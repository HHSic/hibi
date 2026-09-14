# 프레임마다 AI 누끼 알파 만들기
# 초록·검은 바탕이 아닌 영상(예: 러시안블루 cat-rb — Pexels 29758643, 방 안에서 찍음)을 AI 누끼로 딴다.
# 모델: BiRefNet-matting (MIT, github.com/ZhengPeng7/BiRefNet 릴리스 v1 의 BiRefNet-matting-epoch_100.onnx, 927.6MB).
# 모델 파일은 저장소에 넣지 않는다. CPU onnxruntime 으로 1080p 한 장에 약 18초 (Core Ultra 7 155H).
# 순서: matte_run.py (프레임마다 알파) → matte_post.py (다듬어 투명 PNG 묶음) → BAKE_FRAMES=<묶음> main.js (반복 webm)
#
# 영상 구간의 프레임마다 AI 누끼 모델(BiRefNet 계열 ONNX)을 돌려 알파(투명도)를 PNG 로 남긴다 — CPU onnxruntime.
# 이미 만든 프레임은 건너뛴다(도중에 끊겨도 이어서 돌릴 수 있게). 후처리(matte_post.py)는 이 알파를 읽는다.
#
#   python matte_run.py <영상> <출력폴더> <시작초> <끝초> <모델.onnx> [<입력크기=1024>] [<최대장수>]
import os, sys, time, json
sys.stdout.reconfigure(encoding="utf-8")
import cv2
import numpy as np
import onnxruntime as ort

video, out_dir, t0, t1, model = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
size = int(sys.argv[6]) if len(sys.argv) > 6 else 1024
limit = int(sys.argv[7]) if len(sys.argv) > 7 else 0
alpha_dir = os.path.join(out_dir, 'alpha_raw')
os.makedirs(alpha_dir, exist_ok=True)

so = ort.SessionOptions()
so.intra_op_num_threads = os.cpu_count() or 8
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
sess = ort.InferenceSession(model, sess_options=so, providers=['CPUExecutionProvider'])
inp = sess.get_inputs()[0]
print(json.dumps({'input': inp.name, 'shape': inp.shape, 'outputs': [o.name for o in sess.get_outputs()]}), flush=True)

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
f0, f1 = int(round(t0 * fps)), int(round(t1 * fps))
cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
done = 0
started = time.time()
for idx in range(f0, f1):
    ok, frame = cap.read()
    if not ok:
        break
    name = os.path.join(alpha_dir, f'{idx:06d}.png')
    if os.path.exists(name):
        continue
    H, W = frame.shape[:2]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    x = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    x = ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
    t = time.time()
    y = sess.run(None, {inp.name: x})[-1]
    y = np.squeeze(y).astype(np.float32)
    # 모델에 따라 이미 0~1 이기도, 로짓이기도 하다
    if y.min() < 0.0 or y.max() > 1.0:
        y = 1.0 / (1.0 + np.exp(-y))
    a = cv2.resize(y, (W, H), interpolation=cv2.INTER_LINEAR)
    cv2.imwrite(name, np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8))
    done += 1
    per = (time.time() - started) / done
    left = (f1 - idx - 1) * per
    print(f'{idx} {time.time() - t:.1f}s  (평균 {per:.1f}s, 남은 약 {left / 60:.1f}분)', flush=True)
    if limit and done >= limit:
        break
print('끝', done, '장', flush=True)

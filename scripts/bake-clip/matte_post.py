# 알파 다듬어 투명 PNG 묶음 만들기
# 초록·검은 바탕이 아닌 영상(예: 러시안블루 cat-rb — Pexels 29758643, 방 안에서 찍음)을 AI 누끼로 딴다.
# 모델: BiRefNet-matting (MIT, github.com/ZhengPeng7/BiRefNet 릴리스 v1 의 BiRefNet-matting-epoch_100.onnx, 927.6MB).
# 모델 파일은 저장소에 넣지 않는다. CPU onnxruntime 으로 1080p 한 장에 약 18초 (Core Ultra 7 155H).
# 순서: matte_run.py (프레임마다 알파) → matte_post.py (다듬어 투명 PNG 묶음) → BAKE_FRAMES=<묶음> main.js (반복 webm)
#
# matte_run.py 가 만든 프레임별 알파를 다듬어 투명 PNG 묶음으로 만든다 (scripts/bake-clip 의 BAKE_FRAMES 가 굽는다).
#   1) 고정 테두리 — 카메라가 거의 안 움직이고 고양이 몸도 가만히 있다. 모든 알파의 중앙값에서 «고양이 자리»를
#      잡아 넉넉히 넓힌 밖은 지운다 — 의자·수납장 쪽으로 가끔 새어 나오는 반투명 얼룩이 사라진다.
#   2) 시간 방향 다듬기 — 프레임마다 따로 푼 알파는 털 끝이 깜빡인다. 앞뒤 프레임과 섞되, 화면이 움직인 곳
#      (고개·눈)은 섞지 않아 번지지 않게 한다.
#   3) 잘라 줄이기 — 고정 테두리의 상자로 자르고, 높이를 최대 max_h 로 줄인다.
#
#   python matte_post.py <영상> <작업폴더> <시작초> <끝초> [<max_h=760>] [<넓힘px=40>] [strict=x0,y0,x1,y1] [fade_left=0.1] [fade_bottom=0.08]
import os, sys, json
sys.stdout.reconfigure(encoding="utf-8")
import cv2
import numpy as np

video, work, t0, t1 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
pos = [a for a in sys.argv[5:] if '=' not in a]
opt = dict(a.split('=', 1) for a in sys.argv[5:] if '=' in a)
max_h = int(pos[0]) if len(pos) > 0 else 760
grow = int(pos[1]) if len(pos) > 1 else 40
# strict=x0,y0,x1,y1 — 이 상자 안(원본 px)에서는 확실한 몸(중앙값 알파 > 0.9)에서 8px 넘게 떨어진 알파를 지운다.
#   고양이 뒤 물건(러시안블루 귀 뒤 의자 등받이 테두리)에 반투명 알파가 붙어 나오는 곳에만 쓴다 —
#   화면 전체에 쓰면 초점 밖으로 흐린 발처럼 테두리가 넓게 번진 곳이 깎여 딱딱해진다
strict = [int(v) for v in opt['strict'].split(',')] if 'strict' in opt else None
# fade_left=0.1 — 자른 영상 왼쪽 폭의 이만큼을 서서히 투명하게. 몸이 원본 왼쪽 끝에 잘렸는데 영상은 창 오른쪽에 붙을 때
fade_left = float(opt.get('fade_left', 0))
# fade_bottom=0.08 — 아래 끝도 같이. 몸이 원본 아래 끝에 잘렸는데 영상이 창 아래에서 뜰 수 있을 때 (세로 화면에서 단추 줄 위로 올라간다)
fade_bottom = float(opt.get('fade_bottom', 0))
alpha_dir = os.path.join(work, 'alpha_raw')
out_dir = os.path.join(work, 'frames')
os.makedirs(out_dir, exist_ok=True)

cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
f0, f1 = int(round(t0 * fps)), int(round(t1 * fps))
idxs = [i for i in range(f0, f1) if os.path.exists(os.path.join(alpha_dir, f'{i:06d}.png'))]
if not idxs:
    sys.exit('알파가 없다')
first = cv2.imread(os.path.join(alpha_dir, f'{idxs[0]:06d}.png'), cv2.IMREAD_GRAYSCALE)
H, W = first.shape

# 1) 고정 테두리 — 절반 크기로 중앙값
half = np.stack([cv2.resize(cv2.imread(os.path.join(alpha_dir, f'{i:06d}.png'), cv2.IMREAD_GRAYSCALE), (W // 2, H // 2))
                 for i in idxs]).astype(np.uint8)
med = np.median(half, axis=0).astype(np.uint8)
# 구간 전체에서 한 번이라도 고양이가 있었던 곳 — 자를 상자와 «잘린 쪽»은 이걸로 잰다
amax = half.max(axis=0)
del half
body = (med > 127).astype(np.uint8)
k = max(1, grow // 2)
body = cv2.dilate(body, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
body = cv2.GaussianBlur(body.astype(np.float32), (0, 0), k / 2)
limit = cv2.resize(np.clip(body * 1.5, 0, 1), (W, H), interpolation=cv2.INTER_LINEAR)
if strict:
    sx0, sy0, sx1, sy1 = strict
    smed = np.median(np.stack([cv2.imread(os.path.join(alpha_dir, f'{i:06d}.png'), cv2.IMREAD_GRAYSCALE)[sy0:sy1, sx0:sx1]
                               for i in idxs]), axis=0).astype(np.uint8)
    core = cv2.morphologyEx((smed > 230).astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    core = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)))
    tight = np.clip(cv2.GaussianBlur(core.astype(np.float32), (0, 0), 4) * 1.6, 0, 1)
    # 상자 안쪽 가장자리 40px 에서 원래 한계와 섞어 이음매가 안 보이게 — 원본 화면 끝에 닿은 쪽은 섞지 않는다
    ny, nx = sy1 - sy0, sx1 - sx0
    dy, dx = np.full(ny, 1e9), np.full(nx, 1e9)
    if sy0 > 0: dy = np.minimum(dy, np.arange(ny))
    if sy1 < H: dy = np.minimum(dy, np.arange(ny)[::-1])
    if sx0 > 0: dx = np.minimum(dx, np.arange(nx))
    if sx1 < W: dx = np.minimum(dx, np.arange(nx)[::-1])
    wgt = np.clip(np.minimum.outer(dy, dx) / 40.0, 0, 1).astype(np.float32)
    sub = limit[sy0:sy1, sx0:sx1]
    limit[sy0:sy1, sx0:sx1] = sub * (1 - wgt) + np.minimum(sub, tight) * wgt
# 흐리게 넓힌 테두리(limit)로 상자를 잡으면 화면 전체가 잡혔다 — 실제 알파가 있는 곳으로 잡고 1% 만 여유를 둔다
content = cv2.resize(amax, (W, H), interpolation=cv2.INTER_LINEAR).astype(np.float32) * limit > 25
ys, xs = np.where(content > 0)
pad = int(round(0.01 * max(W, H)))
x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
x1, y1 = min(W, int(xs.max()) + 1 + pad), min(H, int(ys.max()) + 1 + pad)
cw, ch = x1 - x0, y1 - y0
scale = min(1.0, max_h / ch)
ow, oh = int(round(cw * scale / 2)) * 2, int(round(ch * scale / 2)) * 2
cut = {'left': bool(xs.min() <= 2), 'right': bool(xs.max() >= W - 3), 'top': bool(ys.min() <= 2), 'bottom': bool(ys.max() >= H - 3)}
if fade_left > 0:
    ramp = np.clip((np.arange(W, dtype=np.float32) - x0) / (fade_left * cw), 0, 1)
    limit = limit * (ramp * ramp * (3 - 2 * ramp))[None, :]
    cut['left'] = False
if fade_bottom > 0:
    ramp = np.clip((y1 - np.arange(H, dtype=np.float32)) / (fade_bottom * ch), 0, 1)
    limit = limit * (ramp * ramp * (3 - 2 * ramp))[:, None]
    cut['bottom'] = False
print(json.dumps({'frames': len(idxs), 'box': [x0, y0, cw, ch], 'out': [ow, oh], 'cut': cut}), flush=True)

# 2) 시간 방향 다듬기 — 세 장씩 보며 흘려 쓴다
def read_alpha(i):
    return cv2.imread(os.path.join(alpha_dir, f'{i:06d}.png'), cv2.IMREAD_GRAYSCALE).astype(np.float32) / 255.0

def read_frame(i):
    cap.set(cv2.CAP_PROP_POS_FRAMES, i)
    ok, fr = cap.read()
    return fr

prev_a, prev_g = None, None
cur_i = idxs[0]
cur_a, cur_f = read_alpha(cur_i), read_frame(cur_i)
cur_g = cv2.GaussianBlur(cv2.cvtColor(cur_f, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 3)
for n, i in enumerate(idxs):
    nxt = idxs[n + 1] if n + 1 < len(idxs) else None
    if nxt is not None:
        nxt_a, nxt_f = read_alpha(nxt), read_frame(nxt)
        nxt_g = cv2.GaussianBlur(cv2.cvtColor(nxt_f, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 3)
    else:
        nxt_a, nxt_f, nxt_g = None, None, None
    # 움직임 — 앞뒤 프레임과의 밝기 차이. 4 넘으면 움직인 곳으로 보고 섞지 않는다
    motion = np.zeros_like(cur_a)
    if prev_g is not None:
        motion = np.maximum(motion, np.abs(cur_g - prev_g))
    if nxt_g is not None:
        motion = np.maximum(motion, np.abs(cur_g - nxt_g))
    still = np.clip(1.0 - (motion - 2.0) / 4.0, 0.0, 1.0)
    side = 0.25 * still
    acc, wsum = cur_a * (1.0 - 2 * side), (1.0 - 2 * side)
    if prev_a is not None:
        acc, wsum = acc + prev_a * side, wsum + side
    if nxt_a is not None:
        acc, wsum = acc + nxt_a * side, wsum + side
    a = acc / np.maximum(wsum, 1e-6)
    a = a * limit
    rgba = cv2.cvtColor(cur_f, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)
    crop = rgba[y0:y1, x0:x1]
    if scale < 1.0:
        crop = cv2.resize(crop, (ow, oh), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(out_dir, f'{n:06d}.png'), crop)
    prev_a, prev_g = cur_a, cur_g
    if nxt is not None:
        cur_i, cur_a, cur_f, cur_g = nxt, nxt_a, nxt_f, nxt_g
    if n % 30 == 0:
        print('후처리', n, '/', len(idxs), flush=True)
print('끝', len(idxs), '장 →', out_dir, flush=True)

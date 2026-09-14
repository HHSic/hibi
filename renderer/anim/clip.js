'use strict';
/**
 * 누끼 딴 실제 고양이 영상을 휴식 창에 띄운다.
 *
 * 고양이를 코드로 그렸더니(anim/cat.js) «이상하다»는 말을 들었다. 사실적인 동물은 그림으로
 * 흉내 낼수록 어색해진다. 그래서 초록 배경에서 찍은 진짜 고양이 영상을 쓴다.
 *
 * ── 영상 파일 (assets/enter/cat.webm) ─────────────────────
 * 원본: Pixabay 영상 116648 «Cat, Pet, Green Screen» — Pixabay Content License
 * (무료, 고쳐 쓸 수 있고 출처 표기 의무 없음). 이 라이선스는 원본을 «거의 그대로» 다시
 * 배포하는 것을 막는다. 그래서 원본 mp4 는 싣지 않고, scripts/bake-clip 이 바꾼 결과만 싣는다:
 *   · 초록 배경을 걷어 투명하게 (VP9 알파)
 *   · 고양이 자리만 잘라 내고, 앉은 받침(밝은 초록 띠)을 잘라 발이 창 아래 끝에 닿게
 *   · 고양이가 가만히 있는 두 순간 사이를 앞뒤로 오가며(핑퐁) 끝없이 되풀이되게 —
 *     한 방향으로 섞어 이으면 자세가 달라 머리가 둘로 겹쳐 보였다
 *
 * 누끼를 앱에서 매 프레임 따지 않고 미리 구운 까닭: 크로미움이 알파 webm 을 그대로 투명하게
 * 틀어 준다. 셰이더도, 매 프레임 텍스처 올리기도 필요 없다 — 휴식 창은 오래 떠 있을 수 있다.
 */
(() => {
  /**
   * 싣고 다니는 영상. width·height 는 영상의 픽셀 크기다 — 영상이 열리기 전에도 자리를 잡으려고
   * 적어 둔다 (다시 구우면 같이 고친다 — test/catclip.test.js 가 맞는지 본다).
   */
  const CLIPS = {
    cat: {
      url: '../assets/enter/cat.webm',
      width: 670,
      height: 760,
      // 오른쪽 아래 구석에 앉힌다. 가끔 왼쪽 — 화면 가운데의 휴식 안내 쪽 — 을 돌아본다.
      place: { anchor: 'right', side: 0.035, bottom: 0, height: 0.46 },
      arrivalMs: 700
    }
  };

  /**
   * 화면에서 영상이 놓일 자리 (CSS px).
   * 글 자리(가운데 가로 41~59%, 세로 30~62%)를 비워 두려고 옆 아래에 둔다:
   *   가로 화면 — 폭을 36% 로 묶어 오른쪽 끝에서 60% 선 안쪽으로 안 들어온다
   *   세로 화면 — 높이가 짧은 변의 37% 라 화면 아래 38% 안에만 있다
   */
  function layout(w, h, clip) {
    const aspect = clip.width / clip.height;
    const P = clip.place || {};
    const portrait = h > w;
    let ch = Math.min(w, h) * (P.height || 0.42) * (portrait ? 0.8 : 1);
    let cw = ch * aspect;
    const maxW = w * (portrait ? 0.9 : 0.36);
    if (cw > maxW) { cw = maxW; ch = cw / aspect; }
    const bottom = h * (P.bottom || 0);
    const side = w * (P.side != null ? P.side : 0.02);
    const x = P.anchor === 'left' ? side : w - side - cw;
    return { x, y: h - bottom - ch, w: cw, h: ch };
  }

  /**
   * 휴식 창에 붙인다. 영상이 안 열리면(파일이 없거나 깨짐) 걷어 내고 onFail 을 한 번 부른다.
   */
  function mount(host, clip, onFail) {
    const v = document.createElement('video');
    v.className = 'ent-clip';
    v.muted = true;            // 소리는 알림음이 따로 낸다
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('aria-hidden', 'true');
    let dead = false;

    const place = () => {
      const w = host.clientWidth || window.innerWidth;
      const h = host.clientHeight || window.innerHeight;
      const b = layout(w, h, clip);
      v.style.left = `${b.x}px`;
      v.style.top = `${b.y}px`;
      v.style.width = `${b.w}px`;
      v.style.height = `${b.h}px`;
    };
    // 첫 프레임이 준비된 뒤에 들어온다 — 빈 네모가 먼저 번쩍이지 않게
    v.addEventListener('loadeddata', () => v.classList.add('in'), { once: true });
    v.addEventListener('error', () => {
      if (dead) return;
      dead = true;
      window.removeEventListener('resize', place);
      v.remove();
      if (onFail) onFail();
    }, { once: true });

    v.src = clip.url;
    place();
    host.append(v);
    window.addEventListener('resize', place);
    v.play().catch(() => { /* 소리 없는 영상이라 보통 안 막힌다. 막혀도 첫 프레임은 남는다 */ });

    return {
      video: v,
      destroy() {
        dead = true;
        window.removeEventListener('resize', place);
        v.pause();
        v.removeAttribute('src');
        v.load();              // 디코더를 바로 놓아 준다
        v.remove();
      }
    };
  }

  window.nunsClip = { CLIPS, layout, mount };
})();

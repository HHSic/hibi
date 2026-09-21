'use strict';
/**
 * 누끼 딴 실제 고양이 영상을 휴식 창에 띄운다.
 *
 * 고양이를 코드로 그렸더니(anim/cat.js) «이상하다»는 말을 들었다. 사실적인 동물은 그림으로
 * 흉내 낼수록 어색해진다. 그래서 초록 배경에서 찍은 진짜 고양이 영상을 쓴다.
 *
 * ── 영상 파일 (assets/enter/*.webm) ──────────────────────
 * 원본 (모두 출처 표기 의무 없음, 고쳐 쓸 수 있음. 원본을 «거의 그대로» 다시 배포하는 것은 금지):
 *   cat.webm       Pixabay 116648 «Cat, Pet, Green Screen» — 앉은 주황 장모 고양이
 *   cat-meow.webm  Pixabay 116727 — 주황 아기 고양이, 3~12.5초 구간 (앉아서 두리번·야옹)
 *   cat-lie.webm   Pixabay 117331 — 줄무늬 아기 고양이, 2.5~5.2초 구간 (엎드려 두리번)
 *   cat-roll.webm  Pixabay 117331 — 같은 고양이, 0~2.2초 구간 (옆으로 늘어져 올려다봄)
 *   cat-loaf.webm  Pexels 5335454 «Adorable Cat Looking Around» — 식빵 자세 브리티시 숏헤어, 검은 바탕
 *   cat-rb.webm    Pexels 3042263 «A Furry Pet Cat Resting On A Carpet Floor» — 흰 가슴털 회색 고양이, 26~36.5초 구간
 *                  (식빵 자세로 고개를 돌린다). 방 안에서 찍어 배경 색으로는 못 가른다 — AI 누끼(BiRefNet-matting, MIT)로 땄다.
 *                  구석(cat-rb)과 가운데(cat-rb-hero) 두 자리가 이 한 파일을 같이 쓴다 — 가운데서도 선명하게 원본 높이로 구웠다
 *   cat-black.webm Pexels 5791546 «Video of a Black Cat» (Phillip Dillow) — 까만 고양이, 0~6.5초 구간 (밝은 바닥에
 *                  엎드려 정면을 보다 고개를 들어 올려다본다). AI 누끼로 땄다. 구석(cat-black)·가운데(cat-black-hero)가 같이 쓴다
 * 원본 mp4 는 싣지 않고, scripts/bake-clip 이 바꾼 결과만 싣는다:
 *   · 배경을 걷어 투명하게 (VP9 알파) — 초록 바탕은 초록 우세도로, 검은 바탕은 밝기 + 구멍 메운 실루엣으로
 *   · 고양이 자리만 잘라 내고, 앉은 받침(밝은 초록 띠)을 잘라 발이 창 아래 끝에 닿게
 *   · 고양이가 가만히 있는 두 순간 사이를 앞뒤로 오가며(핑퐁) 끝없이 되풀이되게 —
 *     한 방향으로 섞어 이으면 자세가 달라 머리가 둘로 겹쳐 보였다
 *   · 아기 고양이 영상은 금방 일어나 화면 밖으로 걸어 나간다 — 자세가 유지되는 구간만 쓴다
 *
 * 누끼를 앱에서 매 프레임 따지 않고 미리 구운 까닭: 크로미움이 알파 webm 을 그대로 투명하게
 * 틀어 준다. 셰이더도, 매 프레임 텍스처 올리기도 필요 없다 — 휴식 창은 오래 떠 있을 수 있다.
 *
 * ── 두 가지 자리 ─────────────────────────────────────────
 *   구석(corner) — 오른쪽 아래 구석에 앉는다. 휴식 안내는 가운데 그대로.
 *   주인공(hero) — 고양이가 화면 가운데에 크게 나오고, 휴식 안내·단추는 오른쪽 아래 구석으로
 *                 비켜 준다 («가운데에 고양이, 글·단추는 오른쪽 아래 구석으로» 라는 요청).
 *                 이 화면에서만 html.ent-hero 를 붙여 overlay.html 의 CSS 가 내용을 옮긴다 —
 *                 연출은 마우스가 있는 화면 하나에만 그리므로, 다른 모니터는 가운데 그대로다.
 */
(() => {
  /**
   * 싣고 다니는 영상. width·height 는 영상의 픽셀 크기다 — 영상이 열리기 전에도 자리를 잡으려고
   * 적어 둔다 (다시 구우면 같이 고친다 — test/catclip.test.js 가 맞는지 본다).
   */
  const CLIPS = {
    'cat-loaf': {
      // Pexels 5335454 — 식빵 자세로 엎드린 브리티시 숏헤어. 가운데 주인공 자리 («커다랗게 나와서 식빵굽는 고양이»)
      url: '../assets/enter/cat-loaf.webm',
      width: 1184,
      height: 600,
      fps: 25,
      place: { mode: 'hero', height: 0.8 },
      arrivalMs: 700
    },
    cat: {
      url: '../assets/enter/cat.webm',
      width: 662,
      height: 760,
      fps: 25,   // 원본은 30fps 로 늘린 25fps — 되풀이 장(6장마다 3번째)을 빼고 구웠다
      // 오른쪽 아래 구석에 앉힌다. 가끔 왼쪽 — 화면 가운데의 휴식 안내 쪽 — 을 돌아본다.
      place: { mode: 'corner', anchor: 'right', side: 0.035, bottom: 0, height: 0.46 },
      arrivalMs: 700
    },
    'cat-meow': {
      // Pixabay 116727 의 3~12.5초 — 주황 아기 고양이가 똑바로 앉아 두리번거리다 가끔 야옹한다
      url: '../assets/enter/cat-meow.webm',
      width: 682,
      height: 760,
      fps: 25,   // 원본은 30fps 로 늘린 25fps — 되풀이 장을 빼고 구웠다
      place: { mode: 'corner', anchor: 'right', side: 0.035, bottom: 0, height: 0.46 },
      arrivalMs: 700
    },
    'cat-lie': {
      // Pixabay 117331 의 2.5~5.2초 — 줄무늬 아기 고양이가 엎드려 두리번거린다 (옆으로 길어서 구석 자리 폭에 맞춰진다)
      url: '../assets/enter/cat-lie.webm',
      width: 1236,
      height: 494,
      fps: 25,
      place: { mode: 'corner', anchor: 'right', side: 0.035, bottom: 0, height: 0.46 },
      arrivalMs: 700
    },
    'cat-roll': {
      // Pixabay 117331 의 0~2.2초 — 같은 아기 고양이가 옆으로 늘어져 누워 위를 올려다본다
      url: '../assets/enter/cat-roll.webm',
      width: 1246,
      height: 426,
      fps: 25,
      place: { mode: 'corner', anchor: 'right', side: 0.035, bottom: 0, height: 0.46 },
      arrivalMs: 700
    },
    'cat-rb': {
      // Pexels 3042263 의 26~36.5초 — 회색 고양이가 카펫에 식빵 자세로 앉아 왼쪽을 보다가 고개를 돌려 정면을 본다.
      // 처음엔 러시안블루(Pexels 29758643) 클로즈업이었는데, 거의 안 움직이고 몸이 잘린 털 덩어리로 보여 바꿨다.
      // 예전에 골라 둔 설정이 그대로 이어지게 id 는 'cat-rb' 로 둔다. 원본 위쪽 끝에 귀 끝이 몇 픽셀 잘려 있다(cut.top)
      url: '../assets/enter/cat-rb.webm',
      width: 1034,
      height: 1032,
      fps: 30,
      cut: { top: true },
      // 오른쪽 여백은 다른 고양이(0.035)보다 좁게 — 가로세로가 거의 같아서, 세로 화면(1080x1920)에서 단추 줄을
      // 피해 폭이 줄면 짧은 변의 30% 아래로 작아졌다 (영상 안에 제 여백이 조금 있어 창 끝에 붙어 보이지는 않는다)
      place: { mode: 'corner', anchor: 'right', side: 0.01, bottom: 0, height: 0.46 },
      arrivalMs: 700
    },
    'cat-rb-hero': {
      // 같은 회색 고양이를 가운데에 크게 — 휴식 안내·할 일 목록·단추는 오른쪽 아래로 비켜 준다
      // («할 목록과 그거를 오른쪽으로 밀고 고양이 영상을 가운데로 옮기는 버전도» 요청). 영상은 cat-rb 와 같은 파일
      url: '../assets/enter/cat-rb.webm',
      width: 1034,
      height: 1032,
      fps: 30,
      cut: { top: true },
      place: { mode: 'hero', height: 0.8 },
      arrivalMs: 700
    },
    'cat-black': {
      // Pexels 5791546 의 0~6.5초 — 까만 고양이가 밝은 바닥에 엎드려 정면을 보다가 고개를 들어 올려다본다(«까만 고양이 버전도»).
      // 밝은 바닥·흰 벽이라 까만 털이 AI 누끼로 깨끗이 떨어졌다. 뒤에서 오는 빛이 털 가장자리를 살려 준다
      url: '../assets/enter/cat-black.webm',
      width: 1036,
      height: 966,
      fps: 24,
      // 어두운 휴식 화면에 까만 털이 묻힌다 — 위쪽으로 치우친 옅은 뒤쪽 빛(mount 가 filter 로 입힌다)
      glow: 'drop-shadow(0 -2px 10px rgba(225, 232, 255, 0.2))',
      place: { mode: 'corner', anchor: 'right', side: 0.035, bottom: 0, height: 0.46 },
      arrivalMs: 700
    },
    'cat-black-hero': {
      // 같은 까만 고양이를 가운데에 크게 — 휴식 안내·할 일 목록·단추는 오른쪽 아래로 비켜 준다 («가운데 버전도»)
      url: '../assets/enter/cat-black.webm',
      width: 1036,
      height: 966,
      fps: 24,
      // 어두운 휴식 화면에 까만 털이 묻힌다 — 위쪽으로 치우친 옅은 뒤쪽 빛(mount 가 filter 로 입힌다)
      glow: 'drop-shadow(0 -2px 10px rgba(225, 232, 255, 0.2))',
      place: { mode: 'hero', height: 0.8 },
      arrivalMs: 700
    }
  };

  /**
   * 주인공 자리일 때 휴식 안내가 차지하는 오른쪽 아래 칸의 폭(여백 포함, CSS px).
   * overlay.html 의 html.ent-hero .stage/.actions 폭 min(460px, 32vw) + 오른쪽 여백 24px 과 같아야 한다.
   */
  function heroPanelWidth(w) {
    return Math.min(460, w * 0.32) + 24;
  }

  /** 단추 줄(overlay.html .actions — 가운데 아래)의 어림 크기 (CSS px) — «다 했어요 (0/7)»·«5분 뒤에»·«건너뛰기» 세 개와 여백보다 넉넉히 */
  const BUTTONS = { half: 200, height: 100 };

  /**
   * 화면에서 영상이 놓일 자리 (CSS px).
   *
   * 구석 — 글 자리(가운데 가로 41~59%, 세로 30~62%)를 비워 두려고 옆 아래에 둔다:
   *   가로 화면은 폭을 36% 로 묶어 오른쪽 끝에서 60% 선 안쪽으로 안 들어오고,
   *   세로 화면은 높이가 짧은 변의 37% 라 화면 아래 38% 안에만 있다.
   *   가운데 아래 단추 줄과 겹치면 폭을 줄여 단추 옆에 앉히거나, 너무 작아지면 단추 줄 위로 올린다.
   * 주인공 — 가로 화면은 높이의 80% 로 가운데에 세우되, 오른쪽 아래 휴식 안내 칸과 16px 넘게
   *   떨어지게 왼쪽으로 물린다. 세로 화면은 휴식 안내가 위로 가므로 아래 55% 안에 가운데로 앉힌다.
   */
  function layout(w, h, clip) {
    const aspect = clip.width / clip.height;
    const P = clip.place || {};
    // overlay.html CSS 의 (orientation: portrait) 는 높이 ≥ 폭이다 — 정사각형 화면에서 둘이 어긋나지 않게 같은 기준
    const portrait = h >= w;
    const bottom = h * (P.bottom || 0);

    if (P.mode === 'hero') {
      let ch = h * (portrait ? Math.min(P.height || 0.8, 0.55) : (P.height || 0.8));
      let cw = ch * aspect;
      const left = w * 0.02;
      const right = portrait ? w * 0.98 : w - heroPanelWidth(w) - 16;
      if (cw > right - left) { cw = right - left; ch = cw / aspect; }
      const x = Math.max(left, Math.min(w / 2 - cw / 2, right - cw));
      return { x, y: h - bottom - ch, w: cw, h: ch };
    }

    let ch = Math.min(w, h) * (P.height || 0.42) * (portrait ? 0.8 : 1);
    let cw = ch * aspect;
    const maxW = w * (portrait ? 0.9 : 0.36);
    if (cw > maxW) { cw = maxW; ch = cw / aspect; }
    const side = w * (P.side != null ? P.side : 0.02);
    const left = P.anchor === 'left';
    let x = left ? side : w - side - cw;
    let y = h - bottom - ch;
    // 가운데 아래 단추 줄(overlay.html .actions)도 피한다 — 옆으로 긴 아기 고양이(cat-lie·cat-roll)가 세로 화면과
    // 폭 1557px 보다 좁은 화면에서 단추 뒤에 깔렸다. 겹치면 폭을 줄여 단추 옆에 앉히고, 그러면 너무 작아질 때는
    // 크기는 두고 단추 줄 위로 올린다. 단추 줄이 없는 작은 칸(설정 미리보기 크기)에서는 피하지 않는다.
    if (w >= 2 * BUTTONS.half + 200) {
      const clear = left ? w / 2 - BUTTONS.half : w / 2 + BUTTONS.half;
      const overlapsX = left ? x + cw > clear : x < clear;
      if (overlapsX && y + ch > h - BUTTONS.height) {
        const cw2 = left ? clear - side : w - side - clear;
        const ch2 = cw2 / aspect;
        // 올린 자리가 글 자리(세로 30~62%)에 걸리면 올릴 수 없다 — 정사각형 화면에서 넓은 고양이가 글을 덮었다
        const canLift = h - BUTTONS.height - ch >= h * 0.63;
        // 줄여도 원래 크기의 3/4 는 남으면 줄여서 바닥에 앉히고, 그보다 작아지면(작은 세로 화면) 크기는 두고 올린다
        if (ch2 >= ch * 0.75 || !canLift) {
          cw = cw2;
          ch = ch2;
          x = left ? side : w - side - cw;
          y = h - bottom - ch;
        } else {
          y = h - BUTTONS.height - ch;
        }
      }
    }
    return { x, y, w: cw, h: ch };
  }

  /**
   * 휴식 창에 붙인다. 영상이 안 열리면(파일이 없거나 깨짐) 걷어 내고 onFail 을 한 번 부른다.
   */
  function mount(host, clip, onFail) {
    const hero = !!(clip.place && clip.place.mode === 'hero');
    const root = document.documentElement;
    const v = document.createElement('video');
    v.className = hero ? 'ent-clip ent-clip-hero' : 'ent-clip';
    v.muted = true;            // 소리는 알림음이 따로 낸다
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('aria-hidden', 'true');
    // 영상마다 따로 주는 필터(CLIPS 의 glow) — 까만 고양이는 어두운 휴식 화면에 윤곽이 묻혀,
    // 뒤에서 비치는 듯한 옅은 빛을 준다. .ent-clip 의 transform(들어오는 움직임)과는 따로 논다
    if (clip.glow) v.style.filter = clip.glow;
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
    const leave = () => {
      window.removeEventListener('resize', place);
      // 주인공이 사라지면 휴식 안내를 가운데로 돌려 놓는다
      if (hero) root.classList.remove('ent-hero');
    };
    // 첫 프레임이 준비된 뒤에 들어온다 — 빈 네모가 먼저 번쩍이지 않게
    v.addEventListener('loadeddata', () => v.classList.add('in'), { once: true });
    v.addEventListener('error', () => {
      if (dead) return;
      dead = true;
      leave();
      v.remove();
      if (onFail) onFail();
    }, { once: true });

    // 휴식 안내는 도착 뒤에 뜬다(--enter-delay). 그 전에 자리를 옮겨 두어야 뜨는 순간 튀지 않는다.
    if (hero) root.classList.add('ent-hero');
    v.src = clip.url;
    place();
    host.append(v);
    window.addEventListener('resize', place);
    v.play().catch(() => { /* 소리 없는 영상이라 보통 안 막힌다. 막혀도 첫 프레임은 남는다 */ });

    return {
      video: v,
      destroy() {
        dead = true;
        leave();
        v.pause();
        v.removeAttribute('src');
        v.load();              // 디코더를 바로 놓아 준다
        v.remove();
      }
    };
  }

  window.nunsClip = { CLIPS, layout, mount, heroPanelWidth };
})();

'use strict';
/**
 * 휴식 화면 등장 연출의 캔버스 엔진.
 *
 * 예전 연출은 SVG·CSS 키프레임이었다. 그걸로는 «살아 있는» 움직임이 안 나온다 —
 * 꼬리가 몸을 따라 늦게 휘거나, 줄에 매달린 몸이 진자처럼 흔들리는 것은 키프레임
 * 몇 개로 흉내 낼 수 없다. 그래서 매 프레임 그리는 캔버스로 옮겼다.
 *
 * ── 장면 약속 ─────────────────────────────────────────────
 *   {
 *     arrival: 1.2,                         // 초. 이때까지 «등장»이 끝나야 한다 (휴식 내용이 이때 뜬다)
 *     setup({ w, h, rng }) → state,         // 한 번. 무작위는 rng 로만 (시드가 같으면 같은 장면)
 *     draw(ctx, t, w, h, state)             // 매 프레임
 *   }
 *
 * draw 는 «t 만의 함수»여야 한다. state 를 고치지 말고, 이전 프레임 값을 기억하지 말 것.
 * 그래야 아무 시각이나 똑같이 다시 그릴 수 있고(renderAt), 그 덕에 시험에서 프레임을
 * 그림 파일로 뽑아 «눈으로» 확인할 수 있다. CSS 애니는 capturePage 로 안 찍혔다 (실측).
 * 꼬리 같은 물리도 적분하지 말고 시간의 식(감쇠 진동 등)으로 쓴다.
 *
 * 좌표는 CSS 픽셀. 엔진이 devicePixelRatio 를 곱해 준다.
 */
(() => {
  // 4K 화면에 배율 2까지 곱하면 픽셀이 3천만 개가 넘는다. 배경 연출에 그만큼은 필요 없다.
  const MAX_BACKING = 2560 * 1600;

  function fitCanvas(cv, w, h) {
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    while (w * h * dpr * dpr > MAX_BACKING && dpr > 0.5) dpr -= 0.25;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    return dpr;
  }

  /** 시드 난수 — 같은 시드면 같은 장면 */
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // ── 움직임 도구 ─────────────────────────────────────────
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  /** t 가 a..b 에서 0..1 로 (밖이면 끝값) */
  const span = (t, a, b) => clamp((t - a) / (b - a));
  const ease = {
    inOut: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
    out: (k) => 1 - Math.pow(1 - k, 3),
    in: (k) => k * k * k,
    outBack: (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
    smooth: (k) => k * k * (3 - 2 * k)
  };
  /**
   * 감쇠 진동 — 멈춘 뒤 «툭» 흔들리다 가라앉는 것. 적분 없이 시간의 식으로.
   * t0 에 충격을 받고 amp 만큼 튀었다가 freq(Hz) 로 떨며 damp 로 가라앉는다.
   */
  const wobble = (t, t0, amp, freq = 2.2, damp = 3.5) => {
    if (t < t0) return 0;
    const x = t - t0;
    return amp * Math.exp(-damp * x) * Math.sin(2 * Math.PI * freq * x);
  };

  /** 화면에 붙인다. 휴식 창이 닫히면 창과 같이 사라지지만, 미리보기처럼 떼야 할 때 destroy. */
  function mount(host, scene, opts = {}) {
    const cv = document.createElement('canvas');
    cv.className = 'ent-canvas';
    host.append(cv);
    const ctx = cv.getContext('2d');

    let w = host.clientWidth || window.innerWidth;
    let h = host.clientHeight || window.innerHeight;
    let dpr = fitCanvas(cv, w, h);
    let state = scene.setup ? scene.setup({ w, h, rng: rng(opts.seed || 7) }) : {};

    const t0 = performance.now();
    let raf = 0;
    let last = 0;
    let dead = false;
    const arrival = scene.arrival || 1.5;

    const frame = (now) => {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const t = (now - t0) / 1000;
      // 등장하는 동안은 60fps. 배경으로 머무는 동안은 30fps 로 줄인다 —
      // 휴식 내내 GPU 를 달굴 이유가 없다.
      if (t > arrival + 0.6 && now - last < 1000 / 30 - 2) return;
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      try {
        scene.draw(ctx, t, w, h, state);
      } catch (e) {
        // 그리다 터져도 휴식 화면은 살아야 한다 — 연출만 멈춘다
        dead = true;
        cancelAnimationFrame(raf);
      }
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => {
      w = host.clientWidth || window.innerWidth;
      h = host.clientHeight || window.innerHeight;
      dpr = fitCanvas(cv, w, h);
      state = scene.setup ? scene.setup({ w, h, rng: rng(opts.seed || 7) }) : {};
    };
    window.addEventListener('resize', onResize);

    return {
      canvas: cv,
      destroy() {
        dead = true;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        cv.remove();
      }
    };
  }

  /** 아무 시각 한 장 — 시험과 미리보기용. 캔버스를 돌려준다. */
  function renderAt(scene, t, w, h, opts = {}) {
    const cv = document.createElement('canvas');
    const scale = opts.scale || 1;
    cv.width = Math.round(w * scale);
    cv.height = Math.round(h * scale);
    const ctx = cv.getContext('2d');
    const state = scene.setup ? scene.setup({ w, h, rng: rng(opts.seed || 7) }) : {};
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    scene.draw(ctx, t, w, h, state);
    return cv;
  }

  window.nunsAnim = {
    mount, renderAt, rng,
    fx: { clamp, lerp, span, ease, wobble },
    scenes: window.nunsAnim ? window.nunsAnim.scenes : {}
  };
})();

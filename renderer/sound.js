/**
 * 알림음 — 파일 없이 Web Audio로 합성한다.
 *
 * mp3를 넣으면 용량도 늘고 라이선스도 따라온다. 짧은 알림음 정도는
 * 오실레이터 두어 개로 충분하고, 설정에서 고르게 하기도 쉽다.
 *
 * 볼륨은 0~1. 0.25가 사무실에서 거슬리지 않으면서 들리는 상한이었다(실측).
 */
(function () {
  const PEAK = 0.25;
  let ctx = null;

  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** 감쇠하는 사인음 하나 */
  function tone(c, { freq, at, dur, vol, type = 'sine', slideTo = null }) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur * 0.8);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(c.destination);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  const VOICES = {
    // 지금까지 쓰던 소리 — 두 음이 겹치며 퍼진다
    chime(c, t, v) {
      tone(c, { freq: 660, at: t + 0.05, dur: 1.6, vol: v });
      tone(c, { freq: 880, at: t + 0.25, dur: 2.0, vol: v * 0.8 });
    },
    // 밝은 종 — 배음을 얹어 또렷하다
    bell(c, t, v) {
      tone(c, { freq: 880, at: t, dur: 1.8, vol: v });
      tone(c, { freq: 1320, at: t, dur: 1.1, vol: v * 0.45 });
      tone(c, { freq: 2640, at: t, dur: 0.5, vol: v * 0.18 });
    },
    // 물방울 — 짧고 음이 떨어진다
    drop(c, t, v) {
      tone(c, { freq: 1200, at: t, dur: 0.42, vol: v, slideTo: 420 });
    },
    // 낮은음 — 조용한 사무실용
    soft(c, t, v) {
      tone(c, { freq: 330, at: t, dur: 1.4, vol: v });
      tone(c, { freq: 495, at: t + 0.12, dur: 1.2, vol: v * 0.5 });
    },
    // 두 번 똑똑 — 놓치기 어렵다
    knock(c, t, v) {
      tone(c, { freq: 740, at: t, dur: 0.28, vol: v, type: 'triangle' });
      tone(c, { freq: 740, at: t + 0.22, dur: 0.28, vol: v, type: 'triangle' });
    }
  };

  window.nunsSound = {
    LIST: [
      { id: 'chime', name: '차임' },
      { id: 'bell', name: '종' },
      { id: 'drop', name: '물방울' },
      { id: 'soft', name: '낮은음' },
      { id: 'knock', name: '똑똑' }
    ],
    /** volume: 0~100 */
    play(id, volume) {
      const voice = VOICES[id] || VOICES.chime;
      const v = PEAK * Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
      if (v <= 0) return;
      try {
        const c = audio();
        voice(c, c.currentTime + 0.02, v);
      } catch { /* 소리를 못 내도 휴식은 진행되어야 한다 */ }
    }
  };
})();

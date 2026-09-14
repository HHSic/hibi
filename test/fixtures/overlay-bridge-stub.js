// 휴식 창(renderer/overlay.html)을 앱 없이 띄우는 시험용 다리 — 진짜 preload(nunsseom) 흉내.
// 시작 신호(휴식 내용)는 시험이 window.__begin(payload) 로 준다.
let beginCb = null;
window.nunsseom = {
  onBreakBegin: (cb) => { beginCb = cb; },
  getBreakPayload: () => new Promise(() => {}),
  getOverlayBg: () => Promise.resolve(null),
  finish() {}, snooze() {}, skip() {}
};
window.__begin = (p) => { if (beginCb) beginCb(p); };

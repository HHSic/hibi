// 설정 창(renderer/settings.html)을 앱 없이 띄우는 시험용 다리 — 진짜 preload(nunsseom) 흉내.
// 설정 값은 시험(메인 쪽)이 'stub:settings' 로 넘긴다. 나머지 부르기는 아무것도 안 하고 빈 답을 준다.
const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('stub:settings');
const known = {
  getSettings: () => Promise.resolve(data),
  statsGet: () => Promise.resolve({ today: { done: 0, skipped: 0 }, week: [] }),
  // 고른 값이 저장 요청으로 나갔는지 시험이 볼 수 있게 남겨 둔다
  setApp: (patch) => { (window.__setApp = window.__setApp || []).push(patch); },
  closeSettings() {}
};
window.nunsseom = new Proxy(known, {
  get: (t, k) => {
    if (k in t) return t[k];
    // onXxx(cb) 는 구독 — 부를 일이 없다. 그 밖의 것은 빈 답
    if (typeof k === 'string' && k.startsWith('on')) return () => {};
    return () => Promise.resolve(null);
  }
});

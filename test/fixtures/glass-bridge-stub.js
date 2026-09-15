// 유리 창(위젯·설정·통계·주식·메일·물어보는 창·차트)을 앱 없이 띄우는 시험용 다리 — 진짜 preload(nunsseom) 흉내.
// 설정 창의 'settings:get' 답은 시험(메인 쪽)이 'stub:glass' 의 settings 로 넘긴다 (설정 창만 쓴다).
// 메인의 'glass' 방송은 시험이 window.__glass(g) 로 흉내 내고, 미리보기 요청은 window.__preview 에 남는다.
// 나머지 부르기는 아무것도 안 하고 빈 답을 준다.
const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('stub:glass') || {};
const glassCbs = [];
window.__glass = (g) => { for (const cb of glassCbs) cb(g); return glassCbs.length; };
window.__preview = [];

const known = {
  onGlass: (cb) => { glassCbs.push(cb); },
  previewScrim: (v) => { window.__preview.push(v); },
  getSettings: () => Promise.resolve(data.settings || null),
  statsGet: () => Promise.resolve({ today: { done: 0, skipped: 0 }, week: [] }),
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

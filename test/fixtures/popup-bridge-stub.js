// 물어보는 창(renderer/popup.html)을 앱 없이 띄우는 시험용 다리 — 진짜 preload 의 popupData·popupSize·popupPick 흉내.
// 보여 줄 데이터는 시험(메인 쪽)이 'stub:popup' 으로 준다. 고른 답과 잰 크기는 window 에 남겨 시험이 본다.
const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('stub:popup');
window.__pick = [];
window.__size = null;
const known = {
  popupData: () => Promise.resolve(data),
  popupSize: (s) => { window.__size = s; },
  popupPick: (v) => { window.__pick.push(v); }
};
window.nunsseom = new Proxy(known, {
  get: (t, k) => {
    if (k in t) return t[k];
    // onXxx(cb) 는 구독 — 부를 일이 없다 (theme.js 의 onGlass 등). 그 밖의 것은 빈 답
    if (typeof k === 'string' && k.startsWith('on')) return () => {};
    return () => Promise.resolve(null);
  }
});

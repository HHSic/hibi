// 휴식 창(renderer/overlay.html)을 앱 없이 띄우는 시험용 다리 — 만지는 고양이 몫까지.
// 시작 신호는 시험이 window.__begin(payload) 로 준다. 고양이 rig.json·기록은 진짜 메인 처리기(src/breakwin.js 의
// catrig:rig·pet·affinity)로 보낸다 — 시험이 breakwin.js 를 불러 이 창을 이번 휴식의 창으로 넣어 둔다(adoptForTest).
// 끝내기 단추는 'test:end' 로 알린다. 휴식 끝 신호('overlay:ending')는 진짜 메인(breakwin.endBreak)이 보낸다.
const { ipcRenderer } = require('electron');

let beginCb = null;
window.nunsseom = {
  onBreakBegin: (cb) => { beginCb = cb; },
  onBreakEnding: (cb) => ipcRenderer.on('overlay:ending', () => cb()),
  getBreakPayload: () => new Promise(() => {}),
  getOverlayBg: () => Promise.resolve(null),
  finish() { ipcRenderer.send('test:end', 'finish'); },
  snooze() { ipcRenderer.send('test:end', 'snooze'); },
  skip() { ipcRenderer.send('test:end', 'skip'); },
  catRig: (id) => ipcRenderer.invoke('catrig:rig', id),
  catPet: (p) => ipcRenderer.send('catrig:pet', p),
  catAffinity: (p) => ipcRenderer.send('catrig:affinity', p),
  onCatAffinity: (cb) => ipcRenderer.on('catrig:affinity', (_e, m) => cb(m))
};
window.__begin = (p) => { if (beginCb) beginCb(p); };

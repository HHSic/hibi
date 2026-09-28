// 설정 창 메일 탭을 앱 없이 띄우는 시험용 다리 — settings-bridge-stub.js 와 같은 꼴에 메일 부르기만 더했다.
// 메일 부르기는 시험(메인 쪽)이 require 한 진짜 처리기(src/mailhub.js 가 건 ipcMain.handle)로 보낸다 —
// 화면이 받는 모양을 시험이 흉내 내면 메인이 바뀌어도 모른다.
// 무엇을 불렀는지는 window 에 남겨 시험이 본다 (비밀번호는 시험용 값뿐이다).
const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('stub:settings');
window.__repass = [];
window.__closed = 0;
const known = {
  getSettings: () => Promise.resolve(data),
  statsGet: () => Promise.resolve({ today: { done: 0, skipped: 0 }, week: [] }),
  setApp: (patch) => { (window.__setApp = window.__setApp || []).push(patch); },
  // Esc 가 입력칸에서 멈추는지 — 설정 창 전체 Esc 는 이걸 부른다
  closeSettings: () => { window.__closed += 1; },
  mailGet: () => ipcRenderer.invoke('mail:get'),
  mailUpdate: (id, patch) => ipcRenderer.invoke('mail:update', { id, patch }),
  mailRemove: (id) => ipcRenderer.invoke('mail:remove', id),
  mailRepass: (req) => { window.__repass.push(req); return ipcRenderer.invoke('mail:repass', req || {}); },
  mailRules: () => ipcRenderer.invoke('mail:rules'),
  mailBackupStatus: () => ipcRenderer.invoke('mail:backup-status'),
  // 주소록은 이 시험과 상관없다 (contacts.js 를 싣지 않는다)
  mailContacts: () => Promise.resolve([])
};
window.nunsseom = new Proxy(known, {
  get: (t, k) => {
    if (k in t) return t[k];
    // onXxx(cb) 는 구독 — 부를 일이 없다. 그 밖의 것은 빈 답
    if (typeof k === 'string' && k.startsWith('on')) return () => {};
    return () => Promise.resolve(null);
  }
});

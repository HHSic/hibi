// 자동 전달 화면 시험용 다리 — settings-mail-bridge-stub.js 를 그대로 싣고 자동 전달 부르기 둘만 더한다.
// 무엇을 부탁했는지는 window.__fwdSet 에 남겨 시험이 본다 (일반 setApp 으로 새지 않는지, 꺼진 채 보내지 않는지).
require('./settings-mail-bridge-stub.js');
const { ipcRenderer } = require('electron');

const base = window.nunsseom;
const extra = {
  mailFwdStatus: () => ipcRenderer.invoke('mail:fwd-status'),
  mailFwdSet: (req) => { (window.__fwdSet = window.__fwdSet || []).push(req); return ipcRenderer.invoke('mail:fwd-set', req); }
};
window.nunsseom = new Proxy(base, { get: (t, k) => (k in extra ? extra[k] : t[k]) });

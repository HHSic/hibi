// 메일 보기 창(renderer/mailview.html)을 앱 없이 띄우는 시험용 다리 — 진짜 preload(nunsseom) 흉내.
// 보여 줄 메일(mailViewData 의 답)은 시험(메인 쪽)이 'stub:mailview' 로 준다.
// 첨부 저장·미리보기 부탁은 메인에 안 가고 window.__calls 에 [이름, 번호] 로 남는다 — 시험이 «몇 번을 부탁했나»를 본다.
// 나머지 부르기는 아무것도 안 하고 빈 답을 준다 (메일 서버·파일 저장 대화상자에는 안 간다).
const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('stub:mailview') || {};
window.__calls = [];
const known = {
  mailViewData: () => Promise.resolve(data),
  mailViewBounds: () => Promise.resolve({ x: 0, y: 0, width: 420, height: 480 }),
  mailSaveAttachment: (i) => { window.__calls.push(['save', i]); return Promise.resolve({ ok: false }); },
  mailPreviewAttachment: (i) => {
    window.__calls.push(['preview', i]);
    return Promise.resolve({ kind: 'none', message: '시험 — 미리보기 안 함' });
  },
  mailOpenAttachment: (i) => { window.__calls.push(['open', i]); return Promise.resolve({ ok: false }); },
  // 링크를 푸는 동안 알림 — 시험(메인 쪽)이 'mail:link' 로 보낸다 (진짜 preload 와 같은 통로)
  onMailLink: (cb) => ipcRenderer.on('mail:link', (_e, s) => cb(s))
};
window.nunsseom = new Proxy(known, {
  get: (t, k) => {
    if (k in t) return t[k];
    // onXxx(cb) 는 구독 — 부를 일이 없다 (theme.js 의 onGlass 등). 그 밖의 것은 빈 답
    if (typeof k === 'string' && k.startsWith('on')) return () => {};
    return () => Promise.resolve(null);
  }
});

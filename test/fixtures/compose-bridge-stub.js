// 쓰기 창(renderer/compose.html)을 앱 없이 띄우는 시험용 다리 — 진짜 preload(nunsseom) 흉내.
// 초안(composeData 의 답)은 시험(메인 쪽)이 'stub:compose' 로 준다.
// 메인으로 가는 부탁은 하나도 메인에 안 간다 — window.__calls 에 남기고 지어낸 답을 준다:
//   · composeSend      → __calls.send 에 보낸 것 그대로 (메일 서버에 안 간다)
//   · composeDraftSave → __calls.draft 에 적어 둔 초안
//   · composeDropFiles → __calls.drop 에 파일 이름 — 경로는 시험이 File 에 달아 둔 __testPath 로 흉내 낸다
//                        (진짜 preload 는 webUtils.getPathForFile 로 뽑는다)
//   · composeFileHasPath → 같은 __testPath 가 있나 (진짜는 webUtils — 경로 글자는 화면에 안 준다)
//   · composePickImage → 시험이 window.__pickResult 에 넣어 둔 것 (대화상자는 안 뜬다)
// contextIsolation 을 끈 채 쓴다 — 시험이 화면에서 만든 File 을 그대로 받아야 __testPath 를 볼 수 있다.
const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('stub:compose') || null;
window.__calls = { send: [], draft: [], drop: [], clear: 0, close: 0, pick: 0 };
window.__pickResult = { images: [], skipped: [] };
window.__sendAnswer = { ok: true, message: '보냈습니다' };
const known = {
  composeData: () => Promise.resolve(data),
  composeLimits: () => Promise.resolve({ attachMax: 25 * 1024 * 1024, imageMax: 5 * 1024 * 1024, draftHtmlMax: 2 * 1024 * 1024 }),
  mailContacts: () => Promise.resolve([]),
  composeSend: (msg) => { window.__calls.send.push(msg); return Promise.resolve(window.__sendAnswer); },
  composeDraftSave: (d) => { window.__calls.draft.push(d); },
  composeDraftClear: () => { window.__calls.clear += 1; },
  composeClose: () => { window.__calls.close += 1; },
  composeAsk: () => Promise.resolve('cancel'),
  composeAttach: () => Promise.resolve([]),
  composeFileHasPath: (files) => Array.from(files || []).map((f) => !!(f && f.__testPath)),
  composeDropFiles: (files) => {
    const list = Array.from(files || []);
    window.__calls.drop.push(list.map((f) => f.name));
    // __testSkip 을 단 것은 메인이 뺀 것처럼 (폴더 등) — 진짜 메인은 { name, why } 로 돌려준다
    const withPath = list.filter((f) => f && f.__testPath && !f.__testSkip);
    const skipped = list.filter((f) => f && f.__testSkip).map((f) => ({ name: f.name, why: f.__testSkip }));
    return Promise.resolve({ files: withPath.map((f) => ({ path: f.__testPath, filename: f.name, size: f.size })), skipped });
  },
  composePickImage: () => { window.__calls.pick += 1; return Promise.resolve(window.__pickResult); },
  composeBounds: () => Promise.resolve({ x: 0, y: 0, width: 640, height: 760 })
};
window.nunsseom = new Proxy(known, {
  get: (t, k) => {
    if (k in t) return t[k];
    // onXxx(cb) 는 구독 — 부를 일이 없다 (theme.js 의 onGlass 등). 그 밖의 것은 빈 답
    if (typeof k === 'string' && k.startsWith('on')) return () => {};
    return () => Promise.resolve(null);
  }
});

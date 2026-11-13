// 주식 창을 앱 없이 띄우는 시험용 다리 — settings-mail-bridge-stub.js 와 같은 꼴이다.
// 메인이 없으니 답은 시험이 정한다. window.__push(box) 가 메인의 'stocks:data' 자리이고,
// 화면이 무엇을 부탁했는지는 window.__calls 에 남겨 시험이 본다. 네트워크에는 안 나간다.
window.__calls = { setApp: [], add: [], remove: [], chart: [], refresh: 0, close: 0 };
window.__addReply = { ok: true, added: true, name: '삼성전자', message: null };
// 시험이 문을 걸어 두면 답을 그때까지 붙잡는다 — «기다리는 동안»을 잰다
window.__addGate = null;
let dataCb = null;
window.__push = (box) => { if (dataCb) dataCb(box); };

const known = {
  onStocksData: (cb) => { dataCb = cb; },
  stocksSetApp: (patch) => { window.__calls.setApp.push(patch); return Promise.resolve(true); },
  stocksAdd: async (input) => {
    window.__calls.add.push(input);
    if (window.__addGate) await window.__addGate;
    return window.__addReply;
  },
  stocksRemove: (ticker) => { window.__calls.remove.push(ticker); return Promise.resolve(true); },
  stocksRefresh: () => { window.__calls.refresh += 1; return Promise.resolve(true); },
  stocksClose: () => { window.__calls.close += 1; },
  stocksSearch: () => Promise.resolve([]),
  stocksBounds: () => Promise.resolve(null),
  chartOpen: (item) => { window.__calls.chart.push(item); }
};
window.nunsseom = new Proxy(known, {
  get: (t, k) => {
    if (k in t) return t[k];
    // onXxx(cb) 는 구독 — 부를 일이 없다. 그 밖의 것은 빈 답
    if (typeof k === 'string' && k.startsWith('on')) return () => {};
    return () => Promise.resolve(null);
  }
});

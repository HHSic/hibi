// 주식 창 TOP 100 화면 — 메인이 보낸 상자대로 줄과 단추가 그려지고, 누르면 메인에 부탁만 하는가.
//
// 진짜 renderer/stocks.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/stocks-bridge-stub.js 를 쓴다. 네트워크에는 안 나간다.
// 줄은 진짜 stocks.top() 이 만든 것이다 (https.get 을 가로채 fixtures/stocktop-rows.json 을 준다) —
// 화면이 받는 모양을 시험이 흉내 내면 메인이 바뀌어도 모른다. 메인 쪽 동작은 stocktop.test.js 가 본다.
//
// [1] 관심 보기 — 지금 모습 그대로 (× 단추, 전부·국내·해외·지수·원화, 안내)
// [2] 단추 — 보기·시장에 따라 보이는 것, 눌렀을 때의 부탁, 머리글
// [3] 줄 — 번호, 이름, 회색 금액, ETF·ETN 표시, 값, 등락 색, 툴팁의 종목번호, 원화
// [4] 별과 누르기 — 별은 차트를 안 연다, 객체로 넣는다, 입력칸을 안 지운다, 호버, 겹쳐 누르기
// [5] 다시 그리기 — 그대로면 안 그린다, 관심 목록이 바뀌면 별이 바뀐다
// [6] 스크롤 — 같은 고르기면 지키고 바뀌면 맨 위로
// [7] 실패·빈 상태 — 줄을 지키고 say 줄에, 줄이 없으면 목록 자리에
// [8] 300px — 넘치지 않고 줄을 바꾼다
// [9] 두 테마
// [10] 파일 — CSP 그대로, preload 에 다리가 있다
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { EventEmitter } = require('events');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 120_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(process.env.HIBI_TEST_OUT || os.tmpdir(), 'stocktopui-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocktop-rows.json'), 'utf8'));
// 어떤 주소든 네트워크로 나가지 않는다
let route = () => { throw new Error('시험: 부를 줄 몰랐던 주소'); };
https.get = (url, _opts, cb) => {
  const req = new EventEmitter();
  req.destroy = () => {};
  Promise.resolve().then(() => route(String(url))).then((body) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.resume = () => {};
    cb(res);
    res.emit('data', Buffer.from(JSON.stringify(body)));
    res.emit('end');
  });
  return req;
};
const stocks = require(path.join(ROOT, 'src', 'stocks.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 160 ? `${s.slice(0, 160)}…` : s}` : ''));
  if (!c) bad++;
};
const until = async (fn, ms = 5000, step = 30) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const BASE = { watch: [], market: 'all', indexes: true, krw: false, view: 'watch', topMarket: 'KR', topSort: 'marketValue',
  rows: [], at: 0, lagSec: null, failed: 0, error: null, loading: false };

async function open(width, height) {
  // 진짜 창처럼 테두리 없이 — 테두리가 있으면 주어진 폭보다 안쪽이 좁아져 300px 을 못 잰다
  const win = new BrowserWindow({ show: false, frame: false, width, height,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'stocks-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'stocks.html'), { query: { theme: 'dark', scrim: '0.96', inset: '12', radius: '18', dense: '1' } });
  const js = (c) => win.webContents.executeJavaScript(c);
  const push = async (box) => { await js(`window.__push(${JSON.stringify(box)})`); await sleep(20); };
  return { win, js, push, errs };
}

const UI = `(() => {
  const $ = (id) => document.getElementById(id);
  const vis = (el) => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  const shown = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((b) => b.textContent);
  return {
    on: shown('.seg.on'),
    views: shown('.seg[data-view]'),
    mk: shown('.seg[data-mk]'),
    tm: shown('.seg[data-tm]'),
    ts: shown('.seg[data-ts]'),
    krw: vis($('krw')),
    idx: vis($('idx')),
    note: $('note').textContent,
    spin: $('refresh').classList.contains('spin'),
    say: $('say').textContent,
    sayBad: $('say').classList.contains('bad'),
    none: [...document.querySelectorAll('#list .none')].map((d) => d.textContent),
    rows: [...document.querySelectorAll('#list .row')].map((r) => ({
      cls: r.className,
      title: r.title,
      rk: r.querySelector('.rk') ? r.querySelector('.rk').textContent : null,
      name: r.querySelector('.nm b').textContent,
      metric: r.querySelector('.nm i') ? r.querySelector('.nm i').textContent : null,
      kd: r.querySelector('.kd') ? r.querySelector('.kd').textContent : null,
      px: r.querySelector('.px').textContent,
      pc: r.querySelector('.pc').textContent,
      pcCls: r.querySelector('.pc').className,
      star: r.querySelector('.star') ? r.querySelector('.star').textContent : null,
      del: !!r.querySelector('.del')
    })),
    calls: window.__calls
  };
})()`;

app.whenReady().then(async () => {
  route = (url) => {
    if (url.includes('api.stock.naver.com')) {
      const ex = url.match(/exchange\/(\w+)\//)[1];
      const nyse = url.includes('/up?') ? [F.us.right, F.us.brk] : [F.us.brk, F.us.whrPref];
      const list = { NASDAQ: [F.us.apple], NYSE: nyse, AMEX: [F.us.amex] }[ex];
      return { stocks: list, marketStatus: 'CLOSE' };
    }
    return { stocks: [F.kr.samsung, F.kr.hynix, F.kr.etf, F.kr.etn, F.kr.oddCode], marketStatus: 'OPEN' };
  };
  const krCap = (await stocks.top({ market: 'KR', sort: 'marketValue' })).rows;
  const krTv = (await stocks.top({ market: 'KR', sort: 'priceTop' })).rows;
  const krUp = (await stocks.top({ market: 'KR', sort: 'up' })).rows;
  const usCap = (await stocks.top({ market: 'US', sort: 'marketValue' })).rows;
  const usUp = (await stocks.top({ market: 'US', sort: 'up' })).rows;
  const top = (x = {}) => ({ ...BASE, view: 'top', status: 'OPEN', rows: krCap, at: Date.now(), ...x });
  const us = (x = {}) => top({ topMarket: 'US', status: 'CLOSE', rows: usCap, ...x });
  // 화면이 쓰는 받은 시각 글 — 오늘이 아니면 날짜가 붙는다 (자정 근처에 돌려도 맞게)
  const stamp = (at) => {
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const HOURS_7 = 7 * 3600_000;

  const w = await open(404, 544);
  const { js, push, win } = w;
  const ui = () => js(UI);

  console.log('\n[1] 관심 보기');
  const watchRows = [
    { ticker: '^KS11', name: '코스피', market: 'KR', index: true, price: 2500.5, pct: 0.5, currency: 'KRW', session: '장중' },
    { ticker: '005930', name: '삼성전자', market: 'KR', index: false, price: 209500, pct: -3.9, currency: 'KRW', symbol: '005930.KS', session: '장중' }
  ];
  const a0 = await ui();
  ok(same(a0.ts, []) && same(a0.tm, []), '받기 전에도 순위 단추는 숨어 있다', a0);
  await push({ ...BASE, rows: watchRows, watch: [{ ticker: '005930', name: '삼성전자', market: 'KR' }], lagSec: 1200 });
  const a1 = await ui();
  ok(same(a1.on, ['관심', '전부', '지수']), '관심 · 전부 · 지수가 켜져 있다', a1.on);
  ok(same(a1.mk, ['전부', '국내', '해외']) && a1.krw && a1.idx, '시장·원화·지수가 그대로 있다', a1);
  ok(same(a1.tm, []) && same(a1.ts, []), '순위 단추는 없다', { tm: a1.tm, ts: a1.ts });
  ok(a1.note === '20분 전', '머리글은 묵은 시간 그대로', a1.note);
  ok(a1.rows.length === 2 && a1.rows[1].del && a1.rows[1].star === null && a1.rows[1].rk === null && !a1.rows[1].cls.includes('top'), '줄은 × 단추 — 별도 번호도 없다', a1.rows[1]);
  ok(a1.rows[0].cls.includes('idx') && (await js("document.querySelectorAll('#list .sep').length")) === 1, '지수 줄과 구분선', a1.rows[0].cls);
  ok(a1.rows[1].metric === '005930' && a1.rows[1].pc === '-3.90%' && a1.rows[1].pcCls.includes('dn'), '이름 옆은 종목번호, 등락 색', a1.rows[1]);
  await push({ ...BASE, rows: watchRows.slice(0, 1), lagSec: 30 });
  const a2 = await ui();
  ok(a2.none.length === 1 && /관심 종목이 없습니다/.test(a2.none[0]) && a2.note === '방금', '관심 종목이 없으면 안내와 가져오기', a2);
  await push({ ...BASE, error: '시세를 못 받았습니다' });
  ok((await ui()).none[0] === '시세를 못 받았습니다' && (await ui()).say === '', '관심 쪽 실패는 지금처럼 목록 자리에', (await ui()).none);
  // 파일이 깨져 관심 목록에 null 이 섞여도 화면이 안 터진다 — 오류는 메인이 보낸다
  await push({ ...BASE, error: '깨진 목록', watch: [null, { ticker: '005930', name: '삼성전자', market: 'KR' }] });
  ok((await ui()).none[0] === '깨진 목록', '관심 목록의 null — 화면이 안 터진다', (await ui()).none);

  console.log('\n[2] 단추');
  await js("document.querySelector('.seg[data-view=\"top\"]').click()");
  ok(same((await ui()).calls.setApp.at(-1), { stocksView: 'top' }), 'TOP 100 — 부탁만 한다', (await ui()).calls.setApp);
  ok((await ui()).on[0] === '관심', '…메인이 답하기 전에는 미리 칠하지 않는다', (await ui()).on);
  await push(top());
  const b1 = await ui();
  ok(same(b1.on, ['TOP 100', '국내', '시가총액']), 'TOP 100 · 국내 · 시가총액이 켜진다', b1.on);
  ok(same(b1.mk, []) && !b1.idx, '전부·국내·해외와 지수는 없다', { mk: b1.mk, idx: b1.idx });
  ok(!b1.krw, '국내에서는 원화가 없다 — 눌러도 아무 일이 없다', b1.krw);
  ok(same(b1.tm, ['국내', '미국']), '시장은 국내·미국', b1.tm);
  ok(same(b1.ts, ['시가총액', '거래대금', '상승', '하락', '인기']), '정렬 다섯', b1.ts);
  ok(b1.note === '네이버 · 거의 실시간 · 장중', '머리글 — 출처·장 상태', b1.note);
  await push(us());
  const b2 = await ui();
  ok(same(b2.on, ['TOP 100', '미국', '시가총액']), '미국이 켜진다', b2.on);
  ok(b2.krw && same(b2.ts, ['시가총액', '거래대금', '상승', '하락']), '미국 — 원화가 있고 인기가 없다', { krw: b2.krw, ts: b2.ts });
  ok(b2.note === '네이버 · 거의 실시간 · 장 마감', '장 마감', b2.note);
  await push(top({ status: null }));
  ok((await ui()).note === '네이버 · 거의 실시간', '장 상태를 모르면 안 쓴다', (await ui()).note);
  await push(top({ rows: [], loading: true, status: null }));
  ok((await ui()).note === '받는 중…' && (await ui()).spin, '줄 없이 받는 중', (await ui()).note);
  await push(top({ loading: true }));
  ok((await ui()).note === '받는 중…', '줄이 있어도 받는 중이면 머리글이 말한다 — 값이 그대로면 ↻ 를 눌렀는지 알 곳이 여기뿐이다', (await ui()).note);
  await push(top());
  ok((await ui()).note === '네이버 · 거의 실시간 · 장중', '…끝나면 돌아온다', (await ui()).note);
  // 묵은 줄과 실패 — «거의 실시간 · 장중» 을 쓰면 거짓말이다
  const longAgo = Date.now() - HOURS_7;
  await push(top({ at: longAgo }));
  ok((await ui()).note === `${stamp(longAgo)} 기준`, '오래 묵은 줄은 받은 시각으로', (await ui()).note);
  await push(top({ at: longAgo, loading: true }));
  ok((await ui()).note === `${stamp(longAgo)} 기준 · 받는 중…`, '…받는 동안에도', (await ui()).note);
  await push(top({ at: Date.now() - 2 * 60_000 }));
  ok((await ui()).note === '네이버 · 거의 실시간 · 장중', '2분은 아직 묵은 것이 아니다', (await ui()).note);
  const failAt = Date.now() - 30_000;
  await push(top({ at: failAt, error: 'HTTP 503' }));
  ok((await ui()).note === `${stamp(failAt)} 기준 · 새로 받지 못함`, '새로 받기 실패 — 방금 받은 줄이어도 실시간이라고 안 쓴다', (await ui()).note);
  await push(top({ at: failAt, error: 'HTTP 503', loading: true }));
  ok((await ui()).note === `${stamp(failAt)} 기준 · 받는 중…`, '…다시 해 보는 동안', (await ui()).note);
  await push(top({ rows: [], error: 'HTTP 503', at: 0 }));
  ok((await ui()).note === '새로 받지 못함', '줄이 없는 실패', (await ui()).note);
  await push(top({ rows: [], at: 0 }));
  ok((await ui()).note === '받는 중…', '아직 아무것도 없으면 받는 중', (await ui()).note);
  await push(top());
  await js("document.getElementById('say').textContent = ''");
  // ↻·닫기·Esc — 다리에 부탁만 한다
  await js("document.getElementById('refresh').click()");
  ok((await ui()).calls.refresh === 1, '↻ — 새로 받기를 부탁한다', (await ui()).calls.refresh);
  await js("document.getElementById('close').click()");
  ok((await ui()).calls.close === 1, '닫기', (await ui()).calls.close);
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 0");
  ok((await ui()).calls.close === 2, 'Esc 도 닫기', (await ui()).calls.close);
  for (const [sel, want] of [
    ['.seg[data-tm="US"]', { stocksTopMarket: 'US' }],
    ['.seg[data-tm="KR"]', { stocksTopMarket: 'KR' }],
    ['.seg[data-ts="priceTop"]', { stocksTopSort: 'priceTop' }],
    ['.seg[data-ts="searchTop"]', { stocksTopSort: 'searchTop' }],
    ['.seg[data-ts="down"]', { stocksTopSort: 'down' }],
    ['.seg[data-view="watch"]', { stocksView: 'watch' }]
  ]) {
    await js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    ok(same((await ui()).calls.setApp.at(-1), want), `${sel} — ${JSON.stringify(want)}`, (await ui()).calls.setApp.at(-1));
  }
  await push(top({ topSort: 'searchTop', rows: krUp }));
  ok((await ui()).on.includes('인기'), '인기가 켜진다', (await ui()).on);
  await push({ ...BASE, rows: watchRows });
  const b3 = await ui();
  ok(same(b3.mk, ['전부', '국내', '해외']) && b3.krw && b3.idx && same(b3.ts, []) && same(b3.tm, []) && b3.rows[1].del, '관심으로 돌아오면 다시 그대로', b3);
  await push(top());

  console.log('\n[3] 줄');
  const c1 = await ui();
  ok(same(c1.rows.map((r) => r.rk), ['1', '2', '3', '4', '5']), '번호', c1.rows.map((r) => r.rk));
  ok(same(c1.rows.map((r) => r.name), ['삼성전자', 'SK하이닉스', 'KODEX 200', '미래에셋 인버스 2X WTI원유 선물 ETN', 'SOL AI반도체TOP2플러스']), '이름', c1.rows.map((r) => r.name));
  ok(same(c1.rows.map((r) => r.metric), ['1,225조', '953조', '21.6조', '324억', '4.16조']), '시가총액', c1.rows.map((r) => r.metric));
  ok(same(c1.rows.map((r) => r.kd), [null, null, 'ETF', 'ETN', 'ETF']), 'ETF·ETN 표시 — 빼지 않는다', c1.rows.map((r) => r.kd));
  ok(c1.rows[0].px === '209,500' && c1.rows[0].pc === '-3.90%' && c1.rows[0].pcCls === 'pc dn', '값과 내림 색', c1.rows[0]);
  ok(c1.rows[3].pc === '+17.73%' && c1.rows[3].pcCls === 'pc up', '오름 색', c1.rows[3]);
  ok(c1.rows.every((r) => r.star === '☆' && !r.del && r.cls.includes('top') && r.cls.includes('tap')), '빈 별, × 단추 없음', c1.rows[0].cls);
  ok(c1.rows[0].title.includes('005930') && !c1.rows[0].metric.includes('005930') && c1.rows[0].title.includes('눌러서 차트'), '종목번호는 툴팁에', c1.rows[0].title);
  await push(top({ topSort: 'priceTop', rows: krTv }));
  ok((await ui()).rows[0].metric === '4,032억', '거래대금', (await ui()).rows[0].metric);
  await push(top({ topSort: 'up', rows: krUp }));
  ok((await ui()).rows.every((r) => r.metric === null), '상승·하락·인기 — 금액 없음', (await ui()).rows[0]);
  await push(us());
  const c2 = await ui();
  ok(c2.rows[0].name === '애플' && c2.rows[0].px === '349.51' && c2.rows[0].metric === '5.08조 달러' && c2.rows[0].title.includes('AAPL'), '미국 줄', c2.rows[0]);
  ok(c2.rows[1].title.includes('BRK-B'), '야후 기호가 툴팁에', c2.rows[1].title);
  await push(us({ topSort: 'up', rows: usUp }));
  const cr = await ui();
  ok(cr.rows[0].kd === '권리' && cr.rows[0].name === '브리스톨 마이어스 스퀴브' && cr.rows[0].title.includes('CELG-RI'), '권리 증서 표시 — 본주 이름으로 오므로', cr.rows[0]);
  ok(cr.rows.slice(1).every((r) => r.kd === null), '…다른 줄에는 없다', cr.rows.map((r) => r.kd));
  await push(us({ krw: true, rows: usCap.map((r) => ({ ...r, krwPrice: r.price * 1400 })) }));
  const c3 = await ui();
  ok(c3.rows[0].px === '489,314' && c3.on.includes('원화'), '원화 — 환산값, 단추도 켜진다 (값이 안 바뀌어도 다시 그린다)', c3.rows[0].px);
  await push(us());
  ok((await ui()).rows[0].px === '349.51', '끄면 달러', (await ui()).rows[0].px);

  console.log('\n[4] 별과 누르기');
  await push(top());
  await js("document.getElementById('q').value = '치던 글자'");
  await js("document.querySelector('#list .row .star').click()");
  const d1 = await until(async () => { const u = await ui(); return /넣었습니다/.test(u.say) ? u : null; });
  ok(!!d1 && same(d1.calls.add.at(-1), { ticker: '005930', name: '삼성전자', market: 'KR' }), '빈 별 — 객체로 넣는다', d1 && d1.calls.add);
  ok(!!d1 && d1.calls.chart.length === 0, '…차트를 안 연다', d1 && d1.calls.chart);
  ok((await js("document.getElementById('q').value")) === '치던 글자', '…입력칸에 치던 글자를 지우지 않는다');
  await js("document.getElementById('q').value = ''");
  await push(top({ watch: [{ ticker: '005930', name: '삼성전자', market: 'KR' }] }));
  const d2 = await ui();
  ok(d2.rows[0].star === '★' && d2.rows[1].star === '☆', '넣은 종목만 채운 별', d2.rows.map((r) => r.star));
  await js("document.querySelector('#list .row .star').click()");
  const d3 = await until(async () => { const u = await ui(); return /뺐습니다/.test(u.say) ? u : null; });
  ok(!!d3 && same(d3.calls.remove, ['005930']) && d3.calls.chart.length === 0, '채운 별 — 빼고, 차트를 안 연다', d3 && d3.calls.remove);
  await push(top());
  await js("window.__addReply = { ok: false, message: '그런 종목을 못 찾았습니다' }");
  await js("document.querySelector('#list .row .star').click()");
  const d4 = await until(async () => { const u = await ui(); return /못 찾았습니다/.test(u.say) ? u : null; });
  ok(!!d4 && d4.sayBad, '야후가 모르는 종목 — 지금 있는 말을 빨강으로', d4 && d4.say);
  await js("window.__addReply = { ok: true, added: false, name: '삼성전자', message: '이미 목록에 있습니다' }");
  await js("document.querySelector('#list .row .star').click()");
  const d5 = await until(async () => { const u = await ui(); return /이미 목록/.test(u.say) ? u : null; });
  ok(!!d5 && !d5.sayBad, '이미 있으면 빨강이 아니다', d5 && d5.say);
  await js("window.__addReply = { ok: true, added: true, name: '삼성전자', message: null }");

  // 찾는 동안 — 같은 줄은 겹쳐 부르지 않고, 다른 줄의 별은 씹히지 않는다
  // executeJavaScript 는 마지막 값이 약속이면 풀릴 때까지 기다리고, DOM 노드면 복제하다 실패한다 — 그런 글 끝에는 ; 0
  await js('window.__calls.add.length = 0; window.__addOpen = null; window.__addGate = new Promise((r) => { window.__addOpen = r; }); 0');
  await js("document.querySelectorAll('#list .row .star')[0].click(); document.querySelectorAll('#list .row .star')[0].click()");
  await js("document.querySelectorAll('#list .row .star')[1].click()");
  await sleep(50);
  const d6 = await ui();
  ok(same(d6.calls.add.map((x) => x.ticker), ['005930', '000660']), '찾는 동안 같은 줄은 한 번만, 다른 줄은 바로', d6.calls.add.map((x) => x.ticker));
  await js('window.__addGate = null; window.__addOpen()');
  await sleep(50);

  await js("document.querySelectorAll('#list .row')[2].click()");
  ok(same((await ui()).calls.chart, [{ ticker: '069500', name: 'KODEX 200', market: 'KR', index: false }]), '줄을 누르면 차트 — index:false', (await ui()).calls.chart);
  await push(us());
  await js("document.querySelectorAll('#list .row')[1].click()");
  ok(same((await ui()).calls.chart.at(-1), { ticker: 'BRK-B', name: '버크셔 해서웨이 Class B', market: 'US', index: false }), '미국 줄은 야후 기호로', (await ui()).calls.chart.at(-1));

  // 별은 호버에만, 채운 별은 늘 — 진짜 마우스 이벤트로 잰다
  await push(top({ watch: [{ ticker: '000660', name: 'SK하이닉스', market: 'KR' }] }));
  const opacity = () => js("[...document.querySelectorAll('#list .row .star')].map((s) => getComputedStyle(s).opacity)");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await sleep(60);
  const o1 = await opacity();
  ok(o1[0] === '0' && o1[1] === '1' && o1[2] === '0', '마우스가 없으면 빈 별은 안 보이고 채운 별은 보인다', o1);
  const at = await js("(() => { const r = document.querySelector('#list .row').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  await until(async () => (await opacity())[0] === '1', 3000);
  const o2 = await opacity();
  ok(o2[0] === '1' && o2[2] === '0', '줄에 올리면 그 줄의 빈 별만 보인다', o2);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await sleep(60);

  console.log('\n[5] 다시 그리기');
  await push(top());
  await js("window.__row = document.querySelector('#list .row'); 0");
  const kept = () => js("window.__row === document.querySelector('#list .row')");
  await push(top());
  ok(await kept(), '값이 그대로면 안 그린다');
  await push(top({ loading: true }));
  ok(await kept(), '받는 중으로 바뀌어도 줄을 안 부순다 — 올려둔 마우스가 깜빡이지 않게');
  await push(top());
  ok(await kept(), '…끝나도');
  await push(top({ watch: [{ ticker: '999999', name: '다른 종목', market: 'KR' }] }));
  ok(!(await kept()), '관심 목록이 바뀌면 다시 그린다');
  await js("window.__row = document.querySelector('#list .row'); 0");
  await push(top({ watch: [{ ticker: '005930', name: '삼성전자', market: 'KR' }] }));
  ok(!(await kept()) && (await ui()).rows[0].star === '★', '…수가 같아도 — 어느 종목인지가 바뀌었다', (await ui()).rows[0].star);
  await js("window.__row = document.querySelector('#list .row'); 0");
  const bumped = krCap.map((r, i) => (i ? r : { ...r, metric: '1,226조' }));
  await push(top({ watch: [{ ticker: '005930', name: '삼성전자', market: 'KR' }], rows: bumped }));
  ok(!(await kept()) && (await ui()).rows[0].metric === '1,226조', '금액만 바뀌어도 다시 그린다', (await ui()).rows[0].metric);
  await js("window.__row = document.querySelector('#list .row'); 0");
  await push(top({ watch: [{ ticker: '005930', name: '삼성전자', market: 'KR' }], rows: bumped, topSort: 'up' }));
  ok(!(await kept()), '줄이 같아도 정렬이 바뀌면 다시 그린다 — 금액을 빼야 할 수 있다');
  await js("window.__row = document.querySelector('#list .row'); 0");
  await push(top({ watch: [{ ticker: '005930', name: '삼성전자', market: 'KR' }], rows: bumped, topSort: 'up', topMarket: 'US' }));
  ok(!(await kept()), '시장이 바뀌어도');

  console.log('\n[6] 스크롤');
  const longRows = (price) => Array.from({ length: 100 }, (_, i) => ({ ...krCap[0], rank: i + 1, ticker: String(i).padStart(6, '0'), price }));
  await push(top({ rows: longRows(100) }));
  const setScroll = (y) => js(`document.getElementById('list').scrollTop = ${y}`);
  const scroll = () => js("document.getElementById('list').scrollTop");
  ok((await js("(() => { const l = document.getElementById('list'); return l.scrollHeight > l.clientHeight + 1000; })()")), '100줄이면 스크롤이 생긴다');
  await setScroll(800);
  ok((await scroll()) === 800, '스크롤을 내린다', await scroll());
  await push(top({ rows: longRows(101) }));
  ok((await ui()).rows[0].px === '101' && (await scroll()) === 800, '같은 고르기를 다시 그려도 그 자리에 있다', await scroll());
  await push(top({ rows: longRows(101), error: 'HTTP 500' }));
  ok((await scroll()) === 800, '실패를 알려도 그 자리에 있다', await scroll());
  await push(top({ rows: longRows(101) }));
  await push(top({ rows: longRows(101), topSort: 'up' }));
  ok((await scroll()) === 0, '정렬이 바뀌면 맨 위로', await scroll());
  await setScroll(800);
  await push(top({ rows: longRows(101), topSort: 'up', topMarket: 'US' }));
  ok((await scroll()) === 0, '시장이 바뀌어도', await scroll());
  await setScroll(800);
  await push({ ...BASE, rows: watchRows });
  await push(top({ rows: longRows(101), topSort: 'up', topMarket: 'US' }));
  ok((await scroll()) === 0, '관심에 다녀와도 맨 위부터', await scroll());
  await setScroll(800);
  await push(top({ rows: [], loading: true, topSort: 'down' }));
  await push(top({ rows: longRows(101), topSort: 'down' }));
  ok((await scroll()) === 0, '아직 안 받은 고르기 — 받는 중에도 답이 와도 맨 위', await scroll());
  // 비운다고 0 이 되는 것은 아니다 — 관심 줄이 스크롤이 생길 만큼 많아야 잴 수 있다
  const manyWatch = Array.from({ length: 60 }, (_, i) => ({ ...watchRows[1], ticker: String(i).padStart(6, '0') }));
  await setScroll(800);
  ok((await scroll()) === 800, '순위에서 내린 뒤', await scroll());
  await push({ ...BASE, rows: manyWatch, watch: [{ ticker: '000000', name: '삼성전자', market: 'KR' }] });
  ok((await js("document.getElementById('list').scrollHeight > document.getElementById('list').clientHeight + 800")), '…관심 줄에도 스크롤이 있고');
  ok((await scroll()) === 0, '…관심으로 가면 맨 위부터', await scroll());

  console.log('\n[7] 실패·빈 상태');
  await push(top());
  await js("document.getElementById('say').textContent = ''");
  await push(top({ error: 'HTTP 500' }));
  const e1 = await ui();
  ok(e1.rows.length === 5 && e1.say === '순위를 새로 받지 못했습니다 — HTTP 500' && e1.sayBad && e1.none.length === 0, '줄이 있으면 그대로 두고 say 줄에 빨강으로', { say: e1.say, rows: e1.rows.length });
  await push(top());
  const e2 = await ui();
  ok(e2.say === '' && !e2.sayBad, '다시 되면 그 말을 지운다', e2.say);
  await push(top({ error: 'HTTP 500' }));
  await js("document.getElementById('say').textContent = '삼성전자 넣었습니다'");
  await push(top());
  ok((await ui()).say === '삼성전자 넣었습니다', '…그 사이 다른 말이 왔으면 그 말을 지우지 않는다', (await ui()).say);
  await js("document.getElementById('say').textContent = ''");
  // 실패 말이 별 한 번에 덮여도, 같은 실패가 또 와도 머리글에는 실패가 남는다
  const stuckAt = Date.now() - 30_000;
  await push(top({ error: 'HTTP 500', at: stuckAt }));
  await js("document.getElementById('say').textContent = '삼성전자 넣었습니다'");
  await push(top({ error: 'HTTP 500', at: stuckAt }));
  const e4 = await ui();
  ok(e4.say === '삼성전자 넣었습니다' && e4.note === `${stamp(stuckAt)} 기준 · 새로 받지 못함`, 'say 가 덮여도 머리글이 실패를 말한다', { say: e4.say, note: e4.note });
  await push(top());
  await js("document.getElementById('say').textContent = ''");
  await push(top({ error: '시간 초과', rows: [] }));
  const e3 = await ui();
  ok(e3.rows.length === 0 && same(e3.none, ['순위를 받지 못했습니다 — 시간 초과']) && e3.say === '', '줄이 하나도 없으면 목록 자리에', e3.none);
  await push(top({ rows: [], loading: true }));
  ok(same((await ui()).none, ['순위를 받는 중…']), '받는 중', (await ui()).none);
  await push(top({ rows: [] }));
  ok(same((await ui()).none, ['순위를 받는 중…']), '아직 답이 없을 때도', (await ui()).none);
  await push(top({ topSort: 'down', rows: krUp, error: 'HTTP 500' }));
  await push({ ...BASE, rows: watchRows });
  ok((await ui()).say === '', '관심으로 가면 순위 실패 글은 사라진다', (await ui()).say);
  ok(w.errs.length === 0, '콘솔 오류가 없다', w.errs.slice(0, 5));

  console.log('\n[8] 300px');
  const n = await open(300, 520);
  const fit = () => n.js(`(() => {
    const card = document.querySelector('.card').getBoundingClientRect();
    const vis = (el) => !el.hidden && el.getBoundingClientRect().width > 0;
    const out = (el, box) => { const r = el.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; };
    const bars = [...document.querySelectorAll('.bar')].filter(vis);
    const rows = [...document.querySelectorAll('#list .row')];
    const list = document.getElementById('list');
    return {
      vw: innerWidth,
      segOut: [...document.querySelectorAll('.seg')].filter(vis).filter((b) => out(b, card)).map((b) => b.textContent),
      segTall: [...document.querySelectorAll('.seg')].filter(vis).filter((b) => b.getBoundingClientRect().height > 30).map((b) => b.textContent),
      wrap: bars.every((b) => getComputedStyle(b).flexWrap === 'wrap'),
      barOver: Math.max(...bars.map((b) => b.scrollWidth - b.clientWidth)),
      cardOver: document.querySelector('.card').scrollWidth - document.querySelector('.card').clientWidth,
      listOver: list.scrollWidth - list.clientWidth,
      rowOut: rows.filter((r) => [...r.children].some((c) => out(c, r.getBoundingClientRect()))).length,
      nameW: rows.length ? Math.min(...rows.map((r) => r.querySelector('.nm b').getBoundingClientRect().width)) : 0,
      metricOut: rows.filter((r) => { const i = r.querySelector('.nm i'); return i && out(i, r.querySelector('.nm').getBoundingClientRect()); }).length,
      metricCut: rows.filter((r) => { const i = r.querySelector('.nm i'); return i && getComputedStyle(i).textOverflow !== 'ellipsis' && r.classList.contains('top'); }).length,
      noteH: document.getElementById('note').getBoundingClientRect().height,
      rows: rows.length
    };
  })()`);
  // 줄 수도 본다 — 줄이 0개면 넘치는 줄도 0개라 그냥 통과한다
  const fine = (f, rows) => Math.abs(f.vw - 300) <= 1 && f.rows === rows && f.wrap && !f.segOut.length && !f.segTall.length && f.barOver <= 0 && f.cardOver <= 0 && f.listOver <= 0 && !f.rowOut && !f.metricOut && !f.metricCut;
  await n.push({ ...BASE, rows: watchRows });
  const f1 = await fit();
  ok(fine(f1, 2), '관심 — 넘치지 않는다', f1);
  await n.push(top());
  const f2 = await fit();
  ok(fine(f2, 5), '국내 — 단추는 줄을 바꾸고 넘치지 않는다', f2);
  ok(f2.nameW >= 40, '…이름이 석 자로 잘리지 않는다 (금액이 아랫줄로 내려간다)', f2.nameW);
  await n.push(us({ krw: true, rows: usCap.map((r) => ({ ...r, krwPrice: r.price * 1400 })) }));
  const f3 = await fit();
  ok(fine(f3, 3), '미국 + 원화 — 넘치지 않는다 (우선주 WHR PRA 는 시가총액 순위에서 빠져 3줄)', f3);
  await n.push(top({ rows: krCap.map((r) => ({ ...r, price: 3456789, pct: -29.99, metric: '1,234조', name: '아주아주아주아주아주아주아주아주아주아주아주 긴 이름의 상장지수상품', kind: 'etn' })) }));
  const f4 = await fit();
  ok(fine(f4, 5), '긴 이름·큰 값 — 넘치지 않는다', f4);
  // 실측 BRK-A 869,300.76 × 환율 1400 — 이름 칸이 금액보다 좁아지는 줄
  await n.push(us({ krw: true, rows: [{ ...usCap[0], ticker: 'BRK-A', name: '버크셔 해서웨이 Class A', price: 869300.76, krwPrice: 1217021064, metric: '1.06조 달러' }] }));
  const f5 = await fit();
  ok(fine(f5, 1), 'BRK-A + 원화 — 금액이 칸 안에서 말줄임으로 끝난다', f5);
  // 가장 긴 머리글 (날짜 + 시각 + 실패) 도 한 줄이다
  await n.push(top({ error: 'HTTP 500', at: new Date(2000, 10, 14, 15, 30).getTime() }));
  const f6 = await fit();
  ok(f6.noteH < 20, '가장 긴 머리글도 한 줄', { note: await n.js("document.getElementById('note').textContent"), h: f6.noteH });
  n.win.destroy();
  // 기본 크기에서는 관심 보기의 단추가 한 줄이다 — 지금 모습이 안 바뀐다
  await push({ ...BASE, rows: watchRows });
  const oneLine = await js(`(() => {
    const segs = [...document.querySelectorAll('.bar .seg')].filter((b) => !b.hidden && b.getBoundingClientRect().width > 0);
    return new Set(segs.map((b) => Math.round(b.getBoundingClientRect().top))).size;
  })()`);
  ok(oneLine === 1, '기본 폭(404)의 관심 보기는 단추가 한 줄', oneLine);

  console.log('\n[9] 두 테마');
  await push(top({ watch: [{ ticker: '000660', name: 'SK하이닉스', market: 'KR' }], status: 'OPEN' }));
  await js("document.getElementById('say').textContent = ''");
  const look = () => js(`(() => {
    const c = (el) => getComputedStyle(el);
    const probe = document.createElement('span');
    document.body.append(probe);
    const tok = (name) => { probe.style.color = 'var(' + name + ')'; return c(probe).color; };
    const rows = document.querySelectorAll('#list .row');
    const out = {
      theme: document.documentElement.getAttribute('data-theme'),
      up: c(rows[3].querySelector('.pc')).color, dn: c(rows[0].querySelector('.pc')).color,
      rk: c(rows[0].querySelector('.rk')).color, metric: c(rows[0].querySelector('.nm i')).color, name: c(rows[0].querySelector('.nm b')).color,
      kd: c(rows[2].querySelector('.kd')).color, kdBg: c(rows[2].querySelector('.kd')).backgroundColor,
      starOn: c(rows[1].querySelector('.star')).color, starOff: c(rows[0].querySelector('.star')).color,
      seg: c(document.querySelector('.seg.on')).backgroundColor, segInk: c(document.querySelector('.seg.on')).color,
      segOff: c(document.querySelector('.seg[data-ts="up"]')).color,
      tokUp: tok('--up'), tokDn: tok('--dn'), tokTer: tok('--tertiary'), tokSec: tok('--secondary'), tokLabel: tok('--label'), tokAcc: tok('--accent'), tokFill: tok('--accent-fill')
    };
    probe.remove();
    return out;
  })()`);
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  const t1 = await look();
  await js("document.documentElement.setAttribute('data-theme', 'light')");
  const t2 = await look();
  for (const t of [t1, t2]) {
    ok(t.up === t.tokUp && t.dn === t.tokDn, `${t.theme} — 오름·내림은 그 테마의 이름 색`, { up: t.up, dn: t.dn });
    ok(t.rk === t.tokTer && t.metric === t.tokTer && t.starOff === t.tokTer, `${t.theme} — 번호·금액·빈 별은 옅은 글자색`, { rk: t.rk, metric: t.metric });
    ok(t.name === t.tokLabel && t.kd === t.tokSec, `${t.theme} — 이름과 표시 글자`, { name: t.name, kd: t.kd });
    ok(t.starOn === t.tokAcc && t.segOff === t.tokAcc, `${t.theme} — 채운 별·꺼진 단추는 강조 글자색`, t.starOn);
  }
  ok(t1.seg === t1.tokAcc && t1.segInk === 'rgb(6, 35, 29)', '다크 — 켜진 단추는 강조색에 짙은 글자', { bg: t1.seg, ink: t1.segInk });
  ok(t2.seg === t2.tokFill && t2.segInk === 'rgb(255, 255, 255)', '라이트 — 켜진 단추는 채움색에 흰 글자 (어두운 글자는 2.4:1 이다)', { bg: t2.seg, ink: t2.segInk });
  ok(t1.up !== t2.up && t1.tokTer !== t2.tokTer && t1.kdBg !== t2.kdBg, '테마가 바뀌면 색이 바뀐다', [t1.up, t2.up]);
  await js("document.documentElement.setAttribute('data-theme', 'dark')");

  console.log('\n[10] 파일');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const html = read('renderer/stocks.html');
  ok(html.includes(`content="default-src 'none'; script-src file: 'unsafe-inline'; style-src file: 'unsafe-inline'; font-src file:;"`), 'CSP 는 그대로 — 그림 주소를 안 연다');
  ok(!/<img\b/.test(html) && !/createElement\('img'\)/.test(read('renderer/stocks.js')), '로고 그림을 안 쓴다');
  const preload = read('src/preload.js');
  for (const name of ['stocksSetApp', 'stocksAdd', 'stocksRemove', 'chartOpen', 'onStocksData', 'stocksRefresh']) {
    ok(new RegExp(`\\b${name}:`).test(preload), `preload 에 ${name} — 시험용 다리와 같은 이름`);
  }
  ok(w.errs.length === 0, '콘솔 오류가 없다', w.errs.slice(0, 5));
  ok(n.errs.length === 0, '좁은 창도 콘솔 오류가 없다', n.errs.slice(0, 5));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

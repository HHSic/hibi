'use strict';
// 주식 창 TOP 100 — 네이버 순위 목록을 줄로 다듬고, 미국 거래소 셋을 합치고, 창이 고르기·캐시·늦은 답을 어떻게 다루는가.
//
// 창도 진짜 Electron 도 쓰지 않는다 — electron 은 Module._load 로 바꿔 끼우고, main.js 를 싣지 않는다.
// 네트워크에도 안 나간다 — https.get 을 가로채 test/fixtures/stocktop-rows.json (실제 줄을 깎은 것)을 준다. 끊김만은 127.0.0.1 서버로 진짜 소켓을 끊는다.
// 화면은 stocktopui.test.js 가 본다.
//   [1] 고르기 — 저장값이 이상하면 읽을 때 기본값으로, 미국의 인기는 시가총액으로
//   [2] 국내 줄 다듬기 — 주소, 숫자, 종류, 짧은 금액, 네이버 순서 그대로
//   [3] 미국 합치기 — 거래소 셋, 값으로 다시 줄 세우기, 겹침, 100개, 번호, 권리 표시
//   [4] 야후 기호 — BRK B·WHR PRA·CELG RT·GRAF.U (실측한 모양)
//   [5] 모양이 바뀐 답 — 던지되 글로, NaN 줄은 없다. 잘린 답, 거래소 하나라도 실패하면 그 회차는 실패다, 본문 도중 끊김 (진짜 소켓 포함)
//   [6] store 기본값
//   [7] 창 — 관심 그대로, 받는 중에 고르기가 바뀌어도 바로 받는다, 늦은 답, 캐시, 실패, 원화, 야후 안 부르기, 별, 끊김, 닫힌 창
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const Module = require('module');
const { EventEmitter } = require('events');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();
// 영영 안 오는 답을 기다리다 일감이 떨어지면 node 는 판정 없이 조용히 끝난다 — 끝까지 못 갔으면 실패다
process.exitCode = 1;

const ROOT = path.join(__dirname, '..');
const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocktop-rows.json'), 'utf8'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let open; let fail; const promise = new Promise((a, b) => { open = a; fail = b; }); return { promise, open, fail }; };
/** 던졌으면 그 오류를, 안 던졌으면 null 을 */
const thrown = (p) => p.then(() => null, (e) => e);
/** 끝났으면 그 값이나 오류를, 시간 안에 안 끝나면 '안 끝남' 을 — 영영 안 끝나는 약속을 재는 곳에 쓴다 */
const settled = (p, ms = 500) => Promise.race([p.then((v) => v, (e) => e), new Promise((r) => setTimeout(() => r('안 끝남'), ms))]);

// ── 가짜 electron ─────────────────────────────────
// 실제 설정 폴더를 건드리지 않게 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const dataDir = fs.mkdtempSync(path.join(process.env.HIBI_TEST_OUT || os.tmpdir(), 'stocktop-'));
const handlers = new Map();
const listeners = new Map();

class FakeWin {
  constructor() {
    this.destroyed = false;
    this.on_ = {};
    this.sent = [];
    this.webContents = {
      // 메인이 들고 있는 객체를 그대로 두면 나중에 바뀐 값이 지난 답처럼 보인다 — 보낸 순간의 모양을 남긴다
      send: (ch, b) => { if (ch === 'stocks:data') this.sent.push(JSON.parse(JSON.stringify(b))); },
      once: (ev, fn) => { this.on_[`wc:${ev}`] = fn; },
      on: () => {},
      setWindowOpenHandler: () => {},
      isDestroyed: () => this.destroyed
    };
    FakeWin.last = this;
  }
  loadFile() {}
  on(ev, fn) { this.on_[ev] = fn; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  moveTop() {}
  focus() {}
  close() { this.destroyed = true; if (this.on_.closed) this.on_.closed(); }
  getBounds() { return { x: 0, y: 0, width: 404, height: 544 }; }
  static getAllWindows() { return []; }
}

const electronStub = {
  app: { getPath: () => dataDir, getName: () => 'Hibi', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: FakeWin,
  ipcMain: {
    on: (ch, fn) => listeners.set(ch, fn),
    handle: (ch, fn) => handlers.set(ch, fn)
  },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayMatching: () => ({ workAreaSize: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  },
  nativeTheme: { shouldUseDarkColors: true, on: () => {} },
  shell: { openExternal: () => {} },
  session: { defaultSession: { allowNTLMCredentialsForDomains: () => {} } }
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === 'electron' ? electronStub : realLoad.call(this, request, ...rest);
};

// ── 가짜 네트워크 ─────────────────────────────────
let route = (url) => { throw new Error(`시험: 부를 줄 몰랐던 주소 ${url}`); };
const asked = [];
https.get = (url, _opts, cb) => {
  const u = String(url);
  asked.push(u);
  const req = new EventEmitter();
  req.destroy = () => {};
  Promise.resolve().then(() => route(u)).then((a) => {
    if (a.error) { req.emit('error', new Error(a.error)); return; }
    const res = new EventEmitter();
    res.statusCode = a.status || 200;
    res.resume = () => {};
    cb(res);
    res.emit('data', Buffer.from(typeof a.body === 'string' ? a.body : JSON.stringify(a.body)));
    // 본문 도중 끊김. 진짜 응답도 듣는 이가 없으면 'error' 를 내지 않는다
    if (a.cut) { if (res.listenerCount(a.cut)) res.emit(a.cut, new Error('aborted')); return; }
    res.emit('end');
  });
  return req;
};

const stocks = require(path.join(ROOT, 'src', 'stocks.js'));
const fx = require(path.join(ROOT, 'src', 'fx.js'));

const answer = (rows, status = 'OPEN') => ({ body: { stocks: rows, totalCount: rows.length, marketStatus: status } });
const krRoute = (rows, status) => () => answer(rows, status);
/** 거래소 이름 → 답. 없는 거래소는 빈 듯 실패하지 않게 시험이 다 적는다 */
const usRoute = (m) => (url) => m[url.match(/exchange\/(\w+)\//)[1]];
const usRow = (sym, over = {}) => ({ ...F.us.apple, symbolCode: sym, ...over });

const realTop = stocks.top;
const realBuild = stocks.build;
const realLookup = stocks.lookup;

async function main() {
  console.log('\n[1] 고르기');
  {
    ok(same(stocks.topPick({}), { view: 'watch', market: 'KR', sort: 'marketValue' }), '설정이 없으면 관심 · 국내 · 시가총액', stocks.topPick({}));
    ok(same(stocks.topPick({ stocksView: 'top', stocksTopMarket: 'US', stocksTopSort: 'priceTop' }), { view: 'top', market: 'US', sort: 'priceTop' }), '맞는 값은 그대로');
    ok(same(stocks.topPick({ stocksView: 'zzz', stocksTopMarket: 'JP', stocksTopSort: '../../x' }), { view: 'watch', market: 'KR', sort: 'marketValue' }), '이상한 저장값은 기본값으로');
    ok(same(stocks.topPick({ stocksView: null, stocksTopMarket: 7, stocksTopSort: {} }), { view: 'watch', market: 'KR', sort: 'marketValue' }), '글자가 아닌 저장값도 기본값으로');
    ok(stocks.topPick({ stocksTopMarket: 'KR', stocksTopSort: 'searchTop' }).sort === 'searchTop', '국내의 인기는 그대로');
    ok(stocks.topPick({ stocksTopMarket: 'US', stocksTopSort: 'searchTop' }).sort === 'marketValue', '미국의 인기는 시가총액으로 — 미국에는 인기 목록이 없다');
    ok(same(stocks.topPick(), { view: 'watch', market: 'KR', sort: 'marketValue' }), '인자가 없어도 터지지 않는다');
  }

  console.log('\n[2] 국내 줄 다듬기');
  {
    route = krRoute([F.kr.samsung, F.kr.hynix, F.kr.etf, F.kr.etn, F.kr.oddCode]);
    asked.length = 0;
    const r = await stocks.top({ market: 'KR', sort: 'marketValue' });
    ok(same(asked, ['https://m.stock.naver.com/api/stocks/marketValue/all?page=1&pageSize=100']), '국내는 cat=all 한 번', asked);
    ok(r.status === 'OPEN', '장 상태를 답에서 읽는다', r.status);
    const s = r.rows[0];
    ok(s.rank === 1 && s.ticker === '005930' && s.name === '삼성전자' && s.market === 'KR', '순위·종목번호·이름·시장', s);
    ok(s.price === 209500 && s.pct === -3.9 && s.currency === 'KRW', '값은 수로 — 쉼표가 있는 글자를 그대로 넘기지 않는다', { price: s.price, pct: s.pct });
    ok(s.kind === 'stock' && r.rows[2].kind === 'etf' && r.rows[3].kind === 'etn', 'ETF·ETN 은 빼지 않고 표시만 한다', r.rows.map((x) => x.kind));
    ok(same(r.rows.map((x) => x.rank), [1, 2, 3, 4, 5]), '번호가 이어진다');
    ok(r.rows[4].ticker === '0167A0', '숫자 여섯 자리가 아닌 코드도 그대로', r.rows[4].ticker);
    ok(same(r.rows.map((x) => x.metric), ['1,225조', '953조', '21.6조', '324억', '4.16조']), '시가총액은 짧게 (원 단위 raw 에서)', r.rows.map((x) => x.metric));
    ok(r.rows.every((x) => x.exchange === 'KOSPI'), '거래소 이름 — 툴팁에 쓴다');
    ok(r.rows.every((x) => !('rankBy' in x)), '줄 세우는 데 쓴 값은 화면으로 안 나간다');

    route = krRoute([F.kr.etf, F.kr.samsung, F.kr.hynix]);
    const o = await stocks.top({ market: 'KR', sort: 'marketValue' });
    ok(same(o.rows.map((x) => x.ticker), ['069500', '005930', '000660']), '국내는 네이버가 준 순서 그대로 — 다시 줄 세우지 않는다', o.rows.map((x) => x.ticker));

    route = krRoute([F.kr.hynix, F.kr.samsung, F.kr.etf]);
    asked.length = 0;
    const p = await stocks.top({ market: 'KR', sort: 'priceTop' });
    ok(asked[0].endsWith('/api/stocks/priceTop/all?page=1&pageSize=100'), '거래대금은 priceTop (이름과 달리 거래대금 순위다 — 실측)', asked[0]);
    ok(same(p.rows.map((x) => x.metric), ['4,907억', '4,032억', '2,003억']), '거래대금도 짧게', p.rows.map((x) => x.metric));

    for (const sort of ['up', 'down']) {
      asked.length = 0;
      const u = await stocks.top({ market: 'KR', sort });
      ok(asked[0].endsWith(`/api/stocks/${sort}/all?page=1&pageSize=100`) && u.rows.every((x) => x.metric == null), `${sort} — 더 보여 줄 금액이 없다`, asked[0]);
    }
    asked.length = 0;
    const st = await stocks.top({ market: 'KR', sort: 'searchTop' });
    ok(same(asked, ['https://m.stock.naver.com/api/stocks/searchTop?page=1&pageSize=100']) && st.rows.every((x) => x.metric == null), '인기는 cat 이 없는 주소', asked);

    // 네이버의 국내 상승·하락은 등락률 순서가 아니다 (실측: 37위 8.54% 가 42위 11.25% 보다 위) — 받은 줄 안에서 다시 줄 세운다
    const moved = [
      { ...F.kr.samsung, fluctuationsRatio: '8.54' },
      { ...F.kr.hynix, fluctuationsRatio: '11.25' },
      { ...F.kr.etf, fluctuationsRatio: '9.00' },
      { ...F.kr.etn, fluctuationsRatio: '9.00' }
    ];
    route = krRoute(moved);
    const mu = await stocks.top({ market: 'KR', sort: 'up' });
    ok(same(mu.rows.map((x) => x.pct), [11.25, 9, 9, 8.54]), '국내 상승 — 등락률 큰 것부터', mu.rows.map((x) => x.pct));
    ok(same(mu.rows.map((x) => x.rank), [1, 2, 3, 4]), '…번호는 줄 순서와 맞는다', mu.rows.map((x) => x.rank));
    ok(mu.rows[1].ticker === F.kr.etf.itemCode && mu.rows[2].ticker === F.kr.etn.itemCode, '…같은 값이면 네이버 순서', mu.rows.map((x) => x.ticker));
    const md = await stocks.top({ market: 'KR', sort: 'down' });
    ok(same(md.rows.map((x) => x.pct), [8.54, 9, 9, 11.25]), '국내 하락 — 등락률 작은 것부터', md.rows.map((x) => x.pct));
    const mt = await stocks.top({ market: 'KR', sort: 'marketValue' });
    ok(same(mt.rows.map((x) => x.ticker), moved.map((x) => x.itemCode)), '…시가총액은 등락률로 줄 세우지 않는다', mt.rows.map((x) => x.ticker));
    const ms = await stocks.top({ market: 'KR', sort: 'searchTop' });
    ok(same(ms.rows.map((x) => x.ticker), moved.map((x) => x.itemCode)), '…인기도 네이버 순서 그대로', ms.rows.map((x) => x.ticker));

    route = krRoute([F.kr.samsung], 'CLOSE');
    ok((await stocks.top({ market: 'KR', sort: 'up' })).status === 'CLOSE', '장 마감도 읽는다');
    route = () => ({ body: { stocks: [{ ...F.kr.samsung, marketStatus: 'OPEN' }] } });
    ok((await stocks.top({ market: 'KR', sort: 'up' })).status === 'OPEN', '답 머리에 없으면 줄에서 읽는다');
    route = () => ({ body: { stocks: [{ ...F.kr.samsung, marketStatus: undefined }] } });
    ok((await stocks.top({ market: 'KR', sort: 'up' })).status === null, '어디에도 없으면 null — 지어내지 않는다');

    route = krRoute([F.kr.samsung]);
    asked.length = 0;
    await stocks.top({ market: 'KR', sort: '../../x' });
    ok(asked[0].endsWith('/api/stocks/marketValue/all?page=1&pageSize=100'), '모르는 정렬은 주소에 안 들어간다', asked[0]);
  }

  console.log('\n[3] 미국 합치기');
  {
    route = usRoute({
      NASDAQ: answer([F.us.apple], 'CLOSE'),
      NYSE: answer([F.us.brk, F.us.whrPref, usRow('AAPL', { marketValueRaw: '10' })], 'CLOSE'),
      AMEX: answer([F.us.amex, F.us.unit], 'CLOSE')
    });
    asked.length = 0;
    const r = await stocks.top({ market: 'US', sort: 'marketValue' });
    ok(same(asked.slice().sort(), ['AMEX', 'NASDAQ', 'NYSE'].map((x) => `https://api.stock.naver.com/stock/exchange/${x}/marketValue?page=1&pageSize=100`)), '거래소 셋을 다 부른다', asked);
    ok(same(r.rows.map((x) => x.ticker), ['AAPL', 'BRK-B', 'ET', 'GRAF-UN']), '값으로 다시 줄 세운다, 우선주는 시가총액 순위에서 뺀다', r.rows.map((x) => x.ticker));
    ok(same(r.rows.map((x) => x.rank), [1, 2, 3, 4]), '번호는 합친 뒤에 매긴다', r.rows.map((x) => x.rank));
    ok(r.rows.filter((x) => x.ticker === 'AAPL').length === 1, '겹치는 종목은 한 줄');
    ok(same(r.rows.map((x) => x.metric), ['5.08조 달러', '8,154억 달러', '670억 달러', '3억 달러']), '달러 금액', r.rows.map((x) => x.metric));

    // 우선주 시가총액은 네이버 값이 틀린다 (실측: 28.69달러 WHR PRA 가 3,299억 달러로 38위, 보통주 WHR 은 상위 100에 없음)
    const prefs = [usRow('PCG PRC', { marketValueRaw: '-' }), usRow('AHT.PRI'), usRow('XYZ PR')];
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer([F.us.brk, F.us.whrPref, ...prefs]), AMEX: answer([F.us.amex]) });
    const noPref = await stocks.top({ market: 'US', sort: 'marketValue' });
    ok(same(noPref.rows.map((x) => x.ticker), ['AAPL', 'BRK-B', 'ET']), '우선주 꼬리 PR·PRA 는 공백·점 모두 뺀다, 시가총액이 «-» 여도 순위를 안 죽인다', noPref.rows.map((x) => x.ticker));
    const prefUp = await stocks.top({ market: 'US', sort: 'up' });
    ok(prefUp.rows.some((x) => x.ticker === 'WHR-PA'), '…상승 순위에는 우선주가 남는다', prefUp.rows.map((x) => x.ticker));
    route = usRoute({ NASDAQ: answer([usRow('PRA'), usRow('APRN')]), NYSE: answer([usRow('BPR')]), AMEX: answer([F.us.amex]) });
    const notPref = await stocks.top({ market: 'US', sort: 'marketValue' });
    ok(same(notPref.rows.map((x) => x.ticker).sort(), ['APRN', 'BPR', 'ET', 'PRA']), '…꼬리가 아니면 PR 이 들어 있어도 안 뺀다', notPref.rows.map((x) => x.ticker));
    ok(r.rows[0].price === 349.51 && r.rows[0].pct === 5.31 && r.rows[0].currency === 'USD' && r.rows[0].market === 'US' && r.rows[0].name === '애플', '값·통화·시장·한글 이름', r.rows[0]);
    ok(r.status === 'CLOSE', '장 상태', r.status);

    route = usRoute({
      NASDAQ: answer([F.us.apple], 'OPEN'),
      NYSE: answer([F.us.brk], 'CLOSE'),
      AMEX: answer([F.us.amex], 'CLOSE')
    });
    ok((await stocks.top({ market: 'US', sort: 'marketValue' })).status === 'OPEN', '한 거래소라도 열려 있으면 장중');

    const many = (prefix, base) => Array.from({ length: 60 }, (_, i) => usRow(`${prefix}${i}`, {
      marketValueRaw: String(base + i * 3), accumulatedTradingValueRaw: String(base + i * 3), fluctuationsRatioRaw: String((base + i * 3) / 100), closePriceRaw: '10'
    }));
    const lists = { NASDAQ: many('A', 1000), NYSE: many('B', 1001), AMEX: many('C', 1002) };
    route = usRoute({ NASDAQ: answer(lists.NASDAQ), NYSE: answer(lists.NYSE), AMEX: answer(lists.AMEX) });
    const all = [...lists.NASDAQ, ...lists.NYSE, ...lists.AMEX];
    const by = (f, dir) => [...all].sort((a, b) => dir * (Number(a[f]) - Number(b[f]))).map((x) => x.symbolCode);
    const big = await stocks.top({ market: 'US', sort: 'marketValue' });
    ok(big.rows.length === 100 && big.rows[99].rank === 100, '합쳐서 100개만', big.rows.length);
    ok(same(big.rows.map((x) => x.ticker), by('marketValueRaw', -1).slice(0, 100)), '…큰 값부터');
    const tv = await stocks.top({ market: 'US', sort: 'priceTop' });
    ok(same(tv.rows.map((x) => x.ticker), by('accumulatedTradingValueRaw', -1).slice(0, 100)), '거래대금 — 거래대금 raw 로');
    const up = await stocks.top({ market: 'US', sort: 'up' });
    ok(same(up.rows.map((x) => x.ticker), by('fluctuationsRatioRaw', -1).slice(0, 100)), '상승 — 등락률 큰 것부터');
    const dn = await stocks.top({ market: 'US', sort: 'down' });
    ok(same(dn.rows.map((x) => x.ticker), by('fluctuationsRatioRaw', 1).slice(0, 100)), '하락 — 등락률 작은 것부터');

    // 권리(CELG RT)는 시가총액이 «-» 로 온다. 값을 못 읽는 줄은 합친 자리를 정할 수 없어 빼면 순위가 틀린다 — 한 줄이어도 실패다
    const nyse = Array.from({ length: 19 }, (_, i) => ({ ...F.us.brk, symbolCode: `N${i}` }));
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer([F.us.right, ...nyse]), AMEX: answer([F.us.amex]) });
    const noCap = await thrown(stocks.top({ market: 'US', sort: 'marketValue' }));
    ok(!!noCap && /읽지 못/.test(noCap.message), '미국은 순위 값을 못 읽는 줄이 하나만 있어도 실패다 — 빼면 합친 순위가 틀린다', noCap && noCap.message);
    const rights = await stocks.top({ market: 'US', sort: 'up' });
    ok(rights.rows[0].ticker === 'CELG-RI' && rights.rows[0].metric == null, '…상승 순위는 등락률로 줄 세우니 그대로 있다', rights.rows[0]);
    // 네이버는 권리 증서를 stock 으로, 본주 이름으로 준다 — 표시가 없으면 대형주가 110% 오른 것으로 읽힌다
    ok(rights.rows[0].kind === 'right' && rights.rows.find((x) => x.ticker === 'AAPL').kind === 'stock', '권리 증서는 kind:right — 기호 꼬리 RT', rights.rows[0].kind);
    route = usRoute({
      NASDAQ: answer([
        usRow('GENVR', { stockName: '젠 디지털', stockNameEng: 'Gen Digital Contingent Value Rights' }),
        usRow('RDACR', { stockNameEng: 'Rising Dragon Acquisition Rights' }),
        usRow('ZZZ RT', { stockNameEng: 'Zzz Holdings' }),
        usRow('RMV', { stockNameEng: 'Rightmove plc' }),
        usRow('CPY', { stockNameEng: 'Copyright Holdings Inc' })
      ]),
      NYSE: answer([F.us.brk]),
      AMEX: answer([{ ...F.us.amex, stockEndType: 'etf', stockNameEng: 'Some Rights ETF' }])
    });
    const kinds = Object.fromEntries((await stocks.top({ market: 'US', sort: 'up' })).rows.map((x) => [x.ticker, x.kind]));
    ok(kinds.GENVR === 'right' && kinds.RDACR === 'right', '…기호가 평범해도 영문 이름으로 (GENVR 실측)', kinds);
    ok(kinds['ZZZ-RI'] === 'right', '…영문 이름에 없어도 기호 꼬리로', kinds['ZZZ-RI']);
    ok(kinds.RMV === 'stock' && kinds.CPY === 'stock' && kinds['BRK-B'] === 'stock', '…Rightmove·Copyright 은 아니다', kinds);
    ok(kinds.ET === 'etf', '…ETF 표시가 먼저다', kinds.ET);
    // 한 거래소의 값이 통째로 사라지면 그 거래소가 조용히 빠진 목록이 된다
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer([{ ...F.us.brk, marketValueRaw: '' }]), AMEX: answer([F.us.amex]) });
    const gone = await thrown(stocks.top({ market: 'US', sort: 'marketValue' }));
    ok(!!gone && /읽지 못/.test(gone.message), '거래소 하나의 값이 통째로 없으면 실패다 — 빠진 목록을 내지 않는다', gone && gone.message);

    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer([F.us.brk]), AMEX: answer([F.us.amex]) });
    asked.length = 0;
    await stocks.top({ market: 'US', sort: 'searchTop' });
    ok(asked.length === 3 && asked.every((u) => u.includes('/marketValue?')), '미국의 인기는 시가총액을 부른다 — searchTop 은 400 이다', asked);
  }

  console.log('\n[4] 야후 기호');
  {
    const table = [['AAPL', 'AAPL'], ['BRK B', 'BRK-B'], ['BRK A', 'BRK-A'], ['MOG A', 'MOG-A'], ['WHR PRA', 'WHR-PA'], ['AHT PRI', 'AHT-PI'], ['PCG PRC', 'PCG-PC'],
      ['CELG RT', 'CELG-RI'], ['NMZ RT', 'NMZ-RI'], ['GRAF.U', 'GRAF-UN'], ['TONT U', 'TONT-UN'], [' brk b ', 'BRK-B'], ['', ''], [null, '']];
    for (const [from, to] of table) ok(stocks.yahooTicker(from) === to, `${JSON.stringify(from)} → ${JSON.stringify(to)}`, stocks.yahooTicker(from));
  }

  console.log('\n[5] 모양이 바뀐 답');
  {
    const SHAPES = [
      ['stocks 가 없다', { body: {} }],
      ['stocks 가 배열이 아니다', { body: { stocks: 'x' } }],
      ['답이 null', { body: 'null' }],
      ['JSON 이 아니다', { body: '<html>점검 중</html>' }],
      ['빈 목록 — 순위 100 이 빈 적은 없다', { body: { stocks: [] } }],
      ['가격을 읽을 수 없다', answer([{ ...F.kr.samsung, closePrice: 'N/A', closePriceRaw: 'N/A' }])],
      ['등락률을 읽을 수 없다', answer([{ ...F.kr.samsung, fluctuationsRatio: '-' }])],
      ['줄이 객체가 아니다', answer([1, null, 'x'])],
      ['값이 비었다 — Number(\'\') 는 0 이다', answer([{ ...F.kr.samsung, closePrice: '', closePriceRaw: '' }])]
    ];
    for (const [name, a] of SHAPES) {
      route = () => a;
      const e = await thrown(stocks.top({ market: 'KR', sort: 'up' }));
      ok(!!e && /순위 자료를 읽지 못했습니다/.test(e.message), `${name} — 글이 있는 실패`, e && e.message);
    }
    route = () => ({ status: 500, body: '' });
    const e500 = await thrown(stocks.top({ market: 'KR', sort: 'up' }));
    ok(!!e500 && e500.message === 'HTTP 500', 'HTTP 실패', e500 && e500.message);

    // 값이 «-» 인 줄 하나로 그 순위 전체가 죽으면 안 된다 — 줄만 뺀다. 많이 깨졌으면 모양이 바뀐 것이다
    const ten = Array.from({ length: 19 }, (_, i) => ({ ...F.kr.samsung, itemCode: String(i).padStart(6, '0') }));
    route = krRoute([...ten.slice(0, 3), { ...F.kr.samsung, itemCode: '999999', closePrice: '-', closePriceRaw: '' }, ...ten.slice(3)]);
    const few = await stocks.top({ market: 'KR', sort: 'up' });
    ok(few.rows.length === 19 && !few.rows.some((x) => x.ticker === '999999'), '읽을 수 없는 한 줄은 그 줄만 뺀다', few.rows.length);
    ok(same(few.rows.map((x) => x.rank), [1, 2, 3, ...Array.from({ length: 16 }, (_, i) => i + 5)]), '…번호는 네이버 자리 그대로 — 당겨 매기면 2등이 1등으로 보인다', few.rows.map((x) => x.rank));
    ok(few.rows.every((x) => Number.isFinite(x.price) && Number.isFinite(x.pct)), '…NaN 줄은 없다');
    route = krRoute([null, ...ten]);
    ok((await stocks.top({ market: 'KR', sort: 'up' })).rows[0].rank === 2, '맨 윗줄이 깨져도 다음 줄이 1등으로 안 보인다');
    route = krRoute([...ten.slice(0, 5), ...ten.slice(5, 10).map((x) => ({ ...x, closePrice: '-', closePriceRaw: '' }))]);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'up' }))), '반이 깨졌으면 줄을 내지 않고 실패');

    // 조작해 본 값들 (실제 답 17개에는 하나도 없었다)
    const ODD = [
      ['값이 음수', { closePriceRaw: '-5', closePrice: '-5' }],
      ['값이 0', { closePriceRaw: '0', closePrice: '0' }],
      ['등락률이 지수 표기', { fluctuationsRatio: '1e30' }]
    ];
    for (const [name, over] of ODD) {
      route = krRoute([...ten, { ...F.kr.samsung, itemCode: '999999', ...over }]);
      const r = await stocks.top({ market: 'KR', sort: 'up' });
      ok(r.rows.length === 19 && !r.rows.some((x) => x.ticker === '999999'), `${name} — 못 읽는 값으로 친다`, r.rows.length);
    }
    route = krRoute([{ ...F.kr.samsung, marketValueRaw: '1e308' }]);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'marketValue' }))), '금액이 지수 표기 — 300자리 금액을 내지 않는다');
    route = krRoute([{ ...F.kr.samsung, marketValueRaw: '9'.repeat(300) }]);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'marketValue' }))), '금액이 300자리 글자여도');
    route = krRoute([{ ...F.kr.samsung, stockName: { a: 1 } }]);
    ok((await stocks.top({ market: 'KR', sort: 'up' })).rows[0].name === '005930', '이름이 글자가 아니면 [object Object] 대신 종목번호');
    route = krRoute([{ ...F.kr.samsung, stockName: '  ' }]);
    ok((await stocks.top({ market: 'KR', sort: 'up' })).rows[0].name === '005930', '이름이 비어 있어도');
    route = krRoute([{ ...F.kr.samsung, itemCode: { a: 1 } }]);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'up' }))), '종목번호가 글자가 아니면 읽을 수 없는 줄');
    const noAmount = (key) => { const { [key]: _gone, ...rest } = F.kr.samsung; return rest; };
    route = krRoute([noAmount('marketValueRaw')]);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'marketValue' }))), '시가총액 순위에서 금액 필드가 사라지면 금액 없는 줄을 내지 않고 실패');
    route = krRoute([noAmount('accumulatedTradingValueRaw')]);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'priceTop' }))), '거래대금 순위도');
    ok((await stocks.top({ market: 'KR', sort: 'up' })).rows.length === 1, '…상승 순위는 그 금액을 안 쓰니 상관없다');

    // 잘린 답 — 줄은 멀쩡해도 빠진 목록이다
    const short = (rows, totalCount) => ({ body: { stocks: rows, totalCount, marketStatus: 'CLOSE' } });
    route = () => short([F.kr.samsung], 2800);
    ok(!!(await thrown(stocks.top({ market: 'KR', sort: 'up' }))), '국내 — 2800개 중 1줄만 오면 실패');
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: short([F.us.brk, F.us.whrPref, usRow('N1'), usRow('N2')], 2770), AMEX: answer([F.us.amex]) });
    ok(!!(await thrown(stocks.top({ market: 'US', sort: 'marketValue' }))), '미국 — 한 거래소가 잘리면 합친 목록을 내지 않는다');
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer([F.us.brk]), AMEX: short([F.us.amex], '4419') });
    ok(!!(await thrown(stocks.top({ market: 'US', sort: 'marketValue' }))), '…totalCount 가 글자로 와도');
    const hundred = Array.from({ length: 100 }, (_, i) => usRow(`H${i}`));
    route = usRoute({ NASDAQ: short(hundred, 3985), NYSE: short([F.us.brk], 1), AMEX: { body: { stocks: [F.us.amex] } } });
    ok((await stocks.top({ market: 'US', sort: 'marketValue' })).rows.length === 100, '100줄이면 통과 · 전체가 그만큼이면 통과 · totalCount 가 없으면 따지지 않는다');
    const tens = Array.from({ length: 100 }, (_, i) => (i < 10 ? usRow(`B${i}`, { marketValueRaw: '-' }) : usRow(`B${i}`)));
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer(tens), AMEX: answer([F.us.amex]) });
    ok(!!(await thrown(stocks.top({ market: 'US', sort: 'marketValue' }))), '미국 — 열 줄을 조용히 빼고 100줄을 내지 않는다');

    // 본문 도중 끊김 — 응답에 'end' 가 안 오고 요청 쪽 오류도 안 온다
    for (const cut of ['close', 'error']) {
      route = () => ({ body: '{"stocks":[', cut });
      const e = await settled(stocks.top({ market: 'KR', sort: 'up' }));
      ok(e instanceof Error && e.message === '연결이 끊겼습니다', `응답 ${cut} — 약속이 끝나고 글이 한국어다`, e instanceof Error ? e.message : e);
    }
    route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: { body: '{"sto', cut: 'close' }, AMEX: answer([F.us.amex]) });
    const cutUs = await settled(stocks.top({ market: 'US', sort: 'marketValue' }));
    ok(cutUs instanceof Error && cutUs.message === '연결이 끊겼습니다', '미국 — 거래소 하나만 끊겨도 그 회차는 실패', cutUs instanceof Error ? cutUs.message : cutUs);

    console.log('  — 진짜 소켓으로 끊는다 (로컬 서버, 밖으로는 안 나간다)');
    // 가짜 응답은 소켓의 사정을 흉내 내지 못한다 — 이 구멍을 못 잡았던 까닭. Electron 안의 Node 에서도 이 시험이 돈다
    const http = require('http');
    let how = {};
    const srv = http.createServer((req, res) => {
      res.writeHead(200, how.chunked ? {} : { 'Content-Length': '100000' });
      res.write('{"stocks":[');
      setTimeout(() => (how.fin ? req.socket.end() : req.socket.destroy()), 10);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const fakeGet = https.get;
    https.get = (_url, opts, cb) => http.get(`http://127.0.0.1:${srv.address().port}/`, { ...opts, agent: false }, cb);
    for (const mode of [{ fin: false }, { fin: true }, { fin: true, chunked: true }]) {
      how = mode;
      const e = await settled(stocks.top({ market: 'KR', sort: 'up' }), 4000);
      ok(e instanceof Error && e.message === '연결이 끊겼습니다', `순위 ${JSON.stringify(mode)}`, e instanceof Error ? e.message : e);
      const q = await settled(stocks._fetchQuote('AAPL'), 4000);
      ok(q instanceof Error && q.message === '연결이 끊겼습니다', `…관심 시세도 같은 길 ${JSON.stringify(mode)}`, q instanceof Error ? q.message : q);
    }
    how = { fin: true };
    const eur = await settled(fx.rate('EUR'), 4000);
    ok(eur === null, '환율 — 끊겨도 끝난다', eur);
    https.get = fakeGet;
    srv.close();
    route = () => ({ body: { chart: { result: [{ meta: { regularMarketPrice: 1500 } }] } } });
    ok(await settled(fx.rate('EUR'), 4000) === 1500, '…끝났으니 다음 부름이 새로 받는다 (진행 중 표시가 안 남는다)');

    const FAILS = [
      ['HTTP 500', { status: 500, body: '' }, 'HTTP 500'],
      ['모양이 바뀜', { body: {} }, /읽지 못/],
      ['연결 실패', { error: '시간 초과' }, '시간 초과']
    ];
    for (const ex of ['NASDAQ', 'NYSE', 'AMEX']) {
      for (const [name, a, want] of FAILS) {
        route = usRoute({ NASDAQ: answer([F.us.apple]), NYSE: answer([F.us.brk]), AMEX: answer([F.us.amex]), [ex]: a });
        const e = await thrown(stocks.top({ market: 'US', sort: 'marketValue' }));
        ok(!!e && (want instanceof RegExp ? want.test(e.message) : e.message === want), `${ex} ${name} — 그 회차는 실패다 (빠진 목록을 미국 TOP 100 이라고 내놓지 않는다)`, e && e.message);
      }
    }
  }

  console.log('\n[6] store 기본값');
  const store = require(path.join(ROOT, 'src', 'store.js'));
  {
    const s = store.settings;
    ok(s.stocksView === 'watch' && s.stocksTopMarket === 'KR' && s.stocksTopSort === 'marketValue', '기본은 관심 · 국내 · 시가총액', { v: s.stocksView, m: s.stocksTopMarket, o: s.stocksTopSort });
    store.setSettings({ stocksTopSort: 'up' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'nunsseom.json'), 'utf8'));
    ok(onDisk.settings.stocksTopSort === 'up', '파일에 남는다', onDisk.settings.stocksTopSort);
    store.setSettings({ stocksTopSort: 'marketValue', stocksEnabled: true });
  }

  console.log('\n[7] 창');
  // 15초 틱을 시험이 직접 돌린다 — 진짜로 기다리면 몇 분이 걸린다
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  let tickFn = null;
  const cleared = [];
  global.setInterval = (fn, ms, ...a) => {
    if (ms === 15_000) { tickFn = fn; return { fake: true }; }
    return realSetInterval(fn, ms, ...a);
  };
  global.clearInterval = (h) => {
    if (h && h.fake) { cleared.push(h); return; }
    realClearInterval(h);
  };
  // 캐시가 묵는 것을 시계로 민다
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;

  const topCalls = [];
  const buildCalls = [];
  let buildAuto = true;
  const watchRows = [{ ticker: 'WATCH', name: '관심 줄', market: 'KR', price: 1, pct: 0, currency: 'KRW', index: false }];
  const rowsOf = (key) => [{ rank: 1, ticker: key, name: key, market: key.split(':')[0], kind: 'stock', price: 100, pct: 1, currency: key.startsWith('US') ? 'USD' : 'KRW', metric: null, exchange: null }];
  stocks.top = (pick) => {
    const g = gate();
    const key = `${pick.market}:${pick.sort}`;
    topCalls.push({ key, g });
    return g.promise;
  };
  stocks.build = (args) => {
    const g = gate();
    buildCalls.push({ args, g });
    if (buildAuto) g.open({ rows: watchRows, at: Date.now(), lagSec: 1200, failed: 0, empty: false });
    return g.promise;
  };
  /** 그 열쇠의 가장 오래된 안 끝난 부름에 답한다 */
  const answerTop = async (key, status = 'OPEN') => {
    const c = topCalls.find((x) => x.key === key && !x.done);
    c.done = true;
    c.g.open({ rows: rowsOf(key), status });
    await tick();
  };
  const failTop = async (key, msg = 'HTTP 500') => {
    const c = topCalls.find((x) => x.key === key && !x.done);
    c.done = true;
    c.g.fail(new Error(msg));
    await tick();
  };
  const closeAllTop = async () => {
    for (const c of topCalls) if (!c.done) { c.done = true; c.g.open({ rows: rowsOf(c.key), status: 'OPEN' }); }
    await tick();
  };

  const stockwin = require(path.join(ROOT, 'src', 'stockwin.js'));
  const invoke = (ch, arg) => handlers.get(ch)({}, arg);
  const setApp = async (p) => { invoke('stocks:set-app', p); await tick(); };

  stockwin.openStocks();
  const win = FakeWin.last;
  const box = () => win.sent[win.sent.length - 1];
  win.on_['wc:did-finish-load']();
  await tick();

  console.log('  — 관심은 그대로');
  {
    ok(buildCalls.length === 1 && topCalls.length === 0, '처음은 관심 — 야후 쪽(build)만 부른다', { build: buildCalls.length, top: topCalls.length });
    const b = box();
    ok(b.view === 'watch' && same(b.rows.map((x) => x.ticker), ['WATCH']) && b.lagSec === 1200 && b.loading === false && b.error === null, '관심 줄이 예전 모양 그대로 간다', b);
    ok(b.market === 'all' && b.indexes === true && b.krw === false && Array.isArray(b.watch), '…시장·지수·원화·관심 목록도', b);
    ok(b.topMarket === 'KR' && b.topSort === 'marketValue', '…고른 순위도 같이 — 화면이 단추를 칠한다', { m: b.topMarket, s: b.topSort });

    buildAuto = false;
    invoke('stocks:refresh');
    await tick();
    const n = buildCalls.length;
    ok(box().loading === true, '받는 중 표시', box().loading);
    invoke('stocks:refresh');
    invoke('stocks:set-app', { stocksIndexes: true });
    await tick();
    ok(buildCalls.length === n, '관심 쪽 받는 중에는 지금처럼 겹쳐 부르지 않는다', buildCalls.length - n);
    buildCalls[buildCalls.length - 1].g.open({ rows: watchRows, at: Date.now(), lagSec: 1200, failed: 0, empty: false });
    await tick();
    ok(buildCalls.length === n, '…묻는 값이 그대로면 끝난 뒤에 다시 받지 않는다', buildCalls.length - n);
    buildAuto = true;
  }

  console.log('  — 관심 쪽을 받는 중에 TOP 100 으로');
  {
    buildAuto = false;
    invoke('stocks:refresh');
    await tick();
    const going = buildCalls[buildCalls.length - 1];
    await setApp({ stocksView: 'top' });
    ok(topCalls.length === 1 && topCalls[0].key === 'KR:marketValue', '받는 중이어도 순위를 바로 부른다', topCalls.map((x) => x.key));
    const b0 = box();
    ok(b0.view === 'top' && b0.rows.length === 0 && b0.loading === true, '관심 줄을 순위 칸에 내보내지 않는다 — 비어 있고 받는 중', b0);
    going.g.open({ rows: watchRows, at: Date.now(), lagSec: 1200, failed: 0, empty: false });
    await tick();
    ok(box().view === 'top' && box().rows.length === 0, '늦게 온 관심 답이 순위 칸을 덮지 않는다', box().rows);
    await answerTop('KR:marketValue');
    ok(same(box().rows.map((x) => x.ticker), ['KR:marketValue']) && box().loading === false && box().status === 'OPEN', '순위 답이 온다', box());
    buildAuto = true;
    const nb = buildCalls.length;
    await setApp({ stocksView: 'watch' });
    ok(buildCalls.length === nb + 1 && same(box().rows.map((x) => x.ticker), ['WATCH']), '관심으로 돌아오면 관심 줄 — 순위 답이 덮지 않았다', box().rows.map((x) => x.ticker));
    const nt = topCalls.length;
    await setApp({ stocksView: 'top' });
    ok(topCalls.length === nt && same(box().rows.map((x) => x.ticker), ['KR:marketValue']), 'TOP 100 으로 돌아오면 묵지 않은 줄을 바로, 다시 안 받는다', { calls: topCalls.length - nt });
  }

  console.log('  — 받는 중에 고르기가 바뀌면');
  {
    await setApp({ stocksTopSort: 'up' });
    ok(topCalls[topCalls.length - 1].key === 'KR:up', '상승을 부른다', topCalls[topCalls.length - 1].key);
    ok(box().topSort === 'up' && box().rows.length === 0 && box().loading === true, '다른 고르기의 줄을 보여 주지 않는다', box());
    await setApp({ stocksTopSort: 'down' });
    ok(topCalls[topCalls.length - 1].key === 'KR:down', '상승을 받는 중이어도 하락을 바로 부른다', topCalls.map((x) => x.key));
    await answerTop('KR:down');
    ok(same(box().rows.map((x) => x.ticker), ['KR:down']), '하락 답', box().rows.map((x) => x.ticker));
    await answerTop('KR:up');
    ok(box().topSort === 'down' && same(box().rows.map((x) => x.ticker), ['KR:down']), '늦게 온 상승 답이 하락을 덮지 않는다', box().rows.map((x) => x.ticker));
    const n = topCalls.length;
    await setApp({ stocksTopSort: 'up' });
    ok(topCalls.length === n && same(box().rows.map((x) => x.ticker), ['KR:up']), '늦은 답도 제 칸에는 남는다 — 돌아가면 바로 보인다', box().rows.map((x) => x.ticker));

    await setApp({ stocksTopMarket: 'US', stocksTopSort: 'priceTop' });
    await setApp({ stocksTopMarket: 'KR', stocksTopSort: 'priceTop' });
    ok(same(topCalls.slice(-2).map((x) => x.key), ['US:priceTop', 'KR:priceTop']), '시장을 바꿔도 같다', topCalls.slice(-2).map((x) => x.key));
    await answerTop('KR:priceTop');
    await answerTop('US:priceTop');
    ok(box().topMarket === 'KR' && same(box().rows.map((x) => x.ticker), ['KR:priceTop']), '늦은 미국 답이 국내를 덮지 않는다', box().rows.map((x) => x.ticker));

    const m = topCalls.length;
    invoke('stocks:set-app', { stocksTopSort: 'searchTop' });
    invoke('stocks:set-app', { stocksTopSort: 'searchTop' });
    await tick();
    ok(topCalls.length === m + 1, '같은 고르기를 겹쳐 부르지 않는다', topCalls.length - m);
    await answerTop('KR:searchTop');
    await setApp({ stocksTopMarket: 'US' });
    ok(box().topMarket === 'US' && box().topSort === 'marketValue' && topCalls[topCalls.length - 1].key === 'US:marketValue', '저장된 인기 + 미국 — 시가총액을 보이고 그것을 부른다', { s: box().topSort, c: topCalls[topCalls.length - 1].key });
    await answerTop('US:marketValue', 'CLOSE');
    ok(box().status === 'CLOSE', '장 상태는 그 고르기의 것', box().status);
    const k = topCalls.length;
    await setApp({ stocksTopMarket: 'KR' });
    ok(box().topSort === 'searchTop' && topCalls.length === k, '국내로 돌아오면 인기 그대로 — 저장값을 덮어쓰지 않았다', box().topSort);
    await setApp({ stocksTopSort: 'marketValue' });
    await closeAllTop();
  }

  console.log('  — 캐시와 주기');
  {
    skew += 61_000;
    tickFn();
    await tick();
    await closeAllTop();
    const n = topCalls.length;
    skew += 30_000;
    tickFn();
    await tick();
    ok(topCalls.length === n, '60초 안의 틱은 다시 안 받는다', topCalls.length - n);
    await setApp({ stocksKrw: false });
    ok(topCalls.length === n, '다른 설정을 바꿔도 묵지 않았으면 안 받는다', topCalls.length - n);
    skew += 31_000;
    tickFn();
    await tick();
    ok(topCalls.length === n + 1 && topCalls[n].key === 'KR:marketValue', '60초가 지나면 틱이 다시 받는다', topCalls.slice(n).map((x) => x.key));
    ok(box().loading === true && box().rows.length === 1, '받는 동안 묵은 줄을 그대로 둔다', box());
    tickFn();
    await tick();
    ok(topCalls.length === n + 1, '받는 중에는 틱이 겹쳐 부르지 않는다', topCalls.length - n);
    await closeAllTop();
    const m = topCalls.length;
    invoke('stocks:refresh');
    await tick();
    ok(topCalls.length === m + 1, '새로 받기 단추는 묵지 않았어도 받는다', topCalls.length - m);
    invoke('stocks:refresh');
    await tick();
    ok(topCalls.length === m + 1, '…받는 중이면 겹치지 않는다', topCalls.length - m);
    await closeAllTop();
    const q = buildCalls.length;
    skew += 61_000;
    tickFn();
    await tick();
    await closeAllTop();
    ok(buildCalls.length === q, 'TOP 100 보기의 틱은 야후 쪽(build)을 안 부른다', buildCalls.length - q);
  }

  console.log('  — 실패');
  {
    skew += 61_000;
    tickFn();
    await tick();
    await failTop('KR:marketValue');
    const b = box();
    ok(b.error === 'HTTP 500' && b.rows.length === 1 && b.loading === false, '실패해도 그 고르기의 마지막 줄을 그대로, 오류를 같이', b);
    const n = topCalls.length;
    skew += 15_000;
    tickFn();
    await tick();
    ok(topCalls.length === n, '실패한 뒤에도 15초 틱마다 두드리지 않는다', topCalls.length - n);
    skew += 46_000;
    tickFn();
    await tick();
    ok(topCalls.length === n + 1, '주기가 되면 다시', topCalls.length - n);
    await answerTop('KR:marketValue');
    ok(box().error === null && box().rows.length === 1, '성공하면 오류가 사라진다', box().error);

    await setApp({ stocksTopSort: 'down' });     // 묵었으니 다시 부른다
    await failTop('KR:down', '시간 초과');
    ok(box().error === '시간 초과' && box().rows.length === 1, '묵은 줄도 실패를 알린다', box().error);
    await setApp({ stocksTopMarket: 'US', stocksTopSort: 'down' });
    await failTop('US:down');
    ok(box().rows.length === 0 && box().error === 'HTTP 500' && box().loading === false, '줄이 하나도 없는 고르기의 실패 — 빈 줄과 오류', box());
    const k = topCalls.length;
    await setApp({ stocksTopMarket: 'KR' });
    await closeAllTop();
    await setApp({ stocksTopMarket: 'US' });
    ok(topCalls.length === k + 2 && topCalls[k + 1].key === 'US:down', '실패한 고르기로 돌아오면 바로 다시 해 본다', topCalls.slice(k).map((x) => x.key));
    await answerTop('US:down');
    ok(box().error === null && box().rows.length === 1, '…이번에는 된다', box());

    // 위는 줄이 없는 칸이다. 줄이 있고 60초 안인 칸도 실패 직후에는 믿지 않는다
    invoke('stocks:refresh');
    await tick();
    await failTop('US:down');
    ok(box().error === 'HTTP 500' && box().rows.length === 1, '묵지 않은 칸의 새로 받기 실패', box().error);
    const h = topCalls.length;
    await setApp({ stocksTopMarket: 'KR' });
    await closeAllTop();
    await setApp({ stocksTopMarket: 'US' });
    ok(topCalls[topCalls.length - 1].key === 'US:down' && topCalls.length > h, '…60초 안이어도 돌아오면 다시 해 본다', topCalls.slice(h).map((x) => x.key));
    await answerTop('US:down');

    // 오프라인의 흔한 모습. 화면 글은 한국어다 — 원문은 기록에만
    const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
    const realLog = evlog.log;
    const logged = [];
    evlog.log = (_k, m) => logged.push(m);
    invoke('stocks:refresh');
    await tick();
    await failTop('US:down', 'getaddrinfo ENOTFOUND api.stock.naver.com');
    ok(box().error === '네트워크에 연결하지 못했습니다', 'node 오류 원문을 화면으로 보내지 않는다', box().error);
    ok(logged.some((m) => m.includes('ENOTFOUND')), '…원문은 기록에 남는다', logged);
    for (const kept of ['HTTP 503', '시간 초과', '연결이 끊겼습니다', '순위 자료를 읽지 못했습니다']) {
      invoke('stocks:refresh');
      await tick();
      await failTop('US:down', kept);
      ok(box().error === kept, `«${kept}» 는 그대로`, box().error);
    }
    evlog.log = realLog;
    invoke('stocks:refresh');
    await tick();
    await answerTop('US:down');
  }

  console.log('  — 원화: 같은 줄을 두 번 곱하지 않는다');
  {
    route = (url) => {
      if (url.includes('USDKRW')) return { body: { chart: { result: [{ meta: { regularMarketPrice: 1400 } }] } } };
      throw new Error(`시험: 부를 줄 몰랐던 주소 ${url}`);
    };
    const realAttach = fx.attach;
    const attachArgs = [];
    fx.attach = (rows) => { attachArgs.push(rows); return realAttach(rows); };
    const usRows = [{ rank: 1, ticker: 'AAPL', name: '애플', market: 'US', kind: 'stock', price: 100, pct: 1, currency: 'USD', metric: null, exchange: 'NASDAQ' }];

    await setApp({ stocksTopMarket: 'US', stocksTopSort: 'marketValue' });
    skew += 61_000;
    invoke('stocks:refresh');
    await tick();
    const c = topCalls.find((x) => !x.done);
    c.done = true;
    c.g.open({ rows: usRows, status: 'CLOSE' });
    await tick();
    ok(box().rows[0].krwPrice === undefined, '원화가 꺼져 있으면 환산 안 한다', box().rows[0]);
    const n = topCalls.length;
    await setApp({ stocksKrw: true });
    await tick(8);
    ok(box().rows[0].krwPrice === 140000 && topCalls.length === n, '켜면 묵지 않은 줄에 바로 붙는다 — 다시 안 받는다', box().rows[0]);
    ok(attachArgs.length === 1 && attachArgs[0][0] !== usRows[0], 'fx.attach 는 새 사본을 받는다', attachArgs.length);
    ok(usRows[0].krwPrice === undefined, '든 줄은 그대로', usRows[0]);
    await setApp({ stocksKrw: false });
    ok(box().rows[0].krwPrice === undefined, '끄면 원래 값', box().rows[0]);
    await setApp({ stocksKrw: true });
    await tick(8);
    ok(box().rows[0].krwPrice === 140000, '다시 켜도 한 번만 곱한다', box().rows[0].krwPrice);

    skew += 61_000;
    invoke('stocks:refresh');
    await tick();
    const c2 = topCalls.find((x) => !x.done);
    c2.done = true;
    c2.g.open({ rows: usRows, status: 'CLOSE' });
    await tick(8);
    ok(box().rows[0].krwPrice === 140000, '새로 받은 줄도 원화가 켜진 채로 온다', box().rows[0]);

    // 받는 중에 켰을 때 — 답이 온 뒤에 붙는다
    await setApp({ stocksKrw: false });
    invoke('stocks:refresh');
    await tick();
    invoke('stocks:set-app', { stocksKrw: true });
    await tick();
    const c3 = topCalls.find((x) => !x.done);
    c3.done = true;
    c3.g.open({ rows: usRows, status: 'CLOSE' });
    await tick(8);
    ok(box().rows[0].krwPrice === 140000, '받는 중에 켜도 답에 붙는다', box().rows[0]);

    fx.attach = realAttach;
    await setApp({ stocksKrw: false, stocksTopMarket: 'KR', stocksTopSort: 'marketValue' });
    await closeAllTop();
  }

  console.log('  — 별');
  {
    skew += 61_000;
    await setApp({ stocksTopSort: 'marketValue' });
    await closeAllTop();
    const nt = topCalls.length;
    const nb = buildCalls.length;
    const lookups = [];
    stocks.lookup = async (input) => { lookups.push(input); return { ticker: input.ticker, market: input.market, name: input.name, symbol: `${input.ticker}.KS` }; };
    const r = await invoke('stocks:add', { ticker: '005930', name: '삼성전자', market: 'KR' });
    await tick();
    ok(r.ok && r.added && r.name === '삼성전자', '넣는다', r);
    ok(same(lookups[0], { ticker: '005930', name: '삼성전자', market: 'KR' }), 'lookup 에 객체로 간다 — 고른 것으로 친다', lookups[0]);
    ok(box().watch.some((w) => w.ticker === '005930'), '바로 관심 목록이 간다 — 별이 칠해진다', box().watch);
    ok(topCalls.length === nt && buildCalls.length === nb, '묵지 않았으면 다시 안 받고, 야후 쪽도 안 부른다', { top: topCalls.length - nt, build: buildCalls.length - nb });
    await invoke('stocks:remove', '005930');
    await tick();
    ok(!box().watch.some((w) => w.ticker === '005930') && topCalls.length === nt && buildCalls.length === nb, '뺀다 — 역시 네트워크 없이', box().watch);
    stocks.lookup = async () => null;
    const miss = await invoke('stocks:add', { ticker: 'XX-UN', name: '없는 것', market: 'US' });
    ok(!miss.ok && miss.message === '그런 종목을 못 찾았습니다', '야후가 모르는 기호는 지금 있는 말로', miss);

    // 칸이 묵었거나 실패 중일 때 — 별은 줄을 다시 받을 까닭이 없고, 네트워크를 기다리면 «찾는 중…» 이 남는다
    stocks.lookup = async (input) => ({ ticker: input.ticker, market: input.market, name: input.name, symbol: `${input.ticker}.KS` });
    skew += 61_000;
    tickFn();
    await tick();
    await failTop('KR:marketValue');
    const nf = topCalls.length;
    const staleAdd = await settled(invoke('stocks:add', { ticker: '005930', name: '삼성전자', market: 'KR' }));
    ok(staleAdd && staleAdd.ok === true, '실패 중에도 넣기가 바로 끝난다', staleAdd);
    ok(box().watch.some((w) => w.ticker === '005930') && topCalls.length === nf, '…별이 칠해지고 네이버를 안 부른다', topCalls.length - nf);
    ok(await settled(invoke('stocks:remove', '005930')) === true && !box().watch.some((w) => w.ticker === '005930') && topCalls.length === nf, '…빼기도', topCalls.length - nf);
    invoke('stocks:refresh');
    await tick();
    const staleAdd2 = await settled(invoke('stocks:add', { ticker: '005930', name: '삼성전자', market: 'KR' }));
    ok(staleAdd2 && staleAdd2.ok === true && box().loading === true, '받는 중에도 답을 안 기다린다', staleAdd2);
    await invoke('stocks:remove', '005930');
    await closeAllTop();
    stocks.lookup = realLookup;

    // 관심 보기는 지금과 똑같이 — 받는 동안 바뀐 몫은 다음 주기에 받는다 (끝나자마자 또 받지 않는다)
    await setApp({ stocksView: 'watch' });
    buildAuto = false;
    invoke('stocks:refresh');
    await tick();
    const going = buildCalls[buildCalls.length - 1];
    const before = buildCalls.length;
    store.addStock({ ticker: 'NEW1', name: '새 종목', market: 'KR' });
    invoke('stocks:set-app', { stocksMarket: 'KR' });
    await tick();
    going.g.open({ rows: watchRows, at: Date.now(), lagSec: 1200, failed: 0, empty: false });
    buildAuto = true;
    await tick();
    ok(buildCalls.length === before, '관심 쪽을 받는 동안 목록·시장이 바뀌어도 끝난 뒤 더 받지 않는다', buildCalls.length - before);
    store.removeStock('NEW1');
    await setApp({ stocksMarket: 'all' });
    await tick();

    // 손으로 고쳤거나 깨진 파일의 null 한 줄 — 받기가 묶이지 않고 지금처럼 오류를 보여 준다
    const fakeBuild = stocks.build;
    stocks.build = realBuild;
    store.stocksWatch.unshift(null);
    const nulled = await settled(invoke('stocks:refresh'));
    ok(nulled === true && box().loading === false && /null/.test(box().error || ''), '관심 목록의 null — loading 이 풀리고 오류가 보인다', { nulled: String(nulled), loading: box().loading, error: box().error });
    store.stocksWatch.shift();
    stocks.build = fakeBuild;
    await invoke('stocks:refresh');
    await setApp({ stocksView: 'top' });
    await closeAllTop();
  }

  console.log('  — 이상한 저장값');
  {
    const n = topCalls.length;
    const nb = buildCalls.length;
    await setApp({ stocksView: 'zzz' });
    ok(box().view === 'watch' && buildCalls.length === nb + 1 && topCalls.length === n, '이상한 보기 — 관심으로', box().view);
    await setApp({ stocksView: 'top', stocksTopMarket: 'JP', stocksTopSort: '../x' });
    ok(box().view === 'top' && box().topMarket === 'KR' && box().topSort === 'marketValue', '이상한 시장·정렬 — 기본값으로', { m: box().topMarket, s: box().topSort });
    await setApp({ stocksTopMarket: 'KR', stocksTopSort: 'marketValue' });
    await closeAllTop();
  }

  console.log('  — 야후 시세를 안 부른다 (진짜 stocks.top · 진짜 fx)');
  {
    stocks.top = realTop;
    stocks.build = (args) => { buildCalls.push({ args, g: gate() }); throw new Error('시험: TOP 100 보기에서 build 를 불렀다'); };
    route = (url) => {
      if (url.includes('USDKRW')) return { body: { chart: { result: [{ meta: { regularMarketPrice: 1400 } }] } } };
      if (url.includes('api.stock.naver.com/stock/exchange/')) return answer([F.us.apple, F.us.brk], 'CLOSE');
      if (url.includes('m.stock.naver.com/api/stocks/')) return answer([F.kr.samsung, F.kr.etf]);
      throw new Error(`시험: 부를 줄 몰랐던 주소 ${url}`);
    };
    const nb = buildCalls.length;
    asked.length = 0;
    skew += 700_000;      // 환율 캐시(10분)도 묵혀서 부르는지 본다
    invoke('stocks:refresh');
    await tick(12);
    await setApp({ stocksTopMarket: 'US', stocksKrw: true });
    await tick(12);
    const rows = box().rows;
    ok(rows.length === 2 && rows[0].ticker === 'AAPL' && rows[0].krwPrice === 349.51 * 1400, '미국 줄 + 원화 환산', rows[0]);
    const yahoo = asked.filter((u) => /finance\.yahoo\.com/.test(u));
    const naver = asked.filter((u) => /stock\.naver\.com/.test(u));
    ok(yahoo.length === 1 && /USDKRW=X/.test(decodeURIComponent(yahoo[0])), '야후에는 환율만', yahoo);
    ok(naver.length === 4 && asked.length === 5, '나머지는 네이버 목록 — 국내 1, 미국 3', asked);
    ok(buildCalls.length === nb, 'build 는 한 번도 안 불렀다', buildCalls.length - nb);

    // 본문 도중 끊김 — 그 고르기가 묶이면 ↻ 도 창 다시 열기도 소용없었다 (topGoing 이 안 빠져서)
    const healthy = route;
    route = () => ({ body: '{"stocks":[', cut: 'close' });
    const cutRefresh = await settled(invoke('stocks:refresh'));
    ok(cutRefresh === true && box().loading === false && box().error === '연결이 끊겼습니다' && box().rows.length === 2, '끊겨도 실패로 끝나고 줄을 지킨다', { r: String(cutRefresh), loading: box().loading, error: box().error });
    route = healthy;
    asked.length = 0;
    const healed = await settled(invoke('stocks:refresh'));
    ok(healed === true && asked.filter((u) => /stock\.naver\.com/.test(u)).length === 3 && box().error === null, '…좋아지면 ↻ 가 새로 받는다', asked.length);
    // 환율 답이 끊겨도 네이버 답을 받은 줄은 들어온다 — 값은 달러로
    skew += 700_000;
    route = (url) => (url.includes('USDKRW') ? { body: '{"chart"', cut: 'close' } : healthy(url));
    const cutFx = await settled(invoke('stocks:refresh'));
    ok(cutFx === true && box().loading === false && box().rows.length === 2 && box().error === null, '환율 끊김 — 순위가 묶이지 않는다', { r: String(cutFx), loading: box().loading });
    route = healthy;

    stocks.build = realBuild;
    await setApp({ stocksKrw: false, stocksTopMarket: 'KR' });
    await tick(12);
  }

  console.log('  — 야후가 모르는 기호');
  {
    route = () => ({ status: 404, body: '{}' });
    ok(await realLookup({ ticker: 'GRAF-UN', name: 'Graf', market: 'US' }) === null, 'lookup — null («그런 종목을 못 찾았습니다» 로 간다)');
    ok(await stocks.history({ ticker: 'GRAF-UN', market: 'US', index: false }, '1mo') === null, 'history — null (빈 차트로 간다)');
    route = () => ({ body: { chart: { result: [{ meta: {} }] } } });
    ok(await realLookup({ ticker: 'GRAF-UN', name: 'Graf', market: 'US' }) === null, '값 없는 답(GRAF-UN 실측)도 null');
    route = (url) => {
      ok(url.includes(encodeURIComponent('BRK-B')), '…야후에는 BRK-B 로 묻는다', url);
      return { body: { chart: { result: [{ meta: { regularMarketPrice: 579.09, currency: 'USD', longName: 'Berkshire' } }] } } };
    };
    const brk = await realLookup({ ticker: 'BRK-B', name: '버크셔 해서웨이 Class B', market: 'US' });
    ok(brk && brk.ticker === 'BRK-B' && brk.name === '버크셔 해서웨이 Class B', '고른 이름 그대로 관심에 들어간다', brk);
  }

  console.log('  — 닫힌 창');
  {
    stocks.top = (pick) => {
      const g = gate();
      topCalls.push({ key: `${pick.market}:${pick.sort}`, g });
      return g.promise;
    };
    skew += 61_000;
    invoke('stocks:refresh');
    await tick();
    const going = topCalls[topCalls.length - 1];
    const sentBefore = win.sent.length;
    const realAttach = fx.attach;
    let attached = 0;
    fx.attach = (rows) => { attached++; return realAttach(rows); };
    store.setSettings({ stocksKrw: true });
    win.close();
    ok(cleared.length === 1, '주기 타이머를 멈춘다', cleared.length);
    going.done = true;
    going.g.open({ rows: rowsOf(going.key), status: 'OPEN' });
    await tick(8);
    ok(win.sent.length === sentBefore, '닫은 뒤 온 답은 보내지 않고 터지지도 않는다', win.sent.length - sentBefore);
    ok(attached === 0, '…환율도 안 부른다', attached);
    fx.attach = realAttach;
    store.setSettings({ stocksKrw: false });

    const n = topCalls.length;
    await invoke('stocks:refresh');
    await invoke('stocks:set-app', { stocksTopSort: 'up' });
    await tick();
    ok(topCalls.length === n, '닫아 두면 받지 않는다', topCalls.length - n);
    store.setSettings({ stocksTopSort: 'marketValue' });

    stockwin.openStocks();
    const win2 = FakeWin.last;
    ok(win2 !== win, '다시 연다');
    win2.on_['wc:did-finish-load']();
    await tick();
    const b2 = win2.sent[win2.sent.length - 1];
    ok(b2.view === 'top' && same(b2.rows.map((x) => x.ticker), [going.key]) && topCalls.length === n, '닫기 전에 받은 줄이 묵지 않았으면 바로 보이고 다시 안 받는다', b2.rows.map((x) => x.ticker));
    win2.close();
  }

  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
  Date.now = realNow;

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
}

main();

// 주식 시세 — 별도 창에서 관심 종목의 지금 값을 보여준다.
//
// 관심 종목은 이 앱이 직접 들고 있다(store의 stocksWatch). 옆 프로젝트(algo-trader)의
// 목록을 읽어 쓰던 때가 있었는데, 그쪽이 파일을 «비우고 다시 쓰는» 방식이라
// 종목을 넣는 순간 목록이 잠깐 비는 문제가 있었고, 무엇보다 서로 매여 있을 이유가 없다.
// 대신 «한 번 가져오기»만 남겨 뒀다 (importFrom).
//
// 시세는 야후에서 받는다. 키가 필요 없고 국내(코스피·코스닥)·해외·지수가 다 되지만
// 20분 지연이다 (실측 1203초). 시세를 받는 곳은 fetchQuote() 하나뿐이니,
// 실시간이 필요해지면 그것만 KIS로 갈아끼우면 된다.

const https = require('https');
const fs = require('fs');
const path = require('path');

const HOST = 'query1.finance.yahoo.com';
const TIMEOUT_MS = 9000;
const MAX_BYTES = 2 * 1024 * 1024;
/** 한 번에 몇 개까지 동시에 물어볼까 — 야후가 묶음 조회(v7)를 막아서 하나씩 받는다 */
const LANES = 5;

/**
 * 같이 보여줄 지수.
 * 국내·미국은 늘 낸다. 일본·홍콩은 그 시장 종목을 하나라도 담았을 때만 낸다 —
 * 국내 종목만 보는 사람에게 항셍까지 여섯 줄을 들이밀 이유가 없다.
 * (^TOPX·^HSTECH는 야후에 없어서 뺐다 — 실측)
 */
const INDEXES = [
  { ticker: '^KS11', name: '코스피', market: 'KR', index: true, always: true },
  { ticker: '^KQ11', name: '코스닥', market: 'KR', index: true, always: true },
  { ticker: '^IXIC', name: '나스닥', market: 'US', index: true, always: true },
  { ticker: '^GSPC', name: 'S&P 500', market: 'US', index: true, always: true },
  { ticker: '^N225', name: '닛케이225', market: 'JP', index: true },
  { ticker: '^HSI', name: '항셍', market: 'HK', index: true }
];

const MARKETS = ['KR', 'US', 'JP', 'HK'];
/** 저장·전달되는 시장 이름을 하나로 맞춘다 */
function toMarket(v) {
  const t = String(v || '').toUpperCase();
  return MARKETS.includes(t) ? t : 'KR';
}

// ── 관심 종목 ───────────────────────────────────────────

/** algo-trader가 쓰는 watchlist.json의 기본 자리 */
function defaultWatchPath(root) {
  return path.join(root || 'C:\\ps\\Project\\trading\\algo-trader', 'stocks', 'watchlist.json');
}

/** 마지막으로 멀쩡히 읽힌 목록 (파일 경로별) */
const lastGood = new Map();

/**
 * 관심 종목을 읽는다. 여기서 터뜨리지 않는다.
 *
 * «파일이 없다»와 «지금 쓰는 중이다»를 구분한다.
 * 그쪽 save()는 파일을 비우고 다시 쓰는 방식이라, 종목을 넣고 빼는 그 순간에는
 * 반쯤 쓰인 JSON이 잠깐 존재한다. 하필 그때 읽고 목록을 비워버리면 화면이
 * «못 읽었습니다»로 깜빡인다 — 사용자는 방금 종목을 추가했을 뿐인데.
 * 그래서 읽다 깨지면 직전에 멀쩡했던 목록을 그대로 쓰고 다음 갱신에서 다시 읽는다.
 * 파일이 정말 없어졌을 때는 붙들지 않는다 — 그건 알려줘야 하는 상태다.
 */
function readWatchlist(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    lastGood.delete(file);   // 자리를 옮겼거나 지웠다 — 옛 목록을 붙들고 있으면 안 된다
    return [];
  }
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('목록이 아님');
    const out = list
      .filter((x) => x && x.ticker)
      .map((x) => ({
        ticker: String(x.ticker).trim(),
        name: String(x.name || x.ticker).trim(),
        market: toMarket(x.market)
      }));
    if (out.length) lastGood.set(file, out);
    return out;
  } catch {
    return lastGood.get(file) || [];
  }
}

// ── 야후 기호 ───────────────────────────────────────────

/**
 * 국내 종목번호에 붙일 꼬리표.
 * 코스피는 .KS, 코스닥은 .KQ인데 watchlist.json에는 그 구분이 없다(둘 다 market: 'KR').
 * 다행히 야후는 코스닥 종목도 .KS로 물어보면 찾아준다(현대무벡스 319400로 확인).
 * 그래도 안 되는 것이 있을 수 있어 .KQ까지 시도하고, 한 번 통한 것은 기억해 둔다.
 */
const solved = new Map();   // '005930' → '005930.KS'

function candidates(item) {
  if (item.index) return [item.ticker];
  const hit = solved.get(item.ticker);
  if (hit) return [hit];
  if (item.market === 'KR') return [`${item.ticker}.KS`, `${item.ticker}.KQ`];
  if (item.market === 'JP') return [`${item.ticker}.T`];
  if (item.market === 'HK') {
    // 네이버는 «00700»처럼 다섯 자리로 주는데 야후는 «0700»을 쓴다.
    // 그런데 위안화로 거래되는 짝(80700)은 다섯 자리 그대로다 — 둘 다 시도한다.
    const four = String(Number(item.ticker)).padStart(4, '0');
    return four === item.ticker ? [`${item.ticker}.HK`] : [`${item.ticker}.HK`, `${four}.HK`];
  }
  return [item.ticker];
}

// ── 받아오기 ────────────────────────────────────────────

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: TIMEOUT_MS,
      // 기본 헤더로는 막히는 때가 있다
      // 네이버는 Referer 없이 부르면 막는다. 야후는 신경 쓰지 않으므로 같이 보낸다.
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        Referer: 'https://m.stock.naver.com/'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); return reject(new Error('응답이 너무 큽니다')); }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('시간 초과')); });
    req.on('error', reject);
  });
}

/**
 * 한 종목의 지금 값. 못 받으면 null.
 * 시세를 받는 곳은 여기 하나다 — 나중에 KIS로 바꿀 때 여기만 갈면 된다.
 */
async function fetchQuote(symbol) {
  const url = `https://${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const j = await getJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const m = r && r.meta;
  if (!m || m.regularMarketPrice == null) return null;
  return {
    symbol,
    price: m.regularMarketPrice,
    // previousClose가 없는 응답이 있어 chartPreviousClose를 같이 본다
    prev: m.previousClose != null ? m.previousClose : m.chartPreviousClose,
    currency: m.currency || null,
    exchange: m.fullExchangeName || m.exchangeName || null,
    zone: m.exchangeTimezoneName || null,
    fullName: m.longName || m.shortName || null,
    at: m.regularMarketTime ? m.regularMarketTime * 1000 : null
  };
}

/** 꼬리표를 바꿔가며 될 때까지 시도한다 */
async function quoteOf(item) {
  let lastErr = null;
  for (const sym of candidates(item)) {
    try {
      const q = await fetchQuote(sym);
      if (q) {
        // 통한 꼬리표는 기억해 둔다 — 다음부터 헛걸음을 안 한다
        if (!item.index) solved.set(item.ticker, sym);
        return q;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/** 여러 개를 몇 개씩 나눠 받는다 — 하나씩 줄 세우면 21개에 3.5초가 걸린다 */
async function pooled(items, work, lanes = LANES) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  }));
  return out;
}

// ── 장이 열려 있나 ──────────────────────────────────────

/** 그 시장 현지의 «지금»을 부분별로 (서머타임은 Intl이 알아서 맞춘다) */
function localParts(zone, at = Date.now()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    min: Number(p.hour) * 60 + Number(p.minute)
  };
}

// 일본·홍콩은 점심에 한 번 닫는다. 그때 «장중»이라고 하면 값이 안 움직이는 이유를 알 수 없다.
// (도쿄 마감은 2024년 11월부터 15:30 — 실측한 마지막 체결 시각과도 맞는다)
const HOURS = {
  KR: { zone: 'Asia/Seoul', open: 9 * 60, close: 15 * 60 + 30 },
  US: { zone: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
  JP: { zone: 'Asia/Tokyo', open: 9 * 60, close: 15 * 60 + 30, lunch: [11 * 60 + 30, 12 * 60 + 30] },
  HK: { zone: 'Asia/Hong_Kong', open: 9 * 60 + 30, close: 16 * 60, lunch: [12 * 60, 13 * 60] }
};

/**
 * 장 상태. 공휴일 달력은 들고 있지 않다 — 대신 «시세가 오늘 것인가»로 판단한다.
 * 시세 시각이 그 시장 기준 오늘이 아니면, 시간표상 장중이어도 실제로는 안 열린 날이다.
 *
 * quoteAt은 반드시 «그 시장에서 가장 최근에 거래된 것»이어야 한다.
 * 종목 하나만 보면 안 된다 — 거래가 뜸한 종목은 오늘 한 번도 안 붙어서 어제 값을 들고 있고,
 * 그걸로 판단하면 장이 열려 있는데도 «휴장»이 된다 (현대무벡스에서 실제로 그랬다).
 */
function session(market, quoteAt, now = Date.now()) {
  const h = HOURS[toMarket(market)];
  const t = localParts(h.zone, now);
  if (t.weekday === 'Sat' || t.weekday === 'Sun') return '주말';
  const within = t.min >= h.open && t.min < h.close;
  if (!within) return t.min < h.open ? '장 시작 전' : '장 마감';
  if (h.lunch && t.min >= h.lunch[0] && t.min < h.lunch[1]) return '점심 휴장';
  // 시간표는 장중인데 시세가 오늘 것이 아니면 안 연 날이다 (공휴일)
  if (quoteAt) {
    const q = localParts(h.zone, quoteAt);
    if (q.date !== t.date) return '휴장';
  }
  return '장중';
}

// ── 바깥에서 쓰는 것 ────────────────────────────────────

/**
 * 좁은 위젯에 들어갈 짧은 이름.
 * watchlist에는 «Advanced Micro Devices, Inc.»처럼 긴 이름이 섞여 있는데
 * 그대로 두면 위젯에서 죄다 «Advanced Micro…»로 잘려 무슨 종목인지 알 수 없다.
 * 해외 종목은 종목기호(AMD)가 오히려 짧고 분명하다.
 */
function shortName(item) {
  const n = String(item.name || '').trim();
  if (!n) return item.ticker;
  if (item.index) return n;
  if (item.market === 'US') return n.length > 10 ? item.ticker : n;
  return n.length > 12 ? `${n.slice(0, 11)}…` : n;
}

/**
 * 관심 종목 + 지수의 지금 값.
 * 못 받은 종목은 버리지 않고 error를 달아 넘긴다 — 목록에서 사라지면
 * «내가 지웠나?» 싶어진다. 자리는 지키고 값만 비워 둔다.
 */
async function build({ list = [], withIndexes = true, market = 'all', now = Date.now() } = {}) {
  // «해외»는 국내가 아닌 전부다 (미국·일본·홍콩)
  const keep = (mk) => market === 'all' || (market === 'KR' ? mk === 'KR' : mk !== 'KR');
  const wanted = list.filter((w) => keep(w.market));
  const has = new Set(wanted.map((w) => w.market));
  const idx = withIndexes
    ? INDEXES.filter((i) => keep(i.market) && (i.always || has.has(i.market)))
    : [];
  const items = [...idx, ...wanted];
  if (!items.length) return { rows: [], at: now, empty: true };

  const rows = await pooled(items, async (item) => {
    const base = {
      ticker: item.ticker,
      name: item.name,
      short: shortName(item),
      market: item.market,
      index: !!item.index
    };
    try {
      const q = await quoteOf(item);
      if (!q) return { ...base, error: '못 찾음' };
      const change = q.prev != null ? q.price - q.prev : null;
      return {
        ...base,
        symbol: q.symbol,
        price: q.price,
        prev: q.prev,
        change,
        pct: q.prev ? (change / q.prev) * 100 : null,
        currency: q.currency,
        exchange: q.exchange,
        at: q.at
      };
    } catch (e) {
      return { ...base, error: e.message || '실패' };
    }
  });

  // 장 상태는 시장마다 한 번만 정하고 그 시장의 모든 줄에 같이 붙인다.
  // 시장에서 «가장 최근에 붙은» 시각을 기준으로 삼는다 — 지수는 늘 거래되니 보통 그것이다.
  const fresh = {};
  for (const r of rows) {
    if (r.at && (!fresh[r.market] || r.at > fresh[r.market])) fresh[r.market] = r.at;
  }
  const sess = {};
  for (const mk of Object.keys(fresh)) sess[mk] = session(mk, fresh[mk], now);
  for (const r of rows) {
    r.session = sess[r.market] || session(r.market, null, now);
    // 이 종목만 오래된 값인가 — 오늘 한 번도 안 붙은 종목은 어제 값을 들고 있다
    r.stale = !!(r.at && fresh[r.market] && fresh[r.market] - r.at > 6 * 60 * 60 * 1000);
  }

  const good = rows.filter((r) => r.price != null);
  const newest = Math.max(0, ...good.map((r) => r.at || 0));
  return {
    rows,
    at: now,
    // 시세가 얼마나 묵었나 — 야후 국내 시세는 20분쯤 지연된다 (실측)
    lagSec: newest ? Math.round((now - newest) / 1000) : null,
    failed: rows.length - good.length,
    empty: false
  };
}

/**
 * 종목 하나를 확인하고 이름까지 받아온다 — 목록에 넣기 전에 «있는 종목인가»를 본다.
 * 국내는 여섯 자리 숫자, 해외는 알파벳으로 판별한다 (algo-trader가 쓰는 규칙과 같다).
 */
/**
 * 국내 종목의 한글 이름. 야후는 «Samsung Electronics Co., Ltd.»처럼 영문으로 주는데,
 * 목록에서 그 이름을 읽고 어느 종목인지 알아보기 어렵다.
 * 못 받으면 그냥 넘어간다 — 이름 하나 때문에 종목 추가가 막히면 안 된다.
 */
function korName(ticker) {
  return getJson(`https://m.stock.naver.com/api/stock/${encodeURIComponent(ticker)}/integration`)
    .then((j) => (j && j.stockName) || null)
    .catch(() => null);
}

async function lookup(input) {
  // 검색 목록에서 고른 것은 시장을 이미 알고 있다. 그때는 그걸 믿는다 —
  // 국내 ETF에는 «0162Z0»처럼 숫자 여섯 자리 규칙에 안 맞는 코드가 있어서,
  // 글자만 보고 나누면 해외 종목으로 잘못 넘어간다.
  const picked = input && typeof input === 'object' ? input : null;
  const raw = String((picked ? picked.ticker : input) || '').trim();
  if (!raw) return null;
  // 고른 것이면 시장을 그대로 쓴다. «국내 아니면 미국»으로 나누면 일본·홍콩이
  // 미국으로 뭉개져서, 7203(토요타)을 야후에 그냥 «7203»으로 물어보고 실패한다.
  const market = picked ? toMarket(picked.market) : (/^\d{6}$/.test(raw) ? 'KR' : 'US');
  // 대문자로 바꾸는 건 미국 기호뿐이다 (nvda → NVDA). 숫자 코드는 손대면 안 된다.
  const item = { ticker: market === 'US' ? raw.toUpperCase() : raw, market, name: raw };
  const q = await quoteOf(item).catch(() => null);
  if (!q) return null;
  // 이름은 «고른 것 → 네이버 한글 → 야후 영문» 순으로 고른다.
  // 네이버는 해외 종목도 한글로 준다(엔비디아) — 목록에서 훨씬 잘 읽힌다.
  const kor = picked ? null : (market === 'KR' ? await korName(item.ticker) : null);
  return {
    ticker: item.ticker,
    market: item.market,
    name: (picked && picked.name) || kor || q.fullName || item.ticker,
    symbol: q.symbol,
    price: q.price,
    currency: q.currency,
    exchange: q.exchange
  };
}

/**
 * 이름으로 종목 찾기 — 네이버 종목 자동완성.
 *
 * 종목번호를 외우고 있는 사람은 없다. «삼성»만 쳐도 삼성전자·삼성전기가 나오고,
 * «삼전» 같은 별칭도, «엔비디아»처럼 한글로 쓴 해외 종목도 찾아준다.
 * 야후에도 검색이 있지만 한글 질의에는 HTTP 400을 준다 (실측).
 *
 * 국내·미국·일본·홍콩만 남긴다 — 야후에서 시세가 확인된 네 곳이다.
 * 그 밖의 나라가 섞여 나오면 골라도 값이 안 나오므로 아예 안 보여준다.
 */
async function search(q, limit = 8) {
  const query = String(q || '').trim();
  if (!query) return [];
  const j = await getJson(
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock`
  ).catch(() => null);
  const items = (j && j.items) || [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || !it.code || !it.name) continue;
    const market = { KOR: 'KR', USA: 'US', JPN: 'JP', HKG: 'HK' }[it.nationCode] || null;
    if (!market || seen.has(it.code)) continue;
    seen.add(it.code);
    out.push({
      ticker: String(it.code),
      name: String(it.name),
      market,
      exchange: it.typeName || it.typeCode || null
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** algo-trader의 watchlist.json을 «한 번» 가져온다 (그 뒤로는 서로 상관없다) */
function importFrom(file) {
  return readWatchlist(file);
}

module.exports = {
  build, lookup, search, importFrom, readWatchlist, toMarket, MARKETS, defaultWatchPath, session, localParts,
  INDEXES, HOURS, _fetchQuote: fetchQuote
};

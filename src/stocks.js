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
// TOP 100 만은 네이버 순위 목록에서 값까지 같이 받는다 (아래 top()).

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
      // 본문 도중 끊기면 'end' 도 요청 쪽 오류도 안 온다 — 이 약속이 영영 안 끝나, 부르는 쪽의 «받는 중»이 앱을 다시 켤 때까지 남는다.
      // 제대로 끝난 뒤의 close 는 이미 끝난 약속이라 아무 일도 안 한다.
      const cut = () => reject(new Error('연결이 끊겼습니다'));
      res.on('error', cut);
      res.on('close', cut);
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

// ── 지난 시세 (차트) ────────────────────────────────────

/**
 * 기간별 봉 간격.
 * 1일을 1분봉으로 받으면 380개가 넘어오는데 폭 700픽셀짜리 창에서는 다 보이지도 않고,
 * 야후가 1분봉은 최근 7일치만 준다. 5분봉이면 하루가 78개라 넉넉하다.
 * 6개월·1년을 주봉으로 받으면 계단이 눈에 띄어서 일봉 그대로 둔다 (1년 = 250개쯤).
 */
const CHART_INTERVAL = { '1d': '5m', '5d': '30m', '1mo': '1d', '6mo': '1d', '1y': '1d' };

/**
 * 한 기호의 지난 시세. 못 받거나 쓸 만한 점이 하나도 없으면 null.
 * 시세를 받는 곳이 fetchQuote() 하나였는데 이제 둘이다 — KIS로 갈 때 같이 봐야 한다.
 */
async function fetchHistory(symbol, range, interval) {
  const url = `https://${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  const j = await getJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = r && r.timestamp;
  const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
  const close = q && q.close;
  if (!Array.isArray(ts) || !Array.isArray(close)) return null;
  // 봉차트와 거래량 막대를 그리려면 종가만으로는 모자란다 — 같은 응답에 다 들어 있으니
  // 같이 뽑는다(요청은 그대로 한 번이다). 없는 값은 종가로 메워 봉이 깨지지 않게 한다.
  const num = (a, i, dflt) => {
    const v = Array.isArray(a) ? a[i] : null;
    return v == null || !Number.isFinite(v) ? dflt : v;
  };
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    // 장중에는 아직 체결이 없는 자리가 null로 온다. 그대로 그리면 선이 0으로 떨어진다.
    if (c == null || !Number.isFinite(c) || ts[i] == null) continue;
    const o = num(q.open, i, c);
    const h = num(q.high, i, Math.max(o, c));
    const l = num(q.low, i, Math.min(o, c));
    points.push({
      t: ts[i] * 1000, c, o,
      // 고가가 저가보다 낮게 오는 자리가 드물게 있다(메워 넣은 값 탓) — 뒤집어 바로잡는다
      h: Math.max(h, l, o, c),
      l: Math.min(l, h, o, c),
      v: Math.max(0, num(q.volume, i, 0))
    });
  }
  if (!points.length) return null;
  // 전일 종가 — 1일 차트의 기준선. meta 에 있을 때만 준다.
  const prev = r.meta && Number.isFinite(r.meta.chartPreviousClose)
    ? r.meta.chartPreviousClose
    : (r.meta && Number.isFinite(r.meta.previousClose) ? r.meta.previousClose : null);
  return { points, range, currency: (r.meta && r.meta.currency) || null, prevClose: prev };
}

/**
 * 차트용 지난 시세. 실패하면 던지지 않고 null을 준다 —
 * 부르는 쪽(chartwin)이 빈 차트를 보여주면 되는 일이지, 창이 깨질 일은 아니다.
 */
async function history(item, range = '1mo') {
  if (!item || !item.ticker) return null;
  const rg = CHART_INTERVAL[range] ? range : '1mo';
  const ticker = String(item.ticker).trim();
  // 지수 줄도 눌러서 차트를 볼 수 있는데, 창에서 넘어오는 것은 { ticker, market }뿐이라
  // index 표시가 없다. 그대로 candidates()에 넘기면 «^KS11.KS»를 물어보고 다 실패한다.
  const want = {
    ticker,
    market: toMarket(item.market),
    index: item.index != null ? !!item.index : ticker.startsWith('^')
  };
  for (const sym of candidates(want)) {
    try {
      const h = await fetchHistory(sym, rg, CHART_INTERVAL[rg]);
      if (h) {
        if (!want.index) solved.set(want.ticker, sym);   // 통한 꼬리표는 시세 쪽과 같이 쓴다
        return h;
      }
    } catch {
      // 다음 후보로 (국내는 .KS가 안 되면 .KQ)
    }
  }
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

// ── 순위 (TOP 100) ──────────────────────────────────────
//
// 증권사 앱의 순위 화면 같은 것. 야후에는 순위가 없어 네이버 목록을 쓴다 — 100줄이 한 번에 오고
// 값도 같이 오므로 줄마다 야후를 부를 일이 없다. 그래서 이 보기는 시세 출처가 관심 종목(야후, 20분 지연)과 다르고
// 거의 실시간이다. 머리글에 그렇게 적는다.

const TOP_SIZE = 100;
// priceTop 은 이름과 달리 거래대금 순위다 (실측: SK하이닉스 3,344억이 삼성전자 2,727억보다 앞).
// 인기(searchTop)는 국내뿐이다. 미국은 400 을 준다.
const TOP_SORTS = ['marketValue', 'priceTop', 'up', 'down', 'searchTop'];
const TOP_KR = 'https://m.stock.naver.com/api/stocks';
const TOP_US = 'https://api.stock.naver.com/stock/exchange';
// 미국 전체를 한 번에 주는 목록은 없다 (USA·ALL 같은 이름은 400 — 실측)
const US_EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX'];
const TOP_BROKEN = '순위 자료를 읽지 못했습니다';

/**
 * 저장된 값에서 지금 고른 것을 읽는다. 이상한 값은 여기서 기본값으로 — 정렬은 주소에 들어가는 값이고,
 * 설정 파일을 손으로 고쳤거나 예전 버전이 남긴 값이 그대로 오면 400 만 받다 끝난다.
 * 미국의 인기는 시가총액으로 «보여 줄» 뿐 저장값을 바꾸지 않는다 — 국내로 돌아오면 인기 그대로다.
 */
function topPick(s = {}) {
  const market = s.stocksTopMarket === 'US' ? 'US' : 'KR';
  let sort = TOP_SORTS.includes(s.stocksTopSort) ? s.stocksTopSort : 'marketValue';
  if (sort === 'searchTop' && market === 'US') sort = 'marketValue';
  return { view: s.stocksView === 'top' ? 'top' : 'watch', market, sort };
}

/**
 * 네이버 기호를 야후 기호로 — 차트와 관심 종목 넣기가 야후로 간다.
 * 실측: BRK B→BRK-B, WHR PRA→WHR-PA(우선주), CELG RT→CELG-RI(권리), GRAF.U·TONT U→-UN(유닛).
 * 그 밖의 꼬리는 하이픈만 붙인다. 야후가 모르는 기호여도 빈 차트·«못 찾았습니다»로 끝나니 망가지지는 않는다.
 */
function yahooTicker(code) {
  const [base, tail] = String(code || '').trim().toUpperCase().split(/[\s.]+/);
  if (!tail) return base;
  if (tail === 'RT') return `${base}-RI`;
  if (tail === 'U') return `${base}-UN`;
  const pref = tail.match(/^PR([A-Z]?)$/);
  return `${base}-${pref ? `P${pref[1]}` : tail}`;
}

/**
 * 글자로 온 수. ''·'-'·'N/A'·null 은 «모름»이다 — Number('')·Number(null) 은 0 이라 그대로 쓰면 0원 줄이 된다.
 * 지수 표기와 터무니없이 긴 수도 모름이다. 네이버가 쓰지 않는 모양이고, 그대로 두면 300자리 금액이 화면에 나간다.
 */
function numOf(v) {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string') return null;
  const t = s.replace(/,/g, '').trim();
  return /^[+-]?\d{1,20}(\.\d+)?$/.test(t) ? Number(t) : null;
}

const textOf = (v) => (typeof v === 'string' ? v.trim() : '');

/** 큰 금액을 좁은 줄에 — 1,225조 · 49.4조 · 5.08조 · 4,907억 · 2만 */
function shortAmount(v) {
  const fmt = (n, digits) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const jo = v / 1e12;
  if (jo >= 100) return `${fmt(jo, 0)}조`;
  if (jo >= 10) return `${fmt(jo, 1)}조`;
  if (jo >= 1) return `${fmt(jo, 2)}조`;
  if (v >= 1e8) return `${fmt(v / 1e8, 0)}억`;
  return v >= 1e4 ? `${fmt(v / 1e4, 0)}만` : null;
}

/**
 * 우선주인가 — 네이버 기호의 꼬리로 본다 (WHR PRA, PCG PRC, AHT.PRI).
 * 우선주의 시가총액은 네이버 값이 틀리다: 28.69달러인 WHR PRA 가 3,299억 달러로 미국 38위에 오고, 보통주 WHR 은 상위 100에 없다 (실측).
 */
function isPreferred(x) {
  return /[\s.]PR[A-Z]?$/.test(textOf(x && x.symbolCode).toUpperCase());
}

/** 네이버 한 줄 → 화면 한 줄. 값을 읽을 수 없으면 null (NaN 줄을 내보내지 않는다) */
function topRow(x, market, sort) {
  if (!x || typeof x !== 'object') return null;
  const us = market === 'US';
  const ticker = us ? yahooTicker(textOf(x.symbolCode)) : textOf(x.itemCode);
  const price = numOf(x.closePriceRaw) ?? numOf(x.closePrice);
  // 국내 줄에는 fluctuationsRatioRaw 가 없다
  const pct = numOf(x.fluctuationsRatioRaw) ?? numOf(x.fluctuationsRatio);
  if (!ticker || price == null || price <= 0 || pct == null) return null;
  // raw 금액은 국내는 원, 미국은 달러다 (실측: 삼성전자 1224795368376000 = 1,224조 7,954억원)
  const amount = sort === 'marketValue' ? numOf(x.marketValueRaw)
    : sort === 'priceTop' ? numOf(x.accumulatedTradingValueRaw) : null;
  // 금액 순위에서 그 금액을 못 읽으면 필드가 바뀐 것이다 — 금액 없는 100줄이 멀쩡한 척 나가면 안 된다.
  // (권리 증서는 시가총액이 «-» 로 오지만 상승·하락에만 나오고, 거기서는 등락률로 줄 세운다)
  if ((sort === 'marketValue' || sort === 'priceTop') && amount == null) return null;
  const short = amount ? shortAmount(amount) : null;
  const end = textOf(x.stockEndType).toLowerCase();
  // 네이버는 권리 증서를 stock 으로, 본주 이름으로 준다 (CELG RT «브리스톨 마이어스 스퀴브» +110%, GENVR «젠 디지털» — 실측).
  // 표시가 없으면 대형주가 그만큼 오른 것으로 읽힌다. GENVR 은 기호가 평범해 영문 이름도 본다
  const right = us && (/-RI$/.test(ticker) || /\b(contingent|rights?)\b/i.test(textOf(x.stockNameEng)));
  return {
    ticker,
    name: textOf(x.stockName) || textOf(x.stockNameEng) || ticker,
    market,
    kind: end === 'etf' || end === 'etn' ? end : right ? 'right' : 'stock',
    price,
    pct,
    currency: us ? 'USD' : 'KRW',
    metric: short && (us ? `${short} 달러` : short),
    exchange: textOf(x.stockExchangeType && x.stockExchangeType.name) || null,
    rankBy: amount ?? pct
  };
}

/**
 * 답 하나를 줄로. 모양이 바뀌었으면 던진다 — 부르는 쪽이 실패로 알린다.
 * 잘린 답(전체는 2770개라는데 3줄)은 줄이 멀쩡해도 빠진 목록이다. totalCount 가 없으면 따지지 못한다.
 * 국내는 값이 «-» 인 줄 하나로 그 순위가 통째로 죽으면 안 되니 그 줄만 빼고 번호는 네이버 자리 그대로 둔다 (당겨 매기면 2등이 1등으로 보인다).
 * 열에 하나를 넘게 못 읽으면 줄이 이상한 것이 아니라 답의 모양이 바뀐 것으로 본다.
 * 미국은 한 줄도 못 뺀다 — 합친 자리를 정할 수 없어 빼면 그 아래 순위가 틀린다. 실제 답 12개에 그런 줄은 없었다.
 */
function topRows(j, market, sort) {
  const list = j && j.stocks;
  if (!Array.isArray(list) || !list.length) throw new Error(TOP_BROKEN);
  if (list.length < Math.min(TOP_SIZE, Number(j.totalCount) || 0)) throw new Error(TOP_BROKEN);
  // 우선주는 줄을 읽기 전에 뺀다 — 시가총액이 «-» 로 와도 «못 읽는 줄»로 세지 않게
  const kept = market === 'US' && sort === 'marketValue' ? list.filter((x) => !isPreferred(x)) : list;
  const rows = kept.flatMap((x) => {
    const r = topRow(x, market, sort);
    return r ? [{ ...r, rank: list.indexOf(x) + 1 }] : [];
  });
  const lost = kept.length - rows.length;
  if (!rows.length || lost > (market === 'US' ? 0 : kept.length * 0.1)) throw new Error(TOP_BROKEN);
  return rows;
}

/** 큰 값부터, 하락만 작은 값부터. 같은 값이면 받은 순서 그대로 */
const byRank = (sort) => {
  const dir = sort === 'down' ? 1 : -1;
  return (a, b) => dir * (a.rankBy - b.rankBy);
};

/**
 * 국내 상승·하락은 네이버 순서가 등락률 순서가 아니다 (실측: 37위 8.54% 가 42위 11.25% 보다 위, 100줄에 역전 30여 곳).
 * «상승» 아래 숫자가 뒤섞이면 고장처럼 보이니 받은 줄 안에서 다시 줄 세운다. 번호 자리는 그대로 — 깨져서 빠진 줄의 번호는 계속 빈다.
 */
function sortMovers(rows, sort) {
  const slots = rows.map((r) => r.rank);
  return [...rows].sort(byRank(sort)).map((r, i) => ({ ...r, rank: slots[i] }));
}

/** 거래소 셋을 하나로 — 값으로 다시 줄 세우고 번호를 새로 매긴다. 각 거래소의 상위 100이면 합친 상위 100은 그 안에 다 있다 */
function mergeTop(rows, sort) {
  const seen = new Set();
  return [...rows]
    .sort(byRank(sort))
    .filter((r) => {
      if (seen.has(r.ticker)) return false;
      seen.add(r.ticker);
      return true;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * 순위 하나를 받아 온다.
 * 미국은 거래소 하나라도 실패하면 통째로 실패다 — 빠진 목록을 «미국 TOP 100»이라고 내놓으면 거짓말이다.
 * ETF·ETN 은 네이버가 준 대로 둔다 (걸러 주는 인자도 없다 — 실측).
 */
async function top(want = {}) {
  const { market, sort } = topPick({ stocksTopMarket: want.market, stocksTopSort: want.sort });
  const query = `?page=1&pageSize=${TOP_SIZE}`;
  const urls = market === 'US'
    ? US_EXCHANGES.map((ex) => `${TOP_US}/${ex}/${sort}${query}`)
    : [sort === 'searchTop' ? `${TOP_KR}/searchTop${query}` : `${TOP_KR}/${sort}/all${query}`];
  let answers;
  try {
    answers = await Promise.all(urls.map((u) => getJson(u)));
  } catch (e) {
    // 점검 안내 같은 HTML 이 오면 JSON 오류가 나온다 — 그대로 화면에 낼 말이 아니다
    throw e instanceof SyntaxError ? new Error(TOP_BROKEN) : e;
  }
  const rows = answers.flatMap((j) => topRows(j, market, sort));
  const ordered = market === 'US' ? mergeTop(rows, sort)
    : sort === 'up' || sort === 'down' ? sortMovers(rows, sort) : rows;
  // 답 머리에 없으면 줄에서 읽는다. 어느 쪽에도 없으면 모른다고 둔다
  const marks = answers.map((j) => j.marketStatus || (j.stocks[0] && j.stocks[0].marketStatus));
  return {
    rows: ordered.slice(0, TOP_SIZE).map(({ rankBy, ...r }) => r),
    status: marks.includes('OPEN') ? 'OPEN' : marks.includes('CLOSE') ? 'CLOSE' : null
  };
}

module.exports = {
  build, lookup, search, history, importFrom, readWatchlist, toMarket, MARKETS, defaultWatchPath,
  session, localParts, INDEXES, HOURS, _fetchQuote: fetchQuote,
  top, topPick, yahooTicker, TOP_SORTS
};

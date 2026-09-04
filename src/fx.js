// 환율 — 외화 시세를 원화로 바꿔 보여주기 위한 것.
//
// 주식 창에서 «원화» 를 켜면, 달러·엔·홍콩달러로 오는 시세를 원으로 환산해 같이 보여준다.
// 시세(stocks.js)와 달리 환율은 자주 안 변하므로 넉넉히 묵혀 쓴다.
//
// ── 계약 (이 두 개만 바깥이 쓴다) ─────────────────────────
//   rate(cur)     → Promise<number|null>
//       'USD'|'JPY'|'HKD' 를 주면 1단위가 몇 원인지. 'KRW' 는 1.
//       못 구하면 null — 부르는 쪽은 «환산 안 함» 으로 조용히 넘어간다.
//
//   attach(rows)  → Promise<rows>
//       각 행에 krwPrice(원화 환산가)를 붙여 돌려준다.
//       환율을 못 구했거나 이미 원화면 안 붙이고 그대로 돌려준다.
//       행 모양은 stocks.build() 가 주는 것 그대로 — { price, currency, ... }.
//
// 환율은 시세와 같은 곳(Yahoo)에서 온다. 심볼은 'USDKRW=X' 꼴이다.
//
// 단위 함정: 야후의 JPYKRW=X 는 «1엔이 몇 원인가»를 준다 (100엔이 아니다).
// 실측 8.63원 — 100엔 기준(약 863)으로 오해해 100 을 곱하거나 나누면 엔화 종목만
// 두 자리 틀린 값이 조용히 나간다. 그래서 받은 값을 그대로 곱하고 손대지 않는다.
// 단위가 맞나 보려면 받은 값끼리 나눠 본다 — 실측 USD 1352.78 · JPY 8.633 · HKD 172.11 에서
// USD/HKD = 7.86 (홍콩달러 페그 7.75~7.85), USD/JPY = 156.7 로 세상 값과 맞아떨어진다.

const https = require('https');

const HOST = 'query1.finance.yahoo.com';
const CACHE_MS = 10 * 60_000;   // 환율은 10분이면 충분히 새것이다
// 시세보다 짧게 끊는다 — 환율은 곁다리라, 이것 때문에 시세 화면이 멎으면 안 된다
const TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;

/** 통화 → { krw, at }. 마지막으로 멀쩡히 받은 값. */
const cache = new Map();
/** 통화 → 진행 중인 약속. 여러 행이 같은 통화를 물어도 요청은 한 번만 나간다. */
const pending = new Map();

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: TIMEOUT_MS,
      // 기본 헤더로는 막히는 때가 있다 (stocks.js 가 겪은 것과 같다)
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
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
    // timeout 은 «연결이 조용한 시간»이라 스스로 끊어주지 않는다 — 직접 죽여야 한다
    req.on('timeout', () => { req.destroy(); reject(new Error('시간 초과')); });
    req.on('error', reject);
  });
}

/**
 * 야후에서 한 통화의 지금 환율. 못 구하면 null (여기서만 그물을 친다).
 * 시세와 같은 chart 엔드포인트다 — meta.regularMarketPrice 가 곧 환율이다.
 */
async function fetchRate(code) {
  const url = `https://${HOST}/v8/finance/chart/${encodeURIComponent(`${code}KRW=X`)}?range=1d&interval=5m`;
  const j = await getJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const m = r && r.meta;
  const v = m && m.regularMarketPrice;
  // 0 이나 null 이 섞여 오는 때가 있다. 그걸 그대로 쓰면 외화 종목이 전부 0원이 된다.
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 통화 → 1단위당 원. 못 구하면 null. */
async function rate(cur) {
  const code = String(cur || '').trim().toUpperCase();
  if (code === 'KRW') return 1;
  // 'USDKRW=X' 를 만들 수 있는 모양만 받는다 — 이상한 값으로 야후를 두드리지 않는다
  if (!/^[A-Z]{3}$/.test(code)) return null;

  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.krw;

  // 같은 통화를 여러 행이 동시에 물어보면 약속을 나눠 쓴다 (요청 한 번)
  const going = pending.get(code);
  if (going) return going;

  const p = fetchRate(code)
    .then((v) => {
      if (v == null) return hit ? hit.krw : null;
      cache.set(code, { krw: v, at: Date.now() });
      return v;
    })
    // 못 받았으면 묵은 값이라도 쓴다 — 환율은 10분 사이에 화면이 틀릴 만큼 안 움직이고,
    // 잠깐 끊겼다고 원화 표시가 통째로 사라지면 «켰는데 왜 안 되지»가 된다.
    // 이때 cache 는 안 건드리므로 다음 부름에서 다시 받아본다.
    .catch(() => (hit ? hit.krw : null))
    .finally(() => { pending.delete(code); });

  pending.set(code, p);
  return p;
}

/**
 * 이 행을 원화로 바꿀 수 있나.
 * 지수(코스피·나스닥)는 값 자체가 «지수»라 환산이 뜻이 없다 — 3만 5천 «원»이 아니다.
 */
function convertible(r) {
  if (!r || r.index) return false;
  if (!Number.isFinite(r.price)) return false;
  const c = String(r.currency || '').toUpperCase();
  return !!c && c !== 'KRW';
}

/**
 * 행마다 krwPrice 를 붙인다. 환율을 못 구하면 그대로 돌려준다 —
 * 화면 쪽은 krwPrice 가 없으면 원래 통화로 그린다.
 *
 * 여기서는 절대 터지지 않는다. 환율은 곁다리인데 그것 때문에 시세 갱신이
 * 통째로 실패하면 (stockwin 의 try 로 떨어져) 화면이 «시세를 못 받았습니다»가 된다.
 */
async function attach(rows) {
  if (!Array.isArray(rows)) return rows;

  const need = [...new Set(
    rows.filter(convertible).map((r) => String(r.currency).toUpperCase())
  )];
  const got = need.length ? await Promise.all(need.map((c) => rate(c).catch(() => null))) : [];
  const table = new Map(need.map((c, i) => [c, got[i]]));

  // 새 배열로 돌려준다. 원본 행은 손대지 않는다 — stockwin 이 들고 있는 객체를
  // 여기서 고치면, 원화를 껐다 켤 때 이미 환산된 값에 또 곱하는 사고가 난다.
  return rows.map((r) => {
    if (!convertible(r)) return r;
    const k = table.get(String(r.currency).toUpperCase());
    return k ? { ...r, krwPrice: r.price * k } : r;
  });
}

module.exports = { rate, attach, CACHE_MS };

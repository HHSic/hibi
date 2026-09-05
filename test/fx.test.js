const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 환율(src/fx.js) 리뷰 — 읽어서 «그렇게 보인다»가 아니라 실제로 그런지 잰다.
// 여기 검사들은 병렬 작업자가 만든 코드가 주장하는 성질 그대로다:
//   · 여러 행이 같은 통화를 물어도 요청은 한 번
//   · 10분은 묵혀 쓴다
//   · 끊기면 묵은 값이라도 쓴다 (원화 표시가 통째로 사라지지 않게)
//   · 원본 행을 안 고친다 (껐다 켤 때 두 번 곱하는 사고를 막는다)
//   · 지수·원화·값 없는 행은 안 건드린다
//   · 무슨 일이 있어도 안 터진다 (시세 갱신을 통째로 날리면 안 되므로)
const { app } = require('electron');
const https = require('https');
const { EventEmitter } = require('events');

let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };

// ── 야후 대신 우리가 답한다 ──────────────────────────────
// 진짜 망을 타면 «요청이 한 번인가»를 못 센다. 여기서는 그 수를 세는 것이 요점이다.
let calls = 0;
let reply = { price: 1350 };     // { price } 또는 { fail: '...' }
https.get = (url, opts, cb) => {
  calls++;
  const done = typeof opts === 'function' ? opts : cb;
  const req = new EventEmitter();
  req.destroy = () => {};
  setImmediate(() => {
    if (reply.fail) { req.emit('error', new Error(reply.fail)); return; }
    const res = new EventEmitter();
    res.statusCode = 200;
    res.resume = () => {};
    done(res);
    res.emit('data', Buffer.from(JSON.stringify({
      chart: { result: [{ meta: { regularMarketPrice: reply.price } }] }
    })));
    res.emit('end');
  });
  return req;
};

const fx = require(`${ROOT}/src/fx.js`);

const row = (o) => ({ ticker: 'X', price: 100, currency: 'USD', ...o });

(async () => {
  // ── 요청 합치기 ──
  calls = 0;
  const many = await Promise.all([...Array(6)].map(() => fx.rate('USD')));
  ok(calls === 1, '같은 통화를 여섯이 물어도 요청은 한 번', { 요청: calls });
  ok(many.every((v) => v === 1350), '여섯이 같은 값을 받는다', many[0]);

  // ── 묵혀 쓰기 ──
  calls = 0;
  await fx.rate('USD');
  ok(calls === 0, '10분 안에는 다시 안 받는다', { 요청: calls });

  // ── 원화는 그냥 1 ──
  ok((await fx.rate('KRW')) === 1, '원화는 환율을 안 물어본다', await fx.rate('KRW'));

  // ── 이상한 통화는 두드리지 않는다 ──
  calls = 0;
  const junk = await fx.rate('없는통화');
  ok(junk === null && calls === 0, '모양이 안 맞으면 요청도 안 한다', { 값: junk, 요청: calls });

  // ── 끊기면 묵은 값 ──
  reply = { fail: '망 끊김' };
  calls = 0;
  const jpyFirst = await fx.rate('JPY');
  ok(jpyFirst === null, '처음부터 못 받으면 null', jpyFirst);
  reply = { price: 8.6 };
  ok((await fx.rate('JPY')) === 8.6, '그다음엔 다시 받아본다 (실패를 캐시하지 않는다)');
  reply = { fail: '망 끊김' };
  // 10분이 안 지났으니 캐시가 먼저 걸린다 — 캐시를 늙히고 다시 본다
  const stale = await fx.rate('JPY');
  ok(stale === 8.6, '끊겨도 묵은 값으로 버틴다', stale);

  // ── attach ──
  reply = { price: 1350 };
  const rows = [
    row({ ticker: 'NVDA' }),
    row({ ticker: '005930', currency: 'KRW', price: 71000 }),
    row({ ticker: '^KS11', currency: 'KRW', price: 2500, index: true }),
    row({ ticker: 'KOSPI200', currency: 'USD', price: 300, index: true }),
    row({ ticker: 'DEAD', price: null }),
    row({ ticker: 'NOCUR', currency: null })
  ];
  const before = JSON.stringify(rows);
  const out = await fx.attach(rows);
  const byT = Object.fromEntries(out.map((r) => [r.ticker, r]));

  ok(byT.NVDA.krwPrice === 100 * 1350, '외화 종목에 원화가 붙는다', byT.NVDA.krwPrice);
  ok(byT['005930'].krwPrice === undefined, '원화 종목은 안 건드린다');
  ok(byT['^KS11'].krwPrice === undefined, '지수는 안 건드린다 (지수는 «원»이 아니다)');
  ok(byT.KOSPI200.krwPrice === undefined, '외화 표시 지수도 안 건드린다');
  ok(byT.DEAD.krwPrice === undefined, '값 없는 행은 안 건드린다');
  ok(byT.NOCUR.krwPrice === undefined, '통화 없는 행은 안 건드린다');
  ok(JSON.stringify(rows) === before, '원본 행을 고치지 않는다 (두 번 곱하는 사고 방지)');
  ok(out !== rows, '새 배열로 돌려준다');

  // 같은 것을 두 번 붙여도 값이 두 배가 되지 않는다 — 실제로 껐다 켜는 흐름이다
  const twice = await fx.attach(await fx.attach(rows));
  ok(twice.find((r) => r.ticker === 'NVDA').krwPrice === 100 * 1350, '두 번 붙여도 한 번만 곱해진다',
    twice.find((r) => r.ticker === 'NVDA').krwPrice);

  // ── 무슨 일이 있어도 안 터진다 ──
  reply = { fail: '망 끊김' };
  let threw = null;
  try { await fx.attach([row({ ticker: 'NEW', currency: 'HKD' })]); } catch (e) { threw = e.message; }
  ok(!threw, '환율이 통째로 안 되어도 안 터진다', threw);
  ok(await fx.attach(null) === null, '이상한 것을 줘도 그대로 돌려준다');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
})().catch((e) => { console.error('LAB 터짐:', e); app.exit(1); });

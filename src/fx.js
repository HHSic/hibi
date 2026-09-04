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

const CACHE_MS = 10 * 60_000;   // 환율은 10분이면 충분히 새것이다

/** 통화 → 1단위당 원. 아직 구현 전이라 늘 null 이다. */
async function rate(cur) {
  if (cur === 'KRW') return 1;
  void cur; void CACHE_MS;
  return null;
}

/**
 * 행마다 krwPrice 를 붙인다. 환율을 못 구하면 그대로 돌려준다 —
 * 화면 쪽은 krwPrice 가 없으면 원래 통화로 그린다.
 */
async function attach(rows) {
  return rows;
}

module.exports = { rate, attach, CACHE_MS };

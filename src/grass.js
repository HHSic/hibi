// 잔디(기여 그래프)와 연속 기록 계산 — 순수 함수라 electron 없이 테스트한다.
//
// stats 모양: { 'YYYY-MM-DD': { done, skipped, byType: { [id]: n } } }
//   · typeId 를 주면 그 종류의 byType 값을, null 이면 done 합계를 센다.
//   · byType 이 없는 옛 기록은 종류별 조회에서 0으로 취급된다(전체는 done 그대로).

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function countOn(stats, key, typeId) {
  const day = stats[key];
  if (!day) return 0;
  if (typeId) return (day.byType && day.byType[typeId]) || 0;
  return day.done || 0;
}

/**
 * 주(週) 컬럼으로 정렬된 잔디 셀 배열을 만든다.
 * 첫 셀은 (weeks-1)주 전의 일요일, 마지막 컬럼은 이번 주(미래 날짜는 future=true).
 * 길이는 항상 weeks*7 이라 렌더러가 7행 그리드로 그리면 컬럼이 깔끔한 주가 된다.
 * @returns {{cells: {count:number, future:boolean, key:string}[], max:number}}
 */
function series(stats, weeks, typeId, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const thisSunday = new Date(t);
  thisSunday.setDate(t.getDate() - t.getDay()); // 이번 주 일요일
  const start = new Date(thisSunday);
  start.setDate(thisSunday.getDate() - (weeks - 1) * 7);

  const cells = [];
  let max = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const future = d > t;
    const count = future ? 0 : countOn(stats, dateKey(d), typeId);
    if (count > max) max = count;
    cells.push({ count, future, key: dateKey(d) });
  }
  return { cells, max };
}

/** 오늘(또는 오늘이 0이면 어제)부터 거슬러 연속으로 기록이 있는 일수 */
function currentStreak(stats, typeId, today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // 오늘이 아직 0이면 어제부터 센다 (하루는 봐준다)
  if (countOn(stats, dateKey(d), typeId) === 0) d.setDate(d.getDate() - 1);
  let n = 0;
  // 과하게 긴 루프를 막는 상한 (약 10년)
  for (let i = 0; i < 3660; i++) {
    if (countOn(stats, dateKey(d), typeId) === 0) break;
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** 기록 전체에서 가장 길었던 연속 일수 */
function bestStreak(stats, typeId) {
  const keys = Object.keys(stats)
    .filter((k) => countOn(stats, k, typeId) > 0)
    .sort();
  if (!keys.length) return 0;

  let best = 1;
  let run = 1;
  let prev = new Date(keys[0]);
  for (let i = 1; i < keys.length; i++) {
    const cur = new Date(keys[i]);
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 1) run++;
    else run = 1;
    if (run > best) best = run;
    prev = cur;
  }
  return best;
}

module.exports = { dateKey, countOn, series, currentStreak, bestStreak };

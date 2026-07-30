// 종료 직전 상태를 담아 두고, 다시 켤 때 이어갈 계획을 만든다.
// 업데이트 설치로 앱이 재시작돼도 카운트다운이 처음부터 돌지 않게 하는 것이 목적이다.
//
// 부수효과가 없는 순수 함수로 두어 테스트할 수 있게 했다.

/** 이보다 오래된 세션은 이어갈 의미가 없다 */
const MAX_AGE_MS = 30 * 60 * 1000;
/** 꺼져 있는 동안 지나간 알림이 실행 직후 바로 터지지 않게 두는 여유 */
const GRACE_MS = 30 * 1000;

/**
 * 저장할 세션 객체를 만든다.
 * @param {{paused:boolean, widgetHidden:boolean, nextAt:Record<string,number>}} snapshot
 * @param {number} now
 */
function capture(snapshot, now = Date.now()) {
  return {
    savedAt: now,
    paused: !!snapshot.paused,
    widgetHidden: !!snapshot.widgetHidden,
    nextAt: { ...(snapshot.nextAt || {}) }
  };
}

/**
 * 저장된 세션으로 무엇을 복원할지 계산한다. 이어갈 게 없으면 null.
 * @param {object|null} session 저장돼 있던 세션
 * @param {string[]} activeIds 현재 켜져 있는 알림 id (꺼진 알림은 복원하지 않는다)
 * @param {number} now
 * @returns {{paused:boolean, widgetHidden:boolean, nextAt:Record<string,number>, restored:number}|null}
 */
function plan(session, activeIds, now = Date.now()) {
  if (!session || !session.nextAt) return null;
  if (now - (session.savedAt || 0) > MAX_AGE_MS) return null;

  const active = new Set(activeIds || []);
  const floor = now + GRACE_MS;
  const nextAt = {};
  let restored = 0;

  for (const [id, at] of Object.entries(session.nextAt)) {
    if (!active.has(id)) continue;
    const t = Number(at);
    if (!Number.isFinite(t)) continue;
    nextAt[id] = Math.max(t, floor);
    restored++;
  }

  if (!restored) return null;
  return {
    paused: !!session.paused,
    widgetHidden: !!session.widgetHidden,
    nextAt,
    restored
  };
}

module.exports = { capture, plan, MAX_AGE_MS, GRACE_MS };

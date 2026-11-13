'use strict';
/**
 * 메일 셈하기 — «무엇이 새로 왔나»와 «무엇을 다시 해볼까».
 *
 * 둘 다 main.js 안에 파묻혀 있던 계산이고, 둘 다 실제로 틀렸었다.
 *   - 통수 뺄셈으로 «새 메일»을 세다가, 규칙을 껐다 켜기만 해도 오지 않은 메일이 왔다고 떴다.
 *   - 실패한 자동 처리에 «했다» 도장을 미리 찍어서, 한 번 실패하면 앱을 끌 때까지 다시
 *     시도하지 않았다. 스팸이면 화면에서는 사라졌는데 서버에는 그대로 남는다.
 *
 * 서버도 화면도 부르지 않는 순수 계산이라, 여기 있으면 시험할 수 있다.
 */

/** 메일 하나를 가리키는 열쇠 — uid는 계정마다 따로 도니까 계정을 붙여야 한다 */
function keyOf(msg) {
  return `${msg.accountId || ''}:${msg.uid}`;
}

/**
 * 이번에 «새로 온» 메일이 몇 통인가.
 *
 * 통수의 차이가 아니라 «지난번에 없던 열쇠»를 센다. 그래야 규칙을 바꿔 숫자가
 * 출렁여도 알림이 거짓말을 하지 않는다.
 *
 * @param messages 이번에 받아온 전체 목록
 * @param known    지난번에 본 열쇠들 (Set). null이면 «아직 한 번도 안 봤다» —
 *                 이때는 0을 돌려준다. 앱을 켤 때마다 쌓여 있던 메일이 전부
 *                 «새 메일»이 되면 안 된다.
 * @param quiet    규칙이 조용히 시킨 열쇠들 (숨김·스팸·알림 안 함)
 * @param tops     이번 판의 경계 (boundsFor). 주면 경계 위의 메일만 센다 — 처음 보는 계정은 세지 않는다
 * @returns {{ fresh, known }} fresh = 알릴 통수, known = 다음번에 쓸 열쇠들
 */
function freshCount(messages, known, quiet, tops) {
  const list = messages || [];
  const now = new Set(list.map(keyOf));
  if (!known) return { fresh: 0, known: now, primed: false };

  const hush = quiet || new Set();
  let fresh = 0;
  for (const m of list) {
    const k = keyOf(m);
    if (!known.has(k) && !m.seen && !hush.has(k) && (!tops || (tops.has(acctOf(m)) && isNew(tops, m)))) fresh++;
  }
  return { fresh, known: now, primed: true };
}

// ── UID 경계 ─────────────────────────────────────────────
// 목록은 «마지막 N통»이다. 서버 정리가 옛 메일을 옮기면 빠진 만큼 더 옛 메일이 창으로 밀려 들어오고,
// 그 메일은 known 에 없으니 «새 메일»처럼 보인다. 폴링이 한 번 실패한 뒤에도 같다 — 그 계정이 known 에서
// 빠지므로 다음 성공 때 창의 안 읽은 메일이 전부 새 메일이 된다. 지난 메일을 받는 일이 이 길을 넓힌다.
// «지난 성공 폴링 때 서버의 맨 위 UID» 보다 큰 메일만 새로 온 것으로 본다. UID 는 오르기만 하니 믿을 수 있다.

/** 메일의 계정 — 위의 freshCount 도 부르므로 함수 선언으로 둔다 */
function acctOf(msg) {
  return msg.accountId || '';
}

/**
 * 폴링이 성공한 계정의 경계를 적는다. 실패한 계정은 results 에 없으니 그대로 남는다 —
 * 그래야 다음 성공 때 그 사이 온 메일만 새 메일이 된다.
 * @param tops    Map<계정, { top, v }>
 * @param results [{ id, top, uidValidity, messages }] — top 을 모르면(UIDNEXT 를 안 주는 서버) 창의 최댓값을 쓴다
 * @returns 새 Map
 */
function topsAfter(tops, results) {
  const next = new Map(tops || []);
  for (const r of results || []) {
    const prev = next.get(r.id);
    const v = vOf(r, prev);
    const top = r.top > 0 ? r.top : (r.messages || []).reduce((n, m) => Math.max(n, m.uid), 0);
    // 번호가 그대로면 내려가지 않는다 — 창의 최댓값은 안 읽은 메일을 다 읽으면 줄어든다
    next.set(r.id, { top: prev && prev.v === v ? Math.max(prev.top, top) : top, v });
  }
  return next;
}

/** UIDVALIDITY 를 비교할 글로 — 한 번 빠진 답을 «번호가 새로 매겨졌다»로 읽지 않는다 */
function vOf(r, prev) {
  return r.uidValidity == null ? (prev ? prev.v : '') : String(r.uidValidity);
}

/**
 * 이번 판에 쓸 경계 — 장부와 같되, UIDVALIDITY 가 바뀐 계정은 옛 경계로 잴 수 없으니 그 판은 아무것도 넘지 못하게 한다.
 * 번호가 새로 매겨지면 메일함 전체가 known 에 없는 새 UID 라, 그대로 두면 창의 안 읽은 메일이 전부 새 메일이 된다.
 */
function boundsFor(tops, results) {
  const out = new Map(tops || []);
  for (const r of results || []) {
    if (renumbered(tops, r)) out.set(r.id, { ...out.get(r.id), top: Infinity });
  }
  return out;
}

/** 이 계정의 UID 를 서버가 새로 매겼나 — 장부에 처음 적는 계정은 아니다 */
function renumbered(tops, r) {
  const prev = tops && tops.get(r.id);
  return !!prev && prev.v !== vOf(r, prev);
}

/** 경계 위의 메일인가 — 장부에 없는 계정(첫 폴링·새 계정)은 잴 수 없으니 막지 않는다. 그 판을 세지 않는 것은 freshCount 가 한다 */
function isNew(tops, msg) {
  const t = tops && tops.get(acctOf(msg));
  return !t || msg.uid > t.top;
}

// ── 규칙의 바닥 ──────────────────────────────────────────
// 자동 읽음·스팸은 서버를 바꾼다. 창으로 밀려 들어온 옛 메일에 나가면 안 된다 —
// 그래서 규칙을 처음 적용한 판(앱을 켠 뒤 첫 폴링, 규칙을 바꾼 뒤 첫 폴링)의 창까지만 걸리게 한다.

/**
 * 바닥이 없는 계정에 이번 창의 최솟값 UID 를 적는다 (floors 를 그 자리에서 바꾼다).
 * 메일이 없는 계정은 적지 않는다 — 다음에 메일이 보일 때 적는다.
 */
function noteFloors(floors, messages) {
  const low = new Map();
  for (const m of messages || []) {
    const id = acctOf(m);
    if (floors.has(id)) continue;
    low.set(id, Math.min(low.has(id) ? low.get(id) : Infinity, m.uid));
  }
  for (const [id, u] of low) floors.set(id, u);
  return floors;
}

/** 규칙이 이 메일의 서버 쪽을 만져도 되는가 — 바닥을 모르면 안 만진다 */
function aboveFloor(floors, msg) {
  const f = floors.get(acctOf(msg));
  return f !== undefined && msg.uid >= f;
}

/**
 * 서버를 만지는 자동 처리(자동 읽음·스팸)의 «했나 / 다시 할까» 장부.
 *
 * 성공한 것만 «했다»로 적는다. 실패한 것은 시간을 두고 몇 번 더 해보고 그만둔다 —
 * 곧바로 되돌려 놓으면 끝에서 부르는 새로고침과 맞물려 느린 서버를 계속 두드린다.
 */
class WorkLog {
  constructor({ tries = 3, retryMs = 5 * 60_000 } = {}) {
    this.tries = tries;
    this.retryMs = retryMs;
    this.done = new Map();   // 동작 → Set<열쇠>
    this.fail = new Map();   // '동작:열쇠' → { n, at }
  }

  _done(action) {
    if (!this.done.has(action)) this.done.set(action, new Set());
    return this.done.get(action);
  }

  /** 지금 이 메일에 손을 대도 되는가 */
  ready(action, key, now = Date.now()) {
    if (this._done(action).has(key)) return false;
    const f = this.fail.get(action + ':' + key);
    if (!f) return true;
    return f.n < this.tries && now - f.at >= this.retryMs;
  }

  /** 해볼 것만 골라낸다 */
  pick(action, messages, now = Date.now()) {
    return (messages || []).filter((m) => this.ready(action, keyOf(m), now));
  }

  /** 서버가 받아줬다 */
  ok(action, keys) {
    for (const k of keys) {
      this._done(action).add(k);
      this.fail.delete(action + ':' + k);
    }
  }

  /** 안 됐다. @returns 이번이 몇 번째 실패인지와, 그만둘 때가 됐는지 */
  bad(action, keys, now = Date.now()) {
    let n = 0;
    for (const k of keys) {
      const f = this.fail.get(action + ':' + k) || { n: 0, at: 0 };
      n = f.n + 1;
      this.fail.set(action + ':' + k, { n, at: now });
    }
    return { n, giveUp: n >= this.tries };
  }

  /** 규칙이 바뀌었다 — 지금까지의 판단을 전부 버린다 */
  clear() {
    this.done.clear();
    this.fail.clear();
  }
}

module.exports = { keyOf, freshCount, topsAfter, boundsFor, renumbered, isNew, noteFloors, aboveFloor, WorkLog };

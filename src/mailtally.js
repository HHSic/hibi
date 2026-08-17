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
 * @returns {{ fresh, known }} fresh = 알릴 통수, known = 다음번에 쓸 열쇠들
 */
function freshCount(messages, known, quiet) {
  const list = messages || [];
  const now = new Set(list.map(keyOf));
  if (!known) return { fresh: 0, known: now, primed: false };

  const hush = quiet || new Set();
  let fresh = 0;
  for (const m of list) {
    const k = keyOf(m);
    if (!known.has(k) && !m.seen && !hush.has(k)) fresh++;
  }
  return { fresh, known: now, primed: true };
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

module.exports = { keyOf, freshCount, WorkLog };

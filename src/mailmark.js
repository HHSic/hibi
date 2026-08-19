'use strict';
/**
 * 읽음 상태 임시 장부 — 서버가 대답하기 전에도 화면이 맞게 보이도록.
 *
 * 이 서버는 읽음 표시 두 통에 88초가 걸린 적이 있다. 그동안 화면이 옛 상태를
 * 들고 있으면 «눌렀는데 안 되네»가 된다. 그래서 사용자가 바꾼 값을 여기 적어두고,
 * 목록·뱃지·메일 보기 창이 전부 이 값을 덮어 쓴 뒤에 그린다.
 *
 * 핵심은 «언제 잊을까»다. 영원히 들고 있으면 화면이 서버와 다른 거짓말을 계속하게 된다.
 *   - 서버가 같은 값을 말하기 시작하면 → 그 즉시 잊는다 (이제 진짜가 됐다)
 *   - 실패했으면 → 부르는 쪽이 곧바로 지운다
 *   - 그 무엇도 아닌 채 시간이 지나면 → 잊는다. 조용히 실패했거나 웹메일에서
 *     누가 바꿨을 수 있다. 오래된 추측보다 서버가 낫다.
 *
 * 서버도 화면도 부르지 않는 순수 계산이라, 여기 있으면 시험할 수 있다.
 */

/**
 * 메일 하나를 가리키는 열쇠.
 * UID는 폴더마다 따로 도니까 폴더까지 넣어야 한다 — 안 그러면 보낸메일함 12번을
 * 읽음으로 바꿨을 때 받은편지함 12번까지 읽음으로 보인다.
 */
function markKey(msg) {
  return `${(msg && msg.accountId) || ''}:${(msg && msg.mailbox) || 'INBOX'}:${msg && msg.uid}`;
}

class SeenMarks {
  /**
   * @param ttlMs 서버가 끝내 인정하지 않으면 이만큼 뒤에 포기한다
   * @param max   장부가 무한히 자라지 않게 (목록 밖으로 밀려난 것은 확인할 길이 없다)
   */
  constructor({ ttlMs = 10 * 60_000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.marks = new Map();   // 열쇠 → { seen, at }
  }

  get size() { return this.marks.size; }

  /** 사용자가 방금 바꿨다 */
  mark(msg, seen, now = Date.now()) {
    const k = markKey(msg);
    this.marks.set(k, { seen: !!seen, at: now });
    // 가장 오래된 것부터 버린다 (Map은 넣은 순서를 지킨다)
    while (this.marks.size > this.max) {
      this.marks.delete(this.marks.keys().next().value);
    }
    return k;
  }

  /** 여러 통을 한 번에 */
  markAll(list, seen, now = Date.now()) {
    for (const m of list || []) this.mark(m, seen, now);
  }

  /** 실패했다 — 추측을 즉시 버린다. 바뀐 척하면 안 된다. */
  unmark(msg) { this.marks.delete(markKey(msg)); }
  unmarkAll(list) { for (const m of list || []) this.unmark(m); }

  /** 오래된 것 버리기 — 목록에 안 나타나는 메일은 이 길로만 잊힌다 */
  sweep(now = Date.now()) {
    for (const [k, v] of this.marks) {
      if (now - v.at > this.ttlMs) this.marks.delete(k);
    }
  }

  /** 창 하나를 열 때 쓸 값 — 장부에 있으면 그것이, 없으면 서버 값이 */
  seenOf(msg, fallback) {
    const v = this.marks.get(markKey(msg));
    return v ? v.seen : !!fallback;
  }

  /**
   * 목록에 덮어씌운다.
   *
   * 원본을 고치지 않고 사본을 돌려준다 — 부르는 쪽이 같은 배열을 다시 쓰는 일이 있다.
   * 서버가 이미 같은 말을 하고 있으면 그 자리에서 장부를 지운다.
   *
   * @returns {{ messages, delta, pending }}
   *   delta   안읽음 수 보정값 (읽음으로 바꾼 만큼 줄고, 되돌린 만큼 는다)
   *   pending 아직 서버가 인정 안 한 통수
   */
  apply(messages, now = Date.now()) {
    this.sweep(now);
    if (!this.marks.size) return { messages: messages || [], delta: 0, pending: 0 };

    let delta = 0;
    let pending = 0;
    const out = [];
    for (const msg of messages || []) {
      const k = markKey(msg);
      const v = this.marks.get(k);
      if (!v) { out.push(msg); continue; }
      if (!!msg.seen === v.seen) {
        // 서버가 따라왔다 — 이제 진짜다
        this.marks.delete(k);
        out.push(msg);
        continue;
      }
      // 아직 서버는 옛 값을 말한다. 사용자가 본 것을 지킨다.
      pending++;
      delta += v.seen ? -1 : 1;
      out.push({ ...msg, seen: v.seen, seenPending: true });
    }
    return { messages: out, delta, pending };
  }

  clear() { this.marks.clear(); }
}

module.exports = { markKey, SeenMarks };

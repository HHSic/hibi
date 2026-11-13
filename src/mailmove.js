'use strict';
/**
 * 서버에서 메일을 다른 폴더(휴지통·스팸)로 옮긴다 — 서버 정리·휴지통 단추·스팸 규칙이 함께 쓴다.
 *
 * MOVE 가 있으면 UID MOVE 한 번. 없으면 «복사 → 복사 증명 → 일지 → 지움 표시 → 정확히 그것만 지우기».
 * imapflow 의 messageMove 는 MOVE 가 없으면 COPY 결과를 보지 않고 지운다(commands/move.js) — 복사가 실패해도
 * 원본이 사라진다. 그 길은 쓰지 않고 연결에서 막는다. 원본은 복사가 증명된 뒤에만 지운다.
 * 휴지통에 같은 메일이 두 통 생기는 것은 받아들이고, 잃는 것은 받아들이지 않는다.
 *
 * 연결에서 쓰는 것: capabilities·enabled·mailbox·usable, search(), status(), messageMove()(MOVE 일 때만),
 * run('COPY'), run('STORE'), IMAP 명령 보내기(EXPUNGE / UID EXPUNGE). 공개 messageCopy·messageDelete·messageFlags* 는
 * 부르지 않는다 — imapflow 의 run('EXPUNGE')도 안에서 messageFlagsAdd 를 불러서 쓰지 않는다.
 *
 * 일지(userData/mail-move.json — main.js 가 정한다): 지움 표시를 보내기 전에 디스크에 적는다. STORE 와 EXPUNGE 사이에
 * 끊기면 다음 번에 그 표시를 푼다 — 원본과 휴지통 복사본이 둘 다 남을 뿐 잃지 않는다. 서버 탓으로 되풀이될 실패를 낸
 * 계정(blocked)과 복사 길을 끝까지 해 본 계정(trusted)도 여기 적는다. 정하지 않으면 메모리에만 둔다 (시험).
 *
 * Electron 을 쓰지 않는다 — 가짜 IMAP 클라이언트로 node 에서 바로 시험한다 (test/mailmove.test.js).
 */
const fs = require('fs');

const CHUNK = 100;            // 한 번에 옮기는 UID 수 (mail.js FLAG_CHUNK·mailtidy CHUNK 와 같은 까닭 — 느린 서버가 답 전에 끊는다)
const JOURNAL_FILE = 'mail-move.json';
const PENDING_MAX = 2000;     // 일지에 남기는 묶음 수 — 끊김이 쌓여도 파일이 커지지 않게
// IMAP4rev2 에는 이 기능들이 기본으로 들어 있다 (imapflow tools.hasCapability 와 같은 판단)
const REV2_HAS = new Set(['MOVE', 'UIDPLUS', 'SPECIAL-USE']);
// 기록에 싣는 능력 이름 — 서버가 이상한 글을 넣어도 주소·비밀이 섞이지 않게 모양을 묶는다
const SAFE_CAP = /^[A-Za-z0-9][A-Za-z0-9=+\-._]{0,39}$/;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function has(client, cap) {
  const caps = client && client.capabilities;
  if (!caps || typeof caps.has !== 'function') return false;
  if (caps.has(cap)) return true;
  if (!REV2_HAS.has(cap)) return false;
  const enabled = client.enabled && typeof client.enabled.has === 'function' ? client.enabled : null;
  return (!!enabled && enabled.has('IMAP4REV2')) || (caps.has('IMAP4rev2') && !caps.has('IMAP4rev1'));
}
const canMove = (client) => has(client, 'MOVE');
const hasUidPlus = (client) => has(client, 'UIDPLUS');

/**
 * 기록·설정 화면에 싣는 «서버 기능» 한 줄. 능력 이름은 안전한 모양만 40개까지, 서버 ID 는 이름·판만.
 * 호스트·아이디·비밀번호는 넣지 않는다 — 사용자가 이 줄을 그대로 옮겨 알려 줄 수 있게.
 */
function capsLine(client) {
  const caps = client && client.capabilities;
  const names = caps && typeof caps.keys === 'function'
    ? [...caps.keys()].map(String).filter((x) => SAFE_CAP.test(x)).slice(0, 40) : [];
  const yn = (b) => (b ? '있음' : '없음');
  const parts = [`옮기기(MOVE) ${yn(canMove(client))}`, `UIDPLUS ${yn(hasUidPlus(client))}`,
    `용도 표시(SPECIAL-USE) ${yn(has(client, 'SPECIAL-USE') || has(client, 'XLIST'))}`];
  if (names.length) parts.push(names.join(' '));
  const id = client && client.serverInfo;
  const clean = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const who = id && typeof id === 'object' ? [clean(id.name), clean(id.version)].filter(Boolean).join(' ') : '';
  if (who) parts.push(`서버 ${who}`);
  return parts.join(' · ');
}

/** [1000,1001,1002,1005] → '1000:1002,1005'. 1 이상 정수만 */
function pack(uids) {
  const s = [...new Set((uids || []).map((x) => (x == null ? NaN : Number(x))))]
    .filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}:${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

/** imapflow tools.canUseFlag 와 같다 — PERMANENTFLAGS 에 없으면 imapflow 는 STORE 를 보내지도 않는다 */
function canFlag(mailbox, flag) {
  const p = mailbox && mailbox.permanentFlags;
  return !p || typeof p.has !== 'function' || p.has('\\*') || p.has(flag);
}

const goodV = (v) => /^[1-9]\d*$/.test(String(v));

/**
 * imapflow 의 대체 경로를 연결에서 막는다. move.js 는 연결의 공개 messageCopy·messageDelete 를 부르므로
 * 여기서 던지면 첫 COPY 에서 멈춘다 — 누가 messageMove 를 불러도 MOVE 없는 서버에서 원본이 사라지지 않는다.
 */
function guardFallback(client) {
  if (client.mmGuarded) return client;
  for (const k of ['messageCopy', 'messageDelete']) {
    client[k] = async () => { throw new Error(`옮기기는 ${k}을 쓰지 않습니다 (MOVE 대체 경로 막음)`); };
  }
  client.mmGuarded = true;
  return client;
}

// ── 일지 ──

const blank = () => ({ pending: [], blocked: {}, trusted: {} });

/** 읽은 일지를 다듬는다 — 모양이 틀린 줄은 버린다 (엉뚱한 UID 의 표시를 풀지 않게) */
function cleanState(j) {
  const st = blank();
  if (!j || typeof j !== 'object') return st;
  for (const e of Array.isArray(j.pending) ? j.pending : []) {
    if (!e || typeof e.acc !== 'string' || typeof e.box !== 'string' || !goodV(e.v)) continue;
    const uids = (Array.isArray(e.uids) ? e.uids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (uids.length) st.pending.push({ acc: e.acc, box: e.box, v: String(e.v), uids, at: Number(e.at) || 0 });
  }
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  for (const [k, v] of Object.entries(obj(j.blocked))) {
    if (v && typeof v.why === 'string') st.blocked[k] = { why: v.why.slice(0, 200), at: Number(v.at) || 0 };
  }
  for (const [k, v] of Object.entries(obj(j.trusted))) if (Number(v) > 0) st.trusted[k] = Number(v);
  return st;
}

/**
 * 파일이 없으면 빈 일지. 깨졌으면 .broken 으로 비켜 두고 빈 일지 (onBroken 으로 알린다 — 기록에 남기게).
 * 깨진 일지에 있던 내 지움 표시는 아무도 풀지 않는다: UIDPLUS 가 없는 서버에서는 «남의 표시»로 보여 그 폴더를 건너뛰고,
 * UIDPLUS 서버에서는 표시가 남은 채 옮기기가 이어진다 (다른 프로그램이 지우기를 하면 원본이 사라진다 — 휴지통에 복사본은 있다).
 * 그 밖의 읽기 실패(백신·동기화 프로그램이 잠깐 잡음)는 null — 빈 일지로 보고 쓰면 남은 표시·멈춘 계정을 덮어쓴다
 */
function loadFile(file, onBroken) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? blank() : null;
  }
  try { return cleanState(JSON.parse(raw)); } catch {
    let moved = false;
    try { fs.renameSync(file, `${file}.broken`); moved = true; } catch { /* 못 비키면 다음 쓰기가 덮는다 */ }
    if (typeof onBroken === 'function') {
      try { onBroken(moved); } catch { /* 알리기 실패는 일지와 상관없다 */ }
    }
    return blank();
  }
}

/** 임시 파일에 쓰고 바꿔치기한다 (mailtidy.saveMoved 와 같은 방식). 못 쓰면 던진다 */
async function writeAtomic(file, body) {
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, file);
  } catch {
    // 백신·동기화 프로그램이 원본을 잠깐 잡고 있으면 바꿔치기가 막힌다 — 직접 써 본다
    await fs.promises.writeFile(file, body);
    try { await fs.promises.unlink(tmp); } catch { /* 남아도 읽지 않는다 */ }
  }
}

/**
 * 일지. file 이 없으면 메모리에만 둔다. 쓰기는 차례로 — 두 계정이 함께 써도 임시 파일이 겹치지 않게.
 * add 만 실패를 던진다 (그러면 지움 표시를 보내지 않는다). 나머지는 메모리에 남겨 이번 실행 동안은 지킨다.
 * 파일을 잠깐 못 읽으면(없는 것도 깨진 것도 아니다) 빈 일지로 덮어쓰지 않는다 — ready() 가 거짓이고 add 는 던진다.
 * 부를 때마다 다시 읽어 보고, 읽히면 그동안 바꾼 것(멈춤·풀기·믿음)을 읽은 내용 위에 다시 한 뒤 쓴다
 */
function makeJournal(file = null, { onBroken = null } = {}) {
  const first = file ? loadFile(file, onBroken) : blank();
  let st = first || blank();
  let unread = !first;
  const missed = [];
  let chain = Promise.resolve();
  const save = () => {
    if (!file) return Promise.resolve();
    if (unread) return Promise.reject(new Error('옮기기 일지를 읽지 못해 쓰지 않았습니다'));
    const body = JSON.stringify({ v: 1, ...st });
    const p = chain.then(() => writeAtomic(file, body));
    chain = p.catch(() => {});
    return p;
  };
  const quiet = () => save().catch(() => {});
  const retry = () => {
    if (!unread) return;
    const got = loadFile(file, onBroken);
    if (!got) return;
    for (const op of missed.splice(0)) op(got);
    st = got;
    unread = false;
    quiet();
  };
  /** 바꾸기 — 못 읽는 동안이면 기억해 두었다가 읽힌 내용 위에 다시 한다 */
  const change = (op) => {
    retry();
    op(st);
    if (unread) missed.push(op);
  };
  return {
    file,
    /** 쓸 수 있나 — 못 읽은 일지에는 지움 표시를 적을 수 없고, 멈춘 계정·남은 표시도 모른다 */
    ready: () => { retry(); return !unread; },
    pending: (acc, box) => { retry(); return st.pending.filter((e) => e.acc === acc && e.box === box).map((e) => ({ v: e.v, uids: [...e.uids] })); },
    pendingBoxes: (acc) => { retry(); return [...new Set(st.pending.filter((e) => e.acc === acc).map((e) => e.box))]; },
    async add(acc, box, v, uids) {
      retry();
      if (unread) throw new Error('옮기기 일지를 읽지 못해 적지 않았습니다');
      const e = { acc, box, v: String(v), uids: [...uids], at: Date.now() };
      st.pending.push(e);
      if (st.pending.length > PENDING_MAX) st.pending.splice(0, st.pending.length - PENDING_MAX);
      try { await save(); } catch (x) {
        st.pending = st.pending.filter((y) => y !== e);
        throw x;
      }
    },
    async remove(acc, box, uids) {
      const drop = new Set(uids);
      let changed = false;
      change((s) => {
        for (const e of s.pending) {
          if (e.acc !== acc || e.box !== box) continue;
          const n = e.uids.length;
          e.uids = e.uids.filter((u) => !drop.has(u));
          if (e.uids.length !== n) changed = true;
        }
        s.pending = s.pending.filter((e) => e.uids.length);
      });
      if (changed) await quiet();
    },
    /** UIDVALIDITY 가 바뀐 폴더의 줄 — 그 UID 는 이제 다른 메일이다 */
    async dropStale(acc, box, v) {
      let changed = false;
      change((s) => {
        const n = s.pending.length;
        s.pending = s.pending.filter((e) => !(e.acc === acc && e.box === box && e.v !== String(v)));
        if (s.pending.length !== n) changed = true;
      });
      if (changed) await quiet();
    },
    blocked: (acc) => { retry(); return own(st.blocked, acc) ? st.blocked[acc].why : null; },
    async block(acc, why) {
      const b = { why: String(why || '').slice(0, 200), at: Date.now() };
      change((s) => { s.blocked[acc] = { ...b }; });
      await quiet();
    },
    /** @returns 멈춰 있었나 */
    async unblock(acc) {
      retry();
      if (!own(st.blocked, acc)) return false;
      change((s) => { delete s.blocked[acc]; });
      await quiet();
      return true;
    },
    trusted: (acc) => { retry(); return own(st.trusted, acc); },
    async trust(acc) {
      const at = Date.now();
      change((s) => { s.trusted[acc] = at; });
      await quiet();
    },
    dump: () => JSON.parse(JSON.stringify({ v: 1, ...st }))
  };
}

let current = makeJournal(null);
/**
 * main.js 가 시작할 때 userData/mail-move.json 을 준다. null 이면 메모리 일지.
 * onBroken(비켰나) — 깨진 일지를 .broken 으로 비킬 때 부른다 (기록에 남긴다)
 */
function setJournalFile(file, { onBroken = null } = {}) {
  current = makeJournal(file || null, { onBroken });
  return current;
}
const journal = () => current;
const memJournal = () => makeJournal(null);
const fileJournal = (file, opts) => makeJournal(file, opts);
/** 설정 창의 «다시 해 보기» — 서버 탓으로 멈춘 계정을 다시 자동 일(정리·스팸 규칙)에 넣는다 */
const unblock = (accKey) => current.unblock(String(accKey || ''));
/** { 계정 열쇠: { why, at } } — 설정 화면이 멈춘 계정과 까닭을 보인다 */
const blockedList = () => current.dump().blocked;

// ── 옮기기 ──

/** 계정마다 한 번에 하나 — 정리가 지움 표시를 해 둔 사이 단추가 같은 폴더에서 «남의 표시»를 보지 않게 */
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

const live = (c) => c.usable !== false;

/** 연결이 끊겨 답을 못 받았다 — 서버가 «못 한다»는 뜻이 아니다. 계정을 멈추지 않는다 */
const lostError = () => Object.assign(new Error('연결이 끊겼습니다'), { lost: true });

/** imapflow 의 run 이 «연결 없음»으로 던졌나 — 소켓이 이미 닫혀 명령을 보내기 전에 던진 것이다 */
const notSent = (e) => !!e && (e.code === 'NoConnection' || e.code === 'EConnectionClosed'
  || /Connection not available|Connection closed/i.test(String(e.message || '')));

async function searchUids(client, q) {
  const s = await client.search(q, { uid: true });
  if (!Array.isArray(s)) {
    // imapflow 의 search 는 명령 중에 끊기면 던지지 않고 false 를 준다 — 서버가 검색을 거절한 것과 가른다
    if (!live(client)) throw lostError();
    throw new Error('서버가 검색에 답하지 않았습니다');
  }
  return s.map(Number);
}

/**
 * 대상 폴더의 { uidNext, messages } — 연결은 사는데 UIDNEXT 를 못 받으면 null. 끊겼으면 던진다.
 * imapflow 의 status 는 명령 중에 끊기면 던지지 않고 false 를 준다 — 그것을 «서버가 UIDNEXT 를 안 준다»로 읽으면 계정을 멈추게 된다
 */
async function trashState(client, dest) {
  let st;
  try {
    st = await client.status(dest, { uidNext: true, messages: true });
  } catch (e) {
    if (!live(client)) throw lostError();
    return null;
  }
  if (!st && !live(client)) throw lostError();
  const n = st && Number(st.uidNext);
  if (!(Number.isFinite(n) && n > 0)) return null;
  const m = st.messages == null ? NaN : Number(st.messages);
  return { uidNext: n, messages: Number.isFinite(m) && m >= 0 ? m : null };
}

/**
 * 휴지통이 n통만큼 늘었나 — UIDNEXT 와 메일 수(MESSAGES) 둘 다. UIDNEXT 에 구멍이 있는 서버가 거짓으로 OK 하면 UIDNEXT 만으로는 속는다.
 * 메일 수를 안 주는 서버는 UIDNEXT 만 본다
 */
function grew(before, after, n) {
  if (!before || !after || after.uidNext - before.uidNext < n) return false;
  return before.messages == null || after.messages == null || after.messages - before.messages >= n;
}

/**
 * 서버가 준 까닭 한 토막. imapflow 는 MOVE·COPY 거절을 false 로만 주고 서버 글은 log.warn 에만 남긴다 —
 * mail.connect 가 그것을 lastWarn 에 붙여 둔다
 */
function reasonOf(e) {
  if (!e) return '';
  // mail.js 가 이 모듈을 부른다 — 순환이라 쓸 때 싣는다
  const f = String(require('./mail').friendly(e) || '').replace(/^서버가 거절했습니다 — /, '');
  return f && f !== 'Command failed' ? ` — ${f}` : '';
}

/** 지움 표시를 푼다. 풀었으면 일지에서도 뺀다 */
async function unflag(client, uids, ctx) {
  if (!uids.length) return true;
  let done = false;
  try {
    done = await client.run('STORE', pack(uids), ['\\Deleted'], { uid: true, operation: 'remove', silent: true });
  } catch { done = false; }
  if (done) await ctx.journal.remove(ctx.accKey, client.mailbox.path, uids);
  return !!done;
}

/** 지우기 명령 — run() 처럼 IDLE 을 먼저 멈춘다. uidSet 이 있으면 그 UID 만 (UIDPLUS) */
async function expungeCmd(client, uidSet) {
  clearTimeout(client.idleStartTimer);
  if (typeof client.preCheck === 'function') await client.preCheck();
  const imapCommand = client.exec.bind(client);
  const r = uidSet
    ? await imapCommand('UID EXPUNGE', [{ type: 'SEQUENCE', value: uidSet }])
    : await imapCommand('EXPUNGE', false);
  if (r && typeof r.next === 'function') r.next();
  return true;
}

/**
 * 이 폴더에 지난번 끊겨 남은 «내» 지움 표시를 푼다 (같은 UIDVALIDITY 일 때만 — 아니면 UID 가 다른 메일이다).
 * 끝내지(지우지) 않고 푸는 까닭: 그 사이 사용자가 휴지통을 비웠을 수 있다. 원본이 남고 복사본이 하나 더 있을 뿐이다.
 */
async function settleIn(client, ctx) {
  const boxPath = client.mailbox.path;
  const v = String(client.mailbox.uidValidity);
  // 이번 답에 UIDVALIDITY 가 없다 — 그 한 번으로 «바뀌었다»고 보고 줄을 버리면 남은 내 표시를 아무도 풀지 않는다. 다음 답을 기다린다
  if (!goodV(v)) return { undone: 0 };
  const items = ctx.journal.pending(ctx.accKey, boxPath);
  if (!items.length) return { undone: 0 };
  if (items.some((e) => e.v !== v)) await ctx.journal.dropStale(ctx.accKey, boxPath, v);
  const mine = [...new Set(items.filter((e) => e.v === v).flatMap((e) => e.uids))];
  if (!mine.length) return { undone: 0 };
  const still = await searchUids(client, { uid: pack(mine), deleted: true });
  const gone = mine.filter((u) => !still.includes(u));
  if (gone.length) await ctx.journal.remove(ctx.accKey, boxPath, gone);
  if (still.length && !(await unflag(client, still, ctx))) {
    throw new Error('지난번에 남은 지움 표시를 풀지 못해 이 폴더에서는 옮기지 않았습니다');
  }
  return { undone: still.length };
}

/** 쓰기 모드로 연 지금 폴더의 남은 내 표시를 푼다 — 서버 정리가 후보를 고르기 전에 부른다 (후보 검색은 \Deleted 를 뺀다) */
function settle(client, { accKey, journal: j } = {}) {
  const ctx = { accKey: String(accKey || ''), journal: j || current };
  return withLock(ctx.accKey, () => settleIn(client, ctx));
}

/** MOVE 길 — 지금과 같다. 옮긴 뒤 폴더에 남은 것을 다시 물어 센다 (COPYUID 는 믿지 않는다) */
async function viaMove(client, uids, dest, ctx, out) {
  let r;
  let err = null;
  client.lastWarn = null;
  ctx.sent = true;
  try { r = await client.messageMove(uids, dest, { uid: true }); } catch (e) { r = false; err = e; }
  if (!r && !live(client)) {
    out.unsure = '옮기는 중에 연결이 끊겨';
    out.kept = uids;
    out.error = '옮기는 중에 연결이 끊겨 옮겨졌는지 모릅니다';
    return out;
  }
  const why = r ? '' : reasonOf(err || client.lastWarn);
  let stayed = null;
  try {
    const s = await searchUids(client, { uid: pack(uids) });
    stayed = uids.filter((u) => s.includes(u));
  } catch { stayed = null; }
  if (!stayed) {
    if (!r) {
      out.unsure = '서버가 옮기기에 제대로 답하지 않아';
      out.kept = uids;
      out.error = '서버가 옮기기에 제대로 답하지 않아 옮겨졌는지 모릅니다';
      return out;
    }
    // 못 물으면 다 옮긴 것으로 센다 — 상한은 줄이는 쪽, 열쇠는 남기는 쪽이 안전하다
    out.moved = uids;
    return out;
  }
  out.moved = uids.filter((u) => !stayed.includes(u));
  out.left = stayed;
  if (!r) out.error = `서버가 옮기기를 거부했습니다${out.moved.length ? ` (${out.moved.length}통만 옮겨짐)` : ''}${why}`;
  return out;
}

/**
 * 복사 길 — MOVE 가 없는 서버. 순서:
 *  0) 지난번 남은 내 지움 표시 풀기   1) \Deleted 를 저장 못 하는 폴더면 멈춤
 *  2) (UIDPLUS 없음) 남의 지움 표시가 있으면 이 폴더는 건너뜀 + 지금 있는 UID 확인   3) 휴지통 UIDNEXT·메일 수
 *  4) UID COPY   5) 증명: COPYUID 가 그 UID 를 덮고 휴지통도 그만큼 늘었다 / (UIDPLUS 없음) 휴지통이 통수만큼 늘었다
 *  6) 일지에 적고 UID STORE +FLAGS.SILENT (\Deleted)
 *  7) UIDPLUS: 남의 지움 표시를 세고 그 UID 만 지우기 / 없음: 남의 지움 표시가 새로 생겼는지 다시 보고 폴더 지우기
 *  8) 남은 것을 다시 물어 센다. UIDPLUS 인데 남의 지움 표시가 함께 사라졌으면 멈춘다
 * 여기서 던진 것은 moveUids 가 결과로 바꾼다 — COPY 를 보내기 전이면 left, 보낸 뒤면 kept
 */
async function viaCopy(client, uids, dest, ctx, out) {
  out.how = 'copy';
  const boxPath = client.mailbox.path;
  const v = String(client.mailbox.uidValidity);
  const uidplus = hasUidPlus(client);
  const block = (why) => { out.block = why; out.error = why; };

  // 일지를 못 읽는 동안은 복사도 하지 않는다 — 지움 표시를 적을 수 없고, 멈춘 계정·남은 표시도 모른다
  if (typeof ctx.journal.ready === 'function' && !ctx.journal.ready()) {
    out.left = uids;
    out.halt = true;
    out.error = `옮기기 일지(${JOURNAL_FILE})를 읽지 못해 옮기지 않았습니다`;
    return out;
  }
  const st = await settleIn(client, ctx);
  out.undone = st.undone;
  // 일지는 UIDVALIDITY 로 메일을 가른다 — 모르면 끊긴 뒤 어느 표시를 풀지 알 수 없다
  if (!goodV(v)) {
    out.left = uids;
    block('서버가 이 폴더의 UIDVALIDITY 를 주지 않아 옮기지 않았습니다');
    return out;
  }
  if (!canFlag(client.mailbox, '\\Deleted')) {
    out.left = uids;
    block('이 폴더는 지움 표시(\\Deleted)를 저장하지 않아 옮기지 않았습니다');
    return out;
  }

  let todo = uids;
  if (!uidplus) {
    // 이 서버의 지우기는 폴더 전체의 \Deleted 를 지운다 — 다른 프로그램이 표시만 해 둔 메일까지 지우지 않게, 복사도 하지 않고 비킨다
    const del = await searchUids(client, { deleted: true });
    if (del.length) {
      out.left = uids;
      out.foreign = del.length;
      out.error = `다른 프로그램이 지움 표시만 해 둔 메일 ${del.length}통이 있어 이 폴더에서는 옮기지 않았습니다`;
      return out;
    }
    const s = await searchUids(client, { uid: pack(uids) });
    todo = uids.filter((u) => s.includes(u));
    out.gone = uids.filter((u) => !s.includes(u));
    if (!todo.length) return out;
  }
  // 휴지통 UIDNEXT·메일 수 — UIDPLUS 가 없으면 유일한 증거, 있으면 COPYUID 와 맞대 보는 덧증거 (묶음마다 STATUS 두 번)
  const before = await trashState(client, dest);
  if (!uidplus && !before) {
    out.left = todo;
    block('서버가 휴지통의 상태(UIDNEXT)를 알려 주지 않아 복사를 확인할 수 없습니다 — 옮기지 않았습니다');
    return out;
  }

  let r;
  let threw = null;
  client.lastWarn = null;
  ctx.sent = true;
  try { r = await client.run('COPY', pack(todo), dest, { uid: true }); } catch (e) { r = false; threw = e; }
  if (!r) {
    if (!live(client)) {
      // imapflow 의 run 은 소켓이 이미 닫혔으면 보내기 전에 던진다 — 복사가 나가지 않았으니 복사본이 생겼을 리 없다
      if (notSent(threw)) {
        out.left = todo;
        out.error = '연결이 끊겨 옮기지 않았습니다';
        return out;
      }
      out.unsure = '휴지통으로 복사하는 중에 연결이 끊겨';
      out.kept = todo;
      out.error = '복사하는 중에 연결이 끊겼습니다 — 원본은 그대로이고, 휴지통에 복사본이 생겼을 수 있습니다';
      return out;
    }
    // RFC 3501 6.4.7 — 실패한 COPY 는 대상 폴더를 이전 상태로 되돌려야 한다
    out.left = todo;
    out.error = `서버가 복사를 거부했습니다${reasonOf(client.lastWarn)}`;
    return out;
  }

  let proven = [];
  if (uidplus) {
    const map = r.uidMap instanceof Map ? r.uidMap : null;
    proven = map ? todo.filter((u) => map.has(u)) : [];
    const rest = todo.filter((u) => !proven.includes(u));
    if (rest.length) {
      let s = null;
      try { s = await searchUids(client, { uid: pack(rest) }); } catch (e) { if (!live(client)) throw e; }
      const there = s ? rest.filter((u) => s.includes(u)) : rest;
      out.gone.push(...rest.filter((u) => !there.includes(u)));
      // 남아 있는데 COPYUID 가 덮지 않았다 — 복사됐는지 모른다. 원본은 지우지 않고 열쇠는 남긴다 (다시 복사하지 않게).
      // 알림에 복사본을 꼭 말한다 — 아무 일도 없던 줄 알고 다시 누르면 휴지통에 복사본이 또 생긴다
      out.kept.push(...there);
      if (there.length) {
        block(map ? `서버의 복사 결과(COPYUID)에 ${there.length}통이 빠져 그 원본은 지우지 않았습니다 — 휴지통에 복사본이 생겼습니다`
          : '서버가 복사 결과(COPYUID)를 알려 주지 않아 원본을 지우지 않았습니다 — 휴지통에 복사본이 생겼습니다');
      }
    }
    if (proven.length && before) {
      const after = await trashState(client, dest);
      if (after && !grew(before, after, proven.length)) {
        // COPYUID 는 «복사했다»는데 휴지통이 그만큼 늘지 않았다 — 어느 쪽도 믿지 않는다
        out.kept.push(...proven);
        block('복사 결과(COPYUID)와 휴지통이 맞지 않아 원본을 지우지 않았습니다 — 휴지통을 확인하세요');
        return out;
      }
    }
  } else {
    const after = await trashState(client, dest);
    if (grew(before, after, todo.length)) proven = todo;
    else {
      out.kept = todo;
      block(after ? '복사했다는데 휴지통이 늘지 않아 원본을 지우지 않았습니다 — 휴지통에 복사본이 있는지 확인하세요'
        : '서버가 복사 뒤 휴지통의 상태(UIDNEXT)를 알려 주지 않아 원본을 지우지 않았습니다 — 휴지통에 복사본이 있는지 확인하세요');
      return out;
    }
  }
  if (!proven.length) return out;

  // 지움 표시 «전에» 디스크에 적는다 — 그 뒤 끊기면 다음 번이 이 줄을 보고 표시를 푼다
  try {
    await ctx.journal.add(ctx.accKey, boxPath, v, proven);
  } catch {
    out.kept.push(...proven);
    out.halt = true;
    out.error = '옮기기 일지를 저장하지 못해 원본을 지우지 않았습니다 — 휴지통에 복사본이 있습니다';
    return out;
  }
  let flagged;
  try { flagged = await client.run('STORE', pack(proven), ['\\Deleted'], { uid: true, operation: 'add', silent: true }); } catch { flagged = false; }
  if (!flagged) {
    out.kept.push(...proven);
    if (!live(client)) {
      out.unsure = '휴지통으로 옮기는(복사·지움 표시) 중에 연결이 끊겨';
      out.error = '지움 표시 중에 연결이 끊겼습니다 — 원본은 다음 번에 되돌립니다 (휴지통에 복사본이 있습니다)';
      return out;
    }
    await unflag(client, proven, ctx);
    block('서버가 지움 표시를 거부해 원본을 남겼습니다 — 휴지통에 복사본이 있습니다');
    return out;
  }

  // UIDPLUS — 지우기 앞의 남의 지움 표시. UID 지우기를 폴더 지우기처럼 하는 서버가 그것까지 지우는지 뒤에서 본다 (못 세면 보지 않는다)
  let others = [];
  try {
    if (uidplus) {
      try {
        others = (await searchUids(client, { deleted: true })).filter((u) => !proven.includes(u));
      } catch (e) {
        if (e.lost) throw e;
        others = [];
      }
      await expungeCmd(client, pack(proven));
    } else {
      let del = null;
      try { del = await searchUids(client, { deleted: true }); } catch (e) { if (e.lost) throw e; }
      if (!del) {
        // 확인 검색을 한 번 거절했다 — 서버가 못 한다는 뜻은 아니라 멈추지 않는다. 표시를 풀고 원본을 남긴다
        await unflag(client, proven, ctx);
        out.kept.push(...proven);
        out.error = '지우기 전 확인 검색에 서버가 답하지 않아 원본을 남겼습니다 — 휴지통에 복사본이 있습니다';
        return out;
      }
      const extra = del.filter((u) => !proven.includes(u));
      if (extra.length) {
        // 그 사이 다른 프로그램이 표시했다 — 폴더 지우기가 그 메일까지 지우므로 보내지 않는다
        await unflag(client, proven, ctx);
        out.kept.push(...proven);
        out.foreign = extra.length;
        out.error = `그 사이 다른 프로그램이 지움 표시를 해(${extra.length}통) 원본을 지우지 않았습니다 — 휴지통에 복사본이 있습니다`;
        return out;
      }
      await expungeCmd(client, null);
    }
  } catch {
    if (!live(client)) {
      out.unsure = '휴지통으로 옮기는(복사·지우기) 중에 연결이 끊겨';
      out.kept.push(...proven);
      out.error = '지우는 중에 연결이 끊겼습니다 — 남은 원본은 다음 번에 되돌립니다';
      return out;
    }
    await unflag(client, proven, ctx);
    out.kept.push(...proven);
    block('서버가 지우기를 거부해 원본을 남겼습니다 — 휴지통에 복사본이 있습니다');
    return out;
  }

  let stayed = null;
  try {
    const s = await searchUids(client, { uid: pack(proven) });
    stayed = proven.filter((u) => s.includes(u));
  } catch { stayed = null; }
  // 못 물으면 옮긴 것으로 센다 — 일지는 남겨 다음 번에 남은 표시를 푼다
  if (!stayed) { out.moved.push(...proven); return out; }
  const done = proven.filter((u) => !stayed.includes(u));
  out.moved.push(...done);
  await ctx.journal.remove(ctx.accKey, boxPath, done);
  if (stayed.length) {
    await unflag(client, stayed, ctx);
    out.kept.push(...stayed);
    block(`서버가 ${stayed.length}통을 지우지 않아 원본을 남겼습니다 — 휴지통에 복사본이 있습니다`);
    return out;
  }
  if (others.length) {
    let s = null;
    try { s = await searchUids(client, { uid: pack(others) }); } catch { s = null; }
    const vanished = s ? others.filter((u) => !s.includes(u)) : [];
    if (vanished.length) {
      // 내 UID 만 지우라고 했는데 남의 표시까지 사라졌다 — 이 서버는 폴더째 지운다. 더 옮기면 또 지운다
      block(`다른 프로그램이 지움 표시만 해 둔 메일 ${vanished.length}통까지 서버가 지웠습니다 — 이 서버에서는 옮기기를 멈춥니다`);
      return out;
    }
  }
  // 한 묶음이 처음부터 끝까지 됐다 — 이 계정은 다음부터 한 번에 옮긴다
  if (!out.block && !out.kept.length && !ctx.journal.trusted(ctx.accKey)) await ctx.journal.trust(ctx.accKey);
  return out;
}

/**
 * 옮기는 중에 던진 것을 결과로 바꾼다 — 부르는 쪽(정리)은 미리 적은 열쇠를 결과를 보고 지우거나 남긴다.
 * 던지면 그 열쇠가 남아 그 메일은 «되찾음»으로 영영 정리되지 않는다.
 * COPY·MOVE 를 보내기 전이면 아무것도 안 됐다(left). 보낸 뒤면 복사본이 있을 수 있다(kept, 끊겼으면 unsure).
 * 끊김이나 한 번의 거절은 서버가 못 한다는 뜻이 아니라 멈추지(block) 않는다
 */
function asResult(client, list, out, ctx, e) {
  const done = new Set([...out.moved, ...out.gone]);
  if (!ctx.sent) {
    out.left = list.filter((u) => !done.has(u));
    out.kept = [];
    out.error = live(client) ? String((e && e.message) || '옮기지 못했습니다') : '연결이 끊겨 옮기지 않았습니다';
    return out;
  }
  const kept = new Set(out.kept);
  out.kept = [...kept, ...list.filter((u) => !done.has(u) && !kept.has(u))];
  out.left = [];
  if (!live(client)) {
    out.unsure = '휴지통으로 옮기는 중에 연결이 끊겨';
    out.error = '옮기는 중에 연결이 끊겼습니다 — 원본은 그대로이고, 휴지통에 복사본이 생겼을 수 있습니다';
  } else {
    out.error = `${String((e && e.message) || '옮기지 못했습니다')} — 휴지통에 복사본이 있을 수 있습니다`;
  }
  return out;
}

/**
 * 지금 쓰기 모드로 열린 폴더의 UID 들을 dest 로 옮긴다 (한 묶음, CHUNK 이하). UID 를 받은 뒤에는 던지지 않는다 — 결과로 말한다.
 * @returns { how, moved, left, kept, gone, unsure, error, block, foreign, undone, halt }
 *   moved — 원본이 사라졌고 (복사 길이면) 복사가 증명됐다
 *   left  — 복사도 옮기기도 안 됐다 (확실) → 부르는 쪽은 미리 적은 열쇠를 지워도 된다
 *   kept  — 원본이 남았지만 복사본이 있거나 있을 수 있다 → 열쇠를 남긴다 (다시 복사하지 않게)
 *   unsure — 끊겨서 옮겨졌는지 모른다. 거짓이 아니면 «…중에 연결이 끊겨» 한 토막이다
 *   block — 서버 탓으로 되풀이될 실패의 까닭. 자동 일(정리·스팸 규칙)은 그 계정을 멈춘다
 *   halt  — 일지를 읽거나 쓰지 못했다 (디스크 탓). 부르는 쪽은 이번 실행을 멈춘다
 */
async function moveUids(client, uids, dest, { accKey, journal: j } = {}) {
  const out = { how: 'move', moved: [], left: [], kept: [], gone: [], unsure: false, error: null, block: null, foreign: 0, undone: 0, halt: false };
  const list = [...new Set((uids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return out;
  if (list.length > CHUNK) throw new Error(`한 번에 ${CHUNK}통까지 옮깁니다`);
  if (!client.mailbox || client.mailbox.readOnly) throw new Error('쓰기 모드로 연 폴더가 없습니다');
  if (!dest || dest === client.mailbox.path) throw new Error('옮길 곳이 지금 폴더와 같습니다');
  guardFallback(client);
  // sent — COPY·MOVE 를 보냈나. 던진 것을 결과로 바꿀 때 left 와 kept 를 가른다
  const ctx = { accKey: String(accKey || ''), journal: j || current, sent: false };
  return withLock(ctx.accKey, async () => {
    try {
      if (canMove(client)) return await viaMove(client, list, dest, ctx, out);
      return await viaCopy(client, list, dest, ctx, out);
    } catch (e) {
      return asResult(client, list, out, ctx, e);
    }
  });
}

/** 묶음 크기 — 복사 길을 끝까지 해 본 적 없는 계정은 1통으로 시험한다 (서버 탓 실패라도 겹치는 복사본이 1통) */
function chunkFor(client, j, accKey) {
  return canMove(client) || (j || current).trusted(String(accKey || '')) ? CHUNK : 1;
}

module.exports = {
  CHUNK, JOURNAL_FILE, canMove, hasUidPlus, capsLine, pack, canFlag, guardFallback,
  memJournal, fileJournal, setJournalFile, journal, unblock, blockedList,
  settle, moveUids, chunkFor, withLock
};

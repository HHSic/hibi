'use strict';
/**
 * 서버 정리 — PC에 저장이 «확인된» 오래된 메일을 서버의 휴지통으로 옮긴다.
 *
 * 메일함이 차서 받기가 막히는 사람을 위한 기능이다. 옮기기만 하고 지우지 않는다.
 * 기간은 받은 지 7·30·90일, 또는 «바로»(0) — 바로는 날짜를 보지 않고 «읽은»(\Seen) 메일만 옮긴다.
 * 안 읽은 메일까지 저장되자마자 사라지면 위젯·폰에서 새 메일을 못 보기 때문이다 (읽고 나면 다음 정리 때 옮긴다).
 * 무엇을 옮겨도 되는지는 아래 까닭들 때문에 하나하나 따져 본다 — 하나라도 불확실하면 남긴다.
 *
 *  - backup-state.json 의 구간(lowUid..lastUid)은 «받았다»는 증거가 되지 못한다.
 *    서버가 원문을 안 준 메일(missing)도 구간은 지나가고, 자동 백업은 처음 본 폴더를
 *    «지금부터»로 표시만 한다(seeded). 그래서 구간이 아니라 실제 파일을 본다.
 *  - 파일 이름의 UID만으로는 같은 메일이라고 할 수 없다. 본문 곳간 키에는 UIDVALIDITY가 없고,
 *    상태 파일이 깨지면 1세대로 다시 시작하고, Windows는 폴더 이름의 대소문자를 가리지 않는다 —
 *    다른 메일이 같은 UID 자리에 놓이는 길이 실제로 있다. 그래서 Message-ID와 Date·From·Subject
 *    원문을 서버와 파일에서 맞대 본다.
 *  - 진짜 삭제(\Deleted + EXPUNGE)는 되돌릴 수 없다. imapflow 는 서버가 MOVE를 모르면
 *    COPY 결과를 보지 않고 곧바로 EXPUNGE한다 — 복사가 실패해도 원본이 사라진다.
 *    그래서 MOVE가 없는 서버는 정리하지 않고, 그 길로 가는 메서드는 연결에서 막아 둔다.
 *  - 쓰기 모드로 연 폴더에서는 CLOSE도 EXPUNGE다. 후보를 고르는 동안은 늘 읽기 전용으로 연다.
 *  - 공유 폴더의 메일을 «내» 휴지통으로 옮기면 동료는 되찾을 길이 없다. 남의 폴더는 열지도 않는다.
 *
 * Electron 을 쓰지 않는다 — 가짜 IMAP 클라이언트로 node 에서 바로 시험한다 (test/mailtidy.test.js).
 */
const fs = require('fs');
const path = require('path');
const mail = require('./mail');
const mailbackup = require('./mailbackup');

// 0 은 «바로» — 받은 지 기간 대신 읽음(\Seen)을 본다. 0이 거짓 값이라 `days || 30` 같은 꼴은 쓰지 않는다
const DAYS = [0, 7, 30, 90];
const DAY_MS = 86_400_000;
const CAP = 300;            // 한 번 실행에서 옮기는 최대 통수 (모든 계정 합) — 버그가 있어도 피해를 이만큼으로 묶는다
const CHUNK = 100;          // 한 명령에 싣는 UID 수 (mail.js FLAG_CHUNK와 같은 까닭 — 느린 서버가 응답 전에 끊는다)
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 4 * 1024;
const TIMEOUT_MS = 90_000;  // mail.js WRITE_TIMEOUT_MS와 같은 값 (그쪽은 export하지 않는다)
// 계정 하나가 쓰는 시간 몫의 바닥 — 명령 하나에 1분 넘게 걸리는 서버도 한 바퀴는 돌 수 있게
const ACCOUNT_MIN_MS = 2 * 60_000;
const MOVED_FILE = 'tidy-moved.json';
const MOVED_MAX = 50_000;   // 약 0.8MB
const HEADS = ['message-id', 'date', 'from', 'subject', 'x-uniform-type-identifier'];
const SAME_HEADS = ['date', 'from', 'subject'];
// 정리하지 않는 폴더 — 임시보관함·전체보관함·별표·중요는 «서버에 남겨 두려고» 있는 곳이다.
// \Important 는 imapflow 의 specialUse 목록에 없어 flags 로만 온다 — 그래서 둘 다 본다.
const NO_TIDY_USE = ['\\Drafts', '\\All', '\\Flagged', '\\Important', '\\Junk', '\\Trash'];
const NO_TIDY_NAME = /^(drafts?|draft items|임시보관함|임시 보관함|임시편지함|임시 편지함|all mail|전체보관함|전체 보관함|starred|별표편지함|별표 편지함|important|중요|중요편지함|중요 편지함|중요메일함|중요 메일함|notes|메모|templates|서식|템플릿|scheduled|예약|예약메일함|예약 메일함|예약편지함|예약 편지함|snoozed|outbox|보낼편지함|보낼 편지함|내게쓴메일함|내게 쓴 메일함|내게쓴편지함|내게 쓴 편지함)$/i;
// NAMESPACE 를 말하지 않는 서버도 있다 — 첫 조각 이름으로 공유 트리를 짐작해 뺀다
const SHARED_ROOT = /^(shared|public|other users|shared folders|public folders|공유|공유 폴더|공유폴더|공용|공용 폴더|공용폴더)$/i;
// 정리 연결에서는 부르지 않는 명령. imapflow 의 대체 경로(COPY + \Deleted + EXPUNGE)는
// 연결 객체의 메서드를 부르므로(runInternal 이 handler(this, …)로 넘긴다) 여기서 막으면 첫 COPY에서 멈춘다.
const FORBIDDEN = ['messageDelete', 'messageCopy', 'messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove',
  'mailboxClose', 'mailboxDelete', 'mailboxRename'];
// 판정 — «확인 안 돼 남김»과 «일부러 남김»을 나눠 센다 (화면이 다르게 말한다)
const UNVERIFIED = new Set(['nofile', 'empty', 'damaged', 'idmismatch', 'sizemismatch', 'headmismatch']);
const SPARED = new Set(['flagged', 'deleted', 'important', 'note', 'recovered']);
const NO_MOVE = '이 서버는 «옮기기»(MOVE)를 지원하지 않아 정리하지 않았습니다';

/**
 * 기간은 0(바로)·7·30·90일 넷뿐이다. 숫자가 아니거나 다른 값이면 기본 30일.
 * 목록의 값을 그대로 돌려준다 — 0을 거짓으로 보고 30으로 바꾸지 않는다 (-0 도 0으로)
 */
function normDays(v) {
  const d = DAYS.find((x) => x === v);
  return d === undefined ? 30 : d;
}

/** Message-ID 비교용 — 공백·꺾쇠·대소문자 차이는 같은 것으로 본다 */
function normId(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').replace(/^</, '').replace(/>$/, '').toLowerCase();
}

/**
 * 헤더 원문에서 HEADS 에 든 이름의 «첫 번째 값»만 꺼낸다.
 * 서버(HEADER.FIELDS)와 파일 양쪽을 같은 함수로 읽어야 접힌 줄·공백 차이가 비교를 흔들지 않는다.
 * @param whole 빈 줄(헤더 끝)이 없을 때 전체를 헤더로 볼지 — 파일 앞부분만 읽었으면 끝이 잘린 것이라 못 믿는다
 * @returns { 이름: 값 } | null (헤더 끝을 못 찾음)
 */
function headerFields(text, { whole = false } = {}) {
  const s = String(text == null ? '' : text);
  const cut = s.search(/\r?\n\r?\n/);
  let head;
  if (cut >= 0) head = s.slice(0, cut);
  else if (whole) head = s;
  else return null;
  const out = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!HEADS.includes(name) || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = line.slice(at + 1).replace(/\s+/g, ' ').trim();
  }
  return out;
}

/**
 * 서버 검색의 BEFORE 날짜.
 * imapflow 는 자정이 아닌 Date에 하루를 더하고(search-compiler), 날짜는 UTC로 적는다(formatDate).
 * (cutoff − 1일)의 UTC 자정을 주면 서버 시간대가 −12h~+14h 어디여도 결과는 모두 cutoff 이전이다.
 * WITHIN이 있으면 imapflow 가 OLDER로 바꾸는데 그때도 이전이다. 받은 뒤 internalDate로 한 번 더 본다.
 */
function searchBefore(cutoff) {
  const d = new Date(cutoff - DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * 내 폴더인지 가르는 함수. 가를 수 없으면 null (그 계정은 정리하지 않는다).
 * imapflow 의 list()는 LIST "" "*" 라 공유·남의 폴더도 같이 온다.
 * 내 namespace 밖의 경로는 imapflow normalizePath 가 개인 접두어를 붙여 다른 폴더로 바꿔 버릴 수도 있다 —
 * 그것도 남의 폴더를 다루지 않는 까닭이다.
 */
function mineOf(client) {
  const ns = (client && client.namespaces) || {};
  const pre = (v) => (Array.isArray(v) ? v : []).map((x) => String((x && x.prefix) || ''));
  const own = pre(ns.personal).filter(Boolean);
  const foreign = [...pre(ns.other), ...pre(ns.shared)];
  const named = foreign.filter(Boolean);
  const bare = foreign.length > named.length;     // 접두어가 빈 공유 namespace (Cyrus 기본 «"" "."»)
  if (bare && !own.length) return null;           // 내 것과 남의 것을 가를 수 없다
  const under = (p, x) => p.startsWith(x) || (x.length > 1 && p === x.slice(0, -1));
  return (b) => {
    const p = String((b && b.path) || '');
    if (named.some((x) => under(p, x))) return false;
    if (SHARED_ROOT.test(p.split((b && b.delimiter) || '/')[0])) return false;   // NAMESPACE가 없는 서버도 이름으로 뺀다
    if (bare) return /^inbox$/i.test(p) || own.some((x) => under(p, x));
    return true;
  };
}

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

/** 정리하지 않는 폴더인가 — 용도 표시·이름·휴지통/스팸 밑 */
function keepsFolder(b, { trash, junk } = {}) {
  const flags = toSet(b.flags);
  if (flags.has('\\Noselect') || flags.has('\\NonExistent')) return true;
  if (NO_TIDY_USE.some((u) => b.specialUse === u || flags.has(u))) return true;
  const p = String(b.path || '');
  const d = b.delimiter || '/';
  const names = [String(b.name || ''), p.split(d).pop()];
  if (names.some((n) => NO_TIDY_NAME.test(n) || mail.BOX_NAMES.trash.test(n) || mail.BOX_NAMES.junk.test(n))) return true;
  for (const x of [trash, junk]) {
    if (!x || !x.path) continue;
    if (p === x.path || p.startsWith(x.path + (x.delimiter || d))) return true;
  }
  return false;
}

/** imapflow tools.hasCapability(c, 'MOVE')와 같은 판단 — IMAP4rev2 에는 MOVE가 기본으로 들어 있다 */
function canMove(client) {
  const caps = client && client.capabilities;
  if (!caps || typeof caps.has !== 'function') return false;
  const enabled = client.enabled && typeof client.enabled.has === 'function' ? client.enabled : new Set();
  return caps.has('MOVE') || enabled.has('IMAP4REV2') || (caps.has('IMAP4rev2') && !caps.has('IMAP4rev1'));
}

/** 정리 연결에서 지우기·복사·플래그·폴더 닫기를 아예 못 하게 한다 (대체 경로가 COPY에서 멈춘다) */
function guard(client) {
  for (const k of FORBIDDEN) {
    client[k] = async () => { throw new Error(`서버 정리는 ${k}을 쓰지 않습니다`); };
  }
  return client;
}

/** 쓸 수 있는 UIDVALIDITY인가 — 서버가 안 주면 백업 기록에 "undefined"가 적힌다 (양쪽이 같아 통과하면 안 된다) */
function goodV(v) {
  return /^[1-9]\d*$/.test(String(v));
}

/** 기록·화면에 나가는 글에서 주소를 가린다 */
function maskAddr(s) {
  return String(s || '').replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '•••@•••');
}

/**
 * 계정을 부르는 이름. 주소는 쓰지 않는다 — 계정을 더할 때 이름 기본값이 주소다(store.addMailAccount).
 */
function labelOf(acc, i) {
  const n = String((acc && acc.name) || '').trim();
  return n && !n.includes('@') ? n.slice(0, 30) : `계정 ${i + 1}`;
}

/**
 * 옮긴 메일의 열쇠 — (계정, 폴더, Message-ID). 본문 곳간 키와 같은 FNV-1a 두 벌.
 * 겹치면 «되찾음»으로 남기는 쪽, 즉 안전한 쪽으로 틀린다.
 */
function movedKey(accKey, boxPath, id) {
  const s = `${accKey || ''}\n${boxPath || ''}\n${id || ''}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return (a.toString(36) + b.toString(36)).padStart(12, '0').slice(-12);
}

/**
 * 옮긴 기록 읽기. 휴지통에서 원래 폴더로 되찾은 메일을 몇 시간 뒤 또 옮기지 않으려고 둔다.
 * 파일이 없으면 빈 기록. 못 읽거나 깨졌으면 던진다 — 그 기록 없이 돌면 되찾은 메일을 다시 옮긴다.
 */
async function loadMoved(dir) {
  let raw;
  try {
    raw = await fs.promises.readFile(path.join(dir, MOVED_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return new Set();
    throw new Error(`정리 기록(${MOVED_FILE})을 읽을 수 없어 정리하지 않았습니다 — ${(e && e.code) || (e && e.message) || e}`);
  }
  let j;
  try { j = JSON.parse(raw); } catch { j = null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.keys)) {
    throw new Error(`정리 기록(${MOVED_FILE})이 깨져 정리하지 않았습니다 — 그 파일을 확인하세요`);
  }
  return new Set(j.keys.map(String));
}

/** 옮긴 기록 쓰기 — 임시 파일에 쓰고 바꿔치기한다. 넘치면 오래된 것부터 버린다 */
async function saveMoved(dir, set) {
  const target = path.join(dir, MOVED_FILE);
  const body = JSON.stringify({ v: 1, keys: [...set].slice(-MOVED_MAX) });
  const tmp = target + '.tmp';
  try {
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, target);
  } catch {
    // 백신·동기화 프로그램이 원본을 잠깐 잡고 있으면 바꿔치기가 막힌다 — 직접 써 본다 (실패하면 던진다)
    await fs.promises.writeFile(target, body);
    try { await fs.promises.unlink(tmp); } catch { /* 남아도 읽지 않는다 */ }
  }
}

/**
 * 옮긴 기록을 새 백업 폴더로 옮겨 적는다 (더하기만 한다).
 * 폴더를 바꾸고 다시 켜도, 예전 폴더 시절에 옮겼다가 휴지통에서 되찾은 메일을 다시 옮기지 않게.
 * 어느 쪽이든 못 읽으면 손대지 않는다 — 새 폴더의 깨진 기록을 덮어쓰면 그 안의 열쇠를 잃는다.
 * @returns 새로 더한 열쇠 수
 */
async function carryMoved(fromDir, toDir) {
  // Windows 는 폴더 이름의 대소문자를 가리지 않는다 — 같은 폴더를 두 번 읽고 쓰지 않게
  const norm = (x) => { const r = path.resolve(x); return process.platform === 'win32' ? r.toLowerCase() : r; };
  if (!fromDir || !toDir || norm(fromDir) === norm(toDir)) return 0;
  let from;
  let to;
  try {
    from = await loadMoved(fromDir);
    to = await loadMoved(toDir);
  } catch {
    return 0;
  }
  const before = to.size;
  for (const k of from) to.add(k);
  if (to.size === before) return 0;
  await saveMoved(toDir, to);
  return to.size - before;
}

const latin1 = (v) => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v == null ? '' : v));

/**
 * «되찾음»을 알아볼 열쇠의 재료. Message-ID 가 있으면 그것, 없으면 크기·Date·From·Subject 원문 —
 * 휴지통에서 되찾아 새 UID 를 받아도 이 넷은 그대로다. Message-ID 만 보면 그것이 없는 메일은
 * 되찾아도 다음 정리 때 또 옮겨진다. 다른 메일과 겹치면 남기는 쪽으로 틀린다.
 */
function recoverId(msg, sh) {
  const sid = normId(msg && msg.envelope && msg.envelope.messageId);
  if (sid) return sid;
  const h = sh || headerFields(latin1(msg && msg.headers), { whole: true }) || {};
  return ['noid', Number(msg && msg.size) || 0, h.date || '', h.from || '', h.subject || ''].join('\n');
}

/**
 * 파일 하나가 서버의 그 메일과 같은가.
 * @returns 'ok' | 판정 코드 | null (열지 못함 — 다음 파일을 본다)
 */
async function checkFile(file, msg, sid, sh) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  try {
    let st;
    try { st = await fh.stat(); } catch { return null; }
    if (!st.isFile() || st.size <= 0) return 'empty';
    const size = st.size;
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const tailLen = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const headText = head.toString('latin1');
    const fields = headerFields(headText, { whole: size <= HEAD_BYTES });
    const cut = headText.search(/\r?\n\r?\n/);
    const headerPart = cut >= 0 ? headText.slice(0, cut) : headText;
    // 전원이 나가 0으로 찬 파일 — 이름은 멀쩡해도 내용이 없다
    if (!fields || headerPart.includes('\0') || tail.every((x) => x === 0)) return 'damaged';
    if (sid) {
      if (normId(fields['message-id']) !== sid) return 'idmismatch';
    } else if (fields['message-id'] || !(Number.isFinite(msg.size) && msg.size > 0 && size === msg.size)) {
      // 서버에 Message-ID가 없으면 크기라도 바이트까지 같아야 한다
      return 'sizemismatch';
    }
    if (SAME_HEADS.some((k) => (fields[k] || '') !== (sh[k] || ''))) return 'headmismatch';
    return 'ok';
  } catch {
    return null;
  } finally {
    try { await fh.close(); } catch { /* 닫기 실패는 판정과 상관없다 */ }
  }
}

/**
 * 한 통을 옮겨도 되는가. 위에서부터 보고, 하나라도 불확실하면 'ok'가 아니다.
 * @param names 그 UID의 파일 경로들 (같은 UID 파일이 둘일 수 있다)
 * @param seenOnly «바로»(0일) — 받은 지 기간은 보지 않고, 서버에서 읽음(\Seen)인 것만 'ok'가 될 수 있다.
 *   서버 검색에도 seen 조건을 주지만 그것만 믿지 않는다 — 조건을 흘려듣는 서버가 있고, 검색과 받아 오기 사이에
 *   «안 읽음»으로 되돌렸을 수도 있다. 날짜를 안 보므로 서버 시계가 앞서 있어(미래 날짜) 생기는 문제도 없다
 * @returns 'ok' | 'gone' | 'young' | 'unread' | SPARED 의 하나 | UNVERIFIED 의 하나
 */
async function verdict(msg, names, { cutoff, seenOnly = false, wasMoved = () => false } = {}) {
  if (!msg) return 'gone';
  if (!seenOnly) {
    // imapflow 는 날짜를 못 읽으면 문자열을 둔다. 잘못된 Date(NaN)도 여기서 걸린다
    const at = msg.internalDate;
    if (!(at instanceof Date) || !(at.getTime() < cutoff)) return 'young';
  }
  const flags = toSet(msg.flags);
  if (flags.has('\\Flagged')) return 'flagged';
  if (flags.has('\\Deleted')) return 'deleted';
  // 안 읽은 메일은 라벨·메모·되찾음·파일보다 먼저 가른다 — «확인 안 됨»(경고)이 아니라 «읽을 때까지 남김»이다.
  // 따로 세는 안 읽음 검색(별표·지움 표시만 뺀다)과 같은 기준이라야 서버가 읽음 조건을 지키든 흘려듣든 수가 같다
  if (seenOnly && !flags.has('\\Seen')) return 'unread';
  // Gmail 은 별표·중요를 라벨로도 붙인다 (X-GM-EXT-1일 때만 imapflow 가 받아 온다)
  const labels = toSet(msg.labels);
  if (labels.has('\\Important') || labels.has('\\Starred')) return 'important';
  const sh = headerFields(latin1(msg.headers), { whole: true }) || {};
  if (String(sh['x-uniform-type-identifier'] || '').toLowerCase() === 'com.apple.mail-note') return 'note';
  const sid = normId(msg.envelope && msg.envelope.messageId);
  if (wasMoved(recoverId(msg, sh))) return 'recovered';
  let last = 'nofile';
  for (const f of names || []) {
    const r = await checkFile(f, msg, sid, sh);
    if (r === 'ok') return 'ok';
    if (r) last = r;
  }
  return last;
}

/**
 * 모든 계정을 정리한다 (dryRun 이면 세기만).
 * 계정 하나가 넘어져도 나머지는 한다. 결과는 opts.into 에 채워 가므로, 중간에 끊겨도 센 데까지 읽힌다.
 * @param opts.budgetMs 이번 실행에 쓸 시간. 주면 계정마다 «남은 시간 ÷ 남은 계정 수»(최소 accountMinMs)만 쓰고
 *   넘으면 그 계정만 끊고 다음 계정으로 간다 — 느린 첫 계정이 시간을 다 써 뒤 계정이 매번 굶지 않게
 * @param opts.days 0(바로)·7·30·90. 0이면 날짜 대신 읽음(\Seen)을 본다 — 안 읽은 것은 res.unread 로만 센다
 * @param opts.inView (acc, 폴더, uid, Message-ID) → 지금 옮기면 안 되는가 — 메일 보기 창에 떠 있거나(Gmail 은 같은 메일이
 *   라벨 폴더에 다른 UID 로도 있어 Message-ID 로도 묻는다), 이 앱에서 방금 «안 읽음»으로 되돌렸다. 그러면 옮기지 않는다(spared) —
 *   보는 중에 서버에서 사라지면 그 창의 휴지통·읽음 단추가 이미 옮겨진 UID 를 만진다
 * @param opts.memo «바로»에서 늘 남김 판정을 받는 메일(Gmail 중요·메모·되찾음·확인 안 됨)을 기억해 두는 곳(Map, 부르는 쪽이 들고 있다).
 *   «바로»는 몇 분마다 돈다 — 그런 메일의 봉투·헤더를 매번 다시 받으면 서버를 두드린다. memoMs 동안은 다시 받지 않고
 *   기억한 판정으로 센다 (옮기지 않는 쪽이라 틀려도 안전하다). 세기만 하기(dryRun)에서는 쓰지 않는다
 */
async function tidyAll(accounts, dir, opts = {}) {
  const {
    days, dryRun = false, cap = CAP,
    shouldStop = () => false,
    accountLive = () => true,
    inView = () => false,
    memo = null,
    memoMs = 0,
    signal,
    budgetMs = 0,
    accountMinMs = ACCOUNT_MIN_MS,
    connect = (acc) => mail.connect(acc, { timeoutMs: TIMEOUT_MS }),
    now = Date.now,
    into
  } = opts;
  const res = Object.assign(into || {}, {
    moved: 0, verified: 0, kept: 0, unsaved: 0, unverified: 0, spared: 0, uncertain: 0, unread: 0,
    skippedBoxes: [], errors: [], accounts: 0, failedAccounts: 0,
    more: false, complete: false, aborted: false, halt: false
  });
  const span = normDays(days);
  // «바로» — 받은 지 기간 대신 읽음을 본다. 안 읽은 메일은 읽을 때까지 서버에 남아 위젯·폰에서 새 메일로 보인다
  const seenOnly = span === 0;
  const cutoff = now() - span * DAY_MS;
  /** 보기 창에 떠 있나 — 부르는 쪽의 실수가 정리를 멈추지 않게 하되, 모르면 옮기지 않는 쪽으로 */
  const viewing = (acc, boxPath, uid, sid) => {
    try { return !!inView(acc, boxPath, uid, sid || ''); } catch { return true; }
  };
  const useMemo = seenOnly && !dryRun && memo instanceof Map && memoMs > 0;
  /** 받아 온 플래그로 지금 옮겨도 되는 읽음 상태인가 — 읽음이고 별표·지움 표시가 없다 */
  const readNow = (f) => !!f && f.has('\\Seen') && !f.has('\\Flagged') && !f.has('\\Deleted');
  /** «바로»가 읽을 때까지 남기는 안 읽은 메일인가 — 따로 세는 안 읽음 검색과 같은 기준 (별표·지움 표시는 뺀다) */
  const unreadNow = (f) => !!f && !f.has('\\Seen') && !f.has('\\Flagged') && !f.has('\\Deleted');
  const aborted = () => !!(signal && signal.aborted);
  // 옮겼는지 모르는 묶음(uncertain)도 상한에서 깎는다 — 실제로 옮겨졌을 수 있다
  const left = () => cap - (dryRun ? res.verified : res.moved + res.uncertain);
  const stopNow = () => shouldStop() || aborted() || res.halt;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;

  // 끊으라면 열린 연결을 닫는다 — 걸린 명령(느린 서버는 한 명령에 1분 넘게 걸린다)이 바로 끝난다
  const open = new Set();
  const onAbort = () => {
    for (const c of open) { try { c.close(); } catch { /* 이미 닫혔다 */ } }
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const state = mailbackup.loadState(dir);
    const moved = await loadMoved(dir);
    /** 열쇠를 더해 저장한다. 못 쓰면 실행 전체를 멈춘다 — 기록 없이 옮기면 되찾은 메일을 다시 옮긴다 */
    const record = async (keys) => {
      if (!keys.length) return;
      for (const k of keys) moved.add(k);
      try {
        await saveMoved(dir, moved);
      } catch {
        res.halt = true;
        throw new Error(`정리 기록(${MOVED_FILE})을 저장하지 못해 멈췄습니다`);
      }
    };
    /** 못 옮긴 것이 확실한 열쇠를 지운다. 못 쓰면 그대로 둔다 — 남기는 쪽으로 틀린다 */
    const forget = async (keys) => {
      if (!keys.length) return;
      for (const k of keys) moved.delete(k);
      try { await saveMoved(dir, moved); } catch { /* 열쇠가 남으면 그 메일을 옮기지 않을 뿐이다 */ }
    };

    const tidyAccount = async (acc, i, share) => {
      const label = labelOf(acc, i);
      const accKey = mailbackup.accountKey(acc);
      const client = connect(acc);
      open.add(client);
      guard(client);
      // 이 계정의 시간 몫을 다 쓰면 연결을 닫는다 — 걸린 명령도 곧 끝나고 다음 계정으로 간다
      let late = false;
      const lateTimer = share > 0 ? setTimeout(() => {
        late = true;
        try { client.close(); } catch { /* 이미 닫혔다 */ }
      }, share) : null;
      const cut = () => aborted() || late;
      const stopHere = () => stopNow() || late;
      try {
        await client.connect();
        if (!canMove(client)) throw new Error(NO_MOVE);
        const mine = mineOf(client);
        if (!mine) throw new Error('내 폴더와 공유 폴더를 구분할 수 없어 정리하지 않았습니다');
        const own = (await client.list() || []).filter(mine);
        // 휴지통은 내 폴더 안에서만 고른다 — 공유 트리의 Trash 로 옮기면 남의 휴지통이다
        const trash = mail.pickBox(own, 'trash');
        if (!trash) throw new Error('휴지통 폴더를 찾지 못해 정리하지 않았습니다');
        const junk = mail.pickBox(own, 'junk');
        const recs = state[accKey] || {};
        const boxes = own.filter((b) => mailbackup.backsUp(b) && !keepsFolder(b, { trash, junk }));

        // UID는 폴더마다 따로 돈다 — 지금 열린 폴더가 그 폴더가 아니면 한 통도 건드리지 않는다
        const sameBox = (b) => {
          if (!client.mailbox || client.mailbox.path !== b.path) {
            throw new Error('열린 폴더가 바뀌어 멈췄습니다');
          }
        };
        // 옮겼는지 모르는 묶음 — 숫자에는 넣지 않되 상태·기록에는 꼭 남긴다 (끊겨 끝날 때도)
        const unsure = (b, n, why) => {
          res.uncertain += n;
          const msg = `${why} 마지막 묶음 ${n}통은 옮겨졌을 수 있습니다 (서버 휴지통에서 확인할 수 있습니다)`;
          // 맨 앞에 둔다 — 상태 줄은 첫 오류 하나만 보이는데, 이것이 사용자가 꼭 알아야 할 것이다
          res.errors.unshift(maskAddr(`${label} · ${b.path}: ${msg}`));
          const e = new Error(msg);
          e.counted = true;
          return e;
        };
        /**
         * UID 들의 플래그만 받는다 (FLAGS — 봉투·헤더보다 훨씬 가볍다). 반복문 안에서는 명령을 보내지 않는다 —
         * 다 받은 뒤에 거른다. 답에 없는 UID 는 그 사이 사라진 것이라 Map 에 없다
         */
        const flagsOf = async (b, uids) => {
          const fl = new Map();
          for (let k = 0; k < uids.length; k += CHUNK) {
            if (stopHere()) break;
            sameBox(b);
            for await (const m of client.fetch(uids.slice(k, k + CHUNK), { uid: true, flags: true }, { uid: true })) {
              if (m && m.uid != null) fl.set(Number(m.uid), toSet(m.flags));
            }
          }
          return fl;
        };

        const moveBox = async (b, rec, ok, idOf, sidOf) => {
          // 쓰기 모드로 여는 것은 여기가 처음이다 (imapflow 는 같은 폴더여도 SELECT를 다시 보낸다)
          const rw = await client.mailboxOpen(b.path, { readOnly: false });
          if (!rw || !goodV(rw.uidValidity) || String(rw.uidValidity) !== String(rec.uidValidity)) {
            res.skippedBoxes.push(b.path);
            return;
          }
          if (rw.path === trash.path || (junk && rw.path === junk.path)) return;
          if (rw.readOnly) throw new Error('이 폴더는 읽기 전용으로만 열립니다');
          for (let k = 0; k < ok.length; k += CHUNK) {
            if (stopHere()) { res.more = true; break; }
            if (!accountLive(acc)) break;
            sameBox(b);
            const part = ok.slice(k, k + CHUNK);
            // 고른 뒤에 별표가 붙었거나 다른 곳에서 지웠을 수 있다 — 옮기기 직전에 다시 묻는다.
            // «바로»는 읽음도 다시 묻는다 — 그 사이 «안 읽음»으로 되돌린 메일은 남긴다
            const still = await client.search({
              uid: part, flagged: false, deleted: false, ...(seenOnly ? { seen: true } : {})
            }, { uid: true });
            if (!Array.isArray(still)) throw new Error('서버가 검색에 답하지 않았습니다');
            // 교집합을 꼭 한다 — uid 조건이 빠지면 검색이 폴더 전체를 돌려준다
            let pre = part.filter((u) => still.includes(u));
            if (seenOnly && pre.length) {
              // 읽음 조건을 흘려듣는 서버에서는 위 검색이 그 사이 «안 읽음»으로 되돌린 메일도 돌려준다 —
              // 플래그를 다시 받아 읽음인 것만 남긴다. 못 받으면(던지면) 이 묶음은 옮기지 않는다 (열쇠를 적기 전이다)
              const fl = await flagsOf(b, pre);
              if (stopHere()) { res.more = true; break; }
              pre = pre.filter((u) => readNow(fl.get(u)));
            }
            // 고른 뒤에 보기 창으로 연 메일도 여기서 뺀다 (창을 닫은 뒤 다음 정리 때 옮긴다)
            const go = pre.filter((u) => !viewing(acc, b.path, u, sidOf.get(u)));
            res.spared += part.length - go.length;
            if (!go.length) continue;
            // 옮기기 «전에» 열쇠를 적어 둔다 — MOVE 를 보낸 뒤 끊겨 답을 못 받아도, 그 묶음을 휴지통에서
            // 되찾았을 때 다시 옮기지 않게. 못 옮긴 것이 확실해지면 아래에서 지운다 (모르면 남긴다)
            const keyOf = new Map(go.map((u) => [u, movedKey(accKey, b.path, idOf.get(u))]));
            const fresh = [...new Set(keyOf.values())].filter((x) => !moved.has(x));
            await record(fresh);
            /** 남아 있는 것이 확실한 UID 의 새 열쇠만 지운다 (같은 열쇠를 옮긴 메일이 쓰면 둔다) */
            const forgetLeft = (leftUids, doneUids) => {
              const keep = new Set(doneUids.map((u) => keyOf.get(u)));
              const drop = new Set(leftUids.map((u) => keyOf.get(u)).filter((x) => !keep.has(x)));
              return forget(fresh.filter((x) => drop.has(x)));
            };
            // 이 둘(폴더·MOVE)과 messageMove 사이에는 await가 없다 — 그 사이에 MOVE가 사라지면 대체 경로를 탄다.
            // 여기서 멈추면 아무것도 옮기지 않았으니 방금 적은 열쇠를 지운다 (남기면 그 메일은 영영 정리되지 않는다)
            const blocked = (() => {
              try { sameBox(b); } catch (e) { return e; }
              return canMove(client) ? null : new Error(NO_MOVE);
            })();
            if (blocked) {
              await forgetLeft(go, []);
              throw blocked;
            }
            let r;
            let moveErr = null;
            try {
              r = await client.messageMove(go, trash.path, { uid: true });
            } catch (e) {
              r = false;
              moveErr = e;
            }
            if (!r) {
              // 끊겨서 답을 못 받았다 — 서버가 옮겼는지 모른다. 열쇠는 남긴다
              if (cut() || client.usable === false) throw unsure(b, go.length, '옮기는 중에 연결이 끊겨');
              // 연결은 살아 있다 — 무엇이 남았는지 다시 물어, 못 옮긴 것의 열쇠는 지운다
              let leftUids = null;
              try {
                sameBox(b);
                const s = await client.search({ uid: go }, { uid: true });
                if (Array.isArray(s)) leftUids = go.filter((u) => s.includes(u));
              } catch { leftUids = null; }
              if (!leftUids) throw unsure(b, go.length, '서버가 옮기기에 제대로 답하지 않아');
              const gone = go.filter((u) => !leftUids.includes(u));
              res.moved += gone.length;
              await forgetLeft(leftUids, gone);
              throw new Error(`서버가 옮기기를 거부했습니다${gone.length ? ` (${gone.length}통만 옮겨짐)` : ''}`
                + (moveErr ? ` — ${mail.friendly(moveErr)}` : ''));
            }
            // 서버가 옮긴 목록(COPYUID)은 믿지 않는다 — imapflow 는 답이 여러 줄로 오면 마지막 줄로 덮어쓰고,
            // 목록을 비워 주는 서버도 있다. 그걸 믿으면 실제보다 적게 세어 상한(CAP)을 넘겨 옮기고,
            // 실제로 옮긴 메일의 열쇠까지 지운다. 폴더에 남은 것을 다시 물어 센다.
            // 못 물으면 다 옮긴 것으로 센다 — 상한은 줄이는 쪽, 열쇠는 남기는 쪽이 안전하다
            let stayed = null;
            try {
              sameBox(b);
              const s = await client.search({ uid: go }, { uid: true });
              if (Array.isArray(s)) stayed = go.filter((u) => s.includes(u));
            } catch { stayed = null; }
            const done = stayed ? go.filter((u) => !stayed.includes(u)) : go;
            res.moved += done.length;
            if (stayed && stayed.length) await forgetLeft(stayed, done);
          }
        };

        const tidyBox = async (b) => {
          // 후보를 고르는 동안은 늘 읽기 전용(EXAMINE) — 쓰기 모드에서는 닫기만 해도 지워진다
          const box = await client.mailboxOpen(b.path, { readOnly: true });
          const rec = recs[b.path];
          // 서버가 UID를 새로 매겼거나 기록이 없으면 파일의 UID를 믿을 수 없다 — 검색도 하지 않는다
          if (!rec || !goodV(rec.uidValidity) || !goodV(box && box.uidValidity)
            || String(rec.uidValidity) !== String(box.uidValidity)) {
            res.skippedBoxes.push(b.path);
            return;
          }
          const boxDir = mailbackup.boxDirFor(dir, acc, b.path, mailbackup.genOf(state, acc, b.path));
          const files = await mailbackup.uidFiles(boxDir);
          if (!files) { res.skippedBoxes.push(b.path); return; }

          sameBox(b);
          // «바로»는 날짜 조건 없이 읽은 것만 고른다. 서버가 조건을 흘려들어도 받아 온 뒤 판정(verdict)이 다시 본다
          let found = await client.search(seenOnly
            ? { seen: true, flagged: false, deleted: false }
            : { before: searchBefore(cutoff), flagged: false, deleted: false }, { uid: true });
          if (!Array.isArray(found)) throw new Error('서버가 검색에 답하지 않았습니다');
          if (seenOnly) {
            // 저장된 안 읽은 메일은 따로 센다 — 화면이 «읽을 때까지 남김»이라고 말한다 (남김 경고가 아니다).
            // 세기일 뿐이라 서버가 거절해도 정리는 한다
            sameBox(b);
            let unseen = null;
            try {
              unseen = await client.search({ seen: false, flagged: false, deleted: false }, { uid: true });
            } catch (e) {
              if (cut() || client.usable === false) throw e;
            }
            if (Array.isArray(unseen)) {
              const picked = new Set(found);
              // 읽음 조건을 지키는 서버라면 두 검색이 겹치지 않는다. 겹치면 흘려듣는 서버다 — 위 검색에 안 읽은 메일이
              // 섞여 와, 그대로 두면 저장 안 된 안 읽은 메일이 «저장 안 됨» 경고로 세어지고 안 읽은 메일의 봉투까지 받는다.
              // 가벼운 플래그만 받아 읽은 것만 남긴다 (못 받으면 그대로 둔다 — 판정이 받아 온 플래그로 다시 본다)
              if (unseen.some((u) => picked.has(u))) {
                let fl = null;
                try {
                  fl = await flagsOf(b, found);
                } catch (e) {
                  if (cut() || client.usable === false) throw e;
                }
                // 받는 도중에 멈추라면 반쯤 받은 플래그로 세지 않는다 — 이 폴더는 다음에
                if (fl && stopHere()) { res.more = true; return; }
                if (fl) {
                  res.unread += found.filter((u) => files.has(u) && unreadNow(fl.get(u))).length;
                  found = found.filter((u) => readNow(fl.get(u)));
                }
              }
              res.unread += unseen.filter((u) => files.has(u) && !picked.has(u)).length;
            }
          }
          let cand = found.filter((u) => files.has(u)).sort((x, y) => x - y);   // 오래된 것부터
          res.unsaved += found.length - cand.length;
          res.kept += found.length - cand.length;

          // «바로» — 지난번에 남김 판정을 받은 메일은 기억한 판정으로 세고 다시 받지 않는다 (memoMs 가 지나면 다시 본다).
          // 열쇠에 백업 폴더(세대 포함)와 UIDVALIDITY 를 넣는다 — UID 가 다른 메일을 가리키게 되면 기억도 따라 버린다
          let mm = null;
          if (useMemo) {
            const key = `${boxDir}\n${String(box.uidValidity)}`;
            mm = memo.get(key);
            // 시간이 지났거나 시계가 뒤로 갔으면 처음부터 다시 본다
            if (!mm || !(now() - mm.at < memoMs) || now() < mm.at) {
              mm = { at: now(), codes: new Map() };
              memo.set(key, mm);
            }
            const fresh = [];
            for (const u of cand) {
              const code = mm.codes.get(u);
              if (UNVERIFIED.has(code)) { res.unverified += 1; res.kept += 1; }
              else if (SPARED.has(code)) res.spared += 1;
              else fresh.push(u);
            }
            cand = fresh;
          }

          const ok = [];
          const idOf = new Map();
          const sidOf = new Map();
          const room = () => left() - (dryRun ? 0 : ok.length);
          for (let k = 0; k < cand.length; k += CHUNK) {
            // 상한을 채웠으면 더 받지 않는다 — 큰 폴더에서 봉투를 다 받다 시간 제한에 걸리지 않게
            if (stopHere() || room() <= 0) { res.more = true; break; }
            sameBox(b);
            const part = cand.slice(k, k + CHUNK);
            const msgs = new Map();
            // 반복문 안에서는 IMAP 명령을 보내지 않는다 (imapflow 교착).
            // 옵션 객체는 호출마다 새로 준다 — imapflow 가 받은 옵션을 고쳐 쓴다(resolveRange)
            for await (const m of client.fetch(part, {
              uid: true, size: true, envelope: true, internalDate: true, flags: true, labels: true, headers: [...HEADS]
            }, { uid: true })) {
              if (m && m.uid != null) msgs.set(Number(m.uid), m);
            }
            let full = false;
            for (const u of part) {
              if (room() <= 0) { res.more = true; full = true; break; }
              const m = msgs.get(u);
              const v = await verdict(m, files.get(u), {
                cutoff, seenOnly, wasMoved: (id) => moved.has(movedKey(accKey, b.path, id))
              });
              const sid = normId(m && m.envelope && m.envelope.messageId);
              if (v === 'ok' && viewing(acc, b.path, u, sid)) {
                // 지금 보기 창에 떠 있다 — 창을 닫은 뒤 다음 정리 때 옮긴다 (기억하지 않는다)
                res.spared += 1;
              } else if (v === 'ok') {
                ok.push(u);
                idOf.set(u, recoverId(m));
                sidOf.set(u, sid);
                res.verified += 1;
              } else if (UNVERIFIED.has(v)) {
                res.unverified += 1;
                res.kept += 1;
                if (mm) mm.codes.set(u, v);
              } else if (SPARED.has(v)) {
                res.spared += 1;
                if (mm) mm.codes.set(u, v);
              } else if (v === 'unread') {
                // 읽으면 판정이 바뀐다 — 기억하지 않는다
                res.unread += 1;
              }
            }
            if (full) break;
          }
          if (dryRun || !ok.length) return;
          // 판정을 마친 폴더부터 바로 옮긴다 — 시간 제한에 걸려도 한 일은 남는다
          await moveBox(b, rec, ok, idOf, sidOf);
        };

        for (const b of boxes) {
          if (stopHere() || left() <= 0) { res.more = true; break; }
          if (!accountLive(acc)) break;
          try {
            await tidyBox(b);
          } catch (e) {
            if (cut()) throw e;
            if (!e.counted) res.errors.push(maskAddr(`${label} · ${b.path}: ${mail.friendly(e)}`));
            // 연결이 끊겼으면 이 계정의 남은 폴더는 다음에
            if (client.usable === false) { res.more = true; break; }
          }
        }
        if (late) throw new Error('시간 몫을 다 썼다');
      } catch (e) {
        if (late && !aborted()) {
          const x = new Error('정해진 시간 안에 다 보지 못했습니다 — 남은 것은 다음에 이어서 합니다');
          x.late = true;
          throw x;
        }
        throw e;
      } finally {
        clearTimeout(lateTimer);
        try {
          if (cut()) client.close();
          else await client.logout();
        } catch {
          try { client.close(); } catch { /* 이미 닫혔다 */ }
        }
        open.delete(client);
      }
    };

    const list = accounts || [];
    for (let i = 0; i < list.length; i++) {
      const acc = list[i];
      if (stopNow() || left() <= 0) { res.more = true; break; }
      if (!accountLive(acc)) continue;      // 끄거나 지운 계정 — 오류가 아니다
      res.accounts += 1;
      // 남은 시간을 남은 계정 수로 나눈다 — 빨리 끝난 계정의 몫은 뒤 계정이 쓴다
      const share = deadline ? Math.max(accountMinMs, Math.floor((deadline - Date.now()) / (list.length - i))) : 0;
      try {
        await tidyAccount(acc, i, share);
      } catch (e) {
        if (aborted()) { res.aborted = true; res.more = true; break; }
        if (e && e.late) {
          // 실패가 아니다 — 이 계정의 남은 것은 다음 실행에서 이어서 본다
          res.more = true;
          res.errors.push(maskAddr(`${labelOf(acc, i)}: ${e.message}`));
          continue;
        }
        res.failedAccounts += 1;
        res.errors.push(maskAddr(`${labelOf(acc, i)}: ${mail.friendly(e)}`));
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (aborted()) { res.aborted = true; res.more = true; }
  res.complete = !res.more && !res.aborted && !res.halt;
  return res;
}

module.exports = {
  DAYS, DAY_MS, CAP, CHUNK, HEADS, MOVED_FILE, MOVED_MAX, FORBIDDEN,
  normDays, normId, headerFields, searchBefore, mineOf, keepsFolder, canMove, guard,
  goodV, maskAddr, labelOf, movedKey, loadMoved, carryMoved, recoverId, verdict, tidyAll, ACCOUNT_MIN_MS
};

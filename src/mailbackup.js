'use strict';
/**
 * 메일 백업 — IMAP에서 원문을 통째로 받아 .eml 파일로 저장한다.
 *
 * 왜 .eml인가: 메일 한 통이 파일 하나다. 탐색기에서 더블클릭하면 열리고,
 * Outlook·Thunderbird로 그대로 가져갈 수 있다. 우리 앱이 없어져도 남는다.
 *
 * 증분이 핵심이다. 메일함이 몇 GB면 처음 한 번은 오래 걸리지만, 폴더별로
 * "어디까지 받았는지"를 기록해두면 다음부터는 새로 온 것만 받는다.
 * 중간에 끊겨도 이어서 받는다 — 받은 만큼은 이미 파일로 남아 있기 때문이다.
 *
 * UIDVALIDITY가 바뀌면 서버가 UID를 새로 매긴 것이므로 그 폴더는 처음부터 다시 받는다.
 */
const fs = require('fs');
const path = require('path');
const mail = require('./mail');
const mailindex = require('./mailindex');

const STATE_FILE = 'backup-state.json';
const BATCH = 50;              // 한 번에 받아올 통수 (너무 크면 서버가 끊는다)
const TIMEOUT_MS = 90_000;     // 소켓 제한 — 전달·정리와 같은 값이다. 원문을 받는 동안 기본값이면 느린 서버에서 끊긴다
const NEW_CAP = 200;           // 꺼져 있던 자동 저장을 켤 때 묻기 전에 받는 통수 (3.4 밀린 구간). 답이 없는 계정은 계정 전체로, 답한 계정은 폴더마다
const NEW_RETRIES = 3;         // 서버가 거절한 새 메일을 몇 번까지 부르나

/** 쓸 수 있는 UIDVALIDITY인가 — src/mailtidy.js 의 goodV 와 같은 식이다 (그쪽을 부르면 순환이다) */
function goodV(v) {
  return /^[1-9]\d*$/.test(String(v));
}

/** 파일 이름으로 쓸 수 없는 글자를 바꾼다 */
function safeName(s, max = 60) {
  // 줄바꿈·탭을 먼저 공백으로 접는다 — 나중에 하면 '_'로 바뀐 뒤라 늦다
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .slice(0, max)
    .trim() || '제목없음';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── 파일 자리 정하기 ────────────────────────────────────
// 같은 메일이 두 번 저장되면 안 된다. 그런데 전체 백업은 서버가 준 제목을,
// 열어보기는 파싱한 제목을 쓰기 때문에 파일 이름이 미세하게 갈릴 수 있다.
// 그래서 "이미 있나"는 제목이 아니라 UID로만 판단한다.
const UID_IN_NAME = /^\d{8}_\d{4}_(\d+)(?:_.*)?\.eml$/;

function accountKey(account) {
  return account.id || account.user;
}

/**
 * 이름이 뭉개졌을 때 서로 구분되게 붙이는 짧은 꼬리표.
 *
 * 마지막에 비트를 섞는 이유: 그냥 h*31+글자만 돌리면 끝 글자 하나만 다른 두 이름이
 * 1만큼만 차이 나는 값이 되고, 앞에서 5글자를 잘라내면 그 차이가 통째로 사라진다.
 * («…가A»와 «…가B»가 같은 꼬리표를 받는다)
 */
function tag(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0).toString(36).padStart(5, '0').slice(-5);
}

// Win32 경로는 끝의 점·공백을 지우고 이 이름들을 장치로 읽는다. Node 는 \\?\ 경로로 만들고 읽어 앱과 정리는 정상으로 보지만,
// 탐색기·다른 프로그램은 그 폴더를 못 연다. 정리가 서버 메일을 옮긴 뒤에는 그것이 유일한 사본이다
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
function winName(name) {
  const cut = name.replace(/[. ]+$/, '') || '_';
  return RESERVED_NAME.test(cut) ? `_${cut}` : cut;
}

/**
 * 폴더 자리.
 *
 * 계정 폴더에 아이디까지 넣는 이유: 이름은 «Gmail»처럼 제공자 이름이 그대로 들어가서
 * 같은 곳의 계정 두 개가 같은 이름을 갖는다. 한 폴더를 나눠 쓰면 UID가 겹쳐
 * 두 번째 계정의 메일이 통째로 "이미 받았다"로 처리된다 — 유실이다.
 *
 * gen(세대): 서버가 UID를 새로 매기면(UIDVALIDITY 변경) 예전 번호와 새 번호가 겹친다.
 * 세대를 나눠 예전 것도 그대로 남긴다.
 *
 * 메일함 이름은 못 쓰는 글자를 바꾸고 잘라내므로 서로 다른 폴더가 같은 이름이 될 수 있다
 * («업무/A»와 «업무_A», 40자 넘는 긴 이름들). 원래 이름과 달라졌으면 꼬리표를 붙인다.
 * 끝의 점과 예약 이름은 비킨다. 다만 그 자리에 이미 받아 둔 폴더는 옮기지 않는다 — 자리가 바뀌면 받은 파일이 안 보여 전부 다시 받는다.
 */
function boxDirFor(dir, account, mailbox, gen = 1) {
  const rawAcc = `${account.name || ''} ${account.user || ''}`.trim() || '계정';
  const acc = safeName(rawAcc, 46);
  const accDir = acc === rawAcc ? acc : `${acc}~${tag(rawAcc)}`;

  const rawBox = String(mailbox || 'INBOX');
  const spot = (n) => {
    const name = n === rawBox ? n : `${n}~${tag(rawBox)}`;
    return path.join(dir, accDir, gen > 1 ? `${name} (${gen})` : name);
  };
  const first = safeName(rawBox.replace(/[\\/]/g, '_'), 40);
  const fixed = winName(first);
  if (fixed === first) return spot(first);
  const old = spot(first);
  return fs.existsSync(old) ? old : spot(fixed);
}

/** 이 폴더를 지금 몇 세대로 쓰고 있나 (기록이 없으면 1) */
function genOf(state, account, mailbox) {
  const per = (state[accountKey(account)] || {})[mailbox || 'INBOX'];
  return Math.max(1, Number(per && per.gen) || 1);
}

/**
 * 이 폴더에 받아둔 파일을 UID별로 — 서버 정리가 «PC에 정말 있나»를 볼 때 쓴다.
 * 같은 UID 파일이 둘일 수 있다 (전체 백업은 서버가 준 제목을, 열어보기는 파싱한 제목을 쓴다) —
 * 그래서 경로 목록으로 준다. 하나라도 같은 메일로 확인되면 된다.
 * 없음과 못 읽음을 섞지 않는다: 폴더가 없으면 빈 목록(«저장 안 됨»), 못 읽으면 null(알 수 없음 —
 * 부르는 쪽이 그 폴더를 통째로 건너뛴다).
 * @returns Map<uid, 전체경로[]> | null
 */
async function uidFiles(boxDir) {
  let names;
  try {
    names = await fs.promises.readdir(boxDir);
  } catch (e) {
    return e && e.code === 'ENOENT' ? new Map() : null;
  }
  const out = new Map();
  for (const n of names) {
    const m = n.match(UID_IN_NAME);
    if (!m) continue;
    const uid = Number(m[1]);
    if (!out.has(uid)) out.set(uid, []);
    out.get(uid).push(path.join(boxDir, n));
  }
  return out;
}

/** 이 폴더에 이미 받아둔 UID들 (한 번 읽어 두고 재사용한다) */
function uidsIn(boxDir) {
  const out = new Set();
  let names;
  try { names = fs.readdirSync(boxDir); } catch { return out; }
  for (const n of names) {
    const m = n.match(UID_IN_NAME);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

let partSeq = 0;
const LOCKED = ['EBUSY', 'EPERM', 'EACCES'];
const LOCK_WAITS = [200, 500, 1000, 2000];

/** 백신·동기화 프로그램이 새 파일을 잠깐 잡으면 rename 이 막힌다 — 원문이 메모리에 있으니 재수신 없이 기다린다 */
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (e) {
      if (i >= LOCK_WAITS.length || !LOCKED.includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, LOCK_WAITS[i]));
    }
  }
}

/**
 * 메일 한 통을 파일로 쓴다.
 *
 * 먼저 임시 이름으로 다 쓰고 나서 제 이름을 준다.
 * 쓰는 도중에 디스크가 차거나 전원이 나가면 반쪽짜리 파일이 남는데, 그 이름에 UID가
 * 들어 있으면 "이미 받았다"로 읽혀 그 메일은 영영 다시 받지 못한다.
 * 임시 이름은 uidsIn이 세지 않는 모양으로 짓는다(.eml로 끝나지 않는다). 시도마다 달라 서로 밟지 않는다.
 * @returns { name, bytes }
 */
async function commit(boxDir, { uid, receivedAt, subject, source }) {
  const d = new Date(receivedAt || Date.now());
  const tmp = path.join(boxDir, `~받는중-${uid}-${process.pid}-${++partSeq}.part`);
  const bytes = Buffer.byteLength(source);
  const drop = () => fs.promises.unlink(tmp).catch(() => { /* 지우지 못해도 .part는 목록에서 무시된다 */ });
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(source);
    await fh.sync();      // 전원이 나가 0으로 찬 파일을 막는다 — PC가 원본이다
  } catch (e) {
    await fh.close().catch(() => {});
    await drop();
    throw e;
  }
  await fh.close();
  const full = `${stamp(d)}_${uid}_${safeName(subject, 50)}.eml`;
  try {
    await renameRetry(tmp, path.join(boxDir, full));
    return { name: full, bytes };
  } catch (e) {
    // 윈도우 경로 길이(260자)에 걸리는 제목이 있다. 제목을 빼면 항상 들어간다.
    if (!['ENAMETOOLONG', 'ENOENT', 'EINVAL'].includes(e.code)) {
      await drop();
      throw e;
    }
  }
  const plain = `${stamp(d)}_${uid}.eml`;
  try {
    await renameRetry(tmp, path.join(boxDir, plain));
    return { name: plain, bytes };
  } catch (e) {
    await drop();
    throw e;
  }
}

/**
 * 열어본 메일 한 통을 그 자리에서 저장한다.
 * 본문을 이미 받아왔으므로 서버를 한 번 더 부르지 않는다 — 읽는 순간이 곧 공짜 백업이다.
 *
 * 폴더에 파일이 수만 개면 목록 읽기가 잠깐 걸린다. 메일을 여는 순간에 화면이 멎으면
 * 안 되므로 디스크 작업은 전부 비동기로 한다.
 */
async function saveOne(account, dir, msg) {
  const state = loadState(dir);
  const rec = (state[accountKey(account)] || {})[msg.mailbox || 'INBOX'];
  const boxDir = boxDirFor(dir, account, msg.mailbox, genOf(state, account, msg.mailbox));
  await fs.promises.mkdir(boxDir, { recursive: true });
  const have = new Set();
  for (const n of await fs.promises.readdir(boxDir)) {
    const m = n.match(UID_IN_NAME);
    if (m) have.add(Number(m[1]));
  }
  if (have.has(msg.uid)) return { saved: false, dir: boxDir };
  // 기록이 없는 폴더에는 색인 줄을 쓰지 않는다. 메타 없는 색인이 생기면 세대를 못 올린다 (freeGen).
  // 그 파일은 뒤에 reconcile 이 메운다
  const indexed = !!rec && goodV(rec.uidValidity);
  if (indexed) {
    await mailindex.ensureMeta(boxDir, {
      acc: accountKey(account), user: account.user, host: account.host,
      box: msg.mailbox || 'INBOX', uidValidity: rec.uidValidity, gen: genOf(state, account, msg.mailbox)
    });
  }
  const { name, bytes } = await commit(boxDir, { uid: msg.uid, receivedAt: msg.receivedAt, subject: msg.subject, source: msg.source });
  if (indexed) {
    try {
      mailindex.append(boxDir, await mailindex.rowFromSource(msg.source, {
        uid: msg.uid, at: msg.receivedAt, seen: msg.seen === undefined ? null : msg.seen, via: 'open', file: name, bytes
      }));
    } catch { /* 줄을 못 만들어도 저장은 끝났다 — reconcile 이 메운다 */ }
  }
  return { saved: true, dir: boxDir };
}

function loadState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')); }
  catch { return {}; }
}

/**
 * 고치려고 읽는 길. loadState 는 못 읽어도 {} 라, 그 값으로 다시 쓰면 기록을 잃는다.
 * 없음은 빈 값이고, 못 읽음(잠김 등)은 던진다 — 덮어쓰면 안 된다.
 * @returns { state, broken, restored? }
 */
function readStateInfo(dir) {
  const file = path.join(dir, STATE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: {}, broken: false };
    throw Object.assign(new Error(`진행 기록을 읽을 수 없습니다 — ${e.code || e.message}`), { code: 'STATE_UNREADABLE' });
  }
  try {
    return { state: JSON.parse(raw), broken: false };
  } catch {
    // 직접 쓰기가 중간에 실패한 파일이다. 그 앞에 둔 사본이 있으면 그것으로 잇는다 — 옛 lastUid 를 잃으면 그 구간을 영영 안 받는다
    try { return { state: JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), broken: false, restored: true }; }
    catch { /* 사본도 없으면 새로 시작한다 */ }
    try { fs.renameSync(file, `${file}.broken`); } catch { /* 못 비켜도 새로 쓴다 */ }
    return { state: {}, broken: true };
  }
}

/** 디스크로 내린다 — 쓰자마자 전원이 나가면 rename 만 남아 0으로 찬 파일이 된다. 안 되는 드라이브여도 rename 은 한다 */
function syncFile(file) {
  try {
    const fd = fs.openSync(file, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code === 'ENOSPC') throw e;
  }
}

/**
 * 어디까지 받았는지 기록한다.
 * 이걸 못 쓰면 다음 실행이 처음부터 다시 받는다 — 조용히 넘기면 안 되고 알려야 한다.
 * @returns 실패 사유 (성공이면 null)
 */
function saveState(dir, state) {
  const target = path.join(dir, STATE_FILE);
  const bak = `${target}.bak`;
  const body = JSON.stringify(state, null, 2);
  try {
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, body);
    syncFile(tmp);
    fs.renameSync(tmp, target);
    // 사본은 직접 쓰기가 실패했을 때 잇는 것이다. 남겨 두면 몇 달 뒤 본 파일이 깨졌을 때 옛 lastUid 가 조용히 돌아온다
    try { fs.unlinkSync(bak); } catch { /* 없으면 그만이다 */ }
    return null;
  } catch (e) {
    // 디스크가 찼으면 직접 쓰지 않는다. writeFileSync 는 파일을 먼저 비우고 쓰다 실패해 기록을 통째로 잃는다
    if (e.code === 'ENOSPC') return e.message;
    // 백신·동기화 프로그램이 원본을 잠깐 잡고 있으면 rename이 막힌다. 사본을 두고 직접 써 본다.
    // 본 파일이 읽힐 때만 사본을 고친다 — 앞선 직접 쓰기가 비운 파일로 덮으면 멀쩡한 사본까지 잃어 모든 계정 기록이 사라진다
    try {
      JSON.parse(fs.readFileSync(target, 'utf8'));
      fs.copyFileSync(target, bak);
    } catch { /* 원본이 없거나 깨졌으면 있는 사본을 둔다 */ }
    try { fs.writeFileSync(target, body); return null; }
    catch (e2) { return e2.message || e.message; }
  }
}

/**
 * 한 폴더의 기록을 고친다. 읽기·합치기·쓰기 사이에 await 가 없어 한 프로세스 안에서 원자적이다.
 * UIDVALIDITY가 같으면 lastUid 는 큰 값, lowUid 는 작은 값으로 합친다 — 겹친 실행이 위치를 되돌리지 못한다.
 * 다르면 patch 로 통째 바꾼다. 그래서 지난 세대의 fill* 칸이 사라진다.
 * 빈 답 확인(mailfill emptySure)의 칸도 여기서 고친다 — exists 를 적는 길이 여럿이라 한 곳에 둔다.
 * @param expectV 회차가 본 UIDVALIDITY — 기록과 다르면 버린다. 끊긴 옛 회차의 값이 새 세대 기록에 붙지 않게 한다
 * @param raiseLow 밀린 구간을 건너뛸 때만 lowUid 를 올린다 (fillHead:false 와 함께 적는다)
 * @returns { rec, error, dropped? }
 */
function patchState(dir, accKey, box, patch, { expectV = null, raiseLow = false } = {}) {
  const { state } = readStateInfo(dir);
  const per = state[accKey] || (state[accKey] = {});
  const prev = per[box] || {};
  if (expectV != null && String(prev.uidValidity) !== String(expectV)) return { rec: prev, error: null, dropped: true };
  const same = prev.uidValidity != null
    && (patch.uidValidity == null || String(prev.uidValidity) === String(patch.uidValidity));
  let next;
  if (same) {
    next = { ...prev, ...patch };
    if (patch.lastUid != null && prev.lastUid != null) next.lastUid = Math.max(prev.lastUid, patch.lastUid);
    if (!raiseLow && patch.lowUid != null && prev.lowUid != null) next.lowUid = Math.min(prev.lowUid, patch.lowUid);
    // 메일이 보였다 — 빈 답 두 번이 이어지지 않았으니 시계만 지운다. 칸은 완료를 적는 confirmBox 가 지운다. 그전에 지우면 다른 길로 내려간 lowUid 가 곧 «다 받음»이다
    if (patch.exists > 0 && prev.fillEmptyAt) next.fillEmptyAt = 0;
    // exists 는 빈 답 하나로 0 이 된다. 폴링이 먼저 덮어도 메일이 있던 폴더라는 증거는 남긴다
    if (Number(prev.exists) > 0 && patch.exists === 0) next.fillHadMail = true;
  } else {
    next = { ...patch };
  }
  per[box] = next;
  return { rec: next, error: saveState(dir, state) };
}

/**
 * 백업할 폴더 목록.
 * 스팸·휴지통은 뺀다 — 지우려고 넣어둔 것까지 받으면 시간만 몇 배가 든다.
 * 서버가 알려주는 용도(specialUse)를 먼저 보고, 없으면 이름으로 짐작한다.
 */
// \All(Gmail의 «전체보관함»)은 빼지 않는다. Gmail에서 «보관»한 메일은 라벨이 없어져
// 오직 거기에만 남는데, 그게 대개 메일함의 대부분이다. 그걸 건너뛰면 «백업 완료»라고
// 말해놓고 실제로는 거의 아무것도 없는 백업이 된다. 겹쳐 받는 용량이 유실보다 낫다.
const SKIP_USE = ['\\Junk', '\\Trash'];
const SKIP_NAME = /^(spam|junk|trash|deleted|정크|스팸|휴지통|지운편지함)/i;

/**
 * 이 폴더를 백업하나. 잣대를 한 곳에 둔다 — 서버 정리(mailtidy)도 «백업하는 폴더»만 보므로
 * 둘이 따로 고치다 어긋나면 백업하지 않은 폴더의 메일을 정리하게 된다.
 */
function backsUp(b) {
  return !b.flags.has('\\Noselect') && !SKIP_USE.includes(b.specialUse) && !SKIP_NAME.test(b.name);
}

/** LIST 항목을 그대로 준다 — 폴더 역할(specialUse)을 색인 메타에 쓴다 */
async function listBoxes(client) {
  return (await client.list()).filter(backsUp);
}

/**
 * 폴더의 맨 위 UID.
 * UIDNEXT는 RFC상 «주는 게 좋다»일 뿐이라 안 주는 서버가 있다.
 * 그냥 빼면 NaN이 되어 두 반복문이 다 건너뛰고 «0통 저장, 완료»가 된다 —
 * 아무것도 안 받고 다 받았다고 말하는 최악의 경우다. 직접 물어본다.
 */
async function topOf(client, box, boxPath) {
  if (Number.isFinite(box.uidNext)) return box.uidNext - 1;
  if (!box.exists) return 0;
  const all = await client.search({ all: true }, { uid: true }) || [];
  if (!all.length) throw new Error(`${boxPath}: 서버가 UID를 알려주지 않습니다`);
  return Math.max(...all);
}

/** 대소문자만 다른 폴더인가 (Work·WORK) — NTFS 에서 한 자리다. INBOX 는 IMAP 에서 대소문자를 가리지 않아 같은 폴더다 */
function caseTwin(a, b) {
  const x = String(a);
  const y = String(b);
  return x !== y && x.toLowerCase() === y.toLowerCase() && x.toLowerCase() !== 'inbox';
}

/**
 * 그 세대가 대소문자만 다른 폴더와 겹치면 다음 세대로 민다.
 * 색인과 폴더를 나눠 쓰면 뒤에 연 폴더가 앞 폴더의 줄을 자기 메일로 읽어 안 받고 거짓 «다 받음»이 된다.
 * 이미 같은 세대로 적힌 옛 기록은 건드리지 않는다 — 옮기면 받은 파일이 안 보인다.
 */
function clearOfTwins(per, boxPath, gen) {
  const used = new Set();
  for (const [p, r] of Object.entries(per || {})) {
    if (caseTwin(p, boxPath) && r && r.uidValidity != null) used.add(Math.max(1, Number(r.gen) || 1));
  }
  let g = gen;
  while (used.has(g)) g += 1;
  return g;
}

/**
 * 상태 파일에 기록이 없는 폴더의 세대. 상태 파일을 잃고 UID가 새로 매겨졌을 때 옛 파일과 겹치지 않게 메타를 본다.
 * 메타가 없는 폴더(업그레이드 전 폴더)는 세대를 올리지 못한다 — 그 경우는 fileMatches 가 막는다.
 */
async function freeGen(dir, account, boxPath, v) {
  for (let g = 1; ; g++) {
    const meta = await mailindex.readMeta(boxDirFor(dir, account, boxPath, g));
    if (meta && meta.box != null && caseTwin(meta.box, boxPath)) continue;
    if (!meta || meta.uidValidity == null || String(meta.uidValidity) === v) return g;
  }
}

/**
 * 기록을 지금 서버에 맞춘다. 기록이 없거나 UIDVALIDITY가 다르면 «여기까지는 받은 셈»으로 표시만 한다.
 * lowUid를 여기 찍어두기 때문에, 그 아래는 사용자가 답한 뒤 받으러 간다.
 * UIDVALIDITY를 못 믿으면 던진다 — 답 하나에 빠졌다고 세대를 올리면 다음 정상 답에서 또 올라 메일함 전체를 두 번 받는다.
 * @returns { rec, top, fresh, genUp?, error? }
 */
async function ensureBox(client, dir, account, boxPath, box) {
  if (!goodV(box.uidValidity)) throw new Error(`${boxPath}: 서버가 UIDVALIDITY를 주지 않습니다`);
  const top = await topOf(client, box, boxPath);
  const accKey = accountKey(account);
  const v = String(box.uidValidity);
  const per = readStateInfo(dir).state[accKey] || {};
  const prev = per[boxPath];
  if (prev && String(prev.uidValidity) === v) return { rec: prev, top, fresh: false };
  // 번호가 새로 매겨졌으면 세대를 올려 예전 파일과 섞이지 않게 한다
  const genUp = !!prev && prev.uidValidity != null;
  const gen = clearOfTwins(per, boxPath, genUp ? Math.max(1, Number(prev.gen) || 1) + 1 : await freeGen(dir, account, boxPath, v));
  const { rec, error } = patchState(dir, accKey, boxPath, {
    uidValidity: v, gen, lowUid: top + 1, lastUid: top,
    ...(Number.isFinite(box.exists) ? { exists: box.exists } : {})
  });
  return { rec, top, fresh: true, genUp, error };
}

// 서버가 거절한 새 메일 — 메모리에만 둔다. 앱을 다시 켜면 색인 줄(st:head)과 fillFail 이 남아 답이 yes 면 뒤 받기가 다시 본다
const retryNew = new Map();    // 폴더 열쇠 → { v, uids: Map<uid, 부른 횟수> }

function retriesOf(dir, accKey, boxPath, v) {
  const k = `${dir}\n${accKey}\n${boxPath}`;
  let r = retryNew.get(k);
  if (!r || r.v !== v) {
    r = { v, uids: new Map() };
    retryNew.set(k, r);
  }
  return r.uids;
}

/**
 * 한 계정을 백업한다.
 * @param onProgress { mailbox, done, total, saved, skipped } 를 받는다
 * @param shouldStop 중간에 멈출지 물어보는 함수 (자리에 돌아왔을 때 등)
 * @param onlyNew    아직 한 번도 받은 적 없는 폴더는 "지금부터"로 표시만 하고 넘어간다.
 *                   자동 백업이 켜지자마자 몇 년치를 몰래 내려받는 일을 막는다 —
 *                   지난 메일은 사용자가 답한 뒤 mailfill 이 받는다.
 * @param dirProblem 파일 쓰기가 실패했을 때 폴더 탓인지 가르는 함수 (사유 | null). 없으면 폴더 탓으로 본다
 * @param unanswered 지난 메일을 받을지 아직 답하지 않은 계정 — 묻기 전에 받는 상한을 계정 전체에 건다. 사용자에게는 «맨 위 200통»으로 말하고 묻는다
 * @param mineOf     내 폴더를 가르는 함수를 주는 함수 (mailtidy.mineOf, 순환이라 부르는 쪽이 넘긴다). 뒤 받기가 «대상 아님»으로 적은 폴더가 내 폴더로 보이면 표시를 지운다
 * @param capsOf     연결에서 «서버 기능» 한 줄을 만드는 함수 (mailmove.capsLine). 주면 결과에 caps 가 찬다 — 폴링 연결이 이미 붙어 있어 연결이 늘지 않는다
 * @returns result — boxErrors 는 폴더별 오류, capped 는 밀린 구간에서 건너뛴 통수, genUp 은 세대가 올랐는지.
 *                   rejected 는 이번에 처음 못 받은 새 메일 통수(폴더 오류가 아니다), boxPaths 는 이번에 LIST 로 본 폴더.
 *                   폴더 오류가 있고 받은 폴더가 하나도 없으면 첫 오류를 던진다.
 */
async function backupAccount(account, dir, { onProgress, shouldStop, onlyNew = false, dirProblem = null, unanswered = false, mineOf = null, capsOf = null } = {}) {
  const root = path.dirname(boxDirFor(dir, account, 'INBOX'));
  fs.mkdirSync(root, { recursive: true });

  // 기록을 들고 있지 않는다 — 폴더마다 다시 읽고 patchState 로 적는다. 들고 있으면 겹친 실행의 기록을 옛 값으로 덮는다.
  // 못 읽으면 여기서 던진다(연결 전이다). 깨졌으면 비키고 새로 시작한다
  const { broken } = readStateInfo(dir);
  const accKey = accountKey(account);

  const client = mail.connect(account, { timeoutMs: TIMEOUT_MS });
  await client.connect();
  const result = {
    saved: 0, skipped: 0, mailboxes: 0, stopped: false, bytes: 0, seeded: 0, missing: 0, capped: 0, genUp: false, rejected: 0, boxPaths: [],
    stateError: broken ? '진행 기록이 깨져 새로 시작했습니다' : null, boxErrors: []
  };
  if (typeof capsOf === 'function') {
    try { result.caps = capsOf(client); } catch { /* 한 줄을 못 만들어도 저장은 한다 */ }
  }
  let firstError = null;
  let okBoxes = 0;
  let writeFailed = false;   // 디스크 쪽 문제 — 다음 폴더도 같으니 멈춘다
  let openDir = null;
  try {
    const boxes = await listBoxes(client);
    result.boxPaths = boxes.map((b) => b.path);
    const sentBox = mail.pickBox(boxes, 'sent');

    // 뒤 받기가 일부만 온 LIST 로 «대상 아님»을 적었으면 — 다 받은 계정은 회차가 안 돌아 아무도 표시를 지우지 않는다
    const mine = typeof mineOf === 'function' ? mineOf(client) : null;
    if (mine) {
      const per = readStateInfo(dir).state[accKey] || {};
      for (const b of boxes) {
        if (!per[b.path] || !per[b.path].fillSkip || !mine(b)) continue;
        const { error } = patchState(dir, accKey, b.path, { fillSkip: undefined });
        if (error && !result.stateError) result.stateError = error;
      }
    }

    const oneBox = async (entry) => {
      const boxPath = entry.path;
      const box = await client.mailboxOpen(boxPath, { readOnly: true });
      result.mailboxes += 1;

      const key = boxPath;
      const v = String(box.uidValidity);
      const per = readStateInfo(dir).state[accKey] || {};
      const prev = per[key] || {};
      // 답에 UIDVALIDITY가 빠지면 폴더 오류다. 그대로 두면 String(undefined)가 다른 값으로 읽혀 세대가 오르고, 다음 정상 답에서 또 오른다.
      // 다만 기록도 같은 나쁜 값이면 «늘 안 주는 서버»다 (옛 버전이 "undefined"·"0" 으로 적고 잘 저장해 왔다) — 막으면 새 메일 저장이 통째로 멈춘다.
      // 세대를 가를 수 없으니 색인은 쓰지 않고 새 파일만 받는다. 뒤 받기도 이 폴더를 건너뛴다 (mailfill noValidity)
      const noV = !goodV(box.uidValidity);
      if (noV && (prev.uidValidity == null || String(prev.uidValidity) !== v)) throw new Error(`${boxPath}: 서버가 UIDVALIDITY를 주지 않습니다`);

      // 서버가 UID를 새로 매겼으면 여태 받은 것과 이어붙일 수 없다
      const fresh = String(prev.uidValidity) !== v;

      // 처음 보는 폴더인데 새 것만 받는 모드면, 여기까지는 받은 셈 치고 표시만 남긴다.
      if (fresh && onlyNew) {
        const made = await ensureBox(client, dir, account, boxPath, box);
        if (made.genUp) result.genUp = true;
        if (made.error && !result.stateError) result.stateError = made.error;
        result.seeded += 1;
        return;
      }

      const top = await topOf(client, box, boxPath);
      const genUp = prev.uidValidity != null && fresh;
      if (genUp) result.genUp = true;
      // 번호가 새로 매겨졌으면 세대를 올려 예전 파일과 섞이지 않게 한다
      const gen0 = genUp
        ? Math.max(1, Number(prev.gen) || 1) + 1
        : Math.max(1, Number(prev.gen) || 1);
      const gen = fresh ? clearOfTwins(per, boxPath, gen0) : gen0;

      // low..last 사이는 이미 다 받았다는 뜻이다.
      // lowUid가 없는 옛 기록은 1부터 받았던 것이므로 1로 본다.
      let low = fresh ? 1 : (prev.lowUid == null ? 1 : Number(prev.lowUid) || 1);
      let last = fresh ? 0 : (Number(prev.lastUid) || 0);

      const boxDir = boxDirFor(dir, account, boxPath, gen);
      // 폴더를 한 번만 훑어 이미 있는 UID를 모아둔다 — 통마다 디스크를 뒤지면 느리다
      let have = null;
      const exists = Number.isFinite(box.exists) ? { exists: box.exists } : {};
      const remember = () => {
        const { error } = patchState(dir, accKey, key, { uidValidity: v, gen, lowUid: low, lastUid: last, ...exists });
        if (error && !result.stateError) result.stateError = error;
      };

      // 밀린 구간 상한 — 자동 저장이 꺼져 있던 동안 쌓인 메일을 묻기 전에, 멈출 수 없이 받지 않는다.
      // UID는 띄엄띄엄이라 폭만 보면 안 된다. 실제 200통이 넘을 때만 맨 위 200통을 받고, 구멍은 low 아래로 넘긴다
      // («low..last 사이는 다 받았다»를 지켜야 옛 코드와 «백업 시작»이 메운다). fillHead:false 라 답이 yes 면 뒤 받기가 메운다.
      // 답이 없는 계정의 몫은 계정 전체다. 폴더마다 주면 폴더 10개에 2,000통을 묻기 전에 받는다. 몫이 바닥나면 폴더 전체가 구멍이다
      const cap = unanswered ? Math.max(0, NEW_CAP - result.saved) : NEW_CAP;
      let known = null;    // 서버가 답한 실제 UID — 있으면 빈칸을 걷지 않는다
      if (onlyNew && top - last > cap) {
        const found = await client.search({ uid: `${last + 1}:${top}` }, { uid: true });
        // 끊겨서 false 가 온 것을 «많다»로 읽으면 없는 구멍을 만든다
        if (!Array.isArray(found) && client.usable === false) throw new Error(`${boxPath}: 연결이 끊겼습니다`);
        let from = null;
        let skipped = 0;
        if (Array.isArray(found)) {
          const uids = found.filter((u) => u > last && u <= top).sort((x, y) => x - y);
          known = uids;
          if (uids.length > cap) {
            from = cap > 0 ? uids[uids.length - cap] : top + 1;
            skipped = uids.length - cap;
          }
        } else {
          from = top - cap + 1;
          skipped = from - (last + 1);
        }
        if (from != null) {
          // 남은 수도 지운다 — 구멍은 그 수에 없다. 낡은 수가 남으면 질문이 «최대 10통»이라고 말하고 수백 통을 받는다
          const { error } = patchState(dir, accKey, key,
            { uidValidity: v, gen, lowUid: from, lastUid: from - 1, ...exists, fillHead: false, fillLeft: undefined, fillLeftBytes: undefined }, { raiseLow: true });
          if (error && !result.stateError) result.stateError = error;
          low = from;
          last = from - 1;
          result.capped += skipped;
        }
        if (known) known = known.filter((u) => u > last);
      }

      // 지난번에 거절된 메일 — 위치는 이미 지나갔으니 한 통씩 따로 부른다
      const retry = onlyNew ? retriesOf(dir, accKey, boxPath, v) : new Map();
      const due = [...retry.keys()];

      // 받아올 두 구간: 새로 온 것(위)과 아직 못 받은 지난 것(아래).
      // 자동 백업은 위쪽만 본다.
      const newSpan = Math.max(0, top - last);
      const oldSpan = onlyNew ? 0 : Math.max(0, Math.min(low - 1, top));
      // UID는 지운 자리만큼 비어 있다. 칸 수를 그대로 쓰면 실제 통수보다 훨씬 커서
      // 진행 막대가 0% 근처에 붙어 있는 것처럼 보인다 — 실제 통수로 눌러준다.
      const span = newSpan + oldSpan;
      const total = Number.isFinite(box.exists) && box.exists > 0
        ? Math.max(1, Math.min(span, box.exists))
        : span;
      let done = 0;

      if (span === 0 && !due.length) {
        // 받을 게 없어도 위치는 갱신해 둔다 (빈 폴더·이미 최신)
        if (last < top) last = top;
        // 새 메일 길은 lowUid 를 내리지 않는다. UIDNEXT 없는 서버의 빈 답 한 번(top 0)으로 «아래는 다 받았다»가 되면 지난 메일을 영영 안 받는다
        if (!onlyNew && top > 0 && low > top + 1) low = top + 1;
        remember();
        return;
      }

      fs.mkdirSync(boxDir, { recursive: true });
      have = await uidFiles(boxDir);
      if (!have) throw new Error(`${boxPath}: 저장 폴더를 읽을 수 없습니다`);
      openDir = boxDir;
      // 폴더 첫 저장 전에 적는다 — 상태 파일을 잃으면 이것으로 세대를 가른다 (freeGen)
      if (!noV) {
        await mailindex.ensureMeta(boxDir, {
          acc: accKey, user: account.user, host: account.host, box: boxPath, uidValidity: v, gen,
          use: entry.specialUse || (entry === sentBox ? '\\Sent' : '')
        });
      }
      const indexRow = (line) => { if (!noV) mailindex.append(boxDir, line); };

      const settled = new Set();   // 이번 판에 결론이 난 UID — 한 통씩 다시 받을 때 건너뛴다
      // 못 받은 수를 상태에 올려 둔다. 다 받은 계정은 아무도 그 폴더를 열지 않아, 이 값이 없으면 자리표를 영영 다시 안 본다.
      // 폴더 오류가 아니다 — 폴더는 잘 열렸고 저장도 되는데 «못 연 폴더»나 «자동 백업 실패»로 말하면 안 된다. 진짜 수는 뒤 받기가 색인으로 다시 센다
      const noteFail = (by) => {
        if (noV) return;   // 뒤 받기가 안 여는 폴더다 — 수를 올리면 하루마다 할 일 없는 연결을 만든다
        const cur = (readStateInfo(dir).state[accKey] || {})[key] || {};
        const { error } = patchState(dir, accKey, key, { fillFail: Math.max(0, (Number(cur.fillFail) || 0) + by) }, { expectV: v });
        if (error && !result.stateError) result.stateError = error;
      };
      const finish = (uid) => {
        settled.add(uid);
        if (retry.delete(uid)) noteFail(-1);
      };
      // 서버가 그 명령만 거절했다(tagged NO·BAD) — 연결은 살아 있다. 끊긴 것은 여기 들지 않는다 (mailfwd fetchEach 와 같은 판정)
      const refused = (e) => !!e && (e.responseStatus === 'NO' || e.responseStatus === 'BAD') && client.usable !== false;
      // 못 받은 메일 때문에 위쪽 메일이 막히면 안 된다 — 자리표를 남기고 위치는 지나간다.
      // 묶음 전체를 다시 받지 않는다. 뒤 받기는 uid ≤ lastUid 만 보므로, 이 줄이 없으면 아무도 메우지 못한다
      const giveUp = (uid) => {
        const n = (retry.get(uid) || 0) + 1;
        if (n === 1) {
          noteFail(1);
          result.rejected += 1;
        }
        // 그만 부르는 메일은 목록에서 뺀다. 줄과 수는 남아 뒤 받기의 몫이다
        if (n >= NEW_RETRIES) retry.delete(uid);
        else retry.set(uid, n);
        settled.add(uid);
        indexRow({ uid, st: 'head', fails: n, via: 'new' });
      };
      const tick = () => {
        done += 1;
        if (onProgress && done % 5 === 0) {
          onProgress({ mailbox: boxPath, done, total, saved: result.saved, skipped: result.skipped });
        }
      };

      const saveMsg = async (msg) => {
        // 서버가 먼저 보낸 알림 줄에는 UID가 없다 — 메일이 아니다
        if (!Number.isInteger(msg.uid)) return;
        // 원문이 안 오면 그 통은 못 받은 것이다. 범위는 그대로 지나가므로
        // 조용히 넘기면 영영 빠진 채 «완료»가 된다 — 몇 통이 빠졌는지는 남긴다.
        if (!msg.source) {
          result.missing += 1;
          if (retry.has(msg.uid)) {
            giveUp(msg.uid);
          } else {
            settled.add(msg.uid);
            indexRow(mailindex.rowFromFetch(msg, 'new'));
            noteFail(1);
            result.rejected += 1;
          }
          return;
        }
        const files = have.get(msg.uid);
        if (files) {
          // 번호만 같고 다른 메일일 수 있다 — 상태 파일을 잃고 메타도 없는 폴더에서는 세대를 못 올려 UID가 옛 파일과 겹친다
          const mid = msg.envelope && msg.envelope.messageId;
          let same = false;
          for (const f of files) {
            if ((await mailindex.fileMatches(f, mid, msg.size)).same) { same = true; break; }
          }
          if (same) {
            result.skipped += 1;
            finish(msg.uid);
            tick();
            return;
          }
        }
        let saved;
        try {
          saved = await commit(boxDir, {
            uid: msg.uid,
            // 못 읽는 날짜 하나가 묶음 전체를 던지면 안 된다 (mail.timeOf)
            receivedAt: mail.timeOf(msg.internalDate) || Date.now(),
            subject: (msg.envelope && msg.envelope.subject) || '',
            source: msg.source
          });
        } catch (e) {
          // 디스크가 찼거나 폴더 탓이면 멈춘다. 프로브가 지나가면 메일 탓이다 — 백신이 막은 메일 하나가 그 위를 막지 않게 한다
          const mailsFault = onlyNew && e.code !== 'ENOSPC' && typeof dirProblem === 'function' && !dirProblem(dir);
          if (!mailsFault) {
            writeFailed = true;
            throw e;
          }
          giveUp(msg.uid);
          return;
        }
        have.set(msg.uid, [...(files || []), path.join(boxDir, saved.name)]);
        indexRow({ ...mailindex.rowFromFetch(msg, 'new'), file: saved.name, bytes: saved.bytes, st: 'file' });
        result.saved += 1;
        result.bytes += msg.source.length;
        finish(msg.uid);
        tick();
      };

      // 옵션 객체는 호출마다 새로 준다 — imapflow 가 받은 옵션을 고쳐 쓴다 (resolveRange)
      const query = () => ({ uid: true, envelope: true, internalDate: true, flags: true, size: true, source: true });

      const takeOne = async (uid) => {
        try {
          for await (const msg of client.fetch([uid], query(), { uid: true })) await saveMsg(msg);
        } catch (e) {
          if (!refused(e)) throw e;
        }
        if (!settled.has(uid)) giveUp(uid);
      };

      const take = async (a, z) => {
        try {
          for await (const msg of client.fetch(`${a}:${z}`, query(), { uid: true })) await saveMsg(msg);
        } catch (e) {
          // 전체 받기는 지금처럼 그 폴더를 멈춘다. 자리표로 지나가는 것은 새 메일 경로뿐이다
          if (!onlyNew || !refused(e)) throw e;
          // 메일 하나 때문에 서버가 묶음을 통째로 거절했다 (O365 «Message cannot be fetched» 등) — 실제 UID를 얻어 한 통씩 받는다
          const uids = await client.search({ uid: `${a}:${z}` }, { uid: true });
          if (!Array.isArray(uids)) throw e;
          for (const uid of uids) {
            if (!settled.has(uid)) await takeOne(uid);
          }
        }
      };

      for (const uid of due) {
        if (shouldStop && shouldStop()) { result.stopped = true; break; }
        await takeOne(uid);
      }

      // ① 새로 온 것 — 급한 쪽부터
      // 실제 UID 를 알면 그것만 묶어 받는다. 간격이 수만이면 50칸씩 걷는 동안 모든 계정의 뒤 받기가 막힌다 (autoBackup.running)
      let from = last + 1;
      let knownAt = 0;
      while (!result.stopped && from <= top) {
        if (shouldStop && shouldStop()) { result.stopped = true; break; }
        let first = from;
        let to = Math.min(from + BATCH - 1, top);
        if (known) {
          if (knownAt >= known.length) {
            last = top;
            remember();
            break;
          }
          first = known[knownAt];
          to = known[Math.min(knownAt + BATCH, known.length) - 1];
          knownAt += BATCH;
        }
        await take(first, to);
        last = to;              // 여기까지 확보. 끊겨도 다음엔 여기서 이어간다
        if (low > last) low = from;   // 처음 받는 폴더면 아래 끝도 여기서 시작한다
        remember();
        from = to + 1;
      }

      // ② 아직 못 받은 지난 것 — 위에서 아래로 내려간다.
      // 아래에서 위로 올라가면 "어디까지 받았나"를 한 숫자로 적을 수 없어 이어받기가 깨진다.
      // 뒤 받기가 맡은 폴더의 빈 답에는 내려가지 않는다 — 받은 것 없이 lowUid 가 1 이 되면 confirmBox 를 안 거치고 «다 받음»으로 읽힌다
      if (!result.stopped && !onlyNew && (Number(box.exists) > 0 || !prev.fillHead)) {
        let to = Math.min(low - 1, top);
        while (to >= 1) {
          if (shouldStop && shouldStop()) { result.stopped = true; break; }
          const a = Math.max(1, to - BATCH + 1);
          await take(a, to);
          low = a;
          remember();
          to = a - 1;
        }
      }

      // 거절된 메일만 다시 부른 판 — 위치는 그대로, 통수만 적어 둔다
      if (span === 0) remember();

      if (onProgress) {
        onProgress({ mailbox: boxPath, done, total, saved: result.saved, skipped: result.skipped });
      }
    };

    // 몫이 계정 전체면 받은편지함이 먼저다 — 새 메일이 다른 폴더에 밀려 구멍으로 넘어가면 안 된다
    const order = unanswered ? [...boxes].sort((x, y) => Number(/^inbox$/i.test(y.path)) - Number(/^inbox$/i.test(x.path))) : boxes;
    for (const entry of order) {
      if (shouldStop && shouldStop()) { result.stopped = true; break; }
      let halt = false;
      // 앞 폴더 실패가 뒤 폴더(INBOX 등)를 막지 않게 폴더마다 잡는다
      try {
        await oneBox(entry);
        okBoxes += 1;
      } catch (e) {
        if (!firstError) firstError = e;
        const why = mail.friendly(e);
        result.boxErrors.push(why.startsWith(`${entry.path}: `) ? why : `${entry.path}: ${why}`);
        // 연결이 죽었거나 디스크에 못 쓰면 다음 폴더도 같다
        halt = client.usable === false || writeFailed;
      } finally {
        // 못 쓴 줄은 버퍼에 남는다. 파일이 있는 줄을 잃어도 reconcile 이 메운다
        if (openDir) await mailindex.flush(openDir);
        openDir = null;
      }
      if (halt || result.stopped) break;
    }
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
  // 지금 호출부의 실패 처리가 그대로 동작하게 한다 — 한 폴더도 못 받았으면 계정 실패다
  if (firstError && !okBoxes) throw firstError;
  return result;
}

/**
 * 같은 UID 파일이 둘이면 나중에 받은 것. 상태 파일을 잃고 번호가 새로 매겨진 폴더에서는 일부러 하나 더 받는다 —
 * 이름순으로 앞의 것을 주면 받아 놓은 맞는 파일을 두고 번호만 같은 옛 메일을 연다.
 * @param files 전체 경로 목록 @returns 경로 | null
 */
function newestOf(files) {
  if (!files || !files.length) return null;
  if (files.length === 1) return files[0];
  let best = files[0];
  let at = -Infinity;
  for (const f of files) {
    let t;
    try { t = fs.statSync(f).mtimeMs; } catch { continue; }
    if (t > at) { at = t; best = f; }
  }
  return best;
}

/**
 * 이미 백업해둔 메일이 있나 — 있으면 그 파일 경로.
 * 자동 백업을 켜둔 사람은 본문이 이미 디스크에 다 있다 —
 * 그걸 두고 서버를 다시 부르는 것은 느린 서버에 대한 예의가 아니다.
 */
function savedFile(dir, account, mailbox, uid) {
  if (!dir) return null;
  const want = Number(uid);
  if (!Number.isInteger(want) || want <= 0) return null;
  try {
    const boxDir = boxDirFor(dir, account, mailbox, genOf(loadState(dir), account, mailbox));
    const found = [];
    for (const n of fs.readdirSync(boxDir)) {
      const m = n.match(UID_IN_NAME);
      if (m && Number(m[1]) === want) found.push(path.join(boxDir, n));
    }
    return newestOf(found);
  } catch { /* 폴더가 없거나 못 읽으면 그냥 없는 것으로 */ }
  return null;
}

/** savedFile 과 같은 일을 비동기로 — 메일을 여는 길이 폴더 목록을 읽느라 화면을 멈추지 않게 */
async function findSaved(dir, account, mailbox, uid) {
  if (!dir) return null;
  const want = Number(uid);
  if (!Number.isInteger(want) || want <= 0) return null;
  try {
    const boxDir = boxDirFor(dir, account, mailbox, genOf(loadState(dir), account, mailbox));
    const files = await uidFiles(boxDir);
    return newestOf(files && files.get(want));
  } catch {
    return null;   // 폴더가 없거나 못 읽으면 그냥 없는 것으로
  }
}

module.exports = {
  savedFile, findSaved, newestOf,
  backupAccount, saveOne, safeName, loadState, uidsIn, boxDirFor, genOf, STATE_FILE,
  accountKey, backsUp, uidFiles,
  readStateInfo, saveState, patchState, commit, ensureBox, listBoxes
};

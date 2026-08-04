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

const STATE_FILE = 'backup-state.json';
const BATCH = 50;              // 한 번에 받아올 통수 (너무 크면 서버가 끊는다)

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
 */
function boxDirFor(dir, account, mailbox, gen = 1) {
  const rawAcc = `${account.name || ''} ${account.user || ''}`.trim() || '계정';
  const acc = safeName(rawAcc, 46);

  const rawBox = String(mailbox || 'INBOX');
  let name = safeName(rawBox.replace(/[\\/]/g, '_'), 40);
  if (name !== rawBox) name = `${name}~${tag(rawBox)}`;

  return path.join(dir,
    acc === rawAcc ? acc : `${acc}~${tag(rawAcc)}`,
    gen > 1 ? `${name} (${gen})` : name);
}

/** 이 폴더를 지금 몇 세대로 쓰고 있나 (기록이 없으면 1) */
function genOf(state, account, mailbox) {
  const per = (state[accountKey(account)] || {})[mailbox || 'INBOX'];
  return Math.max(1, Number(per && per.gen) || 1);
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

/**
 * 메일 한 통을 파일로 쓴다.
 * @returns 'saved' | 'skipped'
 */
function writeMessage(boxDir, { uid, receivedAt, subject, source }, have) {
  if (have && have.has(uid)) return 'skipped';
  const d = new Date(receivedAt || Date.now());

  // 먼저 임시 이름으로 다 쓰고 나서 제 이름을 준다.
  // 쓰는 도중에 디스크가 차거나 전원이 나가면 반쪽짜리 파일이 남는데, 그 이름에 UID가
  // 들어 있으면 "이미 받았다"로 읽혀 그 메일은 영영 다시 받지 못한다.
  // 임시 이름은 uidsIn이 세지 않는 모양으로 짓는다(.eml로 끝나지 않는다).
  const tmp = path.join(boxDir, `~받는중-${uid}.part`);
  const name = (s) => path.join(boxDir, s);
  const full = name(`${stamp(d)}_${uid}_${safeName(subject, 50)}.eml`);
  const plain = name(`${stamp(d)}_${uid}.eml`);

  fs.writeFileSync(tmp, source);
  try {
    fs.renameSync(tmp, full);
  } catch (e) {
    // 윈도우 경로 길이(260자)에 걸리는 제목이 있다. 제목을 빼면 항상 들어간다.
    if (!['ENAMETOOLONG', 'ENOENT', 'EINVAL'].includes(e.code)) {
      try { fs.unlinkSync(tmp); } catch { /* 지우지 못해도 .part는 목록에서 무시된다 */ }
      throw e;
    }
    fs.renameSync(tmp, plain);
  }
  if (have) have.add(uid);
  return 'saved';
}

/**
 * 열어본 메일 한 통을 그 자리에서 저장한다.
 * 본문을 이미 받아왔으므로 서버를 한 번 더 부르지 않는다 — 읽는 순간이 곧 공짜 백업이다.
 *
 * 폴더에 파일이 수만 개면 목록 읽기가 잠깐 걸린다. 메일을 여는 순간에 화면이 멎으면
 * 안 되므로 디스크 작업은 전부 비동기로 한다.
 */
async function saveOne(account, dir, msg) {
  const boxDir = boxDirFor(dir, account, msg.mailbox, genOf(loadState(dir), account, msg.mailbox));
  await fs.promises.mkdir(boxDir, { recursive: true });
  const have = new Set();
  for (const n of await fs.promises.readdir(boxDir)) {
    const m = n.match(UID_IN_NAME);
    if (m) have.add(Number(m[1]));
  }
  if (have.has(msg.uid)) return { saved: false, dir: boxDir };
  await fs.promises.writeFile(path.join(boxDir, `~받는중-${msg.uid}.part`), msg.source);
  const d = new Date(msg.receivedAt || Date.now());
  await fs.promises.rename(
    path.join(boxDir, `~받는중-${msg.uid}.part`),
    path.join(boxDir, `${stamp(d)}_${msg.uid}_${safeName(msg.subject, 50)}.eml`)
  );
  return { saved: true, dir: boxDir };
}

function loadState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')); }
  catch { return {}; }
}

/**
 * 어디까지 받았는지 기록한다.
 * 이걸 못 쓰면 다음 실행이 처음부터 다시 받는다 — 조용히 넘기면 안 되고 알려야 한다.
 * @returns 실패 사유 (성공이면 null)
 */
function saveState(dir, state) {
  const target = path.join(dir, STATE_FILE);
  const body = JSON.stringify(state, null, 2);
  try {
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
    return null;
  } catch (e) {
    // 백신·동기화 프로그램이 원본을 잠깐 잡고 있으면 rename이 막힌다. 직접 써 본다.
    try { fs.writeFileSync(target, body); return null; }
    catch (e2) { return e2.message || e.message; }
  }
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

async function listMailboxes(client) {
  const all = await client.list();
  return all
    .filter((b) => !b.flags.has('\\Noselect'))
    .filter((b) => !SKIP_USE.includes(b.specialUse) && !SKIP_NAME.test(b.name))
    .map((b) => b.path);
}

/**
 * 한 계정을 백업한다.
 * @param onProgress { mailbox, done, total, saved, skipped } 를 받는다
 * @param shouldStop 중간에 멈출지 물어보는 함수 (자리에 돌아왔을 때 등)
 * @param onlyNew    아직 한 번도 받은 적 없는 폴더는 "지금부터"로 표시만 하고 넘어간다.
 *                   자동 백업이 켜지자마자 몇 년치를 몰래 내려받는 일을 막는다 —
 *                   지난 메일은 사용자가 «백업 시작»을 눌러야 받는다.
 */
async function backupAccount(account, dir, { onProgress, shouldStop, onlyNew = false } = {}) {
  const root = path.dirname(boxDirFor(dir, account, 'INBOX'));
  fs.mkdirSync(root, { recursive: true });

  const state = loadState(dir);
  const accKey = accountKey(account);
  if (!state[accKey]) state[accKey] = {};

  const client = mail.connect(account);
  await client.connect();
  const result = { saved: 0, skipped: 0, mailboxes: 0, stopped: false, bytes: 0, seeded: 0, missing: 0, stateError: null };
  try {
    const boxes = await listMailboxes(client);
    for (const boxPath of boxes) {
      if (shouldStop && shouldStop()) { result.stopped = true; break; }

      const box = await client.mailboxOpen(boxPath, { readOnly: true });
      result.mailboxes += 1;

      const key = boxPath;
      const prev = state[accKey][key] || {};

      // UIDNEXT는 RFC상 «주는 게 좋다»일 뿐이라 안 주는 서버가 있다.
      // 그냥 빼면 NaN이 되어 두 반복문이 다 건너뛰고 «0통 저장, 완료»가 된다 —
      // 아무것도 안 받고 다 받았다고 말하는 최악의 경우다. 직접 물어본다.
      let top;
      if (Number.isFinite(box.uidNext)) {
        top = box.uidNext - 1;
      } else if (!box.exists) {
        top = 0;
      } else {
        const all = await client.search({ all: true }, { uid: true }) || [];
        if (!all.length) throw new Error(`${boxPath}: 서버가 UID를 알려주지 않습니다`);
        top = Math.max(...all);
      }
      // 서버가 UID를 새로 매겼으면 여태 받은 것과 이어붙일 수 없다
      const fresh = String(prev.uidValidity) !== String(box.uidValidity);
      // 번호가 새로 매겨졌으면 세대를 올려 예전 파일과 섞이지 않게 한다
      const gen = (prev.uidValidity != null && fresh)
        ? Math.max(1, Number(prev.gen) || 1) + 1
        : Math.max(1, Number(prev.gen) || 1);

      // 처음 보는 폴더인데 새 것만 받는 모드면, 여기까지는 받은 셈 치고 표시만 남긴다.
      // lowUid를 여기 찍어두기 때문에, 나중에 «백업 시작»을 누르면 그 아래를 받으러 간다.
      if (fresh && onlyNew) {
        state[accKey][key] = {
          uidValidity: String(box.uidValidity), gen, lowUid: top + 1, lastUid: top
        };
        saveState(dir, state);
        result.seeded += 1;
        continue;
      }

      // low..last 사이는 이미 다 받았다는 뜻이다.
      // lowUid가 없는 옛 기록은 1부터 받았던 것이므로 1로 본다.
      let low = fresh ? 1 : (prev.lowUid == null ? 1 : Number(prev.lowUid) || 1);
      let last = fresh ? 0 : (Number(prev.lastUid) || 0);

      const boxDir = boxDirFor(dir, account, boxPath, gen);
      // 폴더를 한 번만 훑어 이미 있는 UID를 모아둔다 — 통마다 디스크를 뒤지면 느리다
      let have = null;
      const remember = () => {
        state[accKey][key] = {
          uidValidity: String(box.uidValidity), gen, lowUid: low, lastUid: last
        };
        const bad = saveState(dir, state);
        if (bad && !result.stateError) result.stateError = bad;
      };

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

      if (span === 0) {
        // 받을 게 없어도 위치는 갱신해 둔다 (빈 폴더·이미 최신)
        if (last < top) last = top;
        if (low > top + 1) low = top + 1;
        remember();
        continue;
      }

      fs.mkdirSync(boxDir, { recursive: true });
      have = uidsIn(boxDir);

      const take = async (a, z) => {
        for await (const msg of client.fetch(`${a}:${z}`,
          { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })) {
          // 원문이 안 오면 그 통은 못 받은 것이다. 범위는 그대로 지나가므로
          // 조용히 넘기면 영영 빠진 채 «완료»가 된다 — 몇 통이 빠졌는지는 남긴다.
          if (!msg.source) { result.missing += 1; continue; }
          const written = writeMessage(boxDir, {
            uid: msg.uid,
            receivedAt: (msg.internalDate || new Date()).getTime(),
            subject: (msg.envelope && msg.envelope.subject) || '',
            source: msg.source
          }, have);
          if (written === 'saved') {
            result.saved += 1;
            result.bytes += msg.source.length;
          } else {
            result.skipped += 1;
          }
          done += 1;
          if (onProgress && done % 5 === 0) {
            onProgress({ mailbox: boxPath, done, total, saved: result.saved, skipped: result.skipped });
          }
        }
      };

      // ① 새로 온 것 — 급한 쪽부터
      let from = last + 1;
      while (from <= top) {
        if (shouldStop && shouldStop()) { result.stopped = true; break; }
        const to = Math.min(from + BATCH - 1, top);
        await take(from, to);
        last = to;              // 여기까지 확보. 끊겨도 다음엔 여기서 이어간다
        if (low > last) low = from;   // 처음 받는 폴더면 아래 끝도 여기서 시작한다
        remember();
        from = to + 1;
      }

      // ② 아직 못 받은 지난 것 — 위에서 아래로 내려간다.
      // 아래에서 위로 올라가면 "어디까지 받았나"를 한 숫자로 적을 수 없어 이어받기가 깨진다.
      if (!result.stopped && !onlyNew) {
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

      if (onProgress) {
        onProgress({ mailbox: boxPath, done, total, saved: result.saved, skipped: result.skipped });
      }
      if (result.stopped) break;
    }
  } finally {
    saveState(dir, state);
    try { await client.logout(); } catch { client.close(); }
  }
  return result;
}

module.exports = {
  backupAccount, saveOne, safeName, loadState, uidsIn, boxDirFor, genOf, STATE_FILE
};

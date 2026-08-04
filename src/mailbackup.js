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

function loadState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')); }
  catch { return {}; }
}

function saveState(dir, state) {
  try {
    const tmp = path.join(dir, STATE_FILE + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, path.join(dir, STATE_FILE));
  } catch { /* 상태를 못 써도 백업 자체는 남는다 */ }
}

/**
 * 백업할 폴더 목록.
 * 스팸·휴지통은 뺀다 — 지우려고 넣어둔 것까지 받으면 시간만 몇 배가 든다.
 * 서버가 알려주는 용도(specialUse)를 먼저 보고, 없으면 이름으로 짐작한다.
 */
const SKIP_USE = ['\\Junk', '\\Trash', '\\All'];
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
 */
async function backupAccount(account, dir, { onProgress, shouldStop } = {}) {
  const root = path.join(dir, safeName(account.name || account.user, 40));
  fs.mkdirSync(root, { recursive: true });

  const state = loadState(dir);
  const accKey = account.id || account.user;
  if (!state[accKey]) state[accKey] = {};

  const client = mail.connect(account);
  await client.connect();
  const result = { saved: 0, skipped: 0, mailboxes: 0, stopped: false, bytes: 0 };
  try {
    const boxes = await listMailboxes(client);
    for (const boxPath of boxes) {
      if (shouldStop && shouldStop()) { result.stopped = true; break; }

      const box = await client.mailboxOpen(boxPath, { readOnly: true });
      result.mailboxes += 1;

      const key = boxPath;
      const prev = state[accKey][key] || {};
      // 서버가 UID를 새로 매겼으면 여태 받은 것과 이어붙일 수 없다
      const fresh = String(prev.uidValidity) !== String(box.uidValidity);
      let from = fresh ? 1 : (Number(prev.lastUid) || 0) + 1;

      if (box.exists === 0 || from > box.uidNext - 1) {
        state[accKey][key] = { uidValidity: String(box.uidValidity), lastUid: box.uidNext - 1 };
        continue;
      }

      const boxDir = path.join(root, safeName(boxPath.replace(/[\\/]/g, '_'), 40));
      fs.mkdirSync(boxDir, { recursive: true });

      let lastUid = Number(prev.lastUid) || 0;
      let done = 0;
      const total = Math.max(0, (box.uidNext - 1) - from + 1);

      while (from <= box.uidNext - 1) {
        if (shouldStop && shouldStop()) { result.stopped = true; break; }
        const to = Math.min(from + BATCH - 1, box.uidNext - 1);

        for await (const msg of client.fetch(`${from}:${to}`,
          { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })) {
          if (!msg.source) continue;
          const d = msg.internalDate || new Date();
          const subject = safeName((msg.envelope && msg.envelope.subject) || '', 50);
          const file = path.join(boxDir, `${stamp(d)}_${msg.uid}_${subject}.eml`);
          if (fs.existsSync(file)) {
            result.skipped += 1;
          } else {
            try {
              fs.writeFileSync(file, msg.source);
            } catch (e) {
              // 윈도우 경로 길이(260자)에 걸리는 제목이 있다. 제목을 빼면 항상 들어간다.
              if (e.code !== 'ENAMETOOLONG' && e.code !== 'ENOENT') throw e;
              fs.writeFileSync(path.join(boxDir, `${stamp(d)}_${msg.uid}.eml`), msg.source);
            }
            result.saved += 1;
            result.bytes += msg.source.length;
          }
          if (msg.uid > lastUid) lastUid = msg.uid;
          done += 1;
          if (onProgress && done % 5 === 0) {
            onProgress({ mailbox: boxPath, done, total, saved: result.saved, skipped: result.skipped });
          }
        }

        // 배치마다 저장해둔다 — 여기서 끊겨도 다음에 이어받는다
        state[accKey][key] = { uidValidity: String(box.uidValidity), lastUid };
        saveState(dir, state);
        from = to + 1;
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

module.exports = { backupAccount, safeName, loadState, STATE_FILE };

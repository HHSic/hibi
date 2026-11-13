// 본문 미리 받기 — 곳간(mailcache.js) 위의 «언제 무엇을 채울까» 층.
//
// 목록을 읽을 때 본문까지 뒤에서 받아둔다. 그래야 메일을 두 번 눌렀을 때 창이
// 곧바로 뜬다 — 이 서버는 본문 한 통에도 몇 초가 걸린다.
// 자동 백업이 켜져 있으면 이미 .eml 로 디스크에 있으니 그걸 먼저 쓴다 (localOrServer).
//
// 바깥에는 «로컬이냐 서버냐»(localOrServer), «미리 받기»(prefetchBodies),
// «지금 아는 메일 전부»(knownMessages) 셋만 내준다.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const evlog = require('./evlog');
const mail = require('./mail');
const mailcache = require('./mailcache');
const mailbackup = require('./mailbackup');

// 계정과 «지금 받아둔 목록»은 main.js 가 들고 있다. 순환 require 대신 시작할 때 받아 둔다.
// mailState 는 객체 그대로 받는다 — 복사하면 갱신을 못 본다.
// backupMoving: 백업 폴더를 옮기는 중인가 (backup.moving) — 그동안은 백업 파일을 읽지 않는다 (옮기는 사이에 사라지거나 반쯤 있다)
let host = { mailAccountsForUse: () => [], mailState: { messages: [], folders: [], groups: [], sent: null }, backupMoving: () => false };
function init(h) { host = { ...host, ...h }; }

// 목록을 읽을 때 본문까지 미리 받아둔다. 그래야 메일을 두 번 눌렀을 때 창이
// 곳바로 뜼다 — 이 서버는 본문 한 통에도 몇 초가 걸린다.
const CACHE_DIR = () => path.join(app.getPath('userData'), 'mailcache');
const PREFETCH_MAX = 12;
let prefetching = false;

/** 이 메일의 원문이 이미 디스크에 있나 — 백업본이 먼저다 (같은 것을 두 번 두지 않게) */
async function localSource(acc, mailbox, uid) {
  const dir = store.settings.mailBackupDir;
  if (dir && store.settings.mailAutoBackup && !host.backupMoving()) {
    // 비동기로 읽는다 — 항상 저장하게 되면 폴더에 파일이 수만 개라 메일을 여는 순간 화면이 멎는다
    const f = await mailbackup.findSaved(dir, acc, mailbox || acc.mailbox || 'INBOX', uid);
    if (f) {
      try { return await fs.promises.readFile(f); } catch { /* 그 사이 지워졌으면 곳간을 본다 */ }
    }
  }
  return mailcache.read(CACHE_DIR(), acc.id, mailbox, uid);
}

/**
 * 본문 한 통 — 디스크에 있으면 거기서, 없으면 서버에서.
 * 읽음 상태는 원문에 없으므로 목록이 아는 값을 넘긴다.
 */
async function localOrServer(acc, msg) {
  const box = msg.mailbox || '';
  const allowRemote = store.settings.mailRemoteImages !== false;
  const src = await localSource(acc, box, msg.uid);
  if (src) {
    evlog.log('메일', `본문 · 디스크에서 바로 열음 (uid ${msg.uid})`);
    return mail.viewFromSource(src, {
      uid: msg.uid,
      mailbox: box || acc.mailbox || 'INBOX',
      seen: !!msg.seen,
      receivedAt: msg.at || 0,
      allowRemote
    });
  }
  const got = await mail.fetchBody(acc, msg.uid, { markSeen: false, allowRemote, mailbox: box });
  // 받은 김에 적어둔다 — 같은 메일을 다시 열 때는 서버를 안 부른다
  if (got && got.source) {
    mailcache.write(CACHE_DIR(), acc.id, got.mailbox || box, msg.uid, got.source);
  }
  return got;
}

/**
 * 자동 저장이 켜져 있을 때 곳간에 미리 받을 UID — 저장 안 된 옛 메일만.
 * uid > lastUid 는 곧 자동 저장이 받는다. 이 조건이 없으면 같은 메일을 두 번 받는다.
 * 자르기는 거른 뒤에 한다. 먼저 자르면 맨 위 12통이 모두 저장된 메일일 때 옛 메일에 영영 닿지 않는다.
 */
async function unsavedUids(acc, saveDir, slot) {
  // 답이 yes·paused 인 계정은 뒤 받기 몫이고, 앞쪽 연결이 뒤 받기를 끊는다
  if (['yes', 'paused'].includes((store.settings.mailFill || {})[acc.id])) return [];
  const boxPath = slot.mailbox || acc.mailbox || 'INBOX';
  const rec = (mailbackup.loadState(saveDir)[mailbackup.accountKey(acc)] || {})[boxPath];
  // 기록이 없으면 건너뛴다. 곧 자동 저장이 표시한다
  if (!rec) return [];
  const files = await mailbackup.uidFiles(mailbackup.boxDirFor(saveDir, acc, boxPath, rec.gen));
  return slot.uids.filter((u) => u <= rec.lastUid && !(files && files.has(u))).slice(0, PREFETCH_MAX);
}

/**
 * 목록에 있는데 아직 원문이 없는 것들을 뒤에서 받아둔다.
 * 자동 저장이 켜져 있어도 돌아가지 않는다 — 저장 안 된 옛 메일이 메일을 열 때마다 서버를 기다리지 않게.
 */
async function prefetchBodies() {
  if (prefetching) return;
  const dir = CACHE_DIR();
  const byAccount = new Map();
  for (const m of host.mailState.messages) {
    if (!m.accountId || !m.uid) continue;
    const box = m.mailbox || '';
    if (mailcache.has(dir, m.accountId, box, m.uid)) continue;
    const k = m.accountId + '|' + box;
    if (!byAccount.has(k)) byAccount.set(k, { accountId: m.accountId, mailbox: box, uids: [] });
    byAccount.get(k).uids.push(m.uid);
  }
  if (!byAccount.size) return;

  const saveDir = store.settings.mailAutoBackup && store.settings.mailBackupDir;
  // 백업 폴더를 옮기는 중이면 이번에는 건너뛴다 — 무엇이 저장됐는지 그 폴더의 기록을 읽어야 한다. 다음 목록 읽기 때 다시 본다
  if (saveDir && host.backupMoving()) return;
  prefetching = true;
  try {
    for (const slot of byAccount.values()) {
      const acc = host.mailAccountsForUse().find((a) => a.id === slot.accountId);
      if (!acc) continue;
      try {
        const uids = saveDir ? await unsavedUids(acc, saveDir, slot) : slot.uids.slice(0, PREFETCH_MAX);
        if (!uids.length) continue;
        const n = await mail.fetchSources(acc, uids, {
          mailbox: slot.mailbox,
          onOne: (one) => mailcache.write(dir, acc.id, one.mailbox, one.uid, one.source)
        });
        if (n) evlog.log('메일', `본문 미리 받기 · ${n}통`);
      } catch (e) {
        // 미리 받기는 덕이지 의무가 아니다 — 안 되면 열 때 서버를 부르면 그만이다
        evlog.log('메일', `미리 받기 건너뜀 — ${mail.friendly(e)}`);
      }
    }
    mailcache.sweep(dir);
  } finally {
    prefetching = false;
  }
}

/** 화면이 지금 알고 있는 메일 전부 (보이는 것 · 묶인 것 · 숨긴 것 · 보낸 것) */
function knownMessages() {
  return [
    ...host.mailState.messages,
    ...host.mailState.groups.flatMap((g) => g.items),
    ...host.mailState.folders.filter((f) => f.id === 'hidden').flatMap((f) => f.items),
    ...host.mailState.sent.messages
  ];
}

module.exports = { init, localOrServer, prefetchBodies, knownMessages };

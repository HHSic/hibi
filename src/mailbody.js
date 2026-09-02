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
let host = { mailAccountsForUse: () => [], mailState: { messages: [], folders: [], groups: [], sent: null } };
function init(h) { host = { ...host, ...h }; }

// 목록을 읽을 때 본문까지 미리 받아둔다. 그래야 메일을 두 번 눌렀을 때 창이
// 곳바로 뜼다 — 이 서버는 본문 한 통에도 몇 초가 걸린다.
const CACHE_DIR = () => path.join(app.getPath('userData'), 'mailcache');
const PREFETCH_MAX = 12;
let prefetching = false;

/** 이 메일의 원문이 이미 디스크에 있나 — 백업본이 먼저다 (같은 것을 두 번 두지 않게) */
function localSource(acc, mailbox, uid) {
  const dir = store.settings.mailBackupDir;
  if (dir && store.settings.mailAutoBackup) {
    const f = mailbackup.savedFile(dir, acc, mailbox || acc.mailbox || 'INBOX', uid);
    if (f) {
      try { return fs.readFileSync(f); } catch { /* 그 사이 지워졌으면 곳간을 본다 */ }
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
  const src = localSource(acc, box, msg.uid);
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
 * 목록에 있는데 아직 원문이 없는 것들을 뒤에서 받아둔다.
 * 자동 백업이 켜져 있으면 그쪽이 이미 다 받아 놓으므로 여기선 건드리지 않는다.
 */
async function prefetchBodies() {
  if (prefetching) return;
  if (store.settings.mailAutoBackup && store.settings.mailBackupDir) return;
  const dir = CACHE_DIR();
  const byAccount = new Map();
  for (const m of host.mailState.messages) {
    if (!m.accountId || !m.uid) continue;
    const box = m.mailbox || '';
    if (mailcache.has(dir, m.accountId, box, m.uid)) continue;
    const k = m.accountId + '|' + box;
    if (!byAccount.has(k)) byAccount.set(k, { accountId: m.accountId, mailbox: box, uids: [] });
    const slot = byAccount.get(k);
    if (slot.uids.length < PREFETCH_MAX) slot.uids.push(m.uid);
  }
  if (!byAccount.size) return;

  prefetching = true;
  try {
    for (const slot of byAccount.values()) {
      const acc = host.mailAccountsForUse().find((a) => a.id === slot.accountId);
      if (!acc) continue;
      try {
        const n = await mail.fetchSources(acc, slot.uids, {
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

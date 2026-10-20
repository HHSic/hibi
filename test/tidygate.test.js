'use strict';
// 서버 정리의 문 — 메인 쪽 확인 창·일반 설정 길 막기·잠금·상태 (src/backup.js · src/store.js).
//
// 창을 하나도 띄우지 않는다. main.js 도 싣지 않는다 — backup.js 를 바로 부르고,
// 메일 서버(mail.connect)·백업(mailbackup.backupAccount)·확인 창(popup.askUser)·폴더 고르기(dialog)는
// 바꿔 끼운다. 진짜 메일 서버·자격 증명 관리자는 건드리지 않는다.
//   [1] 기본값  [2] 일반 설정 길은 서버 정리 설정을 못 바꾼다  [3] 정해진 길의 값 다듬기
//   [4] 전제(자동 백업·메일 확인)를 끄면 정리도 꺼지고, 다시 켜도 저절로 켜지지 않는다
//   [5] 정적 검사 — 정해진 길을 부르는 곳·막는 자리  [6] 상태 모양
//   [7]~[16] 켜기 확인 (setTidy)  [17] 백업과 서로 막기  [18] 폴더를 바꾸면 끈다
//   [19] 도는 중에 기간을 늘리거나 계정을 끄면 멈춘다
//   [6b] 꺼져 있으면(기본값) 자동 백업이 돌아도 정리하지 않는다
//   [20] 켠 뒤 유예 안에는 돌지 않고, 그 전에 끄면 아무것도 옮기지 않는다   [21] 줄이려고 세는 동안 끄면 묻지 않는다
//   [22] PC 의 정리 기록을 못 읽으면 켜지 않는다   [23] «백업 시작»의 강제 끊기는 그때 돌던 정리만
//   [24] 옮기는 중에 끊기면 «옮겨졌을 수 있음»을 남기고 목록을 다시 읽는다
//   [25] «바로»(0일) — 0이 30으로 바뀌지 않고, «바로»로·«바로»에서 바꾸기는 묻고, 짧은 간격으로 돌고,
//        읽은 것만 옮기며, 보기 창에 떠 있는 메일은 건너뛴다
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidygate-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));
// 예전 버전이 남긴 설정 파일 — 서버 정리 키가 없고, 손으로 고친 기간 15일이 들어 있다
fs.mkdirSync(path.join(tmp, 'Hibi'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Hibi', 'nunsseom.json'),
  JSON.stringify({ settings: { mailCount: 5, mailTidyDays: 15 }, layoutVersion: 3 }));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return !!fn();
}

const DAY = 86_400_000;
const V = 1700000000n;

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  const lines = [];
  evlog.log = (s, m) => { lines.push(`${s}|${m}`); };
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
  const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
  // backup.js 가 tidyAll 에 무엇을 넘기는지 본다 — 한 번에 옮기는 상한(cap)·시간 몫(budgetMs)이 실제 실행 길에서 지켜지는지
  const tidyCalls = [];
  const realTidyAll = mailtidy.tidyAll;
  mailtidy.tidyAll = (accs, d, o = {}) => {
    tidyCalls.push({ dryRun: !!o.dryRun, cap: o.cap, budgetMs: o.budgetMs, days: o.days, inView: typeof o.inView === 'function' });
    return realTidyAll(accs, d, o);
  };
  const popup = require(path.join(ROOT, 'src', 'popup.js'));
  const { dialog } = require('electron');
  const { makeServer } = require(path.join(ROOT, 'test', 'fixtures', 'fake-imap.js'));

  // ── 가짜 메일 서버 ──
  const mk = (uid, o = {}) => {
    const id = o.id || `m${uid}@corp.example`;
    const date = new Date(Date.now() - (o.daysAgo == null ? 60 : o.daysAgo) * DAY);
    const raw = `Message-ID: <${id}>\r\nDate: ${date.toUTCString()}\r\nFrom: Kim <kim@corp.example>\r\n`
      + `Subject: report ${uid}\r\nMIME-Version: 1.0\r\n\r\nbody ${uid}\r\n`;
    return { uid, raw, date, subject: `report ${uid}`, messageId: `<${id}>`, flags: [], labels: [] };
  };
  const acct = (id) => ({ id, name: `회사${id}`, user: `${id}@corp.example`, host: `imap.${id}.invalid`, port: 993 });
  const A1 = acct('a1');
  const A2 = acct('a2');
  const A3 = acct('a3');
  const server = makeServer({
    a1: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [mk(1000), mk(1003), mk(1007, { daysAgo: 3 })] }, { path: 'Trash', specialUse: '\\Trash', uidValidity: V, msgs: [] }] },
    a2: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [mk(1000)] }] },   // 휴지통 없음
    a3: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [] }, { path: 'Trash', specialUse: '\\Trash', uidValidity: V, msgs: [] }] }
  });
  const dir = path.join(tmp, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const st = {};
  for (const a of [A1, A2, A3]) st[mailbackup.accountKey(a)] = { INBOX: { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 99999 } };
  fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify(st));
  const fileOf = (acc, m) => {
    const bd = mailbackup.boxDirFor(dir, acc, 'INBOX', 1);
    fs.mkdirSync(bd, { recursive: true });
    fs.writeFileSync(path.join(bd, `20250101_0900_${m.uid}_제목.eml`), Buffer.from(m.raw, 'latin1'));
  };
  for (const m of server.box('a1', 'INBOX').msgs) fileOf(A1, m);
  for (const m of server.box('a2', 'INBOX').msgs) fileOf(A2, m);
  /** 서버에 오래된 메일 한 통을 더하고, 원하면 PC에도 저장해 둔다 */
  const addMail = (acc, uid, { file = true, daysAgo = 60, seen = false } = {}) => {
    const m = mk(uid, { daysAgo });
    server.box(acc.id, 'INBOX').msgs.push({ ...m, flags: new Set(seen ? ['\\Seen'] : []), labels: new Set() });
    if (file) fileOf(acc, m);
    return m;
  };
  const inbox = (id) => server.box(id, 'INBOX').msgs.map((m) => m.uid);
  const trashN = (id) => server.box(id, 'Trash').msgs.length;
  const searches = () => server.log.filter((e) => e.cmd === 'search').length;
  const moveCalls = () => server.log.filter((e) => e.cmd === 'messageMove').length;
  const setDelay = (id, d) => { server.spec[id].delay = d; };

  // ── 바꿔 끼우기 ──
  mail.connect = (acc) => server.connect(acc);
  const backupCalls = [];
  let backupDelay = 0;
  mailbackup.backupAccount = async (acc, d, o = {}) => {
    backupCalls.push({ acc: acc.id, onlyNew: !!o.onlyNew, at: Date.now() });
    if (backupDelay) await sleep(backupDelay);
    return { saved: 0, skipped: 0, seeded: 0, missing: 0, mailboxes: 0, stateError: null };
  };
  const asks = [];
  let answer = 1;
  let gate = null;   // 확인 창을 열어 둔 채로 기다리게 할 때
  popup.askUser = async (parent, o) => {
    asks.push(o);
    if (gate) await gate.promise;
    return typeof answer === 'function' ? answer(o) : answer;
  };
  const hold = () => { let open; const promise = new Promise((r) => { open = r; }); gate = { promise, open: (v) => { gate = null; open(v); } }; return gate; };
  let dialogs = 0;
  let pickPath = dir;
  dialog.showOpenDialog = async () => { dialogs += 1; return { canceled: false, filePaths: [pickPath] }; };
  ok(dialog.showOpenDialog.toString().includes('dialogs'), '(대화상자를 바꿔 끼웠다)');

  let accounts = [A1];
  let live = () => true;
  let refreshed = 0;
  const backup = require(path.join(ROOT, 'src', 'backup.js'));
  backup.init({
    mailAccountsForUse: () => accounts,
    refreshMail: () => { refreshed += 1; },
    isSettingsWin: () => true,
    accountLive: (a) => live(a),
    tidyTiming: { FIRST_MS: 0, START_MS: 50, AGAIN_MS: 50, KICK_SLACK_MS: 20, GAP_MS: 3600_000, STOP_GRACE_MS: 300, MAX_MS: 5000 }
  });
  const parent = { gone: false, isDestroyed() { return this.gone; } };
  const T = () => backup.backupStatus().tidy;
  const S = (o) => ({ on: o.tidy.on, days: o.tidy.days, kind: o.tidy.messageKind, msg: o.tidy.message });
  const set = (req, o = {}) => backup.setTidy(req, 'parent' in o ? o.parent : parent, { fromSettings: true, ...o });
  // 정리가 다음 자동 백업 뒤에 곧 돌게 — 수동 백업이 끝나면 정리 시각을 당긴다
  const quickBackup = async () => {
    await backup.startBackup();
    await until(() => !backup.backupStatus().running);
  };

  console.log('\n[1] 기본값');
  ok(store.settings.mailServerTidy === false && store.settings.mailTidyLast === null, '예전 설정 파일(키 없음)을 읽어도 꺼짐·기록 없음이 채워진다', [store.settings.mailServerTidy, store.settings.mailTidyLast]);
  ok(store.settings.mailTidyDays === 15 && T().days === 30, '파일에 15일이 있어도 상태의 기간은 30일', [store.settings.mailTidyDays, T().days]);
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'store.js'), 'utf8');
  ok(/mailServerTidy: false,/.test(storeSrc) && /mailTidyDays: 30,/.test(storeSrc) && /mailTidyLast: null,/.test(storeSrc), '새 설정의 기본값은 꺼짐·30일·기록 없음 (DEFAULT_SETTINGS)');

  console.log('\n[2] 일반 설정 길은 서버 정리 설정을 못 바꾼다');
  lines.length = 0;
  store.setSettings({ mailServerTidy: true, mailTidyDays: 7, mailBackupDir: 'C:\\EVIL-DIR', mailTidyLast: { moved: 9 }, mailCount: 9 });
  ok(store.settings.mailServerTidy === false && store.settings.mailTidyDays === 15 && store.settings.mailBackupDir === null
    && store.settings.mailTidyLast === null && store.settings.mailCount === 9, '막힌 키는 그대로, mailCount 만 저장', store.settings.mailCount);
  const disk = store.reloadFromDisk().settings || {};
  ok(disk.mailCount === 9 && disk.mailServerTidy === false && disk.mailBackupDir === null, '디스크에도 막힌 값은 없다', { mailCount: disk.mailCount, tidy: disk.mailServerTidy, dir: disk.mailBackupDir });
  ok(lines.some((l) => /무시/.test(l)) && !lines.some((l) => /EVIL/.test(l)), '기록에 «무시»가 남고 값은 남지 않는다', lines);
  store.setSettings(null);
  store.setSettings(undefined);
  ok(store.settings.mailCount === 9, 'setSettings(null)도 던지지 않는다');

  console.log('\n[3] 정해진 길 — 값 다듬기');
  ok(JSON.stringify(store.TIDY_DAYS) === JSON.stringify(mailtidy.DAYS), 'store.TIDY_DAYS 와 mailtidy.DAYS 가 같다', store.TIDY_DAYS);
  ok(JSON.stringify(store.GATED_SETTINGS) === JSON.stringify(['mailServerTidy', 'mailTidyDays', 'mailBackupDir', 'mailTidyLast']), 'GATED_SETTINGS 네 키', store.GATED_SETTINGS);
  store.setGatedSettings({ mailTidyDays: 15, mailCount: 1 });
  ok(store.settings.mailTidyDays === 30 && store.settings.mailCount === 9, 'setGatedSettings — 15일은 30일로, mailCount 는 무시', [store.settings.mailTidyDays, store.settings.mailCount]);
  store.setGatedSettings({ mailServerTidy: 'yes', mailBackupDir: '' });
  ok(store.settings.mailServerTidy === false && store.settings.mailBackupDir === null, "'yes'는 켜짐이 아니고 빈 폴더는 null");
  store.setGatedSettings({ mailTidyLast: { at: '5', moved: 'x', more: 1, error: 'e'.repeat(300) } });
  const tl = store.settings.mailTidyLast;
  ok(tl.at === 5 && tl.moved === 0 && tl.more === false && tl.error.length === 200 && tl.kept === 0, 'mailTidyLast 를 숫자·참거짓·200자로 다듬는다', tl);
  // 0(바로)은 거짓 값이지만 30으로 바뀌지 않는다 — 메모리에도 디스크에도
  store.setGatedSettings({ mailTidyDays: 0 });
  ok(store.settings.mailTidyDays === 0 && store.reloadFromDisk().settings.mailTidyDays === 0, 'setGatedSettings — 0(바로)은 0 그대로 (디스크에도)', store.settings.mailTidyDays);
  store.setGatedSettings({ mailTidyDays: -0 });
  ok(Object.is(store.settings.mailTidyDays, 0), '…-0 도 0으로');
  for (const v of ['0', false, null, '', 1]) {
    store.setGatedSettings({ mailTidyDays: v });
    ok(store.settings.mailTidyDays === 30, `setGatedSettings — ${JSON.stringify(v)} 은 30`, store.settings.mailTidyDays);
  }
  store.setSettings({ mailTidyDays: 0 });
  ok(store.settings.mailTidyDays === 30, '일반 설정 길로는 0(바로)도 못 넣는다', store.settings.mailTidyDays);
  store.setGatedSettings({ mailTidyLast: { unread: '4' } });
  ok(store.settings.mailTidyLast.unread === 4, 'mailTidyLast 에 unread(안 읽어 남긴 수)도 숫자로 남긴다', store.settings.mailTidyLast);
  store.setGatedSettings({ mailTidyLast: null, mailBackupDir: dir });
  store.setSettings({ mailEnabled: true, mailAutoBackup: true });

  console.log('\n[4] 전제를 끄면 정리도 꺼진다');
  store.setGatedSettings({ mailServerTidy: true });
  lines.length = 0;
  store.setSettings({ mailAutoBackup: false });
  ok(store.settings.mailServerTidy === false && lines.some((l) => /서버 정리 꺼짐/.test(l)), '«자동으로 백업»을 끄면 정리도 꺼지고 기록이 남는다', lines);
  store.setSettings({ mailAutoBackup: true });
  ok(store.settings.mailServerTidy === false, '자동 백업을 다시 켜도 정리는 저절로 켜지지 않는다');
  store.setGatedSettings({ mailServerTidy: true });
  store.setSettings({ mailEnabled: false });
  ok(store.settings.mailServerTidy === false, '«메일 확인하기»를 꺼도 같다');
  store.setSettings({ mailEnabled: true });
  ok(store.settings.mailServerTidy === false, '…다시 켜도 꺼진 채');
  store.setGatedSettings({ mailServerTidy: true });
  store.setSettings({ mailAutoBackup: true, mailCount: 9 });
  ok(store.settings.mailServerTidy === true, '전제를 끄지 않는 patch 는 정리를 건드리지 않는다');
  store.setGatedSettings({ mailServerTidy: false });

  console.log('\n[5] 정적 검사');
  const srcDir = path.join(ROOT, 'src');
  const srcs = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);
  const callers = srcs.filter(([f, s]) => f !== 'store.js' && /setGatedSettings\(/.test(s)).map(([f]) => f);
  ok(JSON.stringify(callers) === '["backup.js"]', 'setGatedSettings( 를 부르는 곳은 backup.js 뿐', callers);
  const assigns = srcs.filter(([f, s]) => f !== 'store.js' && /\.mailServerTidy\s*=[^=]/.test(s)).map(([f]) => f);
  ok(!assigns.length, 'store.js 밖에 .mailServerTidy = 대입이 없다', assigns);
  const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');
  const setApp = (mainSrc.match(/ipcMain\.on\('settings:set-app',[\s\S]*?\n\}\);/) || [''])[0];
  ok(/store\.setSettings\(patch\)/.test(setApp), 'main.js settings:set-app 은 store.setSettings 로 넘긴다 (거기서 막힌다)');
  const stockSrc = fs.readFileSync(path.join(srcDir, 'stockwin.js'), 'utf8');
  const stockSet = (stockSrc.match(/'stocks:set-app'[\s\S]{0,200}/) || [''])[0];
  ok(/store\.setSettings\(/.test(stockSet), 'stockwin.js stocks:set-app 도 store.setSettings 로 넘긴다');
  const popupSrc = fs.readFileSync(path.join(srcDir, 'popup.js'), 'utf8');
  ok(/kind: 'dialog'[^}]*focusId/.test(popupSrc), 'src/popup.js 가 focusId 를 openPopup 데이터에 싣는다');
  const preSrc = fs.readFileSync(path.join(srcDir, 'preload.js'), 'utf8');
  ok(/mailTidySet: \(req\) => ipcRenderer\.invoke\('mail:tidy-set', req\)/.test(preSrc), 'preload 에 mailTidySet');
  ok(/isSettingsWin: \(wc\) => isSettingsSender\(wc\)/.test(mainSrc) && /refreshMail: \(\) => mailhub\.refreshMail\(\{ force: true \}\)/.test(mainSrc), 'main.js 가 isSettingsWin·refreshMail(force) 를 건넨다');
  // 보기 창에 떠 있는 메일 — main.js 가 mailwin 의 목록을 backup.init 으로 건넨다 (mailwin 시험은 창을 띄우므로 소스로 본다)
  const initSrc = (mainSrc.match(/backup\.init\(\{[\s\S]*?\n\}\);/) || [''])[0];
  ok(/openMailKeys: \(\) => mailwin\.openMailKeys\(\)/.test(initSrc), 'main.js backup.init 에 openMailKeys: () => mailwin.openMailKeys()');
  ok(/markedUnread: \(k\) => mailhub\.seenMarks\.markedUnread\(k\)/.test(initSrc), 'main.js backup.init 에 markedUnread — 방금 «안 읽음»으로 되돌린 메일 (읽음 장부)');
  const winSrc = fs.readFileSync(path.join(srcDir, 'mailwin.js'), 'utf8');
  ok(/module\.exports = \{[^}]*\bopenMailKeys\b/.test(winSrc) && /function openMailKeys\(\) \{\s*return liveMailKeys\(mailWins\.values\(\)\);\s*\}/.test(winSrc)
    && /msg: viewKey\(msg, acc\),/.test(winSrc) && /slot\.msg\.messageId = String\(forView\.messageId \|\| ''\);/.test(winSrc),
  'mailwin.js 가 창마다 viewKey 로 (계정, 폴더, UID)를 들고, 본문이 오면 Message-ID 를 채우고, openMailKeys 는 liveMailKeys 로 내준다');
  {
    // 열쇠 만들기·살아 있는 창 고르기는 동작으로 본다 — 창은 띄우지 않는다 (가짜 창 객체)
    const mailwin = require(path.join(srcDir, 'mailwin.js'));
    const vk = mailwin.viewKey({ accountId: 'a1', mailbox: '', uid: '12' }, { mailbox: 'INBOX' });
    ok(JSON.stringify(vk) === JSON.stringify({ accountId: 'a1', mailbox: 'INBOX', uid: 12, messageId: '' }), 'viewKey — 빈 폴더는 기본값, UID 는 숫자, Message-ID 는 본문이 오기 전엔 빈 글', vk);
    const boxes5 = [
      mailwin.viewKey({ accountId: 'a1', uid: 5 }, { mailbox: 'Work' }).mailbox,
      mailwin.viewKey({ accountId: 'a1', uid: 5 }, null).mailbox,
      mailwin.viewKey({ accountId: 'a1', mailbox: 'Sent', uid: 5 }, { mailbox: 'Work' }).mailbox
    ];
    ok(JSON.stringify(boxes5) === '["Work","INBOX","Sent"]', 'viewKey — 폴더가 비면 계정의 mailbox, 그것도 없으면 INBOX (받아 올 때와 같은 기본값), 메일의 폴더가 먼저', boxes5);
    const alive = { isDestroyed: () => false };
    const dead = { isDestroyed: () => true };
    const lk = mailwin.liveMailKeys([
      { win: alive, msg: vk }, { win: dead, msg: { accountId: 'a1', mailbox: 'INBOX', uid: 13 } },
      { win: alive, msg: null }, { win: null, msg: { accountId: 'a1', mailbox: 'INBOX', uid: 14 } }, null
    ]);
    ok(lk.length === 1 && lk[0].uid === 12 && lk[0] !== vk, 'liveMailKeys — 닫힌 창·메일 없는 창은 빼고, 살아 있는 창의 열쇠를 사본으로', lk);
    lk[0].uid = 99;
    ok(vk.uid === 12 && mailwin.liveMailKeys([]).length === 0, '…사본이라 받는 쪽이 고쳐도 창의 열쇠는 그대로, 창이 없으면 빈 목록');
  }
  {
    // 읽음 장부 — «안 읽음»으로 되돌린 표시가 있을 때만 참 (표시가 없거나 «읽음»이거나 시간이 지났으면 거짓)
    const { SeenMarks } = require(path.join(srcDir, 'mailmark.js'));
    const sm = new SeenMarks({ ttlMs: 1000 });
    const k = { accountId: 'a1', mailbox: '', uid: 7 };
    const r0 = sm.markedUnread(k);
    sm.mark(k, false, 5000);
    const r1 = [sm.markedUnread({ ...k, mailbox: 'INBOX' }, 5500), sm.markedUnread(k, 6001), sm.markedUnread({ ...k, uid: 8 }, 5500)];
    sm.mark(k, true, 5000);
    const r2 = sm.markedUnread(k, 5500);
    ok(r0 === false && JSON.stringify(r1) === '[true,false,false]' && r2 === false,
      'SeenMarks.markedUnread — 표시 없음·«읽음» 표시·시간 지남은 거짓, «안 읽음» 표시만 참 (빈 폴더는 INBOX)', { r0, r1, r2 });
  }

  console.log('\n[6] 상태 모양');
  const s6 = backup.backupStatus();
  const KEYS = ['on', 'days', 'ready', 'why', 'running', 'asking', 'at', 'moved', 'kept', 'unsaved', 'unverified', 'spared', 'unread', 'skippedBoxes', 'more', 'error', 'total', 'cap', 'everyMin', 'message', 'messageKind'];
  ok(KEYS.every((k) => k in s6.tidy) && 'waiting' in s6, 'tidy 에 계약의 키가 모두 있고 waiting 이 있다', Object.keys(s6.tidy));
  ok(s6.tidy.ready === true && s6.tidy.why === '' && s6.tidy.cap === 300 && s6.tidy.on === false, '조건을 갖췄고 꺼져 있다', { ready: s6.tidy.ready, cap: s6.tidy.cap });
  {
    // «바로»가 실제로 도는 주기 — 메일 확인 주기(mailPollMin)와 «바로»의 짧은 간격(5분) 중 긴 것
    const every = [s6.tidy.everyMin];
    store.setSettings({ mailPollMin: 30 });
    every.push(T().everyMin);
    store.setSettings({ mailPollMin: 2 });
    every.push(T().everyMin);
    store.setSettings({ mailPollMin: 10 });
    ok(JSON.stringify(every) === '[10,30,5]', 'everyMin — 메일 확인 10분이면 10, 30분이면 30, 2분이면 «바로» 간격 5', every);
  }

  console.log('\n[6b] 꺼져 있으면(기본값) 자동 백업이 돌아도 정리하지 않는다');
  {
    // 자동 백업을 쓰는 사람은 모두 이 길을 지난다 — 켜지 않았는데 정리가 돌면 확인 창(S5)을 건너뛴 것이다
    const quiet = () => ({ s: searches(), m: moveCalls(), c: server.clients.length, at: T().at, last: store.settings.mailTidyLast, runs: tidyCalls.length });
    const q0 = quiet();
    const b0 = backupCalls.length;
    await backup.autoBackupNew({ now: true });
    ok(backupCalls.length === b0 + 1, '(자동 백업은 한 바퀴 돌았다 — 시험이 헛돌지 않는다)', backupCalls.length - b0);
    ok(JSON.stringify(quiet()) === JSON.stringify(q0) && q0.at === 0 && q0.last === null && !T().running,
      '연결·검색·옮기기 0, 정리를 부르지도 않고 마지막 결과도 남지 않는다', { before: q0, after: quiet() });
    const r6 = await set({ days: 7 });
    ok(r6.tidy.on === false && r6.tidy.days === 7, '(꺼진 채 기간만 7일로)');
    await backup.autoBackupNew({ now: true });
    ok(JSON.stringify(quiet()) === JSON.stringify(q0), '꺼진 채 기간만 바꿔도 돌지 않는다', quiet());
    await set({ days: 30 });
    backupCalls.length = 0;
  }

  console.log('\n[7] 설정 창에서만, 조건을 갖춰야');
  store.setSettings({ mailAutoBackup: false });
  let r = await set({ on: true });
  ok(r.tidy.messageKind === 'bad' && /자동으로 백업/.test(r.tidy.message) && asks.length === 0 && r.tidy.on === false, '자동 백업이 꺼져 있으면 거절 (묻지 않는다)', S(r));
  ok(r.tidy.ready === false && /자동으로 백업/.test(r.tidy.why), '…상태에도 까닭이 보인다', r.tidy.why);
  store.setSettings({ mailAutoBackup: true });
  r = await set({ on: true }, { fromSettings: false });
  ok(/설정 창에서만/.test(r.tidy.message) && asks.length === 0, '설정 창이 아닌 곳에서 켜기 → 거절', S(r));
  r = await set({ on: true }, { parent: null });
  ok(/설정 창에서만/.test(r.tidy.message) && asks.length === 0, '부모 창이 없으면 → 거절', S(r));

  console.log('\n[8] 묻고, 고른 대로');
  let mark = server.log.length;
  answer = 1;
  r = await set({ on: true });
  ok(r.tidy.on === false && r.tidy.messageKind === 'wait' && /그만뒀습니다/.test(r.tidy.message) && asks.length === 1, '«그만두기» → 꺼진 채', S(r));
  answer = null;
  r = await set({ on: true });
  ok(r.tidy.on === false && /그만뒀습니다/.test(r.tidy.message), '창을 그냥 닫음(null) → 꺼진 채', S(r));
  answer = 0;
  r = await set({ on: true });
  const during = server.log.slice(mark);
  ok(r.tidy.on === true && r.tidy.messageKind === 'good' && /켰습니다/.test(r.tidy.message), '«서버 정리 켜기» → 켜진다', S(r));
  const q = asks[asks.length - 1];
  ok(q.danger === true && q.defaultId === 0 && q.focusId === 1 && q.buttons[0] === '서버 정리 켜기' && q.buttons[1] === '그만두기',
    '확인 창 — 위험(빨강)은 켜기 단추, 초점은 «그만두기»', { danger: q.danger, defaultId: q.defaultId, focusId: q.focusId, buttons: q.buttons });
  ok(/받은 지 30일 지난 메일 약 2통/.test(q.message) && /별표/.test(q.detail) && /받은 지 30일 지난 메일을/.test(q.detail)
    && /되찾은 메일은 다시 옮기지 않습니다/.test(q.detail),
  '«약 2통»을 세어 보여 준다 — 기간과 «되찾은 메일은 다시 옮기지 않음»은 몇 통인지 못 세도 보이게 detail 에', q.message);
  ok(during.filter((e) => e.cmd === 'mailboxOpen').every((e) => e.readOnly) && !during.some((e) => e.cmd === 'messageMove'),
    '세는 동안 폴더는 모두 읽기 전용, 옮기기 0', during.filter((e) => e.cmd === 'mailboxOpen').map((e) => e.readOnly));

  console.log('\n[9] 켠 뒤 곧 돈다');
  ok(await until(() => T().at > 0), '정리가 한 번 돌았다', T().at);
  ok(T().moved === 2 && trashN('a1') === 2 && JSON.stringify(inbox('a1')) === '[1007]', '확인된 2통을 옮겼다 (젊은 1통은 남김)', { moved: T().moved, inbox: inbox('a1') });
  ok(await until(() => refreshed === 1), '옮긴 뒤 메일 목록을 다시 읽었다', refreshed);
  ok(store.settings.mailTidyLast && store.settings.mailTidyLast.moved === 2, '마지막 결과(mailTidyLast)가 저장됐다', store.settings.mailTidyLast);
  ok(backupCalls.length === 1 && backupCalls[0].onlyNew, '자동 백업 한 바퀴 뒤에 돌았다', backupCalls);
  ok(lines.length > 0 && !lines.some((l) => l.includes('@') || /report/.test(l)), '기록에 주소·제목이 없다', lines.filter((l) => l.includes('@') || /report/.test(l)));
  ok(lines.some((l) => /서버 정리 · 2통 휴지통으로/.test(l)), '기록에 «서버 정리 · 2통 휴지통으로»', lines.filter((l) => /서버 정리/.test(l)));
  const runs9 = tidyCalls.filter((c) => !c.dryRun);
  ok(runs9.length >= 1 && runs9.every((c) => c.cap === undefined || c.cap <= mailtidy.CAP),
    `실제 정리는 한 번에 옮기는 상한(${mailtidy.CAP}통)을 넘겨 부르지 않는다 (세기만 상한 없이)`, runs9);
  ok(runs9.every((c) => c.budgetMs > 0 && c.budgetMs < 5000), '…계정마다 나눌 전체 시간(budgetMs)을 바깥 상한(MAX_MS)보다 짧게 준다', runs9);

  console.log('\n[10] 간격');
  const mv10 = moveCalls();
  await backup.autoBackupNew({ now: true });
  ok(moveCalls() === mv10 && T().moved === 2, '곧바로 다시 불러도 정리는 돌지 않는다 (3시간 간격)', moveCalls());

  console.log('\n[11] 기간 바꾸기');
  let n = asks.length;
  r = await set({ days: 90 });
  ok(asks.length === n && r.tidy.days === 90 && /90일 지난 메일만/.test(r.tidy.message), '켜진 채 30→90 은 묻지 않는다', S(r));
  answer = 1;
  r = await set({ days: 7 });
  ok(asks.length === n + 1 && r.tidy.days === 90 && /그만뒀습니다/.test(r.tidy.message), '90→7 은 묻고, 그만두면 90일로 남는다', S(r));
  ok(asks[asks.length - 1].buttons[0] === '7일로 줄이기' && /기간 줄이기/.test(asks[asks.length - 1].title), '…«7일로 줄이기» 단추', asks[asks.length - 1].buttons);
  const g11 = hold();
  answer = 0;
  const p11 = set({ days: 7 });
  await until(() => asks.length === n + 2);
  const off11 = await backup.setTidy({ on: false }, null, { fromSettings: false });
  ok(off11.tidy.on === false && /껐습니다/.test(off11.tidy.message) && off11.tidy.asking === true, '묻는 동안에도 끄기는 받는다 (어느 창에서든)', S(off11));
  g11.open();
  r = await p11;
  ok(r.tidy.on === false && r.tidy.days === 7 && store.settings.mailServerTidy === false && /꺼져 있어 기간만 7일/.test(r.tidy.message), '그 뒤 «줄이기»를 골라도 꺼진 채 기간만 7일', S(r));
  ok(r.tidy.asking === false, '돌려줄 때는 asking 이 내려가 있다');

  console.log('\n[12] 끄기·같은 요청·이상한 요청');
  store.setGatedSettings({ mailServerTidy: true });
  n = asks.length;
  r = await set({ on: false }, { fromSettings: false });
  ok(r.tidy.on === false && r.tidy.message === '껐습니다.' && asks.length === n, '끄기는 묻지 않는다', S(r));
  r = await set({ on: false });
  ok(r.tidy.message === '' && r.tidy.messageKind === '', '같은 요청을 다시 → message 는 빈 글', S(r));
  r = await set({ days: 90 });
  ok(/켜면 받은 지 90일/.test(r.tidy.message) && r.tidy.on === false && asks.length === n, '꺼진 채 기간 바꾸기 → «켜면 받은 지 90일»', S(r));
  r = await set({ days: 7 });
  ok(/켜면 받은 지 7일/.test(r.tidy.message) && asks.length === n, '꺼진 채 90→7 도 묻지 않는다 (아무것도 옮기지 않으므로)', S(r));
  r = await set({ days: 30 });
  let threw = null;
  try {
    r = await backup.setTidy(null, parent, { fromSettings: true });
    ok(r && r.tidy && r.tidy.message === '', 'setTidy(null) → 바뀐 것 없음', S(r));
    r = await backup.setTidy(5, parent, { fromSettings: true });
    r = await backup.setTidy({ days: '7', on: 'yes' }, parent, { fromSettings: true });
    ok(r.tidy.days === 30 && r.tidy.on === false && asks.length === n, "setTidy(5)·{ days:'7', on:'yes' } 는 던지지 않고 바꾸지도 않는다", S(r));
  } catch (e) { threw = e; }
  ok(!threw, '이상한 요청에도 던지지 않는다', threw && threw.message);

  console.log('\n[13] 세기가 늦으면');
  setDelay('a1', { search: 1000 });
  answer = 1;
  n = asks.length;
  const c13 = server.clients.length;
  r = await set({ on: true }, { countMs: 200 });
  const q13 = asks[asks.length - 1];
  ok(asks.length === n + 1 && /세지 못했습니다/.test(q13.message), '200ms 안에 못 세면 «세지 못했습니다»라고 묻는다', q13.message);
  ok(/받은 지 \d+일 지난 메일을/.test(q13.detail), '…몇 통인지 몰라도 무엇을 옮기는지(기간)는 detail 에 있다', q13.detail);
  const late = server.clients.slice(c13);
  ok(late.length >= 1 && late.every((c) => c.closed), '늦은 세기의 연결은 끊는다', late.map((c) => c.closed));
  setDelay('a1', undefined);
  await sleep(50);

  console.log('\n[14] 확인 창이 떠 있는 동안 또 켜기');
  const g14 = hold();
  answer = 1;
  n = asks.length;
  const p14 = set({ on: true });
  await until(() => asks.length === n + 1);
  r = await set({ on: true });
  ok(asks.length === n + 1 && r.tidy.messageKind === 'wait' && /확인 창이 떠 있습니다/.test(r.tidy.message), '두 번째 요청은 묻지 않고 «거기서 골라주세요»', S(r));
  g14.open();
  r = await p14;
  ok(r.tidy.on === false, '…첫 요청은 고른 대로 (그만두기)');

  console.log('\n[15] 세는 동안 설정 창을 닫으면');
  setDelay('a1', { search: 300 });
  const p2 = { gone: false, isDestroyed() { return this.gone; } };
  n = asks.length;
  const p15 = set({ on: true }, { parent: p2 });
  setTimeout(() => { p2.gone = true; }, 50);
  r = await p15;
  ok(asks.length === n && r.tidy.on === false && /설정 창이 닫혀/.test(r.tidy.message), '묻지 않고 그만둔다', S(r));
  setDelay('a1', undefined);

  console.log('\n[16] 정리할 수 있는 계정이 없으면');
  accounts = [A2];
  answer = 1;
  await set({ on: true });
  const q16 = asks[asks.length - 1];
  ok(/정리할 수 있는 계정이 없습니다/.test(q16.message) && /휴지통/.test(q16.message) && !/옮길 메일이 없습니다/.test(q16.message), '«옮길 메일이 없다»가 아니라 까닭을 말한다', q16.message);
  accounts = [A1];

  console.log('\n[17] 백업과 서로 막기');
  // (a) 정리 중 «백업 시작» — 바로 돌아오고, 정리를 비키게 한 뒤 이어서 시작한다
  answer = 0;
  r = await set({ on: true });
  ok(r.tidy.on === true, '(켰다)');
  setDelay('a1', { search: 1500 });
  ok(await until(() => T().running), '(정리가 도는 중)');
  let t0 = Date.now();
  let s = await backup.startBackup();
  ok(Date.now() - t0 < 200 && s.running === true && /서버 정리를 멈추는 중/.test(s.waiting), '(a) 바로 돌아오고 waiting 에 «서버 정리를 멈추는 중»', { waiting: s.waiting, ms: Date.now() - t0 });
  ok(await until(() => !T().running, 3000) && Date.now() - t0 < 1300, '…걸린 명령은 기다리지 않고 끊어 정리가 곧 끝난다', Date.now() - t0);
  ok(T().more === true && T().moved === 0, '…정리는 «남음»으로 끝났다', { more: T().more, moved: T().moved });
  ok(await until(() => backupCalls.some((c) => !c.onlyNew)), '…끝나자 수동 백업이 시작됐다', backupCalls);
  await until(() => !backup.backupStatus().running);
  setDelay('a1', undefined);

  // (b) 수동 백업 중 자동 백업 → 정리도 돌지 않는다
  backupDelay = 500;
  let b0 = backupCalls.length;
  let s0 = searches();
  await backup.startBackup();
  await until(() => backupCalls.length === b0 + 1);
  await backup.autoBackupNew({ now: true });
  ok(searches() === s0 && backupCalls.length === b0 + 1, '(b) 수동 백업 중 자동 백업을 불러도 정리 0회', { searches: searches() - s0 });
  await until(() => !backup.backupStatus().running);
  backupDelay = 0;

  // (c) 정리 중 자동 백업 → 백업 0회   (d) 정리 중 폴더 바꾸기 → 거절
  setDelay('a1', { search: 800 });
  const pRun = backup.autoBackupNew({ now: true });
  ok(await until(() => T().running), '(정리가 도는 중)');
  b0 = backupCalls.length;
  await backup.autoBackupNew({ now: true });
  ok(backupCalls.length === b0, '(c) 정리 중 자동 백업 → backupAccount 0회', backupCalls.length - b0);
  const d0 = dialogs;
  s = await backup.pickDir();
  ok(dialogs === d0 && /서버 정리가 도는 중/.test(s.message), '(d) 정리 중 폴더 바꾸기 → 대화상자도 열지 않고 거절', s.message);
  await pRun;
  setDelay('a1', undefined);

  // (e) 자동 백업 중 «백업 시작» → 자동 백업이 끝나도 정리는 돌지 않고 수동 백업이 돈다
  await quickBackup();
  backupDelay = 600;
  const pAuto = backup.autoBackupNew({ now: true });
  await sleep(50);
  s0 = searches();
  const at0 = T().at;
  s = await backup.startBackup();
  ok(/자동 백업이 끝나기를 기다리는 중/.test(s.waiting), '(e) waiting 에 «자동 백업이 끝나기를 기다리는 중»', s.waiting);
  await pAuto;
  ok(searches() === s0 && T().at === at0, '…자동 백업이 끝나도 정리는 시작되지 않는다', { searches: searches() - s0 });
  b0 = backupCalls.filter((c) => !c.onlyNew).length;
  await until(() => !backup.backupStatus().running);
  ok(backupCalls.filter((c) => !c.onlyNew).length >= 1 && /끝났습니다/.test(backup.backupStatus().message), '…수동 백업이 돌았다', backup.backupStatus().message);
  backupDelay = 0;

  // (f) 정리 중 열어본 메일 저장 — 그 실행에서는 옮기지 않는다 (폴더 목록을 찍은 뒤의 새 파일)
  await quickBackup();
  const m3000 = addMail(A1, 3000, { file: false });
  let saidOne = false;
  server.spec.a1.hooks = {
    afterSearch: async () => {
      if (saidOne) return;
      saidOne = true;
      await backup.autoBackupOne(A1, { mailbox: 'INBOX', uid: 3000, receivedAt: m3000.date.getTime(), subject: m3000.subject, source: Buffer.from(m3000.raw, 'latin1') });
    }
  };
  await backup.autoBackupNew({ now: true });
  server.spec.a1.hooks = undefined;
  const saved3000 = fs.readdirSync(mailbackup.boxDirFor(dir, A1, 'INBOX', 1)).some((f) => /_3000_/.test(f));
  ok(saidOne && saved3000 && inbox('a1').includes(3000) && T().unsaved >= 1, '(f) 정리 중에도 열어본 메일은 저장되고, 그 실행에서는 옮기지 않는다', { saved3000, unsaved: T().unsaved });
  await quickBackup();
  await backup.autoBackupNew({ now: true });
  ok(!inbox('a1').includes(3000), '…다음 정리에서 옮긴다', inbox('a1'));

  // (g) 기다리는 동안 멈춤
  backupDelay = 800;
  const pAuto2 = backup.autoBackupNew({ now: true });
  await sleep(50);
  b0 = backupCalls.filter((c) => !c.onlyNew).length;
  s = await backup.startBackup();
  ok(/기다리는 중/.test(s.waiting), '(g) 기다리는 중', s.waiting);
  ipcMain.emit('mail:backup-stop');
  await until(() => !backup.backupStatus().running, 3000);
  ok(/멈췄습니다 — 0통 저장/.test(backup.backupStatus().message) && backupCalls.filter((c) => !c.onlyNew).length === b0, '…멈추면 «멈췄습니다 — 0통 저장», 수동 백업은 돌지 않았다', backup.backupStatus().message);
  await pAuto2;
  backupDelay = 0;

  // (h) 폴더 문제로 «백업 시작»이 거절되면 정리는 비키지 않는다
  await quickBackup();
  addMail(A1, 3100);
  setDelay('a1', { search: 600 });
  const pRun2 = backup.autoBackupNew({ now: true });
  ok(await until(() => T().running), '(정리가 도는 중)');
  const afile = path.join(tmp, 'afile');
  fs.writeFileSync(afile, 'x');
  store.setGatedSettings({ mailBackupDir: path.join(afile, 'sub') });
  s = await backup.startBackup();
  store.setGatedSettings({ mailBackupDir: dir });
  ok(s.running === false && /쓸 수 없습니다/.test(s.message), '(h) 폴더 문제 → «백업 시작» 거절', s.message);
  await pRun2;
  ok(T().moved === 1 && T().more === false && !inbox('a1').includes(3100), '…정리는 멈추지 않고 끝까지 했다', { moved: T().moved, more: T().more });
  setDelay('a1', undefined);

  console.log('\n[18] 폴더를 바꾸면 정리를 끈다');
  ok(store.settings.mailServerTidy === true, '(켜져 있다)');
  const dir2 = path.join(tmp, 'backup2');
  pickPath = dir2;
  s = await backup.pickDir();
  ok(store.settings.mailServerTidy === false && store.settings.mailBackupDir === dir2 && /이전 폴더/.test(s.message) && s.message.includes(dir),
    '다른 폴더 → 정리가 꺼지고 «이전 폴더(…)»를 알린다', s.message);
  {
    const keysIn = (d) => {
      const f = path.join(d, mailtidy.MOVED_FILE);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).keys : [];
    };
    const kOld = keysIn(dir);
    const kNew = keysIn(dir2);
    ok(kOld.length > 0 && kOld.every((k) => kNew.includes(k)), '…옮긴 기록도 새 폴더로 옮겨 적는다 (새 폴더로 다시 켜도 되찾은 메일을 또 옮기지 않게)', { old: kOld.length, now: kNew.length });
  }
  pickPath = dir;
  s = await backup.pickDir();
  store.setGatedSettings({ mailServerTidy: true });
  pickPath = process.platform === 'win32' ? dir.toUpperCase() : dir;
  s = await backup.pickDir();
  ok(store.settings.mailServerTidy === true && s.message === '', '같은 폴더(대소문자만 다름)를 다시 고르면 켜진 채', s.message);
  store.setGatedSettings({ mailBackupDir: dir });

  console.log('\n[19] 도는 중에 기간을 늘리거나 계정을 끄면');
  await quickBackup();
  addMail(A1, 3200);
  setDelay('a1', { search: 600 });
  const pRun3 = backup.autoBackupNew({ now: true });
  ok(await until(() => T().running), '(정리가 도는 중)');
  n = asks.length;
  r = await set({ days: 90 });
  ok(asks.length === n && r.tidy.days === 90, '30→90 은 묻지 않는다', S(r));
  await pRun3;
  const at19 = T().at;
  ok(T().more === true && T().moved === 0 && inbox('a1').includes(3200), '다음 확인 지점에서 멈춘다 (옮기지 않음)', { more: T().more, moved: T().moved });
  ok(await until(() => T().at > at19, 5000), '…새 기간으로 곧 다시 돈다', T().at - at19);
  ok(inbox('a1').includes(3200), '…90일 기준이라 60일 된 메일은 남는다', inbox('a1'));
  setDelay('a1', undefined);
  await until(() => !T().running);

  store.setGatedSettings({ mailTidyDays: 30 });
  addMail(A3, 1000);
  accounts = [A1, A3];
  let a1Live = true;
  live = (a) => a.id !== 'a1' || a1Live;
  server.spec.a1.hooks = { afterSearch: () => { a1Live = false; } };
  await quickBackup();
  await backup.autoBackupNew({ now: true });
  server.spec.a1.hooks = undefined;
  ok(inbox('a1').includes(3200) && trashN('a3') === 1, '도중에 끈 계정은 그 자리에서 멈추고, 다른 계정은 옮긴다', { a1: inbox('a1'), a3Trash: trashN('a3') });
  live = () => true;
  accounts = [A1];
  await until(() => !T().running);

  console.log('\n[20] 켠 뒤 유예 — «1분쯤 뒤 시작, 그 전에 끄면 아무것도 옮기지 않는다»');
  await set({ on: false });
  addMail(A1, 3300);
  await quickBackup();   // 수동 백업이 끝나면 정리 시각이 당겨진다 — 유예 말고는 막는 것이 없는 상태
  answer = 0;
  const mv20 = moveCalls();
  const at20 = T().at;
  r = await set({ on: true }, { startMs: 800 });
  ok(r.tidy.on === true && /분쯤 뒤/.test(r.tidy.message), '(켰다 — 유예 800ms)', S(r));
  const s20 = searches();
  // 폴링·메일 창 열기 끝의 자동 백업 — 마지막 자동 백업에서 2분이 지난 경우와 같다
  await backup.autoBackupNew({ now: true });
  ok(moveCalls() === mv20 && searches() === s20 && T().at === at20, '켠 직후 자동 백업이 돌아도 유예 안에는 정리하지 않는다', { moves: moveCalls() - mv20, searches: searches() - s20 });
  r = await set({ on: false });
  await sleep(800 + 300);   // 켤 때 걸어 둔 예약 타이머가 지나갈 때까지
  ok(moveCalls() === mv20 && inbox('a1').includes(3300) && T().at === at20, '유예 안에 끄면 아무것도 옮기지 않는다 (예약 타이머가 와도)', { moves: moveCalls() - mv20 });
  const t20 = Date.now();
  r = await set({ on: true }, { startMs: 400 });
  ok(await until(() => T().at > at20, 4000) && !inbox('a1').includes(3300) && Date.now() - t20 >= 380, '다시 켜면 유예가 지난 뒤에 옮긴다', Date.now() - t20);

  // 도는 정리가 멈추는 중에 끄고 다시 켰다 — 그 정리가 끝난 뒤 곧바로(AGAIN_MS) 돌지 않고 켤 때 약속한 유예를 지킨다
  addMail(A1, 3400);
  await quickBackup();
  setDelay('a1', { search: 1000 });
  const pRun20 = backup.autoBackupNew({ now: true });
  ok(await until(() => T().running), '(정리가 도는 중)');
  await set({ on: false });
  const t20b = Date.now();
  r = await set({ on: true }, { startMs: 1500, countMs: 100 });
  ok(r.tidy.on === true && T().running, '(도는 중에 끄고 다시 켰다 — 유예 1.5초)', S(r));
  await pRun20;
  setDelay('a1', undefined);
  const at20b = T().at;
  await backup.autoBackupNew({ now: true });
  ok(T().at === at20b && inbox('a1').includes(3400), '…그 정리가 끝난 바로 뒤 자동 백업이 돌아도 정리하지 않는다', { since: Date.now() - t20b });
  ok(await until(() => T().at > at20b, 5000) && !inbox('a1').includes(3400) && Date.now() - t20b >= 1400, '…유예가 지나면 돈다', Date.now() - t20b);

  console.log('\n[21] 기간을 줄이려고 세는 동안 끄면 — 묻지 않는다');
  await until(() => !T().running);
  r = await set({ days: 90 });
  ok(r.tidy.on === true && r.tidy.days === 90, '(켜진 채 90일)', S(r));
  setDelay('a1', { search: 500 });
  n = asks.length;
  answer = 0;
  const p21 = set({ days: 7 });
  await sleep(100);
  const off21 = await backup.setTidy({ on: false }, null, { fromSettings: false });
  ok(off21.tidy.on === false && off21.tidy.asking === true, '(세는 동안 껐다)', S(off21));
  r = await p21;
  ok(asks.length === n && r.tidy.on === false && r.tidy.days === 7 && /꺼져 있어 기간만 7일/.test(r.tidy.message),
    '세기가 끝나도 확인 창을 띄우지 않고, 꺼진 채 기간만 바꾼다', S(r));
  setDelay('a1', undefined);
  await set({ days: 30 });

  console.log('\n[22] PC 의 정리 기록을 못 읽으면 켜지 않는다');
  {
    const movedFile = path.join(dir, mailtidy.MOVED_FILE);
    const keep = fs.existsSync(movedFile) ? fs.readFileSync(movedFile) : null;
    fs.writeFileSync(movedFile, '{broken');
    n = asks.length;
    answer = 0;
    r = await set({ on: true });
    ok(asks.length === n && r.tidy.on === false && r.tidy.messageKind === 'bad' && /tidy-moved\.json/.test(r.tidy.message)
      && !/세지 못했습니다/.test(r.tidy.message), '서버 탓으로 묻지 않고, 묻지도 켜지도 않고 그 까닭(정리 기록)을 말한다', S(r));
    if (keep) fs.writeFileSync(movedFile, keep);
    else fs.rmSync(movedFile, { force: true });
  }

  console.log('\n[23] «백업 시작»이 건 강제 끊기 타이머는 그때 돌던 정리만 끊는다');
  backup.init({ tidyTiming: { STOP_GRACE_MS: 1500 } });
  r = await set({ on: true }, { startMs: 3600_000 });   // 예약 타이머는 시험 동안 오지 않는다
  ok(r.tidy.on === true, '(켰다)');
  await quickBackup();
  setDelay('a1', { search: 200 });
  const pA = backup.autoBackupNew({ now: true });
  ok(await until(() => T().running), '(정리 A 가 도는 중)');
  const t23 = Date.now();
  await backup.startBackup();   // A 에 비켜 달라고 한다 — 1.5초 뒤 강제로 끊는 타이머가 걸린다
  await pA;
  await until(() => !backup.backupStatus().running, 3000);
  ok(Date.now() - t23 < 1300, '(A 는 확인 지점에서 스스로 멈췄고 수동 백업도 끝났다 — 타이머보다 먼저)', Date.now() - t23);
  addMail(A1, 3500);
  setDelay('a1', { search: 1200 });
  const pB = backup.autoBackupNew({ now: true });
  ok(await until(() => T().running), '(정리 B 가 도는 중)');
  await pB;
  ok(Date.now() - t23 > 1600 && T().more === false && T().moved === 1 && !inbox('a1').includes(3500),
    'A 를 겨눈 타이머가 울릴 때 돌던 새 정리 B 는 끊지 않는다', { ms: Date.now() - t23, more: T().more, moved: T().moved });
  setDelay('a1', undefined);
  backup.init({ tidyTiming: { STOP_GRACE_MS: 300 } });

  console.log('\n[24] 옮기는 중에 끊기면');
  addMail(A1, 3600);
  await quickBackup();
  setDelay('a1', { move: 3000 });   // 서버는 옮겼는데 답이 늦다
  const movedLog = () => server.log.filter((e) => e.cmd === 'moved').length;
  const mv24 = movedLog();
  const ref24 = refreshed;
  const pC = backup.autoBackupNew({ now: true });
  ok(await until(() => movedLog() > mv24), '(서버는 옮겼고 답을 기다리는 중)');
  await backup.startBackup();   // 비켜 달라고 한다 — 300ms 뒤 연결을 끊는다
  await pC;
  ok(T().moved === 0 && /옮겨졌을 수 있습니다/.test(T().error || '') && !inbox('a1').includes(3600),
    '끊겨 답을 못 받은 묶음은 상태 줄에 «옮겨졌을 수 있음»으로 남는다', { moved: T().moved, error: T().error });
  ok(await until(() => refreshed > ref24), '…옮긴 수가 0이어도 메일 목록을 다시 읽는다', refreshed - ref24);
  ok(lines.some((l) => /옮겨졌을 수 있음/.test(l)), '…기록에도 남는다', lines.filter((l) => /서버 정리/.test(l)).slice(-2));
  await until(() => !backup.backupStatus().running);
  setDelay('a1', undefined);

  console.log('\n[25] «바로»(0일) — 읽은 메일은 새 메일 확인 때마다');
  {
    await until(() => !T().running);
    // 정리가 짧은 간격으로 도는지 보려고 «바로» 간격만 줄인다 (기간 정리의 GAP_MS 는 1시간 그대로)
    backup.init({ tidyTiming: { QUICK_GAP_MS: 400 } });
    const boxDir = mailbackup.boxDirFor(dir, A1, 'INBOX', 1);
    // 파일 이름에서 UID 를 읽는 규칙은 정리와 같은 것을 쓴다 (mailbackup.uidFiles)
    const savedUids = async () => new Set(((await mailbackup.uidFiles(boxDir)) || new Map()).keys());
    /** 서버에서 «바로»가 고를 것(읽음·저장됨)과 안 읽어 남길 것(안 읽음·저장됨)의 수 */
    const want0 = async () => {
      const files = await savedUids();
      const live = server.box('a1', 'INBOX').msgs.filter((m) => files.has(m.uid) && !m.flags.has('\\Flagged') && !m.flags.has('\\Deleted'));
      return { read: live.filter((m) => m.flags.has('\\Seen')).length, unread: live.filter((m) => !m.flags.has('\\Seen')).length };
    };
    ok(T().on === true && T().days === 30, '(켜진 채 30일)', S(backup.backupStatus()));
    // 받은 지 하루 된 메일 — 30일 정리는 건드리지 않는다
    addMail(A1, 4000, { daysAgo: 1, seen: true });
    addMail(A1, 4003, { daysAgo: 1 });
    // 받은 지 60일 된 안 읽은 메일 — 30일 정리는 옮기지만 «바로»는 읽을 때까지 남긴다
    addMail(A1, 4050, { daysAgo: 60 });
    const w0 = await want0();
    ok(w0.read === 1 && w0.unread >= 2, '(읽음·저장 1통, 안 읽음·저장 2통 이상)', w0);

    // 일반 설정 길로는 바꿀 수 없다
    store.setSettings({ mailTidyDays: 0 });
    ok(store.settings.mailTidyDays === 30, '일반 설정 길(setSettings)로는 0(바로)으로 못 바꾼다', store.settings.mailTidyDays);

    // 설정 창이 아닌 곳(preload 는 모든 창에 같다 — 남이 쓴 본문을 그리는 메일 보기 창도 부를 수 있다)에서
    // 켜진 정리를 «바로»로 바꾸거나 기간을 줄이는 요청은 묻지도 바꾸지도 않는다
    {
      n = asks.length;
      const mv = moveCalls();
      for (const [req, o, label] of [
        [{ days: 0 }, { fromSettings: false }, '설정 창이 아닌 곳의 {days:0}'],
        [{ days: 0 }, { parent: null }, '부모 창 없는 {days:0}'],
        [{ on: true, days: 0 }, { fromSettings: false }, '설정 창이 아닌 곳의 {on:true, days:0}'],
        [{ days: 7 }, { fromSettings: false }, '설정 창이 아닌 곳의 {days:7}(기간 줄이기)']
      ]) {
        r = await set(req, o);
        ok(r.tidy.messageKind === 'bad' && /설정 창에서만 바꿀 수/.test(r.tidy.message) && asks.length === n && r.tidy.on === true
          && r.tidy.days === 30 && store.settings.mailTidyDays === 30, `켜진 30일에서 ${label} → 묻지도 바꾸지도 않는다`, S(r));
      }
      ok(moveCalls() === mv && inbox('a1').includes(4050), '…서버에서 옮긴 것도 없다', moveCalls() - mv);
    }

    // 30 → 0 은 묻는다 — 그만두면 그대로
    n = asks.length;
    answer = 1;
    const mk25 = server.log.length;
    r = await set({ days: 0 });
    const q25 = asks[asks.length - 1];
    ok(asks.length === n + 1 && r.tidy.days === 30 && store.settings.mailTidyDays === 30 && /그만뒀습니다/.test(r.tidy.message),
      '켜진 채 30→0(바로)은 묻고, 그만두면 30일 그대로', S(r));
    ok(q25 && q25.title === '서버 정리 — 읽은 메일 바로 옮기기' && q25.buttons[0] === '«바로»로 바꾸기' && q25.buttons[1] === '그만두기'
      && q25.danger === true && q25.focusId === 1, '확인 창 — «바로»로 바꾸기 (빨강) · 초점은 «그만두기»', q25 && { title: q25.title, buttons: q25.buttons });
    ok(q25 && /약 1통/.test(q25.message), '…«약 1통» — 읽고 저장이 확인된 것만 센다 (받은 지 하루 된 것도, 안 읽은 것은 빼고)', q25 && q25.message);
    const d25 = (q25 && q25.detail) || '';
    ok(/PC에 저장된 읽은 메일만 약 10분마다 옮깁니다/.test(d25) && /서버 휴지통으로 옮깁니다/.test((q25 && q25.message) || '')
      && /안 읽은 메일\(이 앱에서 열기만 한 것 포함\)과 별표·중요 메일, 임시보관함은 남깁니다/.test(d25)
      && /웹메일·폰에서는 사라지고/.test(d25) && /되찾을 수 있습니다/.test(d25),
    '…읽은 메일을 메일 확인 때마다(실제 주기로 말한다) 휴지통으로 · 안 읽은 것은 남음 · 웹메일·폰에서도 사라지지만 되찾을 수 있음 · 별표·중요는 남김', d25);
    ok(/임시보관함/.test(d25), '…임시보관함은 남긴다고 말한다 (임시보관함 메일도 읽음이라 옮겨질까 걱정하지 않게)', d25);
    ok(/이 앱에서 열기만 한 것 포함/.test(d25),
      '…이 앱에서 열어 보기만 해서는 읽음이 되지 않는다고 말한다 (열어 읽고 닫았는데 안 옮겨져 고장 난 줄 알지 않게)', d25);
    ok(/보낸 메일도 옮겨 보낸편지함이 빕니다/.test(d25), '…보낸 메일은 저장되면 곧 옮겨 보낸편지함도 빈다고 말한다', d25);
    ok(/휴지통이 비워지기 전까지 되찾을 수 있습니다/.test(d25) && !/정한 기간이 지나면 비워집니다/.test(d25),
      '…휴지통이 저절로 비워진다고 단정하지 않는다', d25);
    ok(new RegExp(`안 읽은 ${w0.unread}통은 읽을 때까지 남깁니다`).test(d25) && !/읽은 뒤에 옮깁니다/.test(d25),
      `…저장된 안 읽은 ${w0.unread}통은 읽을 때까지 남긴다고만 말한다 (읽어도 남기는 메일이 있어 «읽은 뒤에 옮김»을 약속하지 않는다)`, d25);
    const cnt25 = server.log.slice(mk25);
    ok(cnt25.filter((e) => e.cmd === 'mailboxOpen').every((e) => e.readOnly) && !cnt25.some((e) => e.cmd === 'messageMove')
      && cnt25.some((e) => e.cmd === 'search' && e.q && e.q.seen === true && !('before' in e.q)),
    '…세기는 읽기 전용, 옮기기 0, «바로» 규칙(seen:true, 날짜 없음)으로 센다', cnt25.filter((e) => e.cmd === 'search').map((e) => e.q));
    const dry25 = tidyCalls.filter((c) => c.dryRun).slice(-1)[0];
    ok(dry25 && dry25.days === 0 && dry25.inView, '…세기에도 days 0 과 보기 창 확인(inView)을 넘긴다', dry25);

    // 받아들이면 0 — 30으로 바뀌지 않고 저장·상태·디스크에 0.
    // 30일 정리가 도는 중에 받아들인다 — 그 실행은 다음 확인 지점에서 멈춰야 한다. 30일 정리는 안 읽은 오래된 메일(4050)도
    // 옮기는데, 사용자는 방금 확인 창에서 «안 읽은 메일은 남깁니다»를 보고 받아들였다
    await quickBackup();   // 정리 시각을 당긴다 — 다음 자동 백업 끝에 30일 정리가 돈다
    let release25 = null;
    const held25 = new Promise((res) => { release25 = res; });
    let hold25 = false;
    // 30일 정리의 첫 검색(4050 을 골랐다)에서 붙잡는다. 확인 창의 세기는 그 뒤라 붙잡히지 않는다
    server.spec.a1.hooks = { afterSearch: async () => { if (hold25) return; hold25 = true; await held25; } };
    const pHeld = backup.autoBackupNew({ now: true });
    ok(await until(() => hold25 && T().running), '(30일 정리가 4050 을 고른 채 붙잡혀 도는 중)');
    answer = 0;
    r = await set({ days: 0 });
    ok(r.tidy.on === true && r.tidy.days === 0 && store.settings.mailTidyDays === 0 && store.reloadFromDisk().settings.mailTidyDays === 0
      && /^«바로»로 바꿨습니다 — \d+분쯤 뒤부터 적용됩니다\.$/.test(r.tidy.message),
    '«바로»로 바꾸기 → 0 이 상태·설정·디스크까지 그대로', S(r));
    ok(lines.some((l) => /서버 정리 «바로»로 바꿈 · 읽은 메일 바로/.test(l)), '…기록에 «바로»로 바꿈', lines.filter((l) => /바로/.test(l)));
    release25();
    await pHeld;
    server.spec.a1.hooks = undefined;
    ok(T().more === true && T().moved === 0 && inbox('a1').includes(4050),
      '30일 정리가 도는 중에 «바로»를 받아들이면 그 실행은 멈춘다 — 받은 지 60일 된 안 읽은 메일을 옮기지 않는다', { more: T().more, moved: T().moved, inbox: inbox('a1') });
    const at25 = T().at;
    ok(await until(() => T().at > at25), '…곧 «바로»로 다시 돈다', T().at - at25);
    ok(!inbox('a1').includes(4000) && inbox('a1').includes(4003) && inbox('a1').includes(4050),
      '읽은 4000 은 옮기고, 안 읽은 4003·4050(60일)은 남긴다', inbox('a1'));
    ok(T().unread === w0.unread && T().days === 0 && store.settings.mailTidyLast.unread === w0.unread,
      `상태·마지막 결과에 안 읽어 남긴 ${w0.unread}통 (unread)`, { unread: T().unread, last: store.settings.mailTidyLast });
    const run25 = tidyCalls.filter((c) => !c.dryRun).slice(-1)[0];
    ok(run25 && run25.days === 0 && run25.inView && run25.cap === undefined, '실제 정리에도 days 0 · inView 를 넘기고 상한은 기본(300)', run25);

    // 짧은 간격 — 3시간(여기서는 1시간)이 아니라 QUICK_GAP_MS 뒤에 다시 돈다
    const at25b = T().at;
    addMail(A1, 4010, { daysAgo: 0.01, seen: true });
    await backup.autoBackupNew({ now: true });
    ok(T().at === at25b && inbox('a1').includes(4010), '방금 돈 뒤에는 간격(QUICK_GAP_MS) 안이라 돌지 않는다', inbox('a1'));
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25b && !inbox('a1').includes(4010), '…짧은 간격이 지나면 다음 자동 백업 끝에 돈다 (기간 정리의 1시간을 기다리지 않는다)', inbox('a1'));

    // 안 읽은 메일을 읽었다 — 다음 정리 때 옮긴다
    server.box('a1', 'INBOX').msgs.find((m) => m.uid === 4003).flags.add('\\Seen');
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(!inbox('a1').includes(4003), '읽음이 되면 다음 정리 때 옮긴다', inbox('a1'));

    // 보기 창에 떠 있는 메일은 건너뛴다 (INBOX 는 대소문자를 가리지 않는다)
    addMail(A1, 4020, { daysAgo: 0.01, seen: true });
    backup.init({ openMailKeys: () => [{ accountId: 'a1', mailbox: 'inbox', uid: 4020 }, { accountId: 'a2', mailbox: 'INBOX', uid: 4020 }] });
    await sleep(450);
    let at25c = T().at;
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25c && inbox('a1').includes(4020) && T().spared >= 1, '보기 창에 떠 있는 메일은 옮기지 않는다 (spared)', { inbox: inbox('a1'), spared: T().spared });
    backup.init({ openMailKeys: () => { throw new Error('창 목록 실패'); } });
    await sleep(450);
    at25c = T().at;
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25c && inbox('a1').includes(4020) && !T().error, '창 목록을 못 읽으면 옮기지 않는 쪽으로 (오류로 멈추지 않는다)', { inbox: inbox('a1'), error: T().error });
    backup.init({ openMailKeys: () => [] });
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(!inbox('a1').includes(4020), '…창을 닫으면 다음 정리 때 옮긴다', inbox('a1'));

    // 다른 계정·다른 폴더에 같은 UID 가 떠 있는 것은 그 메일이 아니다 — 옮긴다 (계정·폴더를 함께 맞대 본다)
    addMail(A1, 4025, { daysAgo: 0.01, seen: true });
    backup.init({ openMailKeys: () => [{ accountId: 'a2', mailbox: 'INBOX', uid: 4025 }, { accountId: 'a1', mailbox: 'Sent', uid: 4025 }] });
    await sleep(450);
    at25c = T().at;
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25c && !inbox('a1').includes(4025) && T().spared === 0,
      '다른 계정(a2 INBOX)·다른 폴더(a1 Sent)에 같은 UID 가 떠 있어도 a1 받은편지함의 그 메일은 옮긴다 (spared 0)', { inbox: inbox('a1'), spared: T().spared });
    // Gmail 은 같은 메일이 라벨 폴더에 다른 UID 로 있다 — 같은 계정에서 Message-ID 가 같으면 폴더·UID 가 달라도 건너뛴다
    addMail(A1, 4026, { daysAgo: 0.01, seen: true });
    backup.init({ openMailKeys: () => [{ accountId: 'a2', mailbox: 'INBOX', uid: 1, messageId: '<m4026@corp.example>' }] });
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(!inbox('a1').includes(4026), '다른 계정에 같은 Message-ID 가 떠 있는 것은 상관없다 — 옮긴다', inbox('a1'));
    addMail(A1, 4027, { daysAgo: 0.01, seen: true });
    backup.init({ openMailKeys: () => [{ accountId: 'a1', mailbox: '업무', uid: 9999, messageId: ' <M4027@Corp.Example>' }] });
    await sleep(450);
    at25c = T().at;
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25c && inbox('a1').includes(4027) && T().spared >= 1,
      '같은 계정의 다른 폴더(라벨)에서 Message-ID 가 같은 메일을 보는 중이면 받은편지함 쪽도 옮기지 않는다', { inbox: inbox('a1'), spared: T().spared });
    // 이 앱에서 방금 «안 읽음»으로 되돌렸다 — 느린 서버의 STORE 가 끝나기 전이라 서버는 아직 읽음이어도 옮기지 않는다
    const { SeenMarks } = require(path.join(ROOT, 'src', 'mailmark.js'));
    const marks25 = new SeenMarks();
    backup.init({ openMailKeys: () => [], markedUnread: (k) => marks25.markedUnread(k) });
    marks25.mark({ accountId: 'a1', mailbox: '', uid: 4027 }, false);
    await sleep(450);
    at25c = T().at;
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25c && inbox('a1').includes(4027) && T().spared >= 1,
      '방금 «안 읽음»으로 되돌린 메일(읽음 장부)은 서버가 아직 읽음이어도 옮기지 않는다 (창을 닫았어도)', { inbox: inbox('a1'), spared: T().spared });
    marks25.mark({ accountId: 'a1', mailbox: 'INBOX', uid: 4027 }, true);
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(!inbox('a1').includes(4027), '…장부에 «안 읽음» 표시가 없으면(다시 읽음으로) 옮긴다', inbox('a1'));
    backup.init({ markedUnread: () => false });

    // «바로»는 5분마다 돈다 — 옮긴 것 없이 같은 남김만 되풀이되면 기록에 다시 적지 않는다
    addMail(A1, 4040, { daysAgo: 0.01, seen: true, file: false });
    await sleep(450);
    const l25 = lines.length;
    await backup.autoBackupNew({ now: true });
    const first25 = lines.slice(l25).filter((l) => /서버 정리 ·/.test(l));
    await sleep(450);
    const l25b = lines.length;
    const at25e = T().at;
    await backup.autoBackupNew({ now: true });
    ok(first25.length === 1 && /저장 안 됨 1/.test(first25[0]) && T().at > at25e && !lines.slice(l25b).some((l) => /서버 정리/.test(l)),
      '같은 남김(저장 안 된 1통)이 되풀이되면 처음 한 번만 기록한다', { first: first25, again: lines.slice(l25b) });
    server.box('a1', 'INBOX').msgs = server.box('a1', 'INBOX').msgs.filter((m) => m.uid !== 4040);

    // 안 읽어 남긴 것만 있는 결과는 기록하지 않는다 — 경고가 아니다 (몇 분마다 같은 줄이 쌓이지 않게).
    // 4040 을 치워 kept 가 1 → 0 으로 바뀌었다 — 모양(sig)이 달라 «같은 줄 막기»가 아니라 이 규칙이 막아야 한다
    await sleep(450);
    const l25u = lines.length;
    const at25u = T().at;
    await backup.autoBackupNew({ now: true });
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(T().at > at25u && T().unread >= 1 && T().moved === 0 && T().kept === 0 && !lines.slice(l25u).some((l) => /서버 정리 ·/.test(l)),
      '안 읽은 메일만 남은 결과는 기록에 적지 않는다', { unread: T().unread, lines: lines.slice(l25u) });

    // 기간으로 늘리기 — 0 → 30 도 묻는다 (안 읽은 오래된 메일까지 옮기게 되므로)
    n = asks.length;
    answer = 1;
    r = await set({ days: 30 });
    const q25b = asks[asks.length - 1];
    ok(asks.length === n + 1 && r.tidy.days === 0 && q25b.title === '서버 정리 — 기간으로 바꾸기' && q25b.buttons[0] === '30일로 바꾸기'
      && /안 읽은 메일도 그 기간이 지나면 옮깁니다/.test(q25b.detail), '켜진 채 0→30 도 묻는다 — 그만두면 «바로» 그대로', { ...S(r), title: q25b.title, buttons: q25b.buttons });
    // «바로»가 도는 중에 받아들인다 — 그 실행은 다음 확인 지점에서 멈춰야 한다 (받은 지 하루 된 읽은 메일을 계속 옮기면 안 된다)
    addMail(A1, 4060, { daysAgo: 1, seen: true });
    await sleep(450);   // «바로» 간격이 지났다
    let release25b = null;
    const held25b = new Promise((res) => { release25b = res; });
    let hold25b = false;
    server.spec.a1.hooks = { afterSearch: async () => { if (hold25b) return; hold25b = true; await held25b; } };
    const pHeld0 = backup.autoBackupNew({ now: true });
    ok(await until(() => hold25b && T().running), '(«바로» 정리가 4060 을 고른 채 붙잡혀 도는 중)');
    const calls25 = tidyCalls.length;
    answer = 0;
    r = await set({ days: 30 });
    ok(r.tidy.days === 30 && store.settings.mailTidyDays === 30 && /안 읽은 메일도/.test(r.tidy.message), '…받아들이면 30일', S(r));
    release25b();
    await pHeld0;
    server.spec.a1.hooks = undefined;
    const at25f = T().at;
    ok(T().more === true && T().moved === 0 && inbox('a1').includes(4060),
      '«바로»가 도는 중에 30일을 받아들이면 그 실행은 멈춘다 — 받은 지 하루 된 읽은 메일을 옮기지 않는다', { more: T().more, moved: T().moved, inbox: inbox('a1') });
    ok(await until(() => T().at > at25f && !T().running && tidyCalls.slice(calls25).some((c) => !c.dryRun && c.days === 30), 4000),
      '…새 기간(30일)으로 곧 다시 돈다', tidyCalls.slice(calls25));
    ok(inbox('a1').includes(4060) && !inbox('a1').includes(4050), '…30일 기준이라 하루 된 4060 은 남고, 60일 된 안 읽은 4050 은 옮긴다', inbox('a1'));
    // 30일 정리는 긴 간격(GAP_MS)을 지킨다 — «바로»의 짧은 간격이 지나도 다시 돌지 않는다
    const at25g = T().at;
    addMail(A1, 4070, { daysAgo: 60 });
    await sleep(450);
    await backup.autoBackupNew({ now: true });
    ok(T().at === at25g && inbox('a1').includes(4070), '30일 정리는 «바로»의 짧은 간격이 지나도 돌지 않는다 (긴 간격)', inbox('a1'));
    // 뒤의 «바로» 시험(읽고 저장된 것 «약 1통»)에 섞이지 않게 치운다
    server.box('a1', 'INBOX').msgs = server.box('a1', 'INBOX').msgs.filter((m) => m.uid !== 4060 && m.uid !== 4070);
    await until(() => !T().running, 3000);

    // 꺼진 채 «바로»를 고르고 바로 켜기 — 켤 때 묻는다
    r = await set({ on: false });
    n = asks.length;
    r = await set({ days: 0 });
    ok(asks.length === n && r.tidy.on === false && r.tidy.days === 0 && store.settings.mailTidyDays === 0 && /켜면 PC에 저장된 읽은 메일을 바로/.test(r.tidy.message),
      '꺼진 채 0(바로)을 고르면 묻지 않고, 0 이 그대로 남는다', S(r));
    addMail(A1, 4030, { daysAgo: 0.01, seen: true });
    answer = 1;
    r = await set({ on: true });
    const q25c = asks[asks.length - 1];
    ok(asks.length === n + 1 && r.tidy.on === false && r.tidy.days === 0 && q25c.title === '서버 정리 켜기' && /읽은 메일만/.test(q25c.detail)
      && /읽은 메일 약 1통/.test(q25c.message) && /\d+분쯤 뒤 시작 — 그 전에 끄면 옮기지 않습니다/.test(q25c.detail), '«바로»로 켜기도 묻는다 — 읽고 저장된 것만 세고, 유예를 말한다. 그만두면 꺼진 채 0', { ...S(r), msg: q25c.message });
    answer = 0;
    const at25d = T().at;
    r = await set({ on: true }, { startMs: 300 });
    ok(r.tidy.on === true && r.tidy.days === 0 && /^켰습니다 — \d+분쯤 뒤부터 옮깁니다\. 그 전에 끄면 옮기지 않습니다\.$/.test(r.tidy.message), '…받아들이면 켜진다', S(r));
    await backup.autoBackupNew({ now: true });
    ok(T().at === at25d && inbox('a1').includes(4030), '켠 뒤 유예 안에는 «바로»도 돌지 않는다', inbox('a1'));
    ok(await until(() => T().at > at25d, 4000) && !inbox('a1').includes(4030), '…유예가 지나면 옮긴다', inbox('a1'));
    await until(() => !T().running, 3000);
    await set({ on: false });
    await set({ days: 30 });
  }

  ok(server.forbidden().length === 0, '처음부터 끝까지 금지 명령은 한 번도 불리지 않았다');
  ok(!lines.some((l) => l.includes('@') || /report/.test(l)), '처음부터 끝까지 기록에 주소·제목이 없다', lines.filter((l) => l.includes('@') || /report/.test(l)));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

'use strict';
// 지난 메일 받기의 문 — 처음 묻기·동의·회차 시작 판단·다른 일과의 관계 (src/backup.js · src/store.js · src/mailbody.js).
//
// 창을 하나도 띄우지 않는다. main.js 도 싣지 않는다 — backup.js 를 바로 부르고, 메일 서버(mail.connect)·확인 창(popup.askUser)·
// 폴더 고르기(dialog)·기록(evlog.log)은 바꿔 끼운다. 알림은 init 의 notifyFill 로 받는다 — 진짜 알림은 뜨지 않는다.
// 진짜 메일 서버·자격 증명 관리자는 건드리지 않는다. 가짜 계정 주소는 *.invalid 다.
// 홈·문서·데이터 폴더는 store 를 싣기 전에 임시로 옮긴다. 진짜 홈을 건드리지 않게 하기 위해서다.
//   [1] ensureLocalFirst 표  [2] 쉬던 정리가 켜지는 구멍  [3] defaultDirs·기본 폴더 고르기  [4] 있는 폴더를 안 바꾼다
//   [4b] 옛 파일 스캔  [5] 일반 설정 길은 답을 못 바꾼다  [6] 답 없음·no 면 연결 0  [7] 알림은 한 번, 방해 금지 중 미룸
//   [7a] 자동 yes 는 모든 폴더 lowUid≤1 일 때만, 표시를 못 적은 폴더가 있으면 안 적음  [7b] 첫 확인 전에는 안 적고 안 묻는다
//   [7c] 묻기 전에 받는 양은 계정 전체로 200통  [7d] 거절된 새 메일은 폴더 오류가 아니다
//   [8] setFill — 설정 창에서만 켠다, 문구, 멈추기·이어 받기·정리 허용
//   [9] 회차 — 첫 시작, 몫, 폴링 앞에서 줄이기, 주기 2분  [10] 비킴  [11] 멈춤 조건·물러나기
//   [12] 정리에서 빠진다  [13] 잠금  [14] 폴더 바꾸기  [15] 오해 막기  [16] 정적 검사
//   [17] 못 받은 메일 다시 부르기  [18] 보류의 끝  [19] noMove  [20] 자동 저장 간격  [21] 미리 받기
//   [22] 차례는 실제로 시작할 때 넘긴다  [23] 아무것도 못 받는 회차  [24] 앱을 다시 켜도 옮기기를 멈춘 계정을 안다 · 서버 기능 한 줄
//   [25] 상태 — 서버 정리가 쉬는 까닭, 메일 확인 값  [26] UIDVALIDITY 를 늘 안 주는 서버  [27] 못 연 폴더와 회차 중의 수  [28] 쓸 수 없는 계정
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, dialog } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 240_000).unref();

const ROOT = path.join(__dirname, '..');
// 실제 설정·홈을 건드리지 않게 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fillgate-'));
const HOME = path.join(tmp, 'home');
const DOCS = path.join(tmp, 'docs');
const USER = path.join(tmp, 'Hibi');
for (const d of [HOME, DOCS, USER]) fs.mkdirSync(d, { recursive: true });
app.setPath('appData', tmp);
app.setPath('userData', USER);
app.setPath('home', HOME);
app.setPath('documents', DOCS);
// 예전 버전이 남긴 설정 파일 — 지난 메일 키가 없다
fs.writeFileSync(path.join(USER, 'nunsseom.json'), JSON.stringify({ settings: { mailCount: 5 }, layoutVersion: 3 }));

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
    await sleep(10);
  }
  return !!fn();
}

const DAY = 86_400_000;
const V = 1700000000n;

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  const lines = [];
  const allLines = [];   // 구역마다 lines 를 비운다 — 끝의 «기록에 주소·제목이 없다»는 처음부터의 줄을 봐야 한다
  evlog.log = (s, m) => { lines.push(`${s}|${m}`); allLines.push(`${s}|${m}`); };
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  // 훅을 싣기 전에 잡는다 — mail.connect 를 바꿔 끼우면 진짜 connect 의 훅이 안 불린다
  let frontHook = null;
  const realSetHook = mail.setFrontHook;
  mail.setFrontHook = (fn) => { frontHook = fn; realSetHook(fn); };
  const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
  const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
  // 옮기기 일지 — main.js 를 싣지 않으므로 메모리 일지다. [24]만 임시 데이터 폴더의 파일로 바꿨다가 되돌린다
  const mailmove = require(path.join(ROOT, 'src', 'mailmove.js'));
  const tidyacct = require(path.join(ROOT, 'src', 'tidyacct.js'));
  const tidyCalls = [];
  const realTidyAll = mailtidy.tidyAll;
  mailtidy.tidyAll = (accs, d, o = {}) => {
    if (!o.dryRun) tidyCalls.push(accs.map((a) => a.id));
    return realTidyAll(accs, d, o);
  };
  const mailfill = require(path.join(ROOT, 'src', 'mailfill.js'));
  // 회차 — 진짜를 돌리되 남은 공간은 시험이 정한다 (이 PC의 디스크에 판정이 매이지 않게). fillOverride 를 두면 그것이 회차다
  const fillCalls = [];
  let fillOverride = null;
  let free = () => 1e15;
  const realFill = mailfill.fillAccount;
  mailfill.fillAccount = (a, d, o) => {
    fillCalls.push({ id: a.id, budgetMs: o.budgetMs, opts: o });
    return fillOverride ? fillOverride(a, d, o) : realFill(a, d, { ...o, freeBytes: async () => free() });
  };
  const popup = require(path.join(ROOT, 'src', 'popup.js'));
  const { makeServer } = require(path.join(ROOT, 'test', 'fixtures', 'fake-imap.js'));

  // ── 가짜 메일 서버 ──
  const mk = (uid, o = {}) => {
    const id = o.id || `m${uid}@corp.invalid`;
    const date = new Date(Date.now() - (o.daysAgo == null ? 60 : o.daysAgo) * DAY);
    const raw = `Message-ID: <${id}>\r\nDate: ${date.toUTCString()}\r\nFrom: Kim <kim@corp.invalid>\r\n`
      + `Subject: report ${uid}\r\nMIME-Version: 1.0\r\n\r\nbody ${uid}\r\n`;
    return { uid, raw, date, subject: `report ${uid}`, messageId: `<${id}>`, flags: o.flags || [], labels: [], ...(o.extra || {}) };
  };
  const acct = (id, name) => ({ id, name: name || `회사${id}`, user: `${id}@corp.invalid`, host: `imap.${id}.invalid`, port: 993, enabled: true });
  const A1 = acct('a1');
  const A2 = acct('a2');
  const A3 = acct('a3');
  const inbox = (uids, o = {}) => ({ path: 'INBOX', uidValidity: V, uidNext: 'auto', msgs: uids.map((u) => (typeof u === 'object' ? u : mk(u))), ...o });
  const trash = () => ({ path: 'Trash', specialUse: '\\Trash', uidValidity: V, msgs: [] });
  const range = (a, z) => Array.from({ length: z - a + 1 }, (_, i) => a + i);

  // ── 바꿔 끼우기 ──
  let server = makeServer({});
  const connects = [];
  mail.connect = (acc, o = {}) => {
    connects.push({ id: acc.id, background: !!o.background });
    if (!o.background && frontHook) frontHook(acc);
    return server.connect(acc);
  };
  const bg = () => connects.filter((c) => c.background).length;
  // 앞쪽 연결 장부도 시험이 쥔다 — 진짜 connect 를 쓰지 않으므로
  const fronts = new Map();
  mail.frontState = (acc) => fronts.get(acc.id) || { busy: false, last: 0, okAt: 0 };
  const asks = [];
  let answer = null;
  let gate = null;
  // 백업 옮기기 질문(«기존 메일 백업도 옮길까요?»)은 test/dirmove 가 본다 — 여기서는 예전 동작인 «옮기지 않고 새 폴더만 쓰기»
  const moveAsks = [];
  popup.askUser = async (parent, o) => {
    const keep = (o.buttons || []).indexOf('옮기지 않고 새 폴더만 쓰기');
    if (keep >= 0) { moveAsks.push(o); return keep; }
    asks.push(o);
    if (gate) await gate.promise;
    return typeof answer === 'function' ? answer(o) : answer;
  };
  const hold = () => { let open; const promise = new Promise((r) => { open = r; }); gate = { promise, open: () => { gate = null; open(); } }; return gate; };
  let pickPath = null;
  let onDialog = () => {};
  dialog.showOpenDialog = async () => { onDialog(); return { canceled: !pickPath, filePaths: pickPath ? [pickPath] : [] }; };

  let accounts = [];
  let live = () => true;
  let holdBy = null;
  let nextPoll = () => Infinity;
  let fwdBusy = false;
  const notified = [];
  const backup = require(path.join(ROOT, 'src', 'backup.js'));
  const TIMING = {
    FIRST_MS: 0, GAP_MS: 1, MORE_GAP_MS: 1, QUICK_GAP_MS: 1, START_MS: 50, AGAIN_MS: 50, KICK_SLACK_MS: 20, STOP_GRACE_MS: 300, MAX_MS: 5000,
    FILL_FIRST_MS: 0, FILL_FIRST_TURN_MS: 700, FILL_TURN_MS: 900, FILL_GAP_MS: 0, FILL_QUIET_MS: 40, FILL_FRESH_MS: 400,
    FILL_POLL_MARGIN_MS: 30, FILL_MIN_TURN_MS: 300, FILL_WATCH_MS: 200, FILL_REFUSED_MS: 30 * 60_000, FILL_CHECK_DISK_MS: 60 * 60_000
  };
  backup.init({
    mailAccountsForUse: () => accounts,
    refreshMail: () => {},
    isSettingsWin: () => true,
    accountLive: (a) => live(a),
    forwardBusy: () => fwdBusy,
    holdReason: () => holdBy,
    notifyFill: (title, body) => { notified.push({ title, body }); },
    nextPollAt: () => nextPoll(),
    tidyTiming: TIMING
  });
  const F = backup.fillState;
  const parent = { isDestroyed: () => false };
  const FS = () => backup.backupStatus().fill;
  const row = (id) => FS().accounts.find((a) => a.id === id);
  const T = () => backup.backupStatus().tidy;
  const ans = (id) => store.settings.mailFill[id];
  /** 서버 정리 — 지금 있는 계정 모두를 켜거나 끈다 (옛 공통 스위치 자리. 켜기 확인은 [13]·[25]가 따로 본다) */
  const tidyEvery = (on) => { for (const a of store.mailAccounts) store.setTidyAccount(a.id, { on }); };
  const tidyOnAny = () => tidyacct.anyOn(store.settings.mailTidyAccounts);
  /** 상태의 그 계정 서버 정리 줄 */
  const tr = (id) => (T().accounts || []).find((a) => a.id === id) || {};
  const poll = () => backup.autoBackupNew({ now: true });
  const set = (req, o = {}) => backup.setFill(req, 'parent' in o ? o.parent : parent, { fromSettings: true, ...o });
  const same3 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const RES = (o) => ({ done: false, heads: 0, saved: 0, bytes: 0, failed: 0, left: null, leftBytes: null, need: null, why: 'budget', error: null, boxErrors: [], genUp: false, ...o });
  /** 끊을 때까지 돌아오지 않는 회차 */
  const hang = () => (a, d, o) => new Promise((res) => {
    o.signal.addEventListener('abort', () => res(RES({ why: o.signal.reason === 'yield' ? 'yield' : 'stop' })), { once: true });
  });

  let seq = 0;
  /** 새 판 — 새 폴더, 새 서버, 답·기억 비움 */
  const reset = async (spec, accs) => {
    fillOverride = null;
    gate = null;
    await until(() => !F.running && !backup.backupStatus().running && !T().running);
    server = makeServer(spec);
    connects.length = 0;
    notified.length = 0;
    asks.length = 0;
    fillCalls.length = 0;
    tidyCalls.length = 0;
    fronts.clear();
    store.mailAccounts.splice(0, store.mailAccounts.length, ...accs);
    accounts = accs;
    store.clearFillAnswers();
    Object.assign(F, { nextAt: 0, rr: 0, scanned: true, dirty: false, stuckLine: '', message: '', messageKind: '' });
    F.listed.clear();
    F.counts.clear();
    F.memo.clear();
    const d = path.join(tmp, `d${++seq}`);
    fs.mkdirSync(d, { recursive: true });
    store.setGatedSettings({ mailBackupDir: d, mailTidyAccounts: {}, mailTidyResults: {} });
    store.setSettings({ mailEnabled: true, mailAutoBackup: true });
    live = () => true;
    holdBy = null;
    nextPoll = () => Infinity;
    fwdBusy = false;
    free = () => 1e15;
    answer = null;
    pickPath = null;
    onDialog = () => {};
    return d;
  };
  /** 상태 파일에 기록을 미리 둔다 — «백업 시작»으로 받은 폴더, 옛 폴더 등 */
  const putState = (d, acc, box, rec) => {
    const r = mailbackup.patchState(d, mailbackup.accountKey(acc), box, { uidValidity: String(V), gen: 1, ...rec });
    if (r.error) throw new Error(r.error);
  };
  const fileOf = (d, acc, m, box = 'INBOX') => {
    const bd = mailbackup.boxDirFor(d, acc, box, 1);
    fs.mkdirSync(bd, { recursive: true });
    fs.writeFileSync(path.join(bd, `20250101_0900_${m.uid}_제목.eml`), Buffer.from(m.raw, 'latin1'));
  };
  /** 끝날 때까지 회차를 돌린다 */
  const fillAll = async (acc, d, max = 20) => {
    for (let i = 0; i < max && !mailfill.isDone(acc, d); i++) {
      F.nextAt = 0;
      await backup.fillTick();
    }
    return mailfill.isDone(acc, d);
  };

  console.log('\n[5] 일반 설정 길은 답을 못 바꾼다');
  {
    ok(JSON.stringify(store.settings.mailFill) === '{}' && JSON.stringify(store.settings.mailFillAt) === '{}', '예전 설정 파일(키 없음)을 읽어도 빈 답이 채워진다', store.settings.mailFill);
    ok(store.settings.mailAutoBackup === false && store.settings.mailBackupDir === null, '기본값은 그대로 — 자동 저장 꺼짐, 폴더 없음 (켜는 일은 ensureLocalFirst 가 한다)');
    lines.length = 0;
    store.setSettings({ mailFill: { a1: 'yes' }, mailFillAt: { a1: 5 }, mailCount: 7 });
    ok(JSON.stringify(store.settings.mailFill) === '{}' && JSON.stringify(store.settings.mailFillAt) === '{}' && store.settings.mailCount === 7, '막힌 키는 그대로, mailCount 만 저장', store.settings.mailCount);
    ok(lines.some((l) => l.includes('지난 메일 설정은 일반 설정 길로 바꿀 수 없습니다 — 무시했습니다')), '기록에 «무시»가 남는다', lines);
    const disk = store.reloadFromDisk().settings || {};
    ok(disk.mailCount === 7 && JSON.stringify(disk.mailFill) === '{}', '디스크에도 막힌 값은 없다', disk.mailFill);
    store.setGatedSettings({ mailFill: { a1: 'yes' } });
    store.setForwardSettings({ mailFill: { a1: 'yes' } });
    ok(JSON.stringify(store.settings.mailFill) === '{}', '정리 길·전달 길도 답을 무시한다');
    store.setFillAnswer('a1', 'yes');
    const pub = store.publicSettings();
    ok(!('mailFill' in pub) && !('mailFillAt' in pub) && ans('a1') === 'yes', 'publicSettings 에 없다 (창에 안 나간다)', Object.keys(pub).filter((k) => /fill/i.test(k)));
    ok(JSON.stringify(store.FILL_SETTINGS) === '["mailFill","mailFillAt","mailFillSeen"]', 'FILL_SETTINGS 세 키', store.FILL_SETTINGS);
    ok(store.GATED_SETTINGS.length === 7 && store.FORWARD_SETTINGS.length === 6, 'GATED(옛 키 셋·옮기기 멈춤 포함)·FORWARD 키 수', [store.GATED_SETTINGS.length, store.FORWARD_SETTINGS.length]);
    for (const v of ['asked', 'no', 'paused', 'yes']) {
      store.setFillAnswer('a1', v);
      ok(ans('a1') === v, `setFillAnswer — ${v}`);
    }
    store.setFillAnswer('a1', 'maybe');
    store.setFillAnswer('../evil', 'yes');
    store.setFillAnswer('__proto__', 'yes');
    ok(ans('a1') === 'yes' && Object.keys(store.settings.mailFill).length === 1 && {}.yes === undefined, '모르는 값·이상한 id 는 무시', store.settings.mailFill);
    store.setFillAnswer('a1', null);
    ok(!('a1' in store.settings.mailFill), 'null 은 지운다');
    const t0 = Date.now();
    store.setFillAt('a1', t0);
    store.setFillAt('a1', t0 + 60_000);
    ok(store.settings.mailFillAt.a1 === t0, 'setFillAt — 한 시간 안에는 다시 저장하지 않는다', store.settings.mailFillAt);
    store.setFillAt('a1', t0 + 3600_000);
    ok(store.settings.mailFillAt.a1 === t0 + 3600_000, '…한 시간이 지나면 저장한다');
    store.setFillAnswer('a1', 'yes');
    store.clearFillAnswers();
    ok(JSON.stringify(store.settings.mailFill) === '{}' && JSON.stringify(store.settings.mailFillAt) === '{}', 'clearFillAnswers — 두 칸을 비운다');
    const srcDir = path.join(ROOT, 'src');
    const srcs = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);
    const callers = srcs.filter(([f, s]) => f !== 'store.js' && /setFillAnswer\(/.test(s)).map(([f]) => f);
    ok(JSON.stringify(callers) === '["backup.js"]', 'setFillAnswer( 를 부르는 곳은 backup.js 뿐', callers);
    const assigns = srcs.filter(([f, s]) => f !== 'store.js' && /\.mailFill\w*\s*=[^=]/.test(s)).map(([f]) => f);
    ok(!assigns.length, 'store.js 밖에 .mailFill = 대입이 없다', assigns);
  }

  console.log('\n[3] defaultDirs · 기본 폴더 고르기');
  {
    const base = { home: 'C:\\Users\\me', docs: 'C:\\Users\\me\\Documents', userData: 'C:\\Data\\Hibi', env: {} };
    const J = JSON.stringify;
    ok(J(backup.defaultDirs({ ...base, packaged: true })) === J(['C:\\Users\\me\\Hibi 메일', 'C:\\Users\\me\\Documents\\Hibi 메일', 'C:\\Data\\Hibi\\mail']), '패키지 — 홈, 문서, userData 차례', backup.defaultDirs({ ...base, packaged: true }));
    ok(J(backup.defaultDirs({ ...base, packaged: false })) === J(['C:\\Data\\Hibi\\mail']), '개발·시험 실행은 userData 뿐 — 진짜 홈에 폴더를 만들지 않는다');
    const od = { OneDrive: 'c:\\users\\ME\\onedrive' };
    const under = { ...base, docs: 'C:\\Users\\me\\OneDrive\\Documents', env: od, packaged: true };
    ok(J(backup.defaultDirs(under)) === J(['C:\\Users\\me\\Hibi 메일', 'C:\\Data\\Hibi\\mail']), '문서 폴더가 OneDrive 안이면 건너뛴다 (대소문자 안 가림)', backup.defaultDirs(under));
    ok(backup.underOneDrive('C:\\Users\\me\\OneDrive', od) === true && backup.underOneDrive('C:\\Users\\me\\OneDriveBackup\\x', od) === false && backup.underOneDrive('C:\\x', {}) === false,
      'underOneDrive — 그 폴더와 그 안만, 옆 폴더(OneDriveBackup)는 아니다');
    ok(backup.underOneDrive('D:\\Biz\\a', { OneDriveCommercial: 'D:\\Biz' }) && backup.underOneDrive('E:\\P\\a', { OneDriveConsumer: 'E:\\P' }), '…OneDriveCommercial·OneDriveConsumer 도 본다');
    const blocked = path.join(tmp, 'blocked-file');
    fs.writeFileSync(blocked, 'x');
    const good = path.join(tmp, 'good-dir');
    ok(backup.firstGoodDir([blocked, good]) === good && fs.existsSync(good), '후보를 못 쓰면 다음 후보', backup.firstGoodDir([blocked, good]) === good);
    ok(backup.firstGoodDir([blocked]) === null, '모두 실패하면 null');
    const sys = process.env.SystemDrive;
    process.env.SystemDrive = path.parse(tmp).root.slice(0, 2);
    const onSys = await backup.minFreeFor(tmp);
    process.env.SystemDrive = 'Z:';
    const offSys = await backup.minFreeFor(tmp);
    process.env.SystemDrive = sys;
    ok(onSys >= mailfill.SYSTEM_FREE && offSys === mailfill.MIN_FREE, 'minFreeFor — 시스템 드라이브는 바닥이 높다', [onSys, offSys]);
  }

  console.log('\n[1] ensureLocalFirst 표');
  {
    await reset({}, []);
    store.setGatedSettings({ mailBackupDir: null });
    store.setSettings({ mailAutoBackup: false });
    let writes = 0;
    const realSS = store.setSettings;
    const realGS = store.setGatedSettings;
    store.setSettings = (p) => { writes += 1; return realSS(p); };
    store.setGatedSettings = (p) => { writes += 1; return realGS(p); };
    backup.ensureLocalFirst();
    ok(writes === 0 && store.settings.mailBackupDir === null && store.settings.mailAutoBackup === false, '계정 없음 — 아무것도 안 한다', writes);
    store.mailAccounts.push(A1);
    realSS({ mailEnabled: false });
    backup.ensureLocalFirst();
    ok(writes === 0 && store.settings.mailBackupDir === null && store.settings.mailAutoBackup === false, '메일 확인 꺼짐 — 안 바꾼다');
    realSS({ mailEnabled: true });
    backup.ensureLocalFirst();
    const want = path.join(USER, 'mail');
    ok(store.settings.mailBackupDir === want && store.settings.mailAutoBackup === true && fs.existsSync(want), '새 사용자 — 기본 폴더(개발 실행은 userData\\mail), 자동 저장 켬', store.settings.mailBackupDir === want);
    ok(fs.readdirSync(HOME).length === 0 && fs.readdirSync(DOCS).length === 0, '…홈·문서에 폴더를 만들지 않았다');
    writes = 0;
    backup.ensureLocalFirst();
    backup.ensureLocalFirst();
    ok(writes === 0, '값이 같으면 저장하지 않는다', writes);
    const mine = path.join(tmp, 'mine');
    fs.mkdirSync(mine);
    realGS({ mailBackupDir: mine });
    realSS({ mailAutoBackup: false });
    writes = 0;
    backup.ensureLocalFirst();
    ok(store.settings.mailBackupDir === mine && store.settings.mailAutoBackup === true && writes === 1, '폴더 있음 + 꺼짐 — 폴더는 그대로, 자동 저장만 켬', writes);
    realGS({ mailBackupDir: null });
    realSS({ mailAutoBackup: false });
    fs.rmSync(want, { recursive: true, force: true });
    fs.writeFileSync(want, 'x');
    backup.ensureLocalFirst();
    ok(store.settings.mailBackupDir === null && store.settings.mailAutoBackup === true, '기본 폴더를 모두 못 쓰면 비워 두고 — 다른 곳을 지어내지 않는다');
    fs.unlinkSync(want);
    backup.ensureLocalFirst();
    ok(store.settings.mailBackupDir === want, '…다음 폴링 때 다시 본다');
    store.setSettings = realSS;
    store.setGatedSettings = realGS;
    const srcInit = (fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8').match(/function init\(h\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(srcInit && !/ensureLocalFirst/.test(srcInit), 'backup.init 안에서 부르지 않는다 (tidygate [2]가 init 뒤의 기본값을 본다)');
  }

  console.log('\n[2] 쉬던 정리가 말없이 켜지는 구멍');
  {
    await reset({}, [A1]);
    store.setGatedSettings({ mailBackupDir: null });
    tidyEvery(true);
    store.setSettings({ mailAutoBackup: false });
    tidyEvery(true);
    backup.ensureLocalFirst();
    ok(!tidyOnAny() && store.settings.mailAutoBackup === true && !!store.settings.mailBackupDir, '조건 미달로 쉬던 정리는 모든 계정이 꺼진 채 끝난다', store.settings.mailTidyAccounts);
    const dir2 = path.join(tmp, 'tidy-on');
    fs.mkdirSync(dir2);
    store.setGatedSettings({ mailBackupDir: dir2 });
    tidyEvery(true);
    store.setSettings({ mailAutoBackup: true });
    tidyEvery(true);
    backup.ensureLocalFirst();
    ok(store.settings.mailTidyAccounts.a1.on === true, '돌던 정리는 그대로 둔다');
    tidyEvery(false);
  }

  console.log('\n[4] 있는 폴더를 안 바꾼다. 못 쓰면 멈추고 다른 곳에 쓰지 않는다');
  {
    const d = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    await poll();
    store.setFillAnswer('a1', 'yes');
    const file = path.join(tmp, 'now-a-file');
    fs.writeFileSync(file, 'x');
    store.setGatedSettings({ mailBackupDir: file });
    backup.ensureLocalFirst();
    ok(store.settings.mailBackupDir === file, '못 쓰는 폴더도 ensureLocalFirst 가 바꾸지 않는다');
    await backup.fillTick();
    ok(store.settings.mailBackupDir === file && bg() === 0, '회차는 연결 없이 끝나고 폴더는 그대로', bg());
    const r4 = row('a1');
    ok(r4.state === 'retry' && !!r4.error, '…상태는 물러나기, 사유가 보인다', r4.state);
    ok(!lines.some((l) => l.includes(file)), '…기록에 폴더 경로가 없다');
    void d;
  }

  console.log('\n[4b] 옛 파일 스캔 — 서버를 부르지 않는다');
  {
    const mailindex = require(path.join(ROOT, 'src', 'mailindex.js'));
    const indexOf = (d, acc) => path.join(mailbackup.boxDirFor(d, acc, 'INBOX', 1), mailindex.INDEX_FILE);
    const prep = async (rec) => {
      const d = await reset({ a1: { boxes: [inbox([10])] } }, [A1]);
      putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 10, ...rec });
      fileOf(d, A1, mk(10));
      F.scanned = false;
      F.nextAt = Date.now() + 999_999;
      return d;
    };
    let d = await prep({});
    await backup.fillTick();
    ok(await until(() => fs.existsSync(indexOf(d, A1)), 2000) && connects.length === 0, '답 없는 계정 — 색인을 만들고 연결 0', connects.length);
    d = await prep({ lowUid: 5 });
    store.setFillAnswer('a1', 'yes');
    await backup.fillTick();
    await sleep(100);
    ok(!fs.existsSync(indexOf(d, A1)), '받는 중인 계정은 건너뛴다 — 회차가 맡는다');
    d = await prep({ fillHead: true, fillLeft: 0 });
    store.setFillAnswer('a1', 'yes');
    await backup.fillTick();
    ok(mailfill.isDone(A1, d) && await until(() => fs.existsSync(indexOf(d, A1)), 2000), '다 받은 계정(답은 yes)도 스캔한다');
  }

  console.log('\n[6] 답 없음·no 면 연결 0');
  {
    await reset({ a1: { boxes: [inbox([10, 11, 12])] } }, [A1]);
    await poll();
    for (let i = 0; i < 3; i++) await backup.fillTick();
    ok(bg() === 0 && fillCalls.length === 0, '답 없음(asked) — fillTick 을 여러 번 불러도 뒤 받기 연결 0', { bg: bg(), ans: ans('a1') });
    store.setFillAnswer('a1', 'no');
    for (let i = 0; i < 3; i++) await backup.fillTick();
    ok(bg() === 0 && fillCalls.length === 0, 'no — 연결 0', bg());
    store.setFillAnswer('a1', 'paused');
    await backup.fillTick();
    ok(bg() === 0, 'paused — 연결 0');
    store.setFillAnswer('a1', 'yes');
    backup.init({ tidyTiming: { FILL_ON: false, FILL_FIRST_MS: 0 } });
    await backup.fillTick();
    ok(bg() === 0 && FS().on === false && backup.fillAskLine() === '', '응급 끄기(FILL_ON) — yes 여도 연결 0, 위젯 줄 없음');
    backup.init({ tidyTiming: { FILL_ON: true, FILL_FIRST_MS: 0 } });
  }

  console.log('\n[7] 알림');
  {
    await reset({ a1: { boxes: [inbox([10, 11, 12])] } }, [A1]);
    holdBy = '발표 중';
    await poll();
    await backup.fillTick();
    ok(notified.length === 0 && ans('a1') === undefined, '방해 금지 중에는 미루고 답도 적지 않는다', notified.length);
    ok(backup.fillAskLine() === '지난 메일을 PC로 받을까요? 눌러서 정하기', '…위젯 줄은 보인다', backup.fillAskLine());
    holdBy = null;
    await backup.fillTick();
    ok(notified.length === 1 && ans('a1') === 'asked', '끝나면 한 번 띄우고 asked 로 적는다', notified);
    ok(notified[0].title === '지난 메일을 PC로 받을까요?' && notified[0].body === '새 메일은 이제 PC에 저장합니다. 눌러서 지난 메일을 받을지 고르세요.', '…글이 설계와 같다');
    await backup.fillTick();
    await poll();
    await backup.fillTick();
    ok(notified.length === 1, '다시 띄우지 않는다', notified.length);
    ok(backup.fillAskLine() !== '', 'asked 여도 위젯 줄은 남는다');
    store.setFillAnswer('a1', 'no');
    ok(backup.fillAskLine() === '', '답하면 줄이 사라진다');
  }

  console.log('\n[7a] 자동 yes 는 모든 폴더 lowUid≤1 일 때만');
  {
    let d = await reset({ a1: { boxes: [inbox([10, 11]), { path: 'Sent', uidValidity: V, uidNext: 'auto', msgs: [] }] } }, [A1]);
    putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 11 });
    putState(d, A1, 'Sent', { lowUid: 1, lastUid: 0 });
    fileOf(d, A1, mk(10));
    fileOf(d, A1, mk(11));
    await poll();
    await backup.fillTick();
    ok(ans('a1') === 'yes' && notified.length === 0 && asks.length === 0, '«백업 시작»으로 다 받은 계정 — 묻지 않고 yes', ans('a1'));
    // 기록은 다 받았다는데 파일이 없다 — 사용자가 옮겼거나 빈 답 한 번에 내려간 옛 기록이다. 묻지 않고 받으면 정리 대상이 말없이 넓어진다
    d = await reset({ a1: { boxes: [inbox(range(10, 15))] } }, [A1]);
    putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 15 });
    await poll();
    await backup.fillTick();
    ok(ans('a1') === 'asked' && notified.length === 1 && bg() === 0, '파일이 없으면 yes 로 적지 않고 묻는다', { ans: ans('a1'), notified: notified.length, bg: bg() });
    tidyEvery(true);
    answer = null;
    await set({ id: 'a1', on: true });
    ok(asks[0].danger === true && /서버 정리가 켜져 있습니다/.test(asks[0].detail), '…보통 질문이라 정리 경고가 나온다', asks[0].danger);
    tidyEvery(false);
    asks.length = 0;
    // 빈 답 확인 중인 폴더가 있다 — 폴더를 바꿨다 되돌린 계정의 옛 기록이다. 파일이 다 있어도 묻는다
    d = await reset({ a1: { boxes: [inbox([10, 11]), { path: 'Sent', uidValidity: V, uidNext: 'auto', msgs: [] }] } }, [A1]);
    putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 11 });
    putState(d, A1, 'Sent', { lowUid: 1, lastUid: 0, exists: 0, fillEmptyAt: Date.now() });
    fileOf(d, A1, mk(10));
    fileOf(d, A1, mk(11));
    await poll();
    await backup.fillTick();
    ok(ans('a1') === 'asked' && notified.length === 1 && bg() === 0, '빈 답 확인 중인 폴더가 있으면 yes 로 적지 않고 묻는다', { ans: ans('a1'), notified: notified.length, bg: bg() });
    d = await reset({ a1: { boxes: [inbox([10, 11]), { path: 'Work', uidValidity: V, uidNext: 'auto', msgs: [mk(5)] }] } }, [A1]);
    putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 11 });
    putState(d, A1, 'Work', { lowUid: 3, lastUid: 5 });
    await poll();
    await backup.fillTick();
    ok(ans('a1') === 'asked', '한 폴더라도 lowUid>1 이면 묻는다', ans('a1'));

    // 받은편지함 2100통, 파일 3000개 — 파일 수로 판단하면 «남은 0»이 된다 (정리가 옮긴 메일의 사본까지 센다)
    d = await reset({ a1: { boxes: [inbox(range(1, 2100))] } }, [A1]);
    putState(d, A1, 'INBOX', { lowUid: 2000, lastUid: 2100 });
    const bd = mailbackup.boxDirFor(d, A1, 'INBOX', 1);
    fs.mkdirSync(bd, { recursive: true });
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(bd, `20250101_0900_${100000 + i}_x.eml`), 'x');
    await poll();
    await backup.fillTick();
    ok(ans('a1') === 'asked' && row('a1').left === 2100 && row('a1').leftRough === true, 'exists=2100, 파일 3000개, lowUid>1 — yes 로 안 적고 묻는다. 위로 잡은 수라고 표시한다', { ans: ans('a1'), left: row('a1').left, rough: row('a1').leftRough });
    const r7 = await set({ id: 'a1', on: true });
    ok(asks.length === 1 && asks[0].message.includes('최대 2100통') && ans('a1') === 'asked' && r7.fill.messageKind === 'wait', '…문구는 «최대 2100통»', asks[0] && asks[0].message);

    // 한 번도 안 쓴 폴더(UIDNEXT 1이라 lowUid=1)만 기록되고 받은편지함의 표시를 못 적었다 — 잠김은 fs 를 바꿔 끼워 흉내 낸다
    d = await reset({ a1: { boxes: [inbox(range(1, 50)), { path: 'Drafts', uidValidity: V, uidNext: 'auto', msgs: [] }] } }, [A1]);
    const stateFile = path.join(d, mailbackup.STATE_FILE);
    const realRename = fs.renameSync;
    const realWrite = fs.writeFileSync;
    let locked = 1;
    fs.renameSync = (a, b) => {
      if (locked > 0 && String(b) === stateFile) throw Object.assign(new Error('잠김'), { code: 'EPERM' });
      return realRename(a, b);
    };
    fs.writeFileSync = (p, ...rest) => {
      if (locked > 0 && String(p) === stateFile) { locked -= 1; throw Object.assign(new Error('잠김'), { code: 'EBUSY' }); }
      return realWrite(p, ...rest);
    };
    try { await poll(); } finally { fs.renameSync = realRename; fs.writeFileSync = realWrite; }
    const recs = mailbackup.loadState(d)[mailbackup.accountKey(A1)] || {};
    ok(!recs.INBOX && recs.Drafts && recs.Drafts.lowUid === 1, '준비 — 받은편지함 표시만 못 적었다', Object.keys(recs));
    ok(F.listed.get('a1').clean === false && (F.listed.get('a1').paths || []).includes('INBOX'), '상태 쓰기가 실패한 실행은 clean 이 아니다', F.listed.get('a1').clean);
    await backup.fillTick();
    ok(ans('a1') !== 'yes' && bg() === 0 && row('a1').left === null, '표시를 못 적은 폴더가 있으면 yes 로 적지 않는다', ans('a1'));
    await poll();
    await backup.fillTick();
    ok(ans('a1') === 'asked' && notified.length === 1 && bg() === 0, '다음 폴링이 표시를 적으면 묻는다', { ans: ans('a1'), notified: notified.length });
  }

  console.log('\n[7c] 묻기 전에 받는 양');
  {
    const backlog = async () => {
      const d = await reset({ a1: { boxes: [inbox(range(5001, 5150)), { path: 'Work', uidValidity: V, uidNext: 'auto', msgs: range(5001, 5150).map((u) => mk(u)) }] } }, [A1]);
      for (const p of ['INBOX', 'Work']) putState(d, A1, p, { lowUid: 1, lastUid: 5000 });
      return d;
    };
    const count = (d) => ['INBOX', 'Work'].reduce((n, p) => n + mailbackup.uidsIn(mailbackup.boxDirFor(d, A1, p, 1)).size, 0);
    let d = await backlog();
    await poll();
    ok(count(d) === 200, '답이 없으면 계정 전체로 200통', count(d));
    d = await backlog();
    store.setFillAnswer('a1', 'asked');
    await poll();
    ok(count(d) === 200, '알림만 띄운 계정(asked)도 답이 없는 것이다', count(d));
    d = await backlog();
    store.setFillAnswer('a1', 'no');
    await poll();
    ok(count(d) === 300, '답한 계정은 폴더마다 200통', count(d));
  }

  console.log('\n[7d] 거절된 새 메일');
  {
    const d = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    await poll();
    await backup.fillTick();
    server.box('a1', 'INBOX').msgs.push({ ...mk(12, { extra: { fetchNo: true } }), flags: new Set(), labels: new Set() });
    lines.length = 0;
    for (let i = 0; i < 4; i++) await poll();
    await backup.fillTick();
    const seen = F.listed.get('a1');
    ok(seen.clean === true && same3(seen.boxErrors, []) && same3(row('a1').boxErrors, []), '폴더 오류가 아니다 — 계정 줄이 «못 연 폴더»라고 하지 않는다', seen);
    ok(row('a1').left === 2 + 1 && row('a1').failed === 1, '…남은 수가 사라지지 않고 못 받은 수가 보인다', { left: row('a1').left, failed: row('a1').failed });
    ok(backup.backupStatus().autoError === null, '…«자동 백업 실패»가 안 보인다', backup.backupStatus().autoError);
    const said = lines.filter((l) => l.includes('못 받은 메일'));
    ok(said.length === 1 && !lines.some((l) => l.includes('실패')), '…기록은 처음 한 번만', lines);
    void d;
  }

  console.log('\n[7b] 첫 확인 전에는 안 적고 안 묻는다');
  {
    let d = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    // 빈 폴더 하나만 기록된 상태 — allBelow 로 읽히지만 아직 목록을 안 돌았다
    putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 0 });
    F.dirty = true;
    await backup.fillTick();
    ok(ans('a1') === undefined && notified.length === 0 && backup.fillAskLine() === '', '빈 폴더 하나만 기록 — 답도 알림도 줄도 없다', ans('a1'));
    ok(row('a1').listed === false && row('a1').left === null, '…상태는 listed 거짓, left 없음', row('a1').left);
    d = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    F.dirty = true;
    await backup.fillTick();
    ok(ans('a1') === undefined && notified.length === 0, '폴더 0개 — 같다');
    // 열어 본 메일만 저장 — autoBackup.at 이 찍혀도 첫 확인이 아니다
    const m = mk(11);
    await backup.autoBackupOne(A1, { mailbox: 'INBOX', uid: 11, receivedAt: Date.now(), subject: 'report 11', source: Buffer.from(m.raw, 'latin1'), seen: true });
    ok(backup.backupStatus().autoAt > 0, '(열어 본 메일이 저장돼 autoAt 이 찍혔다)');
    F.dirty = true;
    await backup.fillTick();
    ok(ans('a1') === undefined && notified.length === 0 && !F.listed.has('a1'), '…autoBackupOne 뒤에도 안 적고 안 묻는다', ans('a1'));
    // 폴더 오류가 있었으면 모른다고 하고 묻는다
    await reset({ a1: { boxes: [inbox([10, 11]), { path: 'Work', uidValidity: V, noUidValidity: true, msgs: [mk(5)] }] } }, [A1]);
    await poll();
    await backup.fillTick();
    ok(F.listed.get('a1').clean === false && ans('a1') === 'asked' && row('a1').left === null, '폴더 오류 — left 없이 묻는다', { left: row('a1').left, ans: ans('a1') });
    ok(row('a1').boxErrors.length === 1, '…못 연 폴더가 상태에 보인다', row('a1').boxErrors);
    await set({ id: 'a1', on: true });
    ok(/몇 통인지는 아직 세지 못했습니다/.test(asks[0].message), '…문구는 «세지 못했습니다»', asks[0].message);
    // 오류가 있으면 lowUid≤1 이어도 yes 로 적지 않는다
    d = await reset({ a1: { boxes: [inbox([10, 11]), { path: 'Work', uidValidity: V, noUidValidity: true, msgs: [mk(5)] }] } }, [A1]);
    putState(d, A1, 'INBOX', { lowUid: 1, lastUid: 11 });
    fileOf(d, A1, mk(10));
    fileOf(d, A1, mk(11));
    await poll();
    await backup.fillTick();
    ok(ans('a1') === undefined, '폴더 오류가 있으면 모든 기록이 lowUid≤1 이어도 yes 로 적지 않는다', ans('a1'));
  }

  console.log('\n[8] setFill');
  {
    const d = await reset({ a1: { boxes: [inbox([10, 11, 12])] } }, [A1]);
    await poll();
    F.dirty = true;
    await backup.fillTick();
    notified.length = 0;
    let r = await set({ id: 'zz', on: true });
    ok(r.fill.messageKind === 'bad' && asks.length === 0, '없는 계정 — 거절', r.fill.message);
    r = await set({ id: 'a1', on: true }, { fromSettings: false });
    ok(r.fill.messageKind === 'bad' && r.fill.message === '지난 메일 받기는 설정 창에서만 켤 수 있습니다.' && asks.length === 0, '설정 창 밖에서 켜기 — 거절', r.fill.message);
    r = await set({ id: 'a1', on: true }, { parent: null });
    ok(r.fill.messageKind === 'bad' && asks.length === 0, '부모 창이 없어도 거절');
    answer = null;
    r = await set({ id: 'a1', on: true });
    const q = asks[0];
    ok(ans('a1') === 'asked' && r.fill.messageKind === 'wait' && r.fill.message === '그만뒀습니다.', '창을 그냥 닫으면(null) 답은 그대로', r.fill.message);
    ok(q.title === '지난 메일도 PC로 받을까요?' && JSON.stringify(q.buttons) === '["받기","받지 않기"]' && q.defaultId === 0 && q.focusId === 1 && q.armMs === 800 && !q.danger, '제목·단추·초점 1·armMs, 정리가 꺼져 있으면 위험 표시 없음', { focus: q.focusId, arm: q.armMs, danger: q.danger });
    ok(q.message === `${A1.name} · 서버의 지난 메일을 최대 3통 이 PC로 받아 둡니다.`, '본문', q.message);
    const qLines = q.detail.split('\n');
    ok(qLines.includes('최신 메일부터 뒤에서 조금씩 받습니다. 느린 서버는 며칠 걸릴 수 있습니다. 끊겨도 앱을 다시 켜면 이어 받습니다. 멈추면 «이어 받기»를 누를 때까지 쉽니다.'), '자세히 — 멈춘 뒤에는 앱을 다시 켜도 이어 받지 않는다고 말한다', qLines[1]);
    ok(qLines[0] === `저장할 곳: ${d}` && qLines.some((l) => /^필요한 용량은 전체 목록을 받은 뒤 받는 동안 설정 창에 보입니다\. 다 받으면 이 드라이브의 여유 공간이 \d+GB 아래로 내려갈 양이면 시작하지 않습니다\.$/.test(l))
      && qLines.includes('서버의 메일과 읽음 표시는 바뀌지 않습니다. 알림·자동 전달·규칙은 지난 메일에 돌지 않습니다.')
      && qLines.includes('받지 않아도 새 메일과 열어 본 메일은 저장합니다.'), '자세히 — 저장할 곳·용량·서버 불변·받지 않아도', qLines.length);
    ok(!qLines.some((l) => /서버 정리|OneDrive/.test(l)), '…정리 줄·OneDrive 줄은 그럴 때만');
    // 창이 말하는 바닥은 회차가 실제로 쓰는 값이다 — 시스템 드라이브는 10GB 나 5% 라 고정값이면 어긋난다. 임시 폴더가 어느 드라이브에 있든 시스템 드라이브로 친다
    const sysWas = process.env.SystemDrive;
    process.env.SystemDrive = path.parse(path.resolve(d)).root.slice(0, 2);
    asks.length = 0;
    await set({ id: 'a1', on: true });
    if (sysWas === undefined) delete process.env.SystemDrive;
    else process.env.SystemDrive = sysWas;
    const disk8 = await fs.promises.statfs(d);
    const floorGB = Math.ceil(Math.max(mailfill.SYSTEM_FREE, disk8.blocks * disk8.bsize * 0.05) / 1024 ** 3);
    ok(asks[0].detail.includes(`여유 공간이 ${floorGB}GB 아래로`), '…시스템 드라이브면 그 드라이브의 바닥을 말한다', floorGB);

    tidyEvery(true);
    asks.length = 0;
    await set({ id: 'a1', on: true });
    ok(asks[0].danger === true && asks[0].detail.includes('서버 정리가 켜져 있습니다. 받는 동안과 멈춘 동안 이 계정은 정리를 쉽니다. 다 받으면 받은 메일 중 받은 지 30일 지난 메일도 서버 휴지통으로 옮겨져 웹메일·폰에서 사라집니다.'), '정리가 켜져 있으면 줄과 위험 표시', asks[0].danger);
    tidyEvery(false);
    const oneOld = process.env.OneDrive;
    process.env.OneDrive = path.dirname(d);
    asks.length = 0;
    await set({ id: 'a1', on: true });
    ok(asks[0].detail.includes('이 폴더는 OneDrive 안에 있어 메일이 클라우드로 올라갑니다.') && FS().oneDrive === true, 'OneDrive 안이면 줄과 상태', FS().oneDrive);
    if (oneOld === undefined) delete process.env.OneDrive; else process.env.OneDrive = oneOld;

    // 묻는 중
    hold();
    const p = set({ id: 'a1', on: true });
    await until(() => FS().asking);
    r = await set({ id: 'a1', on: true });
    ok(r.fill.messageKind === 'wait' && /확인 창이 떠 있습니다/.test(r.fill.message), '묻는 중에 또 켜기 — 기다림', r.fill.message);
    gate.open();
    await p;
    ok(FS().asking === false, '…끝나면 asking 이 내려간다');

    answer = 1;
    r = await set({ id: 'a1', on: true });
    ok(ans('a1') === 'no' && r.fill.messageKind === 'good', '«받지 않기» — no', ans('a1'));
    F.nextAt = Date.now() + 999_999;
    answer = 0;
    lines.length = 0;
    r = await set({ id: 'a1', on: true });
    ok(ans('a1') === 'yes' && F.nextAt === 0 && lines.some((l) => l.includes('지난 메일 받기 켬') && l.includes('최대 3통')), '«받기» — yes, 곧바로 돌 수 있게, 기록', lines);
    asks.length = 0;
    r = await set({ id: 'a1', on: true });
    ok(asks.length === 0 && ans('a1') === 'yes', '이미 yes 면 묻지 않는다 — «받지 않기»로 정리 보류가 확인 없이 풀리지 않게');

    // 멈추기는 어느 창에서 와도 받는다
    tidyEvery(true);
    fillOverride = hang();
    const turn = backup.fillTick();
    ok(F.running, '(회차가 돈다)');
    r = await backup.setFill({ id: 'a1', on: false }, null, { fromSettings: false });
    ok(ans('a1') === 'paused' && r.fill.messageKind === 'good' && r.fill.message === '지난 메일 받기를 멈췄습니다. 새 메일과 열어 본 메일은 계속 저장합니다. 서버 정리는 이 계정을 계속 쉽니다.', '멈추기 — 설정 창 밖에서도, paused, 정리 줄까지', r.fill.message);
    await turn;
    ok(!F.running && F.memo.get('a1').why === 'stop', '…돌던 회차가 끊긴다', F.memo.get('a1').why);
    fillOverride = null;
    r = await backup.setFill({ id: 'a1', on: false }, null, { fromSettings: false });
    ok(ans('a1') === 'paused', '멈춘 것을 또 눌러도 paused — 이 요청 하나로 정리 보류가 풀리면 안 된다', ans('a1'));
    r = await backup.setFill({ id: 'a1', on: true }, null, { fromSettings: false });
    ok(ans('a1') === 'paused' && r.fill.messageKind === 'bad', '이어 받기도 설정 창에서만', r.fill.message);
    r = await backup.setFill({ id: 'a1', release: true }, parent, { fromSettings: false });
    ok(ans('a1') === 'paused' && r.fill.messageKind === 'bad', '정리 허용도 설정 창에서만', r.fill.message);
    asks.length = 0;
    answer = 1;
    r = await set({ id: 'a1', release: true });
    ok(asks.length === 1 && asks[0].title === '이 계정의 서버 정리를 다시 허용할까요?' && asks[0].danger === true && asks[0].focusId === 1 && asks[0].armMs === 800
      && /받아 둔 메일 중 받은 지 30일 지난 메일이 서버 휴지통으로 옮겨져 웹메일·폰에서 사라집니다\. 남은 \S+은 받지 않습니다\./.test(asks[0].message)
      && ans('a1') === 'paused' && row('a1').canRelease === true, '정리 허용은 확인 창을 거치고, 그만두면 그대로', asks[0] && asks[0].message);
    answer = 0;
    lines.length = 0;
    r = await set({ id: 'a1', release: true });
    ok(ans('a1') === 'no' && lines.some((l) => l.includes('정리 허용')), '…«정리 허용»이면 no, 기록', lines);
    asks.length = 0;
    r = await set({ id: 'a1', release: true });
    ok(asks.length === 0 && ans('a1') === 'no', '쉬는 정리가 없으면 묻지 않는다', r.fill.message);
    store.setFillAnswer('a1', 'paused');
    tidyEvery(false);
    ok(row('a1').canRelease === false && row('a1').holdsTidy === false, '정리가 꺼져 있으면 정리 허용 단추를 보이지 않는다');
    asks.length = 0;
    F.nextAt = Date.now() + 999_999;
    r = await set({ id: 'a1', on: true });
    ok(asks.length === 0 && ans('a1') === 'yes' && F.nextAt === 0 && r.fill.messageKind === 'good', '이어 받기는 묻지 않는다', ans('a1'));
    store.setFillAnswer('a1', 'asked');
    r = await backup.setFill({ id: 'a1', on: false }, null, { fromSettings: false });
    ok(ans('a1') === 'no' && r.fill.message === '지난 메일 받기를 멈췄습니다. 새 메일과 열어 본 메일은 계속 저장합니다.', '답이 yes 가 아니었으면 no — 정리 줄 없음', r.fill.message);
    store.setFillAnswer('a1', null);
    store.setGatedSettings({ mailBackupDir: null });
    r = await set({ id: 'a1', on: true });
    ok(r.fill.messageKind === 'bad' && ans('a1') === undefined, '폴더가 없으면 묻지 않는다', r.fill.message);
    const file = path.join(tmp, 'file-dir');
    fs.writeFileSync(file, 'x');
    store.setGatedSettings({ mailBackupDir: file });
    asks.length = 0;
    r = await set({ id: 'a1', on: true });
    ok(r.fill.messageKind === 'bad' && asks.length === 0, '폴더를 못 쓰면 묻지 않는다', r.fill.message.slice(0, 20));
  }

  console.log('\n[9] 회차 — 시작 판단과 몫');
  {
    await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    backup.init({ tidyTiming: { FILL_FIRST_MS: 250 } });
    await backup.fillTick();
    ok(bg() === 0 && fillCalls.length === 0, 'FILL_FIRST_MS 전에는 돌지 않는다', fillCalls.length);
    await sleep(270);
    fillOverride = async () => RES({ why: 'budget' });
    await backup.fillTick();
    ok(fillCalls.length === 1 && fillCalls[0].budgetMs === TIMING.FILL_FIRST_TURN_MS, '앱 실행 뒤 계정별 첫 회차는 짧게', fillCalls[0] && fillCalls[0].budgetMs);
    await backup.fillTick();
    ok(fillCalls.length === 2 && fillCalls[1].budgetMs === TIMING.FILL_TURN_MS, '그 뒤는 보통 몫', fillCalls[1] && fillCalls[1].budgetMs);
    backup.init({ tidyTiming: { FILL_FIRST_MS: 0 } });

    nextPoll = () => Date.now() + 530;
    await backup.fillTick();
    const b9 = fillCalls[2] && fillCalls[2].budgetMs;
    ok(fillCalls.length === 3 && b9 <= 530 && b9 > 300, '다음 폴링 앞에서 몫을 줄인다', b9);

    const n0 = fillCalls.length;
    nextPoll = () => Date.now() + 100;
    await backup.fillTick();
    ok(fillCalls.length === n0, '앞쪽 연결에서 먼 틱은 남은 시간이 모자라면 시작하지 않는다 — 연결만 하고 끊기는 회차를 줄인다', fillCalls.length - n0);

    // 주기 2분 — 앞쪽 연결 뒤 60~90초의 틱에는 남은 시간과 상관없이 시작한다. 거부권이면 영영 돌지 않는다
    fronts.set('a1', { busy: false, last: Date.now() - 80, okAt: 0 });
    fillOverride = hang();
    const turn = backup.fillTick();
    ok(F.running && fillCalls.length === n0 + 1 && fillCalls[n0].budgetMs === TIMING.FILL_TURN_MS, '조용한 시간이 막 지난 틱 — 남은 시간이 모자라도 시작, 몫은 보통', fillCalls[n0] && fillCalls[n0].budgetMs);
    frontHook(A1);
    await turn;
    const m9 = F.memo.get('a1');
    ok(m9.why === 'yield' && !m9.strikes && !m9.retryAt && row('a1').state === 'yielding', '폴링이 끊어도 실패가 아니다', { why: m9.why, strikes: m9.strikes });
    fronts.set('a1', { busy: false, last: Date.now() - 600, okAt: 0 });
    await backup.fillTick();
    ok(fillCalls.length === n0 + 1, '그 뒤의 틱은 남은 시간이 모자라면 안 돈다');
    nextPoll = () => Date.now() + 530;
    m9.setupMs = 1000;
    await backup.fillTick();
    ok(fillCalls.length === n0 + 1, '남은 시간이 지난 연결 준비 시간의 두 배보다 작아도 안 돈다');
    m9.setupMs = 0;
    fillOverride = async () => RES({ why: 'budget' });
    await backup.fillTick();
    ok(fillCalls.length === n0 + 2, '…준비 시간이 짧으면 돈다');
  }

  console.log('\n[10] 비킴');
  {
    await reset({ a1: { boxes: [inbox(range(100, 130))], delay: { fetch: 300 } }, a2: { boxes: [inbox([5])] } }, [A1, A2]);
    store.setFillAnswer('a1', 'yes');
    // 몫을 넉넉히 준다 — 회차가 스스로 끝나기 전에 끊어야 한다. 짧으면 PC 가 바쁠 때 코드가 멀쩡해도 실패한다
    backup.init({ tidyTiming: { FILL_FIRST_TURN_MS: 20_000, FILL_FIRST_MS: 0 } });
    const turn = backup.fillTick();
    ok(F.running && F.current.id === 'a1', '(a1 회차가 돈다 — 진짜 mailfill)');
    await until(() => server.log.some((e) => e.acc === 'a1' && e.cmd === 'fetch'));
    frontHook(A2);
    ok(fillCalls[0].opts.signal.aborted === false && F.running, '다른 계정의 앞쪽 연결은 끊지 않는다');
    frontHook(A1);
    ok(fillCalls[0].opts.signal.reason === 'yield', '같은 계정이면 끊는다');
    await turn;
    const m = F.memo.get('a1');
    backup.init({ tidyTiming: { FILL_FIRST_TURN_MS: TIMING.FILL_FIRST_TURN_MS, FILL_FIRST_MS: 0 } });
    ok(m.why === 'yield' && !m.strikes && server.log.some((e) => e.acc === 'a1' && e.cmd === 'close'), '…why:yield, 실패로 안 세고 연결을 닫았다', m.why);
    ok(!lines.some((l) => l.includes('yield')), '…비킴은 기록하지 않는다');
    const n = fillCalls.length;
    fronts.set('a1', { busy: true, last: Date.now() - 1000, okAt: 0 });
    await backup.fillTick();
    ok(fillCalls.length === n, '앞쪽 연결이 도는 중에는 시작하지 않는다');
    fronts.set('a1', { busy: false, last: Date.now(), okAt: 0 });
    await backup.fillTick();
    ok(fillCalls.length === n, 'FILL_QUIET_MS 안에는 시작하지 않는다');
    await sleep(TIMING.FILL_QUIET_MS + 15);
    fillOverride = async () => RES();
    await backup.fillTick();
    ok(fillCalls.length === n + 1, '…지나면 다시 시작한다', fillCalls.length - n);
  }

  console.log('\n[11] 멈춤 조건·물러나기');
  {
    await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    store.setSettings({ mailEnabled: false });
    await backup.fillTick();
    ok(fillCalls.length === 0, '메일 확인을 끄면 시작하지 않는다');
    store.setSettings({ mailEnabled: true });
    live = () => false;
    fillOverride = hang();
    const t = backup.fillTick();
    const so = fillCalls[0].opts.shouldStop;
    ok(so() === true, '계정을 끄거나 지우면 도는 회차도 멈춘다 (shouldStop)');
    live = () => true;
    ok(so() === false, '(계정이 살아 있으면 계속)');
    store.setFillAnswer('a1', 'paused');
    ok(so() === true, '답이 yes 가 아니면 멈춘다');
    store.setFillAnswer('a1', 'yes');
    store.setSettings({ mailEnabled: false });
    ok(so() === true, '메일 확인을 끄면 멈춘다');
    store.setSettings({ mailEnabled: true });
    F.ctl.abort('stop');
    await t;
    accounts = [];
    F.nextAt = 0;
    const nc = fillCalls.length;
    await backup.fillTick();
    ok(fillCalls.length === nc, '쓸 수 있는 계정에 없으면 시작하지 않는다');
    accounts = [A1];

    // 연결 실패 — 물러나기
    fillOverride = async () => RES({ why: 'connect', error: '서버가 응답하지 않습니다' });
    F.memo.clear();
    await backup.fillTick();
    let m = F.memo.get('a1');
    const r1 = m.retryAt - Date.now();
    ok(m.strikes === 1 && r1 > 50_000 && r1 <= 60_000 && row('a1').state === 'retry' && row('a1').retryMin === 1 && row('a1').error === '서버가 응답하지 않습니다', '연결 실패 — 1분 물러난다', { s: m.strikes, min: row('a1').retryMin });
    const nr = fillCalls.length;
    await backup.fillTick();
    ok(fillCalls.length === nr, '…그동안 다시 부르지 않는다');
    m.retryAt = 0;
    await backup.fillTick();
    m = F.memo.get('a1');
    const r2 = m.retryAt - Date.now();
    ok(m.strikes === 2 && r2 > 4 * 60_000 && r2 <= 5 * 60_000, '…두 번째는 5분', m.strikes);
    ok(row('a1').retryPlain === false, '…진짜 연결 실패는 «연결 실패»로 말한다', row('a1').retryPlain);
    m.retryAt = 0;
    // 쓰기·상태 실패와 폴더 오류는 연결 탓이 아니다. 폴더 경로는 화면에만 보이고 기록에는 안 남는다
    const secret = 'INBOX/인수합병: 서버가 거절했습니다';
    lines.length = 0;
    fillOverride = async () => RES({ why: 'connect', error: secret, boxErrors: [secret, 'B: x'] });
    await backup.fillTick();
    ok(row('a1').error === secret && row('a1').retryPlain === true, '폴더 오류뿐인 회차 — 화면에는 사유, 앞말 없이', row('a1').retryPlain);
    ok(lines.length === 1 && !lines[0].includes('인수합병') && lines[0].includes('폴더 2개'), '…기록에는 폴더 수만', lines);
    F.memo.get('a1').retryAt = 0;
    for (const why of ['write', 'state']) {
      lines.length = 0;
      fillOverride = async () => RES({ why, error: 'C:\\비밀폴더\\backup-state.json 잠김' });
      await backup.fillTick();
      ok(row('a1').state === 'retry' && row('a1').retryPlain === true && !!row('a1').error, `${why} — 연결 실패로 말하지 않는다`, row('a1').error);
      ok(lines.length === 1 && !lines[0].includes('비밀폴더'), '…기록에 경로가 없다', lines);
      F.memo.get('a1').retryAt = 0;
    }
    // 사유에 주소가 들어 있어도 기록에는 가린다
    lines.length = 0;
    fillOverride = async () => RES({ why: 'connect', error: '서버가 kim@corp.invalid 를 거절했습니다' });
    await backup.fillTick();
    ok(lines.length === 1 && !lines[0].includes('kim@corp.invalid') && lines[0].includes('•••@•••'), '연결 실패의 사유에 주소가 있어도 기록에는 가린다', lines);
    F.memo.get('a1').retryAt = 0;
    fillOverride = async () => RES({ why: 'budget', saved: 1 });
    await backup.fillTick();
    ok(!F.memo.get('a1').strikes, '…나아가면 초기화');

    // 디스크
    let d = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    await poll();
    store.setFillAnswer('a1', 'yes');
    free = () => 1024;
    await backup.fillTick();
    ok(F.memo.get('a1').why === 'disk' && row('a1').state === 'disk' && F.nextAt > Date.now() + 50 * 60_000, '디스크 부족 — 멈추고 길게 쉰다', row('a1').state);
    ok(mailfill.isDone(A1, d) === false && !fs.readdirSync(mailbackup.boxDirFor(d, A1, 'INBOX', 1)).some((n) => n.endsWith('.eml')), '…본문을 받지 않았다');
    free = () => 1e15;

    // 디스크가 정말 0 — 쓰기 확인이 ENOSPC 로 실패한다. 폴더 탓으로 말하면 다른 폴더를 고르게 된다 (실제 ENOSPC 는 만들지 않고 주입한다)
    await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    await poll();
    store.setFillAnswer('a1', 'yes');
    const realWrite11 = fs.writeFileSync;
    fs.writeFileSync = (p, ...rest) => {
      if (String(p).endsWith('.hibi-쓰기확인')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realWrite11(p, ...rest);
    };
    try { await backup.fillTick(); } finally { fs.writeFileSync = realWrite11; }
    ok(F.memo.get('a1').why === 'disk' && row('a1').state === 'disk' && !row('a1').retryMin && !row('a1').error && bg() === 0, '쓰기 확인의 ENOSPC 는 «공간» 줄이다 — 영어 원문이 섞인 폴더 오류가 아니다', { state: row('a1').state, error: row('a1').error });

    // 비밀번호 거절 — 계정 잠김을 부르지 않게 다시 부르지 않는다
    await reset({ a1: { boxes: [inbox([10])], authFail: 'AUTHENTICATIONFAILED' } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    await backup.fillTick();
    ok(F.memo.get('a1').authOff === true && row('a1').state === 'auth' && bg() === 1, '인증 실패 — 멈춘다', row('a1').state);
    await backup.fillTick();
    await backup.fillTick();
    ok(bg() === 1, '…재시도하지 않는다', bg());
    fronts.set('a1', { busy: false, last: 0, okAt: F.memo.get('a1').authAt - 1000 });
    await backup.fillTick();
    ok(bg() === 1, '…앞쪽 연결이 그 전에 폴더를 연 것으로는 안 풀린다');
    server.spec.a1.authFail = null;
    fronts.set('a1', { busy: false, last: 0, okAt: Date.now() + 1 });
    await sleep(3);
    await backup.fillTick();
    ok(bg() === 2 && F.memo.get('a1').authOff === false, '…그 뒤 앞쪽 연결이 폴더를 열면 풀린다 (okAt > authAt)', bg());

    // 일시 거절 — 비밀번호 안내를 내지 않는다
    await reset({ a1: { boxes: [inbox([10])], authFail: 'UNAVAILABLE' } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    lines.length = 0;
    await backup.fillTick();
    m = F.memo.get('a1');
    const st = row('a1');
    ok(m.why === 'refused' && !m.authOff && m.retryAt - Date.now() > 29 * 60_000 && st.state === 'refused' && st.retryMin === 30, '일시 거절 — 30분 이상 쉰다', { why: m.why, min: st.retryMin });
    ok(!/비밀번호/.test(JSON.stringify(st)) && !lines.some((l) => /비밀번호/.test(l)), '…비밀번호 안내가 없다', st.error);
    ok(/Temporary System Error/.test(st.error || ''), '…대신 서버가 준 까닭을 보인다 — 줄이 «잠시 로그인 거절»만 말하지 않게', st.error);
    d = null;
  }

  console.log('\n[12] 정리에서 빠진다');
  {
    const old = (uid) => mk(uid, { daysAgo: 60 });
    const a1m = [old(1000), old(1003)];
    const a2m = [old(2000)];
    const d = await reset({
      a1: { boxes: [inbox(a1m), trash()] },
      a2: { boxes: [inbox(a2m), trash()] }
    }, [A1, A2]);
    for (const a of [A1, A2]) putState(d, a, 'INBOX', { lowUid: 2, lastUid: 99999 });
    for (const m of a1m) fileOf(d, A1, m);
    for (const m of a2m) fileOf(d, A2, m);
    tidyEvery(true);
    store.setFillAnswer('a1', 'yes');
    store.setFillAnswer('a2', 'no');
    const moves = (id) => server.log.filter((e) => e.cmd === 'moved' && e.acc === id).length;
    await sleep(5);
    await poll();
    ok(JSON.stringify(tidyCalls[0]) === '["a2"]', 'yes 이고 안 끝난 계정은 tidyAll 대상에서 빠지고 다른 계정은 돈다', tidyCalls);
    ok(moves('a1') === 0 && moves('a2') === 1 && server.box('a1', 'INBOX').msgs.length === 2, '…그 계정 MOVE 0, 다른 계정은 옮겨졌다', [moves('a1'), moves('a2')]);
    ok(row('a1').holdsTidy === true && row('a2').holdsTidy === false, '…상태에 «쉬는 중»', row('a1').holdsTidy);
    await backup.setFill({ id: 'a1', on: false }, null, { fromSettings: false });   // 진짜 멈추기 길 — no 로 내려가면 받아 둔 옛 메일이 다음 정리 때 옮겨진다
    tidyCalls.length = 0;
    store.mailAccounts.splice(1, 1);
    accounts = [A1];
    await sleep(5);
    await poll();
    ok(tidyCalls.length === 0 && moves('a1') === 0, 'paused 도 빠진다 — 대상이 없으면 정리를 부르지도 않는다', tidyCalls);
    answer = 0;
    await set({ id: 'a1', release: true });
    await sleep(5);
    await poll();
    ok(JSON.stringify(tidyCalls[0]) === '["a1"]' && moves('a1') > 0 && server.box('a1', 'INBOX').msgs.length === 0, '정리 허용 뒤 다시 대상이 된다', tidyCalls);

    // 빈 답 확인을 기다리는 폴더 — 완료의 칸이 다 차 보여도 아직 아니다. 메일이 돌아오면 옮길 메일을 먼저 받아야 한다
    for (const fillEmptyAt of [Date.now(), 0]) {
      const held = [old(1000)];
      const w = await reset({ a1: { boxes: [inbox(held), trash()] } }, [A1]);
      putState(w, A1, 'INBOX', { lowUid: 1, lastUid: 99999, fillHead: true, fillLeft: 0, fillEmptyAt });
      fileOf(w, A1, held[0]);
      tidyEvery(true);
      store.setFillAnswer('a1', 'yes');
      tidyCalls.length = 0;
      await sleep(5);
      await poll();
      ok(tidyCalls.length === 0 && moves('a1') === 0 && row('a1').done === false && row('a1').holdsTidy === true, `빈 답 확인 중(${fillEmptyAt ? '시계 감' : '시계 지움'})에는 정리에서 빠지고 «쉬는 중»이다`, { tidy: tidyCalls, done: row('a1').done });
    }
  }

  console.log('\n[13] 잠금');
  {
    const a1m = [mk(10), mk(11)];
    const d = await reset({ a1: { boxes: [inbox(a1m), trash()] } }, [A1]);
    await poll();
    store.setFillAnswer('a1', 'yes');
    fwdBusy = true;
    await backup.fillTick();
    ok(fillCalls.length === 0, '자동 전달 중 — 시작 안 함');
    fwdBusy = false;
    server.spec.a1.delay = { connect: 150 };
    const auto = poll();
    await backup.fillTick();
    ok(fillCalls.length === 0, '자동 저장 중 — 시작 안 함');
    await auto;
    server.spec.a1.delay = null;
    // 서버 정리 확인 창이 떠 있는 동안
    hold();
    answer = 1;
    const asking = backup.setTidy({ id: 'a1', on: true }, parent, { fromSettings: true, countMs: 300 });
    ok(T().asking === true, '(정리를 묻는 중)');
    await backup.fillTick();
    ok(fillCalls.length === 0, '정리를 묻는 중 — 시작 안 함');
    await until(() => asks.length > 0, 2000);
    gate.open();
    await asking;
    // 서버 정리가 도는 동안
    tidyEvery(true);
    store.setFillAnswer('a1', 'no');
    server.spec.a1.delay = { connect: 150 };
    const running = poll();
    await until(() => T().running, 2000);
    store.setFillAnswer('a1', 'yes');
    const before = fillCalls.length;
    ok(T().running, '(정리가 돈다)');
    await backup.fillTick();
    ok(fillCalls.length === before, '정리 중 — 시작 안 함');
    await running;
    server.spec.a1.delay = null;
    tidyEvery(false);
    // «백업 시작» — 끊고, 그동안 시작하지 않는다
    F.nextAt = 0;
    fillOverride = hang();
    const turn = backup.fillTick();
    const sig = fillCalls[fillCalls.length - 1].opts.signal;
    ok(F.running, '(회차가 돈다)');
    // 뒤 받기 중에도 열어 본 메일은 저장한다
    const m = mk(77);
    await backup.autoBackupOne(A1, { mailbox: 'INBOX', uid: 77, receivedAt: Date.now(), subject: 'report 77', source: Buffer.from(m.raw, 'latin1') });
    const files77 = await mailbackup.uidFiles(mailbackup.boxDirFor(d, A1, 'INBOX', 1));
    ok(files77.has(77), '뒤 받기 중에 열어 본 메일이 저장된다');
    server.spec.a1.delay = { connect: 150 };
    fillOverride = hang();
    const st = await backup.startBackup();
    ok(st.running === true && sig.aborted && sig.reason === 'stop', '«백업 시작»은 회차를 끊는다', sig.reason);
    await turn;
    const nb = fillCalls.length;
    F.nextAt = 0;
    await backup.fillTick();
    ok(backup.backupStatus().running === true && fillCalls.length === nb, '«백업 시작» 중 — 시작 안 함');
    await until(() => !backup.backupStatus().running, 5000);
    server.spec.a1.delay = null;
    ok(!backup.backupStatus().running, '(백업이 끝났다)');
  }

  console.log('\n[14] 폴더 바꾸기');
  {
    const d = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    await poll();
    await backup.fillTick();
    store.setFillAnswer('a1', 'yes');
    store.setFillAt('a1', Date.now());
    fillOverride = hang();
    const turn = backup.fillTick();
    const sig = fillCalls[0].opts.signal;
    ok(F.running && F.listed.has('a1'), '(회차가 돈다)');
    const seen = [];
    pickPath = null;
    onDialog = () => { seen.push([F.running, F.picking]); };
    let r = await backup.pickDir();
    await turn;
    ok(sig.aborted && sig.reason === 'stop' && JSON.stringify(seen) === '[[false,true]]' && F.picking === false, '회차를 먼저 끊고 끝나기를 기다린 뒤 대화상자, 대화상자 동안 쉰다', seen);
    ok(ans('a1') === 'yes' && F.listed.has('a1'), '취소하면 답을 지키고', ans('a1'));
    fillOverride = async () => RES();
    F.nextAt = 0;
    pickPath = d;
    r = await backup.pickDir();
    ok(ans('a1') === 'yes' && F.listed.has('a1') && r.dir === d, '같은 폴더를 고르면 답을 지킨다', ans('a1'));
    const nd = path.join(tmp, 'new-home');
    pickPath = nd;
    const m0 = moveAsks.length;
    r = await backup.pickDir();
    ok(moveAsks.length === m0 + 1 && moveAsks[m0].title === '기존 메일 백업도 옮길까요?', '(이전 폴더에 백업이 있어 옮길지 물었고 «새 폴더만 쓰기»를 골랐다)', moveAsks.length - m0);
    ok(r.dir === nd && ans('a1') === undefined && F.counts.size === 0 && F.listed.size === 0 && F.memo.size === 0 && JSON.stringify(store.settings.mailFillAt) === '{}', '폴더가 바뀌면 답·counts·listed·memo 를 지운다', r.dir === nd);
    await backup.fillTick();
    ok(notified.length === 1 && backup.fillAskLine() === '', '…새 폴더의 첫 자동 저장 전에는 묻지 않는다 (알림은 그 전 판의 한 번뿐)', notified.length);

    // 확인 창이 떠 있는 동안 폴더를 바꾸면 창에 적힌 폴더와 다른 곳에 받기 시작한다
    {
      const d1 = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
      await poll();
      await backup.fillTick();
      answer = 0;
      hold();
      const asking = set({ id: 'a1', on: true });
      await until(() => FS().asking);
      let shown = 0;
      onDialog = () => { shown += 1; };
      pickPath = path.join(tmp, 'other-while-asking');
      const rp = await backup.pickDir();
      ok(store.settings.mailBackupDir === d1 && shown === 0 && /확인 창/.test(rp.message), '창이 떠 있으면 폴더 고르기를 거절한다 (대화상자도 안 띄운다)', rp.message);
      gate.open();
      await asking;
      ok(ans('a1') === 'yes' && store.settings.mailBackupDir === d1, '…창의 답은 그대로 듣는다', ans('a1'));

      // 순서를 뒤집어 — 폴더 대화상자가 떠 있는 동안 «정하기»
      const d2 = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
      await poll();
      await backup.fillTick();
      answer = 0;
      let during = null;
      onDialog = () => { during = set({ id: 'a1', on: true }); };
      pickPath = path.join(tmp, 'other-while-picking');
      await backup.pickDir();
      const rd = await during;
      ok(rd.fill.messageKind === 'wait' && /폴더를 고르는 중/.test(rd.fill.message) && asks.length === 0 && ans('a1') !== 'yes', '폴더를 고르는 동안에는 묻지 않는다', rd.fill.message);
      ok(store.settings.mailBackupDir === pickPath && d2 !== pickPath, '…폴더는 바뀌었다');

      // 창이 뜬 사이에 다른 길로 폴더가 바뀌어도 그 답을 새 폴더에 적지 않는다
      const d3 = await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
      await poll();
      await backup.fillTick();
      answer = 0;
      F.nextAt = Date.now() + 999_999;
      hold();
      const asking3 = set({ id: 'a1', on: true });
      await until(() => FS().asking);
      const other3 = path.join(tmp, 'other-under-dialog');
      fs.mkdirSync(other3, { recursive: true });
      store.setGatedSettings({ mailBackupDir: other3 });
      gate.open();
      const r3 = await asking3;
      ok(ans('a1') === 'asked' && r3.fill.messageKind === 'wait' && F.nextAt !== 0 && d3 !== other3, '…답을 안 적고 시작하지 않는다', r3.fill.message);
      // 정리 허용 창도 같다
      store.setGatedSettings({ mailBackupDir: d3 });
      tidyEvery(true);
      store.setFillAnswer('a1', 'paused');
      hold();
      const asking4 = set({ id: 'a1', release: true });
      await until(() => FS().asking);
      store.setGatedSettings({ mailBackupDir: other3 });
      gate.open();
      const r4 = await asking4;
      ok(ans('a1') === 'paused' && r4.fill.messageKind === 'wait', '정리 허용 창도 폴더가 바뀌었으면 듣지 않는다', ans('a1'));
      tidyEvery(false);
    }

    // 회차가 돌아오지 않아도 감시 타이머로 끝난다
    await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    pickPath = null;
    store.setFillAnswer('a1', 'yes');
    F.nextAt = 0;
    fillOverride = () => new Promise(() => {});
    const t0 = Date.now();
    const stuck = backup.fillTick();
    ok(F.running, '(돌아오지 않는 회차)');
    pickPath = null;
    await backup.pickDir();
    const took = Date.now() - t0;
    ok(!F.running && took >= TIMING.FILL_FIRST_TURN_MS && took < 4000, '돌아오지 않는 회차도 감시 타이머로 끝나 폴더 고르기가 멈추지 않는다', took);
    await stuck;
    ok(lines.some((l) => l.includes('돌아오지 않아')), '…기록에 남는다');
    fillOverride = null;

    // 예전 폴더로 되돌려도 묻기 전에 200통 넘게 안 받는다
    const oldDir = path.join(tmp, 'old-dir');
    const od = await reset({ a1: { boxes: [inbox(range(5001, 5400))] } }, [A1]);
    fs.mkdirSync(oldDir);
    putState(oldDir, A1, 'INBOX', { lowUid: 4000, lastUid: 5000 });
    pickPath = oldDir;
    await backup.pickDir();
    ok(store.settings.mailBackupDir === oldDir && od !== oldDir, '(예전 폴더로 되돌렸다)');
    await poll();
    const files = await mailbackup.uidFiles(mailbackup.boxDirFor(oldDir, A1, 'INBOX', 1));
    const rec = mailbackup.loadState(oldDir)[mailbackup.accountKey(A1)].INBOX;
    ok(files.size === 200 && Math.min(...files.keys()) === 5201 && rec.fillHead === false && rec.lowUid === 5201, '밀린 구간은 맨 위 200통만', { files: files.size, low: rec.lowUid });
    await backup.fillTick();
    ok(ans('a1') === 'asked' && bg() === 0, '…나머지는 묻고, 답하기 전에는 연결하지 않는다', ans('a1'));
  }

  console.log('\n[15] 오해 막기');
  {
    const msgs = [mk(10), mk(11, { flags: ['\\Seen'] }), mk(12)];
    const d = await reset({ a1: { boxes: [inbox(msgs), { path: 'Sent', specialUse: '\\Sent', uidValidity: V, uidNext: 'auto', msgs: [mk(30)] }, trash()] } }, [A1]);
    await poll();
    const contacts0 = JSON.stringify(store.contacts);
    const rules0 = JSON.stringify(store.mailRules);
    const flags0 = JSON.stringify(server.box('a1', 'INBOX').msgs.map((m) => [...m.flags]));
    store.setFillAnswer('a1', 'yes');
    const finished = await fillAll(A1, d);
    ok(finished && row('a1').done === true && row('a1').state === 'idle', '지난 메일을 끝까지 받았다', row('a1').state);
    const f15 = await mailbackup.uidFiles(mailbackup.boxDirFor(d, A1, 'INBOX', 1));
    ok(f15.size === 3, '…INBOX 세 통 모두 파일로', f15.size);
    ok(lines.some((l) => l.includes('모두 받음') && l.includes('못 받음 0통')), '…기록에 «모두 받음»');
    // 이 시험은 mailhub·autofwd·mailfwd 를 싣지 않는다 — 그 모듈이 돌면 어떤가는 hubwindow·mailfill [22] 가 본다. 여기는 backup.js 길에 store 쓰기가 없다는 것까지다
    ok(JSON.stringify(store.contacts) === contacts0, '이 길은 주소록 store 를 안 건드린다');
    ok(JSON.stringify(store.mailRules) === rules0, '이 길은 규칙 store 를 안 건드린다');
    ok(!fs.existsSync(path.join(USER, 'mail-forward.json')) && !fs.existsSync(path.join(d, 'mail-forward.json')), '이 길은 자동 전달 기록을 안 만든다');
    ok(JSON.stringify(server.box('a1', 'INBOX').msgs.map((m) => [...m.flags])) === flags0, '서버의 읽음 표시가 그대로');
    ok(server.forbidden().length === 0 && !server.log.some((e) => e.cmd === 'messageMove'), '금지 명령·MOVE 0');
    const opens = server.log.filter((e) => e.cmd === 'mailboxOpen');
    ok(opens.length > 0 && opens.every((e) => e.readOnly), 'mailboxOpen 이 전부 readOnly', opens.length);
    const n = connects.length;
    await backup.fillTick();
    F.nextAt = 0;
    await backup.fillTick();
    ok(connects.length === n, '끝난 계정은 연결을 만들지 않는다', connects.length - n);
    const bk = fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8');
    ok(!/require\('\.\/(mailhub|autofwd|mailrules|mailtally)'\)/.test(bk), 'backup.js 는 mailhub·autofwd·mailrules·mailtally 를 싣지 않는다');
  }

  console.log('\n[16] 정적 검사');
  {
    const srcDir = path.join(ROOT, 'src');
    const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');
    const initSrc = (mainSrc.match(/backup\.init\(\{[\s\S]*?\n\}\);/) || [''])[0];
    ok(/holdReason: \(ms\) => holdReason\(ms\)/.test(initSrc) && /nextPollAt: \(\) => mailhub\.mailState\.fetchedAt \+ Math\.max\(2, store\.settings\.mailPollMin \|\| 10\) \* 60_000/.test(initSrc), 'main.js backup.init 꼴 — holdReason·nextPollAt, 닫는 꼴은 줄 맨 앞 });');
    ok(/notifyFill: \(title, body\) => \{[\s\S]*Notification\.isSupported\(\)[\s\S]*silent: true[\s\S]*openSettings\('mail'\)[\s\S]*n\.show\(\)/.test(initSrc) && /Notification\s*\} = require\('electron'\)/.test(mainSrc), '…notifyFill — 소리 없이, 누르면 설정 › 메일');
    ok(/prepareMail: \(\) => backup\.ensureLocalFirst\(\)/.test(mainSrc), 'main.js mailhub.init 에 prepareMail');
    ok(/setInterval\(\(\) => \{ backup\.fillTick\(\)\.catch\(\(\) => \{\}\); \}, 30_000\);/.test(mainSrc), 'main.js 30초 타이머');
    ok(/fillAsk: backup\.fillAskLine\(\)/.test(mainSrc), 'main.js mailBox 에 fillAsk');
    const hub = fs.readFileSync(path.join(srcDir, 'mailhub.js'), 'utf8');
    const refresh = (hub.match(/async function refreshMail\([\s\S]*?\n\}\n/) || [''])[0];
    ok(/mailState\.blocked = '';\s*\n\s*host\.prepareMail\(\);/.test(refresh), 'refreshMail — blocked 를 비운 다음 줄에 prepareMail');
    ok(/autofwd\.forwardNew\(\)\.catch\(\(\) => \{\}\)\.then\(\(\) => autoBackupNew\(\)\)\.catch\(\(\) => \{\}\)\.then\(\(\) => prefetchBodies\(\)\)\.catch\(\(\) => \{\}\);/.test(refresh), 'refreshMail 고리 — 전달, 저장, 그 끝에 미리 받기');
    ok(!/^\s*prefetchBodies\(\);/m.test(hub) && !/^\s*autoBackupNew\(\);/m.test(hub), '…따로 떨어진 prefetchBodies(); autoBackupNew(); 가 없다');
    const bk = fs.readFileSync(path.join(srcDir, 'backup.js'), 'utf8');
    const runTidy = (bk.match(/async function runTidy\([\s\S]*?tidy\.running = true;/) || [''])[0];
    ok(/\|\| host\.forwardBusy\(\)\) return;\s*\n[^\n]*\n[^\n]*\n\s*const on = \(accounts \|\| \[\]\)\.filter\(\(a\) => tidyOnFor\(a\) && !fillHolds\(a, dir\)\);/.test(runTidy),
      'runTidy 문 꼴 그대로, 바로 뒤에서 켠 계정 가운데 지난 메일로 쉬지 않는 계정만 거른다');
    ok(/const due = tidyacct\.dueOrder\(on\.filter/.test(runTidy) && /mailtidy\.tidyAll\(\[acc\], dir, \{/.test(bk), '…tidyAll 은 거른 계정을 하나씩 받는다');
    ok(/mail\.setFrontHook\(fillYield\)/.test(bk), '앞쪽 연결 훅을 건다');
    ok(/ipcMain\.handle\('mail:fill-set', \(e, req\) => setFill\(req, BrowserWindow\.fromWebContents\(e\.sender\),\s*\{ fromSettings: !!host\.isSettingsWin\(e\.sender\) && mainFrameOf\(e\) \}\)\)/.test(bk), 'mail:fill-set 은 설정 창의 본 문서만 fromSettings');
    ok(/background: true/.test(bk) && /mail\.connect\(a, \{ timeoutMs: 90_000, background: true \}\)/.test(bk), '뒤 받기의 연결은 background — 자기가 자기를 끊지 않게');
    ok(/shouldStop: \(\) => !fillOn\(\) \|\| answerOf\(acc\) !== 'yes' \|\| !host\.accountLive\(acc\)/.test(bk), '회차의 shouldStop');
    const storeSrc = fs.readFileSync(path.join(srcDir, 'store.js'), 'utf8');
    ok(/mailAutoBackup: false,/.test(storeSrc) && /mailBackupDir: null,/.test(storeSrc) && /const LAYOUT_VERSION = 4;/.test(storeSrc), 'store 기본값·LAYOUT_VERSION 은 그대로');
  }

  console.log('\n[17] 못 받은 메일 다시 부르기');
  {
    const msgs = [mk(10), mk(11, { extra: { noSource: true } })];
    const d = await reset({ a1: { boxes: [inbox(msgs)] } }, [A1]);
    await poll();
    store.setFillAnswer('a1', 'yes');
    let finished = false;
    for (let i = 0; i < 12 && !finished; i++) {
      F.nextAt = 0;
      await backup.fillTick();
      finished = mailfill.isDone(A1, d);
    }
    const rec = mailbackup.loadState(d)[mailbackup.accountKey(A1)].INBOX;
    ok(finished && rec.fillFail === 1 && row('a1').failed === 1 && row('a1').done === true && row('a1').canRetry === true, '원문을 안 주는 메일 — 다 받음이고 못 받은 수가 남는다, 다시 부를 수 있다', { fail: rec.fillFail, done: finished });
    tidyEvery(true);
    ok(row('a1').holdsTidy === false, '…정리 보류는 안 걸린다', row('a1').holdsTidy);
    tidyEvery(false);
    let n = bg();
    for (let i = 0; i < 3; i++) { F.nextAt = 0; await backup.fillTick(); }
    ok(bg() === n, '한 번 시도한 뒤 24시간까지 연결을 만들지 않는다', bg() - n);
    F.memo.get('a1').retriedAt -= mailfill.RETRY_FAIL_MS + 1000;
    F.nextAt = 0;
    await backup.fillTick();
    ok(bg() === n + 1, '24시간이 지나면 다시 부른다', bg() - n);
    n = bg();
    F.nextAt = 0;
    await backup.fillTick();
    ok(bg() === n, '…그 뒤 다시 하루');
    F.memo.clear();
    F.nextAt = 0;
    await backup.fillTick();
    ok(bg() === n + 1, '앱을 다시 켜면(memo 비움) 다시 부른다', bg() - n);
    ok(mailfill.isDone(A1, d) === true, '…다시 불러도 완료는 그대로');

    // FETCH 전에 끝난 회차가 그날의 재시도를 쓰지 않는다
    F.memo.get('a1').retriedAt -= mailfill.RETRY_FAIL_MS + 1000;
    server.spec.a1.authFail = 'UNAVAILABLE';
    F.nextAt = 0;
    await backup.fillTick();
    ok(F.memo.get('a1').why === 'refused' && bg() === n + 2, '준비 — 연결이 거절됐다', F.memo.get('a1').why);
    server.spec.a1.authFail = null;
    F.memo.get('a1').retryAt = 0;
    F.nextAt = 0;
    const fetches = () => server.log.filter((e) => e.cmd === 'fetch' && e.query.source).length;
    const sent = fetches();
    await backup.fillTick();
    ok(bg() === n + 3 && fetches() === sent + 1, '연결이 돌아오면 하루를 기다리지 않고 다시 부른다', { bg: bg() - n, fetches: fetches() - sent });
    const n2 = bg();
    F.nextAt = 0;
    await backup.fillTick();
    ok(bg() === n2, '…끝낸 뒤에는 다시 하루', bg() - n2);

    // 그 폴더를 못 연다 — 다 받은 계정이라 물러나기가 없다. 그날 몫을 안 쓴 것으로 치면 30초마다 로그인한다
    const openReal = server.connect;
    server.connect = (a) => {
      const c = openReal(a);
      c.mailboxOpen = async () => { throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' }); };
      return c;
    };
    F.memo.get('a1').retriedAt -= mailfill.RETRY_FAIL_MS + 1000;
    const n0 = bg();
    for (let i = 0; i < 5; i++) { F.nextAt = 0; await backup.fillTick(); }
    ok(bg() === n0 + 1 && row('a1').done === true && row('a1').boxErrors.length === 1, '다시 부른 폴더를 못 열어도 그날은 한 번만 연결한다 — 못 연 폴더는 화면에 보인다', { bg: bg() - n0, errors: row('a1').boxErrors });
    server.connect = openReal;
    F.memo.get('a1').boxErrors = [];

    // 100MB 넘는 메일 — 못 받은 수에는 들지만 다시 부를 일은 아니다
    const d2 = await reset({ a1: { boxes: [inbox([10])] } }, [A1]);
    putState(d2, A1, 'INBOX', { lowUid: 1, lastUid: 10, fillHead: true, fillLeft: 0, fillFail: 0, fillBig: 2 });
    store.setFillAnswer('a1', 'yes');
    F.nextAt = 0;
    await backup.fillTick();
    ok(row('a1').failed === 2 && row('a1').done === true && row('a1').canRetry === false && bg() === 0, '100MB 넘는 메일은 «못 받음»에 들고 연결을 만들지 않는다, 다시 받기도 없다', { failed: row('a1').failed, bg: bg() });
  }

  console.log('\n[18] 보류의 끝 · [19] noMove');
  {
    const a1m = [mk(10)];
    // a3 는 MOVE·UIDPLUS 가 없고 STATUS 가 묵은 값을 준다 — 복사를 증명할 수 없어 정리가 그 계정을 멈춘다 (한 통도 안 옮긴다).
    // 진짜 정리 길을 지나 그 사실을 일지에 적는다
    const a3m = mk(50);
    const d = await reset({
      a1: { boxes: [inbox(a1m), trash()] },
      a3: { boxes: [inbox([a3m]), trash()], caps: ['IMAP4rev1', 'NAMESPACE'], statusStale: true }
    }, [A1, A3]);
    for (const a of [A1, A3]) putState(d, a, 'INBOX', { lowUid: 50, lastUid: 99999 });
    fileOf(d, A3, a3m);
    tidyEvery(true);
    store.setFillAnswer('a1', 'no');
    store.setFillAnswer('a3', 'no');
    await sleep(5);
    await poll();
    ok(tidyCalls.length === 2 && tidyCalls.every((c) => c.length === 1), '(정리가 한 번 돌았다 — 계정마다 하나씩)', tidyCalls);
    ok(!!mailmove.journal().blocked('a3') && server.box('a3', 'INBOX').msgs.length === 1, '(a3 는 시험 1통의 복사를 증명 못 해 멈췄다 — 원본은 그대로)', mailmove.blockedList());
    answer = null;
    asks.length = 0;
    store.setFillAnswer('a3', null);
    await set({ id: 'a3', on: true });
    ok(!asks[0].danger && !/서버 정리/.test(asks[0].detail), 'noMove — 질문에 정리 줄과 위험 표시가 없다', asks[0].danger);
    asks.length = 0;
    store.setFillAnswer('a1', null);
    await set({ id: 'a1', on: true });
    ok(asks[0].danger === true && /서버 정리가 켜져 있습니다/.test(asks[0].detail), '기록이 없는 계정은 지금 문구 그대로', asks[0].danger);

    F.nextAt = Date.now() + 999_999;     // 회차는 돌리지 않는다 — 날짜 판정만 본다
    store.setFillAnswer('a1', 'yes');
    store.setFillAnswer('a3', 'no');
    await backup.fillTick();
    ok(typeof store.settings.mailFillAt.a1 === 'number' && backup.fillAskLine() === '' && row('a1').stuckDays === 0, 'mailFillAt 이 없으면 지금 시각을 적고 멈춘 것이 아니다', store.settings.mailFillAt.a1 > 0);
    store.clearFillAnswers();
    store.setFillAnswer('a1', 'yes');
    store.setFillAnswer('a3', 'yes');
    store.setFillAt('a1', Date.now() - 4 * DAY);
    store.setFillAt('a3', Date.now() - 4 * DAY);
    await backup.fillTick();
    // 앱을 켠 뒤 회차가 한 번도 안 돌았다 — 4일은 앱을 꺼 둔 날일 수 있다. 믿고 «정리 허용»을 누르면 남은 메일을 포기한다
    ok(backup.fillAskLine() === '' && row('a1').stuckDays === 0 && row('a1').canRelease === false, '회차를 아직 안 돌렸으면 멈춘 것이 아니다', { line: backup.fillAskLine(), days: row('a1').stuckDays });
    F.memo.set('a1', { firstDone: true });
    F.memo.set('a3', { firstDone: true });
    await backup.fillTick();
    const line = backup.fillAskLine();
    ok(line === `${A1.name} · 지난 메일 받기가 4일째 나아가지 못해 서버 정리도 쉬고 있습니다. 눌러서 확인`, '3일 넘게 나아가지 못하면 위젯 줄', line);
    ok(row('a1').stuckDays === 4 && row('a1').canRelease === true && row('a1').holdsTidy === true, '…상태에 날짜, 정리 허용 단추', row('a1').stuckDays);
    ok(ans('a1') === 'yes', '…자동으로 풀리지 않는다');
    ok(row('a3').stuckDays === 0 && row('a3').holdsTidy === false && row('a3').canRelease === false, 'noMove 계정은 멈춤 줄·«쉬는 중»이 없다', row('a3').holdsTidy);
    // 틱이 한동안 없었다 — 앱이 꺼져 있었거나 PC 가 잠들었다. 그 시간은 «나아가지 못한 날»이 아니다
    const at18 = store.settings.mailFillAt.a1;
    store.setFillSeen(Date.now() - 4 * DAY);
    await backup.fillTick();
    ok(store.settings.mailFillAt.a1 >= at18 + 4 * DAY - 60_000 && row('a1').stuckDays === 0, '꺼져 있던 시간만큼 시계를 민다', { was: at18, now: store.settings.mailFillAt.a1 });
    ok(Date.now() - store.settings.mailFillSeen < 60_000, '…살아 있는 시각을 다시 적는다');
    const at18b = store.settings.mailFillAt.a1;
    await backup.fillTick();
    ok(store.settings.mailFillAt.a1 === at18b, '…틱이 이어지면 더 밀지 않는다');
    const seen18 = store.settings.mailFillSeen;
    await sleep(5);
    await backup.fillTick();
    ok(store.settings.mailFillSeen === seen18, '…한 시간 안에는 다시 적지 않는다 — 30초마다 설정 파일을 쓰지 않는다', store.settings.mailFillSeen - seen18);
    // 방금 나아간 계정 — 지금을 넘어 밀면 그만큼 멈춤을 늦게 알린다
    store.setFillAt('a1', Date.now() - 1000);
    store.setFillSeen(Date.now() - 4 * DAY);
    await backup.fillTick();
    ok(store.settings.mailFillAt.a1 <= Date.now(), '…지금을 넘어 밀지 않는다', store.settings.mailFillAt.a1 - Date.now());
    // a3 가 쉬는 동안 다른 계정으로 정리가 돌아도 기록을 잃지 않는다
    store.setFillAnswer('a1', 'no');
    tidyCalls.length = 0;
    await sleep(5);
    await poll();
    ok(JSON.stringify(tidyCalls[0]) === '["a1"]', '(쉬는 a3 를 빼고 a1 만 돌았다)', tidyCalls);
    ok(row('a3').holdsTidy === false, '…a3 의 멈춤은 남는다 (일지)');
    await mailmove.unblock('a3');
    tidyEvery(false);
    await backup.fillTick();
    ok(backup.fillAskLine() === '', '정리가 꺼지면 멈춤 줄이 사라진다', backup.fillAskLine());

    // 번호를 새로 매겼다 — 묻지 않고 전체를 다시 받으므로 알린다
    const d2 = await reset({ a1: { boxes: [inbox([10, 11], { uidValidity: 1700000001n })] } }, [A1]);
    putState(d2, A1, 'INBOX', { lowUid: 12, lastUid: 11, exists: 2 });
    store.setFillAnswer('a1', 'yes');
    await poll();
    ok(/^서버가 메일 번호를 새로 매겨 \d+통을 다시 받습니다$/.test(backup.fillAskLine()), '답이 yes 면 위젯 줄로 알린다', backup.fillAskLine());
    ok(lines.some((l) => l.includes('새로 매겨')), '…기록에도 남긴다');
    void d;
  }

  console.log('\n[20] 자동 저장 간격');
  {
    ok(backup.autoGapMs(0) === 120_000 && backup.autoGapMs(60_000) === 180_000, '빠른 서버는 2분, 느리면 지난 시간의 세 배', backup.autoGapMs(60_000));
    ok(backup.autoGapMs(3 * 3600_000) === 30 * 60_000, '3시간 걸린 고리 뒤에도 30분을 넘지 않는다', backup.autoGapMs(3 * 3600_000));
    await reset({ a1: { boxes: [inbox([10])] } }, [A1]);
    await poll();
    const n = connects.length;
    await backup.autoBackupNew();
    ok(connects.length === n, '간격 안에는 돌지 않는다', connects.length - n);
    await poll();
    ok(connects.length === n + 1, 'now 는 간격을 무시한다');
  }

  console.log('\n[21] 미리 받기');
  {
    const mailbody = require(path.join(ROOT, 'src', 'mailbody.js'));
    const uids = range(971, 1000).reverse();
    const mailState = { messages: uids.map((uid) => ({ accountId: 'a1', uid, mailbox: 'INBOX' })), folders: [], groups: [], sent: { messages: [] } };
    mailbody.init({ mailAccountsForUse: () => accounts, mailState });
    const fetched = [];
    const realSources = mail.fetchSources;
    mail.fetchSources = async (acc, list, o) => { fetched.push({ id: acc.id, uids: [...list], mailbox: o.mailbox }); return 0; };
    const d = await reset({}, [A1]);

    await mailbody.prefetchBodies();
    ok(fetched.length === 0, '기록이 없는 폴더는 건너뛴다 — 곧 자동 저장이 표시한다', fetched);

    // 맨 위 UID 1000 은 아직 lastUid 위 — 곧 자동 저장이 받는다. 그 아래 12통은 이미 저장됐다
    putState(d, A1, 'INBOX', { lowUid: 2000, lastUid: 999 });
    for (const u of range(988, 999)) fileOf(d, A1, mk(u));
    await mailbody.prefetchBodies();
    ok(fetched.length === 1 && JSON.stringify(fetched[0].uids) === JSON.stringify(range(976, 987).reverse()), '맨 위 12통이 저장돼 있어도 그 아래 옛 메일에 닿는다', fetched[0] && fetched[0].uids);
    ok(!fetched[0].uids.includes(1000), '…uid > lastUid 는 받지 않는다 (같은 메일을 두 번 받지 않게)');
    for (const v of ['yes', 'paused']) {
      fetched.length = 0;
      store.setFillAnswer('a1', v);
      await mailbody.prefetchBodies();
      ok(fetched.length === 0, `답이 ${v} 인 계정은 부르지 않는다 — 뒤 받기 몫이다`, fetched);
    }
    store.setFillAnswer('a1', 'no');
    fetched.length = 0;
    await mailbody.prefetchBodies();
    ok(fetched.length === 1, '답이 no 면 부른다');
    fetched.length = 0;
    store.setSettings({ mailAutoBackup: false });
    await mailbody.prefetchBodies();
    ok(fetched.length === 1 && JSON.stringify(fetched[0].uids) === JSON.stringify(range(989, 1000).reverse()), '자동 저장이 꺼진 동안은 지금처럼 맨 위 12통', fetched[0] && fetched[0].uids);
    store.setSettings({ mailAutoBackup: true });
    mail.fetchSources = realSources;

    // 메일 열기 — 저장돼 있으면 서버를 부르지 않는다 (비동기로 읽는다)
    let bodies = 0;
    const realBody = mail.fetchBody;
    mail.fetchBody = async () => { bodies += 1; return null; };
    const view = await mailbody.localOrServer(A1, { uid: 999, mailbox: 'INBOX', seen: false, at: 1 });
    ok(!!view && bodies === 0 && /report 999/.test(view.subject || ''), '저장된 메일은 디스크에서 연다', view && view.subject);
    await mailbody.localOrServer(A1, { uid: 500, mailbox: 'INBOX', seen: false, at: 1 });
    ok(bodies === 1, '저장 안 된 메일은 서버에서', bodies);
    mail.fetchBody = realBody;
  }

  console.log('\n[22] 차례 — 거부된 선택은 차례를 쓰지 않는다');
  {
    await reset({ a1: { boxes: [inbox([10])] }, a2: { boxes: [inbox([20])] } }, [A1, A2]);
    store.setFillAnswer('a1', 'yes');
    store.setFillAnswer('a2', 'yes');
    fillOverride = async () => RES({ why: 'budget' });
    await backup.fillTick();
    ok(fillCalls.length === 1 && fillCalls[0].id === 'a1', '(a1 차례)', fillCalls.map((c) => c.id));
    nextPoll = () => Date.now() + 100;
    await backup.fillTick();
    ok(fillCalls.length === 1, '다음 폴링이 가까우면 시작을 거부한다', fillCalls.map((c) => c.id));
    nextPoll = () => Infinity;
    await backup.fillTick();
    ok(fillCalls[1] && fillCalls[1].id === 'a2', '거부된 선택이 차례를 쓰지 않아 a2 가 돈다 — 느린 계정이 빠른 계정을 굶기지 않는다', fillCalls.map((c) => c.id));
    // 차례인 계정만 준비 시간이 길면 다른 계정은 돈다
    F.memo.get('a1').setupMs = 60_000;
    nextPoll = () => Date.now() + 530;
    await backup.fillTick();
    ok(fillCalls[2] && fillCalls[2].id === 'a2', '준비 시간이 긴 계정만 막힌다', fillCalls.map((c) => c.id));
    nextPoll = () => Infinity;
    await backup.fillTick();
    ok(fillCalls[3] && fillCalls[3].id === 'a1', '…그 다음 차례는 막혔던 계정이다', fillCalls.map((c) => c.id));
  }

  console.log('\n[23] 아무것도 못 받는 회차가 이어진다');
  {
    await reset({ a1: { boxes: [inbox([10, 11])] } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    fillOverride = async () => RES({ why: 'yield', noGain: true });
    lines.length = 0;
    await backup.fillTick();
    await backup.fillTick();
    const m = F.memo.get('a1');
    ok(m.idle === 2 && !m.retryAt && row('a1').state === 'yielding', '두 번은 그대로다 — 폴링이 끊었을 뿐이다', { idle: m.idle, state: row('a1').state });
    await backup.fillTick();
    const w1 = m.retryAt - Date.now();
    ok(w1 > 50_000 && w1 <= 60_000 && row('a1').state === 'retry' && row('a1').retryPlain === true, '세 번째면 1분 쉰다 — 연결 실패라고 하지 않는다', { w1, plain: row('a1').retryPlain });
    ok(row('a1').error === '서버가 느려 메일 확인 사이에 받지 못합니다', '…까닭을 말한다', row('a1').error);
    const n = fillCalls.length;
    await backup.fillTick();
    ok(fillCalls.length === n, '…그동안 부르지 않는다');
    ok(lines.filter((l) => l.includes('간격을 늘림')).length === 1, '…기록은 한 줄', lines);
    m.retryAt = 0;
    await backup.fillTick();
    const w2 = m.retryAt - Date.now();
    ok(w2 > 4 * 60_000 && w2 <= 5 * 60_000 && lines.filter((l) => l.includes('간격을 늘림')).length === 1, '…다음은 5분, 기록은 그대로 한 줄', w2);
    m.retryAt = 0;
    await backup.fillTick();
    m.retryAt = 0;
    await backup.fillTick();
    m.retryAt = 0;
    await backup.fillTick();
    const w5 = m.retryAt - Date.now();
    ok(w5 > 59 * 60_000 && w5 <= 60 * 60_000, '…한 시간을 넘지 않는다', w5);
    m.retryAt = 0;
    fillOverride = async () => RES({ why: 'stop', noGain: false });
    const before = m.idle;
    await backup.fillTick();
    ok(m.idle === before && !m.retryAt, '멈추기는 세지 않고 지우지도 않는다', m.idle);
    fillOverride = async () => RES({ why: 'yield', saved: 3 });
    await backup.fillTick();
    ok(m.idle === 0 && !m.retryAt && row('a1').state === 'yielding', '받으면 처음부터다', m.idle);
    // 연결 준비에 몫을 다 쓰면 다음 회차의 몫을 늘린다 — LIST 를 못 끝내면 다음에도 처음부터다
    m.setupMs = 1000;
    fillOverride = async () => RES({ why: 'budget' });
    const k = fillCalls.length;
    await backup.fillTick();
    ok(fillCalls[k].budgetMs === 2000, '준비 시간의 두 배까지 몫을 준다', fillCalls[k].budgetMs);
    m.setupMs = 3_600_000;
    await backup.fillTick();
    ok(fillCalls[k + 1].budgetMs === 15 * 60_000, '…상한은 큰 메일 몫과 같다', fillCalls[k + 1].budgetMs);
    m.setupMs = 0;
  }

  console.log('\n[24] 앱을 다시 켜도 옮기기를 멈춘 계정을 안다 · MOVE 없는 계정은 멈춘 계정이 아니다');
  {
    const A4 = acct('a4');
    await reset({ a4: { boxes: [inbox([mk(50)]), trash()], caps: ['IMAP4rev1', 'UIDPLUS', 'NAMESPACE'] } }, [A4]);
    lines.length = 0;
    store.setFillAnswer('a4', 'yes');
    tidyEvery(true);
    F.nextAt = Date.now() + 999_999;
    // MOVE 가 없어도 정리는 복사 길로 옮긴다 — 받는 동안 쉬는 것이 맞고, 다 받으면 옮겨진다고 경고해야 한다
    ok(row('a4').holdsTidy === true, 'MOVE 없는 계정도 지난 메일을 받는 동안 정리가 쉰다 (복사 길로 옮기므로)', row('a4').holdsTidy);
    await poll();
    ok(tidyCalls.length === 0 && row('a4').holdsTidy === true, '…폴링 뒤에도 그대로 — MOVE 유무로 «안 옮김»을 배우지 않는다', tidyCalls);
    const capsLines = () => lines.filter((l) => /^메일\|서버 기능 · /.test(l));
    ok(capsLines().length === 1 && /서버 기능 · 회사a4 · 옮기기\(MOVE\) 없음 · UIDPLUS 있음/.test(capsLines()[0]) && !/@/.test(capsLines()[0]),
      '폴링 연결이 서버 기능 한 줄을 기록에 남긴다 (주소 없이)', capsLines());
    await sleep(5);
    await poll();
    ok(capsLines().length === 1, '…같은 줄은 이번 실행에서 다시 적지 않는다', capsLines().length);
    const srv = () => T().servers.find((x) => x.id === 'a4');
    ok(/^옮기기\(MOVE\) 없음/.test(srv().caps || '') && srv().capsAt > 0 && srv().stopped === null, '…설정 화면이 볼 수 있게 상태에 둔다', srv());
    // 서버 탓으로 멈춘 계정 — 일지 파일에 남아 앱을 다시 켜도 안다
    const jf = path.join(USER, mailmove.JOURNAL_FILE);
    mailmove.setJournalFile(jf);
    await mailmove.journal().block(mailbackup.accountKey(A4), '서버가 지움 표시를 거부해 원본을 남겼습니다');
    mailmove.setJournalFile(jf);     // 앱을 다시 켠 셈 — 메모리는 비고 파일만 남았다
    ok(row('a4').holdsTidy === false && row('a4').canRelease === false, '멈춘 계정 — 다시 켜도 «서버 정리 쉬는 중»이 안 뜬다 (일지 파일)', row('a4').holdsTidy);
    ok(/지움 표시를 거부/.test(srv().stopped || '') && srv().stoppedAt > 0, '…설정 화면에 멈춘 까닭', srv());
    store.setFillAt('a4', Date.now() - 4 * DAY);
    F.memo.set('a4', { firstDone: true });
    await backup.fillTick();
    ok(row('a4').stuckDays === 0 && backup.fillAskLine() === '', '…오래 멈춤 줄도 없다', backup.fillAskLine());
    store.setFillAnswer('a4', 'paused');
    ok(row('a4').holdsTidy === false && row('a4').canRelease === false, '…멈춘 계정도 같다 — 정리 허용의 거짓 경고가 안 뜬다');
    ok(await backup.retryMove('a4') === true && lines.some((l) => /옮기기 다시 해 보기 · 회사a4/.test(l)), '«다시 해 보기»(retryMove)가 멈춤을 풀고 기록한다');
    ok(row('a4').holdsTidy === true && srv().stopped === null, '…풀면 다시 쉰다', row('a4').holdsTidy);
    ok(await backup.retryMove('a4') === false && await backup.retryMove('없는 계정') === false, '…멈추지 않은 계정·없는 계정은 거짓');
    mailmove.setJournalFile(null);
    tidyEvery(false);
  }

  console.log('\n[25] 상태 — 서버 정리가 쉬는 까닭, 메일 확인 값');
  {
    await reset({ a1: { boxes: [inbox([10]), trash()] } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    answer = 0;
    asks.length = 0;
    const r = await backup.setTidy({ id: 'a1', on: true }, parent, { fromSettings: true, countMs: 500, startMs: 50 });
    ok(r.tidy.message === '회사a1 · 켰습니다 — 지난 메일을 다 받은 뒤부터 옮깁니다. 그 전에 끄면 옮기지 않습니다.', '지난 메일을 받는 계정을 켜면 «1분쯤 뒤부터»라고 하지 않는다', r.tidy.message);
    ok(/이 계정은 지난 메일을 받는 중이라 다 받은 뒤부터 옮깁니다/.test(asks[0].detail) && !/분쯤 뒤 시작/.test(asks[0].detail), '…확인 창도 그렇게 말한다', asks[0].detail);
    ok(tr('a1').held === true && !('held' in T()) && !('allHeld' in T()), '…상태의 그 계정 줄에 «쉼» (위쪽 공통 수는 없다)', tr('a1'));
    store.setFillAnswer('a1', 'no');
    ok(tr('a1').held === false, '답이 no 면 쉬지 않는다', tr('a1'));
    await backup.setTidy({ id: 'a1', on: false }, parent, { fromSettings: true });
    await sleep(120);
    await until(() => !T().running && !backup.backupStatus().autoRunning);
    ok(backup.backupStatus().mailEnabled === true, '상태에 메일 확인 값이 있다 — 화면이 창을 열 때 받은 값을 안 본다');
    store.setSettings({ mailEnabled: false });
    ok(backup.backupStatus().mailEnabled === false && T().why === '«메일 확인하기»를 켜야 쓸 수 있습니다.', '…끄면 곧바로 따라온다', T().why);
    store.setSettings({ mailEnabled: true });

    // 일부 계정만 받는 중 — 계정마다 켜므로, 받지 않는 계정을 켜면 «곧»이고 쉬는 것은 받는 계정 줄뿐이다
    await reset({ a1: { boxes: [inbox([10]), trash()] }, a2: { boxes: [inbox([20]), trash()] } }, [A1, A2]);
    store.setFillAnswer('a1', 'yes');
    store.setFillAnswer('a2', 'no');
    answer = 0;
    asks.length = 0;
    const rp = await backup.setTidy({ id: 'a2', on: true }, parent, { fromSettings: true, countMs: 500, startMs: 50 });
    ok(/^회사a2 · 켰습니다 — \d+분쯤 뒤부터 옮깁니다\./.test(rp.tidy.message), '받지 않는 계정을 켜면 «곧» 옮긴다고 말한다', rp.tidy.message);
    ok(/분쯤 뒤 시작/.test(asks[0].detail) && !/지난 메일을 받는/.test(asks[0].detail) && /^회사a2 · /.test(asks[0].message), '…확인 창도 그 계정 것만 말한다', asks[0]);
    store.setTidyAccount('a1', { on: true });
    ok(tr('a1').held === true && tr('a2').held === false, '…쉬는 것은 받는 계정 줄뿐', [tr('a1').held, tr('a2').held]);
    await backup.setTidy({ id: 'a2', on: false }, parent, { fromSettings: true });
    await backup.setTidy({ id: 'a1', on: false }, parent, { fromSettings: true });
    await sleep(120);
    await until(() => !T().running && !backup.backupStatus().autoRunning);

    // 옮기기를 멈춘 계정은 쉬는 것이 아니라 «다시 해 보기» 전까지 못 옮긴다 — 쉰다고 하면 «다 받은 뒤부터 옮긴다»는 거짓말이 된다
    const A4b = acct('a4');
    await reset({ a1: { boxes: [inbox([10]), trash()] }, a4: { boxes: [inbox([mk(50)]), trash()], caps: ['IMAP4rev1', 'UIDPLUS', 'NAMESPACE'] } }, [A1, A4b]);
    store.setFillAnswer('a1', 'no');
    store.setFillAnswer('a4', 'yes');
    await mailmove.journal().block('a4', '서버가 지움 표시를 거부해 원본을 남겼습니다');
    await poll();
    tidyEvery(true);
    ok(row('a4').holdsTidy === false && tr('a4').held === false && tr('a4').blocked === '서버가 지움 표시를 거부해 원본을 남겼습니다',
      '멈춘 계정은 쉬는 것으로 세지 않고 멈춤으로 보인다', tr('a4'));
    await mailmove.unblock('a4');
    tidyEvery(false);
  }

  console.log('\n[26] UIDVALIDITY 를 늘 안 주는 서버');
  {
    const d = await reset({ a1: { boxes: [inbox([10, 11], { noUidValidity: true })] } }, [A1]);
    mailbackup.patchState(d, 'a1', 'INBOX', { uidValidity: 'undefined', gen: 1, lowUid: 1, lastUid: 10, exists: 1 });
    await poll();
    const seen = F.listed.get('a1');
    ok(seen && seen.clean === true && same3(seen.boxErrors, []) && backup.backupStatus().autoError === null, '새 메일 저장이 이어지고 폴더 오류가 아니다', seen);
    ok((await mailbackup.uidFiles(mailbackup.boxDirFor(d, A1, 'INBOX', 1))).has(11), '…새 메일이 파일로 남았다');
    await backup.fillTick();
    ok(ans('a1') === 'asked' && row('a1').listed === true && row('a1').unfillable === 1, '지난 메일 줄이 첫 확인 전에 멈추지 않고 묻는다, 못 받는 폴더 수가 보인다', row('a1').unfillable);
    store.setFillAnswer('a1', 'yes');
    const n = bg();
    await backup.fillTick();
    ok(row('a1').done === true && bg() === n, '받을 것이 없으니 연결하지 않는다', { done: row('a1').done, bg: bg() - n });
  }

  console.log('\n[27] 못 연 폴더가 있으면 회차 중에도 모른다고 한다');
  {
    await reset({ a1: { boxes: [inbox(range(10, 14)), { path: 'Work', uidValidity: V, noUidValidity: true, msgs: [mk(5)] }] } }, [A1]);
    await poll();
    store.setFillAnswer('a1', 'yes');
    const seen = [];
    fillOverride = async (a, dd, o) => {
      o.onProgress({ phase: 'body', box: 'INBOX', saved: 1 });
      seen.push(row('a1').left);
      return RES();
    };
    await backup.fillTick();
    ok(seen.length === 1 && seen[0] === null, '모자란 수를 말하지 않는다', seen);
  }

  console.log('\n[28] 쓸 수 있는 계정에서 빠진 계정');
  {
    await reset({ a1: { boxes: [inbox([10])] } }, [A1]);
    store.setFillAnswer('a1', 'yes');
    accounts = [];
    await backup.fillTick();
    ok(row('a1').state === 'unusable' && fillCalls.length === 0, '«잠시 뒤»라고 하지 않는다', row('a1').state);
    accounts = [A1];
    fillOverride = async () => RES({ why: 'budget' });
    await backup.fillTick();
    ok(row('a1').state !== 'unusable' && fillCalls.length === 1, '다시 쓸 수 있으면 풀린다', row('a1').state);
  }

  ok(fs.readdirSync(HOME).length === 0 && fs.readdirSync(DOCS).length === 0, '처음부터 끝까지 홈·문서 폴더에 아무것도 만들지 않았다');
  // 폴더 경로는 지난 메일 줄만 본다 — «백업 시작» 기록은 원래 폴더를 적는다
  const leaks = allLines.filter((l) => l.replace(/•••@•••/g, '').includes('@') || /report \d/.test(l) || (l.includes('지난 메일') && l.includes(tmp)));
  ok(!leaks.length, '처음부터 끝까지 기록에 주소·제목이 없고, 지난 메일 줄에 폴더 경로가 없다', leaks.slice(0, 3));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

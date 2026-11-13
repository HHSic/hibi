// 설정 › PC에 받아 둔 메일 › «지난 메일» — 계정 줄의 글과 단추가 메인의 답대로 그려지고, 누르면 메인에 부탁만 하는가.
//
// 지난 메일 받기는 서버의 메일을 몇 년치 내려받고, 받는 동안 그 계정의 서버 정리를 쉬게 한다. 받기와 정리 허용은 메인이 확인 창으로
// 묻는다 — 화면은 미리 칠하지 않고 mailFillSet 으로 부탁만 한다. 일반 setApp 으로 새면 확인을 건너뛴다.
//
// 진짜 settings.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/settings-mail-bridge-stub.js 를 쓴다.
// 메일 서버·자격 증명 관리자에는 가지 않는다 (mail.connect 를 막고, 회차를 돌리는 틱을 부르지 않는다). 가짜 계정 주소는 *.invalid 다.
// 위젯 줄은 창을 띄우지 않고 소스만 본다 — src/main.js 없이는 재현 비용이 크다. 눈으로 보는 일은 사용자 PC에 남는다.
//
// [1] st.fill 이 없으면 #fill-wrap 을 감추고 옛 그림 그대로 («백업 시작»이 보인다). 답하기 전·on:false·계정 없음도 감춘다
// [2] 줄 글과 단추 — 설계 표의 모든 상태. paused 의 두 단추, canRelease 거짓이면 정리 허용 없음, stuckDays, boxErrors, needBytes,
//     남은 수를 모를 때, 멈춘 직후의 끝나 가는 회차, 다시 부르는 회차, 계정이 늘고 주는 때, 못 받는 폴더, OneDrive
// [3] 단추 — 정하기·멈추기·받기·이어 받기·정리 허용이 mailFillSet 만 부른다. 답을 그리고 초점을 지킨다.
//     기다리는 동안 켜는 쪽은 다시 부탁하지 않고 멈추기는 보낸다. 응답 없음. 도는 동안만 2초 폴링
// [4] #mailAutoBackup 줄은 숨겨졌고 요소는 있다
// [5] st.fill 이 있으면 #btn-backup-start 를 숨긴다
// [6] 다크·라이트 — 줄 색이 안내 줄과 같고, 단추는 다른 단추와 같은 칠, 막힌 단추는 0.45
// [7] 문구 — 고친 글이 설계와 같고, 보이는 곳에 «백업 시작»이 없다
// [8] 진짜 src/backup.js 처리기 (확인 창 popup.askUser 만 바꿔 끼운다) — 화면과 메인이 같은 약속을 지키는가
// [9] 위젯 줄(paintNote)과 preload — 파일에서 본다
// [10] 계정을 더하거나 켜거나, 알림으로 탭이 열리면 다시 읽는다. 자동 저장 줄은 메인의 메일 확인 값을 본다
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fillui-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));
const BACKUP_DIR = path.join(tmp, 'backup');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
// 화면 상태 덩어리가 길다 — 통과한 줄은 앞부분만, 실패한 줄은 다 찍는다
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 160 ? `${s.slice(0, 160)}…` : s}` : ''));
  if (!c) bad++;
};
const until = async (fn, ms = 5000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};
/** 열 때까지 기다리게 하는 문 — 메인의 답을 붙잡아 «기다리는 동안»을 잰다 */
const gate = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const GB = 1024 ** 3;

// 지난 메일·서버 정리 키 — 화면이 setApp 으로 보내면 안 된다 (메인 store 가 버리지만, 보내는 것 자체가 길을 잘못 든 것이다)
const GATED = ['mailFill', 'mailFillAt', 'mailTidyAccounts', 'mailTidyResults', 'mailBackupDir', 'mailServerTidy', 'mailTidyDays', 'mailTidyLast'];
// 화면이 읽는 계정 줄의 키 — 메인과의 고정 계약
const ROW_KEYS = ['id', 'name', 'listed', 'answer', 'left', 'leftBytes', 'failed', 'done', 'holdsTidy', 'canRelease', 'stuckDays',
  'needBytes', 'floorBytes', 'boxErrors', 'state', 'phase', 'box', 'saved', 'retryMin', 'retryPlain', 'error', 'leftRough', 'unfillable', 'canRetry'];

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  // 서버에는 절대 붙지 않는다 — 회차를 돌리지 않지만 한 겹 더 막는다
  mail.connect = () => { throw new Error('시험: 서버에 붙지 않는다'); };
  const popup = require(path.join(ROOT, 'src', 'popup.js'));
  // 확인 창이 진짜로 뜨면 사용자 모니터에 나온다 — 바꿔 끼우기 전에 불리면 바로 실패로 끝낸다
  popup.askUser = async () => { throw new Error('시험: 진짜 확인 창을 띄우려 했다'); };
  require(path.join(ROOT, 'src', 'mailfilter.js'));   // 'mail:rules' — 설정 탭이 그리는 필터 목록

  // 시험이 만든 창 말고 다른 창(확인 창 등)이 생기면 보이기 전에 부수고 실패로 센다
  let making = false;
  const strays = [];
  app.on('browser-window-created', (_e, w) => {
    if (making) return;
    strays.push(w.id);
    setImmediate(() => { if (!w.isDestroyed()) w.destroy(); });
  });

  ipcMain.handle('mail:get', () => ({ accounts: [], status: { canStore: true }, presets: mail.PRESETS }));
  const addAcct = { id: 'n1', name: '새 계정', host: 'imap.invalid', user: 'new@corp.invalid', enabled: true };
  ipcMain.handle('mail:add', () => ({ ok: true, message: '연결했습니다', accounts: [addAcct], settings: { ...store.settings, mailEnabled: true } }));
  ipcMain.handle('mail:update', () => [addAcct]);
  const settingsData = () => ({
    settings: { ...store.settings, mailEnabled: true, mailAutoBackup: true, autoLaunch: false },
    reminders: store.reminders,
    custom: store.custom,
    calendars: [],
    enterCustom: [],
    calendarStatus: {},
    dndPresets: [],
    update: null,
    types: reminders.TYPES.map((t) => ({ id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind, headline: t.headline }))
  });
  ipcMain.on('stub:settings', (e) => { e.returnValue = settingsData(); });

  // ── 시험용 메인 처리기 ───────────────────────
  // auto:false 로 둬 20초 폴링이 끼어들지 않게 한다 (화면이 다시 읽는 때를 시험이 센다)
  const baseStatus = () => ({ running: false, stop: false, account: '', mailbox: '', done: 0, total: 0, saved: 0, skipped: 0,
    message: '', at: 0, dir: BACKUP_DIR, auto: false, autoAt: 0, autoSaved: 0, autoTotal: 0, autoSeeded: 0, autoError: null, waiting: '' });
  const row = (x = {}) => ({ id: 'a1', name: '회사', listed: true, answer: null, left: null, leftBytes: null, failed: 0, done: false,
    holdsTidy: false, canRelease: false, stuckDays: 0, needBytes: null, floorBytes: null, boxErrors: [], state: 'idle', phase: '', box: '',
    saved: 0, retryMin: 0, retryPlain: false, error: null, leftRough: false, unfillable: 0, canRetry: false, ...x });
  const baseFill = (accounts, x = {}) => ({ on: true, oneDrive: false, message: '', messageKind: '', asking: false, accounts, ...x });
  let fakeFill = null;
  let fakeExtra = {};
  let statusCalls = 0;
  let statusGate = null;
  const fakeStatus = () => ({ ...baseStatus(), ...fakeExtra, ...(fakeFill ? { fill: fakeFill } : {}) });
  ipcMain.handle('mail:backup-status', async () => {
    statusCalls++;
    if (statusGate) await statusGate.promise;
    return fakeStatus();
  });
  const setCalls = [];
  let setGate = null;
  let stopPass = false;   // 참이면 멈추기 부탁은 문에 걸리지 않고 바로 답한다 (켜는 부탁을 붙잡아 둔 채 멈추기)
  let setReply = () => fakeStatus();
  ipcMain.handle('mail:fill-set', async (_e, req) => {
    setCalls.push(req);
    if (setGate && !(stopPass && req && req.on === false)) await setGate.promise;
    return setReply(req);
  });
  /** 답 — 메인이 상태를 바꾸고 말을 실어 돌려준 모양 */
  const answers = (accounts, message, messageKind = 'good') => {
    fakeFill = baseFill(accounts);
    return { ...fakeStatus(), fill: baseFill(accounts, { message, messageKind }) };
  };

  making = true;
  const win = new BrowserWindow({ show: false, width: 520, height: 900,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'settings-mail-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  making = false;
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  const js = (c) => win.webContents.executeJavaScript(c);

  const ui = () => js(`(() => {
    const $ = (id) => document.getElementById(id);
    const vis = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
    const msg = $('fill-msg');
    return {
      wrap: vis($('fill-wrap')),
      lbl: $('fill-wrap').querySelector('.lbl').textContent,
      rows: [...document.querySelectorAll('#fill-rows .fillrow')].map((r) => ({
        id: r.dataset.id,
        text: r.querySelector('.fillline').textContent,
        sub: vis(r.querySelector('.fillsub')) ? r.querySelector('.fillsub').textContent : null,
        btns: [...r.querySelectorAll('button')].filter(vis).map((b) => b.textContent),
        off: [...r.querySelectorAll('button')].filter(vis).map((b) => b.getAttribute('aria-disabled')),
        cls: [...r.querySelectorAll('button')].filter(vis).map((b) => b.className),
        aria: [...r.querySelectorAll('button')].filter(vis).map((b) => b.getAttribute('aria-label'))
      })),
      msg: msg.classList.contains('show')
        ? { text: msg.textContent, kind: ['good', 'bad', 'wait'].find((k) => msg.classList.contains(k)) || '' } : null,
      msgRole: msg.getAttribute('role'),
      start: vis($('btn-backup-start')),
      backupDir: $('backup-dir').textContent,
      autoLine: $('backup-auto').textContent,
      sets: (window.__fillSet || []).slice()
    };
  })()`);
  const repaint = async () => { await js('window.nunsSetMail.loadBackup()'); await sleep(50); return ui(); };
  const show = async (fill, extra = {}) => { fakeFill = fill; fakeExtra = extra; return repaint(); };
  const showRow = (x) => show(baseFill([row(x)]));
  const press = (label, id = 'a1') => js(`[...document.querySelector('#fill-rows [data-id="${id}"]').querySelectorAll('button')]
    .find((b) => b.textContent === ${JSON.stringify(label)} && !b.hidden).click()`);

  console.log('\n[1] st.fill 이 없으면');
  statusGate = gate();
  await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'mail' } });
  await until(() => statusCalls >= 1);
  const u0 = await ui();
  ok(!u0.wrap, '메인이 답하기 전에는 지난 메일 칸이 감춰져 있다', u0);
  const g0 = statusGate;
  statusGate = null;
  g0.open();
  const u1 = await until(async () => { const u = await ui(); return u.backupDir === BACKUP_DIR ? u : null; });
  ok(!!u1 && !u1.wrap && u1.rows.length === 0, 'st.fill 이 없는 답이면 그린 뒤에도 감춘 채다', u1);
  ok(!!u1 && u1.start, '…옛 그림 그대로 «백업 시작»이 보인다', u1 && u1.start);
  const u1b = await show(baseFill([row()]));
  ok(u1b.wrap && u1b.lbl === '지난 메일' && u1b.msg === null && u1b.msgRole === 'status', 'st.fill 이 오면 보인다 — 이름은 «지난 메일», 알림 자리는 role=status', u1b);
  const u1c = await show(null);
  ok(!u1c.wrap, '…다시 없어지면 감춘다 (옛 메인으로 돌아간 것과 같다)', u1c.wrap);
  const u1d = await show(baseFill([row({ answer: 'yes', state: 'waiting', left: 5 })], { on: false }));
  ok(!u1d.wrap, '메일 확인이 꺼져 있으면(on:false) 감춘다 — «잠시 뒤 이어 받습니다»는 거짓말이 된다', u1d.wrap);
  const u1e = await show(baseFill([]));
  ok(!u1e.wrap, '계정이 없으면 감춘다', u1e.wrap);

  console.log('\n[2] 줄 글과 단추');
  const CASES = [
    ['아직 첫 확인 전', { listed: false }, '회사 · 첫 메일 확인이 끝나면 물어봅니다', []],
    ['첫 확인 전 — 알림을 띄웠어도(asked) 앱을 다시 켠 뒤에는 같다', { listed: false, answer: 'asked', left: 7 }, '회사 · 첫 메일 확인이 끝나면 물어봅니다', []],
    ['답 없음, 통수 앎', { left: 2100 }, '회사 · 지난 메일 최대 2100통 · 아직 정하지 않았습니다', ['정하기']],
    ['asked 도 답 없음이다', { answer: 'asked', left: 2100 }, '회사 · 지난 메일 최대 2100통 · 아직 정하지 않았습니다', ['정하기']],
    ['답 없음, 통수 모름', { left: null }, '회사 · 지난 메일을 받을지 아직 정하지 않았습니다', ['정하기']],
    ['답 없음, 0통 — «최대 0통»이라고 하지 않는다', { left: 0 }, '회사 · 지난 메일을 받을지 아직 정하지 않았습니다', ['정하기']],
    ['위로 잡은 수 — 옛 기록이라 그 폴더를 아직 안 열었다', { answer: 'no', left: 2000, leftRough: true }, '회사 · 받지 않음 — 새 메일과 열어 본 메일만 저장합니다 · 남은 최대 2000통', ['받기']],
    ['running, 머리', { answer: 'yes', state: 'running', phase: 'head', left: 2100 }, '회사 · 지난 메일 목록을 받는 중 · 남은 약 2100통', ['멈추기']],
    ['running, 회차 시작 — 아직 목록을 받는 것이 아니다', { answer: 'yes', state: 'running', phase: '', left: 2100 }, '회사 · 서버에 연결하는 중 · 남은 약 2100통', ['멈추기']],
    ['쓸 수 없는 계정', { answer: 'yes', state: 'unusable', left: 9 }, '회사 · 계정을 지금 쓸 수 없어 쉬는 중입니다 · 남은 약 9통', ['멈추기']],
    ['running, 본문', { answer: 'yes', state: 'running', phase: 'body', box: 'INBOX', saved: 12, left: 2088 }, '회사 · 지난 메일 받는 중 · INBOX · 이번에 12통 · 남은 약 2088통', ['멈추기']],
    ['running, 본문 + leftBytes (작으면 소수 한 자리)', { answer: 'yes', state: 'running', phase: 'body', box: 'INBOX', saved: 12, left: 2088, leftBytes: 3.5 * GB }, '회사 · 지난 메일 받는 중 · INBOX · 이번에 12통 · 남은 약 2088통 · 약 3.5GB', ['멈추기']],
    ['running, 본문 + leftBytes (크면 정수)', { answer: 'yes', state: 'running', phase: 'body', box: '보관', saved: 0, left: 50000, leftBytes: 41.6 * GB }, '회사 · 지난 메일 받는 중 · 보관 · 이번에 0통 · 남은 약 50000통 · 약 42GB', ['멈추기']],
    ['yielding', { answer: 'yes', state: 'yielding', left: 2100 }, '회사 · 메일 확인이 끝나면 이어 받습니다 · 남은 약 2100통', ['멈추기']],
    ['waiting', { answer: 'yes', state: 'waiting', left: 2100 }, '회사 · 잠시 뒤 이어 받습니다 · 남은 약 2100통', ['멈추기']],
    ['retry', { answer: 'yes', state: 'retry', left: 2100, error: '서버가 응답하지 않습니다', retryMin: 5 }, '회사 · 연결 실패 — 서버가 응답하지 않습니다 · 5분 뒤 다시 합니다', ['멈추기']],
    ['retry, 연결 탓이 아님 — 쓰기·상태·폴더 오류', { answer: 'yes', state: 'retry', left: 2100, error: '이 폴더에 쓸 수 없습니다', retryMin: 5, retryPlain: true }, '회사 · 이 폴더에 쓸 수 없습니다 · 5분 뒤 다시 합니다', ['멈추기']],
    ['retry, 사유 없음', { answer: 'yes', state: 'retry', left: 2100, retryMin: 5, retryPlain: true }, '회사 · 5분 뒤 다시 합니다', ['멈추기']],
    ['refused', { answer: 'yes', state: 'refused', left: 2100, retryMin: 30 }, '회사 · 서버가 잠시 로그인을 거절했습니다 · 30분 뒤 다시 합니다', ['멈추기']],
    ['refused, 까닭 있음 — 하루 한도·웹 로그인 같은 까닭을 «로그인 거절»로 바꾸지 않는다', { answer: 'yes', state: 'refused', left: 2100, retryMin: 30, error: '메일 서버의 하루 사용량 한도를 넘었습니다 — 하루쯤 뒤 다시 됩니다' }, '회사 · 메일 서버의 하루 사용량 한도를 넘었습니다 — 하루쯤 뒤 다시 됩니다 · 30분 뒤 다시 합니다', ['멈추기']],
    ['auth', { answer: 'yes', state: 'auth', left: 2100 }, '회사 · 로그인이 거절돼 멈췄습니다 — 비밀번호를 확인하세요', ['멈추기']],
    ['disk, needBytes 있음', { answer: 'yes', state: 'disk', left: 2100, needBytes: 12 * GB }, '회사 · 약 12GB가 더 필요한데 공간이 모자라 멈췄습니다 · 비우면 이어 받습니다. 다른 폴더를 고르면 처음부터 다시 묻고 받습니다', ['멈추기']],
    ['disk, needBytes 없음', { answer: 'yes', state: 'disk', left: 2100, floorBytes: 44 * GB }, '회사 · 공간이 모자라 멈췄습니다 · 여유 공간이 44GB를 넘으면 이어 받습니다', ['멈추기']],
    ['disk, 바닥을 재기 전에 쓰기가 실패 — 숫자를 지어내지 않는다', { answer: 'yes', state: 'disk', left: 2100 }, '회사 · 공간이 모자라 멈췄습니다 · 비우면 이어 받습니다', ['멈추기']],
    ['paused, canRelease 거짓 — 정리 허용 없음', { answer: 'paused', left: 2100 }, '회사 · 멈췄습니다 · 남은 약 2100통', ['이어 받기']],
    ['paused, canRelease 참 — 두 단추', { answer: 'paused', left: 2100, canRelease: true, holdsTidy: true }, '회사 · 멈췄습니다 · 남은 약 2100통 · 서버 정리 쉬는 중', ['이어 받기', '정리 허용']],
    ['멈춘 직후 끝나 가는 회차 — 답을 먼저 본다', { answer: 'paused', state: 'running', phase: 'body', box: 'INBOX', left: 2100 }, '회사 · 멈췄습니다 · 남은 약 2100통', ['이어 받기']],
    ['no', { answer: 'no', left: 2100 }, '회사 · 받지 않음 — 새 메일과 열어 본 메일만 저장합니다 · 남은 약 2100통', ['받기']],
    ['no, 남은 수 모름', { answer: 'no', left: null }, '회사 · 받지 않음 — 새 메일과 열어 본 메일만 저장합니다', ['받기']],
    ['done', { answer: 'yes', done: true, left: 0 }, '회사 · 지난 메일을 모두 받았습니다', []],
    ['done, 못 받은 메일 — «모두 받았습니다»라고 하지 않는다', { answer: 'yes', done: true, left: 0, failed: 3 }, '회사 · 지난 메일 받기를 마쳤습니다 · 못 받음 3통', []],
    ['done 뒤 멈춤도 done', { answer: 'paused', done: true, left: 0 }, '회사 · 지난 메일을 모두 받았습니다', []],
    ['done 뒤 멈춤 + 못 받은 메일 — 다시 부르지 않으니 길을 둔다', { answer: 'paused', done: true, left: 0, failed: 1, canRetry: true }, '회사 · 지난 메일 받기를 마쳤습니다 · 못 받음 1통', ['다시 받기']],
    ['done 뒤 멈춤 + 100MB 넘는 메일만 — 다시 받아도 소용없다', { answer: 'paused', done: true, left: 0, failed: 1, canRetry: false }, '회사 · 지난 메일 받기를 마쳤습니다 · 못 받음 1통', []],
    ['못 받은 메일을 다시 부르는 회차 — 끝난 뒤에도 도는 줄', { answer: 'yes', done: true, state: 'running', phase: 'body', box: 'INBOX', left: 0 }, '회사 · 못 받은 메일을 다시 받는 중', ['멈추기']],
    ['…연결 중이어도 같다', { answer: 'yes', done: true, state: 'running', phase: '', left: 0 }, '회사 · 못 받은 메일을 다시 받는 중', ['멈추기']],
    ['남은 수를 모르면 «null통»이라고 쓰지 않는다', { answer: 'yes', state: 'waiting', left: null }, '회사 · 잠시 뒤 이어 받습니다', ['멈추기']],
    ['holdsTidy', { answer: 'yes', state: 'waiting', left: 9, holdsTidy: true }, '회사 · 잠시 뒤 이어 받습니다 · 남은 약 9통 · 서버 정리 쉬는 중', ['멈추기']],
    ['stuckDays — 줄 끝과 정리 허용', { answer: 'yes', state: 'auth', holdsTidy: true, canRelease: true, stuckDays: 4 }, '회사 · 로그인이 거절돼 멈췄습니다 — 비밀번호를 확인하세요 · 서버 정리 쉬는 중 · 4일째 나아가지 못함', ['멈추기', '정리 허용']]
  ];
  for (const [name, x, text, btns] of CASES) {
    const u = await showRow(x);
    const r = u.rows[0] || {};
    ok(u.wrap && u.rows.length === 1 && r.text === text && same(r.btns, btns) && r.sub === null, name, { text: r.text, btns: r.btns, sub: r.sub });
  }

  const b1 = await showRow({ answer: 'yes', state: 'waiting', left: 9, boxErrors: ['스팸함: 서버가 거절했습니다', '보관: 연결 끊김'] });
  ok(b1.rows[0].sub === '못 연 폴더 2개 — 스팸함: 서버가 거절했습니다', 'boxErrors — 둘째 줄에 수와 첫 오류', b1.rows[0].sub);
  const b2 = await showRow({ answer: 'yes', state: 'waiting', left: 9, boxErrors: ['스팸함: 거절', '스팸함: 거절'] });
  ok(b2.rows[0].sub === '못 연 폴더 1개 — 스팸함: 거절', '…폴링과 회차가 같은 글을 줘도 두 폴더로 세지 않는다', b2.rows[0].sub);
  const b4 = await showRow({ answer: 'no', left: 9, failed: 2 });
  ok(b4.rows[0].sub === '못 받은 메일 2통', '못 받은 메일 — 다 받기 전에는 둘째 줄에 수를 보인다', b4.rows[0].sub);
  const b5 = await showRow({ answer: 'yes', state: 'waiting', left: 9, failed: 2, boxErrors: ['스팸함: 거절'] });
  ok(b5.rows[0].sub === '못 연 폴더 1개 — 스팸함: 거절 · 못 받은 메일 2통', '…폴더 오류가 있으면 함께', b5.rows[0].sub);
  const b6 = await showRow({ answer: 'yes', done: true, left: 0, failed: 2 });
  ok(b6.rows[0].sub === null && b6.rows[0].text.endsWith('못 받음 2통'), '…다 받았으면 완료 줄이 말한다', b6.rows[0]);
  const b3 = await showRow({ answer: 'yes', state: 'waiting', left: 9 });
  ok(b3.rows[0].sub === null, '…오류가 사라지면 둘째 줄도 사라진다', b3.rows[0].sub);
  const b7 = await showRow({ answer: 'yes', done: true, left: 0, unfillable: 2 });
  ok(b7.rows[0].text === '회사 · 받을 수 있는 지난 메일을 모두 받았습니다' && b7.rows[0].sub === '메일 번호를 안 주는 폴더 2개는 지난 메일을 받지 못합니다', 'UIDVALIDITY 를 안 주는 폴더 — 다 받았다고만 하지 않는다', b7.rows[0]);
  const od = async (x) => { await show(baseFill([row()], x)); return js("(() => { const e = document.getElementById('fill-onedrive'); return { vis: !e.hidden && e.getBoundingClientRect().height > 0, text: e.textContent }; })()"); };
  const od1 = await od({ oneDrive: true });
  ok(od1.vis && od1.text === '이 폴더는 OneDrive 안에 있어 메일이 클라우드로 올라갑니다.', 'OneDrive 안이면 줄을 늘 보인다 — 묻는 창이 없는 길도 있다', od1);
  const od2 = await od({ oneDrive: false });
  ok(!od2.vis, '…아니면 감춘다', od2);

  // 단추 칠 — 받는 쪽은 채움, 멈추기는 옅게, 정리 허용은 빨간 글자
  const c1 = await showRow({ answer: 'paused', left: 9, canRelease: true });
  ok(same(c1.rows[0].cls, ['mini', 'mini ghost danger']) && same(c1.rows[0].aria, ['회사 이어 받기', '회사 정리 허용']),
    '단추 칠과 이름 — 계정이 여럿이어도 화면 읽기에 어느 계정인지 들린다', c1.rows[0]);
  const c2 = await showRow({ answer: 'yes', state: 'waiting', left: 9 });
  ok(same(c2.rows[0].cls, ['mini ghost']), '멈추기는 옅게 (#btn-backup-stop 과 같다)', c2.rows[0].cls);

  // 계정이 늘고 줄 때 — 순서는 메인이 준 대로, 없어진 계정의 줄은 사라진다
  const A2 = { id: 'a2', name: '개인' };
  const m1 = await show(baseFill([row({ left: 3 }), row({ ...A2, answer: 'no' })]));
  ok(same(m1.rows.map((r) => r.id), ['a1', 'a2']) && m1.rows[1].text.startsWith('개인 · 받지 않음'), '계정마다 한 줄', m1.rows.map((r) => r.text));
  const m2 = await show(baseFill([row({ ...A2, answer: 'no' }), row({ left: 3 })]));
  ok(same(m2.rows.map((r) => r.id), ['a2', 'a1']), '순서는 메인이 준 대로', m2.rows.map((r) => r.id));
  const m3 = await show(baseFill([row({ ...A2, answer: 'no' })]));
  ok(same(m3.rows.map((r) => r.id), ['a2']), '없어진 계정의 줄은 사라진다', m3.rows.map((r) => r.id));

  // 긴 이름·긴 오류 — 단추가 칸 밖으로 밀려나거나 가로 막대가 생기면 안 된다
  await showRow({ name: `very.long.account.name.${'x'.repeat(120)}@corp.invalid`, answer: 'yes', state: 'retry', retryMin: 5,
    error: '오류'.repeat(80), boxErrors: ['폴더'.repeat(80)] });
  const fit = await js(`(() => {
    const pane = document.getElementById('pane-mail');
    const wrap = document.getElementById('fill-wrap').getBoundingClientRect();
    const b = document.querySelector('#fill-rows .fillrow button').getBoundingClientRect();
    return { inside: b.right <= wrap.right && b.width > 0, over: pane.scrollWidth - pane.clientWidth };
  })()`);
  ok(fit.inside && fit.over <= 0, '긴 이름·오류는 줄바꿈되고 단추는 칸 안에 남는다', fit);

  console.log('\n[3] 단추 — mailFillSet 으로 부탁만 한다');
  const yes = (x = {}) => row({ answer: 'yes', state: 'waiting', left: 5, ...x });
  const paused = (x = {}) => row({ answer: 'paused', left: 5, ...x });
  const steps = [
    ['정하기', row({ left: 5 }), { id: 'a1', on: true }, yes(), '지난 메일을 뒤에서 받기 시작합니다.', '잠시 뒤 이어 받습니다'],
    ['멈추기', yes(), { id: 'a1', on: false }, paused(), '지난 메일 받기를 멈췄습니다. 새 메일과 열어 본 메일은 계속 저장합니다.', '멈췄습니다'],
    ['받기', row({ answer: 'no', left: 5 }), { id: 'a1', on: true }, yes(), '지난 메일을 뒤에서 받기 시작합니다.', '잠시 뒤 이어 받습니다'],
    ['이어 받기', paused(), { id: 'a1', on: true }, yes(), '이어 받습니다.', '잠시 뒤 이어 받습니다'],
    ['정리 허용', paused({ canRelease: true }), { id: 'a1', release: true }, row({ answer: 'no', left: 5 }), '이 계정의 서버 정리를 다시 허용했습니다.', '받지 않음']
  ];
  for (const [label, before, want, after, said, line] of steps) {
    await show(baseFill([before]));
    const n = setCalls.length;
    setReply = () => answers([after], said);
    await press(label);
    const u = await until(async () => { const s = await ui(); return s.msg && s.msg.text === said && s.rows[0].text.includes(line) ? s : null; });
    ok(!!u && setCalls.length === n + 1 && same(setCalls[n], want) && same(u.sets[u.sets.length - 1], want),
      `${label} — 부탁은 ${JSON.stringify(want)}`, setCalls.slice(n));
    ok(!!u && u.msg.kind === 'good', `…답을 그린다 — «${line}», 말은 #fill-msg 에`, u && { row: u.rows[0].text, msg: u.msg });
  }
  const held = await repaint();
  ok(!!held.msg, '폴링이 다시 칠해도 답 글을 지우지 않는다', held.msg);

  // 초점 — 멈추기가 이어 받기로 바뀌어도 같은 단추다
  await show(baseFill([yes()]));
  await js(`window.__b = document.querySelector('#fill-rows button'); window.__b.focus();`);
  setReply = () => answers([paused()], '멈췄습니다');
  await press('멈추기');
  const f1 = await until(async () => { const s = await ui(); return s.rows[0].btns[0] === '이어 받기' ? s : null; });
  const focusKept = await js(`document.activeElement === window.__b && window.__b.textContent === '이어 받기'`);
  ok(!!f1 && focusKept, '단추를 다시 만들지 않아 누른 자리에 초점이 남는다', focusKept);

  // 키보드 — Enter (.mini 는 all: unset 이지만 여전히 <button> 이다)
  const nk = setCalls.length;
  setReply = () => answers([yes()], '이어 받습니다.');
  win.webContents.focus();
  for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
  const f2 = await until(async () => { const s = await ui(); return s.rows[0].btns[0] === '멈추기' ? s : null; });
  ok(!!f2 && same(setCalls.slice(nk), [{ id: 'a1', on: true }]), '키보드(Enter)로도 누른다', setCalls.slice(nk));

  // 켜는 쪽의 답을 기다리는 동안 — 다시 부탁하지 않는다. 멈추기는 보낸다
  await show(baseFill([paused(), row({ ...A2, answer: 'yes', state: 'running', phase: 'head', left: 2 })]));
  const nw = setCalls.length;
  setGate = gate();
  stopPass = true;
  setReply = (req) => (req.on === false
    ? answers([paused(), row({ ...A2, answer: 'paused', left: 2 })], '지난 메일 받기를 멈췄습니다.')
    : answers([yes(), row({ ...A2, answer: 'paused', left: 2 })], '이어 받습니다.'));
  await press('이어 받기');
  const w1 = await until(async () => { const s = await ui(); return s.rows[0].off[0] === 'true' ? s : null; }, 2000);
  ok(!!w1 && w1.rows[1].off[0] === 'false', '답을 기다리는 동안 켜는 단추는 막히고 멈추기는 안 막힌다', w1 && w1.rows.map((r) => r.off));
  await press('이어 받기');
  await sleep(100);
  ok(setCalls.length === nw + 1, '…또 눌러도 다시 부탁하지 않는다 — 겹치면 확인 창이 둘 뜬다', setCalls.slice(nw));
  await press('멈추기', 'a2');
  const w2 = await until(async () => { const s = await ui(); return s.rows[1].text.includes('멈췄습니다') ? s : null; });
  ok(!!w2 && same(setCalls.slice(nw), [{ id: 'a1', on: true }, { id: 'a2', on: false }]), '…멈추기는 기다리지 않고 보낸다', setCalls.slice(nw));
  ok(!!w2 && w2.rows[0].off[0] === 'true', '…앞 부탁의 답이 올 때까지 켜는 단추는 막힌 채다', w2 && w2.rows[0].off);
  setGate.open();
  setGate = null;
  stopPass = false;
  const w3 = await until(async () => { const s = await ui(); return s.rows[0].text.includes('이어 받습니다') ? s : null; });
  ok(!!w3 && w3.rows[0].off[0] === 'false', '답이 오면 다시 누를 수 있다', w3 && w3.rows[0]);

  // 메인이 묻는 중(asking) — 다른 계정 줄에서 또 켤 수 없다. 멈추기는 된다
  const a1 = await show(baseFill([paused(), row({ ...A2, answer: 'yes', state: 'waiting', left: 2 })], { asking: true }));
  ok(a1.rows[0].off[0] === 'true' && a1.rows[1].off[0] === 'false', '메인이 확인 창을 띄운 동안 켜는 단추만 막힌다', a1.rows.map((r) => r.off));
  const na = setCalls.length;
  await press('이어 받기');
  await sleep(100);
  ok(setCalls.length === na, '…막힌 단추를 눌러도 부탁하지 않는다', setCalls.slice(na));

  // 응답 없음·거절
  await show(baseFill([row({ left: 5 })]));
  setReply = () => null;
  await press('정하기');
  const e1 = await until(async () => { const s = await ui(); return s.msg && s.msg.kind === 'bad' ? s : null; });
  ok(!!e1 && /응답이 없습니다/.test(e1.msg.text) && e1.rows[0].off[0] === 'false', '응답이 없으면 «응답이 없습니다» — 다시 누를 수 있다', e1 && e1.msg);
  setReply = () => answers([row({ left: 5 })], '지난 메일 받기는 설정 창에서만 켤 수 있습니다.', 'bad');
  await press('정하기');
  const e2 = await until(async () => { const s = await ui(); return s.msg && /설정 창에서만/.test(s.msg.text) ? s : null; });
  ok(!!e2 && e2.msg.kind === 'bad' && e2.rows[0].btns[0] === '정하기', '메인이 거절하면 그 까닭을 빨강으로 — 미리 칠하지 않았다', e2 && e2.msg);
  setReply = () => answers([row({ left: 5 })], '');
  await press('정하기');
  const e3 = await until(async () => { const s = await ui(); return s.msg === null ? s : null; });
  ok(!!e3, '답에 말이 없으면 알림 자리를 비운다', e3 && e3.msg);

  // 폴링 — 도는 동안만 2초. auto:false 인데 폴링하지 않는다는 약속(tidyui)을 지킨다
  await showRow({ answer: 'yes', state: 'running', phase: 'head', left: 5 });
  const p0 = statusCalls;
  ok(await until(() => statusCalls > p0, 15_000), '도는 동안은 2초마다 다시 읽는다', { before: p0, after: statusCalls });
  await showRow({ answer: 'yes', state: 'waiting', left: 5 });
  await sleep(2200);
  const p1 = statusCalls;
  await sleep(2600);
  ok(statusCalls === p1, '돌지 않으면 2초 폴링을 멈춘다 (자동 저장이 꺼진 답이라 더 묻지 않는다)', { before: p1, after: statusCalls });

  console.log('\n[4] #mailAutoBackup');
  const auto = await js(`(() => {
    const sw = document.getElementById('mailAutoBackup');
    const r = sw && sw.closest('.row');
    return { sw: !!sw, hiddenAttr: !!r && r.hidden, display: r ? getComputedStyle(r).display : '', height: r ? r.getBoundingClientRect().height : -1,
      role: sw && sw.getAttribute('role'), opacity: sw ? getComputedStyle(sw).opacity : '' };
  })()`);
  ok(auto.sw && auto.hiddenAttr && auto.display === 'none' && auto.height === 0, '자동 저장 스위치 줄은 숨겨졌다 (.row 의 display 가 hidden 을 이기지 않는다)', auto);
  ok(auto.role === 'switch' && auto.opacity === '1', '…요소는 남아 있다 — settings.js 가 묶고 tidyui·fwdui 가 본다', auto);

  console.log('\n[5] #btn-backup-start');
  const s1 = await show(baseFill([row()]));
  ok(!s1.start, 'st.fill 이 있으면 «백업 시작»을 숨긴다', s1.start);
  const s2 = await show(baseFill([row()], { on: false }));
  ok(!s2.start, '…on:false 여도 숨긴다 (묻지도 쉬지도 않는 길을 다시 내지 않는다)', s2.start);
  const s3 = await show(null);
  ok(s3.start, 'st.fill 이 없으면 보인다', s3.start);
  const s4 = await show(null, { running: true });
  ok(!s4.start, '…돌고 있으면 지금처럼 숨긴다', s4.start);
  await show(null);
  await sleep(1000);   // 도는 중이던 800ms 폴링이 가라앉기를 기다린다

  console.log('\n[5b] 메일 백업을 옮기는 중 (st.move)');
  {
    const look = () => js(`(() => {
      const $ = (id) => document.getElementById(id);
      return { state: $('backup-state').textContent, pick: $('btn-backup-pick').disabled, open: $('btn-backup-open').disabled,
        start: $('btn-backup-start').disabled, bar: $('backup-bar').style.width };
    })()`);
    await show(null, { move: { running: true, phase: 'copy', done: 3, total: 10, bytes: 100, totalBytes: 1000 } });
    const m1 = await look();
    ok(m1.state === '메일 백업을 옮기는 중 — 3/10개' && m1.pick && m1.open && m1.start && m1.bar === '30%', '옮기는 동안 — 진행 줄과 막대, 폴더·백업 단추를 막는다', m1);
    await show(null, { move: { running: true, phase: 'wait', done: 0, total: 10, bytes: 0, totalBytes: 1000 } });
    const m2 = await look();
    ok(m2.state === '메일 백업을 옮기는 중 — 다른 작업이 끝나기를 기다립니다' && m2.pick, '…다른 작업을 기다리는 동안', m2.state);
    await show(null, { move: { running: true, phase: 'trash', done: 10, total: 10, bytes: 1000, totalBytes: 1000 } });
    const m2b = await look();
    ok(m2b.state === '메일 백업을 옮기는 중 — 이전 폴더의 백업을 휴지통으로 보내는 중' && m2b.pick, '…휴지통으로 보내는 동안', m2b.state);
    await show(null, { move: { running: false, phase: '', done: 0, total: 0, bytes: 0, totalBytes: 0 }, message: '메일 백업을 옮겼습니다' });
    const m3 = await look();
    ok(m3.state === '메일 백업을 옮겼습니다' && !m3.pick && !m3.open && !m3.start, '끝나면 단추를 푼다', m3);
    const m4 = await show(null);
    ok(m4.backupDir === BACKUP_DIR, 'st.move 가 없는 옛 메인도 그대로 그린다', m4.backupDir);
    await sleep(1000);   // 옮기는 동안의 800ms 폴링이 가라앉기를 기다린다
  }

  console.log('\n[6] 다크·라이트');
  await show(baseFill([paused({ canRelease: true, boxErrors: ['스팸함: 거절'] })]));
  const look = () => js(`(() => {
    const c = (el) => getComputedStyle(el);
    const r = document.querySelector('#fill-rows .fillrow');
    const [go, rel] = r.querySelectorAll('button');
    const opOf = (b) => { b.setAttribute('aria-disabled', 'true'); const o = c(b).opacity; b.setAttribute('aria-disabled', 'false'); return o; };
    return { theme: document.documentElement.getAttribute('data-theme'),
      line: c(r.querySelector('.fillline')).color, sub: c(r.querySelector('.fillsub')).color, hint: c(document.getElementById('backup-auto')).color,
      lbl: c(document.querySelector('#fill-wrap .lbl')).color, otherLbl: c(document.querySelector('#tidy-wrap > .lbl')).color,
      go: c(go).backgroundColor, goInk: c(go).color, pick: c(document.getElementById('btn-backup-pick')).backgroundColor, pickInk: c(document.getElementById('btn-backup-pick')).color,
      rel: c(rel).color, reset: c(document.getElementById('btn-reset-all')).color, opOn: c(go).opacity, opOff: opOf(rel) };
  })()`);
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  const t1 = await look();
  await js("document.documentElement.setAttribute('data-theme', 'light')");
  const t2 = await look();
  for (const t of [t1, t2]) {
    ok(t.line === t.hint && t.sub === t.hint, `${t.theme} — 줄과 둘째 줄이 안내 줄과 같은 색`, t);
    ok(t.lbl === t.otherLbl, `${t.theme} — «지난 메일» 이름은 다른 이름 칸과 같은 색`, t.lbl);
    ok(t.go === t.pick && t.goInk === t.pickInk && t.rel === t.reset, `${t.theme} — 단추는 «폴더 고르기»·«전체 삭제»와 같은 칠`, { go: t.go, rel: t.rel });
    ok(t.opOn === '1' && t.opOff === '0.45', `${t.theme} — 막힌 단추만 0.45`, [t.opOn, t.opOff]);
  }
  ok(t1.line !== t2.line, '다크와 라이트의 줄 색이 다르다 (테마 이름을 따른다)', [t1.line, t2.line]);
  // 누를 수 없는 단추 — 마우스를 올려도 눌릴 것처럼 반응하지 않는다 (확인 창을 기다리는 동안 마우스는 대개 그 단추 위에 있다)
  const hovered = async () => {
    const at = await js(`(() => {
      const b = document.querySelectorAll('#fill-rows button')[1];
      b.scrollIntoView({ block: 'center' });
      b.setAttribute('aria-disabled', 'true');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    const read = () => js(`(() => {
      const b = document.querySelectorAll('#fill-rows button')[1];
      const cs = getComputedStyle(b);
      return { theme: document.documentElement.getAttribute('data-theme'), hover: b.matches(':hover'), filter: cs.filter, bg: cs.backgroundColor };
    })()`);
    await until(async () => (await read()).hover, 5000);
    const out = await read();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await js(`document.querySelectorAll('#fill-rows button')[1].setAttribute('aria-disabled', 'false')`);
    await sleep(60);
    return out;
  };
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    const h = await hovered();
    ok(h.hover && h.filter === 'none' && h.bg === 'rgba(0, 0, 0, 0)', `${theme} — 막힌 단추는 마우스를 올려도 밝기·바탕이 그대로다`, h);
  }
  await js("document.documentElement.setAttribute('data-theme', 'dark')");

  console.log('\n[7] 문구');
  const text = () => js(`(() => {
    const pane = document.getElementById('pane-mail');
    return { secs: [...pane.querySelectorAll('.sec')].map((e) => e.textContent), foot: pane.querySelector('.foot').innerText,
      notes: [...pane.querySelectorAll('#tidy-wrap .hint')].filter((e) => !e.id).map((e) => e.textContent), all: pane.innerText };
  })()`);
  const w0 = await show(baseFill([row()]));
  ok(w0.autoLine === '메일 확인을 켜면 새 메일과 열어 본 메일을 저장하고, 지난 메일도 받을 수 있습니다.', 'auto:false 안내 줄 — 지난 메일 칸이 왜 없는지도 말한다', w0.autoLine);
  const w4 = await show(baseFill([row()]), { auto: true });
  ok(w4.autoLine === '새 메일과 열어 본 메일을 저장합니다.', 'auto:true, 아직 저장 전 안내 줄', w4.autoLine);
  // 창을 열 때 받은 값이 아니라 메인의 값을 본다 — 스위치를 켜거나 꺼도 창을 다시 열기 전까지 거꾸로 말하면 안 된다
  const w6 = await show(baseFill([row()]), { auto: true, mailEnabled: false, autoAt: Date.now() - 60_000, autoSaved: 1 });
  ok(w6.autoLine === '«메일 확인하기»가 꺼져 있어 자동 저장하지 못합니다. 켜면 지난 메일도 받을 수 있습니다.', '메인이 꺼졌다고 하면 꺼졌다고 말한다 — 창을 열 때는 켜져 있었어도', w6.autoLine);
  await js('window.nunsSet.data.settings.mailEnabled = false');
  const w7 = await show(baseFill([row()]), { auto: true, mailEnabled: true });
  ok(w7.autoLine === '새 메일과 열어 본 메일을 저장합니다.', '메인이 켜졌다고 하면 «꺼져 있어»라고 하지 않는다 — 창을 열 때는 꺼져 있었어도', w7.autoLine);
  await js('window.nunsSet.data.settings.mailEnabled = true');
  await show(baseFill([row()]));
  const srcHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'settings.html'), 'utf8');
  ok(srcHtml.includes('<span class="hint" id="backup-auto">새 메일과 열어 본 메일은 이 폴더에 저장합니다.</span>'), '마크업의 첫 안내 줄');
  const w5 = await text();
  ok(w5.secs.includes('PC에 받아 둔 메일') && !w5.secs.includes('메일 백업'), '칸 이름은 «PC에 받아 둔 메일»', w5.secs);
  ok(w5.foot.includes('새 메일과 열어 본 메일의 원문을 이 PC에 저장합니다. 회사 메일은 사내 정책을 확인하세요.')
    && w5.foot.includes('지난 메일은 고른 뒤에만 받고, 멈춰도 다음에 이어서 받습니다. 스팸·휴지통·공유 폴더는 받지 않습니다.'), '아래 안내', w5.foot);
  ok(w5.notes.includes('지난 메일을 받는 동안 그 계정은 정리를 쉽니다. 다 받으면 받은 메일도 대상이 됩니다. 메일 확인을 끄거나, 폴더를 바꾸면서 기존 백업을 옮기지 않으면 모든 계정이 함께 꺼집니다.'), '서버 정리 안내 — 기존 백업을 옮기면 정리는 켜진 채다', w5.notes);
  ok(!/백업 시작/.test(w5.all), 'st.fill 이 있으면 보이는 곳 어디에도 «백업 시작»이 없다', w5.all.match(/.{0,20}백업 시작.{0,20}/));
  const startBtn = await js(`document.getElementById('btn-backup-start').textContent`);
  ok(startBtn === '백업 시작', '…숨겼을 뿐 단추와 글자는 그대로다 (tidyui 가 누른다)', startBtn);
  // 서버 정리는 계정마다 한 줄 — 그 계정의 상태 줄 (settings-mail.js tidyLine)
  const tidyRow = (o) => ({ id: 'a1', name: '회사', gmail: false, on: true, days: 30, running: false, held: false, blocked: null, copyPath: false,
    at: Date.now() - 60_000, ranDays: 30, moved: 0, kept: 1, unsaved: 1, unverified: 0, spared: 0, important: 0, flagged: 0, unread: 0,
    uncertain: 0, skippedBoxes: 0, more: false, error: null, oldest: Date.now() - 90 * 86_400_000, total: 0, ...o });
  const tidyTop = (row) => ({ ready: true, why: '', running: false, asking: false, askingId: null, current: null, everyMin: 10, cap: 300, total: 0,
    message: '', messageKind: '', accounts: [row] });
  const stateOf = () => js(`(document.querySelector('#tidy-rows .tidyrow[data-id="a1"] .tidystate') || {}).textContent || null`);
  fakeExtra = { tidy: tidyTop(tidyRow({})) };
  await repaint();
  const tidyLine = await stateOf();
  ok(tidyLine === '1분 전 · 30일 지난 메일 1통이 PC에 없음 — «지난 메일 받기» 필요', '서버 정리 상태 줄도 «지난 메일 받기» — PC에 없는 것이 까닭이면 앞에 둔다', tidyLine);
  fakeExtra = { tidy: tidyTop(tidyRow({ moved: 2 })) };
  await repaint();
  const tidyLine2 = await stateOf();
  ok(tidyLine2 === '1분 전 · 2통 휴지통으로 · 저장 안 된 1통 남김(«지난 메일 받기» 필요)', '…옮긴 것이 있으면 꼬리 조각으로', tidyLine2);
  fakeExtra = { tidy: tidyTop(tidyRow({ at: 0, held: true })) };
  await repaint();
  const heldLine = await stateOf();
  ok(heldLine === '쉬는 중 — 지난 메일을 받는 동안 이 계정은 정리를 쉽니다', '그 계정이 받는 중이면 «다음 자동 백업 뒤 정리»라고 하지 않는다', heldLine);
  await show(null);

  // ── [10] 다시 읽기 ────────────────────────
  // auto:false 면 폴링이 없다 — 계정을 더한 창이 안 다시 읽으면 메인이 폴더를 잡고 자동 저장을 켜도 «아직 정하지 않았습니다»에 멈춘다
  console.log('\n[10] 계정을 더하거나 켜거나, 탭이 열리면 다시 읽는다');
  await show(baseFill([row()]));
  await js(`(() => {
    const $ = (id) => document.getElementById(id);
    $('mail-host').value = 'imap.invalid';
    $('mail-user').value = 'new@corp.invalid';
    $('mail-pass').value = 'test-only';
  })()`);
  let c10 = statusCalls;
  await js("document.getElementById('btn-mail-add').click()");
  ok(await until(() => statusCalls > c10, 5000), '계정을 더하면 상태를 다시 읽는다', statusCalls - c10);
  c10 = statusCalls;
  await until(() => js("!!document.querySelector('#mail-accounts .rem.acct .sw')"), 5000);
  await js("document.querySelector('#mail-accounts .rem.acct .sw').click()");
  ok(await until(() => statusCalls > c10, 5000), '계정을 켜거나 끄면 다시 읽는다', statusCalls - c10);
  c10 = statusCalls;
  await js("window.__settingsTab && window.__settingsTab('mail')");
  ok(await until(() => statusCalls > c10, 5000), '알림·위젯 줄로 메일 탭이 열리면 다시 읽는다', statusCalls - c10);
  c10 = statusCalls;
  await js("window.__settingsTab && window.__settingsTab('general')");
  await sleep(150);
  ok(statusCalls === c10, '…다른 탭이면 안 읽는다', statusCalls - c10);
  await js("window.__settingsTab && window.__settingsTab('mail')");
  await sleep(50);
  c10 = statusCalls;
  await js("document.getElementById('mailEnabled').click()");
  await sleep(50);
  await js("document.getElementById('mailEnabled').click()");
  ok(await until(() => statusCalls >= c10 + 3, 5000), '메일 확인을 켜면 확인이 끝난 뒤에도 다시 읽는다 — 그때 자동 저장과 폴더가 맞춰진다', statusCalls - c10);
  // 그 처리기 안에서만 찾는다 (결과를 적는 setNote 앞까지). 그냥 다음 loadBackup 을 찾으면 다른 처리기의 줄이 대신 맞아 이 줄을 지워도 통과한다
  ok(/mailRepass\(\{ id: a\.id, pass \}\)[\s\S]*?if \(r && r\.ok\) \{(?:(?!setNote)[\s\S])*?loadBackup\(\)\.catch/.test(fs.readFileSync(path.join(ROOT, 'renderer', 'settings-mail.js'), 'utf8')), '비밀번호를 고쳐도 다시 읽는다 (소스에서 본다)');
  await show(null);

  // ── [8] 진짜 src/backup.js ────────────────────────
  console.log('\n[8] 진짜 메인 처리기 (src/backup.js)');
  ipcMain.removeHandler('mail:backup-status');
  ipcMain.removeHandler('mail:fill-set');
  const backup = require(path.join(ROOT, 'src', 'backup.js'));
  store.setGatedSettings({ mailBackupDir: BACKUP_DIR });
  store.setSettings({ mailEnabled: true, mailAutoBackup: true });
  store.mailAccounts.push({ id: 'a1', name: '시험 계정', provider: 'custom', host: 'imap.invalid', port: 993, user: 'me@corp.invalid', enabled: true });
  // 둘째 계정 — 아래 «부탁은 모두 그 계정 id 로 갔다»가 실패할 수 있게
  store.mailAccounts.push({ id: 'a2', name: '둘째 계정', provider: 'custom', host: 'imap2.invalid', port: 993, user: 'me2@corp.invalid', enabled: true });
  let allow = true;
  let answer = 1;
  const asks = [];
  popup.askUser = async (_parent, opts) => { asks.push(opts); return answer; };
  backup.init({
    mailAccountsForUse: () => store.mailAccounts,
    isSettingsWin: (wc) => allow && wc === win.webContents,
    refreshMail: () => {}
  });
  await js('window.__fillSet = [];');
  const realMsg = async (re) => until(async () => { const u = await ui(); return u.msg && re.test(u.msg.text) ? u : null; }, 10_000);

  const stR = await js('window.nunsseom.mailBackupStatus()');
  const missing = ROW_KEYS.filter((k) => !(stR && stR.fill && stR.fill.accounts[0] && k in stR.fill.accounts[0]));
  ok(!missing.length && ['on', 'oneDrive', 'message', 'messageKind', 'asking'].every((k) => k in stR.fill) && stR.mailEnabled === true, '메인 상태에 화면이 읽는 키가 다 있다 (st.fill, st.mailEnabled)', missing);
  const r0 = await repaint();
  ok(r0.wrap && r0.rows[0].text === '시험 계정 · 첫 메일 확인이 끝나면 물어봅니다' && !r0.rows[0].btns.length && !r0.start, '첫 메일 확인 전 — 묻지 않고, «백업 시작»도 없다', r0.rows[0]);
  backup.fillState.listed.set('a1', { clean: true, boxErrors: [] });
  backup.fillState.counts.set('a1', { left: 3, leftBytes: null, boxes: 1 });
  const r1 = await repaint();
  ok(r1.rows[0].text === '시험 계정 · 지난 메일 최대 3통 · 아직 정하지 않았습니다' && same(r1.rows[0].btns, ['정하기']), '답 없음 — 정하기', r1.rows[0]);

  answer = 1;
  await press('정하기');
  const r2 = await realMsg(/^받지 않습니다/);
  ok(!!r2 && store.settings.mailFill.a1 === 'no' && asks.length === 1 && r2.rows[0].text.includes('받지 않음') && same(r2.rows[0].btns, ['받기']),
    '정하기 → 확인 창 → «받지 않기» — no, 받기 단추', { ans: store.settings.mailFill.a1, asks: asks.length });
  ok(asks[0].title === '지난 메일도 PC로 받을까요?' && asks[0].focusId === 1, '…확인 창은 메인이 띄우고 초점은 «받지 않기»', asks[0].title);

  answer = 0;
  await press('받기');
  const r3 = await realMsg(/^지난 메일을 뒤에서 받기 시작합니다/);
  ok(!!r3 && store.settings.mailFill.a1 === 'yes' && asks.length === 2 && r3.rows[0].text === '시험 계정 · 잠시 뒤 이어 받습니다 · 남은 약 3통' && same(r3.rows[0].btns, ['멈추기']),
    '받기 → 확인 창 → «받기» — yes, 멈추기 단추', { ans: store.settings.mailFill.a1, row: r3 && r3.rows[0] });

  await press('멈추기');
  const r4 = await realMsg(/^지난 메일 받기를 멈췄습니다/);
  ok(!!r4 && store.settings.mailFill.a1 === 'paused' && asks.length === 2 && r4.rows[0].text === '시험 계정 · 멈췄습니다 · 남은 약 3통' && same(r4.rows[0].btns, ['이어 받기']),
    '멈추기 — 묻지 않고 paused. 정리가 꺼져 있으면 정리 허용 없음', { ans: store.settings.mailFill.a1, row: r4 && r4.rows[0] });

  await press('이어 받기');
  const r5 = await realMsg(/^이어 받습니다/);
  ok(!!r5 && store.settings.mailFill.a1 === 'yes' && asks.length === 2, '이어 받기 — 이미 동의했으므로 다시 묻지 않는다', { ans: store.settings.mailFill.a1, asks: asks.length });

  // 정리가 켜진 채 멈추면 정리 허용 — 그만두면 그대로, 고르면 no
  store.setTidyAccount('a1', { on: true });
  await press('멈추기');
  const r6 = await realMsg(/서버 정리는 이 계정을 계속 쉽니다/);
  ok(!!r6 && r6.rows[0].text === '시험 계정 · 멈췄습니다 · 남은 약 3통 · 서버 정리 쉬는 중' && same(r6.rows[0].btns, ['이어 받기', '정리 허용']),
    '정리가 켜져 있으면 멈춘 동안도 쉰다 — 정리 허용 단추', r6 && r6.rows[0]);
  answer = 1;
  await press('정리 허용');
  const r7 = await realMsg(/^그만뒀습니다/);
  ok(!!r7 && store.settings.mailFill.a1 === 'paused' && asks.length === 3 && asks[2].title === '이 계정의 서버 정리를 다시 허용할까요?' && asks[2].danger === true && asks[2].focusId === 1,
    '정리 허용 → 확인 창에서 그만두면 그대로', { ans: store.settings.mailFill.a1, title: asks[2] && asks[2].title });
  answer = 0;
  await press('정리 허용');
  const r8 = await realMsg(/^이 계정의 서버 정리를 다시 허용했습니다/);
  ok(!!r8 && store.settings.mailFill.a1 === 'no' && r8.rows[0].text === '시험 계정 · 받지 않음 — 새 메일과 열어 본 메일만 저장합니다 · 남은 약 3통',
    '…고르면 no — 정리 쉬는 줄도 사라진다', r8 && r8.rows[0]);
  store.setTidyAccount('a1', { on: false });

  allow = false;
  answer = 0;
  await press('받기');
  const r9 = await realMsg(/설정 창에서만/);
  ok(!!r9 && r9.msg.kind === 'bad' && store.settings.mailFill.a1 === 'no' && asks.length === 4, '설정 창이 아닌 곳에서 온 켜기는 거절 — 확인 창도 안 띄운다', { msg: r9 && r9.msg, asks: asks.length });
  allow = true;
  ok(same((await ui()).sets.filter((x) => x.id !== 'a1'), []), '부탁은 모두 그 계정 id 로 갔다');

  // ── [9] 위젯 줄과 preload — 파일에서 본다 ────────────
  console.log('\n[9] 위젯 줄·preload');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  ok(/mailFillSet: \(req\) => ipcRenderer\.invoke\('mail:fill-set', req\)/.test(read('src/preload.js')), 'preload 에 mailFillSet 이 있다 — 시험용 다리와 같은 통로');
  const wm = read('renderer/widget-mail.js');
  const wh = read('renderer/widget.html');
  const note = (wm.match(/function paintNote\(box\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(note.includes("const ask = !nt && box && box.fillAsk ? box.fillAsk : '';"), 'paintNote — 결과 한 줄이 있으면 묻지 않는다. 메일 상자가 없어도 오류가 없다', note.length);
  ok(note.includes('el.textContent = nt ? nt.text : ask;') && note.includes('el.title = nt ? nt.text : ask;'), '…글과 제목은 둘 중 하나');
  ok(note.includes("el.className = 'note' + (nt ? ' ' + nt.kind : ask ? ' ask' : '');"), '…묻는 줄만 .ask');
  ok(/el\.onclick = ask \? [^\n]*openSettings\('mail'\)[^\n]* : null;/.test(note), '…묻는 줄만 눌리고, 누르면 설정 › 메일이 열린다');
  ok(/\$\('mail-note'\)\.addEventListener\('pointerdown'/.test(wm), '시트 안의 묻는 줄은 pointerdown 을 막는다 — 시트가 먼저 닫히면 클릭이 사라진다');
  ok(/\.note\.ask \{ color: var\(--tint\); cursor: pointer; \}/.test(wh) && /:root\[data-theme="light"\] \.note\.ask \{ color: var\(--tint-ink\); \}/.test(wh), '.note.ask — 다크·라이트 색이 .note.good 과 같다');

  // ── 마무리 ───────────────────────────────────────
  const sentAll = await js('window.__setApp || []');
  ok(!sentAll.some((p) => p && GATED.some((k) => k in p)), '화면 전체에서 setApp 에 지난 메일·서버 정리 키가 없다', sentAll);
  ok(!strays.length, '시험 창 말고 다른 창(확인 창 등)이 하나도 안 생겼다', strays);
  ok(errs.length === 0, '콘솔 오류(level 3 이상)가 없다', errs.slice(0, 5));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

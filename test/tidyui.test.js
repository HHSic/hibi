// 설정 › 메일 백업 › «서버 정리» — 스위치·기간 단추·설명·상태 줄이 메인의 답대로 그려지고, 누르면 메인에 부탁만 하는가.
//
// 서버 정리는 PC에 저장이 확인된 오래된 메일을 서버 휴지통으로 옮긴다. 켜기와 기간 줄이기는 메인이 세어 보고
// 확인 창으로 묻는다 — 화면은 미리 칠하지 않고 mailTidySet 으로 부탁만 한다. 일반 setApp 으로 새면 확인을 건너뛴다.
//
// 진짜 settings.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/settings-mail-bridge-stub.js 를 쓴다.
// 메일 서버·자격 증명 관리자에는 가지 않는다 (mailhub.js 를 싣지 않고, 계정은 늘 비어 있다).
//
// [가] 시험이 정한 답 (메인 처리기 자리에 시험용 처리기) — 화면이 상태 모양마다 맞게 그리는가
//   · 메인이 답하기 전에는 감춰 두고, st.tidy 가 없는 답(옛 메인)이면 계속 감춘다
//   · 스위치는 role=switch·aria-checked·aria-describedby, 기간은 role=group(«옮기는 때») 안의 바로·7·30·90일, 기본 30일(aria-pressed)
//   · «바로»(0)를 고르면 뒤 줄·설명이 «읽은 메일은 새 메일 확인 때마다»로 바뀌고(주기는 메인이 준 everyMin 으로),
//     상태 줄은 «안 읽은 n통은 읽을 때까지 남김»을 말한다 — 지금 설정이 «바로»일 때만. 일부러 남긴 것(spared)도 사실로 적는다.
//     «바로»로·«바로»에서 바꾸기는 묻는 일이라 «확인하는 중…»을 보인다. 휴지통 자동 비우기 안내는 늘 보인다
//   · 자동 백업이 꺼졌거나 폴더가 없으면 스위치가 aria-disabled 이고 상태 줄에 까닭이 보이며, 눌러도 부탁하지 않는다
//   · 기간 줄이기의 답을 기다리는 동안(메인이 세는 최대 20초)에도 켜진 스위치로 끌 수 있다
//   · 막힌 기간 단추는 마우스를 올려도 눌릴 것처럼 반응하지 않는다
//   · 누르면 mailTidySet({on}) / ({days}) — 켜기·기간 줄이기는 답을 기다리는 동안 «확인하는 중…»을 보이고,
//     기다리는 동안 또 눌러도 다시 부탁하지 않는다. 그만두면 꺼진 채, 받아들이면 켜진다. 같은 기간은 부탁하지 않는다
//   · 상태 줄 글 모양 (도는 중 · 아직 안 돔 · 결과 · 쉬는 중), 응답이 없으면 «응답이 없습니다»
//   · «백업 시작»이 기다리는 중이면 그 한 줄을 보인다. 답이 null 이어도 오류가 없다
//   · «메일 확인하기»를 누르면 상태를 다시 읽는다. setApp 에 서버 정리 키가 한 번도 없다
//   · 다크·라이트 모두 상태 줄이 위 안내 줄과 같은 색이고, 누를 수 없는 스위치·단추는 opacity 0.45
// [나] 진짜 src/backup.js 처리기 (확인 창 popup.askUser 만 바꿔 끼운다) — 화면과 메인이 같은 약속을 지키는가
//   · 그만두기 → 꺼진 채 «그만뒀습니다» / 켜기 → 켜짐 / 90일은 묻지 않음 / 7일은 묻고 그만두면 90일 그대로
//   · 끄기는 묻지 않음 / 설정 창이 아닌 곳에서 켜기 → «설정 창에서만» / 자동 백업을 끄면 서버 정리도 꺼지고 막힌다
//   · «바로»는 묻고 그만두면 그대로, 고르면 0 이 메인 설정까지 그대로 간다 (30으로 바뀌지 않는다). «바로»에서 기간으로도 묻는다
//   · 확인 창은 위험 단추를 빨갛게(danger) 두되 초점은 «그만두기»(focusId 1)에
// [다] 진짜 renderer/popup.html 을 화면 밖 창에 — 초점이 실제로 «그만두기»에 가고 Enter 가 그만두기로 답하는가.
//   focusId 가 없는 다른 물음은 예전처럼 기본 단추에 초점 (test/fixtures/popup-bridge-stub.js)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidyui-'));
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

// 서버 정리 키 — 화면이 setApp 으로 보내면 안 된다 (메인 store 가 버리지만, 보내는 것 자체가 길을 잘못 든 것이다)
const GATED = ['mailServerTidy', 'mailTidyDays', 'mailBackupDir', 'mailTidyLast'];
// 화면이 읽는 st.tidy 키 — 고정 계약 (설계 §1.2)
const TIDY_KEYS = ['on', 'days', 'ready', 'why', 'running', 'asking', 'at', 'moved', 'kept', 'unsaved', 'unverified',
  'spared', 'unread', 'skippedBoxes', 'more', 'error', 'total', 'cap', 'everyMin', 'message', 'messageKind'];

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  // 서버에는 절대 붙지 않는다 — 계정이 늘 비어 있지만 한 겹 더 막는다
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

  // ── [가] 시험용 메인 처리기 ───────────────────────
  // auto:false 로 둬 20초 폴링이 끼어들지 않게 한다 (화면이 다시 읽는 때를 시험이 센다)
  const baseStatus = () => ({ running: false, stop: false, account: '', mailbox: '', done: 0, total: 0, saved: 0, skipped: 0,
    message: '', at: 0, dir: BACKUP_DIR, auto: false, autoAt: 0, autoSaved: 0, autoTotal: 0, autoSeeded: 0, autoError: null, waiting: '' });
  const baseTidy = () => ({ on: false, days: 30, ready: true, why: '', running: false, asking: false, at: 0, moved: 0, kept: 0,
    unsaved: 0, unverified: 0, spared: 0, unread: 0, skippedBoxes: 0, more: false, error: null, total: 0, cap: 300, message: '', messageKind: '' });
  let fakeTidy = baseTidy();
  let fakeExtra = {};
  let noTidy = false;
  let statusCalls = 0;
  let statusGate = null;
  const fakeStatus = () => ({ ...baseStatus(), ...fakeExtra, ...(noTidy ? {} : { tidy: { ...fakeTidy } }) });
  ipcMain.handle('mail:backup-status', async () => {
    statusCalls++;
    if (statusGate) await statusGate.promise;
    return fakeStatus();
  });
  const setCalls = [];
  let setGate = null;
  let offPass = false;   // 참이면 끄기 부탁은 문에 걸리지 않고 바로 답한다 (다른 부탁을 붙잡아 둔 채 끄기)
  let setReply = () => fakeStatus();
  ipcMain.handle('mail:tidy-set', async (_e, req) => {
    setCalls.push(req);
    if (setGate && !(offPass && req && req.on === false)) await setGate.promise;
    return setReply(req);
  });

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
    const vis = (el) => !el.hidden && el.getBoundingClientRect().height > 0;
    const sw = $('mailServerTidy');
    const msg = $('tidy-msg');
    return {
      row: vis($('tidy-row')), wrap: vis($('tidy-wrap')),
      role: sw.getAttribute('role'), checked: sw.getAttribute('aria-checked'), on: sw.classList.contains('on'),
      disabled: sw.getAttribute('aria-disabled'), busy: sw.getAttribute('aria-busy'),
      describedby: sw.getAttribute('aria-describedby'),
      group: $('tidy-days').getAttribute('role'), groupBy: $('tidy-days').getAttribute('aria-labelledby'),
      groupDesc: $('tidy-days').getAttribute('aria-describedby'), lbl: $('tidy-days-lbl').textContent, tail: $('tidy-days-tail').textContent,
      notes: [...document.querySelectorAll('#tidy-wrap .hint')].filter((e) => !e.id && vis(e)).map((e) => e.textContent),
      days: [...document.querySelectorAll('#tidy-days button')].map((b) => ({ d: b.dataset.days, t: b.textContent,
        pressed: b.getAttribute('aria-pressed'), ghost: b.classList.contains('ghost'), disabled: b.getAttribute('aria-disabled') })),
      hint: $('tidy-hint').textContent,
      state: vis($('tidy-state')) ? $('tidy-state').textContent : null,
      msg: msg.classList.contains('show')
        ? { text: msg.textContent, kind: ['good', 'bad', 'wait'].find((k) => msg.classList.contains(k)) || '' } : null,
      msgRole: msg.getAttribute('role'),
      backupState: $('backup-state').textContent,
      backupDir: $('backup-dir').textContent,
      sets: (window.__tidySet || []).slice()
    };
  })()`);
  const pressed = (u) => u.days.filter((d) => d.pressed === 'true').map((d) => d.d);
  const clickSwitch = () => js("document.getElementById('mailServerTidy').click()");
  const clickDays = (d) => js(`document.querySelector('#tidy-days [data-days="${d}"]').click()`);
  const repaint = async () => { await js('window.nunsSetMail.loadBackup()'); await sleep(50); return ui(); };
  const show = async (t, extra = {}) => { fakeTidy = { ...baseTidy(), ...t }; fakeExtra = extra; return repaint(); };

  console.log('\n[가] 처음 그리기');
  statusGate = gate();
  await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'mail' } });
  await until(() => statusCalls >= 1);
  const u0 = await ui();
  ok(!u0.row && !u0.wrap, '메인이 답하기 전에는 서버 정리 줄이 감춰져 있다', u0);
  // 옛 메인 — st.tidy 가 없다
  noTidy = true;
  const g0 = statusGate;
  statusGate = null;
  g0.open();
  const u1 = await until(async () => { const u = await ui(); return u.backupDir === BACKUP_DIR ? u : null; });
  ok(!!u1 && !u1.row && !u1.wrap, 'st.tidy 가 없는 답이면 그린 뒤에도 감춘 채다', u1);
  noTidy = false;
  const u2 = await show({});
  ok(u2.row && u2.wrap, 'st.tidy 가 오면 스위치 줄과 설명 칸이 보인다', u2);
  ok(u2.role === 'switch' && u2.checked === 'false' && !u2.on && u2.disabled === 'false'
    && u2.describedby === 'tidy-hint tidy-state', '스위치 — role=switch · aria-checked=false · 설명·상태 줄과 이어짐', u2);
  ok(JSON.stringify(u2.days.map((d) => d.t)) === '["바로","7일","30일","90일"]' && JSON.stringify(u2.days.map((d) => d.d)) === '["0","7","30","90"]'
    && u2.group === 'group' && u2.groupBy === 'tidy-days-lbl' && u2.lbl === '옮기는 때' && u2.groupDesc === 'tidy-days-tail',
  '기간 — role=group «옮기는 때» 안에 바로·7일·30일·90일, 뒤 줄로 설명', u2.days);
  ok(u2.tail === '받은 지 30일 지난 메일만', '…뒤 줄 «받은 지 30일 지난 메일만»', u2.tail);
  ok(u2.notes.some((t) => /휴지통도 서버 용량에 들어가는/.test(t) && /휴지통 자동 비우기/.test(t)), '휴지통도 용량에 든다 — 웹메일에서 자동 비우기를 켜라는 안내가 보인다', u2.notes);
  ok(JSON.stringify(pressed(u2)) === '["30"]' && u2.days.every((d) => d.ghost === (d.d !== '30')),
    '기본은 30일 — aria-pressed 와 칠이 같다', u2.days);
  ok(/받은 지 30일 지난/.test(u2.hint) && /휴지통/.test(u2.hint) && /별표/.test(u2.hint) && /모든 메일 계정/.test(u2.hint),
    '설명에 기간·휴지통·별표·모든 계정이 들어 있다', u2.hint);
  ok(u2.state === null && u2.msg === null && u2.msgRole === 'status', '꺼져 있고 쓸 수 있으면 상태 줄은 감춘다. 알림 자리는 role=status', u2);

  console.log('\n[가] 쓸 수 없을 때');
  const u3 = await show({ ready: false, why: '«자동으로 백업»을 켜야 쓸 수 있습니다.' });
  ok(u3.disabled === 'true' && u3.checked === 'false' && u3.state === '«자동으로 백업»을 켜야 쓸 수 있습니다.',
    '자동 백업이 꺼져 있으면 스위치가 막히고 까닭이 보인다', u3);
  await clickSwitch();
  await sleep(150);
  ok(setCalls.length === 0 && (await ui()).sets.length === 0, '막힌 스위치를 눌러도 부탁하지 않는다', setCalls);
  ok(u3.days.every((d) => d.disabled === 'false'), '기간은 꺼진 채로도 고를 수 있다 (켤 때 쓸 값)', u3.days);
  const u4 = await show({ ready: false, why: '저장할 폴더를 먼저 골라야 쓸 수 있습니다.' });
  ok(u4.disabled === 'true' && u4.state === '저장할 폴더를 먼저 골라야 쓸 수 있습니다.', '폴더가 없으면 막히고 까닭이 보인다', u4);
  const u5 = await show({ on: true, ready: false, why: '위쪽 «메일 확인하기»가 꺼져 있어 쓸 수 없습니다.' });
  ok(u5.disabled === 'false' && u5.checked === 'true' && u5.state === '쉬는 중 — 위쪽 «메일 확인하기»가 꺼져 있어 쓸 수 없습니다.',
    '켜진 채 조건이 모자라면 «쉬는 중» — 그래도 끌 수는 있다', u5);
  const u6 = await show({ asking: true });
  ok(u6.disabled === 'true' && u6.busy === 'true' && u6.days.every((d) => d.disabled === 'true'),
    '메인이 묻는 중이면 꺼진 스위치와 기간 단추를 막는다', u6);
  const u7 = await show({ on: true, asking: true });
  ok(u7.disabled === 'false' && u7.busy === 'true', '묻는 중이어도 켜진 스위치는 끌 수 있다', u7);

  console.log('\n[가] 상태 줄');
  const u8 = await show({ on: true, running: true });
  ok(u8.state === '서버 정리 중…', '도는 중', u8.state);
  const n0 = statusCalls;
  await sleep(2600);
  ok(statusCalls > n0, '도는 동안은 2초마다 다시 읽는다', { before: n0, after: statusCalls });
  await show({ on: true });
  // 그리는 사이 이미 떠난 2초 폴링이 «도는 중»을 한 번 더 그릴 수 있다 — 그 폴링이 끝나기를 기다린 뒤 잰다
  const u9 = await until(async () => { const u = await ui(); return u.state === '켜져 있습니다. 자동 백업이 한 번 돈 뒤 정리합니다.' ? u : null; }, 4000);
  ok(!!u9, '켰지만 아직 안 돔', u9 && u9.state);
  await sleep(2200);
  const n1 = statusCalls;
  await sleep(2600);
  ok(statusCalls === n1, '끝나면 2초 폴링을 멈춘다 (자동 백업이 꺼진 답이라 더 묻지 않는다)', { before: n1, after: statusCalls });
  const u10 = await show({ on: true, at: Date.now() - 3 * 3600_000 - 60_000, moved: 12, kept: 3, unverified: 3 });
  ok(u10.state === '서버 정리 · 3시간 전 · 12통 휴지통으로 · 확인 안 된 3통은 남김', '결과 — 몇 시간 전·옮긴 수·확인 안 돼 남긴 수', u10.state);
  const u11 = await show({ on: true, at: Date.now() - 2 * 86_400_000 - 60_000, moved: 0, kept: 7, unsaved: 5, unverified: 2,
    more: true, skippedBoxes: 1, error: '계정 1: 연결 실패' });
  ok(u11.state === '서버 정리 · 2일 전 · 0통 휴지통으로 · 저장 안 된 5통은 남김(«백업 시작»으로 저장하면 대상)'
    + ' · 확인 안 된 2통은 남김 · 남은 것은 다음에 이어서 · 폴더 1곳은 확인할 수 없어 건너뜀 · 실패: 계정 1: 연결 실패',
  '결과 — 저장 안 됨·확인 안 됨·남은 것·건너뛴 폴더·실패를 다 적는다', u11.state);
  const u12 = await show({ on: false, at: Date.now() - 60_000, moved: 4 });
  ok(u12.state === null, '꺼져 있으면 지난 결과를 보이지 않는다', u12.state);

  console.log('\n[가] 켜기 — 기다리는 동안·그만두기·받아들이기');
  await show({});
  setGate = gate();
  await clickSwitch();
  const w1 = await until(async () => { const u = await ui(); return u.msg && u.msg.kind === 'wait' ? u : null; }, 2000);
  ok(!!w1 && /^확인하는 중…/.test(w1.msg.text) && w1.busy === 'true' && w1.disabled === 'true' && w1.checked === 'false',
    '켜기를 누르면 미리 칠하지 않고 «확인하는 중…»을 보이며 스위치를 잠근다', w1);
  await clickSwitch();
  await sleep(100);
  ok(setCalls.length === 1 && JSON.stringify(setCalls[0]) === '{"on":true}', '기다리는 동안 또 눌러도 다시 부탁하지 않는다 — 부탁은 {on:true} 하나', setCalls);
  setReply = () => ({ ...fakeStatus(), tidy: { ...fakeTidy, message: '그만뒀습니다 — 서버 메일은 그대로입니다.', messageKind: 'wait' } });
  setGate.open();
  setGate = null;
  const c1 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; });
  ok(!!c1 && c1.checked === 'false' && !c1.on && c1.busy === 'false' && c1.disabled === 'false' && c1.msg.kind === 'wait',
    '확인 창에서 그만두면 꺼진 채 «그만뒀습니다»', c1);
  setReply = () => { fakeTidy.on = true; return { ...fakeStatus(), tidy: { ...fakeTidy,
    message: '켰습니다 — 1분쯤 뒤부터 받은 지 30일 지난 메일을 옮깁니다. 그 전에 끄면 아무것도 옮기지 않습니다.', messageKind: 'good' } }; };
  await clickSwitch();
  const c2 = await until(async () => { const u = await ui(); return u.checked === 'true' ? u : null; });
  ok(!!c2 && c2.on && c2.msg && c2.msg.kind === 'good' && /^켰습니다/.test(c2.msg.text) && /1분쯤 뒤/.test(c2.msg.text),
    '받아들이면 켜지고 언제 시작하는지 알린다', c2);
  ok(setCalls.length === 2 && JSON.stringify(setCalls[1]) === '{"on":true}', '부탁은 mailTidySet({on:true})', setCalls);

  console.log('\n[가] 기간');
  setReply = (req) => { fakeTidy.days = req.days; return { ...fakeStatus(), tidy: { ...fakeTidy,
    message: `받은 지 ${req.days}일 지난 메일만 옮기도록 바꿨습니다.`, messageKind: 'good' } }; };
  setGate = gate();
  await js(`document.querySelector('#tidy-days [data-days="90"]').focus()`);
  await clickDays(90);
  await sleep(150);
  const d0 = await ui();
  ok(!(d0.msg && /확인하는 중/.test(d0.msg.text)) && d0.days.every((d) => d.disabled === 'true'),
    '켜진 채 기간 늘리기(30→90)는 묻지 않으므로 «확인하는 중…»을 보이지 않는다. 답을 기다리는 동안 단추는 잠근다', d0);
  setGate.open();
  setGate = null;
  const d1 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(u)) === '["90"]' ? u : null; });
  const focus90 = await js(`document.activeElement === document.querySelector('#tidy-days [data-days="90"]')`);
  ok(!!d1 && /90일 지난/.test(d1.hint) && d1.msg && d1.msg.kind === 'good' && focus90,
    '90일이 눌리고 설명이 바뀌고, 누른 단추에 초점이 남는다 (단추를 다시 만들지 않는다)', { d1, focus90 });
  ok(JSON.stringify(setCalls[2]) === '{"days":90}', '부탁은 mailTidySet({days:90})', setCalls[2]);
  setGate = gate();
  await clickDays(7);
  const d2 = await until(async () => { const u = await ui(); return u.msg && /확인하는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!d2, '켜진 채 기간 줄이기(90→7)는 묻는 일이라 «확인하는 중…»을 보인다', d2);
  setReply = () => ({ ...fakeStatus(), tidy: { ...fakeTidy, message: '그만뒀습니다 — 서버 메일은 그대로입니다.', messageKind: 'wait' } });
  setGate.open();
  setGate = null;
  const d3 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; });
  ok(!!d3 && JSON.stringify(pressed(d3)) === '["90"]' && JSON.stringify(setCalls[3]) === '{"days":7}',
    '그만두면 90일 그대로 — 미리 칠하지 않았다', { pressed: d3 && pressed(d3), req: setCalls[3] });
  const before = setCalls.length;
  await clickDays(90);
  await sleep(150);
  ok(setCalls.length === before && (await ui()).sets.length === before, '이미 고른 기간을 다시 누르면 부탁하지 않는다', setCalls.length);
  // 키보드 — 단추에 초점을 두고 Enter (.mini 는 all: unset 이지만 여전히 <button> 이다)
  setReply = (req) => { fakeTidy.days = req.days; return { ...fakeStatus(), tidy: { ...fakeTidy, message: '', messageKind: '' } }; };
  await js(`document.querySelector('#tidy-days [data-days="30"]').focus()`);
  win.webContents.focus();
  for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
  const d4 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(u)) === '["30"]' ? u : null; });
  ok(!!d4 && JSON.stringify(setCalls[setCalls.length - 1]) === '{"days":30}' && d4.msg === null,
    '키보드(Enter)로도 고른다. 답에 말이 없으면 알림 자리를 비운다', { d4, last: setCalls[setCalls.length - 1] });

  console.log('\n[가] 기간 줄이기를 기다리는 동안에도 끌 수 있다');
  // 켜진 채 30일 → 7일은 메인이 최대 20초 세고 묻는다. 그 사이 확인 창은 아직 없다 — 그만둘 길은 스위치뿐이다
  setGate = gate();
  offPass = true;
  setReply = (req) => {
    if (req && req.on === false) {
      fakeTidy.on = false;
      return { ...fakeStatus(), tidy: { ...fakeTidy, message: '껐습니다 — 서버 메일을 더 옮기지 않습니다.', messageKind: 'good' } };
    }
    fakeTidy.days = req.days;
    return { ...fakeStatus(), tidy: { ...fakeTidy, message: `꺼져 있어 기간만 ${req.days}일로 바꿨습니다.`, messageKind: 'good' } };
  };
  const nk = setCalls.length;
  await clickDays(7);
  const k0 = await until(async () => { const u = await ui(); return u.msg && /확인하는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!k0 && k0.checked === 'true' && k0.disabled === 'false' && k0.days.every((d) => d.disabled === 'true'),
    '기간 줄이기의 답을 기다리는 동안에도 켜진 스위치는 누를 수 있다 (기간 단추는 잠김)', k0);
  await clickSwitch();
  const k1 = await until(async () => { const u = await ui(); return u.checked === 'false' ? u : null; }, 2000);
  ok(!!k1 && JSON.stringify(setCalls.slice(nk)) === '[{"days":7},{"on":false}]' && k1.msg && /^껐습니다/.test(k1.msg.text),
    '…누르면 기다리지 않고 끄기를 부탁하고, 꺼진다', { k1, sent: setCalls.slice(nk) });
  ok(!!k1 && k1.disabled === 'true' && k1.days.every((d) => d.disabled === 'true'),
    '…앞 부탁의 답이 올 때까지 다시 켜기·기간 단추는 잠근 채다', k1);
  await clickSwitch();
  await sleep(150);
  ok(setCalls.length === nk + 2, '…그동안 꺼진 스위치를 눌러도 부탁하지 않는다', setCalls.slice(nk));
  setGate.open();
  setGate = null;
  offPass = false;
  const k2 = await until(async () => { const u = await ui(); return u.msg && /기간만 7일/.test(u.msg.text) ? u : null; });
  ok(!!k2 && k2.checked === 'false' && JSON.stringify(pressed(k2)) === '["7"]' && k2.disabled === 'false' && k2.days.every((d) => d.disabled === 'false'),
    '앞 부탁의 답이 오면 꺼진 채 기간만 7일 — 다시 누를 수 있다', k2);
  await show({ on: true });

  console.log('\n[가] 끄기·응답 없음');
  setGate = gate();
  setReply = () => { fakeTidy.on = false; return { ...fakeStatus(), tidy: { ...fakeTidy, message: '껐습니다 — 서버 메일을 더 옮기지 않습니다.', messageKind: 'good' } }; };
  await clickSwitch();
  await sleep(150);
  const o0 = await ui();
  ok(!(o0.msg && /확인하는 중/.test(o0.msg.text)) && o0.checked === 'true', '끄기는 묻지 않으므로 «확인하는 중…» 없이 답을 기다린다', o0);
  setGate.open();
  setGate = null;
  const o1 = await until(async () => { const u = await ui(); return u.checked === 'false' ? u : null; });
  ok(!!o1 && o1.msg && /^껐습니다/.test(o1.msg.text) && JSON.stringify(setCalls[setCalls.length - 1]) === '{"on":false}',
    '끄면 mailTidySet({on:false}) 후 꺼진다', { o1, last: setCalls[setCalls.length - 1] });
  setReply = () => null;
  await clickSwitch();
  const o2 = await until(async () => { const u = await ui(); return u.msg && u.msg.kind === 'bad' ? u : null; });
  ok(!!o2 && /응답이 없습니다/.test(o2.msg.text) && o2.checked === 'false' && o2.disabled === 'false' && o2.busy === 'false',
    '응답이 없으면 «응답이 없습니다» — 스위치는 그대로, 다시 누를 수 있다', o2);
  setReply = () => ({ ...fakeStatus(), tidy: { ...fakeTidy, message: '서버 정리는 설정 창에서만 켤 수 있습니다.', messageKind: 'bad' } });
  await clickSwitch();
  const o3 = await until(async () => { const u = await ui(); return u.msg && /설정 창에서만/.test(u.msg.text) ? u : null; });
  ok(!!o3 && o3.msg.kind === 'bad' && o3.checked === 'false', '메인이 거절하면 그 까닭을 빨강으로', o3);

  console.log('\n[가] «바로»(0일)');
  const z0 = await show({ days: 0 });
  ok(JSON.stringify(pressed(z0)) === '["0"]' && z0.days.every((d) => d.ghost === (d.d !== '0')) && z0.tail === '읽은 메일은 새 메일 확인 때마다',
    '0일이면 «바로»가 눌리고 뒤 줄이 «읽은 메일은 새 메일 확인 때마다» — «받은 지 0일»·«저장되자마자»라고 쓰지 않는다', { days: z0.days, tail: z0.tail });
  ok(/«읽은» 메일을 새 메일 확인 때마다 서버의/.test(z0.hint) && /안 읽은 메일은 읽을 때까지 서버에 남아/.test(z0.hint) && /창을 닫은 뒤에 옮깁니다/.test(z0.hint)
    && /휴지통에서 되찾을 수/.test(z0.hint) && /별표/.test(z0.hint) && /모든 메일 계정/.test(z0.hint) && !/0일/.test(z0.hint + z0.tail)
    && !/몇 분 안에/.test(z0.hint) && !/분마다/.test(z0.hint),
  '설명이 «바로»의 글로 바뀐다 — 읽은 것만 메일 확인 때마다 · 안 읽은 것은 남음 · 보고 있는 메일은 닫은 뒤 · 되찾기 · 별표 (주기를 모르면 숫자 없이)', z0.hint);
  ok(/열어 보기만 해서는 읽음이 되지 않습니다/.test(z0.hint) && /보기 창이나 위젯 목록에서 읽음으로 표시하거나/.test(z0.hint)
    && /보낸 메일은 늘 읽은 것으로 쳐서/.test(z0.hint) && /보낸편지함도 비게/.test(z0.hint) && /이 앱의 메일 목록에서도 사라지지만/.test(z0.hint),
  '…이 앱에서 열기만 해서는 읽음이 아니라는 것 · 보낸 메일은 곧 옮겨 보낸편지함도 빈다는 것 · 이 앱의 목록에서도 사라진다는 것을 말한다', z0.hint);
  ok(/메일 회사에 따라 일정 기간이 지나면 휴지통이 비워지기도 합니다/.test(z0.hint) && !/정한 기간이 지나면 비워집니다/.test(z0.hint)
    && /Gmail이 저절로 붙인 중요 표시/.test(z0.hint), '…휴지통이 저절로 비워진다고 단정하지 않는다 (아래 자동 비우기 안내와 맞게). Gmail 자동 중요 표시도 남긴다고', z0.hint);
  ok(z0.notes.some((t) => /휴지통 자동 비우기/.test(t)), '…휴지통 자동 비우기 안내는 «바로»에서도 보인다', z0.notes);
  const z0b = await show({ days: 0, everyMin: 30 });
  ok(/새 메일 확인 때마다\(지금은 약 30분마다\)/.test(z0b.hint), '메인이 준 실제 주기(everyMin)로 말한다 — «몇 분 안에»가 아니라 «약 30분마다»', z0b.hint);
  const z1 = await show({ days: 7 });
  ok(JSON.stringify(pressed(z1)) === '["7"]' && z1.tail === '받은 지 7일 지난 메일만' && /받은 지 7일 지난/.test(z1.hint) && !/확인 때마다/.test(z1.hint),
    '7일로 돌아오면 뒤 줄·설명도 기간 글로 돌아온다', { tail: z1.tail, hint: z1.hint });
  const z2 = await show({ on: true, days: 0, at: Date.now() - 2 * 60_000 - 5000, moved: 3, unread: 2 });
  ok(z2.state === '서버 정리 · 2분 전 · 3통 휴지통으로 · 안 읽은 2통은 읽을 때까지 남김',
    '«바로» 상태 줄 — 안 읽어 남긴 것은 경고가 아니라 «읽을 때까지 남김» (읽어도 남기는 메일이 있어 «읽으면 옮김»이라 약속하지 않는다)', z2.state);
  const z2b = await show({ on: true, days: 30, at: Date.now() - 2 * 60_000 - 5000, moved: 0, unread: 2 });
  ok(z2b.state === '서버 정리 · 2분 전 · 0통 휴지통으로',
    '«바로»에서 30일로 바꾼 뒤 남은 지난 «바로» 결과의 unread 는 말하지 않는다 (30일 정리는 안 읽은 메일도 옮긴다)', z2b.state);
  const z2c = await show({ on: true, days: 0, at: Date.now() - 2 * 60_000 - 5000, moved: 1, spared: 4 });
  ok(z2c.state === '서버 정리 · 2분 전 · 1통 휴지통으로 · 별표·중요 표시 등 4통은 남김',
    '일부러 남긴 것(spared — Gmail 자동 중요 표시 등)도 사실로 적는다 — 읽은 메일이 까닭 없이 남아 보이지 않게', z2c.state);
  const z3 = await show({ on: true, days: 0, at: Date.now() - 60_000, moved: 0, unread: 0, kept: 1, unsaved: 1 });
  ok(z3.state === '서버 정리 · 1분 전 · 0통 휴지통으로 · 저장 안 된 1통은 남김(«백업 시작»으로 저장하면 대상)',
    '…안 읽은 것·남긴 것이 없으면 그 말은 없다. 저장 안 된 것은 지금처럼', z3.state);
  // 켜진 채 30 → 바로: 묻는 일이다 — «확인하는 중…», 미리 칠하지 않는다
  await show({ on: true, days: 30 });
  setReply = (req) => { fakeTidy.days = req.days; return { ...fakeStatus(), tidy: { ...fakeTidy, message: '바꿨습니다', messageKind: 'good' } }; };
  setGate = gate();
  const nz = setCalls.length;
  await clickDays(0);
  const z4 = await until(async () => { const u = await ui(); return u.msg && /확인하는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!z4 && JSON.stringify(pressed(z4)) === '["30"]' && JSON.stringify(setCalls[nz]) === '{"days":0}',
    '켜진 채 30→바로는 «확인하는 중…» — 부탁은 {days:0} (0이 빠지거나 30으로 바뀌지 않는다), 답이 오기 전에는 30일 그대로', { pressed: z4 && pressed(z4), sent: setCalls.slice(nz) });
  setGate.open();
  setGate = null;
  const z5 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(u)) === '["0"]' ? u : null; });
  ok(!!z5 && z5.tail === '읽은 메일은 새 메일 확인 때마다', '…받아들인 답이 오면 «바로»가 눌린다', z5 && z5.tail);
  // 바로 → 30 도 묻는다 (안 읽은 오래된 메일까지 옮기게 되므로)
  setGate = gate();
  await clickDays(30);
  const z6 = await until(async () => { const u = await ui(); return u.msg && /확인하는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!z6 && JSON.stringify(setCalls[setCalls.length - 1]) === '{"days":30}', '켜진 채 바로→30 도 «확인하는 중…»', setCalls.slice(nz));
  setGate.open();
  setGate = null;
  await until(async () => JSON.stringify(pressed(await ui())) === '["30"]');
  // 꺼진 채라면 «바로»도 묻지 않는다
  await show({ on: false, days: 30 });
  await clickDays(0);
  await sleep(150);
  const z7 = await ui();
  ok(!(z7.msg && /확인하는 중/.test(z7.msg.text)) && JSON.stringify(setCalls[setCalls.length - 1]) === '{"days":0}',
    '꺼진 채 «바로»를 고르는 것은 묻지 않는다 (켤 때 묻는다)', z7.msg);
  await show({});

  console.log('\n[가] 백업 줄·메일 확인하기·setApp');
  const b1 = await show({}, { running: true, waiting: '서버 정리를 멈추는 중 — 끝나면 바로 백업을 시작합니다' });
  ok(b1.backupState === '서버 정리를 멈추는 중 — 끝나면 바로 백업을 시작합니다', '«백업 시작»이 기다리는 중이면 그 한 줄을 보인다', b1.backupState);
  await show({});
  // 도는 중이던 800ms 폴링이 한 번 더 그릴 수 있다 — 가라앉기를 기다린다
  await sleep(2000);
  const e0 = errs.length;
  await js("document.getElementById('btn-backup-start').click()");   // 시험용 다리는 null 을 준다
  await sleep(200);
  const b2 = await ui();
  ok(errs.length === e0 && b2.row && b2.backupDir === BACKUP_DIR, '«백업 시작»의 답이 null 이어도 오류 없이 그림을 그대로 둔다',
    errs.slice(e0));
  const n2 = statusCalls;
  await js("document.getElementById('mailEnabled').click()");
  const n3 = await until(() => statusCalls > n2, 1500);
  const sentOff = await js('(window.__setApp || []).slice(-1)[0]');
  ok(!!n3 && sentOff && sentOff.mailEnabled === false, '«메일 확인하기»를 누르면 setApp 뒤에 상태를 다시 읽는다', { calls: statusCalls - n2, sentOff });
  await js("document.getElementById('mailEnabled').click()");   // 되돌린다
  await sleep(150);

  console.log('\n[가] 테마');
  await show({ ready: false, why: '«자동으로 백업»을 켜야 쓸 수 있습니다.' });
  const look = () => js(`(() => {
    const c = (id) => getComputedStyle(document.getElementById(id));
    const day = document.querySelector('#tidy-days [data-days="7"]');
    day.setAttribute('aria-disabled', 'true');
    const dayOp = getComputedStyle(day).opacity;
    day.setAttribute('aria-disabled', 'false');
    return { theme: document.documentElement.getAttribute('data-theme'), state: c('tidy-state').color, auto: c('backup-auto').color,
      sw: c('mailServerTidy').opacity, day: dayOp, other: c('mailAutoBackup').opacity };
  })()`);
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  const t1 = await look();
  await js("document.documentElement.setAttribute('data-theme', 'light')");
  const t2 = await look();
  for (const t of [t1, t2]) {
    ok(t.state === t.auto && t.sw === '0.45' && t.day === '0.45' && t.other === '1',
      `${t.theme} — 상태 줄이 위 안내 줄과 같은 색, 막힌 스위치·단추만 0.45`, t);
  }
  ok(t1.state !== t2.state, '다크와 라이트의 상태 줄 색이 다르다 (테마 이름을 따른다)', [t1.state, t2.state]);
  // 누를 수 없는 기간 단추 — 마우스를 올려도 눌릴 것처럼 반응하지 않는다 (묻는 동안 마우스는 대개 그 단추 위에 있다)
  const hovered = async () => {
    const at = await js(`(() => {
      const b = document.querySelector('#tidy-days [data-days="7"]');
      b.scrollIntoView({ block: 'center' });
      b.setAttribute('aria-disabled', 'true');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await sleep(120);
    const out = await js(`(() => {
      const b = document.querySelector('#tidy-days [data-days="7"]');
      const cs = getComputedStyle(b);
      return { theme: document.documentElement.getAttribute('data-theme'), hover: b.matches(':hover'), ghost: b.classList.contains('ghost'),
        filter: cs.filter, bg: cs.backgroundColor };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await js(`document.querySelector('#tidy-days [data-days="7"]').setAttribute('aria-disabled', 'false')`);
    await sleep(60);
    return out;
  };
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    const h = await hovered();
    ok(h.hover && h.ghost && h.filter === 'none' && h.bg === 'rgba(0, 0, 0, 0)',
      `${theme} — 막힌 기간 단추는 마우스를 올려도 밝기·바탕이 그대로다`, h);
  }
  await js("document.documentElement.setAttribute('data-theme', 'dark')");

  // ── [나] 진짜 src/backup.js ────────────────────────
  console.log('\n[나] 진짜 메인 처리기 (src/backup.js)');
  const backupSrc = fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8');
  const nsAsk = /\bpopup\.askUser\(/.test(backupSrc) && !/\{\s*[^}]*\baskUser\b[^}]*\}\s*=\s*require\(/.test(backupSrc);
  ok(nsAsk, 'backup.js 가 확인 창을 popup.askUser(…)로 부른다 — 시험이 바꿔 끼울 수 있다 (안 그러면 진짜 창이 뜬다)');
  ok(typeof store.setGatedSettings === 'function', 'store.setGatedSettings 가 있다 (CORE)');
  let backup = null;
  if (nsAsk && typeof store.setGatedSettings === 'function') {
    ipcMain.removeHandler('mail:backup-status');
    ipcMain.removeHandler('mail:tidy-set');
    backup = require(path.join(ROOT, 'src', 'backup.js'));
  }
  ok(!!backup && typeof backup.setTidy === 'function', 'backup.js 가 setTidy 를 내놓는다 (CORE)');
  if (backup && typeof backup.setTidy === 'function') {
    store.setGatedSettings({ mailBackupDir: BACKUP_DIR });
    store.setSettings({ mailEnabled: true, mailAutoBackup: true });
    let allow = true;
    let answer = 1;
    const asks = [];
    popup.askUser = async (_parent, opts) => { asks.push(opts); return answer; };
    backup.init({
      mailAccountsForUse: () => [],
      isSettingsWin: (wc) => allow && wc === win.webContents,
      refreshMail: () => {},
      // 켠 뒤 정리가 돌기 전에 시험이 끝난다 — 계정도 비어 있다
      tidyTiming: { START_MS: 3600_000, AGAIN_MS: 3600_000, FIRST_MS: 3600_000 }
    });
    await js('window.__tidySet = [];');
    const r0 = await repaint();
    const st0 = await js('window.nunsseom.mailBackupStatus()');
    const missing = TIDY_KEYS.filter((k) => !(st0 && st0.tidy && k in st0.tidy));
    ok(!missing.length && st0 && 'waiting' in st0, '메인 상태에 화면이 읽는 키가 다 있다 (st.tidy·st.waiting)', missing);
    ok(r0.row && r0.checked === 'false' && r0.disabled === 'false' && JSON.stringify(pressed(r0)) === '["30"]' && r0.state === null,
      '처음 — 보이고, 꺼져 있고, 누를 수 있고, 30일', r0);

    answer = 1;
    await clickSwitch();
    const r1 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; }, 25_000);
    ok(!!r1 && r1.checked === 'false' && store.settings.mailServerTidy !== true && asks.length === 1, '그만두기 → 꺼진 채', { r1, asks: asks.length });
    const q = asks[0] || {};
    ok(q.danger === true && q.defaultId === 0 && q.focusId === 1 && Array.isArray(q.buttons)
      && q.buttons[0] === '서버 정리 켜기' && q.buttons[1] === '그만두기',
    '확인 창 — 위험 단추는 빨갛게, 초점은 «그만두기»', { danger: q.danger, defaultId: q.defaultId, focusId: q.focusId, buttons: q.buttons });

    answer = 0;
    await clickSwitch();
    const r2 = await until(async () => { const u = await ui(); return u.checked === 'true' ? u : null; }, 25_000);
    ok(!!r2 && store.settings.mailServerTidy === true && r2.msg && r2.msg.kind === 'good', '서버 정리 켜기 → 켜진다', r2);

    await clickDays(90);
    const r3 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(u)) === '["90"]' ? u : null; }, 10_000);
    ok(!!r3 && store.settings.mailTidyDays === 90 && asks.length === 2, '켜진 채 30→90일은 묻지 않고 바뀐다', { days: store.settings.mailTidyDays, asks: asks.length });

    answer = 1;
    await clickDays(7);
    const r4 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; }, 25_000);
    ok(!!r4 && asks.length === 3 && store.settings.mailTidyDays === 90 && JSON.stringify(pressed(r4)) === '["90"]',
      '90→7일은 묻고, 그만두면 90일 그대로', { asks: asks.length, days: store.settings.mailTidyDays });

    const n4 = (await ui()).sets.length;
    await clickDays(90);
    await sleep(200);
    ok((await ui()).sets.length === n4, '같은 기간을 다시 누르면 부탁하지 않는다');

    await clickSwitch();
    const r5 = await until(async () => { const u = await ui(); return u.checked === 'false' ? u : null; }, 10_000);
    ok(!!r5 && store.settings.mailServerTidy !== true && asks.length === 3 && r5.msg && /껐습니다/.test(r5.msg.text),
      '끄기는 묻지 않는다', { asks: asks.length, msg: r5 && r5.msg });

    allow = false;
    answer = 0;
    await clickSwitch();
    const r6 = await until(async () => { const u = await ui(); return u.msg && /설정 창에서만/.test(u.msg.text) ? u : null; }, 10_000);
    ok(!!r6 && r6.msg.kind === 'bad' && r6.checked === 'false' && asks.length === 3 && store.settings.mailServerTidy !== true,
      '설정 창이 아닌 곳에서 온 켜기는 거절 — 확인 창도 안 띄운다', { msg: r6 && r6.msg, asks: asks.length });

    allow = true;
    await clickSwitch();
    await until(async () => (await ui()).checked === 'true', 25_000);

    // «바로»(0) — 화면 → preload → mail:tidy-set → setTidy → store → 상태 → 화면까지 0 이 0 으로 간다
    const na = asks.length;
    answer = 1;
    await clickDays(0);
    const b1z = await until(async () => { const u = await ui(); return asks.length > na && u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; }, 25_000);
    const qz = asks[asks.length - 1] || {};
    ok(!!b1z && store.settings.mailTidyDays === 90 && JSON.stringify(pressed(b1z)) === '["90"]' && qz.title === '서버 정리 — 읽은 메일 바로 옮기기'
      && qz.buttons && qz.buttons[0] === '«바로»로 바꾸기' && qz.focusId === 1,
    '켜진 채 90일→바로는 묻고, 그만두면 90일 그대로', { days: store.settings.mailTidyDays, title: qz.title, buttons: qz.buttons });
    answer = 0;
    await clickDays(0);
    const b2z = await until(async () => { const u = await ui(); return JSON.stringify(pressed(u)) === '["0"]' ? u : null; }, 25_000);
    const sentZ = (await ui()).sets.filter((x) => x && 'days' in x).slice(-2);
    ok(!!b2z && store.settings.mailTidyDays === 0 && store.reloadFromDisk().settings.mailTidyDays === 0 && b2z.tail === '읽은 메일은 새 메일 확인 때마다'
      && JSON.stringify(sentZ) === '[{"days":0},{"days":0}]' && b2z.msg && b2z.msg.kind === 'good',
    '«바로»로 바꾸기 → 메인 설정·디스크까지 0, 화면도 «바로» (30으로 바뀌지 않는다)', { days: store.settings.mailTidyDays, sent: sentZ, msg: b2z && b2z.msg });
    const stZ = await js('window.nunsseom.mailBackupStatus()');
    ok(stZ.tidy.days === 0 && stZ.tidy.unread === 0, '메인 상태도 days 0 (unread 키가 있다)', { days: stZ.tidy.days, unread: stZ.tidy.unread });
    ok(stZ.tidy.everyMin === 10 && b2z && /새 메일 확인 때마다\(지금은 약 10분마다\)/.test(b2z.hint),
      '설명의 주기는 메인이 메일 확인 주기(기본 10분)로 계산해 준 값이다', { everyMin: stZ.tidy.everyMin, hint: b2z && b2z.hint });
    const nb = asks.length;
    answer = 0;
    await clickDays(90);
    const b3z = await until(async () => { const u = await ui(); return JSON.stringify(pressed(u)) === '["90"]' ? u : null; }, 25_000);
    ok(!!b3z && asks.length === nb + 1 && store.settings.mailTidyDays === 90 && (asks[asks.length - 1] || {}).title === '서버 정리 — 기간으로 바꾸기',
      '바로→90일도 묻고(«기간으로 바꾸기»), 고르면 90일', { asks: asks.length - nb, days: store.settings.mailTidyDays });

    store.setSettings({ mailAutoBackup: false });
    const r7 = await repaint();
    ok(r7.checked === 'false' && r7.disabled === 'true' && /«자동으로 백업»/.test(r7.state || '') && store.settings.mailServerTidy !== true,
      '자동 백업을 끄면 서버 정리도 꺼지고, 스위치가 막히고, 까닭이 보인다', r7);
    const n5 = r7.sets.length;
    await clickSwitch();
    await sleep(200);
    ok((await ui()).sets.length === n5, '막힌 스위치를 눌러도 부탁하지 않는다');
    const sent = await js('window.__setApp || []');
    const leak = sent.filter((p) => p && GATED.some((k) => k in p));
    ok(!leak.length, 'setApp 에 서버 정리 키가 한 번도 실리지 않았다', leak);
  }

  // ── [다] 확인 창 (renderer/popup.html) — 초점 ─────────
  // 메인은 세는 데 20초까지 걸린 뒤 창을 띄우고 초점을 가져간다. 그 사이 다른 데 치던 Enter·Space 가
  // 빨간 «서버 정리 켜기»로 들어가면 안 된다 — 색은 위험 단추에, 초점은 «그만두기»(focusId)에.
  console.log('\n[다] 확인 창 — 위험 단추는 빨갛게, 초점은 «그만두기»');
  let popupData = null;
  ipcMain.on('stub:popup', (e) => { e.returnValue = popupData; });
  making = true;
  const pop = new BrowserWindow({ show: false, width: 400, height: 300,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'popup-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  making = false;
  pop.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  const pjs = (c) => pop.webContents.executeJavaScript(c);
  const openPopup = async (d) => {
    popupData = d;
    await pop.loadFile(path.join(ROOT, 'renderer', 'popup.html'), { query: { theme: 'dark', scrim: '0.92', inset: '12' } });
    return until(() => pjs(`(() => {
      const a = document.activeElement;
      if (!a || !a.classList.contains('btn')) return null;
      return { focus: a.textContent, cls: [...document.querySelectorAll('.btn')].map((b) => [b.textContent, b.className]) };
    })()`), 3000);
  };
  const enter = async () => {
    pop.webContents.focus();
    for (const type of ['keyDown', 'char', 'keyUp']) pop.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
    return until(() => pjs('window.__pick.length ? window.__pick.slice() : null'), 2000);
  };
  const tidyAsk = { kind: 'dialog', title: '서버 정리 켜기', message: '지금 기준으로 약 2통을 서버의 휴지통으로 옮깁니다.',
    detail: '시험', buttons: ['서버 정리 켜기', '그만두기'], defaultId: 0, danger: true, focusId: 1 };
  const p1 = await openPopup(tidyAsk);
  const red = p1 && p1.cls.find(([t]) => t === '서버 정리 켜기');
  ok(!!p1 && p1.focus === '그만두기' && red && /\bbad\b/.test(red[1]), '처음 초점은 «그만두기», 빨간 칠은 «서버 정리 켜기»', p1);
  const pk1 = await enter();
  ok(JSON.stringify(pk1) === '[1]', '…그대로 Enter 를 누르면 «그만두기»(1)로 답한다', pk1);
  const p2 = await openPopup({ ...tidyAsk, title: '서버 정리 — 기간 줄이기', buttons: ['7일로 줄이기', '그만두기'] });
  ok(!!p2 && p2.focus === '그만두기', '기간 줄이기 창도 초점은 «그만두기»', p2);
  // focusId 를 주지 않는 다른 물음은 예전 그대로 — 칠한 기본 단추에 초점
  const p3 = await openPopup({ kind: 'dialog', title: '지우기', message: '이 알림을 지울까요?', buttons: ['지우기', '그만두기'], defaultId: 0, danger: true });
  ok(!!p3 && p3.focus === '지우기', 'focusId 가 없으면 지금처럼 기본(defaultId) 단추에 초점', p3);
  const p4 = await openPopup({ kind: 'dialog', message: '저장할까요?', buttons: ['저장', '취소'], defaultId: 0 });
  ok(!!p4 && p4.focus === '저장' && /\bgo\b/.test((p4.cls.find(([t]) => t === '저장') || [])[1] || ''), '…위험하지 않은 물음도 그대로', p4);
  pop.destroy();

  // ── 마무리 ───────────────────────────────────────
  const sentAll = await js('window.__setApp || []');
  ok(!sentAll.some((p) => p && GATED.some((k) => k in p)), '화면 전체에서 setApp 에 서버 정리 키가 없다', sentAll);
  ok(!strays.length, '시험 창 말고 다른 창(확인 창 등)이 하나도 안 생겼다', strays);
  ok(errs.length === 0, '콘솔 오류(level 3 이상)가 없다', errs.slice(0, 5));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

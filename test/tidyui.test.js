// 설정 › PC에 받아 둔 메일 › «서버 정리» — 계정마다의 줄(스위치·옮기는 때·뜻·상태·멈춤과 «다시 해 보기»)이 메인의 답대로 그려지고,
// 누르면 그 계정 하나를 메인에 부탁만 하는가.
//
// 서버 정리는 PC에 저장이 확인된 오래된 메일을 서버 휴지통으로 옮긴다. 켜기와 기간 줄이기는 메인이 그 계정을 세어 보고
// 확인 창으로 묻는다 — 화면은 미리 칠하지 않고 mailTidySet({ id, … }) 으로 부탁만 한다. 일반 setApp 으로 새면 확인을 건너뛴다.
//
// 진짜 settings.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/settings-mail-bridge-stub.js 를 쓴다.
// 메일 서버·자격 증명 관리자에는 가지 않는다 ([나]는 가짜 IMAP — test/fixtures/fake-imap.js).
//
// [가] 시험이 정한 답 (메인 처리기 자리에 시험용 처리기) — 화면이 상태 모양마다 맞게 그리는가
//   · 메인이 답하기 전·st.tidy 가 없는 답(옛 메인)·옛 모양(계정 줄 없음)이면 감춘다. 공통 스위치는 없다
//   · 계정마다 한 줄: 이름, role=switch(aria-label «{이름} 서버 정리», aria-describedby 로 뜻·상태 줄), 옮기는 때 group
//     («{이름} 옮기는 때» 안의 바로·7·30·90일), 고른 때의 뜻, 상태 한 줄. Gmail 줄에는 라벨 안내, 복사 길 서버에는 그 안내
//   · 상태 줄 순서: 꺼짐(빈 줄) · 쉬는 중 · 멈춤 · 지난 메일로 쉼 · 정리 중 · 아직 안 돔 · 옮김 · 기간이 안 지남 · PC에 없음 ·
//     Gmail 중요 · 안 읽음 · 실패 (+ 꼬리 조각)
//   · 멈춘 계정은 까닭과 «다시 해 보기» 단추를 보이고 옮기는 때를 감추며 켜기를 막는다
//   · 쓸 수 없는 까닭은 한 번(#tidy-why). 묻는 중·기다리는 중에는 켜기·기간 단추를 막고 켜진 스위치(끄기)는 늘 눌린다
//   · 누르면 mailTidySet({id, on}) / ({id, days}) / ({id, retry}) — 같은 기간은 부탁하지 않는다. setApp 에 정리 키가 없다
//   · 다크·라이트 모두 상태 줄이 위 안내 줄과 같은 색이고, 누를 수 없는 스위치·단추는 opacity 0.45
// [나] 진짜 src/backup.js 처리기 (확인 창 popup.askUser 와 메일 서버만 바꿔 끼운다) — 화면과 메인이 같은 약속을 지키는가
// [다] 진짜 renderer/popup.html 을 화면 밖 창에 — 초점이 실제로 «그만두기»에 가고 Enter 가 그만두기로 답하는가.
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
const GATED = ['mailTidyAccounts', 'mailTidyResults', 'mailBackupDir', 'mailServerTidy', 'mailTidyDays', 'mailTidyLast'];
// 화면이 읽는 st.tidy 키 — 위쪽과 계정 줄
const TIDY_KEYS = ['ready', 'why', 'running', 'asking', 'askingId', 'current', 'everyMin', 'cap', 'total', 'message', 'messageKind', 'accounts'];
const ROW_KEYS = ['id', 'name', 'gmail', 'on', 'days', 'running', 'held', 'blocked', 'copyPath', 'at', 'ranDays', 'moved', 'kept', 'unsaved',
  'unverified', 'spared', 'important', 'unread', 'skippedBoxes', 'more', 'error', 'oldest'];
const DAY = 86_400_000;

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  // 서버에는 절대 붙지 않는다 — [나]에서 가짜 서버로 바꿔 끼운다
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
  const row = (id, o = {}) => ({ id, name: id === 'a1' ? '회사' : 'Gmail 개인', gmail: id !== 'a1', on: false, days: 30, running: false, held: false,
    blocked: null, blockedAt: 0, caps: null, copyPath: false, at: 0, ranDays: null, moved: 0, kept: 0, unsaved: 0, unverified: 0, spared: 0,
    important: 0, flagged: 0, unread: 0, uncertain: 0, skippedBoxes: 0, more: false, error: null, oldest: 0, total: 0, ...o });
  const baseTidy = () => ({ ready: true, why: '', running: false, asking: false, askingId: null, current: null, everyMin: 10, cap: 300, total: 0,
    message: '', messageKind: '', accounts: [row('a1'), row('a2')], servers: [] });
  let fakeTidy = baseTidy();
  let fakeExtra = {};
  let noTidy = false;
  let statusCalls = 0;
  let statusGate = null;
  const fakeStatus = () => ({ ...baseStatus(), ...fakeExtra, ...(noTidy ? {} : { tidy: JSON.parse(JSON.stringify(fakeTidy)) }) });
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
  /** 시험용 상태의 그 계정 줄을 고친다 */
  const fake = (id) => fakeTidy.accounts.find((a) => a.id === id);
  const reply = (message, messageKind = 'good') => ({ ...fakeStatus(), tidy: { ...JSON.parse(JSON.stringify(fakeTidy)), message, messageKind } });

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
    const msg = $('tidy-msg');
    const rows = [...document.querySelectorAll('#tidy-rows .tidyrow')].map((r) => {
      const sw = r.querySelector('.sw');
      const g = r.querySelector('.tidydays [role="group"]');
      const st = r.querySelector('.tidystate');
      const tail = r.querySelector('.tidytail');
      const stop = r.querySelector('.tidystop');
      const retry = stop.querySelector('button');
      const ids = (sw.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      return {
        id: r.dataset.id, name: r.querySelector('.tidyname').textContent,
        role: sw.getAttribute('role'), checked: sw.getAttribute('aria-checked'), on: sw.classList.contains('on'),
        disabled: sw.getAttribute('aria-disabled'), busy: sw.getAttribute('aria-busy'), label: sw.getAttribute('aria-label'),
        describedby: ids.join(' '), described: ids.length === 3 && ids.every((x) => !!document.getElementById(x) && r.contains(document.getElementById(x))),
        daysShown: vis(r.querySelector('.tidydays')), groupRole: g.getAttribute('role'), groupLabel: g.getAttribute('aria-label'),
        lbl: r.querySelector('.tidydays .lbl').textContent,
        days: [...g.querySelectorAll('button')].map((b) => ({ d: b.dataset.days, t: b.textContent, pressed: b.getAttribute('aria-pressed'),
          ghost: b.classList.contains('ghost'), disabled: b.getAttribute('aria-disabled') })),
        tail: vis(tail) ? tail.textContent : null,
        copy: vis(r.querySelector('.tidycopy')) ? r.querySelector('.tidycopy').textContent : null,
        caps: vis(r.querySelector('.tidycaps')) ? r.querySelector('.tidycaps').textContent : null,
        capsTitle: r.querySelector('.tidycaps') ? r.querySelector('.tidycaps').title : null,
        swFocused: document.activeElement === sw,
        gmail: vis(r.querySelector('.tidygmail')) ? r.querySelector('.tidygmail').textContent : null,
        state: vis(st) ? st.textContent : null,
        stop: vis(stop) ? stop.querySelector('.tidywhy').textContent : null,
        retryDisabled: retry.getAttribute('aria-disabled'), retryLabel: retry.getAttribute('aria-label')
      };
    });
    return {
      wrap: vis($('tidy-wrap')), lead: $('tidy-lead') ? $('tidy-lead').textContent : null,
      why: vis($('tidy-why')) ? $('tidy-why').textContent : null,
      oldSwitch: !!$('mailServerTidy') || !!$('tidy-row'),
      notes: [...document.querySelectorAll('#tidy-wrap > .hint')].filter((e) => !e.id && vis(e)).map((e) => e.textContent),
      rows,
      msg: msg.classList.contains('show')
        ? { text: msg.textContent, kind: ['good', 'bad', 'wait'].find((k) => msg.classList.contains(k)) || '' } : null,
      msgRole: msg.getAttribute('role'),
      backupState: $('backup-state').textContent,
      backupDir: $('backup-dir').textContent,
      sets: (window.__tidySet || []).slice()
    };
  })()`);
  const R = (u, id = 'a1') => (u.rows || []).find((r) => r.id === id) || {};
  const pressed = (r) => (r.days || []).filter((d) => d.pressed === 'true').map((d) => d.d);
  const sel = (id) => `#tidy-rows .tidyrow[data-id="${id}"]`;
  const clickSwitch = (id = 'a1') => js(`document.querySelector('${sel(id)} .sw').click()`);
  const clickDays = (d, id = 'a1') => js(`document.querySelector('${sel(id)} [data-days="${d}"]').click()`);
  const clickRetry = (id = 'a1') => js(`document.querySelector('${sel(id)} .tidystop button').click()`);
  const repaint = async () => { await js('window.nunsSetMail.loadBackup()'); await sleep(50); return ui(); };
  /** 계정 줄을 이 모양으로 — o 는 { a1: {...}, a2: {...} }, top 은 위쪽 키 */
  const show = async (o = {}, top = {}, extra = {}) => {
    fakeTidy = { ...baseTidy(), ...top, accounts: [row('a1', o.a1 || {}), row('a2', o.a2 || {})] };
    fakeExtra = extra;
    return repaint();
  };

  console.log('\n[가] 처음 그리기');
  statusGate = gate();
  await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'mail' } });
  await until(() => statusCalls >= 1);
  const u0 = await ui();
  ok(!u0.wrap && !u0.oldSwitch, '메인이 답하기 전에는 서버 정리 칸이 감춰져 있고, 옛 공통 스위치는 없다', u0);
  // 옛 메인 — st.tidy 가 없다
  noTidy = true;
  const g0 = statusGate;
  statusGate = null;
  g0.open();
  const u1 = await until(async () => { const u = await ui(); return u.backupDir === BACKUP_DIR ? u : null; });
  ok(!!u1 && !u1.wrap, 'st.tidy 가 없는 답이면 그린 뒤에도 감춘 채다', u1);
  noTidy = false;
  fakeTidy = { on: false, days: 30, ready: true, why: '' };   // 옛 모양 — 계정 줄이 없다
  const u1b = await repaint();
  ok(!u1b.wrap && u1b.rows.length === 0, '…계정 줄이 없는 옛 모양이어도 감춘다', u1b);
  const u2 = await show();
  ok(u2.wrap && u2.rows.length === 2 && JSON.stringify(u2.rows.map((r) => r.id)) === '["a1","a2"]', 'st.tidy 의 계정 줄대로 두 줄 — 설정 순서', u2.rows.map((r) => r.id));
  const a = R(u2);
  ok(a.name === '회사' && a.role === 'switch' && a.checked === 'false' && !a.on && a.disabled === 'false' && a.label === '회사 서버 정리'
    && a.describedby === 'tidy-tail-a1 tidy-state-a1 tidy-why-a1' && a.described,
  '줄 — 이름, role=switch · aria-checked=false · aria-label «회사 서버 정리» · 뜻·상태·멈춘 까닭 줄과 이어짐', a);
  ok(JSON.stringify(a.days.map((d) => d.t)) === '["바로","7일","30일","90일"]' && JSON.stringify(a.days.map((d) => d.d)) === '["0","7","30","90"]'
    && a.groupRole === 'group' && a.groupLabel === '회사 옮기는 때' && a.lbl === '옮기는 때' && a.daysShown,
  '옮기는 때 — role=group «회사 옮기는 때» 안에 바로·7일·30일·90일', a.days);
  ok(JSON.stringify(pressed(a)) === '["30"]' && a.days.every((d) => d.ghost === (d.d !== '30')), '기본은 30일 — aria-pressed 와 칠이 같다', a.days);
  ok(a.tail === '받은 지 30일 지난 메일을 읽음과 상관없이 옮깁니다. 별표·중요 메일은 남깁니다.', '뜻 — 기간 글', a.tail);
  ok(a.state === null && a.stop === null && a.copy === null && a.gmail === null, '꺼져 있으면 상태 줄은 비어 감춘다. 멈춤·복사·Gmail 안내 없음', a);
  const b2 = R(u2, 'a2');
  ok(b2.gmail === 'Gmail은 라벨 폴더에서 옮겨도 메일 자체가 휴지통으로 가 모든 라벨에서 빠집니다.' && b2.label === 'Gmail 개인 서버 정리', 'Gmail 줄에는 라벨 안내 한 줄', b2.gmail);
  ok(/^켜 둔 계정만, PC에 저장이 확인된 메일을 서버 휴지통으로 옮깁니다\./.test(u2.lead || '') && /웹메일·폰에서도 사라지고/.test(u2.lead || ''),
    '맨 위 안내 — 켜 둔 계정만 · 서버 휴지통 · 웹메일·폰에서도 사라짐', u2.lead);
  ok(u2.notes.some((t) => /모든 계정이 함께 꺼집니다/.test(t)) && u2.notes.some((t) => /휴지통 자동 비우기/.test(t)),
    '안내 — 메일 확인을 끄거나 폴더를 바꾸면 모든 계정이 꺼짐 · 휴지통 자동 비우기', u2.notes);
  ok(u2.why === null && u2.msg === null && u2.msgRole === 'status', '쓸 수 있으면 까닭 줄은 감춘다. 알림 자리는 role=status', u2);
  const u2c = await show({ a1: { copyPath: true, caps: '옮기기(MOVE) 없음 · UIDPLUS 있음' } });
  ok(R(u2c).copy === '이 서버는 옮기기(MOVE)가 없어 복사한 뒤 지웁니다.' && R(u2c, 'a2').copy === null, 'MOVE 없는 서버 줄에는 «복사한 뒤 지웁니다» 안내', R(u2c));
  ok(R(u2c).caps === '서버 기능: 옮기기(MOVE) 없음 · UIDPLUS 있음' && R(u2c).capsTitle === '옮기기(MOVE) 없음 · UIDPLUS 있음' && R(u2c, 'a2').caps === null,
    '…서버 기능 요약(MOVE·UIDPLUS)도 보이고 전체 줄은 풍선 도움말로 — 사용자가 그대로 알려 줄 수 있게', R(u2c));
  const u2d = await show({ a1: { caps: '옮기기(MOVE) 있음 · UIDPLUS 있음 · 용도 표시(SPECIAL-USE) 있음 · IMAP4rev1 MOVE' } });
  ok(R(u2d).caps === null, '…MOVE 있는 서버의 멀쩡한 줄에는 서버 기능을 보이지 않는다', R(u2d));

  console.log('\n[가] 쓸 수 없을 때 · 묻는 중');
  const u3 = await show({ a1: { on: true } }, { ready: false, why: '첫 메일 확인이 끝나면 쓸 수 있습니다.' });
  ok(u3.why === '첫 메일 확인이 끝나면 쓸 수 있습니다.' && R(u3, 'a2').disabled === 'true' && R(u3, 'a2').state === null,
    '까닭은 한 번(#tidy-why) — 꺼진 계정의 스위치는 막힌다', u3);
  ok(R(u3).disabled === 'false' && R(u3).state === '쉬는 중', '…켜진 계정은 «쉬는 중» — 그래도 끌 수는 있다', R(u3));
  ok(R(u3, 'a2').days.every((d) => d.disabled === 'false'), '기간은 꺼진 채로도 고를 수 있다 (켤 때 쓸 값)', R(u3, 'a2').days);
  await clickSwitch('a2');
  await sleep(150);
  ok(setCalls.length === 0 && (await ui()).sets.length === 0, '막힌 스위치를 눌러도 부탁하지 않는다', setCalls);
  const u6 = await show({ a1: { on: true } }, { asking: true, askingId: 'a2' });
  ok(R(u6, 'a2').disabled === 'true' && R(u6, 'a2').busy === 'true' && R(u6, 'a2').days.every((d) => d.disabled === 'true')
    && R(u6).disabled === 'false' && R(u6).days.every((d) => d.disabled === 'true'),
  '메인이 묻는 중이면 꺼진 스위치와 기간 단추를 모든 줄에서 막는다 — 켜진 스위치(끄기)는 눌린다', u6.rows);

  console.log('\n[가] 상태 줄');
  const now = Date.now();
  const line = async (o, top) => R(await show({ a1: { on: true, ...o } }, top)).state;
  ok(await line({ running: true }) === '정리 중…', '도는 중');
  const n0 = statusCalls;
  await show({ a1: { on: true, running: true } }, { running: true, current: 'a1' });
  await sleep(2600);
  ok(statusCalls > n0, '도는 동안은 2초마다 다시 읽는다', { before: n0, after: statusCalls });
  await show({ a1: { on: true } });
  // 그리는 사이 이미 떠난 2초 폴링이 «도는 중»을 한 번 더 그릴 수 있다 — 그 폴링이 끝나기를 기다린 뒤 잰다
  const u9 = await until(async () => { const u = await ui(); return R(u).state === '켜짐 · 다음 자동 백업 뒤 정리' ? u : null; }, 4000);
  ok(!!u9, '켰지만 아직 안 돔', u9 && R(u9).state);
  await sleep(2200);
  const n1 = statusCalls;
  await sleep(2600);
  ok(statusCalls === n1, '끝나면 2초 폴링을 멈춘다 (자동 백업이 꺼진 답이라 더 묻지 않는다)', { before: n1, after: statusCalls });
  ok(await line({ held: true }) === '쉬는 중 — 지난 메일을 받는 동안 이 계정은 정리를 쉽니다', '지난 메일을 받는 동안 쉼');
  ok(await line({ usable: false }) === '계정을 지금 쓸 수 없어 정리하지 않습니다 — 설정 › 메일을 확인하세요',
    '쓸 수 없는 계정(비밀번호 없음·못 풂) — «다음 자동 백업 뒤 정리»라고 하지 않는다');
  ok(await line({ usable: false, held: true, at: now - 60_000, moved: 3 }) === '계정을 지금 쓸 수 없어 정리하지 않습니다 — 설정 › 메일을 확인하세요',
    '…쉼·지난 결과보다 먼저');
  ok(await line({ blocked: '이 폴더는 지움 표시(\\Deleted)를 저장하지 않아 옮기지 않았습니다', held: true }) === '옮기기를 멈춰 정리하지 않습니다',
    '멈춤이 쉼보다 먼저');
  ok(await line({ at: now - 3 * 3600_000 - 60_000, ranDays: 30, moved: 12, kept: 3, unverified: 3 }) === '3시간 전 · 12통 휴지통으로 · 확인 안 된 3통 남김',
    '옮김 — 몇 시간 전·옮긴 수·확인 안 돼 남긴 수 (이름·«서버 정리 ·» 앞머리 없음)');
  ok(await line({ at: now - 2 * DAY - 60_000, ranDays: 30, moved: 2, kept: 7, unsaved: 5, unverified: 2, more: true, skippedBoxes: 1, error: '연결 실패' })
    === '2일 전 · 2통 휴지통으로 · 저장 안 된 5통 남김(«지난 메일 받기» 필요) · 확인 안 된 2통 남김 · 나머지는 다음에 · 폴더 1곳 건너뜀 · 실패: 연결 실패',
  '옮김 — 꼬리 조각을 다 적는다');
  ok(await line({ at: now - 60_000, ranDays: 30, oldest: now - 60_000 - 21 * DAY - 3600_000 }) === '1분 전 · 저장된 메일 중 30일 지난 것 0통 — 가장 오래된 것 21일 전',
    '기간이 안 지남 — 저장된 가장 오래된 메일이 며칠 전인지');
  ok(await line({ at: now - 60_000, ranDays: 30, kept: 1951, unsaved: 1951, oldest: now - 40 * DAY }) === '1분 전 · 30일 지난 메일 1951통이 PC에 없음 — «지난 메일 받기» 필요',
    'PC에 없음 — 몇 통이 저장 안 됐는지 · «지난 메일 받기»');
  ok(await line({ at: now - 60_000, ranDays: 0, days: 0, kept: 1, unsaved: 1 }) === '1분 전 · 읽은 메일 1통이 PC에 없음 — «지난 메일 받기» 필요',
    '…«바로»는 «읽은 메일 n통»');
  ok(await line({ at: now - 60_000, ranDays: 30, spared: 49, important: 49, oldest: now - 90 * DAY }, {}) === '1분 전 · 중요 표시한 49통은 남김',
    '중요 — Gmail 이 아니면 «Gmail이» 없이');
  ok(R(await show({ a2: { on: true, at: now - 60_000, ranDays: 30, spared: 52, important: 49, oldest: now - 90 * DAY } })).state === null
    && R(await ui(), 'a2').state === '1분 전 · Gmail이 중요 표시한 49통은 남김 · 별표 등 3통 남김',
  'Gmail 줄 — «Gmail이 중요 표시한 n통은 남김», 나머지 남김은 «별표 등»');
  ok(await line({ at: now - 2 * 60_000 - 5000, ranDays: 0, days: 0, unread: 2 }) === '2분 전 · 안 읽은 2통은 읽을 때까지 남김',
    '«바로»에서 안 읽은 것만 남았으면 그것이 머리');
  ok(await line({ at: now - 2 * 60_000 - 5000, ranDays: 0, days: 0, moved: 3, unread: 2 }) === '2분 전 · 3통 휴지통으로 · 안 읽은 2통 남김',
    '«바로» — 옮긴 것이 있으면 안 읽은 것은 꼬리 (경고가 아니다)');
  ok(await line({ at: now - 2 * 60_000 - 5000, ranDays: 0, days: 30, moved: 0, unread: 2 }) === '2분 전 · 0통 휴지통으로',
    '«바로»에서 30일로 바꾼 뒤 남은 지난 결과의 unread 는 말하지 않는다 (30일 정리는 안 읽은 메일도 옮긴다)');
  ok(await line({ at: now - 60_000, ranDays: 30, error: '휴지통 폴더를 찾지 못해 정리하지 않았습니다' }) === '1분 전 · 실패: 휴지통 폴더를 찾지 못해 정리하지 않았습니다',
    '실패 — 그 글 그대로');
  ok(await line({ at: now - 60_000, ranDays: 30, oldest: now - 90 * DAY }) === '1분 전 · 0통 휴지통으로', '그 밖 — «0통 휴지통으로»');
  ok(await line({ at: now - 60_000, ranDays: 30, skippedBoxes: 3, unsavedBoxes: 3 })
    === '1분 전 · 0통 휴지통으로 · PC에 저장 기록이 없는 폴더 3곳 건너뜀 — 새 메일이 저장되면 대상이 됩니다',
  'PC 에 저장 기록이 없는 폴더 — 왜 건너뛰었는지와 언제 대상이 되는지');
  ok(await line({ at: now - 60_000, ranDays: 30, skippedBoxes: 3, unsavedBoxes: 2 })
    === '1분 전 · 0통 휴지통으로 · PC에 저장 기록이 없는 폴더 2곳 건너뜀 — 새 메일이 저장되면 대상이 됩니다 · 폴더 1곳 더 건너뜀',
  '…번호가 바뀌었거나 못 읽은 폴더는 따로');
  const uOff = await show({ a1: { on: false, copyAsk: true, at: now - 60_000, error: '이 서버는 옮기기(MOVE)가 없어 복사한 뒤 지웁니다 — 이 방식은 아직 묻지 않아 옮기지 않았습니다' } });
  ok(R(uOff).state === '꺼 둠 — 이 서버는 옮기기(MOVE)가 없어 복사한 뒤 지웁니다. 다시 켜면 그 방식으로 옮길지 묻습니다',
    '옛 설정에서 옮겨 와 꺼 둔 계정 — 꺼진 줄에도 왜 꺼졌는지 말한다', R(uOff).state);
  const uOffCopy = await show({ a1: { on: false, copyAsk: true, copyPath: true, at: now - 60_000 } });
  ok(R(uOffCopy).state === '꺼 둠 — 다시 켜면 이 방식으로 옮길지 묻습니다' && !!R(uOffCopy).copy,
    '…복사 길 안내 줄이 보이면 상태 줄은 같은 말을 되풀이하지 않는다', { state: R(uOffCopy).state, copy: R(uOffCopy).copy });
  const u12 = await show({ a1: { on: false, at: now - 60_000, moved: 4 } });
  ok(R(u12).state === null, '꺼져 있으면 지난 결과를 보이지 않는다', R(u12).state);

  console.log('\n[가] 멈춘 계정 — 까닭과 «다시 해 보기»');
  const why0 = '이 폴더는 지움 표시(\\Deleted)를 저장하지 않아 옮기지 않았습니다';
  const k0 = await show({ a1: { on: false, blocked: why0, copyPath: true } });
  ok(R(k0).stop === `이 서버에서 옮기기를 멈췄습니다 — ${why0}` && !R(k0).daysShown && R(k0).tail === null && R(k0).copy === null
    && R(k0).disabled === 'true' && R(k0).retryLabel === '회사 다시 해 보기' && R(k0).retryDisabled === 'false',
  '멈춘 계정 — 까닭과 «다시 해 보기», 옮기는 때·뜻은 감추고 켜기는 막는다 (꺼진 계정이어도)', R(k0));
  ok(R(k0).state === null, '…꺼져 있으면 상태 줄은 비어 있다', R(k0).state);
  ok(R(k0).describedby.split(' ').includes('tidy-why-a1') && R(k0).described, '…막힌 스위치의 설명에 멈춘 까닭 줄이 이어진다 (왜 못 켜는지 읽힌다)', R(k0).describedby);
  setReply = (req) => {
    if (req && req.retry) { fake('a1').blocked = null; return reply('회사 · 멈춤을 풀었습니다 — 서버 정리를 켜면 다시 옮겨 봅니다.'); }
    return fakeStatus();
  };
  const nr = setCalls.length;
  await js(`document.querySelector('${sel('a1')} .tidystop button').focus()`);
  await clickRetry();
  const k1 = await until(async () => { const u = await ui(); return R(u).stop === null ? u : null; });
  ok(!!k1 && JSON.stringify(setCalls.slice(nr)) === '[{"id":"a1","retry":true}]' && R(k1).daysShown && R(k1).disabled === 'false'
    && k1.msg && k1.msg.kind === 'good' && /멈춤을 풀었습니다/.test(k1.msg.text),
  '«다시 해 보기» → mailTidySet({id, retry:true}) · 풀리면 옮기는 때가 돌아오고 켤 수 있다', { k1, sent: setCalls.slice(nr) });
  ok(!!k1 && R(k1).swFocused, '…누른 단추가 감춰지면 초점은 그 줄의 스위치로 (문서로 빠지지 않는다)', k1 && R(k1).swFocused);
  const k2 = await show({ a1: { on: true, blocked: why0 } });
  ok(R(k2).state === '옮기기를 멈춰 정리하지 않습니다' && R(k2).disabled === 'false' && !!R(k2).stop, '켜진 채 멈춘 계정 — 상태 줄과 까닭, 끄기는 눌린다', R(k2));

  console.log('\n[가] 켜기 — 기다리는 동안·그만두기·받아들이기');
  await show();
  setGate = gate();
  const n2 = setCalls.length;
  await clickSwitch();
  const w1 = await until(async () => { const u = await ui(); return u.msg && u.msg.kind === 'wait' ? u : null; }, 2000);
  ok(!!w1 && w1.msg.text === '회사 · 옮길 메일을 세는 중… (최대 20초)' && R(w1).busy === 'true' && R(w1).disabled === 'true' && R(w1).checked === 'false',
    '켜기를 누르면 미리 칠하지 않고 «회사 · 옮길 메일을 세는 중…»을 보이며 스위치를 잠근다', w1 && { msg: w1.msg, row: R(w1) });
  ok(!!w1 && R(w1, 'a2').disabled === 'true' && R(w1, 'a2').days.every((d) => d.disabled === 'true'), '…다른 줄의 켜기·기간도 잠근다 (확인 창은 한 번에 하나)', w1 && R(w1, 'a2'));
  await clickSwitch();
  await clickSwitch('a2');
  await sleep(100);
  ok(JSON.stringify(setCalls.slice(n2)) === '[{"id":"a1","on":true}]', '기다리는 동안 또 눌러도 다시 부탁하지 않는다 — 부탁은 {id:"a1", on:true} 하나', setCalls.slice(n2));
  setReply = () => reply('그만뒀습니다 — 서버 메일은 그대로입니다.', 'wait');
  setGate.open();
  setGate = null;
  const c1 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; });
  ok(!!c1 && R(c1).checked === 'false' && !R(c1).on && R(c1).busy === 'false' && R(c1).disabled === 'false' && c1.msg.kind === 'wait',
    '확인 창에서 그만두면 꺼진 채 «그만뒀습니다»', c1);
  setReply = () => { fake('a1').on = true; return reply('회사 · 켰습니다 — 1분쯤 뒤부터 옮깁니다. 그 전에 끄면 옮기지 않습니다.'); };
  await clickSwitch();
  const c2 = await until(async () => { const u = await ui(); return R(u).checked === 'true' ? u : null; });
  ok(!!c2 && R(c2).on && c2.msg && c2.msg.kind === 'good' && /^회사 · 켰습니다/.test(c2.msg.text) && R(c2).state === '켜짐 · 다음 자동 백업 뒤 정리'
    && R(c2, 'a2').checked === 'false', '받아들이면 그 줄만 켜지고 언제 시작하는지 알린다', c2);

  console.log('\n[가] 기간');
  setReply = (req) => { fake(req.id).days = req.days; return reply(`회사 · 받은 지 ${req.days}일 지난 메일만 옮기도록 바꿨습니다.`); };
  setGate = gate();
  await js(`document.querySelector('${sel('a1')} [data-days="90"]').focus()`);
  await clickDays(90);
  await sleep(150);
  const d0 = await ui();
  ok(!(d0.msg && /옮길 메일을 세는 중/.test(d0.msg.text)) && R(d0).days.every((d) => d.disabled === 'true'),
    '켜진 채 기간 늘리기(30→90)는 묻지 않으므로 «옮길 메일을 세는 중…»을 보이지 않는다. 답을 기다리는 동안 단추는 잠근다', d0);
  setGate.open();
  setGate = null;
  const d1 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u))) === '["90"]' ? u : null; });
  const focus90 = await js(`document.activeElement === document.querySelector('${sel('a1')} [data-days="90"]')`);
  ok(!!d1 && /받은 지 90일 지난/.test(R(d1).tail) && d1.msg && d1.msg.kind === 'good' && focus90,
    '90일이 눌리고 뜻이 바뀌고, 누른 단추에 초점이 남는다 (줄을 다시 만들지 않는다)', { d1, focus90 });
  ok(JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a1","days":90}', '부탁은 mailTidySet({id:"a1", days:90})', setCalls[setCalls.length - 1]);
  setGate = gate();
  await clickDays(7);
  const d2 = await until(async () => { const u = await ui(); return u.msg && /옮길 메일을 세는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!d2, '켜진 채 기간 줄이기(90→7)는 묻는 일이라 «옮길 메일을 세는 중…»을 보인다', d2);
  setReply = () => reply('그만뒀습니다 — 서버 메일은 그대로입니다.', 'wait');
  setGate.open();
  setGate = null;
  const d3 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; });
  ok(!!d3 && JSON.stringify(pressed(R(d3))) === '["90"]' && JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a1","days":7}',
    '그만두면 90일 그대로 — 미리 칠하지 않았다', { pressed: d3 && pressed(R(d3)), req: setCalls[setCalls.length - 1] });
  const before = setCalls.length;
  await clickDays(90);
  await sleep(150);
  ok(setCalls.length === before && (await ui()).sets.length === before, '이미 고른 기간을 다시 누르면 부탁하지 않는다', setCalls.length);
  // 키보드 — 단추에 초점을 두고 Enter (.mini 는 all: unset 이지만 여전히 <button> 이다)
  setReply = (req) => { fake(req.id).days = req.days; return reply('', ''); };
  await js(`document.querySelector('${sel('a1')} [data-days="30"]').focus()`);
  win.webContents.focus();
  for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
  const d4 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u))) === '["30"]' ? u : null; });
  ok(!!d4 && JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a1","days":30}' && d4.msg === null,
    '키보드(Enter)로도 고른다. 답에 말이 없으면 알림 자리를 비운다', { d4, last: setCalls[setCalls.length - 1] });
  // 다른 줄의 기간은 그 계정으로 간다
  setReply = (req) => { fake(req.id).days = req.days; return reply('Gmail 개인 · 켜면 받은 지 7일 지난 메일부터 옮깁니다.'); };
  await clickDays(7, 'a2');
  const d5 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u, 'a2'))) === '["7"]' ? u : null; });
  ok(!!d5 && JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a2","days":7}' && JSON.stringify(pressed(R(d5))) === '["30"]',
    '다른 줄의 기간 → {id:"a2", days:7}, 회사 줄은 그대로', setCalls[setCalls.length - 1]);

  console.log('\n[가] 기간 줄이기를 기다리는 동안에도 끌 수 있다');
  // 켜진 채 30일 → 7일은 메인이 최대 20초 세고 묻는다. 그 사이 확인 창은 아직 없다 — 그만둘 길은 스위치뿐이다
  setGate = gate();
  offPass = true;
  setReply = (req) => {
    if (req && req.on === false) { fake(req.id).on = false; return reply('회사 · 껐습니다.'); }
    fake(req.id).days = req.days;
    return reply(`회사 · 꺼져 있어 기간만 ${req.days}일로 바꿨습니다.`);
  };
  const nk = setCalls.length;
  await clickDays(7);
  const kk0 = await until(async () => { const u = await ui(); return u.msg && /옮길 메일을 세는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!kk0 && R(kk0).checked === 'true' && R(kk0).disabled === 'false' && R(kk0).days.every((d) => d.disabled === 'true'),
    '기간 줄이기의 답을 기다리는 동안에도 켜진 스위치는 누를 수 있다 (기간 단추는 잠김)', kk0 && R(kk0));
  await clickSwitch();
  const kk1 = await until(async () => { const u = await ui(); return R(u).checked === 'false' ? u : null; }, 2000);
  ok(!!kk1 && JSON.stringify(setCalls.slice(nk)) === '[{"id":"a1","days":7},{"id":"a1","on":false}]' && kk1.msg && /^회사 · 껐습니다/.test(kk1.msg.text),
    '…누르면 기다리지 않고 끄기를 부탁하고, 꺼진다', { kk1, sent: setCalls.slice(nk) });
  ok(!!kk1 && R(kk1).disabled === 'true' && R(kk1).days.every((d) => d.disabled === 'true'),
    '…앞 부탁의 답이 올 때까지 다시 켜기·기간 단추는 잠근 채다', kk1 && R(kk1));
  await clickSwitch();
  await sleep(150);
  ok(setCalls.length === nk + 2, '…그동안 꺼진 스위치를 눌러도 부탁하지 않는다', setCalls.slice(nk));
  setGate.open();
  setGate = null;
  offPass = false;
  const kk2 = await until(async () => { const u = await ui(); return u.msg && /기간만 7일/.test(u.msg.text) ? u : null; });
  ok(!!kk2 && R(kk2).checked === 'false' && JSON.stringify(pressed(R(kk2))) === '["7"]' && R(kk2).disabled === 'false' && R(kk2).days.every((d) => d.disabled === 'false'),
    '앞 부탁의 답이 오면 꺼진 채 기간만 7일 — 다시 누를 수 있다', kk2);

  console.log('\n[가] 끄기·응답 없음');
  await show({ a1: { on: true } });
  setGate = gate();
  setReply = (req) => { fake(req.id).on = false; return reply('회사 · 껐습니다.'); };
  await clickSwitch();
  await sleep(150);
  const o0 = await ui();
  ok(!(o0.msg && /옮길 메일을 세는 중/.test(o0.msg.text)) && R(o0).checked === 'true', '끄기는 묻지 않으므로 «옮길 메일을 세는 중…» 없이 답을 기다린다', o0);
  setGate.open();
  setGate = null;
  const o1 = await until(async () => { const u = await ui(); return R(u).checked === 'false' ? u : null; });
  ok(!!o1 && o1.msg && /^회사 · 껐습니다/.test(o1.msg.text) && JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a1","on":false}',
    '끄면 mailTidySet({id, on:false}) 후 꺼진다', { o1, last: setCalls[setCalls.length - 1] });
  setReply = () => null;
  await clickSwitch();
  const o2 = await until(async () => { const u = await ui(); return u.msg && u.msg.kind === 'bad' ? u : null; });
  ok(!!o2 && /응답이 없습니다/.test(o2.msg.text) && R(o2).checked === 'false' && R(o2).disabled === 'false' && R(o2).busy === 'false',
    '응답이 없으면 «응답이 없습니다» — 스위치는 그대로, 다시 누를 수 있다', o2);
  setReply = () => reply('회사 · 켜지 않았습니다 — 휴지통 폴더를 찾지 못해 정리하지 않았습니다', 'bad');
  await clickSwitch();
  const o3 = await until(async () => { const u = await ui(); return u.msg && /켜지 않았습니다/.test(u.msg.text) ? u : null; });
  ok(!!o3 && o3.msg.kind === 'bad' && R(o3).checked === 'false', '메인이 거절하면 그 까닭을 빨강으로 (확인 창 없이)', o3);

  console.log('\n[가] «바로»(0일)');
  const z0 = R(await show({ a1: { days: 0 } }));
  ok(JSON.stringify(pressed(z0)) === '["0"]' && z0.days.every((d) => d.ghost === (d.d !== '0'))
    && z0.tail === '읽은 메일과 보낸 메일을 약 10분마다 옮깁니다. 안 읽은·별표·중요 메일은 남깁니다.',
  '0일이면 «바로»가 눌리고, 뜻은 메인이 준 실제 주기(everyMin)로 «읽은 메일과 보낸 메일을 약 10분마다» — «0일»이라고 쓰지 않는다', z0);
  const z0b = R(await show({ a1: { days: 0 } }, { everyMin: 30 }));
  ok(/약 30분마다/.test(z0b.tail), '…메일 확인 주기가 30분이면 «약 30분마다»', z0b.tail);
  const z0c = R(await show({ a1: { days: 0 } }, { everyMin: undefined }));
  ok(/새 메일 확인 때마다/.test(z0c.tail) && !/분마다/.test(z0c.tail), '…주기를 모르면 숫자 없이 «새 메일 확인 때마다»', z0c.tail);
  // 켜진 채 30 → 바로: 묻는 일이다 — «옮길 메일을 세는 중…», 미리 칠하지 않는다
  await show({ a1: { on: true, days: 30 } });
  setReply = (req) => { fake(req.id).days = req.days; return reply('바꿨습니다'); };
  setGate = gate();
  const nz = setCalls.length;
  await clickDays(0);
  const z4 = await until(async () => { const u = await ui(); return u.msg && /옮길 메일을 세는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!z4 && JSON.stringify(pressed(R(z4))) === '["30"]' && JSON.stringify(setCalls[nz]) === '{"id":"a1","days":0}',
    '켜진 채 30→바로는 «옮길 메일을 세는 중…» — 부탁은 {id, days:0} (0이 빠지거나 30으로 바뀌지 않는다), 답이 오기 전에는 30일 그대로', { pressed: z4 && pressed(R(z4)), sent: setCalls.slice(nz) });
  setGate.open();
  setGate = null;
  const z5 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u))) === '["0"]' ? u : null; });
  ok(!!z5 && /읽은 메일과 보낸 메일을/.test(R(z5).tail), '…받아들인 답이 오면 «바로»가 눌린다', z5 && R(z5).tail);
  // 바로 → 30 도 묻는다 (안 읽은 오래된 메일까지 옮기게 되므로)
  setGate = gate();
  await clickDays(30);
  const z6 = await until(async () => { const u = await ui(); return u.msg && /옮길 메일을 세는 중/.test(u.msg.text) ? u : null; }, 2000);
  ok(!!z6 && JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a1","days":30}', '켜진 채 바로→30 도 «옮길 메일을 세는 중…»', setCalls.slice(nz));
  setGate.open();
  setGate = null;
  await until(async () => JSON.stringify(pressed(R(await ui()))) === '["30"]');
  // 꺼진 채라면 «바로»도 묻지 않는다
  await show({ a1: { on: false, days: 30 } });
  await clickDays(0);
  await sleep(150);
  const z7 = await ui();
  ok(!(z7.msg && /옮길 메일을 세는 중/.test(z7.msg.text)) && JSON.stringify(setCalls[setCalls.length - 1]) === '{"id":"a1","days":0}',
    '꺼진 채 «바로»를 고르는 것은 묻지 않는다 (켤 때 묻는다)', z7.msg);
  await show();

  console.log('\n[가] 백업 줄·메일 확인하기·setApp');
  const b1 = await show({}, {}, { running: true, waiting: '서버 정리를 멈추는 중 · 끝나면 백업 시작' });
  ok(b1.backupState === '서버 정리를 멈추는 중 · 끝나면 백업 시작', '«백업 시작»이 기다리는 중이면 그 한 줄을 보인다', b1.backupState);
  await show();
  // 도는 중이던 800ms 폴링이 한 번 더 그릴 수 있다 — 가라앉기를 기다린다
  await sleep(2000);
  const e0 = errs.length;
  await js("document.getElementById('btn-backup-start').click()");   // 시험용 다리는 null 을 준다
  await sleep(200);
  const bb2 = await ui();
  ok(errs.length === e0 && bb2.wrap && bb2.backupDir === BACKUP_DIR, '«백업 시작»의 답이 null 이어도 오류 없이 그림을 그대로 둔다', errs.slice(e0));
  const n3 = statusCalls;
  await js("document.getElementById('mailEnabled').click()");
  const n4 = await until(() => statusCalls > n3, 1500);
  const sentOff = await js('(window.__setApp || []).slice(-1)[0]');
  ok(!!n4 && sentOff && sentOff.mailEnabled === false, '«메일 확인하기»를 누르면 setApp 뒤에 상태를 다시 읽는다', { calls: statusCalls - n3, sentOff });
  await js("document.getElementById('mailEnabled').click()");   // 되돌린다
  await sleep(150);
  // 계정이 없으면 칸을 감춘다
  fakeTidy = { ...baseTidy(), accounts: [] };
  ok(!(await repaint()).wrap, '계정이 하나도 없으면 서버 정리 칸을 감춘다');

  console.log('\n[가] 테마');
  await show({ a1: { on: true, at: Date.now() - 60_000, moved: 1 } }, { asking: true });
  const look = () => js(`(() => {
    const c = (el) => getComputedStyle(el);
    const r = document.querySelector('${sel('a1')}');
    const day = r.querySelector('[data-days="7"]');
    const off = document.querySelector('${sel('a2')} .sw');
    return { theme: document.documentElement.getAttribute('data-theme'), state: c(r.querySelector('.tidystate')).color, auto: c(document.getElementById('backup-auto')).color,
      sw: c(off).opacity, day: c(day).opacity, other: c(document.getElementById('mailAutoBackup')).opacity, onSw: c(r.querySelector('.sw')).opacity,
      name: c(r.querySelector('.tidyname')).fontSize };
  })()`);
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  const t1 = await look();
  await js("document.documentElement.setAttribute('data-theme', 'light')");
  const t2 = await look();
  for (const t of [t1, t2]) {
    ok(t.state === t.auto && t.sw === '0.45' && t.day === '0.45' && t.other === '1' && t.onSw === '1' && t.name === '13.5px',
      `${t.theme} — 상태 줄이 위 안내 줄과 같은 색, 막힌 스위치·단추만 0.45, 이름은 13.5px`, t);
  }
  ok(t1.state !== t2.state, '다크와 라이트의 상태 줄 색이 다르다 (테마 이름을 따른다)', [t1.state, t2.state]);
  // 누를 수 없는 기간 단추 — 마우스를 올려도 눌릴 것처럼 반응하지 않는다 (묻는 동안 마우스는 대개 그 단추 위에 있다)
  const hovered = async () => {
    const at = await js(`(() => {
      const b = document.querySelector('${sel('a1')} [data-days="7"]');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await sleep(120);
    const out = await js(`(() => {
      const b = document.querySelector('${sel('a1')} [data-days="7"]');
      const cs = getComputedStyle(b);
      return { theme: document.documentElement.getAttribute('data-theme'), hover: b.matches(':hover'), ghost: b.classList.contains('ghost'),
        disabled: b.getAttribute('aria-disabled'), filter: cs.filter, bg: cs.backgroundColor };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await sleep(60);
    return out;
  };
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    const h = await hovered();
    ok(h.hover && h.ghost && h.disabled === 'true' && h.filter === 'none' && h.bg === 'rgba(0, 0, 0, 0)',
      `${theme} — 막힌 기간 단추는 마우스를 올려도 밝기·바탕이 그대로다`, h);
  }
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  await show();

  // ── [나] 진짜 src/backup.js ────────────────────────
  console.log('\n[나] 진짜 메인 처리기 (src/backup.js)');
  const backupSrc = fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8');
  const nsAsk = /\bpopup\.askUser\(/.test(backupSrc) && !/\{\s*[^}]*\baskUser\b[^}]*\}\s*=\s*require\(/.test(backupSrc);
  ok(nsAsk, 'backup.js 가 확인 창을 popup.askUser(…)로 부른다 — 시험이 바꿔 끼울 수 있다 (안 그러면 진짜 창이 뜬다)');
  ok(typeof store.setTidyAccount === 'function', 'store.setTidyAccount 가 있다 (CORE)');
  let backup = null;
  if (nsAsk && typeof store.setTidyAccount === 'function') {
    ipcMain.removeHandler('mail:backup-status');
    ipcMain.removeHandler('mail:tidy-set');
    backup = require(path.join(ROOT, 'src', 'backup.js'));
  }
  ok(!!backup && typeof backup.setTidy === 'function', 'backup.js 가 setTidy 를 내놓는다 (CORE)');
  if (backup && typeof backup.setTidy === 'function') {
    // 가짜 메일 서버 — 휴지통이 있는 계정 하나. 세기는 이 서버에만 붙는다
    const { makeServer } = require(path.join(ROOT, 'test', 'fixtures', 'fake-imap.js'));
    const V = 1700000000n;
    const server = makeServer({ a1: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [] }, { path: 'Trash', specialUse: '\\Trash', uidValidity: V, msgs: [] }] } });
    mail.connect = (acc) => server.connect(acc);
    const A1 = { id: 'a1', name: '회사', user: 'a1@corp.example', host: 'imap.a1.invalid', port: 993 };
    store.addMailAccount(A1);
    store.setGatedSettings({ mailBackupDir: BACKUP_DIR });
    store.setSettings({ mailEnabled: true, mailAutoBackup: true });
    let allow = true;
    let answer = 1;
    const asks = [];
    popup.askUser = async (_parent, opts) => { asks.push(opts); return answer; };
    backup.init({
      mailAccountsForUse: () => [A1],
      isSettingsWin: (wc) => allow && wc === win.webContents,
      refreshMail: () => {},
      // 켠 뒤 정리가 돌기 전에 시험이 끝난다
      tidyTiming: { START_MS: 3600_000, AGAIN_MS: 3600_000, FIRST_MS: 3600_000 }
    });
    const entry = () => store.settings.mailTidyAccounts.a1 || { on: false, days: 30 };
    await js('window.__tidySet = [];');
    const r0 = await repaint();
    const st0 = await js('window.nunsseom.mailBackupStatus()');
    const missing = TIDY_KEYS.filter((k) => !(st0 && st0.tidy && k in st0.tidy));
    const missingRow = ROW_KEYS.filter((k) => !(st0 && st0.tidy && st0.tidy.accounts && st0.tidy.accounts[0] && k in st0.tidy.accounts[0]));
    ok(!missing.length && !missingRow.length && st0 && 'waiting' in st0, '메인 상태에 화면이 읽는 키가 다 있다 (st.tidy·계정 줄·st.waiting)', { missing, missingRow });
    ok(r0.wrap && r0.rows.length === 1 && R(r0).checked === 'false' && R(r0).disabled === 'false' && JSON.stringify(pressed(R(r0))) === '["30"]' && R(r0).state === null,
      '처음 — 계정 한 줄, 꺼져 있고, 누를 수 있고, 30일', r0);

    answer = 1;
    await clickSwitch();
    const r1 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; }, 25_000);
    ok(!!r1 && R(r1).checked === 'false' && entry().on !== true && asks.length === 1, '그만두기 → 꺼진 채', { r1, asks: asks.length });
    const q = asks[0] || {};
    ok(q.danger === true && q.defaultId === 0 && q.focusId === 1 && Array.isArray(q.buttons)
      && q.buttons[0] === '서버 정리 켜기' && q.buttons[1] === '그만두기' && /^회사 · /.test(q.message || ''),
    '확인 창 — 그 계정 이름으로 묻고, 위험 단추는 빨갛게, 초점은 «그만두기»', { danger: q.danger, focusId: q.focusId, buttons: q.buttons, message: q.message });
    ok(server.clients.length >= 1 && server.clients.every((c) => c.acc === 'a1'), '…세기는 그 계정에만 붙었다', server.clients.map((c) => c.acc));

    answer = 0;
    await clickSwitch();
    const r2 = await until(async () => { const u = await ui(); return R(u).checked === 'true' ? u : null; }, 25_000);
    ok(!!r2 && entry().on === true && r2.msg && r2.msg.kind === 'good' && /^회사 · 켰습니다/.test(r2.msg.text), '서버 정리 켜기 → 켜진다', r2);

    await clickDays(90);
    const r3 = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u))) === '["90"]' ? u : null; }, 10_000);
    ok(!!r3 && entry().days === 90 && asks.length === 2, '켜진 채 30→90일은 묻지 않고 바뀐다', { entry: entry(), asks: asks.length });

    answer = 1;
    await clickDays(7);
    const r4 = await until(async () => { const u = await ui(); return u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; }, 25_000);
    ok(!!r4 && asks.length === 3 && entry().days === 90 && JSON.stringify(pressed(R(r4))) === '["90"]',
      '90→7일은 묻고, 그만두면 90일 그대로', { asks: asks.length, entry: entry() });

    const n5 = (await ui()).sets.length;
    await clickDays(90);
    await sleep(200);
    ok((await ui()).sets.length === n5, '같은 기간을 다시 누르면 부탁하지 않는다');

    await clickSwitch();
    const r5 = await until(async () => { const u = await ui(); return R(u).checked === 'false' ? u : null; }, 10_000);
    ok(!!r5 && entry().on !== true && asks.length === 3 && r5.msg && /^회사 · 껐습니다/.test(r5.msg.text),
      '끄기는 묻지 않는다', { asks: asks.length, msg: r5 && r5.msg });

    allow = false;
    answer = 0;
    await clickSwitch();
    const r6 = await until(async () => { const u = await ui(); return u.msg && /설정 창에서만/.test(u.msg.text) ? u : null; }, 10_000);
    ok(!!r6 && r6.msg.kind === 'bad' && R(r6).checked === 'false' && asks.length === 3 && entry().on !== true,
      '설정 창이 아닌 곳에서 온 켜기는 거절 — 확인 창도 안 띄운다', { msg: r6 && r6.msg, asks: asks.length });

    allow = true;
    await clickSwitch();
    await until(async () => R(await ui()).checked === 'true', 25_000);

    // «바로»(0) — 화면 → preload → mail:tidy-set → setTidy → store → 상태 → 화면까지 0 이 0 으로 간다
    const na = asks.length;
    answer = 1;
    await clickDays(0);
    const b1z = await until(async () => { const u = await ui(); return asks.length > na && u.msg && /그만뒀습니다/.test(u.msg.text) ? u : null; }, 25_000);
    const qz = asks[asks.length - 1] || {};
    ok(!!b1z && entry().days === 90 && JSON.stringify(pressed(R(b1z))) === '["90"]' && qz.title === '서버 정리 — 읽은 메일 바로 옮기기'
      && qz.buttons && qz.buttons[0] === '«바로»로 바꾸기' && qz.focusId === 1,
    '켜진 채 90일→바로는 묻고, 그만두면 90일 그대로', { entry: entry(), title: qz.title, buttons: qz.buttons });
    answer = 0;
    await clickDays(0);
    const b2z = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u))) === '["0"]' ? u : null; }, 25_000);
    const sentZ = (await ui()).sets.filter((x) => x && 'days' in x).slice(-2);
    ok(!!b2z && entry().days === 0 && store.reloadFromDisk().settings.mailTidyAccounts.a1.days === 0 && /^읽은 메일과 보낸 메일을 약 10분마다/.test(R(b2z).tail)
      && JSON.stringify(sentZ) === '[{"id":"a1","days":0},{"id":"a1","days":0}]' && b2z.msg && b2z.msg.kind === 'good',
    '«바로»로 바꾸기 → 메인 설정·디스크까지 0, 화면도 «바로» (30으로 바뀌지 않는다)', { entry: entry(), sent: sentZ, msg: b2z && b2z.msg });
    const nb = asks.length;
    await clickDays(90);
    const b3z = await until(async () => { const u = await ui(); return JSON.stringify(pressed(R(u))) === '["90"]' ? u : null; }, 25_000);
    ok(!!b3z && asks.length === nb + 1 && entry().days === 90 && (asks[asks.length - 1] || {}).title === '서버 정리 — 기간으로 바꾸기',
      '바로→90일도 묻고(«기간으로 바꾸기»), 고르면 90일', { asks: asks.length - nb, entry: entry() });

    // 멈춘 계정 — 화면의 «다시 해 보기»가 진짜 처리기(설정 창의 본 문서인지까지 본다)로 가서 멈춤을 푼다
    const mailmove = require(path.join(ROOT, 'src', 'mailmove.js'));
    await mailmove.journal().block('a1', '시험 까닭');
    const k3 = await repaint();
    ok(R(k3).stop === '이 서버에서 옮기기를 멈췄습니다 — 시험 까닭' && R(k3).state === '옮기기를 멈춰 정리하지 않습니다' && !R(k3).daysShown,
      '일지에 멈춘 계정 — 까닭·«다시 해 보기»가 보이고 옮기는 때는 감춘다', R(k3));
    await clickRetry();
    const k4 = await until(async () => { const u = await ui(); return R(u).stop === null ? u : null; }, 10_000);
    ok(!!k4 && !mailmove.journal().blocked('a1') && k4.msg && k4.msg.kind === 'good' && /^회사 · 멈춤을 풀었습니다/.test(k4.msg.text),
      '«다시 해 보기» → 메인이 멈춤을 풀고 줄이 돌아온다', k4 && { msg: k4.msg, row: R(k4) });

    store.setSettings({ mailAutoBackup: false });
    const r7 = await repaint();
    ok(R(r7).checked === 'false' && R(r7).disabled === 'true' && r7.why === '첫 메일 확인이 끝나면 쓸 수 있습니다.' && entry().on !== true,
      '자동 저장이 꺼지면 모든 계정의 서버 정리가 꺼지고, 스위치가 막히고, 까닭이 보인다 — 숨긴 스위치를 말하지 않는다', r7);
    const n6 = r7.sets.length;
    await clickSwitch();
    await sleep(200);
    ok((await ui()).sets.length === n6, '막힌 스위치를 눌러도 부탁하지 않는다');
    const sent = await js('window.__setApp || []');
    const leak = sent.filter((p) => p && GATED.some((k) => k in p));
    ok(!leak.length, 'setApp 에 서버 정리 키가 한 번도 실리지 않았다', leak);
    ok(server.forbidden().length === 0 && !server.log.some((e) => e.cmd === 'messageMove'), '가짜 서버 — 옮기기·금지 명령 0 (세기만 했다)');
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
  const tidyAsk = { kind: 'dialog', title: '서버 정리 켜기', message: '회사 · 받은 지 30일 지난 메일 약 2통을 서버 휴지통으로 옮깁니다.',
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

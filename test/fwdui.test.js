// 설정 › 메일 › «자동 전달» — 스위치·받는 주소·계정 단추·상태 줄이 메인의 답대로 그려지고, 누르면 메인에 부탁만 하는가.
//
// 자동 전달은 새로 오는 메일을 회사 밖 주소로 보낸다. 켜기·주소 더하기·계정 더하기는 메인이 정확한 주소와 계정을 보여 주고
// 확인 창으로 묻는다 — 화면은 미리 칠하지 않고 mailFwdSet 으로 부탁만 한다. 일반 setApp 으로 새면 확인을 건너뛴다.
// 꺼진 채 적은 주소·고른 계정은 메인에 보내지 않는다 — 메인은 확인 창을 지난 값만 저장하므로 켜는 부탁에 함께 싣는다.
//
// 진짜 settings.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/fwdui-bridge-stub.js 를 쓴다.
// 메일 서버·자격 증명 관리자에는 가지 않는다 (mailhub.js 를 싣지 않고, 메일을 보내는 길도 없다).
//
// [가] 시험이 정한 답 (메인 처리기 자리에 시험용 처리기) — 화면이 상태 모양마다 맞게 그리는가
//   · 메인이 답하기 전과 답이 null(옛 메인)이면 감춰 둔다
//   · 스위치는 role=switch·aria-describedby="fwd-hint fwd-state", 계정 단추는 role=group 안의 aria-pressed,
//     받는 주소와 같은 계정은 aria-disabled 와 까닭(title)
//   · 쓸 수 없으면 스위치가 막히고 까닭 줄이 보이며, 눌러도 부탁하지 않는다
//   · 꺼진 채 주소를 쓰고 계정을 눌러도 부탁하지 않는다 (화면에만 둔다)
//   · 켜기는 {on:true,to,accounts} 한 번 — 기다리는 동안 스위치는 꺼진 채 aria-busy, 두 번 눌러도 한 번.
//     그만두면 꺼진 채 «wait», 받아들이면 칸에 확인된 주소와 «켜짐 · 다음 메일 확인 때 시작»
//   · 형식 오류(%·한글·켈빈 기호)·빈 칸·6개·계정 없음은 부탁하지 않는다
//   · 켜진 채: «바꾸기»·Enter → {to}, 계정 단추 → {accounts}, 스위치 → {on:false} 만. 더하는 것만 «확인 창에서 골라주세요.»
//   · 바꾸기를 기다리는 동안에도 켜진 스위치로 끌 수 있다
//   · 상태 줄 모양 (도는 중·결과·오늘 한도·stale·설정 바뀐 계정·쉬는 중), 응답이 없으면 «응답이 없습니다»
//   · «메일 확인하기»를 누르면 상태를 다시 읽는다. setApp 에 mailForward* 키가 한 번도 없다
//   · 다크·라이트 모두 상태 줄이 안내 줄과 같은 색이고, 누를 수 없는 스위치·단추는 opacity 0.45, 마우스에 반응하지 않는다
// [나] 진짜 src/autofwd.js 처리기 (확인 창 popup.askUser 는 부르면 실패) — 상태 키가 고정 계약과 같고 화면이 그대로 그리는가
// [다] 진짜 renderer/popup.html 을 화면 밖 창에 — 뜬 직후(armMs)의 마우스 클릭은 답이 아니고, 키보드는 받는다
//   (test/fixtures/popup-bridge-stub.js)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwdui-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

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
const clone = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// FwdStatus — 고정 계약 (설계 §3). 화면이 읽는 키와 메인이 주는 키가 같아야 한다
const FWD_KEYS = ['on', 'to', 'accounts', 'ready', 'why', 'stale', 'running', 'asking', 'at', 'sent', 'skipped', 'uncertain',
  'more', 'capped', 'error', 'total', 'max', 'message', 'messageKind'];
const ACC_KEYS = ['id', 'name', 'addr', 'on', 'self', 'enabled', 'changed', 'addrs'];
// 화면이 보내는 부탁의 꼴은 넷뿐이다 — {on:true,to,accounts} · {to} · {accounts} · {on:false}
const shapeOk = (r) => {
  const k = Object.keys(r || {}).sort().join(',');
  return (k === 'accounts,on,to' && r.on === true && Array.isArray(r.to) && Array.isArray(r.accounts))
    || (k === 'to' && Array.isArray(r.to)) || (k === 'accounts' && Array.isArray(r.accounts)) || (k === 'on' && r.on === false);
};

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  // 서버에는 절대 붙지 않는다 — 계정이 늘 비어 있지만 한 겹 더 막는다
  mail.connect = () => { throw new Error('시험: 서버에 붙지 않는다'); };
  const popup = require(path.join(ROOT, 'src', 'popup.js'));
  // 확인 창이 진짜로 뜨면 사용자 모니터에 나온다 — 불리면 바로 실패로 끝낸다
  let asked = 0;
  popup.askUser = async () => { asked++; throw new Error('시험: 진짜 확인 창을 띄우려 했다'); };
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
    settings: { ...store.settings, mailEnabled: true, autoLaunch: false },
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
  // 메일 백업 줄 — 이 시험과 상관없다. 서버 정리(st.tidy)는 주지 않아 감춘 채, 자동 백업은 꺼진 답이라 폴링도 없다
  ipcMain.handle('mail:backup-status', () => ({ running: false, stop: false, account: '', mailbox: '', done: 0, total: 0, saved: 0,
    skipped: 0, message: '', at: 0, dir: '', auto: false, autoAt: 0, autoSaved: 0, autoTotal: 0, autoSeeded: 0, autoError: null, waiting: '' }));

  // ── [가] 시험용 메인 처리기 ───────────────────────
  const acc = (id, name, addr, x = {}) => ({ id, name, addr, on: false, self: false, enabled: true, changed: false, addrs: [addr], ...x });
  const ACCS = () => [acc('a1', '이카운트', 'kim@corp.co.kr'), acc('a2', '네이버', 'kim@naver.com'), acc('a3', 'Gmail', 'kim.ai@gmail.com')];
  const baseFwd = () => ({ on: false, to: [], accounts: ACCS(), ready: true, why: '', stale: false, running: false, asking: false,
    at: 0, sent: 0, skipped: 0, uncertain: 0, more: false, capped: false, error: null, total: 0, max: 5, message: '', messageKind: '' });
  /** 켜진 상태 — ids 가 지문까지 맞는 전달 계정 */
  const onFwd = (to, ids, x = {}) => ({ ...baseFwd(), on: true, to, accounts: ACCS().map((a) => ({ ...a, on: ids.includes(a.id) })), ...x });
  let fakeFwd = baseFwd();
  let fwdNull = false;
  let statusCalls = 0;
  let statusGate = null;
  ipcMain.handle('mail:fwd-status', async () => {
    statusCalls++;
    if (statusGate) await statusGate.promise;
    return fwdNull ? null : { ...clone(fakeFwd), message: '', messageKind: '' };
  });
  const setCalls = [];
  let setGate = null;
  let offPass = false;   // 참이면 끄기 부탁은 문에 걸리지 않고 바로 답한다 (다른 부탁을 붙잡아 둔 채 끄기)
  let setReply = () => clone(fakeFwd);
  ipcMain.handle('mail:fwd-set', async (_e, req) => {
    setCalls.push(clone(req));
    if (setGate && !(offPass && req && req.on === false)) await setGate.promise;
    return setReply(req);
  });
  /** 답 — 시험의 메인 상태를 바꾸고 말을 붙여 돌려준다 */
  const say = (kind, text, change) => () => { if (change) change(); return { ...clone(fakeFwd), message: text, messageKind: kind }; };

  // 계약 모양 자체를 먼저 — 시험의 가짜 답이 고정 계약과 어긋나면 아래 결과는 믿을 수 없다
  ok(same(Object.keys(baseFwd()).sort(), [...FWD_KEYS].sort()) && same(Object.keys(ACCS()[0]).sort(), [...ACC_KEYS].sort()),
    '시험의 가짜 상태가 FwdStatus 고정 계약과 같은 키를 쓴다');

  making = true;
  const win = new BrowserWindow({ show: false, width: 520, height: 900,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'fwdui-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  making = false;
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  const js = (c) => win.webContents.executeJavaScript(c);
  // 페이지를 다시 열 때마다 window.__setApp 이 비워진다 — setApp 에 새지 않았는지는 열 때마다 모아 둔다
  const setAppAll = [];
  const keepSetApp = async () => { setAppAll.push(...((await js('window.__setApp || []')) || [])); };

  const ui = () => js(`(() => {
    const $ = (id) => document.getElementById(id);
    // 화면에 실제로 보이나 — hidden 속성이 아니라 계산된 display 로 본다 (.mini 는 all: unset 이라 CSS 가 없으면 hidden 이어도 보인다)
    const vis = (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const sw = $('mailForwardOn');
    const msg = $('fwd-msg');
    const save = $('btn-fwd-save');
    return {
      sec: vis($('fwd-sec')), group: vis($('fwd-group')),
      role: sw.getAttribute('role'), checked: sw.getAttribute('aria-checked'), on: sw.classList.contains('on'),
      disabled: sw.getAttribute('aria-disabled'), busy: sw.getAttribute('aria-busy'), describedby: sw.getAttribute('aria-describedby'),
      to: $('fwd-to').value, save: vis(save), saveDisabled: save.getAttribute('aria-disabled'),
      accGroup: $('fwd-accs').getAttribute('role'), accBy: $('fwd-accs').getAttribute('aria-labelledby'),
      accs: [...document.querySelectorAll('#fwd-accs button')].map((b) => ({ id: b.dataset.id, t: b.textContent,
        pressed: b.getAttribute('aria-pressed'), ghost: b.classList.contains('ghost'), disabled: b.getAttribute('aria-disabled'),
        title: b.getAttribute('title') || '' })),
      hint: $('fwd-hint').textContent,
      state: vis($('fwd-state')) ? $('fwd-state').textContent : null,
      msg: msg.classList.contains('show')
        ? { text: msg.textContent, kind: ['good', 'bad', 'wait'].find((k) => msg.classList.contains(k)) || '' } : null,
      msgRole: msg.getAttribute('role'),
      sets: (window.__fwdSet || []).slice()
    };
  })()`);
  const pressed = (u) => u.accs.filter((a) => a.pressed === 'true').map((a) => a.id);
  const accOf = (u, id) => u.accs.find((a) => a.id === id) || {};
  const clickSwitch = () => js("document.getElementById('mailForwardOn').click()");
  const clickAcc = (id) => js(`document.querySelector('#fwd-accs [data-id="${id}"]').click()`);
  const clickSave = () => js("document.getElementById('btn-fwd-save').click()");
  /** 받는 주소 칸에 쓴다 — 쓰는 동안 초점이 칸에 있고, 다 쓰면 다른 곳을 누른 것처럼 초점을 뺀다 */
  const typeTo = async (text, { keep = false } = {}) => {
    await js(`(() => { const el = document.getElementById('fwd-to'); el.focus(); el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true })); ${keep ? '' : 'el.blur();'} })()`);
    await sleep(30);
    return ui();
  };
  const enterTo = () => js(`document.getElementById('fwd-to').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  const repaint = async () => { await js('window.nunsSetMail.loadFwd()'); await sleep(50); return ui(); };
  const show = async (t) => { fakeFwd = { ...baseFwd(), ...t }; return repaint(); };
  /** 새로 연 페이지 — 화면에만 있던 것(고치던 칸·꺼진 채 고른 계정)을 버린다 */
  const fresh = async (t) => {
    if (win.webContents.getURL()) await keepSetApp();
    fakeFwd = t;
    const n = statusCalls;
    await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'mail' } });
    await until(() => statusCalls > n);
    return until(async () => { const u = await ui(); return u.group ? u : null; }, 3000);
  };

  console.log('\n[가] 처음 그리기');
  statusGate = gate();
  await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'mail' } });
  await until(() => statusCalls >= 1);
  const u0 = await ui();
  ok(!u0.sec && !u0.group, '메인이 답하기 전에는 자동 전달 칸이 감춰져 있다', u0);
  // 옛 메인 — 자동 전달을 모른다 (답이 null)
  fwdNull = true;
  const g0 = statusGate;
  statusGate = null;
  g0.open();
  await sleep(300);
  const u1 = await ui();
  ok(!u1.sec && !u1.group, '답이 null 이면(옛 메인) 그린 뒤에도 감춘 채다', u1);
  fwdNull = false;
  const u2 = await show({});
  ok(u2.sec && u2.group, '상태가 오면 «자동 전달» 칸이 보인다', u2);
  ok(u2.role === 'switch' && u2.checked === 'false' && !u2.on && u2.disabled === 'false' && u2.describedby === 'fwd-hint fwd-state',
    '스위치 — role=switch · aria-checked=false · 안내·상태 줄과 이어짐', u2);
  ok(u2.accGroup === 'group' && u2.accBy === 'fwd-acc-lbl' && same(u2.accs.map((a) => a.t), ['이카운트', '네이버', 'Gmail'])
    && u2.accs.every((a) => a.pressed === 'true' && !a.ghost && a.disabled === 'false'),
  '보낼 계정 — role=group 안의 계정 단추, 처음엔 켜진 계정 전부가 눌려 있다 (aria-pressed)', u2.accs);
  ok(u2.hint === '켠 뒤 오는 새 메일만 보냅니다 · 주소는 쉼표로 여러 개' && u2.state === null && u2.msg === null && u2.msgRole === 'status'
    && !u2.save && u2.to === '', '안내 한 줄, 상태 줄은 감춤, 알림 자리는 role=status, «바꾸기»는 감춤', u2);

  console.log('\n[가] 쓸 수 없을 때');
  const n0 = setCalls.length;
  const u3 = await show({ ready: false, why: '«메일 확인하기»를 켜야 쓸 수 있습니다.' });
  ok(u3.disabled === 'true' && u3.checked === 'false' && u3.state === '«메일 확인하기»를 켜야 쓸 수 있습니다.',
    '메일 확인이 꺼져 있으면 스위치가 막히고 까닭이 보인다', u3);
  await typeTo('a@gmail.com');
  await clickSwitch();
  await sleep(150);
  ok(setCalls.length === n0 && (await ui()).sets.length === 0, '막힌 스위치를 눌러도 부탁하지 않는다', setCalls.slice(n0));
  const u4 = await show({ ready: false, why: '메일 계정을 먼저 더하세요.', accounts: [] });
  ok(u4.disabled === 'true' && u4.state === '메일 계정을 먼저 더하세요.' && u4.accs.length === 0, '계정이 없으면 막히고 까닭이 보인다 — 계정 단추도 없다', u4);

  console.log('\n[가] 꺼진 채로는 부탁하지 않는다');
  let u = await fresh(baseFwd());
  u = await typeTo('Kim.AI@gmail.com');
  ok(accOf(u, 'a3').disabled === 'true' && accOf(u, 'a3').pressed === 'false' && accOf(u, 'a3').title === '받는 주소와 같은 계정'
    && same(pressed(u), ['a1', 'a2']), '칸에 적은 주소와 같은 계정(Gmail)은 고를 수 없다 — 대소문자 상관없이', u.accs);
  await clickAcc('a2');
  await clickAcc('a3');
  await sleep(50);
  u = await ui();
  ok(same(pressed(u), ['a1']), '꺼진 채 계정 단추를 누르면 화면의 고름만 바뀐다 (막힌 단추는 그대로)', u.accs);
  await js("document.getElementById('fwd-to').focus()");
  await enterTo();
  await sleep(150);
  u = await ui();
  ok(u.sets.length === 0 && setCalls.length === n0, '꺼진 채 주소를 쓰고 계정을 누르고 Enter 를 쳐도 메인에 아무것도 보내지 않는다', u.sets);

  console.log('\n[가] 켜기 — 기다리는 동안·그만두기·받아들이기');
  u = await typeTo('A@Gmail.com');
  ok(accOf(u, 'a3').disabled === 'false' && same(pressed(u), ['a1']), '주소를 바꾸면 Gmail 계정이 풀린다 — 고른 것은 그대로', u.accs);
  await clickAcc('a3');
  setGate = gate();
  await clickSwitch();
  const w1 = await until(async () => { const x = await ui(); return x.msg && x.msg.kind === 'wait' ? x : null; }, 2000);
  ok(!!w1 && w1.msg.text === '확인 창에서 골라주세요.' && w1.checked === 'false' && !w1.on && w1.busy === 'true' && w1.disabled === 'true'
    && w1.accs.every((a) => a.disabled === 'true'),
  '켜기를 누르면 미리 칠하지 않고 «확인 창에서 골라주세요.» — 스위치·계정 단추를 잠근다', w1);
  await clickSwitch();
  await clickAcc('a2');
  await sleep(100);
  ok(setCalls.length === n0 + 1 && same(setCalls[n0], { on: true, to: ['a@gmail.com'], accounts: ['a1', 'a3'] }),
    '부탁은 {on:true, to:[소문자], accounts:[꺼진 채 고른 것]} 한 번 — 기다리는 동안 또 눌러도 다시 부탁하지 않는다', setCalls.slice(n0));
  setReply = say('wait', '그만뒀습니다 — 바뀐 것 없습니다.');
  setGate.open();
  setGate = null;
  const c1 = await until(async () => { const x = await ui(); return x.msg && /그만뒀습니다/.test(x.msg.text) ? x : null; });
  ok(!!c1 && c1.checked === 'false' && !c1.on && c1.busy === 'false' && c1.disabled === 'false' && c1.msg.kind === 'wait'
    && c1.to === 'A@Gmail.com' && same(pressed(c1), ['a1', 'a3']),
  '확인 창에서 그만두면 꺼진 채 «wait» — 적던 주소와 고른 계정은 남는다', c1);
  setReply = (req) => say('good', '켰습니다 — 지금부터 오는 메일을 전달합니다.', () => { fakeFwd = onFwd(req.to, req.accounts); })();
  await clickSwitch();
  const c2 = await until(async () => { const x = await ui(); return x.checked === 'true' ? x : null; });
  ok(!!c2 && c2.on && c2.msg && c2.msg.kind === 'good' && /^켰습니다/.test(c2.msg.text) && c2.to === 'a@gmail.com'
    && c2.state === '켜짐 · 다음 메일 확인 때 시작' && same(pressed(c2), ['a1', 'a3']) && !c2.save,
  '받아들이면 켜지고, 칸에는 메인이 확인한 주소, 상태 줄은 «켜짐 · 다음 메일 확인 때 시작»', c2);
  ok(setCalls.length === n0 + 2 && same(setCalls[n0 + 1], setCalls[n0]), '…다시 누른 부탁도 같은 꼴이다', setCalls.slice(n0));

  console.log('\n[가] 주소 형식 — 부탁하지 않는다');
  await fresh(baseFwd());
  const n1 = setCalls.length;
  const formatCases = [
    ['me%evil.example@relay.com', '주소 형식이 이상합니다 — me%evil.example@relay.com', "'%' 는 받지 않는다 (오래된 중계 서버의 길 바꾸기)"],
    ['홍길동@회사.com', '주소 형식이 이상합니다 — 홍길동@회사.com', '한글 주소'],
    ['Kim@gmail.com', '주소 형식이 이상합니다 — Kim@gmail.com', '켈빈 기호 — 소문자로 바꾸면 영문 k 가 되는 글자'],
    ['a@gmail', '주소 형식이 이상합니다 — a@gmail', '점 없는 도메인'],
    ['   ', '받는 주소를 넣어주세요.', '빈 칸'],
    ['a@x.com, b@x.com; c@x.com d@x.com,e@x.com,f@x.com', '받는 주소는 5개까지입니다.', '6개']
  ];
  for (const [text, want, why] of formatCases) {
    await typeTo(text);
    await clickSwitch();
    const x = await until(async () => { const y = await ui(); return y.msg && y.msg.text === want ? y : null; }, 1500);
    ok(!!x && x.msg.kind === 'bad' && x.checked === 'false', `${why} → «${want}»`, x && x.msg);
  }
  await typeTo('a@gmail.com');
  for (const id of ['a1', 'a2', 'a3']) await clickAcc(id);
  await clickSwitch();
  const x0 = await until(async () => { const y = await ui(); return y.msg && y.msg.text === '보낼 계정을 골라주세요.' ? y : null; }, 1500);
  ok(!!x0 && x0.msg.kind === 'bad' && pressed(x0).length === 0, '계정을 하나도 안 고르면 «보낼 계정을 골라주세요.»', x0 && x0.msg);
  ok(setCalls.length === n1 && (await ui()).sets.length === 0, '…어느 경우에도 메인에 부탁하지 않았다', setCalls.slice(n1));

  console.log('\n[가] 켜진 채 — 바꾸기·계정·끄기');
  fakeFwd = onFwd(['a@gmail.com'], ['a1']);
  u = await fresh(fakeFwd);
  ok(u.to === 'a@gmail.com' && !u.save && same(pressed(u), ['a1']) && u.checked === 'true',
    '켜져 있으면 칸에 확인된 주소, 고른 계정은 메인이 확인한 그대로, «바꾸기»는 감춤', u);
  const n2 = setCalls.length;
  u = await typeTo('a@gmail.com');
  ok(!u.save, '같은 주소로 고치면 «바꾸기»는 감춘 채다', u.save);
  u = await typeTo('a@gmail.com, b@gmail.com');
  ok(u.save && u.saveDisabled === 'false', '다른 주소를 쓰면 «바꾸기»가 보인다', u);
  setGate = gate();
  await clickSave();
  const s1 = await until(async () => { const y = await ui(); return y.msg && y.msg.kind === 'wait' ? y : null; }, 2000);
  ok(!!s1 && s1.msg.text === '확인 창에서 골라주세요.' && s1.saveDisabled === 'true' && same(setCalls[n2], { to: ['a@gmail.com', 'b@gmail.com'] }),
    '주소를 더하는 «바꾸기»는 {to} 하나 — 확인 창을 기다리는 동안 «바꾸기»를 잠근다', { s1, sent: setCalls.slice(n2) });
  await clickSave();
  await sleep(100);
  ok(setCalls.length === n2 + 1, '…기다리는 동안 또 눌러도 다시 부탁하지 않는다', setCalls.slice(n2));
  setReply = (req) => say('good', '바꿨습니다.', () => { fakeFwd = { ...fakeFwd, to: req.to }; })();
  setGate.open();
  setGate = null;
  const s2 = await until(async () => { const y = await ui(); return y.msg && y.msg.text === '바꿨습니다.' ? y : null; });
  ok(!!s2 && s2.to === 'a@gmail.com, b@gmail.com' && !s2.save && s2.msg.kind === 'good', '받아들이면 칸이 확인된 주소로, «바꾸기»는 다시 감춤', s2);
  // 빼기는 묻지 않는다 — «확인 창에서 골라주세요.» 를 보이지 않는다
  await typeTo('b@gmail.com');
  setGate = gate();
  await clickSave();
  await sleep(150);
  const s3 = await ui();
  ok(same(setCalls[n2 + 1], { to: ['b@gmail.com'] }) && !(s3.msg && s3.msg.kind === 'wait'),
    '주소를 빼는 «바꾸기»는 {to} — 묻지 않으므로 «확인 창에서 골라주세요.»를 보이지 않는다', { msg: s3.msg, sent: setCalls.slice(n2) });
  setGate.open();
  setGate = null;
  await until(async () => (await ui()).to === 'b@gmail.com' && !(await ui()).save);
  // Enter 로도 — 그만두면 적던 글이 남는다
  await typeTo('b@gmail.com, c@gmail.com', { keep: true });
  setReply = say('wait', '그만뒀습니다 — 바뀐 것 없습니다.');
  await enterTo();
  const s4 = await until(async () => { const y = await ui(); return y.msg && /그만뒀습니다/.test(y.msg.text) ? y : null; });
  ok(!!s4 && same(setCalls[n2 + 2], { to: ['b@gmail.com', 'c@gmail.com'] }) && s4.to === 'b@gmail.com, c@gmail.com' && s4.save,
    '칸에서 Enter 도 {to} — 그만두면 적던 주소와 «바꾸기»가 남는다', { s4, sent: setCalls.slice(n2) });
  await js("document.getElementById('fwd-to').blur()");
  // 계정 더하기 — 묻는다
  setReply = (req) => say('good', '바꿨습니다.', () => { fakeFwd = onFwd(fakeFwd.to, req.accounts); })();
  setGate = gate();
  await clickAcc('a2');
  const a1 = await until(async () => { const y = await ui(); return y.msg && y.msg.kind === 'wait' ? y : null; }, 2000);
  ok(!!a1 && a1.msg.text === '확인 창에서 골라주세요.' && same(setCalls[n2 + 3], { accounts: ['a1', 'a2'] }) && same(pressed(a1), ['a1']),
    '켜진 채 계정을 더하면 {accounts:[전체]} — «확인 창에서 골라주세요.», 답이 오기 전에는 미리 칠하지 않는다', { a1, sent: setCalls.slice(n2) });
  setGate.open();
  setGate = null;
  await until(async () => same(pressed(await ui()), ['a1', 'a2']));
  // 계정 빼기 — 묻지 않는다
  setGate = gate();
  await clickAcc('a1');
  await sleep(150);
  const a2 = await ui();
  ok(same(setCalls[n2 + 4], { accounts: ['a2'] }) && !(a2.msg && a2.msg.kind === 'wait'), '계정을 빼면 {accounts} — 묻지 않는다', setCalls.slice(n2));
  setGate.open();
  setGate = null;
  await until(async () => same(pressed(await ui()), ['a2']));
  // 끄기
  setReply = say('good', '껐습니다.', () => { fakeFwd = { ...fakeFwd, on: false, accounts: fakeFwd.accounts }; });
  await clickSwitch();
  const o1 = await until(async () => { const y = await ui(); return y.checked === 'false' ? y : null; });
  ok(!!o1 && same(setCalls[n2 + 5], { on: false }) && o1.msg && o1.msg.text === '껐습니다.' && o1.disabled === 'false',
    '끄기는 {on:false} 만 — 꺼진다', { o1, last: setCalls[n2 + 5] });

  console.log('\n[가] 바꾸기를 기다리는 동안에도 끌 수 있다');
  fakeFwd = onFwd(['a@gmail.com'], ['a1']);
  await fresh(fakeFwd);
  const n3 = setCalls.length;
  setGate = gate();
  offPass = true;
  setReply = (req) => (req.on === false
    ? say('good', '껐습니다.', () => { fakeFwd = { ...fakeFwd, on: false }; })()
    : say('wait', '그사이 꺼져 바꾸지 않았습니다.')());
  await clickAcc('a3');
  const k0 = await until(async () => { const y = await ui(); return y.msg && y.msg.kind === 'wait' ? y : null; }, 2000);
  ok(!!k0 && k0.checked === 'true' && k0.disabled === 'false' && k0.accs.every((a) => a.disabled === 'true'),
    '계정 더하기의 확인 창을 기다리는 동안에도 켜진 스위치는 누를 수 있다 (계정 단추는 잠김)', k0);
  await clickSwitch();
  const k1 = await until(async () => { const y = await ui(); return y.checked === 'false' ? y : null; }, 2000);
  ok(!!k1 && same(setCalls.slice(n3), [{ accounts: ['a1', 'a3'] }, { on: false }]) && k1.msg && k1.msg.text === '껐습니다.' && k1.disabled === 'true',
    '…누르면 기다리지 않고 끄기를 부탁하고 꺼진다 — 앞 부탁의 답이 올 때까지 다시 켜기는 잠근다', { k1, sent: setCalls.slice(n3) });
  await clickSwitch();
  await sleep(150);
  ok(setCalls.length === n3 + 2, '…그동안 꺼진 스위치를 눌러도 부탁하지 않는다', setCalls.slice(n3));
  setGate.open();
  setGate = null;
  offPass = false;
  const k2 = await until(async () => { const y = await ui(); return y.msg && /그사이 꺼져/.test(y.msg.text) ? y : null; });
  ok(!!k2 && k2.checked === 'false' && k2.disabled === 'false' && k2.msg.kind === 'wait', '앞 부탁의 답이 오면 «그사이 꺼져…» — 꺼진 채, 다시 누를 수 있다', k2);

  console.log('\n[가] 응답 없음·메인의 거절');
  setReply = () => null;
  await typeTo('a@gmail.com');
  await clickSwitch();
  const r0 = await until(async () => { const y = await ui(); return y.msg && y.msg.kind === 'bad' ? y : null; });
  ok(!!r0 && r0.msg.text === '응답이 없습니다 — 잠시 뒤 다시 눌러주세요.' && r0.checked === 'false' && r0.disabled === 'false' && r0.busy === 'false',
    '응답이 없으면 «응답이 없습니다» — 스위치는 그대로, 다시 누를 수 있다', r0);
  setReply = say('bad', '자동 전달은 설정 창에서만 바꿀 수 있습니다.');
  await clickSwitch();
  const r1 = await until(async () => { const y = await ui(); return y.msg && /설정 창에서만/.test(y.msg.text) ? y : null; });
  ok(!!r1 && r1.msg.kind === 'bad' && r1.checked === 'false', '메인이 거절하면 그 까닭을 빨강으로', r1);

  console.log('\n[가] 계정을 먼저 고른 뒤 그 계정 주소를 받는 주소로 적으면');
  {
    await fresh(baseFwd());
    const n5 = setCalls.length;
    setReply = () => clone(fakeFwd);
    await clickAcc('a2');   // 꺼진 채 고름 — {a1, a3}
    let y = await typeTo('kim.ai@gmail.com');
    ok(accOf(y, 'a3').pressed === 'false' && accOf(y, 'a3').disabled === 'true' && same(pressed(y), ['a1']),
      'a3 을 고른 채 a3 주소를 적으면 a3 은 눌림이 풀리고 막힌다 (눌린 채 막혀 보이지 않는다)', y.accs);
    await clickSwitch();
    await until(() => setCalls.length > n5, 1500);
    ok(setCalls.length === n5 + 1 && same(setCalls[n5], { on: true, to: ['kim.ai@gmail.com'], accounts: ['a1'] }),
      '…켜기 부탁에 받는 주소와 같은 계정(a3)이 실리지 않는다', setCalls.slice(n5));
    // 보내는 주소와 아이디가 다른 계정 — 아이디 주소를 적어도 막는다 (메인 isSelf 와 같게)
    y = await fresh({ ...baseFwd(), accounts: [acc('b1', '별칭', 'alias@corp.co.kr', { addrs: ['alias@corp.co.kr', 'login@corp.co.kr'] }), acc('a2', '네이버', 'kim@naver.com')] });
    y = await typeTo('login@corp.co.kr');
    ok(accOf(y, 'b1').disabled === 'true' && accOf(y, 'b1').title === '받는 주소와 같은 계정' && same(pressed(y), ['a2']),
      '받는 주소가 그 계정의 아이디 주소여도 «받는 주소와 같은 계정»', y.accs);
    // 꺼 둔 계정 — 꺼진 채로는 고를 수 없다 (켜도 보내지 못한다)
    y = await fresh({ ...baseFwd(), accounts: ACCS().map((a) => ({ ...a, enabled: a.id !== 'a2' })) });
    ok(accOf(y, 'a2').disabled === 'true' && accOf(y, 'a2').pressed === 'false' && accOf(y, 'a2').title === '꺼 둔 계정' && same(pressed(y), ['a1', 'a3']),
      '꺼 둔 계정 단추는 막히고 까닭(title)이 붙는다 — 기본 고름에서도 빠진다', y.accs);
    // 켜진 채 전달하던 계정을 나중에 껐다 — 눌러서 뺄 수는 있다
    y = await show(onFwd(['a@gmail.com'], ['a1', 'a2'], { accounts: ACCS().map((a) => ({ ...a, on: a.id !== 'a3', enabled: a.id !== 'a2' })) }));
    ok(accOf(y, 'a2').disabled === 'false' && accOf(y, 'a2').pressed === 'true', '…전달 중인 계정이 꺼지면 눌린 채 — 눌러서 뺄 수 있다', accOf(y, 'a2'));
  }

  console.log('\n[가] 상태 줄');
  const ON = (x) => onFwd(['a@gmail.com'], ['a1'], x);
  const t1 = await show(ON({ running: true }));
  ok(t1.state === '전달 중…', '도는 중', t1.state);
  const sc0 = statusCalls;
  await sleep(2600);
  ok(statusCalls > sc0, '도는 동안은 2초마다 다시 읽는다', { before: sc0, after: statusCalls });
  fakeFwd = ON({});
  const t2 = await until(async () => { const y = await ui(); return y.state === '켜짐 · 다음 메일 확인 때 시작' ? y : null; }, 4000);
  ok(!!t2, '켰지만 아직 안 돔', t2 && t2.state);
  const t3 = await show(ON({ at: Date.now() - 3 * 60_000 - 5000, sent: 2, total: 12, skipped: 1, more: true,
    error: '이카운트: 보내는 서버에 연결하지 못했습니다 (smtp.example.com:465)' }));
  ok(t3.state === '전달 · 3분 전 · 2통 · 켠 뒤 12통 · 건너뜀 1통 · 나머지는 다음에 · 실패: 이카운트: 보내는 서버에 연결하지 못했습니다 (smtp.example.com:465)',
    '결과 — 언제·보낸 수·켠 뒤 모두·건너뜀·남은 것·실패', t3.state);
  const t4 = await show(ON({ at: Date.now() - 60_000 - 5000, sent: 0, total: 300, uncertain: 1, capped: true, more: true }));
  ok(t4.state === '전달 · 1분 전 · 켠 뒤 300통 · 확인 안 됨 1통 · 오늘 한도 · 내일 이어서',
    '오늘 한도 — «나머지는 다음에» 대신 «오늘 한도 · 내일 이어서» (이번에 0통이면 «0통»은 앞세우지 않는다)', t4.state);
  const t4b = await show(ON({ at: Date.now() - 5000, sent: 0, total: 0 }));
  ok(t4b.state === '전달 · 방금', '새 메일이 없던 폴링 — «0통» 없이', t4b.state);
  const t5 = await show(ON({ at: Date.now() - 2 * 3600_000 - 60_000, sent: 1, total: 1,
    accounts: ACCS().map((a) => ({ ...a, on: a.id === 'a1', changed: a.id === 'a2' })) }));
  ok(t5.state === '전달 · 2시간 전 · 1통 · 설정 바뀐 계정 1개 빠짐' && accOf(t5, 'a2').title === '계정 설정이 바뀌어 빠짐 — 다시 누르면 확인합니다'
    && accOf(t5, 'a2').pressed === 'false', '설정이 바뀌어 빠진 계정 — 상태 줄과 그 단추의 까닭', { state: t5.state, a2: accOf(t5, 'a2') });
  const t6 = await show({ ...baseFwd(), on: true, stale: true, to: ['a@gmail.com'] });
  ok(t6.state === '쉬는 중 — 이 PC에서 다시 켜 주세요' && t6.checked === 'true' && t6.disabled === 'false' && pressed(t6).length === 0,
    'stale(이 PC에서 확인 안 된 설정) — «쉬는 중 — 이 PC에서 다시 켜 주세요», 스위치는 눌러 끌 수 있다', t6);
  const t7 = await show(ON({ ready: false, why: '«메일 확인하기»를 켜야 쓸 수 있습니다.' }));
  ok(t7.state === '쉬는 중 — «메일 확인하기»를 켜야 쓸 수 있습니다.' && t7.disabled === 'false', '켜진 채 쓸 수 없으면 «쉬는 중» — 그래도 끌 수 있다', t7);
  const t8 = await show(ON({ asking: true }));
  ok(t8.busy === 'true' && t8.disabled === 'false' && t8.accs.every((a) => a.disabled === 'true'), '메인이 묻는 중이면 계정 단추를 잠근다 — 켜진 스위치는 그대로 끌 수 있다', t8);
  const t9 = await show({ ...baseFwd(), at: Date.now() - 60_000, sent: 4, total: 9 });
  ok(t9.state === null, '꺼져 있으면 지난 결과를 보이지 않는다', t9.state);
  const t10 = await show(onFwd(['kim.ai@gmail.com'], ['a1'], { accounts: ACCS().map((a) => ({ ...a, on: a.id === 'a1', self: a.id === 'a3' })) }));
  ok(accOf(t10, 'a3').disabled === 'true' && accOf(t10, 'a3').title === '받는 주소와 같은 계정' && same(pressed(t10), ['a1']),
    '켜진 채 받는 주소와 같은 계정(self)은 막혀 있다', t10.accs);

  console.log('\n[가] 메일 확인하기·setApp');
  await show(ON({}));
  const sc1 = statusCalls;
  await js("document.getElementById('mailEnabled').click()");
  const sc2 = await until(() => statusCalls > sc1, 1500);
  const sentOff = await js('(window.__setApp || []).slice(-1)[0]');
  ok(!!sc2 && sentOff && sentOff.mailEnabled === false, '«메일 확인하기»를 누르면 setApp 뒤에 자동 전달 상태를 다시 읽는다', { calls: statusCalls - sc1, sentOff });
  await js("document.getElementById('mailEnabled').click()");   // 되돌린다
  await sleep(150);

  console.log('\n[가] 테마');
  await show({ ready: false, why: '«메일 확인하기»를 켜야 쓸 수 있습니다.' });
  const look = () => js(`(() => {
    const c = (id) => getComputedStyle(document.getElementById(id));
    const b = document.querySelector('#fwd-accs [data-id="a2"]');
    b.setAttribute('aria-disabled', 'true');
    const accOp = getComputedStyle(b).opacity;
    b.setAttribute('aria-disabled', 'false');
    const save = document.getElementById('btn-fwd-save');
    save.setAttribute('aria-disabled', 'true');
    const saveOp = getComputedStyle(save).opacity;
    save.setAttribute('aria-disabled', 'false');
    return { theme: document.documentElement.getAttribute('data-theme'), state: c('fwd-state').color, hint: c('fwd-hint').color,
      sw: c('mailForwardOn').opacity, acc: accOp, save: saveOp, other: c('mailAutoBackup').opacity, accOn: getComputedStyle(b).opacity };
  })()`);
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  const th1 = await look();
  await js("document.documentElement.setAttribute('data-theme', 'light')");
  const th2 = await look();
  for (const t of [th1, th2]) {
    ok(t.state === t.hint && t.sw === '0.45' && t.acc === '0.45' && t.save === '0.45' && t.other === '1' && t.accOn === '1',
      `${t.theme} — 상태 줄이 안내 줄과 같은 색, 막힌 스위치·계정 단추·«바꾸기»만 0.45`, t);
  }
  ok(th1.state !== th2.state, '다크와 라이트의 상태 줄 색이 다르다 (테마 이름을 따른다)', [th1.state, th2.state]);
  // 누를 수 없는 계정 단추 — 마우스를 올려도 눌릴 것처럼 반응하지 않는다
  const hovered = async () => {
    const at = await js(`(() => {
      const b = document.querySelector('#fwd-accs [data-id="a2"]');
      b.scrollIntoView({ block: 'center' });
      b.classList.add('ghost');
      b.setAttribute('aria-disabled', 'true');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await sleep(120);
    const out = await js(`(() => {
      const b = document.querySelector('#fwd-accs [data-id="a2"]');
      const cs = getComputedStyle(b);
      return { theme: document.documentElement.getAttribute('data-theme'), hover: b.matches(':hover'), filter: cs.filter, bg: cs.backgroundColor };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await sleep(60);
    return out;
  };
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    const h = await hovered();
    ok(h.hover && h.filter === 'none' && h.bg === 'rgba(0, 0, 0, 0)', `${theme} — 막힌 계정 단추는 마우스를 올려도 밝기·바탕이 그대로다`, h);
  }
  await js("document.documentElement.setAttribute('data-theme', 'dark')");
  await repaint();

  // ── [나] 진짜 src/autofwd.js ───────────────────────
  console.log('\n[나] 진짜 메인 처리기 (src/autofwd.js)');
  const fwdPath = path.join(ROOT, 'src', 'autofwd.js');
  const fwdSrc = fs.existsSync(fwdPath) ? fs.readFileSync(fwdPath, 'utf8') : '';
  const nsAsk = /\bpopup\.askUser\(/.test(fwdSrc) && !/\{\s*[^}]*\baskUser\b[^}]*\}\s*=\s*require\(/.test(fwdSrc);
  ok(!!fwdSrc && nsAsk, 'src/autofwd.js 가 있고 확인 창을 popup.askUser(…)로 부른다 — 시험이 바꿔 끼울 수 있다 (CORE)');
  if (fwdSrc && nsAsk) {
    await keepSetApp();
    ipcMain.removeHandler('mail:fwd-status');
    ipcMain.removeHandler('mail:fwd-set');
    const autofwd = require(fwdPath);
    let allow = true;
    autofwd.init({ mailAccountsForUse: () => [], isSettingsWin: (wc) => allow && wc === win.webContents, machine: () => 'test-pc' });
    store.setSettings({ mailEnabled: false });
    const n4 = (await ui()).sets.length;
    const st0 = await js('window.nunsseom.mailFwdStatus()');
    const keys = Object.keys(st0 || {});
    ok(same([...keys].sort(), [...FWD_KEYS].sort()), '메인 상태의 키가 FwdStatus 고정 계약과 같다', { 빠짐: FWD_KEYS.filter((k) => !keys.includes(k)), 더함: keys.filter((k) => !FWD_KEYS.includes(k)) });
    const v0 = await repaint();
    ok(v0.group && v0.checked === 'false' && v0.disabled === 'true' && v0.state === '«메일 확인하기»를 켜야 쓸 수 있습니다.',
      '메일 확인이 꺼져 있으면 메인의 까닭이 그대로 보이고 스위치가 막힌다', v0);
    store.setSettings({ mailEnabled: true });
    const v1 = await repaint();
    ok(v1.disabled === 'true' && v1.state === '메일 계정을 먼저 더하세요.' && v1.accs.length === 0, '계정이 없으면 «메일 계정을 먼저 더하세요.»', v1);
    await typeTo('a@gmail.com');
    await clickSwitch();
    await sleep(150);
    ok((await ui()).sets.length === n4, '막힌 스위치를 눌러도 부탁하지 않는다');
    // 화면을 거치지 않고 다리로 바로 — 메인이 받는 부탁 꼴을 그대로 읽고 막는다 (확인 창 없이)
    const direct = (req) => js(`window.nunsseom.mailFwdSet(${JSON.stringify(req)}).then((s) => s, (e) => ({ thrown: String(e && e.message) }))`);
    const d1 = await direct({ on: true, to: ['a@gmail.com'], accounts: [] });
    ok(d1 && !d1.thrown && d1.on === false && d1.messageKind === 'bad' && asked === 0 && store.settings.mailForwardOn !== true,
      '계정 없이 켜기 → «bad», 확인 창 없음, 꺼진 채', { d1, asked });
    allow = false;
    const d2 = await direct({ on: true, to: ['a@gmail.com'], accounts: [] });
    // 설정 창이 아닌 곳에는 주소·계정·답 글을 주지 않는다 (키는 같고 값만 비운다 — 설계 §3)
    ok(d2 && !d2.thrown && d2.on === false && same(d2.to, []) && same(d2.accounts, []) && d2.message === '' && asked === 0
      && store.settings.mailForwardOn !== true,
    '설정 창이 아닌 곳에서 온 켜기 → 묻지 않고 꺼진 채, 답은 값을 비운 상태', d2);
    const d3 = await direct({ on: false });
    ok(d3 && d3.on === false && d3.messageKind !== 'bad', '끄기는 어느 창에서나 받는다 (이미 꺼져 있으면 그대로)', d3 && { on: d3.on, kind: d3.messageKind });
    allow = true;
    ok(store.settings.mailForwardOn !== true && same(store.settings.mailForwardTo || [], []) && asked === 0,
      '메인 설정은 그대로 (꺼짐·받는 주소 없음) — 확인 창은 한 번도 안 떴다', { on: store.settings.mailForwardOn, to: store.settings.mailForwardTo, asked });
  }

  // ── [다] 확인 창 (renderer/popup.html) — 뜬 직후의 마우스 클릭 ─────────
  // 스위치를 두 번 누르면 두 번째 클릭이 막 뜬 확인 창의 빨간 «전달 켜기»에 떨어진다 — armMs 동안 마우스 클릭은 답이 아니다.
  // 키보드(detail 0)는 받는다 — 초점은 «그만두기»에 있다
  console.log('\n[다] 확인 창 — 뜬 직후(armMs)의 마우스 클릭은 답이 아니다');
  let popupData = null;
  ipcMain.on('stub:popup', (e) => { e.returnValue = popupData; });
  making = true;
  const pop = new BrowserWindow({ show: false, width: 440, height: 420,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'popup-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  making = false;
  pop.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  const pjs = (c) => pop.webContents.executeJavaScript(c);
  let loadedAt = 0;
  const openPopup = async (d) => {
    popupData = d;
    await pop.loadFile(path.join(ROOT, 'renderer', 'popup.html'), { query: { theme: 'dark', scrim: '0.92', inset: '12' } });
    loadedAt = Date.now();
    return until(() => pjs(`(() => {
      const a = document.activeElement;
      if (!a || !a.classList.contains('btn')) return null;
      return { focus: a.textContent, cls: [...document.querySelectorAll('.btn')].map((b) => [b.textContent, b.className]) };
    })()`), 3000, 20);
  };
  const mouseClick = async (label) => {
    const at = await pjs(`(() => {
      const b = [...document.querySelectorAll('.btn')].find((x) => x.textContent === ${JSON.stringify(label)});
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    for (const type of ['mouseDown', 'mouseUp']) pop.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    return Date.now();
  };
  const picks = () => pjs('window.__pick.slice()');
  const enter = async () => {
    pop.webContents.focus();
    for (const type of ['keyDown', 'char', 'keyUp']) pop.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Enter' });
    return until(async () => { const p = await picks(); return p.length ? p : null; }, 2000);
  };
  const fwdAsk = { kind: 'dialog', title: '자동 전달 켜기', message: '새 메일을 a@gmail.com 으로 전달할까요?',
    detail: '이카운트 · 네이버 계정\n회사 메일이 회사 밖으로 나갑니다.', buttons: ['전달 켜기', '그만두기'],
    defaultId: 0, danger: true, focusId: 1, armMs: 800 };
  const p1 = await openPopup(fwdAsk);
  const red = p1 && p1.cls.find(([t]) => t === '전달 켜기');
  ok(!!p1 && p1.focus === '그만두기' && red && /\bbad\b/.test(red[1]), '처음 초점은 «그만두기», 빨간 칠은 «전달 켜기»', p1);
  const clickedAt = await mouseClick('전달 켜기');
  await sleep(200);
  const pk0 = await picks();
  ok(clickedAt - loadedAt < 600 && pk0.length === 0, '뜨자마자(800ms 안) 빨간 단추를 마우스로 누르면 답이 아니다', { ms: clickedAt - loadedAt, pick: pk0 });
  const pk1 = await enter();
  ok(same(pk1, [1]), '…그대로 Enter 를 누르면 «그만두기»(1)로 답한다 — 막힌 클릭이 초점을 빨간 단추로 옮기지 않았다', pk1);
  await openPopup(fwdAsk);
  await sleep(900);
  await mouseClick('전달 켜기');
  const pk2 = await until(async () => { const p = await picks(); return p.length ? p : null; }, 2000);
  ok(same(pk2, [0]), '900ms 뒤에는 빨간 단추를 마우스로 누르면 «전달 켜기»(0)', pk2);
  const noArm = { ...fwdAsk };
  delete noArm.armMs;
  await openPopup({ ...noArm, title: '서버 정리 켜기', buttons: ['서버 정리 켜기', '그만두기'] });
  await mouseClick('서버 정리 켜기');
  const pk3 = await until(async () => { const p = await picks(); return p.length ? p : null; }, 2000);
  ok(same(pk3, [0]), 'armMs 가 없는 물음(서버 정리 등)은 지금처럼 바로 누른 대로 답한다', pk3);
  pop.destroy();

  // ── 마무리 ───────────────────────────────────────
  await keepSetApp();
  const leak = setAppAll.filter((p) => p && Object.keys(p).some((k) => /^mailForward/.test(k)));
  ok(!leak.length, '화면 전체에서 setApp 에 mailForward* 키가 한 번도 없다', leak);
  const odd = setCalls.filter((r) => !shapeOk(r));
  ok(!odd.length, '메인에 보낸 부탁은 모두 정해진 넷 중 하나의 꼴이다 ({on:true,to,accounts}·{to}·{accounts}·{on:false})', odd);
  ok(!strays.length, '시험 창 말고 다른 창(확인 창 등)이 하나도 안 생겼다', strays);
  ok(errs.length === 0, '콘솔 오류(level 3 이상)가 없다', errs.slice(0, 5));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

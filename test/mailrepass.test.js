// 설정 › 메일 — 비밀번호가 이 PC에서 안 풀리는 계정을 «비밀번호 다시 넣기»로 고친다.
//
// «메일 계정이 등록돼 있는데 갑자기 쓸 수 있는 계정이 없다»는 말을 들었다. 저장된 비밀번호를 이 PC에서
// 못 풀면(윈도우 암호 초기화 등) 계정은 말없이 빠졌고, 설정에는 스위치와 «삭제»뿐이라 지우고 다시 넣는 수밖에
// 없었다 — 그러면 서명과 계정 id에 매인 것이 같이 사라진다.
//
// 진짜 settings.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. 메일 처리기는 진짜 src/mailhub.js 를 싣고, 서버에는 붙지 않게 mail.test 만 바꿔 끼운다.
// 비밀번호는 진짜 Windows 자격 증명 관리자에 둔다 — 다만 'Hibi-test/<임의>/' 아래에만, 시험용 값만 쓰고,
// 끝나면(실패해도) 다 지운 뒤 'Hibi-test/' 아래에 남은 것이 없는지 본다. 남의 항목은 읽지도 지우지도 않는다.
// 데이터 폴더도 임시다.
//   · 못 푸는 계정 줄에 «비밀번호 다시 필요»와 «비밀번호 다시 넣기»가 보이고, 꺼진 계정은 예전 모습 그대로다
//   · 쓸 수 있는 계정이 없으면 목록 맨 위에 까닭과 할 일이 한 줄로 보인다 (메인이 만든 말 그대로)
//   · 단추를 누르면 입력칸이 열리고 초점이 간다. Esc 는 입력만 접고 설정 창은 닫지 않는다
//   · Enter 가 mailRepass({ id, pass }) 를 부른다. 실패하면 그 자리에 까닭이 뜨고 저장된 값은 그대로다
//   · 성공하면 다시 그려져 문제가 사라지고, 새 비밀번호가 잠겨 저장되고, 서명·id 는 그대로다
//   · 기록(evlog)에 비밀번호가 남지 않는다. 폴링 건너뜀 줄에 까닭의 셈이 들어가고, 같은 줄을 되풀이하지 않는다
//   · 이 PC에서 못 잠그면·없는 계정이면 거절한다. 콘솔 오류가 없다
//   · 기다리는 동안 목록을 다시 그려도 칸·결과가 그대로이고, 같은 계정으로 두 번 접속하지 않으며, «삭제»가 막힌다
//   · «취소»에서 Esc 도 입력만 접는다. 확인하는 동안 지워진 계정은 «저장했습니다»라고 하지 않는다
//   · 자격 증명 관리자 — 추가하면 항목이 생기고 설정 파일에는 'wincred:' 표시만 남는다. 다시 넣기는 항목을 덮어쓰고,
//     지우면 항목도 지워진다. 항목이 없어졌거나 옛 값(DPAPI)이 안 풀리면 «저장 불가»가 아니라 «비밀번호 다시 필요»다.
//     옛 값이 풀리면 한 번 옮겨 적는다. 남의 이름을 가리키는 값은 꺼내지 않는다
//   · 잠근 뒤 확인에 실패하면 항목을 해 보기 전 모습으로 돌린다. 지웠는데 설정 저장이 실패하면 항목을 남기고,
//     주인 없는 항목은 시작할 때 치운다(설정 파일을 못 읽으면 안 치운다). 설치본은 시험 앞머리를 받지 않는다
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain } = require('electron');

// 자격 증명 관리자 안의 이름 앞머리 — secret.js 를 싣기 전에 정해야 한다
const NS = `Hibi-test/repass-${crypto.randomBytes(6).toString('hex')}`;
process.env.HIBI_CRED_NS = NS;
const ROOT = path.join(__dirname, '..');
const cred = require(path.join(ROOT, 'src', 'credstore.js'));

/** 이 시험이 쓴 항목을 다 지운다 (남은 것 개수를 준다) — 어떻게 끝나든 부른다 */
function cleanup() {
  try {
    for (const t of cred.list(`${NS}/`)) cred.remove(t);
    return cred.list(`${NS}/`).length;
  } catch { return -1; }
}
const die = (why) => (e) => { console.error(why, (e && e.stack) || e); cleanup(); process.exit(1); };
process.on('uncaughtException', die('시험 터짐:'));
process.on('unhandledRejection', die('시험 약속 깨짐:'));
setTimeout(() => { console.error('시간 초과'); cleanup(); process.exit(1); }, 180_000).unref();
app.on('window-all-closed', () => {});

// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailrepass-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const until = async (fn, ms = 8000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

// 시험용 비밀번호 — 진짜 계정 것이 아니다
const WRONG = 'wrong-pass-7Q';
const RIGHT = 'right-pass-9Z';
const ADDED = 'added-pass-3K';
const AGAIN = 'again-pass-5M';
const LEGACY = 'legacy-pass-8R';
const UPDATED = 'updated-pass-2W';
const FLAKY = 'flaky-pass-6T';

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  const secret = require(path.join(ROOT, 'src', 'secret.js'));
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  evlog.init(tmp);
  evlog.setEnabled(true);
  const logText = () => { evlog.flush(); try { return fs.readFileSync(evlog.file, 'utf8'); } catch { return ''; } };

  // 서버에는 붙지 않는다 — mailhub 가 부르는 mail.test 의 대답을 시험이 정한다
  let answer = () => ({ ok: false, message: '시험: 아직 대답을 안 정했다' });
  const tested = [];
  mail.test = async (acc) => { tested.push({ id: acc.id, host: acc.host, user: acc.user, pass: acc.pass }); return answer(acc); };
  mail.fetchSummary = async () => { throw new Error('시험: 서버에 붙지 않는다'); };

  // 이름 앞머리가 시험용이 아니면 아무것도 쓰지 않고 멈춘다 — 설치본·개발 실행의 항목을 건드리면 안 된다
  if (secret.namespace !== NS || !NS.startsWith('Hibi-test/')) {
    console.error('시험 이름 앞머리가 적용되지 않았다 — 멈춘다', secret.namespace);
    app.exit(1);
    return;
  }
  ok(secret.wincred && cred.available, '자격 증명 관리자를 쓸 수 있다 (시험 전제)');
  ok(secret.available, '비밀번호를 잠가 둘 곳이 있다 — DPAPI 가 막혀도 «저장 불가»가 아니다');
  console.log(`   (이름 앞머리 ${NS})`);
  const targetOf = (id) => `${NS}/mail/${id}`;
  const refOf = (id) => `wincred:${targetOf(id)}`;

  // 옛 방식(safeStorage)은 옮겨 적기를 재려고만 쓴다. 이 PC처럼 DPAPI 가 막혀 있으면(격리된 셸도 그렇다)
  // 옛 값을 만들 수 없으니, 옛 방식 자리에만 시험용 자물쇠를 끼운다 — 자격 증명 관리자 쪽은 진짜 그대로다.
  // DPAPI 가 깨진 PC를 흉내 낼 때는 legacyOff(true) 로 옛 방식을 통째로 끈다.
  if (!secret.legacy.available) {
    console.log('   (이 셸에서는 DPAPI 가 막혀 있다 — 옛 방식 자리에만 시험용 자물쇠를 끼운다)');
    const TAG = 'hibi-test-lock:';
    // 진짜 것처럼 legacy.available 이 거짓이면(legacyOff) 잠그지도 풀지도 않는다
    secret.legacy.seal = (plain) => (plain && secret.legacy.available ? Buffer.from(TAG + plain).toString('base64') : null);
    secret.legacy.open = (sealed) => {
      if (!secret.legacy.available) return null;
      const s = Buffer.from(String(sealed || ''), 'base64').toString('utf8');
      return s.startsWith(TAG) ? s.slice(TAG.length) || null : null;
    };
  }
  const legacyOff = (off) => Object.defineProperty(secret.legacy, 'available', { get: () => !off, configurable: true });
  legacyOff(false);

  // 계정 둘 — «회사»는 이 PC에서 못 푸는 옛 값(다른 PC·다른 키로 잠근 것과 같다), «개인»은 꺼 둠
  store.addMailAccount({
    name: '회사', host: 'imap.corp.invalid', port: 993, user: 'kim@corp.invalid',
    sealed: Buffer.from('이 PC 키로 잠근 것이 아니다').toString('base64'), signature: '<p>김 부장 드림</p>'
  });
  // 같은 ms 에 만들어도 id 가 겹치지 않는다 (예전에는 5ms 를 기다려야 했다)
  store.addMailAccount({ name: '개인', host: 'imap.home.invalid', port: 993, user: 'me@home.invalid' });
  const [corp, home] = store.mailAccounts;
  const homeSealed = secret.seal('home-dummy', home.id);
  store.updateMailAccount(home.id, { enabled: false, sealed: homeSealed });
  const lockedSealed = corp.sealed;
  ok(corp.id !== home.id, '두 계정의 id 가 다르다', [corp.id, home.id]);
  ok(homeSealed === refOf(home.id) && cred.read(targetOf(home.id)) === 'home-dummy',
    '잠그면 자격 증명 관리자에 계정 id 이름으로 들어가고, 설정에는 «wincred:» 표시만 남는다', homeSealed);

  // 진짜 처리기 — mail:get·mail:repass·mail:update 등이 여기서 걸린다
  const mailhub = require(path.join(ROOT, 'src', 'mailhub.js'));

  console.log('\n[메인 — 까닭 가르기와 기록]');
  ok(mailhub.mailAccountsForUse().length === 0, '쓸 수 있는 계정이 없다');
  ok(mailhub.mailAccountProblem(corp.id) === 'locked' && mailhub.mailAccountProblem(home.id) === 'off',
    '«회사»는 locked, «개인»은 off', [mailhub.mailAccountProblem(corp.id), mailhub.mailAccountProblem(home.id)]);
  const why = mailhub.noAccountMessage();
  ok(why === '«회사» 계정의 저장된 비밀번호를 이 PC에서 풀 수 없습니다 — 설정 › 메일에서 «비밀번호 다시 넣기»를 눌러 주세요',
    '할 말 — 켜 둔 계정의 못 풂을 이름과 함께', why);
  ok(mailhub.noAccountMessage(home.id) === '메일 계정이 꺼져 있습니다 (설정 › 메일에서 켜세요)',
    '계정 하나를 두고 물으면 그 계정의 까닭', mailhub.noAccountMessage(home.id));
  ok(/지워졌습니다/.test(mailhub.noAccountMessage('없는-id')), '없는 계정을 두고 물으면 «지워졌습니다»', mailhub.noAccountMessage('없는-id'));

  store.setSettings({ mailEnabled: true });
  for (let i = 0; i < 3; i++) await mailhub.refreshMail();
  const skipLines = logText().split('\n').filter((l) => l.includes('건너뜀 — 쓸 수 있는 계정 없음'));
  ok(skipLines.length === 1 && skipLines[0].endsWith('(저장된 계정 2개 · 비밀번호 못 풂 1 · 꺼짐 1)'),
    '건너뜀 줄에 까닭의 셈이 들어가고, 세 번 건너뛰어도 한 번만 적는다', skipLines);
  ok(mailhub.mailState.blocked === why, '위젯에 실어 보낼 까닭(mailState.blocked)이 같은 말이다', mailhub.mailState.blocked);
  // 뒤에서 부르는 새로고침이 서버 쪽으로 가지 않게 끈다 (fetchSummary 도 막아 뒀다)
  store.setSettings({ mailEnabled: false });

  // ── 설정 창 ───────────────────────────────────────
  const data = {
    settings: { ...store.settings, autoLaunch: false },
    reminders: store.reminders,
    custom: store.custom,
    calendars: [],
    enterCustom: [],
    calendarStatus: {},
    dndPresets: [],
    update: null,
    types: reminders.TYPES.map((t) => ({ id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind, headline: t.headline }))
  };
  ipcMain.on('stub:settings', (e) => { e.returnValue = data; });

  const win = new BrowserWindow({ show: false, width: 420, height: 900,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'settings-mail-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'mail' } });
  const js = (c) => win.webContents.executeJavaScript(c);

  // 화면 상태 — 비밀번호 칸의 값은 «비었나»만 본다
  const state = () => js(`(() => {
    const host = document.getElementById('mail-accounts');
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
    const rows = [...host.querySelectorAll('.rem.acct')].map((r) => {
      const fix = r.nextElementSibling && r.nextElementSibling.classList.contains('acct-fix') ? r.nextElementSibling : null;
      const val = r.querySelector('.val');
      const open = fix && [...fix.querySelectorAll('button')].find((b) => b.textContent === '비밀번호 다시 넣기');
      const form = fix && fix.querySelector('.repass');
      const input = form && form.querySelector('input');
      const msg = fix && fix.querySelector('.msg');
      return {
        name: r.querySelector('.nm').firstChild.textContent,
        cls: r.className, val: val.textContent, valBad: val.classList.contains('bad'),
        fix: !!fix, hint: fix ? fix.querySelector('.hint').textContent : '',
        open: vis(open), expanded: open ? open.getAttribute('aria-expanded') : null,
        form: vis(form), inputEmpty: input ? input.value === '' : null, inputType: input ? input.type : null,
        inputLabel: input ? input.getAttribute('aria-label') : null, inputDisabled: input ? input.disabled : null,
        focusInput: !!input && document.activeElement === input, focusOpen: !!open && document.activeElement === open,
        msg: msg ? msg.textContent : '', msgKind: msg ? ['bad', 'good', 'wait'].find((k) => msg.classList.contains(k)) || '' : '',
        msgShown: vis(msg)
      };
    });
    const note = document.getElementById('mail-acct-msg');
    return { rows, note: note ? note.textContent : null, noteShown: vis(note),
      noteKind: note ? ['bad', 'good', 'wait'].find((k) => note.classList.contains(k)) || '' : '',
      repass: window.__repass.map((r) => ({ id: r.id, pass: r.pass })), closed: window.__closed };
  })()`);
  const row = (s, name) => s.rows.find((r) => r.name === name);
  // 고치는 줄이 없으면 터지지 않고 false — 앞의 검사가 이미 실패를 적었다
  const inputOf = `(document.querySelector('#mail-accounts .rem.acct.need + .acct-fix .repass input'))`;
  const press = (key) => js(`(() => { const i = ${inputOf}; if (!i) return false;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true; })()`);
  const type = (text) => js(`(() => { const i = ${inputOf}; if (!i) return false; i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const clickOpen = () => js(`(() => { const fix = document.querySelector('#mail-accounts .rem.acct.need + .acct-fix');
    const b = fix && [...fix.querySelectorAll('button')].find((x) => x.textContent === '비밀번호 다시 넣기');
    if (!b) return false; b.click(); return true; })()`);

  console.log('\n[못 푸는 계정이 보인다]');
  const s0 = await until(async () => { const s = await state(); return s.rows.length === 2 ? s : null; });
  ok(!!s0, '계정 줄 두 개가 그려진다', s0 ? undefined : await state());
  const c0 = row(s0, '회사');
  const h0 = row(s0, '개인');
  ok(c0 && /\bneed\b/.test(c0.cls) && c0.val === '비밀번호 다시 필요' && c0.valBad,
    '«회사» 줄 — «비밀번호 다시 필요»가 빨강(.bad)으로', c0 && { cls: c0.cls, val: c0.val, bad: c0.valBad });
  ok(c0 && c0.fix && c0.open && c0.expanded === 'false' && !c0.form,
    '«비밀번호 다시 넣기» 단추가 있고 입력칸은 접혀 있다', c0 && { open: c0.open, expanded: c0.expanded, form: c0.form });
  ok(c0 && /풀리지 않습니다/.test(c0.hint) && /서명·설정은 그대로/.test(c0.hint), '아랫줄 설명이 까닭과 고친 뒤 무엇이 남는지 말한다', c0 && c0.hint);
  ok(h0 && /\boff\b/.test(h0.cls) && !/\bneed\b/.test(h0.cls) && h0.val === '' && !h0.fix,
    '꺼진 «개인» 줄은 예전 모습 그대로 (까닭 글자·고치는 줄 없음)', h0 && { cls: h0.cls, val: h0.val, fix: h0.fix });
  ok(s0.noteShown && s0.noteKind === 'bad' && s0.note === why, '목록 맨 위에 메인이 만든 말 그대로 한 줄', { note: s0.note, shown: s0.noteShown });
  const payload = await js('window.nunsseom.mailGet()');
  const leaks = payload.accounts.filter((a) => 'sealed' in a || 'pass' in a);
  ok(!leaks.length && !JSON.stringify(payload).includes(lockedSealed), '화면이 받는 계정에 잠긴 값·비밀번호가 없다');

  console.log('\n[열고 — Esc 로 접는다]');
  await clickOpen();
  const s1 = await state();
  const c1 = row(s1, '회사');
  ok(c1.form && !c1.open && c1.expanded === 'true', '누르면 입력칸이 열린다 (단추는 접히고 aria-expanded=true)', { form: c1.form, open: c1.open, expanded: c1.expanded });
  ok(c1.focusInput && c1.inputType === 'password' && /회사/.test(c1.inputLabel || ''),
    '초점이 비밀번호 칸으로 — 칸 이름(aria-label)에 계정 이름', { focus: c1.focusInput, type: c1.inputType, label: c1.inputLabel });
  await type('지울 것');
  await press('Escape');
  const s2 = await state();
  const c2 = row(s2, '회사');
  ok(!c2.form && c2.open && c2.expanded === 'false' && c2.focusOpen, 'Esc — 입력이 접히고 초점이 단추로 돌아간다', { form: c2.form, open: c2.open, focus: c2.focusOpen });
  ok(s2.closed === 0, 'Esc 가 설정 창까지 닫지 않는다', s2.closed);
  ok(s2.repass.length === 0, 'Esc 는 아무것도 보내지 않는다', s2.repass.length);
  await clickOpen();
  ok(row(await state(), '회사').inputEmpty, '다시 열면 칸이 비어 있다 (접을 때 지운다)');

  console.log('\n[빈 칸 · 틀린 비밀번호]');
  await press('Enter');
  const s3 = await state();
  ok(s3.repass.length === 0 && row(s3, '회사').msgKind === 'bad' && /비밀번호를 넣으세요/.test(row(s3, '회사').msg),
    '빈 칸에서 Enter — 보내지 않고 그 자리에 안내', { sent: s3.repass.length, msg: row(s3, '회사').msg });
  answer = () => ({ ok: false, message: '로그인이 거절됐습니다 — 시험' });
  await type(WRONG);
  await press('Enter');
  const s4 = await until(async () => { const s = await state(); const c = row(s, '회사'); return c && c.msgKind === 'bad' && /거절/.test(c.msg) ? s : null; });
  ok(!!s4, '실패하면 그 자리에 까닭이 빨강으로 뜬다', s4 ? row(s4, '회사').msg : row(await state(), '회사').msg);
  const sent = (s4 || await state()).repass;
  ok(sent.length === 1 && sent[0].id === corp.id && sent[0].pass === WRONG, 'Enter 가 mailRepass({ id, pass }) 를 부른다', sent.map((r) => ({ id: r.id, pass: r.pass === WRONG ? '(입력한 값)' : '(다른 값)' })));
  ok(tested.length === 1 && tested[0].host === 'imap.corp.invalid' && tested[0].user === 'kim@corp.invalid' && tested[0].pass === WRONG,
    '메인은 저장된 서버·아이디에 새 비밀번호로 접속해 본다', tested.map((t) => ({ host: t.host, user: t.user })));
  if (s4) {
    const c4 = row(s4, '회사');
    ok(c4.form && !c4.inputDisabled && /\bneed\b/.test(c4.cls), '입력칸은 열린 채 다시 쓸 수 있고 문제 표시도 그대로', { form: c4.form, disabled: c4.inputDisabled });
  }
  ok(store.mailAccounts.find((a) => a.id === corp.id).sealed === lockedSealed, '틀린 비밀번호는 저장하지 않는다');

  console.log('\n[맞는 비밀번호]');
  answer = () => ({ ok: true, message: '연결됨 · 안 읽은 메일 3통' });
  await type(RIGHT);
  await press('Enter');
  const s5 = await until(async () => { const s = await state(); return s.rows.length === 2 && !s.rows.some((r) => /\bneed\b/.test(r.cls)) ? s : null; });
  ok(!!s5, '다시 그려지고 문제 표시가 사라진다', s5 ? undefined : (await state()).rows.map((r) => ({ name: r.name, cls: r.cls, msg: r.msg })));
  if (s5) {
    const c5 = row(s5, '회사');
    ok(c5.val === '' && !c5.fix && !c5.valBad, '«회사» 줄에 까닭 글자도 고치는 줄도 없다', { val: c5.val, fix: c5.fix });
    ok(s5.noteShown && s5.noteKind === 'good' && s5.note === '비밀번호를 다시 저장했습니다 · 연결됨 · 안 읽은 메일 3통',
      '목록 맨 위에 결과 한 줄 (초록)', { note: s5.note, kind: s5.noteKind });
    ok(s5.repass.length === 2 && s5.repass[1].id === corp.id && s5.repass[1].pass === RIGHT, '두 번째 Enter 가 새 비밀번호로 부른다');
    ok(s5.closed === 0, '설정 창은 그대로 열려 있다');
  }
  const saved = store.mailAccounts.find((a) => a.id === corp.id);
  ok(saved.sealed === refOf(corp.id) && cred.read(targetOf(corp.id)) === RIGHT,
    '새 비밀번호가 자격 증명 관리자에 저장되고, 설정에는 «wincred:» 표시만 남는다', saved.sealed);
  ok(!JSON.stringify(store.reloadFromDisk()).includes(RIGHT), '설정 파일에 비밀번호가 없다');
  ok(saved.signature === '<p>김 부장 드림</p>' && saved.name === '회사' && saved.host === 'imap.corp.invalid',
    '서명·이름·서버는 그대로 (지우고 다시 넣지 않았다)', { signature: saved.signature });
  const disk = (store.reloadFromDisk().mailAccounts || []).find((a) => a.id === corp.id);
  ok(!!disk && disk.sealed === saved.sealed, '파일에도 저장됐다');
  ok(mailhub.mailAccountProblem(corp.id) === null && mailhub.mailAccountsForUse().some((a) => a.id === corp.id),
    '이제 «회사»를 쓸 수 있다');
  const log = logText();
  ok(/비밀번호 다시 넣기 · 회사/.test(log) && /비밀번호 다시 넣기 실패 · 회사/.test(log), '다시 넣기와 실패가 기록에 남는다');
  ok(!log.includes(WRONG) && !log.includes(RIGHT) && !log.includes(saved.sealed), '기록에 비밀번호도 잠긴 값도 없다');

  console.log('\n[거절]');
  const nf = await js(`window.nunsseom.mailRepass({ id: '없는-계정', pass: 'x' })`);
  ok(nf && nf.ok === false && /찾을 수 없습니다/.test(nf.message), '없는 계정이면 거절', nf);
  const before = tested.length;
  const desc = Object.getOwnPropertyDescriptor(secret, 'available');
  Object.defineProperty(secret, 'available', { get: () => false, configurable: true });
  const ns = await js(`window.nunsseom.mailRepass({ id: ${JSON.stringify(corp.id)}, pass: 'x' })`);
  Object.defineProperty(secret, 'available', desc);
  ok(ns && ns.ok === false && ns.message === '이 PC에서는 비밀번호를 안전하게 저장할 수 없습니다' && tested.length === before,
    '이 PC에서 못 잠그면 접속해 보지도 않고 거절', ns);
  const nopass = await js(`window.nunsseom.mailRepass({ id: ${JSON.stringify(corp.id)}, pass: '' })`);
  ok(nopass && nopass.ok === false && tested.length === before, '빈 비밀번호는 메인도 거절', nopass);
  ok(secret.open(store.mailAccounts.find((a) => a.id === corp.id).sealed) === RIGHT, '거절된 요청은 저장된 값을 건드리지 않는다');

  // 느린 서버에서는 접속해 보는 데 1분이 넘는다. 그동안 다른 줄을 켜고 끄면 목록이 통째로 다시 그려져
  // 칸이 접히고 다시 쓸 수 있게 됐고(두 번 보내게 됐고), 먼저 보낸 것의 결과는 떨어져 나간 줄에 적혔다.
  console.log('\n[기다리는 동안 — 다시 그려도 그대로, 두 번 보내지 않는다]');
  store.updateMailAccount(corp.id, { sealed: lockedSealed });   // 다시 못 푸는 상태로
  const toggle = (name) => js(`(() => { const r = [...document.querySelectorAll('#mail-accounts .rem.acct')]
    .find((x) => x.querySelector('.nm').firstChild.textContent === ${JSON.stringify(name)}); r.querySelector('.sw').click(); return true; })()`);
  const delLocked = (name) => js(`(() => { const r = [...document.querySelectorAll('#mail-accounts .rem.acct')]
    .find((x) => x.querySelector('.nm').firstChild.textContent === ${JSON.stringify(name)});
    return [...r.querySelectorAll('button')].find((b) => b.textContent === '삭제').disabled; })()`);
  await toggle('개인');   // 꺼 둔 «개인»을 켜며 다시 그린다 — «회사»가 다시 못 푸는 줄로 나온다
  await until(async () => { const s = await state(); const c = row(s, '회사'); return c && c.fix && !/\boff\b/.test(row(s, '개인').cls); });
  let release = null;
  answer = () => new Promise((r) => { release = r; });
  const n0 = tested.length;
  await clickOpen();
  await type(WRONG);
  await press('Enter');
  await until(() => release);
  ok(await delLocked('회사'), '확인하는 동안 그 계정의 «삭제»가 막힌다');
  await toggle('개인');   // 다른 줄의 스위치 → 목록을 통째로 다시 그린다
  await sleep(300);
  const w1 = row(await state(), '회사');
  ok(w1 && w1.form && !w1.open && w1.inputDisabled && w1.msgKind === 'wait',
    '다른 줄 스위치로 다시 그려도 입력칸은 열린 채 «연결 확인 중»이다', w1 && { form: w1.form, open: w1.open, disabled: w1.inputDisabled, msg: w1.msg });
  await press('Enter');
  const dup = await js(`window.nunsseom.mailRepass({ id: ${JSON.stringify(corp.id)}, pass: 'x' })`);
  ok(tested.length === n0 + 1 && dup && dup.ok === false && /이미 확인 중/.test(dup.message),
    '기다리는 동안 다시 눌러도, 메인에 바로 보내도 같은 계정으로 두 번 접속하지 않는다', { 접속: tested.length - n0, dup });
  release({ ok: false, message: '로그인이 거절됐습니다 — 기다린 뒤' });
  const w2 = await until(async () => { const c = row(await state(), '회사'); return c && /기다린 뒤/.test(c.msg) ? c : null; });
  ok(!!w2 && w2.msgShown && w2.msgKind === 'bad' && !w2.inputDisabled, '먼저 보낸 것의 결과가 지금 보이는 줄에 뜨고 칸이 풀린다',
    w2 || row(await state(), '회사'));
  ok(!(await delLocked('회사')), '끝나면 «삭제»가 풀린다');

  console.log('\n[«취소»에서 Esc · 확인 중에 지워진 계정]');
  await js(`(() => { const f = document.querySelector('#mail-accounts .rem.acct.need + .acct-fix');
    const c = [...f.querySelectorAll('button')].find((b) => b.textContent === '취소'); c.focus();
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); })()`);
  const e1 = await state();
  ok(!row(e1, '회사').form && row(e1, '회사').inputEmpty && e1.closed === 0,
    '«취소»에 초점이 있을 때 Esc 도 입력만 접고(칸을 비우고) 설정 창은 닫지 않는다', { form: row(e1, '회사').form, closed: e1.closed });
  release = null;
  answer = () => new Promise((r) => { release = r; });
  const pDel = js(`window.nunsseom.mailRepass({ id: ${JSON.stringify(corp.id)}, pass: ${JSON.stringify(RIGHT)} })`);
  await until(() => release);
  store.removeMailAccount(corp.id);
  release({ ok: true, message: '연결됨' });
  const rDel = await pDel;
  ok(rDel && rDel.ok === false && /지워졌습니다/.test(rDel.message) && !store.mailAccounts.some((a) => a.id === corp.id),
    '확인하는 동안 지워진 계정은 «저장했습니다»라고 하지 않고 되살리지도 않는다', rDel);
  const log2 = logText();
  ok(/비밀번호 다시 넣기 취소 · 회사/.test(log2) && !log2.includes(WRONG) && !log2.includes(RIGHT), '취소가 기록에 남고 비밀번호는 없다');

  // ── 자격 증명 관리자 ─────────────────────────────
  // 여기부터는 IPC 로 부른다 (화면은 다시 그리지 않는다). 뒤에서 서버로 가지 않게 메일 확인은 꺼 둔다.
  const acct = (id) => store.mailAccounts.find((a) => a.id === id);
  const byName = (name) => store.mailAccounts.find((a) => a.name === name);
  const invoke = (fn, ...args) => js(`window.nunsseom.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
  const hasTarget = (id) => cred.list(`${NS}/mail/`).includes(targetOf(id));

  console.log('\n[자격 증명 관리자 — 추가]');
  store.setSettings({ mailEnabled: false });
  answer = () => ({ ok: true, message: '연결됨 · 시험' });
  const nBefore = store.mailAccounts.length;
  // 화면이 id·잠긴 값을 섞어 보내도 메인이 정한다
  const added = await invoke('mailAdd', { name: '새 계정', provider: 'custom', host: 'imap.new.invalid', port: 993,
    user: 'new@new.invalid', pass: ADDED, id: 'hijack', sealed: 'wincred:zz-not-hibi' });
  store.setSettings({ mailEnabled: false });   // 추가가 켜 둔 메일 확인을 다시 끈다
  const fresh = byName('새 계정') || { id: '(없음)' };
  ok(added && added.ok === true && store.mailAccounts.length === nBefore + 1, '추가된다', added && added.message);
  ok(fresh.id !== 'hijack' && fresh.sealed === refOf(fresh.id),
    '계정 id 는 메인이 정하고, 설정에는 그 id 의 «wincred:» 표시만 남는다', { id: fresh.id, sealed: fresh.sealed });
  ok(cred.read(targetOf(fresh.id)) === ADDED, '자격 증명 관리자에 그 이름으로 비밀번호가 들어 있다');
  const disk1 = store.reloadFromDisk();
  const d1 = (disk1.mailAccounts || []).find((a) => a.id === fresh.id);
  ok(!!d1 && d1.sealed === fresh.sealed && !JSON.stringify(disk1).includes(ADDED), '파일에는 표시만 있고 비밀번호는 없다');
  const ui1 = added && (added.accounts || []).find((a) => a.id === fresh.id);
  ok(!!ui1 && ui1.hasPassword && ui1.problem === null && !('sealed' in ui1) && !('pass' in ui1),
    '화면에는 «비밀번호 있음»과 까닭 없음만 간다', ui1 && { has: ui1.hasPassword, problem: ui1.problem });
  ok(mailhub.mailAccountProblem(fresh.id) === null, '바로 쓸 수 있다');

  // 2560바이트가 넘는 비밀번호는 자격 증명 관리자가 받지 않는다. 옛 방식도 끄면 잠글 곳이 없다
  legacyOff(true);
  const nb = store.mailAccounts.length;
  const refused = await invoke('mailAdd', { name: '못 잠금', host: 'imap.x.invalid', port: 993, user: 'x@x.invalid', pass: 'z'.repeat(3000) });
  legacyOff(false);
  store.setSettings({ mailEnabled: false });
  ok(refused && refused.ok === false && /저장하지 못했습니다/.test(refused.message) && store.mailAccounts.length === nb
    && !byName('못 잠금'), '잠그지 못하면 계정을 만들지 않는다 («비밀번호 없는 계정»이 남지 않는다)', refused && refused.message);

  console.log('\n[자격 증명 관리자 — 다시 넣기 · 설정에서 바꾸기]');
  const r2 = await invoke('mailRepass', { id: fresh.id, pass: AGAIN });
  ok(r2 && r2.ok && r2.saved, '다시 넣기가 된다', r2 && r2.message);
  ok(cred.read(targetOf(fresh.id)) === AGAIN && (acct(fresh.id) || {}).sealed === refOf(fresh.id),
    '다시 넣기는 같은 항목을 덮어쓴다 (설정의 표시는 그대로)');
  ok(cred.list(`${NS}/mail/`).filter((t) => t === targetOf(fresh.id)).length === 1, '그 계정의 항목은 하나뿐이다');
  await invoke('mailUpdate', fresh.id, { pass: UPDATED, sealed: 'wincred:zz-not-hibi', id: 'm-other' });
  const f2 = acct(fresh.id) || {};
  ok(f2.sealed === refOf(fresh.id) && cred.read(targetOf(fresh.id)) === UPDATED && !('pass' in f2) && !acct('m-other'),
    '설정에서 비밀번호를 바꿔도 같은 항목이 바뀐다 — 화면이 보낸 잠긴 값·id 는 무시', f2.sealed);

  console.log('\n[항목이 없어지면 — «비밀번호 다시 필요»]');
  cred.remove(targetOf(fresh.id));   // 누가 자격 증명 관리자에서 지웠다
  ok(mailhub.mailAccountProblem(fresh.id) === 'locked', '항목이 없으면 locked (저장 불가가 아니다)', mailhub.mailAccountProblem(fresh.id));
  const g1 = await invoke('mailGet');
  const u1 = g1.accounts.find((a) => a.id === fresh.id) || {};
  ok(g1.status.canStore && u1.problem === 'locked' && u1.canRepass && u1.problemText === '비밀번호 다시 필요',
    '화면에 «비밀번호 다시 필요»와 «비밀번호 다시 넣기»가 나온다', { problem: u1.problem, canRepass: u1.canRepass, text: u1.problemText });
  const r3 = await invoke('mailRepass', { id: fresh.id, pass: AGAIN });
  ok(r3 && r3.ok && cred.read(targetOf(fresh.id)) === AGAIN && mailhub.mailAccountProblem(fresh.id) === null,
    '다시 넣으면 항목이 새로 생기고 쓸 수 있다', r3 && r3.message);

  console.log('\n[DPAPI 가 깨진 PC — 옛 값이 안 풀려도 «저장 불가»가 아니다]');
  legacyOff(true);
  store.addMailAccount({ name: '옛 계정', host: 'imap.old.invalid', port: 993, user: 'old@old.invalid',
    sealed: Buffer.from('옛 DPAPI 값 — 이 PC에서 못 푼다').toString('base64') });
  const old1 = byName('옛 계정');
  ok(mailhub.mailAccountProblem(old1.id) === 'locked', '옛 값이 안 풀리면 locked', mailhub.mailAccountProblem(old1.id));
  const g2 = await invoke('mailGet');
  ok(g2.status.canStore && g2.accounts.every((a) => a.problem !== 'nostore'), '어느 계정도 «저장 불가»가 아니다',
    g2.accounts.map((a) => a.problem));
  ok((g2.accounts.find((a) => a.id === old1.id) || {}).canRepass === true, '«비밀번호 다시 넣기»를 낸다');
  ok(/비밀번호 옮기기 못 함 · 옛 계정 · 예전 방식\(DPAPI\)/.test(logText()), '옮기지 못한 까닭이 기록에 남는다');
  const r4 = await invoke('mailRepass', { id: old1.id, pass: AGAIN });
  ok(r4 && r4.ok && (acct(old1.id) || {}).sealed === refOf(old1.id) && cred.read(targetOf(old1.id)) === AGAIN
    && mailhub.mailAccountProblem(old1.id) === null, 'DPAPI 없이도 다시 넣으면 자격 증명 관리자에 저장되고 쓸 수 있다', r4 && r4.message);
  legacyOff(false);

  console.log('\n[옛 값이 풀리면 — 자격 증명 관리자로 한 번 옮긴다]');
  const legacyOn = secret.legacy.seal(LEGACY);
  const legacyOffAcct = secret.legacy.seal(`${LEGACY}-off`);
  ok(secret.isLegacy(legacyOn) && secret.open(legacyOn) === LEGACY, '옛 방식으로 잠근 값 (시험 전제)');
  const movedBefore = logText().split('\n').filter((l) => l.includes('비밀번호 옮김 ·')).length;
  store.addMailAccount({ name: '옮길 계정', host: 'imap.mig.invalid', port: 993, user: 'mig@mig.invalid', sealed: legacyOn });
  store.addMailAccount({ name: '꺼 둔 옛 계정', host: 'imap.mig2.invalid', port: 993, user: 'mig2@mig.invalid', sealed: legacyOffAcct });
  const mig = byName('옮길 계정');
  const migOff = byName('꺼 둔 옛 계정');
  store.updateMailAccount(migOff.id, { enabled: false });
  ok(mailhub.mailAccountProblem(mig.id) === null, '옛 값이 풀리는 계정은 쓸 수 있다');
  ok((acct(mig.id) || {}).sealed === refOf(mig.id) && cred.read(targetOf(mig.id)) === LEGACY,
    '자격 증명 관리자로 옮겨지고, 설정에는 표시만 남는다', (acct(mig.id) || {}).sealed);
  ok((acct(migOff.id) || {}).sealed === refOf(migOff.id) && cred.read(targetOf(migOff.id)) === `${LEGACY}-off`
    && mailhub.mailAccountProblem(migOff.id) === 'off', '꺼 둔 계정도 옮긴다 (켰을 때는 DPAPI 가 이미 깨졌을 수 있다)');
  const disk2 = store.reloadFromDisk();
  ok(!JSON.stringify(disk2).includes(legacyOn) && !JSON.stringify(disk2).includes(LEGACY)
    && (disk2.mailAccounts || []).find((a) => a.id === mig.id).sealed === refOf(mig.id), '파일의 옛 값도 표시로 바뀌었다');
  for (let i = 0; i < 3; i++) mailhub.mailAccountProblems();
  const moved = logText().split('\n').filter((l) => l.includes('비밀번호 옮김 ·')).length - movedBefore;
  ok(moved === 2, '계정마다 한 번씩만 옮기고 기록한다', moved);
  ok(/비밀번호 옮김 · 옮길 계정 · Windows 자격 증명 관리자로/.test(logText()), '기록 — «비밀번호 옮김 · 옮길 계정 · Windows 자격 증명 관리자로»');

  console.log('\n[남의 이름을 가리키는 값]');
  // 있을 리 없는 이름만 쓴다 — 가드가 부르기 전에 막는지만 본다
  const other = `Hibi-test/other-${crypto.randomBytes(4).toString('hex')}/mail/x`;
  store.addMailAccount({ name: '다른 앞머리', host: 'imap.o.invalid', port: 993, user: 'o@o.invalid', sealed: `wincred:${other}` });
  store.addMailAccount({ name: '남의 이름', host: 'imap.p.invalid', port: 993, user: 'p@p.invalid', sealed: 'wincred:zz-not-hibi-entry' });
  ok(mailhub.mailAccountProblem(byName('다른 앞머리').id) === 'locked' && mailhub.mailAccountProblem(byName('남의 이름').id) === 'locked',
    '이 실행의 앞머리가 아닌 항목은 꺼내지 않는다 — locked');
  ok(secret.open(`wincred:${other}`) === null && secret.remove(`wincred:${other}`) === false, 'secret 도 꺼내지도 지우지도 않는다');
  store.removeMailAccount(byName('다른 앞머리').id);
  store.removeMailAccount(byName('남의 이름').id);

  console.log('\n[지우기]');
  await invoke('mailRemove', fresh.id);
  ok(!acct(fresh.id) && cred.read(targetOf(fresh.id)) === null && !hasTarget(fresh.id), '계정을 지우면 자격 증명 관리자의 항목도 지워진다');
  ok(cred.read(targetOf(mig.id)) === LEGACY, '다른 계정의 항목은 그대로');
  cred.remove(targetOf(old1.id));   // 항목이 이미 없는 계정을 지워도
  await invoke('mailRemove', old1.id);
  ok(!acct(old1.id) && !/지우지 못함 · 옛 계정|옛 계정 · 자격 증명 관리자의 비밀번호를 지우지 못함/.test(logText()),
    '항목이 이미 없어도 지우기는 조용히 끝난다 (실패로 적지 않는다)');
  const log3 = logText();
  ok(![ADDED, AGAIN, UPDATED, LEGACY, WRONG, RIGHT].some((v) => log3.includes(v)), '기록에 시험 비밀번호가 하나도 없다');

  console.log('\n[잠근 뒤 확인에 실패하면 — 해 보기 전 모습으로]');
  // 쓰기는 됐는데 읽어 보기가 새 값을 못 돌려주는 경우를 만든다 — 자격 증명 관리자에 쓰고 지우는 것은 진짜 그대로다.
  // 옛 방식으로 빠지지 않게 끈다 (그러면 seal 이 실패로 끝난다)
  const realRead = cred.read;
  cred.read = (t) => { const v = realRead(t); return v === FLAKY ? null : v; };
  legacyOff(true);
  try {
    await invoke('mailUpdate', mig.id, { pass: FLAKY });
    ok((acct(mig.id) || {}).sealed === refOf(mig.id) && realRead(targetOf(mig.id)) === LEGACY,
      '설정에서 바꾸기 — 못 잠그면 항목도 예전 비밀번호 그대로 (시험하지 않은 새 값이 남지 않는다)');
    const r5 = await invoke('mailRepass', { id: mig.id, pass: FLAKY });
    ok(r5 && r5.ok === false && /잠그지 못했습니다/.test(r5.message) && realRead(targetOf(mig.id)) === LEGACY,
      '다시 넣기 — «잠그지 못했습니다»이고 항목은 예전 비밀번호 그대로', r5 && r5.message);
    const nAcct = store.mailAccounts.length;
    const nCred = cred.list(`${NS}/mail/`).length;
    const r6 = await invoke('mailAdd', { name: '확인 실패', host: 'imap.f.invalid', port: 993, user: 'f@f.invalid', pass: FLAKY });
    store.setSettings({ mailEnabled: false });
    ok(r6 && r6.ok === false && store.mailAccounts.length === nAcct && cred.list(`${NS}/mail/`).length === nCred,
      '추가 — 계정을 만들지 않고, 써 둔 항목도 지운다 (가리키는 계정 없는 비밀번호가 남지 않는다)', r6 && r6.message);
  } finally {
    cred.read = realRead;
    legacyOff(false);
  }
  ok(!logText().includes(FLAKY), '기록에 비밀번호가 없다');

  console.log('\n[지웠는데 설정 저장이 실패하면 — 항목은 남기고, 파일에서 빠진 뒤 시작할 때 치운다]');
  const settingsFile = path.join(tmp, 'Hibi', 'nunsseom.json');
  const orphan = `${NS}/mail/m-orphan-${crypto.randomBytes(3).toString('hex')}`;
  ok(cred.write(orphan, 'orphan-dummy'), '가리키는 계정이 없는 항목 하나 (계정을 추가하다 죽은 흔적)');
  // 설정 파일 자리를 폴더로 바꿔 저장이 실패하게 한다
  console.log('   (아래 «store save failed» 는 일부러 낸 것이다)');
  fs.rmSync(settingsFile, { force: true });
  fs.mkdirSync(settingsFile);
  try {
    await invoke('mailRemove', migOff.id);
    ok(!acct(migOff.id) && cred.read(targetOf(migOff.id)) === `${LEGACY}-off`,
      '설정 파일에서 못 빠졌으면 자격 증명 관리자의 항목은 지우지 않는다 (다음 실행에 «비밀번호 다시 필요»로 되살아나지 않게)');
    ok(/꺼 둔 옛 계정 · 설정 파일에 저장되지 않아 자격 증명 관리자의 비밀번호는 남겨 둠/.test(logText()), '남겨 둔 까닭이 기록에 남는다');
    const nHeld = cred.list(`${NS}/mail/`).length;
    mailhub.sweepPasswords();
    ok(cred.list(`${NS}/mail/`).length === nHeld && cred.list(`${NS}/mail/`).includes(orphan) && hasTarget(migOff.id),
      '설정 파일을 못 읽으면 치우지 않는다 (빈 설정을 믿고 멀쩡한 비밀번호를 지우지 않게)');
  } finally {
    fs.rmSync(settingsFile, { recursive: true, force: true });
    store.setSettings({ mailEnabled: false });   // 다시 저장한다 — 이제 파일에서도 빠진다
  }
  ok(!store.reloadFromDisk().unreadable && !(store.reloadFromDisk().mailAccounts || []).some((a) => a.id === migOff.id),
    '다시 저장하니 파일에서도 빠졌다');
  // 치울 거리 — 설정의 어느 계정도 가리키지 않는 항목 (앞에서 설정에서만 뺀 «회사» 것도 여기 든다)
  const kept = new Set(store.mailAccounts.map((a) => a.sealed));
  const strays = cred.list(`${NS}/mail/`).filter((t) => !kept.has(`wincred:${t}`));
  ok(strays.includes(orphan) && strays.includes(targetOf(migOff.id)), '치울 거리에 주인 없는 것과 지우다 남긴 것이 있다', strays.length);
  mailhub.sweepPasswords();
  const after = cred.list(`${NS}/mail/`);
  ok(strays.every((t) => !after.includes(t)), '시작할 때 치우기 — 설정에 없는 항목을 지운다', after.length);
  ok(store.mailAccounts.filter((a) => secret.isRef(a.sealed)).every((a) => after.includes(secret.targetOf(a.sealed)))
    && cred.read(targetOf(mig.id)) === LEGACY, '설정에 있는 계정의 항목은 그대로');
  const log4 = logText();
  ok(log4.includes(`주인 없는 비밀번호 항목 ${strays.length}개를 자격 증명 관리자에서 지움`)
    && !log4.includes('orphan-dummy') && !log4.includes(orphan), '기록에는 개수만 남는다');
  mailhub.sweepPasswords();
  ok(logText().split('\n').filter((l) => l.includes('주인 없는 비밀번호 항목')).length === 1, '치울 것이 없으면 기록하지 않는다');

  console.log('\n[이름 앞머리 — 시험 변수는 개발 실행에서만]');
  // 값만 읽는다 — 이 블록은 기다리지 않고 한 번에 돈다 (그 사이 다른 코드가 자격 증명 관리자를 부르지 못한다)
  const pkgDesc = Object.getOwnPropertyDescriptor(app, 'isPackaged');
  let pkgNs = null;
  try {
    Object.defineProperty(app, 'isPackaged', { get: () => true, configurable: true });
    pkgNs = secret.namespace;
  } catch (e) {
    pkgNs = `(설치본 흉내를 못 냄: ${e.message})`;
  } finally {
    if (pkgDesc) Object.defineProperty(app, 'isPackaged', pkgDesc);
    else delete app.isPackaged;
  }
  ok(pkgNs === 'Hibi', '설치본은 HIBI_CRED_NS 가 있어도 «Hibi»를 쓴다 (시험 뒷정리에 진짜 비밀번호가 지워지지 않게)', pkgNs);
  delete process.env.HIBI_CRED_NS;
  const devNs = secret.namespace;
  const devSweep = secret.sweepable;
  process.env.HIBI_CRED_NS = NS;
  ok(devNs === 'Hibi (개발)' && devSweep === false,
    '개발 실행의 기본 앞머리에서는 치우지 않는다 (임시 설정으로 도는 창 시험이 개발용 비밀번호를 지우지 않게)', { devNs, devSweep });
  ok(secret.namespace === NS && secret.sweepable === true && app.isPackaged === false, '되돌리면 다시 시험 앞머리');


  await sleep(200);
  const ours = errs.filter((e) => /^settings(-mail)?\.(js|html)$/.test(e.file));
  ok(ours.length === 0, '설정 창 쪽 콘솔 오류가 없다', ours.slice(0, 5));
  ok(errs.length === 0, '콘솔 오류가 하나도 없다', errs.slice(0, 5));

  win.destroy();
  console.log('\n[치우기]');
  ok(cleanup() === 0, '이 시험이 쓴 항목을 다 지웠다');
  ok(cred.list('Hibi-test/').length === 0, '«Hibi-test/» 아래에 남은 항목이 없다', cred.list('Hibi-test/').length);
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

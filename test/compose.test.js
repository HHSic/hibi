const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 쓰기 창을 딴 파일로 뺀 뒤에도 진짜로 열리고 그려지는가.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
// 비밀번호는 진짜 Windows 자격 증명 관리자에 들어간다 — 'Hibi-test/<임의>/' 아래에만 시험용 값을 두고,
// 끝나면(실패해도) 다 지운다. main.js·secret.js 를 싣기 전에 정해야 한다 — 안 정하면 개발 실행의
// 'Hibi (개발)/' 아래에 써 놓고 안 지운다 (옛 값을 옮겨 적는 길로도 들어간다).
const NS = `Hibi-test/compose-${require('crypto').randomBytes(6).toString('hex')}`;
process.env.HIBI_CRED_NS = NS;
const cred = require(`${ROOT}/src/credstore.js`);
/** 이 시험이 쓴 항목을 다 지운다 (남은 것 개수를 준다) — 어떻게 끝나든 부른다 */
function cleanup() {
  try {
    for (const t of cred.list(`${NS}/`)) cred.remove(t);
    return cred.list(`${NS}/`).length;
  } catch { return -1; }
}
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); cleanup(); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const secret = require(`${ROOT}/src/secret.js`);
// 이름 앞머리가 시험용이 아니면 아무것도 쓰지 않고 멈춘다 — 설치본·개발 실행의 항목을 건드리면 안 된다
if (secret.namespace !== NS) {
  console.error('시험 이름 앞머리가 적용되지 않았다 — 멈춘다', secret.namespace);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
/** 치우고, 남은 항목이 없는지 본 뒤 끝낸다 */
function finish(code) {
  console.log('\n[치우기]');
  ok(cleanup() === 0, '이 시험이 쓴 항목을 다 지웠다');
  ok(cred.list('Hibi-test/').length === 0, '«Hibi-test/» 아래에 남은 항목이 없다', cred.list('Hibi-test/').length);
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit((code || bad) ? 1 : 0);
}
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;
async function until(fn, ms = 20000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(200); }
}

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;

  console.log('\n[계정이 없을 때]');
  const r0 = await wwc.executeJavaScript(`window.nunsseom.composeOpen({ kind: 'new' })`);
  ok(r0 && r0.ok === false && /계정/.test(r0.message), 'IPC가 살아 있고 계정 없다고 답한다', r0);

  console.log('\n[계정을 넣고 열기]');
  // 진짜 경로와 같은 모양으로 계정을 하나 심는다 (연결은 안 한다).
  // 비밀번호는 계정 id 이름으로 잠근다 — mail:add 와 같은 길이고, id 가 없으면 옛 방식(DPAPI)으로 빠진다
  const id = store.newMailAccountId();
  const sealed = secret.seal('nope', id);
  ok(!!sealed, '비밀번호 봉하기가 된다 (자격 증명 관리자 — 시험용 이름 아래)', secret.targetOf(sealed) || '(옛 방식)');
  store.addMailAccount({
    id, name: '시험', provider: 'custom', host: 'imap.example.com', port: 993,
    user: 'me@example.com', sealed, from: 'me@example.com', sender: '나'
  });
  await sleep(600);
  const r1 = await wwc.executeJavaScript(`window.nunsseom.composeOpen({ kind: 'new' })`);
  ok(r1 && r1.ok !== false, '쓰기가 열렸다고 답한다', r1);

  const cw = await until(() => winBy('compose.html'));
  ok(!!cw, '쓰기 창이 실제로 떴다');
  if (!cw) { finish(1); return; }
  const cwc = cw.webContents;
  await until(async () => await cwc.executeJavaScript(`!!document.getElementById('from').value`));

  const st = await cwc.executeJavaScript(`(() => ({
    from: document.getElementById('from').value,
    to: document.getElementById('to').value,
    subj: document.getElementById('subject') ? document.getElementById('subject').value : null,
    bar: document.querySelectorAll('.bar button').length,
    pick: document.querySelectorAll('button.pickfield').length,
    sendOff: document.getElementById('send').disabled
  }))()`);
  console.log('  ', JSON.stringify(st));
  ok(/example\.com/.test(st.from), '보내는 사람이 채워졌다', st.from);
  ok(st.bar > 5, '서식 막대가 그려졌다', st.bar);
  ok(st.pick >= 2, '글꼴·크기 고르기 단추가 있다 (pickfield)', st.pick);
  ok(!st.sendOff, '보내기 단추가 살아 있다');

  console.log('\n[창 크기·자리 IPC도 같이 옮겨졌나]');
  const b = await cwc.executeJavaScript(`window.nunsseom.composeBounds()`);
  ok(b && b.width > 0, 'composeBounds 가 답한다', b && { w: b.width, h: b.height });

  console.log('\n[임시저장]');
  await cwc.executeJavaScript(`window.nunsseom.composeDraftSave({ to: 'x@y.z', subject: '쓰다 만 것', html: '<p>hi</p>' })`);
  await sleep(700);
  ok(store.mailDraft && store.mailDraft.subject === '쓰다 만 것', '임시저장이 저장된다', store.mailDraft && store.mailDraft.subject);

  fs.writeFileSync(path.join(OUT, 'compose-win.png'), (await cwc.capturePage()).toPNG());
  finish(0);
});

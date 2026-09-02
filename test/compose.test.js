const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 쓰기 창을 딴 파일로 뺀 뒤에도 진짜로 열리고 그려지는가.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const secret = require(`${ROOT}/src/secret.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
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
  // 진짜 경로와 같은 모양으로 계정을 하나 심는다 (연결은 안 한다)
  const sealed = secret.seal('nope');
  ok(!!sealed, '비밀번호 봉하기가 된다 (safeStorage)');
  store.addMailAccount({
    name: '시험', provider: 'custom', host: 'imap.example.com', port: 993,
    user: 'me@example.com', sealed, from: 'me@example.com', sender: '나'
  });
  await sleep(600);
  const r1 = await wwc.executeJavaScript(`window.nunsseom.composeOpen({ kind: 'new' })`);
  ok(r1 && r1.ok !== false, '쓰기가 열렸다고 답한다', r1);

  const cw = await until(() => winBy('compose.html'));
  ok(!!cw, '쓰기 창이 실제로 떴다');
  if (!cw) { app.exit(1); return; }
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
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

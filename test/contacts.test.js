const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 주소록을 딴 파일로 뺀 뒤에도 IPC가 살아 있고 실제로 읽고 쓰는가
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  const wc = winBy('widget.html').webContents;

  const c0 = await wc.executeJavaScript(`window.nunsseom.mailContacts()`);
  ok(Array.isArray(c0), 'mail:contacts 가 목록을 준다 (IPC 등록됨)', c0.length);

  await wc.executeJavaScript(`window.nunsseom.mailContactSave({ address: 'kim@x.com', name: '김부장' })`);
  await sleep(400);
  const c1 = await wc.executeJavaScript(`window.nunsseom.mailContacts()`);
  ok(c1.some((x) => x.address === 'kim@x.com' && x.name === '김부장'), '넣으면 들어간다', c1.length);
  ok(store.contacts.some((x) => x.address === 'kim@x.com'), '저장소에도 남는다');

  await wc.executeJavaScript(`window.nunsseom.mailContactRemove('kim@x.com')`);
  await sleep(400);
  const c2 = await wc.executeJavaScript(`window.nunsseom.mailContacts()`);
  ok(!c2.some((x) => x.address === 'kim@x.com'), '빼면 빠진다', c2.length);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

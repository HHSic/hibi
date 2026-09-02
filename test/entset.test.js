const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entset-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;
app.whenReady().then(async () => {
  await sleep(2500);
  ipcMain.emit('widget:open-settings', {}, 'app');
  await sleep(3000);
  const sw = winBy('settings.html'); const wc = sw.webContents;
  sw.show(); sw.focus();
  await wc.executeJavaScript(`document.getElementById('enter-pick').scrollIntoView({block:'center'})`);
  await sleep(500);
  const st = await wc.executeJavaScript(`(() => ({
    names: [...document.querySelectorAll('#enter-pick .mini')].map(b=>b.textContent),
    on: [...document.querySelectorAll('#enter-pick .mini:not(.ghost)')].map(b=>b.textContent),
    hint: document.getElementById('enter-hint').textContent
  }))()`);
  console.log('  ', JSON.stringify(st));
  ok(st.names.length === 6 && st.names[5] === '＋ 내 파일', '기본 다섯 개 + 파일 넣기', st.names);
  ok(st.on.length === 1 && st.on[0] === '기본', '지금 고른 것이 하나만 켜져 있다', st.on);
  // 골라보기
  await wc.executeJavaScript(`[...document.querySelectorAll('#enter-pick .mini')].find(b=>b.textContent==='고양이').click()`);
  await sleep(600);
  ok(store.settings.overlayEnter === 'cat', '고르면 저장된다', store.settings.overlayEnter);
  const h2 = await wc.executeJavaScript(`document.getElementById('enter-hint').textContent`);
  ok(/고양이/.test(h2), '설명도 따라 바뀐다', h2);
  fs.writeFileSync(path.join(OUT, 'ent-settings.png'), (await wc.capturePage()).toPNG());
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

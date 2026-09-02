const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 처음 열었을 때의 안내와 «가져오기»가 되는지
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true });
  ipcMain.emit('stocks:open');
  for (let i = 0; i < 40 && !winBy('stocks.html'); i++) await sleep(200);
  const w = winBy('stocks.html');
  w.setSize(400, 560); w.show(); w.focus();
  await sleep(7000);
  const wc = w.webContents;

  const first = await wc.executeJavaScript(`(() => ({
    rows: document.querySelectorAll('.row').length,
    guide: !!document.querySelector('.none'),
    imp: !!document.querySelector('.none .mini')
  }))()`);
  ok(first.rows === 4 && first.guide && first.imp,
    '지수 4줄 + 안내 + 가져오기 단추가 같이 나온다', first);
  fs.writeFileSync(path.join(OUT, 'stockwin-empty.png'), (await wc.capturePage()).toPNG());

  await wc.executeJavaScript(`document.querySelector('.none .mini').click()`);
  await sleep(12000);
  const after = await wc.executeJavaScript(`(() => ({
    rows: document.querySelectorAll('.row').length,
    say: document.getElementById('say').textContent,
    guide: !!document.querySelector('.none')
  }))()`);
  ok(store.stocksWatch.length === 21, 'algo-trader 21종목을 가져왔다', store.stocksWatch.length);
  ok(!after.guide, '가져온 뒤에는 안내가 사라진다', after);
  ok(after.rows === 25, '지수 4 + 21 = 25줄', after.rows);
  console.log('   알림:', after.say);
  fs.writeFileSync(path.join(OUT, 'stockwin-full.png'), (await wc.capturePage()).toPNG());

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

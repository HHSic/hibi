const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 이름으로 찾아서 넣는 흐름 — 진짜 창에서 진짜 키 입력으로
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

/** 진짜 키 입력으로 친다 */
async function type(wc, text) {
  await wc.executeJavaScript(`document.getElementById('q').focus()`);
  for (const ch of text) {
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    await sleep(40);
  }
  await sleep(900);
}
async function key(wc, k) { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(60); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); }

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true, stocksIndexes: false });
  ipcMain.emit('stocks:open');
  for (let i = 0; i < 40 && !winBy('stocks.html'); i++) await sleep(200);
  const w = winBy('stocks.html');
  w.setSize(400, 520); w.show(); w.focus();
  await sleep(4000);
  const wc = w.webContents;

  console.log('\n[«삼성»만 쳐본다]');
  await type(wc, '삼성');
  const sug = await wc.executeJavaScript(`(() => {
    const box = document.getElementById('sug');
    return { open: box.classList.contains('on'),
             items: [...box.querySelectorAll('.it')].map((x) => x.textContent.trim()),
             sel: [...box.querySelectorAll('.it')].findIndex((x) => x.classList.contains('on')) };
  })()`);
  console.log('  ', JSON.stringify(sug.items.slice(0, 4)));
  ok(sug.open && sug.items.length >= 3, '두 글자만 쳐도 후보가 뜬다', sug.items.length);
  ok(sug.sel === 0, '첫 후보가 골라져 있다', sug.sel);
  fs.writeFileSync(path.join(OUT, 'stock-search.png'), (await wc.capturePage()).toPNG());

  console.log('\n[아래로 옮겨 고르기]');
  await key(wc, 'Down'); await sleep(300);
  const sel2 = await wc.executeJavaScript(
    `[...document.querySelectorAll('#sug .it')].findIndex((x) => x.classList.contains('on'))`);
  ok(sel2 === 1, '↓로 두 번째로 옮겨진다', sel2);
  const pickName = await wc.executeJavaScript(`document.querySelectorAll('#sug .it b')[1].textContent`);
  await key(wc, 'Return');
  await sleep(8000);
  ok(store.stocksWatch.length === 1 && store.stocksWatch[0].name === pickName,
    `Enter로 «${pickName}»이 들어갔다`, store.stocksWatch);
  const closed = await wc.executeJavaScript(`document.getElementById('sug').classList.contains('on')`);
  ok(!closed, '넣고 나면 후보 목록이 닫힌다');

  console.log('\n[한글로 해외 종목]');
  await type(wc, '엔비디아');
  const s2 = await wc.executeJavaScript(
    `[...document.querySelectorAll('#sug .it')].map((x) => x.textContent.trim())`);
  console.log('  ', JSON.stringify(s2));
  ok(s2.length >= 1 && /NVDA/.test(s2[0]), '«엔비디아»로 NVDA가 나온다', s2[0]);
  await key(wc, 'Return');
  await sleep(8000);
  const nv = store.stocksWatch.find((x) => x.ticker === 'NVDA');
  ok(!!nv && nv.name === '엔비디아', '한글 이름으로 들어갔다', nv);

  console.log('\n[없는 이름]');
  await type(wc, 'ㅋㅋㅋㅋㅋ');
  const s3 = await wc.executeJavaScript(`document.getElementById('sug').textContent.trim()`);
  ok(/없습니다/.test(s3), '없으면 없다고 알려준다', s3);

  await sleep(3000);
  fs.writeFileSync(path.join(OUT, 'stock-after.png'), (await wc.capturePage()).toPNG());
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

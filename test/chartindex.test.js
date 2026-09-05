const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 지수(코스피·나스닥)도 눌러서 차트를 볼 수 있는가.
// 지수 심볼(^KS11)에 «.KS» 를 붙이면 아무것도 안 나오므로, index 표시가
// 목록 → 창 → history 까지 끝까지 따라가야 한다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cidx-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(p)) || null;
const until = async (f, n = 160) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true, stocksIndexes: true, chartRange: '1mo' });
  ipcMain.emit('stocks:open');
  const sw = await until(async () => winBy('stocks.html'));
  await sleep(4000);

  // 목록에서 지수 줄을 찾는다 (관심 종목을 하나도 안 넣었으니 지수만 있다)
  const idx = await sw.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.row.idx');
    return r ? { tap: r.classList.contains('tap'), name: r.textContent.slice(0, 8) } : null;
  })()`);
  ok(idx && idx.tap, '지수 줄을 누를 수 있다', idx);

  await sw.webContents.executeJavaScript(`document.querySelector('.row.idx').click()`);
  const cw = await until(async () => winBy('chart.html'));
  ok(!!cw, '지수 차트 창이 열렸다');
  const wc = cw.webContents;

  // 값이 실제로 왔는지 — 지수 심볼을 잘못 만들면 «자료가 없습니다» 가 뜬다
  await until(async () => (await wc.executeJavaScript(
    `document.getElementById('note').style.display === 'none' || document.getElementById('note').textContent !== '불러오는 중…'`)) === true, 200);
  const st = await wc.executeJavaScript(`(() => ({
    ticker: document.getElementById('ticker').textContent,
    note: document.getElementById('note').textContent,
    hidden: getComputedStyle(document.getElementById('note')).display === 'none',
    drawn: document.querySelectorAll('#plot svg rect, #plot svg path').length,
    px: document.getElementById('px').textContent
  }))()`);
  console.log('  지수차트', JSON.stringify(st));
  ok(st.ticker.startsWith('^'), '지수 심볼이 그대로 실렸다', st.ticker);
  ok(st.hidden && st.drawn > 0, '자료가 와서 그려졌다', { 안내: st.note, 그린것: st.drawn });
  ok(st.px !== '—', '값이 찍힌다', st.px);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

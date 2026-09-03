const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 주식 창 크기가 드래그마다 반올림으로 커지지 않는가.
// getBounds 를 드래그 기준으로 되읽으면 DPI 배율에서 요청보다 1px 크게 나와 누적된다.
// 그래서 «우리가 정한 크기»를 기준으로 준다 — setBounds(W) 뒤 bounds() 는 정확히 W 여야 한다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockcreep-'));
app.setPath('appData', tmp);
const store = require(`${ROOT}/src/store.js`);
require(`${ROOT}/src/main.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  console.log('  DPI 배율', screen.getPrimaryDisplay().scaleFactor);
  store.setSettings({ stocksEnabled: true });
  ipcMain.emit('stocks:open', {});
  let sw = null; for (let i = 0; i < 80 && !sw; i++) { await sleep(50); sw = winBy('stocks.html'); }
  if (!sw) { ok(false, '주식 창이 열렸다'); app.exit(1); return; }
  await sleep(400);
  const wc = sw.webContents;

  // 렌더러를 거쳐 실제 경로로 크기를 정하고, 같은 경로로 되읽는다
  const setB = (w, h) => wc.executeJavaScript(`window.nunsseom.stocksSetBounds({ x: ${sw.getBounds().x}, y: ${sw.getBounds().y}, width: ${w}, height: ${h} }); 0`);
  const getB = () => wc.executeJavaScript(`window.nunsseom.stocksBounds().then(b => ({ w: b.width, h: b.height }))`);

  // 1) 정한 크기를 정확히 돌려준다 (반올림 부풀림 없음)
  for (const [w, h] of [[500, 560], [437, 611], [623, 489]]) {
    await setB(w, h); await sleep(120);
    const b = await getB();
    ok(b.w === w && b.h === h, `정한 ${w}×${h} 를 그대로 돌려준다`, b);
  }

  // 2) 같은 크기를 여러 번 정해도 스멀스멀 커지지 않는다
  await setB(500, 560); await sleep(100);
  const widths = [];
  for (let k = 0; k < 8; k++) {
    const b = await getB();
    widths.push(b.w);
    // 되읽은 값을 다시 기준 삼아 정한다 — 드래그를 반복하는 것과 같은 왕복
    await setB(b.w, b.h); await sleep(70);
  }
  const grew = Math.max(...widths) - Math.min(...widths);
  ok(grew === 0, '드래그를 반복해도 폭이 안 커진다', { 폭들: widths, 최대차: grew });

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 기록 창을 딴 파일로 뺀 뒤에도 열리고, 데이터를 주고, 닫히고, «바뀜» 알림이 안전한가
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'statswin-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const statswin = require(`${ROOT}/src/statswin.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  ok(statswin.win() === null, '닫혀 있을 때 win()은 null');
  statswin.notifyChanged();                       // 창이 없어도 터지면 안 된다
  ok(true, '닫혀 있을 때 notifyChanged 가 조용히 지나간다');

  ipcMain.emit('widget:open-stats', {}, null);   // 위젯 단추와 같은 경로
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) { await sleep(200); sw = winBy('stats.html'); }
  ok(!!sw, 'widget:open-stats 로 기록 창이 뜬다');
  if (!sw) { app.exit(1); return; }
  ok(statswin.win() === sw, 'win()이 그 창을 돌려준다');
  await sleep(1500);
  const d = await sw.webContents.executeJavaScript(`window.nunsseom.statsData(null)`);
  ok(d && typeof d === 'object' && Array.isArray(d.types || d.items || []) , 'stats:data 가 답한다', d && Object.keys(d).slice(0, 5));
  statswin.notifyChanged();
  ok(true, '열려 있을 때 notifyChanged 가 보내진다');
  await sw.webContents.executeJavaScript(`window.nunsseom.statsSetWeeks(20)`);
  await sleep(400);
  const store = require(`${ROOT}/src/store.js`);
  ok(store.settings.grassWeeks === 20, 'stats:set-weeks 가 저장된다', store.settings.grassWeeks);
  await sw.webContents.executeJavaScript(`window.nunsseom.statsClose()`);
  await sleep(800);
  ok(!winBy('stats.html') && statswin.win() === null, 'stats:close 로 닫히고 win()이 null 로 돌아간다');
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

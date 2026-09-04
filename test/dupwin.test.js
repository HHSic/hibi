const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 휴식 창이 두 벌 생겼을 때 «확인»이 남김없이 닫는가.
// 두 벌이 되면 목록에 담기지 않은 창이 남아, 단추를 눌러도 아무 일이 안 일어난다 —
// 사용자에게는 «닫혔다가 다시 뜬 창이 안 먹는다»로 보인다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupwin-'));
app.setPath('appData', tmp);
app.on('browser-window-created', (_e, w) => { try { w.setOpacity(0); } catch { /* 무시 */ } });
require(`${ROOT}/src/main.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const overlays = () => BrowserWindow.getAllWindows()
  .filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('overlay'));
const visible = () => overlays().filter((w) => w.isVisible());
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(p)) || null;
const until = async (f, n = 120) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };
const click = (wc, id) => wc.executeJavaScript(`(() => { const e = document.getElementById('${id}');
  if (!e || e.style.display === 'none') return false; e.click(); return true; })()`);

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;
  await wwc.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);
  await sleep(600);

  // ── 목록에서 떨어져 나간 창을 흉내 낸다 ──
  // 진짜로는 여는 도중에 또 열려서 생긴다. 여기서는 그 결과만 만들어 두고,
  // «확인»이 그것까지 닫는지를 본다.
  await click(wwc, 'btn-now');
  const ov = await until(async () => (visible().length ? visible()[0] : null));
  // 휴식 창은 화면마다 하나씩 뜬다 — «한 벌»은 1개가 아니라 화면 수만큼이다
  const n = screen.getAllDisplays().length;
  ok(!!ov, '휴식 창이 떴다');
  const d = screen.getPrimaryDisplay();
  const stray = new BrowserWindow({
    ...d.bounds, frame: false, transparent: true, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js') }
  });
  await stray.loadFile(path.join(ROOT, 'renderer', 'overlay.html'), {
    query: { main: 'true', display: String(d.id) }
  });
  stray.show();
  await sleep(500);
  ok(visible().length === n + 1, '두 벌이 된 상태를 만들었다', { 보임: visible().length, 화면: n });

  await click(visible()[0].webContents, 'btn-finish');
  await sleep(1500);
  ok(visible().length === 0, '«다 했어요»가 두 벌을 다 닫는다', visible().length);
  ok(overlays().length === 0, '숨은 것까지 남지 않는다', overlays().length);

  // ── 빠르게 두 번 눌러도 한 벌만 ──
  await sleep(800);
  ipcMain.emit('widget:break-now', {}, 'eye');
  ipcMain.emit('widget:break-now', {}, 'stretch');
  await sleep(5000);
  ok(visible().length <= n, '두 번 눌러도 창은 한 벌', { 보임: visible().length, 화면: n });
  await click(visible()[0].webContents, 'btn-skip');
  await sleep(1500);
  ok(visible().length === 0, '«건너뛰기»로 다 닫힌다', visible().length);

  for (const w of overlays()) w.destroy();
  console.log(bad ? bad + '개 실패' : '모두 통과');
  app.exit(bad ? 1 : 0);
});

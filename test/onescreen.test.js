const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const FIX = `${ROOT}/test/fixtures`;
// 연출은 마우스 있는 화면에서만, 휴식 내용은 모든 화면에.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-'));
app.setPath('appData', tmp);
let hide = false;
app.on('browser-window-created', (_e, w) => { if (hide) { try { w.setOpacity(0); } catch { /* 무시 */ } } });
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winsBy = (p) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes(p));
const until = async (f, n = 100) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

app.whenReady().then(async () => {
  await sleep(2500);
  hide = true;
  const n = screen.getAllDisplays().length;
  console.log('  모니터', n + '대 · 마우스는', screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id, '번');
  await winsBy('widget.html')[0].webContents.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);

  const dir = path.join(app.getPath('userData'), 'enters');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'cat-alpha.webm'), path.join(dir, 'a.webm'));
  const list = store.addEnter({ name: '고양이', file: 'a.webm', kind: 'video', ms: 900 });
  store.setSettings({ overlayEnter: `my:${list[0].id}` });

  ipcMain.emit('widget:break-now', {}, 'eye');
  const ws = await until(async () => { const w = winsBy('overlay'); return w.length >= n ? w : null; }) || winsBy('overlay');
  await sleep(400);
  const st = await Promise.all(ws.map((w) => w.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('curtain');
    return { disp: new URLSearchParams(location.search).get('display'),
             drew: c.children.length > 0, vid: !!c.querySelector('video'),
             delay: getComputedStyle(document.documentElement).getPropertyValue('--enter-delay').trim() };
  })()`).catch(() => null)));
  console.log('  화면별', JSON.stringify(st));
  const live = st.filter(Boolean);
  ok(live.length === n, `창이 ${n}대에 다 떴다`, live.length);
  ok(live.filter((x) => x.vid).length === 1, '영상을 그리는 화면은 하나뿐', live.map((x) => x.vid));
  ok(new Set(live.map((x) => x.delay)).size === 1 && live[0].delay === '960ms',
    '기다리는 시간은 모든 화면이 같다', live.map((x) => x.delay));

  const cur = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  ok(live.find((x) => x.vid)?.disp === cur, '그리는 화면이 마우스 있는 화면이다', [live.find((x) => x.vid)?.disp, cur]);

  // 내용은 모든 화면에 떠야 한다 — 이걸 줄이면 고개만 돌려 계속 일하게 된다
  let heads = null;
  for (let i = 0; i < 40; i++) {
    if (ws.some((w) => w.isDestroyed())) break;
    const h = await Promise.all(ws.map((w) => w.webContents
      .executeJavaScript(`(() => ({ head: (document.getElementById('headline').textContent||'').trim(),
        stage: getComputedStyle(document.querySelector('.stage')).opacity }))()`).catch(() => null)));
    if (h.every((x) => x && x.head && Number(x.stage) > 0.9)) { heads = h; break; }
    heads = h; await sleep(100);
  }
  ok(heads && heads.every((x) => x && x.head.length > 0), '휴식 내용은 모든 화면에 뜬다',
    (heads || []).map((x) => (x ? x.head.slice(0, 8) : null)));

  console.log(bad ? bad + '개 실패' : '모두 통과');
  app.exit(bad ? 1 : 0);
});

const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 누끼 PNG 도 되는가 + «그때그때» 가 내 파일까지 섞고, 모니터마다 같은 것을 내는가.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myent2-'));
app.setPath('appData', tmp);
let hide = false;
app.on('browser-window-created', (_e, w) => { if (hide) { try { w.setOpacity(0); } catch { /* 무시 */ } } });
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winsBy = (p) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes(p));

// 연출을 그리는 창 = 마우스가 있는 화면의 창
const cursorWin = () => {
  const id = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  return BrowserWindow.getAllWindows()
    .find((w) => w.webContents.getURL().includes('overlay') && w.webContents.getURL().includes(`display=${id}`)) || null;
};
const until = async (f, n = 80) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

/** 가운데만 불투명한 PNG 하나 — 배경이 투명한 «누끼» 그림 */
function makePng(file) {
  const W = 240, H = 160, buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const inside = Math.hypot(x - W / 2, y - H / 2) < 55;
    buf[i] = 60; buf[i + 1] = 90; buf[i + 2] = 230; buf[i + 3] = inside ? 255 : 0;  // BGRA
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG());
}

app.whenReady().then(async () => {
  await sleep(2500);
  hide = true;
  await winsBy('widget.html')[0].webContents.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);
  const dir = path.join(app.getPath('userData'), 'enters');
  fs.mkdirSync(dir, { recursive: true });
  makePng(path.join(dir, 'dot.png'));
  const list = store.addEnter({ name: '점', file: 'dot.png', kind: 'img', ms: 700 });
  const id = list[0].id;

  // ── 그림 ──
  store.setSettings({ overlayEnter: `my:${id}` });
  ipcMain.emit('widget:break-now', {}, 'eye');
  const ov = await until(async () => cursorWin());
  await sleep(350);
  const st = await ov.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('curtain');
    const im = c.querySelector('img');
    return { cls: c.className, tag: im ? 'IMG' : (c.querySelector('video') ? 'VIDEO' : null),
             loaded: im ? im.complete && im.naturalWidth : 0,
             fit: im ? getComputedStyle(im).objectFit : null,
             delay: getComputedStyle(document.documentElement).getPropertyValue('--enter-delay').trim() };
  })()`);
  console.log('  그림', JSON.stringify(st));
  ok(st.tag === 'IMG' && st.loaded === 240, '누끼 PNG 가 뜬다', [st.tag, st.loaded]);
  ok(st.fit === 'contain', '잘리지 않게 통째로 보인다', st.fit);
  ok(st.delay === '760ms', '그림도 제 길이만큼 덮는다', st.delay);
  await until(async () => winsBy('overlay').length === 0, 120);

  // ── 그때그때 ──
  // className 은 연출이 도는 «순간»에만 남아 시점을 타므로, main 이 정해서 보낸
  // 페이로드를 직접 읽는다. 여기 담긴 enter 가 곧 그 휴식의 연출이다.
  store.setSettings({ overlayEnter: 'random' });
  const seen = new Set();
  for (let n = 0; n < 12; n++) {
    ipcMain.emit('widget:break-now', {}, 'eye');
    // 화면 수만큼 다 뜨길 기다린다 — 하나만 보고 «같다»고 하면 검사가 아니다
    const want = screen.getAllDisplays().length;
    const ws = await until(async () => { const w = winsBy('overlay'); return w.length >= want ? w : null; })
      || winsBy('overlay');
    const got = await Promise.all(ws.map((w) => w.webContents
      .executeJavaScript('window.nunsseom.getBreakPayload().then(p => p && p.enter)').catch(() => '?')));
    seen.add(got[0]);
    if (n === 0) ok(new Set(got).size === 1, `모니터 ${ws.length}대가 같은 연출을 낸다`, got);
    ipcMain.emit('overlay:skip', {});          // 앱이 스스로 닫게 한다
    await until(async () => winsBy('overlay').length === 0, 60);
  }
  console.log('  나온 것들', [...seen].join(', '));
  ok(seen.size >= 2, '여러 연출이 돌아가며 나온다', [...seen]);
  ok([...seen].some((x) => String(x).startsWith('my:')), '내 파일도 섞여 나온다', [...seen]);
  ok(!seen.has('random'), '«그때그때» 그대로 넘어가지 않는다', [...seen]);

  console.log(bad ? bad + '개 실패' : '모두 통과');
  app.exit(bad ? 1 : 0);
});

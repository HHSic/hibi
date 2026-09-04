const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 호흡·브라운관이 배경으로 화면을 채우고, 그 위에 내용이 뜨는가. 정지 그림도 찍는다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newent-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;
// 연출은 마우스가 있는 화면에서만 그린다 — 화면이 여럿이면 아무 휴식 창이나 보면 안 된다
const cursorWin = () => {
  const id = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  return BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay')
    && w.webContents.getURL().includes(`display=${id}`)) || null;
};

app.whenReady().then(async () => {
  await sleep(2500);
  const wc = winBy('widget.html').webContents;
  await wc.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);
  store.setReminder('eye', { durationSec: 10 });  // 연출 5초

  for (const kind of ['breathe', 'tv']) {
    store.setSettings({ overlayEnter: kind });
    await sleep(300);
    ipcMain.emit('widget:break-now', {}, 'eye');
    let ov = null; for (let i = 0; i < 60 && !ov; i++) { await sleep(50); ov = cursorWin(); }
    const owc = ov.webContents;
    // 연출이 그려질 때까지 기다린다 — 미리 세워둔 창이 없으면 로딩이 길어져,
    // 고정 대기로는 시작 전에 재는 수가 있다(실제로 흔들렸다).
    const probe = `(() => {
      const c = document.getElementById('curtain');
      return { cls: c.className, kids: c.children.length,
               hasScreen: !!c.querySelector('.ent-tv-screen, .ent-breathe'),
               stage: getComputedStyle(document.querySelector('.stage')).opacity,
               delay: getComputedStyle(document.documentElement).getPropertyValue('--enter-delay').trim() };
    })()`;
    let mid = null;
    for (let i = 0; i < 40; i++) {
      mid = await owc.executeJavaScript(probe).catch(() => null);
      if (mid && mid.kids > 0) break;
      await sleep(100);
    }
    if (!mid) mid = { cls: '?', kids: 0, hasScreen: false, stage: '?', delay: '?' };
    console.log(`  [${kind}] 머무는 중`, JSON.stringify(mid));
    ok(mid.cls.includes(`ent-${kind}`) && mid.kids > 0, `${kind}: 화면을 덮는다`, mid.cls);
    ok(Number(mid.stage) < 0.5, `${kind}: 덮인 동안 내용 숨김`, mid.stage);
    fs.writeFileSync(path.join(OUT, `ent-${kind}.png`), (await owc.capturePage()).toPNG());

    // 내용이 그 위에 뜰 때까지 기다린다 (연출은 배경으로 남는다)
    let after = null;
    for (let i = 0; i < 60; i++) {
      if (ov.isDestroyed()) break;
      after = await owc.executeJavaScript(`(() => ({
        on: document.getElementById('curtain').classList.contains('on'),
        kids: document.getElementById('curtain').children.length,
        head: (document.getElementById('headline').textContent || '').trim(),
        stage: getComputedStyle(document.querySelector('.stage')).opacity }))()`).catch(() => null);
      if (after && Number(after.stage) > 0.9) break;
      await sleep(100);
    }
    ok(after && after.head.length > 0 && Number(after.stage) > 0.9, `${kind}: 내용이 그 위에 떴다`, after && after.head);
    ok(after && after.on && after.kids > 0, `${kind}: 연출은 배경으로 남는다`, after && { on: after.on, kids: after.kids });
    ipcMain.emit('overlay:done');
    await sleep(800);
  }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

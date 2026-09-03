const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 호흡·브라운관이 실제 휴식에서 화면을 덮고, 걷힌 뒤 내용이 뜨는가. 정지 그림도 찍는다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newent-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  const wc = winBy('widget.html').webContents;
  await wc.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);
  store.setReminder('eye', { durationSec: 10 });  // 연출 5초

  for (const kind of ['breathe', 'tv']) {
    store.setSettings({ overlayEnter: kind });
    await sleep(300);
    ipcMain.emit('widget:break-now', {}, 'eye');
    let ov = null; for (let i = 0; i < 60 && !ov; i++) { await sleep(50); ov = winBy('overlay'); }
    const owc = ov.webContents;
    await sleep(1100);   // 도착 끝난 시점(머무는 중)
    const mid = await owc.executeJavaScript(`(() => {
      const c = document.getElementById('curtain');
      return { cls: c.className, kids: c.children.length,
               hasScreen: !!c.querySelector('.ent-tv-screen, .ent-breathe'),
               stage: getComputedStyle(document.querySelector('.stage')).opacity,
               delay: getComputedStyle(document.documentElement).getPropertyValue('--enter-delay').trim() };
    })()`);
    console.log(`  [${kind}] 머무는 중`, JSON.stringify(mid));
    ok(mid.cls.includes(`ent-${kind}`) && mid.kids > 0, `${kind}: 화면을 덮는다`, mid.cls);
    ok(Number(mid.stage) < 0.5, `${kind}: 덮인 동안 내용 숨김`, mid.stage);
    fs.writeFileSync(path.join(OUT, `ent-${kind}.png`), (await owc.capturePage()).toPNG());

    // 걷힐 때까지 기다린다
    let after = null;
    for (let i = 0; i < 80; i++) {
      if (ov.isDestroyed()) break;
      after = await owc.executeJavaScript(`(() => ({
        on: document.getElementById('curtain').classList.contains('on'),
        kids: document.getElementById('curtain').children.length,
        head: (document.getElementById('headline').textContent || '').trim(),
        stage: getComputedStyle(document.querySelector('.stage')).opacity }))()`).catch(() => null);
      if (after && !after.on && after.kids === 0 && Number(after.stage) > 0.9) break;
      await sleep(100);
    }
    ok(after && !after.on && after.kids === 0, `${kind}: 커튼이 깨끗이 걷혔다`, after);
    ok(after && after.head.length > 0, `${kind}: 휴식 내용이 떴다`, after && after.head);
    ipcMain.emit('overlay:done');
    await sleep(800);
  }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

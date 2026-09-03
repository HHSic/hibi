const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 진짜 휴식에서 연출이 돌고, 걷힌 뒤 휴식 내용이 제대로 뜨는가.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entreal-'));
app.setPath('appData', tmp);
let hide = false;
app.on('browser-window-created', (_e, w) => { if (hide) { try { w.setOpacity(0); } catch { /* 무시 */ } } });
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;
// 연출은 마우스가 있는 화면에서만 그린다 — 아무 휴식 창이나 보면 안 된다
const cursorWin = () => {
  const id = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  return BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay')
    && w.webContents.getURL().includes(`display=${id}`)) || null;
};

app.whenReady().then(async () => {
  await sleep(2500);
  hide = true;
  const wc = winBy('widget.html').webContents;
  await wc.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);
  // 연출 길이는 휴식의 절반이라, 시험은 짧은 휴식으로 돌려 빨리 끝낸다.
  store.setReminder('eye', { durationSec: 6 });

  for (const kind of ['cat', 'fade']) {
    store.setSettings({ overlayEnter: kind });
    await sleep(400);
    ipcMain.emit('widget:break-now', {}, 'eye');
    let ov = null;
    for (let i = 0; i < 60 && !ov; i++) { await sleep(50); ov = cursorWin(); }
    if (!ov) { ok(false, `${kind}: 휴식 창이 안 뜸`); continue; }
    const owc = ov.webContents;

    // 덮이는 동안: 커튼이 살아 있어야 한다 (fade 는 아예 안 뜬다)
    await sleep(200);
    const mid = await owc.executeJavaScript(`(() => {
      const c = document.getElementById('curtain');
      return { on: c.classList.contains('on'), kids: c.children.length,
               delay: getComputedStyle(document.documentElement).getPropertyValue('--enter-delay').trim() };
    })()`);
    ok(kind === 'fade' ? !mid.on : mid.on, `${kind}: 덮는 중 커튼 상태`, mid);

    // 다 걷힌 뒤: 커튼은 사라지고 휴식 내용이 보여야 한다.
    // 연출 길이가 휴식을 따라 늘었으므로 고정 대기 대신 걷힐 때까지 기다린다.
    let after = null;
    for (let i = 0; i < 90; i++) {
      after = await owc.executeJavaScript(`(() => {
        const c = document.getElementById('curtain');
        const h = document.getElementById('headline');
        return { on: c.classList.contains('on'), kids: c.children.length,
                 head: (h.textContent || '').trim().slice(0, 12),
                 stageOpacity: getComputedStyle(document.querySelector('.stage')).opacity };
      })()`).catch(() => null);
      if (after && !after.on && after.kids === 0 && Number(after.stageOpacity) > 0.9) break;
      await sleep(100);
    }
    ok(!after.on && after.kids === 0, `${kind}: 커튼이 깨끗이 걷혔다`, { on: after.on, kids: after.kids });
    ok(after.head.length > 0 && Number(after.stageOpacity) > 0.9, `${kind}: 휴식 내용이 떴다`, after);
    ipcMain.emit('overlay:done');
    await sleep(1600);
  }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

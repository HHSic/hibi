const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 진짜 앱을 띄워서, 일시정지 동안 위젯에 찍히는 «남은 시간»이 정말 멈추는지 본다.
// tick 페이로드의 remaining이 곧 사용자가 보는 숫자다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => {
  console.error('LAB 터짐:', (e && e.stack) || e);
  process.exit(1);
});

// 진짜 설정을 건드리지 않도록 딴 데를 보게 한다 (main.js가 여기 밑에 userData를 잡는다)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pauselab-'));
app.setPath('appData', tmp);

require(`${ROOT}/src/main.js`);

const seen = [];          // [t, remaining, paused]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function widgetWc() {
  for (const w of BrowserWindow.getAllWindows()) {
    const u = w.webContents.getURL();
    if (u.includes('widget.html')) return w.webContents;
  }
  return null;
}

app.whenReady().then(async () => {
  await sleep(2500);
  const wc = widgetWc();
  if (!wc) { console.error('위젯 창을 못 찾음'); app.exit(1); return; }

  const orig = wc.send.bind(wc);
  wc.send = (ch, ...a) => {
    if (ch === 'tick' && a[0] && !a[0].empty) {
      seen.push([Date.now(), a[0].remaining, a[0].paused, a[0].idle]);
    }
    return orig(ch, ...a);
  };

  const { ipcMain } = require('electron');
  const span = (from, to) => {
    const win = seen.filter(([t]) => t >= from && t <= to);
    return win.length ? { first: win[0][1], last: win[win.length - 1][1], n: win.length,
      paused: win.every((r) => r[2]), idle: win.some((r) => r[3]) } : null;
  };

  // ── 1. 그냥 두면 줄어든다 (대조군) ──
  let t0 = Date.now();
  await sleep(6000);
  const free = span(t0, Date.now());
  if (!free || free.n < 4) { console.error('tick을 못 받음', free); app.exit(1); return; }
  if (free.idle) {
    console.log('※ 자리 비움으로 잡혀서 대조군이 무의미 — 마우스를 안 움직인 탓');
  }
  console.log(`그냥 6초: ${free.first}초 → ${free.last}초  (${free.first - free.last}초 줄어듦)`);

  // ── 2. 멈추면 안 줄어든다 ──
  ipcMain.emit('widget:toggle-pause');
  await sleep(500);
  t0 = Date.now();
  await sleep(10000);
  const held = span(t0, Date.now());
  console.log(`멈춘 10초: ${held.first}초 → ${held.last}초  (${held.first - held.last}초 줄어듦), paused=${held.paused}, 표본 ${held.n}개`);

  // ── 3. 풀면 다시 줄어든다 ──
  ipcMain.emit('widget:toggle-pause');
  await sleep(500);
  t0 = Date.now();
  await sleep(6000);
  const back = span(t0, Date.now());
  console.log(`푼 뒤 6초: ${back.first}초 → ${back.last}초  (${back.first - back.last}초 줄어듦)`);

  const ok = held.paused
    && Math.abs(held.first - held.last) <= 1        // 멈춘 동안 사실상 그대로
    && (back.first - back.last) >= 4                // 풀면 다시 흐른다
    && Math.abs(held.last - back.first) <= 2;       // 풀 때 건너뛰지 않는다

  console.log(ok ? '\n통과 — 일시정지가 시계를 멈춘다' : '\n실패');
  app.exit(ok ? 0 : 1);
});

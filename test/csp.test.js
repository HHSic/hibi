const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 창마다 문이 닫혀 있나 — 그리고 닫아 놓고도 화면이 멀쩡한가.
//
// CSP 는 넣기는 쉽지만, 잘못 넣으면 글꼴이 안 오거나 그림이 빈 채로 조용히 뜬다.
// 그러니 «있다»만 보지 않는다. 진짜 창을 다 띄워 놓고
//   · CSP 위반이 콘솔에 찍혔나
//   · 글꼴·아이콘·그림이 실제로 들어왔나
// 를 같이 본다. 그리고 그 문이 정말 막는지도 시험한다 — 창 안에서 밖으로
// 요청을 날려 보고, 막히는지.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csplab-'));
app.setPath('appData', tmp);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 창마다 콘솔을 엿본다 — CSP 위반은 여기로 나온다
const cspMsgs = new Map();   // url → [줄]
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    // Electron 33: (event, level, message, line, sourceId) 또는 (details)
    const msg = typeof args[0] === 'object' && args[0] && 'message' in args[0]
      ? args[0].message : args[2];
    if (!/Content Security Policy|Refused to/i.test(String(msg || ''))) return;
    const u = String(win.webContents.getURL()).split('/').pop().split('?')[0] || '?';
    if (!cspMsgs.has(u)) cspMsgs.set(u, []);
    cspMsgs.get(u).push(String(msg));
  });
});

require(`${ROOT}/src/main.js`);

const PAGES = ['widget.html', 'settings.html', 'stats.html', 'overlay.html',
  'chart.html', 'stocks.html', 'compose.html', 'mailview.html', 'popup.html'];

const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);

  console.log('\n[1] 모든 화면 파일에 CSP 가 있나 (파일을 직접 읽어 확인)');
  for (const p of PAGES) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'renderer', p), 'utf8');
    const has = /Content-Security-Policy/.test(text);
    const noneDefault = /default-src\s+'none'/.test(text);
    ok(has && noneDefault, `${p} — default-src 'none' 로 시작한다`, has ? undefined : '없음');
  }

  console.log('\n[2] 창을 실제로 띄워 본다 — 열리고, 그려지고, 위반이 안 뜬다');
  // 위젯은 이미 떠 있다. 나머지는 열어 본다.
  ipcMain.emit('widget:open-settings', {});
  await sleep(2500);
  ipcMain.emit('widget:open-stats', {});
  await sleep(2000);
  ipcMain.emit('stocks:open', {});
  await sleep(2500);
  ipcMain.emit('widget:break-now', {}, 'eye');
  await sleep(4000);

  for (const p of ['widget.html', 'settings.html', 'stats.html', 'overlay.html', 'stocks.html']) {
    const w = winBy(p);
    if (!w) { console.log(`   건너뜀 ${p} — 안 열렸다`); continue; }
    // 실제로 무언가 그려졌나 (CSP 로 스크립트가 막히면 텅 빈 껍데기가 된다)
    const drew = await w.webContents.executeJavaScript(
      'document.body.innerText.trim().length + document.querySelectorAll("svg, canvas, img").length');
    ok(drew > 0, `${p} — 내용이 그려졌다`, drew);
    const bads = cspMsgs.get(p) || [];
    ok(!bads.length, `${p} — CSP 위반 없음`, bads.slice(0, 3));
  }

  console.log('\n[3] 아이콘(SVG)이 실제로 들어왔나 — 스크립트가 막히면 여기서 티가 난다');
  for (const p of ['widget.html', 'settings.html']) {
    const w = winBy(p);
    if (!w) continue;
    const n = await w.webContents.executeJavaScript('document.querySelectorAll("svg").length');
    ok(n > 0, `${p} — 아이콘이 그려졌다`, n);
  }

  console.log('\n[4] 글꼴이 왔나 (font-src file: 을 안 열면 조용히 기본 글꼴로 떨어진다)');
  for (const p of ['widget.html', 'settings.html']) {
    const w = winBy(p);
    if (!w) continue;
    const got = await w.webContents.executeJavaScript(
      '(async () => { await document.fonts.ready; '
      + 'return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family); })()');
    ok(got.length > 0, `${p} — 웹글꼴이 실제로 실렸다`, got.slice(0, 3));
  }

  console.log('\n[5] 문이 정말 막는가 — 창 안에서 밖으로 나가 본다');
  for (const p of ['widget.html', 'settings.html', 'overlay.html']) {
    const w = winBy(p);
    if (!w) continue;
    const r = await w.webContents.executeJavaScript(`(async () => {
      try { await fetch('https://example.com/'); return '나갔다'; }
      catch (e) { return '막힘'; }
    })()`);
    ok(r === '막힘', `${p} — fetch 로 밖에 못 나간다`, r);
  }

  console.log('\n[6] 인터넷 그림도 막히나 (읽은 사실이 새는 길)');
  for (const p of ['widget.html', 'settings.html']) {
    const w = winBy(p);
    if (!w) continue;
    const r = await w.webContents.executeJavaScript(`(async () => new Promise((res) => {
      const img = new Image();
      img.onload = () => res('실렸다');
      img.onerror = () => res('막힘');
      img.src = 'https://example.com/x.png';
      setTimeout(() => res('시간초과'), 3000);
    }))()`);
    ok(r === '막힘', `${p} — 바깥 그림이 안 실린다`, r);
  }

  ipcMain.emit('overlay:done');
  await sleep(600);

  if (cspMsgs.size) {
    console.log('\n   (참고) 지금까지 나온 CSP 관련 콘솔 줄:');
    for (const [u, list] of cspMsgs) console.log(`     ${u}: ${list.length}줄  ${JSON.stringify(list[0].slice(0, 110))}`);
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

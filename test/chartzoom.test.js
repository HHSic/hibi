const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 차트 확대·이동 — 휠로 좁히고, 끌어 옮기고, 두 번 눌러 되돌리고,
// 충분히 확대하면 막혀 있던 봉이 다시 풀리는가.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'czoom-'));
app.setPath('appData', tmp);
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (_ev, lvl, msg) => {
    if (w.webContents.getURL().includes('chart.html')) console.log(`  [차트창 ${lvl}] ${msg}`);
  });
  w.webContents.on('render-process-gone', (_ev, d) => console.log('  [죽음]', w.webContents.getURL().slice(-14), JSON.stringify(d)));
});
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(p)) || null;
const until = async (f, n = 160) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

/** 지금 화면에 몇 개가 보이는지 — 아래 안내 문구가 곧 그 수다 */
const SEEN = `(() => {
  const f = document.getElementById('foot').textContent;
  // 정규식을 안 쓴다 — 이 문자열은 템플릿 리터럴을 거쳐 창으로 들어가서
  // \\d 같은 이스케이프가 뭉개진다(실제로 /(d+)/(d+)/ 가 되어 창이 죽었다).
  const seg = (f.split('·')[1] || '').split('/');
  const shown = seg.length === 2 ? parseInt(seg[0], 10) : NaN;
  const total = seg.length === 2 ? parseInt(seg[1], 10) : NaN;
  return { foot: f,
    shown: Number.isFinite(shown) ? shown : null,
    total: Number.isFinite(total) ? total : null,
    candleBlocked: [...document.querySelectorAll('#modes .seg')].find((b) => b.textContent === '봉').disabled,
    rects: document.querySelectorAll('#plot svg rect').length,
    dates: [...document.querySelectorAll('#plot svg text')].map((t) => t.textContent).slice(-4) };
})()`;

/** 차트 한가운데에 휠을 굴린다 */
const wheel = (n) => `(() => {
  const svg = document.querySelector('#plot svg');
  const b = svg.getBoundingClientRect();
  for (let i = 0; i < ${n}; i++) {
    svg.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -100, clientX: b.left + b.width * 0.5, clientY: b.top + b.height * 0.5,
      bubbles: true, cancelable: true
    }));
  }
})()`;

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true, chartRange: '1y' });
  store.addStock({ ticker: 'NVDA', name: '엔비디아', market: 'US' });
  ipcMain.emit('stocks:open');
  const sw = await until(async () => winBy('stocks.html'));
  await sleep(3500);
  await sw.webContents.executeJavaScript(`document.querySelector('.row.tap').click()`);
  const cw = await until(async () => winBy('chart.html'));
  const wc = cw.webContents;
  await until(async () => (await wc.executeJavaScript(`!!document.querySelector('#plot svg path, #plot svg rect')`)) === true);
  await sleep(500);

  const a = await wc.executeJavaScript(SEEN);
  console.log('  처음  ', JSON.stringify({ foot: a.foot, blocked: a.candleBlocked }));
  ok(a.shown === null, '처음엔 확대 안 된 상태', a.foot);
  ok(a.candleBlocked, '1년은 봉이 막혀 있다', a.candleBlocked);

  // 휠로 확대
  await wc.executeJavaScript(wheel(10));
  await sleep(600);
  const b = await wc.executeJavaScript(SEEN);
  console.log('  확대후', JSON.stringify({ foot: b.foot, blocked: b.candleBlocked }));
  // 휠 10번이면 0.82^10 ≈ 0.14 배가 되어야 한다 — 한 번만 먹으면 여기서 걸린다
  ok(b.shown && b.shown < b.total * 0.3, '휠을 굴린 만큼 겹쳐서 확대된다', { 보임: b.shown, 전체: b.total });
  ok(!b.candleBlocked, '충분히 확대하니 봉이 풀렸다', b.candleBlocked);

  // 끌어서 이동 — 보이는 날짜가 달라져야 한다
  const beforeDates = b.dates.join('|');
  await wc.executeJavaScript(`(() => {
    const svg = document.querySelector('#plot svg');
    const r = svg.getBoundingClientRect();
    const opt = (x) => ({ button: 0, pointerId: 1, clientX: x, clientY: r.top + r.height / 2, bubbles: true });
    svg.dispatchEvent(new PointerEvent('pointerdown', opt(r.left + r.width * 0.6)));
    svg.dispatchEvent(new PointerEvent('pointermove', opt(r.left + r.width * 0.2)));
    svg.dispatchEvent(new PointerEvent('pointerup', opt(r.left + r.width * 0.2)));
  })()`);
  await sleep(600);
  const c = await wc.executeJavaScript(SEEN);
  ok(c.dates.join('|') !== beforeDates, '끌면 보이는 구간이 옮겨진다', { 전: beforeDates, 후: c.dates.join('|') });
  ok(c.shown === b.shown, '옮겨도 보이는 개수는 그대로', [b.shown, c.shown]);

  // 두 번 눌러 되돌리기
  await wc.executeJavaScript(`document.querySelector('#plot svg').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(600);
  const d = await wc.executeJavaScript(SEEN);
  ok(d.shown === null && d.candleBlocked, '두 번 누르면 전체로 돌아간다', d.foot);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

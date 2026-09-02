const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 칸 사이를 끌어 세로 길이를 바꾼다 + 상한이 화면에 맞춰 늘어난다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, screen } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'split-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

const M = `(() => {
  const r = (s) => { const el = typeof s === 'string' ? document.querySelector(s) : s;
    return el ? Math.round(el.getBoundingClientRect().height) : 0; };
  const cal = document.getElementById('cal');
  return { 창: innerHeight, 쉬는칸: r('.inner'), 메일칸: r('#mailpanel'), 달력칸: r('#cal'),
           달력잘림: Math.max(0, cal.scrollHeight - cal.clientHeight),
           mailVar: document.getElementById('card').style.getPropertyValue('--mail-h') };
})()`;

/** 손잡이를 진짜로 끈다 — 합성 이벤트가 아니라 창에 넣는 입력으로 */
async function drag(wc, id, dy) {
  const box = await wc.executeJavaScript(`(() => {
    const b = document.getElementById('${id}').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  const send = (type, y) => wc.sendInputEvent({ type, x: box.x, y, button: 'left', clickCount: 1 });
  send('mouseDown', box.y);
  for (let i = 1; i <= 6; i++) { send('mouseMove', box.y + Math.round((dy * i) / 6)); await sleep(35); }
  send('mouseUp', box.y + dy);
  await sleep(300);
}

app.whenReady().then(async () => {
  await sleep(2500);
  const w = winBy('widget.html'); const wc = w.webContents; w.show();
  const wa = screen.getPrimaryDisplay().workAreaSize;
  store.setSettings({ mailEnabled: true, mailShow: true });
  await sleep(1400);
  await wc.executeJavaScript(`document.getElementById('btn-mail').click()`); await sleep(800);
  await wc.executeJavaScript(`document.getElementById('btn-cal').click()`); await sleep(800);
  await wc.executeJavaScript(`document.getElementById('cal-month').click()`); await sleep(1200);

  const a = await wc.executeJavaScript(M);
  console.log('  처음  ', JSON.stringify(a));
  ok(a.달력잘림 === 0, '달력이 더는 안 잘린다', a.달력잘림);

  // 메일 칸을 60px 늘린다
  await drag(wc, 'grip-mail', 60);
  const b = await wc.executeJavaScript(M);
  console.log('  끈 뒤 ', JSON.stringify(b));
  ok(b.메일칸 > a.메일칸 + 30, '메일 칸이 늘었다', [a.메일칸, b.메일칸]);
  ok(b.달력칸 < a.달력칸 - 30, '달력이 그만큼 내줬다', [a.달력칸, b.달력칸]);
  ok(Math.abs(b.창 - a.창) <= 2, '창 높이는 그대로다', [a.창, b.창]);
  ok(store.settings.panelMailH === parseInt(b.mailVar, 10), '끈 높이가 저장된다',
    [store.settings.panelMailH, b.mailVar]);

  // 달력을 다시 그려도 되돌아가지 않아야 한다
  await wc.executeJavaScript(`document.getElementById('cal-next').click()`); await sleep(900);
  const c = await wc.executeJavaScript(M);
  ok(Math.abs(c.메일칸 - b.메일칸) <= 2, '달을 넘겨도 넓힌 채로 있다', [b.메일칸, c.메일칸]);

  // 두 번 누르면 되돌리기
  await wc.executeJavaScript(`document.getElementById('grip-mail').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(500);
  const d = await wc.executeJavaScript(M);
  ok(!d.mailVar && store.settings.panelMailH == null, '두 번 누르면 «알아서»로 돌아간다',
    [d.mailVar, store.settings.panelMailH]);

  // 세로 상한이 화면에 맞춰 늘어났나.
  // getMaximumSize() 로는 못 본다 — resizable:false 인 창은 지금 크기를 돌려준다.
  // 우리 스스로 clamp 하는 자리(widget:set-bounds)에 터무니없는 값을 넣어 본다.
  const { ipcMain } = require('electron');
  const before = w.getBounds();
  ipcMain.emit('widget:set-bounds', {}, { x: before.x, y: before.y, width: before.width, height: 5000, dir: 's' });
  await sleep(400);
  const grown = w.getBounds().height;
  console.log(`  작업영역 세로 ${wa.height} · 끝까지 늘렸을 때 ${grown} (예전 상한은 520+여백)`);
  ok(grown > 560, '상한이 화면 크기를 따라간다', grown);
  ok(grown <= wa.height, '그래도 화면은 안 넘는다', [grown, wa.height]);
  ipcMain.emit('widget:set-bounds', {}, { x: before.x, y: before.y, width: before.width, height: before.height, dir: 's' });
  await sleep(300);

  fs.writeFileSync(path.join(OUT, 'split-after.png'), (await wc.capturePage()).toPNG());
  console.log(bad ? bad + '개 실패' : '모두 통과');
  app.exit(bad ? 1 : 0);
});

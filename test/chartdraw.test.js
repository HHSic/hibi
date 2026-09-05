const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 차트가 실제로 그려지는가 — 봉·거래량·축·십자선·원화.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdraw-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(p)) || null;
const until = async (f, n = 160) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

const SHOT = `(() => {
  const svg = document.querySelector('#plot svg');
  if (!svg) return { svg: false };
  return {
    svg: true,
    rects: svg.querySelectorAll('rect').length,
    lines: svg.querySelectorAll('line').length,
    paths: svg.querySelectorAll('path').length,
    texts: [...svg.querySelectorAll('text')].map((t) => t.textContent),
    note: getComputedStyle(document.getElementById('note')).display,
    px: document.getElementById('px').textContent,
    ohlc: document.getElementById('ohlc').textContent.trim(),
    modeOn: [...document.querySelectorAll('#modes .seg')].filter((b) => b.classList.contains('on')).map((b) => b.textContent)
  };
})()`;

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true });
  store.addStock({ ticker: 'NVDA', name: '엔비디아', market: 'US' });
  ipcMain.emit('stocks:open');
  const sw = await until(async () => winBy('stocks.html'));
  await sleep(3500);
  await sw.webContents.executeJavaScript(`document.querySelector('.row.tap:not(.idx)').click()`);
  const cw = await until(async () => winBy('chart.html'));
  ok(!!cw, '차트 창이 열렸다');
  const wc = cw.webContents;
  await until(async () => (await wc.executeJavaScript(`!!document.querySelector('#plot svg path, #plot svg rect')`)) === true);
  await sleep(400);

  // 1개월 = 봉 (auto)
  let st = await wc.executeJavaScript(SHOT);
  console.log('  [1개월/자동]', JSON.stringify({ rects: st.rects, lines: st.lines, paths: st.paths, modeOn: st.modeOn, px: st.px }));
  ok(st.svg && st.rects > 10, '봉이 그려졌다 (사각형 여러 개)', st.rects);
  ok(st.modeOn.includes('봉'), '자동은 1개월을 봉으로 본다', st.modeOn);
  ok(st.texts.length >= 6, '축 눈금 글자가 있다', st.texts.length);
  ok(/억|만|—/.test(st.ohlc), '거래량 요약이 있다', st.ohlc);

  // 선으로 바꾸기
  await wc.executeJavaScript(`[...document.querySelectorAll('#modes .seg')].find(b=>b.textContent==='선').click()`);
  await sleep(500);
  st = await wc.executeJavaScript(SHOT);
  ok(st.paths >= 2, '선으로 바꾸면 path 가 나온다 (선+채움)', st.paths);
  ok(st.modeOn.includes('선'), '선이 켜졌다', st.modeOn);

  // 1년 = 봉이 촘촘해 선으로 넘어감
  await wc.executeJavaScript(`[...document.querySelectorAll('#ranges .seg')].find(b=>b.textContent==='1년').click()`);
  await sleep(2500);
  await wc.executeJavaScript(`[...document.querySelectorAll('#modes .seg')].find(b=>b.textContent==='봉').click()`);
  await sleep(600);
  const dense = await wc.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('#modes .seg')].find(x => x.textContent === '봉');
    return { disabled: b.disabled, title: b.title };
  })()`);
  ok(dense.disabled && /촘촘/.test(dense.title), '1년은 봉이 촘촘해 막고 알려준다', dense);

  // 짚어 보기
  await wc.executeJavaScript(`(() => {
    const svg = document.querySelector('#plot svg');
    const b = svg.getBoundingClientRect();
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: b.left + b.width * 0.4, clientY: b.top + b.height * 0.4, bubbles: true }));
  })()`);
  await sleep(300);
  const hov = await wc.executeJavaScript(`(() => ({
    ohlc: document.getElementById('ohlc').textContent.trim(),
    shown: document.querySelector('#plot svg g') ? document.querySelector('#plot svg g').getAttribute('visibility') : null
  }))()`);
  console.log('  짚음', JSON.stringify(hov));
  ok(hov.shown === 'visible', '십자선이 보인다', hov.shown);
  ok(/시 .*고 .*저 .*종 /.test(hov.ohlc), '머리글에 시·고·저·종이 뜬다', hov.ohlc.slice(0, 60));

  // 원화 보기
  await sw.webContents.executeJavaScript(`document.getElementById('krw').click()`);
  await sleep(2500);
  await wc.executeJavaScript(`(async () => {})()`);
  await wc.executeJavaScript(`document.getElementById('refresh').click()`);
  await sleep(2500);
  const krw = await wc.executeJavaScript(`document.getElementById('px').textContent`);
  console.log('  원화 전/후', st.px, '→', krw);
  const before = parseFloat(String(st.px).replace(/,/g, ''));
  const after = parseFloat(String(krw).replace(/,/g, ''));
  ok(after > before * 100, '원화로 환산되어 값이 커졌다', { before, after });

  fs.writeFileSync(path.join(OUT, 'chart-shot.png'), (await wc.capturePage()).toPNG());
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

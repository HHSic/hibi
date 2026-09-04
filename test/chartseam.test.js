const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 접점 검사 — 차트 창과 원화 토글의 «배선»이 살아 있는가.
// 실제 차트 그리기(renderer/chart.js)와 환율(src/fx.js)은 아직 비어 있어도,
// 창이 열리고 자료를 물어보고 설정이 바뀌는 길은 이미 통해야 한다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chartseam-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(p)) || null;
const until = async (f, n = 120) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true });
  store.addStock({ ticker: '005930', name: '삼성전자', market: 'KR' });
  ipcMain.emit('stocks:open');
  const sw = await until(async () => winBy('stocks.html'));
  ok(!!sw, '주식 창이 열렸다');
  await sleep(3500);   // 시세 한 바퀴

  // ── 원화 토글 ──
  const before = !!store.settings.stocksKrw;
  const hasKrw = await sw.webContents.executeJavaScript(`!!document.getElementById('krw')`);
  ok(hasKrw, '«원화» 단추가 있다');
  await sw.webContents.executeJavaScript(`document.getElementById('krw').click()`);
  await until(async () => store.settings.stocksKrw !== before);
  ok(store.settings.stocksKrw === !before, '누르면 설정이 바뀐다', store.settings.stocksKrw);
  const lit = await sw.webContents.executeJavaScript(`document.getElementById('krw').classList.contains('on')`);
  ok(lit, '켜진 표시가 들어온다', lit);

  // ── 종목 눌러서 차트 ──
  const tapped = await sw.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.row.tap'); if (!r) return null;
    r.click(); return r.textContent.slice(0, 12);
  })()`);
  ok(!!tapped, '누를 수 있는 종목 줄이 있다', tapped);
  const cw = await until(async () => winBy('chart.html'));
  ok(!!cw, '차트 창이 열렸다');
  await sleep(1200);
  const st = await cw.webContents.executeJavaScript(`(() => ({
    name: document.getElementById('name').textContent,
    ticker: document.getElementById('ticker').textContent,
    ranges: [...document.querySelectorAll('#ranges .seg')].map((b) => b.textContent),
    on: document.querySelector('#ranges .seg.on')?.textContent || null,
    note: document.getElementById('note').textContent
  }))()`);
  console.log('  차트창', JSON.stringify(st));
  ok(st.ticker === '005930', '고른 종목이 실렸다', st.ticker);
  ok(st.ranges.length === 5 && st.on === '1개월', '기간 고르기가 그려졌다', [st.ranges, st.on]);
  ok(/아직 못 불러옵니다|자료가 없습니다/.test(st.note),
    '자료가 아직 없어도 «불러오는 중»에 안 갇힌다', st.note);

  // 같은 창을 돌려 쓰는가
  await sw.webContents.executeJavaScript(`document.querySelector('.row.tap').click()`);
  await sleep(600);
  const n = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()
    && w.webContents.getURL().includes('chart.html')).length;
  ok(n === 1, '또 눌러도 창이 하나뿐', n);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

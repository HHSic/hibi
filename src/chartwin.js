// 차트 창 — 주식 창에서 종목을 누르면 뜨는 큰 차트.
//
// 창 하나를 돌려 쓴다. 다른 종목을 누르면 새 창을 만들지 않고 그 창의 종목만 바꾼다 —
// 열 때마다 창이 쌓이면 닫는 것이 일이 된다.
//
// 지난 시세는 stocks.history() 가 준다 (없으면 조용히 빈 차트).
// 그리는 것은 renderer/chart.js 가 한다.

const { BrowserWindow, ipcMain, screen } = require('electron');
const store = require('./store');
const glass = require('./glass');
const stocks = require('./stocks');
const fx = require('./fx');
const { PRELOAD, page, PAD, clamp, glassQuery, maxSize } = require('./win');

const MIN = { width: 420 + PAD, height: 300 + PAD };
const DEFAULT = { width: 720 + PAD, height: 460 + PAD };

let chartWin = null;
let cur = null;        // 지금 보고 있는 종목 { ticker, name, market }

/** 주식 창에서 종목을 눌렀을 때 */
function openChart(item) {
  if (!item || !item.ticker) return;
  cur = { ticker: String(item.ticker), name: String(item.name || item.ticker), market: item.market || 'KR' };

  if (chartWin && !chartWin.isDestroyed()) {
    chartWin.webContents.send('chart:show', cur);   // 창은 그대로, 종목만 바꾼다
    chartWin.focus();
    return;
  }

  const size = store.settings.chartSize || DEFAULT;
  const max = maxSize(screen.getPrimaryDisplay());
  chartWin = new BrowserWindow({
    width: Math.round(clamp(size.width, MIN.width, max.width)),
    height: Math.round(clamp(size.height, MIN.height, max.height)),
    minWidth: MIN.width,
    minHeight: MIN.height,
    frame: false,
    resizable: false,      // 위젯과 같은 이유 — 네이티브 리사이즈가 배율에서 창을 부풀린다
    alwaysOnTop: true,
    skipTaskbar: true,
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  chartWin.loadFile(page('chart.html'), {
    query: glassQuery({
      radius: String(store.settings.radius),
      ticker: cur.ticker,
      name: cur.name,
      market: cur.market,
      range: store.settings.chartRange || '1mo'
    })
  });
  chartWin.on('closed', () => { chartWin = null; cur = null; });
}

function closeChart() {
  if (chartWin && !chartWin.isDestroyed()) chartWin.close();
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.on('chart:open', (_e, item) => openChart(item));
ipcMain.on('chart:close', () => closeChart());

/**
 * 지난 시세를 준다. stocks.history() 가 아직 없으면 빈 것을 돌려준다 —
 * 그래야 차트 화면이 «불러오는 중»에 갇히지 않고 «자료 없음»을 보여준다.
 */
ipcMain.handle('chart:data', async (_e, { ticker, market, range } = {}) => {
  if (typeof stocks.history !== 'function') return { points: [], range, unsupported: true };
  try {
    const got = await stocks.history({ ticker, market }, range || '1mo');
    if (!got) return { points: [], range };
    // 원화 보기가 켜져 있으면 환율만 같이 보낸다 — 값을 미리 바꿔 두면 토글할 때마다
    // 다시 받아야 한다. 원 통화 그대로 두고 그릴 때 곱하는 편이 싸다.
    // 거래량은 주식 «수»라 환산 대상이 아니다.
    let krwRate = null;
    if (store.settings.stocksKrw && got.currency && got.currency !== 'KRW') {
      krwRate = await fx.rate(got.currency);
    }
    return { ...got, krwRate, mode: store.settings.chartMode || 'auto' };
  } catch (e) {
    return { points: [], range, error: e.message };
  }
});

/** 고른 보기(선/봉)를 기억한다 */
ipcMain.on('chart:set-mode', (_e, mode) => {
  if (['auto', 'line', 'candle'].includes(mode)) store.setSettings({ chartMode: mode });
});

/** 고른 기간을 기억한다 — 다음에 열 때 같은 기간으로 */
ipcMain.on('chart:set-range', (_e, range) => {
  if (typeof range === 'string' && range) store.setSettings({ chartRange: range });
});

ipcMain.handle('chart:bounds', () => {
  if (!chartWin || chartWin.isDestroyed()) return null;
  const [width, height] = chartWin.getSize();
  const [x, y] = chartWin.getPosition();
  return { x, y, width, height };
});

ipcMain.on('chart:set-bounds', (_e, b) => {
  if (!chartWin || chartWin.isDestroyed() || !b) return;
  const max = maxSize(screen.getDisplayMatching(chartWin.getBounds()));
  const width = Math.round(clamp(b.width, MIN.width, max.width));
  const height = Math.round(clamp(b.height, MIN.height, max.height));
  chartWin.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width, height });
  store.setSettings({ chartSize: { width, height } });
});

ipcMain.on('chart:move', (_e, pos) => {
  if (!chartWin || chartWin.isDestroyed() || !pos) return;
  chartWin.setPosition(Math.round(pos.x), Math.round(pos.y));
});

/** 주식 기능을 끄면 이 창도 같이 닫는다 */
function win() { return chartWin && !chartWin.isDestroyed() ? chartWin : null; }

module.exports = { openChart, closeChart, win };

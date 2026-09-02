// 주식 시세 창.
//
// 위젯 안에 패널로 두지 않고 창으로 뺐다. 늘 눈앞에 값이 떠 있으면 이 앱의 취지와
// 정면으로 부딪힌다 — 끊고 쉬라고 만든 앱이 계속 들여다볼 이유를 만들어 준다.
// 그래서 시세는 «창이 열려 있는 동안만» 받는다. 닫아 두면 네트워크를 아예 안 쓴다.

const { BrowserWindow, ipcMain } = require('electron');
const store = require('./store');
const glass = require('./glass');
const evlog = require('./evlog');
const stocks = require('./stocks');
const { PRELOAD, page, PAD, clamp, glassQuery, maxSize } = require('./win');

// 시세와 마지막으로 받은 시각. 화면에는 이 값을 그대로 실어 보낸다.
const stockState = { rows: [], at: 0, fetchedAt: 0, lagSec: null, failed: 0, error: null, loading: false };

let stocksWin = null;
const STOCK_POLL_MS = 60_000;
let stockTimer = null;

async function refreshStocks() {
  if (!stocksWin || stocksWin.isDestroyed()) return;
  if (stockState.loading) return;
  stockState.loading = true;
  sendStocks();
  try {
    const r = await stocks.build({
      list: store.stocksWatch,
      withIndexes: store.settings.stocksIndexes !== false,
      market: store.settings.stocksMarket || 'all'
    });
    stockState.rows = r.rows;
    stockState.at = r.at;
    stockState.lagSec = r.lagSec;
    stockState.failed = r.failed;
    stockState.error = null;
    stockState.fetchedAt = Date.now();
  } catch (e) {
    stockState.error = e.message || '시세를 못 받았습니다';
    evlog.log('주식', `시세 실패 · ${stockState.error}`);
  } finally {
    stockState.loading = false;
    sendStocks();
  }
}

function sendStocks() {
  if (!stocksWin || stocksWin.isDestroyed()) return;
  stocksWin.webContents.send('stocks:data', {
    rows: stockState.rows,
    watch: store.stocksWatch,
    at: stockState.at,
    lagSec: stockState.lagSec,
    failed: stockState.failed,
    error: stockState.error,
    loading: stockState.loading,
    market: store.settings.stocksMarket || 'all',
    indexes: store.settings.stocksIndexes !== false
  });
}

function openStocks() {
  if (!store.settings.stocksEnabled) return;
  if (stocksWin && !stocksWin.isDestroyed()) {
    if (stocksWin.isMinimized()) stocksWin.restore();
    stocksWin.moveTop();
    stocksWin.focus();
    return;
  }
  const saved = store.settings.stocksSize;
  const cap = maxSize(null);
  const width = Math.round(clamp((saved && saved.width) || 380 + PAD, 300, cap.width));
  const height = Math.round(clamp((saved && saved.height) || 520 + PAD, 260, cap.height));

  stocksWin = new BrowserWindow({
    width, height, minWidth: 300, minHeight: 260,
    frame: false,
    // 크기 조절은 렌더러의 리사이즈 존이 맡는다 (네이티브는 투명 창에서 폭주한다)
    resizable: false,
    // 보는 동안 다른 창도 쓴다 — 위에 붙들지 않고 작업표시줄에 올린다
    alwaysOnTop: false, skipTaskbar: false,
    title: '주식',
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  stocksWin.loadFile(page('stocks.html'), { query: glassQuery({ radius: '18' }) });
  stocksWin.webContents.once('did-finish-load', () => {
    sendStocks();
    refreshStocks();
  });
  // 열려 있는 동안만 주기적으로 받는다
  stockTimer = setInterval(() => {
    if (Date.now() - stockState.fetchedAt >= STOCK_POLL_MS) refreshStocks();
  }, 15_000);
  stocksWin.on('closed', () => {
    stocksWin = null;
    if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  });
}

ipcMain.on('stocks:open', openStocks);
ipcMain.on('stocks:close', () => stocksWin && !stocksWin.isDestroyed() && stocksWin.close());
ipcMain.handle('stocks:refresh', async () => { await refreshStocks(); return true; });

ipcMain.handle('stocks:search', (_e, q) => stocks.search(q, 8).catch(() => []));

ipcMain.handle('stocks:add', async (_e, input) => {
  // 넣기 전에 진짜 있는 종목인지 확인한다 — 오타로 «못 찾음» 줄이 목록에 박히지 않게
  const found = await stocks.lookup(input).catch(() => null);
  if (!found) return { ok: false, message: '그런 종목을 못 찾았습니다' };
  const before = store.stocksWatch.length;
  store.addStock(found);
  await refreshStocks();
  return {
    ok: true,
    added: store.stocksWatch.length > before,
    name: found.name,
    message: store.stocksWatch.length > before ? null: '이미 목록에 있습니다'
  };
});

ipcMain.handle('stocks:remove', async (_e, ticker) => {
  store.removeStock(ticker);
  await refreshStocks();
  return true;
});

ipcMain.handle('stocks:set-app', async (_e, patch) => {
  store.setSettings(patch || {});
  await refreshStocks();
  return true;
});

/** algo-trader의 목록을 «한 번» 가져온다 — 그 뒤로는 서로 상관없다 */
ipcMain.handle('stocks:import', async (_e, root) => {
  const file = stocks.defaultWatchPath(String(root || '').trim() || undefined);
  const list = stocks.importFrom(file);
  if (!list.length) return { ok: false, message: `목록을 못 읽었습니다 — ${file}` };
  let added = 0;
  for (const item of list) {
    const before = store.stocksWatch.length;
    store.addStock(item);
    if (store.stocksWatch.length > before) added++;
  }
  await refreshStocks();
  return { ok: true, added, total: list.length, file };
});

ipcMain.handle('stocks:bounds', () => {
  if (!stocksWin || stocksWin.isDestroyed()) return null;
  const cap = maxSize(stocksWin);
  // 상한은 이름을 달리 붙인다 — 그냥 펼치면 width/height가 창의 실제 크기를 덮어쓴다
  return { ...stocksWin.getBounds(), maxWidth: cap.width, maxHeight: cap.height };
});
ipcMain.on('stocks:set-bounds', (_e, b) => {
  if (!stocksWin || stocksWin.isDestroyed() || !b) return;
  stocksWin.setBounds({
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.round(b.width), height: Math.round(b.height)
  });
  store.setSettings({ stocksSize: { width: Math.round(b.width), height: Math.round(b.height) } });
});
ipcMain.on('stocks:move', (_e, pos) => {
  if (!stocksWin || stocksWin.isDestroyed() || !pos) return;
  stocksWin.setPosition(Math.round(pos.x), Math.round(pos.y));
});

/** 설정에서 주식을 끄면 열려 있던 창도 닫는다 */
function closeStocks() {
  if (stocksWin && !stocksWin.isDestroyed()) stocksWin.close();
}

module.exports = { openStocks, closeStocks };

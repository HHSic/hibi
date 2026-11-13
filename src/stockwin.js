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
const fx = require('./fx');
const chartwin = require('./chartwin');
const { PRELOAD, page, PAD, clamp, glassQuery, maxSize, lockToOurPage } = require('./win');

// 시세와 마지막으로 받은 시각. 화면에는 이 값을 그대로 실어 보낸다.
const stockState = { rows: [], at: 0, fetchedAt: 0, lagSec: null, failed: 0, error: null, loading: false };

let stocksWin = null;
// 우리가 정한 창 크기. 드래그 기준을 여기서 준다 — getBounds 로 되읽으면 DPI 배율에서
// 요청보다 1px 크게 나와, 다음 드래그가 그 부푼 값을 기준으로 삼아 잡을 때마다 커진다
// (사용자가 «반올림 오류로 계속 커진다»고 한 것). 위젯이 겪던 것과 같은 병.
let stockSize = null;
const STOCK_POLL_MS = 60_000;
let stockTimer = null;

// 순위(TOP 100)는 시장·정렬마다 제 칸에 든다 — 다시 고르면 바로 보이고, 묵지 않았으면 다시 안 받는다.
// 관심 줄(stockState)과 따로 둔다. 한 칸을 같이 쓰면 늦게 온 답이 다른 보기를 덮는다.
const topCache = new Map();   // 'KR:up' → { rows, krwRows, status, at, tried, error }
const topGoing = new Map();   // 'KR:up' → 받는 중인 약속. 같은 고르기를 겹쳐 부르지 않는다
const topKey = (p) => `${p.market}:${p.sort}`;
const pickNow = () => stocks.topPick(store.settings);
const winOpen = () => !!stocksWin && !stocksWin.isDestroyed();

/** 환산한 줄은 사본에 붙인다 — 칸에 든 줄을 고치면 원화를 껐다 켤 때 값이 두 번 곱해진다 */
function toKrw(rows) {
  return fx.attach(rows.map((r) => ({ ...r })));
}

/** 화면 글은 한국어다 — getaddrinfo ENOTFOUND 같은 node 원문은 기록에만 남긴다 */
const topErrorText = (e) => (/^HTTP \d+$|[가-힣]/.test(e.message || '') ? e.message : '네트워크에 연결하지 못했습니다');

async function loadTop(key, pick) {
  try {
    const r = await stocks.top(pick);
    // 시세 쪽처럼 환산까지 끝낸 뒤 칸에 넣는다 — 먼저 넣으면 1분마다 달러로 깜빡였다가 원으로 돌아온다
    const krwRows = store.settings.stocksKrw && winOpen() ? await toKrw(r.rows) : null;
    const now = Date.now();
    topCache.set(key, { rows: r.rows, krwRows, status: r.status, at: now, tried: now, error: null });
  } catch (e) {
    // 마지막 줄은 지킨다 — 잠깐 끊겼다고 목록이 사라지면 안 된다
    evlog.log('주식', `순위 실패 · ${e.message}`);
    const old = topCache.get(key) || { rows: [], krwRows: null, status: null, at: 0 };
    topCache.set(key, { ...old, tried: Date.now(), error: topErrorText(e) });
  }
}

/**
 * 고르기 하나를 받는다. 답은 제 칸에만 들어가니 옛 고르기의 답이 늦게 와도 새 고르기를 못 덮고,
 * 받는 중에 고르기가 바뀌면 새 고르기는 따로 바로 받는다 (관심 쪽의 «받는 중이면 돌아가기»에 안 걸린다).
 */
function fetchTop(pick) {
  const key = topKey(pick);
  if (!topGoing.has(key)) {
    topGoing.set(key, loadTop(key, pick).finally(() => topGoing.delete(key)));
  }
  return topGoing.get(key);
}

/** force 는 «지금 시세 확인» 단추 — 묵지 않았어도 받는다. 그 밖에는 묵지 않은 칸을 그대로 쓴다 */
async function refreshTop(force) {
  const pick = pickNow();
  const hit = topCache.get(topKey(pick));
  const fresh = hit && !hit.error && Date.now() - hit.at < STOCK_POLL_MS;
  const going = force || !fresh ? fetchTop(pick) : null;
  sendStocks();
  if (going) await going;
  // 묵지 않은 칸에 원화를 켰거나, 받는 사이에 켰을 때. 기다리는 동안 고르기가 바뀌었을 수 있어 지금 고른 칸을 다시 본다
  const cur = topCache.get(topKey(pickNow()));
  if (cur && store.settings.stocksKrw && !cur.krwRows && cur.rows.length && winOpen()) {
    cur.krwRows = await toKrw(cur.rows);
  }
  sendStocks();
}

async function refreshStocks(force = false) {
  if (!stocksWin || stocksWin.isDestroyed()) return;
  if (pickNow().view === 'top') { await refreshTop(force); return; }
  if (stockState.loading) return;
  stockState.loading = true;
  sendStocks();
  try {
    const r = await stocks.build({
      list: store.stocksWatch,
      withIndexes: store.settings.stocksIndexes !== false,
      market: store.settings.stocksMarket || 'all'
    });
    // 원화 보기를 켰으면 환산가를 붙인다. fx 가 환율을 못 구하면 조용히 그대로 —
    // 화면 쪽은 krwPrice 가 없으면 원래 통화로 그린다.
    stockState.rows = store.settings.stocksKrw ? await fx.attach(r.rows) : r.rows;
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

/** 관심 목록을 고친 뒤. TOP 100 보기는 관심 시세를 안 쓰니 목록만 보낸다 — 순위를 다시 받으면 별의 답이 네이버를 기다린다 */
async function afterWatchEdit() {
  if (pickNow().view === 'top') sendStocks();
  else await refreshStocks();
}

function sendStocks() {
  if (!stocksWin || stocksWin.isDestroyed()) return;
  const pick = pickNow();
  const shared = {
    watch: store.stocksWatch,
    market: store.settings.stocksMarket || 'all',
    indexes: store.settings.stocksIndexes !== false,
    krw: !!store.settings.stocksKrw,
    view: pick.view,
    topMarket: pick.market,
    topSort: pick.sort
  };
  if (pick.view === 'top') {
    const hit = topCache.get(topKey(pick));
    stocksWin.webContents.send('stocks:data', {
      ...shared,
      rows: (hit && ((shared.krw && hit.krwRows) || hit.rows)) || [],
      at: hit ? hit.at : 0,
      lagSec: null,
      failed: 0,
      status: hit ? hit.status : null,
      error: hit ? hit.error : null,
      loading: topGoing.has(topKey(pick))
    });
    return;
  }
  stocksWin.webContents.send('stocks:data', {
    ...shared,
    rows: stockState.rows,
    at: stockState.at,
    lagSec: stockState.lagSec,
    failed: stockState.failed,
    error: stockState.error,
    loading: stockState.loading
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
  stockSize = { width, height };

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
  // 우리 페이지 밖으로 못 나가게 (남의 주소로 가면 이 창이 다리를 쥔 브라우저가 된다)
  lockToOurPage(stocksWin);
  // 글이 빽빽한 창이라 유리를 한 단계 진하게 받는다 (계산은 win.js effScrim)
  stocksWin.loadFile(page('stocks.html'), { query: glassQuery({ radius: '18', dense: '1' }) });
  stocksWin.webContents.once('did-finish-load', () => {
    sendStocks();
    refreshStocks();
  });
  // 열려 있는 동안만 주기적으로 받는다
  stockTimer = setInterval(() => {
    const pick = pickNow();
    // 순위는 실패해도 «해 본 때»부터 센다 — 묵지 않은 줄이 없다고 15초마다 네이버를 두드리지 않게
    const hit = pick.view === 'top' ? topCache.get(topKey(pick)) : null;
    const last = pick.view === 'top' ? (hit ? hit.tried : 0) : stockState.fetchedAt;
    if (Date.now() - last >= STOCK_POLL_MS) refreshStocks();
  }, 15_000);
  stocksWin.on('closed', () => {
    stocksWin = null;
    stockSize = null;
    if (stockTimer) { clearInterval(stockTimer); stockTimer = null; }
  });
}

ipcMain.on('stocks:open', openStocks);
ipcMain.on('stocks:close', () => {
  chartwin.closeChart();
  if (stocksWin && !stocksWin.isDestroyed()) stocksWin.close();
});
ipcMain.handle('stocks:refresh', async () => { await refreshStocks(true); return true; });

ipcMain.handle('stocks:search', (_e, q) => stocks.search(q, 8).catch(() => []));

ipcMain.handle('stocks:add', async (_e, input) => {
  // 넣기 전에 진짜 있는 종목인지 확인한다 — 오타로 «못 찾음» 줄이 목록에 박히지 않게
  const found = await stocks.lookup(input).catch(() => null);
  if (!found) return { ok: false, message: '그런 종목을 못 찾았습니다' };
  const before = store.stocksWatch.length;
  store.addStock(found);
  await afterWatchEdit();
  return {
    ok: true,
    added: store.stocksWatch.length > before,
    name: found.name,
    message: store.stocksWatch.length > before ? null: '이미 목록에 있습니다'
  };
});

ipcMain.handle('stocks:remove', async (_e, ticker) => {
  store.removeStock(ticker);
  await afterWatchEdit();
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
  const b = stocksWin.getBounds();
  // 위치(x,y)는 실제에서, 크기(width,height)는 «우리가 정한 값»에서 준다.
  // getBounds 의 크기는 DPI 배율에서 1px 부풀어 있어, 그걸 기준 삼으면 누적된다.
  const size = stockSize || { width: b.width, height: b.height };
  return { x: b.x, y: b.y, width: size.width, height: size.height,
           maxWidth: cap.width, maxHeight: cap.height };
});
ipcMain.on('stocks:set-bounds', (_e, b) => {
  if (!stocksWin || stocksWin.isDestroyed() || !b) return;
  const w = Math.round(b.width);
  const h = Math.round(b.height);
  stocksWin.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: w, height: h });
  // 다음 드래그가 기준으로 삼을 값은 «우리가 방금 요청한 정수»다 (getBounds 아님)
  stockSize = { width: w, height: h };
  store.setSettings({ stocksSize: { width: w, height: h } });
});
ipcMain.on('stocks:move', (_e, pos) => {
  if (!stocksWin || stocksWin.isDestroyed() || !pos) return;
  // setPosition 을 쓰면 안 된다 — 배율 150%에서 부를 때마다 창이 1px 씩 부푼다(실측).
  // 옮기는 동안에는 초당 수십 번 부르므로 순식간에 화면만큼 커진다.
  // 크기를 함께 못박되 «우리가 정한 값»이어야 한다 — getBounds 로 되읽어 넣으면
  // 부푼 값이 도로 들어가 똑같이 자란다. (위젯·쓰기·메일 창은 이미 이렇게 한다.)
  const size = stockSize || (() => { const b = stocksWin.getBounds(); return { width: b.width, height: b.height }; })();
  stocksWin.setBounds({ x: Math.round(pos.x), y: Math.round(pos.y), ...size });
});

/** 설정에서 주식을 끄면 열려 있던 창도 닫는다 */
function closeStocks() {
  chartwin.closeChart();     // 주식 기능을 끄면 차트 창도 같이 치운다
  if (stocksWin && !stocksWin.isDestroyed()) stocksWin.close();
}

module.exports = { openStocks, closeStocks };

// 휴식 창 — 이 앱의 본체.
//
// 알림이 발동하면 화면마다 전체화면 창을 띄우고, 시간이 다 되면 닫는다.
// 여기 모여 있는 것:
//   · 배경으로 깔 바탕화면 사진을 «미리» 찍어 두기 (getSources 가 메인을 2.4초 멈춘다)
//   · 창을 «미리» 세워 두기 (warm pool — 만들고 읽는 데 0.4초가 걸린다)
//   · 등장 연출 고르기·내 파일 관리 (renderer/enter.js 가 그린다)
//   · 휴식 시작·끝, 그때의 기록·재예약
//
// 스케줄러·트레이·공유 상태는 main.js 가 들고 있다. 순환 require 를 피하려고
// 시작할 때 init(host) 로 받아 둔다 — 다른 창 모듈(statswin·stockwin)과 같은 방식이다.

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const store = require('./store');
const reminders = require('./reminders');
const statswin = require('./statswin');
const { PRELOAD, page } = require('./win');

/** 미룰 때 얼마나 미루나 — «5분 뒤에» */
const SNOOZE_MS = 5 * 60_000;

let overlayWins = [];
let overlayShots = new Map();

// main.js 가 들고 있는 것들. init() 전에 불릴 일은 없지만, 그래도 안전한 기본값을 둔다.
let host = {
  state: { onBreak: false, breakIds: [], breakEndsAt: 0, breakStartedAt: 0, dnd: null, paused: false },
  scheduler: null,
  updateTray: () => {},
  pushTick: () => {}
};
function init(h) { host = { ...host, ...h }; }

// ── 오버레이 ──────────────────────────────────────────────
/**
 * 휴식 화면 뒤에 깔리는 바탕화면 사진 — 미리 찍어 둔다.
 *
 * desktopCapturer.getSources()는 메인 프로세스를 통째로 1~2.4초 멈춘다 (화면 3대 기준).
 * 썸네일을 작게 해도, 아예 안 만들어도 마찬가지다 — 화면을 여는 값 자체가 그렇다.
 * 그래서 await를 떼는 것으로는 아무것도 안 고쳐진다. 그동안 창도 못 만들고 IPC도 안 받는다.
 *
 * 휴식을 띄우는 «그 순간»에 이걸 하면 알림이 그만큼 늦게 뜬다. 20분마다 오는 알림이면
 * 몰라도, 09:00에 울려야 하는 알림은 바로 티가 난다.
 * 그래서 아무도 안 기다리는 1분 전에 미리 찍어 둔다. blur(44px)로 뭉개져 깔리는
 * 배경이라 1분 묵어도 알아볼 수 없다.
 *
 * 휴식이 시작된 뒤에는 찍을 수 없다 — 바탕화면이 아니라 휴식 화면 자신이 찍힌다.
 */
const SHOT_LEAD_MS = 60_000;
/** 이보다 오래된 사진은 안 쓴다 */
const SHOT_FRESH_MS = 10 * 60_000;
let shotsAt = 0;

// 찍는 중이던 것이 «휴식이 끝난 뒤에» 뒤늦게 채워 넣지 않도록 세대를 센다
let shotSeq = 0;
/** 지금 찍고 있는 중이면 그 약속. 배경을 달라는 화면이 이걸 기다린다. */
let shotsReady = null;

/** 곧 올 휴식을 위해 미리 찍어 둔다. 아직 멀었으면 아무것도 안 한다. */
function prepareShots(now) {
  // 발표·전체화면 중에는 안 찍는다. 어차피 그 상태에서는 휴식을 안 띄우고,
  // 메인이 2초 멈추면 발표 화면이 끊겨 보인다 — 그게 바로 방해 금지가 막으려던 것이다.
  if (host.state.dnd) return;
  const next = host.scheduler.soonest();
  if (!next) return;
  const left = next.at - now;
  if (left <= 0 || left > SHOT_LEAD_MS) return;
  if (now - shotsAt < SHOT_LEAD_MS) return;   // 이번 휴식 것은 이미 찍어 뒀다
  shotsReady = captureScreens();
}

async function captureScreens() {
  const seq = ++shotSeq;
  overlayShots.clear();
  try {
    const displays = screen.getAllDisplays();
    const max = displays.reduce(
      (a, d) => ({ width: Math.max(a.width, d.size.width), height: Math.max(a.height, d.size.height) }),
      { width: 0, height: 0 }
    );
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // 이 그림은 blur(44px)로 뭉개져 깔린다 — 크게 떠도 보이는 건 똑같다.
      // 크기를 줄여도 찍는 시간은 그대로지만(화면을 긁는 값이 대부분이다),
      // 화면마다 넘겨줄 데이터가 675KB에서 220KB로 준다.
      thumbnailSize: { width: Math.round(max.width / 6), height: Math.round(max.height / 6) }
    });
    if (seq !== shotSeq) return;   // 그 사이 휴식이 끝났거나 새로 시작했다
    // 윈도우에서는 display_id 가 빈 문자열로 온다 (Electron 33에서 실측:
    // name="전체 화면" display_id="" id="screen:1:0"). 그걸 그대로 열쇠로 쓰면
    // 휴식 창이 제 화면 사진을 못 찾아 배경이 통째로 안 깔린다 — 오래 그랬다.
    // 짝을 못 지으면 순서로 맞춘다. 두 목록 모두 OS가 같은 순서로 준다.
    const usable = sources.filter((src) => !src.thumbnail.isEmpty());
    usable.forEach((src, i) => {
      const byId = displays.find((d) => String(d.id) === String(src.display_id || ''));
      const d = byId || displays[i];
      if (d) overlayShots.set(String(d.id), src.thumbnail.toDataURL());
    });
    shotsAt = Date.now();
  } catch (e) {
    console.warn('[overlay] capture failed:', e.message);
  }
}

function pickTip(type) {
  if (!type || !type.tips || !type.tips.length) return null;
  return type.tips[Math.floor(Math.random() * type.tips.length)];
}


// ── 등장 연출 ────────────────────────────────────────────
// 직접 넣은 그림·영상은 이 폴더에 복사해 둔다. 원본을 그대로 가리키면
// 사용자가 파일을 옮기거나 지운 순간 연출이 조용히 사라진다.
const ENTER_DIR = () => path.join(app.getPath('userData'), 'enters');
const ENTER_EXT = ['png', 'gif', 'webp', 'apng', 'webm', 'mp4'];

/** 화면 쪽이 읽을 수 있는 주소로 바꾼다 */
function enterAsset(id) {
  if (!id || !id.startsWith('my:')) return null;
  const item = store.enterCustom.find((x) => x.id === id.slice(3));
  if (!item) return null;
  const full = path.join(ENTER_DIR(), item.file);
  if (!fs.existsSync(full)) return null;   // 파일이 없어졌으면 연출도 없다
  return { url: pathToFileURL(full).href, kind: item.kind, ms: item.ms };
}

/**
 * 마우스가 있는 화면. 창을 만들 때 넘기는 display 값과 맞춰 문자열로 준다.
 * 못 읽으면 null 을 주고, 그때는 화면 쪽이 모두 그린다 (예전 동작).
 */
function cursorDisplayId() {
  try {
    return String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  } catch {
    return null;
  }
}

/** 설정 화면에 넘길 목록 — 미리 보려면 주소가 있어야 한다 */
function enterList() {
  return store.enterCustom.map((x) => ({
    ...x, url: pathToFileURL(path.join(ENTER_DIR(), x.file)).href
  }));
}

/**
 * «그때그때»를 지금 하나로 정한다.
 *
 * 화면 쪽에서 고르면 모니터마다 다른 연출이 나온다 — 세 대를 쓰면 왼쪽은 고양이,
 * 오른쪽은 거미줄이 된다. 한 번의 휴식은 어디서 보든 같아야 하므로 여기서 정한다.
 */
function resolveEnter(id) {
  if (id !== 'random') return id;
  const pool = ['web', 'cat', 'blinds', ...store.enterCustom.map((x) => `my:${x.id}`)];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 발동한 종류들을 오버레이가 그릴 수 있는 형태로 만든다 */
function buildBreakPayload(ids) {
  const custom = store.custom;
  const items = ids.map((id) => {
    const t = reminders.getType(id);
    const m = reminders.meta(id, custom);
    if (t) {
      return {
        ...m,
        headline: t.headline,
        checklist: t.checklist || null,
        tip: t.kind === 'short' ? pickTip(t) : null
      };
    }
    const c = custom[id] || {};
    return { ...m, headline: c.headline || m.name, checklist: null, tip: c.tip ? [c.tip, ''] : null };
  });
  const grouped = items.length > 1;
  const anyLong = items.some((i) => i.kind === 'long');
  const s = store.settings;
  const enter = resolveEnter(s.overlayEnter || 'fade');
  return {
    // 연출은 «지금 보고 있는» 화면에서만 그린다.
    // 휴식 내용과 확인 목록은 모든 화면에 그대로 뜬다 — 덮는 것이 목적이니까.
    // 다만 연출까지 화면 수만큼 그리면 같은 영상을 세 번 디코딩하게 된다.
    enterOn: cursorDisplayId(),
    // 어떤 연출로 등장할지 — 화면 쪽(enter.js)이 그린다.
    // 'my:<id>'면 그릴 파일 주소를 enterAsset 에 같이 실어 보낸다.
    enter,
    enterAsset: enterAsset(enter),
    items, grouped,
    mode: grouped || anyLong ? 'checklist' : 'single',
    // 켜면 «건너뛰기»·«다 했어요»를 숨긴다. 시간이 끝나면 tick()이 알아서 닫는다.
    noEscape: !!s.breakNoEscape,
    sound: { enabled: s.soundEnabled, name: s.soundName, volume: s.soundVolume }
  };
}

let breakPayload = null;

/**
 * 휴식 창을 미리 만들어 둔다.
 *
 * 창을 만들고 overlay.html을 읽는 데 0.4초가 걸린다. 그걸 «휴식이 오는 순간»에 하면
 * 그대로 늦게 뜬다. 미리 만들어 숨겨 두면 그때는 show()만 하면 되고, 그건 10ms다.
 *
 * 다만 계속 들고 있지는 않는다 — 화면 3대 기준 숨긴 창만으로 364MB를 더 쓴다.
 * 휴식이 가까워질 때 만들고, 안 오게 되면(멈춤·자리 비움·방해 금지) 바로 버린다.
 */
const WARM_LEAD_MS = 10_000;
let warmWins = [];
const warmReady = new WeakSet();

function buildOverlayWins() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((disp) => {
    const win = new BrowserWindow({
      ...disp.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,          // 내용을 받은 다음에 보여준다
      webPreferences: { preload: PRELOAD }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.once('did-finish-load', () => warmReady.add(win));
    // endsAt과 내용은 시작할 때 보낸다 — 미리 만들 때는 아직 정해지지 않았다
    win.loadFile(page('overlay.html'), {
      query: { main: String(disp.id === primaryId), display: String(disp.id) }
    });
    return win;
  });
}

function dropWarm() {
  if (!warmWins.length) return;
  for (const w of warmWins) { try { w.destroy(); } catch { /* 이미 없어졌다 */ } }
  warmWins = [];
}

/** 곧 올 휴식을 위해 창을 미리 세워 두거나, 안 오게 됐으면 치운다 */
function tendWarm(now) {
  const next = host.scheduler.soonest();
  const left = next ? next.at - now : Infinity;
  // 한참 남았으면 들고 있을 이유가 없다. 만들고 버리기를 반복하지 않도록
  // 버리는 선은 만드는 선보다 넉넉하게 둔다.
  if (left > WARM_LEAD_MS * 2) { dropWarm(); return; }
  if (left <= 0 || left > WARM_LEAD_MS || warmWins.length) return;
  warmWins = buildOverlayWins();
}

/** 모니터를 꽂거나 빼면 미리 만들어 둔 창은 엉뚱한 자리에 있는 셈이 된다 — 버리고 다시 만든다 */
function watchDisplays() {
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, dropWarm);
  }
}

let openingBreak = false;

async function openOverlays(ids) {
  // 여는 도중에 또 부르면 창이 두 벌 생긴다. 두 번째가 overlayWins 를 덮어써서
  // 첫 벌이 목록에서 떨어져 나가고, 그 창은 «닫기»가 닿지 않는 유령이 된다.
  // host.state.onBreak 는 화면 캡처를 기다린 뒤에야 켜지므로 그 사이가 비어 있다.
  if (openingBreak) return;
  openingBreak = true;
  try {
    await reallyOpenOverlays(ids);
  } finally {
    openingBreak = false;
  }
}

async function reallyOpenOverlays(ids) {
  const durations = ids.map((id) => {
    const c = host.scheduler.cfgOf(id);
    return (c && c.durationSec) || 20;
  });
  const durationSec = Math.max(...durations, 10);

  breakPayload = buildBreakPayload(ids);

  // 미리 찍어둔 게 있으면 그대로 쓴다 — 예정된 휴식은 1분 전에 찍어 둔다.
  // 없을 때만(«지금 쉬기»처럼 예고 없이 시작한 경우) 여기서 찍는다. 그때는 메인이
  // 2초쯤 멈춰 화면이 늦게 뜨지만, 그건 사용자가 방금 직접 누른 경우다.
  if (Date.now() - shotsAt > SHOT_FRESH_MS) await captureScreens();

  host.state.onBreak = true;
  host.state.breakIds = ids;
  host.state.breakStartedAt = Date.now();
  host.state.breakEndsAt = Date.now() + durationSec * 1000;

  // 화면 쪽이 그릴 때 «언제 끝나는지»가 있어야 한다 — 미리 만들어 둔 창은
  // 만들 때 그걸 몰랐으므로 여기서 같이 실어 보낸다.
  breakPayload.endsAt = host.state.breakEndsAt;
  // 등장 연출 길이는 휴식 길이를 따라간다 (화면 쪽 enter.js 가 절반쯤으로 잡는다)
  breakPayload.durationSec = durationSec;

  // 미리 세워 둔 창이 다 준비됐으면 그걸 쓴다. 화면 수가 달라졌거나(모니터를 꽂았거나)
  // 아직 다 안 읽혔으면 그냥 새로 만든다 — 반쯤 준비된 창에 신호를 보내면 놓친다.
  const want = screen.getAllDisplays().length;
  // 아직 다 안 읽혔어도 미리 세워 둔 창을 쓴다 — 새로 만드는 것보다 무조건 앞서 있다.
  // 다 읽혔는지는 아래에서 창마다 따로 본다.
  // 앞의 것이 남아 있으면 먼저 치운다 — 덮어쓰면 그 창들이 목록에서 떨어져 나간다
  for (const w of overlayWins) { try { w.destroy(); } catch { /* 이미 없다 */ } }
  overlayWins = [];
  const usable = warmWins.length === want && warmWins.every((w) => !w.isDestroyed());
  if (usable) {
    overlayWins = warmWins;
    warmWins = [];
  } else {
    dropWarm();
    overlayWins = buildOverlayWins();
  }

  for (const win of overlayWins) {
    if (win.isDestroyed()) continue;
    const go = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('overlay:begin', breakPayload);
      win.show();
    };
    // 미리 만들어 둔 창은 이미 다 읽혔다 — 바로 보여준다 (여기가 빠른 길이다).
    // 새로 만든 창은 다 읽힐 때까지 기다린다. 안 그러면 빈 화면이 먼저 뜬다.
    if (warmReady.has(win)) go();
    else win.webContents.once('did-finish-load', go);
  }
}

function closeOverlays() {
  // 목록만 믿지 않는다. 어떤 까닭으로든 목록에서 떨어져 나간 휴식 창이 있으면
  // 그 창은 단추를 눌러도 안 닫혀 사용자가 빠져나갈 길이 없어진다.
  // 휴식 창인 것은 남김없이 치운다.
  const all = new Set(overlayWins);
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try { if (w.webContents.getURL().includes('overlay.html')) all.add(w); } catch { /* 못 읽으면 넘어간다 */ }
  }
  for (const w of all) { try { w.destroy(); } catch { /* 이미 없다 */ } }
  overlayWins = [];
  warmWins = warmWins.filter((w) => !w.isDestroyed());
  // 아직 찍고 있는 중일 수 있다 (기다리지 않고 창을 띄우므로).
  // 세대를 올려두면 그게 끝나도 지워진 자리에 다시 채워 넣지 않는다.
  shotSeq++;
  shotsReady = null;
  shotsAt = 0;
  overlayShots.clear();
  breakPayload = null;
  host.state.onBreak = false;
}

function startBreak(ids) {
  if (host.state.onBreak) return;
  const list = ids && ids.length ? ids : host.scheduler.activeIds().slice(0, 1);
  if (!list.length) return;
  openOverlays(list);
  host.updateTray();
}

function endBreak(kind) { // 'done' | 'skipped' | 'snoozed'
  const ids = host.state.breakIds;
  closeOverlays();
  if (kind === 'snoozed') {
    host.scheduler.snooze(ids, SNOOZE_MS);
  } else {
    if (kind === 'done') store.recordDone(ids);        // 종류별로 기록
    else store.bumpStat('skipped', ids.length);
    host.scheduler.rescheduleAll(ids);
  }
  statswin.notifyChanged();
  host.state.breakIds = [];
  host.updateTray();
  host.pushTick();
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.on('widget:break-now', (_e, id) => startBreak(id ? [id] : null));

ipcMain.handle('overlay:get-bg', async (_e, id) => {
  // 아직 찍는 중이면 여기서 기다린다 — 그동안 휴식 화면은 이미 떠 있다.
  if (shotsReady) { try { await shotsReady; } catch { /* 배경 없이 간다 */ } }
  return overlayShots.get(String(id)) || null;
});
ipcMain.handle('overlay:get-payload', () => breakPayload);
ipcMain.on('overlay:snooze', () => endBreak('snoozed'));
ipcMain.on('overlay:skip', () => endBreak('skipped'));
ipcMain.on('overlay:done', () => endBreak('done')); // 남은 시간을 기다리지 않고 일찍 끝내기

// ── 내 등장 연출 ──
// 고르기와 넣기를 나눈 이유: 영상 길이는 화면 쪽에서만 잴 수 있다.
// 먼저 고른 파일 주소를 돌려주면, 설정 화면이 미리 보며 길이를 재고 그 다음에 넣는다.
ipcMain.handle('enter:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '등장 연출로 쓸 그림·영상 고르기',
    filters: [{ name: '그림·영상', extensions: ENTER_EXT }],
    properties: ['openFile']
  });
  if (canceled || !filePaths[0]) return null;
  const src = filePaths[0];
  const ext = path.extname(src).slice(1).toLowerCase();
  if (!ENTER_EXT.includes(ext)) return { error: '이 형식은 쓸 수 없습니다.' };
  const size = fs.statSync(src).size;
  // 배포물에 들어가는 게 아니라 사용자 폴더로 복사될 뿐이지만, 그래도 한도는 둔다 —
  // 100MB짜리를 휴식마다 읽으면 뜨는 게 느려진다.
  if (size > 40 * 1024 * 1024) return { error: '파일이 너무 큽니다 (40MB까지).' };
  return {
    path: src,
    url: pathToFileURL(src).href,
    name: path.basename(src, path.extname(src)),
    kind: ext === 'webm' || ext === 'mp4' ? 'video' : 'img'
  };
});

ipcMain.handle('enter:add', (_e, { path: src, name, ms }) => {
  try {
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!ENTER_EXT.includes(ext)) return { error: '이 형식은 쓸 수 없습니다.' };
    const dir = ENTER_DIR();
    fs.mkdirSync(dir, { recursive: true });
    // 같은 이름을 두 번 넣어도 서로 안 덮어쓰게 시각을 붙인다
    const file = `${Date.now().toString(36)}.${ext}`;
    fs.copyFileSync(src, path.join(dir, file));
    store.addEnter({ name, file, kind: ext === 'webm' || ext === 'mp4' ? 'video' : 'img', ms });
    return { list: enterList() };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('enter:remove', (_e, id) => {
  const item = store.enterCustom.find((x) => x.id === id);
  store.removeEnter(id);
  // 목록에서 뺀 다음에 지운다 — 지우다 실패해도 목록엔 안 남아야 한다
  if (item) { try { fs.unlinkSync(path.join(ENTER_DIR(), item.file)); } catch { /* 이미 없으면 됐다 */ } }
  return { list: enterList(), overlayEnter: store.settings.overlayEnter };
});


module.exports = {
  init,
  // 휴식 시작·끝
  startBreak, endBreak,
  // 틱이 매 초 부르는 것들 — 미리 찍기·미리 세우기·치우기
  prepareShots, tendWarm, dropWarm,
  // 모니터가 바뀌면 미리 세워 둔 창을 버리도록 앱 시작 때 한 번 건다
  watchDisplays,
  // 설정 화면이 쓰는 «내 연출» 목록 (settings:get 이 실어 보낸다)
  enterList
};

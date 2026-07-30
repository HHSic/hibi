const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, nativeImage, desktopCapturer, nativeTheme
} = require('electron');
const path = require('path');
const store = require('./store');
const glass = require('./glass');
const reminders = require('./reminders');
const dnd = require('./dnd');
const calendar = require('./calendar');
const updater = require('./updater');

const ICON = path.join(__dirname, '..', 'assets', 'tray.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const page = (name) => path.join(__dirname, '..', 'renderer', name);

// 창 크기 = 카드 크기 + 그림자 여백(INSET*2) + 호버 컨트롤 띠(CONTROLS).
// 카드 기준 176x84 ~ 460x220.
const PAD = glass.INSET * 2;
const PAD_H = PAD + glass.CONTROLS;
const WIDGET_MIN = { width: 176 + PAD, height: 84 + PAD_H };
const WIDGET_MAX = { width: 460 + PAD, height: 220 + PAD_H };
const WIDGET_DEFAULT = { width: 244 + PAD, height: 110 + PAD_H };
const SNOOZE_MS = 5 * 60_000;

let tray = null;
let widgetWin = null;
let settingsWin = null;
let overlayWins = [];
let overlayShots = new Map();

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 렌더러에 넘기는 공통 쿼리 */
function glassQuery(extra) {
  return {
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    scrim: String(store.settings.scrim),
    inset: String(glass.INSET),
    ctlh: String(glass.CONTROLS),
    ...extra
  };
}

const scheduler = new reminders.Scheduler(() => store.reminders, () => store.custom);

const state = {
  paused: false,
  onBreak: false,
  breakIds: [],
  breakEndsAt: 0,
  breakStartedAt: 0,
  hold: null          // 지금 알림을 미루는 이유 ('발표 모드', '회의 중' 등)
};

// 캘린더 일정 캐시
const CAL_REFRESH_MS = 15 * 60 * 1000;
const cal = { occurrences: [], errors: [], fetchedAt: 0, loading: false };

async function refreshCalendars() {
  const list = store.calendars;
  if (!list.length) { cal.occurrences = []; cal.errors = []; return; }
  if (cal.loading) return;
  cal.loading = true;
  try {
    const r = await calendar.loadOccurrences(list, {
      includeAllDay: store.settings.calendarAllDay
    });
    cal.occurrences = r.occurrences;
    cal.errors = r.errors;
    cal.fetchedAt = r.fetchedAt;
    if (r.errors.length) console.warn('[calendar] 일부 실패:', r.errors.map((e) => e.message).join(', '));
  } catch (e) {
    console.warn('[calendar] refresh failed:', e.message);
  } finally {
    cal.loading = false;
  }
}

/**
 * 지금 알림을 띄우면 안 되는 이유가 있으면 문자열로, 없으면 null.
 * 전체화면·발표·집중지원과 캘린더 일정을 함께 본다.
 */
function holdReason() {
  const s = store.settings;
  const d = dnd.check({ enabled: s.dndEnabled, apps: s.dndApps });
  if (d.blocked) return d.reason;
  if (s.calendarBusy) {
    const ev = calendar.currentEvent(cal.occurrences);
    if (ev) return ev.summary ? `일정: ${ev.summary}` : '일정 중';
  }
  return null;
}

// ── 위젯 ──────────────────────────────────────────────────
function createWidget() {
  const pos = store.widgetPos;
  const size = store.widgetSize || WIDGET_DEFAULT;
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  widgetWin = new BrowserWindow({
    width: clamp(size.width, WIDGET_MIN.width, WIDGET_MAX.width),
    height: clamp(size.height, WIDGET_MIN.height, WIDGET_MAX.height),
    x: pos ? pos.x : sw - size.width - 20,
    y: pos ? pos.y : 20,
    minWidth: WIDGET_MIN.width,
    minHeight: WIDGET_MIN.height,
    maxWidth: WIDGET_MAX.width,
    maxHeight: WIDGET_MAX.height,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });

  widgetWin.loadFile(page('widget.html'), {
    query: glassQuery({ radius: String(store.settings.radius) })
  });

  widgetWin.on('moved', () => {
    const [x, y] = widgetWin.getPosition();
    store.setWidgetPos({ x, y });
  });
  widgetWin.on('resize', () => {
    const [width, height] = widgetWin.getSize();
    store.setWidgetSize({ width, height });
  });
  widgetWin.on('closed', () => { widgetWin = null; });
}

// ── 오버레이 ──────────────────────────────────────────────
async function captureScreens() {
  overlayShots.clear();
  try {
    const displays = screen.getAllDisplays();
    const max = displays.reduce(
      (a, d) => ({ width: Math.max(a.width, d.size.width), height: Math.max(a.height, d.size.height) }),
      { width: 0, height: 0 }
    );
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(max.width / 3), height: Math.round(max.height / 3) }
    });
    for (const src of sources) {
      if (!src.thumbnail.isEmpty()) overlayShots.set(String(src.display_id), src.thumbnail.toDataURL());
    }
  } catch (e) {
    console.warn('[overlay] capture failed:', e.message);
  }
}

function pickTip(type) {
  if (!type || !type.tips || !type.tips.length) return null;
  return type.tips[Math.floor(Math.random() * type.tips.length)];
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
  return { items, grouped, mode: grouped || anyLong ? 'checklist' : 'single' };
}

let breakPayload = null;

async function openOverlays(ids) {
  const durations = ids.map((id) => {
    const c = scheduler.cfgOf(id);
    return (c && c.durationSec) || 20;
  });
  const durationSec = Math.max(...durations, 10);

  breakPayload = buildBreakPayload(ids);
  await captureScreens();

  state.onBreak = true;
  state.breakIds = ids;
  state.breakStartedAt = Date.now();
  state.breakEndsAt = Date.now() + durationSec * 1000;

  const primaryId = screen.getPrimaryDisplay().id;
  for (const disp of screen.getAllDisplays()) {
    const win = new BrowserWindow({
      ...disp.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { preload: PRELOAD }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(page('overlay.html'), {
      query: {
        endsAt: String(state.breakEndsAt),
        main: String(disp.id === primaryId),
        display: String(disp.id)
      }
    });
    overlayWins.push(win);
  }
}

function closeOverlays() {
  for (const w of overlayWins) { try { w.destroy(); } catch {} }
  overlayWins = [];
  overlayShots.clear();
  breakPayload = null;
  state.onBreak = false;
}

function startBreak(ids) {
  if (state.onBreak) return;
  const list = ids && ids.length ? ids : scheduler.activeIds().slice(0, 1);
  if (!list.length) return;
  openOverlays(list);
  updateTray();
}

function endBreak(kind) { // 'done' | 'skipped' | 'snoozed'
  const ids = state.breakIds;
  closeOverlays();
  if (kind === 'snoozed') {
    scheduler.snooze(ids, SNOOZE_MS);
  } else {
    store.bumpStat(kind === 'done' ? 'done' : 'skipped', ids.length);
    scheduler.rescheduleAll(ids);
  }
  state.breakIds = [];
  updateTray();
  pushTick();
}

// ── 틱 ────────────────────────────────────────────────────
function tick() {
  const now = Date.now();

  if (state.onBreak) {
    if (now >= state.breakEndsAt) endBreak('done');
    return;
  }
  if (state.paused) { pushTick(); return; }

  if (powerMonitor.getSystemIdleTime() >= store.settings.idlePauseSec) {
    scheduler.postponeAll(1000); // 자리 비움 동안 정지
    state.hold = null;
  } else {
    const due = scheduler.due(now);
    if (due.length) {
      // 발표·전체화면·회의 중이면 끝날 때까지 카운트다운을 붙잡아 둔다.
      // 미룬 알림은 상황이 끝나는 즉시 이어서 실행된다.
      const reason = holdReason();
      if (reason) {
        state.hold = reason;
        scheduler.postponeAll(1000);
      } else {
        state.hold = null;
        startBreak(due);
        return;
      }
    } else {
      state.hold = null;
    }
  }
  pushTick();
}

function pushTick() {
  if (!widgetWin || widgetWin.isDestroyed()) return;

  const next = scheduler.soonest();
  const custom = store.custom;
  let payload;

  if (!next) {
    payload = { empty: true, paused: state.paused, today: store.todayStats() };
  } else {
    const cfg = scheduler.cfgOf(next.id);
    const totalSec = Math.max(1, (cfg ? cfg.intervalMin : 20) * 60);
    const remaining = Math.max(0, Math.round((next.at - Date.now()) / 1000));
    payload = {
      empty: false,
      type: reminders.meta(next.id, custom),
      remaining,
      total: totalSec,
      paused: state.paused,
      onBreak: state.onBreak,
      idle: powerMonitor.getSystemIdleTime() >= store.settings.idlePauseSec,
      hold: state.hold,
      today: store.todayStats(),
      upcoming: upcomingList(8),
      // 다음 휴식에 함께 묶일 종류들 — 위젯 칩에서 강조된다
      bundle: scheduler.nextBundle(),
      week: store.recentDays(7)
    };
  }
  widgetWin.webContents.send('tick', payload);
}

/** 다음 차례 순서대로 종류 메타 + 남은 시간 */
function upcomingList(n) {
  const custom = store.custom;
  const now = Date.now();
  return [...scheduler.nextAt.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([id, at]) => ({
      ...reminders.meta(id, custom),
      remaining: Math.max(0, Math.round((at - now) / 1000))
    }));
}

// ── 트레이 ────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  const next = scheduler.soonest();
  const custom = store.custom;
  const mins = next ? Math.max(0, Math.ceil((next.at - Date.now()) / 60_000)) : 0;
  const up = updater.getState();
  tray.setToolTip(
    state.paused ? '눈쉼 — 일시정지됨'
      : state.hold ? `눈쉼 — ${state.hold} (대기 중)`
        : next ? `눈쉼 — ${reminders.meta(next.id, custom).name} 약 ${mins}분 후`
          : '눈쉼 — 켜진 알림 없음'
  );

  const nowSub = scheduler.activeIds().map((id) => ({
    label: reminders.meta(id, custom).name,
    click: () => startBreak([id])
  }));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.paused ? '타이머 재개' : '타이머 일시정지', click: togglePause },
    nowSub.length
      ? { label: '지금 알림 실행', submenu: nowSub }
      : { label: '지금 알림 실행', enabled: false },
    { type: 'separator' },
    { label: '위젯 보이기/숨기기', click: toggleWidget },
    { label: '위젯 크기 초기화', click: resetWidgetSize },
    { label: '설정', click: openSettings },
    ...(up.status === 'ready'
      ? [{ type: 'separator' }, { label: `업데이트 ${up.newVersion} 설치하고 다시 시작`, click: () => updater.installNow() }]
      : []),
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function togglePause() {
  state.paused = !state.paused;
  updateTray();
  pushTick();
}

function toggleWidget() {
  if (!widgetWin || widgetWin.isDestroyed()) { createWidget(); return; }
  widgetWin.isVisible() ? widgetWin.hide() : widgetWin.show();
}

function resetWidgetSize() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  widgetWin.setSize(WIDGET_DEFAULT.width, WIDGET_DEFAULT.height);
  store.setWidgetSize(WIDGET_DEFAULT);
}

// ── 설정 창 ───────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 392 + PAD,
    height: 616 + PAD,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  settingsWin.loadFile(page('settings.html'), { query: glassQuery({ radius: '20' }) });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.on('widget:toggle-pause', togglePause);
ipcMain.on('widget:break-now', (_e, id) => startBreak(id ? [id] : null));
ipcMain.on('widget:open-settings', openSettings);
ipcMain.on('widget:hide', () => widgetWin && widgetWin.hide());
ipcMain.on('widget:resize', (_e, { width, height }) => {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  widgetWin.setSize(
    Math.round(clamp(width, WIDGET_MIN.width, WIDGET_MAX.width)),
    Math.round(clamp(height, WIDGET_MIN.height, WIDGET_MAX.height))
  );
});
ipcMain.handle('widget:get-size', () => {
  if (!widgetWin || widgetWin.isDestroyed()) return WIDGET_DEFAULT;
  const [width, height] = widgetWin.getSize();
  return { width, height };
});
// 카드를 클릭 가능하게 만들려면 -webkit-app-region: drag를 쓸 수 없어
// 이동을 직접 처리한다 (drag 영역은 마우스 이벤트를 OS가 가져가 클릭이 안 잡힘)
ipcMain.handle('widget:get-pos', () => {
  if (!widgetWin || widgetWin.isDestroyed()) return { x: 0, y: 0 };
  const [x, y] = widgetWin.getPosition();
  return { x, y };
});
ipcMain.on('widget:move', (_e, { x, y }) => {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  widgetWin.setPosition(Math.round(x), Math.round(y));
});

ipcMain.handle('overlay:get-bg', (_e, id) => overlayShots.get(String(id)) || null);
ipcMain.handle('overlay:get-payload', () => breakPayload);
ipcMain.on('overlay:snooze', () => endBreak('snoozed'));
ipcMain.on('overlay:skip', () => endBreak('skipped'));
ipcMain.on('overlay:done', () => endBreak('done')); // 남은 시간을 기다리지 않고 일찍 끝내기

ipcMain.handle('settings:get', () => ({
  settings: store.settings,
  reminders: store.reminders,
  custom: store.custom,
  calendars: store.calendars,
  calendarStatus: calendarStatus(),
  update: updater.getState(),
  types: reminders.TYPES.map((t) => ({
    id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind, headline: t.headline
  }))
}));

function calendarStatus() {
  const now = Date.now();
  const cur = calendar.currentEvent(cal.occurrences, now);
  const next = calendar.nextEvent(cal.occurrences, now);
  return {
    count: cal.occurrences.length,
    fetchedAt: cal.fetchedAt,
    errors: cal.errors.map((e) => ({ name: e.name, message: e.message })),
    current: cur ? { summary: cur.summary, end: cur.end } : null,
    next: next ? { summary: next.summary, start: next.start } : null
  };
}

// ── 캘린더 ────────────────────────────────────────────────
ipcMain.handle('cal:add', async (_e, { name, url }) => {
  store.addCalendar({ name, url });
  await refreshCalendars();
  return { calendars: store.calendars, status: calendarStatus() };
});
ipcMain.handle('cal:update', async (_e, { id, patch }) => {
  store.updateCalendar(id, patch);
  await refreshCalendars();
  return { calendars: store.calendars, status: calendarStatus() };
});
ipcMain.handle('cal:remove', async (_e, id) => {
  store.removeCalendar(id);
  await refreshCalendars();
  return { calendars: store.calendars, status: calendarStatus() };
});
ipcMain.handle('cal:refresh', async () => {
  await refreshCalendars();
  return { calendars: store.calendars, status: calendarStatus() };
});
/** 저장 전에 주소가 실제로 읽히는지 확인 */
ipcMain.handle('cal:test', async (_e, url) => {
  try {
    const text = await calendar.fetchText(url);
    if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, message: 'iCalendar 형식이 아닙니다' };
    const now = Date.now();
    const occ = calendar.occurrencesIn(text, now - 7 * 86400000, now + 30 * 86400000, {
      includeAllDay: store.settings.calendarAllDay
    });
    return { ok: true, message: `연결됨 · 앞으로 30일 일정 ${occ.length}건` };
  } catch (e) {
    return { ok: false, message: String(e.message || e).slice(0, 120) };
  }
});

// ── 기록 ──────────────────────────────────────────────────
function statsPayload() {
  return { today: store.todayStats(), week: store.recentDays(7) };
}
ipcMain.handle('stats:get', () => statsPayload());
ipcMain.handle('stats:reset-today', () => {
  store.resetToday();
  pushTick();
  updateTray();
  return statsPayload();
});
ipcMain.handle('stats:reset-all', () => {
  store.resetAllStats();
  pushTick();
  updateTray();
  return statsPayload();
});

// ── 업데이트 ──────────────────────────────────────────────
ipcMain.handle('update:check', async () => { await updater.check(); return updater.getState(); });
ipcMain.handle('update:state', () => updater.getState());
ipcMain.on('update:install', () => updater.installNow());
/** Windows 로그인 시 자동 실행 (패키징된 앱에서만 의미가 있다) */
function applyAutoLaunch(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath });
  } catch (e) {
    console.warn('[autolaunch] failed:', e.message);
  }
}

ipcMain.on('settings:set-app', (_e, patch) => {
  store.setSettings(patch);
  if (patch.autoLaunch != null) applyAutoLaunch(patch.autoLaunch);
  if (patch.autoUpdate != null) updater.startAuto(patch.autoUpdate);
  if (patch.calendarAllDay != null) refreshCalendars();
  if (widgetWin && !widgetWin.isDestroyed()) {
    if (patch.scrim != null) widgetWin.webContents.send('scrim', patch.scrim);
    if (patch.radius != null) widgetWin.webContents.send('radius', patch.radius);
  }
  updateTray();
});
ipcMain.on('settings:set-reminder', (_e, { id, patch }) => {
  store.setReminder(id, patch);
  scheduler.sync();
  if (patch.intervalMin != null) scheduler.schedule(id);
  updateTray();
  pushTick();
});
ipcMain.on('settings:close', () => settingsWin && settingsWin.close());

// ── 라이프사이클 ──────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (widgetWin) { widgetWin.show(); widgetWin.focus(); } });

  app.whenReady().then(() => {
    tray = new Tray(nativeImage.createFromPath(ICON));
    if (app.isPackaged) applyAutoLaunch(store.settings.autoLaunch);
    scheduler.reset();
    updateTray();
    createWidget();
    setInterval(tick, 1000);
    setInterval(updateTray, 30_000);

    refreshCalendars();
    setInterval(refreshCalendars, CAL_REFRESH_MS);

    updater.init({
      onUpdate: (s) => {
        if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:status', s);
        updateTray();
      }
    });
    updater.startAuto(store.settings.autoUpdate);

    // 개발용: NUNS_DEV=settings,break 로 창을 바로 띄워 확인한다
    const dev = (process.env.NUNS_DEV || '').split(',').map((s) => s.trim());
    if (dev.includes('settings')) setTimeout(openSettings, 1200);
    if (dev.includes('break')) setTimeout(() => startBreak(scheduler.activeIds()), 1800);
  });

  app.on('window-all-closed', () => { /* 트레이 상주 */ });
}

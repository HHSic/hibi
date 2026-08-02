const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, nativeImage, desktopCapturer, nativeTheme, shell, dialog, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const glass = require('./glass');
const reminders = require('./reminders');
const dnd = require('./dnd');
const calendar = require('./calendar');
const updater = require('./updater');
const session = require('./session');
const autolaunch = require('./autolaunch');
const evlog = require('./evlog');
const planner = require('./planner');

const ICON = path.join(__dirname, '..', 'assets', 'tray.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const page = (name) => path.join(__dirname, '..', 'renderer', name);

// 창 크기 = 카드 크기 + 그림자 여백(INSET*2) + 호버 컨트롤 띠(CONTROLS).
// 카드 기준 176x84 ~ 640x520. 상한이 낮으면 크게 쓰던 사람이 리사이즈에서 벽에 막힌다.
const PAD = glass.INSET * 2;
const PAD_H = PAD + glass.CONTROLS;
const WIDGET_MIN = { width: 176 + PAD, height: 84 + PAD_H };
const WIDGET_MAX = { width: 640 + PAD, height: 520 + PAD_H };
const WIDGET_DEFAULT = { width: 244 + PAD, height: 110 + PAD_H };
const SNOOZE_MS = 5 * 60_000;

let tray = null;
let widgetWin = null;
let widgetSize = null;   // 우리가 정한 위젯 크기 (실제 크기를 되읽지 않기 위한 기준)
let settingsWin = null;
let statsWin = null;
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
  hold: null,         // 알림이 밀린 상태 (때가 됐는데 방해 금지라 못 띄움)
  dnd: null           // 방해 금지가 켜진 이유 ('발표 모드', 'Zoom' 등)
};

// 캘린더 일정 캐시
const CAL_REFRESH_MS = 15 * 60 * 1000;
const cal = { occurrences: [], errors: [], sources: [], fetchedAt: 0, loading: false, hold: null };

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
    cal.sources = r.sources;      // 달력에서 다른 달을 펼칠 때 쓴다
    cal.fetchedAt = r.fetchedAt;
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('cal:changed');
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
 * 매 초 네이티브 호출을 반복하지 않도록 잠깐 캐시한다.
 */
const DND_CACHE_MS = 2000;
let dndCache = { at: 0, needMs: 0, reason: null };

/** 휴식에 필요한 시간 — 다음 일정까지 이만큼도 안 남았으면 시작하지 않는다 */
function needMsFor(ids) {
  if (!ids || !ids.length) return 0;
  const secs = ids.map((id) => {
    const c = scheduler.cfgOf(id);
    return (c && c.durationSec) || 20;
  });
  return Math.max(...secs, 10) * 1000;
}

function holdReason(needMs = 0) {
  const now = Date.now();
  // 필요한 시간이 달라지면 캐시를 다시 계산해야 한다 (같은 초에도 판단이 갈린다)
  if (now - dndCache.at < DND_CACHE_MS && dndCache.needMs === needMs) return dndCache.reason;

  const s = store.settings;
  let reason = null;

  const d = dnd.check({ enabled: s.dndEnabled, presets: s.dndPresets, apps: s.dndApps });
  if (d.blocked) {
    reason = d.reason;
  } else if (s.calendarBusy) {
    // 일정 중일 때만이 아니라, 일정 직전이라 휴식이 온전히 들어갈 자리가 없을 때도 미룬다
    const p = planner.check(cal.occurrences, now, s.calendarLead ? needMs : 0, {
      leadMs: (s.calendarLeadMin || 0) * 60_000,
      joinMs: (s.calendarJoinMin || 0) * 60_000
    });
    if (p) reason = p.label;
    cal.hold = p;
  }

  dndCache = { at: now, needMs, reason };
  return reason;
}

// ── 위젯 ──────────────────────────────────────────────────
function createWidget() {
  const pos = store.widgetPos;
  const size = store.widgetSize || WIDGET_DEFAULT;
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  // 우리가 정한 창 크기. 창을 옮길 때마다 이 값을 같이 못박는다.
  // 실제 크기(getSize)를 되읽어 쓰면 안 된다 — 배율이 100%가 아닐 때
  // 창을 옮길 때마다 실제 크기가 1px씩 부풀어, 그 값을 다시 쓰면 끝없이 자란다.
  widgetSize = {
    width: Math.round(clamp(size.width, WIDGET_MIN.width, WIDGET_MAX.width)),
    height: Math.round(clamp(size.height, WIDGET_MIN.height, WIDGET_MAX.height))
  };

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
    // OS 네이티브 리사이즈는 쓰지 않는다.
    // 투명·프레임 없는 창을 배율 150%에서 네이티브로 리사이즈하면, 버튼을 누르고
    // 가만히 있어도 창이 최대치까지 저 혼자 자란다 (매 메시지마다 1px씩 부풀어서).
    // 대신 렌더러의 8방향 리사이즈 존이 widget:set-bounds로 직접 크기를 정한다.
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });

  widgetWin.loadFile(page('widget.html'), {
    query: glassQuery({
      radius: String(store.settings.radius),
      calpanel: store.settings.calendarPanel ? '1' : '',
      calmode: store.settings.calendarMode || 'month'
    })
  });
  // 창은 기록을 켠 뒤에 만들어질 수 있다 — 로드가 끝나면 현재 상태를 알린다
  widgetWin.webContents.on('did-finish-load', () => {
    if (evlog.enabled) widgetWin.webContents.send('debug:mode', true);
  });

  // 저장된 좌표가 지금 없는 모니터를 가리킬 수 있다 (모니터 구성 변경)
  ensureOnScreen(widgetWin);

  widgetWin.on('moved', () => {
    const [x, y] = widgetWin.getPosition();
    store.setWidgetPos({ x, y });
  });
  widgetWin.on('resize', () => {
    const [width, height] = widgetWin.getSize();
    // 저장은 실제값이 아니라 우리가 정한 값으로 한다.
    // 실제값은 배율 탓에 1px 부풀어 있을 수 있고, 그걸 저장하면 실행할 때마다 커진다.
    store.setWidgetSize({ ...widgetSize });
    evlog.log('창', `resize → ${width}x${height} (기준 ${widgetSize.width}x${widgetSize.height})`);
  });
  // 네이티브 드래그 중에는 min/max가 늘 지켜지지는 않는다 (특히 배율이 100%가 아닐 때).
  // 드래그가 끝난 뒤에 한 번만 바로잡는다 — 드래그 중에 고치면 OS와 싸워 창이 튄다.
  widgetWin.on('resized', () => {
    const [width, height] = widgetWin.getSize();
    const w = Math.round(clamp(width, WIDGET_MIN.width, WIDGET_MAX.width));
    const h = Math.round(clamp(height, WIDGET_MIN.height, WIDGET_MAX.height));
    evlog.log('창', `resized(끝) ${width}x${height}`
      + (w !== width || h !== height ? ` → 범위로 되돌림 ${w}x${h}` : ''));
    if (w !== width || h !== height) widgetWin.setSize(w, h);
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
    if (kind === 'done') store.recordDone(ids);        // 종류별로 기록
    else store.bumpStat('skipped', ids.length);
    scheduler.rescheduleAll(ids);
  }
  if (statsWin && !statsWin.isDestroyed()) statsWin.webContents.send('stats:changed');
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
    state.dnd = null;
  } else {
    // 알림이 밀릴 때만이 아니라 방해 금지가 켜진 동안 계속 상태를 알린다.
    // 판단에 "이 휴식이 몇 분 걸리는지"가 필요하므로 due를 먼저 구한다.
    const due = scheduler.due(now);
    state.dnd = holdReason(needMsFor(due));
    if (due.length) {
      // 발표·전체화면·회의 중이면 끝날 때까지 카운트다운을 붙잡아 둔다.
      // 미룬 알림은 상황이 끝나는 즉시 이어서 실행된다.
      if (state.dnd) {
        state.hold = state.dnd;
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

  // 오늘 일정 — 위젯 시트에서 예정된 알림과 나란히 보여준다
  const schedule = store.settings.calendarShow ? planner.today(cal.occurrences) : [];

  if (!next) {
    payload = { empty: true, paused: state.paused, today: store.todayStats(), schedule };
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
      dnd: state.dnd,
      today: store.todayStats(),
      schedule,
      // 일정 때문에 미루는 중이면 언제 이어지는지 알려준다
      holdUntil: state.hold && cal.hold ? cal.hold.until : null,
      upcoming: upcomingList(8),
      // 다음 휴식에 함께 묶일 종류들 — 위젯 칩에서 강조된다
      bundle: scheduler.nextBundle(),
      week: store.recentDays(7),
      update: (() => {
        const u = updater.getState();
        return u.status === 'ready' ? { ready: true, version: u.newVersion } : null;
      })()
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
    state.paused ? 'Hibi — 일시정지됨'
      : state.hold ? `Hibi — 방해 금지 (${state.hold}) · 알림 대기 중`
        : state.dnd ? `Hibi — 방해 금지 (${state.dnd})`
          : next ? `Hibi — ${reminders.meta(next.id, custom).name} 약 ${mins}분 후`
            : 'Hibi — 켜진 알림 없음'
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
    { label: '위젯 보이기', click: revealWidget },
    { label: '위젯 숨기기', click: () => widgetWin && !widgetWin.isDestroyed() && widgetWin.hide() },
    { label: '위젯 크기 초기화', click: resetWidgetSize },
    { label: '기록 보기', click: () => openStats(null) },
    { label: '달력 보기', click: showCalendarPanel },
    { label: '설정', click: openSettings },
    ...(up.status === 'ready'
      ? [{ type: 'separator' }, { label: `업데이트 ${up.newVersion} 설치하고 다시 시작`, click: installUpdate }]
      : []),
    { type: 'separator' },
    {
      label: '이벤트 기록 (문제 재현용)',
      type: 'checkbox',
      checked: evlog.enabled,
      click: (item) => {
        store.setSettings({ eventLog: item.checked });
        setEventLog(item.checked);
      }
    },
    { label: '기록 파일 열기', click: openEventLog },
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
  if (widgetWin.isVisible()) widgetWin.hide();
  else revealWidget();
}

/**
 * 창이 어느 모니터에도 걸쳐 있지 않으면 기본 위치로 되돌린다.
 * 모니터를 뺐다 꽂으면 저장된 좌표가 존재하지 않는 화면을 가리켜
 * 위젯이 보이지 않는 곳에 남는다.
 */
function ensureOnScreen(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    // 일부라도 겹치면 접근 가능하다고 본다
    return b.x < w.x + w.width && b.x + b.width > w.x
      && b.y < w.y + w.height && b.y + b.height > w.y;
  });
  if (visible) return;

  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - b.width - 20;
  const y = workArea.y + 20;
  // setPosition은 배율 탓에 창을 부풀리므로 크기를 함께 못박는다
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  store.setWidgetPos({ x: Math.round(x), y: Math.round(y) });
  console.log('[widget] 화면 밖이라 기본 위치로 되돌렸습니다');
}

/** 트레이에서 위젯을 다시 불러올 때 — 보이게 하고, 화면 안으로, 맨 앞으로 */
function revealWidget() {
  if (!widgetWin || widgetWin.isDestroyed()) { createWidget(); return; }
  ensureOnScreen(widgetWin);
  widgetWin.show();
  widgetWin.setAlwaysOnTop(true);
  widgetWin.focus();
}

let boundsWatch = null;

/**
 * 기록 중에는 창 크기를 짧은 주기로 직접 들여다본다.
 * 이벤트만 믿으면 "아무도 시키지 않았는데 커진" 경우를 통째로 놓친다.
 * 여기 찍힌 변화 옆에 set-bounds/리사이즈 줄이 없으면, 우리 코드 밖에서 창이 커진 것이다.
 */
function watchBounds(on) {
  if (boundsWatch) { clearInterval(boundsWatch); boundsWatch = null; }
  if (!on) return;
  let last = null;
  boundsWatch = setInterval(() => {
    if (!widgetWin || widgetWin.isDestroyed()) return;
    const b = widgetWin.getBounds();
    const key = `${b.width}x${b.height}@${b.x},${b.y}`;
    if (key === last) return;
    const grew = last && `${b.width}x${b.height}` !== last.split('@')[0];
    evlog.log('표본', `${key}${last ? ` (이전 ${last})` : ''}${grew ? '  ← 크기 변함' : ''}`);
    last = key;
  }, 120);
  if (boundsWatch.unref) boundsWatch.unref();
}

/** 이벤트 기록 켜기/끄기 — 렌더러도 같이 알아야 포인터 이벤트를 보낸다 */
function setEventLog(on) {
  evlog.setEnabled(on);
  watchBounds(on);
  if (on) {
    const d = screen.getPrimaryDisplay();
    evlog.log('main', `배율 ${d.scaleFactor} · 작업영역 ${d.workAreaSize.width}x${d.workAreaSize.height}`);
    if (widgetWin && !widgetWin.isDestroyed()) {
      const b = widgetWin.getBounds();
      evlog.log('main', `위젯 시작 상태 ${b.width}x${b.height} @${b.x},${b.y} · resizable=${widgetWin.isResizable()}`);
    }
  }
  for (const w of [widgetWin, statsWin, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('debug:mode', on);
  }
  updateTray();
}

function openEventLog() {
  if (!evlog.file || !fs.existsSync(evlog.file)) {
    dialog.showMessageBox({
      type: 'info', title: '이벤트 기록',
      message: '아직 기록이 없습니다.',
      detail: '트레이 메뉴에서 «이벤트 기록»을 켜고 문제를 재현한 뒤 다시 열어보세요.'
    });
    return;
  }
  shell.openPath(evlog.file);
}

function resetWidgetSize() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  widgetSize = { ...WIDGET_DEFAULT };
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

// ── 기록 창 (통계 + 종류별 상세) ──────────────────────────
function openStats(focusType) {
  if (statsWin && !statsWin.isDestroyed()) {
    statsWin.focus();
    if (focusType) statsWin.webContents.send('stats:focus', focusType);
    return;
  }
  statsWin = new BrowserWindow({
    width: 316 + PAD,      // 15주 잔디에 맞춰 폭을 좁게 (더 긴 기간은 가로 스크롤)
    height: 452 + PAD,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  statsWin.loadFile(page('stats.html'), {
    query: glassQuery({ radius: '20', focus: focusType || '' })
  });
  statsWin.on('closed', () => { statsWin = null; });
}

/** 위젯 안 달력을 펼친다 (별도 창을 두지 않고 위젯이 길어진다) */
function showCalendarPanel() {
  store.setSettings({ calendarPanel: true });
  revealWidget();
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('cal:show');
}

/**
 * 달력 한 달치. 앞뒤로 한 주씩 더 얹어 격자의 빈 칸(지난달·다음달)도 채운다.
 * 이미 받아둔 ICS 원문에서 펼치므로 달을 넘겨도 다시 내려받지 않는다.
 */
ipcMain.handle('cal:month', (_e, { year, month }) => {
  const first = new Date(year, month, 1);
  const from = new Date(year, month, 1 - 7).getTime();
  const to = new Date(year, month + 1, 7).getTime();
  const events = calendar.expandRange(cal.sources, from, to, { includeAllDay: true })
    .map((e) => ({ start: e.start, end: e.end, summary: e.summary || '일정',
                   allDay: !!e.allDay, calendar: e.calendar }));
  return {
    year, month,
    firstWeekday: first.getDay(),
    daysInMonth: new Date(year, month + 1, 0).getDate(),
    events,
    hasCalendar: (cal.sources || []).length > 0,
    errors: cal.errors.map((e) => ({ name: e.name, message: e.message }))
  };
});
ipcMain.on('cal:open', () => showCalendarPanel());

/**
 * 위젯 안 달력을 펼치고 접을 때 창 높이를 그만큼 늘렸다 되돌린다.
 * 필요한 높이는 렌더러가 실제로 그려본 값을 보내온다 — 칸이 정사각형이라
 * 폭에 따라 달라져서 여기서 계산하면 어긋난다.
 */
let widgetBaseHeight = null;
ipcMain.on('cal:panel', (_e, { on, needed }) => {
  if (!widgetWin || widgetWin.isDestroyed() || !widgetSize) return;
  if (on) {
    if (widgetBaseHeight == null) widgetBaseHeight = widgetSize.height;
    const h = Math.round(clamp(widgetBaseHeight + (needed || 0) + 8,
      WIDGET_MIN.height, WIDGET_MAX.height));
    widgetSize = { ...widgetSize, height: h };
  } else {
    if (widgetBaseHeight == null) return;
    widgetSize = { ...widgetSize, height: widgetBaseHeight };
    widgetBaseHeight = null;
  }
  const [x, y] = widgetWin.getPosition();
  widgetWin.setBounds({ x, y, ...widgetSize });
});

/** 기록 창이 그릴 전체 데이터 */
function statsPayloadFull(typeId) {
  const custom = store.custom;
  const weeks = store.settings.grassWeeks || 15;
  const active = scheduler.activeIds();
  const now = Date.now();

  const tabs = active.map((id) => {
    const at = scheduler.nextAt.get(id);
    return {
      ...reminders.meta(id, custom),
      remaining: at ? Math.max(0, Math.round((at - now) / 1000)) : null
    };
  });

  const sel = typeId && active.includes(typeId) ? typeId : null;
  const g = store.grassSeries(weeks, sel);
  const st = store.streaks(sel);

  return {
    weeks,
    selected: sel,
    tabs,
    grass: g.cells,
    max: g.max,
    streak: st,
    today: store.todayCount(sel),
    detail: sel ? tabs.find((t) => t.id === sel) : null
  };
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.on('widget:toggle-pause', togglePause);
ipcMain.on('widget:break-now', (_e, id) => startBreak(id ? [id] : null));
ipcMain.on('widget:open-settings', openSettings);
ipcMain.on('widget:open-stats', (_e, id) => openStats(id || null));
ipcMain.on('widget:hide', () => widgetWin && widgetWin.hide());

// 기록 창
ipcMain.handle('stats:data', (_e, typeId) => statsPayloadFull(typeId));
ipcMain.on('stats:set-weeks', (_e, weeks) => {
  store.setSettings({ grassWeeks: clamp(Math.round(weeks), 4, 53) });
});
ipcMain.on('stats:break-now', (_e, id) => { if (id) startBreak([id]); });
ipcMain.on('stats:close', () => statsWin && statsWin.close());
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
ipcMain.handle('widget:get-bounds', () => {
  if (!widgetWin || widgetWin.isDestroyed()) return { x: 0, y: 0, ...WIDGET_DEFAULT };
  return widgetWin.getBounds();
});
// 가장자리·모서리 드래그 (렌더러의 리사이즈 존). dir에 w/n이 들어가면 반대쪽
// 모서리가 제자리에 있어야 하므로, 크기가 한계에 걸린 만큼 좌표를 되돌린다.
ipcMain.on('widget:set-bounds', (_e, { x, y, width, height, dir }) => {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const w = Math.round(clamp(width, WIDGET_MIN.width, WIDGET_MAX.width));
  const h = Math.round(clamp(height, WIDGET_MIN.height, WIDGET_MAX.height));
  const nx = Math.round(String(dir).includes('w') ? x + (width - w) : x);
  const ny = Math.round(String(dir).includes('n') ? y + (height - h) : y);
  widgetSize = { width: w, height: h };   // 이후 이동은 이 크기를 못박는다
  widgetWin.setBounds({ x: nx, y: ny, width: w, height: h });
  if (evlog.enabled) {
    const got = widgetWin.getBounds();
    const clamped = (w !== Math.round(width) || h !== Math.round(height)) ? ' [한계에 걸림]' : '';
    evlog.log('main', `set-bounds(${dir}) 요청 ${Math.round(width)}x${Math.round(height)}`
      + ` → 적용 ${w}x${h}${clamped} → 실제 ${got.width}x${got.height} @${got.x},${got.y}`);
  }
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
  // setPosition을 쓰면 안 된다 — 배율 150%에서 호출마다 창이 1px씩 부푼다(실측).
  // 드래그는 초당 수십 번이라 순식간에 최대치까지 자란다.
  // 크기를 함께 지정하되, 반드시 "우리가 정한 값"이어야 한다. 실제 크기를
  // 되읽어 넣으면 부푼 값이 다시 들어가 똑같이 폭주한다.
  widgetWin.setBounds({ x: Math.round(x), y: Math.round(y), ...widgetSize });
  evlog.log('main', `move → @${Math.round(x)},${Math.round(y)} (크기 ${widgetSize.width}x${widgetSize.height} 고정)`);
});

// 렌더러가 보내는 포인터 이벤트 기록
ipcMain.on('debug:log', (_e, { source, message }) => evlog.log(source, message));

ipcMain.handle('overlay:get-bg', (_e, id) => overlayShots.get(String(id)) || null);
ipcMain.handle('overlay:get-payload', () => breakPayload);
ipcMain.on('overlay:snooze', () => endBreak('snoozed'));
ipcMain.on('overlay:skip', () => endBreak('skipped'));
ipcMain.on('overlay:done', () => endBreak('done')); // 남은 시간을 기다리지 않고 일찍 끝내기

// 자동 실행은 OS 상태(시작 폴더 바로가기)가 진실이므로 저장값을 신뢰하지 않는다.
ipcMain.handle('autolaunch:get', () => autolaunch.isEnabled());
ipcMain.handle('autolaunch:set', (_e, on) => {
  const actual = autolaunch.setEnabled(on);
  store.setSettings({ autoLaunch: actual });
  return actual;
});

ipcMain.handle('settings:get', () => ({
  settings: { ...store.settings, autoLaunch: autolaunch.isEnabled() },
  reminders: store.reminders,
  custom: store.custom,
  calendars: store.calendars,
  calendarStatus: calendarStatus(),
  dndPresets: dnd.PRESETS,
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
  // 붙여넣은 형태가 무엇이든 ICS 주소로 바꾸고, 이름은 캘린더가 밝힌 것을 쓴다.
  // 이름까지 지어내게 하면 거기서 그만두는 사람이 생긴다.
  const normalized = calendar.normalizeUrl(url);
  let finalName = String(name || '').trim();
  if (!finalName) {
    try { finalName = calendar.calendarName(await calendar.fetchText(normalized)); } catch { /* 이름은 없어도 된다 */ }
  }
  store.addCalendar({ name: finalName || '캘린더', url: normalized });
  await refreshCalendars();
  return { calendars: store.calendars, status: calendarStatus() };
});

/** 클립보드에 캘린더 주소가 있으면 알려준다 — 복사해 온 것을 한 번 눌러 넣게 */
ipcMain.handle('cal:clipboard', () => {
  const text = clipboard.readText();
  if (!calendar.looksLikeCalendar(text)) return null;
  const url = calendar.normalizeUrl(text);
  if (store.calendars.some((c) => c.url === url)) return null;   // 이미 넣은 것
  return { url, raw: text.slice(0, 120) };
});

/** 주소를 찾아야 하는 설정 페이지를 대신 열어준다 */
ipcMain.handle('cal:open-help', (_e, which) => {
  const urls = {
    google: 'https://calendar.google.com/calendar/r/settings',
    outlook: 'https://outlook.live.com/calendar/0/options/calendar/SharedCalendars'
  };
  const target = urls[which];
  if (target) shell.openExternal(target);
  return !!target;
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
    const text = await calendar.fetchText(calendar.normalizeUrl(url));
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
ipcMain.on('update:install', installUpdate);
// ── 세션 유지 ─────────────────────────────────────────────
// 업데이트로 앱이 다시 시작돼도 카운트다운이 처음부터 돌지 않게, 종료 직전 상태를 저장한다.
function saveSession() {
  try {
    store.setSession(session.capture({
      paused: state.paused,
      widgetHidden: !!(widgetWin && !widgetWin.isDestroyed() && !widgetWin.isVisible()),
      nextAt: Object.fromEntries(scheduler.nextAt)
    }));
  } catch (e) {
    console.warn('[session] save failed:', e.message);
  }
}

/** @returns {{restored:number, widgetHidden:boolean}|null} */
function restoreSession() {
  const p = session.plan(store.session, [...scheduler.nextAt.keys()]);
  store.clearSession();
  if (!p) return null;
  state.paused = p.paused;
  for (const [id, at] of Object.entries(p.nextAt)) scheduler.nextAt.set(id, at);
  return { restored: p.restored, widgetHidden: p.widgetHidden };
}

/** 업데이트 설치 — 재시작 후 이어가도록 상태를 먼저 저장한다 */
function installUpdate() {
  saveSession();
  updater.installNow();
}

ipcMain.on('settings:set-app', (_e, patch) => {
  store.setSettings(patch);
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

// 사용자 지정 알림
ipcMain.handle('settings:custom-add', (_e, def) => {
  const { id, custom } = store.addCustom(def);
  scheduler.sync();
  scheduler.schedule(id);
  updateTray();
  pushTick();
  return custom;
});
ipcMain.handle('settings:custom-update', (_e, { id, patch }) => {
  store.setCustom(id, patch);
  scheduler.sync();
  if (patch && patch.intervalMin != null) scheduler.schedule(id);
  updateTray();
  pushTick();
  return store.custom;
});
ipcMain.handle('settings:custom-remove', (_e, id) => {
  store.setCustom(id, null);
  scheduler.sync();
  updateTray();
  pushTick();
  return store.custom;
});

// ── 라이프사이클 ──────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (widgetWin) { widgetWin.show(); widgetWin.focus(); } });

  app.whenReady().then(() => {
    evlog.init(app.getPath('userData'));
    tray = new Tray(nativeImage.createFromPath(ICON));
    if (store.settings.eventLog) setEventLog(true);
    // 트레이 아이콘을 더블클릭하면 위젯이 다시 나온다 (Windows 관례)
    tray.on('double-click', revealWidget);
    // 예전 버전에서 설정값으로만 켜 두었던 경우를 실제 바로가기로 옮긴다
    if (app.isPackaged) {
      const on = autolaunch.migrate(store.settings.autoLaunch);
      if (on !== store.settings.autoLaunch) store.setSettings({ autoLaunch: on });
      console.log('[autolaunch]', on ? '켜짐' : '꺼짐', '·', autolaunch.linkPath());
    }

    scheduler.reset();
    const resumed = restoreSession();
    if (resumed) console.log(`[session] 이전 상태 이어가기 (알림 ${resumed.restored}개)`);

    updateTray();
    createWidget();
    if (resumed && resumed.widgetHidden) widgetWin.hide();
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

    // 강제 종료로 세션을 잃지 않게 주기적으로도 저장한다
    setInterval(saveSession, 60_000);
    app.on('before-quit', saveSession);

    // 개발용: NUNS_DEV=settings,break 로 창을 바로 띄워 확인한다
    const dev = (process.env.NUNS_DEV || '').split(',').map((s) => s.trim());
    if (dev.includes('settings')) setTimeout(openSettings, 1200);
    if (dev.includes('break')) setTimeout(() => startBreak(scheduler.activeIds()), 1800);
    if (dev.includes('stats')) setTimeout(() => openStats(null), 1200);
  });

  app.on('window-all-closed', () => { /* 트레이 상주 */ });
}

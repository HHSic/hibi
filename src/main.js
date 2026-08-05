const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, nativeImage, desktopCapturer, nativeTheme, shell, dialog, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');

// 개발용으로 실행할 때는 설치본과 데이터 폴더를 분리한다.
// 같은 폴더를 쓰면 개발 인스턴스가 옛 설정을 들고 있다가 저장하면서
// 사용자가 방금 넣은 계정·설정을 통째로 덮어쓴다 (실제로 겪었다).
// store.js가 require 시점에 userData 경로를 읽으므로 반드시 그 전에 바꿔야 한다.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Hibi (개발)'));
}

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
const calcache = require('./calcache');
const mail = require('./mail');
const mailbackup = require('./mailbackup');
const send = require('./send');
const secret = require('./secret');

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

/**
 * 저장해둔 원문으로 일정을 먼저 채운다.
 * 네트워크 응답을 기다리는 동안(오프라인이면 영영) 달력이 비어 있지 않게 한다.
 */
function primeCalendarsFromCache() {
  if (!store.calendars.length) return;
  const cached = calcache.load(app.getPath('userData'));
  if (!cached) return;
  const now = Date.now();
  cal.sources = cached.sources;
  cal.fetchedAt = cached.fetchedAt;
  cal.stale = true;                  // 갱신에 성공하면 false가 된다
  cal.occurrences = calendar.expandRange(
    cached.sources, now - 2 * 86400000, now + 2 * 86400000,
    { includeAllDay: store.settings.calendarAllDay }
  );
  console.log(`[calendar] 저장해둔 일정 ${cal.occurrences.length}건으로 시작합니다`);
}

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
    cal.stale = false;
    calcache.save(app.getPath('userData'), r.sources, r.fetchedAt);
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('cal:changed');
    if (r.errors.length) console.warn('[calendar] 일부 실패:', r.errors.map((e) => e.message).join(', '));
  } catch (e) {
    console.warn('[calendar] refresh failed:', e.message,
      cal.sources.length ? '— 저장해둔 일정으로 계속합니다' : '');
  } finally {
    cal.loading = false;
  }
}

// ── 메일 ────────────────────────────────────────────────
// "새 메일 왔다"를 즉시 들이밀면 쉼을 위한 위젯이 방해 도구가 된다.
// 기본은 모아서 — 계속 확인은 하되, 알리는 건 정해진 시각과 휴식 때만.
const mailState = {
  unread: 0,
  messages: [],
  errors: [],
  fetchedAt: 0,
  loading: false,
  lastAnnouncedAt: 0,   // 마지막으로 "새 메일 n통"을 알린 시각
  pending: 0            // 알리지 않고 쌓아둔 새 메일 수
};

/** 저장된 계정을 실제 접속용으로 — 비밀번호를 여기서만 푼다 */
function mailAccountsForUse() {
  return store.mailAccounts
    .filter((a) => a.enabled !== false && a.host && a.user)
    .map((a) => ({ ...a, pass: secret.open(a.sealed) }))
    .filter((a) => a.pass);
}

/**
 * @param force 이미 도는 중이면 그게 끝나기를 기다렸다 다시 읽는다.
 *   읽음 표시처럼 "방금 서버를 바꿔놓고 숫자를 맞춰야 하는" 경우에 쓴다.
 *   그냥 넘기면 화면이 다음 주기(몇 분)까지 옛 숫자를 들고 있는다.
 */
async function refreshMail({ force = false } = {}) {
  if (!store.settings.mailEnabled) { evlog.log('메일', '건너뜀 — 메일 확인이 꺼져 있음'); return; }
  if (mailState.loading) {
    if (!force) return;
    for (let i = 0; i < 60 && mailState.loading; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (mailState.loading) return;
  }
  const accounts = mailAccountsForUse();
  if (!accounts.length) {
    mailState.unread = 0;
    mailState.messages = [];
    evlog.log('메일', `건너뜀 — 쓸 수 있는 계정 없음 (저장된 계정 ${store.mailAccounts.length}개)`);
    return;
  }

  mailState.loading = true;
  const before = mailState.unread;
  try {
    const errors = [];
    let unread = 0;
    let messages = [];
    for (const acc of accounts) {
      try {
        const r = await mail.fetchSummary(acc, {
          limit: store.settings.mailCount || 5,
          onlyUnread: store.settings.mailOnlyUnread !== false
        });
        unread += r.unread;
        messages.push(...r.messages.map((m) => ({ ...m, account: acc.name, accountId: acc.id })));
      } catch (e) {
        errors.push({ name: acc.name, message: mail.friendly(e) });
      }
    }
    // 주소록은 받은 메일에서 자란다 — 이름과 주소가 한 쌍씩 들어 있다.
    // 이렇게 해두면 나중에 «김부장»만 쳐도 주소가 나온다.
    store.rememberContacts(messages
      .filter((m) => m.fromAddress)
      .map((m) => ({ address: m.fromAddress, name: m.fromName })));

    messages.sort((a, b) => b.at - a.at);
    mailState.unread = unread;
    mailState.messages = messages.slice(0, Math.max(1, Math.round(store.settings.mailCount) || 5));
    mailState.errors = errors;
    mailState.fetchedAt = Date.now();
    if (unread > before) mailState.pending += unread - before;
    evlog.log('메일', `확인 완료 · 계정 ${accounts.length}개 · 안읽음 ${unread}`
      + ` · 목록 ${mailState.messages.length}건`
      + (errors.length ? ` · 실패 ${errors.length}건: ${errors[0].message}` : ''));
    if (errors.length) console.warn('[mail]', errors.map((e) => `${e.name}: ${e.message}`).join(', '));
  } finally {
    mailState.loading = false;
  }
  // 새로 온 것을 파일로 남긴다. 기다리지 않는다 — 메일 목록은 이미 화면에 올라가야 한다.
  autoBackupNew();
}

/**
 * 지금 "새 메일 n통"을 알릴 때인가.
 * 모아서 모드면 설정한 시각을 막 지났을 때만 — 하루 몇 번으로 끝난다.
 */
function mailAnnounce(now = Date.now()) {
  const s = store.settings;
  if (!s.mailEnabled || !mailState.pending) return null;
  if (s.mailMode === 'instant') return takeAnnounce();

  const d = new Date(now);
  const times = Array.isArray(s.mailTimes) ? s.mailTimes : [];
  const hour = d.getHours();
  if (!times.includes(hour)) return null;
  // 같은 시각대에 한 번만
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).getTime();
  if (mailState.lastAnnouncedAt >= slot) return null;
  mailState.lastAnnouncedAt = slot;
  return takeAnnounce();
}

function takeAnnounce() {
  const n = mailState.pending;
  mailState.pending = 0;
  mailState.lastAnnouncedAt = Date.now();
  return n > 0 ? { count: n, unread: mailState.unread } : null;
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
      calmode: store.settings.calendarMode || 'month',
      mailpanel: store.settings.mailPanel ? '1' : ''
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
  const s = store.settings;
  return {
    items, grouped,
    mode: grouped || anyLong ? 'checklist' : 'single',
    sound: { enabled: s.soundEnabled, name: s.soundName, volume: s.soundVolume }
  };
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

// 매 초 찍으면 기록이 메일로 뒤덮인다 — 내용이 바뀔 때만 남긴다
let lastMailLog = '';
function logMailPayload(box) {
  if (!evlog.enabled) return;
  const s = store.settings;
  const key = box ? `on:${box.unread}:${box.messages.length}` : `off:${s.mailEnabled}:${s.mailShow}`;
  if (key === lastMailLog) return;
  lastMailLog = key;
  evlog.log('메일', box
    ? `위젯에 전달 · 안읽음 ${box.unread} · 목록 ${box.messages.length}건`
    : `위젯에 안 보냄 — 메일확인=${s.mailEnabled} 위젯표시=${s.mailShow}`);
}

function pushTick() {
  if (!widgetWin || widgetWin.isDestroyed()) return;

  const next = scheduler.soonest();
  const custom = store.custom;
  let payload;

  // 오늘 일정 — 위젯 시트에서 예정된 알림과 나란히 보여준다
  const schedule = store.settings.calendarShow ? planner.today(cal.occurrences) : [];
  const mailBox = (store.settings.mailEnabled && store.settings.mailShow)
    ? { unread: mailState.unread, messages: mailState.messages }
    : null;
  logMailPayload(mailBox);

  if (!next) {
    payload = { empty: true, paused: state.paused, today: store.todayStats(), schedule, mail: mailBox };
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
      mail: mailBox,
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
  // 창은 살아 있어도 렌더러 프레임이 먼저 정리되는 순간이 있다 (종료·새로고침 직전).
  // 그때 보내면 던진다 — 1초마다 도는 틱이 콘솔을 채울 이유는 없다.
  try { widgetWin.webContents.send('tick', payload); } catch { /* 곧 사라질 창이다 */ }
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
// 구독 주소는 15분마다 다시 읽는다. 그런데 사용자가 방금 일정을 고치고 달력을 열면
// 그때까지 옛 내용을 보게 된다 — 열 때 한 번 더 읽는다. 너무 자주 부르지는 않는다.
const CAL_NUDGE_MS = 45_000;
let calNudgedAt = 0;
function nudgeCalendar(force = false) {
  if (!force && Date.now() - calNudgedAt < CAL_NUDGE_MS) return;
  calNudgedAt = Date.now();
  refreshCalendars();
}

function showCalendarPanel() {
  store.setSettings({ calendarPanel: true });
  nudgeCalendar();
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
                   allDay: !!e.allDay, calendar: e.calendar,
                   uid: e.uid || null, url: e.url || null, calUrl: e.calUrl || null }));
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
 * 일정을 웹에서 연다. 쓰기 권한(OAuth)을 받는 대신 브라우저를 열어준다 —
 * 사용자는 이미 그 캘린더에 로그인해 있으므로 거기서 고치면 된다.
 */
ipcMain.handle('cal:open-event', (_e, ev) => {
  const link = calendar.eventLink(ev, ev && ev.calUrl);
  if (!link) return false;
  shell.openExternal(link);
  // 고치러 나간 것이다. 돌아왔을 때 옛 내용이 그대로면 안 고쳐진 줄 안다.
  // 구독 주소는 서버 쪽에도 잠깐 캐시가 있어서 한 번만 부르면 놓친다.
  scheduleCalendarCatchUp();
  return true;
});

/** 브라우저에서 고치고 돌아올 즈음 몇 번 나눠 다시 읽는다 */
function scheduleCalendarCatchUp() {
  for (const ms of [20_000, 60_000, 150_000]) {
    setTimeout(() => nudgeCalendar(true), ms).unref?.();
  }
}

/** 빈 날짜를 누르면 그 시각으로 새 일정 만들기 화면을 연다 */
ipcMain.handle('cal:new-event', (_e, { start, end }) => {
  const hasGoogle = store.calendars.some((c) => calendar.googleCalendarId(c.url));
  if (!hasGoogle) return false;
  shell.openExternal(calendar.newEventLink(start, end));
  scheduleCalendarCatchUp();
  return true;
});

/**
 * 위젯 안 달력을 펼치고 접을 때 창 높이를 그만큼 늘렸다 되돌린다.
 * 필요한 높이는 렌더러가 실제로 그려본 값을 보내온다 — 칸이 정사각형이라
 * 폭에 따라 달라져서 여기서 계산하면 어긋난다.
 */
let widgetBaseHeight = null;
const panelHeights = { cal: 0, mail: 0 };   // 패널이 둘이라 각자 얼마나 쓰는지 따로 센다
ipcMain.on('cal:panel', (_e, { on, needed, which }) => {
  if (!widgetWin || widgetWin.isDestroyed() || !widgetSize) return;
  panelHeights[which === 'mail' ? 'mail' : 'cal'] = on ? (needed || 0) : 0;
  const extra = panelHeights.cal + panelHeights.mail;
  if (extra > 0) {
    if (widgetBaseHeight == null) widgetBaseHeight = widgetSize.height;
    const h = Math.round(clamp(widgetBaseHeight + extra + 8,
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
  // 사람이 직접 조절한 크기가 새 기준이 된다. 이걸 갱신하지 않으면
  // 패널을 접을 때 조절하기 전 크기로 되돌아간다.
  if (widgetBaseHeight != null) {
    widgetBaseHeight = Math.max(WIDGET_MIN.height,
      h - (panelHeights.cal + panelHeights.mail) - 8);
  }
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

// ── 메일 IPC ────────────────────────────────────────────
/** 계정 목록 (비밀번호는 절대 렌더러로 보내지 않는다 — 저장 여부만 알린다) */
function mailAccountsForUi() {
  return store.mailAccounts.map(({ sealed, ...rest }) => ({ ...rest, hasPassword: !!sealed }));
}
function mailStatus() {
  return {
    unread: mailState.unread,
    fetchedAt: mailState.fetchedAt,
    errors: mailState.errors,
    canStore: secret.available
  };
}

ipcMain.handle('mail:get', () => ({
  accounts: mailAccountsForUi(), status: mailStatus(), presets: mail.PRESETS
}));
ipcMain.handle('mail:test', async (_e, acc) => {
  // 새로 입력한 비밀번호가 없으면 저장된 것으로 시험한다
  const pass = acc.pass || secret.open((store.mailAccounts.find((a) => a.id === acc.id) || {}).sealed);
  if (!pass) return { ok: false, message: '비밀번호를 입력하세요' };
  return mail.test({ ...acc, pass });
});
ipcMain.handle('mail:add', async (_e, acc) => {
  if (!secret.available) {
    return { ok: false, message: '이 PC에서는 비밀번호를 안전하게 저장할 수 없습니다' };
  }
  const t = await mail.test({ ...acc, pass: acc.pass });
  if (!t.ok) return { ok: false, message: t.message };
  store.addMailAccount({ ...acc, sealed: secret.seal(acc.pass) });
  // 계정을 넣었는데 별도 스위치를 또 켜야 보인다면, 안 보이는 게 당연해진다
  if (!store.settings.mailEnabled) store.setSettings({ mailEnabled: true });
  // 저장이 실제로 파일까지 갔는지 확인한다 — 메모리에만 남으면 다음 실행에 사라진다
  const saved = store.mailAccounts.length;
  const onDisk = store.reloadFromDisk().mailAccounts.length;
  evlog.log('메일', `계정 추가 · 메모리 ${saved}개 · 파일 ${onDisk}개`
    + (saved !== onDisk ? ' ← 파일에 저장되지 않았습니다' : ''));
  await refreshMail();
  return {
    ok: true, message: t.message,
    accounts: mailAccountsForUi(), settings: store.settings
  };
});
ipcMain.handle('mail:update', (_e, { id, patch }) => {
  const p = { ...patch };
  if (p.pass) { p.sealed = secret.seal(p.pass); delete p.pass; }
  store.updateMailAccount(id, p);
  refreshMail();
  return mailAccountsForUi();
});
ipcMain.handle('mail:remove', (_e, id) => {
  store.removeMailAccount(id);
  refreshMail();
  return mailAccountsForUi();
});
ipcMain.handle('mail:refresh', async () => { await refreshMail(); return mailStatus(); });

/**
 * 열어보지 않고 읽음으로만 표시한다.
 * uids가 없으면 그 계정의 안 읽은 것 전부, accountId가 없으면 모든 계정.
 */
ipcMain.handle('mail:mark-read', async (_e, { accountId, uids, read = true } = {}) => {
  const accounts = mailAccountsForUse().filter((a) => !accountId || a.id === accountId);
  if (!accounts.length) {
    return { ok: false, changed: 0, message: '쓸 수 있는 계정이 없습니다', ...mailStatus() };
  }
  let changed = 0;
  const failed = [];
  for (const acc of accounts) {
    try {
      const r = await mail.markRead(acc, uids, { read });
      changed += r.changed;
    } catch (e) {
      failed.push(`${acc.name || acc.user}: ${e.message || mail.friendly(e)}`);
      // 왜 거부됐는지는 서버가 SELECT 때 알려준 것을 봐야 안다 — 그대로 남긴다
      if (e.diag) {
        evlog.log('메일', `읽음 표시 진단 · ${acc.name || acc.user}`
          + ` · 읽기전용=${e.diag.readOnly}`
          + ` · PERMANENTFLAGS=[${e.diag.permanentFlags.join(' ') || '(없음)'}]`);
      }
    }
  }
  evlog.log('메일', `${read ? '읽음' : '안 읽음'} 표시 · ${changed}통`
    + (failed.length ? ` · 실패 ${failed.join(' / ')}` : ''));
  // 서버 쪽이 바뀌었으니 화면 숫자도 바로 맞춘다. 마침 폴링이 돌고 있으면
  // 그게 끝나기를 기다렸다가 다시 부른다 — 그냥 넘기면 다음 주기(몇 분)까지 숫자가 안 바뀐다.
  await refreshMail({ force: true });
  return {
    ok: failed.length === 0,
    changed,
    message: failed.length ? failed[0] : '',
    ...mailStatus()
  };
});

// ── 메일 쓰기 ───────────────────────────────────────────
// 받기(IMAP)와 보내기(SMTP)는 서버가 다르다. 창은 하나만 띄운다 —
// 쓰던 글이 있는데 새 창이 겹쳐 뜨면 어느 쪽에 쓰고 있었는지 잃는다.
let composeWin = null;
let composePayload = null;
let composeSize = null;

function openCompose(payload) {
  if (composeWin && !composeWin.isDestroyed()) {
    // 쓰던 글이 있는데 새 초안으로 갈아끼우면 그 글은 그대로 사라진다.
    // 화면에 물어보고, 아니라고 하면 쓰던 것을 그대로 둔다.
    composeWin.focus();
    composeWin.webContents.send('compose:replace', payload);
    return true;
  }
  composePayload = payload;
  const saved = store.settings.composeSize;
  const cap = mailViewMax();
  composeWin = new BrowserWindow({
    width: Math.round(clamp((saved && saved.width) || 520 + PAD, 380, cap.width)),
    height: Math.round(clamp((saved && saved.height) || 520 + PAD, 320, cap.height)),
    minWidth: 380, minHeight: 320,
    frame: false,
    resizable: false,            // 크기 조절은 렌더러의 리사이즈 존이 맡는다
    alwaysOnTop: false, skipTaskbar: false,
    title: '메일 쓰기',
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  composeSize = { width: composeWin.getSize()[0], height: composeWin.getSize()[1] };
  lockToOurPage(composeWin);
  composeWin.loadFile(page('compose.html'), { query: glassQuery({ radius: '20' }) });
  composeWin.on('closed', () => { composeWin = null; composePayload = null; });
  return true;
}

/** 새 메일 / 답장 / 전달 — 어느 쪽이든 초안을 만들어 창을 연다 */
ipcMain.handle('compose:open', (_e, { kind = 'new', accountId, source } = {}) => {
  const accounts = mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: '쓸 수 있는 계정이 없습니다' };

  // 답장·전달은 반드시 그 메일을 받은 계정으로 써야 한다. 못 찾았다고 첫 계정으로 넘기면
  // 개인 메일에 회사 주소로 답장이 나간다 — 받는 사람 눈에는 그게 내 정체다.
  const asked = accounts.find((a) => a.id === accountId);
  if (!asked && kind !== 'new') {
    return { ok: false, message: '이 메일을 받은 계정을 쓸 수 없습니다 (꺼져 있거나 지워졌습니다)' };
  }
  const acc = asked || accounts[0];

  const draft = kind === 'new' ? { to: '', subject: '', text: '' } : send.draftFrom(kind, source);
  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  const ok = openCompose({
    accountId: acc.id,
    signature: stored.signature || '',
    signatures: Object.fromEntries(store.mailAccounts.map((a) => [a.id, a.signature || ''])),
    title: kind === 'reply' ? '답장' : kind === 'forward' ? '전달' : '새 메일',
    // 새 메일은 어느 계정으로 보낼지 고를 수 있어야 한다 — 안 그러면 «마지막에 온 메일의
    // 계정»으로 정해져서, 받은 순서가 내 발신 주소를 결정하게 된다
    pickable: kind === 'new',
    accounts: accounts.map((a) => {
      const f = mail.fromOf(a);
      return { id: a.id, name: a.name || a.user, from: f.address, label: f.name };
    }),
    ...draft
  });
  return { ok, message: '' };
});

ipcMain.handle('compose:data', () => composePayload);
ipcMain.on('compose:close', () => composeWin && !composeWin.isDestroyed() && composeWin.close());
/** 화면이 «갈아끼워도 좋다»고 하면 그때 초안을 바꾼다 */
ipcMain.on('compose:accept-replace', (_e, payload) => { composePayload = payload; });
/** 새 메일에서 보낼 계정을 바꾼다 */
ipcMain.on('compose:set-account', (_e, id) => {
  if (composePayload && mailAccountsForUse().some((a) => a.id === id)) composePayload.accountId = id;
});

// 화면이 «이 파일을 붙여라»라고 말한 것을 그대로 믿으면, 렌더러가 뚫렸을 때 이 PC의
// 아무 파일이나 메일로 실어 보낼 수 있다. 대화상자로 사용자가 직접 고른 것만 기억해 둔다.
const attachOk = new Set();

ipcMain.handle('compose:attach', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(composeWin || undefined, {
    title: '첨부할 파일', properties: ['openFile', 'multiSelections']
  });
  if (canceled) return [];
  return filePaths.map((p) => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* 크기를 못 읽어도 붙일 수는 있다 */ }
    attachOk.add(p);
    return { path: p, filename: path.basename(p), size };
  });
});

const ATTACH_MAX = 25 * 1024 * 1024;   // 대부분의 메일 서버가 이쯤에서 거절한다

let sendingNow = false;

ipcMain.handle('compose:send', async (_e, msg) => {
  // 화면 쪽 잠금이 풀린 틈에 두 번 들어와도 두 번 나가지 않게 한다
  if (sendingNow) return { ok: false, message: '이미 보내는 중입니다' };
  const acc = mailAccountsForUse().find((a) => a.id === (composePayload && composePayload.accountId));
  if (!acc) return { ok: false, message: '계정을 찾을 수 없습니다' };

  const picked = (msg && msg.attachments) || [];
  const sneaky = picked.find((a) => !attachOk.has(a && a.path));
  if (sneaky) return { ok: false, message: '첨부는 «파일 첨부»로 고른 것만 보낼 수 있습니다' };
  let bytes = 0;
  for (const a of picked) {
    try { bytes += fs.statSync(a.path).size; } catch { /* 없으면 보낼 때 걸린다 */ }
  }
  if (bytes > ATTACH_MAX) {
    return { ok: false, message: `첨부가 너무 큽니다 (${Math.round(bytes / 1048576)}MB · 최대 25MB)` };
  }

  sendingNow = true;
  let r;
  try {
    r = await send.sendMail(acc, msg || {});
  } finally {
    sendingNow = false;
  }
  evlog.log('메일', r.ok
    ? `보냄 · ${r.accepted}명${r.rejected && r.rejected.length ? ` · 거절 ${r.rejected.join(',')}` : ''}`
      + `${r.sentBox ? ` · 보낸편지함(${r.sentBox})에 저장` : ''}`
    : `보내기 실패 · ${r.message}`);
  if (r.ok) {
    // 보낸 주소는 다음부터 자동완성된다 — 주소록을 손으로 채우게 하면 아무도 안 채운다
    store.rememberContacts([
      ...send.addresses(msg.to), ...send.addresses(msg.cc), ...send.addresses(msg.bcc)
    ].map((a) => ({ address: a.replace(/^.*<|>.*$/g, '').trim(), name: '' })));
    refreshMail();
  }
  return r;
});

/** 주소록 — 쓰기 창의 자동완성과 설정 화면이 쓴다 */
ipcMain.handle('mail:contacts', () => store.contacts);
ipcMain.handle('mail:contact-save', (_e, c) => store.saveContact(c || {}));
ipcMain.handle('mail:contact-remove', (_e, address) => store.removeContact(address));

/** 본문에 넣을 그림 — 대화상자로 고른 것만 읽어 화면에 돌려준다 */
const IMAGE_MAX = 5 * 1024 * 1024;
ipcMain.handle('compose:pick-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(composeWin || undefined, {
    title: '본문에 넣을 그림',
    filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled) return [];
  const out = [];
  for (const p of filePaths) {
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > IMAGE_MAX) continue;   // 본문 그림은 크면 메일이 통째로 무거워진다
      const ext = path.extname(p).slice(1).toLowerCase();
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
      out.push({
        filename: path.basename(p),
        contentType: type,
        dataUrl: `data:${type};base64,${buf.toString('base64')}`
      });
    } catch { /* 못 읽는 파일은 건너뛴다 */ }
  }
  return out;
});

ipcMain.handle('compose:bounds', () => {
  if (!composeWin || composeWin.isDestroyed()) return { x: 0, y: 0, width: 520, height: 520 };
  return composeWin.getBounds();
});
ipcMain.on('compose:move', (_e, { x, y }) => {
  if (!composeWin || composeWin.isDestroyed() || !composeSize) return;
  // setPosition은 배율이 100%가 아닐 때 호출마다 창을 부풀린다 — 크기를 못박아 옮긴다
  composeWin.setBounds({ x: Math.round(x), y: Math.round(y), ...composeSize });
});
ipcMain.on('compose:set-bounds', (_e, { x, y, width, height, dir }) => {
  if (!composeWin || composeWin.isDestroyed()) return;
  const max = mailViewMax();
  const w = Math.round(clamp(width, 380, max.width));
  const h = Math.round(clamp(height, 320, max.height));
  const nx = Math.round(String(dir).includes('w') ? x + (width - w) : x);
  const ny = Math.round(String(dir).includes('n') ? y + (height - h) : y);
  composeSize = { width: w, height: h };
  composeWin.setBounds({ x: nx, y: ny, width: w, height: h });
  store.setSettings({ composeSize });
});

/** 보내기 설정이 맞는지 — 메일은 보내지 않고 로그인만 해 본다 */
ipcMain.handle('mail:smtp-test', async (_e, acc) => {
  const stored = store.mailAccounts.find((a) => a.id === (acc && acc.id));
  const pass = (acc && acc.pass) || secret.open(stored && stored.sealed);
  if (!pass) return { ok: false, message: '비밀번호를 입력하세요' };
  return send.verify({ ...stored, ...acc, pass });
});

// ── 메일 백업 ───────────────────────────────────────────
// 서버에 있는 메일을 .eml 파일로 내 PC에 내려둔다. 회사를 옮기거나 계정이 닫히면
// 웹메일에 있던 것은 같이 사라진다 — 파일로 남겨두면 그때도 열린다.
// 오래 걸리는 작업이라 상태를 남기고, 설정 화면이 그걸 들여다본다.
const backup = {
  running: false, stop: false,
  account: '', mailbox: '', done: 0, total: 0,
  saved: 0, skipped: 0, message: '', at: 0, dir: null
};

// 자동 백업은 사용자가 보고 있지 않을 때 도는 일이라 수동 진행률과 섞지 않는다.
// 여기 값만 따로 보여준다 — "언제 몇 통을 저장했는가".
const autoBackup = { at: 0, saved: 0, total: 0, error: null, seeded: 0 };

function backupStatus() {
  return {
    ...backup,
    dir: store.settings.mailBackupDir || null,
    auto: store.settings.mailAutoBackup === true,
    autoAt: autoBackup.at,
    autoSaved: autoBackup.saved,
    autoTotal: autoBackup.total,
    autoSeeded: autoBackup.seeded,
    autoError: autoBackup.error
  };
}

// ── 자동 백업 ───────────────────────────────────────────
// 두 순간에 저장한다.
//  1) 새 메일이 들어왔을 때 — 폴링이 끝나면 새로 생긴 UID만 받아 둔다
//  2) 사용자가 메일을 열었을 때 — 본문을 이미 받아왔으므로 서버를 더 부르지 않는다
//
// 켜자마자 몇 년치를 몰래 받지는 않는다(onlyNew). 지난 메일은 «백업 시작»의 몫이다.
const AUTO_GAP_MS = 2 * 60_000;   // 폴링이 잦아도 이보다 자주 돌지 않는다
let autoRunAt = 0;

/**
 * 자동 백업이 실제로 돌 수 있는 상태인가.
 * 메일 확인이 꺼져 있으면 폴링이 없어 새 메일을 알 방법이 없다 — 화면에도 그대로 알린다.
 */
function autoBackupOn() {
  return store.settings.mailAutoBackup === true
    && !!store.settings.mailBackupDir
    && store.settings.mailEnabled === true;
}

/** 열어본 메일 한 통 — 이미 받아온 원문을 그대로 파일로 남긴다 */
async function autoBackupOne(acc, m) {
  if (!autoBackupOn() || !m || !m.source) return;
  // 전체 백업이 도는 중이면 손대지 않는다. 그쪽은 폴더 목록을 미리 읽어두고 쓰는데
  // 그 사이에 파일을 끼워 넣으면 같은 메일이 두 번 저장된다. 어차피 그쪽이 받아간다.
  if (backup.running || autoBackup.running) return;
  try {
    const r = await mailbackup.saveOne(acc, store.settings.mailBackupDir, {
      mailbox: m.mailbox, uid: m.uid, receivedAt: m.receivedAt,
      subject: m.subject, source: m.source
    });
    if (r.saved) {
      autoBackup.at = Date.now();
      autoBackup.saved = 1;
      autoBackup.total += 1;
      autoBackup.error = null;
      evlog.log('메일', `자동 백업 · 열어본 메일 저장 (uid ${m.uid})`);
    }
  } catch (e) {
    autoBackup.error = e.message;
    evlog.log('메일', `자동 백업 실패 · ${e.message}`);
  }
}

/**
 * 폴링 뒤 — 새로 들어온 것만 받아 둔다.
 * @param now 켜자마자 한 번은 간격을 무시하고 돈다 (그래야 «지금부터»가 진짜 지금이다)
 */
async function autoBackupNew({ now = false } = {}) {
  // 수동 백업이 도는 중이면 비켜준다. 같은 폴더에 둘이 쓰면 서로를 밟는다.
  if (!autoBackupOn() || backup.running || autoBackup.running) return;
  if (!now && Date.now() - autoRunAt < AUTO_GAP_MS) return;
  autoRunAt = Date.now();

  const dir = store.settings.mailBackupDir;
  const accounts = mailAccountsForUse();
  if (!accounts.length) return;

  autoBackup.running = true;
  let saved = 0;
  let seeded = 0;
  const failed = [];
  for (const acc of accounts) {
    // 계정 하나가 넘어져도 나머지는 받는다
    try {
      const r = await mailbackup.backupAccount(acc, dir, { onlyNew: true });
      saved += r.saved;
      seeded += r.seeded;
    } catch (e) {
      failed.push(`${acc.name || acc.user}: ${mail.friendly(e)}`);
    }
  }
  autoBackup.running = false;
  autoBackup.at = Date.now();
  autoBackup.saved = saved;
  autoBackup.total += saved;
  autoBackup.seeded = seeded;
  autoBackup.error = failed.length ? failed[0] : null;
  if (saved || seeded || failed.length) {
    evlog.log('메일', `자동 백업 · 새 메일 ${saved}통 저장`
      + (seeded ? ` · 폴더 ${seeded}곳을 «지금부터»로 표시 (지난 메일은 받지 않음)` : '')
      + (failed.length ? ` · 실패 ${failed.join(' / ')}` : ''));
  }
}

ipcMain.handle('mail:backup-status', () => backupStatus());

ipcMain.handle('mail:backup-pick', async () => {
  // 도는 중에 폴더를 바꾸면 절반은 저쪽, 절반은 이쪽에 남는다
  if (backup.running || autoBackup.running) {
    backup.message = '백업이 도는 중에는 폴더를 바꿀 수 없습니다';
    return backupStatus();
  }
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '메일을 저장할 폴더',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.settings.mailBackupDir || app.getPath('documents')
  });
  if (canceled || !filePaths[0]) return backupStatus();

  // 여기서 못 쓰는 곳인지 바로 확인한다. 나중에 백업을 눌렀을 때 실패하면
  // 원인이 폴더인지 서버인지 알 수 없다. (C:\Users 밑처럼 윈도우가 막는 자리가 있다)
  const bad = backupDirProblem(filePaths[0]);
  if (bad) { backup.message = bad; return backupStatus(); }

  store.setSettings({ mailBackupDir: filePaths[0] });
  backup.message = '';
  return backupStatus();
});

/**
 * 이 폴더에 정말 쓸 수 있나. 실제로 만들어 보고 지운다 —
 * 권한은 존재 여부만으로는 알 수 없다.
 * @returns 문제가 있으면 사람이 읽을 사유, 없으면 null
 */
function backupDirProblem(dir) {
  const probe = path.join(dir, '.hibi-쓰기확인');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    try { fs.unlinkSync(probe); } catch { /* 없으면 그만 */ }
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return `이 폴더에는 쓸 수 없습니다 — 윈도우가 막는 자리입니다 (${dir}).`
        + ' 문서 폴더 안처럼 내 폴더를 고르세요.';
    }
    return `이 폴더를 쓸 수 없습니다 — ${e.message}`;
  }
}

ipcMain.on('mail:backup-stop', () => { backup.stop = true; });
ipcMain.on('mail:backup-open', () => {
  if (store.settings.mailBackupDir) shell.openPath(store.settings.mailBackupDir);
});

ipcMain.handle('mail:backup-start', async () => {
  // 자리를 먼저 잡는다. await 뒤에 검사하면 두 번 빠르게 누른 사이에 둘 다 통과해
  // 같은 폴더에 백업이 두 개 돈다.
  if (backup.running) return backupStatus();
  backup.running = true;
  try {
    // 자동 백업이 돌고 있으면 끝나기를 잠깐 기다린다 — 같은 폴더를 둘이 쓰면 안 된다
    for (let i = 0; i < 60 && autoBackup.running; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (autoBackup.running) throw new Error('자동 백업이 도는 중입니다. 잠시 뒤 다시 눌러주세요');
    if (!store.settings.mailBackupDir) throw new Error('저장할 폴더를 먼저 고르세요');
    // 폴더는 고른 뒤에도 지워지거나 권한이 바뀔 수 있다 — 시작 전에 다시 본다
    const bad = backupDirProblem(store.settings.mailBackupDir);
    if (bad) throw new Error(bad);
    if (!mailAccountsForUse().length) throw new Error('쓸 수 있는 계정이 없습니다');
  } catch (e) {
    backup.running = false;
    backup.message = e.message;
    return backupStatus();
  }

  // 도는 동안 폴더가 바뀌어도 시작할 때 고른 곳에 끝까지 쓴다
  const dir = store.settings.mailBackupDir;
  const accounts = mailAccountsForUse();

  Object.assign(backup, {
    running: true, stop: false, account: '', mailbox: '',
    done: 0, total: 0, saved: 0, skipped: 0, message: '', at: Date.now()
  });
  evlog.log('메일', `백업 시작 · 계정 ${accounts.length}개 · ${dir}`);

  // 기다리지 않고 바로 상태를 돌려준다 — 몇 시간짜리가 될 수도 있다
  (async () => {
    try {
      // 계정마다 0부터 세므로, 화면에 보이는 숫자는 여기서 합산한다
      let saved = 0;
      let skipped = 0;
      let missing = 0;
      const failed = [];
      for (const acc of accounts) {
        if (backup.stop) break;
        backup.account = acc.name || acc.user;
        // 한 계정이 넘어져도 나머지는 받아야 한다. 여기서 통째로 중단하면
        // 비밀번호가 만료된 계정 하나 때문에 나머지 계정은 영영 백업되지 않는다.
        try {
          const r = await mailbackup.backupAccount(acc, dir, {
            onProgress: (p) => Object.assign(backup, p,
              { saved: saved + p.saved, skipped: skipped + p.skipped }),
            shouldStop: () => backup.stop
          });
          saved += r.saved;
          skipped += r.skipped;
          missing += r.missing;
          if (r.stateError) failed.push(`${backup.account}: 진행 기록 저장 실패 (${r.stateError})`);
        } catch (e) {
          failed.push(`${backup.account}: ${mail.friendly(e)}`);
          evlog.log('메일', `백업 실패 · ${backup.account} · ${mail.friendly(e)}`);
        }
        backup.saved = saved;
        backup.skipped = skipped;
      }
      backup.message = (backup.stop ? `멈췄습니다 — ${saved}통 저장` : `끝났습니다 — ${saved}통 저장`)
        + (missing ? ` · ${missing}통은 서버가 원문을 주지 않았습니다` : '')
        + (failed.length ? ` · 실패 ${failed.length}건: ${failed[0]}` : '');
      evlog.log('메일', `백업 ${backup.stop ? '중단' : '완료'} · ${saved}통`
        + (failed.length ? ` · 실패 ${failed.join(' / ')}` : ''));
    } catch (e) {
      backup.message = mail.friendly(e);
      evlog.log('메일', `백업 실패 · ${backup.message}`);
    } finally {
      backup.running = false;
      backup.mailbox = '';
    }
  })();

  return backupStatus();
});

// ── 메일 한 통 보기 ──────────────────────────────────────
// 본문은 이때만 받는다. 폴링에서 매번 받으면 느리고, 대부분은 열어보지도 않는다.
let mailWin = null;
let mailViewPayload = null;
let mailViewFiles = [];      // 원본 버퍼 — 저장할 때만 쓰고 화면에는 보내지 않는다
let mailViewSize = null;     // 메일 보기 창의 기준 크기 (위젯과 같은 이유로 되읽지 않는다)

/**
 * 이 창은 우리 페이지에서 절대 벗어나지 않는다.
 * preload를 물린 창이 남의 사이트로 이동하면 그 사이트가 우리 IPC를 그대로 쓴다 —
 * 메일 보내기와 파일 첨부가 붙은 지금은 그게 곧 계정 탈취다.
 */
function lockToOurPage(win) {
  const ours = (url) => url.startsWith('file://');
  win.webContents.on('will-navigate', (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

let mailViewSeq = 0;   // 늦게 도착한 예전 요청이 지금 보고 있는 메일을 덮어쓰지 못하게

function openMailView(msg) {
  mailViewPayload = null;
  // 계정이 안 맞으면 그냥 실패시킨다. 예전에는 첫 계정으로 넘어갔는데,
  // 그러면 엉뚱한 계정에서 같은 번호의 메일을 열고 읽음 표시까지 해 버린다.
  const acc = mailAccountsForUse().find((a) => a.id === msg.accountId);
  if (!acc) {
    mailViewPayload = { error: '이 메일의 계정을 찾을 수 없습니다' };
    if (!mailWin || mailWin.isDestroyed()) return false;
  }

  const seq = ++mailViewSeq;
  // 본문을 받아오는 동안 창을 먼저 띄운다 — 클릭했는데 한참 아무 일도 없으면 고장 같다
  if (acc) {
    // 열었다고 바로 읽음으로 바꾸지 않는다. 창의 «안 읽음» 칩을 눌러 사용자가 정한다 —
    // 목록을 훑다가 잘못 연 메일까지 읽음이 되면 다시 찾아내기 어렵다.
    mail.fetchBody(acc, msg.uid, { markSeen: false, allowRemote: store.settings.mailRemoteImages !== false })
      .then((m) => {
        // 원문 버퍼는 화면으로 보내지 않는다 — 백업에만 쓰고 여기서 떼어낸다
        const { source, ...forView } = m;
        autoBackupOne(acc, { ...forView, source });
        if (seq !== mailViewSeq) return;   // 그 사이 다른 메일을 열었다
        mailViewFiles = m.attachments || [];
        // 창에서 읽음 표시를 누르려면 어느 계정의 몇 번 메일인지 알아야 한다
        mailViewPayload = { ...forView, accountId: acc.id,
          attachments: mail.attachmentsForView(mailViewFiles) };
        refreshMail();
      })
      .catch((e) => {
        if (seq !== mailViewSeq) return;
        mailViewPayload = { error: mail.friendly(e) };
      });
  }

  if (mailWin && !mailWin.isDestroyed()) { mailWin.focus(); return true; }
  const saved = store.settings.mailViewSize;
  // 큰 모니터에서 키워 둔 크기를 작은 화면에서 그대로 쓰면 창이 화면 밖으로 나간다
  const cap = mailViewMax();
  mailWin = new BrowserWindow({
    width: Math.round(clamp((saved && saved.width) || 420 + PAD, 320, cap.width)),
    height: Math.round(clamp((saved && saved.height) || 480 + PAD, 260, cap.height)),
    minWidth: 320, minHeight: 260,
    frame: false,
    // 크기 조절은 렌더러의 리사이즈 존이 맡는다 (네이티브는 투명 창에서 폭주한다)
    resizable: false,
    // 메일은 읽는 동안 다른 창을 보기도 한다 — 항상 위에 두지 않고
    // 작업표시줄에도 올려 다시 찾아올 수 있게 한다
    alwaysOnTop: false, skipTaskbar: false,
    title: '메일',
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  mailViewSize = { width: mailWin.getSize()[0], height: mailWin.getSize()[1] };
  // 메일 본문은 남이 쓴 것이다. 그 안의 링크로 이 창이 이동해 버리면 그 사이트가
  // preload 다리(메일 보내기·파일 첨부)를 그대로 쥔다. 창은 우리 페이지에 못박고
  // 바깥 주소는 기본 브라우저로 보낸다.
  lockToOurPage(mailWin);
  mailWin.loadFile(page('mailview.html'), {
    query: glassQuery({ radius: '20',
      remote: store.settings.mailRemoteImages !== false ? '1' : '' })
  });
  mailWin.on('closed', () => { mailWin = null; mailViewPayload = null; mailViewFiles = []; });
  return true;
}

ipcMain.handle('mail:open', (_e, msg) => openMailView(msg));
/** 렌더러가 본문을 달라고 하면, 도착할 때까지 잠깐 기다렸다 준다 */
ipcMain.handle('mail:view-data', async () => {
  for (let i = 0; i < 60 && !mailViewPayload; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return mailViewPayload || { error: '시간이 초과되었습니다' };
});
ipcMain.on('mail:view-close', () => mailWin && !mailWin.isDestroyed() && mailWin.close());

/** 첨부 저장 — 어디에 저장할지는 사용자가 고른다 */
ipcMain.handle('mail:save-attachment', async (_e, index) => {
  const a = mailViewFiles[index];
  if (!a || !a.content) return { ok: false, message: '첨부를 찾을 수 없습니다' };
  const { canceled, filePath } = await dialog.showSaveDialog(mailWin || undefined, {
    defaultPath: a.filename || '첨부파일',
    title: '첨부 저장'
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, a.content);
    return { ok: true, message: '저장했습니다', path: filePath };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

/** 저장한 첨부를 탐색기에서 보여준다 */
ipcMain.on('mail:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });

/** 메일 보기 창 크기 조절 — 위젯과 같은 방식(기준 크기를 못박아 되먹임을 끊는다) */
ipcMain.on('mailview:move', (_e, { x, y }) => {
  if (!mailWin || mailWin.isDestroyed() || !mailViewSize) return;
  // setPosition은 배율이 100%가 아닐 때 호출마다 창을 부풀린다 — 크기를 못박아 옮긴다
  mailWin.setBounds({ x: Math.round(x), y: Math.round(y), ...mailViewSize });
});

ipcMain.handle('mailview:bounds', () => {
  if (!mailWin || mailWin.isDestroyed()) return { x: 0, y: 0, width: 420, height: 480 };
  return mailWin.getBounds();
});
/**
 * 얼마나 크게 늘릴 수 있나. 고정 숫자로 막으면 큰 화면에서 답답하다 —
 * 그 창이 놓인 모니터의 작업 영역만큼 허용한다.
 * 창에는 그림자 여백(PAD)이 붙어 있으므로 그만큼 더해야 보이는 카드가 화면을 꽉 채운다.
 */
function mailViewMax() {
  try {
    const d = mailWin && !mailWin.isDestroyed()
      ? screen.getDisplayMatching(mailWin.getBounds())
      : screen.getPrimaryDisplay();
    return { width: d.workAreaSize.width + PAD, height: d.workAreaSize.height + PAD };
  } catch {
    return { width: 2400, height: 1600 };
  }
}

ipcMain.on('mailview:set-bounds', (_e, { x, y, width, height, dir }) => {
  if (!mailWin || mailWin.isDestroyed()) return;
  const max = mailViewMax();
  const w = Math.round(clamp(width, 320, max.width));
  const h = Math.round(clamp(height, 260, max.height));
  const nx = Math.round(String(dir).includes('w') ? x + (width - w) : x);
  const ny = Math.round(String(dir).includes('n') ? y + (height - h) : y);
  mailViewSize = { width: w, height: h };
  mailWin.setBounds({ x: nx, y: ny, width: w, height: h });
  store.setSettings({ mailViewSize });   // 다음에 열 때 이 크기로
});

/** 우리가 넣어둔 안내 링크만 연다 — 렌더러가 임의 주소를 열지 못하게 http(s)로 제한 */
ipcMain.handle('app:open-url', (_e, url) => {
  const s = String(url || '');
  if (!/^https:\/\//i.test(s)) return false;
  shell.openExternal(s);
  return true;
});

/** 주소를 찾아야 하는 설정 페이지를 대신 열어준다 */
ipcMain.handle('cal:open-help', (_e, which) => {
  const urls = {
    google: 'https://calendar.google.com/calendar/r/settings',
    // Notion 캘린더 앱(옛 Cron)은 일정을 자기가 갖고 있지 않고 Google·iCloud를 비춰 보여줄 뿐이라
    // 거기서는 구독 주소가 나오지 않는다. 주소가 나오는 건 Notion 데이터베이스의 캘린더 뷰다.
    notion: 'https://www.notion.so',
    outlook: 'https://outlook.live.com/calendar/0/options/calendar/SharedCalendars'
  };
  const target = urls[which];
  if (target) shell.openExternal(target);
  return !!target;
});

/** 내 PC에 있는 .ics 파일을 캘린더로 쓴다 (인터넷·계정 연동 없이) */
ipcMain.handle('cal:pick-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '캘린더 파일 고르기',
    filters: [{ name: '캘린더', extensions: ['ics', 'ical', 'ifb'] }],
    properties: ['openFile']
  });
  return canceled ? null : filePaths[0];
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
  // «지금부터»의 기준점을 바로 찍는다. 다음 폴링까지 기다리면 그 사이에 온 메일이
  // 지난 메일로 분류되어 자동 백업 대상에서 빠진다.
  if (patch.mailAutoBackup === true) autoBackupNew({ now: true });
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

    // 네트워크보다 먼저 — 오프라인이어도 달력과 "빈 시간 배치"가 바로 동작한다
    primeCalendarsFromCache();

    scheduler.reset();
    const resumed = restoreSession();
    if (resumed) console.log(`[session] 이전 상태 이어가기 (알림 ${resumed.restored}개)`);

    updateTray();
    createWidget();
    if (resumed && resumed.widgetHidden) widgetWin.hide();
    setInterval(tick, 1000);
    // 메일 — 타이머는 항상 돌고, 켜져 있는지·주기가 됐는지는 안에서 판단한다.
    // 시작할 때만 거는 방식이면 나중에 메일을 켜도 재시작 전까지 확인하지 않는다.
    if (store.settings.mailEnabled) refreshMail();
    setInterval(() => {
      if (!store.settings.mailEnabled) return;
      const every = Math.max(2, store.settings.mailPollMin || 10) * 60_000;
      if (Date.now() - mailState.fetchedAt >= every) refreshMail();
    }, 30_000);
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

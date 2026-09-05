// 캘린더 — 일정 받아오기·캐시·창에 답하기.
//
// main.js 안에 네 덩이로 흩어져 있던 것을 모았다 (캐시와 새로고침이 앞쪽,
// 위젯 달력 패널과 월 보기가 가운데, 상태와 IPC 가 뒤쪽에 있었다).
//
// 여기 있는 것:
//   · 구독 주소·로컬 .ics 를 15분마다 받아 두는 캐시(cal)
//   · 일정이 곧 시작할 때 위젯을 슬쩍 알리는 nudge
//   · 설정·위젯이 물어보는 IPC (넣기·지우기·시험·월 보기·새 일정)
//
// 위젯 창은 main.js 가 들고 있다 — 다시 만들어질 수 있으므로 값이 아니라
// «지금 것을 가져오는 법»으로 받는다.

const { app, ipcMain, dialog, clipboard, shell } = require('electron');

const store = require('./store');
const calendar = require('./calendar');
const calcache = require('./calcache');

let host = {
  widgetWin: () => null,
  revealWidget: () => {}
};
function init(h) { host = { ...host, ...h }; }

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
  // 종일·한가함도 그대로 들고 온다. 무엇을 «바쁨»으로 칠지는 planner가 정하고,
  // 달력 화면은 이 목록을 그대로 보여준다.
  cal.occurrences = calendar.expandRange(
    cached.sources, now - 2 * 86400000, now + 2 * 86400000
  );
  console.log(`[calendar] 저장해둔 일정 ${cal.occurrences.length}건으로 시작합니다`);
}

async function refreshCalendars() {
  const list = store.calendars;
  if (!list.length) { cal.occurrences = []; cal.errors = []; return; }
  if (cal.loading) return;
  cal.loading = true;
  try {
    const r = await calendar.loadOccurrences(list);
    // 한 곳도 못 받아왔는데 전에 받아둔 것이 있으면 그것을 지킨다.
    //
    // loadOccurrences는 그물망이 끊겨도 던지지 않는다 — 실패를 errors에 담아 돌려준다.
    // 그래서 아래 catch가 안 걸리고, 빈 목록이 그대로 덮어써졌다. 캐시는 «켤 때»만
    // 쓰이므로, 오프라인에서는 처음엔 보이다가 다음 폴링에 달력이 텅 비었다.
    if (!r.sources.length && cal.sources.length) {
      cal.errors = r.errors;
      cal.stale = true;           // 지금 보이는 것은 마지막으로 받아둔 것이다
      console.warn('[calendar] 못 받아왔습니다 — 저장해둔 일정을 그대로 씁니다');
      return;
    }
    cal.occurrences = r.occurrences;
    cal.errors = r.errors;
    cal.sources = r.sources;      // 달력에서 다른 달을 펼칠 때 쓴다
    cal.fetchedAt = r.fetchedAt;
    cal.stale = false;
    calcache.save(app.getPath('userData'), r.sources, r.fetchedAt);
    if (host.widgetWin() && !host.widgetWin().isDestroyed()) host.widgetWin().webContents.send('cal:changed');
    if (r.errors.length) console.warn('[calendar] 일부 실패:', r.errors.map((e) => e.message).join(', '));
  } catch (e) {
    console.warn('[calendar] refresh failed:', e.message,
      cal.sources.length ? '— 저장해둔 일정으로 계속합니다' : '');
  } finally {
    cal.loading = false;
  }
}


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
  host.revealWidget();
  if (host.widgetWin() && !host.widgetWin().isDestroyed()) host.widgetWin().webContents.send('cal:show');
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

function calendarStatus() {
  const now = Date.now();
  const cur = calendar.currentEvent(cal.occurrences, now);
  const next = calendar.nextEvent(cal.occurrences, now);
  return {
    count: cal.occurrences.length,
    fetchedAt: cal.fetchedAt,
    // 지금 보이는 것이 «마지막으로 받아둔 것»인지. 인터넷이 끊겨도 달력은 그대로
    // 보이므로, 그것이 최신인지 아닌지는 말해줘야 한다.
    stale: !!cal.stale,
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
    const occ = calendar.occurrencesIn(text, now - 7 * 86400000, now + 30 * 86400000);
    return { ok: true, message: `연결됨 · 앞으로 30일 일정 ${occ.length}건` };
  } catch (e) {
    return { ok: false, message: String(e.message || e).slice(0, 120) };
  }
});

module.exports = {
  init,
  // 바깥이 부르는 것들
  refreshCalendars, calendarStatus, nudgeCalendar, showCalendarPanel, scheduleCalendarCatchUp,
  primeCalendarsFromCache, CAL_REFRESH_MS,
  // 일정 캐시는 같은 객체를 나눠 쓴다 (틱이 이걸 그대로 본다)
  cal
};

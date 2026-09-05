const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, nativeImage, shell
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

// 창을 만들 때 쓰는 것들은 win.js 로 옮겼다.
// 이름을 풀어서 받는다 — 창을 만드는 함수마다 «win»이라는 지역 변수를 이미 쓰고 있어서
// 모듈을 그 이름으로 두면 가려진다.
const { PRELOAD, page, PAD, PAD_H, clamp, glassQuery, openWeb, lockToOurPage } = require('./win');

// 물어보는 창·오른쪽 클릭 메뉴는 popup.js 가 그린다 (윈도우 기본 대화상자를 안 쓴다)
const { askUser } = require('./popup');
// 주식 시세 창 — 여는 것은 그쪽이 IPC로 직접 받는다. 여기서는 «끌 때 닫기»만 쓴다.
const { closeStocks } = require('./stockwin');

// 메일 쓰기 창 — 여는 두 갈래만 여기서 쓴다 (나머지는 그쪽이 IPC로 직접 받는다).
// 그쪽이 우리 것을 몇 개 필요로 해서, 순환 require 대신 시작할 때 건네준다.
const composewin = require('./composewin');

// 메일 백업 — «한 통 저장»과 «새로 온 것 저장»만 여기서 부른다
// 주소록 — 여기서 부를 일이 없다 (그쪽이 IPC로 직접 받는다).
// 파일 고르기 창을 설정 창 위에 띄우려고 그것만 건네준다.
const contacts = require('./contacts');

// 메일 보기 창 — «어느 창에서 온 요청인가»와 «휴지통으로»만 여기서 쓴다
// 본문 미리 받기·거르기 규칙 — 목록(mailhub.mailState)을 그대로 넘겨준다 (복사하면 갱신을 못 본다)
const mailbody = require('./mailbody');
const { localOrServer } = mailbody;
const mailfilter = require('./mailfilter');

// 기록 창 — 여는 것과 «기록이 바뀌었다» 알림만 여기서 쓴다
const statswin = require('./statswin');

// 메일 — 이 앱에서 가장 큰 계통. 받아오기·규칙·알림·창에 답하기가 그쪽에 있다.
// 위젯 창·설정 창·공유 상태·방해 금지 판정은 여기가 들고 있으므로 app-ready 때 건네준다.
const mailhub = require('./mailhub');

// 휴식 창 — 이 앱의 본체. 창 만들기·미리 찍기·미리 세우기·등장 연출이 그쪽에 있다.
// 스케줄러·트레이·공유 상태는 여기가 들고 있으므로 app-ready 때 init() 로 건네준다.
const breakwin = require('./breakwin');

// 캘린더 — 일정 캐시·새로고침·창에 답하기가 그쪽에 있다
const calhub = require('./calhub');
const { openStats } = statswin;

const mailwin = require('./mailwin');
const { slotOf, doTrash } = mailwin;

const backup = require('./backup');
const { autoBackupNew } = backup;
backup.init({ mailAccountsForUse: () => mailhub.mailAccountsForUse() });
// 화살표로 감싸 둔다 — 여기서 바로 값을 넘기면 아직 선언되지 않은 것이 섞인다.
composewin.init({
  mailAccountsForUse: () => mailhub.mailAccountsForUse(),
  refreshMail: (o) => mailhub.refreshMail(o),
  slotOf: (e) => slotOf(e),
  doTrash: (msg, parent) => doTrash(msg, parent)
});
const reminders = require('./reminders');
const dnd = require('./dnd');
const updater = require('./updater');
const session = require('./session');
const autolaunch = require('./autolaunch');
const evlog = require('./evlog');
const planner = require('./planner');

// 마지막 안전망.
// 네트워크 라이브러리는 소켓이 끊기면 우리가 await하던 자리가 아니라 아무도 없는 곳에서
// 오류를 던진다. Electron은 그걸 잡아 «A JavaScript error occurred» 창을 띄우고 앱이 죽는다.
// 휴식 알림 위젯이 메일 서버가 느리다는 이유로 죽으면 안 된다 — 기록만 남기고 살아 있는다.
process.on('uncaughtException', (e) => {
  const msg = (e && e.stack) || String(e);
  console.error('[uncaught]', msg);
  try { evlog.log('오류', `처리되지 않은 예외 · ${(e && e.message) || e}`); } catch { /* 기록도 못 하면 어쩔 수 없다 */ }
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', (e && e.stack) || String(e));
  try { evlog.log('오류', `처리되지 않은 거절 · ${(e && e.message) || e}`); } catch { /* 위와 같다 */ }
});

const ICON = path.join(__dirname, '..', 'assets', 'tray.png');
// 카드 기준 176x84 ~ 640x520. 상한이 낮으면 크게 쓰던 사람이 리사이즈에서 벽에 막힌다.
const WIDGET_MIN = { width: 176 + PAD, height: 84 + PAD_H };
// 세로 상한은 화면에 맞춰 잡는다 — widgetMax() 참고. 여기 값은 그 아래 한계다.
const WIDGET_MAX = { width: 640 + PAD, height: 520 + PAD_H };
const WIDGET_DEFAULT = { width: 244 + PAD, height: 110 + PAD_H };

let tray = null;
let widgetWin = null;
let widgetSize = null;   // 우리가 정한 위젯 크기 (실제 크기를 되읽지 않기 위한 기준)
let settingsWin = null;


/** 렌더러에 넘기는 공통 쿼리 */

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
    const p = planner.check(calhub.cal.occurrences, now, s.calendarLead ? needMs : 0, {
      leadMs: (s.calendarLeadMin || 0) * 60_000,
      joinMs: (s.calendarJoinMin || 0) * 60_000,
      allDayBusy: s.calendarAllDay
    });
    if (p) reason = p.label;
    calhub.cal.hold = p;
  }

  dndCache = { at: now, needMs, reason };
  return reason;
}

/**
 * 위젯이 커질 수 있는 한계.
 *
 * 세로는 화면에 맞춰 늘린다. 예전엔 520px로 박아 두었는데, 작업 영역이 1392px인
 * 화면에서도 520이라 타이머·메일·달력을 다 켜면 달력 아래가 잘렸다.
 * 화면이 크면 그만큼 크게 쓸 수 있어야 한다.
 *
 * 위젯이 놓인 화면을 기준으로 본다 — 노트북 화면과 외부 모니터는 크기가 다르고,
 * 위젯은 그 사이를 옮겨 다닌다.
 */
function widgetMax() {
  let d = null;
  try {
    d = widgetWin && !widgetWin.isDestroyed()
      ? screen.getDisplayMatching(widgetWin.getBounds())
      : screen.getPrimaryDisplay();
  } catch {
    d = screen.getPrimaryDisplay();
  }
  const wa = d.workAreaSize;
  return {
    width: Math.max(WIDGET_MIN.width, Math.min(WIDGET_MAX.width, wa.width - 40)),
    // 화면을 다 덮는 것은 위젯이 아니다. 작업 영역의 85%까지, 그리고 예전 상한보다
    // 작아지지는 않게 (작은 화면에서 오히려 줄어들면 쓰던 사람이 손해다).
    height: Math.max(WIDGET_MAX.height, Math.min(Math.round(wa.height * 0.85), wa.height - 40))
  };
}

// ── 위젯 ──────────────────────────────────────────────────
function createWidget() {
  const { width: MAXW, height: MAXH } = widgetMax();
  const pos = store.widgetPos;
  const size = store.widgetSize || WIDGET_DEFAULT;
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  // 우리가 정한 창 크기. 창을 옮길 때마다 이 값을 같이 못박는다.
  // 실제 크기(getSize)를 되읽어 쓰면 안 된다 — 배율이 100%가 아닐 때
  // 창을 옮길 때마다 실제 크기가 1px씩 부풀어, 그 값을 다시 쓰면 끝없이 자란다.
  widgetSize = {
    width: Math.round(clamp(size.width, WIDGET_MIN.width, MAXW)),
    height: Math.round(clamp(size.height, WIDGET_MIN.height, MAXH))
  };

  widgetWin = new BrowserWindow({
    width: clamp(size.width, WIDGET_MIN.width, MAXW),
    height: clamp(size.height, WIDGET_MIN.height, MAXH),
    x: pos ? pos.x : sw - size.width - 20,
    y: pos ? pos.y : 20,
    minWidth: WIDGET_MIN.width,
    minHeight: WIDGET_MIN.height,
    maxWidth: MAXW,
    maxHeight: MAXH,
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

  // 우리 페이지 밖으로 못 나가게 (남의 주소로 가면 이 창이 다리를 쥔 브라우저가 된다)
  lockToOurPage(widgetWin);
  widgetWin.loadFile(page('widget.html'), {
    query: glassQuery({
      radius: String(store.settings.radius),
      calpanel: store.settings.calendarPanel ? '1' : '',
      calmode: store.settings.calendarMode || 'month',
      mailpanel: store.settings.mailPanel ? '1' : '',
      innerh: store.settings.panelInnerH ? String(store.settings.panelInnerH) : '',
      mailh: store.settings.panelMailH ? String(store.settings.panelMailH) : ''
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
    const { height: MAXH } = widgetMax();

    const [width, height] = widgetWin.getSize();
    const w = Math.round(clamp(width, WIDGET_MIN.width, MAXW));
    const h = Math.round(clamp(height, WIDGET_MIN.height, MAXH));
    evlog.log('창', `resized(끝) ${width}x${height}`
      + (w !== width || h !== height ? ` → 범위로 되돌림 ${w}x${h}` : ''));
    if (w !== width || h !== height) widgetWin.setSize(w, h);
  });
  widgetWin.on('closed', () => { widgetWin = null; });
}


// ── 틱 ────────────────────────────────────────────────────
function tick() {
  const now = Date.now();

  if (state.onBreak) {
    if (now >= state.breakEndsAt) breakwin.endBreak('done');
    return;
  }
  // 일시정지는 «시계를 멈추는 것»이다. 예전에는 알림만 안 띄우고 시계는 계속 갔다 —
  // 그래서 30분 멈춰뒀다 풀면 밀린 것들이 한꺼번에 쏟아졌다. 멈춘 동안 쉬지 않았으니
  // 남은 시간도 줄면 안 된다. 자리 비움과 같은 방식으로 다음 시각을 같이 밀어준다.
  if (state.paused) { scheduler.postponeAll(1000); breakwin.dropWarm(); pushTick(); return; }

  // 멈춰 있거나 자리를 비운 사이에 지나가 버린 «정해진 시각»을 먼저 정리한다.
  // 이걸 due()보다 먼저 해야, 풀자마자 세 시간 전 알림이 튀어나오지 않는다.
  scheduler.catchUp(now);

  if (powerMonitor.getSystemIdleTime() >= store.settings.idlePauseSec) {
    scheduler.postponeAll(1000); // 자리 비움 동안 정지
    state.hold = null;
    state.dnd = null;
    breakwin.dropWarm();         // 자리에 없으면 곧 안 띄운다
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
        breakwin.dropWarm();     // 언제 풀릴지 모르는 채로 들고 있지 않는다
      } else {
        state.hold = null;
        breakwin.startBreak(due);
        return;
      }
    } else {
      state.hold = null;
      // 곧 올 휴식을 미리 준비해 둔다 — 배경 사진(1분 전)과 창(20초 전).
      // 여기서 하면 아무도 안 기다린다. 띄우는 순간에 하면 그 시간이 그대로
      // «늦게 뜬 알림»이 된다.
      breakwin.prepareShots(now);
      breakwin.tendWarm(now);
    }
  }
  mailhub.announceMail();
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
  const schedule = store.settings.calendarShow ? planner.today(calhub.cal.occurrences) : [];
  // 알림 한 줄은 잠깐만 살아 있는다 (기다리는 중이면 끝날 때까지)
  const nt = mailhub.mailState.notice;
  const fresh = nt && (nt.kind === 'wait' || Date.now() - nt.at < 8000) ? nt : null;
  // 주식은 켜져 있을 때만 위젯에 단추를 낸다 (값은 창에서만 본다)
  const stocksOn = !!store.settings.stocksEnabled;

  const mailBox = (store.settings.mailEnabled && store.settings.mailShow)
    ? {
      unread: mailhub.mailState.unread,
      messages: mailhub.mailState.messages,
      notice: fresh,
      // 폴더 — 메일 / 규칙이 묶은 것들 / 숨김 / 보낸메일함.
      // 위젯이 한 번에 한 칸만 보여준다.
      // 받은편지함을 아직 한 번도 못 읽었으면 보낸메일함 탭도 내보내지 않는다 —
      // 그것 하나만 남으면 화면이 «보낸메일함»에서 시작하고 돌아갈 곳이 없다.
      folders: mailhub.mailState.folders.length
        ? [...mailhub.mailState.folders, ...mailhub.draftFolders(), ...mailhub.sentFolders()]
        : [],
      // 계정을 먼저 고르고 그 안에서 폴더를 고른다. 안 나눌 때는 빈 배열이라
      // 화면이 계정 줄을 아예 안 그린다.
      accounts: mailhub.mailState.accountTabs || [],
      filtered: mailhub.mailState.filtered
    }
    : null;
  logMailPayload(mailBox);

  if (!next) {
    payload = { empty: true, paused: state.paused, today: store.todayStats(), schedule, mail: mailBox, stocksOn };
  } else {
    const cfg = scheduler.cfgOf(next.id);
    // 고리가 얼마나 찼는지는 «한 바퀴»가 얼마인지 알아야 그린다.
    // 주기 알림이면 그 주기, 정해진 시각이면 이번 차례에서 다음 차례까지.
    const totalSec = Math.max(1, Math.round(scheduler.periodMsOf(next.id, next.at) / 1000));
    const remaining = Math.max(0, Math.round((next.at - Date.now()) / 1000));
    payload = {
      empty: false,
      type: reminders.meta(next.id, custom),
      remaining,
      total: totalSec,
      // 정해진 시각 알림은 «20시간 남음»보다 «09:00»이 쓸모 있다 — 알람 시계처럼.
      // 가까워지면 화면 쪽에서 알아서 카운트다운으로 바꿔 보여준다.
      fixedAt: reminders.isFixed(cfg) ? hhmm(next.at) : null,
      paused: state.paused,
      onBreak: state.onBreak,
      idle: powerMonitor.getSystemIdleTime() >= store.settings.idlePauseSec,
      hold: state.hold,
      dnd: state.dnd,
      today: store.todayStats(),
      schedule,
      mail: mailBox,
      stocksOn,
      // 일정 때문에 미루는 중이면 언제 이어지는지 알려준다
      holdUntil: state.hold && calhub.cal.hold ? calhub.cal.hold.until : null,
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
/** epoch → '09:00' (로컬 시각) */
function hhmm(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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

/**
 * 트레이 풍선말의 «언제».
 * 정해진 시각 알림은 «21:20에»라고 시각으로 말한다 — «약 300분 후»는 세어봐야 안다.
 */
function tipWhen(next) {
  if (reminders.isFixed(scheduler.cfgOf(next.id))) return `${hhmm(next.at)}에`;
  const mins = Math.max(0, Math.ceil((next.at - Date.now()) / 60_000));
  if (mins < 60) return `약 ${mins}분 후`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `약 ${h}시간 ${m}분 후` : `약 ${h}시간 후`;
}

// ── 트레이 ────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  const next = scheduler.soonest();
  const custom = store.custom;
  const up = updater.getState();
  tray.setToolTip(
    state.paused ? 'Hibi — 일시정지됨'
      : state.hold ? `Hibi — 방해 금지 (${state.hold}) · 알림 대기 중`
        : state.dnd ? `Hibi — 방해 금지 (${state.dnd})`
          : next ? `Hibi — ${reminders.meta(next.id, custom).name} ${tipWhen(next)}`
            : 'Hibi — 켜진 알림 없음'
  );

  const nowSub = scheduler.activeIds().map((id) => ({
    label: reminders.meta(id, custom).name,
    click: () => breakwin.startBreak([id])
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
    { label: '달력 보기', click: () => calhub.showCalendarPanel() },
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
  for (const w of [widgetWin, statswin.win(), settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('debug:mode', on);
  }
  updateTray();
}

function openEventLog() {
  if (!evlog.file || !fs.existsSync(evlog.file)) {
    // 트레이에서 부르므로 부모 창이 없다 — 위젯이 있으면 그 위에, 없으면 화면 한가운데
    askUser(widgetWin && !widgetWin.isDestroyed() ? widgetWin : null, {
      buttons: ['확인'],
      title: '이벤트 기록',
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
const SETTINGS_TABS = ['rem', 'cal', 'mail', 'app'];

/** @param tab 열자마자 보여줄 탭 ('mail' 등). 없으면 마지막 기본값. */
function openSettings(tab) {
  const want = SETTINGS_TABS.includes(tab) ? tab : null;
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (want) settingsWin.webContents.send('settings:tab', want);
    settingsWin.focus();
    return;
  }
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
  // 우리 페이지 밖으로 못 나가게 (남의 주소로 가면 이 창이 다리를 쥔 브라우저가 된다)
  lockToOurPage(settingsWin);
  settingsWin.loadFile(page('settings.html'), {
    query: glassQuery(want ? { radius: '20', tab: want } : { radius: '20' })
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}
let widgetBaseHeight = null;
const panelHeights = { cal: 0, mail: 0, fix: 0, calNeeded: -1 };   // 패널이 둘이라 각자 얼마나 쓰는지 따로 센다
ipcMain.on('cal:panel', (_e, { on, needed, short, which, pinned }) => {
  if (!widgetWin || widgetWin.isDestroyed() || !widgetSize) return;
  const { height: MAXH } = widgetMax();

  panelHeights[which === 'mail' ? 'mail' : 'cal'] = on ? (needed || 0) : 0;
  // 사람이 칸 사이를 끌어 높이를 정해 두었으면 창 높이는 건드리지 않는다.
  // 달력을 다시 그릴 때마다 «내용에 맞춘 높이»로 되돌리면, 방금 넓혀 둔 메일 칸이
  // 도로 좁아진다. 창 크기는 그때부터 가장자리를 끌어 정한다.
  if (pinned) return;

  // 그려본 뒤 «모자란 만큼»을 채운다. 합만으로는 몇 px씩 어긋나 달력 아래가 잘렸다.
  // 달력 내용이 달라지면(달을 넘기거나 주↔월) 다시 재야 하므로 보정값을 버린다.
  if (which !== 'mail') {
    if (needed !== panelHeights.calNeeded) { panelHeights.calNeeded = needed; panelHeights.fix = 0; }
    if (short > 0) panelHeights.fix += short;
  }
  const extra = panelHeights.cal + panelHeights.mail + (panelHeights.cal ? panelHeights.fix : 0);
  if (extra > 0) {
    if (widgetBaseHeight == null) widgetBaseHeight = widgetSize.height;
    const h = Math.round(clamp(widgetBaseHeight + extra + 8,
      WIDGET_MIN.height, MAXH));
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
// ── IPC ──────────────────────────────────────────────────
/** 화면 쪽이 바깥 주소를 열 때 — https 만 연다 */
/** 화면 쪽이 바깥 주소를 열 때 — http/https 만 (win.openWeb 이 판단한다) */
ipcMain.handle('app:open-url', (_e, url) => openWeb(url));

ipcMain.on('widget:toggle-pause', togglePause);
ipcMain.on('widget:open-settings', (_e, tab) => openSettings(tab));
ipcMain.on('widget:hide', () => widgetWin && widgetWin.hide());

ipcMain.on('widget:resize', (_e, { width, height }) => {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const { width: MAXW, height: MAXH } = widgetMax();

  widgetWin.setSize(
    Math.round(clamp(width, WIDGET_MIN.width, MAXW)),
    Math.round(clamp(height, WIDGET_MIN.height, MAXH))
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
  const { width: MAXW, height: MAXH } = widgetMax();

  const w = Math.round(clamp(width, WIDGET_MIN.width, MAXW));
  const h = Math.round(clamp(height, WIDGET_MIN.height, MAXH));
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
  enterCustom: breakwin.enterList(),
  calendarStatus: calhub.calendarStatus(),
  dndPresets: dnd.PRESETS,
  update: updater.getState(),
  types: reminders.TYPES.map((t) => ({
    id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind, headline: t.headline
  }))
}));


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
  // 주식을 끄면 열려 있던 창도 닫는다 — 끈 기능의 창이 남아 있으면 이상하다
  if (patch && patch.stocksEnabled === false) closeStocks();
  if (patch.autoUpdate != null) updater.startAuto(patch.autoUpdate);
  if (patch.calendarAllDay != null) calhub.refreshCalendars();
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
  // 언제 울릴지를 건드렸으면 다시 예약한다. 주기만 보고 있어서
  // 시각·요일을 바꿔도 예전 예약이 그대로 남아 있었다.
  if (patch && ['intervalMin', 'when', 'times', 'days'].some((k) => patch[k] != null)) {
    scheduler.schedule(id);
  }
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
    calhub.primeCalendarsFromCache();

    scheduler.reset();
    const resumed = restoreSession();
    if (resumed) console.log(`[session] 이전 상태 이어가기 (알림 ${resumed.restored}개)`);

    updateTray();
    breakwin.watchDisplays();
    // 주소록의 파일 고르기 창을 설정 창 위에 띄우기 위해 (여기서 해야 settingsWin이 선언된 뒤다)
    contacts.init({ parentWin: () => settingsWin });
    // 휴식 창에 «우리가 들고 있는 것»을 건네준다. state 는 같은 객체를 나눠 쓰므로
    // 그쪽에서 onBreak 를 켜면 여기 tick() 도 바로 본다.
    breakwin.init({ state, scheduler, updateTray, pushTick });
    // 메일에 «우리가 들고 있는 것»을 건네준다. widgetWin 은 다시 만들어질 수 있어
    // 값이 아니라 «지금 것을 가져오는 법»으로 넘긴다.
    calhub.init({ widgetWin: () => widgetWin, revealWidget: () => revealWidget() });
    mailhub.init({
      state,
      widgetWin: () => widgetWin,
      openSettings: (tab) => openSettings(tab),
      revealWidget: () => revealWidget(),
      holdReason: (ms) => holdReason(ms)
    });
    statswin.init({ scheduler, startBreak: (ids) => breakwin.startBreak(ids) });
    mailbody.init({ mailAccountsForUse: () => mailhub.mailAccountsForUse(), mailState: mailhub.mailState });
    mailfilter.init({
      mailState: mailhub.mailState,
      refreshMail: (o) => mailhub.refreshMail(o),
      forgetRuleWork: () => mailhub.forgetRuleWork()
    });
    mailwin.init({
      mailAccountsForUse: () => mailhub.mailAccountsForUse(),
      refreshMail: (o) => mailhub.refreshMail(o),
      localOrServer: (acc, msg) => localOrServer(acc, msg),
      notice: (k, t) => mailhub.notice(k, t),
      seenMarks: mailhub.seenMarks
    });
    createWidget();
    if (resumed && resumed.widgetHidden) widgetWin.hide();
    setInterval(tick, 1000);
    // 메일 — 타이머는 항상 돌고, 켜져 있는지·주기가 됐는지는 안에서 판단한다.
    // 시작할 때만 거는 방식이면 나중에 메일을 켜도 재시작 전까지 확인하지 않는다.
    if (store.settings.mailEnabled) mailhub.refreshMail();
    setInterval(() => {
      if (!store.settings.mailEnabled) return;
      const every = Math.max(2, store.settings.mailPollMin || 10) * 60_000;
      if (Date.now() - mailhub.mailState.fetchedAt >= every) mailhub.refreshMail();
    }, 30_000);
    setInterval(updateTray, 30_000);

    calhub.refreshCalendars();
    setInterval(() => calhub.refreshCalendars(), calhub.CAL_REFRESH_MS);

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
    if (dev.includes('break')) setTimeout(() => breakwin.startBreak(scheduler.activeIds()), 1800);
    if (dev.includes('stats')) setTimeout(() => openStats(null), 1200);
  });

  app.on('window-all-closed', () => { /* 트레이 상주 */ });
}

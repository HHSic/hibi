const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, nativeImage, desktopCapturer, shell, dialog, clipboard, Notification
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
const { PRELOAD, page, PAD, PAD_H, clamp, glassQuery } = require('./win');

// 물어보는 창·오른쪽 클릭 메뉴는 popup.js 가 그린다 (윈도우 기본 대화상자를 안 쓴다)
const { askUser, pickFromMenu } = require('./popup');
// 주식 시세 창 — 여는 것은 그쪽이 IPC로 직접 받는다. 여기서는 «끌 때 닫기»만 쓴다.
const { closeStocks } = require('./stockwin');

// 메일 쓰기 창 — 여는 두 갈래만 여기서 쓴다 (나머지는 그쪽이 IPC로 직접 받는다).
// 그쪽이 우리 것을 몇 개 필요로 해서, 순환 require 대신 시작할 때 건네준다.
const composewin = require('./composewin');
const { startCompose, startCopy } = composewin;

// 메일 백업 — «한 통 저장»과 «새로 온 것 저장»만 여기서 부른다
// 주소록 — 여기서 부를 일이 없다 (그쪽이 IPC로 직접 받는다).
// 파일 고르기 창을 설정 창 위에 띄우려고 그것만 건네준다.
const contacts = require('./contacts');

// 메일 보기 창 — «어느 창에서 온 요청인가»와 «휴지통으로»만 여기서 쓴다
// 본문 미리 받기·거르기 규칙 — 목록(mailState)을 그대로 넘겨준다 (복사하면 갱신을 못 본다)
const mailbody = require('./mailbody');
const { localOrServer, prefetchBodies, knownMessages } = mailbody;
const mailfilter = require('./mailfilter');
const { okToSpam } = mailfilter;

// 기록 창 — 여는 것과 «기록이 바뀌었다» 알림만 여기서 쓴다
const statswin = require('./statswin');
const { openStats } = statswin;

const mailwin = require('./mailwin');
const { slotOf, doTrash } = mailwin;

const backup = require('./backup');
const { autoBackupNew } = backup;
backup.init({ mailAccountsForUse: () => mailAccountsForUse() });
// 화살표로 감싸 둔다 — 여기서 바로 값을 넘기면 아직 선언되지 않은 것이 섞인다.
composewin.init({
  mailAccountsForUse: () => mailAccountsForUse(),
  refreshMail: (o) => refreshMail(o),
  slotOf: (e) => slotOf(e),
  doTrash: (msg, parent) => doTrash(msg, parent)
});
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
const mailrules = require('./mailrules');
const mailtally = require('./mailtally');
const mailmark = require('./mailmark');
const secret = require('./secret');

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
const WIDGET_MAX = { width: 640 + PAD, height: 520 + PAD_H };
const WIDGET_DEFAULT = { width: 244 + PAD, height: 110 + PAD_H };
const SNOOZE_MS = 5 * 60_000;

let tray = null;
let widgetWin = null;
let widgetSize = null;   // 우리가 정한 위젯 크기 (실제 크기를 되읽지 않기 위한 기준)
let settingsWin = null;
let overlayWins = [];
let overlayShots = new Map();


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
  pending: 0,           // 알리지 않고 쌓아둔 새 메일 수
  quiet: 0,             // 규칙이 걸러낸(숨김·스팸·알림 안 함) 안 읽은 메일 수
  total: 0,             // 서버 메일함의 전체 통수 («더 보기»가 끝을 안다)
  // «새 메일 n통»은 통수 뺄셈으로 세면 안 된다. 규칙을 껐다 켜기만 해도 숫자가 움직여서
  // 오지도 않은 메일이 왔다고 뜬다. 지난번에 무엇을 봤는지를 들고 있다가 진짜 새로 나타난
  // 것만 센다. 비어 있으면 «아직 한 번도 안 봤다»는 뜻이라 그 판은 세지 않는다 —
  // 앱을 켤 때마다 쌓여 있던 메일이 전부 «새 메일»이 되면 안 된다.
  known: null,          // Set<'계정:uid'> — 지난 폴링에서 본 것들
  filtered: 0,          // 이번에 화면에서 걷어낸 통수 (설정 화면에 보여준다)
  groups: [],           // 묶인 것들 [{ name, items }]
  folders: [],          // 화면에 보일 폴더 [{ id, acct, name, items, count, unread }]
  accountTabs: [],      // 계정별로 나눠 볼 때의 계정 줄 [{ id, name }] — 안 나누면 빈 배열
  toRead: [],           // 규칙이 «자동 읽음»으로 지목한 것
  toSpam: [],           // 규칙이 «스팸으로»로 지목한 것
  // 보낸메일함은 폴링 때 같이 가져오지 않는다. 이 서버는 받은편지함 한 번 읽는 데도
  // 오래 걸려서, 매번 폴더를 하나 더 열면 그만큼 늘어난다. 탭을 눌렀을 때만 가져온다.
  // total — 서버의 보낸메일함에 실제로 몇 통 있나. «마지막입니다»를 말하려면 이게 있어야 한다.
  sent: { at: 0, loading: false, messages: [], error: '', total: 0 }
};

// 자동 처리는 한 번씩만 — 서버가 느려 몇십 초씩 걸리는데,
// 폴링마다 같은 메일에 또 명령을 보내면 그동안 다른 일이 전부 막힌다.
// 실패한 것은 «했다»가 아니다. 이 서버는 읽음 두 통에 88초가 걸린 적이 있고
// 쓰기 제한이 90초라, 한 번 걸러 넘어가면 그 메일은 영영 처리되지 않는다.
// 스팸은 더 나쁘다 — 화면에서는 이미 숨겨져 «옮겨진 것»처럼 보이는데 서버에는 그대로 남는다.
// 셈은 mailtally가 한다 (거기서만 시험할 수 있다).
// 읽음 상태 임시 장부 — 서버가 대답하기 전에도 화면이 맞게 보이게 한다.
// 이 서버는 읽음 표시 두 통에 88초가 걸린 적이 있고, 그동안 목록이 옷 값을
// 들고 있으면 «눌렀는데 안 되네»가 된다. 서버가 따라오면 장부는 스스로 지워진다.
const seenMarks = new mailmark.SeenMarks({ ttlMs: 10 * 60_000, max: 500 });

const RULE_RETRY_MS = 5 * 60_000;
const ruleLog = new mailtally.WorkLog({ tries: 3, retryMs: RULE_RETRY_MS });
let ruleBusy = false;

/** 저장된 계정을 실제 접속용으로 — 비밀번호를 여기서만 푼다 */
function mailAccountsForUse() {
  return store.mailAccounts
    .filter((a) => a.enabled !== false && a.host && a.user)
    .map((a) => ({ ...a, pass: secret.open(a.sealed) }))
    .filter((a) => a.pass);
}

// ── 더 보기 ────────────────────────────
// 목록은 설정한 만큼만 받는다. 그 끝까지 내려가면 예전 것도 볼 수 있어야 한다.
//
// 늘려놓은 통수는 다음 폴링에도 그대로 쓴다 — 가져오자마자 다시 줄어들면
// 보던 것이 눈앞에서 사라진다. 대신 상한을 둔다 — 많이 받을수록 폴링이 느려진다.
const MAIL_MORE_MAX = 200;
// 폴더마다 따로 센다 — 받은편지함을 200통까지 펼쳤다고 해서 보낸메일함까지
// 200통을 받아올 이유가 없다. 느린 서버에서 그건 몇 분이다.
let mailMore = 0;    // 받은편지함이 설정값에서 얼마나 더 보기로 했나
let sentMore = 0;    // 보낸메일함 몫

// 실제로 서버를 읽어 목록을 갈아끼운 횟수. «더 보기»가 이 수를 앞뒤로 비교해서
// «정말 다시 읽었나»를 안다.
//
// 이게 왜 필요한가: refreshMail도 loadSent도 이미 도는 것이 있으면 15초까지만
// 기다리고 포기한다. 이 서버는 읽음 표시 두 통에 88초가 걸린 적이 있어서 15초는 짧다.
// 포기한 것을 «다 읽었는데 더 없더라»와 구별하지 못하면, 통수만 늘려놓고 화면에는
// «더 없습니다»라고 말한 뒤 그 폴더를 잠가버린다.
let mailLoads = 0;
let sentLoads = 0;

/** 설정값 — «한 번에 몇 통 보여줄까» */
function mailBase() {
  return Math.max(1, Math.round(store.settings.mailCount) || 5);
}

function wantNow() {
  return Math.min(MAIL_MORE_MAX, mailBase() + mailMore);
}

function sentWantNow() {
  return Math.min(MAIL_MORE_MAX, mailBase() + sentMore);
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
  const rules = store.mailRules.filter((r) => r.on !== false);
  // 보여줄 통수 — 설정값이 기본이고, «더 보기»를 누를 때마다 늘어난다
  const want = wantNow();
  // 규칙이 걷어낼 몫만큼 더 받아온다. 안 그러면 광고 다섯 통을 숨긴 자리가 빈 채로 남는다.
  const limit = rules.length ? Math.min(want * 3, want + 20) : want;
  try {
    const errors = [];
    let unread = 0;
    let total = 0;
    let messages = [];
    for (const acc of accounts) {
      try {
        const r = await mail.fetchSummary(acc, {
          limit,
          onlyUnread: store.settings.mailOnlyUnread !== false
        });
        unread += r.unread;
        total += r.total || 0;
        messages.push(...r.messages.map((m) => ({ ...m, account: acc.name, accountId: acc.id })));
      } catch (e) {
        errors.push({ name: acc.name, message: mail.friendly(e) });
      }
    }
    // 주소록은 받은 메일에서 자란다 — 이름과 주소가 한 쌍씩 들어 있다.
    // 이렇게 해두면 나중에 «김부장»만 쳐도 주소가 나온다.
    //
    // 새로 온 것만 센다. 목록에 있는 20통을 확인할 때마다 다시 세면 «자주 쓰는 사람»이
    // 아니라 «메일함에 오래 머무른 사람»을 세게 된다 — 몇 분마다 도니까 하룻밤 두면
    // 한 통이 백 통이 되고, 자동완성 차례가 통째로 뒤집힌다.
    // (mailState.known은 지난번에 본 목록이다. 아래에서 이번 것으로 바뀐다.)
    const seenLastTime = mailState.known;
    store.rememberContacts(messages
      .filter((m) => m.fromAddress && (!seenLastTime || !seenLastTime.has(mailtally.keyOf(m))))
      .map((m) => ({ address: m.fromAddress, name: m.fromName })));

    messages.sort((a, b) => b.at - a.at);

    // 사용자가 방금 바꾼 읽음 상태를 서버 값 위에 덮는다. 규칙보다 먼저 해야
    // «자동 읽음»이 이미 읽은 메일을 또 건드리지 않는다.
    // 뱃지 숫자도 같이 보정한다 — 목록은 읽음인데 숫자만 안 줄면 그게 더 이상하다.
    const overlay = seenMarks.apply(messages);
    messages = overlay.messages;
    unread = Math.max(0, unread + overlay.delta);

    // 규칙 적용 — 화면에서 걷어내는 것과 알림에서 빼는 것은 다르다.
    //   숨김·스팸  → 목록에서도 빠지고 안읽음 수에서도 빠진다 (없는 셈)
    //   알림 안 함 → 목록에는 남지만 «새 메일» 알림을 띄우지 않는다
    const cut = mailrules.apply(messages, rules);
    const unreadOf = (list) => list.filter((m) => !m.seen).length;
    const hiddenUnread = unreadOf(cut.hidden);
    const groupedAll = cut.groups.flatMap((g) => g.items);
    const mutedUnread = unreadOf([...cut.visible, ...groupedAll].filter((m) => cut.mutedUids.has(m.uid)));

    // 서버가 세어 준 안읽음은 «받은 목록 너머»까지 센다. 걷어낸 몫만 빼면 되고,
    // 0 아래로는 내려가지 않게 막는다 (목록 밖에 숨길 것이 더 있으면 어긋난다).
    mailState.unread = Math.max(0, unread - hiddenUnread);
    mailState.quiet = hiddenUnread + mutedUnread;
    // 실패한 계정 몫이 빠진 total로 «마지막입니다»를 말하면, 남은 메일이 있는데도
    // 더 보기를 잠근다. 반쯤 아는 것보다 모르는 편이 낫다 (0이면 그 판단을 안 한다).
    mailState.total = errors.length ? 0 : total;
    mailState.filtered = cut.hidden.length;
    mailState.groups = cut.groups.map((g) => ({
      name: g.name,
      items: g.items.slice(0, want)
    }));
    // 폴더는 «메일 / 묶음들 / 숨김». 숨김은 want에 매이지 않는다 —
    // 무엇이 걸러졌는지 확인하러 여는 곳이라 잘려 있으면 확인이 안 된다.
    // 보낸메일함은 규칙과 무관하므로(내가 쓴 메일을 걸러낼 일은 없다) 여기서 따로 붙인다.
    const split = splitAccounts(accounts);
    mailState.accountTabs = split || [];
    mailState.folders = mailrules.folders(cut, Math.max(want, 30), { accounts: split });
    mailState.messages = cut.visible.slice(0, want);
    mailState.toRead = cut.read;
    mailState.toSpam = cut.spam;
    mailState.errors = errors;
    mailState.fetchedAt = Date.now();

    // «새 메일» — 지난번에 없던 것 중 안 읽었고 규칙이 조용히 시키지 않은 것만.
    // 숨김·스팸은 아예 세지 않고, 알림 안 함은 목록에는 남지만 여기서 빠진다.
    const quietUids = new Set([
      ...cut.hidden.map(mailtally.keyOf),
      ...[...cut.visible, ...groupedAll].filter((m) => cut.mutedUids.has(m.uid)).map(mailtally.keyOf)
    ]);
    const tally = mailtally.freshCount(messages, mailState.known, quietUids);
    mailState.pending += tally.fresh;
    mailState.known = tally.known;
    if (!tally.primed) evlog.log('메일', '첫 확인 — 이미 있던 것은 «새 메일»로 세지 않습니다');

    evlog.log('메일', `확인 완료 · 계정 ${accounts.length}개 · 안읽음 ${mailState.unread}`
      + ` · 목록 ${mailState.messages.length}건`
      + (rules.length ? ` · 규칙 ${rules.length}개로 ${cut.hidden.length}건 숨김`
        + (cut.groups.length ? ` · ${cut.groups.length}묶음` : '') : '')
      + (errors.length ? ` · 실패 ${errors.length}건: ${errors[0].message}` : ''));
    if (errors.length) console.warn('[mail]', errors.map((e) => `${e.name}: ${e.message}`).join(', '));
  } finally {
    mailState.loading = false;
    // 여기까지 왔다면 앞의 관문(꺼짐·이미 도는 중·계정 없음)을 다 지나 실제로 한 바퀴 돈 것이다
    mailLoads += 1;
  }
  // 새로 온 것을 파일로 남긴다. 기다리지 않는다 — 메일 목록은 이미 화면에 올라가야 한다.
  autoBackupNew();
  // 본문도 미리 받아둔다 — 목록은 이미 올라갔고, 이건 뒤에서 천천히 해도 된다.
  // 그래야 메일을 두 번 눌렀을 때 창이 곧바로 뜬다.
  prefetchBodies();
  // 서버를 만지는 규칙(자동 읽음·스팸)도 뒤에서 따로 돈다. 여기서 기다리면
  // 느린 서버에서 목록이 1분 넘게 안 뜬다 (실제로 88초가 걸린 적이 있다).
  runServerRules();
}

/**
 * «자동 읽음»과 «스팸으로»를 서버에 반영한다.
 * 화면 갱신과 떼어 놓고 한 번에 하나씩만 돈다 — 느린 서버에서 명령이 겹치면 소켓이 끊긴다.
 */
async function runServerRules() {
  if (ruleBusy) return;
  const toRead = ruleLog.pick('read', mailState.toRead.filter((m) => !m.seen));
  const toSpam = ruleLog.pick('spam', mailState.toSpam);
  if (!toRead.length && !toSpam.length) return;

  ruleBusy = true;
  let did = 0;
  try {
    for (const [action, list] of [['spam', toSpam], ['read', toRead]]) {
      const byAccount = new Map();
      for (const m of list) {
        if (!byAccount.has(m.accountId)) byAccount.set(m.accountId, []);
        byAccount.get(m.accountId).push(m.uid);
      }
      for (const [id, uids] of byAccount) {
        const acc = mailAccountsForUse().find((a) => a.id === id);
        if (!acc) continue;
        const keys = uids.map((u) => `${id}:${u}`);
        try {
          if (action === 'spam') {
            const r = await mail.moveToSpam(acc, uids);
            evlog.log('메일', `규칙 · 스팸으로 ${r.moved}통 → ${r.mailbox}`);
            did += r.moved;
          } else {
            const r = await mail.markRead(acc, uids, { read: true });
            evlog.log('메일', `규칙 · 자동 읽음 ${r.changed}통`);
            did += r.changed;
          }
          // 서버가 받아준 뒤에야 «했다»고 적는다
          ruleLog.ok(action, keys);
        } catch (e) {
          // 시간을 두고 몇 번 더 — 다만 무한정은 아니다. 곧바로 되돌려 놓으면
          // 끝에서 부르는 새로고침과 맞물려 느린 서버를 계속 두드리게 된다.
          const { n, giveUp } = ruleLog.bad(action, keys);
          evlog.log('메일', `규칙 실패 · ${action} · ${uids.length}통 · ${n}번째`
            + (giveUp ? ' · 그만둠' : ` · ${Math.round(RULE_RETRY_MS / 60000)}분 뒤 다시`) + ` · ${e.message}`);
          notice('bad', giveUp
            ? `규칙 적용을 그만뒀습니다 — ${e.message}`
            : `규칙 적용 실패, 다시 해봅니다 — ${e.message}`);
        }
      }
    }
  } finally {
    ruleBusy = false;
  }
  // 서버가 바뀌었으니 숫자를 맞춘다. 바뀐 게 없으면 부르지 않는다 — 헛돌기만 한다.
  if (did && !mailState.loading) refreshMail();
}

/** 규칙이 바뀌면 «이미 처리함»도 «해봤다 안 됐다»도 지운다 — 새 규칙은 있던 메일에도 걸려야 한다 */
function forgetRuleWork() {
  ruleLog.clear();
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
 * 새 메일을 실제로 알린다.
 *
 * 위 mailAnnounce()는 «지금이 알릴 때인가»만 판단한다. 그걸 부르는 곳이 없어서
 * 설정의 «알리는 방식»과 «알림 시각»이 아무 일도 하지 않고 있었다 — 그 자리를 잇는다.
 *
 * 휴식 알림과 같은 규칙을 따른다: 발표·전체화면·회의 중이면 알리지 않고 쌓아둔다.
 * 메일 때문에 발표가 끊기면 안 된다.
 */
function announceMail() {
  if (state.onBreak || state.paused) return;
  if (holdReason(0)) return;          // 방해 금지 — 끝난 뒤에 알린다 (pending은 그대로 남는다)

  const a = mailAnnounce();
  if (!a) return;

  const title = `새 메일 ${a.count}통`;
  const body = mailState.messages.length
    ? mailState.messages.slice(0, 3).map((m) => m.subject).join('\n')
    : '';

  // 위젯 머리글에도 남긴다 — 알림을 놓쳐도 여기서 보인다
  notice('good', title);
  evlog.log('메일', `알림 · ${title}`);

  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: !store.settings.soundEnabled });
  // 눌러서 바로 볼 수 있게 — 알림만 뜨고 어디로 가야 할지 모르면 소용이 없다
  n.on('click', () => {
    store.setSettings({ mailPanel: true });
    revealWidget();
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('mail:show');
  });
  n.show();
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
      joinMs: (s.calendarJoinMin || 0) * 60_000,
      allDayBusy: s.calendarAllDay
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
  if (state.dnd) return;
  const next = scheduler.soonest();
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
    for (const src of sources) {
      if (!src.thumbnail.isEmpty()) overlayShots.set(String(src.display_id), src.thumbnail.toDataURL());
    }
    shotsAt = Date.now();
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
  const next = scheduler.soonest();
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

async function openOverlays(ids) {
  const durations = ids.map((id) => {
    const c = scheduler.cfgOf(id);
    return (c && c.durationSec) || 20;
  });
  const durationSec = Math.max(...durations, 10);

  breakPayload = buildBreakPayload(ids);

  // 미리 찍어둔 게 있으면 그대로 쓴다 — 예정된 휴식은 1분 전에 찍어 둔다.
  // 없을 때만(«지금 쉬기»처럼 예고 없이 시작한 경우) 여기서 찍는다. 그때는 메인이
  // 2초쯤 멈춰 화면이 늦게 뜨지만, 그건 사용자가 방금 직접 누른 경우다.
  if (Date.now() - shotsAt > SHOT_FRESH_MS) await captureScreens();

  state.onBreak = true;
  state.breakIds = ids;
  state.breakStartedAt = Date.now();
  state.breakEndsAt = Date.now() + durationSec * 1000;

  // 화면 쪽이 그릴 때 «언제 끝나는지»가 있어야 한다 — 미리 만들어 둔 창은
  // 만들 때 그걸 몰랐으므로 여기서 같이 실어 보낸다.
  breakPayload.endsAt = state.breakEndsAt;

  // 미리 세워 둔 창이 다 준비됐으면 그걸 쓴다. 화면 수가 달라졌거나(모니터를 꽂았거나)
  // 아직 다 안 읽혔으면 그냥 새로 만든다 — 반쯤 준비된 창에 신호를 보내면 놓친다.
  const want = screen.getAllDisplays().length;
  // 아직 다 안 읽혔어도 미리 세워 둔 창을 쓴다 — 새로 만드는 것보다 무조건 앞서 있다.
  // 다 읽혔는지는 아래에서 창마다 따로 본다.
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
  for (const w of overlayWins) { try { w.destroy(); } catch {} }
  overlayWins = [];
  // 아직 찍고 있는 중일 수 있다 (기다리지 않고 창을 띄우므로).
  // 세대를 올려두면 그게 끝나도 지워진 자리에 다시 채워 넣지 않는다.
  shotSeq++;
  shotsReady = null;
  shotsAt = 0;
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
  statswin.notifyChanged();
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
  // 일시정지는 «시계를 멈추는 것»이다. 예전에는 알림만 안 띄우고 시계는 계속 갔다 —
  // 그래서 30분 멈춰뒀다 풀면 밀린 것들이 한꺼번에 쏟아졌다. 멈춘 동안 쉬지 않았으니
  // 남은 시간도 줄면 안 된다. 자리 비움과 같은 방식으로 다음 시각을 같이 밀어준다.
  if (state.paused) { scheduler.postponeAll(1000); dropWarm(); pushTick(); return; }

  // 멈춰 있거나 자리를 비운 사이에 지나가 버린 «정해진 시각»을 먼저 정리한다.
  // 이걸 due()보다 먼저 해야, 풀자마자 세 시간 전 알림이 튀어나오지 않는다.
  scheduler.catchUp(now);

  if (powerMonitor.getSystemIdleTime() >= store.settings.idlePauseSec) {
    scheduler.postponeAll(1000); // 자리 비움 동안 정지
    state.hold = null;
    state.dnd = null;
    dropWarm();                  // 자리에 없으면 곧 안 띄운다
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
        dropWarm();              // 언제 풀릴지 모르는 채로 들고 있지 않는다
      } else {
        state.hold = null;
        startBreak(due);
        return;
      }
    } else {
      state.hold = null;
      // 곧 올 휴식을 미리 준비해 둔다 — 배경 사진(1분 전)과 창(20초 전).
      // 여기서 하면 아무도 안 기다린다. 띄우는 순간에 하면 그 시간이 그대로
      // «늦게 뜬 알림»이 된다.
      prepareShots(now);
      tendWarm(now);
    }
  }
  announceMail();
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
  // 알림 한 줄은 잠깐만 살아 있는다 (기다리는 중이면 끝날 때까지)
  const nt = mailState.notice;
  const fresh = nt && (nt.kind === 'wait' || Date.now() - nt.at < 8000) ? nt : null;
  // 주식은 켜져 있을 때만 위젯에 단추를 낸다 (값은 창에서만 본다)
  const stocksOn = !!store.settings.stocksEnabled;

  const mailBox = (store.settings.mailEnabled && store.settings.mailShow)
    ? {
      unread: mailState.unread,
      messages: mailState.messages,
      notice: fresh,
      // 폴더 — 메일 / 규칙이 묶은 것들 / 숨김 / 보낸메일함.
      // 위젯이 한 번에 한 칸만 보여준다.
      // 받은편지함을 아직 한 번도 못 읽었으면 보낸메일함 탭도 내보내지 않는다 —
      // 그것 하나만 남으면 화면이 «보낸메일함»에서 시작하고 돌아갈 곳이 없다.
      folders: mailState.folders.length
        ? [...mailState.folders, ...draftFolders(), ...sentFolders()]
        : [],
      // 계정을 먼저 고르고 그 안에서 폴더를 고른다. 안 나눌 때는 빈 배열이라
      // 화면이 계정 줄을 아예 안 그린다.
      accounts: mailState.accountTabs || [],
      filtered: mailState.filtered
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
  settingsWin.loadFile(page('settings.html'), {
    query: glassQuery(want ? { radius: '20', tab: want } : { radius: '20' })
  });
  settingsWin.on('closed', () => { settingsWin = null; });
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
// ── IPC ──────────────────────────────────────────────────
ipcMain.on('widget:toggle-pause', togglePause);
ipcMain.on('widget:break-now', (_e, id) => startBreak(id ? [id] : null));
ipcMain.on('widget:open-settings', (_e, tab) => openSettings(tab));
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

ipcMain.handle('overlay:get-bg', async (_e, id) => {
  // 아직 찍는 중이면 여기서 기다린다 — 그동안 휴식 화면은 이미 떠 있다.
  if (shotsReady) { try { await shotsReady; } catch { /* 배경 없이 간다 */ } }
  return overlayShots.get(String(id)) || null;
});
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

// ── 메일 IPC ────────────────────────────────────────────
/** 계정 목록 (비밀번호는 절대 렌더러로 보내지 않는다 — 저장 여부만 알린다) */
function mailAccountsForUi() {
  return store.mailAccounts.map(({ sealed, ...rest }) => ({
    ...rest,
    hasPassword: !!sealed,
    // 비워두면 받는 서버와 아이디에서 짐작한다. 화면에는 «무엇이 실제로 쓰이는지»를
    // 보여줘야 한다 — 빈 칸에 예시만 떠 있으면 안 넣은 줄 알고 다시 넣게 된다.
    smtpResolved: mail.smtpOf(rest).host,
    smtpPortResolved: mail.smtpOf(rest).port,
    fromResolved: mail.fromOf(rest).address
  }));
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
  // 서명은 웹메일에서 통째로 복사해 오는 일이 많다. 저장되는 것이 최종본이므로
  // 여기서 실행되는 것을 걷어낸다 — 화면 쪽 검사는 붙여넣는 순간의 편의일 뿐이다.
  if (typeof p.signature === 'string') p.signature = mail.cleanHtml(p.signature);
  store.updateMailAccount(id, p);
  refreshMail();
  return mailAccountsForUi();
});
ipcMain.handle('mail:remove', (_e, id) => {
  store.removeMailAccount(id);
  refreshMail();
  return mailAccountsForUi();
});
/**
 * 지금 바로 확인. 주기(몇 분)를 기다리지 않고 새로 온 것을 본다.
 * 느린 서버에서는 이것도 한참 걸리므로 도는 동안 화면에 알린다.
 */
ipcMain.handle('mail:refresh', async () => {
  if (!store.settings.mailEnabled) {
    notice('bad', '메일 확인이 꺼져 있습니다 (설정에서 켜세요)');
    return mailStatus();
  }
  if (!mailAccountsForUse().length) {
    notice('bad', '쓸 수 있는 계정이 없습니다');
    return mailStatus();
  }
  notice('wait', '메일 확인 중…');
  const before = mailState.messages.map((m) => `${m.accountId}:${m.uid}`);
  await refreshMail({ force: true });

  if (mailState.errors.length) {
    notice('bad', mailState.errors[0].message);
    return mailStatus();
  }
  // «몇 통 왔나»는 목록 길이의 차이가 아니라 «전에 없던 것이 몇 개인가»다.
  // 개수만 비교하면 오래된 것이 밀려난 만큼 새 것을 못 센다.
  const fresh = mailState.messages.filter((m) => !before.includes(`${m.accountId}:${m.uid}`)).length;
  notice(fresh ? 'good' : '', fresh ? `새 메일 ${fresh}통` : '새로 온 메일이 없습니다');
  // 보낸메일함을 이미 열어봤다면 그것도 같이 새로 읽는다 — 방금 보낸 메일이
  // 안 보이면 «보내진 건가» 싶어진다. 한 번도 안 열어봤으면 건드리지 않는다.
  if (mailState.sent.at) loadSent();
  return mailStatus();
});

/**
 * 열어보지 않고 읽음으로만 표시한다.
 * uids가 없으면 그 계정의 안 읽은 것 전부, accountId가 없으면 모든 계정.
 */
/**
 * 위젯에 잠깐 띄울 한 줄. 틱 payload에 실어 보낸다 —
 * 화면에서 직접 글자를 바꾸면 1초 뒤 틱이 그대로 덮어써서 아무도 못 본다 (그랬다).
 */
function notice(kind, text) {
  mailState.notice = { at: Date.now(), kind, text };
}

async function doMarkRead({ accountId, uids, read = true, mailbox = '' } = {}) {
  const accounts = mailAccountsForUse().filter((a) => !accountId || a.id === accountId);
  if (!accounts.length) {
    notice('bad', '쓸 수 있는 계정이 없습니다');
    return { ok: false, changed: 0, message: '쓸 수 있는 계정이 없습니다', ...mailStatus() };
  }
  // 서버가 느리면 1분 넘게 걸린다. 그동안 아무 말이 없으면 «안 눌렸나» 싶어 또 누르게 된다.
  notice('wait', read ? '읽음 표시 중…' : '안 읽음으로 되돌리는 중…');

  // 바꾸려는 값을 먼저 장부에 적는다. 다음 틱부터 목록과 뱃지가 곧바로 그 값으로 보인다 —
  // 서버가 대답하는 건 그 한참 뒤다. 실패하면 아래에서 도로 지운다.
  // uids를 안 주면 «안 읽은 것 전부»라서 목록으로 알 수 있는 것만 적는다.
  // uid만으로는 어느 계정인지 알 수 없다 — 계정을 같이 받았을 때만 uid를 그대로 믿는다.
  // 아니면 화면이 알고 있는 목록에서 조건에 맞는 것을 찾아 적는다.
  const marked = (uids && uids.length && accountId)
    ? uids.map((u) => ({ accountId, mailbox, uid: u }))
    : knownMessages()
      .filter((m) => (!accountId || m.accountId === accountId) && !!m.seen !== read)
      .filter((m) => !uids || !uids.length || uids.includes(m.uid))
      .map((m) => ({ accountId: m.accountId, mailbox: m.mailbox || '', uid: m.uid }));
  seenMarks.markAll(marked, read);

  let changed = 0;
  const failed = [];
  for (const acc of accounts) {
    try {
      const r = await mail.markRead(acc, uids, { read, mailbox });
      changed += r.changed;
    } catch (e) {
      // 추측을 즉시 버린다 — 바뀜 척하면 안 된다
      seenMarks.unmarkAll(marked.filter((x) => x.accountId === acc.id));
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
  notice(failed.length ? 'bad' : 'good',
    failed.length ? failed[0].replace(/^[^:]+:\s*/, '')
      : changed ? `${changed}통 ${read ? '읽음' : '안 읽음'}으로 표시했습니다`
        : '바꿀 메일이 없습니다');
  // 서버 쪽이 바뀌었으니 화면 숫자도 맞춘다. 다만 **기다리지 않는다** —
  // 이 서버는 새로고침 한 번이 1분을 넘긴 적이 있고, 여기서 기다리면 그동안
  // 부른 쪽이 잠긴다. 메일 보기 창의 읽음 칩이 실제로 그랬다: 눌러서 바뀐 것을
  // 되돌리려고 다시 눌러도 1분 넘게 아무 일도 안 일어났다.
  // 서버는 이미 바뀌었으니 «됐다»는 지금 말할 수 있다. 숫자는 조금 뒤 틱에 따라온다.
  refreshMail({ force: true }).catch(() => { /* 실패는 다음 폴링이 알아서 다시 본다 */ });
  return {
    ok: failed.length === 0,
    changed,
    message: failed.length ? failed[0] : '',
    ...mailStatus()
  };
}

ipcMain.handle('mail:mark-read', (_e, opts) => doMarkRead(opts || {}));

ipcMain.handle('mail:row-menu', async (e, msg) => {
  const win = BrowserWindow.fromWebContents(e.sender);

  // 임시보관함의 줄은 메일이 아니다 — 읽음도 규칙도 뜻이 없다.
  if (msg && msg.draft) {
    const pick = await pickFromMenu(win, [
      { id: 'edit', label: '이어서 쓰기' },
      { type: 'separator' },
      { id: 'drop', label: '임시 저장 버리기', danger: true }
    ], screen.getCursorScreenPoint());
    if (pick === 'edit') startCompose({ kind: 'new' });
    if (pick === 'drop') {
      const r = await askUser(win, {
        buttons: ['버리기', '그만두기'],
        defaultId: 0,
        danger: true,
        title: '임시보관함',
        message: '쓰다 만 글을 버릴까요?',
        detail: '되돌릴 수 없습니다.'
      });
      if (r === 0) {
        store.clearMailDraft();
        notice('good', '임시 저장을 버렸습니다');
      }
    }
    return null;
  }

  if (!msg || !msg.uid) return null;
  const base = mailrules.ruleFor(msg, 'hide');
  const who = base.match || '(보낸사람 모름)';

  const add = (action, extra) => {
    store.addMailRule({ ...base, action, ...extra });
    forgetRuleWork();
    refreshMail({ force: true });
  };

  const items = [];

  // 답장·전달은 메일을 열어야만 할 수 있었다 — 목록에서 바로 되어야 한다.
  // 인용문을 넣으려면 원문이 필요해서 여기서 한 번 받아온다 (메일을 여는 것과 같은 비용).
  const draft = (kind) => async () => {
    const acc = mailAccountsForUse().find((a) => a.id === msg.accountId);
    if (!acc) { notice('bad', '이 메일의 계정을 쓸 수 없습니다'); return; }
    notice('wait', kind === 'reply' ? '답장 준비 중…' : '전달 준비 중…');
    try {
      const m = await mail.fetchBody(acc, msg.uid, {
        markSeen: false, allowRemote: false, mailbox: msg.mailbox || ''
      });
      const r = startCompose({
        kind,
        accountId: acc.id,
        source: {
          subject: m.subject, from: m.from, fromAddress: m.fromAddress, to: m.to,
          replyTo: m.replyTo, messageId: m.messageId, at: m.receivedAt,
          text: m.text, html: m.html
        }
      });
      notice(r.ok ? '' : 'bad', r.ok ? '' : r.message);
    } catch (e) {
      notice('bad', mail.friendly(e));
    }
  };

  // 보낸메일함의 메일은 내가 쓴 것이다. 답장하면 나에게 가니 그 자리에 «복사»를 둔다 —
  // 받는사람·제목·본문을 그대로 둔 새 메일로 열어 다시 보낼 수 있게.
  const copy = () => async () => {
    const acc = mailAccountsForUse().find((a) => a.id === msg.accountId);
    if (!acc) { notice('bad', '이 메일의 계정을 쓸 수 없습니다'); return; }
    notice('wait', '복사 준비 중…');
    try {
      const m = await mail.fetchBody(acc, msg.uid, {
        markSeen: false, allowRemote: false, mailbox: msg.mailbox || ''
      });
      const r = startCopy({
        accountId: acc.id,
        view: { subject: m.subject, to: m.to, cc: m.cc, text: m.text, html: m.html },
        files: m.attachments || []
      });
      notice(r.ok ? '' : 'bad', r.ok ? '' : r.message);
    } catch (e) {
      notice('bad', mail.friendly(e));
    }
  };

  items.push(
    ...(msg.fromSelf
      ? [{ label: '복사 (다시 쓰기)', click: copy() }]
      : [{ label: '답장', click: draft('reply') }]),
    { label: '전달', click: draft('forward') },
    { type: 'separator' }
  );

  // 읽음은 되돌릴 수 있어야 한다. 메일 보기 창의 칩은 양쪽으로 도는데
  // 목록에는 «읽음으로»만 있어서, 잘못 누르면 창을 열어야만 되돌릴 수 있었다.
  items.push({
    label: msg.seen ? '안 읽음으로 되돌리기' : '읽음으로 표시',
    click: () => doMarkRead({
      accountId: msg.accountId,
      uids: [msg.uid],
      read: !msg.seen,
      mailbox: msg.mailbox || ''
    })
  }, {
    label: '휴지통으로',
    danger: true,
    click: () => doTrash(msg, win)
  }, { type: 'separator' });

  // 이 메일이 규칙에 걸려서 여기 있는 것이라면, 그 규칙을 되돌리는 길이 제일 위에 와야 한다.
  // 숨김 폴더를 열어보는 이유가 대개 «이건 숨기면 안 되는데»이기 때문이다.
  // 화면이 준 id를 그대로 믿지 않고 저장된 규칙에서 다시 찾는다.
  const mark = msg.byRule && msg.byRule.id
    ? store.mailRules.find((r) => r.id === msg.byRule.id)
    : null;
  if (mark) {
    items.push(
      {
        label: `이 규칙 끄기 — ${mailrules.describe(mark)}`,
        click: () => {
          store.updateMailRule(mark.id, { on: false });
          forgetRuleWork();
          notice('good', '규칙을 껐습니다');
          refreshMail({ force: true });
        }
      },
      {
        label: '이 규칙 지우기',
        danger: true,
        click: () => {
          store.removeMailRule(mark.id);
          forgetRuleWork();
          notice('good', '규칙을 지웠습니다');
          refreshMail({ force: true });
        }
      },
      { type: 'separator' }
    );
  }

  // 규칙은 «받는 메일»에 대한 것이다. 보낸메일함 줄에서는 보여주지 않는다 —
  // 그 줄의 보낸사람은 나라서, «이 보낸사람 숨기기»가 내 주소를 거르는 규칙이 된다.
  // 그러면 받은편지함의 내게쓴메일·반송·사내 배포메일이 대신 숨겨지거나 스팸으로 간다.
  // (받는 사람 기준으로 규칙을 만들려면 목록이 To를 들고 있어야 하는데 지금은 From만 든다)
  if (!msg.fromSelf) {
    // 주소를 줄마다 되풀이하지 않는다 — 다섯 줄이 다 «— ecount@ecount.com»으로 끝나면
    // 정작 다른 부분(무엇을 하는가)이 눈에 안 들어온다. 어느 메일에서 연 메뉴인지는
    // 방금 오른쪽 클릭한 그 줄이 말해준다. 주소는 마우스를 올리면 나온다.
    items.push(
      { label: '숨기기', title: `${who} 에서 오는 메일을 숨깁니다`, click: () => add('hide') },
      ...(base.domain
        ? [{
          label: '전부 숨기기',
          title: `${base.domain} — 같은 곳에서 오는 메일을 모두 숨깁니다`,
          click: () => add('hide', { match: base.domain })
        }]
        : []),
      { label: '알림 안 함', title: `${who} — 목록에는 두되 알리지 않습니다`, click: () => add('mute') },
      { label: '자동 읽음', title: `${who} — 오는 대로 읽음으로 표시합니다`, click: () => add('read') },
      { type: 'separator' },
      {
        // 물어보는 일은 okToSpam 한 곳에서만 한다 — 입구마다 따로 두면 하나씩 빠진다
        label: '스팸으로 보내기',
        title: `${who} — 서버의 스팸 폴더로 옮깁니다`,
        danger: true,
        click: async () => {
          const rule = { ...base, action: 'spam' };
          if (await okToSpam(rule, win)) add('spam');
        }
      },
      { type: 'separator' }
    );
  }

  items.push(
    { label: '필터 관리…', click: openSettings }
  );

  // 항목마다 자리 번호를 붙여 화면에 넘기고, 골라 온 번호의 click을 여기서 부른다.
  // 이렇게 하면 위에서 만들어 둔 동작들을 그대로 두고 그리는 쪽만 갈아끼울 수 있다.
  const list = items.map((it, i) => (it.type === 'separator'
    ? { type: 'separator' }
    : { id: String(i), label: it.label, title: it.title || '', danger: !!it.danger }));
  const pick = await pickFromMenu(win, list, screen.getCursorScreenPoint());
  const chosen = pick == null ? null : items[Number(pick)];
  if (chosen && typeof chosen.click === 'function') await chosen.click();
  return null;
});

/**
 * 임시보관함 한 칸.
 *
 * 쓰다 만 글이 «어딘가에 있다»고만 하면 없는 것과 같다.
 * 아웃룭처럼 폴더로 보여야 «여기 있구나»가 된다.
 * 서버의 Drafts가 아니라 이 PC에 적어둔 것이다 — 이 서버는 느려서
 * 손이 멈출 때마다 서버에 올리면 그게 오히려 방해가 된다.
 */
/**
 * 계정별로 나눠 볼 계정 목록. 안 나눌 때는 null.
 *
 * 계정이 하나면 나누지 않는다 — 그 이름으로 칸 하나를 만들면 «메일»이 사라진 것처럼
 * 보이고, 고를 것이 없는 계정 줄만 자리를 차지한다.
 */
function splitAccounts(accounts) {
  const list = accounts || mailAccountsForUse();
  if (!store.settings.mailPerAccount || list.length < 2) return null;
  return list.map((a) => ({ id: a.id, name: a.name || a.user }));
}

function draftFolder() {
  const d = store.mailDraft;
  if (!d) return null;
  const who = String(d.to || '').trim();
  return {
    id: 'draft',
    name: '임시보관함',
    items: [{
      draft: true,
      uid: 0,
      accountId: d.accountId || '',
      subject: String(d.subject || '').trim() || '(제목 없음)',
      from: who ? `받는 사람: ${who}` : '받는 사람 없음',
      at: d.at || 0,
      seen: true
    }],
    count: 1,
    unread: 0
  };
}

/**
 * 보낸메일함 폴더 한 칸.
 * 아직 안 불러왔어도 «탭»은 있어야 한다 — 없으면 누를 것이 없어서 영영 안 불러온다.
 * lazy 표시를 보고 화면이 처음 누를 때 mail:sent를 부른다.
 */
function sentFolder(acct, items) {
  const s = mailState.sent;
  const list = items || s.messages;
  return {
    id: 'sent',
    acct: acct || '',
    name: acct ? '보낸' : '보낸메일함',
    items: list,
    count: list.length,
    unread: 0,                 // 내가 쓴 메일에 «안 읽음»은 뜻이 없다
    lazy: !s.at,               // 한 번도 안 불러왔다
    loading: s.loading,
    error: s.error
  };
}

/** 계정별로 볼 때는 보낸메일함도 계정마다 하나씩 — 내 회사 메일과 개인 메일은 다르다 */
function sentFolders() {
  const split = splitAccounts();
  if (!split) return [sentFolder()];
  return split.map((a) =>
    sentFolder(a.id, mailState.sent.messages.filter((m) => m.accountId === a.id)));
}

/** 임시보관함은 한 통뿐이다 — 계정별로 볼 때는 그 초안을 쓴 계정 밑에만 둔다 */
function draftFolders() {
  const d = draftFolder();
  if (!d) return [];
  const split = splitAccounts();
  if (!split) return [d];
  const owner = split.find((a) => a.id === (store.mailDraft || {}).accountId) || split[0];
  return [{ ...d, acct: owner.id }];
}

/**
 * 보낸메일함 — 눌렀을 때만 가져온다.
 * 폴더 이름이 서버마다 달라서 mail.findBox가 찾아준다. 못 찾으면 받은편지함으로
 * 슬쩍 넘어가지 않고 그 사실을 말한다.
 */
async function loadSent({ force = false } = {}) {
  if (mailState.sent.loading) {
    // «더 보기»는 이미 도는 것이 끝나기를 기다렸다 다시 읽어야 한다 —
    // 그냥 돌아가면 통수를 늘려놓고 안 가져온 셈이 되어, 화면은 그대로인데
    // 다음에 부를 때는 «이미 늘렸으니 그만»이 된다.
    if (!force) return mailState.sent;
    for (let i = 0; i < 60 && mailState.sent.loading; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (mailState.sent.loading) return mailState.sent;
  }
  const accounts = mailAccountsForUse();
  if (!accounts.length) {
    // at을 찍어야 «한 번 해봤고 안 됐다»가 된다. 안 찍으면 lazy가 안 풀려서
    // 화면이 «누르면 불러옵니다»로 되돌아가고 사유는 끝내 안 보인다.
    mailState.sent = { ...mailState.sent, at: Date.now(), loading: false, error: '쓸 수 있는 계정이 없습니다' };
    return mailState.sent;
  }
  mailState.sent = { ...mailState.sent, loading: true, error: '' };
  const want = sentWantNow();
  const out = [];
  const bad = [];
  let total = 0;
  for (const acc of accounts) {
    try {
      // 보낸 메일에 «안 읽음»은 뜻이 없다 — 내가 쓴 것이다. 최근 것부터 그냥 보여준다.
      const r = await mail.fetchSummary(acc, { limit: want, onlyUnread: false, box: 'sent' });
      // fromSelf — 내가 쓴 메일이라는 표시. 여기에 «답장»을 붙이면 나에게 답장이 간다.
      // seen을 참으로 고정한다 — 내가 쓴 메일에 «안 읽음» 강조는 뜻이 없다.
      // 그래서 이 목록에는 읽음 임시 장부를 덮지 않는다. 덮으면 «고정된 참»과 값이 같아져
      // 장부가 곧바로 지워지고, 정작 메일을 다시 열었을 때 옛 값이 나온다.
      total += r.total || 0;
      out.push(...r.messages.map((m) => ({
        ...m, account: acc.name, accountId: acc.id, seen: true, fromSelf: true
      })));
    } catch (e) {
      bad.push(`${acc.name || acc.user}: ${mail.friendly(e)}`);
    }
  }
  out.sort((a, b) => b.at - a.at);
  mailState.sent = {
    at: Date.now(), loading: false, messages: out.slice(0, want),
    // 계정 하나가 실패하면 그 몫이 빠져 total이 실제보다 작아진다. 그 작은 수로
    // «마지막입니다»를 판단하면 남은 메일이 있는데도 폴더를 잠근다 — 모르는 편이 낫다.
    total: bad.length ? 0 : total,
    error: out.length ? '' : (bad[0] || '보낸 메일이 없습니다')
  };
  sentLoads += 1;
  evlog.log('메일', `보낸메일함 · ${out.length}건`
    + (want > mailBase() ? ` (${want}통까지 폈음)` : '')
    + (bad.length ? ` · 실패 ${bad.join(' / ')}` : ''));
  return mailState.sent;
}

/**
 * 더 보기 — 목록 끝까지 내려갔을 때 화면이 부른다.
 * 한 번에 설정값만큼씩 늘린다 (20이면 20 → 40 → 60…).
 * 끝까지 왔으면 그렇다고 말해준다 — 아무 말도 없으면 계속 누르게 된다.
 */
ipcMain.handle('mail:more', async (_e, folder) => (
  folder === 'sent' ? moreSent() : moreInbox()
));

/**
 * 더 부를 자리가 남았는지 — 상한과 서버에 있는 통수를 본다.
 * 남았으면 null, 아니면 화면에 그대로 보여줄 대답.
 */
function moreRoom(before, total, count) {
  if (before >= MAIL_MORE_MAX) {
    return { ok: false, more: false, count, message: `여기까지입니다 (최대 ${MAIL_MORE_MAX}통)` };
  }
  // 서버에 있는 것보다 많이 부르면 더 나올 게 없다
  if (total && before >= total) return { ok: false, more: false, count, message: '마지막입니다' };
  return null;
}

/**
 * 늘려놓고 못 가져왔을 때 되돌린다.
 *
 * refreshMail·loadSent는 앞의 것이 안 끝나면 15초까지만 기다리고 포기한다.
 * 포기한 채로 «다 읽었는데 더 없더라»라고 하면 두 가지가 한꺼번에 어긋난다 —
 * 화면은 그 폴더를 «끝»으로 적어 잠그고, 통수는 받아오지도 않은 채 늘어난 상태로
 * 남아 그 뒤 새로고침마다 이 느린 서버에서 그만큼씩 더 받는다.
 */
function notLoaded(count) {
  notice('bad', '서버가 아직 응답하지 않습니다 — 잠시 뒤 다시 해보세요');
  return { ok: false, more: false, retry: true, count, message: '서버가 아직 응답하지 않습니다' };
}

async function moreInbox() {
  const base = mailBase();
  const before = wantNow();
  const full = moreRoom(before, mailState.total, mailState.messages.length);
  if (full) return full;

  const was = mailMore;
  mailMore = Math.min(MAIL_MORE_MAX, before + base) - base;
  notice('wait', '이전 메일을 불러오는 중…');
  const had = mailState.messages.length;
  const loads = mailLoads;
  await refreshMail({ force: true });
  if (mailLoads === loads) { mailMore = was; return notLoaded(had); }
  const now = mailState.messages.length;
  notice(now > had ? 'good' : '', now > had ? `${now - had}통 더 불렀습니다` : '더 없습니다');
  return { ok: true, more: now > had, count: now };
}

/**
 * 보낸메일함 더 보기 — 받은편지함과 같은 셈을 제 통수로 한다.
 * 아직 한 번도 안 불러왔으면 늘리지 않는다. 처음 여는 것이 곧 첫 20통이고,
 * 여기서 늘려버리면 열자마자 40통을 받으러 간다.
 */
async function moreSent() {
  const count = mailState.sent.messages.length;
  // 첫 목록도 아직 안 왔다. «끝»이 아니라 «조금 뒤에»다 — retry를 달아 구별해 준다.
  if (!mailState.sent.at) {
    return { ok: false, more: false, retry: true, count, message: '아직 안 불러왔습니다' };
  }

  const base = mailBase();
  const before = sentWantNow();
  const full = moreRoom(before, mailState.sent.total, count);
  if (full) return full;

  const was = sentMore;
  sentMore = Math.min(MAIL_MORE_MAX, before + base) - base;
  notice('wait', '이전 보낸 메일을 불러오는 중…');
  const loads = sentLoads;
  await loadSent({ force: true });
  if (sentLoads === loads) { sentMore = was; return notLoaded(count); }
  const now = mailState.sent.messages.length;
  notice(now > count ? 'good' : '', now > count ? `${now - count}통 더 불렀습니다` : '더 없습니다');
  return { ok: true, more: now > count, count: now };
}

ipcMain.handle('mail:sent', async () => {
  const r = await loadSent();
  return { loading: r.loading, count: r.messages.length, error: r.error };
});

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
    const occ = calendar.occurrencesIn(text, now - 7 * 86400000, now + 30 * 86400000);
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
  // 주식을 끄면 열려 있던 창도 닫는다 — 끈 기능의 창이 남아 있으면 이상하다
  if (patch && patch.stocksEnabled === false) closeStocks();
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
    primeCalendarsFromCache();

    scheduler.reset();
    const resumed = restoreSession();
    if (resumed) console.log(`[session] 이전 상태 이어가기 (알림 ${resumed.restored}개)`);

    updateTray();
    watchDisplays();
    // 주소록의 파일 고르기 창을 설정 창 위에 띄우기 위해 (여기서 해야 settingsWin이 선언된 뒤다)
    contacts.init({ parentWin: () => settingsWin });
    statswin.init({ scheduler, startBreak: (ids) => startBreak(ids) });
    mailbody.init({ mailAccountsForUse: () => mailAccountsForUse(), mailState });
    mailfilter.init({
      mailState,
      refreshMail: (o) => refreshMail(o),
      forgetRuleWork: () => forgetRuleWork()
    });
    mailwin.init({
      mailAccountsForUse: () => mailAccountsForUse(),
      refreshMail: (o) => refreshMail(o),
      localOrServer: (acc, msg) => localOrServer(acc, msg),
      notice: (k, t) => notice(k, t),
      seenMarks
    });
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

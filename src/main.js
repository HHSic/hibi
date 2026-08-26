const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  powerMonitor, nativeImage, desktopCapturer, nativeTheme, shell, dialog, clipboard, Notification
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
const mailrules = require('./mailrules');
const mailtally = require('./mailtally');
const mailmark = require('./mailmark');
const contactcsv = require('./contactcsv');
const mailcache = require('./mailcache');
const preview = require('./preview');
const send = require('./send');
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
  folders: [],          // 화면에 보일 폴더 [{ id, name, items, count, unread }]
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
    // 계정이 둘 이상이고 설정을 켰을 때만 계정별로 나눈다 —
    // 계정이 하나인데 그 이름으로 칸을 만들면 «메일»이 사라진 것처럼 보인다.
    const split = store.settings.mailPerAccount && accounts.length > 1
      ? accounts.map((a) => ({ id: a.id, name: a.name || a.user }))
      : null;
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
    // 켜면 «건너뛰기»·«다 했어요»를 숨긴다. 시간이 끝나면 tick()이 알아서 닫는다.
    noEscape: !!s.breakNoEscape,
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
        ? [...mailState.folders, draftFolder(), sentFolder()].filter(Boolean)
        : [],
      filtered: mailState.filtered
    }
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
ipcMain.on('widget:open-settings', (_e, tab) => openSettings(tab));
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

// ── 메일 쓰기 ───────────────────────────────────────────
// 받기(IMAP)와 보내기(SMTP)는 서버가 다르다. 창은 하나만 띄운다 —
// 쓰던 글이 있는데 새 창이 겹쳐 뜨면 어느 쪽에 쓰고 있었는지 잃는다.
let composeWin = null;
let composePayload = null;
let composeSize = null;
// 복사(다시 보내기)로 실어둔 원문 첨부. 바이트는 여기 메인에만 둔다 —
// 화면에는 «무엇이 붙어 있나»만(이름·크기·id) 넘기고, 보낼 때 id로 다시 맞춘다.
// composePayload와 짝이다(창이 하나뿐이다). 그래서 반드시 같이 확정해야 한다 —
// 짝이 어긋나면 화면에 붙어 보이는 첨부를 못 보내게 된다.
let composeCarried = [];
// 창이 이미 열려 있어 갈아끼기를 «물어보는 중»인 첨부. 화면이 수락할 때 비로소 확정한다.
// 먼저 확정하면, 사용자가 «현재 초안 유지»를 고른 순간 그 초안의 첨부가 사라진다.
let pendingCarried = [];
let copySeq = 0;
// 보내는 중인가. 두 번 나가는 것을 막고, 그 사이에 들어오는 새 초안도 거절한다.
// openCompose가 이걸 보므로 그보다 위에 선언한다 (선언 전 사용으로 화면이 죽은 적이 여러 번 있다).
let sendingNow = false;

function openCompose(payload, carried = []) {
  if (composeWin && !composeWin.isDestroyed()) {
    // 보내는 중이면 화면이 갈아끼우기를 그냥 버린다. 그걸 성공이라고 돌려주면
    // 답장을 눌렀는데 아무 일도 안 일어나고 이유도 안 나온다 — 여기서 거절한다.
    // (이 서버는 보내는 데 수십 초가 걸려서 그 사이가 짧지 않다)
    if (sendingNow) {
      return { ok: false, message: '쓰기 창이 메일을 보내는 중입니다 — 끝나면 다시 눌러주세요' };
    }
    // 창을 반드시 보이게 한 다음에 말을 건다.
    // focus()만으로는 최소화된 창이 안 올라온다 — 그러면 답장을 눌렀는데
    // 아무 일도 안 일어난다. 갈아끼울까 묻는 말도 안 보이는 창에서 뜼게 된다.
    if (composeWin.isMinimized()) composeWin.restore();
    if (!composeWin.isVisible()) composeWin.show();
    composeWin.moveTop();
    composeWin.focus();
    // 쓰던 글이 있는데 새 초안으로 갈아끼우면 그 글은 그대로 사라진다.
    // 화면에 물어보고, 아니라고 하면 쓰던 것을 그대로 둔다.
    // 첨부도 여기서 확정하지 않는다 — 화면이 수락해야(compose:accept-replace) composeCarried와
    // composePayload를 함께 바꾼다. 먼저 바꾸면 «유지»를 골랐을 때 그 초안의 첨부가 사라진다.
    pendingCarried = carried;
    composeWin.webContents.send('compose:replace', payload);
    evlog.log('메일', '쓰기 창이 이미 열려 있어 갈아끼기를 물어봅니다');
    return { ok: true, message: '쓰기 창이 이미 열려 있습니다 — 그쪽에서 물어봅니다', reused: true };
  }
  composePayload = payload;
  composeCarried = carried;   // 새 창은 곧바로 확정한다 — composeData로 그대로 채운다
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
  composeWin.on('closed', () => {
    composeWin = null; composePayload = null; composeCarried = []; pendingCarried = [];
  });
  return { ok: true, message: '' };
}

/**
 * 새 메일 / 답장 / 전달 — 어느 쪽이든 초안을 만들어 창을 연다.
 * 메일 보기 창의 «답장» 버튼과 목록의 오른쪽 클릭이 같은 길을 쓴다.
 */
function startCompose({ kind = 'new', accountId, source } = {}) {
  const accounts = mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: '쓸 수 있는 계정이 없습니다' };

  // 답장·전달은 반드시 그 메일을 받은 계정으로 써야 한다. 못 찾았다고 첫 계정으로 넘기면
  // 개인 메일에 회사 주소로 답장이 나간다 — 받는 사람 눈에는 그게 내 정체다.
  const asked = accounts.find((a) => a.id === accountId);
  if (!asked && kind !== 'new') {
    evlog.log('메일', `쓰기 못 열음 · 계정 ${accountId}을 목록에서 못 찾음`
      + ` (쓸 수 있는 계정: ${accounts.map((a) => a.id).join(',') || '없음'})`);
    return { ok: false, message: '이 메일을 받은 계정을 쓸 수 없습니다 (꺼져 있거나 지워졌습니다)' };
  }
  // 이어쓰는 것은 원래 쓰던 계정으로 — 그 계정이 없어졌으면 첫 계정으로 놓아둔다
  const draftAcc = kind === 'new' && store.mailDraft
    ? accounts.find((x) => x.id === store.mailDraft.accountId)
    : null;
  const acc = asked || draftAcc || accounts[0];

  // 쓰다 말은 것이 있으면 이어서 쓴다. 답장·전달은 새 초안이 분명하므로 건드리지 않는다.
  const kept = kind === 'new' ? store.mailDraft : null;
  const draft = kept
    ? {
      to: kept.to, cc: kept.cc, bcc: kept.bcc, subject: kept.subject,
      bodyHtml: kept.bodyHtml, inReplyTo: kept.inReplyTo, references: kept.references,
      restored: true, restoredAt: kept.at, restoredNames: kept.attachNames || []
    }
    : (kind === 'new' ? { to: '', subject: '', text: '' } : send.draftFrom(kind, source));
  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  evlog.log('메일', `쓰기 열기 · ${kind} · 계정 ${acc.name || acc.user}`);
  const opened = openCompose({
    accountId: acc.id,
    signature: stored.signature || '',
    signatures: Object.fromEntries(store.mailAccounts.map((a) => [a.id, a.signature || ''])),
    title: kept ? (kept.title || '이어 쓰기')
      : kind === 'reply' ? '답장' : kind === 'forward' ? '전달' : '새 메일',
    // 새 메일은 어느 계정으로 보낼지 고를 수 있어야 한다 — 안 그러면 «마지막에 온 메일의
    // 계정»으로 정해져서, 받은 순서가 내 발신 주소를 결정하게 된다
    pickable: kind === 'new',
    accounts: accounts.map((a) => {
      const f = mail.fromOf(a);
      return { id: a.id, name: a.name || a.user, from: f.address, label: f.name };
    }),
    ...draft
  });
  if (!opened.ok) evlog.log('메일', `쓰기 못 열음 · ${opened.message}`);
  return opened;
}

ipcMain.handle('compose:open', (_e, opts) => startCompose(opts || {}));

// 본문에 박힌 그림은 «첨부»가 아니다 — 이미 본문(cid/data:)에 들어 있다.
// 그것까지 다시 실으면 그림이 두 번(본문 한 번, 첨부 한 번) 나간다.
// mailparser는 본문이 참조하는 조각에 related=true를 단다.
function realAttachments(files) {
  return (files || []).filter((a) => a && a.content && a.filename
    && !a.related && a.contentDisposition !== 'inline');
}

/**
 * 보낸 메일을 복사해 새 메일로 연다 — «다시 보내기».
 * 원문 첨부의 바이트는 메인에만 두고(composeCarried), 화면에는 이름·크기·id만 넘긴다.
 * 보낼 때 그 id로 바이트를 다시 맞춘다 — 큰 파일이 화면을 오가지 않게, 그리고
 * 화면이 뚫려도 아무 파일이나 실어 보내지 못하게.
 */
function startCopy({ accountId, view, files } = {}) {
  const accounts = mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: '쓸 수 있는 계정이 없습니다' };
  // 보낸 메일은 그 계정으로 다시 보내는 게 자연스럽다. 못 찾으면 첫 계정으로 둔다
  // (내 보낸메일함이니 어느 계정이든 내 것이다).
  const acc = accounts.find((a) => a.id === accountId) || accounts[0];
  const draft = send.copyFrom(view || {});

  const carry = realAttachments(files).slice(0, 20).map((a) => ({
    id: `copy${++copySeq}`, filename: a.filename, size: a.content.length, content: a.content
  }));

  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  evlog.log('메일', `복사 열기 · 계정 ${acc.name || acc.user}`
    + (carry.length ? ` · 첨부 ${carry.length}개` : ''));
  const opened = openCompose({
    accountId: acc.id,
    signature: stored.signature || '',
    signatures: Object.fromEntries(store.mailAccounts.map((a) => [a.id, a.signature || ''])),
    title: '복사본',
    pickable: false,
    accounts: accounts.map((a) => {
      const f = mail.fromOf(a);
      return { id: a.id, name: a.name || a.user, from: f.address, label: f.name };
    }),
    ...draft,
    // 바이트는 빼고 이름·크기·id만. 화면은 이걸로 칩을 그리고, 보낼 때 도로 넘긴다.
    attachments: carry.map(({ content, ...d }) => ({ ...d, carried: true }))
  }, carry);
  if (!opened.ok) evlog.log('메일', `복사 못 열음 · ${opened.message}`);
  return opened;
}

// 메일 보기 창의 «휴지통» — 옮기고 나면 그 창은 없는 메일을 보고 있으므로 닫는다
ipcMain.handle('mail:trash', async (e) => {
  const slot = slotOf(e);
  if (!slot || !slot.payload || slot.payload.error) {
    return { ok: false, message: '메일을 아직 다 읽지 못했습니다' };
  }
  const v = slot.payload;
  const r = await doTrash(
    { accountId: v.accountId, uid: v.uid, mailbox: v.mailbox, subject: v.subject }, slot.win);
  // 물어보고 그만뒀거나 실패했으면 창을 그대로 둔다 — 옮겨졌을 때만 닫는다.
  // (목록이 줄었는지로 판단하면 안 된다. refreshMail을 기다리지 않기 때문이다.)
  if (r.moved && !slot.win.isDestroyed()) slot.win.close();
  // 그만두기를 고른 것은 실패가 아니다 — 화면이 «옮기지 못했습니다»라고 하면 안 된다
  return { ok: r.moved, cancelled: !!r.cancelled, closed: !!r.moved, message: r.message || '' };
});

// 메일 보기 창의 «복사» — 원문 버퍼가 여기(slot.files)에 있으므로 메인이 만든다
ipcMain.handle('mail:copy', (e) => {
  const slot = slotOf(e);
  if (!slot || !slot.payload || slot.payload.error) {
    return { ok: false, message: '메일을 아직 다 읽지 못했습니다' };
  }
  const v = slot.payload;
  // 단추·메뉴는 내가 보낸 메일에서만 «복사»를 보여준다. IPC도 같은 문을 지켜야 한다 —
  // 안 그러면 뚫린 화면이 받은 메일의 첨부 바이트(메인에만 두는 것)를 실어 보낼 수 있다.
  if (!v.fromSelf) return { ok: false, message: '복사는 내가 보낸 메일에서만 됩니다' };
  return startCopy({
    accountId: v.accountId,
    view: { subject: v.subject, to: v.to, cc: v.cc, text: v.text, html: v.html },
    files: slot.files
  });
});

// 쓰다 말은 것을 계속 적어둔다. 화면이 손이 멈출 때마다 보낸다 —
// 창을 닫았거나 앱이 죽어도 다음에 새 메일을 열면 그대로 나온다.
ipcMain.on('compose:draft-save', (_e, d) => {
  try { store.setMailDraft(d || null); } catch (err) { evlog.log('메일', `임시 저장 실패 — ${err.message}`); }
});
ipcMain.on('compose:draft-clear', () => store.clearMailDraft());

/**
 * 쓰기 창이 물어볼 것들.
 * 브라우저 confirm은 테두리 없는 창에서 동떨어지게 뜨고 버튼이 둘뿐이다.
 * 닫기는 세 갈래길이다 — 저장 / 버림 / 계속 쓰기.
 */
ipcMain.handle('compose:ask', async (_e, kind) => {
  const win = composeWin && !composeWin.isDestroyed() ? composeWin : undefined;
  if (kind === 'replace') {
    // «임시 저장하고 열기»는 여기서 넣지 않는다 — 칸이 하나라 새 답장을
    // 치는 순간 그게 덮인다. 할 수 없는 걸 리스트에 두면 그게 거짓말이 된다.
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['버리고 열기', '그만두기'],
      defaultId: 1,
      cancelId: 1,
      title: '메일 쓰기',
      message: '쓰던 글을 버리고 새로 여시겠습니까?',
      detail: '임시 저장은 한 통뿐이라 새 글을 쓰기 시작하면 지금 글은 사라집니다.\n'
        + '지금 글을 지키려면 «그만두기»를 누르고 먼저 보내거나 닫으세요.'
    });
    return response === 0 ? 'discard' : 'cancel';
  }
  if (kind === 'discard') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['버리기', '그만두기'],
      defaultId: 1,
      cancelId: 1,
      title: '새로 쓰기',
      message: '이어쓰던 글을 버릴까요?',
      detail: '빈 메일로 시작합니다. 버린 글은 되돌릴 수 없습니다.'
    });
    return response === 0 ? 'discard' : 'cancel';
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['임시 저장', '저장 안 함', '계속 쓰기'],
    defaultId: 0,
    cancelId: 2,
    title: '메일 쓰기',
    message: '쓰다 만 메일을 임시 저장할까요?',
    detail: '저장하면 다음에 «쓰기»를 누를 때 이어서 씁니다.'
  });
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
});

ipcMain.handle('compose:data', () => composePayload);
ipcMain.on('compose:close', () => composeWin && !composeWin.isDestroyed() && composeWin.close());
/**
 * 화면이 «갈아끼워도 좋다»고 하면 그때 초안을 바꾼다.
 * 실어둔 첨부도 바로 이 순간에 확정한다 — payload와 짝을 맞춰야, «유지»를 골랐을 때
 * 옛 초안이 제 첨부를 그대로 들고 있게 된다.
 */
ipcMain.on('compose:accept-replace', (_e, payload) => {
  composePayload = payload;
  composeCarried = pendingCarried;
  pendingCarried = [];
});
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

ipcMain.handle('compose:send', async (_e, msg) => {
  // 화면 쪽 잠금이 풀린 틈에 두 번 들어와도 두 번 나가지 않게 한다
  if (sendingNow) return { ok: false, message: '이미 보내는 중입니다' };
  const acc = mailAccountsForUse().find((a) => a.id === (composePayload && composePayload.accountId));
  if (!acc) return { ok: false, message: '계정을 찾을 수 없습니다' };

  const picked = (msg && msg.attachments) || [];
  // 복사(다시 보내기)로 실어둔 것은 id로 안다 — 바이트는 메인에만 있다.
  const carriedById = new Map((composeCarried || []).map((f) => [f.id, f]));
  const outAtts = [];
  let bytes = 0;
  for (const a of picked) {
    if (a && a.carried) {
      // 화면이 준 것은 «이 id를 보내달라»는 표시뿐이다. 실물은 메인에서 꺼낸다 —
      // 화면이 뚫려도 우리가 실어둔 것만 나간다.
      const f = carriedById.get(a.id);
      if (!f) return { ok: false, message: '복사한 첨부를 찾지 못했습니다 (다시 열어주세요)' };
      outAtts.push({ filename: f.filename, content: f.content });
      bytes += f.size || (f.content ? f.content.length : 0);
    } else {
      // 대화상자로 사용자가 직접 고른 것만. 화면이 준 경로를 그대로 믿지 않는다.
      if (!attachOk.has(a && a.path)) {
        return { ok: false, message: '첨부는 «파일 첨부»로 고른 것만 보낼 수 있습니다' };
      }
      outAtts.push({ path: a.path, filename: a.filename });
      try { bytes += fs.statSync(a.path).size; } catch { /* 없으면 보낼 때 걸린다 */ }
    }
  }
  if (bytes > ATTACH_MAX) {
    return { ok: false, message: `첨부가 너무 큽니다 (${Math.round(bytes / 1048576)}MB · 최대 25MB)` };
  }

  sendingNow = true;
  let r;
  try {
    r = await send.sendMail(acc, { ...msg, attachments: outAtts });
  } finally {
    sendingNow = false;
  }
  evlog.log('메일', r.ok
    ? `보냄 · ${r.accepted}명${r.rejected && r.rejected.length ? ` · 거절 ${r.rejected.join(',')}` : ''}`
      + `${r.sentBox ? ` · 보낸편지함(${r.sentBox})에 저장` : ''}`
    : `보내기 실패 · ${r.message}`);
  if (r.ok) {
    // 보낸 주소는 다음부터 자동완성된다 — 주소록을 손으로 채우게 하면 아무도 안 채운다.
    // 받은 것보다 무겁게 센다: 내가 답장한 사람이 진짜 아는 사람이다.
    // 소식지는 매일 오지만 나는 한 번도 답하지 않는다.
    store.rememberContacts([
      ...send.addresses(msg.to), ...send.addresses(msg.cc), ...send.addresses(msg.bcc)
    ].map((a) => ({ address: a.replace(/^.*<|>.*$/g, '').trim(), name: '' })), { weight: 5 });
    // 나갔으면 임시 저장은 지운다 — 안 그러면 다음에 «쓰기»를 눌렀을 때
    // 방금 보낸 메일이 그대로 다시 떠서 두 번 보내게 된다.
    store.clearMailDraft();
    refreshMail();
  }
  return r;
});

/**
 * 목록에서 오른쪽 클릭 — 여기가 규칙을 만드는 주된 길이다.
 *
 * 설정 화면에 들어가 조건을 손으로 적게 하면 아무도 안 쓴다.
 * 「이 광고 또 왔네」 하는 그 순간에 두 번 눌러 끝나야 한다.
 *
 * HTML 메뉴가 아니라 진짜 메뉴를 쓴다 — 위젯은 작고 테두리가 없어서
 * 직접 그리면 창 밖으로 잘린다.
 */
ipcMain.handle('mail:row-menu', async (e, msg) => {
  const win = BrowserWindow.fromWebContents(e.sender);

  // 임시보관함의 줄은 메일이 아니다 — 읽음도 규칙도 뜻이 없다.
  if (msg && msg.draft) {
    Menu.buildFromTemplate([
      { label: '이어서 쓰기', click: () => startCompose({ kind: 'new' }) },
      { type: 'separator' },
      {
        label: '임시 저장 버리기',
        click: async () => {
          const { response } = await dialog.showMessageBox(win || undefined, {
            type: 'question',
            buttons: ['버리기', '그만두기'],
            defaultId: 1,
            cancelId: 1,
            title: '임시보관함',
            message: '쓰다 만 글을 버릴까요?',
            detail: '되돌릴 수 없습니다.'
          });
          if (response !== 0) return;
          store.clearMailDraft();
          notice('good', '임시 저장을 버렸습니다');
        }
      }
    ]).popup({ window: win || undefined });
    return null;
  }

  if (!msg || !msg.uid) return null;
  const base = mailrules.ruleFor(msg, 'hide');
  const who = base.match || '(보낸사람 모름)';
  const short = who.length > 34 ? who.slice(0, 33) + '…' : who;

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
    items.push(
      { label: `숨기기 — ${short}`, click: () => add('hide') },
      ...(base.domain ? [{ label: `숨기기 — ${base.domain} 전부`, click: () => add('hide', { match: base.domain }) }] : []),
      { label: `알림 안 함 — ${short}`, click: () => add('mute') },
      { label: `자동 읽음 — ${short}`, click: () => add('read') },
      { type: 'separator' },
      {
        // 물어보는 일은 okToSpam 한 곳에서만 한다 — 입구마다 따로 두면 하나씩 빠진다
        label: `스팸으로 보내기 — ${short}`,
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
  Menu.buildFromTemplate(items).popup({ window: win || undefined });
  return null;
});

/** 메일 필터 — 설정 화면과 위젯의 오른쪽 클릭이 함께 쓴다 */
function rulesPayload() {
  return {
    rules: store.mailRules,
    actions: mailrules.ACTION_NAMES,
    filtered: mailState.filtered,
    groups: mailState.groups.map((g) => ({ name: g.name, count: g.items.length }))
  };
}
/**
 * 임시보관함 한 칸.
 *
 * 쓰다 만 글이 «어딘가에 있다»고만 하면 없는 것과 같다.
 * 아웃룭처럼 폴더로 보여야 «여기 있구나»가 된다.
 * 서버의 Drafts가 아니라 이 PC에 적어둔 것이다 — 이 서버는 느려서
 * 손이 멈출 때마다 서버에 올리면 그게 오히려 방해가 된다.
 */
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
function sentFolder() {
  const s = mailState.sent;
  return {
    id: 'sent',
    name: '보낸메일함',
    items: s.messages,
    count: s.messages.length,
    unread: 0,                 // 내가 쓴 메일에 «안 읽음»은 뜻이 없다
    lazy: !s.at,               // 한 번도 안 불러왔다
    loading: s.loading,
    error: s.error
  };
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

// ── 본문 곳간 ────────────────────────────
// 목록을 읽을 때 본문까지 미리 받아둔다. 그래야 메일을 두 번 눌렀을 때 창이
// 곳바로 뜼다 — 이 서버는 본문 한 통에도 몇 초가 걸린다.
const CACHE_DIR = () => path.join(app.getPath('userData'), 'mailcache');
const PREFETCH_MAX = 12;
let prefetching = false;

/** 이 메일의 원문이 이미 디스크에 있나 — 백업본이 먼저다 (같은 것을 두 번 두지 않게) */
function localSource(acc, mailbox, uid) {
  const dir = store.settings.mailBackupDir;
  if (dir && store.settings.mailAutoBackup) {
    const f = mailbackup.savedFile(dir, acc, mailbox || acc.mailbox || 'INBOX', uid);
    if (f) {
      try { return fs.readFileSync(f); } catch { /* 그 사이 지워졌으면 곳간을 본다 */ }
    }
  }
  return mailcache.read(CACHE_DIR(), acc.id, mailbox, uid);
}

/**
 * 본문 한 통 — 디스크에 있으면 거기서, 없으면 서버에서.
 * 읽음 상태는 원문에 없으므로 목록이 아는 값을 넘긴다.
 */
async function localOrServer(acc, msg) {
  const box = msg.mailbox || '';
  const allowRemote = store.settings.mailRemoteImages !== false;
  const src = localSource(acc, box, msg.uid);
  if (src) {
    evlog.log('메일', `본문 · 디스크에서 바로 열음 (uid ${msg.uid})`);
    return mail.viewFromSource(src, {
      uid: msg.uid,
      mailbox: box || acc.mailbox || 'INBOX',
      seen: !!msg.seen,
      receivedAt: msg.at || 0,
      allowRemote
    });
  }
  const got = await mail.fetchBody(acc, msg.uid, { markSeen: false, allowRemote, mailbox: box });
  // 받은 김에 적어둔다 — 같은 메일을 다시 열 때는 서버를 안 부른다
  if (got && got.source) {
    mailcache.write(CACHE_DIR(), acc.id, got.mailbox || box, msg.uid, got.source);
  }
  return got;
}

/**
 * 목록에 있는데 아직 원문이 없는 것들을 뒤에서 받아둔다.
 * 자동 백업이 켜져 있으면 그쪽이 이미 다 받아 놓으므로 여기선 건드리지 않는다.
 */
async function prefetchBodies() {
  if (prefetching) return;
  if (store.settings.mailAutoBackup && store.settings.mailBackupDir) return;
  const dir = CACHE_DIR();
  const byAccount = new Map();
  for (const m of mailState.messages) {
    if (!m.accountId || !m.uid) continue;
    const box = m.mailbox || '';
    if (mailcache.has(dir, m.accountId, box, m.uid)) continue;
    const k = m.accountId + '|' + box;
    if (!byAccount.has(k)) byAccount.set(k, { accountId: m.accountId, mailbox: box, uids: [] });
    const slot = byAccount.get(k);
    if (slot.uids.length < PREFETCH_MAX) slot.uids.push(m.uid);
  }
  if (!byAccount.size) return;

  prefetching = true;
  try {
    for (const slot of byAccount.values()) {
      const acc = mailAccountsForUse().find((a) => a.id === slot.accountId);
      if (!acc) continue;
      try {
        const n = await mail.fetchSources(acc, slot.uids, {
          mailbox: slot.mailbox,
          onOne: (one) => mailcache.write(dir, acc.id, one.mailbox, one.uid, one.source)
        });
        if (n) evlog.log('메일', `본문 미리 받기 · ${n}통`);
      } catch (e) {
        // 미리 받기는 덕이지 의무가 아니다 — 안 되면 열 때 서버를 부르면 그만이다
        evlog.log('메일', `미리 받기 건너뜀 — ${mail.friendly(e)}`);
      }
    }
    mailcache.sweep(dir);
  } finally {
    prefetching = false;
  }
}

/** 화면이 지금 알고 있는 메일 전부 (보이는 것 · 묶인 것 · 숨긴 것 · 보낸 것) */
function knownMessages() {
  return [
    ...mailState.messages,
    ...mailState.groups.flatMap((g) => g.items),
    ...mailState.folders.filter((f) => f.id === 'hidden').flatMap((f) => f.items),
    ...mailState.sent.messages
  ];
}

/** 지금 받아둔 것 중 이 조건에 걸리는 메일 — 규칙을 만들기 전에 보여준다 */
function wouldHit(rule) {
  const all = [
    ...mailState.messages,
    ...mailState.groups.flatMap((g) => g.items),
    ...mailState.folders.filter((f) => f.id === 'hidden').flatMap((f) => f.items)
  ];
  return all.filter((m) => mailrules.hits({ ...rule, on: true }, m));
}

/**
 * «스팸으로»는 서버에서 메일을 옮긴다 — 웹메일에서도 사라진다.
 * 그래서 규칙이 어디서 만들어지든 이 문을 지나야 한다. 확인을 화면 쪽에 두면
 * 입구가 늘 때마다 빠뜨리게 된다 — 실제로 설정 화면 쪽이 그렇게 빠져 있었다.
 *
 * 조건이 얼마나 넓은지도 여기서 같이 보여준다. «제목에 안내»처럼 무심코 적은 한 마디가
 * 사내 공지까지 쓸어가는데, 숫자를 보기 전에는 그걸 알 방법이 없다.
 */
/**
 * 휴지통으로 옮긴다.
 *
 * 물어보고 옮긴다 — 목록에서 오른쪽 클릭 한 번으로 메일이 사라지면, 잘못 눌렀을 때
 * «방금 뭐가 없어졌지»가 된다. 다만 겁주지는 않는다: 휴지통에 남으므로 되찾을 수 있다.
 * 그 사실을 대화상자에 적어 둔다.
 */
async function doTrash(msg, parent) {
  const acc = mailAccountsForUse().find((a) => a.id === msg.accountId);
  if (!acc) {
    notice('bad', '이 메일의 계정을 쓸 수 없습니다');
    return { moved: false, message: '이 메일의 계정을 쓸 수 없습니다' };
  }

  const { response } = await dialog.showMessageBox(parent || undefined, {
    type: 'question',
    buttons: ['휴지통으로', '그만두기'],
    defaultId: 1,
    cancelId: 1,
    title: '휴지통으로 옮기기',
    message: String(msg.subject || '(제목 없음)').slice(0, 60),
    detail: '서버의 휴지통으로 옮깁니다 — 웹메일에서도 받은편지함에서 사라집니다.\n'
      + '완전히 지우는 것이 아니라, 휴지통에서 되찾을 수 있습니다.'
  });
  if (response !== 0) return { moved: false, cancelled: true };

  notice('wait', '휴지통으로 옮기는 중…');
  try {
    const r = await mail.moveToTrash(acc, [msg.uid], { mailbox: msg.mailbox || '' });
    if (r.already) {
      notice('', '이미 휴지통에 있습니다');
      return { moved: false, already: true, message: '이미 휴지통에 있습니다' };
    }
    evlog.log('메일', `휴지통으로 · ${r.moved}통 · ${r.mailbox}`);
    notice('good', `휴지통으로 옮겼습니다 (${r.mailbox})`);
    // 목록 갱신은 기다리지 않는다 — 느린 서버에서 몇십 초다.
    // 옮겼다는 사실은 여기서 이미 확정이므로 부르는 쪽은 이 반환값을 믿으면 된다.
    refreshMail({ force: true });
    return { moved: true, mailbox: r.mailbox };
  } catch (e) {
    // 휴지통을 못 찾았거나 서버가 거부한 경우 — 지운 척하지 않는다
    evlog.log('메일', `휴지통 실패 · ${e.message}`);
    const message = mail.friendly(e);
    notice('bad', message);
    return { moved: false, message };
  }
}

async function okToSpam(rule, parent) {
  if (!rule || rule.action !== 'spam' || rule.on === false) return true;
  const caught = wouldHit(rule);
  const sample = caught.slice(0, 3).map((m) => ' · ' + String(m.subject || '(제목 없음)').slice(0, 46));
  const { response } = await dialog.showMessageBox(parent || undefined, {
    type: 'warning',
    buttons: ['스팸으로', '그만두기'],
    defaultId: 1,
    cancelId: 1,
    title: '스팸으로 보내기',
    message: caught.length
      ? `지금 받아둔 메일 중 ${caught.length}통이 이 조건에 걸립니다.`
      : '지금 받아둔 메일 중에는 걸리는 것이 없습니다.',
    detail: (sample.length ? sample.join('\n') + '\n\n' : '')
      + `조건: ${mailrules.describe(rule)}\n\n`
      + '화면에서만 숨기는 것이 아니라 서버의 스팸 폴더로 옮깁니다.\n'
      + '지금 있는 것과 앞으로 오는 것 모두 옮겨지고, 웹메일에서도 사라집니다.'
  });
  return response === 0;
}

ipcMain.handle('mail:rules', () => rulesPayload());
ipcMain.handle('mail:rule-add', async (e, rule) => {
  if (!await okToSpam(rule, BrowserWindow.fromWebContents(e.sender))) return rulesPayload();
  store.addMailRule(rule || {});
  forgetRuleWork();
  // 방금 만든 규칙이 지금 목록에 바로 먹히게 한다 — 다음 주기(몇 분)를 기다리면 «안 됐네» 싶다
  await refreshMail({ force: true });
  return rulesPayload();
});
ipcMain.handle('mail:rule-update', async (e, { id, patch } = {}) => {
  // 꺼둔 스팸 규칙을 다시 켜는 것도 «지금부터 옮긴다»와 같은 일이다
  const now = store.mailRules.find((r) => r.id === id);
  const after = { ...(now || {}), ...(patch || {}) };
  const wakingUp = after.action === 'spam' && after.on !== false && (!now || now.on === false);
  if (wakingUp && !await okToSpam(after, BrowserWindow.fromWebContents(e.sender))) {
    return rulesPayload();
  }
  store.updateMailRule(id, patch || {});
  forgetRuleWork();
  await refreshMail({ force: true });
  return rulesPayload();
});
ipcMain.handle('mail:rule-remove', async (_e, id) => {
  store.removeMailRule(id);
  forgetRuleWork();
  await refreshMail({ force: true });
  return rulesPayload();
});

/** 주소록 — 쓰기 창의 자동완성과 설정 화면이 쓴다 */
ipcMain.handle('mail:contacts', () => store.contacts);
ipcMain.handle('mail:contact-save', (_e, c) => store.saveContact(c || {}));
ipcMain.handle('mail:contact-remove', (_e, address) => store.removeContact(address));

/**
 * 주소록 가져오기 — 아웃룭·구글·엑셀이 내보낸 CSV를 그대로 받는다.
 * 덮어쓰지 않고 합친다 — 이미 있는 사람은 이름만 채워 넣는다.
 * 지우지는 않는다: 가져오기로 주소록이 줄어들면 되돌릴 길이 없다.
 */
ipcMain.handle('mail:contacts-import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin || undefined, {
    title: '주소록 불러오기',
    filters: [{ name: '주소록 (CSV)', extensions: ['csv', 'txt'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true, contacts: store.contacts };

  let raw;
  try {
    raw = fs.readFileSync(filePaths[0]);
  } catch (e) {
    return { ok: false, message: `파일을 읽지 못했습니다 — ${e.message}`, contacts: store.contacts };
  }
  if (raw.length > 8 * 1024 * 1024) {
    return { ok: false, message: '파일이 너무 큽니다 (8MB까지)', contacts: store.contacts };
  }

  const { text, encoding } = contactcsv.decode(raw);
  const r = contactcsv.toContacts(text);
  if (!r.contacts.length) {
    return {
      ok: false,
      message: r.total
        ? `주소를 찾지 못했습니다 — ${r.total}줄을 봤지만 메일 주소가 없었습니다`
        : '빈 파일입니다',
      contacts: store.contacts
    };
  }

  const before = new Set(store.contacts.map((c) => c.address));
  for (const c of r.contacts) {
    // 이름 없는 줄이 이미 있던 이름을 지우면 안 된다. saveContact는 준 값을 그대로
    // 덮어쓰므로, 빈 이름이면 있던 것을 그대로 다시 넣는다.
    const had = store.contacts.find((x) => x.address === c.address);
    store.saveContact({ address: c.address, name: c.name || (had && had.name) || '' });
  }
  const added = store.contacts.filter((c) => !before.has(c.address)).length;
  const updated = r.contacts.length - added;

  evlog.log('메일', `주소록 가져오기 · ${encoding} · 새로 ${added} · 이미있음 ${updated}`
    + (r.skipped ? ` · 버림 ${r.skipped}` : ''));

  return {
    ok: true,
    contacts: store.contacts,
    added,
    updated,
    skipped: r.skipped,
    encoding,
    message: `${added}명 넣음`
      + (updated ? ` · ${updated}명은 이미 있어 이름만 갱신` : '')
      + (r.skipped ? ` · ${r.skipped}줄은 주소가 없어 건너뜀` : '')
      + (encoding === 'cp949' ? ' · CP949로 읽음' : '')
  };
});

/** 주소록 내보내기 — 엑셀이 한글을 제대로 열도록 BOM을 붙인 UTF-8 */
ipcMain.handle('mail:contacts-export', async () => {
  const list = store.contacts;
  if (!list.length) return { ok: false, message: '내보낼 주소가 없습니다' };

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const { canceled, filePath } = await dialog.showSaveDialog(settingsWin || undefined, {
    title: '주소록 내보내기',
    defaultPath: `Hibi 주소록 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.csv`,
    filters: [{ name: '주소록 (CSV)', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(filePath, contactcsv.encode(contactcsv.fromContacts(list)));
  } catch (e) {
    return { ok: false, message: `저장하지 못했습니다 — ${e.message}` };
  }
  evlog.log('메일', `주소록 내보내기 · ${list.length}명 → ${filePath}`);
  return { ok: true, path: filePath, count: list.length, message: `${list.length}명 내보냈습니다` };
});

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

  // 폴더를 못 쓰면 10분마다 같은 실패를 반복해봐야 아무것도 안 바뀐다.
  // 한 번 알리고 멈춘다 — 폴더를 다시 고르면 그때 풀린다.
  const bad = backupDirProblem(dir);
  if (bad) {
    if (autoBackup.error !== bad) {
      autoBackup.error = bad;
      evlog.log('메일', `자동 백업 멈춤 · ${bad}`);
    }
    return;
  }

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
/**
 * 메일 보기 창들.
 *
 * 예전엔 하나였다 — 두 번째 메일을 열면 앞에 보던 것이 그 자리에서 바뀌어
 * 둘을 나란히 놓고 볼 수가 없었다. 이젠 창마다 제 메일을 든다.
 *
 * 상태를 전역으로 두면 두 창이 같은 칸을 밟는다 — 열쇠는 그 창의 webContents id다.
 * 물어보는 쪽(mail:view-data, 첨부 저장, 크기 조절)은 전부 e.sender로 자기 칸을 찾는다.
 */
const mailWins = new Map();   // webContents.id → { win, payload, files, seq, size }
// 한 번에 열 수 있는 창 수. 실수로 목록을 드로그하듯 눌러도 화면이 안 덮이게.
const MAIL_WIN_MAX = 8;
let mailViewSize = null;     // 마지막으로 조절한 크기 (다음에 열 때 이 크기로)

/** 그 창의 칸 — IPC는 전부 이걸로 자기 것을 찾는다 */
function slotOf(e) {
  return e && e.sender ? mailWins.get(e.sender.id) : null;
}

/** 제일 오래전에 열린 창 — 상한을 넘길 때 이걸 닫는다 */
function oldestMailWin() {
  let found = null;
  for (const slot of mailWins.values()) {
    if (!found || slot.at < found.at) found = slot;
  }
  return found;
}

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

let mailViewSeq = 0;   // 늦게 도착한 예전 요청이 지금 보고 있는 메일을 덤어쓰지 못하게

/**
 * 새 창을 어디에 놓을까 — 정확히 같은 자리에 곹쳐 띄우면 둘이 하나처럼 보인다.
 * 이미 열린 창이 있으면 그 옆으로 조금씩 비쪨 놓는다 (윈도우 기본 동작과 같은 모양).
 */
function cascadeFrom(width, height) {
  const last = [...mailWins.values()].sort((x, y) => y.at - x.at)[0];
  if (!last || !last.win || last.win.isDestroyed()) return {};
  const b = last.win.getBounds();
  const step = 28;
  let x = b.x + step;
  let y = b.y + step;
  try {
    const area = screen.getDisplayMatching(b).workArea;
    // 화면 밖으로 나가면 다시 왼쪽 위로 돌아온다
    if (x + width > area.x + area.width || y + height > area.y + area.height) {
      x = area.x + step;
      y = area.y + step;
    }
  } catch { /* 모니터를 못 읽으면 그냥 비쪨만 */ }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 메일 한 통을 새 창으로 열어 보여준다.
 * 같은 메일을 또 열면 새 창을 만들지 않고 그 창을 앞으로 가져온다 —
 * 같은 글이 두 번 떠 있을 이유가 없다.
 */
function openMailView(msg) {
  const acc = mailAccountsForUse().find((a) => a.id === msg.accountId);

  // 이미 그 메일을 보고 있으면 그 창을 올린다
  const key = `${msg.accountId}:${msg.mailbox || ''}:${msg.uid}`;
  for (const slot of mailWins.values()) {
    if (slot.key !== key || !slot.win || slot.win.isDestroyed()) continue;
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.moveTop();
    slot.win.focus();
    return true;
  }

  // 너무 많이 쌓이면 제일 오래된 것부터 닫는다
  while (mailWins.size >= MAIL_WIN_MAX) {
    const old = oldestMailWin();
    if (!old || !old.win || old.win.isDestroyed()) break;
    old.win.close();
    mailWins.delete(old.id);
  }

  const saved = store.settings.mailViewSize;
  const cap = mailViewMax(null);
  const width = Math.round(clamp((saved && saved.width) || 420 + PAD, 320, cap.width));
  const height = Math.round(clamp((saved && saved.height) || 480 + PAD, 260, cap.height));

  const win = new BrowserWindow({
    width, height, minWidth: 320, minHeight: 260,
    ...cascadeFrom(width, height),
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

  const id = win.webContents.id;
  const slot = {
    id, win, key,
    payload: null,
    files: [],
    seq: ++mailViewSeq,
    size: { width: win.getSize()[0], height: win.getSize()[1] },
    at: Date.now()
  };
  mailWins.set(id, slot);

  // 계정을 못 찾으면 그냥 실패시킨다. 예전에는 첫 계정으로 넘어갔는데,
  // 그러면 엉뚜한 계정에서 같은 번호의 메일을 열고 읽음 표시까지 해 버린다.
  if (!acc) {
    slot.payload = { error: '이 메일의 계정을 찾을 수 없습니다' };
  } else {
    // 본문을 받아오는 동안 창을 먼저 띄운다 — 클릭했는데 한참 아무 일도 없으면 고장 같다.
    // 열었다고 바로 읽음으로 바꾸지 않는다. 창의 «안 읽음» 칩을 눌러 사용자가 정한다.
    localOrServer(acc, msg)
      .then((m) => {
        // 원문 버퍼는 화면으로 보내지 않는다 — 백업에만 쓰고 여기서 떼어낸다
        const { source, ...forView } = m;
        autoBackupOne(acc, { ...forView, source });
        if (win.isDestroyed()) return;      // 받는 사이에 닫았으면 버린다
        slot.files = m.attachments || [];
        slot.payload = {
          ...forView,
          accountId: acc.id,
          // 내가 쓴 메일이면 «답장»을 감춘다 — 나에게 답장이 가는 건 뜻이 없다
          fromSelf: !!msg.fromSelf,
          // 방금 바꿔둔 값이 있으면 그것이 먼저다. 서버는 아직 옷 값을 말할 수 있는데,
          // 그걸 그대로 보여주면 «분명히 읽음으로 바꾸었는데 다시 열면 안 읽음»이 된다.
          seen: seenMarks.seenOf({ accountId: acc.id, mailbox: forView.mailbox, uid: msg.uid }, forView.seen),
          attachments: mail.attachmentsForView(slot.files)
        };
        refreshMail();
      })
      .catch((e) => {
        if (win.isDestroyed()) return;
        slot.payload = { error: mail.friendly(e) };
      });
  }

  // 메일 본문은 남이 쓴 것이다. 그 안의 링크로 이 창이 이동해 버리면 그 사이트가
  // preload 다리(메일 보내기·파일 첨부)를 그대로 쥐다. 창은 우리 페이지에 못박고
  // 바깥 주소는 기본 브라우저로 보낸다.
  lockToOurPage(win);
  win.loadFile(page('mailview.html'), {
    query: glassQuery({ radius: '20',
      remote: store.settings.mailRemoteImages !== false ? '1' : '' })
  });
  win.on('closed', () => { mailWins.delete(id); });
  return true;
}

ipcMain.handle('mail:open', (_e, msg) => openMailView(msg));
/** 렌더러가 본문을 달라고 하면, 도착할 때까지 잠깐 기다렸다 준다 */
ipcMain.handle('mail:view-data', async (e) => {
  const slot = slotOf(e);
  if (!slot) return { error: '창을 찾지 못했습니다' };
  for (let i = 0; i < 60 && !slot.payload; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return slot.payload || { error: '시간이 초과되었습니다' };
});
ipcMain.on('mail:view-close', (e) => {
  const slot = slotOf(e);
  if (slot && !slot.win.isDestroyed()) slot.win.close();
});

/** 첨부 저장 — 어디에 저장할지는 사용자가 고른다 */
ipcMain.handle('mail:save-attachment', async (e, index) => {
  // 첨부는 창마다 따로 든다 — 전역 목록을 쓰면 두 번째 창을 연 순간
  // 첫 창의 «첨부 저장»이 엉뚱한 파일을 내놓는다.
  const slot = slotOf(e);
  const a = slot && slot.files[index];
  if (!a || !a.content) return { ok: false, message: '첨부를 찾을 수 없습니다' };
  const { canceled, filePath } = await dialog.showSaveDialog(slot.win || undefined, {
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

/**
 * 첨부 미리보기 — 저장하지 않고 그 자리에서 본다.
 *
 * 그림은 이미 창이 data:로 그리고 있으므로 여기 오지 않는다.
 * 글은 글자로 풀어 돌려주고, PDF는 크로미움 뷰어를 띄운다.
 * 열 수 없는 것은 그렇다고 말한다 — 눌렀는데 아무 일도 없는 게 제일 나쁘다.
 */
const PREVIEW_DIR = () => path.join(app.getPath('userData'), 'preview');
const pdfWins = new Set();

ipcMain.handle('mail:preview-attachment', async (e, index) => {
  const slot = slotOf(e);
  const a = slot && slot.files[index];
  if (!a || !a.content) return { kind: 'none', message: '첨부를 찾을 수 없습니다' };

  const kind = preview.kindOf(a);
  if (kind === 'toobig') {
    return { kind: 'none', message: '파일이 커서 미리보기를 건너뜁니다 — 저장한 뒤 열어주세요' };
  }
  if (kind === 'none') {
    return { kind: 'none', message: '이 형식은 미리보기를 못 합니다 — 저장한 뒤 열어주세요' };
  }

  if (kind === 'text') {
    // 한국어 윈도우에서 만든 텍스트는 CP949인 경우가 많다 — 주소록에서 쓰던 판별을 그대로 쓴다.
    // HTML이어도 글자로만 돌려준다. 첨부로 온 HTML을 그려주면 그건 남의 페이지를 여는 것이다.
    const { text, encoding } = contactcsv.decode(a.content);
    return { kind: 'text', text, encoding, filename: a.filename };
  }

  if (kind === 'image') {
    // 목록에는 그림을 다 실어 보내지 않는다 — 본문에 박힌 것과 아주 큰 것은 dataUrl이 없다
    // (본문이 밀리고 틱마다 무거워진다). 그래서 눌렀을 때 여기서 만들어 준다.
    //
    // 이 갈래가 없어서 그림이 아래 PDF 길로 흘러들어갔다. PNG를 .pdf로 써서 열었으니
    // 크로미움이 «PDF 문서를 로드하지 못했습니다»라고 할 수밖에 없었다.
    return {
      kind: 'image',
      dataUrl: `data:${a.contentType || 'image/png'};base64,${a.content.toString('base64')}`,
      filename: a.filename
    };
  }

  // 여기까지 왔는데 PDF가 아니면 아래로 흘려보내지 않는다 — 아는 것만 연다.
  // (새 형식이 kindOf에 늘어도 조용히 PDF로 열리는 일이 없게)
  if (kind !== 'pdf') {
    return { kind: 'none', message: '이 형식은 미리보기를 못 합니다 — 저장한 뒤 열어주세요' };
  }

  // PDF — 임시 파일로 떨구고 크로미움 뷰어로 연다
  const dir = PREVIEW_DIR();
  const file = preview.tempPathFor(dir, a, '.pdf');
  if (!file) return { kind: 'none', message: '미리보기 파일을 만들지 못했습니다' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, a.content);
  } catch (err) {
    return { kind: 'none', message: `미리보기 파일을 쓰지 못했습니다 — ${err.message}` };
  }

  const win = new BrowserWindow({
    width: 900, height: 1000,
    title: a.filename || '첨부 미리보기',
    backgroundColor: '#2b2b2b',
    // 이 창에는 다리를 놓지 않는다 — 남이 보낸 파일을 여는 창이다
    webPreferences: { preload: undefined, nodeIntegration: false, contextIsolation: true, sandbox: true, plugins: true }
  });
  pdfWins.add(win);
  // 이 창은 그 파일에서 절대 벗어나지 않는다
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, url) => {
    if (url !== `file:///${file.replace(/\\/g, '/')}`) ev.preventDefault();
  });
  win.on('closed', () => {
    pdfWins.delete(win);
    // 본 뒤에는 남겨두지 않는다 — 첨부가 임시 폴더에 쌓이면 그것대로 새는 길이다
    try { fs.unlinkSync(file); } catch { /* 이미 없으면 그만 */ }
  });
  win.loadFile(file);
  evlog.log('메일', `첨부 미리보기 · ${a.filename}`);
  return { kind: 'pdf', filename: a.filename };
});

/** 저장한 첨부를 탐색기에서 보여준다 */
ipcMain.on('mail:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });

/** 메일 보기 창 크기 조절 — 위젯과 같은 방식(기준 크기를 못박아 되먹임을 끊는다) */
ipcMain.on('mailview:move', (e, { x, y }) => {
  const slot = slotOf(e);
  if (!slot || slot.win.isDestroyed() || !slot.size) return;
  // setPosition은 배율이 100%가 아닐 때 호출마다 창을 부풀린다 — 크기를 못박아 옮긴다
  slot.win.setBounds({ x: Math.round(x), y: Math.round(y), ...slot.size });
});

ipcMain.handle('mailview:bounds', (e) => {
  const slot = slotOf(e);
  if (!slot || slot.win.isDestroyed()) return { x: 0, y: 0, width: 420, height: 480 };
  return slot.win.getBounds();
});
/**
 * 얼마나 크게 늘릴 수 있나. 고정 숫자로 막으면 큰 화면에서 답답하다 —
 * 그 창이 놓인 모니터의 작업 영역만큼 허용한다.
 * 창에는 그림자 여백(PAD)이 붙어 있으므로 그만큼 더해야 보이는 카드가 화면을 꽉 채운다.
 */
function mailViewMax(win) {
  try {
    const d = win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay();
    return { width: d.workAreaSize.width + PAD, height: d.workAreaSize.height + PAD };
  } catch {
    return { width: 2400, height: 1600 };
  }
}

ipcMain.on('mailview:set-bounds', (e, { x, y, width, height, dir }) => {
  const slot = slotOf(e);
  if (!slot || slot.win.isDestroyed()) return;
  const max = mailViewMax(slot.win);
  const w = Math.round(clamp(width, 320, max.width));
  const h = Math.round(clamp(height, 260, max.height));
  const nx = Math.round(String(dir).includes('w') ? x + (width - w) : x);
  const ny = Math.round(String(dir).includes('n') ? y + (height - h) : y);
  slot.size = { width: w, height: h };
  slot.win.setBounds({ x: nx, y: ny, width: w, height: h });
  // 마지막으로 조절한 크기를 다음 창의 기본으로 쓴다
  mailViewSize = slot.size;
  store.setSettings({ mailViewSize });
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

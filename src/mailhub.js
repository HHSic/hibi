// 메일 — 받아오기·규칙·알림·창에 답하기.
//
// 이 앱에서 가장 큰 계통이다. main.js 안에 두 덩이로 흩어져 있던 것을 한곳에 모았다
// (상태·규칙·적재가 앞쪽에, 화면에 답하는 IPC 가 뒤쪽에 있었다).
//
// 여기 있는 것:
//   · 계정별 받은편지함·보낸편지함 상태와 «더 보기» 적재
//   · 서버 규칙 돌리기(runServerRules)와 그 재시도
//   · 새 메일 알림 모으기(mailAnnounce/announceMail)
//   · 설정·위젯·메일 창이 물어보는 IPC 스물 몇 개
//
// 위젯 창·설정 창·공유 상태·방해 금지 판정은 main.js 가 들고 있다.
// 순환 require 를 피하려고 시작할 때 init(host) 로 받아 둔다 — 다른 모듈과 같은 방식이다.

const { BrowserWindow, ipcMain, screen, Notification } = require('electron');

const store = require('./store');
const evlog = require('./evlog');
const secret = require('./secret');
const mail = require('./mail');
const mailrules = require('./mailrules');
const mailmark = require('./mailmark');
const mailtally = require('./mailtally');
const { askUser, pickFromMenu } = require('./popup');
const { startCompose, startCopy } = require('./composewin');
const { prefetchBodies, knownMessages } = require('./mailbody');
const { okToSpam } = require('./mailfilter');
const { doTrash } = require('./mailwin');
const { autoBackupNew } = require('./backup');

let host = {
  state: { onBreak: false, paused: false },
  widgetWin: () => null,
  openSettings: () => {},
  revealWidget: () => {},
  holdReason: () => null
};
function init(h) { host = { ...host, ...h }; }

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
  if (host.state.onBreak || host.state.paused) return;
  if (host.holdReason(0)) return;          // 방해 금지 — 끝난 뒤에 알린다 (pending은 그대로 남는다)

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
    host.revealWidget();
    const w = host.widgetWin();
    if (w && !w.isDestroyed()) w.webContents.send('mail:show');
  });
  n.show();
}

/**
 * 지금 알림을 띄우면 안 되는 이유가 있으면 문자열로, 없으면 null.
 * 전체화면·발표·집중지원과 캘린더 일정을 함께 본다.
 * 매 초 네이티브 호출을 반복하지 않도록 잠깐 캐시한다.
 */

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
    { label: '필터 관리…', click: () => host.openSettings() }
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

module.exports = {
  init,
  // 바깥이 부르는 것들
  refreshMail, announceMail, forgetRuleWork, mailAccountsForUse, notice,
  draftFolders, sentFolders,
  // 상태는 같은 객체를 나눠 쓴다 (다른 창 모듈들이 이걸 그대로 본다)
  mailState, seenMarks
};

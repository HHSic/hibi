// 메일 백업 — 받은 메일을 내 PC 폴더에 파일로 남긴다.
//
// 서버에서 지워져도 내 손에는 남게 하는 것이 목적이다. 그래서 저장은 «되는 만큼»
// 조용히 해 두고, 실패해도 메일 보기를 막지 않는다.
//
// 바깥에는 «한 통 저장»과 «새로 온 것 저장» 둘만 내준다.
// 나머지(폴더 고르기·전체 저장·진행 상황)는 여기서 IPC로 직접 받는다.
//
// «서버 정리»(PC에 저장이 확인된 오래된 메일을 서버 휴지통으로 옮기기)도 여기서 언제 돌릴지 정한다.
// 옮길지 말지 따지는 일은 src/mailtidy.js 가 하고, 여기는 잠금·확인 창·상태만 맡는다 —
// 백업과 같은 폴더·같은 상태 파일을 보므로 둘이 동시에 돌지 않게 하는 자리가 한 곳이어야 한다.

const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const evlog = require('./evlog');
const mail = require('./mail');
const mailbackup = require('./mailbackup');
const mailtidy = require('./mailtidy');
// 이름 공간으로 부른다 (popup.askUser) — 시험이 바꿔 끼울 수 있게
const popup = require('./popup');

// 계정 목록은 main.js 가 들고 있다 (비밀번호를 푸는 곳이 거기다).
// 쓸 계정이 없을 때 할 말도 거기서 받는다 — 꺼짐·비밀번호 못 풂·없음을 가려 말한다.
let host = {
  mailAccountsForUse: () => [],
  noAccountMessage: () => '메일 계정을 지금 쓸 수 없습니다 — 설정 › 메일을 확인하세요',
  // 서버 정리가 메일을 옮겼으면 위젯 목록을 다시 읽는다
  refreshMail: () => {},
  // 서버 정리를 켜는 요청이 설정 창에서 왔나 — 다른 창(위젯·메일 창)은 켤 수 없다
  isSettingsWin: () => false,
  // 그 계정을 아직 써도 되나 — 정리 도중 끄거나 지운 계정은 그 자리에서 멈춘다 (비밀번호를 다시 풀지 않는다)
  accountLive: (acc) => !!acc && store.mailAccounts.some((a) =>
    (a.id || a.user) === (acc.id || acc.user) && a.enabled !== false),
  // 지금 메일 보기 창에 떠 있는 메일들 [{ accountId, mailbox, uid, messageId }] — 서버 정리가 그 메일은 옮기지 않는다
  openMailKeys: () => [],
  // 사용자가 이 앱에서 방금 «안 읽음»으로 되돌린 메일인가 ({ accountId, mailbox, uid }) — mailhub 의 읽음 장부를 본다
  markedUnread: () => false,
  // 자동 전달이 도는 중인가 — 그동안 서버 정리는 시작하지 않는다 (전달이 아직 못 받은 메일을 옮기지 않게)
  forwardBusy: () => false
};

// 서버 정리의 시간표. 시험이 init({ tidyTiming })으로 줄여 쓴다.
const T = {
  GAP_MS: 3 * 3600_000,       // 남은 것이 없으면 3시간 뒤 — 30일 지난 것을 고르는 일이라 자주 볼 까닭이 없다
  MORE_GAP_MS: 20 * 60_000,   // 상한·시간 제한으로 남았으면 20분 뒤
  // «바로»(0일)는 남은 것이 있든 없든 5분 — 읽은 메일을 «바로» 옮긴다고 했는데 3시간을 기다리면 거짓말이 된다.
  // 실제로는 자동 백업 한 바퀴(메일 확인·이 앱에서 읽음 표시 뒤의 목록 다시 읽기) 끝에 붙어 돈다
  QUICK_GAP_MS: 5 * 60_000,
  FIRST_MS: 5 * 60_000,       // 앱을 켜자마자 몰리는 일과 겹치지 않게
  START_MS: 60_000,           // 켠 뒤 첫 정리까지 — 그 사이 끄거나 «백업 시작»을 먼저 누를 수 있게
  AGAIN_MS: 5_000,
  KICK_SLACK_MS: 1_000,       // 예약 타이머는 문(tidyNextAt)보다 이만큼 늦게 — 타이머가 조금 일찍 깨도 문에 막히지 않게
  COUNT_MS: 20_000,           // 확인 창의 «약 n통» 세기 제한
  MAX_MS: 10 * 60_000,        // 한 번 도는 시간 상한 — 넘으면 연결을 끊어 강제로 끝낸다
  STOP_GRACE_MS: 10_000,      // «백업 시작»이 비켜 달라고 한 뒤 강제로 끊기까지
  WAIT_MAX_MS: 5 * 60_000     // «백업 시작»이 정리·자동 백업을 기다리는 최대
};
// 서버 정리의 지금 상태와 이번 앱 실행의 마지막 결과
const tidy = {
  // again: 도는 사이에 켜기·기간 바꾸기가 확인됐다 — 끝난 뒤 againAt 보다 이르지 않게 다시 돈다
  running: false, stop: false, asking: false, again: false, againAt: 0, abort: null,
  // unread: «바로»에서 저장은 됐지만 아직 안 읽어 남긴 수 — 읽으면 다음 정리 때 옮긴다 (남김 경고가 아니다)
  at: 0, moved: 0, kept: 0, unsaved: 0, unverified: 0, spared: 0, unread: 0, skippedBoxes: 0, more: false,
  error: null, total: 0, message: '', messageKind: ''
};
let tidyNextAt = Date.now() + T.FIRST_MS;
let tidyLogSig = '';   // 마지막으로 기록에 적은 정리 결과의 모양 — «바로»가 같은 줄을 5분마다 쌓지 않게
// «바로»가 늘 남기는 메일(Gmail 중요·메모·되찾음·확인 안 됨)의 판정 기억 — 몇 분마다 봉투·헤더를 다시 받지 않게 (mailtidy opts.memo).
// 메모리에만 둔다. 앱을 다시 켜면 한 번 더 받아 볼 뿐이다
const tidyMemo = new Map();

function init(h) {
  host = { ...host, ...h };
  if (h && h.tidyTiming) {
    Object.assign(T, h.tidyTiming);
    tidyNextAt = Date.now() + T.FIRST_MS;
  }
}

// 서버에 있는 메일을 .eml 파일로 내 PC에 내려둔다. 회사를 옮기거나 계정이 닫히면
// 웹메일에 있던 것은 같이 사라진다 — 파일로 남겨두면 그때도 열린다.
// 오래 걸리는 작업이라 상태를 남기고, 설정 화면이 그걸 들여다본다.
const backup = {
  running: false, stop: false,
  account: '', mailbox: '', done: 0, total: 0,
  saved: 0, skipped: 0, message: '', at: 0, dir: null,
  waiting: ''   // 정리·자동 백업이 끝나기를 기다리는 중이면 그 한 줄
};

// 자동 백업은 사용자가 보고 있지 않을 때 도는 일이라 수동 진행률과 섞지 않는다.
// 여기 값만 따로 보여준다 — "언제 몇 통을 저장했는가".
const autoBackup = { at: 0, saved: 0, total: 0, error: null, seeded: 0 };

function backupStatus() {
  return {
    ...backup,
    waiting: backup.waiting || '',
    dir: store.settings.mailBackupDir || null,
    auto: store.settings.mailAutoBackup === true,
    autoAt: autoBackup.at,
    autoSaved: autoBackup.saved,
    autoTotal: autoBackup.total,
    autoSeeded: autoBackup.seeded,
    autoError: autoBackup.error,
    tidy: tidyStatus()
  };
}

/** 설정 화면이 보는 서버 정리 상태. 이번 실행에서 아직 안 돌았으면 저장해 둔 마지막 결과를 쓴다 */
function tidyStatus() {
  const s = store.settings;
  const why = tidyWhy();
  const saved = s.mailTidyLast && typeof s.mailTidyLast === 'object' ? s.mailTidyLast : {};
  const last = tidy.at ? tidy : saved;
  const num = (x) => Number(x) || 0;
  return {
    on: s.mailServerTidy === true,
    days: tidyDays(),
    ready: !why,
    why,
    running: tidy.running,
    asking: tidy.asking,
    at: num(last.at),
    moved: num(last.moved),
    kept: num(last.kept),
    unsaved: num(last.unsaved),
    unverified: num(last.unverified),
    spared: num(last.spared),
    unread: num(last.unread),
    skippedBoxes: num(last.skippedBoxes),
    more: last.more === true,
    error: typeof last.error === 'string' && last.error ? last.error : null,
    total: tidy.total,
    cap: mailtidy.CAP,
    everyMin: tidyEveryMin(),
    message: tidy.message,
    messageKind: tidy.messageKind
  };
}

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

/** 서버 정리가 돌 수 있나 — 자동 백업이 도는 사람만 (정리는 자동 백업 한 바퀴 뒤에 붙어 돈다) */
function tidyOn() {
  return autoBackupOn() && store.settings.mailServerTidy === true;
}

/** 0(바로)·7·30·90 — 0은 거짓 값이라 `|| 30` 으로 다듬으면 안 된다 (normDays 가 목록의 값을 그대로 준다) */
function tidyDays() {
  return mailtidy.normDays(store.settings.mailTidyDays);
}

/** 무엇을 옮기는지 한 마디 — 확인 창·답·기록이 같은 말을 쓰게 */
function tidyWhat(days) {
  return days === 0 ? '읽은 메일' : `받은 지 ${days}일 지난 메일`;
}

const minutesOf = (ms) => Math.max(1, Math.round(ms / 60_000));

/**
 * «바로»가 실제로 몇 분마다 도는지 —정리는 메일 확인(폴링) 끝의 자동 백업에 붙어 돌고, 그 사이 QUICK_GAP_MS 를 둔다.
 * 확인 주기를 30~60분으로 둔 사람에게 «몇 분 안에»라고 하면 거짓말이 된다 — 화면·확인 창이 이 값으로 말한다
 */
function tidyEveryMin() {
  const poll = Number(store.settings.mailPollMin);
  return Math.max(minutesOf(T.QUICK_GAP_MS), Number.isFinite(poll) && poll > 0 ? Math.round(poll) : 10);
}

/** INBOX 는 IMAP 에서 대소문자를 가리지 않는다 — 비교하기 전에 한 모양으로 */
const boxName = (p) => (/^inbox$/i.test(String(p || '')) ? 'INBOX' : String(p || ''));

/**
 * 그 메일이 지금 메일 보기 창에 떠 있나 (main.js 가 mailwin 의 창 목록을 건넨다).
 * «바로»에서는 이 앱으로 읽던 메일이 열어볼 때 저장되고 몇 분 뒤 서버에서 사라질 수 있다 — 창이 떠 있는 동안
 * 옮기면 그 창의 «휴지통»·«읽음» 단추가 이미 옮겨진 UID 를 만진다. 창을 닫은 뒤 다음 정리 때 옮긴다.
 * Gmail 은 같은 메일이 받은편지함과 라벨 폴더에 서로 다른 UID 로 있고, 어느 쪽을 휴지통으로 옮겨도 모든 라벨에서 빠진다 —
 * 그래서 같은 계정에서 Message-ID(sid, mailtidy.normId 모양)가 같으면 폴더와 상관없이 떠 있는 것으로 본다.
 * 묻다가 던지면 mailtidy 가 «떠 있다»(옮기지 않음)로 본다
 */
function inMailView(acc, boxPath, uid, sid = '') {
  const want = boxName(boxPath);
  return (host.openMailKeys() || []).some((k) => !!k && !!acc && k.accountId === acc.id
    && ((boxName(k.mailbox) === want && Number(k.uid) === Number(uid))
      || (!!sid && !!k.messageId && mailtidy.normId(k.messageId) === sid)));
}

/**
 * 사용자가 이 앱에서 방금 «안 읽음»으로 되돌린 메일인가 (main.js 가 mailhub 의 읽음 장부를 건넨다).
 * 느린 서버는 STORE 에 수십 초가 걸린다 — 그 사이 보기 창을 닫으면 서버는 아직 읽음(\Seen)이라 «바로»가 옮겨 버린다.
 * 사용자가 남기려고 되돌린 메일이므로 장부에 «안 읽음» 표시가 있는 동안은 옮기지 않는다 (서버가 따라오면 장부에서 지워진다)
 */
function markedUnread(acc, boxPath, uid) {
  return !!acc && !!host.markedUnread({ accountId: acc.id, mailbox: boxName(boxPath), uid: Number(uid) });
}

/** 정리가 지금 그 메일을 건너뛰어야 하나 — 보기 창에 떠 있거나, «바로»에서 방금 «안 읽음»으로 되돌렸다 */
function holdBack(days, acc, boxPath, uid, sid) {
  return inMailView(acc, boxPath, uid, sid) || (days === 0 && markedUnread(acc, boxPath, uid));
}

/**
 * 서버 정리를 쓸 수 없는 까닭 한 줄 (쓸 수 있으면 '').
 * 설정 값만 본다 — 폴더에 쓸 수 있는지는 상태를 물을 때마다 디스크에 써 봐야 해서 여기서 보지 않는다.
 * 순서는 설정 화면의 자동 백업 줄(paintAuto)과 같다.
 */
function tidyWhy() {
  const s = store.settings;
  if (s.mailAutoBackup !== true) return '«자동으로 백업»을 켜야 쓸 수 있습니다.';
  if (!s.mailBackupDir) return '저장할 폴더를 먼저 골라야 쓸 수 있습니다.';
  if (s.mailEnabled !== true) return '«메일 확인하기»를 켜야 쓸 수 있습니다.';
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 열어본 메일 한 통 — 이미 받아온 원문을 그대로 파일로 남긴다 */
async function autoBackupOne(acc, m) {
  if (!autoBackupOn() || !m || !m.source) return;
  // 전체 백업이 도는 중이면 손대지 않는다. 그쪽은 폴더 목록을 미리 읽어두고 쓰는데
  // 그 사이에 파일을 끼워 넣으면 같은 메일이 두 번 저장된다. 어차피 그쪽이 받아간다.
  // 서버 정리 중에는 저장한다 — 파일 하나를 원자적으로 더할 뿐이고, 정리는 폴더 목록을
  // 찍은 뒤에 생긴 새 파일을 쓰지 않는다 (그 메일은 다음 정리 때 본다).
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
 * 폴링 뒤 — 새로 들어온 것만 받아 둔다. 끝나면 서버 정리가 때가 됐는지 본다.
 * @param now 켜자마자 한 번은 간격을 무시하고 돈다 (그래야 «지금부터»가 진짜 지금이다)
 */
async function autoBackupNew({ now = false } = {}) {
  // 수동 백업이 도는 중이면 비켜준다. 같은 폴더에 둘이 쓰면 서로를 밟는다.
  // 서버 정리 중에도 비켜준다 — 정리는 백업 상태 파일과 폴더를 근거로 옮긴다.
  if (!autoBackupOn() || backup.running || autoBackup.running || tidy.running) return;
  if (!now && Date.now() - autoRunAt < AUTO_GAP_MS) return;
  autoRunAt = Date.now();

  const dir = store.settings.mailBackupDir;
  const accounts = host.mailAccountsForUse();
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
  try {
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
  } finally {
    autoBackup.running = false;
  }
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
  // finally 부터 runTidy 의 tidy.running = true 까지 await 가 없다 — 그래야 수동 백업이 사이에 끼지 못한다
  await runTidy(dir, accounts);
}

/**
 * 서버 정리 한 번. 때가 안 됐거나 다른 일이 돌면 그냥 돌아간다.
 * 한 번은 최대 T.MAX_MS — 느린 서버의 걸린 명령은 확인 지점을 기다리지 않고 연결을 끊어 끝낸다.
 */
async function runTidy(dir, accounts) {
  // 첫 await 전에 자리를 잡는다. autoBackupNew 가 autoBackup.running 을 놓은 바로 그 틱이다
  // 자동 전달이 도는 중이면 이번엔 건너뛴다 — 전달이 받기 전에 받은편지함에서 옮기지 않게 (다음 자동 백업이 다시 본다)
  if (!tidyOn() || tidy.running || backup.running || Date.now() < tidyNextAt || host.forwardBusy()) return;
  tidy.running = true;
  tidy.stop = false;
  tidy.again = false;
  tidy.againAt = 0;
  const days = tidyDays();
  const ctl = new AbortController();
  tidy.abort = () => ctl.abort();
  const hard = setTimeout(() => ctl.abort(), T.MAX_MS);
  let r = null;
  try {
    r = await mailtidy.tidyAll(accounts, dir, {
      days,
      signal: ctl.signal,
      // 계정마다 시간 몫을 따로 준다 — 느린 첫 계정이 상한을 다 써 뒤 계정이 매번 굶지 않게.
      // 바깥 상한(hard)보다 조금 짧게 잡아, 몫을 다 쓴 계정은 «시간 안에 못 끝냄»으로 적히고 다음 계정으로 넘어간다
      budgetMs: Math.round(T.MAX_MS * 0.9),
      accountLive: (acc) => host.accountLive(acc),
      inView: (acc, boxPath, uid, sid) => holdBack(days, acc, boxPath, uid, sid),
      memo: tidyMemo,
      memoMs: T.GAP_MS,
      shouldStop: () => {
        if (tidy.stop || !tidyOn()) return true;
        // 새 설정이 지금 실행이 옮기는 범위를 다 덮지 않으면 지금 묶음까지만 하고 새 설정으로 다시 돈다.
        // «바로»와 기간 정리는 범위가 서로 다르다 — «바로»는 안 읽은 오래된 메일을, 기간 정리는 막 읽은 메일을 옮기지 않는다.
        // 그래서 둘 사이를 오가면 어느 쪽이든 멈춘다 (30일 실행 중 «바로»를 받아들였는데 안 읽은 오래된 메일을 계속 옮기면 안 된다).
        // 기간을 늘린 것도 멈춘다. 기간을 줄인 것(30 → 7)은 지금 실행이 고르는 것이 새 범위 안이라 그대로 둔다
        const cur = tidyDays();
        return cur !== days && (cur === 0 || days === 0 || cur > days);
      }
    });
    Object.assign(tidy, {
      at: Date.now(), moved: r.moved, kept: r.kept, unsaved: r.unsaved, unverified: r.unverified,
      spared: r.spared, unread: r.unread, skippedBoxes: r.skippedBoxes.length, more: r.more, error: r.errors[0] || null
    });
    tidy.total += r.moved;
    // «바로»는 5분마다 돈다 — 옮긴 것 없이 지난번과 같은 남김·오류만 되풀이되면 다시 적지 않는다 (기록이 같은 줄로 차지 않게).
    // 안 읽어 남긴 것(unread)·일부러 남긴 것(spared)만으로도 적지 않는다 — 경고가 아니다
    const sig = [r.kept, r.unsaved, r.unverified, r.unread, r.skippedBoxes.join('|'), r.errors.join('|')].join('/');
    const same = days === 0 && !r.moved && !r.uncertain && sig === tidyLogSig;
    tidyLogSig = sig;
    if (!same && (r.moved || r.kept || r.uncertain || r.errors.length || r.skippedBoxes.length)) {
      evlog.log('메일', mailtidy.maskAddr(`서버 정리 · ${r.moved}통 휴지통으로`
        + (r.uncertain ? ` · 옮기는 중 끊겨 ${r.uncertain}통은 옮겨졌을 수 있음` : '')
        + (r.kept ? ` · 남김 ${r.kept}통 (저장 안 됨 ${r.unsaved} · 확인 안 됨 ${r.unverified})` : '')
        + (r.spared ? ` · 별표·중요 등 ${r.spared}통은 남김` : '')
        + (r.unread ? ` · 안 읽은 ${r.unread}통은 읽을 때까지 남김` : '')
        + (r.more ? ` · 남은 것은 다음에 (한 번에 ${mailtidy.CAP}통까지${r.aborted ? ', 중간에 끊음' : ''})` : '')
        + (r.skippedBoxes.length ? ` · 건너뛴 폴더 ${r.skippedBoxes.slice(0, 5).join(', ')}` : '')
        + (r.errors.length ? ` · 실패 ${r.errors.join(' / ')}` : '')));
    }
  } catch (e) {
    Object.assign(tidy, {
      at: Date.now(), moved: 0, kept: 0, unsaved: 0, unverified: 0, spared: 0, unread: 0, skippedBoxes: 0, more: false,
      error: mailtidy.maskAddr(mail.friendly(e))
    });
    const sig = `실패/${tidy.error}`;
    if (!(days === 0 && sig === tidyLogSig)) evlog.log('메일', `서버 정리 실패 · ${tidy.error}`);
    tidyLogSig = sig;
  } finally {
    clearTimeout(hard);
    tidy.abort = null;
    tidy.running = false;
    tidy.stop = false;
    // 앱을 다시 켜도 설정 화면이 마지막 결과를 보여 주게 남긴다
    store.setGatedSettings({
      mailTidyLast: {
        at: tidy.at, moved: tidy.moved, kept: tidy.kept, unsaved: tidy.unsaved, unverified: tidy.unverified,
        spared: tidy.spared, unread: tidy.unread, skippedBoxes: tidy.skippedBoxes, more: tidy.more, error: tidy.error
      }
    });
    // 정리가 오래 걸렸어도, 끝의 목록 다시 읽기가 자동 백업을 곧바로 한 바퀴 또 돌리지 않게
    autoRunAt = Date.now();
    // 지금 설정으로 간격을 고른다 — 도는 사이 «바로»에서 기간으로 바꿨으면 긴 간격으로 돌아간다
    tidyNextAt = Date.now() + (tidyDays() === 0 ? T.QUICK_GAP_MS : r && r.more ? T.MORE_GAP_MS : T.GAP_MS);
    // 도는 사이에 켜기·기간 바꾸기가 확인됐다 — 새 설정으로 다시 돈다.
    // 켤 때 약속한 유예(«1분쯤 뒤»)가 남아 있으면 그보다 이르지 않게
    if (tidy.again) {
      const wait = Math.max(T.AGAIN_MS, tidy.againAt - Date.now());
      tidy.again = false;
      tidy.againAt = 0;
      kickTidy(wait);
    }
  }
  // 옮긴 메일이 위젯 목록에 남지 않게 다시 읽는다. 옮겼는지 모르는 묶음이 있어도 읽는다. 기다리지 않는다
  if (r && (r.moved > 0 || r.uncertain > 0)) Promise.resolve().then(() => host.refreshMail()).catch(() => {});
}

/**
 * 서버 정리를 ms 뒤에 돌린다 (자동 백업 한 바퀴 뒤에). 도는 중이면 끝난 뒤에 다시.
 * 문(tidyNextAt)도 같은 때로 맞춘다 — 타이머만 늦추고 문을 열어 두면, 그 사이 폴링·메일 창 열기 끝의
 * autoBackupNew()가 곧바로 정리를 돌려 «켜고 1분쯤 뒤에 시작, 그 전에 끄면 아무것도 옮기지 않는다»가 깨진다.
 */
function kickTidy(ms) {
  const at = Date.now() + ms;
  tidyNextAt = at;
  if (tidy.running) {
    tidy.again = true;
    tidy.againAt = Math.max(tidy.againAt, at);
    return;
  }
  const t = setTimeout(() => { autoBackupNew({ now: true }).catch(() => {}); }, ms + T.KICK_SLACK_MS);
  if (t.unref) t.unref();
}

/**
 * 확인 창에 쓸 «약 n통» — 정리와 같은 판정을 읽기 전용으로 돌려 세기만 한다. 최대 ms까지.
 * 늦은 세기는 연결을 끊어 바로 멈춘다 — 켜자마자 도는 백업·폴링과 연결 수를 다투지 않게.
 */
async function countForConfirm(days, ms) {
  const seen = {};
  const ctl = new AbortController();
  let timer;
  let accounts = [];
  // 통째로 실패한 까닭 — 계정별 오류는 tidyAll 안에서 errors 에 쌓이므로, 여기 오는 것은
  // 연결 전 PC 쪽 단계(정리 기록 tidy-moved.json 을 못 읽음·깨짐)뿐이다. 서버 탓으로 말하면 안 된다
  let failed = '';
  try { accounts = host.mailAccountsForUse() || []; } catch { accounts = []; }
  const work = mailtidy.tidyAll(accounts, store.settings.mailBackupDir, {
    days, dryRun: true, cap: Infinity, into: seen, signal: ctl.signal,
    accountLive: (acc) => host.accountLive(acc),
    inView: (acc, boxPath, uid, sid) => holdBack(days, acc, boxPath, uid, sid),
    connect: (acc) => mail.connect(acc, { timeoutMs: ms })
  }).then(() => true, (e) => { failed = mailtidy.maskAddr(mail.friendly(e)); return false; });
  const done = await Promise.race([work, new Promise((r) => { timer = setTimeout(() => r(false), ms); })]);
  clearTimeout(timer);
  ctl.abort();
  return {
    verified: 0, kept: 0, unsaved: 0, unverified: 0, unread: 0, errors: [], accounts: 0, failedAccounts: 0,
    ...seen,
    failed,
    complete: done && seen.complete === true
  };
}

/** 확인 창의 글 — 무엇을, 몇 통, 어디로 옮기는지와 무엇은 남기는지 */
function tidyQuestion(n, { days, from = 30, lowering, countMs, startMs }) {
  const v = Number(n.verified) || 0;
  const errors = Array.isArray(n.errors) ? n.errors : [];
  let message;
  if (n.complete && n.accounts > 0 && n.failedAccounts >= n.accounts) {
    message = `지금은 정리할 수 있는 계정이 없습니다 — ${errors[0] || ''}`;
  } else if (n.complete && n.accounts === 0) {
    message = '지금 쓸 수 있는 메일 계정이 없어 세지 못했습니다.';
  } else if (n.complete && v > 0) {
    message = `${tidyWhat(days)} 약 ${v}통을 서버 휴지통으로 옮깁니다.`;
  } else if (n.complete) {
    message = '지금은 옮길 메일이 없습니다.';
  } else if (v > 0) {
    message = `지금까지 센 ${tidyWhat(days)} ${v}통 — ${countMs / 1000}초 안에 다 세지 못했습니다.`;
  } else {
    message = '몇 통인지 세지 못했습니다.';
  }
  // 휴지통을 저절로 비우지 않는 서버도 있다 — 설정 화면의 «휴지통 자동 비우기를 켜 두세요»와 어긋나지 않게 단정하지 않는다
  const undo = '웹메일·폰에서는 사라지고 PC 사본은 남습니다. 서버 휴지통이 비워지기 전까지 되찾을 수 있습니다. 되찾은 메일은 다시 옮기지 않습니다.';
  // «바로»는 날짜가 아니라 읽음으로 고른다 — 무엇이 언제 사라지고 무엇이 남는지를 먼저 말한다.
  // 언제는 «몇 분 안에»가 아니라 실제 주기로 — 메일 확인 주기를 길게 둔 사람에게는 몇십 분이다
  const detail = days === 0 ? [
    `모든 계정에서 PC에 저장된 읽은 메일만 약 ${tidyEveryMin()}분마다 옮깁니다. 보낸 메일도 옮겨 보낸편지함이 빕니다.`,
    undo,
    '안 읽은 메일(이 앱에서 열기만 한 것 포함)과 별표·중요 메일, 임시보관함은 남깁니다.'
  ] : [
    `모든 계정에서 PC에 저장된 ${tidyWhat(days)}을 읽음과 상관없이 옮깁니다.`,
    undo,
    '별표·중요 메일과 임시보관함은 남깁니다.'
  ];
  if (lowering && from === 0 && days > 0) detail.push('«바로»와 달리 안 읽은 메일도 그 기간이 지나면 옮깁니다.');
  // 읽은 뒤에 옮긴다고 약속하지 않는다 — 별표·중요 표시가 붙은 것처럼 읽어도 남기는 메일이 섞여 있다
  if (days === 0 && n.unread > 0) detail.push(`안 읽은 ${n.unread}통은 읽을 때까지 남깁니다.`);
  if (n.unsaved > 0) detail.push(`저장 안 된 ${n.unsaved}통은 남깁니다 — «백업 시작»으로 저장하면 대상이 됩니다.`);
  if (n.unverified > 0) detail.push(`같은 메일인지 확인 안 된 ${n.unverified}통도 남깁니다.`);
  if (v > mailtidy.CAP) detail.push(`한 번에 ${mailtidy.CAP}통씩 나눠서 옮깁니다.`);
  if (errors.length) detail.push(`정리하지 못하는 곳: ${errors.slice(0, 2).join(' / ')}`);
  if (!lowering) detail.push(`${minutesOf(startMs)}분쯤 뒤 시작 — 그 전에 끄면 옮기지 않습니다.`);
  // 켜진 채 바꾸기 — «바로»로 · «바로»에서 기간으로 · 기간 줄이기
  const lowerTitle = days === 0 ? '서버 정리 — 읽은 메일 바로 옮기기'
    : from === 0 ? '서버 정리 — 기간으로 바꾸기' : '서버 정리 — 기간 줄이기';
  const lowerButton = days === 0 ? '«바로»로 바꾸기' : from === 0 ? `${days}일로 바꾸기` : `${days}일로 줄이기`;
  return {
    title: lowering ? lowerTitle : '서버 정리 켜기',
    message,
    detail: detail.join('\n'),
    buttons: [lowering ? lowerButton : '서버 정리 켜기', '그만두기'],
    // 단추 색은 위험(빨강)으로 두되 초점은 «그만두기»에 — 세는 동안 최대 20초 늦게 뜨는 창에
    // 다른 데 치던 Enter가 들어가 켜지면 안 된다
    defaultId: 0,
    danger: true,
    focusId: 1
  };
}

/**
 * 서버 정리 켜기·끄기·기간 — 메인 쪽 확인 문.
 *
 * 확인을 화면 쪽에 두면 입구가 늘 때마다 빠뜨리게 된다. 그래서 여기서 직접 세어 보고 묻는다.
 * 일반 설정 길(setApp)은 이 값을 아예 못 바꾼다 (store.setSettings 가 버린다).
 * 끄기와 기간 늘리기(덜 옮기는 쪽)는 묻지 않는다. 끄기는 어느 창에서 와도, 묻는 중에도 받는다.
 * «바로»(0)는 가장 많이 옮기는 쪽이라 거기로 바꾸면 묻는다. «바로»에서 기간으로 바꾸는 것도 묻는다 —
 * 기간 정리는 안 읽은 오래된 메일도 옮기는데, «바로»를 켤 때는 그것을 묻지 않았다.
 * @returns BackupStatus — 확인 창이 닫히고 asking 이 내려간 뒤에 돌아온다
 */
async function setTidy(req, parent, { fromSettings = false, countMs = T.COUNT_MS, startMs = T.START_MS } = {}) {
  const q = req && typeof req === 'object' ? req : {};
  // 답은 요청마다 새로 쓴다 — 지난 요청의 말이 남아 엉뚱한 때 다시 보이지 않게
  tidy.message = '';
  tidy.messageKind = '';
  const say = (kind, text) => {
    tidy.messageKind = kind;
    tidy.message = text;
    return backupStatus();
  };
  const cur = { on: store.settings.mailServerTidy === true, days: tidyDays() };
  const on = typeof q.on === 'boolean' ? q.on : cur.on;
  const days = q.days !== undefined ? mailtidy.normDays(q.days) : cur.days;
  if (on === cur.on && days === cur.days) return backupStatus();

  // 꺼진 채 기간만 바꿨다는 답 — «바로»는 기간이 아니다
  const onlyDays = () => say('good', days === 0
    ? '꺼져 있어 옮기는 때만 «바로»로 바꿨습니다.'
    : `꺼져 있어 기간만 ${days}일로 바꿨습니다.`);
  // 꺼진 채 기간만 바꿈 — 아무것도 옮기지 않으므로 묻지 않는다 (켤 때 그 기간으로 묻는다)
  if (!on && !cur.on) {
    store.setGatedSettings({ mailTidyDays: days });
    return say('good', days === 0
      ? '켜면 PC에 저장된 읽은 메일을 바로 옮깁니다.'
      : `켜면 받은 지 ${days}일 지난 메일부터 옮깁니다.`);
  }
  // 끄기
  if (!on && cur.on) {
    store.setGatedSettings({ mailServerTidy: false, mailTidyDays: days });
    const was = tidy.running;
    if (was) tidy.stop = true;
    evlog.log('메일', '서버 정리 끔');
    return say('good', was
      ? '껐습니다 — 지금 묶음까지만 하고 멈춥니다.'
      : '껐습니다.');
  }
  // 켜진 채 기간 늘리기 — 덜 옮기는 쪽이라 묻지 않는다. 도는 정리는 shouldStop 으로 멈추고 새 기간으로 다시 돈다.
  // «바로»(0)에서 기간으로는 여기 오지 않는다 — 안 읽은 오래된 메일까지 옮기게 되므로 아래에서 묻는다
  if (cur.on && cur.days > 0 && days > cur.days) {
    store.setGatedSettings({ mailTidyDays: days });
    evlog.log('메일', `서버 정리 기간 늘림 · 받은 지 ${days}일 지난 것`);
    if (tidy.running) kickTidy(T.AGAIN_MS);
    return say('good', `받은 지 ${days}일 지난 메일만 옮기도록 바꿨습니다.`);
  }

  // 여기부터는 위험해지는 요청 — 켜기, 켜진 채 기간 줄이기·«바로»로·«바로»에서 기간으로
  if (tidy.asking) return say('wait', '확인 창이 떠 있습니다 — 거기서 골라주세요.');
  // preload 는 모든 창에 같다 — 남이 쓴 본문을 그리는 메일 보기 창도 mail:tidy-set 을 부를 수 있다. 켜진 정리를
  // «바로»로 바꾸거나 기간을 줄이는 것(더 옮기는 쪽)도 켜기와 똑같이 설정 창에서만 받는다
  if (!fromSettings || !parent) {
    return say('bad', cur.on ? '서버 정리는 설정 창에서만 바꿀 수 있습니다.' : '서버 정리는 설정 창에서만 켤 수 있습니다.');
  }
  const why = tidyWhy() || backupDirProblem(store.settings.mailBackupDir);
  if (why) return say('bad', why);

  const lowering = cur.on;
  let n = null;
  let r = null;
  let gone = false;
  let offNow = false;
  tidy.asking = true;
  try {
    n = await countForConfirm(days, countMs);
    // 세는 동안 설정 창을 닫았으면 묻지 않는다 — 부모 없이 뜬 창은 무엇을 묻는지 알 수 없다
    gone = typeof parent.isDestroyed === 'function' && parent.isDestroyed();
    // 기간을 줄이려고 세는 사이에 껐다 — 꺼진 정리의 기간은 아무것도 옮기지 않으므로 묻지 않는다
    offNow = lowering && store.settings.mailServerTidy !== true;
    // PC 쪽 정리 기록을 못 읽으면 켜도 매번 같은 오류로 아무것도 못 한다 — 묻지 않고 그 까닭을 말한다
    if (!gone && !offNow && !n.failed) {
      r = await popup.askUser(parent, tidyQuestion(n, { days, from: cur.days, lowering, countMs, startMs }));
    }
  } finally {
    tidy.asking = false;
  }
  if (gone) return say('bad', '설정 창이 닫혀 그만뒀습니다 — 서버 메일은 그대로입니다.');
  if (offNow) {
    store.setGatedSettings({ mailTidyDays: days });
    return onlyDays();
  }
  if (n.failed) return say('bad', `${lowering ? '기간을 바꾸지' : '켜지'} 않았습니다. ${n.failed}`);
  if (r !== 0) return say('wait', '그만뒀습니다 — 서버 메일은 그대로입니다.');

  // 묻는 동안 바뀌었을 수 있다 — 저장 직전에 다시 본다
  const why2 = tidyWhy();
  if (why2) return say('bad', why2);
  if (lowering && store.settings.mailServerTidy !== true) {
    // 묻는 사이에 껐다 — 끈 것이 이긴다. 기간만 남긴다
    store.setGatedSettings({ mailTidyDays: days });
    return onlyDays();
  }
  store.setGatedSettings({ mailServerTidy: true, mailTidyDays: days });
  const how = !lowering ? '켬' : days === 0 ? '«바로»로 바꿈' : cur.days === 0 ? '기간으로 바꿈' : '기간 줄임';
  evlog.log('메일', `서버 정리 ${how} · ${days === 0 ? '읽은 메일 바로' : `받은 지 ${days}일 지난 것`}`
    + ` · 확인 때 ${Number(n && n.verified) || 0}통${n && n.complete ? '' : ' 이상'}`);
  kickTidy(startMs);
  const soon = `${minutesOf(startMs)}분쯤 뒤부터`;
  if (!lowering) return say('good', `켰습니다 — ${soon} 옮깁니다. 그 전에 끄면 옮기지 않습니다.`);
  if (days === 0) return say('good', `«바로»로 바꿨습니다 — ${soon} 적용됩니다.`);
  if (cur.days === 0) return say('good', `${days}일로 바꿨습니다 — 안 읽은 메일도 그 기간이 지나면 옮깁니다.`);
  return say('good', `${days}일로 줄였습니다 — 곧 적용됩니다.`);
}

ipcMain.handle('mail:backup-status', () => backupStatus());

ipcMain.handle('mail:backup-pick', () => pickDir());

ipcMain.handle('mail:tidy-set', (e, req) => setTidy(req, BrowserWindow.fromWebContents(e.sender),
  { fromSettings: !!host.isSettingsWin(e.sender) }));

/** 백업 폴더 고르기 */
async function pickDir() {
  // 도는 중에 폴더를 바꾸면 절반은 저쪽, 절반은 이쪽에 남는다.
  // 서버 정리도 마찬가지다 — 정리는 이 폴더의 파일을 근거로 옮긴다
  const busy = () => backup.running || autoBackup.running || tidy.running || tidy.asking;
  const refuse = () => {
    backup.message = '백업이나 서버 정리가 도는 중에는 폴더를 바꿀 수 없습니다';
    return backupStatus();
  };
  if (busy()) return refuse();
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '메일을 저장할 폴더',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.settings.mailBackupDir || app.getPath('documents')
  });
  if (canceled || !filePaths || !filePaths[0]) return backupStatus();
  // 대화상자를 기다린 사이에 백업이나 정리가 시작됐을 수 있다
  if (busy()) return refuse();
  const p = filePaths[0];

  // 여기서 못 쓰는 곳인지 바로 확인한다. 나중에 백업을 눌렀을 때 실패하면
  // 원인이 폴더인지 서버인지 알 수 없다. (C:\Users 밑처럼 윈도우가 막는 자리가 있다)
  const bad = backupDirProblem(p);
  if (bad) { backup.message = bad; return backupStatus(); }

  // 폴더가 바뀌면 서버 정리를 끈다 — 이미 정리한 메일의 PC 사본은 이전 폴더에 있다.
  // 새 폴더로 정리하려면 다시 묻는다 (새 폴더에는 아직 아무것도 없을 수 있다)
  const old = store.settings.mailBackupDir;
  const norm = (x) => {
    const r = path.resolve(x);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const changed = !old || norm(old) !== norm(p);
  const offTidy = changed && store.settings.mailServerTidy === true;
  // 판정 기억은 그 폴더의 파일을 근거로 한 것이다 (열쇠에 폴더가 들어 있지만, 쓸모없는 것을 들고 있지 않게)
  if (changed) tidyMemo.clear();
  store.setGatedSettings({ mailBackupDir: p, ...(offTidy ? { mailServerTidy: false } : {}) });
  // 옮긴 기록은 새 폴더로도 옮겨 적는다 — 새 폴더로 다시 켰을 때, 예전에 옮겼다가 휴지통에서 되찾은 메일을
  // 또 옮기지 않게 (더하기만 한다. 못 읽거나 못 쓰면 그만이다 — 정리는 꺼져 있고 다시 켤 때 묻는다)
  if (changed && old) {
    try { await mailtidy.carryMoved(old, p); } catch { /* 기록을 못 옮겨도 폴더 고르기는 끝낸다 */ }
  }
  if (offTidy) {
    backup.message = `폴더를 바꿔 «서버 정리»를 껐습니다 — 정리한 메일의 사본이 이전 폴더(${old})에 있으니 지우지 마세요.`;
    evlog.log('메일', '서버 정리 꺼짐 · 백업 폴더를 바꿈 (이전 폴더에 정리한 메일의 사본이 있음)');
  } else {
    backup.message = '';
  }
  return backupStatus();
}

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
      return `이 폴더에는 쓸 수 없습니다 (${dir}) — 문서 폴더 안의 폴더를 고르세요.`;
    }
    return `이 폴더를 쓸 수 없습니다 — ${e.message}`;
  }
}

ipcMain.on('mail:backup-stop', () => { backup.stop = true; });
ipcMain.on('mail:backup-open', () => {
  if (store.settings.mailBackupDir) shell.openPath(store.settings.mailBackupDir);
});

ipcMain.handle('mail:backup-start', () => startBackup());

/** «백업 시작» — 지난 메일까지 전부. 기다리지 않고 바로 상태를 돌려준다 (몇 시간짜리가 될 수도 있다) */
async function startBackup() {
  // 자리를 먼저 잡는다. await 뒤에 검사하면 두 번 빠르게 누른 사이에 둘 다 통과해
  // 같은 폴더에 백업이 두 개 돈다.
  if (backup.running) return backupStatus();
  backup.running = true;
  try {
    if (!store.settings.mailBackupDir) throw new Error('저장할 폴더를 먼저 고르세요');
    // 폴더는 고른 뒤에도 지워지거나 권한이 바뀔 수 있다 — 시작 전에 다시 본다
    const bad = backupDirProblem(store.settings.mailBackupDir);
    if (bad) throw new Error(bad);
    if (!host.mailAccountsForUse().length) throw new Error(host.noAccountMessage());
  } catch (e) {
    backup.running = false;
    backup.message = e.message;
    return backupStatus();
  }

  Object.assign(backup, {
    stop: false, account: '', mailbox: '',
    done: 0, total: 0, saved: 0, skipped: 0, message: '', at: Date.now(), waiting: ''
  });
  // 시작이 확정된 뒤에만 정리에 비켜 달라고 한다 — 다른 까닭으로 못 시작하면 정리는 그대로 둔다.
  // 확인 지점까지 기다리되, 느린 서버의 걸린 명령은 STOP_GRACE_MS 뒤 연결을 끊어 끝낸다
  if (tidy.running) {
    tidy.stop = true;
    // 지금 도는 그 실행만 끊는다 — 그 실행이 스스로 끝나고 곧 새 실행이 떴으면 낡은 타이머가 그것을 끊으면 안 된다
    // (runTidy 는 실행마다 tidy.abort 를 새로 만든다)
    const stopThis = tidy.abort;
    setTimeout(() => { if (tidy.running && stopThis && tidy.abort === stopThis) stopThis(); }, T.STOP_GRACE_MS);
  }
  if (tidy.running) backup.waiting = '서버 정리를 멈추는 중 · 끝나면 백업 시작';
  else if (autoBackup.running) backup.waiting = '자동 백업이 끝나기를 기다리는 중';

  (async () => {
    try {
      // 같은 폴더를 둘이 쓰면 안 된다 — 정리·자동 백업이 끝나기를 기다린다
      const t0 = Date.now();
      while ((tidy.running || autoBackup.running) && !backup.stop && Date.now() - t0 < T.WAIT_MAX_MS) {
        await sleep(500);
      }
      if (backup.stop) { backup.message = '멈췄습니다 — 0통 저장'; return; }
      if (tidy.running || autoBackup.running) {
        backup.message = '다른 작업이 끝나지 않아 시작하지 못했습니다 — 잠시 뒤 다시 누르세요';
        return;
      }
      backup.waiting = '';

      // 도는 동안 폴더가 바뀌어도 시작할 때 고른 곳에 끝까지 쓴다
      const dir = store.settings.mailBackupDir;
      const accounts = host.mailAccountsForUse();
      evlog.log('메일', `백업 시작 · 계정 ${accounts.length}개 · ${dir}`);

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
        + (missing ? ` · ${missing}통 못 받음` : '')
        + (failed.length ? ` · 실패 ${failed.length}건: ${failed[0]}` : '');
      evlog.log('메일', `백업 ${backup.stop ? '중단' : '완료'} · ${saved}통`
        + (failed.length ? ` · 실패 ${failed.join(' / ')}` : ''));
    } catch (e) {
      backup.message = mail.friendly(e);
      evlog.log('메일', `백업 실패 · ${backup.message}`);
    } finally {
      backup.running = false;
      backup.waiting = '';
      backup.mailbox = '';
      // 지난 메일을 새로 저장했으니 정리를 너무 오래 미루지 않는다
      if (tidyOn()) tidyNextAt = Math.min(tidyNextAt, Date.now() + T.FIRST_MS);
    }
  })();

  return backupStatus();
}

module.exports = { init, autoBackupOne, autoBackupNew, setTidy, backupStatus, startBackup, pickDir };

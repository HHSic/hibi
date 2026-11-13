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
//
// 백업 폴더를 바꿀 때 «기존 메일 백업도 옮기기»도 여기서 잠근다 — 무엇을 어떻게 옮길지는 src/backupmove.js 가 하고,
// 여기는 묻기·이 폴더에 쓰는 일 멈추기·설정 바꾸기만 맡는다.

const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const evlog = require('./evlog');
const mail = require('./mail');
const mailbackup = require('./mailbackup');
const mailtidy = require('./mailtidy');
const mailfill = require('./mailfill');
const mailindex = require('./mailindex');
const mailmove = require('./mailmove');
const tidyacct = require('./tidyacct');
// 이름 공간으로 부른다 (backupmove.run · backuphome.probe) — 시험이 바꿔 끼울 수 있게
const backupmove = require('./backupmove');
const backuphome = require('./backuphome');
const { defaultDirs, underOneDrive } = backuphome;
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
  forwardBusy: () => false,
  // 지금 알림을 띄우면 안 되는 까닭 (없으면 null) — 지난 메일을 묻는 알림은 방해 금지가 끝난 뒤에
  holdReason: () => null,
  // 지난 메일을 묻는 Windows 알림 — 알림 객체는 main.js 가 맡는다
  notifyFill: () => {},
  // 다음 폴링 시각 — 뒤 받기가 폴링 앞에서 회차를 줄이려고 본다
  nextPollAt: () => Infinity,
  // 메일 백업을 옮기는 동안 종료를 눌러 미뤘다 — 알림은 main.js 가 띄운다 (말없이 안 꺼지면 작업 관리자로 끌 수 있다)
  quitHeld: () => {}
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
  KICK_SLACK_MS: 1_000,       // 예약 타이머는 문(계정의 다음 정리 시각)보다 이만큼 늦게 — 타이머가 조금 일찍 깨도 문에 막히지 않게
  COUNT_MS: 20_000,           // 확인 창의 «약 n통» 세기 제한
  MAX_MS: 10 * 60_000,        // 한 번 도는 시간 상한 — 넘으면 연결을 끊어 강제로 끝낸다
  STOP_GRACE_MS: 10_000,      // «백업 시작»이 비켜 달라고 한 뒤 강제로 끊기까지
  WAIT_MAX_MS: 5 * 60_000,    // «백업 시작»이 정리·자동 백업을 기다리는 최대
  // 지난 메일 뒤 받기의 시간표
  FILL_ON: true,                 // 응급 끄기
  FILL_FIRST_MS: 5 * 60_000,     // 앱을 켜고 첫 회차까지
  FILL_FIRST_TURN_MS: 60_000,    // 앱 실행 뒤 계정별 첫 회차
  FILL_TURN_MS: 4 * 60_000,
  FILL_BIG_TURN_MS: 15 * 60_000,  // 8MB 넘는 메일이나 전에 끊긴 메일 한 통에 줄 수 있는 몫의 상한
  FILL_GAP_MS: 30_000,
  FILL_QUIET_MS: 60_000,
  FILL_FRESH_MS: 90_000,          // 마지막 앞쪽 연결 뒤 이 안이면 남은 시간과 상관없이 시작한다
  FILL_POLL_MARGIN_MS: 30_000,
  FILL_MIN_TURN_MS: 60_000,
  FILL_WATCH_MS: 30_000,          // 몫을 이만큼 넘기면 회차를 강제로 끝낸다
  FILL_RETRY_MS: [60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000],
  FILL_IDLE_TURNS: 3,             // 끊겨서 아무것도 못 받은 회차가 이만큼 이어지면 간격을 늘린다 — 로그인만 쌓인다
  FILL_REFUSED_MS: 30 * 60_000,   // 로그인 일시 거절 — 연결 수 제한일 수 있어 길게 쉰다
  FILL_STUCK_MS: 3 * 24 * 3600_000,  // 이만큼 나아가지 못하면 위젯에 알린다
  FILL_CHECK_DISK_MS: 30 * 60_000
};
// 서버 정리의 지금 상태와 이번 앱 실행의 결과 — 계정마다 켜고, 계정마다 제 시각에 돈다
const tidy = {
  // again: 도는 사이에 켜기·기간 바꾸기가 확인됐다 — 끝난 뒤 againAt 보다 이르지 않게 다시 돈다 (againIds: 그 계정의 시각)
  running: false, stop: false, asking: false, askingId: null, again: false, againAt: 0, againIds: new Map(), abort: null,
  current: null,          // 지금 정리하는 계정 id
  last: new Map(),        // 계정 id → 이번 실행의 마지막 결과 (없으면 저장해 둔 mailTidyResults)
  total: new Map(),       // 계정 id → 이번 앱 실행에서 옮긴 수
  nextAt: new Map(),      // 계정 id → 다음 정리 시각 (없으면 앱을 켠 뒤 FIRST_MS)
  // 계정 id → 켜기·바꾸기를 확인할 때 약속한 유예가 끝나는 때 («n분쯤 뒤부터 — 그 전에 끄면 옮기지 않습니다»). «다시 해 보기»도 줄이지 않는다
  graceUntil: new Map(),
  // 마지막으로 기록에 적은 결과의 모양 — «바로»가 같은 줄을 5분마다 쌓지 않게 (계정마다)
  logSig: new Map(),
  stopSaid: new Set(),    // 멈춘 계정을 건너뛴다고 이번 실행에 이미 적은 계정 id
  message: '', messageKind: ''
};
// 계정마다 이번 실행에 본 «서버 기능» 한 줄 (mailmove.capsLine) — 설정 화면이 보이고, 처음 보거나 바뀔 때만 기록에 남긴다
const serverCaps = new Map();   // 계정 열쇠 → { line, at }
let tidyBootAt = Date.now();
// «바로»가 늘 남기는 메일(Gmail 중요·메모·되찾음·확인 안 됨)의 판정 기억 — 몇 분마다 봉투·헤더를 다시 받지 않게 (mailtidy opts.memo).
// 메모리에만 둔다. 앱을 다시 켜면 한 번 더 받아 볼 뿐이다
const tidyMemo = new Map();

// 지난 메일 뒤 받기의 지금 상태. 답만 저장하고(store.mailFill) 나머지는 메모리에 둔다 — 앱을 다시 켜면 색인이 곧 할 일이다
const fill = {
  running: false, ctl: null, current: null, turnDone: null, turnId: 0, picking: false, asking: false,
  nextAt: Date.now() + T.FILL_FIRST_MS, rr: 0, scanned: false,
  scan: null,         // 도는 옛 파일 스캔 (프라미스) — 백업 폴더 옮기기가 끝나기를 기다린다
  // 회차가 끝났거나 자동 저장이 돌았다 — 다음 틱에 남은 수를 다시 센다
  dirty: false,
  listed: new Map(),  // 계정 → { clean, boxErrors } — 이번 실행의 첫 backupAccount 가 끝났나. autoBackupNew 만 적는다
  memo: new Map(),    // 계정 → { chunk, retried, retriedAt, list, listAt, miss, scanned, setupMs, bps, firstDone, strikes, idle, retryAt, authOff, authAt, unusable, saved, why, error, box, phase, need, floor, genNote, boxErrors }
  counts: new Map(),  // 계정 → countPending 결과
  stuckLine: '',      // 위젯에 낼 «오래 멈춤» 줄 — 틱이 적는다. 위젯은 매초 묻는데 판정은 상태 파일을 읽어야 해서
  message: '', messageKind: ''
};

function init(h) {
  host = { ...host, ...h };
  if (h && h.tidyTiming) {
    Object.assign(T, h.tidyTiming);
    tidyBootAt = Date.now();
    tidy.nextAt.clear();
    fill.nextAt = Date.now() + T.FILL_FIRST_MS;
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
// 저장 중인 «열어본 메일» 수 — 백업 폴더 옮기기는 이것이 0 이 되기를 기다린다
let savingOne = 0;

// 백업 폴더 옮기기 (폴더를 바꿀 때 «옮기기»를 골랐다). 도는 동안 이 폴더에 쓰는 일은 모두 쉰다 —
// 수동·자동 백업, 열어본 메일 저장, 서버 정리, 지난 메일 받기(회차·옛 파일 스캔), 자동 전달(main.js 가 autofwd 에 moving 을 넘긴다).
// 메일 열기(mailbody)는 그동안 백업 파일을 읽지 않고 서버로 간다. phase: wait(다른 일이 멈추기를) · copy · verify · trash
// 옮기기가 멈춘 채(설정 mailMoveHalt — 바꿔 단 것이 새 폴더에 남았다)여도 똑같이 쉰다 (moveHold) — 그때 고른 새 폴더를 다시 고르면 이어서 옮긴다
const move = { running: false, phase: '', done: 0, total: 0, bytes: 0, totalBytes: 0 };
const MOVING_WAIT = '메일 백업을 옮기는 중입니다 — 끝난 뒤 다시 눌러주세요.';
const HALT_WAIT = '메일 백업 옮기기가 끝나지 않았습니다 — 설정 › 메일에서 그때 고른 새 폴더를 다시 골라 이어서 옮기세요.';
const MOVE_TITLE = '기존 메일 백업도 옮길까요?';
const RESUME_TITLE = '옮기다 멈춘 메일 백업을 이어서 옮길까요?';
const NEW_ONLY = '옮기지 않고 새 폴더만 쓰기';
// 옮기는 동안 종료를 눌렀다 — 끝나면 다시 종료한다 (holdQuit)
let quitHeld = false;
// 앱을 켠 뒤 옮기기의 남은 것(멈춤·끝난 일지)을 한 번 봤나 (checkMoveLeft)
let leftChecked = false;

/**
 * 옮기기가 멈춘 채인가 — 같은 볼륨에서 바꿔 달다 막혔거나 꺼져 일부가 새 폴더에 있다 (설정 mailMoveHalt — 다시 켜도 남는다).
 * 그동안 이전 폴더는 갈려 있다: 상태 파일과 계정 폴더가 두 곳에 나뉘었을 수 있다
 */
function moveHalt() {
  const h = store.settings.mailMoveHalt;
  return h && typeof h === 'object' && typeof h.from === 'string' && h.from && typeof h.to === 'string' && h.to ? h : null;
}

/** 이 폴더에 쓰는 일을 쉬나 — 옮기는 중이거나 옮기기가 멈춘 채 */
function moveHold() {
  return move.running || !!moveHalt();
}

/** 쉬는 까닭 한 줄 */
function holdWait() {
  return move.running ? MOVING_WAIT : HALT_WAIT;
}

/** 백업 폴더를 옮기는 중인가 (멈춘 채도) — main.js 가 자동 전달·본문 읽기에 넘긴다 */
function moving() {
  return moveHold();
}

/** 지금 옮기기가 도는가 — 종료·업데이트 설치를 미룰지 본다 (멈춘 채는 아니다 — 도는 것이 없다) */
function moveRunning() {
  return move.running;
}

function backupStatus() {
  return {
    ...backup,
    waiting: backup.waiting || '',
    move: { ...move },
    dir: store.settings.mailBackupDir || null,
    auto: store.settings.mailAutoBackup === true,
    // 화면은 창을 열 때 받은 설정을 들고 있다 — 스위치를 켜고 꺼도 이 값은 따라온다
    mailEnabled: store.settings.mailEnabled === true,
    autoAt: autoBackup.at,
    autoSaved: autoBackup.saved,
    autoTotal: autoBackup.total,
    autoSeeded: autoBackup.seeded,
    autoError: autoBackup.error,
    tidy: tidyStatus(),
    fill: fillStatus()
  };
}

/** Gmail 계정인가 — 라벨 폴더에서 옮겨도 메일 자체가 휴지통으로 간다는 안내를 붙인다 */
function isGmail(acc) {
  return !!acc && (acc.provider === 'gmail' || /(^|\.)gmail\.com$/i.test(String(acc.host || '').trim()));
}

/**
 * 설정 화면이 보는 서버 정리 상태 — 계정마다 한 줄 (설정 순서). 이번 실행에서 아직 안 돌았으면 저장해 둔 마지막 결과를 쓴다.
 * 멈춤(blocked)은 옮기기 일지에서 읽는다 — 앱을 다시 켜도 남는다
 */
function tidyStatus() {
  const why = tidyWhy();
  const dir = store.settings.mailBackupDir;
  const saved = store.settings.mailTidyResults || {};
  const blocked = mailmove.blockedList();
  // 쓸 수 있는 계정(비밀번호를 풀 수 있는)인가 — 못 쓰는 계정은 정리가 영영 돌지 않는데 줄이 «다음 자동 백업 뒤»라고 하면 안 된다. 모르면 막지 않는다
  let usable = null;
  try { usable = new Set((host.mailAccountsForUse() || []).map((a) => a.id)); } catch { usable = null; }
  let total = 0;
  const accounts = liveAccounts().map((a) => {
    const e = tidyEntry(a);
    const k = mailbackup.accountKey(a);
    const b = Object.prototype.hasOwnProperty.call(blocked, k) ? blocked[k] : null;
    const c = serverCaps.get(k);
    const last = tidy.last.get(a.id) || tidyacct.normResult(saved[a.id]) || tidyacct.normResult({});
    const sum = tidy.total.get(a.id) || 0;
    total += sum;
    return {
      ...last,
      // last.days 는 그 결과를 낸 실행의 기간이다 — 지금 고른 기간과 다를 수 있다
      ranDays: last.at ? last.days : null,
      id: a.id,
      name: a.name || a.user,
      gmail: isGmail(a),
      on: e.on,
      days: e.days,
      running: tidy.running && tidy.current === a.id,
      // 지난 메일을 받는 동안 쉰다. 멈춘 계정은 어차피 안 옮기므로 쉰다고 말하지 않는다
      held: e.on && !b && !!dir && fillHolds(a, dir),
      blocked: b ? String(b.why || '') || '서버가 옮기기를 거절했습니다' : null,
      blockedAt: b ? Number(b.at) || 0 : 0,
      // 서버 기능 한 줄 — 계정 줄이 복사 길·멈춘 계정에 요약을 보이고 전체는 풍선 도움말로 둔다 (사용자가 그대로 옮겨 알려 줄 수 있게)
      caps: c ? c.line : null,
      // MOVE 가 없는 서버 — 복사한 뒤 지운다 (mailmove). 폴링 연결이 한 번 읽어야 안다
      copyPath: !!c && /^옮기기\(MOVE\) 없음/.test(c.line),
      usable: !usable || usable.has(a.id),
      total: sum
    };
  });
  return {
    ready: !why,
    why,
    running: tidy.running,
    asking: tidy.asking,
    askingId: tidy.askingId,
    current: tidy.current,
    everyMin: tidyEveryMin(),
    cap: mailtidy.CAP,
    total,
    message: tidy.message,
    messageKind: tidy.messageKind,
    accounts,
    // 계정마다 서버 기능 한 줄과 옮기기 멈춤 (꺼 둔 계정도). 화면은 accounts[].caps 를 쓴다 — 이것은 지난 메일 쪽·시험이 읽는다
    servers: serverRows()
  };
}

/** 설정 화면의 계정 줄에 붙일 것 — { id, caps, capsAt, stopped, stoppedAt }. 주소는 넣지 않는다 */
function serverRows() {
  const blocked = mailmove.blockedList();
  return store.mailAccounts.map((a) => {
    const k = mailbackup.accountKey(a);
    const c = serverCaps.get(k);
    const b = Object.prototype.hasOwnProperty.call(blocked, k) ? blocked[k] : null;
    return { id: a.id, caps: c ? c.line : null, capsAt: c ? c.at : 0, stopped: b ? b.why : null, stoppedAt: b ? b.at : 0 };
  });
}

// 두 순간에 저장한다.
//  1) 새 메일이 들어왔을 때 — 폴링이 끝나면 새로 생긴 UID만 받아 둔다
//  2) 사용자가 메일을 열었을 때 — 본문을 이미 받아왔으므로 서버를 더 부르지 않는다
//
// 켜자마자 몇 년치를 몰래 받지는 않는다(onlyNew). 지난 메일은 사용자가 답한 뒤 mailfill 이 받는다.
const AUTO_GAP_MS = 2 * 60_000;   // 폴링이 잦아도 이보다 자주 돌지 않는다
const AUTO_GAP_MAX_MS = 30 * 60_000;
let autoRunAt = 0;
let autoLastMs = 0;               // 지난 계정 고리의 실제 시간

/**
 * 다음 자동 저장까지 두는 간격 — 느린 서버에서 폴링마다 LIST·EXAMINE 을 다시 보내지 않게 늘린다.
 * 상한이 없으면 3시간 걸린 고리 뒤 9시간 동안 새 메일 저장이 멎는다
 */
function autoGapMs(lastMs) {
  return Math.min(AUTO_GAP_MAX_MS, Math.max(AUTO_GAP_MS, lastMs * 3));
}

/**
 * 자동 백업이 실제로 돌 수 있는 상태인가.
 * 메일 확인이 꺼져 있으면 폴링이 없어 새 메일을 알 방법이 없다 — 화면에도 그대로 알린다.
 */
function autoBackupOn() {
  return store.settings.mailAutoBackup === true
    && !!store.settings.mailBackupDir
    && store.settings.mailEnabled === true;
}

/** 그 계정의 서버 정리 설정 { on, days } — 항목이 없으면 꺼짐·30일 (새로 더한 계정) */
function tidyEntry(acc) {
  return tidyacct.entryOf(store.settings.mailTidyAccounts, acc && acc.id);
}

/** 그 계정의 서버 정리가 돌 수 있나 — 자동 백업이 도는 사람만 (정리는 자동 백업 한 바퀴 뒤에 붙어 돈다) */
function tidyOnFor(acc) {
  return autoBackupOn() && tidyEntry(acc).on;
}

/** 0(바로)·7·30·90 — 0은 거짓 값이라 `|| 30` 으로 다듬으면 안 된다 (entryOf 가 목록의 값을 그대로 준다) */
function daysOf(acc) {
  return tidyEntry(acc).days;
}

/** 그 계정의 다음 정리 시각 — 아직 없으면 앱을 켠 뒤 FIRST_MS (켜자마자 몰리는 일과 겹치지 않게) */
function nextAtOf(id) {
  return tidy.nextAt.has(id) ? tidy.nextAt.get(id) : tidyBootAt + T.FIRST_MS;
}

const sameAcc = (a, b) => !!a && !!b && (a.id || a.user) === (b.id || b.user);

/** 기록에 쓰는 계정 이름 — 주소를 쓰지 않는다. 순번은 설정 순서다 (정리에 넘긴 목록의 순번이 아니다) */
const labelFor = (acc) => mailtidy.labelOf(acc, Math.max(0, store.mailAccounts.findIndex((a) => sameAcc(a, acc))));

/**
 * 확인 창·답에 쓰는 이름 — 설정 화면의 계정 줄(이름, 없으면 주소)과 같게. 서버 메일을 옮기는 확인 창이 화면과 다른 이름(«계정 3»)으로
 * 부르면 어느 계정인지 맞추기 어렵다. 이 PC 의 창에만 뜬다 — 기록에는 labelFor 를 쓴다
 */
const shownName = (acc) => String((acc && (acc.name || acc.user)) || '').trim() || labelFor(acc);

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
 * 메일 확인을 먼저 본다. 자동 저장 스위치는 숨겼다 — 메일 확인이 돌면 ensureLocalFirst 가 켜므로, 켜라고 하면 찾을 수 없는 것을 찾게 된다.
 */
function tidyWhy() {
  const s = store.settings;
  if (s.mailEnabled !== true) return '«메일 확인하기»를 켜야 쓸 수 있습니다.';
  if (s.mailAutoBackup !== true) return '첫 메일 확인이 끝나면 쓸 수 있습니다.';
  if (!s.mailBackupDir) return '저장할 폴더를 먼저 골라야 쓸 수 있습니다.';
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
  // 백업 폴더를 옮기는 중에는 쓰지 않는다 — 옮긴 뒤 이전 자리에 파일이 다시 생긴다 (그 메일은 서버에 있고, 다시 열면 저장된다)
  if (backup.running || autoBackup.running || moveHold()) return;
  savingOne += 1;
  try {
    const r = await mailbackup.saveOne(acc, store.settings.mailBackupDir, {
      mailbox: m.mailbox, uid: m.uid, receivedAt: m.receivedAt,
      subject: m.subject, source: m.source, seen: m.seen
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
  } finally {
    savingOne -= 1;
  }
}

/**
 * 폴링 뒤 — 새로 들어온 것만 받아 둔다. 끝나면 서버 정리가 때가 됐는지 본다.
 * @param now 켜자마자 한 번은 간격을 무시하고 돈다 (그래야 «지금부터»가 진짜 지금이다)
 */
async function autoBackupNew({ now = false } = {}) {
  // 수동 백업이 도는 중이면 비켜준다. 같은 폴더에 둘이 쓰면 서로를 밟는다.
  // 서버 정리 중에도 비켜준다 — 정리는 백업 상태 파일과 폴더를 근거로 옮긴다. 백업 폴더를 옮기는 중에도 돌지 않는다.
  if (!autoBackupOn() || backup.running || autoBackup.running || tidy.running || moveHold()) return;
  if (!now && Date.now() - autoRunAt < autoGapMs(autoLastMs)) return;
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
  let capped = 0;
  let rejected = 0;
  const failed = [];
  const startedAt = Date.now();
  try {
    for (const acc of accounts) {
      // 계정 하나가 넘어져도 나머지는 받는다
      try {
        const r = await mailbackup.backupAccount(acc, dir, {
          onlyNew: true,
          // 메일 확인을 끄거나 «백업 시작»을 누르거나 백업 폴더를 옮기기 시작하면 다음 묶음 앞에서 멈춘다 — 밀린 구간이 길면 몇 분이 걸린다
          shouldStop: () => !autoBackupOn() || backup.running || moveHold(),
          dirProblem: backupDirProblem,
          unanswered: !answerOf(acc) || answerOf(acc) === 'asked',
          mineOf: mailtidy.mineOf,
          // 서버 기능(MOVE·UIDPLUS 등)은 이미 붙은 폴링 연결에서 읽는다 — 연결이 늘지 않는다
          capsOf: mailmove.capsLine
        });
        noteCaps(acc, r.caps);
        saved += r.saved;
        seeded += r.seeded;
        capped += r.capped || 0;
        rejected += r.rejected || 0;
        const name = acc.name || acc.user;
        const boxErrors = r.boxErrors || [];
        for (const why of boxErrors) failed.push(`${name}: ${why}`);
        if (r.stateError) failed.push(`${name}: 진행 기록 저장 실패 (${r.stateError})`);
        // 폴더를 끝까지 돈 뒤에만 «목록을 안다»로 친다. 그전에는 빈 폴더 하나만 기록된 상태를 보고 판단할 수 있다.
        // 기록을 못 쓴 실행도 같다 — 표시를 못 적은 폴더는 기록이 없어, 남은 빈 폴더만 보고 «다 받음»으로 읽으면 동의 없이 전부 받는다
        if (!r.stopped) fill.listed.set(acc.id, { clean: !boxErrors.length && !r.stateError, boxErrors, paths: r.boxPaths || [] });
        if (r.genUp) noteRenumbered(acc, dir);
      } catch (e) {
        failed.push(`${acc.name || acc.user}: ${mail.friendly(e)}`);
      }
    }
  } finally {
    autoBackup.running = false;
    autoLastMs = Date.now() - startedAt;
    fill.dirty = true;
  }
  autoBackup.at = Date.now();
  autoBackup.saved = saved;
  autoBackup.total += saved;
  autoBackup.seeded = seeded;
  autoBackup.error = failed.length ? failed[0] : null;
  if (saved || seeded || capped || rejected || failed.length) {
    evlog.log('메일', mailtidy.maskAddr(`자동 백업 · 새 메일 ${saved}통 저장`
      + (seeded ? ` · 폴더 ${seeded}곳을 «지금부터»로 표시 (지난 메일은 받지 않음)` : '')
      + (capped ? ` · 밀린 ${capped}통은 뒤로 미룸` : '')
      + (rejected ? ` · 못 받은 메일 ${rejected}통` : '')
      + (failed.length ? ` · 실패 ${failed.join(' / ')}` : '')));
  }
  // finally 부터 runTidy 의 tidy.running = true 까지 await 가 없다 — 그래야 수동 백업이 사이에 끼지 못한다
  await runTidy(dir, accounts);
}

/**
 * 서버 정리 한 번 — 켠 계정 가운데 제 시각이 된 계정을 오래 기다린 차례로, 계정마다 그 계정의 기간으로.
 * 때가 된 계정이 없거나 다른 일이 돌면 그냥 돌아간다.
 * 한 번은 최대 T.MAX_MS — 느린 서버의 걸린 명령은 확인 지점을 기다리지 않고 연결을 끊어 끝낸다.
 * 한 번에 옮기는 상한(CAP)은 모든 계정의 합이다 — 계정마다 남은 양을 남은 계정 수로 나눠 준다
 */
async function runTidy(dir, accounts) {
  // 첫 await 전에 자리를 잡는다. autoBackupNew 가 autoBackup.running 을 놓은 바로 그 틱이다
  // 자동 전달이 도는 중이면 이번엔 건너뛴다 — 전달이 받기 전에 받은편지함에서 옮기지 않게 (다음 자동 백업이 다시 본다)
  // 백업 폴더를 옮기는 중에도 — 정리는 그 폴더의 상태 파일과 정리 기록을 읽고 쓴다
  if (tidy.running || backup.running || moveHold() || !autoBackupOn() || host.forwardBusy()) return;
  const now = Date.now();
  // 켠 계정만. 지난 메일을 받는 중이거나 멈춘 계정은 뺀다 — 받아 둔 옛 메일이 다음 정리 때 300통씩 말없이 옮겨지면 안 된다
  const on = (accounts || []).filter((a) => tidyOnFor(a) && !fillHolds(a, dir));
  // 서버 탓으로 옮기기를 멈춘 계정은 연결하지 않는다 — «다시 해 보기» 전까지. 이번 실행에 한 번만 적는다
  for (const a of on) {
    if (!moveStopped(a) || tidy.stopSaid.has(a.id) || now < nextAtOf(a.id)) continue;
    tidy.stopSaid.add(a.id);
    evlog.log('메일', mailtidy.maskAddr(`서버 정리 · ${labelFor(a)} · 건너뜀 — 이 서버에서는 옮기기를 멈췄습니다`
      + ` (${moveStoppedWhy(a)}) · 설정의 «다시 해 보기»로 풀 수 있습니다`));
  }
  const due = tidyacct.dueOrder(on.filter((a) => !moveStopped(a)), (a) => nextAtOf(a.id), now);
  if (!due.length) return;
  tidy.running = true;
  tidy.stop = false;
  tidy.again = false;
  tidy.againAt = 0;
  tidy.againIds.clear();
  const ctl = new AbortController();
  tidy.abort = () => ctl.abort();
  const hard = setTimeout(() => ctl.abort(), T.MAX_MS);
  // 계정마다 시간 몫을 따로 준다 — 느린 첫 계정이 상한을 다 써 뒤 계정이 매번 굶지 않게.
  // 바깥 상한(hard)보다 조금 짧게 잡아, 몫을 다 쓴 계정은 «시간 안에 못 끝냄»으로 적히고 다음 계정으로 넘어간다
  const deadline = Date.now() + Math.round(T.MAX_MS * 0.9);
  let used = 0;
  let touched = false;
  try {
    for (let i = 0; i < due.length; i++) {
      const acc = due[i];
      // 상한을 다 썼거나 비켜 달라고 했다 — 남은 계정은 제 시각이 그대로라 다음 자동 백업 때 먼저 돈다
      if (tidy.stop || ctl.signal.aborted || used >= mailtidy.CAP) break;
      // 도는 사이에 끄거나, 지운 계정 — 또는 켤 때 약속한 유예가 아직 남은 계정 (도는 사이에 다시 켰다)
      if (!tidyOnFor(acc) || !host.accountLive(acc) || Date.now() < nextAtOf(acc.id)) continue;
      const days = daysOf(acc);
      const left = due.length - i;
      tidy.current = acc.id;
      let r;
      try {
        r = await mailtidy.tidyAll([acc], dir, {
          days,
          cap: tidyacct.capShare(mailtidy.CAP - used, left),
          signal: ctl.signal,
          budgetMs: Math.max(1, Math.floor((deadline - Date.now()) / left)),
          // 기록·오류에 쓰는 이름은 설정 순서로 — 혼자 넘기면 «계정 1»이 된다
          labelOf: () => labelFor(acc),
          accountLive: (a) => host.accountLive(a),
          // 옛 설정에서 옮겨 온 켜짐(copyAsk)은 MOVE 없는 서버의 «복사한 뒤 지우기»를 묻지 않았다 — 옮기기 전에 멈추게 한다
          copyOk: (a) => !tidyEntry(a).copyAsk,
          inView: (a, boxPath, uid, sid) => holdBack(days, a, boxPath, uid, sid),
          memo: tidyMemo,
          memoMs: T.GAP_MS,
          shouldStop: () => {
            // 끄거나, 끄고 다시 켰다 — 다시 켤 때 약속한 유예(그 계정의 시각)가 남아 있으면 지금 실행은 멈춘다
            if (tidy.stop || !tidyOnFor(acc) || Date.now() < nextAtOf(acc.id)) return true;
            // 새 설정이 지금 실행이 옮기는 범위를 다 덮지 않으면 지금 묶음까지만 하고 새 설정으로 다시 돈다.
            // «바로»와 기간 정리는 범위가 서로 다르다 — «바로»는 안 읽은 오래된 메일을, 기간 정리는 막 읽은 메일을 옮기지 않는다.
            // 그래서 둘 사이를 오가면 어느 쪽이든 멈춘다. 기간을 늘린 것도 멈춘다. 기간을 줄인 것(30 → 7)은 그대로 둔다
            const cur = daysOf(acc);
            return cur !== days && (cur === 0 || days === 0 || cur > days);
          }
        });
      } catch (e) {
        // PC 쪽 문제(정리 기록을 못 읽음) — 남은 계정도 같으니 이번 실행을 끝낸다
        const error = mailtidy.maskAddr(mail.friendly(e));
        for (const a of due.slice(i)) {
          if (!tidyOnFor(a)) continue;
          noteTidyResult(a, { at: Date.now(), days: daysOf(a), error });
          tidy.nextAt.set(a.id, Date.now() + tidyacct.gapMs(daysOf(a), false, T));
        }
        const sig = `실패/${error}`;
        if (!(days === 0 && sig === tidy.logSig.get(acc.id))) evlog.log('메일', `서버 정리 실패 · ${error}`);
        tidy.logSig.set(acc.id, sig);
        break;
      }
      used += r.moved + r.uncertain;
      if (r.moved > 0 || r.uncertain > 0) touched = true;
      const p = (r.per || {})[mailbackup.accountKey(acc)] || {};
      if (p.copyAsk) {
        // 옛 설정에서 옮겨 온 켜짐인데 MOVE 가 없는 서버 — 복사한 뒤 지우는 방식은 묻지 않았다. 끄고, 다시 켤 때 확인 창이 묻는다
        store.setTidyAccount(acc.id, { on: false });
        evlog.log('메일', `서버 정리 꺼짐 · ${labelFor(acc)} — 옮기기(MOVE)가 없는 서버라 복사한 뒤 지웁니다.`
          + ' 옛 설정에서 옮겨 와 그 방식은 묻지 않았으므로 껐습니다 (다시 켜면 확인합니다)');
      }
      noteTidyResult(acc, {
        at: Date.now(), days, moved: r.moved, kept: r.kept, unsaved: r.unsaved, unverified: r.unverified,
        spared: r.spared, important: r.important, flagged: r.flagged, unread: r.unread, uncertain: r.uncertain,
        skippedBoxes: r.skippedBoxes.length, unsavedBoxes: (r.unsavedBoxes || []).length, copyAsk: p.copyAsk === true,
        more: r.more, error: p.error || r.errors[0] || null, oldest: r.oldest,
        blocked: Array.isArray(r.noMove) && r.noMove.length > 0
      });
      tidy.total.set(acc.id, (tidy.total.get(acc.id) || 0) + r.moved);
      logTidyRun(acc, days, r, p.errors || r.errors);
      // 지금 설정으로 간격을 고른다 — 도는 사이 «바로»에서 기간으로 바꿨으면 긴 간격으로 돌아간다.
      // 도는 사이에 다시 켜거나 바꿔 정한 시각이 있으면 그것을 둔다 (끝난 뒤 다시 돈다)
      if (!tidy.againIds.has(acc.id)) tidy.nextAt.set(acc.id, Date.now() + tidyacct.gapMs(daysOf(acc), r.more, T));
      if (r.halt || r.aborted) break;
    }
  } finally {
    clearTimeout(hard);
    tidy.abort = null;
    tidy.running = false;
    tidy.stop = false;
    tidy.current = null;
    // 정리가 오래 걸렸어도, 끝의 목록 다시 읽기가 자동 백업을 곧바로 한 바퀴 또 돌리지 않게
    autoRunAt = Date.now();
    // 도는 사이에 켜기·기간 바꾸기가 확인됐다 — 새 설정으로 다시 돈다.
    // 켤 때 약속한 유예(«1분쯤 뒤»)가 남아 있으면 그보다 이르지 않게
    if (tidy.again) {
      const wait = Math.max(T.AGAIN_MS, tidy.againAt - Date.now());
      for (const [id, at] of tidy.againIds) tidy.nextAt.set(id, Math.max(at, Date.now() + T.AGAIN_MS));
      tidy.again = false;
      tidy.againAt = 0;
      tidy.againIds.clear();
      kickTidy(wait);
    }
  }
  // 옮긴 메일이 위젯 목록에 남지 않게 다시 읽는다. 옮겼는지 모르는 묶음이 있어도 읽는다. 기다리지 않는다
  if (touched) Promise.resolve().then(() => host.refreshMail()).catch(() => {});
}

/** 한 계정의 결과를 둔다 — 이번 실행의 메모리와, 앱을 다시 켜도 보이게 설정 파일에 */
function noteTidyResult(acc, r) {
  const v = tidyacct.normResult(r);
  tidy.last.set(acc.id, v);
  store.setTidyResult(acc.id, v);
}

/**
 * 계정 한 줄의 기록 — 주소는 가린다. «바로»는 5분마다 돈다 — 옮긴 것 없이 지난번과 같은 남김·오류만 되풀이되면 다시 적지 않는다.
 * 안 읽어 남긴 것(unread)·일부러 남긴 것(spared)만으로도 적지 않는다 — 경고가 아니다
 */
function logTidyRun(acc, days, r, errors) {
  const sig = [r.kept, r.unsaved, r.unverified, r.unread, r.skippedBoxes.join('|'), errors.join('|')].join('/');
  const same = days === 0 && !r.moved && !r.uncertain && sig === tidy.logSig.get(acc.id);
  tidy.logSig.set(acc.id, sig);
  if (same || !(r.moved || r.kept || r.uncertain || errors.length || r.skippedBoxes.length)) return;
  evlog.log('메일', mailtidy.maskAddr(`서버 정리 · ${labelFor(acc)} · ${r.moved}통 휴지통으로`
    + (r.uncertain ? ` · 옮기는 중 끊겨 ${r.uncertain}통은 옮겨졌을 수 있음` : '')
    + (r.kept ? ` · 남김 ${r.kept}통 (저장 안 됨 ${r.unsaved} · 확인 안 됨 ${r.unverified})` : '')
    + (r.spared ? ` · 별표·중요 등 ${r.spared}통은 남김` : '')
    + (r.unread ? ` · 안 읽은 ${r.unread}통은 읽을 때까지 남김` : '')
    + (r.more ? ` · 남은 것은 다음에 (한 번에 ${mailtidy.CAP}통까지, 모든 계정 합${r.aborted ? ', 중간에 끊음' : ''})` : '')
    + (r.skippedBoxes.length ? ` · 건너뛴 폴더 ${r.skippedBoxes.slice(0, 5).join(', ')}`
      + ((r.unsavedBoxes || []).length ? ` (PC에 저장 기록 없음 ${r.unsavedBoxes.length}곳)` : '') : '')
    + (errors.length ? ` · 실패 ${errors.join(' / ')}` : '')));
}

/**
 * 서버 정리를 ms 뒤에 돌린다 (자동 백업 한 바퀴 뒤에). 도는 중이면 끝난 뒤에 다시.
 * id 를 주면 그 계정의 시각(문)도 같은 때로 맞춘다 — 타이머만 늦추고 문을 열어 두면, 그 사이 폴링·메일 창 열기 끝의
 * autoBackupNew()가 곧바로 정리를 돌려 «켜고 1분쯤 뒤에 시작, 그 전에 끄면 아무것도 옮기지 않는다»가 깨진다.
 * 다른 계정의 시각은 건드리지 않는다 — «바로» 계정 하나 때문에 다른 계정까지 끌려 돌지 않게
 */
function kickTidy(ms, id = null) {
  const at = Date.now() + ms;
  if (id) tidy.nextAt.set(id, at);
  if (tidy.running) {
    tidy.again = true;
    tidy.againAt = Math.max(tidy.againAt, at);
    if (id) tidy.againIds.set(id, at);
    return;
  }
  const t = setTimeout(() => { autoBackupNew({ now: true }).catch(() => {}); }, ms + T.KICK_SLACK_MS);
  if (t.unref) t.unref();
}

/**
 * 확인 창에 쓸 «약 n통» — 그 계정 하나만, 정리와 같은 판정을 읽기 전용으로 돌려 세기만 한다. 최대 ms까지.
 * 늦은 세기는 연결을 끊어 바로 멈춘다 — 켜자마자 도는 백업·폴링과 연결 수를 다투지 않게.
 * 세다가 그 계정이 넘어지면(연결·휴지통 없음·멈춤) refuse 에 까닭을 둔다 — 켜도 아무것도 못 하니 묻지 않는다
 */
async function countForConfirm(acc, days, ms) {
  const seen = {};
  const ctl = new AbortController();
  let timer;
  let usable = null;
  try { usable = (host.mailAccountsForUse() || []).find((a) => sameAcc(a, acc)) || null; } catch { usable = null; }
  if (!usable) {
    return { verified: 0, complete: true, accounts: 0, refuse: '계정을 지금 쓸 수 없습니다 — 설정 › 메일을 확인하세요.' };
  }
  // 통째로 실패한 까닭 — 계정 오류는 tidyAll 안에서 errors 에 쌓이므로, 여기 오는 것은
  // 연결 전 PC 쪽 단계(정리 기록 tidy-moved.json 을 못 읽음·깨짐)뿐이다. 서버 탓으로 말하면 안 된다
  let failed = '';
  const work = mailtidy.tidyAll([usable], store.settings.mailBackupDir, {
    days, dryRun: true, cap: Infinity, into: seen, signal: ctl.signal,
    labelOf: () => labelFor(acc),
    accountLive: (a) => host.accountLive(a),
    inView: (a, boxPath, uid, sid) => holdBack(days, a, boxPath, uid, sid),
    connect: (a) => mail.connect(a, { timeoutMs: ms })
  }).then(() => true, (e) => { failed = mailtidy.maskAddr(mail.friendly(e)); return false; });
  const done = await Promise.race([work, new Promise((r) => { timer = setTimeout(() => r(false), ms); })]);
  clearTimeout(timer);
  ctl.abort();
  const n = {
    verified: 0, kept: 0, unsaved: 0, unverified: 0, unread: 0, errors: [], accounts: 0, failedAccounts: 0, per: {},
    ...seen,
    complete: done && seen.complete === true
  };
  const p = n.per[mailbackup.accountKey(usable)] || {};
  n.refuse = failed || (n.complete && n.failedAccounts > 0 ? p.error || '정리할 수 없습니다' : '');
  // 계정은 됐는데 몇 폴더를 못 본 것 — 묻는 창에 그대로 적는다
  n.notes = Array.isArray(p.errors) ? p.errors : [];
  // 세면서 연결해 보니 MOVE 가 없는 서버 — 폴링이 서버 기능을 아직 안 읽었어도 확인 창이 «복사한 뒤 지웁니다»를 말하게
  n.copy = p.copy === true;
  return n;
}

/** 확인 창의 글 — 이 계정에서 무엇을, 몇 통, 어디로 옮기는지와 무엇은 남기는지 */
function tidyQuestion(acc, n, { days, from = 30, lowering, countMs, startMs, held = false }) {
  const name = shownName(acc);
  const v = Number(n.verified) || 0;
  let message;
  if (n.complete && v > 0) {
    message = `${name} · ${tidyWhat(days)} 약 ${v}통을 서버 휴지통으로 옮깁니다.`;
  } else if (n.complete) {
    message = `${name} · 지금은 옮길 메일이 없습니다.`;
  } else if (v > 0) {
    message = `${name} · 지금까지 센 ${tidyWhat(days)} ${v}통 — ${countMs / 1000}초 안에 다 세지 못했습니다.`;
  } else {
    message = `${name} · 몇 통인지 세지 못했습니다.`;
  }
  // 휴지통을 저절로 비우지 않는 서버도 있다 — 설정 화면의 «휴지통 자동 비우기를 켜 두세요»와 어긋나지 않게 단정하지 않는다
  const undo = '웹메일·폰에서는 사라지고 PC 사본은 남습니다. 서버 휴지통이 비워지기 전까지 되찾을 수 있습니다. 되찾은 메일은 다시 옮기지 않습니다.';
  // «바로»는 날짜가 아니라 읽음으로 고른다 — 무엇이 언제 사라지고 무엇이 남는지를 먼저 말한다.
  // 언제는 «몇 분 안에»가 아니라 실제 주기로 — 메일 확인 주기를 길게 둔 사람에게는 몇십 분이다
  const detail = days === 0 ? [
    `이 계정에서 PC에 저장된 읽은 메일만 약 ${tidyEveryMin()}분마다 옮깁니다. 보낸 메일도 옮겨 보낸편지함이 빕니다.`,
    undo,
    '안 읽은 메일(이 앱에서 열기만 한 것 포함)과 별표·중요 메일, 임시보관함은 남깁니다.'
  ] : [
    `이 계정에서 PC에 저장된 ${tidyWhat(days)}을 읽음과 상관없이 옮깁니다.`,
    undo,
    '별표·중요 메일과 임시보관함은 남깁니다.'
  ];
  if (lowering && from === 0 && days > 0) detail.push('«바로»와 달리 안 읽은 메일도 그 기간이 지나면 옮깁니다.');
  // Gmail 은 라벨이 폴더로 보인다 — 어느 폴더에서 옮겨도 메일 자체가 휴지통으로 가 모든 라벨에서 빠진다
  if (isGmail(acc)) detail.push('Gmail은 라벨 폴더에서 옮겨도 메일 자체가 휴지통으로 가 모든 라벨에서 빠집니다.');
  if (copyPathOf(acc) || n.copy) detail.push('이 서버는 옮기기(MOVE)가 없어 복사한 뒤 지웁니다.');
  // 읽은 뒤에 옮긴다고 약속하지 않는다 — 별표·중요 표시가 붙은 것처럼 읽어도 남기는 메일이 섞여 있다
  if (days === 0 && n.unread > 0) detail.push(`안 읽은 ${n.unread}통은 읽을 때까지 남깁니다.`);
  if (n.unsaved > 0) detail.push(`저장 안 된 ${n.unsaved}통은 남깁니다 — «지난 메일 받기»로 저장하면 대상이 됩니다.`);
  if (n.unverified > 0) detail.push(`같은 메일인지 확인 안 된 ${n.unverified}통도 남깁니다.`);
  if (v > mailtidy.CAP) detail.push(`한 번에 ${mailtidy.CAP}통씩 나눠서 옮깁니다 (다른 계정과 합쳐서 셉니다).`);
  const notes = Array.isArray(n.notes) ? n.notes : [];
  if (notes.length) detail.push(`정리하지 못하는 곳: ${notes.slice(0, 2).join(' / ')}`);
  // 위의 수에는 받는 중인 메일도 들어 있다
  if (held) detail.push('이 계정은 지난 메일을 받는 중이라 다 받은 뒤부터 옮깁니다. 위의 수에는 그 메일도 들어 있습니다.');
  else if (!lowering) detail.push(`${minutesOf(startMs)}분쯤 뒤 시작 — 그 전에 끄면 옮기지 않습니다.`);
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

/** 이 계정은 복사한 뒤 지우는 길로 옮기나 — 폴링 연결이 읽은 서버 기능 한 줄로 안다 (아직 모르면 거짓) */
function copyPathOf(acc) {
  const c = serverCaps.get(mailbackup.accountKey(acc));
  return !!c && /^옮기기\(MOVE\) 없음/.test(c.line);
}

/**
 * 서버 정리 켜기·끄기·기간·«다시 해 보기» — 메인 쪽 확인 문. 요청은 계정 하나 ({ id, on?, days?, retry? }).
 *
 * 확인을 화면 쪽에 두면 입구가 늘 때마다 빠뜨리게 된다. 그래서 여기서 그 계정을 직접 세어 보고 묻는다.
 * 일반 설정 길(setApp)은 이 값을 아예 못 바꾼다 (store.setSettings 가 버린다).
 * 끄기와 기간 늘리기(덜 옮기는 쪽)는 묻지 않는다. 끄기는 어느 창에서 와도, 묻는 중에도 받는다.
 * «바로»(0)는 가장 많이 옮기는 쪽이라 거기로 바꾸면 묻는다. «바로»에서 기간으로 바꾸는 것도 묻는다 —
 * 기간 정리는 안 읽은 오래된 메일도 옮기는데, «바로»를 켤 때는 그것을 묻지 않았다.
 * 세다가 그 계정이 넘어지면(연결·휴지통 없음·멈춤) 확인 창 없이 거절한다 — 켜도 아무것도 못 한다.
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
  const acc = typeof q.id === 'string' ? store.mailAccounts.find((a) => a.id === q.id) : null;
  if (!acc) return say('bad', '그 메일 계정을 찾지 못했습니다.');
  // 답은 화면 줄과 같은 이름, 기록은 주소 없는 이름
  const name = shownName(acc);
  const label = labelFor(acc);

  // «다시 해 보기» — 서버 탓으로 멈춘 옮기기를 푼다. 다시 옮기기 시작하는 일이라 설정 창에서만 받는다
  if (q.retry === true) {
    if (!fromSettings || !parent) return say('bad', '«다시 해 보기»는 설정 창에서만 누를 수 있습니다.');
    const was = await retryMove(acc.id);
    if (!was) return say('wait', `${name} · 멈춘 옮기기가 없습니다.`);
    tidy.stopSaid.delete(acc.id);
    if (!tidyOnFor(acc)) return say('good', `${name} · 멈춤을 풀었습니다 — 서버 정리를 켜면 다시 옮겨 봅니다.`);
    // 켤 때 약속한 유예가 남았으면 앞당기지 않는다 — «그 전에 끄면 옮기지 않습니다»를 믿고 끄려는 사람이 있다
    const grace = (tidy.graceUntil.get(acc.id) || 0) - Date.now();
    kickTidy(Math.max(T.AGAIN_MS, grace), acc.id);
    if (grace > T.AGAIN_MS) return say('good', `${name} · 멈춤을 풀었습니다 — 켤 때 말한 대로 ${minutesOf(grace)}분쯤 뒤부터 옮깁니다. 그 전에 끄면 옮기지 않습니다.`);
    return say('good', `${name} · 멈춤을 풀었습니다 — 곧 다시 옮겨 봅니다.`);
  }

  const cur = tidyEntry(acc);
  const on = typeof q.on === 'boolean' ? q.on : cur.on;
  const days = q.days !== undefined ? tidyacct.normDays(q.days) : cur.days;
  if (on === cur.on && days === cur.days) return backupStatus();

  // 꺼진 채 기간만 바꿨다는 답 — «바로»는 기간이 아니다
  const onlyDays = () => say('good', days === 0
    ? `${name} · 꺼져 있어 옮기는 때만 «바로»로 바꿨습니다.`
    : `${name} · 꺼져 있어 기간만 ${days}일로 바꿨습니다.`);
  // 꺼진 채 기간만 바꿈 — 아무것도 옮기지 않으므로 묻지 않는다 (켤 때 그 기간으로 묻는다)
  if (!on && !cur.on) {
    store.setTidyAccount(acc.id, { days });
    return say('good', days === 0
      ? `${name} · 켜면 PC에 저장된 읽은 메일을 바로 옮깁니다.`
      : `${name} · 켜면 받은 지 ${days}일 지난 메일부터 옮깁니다.`);
  }
  // 끄기 — 그 계정만. 도는 중이면 그 계정은 다음 확인 지점에서 멈추고 다른 계정은 그대로 돈다
  if (!on && cur.on) {
    store.setTidyAccount(acc.id, { on: false, days });
    const was = tidy.running && tidy.current === acc.id;
    evlog.log('메일', `서버 정리 끔 · ${label}`);
    return say('good', was ? `${name} · 껐습니다 — 지금 묶음까지만 하고 멈춥니다.` : `${name} · 껐습니다.`);
  }
  // 켜진 채 기간 늘리기 — 덜 옮기는 쪽이라 묻지 않는다. 도는 정리는 shouldStop 으로 멈추고 새 기간으로 다시 돈다.
  // «바로»(0)에서 기간으로는 여기 오지 않는다 — 안 읽은 오래된 메일까지 옮기게 되므로 아래에서 묻는다
  if (cur.on && cur.days > 0 && days > cur.days) {
    store.setTidyAccount(acc.id, { days });
    evlog.log('메일', `서버 정리 기간 늘림 · ${label} · 받은 지 ${days}일 지난 것`);
    if (tidy.running && tidy.current === acc.id) kickTidy(T.AGAIN_MS, acc.id);
    return say('good', `${name} · 받은 지 ${days}일 지난 메일만 옮기도록 바꿨습니다.`);
  }

  // 여기부터는 위험해지는 요청 — 켜기, 켜진 채 기간 줄이기·«바로»로·«바로»에서 기간으로
  if (tidy.asking) return say('wait', '확인 창이 떠 있습니다 — 거기서 골라주세요.');
  // 백업 폴더를 옮기는 중 — 세는 일도 그 폴더의 기록을 읽는다. 옮긴 뒤 새 폴더로 묻는다
  if (moveHold()) return say('wait', holdWait());
  // preload 는 모든 창에 같다 — 남이 쓴 본문을 그리는 메일 보기 창도 mail:tidy-set 을 부를 수 있다. 켜진 정리를
  // «바로»로 바꾸거나 기간을 줄이는 것(더 옮기는 쪽)도 켜기와 똑같이 설정 창에서만 받는다
  if (!fromSettings || !parent) {
    return say('bad', cur.on ? '서버 정리는 설정 창에서만 바꿀 수 있습니다.' : '서버 정리는 설정 창에서만 켤 수 있습니다.');
  }
  const why = tidyWhy() || backupDirProblem(store.settings.mailBackupDir);
  if (why) return say('bad', why);
  const what = cur.on ? '기간을 바꾸지' : '켜지';
  if (acc.enabled === false) return say('bad', `${name} · 꺼 둔 계정이라 ${what} 않았습니다 — 설정 › 메일에서 계정을 먼저 켜세요.`);
  // 서버 탓으로 옮기기를 멈춘 계정 — 세지도 묻지도 않는다. 켜도 아무것도 옮기지 않는다
  const stopped = moveStoppedWhy(acc);
  if (stopped) return say('bad', `${name} · ${what} 않았습니다 — 이 서버에서는 옮기기를 멈췄습니다 (${stopped}). «다시 해 보기»를 먼저 누르세요.`);

  const lowering = cur.on;
  const before = { ...acc };
  let n = null;
  let r = null;
  let gone = false;
  let offNow = false;
  tidy.asking = true;
  tidy.askingId = acc.id;
  try {
    n = await countForConfirm(acc, days, countMs);
    // 세는 동안 설정 창을 닫았으면 묻지 않는다 — 부모 없이 뜬 창은 무엇을 묻는지 알 수 없다
    gone = typeof parent.isDestroyed === 'function' && parent.isDestroyed();
    // 기간을 줄이려고 세는 사이에 껐다 — 꺼진 정리의 기간은 아무것도 옮기지 않으므로 묻지 않는다
    offNow = lowering && !tidyEntry(acc).on;
    // 그 계정을 셀 수 없었다 — 켜도 매번 같은 까닭으로 아무것도 못 한다. 묻지 않고 그 까닭을 말한다
    if (!gone && !offNow && !n.refuse) {
      const held = !!store.settings.mailBackupDir && fillHolds(acc, store.settings.mailBackupDir);
      r = await popup.askUser(parent, tidyQuestion(acc, n, { days, from: cur.days, lowering, countMs, startMs, held }));
    }
  } finally {
    tidy.asking = false;
    tidy.askingId = null;
  }
  if (gone) return say('bad', '설정 창이 닫혀 그만뒀습니다 — 서버 메일은 그대로입니다.');
  if (offNow) {
    store.setTidyAccount(acc.id, { days });
    return onlyDays();
  }
  if (n.refuse) return say('bad', `${name} · ${what} 않았습니다 — ${n.refuse}`);
  if (r !== 0) return say('wait', '그만뒀습니다 — 서버 메일은 그대로입니다.');

  // 묻는 동안 바뀌었을 수 있다 — 저장 직전에 다시 본다
  const now = store.mailAccounts.find((a) => a.id === acc.id);
  if (!now) return say('bad', `확인하는 동안 계정이 지워졌습니다 — ${what} 않았습니다.`);
  if (!tidyacct.samePath(before, now)) return say('wait', '확인하는 동안 계정의 서버나 아이디가 바뀌었습니다 — 다시 눌러 주세요.');
  if (now.enabled === false) return say('bad', `확인하는 동안 계정을 껐습니다 — ${what} 않았습니다.`);
  const why2 = tidyWhy();
  if (why2) return say('bad', why2);
  if (lowering && !tidyEntry(acc).on) {
    // 묻는 사이에 껐다 — 끈 것이 이긴다. 기간만 남긴다
    store.setTidyAccount(acc.id, { days });
    return onlyDays();
  }
  store.setTidyAccount(acc.id, { on: true, days });
  const how = !lowering ? '켬' : days === 0 ? '«바로»로 바꿈' : cur.days === 0 ? '기간으로 바꿈' : '기간 줄임';
  evlog.log('메일', `서버 정리 ${how} · ${label} · ${days === 0 ? '읽은 메일 바로' : `받은 지 ${days}일 지난 것`}`
    + ` · 확인 때 ${Number(n && n.verified) || 0}통${n && n.complete ? '' : ' 이상'}`);
  tidy.stopSaid.delete(acc.id);
  tidy.graceUntil.set(acc.id, Date.now() + startMs);
  kickTidy(startMs, acc.id);
  const soon = `${minutesOf(startMs)}분쯤 뒤부터`;
  const held = !!store.settings.mailBackupDir && fillHolds(acc, store.settings.mailBackupDir);
  if (!lowering && held) return say('good', `${name} · 켰습니다 — 지난 메일을 다 받은 뒤부터 옮깁니다. 그 전에 끄면 옮기지 않습니다.`);
  if (!lowering) return say('good', `${name} · 켰습니다 — ${soon} 옮깁니다. 그 전에 끄면 옮기지 않습니다.`);
  if (days === 0) return say('good', `${name} · «바로»로 바꿨습니다 — ${soon} 적용됩니다.`);
  if (cur.days === 0) return say('good', `${name} · ${days}일로 바꿨습니다 — 안 읽은 메일도 그 기간이 지나면 옮깁니다.`);
  return say('good', `${name} · ${days}일로 줄였습니다 — 곧 적용됩니다.`);
}

// ── 지난 메일 뒤 받기 ─────────────────────────────────────────
//
// «언제 돌릴지»만 여기서 정한다 — 한 회차의 일은 src/mailfill.js 가 한다.
// 사용자의 답(mailFill)이 yes 인 계정만 연결을 만든다. 답을 스스로 yes 로 적는 길은 하나뿐이다:
// «백업 시작»으로 이미 전부 받은 계정(allBelow) — 그때 동의를 받았다.

const FILL_QUESTION_TITLE = '지난 메일도 PC로 받을까요?';   // 확인 창 (설계 4.2). 알림 제목과 한 글자 다르다
const FILL_ASK_TITLE = '지난 메일을 PC로 받을까요?';
const FILL_ASK_BODY = '새 메일은 이제 PC에 저장합니다. 눌러서 지난 메일을 받을지 고르세요.';
const FILL_ASK_LINE = '지난 메일을 PC로 받을까요? 눌러서 정하기';
const DIR_FULL = '공간이 모자랍니다 — 비우거나 다른 폴더를 고르세요.';
const GEN_NOTE_MS = 3600_000;    // 번호를 새로 매겼다는 줄을 위젯에 두는 시간
const DAY_MS = 24 * 3600_000;
const FILL_SEEN_MS = 3600_000;   // 앱이 돌고 있다고 적는 간격
// 기본 폴더 후보(defaultDirs)와 OneDrive 판정(underOneDrive)은 src/backuphome.js 에 있다 — node 로 시험한다

/** Electron 이 특수 폴더를 못 찾으면 던진다 — 후보 하나가 없다고 메일 확인이 멈추면 안 된다 */
function appPathOr(name) {
  try { return app.getPath(name); } catch { return ''; }
}

/** 쓸 수 있는 첫 후보 — 모두 실패하면 null 이고 다음 폴링 때 다시 본다 */
function firstGoodDir(list) {
  return list.find((x) => !backupDirProblem(x)) || null;
}

/** 항상 PC로 — 폴더를 잡고 자동 저장을 켠다. 메일 확인이 돌 때마다 불려도 값이 같으면 아무 일도 안 한다 */
function ensureLocalFirst() {
  // 앱을 켠 뒤 한 번 — 멈춘 옮기기를 알리고, 끝난 옮기기의 일지를 치운다
  checkMoveLeft();
  if (!store.mailAccounts.length || store.settings.mailEnabled !== true) return;
  // 먼저 끈다. 조건 미달로 쉬던 정리는 자동 저장을 켜는 순간 말없이 돈다 (store.js setSettings 가 금지한 일) — 모든 계정
  if (tidyacct.anyOn(store.settings.mailTidyAccounts) && !autoBackupOn()) {
    store.setGatedSettings({ mailTidyAccounts: tidyacct.allOff(store.settings.mailTidyAccounts) });
  }
  if (!store.settings.mailBackupDir) {
    // 쓸 만한 D: 가 있으면 맨 앞 후보 — 살피기는 패키지 실행에서만 한다 (defaultDirs 가 부른다). 못 살피면 D: 만 빠진다
    const d = firstGoodDir(defaultDirs({ home: appPathOr('home'), docs: appPathOr('documents'),
      userData: app.getPath('userData'), env: process.env, packaged: app.isPackaged,
      dataDrive: () => backuphome.probe('D') }));
    if (d) store.setGatedSettings({ mailBackupDir: d });
  }
  if (store.settings.mailAutoBackup !== true) store.setSettings({ mailAutoBackup: true });
}

function fillOn() {
  return T.FILL_ON && autoBackupOn();
}

function answerOf(acc) {
  return (store.settings.mailFill || {})[acc.id];
}

/** 끄지 않은 계정 — 비밀번호를 풀지 않는다 (틱·위젯 줄이 부른다) */
function liveAccounts() {
  return store.mailAccounts.filter((a) => a.enabled !== false);
}

/**
 * 서버 탓으로 옮기기를 멈춘 계정인가 (mailmove 일지 — 앱을 다시 켜도 남는다).
 * 그 계정은 정리가 한 통도 옮기지 않으므로 «정리가 쉰다»·«받은 뒤 옮겨진다»고 말하면 거짓말이다
 */
function moveStopped(acc) {
  return !!mailmove.journal().blocked(mailbackup.accountKey(acc));
}

/** 멈춘 까닭 (멈추지 않았으면 '') */
function moveStoppedWhy(acc) {
  const why = mailmove.journal().blocked(mailbackup.accountKey(acc));
  return why ? String(why) : '';
}

/** 폴링 연결이 읽은 서버 기능 한 줄을 둔다. 이번 실행에 처음 보거나 바뀌었을 때만 기록에 남긴다 (주소는 넣지 않는다) */
function noteCaps(acc, line) {
  if (!line) return;
  const k = mailbackup.accountKey(acc);
  const prev = serverCaps.get(k);
  serverCaps.set(k, { line, at: Date.now() });
  if (!prev || prev.line !== line) evlog.log('메일', mailtidy.maskAddr(`서버 기능 · ${labelFor(acc)} · ${line}`));
}

/**
 * 설정 창의 «다시 해 보기» — 서버 탓으로 멈춘 계정을 다시 자동 일(정리·스팸 규칙)에 넣는다.
 * 화면 연결은 계정별 설정 단계에서 한다. 여기서는 엔진만 연다
 * @returns 멈춰 있었나
 */
async function retryMove(id) {
  const acc = store.mailAccounts.find((a) => a.id === id);
  if (!acc) return false;
  const was = await mailmove.unblock(mailbackup.accountKey(acc));
  if (was) evlog.log('메일', `옮기기 다시 해 보기 · ${labelFor(acc)}`);
  return was;
}

function memoOf(acc) {
  if (!fill.memo.has(acc.id)) fill.memo.set(acc.id, {});
  return fill.memo.get(acc.id);
}

/** 그 계정의 서버 정리를 쉬어야 하나 — 멈춘 동안도 쉰다. no 로 두면 받아 둔 옛 메일이 다음 정리 때 옮겨진다 */
function fillHolds(acc, dir) {
  return ['yes', 'paused'].includes(answerOf(acc)) && !mailfill.isDone(acc, dir);
}

/** 앞쪽 연결이 생겼다 — 같은 계정의 회차만 끊는다. 다른 계정은 서버가 달라 겹쳐도 된다 */
function fillYield(acc) {
  if (fill.running && fill.ctl && sameAcc(fill.current, acc)) fill.ctl.abort('yield');
}

/** 돌고 있는 회차를 끊고 끝나기를 기다린다. 감시 타이머가 있어 반드시 돌아온다 */
async function fillHalt() {
  if (!fill.running) return;
  fill.ctl.abort('stop');
  await fill.turnDone;
}

/** 못 받은 통수 — 다 받아도 남는다. 상태 파일만 본다. fillFail(st:fail)은 다시 부를 일이고, fillBig(100MB 초과)은 다시 불러도 소용없다 */
function fillFailed(acc, dir, field = 'fillFail') {
  const per = mailbackup.loadState(dir)[mailbackup.accountKey(acc)] || {};
  return Object.values(per).reduce((sum, r) => sum + ((r && !r.fillSkip && Number(r[field])) || 0), 0);
}

/** 이 드라이브에 남길 바닥 — 시스템 드라이브는 받기만으로 윈도우가 멈출 만큼 채우면 안 된다 */
async function minFreeFor(dir) {
  const sys = String(process.env.SystemDrive || '').toLowerCase();
  if (!sys || !path.resolve(dir).toLowerCase().startsWith(sys)) return mailfill.MIN_FREE;
  const s = await fs.promises.statfs(dir);
  return Math.max(mailfill.SYSTEM_FREE, s.blocks * s.bsize * 0.05);
}

/**
 * 화면에 낼 남은 수. 첫 backupAccount 전에는 세지 않는다 — 빈 폴더 하나만 기록된 상태를 보고 판단할 수 있다.
 * 못 연 폴더가 있으면 합이 모자란다 — 모자란 수를 말하느니 모른다고 한다. 회차 중의 진행 보고도 이 길로 적는다
 */
function fillCountsOf(acc, dir) {
  const seen = fill.listed.get(acc.id);
  if (!seen) return { left: null, leftBytes: null, boxes: 0 };
  const n = mailfill.countPending(acc, dir);
  return seen.clean ? n : { ...n, left: null, leftBytes: null, rough: false };
}

/** 남은 수를 다시 세고, 이미 다 받은 계정이면 답을 적는다 */
function refreshFillCounts() {
  const dir = store.settings.mailBackupDir;
  for (const acc of liveAccounts()) {
    fill.counts.set(acc.id, fillCountsOf(acc, dir));
    const seen = fill.listed.get(acc.id);
    if (seen && seen.clean && !answerOf(acc) && mailfill.allBelow(acc, dir, seen.paths)) store.setFillAnswer(acc.id, 'yes');
  }
}

/**
 * 앱이 꺼져 있거나 PC 가 잠든 시간은 «나아가지 못한 날»이 아니다 — 보류의 시계(mailFillAt)를 그만큼 민다.
 * 한 시간마다 «돌고 있었다»를 적어 두고, 그보다 크게 벌어졌으면 그동안 꺼져 있던 것이다. 그래야 연휴 뒤에 «4일째 나아가지 못함»과 빨간 «정리 허용»이 안 뜨고,
 * 밤마다 끄는 PC 에서도 돈 시간이 쌓여 언젠가는 알린다 (실행마다 시계를 새로 걸면 영영 안 알린다)
 */
function fillClock(now) {
  const seen = Number(store.settings.mailFillSeen) || 0;
  if (seen && now - seen < FILL_SEEN_MS) return;
  const gap = seen ? now - seen : 0;
  if (gap >= 2 * FILL_SEEN_MS) {
    for (const [id, at] of Object.entries(store.settings.mailFillAt || {})) store.setFillAt(id, Math.min(now, at + gap));
  }
  store.setFillSeen(now);
}

/** 다 못 받았는데 나아가지 못하는 계정인가. 정리가 그 때문에 쉬므로 메일함이 차기 전에 사용자가 알아야 한다 */
function fillStuck(acc) {
  const dir = store.settings.mailBackupDir;
  if (answerOf(acc) !== 'yes' || !tidyEntry(acc).on) return false;
  if (moveStopped(acc)) return false;
  const now = Date.now();
  const at = (store.settings.mailFillAt || {})[acc.id];
  if (!at) {
    store.setFillAt(acc.id, now);
    return false;
  }
  // 이번 실행에서 회차를 돌려 본 뒤에만 판단한다 — 켠 뒤 5분 동안은 해 보지도 않고 «못 나아갔다»고 말하게 된다
  if (!(fill.memo.get(acc.id) || {}).firstDone) return false;
  return now - at > T.FILL_STUCK_MS && !mailfill.isDone(acc, dir);
}

const stuckDaysOf = (acc) => Math.floor((Date.now() - ((store.settings.mailFillAt || {})[acc.id] || 0)) / DAY_MS);

/** 위젯에 낼 줄 — 동기·저렴. 메모리만 본다 (오래 멈춤 판정은 틱이 stuckLine 에 적어 둔다) */
function fillAskLine() {
  if (!fillOn()) return '';
  const accs = liveAccounts();
  const now = Date.now();
  for (const acc of accs) {
    const note = (fill.memo.get(acc.id) || {}).genNote;
    if (note && answerOf(acc) === 'yes' && now - note.at < GEN_NOTE_MS) {
      return note.n ? `서버가 메일 번호를 새로 매겨 ${note.n}통을 다시 받습니다` : '서버가 메일 번호를 새로 매겨 메일을 다시 받습니다';
    }
  }
  if (fill.stuckLine) return fill.stuckLine;
  // 남은 수를 센 뒤에만 묻는다 — 이미 다 받은 계정(allBelow)이 틱 사이에 잠깐 물어보는 일이 없게
  const asking = accs.some((a) => fill.listed.has(a.id) && fill.counts.has(a.id)
    && (!answerOf(a) || answerOf(a) === 'asked'));
  return asking ? FILL_ASK_LINE : '';
}

/** 서버가 UID 를 새로 매겼다 — 묻지 않고 전체를 다시 받으므로 알린다 */
function noteRenumbered(acc, dir) {
  if (answerOf(acc) !== 'yes') return;
  const n = mailfill.countPending(acc, dir).left;
  memoOf(acc).genNote = { at: Date.now(), n };
  evlog.log('메일', `지난 메일 · ${labelFor(acc)} · 서버가 메일 번호를 새로 매겨 다시 받음`);
}

/** 묻는 창의 글 (4.2). n 은 폴더별 exists 의 합이다 — 파일 수를 빼면 실제보다 적게 말할 수 있어 위로 잡은 값을 쓴다 */
function fillQuestion(acc, n, { dir, tidy: tidyIsOn = false, days = 30, oneDrive = false, noMove = false, floorGB = 2 } = {}) {
  const name = acc.name || acc.user;
  const warn = tidyIsOn && !noMove;
  const detail = [
    `저장할 곳: ${dir}`,
    '최신 메일부터 뒤에서 조금씩 받습니다. 느린 서버는 며칠 걸릴 수 있습니다. 끊겨도 앱을 다시 켜면 이어 받습니다. 멈추면 «이어 받기»를 누를 때까지 쉽니다.',
    `필요한 용량은 전체 목록을 받은 뒤 받는 동안 설정 창에 보입니다. 다 받으면 이 드라이브의 여유 공간이 ${floorGB}GB 아래로 내려갈 양이면 시작하지 않습니다.`,
    '서버의 메일과 읽음 표시는 바뀌지 않습니다. 알림·자동 전달·규칙은 지난 메일에 돌지 않습니다.',
    '스팸·휴지통·공유 폴더는 받지 않습니다. 100MB를 넘는 메일도 받지 않습니다. 못 받은 메일은 수를 보여 줍니다.',
    '받지 않아도 새 메일과 열어 본 메일은 저장합니다.'
  ];
  if (warn) detail.push(`서버 정리가 켜져 있습니다. 받는 동안과 멈춘 동안 이 계정은 정리를 쉽니다. 다 받으면 받은 메일 중 ${tidyWhat(days)}도 서버 휴지통으로 옮겨져 웹메일·폰에서 사라집니다.`);
  if (oneDrive) detail.push('이 폴더는 OneDrive 안에 있어 메일이 클라우드로 올라갑니다.');
  return {
    title: FILL_QUESTION_TITLE,
    message: n > 0
      ? `${name} · 서버의 지난 메일을 최대 ${n}통 이 PC로 받아 둡니다.`
      : `${name} · 서버의 지난 메일을 이 PC로 받아 둡니다. 몇 통인지는 아직 세지 못했습니다.`,
    detail: detail.join('\n'),
    buttons: ['받기', '받지 않기'],
    defaultId: 0,
    // 초점은 «받지 않기»에 — 늦게 뜬 창에 다른 데 치던 Enter 가 들어가 받기 시작하면 안 된다
    focusId: 1,
    armMs: 800,
    ...(warn ? { danger: true } : {})
  };
}

/** 설정 창의 본 문서에서 왔나 — 그 안에 낀 틀(iframe)은 믿지 않는다 (autofwd.js 와 같다. preload 가 모든 창에 같다) */
const mainFrameOf = (e) => {
  const f = e && e.senderFrame;
  const m = e && e.sender && e.sender.mainFrame;
  return !!f && !!m && f.processId === m.processId && f.routingId === m.routingId;
};

/** 정리 허용 단추를 보일까 — 쉬고 있어야 풀 것이 있고, 도는 중에는 먼저 멈춘 뒤에 고른다 */
function canRelease(acc, dir) {
  return fillHoldsTidy(acc, dir) && (answerOf(acc) === 'paused' || fillStuck(acc));
}

/** 그 계정 때문에 서버 정리가 실제로 쉬고 있나 — 옮기기를 멈춘 계정은 어차피 안 옮기므로 쉰다고 말하면 거짓말이다 */
function fillHoldsTidy(acc, dir) {
  return tidyEntry(acc).on && !moveStopped(acc) && fillHolds(acc, dir);
}

/**
 * 지난 메일 받기 — 메인 쪽 확인 문. 켜는 쪽은 설정 창에서만 받고, 멈추기는 어느 창에서 와도 받는다.
 * 메일을 내려받기 시작하는 일과 서버 정리를 다시 허용하는 일은 확인 창을 거친다.
 * @returns BackupStatus
 */
async function setFill(req, parent, { fromSettings = false } = {}) {
  const q = req && typeof req === 'object' ? req : {};
  // 답은 요청마다 새로 쓴다 — 지난 요청의 말이 남아 엉뚱한 때 다시 보이지 않게
  fill.message = '';
  fill.messageKind = '';
  const say = (kind, text) => {
    fill.messageKind = kind;
    fill.message = text;
    return backupStatus();
  };
  const acc = store.mailAccounts.find((a) => a.id === q.id);
  if (!acc) return say('bad', '그 메일 계정을 찾지 못했습니다.');
  const dir = store.settings.mailBackupDir;
  const label = labelFor(acc);
  const cutTurn = () => { if (fill.running && sameAcc(fill.current, acc)) fill.ctl.abort('stop'); };
  // 받기로 답한 순간부터 보류의 시계가 간다 — 멈춘 동안의 날짜를 «나아가지 못했다»로 세지 않게
  const startFill = () => {
    store.setFillAnswer(acc.id, 'yes');
    store.setFillAt(acc.id, Date.now());
    fill.nextAt = 0;
  };

  if (q.on === false) {
    const was = answerOf(acc);
    // 멈춘 것을 다시 눌러도 멈춘 채다. no 로 내리면 이 요청 하나(어느 창에서든 온다)로 정리 보류가 풀린다 — 그건 «정리 허용»의 몫이다
    store.setFillAnswer(acc.id, was === 'yes' || was === 'paused' ? 'paused' : 'no');
    cutTurn();
    fill.stuckLine = '';
    return say('good', '지난 메일 받기를 멈췄습니다. 새 메일과 열어 본 메일은 계속 저장합니다.'
      + (fillHoldsTidy(acc, dir) ? ' 서버 정리는 이 계정을 계속 쉽니다.' : ''));
  }
  if (q.on !== true && q.release !== true) return backupStatus();

  // 여기부터 켜는 쪽이다
  if (fill.asking) return say('wait', '확인 창이 떠 있습니다 — 거기서 골라주세요.');
  if (!fromSettings || !parent) return say('bad', '지난 메일 받기는 설정 창에서만 켤 수 있습니다.');
  // 백업 폴더를 옮기는 중 — 끝나면 폴더가 바뀐다
  if (moveHold()) return say('wait', holdWait());
  // 폴더 대화상자가 떠 있다 — 지금 묻는 폴더는 곧 바뀔 수 있다. 창에 적힌 폴더와 다른 곳에 받기 시작하면 안 된다
  if (fill.picking) return say('wait', '폴더를 고르는 중입니다 — 고른 뒤 다시 눌러주세요.');
  // 창이 떠 있는 동안 폴더가 바뀌었다 (창은 모달이 아니다). 그 답은 옛 폴더에 대한 것이라 적지 않는다
  const dirMoved = () => store.settings.mailBackupDir !== dir;
  const stale = () => say('wait', '폴더가 바뀌어 그만뒀습니다 — 다시 눌러주세요.');

  if (q.release === true) {
    if (!canRelease(acc, dir)) return say('wait', '지금은 쉬고 있는 서버 정리가 없습니다.');
    const n = mailfill.countPending(acc, dir).left;
    let r = null;
    fill.asking = true;
    try {
      r = await popup.askUser(parent, {
        title: '이 계정의 서버 정리를 다시 허용할까요?',
        message: `받아 둔 메일 중 ${tidyWhat(daysOf(acc))}이 서버 휴지통으로 옮겨져 웹메일·폰에서 사라집니다. 남은 ${n == null ? '메일' : `${n}통`}은 받지 않습니다.`,
        buttons: ['정리 허용', '그만두기'],
        defaultId: 0,
        danger: true,
        focusId: 1,
        armMs: 800
      });
    } finally {
      fill.asking = false;
    }
    if (r !== 0) return say('wait', '그만뒀습니다.');
    if (dirMoved()) return stale();
    store.setFillAnswer(acc.id, 'no');
    cutTurn();
    fill.stuckLine = '';
    evlog.log('메일', `지난 메일 · ${label} · 정리 허용`);
    return say('good', '이 계정의 서버 정리를 다시 허용했습니다.');
  }

  if (answerOf(acc) === 'paused') {
    // 이미 동의했으므로 다시 묻지 않는다
    startFill();
    return say('good', '이어 받습니다.');
  }
  // 이미 받는 중 — 묻고 «받지 않기»가 눌리면 정리 보류까지 확인 없이 풀린다
  if (answerOf(acc) === 'yes') return backupStatus();
  if (!dir) return say('bad', '저장할 폴더를 먼저 고르세요.');
  const bad = backupDirProblem(dir);
  if (bad) return say('bad', bad);

  const seen = fill.listed.get(acc.id);
  const n = seen && seen.clean ? mailfill.countPending(acc, dir).left : null;
  let r = null;
  fill.asking = true;
  try {
    let floor = mailfill.MIN_FREE;
    try { floor = await minFreeFor(dir); } catch { /* 모르면 기본 바닥을 말한다 */ }
    r = await popup.askUser(parent, fillQuestion(acc, n, {
      dir,
      tidy: tidyEntry(acc).on,
      days: daysOf(acc),
      oneDrive: underOneDrive(dir, process.env),
      noMove: moveStopped(acc),
      floorGB: Math.ceil(floor / 1024 ** 3)
    }));
  } finally {
    fill.asking = false;
  }
  if ((r === 0 || r === 1) && dirMoved()) return stale();
  if (r === 0) {
    startFill();
    evlog.log('메일', `지난 메일 받기 켬 · ${label}${n > 0 ? ` · 최대 ${n}통` : ''}`);
    return say('good', '지난 메일을 뒤에서 받기 시작합니다.');
  }
  if (r === 1) {
    store.setFillAnswer(acc.id, 'no');
    return say('good', '받지 않습니다. 새 메일과 열어 본 메일은 계속 저장합니다.');
  }
  return say('wait', '그만뒀습니다.');
}

/** 회차가 지금 돌 차례인가. 다 받은 계정은 연결을 만들지 않는다 — 못 받은 메일이 남았으면 하루에 한 번만 다시 부른다 */
function fillDue(acc, dir, now) {
  if (!mailfill.isDone(acc, dir)) return true;
  if (fillFailed(acc, dir) <= 0) return false;
  return mailfill.retryDue(acc, dir, memoOf(acc), now);
}

/**
 * 이번 회차의 계정 — 지난번 다음부터 차례로 하나. 실제로 시작할 계정일 때만 차례를 넘긴다.
 * 시작을 거부한 뒤에 넘기면 조용한 시간이 풀리는 첫 틱의 차례가 언제나 느린 계정이어서, 빠른 계정이 느린 계정이 끝날 때까지 굶는다.
 */
function pickFillAccount(dir, now) {
  // 비밀번호를 푸는 길(mailAccountsForUse)은 받을 계정이 있을 때만 — 다 받은 사람도 30초마다 틱이 돈다
  const due = liveAccounts().filter((a) => answerOf(a) === 'yes' && fillDue(a, dir, now));
  if (!due.length) return null;
  const usable = host.mailAccountsForUse() || [];
  // 비밀번호를 못 풀어 빠진 계정 — 회차가 영영 안 돈다. 화면이 «잠시 뒤»라고 하지 않게 적어 둔다
  for (const a of due) memoOf(a).unusable = !usable.some((u) => sameAcc(u, a));
  const remain = host.nextPollAt() - now - T.FILL_POLL_MARGIN_MS;
  for (let i = 0; i < usable.length; i++) {
    const j = (fill.rr + i) % usable.length;
    const acc = usable[j];
    if (!due.some((a) => sameAcc(a, acc))) continue;
    const memo = memoOf(acc);
    const front = mail.frontState(acc);
    // 앞쪽 연결이 그 뒤 폴더를 열었으면 비밀번호는 맞다 — 일시 거절을 잘못 멈춘 것이다
    if (memo.authOff && front.okAt > (memo.authAt || 0)) memo.authOff = false;
    if (memo.authOff || (memo.retryAt || 0) > now) continue;
    if (front.busy || now - front.last < T.FILL_QUIET_MS) continue;
    // 다음 폴링 피하기는 거부권이 아니다. 앞쪽 연결 직후에는 남은 시간과 상관없이 시작한다 —
    // 거부권이면 주기 2분에서 회차가 영영 돌지 않는다. 폴링이 오면 훅이 끊고, 비킴은 실패가 아니다
    if (now - front.last > T.FILL_FRESH_MS && remain < Math.max(T.FILL_MIN_TURN_MS, (memo.setupMs || 0) * 2)) continue;
    fill.rr = j + 1;
    return acc;
  }
  return null;
}

/** 옛 파일을 색인에 맞춘다. 서버를 부르지 않고, 회차를 막지 않는다 (색인 쓰기는 폴더별 줄이 직렬화한다) */
async function scanOldFiles(dir) {
  for (const acc of liveAccounts()) {
    if (fillHolds(acc, dir)) continue;
    // 다 받은 계정의 답도 yes 다 — 답이 «지금» yes 로 바뀐 때만 비킨다 (회차가 같은 폴더를 맡는다)
    const wasYes = answerOf(acc) === 'yes';
    // 백업 폴더를 옮기기 시작해도 멈춘다 — 색인 파일을 쓴다. 옮긴 뒤 다시 돈다 (fill.scanned 를 내린다)
    await mailfill.scanAccount(acc, dir, {
      shouldStop: () => !fillOn() || moveHold() || store.settings.mailBackupDir !== dir || (!wasYes && answerOf(acc) === 'yes')
    }).catch(() => {});
  }
}

/** 회차의 결과를 받아 다음 일을 정한다 */
function fillTurnEnd(acc, memo, r, label) {
  const now = Date.now();
  memo.firstDone = true;
  memo.why = r.why;
  // 거절의 까닭은 보여 준다 — 하루 한도·속도 제한·IMAP 꺼짐·웹 로그인·동시 연결은 비밀번호 탓이 아니고, 안 보이면 왜 쉬는지 알 수 없다.
  // 다만 «비밀번호를 넣으세요»로 옮겨진 글은 감춘다 — 일시 거절에 맞는 비밀번호를 다시 넣게 된다
  memo.error = r.why === 'refused' && /비밀번호/.test(r.error || '') ? null : r.error || null;
  memo.boxErrors = r.boxErrors || [];
  // 폴더 오류뿐인 회차는 물러나기를 타려고 why 가 connect 다. 사유에 폴더 경로가 들어 있다
  const folderOnly = memo.boxErrors.length > 0 && memo.boxErrors.includes(r.error);
  // 연결 탓이 아닌 물러나기 — 화면이 «연결 실패»라고 하면 사용자가 서버를 의심한다
  memo.retryPlain = folderOnly || r.why === 'write' || r.why === 'state';
  memo.need = r.why === 'disk' ? r.need || null : null;
  if (r.genUp) noteRenumbered(acc, store.settings.mailBackupDir);
  // 나아갔으면 보류의 시계를 다시 건다
  if (r.heads || r.saved) store.setFillAt(acc.id, now);
  const backOff = () => {
    memo.strikes = (memo.strikes || 0) + 1;
    return T.FILL_RETRY_MS[Math.min(memo.strikes - 1, T.FILL_RETRY_MS.length - 1)];
  };
  switch (r.why) {
    case 'done': {
      memo.strikes = 0;
      memo.retryAt = 0;
      // 못 받은 메일을 다시 불러도 같은 결과면 하루마다 같은 줄을 쌓지 않는다
      const sig = `done/${r.failed || 0}`;
      if (memo.doneSig !== sig) {
        memo.doneSig = sig;
        evlog.log('메일', `지난 메일 · ${label} · 모두 받음 · 못 받음 ${r.failed || 0}통`);
      }
      break;
    }
    case 'budget':
    case 'stop':
    case 'yield':
      memo.strikes = 0;
      memo.retryAt = 0;
      if (r.why !== 'yield' && (r.heads || r.saved)) evlog.log('메일', `지난 메일 · ${label} · 머리 ${r.heads}통 · 본문 ${r.saved}통`);
      // 끊겨서 아무것도 못 받은 회차가 이어진다 — 연결 준비나 첫 줄이 폴링 창보다 길다. 비킴은 실패가 아니지만 그대로 두면 폴링마다 로그인만 쌓이고 끝나지 않는다
      if (r.noGain) {
        memo.idle = (memo.idle || 0) + 1;
        if (memo.idle >= T.FILL_IDLE_TURNS) {
          memo.retryAt = now + T.FILL_RETRY_MS[Math.min(memo.idle - T.FILL_IDLE_TURNS, T.FILL_RETRY_MS.length - 1)];
          memo.retryPlain = true;
          memo.error = '서버가 느려 메일 확인 사이에 받지 못합니다';
          if (memo.idle === T.FILL_IDLE_TURNS) evlog.log('메일', `지난 메일 · ${label} · 끊겨서 아무것도 못 받은 회차가 이어져 간격을 늘림`);
        }
      } else if (r.why !== 'stop') {
        memo.idle = 0;
      }
      break;
    case 'disk':
      fill.nextAt = now + T.FILL_CHECK_DISK_MS;
      evlog.log('메일', `지난 메일 · ${label} · 공간이 모자라 멈춤`);
      break;
    case 'refused':
      // 연결 수 제한이나 일시 거절일 수 있다. 비밀번호 안내를 내지 않는다
      memo.retryAt = now + Math.max(T.FILL_REFUSED_MS, backOff());
      evlog.log('메일', r.limit ? mailtidy.maskAddr(`지난 메일 · ${label} · 서버가 받기를 잠시 거절 · ${r.error || ''}`)
        : `지난 메일 · ${label} · 서버가 로그인을 잠시 거절`);
      break;
    case 'auth':
      // 계정 잠김을 부르지 않기 위해 그 계정을 안 부른다. 같은 계정의 앞쪽 연결이 폴더를 열면 푼다
      memo.authOff = true;
      memo.authAt = now;
      evlog.log('메일', `지난 메일 · ${label} · 로그인이 거절돼 멈춤`);
      break;
    case 'write':
      // 사유에 폴더 경로가 들어 있다 — 기록에는 남기지 않는다. 화면은 error 로 본다
      memo.retryAt = now + backOff();
      evlog.log('메일', `지난 메일 · ${label} · 폴더에 쓰지 못해 쉼`);
      break;
    default: {   // state, connect
      memo.retryAt = now + backOff();
      // 폴더 오류와 상태 파일 오류의 사유에는 경로가 들어 있다 — 기록에는 남기지 않는다. 화면은 error 로 본다
      const why = folderOnly ? `폴더 ${memo.boxErrors.length}개를 열지 못함`
        : r.why === 'state' ? '진행 기록을 읽거나 쓰지 못해 쉼'
          : `${r.why} 실패 · ${r.error || ''}`;
      evlog.log('메일', mailtidy.maskAddr(`지난 메일 · ${label} · ${why}`));
    }
  }
}

/**
 * 30초마다 main.js 가 부른다. 던지지 않는다.
 * 답 쓰기는 잠금 앞이다 — listed 가 첫 backupAccount 가 끝난 뒤에만 서므로 안전하다.
 */
async function fillTick() {
  try {
    await fillTickOnce();
  } catch (e) {
    evlog.log('메일', `지난 메일 · 틱 실패 · ${(e && (e.code || e.name)) || '오류'}`);   // 글에는 경로가 들어 있을 수 있다
  }
}

async function fillTickOnce() {
  if (!fillOn() || fill.running || fill.picking || moveHold()) return;
  const dir = store.settings.mailBackupDir;
  fillClock(Date.now());

  if (fill.dirty) {
    fill.dirty = false;
    refreshFillCounts();
  }
  const stuck = liveAccounts().find((a) => fillStuck(a));
  fill.stuckLine = stuck
    ? `${stuck.name || stuck.user} · 지난 메일 받기가 ${stuckDaysOf(stuck)}일째 나아가지 못해 서버 정리도 쉬고 있습니다. 눌러서 확인`
    : '';

  // 묻기 — 창을 띄우지 않는다. 알림은 한 번만 (asked). 답하지 않아도 잃는 것이 없다: 새 메일은 이미 저장 중이다
  const unasked = liveAccounts().filter((a) => fill.listed.has(a.id) && !answerOf(a) && !mailfill.allBelow(a, dir));
  if (unasked.length && !host.holdReason(0)) {
    for (const a of unasked) store.setFillAnswer(a.id, 'asked');
    try { host.notifyFill(FILL_ASK_TITLE, FILL_ASK_BODY); } catch { /* 위젯 줄이 남는다 */ }
  }

  if (!fill.scanned) {
    fill.scanned = true;
    // 기다리지 않는다 — 다만 백업 폴더 옮기기가 끝나기를 기다릴 수 있게 쥐어 둔다
    const scan = scanOldFiles(dir).catch(() => {});
    fill.scan = scan;
    scan.then(() => { if (fill.scan === scan) fill.scan = null; });
  }

  if (backup.running || autoBackup.running || tidy.running || tidy.asking || host.forwardBusy()) return;
  const now = Date.now();
  if (now < fill.nextAt) return;

  const acc = pickFillAccount(dir, now);
  if (!acc) return;
  const memo = memoOf(acc);
  const remain = host.nextPollAt() - now - T.FILL_POLL_MARGIN_MS;
  // 연결 준비가 몫을 다 쓰면 LIST 도 못 남겨 다음 회차가 처음부터다 — 준비 시간의 두 배까지 몫을 준다
  const base = Math.max(memo.firstDone ? T.FILL_TURN_MS : T.FILL_FIRST_TURN_MS, Math.min((memo.setupMs || 0) * 2, T.FILL_BIG_TURN_MS));
  const budgetMs = remain >= T.FILL_MIN_TURN_MS ? Math.min(base, remain) : base;

  // 첫 await 전에 자리를 잡는다
  const turnId = ++fill.turnId;
  const ctl = new AbortController();
  let finish;
  fill.running = true;
  fill.current = acc;
  fill.ctl = ctl;
  fill.turnDone = new Promise((res) => { finish = res; });
  Object.assign(memo, { saved: 0, box: '', phase: '' });
  const label = labelFor(acc);

  // 감시 타이머 — 무엇이 걸려도 회차는 끝난다. 그래야 «멈추기»와 폴더 바꾸기가 앱 재시작까지 멈추지 않는다.
  // 늦게 돌아온 옛 회차의 결과는 경주에서 버려지고, 진행 보고는 회차 번호로 버린다
  let forceEnd;
  const forced = new Promise((res) => { forceEnd = res; });
  let watch = null;
  const armWatch = (ms) => {
    clearTimeout(watch);
    watch = setTimeout(() => {
      ctl.abort('stop');
      forceEnd({ why: 'stop', heads: 0, saved: 0, forced: true });
    }, ms + T.FILL_WATCH_MS);
  };
  armWatch(budgetMs);

  let r;
  try {
    const bad = backupDirProblem(dir);
    // 디스크가 정말 찼다 — 폴더 탓으로 말하면 다른 폴더를 고르게 된다
    r = bad === DIR_FULL ? { why: 'disk', heads: 0, saved: 0 } : bad ? { why: 'write', error: bad, heads: 0, saved: 0 } : await Promise.race([
      mailfill.fillAccount(acc, dir, {
        connect: (a) => mail.connect(a, { timeoutMs: 90_000, background: true }),
        signal: ctl.signal,
        budgetMs,
        bigTurnMs: T.FILL_BIG_TURN_MS,
        dirProblem: backupDirProblem,
        // 바닥을 적어 둔다 — 화면이 «{floor}GB 넘게 비우면»을 말하려면 회차가 쓴 값을 알아야 한다
        minFree: async (d) => {
          memo.floor = await minFreeFor(d);
          return memo.floor;
        },
        shouldStop: () => !fillOn() || answerOf(acc) !== 'yes' || !host.accountLive(acc),
        onProgress: (p) => {
          if (turnId !== fill.turnId) return;
          Object.assign(memo, { phase: p.phase, box: p.box, saved: p.saved });
          if (p.extendMs) armWatch(p.extendMs);
          fill.counts.set(acc.id, fillCountsOf(acc, dir));
        },
        memo
      }),
      forced
    ]);
  } catch (e) {
    r = { why: 'connect', error: mail.friendly(e), heads: 0, saved: 0 };
  } finally {
    clearTimeout(watch);
  }
  if (r.forced) evlog.log('메일', `지난 메일 · ${label} · 회차가 돌아오지 않아 강제로 끝냄`);
  try {
    fillTurnEnd(acc, memo, r, label);
  } finally {
    fill.running = false;
    fill.current = null;
    fill.dirty = true;
    fill.nextAt = Math.max(fill.nextAt, Date.now() + T.FILL_GAP_MS);
    finish();
  }
}

/** 설정 화면이 보는 뒤 받기 상태. 답이 없는 계정도 줄을 낸다 — 화면이 «정하기» 단추를 그린다 */
function fillStatus() {
  const dir = store.settings.mailBackupDir;
  const now = Date.now();
  const stateOf = (acc, memo, running) => {
    if (running) return fill.ctl.signal.aborted && fill.ctl.signal.reason === 'yield' ? 'yielding' : 'running';
    if (answerOf(acc) !== 'yes' || mailfill.isDone(acc, dir)) return 'idle';
    if (memo.unusable) return 'unusable';
    if (memo.authOff) return 'auth';
    if (memo.why === 'disk') return 'disk';
    if ((memo.retryAt || 0) > now) return memo.why === 'refused' ? 'refused' : 'retry';
    return memo.why === 'yield' ? 'yielding' : 'waiting';
  };
  return {
    on: !!fillOn(),
    oneDrive: !!dir && underOneDrive(dir, process.env),
    message: fill.message,
    messageKind: fill.messageKind,
    asking: fill.asking,
    accounts: liveAccounts().map((acc) => {
      const memo = fill.memo.get(acc.id) || {};
      const seen = fill.listed.get(acc.id);
      const n = fill.counts.get(acc.id) || {};
      const running = fill.running && sameAcc(fill.current, acc);
      const stuck = fillStuck(acc);
      return {
        id: acc.id,
        name: acc.name || acc.user,
        listed: !!seen,
        answer: answerOf(acc) || null,
        left: n.left == null ? null : n.left,
        leftRough: !!n.rough,
        leftBytes: n.leftBytes == null ? null : n.leftBytes,
        failed: fillFailed(acc, dir) + fillFailed(acc, dir, 'fillBig'),
        canRetry: fillFailed(acc, dir) > 0,
        unfillable: mailfill.unfillable(acc, dir),
        done: mailfill.isDone(acc, dir),
        holdsTidy: fillHoldsTidy(acc, dir),
        canRelease: canRelease(acc, dir),
        stuckDays: stuck ? stuckDaysOf(acc) : 0,
        needBytes: memo.need || null,
        floorBytes: memo.floor || null,
        boxErrors: [...((seen && seen.boxErrors) || []), ...(memo.boxErrors || [])],
        state: stateOf(acc, memo, running),
        phase: running ? memo.phase || '' : '',
        box: running ? memo.box || '' : '',
        saved: memo.saved || 0,
        retryMin: (memo.retryAt || 0) > now ? minutesOf(memo.retryAt - now) : 0,
        retryPlain: !!memo.retryPlain,
        error: memo.error || null
      };
    })
  };
}

ipcMain.handle('mail:backup-status', () => backupStatus());

// 보낸 창(설정 창)을 넘긴다 — «기존 메일 백업도 옮길까요?»를 그 위에 띄운다
ipcMain.handle('mail:backup-pick', (e) => pickDir(BrowserWindow.fromWebContents(e.sender)));

// 설정 창의 본 문서에서 온 것만 «설정 창에서»로 친다 — 그 안에 낀 틀(iframe)이 켜기·«다시 해 보기»를 부탁하면 거절한다
ipcMain.handle('mail:tidy-set', (e, req) => setTidy(req, BrowserWindow.fromWebContents(e.sender),
  { fromSettings: !!host.isSettingsWin(e.sender) && mainFrameOf(e) }));

ipcMain.handle('mail:fill-set', (e, req) => setFill(req, BrowserWindow.fromWebContents(e.sender),
  { fromSettings: !!host.isSettingsWin(e.sender) && mainFrameOf(e) }));

/** 설정에 있는 계정의 폴더 이름 — 이전 폴더에서 Hibi 계정 폴더를 알아보는 데 쓴다 (메일함 이름은 보지 않는다) */
function accountDirNames(dir) {
  return store.mailAccounts.map((a) => path.basename(path.dirname(mailbackup.boxDirFor(dir, a, 'INBOX', 1))));
}

/** 이전 폴더에서 옮길 것을 센다 — 못 세면 null (그러면 예전처럼 묻지 않고 바꾼다) */
async function planMove(old, p) {
  try { return await backupmove.plan(old, p, { known: accountDirNames(old) }); } catch { return null; }
}

/** «옮기지 않고 새 폴더만 쓰기»가 하는 일 한 줄 — 정리가 켜졌거나 지난 메일 답이 있을 때만 */
function newOnlyNote() {
  const tidyOn = tidyacct.anyOn(store.settings.mailTidyAccounts);
  const answered = Object.keys(store.settings.mailFill || {}).length > 0;
  if (tidyOn && answered) return '옮기지 않고 새 폴더만 쓰면 모든 계정의 서버 정리를 끄고, 지난 메일 받기는 새 폴더에서 다시 묻습니다.';
  if (tidyOn) return '옮기지 않고 새 폴더만 쓰면 모든 계정의 서버 정리를 끕니다.';
  if (answered) return '옮기지 않고 새 폴더만 쓰면 지난 메일 받기는 새 폴더에서 다시 묻습니다.';
  return '';
}

/** «기존 메일 백업도 옮길까요?» — 수·크기, 남겨 둘 항목, 휴지통, 쉬는 일 */
function moveQuestion(pl) {
  const detail = [`이전 폴더: ${pl.from}`, `새 폴더: ${pl.to}`];
  if (pl.unknown.length) detail.push(`Hibi 것이 아닌 항목 ${pl.unknown.length}개는 그대로 둡니다.`);
  detail.push('다 옮긴 뒤 이전 폴더의 백업은 휴지통으로 보냅니다. 옮기는 동안 백업·정리·지난 메일 받기는 쉽니다.');
  const note = newOnlyNote();
  if (note) detail.push(note);
  return {
    title: MOVE_TITLE,
    message: `이전 폴더의 메일 백업(파일 ${pl.files}개 · ${backupmove.sizeText(pl.bytes)})을 새 폴더로 옮깁니다.`,
    detail: detail.join('\n'),
    buttons: ['옮기기', NEW_ONLY, '그만두기'],
    defaultId: 0,
    focusId: 0
  };
}

/**
 * 옮길 수 없을 때 — 까닭을 말하고 새 폴더만 쓰기·그만두기만. 초점은 그만두기 (아무것도 안 바뀐다).
 * newOnly 가 거짓이면 그만두기만 — 새 폴더에 옮기다 멈춘 조각이 있거나(그 조각을 백업 폴더로 쓰게 된다) 옮기기가 멈춘 채다
 */
function cantMoveQuestion(pl, newOnly = true) {
  const detail = [`이전 폴더: ${pl.from}`, `새 폴더: ${pl.to}`];
  if (newOnly) {
    detail.push('새 폴더만 쓰면 이전 폴더의 백업은 그대로 둡니다.');
    const note = newOnlyNote();
    if (note) detail.push(note);
  } else {
    detail.push('아무것도 바꾸지 않았습니다.');
  }
  const buttons = newOnly ? [NEW_ONLY, '그만두기'] : ['그만두기'];
  return {
    title: '기존 메일 백업은 옮길 수 없습니다',
    message: pl.problem,
    detail: detail.join('\n'),
    buttons,
    defaultId: buttons.length - 1,
    focusId: buttons.length - 1
  };
}

/** «옮기다 멈춘 메일 백업을 이어서 옮길까요?» — 새 폴더에 이 이전 폴더의 일지가 있다 (꺼졌거나 되돌리지 못했거나 설정을 못 바꿨다) */
function resumeQuestion(pl) {
  const detail = [`이전 폴더: ${pl.from}`, `새 폴더: ${pl.to}`];
  if (pl.stale.length) detail.push(`새 폴더에 남은 지난번 조각(항목 ${pl.stale.length}개)은 지우고 다시 복사합니다.`);
  if (pl.done.length) detail.push(`지난번에 옮긴 항목 ${pl.done.length}개는 새 폴더에 그대로 둡니다.`);
  if (pl.unknown.length) detail.push(`Hibi 것이 아닌 항목 ${pl.unknown.length}개는 그대로 둡니다.`);
  if (pl.entries.length) detail.push('다 옮긴 뒤 이전 폴더의 백업은 휴지통으로 보냅니다. 옮기는 동안 백업·정리·지난 메일 받기는 쉽니다.');
  return {
    title: RESUME_TITLE,
    message: pl.entries.length
      ? `지난번에 옮기다 멈췄습니다 — 남은 메일 백업(파일 ${pl.files}개 · ${backupmove.sizeText(pl.bytes)})을 새 폴더로 옮깁니다.`
      : '지난번에 옮긴 메일 백업이 새 폴더에 모두 있습니다 — 백업 폴더를 새 폴더로 바꿔 마칩니다.',
    detail: detail.join('\n'),
    buttons: ['이어서 옮기기', '그만두기'],
    defaultId: 0,
    focusId: 0
  };
}

/**
 * 옮기기 전에 이 폴더에 쓰는 일이 모두 멈추기를 기다린다 — move.running 이 선 뒤라 새로 시작하는 일은 없다.
 * 서버 정리는 비켜 달라고 하고(확인 지점에서 멈춘다, 늦으면 연결을 끊는다), 자동 백업은 다음 묶음 앞에서 멈춘다 (shouldStop).
 * 자동 전달은 백업 파일·정리 기록을 읽는다 — 도는 것은 끝나기를 기다린다 (새로 시작하지는 않는다 — main.js 가 moving 을 넘긴다)
 * @returns 못 멈춘 까닭 ('' 이면 조용하다)
 */
async function quietForMove() {
  if (tidy.running) {
    tidy.stop = true;
    const stopThis = tidy.abort;
    setTimeout(() => { if (tidy.running && stopThis && tidy.abort === stopThis) stopThis(); }, T.STOP_GRACE_MS);
  }
  if (fill.running) fill.ctl.abort('stop');
  const busyNow = () => backup.running || autoBackup.running || savingOne > 0 || tidy.running || tidy.asking
    || fill.running || fill.asking || !!fill.scan || host.forwardBusy();
  const t0 = Date.now();
  while (busyNow() && Date.now() - t0 < T.WAIT_MAX_MS) await sleep(100);
  return busyNow() ? '다른 작업(백업·정리·자동 전달)이 끝나지 않았습니다 — 잠시 뒤 다시 고르세요' : '';
}

/**
 * 뒤 받기의 기억 가운데 메일함 폴더 경로를 열쇠로 둔 것(Map·Set)을 새 폴더로 옮겨 적는다 — 답과 나머지 기억(로그인 거절 등)은 그대로.
 * 남은 수는 새 폴더로 다시 센다
 */
function rebaseFill(old, p) {
  const moveKey = (k) => (typeof k === 'string' && backupmove.inside(k, old) ? path.join(p, path.relative(old, k)) : k);
  for (const m of fill.memo.values()) {
    for (const [f, v] of Object.entries(m)) {
      if (v instanceof Map) m[f] = new Map([...v].map(([k, x]) => [moveKey(k), x]));
      else if (v instanceof Set) m[f] = new Set([...v].map(moveKey));
    }
  }
  fill.counts.clear();
  fill.dirty = true;
}

/**
 * «옮기기» — 이전 폴더의 Hibi 것만 새 폴더로 옮기고 설정을 바꾼다. 서버 정리는 켜 둔 채, 지난 메일 답도 그대로다
 * (정리한 메일의 사본·정리 기록·받은 위치가 같이 간다). 실패하면 아무것도 바꾸지 않는다 (backupmove 가 만든 것만 지운다).
 * 바꿔 달다 되돌리지 못하면(split) «옮기기 멈춤»이 남는다. 설정 파일을 저장하지 못하면 이전 폴더를 휴지통으로 보내지 않는다 —
 * 복사했으면 설정을 이전 폴더로 되돌리고, 바꿔 달았으면(백업이 새 폴더에만 있다) 이번 실행은 새 폴더를 쓴다.
 * @returns { message } — 옮겼다 · { error, split?, left?, copied? } — 못 옮겼다 (사유에 경로·주소는 없다)
 */
async function moveBackupsOnce(old, p) {
  const why = await quietForMove();
  if (why) return { error: why };
  // 버퍼에 남은 색인 줄을 이전 자리에 먼저 쓴다 — 옮긴 뒤에 써지면 이전 자리에 폴더가 다시 생긴다
  await mailindex.flushAll();
  // 묻고 기다린 사이에 저장된 메일까지 다시 센다
  const pl = await planMove(old, p);
  if (!pl) return { error: '옮길 것을 다시 세지 못했습니다' };
  if (pl.problem) return { error: pl.problem.replace(/\.$/, '') };
  if (!pl.entries.length && !pl.done.length) return { error: '이전 폴더에 옮길 백업이 없습니다' };
  Object.assign(move, { phase: 'copy', done: 0, total: pl.files, bytes: 0, totalBytes: pl.bytes });
  // «옮기기 멈춤» — 설정 파일에 써졌는지까지 본다. 못 쓰면 바꿔 달지 않는다 (다시 켰을 때 갈린 폴더에 쓰게 된다)
  const setHalt = (h) => {
    store.setGatedSettings({ mailMoveHalt: h });
    return store.lastSaveOk();
  };
  const r = await backupmove.run(pl, {
    onProgress: (q) => Object.assign(move, { phase: q.phase === 'verify' ? 'verify' : 'copy', done: q.done, total: q.total, bytes: q.bytes, totalBytes: q.totalBytes }),
    // 같은 볼륨 — 바꿔 달기 전에 남기고, 다 되돌리면 푼다. 바꿔 단 채 끝나면 아래에서 폴더와 함께 푼다
    // 못 남기면 메모리 값도 되돌린다 — 디스크에는 없는 멈춤으로 이번 실행의 백업·정리를 쉬게 하지 않는다
    hold: {
      on: async () => {
        const prev = store.settings.mailMoveHalt;
        if (setHalt({ from: old, to: p, at: Date.now() })) return true;
        store.setGatedSettings({ mailMoveHalt: prev || null });
        return false;
      },
      off: async () => { setHalt(null); }
    }
  });
  if (!r.ok) return { error: r.error, split: !!r.split, left: r.left || 0 };
  // 설정 — 새 폴더로, 멈춤은 푼다. 정리는 켜 둔 채, 지난 메일 답도 그대로. 정리 기록(tidy-moved.json)은 파일째 갔으니 옮겨 적지 않는다
  store.setGatedSettings({ mailBackupDir: p, mailMoveHalt: null });
  const saved = store.lastSaveOk();
  if (!saved && r.mode === 'copy' && !pl.done.length) {
    // 복사했다 — 이전 폴더는 그대로다. 설정을 되돌리고 휴지통으로 보내지 않는다. 다시 켜도 디스크의 설정은 이전 폴더다.
    // 새 폴더의 사본에는 일지가 남아 같은 폴더를 다시 고르면 지우고 다시 옮긴다
    store.setGatedSettings({ mailBackupDir: old, mailMoveHalt: null });
    evlog.log('메일', '백업 폴더 옮기기 실패 · 설정 파일을 저장하지 못함 — 이전 폴더 그대로');
    return { error: '설정 파일을 저장하지 못했습니다 (이전 폴더의 백업은 지우지 않았습니다)', copied: true };
  }
  // 판정 기억은 열쇠에 폴더가 들어 있다 — 새 폴더로 다시 본다
  tidyMemo.clear();
  mailindex.forget(old);
  rebaseFill(old, p);
  if (!saved) {
    // 바꿔 달았다 — 백업은 새 폴더에만 있다. 이번 실행은 새 폴더를 쓴다 (다음 저장이 되면 디스크에도 간다).
    // 디스크에는 바꿔 달기 전에 남긴 «옮기기 멈춤»이 있어 그대로 다시 켜면 쉬고, 같은 새 폴더를 고르면 마친다 (일지가 남아 있다)
    evlog.log('메일', '백업 폴더 옮김 · 설정 파일을 저장하지 못함 — 다시 켜면 «옮기기 멈춤»');
    return {
      message: `메일 백업을 새 폴더로 옮겼지만 설정 파일을 저장하지 못했습니다 — 앱을 다시 켜기 전에 설정 › 메일에서 백업 폴더를 확인하세요. `
        + `다시 켰을 때 메일 백업이 쉬고 있으면 같은 새 폴더(${p})를 다시 골라 마치세요.`
    };
  }
  // 설정을 바꿨다 — 일지는 더 쓸 일이 없다. 못 지우면 다음에 켤 때 지운다 (checkMoveLeft)
  await backupmove.finish(pl);
  move.phase = 'trash';
  const c = await backupmove.cleanup(pl, r, { trash: (x) => shell.trashItem(x) });
  // 주소가 들어 있는 폴더 이름·경로는 적지 않는다
  evlog.log('메일', `백업 폴더 옮김 · 파일 ${r.files}개 · ${backupmove.sizeText(r.bytes)}`
    + (pl.done.length ? ` · 지난번에 옮긴 항목 ${pl.done.length}개와 합침` : '')
    + (c.trashFailed.length ? ` · 이전 폴더의 ${c.trashFailed.length}개를 휴지통으로 보내지 못함` : ''));
  const parts = [pl.entries.length
    ? `메일 백업을 옮겼습니다 — 파일 ${r.files}개 · ${backupmove.sizeText(r.bytes)}.`
    : '메일 백업 옮기기를 마쳤습니다 — 백업 폴더를 새 폴더로 바꿨습니다.'];
  if (pl.done.length) parts.push(`지난번에 옮긴 항목 ${pl.done.length}개는 새 폴더에 그대로 있습니다.`);
  if (pl.unknown.length) parts.push(`Hibi 것이 아닌 항목 ${pl.unknown.length}개는 그대로 두었습니다.`);
  if (c.trashFailed.length) parts.push('이전 폴더의 백업을 휴지통으로 보내지 못했습니다 — 새 폴더에 모두 옮겨졌으니 직접 지워도 됩니다.');
  else if (r.mode === 'copy') parts.push('이전 폴더의 백업은 휴지통으로 보냈습니다.');
  return { message: parts.join(' ') };
}

/** moveBackupsOnce 를 move.running 안에서 돌리고, 끝나면 상태를 풀고 답을 적는다 */
async function moveBackups(old, p) {
  Object.assign(move, { running: true, phase: 'wait', done: 0, total: 0, bytes: 0, totalBytes: 0 });
  let r;
  try {
    r = await moveBackupsOnce(old, p);
  } catch (e) {
    r = { error: `오류가 났습니다 (${(e && e.code) || 'ERR'})` };
  } finally {
    Object.assign(move, { running: false, phase: '', done: 0, total: 0, bytes: 0, totalBytes: 0 });
    // 옛 파일 스캔은 옮기는 동안 멈췄다 — 다음 틱에 지금 폴더로 다시 돈다 (시각이 그대로라 맞춰 둔 폴더는 건너뛴다)
    fill.scanned = false;
  }
  if (r.error) {
    evlog.log('메일', mailtidy.maskAddr(`백업 폴더 옮기기 실패 · ${r.error}`));
    // 바꿔 단 것이 새 폴더에 남았다 (이번에 되돌리지 못했거나 지난번 것) — «옮기기 멈춤»이 서 있다
    const halted = !!moveHalt();
    backup.message = (r.split
      ? `메일 백업을 옮기다 멈췄습니다 — ${r.error}.`
      : `메일 백업을 옮기지 못했습니다 — ${r.error}.${halted ? '' : ' 폴더는 그대로입니다.'}`
        + (r.left ? ` 새 폴더에 지우지 못한 파일 ${r.left}개가 남았습니다.` : '')
        + (r.copied ? ' 새 폴더에 만든 사본은 같은 폴더를 다시 고르면 지우고 다시 옮깁니다.' : ''))
      + (halted ? ' 이 폴더의 백업·서버 정리·지난 메일 받기를 멈췄습니다 — 설정 › 메일에서 같은 새 폴더를 다시 골라 이어서 옮기세요.' : '');
    if (halted) evlog.log('메일', '백업 폴더 옮기기 멈춤 · 이 폴더의 백업·정리·지난 메일 받기를 쉼');
  } else {
    backup.message = r.message;
  }
  // 옮기는 동안 종료를 눌렀다 — 이제 끈다
  if (quitHeld) {
    quitHeld = false;
    setImmediate(() => app.quit());
  }
  return backupStatus();
}

/**
 * 종료 직전(before-quit, main.js) — 옮기는 중이면 종료를 미루고, 옮기기가 끝나면 다시 종료한다.
 * 복사 도중에 꺼지면 새 폴더에 조각이 남는다 (일지가 있어 다시 고르면 이어서 옮기지만 끝까지 가는 쪽이 낫다).
 * 트레이 «종료»·업데이트 뒤 종료가 여기로 온다. 윈도우 종료·작업 관리자는 막을 수 없다 — 그때는 일지가 받는다
 * @returns 미뤘나
 */
function holdQuit(e) {
  if (!move.running) return false;
  e.preventDefault();
  if (!quitHeld) {
    quitHeld = true;
    evlog.log('메일', '종료를 미룸 · 메일 백업을 옮기는 중');
    try { host.quitHeld(); } catch { /* 알림을 못 띄워도 미룬다 */ }
  }
  backup.message = '메일 백업을 옮기는 중입니다 — 끝나면 종료합니다.';
  return true;
}

/**
 * 앱을 켠 뒤 한 번 — 옮기기의 남은 것을 본다.
 * 멈춘 채면 알린다 (이 폴더의 백업·정리·지난 메일 받기는 쉰다). 아니면 지금 폴더에 남은 일지를 지운다 —
 * 설정이 이 폴더를 가리키니 이리로 옮기기는 끝났다 (설정을 저장한 뒤 일지를 지우기 전에 꺼졌다)
 */
function checkMoveLeft() {
  if (leftChecked) return;
  leftChecked = true;
  if (moveHalt()) {
    backup.message = HALT_WAIT;
    evlog.log('메일', '백업 폴더 옮기기가 끝나지 않음 · 이 폴더의 백업·정리·지난 메일 받기를 쉼');
    return;
  }
  const dir = store.settings.mailBackupDir;
  if (dir) backupmove.dropJournal(dir).catch(() => { /* 다음에 켤 때 다시 본다 */ });
}

/**
 * 백업 폴더 고르기 — parent 는 부탁한 창 (설정 창). 확인 창을 그 위에 띄운다.
 * 이전 폴더에 Hibi 백업이 있으면 «기존 메일 백업도 옮길까요?»를 묻는다:
 *   옮기기 — Hibi 것만 새 폴더로 옮긴다 (moveBackups). 서버 정리·지난 메일 답은 그대로다
 *   옮기지 않고 새 폴더만 쓰기 — 예전 그대로: 모든 계정의 서버 정리를 끄고, 지난 메일 답을 지우고, 정리 기록을 옮겨 적는다
 *   그만두기 (창 닫기·Esc) — 아무것도 안 바뀐다
 * 옮길 수 없으면(새 폴더에 이미 백업이 있다·안팎으로 겹친다·공간이 모자라다) 까닭을 말하고 새 폴더만 쓰기·그만두기만 묻는다.
 * 새 폴더에 이 이전 폴더에서 옮기다 멈춘 일지가 있으면 «이어서 옮기기»·그만두기만 묻는다 (조각은 지우고 다시, 바꿔 단 것은 그대로).
 * 다른 곳에서 옮기다 멈춘 조각이 있거나 옮기기가 멈춘 채면 «새 폴더만 쓰기»를 내지 않는다 — 조각이나 갈린 폴더를 백업으로 쓰게 된다.
 * 옮기기가 멈춘 채면 그때 고른 새 폴더만 받는다.
 * 이전 폴더가 없거나 Hibi 것이 없으면 묻지 않고 예전처럼 바꾼다.
 */
async function pickDir(parent = null) {
  // 도는 중에 폴더를 바꾸면 절반은 저쪽, 절반은 이쪽에 남는다.
  // 서버 정리도 마찬가지다 — 정리는 이 폴더의 파일을 근거로 옮긴다
  // 지난 메일 확인 창도 막는다 — 창에는 지금 폴더가 적혀 있다. 바꾸고 «받기»를 누르면 본 적 없는 폴더(OneDrive 안일 수도 있다)에 받기 시작한다
  const busy = () => move.running || backup.running || autoBackup.running || tidy.running || tidy.asking || fill.asking;
  const refuse = () => {
    backup.message = move.running ? '메일 백업을 옮기는 중입니다 — 끝난 뒤 다시 고르세요'
      : fill.asking ? '확인 창이 떠 있는 동안에는 폴더를 바꿀 수 없습니다 — 거기서 먼저 고르세요'
        : '백업이나 서버 정리가 도는 중에는 폴더를 바꿀 수 없습니다';
    return backupStatus();
  };
  if (busy()) return refuse();
  // 대화상자나 옮길지 묻는 창이 이미 떠 있다 (두 번 눌렀다) — 하나만 띄운다
  if (fill.picking) {
    backup.message = '폴더를 고르는 중입니다 — 열린 창에서 먼저 고르세요';
    return backupStatus();
  }
  // 뒤 받기는 거절 사유가 아니다 — 며칠씩 도는 일이라 거절하면 폴더를 영영 못 바꾼다. 먼저 끊고, 대화상자 동안 쉰다
  fill.picking = true;
  try {
    await fillHalt();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '메일을 저장할 폴더',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.settings.mailBackupDir || app.getPath('home')
    });
    if (canceled || !filePaths || !filePaths[0]) return backupStatus();
    // 대화상자를 기다린 사이에 백업이나 정리가 시작됐을 수 있다
    if (busy()) return refuse();
    const p = filePaths[0];
    const old = store.settings.mailBackupDir;
    const norm = (x) => {
      const r = path.resolve(x);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    // 지난 옮기기가 멈춘 채 — 그때 고른 새 폴더로만 이어서 옮긴다. 다른 곳을 고르면 남은 것이 세 곳으로 갈린다
    const halt = moveHalt();
    if (halt && !(old && norm(p) === norm(halt.to) && norm(old) === norm(halt.from))) {
      backup.message = `지난번 메일 백업 옮기기가 끝나지 않았습니다 — 그때 고른 새 폴더(${halt.to})를 다시 고르면 이어서 옮깁니다.`;
      return backupStatus();
    }

    // 여기서 못 쓰는 곳인지 바로 확인한다. 나중에 백업을 눌렀을 때 실패하면
    // 원인이 폴더인지 서버인지 알 수 없다. (C:\Users 밑처럼 윈도우가 막는 자리가 있다)
    const bad = backupDirProblem(p);
    if (bad) { backup.message = bad; return backupStatus(); }

    const changed = !old || norm(old) !== norm(p);

    // 이전 폴더에 Hibi 백업이 있으면 옮길지 묻는다. 새 폴더에 지난번 옮기기의 일지가 있으면 «이어서 옮기기»를 묻는다
    if (changed && old) {
      const pl = await planMove(old, p);
      if (pl && (pl.entries.length || pl.done.length || pl.stale.length || pl.partial)) {
        // «새 폴더만 쓰기»를 낼 수 있나 — 새 폴더에 옮기다 멈춘 조각이 있으면(그 조각을 백업으로 쓰게 된다)·옮기기가 멈춘 채면 안 된다
        const newOnly = !pl.resume && !pl.partial && !halt;
        const q = pl.problem ? cantMoveQuestion(pl, newOnly) : pl.resume ? resumeQuestion(pl) : moveQuestion(pl);
        const choices = pl.problem ? [...(newOnly ? ['new'] : []), 'cancel'] : pl.resume ? ['move', 'cancel'] : ['move', 'new', 'cancel'];
        const r = await popup.askUser(parent, q);
        // 창을 닫거나 Esc 는 null — 그만두기
        const choice = choices[r] || 'cancel';
        if (choice === 'cancel') {
          backup.message = '그만뒀습니다 — 폴더는 그대로입니다.';
          return backupStatus();
        }
        // 묻는 사이에 다른 길로 폴더가 바뀌었다 — 그 답은 옛 폴더에 대한 것이다
        if (store.settings.mailBackupDir !== old) {
          backup.message = '폴더가 바뀌어 그만뒀습니다 — 다시 고르세요.';
          return backupStatus();
        }
        // 수동 백업·확인 창은 기다리지 않는다 (몇 시간·사람의 답). 자동 백업·정리·전달은 moveBackups 가 멈추고 기다린다
        if (choice === 'move') {
          if (backup.running || tidy.asking || fill.asking) return refuse();
          return await moveBackups(old, p);
        }
        if (busy()) return refuse();
      }
    }
    // 멈춘 채인데 이어서 옮길 것을 못 찾았다 (일지가 없어졌다 등) — 갈린 폴더를 새 폴더만 쓰기로 넘기지 않는다
    if (halt) {
      backup.message = '지난번 메일 백업 옮기기를 이어서 할 것을 찾지 못했습니다 — 두 폴더를 확인하세요. 폴더는 그대로입니다.';
      return backupStatus();
    }

    // «새 폴더만 쓰기» (예전 그대로) — 서버 정리를 끈다. 이미 정리한 메일의 PC 사본은 이전 폴더에 있다.
    // 새 폴더로 정리하려면 다시 묻는다 (새 폴더에는 아직 아무것도 없을 수 있다)
    const offTidy = changed && tidyacct.anyOn(store.settings.mailTidyAccounts);
    // 판정 기억은 그 폴더의 파일을 근거로 한 것이다 (열쇠에 폴더가 들어 있지만, 쓸모없는 것을 들고 있지 않게)
    if (changed) tidyMemo.clear();
    // 모든 계정을 끈다 — 기간은 남긴다 (다시 켤 때 고르던 값)
    store.setGatedSettings({ mailBackupDir: p, ...(offTidy ? { mailTidyAccounts: tidyacct.allOff(store.settings.mailTidyAccounts) } : {}) });
    // 지난 메일의 답은 그 폴더에 받겠다는 답이다 — 새 폴더의 첫 자동 저장이 끝난 뒤 다시 묻는다
    if (changed) {
      store.clearFillAnswers();
      fill.counts.clear();
      fill.listed.clear();
      fill.memo.clear();
      fill.scanned = false;
      fill.stuckLine = '';
    }
    // 옮긴 기록은 새 폴더로도 옮겨 적는다 — 새 폴더로 다시 켰을 때, 예전에 옮겼다가 휴지통에서 되찾은 메일을
    // 또 옮기지 않게 (더하기만 한다. 못 읽거나 못 쓰면 그만이다 — 정리는 꺼져 있고 다시 켤 때 묻는다)
    if (changed && old) {
      try { await mailtidy.carryMoved(old, p); } catch { /* 기록을 못 옮겨도 폴더 고르기는 끝낸다 */ }
    }
    if (offTidy) {
      backup.message = `폴더를 바꿔 모든 계정의 «서버 정리»를 껐습니다 — 정리한 메일의 사본이 이전 폴더(${old})에 있으니 지우지 마세요.`;
      evlog.log('메일', '서버 정리 꺼짐 · 백업 폴더를 바꿈 (모든 계정 · 이전 폴더에 정리한 메일의 사본이 있음)');
    } else {
      backup.message = '';
    }
    return backupStatus();
  } finally {
    fill.picking = false;
  }
}

/**
 * 이 폴더에 정말 쓸 수 있나. 실제로 만들어 보고 지운다 —
 * 권한은 존재 여부만으로는 알 수 없다.
 * @returns 문제가 있으면 사람이 읽을 사유, 없으면 null
 */
function backupDirProblem(dir) {
  // 이름은 backupmove 가 쥔다 — 옮기기가 «Hibi 것»으로 알아본다
  const probe = path.join(dir, backupmove.PROBE_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    try { fs.unlinkSync(probe); } catch { /* 없으면 그만 */ }
    if (e.code === 'ENOSPC') return DIR_FULL;
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return `이 폴더에는 쓸 수 없습니다 (${dir}) — 다른 폴더를 고르세요.`;
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
  // 백업 폴더를 옮기는 중 — 끝나면 폴더가 바뀐다. 옮기기가 멈춘 채면 이 폴더는 갈려 있다 — 이어서 옮긴 뒤에
  if (moveHold()) {
    backup.message = move.running ? '메일 백업을 옮기는 중입니다 — 끝난 뒤 다시 누르세요' : HALT_WAIT;
    return backupStatus();
  }
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
  // 뒤 받기도 비켜 준다 — 다음 틱은 backup.running 을 보고 시작하지 않는다
  if (fill.running) fill.ctl.abort('stop');
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
      // 뒤 받기는 끊었으니 곧 끝난다 (감시 타이머가 있어 반드시 끝난다)
      while ((tidy.running || autoBackup.running || fill.running) && !backup.stop && Date.now() - t0 < T.WAIT_MAX_MS) {
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
      // 지난 메일을 새로 저장했으니 정리를 너무 오래 미루지 않는다 — 켠 계정마다
      for (const a of liveAccounts()) {
        if (tidyOnFor(a)) tidy.nextAt.set(a.id, Math.min(nextAtOf(a.id), Date.now() + T.FIRST_MS));
      }
    }
  })();

  return backupStatus();
}

// 끝에 둔다 — 훅은 fill·T 가 만들어진 뒤에 불려야 한다. 이 모듈이 실린 뒤로 앞쪽 연결은 모두 여기를 지난다
mail.setFrontHook(fillYield);

module.exports = {
  init, autoBackupOne, autoBackupNew, setTidy, backupStatus, startBackup, pickDir, retryMove, moving, moveRunning, holdQuit,
  ensureLocalFirst, fillTick, setFill, fillAskLine, fillQuestion, defaultDirs, underOneDrive, fillStatus,
  autoGapMs, minFreeFor, firstGoodDir,
  // 시험이 «앱을 다시 켠 것»을 흉내 내려고 본다 — 화면으로 나가는 값이 아니다
  fillState: fill
};

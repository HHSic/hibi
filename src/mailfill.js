'use strict';
/**
 * 지난 메일 뒤 받기 — 사용자가 «받기»로 답한 계정의 지난 메일을 회차(몇 분)씩 나눠 PC로 받는다.
 *
 * 순서는 표시 → 머리(회차 몫의 1/3까지) → 본문이고, 본문은 최신부터다. 색인의 «at 없는 줄»과 «st:head 줄»이 곧 할 일이라
 * 진행 칸이 따로 없다 — 어디서 끊겨도 다음 회차가 그 줄부터 잇는다. 끝난 계정은 연결을 만들지 않는다.
 *
 * «다 받음»은 파일 수로 판단하지 않는다. 서버 검색 결과의 모든 UID가 끝났음을 확인한 confirmBox 만 적는다.
 * 서버 정리가 이 판정을 보고 그 계정을 쉬었다 다시 돌기 때문이다.
 *
 * 바깥에는 «한 회차(fillAccount), 서버를 부르지 않는 판정(countPending·allBelow·isDone·retryDue·unfillable), 옛 파일 스캔(scanAccount)»만 내준다.
 * 왜: 부르는 쪽(src/backup.js)은 회차를 언제 돌릴지만 정한다. 묶음·실패 가르기·완료 판정을 바깥이 알면 «파일 수로 완료» 같은 지름길이 다시 생긴다.
 *
 * 서버는 읽기만 한다. 폴더는 전부 EXAMINE 으로 열고, 쓰는 메서드는 연결에서 막고(FORBIDDEN), 원문은 BODY.PEEK 로 받는다.
 * store·mailhub·autofwd·mailrules·mailtally·electron 을 싣지 않는다 — 뒤 받기가 알림·주소록·규칙·전달을 건드리지 못하게 구조로 막는다.
 * 그래서 시험이 node 로 돈다 (test/mailfill.test.js).
 */
const fs = require('fs');
const path = require('path');
const mail = require('./mail');
const mailbackup = require('./mailbackup');
const mailindex = require('./mailindex');
const mailtidy = require('./mailtidy');

const HEAD_CHUNK = 100;
const BODY_N = 10;
const BODY_BYTES = 8 * 1024 * 1024;
const BIG_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const MIN_FREE = 2 * 1024 * 1024 * 1024;
const SYSTEM_FREE = 10 * 1024 * 1024 * 1024;
const STRIKES = 3;
const HEAD_SHARE = 1 / 3;      // 머리는 회차 몫의 이만큼까지 — 큰 메일함에서 몇 시간 동안 파일이 0통이면 안 된다
const LIST_MS = 60 * 60_000;
const MISS_GAP_MS = 10 * 60_000;
const FILES_SURE = 0.9;         // 자동 yes — 서버 수의 이만큼이 파일로 있어야 «이미 받았다»로 본다. 정리가 옮긴 메일의 사본도 남으므로 정상 기록은 다 넘는다
const RETRY_FAIL_MS = 24 * 60 * 60_000;
const SEARCH_MS = 60 * 60_000; // 폴더를 연 김에 사라진 메일을 다시 묻는 간격
const CUT_MIN_MS = 5000;       // 줄을 이만큼도 못 기다리고 끊겼으면 메일 탓을 따지지 않는다 — 비킴은 아무 때나 온다
const SLEEP_MS = 30_000;       // 경과 시간이 몫을 이만큼 넘으면 잠자기 흔적이다. 타이머가 제때 못 깬 회차라 메일 탓이 아니다
const LOOP_CHECK = 100;         // 디스크를 보는 긴 고리가 이만큼마다 끊겼는지 본다 — \All 은 줄이 수만 개다
const HOLE_FLUSH = 1000;        // 자리표를 이만큼마다 쓴다. 동기 고리에는 쓰기가 끼어들 틈이 없어 버퍼 상한(5,000줄)이 멀쩡한 줄을 버린다
const FORBIDDEN = [...mailtidy.FORBIDDEN, 'messageMove'];
// Gmail 은 평소 비밀번호를 넣으면 «Application-specific password required»로 거절한다 — 비밀번호 탓이다
const AUTH_TEXT = /invalid credentials|login failed|authentication failed|application-specific password|비밀번호/i;

const isInbox = (b) => /^inbox$/i.test(String(b && b.path));
const hasUse = (b, use) => b.specialUse === use || !!(b.flags && typeof b.flags.has === 'function' && b.flags.has(use));
const genOf = (rec) => Math.max(1, Number(rec && rec.gen) || 1);
const lastOf = (c) => Number(c.rec.lastUid) || 0;
/** 이 폴더를 다 받았나. 빈 답 확인(emptySure)이 남았으면 lowUid 가 어느 길로 내려갔든 아니다 */
const recDone = (r) => r.fillHead === true && Number(r.lowUid) <= 1 && Number(r.fillLeft) === 0 && r.fillEmptyAt == null;

/** 회차를 곧바로 끝내는 일 (디스크·폴더·상태 파일). 폴더 오류처럼 다음 폴더로 넘어가지 않는다 */
const turnEnd = (why, note = null) => Object.assign(new Error(note || why), { turnEnd: why, note });

/** 부르는 쪽이 들고 있는 기억 — 빈 칸만 채운다. 부르는 쪽의 칸(strikes 등)은 건드리지 않는다 */
function memoOf(memo) {
  const m = memo || {};
  const blank = {
    chunk: BODY_N, retried: new Set(), retriedAt: 0, list: null, listAt: 0, miss: new Map(), scanned: new Set(),
    setupMs: 0, bps: 0, searchAt: new Map(), cuts: new Map(), cutSince: new Map(), triedAt: new Map(), short: new Map(), slowRow: false
  };
  for (const [k, v] of Object.entries(blank)) if (m[k] === undefined) m[k] = v;
  return m;
}

/**
 * 서버의 SEARCH ALL 답을 믿어도 되나. 일부만 답하는 서버가 있어 «이게 전부»로 믿으면 없는 메일을 사라졌다고 적는다.
 * 3단계 judgeServer 와 같은 뜻의 문턱이다.
 */
function searchOk(found, exists) {
  if (!Array.isArray(found)) return false;
  if (!Number.isFinite(exists)) return true;
  if (exists > 0 && !found.length) return false;
  return Math.abs(found.length - exists) <= Math.max(20, exists * 0.02);
}

/** LOGIN 의 모든 거절에 authenticationFailed 가 붙는다 (NO [UNAVAILABLE] 에도) — 비밀번호 탓은 응답으로만 가른다 */
function authFailed(e) {
  if (!e) return false;
  if (e.serverResponseCode === 'AUTHENTICATIONFAILED') return true;
  return AUTH_TEXT.test(`${e.responseText || ''} ${e.message || ''}`);
}

/**
 * 메일 하나가 아니라 계정 전체가 거절됐나 — Gmail 하루 한도(«[ALERT] Account exceeded command or bandwidth limits»),
 * 속도 제한([THROTTLED]), 동시 연결 초과. 이때는 한 통씩 다시 받아도 모두 거절된다
 */
function accountWide(e) {
  return !!e && /ALERT|exceeded|bandwidth|THROTTLED|Too many/i.test(`${e.serverResponseCode || ''} ${e.responseText || ''}`);
}

function connectWhy(e) {
  if (authFailed(e)) return 'auth';
  return e && (e.authenticationFailed || e.responseStatus === 'NO' || e.responseStatus === 'BAD') ? 'refused' : 'connect';
}

function recsOf(acc, dir) {
  const per = mailbackup.loadState(dir)[mailbackup.accountKey(acc)];
  if (!per || typeof per !== 'object') return [];
  return Object.entries(per).filter(([, r]) => r && typeof r === 'object');
}

/**
 * UIDVALIDITY 를 늘 안 주는 서버의 폴더 — 기록에 "undefined"·"0" 이 남는다. 아직 못 연 폴더의 빈 기록(값 없음)과 다르다.
 * UID 를 세대로 가를 수 없어 색인도 뒤 받기도 하지 않는다. 새 메일 저장만 잇는다 (mailbackup.backupAccount). 정리도 이 폴더를 건너뛴다 (mailtidy goodV).
 */
const noValidity = (r) => r.uidValidity != null && !mailtidy.goodV(r.uidValidity);
const liveRecs = (acc, dir) => recsOf(acc, dir).filter(([, r]) => !r.fillSkip && !noValidity(r));

/**
 * 남은 통수. 서버를 부르지 않는다. 파일 수를 빼지 않는다 — 정리가 옮긴 메일의 사본까지 세어 «남은 0»이 나오기 때문이다.
 * @returns { left, leftBytes, boxes, rough? } — left 는 아는 폴더가 없으면 null, leftBytes 는 전 폴더가 fillHead 일 때만 숫자.
 *   rough 는 아직 안 연 폴더의 exists 를 더했다는 표시다 — 위로 잡은 값이라 «남은 약»이라고 말하면 안 된다 (옛 «백업 시작» 기록은 크게 틀린다)
 */
function countPending(acc, dir) {
  const live = liveRecs(acc, dir);
  let left = null;
  let bytes = 0;
  let heads = live.length > 0;
  let rough = false;
  for (const [, r] of live) {
    const known = Number.isFinite(r.fillLeft);
    const n = known ? r.fillLeft : r.exists;
    if (Number.isFinite(n)) {
      left = (left || 0) + n;
      if (!known) rough = true;
    }
    if (r.fillHead) bytes += Number(r.fillLeftBytes) || 0;
    else heads = false;
  }
  return { left, leftBytes: heads ? bytes : null, boxes: live.length, ...(rough ? { rough } : {}) };
}

/**
 * 이미 «백업 시작»으로 전부 받은 계정인가 — 묻지 않고 yes 로 적는 유일한 조건이다. 아직 못 연 폴더의 빈 기록은 받은 것이 아니다.
 * 기록만 믿지 않고 파일을 본다. 파일을 지우거나 옮겼거나, 옛 버전이 빈 답 한 번에 lowUid 를 내렸거나, 계정 이름이 바뀌어 자리가 달라졌으면 기록은 «다 받음»인데 PC 에 없다.
 * 그때 yes 로 적으면 질문 없이 메일함 전체를 다시 받고, 정리가 켜져 있으면 대상이 말없이 넓어진다.
 * «완료를 파일 수로 판단하지 않는다»는 isDone 쪽 규칙이다. 여기는 묻지 않아도 되는지 보는 자리라, 모자라면 물을 뿐 잃는 것이 없다.
 * 빈 답 확인(fillEmptyAt) 칸이 남은 폴더가 있으면 거짓이다. LIST 에서 빠져 표시된 폴더도, 시계만 지워진 칸(0)도 같다 — 그 폴더가 정말 비었는지 아직 모른다.
 * 자동 yes 는 안전한 쪽으로 틀려야 한다. 잘못된 «아니오»의 값은 질문 한 번이고, 잘못된 «예»의 값은 동의 없이 메일함 전체다.
 * @param paths 이번에 LIST 로 본 폴더. 기록이 없는 폴더가 있으면 거짓이다 — 남은 빈 폴더만 보고 참이 되면 동의 없이 전부 받는다
 */
function allBelow(acc, dir, paths = null) {
  const recs = recsOf(acc, dir);
  if (recs.some(([, r]) => r.fillEmptyAt != null)) return false;
  if (paths) {
    const have = new Set(recs.map(([p]) => p));
    if (!paths.every((p) => have.has(p))) return false;
  }
  const live = liveRecs(acc, dir);
  const hasFiles = (boxPath, r) => {
    const n = Number(r.exists);
    if (!Number.isFinite(n) || r.exists == null) return false;
    return n <= 0 || mailbackup.uidsIn(mailbackup.boxDirFor(dir, acc, boxPath, genOf(r))).size >= n * FILES_SURE;
  };
  return live.length > 0 && live.every(([p, r]) => (Number(r.lowUid) <= 1 || (r.lowUid == null && r.fillHead !== false)) && hasFiles(p, r));
}

/**
 * 다 받았나. 동기다 — runTidy 가 계정마다 부른다. confirmBox 만 이 조건을 참으로 만든다.
 * confirmBox 가 적는 칸을 다 본다 — 다른 길로 lowUid 만 내려가도 참이 되면 정리 보류가 풀리고 남은 메일을 아무도 안 받는다.
 * 뒤 받기가 못 여는 폴더(noValidity)는 보지 않는다. 그런 폴더뿐인 계정은 받을 것이 없다 — 거짓으로 두면 정리 보류가 영영 안 풀린다.
 */
function isDone(acc, dir) {
  const recs = recsOf(acc, dir).filter(([, r]) => !r.fillSkip);
  return recs.length > 0 && recs.every(([, r]) => noValidity(r) || recDone(r));
}

/** 뒤 받기가 못 여는 폴더 수 — 화면이 «다 받았다»고만 말하지 않게 */
function unfillable(acc, dir) {
  return recsOf(acc, dir).filter(([, r]) => !r.fillSkip && noValidity(r)).length;
}

/**
 * 못 받은 메일을 다시 부를 때인가 — 부르는 쪽이 다 받은 계정에 연결을 만들지 정한다. 서버를 부르지 않는다.
 * 하루 시계만 보지 않는다. 연결 실패나 비킴으로 FETCH 전에 끝난 회차가 그날의 재시도를 써 버리면 안 되므로 폴더마다 끝냈는지(memo.retried)를 함께 본다.
 */
function retryDue(acc, dir, memo, now = Date.now()) {
  if (!memo || !memo.retried || now - (memo.retriedAt || 0) >= RETRY_FAIL_MS) return true;
  return liveRecs(acc, dir).some(([p, r]) => Number(r.fillFail) > 0 && !memo.retried.has(mailbackup.boxDirFor(dir, acc, p, genOf(r))));
}

/**
 * 답이 yes 가 아닌 계정의 옛 파일을 색인에 맞춘다. 서버를 부르지 않는다.
 * 폴더 mtime 이 색인 mtime 보다 새로운 폴더만 읽는다 — 5만 통이면 파일을 다 읽는 데 몇 분이 걸린다.
 * @returns { boxes, added, missing, damaged, parts, errors, stopped }
 */
async function scanAccount(acc, dir, { shouldStop = () => false, skipBox = () => false } = {}) {
  const out = { boxes: 0, added: 0, missing: 0, damaged: 0, parts: 0, errors: 0, stopped: false };
  for (const [boxPath, rec] of recsOf(acc, dir)) {
    if (shouldStop()) { out.stopped = true; break; }
    // 세대를 가를 수 없는 폴더에 메타 없는 색인을 만들면, 서버가 값을 주기 시작했을 때 세대를 못 고른다
    if (skipBox(boxPath) || noValidity(rec)) continue;
    const boxDir = mailbackup.boxDirFor(dir, acc, boxPath, genOf(rec));
    let dirAt;
    try { dirAt = (await fs.promises.stat(boxDir)).mtimeMs; } catch { continue; }
    let indexAt = 0;
    try { indexAt = (await fs.promises.stat(path.join(boxDir, mailindex.INDEX_FILE))).mtimeMs; } catch { /* 색인이 없으면 만든다 */ }
    if (dirAt <= indexAt) continue;
    out.boxes += 1;
    try {
      const r = await mailindex.reconcile(boxDir, { shouldStop });
      out.added += r.added;
      out.missing += r.missing;
      out.damaged += r.damaged;
      out.parts += r.parts;
      if (r.stopped) { out.stopped = true; break; }
    } catch {
      out.errors += 1;   // 색인을 못 읽는 폴더 — 덮어쓰지 않고 이번 판에 건너뛴다
    }
  }
  return out;
}

/**
 * 한 회차. 던지지 않는다 — 부르는 쪽(fillTick)은 why 만 보고 다음 일을 정한다.
 *
 * @param opts.connect    (acc) => client (필수)  src/backup.js 는 mail.connect(a, { timeoutMs: 90_000, background: true }) 를 준다
 * @param opts.signal     AbortSignal — 끊으면 연결을 닫는다. abort('yield') 면 why:'yield' (같은 계정의 앞쪽 연결에 비킴), 그 밖은 'stop'
 * @param opts.budgetMs   회차 몫. 연결 단계도 몫 안이다
 * @param opts.shouldStop () => bool
 * @param opts.dirProblem (dir) => 사유 | null — 파일 쓰기가 실패했을 때 폴더 탓인지 가른다. 통과하면 메일 탓이다
 * @param opts.onProgress ({ phase, box, heads, saved, bytes, extendMs? }) — 큰 메일에 몫을 늘리면 extendMs 가 온다. 감시 타이머를 그만큼 다시 건다
 * @param opts.bigTurnMs  8MB 넘는 메일이나 전에 끊긴 메일 한 통에 줄 수 있는 몫의 상한
 * @param opts.freeBytes  (dir) => 남은 바이트   opts.minFree (dir) => 바닥 바이트
 * @param opts.memo       회차 사이의 기억 (부르는 쪽이 계정마다 들고 있는다) — 비우면 «앱을 다시 켠 것»이다
 * @param opts.now        () => ms  기본 Date.now
 * @param opts.sleepMs    경과 시간이 몫을 이만큼 넘으면 잠자기 흔적으로 본다. 시계를 빨리 돌리는 시험이 배율에 맞춘다
 * @returns { done, heads, saved, bytes, failed, left, leftBytes, need, why, error, boxErrors, genUp, noGain, limit }
 *   why: 'done' | 'budget' | 'yield' | 'stop' | 'disk' | 'write' | 'connect' | 'refused' | 'auth' | 'state'
 *   need: 공간이 얼마나 모자라나 (실제 부족분)
 *   noGain: 몫이 끝나거나 비켜서 끊겼는데 머리도 본문도 못 받았다 — 부르는 쪽이 세어 간격을 늘린다
 *   limit: 로그인 뒤 계정 전체가 거절됐다 (하루 한도·속도 제한) — why 는 refused, error 는 그 까닭. 비밀번호 탓이 아니어서 화면에 보여도 된다
 */
async function fillAccount(acc, dir, opts = {}) {
  const {
    connect, signal, budgetMs = 240_000, shouldStop = () => false, dirProblem = () => null,
    onProgress = () => {}, bigTurnMs = 15 * 60_000,
    freeBytes = async (d) => { const s = await fs.promises.statfs(d); return s.bavail * s.bsize; },
    minFree = async () => MIN_FREE,
    now = Date.now,
    sleepMs = SLEEP_MS
  } = opts;
  const memo = memoOf(opts.memo);
  const accKey = mailbackup.accountKey(acc);
  const res = {
    done: false, heads: 0, saved: 0, bytes: 0, failed: 0, left: null, leftBytes: null, need: null,
    why: '', error: null, boxErrors: [], genUp: false, noGain: false, limit: false
  };
  const aborted = () => !!(signal && signal.aborted);
  const abortWhy = () => (signal.reason === 'yield' ? 'yield' : 'stop');
  const wrapUp = () => {
    const n = countPending(acc, dir);
    res.left = n.left;
    res.leftBytes = n.leftBytes;
    res.failed = liveRecs(acc, dir).reduce((sum, [, r]) => sum + (Number(r.fillFail) || 0) + (Number(r.fillBig) || 0), 0);
    res.done = isDone(acc, dir);
    return res;
  };
  const dirOf = (boxPath, rec) => mailbackup.boxDirFor(dir, acc, boxPath, genOf(rec));
  const failKey = (c, uid) => `${c.boxDir}\n${uid}`;

  /** 빈 답 확인(emptySure)의 시계 — 'none' | 'running' | 'passed'. 시각이 앞이면 시계를 되돌린 것이다. 기다리지 않고 처음부터 다시 잰다 */
  const emptyClock = (rec) => {
    const at = Number(rec && rec.fillEmptyAt) || 0;
    if (at <= 0 || at > now()) return 'none';
    return now() - at < MISS_GAP_MS ? 'running' : 'passed';
  };

  /** 회차 계획 — 상태 파일만 본다. 폴더마다 다시 검색하면 느린 서버에서 몫이 명령 왕복으로 다 사라진다 */
  const jobOf = (boxPath, rec) => {
    if (rec && noValidity(rec)) return null;
    // 빈 답 확인을 기다린다 — 10분이 찰 때까지 열지 않는다
    if (emptyClock(rec) === 'running') return null;
    if (!rec || !rec.fillHead) return 'head';
    const boxDir = dirOf(boxPath, rec);
    if (Number(rec.fillFail) > 0 && !memo.retried.has(boxDir)) return 'body';
    if (recDone(rec)) return null;
    // 사라짐 확인만 남았으면 10분이 찰 때까지 열지 않는다
    const waiting = memo.miss.get(boxDir);
    if (waiting && waiting.size && rec.fillLeft === 0) {
      let oldest = Infinity;
      for (const at of waiting.values()) if (at < oldest) oldest = at;
      if (now() - oldest < MISS_GAP_MS) return null;
    }
    return 'body';
  };

  let per;
  try {
    const info = mailbackup.readStateInfo(dir);
    per = info.state[accKey] || {};
    if (info.broken) res.error = '진행 기록이 깨져 새로 시작했습니다';
  } catch (e) {
    // 못 읽는 기록을 빈 값으로 보고 쓰면 기록을 잃는다 — 연결도 하지 않는다
    res.why = 'state';
    res.error = e.message;
    return wrapUp();
  }

  // 못 받은 메일은 앱 실행마다, 그리고 하루에 한 번만 다시 부른다. 서버를 두드리지 않으려고 줄이 아니라 여기 적는다.
  // 시계는 여기서 가도 이번 판은 폴더를 끝내야 끝난다 (retryDue)
  if (now() - memo.retriedAt >= RETRY_FAIL_MS) {
    memo.retried.clear();
    memo.retriedAt = now();
  }
  if (aborted()) {
    res.why = abortWhy();
    return wrapUp();
  }
  // 할 일이 없으면 연결하지 않는다 (끝남, 사라짐 확인 대기)
  if (memo.list && now() - memo.listAt < LIST_MS && memo.list.every((e) => !jobOf(e.path, per[e.path]))) {
    res.why = isDone(acc, dir) ? 'done' : 'budget';
    return wrapUp();
  }

  const started = now();
  let budget = budgetMs;
  let late = false;
  let stopped = false;
  let connected = false;
  let broke = false;      // FETCH 반복문 안에서 회차를 끝냈다 — 남은 줄을 기다리지 않고 닫는다
  let worked = false;     // 이번 회차에 FETCH 를 보냈다 — «몫 전부가 남았나»
  let setupDone = false;
  let ready = false;      // 본문을 받을 수 있는 줄이 어딘가 있다
  let stretched = false;  // 이번 회차에 몫을 늘렸다
  let client;
  try {
    client = connect(acc);
  } catch (e) {
    res.why = 'connect';
    res.error = mail.friendly(e);
    return wrapUp();
  }
  // 지우기·옮기기·플래그는 이 연결에서 아예 못 하게 한다. imapflow 의 대체 경로도 연결 객체의 메서드를 부른다
  for (const k of FORBIDDEN) {
    client[k] = async () => { throw new Error(`뒤 받기는 ${k}을 쓰지 않습니다`); };
  }
  const kill = () => { try { client.close(); } catch { /* 이미 닫혔다 */ } };
  let lateTimer = null;
  const armLate = (ms) => {
    clearTimeout(lateTimer);
    lateTimer = setTimeout(() => { late = true; kill(); }, ms);
  };
  // 타이머는 연결 전에 건다 — 연결 단계도 몫 안이다
  armLate(budgetMs);
  if (signal) signal.addEventListener('abort', kill, { once: true });

  const cut = () => aborted() || late;
  const askStop = () => {
    let s;
    try { s = !!shouldStop(); } catch { s = true; }
    if (s) stopped = true;
    return s;
  };
  const halted = () => cut() || client.usable === false || askStop();
  const remaining = () => budget - (now() - started);
  // 서버가 그 명령만 거절했다(tagged NO·BAD) — 연결은 살아 있다. 끊긴 것·몫이 끝난 것은 여기 들지 않는다 (mailfwd fetchEach 와 같은 판정)
  const refused = (e) => !!e && (e.responseStatus === 'NO' || e.responseStatus === 'BAD') && client.usable !== false && !cut();
  const report = (phase, c, extra = {}) => {
    try {
      onProgress({ phase, box: c.path, heads: res.heads, saved: res.saved, bytes: res.bytes, ...extra });
    } catch { /* 화면 쪽 실수가 받기를 멈추면 안 된다 */ }
  };
  const markSetup = () => {
    if (setupDone) return;
    setupDone = true;
    memo.setupMs = now() - started;
  };

  /** 쓰기 실패가 디스크·폴더 탓이면 회차를 끝낼 오류를, 메일 탓이면 null 을 준다 */
  const fault = async (e) => {
    if (e && e.code === 'ENOSPC') return turnEnd('disk');
    let why;
    try { why = await dirProblem(dir); } catch (x) { why = (x && x.message) || String(x); }
    return why ? turnEnd('write', why) : null;
  };

  // ── 남은 공간 ──
  const diskFree = async () => {
    try { return await freeBytes(dir); } catch { return Infinity; }   // 모르면 막지 않는다. 진짜로 차면 commit 이 ENOSPC 로 멈춘다
  };
  let floor = null;
  const floorOf = async () => {
    if (floor == null) {
      try { floor = await minFree(dir); } catch { floor = MIN_FREE; }
    }
    return floor;
  };
  const diskCheck = async () => {
    if ((await diskFree()) < await floorOf()) throw turnEnd('disk');
  };

  // ── 상태 ──
  /** 뒤 받기의 패치는 모두 expectV 를 싣는다 — 끊긴 옛 회차의 값이 새 세대 기록에 붙지 않게 */
  const patch = (c, fields, o = {}) => {
    const r = mailbackup.patchState(dir, accKey, c.path, fields, { expectV: c.v, ...o });
    if (r.dropped) throw new Error(`${c.path}: 서버가 메일 번호를 새로 매겨 이 판을 버립니다`);
    if (r.error) throw turnEnd('state', r.error);
    c.rec = r.rec;
    return r.rec;
  };
  const tally = (c) => {
    const last = lastOf(c);
    const waiting = memo.miss.get(c.boxDir);
    let left = 0;
    let bytes = 0;
    let failed = 0;
    let big = 0;
    for (const [uid, r] of c.rows) {
      if (r.srv) continue;
      if (r.st === 'fail') failed += 1;
      else if (r.st === 'big') big += 1;
      else if (r.st === 'head' && uid <= last && !(waiting && waiting.has(uid))) {
        left += 1;
        bytes += Number(r.size) || 0;
      }
    }
    return { left, bytes, failed, big };
  };
  const saveLeft = (c, extra = {}, o = {}) => {
    const t = tally(c);
    return patch(c, {
      ...(Number.isFinite(c.box.exists) ? { exists: c.box.exists } : {}),
      fillLeft: t.left, fillLeftBytes: t.bytes, fillFail: t.failed, fillBig: t.big, ...extra
    }, o);
  };

  // ── 색인 ──
  const put = (c, line) => {
    mailindex.append(c.boxDir, line);
    const cur = c.rows.get(line.uid);
    const next = { ...cur, ...line };
    if (cur && line.seen === null && cur.seen !== undefined) next.seen = cur.seen;
    c.rows.set(line.uid, next);
  };
  /** 못 쓴 줄이 있으면 완료를 적지 않는다. 줄은 버퍼에 남아 다음 회차가 다시 쓴다 */
  const flushOk = async (c) => {
    const f = await mailindex.flush(c.boxDir);
    if (f.unwritten) throw turnEnd('write', f.error || '색인을 쓰지 못했습니다');
  };
  const hasBody = (c) => {
    const last = lastOf(c);
    for (const [uid, r] of c.rows) {
      if (r.st === 'head' && !r.srv && uid <= last && (r.at != null || c.rec.fillHead)) return true;
    }
    return false;
  };

  // ── 폴더 들어가기 ──
  const ctxs = new Map();     // 폴더 경로 → 이번 회차의 그 폴더
  const touched = new Set();
  const badBoxes = new Set();
  let opened = null;
  let twins = null;

  const openDisk = async (c) => {
    try {
      await fs.promises.mkdir(c.boxDir, { recursive: true });   // 없으면 색인 쓰기가 ENOENT 로 전부 실패한다
    } catch (e) {
      throw (await fault(e)) || e;
    }
    await mailindex.ensureMeta(c.boxDir, {
      acc: accKey, user: acc.user, host: acc.host, box: c.path, uidValidity: c.v, gen: genOf(c.rec),
      use: c.entry.specialUse || (c.entry === mail.pickBox(memo.list, 'sent') ? '\\Sent' : '')
    });
    await mailindex.flush(c.boxDir);
    // 이번 실행에서 처음 보는 폴더 — 머리로 못 채운 파일(서버에 없는 메일)만 스캔 줄로 남는다
    if (!memo.scanned.has(c.boxDir)) {
      const r = await mailindex.reconcile(c.boxDir, { shouldStop: halted });
      if (!r.stopped) memo.scanned.add(c.boxDir);
    }
    c.rows = (await mailindex.load(c.boxDir)).rows;   // 못 읽으면 던진다 — 그 폴더를 이번 판에 건너뛴다. 덮어쓰지 않는다
  };

  const enter = async (entry) => {
    const known = ctxs.get(entry.path);
    if (opened === entry.path && known) return known;   // imapflow 는 같은 폴더여도 EXAMINE 을 다시 보낸다
    opened = null;
    // EXAMINE 이다 — 읽음 표시가 바뀌지 않고, 닫아도 지워지지 않는다
    const box = await client.mailboxOpen(entry.path, { readOnly: true });
    // 기록이 없거나 UIDVALIDITY 가 다르면 먼저 표시한다(low=top+1). 없으면 옛 경로처럼 1번부터 오름차순으로 받는다.
    // UIDVALIDITY 를 못 믿으면 던진다 — 폴더 오류이고 세대를 올리지 않는다
    const made = await mailbackup.ensureBox(client, dir, acc, entry.path, box);
    if (made.error) throw turnEnd('state', made.error);
    if (made.genUp) res.genUp = true;
    const boxDir = dirOf(entry.path, made.rec);
    let c = known && known.boxDir === boxDir ? known : null;
    if (c) {
      Object.assign(c, { box, v: String(box.uidValidity), rec: made.rec });
    } else {
      c = {
        entry, path: entry.path, boxDir, box, v: String(box.uidValidity), rec: made.rec,
        rows: new Map(), struck: new Set(), deferred: new Set(), desc: null, at: 0, settled: false, rechecked: false
      };
      ctxs.set(entry.path, c);
      touched.add(boxDir);
      await openDisk(c);
    }
    opened = entry.path;
    return c;
  };

  /** SEARCH ALL. 믿을 수 없는 답이면 폴더 오류이고 아무것도 적지 않는다. 끊겨서 false 가 온 것은 회차 끝이다 */
  const askAll = async (c) => {
    const all = await client.search({ all: true }, { uid: true });
    if (!Array.isArray(all) && (cut() || client.usable === false)) throw new Error('Connection not available');
    if (!searchOk(all, c.box.exists)) throw new Error(`${c.path}: 서버의 검색 답을 믿을 수 없습니다`);
    memo.searchAt.set(c.boxDir, now());
    return all.map(Number);
  };

  /**
   * 답에 없는 줄 가르기. 답에 없다고 바로 «사라짐»으로 적지 않는다 — 10분 넘게 떨어진 다음 검색에도 없어야 적는다.
   * 맨 위 UID 보다 큰 줄은 판정하지 않는다. 답이 위쪽에서 잘렸을 수 있다 — 다만 답의 수가 EXISTS 에 닿으면 잘린 답이 아니다.
   * 그때는 같이 판정한다. 안 그러면 사용자가 위쪽 메일을 지운 폴더에 «못 받음»이 영영 남는다. 빈 답은 넣지 않는다 — 그것은 emptySure 의 몫이고, 믿어도 수를 남겨 보이게 한다.
   */
  const judge = (c, all) => {
    const have = new Set(all);
    let top = 0;
    for (const u of all) if (u > top) top = u;
    const whole = all.length > 0 && Number.isFinite(c.box.exists) && all.length >= c.box.exists;
    const waiting = memo.miss.get(c.boxDir) || new Map();
    for (const [uid, r] of [...c.rows]) {
      if (have.has(uid)) {
        waiting.delete(uid);
        if (r.srv) put(c, { uid, srv: null });
        continue;
      }
      if ((uid > top && !whole) || r.srv || (r.st !== 'head' && r.st !== 'fail')) continue;
      const at = waiting.get(uid);
      if (at == null) {
        waiting.set(uid, now());
      } else if (now() - at >= MISS_GAP_MS) {
        put(c, { uid, srv: 'gone' });
        waiting.delete(uid);
      }
    }
    if (waiting.size) memo.miss.set(c.boxDir, waiting);
    else memo.miss.delete(c.boxDir);
  };

  /**
   * 빈 답을 «정말 비었다»로 믿어도 되나 — judge 와 같은 두 번 확인이다. EXISTS 0 으로 한 번 답하는 서버가 있어, 믿으면 받지도 않은 메일이 «다 받음»이 된다.
   * 메일이 있던 흔적이 있는 폴더는 첫 빈 답에 시각만 적고, MISS_GAP_MS 넘게 떨어진 다음 답도 비어야 믿는다. 사이에 메일이 보이면 시계가 지워져 처음부터다 (patchState).
   * 시각은 memo 가 아니라 상태 파일에 둔다. isDone 은 memo 를 못 보는데, 기다리는 사이에 다른 길로 lowUid 가 내려가도 참이 되면 안 된다. 앱을 다시 켜도 이어진다.
   * 흔적이 없는 폴더는 바로 믿는다. 이미 다 받은 폴더도 믿는다 — 새로 적을 것이 없는데 빈 답 하나로 정리 보류가 다시 걸리면 안 된다.
   * @param all SEARCH ALL 답
   * @returns false 면 이번 답으로 아무것도 적지 않고 돌아간다
   */
  const emptySure = (c, all) => {
    if (all.length) {
      // EXISTS 를 안 주는 서버는 patchState 가 메일을 못 본다
      if (c.rec.fillEmptyAt) patch(c, { fillEmptyAt: 0 });
      return true;
    }
    if (recDone(c.rec)) return true;
    const had = c.rec.fillEmptyAt != null || lastOf(c) > 0 || genOf(c.rec) > 1 || Number(c.rec.exists) > 0 || !!c.rec.fillHadMail || c.rows.size > 0;
    if (!had) return true;
    const clock = emptyClock(c.rec);
    if (clock === 'none') patch(c, { fillEmptyAt: now() });
    return clock === 'passed';
  };

  /**
   * 원문이나 머리를 묶음으로 받는다. 망가진 메일 하나 때문에 서버가 묶음을 통째로 거절하면 한 통씩 다시 받아 그 메일만 가린다.
   * FETCH 반복문 안에서는 IMAP 명령을 보내지 않는다 (imapflow 교착). 옵션 객체는 호출마다 새로 만든다 (imapflow 가 고쳐 쓴다).
   * @returns 실제로 물어본 UID — 묶음 끝에서 «물어본 것 − 받은 줄»을 센다. 서버가 줄을 안 줘도 오류가 나지 않기 때문이다
   */
  const fetchEach = async (uids, query, take, got) => {
    const asked = new Set(uids);
    try {
      for await (const m of client.fetch(uids, query(), { uid: true })) await take(m);
    } catch (e) {
      if (!refused(e)) throw e;
      // 계정 전체의 거절(하루 한도·속도 제한·동시 연결) — 메일 탓이 아니다. 한 통씩 다시 부르면 거절만 쌓이고 까닭은 사라진다
      if (accountWide(e)) throw Object.assign(turnEnd('refused', mail.friendly(e)), { limit: true });
      if (uids.length === 1) return asked;
      asked.clear();
      for (const u of uids) {
        if (got.has(u)) { asked.add(u); continue; }
        if (halted()) break;
        asked.add(u);
        try {
          for await (const m of client.fetch([u], query(), { uid: true })) await take(m);
        } catch (e2) {
          if (!refused(e2)) throw e2;
          if (accountWide(e2)) throw Object.assign(turnEnd('refused', mail.friendly(e2)), { limit: true });
        }
      }
    }
    return asked;
  };

  /** 닫힌 연결의 fetch 는 줄 없이 정상으로 끝난다 (imapflow) — «물어본 것 − 받은 줄»로 세면 비킴이 묶음 전체의 실패가 된다 */
  const missedOf = (asked, got) => {
    const missed = [...asked].filter((u) => !got.has(u));
    if (missed.length && (cut() || client.usable === false)) throw new Error('Connection not available');
    return missed;
  };

  // ── 머리 ──
  const headChunk = async (c, part) => {
    markSetup();
    worked = true;
    const want = new Set(part);
    const got = new Set();
    const take = (msg) => {
      // 알림 줄에는 UID 가 없다 — 메일이 아니다
      if (!Number.isInteger(msg.uid) || !want.has(msg.uid)) return;
      got.add(msg.uid);
      const cur = c.rows.get(msg.uid) || {};
      const line = mailindex.rowFromFetch(msg, 'fill');
      if (cur.via) delete line.via;
      // 파일 이름에서 얻은 값이 지금 시각보다 낫다 (못 읽는 INTERNALDATE)
      if (!mail.timeOf(msg.internalDate) && cur.at != null) delete line.at;
      // 서버가 ENVELOPE 에 Message-ID 를 안 줬다 — 비교할 값이 없는 것이지 다른 메일이 아니다. 다르다고 하면 받아 둔 메일을 질문 없이 전부 다시 받는다
      if (!line.mid && cur.mid) delete line.mid;
      if (cur.st === 'file' && line.mid && mailtidy.normId(cur.mid) !== mailtidy.normId(line.mid)) {
        // 번호만 같고 다른 메일이다 (상태 파일을 잃고 세대를 못 올린 폴더) — 옛 파일은 두고 다시 받는다
        line.file = null;
        line.st = 'head';
      } else if (cur.st && cur.st !== 'head') {
        // 이미 결론이 난 줄의 파일 칸을 지우지 않는다
        delete line.file;
        delete line.st;
      }
      put(c, line);
      res.heads += 1;
    };
    const query = () => ({ uid: true, envelope: true, internalDate: true, flags: true, size: true });
    const asked = await fetchEach(part, query, take, got);
    for (const u of missedOf(asked, got)) put(c, { uid: u, hf: (Number((c.rows.get(u) || {}).hf) || 0) + 1 });
    await flushOk(c);
    report('head', c);
  };

  /** 머리에 쓸 시간이 끝났나 — 본문을 받을 줄이 하나도 없으면 묶음을 더 받는다 */
  const headsOver = (headUntil, c) => {
    if (now() < headUntil) return false;
    if (!ready && c && hasBody(c)) ready = true;
    return ready;
  };

  const fillHeads = async (entry, headUntil) => {
    const c = await enter(entry);
    report('head', c);
    const all = await askAll(c);
    judge(c, all);
    const last = lastOf(c);
    // 서버 검색의 UID 마다 자리표를 먼저 쓴다. 머리를 못 받은 UID 도 대기열과 완료 판정에서 빠지지 않게
    let holes = 0;
    for (const u of all) {
      if (u <= last && !c.rows.has(u)) {
        put(c, { uid: u, st: 'head', via: 'fill' });
        holes += 1;
        if (holes % HOLE_FLUSH === 0) await flushOk(c);
      }
    }
    if (holes) await flushOk(c);
    // 첫 빈 답에는 머리가 끝났다고 적지 않는다 — fillHead 가 서면 메일이 돌아와도 머리 없이 한 통씩 받아 크기·읽음을 모른다
    if (!emptySure(c, all)) return;
    saveLeft(c);

    const needs = (r) => (r.at == null || r.seen === null) && (Number(r.hf) || 0) < STRIKES;
    const todo = all.filter((u) => u <= last && needs(c.rows.get(u))).sort((x, y) => y - x);
    for (let i = 0; i < todo.length; i += HEAD_CHUNK) {
      if (halted() || headsOver(headUntil, c)) return;
      await headChunk(c, todo.slice(i, i + HEAD_CHUNK));
    }
    if (!ready && hasBody(c)) ready = true;

    // 다 끝난 것 같아도 다시 읽어 확인한다. 파일이 없는 줄(머리·자리표)을 잃으면 reconcile 이 메우지 못한다
    await flushOk(c);
    c.rows = (await mailindex.load(c.boxDir)).rows;
    c.desc = null;
    for (const u of all) {
      if (u > last) continue;
      const r = c.rows.get(u);
      if (!r) {
        put(c, { uid: u, st: 'head', via: 'fill' });
        return;
      }
      if (needs(r)) return;
    }
    // lowUid≤1 인 옛 기록(«백업 시작»)도 confirmBox 를 지나게 올려 둔다 — fillHead 와 lowUid≤1 이 만나면 곧 완료로 읽힌다
    if (Number(c.rec.lowUid) > 1) saveLeft(c, { fillHead: true });
    else saveLeft(c, { fillHead: true, lowUid: Math.max(2, last + 1) }, { raiseLow: true });
    ready = ready || hasBody(c);
  };

  // ── 본문 ──
  const strike = (c, uid, giveUp = false) => {
    const was = (Number((c.rows.get(uid) || {}).fails) || 0) + 1;
    const n = giveUp ? Math.max(was, STRIKES) : was;
    put(c, { uid, fails: n, ...(n >= STRIKES ? { st: 'fail' } : {}) });
    c.struck.add(uid);
    if (n >= STRIKES) memo.retried.add(failKey(c, uid));
  };

  /** 파일 쓰기까지. 메일 탓 쓰기 실패는 그 UID 에 실패를 적고 다음 통으로 간다 — 백신이 막은 메일 하나가 그 아래를 영영 막지 않게 */
  const saveBody = async (c, msg) => {
    const r = c.rows.get(msg.uid) || {};
    const at = mail.timeOf(msg.internalDate) || Number(r.at) || Date.now();
    let made = null;
    if (r.at == null) {
      // 머리를 끝내 못 받은 줄이다 — 원문에서 채운다
      try { made = await mailindex.rowFromSource(msg.source, { uid: msg.uid, at, seen: null, via: r.via || 'fill' }); } catch { made = null; }
    }
    let saved;
    try {
      saved = await mailbackup.commit(c.boxDir, {
        uid: msg.uid, receivedAt: at, subject: made ? made.subject : r.subject || '', source: msg.source
      });
    } catch (e) {
      const end = await fault(e);
      if (end) {
        broke = true;
        throw end;
      }
      strike(c, msg.uid);
      return 0;
    }
    put(c, {
      ...(made || {}), ...(r.at == null ? { at, size: saved.bytes } : {}),
      uid: msg.uid, file: saved.name, bytes: saved.bytes, st: 'file'
    });
    res.saved += 1;
    res.bytes += saved.bytes;
    return saved.bytes;
  };

  /**
   * 끊긴 묶음 — 비킴·몫 끝은 메일 탓이 아니다. 다만 몫 안에 못 받는 메일을 안 세면 대기열을 영영 막고, 같은 메일을 회차마다 처음부터 다시 받는다.
   * 그래서 마지막 줄 뒤로 회차에서 일한 시간의 절반 넘게 기다렸을 때만 본다. 몫이 폴링에 줄어 어떤 값이 되든 같은 잣대다.
   * 여러 통이 남았으면 어느 메일 탓인지 모르니 묶음을 가르고, 한 통이 남았으면 그 메일을 센다. STRIKES 번이면 st:fail — 24시간과 앱 실행마다 다시 시도한다.
   * 폴링이 끊은 것(비킴)은 세지 않는다. 몫을 15분으로 늘려도 폴링이 먼저 끊으니 메일이 그 창을 넘는지 알 길이 없고, 세면 첫 줄이 창보다 늦은 서버에서 건강한 메일이 차례로 st:fail 이 된다.
   * 대신 뒤로 돌려 대기열을 막지 않고, 하루가 넘게 못 받으면 st:fail 로 끝내 계정이 영영 안 끝나는 일을 막는다.
   * @param rowAt 마지막으로 줄을 받은 때 (없으면 FETCH 를 보낸 때)
   */
  const noteCut = (c, part, got, rowAt) => {
    const rest = part.filter((u) => !got.has(u));
    const slept = now() - started > budget + sleepMs;
    if (!cut()) {
      memo.chunk = Math.max(1, Math.floor(memo.chunk / 2));
      if (part.length === 1 && rest.length === 1 && !slept) strike(c, part[0]);
      return;
    }
    const stalled = now() - rowAt;
    if (slept || !rest.length || stalled < CUT_MIN_MS || stalled * 2 < now() - started - memo.setupMs) return;
    if (rest.length > 1) {
      memo.chunk = Math.max(1, Math.floor(Math.min(memo.chunk, rest.length) / 2));
      return;
    }
    const key = failKey(c, rest[0]);
    if (aborted() && signal.reason === 'yield') {
      if (!memo.cuts.has(key)) memo.cuts.set(key, 0);
      if (!memo.cutSince.has(key)) memo.cutSince.set(key, now());
      if (now() - memo.cutSince.get(key) >= RETRY_FAIL_MS) strike(c, rest[0], true);
      return;
    }
    const n = (memo.cuts.get(key) || 0) + 1;
    memo.cuts.set(key, n);
    // 몫 끝까지 첫 줄이 안 왔다 — 서버가 느린 것일 수 있다. 다음 회차는 끊긴 적 없는 메일도 몫을 늘린다 (fillBodies)
    if (!got.size) memo.slowRow = true;
    if (n >= STRIKES) strike(c, rest[0], true);
  };

  /** 위에서부터 빈틈없이 끝난 데까지 lowUid 를 내린다. 1은 적지 않는다 — 완료는 confirmBox 만 적는다 */
  const lowered = (c) => {
    if (!c.desc) {
      const last = lastOf(c);
      c.desc = [...c.rows.keys()].filter((u) => u <= last).sort((x, y) => y - x);
      c.at = 0;
    }
    let low = null;
    while (c.at < c.desc.length) {
      const r = c.rows.get(c.desc[c.at]);
      if (r.st === 'head' && !r.srv) break;
      low = c.desc[c.at];
      c.at += 1;
    }
    return low == null ? {} : { lowUid: Math.max(2, low) };
  };

  const takeBatch = async (c, part) => {
    markSetup();
    worked = true;
    for (const u of part) {
      if (c.rows.get(u).st === 'fail') memo.retried.add(failKey(c, u));
      if (memo.cuts.has(failKey(c, u))) memo.triedAt.set(failKey(c, u), now());
    }
    const want = new Set(part);
    const got = new Set();
    let bytes = 0;
    const sentAt = now();
    let rowAt = sentAt;
    let firstMs = null;     // 첫 줄까지 걸린 시간
    const take = async (msg) => {
      if (!Number.isInteger(msg.uid) || !want.has(msg.uid) || got.has(msg.uid) || !msg.source || !msg.source.length) return;
      if (firstMs == null) firstMs = now() - sentAt;
      bytes += await saveBody(c, msg);
      got.add(msg.uid);
      rowAt = now();
      const done = failKey(c, msg.uid);
      memo.cuts.delete(done);
      memo.cutSince.delete(done);
      memo.triedAt.delete(done);
    };
    const query = () => ({ uid: true, source: true, internalDate: true });
    let missed;
    try {
      missed = missedOf(await fetchEach(part, query, take, got), got);
    } catch (e) {
      if (!e.turnEnd) noteCut(c, part, got, rowAt);
      throw e;
    }
    // 서버가 줄을 안 줬거나 원문이 안 왔다 — 오류 없이 지나가므로 여기서 센다
    for (const u of missed) strike(c, u);
    if (firstMs != null && firstMs * 2 < budgetMs) memo.slowRow = false;
    if (bytes > 0) {
      memo.chunk = Math.min(BODY_N, memo.chunk + 1);
      const speed = bytes / (Math.max(1, now() - sentAt) / 1000);
      memo.bps = memo.bps > 0 ? memo.bps * 0.7 + speed * 0.3 : speed;   // 초당 바이트
    }
    await flushOk(c);
    saveLeft(c, lowered(c));
    report('body', c);
  };

  /** 파일이 있는 st:head 줄 — 파일이 정말 그 메일인지 보고 file 을 채운다. 다르면 채우지 않고 받는다. 옛 파일은 건드리지 않는다 */
  const settleFiles = async (c) => {
    const files = await mailbackup.uidFiles(c.boxDir);
    if (!files) throw new Error(`${c.path}: 저장 폴더를 읽을 수 없습니다`);
    for (const [uid, list] of files) {
      const r = c.rows.get(uid);
      if (!r || r.st !== 'head') continue;
      if (r.mid === undefined && !c.rec.fillHead) continue;   // 머리를 아직 안 받았다 — 비교할 Message-ID 를 모른다
      for (const f of list) {
        const m = await mailindex.fileMatches(f, r.mid, r.size);
        if (m.damaged) {
          // 지우지 않는다. 이름만 비켜 UID 규칙에서 뺀다
          await fs.promises.rename(f, `${f}.damaged`).catch(() => {});
        } else if (m.same) {
          const st = await fs.promises.stat(f);
          put(c, { uid, file: path.basename(f), bytes: st.size, st: 'file' });
          break;
        }
      }
    }
  };

  /** 폴더를 연 김에 — exists 가 줄었거나 지난 검색이 오래됐으면 사라진 줄만 다시 본다. 처음 보는 폴더는 시계만 건다 */
  const recheck = async (c) => {
    if (c.rechecked || !c.rec.fillHead) return;
    c.rechecked = true;
    const asked = memo.searchAt.get(c.boxDir);
    if (asked == null) memo.searchAt.set(c.boxDir, now());
    const shrunk = Number.isFinite(c.box.exists) && Number.isFinite(c.rec.exists) && c.box.exists < c.rec.exists;
    if (!shrunk && !(asked != null && now() - asked >= SEARCH_MS)) return;
    try {
      judge(c, await askAll(c));
    } catch (e) {
      if (e.turnEnd || cut() || client.usable === false) throw e;
    }
  };

  const queueOf = (c) => {
    const retry = new Set();
    for (const [uid, r] of c.rows) if (r.st === 'fail' && memo.retried.has(failKey(c, uid))) retry.add(uid);
    const waiting = memo.miss.get(c.boxDir);
    const list = mailindex.pendingOf(c.rows, { lastUid: lastOf(c), fillHead: !!c.rec.fillHead, retry });
    return waiting ? list.filter((u) => !waiting.has(u)) : list;
  };

  // \All 에서만 쓴다. 다른 폴더 색인에 (mid, size)가 같고 파일이 있는 줄 — Gmail 의 전체보관함이 메일함 전체를 두 번 받지 않게
  const loadTwins = async (self) => {
    const out = new Map();
    const state = mailbackup.loadState(dir)[accKey] || {};
    for (const entry of memo.list) {
      const rec = state[entry.path];
      if (entry.path === self.path || !rec) continue;
      const boxDir = dirOf(entry.path, rec);
      await mailindex.flush(boxDir);
      let rows;
      try { ({ rows } = await mailindex.load(boxDir)); } catch { continue; }
      for (const [uid, r] of rows) {
        const id = mailtidy.normId(r.mid);
        if (r.st !== 'file' || !r.file || !id) continue;
        const key = `${id}\n${Number(r.size) || 0}`;
        if (!out.has(key)) out.set(key, { box: entry.path, uid, file: path.join(boxDir, r.file) });
      }
    }
    return out;
  };
  const twinOf = async (c, r) => {
    const id = mailtidy.normId(r.mid);
    if (!id || !hasUse(c.entry, '\\All')) return null;
    if (!twins) twins = await loadTwins(c);
    const hit = twins.get(`${id}\n${Number(r.size) || 0}`);
    if (!hit) return null;
    try { await fs.promises.access(hit.file); } catch { return null; }
    return { box: hit.box, uid: hit.uid };
  };

  /** 묶음은 memo.chunk 통 또는 8MB까지. 8MB 초과와 크기를 모르는 줄(머리 없음), 전에 끊긴 줄은 혼자 받는다 */
  const pick = (c, order, from) => {
    const part = [];
    let bytes = 0;
    for (let i = from; i < order.length; i++) {
      const r = c.rows.get(order[i]);
      const size = Number(r.size) || 0;
      const alone = r.at == null || size > BIG_BYTES || memo.cuts.has(failKey(c, order[i]));
      if (part.length && (alone || part.length >= memo.chunk || bytes + size > BODY_BYTES)) break;
      part.push(order[i]);
      bytes += size;
      if (alone) break;
    }
    return part;
  };

  // ── 폴더 끝 ──
  const partnerAlive = async (ref, cache, state) => {
    if (!ref || !ref.box) return false;
    let rows = cache.get(ref.box);
    const rec = state[ref.box];
    if (!rec) return false;
    const boxDir = dirOf(ref.box, rec);
    if (!rows) {
      await mailindex.flush(boxDir);
      try { ({ rows } = await mailindex.load(boxDir)); } catch { return false; }
      cache.set(ref.box, rows);
    }
    const r = rows.get(ref.uid);
    if (!r || r.st !== 'file' || !r.file) return false;
    try { await fs.promises.access(path.join(boxDir, r.file)); return true; } catch { return false; }
  };

  /**
   * 답이 EXISTS 보다 조금 적어도 믿어도 되나. 유령 메일을 세거나 지운 표시를 검색에서 빼는 서버는 늘 이렇게 답한다 — 안 믿으면 다 받고도 완료를 못 적어 정리 보류가 안 풀린다.
   * judge·emptySure 와 같은 두 번 확인이다. 부족분이 작고, MISS_GAP_MS 넘게 떨어진 두 답의 (exists, 답의 수)가 똑같을 때만 믿는다. 답 하나로 완료를 적는 길은 막아 둔다.
   * 부족분 문턱은 searchOk 보다 좁다 — 거기는 20통 폴더의 1통 답도 지나간다
   */
  const shortSure = (c, all) => {
    const exists = c.box.exists;
    if (exists - all.length > Math.max(3, exists * 0.02)) return false;
    const seen = memo.short.get(c.boxDir);
    if (!seen || seen.exists !== exists || seen.found !== all.length || seen.at > now()) {
      memo.short.set(c.boxDir, { exists, found: all.length, at: now() });
      return false;
    }
    return now() - seen.at >= MISS_GAP_MS;
  };

  /** 폴더 일이 끝났을 때 한 번 돈다. 명령은 SEARCH 하나다. 비었다는 것만으로 lowUid:1 을 적지 않는다 */
  const confirmBox = async (c) => {
    await flushOk(c);
    const all = await askAll(c);
    // 완료를 적는 자리는 머리 단계보다 엄격하다 — searchOk 문턱은 20통 폴더의 1통 답도 지나간다. 줄이 없는 UID 는 대기열에도 판정에도 안 잡혀
    // 거짓 «다 받음»이 된다. SEARCH ALL 과 EXISTS 는 지운 표시 메일까지 같은 수를 세므로 늘어나는 쪽만 믿는다 (늘 조금 적은 서버는 shortSure)
    if (Number.isFinite(c.box.exists) && all.length < c.box.exists && !shortSure(c, all)) throw new Error(`${c.path}: 서버의 검색 답을 믿을 수 없습니다`);
    if (!emptySure(c, all)) return;
    // 다시 읽는다 — 버퍼 상한으로 버린 줄이 여기서 드러난다
    c.rows = (await mailindex.load(c.boxDir)).rows;
    c.desc = null;
    judge(c, all);
    const last = lastOf(c);
    let again = false;
    for (const u of all) {
      if (u > last) continue;
      const r = c.rows.get(u);
      if (!r) {
        put(c, { uid: u, st: 'head', via: 'fill' });
        again = true;
      } else if (r.st === 'head' && !r.srv) {
        again = true;
      }
    }
    const cache = new Map();
    const state = mailbackup.loadState(dir)[accKey] || {};   // 줄마다 읽지 않는다 — 메인이 그만큼 멎는다
    let dups = 0;
    for (const [uid, r] of [...c.rows]) {
      if (r.st !== 'dup') continue;
      // 끊겼으면 완료를 적지 않고 다음 회차에 다시 본다. 듣지 않으면 «멈추기»와 폴더 바꾸기가 이 고리를 기다린다
      if (++dups % LOOP_CHECK === 0 && halted()) return;
      if (!(await partnerAlive(r.dupOf, cache, state))) {
        put(c, { uid, st: 'head', dupOf: null });
        again = true;
      }
    }
    await flushOk(c);
    const waiting = memo.miss.get(c.boxDir);
    if (again || (waiting && waiting.size) || tally(c).left > 0) {
      // 재시도로 연 끝난 폴더에서 받을 줄이 다시 생겼다 — 하루를 기다리지 않고 다음 회차가 받는다
      if (again || tally(c).left > 0) memo.retried.delete(c.boxDir);
      saveLeft(c);
      return;
    }
    saveLeft(c, { lowUid: 1, fillHead: true, fillEmptyAt: undefined });
    await mailindex.compact(c.boxDir);
  };

  const fillBodies = async (entry, stretching = false) => {
    const c = await enter(entry);
    // 세대가 막 바뀐 폴더 — 검색 전에 남은 수를 적으면 «남은 0»으로 읽힌다. 다음 회차의 머리 일감이다
    if (!c.rec.fillHead && !c.rows.size) return;
    // 첫 빈 답에는 부르지 않는다 — 줄이 안 와 멀쩡한 메일에 fails 가 오르고, 세 번이면 메일함 전체가 st:fail 이다
    if (c.box.exists === 0 && !emptySure(c, await askAll(c))) return;
    report('body', c);
    if (!c.settled) {
      await settleFiles(c);
      c.settled = true;
    }
    await recheck(c);

    const small = [];
    const large = [];
    let looked = 0;
    for (const uid of queueOf(c)) {
      if (++looked % LOOP_CHECK === 0 && halted()) return;
      if (c.struck.has(uid)) continue;    // 같은 회차 안에서는 다시 부르지 않는다
      const r = c.rows.get(uid);
      const size = Number(r.size) || 0;
      if (size > MAX_BYTES) {
        // 파일이 없으니 정리가 옮기지 않아 잃지 않는다
        put(c, { uid, st: 'big' });
        continue;
      }
      const twin = await twinOf(c, r);
      if (twin) {
        put(c, { uid, st: 'dup', dupOf: twin });
        continue;
      }
      (size > BIG_BYTES || memo.cuts.has(failKey(c, uid)) ? large : small).push(uid);
    }
    // 전에 끊긴 메일끼리는 오래전에 시도한 것부터 — 폴링 창보다 긴 메일 하나가 그 뒤의 메일을 영영 막지 않게
    const triedOf = (u) => memo.triedAt.get(failKey(c, u)) || 0;
    large.sort((x, y) => triedOf(x) - triedOf(y));
    const order = [...small, ...large];   // 큰 메일이나 전에 끊긴 메일 하나가 작은 메일 수백 통을 기다리게 하지 않는다

    for (let i = 0; i < order.length;) {
      if (halted()) return;
      const part = pick(c, order, i);
      i += part.length;
      const size = Number(c.rows.get(part[0]).size) || 0;
      if (part.length === 1 && size > BIG_BYTES) {
        const need = memo.bps > 0 ? (size / memo.bps) * 1000 : 0;
        // 속도를 모르면 몫이 통째로 남았을 때만 시작한다
        const fits = memo.bps > 0 ? need <= remaining() : !worked;
        if (!fits) {
          if (!stretching || !(memo.bps > 0)) {
            c.deferred.add(part[0]);
            continue;
          }
          // 남은 일이 이런 메일뿐이다 — 몫을 늘리지 않으면 영영 시작하지 못한다
          const ms = Math.max(remaining(), Math.min(bigTurnMs, need * 1.5));
          budget = now() - started + ms;
          armLate(ms);
          report('body', c, { extendMs: ms });
        }
        c.deferred.delete(part[0]);
      }
      await diskCheck();
      if (halted()) return;   // 공간을 보는 사이에 끊겼을 수 있다
      // 전에 끊긴 메일 — 몫을 상한까지 늘려 한 번 시도한다. 8MB 이하이거나 앱을 다시 켜 속도를 몰라도 같다. 몫을 못 늘리면 몫보다 오래 걸리는 메일은 영영 못 받는다.
      // 첫 줄이 몫보다 늦은 서버면(slowRow) 끊긴 적 없는 메일도 회차에 한 번 늘린다. 통마다 끊겨 봐야 늘리면 한 통도 못 받는 회차가 폴더 통수만큼 이어지고, 그사이 물러나기가 간격을 늘린다
      const wasCut = part.length === 1 && memo.cuts.has(failKey(c, part[0]));
      if ((wasCut || (part.length === 1 && memo.slowRow && !stretched)) && remaining() < bigTurnMs) {
        stretched = true;
        budget = now() - started + bigTurnMs;
        armLate(bigTurnMs);
        report('body', c, { extendMs: bigTurnMs });
      }
      await takeBatch(c, part);
    }
    if (halted()) return;

    // 이번 회차에 못 부른 줄(거절·큰 메일)이 남았으면 다음 회차다. 끝나 보이면 확인을 돈다
    if (c.rec.fillHead && !queueOf(c).length) {
      memo.retried.add(c.boxDir);
      await confirmBox(c);
    } else {
      await flushOk(c);
      saveLeft(c, lowered(c));
    }
  };

  /** 폴더 오류는 적고 다음 폴더로 간다. 연결이 죽었거나 회차를 끝낼 일이면 더 올린다 */
  const guarded = async (entry, work) => {
    try {
      await work();
    } catch (e) {
      if (e.turnEnd || e.code === 'STATE_UNREADABLE' || cut() || client.usable === false) throw e;
      badBoxes.add(entry.path);
      // 다 받은 폴더의 재시도가 폴더 오류로 끝났다 — 그날 몫을 쓴 것으로 친다. 안 적으면 retryDue 가 계속 참이고, why 가 done 이라 물러나기도 없이 30초마다 로그인한다
      const done = (mailbackup.loadState(dir)[accKey] || {})[entry.path];
      if (done && recDone(done)) memo.retried.add(dirOf(entry.path, done));
      const why = mail.friendly(e);
      res.boxErrors.push(why.startsWith(`${entry.path}: `) ? why : `${entry.path}: ${why}`);
    }
  };

  // ── 폴더 목록 ──
  let listedNow = false;   // 이번 회차에 LIST 를 받았다
  const targetsOf = async () => {
    if (!memo.list || now() - memo.listAt >= LIST_MS) {
      const list = await client.list();
      const mine = mailtidy.mineOf(client);
      // 공유 폴더의 메일은 받지 않는다. 내 것과 남의 것을 가를 수 없으면 받은편지함만 받는다
      const own = (list || []).filter(mine || isInbox).filter(mailbackup.backsUp);
      // 빈 목록을 믿으면 모든 기록이 «대상 아님»이 되어 곧 «다 받음»으로 읽힌다
      if (!own.length) throw turnEnd('connect', '서버가 폴더 목록을 주지 않았습니다');
      const sent = mail.pickBox(own, 'sent');
      const rank = (b) => {
        if (isInbox(b)) return 0;
        if (b === sent) return 1;
        if (hasUse(b, '\\All')) return 4;
        return hasUse(b, '\\Drafts') ? 3 : 2;
      };
      memo.list = [...own].sort((x, y) => rank(x) - rank(y));
      memo.listAt = now();
      listedNow = true;
    }
    return memo.list;
  };

  /** 목록에 없는데 아직 표시가 없는 기록 — 받는 사이에 새로 생긴 폴더일 수 있다 */
  const wouldSkip = (targets) => {
    const want = new Set(targets.map((e) => e.path));
    const state = mailbackup.readStateInfo(dir).state[accKey] || {};
    return Object.entries(state).some(([boxPath, rec]) => rec && typeof rec === 'object' && !rec.fillSkip && !want.has(boxPath));
  };

  const markSkips = (targets) => {
    const state = mailbackup.readStateInfo(dir).state[accKey] || {};
    const want = new Set(targets.map((e) => e.path));
    const write = (boxPath, fields) => {
      const r = mailbackup.patchState(dir, accKey, boxPath, fields);
      if (r.error) throw turnEnd('state', r.error);
    };
    for (const [boxPath, rec] of Object.entries(state)) {
      if (!rec || typeof rec !== 'object' || !!rec.fillSkip === !want.has(boxPath)) continue;
      // 빈 답 확인 중인 폴더는 LIST 에 한 번 없다고 빼지 않는다 — 빼면 isDone 이 그 폴더를 안 봐 확인 없이 «다 받음»이 된다. 10분 넘게 떨어져 또 없으면 뺀다
      if (!want.has(boxPath) && rec.fillEmptyAt != null) {
        const clock = emptyClock(rec);
        if (clock === 'none') write(boxPath, { fillEmptyAt: now() });
        if (clock !== 'passed') continue;
      }
      write(boxPath, { ...rec, fillSkip: want.has(boxPath) ? undefined : true });
    }
    // 아직 못 연 폴더에도 빈 기록을 둔다 — 기록이 없으면 isDone 이 그 폴더를 못 보고 «다 받음»이 된다. 첫 표시(ensureBox)가 통째로 바꾼다
    for (const boxPath of want) if (!state[boxPath]) write(boxPath, { fillHead: false });
  };

  try {
    // close 이벤트로 끝난다 — TCP·TLS 단계에서 끊으면 connect() 는 영원히 끝나지 않는다
    await mail.connectOrClose(client);
    connected = true;

    let targets = await targetsOf();
    // 묵은 목록으로 표시를 붙이면 그 폴더를 빼고 «다 받음»이 된다. 다 받으면 회차가 안 돌아 표시가 영영 안 풀린다 — 붙이기 전에 목록을 다시 받는다
    if (!listedNow && wouldSkip(targets)) {
      memo.list = null;
      targets = await targetsOf();
    }
    markSkips(targets);
    const recNow = () => mailbackup.readStateInfo(dir).state[accKey] || {};

    // 머리 — 쓸 시간은 회차 몫의 1/3이다
    const headUntil = started + budgetMs * HEAD_SHARE;
    let state = recNow();
    ready = targets.some((e) => state[e.path] && state[e.path].fillHead && Number(state[e.path].fillLeft) > 0);
    for (const entry of targets) {
      if (halted() || headsOver(headUntil)) break;
      if (jobOf(entry.path, state[entry.path]) === 'head') await guarded(entry, () => fillHeads(entry, headUntil));
    }

    // 전 폴더 머리가 끝났으면 받을 양을 안다 — 시스템 드라이브를 채우기 전에 본문을 시작하지 않는다
    state = recNow();
    const counted = targets.filter((e) => !(state[e.path] && noValidity(state[e.path])));
    if (!halted() && counted.every((e) => state[e.path] && state[e.path].fillHead)) {
      const leftBytes = counted.reduce((sum, e) => sum + (Number(state[e.path].fillLeftBytes) || 0), 0);
      const room = (await diskFree()) - await floorOf();
      if (leftBytes > 0 && leftBytes > room) {
        // 남은 전체가 아니라 부족분이다 — 화면이 이 값으로 «얼마나 비울지» 말한다
        res.need = leftBytes - room;
        throw turnEnd('disk');
      }
    }

    // 본문 — 남은 몫으로 폴더 차례대로
    for (const entry of targets) {
      if (halted()) break;
      if (badBoxes.has(entry.path)) continue;
      const rec = recNow()[entry.path];
      const job = jobOf(entry.path, rec);
      // 머리를 아직 못 본 폴더는 줄이 있을 때만 연다
      if (!job || (job === 'head' && !ctxs.has(entry.path) && !(Number(rec && rec.fillLeft) > 0))) continue;
      await guarded(entry, () => fillBodies(entry));
    }
    // 남은 일이 시간이 모자란 큰 메일뿐일 때
    for (const c of [...ctxs.values()]) {
      if (halted()) break;
      if (c.deferred.size && memo.bps > 0 && !badBoxes.has(c.path)) await guarded(c.entry, () => fillBodies(c.entry, true));
    }
  } catch (e) {
    if (e.turnEnd) {
      res.why = e.turnEnd;
      if (e.note) res.error = e.note;
      if (e.limit) res.limit = true;
    } else if (e.code === 'STATE_UNREADABLE') {
      res.why = 'state';
      res.error = e.message;
    } else if (!cut()) {
      // 던져진 오류보다 끊은 사실을 먼저 본다 — 비킴을 연결 실패로 세지 않는다
      res.why = connected ? 'connect' : connectWhy(e);
      res.error = mail.friendly(e);
    }
  }

  // 쓰다 만 폴더 — 못 쓴 줄은 버퍼에 남는다. 파일이 있는 줄을 잃어도 reconcile 이 메운다
  for (const boxDir of touched) {
    await mailindex.flush(boxDir).catch(() => {});
  }

  if (!res.why) {
    if (aborted()) res.why = abortWhy();
    else if (late) res.why = 'budget';
    else if (stopped) res.why = 'stop';
    else if (client.usable === false) {
      res.why = 'connect';
      res.error = '연결이 끊겼습니다';
    } else if (isDone(acc, dir)) {
      res.why = 'done';
    } else if (!res.heads && !res.saved && res.boxErrors.length) {
      // 받은 것 없이 폴더 오류뿐이면 물러나기를 타게 한다. 그대로 두면 30초마다 같은 폴더를 두드린다
      res.why = 'connect';
      res.error = res.boxErrors[0];
    } else {
      res.why = 'budget';
    }
  }

  // 연결 준비가 창이나 몫보다 길면 첫 FETCH 전에 끊겨 setupMs 가 안 찬다 — 게이트가 배우게 걸린 시간을 남긴다. 다음 FETCH 가 진짜 값으로 고쳐 쓴다
  res.noGain = (late || (aborted() && signal.reason === 'yield')) && !res.heads && !res.saved;
  if (res.noGain && !setupDone) memo.setupMs = Math.max(Number(memo.setupMs) || 0, now() - started);

  try {
    if (cut() || broke || !connected || client.usable === false) kill();
    else await client.logout();
  } catch {
    kill();
  }
  clearTimeout(lateTimer);
  if (signal) signal.removeEventListener('abort', kill);
  return wrapUp();
}

module.exports = {
  fillAccount, countPending, allBelow, isDone, unfillable, retryDue, scanAccount, searchOk,
  HEAD_CHUNK, BODY_N, BODY_BYTES, BIG_BYTES, MAX_BYTES, MIN_FREE, SYSTEM_FREE, STRIKES, HEAD_SHARE,
  LIST_MS, MISS_GAP_MS, RETRY_FAIL_MS, CUT_MIN_MS, FORBIDDEN
};

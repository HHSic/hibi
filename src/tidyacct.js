'use strict';
// 서버 정리 — 계정마다의 설정과 결과를 다루는 순수 함수들 (store.js · backup.js 가 같이 쓴다).
//
// Electron 도 imapflow 도 쓰지 않는다 — 시험이 node 로 바로 부른다.
// 설정 모양: mailTidyAccounts { 계정 id: { on, days, copyAsk? } }, mailTidyResults { 계정 id: 마지막 결과 }.
// copyAsk — 옛 설정에서 옮겨 온 켜짐이라 MOVE 없는 서버의 «복사한 뒤 지우기»는 묻지 않았다 (backup.js 가 옮기기 전에 끄고 다시 묻는다).
// 항목이 없는 계정은 꺼짐·30일이다 — 새로 더한 계정은 묻기 전에는 정리 대상이 아니다.

// 0 은 «바로» — 날짜 대신 읽음을 본다 (src/mailtidy.js DAYS 와 같아야 한다). 0이 거짓 값이라 `|| 30` 으로 다듬지 않는다
const TIDY_DAYS = [0, 7, 30, 90];
const ACC_ID = /^[\w.-]{1,64}$/;
const MAX_ACCOUNTS = 50;
const ERROR_MAX = 200;
// 이 값이 바뀐 계정은 정리에서 뺀다 — 확인 창은 바꾸기 전의 서버·아이디를 두고 물었다
const PATH_KEYS = ['host', 'port', 'user', 'mailbox'];
const OFF = Object.freeze({ on: false, days: 30 });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 계정 id 로 쓸 수 있나 — __proto__ 는 열쇠로 쓰지 않는다 */
function goodId(id) {
  return typeof id === 'string' && ACC_ID.test(id) && id !== '__proto__';
}

/** 목록의 값을 그대로 (-0 도 0). 그 밖은 30 */
function normDays(v) {
  const d = TIDY_DAYS.find((x) => x === v);
  return d === undefined ? 30 : d;
}

/** 한 계정의 설정 — on 은 참일 때만 켜짐. copyAsk 는 켜진 항목의 true 만 (꺼지면 다시 켤 때 확인 창이 묻는다) */
function normEntry(x) {
  if (!isObj(x)) return undefined;
  const on = x.on === true;
  return { on, days: normDays(x.days), ...(on && x.copyAsk === true ? { copyAsk: true } : {}) };
}

/** 0 이상 정수만 — 손으로 고친 파일·이상한 값은 0 */
function count(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 마지막 결과 한 건 — 숫자·참거짓·200자로 다듬는다 */
function normResult(v) {
  if (!isObj(v)) return undefined;
  const text = (s) => (typeof s === 'string' && s ? s.slice(0, ERROR_MAX) : null);
  return {
    at: count(v.at), days: normDays(v.days),
    moved: count(v.moved), kept: count(v.kept), unsaved: count(v.unsaved), unverified: count(v.unverified),
    spared: count(v.spared), important: count(v.important), flagged: count(v.flagged),
    unread: count(v.unread), uncertain: count(v.uncertain), skippedBoxes: count(v.skippedBoxes),
    more: v.more === true, error: text(v.error), oldest: count(v.oldest), blocked: v.blocked === true,
    // PC 에 저장 기록이 없어 건너뛴 폴더 수 (skippedBoxes 안의 몫) · 복사 길을 묻지 않아 껐다
    unsavedBoxes: Math.min(count(v.unsavedBoxes), count(v.skippedBoxes)), copyAsk: v.copyAsk === true
  };
}

/**
 * { id: 값 } 을 다듬는다 — 계정 열쇠만, 50개까지. ids 를 주면 그 계정만 남긴다 (지운 계정이 되살아나지 않게)
 */
function accMap(v, val, ids = null) {
  const out = {};
  if (!isObj(v)) return out;
  const keep = ids ? new Set(ids) : null;
  for (const [k, x] of Object.entries(v)) {
    if (Object.keys(out).length >= MAX_ACCOUNTS) break;
    if (!goodId(k) || (keep && !keep.has(k))) continue;
    const y = val(x);
    if (y !== undefined) out[k] = y;
  }
  return out;
}

const normMap = (v, ids) => accMap(v, normEntry, ids);
const normResults = (v, ids) => accMap(v, normResult, ids);

/** 그 계정의 설정 — 항목이 없으면 꺼짐·30일 */
function entryOf(map, id) {
  if (!isObj(map) || !goodId(id) || !own(map, id)) return { ...OFF };
  return normEntry(map[id]) || { ...OFF };
}

const anyOn = (map) => Object.values(normMap(map)).some((x) => x.on);

/** 모두 끈다 — 기간은 남긴다 (다시 켤 때 고르던 값) */
function allOff(map) {
  const out = {};
  for (const [k, x] of Object.entries(normMap(map))) out[k] = { on: false, days: x.days };
  return out;
}

/** 견줄 수 있게 — 포트는 숫자, 나머지는 공백 없는 소문자 */
function pathOf(a) {
  const x = isObj(a) ? a : {};
  return PATH_KEYS.map((k) => (k === 'port' ? Number(x[k]) || 0 : String(x[k] == null ? '' : x[k]).trim().toLowerCase()));
}

const samePath = (a, b) => pathOf(a).every((v, i) => v === pathOf(b)[i]);

/**
 * 계정을 고친 뒤 — 켜진 정리를 둘지. 서버·아이디·폴더가 바뀌거나 계정을 끄면 끈다 (다시 켤 때 다시 묻는다).
 * 이름이나 비밀번호만 바꾸면 그대로 둔다.
 * @returns { entry, why } — why 는 기록에 남길 말 (바뀌지 않았으면 null)
 */
function afterUpdate(entry, before, after) {
  const e = normEntry(entry) || { ...OFF };
  if (!e.on) return { entry: e, why: null };
  if (!samePath(before, after)) {
    return { entry: { on: false, days: e.days }, why: '서버 정리에서 뺌 — 계정의 서버·아이디를 바꿔서 (다시 켜려면 다시 확인합니다)' };
  }
  if ((!isObj(before) || before.enabled !== false) && isObj(after) && after.enabled === false) {
    return { entry: { on: false, days: e.days }, why: '서버 정리 꺼짐 — 계정을 꺼서 (다시 켜려면 다시 확인합니다)' };
  }
  return { entry: e, why: null };
}

/**
 * 옛 설정(모든 계정 하나의 스위치)을 계정마다로 옮긴다. 이미 계정마다면 null.
 * 옛 스위치가 켜져 있고 정리가 실제로 돌 수 있었으면(메일 확인·자동 백업·폴더) 그때 있던 켜진 계정을 모두 같은 기간으로 켠다 —
 * 지금 도는 범위와 같아 새로 옮기는 메일이 없다 — MOVE 있는 서버에서는. 옛 확인 창은 MOVE 없는 서버를 «옮기지 않음»으로 셌고
 * 엔진도 거절했는데, 이제는 복사한 뒤 지워 옮긴다. 그 방식은 묻지 않았으므로 켠 항목에 copyAsk 를 단다 — 정리가 연결해 MOVE 가
 * 없으면 옮기기 전에 끄고 다시 켤 때 묻는다 (backup.js runTidy). 아니면 모두 끈다. 기록할 말은 옛 스위치가 켜져 있었을 때만
 * @returns { map, note } | null
 */
function migrate(rawSettings, mailAccounts) {
  const rs = isObj(rawSettings) ? rawSettings : {};
  if (isObj(rs.mailTidyAccounts)) return null;
  const ready = rs.mailEnabled === true && rs.mailAutoBackup === true
    && typeof rs.mailBackupDir === 'string' && !!rs.mailBackupDir;
  const on = rs.mailServerTidy === true && ready;
  const days = normDays(rs.mailTidyDays);
  const map = {};
  for (const a of Array.isArray(mailAccounts) ? mailAccounts : []) {
    if (!isObj(a) || !goodId(a.id) || own(map, a.id) || Object.keys(map).length >= MAX_ACCOUNTS) continue;
    const yes = on && a.enabled !== false;
    map[a.id] = yes ? { on: true, days, copyAsk: true } : { on: false, days };
  }
  const n = Object.values(map).filter((x) => x.on).length;
  const note = rs.mailServerTidy === true
    ? `서버 정리 설정을 계정마다로 옮김 · 켜짐 ${n}개 · ${days === 0 ? '바로' : `${days}일`}${on ? (n ? ' · MOVE 없는 서버는 옮기기 전에 다시 묻습니다' : '') : ' (조건이 모자라 모두 꺼 둠)'}`
    : null;
  return { map, note };
}

/** 다음 정리까지 — «바로»는 늘 짧게, 상한·시간으로 남았으면 중간, 아니면 길게 */
function gapMs(days, more, T) {
  return days === 0 ? T.QUICK_GAP_MS : more ? T.MORE_GAP_MS : T.GAP_MS;
}

/**
 * 때가 된 계정을 오래 기다린 차례로 — 상한에 밀린 계정이 다음 실행에서 먼저 돈다. 같으면 설정 순서
 * @param nextAtOf (acc) → 그 계정의 다음 정리 시각(ms)
 */
function dueOrder(accs, nextAtOf, now) {
  return (Array.isArray(accs) ? accs : [])
    .map((a, i) => ({ a, i, at: Number(nextAtOf(a)) || 0 }))
    .filter((x) => now >= x.at)
    .sort((x, y) => x.at - y.at || x.i - y.i)
    .map((x) => x.a);
}

/**
 * 한 번 실행의 상한(모든 계정 합)에서 이 계정에 줄 몫 — 남은 양을 남은 계정 수로 (올림).
 * 빨리 끝난 계정이 남긴 몫은 뒤 계정이 쓴다. 합은 남은 양을 넘지 않는다
 */
function capShare(left, accountsLeft) {
  const l = Math.max(0, Math.floor(Number(left) || 0));
  const n = Math.max(1, Math.floor(Number(accountsLeft) || 1));
  return Math.min(l, Math.ceil(l / n));
}

module.exports = {
  TIDY_DAYS, PATH_KEYS, goodId, normDays, normEntry, normResult, normMap, normResults, entryOf, anyOn, allOff,
  pathOf, samePath, afterUpdate, migrate, gapMs, dueOrder, capShare
};

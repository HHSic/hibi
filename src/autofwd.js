'use strict';
// 자동 전달 — 언제 돌릴지·확인 창·상태만 맡는다. 무엇을 어떻게 보낼지는 src/mailfwd.js 가 한다.
// 메일이 밖으로 나가는 설정이다 — 자동 전달은 메일을 몰래 빼내는 흔한 수법이라 켜기·주소 더하기·계정 더하기는
// 메인이 정확한 주소와 계정을 보여 주고 묻는다. 일반 설정 길은 이 값을 아예 못 바꾼다 (store.setSettings 가 버린다).
// 물은 뒤에는 계정마다 지문(이 PC·그 계정의 서버·주소·받는 주소)을 적는다 — 지문이 안 맞는 계정은 보내지 않는다.
// 다른 PC에서 복사해 온 설정이나 확인 뒤에 서버를 바꾼 계정이 묻지 않고 메일을 내보내지 않게.
const os = require('os');
const { app, ipcMain, BrowserWindow } = require('electron');
const store = require('./store');
const evlog = require('./evlog');
const mail = require('./mail');
const send = require('./send');
const mailfwd = require('./mailfwd');
const mailtidy = require('./mailtidy');   // maskAddr · labelOf
const popup = require('./popup');         // 이름 공간으로 — 시험이 popup.askUser 를 바꿔 끼운다

let host = {
  mailAccountsForUse: () => [],
  isSettingsWin: () => false,
  stateDir: () => app.getPath('userData'),
  // 이 PC·이 사용자 — 지문의 재료. 시험이 바꿔 끼운다 (다른 PC에서 온 설정 흉내)
  machine: () => {
    let u = '';
    try { u = os.userInfo().username; } catch { /* 없으면 PC 이름만 */ }
    return `${os.hostname()}\n${u}`.toLowerCase();
  }
};
// 시간표. 시험이 init({ fwdTiming })으로 줄여 쓴다
const T = {
  GAP_MS: 60_000,        // 폴링 한 번에 한 번만 — 폴링이 잦아도 이보다 자주 돌지 않는다
  MORE_MS: 60_000,       // 남은 것이 있으면 다음 폴링(몇십 분일 수 있다)을 기다리지 않고 이만큼 뒤 이어서
  MAX_MS: 10 * 60_000,   // 한 번 도는 시간 상한 — 넘으면 연결을 끊어 강제로 끝낸다
  AGAIN_MS: 5_000        // 도는 사이에 켜기·바꾸기가 확인됐으면 끝난 뒤 이만큼 뒤 다시
};
// 지금 상태와 이번 앱 실행의 마지막 결과
const fwd = {
  running: false, asking: false, again: false, abort: null,
  at: 0, sent: 0, skipped: 0, uncertain: 0, more: false, capped: false, error: null, total: 0,
  message: '', messageKind: ''
};
let lastRunAt = 0;
let logSig = '';   // 마지막으로 기록에 적은 줄 — 보낸 것 없이 같은 줄을 폴링마다 쌓지 않게

function init(h) {
  host = { ...host, ...h };
  if (h && h.fwdTiming) Object.assign(T, h.fwdTiming);
}

const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 설정을 매번 다시 다듬어 읽는다 — 손으로 고친 파일·옛 버전의 값을 그대로 믿지 않는다 */
function fwdConf() {
  const s = store.settings;
  const to = [...new Set((Array.isArray(s.mailForwardTo) ? s.mailForwardTo : []).map(store.normFwdAddr).filter(Boolean))];
  const ids = [...new Set((Array.isArray(s.mailForwardAccounts) ? s.mailForwardAccounts : []).filter((x) => typeof x === 'string'))];
  return {
    on: s.mailForwardOn === true, to, ids,
    since: isObj(s.mailForwardSince) ? s.mailForwardSince : {},
    fp: isObj(s.mailForwardFp) ? s.mailForwardFp : {}
  };
}

const accOf = (id) => store.mailAccounts.find((a) => a.id === id) || null;
/** 계정의 이름 — 확인 창·답에 쓴다 */
const nameOf = (a) => String((a && (a.name || a.user)) || '').slice(0, 30);

/** 그 계정의 주소들 — 보내는 주소와 아이디(주소꼴일 때) */
function ownAddrs(acc) {
  return [...new Set([mail.fromOf(acc).address, acc && acc.user].map(low).filter((x) => x.includes('@')))];
}

/** 받는 주소가 그 계정 자신인가 — 자기에게 보내는 고리가 된다 */
function isSelf(acc, to) {
  return !!acc && ownAddrs(acc).some((a) => (to || []).includes(a));
}

/** 이 PC에서 확인 창을 지난 그대로인가 — 계정 설정·받는 주소·PC 가 같아야 한다 */
function fpOk(id, c) {
  const a = accOf(id);
  return !!a && typeof c.fp[id] === 'string' && c.fp[id] === mailfwd.fpOf(a, c.to, host.machine());
}

/** 이 PC에서 확인한 그대로인 계정 */
function liveIds(c) {
  return c.ids.filter((id) => fpOk(id, c));
}

/**
 * 쓸 수 없는 까닭 한 줄 (쓸 수 있으면 ''). 상태는 몇 초마다 읽으므로 여기서는 비밀번호를 풀지 않는다 —
 * 꺼 둔 계정뿐인지만 본다. 비밀번호가 풀리는지는 켜기·더하기 때 setForward 가 본다
 */
function fwdWhy() {
  if (store.settings.mailEnabled !== true) return '«메일 확인하기»를 켜야 쓸 수 있습니다.';
  if (!store.mailAccounts.length) return '메일 계정을 먼저 더하세요.';
  if (!store.mailAccounts.some((a) => a.enabled !== false)) return '켜 둔 메일 계정이 없습니다.';
  return '';
}

/** 실제로 보낼 수 있게 켜져 있나 — 켜짐·메일 확인·받는 주소·이 PC에서 확인한 계정 */
function fwdOn(c = fwdConf()) {
  return !!(c.on && store.settings.mailEnabled === true && c.to.length && liveIds(c).length);
}

/** 트레이가 본다 — 켜져 있으면 «메일 자동 전달 켜짐» 줄을 늘 보인다 */
function isOn() {
  return fwdOn();
}

/** 서버 정리(backup.js runTidy)가 본다 — 도는 동안 정리는 시작하지 않는다 */
function busy() {
  return fwd.running;
}

/** 도는 중 이것이 바뀌면 다음 보내기 전에 멈춘다 — 끄기·주소 바꾸기·계정 빼기·메일 확인 끄기 */
function sig() {
  const c = fwdConf();
  return JSON.stringify([c.on, c.to, c.ids, c.since, c.fp, store.settings.mailEnabled === true]);
}

/**
 * 설정 화면이 보는 상태 (고정 계약 FwdStatus). 이번 실행에서 아직 안 돌았으면 저장해 둔 마지막 결과를 쓴다.
 * @param full 설정 창의 요청이면 주소·계정까지. 다른 창에는 키는 같고 값만 비운다
 */
function fwdStatus({ full = false } = {}) {
  const s = store.settings;
  const c = fwdConf();
  const why = fwdWhy();
  const live = liveIds(c);
  const saved = isObj(s.mailForwardLast) ? s.mailForwardLast : {};
  const last = fwd.at ? fwd : saved;
  const num = (x) => Number(x) || 0;
  const out = {
    on: c.on,
    to: c.to,
    accounts: store.mailAccounts.map((a) => ({
      id: String(a.id),
      name: String(a.name || a.user || '').slice(0, 40),
      addr: low(mail.fromOf(a).address),
      on: c.on ? live.includes(a.id) : c.ids.includes(a.id),
      self: isSelf(a, c.to),
      enabled: a.enabled !== false,
      changed: !c.ids.includes(a.id) && !!c.fp[a.id],
      // 그 계정의 주소들(보내는 주소·주소꼴 아이디) — 꺼진 채 화면이 «받는 주소와 같은 계정»을 메인(isSelf)과 같게 가린다
      addrs: ownAddrs(a)
    })),
    ready: !why,
    why,
    stale: !!(c.on && c.to.length && c.ids.length && !live.length),
    running: fwd.running,
    asking: fwd.asking,
    at: num(last.at),
    sent: num(last.sent),
    skipped: num(last.skipped),
    uncertain: num(last.uncertain),
    more: last.more === true,
    capped: last.capped === true,
    error: typeof last.error === 'string' && last.error ? last.error : null,
    total: num(last.total),
    max: store.FWD_MAX_TO,
    message: fwd.message,
    messageKind: fwd.messageKind
  };
  if (!full) {
    // 다른 창(메일 보기 창은 남이 쓴 본문을 그린다)에는 주소·계정·결과를 주지 않는다 — 켜짐·준비·까닭만
    Object.assign(out, {
      to: [], accounts: [], at: 0, sent: 0, skipped: 0, uncertain: 0, total: 0,
      more: false, capped: false, asking: false, error: null, message: '', messageKind: ''
    });
  }
  return out;
}

/** 확인 창의 글 — 정확한 받는 주소와 계정 이름, 새로 더한 것은 따로 */
function fwdQuestion({ to, addedTo = [], names, addedNames = [], change }) {
  // 새로 더한 계정은 «외 n개»로 줄이지 않는다 — 확인 창이 이 기능의 유일한 사람 확인 자리다
  const old = names.filter((n) => !addedNames.includes(n));
  const oldShort = old.length > 4 ? [...old.slice(0, 4), `외 ${old.length - 4}개`] : old;
  const who = [...addedNames, ...oldShort].join(' · ');
  let message;
  if (!change) message = `새 메일을 ${to.join(', ')} 으로 전달할까요?`;
  else if (addedTo.length && addedNames.length) message = `${addedTo.join(', ')} 으로도, ${addedNames.join(' · ')} 계정 메일도 전달할까요?`;
  else if (addedTo.length) message = `새 메일을 ${addedTo.join(', ')} 으로도 전달할까요?`;
  else message = `${addedNames.join(' · ')} 계정 메일도 전달할까요?`;
  return {
    title: change ? '자동 전달 바꾸기' : '자동 전달 켜기',
    message,
    detail: [change ? `${who} 계정 → ${to.join(', ')}` : `${who} 계정`, '회사 메일이 회사 밖으로 나갑니다.'].join('\n'),
    buttons: [change ? '바꾸기' : '전달 켜기', '그만두기'],
    // 단추 색은 위험(빨강)으로 두되 초점은 «그만두기»에 — 다른 데 치던 Enter 로 켜지지 않게.
    // 뜬 직후의 마우스 클릭도 받지 않는다 — 스위치를 두 번 누른 두 번째 클릭이 막 뜬 빨간 단추에 떨어지지 않게
    defaultId: 0, danger: true, focusId: 1, armMs: 800
  };
}

/**
 * 자동 전달 켜기·끄기·받는 주소·계정 — 메인 쪽 확인 문.
 * 켜기·주소 더하기·계정 더하기(지문이 안 맞던 계정 포함)는 묻는다. 끄기·빼기는 묻지 않는다.
 * 끄기는 어느 창에서 와도 받는다. 그 밖은 설정 창의 본 문서에서 온 것만.
 * 꺼진 채로는 주소·계정을 저장하지 않는다 — 켜는 요청에 실려 와 확인 창을 지난 것만 저장한다.
 * @returns FwdStatus — 확인 창이 닫히고 asking 이 내려간 뒤에 돌아온다
 */
async function setForward(req, parent, { fromSettings = false } = {}) {
  // 답은 요청마다 새로 쓴다 — 지난 요청의 말이 남아 엉뚱한 때 다시 보이지 않게
  fwd.message = '';
  fwd.messageKind = '';
  // 답 — 설정 창(본 문서)이 아니면 키는 같고 값은 비운 상태다 (답 글도). 답 글은 fwd 에 남아 설정 창이 다음에 읽는다
  const reply = () => fwdStatus({ full: fromSettings });
  const say = (kind, text) => {
    fwd.messageKind = kind;
    fwd.message = text;
    return reply();
  };
  const q = req && typeof req === 'object' ? req : {};
  const cur = fwdConf();

  // 끄기 — 묻지 않는다. 도는 실행은 sig 가 바뀌어 다음 보내기 전에 멈춘다
  if (q.on === false) {
    if (!cur.on) return reply();
    store.setForwardSettings({ mailForwardOn: false, mailForwardFp: {} });
    evlog.log('메일', '자동 전달 끔');
    return say('good', '껐습니다.');
  }
  // preload 는 모든 창에 같다 — 남이 쓴 본문을 그리는 메일 보기 창도 mail:fwd-set 을 부를 수 있다
  if (!fromSettings || !parent) return say('bad', '자동 전달은 설정 창에서만 바꿀 수 있습니다.');
  const turningOn = q.on === true && !cur.on;
  if (!cur.on && !turningOn) return say('bad', '꺼진 채로는 저장하지 않습니다.');

  // 받는 주소 — 전체 목록으로 온다. 하나라도 못 쓰면 아무것도 바꾸지 않는다
  let to = cur.to;
  if (q.to !== undefined) {
    const parts = [].concat(q.to).map((x) => String(x == null ? '' : x)).join(',').split(/[,;\s]+/).filter(Boolean);
    const list = [];
    for (const x of parts) {
      const n = store.normFwdAddr(x);
      if (!n) return say('bad', `주소 형식이 이상합니다 — ${x.slice(0, 60)}`);
      if (!list.includes(n)) list.push(n);
    }
    if (list.length > store.FWD_MAX_TO) return say('bad', `받는 주소는 ${store.FWD_MAX_TO}개까지입니다.`);
    to = list;
  }

  // 계정 — 전체 목록으로 온다
  const all = store.mailAccounts;
  let picked = null;
  if (q.accounts !== undefined) {
    if (!Array.isArray(q.accounts) || q.accounts.some((id) => typeof id !== 'string' || !accOf(id))) {
      return say('bad', '없는 계정이 섞여 있습니다.');
    }
    picked = new Set(q.accounts);
  }

  if (!to.length) {
    if (cur.on) {
      store.setForwardSettings({ mailForwardOn: false, mailForwardTo: [], mailForwardFp: {} });
      evlog.log('메일', '자동 전달 끔 · 받는 주소 없음');
      return say('good', '받는 주소가 없어 껐습니다.');
    }
    return say('bad', '받는 주소를 넣어주세요.');
  }

  // 보낼 계정 — store 순서로. 받는 주소와 같은 계정은 고를 수 없다 (자기에게 보내는 고리)
  let accounts;
  if (picked) {
    const self = all.find((a) => picked.has(a.id) && isSelf(a, to));
    if (self) return say('bad', `${nameOf(self)} 계정은 받는 주소와 같아 고를 수 없습니다.`);
    accounts = all.filter((a) => picked.has(a.id)).map((a) => a.id);
  } else if (turningOn) {
    // 지난번에 고른 계정이 남아 있으면 그것, 없으면 켜 둔 계정 전부 (꺼 둔 계정은 빼고)
    const kept = all.filter((a) => cur.ids.includes(a.id) && a.enabled !== false && !isSelf(a, to)).map((a) => a.id);
    accounts = kept.length ? kept : all.filter((a) => a.enabled !== false && !isSelf(a, to)).map((a) => a.id);
  } else {
    accounts = all.filter((a) => cur.ids.includes(a.id) && !isSelf(a, to)).map((a) => a.id);
  }
  if (!accounts.length) {
    if (cur.on) {
      store.setForwardSettings({ mailForwardOn: false, mailForwardAccounts: [], mailForwardSince: {}, mailForwardFp: {} });
      evlog.log('메일', '자동 전달 끔 · 계정 없음');
      return say('good', '전달할 계정이 없어 껐습니다.');
    }
    return say('bad', '전달할 계정을 골라주세요.');
  }

  const why = fwdWhy();
  if (why) return say('bad', why);
  for (const id of accounts) {
    const a = accOf(id);
    const problem = send.problemWith(a, { to: to.join(', ') });
    if (problem) return say('bad', `${nameOf(a)}: ${mailtidy.maskAddr(problem)}`);
  }

  // 새로 늘어난 것 — 지문이 안 맞던 계정(복사된 설정·서버를 바꾼 계정)도 «새로»다
  const live = liveIds(cur);
  const addedTo = turningOn ? to : to.filter((x) => !cur.to.includes(x));
  const addedIds = turningOn ? accounts : accounts.filter((id) => !live.includes(id));

  if (!turningOn && !addedTo.length && !addedIds.length) {
    // 켜진 채 빼기만 — 확인을 넓히지 않으므로 묻지 않는다. 남은 계정의 지문은 새 받는 주소로 다시 적는다
    const same = to.length === cur.to.length && to.every((x, i) => x === cur.to[i])
      && accounts.length === cur.ids.length && accounts.every((x, i) => x === cur.ids[i]);
    if (same) return reply();
    const m = host.machine();
    const since = {};
    const fp = {};
    for (const id of accounts) {
      if (cur.since[id] != null) since[id] = cur.since[id];
      fp[id] = mailfwd.fpOf(accOf(id), to, m);
    }
    store.setForwardSettings({ mailForwardTo: to, mailForwardAccounts: accounts, mailForwardSince: since, mailForwardFp: fp });
    evlog.log('메일', `자동 전달 바꿈 · 받는 주소 ${to.length}개 · 계정 ${accounts.length}개`);
    return say('good', '바꿨습니다.');
  }

  // 새로 넣는 계정은 지금 쓸 수 있어야 한다 — 꺼 둔 계정·비밀번호를 못 푼 계정은 켜도 보내지 못한다
  // (확인 창까지 지나 «켰습니다» 뒤에야 «쓸 수 있는 계정이 없습니다»가 뜨지 않게). 묻기 전 한 번만 푼다
  let usable = [];
  try { usable = host.mailAccountsForUse() || []; } catch { usable = []; }
  const usableIds = new Set(usable.map((a) => a && a.id));
  const unusable = addedIds.map(accOf).find((a) => a && !usableIds.has(a.id));
  if (unusable) {
    return say('bad', unusable.enabled === false
      ? `${nameOf(unusable)} 계정은 꺼져 있어 고를 수 없습니다.`
      : `${nameOf(unusable)} 계정은 지금 쓸 수 없습니다 — 계정 설정을 확인하세요.`);
  }

  if (fwd.asking) return say('wait', '확인 창이 떠 있습니다 — 거기서 골라주세요.');
  const names = accounts.map((id) => nameOf(accOf(id)));
  const addedNames = addedIds.map((id) => nameOf(accOf(id)));
  // 묻기 전의 구성 — 묻는 사이에 계정 서버·주소나 전달 설정이 바뀌면 확인 창에 보인 것과 다른 구성에 «확인됨» 지문을 찍게 된다
  const m0 = host.machine();
  const before = sig();
  const fpBefore = accounts.map((id) => mailfwd.fpOf(accOf(id), to, m0));
  let r = null;
  fwd.asking = true;
  try {
    r = await popup.askUser(parent, fwdQuestion({ to, addedTo, names, addedNames, change: !turningOn }));
  } catch {
    r = null;
  } finally {
    fwd.asking = false;
  }
  if (r !== 0) return say('wait', '그만뒀습니다 — 바뀐 것 없습니다.');

  // 묻는 동안 바뀌었을 수 있다 — 저장 직전에 다시 본다
  const why2 = fwdWhy();
  if (why2) return say('bad', why2);
  // 묻는 사이에 껐다 — 끈 것이 이긴다
  if (!turningOn && store.settings.mailForwardOn !== true) return say('wait', '그사이 꺼져 바꾸지 않았습니다.');
  // 묻는 사이에 설정(빼기·끄기 등)이나 계정(서버·아이디·보내는 주소)이 바뀌었다 — 아무것도 저장하지 않는다.
  // 그 사이 들어온 «빼기»를 되살리거나, 바뀐 서버에 확인 창을 지난 지문을 찍지 않게
  const m = host.machine();
  if (sig() !== before || m !== m0
    || accounts.some((id, i) => !accOf(id) || mailfwd.fpOf(accOf(id), to, m) !== fpBefore[i])) {
    return say('wait', '그사이 설정이 바뀌어 바꾸지 않았습니다 — 다시 눌러주세요.');
  }
  const final = accounts.filter((id) => accOf(id));
  if (!final.length) return say('bad', '전달할 계정을 골라주세요.');

  const t = Date.now();
  const since = {};
  const fp = {};
  for (const id of final) {
    // 켤 때는 모두 «지금부터». 켜진 채 바꾸면 전부터 보내던 계정은 그대로, 새로 더한 계정만 «지금부터»
    since[id] = turningOn || !live.includes(id) || cur.since[id] == null ? t : cur.since[id];
    fp[id] = mailfwd.fpOf(accOf(id), to, m);
  }
  store.setForwardSettings({
    mailForwardOn: true, mailForwardTo: to, mailForwardAccounts: final, mailForwardSince: since, mailForwardFp: fp,
    ...(turningOn ? { mailForwardLast: null } : {})
  });
  if (turningOn) Object.assign(fwd, { at: 0, sent: 0, skipped: 0, uncertain: 0, total: 0, more: false, capped: false, error: null });
  // 주소는 적지 않는다 — 수만
  evlog.log('메일', `자동 전달 ${turningOn ? '켬' : '바꿈'} · 받는 주소 ${to.length}개 · 계정 ${final.length}개`);
  // 기준점을 지금 잡는다 — 다음 폴링까지 기다리면 그 사이 «지금부터»가 흐려진다
  kick();
  return say('good', turningOn ? '켰습니다 — 지금부터 오는 메일을 전달합니다.' : '바꿨습니다.');
}

const SKIP_NAMES = {
  mine: '전달한 메일', target: '받는 주소에서 온 메일', auto: '자동 답장', bounce: '반송', spam: '스팸',
  gone: '사라진 메일', dup: '이미 보낸 메일', strike: '3번 실패', crash: '읽다가 앱이 꺼진 메일', old: '켜기 전 메일'
};

/** 실행 기록 — 수와 가린 오류만. 제목·본문·주소는 적지 않는다 */
function logRun(r) {
  const why = Object.entries(r.skips || {}).filter(([, n]) => n > 0).map(([k, n]) => `${SKIP_NAMES[k] || k} ${n}`).join(', ');
  const line = mailtidy.maskAddr(`자동 전달 · ${r.sent}통 보냄`
    + (r.seeded ? ` · 계정 ${r.seeded}개 «지금부터» 표시` : '')
    + (r.skipped ? ` · 건너뜀 ${r.skipped}통 (${why})` : '')
    + (r.uncertain ? ` · 보냈는지 모르는 ${r.uncertain}통은 다시 안 보냄` : '')
    + (r.capped ? ` · 오늘 한도 ${r.capped}개 계정` : '')
    + (r.more ? ' · 나머지는 다음에' : '')
    + (r.errors.length ? ` · 실패 ${r.errors.join(' / ')}` : '')
    + (r.notes && r.notes.length ? ` · ${r.notes.join(' / ')}` : ''));
  // 보낸 것 없이 지난번과 같은 줄이면 다시 적지 않는다 — 폴링마다 같은 줄이 쌓이지 않게
  if (!r.sent && line === logSig) return;
  logSig = line;
  // 아무 일도 없던 실행(새 메일 없음)은 적지 않는다
  if (!(r.sent || r.seeded || r.skipped || r.uncertain || r.capped || r.more || r.errors.length || (r.notes && r.notes.length))) return;
  evlog.log('메일', line);
}

/** 결과를 상태에 두고 설정에도 남긴다 — 앱을 다시 켜도 설정 화면이 마지막 결과를 보여 준다 */
function finish(x) {
  const error = typeof x.error === 'string' && x.error ? mailtidy.maskAddr(x.error).slice(0, 200) : null;
  Object.assign(fwd, { at: Date.now(), ...x, error });
  store.setForwardSettings({
    mailForwardLast: {
      at: fwd.at, sent: fwd.sent, skipped: fwd.skipped, uncertain: fwd.uncertain,
      more: fwd.more, capped: fwd.capped, error: fwd.error, total: fwd.total
    }
  });
}

/** ms 뒤에 한 번 더 — 기다리지 않는다 */
function later(ms) {
  const t = setTimeout(() => { forwardNew({ now: true }).catch(() => {}); }, ms);
  if (t.unref) t.unref();
}

/** 곧바로 한 번 돌린다. 도는 중이면 끝난 뒤에 다시 */
function kick() {
  if (fwd.running) { fwd.again = true; return; }
  later(0);
}

/**
 * 폴링 끝(mailhub refreshMail)에 부른다 — 자동 백업·서버 정리보다 먼저. 이 함수는 던지지 않는다.
 * @param now 간격(GAP_MS)을 무시하고 돈다 — 켠 직후·이어 보내기
 */
async function forwardNew({ now = false } = {}) {
  try {
    if (fwd.running) return;
    const c = fwdConf();
    if (!fwdOn(c)) return;
    if (!now && Date.now() - lastRunAt < T.GAP_MS) return;   // 폴링 한 번에 한 번만
    lastRunAt = Date.now();
    const live = liveIds(c);
    let usable = [];
    try { usable = host.mailAccountsForUse() || []; } catch { usable = []; }
    const accounts = usable.filter((a) => a && live.includes(a.id) && !isSelf(a, c.to));
    const s = store.settings;
    const prevTotal = fwd.at ? fwd.total : Number((isObj(s.mailForwardLast) ? s.mailForwardLast : {}).total) || 0;
    if (!accounts.length) {
      // 아무것도 못 하는 것도 드러낸다 — 화면이 «켜짐 · 다음 메일 확인 때 시작»에 멈춰 있지 않게
      finish({ sent: 0, skipped: 0, uncertain: 0, more: false, capped: false, error: '지금 쓸 수 있는 전달 계정이 없습니다', total: prevTotal });
      return;
    }
    fwd.running = true;
    fwd.again = false;
    const ctl = new AbortController();
    fwd.abort = () => ctl.abort();
    const hard = setTimeout(() => ctl.abort(), T.MAX_MS);
    const start = sig();
    // 고른 계정 전부의 주소 — 그 주소에서 «자동 전달됨»으로 온 메일은 우리 것이거나 이미 직접 보내는 메일이다
    const own = c.ids.map(accOf).filter(Boolean).flatMap(ownAddrs);
    let r = null;
    try {
      r = await mailfwd.forwardAll(accounts, {
        dir: host.stateDir(), to: c.to, since: c.since, keep: c.ids, rules: store.mailRules, own,
        backupDir: s.mailBackupDir || null,
        backupOn: s.mailAutoBackup === true && !!s.mailBackupDir,
        // 계정마다 시간 몫을 나눈다 — 바깥 상한(hard)보다 조금 짧게 잡아, 몫을 다 쓴 계정은 «다음에 이어서»로 끝난다
        budgetMs: Math.round(T.MAX_MS * 0.9),
        signal: ctl.signal,
        shouldStop: () => !fwdOn() || sig() !== start
      });
      // 상태 줄의 «실패:» 는 진짜 실패(r.errors)만 — 시간 몫·«확인 안 됨» 같은 알림(r.notes)은 상태 줄의 숫자가 이미 말한다.
      // 알림을 앞세우면 다른 계정의 로그인 거절 같은 진짜 실패가 가려진다
      finish({
        sent: r.sent, skipped: r.skipped, uncertain: r.uncertain, more: r.more, capped: r.capped > 0,
        error: r.errors[0] || (r.reset ? '전달 기록이 깨져 지금부터 다시 셉니다' : null), total: prevTotal + r.sent
      });
      logRun(r);
    } catch (e) {
      finish({ sent: 0, skipped: 0, uncertain: 0, more: false, capped: false, error: mailtidy.maskAddr(mailfwd.imapText(e)), total: prevTotal });
      evlog.log('메일', `자동 전달 실패 · ${fwd.error}`);
    } finally {
      clearTimeout(hard);
      fwd.abort = null;
      fwd.running = false;
      if (fwd.again) {
        fwd.again = false;
        later(T.AGAIN_MS);
      } else if (r && r.more && !r.aborted && !r.halt) {
        // 남은 것은 다음 폴링(몇십 분일 수 있다)까지 기다리지 않고 이어서 — 계정·3번 실패로 멈춘 것은 폴링 때 다시 본다
        later(T.MORE_MS);
      }
    }
  } catch (e) {
    // 던지지 않는다 — 폴링(목록 읽기)을 막지 않게
    try { evlog.log('메일', `자동 전달 실패 · ${mailtidy.maskAddr(String((e && e.message) || e)).slice(0, 120)}`); } catch { /* 기록 실패 */ }
  }
}

/** 설정 창의 본 문서에서 왔나 — 그 안에 낀 틀(iframe)은 믿지 않는다 */
const mainFrameOf = (e) => {
  const f = e && e.senderFrame;
  const m = e && e.sender && e.sender.mainFrame;
  return !!f && !!m && f.processId === m.processId && f.routingId === m.routingId;
};

ipcMain.handle('mail:fwd-status', (e) => fwdStatus({ full: !!host.isSettingsWin(e.sender) }));
ipcMain.handle('mail:fwd-set', (e, req) => setForward(req, BrowserWindow.fromWebContents(e.sender),
  { fromSettings: !!host.isSettingsWin(e.sender) && mainFrameOf(e) }));

module.exports = { init, forwardNew, setForward, fwdStatus, fwdQuestion, busy, isOn };

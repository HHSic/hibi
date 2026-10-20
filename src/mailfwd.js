'use strict';
/**
 * 자동 전달 — 새로 온 메일을 정해 둔 주소로 보낸다 (받은편지함만, 켠 뒤 온 것만).
 *
 * 무엇을·어떻게 보낼지만 여기서 한다. 언제 돌릴지·확인 창·상태는 src/autofwd.js 가 맡는다.
 * 받는 쪽은 사용자의 다른 메일함(대개 Gmail)이고, 거기서 AI 가 읽는다 — 그래서 본문 맨 앞에
 * «누가·언제·무엇을» 줄을 두고 원문 전체를 글로도 싣는다.
 *
 * 따져 둔 것들:
 *  - 몇 번째 메일까지 보냈는지(lastUid)는 설정 파일이 아니라 userData 의 mail-forward.json 에 둔다.
 *    UIDVALIDITY·서버·아이디·폴더·«켠 시각»이 바뀌면 그 계정은 기준을 다시 잡는다 — 지난 메일을 한꺼번에 보내지 않는다.
 *  - 보내기 «전에» 무엇을 보내는지 적어 둔다(pending). 보낸 뒤 저장하기 전에 앱이 꺼져도 같은 메일을 두 번 보내지 않는다.
 *    같은 메일이 다른 UID 로 다시 들어온 것은 내용 열쇠(Message-ID·Date·From·Subject·크기)로 거른다.
 *  - 우리가 보낸 메일은 설치마다 다른 표시(tok)로 알아본다 — 받는 쪽이 되돌려 보내도 고리가 돌지 않게.
 *    남이 붙인 «X-Hibi-Forwarded: 1» 같은 가짜 표시로 메일을 숨길 수는 없다.
 *  - 서버 정리(src/mailtidy.js)가 먼저 옮긴 메일은 PC 백업 파일로 대신 보낸다. 정리가 옮겼다는 열쇠
 *    (tidy-moved.json)가 있을 때만 — 사용자가 지우거나 스팸으로 옮긴 메일은 보내지 않는다.
 *  - 받는 쪽 IMAP 은 늘 읽기 전용(EXAMINE)으로 연다. 읽음 표시도, 보낸편지함 넣기도 하지 않는다.
 *  - SMTP 오류는 «어느 단계에서» 났는지로 먼저 나눈다 — 계정 탓(로그인·보내는 주소·한도)은 그 메일을 버리지 않고
 *    다음에 다시 본다. 내용 탓(DATA 5xx)만 세 번 실패하면 건너뛴다. 원문을 끝까지 넘긴 뒤 답 없이 끊긴 것은
 *    서버가 받았을 수 있어 «확인 안 됨»으로 세고 다시 보내지 않는다.
 *  - 받은 시각(INTERNALDATE)이 «켠 때»보다 이른 메일은 UID 가 새것이어도 보내지 않는다 (옮겨 오거나 되찾은 옛 메일).
 *
 * Electron 을 쓰지 않는다 — 가짜 IMAP·가짜 SMTP 로 node 에서 바로 시험한다 (test/mailfwd.test.js).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 이름 공간으로 부른다 — 시험이 «해석하지 못하는 원문»을 흉내 낼 수 있게
const mailparser = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const mail = require('./mail');
const send = require('./send');
const mailbackup = require('./mailbackup');
const mailtidy = require('./mailtidy');
const mailrules = require('./mailrules');

const STATE_FILE = 'mail-forward.json';
const CAP = 30;                          // 계정 하나가 한 번에 보내는 최대 통수 — 나머지는 다음에
const SIZE_LIMIT = 20 * 1024 * 1024;     // 보내는 원문 상한
const BIG_LIMIT = 2 * SIZE_LIMIT;        // 이보다 큰 원문은 받지 않는다 — 머리만 받아 «원문이 커서» 한 줄로
const FETCH_BUDGET = 64 * 1024 * 1024;   // 한 계정이 한 번에 받아 두는 원문 합 (첫 통은 넘어도 받는다)
const FETCH_CHUNK = 5;
const SENT_MAX = 5000;
const STRIKES = 3;
const DAY_RCPT = 300;                    // 계정 하나가 하루에 보내는 받는 사람 수 — 발송 한도를 다 써 평소 메일까지 막히지 않게
const RESEED_BACK_MS = 3 * 86_400_000;   // «켠 때부터»를 찾아 거슬러 보는 한도
const ACCOUNT_MIN_MS = 2 * 60_000;
const TIMEOUT_MS = 90_000;
const SEND_HANG_MS = 120_000;           // 한 통을 보내는 데 이보다 오래 걸리면 끊는다 (send.js 의 시간 제한 60초 × 2 — 그쪽이 먼저 걸린다)
const DAY_MS = 86_400_000;
const DATE_CHUNK = 50;                   // «켠 뒤 첫 UID»를 찾을 때 받은 시각을 한 번에 받는 수
const TEXT_MAX = 1_000_000;              // 그래도 크면 본문 글을 이만큼에서 자른다
const OLD_SLACK_MS = 10 * 60_000;        // «켜기 전 메일» 판정의 여유 — 서버·PC 시계가 몇 분 어긋나도 켠 직후 메일을 버리지 않게
const FETCH_SHARE = 0.6;                 // 계정 시간 몫 중 원문 받기(1단계)에 쓰는 몫 — 나머지는 받은 것을 보내는 데 남긴다
const HEAD_NAMES = ['from', 'to', 'cc', 'date', 'subject', 'message-id', 'in-reply-to', 'references', 'content-type',
  'auto-submitted', 'x-autoreply', 'x-autorespond', 'x-autoreply-from', 'precedence', 'x-hibi-forwarded',
  'x-spam-flag', 'x-spam-status', 'x-ms-exchange-organization-scl'];
const SKIP_CODES = ['mine', 'target', 'auto', 'bounce', 'spam', 'gone', 'dup', 'strike', 'crash', 'old'];
const HALT = '전달 기록(mail-forward.json)을 저장하지 못해 멈췄습니다';

const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const latin1 = (v) => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v == null ? '' : v));
const asc = (a, b) => a - b;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const maxOf = (list) => list.reduce((m, x) => (x > m ? x : m), 0);

/** 우리가 지어낸 오류 — 글이 이미 사람이 읽을 말이다 (imapText 가 그대로 쓴다) */
function own(message) {
  const e = new Error(message);
  e.own = true;
  return e;
}

// ── 지문·상태 ────────────────────────────────────────────

/** 확인 창을 지난 구성의 지문 — 이 PC·그 계정의 서버·아이디·폴더·보내는 서버·보내는 주소·받는 주소 */
function fpOf(acc, to, machine) {
  const smtp = mail.smtpOf(acc);
  return sha(JSON.stringify([String(machine || ''), low(acc.host), Number(acc.port) || 993, low(acc.user),
    String(acc.mailbox || 'INBOX'), low(smtp.host), smtp.port, low(mail.fromOf(acc).address), [...(to || [])].sort()])).slice(0, 32);
}

/** 상태 기록이 그 메일함의 것인가 — 서버·아이디·폴더가 바뀌면 다른 메일함이다 */
function whoOf(acc, boxPath) {
  return sha(JSON.stringify([low(acc.host), Number(acc.port) || 993, low(acc.user), String(boxPath)])).slice(0, 16);
}

function blankState() {
  return { v: 1, tok: crypto.randomBytes(8).toString('hex'), acc: {}, sent: [], day: { d: '', n: {} }, rr: '', pending: null };
}

/** 계정 기록 하나 — 모양이 틀리면 null (그 계정은 기준을 다시 잡는다) */
function normRec(r) {
  if (!isObj(r) || typeof r.box !== 'string' || typeof r.who !== 'string' || !mailtidy.goodV(r.uidValidity)) return null;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const floor = isObj(r.floor) ? { uid: n(r.floor.uid), at: n(r.floor.at) } : null;
  const strike = isObj(r.strike) ? { uid: n(r.strike.uid), n: n(r.strike.n) } : null;
  return { box: r.box, who: r.who, uidValidity: String(r.uidValidity), lastUid: n(r.lastUid), since: n(r.since),
    okAt: n(r.okAt), floor, strike };
}

/**
 * 전달 기록 읽기. 파일이 없으면 새 기록(fresh), 깨졌거나 모양이 틀리면 새 기록에 reset 을 붙인다 — 던지지 않는다.
 * reset 이면 모든 계정이 «지금부터» 다시 잡는다 (어디까지 보냈는지 모르니 지난 메일을 다시 보내지 않는 쪽으로).
 * 읽기 자체가 막힌 것(EBUSY·EPERM 등 — 백신·동기화 프로그램이 잠깐 잡고 있다)은 깨진 것이 아니다 — unreadable 을 붙여
 * 이번 실행만 쉬게 한다. reset 으로 덮어쓰면 lastUid·중복 열쇠가 사라져 지난 실행 뒤 온 메일이 영영 안 간다
 */
function loadState(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return Object.assign(blankState(), { fresh: true });
    return Object.assign(blankState(), { unreadable: true });
  }
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  if (!isObj(j) || typeof j.tok !== 'string' || !/^[0-9a-f]{16}$/.test(j.tok) || !isObj(j.acc)) {
    return Object.assign(blankState(), { fresh: true, reset: true });
  }
  const st = blankState();
  st.tok = j.tok;
  for (const [id, r] of Object.entries(j.acc)) {
    const rec = normRec(r);
    if (rec && id !== '__proto__') st.acc[id] = rec;
  }
  st.sent = (Array.isArray(j.sent) ? j.sent : []).filter((k) => typeof k === 'string').slice(-SENT_MAX);
  if (isObj(j.day) && typeof j.day.d === 'string') {
    st.day.d = j.day.d;
    for (const [id, n] of Object.entries(isObj(j.day.n) ? j.day.n : {})) {
      if (id !== '__proto__') st.day.n[id] = Number(n) || 0;
    }
  }
  st.rr = typeof j.rr === 'string' ? j.rr : '';
  const p = j.pending;
  if (isObj(p) && typeof p.acc === 'string' && (p.stage === 'read' || p.stage === 'send')) {
    st.pending = { acc: p.acc, uid: Number(p.uid) || 0, stage: p.stage, n: Number(p.n) || 0,
      k: typeof p.k === 'string' ? p.k : '', at: Number(p.at) || 0 };
  }
  return st;
}

/** 전달 기록 쓰기 — 임시 파일에 쓰고 바꿔치기한다. 막히면 직접 쓴다. 그것도 실패하면 던진다 */
async function saveState(dir, state) {
  const target = path.join(dir, STATE_FILE);
  const body = JSON.stringify({
    v: 1, tok: state.tok, acc: state.acc, sent: (state.sent || []).slice(-SENT_MAX),
    day: state.day, rr: state.rr || '', pending: state.pending || null
  });
  const tmp = target + '.tmp';
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, target);
  } catch {
    // 백신·동기화 프로그램이 원본을 잠깐 잡고 있으면 바꿔치기가 막힌다 — 직접 써 본다 (실패하면 던진다)
    await fs.promises.writeFile(target, body);
    try { await fs.promises.unlink(tmp); } catch { /* 남아도 읽지 않는다 */ }
  }
}

/**
 * 내용 열쇠 — 같은 메일이 다른 UID 로 다시 들어와도 한 번만 보낸다.
 * Message-ID 를 다시 쓰는 알림 메일도 Date·크기가 다르면 다른 열쇠다. 정리 뒤 휴지통에서 되찾은 같은 바이트는 같은 열쇠다.
 * @param sh mailtidy.headerFields(원문, { whole: true }) — 서버 원문과 백업 파일을 같은 함수로 읽는다
 */
function keyOf(accId, sh, size) {
  const h = sh || {};
  return sha([accId, mailtidy.normId(h['message-id']), h.date || '', h.from || '', h.subject || '', Number(size) || 0]
    .join('\n')).slice(0, 24);
}

// ── 다듬기·건너뛰기 ──────────────────────────────────────

// 머리 블록·제목에 들어가는 값은 모두 여기를 지난다. 남이 쓴 이름·첨부 이름은 RFC 2047 로 줄바꿈을 숨겨 올 수 있다
// (mailparser 3.9.20 이 «Boss\r\n받은 계정: 회사»를 그대로 준다 — 실측). AI 가 가짜 «보낸 사람:»·«받은 계정:» 줄을 믿지 않게
// 줄바꿈·제어문자·방향 바꾸기·폭 없는 문자를 지우고 한 줄로 만든다
const one = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ');
function clean(v, max = 200) {
  return one(v).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function fwdSubject(s) {
  const x = clean(s, 480) || '(제목 없음)';
  return /^(fw|fwd):/i.test(x) ? x : `FW: ${x}`;
}

/** mailparser 머리글 값 하나를 소문자 글로 — 구조 있는 값({ value })·여러 번 나온 값(배열)도 첫 값으로 */
function headerValue(headers, name) {
  if (!(headers instanceof Map)) return '';
  let v = headers.get(name);
  if (Array.isArray(v)) v = v[0];
  if (isObj(v) && 'value' in v) v = v.value;
  if (v instanceof Date) v = v.toISOString();
  return low(v);
}

/** 주소 머리글의 사람들 — 그룹은 펼친다 */
function addrsOf(field) {
  const out = [];
  for (const f of [].concat(field || [])) {
    for (const v of [].concat((f && f.value) || [])) {
      for (const x of v && Array.isArray(v.group) ? v.group : [v]) {
        if (x) out.push(x);
      }
    }
  }
  return out;
}

/** 메일 식별자들 — Message-ID·In-Reply-To·References (한 칸에 여럿이 붙어 와도 하나씩) */
function idsOf(p) {
  const out = [];
  for (const v of [p.messageId, p.inReplyTo, ...[].concat(p.references || [])]) {
    for (const x of String(v == null ? '' : v).replace(/></g, '> <').split(/\s+/)) {
      const id = mailtidy.normId(x);
      if (id) out.push(id);
    }
  }
  return out;
}

/**
 * 보내지 않을 메일인가 — 위에서부터 처음 걸린 까닭 하나 ('' 이면 보낸다).
 * auto-generated·auto-notified(결재·ERP 알림)와 auto-forwarded 만 붙은 메일(회사 전달 규칙·공유 메일함)은 보낸다 —
 * 그 메일들이야말로 이 길이 아니면 AI 에게 가지 않는다.
 * @param own 고른 계정들의 주소 — 그 주소에서 «자동 전달됨»으로 온 메일은 우리 것이거나 이미 직접 보내는 메일이다
 */
function skipReason(parsed, { to = [], rules = [], tok = '', own: owned = [] } = {}) {
  const p = parsed || {};
  const H = p.headers instanceof Map ? p.headers : new Map();
  const hv = (n) => headerValue(H, n);
  const people = addrsOf(p.from);
  const froms = people.map((x) => low(x.address)).filter(Boolean);
  const toSet = new Set((to || []).map(low));
  const ownSet = new Set((owned || []).map(low));
  const autoSub = hv('auto-submitted');
  const t = low(tok);

  if ((t && hv('x-hibi-forwarded') === t)
    || (t && idsOf(p).some((id) => id.startsWith(`hibi-fwd.${t}.`)))
    || (froms.some((f) => ownSet.has(f)) && autoSub.startsWith('auto-forwarded'))) return 'mine';
  if (froms.some((f) => toSet.has(f))) return 'target';
  if (froms.some((f) => /^(mailer-daemon|postmaster)$/.test(f.split('@')[0]))
    || hv('content-type').startsWith('multipart/report')) return 'bounce';
  if (autoSub.startsWith('auto-replied')
    || ['x-autoreply', 'x-autorespond', 'x-autoreply-from'].some((n) => H.has(n))
    || hv('precedence') === 'auto_reply') return 'auto';
  const first = people[0] || {};
  const msg = { fromName: first.name || '', fromAddress: first.address || '', from: (p.from && p.from.text) || '', subject: p.subject || '' };
  if (hv('x-spam-flag') === 'yes' || hv('x-spam-status').startsWith('yes')
    || Number(hv('x-ms-exchange-organization-scl')) >= 5
    || (Array.isArray(rules) ? rules : []).filter((r) => r && r.on !== false && r.action === 'spam')
      .some((r) => mailrules.hits(r, msg))) return 'spam';
  return '';
}

// ── 전달 메일 만들기 ─────────────────────────────────────

/** «주소 (이름)» — 이름이 주소처럼 보이지 않게 @<>" 는 지운다 */
function people(field) {
  const out = [];
  for (const x of addrsOf(field)) {
    const addr = clean(x.address, 254).toLowerCase();
    const name = clean(x.name, 80).replace(/[@<>"]/g, '').trim();
    if (!addr && !name) continue;
    out.push(addr && name ? `${addr} (${name})` : addr || `(${name})`);
  }
  return out.join(', ').slice(0, 1000);
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const goodDate = (d) => (d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : 0);

/**
 * 머리 블록 — AI 가 «누가·누구에게·언제·무엇을·어느 계정으로»를 먼저 읽는다. 줄 수가 정해져 있다
 * (없는 칸은 줄째 뺀다). 값은 모두 clean 을 지나 한 줄이다.
 * @param names 본문 그림이 아닌 첨부의 이름들 (이미 다듬은 것)
 * @param note 한 줄 알림 — 빠진 첨부·원문이 커서·원문을 못 읽어서
 */
function headLines(parsed, ctx, names = [], note = '') {
  const p = parsed || {};
  const c = ctx || {};
  const lines = ['---------- 전달된 메일 ----------', `보낸 사람: ${people(p.from) || '(없음)'}`];
  const to = people(p.to);
  if (to) lines.push(`받는 사람: ${to}`);
  const cc = people(p.cc);
  if (cc) lines.push(`참조: ${cc}`);
  lines.push(`날짜: ${fmtDate(goodDate(p.date) || Number(c.at) || Date.now())}`);
  lines.push(`제목: ${clean(p.subject, 480) || '(제목 없음)'}`);
  lines.push(`받은 계정: ${clean(c.accountName, 40)}`);
  const list = (names || []).filter(Boolean);
  if (list.length) {
    lines.push(`첨부: ${list.slice(0, 10).join(' · ')}${list.length > 10 ? ` 외 ${list.length - 10}개` : ''}`);
  }
  if (note) lines.push(clean(note, 300));
  return lines;
}

/**
 * 원문 HTML 에서 세 가지만 걷어낸다 — 다시 싸면 MIME 이 UTF-8 인데 <meta charset=ks_c_5601-1987> 이 남으면
 * Outlook 등에서 한글이 깨진다. <base> 는 상대 링크를 엉뚱한 곳으로 돌린다 (mail.js buildViewHtml 도 걷어낸다)
 */
function stripHead(html) {
  return String(html || '')
    .replace(/<meta\b[^>]*charset[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-type[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 본문 그림인가 — cid 가 있고 원문 HTML 이 그 cid 를 가리킨다. 끝 경계를 둔다 — 없으면 HTML 이 cid:img10 만 가리켜도
 * cid 가 img1 인 첨부가 본문 그림이 되어 «첨부:» 줄에서 빠진다
 */
function inlineCid(a, html) {
  return !!a && !!a.cid && !!html && new RegExp(`cid:${escapeRe(a.cid)}(?=["'\\s)>]|$)`, 'i').test(html);
}

const attName = (a, i) => clean(mail.attachmentName(a, i), 100) || `첨부${i + 1}`;
const htmlOf = (p) => (typeof p.html === 'string' ? p.html : '');

// 태그 안의 속성 — 따옴표 안의 «>» 는 태그 끝이 아니다
const ATTRS = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';
// <body> 앞에 와도 되는 것 — 이것 말고 다른 태그나 글이 먼저 나오면 브라우저는 거기서 이미 본문을 연다
const HEAD_TAGS = new RegExp(`</?(?:html|head|meta|link|base|title|style|script|noscript|template)\\b${ATTRS}>`, 'gi');

/**
 * 머리 블록을 끼울 자리 — 진짜 <body> 여는 태그 바로 뒤. 못 찾으면 -1 (맨 앞에 둔다).
 * 원문이 «<!-- <body> -->»·«<title><body></title>» 를 앞에 두면 첫 «<body» 글자 뒤는 주석·제목 안이라 블록이 숨고,
 * 원문이 그린 가짜 «보낸 사람:» 만 보인다. 그래서 주석·글만 담는 요소(script·style·title …)·<!…> 를 같은 길이의
 * 빈칸으로 가린 뒤 찾는다. <body> 앞에 머리에 올 것이 아닌 태그·글이 있으면(예: 숨긴 <div> 안의 <body>) 그 자리도 믿지 않는다
 */
function bodyAt(html) {
  const blank = (m) => ' '.repeat(m.length);
  const s = String(html)
    // 주석 — <!--> · <!---> 처럼 바로 닫힌 것도. 안 닫혔으면 끝까지
    .replace(/<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g, blank)
    .replace(new RegExp(`<(script|style|title|textarea|xmp|iframe|noembed|noframes|noscript|template)\\b${ATTRS}>[\\s\\S]*?(?:</\\1\\s*>|$)`, 'gi'), blank)
    .replace(/<[!?][^>]*>/g, blank);
  const m = s.match(new RegExp(`<body(?=[\\s/>])${ATTRS}>`, 'i'));
  if (!m) return -1;
  if (s.slice(0, m.index).replace(HEAD_TAGS, '').trim()) return -1;
  return m.index + m[0].length;
}

/** 서식 본문 — 머리 블록을 진짜 <body> 바로 뒤(못 찾으면 맨 앞)에 끼운다. 나머지 HTML 은 그대로 둔다 */
function htmlBody(html, lines) {
  const block = '<div style="margin:0 0 12px;padding:0 0 8px;border-bottom:1px solid #ccc;font-family:sans-serif;'
    + `font-size:13px;line-height:1.5;color:#444">${lines.map(escapeHtml).join('<br>')}</div>`;
  const s = stripHead(html);
  const at = bodyAt(s);
  if (at < 0) return block + s;
  return s.slice(0, at) + block + s.slice(at);
}

/** 모든 전달 메일에 같은 머리글 — 보낸 사람은 그 계정, 우리 표시(tok), 회신 머리글은 두지 않는다 */
function baseMsg(parsed, ctx) {
  const from = (ctx && ctx.from) || { address: '' };
  const addr = String(from.address || '');
  return {
    from: from.name ? { name: clean(from.name, 80), address: addr } : addr,
    to: ctx.to,
    subject: fwdSubject((parsed || {}).subject),
    // 우리 메일을 알아볼 Message-ID — 받는 쪽이 머리글을 지우고 되돌려 보내도 이것으로 고리를 끊는다
    messageId: `<hibi-fwd.${ctx.tok}.${crypto.randomBytes(8).toString('hex')}@${addr.split('@')[1] || 'hibi.invalid'}>`,
    headers: { 'X-Hibi-Forwarded': ctx.tok, 'Auto-Submitted': 'auto-forwarded' },
    // 원문에 무엇이 섞여 와도 디스크·인터넷에서 읽지 않는다
    disableFileAccess: true,
    disableUrlAccess: true
  };
}

/**
 * 전달 메일 (MailComposer 에 넘길 값). replyTo·inReplyTo·references 는 두지 않는다 — 원문 대화에 끼지 않게.
 * @param drop 뺄 첨부 번호들 — 빠진 수를 머리 블록에 한 줄로 알린다 (본문 그림 포함)
 */
function buildForward(parsed, ctx, drop = new Set(), { textMax = Infinity, noHtml = false } = {}) {
  const p = parsed || {};
  const html = htmlOf(p);
  const atts = Array.isArray(p.attachments) ? p.attachments : [];
  const names = atts.map((a, i) => (inlineCid(a, html) ? '' : attName(a, i))).filter(Boolean);
  const note = drop.size
    ? `첨부 ${drop.size}개는 크기 때문에 빠짐 — 원본은 ${ctx.backupOn ? 'PC 백업에' : '받은 메일함에'}`
    : '';
  const lines = headLines(p, ctx, names, note);
  // 링크 주소도 그대로 둔다 (tidyText 는 쓰지 않는다) — AI 에게는 링크가 필요하다
  let body = String(p.text || '').replace(/\r\n?/g, '\n').trim() || mail.htmlToText(html) || '(본문 없음)';
  if (body.length > textMax) body = `${body.slice(0, textMax)}\n…(생략)`;
  return {
    ...baseMsg(p, ctx),
    text: `${lines.join('\n')}\n---------- 원문 ----------\n${body}`,
    html: noHtml || !html.trim() ? undefined : htmlBody(html, lines),
    attachments: atts.map((a, i) => ({ a, i })).filter(({ i }) => !drop.has(i)).map(({ a, i }) => (inlineCid(a, html)
      ? { filename: attName(a, i), content: a.content, contentType: a.contentType, cid: a.cid, contentDisposition: 'inline' }
      : { filename: attName(a, i), content: a.content, contentType: a.contentType, contentDisposition: 'attachment' }))
  };
}

/** 머리 블록만 있는 전달 메일 — 원문이 너무 커서 받지 않았을 때 */
function buildStub(parsed, ctx, note) {
  return { ...baseMsg(parsed, ctx), text: headLines(parsed, ctx, [], note).join('\n'), attachments: [] };
}

/** 원문을 해석하지 못했다 — 들어가면 원문을 그대로 original.eml 로 붙이고, 안 들어가면 머리 블록만 */
function buildRawFallback(raw, parsed, ctx, limit = SIZE_LIMIT) {
  const fits = Buffer.isBuffer(raw) && raw.length > 0 && raw.length * 1.37 + 64 * 1024 <= limit;
  const note = fits
    ? '원문을 읽지 못해 첨부(original.eml)로 보냅니다'
    : `원문을 읽지 못했고 커서 첨부하지 못했습니다 — 원본은 ${ctx.backupOn ? 'PC 백업에' : '받은 메일함에'}`;
  return {
    ...baseMsg(parsed, ctx),
    text: headLines(parsed, ctx, [], note).join('\n'),
    attachments: fits ? [{ filename: 'original.eml', content: raw, contentType: 'message/rfc822', contentDisposition: 'attachment' }] : []
  };
}

const compile = (msg) => new MailComposer(msg).compile().build();

/**
 * 크기에 맞춰 만든다. 어림으로 먼저 고르고 만드는 횟수를 줄인다 — 보통 한 번, 많아야 세 번.
 *  1) 큰 첨부부터 빼서 어림이 limit 의 95% 안에 들게   2) 그래도 넘으면 첨부를 모두 빼고
 *  3) 그래도 넘으면 서식 없이, 본문 글을 잘라서
 * @param lean 처음부터 첨부를 모두 뺀다 (서버가 한 번 더 크다고 거절했을 때)
 * @returns { raw, dropped, lean }
 */
async function fitToLimit(parsed, ctx, limit, { lean = false } = {}) {
  const p = parsed || {};
  const atts = Array.isArray(p.attachments) ? p.attachments : [];
  const est = (a) => Math.ceil((Number(a && a.size) || (a && a.content ? a.content.length : 0)) / 57) * 78 + 512;
  const all = new Set(atts.map((_, i) => i));
  const drop = new Set();
  if (lean) {
    for (const i of all) drop.add(i);
  } else {
    const m0 = buildForward(p, ctx);
    let total = (Buffer.byteLength(m0.text || '') + Buffer.byteLength(m0.html || '')) * 1.4 + 8192
      + atts.reduce((s, a) => s + est(a), 0);
    for (const i of [...all].sort((x, y) => est(atts[y]) - est(atts[x]))) {
      if (total <= limit * 0.95) break;
      drop.add(i);
      total -= est(atts[i]);
    }
  }
  let raw = await compile(buildForward(p, ctx, drop));
  if (raw.length <= limit) return { raw, dropped: drop.size, lean };
  if (drop.size < all.size) {
    raw = await compile(buildForward(p, ctx, all));
    if (raw.length <= limit) return { raw, dropped: all.size, lean };
  }
  raw = await compile(buildForward(p, ctx, all, { noHtml: true, textMax: TEXT_MAX }));
  return { raw, dropped: all.size, lean };
}

// ── 오류 나누기 ──────────────────────────────────────────

// nodemailer 는 오류에 «어느 단계에서» 났는지(err.command)를 붙인다 — CONN·EHLO·STARTTLS·AUTH …·MAIL FROM·RCPT TO·DATA.
// 응답 코드만 보면 MAIL FROM 의 553(보내는 주소 거절)·Gmail 의 550 5.4.5(하루 한도)·RCPT 의 552 5.2.2(메일함 가득)가
// «그 메일 탓»으로 떨어져, 3번 실패 규칙이 장애 동안 온 메일을 모두 버린다. 단계로 먼저 나눈다
const ACCOUNT_CODES = ['EAUTH', 'ENOAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EPROTOCOL',
  'EENVELOPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
const CONN_CODES = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
// 발송 한도 낱말 — 낱말 경계를 둔다. 경계 없이 rate·limit 을 찾으면 «corporate policy»·«generated»·«separate»·«unlimited»
// 같은 내용 거부 글이 «계정 탓»이 되어, 3번 실패 규칙도 타지 않고 그 메일과 뒤 메일이 영영 멈춘다.
// quota 만은 O365 «SubmissionQuotaExceededException» 처럼 낱말 안에 붙어 오므로 경계 없이 본다 (quotation 은 빼고)
const LIMIT_WORDS = /quota(?!tion)|\brate[- ]?limit|\b(?:sending|daily|hourly|message|recipient)s? (?:limit|quota)\b|\blimit (?:exceeded|reached)\b|\btoo many (?:messages|mails|emails|recipients|connections|requests|sessions|logins?)\b/i;
// 크기 거부 낱말 — 응답 코드(552·5.3.4)를 붙이지 않는 서버도 있다
const SIZE_WORDS = /\b(?:message|mail) (?:size|too (?:big|large))\b|\bsize limit\b|\btoo (?:big|large)\b/i;
const escOf = (e) => (String((e && e.response) || '').match(/\b[245]\.\d{1,3}\.\d{1,3}\b/) || [''])[0];
/** 발송 한도·받는 메일함 가득 — 계정 탓 (다음에 다시) */
function isLimit(e) {
  const esc = escOf(e);
  return esc === '5.4.5' || /^4\.7\./.test(esc) || esc === '5.2.2' || LIMIT_WORDS.test(String((e && e.response) || ''));
}

function smtpKind(e, signal) {
  if (signal && signal.aborted) return 'abort';
  const cmd = String((e && e.command) || '');
  const code = String((e && e.code) || '');
  const rc = Number(e && e.responseCode) || 0;
  const esc = escOf(e);
  const text = String((e && e.response) || '');
  if (code === 'EMESSAGE' && /larger than allowed/i.test(String(e.message))) return 'size';
  if ((cmd === 'DATA' || /^MAIL FROM/.test(cmd))
    && ((rc === 552 && esc !== '5.2.2') || esc === '5.3.4' || esc === '5.2.3' || SIZE_WORDS.test(text))) return 'size';
  if (isLimit(e)) return 'account';
  if (/^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL FROM|RCPT TO|RSET)/.test(cmd) || ACCOUNT_CODES.includes(code)
    || (rc >= 400 && rc < 500)) return 'account';
  if (cmd === 'DATA' && rc >= 500) return 'message';   // 내용 거부 — 그 메일 탓
  return 'account';                                    // 모르는 것은 «다시 해 본다» 쪽으로 (버리지 않는다)
}

/**
 * 원문을 서버에 끝까지 넘겼나 — nodemailer 는 DATA 의 마지막 «.» 까지 소켓에 쓰면 info({ tnx: 'message', outByteCount })
 * 를 남긴다 (smtp-connection _createSendStream). 그 뒤 250 없이 끊기거나 시간이 넘으면 오류는 연결 실패와 똑같이
 * command 'CONN' 으로 온다 — 이 표시로만 «넘기기 전 연결 실패»(다시 보내도 된다)와 «넘긴 뒤 끊김»(서버가 받았을 수 있다)을 가른다
 * @param mark { done } — 보낼 때마다 false 로 두고 본다 (연결 하나로 한 통씩 보낸다 — maxConnections 1)
 */
function wireLogger(mark) {
  const nop = () => {};
  return {
    trace: nop, debug: nop, warn: nop, error: nop, fatal: nop,
    // 남기는 글은 버린다 — 서버 응답·주소가 들어 있다
    info: (entry) => { if (entry && entry.tnx === 'message' && entry.outByteCount != null) mark.done = true; }
  };
}

/** 'larger than allowed N' 의 N, 없으면 지금 크기의 절반 */
function limitFrom(e, rawLen) {
  const m = String((e && e.message) || '').match(/larger than allowed (\d+)/i);
  return m ? Number(m[1]) : Math.floor(rawLen / 2);
}

/**
 * SMTP 오류를 한 줄로. 서버가 보낸 글은 싣지 않는다 — 고정 문장에 응답 코드만 붙인다.
 * 거절 응답에는 첨부 이름·바이러스 이름·제목 조각이 들어 있어, 그대로 두면 기록과 설정 파일에 남는다
 */
function smtpText(e, acc) {
  const cmd = String((e && e.command) || '');
  const code = String((e && e.code) || '');
  const rc = Number(e && e.responseCode) || 0;
  const esc = escOf(e);
  const text = String((e && e.response) || '');
  const tag = [rc || '', esc].filter(Boolean).join(' ');
  const paren = tag ? ` (${tag})` : '';
  let s;
  if (code === 'EAUTH' || rc === 535) s = '보내는 서버 로그인이 거절됐습니다 — 앱 비밀번호를 확인하세요';
  else if (smtpKind(e) === 'size') s = '메일이 너무 커서 보내는 서버가 거절했습니다';
  else if (esc === '5.4.5' || /^4\.7\./.test(esc) || LIMIT_WORDS.test(text)) s = `보내는 서버의 발송 한도에 걸렸습니다${paren}`;
  else if (esc === '5.2.2') s = `받는 메일함이 가득 찼습니다${paren}`;
  else if (/^MAIL FROM/.test(cmd)) s = `보내는 서버가 보내는 주소를 거절했습니다${paren}`;
  else if (/^RCPT TO/.test(cmd) || code === 'EENVELOPE') s = `받는 주소를 보내는 서버가 거절했습니다${paren}`;
  else if (code === 'ETLS' || /^STARTTLS/.test(cmd)) s = '보내는 서버와 안전하게 연결하지 못했습니다';
  else if (CONN_CODES.includes(code) || /^(CONN|EHLO|HELO|LHLO)/.test(cmd)) {
    let where = '';
    try { const m = mail.smtpOf(acc || {}); where = m.host ? ` (${m.host}:${m.port})` : ''; } catch { where = ''; }
    s = `보내는 서버에 연결하지 못했습니다${where}`;
  } else if (cmd === 'DATA' && rc >= 500) s = `보내는 서버가 이 메일을 거절했습니다${paren}`;
  else s = `보내지 못했습니다 (${code || rc || '알 수 없음'})`;
  return mailtidy.maskAddr(s);
}

/** IMAP 오류를 한 줄로 — 알려진 경우는 mail.friendly 의 말, 모르는 서버 글은 싣지 않는다 */
function imapText(e) {
  if (e && e.own) return String(e.message);
  const raw = String((e && e.message) || e).slice(0, 120);
  const f = mail.friendly(e);
  return f === raw ? `받는 서버 오류${e && e.code ? ` (${String(e.code).slice(0, 40)})` : ''}` : f;
}

// ── 실행 ────────────────────────────────────────────────

/** 로컬 날짜 YYYY-MM-DD — 하루 한도를 세는 칸 */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 백업 파일 이름의 YYYYMMDD_HHMM (로컬) — 받은 시각 */
function fileAt(file) {
  const m = path.basename(String(file || '')).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_/);
  if (!m) return 0;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 원문의 머리 부분만 (첫 빈 줄까지) — 해석하지 못한 원문에서 보낸 사람·제목이라도 건지려고 */
function headPart(buf) {
  const s = latin1(buf);
  const cut = s.search(/\r?\n\r?\n/);
  return Buffer.from(`${cut >= 0 ? s.slice(0, cut) : s.slice(0, 64 * 1024)}\r\n\r\n`, 'latin1');
}

const timeOf = (d) => (d instanceof Date ? d.getTime() : Number.isFinite(Date.parse(d)) ? Date.parse(d) : 0);

/**
 * 모든 계정의 새 메일을 전달한다. 계정 하나가 넘어져도 나머지는 한다.
 * @param accounts 비밀번호가 풀린 접속용 계정 (지문까지 맞는 것만 — autofwd 가 거른다)
 * @param opts.dir         상태 파일 폴더 (필수)
 * @param opts.to          받는 주소 [] (다듬은 소문자 1..5)
 * @param opts.since       { 계정 id: ms } — 상태의 since 와 다르면 그 계정은 다시 «지금부터»
 * @param opts.keep        계정 id 목록 — 이 밖의 계정 기록은 지운다 (없으면 안 지운다)
 * @param opts.rules       store.mailRules (on !== false && action === 'spam' 만 본다)
 * @param opts.own         고른 계정들의 주소 [] — «보내는 계정 + auto-forwarded»를 우리 것으로 본다
 * @param opts.backupDir   PC 백업 폴더 | null    opts.backupOn  «원본은 PC 백업에»/«받은 메일함에»
 * @param opts.cap = CAP   opts.sizeLimit = SIZE_LIMIT   opts.bigLimit = BIG_LIMIT   opts.fetchBudget = FETCH_BUDGET
 * @param opts.dayMax = DAY_RCPT   opts.reseedBackMs = RESEED_BACK_MS   opts.budgetMs = 0   opts.accountMinMs = ACCOUNT_MIN_MS
 * @param opts.shouldStop  () => bool — 보내기 직전마다 묻는다
 * @param opts.signal      AbortSignal — 열린 IMAP 연결과 SMTP 전송을 닫는다
 * @param opts.connect     (acc) => client  기본 (acc) => mail.connect(acc, { timeoutMs: TIMEOUT_MS })
 * @param opts.transport   (acc, { logger }) => { sendMail({ envelope, raw }), close() }
 *                         기본 (acc, { logger }) => send.transportFor(acc, { pool: true, logger }) — logger 는 wireLogger
 * @param opts.save        (dir, state) => void|Promise  기본 saveState — 시험이 «보낸 뒤 저장 전에 죽음»을 흉내 낸다
 * @param opts.now         () => ms  기본 Date.now
 * @param opts.sendHangMs  한 통 보내기를 끊는 시간  기본 SEND_HANG_MS (시험이 짧게 준다)
 * @param opts.into        결과를 채워 갈 객체
 * @returns { sent, skipped, uncertain, seeded, more, capped, accounts, failedAccounts, errors: string[], notes: string[],
 *            skips: { mine, target, auto, bounce, spam, gone, dup, strike, crash, old }, halt, aborted, reset }
 *   errors 는 실패(계정·3번 실패·기록 저장 등), notes 는 실패가 아닌 알림(시간 몫·확인 안 됨 — 상태 줄의 숫자가 이미 말한다)
 */
async function forwardAll(accounts, opts = {}) {
  const {
    dir, to = [], since = {}, keep = null, rules = [], own: owned = [],
    backupDir = null, backupOn = false,
    cap = CAP, sizeLimit = SIZE_LIMIT, bigLimit = BIG_LIMIT, fetchBudget = FETCH_BUDGET,
    dayMax = DAY_RCPT, reseedBackMs = RESEED_BACK_MS, budgetMs = 0, accountMinMs = ACCOUNT_MIN_MS,
    shouldStop = () => false,
    signal,
    // 부르는 순간에 이름 공간에서 찾는다 — 시험이 mail.connect·send.transportFor 를 바꿔 끼울 수 있게
    connect = (acc) => mail.connect(acc, { timeoutMs: TIMEOUT_MS }),
    transport = (acc, { logger } = {}) => send.transportFor(acc, { pool: true, logger }),
    save = saveState,
    now = Date.now,
    sendHangMs = SEND_HANG_MS,
    into
  } = opts;
  const res = Object.assign(into || {}, {
    sent: 0, skipped: 0, uncertain: 0, seeded: 0, more: false, capped: 0, accounts: 0, failedAccounts: 0,
    errors: [], notes: [], skips: Object.fromEntries(SKIP_CODES.map((k) => [k, 0])), halt: false, aborted: false, reset: false
  });
  const toList = [...new Set((to || []).map(low).filter(Boolean))];
  const ownList = [...new Set((owned || []).map(low).filter(Boolean))];
  const aborted = () => !!(signal && signal.aborted);
  const stopNow = () => {
    let s = false;
    try { s = !!shouldStop(); } catch { s = true; }
    return s || aborted() || res.halt;
  };
  const skip = (why) => {
    res.skipped += 1;
    res.skips[why] = (res.skips[why] || 0) + 1;
  };

  // 끊으라면 열린 연결(IMAP)과 전송(SMTP)을 닫는다. IMAP 은 걸린 명령이 바로 끝난다. SMTP pool 의 close() 는 쉬는 연결만
  // 닫는다 — 보내는 중인 연결은 그 한 통이 끝나거나 socketTimeout 까지 둔다 (그래서 abort 는 그만큼 늦게 끝날 수 있다)
  const open = new Set();
  const onAbort = () => {
    for (const c of open) { try { c.close(); } catch { /* 이미 닫혔다 */ } }
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const state = loadState(dir);
  if (state.reset) res.reset = true;
  const sentSet = new Set(state.sent);
  /** 저장한다. 못 쓰면 실행 전체를 멈춘다 — 기록 없이 보내면 같은 메일을 또 보낸다 */
  const saveOrHalt = async () => {
    try {
      await save(dir, state);
    } catch {
      res.halt = true;
      throw own(HALT);
    }
  };

  try {
    if (state.unreadable) {
      res.errors.push('전달 기록(mail-forward.json)을 읽지 못해 이번에는 쉽니다');
      return res;
    }
    let dirty = !!(state.fresh || state.reset);
    if (Array.isArray(keep)) {
      for (const id of Object.keys(state.acc)) if (!keep.includes(id)) { delete state.acc[id]; dirty = true; }
      for (const id of Object.keys(state.day.n)) if (!keep.includes(id)) { delete state.day.n[id]; dirty = true; }
    }
    const today = dayKey(now());
    if (state.day.d !== today) { state.day = { d: today, n: {} }; dirty = true; }

    // 지난 실행이 남긴 «하던 일» — 보내다가 꺼졌으면 보냈을 수 있다 (다시 보내지 않는다).
    // 읽다가 두 번 꺼진 메일은 건너뛴다 (그 메일을 다시 열면 또 꺼진다)
    const p = state.pending;
    if (p) {
      const rec = state.acc[p.acc];
      if (!rec) {
        state.pending = null;
        dirty = true;
      } else if (p.stage === 'send') {
        if (p.k && !sentSet.has(p.k)) { state.sent.push(p.k); sentSet.add(p.k); }
        rec.lastUid = Math.max(rec.lastUid, p.uid);
        rec.strike = null;
        res.uncertain += 1;
        res.notes.push('보내던 중 앱이 꺼져 1통은 다시 보내지 않았습니다');
        state.pending = null;
        dirty = true;
      } else if (p.stage === 'read' && p.n >= 2) {
        skip('crash');
        rec.lastUid = Math.max(rec.lastUid, p.uid);
        rec.strike = null;
        res.notes.push('읽다가 앱이 꺼지는 메일 1통을 건너뜀');
        state.pending = null;
        dirty = true;
      }
    }
    if (dirty) {
      try {
        await saveOrHalt();
      } catch (e) {
        res.errors.push(e.message);
        return res;
      }
    }

    // 지난 실행이 처음 본 계정의 다음부터 — 느린 첫 계정이 시간을 다 써 뒤 계정이 매번 굶지 않게
    const list = (accounts || []).filter((a) => a && a.id);
    const at = list.findIndex((a) => a.id === state.rr);
    const startAt = at >= 0 ? (at + 1) % (list.length || 1) : 0;
    const order = [...list.slice(startAt), ...list.slice(0, startAt)];
    if (order.length) state.rr = order[0].id;
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;

    /** 한 계정 — 1단계(IMAP, 읽기 전용)에서 새 메일의 원문을 모으고, 2단계에서 하나씩 보낸다 */
    const forwardAccount = async (acc, label, share) => {
      const id = acc.id;
      const boxPath = acc.mailbox || 'INBOX';
      let late = false;
      let client = null;
      let tx = null;
      // 이 계정의 시간 몫을 다 쓰면 IMAP 연결만 닫는다. 보내는 중인 SMTP 는 끊지 않는다 (끊으면 «보냈는지 모름»이 된다) —
      // 다음 보내기 전에 멈춘다
      const lateTimer = share > 0 ? setTimeout(() => {
        late = true;
        if (client) { try { client.close(); } catch { /* 이미 닫혔다 */ } }
      }, share) : null;
      const cut = () => aborted() || late;
      // 원문 받기(1단계)는 몫의 일부만 쓴다 — 느린 서버에서 받기만 하다 몫이 끝나 한 통도 못 보내는 일이 되풀이되지 않게
      const fetchUntil = share > 0 ? Date.now() + Math.floor(share * FETCH_SHARE) : 0;
      let rec = null;
      let cand = [];
      let accMore = false;
      let accCapped = false;
      let files = null;
      let bsame = false;
      let foundSet = new Set();
      let done = 0;   // 이번에 끝낸 메일 (보냄·건너뜀) — 몫이 끝났을 때 이어 보낼지 가른다
      const sources = new Map();
      const advance = async (uid) => {
        rec.lastUid = Math.max(rec.lastUid, uid);
        rec.strike = null;
        state.pending = null;
        done += 1;
        await saveOrHalt();
      };
      // 서버가 그 명령을 거절했다(tagged NO·BAD) — 연결은 살아 있다. 끊긴 것·시간 몫이 끝난 것은 여기 들지 않는다
      const refused = (e) => !!e && (e.responseStatus === 'NO' || e.responseStatus === 'BAD') && client.usable !== false && !cut();
      /**
       * 원문을 묶음으로 받는다. 망가진 메일 하나 때문에 서버가 묶음 FETCH 를 통째로 거절하면(O365 «Message cannot be fetched» 등)
       * 한 통씩 다시 받아 그 메일만 가린다 — 계정 전체가 매번 같은 묶음에서 멈추지 않게.
       * 한 통씩 받아도 거절된 메일은 원문 없이 남는다 — 2단계가 «원문을 받지 못함»으로 센다 (세 번이면 건너뛴다)
       */
      const fetchEach = async (uids, query, take, have = (u) => sources.has(u)) => {
        try {
          for await (const m of client.fetch(uids, query, { uid: true })) take(m);
        } catch (e) {
          if (!refused(e)) throw e;
          for (const u of uids) {
            if (have(u)) continue;
            try {
              for await (const m of client.fetch([u], query, { uid: true })) take(m);
            } catch (e2) {
              if (!refused(e2)) throw e2;
            }
          }
        }
      };
      try {
        // ── 1단계: IMAP, 읽기 전용 ──
        client = connect(acc);
        open.add(client);
        let failed = false;
        try {
          await client.connect();
          // EXAMINE — 읽음 표시가 바뀌지 않는다
          const box = await client.mailboxOpen(boxPath, { readOnly: true });
          const v = String(box && box.uidValidity);
          if (!mailtidy.goodV(v)) throw own('서버가 UIDVALIDITY를 주지 않아 전달하지 않았습니다');
          // 맨 위 UID — UIDNEXT 를 안 주는 서버는 직접 묻는다 (mailbackup backupAccount 와 같은 규칙)
          let top;
          if (Number.isFinite(box.uidNext)) {
            top = box.uidNext - 1;
          } else if (!box.exists) {
            top = 0;
          } else {
            const all = await client.search({ all: true }, { uid: true });
            if (!Array.isArray(all)) throw own('서버가 검색에 답하지 않았습니다');
            if (!all.length) throw own(`${boxPath}: 서버가 UID를 알려주지 않습니다`);
            top = maxOf(all.map(Number));
          }

          // 기준을 다시 잡을지 — 처음 보는 계정·켠 시각이 바뀜·서버나 폴더가 바뀜·UID 를 새로 매김
          const want = Number(since[id]) || 0;
          const who = whoOf(acc, boxPath);
          rec = state.acc[id] || null;
          if (!rec || rec.box !== boxPath || rec.who !== who || rec.since !== want || rec.uidValidity !== v) {
            // 거슬러 볼 시각 — «켠 때»부터 온 메일은 보낸다. 그때 서버에 못 붙었어도 그 사이 온 메일이 빠지지 않게.
            // 서버·폴더가 바뀌었거나 UID 를 새로 매겼으면(서버 이전·재구성) «지금부터» — 거슬러 보지 않는다. 그런 서버는
            // 받은 시각(INTERNALDATE)도 옮긴 때로 다시 매기는 일이 많아, 시각으로 고르면 몇 해 전 메일까지 «새 메일»로 나간다
            const renumbered = !!rec && rec.uidValidity !== v && rec.box === boxPath && rec.who === who;
            let base = 0;
            if (state.reset || renumbered) base = 0;
            else if (!rec || rec.since !== want) base = want;
            if (base && now() - base > reseedBackMs) base = 0;
            if (renumbered) {
              res.errors.push(mailtidy.maskAddr(`${label}: 서버가 메일 번호를 새로 매겨 지금부터 다시 셉니다 — 그 사이 온 메일은 빠졌을 수 있음`));
            }
            let lastUid = top;
            let floor = null;
            if (base) {
              const near = await client.search({ since: new Date(base - DAY_MS) }, { uid: true });
              if (!Array.isArray(near)) throw own('서버가 검색에 답하지 않았습니다');
              const pick = near.map(Number).filter((u) => u <= top).sort(asc);
              let first = 0;
              for (let k = 0; k < pick.length && !first; k += DATE_CHUNK) {
                const part = pick.slice(k, k + DATE_CHUNK);
                const dates = new Map();
                // 반복문 안에서는 다른 명령을 보내지 않는다 (imapflow 교착)
                for await (const m of client.fetch(part, { uid: true, internalDate: true }, { uid: true })) {
                  if (m && m.uid != null) dates.set(Number(m.uid), timeOf(m.internalDate));
                }
                first = part.find((u) => (dates.get(u) || 0) >= base) || 0;
              }
              lastUid = first ? first - 1 : top;
              // 받은편지함으로 옮겨 온 옛 메일은 UID 가 커도 받은 시각이 옛날이다 — floor 가 거른다
              floor = { uid: top, at: base };
            }
            rec = { box: boxPath, who, uidValidity: v, lastUid, since: want, okAt: now(), floor, strike: null };
            state.acc[id] = rec;
            if (state.pending && state.pending.acc === id) state.pending = null;
            await saveOrHalt();
            res.seeded += 1;
            // 거슬러 볼 것이 없으면 이번에는 표시만 — 지난 메일은 보내지 않는다
            if (!base) return;
          }

          // 새 UID — n:* 는 n 이 맨 위보다 크면 맨 위 한 통을 돌려준다. 꼭 거른다
          const found0 = await client.search({ uid: `${rec.lastUid + 1}:*` }, { uid: true });
          if (!Array.isArray(found0)) throw own('서버가 검색에 답하지 않았습니다');
          const found = found0.map(Number).filter((u) => u > rec.lastUid).sort(asc);
          foundSet = new Set(found);
          rec.okAt = now();

          // 정리가 옮겼을 수 있는 메일 — 서버에 없는 UID 중 PC 백업 파일이 있는 것 (같은 UIDVALIDITY 의 백업일 때만)
          let extra = [];
          if (backupDir) {
            let bs = {};
            try { bs = mailbackup.loadState(backupDir) || {}; } catch { bs = {}; }
            const brec = (bs[mailbackup.accountKey(acc)] || {})[boxPath];
            bsame = !!brec && String(brec.uidValidity) === v;
            if (bsame) {
              files = await mailbackup.uidFiles(
                mailbackup.boxDirFor(backupDir, acc, boxPath, mailbackup.genOf(bs, acc, boxPath)));
              if (files === null) {
                // 정리도 이 폴더를 건너뛴다 (mailtidy tidyBox) — 옮겨진 메일이 생기지 않는다
                res.errors.push(mailtidy.maskAddr(`${label}: PC 백업 폴더를 읽지 못해 정리로 옮겨진 메일은 보지 못함`));
              } else {
                extra = [...files.keys()].filter((u) => u > rec.lastUid && u <= top && !foundSet.has(u));
              }
            }
          }

          cand = [...found, ...extra].sort(asc);
          if (cand.length > cap) {
            cand = cand.slice(0, cap);
            accMore = true;
          }

          // 크기 먼저 — 아주 큰 원문은 받지 않는다
          const onServer = cand.filter((u) => foundSet.has(u));
          const sizes = new Map();
          if (onServer.length) {
            await fetchEach(onServer, { uid: true, size: true }, (m) => {
              if (m && m.uid != null) sizes.set(Number(m.uid), Number(m.size) || 0);
            }, (u) => sizes.has(u));
          }
          const wantSrc = onServer.filter((u) => sizes.has(u));
          let bytes = 0;
          for (let k = 0; k < wantSrc.length; k += FETCH_CHUNK) {
            const chunk = wantSrc.slice(k, k + FETCH_CHUNK);
            // 받아 둔 원문이 많거나 받기에 쓸 시간이 지났으면 나머지는 다음에 — 메모리를 지키고, 받은 것은 보낼 시간을 남긴다
            // (첫 묶음은 넘어도 받는다)
            if (sources.size && (bytes >= fetchBudget || (fetchUntil && Date.now() >= fetchUntil))) {
              cand = cand.filter((u) => u < chunk[0]);
              accMore = true;
              break;
            }
            if (cut()) break;
            const small = chunk.filter((u) => sizes.get(u) <= bigLimit);
            const big = chunk.filter((u) => sizes.get(u) > bigLimit);
            if (small.length) {
              await fetchEach(small, { uid: true, source: true, internalDate: true }, (m) => {
                if (!m || m.uid == null || !m.source) return;
                const u = Number(m.uid);
                sources.set(u, { raw: m.source, at: timeOf(m.internalDate), size: sizes.get(u) });
                bytes += m.source.length;
              });
            }
            if (big.length) {
              await fetchEach(big, { uid: true, internalDate: true, headers: [...HEAD_NAMES] }, (m) => {
                if (!m || m.uid == null) return;
                const u = Number(m.uid);
                sources.set(u, { head: m.headers || Buffer.alloc(0), at: timeOf(m.internalDate), size: sizes.get(u), big: true });
              });
            }
          }
        } catch (e) {
          failed = true;
          // 받기가 실패한 계정은 60초 뒤 이어 보내기를 하지 않는다 — 같은 실패를 되풀이할 뿐이다 (다음 폴링 때 다시 본다)
          accMore = false;
          throw e;
        } finally {
          try {
            if (failed || cut()) client.close();
            else await client.logout();
          } catch {
            try { client.close(); } catch { /* 이미 닫혔다 */ }
          }
          open.delete(client);
        }

        // ── 2단계: 하나씩 보낸다 (오래된 것부터) ──
        let moved = null;
        let movedFailed = false;
        const wire = { done: false };   // 원문을 서버에 끝까지 넘겼나 (wireLogger)
        let rejectedWarned = false;
        const where = (fromFile) => (backupOn || fromFile ? 'PC 백업에' : '받은 메일함에');
        for (let ci = 0; ci < cand.length; ci++) {
          const uid = cand[ci];
          if (stopNow()) { res.more = true; break; }
          // 몫이 끝났다 — 이어 보낼지는 바깥(late)이 가른다 (한 통도 못 끝냈으면 60초 뒤 이어 보내기를 하지 않는다)
          if (late) break;
          if ((state.day.n[id] || 0) + toList.length > dayMax) {
            res.capped += 1;
            accCapped = true;
            break;
          }

          /** 이 메일 탓의 실패 — 세 번이면 건너뛰고(다음 메일로), 아니면 이 계정만 멈춘다 (순서를 지키려고) */
          const strikeOut = async (text) => {
            const n = rec.strike && rec.strike.uid === uid ? rec.strike.n + 1 : 1;
            if (n >= STRIKES) {
              skip('strike');
              res.errors.push(mailtidy.maskAddr(`${label}: 한 통을 ${STRIKES}번 보내지 못해 건너뜀 — ${text}`));
              await advance(uid);
              return true;
            }
            rec.strike = { uid, n };
            state.pending = null;
            await saveOrHalt();
            res.errors.push(mailtidy.maskAddr(`${label}: 한 통을 보내지 못함 (${n}/${STRIKES}) — ${text}`));
            return false;
          };

          // 원문 — 서버에 없으면 PC 백업 파일. 1단계 뒤에 백업이 저장하고 정리가 옮겼을 수 있어 그 자리에서 다시 찾는다
          let src = sources.get(uid);
          if (!src) {
            let file = null;
            if (backupDir && bsame) {
              file = ((files && files.get(uid)) || [])[0] || mailbackup.savedFile(backupDir, acc, boxPath, uid);
            }
            let raw = null;
            let readFailed = false;
            if (file) {
              try { raw = await fs.promises.readFile(file); } catch { raw = null; readFailed = true; }
            }
            let wasMoved = false;
            if (raw && raw.length) {
              // 정리가 옮긴 메일인가 — 사용자가 지우거나 스팸으로 옮긴 메일은 보내지 않는다
              if (!moved && !movedFailed) {
                try {
                  moved = await mailtidy.loadMoved(backupDir);
                } catch {
                  movedFailed = true;
                  res.errors.push(mailtidy.maskAddr(`${label}: 정리 기록(tidy-moved.json)을 읽지 못해 정리로 옮겨진 메일은 보지 못함`));
                }
              }
              if (moved) {
                const fh = mailtidy.headerFields(latin1(raw), { whole: true }) || {};
                const rid = mailtidy.recoverId({ envelope: { messageId: fh['message-id'] }, size: raw.length }, fh);
                wasMoved = moved.has(mailtidy.movedKey(mailbackup.accountKey(acc), boxPath, rid));
              }
            }
            if (!wasMoved) {
              // «사라진 메일»은 확인했을 때만 — 1단계 검색에 그 UID 가 없었고(서버에 없다) 백업 파일·정리 기록도 제대로 읽었다.
              // 서버에 있는데 원문이 안 왔거나(서버가 거절했거나 BODY[] 를 안 줌) 파일·기록을 잠깐 못 읽은 것은 건너뛰지 않는다 —
              // lastUid 를 두고 이 메일 탓으로 센다 (세 번이면 건너뛴다 — 계정이 영영 멈추지 않게)
              const unsure = foundSet.has(uid) || readFailed || (!!raw && raw.length > 0 && movedFailed);
              if (!unsure) {
                skip('gone');
                await advance(uid);
                continue;
              }
              if (await strikeOut(foundSet.has(uid) ? '원문을 받지 못했습니다' : 'PC 백업 파일·정리 기록을 읽지 못했습니다')) continue;
              accMore = false;
              break;
            }
            src = { raw, at: fileAt(file) || now(), size: raw.length, fromFile: true };
          }

          // 켜기 전 메일 — 받은 시각이 «켠 때»보다 이르다. UID 와 상관없이 본다: 보관함·휴지통에서 받은편지함으로 옮기거나
          // 되찾은 옛 메일은 새 UID 를 받아도 받은 시각은 그대로다 (IMAP MOVE·COPY 가 INTERNALDATE 를 지킨다).
          // 기준을 잡을 때 있던 UID(floor)는 그때 쓴 시각 그대로(파일 이름의 시각은 분 단위라 1분 여유),
          // 그 뒤 UID 는 서버·PC 시계가 몇 분 어긋나도 켠 직후 메일을 버리지 않게 여유를 둔다
          const inFloor = !!rec.floor && uid <= rec.floor.uid;
          const oldCut = inFloor ? rec.floor.at - (src.fromFile ? 60_000 : 0) : rec.since ? rec.since - OLD_SLACK_MS : 0;
          if (oldCut && src.at && src.at < oldCut) {
            skip('old');
            await advance(uid);
            continue;
          }

          // 읽기 «전에» 적는다 — 이 메일을 읽다가 앱이 꺼지면 다음에 센다 (두 번째면 건너뛴다)
          const pp = state.pending;
          const prevN = pp && pp.acc === id && pp.uid === uid && pp.stage === 'read' ? Number(pp.n) || 0 : 0;
          state.pending = { acc: id, uid, stage: 'read', n: prevN + 1, k: '', at: now() };
          await saveOrHalt();

          let parsed;
          let broken = false;
          try {
            parsed = src.big
              ? await mailparser.simpleParser(src.head)
              // cid 링크를 data URL 로 바꾸지 않는다 — 본문 그림을 같은 Content-ID 로 다시 붙인다
              : await mailparser.simpleParser(src.raw, { keepCidLinks: true });
          } catch {
            broken = true;
            try {
              parsed = await mailparser.simpleParser(headPart(src.raw || src.head));
            } catch {
              parsed = { headers: new Map(), from: null, subject: '' };
            }
          }
          if (!parsed || !(parsed.headers instanceof Map)) parsed = { ...(parsed || {}), headers: new Map() };

          const sh = mailtidy.headerFields(latin1(src.raw || src.head), { whole: true }) || {};
          const k = keyOf(id, sh, src.size);
          if (sentSet.has(k)) {
            skip('dup');
            await advance(uid);
            continue;
          }
          const why = skipReason(parsed, { to: toList, rules, tok: state.tok, own: ownList });
          if (why) {
            skip(why);
            await advance(uid);
            continue;
          }

          const ctx = {
            from: mail.fromOf(acc), to: toList, accountName: acc.name || acc.user,
            at: src.at || now(), backupOn: backupOn || !!src.fromFile, tok: state.tok
          };
          let built = null;
          let buildErr = null;
          try {
            if (src.big) {
              const mb = Math.max(1, Math.round(src.size / 1048576));
              built = { raw: await compile(buildStub(parsed, ctx,
                `원문이 커서(${mb}MB) 본문과 첨부를 싣지 못했습니다 — 원본은 ${where(src.fromFile)}`)), stub: true };
            } else if (broken) {
              built = { raw: await compile(buildRawFallback(src.raw, parsed, ctx, sizeLimit)), stub: true };
            } else {
              try {
                built = await fitToLimit(parsed, ctx, sizeLimit);
              } catch {
                // 만들지 못하는 원문 — 세 번 실패를 기다리지 않고 원문을 그대로 붙여 보낸다
                built = { raw: await compile(buildRawFallback(src.raw, parsed, ctx, sizeLimit)), stub: true };
              }
            }
          } catch (e) {
            buildErr = e;
          }

          if (buildErr) {
            state.pending = null;
            await saveOrHalt();
            if (await strikeOut('메일을 만들지 못했습니다')) continue;
            accMore = false;
            break;
          }

          // 보내기 «전에» 적는다 — 보낸 뒤 저장하기 전에 꺼지면 다음 시작에서 «보냈는지 모름»으로 세고 다시 보내지 않는다
          const sending = () => ({ acc: id, uid, stage: 'send', k, n: 0, at: now() });
          state.pending = sending();
          await saveOrHalt();
          if (!tx) {
            tx = transport(acc, { logger: wireLogger(wire) });
            open.add(tx);
          }
          let sizeTries = 0;
          let lim = 0;
          let outcome = '';   // 'sent' | 'next' | 'stop'
          for (;;) {
            let info;
            try {
              wire.done = false;
              // size 를 주면 nodemailer 가 서버의 SIZE 한도와 견줘, 넘으면 올리기 전에 멈춘다 (EMESSAGE · MAIL FROM)
              // pool 전송은 서버가 인사(220) 전에 연결을 끊으면 오류 없이 멈춰 있는다 (실측 — 127.0.0.1 가짜 서버,
              // pool 이 아닌 전송은 1초 만에 오류). 그러면 실행이 상한(MAX_MS)까지 붙잡힌다. 따로 시간을 재 끊는다 —
              // 원문을 넘기기 전이면 «안 나감»(다음에 다시), 넘긴 뒤면 아래 «확인 안 됨» 길로 간다 (wire.done)
              let hangTimer = null;
              const hang = new Promise((_, reject) => {
                hangTimer = setTimeout(() => {
                  try { tx.close(); } catch { /* 이미 닫혔다 */ }
                  const err = new Error('보내는 서버가 답하지 않습니다');
                  err.code = 'ETIMEDOUT';
                  reject(err);
                }, sendHangMs);
              });
              try {
                info = await Promise.race([
                  tx.sendMail({ envelope: { from: ctx.from.address, to: toList, size: built.raw.length }, raw: built.raw }),
                  hang
                ]);
              } finally {
                clearTimeout(hangTimer);
              }
            } catch (e) {
              const kind = smtpKind(e, signal);
              if (kind === 'abort') {
                // 강제로 끊었다. 원문을 끝까지 넘긴 뒤였으면 보냈는지 모른다 — pending(send)을 그대로 둔다: 다음 시작에서
                // «확인 안 됨»으로 세고 다시 보내지 않는다. 넘기기 전이었으면 안 나간 것이다 — 지워서 다음에 다시 보낸다
                if (!wire.done) {
                  state.pending = null;
                  try { await save(dir, state); } catch { /* 못 쓰면 다음 시작이 «확인 안 됨»으로 셀 뿐이다 */ }
                }
                res.aborted = true;
                throw e;
              }
              if (wire.done && !(Number(e && e.responseCode) > 0)) {
                // 원문을 끝(«.»)까지 넘긴 뒤 답(250) 없이 끊기거나 시간이 넘었다 — 서버가 받았을 수 있다 (큰 첨부를 오래 검사하는
                // 회사 중계 서버에서 흔하다). 다시 보내면 같은 메일이 폴링마다 또 간다 — 강제로 끊은 것처럼 «확인 안 됨»으로 세고
                // 다시 보내지 않는다. 이 계정은 이번에는 멈춘다 (다음 폴링 때 이어서)
                state.pending = null;
                if (!sentSet.has(k)) { state.sent.push(k); sentSet.add(k); }
                rec.lastUid = Math.max(rec.lastUid, uid);
                rec.strike = null;
                state.day.n[id] = (state.day.n[id] || 0) + toList.length;
                res.uncertain += 1;
                done += 1;
                res.notes.push(mailtidy.maskAddr(`${label}: 1통은 보냈는지 확인하지 못해 다시 보내지 않음`));
                await saveOrHalt();
                outcome = 'stop';
                break;
              }
              // 서버가 답했거나 원문을 넘기기 전에 끊겼다 — 안 나간 것이다
              state.pending = null;
              await saveOrHalt();
              if (kind === 'size' && !built.stub && sizeTries < 2) {
                sizeTries += 1;
                try {
                  if (sizeTries === 1) lim = limitFrom(e, built.raw.length);
                  // 서버가 말한 한도의 95% 로 한 번, 그래도 크면 첨부를 모두 빼고 한 번 더
                  built = await fitToLimit(parsed, ctx, Math.floor(lim * 0.95), { lean: sizeTries > 1 });
                } catch {
                  outcome = (await strikeOut('메일을 만들지 못했습니다')) ? 'next' : 'stop';
                  break;
                }
                state.pending = sending();
                await saveOrHalt();
                continue;
              }
              if (kind === 'account') {
                // 계정 탓 — 이 메일을 버리지 않는다. lastUid 는 그대로라 다음 폴링에서 다시 본다
                res.errors.push(mailtidy.maskAddr(`${label}: ${smtpText(e, acc)}`));
                res.failedAccounts += 1;
                outcome = 'stop';
                break;
              }
              outcome = (await strikeOut(smtpText(e, acc))) ? 'next' : 'stop';
              break;
            }
            // 나갔다
            state.pending = null;
            state.sent.push(k);
            sentSet.add(k);
            rec.lastUid = Math.max(rec.lastUid, uid);
            rec.strike = null;
            state.day.n[id] = (state.day.n[id] || 0) + toList.length;
            res.sent += 1;
            done += 1;
            if (info && Array.isArray(info.rejected) && info.rejected.length && !rejectedWarned) {
              rejectedWarned = true;
              res.errors.push(mailtidy.maskAddr(`${label}: 일부 받는 주소를 서버가 받지 않았습니다`));
            }
            await saveOrHalt();
            outcome = 'sent';
            break;
          }
          if (outcome === 'stop') {
            // 계정 탓·이 메일 탓으로 멈춘 계정은 이어 보내지 않는다 — 다음 폴링 때 다시 본다
            // (60초 뒤 이어 보내기로 다시 부르면 «3번 실패»가 몇 분 만에 차 버린다)
            accMore = false;
            break;
          }
        }
        if (late) throw new Error('시간 몫을 다 썼다');
      } catch (e) {
        if (late && !aborted() && !res.halt) {
          const x = new Error('시간 안에 다 보내지 못함 — 다음에 이어서');
          x.late = true;
          x.progress = done > 0;
          throw x;
        }
        throw e;
      } finally {
        clearTimeout(lateTimer);
        if (tx) {
          try { tx.close(); } catch { /* 이미 닫혔다 */ }
          open.delete(tx);
        }
        // 하루 한도로 멈춘 계정은 «나머지는 다음에»로 이어 보내지 않는다 — 내일 이어서 (60초마다 다시 붙지 않게).
        // 몫이 끝나도록 한 통도 못 끝낸 계정도 — 60초마다 같은 원문을 다시 받기만 한다 (다음 폴링 때 다시 본다)
        if (accMore && !accCapped && !(late && !done)) res.more = true;
      }
    };

    for (let i = 0; i < order.length; i++) {
      const acc = order[i];
      const label = mailtidy.labelOf(acc, list.indexOf(acc));
      if (stopNow()) { res.more = true; break; }
      const problem = send.problemWith(acc, { to: toList.join(', ') });
      if (problem) {
        res.errors.push(mailtidy.maskAddr(`${label}: ${problem}`));
        res.failedAccounts += 1;
        continue;
      }
      // 오늘 한도 — 오류가 아니다. 내일 이어서
      if ((state.day.n[acc.id] || 0) + toList.length > dayMax) {
        res.capped += 1;
        continue;
      }
      res.accounts += 1;
      // 남은 시간을 남은 계정 수로 나눈다 — 빨리 끝난 계정의 몫은 뒤 계정이 쓴다
      const share = deadline ? Math.max(accountMinMs, Math.floor((deadline - Date.now()) / (order.length - i))) : 0;
      try {
        await forwardAccount(acc, label, share);
      } catch (e) {
        if (aborted()) { res.aborted = true; res.more = true; break; }
        if (res.halt) {
          res.errors.push(mailtidy.maskAddr(`${label}: ${HALT}`));
          break;
        }
        if (e && e.late) {
          // 실패가 아니다 — 이 계정의 남은 것은 다음 실행에서 이어서 본다. 한 통도 못 끝냈으면 60초 뒤 이어 보내기는
          // 하지 않는다 (느린 서버에서 같은 원문만 매번 다시 받게 된다) — 다음 폴링 때 다시 본다
          if (e.progress) res.more = true;
          res.notes.push(mailtidy.maskAddr(`${label}: ${e.message}`));
          continue;
        }
        res.failedAccounts += 1;
        res.errors.push(mailtidy.maskAddr(`${label}: ${imapText(e)}`));
      }
    }

    // 마지막으로 확인한 때(okAt)·차례(rr)를 남긴다 — 못 써도 다음 실행이 조금 더 거슬러 볼 뿐이다
    if (!res.halt) {
      try { await save(dir, state); } catch { /* 위 설명 */ }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (aborted()) { res.aborted = true; res.more = true; }
  return res;
}

module.exports = {
  STATE_FILE, CAP, SIZE_LIMIT, SEND_HANG_MS, BIG_LIMIT, FETCH_BUDGET, SENT_MAX, STRIKES, DAY_RCPT, RESEED_BACK_MS, HEAD_NAMES,
  loadState, saveState, fpOf, whoOf, keyOf, clean, skipReason, headLines, fwdSubject, stripHead,
  buildForward, buildStub, buildRawFallback, fitToLimit, smtpKind, smtpText, imapText, limitFrom, forwardAll
};

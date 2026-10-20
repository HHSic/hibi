'use strict';
// 자동 전달 엔진 — 새로 온 메일을 정해 둔 주소로 보내는가 (src/mailfwd.js).
//
// 창도 Electron 도 쓰지 않는다 — 가짜 IMAP(test/fixtures/fake-imap.js)·가짜 SMTP 전송·임시 폴더로만 돈다.
// 진짜 메일 서버에 붙지 않고, 진짜 메일을 보내지 않는다. 보낸 원문은 mailparser 로 다시 읽어 본다.
//   [1] 순수 함수 — 제목·다듬기·머리 블록·열쇠·지문·SMTP 오류 나누기
//   [2] 첫 실행은 기준만 잡는다 (UIDNEXT·SEARCH ALL·빈 상자)   [3] «켠 때부터» — 3일 창·깨진 기록
//   [4] 오래된 것부터, 한 번에 30통   [5] 글 본문과 머리 블록 · HTML 만 있는 원문 · charset meta · 머리 블록 위조
//   [6] 첨부·본문 그림   [7] 크기 — 큰 첨부 빼기·서버 SIZE 한도·아주 큰 원문
//   [8] 건너뛰기   [9] 앱이 죽는 경우·중복   [10] PC 백업 파일로 대신 보내기
//   [11] SMTP 계정 오류는 버리지 않는다   [12] 3번 실패 · 해석하지 못하는 원문
//   [13] 계정 하나가 넘어져도·시간 몫·차례   [14] 멈추기·끊기   [15] 기준 다시 잡기
//   [16] 하루 한도   [17] 읽기 전용   [18] 봉투·머리글·주소 가리기·연결 이어 쓰기
//   [19] 원문을 넘긴 뒤 끊김은 «확인 안 됨»   [20] «사라진 메일»은 확인했을 때만   [21] 메일 하나의 FETCH 거절
//   [22] 전달 기록을 잠깐 못 읽음   [23] 몫 안에서 받은 것은 보낸다   [24] 켠 뒤 옮겨 온 옛 메일
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const mailfwd = require(path.join(ROOT, 'src', 'mailfwd.js'));
const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
const mailparser = require('mailparser');
const iconv = require('iconv-lite');
const MailComposer = require('nodemailer/lib/mail-composer');
const { makeServer } = require(path.join(__dirname, 'fixtures', 'fake-imap.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 120_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailfwd-'));
const V = 1700000000n;     // 서버 UIDVALIDITY (imapflow 는 BigInt 로 준다)
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TO = ['me@gmail.com'];
/** UTF-8 글을 원문 바이트(latin1 글)로 — 가짜 서버는 원문을 latin1 글로 들고 있다 */
const L = (s) => Buffer.from(s, 'utf8').toString('latin1');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

let seq = 0;
/** 글 메일 한 통의 원문 */
function rawOf(o = {}) {
  const id = o.id === undefined ? `m${++seq}.${crypto.randomBytes(3).toString('hex')}@corp.example` : o.id;
  const date = o.date || new Date();
  // 한글 제목은 RFC 2047 로 — 진짜 메일이 그렇다 (날것 UTF-8 머리글은 mailparser 가 끝 바이트 0xA0 을 공백으로 잘라 먹는다)
  const subject = /[^\x20-\x7e]/.test(o.subject || '') ? `=?UTF-8?B?${b64(o.subject)}?=` : o.subject;
  const head = [
    id ? `Message-ID: <${id}>` : null,
    `Date: ${date.toUTCString()}`,
    `From: ${o.from || 'Kim <kim@corp.example>'}`,
    `To: ${o.to || 'a1@corp.example'}`,
    `Subject: ${subject || 'report'}`,
    ...(o.extra || []),
    'MIME-Version: 1.0',
    o.ctype || 'Content-Type: text/plain; charset=utf-8'
  ].filter(Boolean).join('\r\n');
  return L(`${head}\r\n\r\n${o.body || 'hello body'}\r\n`);
}
/** 서버 메일 — 원문(latin1 글)과 받은 시각 */
function msgOf(uid, raw, o = {}) {
  return { uid, raw, date: o.date || new Date(), flags: o.flags || [], labels: [], noSource: !!o.noSource, fetchNo: !!o.fetchNo };
}
async function composed(m) {
  return (await new MailComposer(m).compile().build()).toString('latin1');
}
const acct = (id, over = {}) => ({
  id, name: `회사${id}`, user: `${id}@corp.example`, host: `imap.${id}.invalid`, port: 993,
  smtpHost: `smtp.${id}.invalid`, smtpPort: 465, fromAddress: `${id}@corp.example`, ...over
});
const A1 = acct('a1');
const A2 = acct('a2');

/**
 * 가짜 SMTP 전송 — 받은 것을 모으고, fail 이 오류를 돌려주면 던진다. hold 면 끊길 때까지 붙잡는다.
 * hold === 'data' 면 nodemailer 처럼 «원문을 끝까지 넘겼다»(logger.info tnx:'message')를 남긴 뒤 붙잡는다 — 250 을 기다리는 중
 */
function mkTx() {
  const tx = {
    sent: [], tries: [], fail: null, closed: 0, made: 0, hold: false, waiting: null, logger: null,
    async sendMail({ envelope, raw }) {
      tx.tries.push({ envelope, raw });
      if (tx.hold === 'data' && tx.logger) tx.logger.info({ tnx: 'message', outByteCount: raw.length }, '<%s bytes>', raw.length);
      if (tx.hold) {
        await new Promise((resolve, reject) => { tx.waiting = { resolve, reject }; });
      }
      const e = tx.fail ? tx.fail(raw, envelope) : null;
      if (e) throw e;
      tx.sent.push({ envelope, raw });
      return { accepted: envelope.to, rejected: [] };
    },
    close() {
      tx.closed += 1;
      if (tx.waiting) { tx.waiting.reject(new Error('Connection closed')); tx.waiting = null; }
    }
  };
  return tx;
}
const smtpErr = (msg, o) => Object.assign(new Error(msg), o);

/** 가짜 서버 + 임시 상태 폴더 */
let cn = 0;
function setup(spec, { to = TO, since = {} } = {}) {
  const dir = path.join(TMP, `s${++cn}`);
  fs.mkdirSync(dir, { recursive: true });
  const server = makeServer(spec);
  const tx = mkTx();
  const errs = [];
  const ctx = {
    dir, server, tx, to, since,
    box: (id = 'a1') => server.box(id, 'INBOX'),
    add: (uid, raw, o, id = 'a1') => { ctx.box(id).msgs.push({ ...msgOf(uid, raw, o), flags: new Set(), labels: new Set() }); },
    state: () => JSON.parse(fs.readFileSync(path.join(dir, mailfwd.STATE_FILE), 'utf8')),
    writeState: (st) => fs.writeFileSync(path.join(dir, mailfwd.STATE_FILE), JSON.stringify(st)),
    // run(opts) 또는 run([계정…], opts)
    run: async (a, b) => {
      const accounts = Array.isArray(a) ? a : [A1];
      const o = (Array.isArray(a) ? b : a) || {};
      const r = await mailfwd.forwardAll(accounts, {
        dir, to: ctx.to, since: ctx.since,
        connect: (a) => server.connect(a), transport: (_a, hooks) => { tx.made += 1; tx.logger = hooks && hooks.logger; return tx; }, ...o
      });
      errs.push(...r.errors, ...r.notes);
      allErrors.push(...r.errors, ...r.notes);
      return r;
    },
    errs
  };
  return ctx;
}
const inbox = (msgs, extra = {}) => ({ boxes: [{ path: 'INBOX', uidValidity: V, uidNext: 'auto', msgs, ...extra }] });
/** 계정 a1 하나 */
const one = (msgs, extra) => ({ a1: inbox(msgs, extra) });
const parse = (raw) => mailparser.simpleParser(raw, { keepCidLinks: true });
const subjects = async (tx) => Promise.all(tx.sent.map(async (s) => (await parse(s.raw)).subject));
/** 보낸 글 본문의 머리 블록 줄들 (원문 경계 줄 앞) */
const blockOf = (text) => String(text || '').split('---------- 원문 ----------')[0].trim().split('\n');
const allErrors = [];

(async () => {
  console.log('\n[1] 순수 함수');
  {
    ok(mailfwd.fwdSubject('회의 안건') === 'FW: 회의 안건' && mailfwd.fwdSubject('Fwd: x') === 'Fwd: x'
      && mailfwd.fwdSubject('FW: y') === 'FW: y' && mailfwd.fwdSubject('') === 'FW: (제목 없음)', 'fwdSubject — FW: 붙이기, 이미 있으면 그대로, 빈 제목');
    ok(mailfwd.fwdSubject('a\r\n받은 계정: x\u202Eb') === 'FW: a 받은 계정: xb', 'fwdSubject — 줄바꿈은 한 칸, 방향 제어 문자는 지운다', mailfwd.fwdSubject('a\r\n받은 계정: x\u202Eb'));
    ok(mailfwd.clean('a\u200b\u2066b\u0007  c\t\td', 50) === 'ab c d' && mailfwd.clean('x'.repeat(300)).length === 200 && mailfwd.clean(null) === '',
      'clean — 폭 없는·방향·제어 문자 지우기, 공백 접기, 길이 제한', mailfwd.clean('a\u200b\u2066b\u0007  c\t\td', 50));
    const ctx = { accountName: '회사a1', at: new Date(2026, 9, 20, 9, 5).getTime() };
    const p0 = { from: { value: [{ address: 'Kim@Corp.Example', name: '김 부장' }] }, subject: '안건', date: new Date(2026, 9, 20, 9, 5) };
    const l0 = mailfwd.headLines(p0, ctx);
    ok(JSON.stringify(l0) === JSON.stringify(['---------- 전달된 메일 ----------', '보낸 사람: kim@corp.example (김 부장)',
      '날짜: 2026-10-20 09:05', '제목: 안건', '받은 계정: 회사a1']), 'headLines — 받는 사람·참조가 없으면 그 줄이 없고, «주소 (이름)», 날짜는 YYYY-MM-DD HH:mm', l0);
    const l1 = mailfwd.headLines({ ...p0, date: new Date('x'), to: { value: [{ address: 'a@b.c', name: '' }, { group: [{ address: 'g@b.c', name: 'G' }] }] },
      cc: { value: [{ address: 'c@b.c', name: '' }] } }, ctx, ['견적서.pdf'], '한 줄');
    ok(l1.includes('받는 사람: a@b.c, g@b.c (G)') && l1.includes('참조: c@b.c') && l1.includes('날짜: 2026-10-20 09:05')
      && l1.includes('첨부: 견적서.pdf') && l1[l1.length - 1] === '한 줄', 'headLines — 그룹은 펼치고, 잘못된 날짜는 받은 시각으로, 첨부·알림 줄', l1);
    const names = Array.from({ length: 12 }, (_, i) => `f${i}`);
    ok(mailfwd.headLines(p0, ctx, names).some((l) => /^첨부: f0 · .* · f9 외 2개$/.test(l)), 'headLines — 첨부는 10개까지 + «외 n개»');

    const sh = { 'message-id': '<A@x>', date: 'Mon, 1 Jan 2026', from: 'k', subject: 's' };
    const k1 = mailfwd.keyOf('a1', sh, 100);
    ok(k1 === mailfwd.keyOf('a1', { ...sh, 'message-id': ' <a@X> ' }, 100), 'keyOf — Message-ID 의 꺾쇠·대소문자·공백은 같다');
    ok(k1 !== mailfwd.keyOf('a1', { ...sh, date: 'Tue, 2 Jan 2026' }, 100) && k1 !== mailfwd.keyOf('a1', sh, 101)
      && k1 !== mailfwd.keyOf('a2', sh, 100) && /^[0-9a-f]{24}$/.test(k1), 'keyOf — 같은 Message-ID 라도 Date·크기·계정이 다르면 다른 열쇠 (24 hex)', k1);
    const f1 = mailfwd.fpOf(A1, ['x@y.zz', 'a@b.cc'], 'pc');
    ok(/^[0-9a-f]{32}$/.test(f1) && f1 === mailfwd.fpOf(A1, ['a@b.cc', 'x@y.zz'], 'pc')
      && f1 !== mailfwd.fpOf(A1, ['a@b.cc', 'x@y.zz'], 'other-pc') && f1 !== mailfwd.fpOf({ ...A1, smtpHost: 'evil.invalid' }, ['a@b.cc', 'x@y.zz'], 'pc')
      && f1 !== mailfwd.fpOf({ ...A1, fromAddress: 'z@corp.example' }, ['a@b.cc', 'x@y.zz'], 'pc')
      && f1 !== mailfwd.fpOf(A1, ['a@b.cc'], 'pc'), 'fpOf — 받는 주소 순서는 상관없고, PC·보내는 서버·보내는 주소·받는 주소가 바뀌면 다르다');
    const w1 = mailfwd.whoOf(A1, 'INBOX');
    ok(/^[0-9a-f]{16}$/.test(w1) && w1 === mailfwd.whoOf({ ...A1, user: 'A1@Corp.Example' }, 'INBOX')
      && w1 !== mailfwd.whoOf({ ...A1, user: 'b@corp.example' }, 'INBOX') && w1 !== mailfwd.whoOf(A1, 'Work'), 'whoOf — 아이디·폴더가 바뀌면 다르다');

    const K = (e) => mailfwd.smtpKind(e);
    const cases = [
      [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, 'account', 'EAUTH'],
      [{ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 421, response: '421 4.7.0 try later' }, 'account', '421'],
      [{ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553, response: '553 5.7.1 sender rejected' }, 'account', 'MAIL FROM 553'],
      [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 552, response: '552 5.2.2 mailbox full' }, 'account', 'RCPT 552 5.2.2'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.4.5 Daily user sending quota exceeded' }, 'account', 'DATA 550 5.4.5 quota'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 552, response: '552 5.3.4 too big' }, 'size', 'DATA 552'],
      [{ code: 'EMESSAGE', command: 'MAIL FROM', message: 'Message size larger than allowed 1000' }, 'size', "EMESSAGE 'larger than allowed 1000'"],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.7.1 virus found' }, 'message', 'DATA 554'],
      // 낱말 경계 — corporate·generated·separate·unlimited 안의 rate·limit 은 한도가 아니다 (내용 거부 → 그 메일 탓)
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.7.1 Message rejected due to corporate policy' }, 'message', 'DATA 554 corporate policy'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.7.1 Content generated by filter' }, 'message', 'DATA 550 generated'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.7.1 Separate attachments not allowed' }, 'message', 'DATA 550 separate'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.6.0 unlimited nesting rejected' }, 'message', 'DATA 554 unlimited'],
      // 진짜 한도 글은 그대로 계정 탓
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.2.0 STOREDRV.Submission.Exception:SubmissionQuotaExceededException' }, 'account', 'O365 SubmissionQuotaExceeded'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 Daily sending limit exceeded' }, 'account', 'DATA 550 daily sending limit'],
      [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.5.3 Too many recipients' }, 'account', 'RCPT too many recipients'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 552, response: '552 5.2.2 mailbox full' }, 'account', 'DATA 552 5.2.2 메일함 가득 (크기 아님)'],
      [{ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 552, response: '552 5.3.4 Message size exceeds fixed maximum message size' }, 'size', 'MAIL FROM 552 5.3.4'],
      [{ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 Message size limit exceeded' }, 'size', 'DATA 550 size limit (코드 없음)'],
      [{ code: 'ETIMEDOUT', command: 'CONN' }, 'account', 'ETIMEDOUT CONN (원문을 넘겼는지는 forwardAll 이 따로 본다)'],
      [{}, 'account', '알 수 없음']
    ];
    for (const [o, want, label] of cases) {
      const e = smtpErr(o.message || 'x', o);
      ok(K(e) === want, `smtpKind — ${label} → ${want}`, K(e));
    }
    ok(mailfwd.smtpKind(smtpErr('x', { command: 'DATA', responseCode: 554 }), { aborted: true }) === 'abort', 'smtpKind — 끊었으면 abort');
    ok(mailfwd.limitFrom(smtpErr('Message size larger than allowed 1000', {}), 9000) === 1000 && mailfwd.limitFrom(smtpErr('x', {}), 9000) === 4500,
      'limitFrom — «larger than allowed N» 의 N, 없으면 지금 크기의 절반');
    const t554 = mailfwd.smtpText(smtpErr('Message failed', { code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.7.1 급여명세_홍길동.xlsx virus' }), A1);
    ok(t554 === '보내는 서버가 이 메일을 거절했습니다 (554 5.7.1)', 'smtpText — 서버 글은 싣지 않고 코드만', t554);
    const tq = mailfwd.smtpText(smtpErr('x', { code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.4.5 Daily user sending quota exceeded' }), A1);
    ok(/발송 한도/.test(tq) && !/quota/i.test(tq), 'smtpText — 한도는 «발송 한도», 서버 낱말(quota)은 없다', tq);
    const tcp = mailfwd.smtpText(smtpErr('x', { code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.7.1 Message rejected due to corporate policy' }), A1);
    ok(tcp === '보내는 서버가 이 메일을 거절했습니다 (554 5.7.1)', 'smtpText — «corporate policy» 는 한도가 아니라 이 메일 거절', tcp);
    const tc = mailfwd.smtpText(smtpErr('connect ECONNREFUSED', { code: 'ECONNECTION', command: 'CONN' }), A1);
    ok(tc === '보내는 서버에 연결하지 못했습니다 (smtp.a1.invalid:465)', 'smtpText — 연결은 서버:포트', tc);
    ok(mailfwd.imapText(Object.assign(new Error('mine'), { own: true })) === 'mine'
      && mailfwd.imapText(new Error('AUTHENTICATIONFAILED')) === '로그인이 거절됐습니다 — 평소 비밀번호가 아닌 앱 비밀번호를 넣으세요'
      && mailfwd.imapText(Object.assign(new Error('NO [SERVERBUG] secret subject here'), { code: 'X1' })) === '받는 서버 오류 (X1)',
    'imapText — 우리 말은 그대로, 알려진 것은 friendly, 모르는 서버 글은 싣지 않는다');
    ok(mailfwd.stripHead('<head><meta charset="ks_c_5601-1987"><META http-equiv=Content-Type content="text/html; charset=euc-kr"><base href="http://x/"><meta name="a"></head>')
      === '<head><meta name="a"></head>', 'stripHead — charset meta·Content-Type meta·base 만 걷는다');
  }

  console.log('\n[2] 첫 실행은 기준만 잡는다');
  {
    const old = new Date(Date.now() - HOUR);
    for (const [label, extra] of [['UIDNEXT 를 주는 서버', { uidNext: 'auto' }], ['UIDNEXT 가 없는 서버 (SEARCH ALL)', { uidNext: undefined }]]) {
      const c = setup({ a1: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [msgOf(1000, rawOf({ date: old }), { date: old }), msgOf(1003, rawOf({ date: old }), { date: old })], ...extra }] } },
        { since: { a1: Date.now() } });
      let r = await c.run();
      ok(r.sent === 0 && r.seeded === 1 && c.state().acc.a1.lastUid === 1003, `${label} — 0통 보내고 «지금부터» 표시 (lastUid 1003)`, { sent: r.sent, seeded: r.seeded, last: c.state().acc.a1.lastUid });
      c.add(1010, rawOf({ subject: 'new1' }));
      r = await c.run();
      ok(r.sent === 1 && r.seeded === 0 && JSON.stringify(await subjects(c.tx)) === '["FW: new1"]', `${label} — 그 뒤 더한 메일만 간다`, await subjects(c.tx));
    }
    const ce = setup({ a1: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [] }] } });
    let r = await ce.run();
    ok(r.sent === 0 && r.seeded === 1 && ce.state().acc.a1.lastUid === 0, '빈 상자 — lastUid 0 으로 표시', ce.state().acc.a1);
    ce.add(1000, rawOf({ subject: 'first' }));
    r = await ce.run();
    ok(r.sent === 1, '…첫 메일이 오면 보낸다', r.sent);
    const cs = setup({ a1: { boxes: [{ path: 'INBOX', uidValidity: V, msgs: [msgOf(1000, rawOf())] }] } });
    cs.server.spec.a1.searchReturns = false;
    r = await cs.run();
    ok(r.failedAccounts === 1 && r.errors.some((e) => /서버가 검색에 답하지 않았습니다/.test(e)) && !cs.state().acc.a1,
      '검색에 답하지 않는 서버 — 계정 실패, 기록 없음', r.errors);
  }

  console.log('\n[3] «켠 때부터» — 켜고 첫 실행 전에 온 메일도 보낸다');
  {
    const t = Date.now() - HOUR;
    const at = (ms) => new Date(t + ms);
    const msgs = [
      msgOf(1000, rawOf({ subject: 'old1', date: at(-2 * HOUR) }), { date: at(-2 * HOUR) }),
      msgOf(1003, rawOf({ subject: 'old2', date: at(-HOUR) }), { date: at(-HOUR) }),
      msgOf(1006, rawOf({ subject: 'new1', date: at(10 * 60_000) }), { date: at(10 * 60_000) }),
      // 받은편지함으로 옮겨 온 옛 메일 — UID 는 크지만 받은 시각은 «켠 때»보다 이르다
      msgOf(1009, rawOf({ subject: 'movedin', date: at(-5 * DAY) }), { date: at(-5 * DAY) }),
      msgOf(1012, rawOf({ subject: 'new2', date: at(20 * 60_000) }), { date: at(20 * 60_000) })
    ];
    const c = setup(one(msgs), { since: { a1: t } });
    const r = await c.run();
    ok(r.sent === 2 && JSON.stringify(await subjects(c.tx)) === '["FW: new1","FW: new2"]' && r.skips.old === 1 && r.seeded === 1,
      '켠 뒤 온 2통만 보내고, 옮겨 온 옛 메일은 «켜기 전 메일»로 건너뛴다', { sent: await subjects(c.tx), skips: r.skips, errors: r.errors });
    const c2 = setup(one(msgs.map((m) => ({ ...m }))), { since: { a1: Date.now() - 4 * DAY } });
    const r2 = await c2.run();
    ok(r2.sent === 0 && r2.seeded === 1 && c2.state().acc.a1.lastUid === 1012, '«켠 때»가 3일보다 오래됐으면 맨 위부터 (0통)', { sent: r2.sent, last: c2.state().acc.a1.lastUid });
    const c3 = setup(one(msgs.map((m) => ({ ...m }))), { since: { a1: t } });
    fs.writeFileSync(path.join(c3.dir, mailfwd.STATE_FILE), '{broken');
    const r3 = await c3.run();
    ok(r3.sent === 0 && r3.reset === true && r3.seeded === 1 && /^[0-9a-f]{16}$/.test(c3.state().tok), '깨진 전달 기록 — 던지지 않고 reset, 0통 (지금부터)', { sent: r3.sent, reset: r3.reset });
  }

  console.log('\n[4] 오래된 것부터, 한 번에 30통');
  {
    const c = setup(one([]));
    await c.run();
    for (let i = 0; i < 31; i++) c.add(2000 + i * 3, rawOf({ subject: `n${String(i).padStart(2, '0')}` }));
    let r = await c.run();
    const s1 = await subjects(c.tx);
    ok(r.sent === 30 && r.more === true && s1[0] === 'FW: n00' && s1[29] === 'FW: n29', '31통 → 30통 보내고 «나머지는 다음에», 오래된 것부터', { sent: r.sent, more: r.more, first: s1[0], last: s1[29] });
    r = await c.run();
    ok(r.sent === 1 && r.more === false && (await subjects(c.tx))[30] === 'FW: n30', '다음 실행에 나머지 1통', r.sent);
    ok(c.tx.made === 2 && c.tx.closed === 2, '전송은 계정·실행마다 한 번 만들고 닫는다 (30통에 30번 로그인하지 않는다)', { made: c.tx.made, closed: c.tx.closed });
  }

  console.log('\n[5] 글 본문과 머리 블록');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: '주간 보고', from: `=?UTF-8?B?${b64('김 부장')}?= <kim@corp.example>`, to: 'a1@corp.example, Lee <lee@corp.example>',
      extra: ['Cc: park@corp.example'], body: '첫 줄\r\n링크 <https://example.com/x>\r\n끝' }));
    // HTML 만 있는 원문
    c.add(1003, rawOf({ subject: 'html only', ctype: 'Content-Type: text/html; charset=utf-8', body: '<html><head><title>t</title></head><body class="b"><p>서식 본문 낱말</p></body></html>' }));
    // EUC-KR 원문 — charset meta·base 가 붙어 있다
    const euc = iconv.encode('<html><head><meta http-equiv="Content-Type" content="text/html; charset=ks_c_5601-1987"><meta charset=ks_c_5601-1987><base href="http://evil.example/"></head><body>안녕하세요 본문</body></html>', 'euc-kr').toString('latin1');
    c.add(1006, L('Message-ID: <euc@corp.example>\r\nDate: Mon, 19 Oct 2026 00:00:00 +0000\r\nFrom: kim@corp.example\r\nSubject: euc\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=ks_c_5601-1987\r\nContent-Transfer-Encoding: 8bit\r\n\r\n') + euc);
    // 머리 블록 위조 — 줄바꿈을 숨긴 이름·첨부 이름, 방향 제어 문자, 주소처럼 생긴 이름
    const forged = await composed({
      from: { name: 'Boss\r\n받은 계정: 회사\r\n보낸 사람: ceo@corp.com\u202E', address: 'x@evil.test' },
      to: { name: 'ceo@corp.com', address: 'y@evil.test' },
      subject: '위조\r\n제목: 가짜', text: '본문',
      attachments: [{ filename: 'a\r\n받은 계정: 가짜.pdf', content: Buffer.from('pdf') }]
    });
    c.add(1009, forged);
    const r = await c.run();
    ok(r.sent === 4, '(4통 보냄)', r.sent);
    const [p1, p2, p3, p4] = await Promise.all(c.tx.sent.map((s) => parse(s.raw)));
    const b1 = blockOf(p1.text);
    ok(b1[0] === '---------- 전달된 메일 ----------' && b1[1] === '보낸 사람: kim@corp.example (김 부장)'
      && b1[2] === '받는 사람: a1@corp.example, lee@corp.example (Lee)' && b1[3] === '참조: park@corp.example'
      && /^날짜: \d{4}-\d\d-\d\d \d\d:\d\d$/.test(b1[4]) && b1[5] === '제목: 주간 보고' && b1[6] === '받은 계정: 회사a1' && b1.length === 7,
    'text — 머리 블록 일곱 줄 (보낸 사람·받는 사람·참조·날짜·제목·받은 계정)', b1);
    ok(/---------- 원문 ----------\n첫 줄\n링크 <https:\/\/example\.com\/x>\n끝/.test(p1.text), '…경계 줄 뒤에 원문 전체 (링크 주소도 그대로)', p1.text.slice(-60));
    ok(p1.subject === 'FW: 주간 보고' && !p1.html, '제목 FW:, 글 원문이면 서식 본문은 없다');
    ok(/서식 본문 낱말/.test(p2.text) && /---------- 원문 ----------/.test(p2.text), 'HTML 만 있는 원문 — text 에 본문 낱말', p2.text.slice(-40));
    ok(/<body class="b"><div style="[^"]*border-bottom[^"]*">---------- 전달된 메일 ----------<br>보낸 사람: /.test(p2.html) && /<p>서식 본문 낱말<\/p>/.test(p2.html),
      '…html 은 <body> 바로 뒤에 머리 블록, 원문 HTML 은 그대로', p2.html.slice(0, 200));
    ok(/안녕하세요 본문/.test(p3.html) && /안녕하세요 본문/.test(p3.text) && !/ks_c_5601/i.test(p3.html) && !/<base/i.test(p3.html) && !/http-equiv/i.test(p3.html),
      'EUC-KR 원문 — 보낸 html 에 charset meta·Content-Type meta·base 가 없고 한글은 그대로', p3.html.slice(0, 160));
    ok(p3.html.startsWith('<html><head></head><body><div') || /^<html><head>\s*<\/head><body><div/.test(p3.html), '…<head> 는 남고 머리 블록은 <body> 뒤', p3.html.slice(0, 60));
    const b4 = blockOf(p4.text);
    ok(b4.length === 7 && b4.filter((l) => l.startsWith('보낸 사람:')).length === 1 && b4.filter((l) => l.startsWith('받은 계정:')).length === 1
      && b4.filter((l) => l.startsWith('제목:')).length === 1, '위조 — 숨긴 줄바꿈이 있어도 머리 블록은 일곱 줄, «보낸 사람:»·«받은 계정:»·«제목:» 줄은 하나씩', b4);
    ok(!p4.text.includes('\u202E') && !p4.html, '…방향 제어 문자(U+202E)가 남지 않는다');
    ok(b4[1].startsWith('보낸 사람: x@evil.test (Boss') && b4[2] === '받는 사람: y@evil.test (ceocorp.com)' && /^첨부: a 받은 계정: 가짜\.pdf$/.test(b4[6]),
      '…«주소 (이름)» — 이름에서 @<>" 는 지운다 (ceocorp.com), 첨부 이름도 한 줄', [b4[1], b4[2], b4[6]]);

    // 머리 블록을 숨기는 원문 — 진짜 블록이 주석·제목·style·script·숨긴 div 안에 들어가면 원문이 그린 가짜 «보낸 사람:» 만 보인다
    const fake = '<div>---------- 전달된 메일 ----------<br>보낸 사람: ceo@corp.example</div>';
    // [이름, 원문 html, 우리 블록 바로 앞에 와야 할 글 ('' 이면 맨 앞)]
    const hides = [
      ['주석 안의 <body>', `<!-- <body> --><html><body>${fake}</body></html>`, '<!-- <body> --><html><body>'],
      ['바로 닫힌 주석 <!--> 뒤의 진짜 <body>', `<!--> <body> --><p>${fake}</p>`, '<!--> <body>'],
      ['title 안의 <body>', `<html><head><title><body></title></head><body>${fake}</body></html>`, '<html><head><title><body></title></head><body>'],
      ['style 안의 <body>', `<html><head><style>/* <body> */</style></head><body>${fake}</body></html>`, '<html><head><style>/* <body> */</style></head><body>'],
      ['script 안의 <body>', `<html><head><script>var a="<body>"</script></head><body>${fake}</body></html>`, '<html><head><script>var a="<body>"</script></head><body>'],
      ['속성 값 안의 >', `<html><body title="a>b">${fake}</body></html>`, '<html><body title="a>b">'],
      ['숨긴 div 안의 <body>', `<html><div style="display:none"><body></div>${fake}</html>`, ''],
      ['<body-x> 뒤의 <body>', `<html><body-x><body>${fake}</body></html>`, '']
    ];
    const ch = setup(one([]));
    await ch.run();
    hides.forEach(([, html], i) => ch.add(2000 + i * 3, rawOf({ subject: `hide-${i}`, ctype: 'Content-Type: text/html; charset=utf-8', body: html })));
    await ch.run();
    const hp = await Promise.all(ch.tx.sent.map((s) => parse(s.raw)));
    hides.forEach(([label, , want], i) => {
      const h = (hp[i] && hp[i].html) || '';
      ok(h.startsWith(`${want}<div style="margin:0 0 12px`) && h.indexOf('<div style="margin:0 0 12px') < h.indexOf('보낸 사람: ceo@corp.example'),
        `위조 html — ${label}: 진짜 머리 블록은 ${want ? '진짜 <body> 바로 뒤' : '맨 앞'} (가짜보다 앞)`, h.slice(0, 90));
    });

    // 여러 부분 메일 안에 HTML 만 있다 (HTML 본문 + 첨부) — mailparser 는 이때 글 본문을 만들지 않는다 → htmlToText 로
    const mixed = L('Message-ID: <mixed@corp.example>\r\nDate: Mon, 19 Oct 2026 00:00:00 +0000\r\nFrom: kim@corp.example\r\nSubject: mixed\r\n'
      + 'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="mx"\r\n\r\n'
      + '--mx\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>섞인 서식 낱말</p></body></html>\r\n'
      + '--mx\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0x\r\n--mx--\r\n');
    const mp = await parse(Buffer.from(mixed, 'latin1'));
    const cm = setup(one([]));
    await cm.run();
    cm.add(3000, mixed);
    await cm.run();
    const pm = await parse(cm.tx.sent[0].raw);
    ok(!mp.text && /---------- 원문 ----------\n[\s\S]*섞인 서식 낱말/.test(pm.text) && !/\(본문 없음\)/.test(pm.text),
      'multipart/mixed 안의 HTML 만 있는 원문 — mailparser 가 글을 안 만들어도 text 에 본문 낱말 (htmlToText)', { parsedText: mp.text, sent: pm.text.slice(-40) });

    // 그 HTML 에 표가 있으면 칸이 붙으면 안 된다 — «센서 모듈 | 20 | 1,200,000원»이 «센서 모듈201,200,000원»으로
    // 읽혀 수량과 금액이 한 숫자가 됐다 (실측 — 견본). 글만 읽는 AI 가 숫자를 틀리게 읽는다
    // mixed 는 L() 로 바이트 글이 됐다 — 바꿀 글도 같이 L() 로
    const table = mixed.replace(L('<p>섞인 서식 낱말</p>'),
      L('<table><tr><th>품목</th><th>수량</th><th>금액</th></tr><tr><td>센서 모듈</td><td>20</td><td>1,200,000원</td></tr></table>'))
      .replace('<mixed@corp.example>', '<table@corp.example>');
    const ct = setup(one([]));
    await ct.run();
    ct.add(3000, table);
    await ct.run();
    const pt = await parse(ct.tx.sent[0].raw);
    ok(/품목\t수량\t금액\n/.test(pt.text) && /센서 모듈\t20\t1,200,000원/.test(pt.text) && !/모듈20|201,200/.test(pt.text),
      'HTML 만 있는 원문의 표 — 글 본문에서 칸이 탭으로 갈린다 (수량과 금액이 붙지 않는다)', pt.text.slice(-80));
  }

  console.log('\n[6] 첨부와 본문 그림');
  {
    const c = setup(one([]));
    await c.run();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c10000000049454e44ae426082', 'hex');
    c.add(1000, await composed({
      from: 'kim@corp.example', to: 'a1@corp.example', subject: '견적', text: '글',
      html: '<p>그림 <img src="cid:pic1@corp"></p>',
      attachments: [
        { filename: '견적서.pdf', content: Buffer.from('%PDF-1.4 견적') },
        { filename: 'pic.png', content: png, cid: 'pic1@corp' },
        { filename: '안쓴그림.png', content: png, cid: 'unused@corp' }
      ]
    }));
    await c.run();
    const p = await parse(c.tx.sent[0].raw);
    const pdf = p.attachments.find((a) => a.filename === '견적서.pdf');
    const pic = p.attachments.find((a) => a.cid === 'pic1@corp');
    ok(pdf && pdf.content.equals(Buffer.from('%PDF-1.4 견적')) && pdf.contentDisposition === 'attachment', '첨부가 이름·내용 그대로 다시 붙는다', pdf && pdf.filename);
    ok(pic && pic.content.equals(png) && /cid:pic1@corp/.test(p.html), '본문 그림은 같은 Content-ID 로 붙고 html 이 그 cid: 를 그대로 가리킨다', pic && pic.cid);
    ok(/^첨부: .*견적서\.pdf/m.test(p.text) && /^첨부: .*안쓴그림\.png/m.test(p.text) && !/^첨부: .*pic\.png/m.test(p.text), '…머리 블록의 «첨부:» 는 본문 그림이 아닌 것만', blockOf(p.text).slice(-1));
    // cid:img10 만 가리키는 html — cid 가 img1 인 첨부는 본문 그림이 아니다 (앞부분만 맞으면 안 된다)
    c.add(1003, await composed({
      from: 'kim@corp.example', to: 'a1@corp.example', subject: 'cid prefix', text: '글',
      html: '<p><img src="cid:img10"></p>',
      attachments: [{ filename: 'real-attach.png', content: png, cid: 'img1' }, { filename: 'inline10.png', content: png, cid: 'img10' }]
    }));
    await c.run();
    const pc = await parse(c.tx.sent[1].raw);
    const real = pc.attachments.find((a) => a.filename === 'real-attach.png');
    ok(/^첨부: real-attach\.png$/m.test(pc.text) && real && real.contentDisposition === 'attachment', 'cid:img10 만 쓰는 html — cid img1 첨부는 «첨부:» 줄에 남고 attachment 로 붙는다', blockOf(pc.text).slice(-1));
  }

  console.log('\n[7] 크기');
  {
    const big = crypto.randomBytes(300 * 1024);
    const small = crypto.randomBytes(10 * 1024);
    const withAtts = () => composed({
      from: 'kim@corp.example', to: 'a1@corp.example', subject: '큰 첨부', text: '본문', html: '<p>본문</p>',
      attachments: [{ filename: 'big.bin', content: big }, { filename: 'small.bin', content: small }]
    });
    const c = setup(one([]));
    await c.run();
    c.add(1000, await withAtts());
    await c.run({ sizeLimit: 200 * 1024, backupOn: true });
    let p = await parse(c.tx.sent[0].raw);
    ok(p.attachments.length === 1 && p.attachments[0].filename === 'small.bin' && c.tx.sent[0].raw.length <= 200 * 1024,
      'sizeLimit 을 넘으면 큰 첨부만 빠진다', p.attachments.map((a) => a.filename));
    ok(/첨부 1개는 크기 때문에 빠짐 — 원본은 PC 백업에/.test(p.text) && /첨부 1개는 크기 때문에 빠짐 — 원본은 PC 백업에/.test(p.html),
      '…«첨부 1개는 크기 때문에 빠짐 — 원본은 PC 백업에» 줄이 text·html 둘 다에', blockOf(p.text).slice(-1));
    ok(c.tx.sent[0].envelope.size === c.tx.sent[0].raw.length, '봉투에 size 가 있다 (서버 SIZE 한도를 올리기 전에 본다)', c.tx.sent[0].envelope.size);
    c.add(1003, await withAtts());
    await c.run({ sizeLimit: 200 * 1024, backupOn: false });
    p = await parse(c.tx.sent[1].raw);
    ok(/원본은 받은 메일함에/.test(p.text), 'backupOn 이 아니면 «원본은 받은 메일함에»', blockOf(p.text).slice(-1));

    // 서버 SIZE 한도 — 'larger than allowed N' 이면 N 의 95% 로 다시 만들어 보낸다
    const N = 150_000;
    c.add(1006, await withAtts());
    let fails = 1;
    c.tx.fail = () => (fails-- > 0 ? smtpErr(`Message size larger than allowed ${N}`, { code: 'EMESSAGE', command: 'MAIL FROM' }) : null);
    let r = await c.run();
    p = await parse(c.tx.sent[2].raw);
    ok(r.sent === 1 && c.tx.sent[2].raw.length <= N * 0.95 && p.attachments.length === 1 && /첨부 1개는 크기 때문에 빠짐/.test(p.text),
      `서버가 «${N} 넘음» → 95% 안으로 다시 만들어 같은 실행에서 보낸다`, { len: c.tx.sent[2].raw.length, atts: p.attachments.length });
    c.add(1009, await withAtts());
    fails = 2;
    r = await c.run();
    p = await parse(c.tx.sent[3].raw);
    ok(r.sent === 1 && p.attachments.length === 0 && /첨부 2개는 크기 때문에 빠짐/.test(p.text), '…또 거절되면 첨부를 모두 빼고 보낸다', p.attachments.length);
    c.tx.fail = null;

    // 아주 큰 원문 — 원문(source)을 받지 않고 머리만 받아 한 줄 메일
    c.add(1012, await withAtts());
    const mark = c.server.log.length;
    r = await c.run({ bigLimit: 100 * 1024 });
    const fetched = c.server.log.slice(mark).filter((e) => e.cmd === 'fetch');
    p = await parse(c.tx.sent[4].raw);
    ok(r.sent === 1 && !fetched.some((e) => e.query.source) && fetched.some((e) => e.query.headers), 'bigLimit 을 넘는 원문은 원문을 받지 않는다 (머리만)', fetched.map((e) => Object.keys(e.query)));
    ok(/원문이 커서\(\d+MB\) 본문과 첨부를 싣지 못했습니다 — 원본은 받은 메일함에/.test(p.text) && p.attachments.length === 0 && p.subject === 'FW: 큰 첨부'
      && /보낸 사람: kim@corp\.example/.test(p.text), '…«원문이 커서» 한 줄 메일 (보낸 사람·제목은 있다)', blockOf(p.text));
  }

  console.log('\n[8] 건너뛰기');
  {
    const c = setup(one([]));
    await c.run();
    const tok = c.state().tok;
    const rules = [{ id: 'f1', on: true, field: 'subject', match: '(광고)', action: 'spam' }, { id: 'f2', on: false, field: 'subject', match: '꺼진규칙', action: 'spam' }];
    const list = [
      ['mine-header', { extra: [`X-Hibi-Forwarded: ${tok}`] }],
      ['mine-msgid', { id: `hibi-fwd.${tok}.abcdef@gmail.com` }],
      ['mine-own', { from: 'a1@corp.example', extra: ['Auto-Submitted: auto-forwarded'] }],
      ['target', { from: 'Me <ME@Gmail.com>' }],
      ['auto-replied', { extra: ['Auto-Submitted: auto-replied'] }],
      ['x-autoreply', { extra: ['X-Autoreply: yes'] }],
      ['x-autorespond', { extra: ['X-Autorespond: 1'] }],
      ['x-autoreply-from', { extra: ['X-Autoreply-From: a@b.c'] }],
      ['prec', { extra: ['Precedence: auto_reply'] }],
      ['daemon', { from: 'MAILER-DAEMON@corp.example' }],
      ['report', { ctype: 'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', body: '--b1\r\nContent-Type: text/plain\r\n\r\nfailed\r\n--b1--' }],
      ['spamflag', { extra: ['X-Spam-Flag: YES'] }],
      ['spamstatus', { extra: ['X-Spam-Status: Yes, score=9'] }],
      ['scl', { extra: ['X-MS-Exchange-Organization-SCL: 6'] }],
      ['(광고) 세일', {}],
      // 보낸다
      ['SEND-generated', { extra: ['Auto-Submitted: auto-generated'] }],
      ['SEND-forwarded', { from: 'other@corp.example', extra: ['Auto-Submitted: auto-forwarded'] }],
      ['SEND-fakehibi', { extra: ['X-Hibi-Forwarded: 1'] }],
      ['SEND-rule-off 꺼진규칙', {}],
      ['SEND-scl1', { extra: ['X-MS-Exchange-Organization-SCL: 1'] }]
    ];
    list.forEach(([subject, o], i) => c.add(1000 + i * 3, rawOf({ subject, ...o })));
    const r = await c.run({ rules, own: ['a1@corp.example'] });
    const sent = (await subjects(c.tx)).map((s) => s.replace(/^FW: /, ''));
    ok(JSON.stringify(sent) === JSON.stringify(['SEND-generated', 'SEND-forwarded', 'SEND-fakehibi', 'SEND-rule-off 꺼진규칙', 'SEND-scl1']),
      'auto-generated·남의 auto-forwarded·남의 X-Hibi-Forwarded: 1·꺼진 규칙은 보낸다', sent);
    ok(JSON.stringify(r.skips) === JSON.stringify({ mine: 3, target: 1, auto: 5, bounce: 2, spam: 4, gone: 0, dup: 0, strike: 0, crash: 0, old: 0 }) && r.skipped === 15,
      '건너뜀 — 우리 표시·우리 Message-ID·보내는 계정+auto-forwarded(3)·받는 주소(1)·자동 답장(5: Auto-Submitted·X-Autoreply·X-Autorespond·X-Autoreply-From·Precedence)·반송(2)·스팸(4: X-Spam-Flag·X-Spam-Status·SCL·규칙)', r.skips);
    ok(c.state().acc.a1.lastUid === 1000 + (list.length - 1) * 3, '건너뛴 것도 lastUid 를 올린다', c.state().acc.a1.lastUid);
    const r2 = await c.run({ rules, own: ['a1@corp.example'] });
    ok(r2.sent === 0 && r2.skipped === 0, '…다시 돌려도 다시 보지 않는다');
  }

  console.log('\n[9] 앱이 죽는 경우·중복');
  {
    // ① 보낸 뒤 저장 전에 죽음
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'crash-send' }));
    c.add(1003, rawOf({ subject: 'after' }));
    let blow = true;
    const save = async (d, st) => {
      if (blow && c.tx.sent.length >= 1 && st.pending === null) { blow = false; throw new Error('disk full'); }
      return mailfwd.saveState(d, st);
    };
    let r = await c.run({ save });
    ok(r.halt === true && r.sent === 1 && c.tx.sent.length === 1 && r.errors.some((e) => /mail-forward\.json/.test(e)), '보낸 뒤 저장하다 실패 → halt (다음 메일은 보내지 않는다)', { halt: r.halt, sent: r.sent, errors: r.errors });
    const disk = c.state();
    ok(disk.pending && disk.pending.stage === 'send' && disk.pending.uid === 1000 && /^[0-9a-f]{24}$/.test(disk.pending.k), '…디스크에 pending(send)이 남아 있다', disk.pending);
    r = await c.run();
    ok(c.tx.sent.length === 2 && r.uncertain === 1 && r.sent === 1 && (await subjects(c.tx))[1] === 'FW: after' && r.notes.some((e) => /보내던 중 앱이 꺼져 1통은 다시 보내지 않았습니다/.test(e))
      && !r.errors.length, '다시 돌리면 그 메일은 다시 보내지 않고(uncertain 1) 다음 메일만 — 그 말은 실패가 아니라 알림(notes)', { uncertain: r.uncertain, sent: await subjects(c.tx), errors: r.errors });

    // ② 같은 원문 바이트가 다른 UID 로
    const same = rawOf({ subject: 'twice', id: 'twice@corp.example' });
    c.add(1006, same);
    c.add(1009, same);
    r = await c.run();
    ok(r.sent === 1 && r.skips.dup === 1, '같은 원문 바이트가 다른 UID 로 다시 오면 dup', r.skips);
    // ③ Message-ID 는 같고 Date·본문이 다르다 (Message-ID 를 다시 쓰는 알림)
    c.add(1012, rawOf({ subject: 'alert', id: 'alert@corp.example', date: new Date(Date.now() - 60_000), body: 'one' }));
    c.add(1015, rawOf({ subject: 'alert', id: 'alert@corp.example', date: new Date(), body: 'two two' }));
    r = await c.run();
    ok(r.sent === 2 && r.skips.dup === 0, 'Message-ID 가 같아도 Date·크기가 다르면 둘 다 보낸다', r.skips);

    // ④ 읽다가 꺼짐 — 한 번이면 다시 해 보고(n=2 로 적음), 두 번이면 건너뛴다
    c.add(1018, rawOf({ subject: 'read-crash-1' }));
    let st = c.state();
    st.pending = { acc: 'a1', uid: 1018, stage: 'read', n: 1, k: '', at: Date.now() };
    c.writeState(st);
    const seen = [];
    r = await c.run({ save: async (d, s) => { if (s.pending) seen.push({ ...s.pending }); return mailfwd.saveState(d, s); } });
    ok(r.sent === 1 && seen.some((p) => p.uid === 1018 && p.stage === 'read' && p.n === 2), 'pending(read, n=1) 이 남은 채 시작 → 다시 해 보고 n=2 로 적는다', seen.filter((p) => p.stage === 'read'));
    c.add(1021, rawOf({ subject: 'read-crash-2' }));
    st = c.state();
    st.pending = { acc: 'a1', uid: 1021, stage: 'read', n: 2, k: '', at: Date.now() };
    c.writeState(st);
    const before = c.tx.sent.length;
    r = await c.run();
    ok(r.skips.crash === 1 && c.tx.sent.length === before && c.state().acc.a1.lastUid >= 1021 && !c.state().pending
      && r.notes.some((e) => /읽다가 앱이 꺼지는 메일 1통을 건너뜀/.test(e)), 'pending(read, n=2) → crash 로 건너뛰고 lastUid 가 오른다 (알림)', { skips: r.skips, last: c.state().acc.a1.lastUid });
  }

  console.log('\n[10] 정리가 옮긴 메일은 PC 백업 파일로');
  {
    const backupDir = path.join(TMP, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const accKey = mailbackup.accountKey(A1);
    const writeBackupState = (v) => fs.writeFileSync(path.join(backupDir, 'backup-state.json'),
      JSON.stringify({ [accKey]: { INBOX: { uidValidity: String(v), gen: 1, lowUid: 1, lastUid: 99999 } } }));
    const boxDir = mailbackup.boxDirFor(backupDir, A1, 'INBOX', 1);
    fs.mkdirSync(boxDir, { recursive: true });
    const keys = new Set();
    const saveFile = (uid, raw, { key = true } = {}) => {
      fs.writeFileSync(path.join(boxDir, `20261020_0900_${uid}_제목.eml`), Buffer.from(raw, 'latin1'));
      if (key) {
        const sh = mailtidy.headerFields(raw, { whole: true });
        keys.add(mailtidy.movedKey(accKey, 'INBOX', mailtidy.recoverId({ envelope: { messageId: sh['message-id'] }, size: Buffer.byteLength(raw, 'latin1') }, sh)));
        fs.writeFileSync(path.join(backupDir, mailtidy.MOVED_FILE), JSON.stringify({ v: 1, keys: [...keys] }));
      }
    };
    writeBackupState(V);
    const c = setup(one([]));
    await c.run({ backupDir, backupOn: true });
    // ① 서버에서 옮겨졌고(받은편지함에 없음) 파일·열쇠가 있다 → 파일로 보낸다
    const moved1 = rawOf({ subject: 'tidied', body: 'from file' });
    saveFile(2001, moved1);
    c.add(2001, moved1);
    c.add(2004, rawOf({ subject: 'on server' }));
    c.box().msgs = c.box().msgs.filter((m) => m.uid !== 2001);
    let r = await c.run({ backupDir, backupOn: true });
    const s1 = await subjects(c.tx);
    ok(r.sent === 2 && JSON.stringify(s1) === '["FW: tidied","FW: on server"]', '정리가 옮긴 메일은 파일로, 서버 메일은 서버에서 — UID 순서대로', s1);
    ok(/from file/.test((await parse(c.tx.sent[0].raw)).text), '…파일의 원문을 보냈다');
    // ② 파일은 있는데 열쇠가 없다 — 사용자가 지운 메일
    const del = rawOf({ subject: 'user-deleted' });
    saveFile(2007, del, { key: false });
    c.add(2007, del);
    c.box().msgs = c.box().msgs.filter((m) => m.uid !== 2007);
    c.add(2010, rawOf({ subject: 'next' }));
    r = await c.run({ backupDir, backupOn: true });
    ok(r.sent === 1 && r.skips.gone === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: next', '파일만 있고 정리 열쇠가 없으면(지운 메일) 보내지 않는다 (gone)', r.skips);
    // ③ 백업 기록의 UIDVALIDITY 가 다르다 — 옛 세대 파일은 쓰지 않는다
    writeBackupState(V + 1n);
    const gen = rawOf({ subject: 'other-gen' });
    saveFile(2013, gen);
    c.add(2013, gen);
    c.box().msgs = c.box().msgs.filter((m) => m.uid !== 2013);
    c.add(2016, rawOf({ subject: 'next2' }));
    r = await c.run({ backupDir, backupOn: true });
    ok(r.sent === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: next2' && !(await subjects(c.tx)).includes('FW: other-gen'),
      '백업 기록의 UIDVALIDITY 가 다르면 파일을 쓰지 않는다 (옛 세대 파일로 보내지 않는다)', await subjects(c.tx));
    writeBackupState(V);
    // ④ 1단계 뒤에 백업이 저장하고 정리가 옮겼다 — 2단계에서 그 자리에서 찾는다
    const late = rawOf({ subject: 'moved-mid-run', body: 'mid' });
    c.add(2019, late);
    c.server.spec.a1.hooks = {
      afterFetch: ({ query }) => {
        if (!query.size) return;
        saveFile(2019, late);
        c.box().msgs = c.box().msgs.filter((m) => m.uid !== 2019);
        c.server.spec.a1.hooks = undefined;
      }
    };
    r = await c.run({ backupDir, backupOn: true });
    ok(r.sent === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: moved-mid-run', '1단계 뒤에 옮겨진 메일도 그 자리에서 파일을 찾아 보낸다', { sent: r.sent, skips: r.skips });
    // ⑤ 백업 폴더를 못 읽는다 — 던지지 않고 서버 메일은 보낸다
    const c5 = setup(one([]), {});
    const bd5 = path.join(TMP, 'backup5');
    fs.mkdirSync(bd5, { recursive: true });
    fs.writeFileSync(path.join(bd5, 'backup-state.json'), JSON.stringify({ [accKey]: { INBOX: { uidValidity: String(V), gen: 1 } } }));
    const bx5 = mailbackup.boxDirFor(bd5, A1, 'INBOX', 1);
    fs.mkdirSync(path.dirname(bx5), { recursive: true });
    fs.writeFileSync(bx5, 'not a folder');
    await c5.run({ backupDir: bd5 });
    c5.add(3000, rawOf({ subject: 'srv' }));
    r = await c5.run({ backupDir: bd5 });
    ok(r.sent === 1 && r.failedAccounts === 0 && r.errors.some((e) => /PC 백업 폴더를 읽지 못해/.test(e)), '백업 폴더를 못 읽으면 오류 줄만 남기고 서버 메일은 보낸다', r.errors);
  }

  console.log('\n[11] SMTP 계정 오류는 메일을 버리지 않는다');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'keep-me' }));
    const errs = [
      ['EAUTH', smtpErr('Invalid login: 535 5.7.8 Username and Password not accepted', { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, response: '535 5.7.8 Username and Password not accepted' })],
      ['MAIL FROM 553', smtpErr('Mail command failed: 553 5.7.1 Sender address rejected: not owned by user a1@corp.example', { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553, response: '553 5.7.1 Sender address rejected: not owned by user a1@corp.example' })],
      ['DATA 550 5.4.5', smtpErr('Message failed: 550 5.4.5 Daily user sending quota exceeded', { code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.4.5 Daily user sending quota exceeded' })]
    ];
    for (const [label, e] of errs) {
      c.tx.fail = () => e;
      const r = await c.run();
      const st = c.state().acc.a1;
      ok(r.sent === 0 && r.failedAccounts === 1 && st.lastUid < 1000 && !st.strike && !c.state().pending
        && !r.errors.some((x) => /quota|Sender address|Username|a1@corp/i.test(x)), `${label} — lastUid 그대로, strike 없음, 오류 글에 서버 응답 글이 없다`, r.errors);
    }
    c.tx.fail = null;
    const r = await c.run();
    ok(r.sent === 1 && (await subjects(c.tx))[0] === 'FW: keep-me', '…다음 실행에서 보낸다');
  }

  console.log('\n[12] 같은 메일이 3번 실패하면 건너뛴다');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'POISON' }));
    c.add(1003, rawOf({ subject: 'fine' }));
    c.tx.fail = (raw) => (/POISON/.test(raw.toString('latin1'))
      ? smtpErr('Message failed: 554 5.7.1 급여명세_홍길동.xlsx infected', { code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.7.1 급여명세_홍길동.xlsx infected' })
      : null);
    let r = await c.run();
    ok(r.sent === 0 && c.state().acc.a1.strike.n === 1 && r.errors.some((e) => /한 통을 보내지 못함 \(1\/3\)/.test(e)) && r.more === false,
      '1번째 — (1/3), 순서를 지키려고 이 계정은 멈춘다 (뒤 메일도 아직)', r.errors);
    r = await c.run();
    ok(r.sent === 0 && c.state().acc.a1.strike.n === 2, '2번째 — (2/3)', c.state().acc.a1.strike);
    r = await c.run();
    ok(r.sent === 1 && r.skips.strike === 1 && (await subjects(c.tx))[0] === 'FW: fine' && !c.state().acc.a1.strike
      && r.errors.some((e) => /한 통을 3번 보내지 못해 건너뜀/.test(e)), '3번째 — 건너뛰고 같은 실행에서 뒤 메일은 보낸다', r.errors);
    ok(!c.errs.some((e) => /급여명세|홍길동|infected/.test(e)), '…서버 응답 글(첨부 이름)은 오류 줄에 없다', c.errs.filter((e) => /급여/.test(e)));
    c.tx.fail = null;

    // «corporate policy» 거절 — 예전에는 rate 낱말 때문에 «계정 탓»이 되어 영영 멈췄다. 이제 이 메일 탓으로 세어 3번이면 건너뛴다
    c.add(1004, rawOf({ subject: 'CORP-POLICY' }));
    c.add(1005, rawOf({ subject: 'after-policy' }));
    c.tx.fail = (raw) => (/CORP-POLICY/.test(raw.toString('latin1'))
      ? smtpErr('Message failed: 554 5.7.1 Message rejected due to corporate policy', { code: 'EMESSAGE', command: 'DATA', responseCode: 554, response: '554 5.7.1 Message rejected due to corporate policy' })
      : null);
    for (let i = 0; i < 3; i++) r = await c.run();
    ok(r.skips.strike === 1 && (await subjects(c.tx)).includes('FW: after-policy') && c.state().acc.a1.lastUid === 1005
      && !c.errs.some((e) => /발송 한도/.test(e)), '«corporate policy» 554 — 3번째에 건너뛰고 뒤 메일은 보낸다 («발송 한도»라고 하지 않는다)', { skips: r.skips, last: c.state().acc.a1.lastUid });
    c.tx.fail = null;

    // 해석하지 못하는 원문 — 실패를 기다리지 않고 original.eml 로
    const realParse = mailparser.simpleParser;
    mailparser.simpleParser = (input, o) => (o && o.keepCidLinks && /BROKEN-MARK/.test(Buffer.from(input).toString('latin1'))
      ? Promise.reject(new Error('parse fail')) : realParse(input, o));
    try {
      c.add(1006, rawOf({ subject: 'BROKEN-MARK', body: '원래 본문' }));
      r = await c.run();
    } finally {
      mailparser.simpleParser = realParse;
    }
    const p = await parse(c.tx.sent[c.tx.sent.length - 1].raw);
    const att = p.attachments.find((a) => a.filename === 'original.eml');
    ok(r.sent === 1 && att && /BROKEN-MARK/.test(att.content.toString('latin1')) && /원문을 읽지 못해 첨부\(original\.eml\)로 보냅니다/.test(p.text)
      && p.subject === 'FW: BROKEN-MARK', '해석하지 못하는 원문 — 그 실행에 original.eml 첨부로 나간다 (보낸 사람·제목은 머리만 다시 읽어 건진다)', { sent: r.sent, subject: p.subject });
  }

  console.log('\n[13] 계정 하나가 넘어져도·시간 몫·차례');
  {
    const c = setup({ a1: { failConnect: true, boxes: [{ path: 'INBOX', uidValidity: V, uidNext: 'auto', msgs: [] }] }, a2: inbox([]) });
    await c.run([A1, A2]);
    c.add(1000, rawOf({ subject: 'a2-mail' }), {}, 'a2');
    let r = await c.run([A1, A2]);
    ok(r.sent === 1 && r.failedAccounts === 1 && r.errors.some((e) => /회사a1: 로그인이 거절됐습니다/.test(e)), '받는 서버 로그인이 안 되는 계정이 있어도 다른 계정은 보낸다', r.errors);

    const c2 = setup({ a1: inbox([]), a2: inbox([]) });
    await c2.run([A1, A2]);
    const firstOf = (mark) => (c2.server.log.slice(mark).find((e) => e.cmd === 'connect') || {}).acc;
    const m2 = c2.server.log.length;
    c2.add(1000, rawOf({ subject: 'slow' }), {}, 'a1');
    c2.add(1000, rawOf({ subject: 'quick' }), {}, 'a2');
    c2.server.spec.a1.delay = { fetch: 1500 };
    const t0 = Date.now();
    r = await c2.run([A1, A2], { budgetMs: 400, accountMinMs: 150 });
    ok(Date.now() - t0 < 1400 && r.sent === 1 && (await subjects(c2.tx))[0] === 'FW: quick' && r.more === false && r.failedAccounts === 0
      && r.notes.some((e) => /회사a1: 시간 안에 다 보내지 못함 — 다음에 이어서/.test(e)) && !r.errors.length,
    '첫 계정이 몫을 넘겨도 둘째 계정은 보내고, 첫 계정은 «다음에 이어서»(알림) — 한 통도 못 끝냈으니 60초 뒤 이어 보내기(more)는 없다', { ms: Date.now() - t0, more: r.more, notes: r.notes });
    c2.server.spec.a1.delay = undefined;
    const first2 = firstOf(m2);
    const m3 = c2.server.log.length;
    r = await c2.run([A1, A2]);
    const first3 = firstOf(m3);
    ok(first2 && first3 && first2 !== first3 && r.sent === 1 && (await subjects(c2.tx))[1] === 'FW: slow',
      '실행마다 첫 계정을 돌린다 (지난번 첫 계정의 다음부터) — 밀린 a1 메일도 이어서 보낸다', { first2, first3 });
  }

  console.log('\n[14] 멈추기·끊기');
  {
    const c = setup(one([]));
    await c.run();
    for (let i = 0; i < 3; i++) c.add(1000 + i * 3, rawOf({ subject: `s${i}` }));
    let r = await c.run({ shouldStop: () => c.tx.sent.length >= 1 });
    ok(r.sent === 1 && r.more === true && c.state().acc.a1.lastUid === 1000, 'shouldStop 이 참이면 다음 보내기 전에 멈춘다', { sent: r.sent, more: r.more });
    // 받는 동안 끊기
    c.server.spec.a1.delay = { fetch: 3000 };
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const t0 = Date.now();
    r = await c.run({ signal: ctl.signal });
    ok(r.aborted === true && Date.now() - t0 < 1500 && r.sent === 0 && c.server.clients[c.server.clients.length - 1].closed, 'signal 로 끊으면 걸린 명령도 끊고 aborted', { ms: Date.now() - t0, aborted: r.aborted });
    c.server.spec.a1.delay = undefined;
    // 보내는 중에 끊기 — 원문을 다 넘기고 답을 기다리던 중이면 보냈는지 모르니 pending(send)을 남기고, 다음에 다시 보내지 않는다
    c.tx.hold = 'data';
    const ctl2 = new AbortController();
    const p = c.run({ signal: ctl2.signal });
    for (let i = 0; i < 100 && !c.tx.waiting; i++) await sleep(10);
    ctl2.abort();
    r = await p;
    c.tx.hold = false;
    ok(r.aborted === true && c.state().pending && c.state().pending.stage === 'send' && c.state().pending.uid === 1003, '보내는 중에 끊기면 pending(send)이 남는다', c.state().pending);
    r = await c.run();
    ok(r.uncertain === 1 && r.sent === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: s2', '…다음 실행은 그 메일을 «확인 안 됨»으로 세고 다시 보내지 않는다', { uncertain: r.uncertain });
    // 원문을 넘기기 전(연결·로그인 중)에 끊기면 안 나간 것이다 — pending 을 지우고 다음에 보낸다
    c.add(1009, rawOf({ subject: 's3' }));
    c.tx.hold = true;
    const ctl3 = new AbortController();
    const p3 = c.run({ signal: ctl3.signal });
    for (let i = 0; i < 100 && !c.tx.waiting; i++) await sleep(10);
    ctl3.abort();
    r = await p3;
    c.tx.hold = false;
    ok(r.aborted === true && !c.state().pending && c.state().acc.a1.lastUid === 1006, '원문을 넘기기 전에 끊기면 pending 을 지운다 (lastUid 그대로)', { pending: c.state().pending, last: c.state().acc.a1.lastUid });
    r = await c.run();
    ok(r.sent === 1 && r.uncertain === 0 && (await subjects(c.tx)).slice(-1)[0] === 'FW: s3', '…다음 실행에서 그 메일을 보낸다', { sent: r.sent, uncertain: r.uncertain });
  }

  console.log('\n[15] 기준 다시 잡기');
  {
    const old = new Date(Date.now() - HOUR);
    const c = setup(one([msgOf(1000, rawOf({ subject: 'old', date: old }), { date: old })]));
    await c.run();
    const okAt = c.state().acc.a1.okAt;
    // 서버가 UID 를 새로 매겼다(서버 이전·재구성) — 거슬러 보지 않고 «지금부터». 받은 시각(INTERNALDATE)을 옮긴 때로 다시 매기는
    // 서버면 몇 해 전 메일도 «okAt 뒤»로 보여 받은편지함 전체가 나간다
    await sleep(5);
    const box = c.box();
    box.uidValidity = V + 7n;
    box.msgs = [{ ...msgOf(1, rawOf({ subject: 'old-renumbered', date: old }), { date: old }), flags: new Set(), labels: new Set() }];
    box.hiUid = 1;
    for (let i = 0; i < 40; i++) c.add(2 + i, rawOf({ subject: `restamped-${i}`, date: new Date(Date.now() - 400 * DAY) }), { date: new Date(okAt + 1000) });
    let r = await c.run();
    ok(r.seeded === 1 && r.sent === 0 && r.more === false && c.state().acc.a1.lastUid === 41
      && r.errors.some((e) => /메일 번호를 새로 매겨 지금부터 다시 셉니다/.test(e)), 'UIDVALIDITY 가 바뀌면 지금부터 (받은 시각을 다시 매긴 옛 메일 40통도 0통) — 그 사이 빠졌을 수 있음을 알린다', { sent: r.sent, errors: r.errors });
    c.add(44, rawOf({ subject: 'after-renumber' }));
    r = await c.run();
    ok(r.sent === 1 && (await subjects(c.tx))[0] === 'FW: after-renumber', '…그 뒤 온 메일은 보낸다', await subjects(c.tx));
    // since 가 바뀌면 (다시 켬) 그 때부터
    c.since = { a1: Date.now() + 60_000 };
    c.add(47, rawOf({ subject: 'before-new-since' }));
    r = await c.run();
    ok(r.seeded === 1 && r.sent === 0, 'since 가 바뀌면 기준을 다시 잡고 그 전 메일은 보내지 않는다', { seeded: r.seeded, sent: r.sent });
    // 아이디·폴더가 바뀌면 (who) 지금부터
    c.add(50, rawOf({ subject: 'before-user-change' }));
    r = await c.run([{ ...A1, user: 'A1-new@corp.example' }]);
    ok(r.seeded === 1 && r.sent === 0 && c.state().acc.a1.lastUid === 50, '아이디가 바뀌면 지난 메일은 보내지 않는다', c.state().acc.a1.lastUid);
    // keep 밖의 계정 기록은 지운다
    const st = c.state();
    st.acc.zz = { ...st.acc.a1 };
    st.day.n.zz = 3;
    c.writeState(st);
    await c.run([{ ...A1, user: 'A1-new@corp.example' }], { keep: ['a1'] });
    ok(!c.state().acc.zz && c.state().day.n.zz === undefined && !!c.state().acc.a1, 'keep 밖의 계정 기록(acc·day)은 지운다', Object.keys(c.state().acc));
  }

  console.log('\n[16] 하루 한도');
  {
    const c = setup(one([]));
    await c.run();
    for (let i = 0; i < 5; i++) c.add(1000 + i * 3, rawOf({ subject: `d${i}` }));
    let r = await c.run({ dayMax: 3 });
    ok(r.sent === 3 && r.capped === 1 && r.more === false, '하루 3명 — 3통 보내고 capped 1 («나머지는 다음에»로 60초마다 다시 붙지 않는다)', { sent: r.sent, capped: r.capped, more: r.more });
    r = await c.run({ dayMax: 3 });
    ok(r.sent === 0 && r.capped === 1, '같은 날 다시 돌리면 0통', r.sent);
    r = await c.run({ dayMax: 3, now: () => Date.now() + DAY });
    ok(r.sent === 2 && r.capped === 0, '다음 날이면 나머지 2통', r.sent);
  }

  console.log('\n[17] 읽기 전용');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'ro' }));
    await c.run();
    const opens = c.server.log.filter((e) => e.cmd === 'mailboxOpen');
    ok(opens.length >= 2 && opens.every((e) => e.readOnly), 'mailboxOpen 은 늘 readOnly', opens.map((e) => e.readOnly));
    ok(c.server.forbidden().length === 0, '금지 명령(지우기·복사·플래그)을 부르지 않았다');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mailfwd.js'), 'utf8');
    ok(!/appendToSent|messageFlagsAdd|messageMove|messageDelete/.test(src), '소스에 appendToSent·messageFlagsAdd·messageMove 가 없다');
  }

  console.log('\n[18] 봉투·머리글·주소 가리기·연결 이어 쓰기');
  {
    const c = setup(one([]), { to: ['me@gmail.com', 'ai@example.org'] });
    await c.run([{ ...A1, fromName: '김\r\n대리' }]);
    c.add(1000, rawOf({ subject: 'env', extra: ['Reply-To: other@corp.example'] }));
    await c.run([{ ...A1, fromName: '김\r\n대리' }]);
    const s = c.tx.sent[0];
    const tok = c.state().tok;
    const p = await parse(s.raw);
    ok(s.envelope.from === 'a1@corp.example' && JSON.stringify(s.envelope.to) === '["me@gmail.com","ai@example.org"]', '봉투 from 은 그 계정 주소, to 는 받는 주소들', s.envelope);
    ok(p.from.value[0].address === 'a1@corp.example' && p.from.value[0].name === '김 대리' && p.headers.get('x-hibi-forwarded') === tok
      && p.headers.get('auto-submitted') === 'auto-forwarded' && p.messageId.startsWith(`<hibi-fwd.${tok}.`) && !p.replyTo && !p.inReplyTo,
    'From·X-Hibi-Forwarded: <tok>·Auto-Submitted: auto-forwarded·Message-ID <hibi-fwd.<tok>.…> 가 있고 Reply-To·In-Reply-To 는 없다', { mid: p.messageId, tok });
    allErrors.push(...c.errs);
    const sendSrc = fs.readFileSync(path.join(ROOT, 'src', 'send.js'), 'utf8');
    ok(/function transportFor\(account, \{ pool = false, logger = null \} = \{\}\)/.test(sendSrc) && /pool: true, maxConnections: 1/.test(sendSrc)
      && /module\.exports = \{[^}]*transportFor/.test(sendSrc), 'send.transportFor 를 내보내고, pool 이면 연결 하나를 이어 쓴다 (maxConnections: 1)');
    const fwdSrc = fs.readFileSync(path.join(ROOT, 'src', 'mailfwd.js'), 'utf8');
    ok(/send\.transportFor\(acc, \{ pool: true, logger \}\)/.test(fwdSrc), '…자동 전달의 기본 전송이 pool (원문을 다 넘겼는지 알아볼 logger 를 싣는다)');
    const tr = require(path.join(ROOT, 'src', 'send.js')).transportFor({ ...A1, pass: 'x' }, { pool: true });
    ok(tr.transporter && tr.transporter.name === 'SMTP (pool)' && tr.transporter.options.maxConnections === 1, '…실제로 만든 전송도 SMTP pool · maxConnections 1 (연결은 하지 않는다)', tr.transporter && tr.transporter.name);
    tr.close();
  }

  console.log('\n[19] 원문을 끝까지 넘긴 뒤 답 없이 끊김 — «확인 안 됨», 다시 보내지 않는다');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'av-slow' }));
    c.add(1003, rawOf({ subject: 'av-next' }));
    // 회사 중계 서버가 큰 첨부를 검사하느라 «.» 뒤 250 을 60초 안에 못 준다 — nodemailer 는 연결 실패와 같은 ETIMEDOUT·CONN 으로 던진다.
    // 원문을 끝까지 넘겼다는 표시(logger.info tnx:'message')만 다르다
    c.tx.fail = (raw) => {
      if (!/av-slow/.test(raw.toString('latin1'))) return null;
      c.tx.logger.info({ tnx: 'message', outByteCount: raw.length }, '<%s bytes>', raw.length);
      return smtpErr('Timeout', { code: 'ETIMEDOUT', command: 'CONN' });
    };
    let r = await c.run();
    const st = c.state();
    ok(r.sent === 0 && r.uncertain === 1 && st.acc.a1.lastUid === 1000 && !st.pending && !st.acc.a1.strike && st.day.n.a1 === 1
      && r.notes.some((e) => /1통은 보냈는지 확인하지 못해 다시 보내지 않음/.test(e)) && !r.errors.length,
    '«.» 뒤 시간 초과 — «확인 안 됨» 1통, lastUid 를 올리고 하루 수에도 센다 (실패·«연결하지 못했습니다»가 아니다)', { uncertain: r.uncertain, last: st.acc.a1.lastUid, day: st.day.n, notes: r.notes, errors: r.errors });
    for (let i = 0; i < 4; i++) r = await c.run();
    const tries = c.tx.tries.filter((t) => /av-slow/.test(t.raw.toString('latin1'))).length;
    ok(tries === 1 && (await subjects(c.tx)).includes('FW: av-next'), '…다섯 번 돌려도 그 메일은 한 번만 보냈고(중복 없음) 뒤 메일은 간다', { tries, sent: await subjects(c.tx) });
    // 원문을 넘기기 전의 연결 실패(접속 거부·인사 시간 초과)는 안 나간 것이다 — 계정 탓으로 두고 서버가 살아나면 보낸다
    c.add(1006, rawOf({ subject: 'conn-down' }));
    let downs = 3;
    c.tx.fail = () => (downs-- > 0 ? smtpErr('connect ECONNREFUSED', { code: 'ECONNECTION', command: 'CONN' }) : null);
    r = await c.run();
    ok(r.sent === 0 && r.uncertain === 0 && r.failedAccounts === 1 && c.state().acc.a1.lastUid === 1003 && !c.state().acc.a1.strike
      && r.errors.some((e) => /보내는 서버에 연결하지 못했습니다/.test(e)), '원문을 넘기기 전의 연결 실패 — 계정 탓, lastUid 그대로, strike 없음', { last: c.state().acc.a1.lastUid, errors: r.errors });
    await c.run();
    await c.run();
    r = await c.run();
    ok(r.sent === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: conn-down', '…세 번 넘게 실패해도 버리지 않고, 살아나면 보낸다', await subjects(c.tx));
    c.tx.fail = null;
  }

  console.log('\n[20] «사라진 메일»은 확인했을 때만');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'nosrc' }), { noSource: true });
    c.add(1003, rawOf({ subject: 'after-nosrc' }));
    let r = await c.run();
    ok(r.sent === 0 && r.skips.gone === 0 && c.state().acc.a1.lastUid < 1000 && c.state().acc.a1.strike && c.state().acc.a1.strike.n === 1
      && r.errors.some((e) => /한 통을 보내지 못함 \(1\/3\) — 원문을 받지 못했습니다/.test(e)), '서버에 있는데 원문(BODY[])이 안 오면 «사라진 메일»이 아니다 — lastUid 그대로, (1/3)', { skips: r.skips, errors: r.errors });
    c.box().msgs.find((m) => m.uid === 1000).noSource = false;
    r = await c.run();
    ok(r.sent === 2 && JSON.stringify(await subjects(c.tx)) === '["FW: nosrc","FW: after-nosrc"]', '…서버가 원문을 주면 보낸다 (영영 빠지지 않는다)', await subjects(c.tx));
    // 원문이 끝내 안 오면 세 번째에 건너뛴다 — 계정이 영영 멈추지 않게
    c.add(1006, rawOf({ subject: 'never' }), { noSource: true });
    c.add(1009, rawOf({ subject: 'after-never' }));
    for (let i = 0; i < 3; i++) r = await c.run();
    ok(r.skips.strike === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: after-never', '…끝내 안 오면 세 번째에 그 메일만 건너뛴다', r.skips);

    // 정리 기록(tidy-moved.json)이 깨졌다 — 정리가 옮긴 메일을 «사라진 메일»로 버리지 않는다
    const bd = path.join(TMP, 'backup20');
    fs.mkdirSync(bd, { recursive: true });
    const accKey = mailbackup.accountKey(A1);
    fs.writeFileSync(path.join(bd, 'backup-state.json'), JSON.stringify({ [accKey]: { INBOX: { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 99999 } } }));
    const bx = mailbackup.boxDirFor(bd, A1, 'INBOX', 1);
    fs.mkdirSync(bx, { recursive: true });
    const c2 = setup(one([]));
    await c2.run({ backupDir: bd, backupOn: true });
    const m1 = rawOf({ subject: 'tidied-20' });
    fs.writeFileSync(path.join(bx, '20261020_0900_2001_x.eml'), Buffer.from(m1, 'latin1'));
    const sh = mailtidy.headerFields(m1, { whole: true });
    const key = mailtidy.movedKey(accKey, 'INBOX', mailtidy.recoverId({ envelope: { messageId: sh['message-id'] }, size: Buffer.byteLength(m1, 'latin1') }, sh));
    c2.add(2001, m1);
    c2.add(2004, rawOf({ subject: 'srv-20' }));
    c2.box().msgs = c2.box().msgs.filter((m) => m.uid !== 2001);
    fs.writeFileSync(path.join(bd, mailtidy.MOVED_FILE), '{"v":1,"keys":["');
    r = await c2.run({ backupDir: bd, backupOn: true });
    ok(r.sent === 0 && r.skips.gone === 0 && c2.state().acc.a1.lastUid < 2001 && r.errors.some((e) => /정리 기록\(tidy-moved\.json\)을 읽지 못해/.test(e)),
      '정리 기록이 깨져 있으면 파일만 있는 메일을 «사라진 메일»로 건너뛰지 않는다 — lastUid 그대로', { skips: r.skips, last: c2.state().acc.a1.lastUid, errors: r.errors });
    fs.writeFileSync(path.join(bd, mailtidy.MOVED_FILE), JSON.stringify({ v: 1, keys: [key] }));
    r = await c2.run({ backupDir: bd, backupOn: true });
    ok(r.sent === 2 && JSON.stringify(await subjects(c2.tx)) === '["FW: tidied-20","FW: srv-20"]', '…기록이 고쳐지면 파일로 보낸다', await subjects(c2.tx));
  }

  console.log('\n[21] 메일 하나의 원문 FETCH 를 서버가 거절');
  {
    const c = setup(one([]));
    await c.run();
    for (let i = 0; i < 7; i++) c.add(1000 + i * 3, rawOf({ subject: `f${i}` }), { fetchNo: i === 2 });
    let r = await c.run();
    const s1 = await subjects(c.tx);
    ok(JSON.stringify(s1) === '["FW: f0","FW: f1"]' && r.failedAccounts === 0 && r.more === false
      && c.state().acc.a1.strike && c.state().acc.a1.strike.uid === 1006 && c.state().acc.a1.strike.n === 1,
    '묶음 FETCH 가 거절돼도 한 통씩 다시 받아 앞 메일은 보내고, 거절된 메일에서 (1/3) 으로 멈춘다 (계정 실패·60초 이어 보내기 아님)', { s1, more: r.more, strike: c.state().acc.a1.strike, errors: r.errors });
    await c.run();
    r = await c.run();
    const s3 = await subjects(c.tx);
    ok(r.skips.strike === 1 && s3.length === 6 && !s3.includes('FW: f2') && c.state().acc.a1.lastUid === 1018,
      '…세 번째에 그 메일만 건너뛰고 나머지는 보낸다 (계정이 영영 멈추지 않는다)', { s3, last: c.state().acc.a1.lastUid });
  }

  console.log('\n[22] 전달 기록을 잠깐 못 읽음 (EBUSY)');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'b1' }));
    await c.run();
    const before = JSON.stringify(c.state());
    c.add(1003, rawOf({ subject: 'b2' }));
    const realRead = fs.readFileSync;
    let busy = 1;
    fs.readFileSync = function readBusy(p, ...rest) {
      if (busy > 0 && String(p).endsWith(mailfwd.STATE_FILE)) {
        busy -= 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
      }
      return realRead.call(this, p, ...rest);
    };
    let r;
    try { r = await c.run(); } finally { fs.readFileSync = realRead; }
    ok(r.sent === 0 && r.reset === false && r.seeded === 0 && JSON.stringify(c.state()) === before
      && r.errors.some((e) => /전달 기록\(mail-forward\.json\)을 읽지 못해 이번에는 쉽니다/.test(e)),
    '읽기가 잠깐 막히면(EBUSY) reset 하지 않고 이번만 쉰다 — 기록(lastUid·중복 열쇠)을 덮어쓰지 않는다', { reset: r.reset, errors: r.errors });
    r = await c.run();
    ok(r.sent === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: b2' && r.reset === false, '…다음 실행에 그 사이 온 메일을 보낸다', await subjects(c.tx));
  }

  console.log('\n[23] 몫 안에서 받은 것은 보낸다');
  {
    const c = setup(one([]));
    await c.run();
    for (let i = 0; i < 12; i++) c.add(1000 + i * 3, rawOf({ subject: `l${String(i).padStart(2, '0')}` }));
    // 느린 서버 — FETCH 마다 350ms. 몫 1000ms 중 받기는 600ms 까지 — 받은 5통은 남은 시간에 보낸다
    c.server.spec.a1.delay = { fetch: 350 };
    let r = await c.run({ budgetMs: 1000, accountMinMs: 100 });
    c.server.spec.a1.delay = undefined;
    const n1 = c.tx.sent.length;
    ok(n1 >= 1 && r.more === true && (await subjects(c.tx))[0] === 'FW: l00', '받기에 몫을 다 쓰지 않는다 — 받은 원문은 그 실행에 보내고 «나머지는 다음에»', { sent: n1, more: r.more, notes: r.notes });
    r = await c.run();
    ok(c.tx.sent.length === 12 && (await subjects(c.tx))[11] === 'FW: l11', '…다음 실행에 나머지', c.tx.sent.length);
  }

  console.log('\n[24] 켠 뒤 받은편지함으로 옮겨 오거나 되찾은 옛 메일');
  {
    const t = Date.now() - HOUR;
    const preRaw = rawOf({ subject: 'pre', date: new Date(t - DAY) });
    const c = setup(one([msgOf(1000, preRaw, { date: new Date(t - DAY) })]), { since: { a1: t } });
    let r = await c.run();
    ok(r.seeded === 1 && r.sent === 0, '(기준 — 켜기 전 메일 1통)');
    const twoY = new Date(Date.now() - 730 * DAY);
    c.add(1010, rawOf({ subject: 'moved-in-2y', date: twoY }), { date: twoY });
    c.add(1013, rawOf({ subject: 'fresh' }));
    r = await c.run();
    ok(r.skips.old === 1 && JSON.stringify(await subjects(c.tx)) === '["FW: fresh"]', '기준을 잡은 뒤 새 UID 로 들어온 옛 메일(받은 시각 2년 전)은 «켜기 전 메일»로 건너뛴다', { skips: r.skips, sent: await subjects(c.tx) });
    // 서버 정리 → 휴지통 → 되찾기: 켜기 전에 있던 메일이 같은 원문·같은 받은 시각으로 새 UID 를 받는다 (한 번도 안 보낸 메일)
    c.add(1016, preRaw, { date: new Date(t - DAY) });
    r = await c.run();
    ok(r.skips.old === 1 && r.sent === 0 && !(await subjects(c.tx)).includes('FW: pre'), '켜기 전 메일을 휴지통에서 되찾아 새 UID 를 받아도 보내지 않는다', r.skips);
    // 서버 시계가 몇 분 늦다 — «켠 때»보다 조금(10분 안) 이른 받은 시각은 보낸다
    c.add(1019, rawOf({ subject: 'skew' }), { date: new Date(t - 3 * 60_000) });
    r = await c.run();
    ok(r.sent === 1 && (await subjects(c.tx)).slice(-1)[0] === 'FW: skew', '…서버 시계가 몇 분 늦은 메일(켠 때 −3분)은 보낸다', r.skips);
    // floor 가 없는 계정 (켠 지 오래 — 맨 위부터 잡음)
    const c2 = setup(one([]), { since: { a1: Date.now() - 4 * DAY } });
    await c2.run();
    c2.add(1000, rawOf({ subject: 'moved-in-old', date: twoY }), { date: twoY });
    c2.add(1003, rawOf({ subject: 'fresh2' }));
    r = await c2.run();
    ok(r.skips.old === 1 && JSON.stringify(await subjects(c2.tx)) === '["FW: fresh2"]', 'floor 가 없어도(켠 지 오래) 받은 시각이 «켠 때»보다 이르면 건너뛴다', { skips: r.skips, sent: await subjects(c2.tx) });
  }

  console.log('\n[25] 보내는 서버가 답 없이 멈춤 (pool 이 인사 전에 끊긴 연결에서 멈추는 것)');
  {
    const c = setup(one([]));
    await c.run();
    c.add(1000, rawOf({ subject: 'stuck' }));
    // close() 로도 풀리지 않는 멈춤 — 진짜 pool 전송이 그랬다
    c.tx.hold = true;
    const close0 = c.tx.close;
    c.tx.close = () => { c.tx.closed += 1; };
    const t0 = Date.now();
    let r = await c.run({ sendHangMs: 300 });
    const ms = Date.now() - t0;
    const st = c.state();
    ok(ms < 5000 && r.sent === 0 && c.tx.closed >= 1, '정해 둔 시간이 지나면 전송을 닫고 그 실행을 끝낸다 (상한까지 붙잡히지 않는다)', { ms, sent: r.sent, closed: c.tx.closed });
    ok(!st.pending && JSON.stringify(st.sent || []) === '[]', '…원문을 넘기기 전이라 «안 나감» — 보냈다고 적지 않는다', { pending: st.pending, sent: st.sent });
    // 서버가 돌아오면 다음 실행에 보낸다
    c.tx.hold = false;
    c.tx.close = close0;
    r = await c.run();
    ok(r.sent === 1 && JSON.stringify(await subjects(c.tx)) === '["FW: stuck"]', '…다음 실행에 다시 보낸다', { sent: r.sent, subjects: await subjects(c.tx) });
  }

  // 모든 시험의 오류 줄에 가려지지 않은 주소가 없다
  const errs = [...allErrors];
  ok(!errs.some((e) => /[^\s•]@[^\s•]/.test(e)), '오류 줄에 가려지지 않은 주소가 없다', errs.filter((e) => /[^\s•]@[^\s•]/.test(e)));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

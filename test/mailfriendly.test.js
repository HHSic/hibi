'use strict';
// 메일 오류 문구 — imapflow 가 실제로 던지는 모양에서 서버의 까닭을 읽어 한국어로 말하는가 (src/mail.js friendly).
//
// imapflow 의 tagged NO/BAD 오류는 message 가 늘 'Command failed' 다. 서버 글은 responseText 와 serverResponseCode 에만 있다.
// 창도 Electron 도 쓰지 않는다. 서버에 붙지 않는다 — 오류 객체만 만들어 넘긴다.
//   [1] 로그인 거절   [2] 계정 전체의 거절 (웹 로그인·동시 연결·하루 한도·속도 제한·IMAP 꺼짐)
//   [3] 그 밖의 서버 거절   [4] 원래 문구는 그대로   [5] 연결의 경고 받기 (MOVE·COPY 거절 까닭)
//   [6] 사람이 누른 단추·연결 시험에도 쓰는 문구라 «다시 합니다» 같은 약속을 하지 않는다 · Gmail 의 옛 웹 로그인 거절
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src', 'mail.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 30_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

/** imapflow 의 tagged NO 와 같은 모양 */
const no = (responseText, serverResponseCode, extra = {}) => Object.assign(new Error('Command failed'), {
  responseStatus: 'NO', ...(responseText ? { responseText } : {}), ...(serverResponseCode ? { serverResponseCode } : {}), ...extra
});
const LOGIN = '로그인이 거절됐습니다 — 평소 비밀번호가 아닌 앱 비밀번호를 넣으세요';

console.log('\n[1] 로그인 거절');
{
  const f = mail.friendly(no('Invalid credentials (Failure)', 'AUTHENTICATIONFAILED', { authenticationFailed: true }));
  ok(f === LOGIN, 'NO [AUTHENTICATIONFAILED] Invalid credentials', f);
  const f2 = mail.friendly(no('Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)', 'ALERT', { authenticationFailed: true }));
  ok(f2 === LOGIN, 'NO [ALERT] Application-specific password required — 하루 한도가 아니라 로그인 거절', f2);
  const f3 = mail.friendly(no('LOGIN failed.', null, { authenticationFailed: true }));
  ok(f3 === LOGIN, 'NO LOGIN failed. (응답 코드 없음)', f3);
  ok(mail.friendly(new Error('AUTHENTICATIONFAILED Invalid credentials (Failure)')) === LOGIN, '(옛 모양) message 에 든 글도 그대로');
}

console.log('\n[2] 계정 전체의 거절');
{
  const cases = [
    [no('Web login required: https://support.google.com/mail/answer/78754 (Failure)', 'WEBALERT https://accounts.google.com/signin/continue?sarp=1', { authenticationFailed: true }),
      /^서버가 웹에서 먼저 로그인하라고 합니다/, 'WEBALERT'],
    [no('Too many simultaneous connections. (Failure)', 'ALERT', { authenticationFailed: true }), /^동시 연결이 너무 많습니다/, 'Too many simultaneous connections'],
    [no('Account exceeded command or bandwidth limits. (Failure)', 'ALERT'), /^메일 서버의 하루 사용량 한도를 넘었습니다/, 'Account exceeded command or bandwidth limits'],
    [no('System busy, try again', 'THROTTLED'), /^서버가 잠시 속도를 제한했습니다/, 'THROTTLED'],
    [no('Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)', 'ALERT', { authenticationFailed: true }),
      /^IMAP을 쓸 수 없습니다 — 메일 설정에서 IMAP을 켜세요$/, 'not enabled for IMAP']
  ];
  for (const [e, re, name] of cases) {
    const f = mail.friendly(e);
    ok(re.test(f), name, f);
    ok(!/https?:|Failure/.test(f), '…주소·영어 원문은 싣지 않는다', f);
  }
}

console.log('\n[3] 그 밖의 서버 거절 — 서버 글을 붙인다 (주소는 가린다)');
{
  const f = mail.friendly(no('Mailbox is over quota'));
  ok(f === '서버가 거절했습니다 — Mailbox is over quota', '응답 글을 붙인다', f);
  const long = mail.friendly(no(`Rejected for kim@corp.example ${'x'.repeat(300)}`, 'CANNOT'));
  ok(long.startsWith('서버가 거절했습니다 — ') && long.length <= 120 && !long.includes('kim@corp.example') && long.includes('•••@•••'), '…길면 자르고 주소는 가린다', long);
  ok(mail.friendly(no(null, 'NONEXISTENT')) === '서버가 거절했습니다 — NONEXISTENT', '응답 글이 없으면 코드라도', mail.friendly(no(null, 'NONEXISTENT')));
  ok(mail.friendly(Object.assign(new Error('Command failed'), { responseStatus: 'NO' })) === 'Command failed', '아무것도 없으면 그대로 (지금과 같다)');
}

console.log('\n[4] 원래 문구는 그대로');
{
  ok(mail.friendly(new Error('getaddrinfo ENOTFOUND imap.x.invalid')) === '서버 주소를 찾을 수 없습니다', 'ENOTFOUND');
  ok(mail.friendly(new Error('connect ECONNREFUSED 127.0.0.1:1')) === '연결이 거부되었습니다 — 포트를 확인하세요', 'ECONNREFUSED');
  ok(mail.friendly(new Error('Failed to receive greeting from server in required time')) === '서버가 IMAP으로 응답하지 않습니다 — 받는 서버 주소와 포트(993)를 확인하세요', 'greeting');
  ok(mail.friendly(Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })) === '서버가 응답하지 않습니다', 'timeout');
  ok(mail.friendly(new Error('self signed certificate')) === '서버 인증서를 확인할 수 없습니다', 'certificate');
  ok(mail.friendly('그냥 글') === '그냥 글' && mail.friendly(null) === 'null', '글·null 도 던지지 않는다');
  ok(mail.friendly(new Error('서버가 옮기기를 거부했습니다')) === '서버가 옮기기를 거부했습니다', '우리 한국어 문구는 그대로');
}

console.log('\n[5] 연결의 경고 받기 — imapflow 가 log.warn 으로만 남기는 서버 글을 연결에 붙여 둔다');
{
  const holder = {};
  const lg = mail.warnCatcher(holder);
  ok(['trace', 'debug', 'info', 'warn', 'error', 'fatal'].every((k) => typeof lg[k] === 'function'), '모든 수준이 함수다 (빠지면 imapflow 가 console 에 찍는다)');
  holder.client = {};
  lg.debug({ msg: 'C: LOGIN', err: new Error('x') });
  lg.info({ msg: 'connected' });
  ok(holder.client.lastWarn === undefined, '…debug·info 는 버린다');
  const err = no('Too many commands', 'THROTTLED');
  lg.warn({ err, cid: 'c1' });
  ok(holder.client.lastWarn === err, '…warn 의 err 를 lastWarn 에 둔다');
  lg.warn({ msg: '오류 없음' });
  ok(holder.client.lastWarn === err, '…err 가 없는 warn 은 지우지 않는다');
  const c = mail.connect({ id: 'w1', host: '127.0.0.1', port: 1, user: 'u', pass: 'fake' });
  ok(c.options && typeof c.options.logger === 'object' && typeof c.options.logger.warn === 'function', 'mail.connect 가 그 받개를 건다 (연결은 하지 않는다)', c.options && typeof c.options.logger);
  c.options.logger.warn({ err });
  ok(c.lastWarn === err, '…그 연결의 lastWarn 에 붙는다');
  try { c.close(); } catch { /* 연결하지 않았다 */ }
}

console.log('\n[6] 약속하지 않는 문구 · Gmail 옛 웹 로그인 거절');
{
  // 휴지통 단추·연결 시험·메일 열기는 다시 하지 않는다 — 자동 일(정리·받기)은 각자 «n분 뒤 다시 합니다»를 붙인다
  const words = [no('Too many simultaneous connections. (Failure)', 'ALERT', { authenticationFailed: true }), no('System busy, try again', 'THROTTLED')]
    .map((e) => mail.friendly(e));
  ok(words.every((w) => !/다시 합니다|다음 차례/.test(w)) && /^동시 연결이 너무 많습니다 — 폰·다른 메일 프로그램도 연결을 씁니다$/.test(words[0])
    && words[1] === '서버가 잠시 속도를 제한했습니다', '동시 연결·속도 제한 — 주어 없는 사실만 (거짓 약속 없음)', words);
  const web = mail.friendly(no('Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)', 'ALERT', { authenticationFailed: true }));
  ok(/^서버가 웹에서 먼저 로그인하라고 합니다/.test(web) && !/Please|https?:/.test(web), 'Please log in via your web browser — 영어 원문 대신 한국어', web);
  const web2 = mail.friendly(no('Please log in via your web browser and then try again.', null, { authenticationFailed: true }));
  ok(/^서버가 웹에서 먼저 로그인하라고 합니다/.test(web2), '…응답 코드가 없어도', web2);
}

console.log(bad ? `\n실패 ${bad}` : '\n모두 통과');
process.exit(bad ? 1 : 0);

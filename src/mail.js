'use strict';
/**
 * 메일 — IMAP으로 "안 읽은 메일이 몇 통이고 무슨 제목인지"만 읽는다.
 *
 * 본문은 받지 않는다. 목적이 알림이지 메일 클라이언트가 아니고,
 * 본문까지 받으면 느려지고 저장할 것도 늘어난다. (백업은 별개 기능으로 둔다)
 *
 * OAuth를 쓰지 않는 이유는 캘린더와 같다 — 이카운트·네이버·다음은 아이디/비밀번호
 * IMAP을 그대로 제공한다. Gmail만 언젠가 OAuth가 필요해진다.
 */
const { ImapFlow } = require('imapflow');

const CONNECT_TIMEOUT_MS = 20_000;
const MAX_PREVIEW = 10;          // 제목을 몇 개까지 들고 올지

/** 제공자별 서버 — 사용자가 서버 주소를 몰라도 되게 */
const PRESETS = [
  { id: 'ecount', name: '이카운트', host: '', port: 993, help: '',
    note: '서버 주소는 이카운트 웹메일 → 환경설정 → IMAP 동기화에서 확인하세요' },
  { id: 'naver', name: '네이버', host: 'imap.naver.com', port: 993,
    help: 'https://nid.naver.com/user2/help/myInfo',
    note: '2단계 인증을 켜고 애플리케이션 비밀번호를 발급해 넣으세요' },
  { id: 'gmail', name: 'Gmail', host: 'imap.gmail.com', port: 993,
    help: 'https://myaccount.google.com/apppasswords',
    note: '2단계 인증을 켠 뒤 앱 비밀번호를 발급해 넣으세요' },
  { id: 'daum', name: '다음', host: 'imap.daum.net', port: 993,
    help: 'https://cs.daum.net/faq/43/9234.html',
    note: '메일 설정에서 IMAP 사용을 먼저 켜세요' },
  { id: 'kakao', name: '카카오', host: 'imap.kakao.com', port: 993,
    help: 'https://cs.kakao.com/helps_html/1073195244',
    note: '카카오메일 설정에서 IMAP을 켜고 앱 비밀번호를 쓰세요' },
  { id: 'icloud', name: 'iCloud', host: 'imap.mail.me.com', port: 993,
    help: 'https://account.apple.com/account/manage',
    note: '앱 암호를 발급해 넣으세요' },
  { id: 'custom', name: '직접 입력', host: '', port: 993, help: '', note: '' }
];

function preset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[PRESETS.length - 1];
}

/** 보낸 사람을 사람이 읽을 형태로 — "이름" 또는 주소 */
function senderOf(envelope) {
  const from = envelope && Array.isArray(envelope.from) ? envelope.from[0] : null;
  if (!from) return '';
  const name = String(from.name || '').trim();
  if (name) return name.slice(0, 40);
  return `${from.address || ''}`.slice(0, 40);
}

function connect(account) {
  return new ImapFlow({
    host: account.host,
    port: Number(account.port) || 993,
    secure: account.port === 143 ? false : true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    // 서버가 응답하지 않을 때 앱이 붙잡히지 않게
    socketTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    tls: { rejectUnauthorized: true }
  });
}

/**
 * 받은편지함의 안 읽은 메일 요약.
 * @returns { unread, total, messages: [{ uid, subject, from, at, seen }] }
 */
async function fetchSummary(account, { limit = MAX_PREVIEW } = {}) {
  const client = connect(account);
  await client.connect();
  try {
    const box = await client.mailboxOpen(account.mailbox || 'INBOX', { readOnly: true });
    const unseen = await client.search({ seen: false }, { uid: true });
    const uids = (unseen || []).slice(-limit).reverse();

    const messages = [];
    if (uids.length) {
      for await (const msg of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
        messages.push({
          uid: msg.uid,
          subject: String((msg.envelope && msg.envelope.subject) || '(제목 없음)').slice(0, 120),
          from: senderOf(msg.envelope),
          at: (msg.internalDate || new Date()).getTime()
        });
      }
      messages.sort((a, b) => b.at - a.at);
    }
    return { unread: (unseen || []).length, total: box.exists || 0, messages };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

/** 연결만 확인 — 설정 화면의 "연결 테스트" */
async function test(account) {
  try {
    const r = await fetchSummary(account, { limit: 1 });
    return { ok: true, message: `연결됨 · 안 읽은 메일 ${r.unread}통` };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}

/** IMAP 오류 문구는 그대로 보여주면 알아볼 수 없다 */
function friendly(e) {
  const raw = String((e && e.message) || e);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(raw)) {
    return '아이디 또는 비밀번호가 맞지 않습니다 (앱 비밀번호가 필요할 수 있어요)';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return '서버 주소를 찾을 수 없습니다';
  if (/ECONNREFUSED/i.test(raw)) return '연결이 거부되었습니다 (포트를 확인하세요)';
  if (/timeout|ETIMEDOUT/i.test(raw)) return '서버가 응답하지 않습니다';
  if (/certificate|self.signed/i.test(raw)) return '서버 인증서를 확인할 수 없습니다';
  if (/Command failed.*IMAP|not enabled|disabled/i.test(raw)) {
    return 'IMAP이 꺼져 있을 수 있습니다 (메일 설정에서 켜세요)';
  }
  return raw.slice(0, 120);
}

module.exports = { PRESETS, preset, fetchSummary, test, senderOf, friendly };

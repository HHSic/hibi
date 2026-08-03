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
 * 받은편지함 요약.
 * @param onlyUnread 안 읽은 것만 볼지, 최근 온 것을 모두 볼지
 * @param limit      제목을 몇 개까지 들고 올지
 * @returns { unread, total, messages: [{ uid, subject, from, at, seen }] }
 */
async function fetchSummary(account, { limit = MAX_PREVIEW, onlyUnread = true } = {}) {
  const take = Math.max(1, Math.min(MAX_PREVIEW, limit));
  const client = connect(account);
  await client.connect();
  try {
    const box = await client.mailboxOpen(account.mailbox || 'INBOX', { readOnly: true });
    // 안 읽은 수는 무엇을 보여주든 항상 필요하다 (뱃지에 쓰인다)
    const unseen = await client.search({ seen: false }, { uid: true }) || [];

    const messages = [];
    if (onlyUnread) {
      const uids = unseen.slice(-take).reverse();
      if (uids.length) await collect(client, uids, { uid: true }, messages);
    } else if (box.exists > 0) {
      // 최근 온 것 — 읽음 여부와 무관하게 마지막 N통
      const from = Math.max(1, box.exists - take + 1);
      await collect(client, `${from}:*`, {}, messages);
    }
    messages.sort((a, b) => b.at - a.at);
    return { unread: unseen.length, total: box.exists || 0, messages: messages.slice(0, take) };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

async function collect(client, range, opts, out) {
  for await (const msg of client.fetch(range, { envelope: true, internalDate: true, flags: true }, opts)) {
    const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags || []);
    out.push({
      uid: msg.uid,
      subject: String((msg.envelope && msg.envelope.subject) || '(제목 없음)').slice(0, 120),
      from: senderOf(msg.envelope),
      at: (msg.internalDate || new Date()).getTime(),
      // IMAP 플래그는 역슬래시로 시작한다 ('\Seen') — 소스에서는 두 번 써야 한다
      seen: flags.has('\\Seen')
    });
  }
}

/** HTML 메일을 글로 — 본문을 그대로 그리면 원격 이미지·스크립트가 따라온다 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 한 통의 본문을 글로만 가져오고, 원하면 읽음으로 표시한다.
 * HTML은 그대로 그리지 않는다 — 원격 이미지가 열람 사실을 알리고 스크립트가 딸려온다.
 * text/plain을 먼저 쓰고, 없을 때만 HTML에서 태그를 걷어낸다.
 */
async function fetchBody(account, uid, { markSeen = true, maxChars = 8000 } = {}) {
  const client = connect(account);
  await client.connect();
  try {
    await client.mailboxOpen(account.mailbox || 'INBOX', { readOnly: !markSeen });
    const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: true },
      { uid: true });
    if (!msg) throw new Error('메일을 찾을 수 없습니다');

    const raw = msg.source ? msg.source.toString('utf8') : '';
    let text = extractText(raw);
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n…(생략)';

    if (markSeen) {
      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch { /* 실패해도 본문은 보여준다 */ }
    }
    return {
      uid,
      subject: String((msg.envelope && msg.envelope.subject) || '(제목 없음)'),
      from: senderOf(msg.envelope),
      at: (msg.internalDate || new Date()).getTime(),
      text
    };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

/** 원문에서 사람이 읽을 부분만 — 전체 MIME 파서를 두지 않고 최소한으로 */
function extractText(raw) {
  if (!raw) return '';
  const parts = raw.split(/\r?\n\r?\n/);
  const body = parts.slice(1).join('\n\n');

  const boundary = (raw.match(/boundary="?([^"\s;]+)"?/i) || [])[1];
  if (!boundary) return decodePart(raw, body);

  const chunks = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  let plain = '';
  let html = '';
  for (const chunk of chunks) {
    if (!/content-type:/i.test(chunk)) continue;
    const head = chunk.split(/\r?\n\r?\n/)[0] || '';
    const rest = chunk.split(/\r?\n\r?\n/).slice(1).join('\n\n');
    if (/text\/plain/i.test(head) && !plain) plain = decodePart(head, rest);
    else if (/text\/html/i.test(head) && !html) html = decodePart(head, rest);
  }
  if (plain) return plain.trim();
  if (html) return htmlToText(html);
  return decodePart(raw, body);
}

/** base64 / quoted-printable 정도만 푼다 */
function decodePart(head, body) {
  const enc = (String(head).match(/content-transfer-encoding:\s*([\w-]+)/i) || [])[1] || '';
  const charset = (String(head).match(/charset="?([\w-]+)"?/i) || [])[1] || 'utf-8';
  let out = String(body || '');
  try {
    if (/base64/i.test(enc)) {
      out = Buffer.from(out.replace(/\s+/g, ''), 'base64')
        .toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
    } else if (/quoted-printable/i.test(enc)) {
      out = out.replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
      if (/utf-?8/i.test(charset)) out = Buffer.from(out, 'latin1').toString('utf8');
    }
  } catch { /* 못 풀면 원문 그대로 */ }
  return out;
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

module.exports = { PRESETS, preset, fetchSummary, fetchBody, test, senderOf, friendly, htmlToText, extractText };

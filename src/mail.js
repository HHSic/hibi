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
const { simpleParser } = require('mailparser');
const { cleanHtml } = require('./htmlclean');

const CONNECT_TIMEOUT_MS = 20_000;
// 플래그를 바꾸는 일은 통수만큼 오래 걸린다 — 읽기보다 넉넉히 준다
const WRITE_TIMEOUT_MS = 90_000;
// 한 번에 보낼 UID 개수. 수백 개를 한 줄에 실으면 느린 서버가 응답 전에 끊는다.
const FLAG_CHUNK = 100;
// 몇 통까지 들고 올지는 사용자가 정한다. 여기 상한은 실수로 수만 통을 부르는 걸 막는 안전장치일 뿐이다.
const PREVIEW_HARD_MAX = 500;

/** 제공자별 서버 — 사용자가 서버 주소를 몰라도 되게 */
const PRESETS = [
  { id: 'ecount', name: '이카운트', host: '', port: 993,
    smtpHost: '', smtpPort: 465, help: '',
    note: '서버 주소는 이카운트 웹메일 → 환경설정 → IMAP 동기화에서 확인하세요' },
  { id: 'naver', name: '네이버', host: 'imap.naver.com', port: 993,
    smtpHost: 'smtp.naver.com', smtpPort: 587,
    help: 'https://nid.naver.com/user2/help/myInfo',
    note: '2단계 인증을 켜고 애플리케이션 비밀번호를 발급해 넣으세요' },
  { id: 'gmail', name: 'Gmail', host: 'imap.gmail.com', port: 993,
    smtpHost: 'smtp.gmail.com', smtpPort: 465,
    help: 'https://myaccount.google.com/apppasswords',
    note: '2단계 인증을 켠 뒤 앱 비밀번호를 발급해 넣으세요' },
  { id: 'daum', name: '다음', host: 'imap.daum.net', port: 993,
    smtpHost: 'smtp.daum.net', smtpPort: 465,
    help: 'https://cs.daum.net/faq/43/9234.html',
    note: '메일 설정에서 IMAP 사용을 먼저 켜세요' },
  { id: 'kakao', name: '카카오', host: 'imap.kakao.com', port: 993,
    smtpHost: 'smtp.kakao.com', smtpPort: 465,
    help: 'https://cs.kakao.com/helps_html/1073195244',
    note: '카카오메일 설정에서 IMAP을 켜고 앱 비밀번호를 쓰세요' },
  { id: 'icloud', name: 'iCloud', host: 'imap.mail.me.com', port: 993,
    smtpHost: 'smtp.mail.me.com', smtpPort: 587,
    help: 'https://account.apple.com/account/manage',
    note: '앱 암호를 발급해 넣으세요' },
  { id: 'custom', name: '직접 입력', host: '', port: 993,
    smtpHost: '', smtpPort: 465, help: '', note: '' }
];

/**
 * 보내는 서버가 비어 있으면 받는 서버에서 유추한다.
 * imap.회사.com → smtp.회사.com 이 업계 관행이고, 아니면 같은 호스트를 쓴다.
 * 유추는 어디까지나 첫 시도일 뿐이라 설정에서 직접 고칠 수 있어야 한다.
 */
function smtpOf(account) {
  const host = String(account.smtpHost || '').trim()
    || String(account.host || '').replace(/^imaps?\./i, 'smtp.');
  const port = Number(account.smtpPort) || 465;
  return {
    host,
    port,
    // 465는 처음부터 TLS, 587·25는 접속한 뒤 STARTTLS로 올린다
    secure: port === 465
  };
}

/** 보내는 사람 주소 — 따로 적지 않았으면 로그인 아이디가 주소인 경우가 대부분이다 */
function fromOf(account) {
  const addr = String(account.fromAddress || '').trim()
    || (/@/.test(account.user || '') ? account.user : '');
  const name = String(account.fromName || '').trim();
  return { address: addr, name };
}

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

function connect(account, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const client = new ImapFlow({
    host: account.host,
    port: Number(account.port) || 993,
    secure: account.port === 143 ? false : true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    // 서버가 응답하지 않을 때 앱이 붙잡히지 않게
    socketTimeout: timeoutMs,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    tls: { rejectUnauthorized: true }
  });

  // 소켓이 끊기거나 시간이 초과되면 ImapFlow는 'error' 이벤트를 낸다.
  // EventEmitter는 듣는 사람이 없는 'error'를 그냥 던져버린다 — 그러면 우리가 await하던
  // 자리가 아니라 아무도 잡지 않는 곳에서 터져 앱 전체가 죽는다 (실제로 죽었다).
  // 여기서 받아두면 정상적인 실패로 흘러가 화면에 사유가 뜬다.
  // 사유 자체는 await하던 쪽이 던지는 오류에 이미 들어 있으므로 여기서는 흘려보낸다 —
  // 듣는 사람이 있다는 것 자체가 목적이다.
  client.on('error', () => {});
  return client;
}

/**
 * 받은편지함 요약.
 * @param onlyUnread 안 읽은 것만 볼지, 최근 온 것을 모두 볼지
 * @param limit      제목을 몇 개까지 들고 올지
 * @returns { unread, total, messages: [{ uid, subject, from, at, seen }] }
 */
/**
 * @param box 'inbox'(기본) | 'sent' — 보낸메일함은 폴더 이름이 서버마다 달라 찾아서 연다.
 *   못 찾으면 받은편지함으로 슬쩍 넘어가지 않고 실패한다. 보낸 메일을 보러 왔는데
 *   받은 메일이 나오면 «보낸메일함이 원래 이런가»로 오해한다.
 */
async function fetchSummary(account, { limit = 5, onlyUnread = true, box: which = 'inbox' } = {}) {
  const take = Math.max(1, Math.min(PREVIEW_HARD_MAX, Math.round(limit) || 5));
  const client = connect(account);
  await client.connect();
  try {
    let path = account.mailbox || 'INBOX';
    if (which === 'sent') {
      const found = await findBox(client, 'sent');
      if (!found) throw new Error('보낸편지함을 찾지 못했습니다');
      path = found.path;
    }
    const box = await client.mailboxOpen(path, { readOnly: true });
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
    // 어느 폴더에서 왔는지 붙여 보낸다 — 나중에 이 메일을 열 때 그 폴더를 다시 열어야 한다
    for (const m of messages) m.mailbox = path;
    return {
      unread: unseen.length, total: box.exists || 0, mailbox: path,
      messages: messages.slice(0, take)
    };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

/**
 * 읽음으로 표시한다 (본문은 가져오지 않는다).
 * 열어보지 않고 뱃지만 지우고 싶을 때가 있다 — 광고 메일이 대표적이다.
 * @param uids 비우면 안 읽은 것 전부
 */
async function markRead(account, uids, { read = true } = {}) {
  // 여러 통을 한 번에 바꾸는 일이라 읽기보다 오래 걸린다.
  // 20초로는 스무 통에서도 소켓이 끊겼다 (실제로 끊겼다).
  const client = connect(account, { timeoutMs: WRITE_TIMEOUT_MS });
  await client.connect();
  try {
    // 플래그를 바꿔야 하므로 읽기 전용으로 열면 안 된다
    const box = await client.mailboxOpen(account.mailbox || 'INBOX', { readOnly: false });

    // 서버가 «이 폴더에 영구 저장할 수 있는 플래그»를 알려준다. 거기에 \Seen도 \*도 없으면
    // 라이브러리가 STORE를 보내지도 않고 false를 돌려준다 — 원인을 정확히 알려주려고 미리 본다.
    const perm = box.permanentFlags instanceof Set
      ? [...box.permanentFlags]
      : (box.permanentFlags || []);
    const diag = {
      readOnly: !!box.readOnly,
      permanentFlags: perm,
      canSeen: !perm.length || perm.includes('\\*') || perm.includes('\\Seen')
    };

    const list = (uids && uids.length)
      ? uidList(uids)
      : (await client.search({ seen: !read }, { uid: true }) || []);
    if (!list.length) return { changed: 0, diag };

    // IMAP 플래그는 역슬래시로 시작한다 — 소스에서는 두 번 써야 한다
    // 서버가 false를 돌려주면 아무것도 안 바뀐 것이다 — 성공으로 셈하면 안 된다
    // 수백 개를 한 줄에 실으면 느린 서버가 응답 전에 소켓을 끊는다 — 나눠 보낸다
    let okFlag = true;
    for (let i = 0; i < list.length; i += FLAG_CHUNK) {
      const part = list.slice(i, i + FLAG_CHUNK);
      const r = read
        ? await client.messageFlagsAdd(part, ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(part, ['\\Seen'], { uid: true });
      if (r === false) { okFlag = false; break; }
    }
    if (okFlag === false) {
      // STORE를 거절하는 서버가 있다. 그때 남은 길이 하나 있다 —
      // 본문을 PEEK 없이 읽으면 서버가 스스로 \Seen을 붙인다 (RFC 3501에 정해진 동작).
      // imapflow는 언제나 BODY.PEEK을 쓰므로 이 명령만 직접 내려보낸다.
      // 읽음으로 바꾸는 게 목적이니 제일 작은 조각(HEADER)만 부른다.
      if (read) {
        const imapCommand = client.exec.bind(client);
        try {
          for (let i = 0; i < list.length; i += FLAG_CHUNK) {
            await imapCommand('UID FETCH', [
              { type: 'SEQUENCE', value: list.slice(i, i + FLAG_CHUNK).join(',') },
              { type: 'ATOM', value: 'BODY', section: [{ type: 'ATOM', value: 'HEADER' }] }
            ]);
          }
          // 정말 바뀌었는지 서버에 되물어본다 — 명령이 통했다고 다 되는 건 아니다
          const still = await client.search({ seen: false }, { uid: true }) || [];
          if (!list.some((u) => still.includes(u))) {
            return { changed: list.length, diag: { ...diag, via: 'fetch' } };
          }
        } catch { /* 이 길도 막혔으면 아래에서 사유를 알린다 */ }
      }
      const why = diag.readOnly ? '메일함이 읽기 전용으로 열렸습니다'
        : !diag.canSeen ? '이 서버는 읽음 상태를 저장하지 않습니다'
        : '서버가 명령을 거부했습니다';
      const e = new Error(`읽음 표시를 못 했습니다 — ${why}`);
      e.diag = diag;
      throw e;
    }
    return { changed: list.length, diag };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

/**
 * 스팸 폴더 찾기.
 * 이름은 서버마다 다르다. 용도 표시(\Junk)를 먼저 믿고, 없으면 흔한 이름으로 짐작한다.
 * 이카운트처럼 용도를 안 알려주는 서버가 있어서 이름 짐작이 실제로 필요하다.
 */
const BOX_NAMES = {
  junk: /^(junk|junk e-?mail|spam|bulk mail|스팸|스팸메일함|스팸 메일함|정크)$/i,
  sent: /^(sent|sent items|sent messages|sent mail|보낸편지함|보낸 편지함|보낸메일함|보낸 메일함)$/i
};
const BOX_USE = { junk: '\\Junk', sent: '\\Sent' };

/**
 * UID 목록 다듬기.
 * Number(null)과 Number('')은 0이고 0은 유한한 수다 — 그대로 두면 없는 메일 «0번»을
 * 서버에 들이밀게 된다. IMAP UID는 1부터 시작하는 정수다.
 */
function uidList(uids) {
  return (uids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * 용도별 폴더 찾기 — 이름은 서버마다 다르다.
 * 서버가 알려주는 용도 표시(\Sent, \Junk)를 먼저 믿고, 없으면 흔한 이름으로 짐작한다.
 * 이카운트처럼 용도를 안 알려주는 서버가 있어서 이름 짐작이 실제로 필요하다.
 * @param kind 'junk' | 'sent'
 */
async function findBox(client, kind) {
  const re = BOX_NAMES[kind];
  if (!re) return null;
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === BOX_USE[kind])
    || boxes.find((b) => re.test(b.name))
    // 하위 폴더로 둔 서버도 있다 (INBOX/보낸편지함)
    || boxes.find((b) => re.test(String(b.path).split(b.delimiter || '/').pop()))
    || null;
}

/** 예전 이름 — 부르는 곳이 있어 그대로 둔다 */
function findJunk(client) {
  return findBox(client, 'junk');
}

/**
 * 스팸 폴더로 옮긴다.
 *
 * 화면에서 숨기는 것과 다르다 — 서버에서 실제로 치우므로 웹메일에서도 사라지고,
 * 다음에 다시 안 내려온다. 그래서 «되돌릴 수 없는 일»에 가깝고, 규칙이 정확할 때만 쓴다.
 *
 * MOVE를 모르는 서버에서는 라이브러리가 알아서 복사 + 삭제표시 + 정리로 대신한다.
 */
async function moveToSpam(account, uids) {
  const list = uidList(uids);
  if (!list.length) return { moved: 0 };

  const client = connect(account, { timeoutMs: WRITE_TIMEOUT_MS });
  await client.connect();
  try {
    const junk = await findJunk(client);
    if (!junk) throw new Error('스팸 폴더를 찾지 못했습니다');
    const box = await client.mailboxOpen(account.mailbox || 'INBOX', { readOnly: false });
    if (box.path === junk.path) return { moved: 0, mailbox: junk.path };

    let moved = 0;
    for (let i = 0; i < list.length; i += FLAG_CHUNK) {
      const part = list.slice(i, i + FLAG_CHUNK);
      const r = await client.messageMove(part, junk.path, { uid: true });
      if (r === false) throw new Error('서버가 옮기기를 거부했습니다');
      moved += part.length;
    }
    return { moved, mailbox: junk.path };
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
      // 주소록은 여기서 자란다 — 받은 메일마다 «이름 ↔ 주소»가 한 쌍씩 들어 있다
      fromAddress: ((msg.envelope && msg.envelope.from && msg.envelope.from[0]) || {}).address || '',
      fromName: ((msg.envelope && msg.envelope.from && msg.envelope.from[0]) || {}).name || '',
      at: (msg.internalDate || new Date()).getTime(),
      // IMAP 플래그는 역슬래시로 시작한다 ('\Seen') — 소스에서는 두 번 써야 한다
      seen: flags.has('\\Seen')
    });
  }
}

/**
 * 한 통을 가져오고, 원하면 읽음으로 표시한다.
 *
 * MIME 파싱은 직접 하지 않는다. 한글 메일은 EUC-KR인 경우가 많은데 Node의 Buffer는
 * EUC-KR을 모르고, multipart·base64·quoted-printable·헤더 인코딩까지 겹치면
 * 손으로 짠 파서는 반드시 어딘가에서 깨진다 (실제로 깨졌다).
 *
 * 본문은 메일 원래 모양대로 보여주되(buildViewHtml), 위험한 것과 원격 이미지는 걷어낸다.
 */
async function fetchBody(account, uid, { markSeen = true, maxChars = 8000, allowRemote = false, mailbox = '' } = {}) {
  const client = connect(account);
  await client.connect();
  try {
    // 메일이 어느 폴더에 있는지는 부르는 쪽이 안다 — 보낸메일함의 메일을
    // 받은편지함에서 같은 번호로 열면 전혀 다른 메일이 나온다 (UID는 폴더마다 따로 돌아간다).
    const path = mailbox || account.mailbox || 'INBOX';
    await client.mailboxOpen(path, { readOnly: !markSeen });
    const msg = await client.fetchOne(String(uid),
      { envelope: true, internalDate: true, source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('메일을 찾을 수 없습니다');
    const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags || []);
    const wasSeen = flags.has('\\Seen');

    const parsed = await simpleParser(msg.source, { skipImageLinks: true });
    // 원래 모양대로 보여주는 게 우선 — HTML이 없을 때만 글로 떨어진다
    const view = buildViewHtml(parsed, { allowRemote });
    let text = (parsed.text || '').trim();
    if (!text && parsed.html) text = htmlToText(parsed.html);
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n…(생략)';

    if (markSeen) {
      // IMAP 플래그는 역슬래시로 시작한다 — 소스에서는 두 번 써야 한다
      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch { /* 실패해도 본문은 보여준다 */ }
    }
    return {
      uid,
      subject: parsed.subject || (msg.envelope && msg.envelope.subject) || '(제목 없음)',
      from: (parsed.from && parsed.from.text) || senderOf(msg.envelope),
      // 답장을 쓰려면 «누구에게»와 «어느 글에 이어»가 필요하다
      fromAddress: (parsed.from && parsed.from.value && parsed.from.value[0]
        && parsed.from.value[0].address) || '',
      replyTo: (parsed.replyTo && parsed.replyTo.value && parsed.replyTo.value[0]
        && parsed.replyTo.value[0].address) || '',
      messageId: parsed.messageId || '',
      at: (parsed.date || msg.internalDate || new Date()).getTime(),
      // 백업 파일 이름은 서버가 받은 시각으로 짓는다. 보낸 사람이 적은 날짜(Date: 헤더)를
      // 쓰면 전체 백업이 지은 이름과 어긋나 같은 메일이 두 번 저장된다.
      receivedAt: (msg.internalDate || new Date()).getTime(),
      mailbox: path,
      // 열었다고 무조건 읽음으로 바꾸지 않는다 — 창에서 직접 누르게 한다
      seen: markSeen ? true : wasSeen,
      // 원본 버퍼는 저장할 때만 쓰므로 여기 남겨두고, 화면에는 요약만 보낸다
      source: msg.source,
      attachments: parsed.attachments || [],
      html: view.html,
      blockedRemote: view.blockedRemote,
      text
    };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

// 메일에 들어 있는 그림만 보여준다. 인터넷에서 받아오는 그림(원격 이미지)은
// 불러오는 순간 "이 사람이 언제 열었다"가 발신자에게 전달되므로 아예 받지 않는다.
// 본문을 글로만 그리는 것도 같은 이유다.
const INLINE_IMAGE_MAX = 3 * 1024 * 1024;   // 이보다 큰 그림은 목록에만 둔다

/** 화면에 넘길 첨부 요약 — 원본 버퍼는 빼고, 그림만 data URL로 */
function attachmentsForView(list) {
  return (list || []).map((a, i) => {
    const type = String(a.contentType || '').toLowerCase();
    const isImage = type.startsWith('image/') && a.content && a.content.length <= INLINE_IMAGE_MAX;
    // 본문에 박혀 있는 그림은 이미 본문에서 보인다 — 아래에 또 크게 깔면
    // 본문이 밀려나고 같은 그림이 두 번 나온다. 저장은 되게 목록에는 남긴다.
    const inline = !!(a.related || a.cid || a.contentId
      || String(a.contentDisposition || '').toLowerCase() === 'inline');
    return {
      index: i,
      filename: a.filename || (isImage ? `그림${i + 1}` : `첨부${i + 1}`),
      size: a.content ? a.content.length : 0,
      contentType: type,
      inline,
      // data URL이라 네트워크를 타지 않는다 — 열람 사실이 새지 않는다
      dataUrl: isImage && !inline ? `data:${type};base64,${a.content.toString('base64')}` : null
    };
  });
}

/**
 * 메일 원래 모양대로 보여주기 위한 HTML 만들기.
 *
 * 글로만 바꾸면 그림이 아래로 몰리고 표·서식이 다 사라진다. 그래서 HTML을 쓰되,
 * 위험한 것만 걷어낸다:
 *  - 스크립트·프레임·외부 리소스 태그 제거
 *  - on* 이벤트 속성, javascript: 링크 제거
 *  - 메일에 담겨 온 그림(cid:)만 data URL로 바꿔 제자리에 넣는다
 *  - 인터넷에서 받아오는 그림은 지운다 (열람 사실이 발신자에게 전달된다)
 *
 * 여기서 놓치더라도 보기 창의 CSP가 외부 요청 자체를 막는다 — 이중 방어다.
 */
function buildViewHtml(parsed, { allowRemote = false } = {}) {
  let html = String(parsed.html || '');
  if (!html) return { html: '', blockedRemote: 0 };

  // 통째로 위험한 태그
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(link|meta|base)\b[^>]*>/gi, '')
    .replace(/@import[^;]+;/gi, '');

  // 이벤트 속성과 javascript: 링크.
  // 앞이 공백이라고만 보면 안 된다 — 따옴표 뒤에는 «/»도 속성 구분자로 통해서
  // <img src="x"/onerror="..."> 가 그대로 살아남는다. 태그 시작이 아닌 모든 자리를 본다.
  html = html
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ')
    .replace(/(href|src|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'")
    .replace(/(href|src|xlink:href)\s*=\s*javascript:[^\s>]*/gi, '$1="#"');

  // 메일에 담겨 온 그림을 본문 제자리에 넣는다.
  // 같은 그림을 가리키는 이름이 cid / contentId / 파일명으로 제각각이라 전부 받아둔다 —
  // 하나라도 어긋나면 그림이 본문에서 사라지고 첨부 목록으로 밀려난다(실제로 그랬다).
  const byKey = new Map();
  const key = (v) => String(v || '').replace(/^<|>$/g, '').trim().toLowerCase();
  for (const a of parsed.attachments || []) {
    if (!a.content || !String(a.contentType || '').startsWith('image/')) continue;
    if (a.content.length > INLINE_IMAGE_MAX) continue;
    const url = `data:${a.contentType};base64,${a.content.toString('base64')}`;
    for (const k of [a.cid, a.contentId, a.filename]) {
      if (k) byKey.set(key(k), url);
    }
  }
  html = html.replace(/src\s*=\s*["']cid:([^"']+)["']/gi, (m, cid) => {
    const url = byKey.get(key(cid));
    return url ? `src="${url}"` : 'src="" data-missing="1"';
  });
  // 끝내 못 찾은 그림은 빈 칸으로 남으니 지운다
  html = html.replace(/<img\b[^>]*data-missing="1"[^>]*>/gi, '');

  // 인터넷에서 받아오는 그림 — 허용하면 그대로 두고, 아니면 지운다.
  // (지우는 쪽이 안전하지만, 회사 메일은 정상적인 그림도 원격인 경우가 많다)
  // <img>만 막으면 <image>·<input type=image>·CSS url()로 그대로 새어 나간다.
  // «열어본 사실»이 새지 않게 하는 게 목적이므로 바깥을 부르는 자리는 다 막아야 한다.
  let blockedRemote = 0;
  if (!allowRemote) {
    html = html.replace(/<(img|image|input|video|audio|source|iframe|embed)\b[^>]*>/gi, (tag, name) => {
      if (/^img$/i.test(name) && /src\s*=\s*["']?data:/i.test(tag)) return tag;
      if (!/(src|srcset|poster|data)\s*=/i.test(tag)) return tag;
      blockedRemote += 1;
      return '';
    });
    // style="background:url(https://…)" 같은 자리도 바깥을 부른다
    html = html.replace(/url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, () => {
      blockedRemote += 1;
      return 'none';
    });
  }

  return { html, blockedRemote };
}

/** HTML만 있는 메일을 읽을 수 있는 글로 */
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

module.exports = { PRESETS, preset, connect, smtpOf, fromOf, cleanHtml, fetchSummary, fetchBody, markRead, moveToSpam, findJunk, findBox, test, senderOf, friendly, htmlToText, attachmentsForView, buildViewHtml };

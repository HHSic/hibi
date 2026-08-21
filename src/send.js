'use strict';
/**
 * 메일 보내기 — SMTP.
 *
 * 받기(IMAP)와 서버가 다르다. 같은 아이디·비밀번호를 쓰지만 주소와 포트가 따로다.
 *
 * 보낸 메일은 서버의 «보낸편지함»에 자동으로 들어가지 않는다. SMTP는 그냥 흘려보낼 뿐이고
 * 웹메일에서 보낸 것처럼 남기려면 IMAP APPEND로 우리가 직접 넣어야 한다.
 * 이걸 안 하면 "분명 보냈는데 보낸편지함에 없다"가 된다.
 */
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const mail = require('./mail');

const SEND_TIMEOUT_MS = 60_000;

/** 사람이 쉼표로 나열한 주소를 목록으로 — 빈 칸과 중복은 버린다 */
function addresses(s) {
  return String(s || '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x, i, all) => all.indexOf(x) === i);
}

/** 주소처럼 생겼는지 — 보내기 전에 오타를 잡는다 */
function looksLikeAddress(s) {
  return /^[^\s<>@]+@[^\s<>@.]+\.[^\s<>@]+$/.test(String(s).replace(/^.*<|>.*$/g, '').trim());
}

/**
 * 보내기 전 확인. 서버를 부르지 않고 판단할 수 있는 것만 본다.
 * @returns 문제가 있으면 사람이 읽을 사유, 없으면 null
 */
function problemWith(account, msg) {
  const from = mail.fromOf(account);
  if (!from.address) {
    return '보내는 사람 주소를 설정에서 먼저 넣어주세요';
  }
  const to = addresses(msg && msg.to);
  const cc = addresses(msg && msg.cc);
  const bcc = addresses(msg && msg.bcc);
  if (!to.length && !cc.length && !bcc.length) return '받는 사람을 넣어주세요';

  const bad = [...to, ...cc, ...bcc].find((a) => !looksLikeAddress(a));
  if (bad) return `주소 형식이 이상합니다 — ${bad}`;

  const { host } = mail.smtpOf(account);
  if (!host) return '보내는 서버(SMTP) 주소를 설정에서 넣어주세요';
  return null;
}

function transportFor(account) {
  const { host, port, secure } = mail.smtpOf(account);
  return nodemailer.createTransport({
    host,
    port,
    secure,
    // 465가 아니면 평문으로 붙었다가 STARTTLS로 올린다. 그런데 서버가 STARTTLS를
    // 안 알려주면 nodemailer는 그냥 평문으로 진행한다 — 비밀번호가 그대로 나간다.
    // 반드시 올리게 하고, 못 올리면 보내지 않는다.
    requireTLS: !secure,
    auth: { user: account.user, pass: account.pass },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
    tls: { rejectUnauthorized: true }
  });
}

/** 계정이 실제로 보낼 수 있는 상태인지 — 메일은 보내지 않고 로그인만 해 본다 */
async function verify(account) {
  const { host } = mail.smtpOf(account);
  if (!host) return { ok: false, message: '보내는 서버(SMTP) 주소를 넣어주세요' };
  const tx = transportFor(account);
  try {
    await tx.verify();
    return { ok: true, message: `보내기 준비됨 · ${host}` };
  } catch (e) {
    return { ok: false, message: mail.friendly(e) };
  } finally {
    tx.close();
  }
}

/**
 * 보낸 메일을 서버의 «보낸편지함»에 넣는다.
 * 폴더 이름은 서버마다 다르므로 용도(\Sent)로 먼저 찾고, 없으면 흔한 이름으로 짐작한다.
 * 실패해도 메일은 이미 나갔으므로 보내기 자체를 실패로 만들지 않는다.
 */
const SENT_NAME = /^(sent|sent items|sent messages|보낸편지함|보낸 편지함|보낸메일함)$/i;

async function appendToSent(account, raw) {
  const client = mail.connect(account);
  await client.connect();
  try {
    const boxes = await client.list();
    const box = boxes.find((b) => b.specialUse === '\\Sent')
      || boxes.find((b) => SENT_NAME.test(b.name));
    if (!box) return { ok: false, message: '보낸편지함을 찾지 못했습니다' };
    await client.append(box.path, raw, ['\\Seen']);
    return { ok: true, mailbox: box.path };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

/**
 * 한 통 보낸다.
 * @param msg { to, cc, bcc, subject, text, attachments: [{path, filename}], inReplyTo, references }
 */
async function sendMail(account, msg) {
  const bad = problemWith(account, msg);
  if (bad) return { ok: false, message: bad };

  const from = mail.fromOf(account);
  const to = addresses(msg.to);
  const cc = addresses(msg.cc);
  const bcc = addresses(msg.bcc);

  // 원문을 먼저 한 번 만들어 두고, 그 바이트를 그대로 보내고 그대로 보낸편지함에 넣는다.
  // SMTP로 보낼 때 nodemailer는 완성본을 돌려주지 않는다(info.message는 없다) —
  // 그걸 모르고 쓰면 보낸편지함에 빈 메일이 쌓인다.
  // 본문에 박은 그림은 파일로 같이 실어 보내고 본문에서는 cid로 가리킨다.
  // 화면에서는 data: URL로 보이지만 그대로 보내면 메일 크기가 부풀고
  // 어떤 메일 클라이언트는 data: 그림을 아예 안 보여준다.
  const inline = (msg.inline || []).map((a) => ({
    cid: a.cid,
    filename: a.filename || `그림.${(a.contentType || 'image/png').split('/')[1] || 'png'}`,
    contentType: a.contentType || 'image/png',
    content: Buffer.from(String(a.base64 || ''), 'base64'),
    contentDisposition: 'inline'
  }));

  let raw;
  try {
    raw = await new MailComposer({
      from: from.name ? { name: from.name, address: from.address } : from.address,
      to, cc, bcc,
      subject: String(msg.subject || '').slice(0, 500),
      text: String(msg.text || ''),
      // 서식 있는 본문. 글로만 읽는 곳을 위해 text도 같이 넣는다.
      html: msg.html ? String(msg.html) : undefined,
      attachments: [
        ...inline,
        ...(msg.attachments || []).map((a) => ({ path: a.path, filename: a.filename }))
      ],
      // 답장이면 원문에 이어 붙는다 — 이게 있어야 메일 클라이언트가 대화로 묶는다
      inReplyTo: msg.inReplyTo || undefined,
      references: msg.references || undefined,
      // 숨은참조는 봉투에만 넣고 본문 머리글에는 남기지 않는다 —
      // 남기면 받는 사람들이 서로의 주소를 다 보게 된다
      hideBcc: true
    }).compile().build();
  } catch (e) {
    return { ok: false, message: `메일을 만들지 못했습니다 — ${e.message}` };
  }

  const tx = transportFor(account);
  let info;
  try {
    info = await tx.sendMail({
      envelope: { from: from.address, to: [...to, ...cc, ...bcc] },
      raw
    });
  } catch (e) {
    return { ok: false, message: mail.friendly(e) };
  } finally {
    tx.close();
  }

  // 서버가 일부 주소만 거절해도 nodemailer는 성공으로 끝난다 (전부 거절될 때만 던진다).
  // 그걸 그냥 «보냈습니다»라고 하면, 안 간 사람이 있는 걸 아무도 모른다.
  const accepted = (info.accepted || []).map(String);
  const rejected = (info.rejected || []).map(String);

  // 여기부터는 이미 나간 뒤다. 실패해도 «보냈다»는 사실은 바뀌지 않는다.
  let sentBox = null;
  let sentWarn = null;
  try {
    const r = await appendToSent(account, raw);
    if (r.ok) sentBox = r.mailbox;
    else sentWarn = r.message;
  } catch (e) {
    sentWarn = mail.friendly(e);
  }

  return {
    ok: true,
    messageId: info.messageId,
    accepted: accepted.length,
    rejected,
    sentBox,
    warn: [
      rejected.length ? `${rejected.join(', ')} — 서버가 받지 않았습니다` : '',
      sentWarn ? `보낸편지함에는 넣지 못했습니다 (${sentWarn})` : ''
    ].filter(Boolean).join(' · '),
    message: `보냈습니다 · ${accepted.length}명`
  };
}

// 인용문으로 들고 갈 수 있는 원문 크기. 초안은 2MB까지 저장하므로 그 안에서 넉넉히 잡는다.
const QUOTE_MAX = 400_000;

/**
 * 웹메일이 HTML과 함께 보내는 text/plain은 사람이 읽으라고 만든 것이 아니다.
 * 기계가 표를 글로 옮긴 결과라서 두 가지가 늘 따라온다.
 *  - 서명이 표로 짜여 있으면 칸마다 빈 줄이 생긴다. 서명 하나가 빈 줄 스무 개가 된다.
 *  - 링크가 «<http://x/> x»처럼 주소와 이름 두 번으로 나온다.
 * 인용문에 넣기 전에 이 둘을 걷어낸다.
 */
function tidyText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    // 꺾쇠에 든 주소 뒤에 글이 이어지면 그 글이 곧 링크 이름이다 — 주소 쪽이 군더더기다.
    // 뒤가 줄 끝이면 그 주소 자체가 본문이므로 꺾쇠만 벗긴다.
    .replace(/<((?:mailto:|https?:\/\/)[^\s<>]*)>[ \t]*/g, (m, url, at, whole) => (
      /^[^\n]*\S/.test(whole.slice(at + m.length)) ? '' : url.replace(/^mailto:/, '')
    ))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')   // 빈 줄이 줄줄이 이어지는 것을 하나로
    .trim();
}

/**
 * 원문 HTML을 인용문으로 쓸 수 있게 다듬는다.
 *
 * 여기 오는 HTML은 이미 buildViewHtml을 지나 바깥 그림이 걷힌 것이지만, 그 사실에 기대지
 * 않는다 — 부르는 자리가 하나 늘어나는 순간 그 약속은 조용히 깨진다. cleanHtml을 다시 돌리고
 * 그 위에 두 가지를 더 한다.
 *  - <style>은 쓰기 창 전체에 걸린다. 남의 메일이 내 도구 모음을 다시 칠하게 둘 수 없다.
 *  - <html>/<body>는 문서 한 벌이라 인용문 안에 들어가면 안 된다.
 * 너무 크면 본문에 박힌 그림부터 덜어내고, 그래도 크면 글로 인용한다.
 */
function quoteHtmlOf(html) {
  let h = String(html || '').trim();
  if (!h) return '';
  h = mail.cleanHtml(h)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, '')
    .trim();
  if (h.length > QUOTE_MAX) {
    h = h.replace(/<img\b[^>]*src\s*=\s*["']data:[^"']*["'][^>]*>/gi, '');
  }
  return h.length > QUOTE_MAX ? '' : h;
}

/** 전달 머리글 — 원문이 누구에게서 언제 왔는지. 아웃룩·지메일이 붙이는 그 줄들이다. */
function forwardHead(src, when) {
  return [
    '---------- 전달된 메일 ----------',
    `보낸사람: ${src.from || src.fromAddress || ''}`,
    `날짜: ${when}`,
    `제목: ${src.subject || ''}`,
    src.to ? `받는사람: ${src.to}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * 답장·전달 초안 — 제목 접두사와 인용문을 만든다.
 *
 * 인용문은 원문 서식을 그대로 쓴다. 예전엔 함께 온 text/plain을 «> »로 줄마다 찍어 넣었는데,
 * 웹메일이 기계로 만든 그 글은 빈 줄과 두 번씩 나온 주소로 가득해서, 답장 창을 열면
 * 내가 쓸 자리보다 그것이 먼저 보였다. 원문 HTML이 없을 때만 글로 인용한다.
 */
function draftFrom(kind, src) {
  if (!src) return { to: '', subject: '', text: '' };
  const when = new Date(src.at || Date.now()).toLocaleString('ko-KR');
  const quote = {
    quoteHtml: quoteHtmlOf(src.html),
    // 서식으로 인용하더라도 글 인용문을 같이 넘긴다 — 글로만 읽는 곳으로 나갈 몫이다
    text: tidyText(src.text),
    quoteHead: kind === 'forward'
      ? forwardHead(src, when)
      : `${when} ${src.from || ''} 님이 쓴 글:`
  };

  if (kind === 'forward') {
    return {
      to: '',
      subject: /^fwd:/i.test(src.subject || '') ? src.subject : `Fwd: ${src.subject || ''}`,
      ...quote
    };
  }
  return {
    to: src.replyTo || src.fromAddress || '',
    subject: /^re:/i.test(src.subject || '') ? src.subject : `Re: ${src.subject || ''}`,
    ...quote,
    inReplyTo: src.messageId || '',
    references: src.messageId || ''
  };
}

module.exports = { sendMail, verify, appendToSent, draftFrom, addresses, looksLikeAddress, problemWith, tidyText, quoteHtmlOf };

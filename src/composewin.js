// 메일 쓰기 창.
//
// 받기(IMAP)와 보내기(SMTP)는 서버가 다르다. 창은 하나만 띄운다 —
// 쓰던 글이 있는데 새 창이 겹쳐 뜨면 어느 쪽에 쓰고 있었는지 잃는다.
//
// 바깥(main.js)에는 «새로 쓰기»와 «복사해서 쓰기» 둘만 내준다.
// 나머지(첨부·보내기·임시저장·창 크기)는 여기서 IPC로 직접 받는다.

const { BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const glass = require('./glass');
const evlog = require('./evlog');
const mail = require('./mail');
const send = require('./send');
const secret = require('./secret');
const { askUser } = require('./popup');
const { PRELOAD, page, PAD, clamp, glassQuery, lockToOurPage, maxSize } = require('./win');

// 메일 목록·계정은 main.js 가 들고 있다. 서로 require 하면 순환이 되므로
// 필요한 것만 시작할 때 받아 둔다 (init).
let host = {
  mailAccountsForUse: () => [],
  // 쓸 계정이 없을 때 할 말 — 꺼짐·비밀번호 못 풂·없음을 가려 말한다 (mailhub 가 준다)
  noAccountMessage: () => '메일 계정을 지금 쓸 수 없습니다 — 설정 › 메일을 확인하세요',
  refreshMail: async () => {},
  slotOf: () => null,
  doTrash: async () => ({ moved: false })
};
function init(h) { host = { ...host, ...h }; }

// 받기(IMAP)와 보내기(SMTP)는 서버가 다르다. 창은 하나만 띄운다 —
// 쓰던 글이 있는데 새 창이 겹쳐 뜨면 어느 쪽에 쓰고 있었는지 잃는다.
let composeWin = null;
let composePayload = null;
let composeSize = null;
// 복사(다시 보내기)·답장·전달로 실어둔 원문 첨부. 바이트는 여기 메인에만 둔다 —
// 화면에는 «무엇이 붙어 있나»만(이름·크기·id) 넘기고, 보낼 때 id로 다시 맞춘다.
// composePayload와 짝이다(창이 하나뿐이다). 그래서 반드시 같이 확정해야 한다 —
// 짝이 어긋나면 화면에 붙어 보이는 첨부를 못 보내게 된다.
let composeCarried = [];
// 창이 이미 열려 있어 갈아끼기를 «물어보는 중»인 첨부. 화면이 수락할 때 비로소 확정한다.
// 먼저 확정하면, 사용자가 «현재 초안 유지»를 고른 순간 그 초안의 첨부가 사라진다.
// 물어본 초안마다 열쇠(carryKey)를 달아 따로 둔다. 하나만 두면, 묻는 사이 다른 메일에서
// 또 «전달»을 누를 때 덮여서 수락한 초안이 남의 첨부를 들고 간다 (화면은 묻는 중에 온 것을 버린다).
let pendingCarried = new Map();   // 열쇠(번호) → 첨부
let replaceSeq = 0;
let carrySeq = 0;
// 보내는 중인가. 두 번 나가는 것을 막고, 그 사이에 들어오는 새 초안도 거절한다.
// openCompose가 이걸 보므로 그보다 위에 선언한다 (선언 전 사용으로 화면이 죽은 적이 여러 번 있다).
let sendingNow = false;

/**
 * 쓰기 창의 본 문서에서 왔나. 모든 창이 preload 하나(PRELOAD)를 같이 쓴다 — 남의 HTML 을 그리는
 * 메일 보기 창에도 composeSend·composeData·composeAcceptReplace 가 열려 있다. 그 화면이 뚫리면
 * 사용자가 쓰고 있는 답장·전달의 칩 id(순번이라 짐작도 쉽다)를 읽어, 받은 메일의 원문 첨부를 아무 주소로
 * 보낼 수 있었다 (실측 — 지어낸 메일·가짜 운반). 보내기·초안 읽기·바꾸기·임시 저장은 쓰기 창만 한다.
 * 그 안에 낀 틀(iframe)도 믿지 않는다 (autofwd.js 의 mainFrameOf 와 같은 까닭).
 */
function fromComposeWin(e) {
  if (!composeWin || composeWin.isDestroyed() || !e || e.sender !== composeWin.webContents) return false;
  const f = e.senderFrame;
  const m = e.sender.mainFrame;
  return !!f && !!m && f.processId === m.processId && f.routingId === m.routingId;
}

function openCompose(payload, carried = []) {
  if (composeWin && !composeWin.isDestroyed()) {
    // 보내는 중이면 화면이 갈아끼우기를 그냥 버린다. 그걸 성공이라고 돌려주면
    // 답장을 눌렀는데 아무 일도 안 일어나고 이유도 안 나온다 — 여기서 거절한다.
    // (이 서버는 보내는 데 수십 초가 걸려서 그 사이가 짧지 않다)
    if (sendingNow) {
      return { ok: false, message: '쓰기 창이 보내는 중입니다 — 끝나면 다시 눌러주세요' };
    }
    // 창을 반드시 보이게 한 다음에 말을 건다.
    // focus()만으로는 최소화된 창이 안 올라온다 — 그러면 답장을 눌렀는데
    // 아무 일도 안 일어난다. 갈아끼울까 묻는 말도 안 보이는 창에서 뜼게 된다.
    if (composeWin.isMinimized()) composeWin.restore();
    if (!composeWin.isVisible()) composeWin.show();
    composeWin.moveTop();
    composeWin.focus();
    // 쓰던 글이 있는데 새 초안으로 갈아끼우면 그 글은 그대로 사라진다.
    // 화면에 물어보고, 아니라고 하면 쓰던 것을 그대로 둔다.
    // 첨부도 여기서 확정하지 않는다 — 화면이 수락해야(compose:accept-replace) composeCarried와
    // composePayload를 함께 바꾼다. 먼저 바꾸면 «유지»를 골랐을 때 그 초안의 첨부가 사라진다.
    // 화면은 수락할 때 받은 초안을 그대로 돌려준다 — 그 안의 열쇠로 제 첨부를 찾는다.
    const carryKey = ++replaceSeq;
    pendingCarried.set(carryKey, carried);
    // 그만두기·버린 초안은 화면이 compose:drop-replace 로 알려 바로 지운다 (첨부 바이트가 창이 닫힐 때까지
    // 메인에 남지 않게). 이 상한은 그 알림이 안 올 때를 위한 것이다. 가장 먼저 물은 것(지금 묻고 있는 것)은
    // 남긴다 — 화면은 묻는 중에 온 것을 버리므로 수락할 수 있는 것은 언제나 그것이다. 예전엔 가장 오래된 것부터
    // 지워서, 묻는 사이 «전달»을 네 번 더 누르면 칩은 보이는데 보내기가 «원문 첨부를 찾지 못했습니다»로 막혔다.
    while (pendingCarried.size > 4) pendingCarried.delete([...pendingCarried.keys()][1]);
    composeWin.webContents.send('compose:replace', { ...payload, carryKey });
    evlog.log('메일', '쓰기 창이 이미 열려 있어 갈아끼기를 물어봅니다');
    return { ok: true, message: '쓰기 창이 이미 열려 있습니다 — 그쪽에서 물어봅니다', reused: true };
  }
  composePayload = payload;
  composeCarried = carried;   // 새 창은 곧바로 확정한다 — composeData로 그대로 채운다
  const saved = store.settings.composeSize;
  const cap = maxSize();
  composeWin = new BrowserWindow({
    width: Math.round(clamp((saved && saved.width) || 520 + PAD, 380, cap.width)),
    height: Math.round(clamp((saved && saved.height) || 520 + PAD, 320, cap.height)),
    minWidth: 380, minHeight: 320,
    frame: false,
    resizable: false,            // 크기 조절은 렌더러의 리사이즈 존이 맡는다
    alwaysOnTop: false, skipTaskbar: false,
    title: '메일 쓰기',
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  composeSize = { width: composeWin.getSize()[0], height: composeWin.getSize()[1] };
  lockToOurPage(composeWin);
  composeWin.loadFile(page('compose.html'), { query: glassQuery({ radius: '20' }) });
  composeWin.on('closed', () => {
    composeWin = null; composePayload = null; composeCarried = []; pendingCarried = new Map();
  });
  return { ok: true, message: '' };
}

// 본문에 박힌 그림은 «첨부»가 아니다 — 이미 본문(cid/data:)에 들어 있다.
// 그것까지 다시 실으면 그림이 두 번(본문 한 번, 첨부 한 번) 나간다.
// 무엇이 «첨부»인지는 부르는 쪽이 보기 창과 같은 판정(mail.js attachmentsForView / realAttachmentsOf)으로 골라 넘긴다.
// 예전엔 여기서 따로 related·disposition inline 으로 걸렀는데, 그 기준이 보기 창과 달라서
// 보기 창이 «첨부 1개 scan.pdf»라고 보여 준 Apple Mail 의 inline PDF 가 복사본에서 조용히 빠졌다 (실측 — 지어낸 메일).
// 이름은 부르는 쪽이 보기 창과 같은 이름(mail.attachmentName)으로 채워 넘긴다 — 이름 없는 첨부(첨부된 메일·
// 회의 초대·이름 없는 PDF)도 보기 창에는 «첨부3»으로 보인다. 예전엔 여기서 이름 없는 것을 걸러,
// 보기 창에서 «첨부 2개»를 보고 전달해도 0개가 갔고 쓰기 창에도 아무 말이 없었다 (실측 — 지어낸 메일).

// 원문 첨부를 얼마까지 실어 두나. 보내기 한도(ATTACH_MAX 25MB)보다 조금 아래로 잡는다 —
// 한도까지 꽉 채워 열면, 사용자가 제 파일 하나만 더 붙여도 못 보내고 무엇을 뺄지부터 골라야 한다.
const CARRY_MAX = 20 * 1024 * 1024;
const CARRY_COUNT = 20;

// 원문 메일이 적어 온 형식 — 보낼 때 그대로 단다 (안 달면 nodemailer 가 이름의 확장자로 짐작해서
// .hwp·확장자 없는 이름·첨부된 메일이 application/octet-stream 으로 나간다). 남이 보낸 머리글이라 꼴을 확인한다.
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/**
 * 원문 첨부를 쓰기 창에 실을 꼴로 — 바이트는 여기(메인)에 남고 화면에는 id·이름·크기만 간다.
 * 개수(20개)와 합계(20MB — 복사는 max 로 따로)를 넘는 것, 바이트가 없는 것은 빼고, 뺀 것은 한 줄로 알린다.
 * 말 없이 빼면 받는 사람이 «첨부가 없다»고 되묻고 나서야 안다.
 * 순서대로 담되 큰 것 하나 때문에 뒤의 작은 것까지 버리지는 않는다.
 * pics 는 본문 그림인데 인용문에서 덜어낸 것 — 첨부 뒤에 싣고 «첨부로 붙였습니다»라고 알린다.
 * @returns { carry: [{ id, filename, size, content, contentType }], note }
 */
function carryOf(files, prefix = 'copy', { max = CARRY_MAX, pics = [] } = {}) {
  const carry = [];
  const big = [];
  let many = 0;
  let lost = 0;
  let picsIn = 0;
  let bytes = 0;
  const put = (a, pic) => {
    if (!a) return;
    if (!a.content) { lost++; return; }
    if (carry.length >= CARRY_COUNT) { many++; return; }
    const name = String(a.filename || '첨부');
    if (bytes + a.content.length > max) { big.push(name); return; }
    bytes += a.content.length;
    if (pic) picsIn++;
    const type = MIME_TYPE.test(String(a.contentType || '')) ? String(a.contentType).toLowerCase() : undefined;
    carry.push({ id: `${prefix}${++carrySeq}`, filename: name, size: a.content.length, content: a.content, contentType: type });
  };
  for (const a of files || []) put(a, false);
  for (const a of pics || []) put(a, true);
  const note = [
    picsIn ? `본문 그림 ${picsIn}개는 첨부로 붙였습니다` : '',
    big.length ? `첨부 ${big.length}개는 커서 뺐습니다 (${big.join(', ').slice(0, 60)})` : '',
    many ? `첨부 ${many}개는 많아서 뺐습니다` : '',
    lost ? `첨부 ${lost}개는 못 실었습니다` : ''
  ].filter(Boolean).join(' · ');
  return { carry, note };
}

/** 화면에 넘길 칩 — 이름·크기·id만 (바이트·형식은 메인에 둔다). 화면은 이걸로 칩을 그리고, 보낼 때 도로 넘긴다. */
function chipsOf(carry) {
  return carry.map(({ id, filename, size }) => ({ id, filename, size, carried: true }));
}

/**
 * 내 주소 전부 — 답장의 참조에서 뺀다 (send.replyCc). 설정에 있는 계정 전부(꺼 둔 것·비밀번호가 안 풀리는 것도)와
 * 지금 쓸 수 있는 계정의 로그인 아이디·보내는 주소. 이 메일을 받은 계정만 빼면, 다른 내 주소가 참조에 남아
 * 내가 쓴 답장이 나에게 또 온다.
 */
function selfAddresses(accounts) {
  return [...store.mailAccounts, ...(accounts || [])]
    .filter(Boolean)
    .flatMap((a) => [a.user, mail.fromOf(a).address]);
}

/**
 * 새 메일 / 답장 / 전달 — 어느 쪽이든 초안을 만들어 창을 연다.
 * 메일 보기 창의 «답장»·«전달» 버튼(mail:reply·mail:forward)과 목록의 오른쪽 클릭이 같은 길을 쓴다.
 * 답장·전달이면 원문 첨부(files — 보기 창이 «첨부»로 보여 준 것)를 같이 싣는다.
 * 사용자가 칩을 빼면 그것만 빼고 보낸다. 받는 사람은 그대로다 — 답장은 보낸 사람에게 가고,
 * 원문의 참조는 참조로 잇는다 (내 주소는 뺀다 — selfAddresses). 전달은 받는 사람·참조 모두 빈 칸이다.
 * bodyPics 는 본문에 그려진 그림의 원문 — 인용문이 너무 커서 그림을 덜어냈을 때만 첨부로 싣는다.
 */
function startCompose({ kind = 'new', accountId, source, files, bodyPics } = {}) {
  const accounts = host.mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: host.noAccountMessage() };

  // 답장·전달은 반드시 그 메일을 받은 계정으로 써야 한다. 못 찾았다고 첫 계정으로 넘기면
  // 개인 메일에 회사 주소로 답장이 나간다 — 받는 사람 눈에는 그게 내 정체다.
  const asked = accounts.find((a) => a.id === accountId);
  if (!asked && kind !== 'new') {
    evlog.log('메일', `쓰기 못 열음 · 계정 ${accountId}을 목록에서 못 찾음`
      + ` (쓸 수 있는 계정: ${accounts.map((a) => a.id).join(',') || '없음'})`);
    return { ok: false, message: '이 메일을 받은 계정을 쓸 수 없습니다 — 설정 › 메일을 확인하세요' };
  }
  // 이어쓰는 것은 원래 쓰던 계정으로 — 그 계정이 없어졌으면 첫 계정으로 놓아둔다
  const draftAcc = kind === 'new' && store.mailDraft
    ? accounts.find((x) => x.id === store.mailDraft.accountId)
    : null;
  const acc = asked || draftAcc || accounts[0];

  // 쓰다 말은 것이 있으면 이어서 쓴다. 답장·전달은 새 초안이 분명하므로 건드리지 않는다.
  const kept = kind === 'new' ? store.mailDraft : null;
  const { quoteDropped, ...draft } = kept
    ? {
      to: kept.to, cc: kept.cc, bcc: kept.bcc, subject: kept.subject,
      bodyHtml: kept.bodyHtml, inReplyTo: kept.inReplyTo, references: kept.references,
      restored: true, restoredAt: kept.at, restoredNames: kept.attachNames || [],
      restoredCarried: kept.carriedNames || [],
      // 임시 저장 칸에 다 안 들어가 자리표로 바꾼 본문 그림 수 · 글만으로 넘쳐 본문을 비웠나 (store.setMailDraft)
      restoredPicsGone: Number(kept.droppedPics) || 0,
      restoredBodyGone: !!kept.bodyDropped
    }
    : (kind === 'new' ? { to: '', subject: '', text: '' } : send.draftFrom(kind, source, { self: selfAddresses(accounts) }));
  // 원문 첨부는 답장·전달에만 — 새 메일(이어 쓰기 포함)에는 실을 원문이 없다.
  // 본문 그림은 «인용문 안에서 cid 그림으로 나간다»고 보고 싣지 않는다. 그런데 인용문이 너무 커서
  // (send.quoteHtmlOf) 그림을 덜어냈으면 그 그림은 인용문에도 첨부에도 없다 — 300KB 남짓한 화면 캡처 한 장이면
  // 그렇게 된다 (실측). 그때만 본문 그림을 첨부로 싣는다.
  const { carry, note } = kind === 'new' ? { carry: [], note: '' }
    : carryOf(files, kind === 'reply' ? 'reply' : 'fwd', { pics: quoteDropped ? bodyPics : [] });
  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  evlog.log('메일', `쓰기 열기 · ${kind} · 계정 ${acc.name || acc.user}`
    + (carry.length ? ` · 첨부 ${carry.length}개` : '') + (note ? ' · 일부 첨부 뺌' : ''));
  const opened = openCompose({
    accountId: acc.id,
    signature: stored.signature || '',
    signatures: Object.fromEntries(store.mailAccounts.map((a) => [a.id, a.signature || ''])),
    title: kept ? (kept.title || '이어 쓰기')
      : kind === 'reply' ? '답장' : kind === 'forward' ? '전달' : '새 메일',
    // 새 메일은 어느 계정으로 보낼지 고를 수 있어야 한다 — 안 그러면 «마지막에 온 메일의
    // 계정»으로 정해져서, 받은 순서가 내 발신 주소를 결정하게 된다
    pickable: kind === 'new',
    accounts: accounts.map((a) => {
      const f = mail.fromOf(a);
      return { id: a.id, name: a.name || a.user, from: f.address, label: f.name };
    }),
    ...draft,
    attachments: chipsOf(carry),
    carryNote: note
  }, carry);
  if (!opened.ok) evlog.log('메일', `쓰기 못 열음 · ${opened.message}`);
  return opened;
}

// 화면이 여는 것은 «새 메일»뿐이다. 답장·전달은 원문(첨부 바이트까지)이 메인에 있어야 해서
// 메일 보기 창은 mail:reply·mail:forward 로, 목록 메뉴는 메인 안에서 바로 startCompose 를 부른다.
// 화면이 꾸린 원문으로 답장을 열어 주면 첨부가 빠진 답장이 아무 말 없이 열린다.
ipcMain.handle('compose:open', (_e, opts) => {
  const o = opts || {};
  if (o.kind && o.kind !== 'new') {
    evlog.log('메일', `쓰기 못 열음 · 화면이 ${String(o.kind).slice(0, 20)}을 compose:open 으로 부름`);
    return { ok: false, message: '답장·전달은 메일에서 다시 눌러주세요' };
  }
  return startCompose({ kind: 'new', accountId: o.accountId });
});

/**
 * 보낸 메일을 복사해 새 메일로 연다 — «다시 보내기».
 * 원문 첨부의 바이트는 메인에만 두고(composeCarried), 화면에는 이름·크기·id만 넘긴다.
 * 보낼 때 그 id로 바이트를 다시 맞춘다 — 큰 파일이 화면을 오가지 않게, 그리고
 * 화면이 뚫려도 아무 파일이나 실어 보내지 못하게.
 */
function startCopy({ accountId, view, files } = {}) {
  const accounts = host.mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: host.noAccountMessage() };
  // 보낸 메일은 그 계정으로 다시 보내는 게 자연스럽다. 못 찾으면 첫 계정으로 둔다
  // (내 보낸메일함이니 어느 계정이든 내 것이다).
  const acc = accounts.find((a) => a.id === accountId) || accounts[0];
  const draft = send.copyFrom(view || {});

  // 복사는 예전처럼 개수만 본다 — 크기는 보내기 한도(ATTACH_MAX)가 막고, 쓰기 창이 «모두 n MB — 25MB까지만»으로
  // 미리 알린다. 20MB 로 자르면, 받을 때도 보낼 때도 문제없던 22MB 메일을 다시 보낼 수 없게 된다
  // (빠진 파일은 디스크에 없어서 다시 붙이기도 어렵다).
  const { carry, note } = carryOf(files, 'copy', { max: Infinity });

  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  evlog.log('메일', `복사 열기 · 계정 ${acc.name || acc.user}`
    + (carry.length ? ` · 첨부 ${carry.length}개` : '') + (note ? ' · 일부 첨부 뺌' : ''));
  const opened = openCompose({
    accountId: acc.id,
    signature: stored.signature || '',
    signatures: Object.fromEntries(store.mailAccounts.map((a) => [a.id, a.signature || ''])),
    title: '복사본',
    pickable: false,
    accounts: accounts.map((a) => {
      const f = mail.fromOf(a);
      return { id: a.id, name: a.name || a.user, from: f.address, label: f.name };
    }),
    ...draft,
    attachments: chipsOf(carry),
    carryNote: note
  }, carry);
  if (!opened.ok) evlog.log('메일', `복사 못 열음 · ${opened.message}`);
  return opened;
}

/**
 * 보기 창이 보여 준 것 그대로의 원문 바이트. 번호는 원래 첨부 번호다 (slot.files 의 자리).
 * 이름은 보기 창이 붙인 것으로 채운다 — 이름 없는 첨부(«첨부3»·첨부된 메일·회의 초대)를 원본 그대로 넘기면
 * 이름이 없어 답장·전달에서 말 없이 빠졌다 (보기 창에는 보이는데).
 */
function viewPick(slot, keep) {
  return (slot.payload.attachments || []).filter(keep).map((a) => {
    const f = slot.files[a.index];
    return f && { ...f, filename: f.filename || a.filename };
  });
}
/** «첨부» 무리 — 본문 그림(inline)은 이미 본문에 들어 있다. 복사·답장·전달이 이것 하나로 고른다. */
const viewFiles = (slot) => viewPick(slot, (a) => !a.inline);
/** 본문에 그려진 그림 (Word 의 VML 짝은 빼고) — 인용문이 그림을 덜어냈을 때만 첨부로 싣는다 */
const viewBodyPics = (slot) => viewPick(slot, (a) => a.inline && !a.dup);

/**
 * 메일 보기 창의 «답장»·«전달». 원문 첨부의 바이트는 여기(slot.files)에 있으므로 메인이 초안을 만든다.
 * 예전엔 화면이 원문을 꾸려 compose:open 으로 넘겼다 — 화면에는 바이트가 없어 첨부가 따라가지 못했다.
 */
function composeFromView(e, kind) {
  const slot = host.slotOf(e);
  if (!slot || !slot.payload || slot.payload.error) {
    return { ok: false, message: '메일을 아직 다 읽지 못했습니다' };
  }
  const v = slot.payload;
  // 보낸메일함의 메일에 답장하면 나에게 간다 — 단추·목록 메뉴는 그래서 숨긴다. IPC도 같은 문을 지킨다 (mail:copy 처럼).
  if (kind === 'reply' && v.fromSelf) return { ok: false, message: '내가 보낸 메일에는 답장할 수 없습니다' };
  return startCompose({
    kind,
    accountId: v.accountId,
    // 인용문을 원문 서식 그대로 넣으려고 html 도 같이 (화면이 넘기던 것과 같은 칸들).
    // 참조(cc)는 답장의 참조가 된다 (send.replyCc — 내 주소·받는 사람은 뺀다)
    source: {
      subject: v.subject, from: v.from, fromAddress: v.fromAddress, to: v.to, cc: v.cc,
      replyTo: v.replyTo, messageId: v.messageId, at: v.at,
      text: v.text, html: v.html
    },
    files: viewFiles(slot),
    bodyPics: viewBodyPics(slot)
  });
}
ipcMain.handle('mail:reply', (e) => composeFromView(e, 'reply'));
ipcMain.handle('mail:forward', (e) => composeFromView(e, 'forward'));

// 메일 보기 창의 «휴지통» — 옮기고 나면 그 창은 없는 메일을 보고 있으므로 닫는다
ipcMain.handle('mail:trash', async (e) => {
  const slot = host.slotOf(e);
  if (!slot || !slot.payload || slot.payload.error) {
    return { ok: false, message: '메일을 아직 다 읽지 못했습니다' };
  }
  const v = slot.payload;
  const r = await host.doTrash(
    { accountId: v.accountId, uid: v.uid, mailbox: v.mailbox, subject: v.subject }, slot.win);
  // 물어보고 그만뒀거나 실패했으면 창을 그대로 둔다 — 옮겨졌을 때만 닫는다.
  // (목록이 줄었는지로 판단하면 안 된다. refreshMail을 기다리지 않기 때문이다.)
  if (r.moved && !slot.win.isDestroyed()) slot.win.close();
  // 그만두기를 고른 것은 실패가 아니다 — 화면이 «옮기지 못했습니다»라고 하면 안 된다
  return { ok: r.moved, cancelled: !!r.cancelled, closed: !!r.moved, message: r.message || '' };
});

// 메일 보기 창의 «복사» — 원문 버퍼가 여기(slot.files)에 있으므로 메인이 만든다
ipcMain.handle('mail:copy', (e) => {
  const slot = host.slotOf(e);
  if (!slot || !slot.payload || slot.payload.error) {
    return { ok: false, message: '메일을 아직 다 읽지 못했습니다' };
  }
  const v = slot.payload;
  // 단추·메뉴는 내가 보낸 메일에서만 «복사»를 보여준다. IPC도 같은 문을 지킨다.
  // 이것은 첨부를 지키는 문이 아니다 — 답장·전달(mail:reply·mail:forward)은 어느 메일이든 받은 첨부를 싣는다.
  // 실어 둔 바이트를 지키는 진짜 문은 compose:send·compose:data 의 «쓰기 창에서 왔나»(fromComposeWin)다.
  if (!v.fromSelf) return { ok: false, message: '복사는 내가 보낸 메일에서만 됩니다' };
  return startCopy({
    accountId: v.accountId,
    view: { subject: v.subject, to: v.to, cc: v.cc, text: v.text, html: v.html },
    files: viewFiles(slot)
  });
});

// 쓰다 말은 것을 계속 적어둔다. 화면이 손이 멈출 때마다 보낸다 —
// 창을 닫았거나 앱이 죽어도 다음에 새 메일을 열면 그대로 나온다.
// 쓰기 창만 — 다른 창이 사용자의 쓰다 만 글을 덮거나 지우지 못하게 (fromComposeWin)
ipcMain.on('compose:draft-save', (e, d) => {
  if (!fromComposeWin(e)) return;
  try { store.setMailDraft(d || null); } catch (err) { evlog.log('메일', `임시 저장 실패 — ${err.message}`); }
});
ipcMain.on('compose:draft-clear', (e) => { if (fromComposeWin(e)) store.clearMailDraft(); });

/**
 * 쓰기 창이 물어볼 것들.
 * 브라우저 confirm은 테두리 없는 창에서 동떨어지게 뜨고 버튼이 둘뿐이다.
 * 닫기는 세 갈래길이다 — 저장 / 버림 / 계속 쓰기.
 */
ipcMain.handle('compose:ask', async (_e, kind) => {
  const win = composeWin && !composeWin.isDestroyed() ? composeWin : undefined;
  if (kind === 'replace') {
    // «임시 저장하고 열기»는 여기서 넣지 않는다 — 칸이 하나라 새 답장을
    // 치는 순간 그게 덮인다. 할 수 없는 걸 리스트에 두면 그게 거짓말이 된다.
    const r = await askUser(win, {
      buttons: ['버리고 열기', '그만두기'],
      defaultId: 1,
      danger: false,
      title: '메일 쓰기',
      message: '쓰던 글을 버리고 새로 열까요?',
      detail: '되돌릴 수 없습니다.'
    });
    return r === 0 ? 'discard' : 'cancel';
  }
  if (kind === 'discard') {
    const r = await askUser(win, {
      buttons: ['버리기', '그만두기'],
      defaultId: 1,
      title: '새로 쓰기',
      message: '이어쓰던 글을 버릴까요?',
      detail: '되돌릴 수 없습니다.'
    });
    return r === 0 ? 'discard' : 'cancel';
  }
  const r = await askUser(win, {
    buttons: ['임시 저장', '저장 안 함', '계속 쓰기'],
    defaultId: 0,
    title: '메일 쓰기',
    message: '쓰다 만 메일을 임시 저장할까요?',
    detail: '저장하면 다음에 «쓰기»를 누를 때 이어서 씁니다.'
  });
  // 창 밖을 눌렀거나 Esc — 아무것도 안 고른 것은 «계속 쓰기»다.
  // 글이 날아가는 쪽으로 기울면 안 된다.
  return r === 0 ? 'save' : r === 1 ? 'discard' : 'cancel';
});

// 초안에는 실어 둔 칩 id 가 들어 있다 — 쓰기 창에만 준다 (fromComposeWin)
ipcMain.handle('compose:data', (e) => (fromComposeWin(e) ? composePayload : null));
ipcMain.on('compose:close', () => composeWin && !composeWin.isDestroyed() && composeWin.close());
/**
 * 화면이 «갈아끼워도 좋다»고 하면 그때 초안을 바꾼다.
 * 실어둔 첨부도 바로 이 순간에 확정한다 — payload와 짝을 맞춰야, «유지»를 골랐을 때
 * 옛 초안이 제 첨부를 그대로 들고 있게 된다.
 */
ipcMain.on('compose:accept-replace', (e, payload) => {
  // 다른 창이 «그만두기»로 남겨 둔 초안을 확정해 그 첨부를 빼앗지 못하게 — 쓰기 창만
  if (!fromComposeWin(e)) return;
  const key = Number(payload && payload.carryKey);
  composePayload = payload;
  composeCarried = pendingCarried.get(key) || [];
  // 화면은 온 차례대로 수락한다 — 이것보다 먼저 물은 것은 이미 수락됐거나 화면이 버린 것이다
  for (const k of [...pendingCarried.keys()]) if (k <= key) pendingCarried.delete(k);
});
/**
 * 화면이 갈아끼우지 않기로 한 초안 — 그만두기를 골랐거나, 묻는 중·보내는 중이라 버렸다.
 * 그 첨부 바이트(하나에 20MB 까지)를 창이 닫힐 때까지 쥐고 있지 않게 바로 지운다.
 */
ipcMain.on('compose:drop-replace', (e, carryKey) => {
  if (!fromComposeWin(e)) return;
  pendingCarried.delete(Number(carryKey));
});
/** 새 메일에서 보낼 계정을 바꾼다 */
ipcMain.on('compose:set-account', (e, id) => {
  if (!fromComposeWin(e)) return;
  if (composePayload && host.mailAccountsForUse().some((a) => a.id === id)) composePayload.accountId = id;
});

// 화면이 «이 파일을 붙여라»라고 말한 것을 그대로 믿으면, 렌더러가 뚫렸을 때 이 PC의
// 아무 파일이나 메일로 실어 보낼 수 있다. 대화상자로 사용자가 직접 고른 것만 기억해 둔다.
const attachOk = new Set();

ipcMain.handle('compose:attach', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(composeWin || undefined, {
    title: '첨부할 파일', properties: ['openFile', 'multiSelections']
  });
  if (canceled) return [];
  return filePaths.map((p) => {
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* 크기를 못 읽어도 붙일 수는 있다 */ }
    attachOk.add(p);
    return { path: p, filename: path.basename(p), size };
  });
});

/**
 * 끌어다 놓은 파일. 경로는 preload 가 진짜 File 객체에서 뽑아 보낸 것이다
 * (화면이 지어낸 글자로는 여기 못 온다 — preload.js composeDropFiles 참고).
 * 그래도 폴더나 없는 파일은 여기서 거른다.
 */
ipcMain.handle('compose:attach-dropped', (_e, paths) => {
  const out = [];
  const skipped = [];
  for (const raw of Array.isArray(paths) ? paths.slice(0, 20) : []) {
    const p = String(raw || '');
    if (!p || !path.isAbsolute(p)) continue;
    let st;
    try { st = fs.statSync(p); } catch { skipped.push({ name: path.basename(p), why: '파일을 못 읽었습니다' }); continue; }
    if (st.isDirectory()) { skipped.push({ name: path.basename(p), why: '폴더는 붙일 수 없습니다' }); continue; }
    attachOk.add(p);
    out.push({ path: p, filename: path.basename(p), size: st.size });
  }
  return { files: out, skipped };
});

const ATTACH_MAX = 25 * 1024 * 1024;   // 대부분의 메일 서버가 이쯤에서 거절한다
// 본문 그림 하나 — 화면(renderer/pastepick.js)이 붙여넣기·«그림» 단추에서 이 아래로 줄여 넣는다
const IMAGE_MAX = 5 * 1024 * 1024;
// «그림» 단추로 고른 파일을 읽는 한도 — 이보다 크면 읽지 않고 까닭을 돌려준다 (줄이는 것은 화면 몫)
const IMAGE_READ_MAX = 30 * 1024 * 1024;

/** 화면이 «얼마까지 되는지»를 미리 알려줄 수 있게 */
ipcMain.handle('compose:limits', () => ({
  attachMax: ATTACH_MAX, imageMax: IMAGE_MAX, draftHtmlMax: store.DRAFT_HTML_MAX
}));

// 본문 그림(msg.inline) — 화면이 data: 그림을 떼어 cid 로 넘긴 것 (compose.js bodyForSend).
// 화면이 준 것이라 그대로 믿지 않는다: 메일 클라이언트가 그리는 형식만, base64 글자만, 우리가 붙이는 cid 꼴만.
// 어긋나면 그 그림만 말 없이 빼지 않고 통째로 거절한다 — 본문에 보이던 그림이 빠진 채 나가면 받는 사람이 되묻고 나서야 안다.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const INLINE_COUNT = 300;                       // 서명 로고가 줄줄이 달린 인용문도 넉넉히
const INLINE_ONE = IMAGE_MAX + 64 * 1024;       // 화면이 줄여 넣는 한도 + 조금
const INLINE_CID = /^img\d{1,6}@hibi$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
// 이름에 못 오는 글자 — 제어 글자(C0·C1·머리글을 끊는 줄바꿈), 경로 글자, 줄·문단 구분, 글자 방향을 바꾸는 표시와 BOM.
// 방향 표시(RLO 등)가 있으면 «사진\u202egnp.exe» 가 받는 쪽에 «사진exe.png» 처럼 보인다. 화면(renderer/pastepick.js safeName)도 같은 글자를 뺀다
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff/\\]/;
// 형식마다 받는 확장자 — 다르면(.exe 등) 첫째 것으로 바꿔 싣는다 (화면 nameFor 와 같은 표)
const INLINE_EXT = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/gif': ['gif'] };
function inlineName(filename, type) {
  const exts = INLINE_EXT[type];
  const m = filename.match(/\.([A-Za-z0-9]{1,8})$/);
  if (m && exts.includes(m[1].toLowerCase())) return filename;
  return `${m ? filename.slice(0, -m[0].length) : filename}.${exts[0]}`;
}

/**
 * @returns { parts: [{ cid, contentType, base64, filename }], bytes } 또는 { message } (거절)
 */
function inlineOf(list) {
  if (list === undefined || list === null) return { parts: [], bytes: 0 };
  const no = (why, message) => {
    evlog.log('메일', `보내기 거절 · 본문 그림 ${why}`);
    return { message };
  };
  if (!Array.isArray(list)) return no('꼴이 배열이 아님', '본문 그림을 읽지 못했습니다 — 다시 넣어 주세요');
  if (list.length > INLINE_COUNT) return no('너무 많음', `본문 그림이 너무 많습니다 (최대 ${INLINE_COUNT}개)`);
  const parts = [];
  const seen = new Set();
  let bytes = 0;
  for (const a of list) {
    if (!a || typeof a !== 'object') return no('항목이 객체가 아님', '본문 그림을 읽지 못했습니다 — 다시 넣어 주세요');
    const cid = typeof a.cid === 'string' ? a.cid : '';
    if (!INLINE_CID.test(cid) || seen.has(cid)) return no('cid 꼴이 다름', '본문 그림 표시가 잘못됐습니다 — 다시 넣어 주세요');
    seen.add(cid);
    const type = typeof a.contentType === 'string' ? a.contentType.toLowerCase() : '';
    if (!INLINE_TYPES.has(type)) return no('형식이 다름', '본문 그림은 PNG·JPEG·GIF만 보낼 수 있습니다');
    const b64 = a.base64;
    if (typeof b64 !== 'string' || !b64 || b64.length % 4 || !B64.test(b64)) {
      return no('자료가 base64 가 아님', '본문 그림 자료가 잘못됐습니다 — 다시 넣어 주세요');
    }
    const size = (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    if (size > INLINE_ONE) return no('하나가 너무 큼', `본문 그림 하나가 너무 큽니다 (최대 ${Math.round(IMAGE_MAX / 1048576)}MB)`);
    const filename = typeof a.filename === 'string' ? a.filename : '';
    // 제어·방향 글자·경로 글자는 이름에 못 온다 — 화면은 nameFor 로 다듬어 보낸다
    if (!filename || filename.length > 200 || BAD_NAME.test(filename)) {
      return no('이름 꼴이 다름', '본문 그림 이름이 잘못됐습니다 — 다시 넣어 주세요');
    }
    parts.push({ cid, contentType: type, base64: b64, filename: inlineName(filename, type) });
    bytes += size;
  }
  return { parts, bytes };
}

ipcMain.handle('compose:send', async (e, msg) => {
  // 보내기는 쓰기 창만 — 메일 보기 창(남의 HTML)이 뚫려도 사용자 계정으로 메일을 내보내지 못하게 (fromComposeWin)
  if (!fromComposeWin(e)) {
    evlog.log('메일', '보내기 거절 · 쓰기 창이 아닌 곳에서 옴');
    return { ok: false, message: '쓰기 창에서만 보낼 수 있습니다' };
  }
  // 화면 쪽 잠금이 풀린 틈에 두 번 들어와도 두 번 나가지 않게 한다
  if (sendingNow) return { ok: false, message: '이미 보내는 중입니다' };
  const acc = host.mailAccountsForUse().find((a) => a.id === (composePayload && composePayload.accountId));
  if (!acc) return { ok: false, message: '계정을 찾을 수 없습니다' };

  const picked = Array.isArray(msg && msg.attachments) ? msg.attachments : [];
  // 복사·답장·전달로 실어둔 것은 id로 안다 — 바이트는 메인에만 있다.
  // 화면에서 칩을 뺐으면 그 id 가 안 온다 — 온 것만 싣는다.
  const carriedById = new Map((composeCarried || []).map((f) => [f.id, f]));
  const usedIds = new Set();
  const outAtts = [];
  let bytes = 0;
  for (const a of picked) {
    if (a && a.carried) {
      // 화면이 준 것은 «이 id를 보내달라»는 표시뿐이다. 실물은 메인에서 꺼낸다 —
      // 화면이 뚫려도 우리가 실어둔 것만 나간다. 함께 온 이름·바이트·경로는 보지 않는다.
      const f = carriedById.get(a.id);
      // 모르는 id 는 아무것도 싣지 않는다. 빼고 보내지도 않는다 — 화면에 붙어 보이던 파일이
      // 말 없이 빠진 채 나가면 받는 사람이 되묻고 나서야 안다. 다시 열면 맞는 id 가 온다.
      if (!f) {
        evlog.log('메일', '보내기 거절 · 실어둔 적 없는 첨부 id');
        return { ok: false, message: '원문 첨부를 찾지 못했습니다 — 다시 열어주세요' };
      }
      if (usedIds.has(f.id)) continue;   // 같은 칩이 두 번 와도 한 번만 싣는다
      usedIds.add(f.id);
      outAtts.push({ filename: f.filename, content: f.content, contentType: f.contentType });
      bytes += f.size || (f.content ? f.content.length : 0);
    } else {
      // 대화상자로 사용자가 직접 고른 것만. 화면이 준 경로를 그대로 믿지 않는다.
      if (!attachOk.has(a && a.path)) {
        return { ok: false, message: '첨부는 «파일 첨부»로 고른 것만 보낼 수 있습니다' };
      }
      outAtts.push({ path: a.path, filename: a.filename });
      try { bytes += fs.statSync(a.path).size; } catch { /* 없으면 보낼 때 걸린다 */ }
    }
  }
  // 본문 그림도 메일 크기다 — 첨부와 합쳐 한도를 본다 (붙여넣은 화면 캡처 몇 장이면 금방 찬다)
  const inline = inlineOf(msg && msg.inline);
  if (inline.message) return { ok: false, message: inline.message };
  // 본문 글(html·text)도 센다 — 화면이 cid 로 못 뗀 data: 그림이 html 에 남으면 그만큼 한도 밖으로 나가던 길을 막는다
  const textBytes = Buffer.byteLength(String((msg && msg.html) || '')) + Buffer.byteLength(String((msg && msg.text) || ''));
  const fileBytes = bytes;
  bytes += inline.bytes + textBytes;
  if (bytes > ATTACH_MAX) {
    const what = textBytes > fileBytes + inline.bytes ? '본문이'
      : fileBytes && inline.bytes ? '첨부와 본문 그림이' : inline.bytes ? '본문 그림이' : '첨부가';
    return { ok: false, message: `${what} 너무 큽니다 (${Math.round(bytes / 1048576)}MB · 최대 25MB)` };
  }

  sendingNow = true;
  let r;
  try {
    // 화면이 준 inline 이 아니라 확인한 것만 싣는다
    r = await send.sendMail(acc, { ...msg, inline: inline.parts, attachments: outAtts });
  } finally {
    sendingNow = false;
  }
  evlog.log('메일', r.ok
    ? `보냄 · ${r.accepted}명${r.rejected && r.rejected.length ? ` · 거절 ${r.rejected.join(',')}` : ''}`
      + `${r.sentBox ? ` · 보낸편지함(${r.sentBox})에 저장` : ''}`
    : `보내기 실패 · ${r.message}`);
  if (r.ok) {
    // 보낸 주소는 다음부터 자동완성된다 — 주소록을 손으로 채우게 하면 아무도 안 채운다.
    // 받은 것보다 무겁게 센다: 내가 답장한 사람이 진짜 아는 사람이다.
    // 소식지는 매일 오지만 나는 한 번도 답하지 않는다.
    store.rememberContacts([
      ...send.addresses(msg.to), ...send.addresses(msg.cc), ...send.addresses(msg.bcc)
    ].map((a) => ({ address: a.replace(/^.*<|>.*$/g, '').trim(), name: '' })), { weight: 5 });
    // 나갔으면 임시 저장은 지운다 — 안 그러면 다음에 «쓰기»를 눌렀을 때
    // 방금 보낸 메일이 그대로 다시 떠서 두 번 보내게 된다.
    store.clearMailDraft();
    host.refreshMail();
  }
  return r;
});

/**
 * 목록에서 오른쪽 클릭 — 여기가 규칙을 만드는 주된 길이다.
 *
 * 설정 화면에 들어가 조건을 손으로 적게 하면 아무도 안 쓴다.
 * 「이 광고 또 왔네」 하는 그 순간에 두 번 눌러 끝나야 한다.
 *
 * HTML 메뉴가 아니라 진짜 메뉴를 쓴다 — 위젯은 작고 테두리가 없어서
 * 직접 그리면 창 밖으로 잘린다.
 */

/**
 * 본문에 넣을 그림 — 대화상자로 고른 것만 읽어 화면에 돌려준다.
 * 예전엔 5MB 넘는 것을 말 없이 건너뛰었다 (사진 한 장이 그냥 안 들어갔다). 이제는 넘기고 화면이 줄인다
 * (붙여넣기와 같은 길 — renderer/compose.js). 너무 큰 것·못 읽는 것만 까닭과 함께 skipped 로 돌려준다 (이름만, 경로는 안 준다).
 * @returns { images: [{ filename, contentType, size, dataUrl }], skipped: [{ name, why }] }
 */
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
// 한 번에 읽어 넘기는 양 — 큰 그림 여러 장을 한 답으로 넘기면 화면 메모리가 치솟고 줄이는 데도 한참 걸린다
const PICK_COUNT = 20;
const PICK_TOTAL = 60 * 1024 * 1024;
ipcMain.handle('compose:pick-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(composeWin || undefined, {
    title: '본문에 넣을 그림',
    filters: [{ name: '그림', extensions: Object.keys(IMAGE_TYPES) }],
    properties: ['openFile', 'multiSelections']
  });
  const images = [];
  const skipped = [];
  if (canceled) return { images, skipped };
  let total = 0;
  for (const p of filePaths || []) {
    const name = path.basename(p);
    try {
      const size = fs.statSync(p).size;
      if (size > IMAGE_READ_MAX) {
        skipped.push({ name, why: `${Math.round(IMAGE_READ_MAX / 1048576)}MB가 넘는 그림은 넣을 수 없습니다` });
        continue;
      }
      if (images.length >= PICK_COUNT) {
        skipped.push({ name, why: `한 번에 ${PICK_COUNT}장까지 넣을 수 있습니다 — 나눠서 넣어 주세요` });
        continue;
      }
      if (total + size > PICK_TOTAL) {
        skipped.push({ name, why: `한 번에 넣는 그림이 ${Math.round(PICK_TOTAL / 1048576)}MB를 넘습니다 — 나눠서 넣어 주세요` });
        continue;
      }
      const buf = fs.readFileSync(p);
      total += buf.length;
      const type = IMAGE_TYPES[path.extname(p).slice(1).toLowerCase()] || 'image/png';
      images.push({ filename: name, contentType: type, size: buf.length, dataUrl: `data:${type};base64,${buf.toString('base64')}` });
    } catch {
      skipped.push({ name, why: '파일을 못 읽었습니다' });
    }
  }
  return { images, skipped };
});

ipcMain.handle('compose:bounds', () => {
  if (!composeWin || composeWin.isDestroyed()) return { x: 0, y: 0, width: 520, height: 520 };
  return composeWin.getBounds();
});
ipcMain.on('compose:move', (_e, { x, y }) => {
  if (!composeWin || composeWin.isDestroyed() || !composeSize) return;
  // setPosition은 배율이 100%가 아닐 때 호출마다 창을 부풀린다 — 크기를 못박아 옮긴다
  composeWin.setBounds({ x: Math.round(x), y: Math.round(y), ...composeSize });
});
ipcMain.on('compose:set-bounds', (_e, { x, y, width, height, dir }) => {
  if (!composeWin || composeWin.isDestroyed()) return;
  const max = maxSize();
  const w = Math.round(clamp(width, 380, max.width));
  const h = Math.round(clamp(height, 320, max.height));
  const nx = Math.round(String(dir).includes('w') ? x + (width - w) : x);
  const ny = Math.round(String(dir).includes('n') ? y + (height - h) : y);
  composeSize = { width: w, height: h };
  composeWin.setBounds({ x: nx, y: ny, width: w, height: h });
  store.setSettings({ composeSize });
});

/** 보내기 설정이 맞는지 — 메일은 보내지 않고 로그인만 해 본다 */
ipcMain.handle('mail:smtp-test', async (_e, acc) => {
  const stored = store.mailAccounts.find((a) => a.id === (acc && acc.id));
  const pass = (acc && acc.pass) || secret.open(stored && stored.sealed);
  if (!pass) return { ok: false, message: '비밀번호를 입력하세요' };
  return send.verify({ ...stored, ...acc, pass });
});

module.exports = { init, startCompose, startCopy };

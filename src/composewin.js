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
// 복사(다시 보내기)로 실어둔 원문 첨부. 바이트는 여기 메인에만 둔다 —
// 화면에는 «무엇이 붙어 있나»만(이름·크기·id) 넘기고, 보낼 때 id로 다시 맞춘다.
// composePayload와 짝이다(창이 하나뿐이다). 그래서 반드시 같이 확정해야 한다 —
// 짝이 어긋나면 화면에 붙어 보이는 첨부를 못 보내게 된다.
let composeCarried = [];
// 창이 이미 열려 있어 갈아끼기를 «물어보는 중»인 첨부. 화면이 수락할 때 비로소 확정한다.
// 먼저 확정하면, 사용자가 «현재 초안 유지»를 고른 순간 그 초안의 첨부가 사라진다.
let pendingCarried = [];
let copySeq = 0;
// 보내는 중인가. 두 번 나가는 것을 막고, 그 사이에 들어오는 새 초안도 거절한다.
// openCompose가 이걸 보므로 그보다 위에 선언한다 (선언 전 사용으로 화면이 죽은 적이 여러 번 있다).
let sendingNow = false;

function openCompose(payload, carried = []) {
  if (composeWin && !composeWin.isDestroyed()) {
    // 보내는 중이면 화면이 갈아끼우기를 그냥 버린다. 그걸 성공이라고 돌려주면
    // 답장을 눌렀는데 아무 일도 안 일어나고 이유도 안 나온다 — 여기서 거절한다.
    // (이 서버는 보내는 데 수십 초가 걸려서 그 사이가 짧지 않다)
    if (sendingNow) {
      return { ok: false, message: '쓰기 창이 메일을 보내는 중입니다 — 끝나면 다시 눌러주세요' };
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
    pendingCarried = carried;
    composeWin.webContents.send('compose:replace', payload);
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
    composeWin = null; composePayload = null; composeCarried = []; pendingCarried = [];
  });
  return { ok: true, message: '' };
}

/**
 * 새 메일 / 답장 / 전달 — 어느 쪽이든 초안을 만들어 창을 연다.
 * 메일 보기 창의 «답장» 버튼과 목록의 오른쪽 클릭이 같은 길을 쓴다.
 */
function startCompose({ kind = 'new', accountId, source } = {}) {
  const accounts = host.mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: '쓸 수 있는 계정이 없습니다' };

  // 답장·전달은 반드시 그 메일을 받은 계정으로 써야 한다. 못 찾았다고 첫 계정으로 넘기면
  // 개인 메일에 회사 주소로 답장이 나간다 — 받는 사람 눈에는 그게 내 정체다.
  const asked = accounts.find((a) => a.id === accountId);
  if (!asked && kind !== 'new') {
    evlog.log('메일', `쓰기 못 열음 · 계정 ${accountId}을 목록에서 못 찾음`
      + ` (쓸 수 있는 계정: ${accounts.map((a) => a.id).join(',') || '없음'})`);
    return { ok: false, message: '이 메일을 받은 계정을 쓸 수 없습니다 (꺼져 있거나 지워졌습니다)' };
  }
  // 이어쓰는 것은 원래 쓰던 계정으로 — 그 계정이 없어졌으면 첫 계정으로 놓아둔다
  const draftAcc = kind === 'new' && store.mailDraft
    ? accounts.find((x) => x.id === store.mailDraft.accountId)
    : null;
  const acc = asked || draftAcc || accounts[0];

  // 쓰다 말은 것이 있으면 이어서 쓴다. 답장·전달은 새 초안이 분명하므로 건드리지 않는다.
  const kept = kind === 'new' ? store.mailDraft : null;
  const draft = kept
    ? {
      to: kept.to, cc: kept.cc, bcc: kept.bcc, subject: kept.subject,
      bodyHtml: kept.bodyHtml, inReplyTo: kept.inReplyTo, references: kept.references,
      restored: true, restoredAt: kept.at, restoredNames: kept.attachNames || []
    }
    : (kind === 'new' ? { to: '', subject: '', text: '' } : send.draftFrom(kind, source));
  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  evlog.log('메일', `쓰기 열기 · ${kind} · 계정 ${acc.name || acc.user}`);
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
    ...draft
  });
  if (!opened.ok) evlog.log('메일', `쓰기 못 열음 · ${opened.message}`);
  return opened;
}

ipcMain.handle('compose:open', (_e, opts) => startCompose(opts || {}));

// 본문에 박힌 그림은 «첨부»가 아니다 — 이미 본문(cid/data:)에 들어 있다.
// 그것까지 다시 실으면 그림이 두 번(본문 한 번, 첨부 한 번) 나간다.
// mailparser는 본문이 참조하는 조각에 related=true를 단다.
function realAttachments(files) {
  return (files || []).filter((a) => a && a.content && a.filename
    && !a.related && a.contentDisposition !== 'inline');
}

/**
 * 보낸 메일을 복사해 새 메일로 연다 — «다시 보내기».
 * 원문 첨부의 바이트는 메인에만 두고(composeCarried), 화면에는 이름·크기·id만 넘긴다.
 * 보낼 때 그 id로 바이트를 다시 맞춘다 — 큰 파일이 화면을 오가지 않게, 그리고
 * 화면이 뚫려도 아무 파일이나 실어 보내지 못하게.
 */
function startCopy({ accountId, view, files } = {}) {
  const accounts = host.mailAccountsForUse();
  if (!accounts.length) return { ok: false, message: '쓸 수 있는 계정이 없습니다' };
  // 보낸 메일은 그 계정으로 다시 보내는 게 자연스럽다. 못 찾으면 첫 계정으로 둔다
  // (내 보낸메일함이니 어느 계정이든 내 것이다).
  const acc = accounts.find((a) => a.id === accountId) || accounts[0];
  const draft = send.copyFrom(view || {});

  const carry = realAttachments(files).slice(0, 20).map((a) => ({
    id: `copy${++copySeq}`, filename: a.filename, size: a.content.length, content: a.content
  }));

  const stored = store.mailAccounts.find((a) => a.id === acc.id) || {};
  evlog.log('메일', `복사 열기 · 계정 ${acc.name || acc.user}`
    + (carry.length ? ` · 첨부 ${carry.length}개` : ''));
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
    // 바이트는 빼고 이름·크기·id만. 화면은 이걸로 칩을 그리고, 보낼 때 도로 넘긴다.
    attachments: carry.map(({ content, ...d }) => ({ ...d, carried: true }))
  }, carry);
  if (!opened.ok) evlog.log('메일', `복사 못 열음 · ${opened.message}`);
  return opened;
}

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
  // 단추·메뉴는 내가 보낸 메일에서만 «복사»를 보여준다. IPC도 같은 문을 지켜야 한다 —
  // 안 그러면 뚫린 화면이 받은 메일의 첨부 바이트(메인에만 두는 것)를 실어 보낼 수 있다.
  if (!v.fromSelf) return { ok: false, message: '복사는 내가 보낸 메일에서만 됩니다' };
  return startCopy({
    accountId: v.accountId,
    view: { subject: v.subject, to: v.to, cc: v.cc, text: v.text, html: v.html },
    files: slot.files
  });
});

// 쓰다 말은 것을 계속 적어둔다. 화면이 손이 멈출 때마다 보낸다 —
// 창을 닫았거나 앱이 죽어도 다음에 새 메일을 열면 그대로 나온다.
ipcMain.on('compose:draft-save', (_e, d) => {
  try { store.setMailDraft(d || null); } catch (err) { evlog.log('메일', `임시 저장 실패 — ${err.message}`); }
});
ipcMain.on('compose:draft-clear', () => store.clearMailDraft());

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
      message: '쓰던 글을 버리고 새로 여시겠습니까?',
      detail: '임시 저장은 한 통뿐이라 새 글을 쓰기 시작하면 지금 글은 사라집니다.\n'
        + '지금 글을 지키려면 «그만두기»를 누르고 먼저 보내거나 닫으세요.'
    });
    return r === 0 ? 'discard' : 'cancel';
  }
  if (kind === 'discard') {
    const r = await askUser(win, {
      buttons: ['버리기', '그만두기'],
      defaultId: 1,
      title: '새로 쓰기',
      message: '이어쓰던 글을 버릴까요?',
      detail: '빈 메일로 시작합니다. 버린 글은 되돌릴 수 없습니다.'
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

ipcMain.handle('compose:data', () => composePayload);
ipcMain.on('compose:close', () => composeWin && !composeWin.isDestroyed() && composeWin.close());
/**
 * 화면이 «갈아끼워도 좋다»고 하면 그때 초안을 바꾼다.
 * 실어둔 첨부도 바로 이 순간에 확정한다 — payload와 짝을 맞춰야, «유지»를 골랐을 때
 * 옛 초안이 제 첨부를 그대로 들고 있게 된다.
 */
ipcMain.on('compose:accept-replace', (_e, payload) => {
  composePayload = payload;
  composeCarried = pendingCarried;
  pendingCarried = [];
});
/** 새 메일에서 보낼 계정을 바꾼다 */
ipcMain.on('compose:set-account', (_e, id) => {
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

const ATTACH_MAX = 25 * 1024 * 1024;   // 대부분의 메일 서버가 이쯤에서 거절한다

ipcMain.handle('compose:send', async (_e, msg) => {
  // 화면 쪽 잠금이 풀린 틈에 두 번 들어와도 두 번 나가지 않게 한다
  if (sendingNow) return { ok: false, message: '이미 보내는 중입니다' };
  const acc = host.mailAccountsForUse().find((a) => a.id === (composePayload && composePayload.accountId));
  if (!acc) return { ok: false, message: '계정을 찾을 수 없습니다' };

  const picked = (msg && msg.attachments) || [];
  // 복사(다시 보내기)로 실어둔 것은 id로 안다 — 바이트는 메인에만 있다.
  const carriedById = new Map((composeCarried || []).map((f) => [f.id, f]));
  const outAtts = [];
  let bytes = 0;
  for (const a of picked) {
    if (a && a.carried) {
      // 화면이 준 것은 «이 id를 보내달라»는 표시뿐이다. 실물은 메인에서 꺼낸다 —
      // 화면이 뚫려도 우리가 실어둔 것만 나간다.
      const f = carriedById.get(a.id);
      if (!f) return { ok: false, message: '복사한 첨부를 찾지 못했습니다 (다시 열어주세요)' };
      outAtts.push({ filename: f.filename, content: f.content });
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
  if (bytes > ATTACH_MAX) {
    return { ok: false, message: `첨부가 너무 큽니다 (${Math.round(bytes / 1048576)}MB · 최대 25MB)` };
  }

  sendingNow = true;
  let r;
  try {
    r = await send.sendMail(acc, { ...msg, attachments: outAtts });
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

/** 본문에 넣을 그림 — 대화상자로 고른 것만 읽어 화면에 돌려준다 */
const IMAGE_MAX = 5 * 1024 * 1024;
ipcMain.handle('compose:pick-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(composeWin || undefined, {
    title: '본문에 넣을 그림',
    filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled) return [];
  const out = [];
  for (const p of filePaths) {
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > IMAGE_MAX) continue;   // 본문 그림은 크면 메일이 통째로 무거워진다
      const ext = path.extname(p).slice(1).toLowerCase();
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
      out.push({
        filename: path.basename(p),
        contentType: type,
        dataUrl: `data:${type};base64,${buf.toString('base64')}`
      });
    } catch { /* 못 읽는 파일은 건너뛴다 */ }
  }
  return out;
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

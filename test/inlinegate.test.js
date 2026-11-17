'use strict';
// 본문 그림의 메인 쪽 문 — 보내기·그림 고르기·임시 저장.
//
// 붙여넣기로 본문 그림이 흔해진다 (사용자: «메일 작성할때 이미지 붙이기 기능»). 화면이 넘기는 본문 그림(msg.inline)을
// 메인이 그대로 믿으면 안 되고, 크기 한도에도 들어가야 한다:
//   [1] compose:send — 본문 그림 바이트도 25MB 한도에 센다 (첨부와 합쳐서). 넘으면 안 보내고 말한다
//   [2] compose:send — 본문 그림 꼴 확인: 형식(PNG·JPEG·GIF 만) · base64 글자 · cid(imgN@hibi, 겹침 없음) · 이름 ·
//       하나 5MB(+조금) · 개수. 어긋나면 말 없이 빼지 않고 거절한다. 맞으면 나간 원문에 그 바이트 그대로
//   [3] compose:pick-image — 5MB 넘는 그림도 말 없이 빼지 않는다 (화면이 줄인다). 30MB 넘는 것만 까닭과 함께 뺀다
//   [4] compose:limits — 화면이 쓸 한도 (첨부 25MB · 그림 5MB · 임시 저장 본문 2MB)
//   [5] store.setMailDraft — 본문 HTML 을 자르지 않는다. 넘으면 data: 그림을 자리표로 (droppedPics),
//       그래도 넘으면 본문을 비우고 bodyDropped. 보통 초안은 예전과 같은 칸만
//   [6] 이어 쓰기 — 초안의 droppedPics·bodyDropped 를 쓰기 창에 넘긴다 (restoredPicsGone·restoredBodyGone)
//
// 창은 하나도 안 만든다 — src 쪽 모듈이 받는 electron 의 BrowserWindow 를 창 없는 가짜로, dialog 를 지어낸 답으로 바꿔 끼운다.
// 앱(main.js)은 안 띄운다. 메일 서버에는 안 붙는다 — nodemailer 의 운반과 IMAP 접속을 가짜로 바꿔 만든 원문만 받아 둔다.
// 설정 파일은 임시 폴더에만 생긴다. 주소는 지어낸 것이다 (.invalid).
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const electron = require('electron');
const { app } = electron;

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 90_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inlinegate-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

// npm test 는 실패 줄만 보여 준다 — PASTE_TEST_LOG 에 파일을 주면 모든 줄을 거기에도 적는다
if (process.env.PASTE_TEST_LOG) {
  for (const k of ['log', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      try { fs.appendFileSync(process.env.PASTE_TEST_LOG, `${a.map(String).join(' ')}\n`); } catch { /* 적지 못해도 시험은 간다 */ }
      orig(...a);
    };
  }
}

const MB = 1024 * 1024;
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${s.length > 200 ? `${s.slice(0, 200)}…` : s}` : ''));
  if (!c) bad++;
};

// ── 창 없는 가짜 창 ──
const wins = [];
class FakeWin {
  constructor(opts) {
    this.opts = opts;
    this.destroyed = false;
    this.events = {};
    const n = wins.length + 1;
    this.webContents = {
      id: 7000 + n, sent: [],
      send: (ch, p) => { this.webContents.sent.push([ch, p]); },
      on() {}, once() {}, setWindowOpenHandler() {},
      isLoading: () => false,
      mainFrame: { processId: 1, routingId: n }
    };
    wins.push(this);
  }
  loadFile(file) { this.file = file; return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  on(ev, fn) { (this.events[ev] = this.events[ev] || []).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  getSize() { return [520, 520]; }
  getBounds() { return { x: 0, y: 0, width: 520, height: 520 }; }
  setBounds() {}
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  isVisible() { return false; }
  show() {} showInactive() {} focus() {} moveTop() {} restore() {} hide() {}
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fn of this.events.closed || []) fn();
  }
  destroy() { this.close(); }
  static getAllWindows() { return wins.filter((w) => !w.destroyed); }
  static fromWebContents(wc) { return wins.find((w) => w.webContents === wc) || null; }
}
const handlers = new Map();
const fakeIpc = {
  handle: (ch, fn) => { handlers.set(ch, fn); },
  on: (ch, fn) => { handlers.set(ch, fn); },
  once() {}, removeHandler() {}, removeAllListeners() {}
};
// 파일 대화상자는 안 뜬다 — 시험이 고른 것처럼 답을 지어 준다
let dialogAnswer = { canceled: true, filePaths: [] };
const fakeDialog = {
  showOpenDialog: async () => dialogAnswer,
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox() {}
};
const fakeElectron = {};
const swapped = { BrowserWindow: FakeWin, ipcMain: fakeIpc, dialog: fakeDialog };
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

// ── 서버 대신 ──
const nodemailer = require('nodemailer');
const sent = [];
nodemailer.createTransport = () => ({
  sendMail: async ({ envelope, raw }) => {
    sent.push({ envelope, raw: Buffer.from(raw) });
    return { accepted: [].concat(envelope.to), rejected: [], messageId: `<t${sent.length}@test.invalid>` };
  },
  close() {}
});
const { simpleParser } = require('mailparser');

const ACC = { id: 'acc1', name: '시험 계정', user: 'me@example.invalid', host: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', smtpPort: 587 };
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const pic = (n, cid = `img${n}@hibi`, extra = {}) => ({ cid, contentType: 'image/png', base64: PNG.toString('base64'), filename: `그림${n}.png`, ...extra });
const bigPic = (n, bytes) => pic(n, undefined, { contentType: 'image/jpeg', base64: Buffer.alloc(bytes, n).toString('base64'), filename: `큰${n}.jpg` });

app.whenReady().then(async () => {
  const mail = require(path.join(SRC, 'mail.js'));
  mail.connect = () => ({
    connect: async () => {}, close() {}, logout: async () => {},
    list: async () => [{ specialUse: '\\Sent', path: 'Sent', name: 'Sent' }],
    append: async () => {}
  });
  const popup = require(path.join(SRC, 'popup.js'));
  popup.askUser = async () => 1;
  popup.pickFromMenu = async () => null;
  const store = require(path.join(SRC, 'store.js'));
  const composewin = require(path.join(SRC, 'composewin.js'));
  composewin.init({
    mailAccountsForUse: () => [ACC],
    noAccountMessage: () => '계정 없음 (시험)',
    refreshMail: async () => {},
    slotOf: () => null,
    doTrash: async () => ({ moved: false })
  });
  const composeWin = () => FakeWin.getAllWindows().find((w) => String(w.file || '').endsWith('compose.html')) || null;
  const own = () => { const wc = composeWin().webContents; return { sender: wc, senderFrame: wc.mainFrame }; };
  const data = () => handlers.get('compose:data')(own());

  let r = composewin.startCompose({ kind: 'new', accountId: ACC.id });
  ok(r && r.ok && composeWin(), '쓰기 창(가짜)을 연다', r);
  const sendMsg = (extra) => handlers.get('compose:send')(own(), {
    to: 'friend@example.invalid', subject: '그림 시험', text: '본문', html: '<p>본문 <img src="cid:img1@hibi"></p>', attachments: [], ...extra
  });

  console.log('\n[2] 본문 그림 꼴 확인');
  r = await sendMsg({ inline: [pic(1), pic(2, 'img2@hibi', { contentType: 'image/jpeg' }), pic(3, 'img3@hibi', { contentType: 'image/gif' })] });
  ok(r && r.ok && sent.length === 1, 'PNG·JPEG·GIF 셋 — 보낸다', r);
  const p = await simpleParser(sent[0].raw, { keepCidLinks: true });
  const ins = p.attachments.filter((a) => a.contentDisposition !== 'attachment');
  ok(ins.length === 3 && ins.every((a) => a.content.equals(PNG)) && ins.map((a) => a.cid).join() === 'img1@hibi,img2@hibi,img3@hibi',
    '  나간 원문에 cid 그림 셋, 바이트 그대로', ins.map((a) => [a.cid, a.contentType, a.size]));
  // 이름의 확장자는 형식에 맞춘다 — image/jpeg 인데 «그림2.png» 면 «그림2.jpg» (받는 쪽에 형식과 다른 이름이 가지 않게)
  ok(ins.map((a) => a.filename).join() === '그림1.png,그림2.jpg,그림3.gif', '  이름 그대로 (확장자만 형식에 맞춘다)', ins.map((a) => a.filename));

  const before = sent.length;
  const BAD = [
    ['형식 text/html', [pic(1, undefined, { contentType: 'text/html' })]],
    ['형식 image/svg+xml', [pic(1, undefined, { contentType: 'image/svg+xml' })]],
    ['형식 image/webp (화면이 PNG 로 바꿔 보내야 한다)', [pic(1, undefined, { contentType: 'image/webp' })]],
    ['형식 없음', [pic(1, undefined, { contentType: undefined })]],
    ['base64 에 다른 글자', [pic(1, undefined, { base64: '<script>alert(1)</script>AAAA' })]],
    ['base64 길이가 4의 배수가 아님', [pic(1, undefined, { base64: 'QUJD' + 'QQ' })]],
    ['base64 가 빈 값', [pic(1, undefined, { base64: '' })]],
    ['base64 가 글이 아님', [pic(1, undefined, { base64: { length: 4 } })]],
    ['cid 꼴이 다름 (evil@x)', [pic(1, 'evil@x')]],
    ['cid 에 꺾쇠', [pic(1, '<img1@hibi>')]],
    ['cid 겹침', [pic(1), pic(2, 'img1@hibi')]],
    // 검증에서 더함 — 앞만 맞고 뒤에 꼬리가 붙은 cid (머리글 줄바꿈·다른 도메인)
    ['cid 뒤에 꼬리 (img1@hibi.evil.invalid)', [pic(1, 'img1@hibi.evil.invalid')]],
    ['cid 끝에 줄바꿈 머리글', [pic(1, 'img1@hibi\r\nX-Evil: 1')]],
    // 위 «다른 글자» 는 길이(29)에서 먼저 걸린다 — 길이가 4의 배수인 꼴로 글자 검사 자체를 본다
    ['base64 에 다른 글자 (길이는 4의 배수)', [pic(1, undefined, { base64: '<svg onload=x>AA' })]],
    ['이름에 경로 (../)', [pic(1, undefined, { filename: '../../x.png' })]],
    ['이름에 역슬래시', [pic(1, undefined, { filename: 'C:\\x\\y.png' })]],
    ['이름에 줄바꿈', [pic(1, undefined, { filename: 'a\r\nContent-Type: text/html.png' })]],
    ['이름이 너무 김', [pic(1, undefined, { filename: `${'가'.repeat(300)}.png` })]],
    // 받는 쪽에서 «사진exe.png» 처럼 보이게 하는 방향 바꾸기 글자 · C1 · 줄 구분
    ['이름에 U+202E (RLO)', [pic(1, undefined, { filename: '사진\u202egnp.exe' })]],
    ['이름에 U+0085 (C1 NEL)', [pic(1, undefined, { filename: 'a\u0085b.png' })]],
    ['이름에 U+2028 (줄 구분)', [pic(1, undefined, { filename: 'a\u2028b.png' })]],
    ['이름에 U+2066 (방향 격리)', [pic(1, undefined, { filename: 'a\u2066b.png' })]],
    ['그림 하나가 5MB 를 크게 넘음', [bigPic(1, 6 * MB)]],
    ['개수가 너무 많음', Array.from({ length: 301 }, (_, i) => pic(i + 1))],
    ['배열이 아님', { cid: 'img1@hibi' }],
    ['항목이 객체가 아님', ['img1@hibi']]
  ];
  for (const [name, inline] of BAD) {
    r = await sendMsg({ inline });
    ok(r && r.ok === false && typeof r.message === 'string' && /[가-힣]/.test(r.message) && sent.length === before,
      `${name} → 거절 (안 보냄, 한국어 알림)`, r && r.message);
  }
  r = await sendMsg({ inline: [] });
  ok(r && r.ok && sent.length === before + 1, '본문 그림 없음([]) → 그냥 보낸다', r);
  r = await sendMsg({ inline: undefined });
  ok(r && r.ok && sent.length === before + 2, 'inline 칸이 없어도 → 그냥 보낸다 (예전 꼴)', r);
  r = await sendMsg({ inline: [bigPic(1, 5 * MB)] });
  ok(r && r.ok && sent.length === before + 3, '딱 5MB 그림 하나 → 보낸다', r && r.message);

  console.log('\n[1] 한도 25MB — 본문 그림도 센다');
  const n1 = sent.length;
  r = await sendMsg({ inline: [1, 2, 3, 4, 5, 6].map((k) => bigPic(k, Math.round(4.5 * MB))) });
  ok(r && r.ok === false && /25MB/.test(r.message) && sent.length === n1, '본문 그림 4.5MB × 6 = 27MB → 거절 (첨부는 없어도)', r && r.message);
  // 대화상자로 고른 첨부 하나 (임시 폴더의 지어낸 파일) + 본문 그림
  const filePath = path.join(tmp, 'report.bin');
  fs.writeFileSync(filePath, Buffer.alloc(12 * MB, 1));
  dialogAnswer = { canceled: false, filePaths: [filePath] };
  const picked = await handlers.get('compose:attach')();
  ok(Array.isArray(picked) && picked.length === 1 && picked[0].size === 12 * MB, '  «파일 첨부»로 12MB 하나 (가짜 대화상자)', picked && picked.map((a) => a.size));
  r = await sendMsg({ attachments: picked, inline: [1, 2, 3].map((k) => bigPic(k, Math.round(4.5 * MB))) });
  ok(r && r.ok === false && /25MB/.test(r.message) && sent.length === n1, '첨부 12MB + 본문 그림 13.5MB = 25.5MB → 거절', r && r.message);
  r = await sendMsg({ attachments: picked, inline: [1, 2].map((k) => bigPic(k, Math.round(4.5 * MB))) });
  ok(r && r.ok && sent.length === n1 + 1, '첨부 12MB + 본문 그림 9MB = 21MB → 보낸다', r && r.message);
  // html·text 도 메일 크기다 — html 에 남은 data: 그림(화면이 못 뗀 꼴)이 한도 밖으로 나가지 않게
  const n2 = sent.length;
  r = await sendMsg({ html: `<p>${'a'.repeat(26 * MB)}</p>`, inline: [] });
  ok(r && r.ok === false && /25MB/.test(r.message) && /본문/.test(r.message) && sent.length === n2, 'html 26MB (첨부·본문 그림 없음) → 거절 «본문이 너무 큽니다»', r && r.message);
  r = await sendMsg({ attachments: picked, html: `<p>${'a'.repeat(8 * MB)}</p>`, text: 'b'.repeat(6 * MB), inline: [] });
  ok(r && r.ok === false && /25MB/.test(r.message) && sent.length === n2, '  첨부 12MB + html 8MB + text 6MB = 26MB → 거절', r && r.message);
  r = await sendMsg({ attachments: picked, html: `<p>${'a'.repeat(4 * MB)}</p>`, inline: [] });
  ok(r && r.ok && sent.length === n2 + 1, '  첨부 12MB + html 4MB → 보낸다', r && r.message);

  console.log('\n[2b] 형식과 안 맞는 확장자는 형식 확장자로');
  const n3 = sent.length;
  r = await sendMsg({ inline: [pic(1, undefined, { filename: '사진.exe' })] });
  ok(r && r.ok && sent.length === n3 + 1, 'image/png 인데 이름이 .exe → 보내되', r && r.message);
  const p2 = await simpleParser(sent[sent.length - 1].raw, { keepCidLinks: true });
  const nm = p2.attachments.map((a) => a.filename);
  ok(nm.length === 1 && nm[0] === '사진.png', '  나간 이름은 사진.png', nm);

  console.log('\n[3] compose:pick-image — 5MB 넘는 그림도 넘긴다');
  const smallPng = path.join(tmp, '작은.png');
  const bigJpg = path.join(tmp, '큰 사진.jpg');
  const hugePng = path.join(tmp, 'huge.png');
  const webp = path.join(tmp, '로고.webp');
  fs.writeFileSync(smallPng, PNG);
  fs.writeFileSync(bigJpg, Buffer.alloc(7 * MB, 2));
  fs.writeFileSync(hugePng, Buffer.alloc(31 * MB, 3));
  fs.writeFileSync(webp, Buffer.from('RIFF0000WEBPVP8 '));
  dialogAnswer = { canceled: false, filePaths: [smallPng, bigJpg, hugePng, webp, path.join(tmp, '없는.png')] };
  const got = await handlers.get('compose:pick-image')();
  const imgs = got && got.images;
  ok(imgs && imgs.map((i) => i.filename).join('|') === '작은.png|큰 사진.jpg|로고.webp', '작은 것·7MB·WebP 는 넘긴다 (7MB 를 말 없이 빼지 않는다)', imgs && imgs.map((i) => i.filename));
  ok(imgs && imgs[1].contentType === 'image/jpeg' && imgs[1].size === 7 * MB && imgs[1].dataUrl.startsWith('data:image/jpeg;base64,')
    && Buffer.from(imgs[1].dataUrl.split(',')[1], 'base64').length === 7 * MB, '  7MB 사진은 바이트 그대로 (줄이는 것은 화면 몫)', imgs && { type: imgs[1].contentType, size: imgs[1].size });
  ok(imgs && imgs[2].contentType === 'image/webp' && imgs[0].contentType === 'image/png', '  형식은 확장자로', imgs && imgs.map((i) => i.contentType));
  ok(got && Array.isArray(got.skipped) && got.skipped.length === 2 && got.skipped[0].name === 'huge.png' && /30MB/.test(got.skipped[0].why)
    && got.skipped[1].name === '없는.png' && /[가-힣]/.test(got.skipped[1].why), '  30MB 넘는 것·못 읽는 것은 까닭과 함께 skipped', got && got.skipped);
  ok(!JSON.stringify(got.skipped).includes(tmp), '  skipped 에 경로는 없다 (이름만)');
  dialogAnswer = { canceled: true, filePaths: [] };
  const none = await handlers.get('compose:pick-image')();
  ok(none && Array.isArray(none.images) && none.images.length === 0 && none.skipped.length === 0, '  그만두면 빈 답', none);
  // 한 번에 고른 양에도 한도 — 큰 그림 여러 장을 한 번의 답으로 넘기면 화면 메모리가 치솟는다
  const many = Array.from({ length: 21 }, (_, i) => { const p = path.join(tmp, `m${i}.png`); fs.writeFileSync(p, PNG); return p; });
  dialogAnswer = { canceled: false, filePaths: many };
  let g = await handlers.get('compose:pick-image')();
  ok(g.images.length === 20 && g.skipped.length === 1 && g.skipped[0].name === 'm20.png' && /한 번에/.test(g.skipped[0].why),
    '21장 고름 → 20장만, 나머지는 까닭과 함께 skipped', { images: g.images.length, skipped: g.skipped });
  const big29a = path.join(tmp, '큰a.png');
  const big29b = path.join(tmp, '큰b.png');
  const ten = path.join(tmp, '열.png');
  fs.writeFileSync(big29a, Buffer.alloc(29 * MB, 4));
  fs.writeFileSync(big29b, Buffer.alloc(29 * MB, 5));
  fs.writeFileSync(ten, Buffer.alloc(10 * MB, 6));
  dialogAnswer = { canceled: false, filePaths: [big29a, big29b, ten, smallPng] };
  g = await handlers.get('compose:pick-image')();
  ok(g.images.map((i) => i.filename).join('|') === '큰a.png|큰b.png|작은.png' && g.skipped.length === 1 && g.skipped[0].name === '열.png' && /한 번에/.test(g.skipped[0].why),
    '  29MB + 29MB + 10MB → 합이 60MB 를 넘는 것만 skipped (작은 것은 넘긴다)', { images: g.images.map((i) => i.filename), skipped: g.skipped });
  for (const p of [...many, big29a, big29b, ten]) fs.rmSync(p, { force: true });

  console.log('\n[4] compose:limits');
  const lim = await handlers.get('compose:limits')();
  ok(lim && lim.attachMax === 25 * MB && lim.imageMax === 5 * MB && lim.draftHtmlMax === 2 * MB, '첨부 25MB · 그림 5MB · 임시 저장 본문 2MB', lim);

  console.log('\n[5] store.setMailDraft — 본문을 자르지 않는다');
  const base = { accountId: ACC.id, kind: 'new', title: '새 메일', to: 'a@example.invalid', cc: '', bcc: '', subject: '초안', inReplyTo: '', references: '', attachNames: [], carriedNames: [] };
  let md = store.setMailDraft({ ...base, bodyHtml: '<div>짧은 글</div>' });
  ok(md.bodyHtml === '<div>짧은 글</div>' && !('droppedPics' in md) && !('bodyDropped' in md), '보통 초안 — 그대로, 새 칸 없음', Object.keys(md));
  const bigB64 = Buffer.alloc(Math.round(2.4 * MB), 9).toString('base64');
  const smallB64 = PNG.toString('base64');
  const html = `<div>앞 글</div><img src="data:image/png;base64,${bigB64}" data-name="큰.png"><div>사이</div>`
    + `<img src="data:image/png;base64,${smallB64}"><div>끝 표시 END-MARK</div>`;
  md = store.setMailDraft({ ...base, bodyHtml: html });
  ok(md.bodyHtml.length <= 2 * MB && /END-MARK/.test(md.bodyHtml) && /앞 글/.test(md.bodyHtml), '2MB 넘는 본문 — 한도 아래로, 뒤쪽 글까지 그대로', md.bodyHtml.length);
  ok(!/data:image/.test(md.bodyHtml) && (md.bodyHtml.match(/data-pic-gone="1"/g) || []).length === 2 && md.droppedPics === 2,
    '  data: 그림은 자리표로 (잘린 base64 없음), droppedPics = 2', { dropped: md.droppedPics });
  // 자리표는 쓰기 창의 것(renderer/pastepick.js)과 같다 — 편집 안 되는 덩어리라 커서가 안에 못 들어간다
  const HOLE = require(path.join(ROOT, 'renderer', 'pastepick.js')).PLACEHOLDER;
  ok(md.bodyHtml.includes(HOLE) && /contenteditable="false"/.test(HOLE), '  store 의 자리표는 쓰기 창 PLACEHOLDER 와 같다 (contenteditable=false)');
  md = store.setMailDraft({ ...base, bodyHtml: `<div>글</div><span data-pic-gone="1">그림 자리</span><img src="data:image/png;base64,${smallB64}">` });
  ok(md.droppedPics === 1 && md.bodyHtml.includes(smallB64), '이미 있던 자리표도 센다 (작은 그림은 그대로)', { dropped: md.droppedPics });
  // 인용문 그림은 alt 를 원문 그대로 들고 온다 — 화면이 적은 HTML 에는 «>» 가 날것으로 남는다
  md = store.setMailDraft({ ...base, bodyHtml: `<div>앞</div><img alt="가>나" src="data:image/png;base64,${bigB64}" data-name="q.png"><div>END2</div>` });
  ok(md.bodyHtml.startsWith('<div>앞</div><span data-pic-gone="1"') && md.bodyHtml.endsWith('</span><div>END2</div>')
    && md.droppedPics === 1 && !/나"|data:image/.test(md.bodyHtml),
    '  alt 에 «>» 가 있어도 태그 통째로 자리표 (꼬리 조각이 글로 남지 않는다)', md.bodyHtml.replace(/style="[^"]*"/, 'style=…'));
  const longText = `<div>${'가나다라마바사 '.repeat(300000)}</div>`;
  md = store.setMailDraft({ ...base, bodyHtml: longText });
  ok(md.bodyHtml === '' && md.bodyDropped === true && md.subject === '초안' && md.to === 'a@example.invalid',
    '글만으로 2MB 넘음 — 자르지 않고 본문을 비우고 bodyDropped (받는 사람·제목은 남는다)', { len: md.bodyHtml.length, bodyDropped: md.bodyDropped });

  console.log('\n[6] 이어 쓰기 — 빠진 그림 수를 쓰기 창에 넘긴다');
  composeWin().close();
  store.setMailDraft({ ...base, bodyHtml: html });
  r = composewin.startCompose({ kind: 'new', accountId: ACC.id });
  let d = await data();
  ok(r && r.ok && d && d.restored && d.restoredPicsGone === 2 && !d.restoredBodyGone, 'restoredPicsGone = 2', d && { gone: d.restoredPicsGone, body: d.restoredBodyGone });
  composeWin().close();
  store.setMailDraft({ ...base, bodyHtml: longText });
  r = composewin.startCompose({ kind: 'new', accountId: ACC.id });
  d = await data();
  ok(r && r.ok && d && d.restored && d.restoredBodyGone === true, 'restoredBodyGone = true', d && { gone: d.restoredPicsGone, body: d.restoredBodyGone });
  composeWin().close();

  ok(wins.every((w) => w.opts && w.opts.show !== true) && FakeWin.getAllWindows().length === 0, '가짜 창은 전부 닫혔다 (진짜 창은 하나도 안 만들었다)');
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });

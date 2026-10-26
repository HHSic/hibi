'use strict';
// 답장의 참조 — 원문의 참조가 그대로 따라가는가. 전달은 참조 없이.
//
// 사용자: «답장에는 참조인원도 그대로 들어가게», «전달엔 참조인원 안들어가고».
// 예전엔 답장 초안이 받는 사람(보낸 사람) 하나만 들고 갔다 — 같이 받던 사람이 답장에서 빠져 대화에서 혼자 떨어졌다.
//   [1] send.replyCc — 원문 참조에서 내 주소(설정한 계정 전부 · 대소문자 무시)와 받는 사람을 뺀다.
//       두 번 나온 주소는 한 번, 이름은 원문 그대로, 묶음은 펴고, 주소 꼴이 아닌 것은 뺀다
//   [2] send.draftFrom — 답장은 cc 를 채우고 이어 붙이는 머리글(In-Reply-To·References)도 그대로. 전달은 받는 사람·참조 빈 칸
//   [3] send.addresses — 따옴표 안의 쉼표는 이름이다 («"Kim, Minsu" <…>» 를 자르면 못 보낸다)
//   [4] startCompose — 두 입구 모두: 보기 창(mail:reply — slot 의 payload)·목록 메뉴(mailhub 가 꾸리는 꼴의 원문).
//       원문의 다른 받는 사람(To)은 안 들어간다. «새 메일»·«복사»는 예전 그대로
//   [5] 보내기 — 만든 원문을 mailparser 로 읽어 Cc 머리글(이름 그대로)·To·봉투·In-Reply-To 를 본다
//   [6] 소스 — mailhub 목록 메뉴·보기 창이 cc 를 넘기고, 쓰기 창이 참조 칸을 펴는가
//
// 창은 하나도 안 만든다 — src 쪽 모듈이 받는 electron 의 BrowserWindow 를 창 없는 가짜로 바꿔 끼운다
// (쓰기 창을 «열면» 가짜가 초안만 받아 둔다). 앱(main.js)은 안 띄운다. 물어보는 창(popup)도 안 부른다.
// 메일 서버에는 안 붙는다 — nodemailer 의 운반과 IMAP 접속(mail.connect)을 가짜로 바꿔, 만든 원문을 받아 둔다.
// 메일·주소는 지어낸 것이다 (전부 .invalid).
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const electron = require('electron');
const { app } = electron;

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replycc-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 200 ? `${s.slice(0, 200)}…` : s}` : ''));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 창 없는 가짜 창 — composewin 이 «쓰기 창»으로 만들면 초안(compose:data)만 받아 둔다 ──
const wins = [];
class FakeWin {
  constructor(opts) {
    this.opts = opts;
    this.destroyed = false;
    this.events = {};
    const n = wins.length + 1;
    this.webContents = {
      id: 9000 + n,
      sent: [],
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
// IPC 처리기는 시험이 직접 부른다 (진짜 ipcMain 에는 안 건다)
const handlers = new Map();
const fakeIpc = {
  handle: (ch, fn) => { handlers.set(ch, fn); },
  on: (ch, fn) => { handlers.set(ch, fn); },
  once() {}, removeHandler() {}, removeAllListeners() {}
};
const fakeElectron = {};
const swapped = { BrowserWindow: FakeWin, ipcMain: fakeIpc };
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
    return { accepted: [].concat(envelope.to), rejected: [], messageId: `<t${sent.length}@test.invalid>` };
  },
  close() {}
});
const { simpleParser } = require('mailparser');
const addressparser = require('nodemailer/lib/addressparser');

// ── 지어낸 메일 — 참조에 내 주소(대소문자 섞어)·받는 사람·겹친 주소·이름에 쉼표·묶음까지 ──
const EML = [
  'From: "보낸이" <sender@example.invalid>',
  // 대리 발송 꼴 — 답장은 From 이 아니라 여기로 간다
  'Reply-To: <reply@example.invalid>',
  // 원문의 다른 받는 사람(other)은 답장에 안 들어간다 («전체 답장»은 청하지 않았다)
  'To: "나" <me@example.invalid>, "다른 사람" <other@example.invalid>',
  'Cc: "동료" <coworker@example.invalid>, "Kim, Minsu" <Kim.Minsu@Example.invalid>, <ME@EXAMPLE.INVALID>,'
    + ' "내 다른 주소" <me2@example.invalid>, REPLY@example.invalid, coworker@EXAMPLE.invalid,'
    + ' Me3@example.INVALID, team: lee@example.invalid, "박 과장" <park@example.invalid>;, bare@example.invalid',
  'Subject: =?UTF-8?B?' + Buffer.from('회의 일정').toString('base64') + '?=',
  'Message-ID: <orig-cc@example.invalid>',
  'References: <older@example.invalid>',
  'Date: Tue, 20 Oct 2026 13:13:00 +0900',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>다음 주 회의 일정입니다.</p>',
  ''
].join('\r\n');

// 이 메일을 받은 계정 · 지금 쓸 수 있는 다른 계정(로그인 아이디는 주소가 아니고 보내는 주소가 따로) ·
// 설정에만 있고 꺼 둔 계정(store) — 셋 다 «내 주소»다
const ACC = { id: 'acc1', name: '시험 계정', user: 'me@example.invalid', host: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', smtpPort: 587 };
const ACC2 = { id: 'acc2', name: '둘째 계정', user: 'login-id', fromAddress: 'me3@example.invalid', host: 'imap2.example.invalid' };
// 기대하는 답장 참조 — 원문 차례 그대로, 이름 그대로
const WANT = ['"동료" <coworker@example.invalid>', '"Kim, Minsu" <Kim.Minsu@Example.invalid>',
  'lee@example.invalid', '"박 과장" <park@example.invalid>', 'bare@example.invalid'].join(', ');

app.whenReady().then(async () => {
  const send = require(path.join(SRC, 'send.js'));
  const mail = require(path.join(SRC, 'mail.js'));
  // 보낸편지함 넣기(IMAP APPEND)도 서버에 안 간다
  mail.connect = () => ({
    connect: async () => {}, close() {}, logout: async () => {},
    list: async () => [{ specialUse: '\\Sent', path: 'Sent', name: 'Sent' }],
    append: async () => {}
  });
  const store = require(path.join(SRC, 'store.js'));
  // 설정에만 있는 꺼 둔 계정 — 비밀번호 없이 (잠긴 값도 안 만든다)
  store.addMailAccount({ id: 'acc3', name: '꺼 둔 계정', user: 'old-login', host: 'imap3.example.invalid', fromAddress: 'ME2@Example.invalid' });
  store.updateMailAccount('acc3', { enabled: false });

  const composewin = require(path.join(SRC, 'composewin.js'));
  const slots = new Map();   // 보기 창 webContents.id → { payload, files }
  composewin.init({
    mailAccountsForUse: () => [ACC, ACC2],
    noAccountMessage: () => '계정 없음 (시험)',
    refreshMail: async () => {},
    slotOf: (e) => slots.get(e && e.sender && e.sender.id) || null,
    doTrash: async () => ({ moved: false })
  });
  const composeWin = () => FakeWin.getAllWindows().find((w) => String(w.file || '').endsWith('compose.html')) || null;
  const own = () => { const wc = composeWin().webContents; return { sender: wc, senderFrame: wc.mainFrame }; };
  const data = () => handlers.get('compose:data')(own());
  const closeCompose = () => { const w = composeWin(); if (w) w.close(); };
  const addrs = (s) => addressparser(String(s || '')).map((a) => a.address.toLowerCase());

  console.log('\n[1] send.replyCc — 원문 참조 − 내 주소 − 받는 사람');
  ok(send.replyCc('"동료" <c@example.invalid>, b@example.invalid', 'b@example.invalid') === '"동료" <c@example.invalid>',
    '받는 사람과 같은 주소는 참조에서 뺀다');
  ok(send.replyCc('a@example.invalid, "나" <ME@Example.INVALID>', 'x@example.invalid', ['me@example.invalid']) === 'a@example.invalid',
    '내 주소는 대소문자가 달라도 뺀다');
  ok(send.replyCc('A@Example.invalid, a@example.INVALID, "또" <a@example.invalid>', '') === 'A@Example.invalid',
    '같은 주소가 대소문자만 달라 세 번 → 처음 적힌 그대로 한 번');
  ok(send.replyCc('"홍길동" <hong@example.invalid>, "Kim, Minsu" <kim@example.invalid>', '') === '"홍길동" <hong@example.invalid>, "Kim, Minsu" <kim@example.invalid>',
    '이름은 원문 그대로 (한글 이름·쉼표 든 이름)');
  ok(send.replyCc('team: a@example.invalid, "B" <b@example.invalid>;, c@example.invalid', '') === 'a@example.invalid, "B" <b@example.invalid>, c@example.invalid',
    '묶음(team: …;)은 그 안의 주소로 편다');
  ok(send.replyCc('undisclosed-recipients:;', '') === '' && send.replyCc('', 'x@example.invalid') === '' && send.replyCc(undefined, undefined) === '',
    '참조가 없거나 빈 묶음뿐이면 빈 칸');
  ok(send.replyCc('foo, good@example.invalid', '') === 'good@example.invalid', '주소 꼴이 아닌 것은 뺀다 (그것 하나로 답장 전체가 막히지 않게)');
  ok(send.replyCc('"a@example.invalid" <a@example.invalid>', '"a" <A@example.invalid>') === '', '받는 사람이 이름을 달고 있어도 주소로 맞춘다');
  const qn = send.replyCc('"a \\"q\\" b" <q@example.invalid>', '');
  ok(qn === '"a \\"q\\" b" <q@example.invalid>' && send.addresses(qn).length === 1 && addressparser(qn)[0].name === 'a "q" b',
    '이름 안의 따옴표는 막아서 적는다 — 주소 하나로 읽히고 이름도 그대로 돌아온다', qn);

  console.log('\n[2] send.draftFrom — 답장은 참조를 잇고, 전달은 빈 칸');
  const view = await mail.viewFromSource(Buffer.from(EML), { allowRemote: false });
  ok(/Kim, Minsu/.test(view.cc) && /me2@example\.invalid/.test(view.cc), '원문을 읽은 결과(viewFromSource)에 cc 가 이름째 있다', view.cc);
  const self = ['me@example.invalid', 'login-id', 'me3@example.invalid', 'old-login', 'ME2@Example.invalid'];
  const src = { subject: view.subject, from: view.from, fromAddress: view.fromAddress, to: view.to, cc: view.cc,
    replyTo: view.replyTo, messageId: view.messageId, at: view.at, text: view.text, html: view.html };
  let d = send.draftFrom('reply', src, { self });
  ok(d.to === 'reply@example.invalid' && d.cc === WANT, '답장 — 받는 사람은 Reply-To 하나, 참조는 원문 참조에서 내 주소·받는 사람·겹친 것을 뺀 것', { to: d.to, cc: d.cc });
  ok(!addrs(d.cc).includes('other@example.invalid') && !addrs(d.to).includes('other@example.invalid'), '  원문의 다른 받는 사람(To 의 other)은 안 들어간다');
  ok(d.subject === 'Re: 회의 일정' && d.inReplyTo === '<orig-cc@example.invalid>' && d.references === '<orig-cc@example.invalid>',
    '  제목 Re:, 이어 붙이는 머리글(In-Reply-To·References) 그대로', { s: d.subject, irt: d.inReplyTo, ref: d.references });
  d = send.draftFrom('forward', src, { self });
  ok(d.to === '' && !d.cc && d.subject === 'Fwd: 회의 일정', '전달 — 받는 사람·참조 모두 빈 칸', { to: d.to, cc: d.cc });
  d = send.draftFrom('reply', { ...src, cc: '' }, { self });
  ok(d.cc === '' && d.to === 'reply@example.invalid', '원문에 참조가 없으면 답장 참조도 빈 칸');
  d = send.draftFrom('reply', src);
  ok(addrs(d.cc).includes('me@example.invalid') && addrs(d.cc).includes('me2@example.invalid'),
    '  내 주소를 안 주면 참조에 남는다 — 그래서 startCompose 가 계정 전부(selfAddresses)를 준다', d.cc);

  console.log('\n[3] send.addresses — 따옴표 안의 쉼표는 이름');
  ok(same(send.addresses('"Kim, Minsu" <kim@example.invalid>, b@example.invalid'), ['"Kim, Minsu" <kim@example.invalid>', 'b@example.invalid']),
    '«"Kim, Minsu" <…>» 를 쉼표에서 자르지 않는다');
  ok(same(send.addresses('a@example.invalid; b@example.invalid\nc@example.invalid, a@example.invalid'), ['a@example.invalid', 'b@example.invalid', 'c@example.invalid']),
    '쉼표·쌍반점·줄바꿈으로 나누고 겹친 것은 한 번 (예전과 같다)');
  ok(same(send.addresses('"Kim <kim@example.invalid>, b@example.invalid'), ['"Kim <kim@example.invalid>', 'b@example.invalid']),
    '따옴표 짝이 안 맞으면 예전처럼 다 자른다 (뒤의 주소가 이름 속으로 말려 들어가지 않게)');
  ok(send.problemWith({ ...ACC }, { to: 'reply@example.invalid', cc: WANT }) === null, '답장 참조 그대로 보내기 전 확인을 통과한다 (쉼표 든 이름 포함)');

  console.log('\n[4] startCompose — 보기 창(mail:reply)·목록 메뉴 두 입구');
  const payload = mail.viewPayload(view, { accountId: ACC.id, fromSelf: false, seen: true });
  ok(payload.cc === view.cc, '보기 창에 넘기는 payload 에도 cc 가 있다 (slot.payload)');
  slots.set(-1, { payload, files: view.attachments });
  let r = await handlers.get('mail:reply')({ sender: { id: -1 } });
  ok(r && r.ok && composeWin(), '보기 창 «답장»(mail:reply) — 쓰기 창(가짜)을 연다', r);
  d = await data();
  ok(d && d.title === '답장' && d.to === 'reply@example.invalid' && d.cc === WANT,
    '  초안 참조 = 원문 참조 − 내 주소(이 계정·둘째 계정의 보내는 주소·꺼 둔 계정) − 받는 사람 − 겹친 것', d && { to: d.to, cc: d.cc });
  ok(d && d.inReplyTo === '<orig-cc@example.invalid>' && d.references === '<orig-cc@example.invalid>', '  이어 붙이는 머리글 그대로');
  const replyDraft = d;

  // 보내기 — 만든 원문에 Cc 가 이름째 실리는가
  console.log('\n[5] 보내기 — 원문의 Cc 머리글·봉투');
  r = await handlers.get('compose:send')(own(), {
    to: d.to, cc: d.cc, bcc: '', subject: d.subject, text: '확인했습니다', html: '<p>확인했습니다</p>',
    attachments: [], inReplyTo: d.inReplyTo, references: d.references
  });
  ok(r && r.ok && sent.length === 1, '보냈다 (가짜 운반)', r);
  const p = await simpleParser(sent[0].raw);
  ok(p.to && same(p.to.value.map((a) => a.address), ['reply@example.invalid']), '  To = Reply-To 하나', p.to && p.to.text);
  // nodemailer 는 머리글을 쓸 때 도메인만 소문자로 적는다 (도메인은 대소문자를 안 가린다) — 이름·@ 앞은 그대로다
  ok(p.cc && same(p.cc.value.flatMap((a) => (a.group ? a.group : [a])).map((a) => [a.name, a.address]),
    [['동료', 'coworker@example.invalid'], ['Kim, Minsu', 'Kim.Minsu@example.invalid'], ['', 'lee@example.invalid'],
      ['박 과장', 'park@example.invalid'], ['', 'bare@example.invalid']]),
  '  Cc = 다섯 사람, 이름 그대로 (쉼표 든 이름도 한 사람)', p.cc && p.cc.text);
  const env = sent[0].envelope.to.flatMap((x) => addrs(x));
  ok(same(env, ['reply@example.invalid', 'coworker@example.invalid', 'kim.minsu@example.invalid', 'lee@example.invalid', 'park@example.invalid', 'bare@example.invalid']),
    '  봉투 = 받는 사람 + 참조 다섯 (내 주소 없음)', env);
  ok(p.inReplyTo === '<orig-cc@example.invalid>' && /orig-cc@example\.invalid/.test(String(p.references || '')), '  In-Reply-To·References 로 원문에 이어 붙는다', { irt: p.inReplyTo, ref: p.references });
  closeCompose();

  r = await handlers.get('mail:forward')({ sender: { id: -1 } });
  d = await data();
  ok(r && r.ok && d && d.title === '전달' && d.to === '' && !d.cc, '보기 창 «전달»(mail:forward) — 받는 사람·참조 빈 칸', d && { to: d.to, cc: d.cc });
  closeCompose();

  // 목록 메뉴 — mailhub 의 draft(kind) 가 fetchBody(= viewFromSource) 결과로 꾸리는 것과 같은 꼴
  const m = view;
  const listSource = { subject: m.subject, from: m.from, fromAddress: m.fromAddress, to: m.to, cc: m.cc,
    replyTo: m.replyTo, messageId: m.messageId, at: m.receivedAt, text: m.text, html: m.html };
  r = composewin.startCompose({ kind: 'reply', accountId: ACC.id, source: listSource, files: [] });
  d = await data();
  ok(r && r.ok && d && d.cc === WANT && d.to === 'reply@example.invalid', '목록 메뉴 «답장» 꼴 — 같은 참조', d && d.cc);
  closeCompose();
  r = composewin.startCompose({ kind: 'forward', accountId: ACC.id, source: listSource, files: [] });
  d = await data();
  ok(r && r.ok && d && d.to === '' && !d.cc, '목록 메뉴 «전달» 꼴 — 참조 없음', d && { to: d.to, cc: d.cc });
  closeCompose();

  r = composewin.startCompose({ kind: 'new', accountId: ACC.id });
  d = await data();
  ok(r && r.ok && d && d.title === '새 메일' && !d.cc && !d.to, '«새 메일» — 예전 그대로 빈 칸', d && { to: d.to, cc: d.cc });
  closeCompose();
  r = composewin.startCopy({ accountId: ACC.id, view: { subject: '보낸 것', to: 'a@example.invalid', cc: '"나" <me@example.invalid>, b@example.invalid', html: '<p>본문</p>' } });
  d = await data();
  ok(r && r.ok && d && d.title === '복사본' && d.cc === '"나" <me@example.invalid>, b@example.invalid',
    '«복사» — 예전 그대로 원문의 참조를 손대지 않고 싣는다', d && d.cc);
  closeCompose();
  ok(replyDraft && wins.every((w) => w.opts && w.opts.show !== true) && FakeWin.getAllWindows().length === 0, '  가짜 창은 전부 닫혔다 (진짜 창은 하나도 안 만들었다)');

  console.log('\n[6] 소스 — 두 입구가 cc 를 넘기고, 쓰기 창이 참조 칸을 편다');
  const hubSrc = fs.readFileSync(path.join(SRC, 'mailhub.js'), 'utf8');
  const cwSrc = fs.readFileSync(path.join(SRC, 'composewin.js'), 'utf8');
  const cjs = fs.readFileSync(path.join(ROOT, 'renderer', 'compose.js'), 'utf8');
  const draftFn = hubSrc.slice(hubSrc.indexOf('const draft = (kind)'), hubSrc.indexOf('const copy = ()'));
  ok(/source: \{[^}]*\bcc: m\.cc,/.test(draftFn), 'mailhub 목록 메뉴 draft(kind) — source 에 cc: m.cc');
  const viewFn = cwSrc.slice(cwSrc.indexOf('function composeFromView('), cwSrc.indexOf("ipcMain.handle('mail:reply'"));
  ok(/source: \{[^}]*\bcc: v\.cc,/.test(viewFn), 'composewin composeFromView — source 에 cc: v.cc (slot.payload)');
  ok(/send\.draftFrom\(kind, source, \{ self: selfAddresses\(accounts\) \}\)/.test(cwSrc)
    && /\[\.\.\.store\.mailAccounts, \.\.\.\(accounts \|\| \[\]\)\]/.test(cwSrc),
  'startCompose — 내 주소는 설정의 계정 전부 + 쓸 수 있는 계정 (selfAddresses)');
  ok(/if \(d\.cc && !d\.restored && !d\.reuse\) \{\s*\$\('cc'\)\.value = d\.cc;\s*\$\('row-cc'\)\.classList\.remove\('hide'\);/.test(cjs),
    '쓰기 창 fill — 답장의 참조를 채우고 참조 칸을 편다 (이어 쓰기·복사는 제 길 그대로)');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });

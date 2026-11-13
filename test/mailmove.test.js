'use strict';
// 옮기기 도우미 — MOVE 가 없는 서버에서도 메일을 잃지 않고 휴지통·스팸으로 옮기는가 (src/mailmove.js).
//
// 창도 Electron 도 쓰지 않는다 — 가짜 IMAP 클라이언트(test/fixtures/fake-imap.js)로만 돈다. node 로도, npx electron 으로도 돈다.
// 진짜 메일 서버에는 붙지 않는다. 일지 파일은 임시 폴더에만 쓴다.
// 모든 경우에 «잃은 메일 0»(INBOX ∪ 휴지통에 원래 Message-ID 가 다 있다)과 «금지 명령 0»을 함께 본다.
//   [A] MOVE 가 있으면 지금 길 그대로   [B] MOVE 없음 + UIDPLUS   [C] MOVE 없음 + UIDPLUS 없음
//   [D] COPY 거절   [E] COPY 가 OK 인데 아무것도 안 생김   [F] COPYUID 일부·없음
//   [G] 남이 지움 표시한 메일   [H] 끊김 — COPY 뒤·STORE 뒤·EXPUNGE 중   [I] 휴지통 없음·지움 표시 못 함·STATUS
//   [J] STORE·EXPUNGE 거절   [K] imapflow 대체 경로는 막힌다   [L] 같은 계정 두 일   [M] 첫 묶음 1통 시험
//   [N] pack   [O] 일지 파일   [P] 계정 멈춤·풀기   [Q] 서버 기능 한 줄   [R] 소스 검사
//   [S] 복사 전 실패는 던지지 않고 left · 끊김은 멈춤이 아니다   [T] UIDVALIDITY 없는 답 한 번   [U] 일지를 잠깐 못 읽음
//   [V] 거짓 COPY OK + UIDNEXT 구멍   [W] UID 지우기가 폴더 전체를 지우는 서버
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const mm = require(path.join(ROOT, 'src', 'mailmove.js'));
const { makeServer } = require(path.join(__dirname, 'fixtures', 'fake-imap.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const V = 1700000000n;
function mk(uid, o = {}) {
  const id = `m${uid}@corp.example`;
  return { uid, raw: `Message-ID: <${id}>\r\nSubject: s${uid}\r\n\r\nbody ${uid}\r\n`, date: new Date(Date.UTC(2026, 0, 1)), subject: `s${uid}`, flags: o.flags || [], labels: [], messageId: `<${id}>` };
}
const NOMOVE_UP = ['IMAP4rev1', 'UIDPLUS'];
const NOMOVE = ['IMAP4rev1'];
const WITH_MOVE = ['IMAP4rev1', 'MOVE', 'UIDPLUS'];

async function env(spec, { inbox = [1000, 1001, 1002], trash = 'Trash', extraInbox = [], boxExtra = {} } = {}) {
  const s = { a1: { caps: NOMOVE_UP, ...spec, boxes: [
    { path: 'INBOX', uidValidity: V, msgs: [...inbox.map((u) => mk(u)), ...extraInbox], ...boxExtra },
    ...(trash ? [{ path: trash, specialUse: '\\Trash', uidValidity: V, msgs: [] }] : [])
  ] } };
  const server = makeServer(s);
  const orig = new Set(server.box('a1', 'INBOX').msgs.map((m) => m.messageId));
  const open = async () => {
    const c = server.connect({ id: 'a1' });
    await c.connect();
    await c.mailboxOpen('INBOX', { readOnly: false });
    return c;
  };
  const c = await open();
  const ids = (p) => (server.box('a1', p) ? server.box('a1', p).msgs.map((m) => m.messageId) : []);
  const lost = () => [...orig].filter((id) => !ids('INBOX').includes(id) && !ids(trash || 'Trash').includes(id));
  const cmds = () => server.log.filter((e) => e.acc === 'a1').map((e) => e.cmd);
  const inboxFlags = () => Object.fromEntries(server.box('a1', 'INBOX').msgs.map((m) => [m.uid, [...m.flags]]));
  return { server, c, open, ids, lost, cmds, inboxFlags };
}
const short = (r) => ({ how: r.how, moved: r.moved, left: r.left, kept: r.kept, gone: r.gone, unsure: r.unsure, block: r.block, error: r.error, foreign: r.foreign, undone: r.undone });
const count = (arr, x) => arr.filter((y) => y === x).length;
const safe = (e, extra = '') => ok(e.lost().length === 0 && e.server.forbidden().length === 0, `…잃은 메일 0 · 금지 명령 0${extra}`, { lost: e.lost(), forbidden: e.server.forbidden() });
// 명령 순서에서 연결·폴더 열기를 뺀 것
const flow = (e) => e.cmds().filter((x) => !['connect', 'mailboxOpen', 'moved', 'copied', 'stored', 'expunged', 'drop', 'close'].includes(x));

(async () => {
  console.log('\n[A] MOVE 가 있으면 지금 길 그대로 (UID MOVE 1번 + 남은 것 묻기)');
  {
    const e = await env({ caps: WITH_MOVE });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001, 1002], 'Trash', { accKey: 'a1', journal: j });
    ok(r.how === 'move' && r.moved.length === 3 && e.ids('Trash').length === 3 && e.ids('INBOX').length === 0, '3통 옮김', short(r));
    ok(JSON.stringify(flow(e)) === '["messageMove","search"]', '…UID MOVE 한 번 + 남은 것 묻기 — COPY·STORE·EXPUNGE·STATUS 없음', flow(e));
    ok(!j.trusted('a1') && mm.chunkFor(e.c, j, 'a1') === mm.CHUNK, '…MOVE 서버는 시험 묶음 없이 늘 한 번에', mm.chunkFor(e.c, j, 'a1'));
    safe(e);
  }
  {
    // 서버가 MOVE 를 거절 — imapflow 는 false 만 주고 까닭은 log.warn 에만 남긴다. 그 글을 보여 준다
    const e = await env({ caps: WITH_MOVE, moveNo: { serverResponseCode: 'THROTTLED', responseText: 'Too many commands, slow down' } });
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.left.length === 2 && r.moved.length === 0 && /옮기기를 거부/.test(r.error || '') && /속도를 제한/.test(r.error || ''),
      'MOVE 거절 — 남은 것은 left, 오류에 서버가 준 까닭이 붙는다', short(r));
    safe(e);
  }

  console.log('\n[B] MOVE 없음 + UIDPLUS — STATUS → COPY → STATUS → STORE → UID EXPUNGE → SEARCH');
  {
    const e = await env({ caps: NOMOVE_UP }, { extraInbox: [mk(1005, { flags: ['\\Deleted'] })] });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001, 1002], 'Trash', { accKey: 'a1', journal: j });
    ok(r.how === 'copy' && r.moved.length === 3 && e.ids('Trash').length === 3 && !r.error, '3통 옮김', short(r));
    ok(JSON.stringify(flow(e)) === '["status","COPY","status","STORE","search","UID EXPUNGE","search","search"]',
      '…명령 순서 (지우기 앞에서 남의 지움 표시를 세고, 뒤에서 그것이 남았는지 본다)', flow(e));
    ok(e.ids('INBOX').length === 1 && e.ids('INBOX')[0] === '<m1005@corp.example>', '…남이 지움 표시한 1005 는 UID EXPUNGE 가 건드리지 않는다', e.ids('INBOX'));
    const store = e.server.log.find((x) => x.cmd === 'STORE');
    ok(store.range === '1000:1002' && store.opts.silent === true && store.opts.operation === 'add' && store.flags[0] === '\\Deleted', '…UID STORE +FLAGS.SILENT (\\Deleted) 1000:1002', store);
    ok(j.dump().pending.length === 0 && j.trusted('a1'), '…일지 비움 · 이 계정은 믿는다', j.dump());
    safe(e);
  }

  console.log('\n[C] MOVE 없음 + UIDPLUS 없음 — 남의 표시 보기 → UID 확인 → STATUS → COPY → STATUS → STORE → 다시 보기 → EXPUNGE');
  {
    const e = await env({ caps: NOMOVE });
    const r = await mm.moveUids(e.c, [1000, 1001, 1002], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.how === 'copy' && r.moved.length === 3 && e.ids('Trash').length === 3 && e.ids('INBOX').length === 0, '3통 옮김', short(r));
    ok(JSON.stringify(flow(e)) === '["search","search","status","COPY","status","STORE","search","EXPUNGE","search"]', '…명령 순서 (평 EXPUNGE 1번)', flow(e));
    const q = e.server.log.filter((x) => x.cmd === 'search').map((x) => x.q);
    ok(q[0].deleted === true && q[0].uid === undefined && q[2].deleted === true, '…EXPUNGE 앞뒤로 폴더 전체의 지움 표시를 본다', q);
    safe(e);
  }
  for (const caps of [NOMOVE, NOMOVE_UP]) {
    // 고른 뒤 다른 곳에서 지운 UID 가 섞임 — 그것은 gone 이고, 나머지는 옮긴다 (UIDPLUS 없음: 없는 UID 까지 복사하면 휴지통 증명이 어긋나 멈춘다)
    const e = await env({ caps });
    const r = await mm.moveUids(e.c, [1000, 1001, 1003], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    const copies = e.server.log.filter((x) => x.cmd === 'COPY').map((x) => x.range);
    ok(JSON.stringify(r.moved) === '[1000,1001]' && JSON.stringify(r.gone) === '[1003]' && !r.block && !r.kept.length && e.ids('Trash').length === 2,
      `${caps.join('+')} · 이미 없는 UID 1003 — gone, 나머지 2통은 옮기고 멈추지 않는다`, { r: short(r), copies });
    if (caps === NOMOVE) ok(JSON.stringify(copies) === '["1000:1001"]', '…UIDPLUS 없으면 지금 있는 UID 만 복사한다', copies);
    safe(e);
  }

  console.log('\n[D] COPY 거절');
  for (const caps of [NOMOVE_UP, NOMOVE]) {
    const e = await env({ caps, copyNo: { responseText: 'Mailbox is full' } });
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.left.length === 2 && r.moved.length === 0 && !r.block && e.ids('INBOX').length === 3 && e.ids('Trash').length === 0 && !e.cmds().includes('STORE'),
      `${caps.join('+')} — 원본 그대로, STORE 안 보냄, left (열쇠를 지워도 된다)`, short(r));
    ok(/복사를 거부/.test(r.error || '') && /Mailbox is full/.test(r.error || ''), '…오류에 서버 글', r.error);
    safe(e);
  }

  console.log('\n[E] COPY 는 OK 인데 휴지통에 아무것도 안 생김');
  for (const caps of [NOMOVE, NOMOVE_UP]) {
    const e = await env({ caps, copyLies: true });
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.kept.length === 2 && !!r.block && e.ids('INBOX').length === 3 && !e.cmds().includes('STORE'),
      `${caps.join('+')} — UIDNEXT 가 안 늘어 지우지 않음 + 계정 멈춤(block)`, short(r));
    safe(e);
  }

  console.log('\n[F] COPYUID 가 일부만 / 아예 없음');
  {
    const e = await env({ caps: NOMOVE_UP, copyuidPartial: true });
    const r = await mm.moveUids(e.c, [1000, 1001, 1002], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(JSON.stringify(r.moved) === '[1001,1002]' && JSON.stringify(r.kept) === '[1000]' && !!r.block, '덮인 2통만 지우고, 빠진 1000 은 원본을 남김', short(r));
    ok(/휴지통에 복사본이 생겼습니다/.test(r.error || ''), '…알림이 휴지통에 복사본이 생겼다고 말한다 (다시 누르면 또 생긴다)', r.error);
    ok(e.ids('INBOX').includes('<m1000@corp.example>') && count(e.ids('Trash'), '<m1000@corp.example>') === 1, '…1000 은 INBOX·휴지통 둘 다 (겹침이지 잃음이 아니다)', { inbox: e.ids('INBOX'), trash: e.ids('Trash') });
    safe(e);
  }
  {
    const e = await env({ caps: NOMOVE_UP, copyuidMissing: true });
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.kept.length === 2 && r.moved.length === 0 && !!r.block && !e.cmds().includes('STORE') && /COPYUID/.test(r.error || ''), 'COPYUID 없음 — 원본 남김, 지움 표시도 안 함 + 계정 멈춤', short(r));
    ok(/휴지통에 복사본이 생겼습니다/.test(r.error || ''), '…알림이 휴지통에 복사본이 생겼다고 말한다', r.error);
    safe(e);
  }

  console.log('\n[G] 남이 지움 표시한 메일');
  {
    const e = await env({ caps: NOMOVE }, { extraInbox: [mk(1005, { flags: ['\\Deleted'] })] });
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.left.length === 2 && r.foreign === 1 && !r.block && !e.cmds().includes('COPY') && e.ids('INBOX').length === 4 && /지움 표시만/.test(r.error || ''),
      'UIDPLUS 없음 — 미리 보면 복사도 안 하고 이 폴더는 건너뜀 (평 EXPUNGE 가 남의 메일을 지우지 않게)', short(r));
    safe(e);
  }
  {
    const e = await env({ caps: NOMOVE, hooks: { afterCopy: ({ box }) => { box.msgs.find((m) => m.uid === 1002).flags.add('\\Deleted'); } } });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    const f = e.inboxFlags();
    ok(r.kept.length === 2 && r.foreign === 1 && !e.cmds().includes('EXPUNGE') && e.ids('INBOX').length === 3, '복사 뒤 다른 프로그램이 1002 에 표시 — EXPUNGE 를 보내지 않는다', short(r));
    ok(!f[1000].includes('\\Deleted') && !f[1001].includes('\\Deleted') && f[1002].includes('\\Deleted') && j.dump().pending.length === 0, '…내 표시는 풀고 남의 표시는 그대로, 일지 비움', f);
    safe(e);
  }

  console.log('\n[H] 끊김 — COPY 뒤 / STORE 뒤 / EXPUNGE 중');
  for (const caps of [NOMOVE_UP, NOMOVE]) {
    const e = await env({ caps, dropAt: 'copy' });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    ok(r.unsure && r.kept.length === 2 && !e.cmds().includes('STORE') && e.ids('INBOX').length === 3 && j.dump().pending.length === 0,
      `${caps.join('+')} COPY 뒤 끊김 — unsure, 원본 그대로, 표시 없음, 일지 없음`, short(r));
    safe(e);
  }
  for (const caps of [NOMOVE_UP, NOMOVE]) {
    const e = await env({ caps, dropAt: 'store' });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    const f1 = e.inboxFlags();
    ok(r.unsure && r.kept.length === 2 && f1[1000].includes('\\Deleted') && j.dump().pending.length === 1 && e.ids('INBOX').length === 3,
      `${caps.join('+')} STORE 뒤 끊김 — 원본에 내 표시가 남고 일지에 적혀 있다`, { ...short(r), pending: j.dump().pending });
    // 다음 번 — 새 연결로 다른 메일(1002)을 옮긴다. 먼저 내 표시를 푼다 (UIDPLUS 가 없어도 «남의 표시»로 오인해 막히지 않는다)
    e.server.spec.a1.dropAt = undefined;
    const c2 = await e.open();
    const r2 = await mm.moveUids(c2, [1002], 'Trash', { accKey: 'a1', journal: j });
    const f2 = e.inboxFlags();
    ok(r2.undone === 2 && JSON.stringify(r2.moved) === '[1002]' && !f2[1000].includes('\\Deleted') && !f2[1001].includes('\\Deleted') && j.dump().pending.length === 0,
      '…다음 번: 남은 내 표시 2통을 먼저 풀고, 1002 는 옮긴다', { ...short(r2), flags: f2 });
    const un = e.server.log.filter((x) => x.cmd === 'STORE' && x.opts.operation === 'remove');
    ok(un.length === 1 && un[0].range === '1000:1001' && un[0].opts.silent === true, '…UID STORE -FLAGS.SILENT (\\Deleted) 로 푼다', un);
    ok(e.ids('INBOX').length === 2, '…1000·1001 은 INBOX 원본 + 휴지통 복사본 (겹침)', { inbox: e.ids('INBOX'), trash: e.ids('Trash') });
    safe(e);
  }
  for (const caps of [NOMOVE_UP, NOMOVE]) {
    const e = await env({ caps, dropAt: 'expunge' });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    ok(r.unsure && e.ids('INBOX').length === 1 && e.ids('Trash').length === 2, `${caps.join('+')} EXPUNGE 는 됐는데 답 전에 끊김 — unsure`, short(r));
    e.server.spec.a1.dropAt = undefined;
    const c2 = await e.open();
    const st = await mm.settle(c2, { accKey: 'a1', journal: j });
    ok(st.undone === 0 && j.dump().pending.length === 0, '…다음 번: 일지의 UID 가 이미 없으니 일지만 비운다', { st, pending: j.dump().pending });
    safe(e);
  }
  {
    // UIDVALIDITY 가 바뀐 폴더 — 일지의 UID 는 다른 메일이다. 그 줄만 버리고 아무것도 풀지 않는다
    const e = await env({ caps: NOMOVE_UP }, { extraInbox: [mk(1009, { flags: ['\\Deleted'] })] });
    const j = mm.memJournal();
    await j.add('a1', 'INBOX', '1', [1009]);
    const st = await mm.settle(e.c, { accKey: 'a1', journal: j });
    ok(st.undone === 0 && j.dump().pending.length === 0 && e.inboxFlags()[1009].includes('\\Deleted') && !e.cmds().includes('STORE'),
      'UIDVALIDITY 가 다른 일지 줄은 버리고 표시는 건드리지 않는다', { st, flags: e.inboxFlags()[1009] });
  }

  console.log('\n[I] 휴지통 없음 · 지움 표시 못 함 · STATUS 가 UIDNEXT 를 안 줌 · STATUS 가 묵은 값');
  {
    const e = await env({ caps: NOMOVE_UP }, { trash: null });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.left.length === 1 && !e.cmds().includes('STORE') && e.ids('INBOX').length === 3, '없는 폴더로 COPY — 서버가 거절(TRYCREATE), 원본 그대로', short(r));
  }
  {
    const e = await env({ caps: NOMOVE_UP }, { boxExtra: { noDeletedFlag: true } });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.left.length === 1 && !!r.block && !e.cmds().includes('COPY'), 'PERMANENTFLAGS 에 \\Deleted 없음 — 복사도 하지 않고 멈춤', short(r));
  }
  {
    const e = await env({ caps: NOMOVE, statusNoUidNext: true });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.left.length === 1 && !!r.block && !e.cmds().includes('COPY'), 'UIDPLUS 없음 + STATUS 에 UIDNEXT 없음 — 증명할 길이 없어 복사도 안 함', short(r));
  }
  {
    const e = await env({ caps: NOMOVE_UP, statusNoUidNext: true });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(JSON.stringify(r.moved) === '[1000]' && !r.error, 'UIDPLUS + STATUS 에 UIDNEXT 없음 — COPYUID 만으로 옮김', short(r));
    safe(e);
  }
  {
    const e = await env({ caps: NOMOVE, statusStale: true });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    ok(r.kept.length === 1 && !!r.block && e.ids('INBOX').length === 3 && e.ids('Trash').length === 1, 'STATUS 가 묵은 값 — 지우지 않고 멈춤 (복사본 1통 겹침)', short(r));
    safe(e);
  }

  console.log('\n[J] 서버가 STORE / EXPUNGE 를 거절');
  {
    const e = await env({ caps: NOMOVE_UP, storeNo: true });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    ok(r.kept.length === 2 && !!r.block && !e.cmds().includes('UID EXPUNGE') && e.ids('INBOX').length === 3, 'STORE 거절 — 지우지 않음 + 계정 멈춤', short(r));
    safe(e);
  }
  for (const caps of [NOMOVE_UP, NOMOVE]) {
    const e = await env({ caps, expungeNo: true });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    const f = e.inboxFlags();
    ok(r.kept.length === 2 && !!r.block && !f[1000].includes('\\Deleted') && j.dump().pending.length === 0, `${caps.join('+')} EXPUNGE 거절 — 내 표시를 풀고 멈춤`, short(r));
    safe(e);
  }
  {
    // 서버가 표시를 해 놓고 NO 로 답함 — 원본에 내 \Deleted 가 남으면 다른 프로그램의 지우기가 원본을 없앤다. 풀고 일지도 비운다
    const e = await env({ caps: NOMOVE_UP });
    const realRun = e.c.run.bind(e.c);
    e.c.run = async (cmd, ...a) => {
      if (cmd !== 'STORE' || !a[2] || a[2].operation !== 'add') return realRun(cmd, ...a);
      await realRun(cmd, ...a);
      return false;
    };
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: j });
    ok(JSON.stringify(r.kept) === '[1000]' && !!r.block && !e.inboxFlags()[1000].includes('\\Deleted') && j.dump().pending.length === 0 && !e.cmds().includes('UID EXPUNGE'),
      'STORE 가 표시를 남기고 거절 — 내 표시를 풀고 일지를 비운 뒤 멈춤', { r: short(r), flags: e.inboxFlags(), pending: j.dump().pending });
    safe(e);
  }
  for (const caps of [NOMOVE_UP, NOMOVE]) {
    // 지우기에 OK 라고 답하고 아무것도 안 지움 — 원본을 남기고, 내 표시를 풀고, 멈춘다
    const e = await env({ caps });
    const realExec = e.c.exec.bind(e.c);
    e.c.exec = async (cmd, ...a) => (/EXPUNGE/i.test(String(cmd)) ? { response: { attributes: [] }, next: () => {} } : realExec(cmd, ...a));
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: j });
    ok(JSON.stringify(r.kept) === '[1000]' && r.moved.length === 0 && /지우지 않아/.test(r.block || '') && !e.inboxFlags()[1000].includes('\\Deleted') && j.dump().pending.length === 0,
      `${caps.join('+')} · 지우기 OK 인데 남음 — 원본에 내 표시를 남기지 않고 멈춤`, { r: short(r), flags: e.inboxFlags(), pending: j.dump().pending });
    safe(e);
  }
  {
    // UIDPLUS 없음 — 지우기 직전 확인 검색을 서버가 거절 (연결은 산다). 폴더 지우기를 보내지 않고 표시를 푼다. 한 번의 거절이라 멈추지 않는다
    const e = await env({ caps: NOMOVE, hooks: { afterCopy: ({ box }) => { box.searchReturns = false; } } });
    const j = mm.memJournal();
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: j });
    ok(JSON.stringify(r.kept) === '[1000]' && !r.block && /확인 검색/.test(r.error || '') && !e.cmds().includes('EXPUNGE')
      && !e.inboxFlags()[1000].includes('\\Deleted') && j.dump().pending.length === 0 && e.ids('INBOX').length === 3,
    '확인 검색 거절 — EXPUNGE 없이 표시를 풀고 원본을 남김, 멈추지 않음', { r: short(r), flags: e.inboxFlags(), pending: j.dump().pending });
    safe(e);
  }

  console.log('\n[K] imapflow 대체 경로는 막힌다 (도우미가 연결에 건다)');
  {
    const e = await env({ caps: NOMOVE_UP });
    mm.guardFallback(e.c);
    const err = await e.c.messageMove('1000', 'Trash', { uid: true }).then(() => null, (x) => x.message);
    ok(/MOVE 대체 경로 막음/.test(err || '') && e.ids('INBOX').length === 3 && e.ids('Trash').length === 0, 'messageMove 를 누가 불러도 첫 COPY 에서 멈춘다 (서버 그대로)', err);
    safe(e);
  }
  {
    // 도우미를 거친 연결도 같다 — 옮긴 뒤에 누가 messageMove 를 불러도 대체 경로를 못 탄다
    const e = await env({ caps: NOMOVE_UP });
    await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() });
    const err = await e.c.messageMove('1001', 'Trash', { uid: true }).then(() => null, (x) => x.message);
    ok(/MOVE 대체 경로 막음/.test(err || '') && e.ids('INBOX').length === 2, 'moveUids 를 지난 연결은 막혀 있다', err);
    safe(e);
  }
  {
    // 읽기 전용·같은 폴더·너무 많은 UID 는 시작도 하지 않는다
    const e = await env({ caps: NOMOVE_UP });
    const big = Array.from({ length: mm.CHUNK + 1 }, (_, i) => 1000 + i);
    const errs = [];
    errs.push(await mm.moveUids(e.c, big, 'Trash', { accKey: 'a1', journal: mm.memJournal() }).then(() => null, (x) => x.message));
    errs.push(await mm.moveUids(e.c, [1000], 'INBOX', { accKey: 'a1', journal: mm.memJournal() }).then(() => null, (x) => x.message));
    await e.c.mailboxOpen('INBOX', { readOnly: true });
    errs.push(await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: mm.memJournal() }).then(() => null, (x) => x.message));
    ok(errs.every(Boolean) && !e.cmds().some((x) => ['COPY', 'STORE', 'status', 'messageMove'].includes(x)), '100통 넘음·같은 폴더·읽기 전용 — 명령 없이 던진다', errs);
  }

  console.log('\n[L] 같은 계정 두 일이 겹칠 때 (정리 + 휴지통 단추, UIDPLUS 없음)');
  for (const sameKey of [true, false]) {
    // 첫 일(정리)은 지움 표시를 한 뒤 EXPUNGE 앞에서 30ms 머문다 — 그 사이 둘째 일(단추)이 들어온다
    let first = null;
    const e = await env({ caps: NOMOVE, hooks: { beforeExpunge: ({ client }) => (client === first ? new Promise((res) => setTimeout(res, 30)) : null) } },
      { inbox: [1000, 1001, 1002, 1003] });
    first = e.c;
    const c2 = await e.open();
    const j = mm.memJournal();
    const [r1, r2] = await Promise.all([
      mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j }),
      new Promise((res) => setTimeout(res, 10)).then(() => mm.moveUids(c2, [1002], 'Trash', { accKey: sameKey ? 'a1' : 'a1-other', journal: j }))
    ]);
    const okAll = r1.moved.length === 2 && r2.moved.length === 1;
    ok(sameKey ? okAll : !okAll, sameKey ? '계정 자물쇠 — 둘 다 옮김' : '(대조) 자물쇠가 다르면 한쪽이 상대 표시를 «남의 표시»로 보고 물러난다',
      { r1: short(r1), r2: short(r2) });
    safe(e);
  }

  console.log('\n[M] 첫 묶음 1통 시험');
  {
    const e = await env({ caps: NOMOVE_UP });
    const j = mm.memJournal();
    const a = mm.chunkFor(e.c, j, 'a1');
    await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: j });
    const b = mm.chunkFor(e.c, j, 'a1');
    ok(a === 1 && b === mm.CHUNK && mm.CHUNK === 100, '복사 길을 끝까지 해 본 적 없는 계정은 1통, 한 번 끝내면 100통', { a, b });
  }
  {
    const e = await env({ caps: NOMOVE_UP, copyuidPartial: true });
    const j = mm.memJournal();
    await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    ok(!j.trusted('a1') && mm.chunkFor(e.c, j, 'a1') === 1, '…일부만 된 묶음으로는 믿지 않는다', j.dump());
  }

  console.log('\n[N] pack');
  ok(mm.pack([1005, 1000, 1001, 1002, 1002, 7]) === '7,1000:1002,1005', 'pack', mm.pack([1005, 1000, 1001, 1002, 1002, 7]));
  ok(mm.pack([0, -1, 'x', 3.5, null, 12]) === '12', '…1 이상 정수만', mm.pack([0, -1, 'x', 3.5, null, 12]));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailmove-'));
  console.log('\n[O] 일지 파일 — 지움 표시 전에 디스크에 쓴다, 다시 읽힌다, 깨지면 비켜 두고 새로 시작한다');
  {
    const file = path.join(tmp, mm.JOURNAL_FILE);
    const j = mm.fileJournal(file);
    const e = await env({ caps: NOMOVE, dropAt: 'store' });
    await mm.moveUids(e.c, [1000, 1001], 'Trash', { accKey: 'a1', journal: j });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(onDisk.v === 1 && onDisk.pending.length === 1 && JSON.stringify(onDisk.pending[0].uids) === '[1000,1001]' && onDisk.pending[0].box === 'INBOX'
      && onDisk.pending[0].v === String(V), 'STORE 뒤 끊김 — 일지 파일에 계정·폴더·UIDVALIDITY·UID 가 있다', onDisk.pending);
    ok(!fs.existsSync(file + '.tmp'), '…임시 파일은 남지 않는다 (바꿔치기)');
    // 앱을 다시 켠 셈 — 새 일지가 파일을 읽어 다음 번에 표시를 푼다
    const j2 = mm.fileJournal(file);
    e.server.spec.a1.dropAt = undefined;
    const c2 = await e.open();
    const st = await mm.settle(c2, { accKey: 'a1', journal: j2 });
    ok(st.undone === 2 && JSON.parse(fs.readFileSync(file, 'utf8')).pending.length === 0, '…다시 켠 뒤 그 표시를 풀고 파일에서도 뺀다', st);
    safe(e);
  }
  {
    const file = path.join(tmp, 'broken.json');
    fs.writeFileSync(file, '{ 깨진');
    const j = mm.fileJournal(file);
    ok(j.dump().pending.length === 0 && fs.existsSync(file + '.broken') && !fs.existsSync(file), '깨진 일지는 .broken 으로 비켜 두고 빈 일지로 시작한다', fs.readdirSync(tmp));
    await j.block('a9', '시험');
    ok(JSON.parse(fs.readFileSync(file, 'utf8')).blocked.a9.why === '시험', '…그 뒤 쓰기는 새 파일로', fs.readFileSync(file, 'utf8'));
  }
  {
    // 일지를 쓸 수 없으면 지움 표시를 보내지 않는다 — 원본과 복사본이 둘 다 남을 뿐이다
    const j = mm.fileJournal(path.join(tmp, '없는 폴더', 'x', mm.JOURNAL_FILE));
    const e = await env({ caps: NOMOVE_UP });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1', journal: j });
    ok(r.kept.length === 1 && r.halt === true && !e.cmds().includes('STORE') && /일지/.test(r.error || '') && e.ids('INBOX').length === 3,
      '일지 쓰기 실패 — STORE 를 보내지 않고 kept, halt', short(r));
    safe(e);
  }
  {
    // setJournalFile 은 모듈 기본 일지를 바꾼다 — moveUids 가 journal 을 안 받으면 그것을 쓴다
    const file = path.join(tmp, 'default.json');
    mm.setJournalFile(file);
    const e = await env({ caps: NOMOVE_UP, statusStale: true });
    const r = await mm.moveUids(e.c, [1000], 'Trash', { accKey: 'a1' });
    ok(!!r.block && mm.journal().dump().pending.length === 0, '(묵은 STATUS 로 멈춤 — 기본 일지를 썼다)', short(r));
    await mm.journal().block('a1', r.block);
    ok(JSON.parse(fs.readFileSync(file, 'utf8')).blocked.a1.why === r.block, '…기본 일지가 파일로 간다', fs.readFileSync(file, 'utf8'));
    mm.setJournalFile(null);
    ok(mm.journal().blocked('a1') === null, '…null 이면 메모리 일지로 돌아간다');
  }

  console.log('\n[P] 계정 멈춤·풀기');
  {
    const j = mm.memJournal();
    await j.block('a1', '서버가 지움 표시를 거부해 원본을 남겼습니다');
    ok(j.blocked('a1') === '서버가 지움 표시를 거부해 원본을 남겼습니다' && j.blocked('a2') === null, 'block 은 까닭을 기억한다', j.dump().blocked);
    const s = j.dump().blocked.a1;
    ok(typeof s.at === 'number' && s.at > 0, '…시각도', s);
    ok(await j.unblock('a1') === true && j.blocked('a1') === null && await j.unblock('a1') === false, 'unblock 은 풀었는지 돌려준다');
    const file = path.join(tmp, 'unblock.json');
    mm.setJournalFile(file);
    await mm.journal().block('a7', '시험');
    ok(await mm.unblock('a7') === true && mm.journal().blocked('a7') === null && !JSON.parse(fs.readFileSync(file, 'utf8')).blocked.a7,
      'mm.unblock — 설정 창의 «다시 해 보기»가 부를 엔진 함수 (파일에서도 지운다)');
    ok(JSON.stringify(mm.blockedList()) === '{}', '…blockedList 는 { 계정: { why, at } }', mm.blockedList());
    mm.setJournalFile(null);
  }

  console.log('\n[Q] 서버 기능 한 줄 (capsLine) — 비밀이 아닌 것만');
  {
    const caps = new Map([['IMAP4rev1', true], ['UIDPLUS', true], ['ID', true], ['AUTH=PLAIN', true], ['X-GM-EXT-1', true],
      ['kim@corp.example', true], ['has space', true], ['A'.repeat(60), true], ['비밀', true], ['IDLE', true]]);
    const line = mm.capsLine({ capabilities: caps, enabled: new Set(), serverInfo: { name: 'Ecount IMAP<script>', version: '2.1 beta', vendor: 'x', 'support-url': 'http://x' }, host: 'imap.secret.invalid', user: 'kim@corp.example' });
    ok(/^옮기기\(MOVE\) 없음 · UIDPLUS 있음 · 용도 표시\(SPECIAL-USE\) 없음 · /.test(line), '요약 — MOVE·UIDPLUS·SPECIAL-USE 있음/없음', line);
    ok(/ IMAP4rev1 /.test(line) && /UIDPLUS ID AUTH=PLAIN X-GM-EXT-1 IDLE/.test(line), '…능력 이름은 그대로', line);
    ok(!/@|has space|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|비밀|secret|kim|[<>]|http/.test(line), '…주소·공백·긴 값·한글·호스트·아이디·꺾쇠·주소창은 없다', line);
    ok(/ · 서버 Ecount IMAPscript 2\.1 beta$/.test(line), '…서버 ID 는 이름·판만 (안전한 글자만)', line);
    const many = new Map(Array.from({ length: 80 }, (_, i) => [`X-CAP${i}`, true]));
    const l2 = mm.capsLine({ capabilities: many });
    ok(l2.split(' · ').pop().split(' ').length === 40, '…능력 이름은 40개까지', l2.length);
    const l3 = mm.capsLine({ capabilities: new Map([['IMAP4rev2', true]]), enabled: new Set() });
    ok(/MOVE\) 있음 · UIDPLUS 있음 · 용도 표시\(SPECIAL-USE\) 있음/.test(l3), 'IMAP4rev2 만 말하는 서버 — MOVE·UIDPLUS·SPECIAL-USE 가 들어 있다 (imapflow 와 같은 판단)', l3);
    ok(mm.capsLine(null) === '옮기기(MOVE) 없음 · UIDPLUS 없음 · 용도 표시(SPECIAL-USE) 없음', '기능 목록이 없으면 모두 없음', mm.capsLine(null));
  }

  // 던지면 정리(mailtidy)가 미리 적은 열쇠가 남아 그 메일은 영영 정리되지 않는다 — 결과로 돌려줘야 한다
  const tryMove = (c, uids, j) => mm.moveUids(c, uids, 'Trash', { accKey: 'a1', journal: j }).then((r) => r, (x) => ({ thrown: x.message }));

  console.log('\n[S] 복사를 보내기 전의 실패 — 던지지 않고 left (열쇠를 지워도 된다), 끊김·한 번의 거절로 계정을 멈추지 않는다');
  {
    // 첫 UID SEARCH DELETED 에서 끊김 — imapflow 는 던지지 않고 false
    const e = await env({ caps: NOMOVE, dropAt: 'search' });
    const r = await tryMove(e.c, [1000, 1001], mm.memJournal());
    ok(!r.thrown && JSON.stringify(r.left) === '[1000,1001]' && !r.block && !r.unsure && !e.cmds().includes('COPY'),
      'UIDPLUS 없음 · 첫 검색에서 끊김 — left, 멈추지 않음, COPY 없음', r.thrown ? r : short(r));
    safe(e);
  }
  {
    // 연결은 사는데 서버가 검색을 한 번 거절
    const e = await env({ caps: NOMOVE, searchReturns: false });
    const r = await tryMove(e.c, [1000], mm.memJournal());
    ok(!r.thrown && JSON.stringify(r.left) === '[1000]' && !r.block && /검색/.test(r.error || '') && !e.cmds().includes('COPY'),
      'UIDPLUS 없음 · 검색 거절 — left + 까닭, 멈추지 않음', r.thrown ? r : short(r));
    safe(e);
  }
  for (const caps of [NOMOVE, NOMOVE_UP]) {
    // 복사 전 휴지통 STATUS 에서 끊김 — imapflow 의 status 는 false 를 준다. «서버가 UIDNEXT 를 안 준다»로 읽으면 안 된다
    const e = await env({ caps, dropAt: 'status' });
    const r = await tryMove(e.c, [1000], mm.memJournal());
    ok(!r.thrown && JSON.stringify(r.left) === '[1000]' && !r.block && !r.unsure && r.kept.length === 0 && !e.cmds().includes('COPY'),
      `${caps.join('+')} · 복사 전 STATUS 에서 끊김 — left (COPY 를 안 보냈다), 멈추지 않음`, r.thrown ? r : short(r));
    safe(e);
  }
  {
    // COPY 를 보내려는 순간 이미 끊겨 있다 — run 이 보내기 전에 던진다. 복사본이 생겼을 리 없다
    const e = await env({ caps: NOMOVE_UP });
    const realRun = e.c.run.bind(e.c);
    e.c.run = async (cmd, ...a) => { if (cmd === 'COPY') e.c.close(); return realRun(cmd, ...a); };
    const r = await tryMove(e.c, [1000], mm.memJournal());
    ok(!r.thrown && JSON.stringify(r.left) === '[1000]' && !r.unsure && !r.block,
      'COPY 를 보내기 전에 연결이 없음 — unsure 가 아니라 left', r.thrown ? r : short(r));
    safe(e);
  }
  {
    // 지난번에 남은 내 표시를 풀지 못함 — 이 폴더는 건너뛰되 던지지 않는다
    const e = await env({ caps: NOMOVE_UP, storeNo: true }, { inbox: [1001, 1002], extraInbox: [mk(1000, { flags: ['\\Deleted'] })] });
    const j = mm.memJournal();
    await j.add('a1', 'INBOX', String(V), [1000]);
    const r = await tryMove(e.c, [1001], j);
    ok(!r.thrown && JSON.stringify(r.left) === '[1001]' && /풀지 못해/.test(r.error || '') && !e.cmds().includes('COPY') && j.dump().pending.length === 1,
      '남은 표시를 못 풂 — left + 까닭, 일지는 그대로', r.thrown ? r : short(r));
    safe(e);
  }
  for (const caps of [NOMOVE, NOMOVE_UP]) {
    // 복사 뒤 휴지통 STATUS 에서 끊김 — 복사본이 있을 수 있다 (unsure + kept). 서버 탓이 아니라 멈추지 않는다
    const e = await env({ caps, dropAt: 'status', dropAtN: 2 });
    const j = mm.memJournal();
    const r = await tryMove(e.c, [1000], j);
    ok(!r.thrown && !!r.unsure && JSON.stringify(r.kept) === '[1000]' && !r.block && !e.cmds().includes('STORE') && j.dump().pending.length === 0,
      `${caps.join('+')} · 복사 뒤 STATUS 에서 끊김 — unsure·kept, 멈추지 않음, 지움 표시 없음`, r.thrown ? r : short(r));
    safe(e);
  }

  console.log('\n[T] SELECT 답에 UIDVALIDITY 가 한 번 빠져도 일지의 «내 지움 표시» 줄을 버리지 않는다');
  for (const caps of [NOMOVE, NOMOVE_UP]) {
    const e = await env({ caps, dropAt: 'store' });
    const j = mm.memJournal();
    await tryMove(e.c, [1000], j);
    e.server.spec.a1.dropAt = undefined;
    e.server.box('a1', 'INBOX').noUidValidity = true;
    const c2 = await e.open();
    const copies0 = count(e.cmds(), 'COPY');
    const r2 = await tryMove(c2, [1001], j);
    ok(j.dump().pending.length === 1 && e.inboxFlags()[1000].includes('\\Deleted') && !r2.thrown,
      `${caps.join('+')} · UIDVALIDITY 없는 답 — 일지 줄과 표시를 그대로 둔다`, { pending: j.dump().pending, r2: r2.thrown || short(r2) });
    // 일지는 UIDVALIDITY 로 메일을 가른다 — 모르는 채로 복사·지움 표시를 하면 끊긴 뒤 어느 표시를 풀지 알 수 없다
    ok(!r2.thrown && JSON.stringify(r2.left) === '[1001]' && r2.moved.length === 0 && count(e.cmds(), 'COPY') === copies0,
      '…그 답으로는 복사도 하지 않는다 (left)', r2.thrown ? r2 : short(r2));
    const st0 = await mm.settle(c2, { accKey: 'a1', journal: j });
    ok(st0.undone === 0 && j.dump().pending.length === 1, '…settle 도 그 답으로는 줄을 버리지 않는다', st0);
    e.server.box('a1', 'INBOX').noUidValidity = false;
    const c3 = await e.open();
    const r3 = await tryMove(c3, [1002], j);
    ok(r3.undone === 1 && !e.inboxFlags()[1000].includes('\\Deleted') && j.dump().pending.length === 0 && JSON.stringify(r3.moved) === '[1002]',
      '…다음 정상 답에서 내 표시를 풀고 옮긴다', { r3: r3.thrown || short(r3), flags: e.inboxFlags() });
    safe(e);
  }

  console.log('\n[U] 일지 파일을 잠깐 못 읽음(EBUSY) — 빈 일지로 덮어쓰지 않고, 그동안 복사도 하지 않는다');
  {
    const file = path.join(tmp, 'busy.json');
    const before = { v: 1, pending: [{ acc: 'a1', box: 'INBOX', v: String(V), uids: [1000], at: 1 }], blocked: { a2: { why: '시험 멈춤', at: 1 } }, trusted: { a1: 1 } };
    fs.writeFileSync(file, JSON.stringify(before));
    const realRead = fs.readFileSync;
    let busy = true;
    fs.readFileSync = function patched(p, ...a) {
      if (busy && p === file) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' });
      return realRead.call(this, p, ...a);
    };
    try {
      const j = mm.fileJournal(file);
      ok(typeof j.ready === 'function' && j.ready() === false, '못 읽은 일지는 «준비 안 됨»', typeof j.ready);
      await j.trust('a3');
      const disk = JSON.parse(realRead.call(fs, file, 'utf8'));
      ok(disk.pending.length === 1 && !!disk.blocked.a2 && !disk.trusted.a3, '…저장이 남은 표시·멈춘 계정을 덮어쓰지 않는다', disk);
      const e = await env({ caps: NOMOVE_UP });
      const r = await tryMove(e.c, [1001], j);
      ok(!r.thrown && r.halt === true && JSON.stringify(r.left) === '[1001]' && !e.cmds().includes('COPY'),
        '…그동안 옮기기는 복사도 하지 않고 멈춘다 (halt)', r.thrown ? r : short(r));
      busy = false;
      ok(j.blocked('a2') === '시험 멈춤' && j.trusted('a1') && j.trusted('a3') && j.dump().pending.length === 1,
        '…다시 읽히면 파일 내용 위에 그동안 바꾼 것(a3 믿음)을 더한다', j.dump());
      await sleep(20);
      const disk2 = JSON.parse(realRead.call(fs, file, 'utf8'));
      ok(!!disk2.trusted.a3 && !!disk2.blocked.a2 && disk2.pending.length === 1, '…그리고 그것을 파일에 쓴다', disk2);
    } finally {
      fs.readFileSync = realRead;
    }
  }
  {
    const file = path.join(tmp, 'broken2.json');
    fs.writeFileSync(file, '{ 깨진');
    const seen = [];
    const j = mm.fileJournal(file, { onBroken: (moved) => seen.push(moved) });
    ok(j.dump().pending.length === 0 && JSON.stringify(seen) === '[true]', '깨진 일지를 비킬 때 알린다 (기록에 남기게)', seen);
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    ok(/mailmove\.setJournalFile\(path\.join\(app\.getPath\('userData'\), mailmove\.JOURNAL_FILE\), \{ onBroken: journalBroken \}\)/.test(mainSrc)
      && /logReady = true;\s*\r?\n\s*for \(const msg of journalNotes\.splice\(0\)\) evlog\.log\('메일', msg\);/.test(mainSrc),
    '…main.js 가 그 알림을 받아 기록이 켜진 뒤 남긴다 (소스 검사 — 앱을 띄우지 않는다)');
  }

  console.log('\n[V] 거짓 COPY OK + 휴지통 UIDNEXT 구멍 — 휴지통 메일 수(MESSAGES)도 늘어야 증명');
  for (const caps of [NOMOVE, NOMOVE_UP]) {
    const e = await env({ caps, copyLies: true, hooks: { afterCopy: ({ client }) => { client.server.box('a1', 'Trash').nextUid += 5; } } });
    const r = await tryMove(e.c, [1000], mm.memJournal());
    ok(!r.thrown && r.moved.length === 0 && JSON.stringify(r.kept) === '[1000]' && !!r.block && !e.cmds().includes('STORE'),
      `${caps.join('+')} — UIDNEXT 는 늘었지만 메일 수가 그대로 — 지우지 않고 멈춤`, r.thrown ? r : short(r));
    safe(e);
  }

  console.log('\n[W] UIDPLUS 라면서 UID 지우기가 폴더 전체를 지우는 서버 — 알아채고 멈춘다');
  {
    const e = await env({ caps: NOMOVE_UP, uidExpungeAll: true }, { extraInbox: [mk(1005, { flags: ['\\Deleted'] })] });
    const j = mm.memJournal();
    const r = await tryMove(e.c, [1000], j);
    ok(!r.thrown && JSON.stringify(r.moved) === '[1000]' && !!r.block && /다른 프로그램이 지움 표시만 해 둔 메일 1통/.test(r.block || ''),
      '남의 지움 표시 1005 가 함께 사라짐 — 멈춤(block)으로 다음 옮기기를 막는다', r.thrown ? r : short(r));
    ok(!j.trusted('a1'), '…이 계정을 믿지 않는다', j.dump());
  }

  console.log('\n[R] 소스 검사 — 공개 지우기·복사·플래그 메서드를 부르지 않는다');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mailmove.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
    const hit = src.match(/\.(?:messageDelete|messageCopy|messageFlags(?:Add|Set|Remove))\s*\(|mailboxClose|['"`]CLOSE['"`]/);
    ok(!hit, 'mailmove.js(주석 제외)에 .messageCopy( · .messageDelete( · .messageFlags*( · mailboxClose 가 없다', hit && hit[0]);
    const fn = src.match(/async function expungeCmd[\s\S]*?\n}\n/);
    const outside = fn ? src.replace(fn[0], '') : src;
    ok(!!fn && /EXPUNGE/.test(fn[0]) && !/EXPUNGE/.test(outside), 'EXPUNGE 명령 글은 expungeCmd 안에만 있다', !!fn);
    ok(/run\('COPY'/.test(src) && /run\('STORE'/.test(src), '(검사가 헛돌지 않는다 — run(COPY)·run(STORE) 는 있다)');
  }

  console.log(bad ? `\n실패 ${bad}` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

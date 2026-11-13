'use strict';
// 휴지통 단추·스팸 규칙 — MOVE 가 없는 서버(이카운트형)에서도 메일을 잃지 않고 옮기는가 (src/mail.js moveToTrash·moveToSpam).
//
// 창도 Electron 도 쓰지 않는다 — 연결은 가짜 IMAP 클라이언트(test/fixtures/fake-imap.js)를 넣어 준다.
// 계정 주소는 127.0.0.1 의 닫힌 포트다 — 넣어 준 연결을 안 쓰는 코드가 있어도 바깥 서버에는 붙지 않는다.
//   [1] 이카운트형 — 용도 표시 없는 «휴지통», MOVE·UIDPLUS 없음   [2] 휴지통 이름 짐작   [3] 휴지통이 없거나 이미 휴지통
//   [4] 서버가 거절하면 지운 척하지 않는다   [5] 계정 멈춤 — 규칙은 연결 전에 멈추고, 사람이 누른 단추는 해 보고 풀어 준다
//   [6] 첫 묶음 1통 시험   [7] MOVE 서버는 지금 그대로
//   [8] 단추가 계정을 멈추면 알림이 복사본과 자동 일의 멈춤을 말한다 · 멈춘 계정의 규칙 오류에는 blocked 표시 (규칙이 되풀이하지 않게)
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src', 'mail.js'));
const mailmove = require(path.join(ROOT, 'src', 'mailmove.js'));
const { makeServer } = require(path.join(__dirname, 'fixtures', 'fake-imap.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 90_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const V = 1700000000n;
function mk(uid) {
  const id = `m${uid}@corp.example`;
  return { uid, raw: `Message-ID: <${id}>\r\nSubject: s${uid}\r\n\r\nbody\r\n`, date: new Date(Date.UTC(2026, 0, 1)), subject: `s${uid}`, flags: [], labels: [], messageId: `<${id}>` };
}
// 닫힌 포트 — 이 연결을 실제로 쓰면 곧바로 거부된다
const ACC = { id: 'a1', name: '이카운트', user: 'kim@corp.example', host: '127.0.0.1', port: 1 };
const ECOUNT = ['IMAP4rev1'];

function env({ caps = ECOUNT, trash = '휴지통', junk = '스팸메일함', inbox = [1000, 1001, 1002], spec = {} } = {}) {
  const boxes = [{ path: 'INBOX', uidValidity: V, msgs: inbox.map(mk) }];
  if (trash) boxes.push({ path: trash, uidValidity: V, msgs: [] });
  if (junk) boxes.push({ path: junk, uidValidity: V, msgs: [] });
  const server = makeServer({ a1: { caps, boxes, ...spec } });
  const journal = mailmove.memJournal();
  const ids = (p) => (server.box('a1', p) ? server.box('a1', p).msgs.map((m) => m.messageId) : []);
  const cmds = () => server.log.map((e) => e.cmd);
  const all = inbox.map((u) => `<m${u}@corp.example>`);
  const lost = () => all.filter((id) => ![...ids('INBOX'), ...(trash ? ids(trash) : []), ...(junk ? ids(junk) : [])].includes(id));
  return { server, journal, ids, cmds, lost, opts: { connect: (acc) => server.connect(acc), journal } };
}
const safe = (e) => ok(e.lost().length === 0 && e.server.forbidden().length === 0, '…잃은 메일 0 · 금지 명령 0', { lost: e.lost(), forbidden: e.server.forbidden() });
const err = (p) => p.then(() => null, (x) => (x && x.message) || String(x));

(async () => {
  console.log('\n[1] 이카운트형 — 용도 표시 없는 «휴지통», MOVE·UIDPLUS 없음');
  {
    const e = env();
    const r = await mail.moveToTrash(ACC, [1000], { ...e.opts });
    ok(r.moved === 1 && r.how === 'copy' && r.mailbox === '휴지통' && e.ids('휴지통').length === 1 && e.ids('INBOX').length === 2, '휴지통 단추 — 복사 후 지움으로 1통', r);
    ok(!e.cmds().includes('messageMove') && e.cmds().includes('COPY') && e.cmds().includes('EXPUNGE'), '…imapflow messageMove 를 부르지 않는다', e.cmds());
    ok(e.cmds().includes('logout'), '…연결은 닫는다');
    safe(e);
  }
  {
    const e = env();
    const r = await mail.moveToSpam(ACC, [1001], { ...e.opts });
    ok(r.moved === 1 && r.how === 'copy' && r.mailbox === '스팸메일함' && e.ids('스팸메일함').length === 1, '스팸 규칙 — 같은 길로 1통', r);
    safe(e);
  }

  console.log('\n[2] 휴지통 이름 짐작');
  {
    const yes = ['지운메일함', '지운 메일함', '삭제메일함', '삭제된 메일', '삭제된메일', 'Deleted Mail', 'Recycle Bin', ' 휴지통 ', '휴지통', 'Trash', 'Deleted Items', '지운편지함'];
    const no = ['받은편지함', 'INBOX', '휴지통 보관', 'Trash backup', '내 메일'];
    const pick = (name) => mail.pickBox([{ path: `INBOX/${name}`, name, delimiter: '/' }], 'trash');
    ok(yes.every((n) => !!pick(n)), '국내 메일의 흔한 휴지통 이름과 앞뒤 공백', yes.filter((n) => !pick(n)));
    ok(no.every((n) => !pick(n)), '…다른 폴더는 고르지 않는다', no.filter((n) => !!pick(n)));
    ok(yes.every((n) => mail.BOX_NAMES.trash.test(n.trim())), 'BOX_NAMES.trash 정규식 (정리가 빼는 폴더도 같이 넓어진다)');
    const e = env({ trash: '지운메일함' });
    const r = await mail.moveToTrash(ACC, [1000], { ...e.opts });
    ok(r.moved === 1 && r.mailbox === '지운메일함', '«지운메일함»으로 옮긴다', r);
    safe(e);
  }

  console.log('\n[3] 휴지통이 없거나 이미 휴지통');
  {
    const e = env({ trash: null });
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(m === '휴지통 폴더를 찾지 못했습니다' && !e.cmds().some((x) => ['COPY', 'STORE', 'EXPUNGE', 'messageMove'].includes(x)) && e.ids('INBOX').length === 3,
      '휴지통이 없으면 아무것도 바꾸지 않고 말한다', { m, cmds: e.cmds() });
    ok(e.cmds().includes('logout'), '…연결은 닫는다');
  }
  {
    const e = env();
    e.server.box('a1', '휴지통').msgs.push(mk(2000));
    const r = await mail.moveToTrash(ACC, [2000], { ...e.opts, mailbox: '휴지통' });
    ok(r.moved === 0 && r.already === true && e.ids('휴지통').length === 1 && !e.cmds().includes('COPY'), '이미 휴지통이면 already — 진짜 삭제로 넘어가지 않는다', r);
  }

  console.log('\n[4] 서버가 거절하면 지운 척하지 않는다');
  {
    const e = env({ spec: { copyNo: { responseText: 'Quota exceeded' } } });
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(/서버가 복사를 거부했습니다/.test(m || '') && /Quota exceeded/.test(m || '') && e.ids('INBOX').length === 3 && !e.cmds().includes('STORE'), 'COPY 거절 — 서버 글과 함께 던지고 원본은 그대로', m);
    safe(e);
  }
  {
    const e = env({ spec: { dropAt: 'copy' } });
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(/연결이 끊겼습니다/.test(m || '') && e.ids('INBOX').length === 3, 'COPY 뒤 끊김 — «복사본이 생겼을 수 있음»을 말한다', m);
    safe(e);
  }

  console.log('\n[5] 계정 멈춤');
  {
    const e = env();
    await e.journal.block('a1', '서버가 지움 표시를 거부해 원본을 남겼습니다 — 휴지통에 복사본이 있습니다');
    const m = await err(mail.moveToSpam(ACC, [1000], { ...e.opts }));
    ok(/옮기기를 멈췄습니다/.test(m || '') && /지움 표시를 거부/.test(m || '') && !e.cmds().includes('connect'), '스팸 규칙 — 멈춘 계정은 연결도 하지 않는다', { m, cmds: e.cmds() });
    const r = await mail.moveToTrash(ACC, [1000], { ...e.opts });
    ok(r.moved === 1 && e.journal.blocked('a1') === null, '휴지통 단추 — 사람이 누른 것은 해 보고, 끝까지 되면 멈춤을 푼다', { r, blocked: e.journal.blocked('a1') });
    safe(e);
  }
  {
    // 멈춘 계정에서 단추가 끝까지 못 함 (한 번의 복사 거절 — 서버 탓 멈춤은 아니다) — 멈춤은 그대로 둔다
    const e = env({ spec: { copyNo: { responseText: 'Quota exceeded' } } });
    await e.journal.block('a1', '시험 멈춤');
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(/복사를 거부/.test(m || '') && e.journal.blocked('a1') === '시험 멈춤', '…끝까지 못 하면 멈춤을 풀지 않는다 (자동 일이 다시 돌지 않게)', { m, blocked: e.journal.blocked('a1') });
    safe(e);
  }
  {
    const e = env({ spec: { statusStale: true } });
    const m = await err(mail.moveToSpam(ACC, [1000], { ...e.opts }));
    ok(!!m && !!e.journal.blocked('a1') && e.ids('INBOX').length === 3, '스팸 규칙이 서버 탓 실패를 내면 그 계정을 멈춘다', { m, blocked: e.journal.blocked('a1') });
    const n = e.server.log.length;
    const m2 = await err(mail.moveToSpam(ACC, [1001], { ...e.opts }));
    ok(/멈췄습니다/.test(m2 || '') && e.server.log.length === n, '…다음 규칙은 서버를 부르지 않는다 (매번 복사본을 만들지 않게)', m2);
    safe(e);
  }
  {
    const e = env({ spec: { storeNo: true } });
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(!!m && !!e.journal.blocked('a1'), '단추도 서버 탓 실패면 멈춤을 적는다 (자동 일이 되풀이하지 않게)', { m, blocked: e.journal.blocked('a1') });
    safe(e);
  }

  console.log('\n[6] 첫 묶음 1통 시험');
  {
    const e = env({ inbox: [1000, 1001, 1002, 1003] });
    const r = await mail.moveToSpam(ACC, [1000, 1001, 1002, 1003], { ...e.opts });
    const ranges = e.server.log.filter((x) => x.cmd === 'COPY').map((x) => x.range);
    ok(r.moved === 4 && JSON.stringify(ranges) === '["1000","1001:1003"]', '처음 쓰는 서버는 1통으로 시험하고, 되면 나머지를 한 번에', ranges);
    safe(e);
  }

  console.log('\n[7] MOVE 서버는 지금 그대로');
  {
    const e = env({ caps: ['IMAP4rev1', 'MOVE', 'UIDPLUS'], trash: 'Trash' });
    const r = await mail.moveToTrash(ACC, [1000, 1001], { ...e.opts });
    ok(r.moved === 2 && r.how === 'move' && e.cmds().filter((x) => x === 'messageMove').length === 1 && !e.cmds().includes('COPY'), 'UID MOVE 한 번', { r, cmds: e.cmds() });
    safe(e);
  }
  {
    const e = env({ caps: ['IMAP4rev1', 'MOVE', 'UIDPLUS'], trash: 'Trash', spec: { moveNo: { serverResponseCode: 'THROTTLED', responseText: 'slow down' } } });
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(/서버가 옮기기를 거부했습니다/.test(m || '') && /속도를 제한/.test(m || ''), 'MOVE 거절 — 서버의 까닭을 붙인다', m);
    safe(e);
  }

  console.log('\n[8] 멈춤을 알리는 말');
  {
    const e = env({ caps: ['IMAP4rev1', 'UIDPLUS'], spec: { copyuidMissing: true } });
    const m = await err(mail.moveToTrash(ACC, [1000], { ...e.opts }));
    ok(/휴지통에 복사본이 생겼습니다/.test(m || '') && /다시 해 보기/.test(m || '') && mail.friendly(new Error(m)) === m,
      'COPYUID 없음 — 알림이 복사본(다시 누르면 또 생긴다)과 «다시 해 보기» 전까지의 멈춤을 말한다 (잘리지 않는 길이)', m);
    const e2 = env({ spec: { statusStale: true } });
    await err(mail.moveToSpam(ACC, [1000], { ...e2.opts }));
    const x = await mail.moveToSpam(ACC, [1001], { ...e2.opts }).then(() => null, (y) => y);
    ok(!!x && x.blocked === true && /멈췄습니다/.test(x.message), '멈춘 계정의 규칙 오류에는 blocked 표시 — 규칙은 «다시 해봅니다»를 되풀이하지 않는다', x && { blocked: x.blocked, m: x.message });
  }

  console.log(bad ? `\n실패 ${bad}` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

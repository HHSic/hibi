'use strict';
// 서버 정리 — PC에 저장이 «확인된» 오래된 메일만 서버 휴지통으로 옮기는가 (src/mailtidy.js).
//
// 창도 Electron 도 쓰지 않는다 — 가짜 IMAP 클라이언트(test/fixtures/fake-imap.js)와 임시 백업 폴더로만 돈다.
// node 로도, npx electron 으로도 돈다. 진짜 메일 서버·자격 증명 관리자는 건드리지 않는다.
//   [1] 순수 함수 — 기간·Message-ID·헤더 읽기·검색 날짜·UIDVALIDITY·주소 가리기·계정 이름·MOVE 판단
//   [2] 확인된 것만 옮긴다            [3] 확인이 하나라도 불확실하면 남긴다 (S1)
//   [4] 별표·중요·메모는 남긴다       [5] 정리하지 않는 폴더·공유 폴더는 열지도 않는다
//   [6] 휴지통이 없으면 그 계정은 옮기지 않는다 (S2)
//   [7] MOVE가 없으면 정리하지 않고, 대체 경로(COPY+지우기)는 연결에서 막힌다
//   [8] 계정 하나가 넘어져도 나머지는 한다 (S6)   [9] 한 번에 옮기는 양 (S4)
//   [10] 세기만 하기(dry-run)는 읽기 전용 (S7)    [11] 검색이 답하지 않음   [12] 옮기기가 거부됨
//   [13] UID는 폴더마다 (S3)          [14] 금지 명령을 소스에 쓰지 않았다
//   [15] 연결은 늘 닫는다 · 끊으라면 걸린 명령도 끊는다   [16] 휴지통에서 되찾은 메일은 다시 옮기지 않는다
//   [17] 받은 지 기간은 서버의 날짜 검색이 아니라 받아 온 internalDate 로 다시 본다
//   [18] 옮기는 중에 끊기면 «옮겨졌을 수 있음»을 남기고, 미리 적어 둔 열쇠로 되찾은 메일을 지킨다
//   [19] 느린 계정이 시간 몫을 다 써도 다음 계정은 제 차례를 받는다
//   [20] «바로»(0일) — 날짜는 보지 않고 읽은(\Seen) 것만. 안 읽은 것은 «읽을 때까지 남김»(unread)으로만 센다 —
//        서버가 읽음 조건을 지키든 흘려듣든 같은 수, 옮기기 직전에는 플래그를 다시 받아 본다, 되찾은 메일은 다시 옮기지 않는다,
//        늘 남기는 메일은 기억해 두고 몇 분마다 다시 받지 않는다
//   [21] 보기 창에 떠 있는 메일은 옮기지 않는다 (모든 기간) — 다른 폴더라도 Message-ID 가 같으면
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
const { makeServer } = require(path.join(__dirname, 'fixtures', 'fake-imap.js'));
const { hasCapability } = require('imapflow/lib/tools.js');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 120_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailtidy-'));
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const DAY = 86_400_000;
const V = 1700000000n;   // 서버 UIDVALIDITY (imapflow 는 BigInt 로 준다)

/** 메일 한 통 — 원문(raw)이 서버와 PC 파일 양쪽의 근거다 */
function mk(uid, o = {}) {
  const id = o.id === undefined ? `m${uid}@corp.example` : o.id;   // null 이면 Message-ID 없음
  const date = new Date(NOW - (o.daysAgo == null ? 60 : o.daysAgo) * DAY);
  const subject = o.subject || `report ${uid}`;
  const head = [
    id ? `Message-ID: <${id}>` : null,
    `Date: ${o.dateHdr || date.toUTCString()}`,
    `From: ${o.from || 'Kim <kim@corp.example>'}`,
    `Subject: ${subject}`,
    ...(o.extra || []),
    'MIME-Version: 1.0'
  ].filter(Boolean).join('\r\n');
  const raw = `${head}\r\n\r\nbody of ${uid}\r\n${o.body || ''}`;
  return {
    uid, raw, date, subject, flags: o.flags || [], labels: o.labels || [],
    messageId: id ? `<${id}>` : null,
    file: o.file, noFile: !!o.noFile
  };
}
const TRASH = () => ({ path: 'Trash', specialUse: '\\Trash', uidValidity: V, msgs: [] });
const box = (p, msgs, extra = {}) => ({ path: p, uidValidity: V, msgs, ...extra });
const acct = (id, over = {}) => ({ id, name: `회사${id}`, user: `${id}@corp.example`, host: `imap.${id}.invalid`, port: 993, ...over });

/**
 * 가짜 서버 + 임시 백업 폴더. 상자마다 noState·stateV·gen·fileGen 으로 백업 기록을 비틀 수 있다.
 * @param specs [{ acc, caps, namespaces, boxes, ... }]
 */
let seq = 0;
function setup(specs, { state = true } = {}) {
  const dir = path.join(TMP, `b${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const spec = {};
  const st = {};
  for (const a of specs) {
    spec[a.acc.id] = a;
    const key = mailbackup.accountKey(a.acc);
    st[key] = {};
    for (const b of a.boxes) {
      if (!b.noState) {
        st[key][b.path] = {
          uidValidity: b.stateV !== undefined ? b.stateV : String(b.uidValidity),
          gen: b.gen || 1, lowUid: 1, lastUid: 99999
        };
      }
      if (b.noFiles) continue;
      const bd = mailbackup.boxDirFor(dir, a.acc, b.path, b.fileGen || b.gen || 1);
      fs.mkdirSync(bd, { recursive: true });
      for (const m of b.msgs || []) {
        if (m.noFile) continue;
        fs.writeFileSync(path.join(bd, `20250101_0900_${m.uid}_제목.eml`),
          m.file !== undefined ? m.file : Buffer.from(m.raw, 'latin1'));
      }
    }
  }
  if (state) fs.writeFileSync(path.join(dir, 'backup-state.json'), JSON.stringify(st));
  const server = makeServer(spec);
  return { dir, server, accounts: specs.map((a) => a.acc) };
}
const run = (env, opts = {}) => mailtidy.tidyAll(opts.accounts || env.accounts, env.dir, {
  days: 30, now: () => NOW, connect: (acc) => env.server.connect(acc), ...opts
});
const ids = (env, accId, p) => env.server.box(accId, p).msgs.map((m) => m.messageId).sort();
const opened = (env, accId) => env.server.log.filter((e) => e.cmd === 'mailboxOpen' && (!accId || e.acc === accId));
const moves = (env) => env.server.log.filter((e) => e.cmd === 'messageMove');
/** tidy-moved.json 의 열쇠 — 파일이 없으면 빈 목록 (없어서 시험이 죽지 않고 실패로 찍히게) */
const movedKeys = (dir) => {
  const f = path.join(dir, mailtidy.MOVED_FILE);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).keys : [];
};
const pick = (r) => ({ moved: r.moved, verified: r.verified, kept: r.kept, unsaved: r.unsaved, unverified: r.unverified, spared: r.spared, unread: r.unread, skipped: r.skippedBoxes, errors: r.errors, more: r.more });

(async () => {
  console.log('\n[1] 순수 함수');
  ok([0, 7, 30, 90].every((d) => mailtidy.normDays(d) === d), 'normDays — 0(바로)·7·30·90 은 그대로');
  ok(mailtidy.normDays(0) === 0 && Object.is(mailtidy.normDays(-0), 0), 'normDays(0) 은 0 — 거짓 값이라고 30으로 바꾸지 않는다 (-0 도 0)');
  ok(['7', '0', 15, null, NaN, {}, undefined, -1, false, ''].every((d) => mailtidy.normDays(d) === 30), "normDays — '7'·'0'·15·null·NaN·{}·false·'' 는 30");
  ok(JSON.stringify(mailtidy.DAYS) === '[0,7,30,90]', 'DAYS 는 0·7·30·90', mailtidy.DAYS);
  ok(mailtidy.normId('<A@B>') === mailtidy.normId(' a@b ') && mailtidy.normId('<A@B>') === 'a@b', 'normId — <A@B> 와 « a@b »가 같다');
  ok(mailtidy.normId(undefined) === '' && mailtidy.normId('') === '', 'normId — 없으면 빈 글');
  const hf = mailtidy.headerFields;
  ok(hf('Subject: a\r\n  b\r\n\r\nbody').subject === 'a b', 'headerFields — 접힌 줄을 편다');
  ok(hf('SUBJECT: x\r\nmessage-ID: <q@x>\r\n\r\n').subject === 'x' && hf('SUBJECT: x\r\nmessage-ID: <q@x>\r\n\r\n')['message-id'] === '<q@x>', 'headerFields — 이름 대소문자를 가리지 않는다');
  ok(hf('Resent-Message-ID: <r@x>\r\nMessage-ID: <m@x>\r\n\r\n')['message-id'] === '<m@x>', 'headerFields — Resent-Message-ID 는 걸리지 않는다');
  ok(!('message-id' in hf('Subject: a\r\n\r\nMessage-ID: <b@x>\r\n')), 'headerFields — 본문의 줄은 읽지 않는다');
  ok(hf('Subject: first\r\nSubject: second\r\n\r\n').subject === 'first', 'headerFields — 첫 번째 값만');
  ok(hf('Subject: a\nDate: d\n\nbody').date === 'd' && hf('Subject: a\r\nDate: d\r\n\r\nbody').date === 'd', 'headerFields — LF·CRLF 둘 다');
  ok(hf('Subject: a', { whole: true }).subject === 'a' && hf('Subject: a') === null, '빈 줄이 없으면 whole 일 때만 전체를 헤더로 (아니면 null)');
  const cutoffs = [NOW, Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 0, 1, 23, 59, 59, 999), Date.UTC(2026, 1, 28, 12)];
  const sb = cutoffs.map((c) => [c, mailtidy.searchBefore(c).getTime()]);
  ok(sb.every(([c, b]) => b % DAY === 0 && b > c - 2 * DAY && b <= c - DAY), 'searchBefore — UTC 자정, cutoff−2일 초과 cutoff−1일 이하', sb.map(([c, b]) => (c - b) / 3600_000));
  ok(['1', '123', 1700000000n, 42].every((v) => mailtidy.goodV(v)), 'goodV — 양의 정수');
  ok(['undefined', undefined, '0', '', null, '-1', '01', 'abc', NaN].every((v) => !mailtidy.goodV(v)), 'goodV — "undefined"·"0"·""·없음은 거짓');
  ok(mailtidy.maskAddr('회사: kim@corp.example 실패 <a.b@c.d>') === '회사: •••@••• 실패 <•••@•••>', 'maskAddr — 주소를 가린다', mailtidy.maskAddr('회사: kim@corp.example 실패 <a.b@c.d>'));
  ok(mailtidy.labelOf({ name: ' 회사 ' }, 0) === '회사', 'labelOf — 이름');
  ok(mailtidy.labelOf({ name: 'kim@corp.example', user: 'kim@corp.example' }, 0) === '계정 1', 'labelOf — 이름이 주소면 «계정 n»');
  ok(mailtidy.labelOf({ name: '', user: 'x@corp.example' }, 1) === '계정 2', 'labelOf — 이름이 없으면 주소를 쓰지 않고 «계정 n»');
  ok(mailtidy.labelOf({ name: 'ㄱ'.repeat(50) }, 0).length === 30, 'labelOf — 30자까지');
  const capCases = [
    { caps: ['IMAP4rev1', 'MOVE'], en: [] },
    { caps: ['IMAP4rev1'], en: [] },
    { caps: ['IMAP4rev2'], en: [] },
    { caps: ['IMAP4rev1', 'IMAP4rev2'], en: [] },
    { caps: ['IMAP4rev1', 'IMAP4rev2'], en: ['IMAP4REV2'] },
    { caps: [], en: [] }
  ];
  const capRes = capCases.map((c) => {
    const conn = { capabilities: new Map(c.caps.map((x) => [x, true])), enabled: new Set(c.en) };
    return [mailtidy.canMove(conn), hasCapability(conn, 'MOVE')];
  });
  ok(capRes.every(([a, b]) => a === b), 'canMove 가 imapflow tools.hasCapability(c, "MOVE")와 같다', capRes);
  ok(mailtidy.canMove({}) === false && mailtidy.canMove(null) === false, 'canMove — 기능 목록이 없으면 거짓');

  console.log('\n[2] 확인된 것만 옮긴다');
  {
    const env = setup([{
      acc: acct('a1'),
      boxes: [box('INBOX', [mk(1000), mk(1003), mk(1007), mk(1010, { daysAgo: 5 }), mk(1013, { flags: ['\\Flagged'] })]), TRASH()]
    }]);
    const r = await run(env);
    ok(r.moved === 3 && r.kept === 0 && r.errors.length === 0 && r.complete, '오래되고 저장된 3통만 옮긴다 (젊은 것·별표는 남김)', pick(r));
    ok(JSON.stringify(ids(env, 'a1', 'INBOX')) === JSON.stringify(['<m1010@corp.example>', '<m1013@corp.example>']), '받은편지함에 젊은 것·별표만 남았다', ids(env, 'a1', 'INBOX'));
    ok(ids(env, 'a1', 'Trash').length === 3, '휴지통으로 3통', ids(env, 'a1', 'Trash'));
    const rw = opened(env).filter((e) => !e.readOnly);
    ok(rw.length === 1 && rw[0].path === 'INBOX', '쓰기로 연 것은 INBOX 하나', rw.map((e) => e.path));
    ok(moves(env).every((e) => e.destination === 'Trash'), '목적지는 휴지통', moves(env).map((e) => e.destination));
    const rec = JSON.parse(fs.readFileSync(path.join(env.dir, mailtidy.MOVED_FILE), 'utf8'));
    ok(rec.v === 1 && rec.keys.length === 3, 'tidy-moved.json 에 옮긴 3통이 남는다', rec.keys.length);
    ok(env.server.forbidden().length === 0, '금지 명령은 한 번도 불리지 않았다');
  }

  console.log('\n[3] 확인이 불확실하면 남긴다 (S1)');
  const one = async (label, m, boxExtra = {}, opts = {}) => {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [m], boxExtra), TRASH()] }], opts);
    const r = await run(env);
    return { env, r };
  };
  {
    const { r } = await one('nofile', mk(1000, { noFile: true }));
    ok(r.moved === 0 && r.unsaved === 1 && r.kept === 1 && r.unverified === 0, '파일 없음 → 저장 안 됨으로 남김', pick(r));
  }
  {
    const { r } = await one('gen', mk(1000), { gen: 2, fileGen: 1 });
    ok(r.moved === 0 && r.unsaved === 1, '파일이 1세대 폴더에만 있고 기록은 2세대 → 남김', pick(r));
  }
  {
    const { env, r } = await one('uv', mk(1000), { stateV: '1699999999' });
    ok(r.moved === 0 && r.skippedBoxes.includes('INBOX'), 'UIDVALIDITY 가 다르면 폴더를 건너뛴다', pick(r));
    ok(!env.server.log.some((e) => e.cmd === 'search'), '…검색도 하지 않는다');
  }
  {
    const { env, r } = await one('undef', mk(1000), { uidValidity: undefined, stateV: 'undefined' });
    ok(r.moved === 0 && r.skippedBoxes.includes('INBOX'), '서버가 UIDVALIDITY 를 안 주고 기록도 "undefined" → 건너뜀', pick(r));
    ok(!env.server.log.some((e) => e.cmd === 'search'), '…검색도 하지 않는다');
  }
  {
    const { env, r } = await one('norec', mk(1000), { noState: true });
    ok(r.moved === 0 && r.skippedBoxes.includes('INBOX') && !env.server.log.some((e) => e.cmd === 'search'), '그 폴더의 백업 기록이 없으면 건너뜀', pick(r));
  }
  {
    const { r } = await one('nostate', mk(1000), {}, { state: false });
    ok(r.moved === 0 && r.skippedBoxes.includes('INBOX'), '상태 파일이 없으면 건너뜀', pick(r));
  }
  {
    const other = mk(1000, { id: 'someone-else@corp.example' });
    const { r } = await one('idmis', { ...mk(1000), file: Buffer.from(other.raw, 'latin1') });
    ok(r.moved === 0 && r.unverified === 1 && r.kept === 1, 'Message-ID 가 다르면 남김', pick(r));
  }
  {
    const noid = mk(1000, { id: null });
    const { r } = await one('fileNoId', { ...mk(1000), file: Buffer.from(noid.raw, 'latin1') });
    ok(r.moved === 0 && r.unverified === 1, '파일에 Message-ID 가 없으면 남김', pick(r));
  }
  {
    const srv = mk(1000, { id: null });
    const longer = mk(1000, { id: null, body: 'x' });
    const a = await one('noIdSize', { ...srv, file: Buffer.from(longer.raw, 'latin1') });
    ok(a.r.moved === 0 && a.r.unverified === 1, '서버에 Message-ID 가 없고 크기가 다르면 남김', pick(a.r));
    const b = await one('noIdSame', srv);
    ok(b.r.moved === 1, '서버에 Message-ID 가 없어도 크기·헤더가 같으면 옮긴다', pick(b.r));
  }
  {
    const { r } = await one('zero', { ...mk(1000), file: Buffer.alloc(0) });
    ok(r.moved === 0 && r.unverified === 1, '0바이트 파일 → 남김', pick(r));
  }
  {
    const d = mk(1000, { dateHdr: 'Mon, 01 Jan 2024 00:00:00 GMT' });
    const a = await one('date', { ...mk(1000), file: Buffer.from(d.raw, 'latin1') });
    ok(a.r.moved === 0 && a.r.unverified === 1, 'Message-ID 는 같고 Date 가 다르면 남김', pick(a.r));
    const s = mk(1000, { subject: 'something else' });
    const b = await one('subj', { ...mk(1000), file: Buffer.from(s.raw, 'latin1') });
    ok(b.r.moved === 0 && b.r.unverified === 1, 'Message-ID 는 같고 Subject 가 다르면 남김', pick(b.r));
  }
  {
    const srv = mk(1000, { id: null, subject: 'aaaa' });
    const f = mk(1000, { id: null, subject: 'bbbb' });
    ok(f.raw.length === srv.raw.length, '(크기가 같은 두 원문을 만들었다)');
    const { r } = await one('sizeSameHead', { ...srv, file: Buffer.from(f.raw, 'latin1') });
    ok(r.moved === 0 && r.unverified === 1, '크기는 같고 헤더가 다르면 남김', pick(r));
  }
  {
    const m = mk(1000);
    const zeros = await one('nul', { ...m, file: Buffer.alloc(Buffer.byteLength(m.raw, 'latin1')) });
    ok(zeros.r.moved === 0 && zeros.r.unverified === 1, 'NUL 로 찬 파일 → 남김', pick(zeros.r));
    const tailNul = Buffer.concat([Buffer.from(m.raw, 'latin1'), Buffer.alloc(5000)]);
    const t = await one('tailnul', { ...m, file: tailNul });
    ok(t.r.moved === 0 && t.r.unverified === 1, '끝이 NUL 로 찬 파일 → 남김', pick(t.r));
  }
  {
    const m = mk(1000, { id: 'm1000@corp.example' });
    const f = mk(1000, { id: ' M1000@Corp.Example ' });
    const { r } = await one('idcase', { ...m, file: Buffer.from(f.raw, 'latin1') });
    ok(r.moved === 1, 'Message-ID 가 대소문자·꺾쇠·공백만 다르면 옮긴다', pick(r));
  }
  {
    // 서버에는 Message-ID 가 없는데 파일에는 있다 — 크기·Date·From·Subject 를 맞춰도 다른 메일이다
    const srv = mk(1000, { id: null, body: 'x'.repeat(19) });
    const f = mk(1000, { id: 'f@x' });
    ok(Buffer.byteLength(srv.raw, 'latin1') === Buffer.byteLength(f.raw, 'latin1'), '(크기가 같은 두 원문을 만들었다 — 서버 쪽만 Message-ID 없음)');
    const { r } = await one('srvNoIdFileId', { ...srv, file: Buffer.from(f.raw, 'latin1') });
    ok(r.moved === 0 && r.unverified === 1, '서버에 Message-ID 가 없는데 파일에 있으면, 크기·헤더가 같아도 남김', pick(r));
  }
  {
    // 읽기 전용으로 고른 뒤 쓰기로 다시 열 때 서버가 UID 를 새로 매겼다 — 그 UID 는 확인한 메일이 아닐 수 있다
    for (const [label, nv] of [['다른 값', 1700000001n], ['없음', undefined]]) {
      const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] };
      spec.hooks = { afterFetch: ({ box: b }) => { b.uidValidity = nv; } };
      const env = setup([spec]);
      const r = await run(env);
      ok(r.moved === 0 && moves(env).length === 0 && r.skippedBoxes.includes('INBOX') && ids(env, 'a1', 'INBOX').length === 2,
        `옮기려고 쓰기로 다시 열 때 UIDVALIDITY 가 ${label}이면 옮기지 않고 건너뛴다`, pick(r));
    }
  }
  {
    // 백업 폴더를 못 읽는다 (그 자리에 파일이 있어 ENOTDIR) — «저장 안 됨»(폴더 없음)과 섞지 않고 «건너뜀»
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000)], { noFiles: true }), TRASH()] }]);
    const bd = mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1);
    fs.mkdirSync(path.dirname(bd), { recursive: true });
    fs.writeFileSync(bd, 'not a folder');
    const r = await run(env);
    ok(r.moved === 0 && r.skippedBoxes.includes('INBOX') && r.unsaved === 0 && r.errors.length === 0 && !env.server.log.some((e) => e.cmd === 'search'),
      '백업 폴더를 못 읽으면 검색도 하지 않고 그 폴더를 건너뛴다 (저장 안 됨으로 세지 않는다)', pick(r));
  }
  {
    // 같은 UID 파일이 둘 — 하나가 깨졌어도 다른 하나가 맞으면 옮긴다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const bd = mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1);
    fs.writeFileSync(path.join(bd, '20240101_0900_1000.eml'), Buffer.alloc(0));
    const r = await run(env);
    ok(r.moved === 1 && r.unverified === 0, '같은 UID 파일이 둘이면 하나만 맞아도 옮긴다', pick(r));
  }

  console.log('\n[4] 별표·중요·메모는 남긴다');
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000, { flags: ['\\Flagged'] }), mk(1003)]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 1 && r.kept === 0 && r.spared === 0 && ids(env, 'a1', 'INBOX').includes('<m1000@corp.example>'), '검색 단계 — 별표는 후보에도 안 든다', pick(r));
  }
  {
    let once = false;
    const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] };
    spec.hooks = { afterSearch: ({ box: b }) => { if (once) return; once = true; b.msgs.find((m) => m.uid === 1000).flags.add('\\Flagged'); } };
    const env = setup([spec]);
    const r = await run(env);
    ok(r.moved === 1 && r.spared === 1 && r.kept === 0 && r.verified === 1 && ids(env, 'a1', 'INBOX').includes('<m1000@corp.example>'),
      '받아 오는 단계 — 검색 뒤 붙은 별표도 남긴다 (판정에서 걸러 확인된 것에 넣지 않는다)', pick(r));
  }
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000, { flags: ['\\Deleted'] }), mk(1003)]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 1 && r.verified === 1 && r.spared === 0 && ids(env, 'a1', 'INBOX').includes('<m1000@corp.example>'),
      '검색 단계 — 지움 표시(\\Deleted)한 메일은 후보에도 안 든다', pick(r));
  }
  {
    let once = false;
    const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] };
    spec.hooks = { afterSearch: ({ box: b }) => { if (once) return; once = true; b.msgs.find((m) => m.uid === 1000).flags.add('\\Deleted'); } };
    const env = setup([spec]);
    const r = await run(env);
    ok(r.moved === 1 && r.spared === 1 && r.verified === 1 && ids(env, 'a1', 'INBOX').includes('<m1000@corp.example>'),
      '받아 오는 단계 — 검색 뒤 붙은 지움 표시도 판정에서 남긴다', pick(r));
  }
  {
    let once = false;
    const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] };
    spec.hooks = { afterFetch: ({ box: b }) => { if (once) return; once = true; b.msgs.find((m) => m.uid === 1003).flags.add('\\Flagged'); } };
    const env = setup([spec]);
    const r = await run(env);
    ok(r.moved === 1 && r.spared === 1 && r.kept === 0 && ids(env, 'a1', 'INBOX').includes('<m1003@corp.example>'), '옮기기 직전 다시 검색 — 그 사이 붙은 별표도 남긴다 (kept 가 아니라 spared)', pick(r));
  }
  {
    const env = setup([{
      acc: acct('a1'), caps: ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'X-GM-EXT-1'],
      boxes: [box('INBOX', [mk(1000, { labels: ['\\Important'] }), mk(1003, { labels: ['\\Starred'] }), mk(1007)]), TRASH()]
    }]);
    const r = await run(env);
    ok(r.moved === 1 && r.spared === 2, 'Gmail \\Important·\\Starred 라벨은 남긴다', pick(r));
  }
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000, { extra: ['X-Uniform-Type-Identifier: com.apple.mail-note'] }), mk(1003)]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 1 && r.spared === 1 && ids(env, 'a1', 'INBOX').includes('<m1000@corp.example>'), 'Apple 메모(X-Uniform-Type-Identifier)는 남긴다', pick(r));
  }

  console.log('\n[5] 정리하지 않는 폴더·공유 폴더는 열지도 않는다');
  {
    let u = 1000;
    const b = (p, extra = {}) => box(p, [mk(u += 3, { id: `x${u}@corp.example` })], extra);
    const env = setup([{
      acc: acct('a1'),
      namespaces: { personal: [{ prefix: '', delimiter: '/' }], other: [{ prefix: 'Other Users/', delimiter: '/' }], shared: [{ prefix: 'shared/', delimiter: '/' }] },
      boxes: [
        b('INBOX'), b('Sent', { specialUse: '\\Sent' }), b('업무'),
        b('Drafts', { specialUse: '\\Drafts' }), b('임시보관함'), b('[Gmail]/All Mail', { specialUse: '\\All' }),
        b('Starred'), b('중요', { flags: ['\\Important'] }), b('Flags', { flags: ['\\Important'] }),
        b('스팸메일함'), b('Trash/old'), b('Notes'), b('Templates'), b('보낼편지함'), b('내게쓴편지함'),
        b('shared/team/INBOX'), b('Other Users/bob/INBOX'), b('Junk', { specialUse: '\\Junk' }), TRASH()
      ]
    }]);
    const r = await run(env);
    const paths = [...new Set(opened(env).map((e) => e.path))].sort();
    ok(JSON.stringify(paths) === JSON.stringify(['INBOX', 'Sent', '업무']), '받은편지함·보낸편지함·업무만 연다 — 임시·전체·별표·중요·스팸·휴지통 밑·메모·서식·보낼·내게쓴·공유는 열지 않는다', paths);
    ok(r.moved === 3 && r.errors.length === 0, '…세 폴더에서 3통 옮긴다', pick(r));
  }
  {
    // 이름으로는 안 걸리는 폴더 (영어·한국어가 아닌 Gmail 등) — 용도 표시만이 막는다.
    // 서버가 준 표시(specialUse 와 flags 둘 다) · imapflow 가 이름으로 짐작한 표시(specialUse 만) · flags 에만 있는 표시
    let u = 2000;
    const b = (p, extra = {}) => box(p, [mk(u += 3, { id: `y${u}@corp.example` })], extra);
    const env = setup([{
      acc: acct('a1'),
      boxes: [
        b('INBOX'),
        b('Brouillons', { specialUse: '\\Drafts', useGuessed: true }),
        b('[Gmail]/Tous les messages', { specialUse: '\\All' }),
        b('[Gmail]/Suivis', { specialUse: '\\Flagged', useGuessed: true }),
        b('Entwürfe', { flags: ['\\Drafts'] }),
        b('Alle Nachrichten', { flags: ['\\All'] }),
        b('Markiert', { flags: ['\\Flagged'] }),
        TRASH()
      ]
    }]);
    const r = await run(env);
    const paths = [...new Set(opened(env).map((e) => e.path))];
    ok(JSON.stringify(paths) === '["INBOX"]' && r.moved === 1, '이름이 달라도 \\Drafts·\\All·\\Flagged 용도 폴더는 열지 않는다 (specialUse 로만 와도, flags 로만 와도)', { paths, ...pick(r) });
  }
  {
    const env = setup([{
      acc: acct('a1'), noNamespace: true,
      boxes: [box('INBOX', [mk(1000)]), box('Public Folders/x', [mk(1003)]), box('공유/팀', [mk(1007)]), TRASH()]
    }]);
    const r = await run(env);
    const paths = [...new Set(opened(env).map((e) => e.path))];
    ok(JSON.stringify(paths) === '["INBOX"]' && r.moved === 1, 'NAMESPACE 가 없는 서버 — Public Folders·공유 밑은 이름으로 빼고 열지 않는다', { paths, ...pick(r) });
  }
  {
    const env = setup([{
      acc: acct('a1'),
      namespaces: { personal: [{ prefix: 'INBOX.', delimiter: '.' }], other: false, shared: [{ prefix: '', delimiter: '.' }] },
      boxes: [
        box('INBOX', [mk(1000)], { delimiter: '.' }), box('INBOX.Sent', [mk(1003)], { delimiter: '.' }),
        box('team', [mk(1007)], { delimiter: '.' }), box('INBOX.Trash', [], { delimiter: '.', specialUse: '\\Trash' })
      ]
    }]);
    const r = await run(env);
    const paths = [...new Set(opened(env).map((e) => e.path))].sort();
    ok(JSON.stringify(paths) === '["INBOX","INBOX.Sent"]' && r.moved === 2, 'Cyrus 꼴(personal INBOX. · shared "") — INBOX·INBOX.Sent 는 처리, team 은 열지 않는다', { paths, ...pick(r) });
  }
  {
    const env = setup([{
      acc: acct('a1'),
      namespaces: { personal: [{ prefix: '', delimiter: '/' }], other: false, shared: [{ prefix: '', delimiter: '/' }] },
      boxes: [box('INBOX', [mk(1000)]), TRASH()]
    }]);
    const r = await run(env);
    ok(r.moved === 0 && r.failedAccounts === 1 && /구분할 수 없어/.test(r.errors[0] || '') && opened(env).length === 0, 'personal·shared 가 둘 다 "" — 그 계정은 오류, 아무것도 열지 않는다', pick(r));
  }

  console.log('\n[6] 휴지통');
  {
    const env = setup([
      { acc: acct('a1'), boxes: [box('INBOX', [mk(1000)])] },
      { acc: acct('a2'), boxes: [box('INBOX', [mk(1000)]), TRASH()] },
      {
        acc: acct('a3'),
        namespaces: { personal: [{ prefix: '', delimiter: '/' }], other: false, shared: [{ prefix: 'shared/', delimiter: '/' }] },
        boxes: [box('INBOX', [mk(1000)]), box('shared/Trash', [], { specialUse: '\\Trash' })]
      }
    ]);
    const r = await run(env);
    ok(ids(env, 'a1', 'INBOX').length === 1 && ids(env, 'a3', 'INBOX').length === 1, '휴지통이 없는 계정은 한 통도 옮기지 않는다 (공유 트리의 Trash 는 내 휴지통이 아니다)');
    ok(ids(env, 'a2', 'Trash').length === 1 && r.moved === 1, '다른 계정은 옮긴다', pick(r));
    ok(r.errors.length === 2 && r.errors.every((e) => /휴지통/.test(e)) && r.failedAccounts === 2, '오류에 «휴지통»', r.errors);
    ok(!opened(env, 'a1').length && !opened(env, 'a3').length, '휴지통이 없으면 폴더를 열지도 않는다');
  }

  console.log('\n[7] MOVE');
  {
    const env = setup([{ acc: acct('a1'), caps: ['IMAP4rev1', 'UIDPLUS'], boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 0 && /MOVE/.test(r.errors[0] || '') && env.server.forbidden().length === 0 && opened(env).length === 0, '처음부터 MOVE 가 없으면 정리하지 않는다 (금지 명령 0)', pick(r));
  }
  {
    const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), TRASH()] };
    spec.hooks = { afterSearch: ({ client }) => { client.capabilities.delete('MOVE'); } };
    const env = setup([spec]);
    const r = await run(env);
    ok(r.moved === 0 && moves(env).length === 0 && /MOVE/.test(r.errors.join(' ')) && env.server.forbidden().length === 0, '도중에 MOVE 가 사라지면 옮기기 직전에 멈춘다 (messageMove 0회)', pick(r));
    ok(movedKeys(env.dir).length === 0, '…옮기기 전에 적어 둔 열쇠는 지운다 (남기면 그 메일은 영영 정리되지 않는다)', movedKeys(env.dir));
  }
  {
    // imapflow 의 대체 경로(COPY + 지우기)를 일부러 태운다
    const mkEnv = () => setup([{ acc: acct('a1'), caps: ['IMAP4rev1', 'UIDPLUS'], boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const g = mkEnv();
    const c = mailtidy.guard(g.server.connect(acct('a1')));
    await c.connect();
    await c.mailboxOpen('INBOX', { readOnly: false });
    const err = await c.messageMove([1000], 'Trash', { uid: true }).then(() => null, (e) => e.message);
    ok(/서버 정리는 messageCopy을 쓰지 않습니다/.test(err || '') && g.server.forbidden().length === 0
      && ids(g, 'a1', 'INBOX').length === 1 && ids(g, 'a1', 'Trash').length === 0,
    'guard 가 있는 연결 — 대체 경로가 첫 COPY 에서 막혀 서버는 그대로, 금지 명령은 실행되지 않았다', err);
    const u = mkEnv();
    const c2 = u.server.connect(acct('a1'));
    await c2.connect();
    await c2.mailboxOpen('INBOX', { readOnly: false });
    await c2.messageMove([1000], 'Trash', { uid: true }).catch(() => {});
    ok(u.server.forbidden().length === 1, '(대조) guard 가 없으면 대체 경로가 금지 명령을 실제로 부른다', u.server.forbidden());
  }

  console.log('\n[8] 계정 하나가 넘어져도 나머지는 한다');
  {
    const env = setup([
      { acc: acct('a1', { name: '회사메일', user: 'kim@corp.example' }), failConnect: true, boxes: [box('INBOX', [mk(1000)]), TRASH()] },
      { acc: acct('a2'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }
    ]);
    const r = await run(env);
    ok(r.failedAccounts === 1 && /회사메일/.test(r.errors[0] || '') && !/kim@corp/.test(r.errors.join(' ')), '로그인 실패 — 오류에 계정 이름은 있고 주소는 없다', r.errors);
    ok(r.moved === 1 && ids(env, 'a2', 'Trash').length === 1, '다음 계정은 진행', pick(r));
  }
  {
    const env = setup([{ acc: acct('a1', { name: 'kim@corp.example' }), failConnect: true, boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const r = await run(env);
    ok(r.errors.length === 1 && !r.errors[0].includes('@') && /계정 1/.test(r.errors[0]), '이름이 주소인 계정 — 오류 글에 @ 가 없고 «계정 n»', r.errors);
  }
  {
    let live = true;
    const s1 = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), box('업무', [mk(1003)]), TRASH()] };
    s1.hooks = { afterFetch: () => { live = false; } };
    const env = setup([s1, { acc: acct('a2'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const r = await run(env, { accountLive: (a) => a.id !== 'a1' || live });
    ok(ids(env, 'a1', 'Trash').length === 0 && !opened(env, 'a1').some((e) => e.path === '업무'), '도중에 계정을 끄면 그 계정은 그 자리에서 멈춘다', pick(r));
    ok(ids(env, 'a2', 'Trash').length === 1 && r.errors.length === 0, '…다른 계정은 그대로 한다', pick(r));
  }
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const r = await run(env, { accountLive: () => false });
    ok(r.accounts === 0 && r.moved === 0 && r.errors.length === 0 && env.server.clients.length === 0, '처음부터 꺼진 계정은 붙지도 않는다 (오류 아님)', pick(r));
  }

  console.log('\n[9] 한 번에 옮기는 양');
  {
    const msgs = [0, 1, 2, 3, 4, 5, 6].map((i) => mk(1000 + i * 3));
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', msgs), TRASH()] }]);
    const r1 = await run(env, { cap: 5 });
    ok(r1.moved === 5 && r1.more === true && !r1.complete, '상한 5 — 확인된 7통 중 5통 옮기고 «남음»', pick(r1));
    ok(JSON.stringify(ids(env, 'a1', 'INBOX')) === JSON.stringify(['<m1015@corp.example>', '<m1018@corp.example>']), '…오래된 것부터 옮긴다', ids(env, 'a1', 'INBOX'));
    const r2 = await run(env, { cap: 5 });
    ok(r2.moved === 2 && r2.more === false && r2.complete, '다음 실행에서 나머지 2통, 남음 없음', pick(r2));
  }
  {
    const four = () => [0, 1, 2, 3].map((i) => mk(1000 + i * 3));
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', four()), TRASH()] }, { acc: acct('a2'), boxes: [box('INBOX', four()), TRASH()] }]);
    const r = await run(env, { cap: 5 });
    ok(r.moved === 5 && r.more === true, '계정 둘을 합쳐도 상한을 지킨다', pick(r));
  }
  {
    const many = Array.from({ length: 1000 }, (_, i) => mk(1000 + i * 3, { id: `bulk${i}@corp.example` }));
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', many), TRASH()] }]);
    const r = await run(env, { cap: 5 });
    const fetches = env.server.log.filter((e) => e.cmd === 'fetch');
    ok(r.moved === 5 && r.more === true && fetches.length === 1, '후보 1000통 + 상한 5 → 받아 오기는 한 번뿐', { ...pick(r), fetches: fetches.length });
  }

  console.log('\n[10] 세기만 하기 (dry-run)');
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000), mk(1003), mk(1007, { noFile: true })]), box('업무', [mk(1010)]), TRASH()] }]);
    const r = await run(env, { dryRun: true });
    ok(r.verified === 3 && r.moved === 0 && r.unsaved === 1 && r.complete, '확인된 통수를 센다', pick(r));
    ok(moves(env).length === 0 && opened(env).every((e) => e.readOnly), '옮기지 않고, 모든 폴더를 읽기 전용으로만 연다', opened(env));
    ok(!fs.existsSync(path.join(env.dir, mailtidy.MOVED_FILE)), 'tidy-moved.json 을 쓰지 않는다');
    ok(ids(env, 'a1', 'INBOX').length === 3, '서버는 그대로');
  }
  {
    let stop = false;
    const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000), mk(1003)]), box('업무', [mk(1007), mk(1010)]), TRASH()] };
    spec.hooks = { afterFetch: () => { stop = true; } };
    const env = setup([spec]);
    const into = {};
    const p = run(env, { dryRun: true, into, shouldStop: () => stop });
    ok(into.verified === 0 && Array.isArray(into.errors), 'into 는 부르자마자 채워진다 (동기)', into.verified);
    const r = await p;
    ok(r === into && into.verified === 2 && into.more === true && !into.complete, '도중에 멈추면 into 에 센 데까지 남는다', pick(into));
  }

  console.log('\n[11] 검색이 답하지 않음');
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), box('업무', [mk(1003)], { searchReturns: false }), TRASH()] }]);
    const r = await run(env);
    ok(r.errors.length === 1 && /업무/.test(r.errors[0]) && /검색/.test(r.errors[0]), '그 폴더만 오류', r.errors);
    ok(r.moved === 1 && ids(env, 'a1', 'INBOX').length === 0, '다른 폴더는 진행', pick(r));
  }

  console.log('\n[12] 옮기기가 거부됨');
  {
    const env = setup([{ acc: acct('a1'), moveReturns: false, boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] }]);
    const r = await run(env);
    const keys = movedKeys(env.dir);
    ok(r.moved === 0 && r.uncertain === 0 && /거부/.test(r.errors[0] || ''), '서버가 거부하면 오류, 거부된 묶음은 셈에 넣지 않는다', pick(r));
    ok(keys.length === 0 && ids(env, 'a1', 'INBOX').length === 2, '…옮기기 전에 적어 둔 열쇠는, 다시 물어 남아 있는 것이 확인되면 지운다 (다음에 옮길 수 있게)', keys);
  }
  {
    // 옮긴 목록(COPYUID)은 믿지 않는다 — 비어 와도 폴더에 남은 것을 다시 물어 실제로 옮긴 만큼 센다
    const env = setup([{ acc: acct('a1'), emptyUidMap: true, boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 1 && r.errors.length === 0 && ids(env, 'a1', 'Trash').length === 1,
      '서버가 옮긴 목록을 비워 줘도(uidMap 0) 실제로 옮긴 1통으로 센다', pick(r));
    ok(movedKeys(env.dir).includes(mailtidy.movedKey('a1', 'INBOX', 'm1000@corp.example')),
      '…실제로 옮긴 메일의 열쇠는 지우지 않는다 (되찾았을 때 다시 옮기지 않게)', movedKeys(env.dir));
  }
  for (const quirk of ['emptyUidMap', 'partialUidMap']) {
    // imapflow 는 COPYUID 줄이 여러 번 오면 마지막 줄로 덮어쓴다 — 목록만 믿으면 적게 세어 상한을 넘긴다
    const three = (p) => box(p, [mk(1000), mk(1003), mk(1006)]);
    const env = setup([{ acc: acct('a1'), [quirk]: true, boxes: [three('INBOX'), three('업무'), three('공지'), three('보관'), TRASH()] }]);
    const r = await run(env, { cap: 3 });
    const inTrash = ids(env, 'a1', 'Trash').length;
    ok(inTrash === 3 && r.moved === 3 && r.more === true,
      `${quirk} — 상한 3 을 넘겨 옮기지 않고, 옮긴 수를 실제대로 센다`, { ...pick(r), inTrash });
    ok(movedKeys(env.dir).length === 3, `${quirk} — 옮긴 3통의 열쇠가 모두 남는다`, movedKeys(env.dir).length);
  }
  {
    // 옮긴 뒤 다시 묻기가 실패하면 — 다 옮긴 것으로 센다 (상한은 줄이는 쪽, 열쇠는 남기는 쪽)
    const env = setup([{ acc: acct('a1'), emptyUidMap: true, boxes: [box('INBOX', [mk(1000), mk(1003)]), box('업무', [mk(1000), mk(1003)]), TRASH()] }]);
    const c0 = env.server.connect.bind(env.server);
    env.server.connect = (acc) => {
      const c = c0(acc);
      const search = c.search.bind(c);
      c.search = async (q, o) => {
        if (env.server.log.some((e) => e.cmd === 'moved') && q && Array.isArray(q.uid) && q.flagged === undefined) throw new Error('fake: search failed');
        return search(q, o);
      };
      return c;
    };
    const r = await run(env, { cap: 2 });
    ok(r.moved === 2 && ids(env, 'a1', 'Trash').length === 2 && movedKeys(env.dir).length === 2,
      '옮긴 뒤 다시 묻기가 실패해도 보낸 통수로 세고 상한을 지킨다', pick(r));
  }
  {
    const env = setup([{ acc: acct('a1'), noUidPlus: true, boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 2, '옮긴 목록(UIDPLUS)이 없으면 보낸 통수로 센다', pick(r));
  }

  console.log('\n[13] UID 는 폴더마다');
  {
    const env = setup([{
      acc: acct('a1'),
      boxes: [box('INBOX', [mk(1005, { id: 'inbox1005@corp.example' })]), box('업무', [mk(1005, { id: 'work1005@corp.example' })]), TRASH()]
    }]);
    const r = await run(env);
    const mv = env.server.log.filter((e) => e.cmd === 'moved').map((e) => [e.from, e.uids]);
    ok(r.moved === 2 && JSON.stringify(mv) === JSON.stringify([['INBOX', [1005]], ['업무', [1005]]]), '두 폴더의 1005 를 각자 그 폴더에서 옮긴다', mv);
    ok(JSON.stringify(ids(env, 'a1', 'Trash')) === JSON.stringify(['<inbox1005@corp.example>', '<work1005@corp.example>']), '휴지통에 두 메일이 하나씩', ids(env, 'a1', 'Trash'));
    // 옮기기마다 — 바로 앞의 열기가 그 폴더의 쓰기 열기이고, 바로 앞의 검색(옮기기 직전 재확인)이 그 폴더의 그 UID 였다
    const log = env.server.log;
    const mvAt = log.map((e, k) => (e.cmd === 'messageMove' ? k : -1)).filter((k) => k >= 0);
    const seq = mvAt.map((k) => {
      const e = log[k];
      const before = log.slice(0, k).reverse();
      const op = before.find((x) => x.cmd === 'mailboxOpen');
      const se = before.find((x) => x.cmd === 'search');
      return op && op.path === e.path && op.readOnly === false && se && se.path === e.path
        && JSON.stringify(se.q.uid) === JSON.stringify(e.range) && e.destination === 'Trash';
    });
    ok(mvAt.length === 2 && seq.every(Boolean), '옮기기마다 바로 앞에 그 폴더를 쓰기로 열고 그 UID 를 다시 확인했다', seq);
    const os2 = env.server.log.opts.map((x) => x.opts);
    ok(os2.length >= 5 && new Set(os2).size === os2.length && os2.every((o) => o && o.uid === true), 'search·fetch·messageMove 가 받은 옵션 객체가 모두 서로 다르고 모두 uid:true', os2.length);
  }
  {
    // 업무의 1005 파일에는 받은편지함의 메일이 들어 있다 — 같은 UID 라도 다른 메일이면 옮기지 않는다
    const inbox = mk(1005, { id: 'inbox1005@corp.example' });
    const env = setup([{
      acc: acct('a1'),
      boxes: [box('INBOX', [inbox]), box('업무', [{ ...mk(1005, { id: 'work1005@corp.example' }), file: Buffer.from(inbox.raw, 'latin1') }]), TRASH()]
    }]);
    const r = await run(env);
    ok(r.moved === 1 && r.unverified === 1 && ids(env, 'a1', '업무').length === 1, '다른 폴더의 같은 UID 파일을 근거로 옮기지 않는다', pick(r));
  }
  {
    // 검색 뒤에 다른 폴더가 열렸다 — 그 상태로는 한 통도 건드리지 않는다 (sameBox)
    let once = false;
    const spec = { acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), box('업무', [mk(1003)]), TRASH()] };
    spec.hooks = { afterSearch: async ({ client }) => { if (once) return; once = true; await client.mailboxOpen('업무', { readOnly: true }); } };
    const env = setup([spec]);
    const r = await run(env);
    const hijack = env.server.log.findIndex((e) => e.cmd === 'mailboxOpen' && e.path === '업무');
    const next = env.server.log.findIndex((e, k) => k > hijack && e.cmd === 'mailboxOpen');
    ok(!env.server.log.slice(hijack + 1, next).some((e) => e.cmd === 'fetch' || e.cmd === 'messageMove')
      && ids(env, 'a1', 'INBOX').length === 1 && r.errors.some((e) => /INBOX/.test(e) && /열린 폴더가 바뀌어/.test(e)),
    '검색 뒤 열린 폴더가 바뀌면 그 폴더(INBOX)는 받아 오지도 옮기지도 않고 오류를 남긴다', pick(r));
    ok(ids(env, 'a1', '업무').length === 0 && r.moved === 1, '…다음 폴더는 제 차례에 제대로 연 뒤 옮긴다', pick(r));
  }

  console.log('\n[14] 금지 명령을 소스에 쓰지 않았다');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mailtidy.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
    const bad = /\.(?:messageDelete|messageCopy|messageFlags(?:Add|Set|Remove)|mailboxClose|mailboxDelete|mailboxRename|exec)\s*\(|EXPUNGE|['"`]CLOSE['"`]/;
    const hit = src.match(bad);
    ok(!hit, 'mailtidy.js(주석 제외)에 지우기·복사·플래그·닫기·exec·EXPUNGE·CLOSE 가 없다', hit && hit[0]);
    ok(/messageMove\(/.test(src) && /readOnly: true/.test(src), '(검사가 헛돌지 않는다 — 주석을 지운 소스에 messageMove·readOnly 는 남아 있다)');
  }

  console.log('\n[15] 연결은 늘 닫는다');
  {
    const env = setup([
      { acc: acct('a1'), failConnect: true, boxes: [box('INBOX', [mk(1000)]), TRASH()] },
      { acc: acct('a2'), boxes: [box('INBOX', [mk(1000)], { searchReturns: false }), TRASH()] },
      { acc: acct('a3'), boxes: [box('INBOX', [mk(1000)])] },
      { acc: acct('a4'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }
    ]);
    await run(env);
    ok(env.server.clients.length === 4 && env.server.clients.every((c) => c.loggedOut || c.closed), '오류가 났어도 연결마다 logout 이나 close 를 불렀다', env.server.clients.map((c) => [c.acc, c.loggedOut, c.closed]));
  }
  {
    const env = setup([
      { acc: acct('a1'), delay: { fetch: 5000 }, boxes: [box('INBOX', [mk(1000)]), TRASH()] },
      { acc: acct('a2'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }
    ]);
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 150);
    const r = await run(env, { signal: ctl.signal });
    const ms = Date.now() - t0;
    ok(r.aborted === true && r.more === true && !r.complete && ms < 2000, '끊으라면 걸린 받아 오기도 곧 끝난다', { ms, ...pick(r) });
    ok(env.server.clients[0].closed === true && env.server.clients.length === 1, '…연결을 닫고 다음 계정으로 가지 않는다', env.server.clients.map((c) => [c.acc, c.closed]));
    ok(ids(env, 'a1', 'INBOX').length === 1 && r.errors.length === 0, '…옮긴 것도 오류도 없다', pick(r));
  }

  console.log('\n[16] 휴지통에서 되찾은 메일');
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000, { id: 'keep@corp.example' })]), box('업무', []), TRASH()] }]);
    const r1 = await run(env);
    const rec = JSON.parse(fs.readFileSync(path.join(env.dir, mailtidy.MOVED_FILE), 'utf8'));
    ok(r1.moved === 1 && rec.keys.includes(mailtidy.movedKey('a1', 'INBOX', 'keep@corp.example')), '옮긴 뒤 tidy-moved.json 에 (계정, 폴더, Message-ID) 열쇠가 생긴다', rec.keys);
    // 사용자가 휴지통에서 받은편지함으로 되찾았다 — 새 UID 로 다시 나타난다. 백업도 그 UID 로 저장해 두었다
    const back = mk(2000, { id: 'keep@corp.example' });
    env.server.box('a1', 'INBOX').msgs.push({ ...back, flags: new Set(), labels: new Set() });
    const same = mk(2003, { id: 'keep@corp.example' });
    env.server.box('a1', '업무').msgs.push({ ...same, flags: new Set(), labels: new Set() });
    fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1), '20250101_0900_2000_제목.eml'), Buffer.from(back.raw, 'latin1'));
    fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), '업무', 1), '20250101_0900_2003_제목.eml'), Buffer.from(same.raw, 'latin1'));
    const r2 = await run(env);
    ok(r2.spared === 1 && ids(env, 'a1', 'INBOX').length === 1, '같은 폴더에 같은 Message-ID 가 다시 나타나면 «되찾음»으로 남긴다', pick(r2));
    ok(r2.moved === 1 && ids(env, 'a1', '업무').length === 0, '다른 폴더의 같은 ID 는 옮긴다', pick(r2));
    fs.writeFileSync(path.join(env.dir, mailtidy.MOVED_FILE), '{not json');
    env.server.box('a1', '업무').msgs.push({ ...mk(2009, { id: 'other@corp.example' }), flags: new Set(), labels: new Set() });
    fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), '업무', 1), '20250101_0900_2009_제목.eml'), Buffer.from(mk(2009, { id: 'other@corp.example' }).raw, 'latin1'));
    const before = moves(env).length;
    const err = await run(env).then(() => null, (e) => e.message);
    ok(/tidy-moved\.json/.test(err || '') && moves(env).length === before && ids(env, 'a1', '업무').length === 1, '기록 파일이 깨져 있으면 아무것도 옮기지 않고 오류', err);
  }
  {
    // 기록이 상한을 넘으면 오래된 것부터 버린다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }]);
    const old = Array.from({ length: mailtidy.MOVED_MAX }, (_, i) => `old${i}`);
    fs.writeFileSync(path.join(env.dir, mailtidy.MOVED_FILE), JSON.stringify({ v: 1, keys: old }));
    await run(env);
    const rec = JSON.parse(fs.readFileSync(path.join(env.dir, mailtidy.MOVED_FILE), 'utf8'));
    ok(rec.keys.length === mailtidy.MOVED_MAX && rec.keys[0] === 'old1' && rec.keys.includes(mailtidy.movedKey('a1', 'INBOX', 'm1000@corp.example')), `기록은 ${mailtidy.MOVED_MAX}개까지 — 넘치면 오래된 것부터 버린다`, rec.keys.length);
  }
  {
    // Message-ID 가 없는 메일도 — 크기·Date·From·Subject 로 알아본다
    const first = mk(1000, { id: null, subject: 'noid keep' });
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [first]), TRASH()] }]);
    const r1 = await run(env);
    const keys1 = JSON.parse(fs.readFileSync(path.join(env.dir, mailtidy.MOVED_FILE), 'utf8')).keys;
    ok(r1.moved === 1 && keys1.length === 1, 'Message-ID 없는 메일도 옮기면 열쇠가 남는다', { ...pick(r1), keys: keys1.length });
    // 휴지통에서 되찾았다 — 같은 원문이 새 UID 로. 자동 백업도 그 UID 로 저장했다
    const back = { ...first, uid: 2000 };
    const other = mk(2003, { id: null, subject: 'noid other' });
    for (const m of [back, other]) {
      env.server.box('a1', 'INBOX').msgs.push({ ...m, flags: new Set(), labels: new Set() });
      fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1), `20250101_0900_${m.uid}_제목.eml`), Buffer.from(m.raw, 'latin1'));
    }
    const r2 = await run(env);
    const left = env.server.box('a1', 'INBOX').msgs.map((m) => m.uid);
    ok(r2.spared === 1 && r2.moved === 1 && JSON.stringify(left) === '[2000]', '되찾은 것은 남기고, Message-ID 없는 다른 메일은 옮긴다', { ...pick(r2), left });
  }
  {
    // 백업 폴더를 바꾸면 옮긴 기록도 새 폴더로 — 더하기만 하고, 깨진 기록은 덮어쓰지 않는다
    const a = path.join(TMP, 'carry-a');
    const b = path.join(TMP, 'carry-b');
    const c = path.join(TMP, 'carry-c');
    for (const d of [a, b, c]) fs.mkdirSync(d, { recursive: true });
    const put = (d, v) => fs.writeFileSync(path.join(d, mailtidy.MOVED_FILE), typeof v === 'string' ? v : JSON.stringify({ v: 1, keys: v }));
    const get = (d) => fs.readFileSync(path.join(d, mailtidy.MOVED_FILE), 'utf8');
    put(a, ['k1', 'k2']);
    put(b, ['k2', 'k3']);
    const n1 = await mailtidy.carryMoved(a, b);
    ok(n1 === 1 && JSON.stringify(JSON.parse(get(b)).keys.sort()) === '["k1","k2","k3"]', '새 폴더의 기록에 이전 폴더의 열쇠를 더한다', get(b));
    const n2 = await mailtidy.carryMoved(a, c);
    ok(n2 === 2 && JSON.stringify(JSON.parse(get(c)).keys.sort()) === '["k1","k2"]', '새 폴더에 기록이 없으면 만든다', get(c));
    put(b, '{broken');
    const n3 = await mailtidy.carryMoved(a, b);
    ok(n3 === 0 && get(b) === '{broken', '새 폴더의 기록이 깨져 있으면 덮어쓰지 않는다');
    ok(await mailtidy.carryMoved(a, a.toUpperCase()) === 0 && await mailtidy.carryMoved(path.join(TMP, 'carry-none'), c) === 0, '같은 폴더·기록 없는 폴더는 아무것도 하지 않는다');
  }

  console.log('\n[17] 받은 지 기간 — 서버의 날짜 검색에 기대지 않는다');
  {
    // 서버가 날짜 조건을 엉성하게 본다(서버 시간대·무시) — 받아 온 internalDate 로 다시 본다. 경계는 30일
    const env = setup([{
      acc: acct('a1'), searchIgnoresBefore: true,
      boxes: [box('INBOX', [
        mk(1000, { daysAgo: 29 }), mk(1003, { daysAgo: 29.9 }), mk(1007, { daysAgo: 30 - 1 / 24 }),
        mk(1010, { daysAgo: 30 + 1 / 24 }), mk(1013, { daysAgo: 31 })
      ]), TRASH()]
    }]);
    const r = await run(env);
    ok(r.moved === 2 && r.verified === 2 && r.kept === 0 && r.unverified === 0 && r.spared === 0,
      '서버가 젊은 메일까지 돌려줘도 30일 지난 2통만 옮긴다 (젊은 것은 세지도 않는다)', pick(r));
    ok(JSON.stringify(ids(env, 'a1', 'INBOX')) === JSON.stringify(['<m1000@corp.example>', '<m1003@corp.example>', '<m1007@corp.example>']),
      '…30일에서 1시간 모자란 것까지는 남는다', ids(env, 'a1', 'INBOX'));
  }
  {
    // 보통 서버 — 날짜 검색은 하루 넘게 넉넉히 오래된 쪽으로만 고른다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000, { daysAgo: 30 - 1 / 24 }), mk(1003, { daysAgo: 32 })]), TRASH()] }]);
    const r = await run(env);
    ok(r.moved === 1 && JSON.stringify(ids(env, 'a1', 'INBOX')) === '["<m1000@corp.example>"]', '30일 직전은 남고 32일 된 것은 옮긴다', pick(r));
  }

  console.log('\n[18] 옮기는 중에 끊기면');
  {
    // 서버는 이미 옮겼는데 답이 늦다 — 그 사이 끊는다 («백업 시작»의 비켜 주기·시간 상한·앱 끄기)
    const env = setup([{ acc: acct('a1'), delay: { move: 5000 }, boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] }]);
    const ctl = new AbortController();
    const watch = setInterval(() => { if (env.server.log.some((e) => e.cmd === 'moved')) { clearInterval(watch); ctl.abort(); } }, 5);
    const t0 = Date.now();
    const r = await run(env, { signal: ctl.signal });
    clearInterval(watch);
    ok(r.aborted && r.moved === 0 && r.uncertain === 2 && /옮겨졌을 수 있습니다/.test(r.errors[0] || '') && /2통/.test(r.errors[0] || '') && Date.now() - t0 < 2000,
      '답을 못 받은 묶음은 숫자에 넣지 않되 «옮겨졌을 수 있음»으로 오류 맨 앞에 남는다', pick(r));
    const keys = movedKeys(env.dir);
    ok(ids(env, 'a1', 'Trash').length === 2 && ['m1000@corp.example', 'm1003@corp.example'].every((id) => keys.includes(mailtidy.movedKey('a1', 'INBOX', id))),
      '…옮기기 전에 적어 둔 열쇠가 남아 있다', keys.length);
    // 사용자가 휴지통에서 되찾았다 — 다음 정리는 다시 옮기지 않는다
    env.server.spec.a1.delay = undefined;
    const back = { ...mk(1000), uid: 2000 };
    env.server.box('a1', 'INBOX').msgs.push({ ...back, flags: new Set(), labels: new Set() });
    fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1), '20250101_0900_2000_제목.eml'), Buffer.from(back.raw, 'latin1'));
    const r2 = await run(env);
    ok(r2.moved === 0 && r2.spared === 1 && ids(env, 'a1', 'INBOX').length === 1, '…끊긴 묶음에서 되찾은 메일도 다시 옮기지 않는다', pick(r2));
  }

  {
    // 옮겼는지 모르는 묶음도 상한에서 깎는다 — 실제로 옮겨졌을 수 있다
    const env = setup([
      { acc: acct('a1'), delay: { move: 3000 }, boxes: [box('INBOX', [mk(1000), mk(1003)]), TRASH()] },
      { acc: acct('a2'), boxes: [box('INBOX', [mk(1000), mk(1003), mk(1006)]), TRASH()] }
    ]);
    const r = await run(env, { cap: 3, budgetMs: 800, accountMinMs: 0 });
    ok(r.uncertain === 2 && ids(env, 'a1', 'Trash').length === 2, '첫 계정 — 끊긴 묶음 2통은 «옮겨졌을 수 있음»', pick(r));
    ok(r.moved === 1 && ids(env, 'a2', 'Trash').length === 1 && r.more === true,
      '…둘째 계정은 상한 3 에서 그 2통을 뺀 1통만 옮긴다', { ...pick(r), uncertain: r.uncertain });
  }

  console.log('\n[19] 느린 계정이 시간을 다 써도 다음 계정은 한다');
  {
    const slow = Array.from({ length: 8 }, (_, k) => box(k ? `폴더${k}` : 'INBOX', [mk(1000 + k * 3)]));
    const env = setup([
      { acc: acct('a1'), delay: { search: 300 }, boxes: [...slow, TRASH()] },
      { acc: acct('a2'), boxes: [box('INBOX', [mk(1000)]), TRASH()] }
    ]);
    const t0 = Date.now();
    const r = await run(env, { budgetMs: 1000, accountMinMs: 0 });
    const ms = Date.now() - t0;
    ok(ids(env, 'a2', 'Trash').length === 1, '두 번째 계정도 차례가 와서 옮긴다', pick(r));
    ok(r.more === true && !r.aborted && r.failedAccounts === 0 && r.errors.some((e) => /회사a1/.test(e) && /시간 안에/.test(e)),
      '…첫 계정은 실패가 아니라 «시간 안에 다 보지 못함», 남은 것은 다음에', pick(r));
    ok(env.server.clients[0].closed === true && ms < 3000, '…첫 계정의 연결은 끊고, 전체도 곧 끝난다', ms);
    const r2 = await run(env, { accounts: [acct('a2')], budgetMs: 1000, accountMinMs: 0 });
    ok(r2.complete && r2.errors.length === 0, '(대조) 시간 안에 끝난 계정은 아무 오류도 없다', pick(r2));
  }

  console.log('\n[20] «바로»(0일) — 읽은 것만, 날짜는 보지 않는다');
  // 읽음(\Seen) 표시가 있는 메일 — mk 의 기본은 안 읽음이다
  const rd = (uid, o = {}) => mk(uid, { ...o, flags: ['\\Seen', ...(o.flags || [])] });
  const searchesIn = (env) => env.server.log.filter((e) => e.cmd === 'search');
  {
    const s0 = mk(1000, { daysAgo: 0.001 });
    ok(await mailtidy.verdict(null, [], { seenOnly: true }) === 'gone', 'verdict — 메일이 없으면 gone');
    const at = (o) => ({ uid: 1000, size: 1, internalDate: o.date, flags: new Set(o.flags || []), labels: new Set(), envelope: { messageId: s0.messageId }, headers: Buffer.from(s0.raw, 'latin1') });
    const future = new Date(NOW + 2 * DAY);
    ok(await mailtidy.verdict(at({ date: future, flags: [] }), [], { seenOnly: true }) === 'unread', 'verdict(seenOnly) — 안 읽음이면 unread (파일을 보기 전에)');
    ok(await mailtidy.verdict(at({ date: future, flags: ['\\Seen'] }), [], { seenOnly: true }) === 'nofile', 'verdict(seenOnly) — 날짜를 보지 않는다 (미래 날짜여도 young 이 아니다)');
    ok(await mailtidy.verdict(at({ date: 'bad', flags: ['\\Seen'] }), [], { seenOnly: true }) === 'nofile', 'verdict(seenOnly) — 날짜를 못 읽었어도 던지지 않는다');
    ok(await mailtidy.verdict(at({ date: future, flags: ['\\Seen'] }), [], { cutoff: NOW }) === 'young', '(대조) 기간 정리에서는 미래 날짜가 young');
    ok(await mailtidy.verdict(at({ date: new Date(NOW - 60 * DAY), flags: [] }), [], { cutoff: NOW - 30 * DAY }) === 'nofile', '(대조) 기간 정리에서는 안 읽음을 따지지 않는다');
    ok(await mailtidy.verdict(at({ date: future, flags: ['\\Flagged'] }), [], { seenOnly: true }) === 'flagged', 'verdict(seenOnly) — 안 읽은 별표는 unread 가 아니라 flagged (읽어도 옮기지 않는다)');
    const imp = { ...at({ date: future, flags: [] }), labels: new Set(['\\Important']) };
    ok(await mailtidy.verdict(imp, [], { seenOnly: true }) === 'unread' && await mailtidy.verdict({ ...imp, flags: new Set(['\\Seen']) }, [], { seenOnly: true }) === 'important',
      'verdict(seenOnly) — 안 읽은 중요 표시는 unread (따로 세는 안 읽음 검색과 같은 기준), 읽으면 important');
  }
  /** 바로 정리에서 가를 것들이 모인 받은편지함 */
  const mixed = () => {
    const other = mk(1022, { id: 'someone-else@corp.example' });
    return [
      rd(1000, { daysAgo: 0.001 }), rd(1003, { daysAgo: 60 }),         // 읽음·저장됨 → 옮김 (막 온 것도)
      mk(1007, { daysAgo: 0.001 }), mk(1010, { daysAgo: 60 }),         // 안 읽음·저장됨 → 읽을 때까지 남김
      rd(1013, { flags: ['\\Flagged'] }), rd(1016, { flags: ['\\Deleted'] }),
      rd(1019, { noFile: true }),                                         // 읽음·저장 안 됨 → 남김(저장 안 됨)
      { ...rd(1022), file: Buffer.from(other.raw, 'latin1') },          // 읽음·다른 메일 파일 → 남김(확인 안 됨)
      mk(1025, { noFile: true })                                          // 안 읽음·저장 안 됨 → 세지 않는다
    ];
  };
  const LEFT0 = [1007, 1010, 1013, 1016, 1019, 1022, 1025];
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', mixed()), TRASH()] }]);
    const r = await run(env, { days: 0 });
    const left = env.server.box('a1', 'INBOX').msgs.map((m) => m.uid);
    ok(r.moved === 2 && r.unread === 2 && r.unsaved === 1 && r.unverified === 1 && r.kept === 2 && r.spared === 0 && r.errors.length === 0 && r.complete,
      '읽고 저장이 확인된 2통만 옮긴다 — 받은 지 1분 된 것도. 안 읽은 2통은 unread 로만 센다 (남김 경고가 아니다)', pick(r));
    ok(JSON.stringify(left) === JSON.stringify(LEFT0), '…안 읽음·별표·지움 표시·저장 안 됨·다른 메일 파일은 서버에 남는다', left);
    const se = searchesIn(env);
    const first = se[0] && se[0].q;
    ok(first && first.seen === true && first.flagged === false && first.deleted === false && !('before' in first),
      '고르는 검색 — 날짜 조건 없이 seen:true · flagged:false · deleted:false', first);
    ok(se.some((e) => e.q && e.q.seen === false && !('uid' in e.q)), '…안 읽은 것을 세는 검색이 따로 있다 (seen:false)', se.map((e) => e.q));
    const recheck = se.filter((e) => e.q && Array.isArray(e.q.uid) && e.q.flagged === false);
    ok(recheck.length === 1 && recheck[0].q.seen === true, '옮기기 직전 다시 묻는 검색에도 seen:true 가 있다', recheck.map((e) => e.q));
    ok(env.server.forbidden().length === 0 && moves(env).every((e) => e.destination === 'Trash'), '…휴지통으로 옮기기만 한다 (금지 명령 0)');
  }
  {
    // 읽음 조건을 흘려듣는 서버 — 안 읽은 메일도 검색에 섞여 온다. 받아 온 플래그로 다시 봐서 남긴다
    const env = setup([{ acc: acct('a1'), searchIgnoresSeen: true, boxes: [box('INBOX', mixed()), TRASH()] }]);
    const r = await run(env, { days: 0 });
    const left = env.server.box('a1', 'INBOX').msgs.map((m) => m.uid);
    ok(r.moved === 2 && JSON.stringify(left) === JSON.stringify(LEFT0), '서버가 seen 조건을 흘려들어도 안 읽은 것은 옮기지 않는다', { ...pick(r), left });
    ok(r.unread === 2 && r.unverified === 1, '…안 읽은 것은 unread 로 센다 — «확인 안 됨»으로 세지 않고, 두 번 세지도 않는다', pick(r));
    ok(r.kept === 2 && r.unsaved === 1 && r.spared === 0,
      '…안 읽고 저장 안 된 1025 는 «저장 안 됨» 경고로 세지 않는다 — 보통 서버와 같은 kept 2 · unsaved 1', pick(r));
    const selected = env.server.log.filter((e) => e.cmd === 'fetch' && e.query && e.query.envelope).flatMap((e) => e.range);
    ok(!selected.some((u) => [1007, 1010, 1025].includes(u)), '…안 읽은 메일은 봉투·헤더를 받지 않는다 (가벼운 플래그로 먼저 가른다)', selected);
  }
  for (const loose of [false, true]) {
    // 고른 뒤 옮기기 전에 «안 읽음»으로 되돌렸다 — 옮기기 직전 다시 묻기에서 빠진다.
    // 읽음 조건을 흘려듣는 서버(loose)는 그 검색이 소용없다 — 플래그를 다시 받아 본다
    let once = false;
    const spec = { acc: acct('a1'), searchIgnoresSeen: loose, boxes: [box('INBOX', [rd(1000), rd(1003)]), TRASH()] };
    spec.hooks = {
      afterFetch: ({ box: b, query }) => {
        if (once || !query.envelope) return;   // 고르는 받아 오기(봉투)가 끝난 바로 뒤
        once = true;
        b.msgs.find((m) => m.uid === 1003).flags.delete('\\Seen');
      }
    };
    const env = setup([spec]);
    const r = await run(env, { days: 0 });
    const trash = env.server.box('a1', 'Trash').msgs;
    ok(once && r.moved === 1 && r.spared === 1 && ids(env, 'a1', 'INBOX').includes('<m1003@corp.example>') && trash.every((m) => m.flags.has('\\Seen')),
      `${loose ? '읽음 조건을 흘려듣는 서버' : '보통 서버'} — 고른 뒤 안 읽음으로 되돌린 메일은 옮기지 않는다 (spared, 휴지통에 안 읽은 메일 없음)`, pick(r));
    const lg = env.server.log;
    const mv = lg.findIndex((e) => e.cmd === 'messageMove');
    const pre = lg.slice(0, mv).reverse().find((e) => e.cmd === 'fetch');
    // 보통 서버는 다시 묻는 검색(seen:true)에서 이미 1003 이 빠진다 — 플래그는 남은 것만 받는다
    ok(mv > 0 && pre && pre.query.flags && !pre.query.envelope && JSON.stringify(pre.range) === (loose ? '[1000,1003]' : '[1000]'),
      '…옮기기 바로 앞에 그 묶음의 플래그를 다시 받는다', pre && { range: pre.range, query: pre.query });
  }
  {
    // 옮기기 직전 플래그를 못 받으면 그 묶음은 옮기지 않는다 (열쇠도 적지 않는다)
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000), rd(1003)]), TRASH()] }]);
    const c0 = env.server.connect.bind(env.server);
    env.server.connect = (acc) => {
      const c = c0(acc);
      const fetch = c.fetch.bind(c);
      c.fetch = (range, query, o) => {
        if (query && query.flags && !query.envelope) throw new Error('fake: FETCH FLAGS rejected');
        return fetch(range, query, o);
      };
      return c;
    };
    const r = await run(env, { days: 0 });
    ok(r.moved === 0 && moves(env).length === 0 && ids(env, 'a1', 'INBOX').length === 2 && r.errors.length === 1 && movedKeys(env.dir).length === 0,
      '옮기기 직전 플래그를 못 받으면 옮기지 않는다 — 오류만 남기고 열쇠도 적지 않는다', pick(r));
  }
  {
    // 판정이면 남길 안 읽은 메일(Gmail 중요·메모·되찾음) — 읽을 때까지 남김으로 센다. 서버가 읽음 조건을 지키든 흘려듣든 같은 수다
    const note = ['X-Uniform-Type-Identifier: com.apple.mail-note'];
    for (const loose of [false, true]) {
      const env = setup([{
        acc: acct('a1'), caps: ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'X-GM-EXT-1'], searchIgnoresSeen: loose,
        boxes: [box('INBOX', [mk(1000), mk(1003, { labels: ['\\Important'] }), mk(1006, { extra: note })]), TRASH()]
      }]);
      const d = await run(env, { days: 0, dryRun: true });
      ok(d.unread === 3 && d.spared === 0 && d.verified === 0 && d.kept === 0,
        `${loose ? '흘려듣는 서버' : '보통 서버'} — 안 읽은 3통(보통·중요·메모)은 모두 unread, 남김(spared)·경고로 세지 않는다`, pick(d));
      for (const m of env.server.box('a1', 'INBOX').msgs) m.flags.add('\\Seen');
      const r = await run(env, { days: 0 });
      ok(r.moved === 1 && r.spared === 2 && r.unread === 0 && JSON.stringify(env.server.box('a1', 'INBOX').msgs.map((m) => m.uid)) === '[1003,1006]',
        '…읽고 나면 보통 메일만 옮기고 중요·메모는 남긴다 (그래서 «읽으면 옮김»이라고 약속하지 않는다)', pick(r));
    }
  }
  {
    // «바로»도 휴지통에서 되찾은 메일은 다시 옮기지 않는다 — 몇 분마다 돌므로 이것이 깨지면 되찾자마자 또 사라진다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000)]), TRASH()] }]);
    const r1 = await run(env, { days: 0 });
    ok(r1.moved === 1 && movedKeys(env.dir).includes(mailtidy.movedKey('a1', 'INBOX', 'm1000@corp.example')), '(«바로»로 1000 을 옮겼다)', pick(r1));
    const back = { ...rd(1000), uid: 2000 };
    env.server.box('a1', 'INBOX').msgs.push({ ...back, flags: new Set(['\\Seen']), labels: new Set() });
    fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1), '20250101_0900_2000_제목.eml'), Buffer.from(back.raw, 'latin1'));
    const r2 = await run(env, { days: 0 });
    ok(r2.moved === 0 && r2.spared === 1 && JSON.stringify(env.server.box('a1', 'INBOX').msgs.map((m) => m.uid)) === '[2000]',
      '되찾은 읽은 메일(새 UID 2000, 다시 저장됨)은 «바로»에서도 다시 옮기지 않는다', pick(r2));
  }
  {
    // days 가 없거나 이상한 값이면 30일 규칙이다 — «바로»(읽음만·날짜 없음)로 새지 않는다
    for (const d of [undefined, '0', null, NaN, 15]) {
      const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000, { daysAgo: 1 }), mk(1003, { daysAgo: 60 })]), TRASH()] }]);
      const r = await run(env, { days: d });
      const first = searchesIn(env)[0] && searchesIn(env)[0].q;
      ok(first && first.before instanceof Date && !('seen' in first) && r.moved === 1 && r.unread === 0
        && JSON.stringify(env.server.box('a1', 'INBOX').msgs.map((m) => m.uid)) === '[1000]',
      `days ${String(d)} → 30일 규칙 (하루 된 읽은 메일은 남고, 60일 된 안 읽은 메일은 옮긴다)`, { first, ...pick(r) });
    }
  }
  {
    // 안 읽은 것을 세는 검색은 세기일 뿐 — 서버가 그 검색만 거절해도 정리는 그대로 한다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', mixed()), TRASH()] }]);
    const c0 = env.server.connect.bind(env.server);
    env.server.connect = (acc) => {
      const c = c0(acc);
      const search = c.search.bind(c);
      c.search = async (q, o) => {
        if (q && q.seen === false) { c._cmd('search', { path: c.mailbox && c.mailbox.path, q, opts: o }); throw new Error('fake: UNSEEN rejected'); }
        return search(q, o);
      };
      return c;
    };
    const r = await run(env, { days: 0 });
    const left = env.server.box('a1', 'INBOX').msgs.map((m) => m.uid);
    ok(r.moved === 2 && r.errors.length === 0 && r.unread === 0 && JSON.stringify(left) === JSON.stringify(LEFT0),
      '안 읽음 세기 검색만 거절돼도 오류 없이 읽은 2통을 옮긴다 (unread 는 0으로)', { ...pick(r), left });
  }
  {
    // 늘 남기는 메일(Gmail 중요·메모·다른 메일 파일)은 기억해 두고 «바로»가 몇 분마다 봉투·헤더를 다시 받지 않는다
    const other = mk(1006, { id: 'someone-else@corp.example' });
    const env = setup([{
      acc: acct('a1'), caps: ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'X-GM-EXT-1'],
      boxes: [box('INBOX', [rd(1000, { labels: ['\\Important'] }), rd(1003, { extra: ['X-Uniform-Type-Identifier: com.apple.mail-note'] }),
        { ...rd(1006), file: Buffer.from(other.raw, 'latin1') }, rd(1009)]), TRASH()]
    }]);
    const memo = new Map();
    const HOUR = 3600_000;
    const selectedSince = (k) => env.server.log.slice(k).filter((e) => e.cmd === 'fetch' && e.query && e.query.envelope).flatMap((e) => e.range);
    const counts = (r) => ({ moved: r.moved, spared: r.spared, unverified: r.unverified, kept: r.kept });
    const r1 = await run(env, { days: 0, memo, memoMs: HOUR });
    ok(r1.moved === 1 && r1.spared === 2 && r1.unverified === 1 && r1.kept === 1, '(첫 실행 — 1009 옮김, 중요·메모 남김, 다른 메일 파일은 확인 안 됨)', pick(r1));
    const add = rd(1012);
    env.server.box('a1', 'INBOX').msgs.push({ ...add, flags: new Set(['\\Seen']), labels: new Set() });
    fs.writeFileSync(path.join(mailbackup.boxDirFor(env.dir, acct('a1'), 'INBOX', 1), '20250101_0900_1012_제목.eml'), Buffer.from(add.raw, 'latin1'));
    const k2 = env.server.log.length;
    const r2 = await run(env, { days: 0, memo, memoMs: HOUR, now: () => NOW + HOUR - 1 });
    ok(JSON.stringify(selectedSince(k2)) === '[1012]' && r2.moved === 1 && JSON.stringify({ ...counts(r2), moved: 0 }) === JSON.stringify({ ...counts(r1), moved: 0 }),
      '두 번째 «바로»는 남김 판정 받은 1000·1003·1006 을 다시 받지 않고(새 1012 만), 남김·확인 안 됨 수는 그대로 센다', { fetched: selectedSince(k2), ...pick(r2) });
    const k3 = env.server.log.length;
    const r3 = await run(env, { days: 0, memo, memoMs: HOUR, now: () => NOW + HOUR + 1 });
    ok(JSON.stringify(selectedSince(k3)) === '[1000,1003,1006]' && r3.moved === 0 && r3.spared === 2 && r3.unverified === 1,
      '…기억할 시간(memoMs)이 지나면 다시 받아 본다', { fetched: selectedSince(k3), ...pick(r3) });
    const k4 = env.server.log.length;
    const r4 = await run(env, { days: 0, memo, memoMs: HOUR, now: () => NOW + HOUR + 2, dryRun: true });
    ok(JSON.stringify(selectedSince(k4)) === '[1000,1003,1006]' && r4.spared === 2, '…세기만 하기(확인 창)는 기억을 쓰지 않는다', selectedSince(k4));
    const k5 = env.server.log.length;
    await run(env, { days: 30, memo, memoMs: HOUR, now: () => NOW + HOUR + 3 });
    ok(selectedSince(k5).length > 0, '…기간 정리(30일)도 기억을 쓰지 않는다 (3시간마다 돌아 그럴 까닭이 없다)', selectedSince(k5));
  }
  {
    // 서버 시계가 앞서 있다 — 받은 날짜가 미래. 던지지 않고, 읽음·저장 확인만으로 판단한다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000, { daysAgo: -2 }), mk(1003, { daysAgo: -2 })]), TRASH()] }]);
    const r = await run(env, { days: 0 }).then((x) => x, (e) => ({ threw: e.message }));
    ok(!r.threw && r.errors.length === 0 && r.complete && r.moved === 1 && r.unread === 1 && ids(env, 'a1', 'INBOX').includes('<m1003@corp.example>'),
      '받은 날짜가 미래여도 던지지 않는다 — 읽은 것은 옮기고 안 읽은 것은 남긴다', r.threw || pick(r));
  }
  {
    // S1 — 폴더 기록이 어긋나면 «바로»도 검색조차 하지 않는다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000)], { stateV: '1699999999' }), box('업무', [rd(1003)], { gen: 2, fileGen: 1 }), TRASH()] }]);
    const r = await run(env, { days: 0 });
    ok(r.moved === 0 && r.skippedBoxes.includes('INBOX') && r.unsaved === 1 && !searchesIn(env).some((e) => e.path === 'INBOX'),
      'UIDVALIDITY 가 다르면 건너뛰고, 파일이 다른 세대 폴더에만 있으면 저장 안 됨으로 남긴다', pick(r));
  }
  {
    // 세기만 하기(확인 창의 «약 n통») — 같은 규칙으로 센다
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', mixed()), TRASH()] }]);
    const r = await run(env, { days: 0, dryRun: true });
    ok(r.verified === 2 && r.unread === 2 && r.moved === 0 && moves(env).length === 0 && opened(env).every((e) => e.readOnly),
      '세기만 하기도 읽고 확인된 2통만 세고, 안 읽은 2통은 따로 센다 (읽기 전용)', pick(r));
  }
  {
    // 기간 정리(7·30·90)는 그대로 — 읽음 조건을 쓰지 않고, 안 읽은 메일도 옮긴다
    for (const d of [7, 30, 90]) {
      const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [mk(1000, { daysAgo: 120 }), rd(1003, { daysAgo: 120 }), mk(1007, { daysAgo: 1 })]), TRASH()] }]);
      const r = await run(env, { days: d });
      const se = searchesIn(env);
      ok(r.moved === 2 && r.unread === 0 && se.every((e) => !('seen' in (e.q || {}))) && se[0].q.before instanceof Date,
        `${d}일 — 안 읽은 오래된 메일도 옮기고, 검색에 읽음 조건이 없다 (날짜 조건만)`, { ...pick(r), qs: se.map((e) => Object.keys(e.q || {})) });
    }
  }

  console.log('\n[21] 보기 창에 떠 있는 메일은 옮기지 않는다');
  for (const d of [0, 30]) {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000), rd(1003)]), box('업무', [rd(1003)]), TRASH()] }]);
    const seen = [];
    const r = await run(env, { days: d, inView: (acc, p, u) => { seen.push([acc.id, p, u]); return acc.id === 'a1' && p === 'INBOX' && u === 1003; } });
    ok(r.moved === 2 && r.spared === 1 && ids(env, 'a1', 'INBOX').includes('<m1003@corp.example>') && ids(env, 'a1', '업무').length === 0,
      `${d}일 — 받은편지함 1003 은 보는 중이라 남기고, 다른 폴더의 같은 UID 는 옮긴다`, pick(r));
    ok(seen.every(([a, p, u]) => a === 'a1' && typeof p === 'string' && Number.isInteger(u)), '…계정·폴더·UID 로 묻는다', seen.slice(0, 3));
  }
  {
    // 고른 뒤에 열었다 — 옮기기 직전에 다시 본다 (1000 은 고를 때 한 번, 옮기기 직전에 한 번 묻는다)
    let asked = 0;
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000), rd(1003)]), TRASH()] }]);
    const r = await run(env, { days: 0, inView: (_a, _p, u) => u === 1000 && ++asked >= 2 });
    ok(r.moved === 1 && r.spared === 1 && r.verified === 2 && ids(env, 'a1', 'INBOX').includes('<m1000@corp.example>'),
      '고른 뒤 보기 창으로 연 메일도 옮기기 직전에 빠진다', pick(r));
    ok(!movedKeys(env.dir).includes(mailtidy.movedKey('a1', 'INBOX', 'm1000@corp.example')), '…그 메일의 열쇠는 적지 않는다 (다음에 옮길 수 있게)', movedKeys(env.dir));
  }
  {
    const env = setup([{ acc: acct('a1'), boxes: [box('INBOX', [rd(1000)]), TRASH()] }]);
    const r = await run(env, { days: 0, inView: () => { throw new Error('boom'); } });
    ok(r.moved === 0 && r.spared === 1 && r.errors.length === 0, '보는 중인지 묻다 실패하면 옮기지 않는 쪽으로 (오류로 멈추지는 않는다)', pick(r));
  }
  {
    // Gmail — 같은 메일이 받은편지함과 라벨 폴더에 다른 UID 로 있다. 어느 쪽을 옮겨도 모든 라벨에서 빠지므로
    // 받은편지함에서 보는 중이면 라벨 폴더 쪽도 옮기지 않는다 (Message-ID 를 넘겨 묻는다)
    const env = setup([{
      acc: acct('a1'),
      boxes: [box('INBOX', [rd(1000, { id: 'same@corp.example' }), rd(1003)]), box('업무', [rd(1006, { id: 'same@corp.example' })]), TRASH()]
    }]);
    const asked = [];
    const r = await run(env, { days: 0, inView: (acc, p, u, sid) => { asked.push(sid); return sid === 'same@corp.example'; } });
    ok(r.moved === 1 && r.spared === 2 && ids(env, 'a1', '업무').length === 1 && JSON.stringify(ids(env, 'a1', 'INBOX')) === '["<same@corp.example>"]',
      '보는 중인 메일과 Message-ID 가 같으면 다른 폴더의 다른 UID 도 남긴다', pick(r));
    // 고를 때와 옮기기 직전 둘 다 Message-ID 를 넘긴다 (모든 메일에 Message-ID 가 있다)
    ok(asked.length >= 4 && asked.every((s) => typeof s === 'string' && s.length > 0 && s === s.toLowerCase() && !/[<>]/.test(s)),
      '…고를 때도 옮기기 직전에도 Message-ID 를 꺾쇠 없이 소문자로 (normId) 넘긴다', asked);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

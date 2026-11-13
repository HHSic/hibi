'use strict';
// 한 계정 백업 — backupAccount 가 지금 하는 일을 잠근다 (src/mailbackup.js).
//
// 창도 Electron 도 쓰지 않는다 — main.js 를 싣지 않고, 가짜 IMAP(test/fixtures/fake-imap.js)과 임시 폴더로만 돈다.
// mail.connect 를 바꿔 끼우므로 진짜 메일 서버·자격 증명 관리자에는 가지 않는다. 가짜 계정 주소는 *.invalid 다.
// [1]~[6]은 이 함수를 고치기 전에 먼저 통과시킨 줄들이다 — 고친 뒤에도 그대로 지나가야 한다.
// 그래서 상태 기록은 통째로 비교하지 않고 네 칸(uidValidity·gen·lowUid·lastUid)만 본다.
//   [1] 새 것만 받기(onlyNew) + 기록 없는 폴더 — 표시만 남고 파일 0, lowUid = top + 1
//   [2] 새 메일 — 위 구간만 받고, 파일이 생기고, lastUid 가 오른다
//   [3] UIDVALIDITY 변경 — 세대가 오르고 옛 파일은 남는다
//   [4] UIDNEXT 를 안 주는 서버 — 검색으로 맨 위 UID 를 찾는다
//   [5] 원문을 안 주는 메일(noSource) — missing 으로 세고, 구간은 지나간다
//   [6] 전체 받기(onlyNew:false) — 아래 구간을 위에서 아래로 받고, 멈춰도 이어 받는다
// 아래는 고친 뒤의 일이다. 디스크 오류는 fs 를 바꿔 끼워 흉내 낸다 (ENOSPC 는 실제로 만들지 않았다).
//   [7]  앞 폴더 실패에도 뒤 폴더 저장, boxErrors 에 남음. 다 실패하면 첫 오류를 던짐. 연결이 죽으면 멈춤
//   [8]  두 실행이 겹쳐도 lastUid 가 되돌아가지 않고 다른 계정 기록이 남음
//   [9]  색인 줄의 seen·size·file, 메타, exists 칸, 비밀번호 없음
//   [10] 못 읽는 상태 파일은 덮어쓰지 않음, 깨진 상태 파일은 .broken 이 남고 새로 시작
//   [11] 상태 파일을 잃고 UIDVALIDITY 가 달라지면 메타로 세대를 올림
//   [12] 저장 파일 이름 모양과 상태 네 칸이 그대로, 긴 이름 대체 길, rename 잠김은 재수신 없이 기다림
//   [13] 밀린 구간 상한 — 맨 위 200통만 받음, lowUid 오름, fillHead 지움, capped. 띄엄띄엄한 UID 로 실제 200통 이하면 전부 받음. 낡은 fillLeft 를 지움. 답이 없는 계정은 계정 전체로 200통
//   [14] shouldStop 이면 다음 묶음 앞에서 멈춤
//   [15] 독 메일 — 나머지와 그 위 메일 저장, last 오름, 자리표, 다음 실행은 그 UID 만 3번까지, 폴더 오류가 아니라 rejected·fillFail. 쓰기 실패도 같게 (ENOSPC·폴더 탓은 멈춤)
//   [16] badDate·notify — 묶음이 던지지 않고 uid 없는 줄이 색인에 없음
//   [17] noUidValidity — 폴더 오류이고 세대가 안 오름, 다음 정상 답에도 그대로
//   [18] saveState — ENOSPC 에 원본을 비우지 않음, 직접 쓰기가 중간에 실패한 파일은 .bak 에서 되살림, 깨진 본 파일로 사본을 안 덮음, 원자적 쓰기가 되면 사본을 지움, .tmp 와 commit 은 rename 전에 fsync
//   [19] patchState — expectV 가 다르면 버림, raiseLow 없이는 lowUid 가 안 오름, 세대가 바뀌면 fill* 칸이 사라짐
//   [20] 같은 UID 자리에 다른 메일 파일이 있으면 건너뛰지 않고 받음
//   [21] saveOne 의 색인 줄, findSaved
//   [22] 소켓 제한 90초
//   [23] UIDVALIDITY 를 늘 안 주는 서버 — 기록도 같은 나쁜 값이면 새 메일을 계속 저장, 색인·메타 없음, 세대 안 오름. 기록이 좋은 값이면 폴더 오류 그대로
//   [24] UID 간격이 크면 검색 답의 UID 만 받음 — 빈칸을 걷지 않음
//   [25] 같은 UID 파일이 둘이면 나중에 받은 것
//   [26] 폴더 자리 — 끝의 점·예약 이름을 비킴, 이미 있는 폴더는 옮기지 않음
//   [27] 대소문자만 다른 폴더는 세대를 나눔, 상태 파일을 잃어도 메타로 가름
//   [28] 서버 기능 한 줄(capsOf) — 폴링 연결에서 MOVE·UIDPLUS 유무를 읽는다, 연결을 늘리지 않는다
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src', 'mail.js'));
const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
const mailmove = require(path.join(ROOT, 'src', 'mailmove.js'));
const mailindex = require(path.join(ROOT, 'src', 'mailindex.js'));
const { makeServer } = require(path.join(__dirname, 'fixtures', 'fake-imap.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backupacct-'));
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const DAY = 86_400_000;
const V = 1700000000n;   // 서버 UIDVALIDITY (imapflow 는 BigInt 로 준다)
const A = { id: 'a1', name: '회사', user: 'kim@corp.invalid', host: 'imap.corp.invalid', port: 993 };

/** 메일 한 통 — tag 를 주면 같은 UID 라도 다른 메일이다 (UIDVALIDITY 변경) */
function mk(uid, o = {}) {
  const date = new Date(NOW - (o.daysAgo == null ? 60 : o.daysAgo) * DAY);
  const subject = `report ${o.tag || uid}`;
  const id = `m${o.tag || uid}@corp.invalid`;
  const raw = `Message-ID: <${id}>\r\nDate: ${date.toUTCString()}\r\nFrom: Kim <kim@corp.invalid>\r\n`
    + `Subject: ${subject}\r\nMIME-Version: 1.0\r\n\r\nbody of ${o.tag || uid}\r\n`;
  return { uid, raw, date, subject, messageId: `<${id}>`, flags: o.seen ? ['\\Seen'] : [], noSource: !!o.noSource };
}
const box = (p, msgs, extra = {}) => ({ path: p, uidValidity: V, msgs, ...extra });

let seq = 0;
/** 가짜 서버 + 빈 백업 폴더 */
function setup(boxes, acct = {}) {
  const dir = path.join(TMP, `b${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const server = makeServer({ a1: { boxes, ...acct } });
  mail.connect = (acc) => server.connect(acc);
  return {
    dir,
    server,
    run: (o) => mailbackup.backupAccount(A, dir, o),
    rec: (p = 'INBOX') => (mailbackup.loadState(dir)[mailbackup.accountKey(A)] || {})[p],
    uids: (p = 'INBOX', gen = 1) => [...mailbackup.uidsIn(mailbackup.boxDirFor(dir, A, p, gen))].sort((x, y) => x - y),
    boxDir: (p = 'INBOX', gen = 1) => mailbackup.boxDirFor(dir, A, p, gen),
    // 원문을 달라고 한 FETCH 의 범위들 (머리만 받는 것과 가른다)
    sourceRanges: () => server.log.filter((e) => e.cmd === 'fetch' && e.query && e.query.source).map((e) => String(e.range)),
    opens: () => server.log.filter((e) => e.cmd === 'mailboxOpen'),
    clean: () => server.forbidden().length === 0 && server.log.filter((e) => e.cmd === 'mailboxOpen').every((e) => e.readOnly)
  };
}
/** 네 칸만 — 고친 뒤 칸이 늘어도 이 줄들은 그대로 본다 */
const four = (r) => (r ? { uidValidity: r.uidValidity, gen: r.gen, lowUid: r.lowUid, lastUid: r.lastUid } : r);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lowOf = (range) => Number(String(range).split(':')[0]);
/** 서버에 새 메일을 넣는다 */
const addMail = (env, msgs, p = 'INBOX') => {
  const sb = env.server.box('a1', p);
  for (const m of msgs) sb.msgs.push({ ...m, flags: new Set(m.flags || []), labels: new Set() });
  return sb;
};
/** 연결을 만들 때마다 손을 댄다 — 가짜 서버에 없는 고장을 흉내 낸다 */
const onClient = (fn) => {
  const real = mail.connect;
  mail.connect = (acc, o) => { const c = real(acc, o); fn(c); return c; };
};
const failOpen = (name) => onClient((c) => {
  const open = c.mailboxOpen.bind(c);
  c.mailboxOpen = async (p, o) => {
    if (p === name) throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' });
    return open(p, o);
  };
});
const thrownBy = async (p) => { try { await p; return null; } catch (e) { return e; } };
const oops = (code, m = '쓰기 실패') => Object.assign(new Error(m), { code });

(async () => {
  console.log('\n[1] 새 것만 받기 + 기록 없는 폴더 — 표시만');
  {
    const env = setup([
      box('INBOX', [mk(1000), mk(1003), mk(1007)], { uidNext: 'auto' }),
      box('업무', [mk(1000)], { uidNext: 'auto' }),
      box('Trash', [mk(1000)], { specialUse: '\\Trash', uidNext: 'auto' })
    ]);
    const r = await env.run({ onlyNew: true });
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1008, lastUid: 1007 }), '기록은 lowUid = top + 1, lastUid = top', four(env.rec()));
    ok(r.seeded === 2 && r.saved === 0 && r.skipped === 0 && r.mailboxes === 2 && r.stopped === false, '표시 2개, 저장 0통', r);
    ok(env.uids().length === 0 && env.uids('업무').length === 0, '파일 0개');
    ok(env.sourceRanges().length === 0, '원문을 달라고 하지 않는다', env.sourceRanges());
    ok(!env.opens().some((e) => e.path === 'Trash') && !env.rec('Trash'), '휴지통은 열지도 적지도 않는다');
    ok(env.clean(), '금지 명령 0, 모두 읽기 전용으로 열었다');
    ok(env.server.clients.length === 1 && env.server.clients[0].loggedOut, '연결은 한 번, 끝나면 로그아웃');
  }

  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' }), box('업무', [], { uidNext: 'auto' })]);
    const r = await env.run({ onlyNew: true });
    ok(same(r.boxPaths, ['INBOX', '업무']), '이번에 LIST 로 본 폴더를 돌려준다', r.boxPaths);
  }

  console.log('\n[2] 새 메일 — 위 구간만');
  {
    const env = setup([box('INBOX', [mk(1000), mk(1003), mk(1007)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const sb = env.server.box('a1', 'INBOX');
    const fresh = [mk(1010, { daysAgo: 0 }), mk(1012, { daysAgo: 0 })];
    for (const m of fresh) sb.msgs.push({ ...m, flags: new Set(), labels: new Set() });

    const r = await env.run({ onlyNew: true });
    ok(r.saved === 2 && r.skipped === 0 && r.seeded === 0 && r.missing === 0, '새로 온 두 통만 저장', r);
    ok(same(env.uids(), [1010, 1012]), '파일은 위 구간뿐 — 지난 메일(1000·1003·1007)은 받지 않는다', env.uids());
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1008, lastUid: 1012 }), 'lastUid 만 오른다', four(env.rec()));
    ok(env.sourceRanges().every((x) => lowOf(x) >= 1008), '받아 온 범위가 표시한 자리 위에서 시작한다', env.sourceRanges());
    ok(r.bytes === fresh.reduce((n, m) => n + Buffer.byteLength(m.raw, 'latin1'), 0), '받은 바이트를 센다', r.bytes);

    const names = fs.readdirSync(env.boxDir()).filter((n) => n.endsWith('.eml')).sort();
    ok(names.length === 2 && /^\d{8}_\d{4}_1010_report 1010\.eml$/.test(names[0]) && /^\d{8}_\d{4}_1012_report 1012\.eml$/.test(names[1]),
      '파일 이름은 받은 시각_UID_제목.eml', names);
    ok(fs.readFileSync(path.join(env.boxDir(), names[0])).equals(Buffer.from(fresh[0].raw, 'latin1')), '파일 내용이 원문과 바이트까지 같다');
    ok(!fs.readdirSync(env.boxDir()).some((n) => n.endsWith('.part')), '임시 파일이 남지 않는다');

    const before = env.sourceRanges().length;
    const again = await env.run({ onlyNew: true });
    ok(again.saved === 0 && env.sourceRanges().length === before, '새 메일이 없으면 받지 않는다', again);
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1008, lastUid: 1012 }), '…기록도 그대로', four(env.rec()));
    ok(env.clean(), '금지 명령 0, 모두 읽기 전용으로 열었다');
  }

  console.log('\n[3] UIDVALIDITY 변경 — 세대가 오르고 옛 파일은 남는다');
  {
    const env = setup([box('INBOX', [mk(1000), mk(1003)], { uidNext: 1004 })]);
    await env.run({ onlyNew: false });
    const oldName = fs.readdirSync(env.boxDir()).find((n) => n.includes('_1000_'));
    const oldBody = fs.readFileSync(path.join(env.boxDir(), oldName));
    ok(same(env.uids(), [1000, 1003]) && env.rec().gen === 1, '처음에는 1세대에 받는다', env.uids());

    // 서버가 번호를 새로 매겼다 — 같은 1000번이 이제 다른 메일이다
    const sb = env.server.box('a1', 'INBOX');
    sb.uidValidity = V + 1n;
    sb.uidNext = 1002;
    sb.msgs = [mk(1000, { tag: 'new-a' }), mk(1001, { tag: 'new-b' })].map((m) => ({ ...m, flags: new Set(), labels: new Set() }));

    const r = await env.run({ onlyNew: false });
    ok(same(four(env.rec()), { uidValidity: String(V + 1n), gen: 2, lowUid: 1, lastUid: 1001 }), '세대가 오르고 처음부터 다시 받은 것으로 적는다', four(env.rec()));
    ok(r.saved === 2 && same(env.uids('INBOX', 2), [1000, 1001]), '새 번호의 메일을 새 세대 폴더에 받는다 (이미 있는 것으로 치지 않는다)', env.uids('INBOX', 2));
    ok(env.boxDir('INBOX', 2) !== env.boxDir('INBOX', 1), '세대 폴더가 따로다', path.basename(env.boxDir('INBOX', 2)));
    ok(same(env.uids('INBOX', 1), [1000, 1003]) && fs.readFileSync(path.join(env.boxDir(), oldName)).equals(oldBody), '옛 세대 파일은 그대로 남는다', env.uids('INBOX', 1));
    ok(mailbackup.genOf(mailbackup.loadState(env.dir), A, 'INBOX') === 2, 'genOf 도 2세대를 말한다');
  }
  {
    const env = setup([box('INBOX', [mk(1000), mk(1003)], { uidNext: 1004 })]);
    await env.run({ onlyNew: true });
    const sb = env.server.box('a1', 'INBOX');
    sb.uidValidity = V + 1n;
    sb.uidNext = 1006;
    const r = await env.run({ onlyNew: true });
    ok(same(four(env.rec()), { uidValidity: String(V + 1n), gen: 2, lowUid: 1006, lastUid: 1005 }) && r.seeded === 1 && r.saved === 0,
      '새 것만 받기에서는 세대만 올리고 다시 표시만 한다', four(env.rec()));
  }

  console.log('\n[4] UIDNEXT 를 안 주는 서버 — 검색으로 맨 위 UID 를 찾는다');
  {
    const env = setup([box('INBOX', [mk(1000), mk(1007), mk(1003)])]);
    const r = await env.run({ onlyNew: true });
    const asked = env.server.log.filter((e) => e.cmd === 'search');
    ok(asked.length === 1 && same(asked[0].q, { all: true }), '전체 검색을 한 번 한다', asked.map((e) => e.q));
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1008, lastUid: 1007 }) && r.seeded === 1, '찾은 값이 맨 위 UID 다 (정렬돼 오지 않아도)', four(env.rec()));
  }
  {
    const env = setup([box('INBOX', [mk(5), mk(9)])]);
    const r = await env.run({ onlyNew: false });
    ok(r.saved === 2 && same(env.uids(), [5, 9]) && env.rec().lastUid === 9, '전체 받기도 찾은 값까지 받는다 — «0통 저장, 완료»가 아니다', r);
  }
  {
    const env = setup([box('INBOX', [])]);
    const r = await env.run({ onlyNew: true });
    ok(env.server.log.filter((e) => e.cmd === 'search').length === 0 && same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 0 }) && r.seeded === 1,
      '빈 폴더는 묻지 않고 맨 위를 0으로 본다', four(env.rec()));
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { searchReturns: false })]);
    let thrown = '';
    try { await env.run({ onlyNew: false }); } catch (e) { thrown = e.message; }
    ok(/UID를 알려주지 않습니다/.test(thrown) && !env.rec(), '검색도 답하지 않으면 «다 받았다»고 적지 않고 실패한다', thrown);
  }

  console.log('\n[5] 원문을 안 주는 메일 — missing 으로 센다');
  {
    const env = setup([box('INBOX', [mk(1000), mk(1003, { noSource: true }), mk(1007)], { uidNext: 'auto' })]);
    const r = await env.run({ onlyNew: false });
    ok(r.missing === 1 && r.saved === 2, '받은 것 2통, 빠진 것 1통', r);
    ok(same(env.uids(), [1000, 1007]), '빠진 메일의 파일은 없다', env.uids());
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1007 }), '구간은 그대로 지나간다', four(env.rec()));
  }

  console.log('\n[6] 전체 받기 — 아래 구간을 위에서 아래로');
  {
    const msgs = [];
    for (let u = 1; u <= 130; u++) msgs.push(mk(u));
    const env = setup([box('INBOX', msgs, { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 131, lastUid: 130 }), '먼저 표시만 해 둔 폴더', four(env.rec()));
    const sb = env.server.box('a1', 'INBOX');
    for (const m of [mk(131, { daysAgo: 0 }), mk(132, { daysAgo: 0 })]) sb.msgs.push({ ...m, flags: new Set(), labels: new Set() });

    // 두 묶음을 받은 뒤 멈춘다 — 새 것 한 묶음 + 지난 것 한 묶음
    const r1 = await env.run({ onlyNew: false, shouldStop: () => env.sourceRanges().length >= 2 });
    ok(r1.stopped === true && same(env.sourceRanges(), ['131:132', '81:130']), '새로 온 것을 먼저, 그다음 지난 메일을 위에서부터 받는다', env.sourceRanges());
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 81, lastUid: 132 }), '멈춘 자리가 기록에 남는다', four(env.rec()));

    const r2 = await env.run({ onlyNew: false });
    ok(same(env.sourceRanges(), ['131:132', '81:130', '31:80', '1:30']), '다음 실행은 그 아래부터 내림차순으로 잇는다', env.sourceRanges());
    ok(r2.saved === 80 && r2.skipped === 0 && r1.saved === 52, '이미 받은 것은 다시 받지 않는다', [r1.saved, r2.saved, r2.skipped]);
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 132 }), '끝나면 lowUid 1, lastUid 맨 위', four(env.rec()));
    ok(env.uids().length === 132, '파일 132개', env.uids().length);
    ok(env.clean(), '금지 명령 0, 모두 읽기 전용으로 열었다');
  }

  console.log('\n[7] 폴더별로 잡는다');
  {
    const env = setup([box('망가진', [mk(1000)], { uidNext: 'auto' }), box('INBOX', [mk(1000), mk(1003)], { uidNext: 'auto' })]);
    failOpen('망가진');
    const r = await env.run({ onlyNew: false });
    ok(r.saved === 2 && same(env.uids(), [1000, 1003]), '앞 폴더가 실패해도 뒤 폴더를 받는다', env.uids());
    ok(r.boxErrors.length === 1 && /^망가진: /.test(r.boxErrors[0]), 'boxErrors 에 남는다', r.boxErrors);
    ok(!env.rec('망가진') && env.rec().lastUid === 1003, '실패한 폴더는 기록하지 않는다', env.rec());
  }
  {
    const env = setup([box('A', [mk(5)], { uidNext: 'auto' }), box('B', [mk(5)], { uidNext: 'auto' })]);
    onClient((c) => {
      const open = c.mailboxOpen.bind(c);
      c.mailboxOpen = async (p, o) => {
        if (p === 'A') throw Object.assign(new Error('첫 번째'), { responseStatus: 'NO' });
        if (p === 'B') throw Object.assign(new Error('두 번째'), { responseStatus: 'NO' });
        return open(p, o);
      };
    });
    const e = await thrownBy(env.run({ onlyNew: true }));
    ok(e && e.message === '첫 번째', '받은 폴더가 하나도 없으면 첫 오류를 던진다 — 호출부의 실패 처리가 그대로 돈다', e && e.message);
    ok(env.server.clients[0].loggedOut, '…로그아웃은 한다');
  }
  {
    const env = setup([box('A', [mk(5)], { uidNext: 'auto' }), box('B', [mk(5)], { uidNext: 'auto' }), box('C', [mk(5)], { uidNext: 'auto' })],
      { hooks: { afterFetch: ({ client }) => client.close() } });
    const r = await env.run({ onlyNew: false });
    ok(r.saved === 1 && same(env.uids('A'), [5]), '끊기기 전에 받은 것은 남는다', r.saved);
    ok(r.boxErrors.length === 1 && /^B: /.test(r.boxErrors[0]), '연결이 죽으면 그 폴더에서 멈춘다', r.boxErrors);
    ok(same(env.opens().map((o) => o.path), ['A']), '…다음 폴더를 열지 않는다', env.opens().map((o) => o.path));
  }
  {
    // UID 없는 답을 준 폴더 하나 때문에 다른 폴더가 멈추지 않는다 — 검색 실패도 폴더 오류다
    const env = setup([box('A', [mk(5)], { searchReturns: false }), box('INBOX', [mk(5)], { uidNext: 'auto' })]);
    const r = await env.run({ onlyNew: false });
    ok(r.boxErrors.length === 1 && r.boxErrors[0] === 'A: 서버가 UID를 알려주지 않습니다' && r.saved === 1, '폴더 이름을 두 번 적지 않는다', r.boxErrors);
  }

  console.log('\n[8] 겹친 실행');
  {
    let env = null;
    env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })], {
      hooks: {
        afterFetch: () => {
          // 받는 사이에 다른 실행이 더 위까지 적고, 다른 계정 기록도 들어온다
          mailbackup.patchState(env.dir, 'a1', 'INBOX', { lastUid: 9000 });
          mailbackup.patchState(env.dir, '다른계정', 'INBOX', { uidValidity: '5', gen: 1, lowUid: 1, lastUid: 77 });
        }
      }
    });
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    const r = await env.run({ onlyNew: true });
    const all = mailbackup.loadState(env.dir);
    ok(r.saved === 1 && env.rec().lastUid === 9000, 'lastUid 가 되돌아가지 않는다', env.rec().lastUid);
    ok(all['다른계정'] && all['다른계정'].INBOX.lastUid === 77, '다른 계정 기록이 남는다', all['다른계정']);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })], { delay: { fetch: 20 } });
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 }), mk(1012, { daysAgo: 0 })]);
    await Promise.all([env.run({ onlyNew: true }), env.run({ onlyNew: true })]);
    ok(same(four(env.rec()), { uidValidity: String(V), gen: 1, lowUid: 1001, lastUid: 1012 }) && same(env.uids(), [1010, 1012]), '두 실행이 함께 돌아도 기록과 파일이 맞다', four(env.rec()));
    ok(!fs.readdirSync(env.boxDir()).some((n) => n.endsWith('.part')), '임시 파일이 서로 밟지 않는다');
  }

  console.log('\n[9] 색인 줄과 exists');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' }), box('보낸편지함', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    ok(env.rec().exists === 1, '표시만 할 때도 exists 를 적는다', env.rec().exists);
    const seen = mk(1010, { daysAgo: 0, seen: true });
    addMail(env, [seen, mk(1012, { daysAgo: 0 })]);
    addMail(env, [mk(1010, { daysAgo: 0 })], '보낸편지함');
    const secretAcc = { ...A, pass: 'hibi-test-not-a-secret' };
    await mailbackup.backupAccount(secretAcc, env.dir, { onlyNew: true });
    const l = await mailindex.load(env.boxDir());
    const row = l.rows.get(1010);
    ok(row.seen === true && l.rows.get(1012).seen === false, 'seen 은 서버 플래그 값', [row.seen, l.rows.get(1012).seen]);
    ok(row.size === Buffer.byteLength(seen.raw, 'latin1') && row.bytes === row.size, 'size·bytes', [row.size, row.bytes]);
    ok(row.st === 'file' && row.via === 'new' && fs.existsSync(path.join(env.boxDir(), row.file)) && /_1010_report 1010\.eml$/.test(row.file), 'file 은 실제 파일 이름', row.file);
    ok(row.mid === seen.messageId && row.subject === seen.subject && Number.isFinite(row.at), '머리 칸', row.mid);
    ok(l.meta && l.meta.acc === 'a1' && l.meta.user === A.user && l.meta.host === A.host && l.meta.box === 'INBOX' && l.meta.uidValidity === String(V) && l.meta.gen === 1 && l.meta.use === '', '메타', l.meta);
    ok((await mailindex.load(env.boxDir('보낸편지함'))).meta.use === '\\Sent', '보낸편지함은 이름으로 짐작한 역할을 적는다');
    ok(env.rec().exists === 3 && env.rec('보낸편지함').exists === 2, 'exists 칸', env.rec().exists);
    const text = fs.readFileSync(path.join(env.boxDir(), mailindex.INDEX_FILE), 'utf8') + fs.readFileSync(path.join(env.dir, mailbackup.STATE_FILE), 'utf8');
    ok(!text.includes(secretAcc.pass), '비밀번호가 색인·상태 파일에 들어가지 않는다');
  }

  console.log('\n[10] 상태 파일');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const file = path.join(env.dir, mailbackup.STATE_FILE);
    const body = fs.readFileSync(file);
    const real = fs.readFileSync;
    const conns = env.server.clients.length;
    fs.readFileSync = (f, ...a) => { if (String(f) === file) throw oops('EPERM', '잠김'); return real(f, ...a); };
    const e = await thrownBy(env.run({ onlyNew: true }));
    fs.readFileSync = real;
    ok(e && e.code === 'STATE_UNREADABLE' && /진행 기록을 읽을 수 없습니다 — EPERM/.test(e.message), '못 읽으면 던진다', e && e.message);
    ok(env.server.clients.length === conns, '…연결하기 전이다', env.server.clients.length);
    ok(fs.readFileSync(file).equals(body), '…덮어쓰지 않는다');

    // 도는 도중에 잠겨도 마찬가지다
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    let n = 0;
    fs.readFileSync = (f, ...a) => { if (String(f) === file && ++n > 1) throw oops('EPERM', '잠김'); return real(f, ...a); };
    const e2 = await thrownBy(env.run({ onlyNew: true }));
    fs.readFileSync = real;
    ok(e2 && e2.code === 'STATE_UNREADABLE' && fs.readFileSync(file).equals(body), '도는 도중에 잠겨도 덮어쓰지 않는다', e2 && e2.message);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    const file = path.join(env.dir, mailbackup.STATE_FILE);
    fs.writeFileSync(file, '{"a1":{"INBOX":{"lastUid":12');
    const r = await env.run({ onlyNew: true });
    ok(r.stateError === '진행 기록이 깨져 새로 시작했습니다', '깨졌으면 알린다', r.stateError);
    ok(fs.readFileSync(`${file}.broken`, 'utf8') === '{"a1":{"INBOX":{"lastUid":12', '.broken 이 남는다');
    ok(env.rec() && env.rec().lastUid === 1000 && r.seeded === 1, '새로 시작한다', four(env.rec()));
  }
  {
    const dir = path.join(TMP, `s${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    ok(same(mailbackup.readStateInfo(dir), { state: {}, broken: false }), '없음은 빈 값');
  }

  console.log('\n[11] 상태 파일을 잃은 폴더');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    const file = path.join(env.dir, mailbackup.STATE_FILE);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    await env.run({ onlyNew: true });

    fs.unlinkSync(file);
    const r0 = await env.run({ onlyNew: true });
    ok(env.rec().gen === 1 && r0.seeded === 1 && r0.genUp === false, 'UIDVALIDITY 가 같으면 세대를 그대로 쓴다', env.rec().gen);

    fs.unlinkSync(file);
    const sb = env.server.box('a1', 'INBOX');
    sb.uidValidity = V + 1n;
    const r1 = await env.run({ onlyNew: true });
    ok(env.rec().gen === 2 && env.rec().uidValidity === String(V + 1n) && r1.seeded === 1, '달라졌으면 메타를 보고 세대를 올린다', env.rec().gen);
    ok(same(env.uids('INBOX', 1), [1010]), '옛 파일은 그대로', env.uids('INBOX', 1));

    addMail(env, [mk(1020, { daysAgo: 0 })]);
    await env.run({ onlyNew: true });
    ok(same(env.uids('INBOX', 2), [1020]), '새 메일은 새 세대 폴더로', env.uids('INBOX', 2));

    fs.unlinkSync(file);
    sb.uidValidity = V + 2n;
    await env.run({ onlyNew: true });
    ok(env.rec().gen === 3, '메타가 있는 세대를 모두 건너뛴다', env.rec().gen);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const sb = env.server.box('a1', 'INBOX');
    sb.uidValidity = V + 1n;
    const r = await env.run({ onlyNew: true });
    ok(env.rec().gen === 2 && r.genUp === true, '기록이 있으면 메타 없이도 세대가 오르고 genUp 이 참이다', [env.rec().gen, r.genUp]);
  }

  console.log('\n[12] 옛 코드가 읽는 모양');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    await env.run({ onlyNew: true });
    const names = fs.readdirSync(env.boxDir()).filter((n) => n.endsWith('.eml'));
    ok(names.length === 1 && /^\d{8}_\d{4}_1010_report 1010\.eml$/.test(names[0]), '파일 이름은 받은 시각_UID_제목.eml', names);
    ok(same([...await mailbackup.uidFiles(env.boxDir())].map(([u]) => u), [1010]) && same(env.uids(), [1010]), 'uidFiles·uidsIn 이 그대로 읽는다');
    const rec = env.rec();
    ok(typeof rec.uidValidity === 'string' && Number.isInteger(rec.gen) && Number.isInteger(rec.lowUid) && Number.isInteger(rec.lastUid), '네 칸의 타입', four(rec));
    ok(same(four(rec), { uidValidity: String(V), gen: 1, lowUid: 1001, lastUid: 1010 }), '네 칸의 값', four(rec));
    ok(mailbackup.savedFile(env.dir, A, 'INBOX', 1010) === path.join(env.boxDir(), names[0]), 'savedFile 이 그 파일을 찾는다');
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    const real = fs.promises.rename;
    let n = 0;
    fs.promises.rename = async (a, b) => { n += 1; if (n === 1) throw oops('ENAMETOOLONG', '이름이 길다'); return real(a, b); };
    const r = await env.run({ onlyNew: true });
    fs.promises.rename = real;
    const names = fs.readdirSync(env.boxDir()).filter((x) => x.endsWith('.eml'));
    ok(r.saved === 1 && names.length === 1 && /^\d{8}_\d{4}_1010\.eml$/.test(names[0]), '긴 이름에 걸리면 제목을 뺀다', names);
    const row = (await mailindex.load(env.boxDir())).rows.get(1010);
    ok(row.file === names[0], '…색인 줄도 그 이름이다', row.file);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    const real = fs.promises.rename;
    let n = 0;
    fs.promises.rename = async (a, b) => { n += 1; if (n <= 3) throw oops('EBUSY', '잠김'); return real(a, b); };
    const before = env.sourceRanges().length;
    const r = await env.run({ onlyNew: true });
    fs.promises.rename = real;
    ok(r.saved === 1 && n === 4 && env.sourceRanges().length === before + 1, 'rename 이 세 번 막혀도 재수신 없이 저장된다', [n, env.sourceRanges().length - before]);
    ok(same(r.boxErrors, []), '…오류로 남지 않는다', r.boxErrors);
  }
  {
    const d = path.join(TMP, `c${++seq}`);
    fs.mkdirSync(d, { recursive: true });
    const real = fs.promises.rename;
    fs.promises.rename = async () => { throw oops('EIO', '안 됨'); };
    const e = await thrownBy(mailbackup.commit(d, { uid: 7, receivedAt: NOW, subject: 's', source: Buffer.from('x') }));
    fs.promises.rename = real;
    ok(e && e.code === 'EIO' && fs.readdirSync(d).length === 0, '그 밖의 rename 실패는 던지고 .part 를 남기지 않는다', fs.readdirSync(d));
    const c = await mailbackup.commit(d, { uid: 7, receivedAt: new Date(2025, 0, 2, 3, 4).getTime(), subject: 'a/b', source: Buffer.from('xyz') });
    ok(c.name === '20250102_0304_7_a_b.eml' && c.bytes === 3, 'commit 은 이름과 바이트 수를 준다', c);
  }

  console.log('\n[13] 밀린 구간 상한');
  {
    const seedOld = (msgs, extra) => {
      const env = setup([box('INBOX', msgs, extra)]);
      mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000, fillHead: true });
      return env;
    };
    const range = (a, z, step = 1) => { const out = []; for (let u = a; u <= z; u += step) out.push(mk(u)); return out; };

    const env = seedOld(range(5001, 7000), { uidNext: 7001 });
    let stops = 0;
    const r = await env.run({ onlyNew: true, shouldStop: () => env.sourceRanges().length >= 1 && ++stops >= 1 });
    ok(r.capped === 1800 && r.saved === 50 && r.stopped === true, '맨 위 200통부터 받고, 건너뛴 통수를 적는다', [r.capped, r.saved, r.stopped]);
    ok(env.server.log.some((e) => e.cmd === 'search' && same(e.q, { uid: '5001:7000' })), '폭이 아니라 실제 UID 를 센다');
    ok(env.rec().lowUid === 6801 && env.rec().lastUid === 6850 && env.rec().fillHead === false, 'lowUid 가 오르고 fillHead 가 지워진다', env.rec());
    const r2 = await env.run({ onlyNew: true });
    ok(r2.capped === 0 && r2.saved === 150 && env.rec().lastUid === 7000 && env.rec().lowUid === 6801, '끊겨도 다음 폴링이 last+1 부터 잇는다', [r2.capped, r2.saved, env.rec().lastUid]);
    ok(env.sourceRanges().every((x) => lowOf(x) >= 6801) && env.uids().length === 200 && env.uids()[0] === 6801, '받은 것은 맨 위 200통뿐', env.uids().length);
    const n = env.server.log.length;
    const r3 = await env.run({ onlyNew: true });
    ok(r3.saved === 0 && !env.server.log.slice(n).some((e) => e.cmd === 'search' || e.cmd === 'fetch'), '다음 실행은 받을 것이 없다', r3.saved);
    ok(env.rec().fillHead === false && env.rec().lowUid === 6801, '…기록도 그대로');
  }
  {
    // 받는 중 멈춘 뒤 구멍이 생겼다 — 낡은 남은 수로 «최대 10통»이라고 물으면 안 된다
    const msgs = [];
    for (let u = 5001; u <= 5630; u++) msgs.push(mk(u));
    const env = setup([box('INBOX', msgs, { uidNext: 5631 })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000, fillHead: true, fillLeft: 10, fillLeftBytes: 999 });
    const r = await env.run({ onlyNew: true });
    ok(r.capped === 430 && env.rec().fillLeft === undefined && env.rec().fillLeftBytes === undefined, '구멍을 만들면 낡은 남은 수를 지운다', env.rec());
    ok(require(path.join(ROOT, 'src', 'mailfill.js')).countPending(A, env.dir).left === 630, '…통수는 exists 로 돌아간다', env.rec().exists);
  }
  {
    // 답이 없는 계정 — 묻기 전에 받는 양은 계정 전체로 200통이다. 받은편지함이 먼저다
    const backlog = (o) => {
      const msgs = [];
      for (let u = 5001; u <= 5300; u++) msgs.push(mk(u));
      const env = setup(['A', 'B', 'INBOX'].map((p) => box(p, msgs, { uidNext: 5301 })));
      for (const p of ['A', 'B', 'INBOX']) mailbackup.patchState(env.dir, 'a1', p, { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000 });
      return env.run({ onlyNew: true, ...o }).then((r) => ({ env, r }));
    };
    let { env, r } = await backlog({ unanswered: true });
    ok(r.saved === 200 && env.uids('INBOX').length === 200 && !env.uids('A').length && !env.uids('B').length, '답이 없으면 폴더가 셋이어도 200통, 받은편지함부터', [r.saved, env.uids('INBOX').length, env.uids('A').length]);
    ok(r.capped === 700, '…나머지는 뒤로 미룬다', r.capped);
    ok(env.rec('A').lowUid === 5301 && env.rec('A').lastUid === 5300 && env.rec('A').fillHead === false, '…몫이 없는 폴더는 통째로 구멍이 된다', env.rec('A'));
    const n = env.sourceRanges().length;
    const r2 = await env.run({ onlyNew: true, unanswered: true });
    ok(r2.saved === 0 && env.sourceRanges().length === n, '…다음 실행은 받을 것이 없다', r2.saved);
    ({ env, r } = await backlog({}));
    ok(r.saved === 600 && r.capped === 300, '답한 계정은 지금처럼 폴더마다 200통', [r.saved, r.capped]);
  }
  {
    // UID 는 듬성듬성하다 — 폭은 2000이어도 실제 100통이면 지금처럼 다 받는다
    const msgs = [];
    for (let u = 5020; u <= 7000; u += 20) msgs.push(mk(u));
    const env = setup([box('INBOX', msgs, { uidNext: 7001 })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000, fillHead: true });
    const r = await env.run({ onlyNew: true });
    ok(r.capped === 0 && r.saved === 100 && env.rec().lowUid === 1 && env.rec().fillHead === true, '띄엄띄엄한 UID 로 실제 200통 이하면 전부 받는다', [r.capped, r.saved, env.rec().lowUid]);
  }
  {
    const msgs = [];
    for (let i = 0; i < 201; i++) msgs.push(mk(5001 + i * 9));
    const env = setup([box('INBOX', msgs, { uidNext: 6802 })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000 });
    const r = await env.run({ onlyNew: true });
    ok(r.capped === 1 && r.saved === 200 && env.rec().lowUid === 5010 && env.uids()[0] === 5010, '실제 201통이면 한 통만 뒤 받기로 넘긴다', [r.capped, r.saved, env.rec().lowUid]);
  }
  {
    const msgs = [];
    for (let i = 0; i < 200; i++) msgs.push(mk(5001 + i * 9));
    const env = setup([box('INBOX', msgs, { uidNext: 6793 })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000, fillHead: true });
    const r = await env.run({ onlyNew: true });
    ok(r.capped === 0 && r.saved === 200 && env.rec().lowUid === 1 && env.rec().fillHead === true, '꼭 200통이면 구멍을 만들지 않는다', [r.capped, r.saved, env.rec().lowUid]);
  }
  {
    const msgs = [];
    for (let u = 6950; u <= 7000; u++) msgs.push(mk(u));
    const env = setup([box('INBOX', msgs, { uidNext: 7001, searchReturns: false })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000 });
    const r = await env.run({ onlyNew: true });
    ok(r.capped === 1800 && env.rec().lowUid === 6801 && env.rec().lastUid === 7000 && r.saved === 51, '검색 답이 배열이 아니면 폭으로 판단한다', [r.capped, env.rec().lowUid, r.saved]);
  }
  {
    // 검색이 끊겨서 false 를 준 것을 «많다»로 읽으면 없는 구멍을 만든다
    const msgs = [mk(6999), mk(7000)];
    const env = setup([box('INBOX', msgs, { uidNext: 7001, searchReturns: false })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 5000, fillHead: true });
    onClient((c) => {
      const search = c.search.bind(c);
      c.search = async (...a) => { const v = await search(...a); c.usable = false; return v; };
    });
    const e = await thrownBy(env.run({ onlyNew: true }));
    ok(e && /끊겼습니다/.test(e.message) && env.rec().lastUid === 5000 && env.rec().lowUid === 1 && env.rec().fillHead === true, '끊긴 것이면 기록을 건드리지 않는다', e && e.message);
  }
  {
    const msgs = [];
    for (let u = 1; u <= 250; u++) msgs.push(mk(u));
    const env = setup([box('INBOX', msgs, { uidNext: 'auto' })]);
    const r = await env.run({ onlyNew: false });
    ok(r.capped === 0 && r.saved === 250, '전체 받기에는 상한이 없다', [r.capped, r.saved]);
  }

  console.log('\n[14] shouldStop');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' }), box('업무', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const msgs = [];
    for (let u = 1001; u <= 1120; u++) msgs.push(mk(u));
    addMail(env, msgs);
    const before = env.sourceRanges().length;
    const r = await env.run({ onlyNew: true, shouldStop: () => env.sourceRanges().length - before >= 1 });
    ok(r.stopped === true && r.saved === 50 && env.rec().lastUid === 1050, '다음 묶음 앞에서 멈춘다', [r.stopped, r.saved, env.rec().lastUid]);
    ok(env.server.clients[env.server.clients.length - 1].loggedOut, '…로그아웃한다');
    const opened = env.opens().length;
    const r2 = await env.run({ onlyNew: true, shouldStop: () => true });
    ok(r2.stopped === true && env.opens().length === opened, '처음부터 참이면 폴더를 열지 않는다', env.opens().length - opened);
    const r3 = await env.run({ onlyNew: true });
    ok(r3.saved === 70 && env.rec().lastUid === 1120, '다음 실행이 잇는다', r3.saved);
  }

  console.log('\n[15] 독 메일');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const msgs = [];
    for (let u = 1001; u <= 1070; u++) msgs.push(u === 1010 ? { ...mk(u), fetchNo: true } : mk(u));
    addMail(env, msgs);
    const rows = async () => (await mailindex.load(env.boxDir())).rows;

    const r = await env.run({ onlyNew: true });
    ok(r.saved === 69 && !env.uids().includes(1010) && env.uids().length === 69, '묶음의 나머지와 그 위 메일이 저장된다', [r.saved, env.uids().length]);
    ok(env.rec().lastUid === 1070, 'last 가 오른다', env.rec().lastUid);
    const row1 = (await rows()).get(1010);
    ok(row1 && row1.st === 'head' && row1.fails === 1 && row1.via === 'new' && !row1.file && row1.at === undefined, '자리표 줄이 남는다', row1);
    ok(same(r.boxErrors, []) && r.rejected === 1 && env.rec().fillFail === 1, '폴더 오류가 아니다 — 못 받은 통수는 rejected 와 fillFail 로', [r.boxErrors, r.rejected, env.rec().fillFail]);
    ok(env.server.log.some((e) => e.cmd === 'search' && same(e.q, { uid: '1001:1050' })), '실제 UID 를 얻어 한 통씩 받는다');

    let n = env.sourceRanges().length;
    const r2 = await env.run({ onlyNew: true });
    ok(same(env.sourceRanges().slice(n), ['1010']) && (await rows()).get(1010).fails === 2, '다음 실행은 그 UID 만 다시 부른다', env.sourceRanges().slice(n));
    ok(r2.saved === 0 && same(r2.boxErrors, []) && r2.rejected === 0 && env.rec().fillFail === 1, '…같은 메일을 또 세지 않는다', [r2.rejected, env.rec().fillFail]);
    n = env.sourceRanges().length;
    await env.run({ onlyNew: true });
    ok(same(env.sourceRanges().slice(n), ['1010']) && (await rows()).get(1010).fails === 3, '세 번째', env.sourceRanges().slice(n));
    n = env.sourceRanges().length;
    const r4 = await env.run({ onlyNew: true });
    ok(env.sourceRanges().length === n && (await rows()).get(1010).st === 'head', '3번 뒤에는 안 부른다, 줄은 st:head 로 남는다', env.sourceRanges().length - n);
    ok(same(r4.boxErrors, []) && env.rec().fillFail === 1, '…폴더 오류로 남지 않고 못 받은 수는 상태에 남는다', [r4.boxErrors, env.rec().fillFail]);
    ok(env.clean(), '금지 명령 0, 모두 읽기 전용으로 열었다');
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const sb = addMail(env, [mk(1001), { ...mk(1002), fetchNo: true }, mk(1003)]);
    await env.run({ onlyNew: true });
    sb.msgs.find((m) => m.uid === 1002).fetchNo = false;
    addMail(env, [mk(1005, { daysAgo: 0 })]);
    const n = env.sourceRanges().length;
    const r = await env.run({ onlyNew: true });
    ok(r.saved === 2 && same(env.uids(), [1001, 1002, 1003, 1005]) && same(r.boxErrors, []), '풀리면 받고 말을 거둔다, 새 메일도 함께', r);
    const row = (await mailindex.load(env.boxDir())).rows.get(1002);
    ok(row.st === 'file' && !!row.file, '…줄이 st:file 이 된다', row.st);
    ok(same(env.sourceRanges().slice(n), ['1002', '1004:1005']), '거절된 메일을 먼저 부른다', env.sourceRanges().slice(n));
    const n2 = env.sourceRanges().length;
    await env.run({ onlyNew: true });
    ok(env.sourceRanges().length === n2, '…다음 실행은 부르지 않는다');
  }
  {
    // 거절처럼 보여도 연결이 죽었으면 자리표로 지나가면 안 된다 — 받을 수 있는 메일을 건너뛰게 된다
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1001)]);
    onClient((c) => {
      c.fetch = async function* dead() { c.usable = false; throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' }); };
    });
    const e = await thrownBy(env.run({ onlyNew: true }));
    ok(e && env.rec().lastUid === 1000, '연결이 죽었으면 last 를 올리지 않는다', env.rec().lastUid);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' }), box('업무', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: false });
    addMail(env, [mk(1001), { ...mk(1002), fetchNo: true }]);
    addMail(env, [mk(1001)], '업무');
    const r = await env.run({ onlyNew: false });
    ok(same(env.uids().filter((u) => u > 1000), []) && env.rec().lastUid === 1000 && r.boxErrors.length === 1, '전체 받기는 지금처럼 그 폴더를 멈춘다 — low..last 에 구멍을 남기지 않는다', r.boxErrors);
    ok(same(env.uids('업무'), [1000, 1001]), '…다른 폴더는 받는다', env.uids('업무'));
  }
  {
    const realOpen = fs.promises.open;
    const failFor = (uid, code) => {
      fs.promises.open = async (f, ...a) => {
        if (String(f).includes(path.join('B', `~받는중-${uid}-`))) throw oops(code);
        return realOpen(f, ...a);
      };
    };
    const seeded = async () => {
      const env = setup([box('A', [mk(1000)], { uidNext: 'auto' }), box('B', [mk(1000)], { uidNext: 'auto' }), box('C', [mk(1000)], { uidNext: 'auto' })]);
      await env.run({ onlyNew: true });
      for (const p of ['A', 'B', 'C']) addMail(env, [mk(1001), mk(1002), mk(1003)], p);
      return env;
    };

    let env = await seeded();
    let asked = 0;
    let opened = env.opens().length;
    failFor(1002, 'ENOSPC');
    let r = await env.run({ onlyNew: true, dirProblem: () => { asked += 1; return null; } });
    fs.promises.open = realOpen;
    ok(same(env.uids('A'), [1001, 1002, 1003]) && same(env.uids('B'), [1001]) && env.rec('B').lastUid === 1000, 'ENOSPC — 그 폴더에서 멈추고 last 를 올리지 않는다', [env.uids('B'), env.rec('B').lastUid]);
    ok(r.boxErrors.length === 1 && /^B: /.test(r.boxErrors[0]) && asked === 0, '…프로브를 부르지 않는다', r.boxErrors);
    ok(same(env.opens().slice(opened).map((o) => o.path), ['A', 'B']), '…다음 폴더를 열지 않는다', env.opens().slice(opened).map((o) => o.path));
    ok(!fs.readdirSync(env.boxDir('B')).some((n) => n.endsWith('.part')), '….part 를 남기지 않는다');
    r = await env.run({ onlyNew: true, dirProblem: () => null });
    ok(same(env.uids('B'), [1001, 1002, 1003]) && same(env.uids('C'), [1001, 1002, 1003]) && r.skipped === 1, '풀리면 그 자리부터 잇는다', [env.uids('B'), r.skipped]);

    env = await seeded();
    opened = env.opens().length;
    failFor(1002, 'EACCES');
    let seenDir = null;
    r = await env.run({ onlyNew: true, dirProblem: (d) => { seenDir = d; return '이 폴더에는 쓸 수 없습니다'; } });
    fs.promises.open = realOpen;
    ok(seenDir === env.dir && env.rec('B').lastUid === 1000 && same(env.opens().slice(opened).map((o) => o.path), ['A', 'B']), '폴더 탓이면 멈춘다', [seenDir === env.dir, env.rec('B').lastUid]);

    env = await seeded();
    failFor(1002, 'EACCES');
    r = await env.run({ onlyNew: true });
    fs.promises.open = realOpen;
    ok(env.rec('B').lastUid === 1000 && r.boxErrors.length === 1, '가르는 함수가 없으면 폴더 탓으로 본다', r.boxErrors);

    env = await seeded();
    failFor(1002, 'EACCES');
    r = await env.run({ onlyNew: true, dirProblem: () => null });
    fs.promises.open = realOpen;
    ok(same(env.uids('B'), [1001, 1003]) && env.rec('B').lastUid === 1003 && same(env.uids('C'), [1001, 1002, 1003]), '메일 탓이면 거절된 통과 같다 — 위쪽 메일과 다음 폴더를 막지 않는다', [env.uids('B'), env.rec('B').lastUid]);
    const row = (await mailindex.load(env.boxDir('B'))).rows.get(1002);
    ok(row.st === 'head' && row.fails === 1 && row.via === 'new' && !row.file, '…자리표가 남는다 — 못 쓴 파일을 가리키지 않는다', row);
    ok(r.rejected === 1 && env.rec('B').fillFail === 1 && same(r.boxErrors, []), '…못 받은 통수가 남는다', [r.rejected, env.rec('B').fillFail, r.boxErrors]);
    const n = env.sourceRanges().length;
    r = await env.run({ onlyNew: true, dirProblem: () => null });
    ok(same(env.sourceRanges().slice(n), ['1002']) && same(env.uids('B'), [1001, 1002, 1003]) && env.rec('B').fillFail === 0, '…다음 실행이 그 한 통을 받고 수를 되돌린다', env.sourceRanges().slice(n));
  }

  console.log('\n[16] 못 읽는 날짜와 알림 줄');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })], { notify: true });
    await env.run({ onlyNew: true });
    addMail(env, [{ ...mk(1010), badDate: true }, mk(1011), { ...mk(1012), badDate: '15 Jun 2024 12:00:00 +0000' }]);
    const r = await env.run({ onlyNew: true });
    ok(r.saved === 3 && r.missing === 0 && same(r.boxErrors, []), '묶음이 던지지 않는다, 알림 줄을 «못 받음»으로 세지 않는다', r);
    const l = await mailindex.load(env.boxDir());
    ok(same([...l.rows.keys()].sort(), [1010, 1011, 1012]) && l.bad === 0, 'uid 없는 줄이 색인에 없다', [[...l.rows.keys()], l.bad]);
    ok(!/undefined/.test(fs.readFileSync(path.join(env.boxDir(), mailindex.INDEX_FILE), 'utf8')), '색인 파일에도 없다');
    ok(/^202406/.test(l.rows.get(1012).file), '읽을 수 있는 문자열 날짜는 그 값을 쓴다', l.rows.get(1012).file);
    ok(Number.isFinite(l.rows.get(1010).at) && /^\d{8}_\d{4}_1010_/.test(l.rows.get(1010).file), '못 읽으면 지금 시각을 쓴다', l.rows.get(1010).file);
  }

  console.log('\n[17] UIDVALIDITY 를 안 주는 답');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const was = JSON.stringify(env.rec());
    const sb = env.server.box('a1', 'INBOX');
    sb.noUidValidity = true;
    const e = await thrownBy(env.run({ onlyNew: true }));
    ok(e && /UIDVALIDITY/.test(e.message) && JSON.stringify(env.rec()) === was, '폴더 오류이고 기록이 그대로다', e && e.message);
    const e2 = await thrownBy(env.run({ onlyNew: false }));
    ok(e2 && JSON.stringify(env.rec()) === was, '전체 받기도 마찬가지', e2 && e2.message);
    sb.noUidValidity = false;
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    const r = await env.run({ onlyNew: true });
    ok(env.rec().gen === 1 && r.saved === 1 && same(env.uids(), [1010]) && r.genUp === false, '다음 정상 답에도 세대가 그대로다', env.rec());
    ok(!/undefined/.test(fs.readFileSync(path.join(env.dir, mailbackup.STATE_FILE), 'utf8')), '기록에 "undefined" 가 없다');
  }
  {
    const env = setup([box('A', [mk(1000)], { noUidValidity: true, uidNext: 'auto' }), box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    const r = await env.run({ onlyNew: true });
    ok(r.boxErrors.length === 1 && /^A: /.test(r.boxErrors[0]) && !env.rec('A') && r.seeded === 1, '기록 없는 폴더도 적지 않는다', r.boxErrors);
  }

  console.log('\n[18] saveState');
  {
    const dir = path.join(TMP, `s${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, mailbackup.STATE_FILE);
    const good = { a1: { INBOX: { uidValidity: '7', gen: 1, lowUid: 1, lastUid: 500 } } };
    ok(mailbackup.saveState(dir, good) === null, '보통은 null');
    const body = fs.readFileSync(file);
    const realW = fs.writeFileSync;
    const realR = fs.renameSync;

    // 직접 쓰기는 파일을 먼저 비운다 — 진짜로 비워 보여 준다
    fs.writeFileSync = (f, d) => {
      if (String(f) === file) realW(file, '');
      if (String(f).startsWith(file)) throw oops('ENOSPC', '디스크가 찼습니다');
      return realW(f, d);
    };
    const e = mailbackup.saveState(dir, { other: 1 });
    fs.writeFileSync = realW;
    ok(e === '디스크가 찼습니다', 'ENOSPC 면 오류만 돌려준다', e);
    ok(fs.readFileSync(file).equals(body), '…원본을 비우지 않는다');
    ok(!fs.existsSync(`${file}.bak`), '….bak 도 만들지 않는다');

    fs.renameSync = () => { throw oops('EBUSY', '잠김'); };
    const e2 = mailbackup.saveState(dir, { a1: { INBOX: { uidValidity: '7', gen: 1, lowUid: 1, lastUid: 600 } } });
    fs.renameSync = realR;
    ok(e2 === null && JSON.parse(fs.readFileSync(file, 'utf8')).a1.INBOX.lastUid === 600, 'rename 이 막히면 직접 쓴다', e2);
    ok(fs.readFileSync(`${file}.bak`).equals(body), '…먼저 사본을 둔다');

    const mid = fs.readFileSync(file);
    fs.renameSync = () => { throw oops('EBUSY', '잠김'); };
    fs.writeFileSync = (f, d) => {
      if (String(f) === file) { realW(file, '{"a1":{"INB'); throw oops('EIO', '쓰다 끊김'); }
      return realW(f, d);
    };
    const e3 = mailbackup.saveState(dir, { a1: { INBOX: { uidValidity: '7', gen: 1, lowUid: 1, lastUid: 700 } } });
    fs.renameSync = realR;
    fs.writeFileSync = realW;
    ok(e3 === '쓰다 끊김' && fs.readFileSync(`${file}.bak`).equals(mid), '직접 쓰기가 중간에 실패하면 오류를 돌려준다', e3);
    const info = mailbackup.readStateInfo(dir);
    ok(info.broken === false && info.restored === true && info.state.a1.INBOX.lastUid === 600, '.bak 에서 되살린다 — 옛 lastUid 를 잃지 않는다', info);
    ok(!fs.existsSync(`${file}.broken`), '….broken 으로 비키지 않는다');

    fs.writeFileSync(`${file}.bak`, '{깨짐');
    const info2 = mailbackup.readStateInfo(dir);
    ok(info2.broken === true && same(info2.state, {}) && fs.existsSync(`${file}.broken`), '사본도 깨졌으면 새로 시작한다', info2);
  }
  {
    // 잠김과 쓰기 실패가 두 번 겹친다 — 비워진 본 파일을 사본 위에 덮으면 모든 계정 기록을 잃는다
    const dir = path.join(TMP, `s${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, mailbackup.STATE_FILE);
    const first = { a1: { INBOX: { uidValidity: '7', gen: 1, lowUid: 5001, lastUid: 5000 } }, b2: { INBOX: { uidValidity: '9', gen: 1, lowUid: 1, lastUid: 9 } } };
    ok(mailbackup.saveState(dir, first) === null, '준비');
    const body = fs.readFileSync(file);
    const realW = fs.writeFileSync;
    const realR = fs.renameSync;
    fs.renameSync = () => { throw oops('EPERM', '잠김'); };
    fs.writeFileSync = (fl, d) => {
      if (String(fl) === file) { realW(file, ''); throw oops('ENOSPC', '디스크가 찼습니다'); }
      return realW(fl, d);
    };
    const e1 = mailbackup.patchState(dir, 'a1', 'INBOX', { lastUid: 5001 }).error;
    ok(!!e1 && fs.statSync(file).size === 0 && fs.readFileSync(`${file}.bak`).equals(body), '첫 번째 — 본 파일은 비었지만 사본이 있다', fs.statSync(file).size);
    const e2 = mailbackup.patchState(dir, 'a1', 'INBOX', { lastUid: 5002 }).error;
    fs.renameSync = realR;
    fs.writeFileSync = realW;
    ok(!!e2 && fs.readFileSync(`${file}.bak`).equals(body), '두 번째 — 비워진 본 파일로 사본을 덮지 않는다', fs.statSync(`${file}.bak`).size);
    const info = mailbackup.readStateInfo(dir);
    ok(info.broken === false && info.restored === true && info.state.b2.INBOX.lastUid === 9 && info.state.a1.INBOX.lastUid === 5000, '…기록이 살아난다', info.state.a1);
    ok(mailbackup.patchState(dir, 'a1', 'INBOX', { lastUid: 5003 }).error === null && !fs.existsSync(`${file}.bak`), '원자적 쓰기가 되면 사본을 지운다 — 몇 달 뒤 옛 값이 돌아오지 않게', fs.existsSync(`${file}.bak`));
    fs.writeFileSync(file, Buffer.alloc(64));
    const info2 = mailbackup.readStateInfo(dir);
    ok(info2.broken === true && !info2.restored, '…그 뒤 본 파일이 깨지면 옛 값으로 조용히 돌아가지 않고 깨졌다고 말한다', info2.broken);
    // .tmp 는 rename 전에 디스크로 내린다 — 전원이 나가 0으로 찬 파일을 막는다
    const realF = fs.fsyncSync;
    let synced = 0;
    fs.fsyncSync = (fd) => { synced += 1; return realF(fd); };
    mailbackup.saveState(dir, first);
    fs.fsyncSync = realF;
    ok(synced === 1, '.tmp 에 fsync 를 한다', synced);
    // commit 도 rename 전에 내린다. 전원 차단은 시험으로 못 재니 불렀는지와 차례만 본다
    const order = [];
    const realOpen = fs.promises.open;
    const realRename = fs.promises.rename;
    fs.promises.open = async (...a) => {
      const fh = await realOpen(...a);
      const sync = fh.sync.bind(fh);
      fh.sync = () => { order.push('sync'); return sync(); };
      return fh;
    };
    fs.promises.rename = async (...a) => { order.push('rename'); return realRename(...a); };
    await mailbackup.commit(dir, { uid: 77, receivedAt: Date.now(), subject: 'x', source: Buffer.from('Subject: x\r\n\r\ny', 'latin1') });
    fs.promises.open = realOpen;
    fs.promises.rename = realRename;
    ok(same(order, ['sync', 'rename']), 'commit 은 rename 전에 fsync 를 한다', order);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    const file = path.join(env.dir, mailbackup.STATE_FILE);
    const body = fs.readFileSync(file);
    const realW = fs.writeFileSync;
    fs.writeFileSync = (f, d) => { if (String(f).startsWith(file)) throw oops('ENOSPC', '디스크가 찼습니다'); return realW(f, d); };
    const r = await env.run({ onlyNew: true });
    fs.writeFileSync = realW;
    ok(r.stateError === '디스크가 찼습니다' && r.saved === 1, '기록을 못 쓰면 stateError 로 알린다', r.stateError);
    ok(fs.readFileSync(file).equals(body), '…원본은 그대로 — 다음 실행이 그 자리부터 다시 받는다');
    const r2 = await env.run({ onlyNew: true });
    ok(r2.skipped === 1 && r2.saved === 0 && r2.stateError === null && env.rec().lastUid === 1010, '…파일이 있으니 다시 쓰지 않는다', [r2.skipped, r2.saved]);
  }

  console.log('\n[19] patchState');
  {
    const dir = path.join(TMP, `s${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const get = () => mailbackup.loadState(dir).a1.INBOX;
    const base = { uidValidity: '7', gen: 1, lowUid: 100, lastUid: 200, exists: 5, fillHead: true, fillLeft: 9 };
    ok(mailbackup.patchState(dir, 'a1', 'INBOX', base).error === null && same(get(), base), '처음에는 그대로 적는다', get());
    mailbackup.patchState(dir, 'a1', 'INBOX', { lowUid: 300, lastUid: 150 });
    ok(get().lowUid === 100 && get().lastUid === 200, 'raiseLow 없이는 lowUid 가 안 오르고, lastUid 가 안 내려간다', [get().lowUid, get().lastUid]);
    mailbackup.patchState(dir, 'a1', 'INBOX', { lowUid: 50, lastUid: 300 });
    ok(get().lowUid === 50 && get().lastUid === 300, '넓히는 쪽은 받는다', [get().lowUid, get().lastUid]);
    mailbackup.patchState(dir, 'a1', 'INBOX', { lowUid: 250, lastUid: 249, fillHead: false }, { raiseLow: true });
    ok(get().lowUid === 250 && get().lastUid === 300 && get().fillHead === false, 'raiseLow 면 lowUid 가 오른다', get());
    const was = JSON.stringify(get());
    const d = mailbackup.patchState(dir, 'a1', 'INBOX', { fillLeft: 1 }, { expectV: '8' });
    ok(d.dropped === true && d.error === null && JSON.stringify(get()) === was, 'expectV 가 다르면 버린다', d);
    const d2 = mailbackup.patchState(dir, 'a1', 'INBOX', { fillLeft: 1 }, { expectV: 7 });
    ok(!d2.dropped && get().fillLeft === 1, 'expectV 가 같으면 적는다 (글자로 비교)', get().fillLeft);
    const d3 = mailbackup.patchState(dir, 'a1', '없는폴더', { fillLeft: 1 }, { expectV: '7' });
    ok(d3.dropped === true && !mailbackup.loadState(dir).a1['없는폴더'], '기록이 없는 폴더의 expectV 도 버린다', d3);
    mailbackup.patchState(dir, 'a1', 'INBOX', { fillSkip: false });
    ok(get().fillSkip === false && get().lowUid === 250, 'lowUid·lastUid 가 없는 패치도 된다', get());
    mailbackup.patchState(dir, 'b2', 'INBOX', { uidValidity: '1', gen: 1, lowUid: 1, lastUid: 1 });
    mailbackup.patchState(dir, 'a1', 'INBOX', { uidValidity: '8', gen: 2, lowUid: 10, lastUid: 9 });
    ok(same(get(), { uidValidity: '8', gen: 2, lowUid: 10, lastUid: 9 }), '세대가 바뀌면 통째 바꾼다 — fill* 칸이 사라진다', get());
    ok(mailbackup.loadState(dir).b2.INBOX.lastUid === 1, '다른 계정 기록은 남는다');
  }

  console.log('\n[20] 같은 UID 자리의 다른 메일');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    fs.mkdirSync(env.boxDir(), { recursive: true });
    const oldName = '20200101_0900_1010_옛 메일.eml';
    const oldBody = Buffer.from('Message-ID: <old@corp.invalid>\r\nSubject: old\r\n\r\nold\r\n', 'latin1');
    fs.writeFileSync(path.join(env.boxDir(), oldName), oldBody);
    const r = await env.run({ onlyNew: true });
    const files = (await mailbackup.uidFiles(env.boxDir())).get(1010);
    ok(r.saved === 1 && r.skipped === 0 && files.length === 2, '건너뛰지 않고 받는다 — 같은 UID 파일 둘은 uidFiles 가 허용한다', [r.saved, files.length]);
    ok(fs.readFileSync(path.join(env.boxDir(), oldName)).equals(oldBody), '옛 파일은 건드리지 않는다');
    ok((await mailindex.load(env.boxDir())).rows.get(1010).file !== oldName, '색인은 새 파일을 가리킨다');
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const m = mk(1010, { daysAgo: 0 });
    addMail(env, [m]);
    fs.mkdirSync(env.boxDir(), { recursive: true });
    fs.writeFileSync(path.join(env.boxDir(), '20200101_0900_1010_같은 메일.eml'), Buffer.from(m.raw, 'latin1'));
    const r = await env.run({ onlyNew: true });
    ok(r.saved === 0 && r.skipped === 1, '같은 메일이면 다시 쓰지 않는다', [r.saved, r.skipped]);
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    addMail(env, [mk(1010, { daysAgo: 0 })]);
    fs.mkdirSync(env.boxDir(), { recursive: true });
    fs.writeFileSync(path.join(env.boxDir(), '20200101_0900_1010_망가짐.eml'), Buffer.alloc(9000));
    const r = await env.run({ onlyNew: true });
    ok(r.saved === 1 && r.skipped === 0, '0으로 찬 파일을 «이미 받음»으로 보지 않는다', [r.saved, r.skipped]);
  }
  {
    // ENVELOPE 에 Message-ID 를 안 주는 서버 — 비교할 값이 없으니 크기로 가른다. 크기를 안 보면 받아 둔 메일을 다른 메일로 읽어 또 받는다
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const m = { ...mk(1010, { daysAgo: 0 }), messageId: undefined };
    addMail(env, [m]);
    fs.mkdirSync(env.boxDir(), { recursive: true });
    fs.writeFileSync(path.join(env.boxDir(), '20200101_0900_1010_같은 메일.eml'), Buffer.from(m.raw, 'latin1'));
    const r = await env.run({ onlyNew: true });
    ok(r.saved === 0 && r.skipped === 1, 'ENVELOPE 에 Message-ID 가 없어도 크기가 같으면 다시 쓰지 않는다', [r.saved, r.skipped]);
    const env2 = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env2.run({ onlyNew: true });
    addMail(env2, [{ ...mk(1010, { daysAgo: 0 }), messageId: undefined }]);
    fs.mkdirSync(env2.boxDir(), { recursive: true });
    fs.writeFileSync(path.join(env2.boxDir(), '20200101_0900_1010_옛 메일.eml'), Buffer.from('Message-ID: <old@corp.invalid>\r\nSubject: old\r\n\r\nold\r\n', 'latin1'));
    const r2 = await env2.run({ onlyNew: true });
    ok(r2.saved === 1 && r2.skipped === 0, '…크기가 다르면 다른 메일로 보고 받는다', [r2.saved, r2.skipped]);
  }

  console.log('\n[21] saveOne·findSaved');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    const m = mk(1010, { daysAgo: 0 });
    const one = (o = {}) => mailbackup.saveOne(A, env.dir, { mailbox: 'INBOX', uid: 1010, receivedAt: m.date.getTime(), subject: m.subject, source: Buffer.from(m.raw, 'latin1'), ...o });
    const r = await one({ seen: true });
    await mailindex.flush(env.boxDir());
    const l = await mailindex.load(env.boxDir());
    const row = l.rows.get(1010);
    ok(r.saved === true && r.dir === env.boxDir(), '저장한다', r);
    ok(row.via === 'open' && row.seen === true && row.st === 'file' && row.at === m.date.getTime() && row.bytes === Buffer.byteLength(m.raw, 'latin1') && fs.existsSync(path.join(env.boxDir(), row.file)), '색인 줄을 쓴다', row);
    ok(l.meta && l.meta.uidValidity === String(V) && l.meta.user === A.user, '먼저 메타를 적는다', l.meta);
    ok((await one()).saved === false, '이미 있으면 다시 쓰지 않는다');
    const r2 = await mailbackup.saveOne(A, env.dir, { mailbox: 'INBOX', uid: 1011, receivedAt: m.date.getTime(), subject: 'x', source: Buffer.from('Subject: x\r\n\r\ny', 'latin1') });
    await mailindex.flush(env.boxDir());
    ok(r2.saved && (await mailindex.load(env.boxDir())).rows.get(1011).seen === null, 'seen 을 안 주면 모름(null)');

    const f = await mailbackup.findSaved(env.dir, A, 'INBOX', 1010);
    ok(f && f === mailbackup.savedFile(env.dir, A, 'INBOX', 1010) && fs.existsSync(f), 'findSaved 는 savedFile 과 같은 파일을 찾는다', path.basename(f));
    ok(await mailbackup.findSaved(env.dir, A, 'INBOX', '1010') === f, '글자 UID 도 받는다');
    ok(await mailbackup.findSaved(env.dir, A, 'INBOX', 9999) === null, '없으면 null');
    ok(await mailbackup.findSaved(env.dir, A, '없는폴더', 1010) === null, '폴더가 없으면 null');
    ok(await mailbackup.findSaved(env.dir, A, 'INBOX', 'abc') === null && await mailbackup.findSaved('', A, 'INBOX', 1010) === null, '잘못된 값이면 null');

    // 기록이 없는 폴더 — 메타 없는 색인이 생기면 세대를 못 올린다
    const r3 = await mailbackup.saveOne(A, env.dir, { mailbox: '업무', uid: 5, receivedAt: m.date.getTime(), subject: 'x', source: Buffer.from('Subject: x\r\n\r\ny', 'latin1') });
    await mailindex.flush(env.boxDir('업무'));
    ok(r3.saved && !fs.existsSync(path.join(env.boxDir('업무'), mailindex.INDEX_FILE)) && same(env.uids('업무'), [5]), '기록이 없는 폴더에는 색인 줄을 쓰지 않는다', env.uids('업무'));
  }

  console.log('\n[22] 소켓 제한');
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    const real = mail.connect;
    let opts = null;
    mail.connect = (acc, o) => { opts = o; return real(acc, o); };
    await env.run({ onlyNew: true });
    ok(opts && opts.timeoutMs === 90_000 && !opts.background, '90초 — 앞쪽 연결이다', opts);
  }

  console.log('\n[23] UIDVALIDITY 를 늘 안 주는 서버');
  for (const bad0 of ['undefined', '0']) {
    const env = setup([box('INBOX', [mk(1000), mk(1001)], { uidNext: 'auto', ...(bad0 === '0' ? { uidValidity: 0 } : { noUidValidity: true }) })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: bad0, gen: 1, lowUid: 1, lastUid: 1000, exists: 1 });
    const r = await env.run({ onlyNew: true });
    ok(same(r.boxErrors, []) && r.saved === 1 && same(env.uids(), [1001]), `기록도 "${bad0}" 이면 새 메일을 계속 저장한다`, r);
    ok(env.rec().gen === 1 && env.rec().uidValidity === bad0 && env.rec().lastUid === 1001 && r.genUp === false, '…세대가 안 오르고 위치만 오른다', env.rec());
    await mailindex.flush(env.boxDir());
    ok(!fs.existsSync(path.join(env.boxDir(), mailindex.INDEX_FILE)), '…색인·메타를 쓰지 않는다 — 세대를 가를 수 없는 폴더다');
  }
  {
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto', noUidValidity: true })]);
    const e = await thrownBy(env.run({ onlyNew: true }));
    ok(e && /UIDVALIDITY/.test(e.message) && !env.rec(), '기록이 없는 폴더는 폴더 오류 그대로 — 한 번 빠진 답과 가르지 못한다', e && e.message);
    const env2 = setup([box('INBOX', [mk(1000), mk(1001)], { uidNext: 'auto', noUidValidity: true })]);
    mailbackup.patchState(env2.dir, 'a1', 'INBOX', { uidValidity: 'undefined', gen: 1, lowUid: 1, lastUid: 1000 });
    env2.server.box('a1', 'INBOX').noUidValidity = false;
    const r = await env2.run({ onlyNew: true });
    ok(r.genUp === true && env2.rec().gen === 2 && env2.rec().uidValidity === String(V), '서버가 값을 주기 시작하면 세대를 올려 새로 시작한다', env2.rec());
    // 뒤 받기가 안 여는 폴더라 못 받은 수를 올리면 아무도 내리지 못하고, 다 받은 계정이 하루마다 할 일 없는 연결을 만든다
    const env3 = setup([box('INBOX', [mk(1000), mk(1001, { noSource: true })], { uidNext: 'auto', noUidValidity: true })]);
    mailbackup.patchState(env3.dir, 'a1', 'INBOX', { uidValidity: 'undefined', gen: 1, lowUid: 1, lastUid: 1000 });
    const r3 = await env3.run({ onlyNew: true });
    ok(r3.rejected === 1 && !env3.rec().fillFail, '못 받은 새 메일의 수를 그 폴더에 올리지 않는다', { rejected: r3.rejected, fillFail: env3.rec().fillFail });
  }

  console.log('\n[24] UID 간격이 크면');
  {
    const env = setup([box('INBOX', [mk(10), mk(5000), mk(9000), mk(15000)], { uidNext: 'auto' })]);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 9 });
    const r = await env.run({ onlyNew: true });
    ok(r.saved === 4 && env.sourceRanges().length === 1, '네 통이면 원문 FETCH 한 번 — 빈칸을 50칸씩 걷지 않는다', env.sourceRanges());
    ok(env.rec().lastUid === 15000, '…위치는 맨 위까지', env.rec().lastUid);
    const many = Array.from({ length: 120 }, (_, i) => mk(1000 + i * 1000));
    const env2 = setup([box('INBOX', many, { uidNext: 'auto' })]);
    mailbackup.patchState(env2.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 999 });
    const r2 = await env2.run({ onlyNew: true });
    ok(r2.saved === 120 && env2.sourceRanges().length === 3, '50통씩 묶는다', env2.sourceRanges());
    const env3 = setup([box('INBOX', [mk(10)], { uidNext: 5000 })]);
    mailbackup.patchState(env3.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 10 });
    await env3.run({ onlyNew: true });
    ok(env3.rec().lastUid === 4999 && env3.sourceRanges().length === 0, '검색 답이 비면 받지 않고 위치만 올린다', env3.rec().lastUid);
  }

  console.log('\n[25] 같은 UID 파일이 둘');
  {
    const env = setup([box('INBOX', [mk(25)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    fs.mkdirSync(env.boxDir(), { recursive: true });
    const old = path.join(env.boxDir(), '20200101_0900_25_a옛메일.eml');
    const fresh = path.join(env.boxDir(), '20260101_0900_25_z새메일.eml');
    fs.writeFileSync(old, 'Message-ID: <old@corp.invalid>\r\n\r\nold');
    fs.writeFileSync(fresh, 'Message-ID: <new@corp.invalid>\r\n\r\nnew');
    fs.utimesSync(old, new Date(Date.now() - DAY), new Date(Date.now() - DAY));
    ok(await mailbackup.findSaved(env.dir, A, 'INBOX', 25) === fresh, 'findSaved 는 나중에 받은 파일을 준다');
    ok(mailbackup.savedFile(env.dir, A, 'INBOX', 25) === fresh, 'savedFile 도 같다');
    fs.utimesSync(fresh, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    ok(await mailbackup.findSaved(env.dir, A, 'INBOX', 25) === old, '…이름순이 아니라 시각으로 고른다');
    ok(mailbackup.newestOf([]) === null, '없으면 null');
  }

  console.log('\n[26] 폴더 자리');
  {
    const dir = path.join(TMP, 'places');
    fs.mkdirSync(dir, { recursive: true });
    const base = (p, g = 1) => path.basename(mailbackup.boxDirFor(dir, A, p, g));
    ok(base('INBOX') === 'INBOX' && base('Work', 2) === 'Work (2)' && base('받은편지함') === '받은편지함', '보통 이름은 그대로', base('Work', 2));
    ok(!/[. ]$/.test(base('etc.')) && /^etc~/.test(base('etc.')), '끝의 점을 지우고 꼬리표를 붙인다 — 탐색기가 못 여는 자리에 저장하면 안 된다', base('etc.'));
    ok(!/[. ]$/.test(base('기타...')) && base('기타...') !== base('기타..'), '점이 여럿이어도 — 서로 다른 폴더는 다른 자리', [base('기타...'), base('기타..')]);
    ok(/^_CON~/.test(base('CON')) && /^_nul~/.test(base('nul')) && /^_COM1~/.test(base('COM1')) && /^_con\.txt~/.test(base('con.txt')), '예약 이름을 비킨다', [base('CON'), base('nul'), base('COM1'), base('con.txt')]);
    ok(base('Console') === 'Console' && base('COM') === 'COM', '예약 이름이 아니면 그대로', [base('Console'), base('COM')]);
    // 이미 받아 둔 폴더 — 자리를 옮기면 받은 파일이 안 보여 전부 다시 받는다
    const acc = path.dirname(mailbackup.boxDirFor(dir, A, 'INBOX'));
    const had = path.join(acc, 'old.');
    fs.mkdirSync(had, { recursive: true });
    ok(mailbackup.boxDirFor(dir, A, 'old.') === had, '옛 자리에 폴더가 있으면 그 자리를 쓴다', base('old.'));
  }

  console.log('\n[27] 대소문자만 다른 폴더');
  {
    const env = setup([box('Work', [mk(1000)], { uidNext: 'auto' }), box('WORK', [mk(1000)], { uidNext: 'auto' })]);
    await env.run({ onlyNew: true });
    ok(env.rec('Work').gen === 1 && env.rec('WORK').gen === 2, '새 기록은 세대를 나눈다', [env.rec('Work').gen, env.rec('WORK').gen]);
    const env2 = setup([box('WORK', [mk(1000)], { uidNext: 'auto' })]);
    await mailindex.ensureMeta(env2.boxDir('Work'), { box: 'Work', uidValidity: V, gen: 1 });
    await mailindex.flush(env2.boxDir('Work'));
    await env2.run({ onlyNew: true });
    ok(env2.rec('WORK').gen === 2, '상태 파일을 잃어도 메타의 폴더 이름으로 가른다', env2.rec('WORK').gen);
    const env3 = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    await mailindex.ensureMeta(env3.boxDir('Inbox'), { box: 'Inbox', uidValidity: V, gen: 1 });
    await mailindex.flush(env3.boxDir('Inbox'));
    await env3.run({ onlyNew: true });
    ok(env3.rec().gen === 1, 'INBOX 는 대소문자가 달라도 같은 폴더다', env3.rec().gen);
    // «백업 시작»은 표시 길(ensureBox)을 안 탄다 — 여기서 안 나누면 NTFS 의 한 폴더에 두 폴더의 같은 UID 가 섞인다
    const env4 = setup([box('Work', [mk(1000)], { uidNext: 'auto' }), box('WORK', [mk(1000, { tag: 'w' })], { uidNext: 'auto' })]);
    await env4.run({});
    ok(env4.rec('Work').gen === 1 && env4.rec('WORK').gen === 2 && same(env4.uids('WORK', 2), [1000]), '전체 받기도 세대를 나눈다', [env4.rec('Work').gen, env4.rec('WORK').gen]);
  }

  console.log('\n[28] 서버 기능 한 줄 (capsOf)');
  {
    // 이카운트형 — MOVE·UIDPLUS 없음. 서버가 이상한 토큰을 섞어도 한 줄에는 안 들어간다
    const env = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })], { caps: ['IMAP4rev1', 'AUTH=PLAIN', 'kim@corp.example', 'IDLE'] });
    const r = await env.run({ onlyNew: true, capsOf: mailmove.capsLine });
    ok(/^옮기기\(MOVE\) 없음 · UIDPLUS 없음 · /.test(r.caps || '') && /IMAP4rev1 AUTH=PLAIN IDLE/.test(r.caps || '') && !/@/.test(r.caps || ''),
      'MOVE·UIDPLUS 없음 — 주소 모양 토큰은 빠진다', r.caps);
    ok(env.server.clients.length === 1, '…연결은 저장하던 그 하나뿐이다', env.server.clients.length);
    const env2 = setup([box('INBOX', [mk(1000)], { uidNext: 'auto' })]);
    ok(/^옮기기\(MOVE\) 있음 · UIDPLUS 있음 · /.test((await env2.run({ onlyNew: true, capsOf: mailmove.capsLine })).caps || ''), '있으면 있음');
    ok((await env2.run({ onlyNew: true })).caps === undefined, '함수를 안 주면 비워 둔다');
    const r3 = await env2.run({ onlyNew: true, capsOf: () => { throw new Error('x'); } });
    ok(r3.caps === undefined && r3.mailboxes === 1, '한 줄을 못 만들어도 저장은 그대로 한다', r3.mailboxes);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

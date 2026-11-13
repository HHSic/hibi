'use strict';
// 지난 메일 뒤 받기 — 한 회차가 서버를 읽기만 하고, 어디서 끊겨도 잃지 않고, 끝났을 때만 끝났다고 적는가 (src/mailfill.js).
//
// 창도 Electron 도 쓰지 않는다 — main.js 를 싣지 않고, 가짜 IMAP(test/fixtures/fake-imap.js)과 임시 폴더로만 돈다.
// [25]만 진짜 imapflow 를 쓰되 127.0.0.1 의 말 없는 TCP 서버에만 붙는다. 진짜 메일 서버·자격 증명 관리자에는 가지 않는다.
// 가짜 계정 주소는 *.invalid 다. 쓰기 실패는 fs.promises 를 바꿔 끼워 흉내 낸다. 잠자기·긴 시간은 opts.now 로 시계를 밀어 흉내 낸다.
//   [1]  기록 없는 폴더 — 첫 본문 묶음에 맨 위 UID, 오름차순이 아님
//   [2]  머리가 본문보다 먼저, 머리 FETCH 수 상한, 머리 일감이 많아도 첫 회차에 .eml 이 생김 (몫의 1/3)
//   [3]  전 폴더 readOnly, FORBIDDEN 0, 플래그 불변, 연결의 금지 메서드는 던짐
//   [4]  듬성한 UID 에서 FETCH 수가 통수에 비례
//   [5]  있는 파일을 다시 안 받음, lowUid 위쪽에 빠진 메일도 되찾음
//   [6]  signal('yield') — why:'yield', 걸린 FETCH 가 곧 끝남, fails 안 오름. 비킴으로 끊긴 한 통은 몇 번이어도 실패가 아니고, 하루가 넘게 못 받으면 st:fail
//   [7]  시간 몫 — why:'budget', 여러 판에 나눠도 유실·중복 0. 짧은 몫의 late 와 잠자기 흔적은 fails 를 안 올림
//   [8]  3~14 명령마다 끊겨도 완주, 재수신 0
//   [9]  fetchNo 독 메일 — 나머지 저장, 3회 뒤 안 부름, memo.retried 가 비면 다시 부름, 다시 불러도 isDone 불변
//   [10] noSource·noRow(본문) — 실패 기록, 거짓 완료 없음, 영구 대기 없음
//   [11] 끊김 시 memo.chunk 절반, 성공 시 회복, 끊긴 한 통짜는 fails+1
//   [12] 폴더 실패 격리, 폴더 차례, 공유·스팸·휴지통 제외, mineOf 가 null 이면 받은편지함만
//   [13] 공유 폴더 기록이 상태에 있어도 isDone 이 참 (fillSkip)
//   [14] UIDVALIDITY 변경 — 세대 오름, fill* 칸 사라짐, 다시 받음, genUp. noUidValidity — 폴더 오류, 세대 안 오름, 칸 유지
//   [15] 100MB 초과 big, 8MB 초과는 작은 메일 뒤
//   [16] \All — 상대 줄이 st:file 이고 파일이 있으면 dup, mid 없으면 받음, 상대가 head·fail·big 이면 받음. 상대 파일이 사라지면 st:head 로 돌아감
//   [17] 공간 — 부족하면 why:'disk'·본문 0, 전 폴더 머리 뒤 leftBytes 가 넘으면 본문 전에 멈추고 need, minFree 주입이 바닥
//   [18] 쓰기 실패 — 프로브 실패면 why:'write'·fails 그대로, 통과면 그 UID 만 fails+1, 3번이면 st:fail, ENOSPC 는 disk, rename EBUSY 뒤 재수신 0
//   [19] patchState 동시 호출과 자동 저장이 겹쳐도 기록 유지, 세대가 바뀐 뒤 옛 회차의 패치는 버림, .part 는 서로 안 밟음
//   [20] 파일 이름 시각이 INTERNALDATE
//   [21] 뒤 받기 뒤 mailtidy.tidyAll dryRun 수가 0 → n
//   [22] 뒤 받기 뒤 mailfwd 엔진이 같은 가짜 SMTP 로 0통
//   [23] 소스 검사 — store·mailhub·autofwd·mailrules·mailtally·electron require 없음
//   [24] mail.connect(진짜 함수, 연결은 안 함) — 훅·frontState·okAt·5분 만료, rowOf 가 옛 collect 칸과 같음, 문자열 날짜에 안 던짐
//   [25] 연결 중 끊기 — 진짜 imapflow + 말 없는 TCP 서버. yield·budget 이 제한 안에 끝남. mailtidy·mailfwd 도 같은 함수
//   [26] headNo — 자리표와 hf, hf 3이면 fillHead 가 서고 본문이 받음, 받기 전에는 isDone 거짓
//   [27] noRow(머리) — 오류 없이 끝나도 hf+1, «모두 받음»이 안 됨
//   [28] 색인 쓰기 실패 — fillHead·lowUid:1 을 안 씀, 회복하면 완주, 세대 폴더가 없어도 머리 줄이 써짐
//   [29] badDate(머리) — 안 던짐, 그 아래 메일도 머리를 받음. notify — uid 없는 줄이 색인·fails 에 안 들어감
//   [30] searchShort 등 믿을 수 없는 답 — 폴더 오류, fillHead·srv 안 씀, 정상 답이 돌아오면 완주. 끊겨서 온 false 는 회차 끝
//   [31] confirmBox — 한 번 없으면 srv 안 씀, 10분 뒤 두 번째면 씀, 다시 보이면 지움, 맨 위보다 큰 줄은 판정 안 함
//   [32] 파일 확인 — 같은 UID 에 다른 메일이면 file 을 안 채우고 받음, 0으로 찬 파일은 .damaged 로 돌리고 받음, 옛 파일(bytes 없음)도 같음
//   [33] 회차 명령 수 — 회차 앞 명령이 connect + 일감 폴더 EXAMINE 뿐, 끝난 폴더는 0, LIST 는 1시간에 한 번, setupMs
//   [34] 큰 메일 — 속도로 봐 몫이 모자라면 다음 통으로, 남은 일이 그뿐이면 몫을 늘려 시작, 속도를 모르면 몫 전부일 때만
//   [35] 인증 판정 — AUTHENTICATIONFAILED 는 auth, UNAVAILABLE 은 refused, 끊은 것은 먼저 본다
//   [36] countPending·allBelow·isDone·searchOk·scanAccount (폴더 mtime 이 색인보다 오래됐으면 읽지 않음 — mailindex 시험에서 넘어온 줄)
//   [37] 몫 안에 못 받는 메일 — 실제 몫 240초를 그대로 주고 시계를 200배로 돌린다. 묶음을 가르고, 몫을 늘려 보고, 3번이면 st:fail
//   [38] 닫힌 연결의 FETCH — 줄 없이 끝나도 fails·hf 를 안 올림
//   [39] \All 의 dup 고리 — 끊기를 듣고, 줄마다 상태 파일을 안 읽음
//   [40] UIDNEXT 없는 서버의 빈 답 — lowUid 를 안 내림, fillLeft 가 남으면 isDone 거짓
//   [41] 다 받은 계정의 거절된 새 메일 — fillFail 이 올라 뒤 받기가 다시 본다
//   [42] 빈 답 — 메일이 있던 폴더는 EXISTS 0 한 번으로 완료를 안 적음, 10분 뒤 두 번째면 적음, 사이에 메일이 보이면 처음부터, 앱을 다시 켜도 이어짐, 다른 길로도 isDone 이 안 됨
//   [43] 자동 yes 는 파일을 본다 — exists 의 90% 파일이 그 세대 폴더에 있어야 참. 어느 폴더든 빈 답 확인(fillEmptyAt)이 남았으면 거짓
//   [44] UIDVALIDITY 를 늘 안 주는 폴더 — 뒤 받기가 건너뜀, 폴더 오류가 아님, 남은 수·완료 판정에서 빠짐, 옛 파일 스캔도 안 함
//   [45] ENVELOPE 에 Message-ID 가 없는 서버 — 받아 둔 메일을 다시 안 받음, 줄의 값을 안 덮음, 크기로 파일을 가림
//   [46] 끊겨서 아무것도 못 받은 회차 — noGain, setupMs 를 배움. 멈추기·받다가 비킴은 아님
//   [47] 다 받은 계정의 재시도가 폴더 오류로 끝나면 그날 몫을 쓴 것이다
//   [48] SEARCH ALL 이 EXISTS 보다 늘 조금 적은 서버 — 10분 넘게 떨어진 같은 두 답이면 믿음, 수가 바뀌면 처음부터, 부족분이 크면 안 믿음
//   [49] 맨 위 UID 가 지워짐 — 답의 수가 EXISTS 와 맞으면 그 줄도 두 번 확인
//   [50] 전에 끊긴 메일끼리 차례로 시도
//   [51] 대소문자만 다른 폴더 — 세대를 나눠 둘 다 받음
//   [52] 계정 전체의 거절(하루 한도·속도 제한) — 한 통씩 다시 받지 않고 회차를 그 까닭과 함께 끝냄. 메일 한 통의 거절은 지금처럼
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src', 'mail.js'));
const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
const mailindex = require(path.join(ROOT, 'src', 'mailindex.js'));
const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
const mailfwd = require(path.join(ROOT, 'src', 'mailfwd.js'));
const mailfill = require(path.join(ROOT, 'src', 'mailfill.js'));
const { makeServer } = require(path.join(__dirname, 'fixtures', 'fake-imap.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 300_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailfill-'));
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const DAY = 86_400_000;
const V = 1700000000n;   // 서버 UIDVALIDITY (imapflow 는 BigInt 로 준다)
const A = { id: 'a1', name: '회사', user: 'kim@corp.invalid', host: 'imap.corp.invalid', port: 993 };
const PLENTY = 1e13;
const realConnect = mail.connect;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asc = (x, y) => x - y;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 메일 한 통 — tag 가 같으면 UID 가 달라도 같은 메일이다. id:null 이면 Message-ID 가 없다 */
function mk(uid, o = {}) {
  const date = o.date || new Date(NOW - (o.daysAgo == null ? 60 : o.daysAgo) * DAY);
  const tag = o.tag || uid;
  const id = o.id === undefined ? `m${tag}@corp.invalid` : o.id;
  const subject = `report ${tag}`;
  const raw = [
    id ? `Message-ID: <${id}>` : null,
    `Date: ${(o.hdrDate || date).toUTCString()}`,
    'From: Kim <kim@corp.invalid>',
    'To: lee@corp.invalid',
    `Subject: ${subject}`,
    'MIME-Version: 1.0'
  ].filter(Boolean).join('\r\n') + `\r\n\r\nbody of ${tag}\r\n`;
  const { daysAgo, tag: _t, id: _i, seen, hdrDate, date: _d, ...rest } = o;
  return {
    uid, raw, date, subject, messageId: id ? `<${id}>` : undefined,
    from: [{ name: 'Kim', address: 'kim@corp.invalid' }], to: [{ name: '', address: 'lee@corp.invalid' }],
    flags: seen ? ['\\Seen'] : [], ...rest
  };
}
const mks = (n, from = 1000, step = 1, o = {}) => Array.from({ length: n }, (_, i) => mk(from + i * step, o));
const box = (p, msgs, extra = {}) => ({ path: p, uidValidity: V, uidNext: 'auto', msgs, ...extra });

let seq = 0;
/** 가짜 서버 + 빈 백업 폴더. 회차 사이의 기억(memo)은 한 벌을 돌려 쓴다 — 앱이 켜져 있는 동안과 같다 */
function setup(boxes, acct = {}) {
  const dir = path.join(TMP, `f${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const server = makeServer({ a1: { boxes, ...acct } });
  const env = {
    dir,
    server,
    memo: {},
    sb: (p = 'INBOX') => server.box('a1', p),
    connect: (a) => server.connect(a),
    run: (o = {}) => mailfill.fillAccount(A, dir, { connect: env.connect, memo: env.memo, freeBytes: async () => PLENTY, ...o }),
    rec: (p = 'INBOX') => (mailbackup.loadState(dir)[mailbackup.accountKey(A)] || {})[p],
    boxDir: (p = 'INBOX', gen = 1) => mailbackup.boxDirFor(dir, A, p, gen),
    rows: async (p = 'INBOX', gen = 1) => {
      await mailindex.flush(env.boxDir(p, gen));
      return (await mailindex.load(env.boxDir(p, gen))).rows;
    },
    files: (p = 'INBOX', gen = 1) => [...mailbackup.uidsIn(env.boxDir(p, gen))].sort(asc),
    bodies: (from = 0) => server.log.slice(from).filter((e) => e.cmd === 'fetch' && e.query && e.query.source),
    heads: (from = 0) => server.log.slice(from).filter((e) => e.cmd === 'fetch' && e.query && !e.query.source && e.query.envelope),
    opens: (from = 0) => server.log.slice(from).filter((e) => e.cmd === 'mailboxOpen'),
    clean: () => server.forbidden().length === 0 && server.log.filter((e) => e.cmd === 'mailboxOpen').every((e) => e.readOnly),
    done: () => mailfill.isDone(A, dir)
  };
  return env;
}
const uidsOf = (list) => list.flatMap((e) => (Array.isArray(e.range) ? e.range : [e.range]));
/** 머리만 받는 회차 — 공간이 모자라 본문 전에 멈춘다. 그 뒤로 본문 단계를 따로 시험한다 */
const headsOnly = (env) => env.run({ freeBytes: async () => 0 });
/** 끝날 때까지 돌린다 */
async function drive(env, o = {}, limit = 40) {
  let r;
  for (let i = 0; i < limit; i++) {
    r = await env.run(o);
    if (r.done) break;
  }
  return r;
}
/** 연결을 만들 때마다 손을 댄다 — 가짜 서버에 없는 고장을 흉내 낸다 */
const withClient = (env, fn) => (a) => { const c = env.server.connect(a); fn(c); return c; };
const failOpen = (env, name) => withClient(env, (c) => {
  const open = c.mailboxOpen.bind(c);
  c.mailboxOpen = async (p, o) => {
    if (p === name) throw Object.assign(new Error('Command failed'), { responseStatus: 'NO' });
    return open(p, o);
  };
});
/** FETCH 가 시작되는 순간에 일을 시킨다 */
const onFetch = (env, fn) => withClient(env, (c) => {
  const fetch = c.fetch.bind(c);
  c.fetch = (r, q, o) => { fn(c, r, q); return fetch(r, q, o); };
});
/** 서버가 주는 크기만 부풀린다 — 진짜 100MB 를 만들지 않는다 */
const sized = (env, sizes) => withClient(env, (c) => {
  const fetch = c.fetch.bind(c);
  c.fetch = async function* inflate(r, q, o) {
    for await (const m of fetch(r, q, o)) {
      if (m && m.size != null && sizes[m.uid] != null) m.size = sizes[m.uid];
      yield m;
    }
  };
});
/** 원문이 몇 번 왔나 — 재수신을 잰다 */
const counting = (env, seen) => withClient(env, (c) => {
  const fetch = c.fetch.bind(c);
  c.fetch = async function* count(r, q, o) {
    for await (const m of fetch(r, q, o)) {
      if (m && m.source) seen.set(m.uid, (seen.get(m.uid) || 0) + 1);
      yield m;
    }
  };
});
/** 그 메일의 줄을 내기 전에 오래 기다리는 서버 (ms: UID → 실제 ms). 가짜 서버는 오름차순으로 답한다. 끊으면 _wait 가 던진다. sizes 는 서버가 말하는 크기 */
const slowMail = (env, ms, sizes = {}) => withClient(env, (c) => {
  const fetch = c.fetch.bind(c);
  c.fetch = async function* slow(r, q, o) {
    for await (const m of fetch(r, q, o)) {
      if (q.source && ms[m.uid]) await c._wait(ms[m.uid]);
      if (m && m.size != null && sizes[m.uid] != null) m.size = sizes[m.uid];
      yield m;
    }
  };
});
const stampOf = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
const putFile = async (env, msg, p = 'INBOX') => {
  await fs.promises.mkdir(env.boxDir(p), { recursive: true });
  return mailbackup.commit(env.boxDir(p), { uid: msg.uid, receivedAt: msg.date, subject: msg.subject, source: Buffer.from(msg.raw, 'latin1') });
};

(async () => {
  console.log('\n[1] 기록 없는 폴더 — 맨 위부터');
  {
    const msgs = mks(35, 1000, 3);
    const top = 1000 + 34 * 3;
    const env = setup([box('INBOX', msgs)]);
    const r = await env.run();
    const first = (env.bodies()[0] || { range: [] }).range;
    ok(first.includes(top), '첫 본문 묶음에 맨 위 UID 가 있다', first);
    ok(first.every((u, i) => i === 0 || u < first[i - 1]), '…묶음은 내림차순이다');
    ok((env.bodies()[1] || { range: [Infinity] }).range[0] < first[first.length - 1], '…다음 묶음은 그 아래다');
    ok(r.why === 'done' && r.done && r.saved === 35 && r.left === 0, '끝까지 받고 끝났다고 말한다', { why: r.why, saved: r.saved, left: r.left });
    ok(env.files().length === 35, '파일 35개', env.files().length);
    const rec = env.rec();
    ok(rec.lowUid === 1 && rec.fillHead === true && rec.fillLeft === 0 && rec.fillFail === 0 && rec.lastUid === top && rec.exists === 35, '기록', rec);
    const row = (await env.rows()).get(top);
    ok(!!row && row.st === 'file' && row.via === 'fill' && row.seen === false && row.size > 0 && row.bytes === row.size && row.mid === `<m${top}@corp.invalid>` && row.at === msgs[34].date.getTime(), '색인 줄', row);
    const text = fs.readFileSync(path.join(env.boxDir(), mailindex.INDEX_FILE), 'utf8');
    ok(!/"pass"|password/i.test(text) && text.includes('"meta":1'), '색인에 메타가 있고 비밀번호 칸이 없다');

    // UID 1번까지 받아도 lowUid:1 은 confirmBox 만 적는다 — fillHead 와 만나면 곧 «다 받음»이다
    const low = setup([box('INBOX', mks(5, 1))]);
    let saved = 0;
    const r2 = await low.run({ onProgress: (p) => { saved = p.saved; }, shouldStop: () => saved >= 5 });
    ok(r2.why === 'stop' && low.rec().lowUid === 2 && !low.done(), 'UID 1번을 받아도 lowUid:1 을 안 적는다', low.rec().lowUid);
    const r3 = await low.run();
    ok(r3.done && low.rec().lowUid === 1, '…확인을 돈 뒤에 적는다', low.rec().lowUid);
  }

  console.log('\n[2] 머리가 먼저, 몫의 1/3');
  {
    const env = setup([box('INBOX', mks(250))]);
    await env.run();
    const log = env.server.log;
    const firstBody = log.findIndex((e) => e.cmd === 'fetch' && e.query.source);
    const lastHead = log.map((e, i) => (e.cmd === 'fetch' && !e.query.source ? i : -1)).reduce((x, y) => Math.max(x, y), -1);
    ok(lastHead >= 0 && lastHead < firstBody, '머리 FETCH 가 모두 본문보다 먼저다', { lastHead, firstBody });
    ok(env.heads().length === 3, '머리 FETCH 는 250통에 3번이다', env.heads().length);
    ok(env.heads()[0].range.length === 100 && env.heads()[0].range[0] === 1249, '…100통씩 내림차순으로', env.heads()[0].range[0]);

    // 머리 FETCH 20번이 몫을 넘게 잡는다 — 몫의 1/3 제한이 없으면 첫 회차에 .eml 이 하나도 안 생긴다.
    // 실제 시간으로 재면 부하에 흔들리므로 머리 FETCH 마다 시계를 민다
    const big = setup([box('INBOX', mks(2000))]);
    let clock = NOW;
    let bigSaved = 0;
    const r = await big.run({
      budgetMs: 700_000, now: () => clock,
      connect: onFetch(big, (c, u, q) => { if (!q.source) clock += 100_000; }),
      onProgress: (p) => { bigSaved = p.saved; }, shouldStop: () => bigSaved >= 10
    });
    ok(big.heads().length < 20, '머리를 다 받기 전에 본문으로 넘어간다', big.heads().length);
    ok(big.files().length > 0 && r.saved === big.files().length, '…첫 회차에 .eml 이 생긴다', big.files().length);
    ok(big.files().includes(2999), '…맨 위 메일부터', big.files().slice(-3));
    ok(big.rec().fillHead === undefined, '…fillHead 는 아직이다');
    ok(big.rec().fillLeft > 0, '…통수는 검색 직후부터 보인다', big.rec().fillLeft);

    // 자리표 고리가 동기면 쓰기가 끼어들지 못해 버퍼 상한(5,000줄)이 멀쩡한 줄을 버린다
    const huge = setup([box('INBOX', mks(12000))]);
    await huge.run({ budgetMs: 120_000, freeBytes: async () => 0, shouldStop: () => (huge.rec() || {}).fillLeft > 0 });
    ok((await huge.rows()).size === 12000 && huge.rec().fillLeft === 12000, '5,000통 넘는 폴더의 첫 자리표도 다 써진다', (await huge.rows()).size);
  }

  console.log('\n[3] 서버는 읽기만');
  {
    const inbox = mks(12).map((m, i) => ({ ...m, flags: i % 2 ? ['\\Seen'] : [] }));
    const env = setup([box('INBOX', inbox), box('Sent', mks(5, 2000), { specialUse: '\\Sent' }), box('Archive', mks(5, 3000))]);
    const flags = () => JSON.stringify(['INBOX', 'Sent', 'Archive'].map((p) => env.sb(p).msgs.map((m) => [...m.flags])));
    const before = flags();
    let made;
    const r = await env.run({ connect: withClient(env, (c) => { made = c; }) });
    ok(r.done && r.saved === 22, '다 받았다', r.saved);
    ok(env.opens().length >= 3 && env.opens().every((e) => e.readOnly), '전 폴더 readOnly', env.opens().map((e) => [e.path, e.readOnly]));
    ok(env.server.forbidden().length === 0, 'FORBIDDEN 0');
    ok(flags() === before, '플래그 불변');
    const threw = [];
    for (const k of mailfill.FORBIDDEN) {
      try { await made[k](); threw.push(`${k}:안 던짐`); } catch (e) { if (!/뒤 받기는/.test(e.message)) threw.push(`${k}:${e.message}`); }
    }
    ok(!threw.length && mailfill.FORBIDDEN.includes('messageMove') && env.server.forbidden().length === 0, '연결의 금지 메서드는 던지고 서버까지 안 간다', threw);
    ok(env.bodies().every((e) => e.query.markSeen === undefined), '원문을 달라는 FETCH 에 markSeen 이 없다 (BODY.PEEK)');
    ok(fs.readFileSync(require.resolve('imapflow/lib/commands/fetch.js'), 'utf8').includes('.PEEK'), '…imapflow 는 source 를 PEEK 로 받는다');
    const rows = await env.rows();
    ok(rows.get(1001).seen === true && rows.get(1000).seen === false, '읽음은 색인에만 적는다');
  }

  console.log('\n[4] 듬성한 UID');
  {
    const env = setup([box('INBOX', mks(200, 1000, 500))]);
    const r = await env.run();
    ok(r.done && r.saved === 200, '200통', r.saved);
    ok(env.bodies().length === 20, '본문 FETCH 는 통수에 비례한다 (UID 폭 100,000)', env.bodies().length);
    ok(env.heads().length === 2, '머리 FETCH 2번', env.heads().length);
  }

  console.log('\n[5] 있는 파일, 빠진 메일');
  {
    const msgs = mks(21);       // 1000..1020
    const env = setup([box('INBOX', msgs)]);
    for (const m of msgs) if (m.uid >= 1010 && m.uid !== 1015) await putFile(env, m);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1010, lastUid: 1020, exists: 21 });
    const r = await env.run();
    const got = uidsOf(env.bodies()).sort(asc);
    ok(same(got, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1015]), '있는 파일은 다시 안 받고, 옛 경로가 놓친 1015 를 되찾는다', got);
    ok(r.done && env.files().length === 21, '다 있다', env.files().length);
    const rows = await env.rows();
    ok(rows.get(1012).st === 'file' && rows.get(1012).via === 'scan' && rows.get(1012).seen === false, '스캔 줄의 읽음은 머리로 채운다', rows.get(1012));

    // 옛 «백업 시작» 기록(lowUid:1) — 머리가 끝났다고 곧 완료로 읽히면 빠진 메일을 영영 안 받는다
    const list = mks(20);
    const old = setup([box('INBOX', list)]);
    for (const m of list) if (m.uid !== 1003) await putFile(old, m);
    mailbackup.patchState(old.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1019, exists: 20 });
    ok(mailfill.allBelow(A, old.dir), '준비 — allBelow');
    const h = await headsOnly(old);
    ok(h.why === 'disk' && old.rec().fillHead === true && old.rec().lowUid > 1 && !old.done(), 'lowUid:1 인 옛 기록도 머리 뒤에 완료로 읽히지 않는다', old.rec().lowUid);
    const oldRows = await old.rows();
    ok(oldRows.get(1002).st === 'file' && !!oldRows.get(1002).file && oldRows.get(1002).seen === false && old.rec().fillLeft === 1, '머리 줄이 이미 저장된 줄의 파일 칸을 지우지 않는다', [oldRows.get(1002).st, old.rec().fillLeft]);
    const r2 = await old.run();
    ok(r2.done && same(uidsOf(old.bodies()), [1003]) && old.rec().lowUid === 1, '…빠진 메일을 받은 뒤에 끝난다', uidsOf(old.bodies()));
  }

  console.log('\n[6] 비킴');
  {
    const env = setup([box('INBOX', mks(3))]);
    const h = await headsOnly(env);
    ok(h.why === 'disk' && env.rec().fillHead === true, '준비 — 머리만', h.why);
    env.server.spec.a1.delay = { fetch: 5000 };
    env.memo.chunk = 1;
    let ctl = new AbortController();
    let t0 = Date.now();
    let r = await env.run({ signal: ctl.signal, connect: onFetch(env, () => { setTimeout(() => ctl.abort('yield'), 30); }) });
    ok(r.why === 'yield' && !r.error, "why:'yield'", r.why);
    ok(Date.now() - t0 < 2000, '걸린 FETCH 가 곧 끝난다', Date.now() - t0);
    ok((await env.rows()).get(1002).fails === undefined, 'fails 안 오름');
    ok(env.server.clients.every((c) => c.closed || c.loggedOut), '연결이 닫혔다');

    ok(env.memo.cuts.size === 0 && env.memo.chunk === 1, '잠깐 전에 부른 줄이 끊긴 것은 메일 탓이 아니다', env.memo.cuts.size);

    // 폴링이 먼저 끊은 메일은 탓하지 않는다 — 건강한 메일도 첫 줄이 창보다 늦으면 3번 만에 st:fail 이 된다. 뒤로 돌려 대기열은 막지 않고, 하루가 넘게 못 받으면 st:fail 이다
    const slow = setup([box('INBOX', mks(3))]);
    await headsOnly(slow);
    slow.memo.chunk = 1;
    const cutOnce = async (base6 = 0) => {
      const c6 = new AbortController();
      let off = base6;
      const base = slowMail(slow, { 1002: 5000 });
      return slow.run({
        signal: c6.signal, now: () => Date.now() + off,
        connect: (a) => {
          const c = base(a);
          const fetch = c.fetch.bind(c);
          c.fetch = (u, q, o) => {
            if (u.includes(1002)) { off = base6 + 60_000; setTimeout(() => c6.abort('yield'), 30); }
            return fetch(u, q, o);
          };
          return c;
        }
      });
    };
    r = await cutOnce();
    let row6 = (await slow.rows()).get(1002);
    ok(r.why === 'yield' && slow.memo.cuts.size === 1 && row6.st === 'head' && row6.fails === undefined, '한 번 끊겼다고 실패로 적지는 않는다', row6.fails);
    await cutOnce();
    r = await cutOnce();
    row6 = (await slow.rows()).get(1002);
    ok(r.why === 'yield' && row6.st === 'head' && row6.fails === undefined, '3번 끊겨도 실패가 아니다 — 폴링이 끊었다', { st: row6.st, fails: row6.fails });
    r = await cutOnce(DAY + 1000);
    row6 = (await slow.rows()).get(1002);
    ok(r.why === 'yield' && row6.st === 'fail' && row6.fails === mailfill.STRIKES, '…하루가 넘도록 못 받으면 st:fail', { st: row6.st, fails: row6.fails });
    ok(slow.files().includes(1001) && slow.files().includes(1000), '…그 사이 다른 메일은 받았다', slow.files());

    // 여러 통 묶음은 어느 메일 탓인지 모른다 — 세지 않고 묶음을 가른다
    const many = setup([box('INBOX', mks(6))]);
    await headsOnly(many);
    many.memo.chunk = 6;
    many.server.spec.a1.delay = { fetch: 5000 };
    ctl = new AbortController();
    let off2 = 0;
    r = await many.run({
      signal: ctl.signal, now: () => Date.now() + off2,
      connect: onFetch(many, () => { off2 = 60_000; setTimeout(() => ctl.abort('yield'), 30); })
    });
    const rows = await many.rows();
    ok(r.why === 'yield' && [...rows.values()].every((x) => x.fails === undefined) && many.memo.cuts.size === 0, '여러 통 묶음은 안 센다', many.memo.cuts.size);
    ok(many.memo.chunk === 3, '…묶음을 가른다', many.memo.chunk);
  }

  console.log('\n[7] 시간 몫');
  {
    const env = setup([box('INBOX', mks(170))], { delay: { fetch: 15 } });
    const seen = new Map();
    let turns = 0;
    let r;
    const whys = new Set();
    while (turns < 300) {
      turns += 1;
      r = await env.run({ budgetMs: 150, connect: counting(env, seen) });
      whys.add(r.why);
      if (r.done) break;
    }
    ok(r.done && env.files().length === 170, `${turns}판에 나눠 170통 — 유실 0`, env.files().length);
    ok(turns >= 5 && whys.has('budget'), "여러 판이었고 why:'budget' 이 있었다", [turns, [...whys]]);
    ok(Math.max(...seen.values()) === 1, '중복 0', Math.max(...seen.values()));
    const rows = await env.rows();
    ok([...rows.values()].every((x) => x.fails === undefined), '몫 끝은 실패가 아니다');

    // 짧은 몫 — 한 통짜도 안 센다
    const one = setup([box('INBOX', mks(2))]);
    await headsOnly(one);
    one.server.spec.a1.delay = { fetch: 5000 };
    one.memo.chunk = 1;
    r = await one.run({ budgetMs: 80 });
    ok(r.why === 'budget' && (await one.rows()).get(1001).fails === undefined, "짧은 몫의 late 는 fails 를 안 올린다", r.why);

    ok(one.memo.cuts.size === 0, '…끊긴 횟수도 안 센다', one.memo.cuts.size);

    // 잠자기 흔적 — 경과 시간이 몫+30초를 넘었다. 타이머가 제때 못 깬 회차다
    let off = 0;
    r = await one.run({ budgetMs: 80, now: () => Date.now() + off, connect: onFetch(one, () => { off = 241_000; }) });
    ok(r.why === 'budget' && (await one.rows()).get(1001).fails === undefined && one.memo.cuts.size === 0, '잠자기 흔적도 안 올린다', r.why);
  }

  console.log('\n[8] 3~14 명령마다 끊김');
  {
    const env = setup([box('INBOX', mks(300)), box('Sent', mks(40, 2000), { specialUse: '\\Sent' })]);
    const seen = new Map();
    let x = 7;
    const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
    let turns = 0;
    let r = { done: false };
    let cuts = 0;
    while (!r.done && turns < 800) {
      turns += 1;
      const limit = 3 + Math.floor(rnd() * 12);
      const n0 = env.server.log.length;
      let current = null;
      const timer = setInterval(() => {
        if (current && !current.closed && env.server.log.length - n0 > limit) {
          cuts += 1;
          current.close();
        }
      }, 0);
      const count = counting(env, seen);
      r = await env.run({ connect: (a) => { current = count(a); return current; } });
      clearInterval(timer);
    }
    ok(r.done && env.files().length === 300 && env.files('Sent').length === 40, `${turns}판, 끊김 ${cuts}번에도 완주`, [env.files().length, env.files('Sent').length]);
    ok(cuts > 3, '정말 끊겼다', cuts);
    ok(Math.max(...seen.values()) === 1 && seen.size === 340, '재수신 0', [Math.max(...seen.values()), seen.size]);
    ok(env.clean(), '끊겨도 쓰기 명령 0');
    const rows = await env.rows();
    ok([...rows.values()].every((row) => row.st === 'file'), '실패로 남은 줄 없음');
    ok(!fs.readdirSync(env.boxDir()).some((n) => n.endsWith('.part')), '.part 가 남지 않았다');
  }

  console.log('\n[9] fetchNo 독 메일');
  {
    const msgs = mks(30);
    msgs[20].fetchNo = true;
    const poison = msgs[20].uid;
    const env = setup([box('INBOX', msgs)]);
    let r = await env.run();
    ok(env.files().length === 29 && !env.files().includes(poison), '나머지는 다 받았다', env.files().length);
    let row = (await env.rows()).get(poison);
    ok(row.fails === 1 && row.st === 'head' && !r.done, '독 메일은 fails 1, 끝나지 않았다', row.fails);
    ok(env.rec().lowUid > poison, 'lowUid 는 그 위까지만 내려간다', env.rec().lowUid);
    r = await env.run();
    row = (await env.rows()).get(poison);
    ok(row.fails === 2 && !r.done, '다음 판 fails 2', row.fails);
    ok(uidsOf(env.bodies()).filter((u) => u === poison).length >= 2, '…그 메일만 다시 부른다');
    r = await env.run();
    row = (await env.rows()).get(poison);
    ok(row.fails === 3 && row.st === 'fail' && r.done && r.failed === 1 && r.why === 'done', '3번이면 st:fail, 폴더는 끝난다', { fails: row.fails, st: row.st, why: r.why, failed: r.failed });
    ok(env.rec().lowUid === 1 && env.rec().fillFail === 1, 'fillFail 1', env.rec().fillFail);

    const conns = env.server.clients.length;
    const mark = env.server.log.length;
    r = await env.run();
    ok(env.bodies(mark).length === 0 && env.server.clients.length === conns && r.why === 'done', '3회 뒤 안 부른다 — 연결도 안 만든다', env.server.clients.length - conns);

    env.memo.retried.clear();
    const mark2 = env.server.log.length;
    ok(env.done(), '다시 부르기 전 isDone 참');
    r = await env.run();
    row = (await env.rows()).get(poison);
    ok(same(uidsOf(env.bodies(mark2)), [poison]) && row.fails === 4 && row.st === 'fail', 'memo.retried 가 비면 다시 부른다', uidsOf(env.bodies(mark2)));
    ok(env.done() && r.done, '다시 불러도 isDone 이 안 바뀐다');
    const mark3 = env.server.log.length;
    await env.run();
    ok(env.bodies(mark3).length === 0, '…그 뒤로는 또 안 부른다');

    // 하루가 지나면 다시 부른다 — 이번에는 서버가 준다
    env.sb().msgs.find((m) => m.uid === poison).fetchNo = false;
    r = await env.run({ now: () => Date.now() + mailfill.RETRY_FAIL_MS + 1 });
    row = (await env.rows()).get(poison);
    ok(row.st === 'file' && env.files().length === 30 && r.done && env.rec().fillFail === 0, '24시간 뒤 다시 불러 받는다', row.st);

    // 앱 재시작(memo 비움)
    const again = setup([box('INBOX', mks(3).map((m, i) => (i === 1 ? { ...m, fetchNo: true } : m)))]);
    await drive(again);
    const before = again.server.clients.length;
    again.memo = {};
    await again.run();
    ok(again.server.clients.length === before + 1 && again.done(), '앱을 다시 켜면 한 번 다시 부른다', again.server.clients.length - before);
  }

  console.log('\n[10] noSource · noRow(본문)');
  {
    const msgs = mks(12);
    msgs[5].noSource = true;
    const env = setup([box('INBOX', msgs)]);
    let r = await env.run();
    ok(!r.done && (await env.rows()).get(1005).fails === 1, 'noSource — 실패를 적고 끝났다고 안 한다', r.why);
    r = await drive(env);
    const row = (await env.rows()).get(1005);
    ok(r.done && row.st === 'fail' && !env.files().includes(1005) && env.files().length === 11, '…3번이면 st:fail 로 끝난다 (영구 대기 없음)', row);

    const env2 = setup([box('INBOX', mks(12))]);
    await headsOnly(env2);
    env2.sb().msgs.find((m) => m.uid === 1007).noRow = true;
    r = await env2.run();
    ok(!r.done && (await env2.rows()).get(1007).fails === 1, 'noRow(본문) — 오류 없이 지나가도 센다', (await env2.rows()).get(1007).fails);
    ok(env2.files().length === 11, '…나머지는 저장', env2.files().length);
    r = await drive(env2);
    ok(r.done && (await env2.rows()).get(1007).st === 'fail' && r.failed === 1, '…3번이면 st:fail', r.failed);
  }

  console.log('\n[11] 끊김과 묶음 크기');
  {
    const env = setup([box('INBOX', mks(40))]);
    await headsOnly(env);
    env.server.spec.a1.delay = { fetch: 400 };
    let r = await env.run({ connect: onFetch(env, (c) => { setTimeout(() => c.close(), 20); }) });
    ok(r.why === 'connect' && env.memo.chunk === 5 && !!r.error, '끊기면 memo.chunk 절반, 회차 끝', [r.why, env.memo.chunk]);
    ok([...(await env.rows()).values()].every((x) => x.fails === undefined), '여러 통 묶음은 fails 를 안 올린다');
    delete env.server.spec.a1.delay;
    const mark = env.server.log.length;
    r = await env.run();
    const sizes = env.bodies(mark).map((e) => e.range.length);
    ok(same(sizes.slice(0, 3), [5, 6, 7]) && env.memo.chunk === 10, '성공하면 1씩 회복', sizes);
    ok(r.done, '완주');

    const solo = setup([box('INBOX', mks(2))]);
    await headsOnly(solo);
    solo.memo.chunk = 1;
    solo.server.spec.a1.delay = { fetch: 400 };
    r = await solo.run({ connect: onFetch(solo, (c) => { setTimeout(() => c.close(), 20); }) });
    ok(r.why === 'connect' && (await solo.rows()).get(1001).fails === 1 && solo.memo.chunk === 1, '끊긴 한 통짜는 fails+1, 최소 1', [(await solo.rows()).get(1001).fails, solo.memo.chunk]);
  }

  console.log('\n[12] 폴더 격리·차례·제외');
  {
    const env = setup([
      box('All Mail', mks(2, 6000), { specialUse: '\\All' }),
      box('Drafts', mks(2, 5000), { specialUse: '\\Drafts' }),
      box('Bad', mks(2, 4000)),
      box('Archive', mks(2, 3000)),
      box('보낸편지함', mks(2, 2000)),
      box('INBOX', mks(2)),
      box('Spam', mks(2, 7000), { specialUse: '\\Junk' }),
      box('Trash', mks(2, 8000), { specialUse: '\\Trash' }),
      box('Shared/team', mks(2, 9000))
    ], { namespaces: { personal: [{ prefix: '', delimiter: '/' }], other: false, shared: [{ prefix: 'Shared/', delimiter: '/' }] } });
    const r = await env.run({ connect: failOpen(env, 'Bad') });
    const order = env.opens().map((e) => e.path);
    ok(same([...new Set(order)], ['INBOX', '보낸편지함', 'Archive', 'Drafts', 'All Mail']), '받은편지함, 보낸편지함, 그 밖, \\Drafts, \\All', [...new Set(order)]);
    ok(r.boxErrors.length === 1 && r.boxErrors[0].startsWith('Bad: '), '실패한 폴더는 적고 다음 폴더로 간다', r.boxErrors);
    ok(env.files().length === 2 && env.files('All Mail').length === 2, '…뒤 폴더도 받았다', env.files('All Mail').length);
    ok(!env.rec('Shared/team') && !env.rec('Spam') && !env.rec('Trash'), '공유·스팸·휴지통은 기록도 없다');
    ok(!r.done && env.rec().lowUid === 1 && env.rec('Bad').fillHead === false, '못 연 폴더가 있으면 계정은 안 끝났다', env.rec('Bad'));
    const r2 = await env.run({ connect: failOpen(env, 'Bad') });
    ok(r2.why === 'connect' && r2.saved === 0 && r2.error.startsWith('Bad: '), '받은 것 없이 폴더 오류뿐이면 물러나기를 탄다', r2.why);
    const r3 = await env.run();
    ok(r3.done && env.files('Bad').length === 2, '폴더가 돌아오면 끝난다', r3.why);

    const bare = setup([box('INBOX', mks(2)), box('Archive', mks(2, 3000))], {
      namespaces: { personal: [{ prefix: '', delimiter: '/' }], other: [{ prefix: '', delimiter: '/' }], shared: false }
    });
    const b = await bare.run();
    ok(same(bare.opens().map((e) => e.path).filter((p, i, a) => a.indexOf(p) === i), ['INBOX']) && b.done, 'mineOf 가 null 이면 받은편지함만', bare.opens().map((e) => e.path));

    // 색인을 못 읽는 폴더 — 덮어쓰지 않고 이번 판에 건너뛴다 (폴더를 파일 자리에 둔다)
    const locked = setup([box('INBOX', mks(2)), box('Archive', mks(2, 3000))]);
    fs.mkdirSync(path.join(locked.boxDir('Archive'), mailindex.INDEX_FILE), { recursive: true });
    const l = await locked.run();
    ok(l.boxErrors.length === 1 && l.boxErrors[0].startsWith('Archive: ') && locked.files().length === 2 && !l.done, '색인을 못 읽는 폴더만 건너뛴다', l.boxErrors);
    ok(fs.statSync(path.join(locked.boxDir('Archive'), mailindex.INDEX_FILE)).isDirectory() && locked.files('Archive').length === 0, '…덮어쓰지 않고 받지도 않는다');

    const none = setup([]);
    const n = await none.run();
    ok(n.why === 'connect' && !n.done, '빈 LIST 는 믿지 않는다', n.why);
  }

  console.log('\n[13] fillSkip');
  {
    const env = setup([box('INBOX', mks(3)), box('Shared/team', mks(2, 2000))], {
      namespaces: { personal: [{ prefix: '', delimiter: '/' }], other: false, shared: [{ prefix: 'Shared/', delimiter: '/' }] }
    });
    mail.connect = (a) => env.server.connect(a);
    await mailbackup.backupAccount(A, env.dir, { onlyNew: true });
    ok(!!env.rec('Shared/team') && !env.rec('Shared/team').fillSkip, '준비 — 새 메일 경로는 공유 폴더 기록을 남긴다');
    const mark = env.server.log.length;
    const r = await env.run();
    ok(r.done && env.done(), '공유 폴더 기록이 있어도 isDone 이 참', r.why);
    ok(env.rec('Shared/team').fillSkip === true, 'fillSkip 이 적힌다', env.rec('Shared/team'));
    ok(!env.opens(mark).some((e) => e.path === 'Shared/team'), '…열지 않는다');
    mailbackup.patchState(env.dir, 'a1', 'Shared/team', { fillSkip: undefined });
    ok(!env.done(), 'fillSkip 이 없으면 참이 아니다');
    env.sb('Shared/team').msgs.length = 0;
    env.memo.listAt = 0;
    await env.run();
    ok(env.rec('Shared/team').fillSkip === true && env.done(), '대상이 아니면 다시 적는다');
    // 대상이 되면 지운다
    const env2 = setup([box('INBOX', mks(1)), box('Sub', mks(1, 2000))]);
    mailbackup.patchState(env2.dir, 'a1', 'Sub', { uidValidity: String(V), gen: 1, lowUid: 2001, lastUid: 2000, fillSkip: true });
    await env2.run();
    ok(env2.rec('Sub').fillSkip === undefined && env2.rec('Sub').fillHead === true, '대상인 기록의 fillSkip 은 지운다', env2.rec('Sub'));

    // 받는 중 새로 생긴 폴더 — 1시간짜리 묵은 목록으로 «대상 아님»을 적으면 그 폴더를 빼고 «다 받음»이 된다
    const hidden = new Set(['Project']);
    const env3 = setup([box('INBOX', mks(30)), box('Project', mks(5, 2000))]);
    const seeing = withClient(env3, (c) => {
      const list = c.list.bind(c);
      c.list = async () => (await list()).filter((b) => !hidden.has(b.path));
    });
    await env3.run({ connect: seeing, freeBytes: async () => 0 });
    const lists = () => env3.server.log.filter((e) => e.cmd === 'list').length;
    ok(lists() === 1 && !env3.rec('Project'), '준비 — 첫 목록에는 없었다', lists());
    hidden.clear();
    mailbackup.patchState(env3.dir, 'a1', 'Project', { uidValidity: String(V), gen: 1, lowUid: 2005, lastUid: 2004, exists: 5 });
    const r3 = await drive(env3, { connect: seeing });
    ok(env3.rec('Project').fillSkip === undefined && env3.files('Project').length === 5 && r3.done, '표시를 붙이기 전에 목록을 다시 받아 그 폴더도 받는다', env3.rec('Project'));
    ok(lists() === 2, '…목록은 한 번만 더 부른다', lists());

    // LIST 가 한 번 일부만 답해 표시가 붙었다 — 다 받은 계정은 회차가 안 도니 자동 저장이 그 폴더를 보면 지운다
    const env4 = setup([box('INBOX', mks(3)), box('Project', mks(5, 2000))]);
    hidden.add('Project');
    const seeing4 = withClient(env4, (c) => {
      const list = c.list.bind(c);
      c.list = async () => (await list()).filter((b) => !hidden.has(b.path));
    });
    mailbackup.patchState(env4.dir, 'a1', 'Project', { uidValidity: String(V), gen: 1, lowUid: 2005, lastUid: 2004, exists: 5 });
    await env4.run({ connect: seeing4 });
    ok(env4.rec('Project').fillSkip === true && env4.done(), '준비 — 표시가 붙고 다 받음으로 읽힌다', env4.rec('Project').fillSkip);
    hidden.clear();
    mail.connect = (a) => env4.server.connect(a);
    await mailbackup.backupAccount(A, env4.dir, { onlyNew: true });
    ok(env4.rec('Project').fillSkip === true, '가르는 함수를 안 주면 그대로 둔다', env4.rec('Project').fillSkip);
    await mailbackup.backupAccount(A, env4.dir, { onlyNew: true, mineOf: mailtidy.mineOf });
    ok(env4.rec('Project').fillSkip === undefined && !env4.done(), '자동 저장이 내 폴더로 보면 표시를 지운다', env4.rec('Project'));
    env4.memo.listAt = 0;
    const r4 = await drive(env4);
    ok(r4.done && env4.files('Project').length === 5, '…뒤 받기가 그 폴더를 받는다', env4.files('Project').length);
    // 공유 폴더는 내 폴더가 아니다 — 지우면 폴링마다 표시가 오르내린다
    mail.connect = (a) => env.server.connect(a);
    await mailbackup.backupAccount(A, env.dir, { onlyNew: true, mineOf: mailtidy.mineOf });
    ok(env.rec('Shared/team').fillSkip === true && env.done(), '공유 폴더의 표시는 안 지운다', env.rec('Shared/team').fillSkip);
  }

  console.log('\n[14] UIDVALIDITY');
  {
    const env = setup([box('INBOX', mks(4))]);
    await headsOnly(env);
    const sb = env.sb();
    sb.uidValidity = V + 1n;
    sb.msgs = mks(4, 1000, 1, { tag: undefined }).map((m) => ({ ...m, raw: m.raw.replace(/report /, 'other ').replace(/<m/, '<x'), messageId: m.messageId.replace('<m', '<x'), flags: new Set(), labels: new Set() }));
    let r = await env.run();
    const rec = env.rec();
    ok(r.genUp === true && rec.gen === 2, '세대가 오르고 genUp 이 참', { genUp: r.genUp, gen: rec.gen });
    ok(rec.fillHead === undefined && rec.fillLeft === undefined && rec.fillFail === undefined && rec.fillLeftBytes === undefined, 'fill* 칸이 사라진다', rec);
    r = await drive(env);
    ok(r.done && env.files('INBOX', 2).length === 4, '새 세대를 다시 받는다', env.files('INBOX', 2).length);
    ok(env.rec().uidValidity === String(V + 1n) && fs.existsSync(env.boxDir('INBOX', 1)), '옛 세대 폴더는 남는다');

    // 끝난 폴더는 열지 않으므로 새 메일 경로가 먼저 본다 — 그 뒤로 뒤 받기가 잇는다
    const done = setup([box('INBOX', mks(3))]);
    await done.run();
    ok(done.done(), '준비 — 끝남');
    done.sb().uidValidity = V + 2n;
    mail.connect = (a) => done.server.connect(a);
    const b = await mailbackup.backupAccount(A, done.dir, { onlyNew: true });
    ok(b.genUp && done.rec().fillHead === undefined && !done.done(), '새 메일 경로가 세대를 올리면 완료가 풀린다', done.rec());
    const r2 = await drive(done);
    ok(r2.done && done.files('INBOX', 2).length === 3, '…뒤 받기가 다시 받는다', done.files('INBOX', 2).length);

    // 답에 UIDVALIDITY 가 빠졌다 — 세대를 올리면 다음 정상 답에서 또 올라 메일함 전체를 두 번 받는다
    const noV = setup([box('INBOX', mks(3))]);
    await headsOnly(noV);
    const before = noV.rec();
    noV.sb().noUidValidity = true;
    const x = await noV.run();
    ok(x.boxErrors.length === 1 && noV.rec().gen === 1 && same(noV.rec(), before) && !x.genUp && x.saved === 0, 'noUidValidity — 폴더 오류, 세대 안 오름, 칸 유지', x.boxErrors);
    delete noV.sb().noUidValidity;
    const y = await drive(noV);
    ok(y.done && noV.rec().gen === 1 && !y.genUp && noV.files().length === 3, '…정상 답이 돌아와도 세대는 그대로다', noV.rec().gen);
  }

  console.log('\n[15] 큰 메일 차례');
  {
    const env = setup([box('INBOX', mks(6))]);
    const sizes = { 1005: mailfill.MAX_BYTES + 1, 1004: 9 * 1024 * 1024 };
    env.memo.bps = 1e12;    // 속도로는 바로 시작할 수 있다 — 그래도 작은 메일 뒤다
    const r = await drive(env, { connect: sized(env, sizes) });
    const order = uidsOf(env.bodies());
    ok(!order.includes(1005), '100MB 넘으면 안 받는다', order);
    ok(order[order.length - 1] === 1004 && same(order.slice(0, 4), [1003, 1002, 1001, 1000]), '8MB 넘는 메일은 작은 메일 뒤다', order);
    ok(env.bodies().find((e) => e.range.includes(1004)).range.length === 1, '…혼자 받는다');
    const rows = await env.rows();
    ok(rows.get(1005).st === 'big' && !env.files().includes(1005), "st:'big'", rows.get(1005).st);
    ok(r.done && rows.get(1004).st === 'file', '끝난다', r.why);
    ok(r.failed === 1 && env.rec().fillBig === 1 && env.rec().fillFail === 0, '100MB 넘어 못 받은 메일도 «못 받음»에 센다', { failed: r.failed, big: env.rec().fillBig });
    const conns = env.server.clients.length;
    await env.run({ connect: sized(env, sizes) });
    ok(env.server.clients.length === conns, '…다시 불러 봐야 소용없으니 연결을 안 만든다', env.server.clients.length - conns);

    // 묶음은 8MB까지
    const MB = 1024 * 1024;
    const env2 = setup([box('INBOX', mks(5))]);
    await env2.run({ connect: sized(env2, { 1004: 3 * MB, 1003: 3 * MB, 1002: 3 * MB, 1001: 3 * MB, 1000: 3 * MB }) });
    ok(same(env2.bodies().map((e) => e.range.length), [2, 2, 1]), '묶음은 8MB를 넘지 않는다', env2.bodies().map((e) => e.range.length));

    // 머리를 끝내 못 받은 줄은 크기를 모른다 — 혼자 받는다
    const list = mks(3);
    list[0].headNo = true;
    list[1].headNo = true;
    const env3 = setup([box('INBOX', list)]);
    await drive(env3);
    ok(env3.done() && env3.bodies().filter((e) => e.range.includes(1000) || e.range.includes(1001)).every((e) => e.range.length === 1), '머리 없는 줄은 혼자 받는다', env3.bodies().map((e) => e.range));
  }

  console.log('\n[16] \\All');
  {
    const sizeOf = (m) => Buffer.byteLength(m.raw, 'latin1');
    const a = mk(1000, { tag: 'a' });
    const b = mk(1001, { tag: 'b', fetchNo: true });
    const c = mk(1002, { tag: 'c', fetchNo: true });
    const d = mk(1003, { tag: 'd' });
    const e = mk(1004, { tag: 'e', id: null });
    const copy = (m, uid) => ({ ...m, uid, fetchNo: false });
    const env = setup([
      box('All Mail', [copy(a, 2000), copy(b, 2001), copy(c, 2002), copy(d, 2003), copy(e, 2004)], { specialUse: '\\All' }),
      box('INBOX', [a, b, c, d, e])
    ]);
    // 상대 줄이 fail·big 인 경우는 줄을 미리 적어 만든다
    const seed = { at: 1000, seen: false, subject: 'x', via: 'fill', file: null };
    mailindex.append(env.boxDir(), { uid: 1002, ...seed, mid: c.messageId, size: sizeOf(c), st: 'fail', fails: 3 });
    mailindex.append(env.boxDir(), { uid: 1003, ...seed, mid: d.messageId, size: sizeOf(d), st: 'big' });
    await mailindex.flush(env.boxDir());
    await env.run();
    const all = await env.rows('All Mail');
    ok(all.get(2000).st === 'dup' && same(all.get(2000).dupOf, { box: 'INBOX', uid: 1000 }) && !env.files('All Mail').includes(2000), '상대가 st:file 이고 파일이 있으면 dup', all.get(2000));
    ok(all.get(2001).st === 'file', '상대가 st:head 면 받는다', all.get(2001).st);
    ok(all.get(2002).st === 'file', '상대가 st:fail 이면 받는다', all.get(2002).st);
    ok(all.get(2003).st === 'file', '상대가 st:big 이면 받는다', all.get(2003).st);
    ok(all.get(2004).st === 'file', 'mid 가 없으면 받는다', all.get(2004).st);

    // 상대 파일이 사라졌다 — confirmBox 의 SEARCH 때 지운다
    let searches = 0;
    const env2 = setup([
      box('All Mail', [copy(a, 2000)], { specialUse: '\\All' }),
      box('INBOX', [{ ...a }])
    ], { hooks: { afterSearch: ({ box: b2 }) => {
      if (b2.path !== 'All Mail' || ++searches !== 2) return;
      for (const n of fs.readdirSync(env2.boxDir())) if (n.endsWith('.eml')) fs.unlinkSync(path.join(env2.boxDir(), n));
    } } });
    const r = await env2.run();
    const row = (await env2.rows('All Mail')).get(2000);
    ok(searches === 2 && row.st === 'head' && row.dupOf === null, 'dup 의 상대 파일이 사라지면 st:head 로 돌아간다', row);
    ok(!r.done && !env2.done() && env2.rec('All Mail').lowUid > 1, '…isDone 이 거짓이다', env2.rec('All Mail').lowUid);
    const r2 = await env2.run();
    ok(r2.done && env2.files('All Mail').includes(2000), '…다음 회차가 제 사본을 받는다', env2.files('All Mail'));
  }

  console.log('\n[17] 공간');
  {
    // 머리가 안 끝난 폴더가 있으면 묶음마다 본다
    const env = setup([box('INBOX', mks(5)), box('Bad', mks(1, 3000))]);
    let r = await env.run({ freeBytes: async () => 100, connect: failOpen(env, 'Bad') });
    ok(r.why === 'disk' && r.saved === 0 && env.bodies().length === 0 && r.need === null, "공간이 모자라면 why:'disk', 본문 0", { why: r.why, saved: r.saved });

    // 전 폴더 머리 뒤에는 받을 양과 견준다
    const env2 = setup([box('INBOX', mks(5))]);
    const total = env2.sb().msgs.reduce((s, m) => s + Buffer.byteLength(m.raw, 'latin1'), 0);
    r = await env2.run({ freeBytes: async () => 1_000_000, minFree: async () => 1_000_000 - total + 1 });
    ok(r.why === 'disk' && r.need === 1 && r.saved === 0 && env2.bodies().length === 0, '받을 양이 공간을 넘으면 본문 전에 멈추고 need 는 실제 부족분이다', { need: r.need, total });
    ok(r.leftBytes === total && r.left === 5, '…남은 양을 안다', [r.left, r.leftBytes]);
    r = await env2.run({ freeBytes: async () => 5, minFree: async () => 10 });
    ok(r.why === 'disk' && r.need === total + 5, '…바닥 아래로 내려가 있으면 그만큼 더 비워야 한다', { need: r.need, total });
    r = await env2.run({ freeBytes: async () => 1_000_000, minFree: async () => 1_000_000 - total });
    ok(r.done && r.saved === 5, 'minFree 주입이 바닥이다 — 딱 맞으면 받는다', r.why);

    // 받는 도중에 바닥에 닿는다
    const env3 = setup([box('INBOX', mks(30))]);
    let n = 0;
    r = await env3.run({ freeBytes: async () => (++n > 3 ? 5 : PLENTY), minFree: async () => 10 });
    ok(r.why === 'disk' && r.saved > 0 && r.saved < 30, '…도중에 닿아도 멈춘다', r.saved);
  }

  console.log('\n[18] 쓰기 실패');
  {
    const realOpen = fs.promises.open;
    const blockOpen = (uid, code) => {
      fs.promises.open = async (f, flags) => {
        if (new RegExp(`~받는중-${uid}[-.]`).test(String(f))) throw Object.assign(new Error('막힘'), { code });
        return realOpen(f, flags);
      };
    };
    try {
      const env = setup([box('INBOX', mks(12))]);
      blockOpen(1011, 'EIO');
      let r = await env.run({ dirProblem: () => '이 폴더를 쓸 수 없습니다' });
      ok(r.why === 'write' && r.error === '이 폴더를 쓸 수 없습니다', "프로브 실패면 why:'write'", r.why);
      ok((await env.rows()).get(1011).fails === undefined, '…fails 그대로');
      ok(env.server.clients[env.server.clients.length - 1].closed, '…걸린 FETCH 를 기다리지 않고 닫는다');

      r = await env.run({ dirProblem: () => null });
      let row = (await env.rows()).get(1011);
      ok(row.fails === 1 && row.st === 'head', '프로브 통과면 그 UID 만 fails+1', row.fails);
      ok(env.files().length === 11 && !env.files().includes(1011), '…다음 통은 저장한다', env.files().length);
      await env.run({ dirProblem: () => null });
      r = await env.run({ dirProblem: () => null });
      row = (await env.rows()).get(1011);
      ok(row.fails === 3 && row.st === 'fail' && r.done, '3번이면 st:fail', row.st);

      const full = setup([box('INBOX', mks(3))]);
      blockOpen(1002, 'ENOSPC');
      r = await full.run({ dirProblem: () => null });
      ok(r.why === 'disk' && (await full.rows()).get(1002).fails === undefined, "ENOSPC 는 회차 끝, why:'disk'", r.why);
    } finally {
      fs.promises.open = realOpen;
    }

    const realRename = fs.promises.rename;
    try {
      const env = setup([box('INBOX', mks(3))]);
      let left = 3;
      fs.promises.rename = async (a, b) => {
        if (/~받는중-1002[-.]/.test(String(a)) && left > 0) {
          left -= 1;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return realRename(a, b);
      };
      const seen = new Map();
      const r = await env.run({ connect: counting(env, seen) });
      ok(r.done && left === 0 && env.files().includes(1002), 'rename EBUSY 가 세 번 난 뒤 풀리면 저장된다', env.files());
      ok(seen.get(1002) === 1 && (await env.rows()).get(1002).fails === undefined, '…재수신 0, 실패 0', seen.get(1002));
    } finally {
      fs.promises.rename = realRename;
    }
  }

  console.log('\n[19] 겹침');
  {
    const B = { ...A, id: 'b1', user: 'lee@corp.invalid', name: '다른' };
    const dir = path.join(TMP, 'overlap');
    fs.mkdirSync(dir, { recursive: true });
    const server = makeServer({
      a1: { delay: { fetch: 3 }, boxes: [box('INBOX', mks(40))] },
      b1: { delay: { fetch: 3 }, boxes: [box('INBOX', mks(5, 3000))] }
    });
    mail.connect = (a) => server.connect(a);
    await mailbackup.backupAccount(A, dir, { onlyNew: true });
    await mailbackup.backupAccount(B, dir, { onlyNew: true });
    server.box('a1', 'INBOX').msgs.push({ ...mk(1500, { daysAgo: 0 }), flags: new Set(), labels: new Set() });
    const memo = {};
    const [r] = await Promise.all([
      mailfill.fillAccount(A, dir, { connect: (a) => server.connect(a), memo, freeBytes: async () => PLENTY }),
      mailbackup.backupAccount(A, dir, { onlyNew: true }),
      mailbackup.backupAccount(B, dir, { onlyNew: true }),
      mailfill.fillAccount(B, dir, { connect: (a) => server.connect(a), memo: {}, freeBytes: async () => PLENTY })
    ]);
    const st = mailbackup.loadState(dir);
    ok(st.a1.INBOX.lastUid === 1500, '겹쳐도 lastUid 가 되돌아가지 않는다', st.a1.INBOX.lastUid);
    ok(!!st.b1 && st.b1.INBOX.lowUid === 1 && st.b1.INBOX.fillHead === true, '다른 계정 기록이 남는다', st.b1 && st.b1.INBOX);
    ok(r.done && st.a1.INBOX.lowUid === 1, '두 일이 겹쳐도 끝까지 간다', r.why);
    ok(mailbackup.uidsIn(mailbackup.boxDirFor(dir, A, 'INBOX', 1)).size === 41, '지난 메일 40 + 새 메일 1', mailbackup.uidsIn(mailbackup.boxDirFor(dir, A, 'INBOX', 1)).size);
    mailbackup.patchState(dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 5000, lastUid: 1000 });
    const kept = mailbackup.loadState(dir);
    ok(kept.a1.INBOX.lastUid === 1500 && kept.a1.INBOX.lowUid === 1 && kept.a1.INBOX.fillHead === true && !!kept.b1, '늦게 온 옛 값이 위치를 되돌리지 못한다', kept.a1.INBOX);

    // 끊긴 옛 회차의 값이 새 세대 기록에 붙지 않는다
    let env;
    env = setup([box('INBOX', mks(5))], { hooks: { afterFetch: ({ query }) => {
      if (query.source) mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: '999', gen: 2, lowUid: 5, lastUid: 5 });
    } } });
    await headsOnly(env);
    const x = await env.run();
    ok(same(env.rec(), { uidValidity: '999', gen: 2, lowUid: 5, lastUid: 5 }), '세대가 바뀐 뒤 옛 회차의 패치는 버린다', env.rec());
    ok(x.boxErrors.length === 1, '…폴더 오류로 적는다', x.boxErrors);

    // .part 이름이 시도마다 달라 동시 저장이 서로 안 밟는다
    const env3 = setup([box('INBOX', [])]);
    await fs.promises.mkdir(env3.boxDir(), { recursive: true });
    const msg = mk(77);
    const both = await Promise.all([1, 2].map(() => mailbackup.commit(env3.boxDir(), { uid: 77, receivedAt: msg.date, subject: msg.subject, source: Buffer.from(msg.raw, 'latin1') })));
    ok(both.every((s) => s.bytes > 0) && !fs.readdirSync(env3.boxDir()).some((n) => n.endsWith('.part')), '같은 UID 동시 저장 둘 다 성공', both.map((s) => s.name));
  }

  console.log('\n[20] 파일 이름 시각');
  {
    const at = new Date(2024, 9, 27, 9, 12, 30);
    const env = setup([box('INBOX', [mk(1000, { date: at, hdrDate: new Date(2020, 0, 2, 3, 4, 5) })])]);
    await env.run();
    const name = fs.readdirSync(env.boxDir()).find((n) => n.endsWith('.eml'));
    ok(name.startsWith(`${stampOf(at)}_1000_`), '파일 이름 시각은 INTERNALDATE 다 (Date 머리글이 아니다)', name);
    ok((await env.rows()).get(1000).at === at.getTime(), '색인의 at 도 같다');
  }

  console.log('\n[21] 서버 정리 대상');
  {
    const env = setup([box('INBOX', mks(12)), box('Trash', [], { specialUse: '\\Trash' })]);
    mail.connect = (a) => env.server.connect(a);
    await mailbackup.backupAccount(A, env.dir, { onlyNew: true });
    const count = () => mailtidy.tidyAll([A], env.dir, { days: 30, dryRun: true, cap: Infinity, connect: env.connect, now: () => NOW });
    const a = await count();
    const r = await env.run();
    const b = await count();
    ok(r.done && a.verified === 0 && a.unsaved === 12, '받기 전 정리 대상 0', { verified: a.verified, unsaved: a.unsaved });
    ok(b.verified === 12 && b.unsaved === 0, '받은 뒤 대상 12 — 답에 정리 문구가 필요한 까닭이다', { verified: b.verified, unsaved: b.unsaved });
    ok(!env.server.log.some((e) => e.cmd === 'moved'), '세기만 했다');
  }

  console.log('\n[22] 자동 전달');
  {
    const env = setup([box('INBOX', mks(10, 1000, 1, { daysAgo: 1 }))]);
    const tx = {
      sent: [],
      async sendMail(m) { tx.sent.push(m); return { accepted: m.envelope.to, rejected: [] }; },
      close() {}
    };
    const fwd = () => mailfwd.forwardAll([A], {
      dir: env.dir, to: ['me@corp.invalid'], since: {}, connect: env.connect, transport: () => tx, backupDir: env.dir, backupOn: true
    });
    const r0 = await fwd();
    ok(r0.seeded === 1 && tx.sent.length === 0, '준비 — 기준만 잡는다', r0.seeded);
    const r = await env.run();
    const r1 = await fwd();
    ok(r.done && r.saved === 10, '지난 메일 10통을 받았다', r.saved);
    ok(r1.sent === 0 && tx.sent.length === 0, '전달 엔진은 0통을 보낸다', r1.sent);
    env.sb().msgs.push({ ...mk(1500, { daysAgo: 0 }), flags: new Set(), labels: new Set() });
    const r2 = await fwd();
    ok(r2.sent === 1 && tx.sent.length === 1, '대조 — 진짜 새 메일은 보낸다', r2.sent);
  }

  console.log('\n[23] 소스 검사');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mailfill.js'), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
    ok(same(reqs, ['./mail', './mailbackup', './mailindex', './mailtidy', 'fs', 'path']), 'require 는 fs·path·mail·mailbackup·mailindex·mailtidy 뿐이다', reqs);
    ok(!/require\([^)]*(store|mailhub|autofwd|mailrules|mailtally|electron)/.test(src), 'store·mailhub·autofwd·mailrules·mailtally·electron 없음');
    ok(!/readOnly:\s*false/.test(src), 'readOnly:false 가 소스에 없다');
    ok(!/\.(messageMove|messageCopy|messageDelete|messageFlags\w+)\(/.test(src), '쓰는 명령을 부르는 줄이 없다');
    const loaded = Object.keys(require.cache).filter((f) => /[\\/]src[\\/](store|mailhub|autofwd|mailtally)\.js$/.test(f) || /[\\/]electron[\\/]/.test(f));
    ok(!loaded.length, '실제로 실리지도 않았다', loaded);
  }

  console.log('\n[24] 앞쪽 연결 추적');
  {
    const acc = { id: 'front1', user: 'u@corp.invalid', host: 'imap.corp.invalid', port: 993, pass: 'x' };
    const calls = [];
    mail.setFrontHook((a) => calls.push(a.id));
    const c = realConnect(acc);
    ok(same(calls, ['front1']) && mail.frontState(acc).busy === true, '앞쪽 연결 — 훅이 불리고 busy', calls);
    const bgAcc = { ...acc, id: 'front2' };
    realConnect(bgAcc, { background: true });
    ok(calls.length === 1 && mail.frontState(bgAcc).busy === false, 'background:true 는 안 불린다', calls);
    ok(mail.frontState(acc).okAt === 0, '폴더를 열기 전에는 okAt 이 0');
    c.emit('mailboxOpen');
    ok(mail.frontState(acc).okAt > 0, "emit('mailboxOpen') 뒤 okAt", mail.frontState(acc).okAt > 0);
    c.emit('close');
    ok(mail.frontState(acc).busy === false && mail.frontState(acc).last > 0, "emit('close') 뒤 busy 거짓", mail.frontState(acc).busy);
    realConnect(acc);
    ok(mail.frontState(acc).busy === true, '다시 앞쪽 연결');
    ok(mail.frontState(acc, Date.now() + 5 * 60_000 + 1).busy === false, '5분 뒤 만료');
    mail.setFrontHook(null);

    const msg = {
      uid: 7, internalDate: new Date(NOW), flags: new Set(['\\Seen']),
      envelope: { subject: 'x'.repeat(150), from: [{ name: 'Kim', address: 'kim@corp.invalid' }] }
    };
    const old = {
      uid: msg.uid,
      subject: String((msg.envelope && msg.envelope.subject) || '(제목 없음)').slice(0, 120),
      from: mail.senderOf(msg.envelope),
      fromAddress: ((msg.envelope && msg.envelope.from && msg.envelope.from[0]) || {}).address || '',
      fromName: ((msg.envelope && msg.envelope.from && msg.envelope.from[0]) || {}).name || '',
      at: (msg.internalDate || new Date()).getTime(),
      seen: msg.flags.has('\\Seen')
    };
    ok(same(mail.rowOf(msg), old), 'rowOf 가 옛 collect 칸과 같다', Object.keys(mail.rowOf(msg)));
    let threw = null;
    let row = null;
    try { row = mail.rowOf({ uid: 8, internalDate: 'not-a-date', flags: new Set() }); } catch (e) { threw = e; }
    ok(!threw && Number.isFinite(row.at) && row.at > NOW - DAY, '문자열 날짜에 던지지 않는다', row && row.at > 0);
  }

  console.log('\n[25] 연결 중 끊기 (진짜 imapflow, 127.0.0.1)');
  {
    const socks = new Set();
    const srv = net.createServer((s) => { socks.add(s); s.on('error', () => {}); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const acc = { id: 'cut1', name: '끊기', user: 'u@corp.invalid', pass: 'x', host: '127.0.0.1', port: srv.address().port };
    const dir = path.join(TMP, 'cut');
    fs.mkdirSync(dir, { recursive: true });
    const connect = (a) => realConnect(a, { timeoutMs: 90_000, background: true });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort('yield'), 200);
    let t0 = Date.now();
    let r = await mailfill.fillAccount(acc, dir, { connect, signal: ctl.signal, budgetMs: 20_000 });
    ok(r.why === 'yield' && Date.now() - t0 < 3000, "TLS 단계에서 비키면 곧 끝나고 why:'yield'", { why: r.why, ms: Date.now() - t0 });
    t0 = Date.now();
    r = await mailfill.fillAccount(acc, dir, { connect, budgetMs: 300 });
    ok(r.why === 'budget' && Date.now() - t0 < 3000, "몫이 지나면 why:'budget'", { why: r.why, ms: Date.now() - t0 });
    for (const s of socks) s.destroy();
    srv.close();
    const srcOf = (n) => fs.readFileSync(path.join(ROOT, 'src', n), 'utf8');
    ok(['mailfill.js', 'mailtidy.js', 'mailfwd.js'].every((n) => srcOf(n).includes('mail.connectOrClose(client)')), 'mailfill·mailtidy·mailfwd 의 연결 자리가 같은 함수를 쓴다');
  }

  console.log('\n[26] headNo');
  {
    const msgs = mks(5);
    msgs[2].headNo = true;
    msgs[2].fetchNo = true;
    const env = setup([box('INBOX', msgs)]);
    let r = await env.run();
    let row = (await env.rows()).get(1002);
    ok(row.st === 'head' && row.hf === 1 && row.at === undefined, '거절된 UID 에 자리표와 hf 가 남는다', row);
    ok(env.files().length === 4 && env.rec().fillHead === undefined && !r.done, '…나머지는 받고, fillHead 는 아직이다', env.files().length);
    await env.run();
    ok((await env.rows()).get(1002).hf === 2 && env.rec().fillHead === undefined, 'hf 2');
    r = await env.run();
    row = (await env.rows()).get(1002);
    ok(row.hf === 3 && env.rec().fillHead === true, 'hf 3이면 fillHead 가 선다', row.hf);
    ok(uidsOf(env.bodies()).includes(1002) && row.fails === 1, '…본문 단계가 그 UID 를 부른다', row.fails);
    ok(!r.done && !env.done(), '…받기 전에는 isDone 이 거짓이다');
    env.sb().msgs.find((m) => m.uid === 1002).fetchNo = false;
    const heads = env.heads().length;
    r = await env.run();
    row = (await env.rows()).get(1002);
    ok(r.done && row.st === 'file' && env.files().length === 5, '받으면 끝난다', row.st);
    ok(env.heads().length === heads, '…머리를 더 묻지 않는다');
    ok(row.subject === 'report 1002' && row.at === msgs[2].date.getTime() && row.mid === '<m1002@corp.invalid>' && row.size === row.bytes, '…줄은 원문으로 채운다', row);
  }

  console.log('\n[27] noRow(머리)');
  {
    const msgs = mks(5);
    msgs[1].noRow = true;
    const env = setup([box('INBOX', msgs)]);
    const r = await env.run();
    const row = (await env.rows()).get(1001);
    ok(row.hf === 1 && row.st === 'head', '묶음이 오류 없이 끝나도 그 UID 에 hf+1', row);
    ok(!r.done && r.why !== 'done' && env.rec().fillHead === undefined, '«모두 받음»이 되지 않는다', r.why);
    ok(r.boxErrors.length === 0, '폴더 오류가 아니다');
  }

  console.log('\n[28] 색인 쓰기 실패');
  {
    const realAppend = fs.promises.appendFile;
    const env = setup([box('INBOX', mks(5))]);
    fs.promises.appendFile = async () => { throw Object.assign(new Error('막힘'), { code: 'EIO' }); };
    let r;
    try {
      r = await env.run();
      ok(r.why === 'write', "못 쓴 줄이 있으면 why:'write'", r.why);
      ok(env.rec().fillHead === undefined && env.rec().lowUid > 1, 'fillHead·lowUid:1 을 안 쓴다', env.rec());
      ok(env.bodies().length === 0, '머리 줄을 못 쓰면 본문도 안 받는다');
    } finally {
      fs.promises.appendFile = realAppend;
    }
    r = await env.run();
    ok(r.done && env.files().length === 5, '회복하면 완주한다', r.why);

    // 본문 뒤 색인을 못 쓰면 완료를 안 적는다
    const env2 = setup([box('INBOX', mks(3))]);
    await headsOnly(env2);
    fs.promises.appendFile = async () => { throw Object.assign(new Error('막힘'), { code: 'EIO' }); };
    try {
      r = await env2.run();
      ok(r.why === 'write' && env2.rec().lowUid > 1 && !env2.done(), '본문 뒤 색인을 못 써도 lowUid 를 안 내린다', env2.rec().lowUid);
    } finally {
      fs.promises.appendFile = realAppend;
    }
    r = await env2.run();
    ok(r.done && (await env2.rows()).get(1000).st === 'file', '…회복하면 버퍼의 줄이 써지고 완주한다', r.why);

    // 세대 폴더가 없어도 머리 줄이 써진다
    let env3;
    let cut = false;
    env3 = setup([box('INBOX', mks(3))], { hooks: { afterSearch: () => {
      if (cut) return;
      cut = true;
      fs.rmSync(env3.boxDir(), { recursive: true, force: true });
    } } });
    r = await env3.run();
    ok(cut && r.done && env3.files().length === 3 && (await env3.rows()).size === 3, '세대 폴더가 없어도 머리 줄이 써진다', r.why);
  }

  console.log('\n[29] badDate · notify');
  {
    const msgs = mks(150);
    msgs[149].badDate = true;   // 맨 위 — 내림차순으로 받으면 처음 만난다
    msgs[100].badDate = 'Tue, garbage';
    const env = setup([box('INBOX', msgs)]);
    const r = await env.run();
    const rows = await env.rows();
    ok(r.boxErrors.length === 0 && r.heads === 150 && r.done, '던지지 않는다', { heads: r.heads, why: r.why });
    ok(rows.get(1000).at === msgs[0].date.getTime() && rows.get(1050).at === msgs[50].date.getTime(), '그 UID 아래 메일도 머리를 받는다', rows.get(1000).at > 0);
    ok(Number.isFinite(rows.get(1149).at) && rows.get(1149).st === 'file' && rows.get(1149).fails === undefined, '못 읽는 날짜의 메일도 저장한다', rows.get(1149).st);

    const env2 = setup([box('INBOX', mks(25))], { notify: true });
    const r2 = await env2.run();
    const loaded = await mailindex.load(env2.boxDir());
    ok(r2.done && r2.saved === 25, 'notify — 묶음이 끝까지 간다', r2.saved);
    ok(loaded.bad === 0 && loaded.rows.size === 25, 'uid 없는 줄이 색인에 안 들어간다', [loaded.bad, loaded.rows.size]);
    ok([...loaded.rows.values()].every((x) => x.fails === undefined && x.hf === undefined), '…fails·hf 에도 안 들어간다');
  }

  console.log('\n[30] 믿을 수 없는 검색 답');
  {
    const check = async (label, tune, undo) => {
      const env = setup([box('INBOX', mks(100))]);
      tune(env);
      const r = await env.run();
      const rows = await env.rows().catch(() => new Map());
      ok(r.boxErrors.length === 1 && env.rec().fillHead === undefined && r.saved === 0, `${label} — 폴더 오류이고 fillHead 를 안 쓴다`, r.boxErrors);
      ok(![...rows.values()].some((x) => x.srv), '…srv 도 안 쓴다');
      undo(env);
      const r2 = await drive(env);
      ok(r2.done && env.files().length === 100, '…정상 답이 돌아오면 완주한다', env.files().length);
    };
    await check('앞 3개만 답함', (e) => { e.sb().searchShort = 3; }, (e) => { delete e.sb().searchShort; });
    await check('exists>0 인데 빈 답', (e) => { e.sb().searchShort = 0; }, (e) => { delete e.sb().searchShort; });
    await check('배열이 아닌 답', (e) => { e.sb().searchReturns = false; }, (e) => { delete e.sb().searchReturns; });

    // 문턱 — 머리 단계는 exists 의 2% 또는 20통까지 믿는다. 완료를 적는 자리는 답이 EXISTS 보다 적으면 안 믿는다
    const env = setup([box('INBOX', mks(100))]);
    env.sb().searchShort = 85;
    const r = await env.run();
    ok(env.rec().fillHead === true && env.files().length === 85, '차이가 20통 안이면 머리 단계는 믿는다', env.files().length);
    ok(!r.done && r.why !== 'done' && env.rec().lowUid > 1 && r.boxErrors.length === 1 && r.boxErrors[0].startsWith('INBOX: '), '…완료는 적지 않고 폴더 오류로 남긴다', r.boxErrors);
    delete env.sb().searchShort;
    const r0 = await drive(env);
    ok(r0.done && env.files().length === 100, '…정상 답이 돌아오면 나머지까지 받고 끝난다', env.files().length);
    const tiny = setup([box('INBOX', mks(20))]);
    tiny.sb().searchShort = 1;
    const t1 = await tiny.run();
    ok(!t1.done && tiny.rec().lowUid > 1 && tiny.files().length === 1, 'exists 20 에 1통만 답해도 «다 받음»이 안 된다', { why: t1.why, low: tiny.rec().lowUid });
    const more = setup([box('INBOX', mks(3))]);
    const m1 = await more.run({ connect: withClient(more, (c) => {
      const open = c.mailboxOpen.bind(c);
      c.mailboxOpen = async (p, o) => { const x = await open(p, o); x.exists = 2; return x; };
    }) });
    ok(m1.done && m1.boxErrors.length === 0, '답이 EXISTS 보다 많은 것은 믿는다 — 그 사이 메일이 왔다', m1.boxErrors);

    // 끊겨서 온 false 는 폴더 오류가 아니다 [실측: S3]
    const dead = setup([box('INBOX', mks(3))]);
    const r2 = await dead.run({ connect: withClient(dead, (c) => { c.search = async () => { c.close(); return false; }; }) });
    ok(r2.why === 'connect' && r2.boxErrors.length === 0 && !/믿을 수 없/.test(r2.error), '끊겨서 온 false 는 회차 끝이다 — 서버 답 탓으로 말하지 않는다', [r2.why, r2.error]);

    // 머리 단계의 답이 나빠도, 끝난 폴더 확인의 답이 나빠도 같다
    const late = setup([box('INBOX', mks(30))]);
    let searches = 0;
    const r3 = await late.run({ connect: withClient(late, (c) => {
      const s = c.search.bind(c);
      c.search = async (q, o) => (++searches === 2 ? false : s(q, o));
    }) });
    ok(searches === 2 && !r3.done && late.rec().lowUid > 1 && r3.boxErrors.length === 1, 'confirmBox 의 답이 나쁘면 아무것도 안 적는다', late.rec().lowUid);
    const r4 = await late.run();
    ok(r4.done, '…다음 회차가 확인한다', r4.why);
  }

  console.log('\n[31] confirmBox — 사라진 메일');
  {
    let off = 0;
    const now = () => Date.now() + off;
    const env = setup([box('INBOX', mks(8))]);
    await headsOnly(env);
    env.sb().msgs = env.sb().msgs.filter((m) => m.uid !== 1003 && m.uid !== 1007);   // 1007 은 맨 위다
    let r = await env.run({ now });
    let rows = await env.rows();
    ok(rows.get(1003).srv === undefined && rows.get(1003).fails === undefined, '한 번 답에 없으면 srv 를 안 쓴다 — 부르지도 않는다', rows.get(1003));
    ok(env.memo.miss.get(env.boxDir()).has(1003), '…memo.miss 에 적는다');
    ok(env.memo.miss.get(env.boxDir()).has(1007) && rows.get(1007).fails === undefined, '답의 수가 EXISTS 와 맞으면 맨 위 줄도 같은 두 번 확인을 받는다 — 잘린 답이 아니다');
    ok(!r.done, '…끝나지 않았다');
    r = await env.run({ now });
    r = await env.run({ now });
    rows = await env.rows();
    ok(rows.get(1007).st === 'head' && rows.get(1007).fails === undefined, '…기다리는 동안 부르지 않아 실패로 남지 않는다', rows.get(1007));
    ok(rows.get(1003).srv === undefined && !r.done && !env.done(), '확인을 돌아도 10분 전에는 안 쓴다', rows.get(1003).srv);
    const conns = env.server.clients.length;
    r = await env.run({ now });
    ok(env.server.clients.length === conns && !r.done, '기다리는 동안은 연결을 안 만든다', env.server.clients.length - conns);
    off = mailfill.MISS_GAP_MS + 1000;
    r = await env.run({ now });
    rows = await env.rows();
    ok(rows.get(1003).srv === 'gone' && rows.get(1007).srv === 'gone' && r.done && r.why === 'done', '10분 뒤 두 번째로 없으면 쓴다', rows.get(1003).srv);
    ok(!env.memo.miss.has(env.boxDir()), '…대기가 빈다');
    ok(rows.get(1003).st === 'head' && mailindex.terminal(rows.get(1003)), '…줄은 st:head 로 남고 끝난 줄이다');

    // 답이 EXISTS 보다 적으면 위쪽이 잘린 것일 수 있다 — 맨 위보다 큰 줄은 판정하지 않는다
    off = 0;
    const cutTop = setup([box('INBOX', mks(8))]);
    await headsOnly(cutTop);
    cutTop.sb().searchShort = 7;
    off = 2 * 3600_000;
    let bodyNow = false;
    await cutTop.run({ now, onProgress: (p) => { if (p.phase === 'body') bodyNow = true; }, shouldStop: () => bodyNow });
    ok(bodyNow && !(cutTop.memo.miss.get(cutTop.boxDir()) || new Map()).has(1007), '답이 EXISTS 보다 적으면 맨 위보다 큰 줄은 판정하지 않는다', [...(cutTop.memo.miss.get(cutTop.boxDir()) || new Map()).keys()]);

    // 다시 보이면 지운다
    off = 0;
    const env2 = setup([box('INBOX', mks(6).map((m) => (m.uid === 1004 ? { ...m, fetchNo: true } : m)))]);
    await headsOnly(env2);
    const gone = env2.sb().msgs.find((m) => m.uid === 1002);
    env2.sb().msgs = env2.sb().msgs.filter((m) => m !== gone);
    await env2.run({ now });
    await env2.run({ now });
    off = mailfill.MISS_GAP_MS + 1000;
    r = await env2.run({ now });
    ok((await env2.rows()).get(1002).srv === 'gone' && r.done, '준비 — 사라짐으로 적혔고 독 메일은 st:fail', (await env2.rows()).get(1002).srv);
    env2.sb().msgs.push(gone);
    env2.memo.retried.clear();
    r = await env2.run({ now });
    ok((await env2.rows()).get(1002).srv === null, '다시 보이면 지운다', (await env2.rows()).get(1002).srv);
    r = await env2.run({ now });
    rows = await env2.rows();
    ok(rows.get(1002).st === 'file' && env2.files().includes(1002) && r.done, '…다음 회차가 받는다', rows.get(1002).st);

    // 기다리는 동안 다시 보인 메일은 대기에서 빠지고 받는다
    off = 0;
    const env3 = setup([box('INBOX', mks(4))]);
    await headsOnly(env3);
    const back = env3.sb().msgs.find((m) => m.uid === 1001);
    env3.sb().msgs = env3.sb().msgs.filter((m) => m !== back);
    await env3.run({ now });
    ok(env3.memo.miss.get(env3.boxDir()).has(1001), '준비 — 대기 중');
    env3.sb().msgs.push(back);
    off = mailfill.MISS_GAP_MS + 1000;
    await env3.run({ now });
    ok(!env3.memo.miss.has(env3.boxDir()) && (await env3.rows()).get(1001).srv === undefined, '다시 보이면 대기에서 뺀다', (await env3.rows()).get(1001).srv);
    r = await env3.run({ now });
    ok(r.done && env3.files().includes(1001), '…그리고 받는다', r.why);
    off = 0;

    // 폴더를 연 김에 — 지난 검색이 1시간 넘었으면 사라진 줄을 다시 본다. exists 는 폴링이 이미 고쳐 줄어든 줄을 모른다
    const stale = async (later) => {
      const e = setup([box('INBOX', mks(4))]);
      await headsOnly(e);
      e.sb().msgs = e.sb().msgs.filter((m) => m.uid !== 1000);
      mailbackup.patchState(e.dir, 'a1', 'INBOX', { exists: 3 });
      await e.run({ now: () => Date.now() + later });
      return { asked: uidsOf(e.bodies()).includes(1000), waiting: !!(e.memo.miss.get(e.boxDir()) || new Map()).has(1000) };
    };
    const soon = await stale(0);
    ok(soon.asked && !soon.waiting, '대조 — 1시간 안이면 다시 묻지 않아 부른다', soon);
    const after = await stale(60 * 60_000 + 1000);
    ok(!after.asked && after.waiting, '1시간이 넘었으면 다시 물어 대기에 넣고 안 부른다', after);
  }

  console.log('\n[32] 파일 확인');
  {
    // 상태 파일을 잃고 메타도 없는 폴더 — 번호만 같은 옛 파일이 있다
    const msgs = mks(4);
    const env = setup([box('INBOX', msgs)]);
    const other = mk(1002, { tag: 'old-mail' });
    const oldSaved = await putFile(env, other);
    const zero = await putFile(env, msgs[1]);
    fs.writeFileSync(path.join(env.boxDir(), zero.name), Buffer.alloc(zero.bytes));
    const r = await env.run();
    const rows = await env.rows();
    const names = fs.readdirSync(env.boxDir());
    ok(uidsOf(env.bodies()).includes(1002) && rows.get(1002).file !== oldSaved.name && rows.get(1002).st === 'file', '같은 UID 에 다른 메일 파일이면 file 을 안 채우고 받는다', rows.get(1002).file);
    ok(names.includes(oldSaved.name), '…옛 파일은 건드리지 않는다', oldSaved.name);
    ok(names.includes(`${zero.name}.damaged`) && uidsOf(env.bodies()).includes(1001) && rows.get(1001).st === 'file', '0으로 찬 옛 파일(bytes 없음)은 .damaged 로 돌리고 받는다', rows.get(1001).file);
    ok(r.done, '끝난다', r.why);

    // 머리를 받은 줄 + 스캔이 끝난 폴더 — fillBodies 가 본다
    const msgs2 = mks(4);
    const env2 = setup([box('INBOX', msgs2)]);
    await headsOnly(env2);
    ok(env2.memo.scanned.has(env2.boxDir()), '준비 — 이번 실행의 스캔은 끝났다');
    const good = await putFile(env2, msgs2[3]);                       // 그 메일이 맞다
    await putFile(env2, mk(1002, { tag: 'other' }));                  // 다른 메일
    const z2 = await putFile(env2, msgs2[1]);                         // 0으로 찬 파일
    fs.writeFileSync(path.join(env2.boxDir(), z2.name), Buffer.alloc(z2.bytes));
    const mark = env2.server.log.length;
    const r2 = await env2.run();
    const got = uidsOf(env2.bodies(mark)).sort(asc);
    const rows2 = await env2.rows();
    ok(same(got, [1000, 1001, 1002]), '맞는 파일은 안 받고, 다른 메일·0으로 찬 파일은 받는다', got);
    ok(rows2.get(1003).file === good.name && rows2.get(1003).bytes === good.bytes && rows2.get(1003).st === 'file', '맞는 파일로 file 을 채운다', rows2.get(1003).file);
    ok(fs.existsSync(path.join(env2.boxDir(), `${z2.name}.damaged`)) && rows2.get(1001).st === 'file', '.damaged 로 비킨다');
    ok(r2.done, '끝난다', r2.why);

    // Message-ID 없는 메일 — 파일에도 없어야 같다
    const m3 = mk(1000, { id: null });
    const env3 = setup([box('INBOX', [m3])]);
    await headsOnly(env3);
    await putFile(env3, m3);
    const mark3 = env3.server.log.length;
    const r3 = await env3.run();
    ok(r3.done && env3.bodies(mark3).length === 0, 'Message-ID 가 양쪽에 없으면 같은 메일로 본다', env3.bodies(mark3).length);
  }

  console.log('\n[33] 회차 명령 수');
  {
    const boxes = [box('INBOX', mks(3))];
    for (let i = 1; i < 15; i++) boxes.push(box(`f${String(i).padStart(2, '0')}`, mks(3, 2000 + i * 100)));
    const env = setup(boxes, { delay: { connect: 3 } });
    const h = await headsOnly(env);
    ok(h.why === 'disk' && boxes.every((b) => env.rec(b.path).fillHead === true), '준비 — 폴더 15개의 머리가 끝났다', h.need);
    ok(env.memo.setupMs > 0, 'memo.setupMs 가 찬다', env.memo.setupMs);
    const listCount = () => env.server.log.filter((e) => e.cmd === 'list').length;
    ok(listCount() === 1, 'LIST 1번');
    let mark = env.server.log.length;
    let saved = 0;
    const r = await env.run({ onProgress: (p) => { saved = p.saved; }, shouldStop: () => saved >= 6 });
    const log = env.server.log.slice(mark);
    const first = log.findIndex((e) => e.cmd === 'fetch');
    ok(same(log.slice(0, first).map((e) => [e.cmd, e.path]).map(([c, p]) => (p ? `${c}:${p}` : c)), ['connect', 'mailboxOpen:INBOX']), '회차 앞 명령은 connect + 일감 폴더 EXAMINE 뿐이다', log.slice(0, first).map((e) => e.cmd));
    ok(log[first].query.source === true, '…그다음이 본문 FETCH 다');
    ok(r.why === 'stop' && listCount() === 1, 'LIST 는 다시 안 부른다', listCount());
    ok(env.rec().lowUid === 1, '받은편지함은 끝났다', env.rec().lowUid);
    mark = env.server.log.length;
    const r2 = await env.run();
    ok(!env.opens(mark).some((e) => e.path === 'INBOX') && r2.done, '끝난 폴더는 명령 0이다', env.opens(mark).map((e) => e.path).slice(0, 3));
    ok(env.server.log.slice(mark).filter((e) => e.path === 'INBOX').length === 0, '…SEARCH·FETCH 도 없다');
    const conns = env.server.clients.length;
    await env.run();
    ok(env.server.clients.length === conns, '끝난 계정은 연결을 만들지 않는다', env.server.clients.length - conns);
    env.sb('f03').msgs.push({ ...mk(9000), flags: new Set(), labels: new Set() });
    mailbackup.patchState(env.dir, 'a1', 'f03', { fillHead: false });
    await env.run({ now: () => Date.now() + mailfill.LIST_MS + 1 });
    ok(listCount() === 2, 'LIST 는 1시간에 한 번이다', listCount());
  }

  console.log('\n[34] 큰 메일과 몫');
  {
    const MB = 1024 * 1024;
    // 빠른 메일이 있으면 그것 먼저, 남은 일이 그뿐이면 몫을 늘린다
    const env = setup([box('INBOX', mks(2))]);
    const sizes = { 1001: 30 * MB, 1000: 9 * MB };
    await env.run({ connect: sized(env, sizes), freeBytes: async () => 0 });
    env.memo.bps = 5 * MB;
    const mark = env.server.log.length;
    const extends_ = [];
    let r = await env.run({ connect: sized(env, sizes), budgetMs: 3000, onProgress: (p) => { if (p.extendMs) extends_.push(p.extendMs); } });
    const order = uidsOf(env.bodies(mark));
    ok(same(order, [1000, 1001]), '속도로 봐 몫이 모자라면 시작하지 않고 다음 통으로 간다', order);
    ok(extends_.length === 1 && extends_[0] > 3000, '남은 일이 그 메일뿐이면 몫을 늘려 시작한다', extends_);
    ok(r.done, '끝난다', r.why);

    // 몫을 늘렸으니 원래 몫을 넘겨도 끊기지 않는다
    const slow = setup([box('INBOX', mks(1))]);
    const s2 = { 1000: 9 * MB };
    await slow.run({ connect: sized(slow, s2), freeBytes: async () => 0 });
    slow.memo.bps = 1 * MB;
    slow.server.spec.a1.delay = { fetch: 500 };
    const stretched = [];
    r = await slow.run({ connect: sized(slow, s2), budgetMs: 300, onProgress: (p) => { if (p.extendMs) stretched.push(p.extendMs); } });
    ok(r.saved === 1 && r.why !== 'budget', '늘린 몫 안에서 받는다 (FETCH 500ms, 원래 몫 300ms)', { saved: r.saved, why: r.why });
    ok(stretched.length === 1 && stretched[0] >= 13_000, '…min(상한, 크기/속도×1.5)', stretched);

    // 상한
    const cap = setup([box('INBOX', mks(1))]);
    await cap.run({ connect: sized(cap, s2), freeBytes: async () => 0 });
    cap.memo.bps = 1 * MB;
    const capped = [];
    await cap.run({ connect: sized(cap, s2), budgetMs: 300, bigTurnMs: 1000, onProgress: (p) => { if (p.extendMs) capped.push(p.extendMs); } });
    ok(same(capped, [1000]), 'bigTurnMs 가 상한이다', capped);

    // 큰 메일 때문에 폴더를 한 번 더 돌아도 거절된 메일은 같은 회차에 다시 안 부른다
    const twice = setup([box('INBOX', [mk(1000), { ...mk(1001), fetchNo: true }])]);
    const s3 = { 1000: 9 * MB };
    await twice.run({ connect: sized(twice, s3), freeBytes: async () => 0 });
    twice.memo.bps = 1 * MB;
    const mark2 = twice.server.log.length;
    await twice.run({ connect: sized(twice, s3), budgetMs: 300 });
    ok(same(uidsOf(twice.bodies(mark2)), [1001, 1000]) && (await twice.rows()).get(1001).fails === 1, '거절된 메일은 같은 회차에 다시 안 부른다', uidsOf(twice.bodies(mark2)));

    // 속도를 모르면 몫이 통째로 남았을 때만
    const unknown = setup([box('INBOX', mks(1))]);
    r = await unknown.run({ connect: sized(unknown, s2) });
    ok(r.saved === 0 && r.why === 'budget' && unknown.bodies().length === 0, '속도를 모르고 머리에 몫을 썼으면 시작하지 않는다', r.why);
    r = await unknown.run({ connect: sized(unknown, s2) });
    ok(r.saved === 1 && r.done, '…다음 회차에 몫이 통째로 있으면 시작한다', r.why);
    ok(unknown.memo.bps > 0, '…받은 바이트와 시간으로 속도를 안다', unknown.memo.bps > 0);
  }

  console.log('\n[35] 인증 판정');
  {
    const run = async (spec, o = {}) => {
      const env = setup([box('INBOX', mks(1))], spec);
      const r = await env.run(o);
      return { r, env };
    };
    let x = await run({ authFail: 'AUTHENTICATIONFAILED' });
    ok(x.r.why === 'auth' && !!x.r.error, 'AUTHENTICATIONFAILED 는 auth', [x.r.why, x.r.error]);
    x = await run({ authFail: 'UNAVAILABLE' });
    ok(x.r.why === 'refused' && !!x.r.error, 'UNAVAILABLE 은 refused', x.r.why);
    ok(x.env.server.log.filter((e) => e.cmd === 'list').length === 0, '…그 뒤로 명령이 없다');
    x = await run({ failConnect: true });
    ok(x.r.why === 'auth', '응답 글 Invalid credentials 도 auth', x.r.why);

    const throwing = (e) => {
      const env = setup([box('INBOX', mks(1))]);
      return env.run({ connect: withClient(env, (c) => { c.connect = async () => { throw e; }; }) });
    };
    let r = await throwing(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'LOGIN failed.' }));
    ok(r.why === 'auth', '응답 글 LOGIN failed 도 auth', r.why);
    r = await throwing(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    ok(r.why === 'connect' && r.error === mail.friendly(new Error('connect ECONNREFUSED')), '네트워크 오류는 connect', [r.why, r.error]);

    const ctl = new AbortController();
    setTimeout(() => ctl.abort('yield'), 30);
    x = await run({ delay: { connect: 5000 } }, { signal: ctl.signal });
    ok(x.r.why === 'yield' && !x.r.error, '끊은 것은 오류보다 먼저 본다 — 비킴을 연결 실패로 세지 않는다', x.r.why);
    x = await run({ delay: { connect: 5000 } }, { budgetMs: 30 });
    ok(x.r.why === 'budget', '연결 단계도 몫 안이다', x.r.why);
    const stop = new AbortController();
    stop.abort();
    x = await run({}, { signal: stop.signal });
    ok(x.r.why === 'stop' && x.env.server.clients.length === 0, "이미 멈춘 신호면 연결하지 않는다", x.r.why);
    x = await run({}, { shouldStop: () => true });
    ok(x.r.why === 'stop' && x.env.bodies().length === 0, "shouldStop 이면 why:'stop'", x.r.why);
    const broken = setup([box('INBOX', mks(1))]);
    fs.mkdirSync(path.join(broken.dir, mailbackup.STATE_FILE));    // 폴더를 파일 자리에 둔다 — 못 읽음
    r = await broken.run();
    ok(r.why === 'state' && broken.server.clients.length === 0, '상태 파일을 못 읽으면 연결도 안 한다', r.why);
  }

  console.log('\n[36] 서버를 부르지 않는 판정');
  {
    const dirOf = (name) => {
      const d = path.join(TMP, name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    const write = (d, recs) => fs.writeFileSync(path.join(d, mailbackup.STATE_FILE), JSON.stringify({ a1: recs }));
    const d = dirOf('judge');
    ok(same(mailfill.countPending(A, d), { left: null, leftBytes: null, boxes: 0 }), '기록 없음 — left:null', mailfill.countPending(A, d));
    ok(!mailfill.allBelow(A, d) && !mailfill.isDone(A, d), '기록 없음 — allBelow·isDone 거짓');

    write(d, { INBOX: { lowUid: 3000, exists: 2100 }, Shared: { exists: 500, fillSkip: true } });
    ok(same(mailfill.countPending(A, d), { left: 2100, leftBytes: null, boxes: 1, rough: true }), '파일 수를 빼지 않고 exists 를 그대로 더한다, fillSkip 은 뺀다. 위로 잡은 값이라고 표시한다', mailfill.countPending(A, d));
    ok(!mailfill.allBelow(A, d), 'lowUid>1 이면 allBelow 거짓');

    write(d, { INBOX: { lowUid: 3000 } });
    ok(mailfill.countPending(A, d).left === null, 'exists 가 없는 폴더뿐이면 left:null');

    write(d, { INBOX: { lowUid: 5, fillHead: true, fillLeft: 3, fillLeftBytes: 700, exists: 99 }, Sent: { lowUid: 9, fillLeft: 2, fillHead: true, fillLeftBytes: 300 } });
    ok(same(mailfill.countPending(A, d), { left: 5, leftBytes: 1000, boxes: 2 }), 'fillLeft 가 있으면 그 값, leftBytes 는 전 폴더가 fillHead 일 때만', mailfill.countPending(A, d));
    write(d, { INBOX: { lowUid: 5, fillHead: true, fillLeft: 3, fillLeftBytes: 700 }, Sent: { lowUid: 9, fillLeft: 2 } });
    ok(mailfill.countPending(A, d).leftBytes === null, '머리가 안 끝난 폴더가 있으면 leftBytes:null');

    write(d, { INBOX: { uidValidity: '7', lowUid: 1, exists: 0 }, Old: { uidValidity: '8', exists: 0 } });
    ok(mailfill.allBelow(A, d) && !mailfill.isDone(A, d), 'lowUid 가 없거나 1 이하면 allBelow 참 — 그것만으로 isDone 은 아니다');
    write(d, { INBOX: { uidValidity: '7', lowUid: 1, exists: 0 }, New: { fillHead: false } });
    ok(!mailfill.allBelow(A, d) && !mailfill.isDone(A, d), '아직 못 연 폴더의 빈 기록은 받은 것이 아니다');
    write(d, { INBOX: { uidValidity: '7', lowUid: 1, exists: 0 }, Drafts: { uidValidity: '8', lowUid: 1, exists: 0 } });
    ok(mailfill.allBelow(A, d, ['INBOX', 'Drafts']) && !mailfill.allBelow(A, d, ['INBOX', 'Drafts', 'Work']), '이번 LIST 에 있는 폴더의 기록이 없으면 allBelow 거짓');
    write(d, { INBOX: { uidValidity: '7', lowUid: 1, fillHead: true, fillLeft: 10 } });
    ok(!mailfill.isDone(A, d), '남은 줄이 있으면 lowUid≤1 이어도 다 받은 것이 아니다');
    write(d, { INBOX: { uidValidity: '7', lowUid: 1, fillHead: true } });
    ok(!mailfill.isDone(A, d), '…남은 수를 모르는 기록도 아니다 (confirmBox 는 늘 0을 적는다)');
    write(d, { INBOX: { uidValidity: '7', lowUid: 1, fillHead: true, fillLeft: 0, exists: 0 }, Shared: { uidValidity: '8', lowUid: 900, fillSkip: true } });
    ok(mailfill.isDone(A, d) && mailfill.allBelow(A, d), 'fillSkip 은 판정에서 뺀다');
    write(d, { Shared: { lowUid: 1, fillHead: true, fillSkip: true } });
    ok(!mailfill.isDone(A, d) && !mailfill.allBelow(A, d), '대상 폴더가 하나도 없으면 거짓이다');

    ok(mailfill.searchOk([1, 2], 2) && !mailfill.searchOk(false, 2) && !mailfill.searchOk([], 5) && mailfill.searchOk([], 0), 'searchOk — 배열, 빈 답');
    const list = Array.from({ length: 1000 }, (_, i) => i + 1);
    ok(mailfill.searchOk(list, 1020) && !mailfill.searchOk(list, 1021) && mailfill.searchOk(list.slice(0, 980), 1000) && !mailfill.searchOk(list.slice(0, 979), 1000), 'searchOk — 문턱 max(20, 2%)');
    ok(mailfill.searchOk(Array.from({ length: 4900 }), 5000) && !mailfill.searchOk(Array.from({ length: 4899 }), 5000), 'searchOk — 큰 폴더는 2%');
    ok(mailfill.searchOk([1], undefined), 'exists 를 모르면 수를 견주지 않는다');

    // 옛 파일 스캔
    const s = dirOf('scan');
    const msg = mk(1000);
    const boxDir = mailbackup.boxDirFor(s, A, 'INBOX', 1);
    fs.mkdirSync(boxDir, { recursive: true });
    await mailbackup.commit(boxDir, { uid: 1000, receivedAt: msg.date, subject: msg.subject, source: Buffer.from(msg.raw, 'latin1') });
    write(s, { INBOX: { uidValidity: String(V), gen: 1, lowUid: 1001, lastUid: 1000 }, Gone: { uidValidity: String(V), gen: 1 } });
    const realRec = mailindex.reconcile;
    let calls = 0;
    mailindex.reconcile = (...a) => { calls += 1; return realRec(...a); };
    try {
      let r = await mailfill.scanAccount(A, s, { skipBox: (p) => p === 'INBOX' });
      ok(calls === 0 && r.boxes === 0, 'skipBox 면 안 읽는다, 없는 폴더도 넘어간다', r);
      r = await mailfill.scanAccount(A, s, { shouldStop: () => true });
      ok(calls === 0 && r.stopped, 'shouldStop 이면 멈춘다', r.stopped);
      r = await mailfill.scanAccount(A, s);
      ok(calls === 1 && r.added === 1, '색인이 없으면 만든다', r);
      const idx = path.join(boxDir, mailindex.INDEX_FILE);
      const old = new Date(Date.now() - 3600_000);
      fs.utimesSync(boxDir, old, old);
      fs.utimesSync(idx, new Date(), new Date());
      calls = 0;
      r = await mailfill.scanAccount(A, s);
      ok(calls === 0 && r.boxes === 0, '폴더 mtime 이 색인보다 오래됐으면 읽지 않는다', r);
      fs.utimesSync(idx, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
      r = await mailfill.scanAccount(A, s);
      ok(calls === 1 && r.boxes === 1, '폴더가 더 새로우면 읽는다', r);
    } finally {
      mailindex.reconcile = realRec;
    }
  }

  console.log('\n[37] 몫 안에 못 받는 메일 (실제 몫 240초, 시계 200배)');
  {
    const SCALE = 200;
    const FOREVER = 60_000;
    const MB = 1024 * 1024;
    const realSet = global.setTimeout;
    // 회차의 몫 타이머만 줄인다. 색인·가짜 서버 타이머는 그대로
    global.setTimeout = (fn, ms, ...rest) => realSet(fn, ms >= 200_000 && ms <= 900_000 ? ms / SCALE : ms, ...rest);
    const t0 = Date.now();
    const vnow = () => t0 + (Date.now() - t0) * SCALE;
    // 잠자기 허용을 배율에 맞춘다 — 30초가 실제 150ms 면 코드가 멀쩡해도 PC 가 바쁠 때 잠든 것으로 읽혀 끊김을 안 센다
    const turn = (env, o = {}) => env.run({ budgetMs: 240_000, bigTurnMs: 480_000, now: vnow, sleepMs: 5000 * SCALE, ...o });
    try {
      // 오름차순으로 답하는 서버 — 느린 메일이 묶음 맨 앞이면 묶음 전체가 막힌다
      const env = setup([box('INBOX', mks(25))]);
      const conn = slowMail(env, { 1005: FOREVER });
      let r = await turn(env, { connect: conn });
      ok(env.files().length === 10 && env.memo.chunk === 5, '묶음이 몫을 다 쓰고 한 통도 못 받으면 묶음을 가른다', { files: env.files().length, chunk: env.memo.chunk });
      let turns = 1;
      while (!r.done && turns < 40) {
        r = await turn(env, { connect: conn });
        turns += 1;
      }
      const rows = await env.rows();
      ok(r.done && r.why === 'done' && turns < 40, `${turns}회차에 끝난다 — 영구 정체가 없다`, { why: r.why, turns });
      ok(env.files().length === 24 && !env.files().includes(1005), '그 아래 메일까지 24통을 다 받는다', env.files().length);
      ok(rows.get(1005).st === 'fail' && r.failed === 1 && env.rec().fillFail === 1, '느린 메일은 st:fail 이고 «못 받음»에 보인다', rows.get(1005));
      const conns = env.server.clients.length;
      await turn(env, { connect: conn });
      ok(env.server.clients.length === conns, '…같은 날에는 다시 받지 않는다', env.server.clients.length - conns);

      // 앱을 다시 켠 뒤 남은 일이 12MB 메일 하나 — 속도를 몰라도 몫을 늘려 보고, 안 되면 끝낸다
      const big = setup([box('INBOX', mks(1, 500))]);
      const conn2 = slowMail(big, { 500: FOREVER }, { 500: 12 * MB });
      const ext = [];
      const go = () => turn(big, { connect: conn2, onProgress: (p) => { if (p.extendMs) ext.push(p.extendMs); } });
      let x = await go();
      ok(x.why === 'budget' && big.bodies().length === 0, '속도를 모르고 머리에 몫을 썼으면 시작하지 않는다', x.why);
      x = await go();
      ok(big.bodies().length === 1 && big.memo.cuts.size === 1 && !ext.length && big.memo.bps === 0, '몫이 통째로 있으면 시작하고, 끊기면 센다', big.memo.cuts.size);
      x = await go();
      ok(ext.length === 1 && ext[0] === 480_000, '다음 회차는 속도를 몰라도 상한까지 몫을 늘린다', ext);
      ok((await big.rows()).get(500).st === 'head', '…아직 실패가 아니다');
      x = await go();
      ok((await big.rows()).get(500).st === 'fail', '3번 끊기면 st:fail', (await big.rows()).get(500).st);
      const sent = big.bodies().length;
      x = await go();
      ok(x.done && x.failed === 1 && big.bodies().length === sent, '…끝나고, 회차마다 다시 받지 않는다', { done: x.done, failed: x.failed });
      ok(sent === 3, '원문을 3번까지만 불렀다', sent);

      // 늘린 몫이면 끝나는 메일 — 실제 1.6초 = 시계 320초. 240초 몫에는 못 끝나고 480초 몫이면 끝난다
      const fits = setup([box('INBOX', mks(1, 700))]);
      await headsOnly(fits);
      const conn3 = slowMail(fits, { 700: 1600 });
      x = await turn(fits, { connect: conn3 });
      ok(x.saved === 0 && fits.memo.cuts.size === 1, '보통 몫에는 못 끝낸다', x.saved);
      x = await turn(fits, { connect: conn3 });
      ok(x.saved === 1 && x.done && fits.memo.cuts.size === 0 && (await fits.rows()).get(700).st === 'file', '늘린 몫이면 받는다 — 8MB 이하여도 같다', { saved: x.saved, why: x.why });

      // 모든 메일의 첫 줄이 몫보다 늦은 서버 — 통마다 한 번씩 끊겨 봐야 몫을 늘리면 30통 폴더는 30회차 동안 한 통도 못 받고, 그사이 물러나기가 간격을 늘린다
      const slowAll = setup([box('INBOX', mks(4, 800))]);
      await headsOnly(slowAll);
      const conn5 = slowMail(slowAll, { 800: 1600, 801: 1600, 802: 1600, 803: 1600 });
      slowAll.memo.chunk = 1;
      x = await turn(slowAll, { connect: conn5 });
      ok(x.saved === 0 && slowAll.memo.cuts.size === 1 && slowAll.memo.slowRow === true, '한 통이 몫 끝까지 첫 줄을 못 받으면 서버가 느린 것으로 적어 둔다', { saved: x.saved, slow: slowAll.memo.slowRow });
      x = await turn(slowAll, { connect: conn5 });
      ok(x.saved >= 1 && x.why === 'budget', '…다음 회차는 끊긴 적 없는 메일도 몫을 늘려 받는다', { saved: x.saved, why: x.why });
      ok((await slowAll.rows()).get(803).st === 'head', '…끊긴 메일은 실패가 아니다', (await slowAll.rows()).get(803).st);
      // 표시가 안 지워진 채로 통마다 늘리면 회차가 끝나지 않고 연결을 붙든다. 묶음은 한 통 받으면 커지므로, 둘째 통이 홀로 남는 3통 폴더로 본다
      const slow3 = setup([box('INBOX', mks(3, 810))]);
      await headsOnly(slow3);
      const conn6 = slowMail(slow3, { 810: 1600, 811: 1600, 812: 1600 });
      slow3.memo.chunk = 1;
      await turn(slow3, { connect: conn6 });
      const extS = [];
      x = await turn(slow3, { connect: conn6, onProgress: (p) => { if (p.extendMs) extS.push(p.extendMs); } });
      ok(x.why === 'budget' && slow3.memo.slowRow === true && extS.length === 1, '…표시가 남아 있어도 한 회차에 한 번만 늘린다', { why: x.why, slow: slow3.memo.slowRow, ext: extS.length });
      const quick = setup([box('INBOX', mks(3, 900))]);
      await headsOnly(quick);
      quick.memo.slowRow = true;
      quick.memo.chunk = 1;
      const extQ = [];
      x = await turn(quick, { onProgress: (p) => { if (p.extendMs) extQ.push(p.extendMs); } });
      ok(x.done && quick.memo.slowRow === false, '첫 줄이 다시 빨리 오면 표시를 지운다', { done: x.done, slow: quick.memo.slowRow, ext: extQ.length });
      ok(extQ.length === 1, '…한 회차에 한 번만 늘린다', extQ.length);

      // 잠자기 허용은 주입한 값을 쓴다 — 고정값이면 시계를 빨리 돌리는 이 시험이 PC 가 바쁠 때마다 흔들린다. 몫 절반을 넘으면 잠든 것으로 치게 주입한다
      const nap = setup([box('INBOX', mks(1, 400))]);
      await headsOnly(nap);
      x = await turn(nap, { connect: slowMail(nap, { 400: FOREVER }), sleepMs: -120_000 });
      ok(x.why === 'budget' && nap.memo.cuts.size === 0, '주입한 잠자기 허용을 넘긴 회차는 끊김을 세지 않는다', { why: x.why, cuts: nap.memo.cuts.size });

      // 폴링 2분 — 회차가 약 60초마다 비킨다
      const y = setup([box('INBOX', [mk(299), mk(300)])]);
      await headsOnly(y);
      const conn4 = slowMail(y, { 300: FOREVER });
      const yieldTurn = (ms) => {
        const ctl = new AbortController();
        realSet(() => ctl.abort('yield'), ms / SCALE);
        return turn(y, { signal: ctl.signal, connect: conn4 });
      };
      x = await yieldTurn(1000);
      ok(x.why === 'yield' && y.memo.cuts.size === 0, '시계 1초 만의 비킴은 메일 탓이 아니다', y.memo.cuts.size);
      for (let i = 0; i < 3; i++) x = await yieldTurn(60_000);
      let yRows = await y.rows();
      ok(x.why === 'yield' && yRows.get(300).st === 'head' && yRows.get(299).st === 'file', '비킴으로 3번 끊겨도 실패가 아니다 — 15분으로 늘려도 폴링이 먼저 끊는다', { st: yRows.get(300).st, fails: yRows.get(300).fails });
      for (const [k, v] of y.memo.cutSince) y.memo.cutSince.set(k, v - DAY - 1000);
      x = await yieldTurn(60_000);
      yRows = await y.rows();
      ok(x.why === 'yield' && yRows.get(300).st === 'fail', '…하루가 넘도록 못 받으면 st:fail', { st: yRows.get(300).st, fails: yRows.get(300).fails });
      x = await yieldTurn(60_000);
      ok(x.done && x.failed === 1, '…끝난다', x.why);
    } finally {
      global.setTimeout = realSet;
    }
  }

  console.log('\n[38] 닫힌 연결의 FETCH');
  {
    // imapflow 는 닫힌 뒤의 fetch 를 오류 없이 끝낸다 (mailbox 가 false). 가짜 서버는 던지므로 그 꼴로 바꾼다
    const silent = (env) => withClient(env, (c) => {
      const fetch = c.fetch.bind(c);
      c.fetch = async function* quiet(r, q, o) {
        if (c.closed) return;
        yield* fetch(r, q, o);
      };
    });
    const noFails = (rows) => [...rows.values()].every((x) => x.fails === undefined && x.hf === undefined);

    // 남은 공간을 보는 사이에 폴링이 온다
    const env = setup([box('INBOX', mks(12))]);
    await headsOnly(env);
    const ctl = new AbortController();
    let n = 0;
    const r = await env.run({
      signal: ctl.signal, connect: silent(env),
      freeBytes: async () => { if (++n === 2) ctl.abort('yield'); return PLENTY; }
    });
    ok(n === 2 && r.why === 'yield' && r.saved === 0, '준비 — 공간을 보는 사이에 비켰다', { n, why: r.why });
    ok(noFails(await env.rows()), '비킴이 묶음 전체의 실패로 세어지지 않는다', [...(await env.rows()).values()].filter((x) => x.fails).length);

    // 원문을 부르는 순간 연결이 죽었다
    const dead = setup([box('INBOX', mks(12))]);
    await headsOnly(dead);
    const r2 = await dead.run({ connect: withClient(dead, (c) => {
      const fetch = c.fetch.bind(c);
      c.fetch = async function* gone(u, q, o) {
        if (q.source) { c.close(); return; }
        yield* fetch(u, q, o);
      };
    }) });
    ok(r2.why === 'connect' && noFails(await dead.rows()), '끊긴 연결도 묶음 전체의 실패로 세지 않는다', r2.why);

    // 머리도 같다
    const head = setup([box('INBOX', mks(5))]);
    const r3 = await head.run({ connect: withClient(head, (c) => {
      c.fetch = async function* gone() { c.close(); };
    }) });
    ok(r3.why === 'connect' && noFails(await head.rows()), '머리 묶음도 hf 를 안 올린다', r3.why);
  }

  console.log('\n[39] \\All 의 dup 고리');
  {
    const N = 1000;
    const build = async () => {
      const twin = mk(1000, { tag: 'twin' });
      const all = mks(N, 2000);
      const env = setup([box('All Mail', all, { specialUse: '\\All' }), box('INBOX', [twin])]);
      const saved = await putFile(env, twin);
      mailindex.append(env.boxDir(), { uid: 1000, st: 'file', file: saved.name, at: 1, seen: false, mid: twin.messageId, size: 1, via: 'fill' });
      mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1000, fillHead: true, fillLeft: 0, exists: 1 });
      mailbackup.patchState(env.dir, 'a1', 'All Mail', { uidValidity: String(V), gen: 1, lowUid: 5, lastUid: 2000 + N, fillHead: true, fillLeft: 0, exists: N });
      for (const m of all) mailindex.append(env.boxDir('All Mail'), { uid: m.uid, st: 'dup', dupOf: { box: 'INBOX', uid: 1000 }, at: 1, seen: false, size: 1, mid: m.messageId, via: 'fill' });
      await mailindex.flush(env.boxDir());
      await mailindex.flush(env.boxDir('All Mail'));
      return env;
    };

    const realLoad = mailbackup.loadState;
    let loads = 0;
    mailbackup.loadState = (d) => { loads += 1; return realLoad(d); };
    let env;
    let r;
    try {
      env = await build();
      r = await env.run();
    } finally {
      mailbackup.loadState = realLoad;
    }
    ok(r.done && env.rec('All Mail').lowUid === 1, '준비 — 끊지 않으면 끝난다', r.why);
    ok(loads < 100, '줄마다 상태 파일을 읽지 않는다', loads);

    const realAccess = fs.promises.access;
    let calls = 0;
    const ctl = new AbortController();
    fs.promises.access = (...a) => {
      if (++calls === 150) ctl.abort('stop');
      return realAccess(...a);
    };
    try {
      env = await build();
      r = await env.run({ signal: ctl.signal });
    } finally {
      fs.promises.access = realAccess;
    }
    ok(r.why === 'stop' && calls < 400, '끊으면 고리가 곧 멈춘다', { why: r.why, calls });
    ok(env.rec('All Mail').lowUid === 5 && !r.done, '…끊겼으면 완료를 적지 않는다', env.rec('All Mail').lowUid);
    r = await env.run();
    ok(r.done, '…다음 회차가 잇는다', r.why);
  }

  console.log('\n[40] UIDNEXT 없는 서버의 빈 답');
  {
    const noNext = (p, msgs) => ({ path: p, uidValidity: V, msgs });
    // 받는 중
    const env = setup([noNext('INBOX', mks(20))]);
    mail.connect = (a) => env.server.connect(a);
    await headsOnly(env);
    let saved = 0;
    await env.run({ onProgress: (p) => { saved = p.saved; }, shouldStop: () => saved >= 10 });
    const before = env.rec();
    ok(before.fillHead === true && before.lowUid === 1010 && before.fillLeft === 10, '준비 — 받는 중', before);
    const keep = env.sb().msgs;
    env.sb().msgs = [];
    const empty = await mailbackup.backupAccount(A, env.dir, { onlyNew: true });
    ok(empty.boxErrors.length === 0 && env.rec().lowUid === 1010 && !env.done(), '빈 답 한 번으로 lowUid 를 안 내린다', env.rec().lowUid);
    env.sb().msgs = keep;
    const r = await drive(env);
    ok(r.done && env.files().length === 20, '…남은 메일까지 받고 끝난다', env.files().length);

    // 답이 없는 계정 — lowUid:1 로 읽히면 묻지 않고 yes 가 된다
    const fresh = setup([noNext('INBOX', mks(5))]);
    mail.connect = (a) => fresh.server.connect(a);
    await mailbackup.backupAccount(A, fresh.dir, { onlyNew: true });
    const low = fresh.rec().lowUid;
    fresh.sb().msgs = [];
    await mailbackup.backupAccount(A, fresh.dir, { onlyNew: true });
    ok(fresh.rec().lowUid === low && low > 1 && !mailfill.allBelow(A, fresh.dir), '답이 없는 계정도 빈 답으로 allBelow 가 안 된다', fresh.rec().lowUid);

    // 전체 받기도 빈 답 하나로 «다 받은 셈»이 되지 않는다
    const full = setup([noNext('INBOX', mks(5))]);
    mail.connect = (a) => full.server.connect(a);
    mailbackup.patchState(full.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1004, lastUid: 1004 });
    full.sb().msgs = [];
    await mailbackup.backupAccount(A, full.dir, {});
    ok(full.rec().lowUid === 1004, '전체 받기도 같다', full.rec().lowUid);

    // lowUid:1 이 다른 길로 적혔어도 남은 줄이 있으면 끝나지 않았다 — 회차가 받는다
    const other = setup([box('INBOX', mks(12))]);
    await headsOnly(other);
    mailbackup.patchState(other.dir, 'a1', 'INBOX', { lowUid: 1 });
    ok(!other.done() && other.rec().fillLeft === 12, 'fillLeft 가 남으면 isDone 거짓', other.rec().fillLeft);
    const r2 = await other.run();
    ok(r2.done && other.files().length === 12, '…회차가 그 폴더를 열어 받는다', other.files().length);
  }

  console.log('\n[41] 다 받은 계정의 거절된 새 메일');
  {
    const later = () => Date.now() + mailfill.RETRY_FAIL_MS + 1000;
    const newMail = (env, m) => env.sb().msgs.push({ ...m, flags: new Set(), labels: new Set() });
    const env = setup([box('INBOX', mks(3))]);
    mail.connect = (a) => env.server.connect(a);
    await drive(env);
    ok(env.done() && env.rec().fillFail === 0, '준비 — 다 받았다');
    newMail(env, { ...mk(2000), fetchNo: true });
    const opts = { onlyNew: true, dirProblem: () => null };
    const nr = await mailbackup.backupAccount(A, env.dir, opts);
    ok(nr.rejected === 1 && nr.boxErrors.length === 0, '폴더 오류가 아니라 거절 통수로 돌려준다', { rejected: nr.rejected, boxErrors: nr.boxErrors });
    ok(env.rec().fillFail === 1 && env.done(), '못 받은 수가 상태에 오르고, 정리 보류는 다시 걸리지 않는다', env.rec().fillFail);

    const conns = env.server.clients.length;
    await env.run();
    ok(env.server.clients.length === conns, '이번 하루의 재시도를 이미 끝낸 폴더는 안 연다', env.server.clients.length - conns);
    const mark = env.server.log.length;
    let r = await env.run({ now: later });
    ok(same(uidsOf(env.bodies(mark)), [2000]) && !r.saved, '하루가 지나면 뒤 받기가 그 메일을 부른다', uidsOf(env.bodies(mark)));
    ok(env.rec().fillLeft === 1 && !env.done(), '…못 받았으면 남은 일로 적는다', env.rec().fillLeft);
    r = await env.run({ now: later });
    const row = (await env.rows()).get(2000);
    ok(row.st === 'fail' && r.done && r.failed === 1, '…3번이면 st:fail 로 끝나고 «못 받음»에 보인다', { st: row.st, failed: r.failed });
    env.sb().msgs.find((m) => m.uid === 2000).fetchNo = false;
    env.memo.retried.clear();
    r = await env.run({ now: later });
    ok(env.files().includes(2000) && r.done && r.failed === 0, '서버가 나아지면 받고 수를 지운다', r.failed);

    // 폴링이 다시 불러도 같은 메일을 두 번 세지 않는다
    const twice = setup([box('INBOX', mks(2))]);
    mail.connect = (a) => twice.server.connect(a);
    await drive(twice);
    newMail(twice, { ...mk(2500), fetchNo: true });
    await mailbackup.backupAccount(A, twice.dir, opts);
    const nr2 = await mailbackup.backupAccount(A, twice.dir, opts);
    ok(nr2.rejected === 0 && twice.rec().fillFail === 1, '다시 불러도 같은 메일을 두 번 세지 않는다', twice.rec().fillFail);

    // 서버가 곧 나아지면 — 다음 폴링이 받고 수를 되돌린다
    const soon = setup([box('INBOX', mks(2))]);
    mail.connect = (a) => soon.server.connect(a);
    await drive(soon);
    newMail(soon, { ...mk(3000), fetchNo: true });
    await mailbackup.backupAccount(A, soon.dir, opts);
    soon.sb().msgs.find((m) => m.uid === 3000).fetchNo = false;
    const again = await mailbackup.backupAccount(A, soon.dir, opts);
    ok(again.saved === 1 && soon.rec().fillFail === 0, '다음 폴링이 받으면 못 받은 수를 되돌린다', soon.rec().fillFail);

    // 원문을 안 주는 메일 — 폴링은 다시 안 부른다
    const noSrc = setup([box('INBOX', mks(2))]);
    mail.connect = (a) => noSrc.server.connect(a);
    await drive(noSrc);
    newMail(noSrc, { ...mk(4000), noSource: true });
    const ns = await mailbackup.backupAccount(A, noSrc.dir, opts);
    ok(ns.missing === 1 && ns.rejected === 1 && noSrc.rec().fillFail === 1, '원문이 안 온 메일도 같다', { missing: ns.missing, fail: noSrc.rec().fillFail });

    // 앱을 다시 켜면 곧바로 한 번 본다 — 재시도 기억이 비었다
    noSrc.memo = {};
    const mark2 = noSrc.server.log.length;
    await noSrc.run();
    ok(same(uidsOf(noSrc.bodies(mark2)), [4000]), '앱을 다시 켜면 그 메일을 다시 부른다', uidsOf(noSrc.bodies(mark2)));
  }

  console.log('\n[42] 빈 답');
  {
    const GAP = mailfill.MISS_GAP_MS;
    let off = 0;
    const now = () => Date.now() + off;
    const onlyNew = { onlyNew: true };
    const noNext = (p, msgs) => ({ path: p, uidValidity: V, msgs });
    /** 폴링이 표시만 해 둔 폴더 — 머리도 아직이다. keep 은 서버에서 잠깐 안 보일 메일 */
    const marked = async (boxes) => {
      const e = setup(boxes);
      mail.connect = (a) => e.server.connect(a);
      await mailbackup.backupAccount(A, e.dir, onlyNew);
      e.keep = e.sb().msgs;
      return e;
    };
    /** UIDNEXT 를 안 주는 서버의 폴더에 기록을 직접 둔다 — lastUid 0 으로 증거를 하나씩 가른다 */
    const seeded = (fields, msgs = []) => {
      const e = setup([noNext('INBOX', msgs)]);
      mail.connect = (a) => e.server.connect(a);
      mailbackup.patchState(e.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 0, ...fields });
      return e;
    };

    // 보고된 꼴 — UIDNEXT 를 주는 서버가 첫 회차에 EXISTS 0 으로 한 번 답한다
    const env = await marked([box('INBOX', mks(3))]);
    env.sb().msgs = [];
    let r = await env.run({ now });
    let rec = env.rec();
    ok(!r.done && r.why !== 'done' && !env.done() && rec.lowUid === 1003, '메일이 있던 폴더의 첫 빈 답은 완료를 적지 않는다', { why: r.why, rec });
    ok(rec.fillEmptyAt > 0 && !rec.fillHead, '…시각을 적고, 머리가 끝났다고 적지 않는다', rec);
    ok(mailfill.countPending(A, env.dir).left === 3, '…남은 수도 그대로다 — 설정 줄이 «0통»이라고 안 한다', mailfill.countPending(A, env.dir));
    const at = rec.fillEmptyAt;

    let conns = env.server.clients.length;
    off = GAP - 2000;
    r = await env.run({ now });
    ok(env.server.clients.length === conns && !r.done && r.why === 'budget', '기다리는 동안은 연결을 안 만든다', env.server.clients.length - conns);

    env.memo = {};
    let mark = env.server.log.length;
    r = await env.run({ now });
    ok(env.opens(mark).length === 0 && !r.done && env.rec().fillEmptyAt === at, '앱을 다시 켜도 기다린다 — 시각은 상태 파일에 있고 폴더를 안 연다', env.opens(mark).length);

    await mailbackup.backupAccount(A, env.dir, onlyNew);
    ok(env.rec().fillEmptyAt === at && env.rec().lowUid === 1003 && !env.done(), '폴링의 빈 답은 시계를 안 건드린다', env.rec());

    off = GAP + 1000;
    env.memo = {};
    r = await env.run({ now });
    rec = env.rec();
    ok(r.done && r.why === 'done' && rec.lowUid === 1 && rec.fillHead === true && rec.fillLeft === 0, '10분 뒤 두 번째도 비면 완료를 적는다 (앱을 다시 켠 뒤에도)', { why: r.why, rec });
    ok(rec.fillEmptyAt === undefined, '…확인 칸이 사라진다', rec.fillEmptyAt);
    off = 0;

    // 돌아오면 정상 차례로 받는다 — fillHead 가 먼저 섰으면 머리 없이 한 통씩 받고, 크기와 읽음을 모른다
    const back = await marked([box('INBOX', mks(3))]);
    back.sb().msgs = [];
    await back.run({ now });
    back.sb().msgs = back.keep;
    off = GAP + 1000;
    r = await back.run({ now });
    let rows = await back.rows();
    ok(back.heads().length === 1 && rows.get(1002).size > 0 && rows.get(1002).seen === false, '메일이 돌아오면 머리부터 받는다', rows.get(1002));
    ok(r.done && back.files().length === 3 && back.rec().fillEmptyAt === undefined, '…다 받고 끝난다', { files: back.files(), rec: back.rec() });
    off = 0;

    // 사이에 메일이 보이면 처음부터
    const flip = await marked([box('INBOX', mks(3))]);
    flip.sb().msgs = [];
    await flip.run({ now });
    flip.sb().msgs = flip.keep;
    await mailbackup.backupAccount(A, flip.dir, onlyNew);
    ok(flip.rec().fillEmptyAt === 0 && !flip.done(), '폴링이 메일을 보면 시계를 지운다 — 칸은 남는다', flip.rec().fillEmptyAt);
    flip.sb().msgs = [];
    off = GAP + 1000;
    r = await flip.run({ now });
    ok(!r.done && flip.rec().fillEmptyAt >= Date.now() && flip.rec().lowUid === 1003, '첫 빈 답에서 10분이 지났어도 사이에 메일이 보였으면 첫 답으로 다시 센다', flip.rec());
    off = 2 * GAP + 2000;
    r = await flip.run({ now });
    ok(r.done, '…거기서 10분 뒤 또 비면 완료', r.why);
    off = 0;

    // 폴링이 메일을 봤으면 시계가 차기 전에 깨어난다
    const wake = await marked([box('INBOX', mks(3))]);
    wake.sb().msgs = [];
    await wake.run({ now });
    wake.sb().msgs = wake.keep;
    await mailbackup.backupAccount(A, wake.dir, onlyNew);
    r = await wake.run({ now });
    ok(r.done && wake.files().length === 3, '메일이 보였으면 10분을 기다리지 않고 받는다', wake.files());

    // EXISTS 를 안 주는 서버도 SEARCH 빈 답이면 같다. 폴링이 못 보므로 회차가 시계를 지운다
    const noExistsOf = (e) => withClient(e, (c) => {
      const open = c.mailboxOpen.bind(c);
      c.mailboxOpen = async (p, o) => {
        const b = await open(p, o);
        delete b.exists;
        return b;
      };
    });
    const noExists = await marked([box('INBOX', mks(3))]);
    noExists.connect = noExistsOf(noExists);
    noExists.sb().msgs = [];
    r = await noExists.run({ now });
    ok(!r.done && noExists.rec().fillEmptyAt > 0, 'EXISTS 없이 SEARCH 만 비어도 첫 답으로 센다', noExists.rec());
    noExists.sb().msgs = noExists.keep;
    off = GAP + 1000;
    let cut = 0;
    r = await noExists.run({ now, onProgress: () => { cut += 1; }, shouldStop: () => cut > 1 });
    ok(!r.done && noExists.rec().fillEmptyAt === 0, '…메일이 보이면 시계를 지운다', noExists.rec());
    r = await noExists.run({ now });
    ok(r.done && noExists.rec().fillEmptyAt === undefined, '…끝나면 칸이 사라진다', noExists.rec());
    off = 0;
    // 다 받고 확인만 남은 폴더 — EXISTS 가 없으면 본문 단계가 빈 답을 모른다. 완료를 적는 confirmBox 가 막아야 한다
    const lastLook = setup([box('INBOX', mks(3))]);
    lastLook.connect = noExistsOf(lastLook);
    let got = 0;
    await lastLook.run({ now, onProgress: (p) => { got = p.saved; }, shouldStop: () => got >= 3 });
    ok(lastLook.rec().fillHead === true && lastLook.rec().fillLeft === 0 && lastLook.rec().lowUid === 1000, '준비 — 다 받았고 확인 전이다', lastLook.rec());
    lastLook.sb().msgs = [];
    r = await lastLook.run({ now });
    ok(!r.done && lastLook.rec().fillEmptyAt > 0 && lastLook.rec().lowUid === 1000, '…confirmBox 가 첫 빈 답에 완료를 적지 않는다', lastLook.rec());

    // 증거
    r = await seeded({}).run({ now });
    ok(r.done && r.why === 'done', '증거가 없는 폴더(lastUid 0, exists 없음, 줄 없음)는 바로 완료', r.why);
    r = await setup([box('INBOX', [])]).run({ now });
    ok(r.done, '…UIDNEXT 를 주는 서버의 처음부터 빈 폴더도', r.why);
    const onlyExists = seeded({ exists: 5 });
    r = await onlyExists.run({ now });
    ok(!r.done && onlyExists.rec().fillEmptyAt > 0 && !onlyExists.rec().fillHead, '증거 — 전에 본 exists. 첫 답에 머리 끝남도 안 적는다', onlyExists.rec());
    const wiped = seeded({ exists: 5 });
    await mailbackup.backupAccount(A, wiped.dir, onlyNew);
    ok(wiped.rec().exists === 0, '준비 — 폴링이 빈 답을 먼저 적었다', wiped.rec().exists);
    r = await wiped.run({ now });
    ok(!r.done && wiped.rec().fillEmptyAt > 0, '…폴링이 exists 를 0 으로 덮어도 증거가 남는다', wiped.rec());
    const onlyRows = seeded({ exists: 0 });
    await putFile(onlyRows, mk(5));
    r = await onlyRows.run({ now });
    ok(!r.done && onlyRows.rec().fillEmptyAt > 0, '증거 — 색인의 줄', onlyRows.rec());
    off = GAP + 1000;
    r = await onlyRows.run({ now });
    ok(r.done && onlyRows.rec().fillHead === true && onlyRows.rec().lowUid === 1, '…10분 뒤 두 번째면 완료', { why: r.why, rec: onlyRows.rec() });
    off = 0;
    const renumber = seeded({ uidValidity: '1' });
    r = await renumber.run({ now });
    ok(!r.done && renumber.rec().gen === 2 && renumber.rec().fillEmptyAt > 0, '증거 — 번호를 새로 매긴 폴더 (기록이 통째로 바뀌어 옛 칸이 없다)', renumber.rec());

    // 받는 중에 빈 답 — 부르면 줄이 안 와 멀쩡한 메일에 fails 가 오른다
    const mid = setup([box('INBOX', mks(12))]);
    await headsOnly(mid);
    const midKeep = mid.sb().msgs;
    mid.sb().msgs = [];
    mark = mid.server.log.length;
    r = await mid.run({ now });
    rows = await mid.rows();
    ok(mid.bodies(mark).length === 0 && [...rows.values()].every((x) => x.fails === undefined), '받는 중의 첫 빈 답에는 본문을 안 부른다', mid.bodies(mark).length);
    ok(!r.done && mid.rec().fillEmptyAt > 0 && mid.rec().fillLeft === 12, '…남은 수는 그대로', mid.rec());
    conns = mid.server.clients.length;
    r = await mid.run({ now });
    ok(mid.server.clients.length === conns, '…기다리는 동안 연결을 안 만든다', mid.server.clients.length - conns);
    mid.sb().msgs = midKeep;
    off = GAP + 1000;
    r = await drive(mid, { now });
    ok(r.done && mid.files().length === 12 && r.failed === 0, '…돌아오면 다 받는다', { files: mid.files().length, failed: r.failed });
    off = 0;

    // 머리를 받은 메일이 정말 사라졌으면 — «모두 받음» 대신 못 받은 수가 남는다
    const emptied = setup([box('INBOX', mks(3))]);
    await headsOnly(emptied);
    emptied.sb().msgs = [];
    await emptied.run({ now });
    ok(!emptied.done(), '준비 — 첫 빈 답');
    off = GAP + 1000;
    r = await drive(emptied, { now });
    ok(r.done && r.failed === 3 && emptied.files().length === 0, '두 번째부터는 불러 보고 못 받음으로 끝난다', { why: r.why, failed: r.failed });
    off = 0;

    // 다른 길로 lowUid 가 내려가도 isDone 이 안 된다
    const side = await marked([box('INBOX', mks(3))]);
    side.sb().msgs = [];
    await side.run({ now });
    await mailbackup.backupAccount(A, side.dir, {});
    ok(!side.done(), '확인을 기다리는 폴더 — 전체 받기가 빈 답을 받아도 isDone 거짓', side.rec());
    mailbackup.patchState(side.dir, 'a1', 'INBOX', { lowUid: 1, fillHead: true, fillLeft: 0 });
    ok(!side.done(), '…완료의 세 칸이 다 차도 확인 칸이 있으면 isDone 거짓', side.rec());
    side.sb().msgs = side.keep;
    await mailbackup.backupAccount(A, side.dir, onlyNew);
    ok(side.rec().fillEmptyAt === 0 && !side.done(), '…폴링이 메일을 봐도 confirmBox 전에는 isDone 거짓', side.rec());
    r = await drive(side, { now });
    ok(r.done && side.files().length === 3, '…lowUid≤1 이어도 회차가 폴더를 열어 받고 끝낸다', side.files());

    // 다른 길 — LIST 에서 빠진 폴더는 fillSkip 으로 isDone 에서 빠진다. 확인 중이면 한 번 없다고 빼지 않는다
    const unlisted = await marked([box('INBOX', mks(2)), box('Drafts', mks(2, 3000))]);
    unlisted.sb('Drafts').msgs = [];
    await unlisted.run({ now });
    const without = () => {
      unlisted.server.spec.a1.boxes = unlisted.server.spec.a1.boxes.filter((b) => b.path !== 'Drafts');
      unlisted.memo.list = null;
    };
    without();
    r = await unlisted.run({ now });
    ok(!r.done && !unlisted.done() && !unlisted.rec('Drafts').fillSkip && unlisted.rec('Drafts').fillEmptyAt > 0, '확인 중인 폴더가 LIST 에서 한 번 빠져도 안 끝난다', { why: r.why, drafts: unlisted.rec('Drafts') });
    off = GAP + 1000;
    without();
    r = await unlisted.run({ now });
    ok(r.done && unlisted.rec('Drafts').fillSkip === true, '…10분 넘게 떨어져 또 없으면 뺀다 — 폴더를 정말 지운 계정이 영영 안 끝나면 안 된다', { why: r.why, drafts: unlisted.rec('Drafts') });
    off = 0;
    // 시계를 지운 뒤(폴링이 메일을 봤다) LIST 에서 빠지면 거기서 시계를 건다
    const unlisted2 = await marked([box('INBOX', mks(2)), box('Drafts', mks(2, 3000))]);
    unlisted2.sb('Drafts').msgs = [];
    await unlisted2.run({ now });
    mailbackup.patchState(unlisted2.dir, 'a1', 'Drafts', { exists: 2 });
    ok(unlisted2.rec('Drafts').fillEmptyAt === 0, '준비 — 시계가 지워졌다', unlisted2.rec('Drafts').fillEmptyAt);
    unlisted2.server.spec.a1.boxes = unlisted2.server.spec.a1.boxes.filter((b) => b.path !== 'Drafts');
    unlisted2.memo.list = null;
    r = await unlisted2.run({ now });
    ok(!r.done && !unlisted2.rec('Drafts').fillSkip && unlisted2.rec('Drafts').fillEmptyAt > 0, '…LIST 에서 빠지면 시계를 건다', unlisted2.rec('Drafts'));
    // 확인 중이 아닌 폴더는 전처럼 바로 뺀다
    const plain = setup([box('INBOX', mks(2)), box('Work', mks(2, 3000))]);
    await plain.run({ now });
    plain.server.spec.a1.boxes = plain.server.spec.a1.boxes.filter((b) => b.path !== 'Work');
    plain.memo.list = null;
    mailbackup.patchState(plain.dir, 'a1', 'Work', { lowUid: 5000 }, { raiseLow: true });
    ok(!plain.done(), '준비 — Work 는 안 끝났다', plain.rec('Work').lowUid);
    r = await plain.run({ now });
    ok(plain.rec('Work').fillSkip === true && r.done, '대조 — 확인 중이 아니면 LIST 에서 빠진 폴더를 바로 뺀다', plain.rec('Work'));

    // 확인 전의 폴더(몫이 끝나 confirmBox 를 못 돌았다) — 전체 받기가 빈 답 하나로 lowUid 를 1 로 내리면 곧 isDone 이다
    const before = setup([box('INBOX', mks(5))]);
    mail.connect = (a) => before.server.connect(a);
    let saved = 0;
    await before.run({ onProgress: (p) => { saved = p.saved; }, shouldStop: () => saved >= 5 });
    ok(before.rec().fillHead === true && before.rec().fillLeft === 0 && before.rec().lowUid === 1000 && !before.done(), '준비 — 다 받았고 확인 전이다', before.rec());
    const beforeKeep = before.sb().msgs;
    before.sb().msgs = [];
    await mailbackup.backupAccount(A, before.dir, {});
    ok(before.rec().lowUid === 1000 && !before.done(), '전체 받기의 빈 답은 뒤 받기가 맡은 폴더의 lowUid 를 안 내린다', before.rec());
    before.sb().msgs = beforeKeep;
    r = await before.run();
    ok(r.done, '…메일이 보이면 확인을 돌고 끝난다', r.why);
    // 메일이 있는 답에는 전처럼 내려간다
    const lower = setup([box('INBOX', mks(5))]);
    mail.connect = (a) => lower.server.connect(a);
    await headsOnly(lower);
    await mailbackup.backupAccount(A, lower.dir, {});
    ok(lower.rec().lowUid === 1 && lower.files().length === 5, '대조 — 메일이 있으면 전체 받기가 전처럼 내려간다', lower.rec().lowUid);

    // 시계를 되돌렸으면 영영 기다리지 않는다
    const clock = await marked([box('INBOX', mks(3))]);
    clock.sb().msgs = [];
    mailbackup.patchState(clock.dir, 'a1', 'INBOX', { fillEmptyAt: Date.now() + DAY });
    mark = clock.server.log.length;
    r = await clock.run({ now });
    ok(clock.opens(mark).length === 1 && !r.done && clock.rec().fillEmptyAt <= Date.now(), '시각이 앞이면 폴더를 열고 첫 답으로 다시 센다', clock.rec().fillEmptyAt);

    // 이미 다 받은 폴더 — 새로 적을 것이 없는데 빈 답 하나로 정리 보류가 다시 걸리면 안 된다
    const ended = setup([box('INBOX', mks(3).map((m) => (m.uid === 1001 ? { ...m, fetchNo: true } : m)))]);
    mail.connect = (a) => ended.server.connect(a);
    r = await drive(ended, { now });
    ok(r.done && r.failed === 1, '준비 — 다 받았고 독 메일 하나', r.failed);
    ended.sb().msgs = [];
    await mailbackup.backupAccount(A, ended.dir, onlyNew);
    ended.memo.retried.clear();
    mark = ended.server.log.length;
    r = await ended.run({ now });
    ok(ended.opens(mark).length === 1 && r.done && ended.done() && ended.rec().fillEmptyAt === undefined, '다 받은 폴더를 다시 열어 빈 답을 봐도 그대로다', ended.rec());

    // 다른 폴더는 그대로 받고, 계정만 끝나지 않는다
    const two = await marked([box('INBOX', mks(3)), box('Drafts', mks(2, 3000))]);
    two.sb('Drafts').msgs = [];
    r = await two.run({ now });
    ok(two.files().length === 3 && two.rec().lowUid === 1 && !r.done && two.rec('Drafts').fillEmptyAt > 0, '다른 폴더는 받고, 빈 답 폴더 때문에 계정이 안 끝난다', { why: r.why, drafts: two.rec('Drafts') });
    off = GAP + 1000;
    r = await two.run({ now });
    ok(r.done, '…10분 뒤 두 번째면 계정이 끝난다', r.why);
    off = 0;
  }

  console.log('\n[43] 자동 yes 는 파일을 본다');
  {
    const env = setup([box('INBOX', mks(20))]);
    const put = (rec) => mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1019, ...rec });
    put({ exists: 20 });
    ok(!mailfill.allBelow(A, env.dir), '기록이 lowUid≤1 이어도 파일이 없으면 거짓 — 사용자가 옮겼거나 빈 답 한 번에 내려간 기록이다');
    const msgs = env.sb().msgs;
    for (const m of msgs.slice(0, 17)) await putFile(env, m);
    ok(!mailfill.allBelow(A, env.dir), '…20통 중 17개면 거짓');
    await putFile(env, msgs[17]);
    ok(mailfill.allBelow(A, env.dir), '…18개(90%)면 참');
    put({ exists: 5 });
    ok(mailfill.allBelow(A, env.dir), '정리가 옮겨 서버 수가 줄어도 사본이 남으니 참');
    ok(!mailfill.allBelow({ ...A, name: '이름 바꿈' }, env.dir), '설정 파일에서 계정 이름을 바꿔 자리가 달라지면 파일이 안 보여 거짓');
    const empty = setup([box('INBOX', [])]);
    mailbackup.patchState(empty.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 0, exists: 0 });
    ok(mailfill.allBelow(A, empty.dir), '빈 폴더는 파일 없이 참');
    const unknown = setup([box('INBOX', mks(3))]);
    mailbackup.patchState(unknown.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1002 });
    ok(!mailfill.allBelow(A, unknown.dir), '서버 수를 모르면 근거가 없어 거짓');
    const moved = setup([box('INBOX', mks(3))]);
    mailbackup.patchState(moved.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 2, lowUid: 1, lastUid: 1002, exists: 3 });
    fs.mkdirSync(moved.boxDir('INBOX', 2), { recursive: true });
    for (const m of moved.sb().msgs) await mailbackup.commit(moved.boxDir('INBOX', 2), { uid: m.uid, receivedAt: m.date, subject: m.subject, source: Buffer.from(m.raw, 'latin1') });
    ok(mailfill.allBelow(A, moved.dir), '그 세대의 폴더를 본다');

    // 빈 답 확인이 남은 폴더 — 비었는지 아직 모른다. 잘못된 «아니오»의 값은 질문 한 번이고, 잘못된 «예»의 값은 동의 없이 메일함 전체다
    const quiet = setup([box('INBOX', []), box('Drafts', [])]);
    const putBox = (p, o = {}) => mailbackup.patchState(quiet.dir, 'a1', p, { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 0, exists: 0, ...o });
    putBox('INBOX');
    putBox('Drafts');
    ok(mailfill.allBelow(A, quiet.dir), '(대조) 확인 칸이 없으면 참');
    putBox('Drafts', { fillEmptyAt: Date.now() });
    ok(!mailfill.allBelow(A, quiet.dir), '한 폴더라도 빈 답 확인 중이면 거짓');
    putBox('Drafts', { fillEmptyAt: 0 });
    ok(!mailfill.allBelow(A, quiet.dir), '시계만 지워진 칸(0)도 거짓 — 메일이 보여 지웠을 뿐 칸은 confirmBox 가 지운다');
    putBox('Drafts', { fillEmptyAt: Date.now() - 7 * DAY, fillSkip: true });
    ok(!mailfill.allBelow(A, quiet.dir), 'LIST 에서 빠져 표시된 폴더에 칸이 남아도 거짓 — 틀려도 질문 한 번이다');
    const noted = setup([box('INBOX', mks(3))]);
    mailbackup.patchState(noted.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1002, exists: 3, fillEmptyAt: Date.now() });
    for (const m of noted.sb().msgs) await putFile(noted, m);
    ok(!mailfill.allBelow(A, noted.dir), '파일이 다 있어도 거짓');
  }

  console.log('\n[44] UIDVALIDITY 를 늘 안 주는 폴더');
  {
    const seed = (env, p, v) => mailbackup.patchState(env.dir, 'a1', p, { uidValidity: v, gen: 1, lowUid: 1, lastUid: 9000, exists: 3 });
    const env = setup([box('INBOX', mks(3), { noUidValidity: true }), box('Work', mks(2, 2000))]);
    seed(env, 'INBOX', 'undefined');
    const r = await drive(env);
    ok(r.done && same(r.boxErrors, []) && env.files('Work').length === 2, '다른 폴더는 받고 끝난다 — 폴더 오류가 아니다', { done: r.done, errors: r.boxErrors });
    ok(env.files('INBOX').length === 0 && !env.opens().some((e) => e.path === 'INBOX'), '…그 폴더는 열지도 받지도 않는다');
    ok(env.rec('INBOX').gen === 1 && env.rec('INBOX').uidValidity === 'undefined', '…기록이 그대로다', env.rec('INBOX'));
    ok(mailfill.countPending(A, env.dir).boxes === 1 && mailfill.unfillable(A, env.dir) === 1, '…남은 수에서 빠지고 따로 센다', mailfill.unfillable(A, env.dir));

    const only = setup([box('INBOX', mks(2), { noUidValidity: true })]);
    seed(only, 'INBOX', '0');
    ok(only.done(), '그런 폴더뿐이면 받을 것이 없다 — 정리 보류가 영영 안 풀리면 안 된다 (정리는 그 폴더를 스스로 건너뛴다)');
    ok(!mailfill.allBelow(A, only.dir), '…묻지 않고 yes 로 적을 근거도 아니다');
    await putFile(only, only.sb().msgs[0]);
    const s = await mailfill.scanAccount(A, only.dir);
    ok(s.boxes === 0 && !fs.existsSync(path.join(only.boxDir(), mailindex.INDEX_FILE)), '옛 파일 스캔이 색인을 만들지 않는다 — 메타 없는 색인이 생기면 세대를 못 가른다', s);
    ok(!mailfill.allBelow(A, setup([]).dir) && !mailfill.isDone(A, setup([]).dir), '(기록이 없으면 그대로 거짓)');

    // 그 폴더는 머리를 안 받는다 — 공간 판단이 그 폴더를 기다리면 남은 양과 견주지 못한 채 본문부터 받아 바닥까지 채운다
    const room = setup([box('INBOX', mks(2), { noUidValidity: true }), box('Work', mks(2, 2000))]);
    seed(room, 'INBOX', 'undefined');
    const need = room.sb('Work').msgs.reduce((sum, m) => sum + Buffer.byteLength(m.raw, 'latin1'), 0);
    const rr = await room.run({ freeBytes: async () => 1_000_000, minFree: async () => 1_000_000 - need + 1 });
    ok(rr.why === 'disk' && rr.need === 1 && rr.saved === 0, '공간 판단은 그 폴더를 기다리지 않는다', { why: rr.why, need: rr.need, saved: rr.saved });
  }

  console.log('\n[45] ENVELOPE 에 Message-ID 를 안 주는 서버');
  {
    const plain = (n, from = 1000) => mks(n, from).map((m) => ({ ...m, messageId: undefined }));
    const env = setup([box('INBOX', plain(6))]);
    for (const m of env.sb().msgs) await putFile(env, m);
    mailbackup.patchState(env.dir, 'a1', 'INBOX', { uidValidity: String(V), gen: 1, lowUid: 1, lastUid: 1005, exists: 6 });
    const r = await drive(env);
    ok(r.done && r.saved === 0 && env.bodies().length === 0, '받아 둔 메일을 다시 받지 않는다', { saved: r.saved, bodies: env.bodies().length });
    const row = (await env.rows()).get(1003);
    ok(row.st === 'file' && !!row.file && row.mid === '<m1003@corp.invalid>', '…줄의 Message-ID 를 빈 값으로 덮지 않는다', row);

    // 줄이 먼저 있고 파일이 뒤에 생겼다 — 크기가 같으면 그 메일로 본다
    const late = setup([box('INBOX', plain(4))]);
    await headsOnly(late);
    const m2 = late.sb().msgs.find((m) => m.uid === 1002);
    await putFile(late, m2);
    await mailbackup.commit(late.boxDir(), { uid: 1001, receivedAt: m2.date, subject: 'other', source: Buffer.from('Message-ID: <other@corp.invalid>\r\nSubject: other\r\n\r\nother', 'latin1') });
    const r2 = await drive(late);
    const got = uidsOf(late.bodies());
    ok(r2.done && !got.includes(1002) && got.includes(1001), '크기가 같은 파일은 받지 않고, 다른 메일 파일은 받는다', got);
  }

  console.log('\n[46] 끊겨서 아무것도 못 받은 회차');
  {
    const env = setup([box('INBOX', mks(3))], { delay: { connect: 400 } });
    let r = await env.run({ budgetMs: 60 });
    ok(r.why === 'budget' && r.noGain === true && r.heads === 0, '연결 중에 몫이 끝났다 — noGain', { why: r.why, noGain: r.noGain });
    ok(env.memo.setupMs >= 50, '…걸린 시간을 배운다. 첫 FETCH 전에 끊기면 안 찼던 값이다', env.memo.setupMs);
    const c1 = new AbortController();
    setTimeout(() => c1.abort('yield'), 30);
    r = await env.run({ signal: c1.signal });
    ok(r.why === 'yield' && r.noGain === true, '비켜도 같다', { why: r.why, noGain: r.noGain });
    const c2 = new AbortController();
    setTimeout(() => c2.abort('stop'), 30);
    r = await env.run({ signal: c2.signal });
    ok(r.why === 'stop' && !r.noGain, '«멈추기»는 아니다 — 사용자가 끊었다', r.noGain);
    env.server.spec.a1.delay = null;
    r = await env.run();
    ok(r.done && !r.noGain, '끝까지 받은 회차는 아니다', r.noGain);
    const some = setup([box('INBOX', mks(30))]);
    let saved = 0;
    const c3 = new AbortController();
    r = await some.run({ signal: c3.signal, onProgress: (p) => { saved = p.saved; if (saved >= 10) c3.abort('yield'); } });
    ok(r.why === 'yield' && r.saved >= 10 && !r.noGain, '받다가 비킨 회차도 아니다', { saved: r.saved, noGain: r.noGain });
  }

  console.log('\n[47] 다 받은 계정의 재시도가 폴더 오류로 끝난다');
  {
    const env = setup([box('INBOX', mks(3).map((m) => (m.uid === 1001 ? { ...m, fetchNo: true } : m)))]);
    let r = await drive(env);
    ok(r.done && r.failed === 1, '준비 — 다 받았고 독 메일 하나', r.failed);
    env.memo.retriedAt -= mailfill.RETRY_FAIL_MS + 1000;
    ok(mailfill.retryDue(A, env.dir, env.memo), '(하루가 지났다)');
    r = await env.run({ connect: failOpen(env, 'INBOX') });
    ok(r.why === 'done' && r.boxErrors.length === 1, '폴더를 못 열었다 — 다 받은 것은 그대로', { why: r.why, errors: r.boxErrors });
    ok(!mailfill.retryDue(A, env.dir, env.memo), '…그날 몫을 쓴 것이다. 안 그러면 물러나기 없이 30초마다 로그인한다');
    env.memo.retriedAt -= mailfill.RETRY_FAIL_MS + 1000;
    ok(mailfill.retryDue(A, env.dir, env.memo), '…다음 날 다시 부른다');
  }

  console.log('\n[48] SEARCH ALL 이 EXISTS 보다 늘 조금 적은 서버');
  {
    let off = 0;
    const now = () => Date.now() + off;
    const GAP = mailfill.MISS_GAP_MS + 1000;
    const env = setup([box('INBOX', mks(50), { searchShort: 49 })]);
    let r = await env.run({ now });
    ok(!r.done && env.files().length === 49 && /믿을 수 없습니다/.test(r.boxErrors[0] || ''), '첫 답으로는 완료를 적지 않는다', r.boxErrors);
    r = await env.run({ now });
    ok(!r.done && !env.done(), '곧바로 온 같은 답으로도 아니다', r.why);
    off = GAP;
    r = await env.run({ now });
    ok(r.done && env.rec().lowUid === 1 && r.boxErrors.length === 0, '10분 넘게 떨어진 두 답이 같으면 그 수를 믿는다', { done: r.done, errors: r.boxErrors });

    off = 0;
    const moved = setup([box('INBOX', mks(50), { searchShort: 49 })]);
    await moved.run({ now });
    off = GAP;
    moved.sb().searchShort = 48;
    r = await moved.run({ now });
    ok(!r.done, '답의 수가 달라지면 처음부터 다시 잰다', r.why);
    off = GAP * 2;
    r = await moved.run({ now });
    ok(r.done, '…다시 10분이 지나 같으면 믿는다', r.why);

    off = 0;
    const far = setup([box('INBOX', mks(50), { searchShort: 40 })]);
    await far.run({ now });
    off = GAP;
    r = await far.run({ now });
    off = GAP * 2;
    r = await far.run({ now });
    ok(!r.done && far.rec().lowUid > 1, '부족분이 크면 몇 번을 답해도 안 믿는다 — 답이 잘린 것이다', far.rec().lowUid);

    // 시계를 되돌렸다 — 앞선 시각에 묶이면 그 시각이 다시 올 때까지 완료를 못 적어 정리 보류가 안 풀린다
    off = GAP * 5;
    const back = setup([box('INBOX', mks(50), { searchShort: 49 })]);
    await back.run({ now });
    off = 0;
    r = await back.run({ now });
    ok(!r.done, '시계가 뒤로 가면 그 답은 믿지 않고 처음부터 다시 잰다', r.why);
    off = GAP;
    r = await back.run({ now });
    ok(r.done, '…거기서 10분이 지나 같으면 믿는다', r.why);
  }

  console.log('\n[49] 맨 위 UID 들이 서버에서 지워졌다');
  {
    let off = 0;
    const now = () => Date.now() + off;
    const env = setup([box('INBOX', mks(30))]);
    await headsOnly(env);
    env.sb().msgs = env.sb().msgs.filter((m) => m.uid < 1010);
    let r = await env.run({ now });
    let rows = await env.rows();
    ok(rows.get(1029).fails === undefined && env.memo.miss.get(env.boxDir()).has(1029) && !r.done, '답의 수가 EXISTS 와 맞으면 맨 위 줄도 두 번 확인에 넣는다', rows.get(1029));
    off = mailfill.MISS_GAP_MS + 1000;
    r = await env.run({ now });
    rows = await env.rows();
    ok(r.done && r.failed === 0 && rows.get(1029).srv === 'gone' && env.files().length === 10, '…10분 뒤 사라짐으로 적고 «못 받음»이 남지 않는다', { failed: r.failed, srv: rows.get(1029).srv });
  }

  console.log('\n[50] 전에 끊긴 메일끼리');
  {
    const FOREVER = 60_000;
    const env = setup([box('INBOX', [mk(500), mk(501)])]);
    await headsOnly(env);
    for (const u of [500, 501]) env.memo.cuts.set(`${env.boxDir()}\n${u}`, 0);
    const go = async () => {
      const ctl = new AbortController();
      const base = slowMail(env, { 500: FOREVER, 501: FOREVER });
      return env.run({ signal: ctl.signal, connect: (a) => {
        const c = base(a);
        const fetch = c.fetch.bind(c);
        c.fetch = (u, q, o) => { if (q.source) setTimeout(() => ctl.abort('yield'), 10); return fetch(u, q, o); };
        return c;
      } });
    };
    await go();
    await go();
    await go();
    ok(same(uidsOf(env.bodies()), [501, 500, 501]), '차례로 시도한다 — 앞 메일이 뒤 메일을 영영 막지 않는다', uidsOf(env.bodies()));
  }

  console.log('\n[51] 대소문자만 다른 폴더');
  {
    const twin = mks(5).map((m, i) => mk(m.uid, { tag: `w${i}` }));
    const env = setup([box('Work', mks(5)), box('WORK', twin)]);
    mail.connect = (a) => env.server.connect(a);
    await mailbackup.backupAccount(A, env.dir, { onlyNew: true });
    ok(env.rec('Work').gen !== env.rec('WORK').gen, '같은 세대를 주지 않는다 — NTFS 에서 한 폴더다', [env.rec('Work').gen, env.rec('WORK').gen]);
    const r = await drive(env);
    ok(r.done && env.files('Work', env.rec('Work').gen).length === 5 && env.files('WORK', env.rec('WORK').gen).length === 5, '둘 다 끝까지 받는다 — 앞 폴더의 줄을 자기 메일로 읽어 안 받지 않는다', { w: env.files('Work').length });
  }

  console.log('\n[52] 계정 전체의 거절 — 한 통씩 다시 받지 않는다');
  {
    // Gmail 하루 한도처럼 서버가 모든 FETCH 를 거절한다 — 망가진 메일 하나가 아니다
    const env = setup([box('INBOX', mks(30))], { fetchRefuse: { serverResponseCode: 'ALERT', responseText: 'Account exceeded command or bandwidth limits. (Failure)' } });
    const r = await env.run();
    const fetches = env.server.log.filter((e) => e.cmd === 'fetch').length;
    ok(fetches <= 2, '묶음이 거절되면 한 통씩 다시 받지 않는다 (FETCH 2번 이하)', fetches);
    ok(r.why === 'refused' && /하루 사용량 한도/.test(r.error || '') && !r.done, '…회차를 «refused»와 그 까닭으로 끝낸다', { why: r.why, error: r.error });
    ok(env.clean(), '…읽기만 했다 (금지 명령 0 · 모두 EXAMINE)');
    const rows = await env.rows();
    ok([...rows.values()].every((x) => !(Number(x.hf) > 0) && !(Number(x.fails) > 0)), '…메일마다 실패를 적지 않는다 (서버 사정이지 메일 탓이 아니다)', [...rows.values()].slice(0, 3));
  }
  {
    const env = setup([box('INBOX', mks(10))], { fetchRefuse: { serverResponseCode: 'THROTTLED', responseText: 'Slow down' } });
    const r = await env.run();
    ok(r.why === 'refused' && /속도를 제한/.test(r.error || '') && env.server.log.filter((e) => e.cmd === 'fetch').length <= 2, 'THROTTLED 도 같다', { why: r.why, error: r.error });
  }
  {
    // 메일 한 통만 거절 — 지금처럼 한 통씩 다시 받아 그 메일만 가린다
    const msgs = mks(5);
    msgs[2].fetchNo = true;
    const env = setup([box('INBOX', msgs)]);
    const r = await env.run();
    ok(env.files().length === 4 && r.why !== 'refused', '메일 한 통의 거절은 그 통만 가린다 (회차는 이어 간다)', { files: env.files().length, why: r.why });
  }

  mail.connect = realConnect;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

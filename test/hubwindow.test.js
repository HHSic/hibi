'use strict';
// «새 메일»의 경계 — 진짜 refreshMail 을 돌려 본다 (src/mailhub.js).
//
// Electron 으로 돌지만 창을 하나도 띄우지 않는다. main.js 도 싣지 않는다 — mailhub.js 를 바로 싣는다.
// 싣기 전에 바꿔 끼운다: secret(모듈째 — 자격 증명 관리자 코드는 싣지도 않는다), mail.fetchSummary·moveToSpam·markRead,
// backup.autoBackupNew, mailbody.prefetchBodies, autofwd.forwardNew. 진짜 메일 서버에는 붙지 않는다. 가짜 계정 주소는 *.invalid 다.
// 데이터 폴더도 임시다.
// 창은 «마지막 N통»이라 서버 정리가 옮긴 자리로 옛 메일이 밀려 들어온다. 그 메일은 known 에 없지만 새 메일이 아니다.
//   [0] 쓸 계정이 없으면 prepareMail 을 부르지 않는다
//   [1] «바로» — 창 45통이 차례로 빠지며 옛 메일이 창에 들어온다. pending 0, 주소록 변화 0, moveToSpam·markRead 0, 화면에는 보인다
//   [2] 폴링 한 번 실패 뒤 성공 — pending 0, 주소록 변화 0. 실패한 사이 온 메일은 놓치지 않는다
//   [3] 진짜 새 메일 — pending 1, 주소록 +1, 규칙이 서버로 나간다
//   [4] 규칙을 바꾸면 그때 창에 있던 메일까지 걸리고, 그보다 옛 메일은 안 걸린다
//   [5] UIDVALIDITY 변경 — 그 판은 세지 않는다
//   [6] 옮기기를 멈춘 계정의 스팸 규칙 — 알림은 한 번, «다시 해봅니다»라고 하지 않고, 풀리면 다음 폴링에 나간다
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 90_000).unref();

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubwindow-'));
for (const d of ['Hibi', 'home', 'docs']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));
app.setPath('home', path.join(tmp, 'home'));
app.setPath('documents', path.join(tmp, 'docs'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 규칙은 최근 메일부터 보내므로 UID 차례가 뒤집혀 나간다 — 무엇이 나갔는지만 본다 */
const asc = (a) => JSON.stringify([...a].sort((x, y) => x - y));

const V = 1700000000n;
const BASE = Date.UTC(2026, 0, 1);
const RULES = [
  { field: 'from', match: '*@spam.invalid', action: 'spam' },
  { field: 'from', match: '*@alert.invalid', action: 'read' }
];

app.whenReady().then(async () => {
  // 비밀번호는 시험용 값뿐이다. 모듈째 바꿔 끼워 credstore.js(자격 증명 관리자)가 실리지 않게 한다
  const secretPath = require.resolve(path.join(ROOT, 'src', 'secret.js'));
  require.cache[secretPath] = {
    id: secretPath,
    filename: secretPath,
    loaded: true,
    exports: {
      available: true, wincred: false, lastError: 0,
      open: (s) => (s ? 'fake-pass' : null),
      isLegacy: () => false, isRef: () => false, seal: () => null, remove: () => true, sweep: () => 0
    }
  };

  const store = require(path.join(ROOT, 'src', 'store.js'));
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  evlog.log = () => {};
  const mail = require(path.join(ROOT, 'src', 'mail.js'));

  // ── 가짜 서버 — 계정 id → { v, hi, msgs, fail } ──
  const server = new Map();
  const calls = { spam: [], read: [], fetch: 0 };
  let lastTouch = Date.now();
  const touch = () => { lastTouch = Date.now(); };
  /** 메일 한 통 — 보낸 사람 도메인으로 규칙에 걸린다 */
  const mk = (uid, o = {}) => ({
    uid,
    subject: `report ${uid}`,
    from: `사람${uid}`,
    fromAddress: `${o.who || 'kim'}${uid}@${o.at || 'corp.invalid'}`,
    fromName: `사람${uid}`,
    at: BASE + uid * 60_000,
    seen: !!o.seen
  });
  const add = (id, m) => {
    const b = server.get(id);
    b.msgs.push(m);
    b.hi = Math.max(b.hi, m.uid);
  };
  const addBox = (id, msgs) => {
    server.set(id, { v: V, hi: 0, msgs: [], fail: false });
    for (const m of msgs) add(id, m);
    store.addMailAccount({ id, name: id, host: `imap.${id}.invalid`, port: 993, user: `${id}@corp.invalid`, sealed: 'fake-sealed' });
  };
  /** 이 계정들만 켠다 — 앞 장면의 계정이 폴링에 끼지 않게 */
  const only = (...ids) => {
    for (const a of store.mailAccounts) store.updateMailAccount(a.id, { enabled: ids.includes(a.id) });
  };

  mail.fetchSummary = async (acc, { limit, onlyUnread }) => {
    touch();
    calls.fetch += 1;
    const b = server.get(acc.id);
    if (b.fail) throw new Error('시험: 서버가 답하지 않는다');
    const all = [...b.msgs].sort((x, y) => x.uid - y.uid);
    const unread = all.filter((m) => !m.seen);
    // 진짜 fetchSummary 와 같은 창 — 마지막 limit 통. 앞이 빠지면 더 옛 메일이 들어온다
    const win = onlyUnread ? unread.slice(-limit) : all.slice(-limit);
    return {
      unread: unread.length, total: all.length, mailbox: 'INBOX', top: b.hi, uidValidity: b.v,
      messages: win.map((m) => ({ ...m, mailbox: 'INBOX' })).sort((x, y) => y.at - x.at)
    };
  };
  mail.moveToSpam = async (acc, uids) => {
    touch();
    calls.spam.push(...uids);
    const b = server.get(acc.id);
    b.msgs = b.msgs.filter((m) => !uids.includes(m.uid));
    return { moved: uids.length, mailbox: 'Junk' };
  };
  mail.markRead = async (acc, uids) => {
    touch();
    calls.read.push(...uids);
    for (const m of server.get(acc.id).msgs) if (uids.includes(m.uid)) m.seen = true;
    return { changed: uids.length };
  };

  // refreshMail 끝에 부르는 뒷일 — 진짜가 돌면 메일 서버·디스크로 나간다. 싣기 전에 바꾼다 (mailhub 가 구조 분해로 받는다)
  const tails = { forward: 0, backup: 0, prefetch: 0 };
  const backup = require(path.join(ROOT, 'src', 'backup.js'));
  backup.autoBackupNew = async () => { tails.backup += 1; };
  const mailbody = require(path.join(ROOT, 'src', 'mailbody.js'));
  mailbody.prefetchBodies = () => { tails.prefetch += 1; };
  const autofwd = require(path.join(ROOT, 'src', 'autofwd.js'));
  autofwd.forwardNew = async () => { tails.forward += 1; };

  const mailhub = require(path.join(ROOT, 'src', 'mailhub.js'));
  ok(typeof mailhub.init === 'function' && !!mailhub.mailState, 'mailhub.js 가 창 없이 실린다');
  const S = mailhub.mailState;
  let prepared = 0;
  mailhub.init({ prepareMail: () => { prepared += 1; } });

  // 규칙은 runServerRules 로 따로 돌고, 서버가 바뀌면 스스로 한 번 더 읽는다 — 잠잠해질 때까지 기다린다
  const poll = async () => {
    await mailhub.refreshMail({ force: true });
    await sleep(20);
    while (S.loading || Date.now() - lastTouch < 40) await sleep(10);
  };
  const book = () => JSON.stringify(store.contacts.map((c) => [c.address, c.used]));

  store.setSettings({ mailEnabled: true, mailOnlyUnread: false, mailCount: 25 });
  ok(store.settings.mailEnabled === true && store.settings.mailCount === 25, '메일 확인 켬, 25통');
  for (const r of RULES) store.addMailRule(r);

  console.log('\n[0] 쓸 계정이 없으면 prepareMail 을 부르지 않는다');
  await poll();
  ok(prepared === 0 && !!S.blocked, '계정 없음 — 부르지 않고 까닭만 남긴다', [prepared, S.blocked]);

  console.log('\n[1] «바로» — 창이 차례로 빠지며 옛 메일이 들어온다');
  {
    // 100통. 위 45통은 읽음, 아래 55통은 안 읽음 — 규칙에 걸리는 옛 메일이 섞여 있다
    const msgs = [];
    for (let i = 0; i < 100; i++) {
      const uid = 1000 + i * 3;
      if (i >= 55) msgs.push(mk(uid, { seen: true }));
      else if (i % 5 === 0) msgs.push(mk(uid, { who: 'ad', at: 'spam.invalid' }));
      else if (i % 5 === 1) msgs.push(mk(uid, { who: 'bot', at: 'alert.invalid' }));
      else msgs.push(mk(uid));
    }
    addBox('a1', msgs);
    only('a1');
    await poll();
    ok(prepared > 0, 'prepareMail 이 폴링마다 불린다', prepared);
    ok(S.known instanceof Set && S.pending === 0, '첫 폴링 — 있던 것은 새 메일이 아니다', S.pending);
    ok(S.tops.get('a1').top === 1297 && S.tops.get('a1').v === String(V), '장부에 맨 위 UID 와 UIDVALIDITY', S.tops.get('a1'));
    const floor = 1000 + 55 * 3;
    const before = book();
    const box = server.get('a1');
    let rounds = 0;
    for (let n = 0; n < 9; n++) {
      // 서버 정리가 읽은 메일을 옮겼다 — 맨 위 UID 는 그대로이고 창만 아래로 밀린다
      const gone = box.msgs.filter((m) => m.seen).sort((x, y) => y.uid - x.uid).slice(0, 5).map((m) => m.uid);
      box.msgs = box.msgs.filter((m) => !gone.includes(m.uid));
      await poll();
      if (S.pending === 0 && book() === before && !calls.spam.length && !calls.read.length) rounds += 1;
    }
    ok(rounds === 9, '아홉 판 내내 pending 0, 주소록 변화 0, 서버 동작 0', { rounds, pending: S.pending, spam: calls.spam.length, read: calls.read.length });
    ok(!box.msgs.some((m) => m.seen), '(읽은 메일이 다 빠졌다)');
    ok(S.toSpam.length === 0 && S.toRead.length === 0, '규칙에 걸린 옛 메일은 서버로 나갈 목록에 없다', [S.toSpam.length, S.toRead.length]);
    ok(S.filtered > 0, '…그래도 화면에서 숨기는 일은 그대로다', S.filtered);
    ok(S.messages.length === 25 && S.messages.every((m) => m.uid < floor && !m.seen), '옛 메일이 화면 목록에는 보인다', S.messages.slice(0, 3).map((m) => m.uid));
    ok(S.tops.get('a1').top === 1297, '맨 위 UID 는 내려가지 않는다', S.tops.get('a1').top);
  }

  console.log('\n[2] 폴링 한 번 실패 뒤 성공');
  {
    const mine = (id, from) => Array.from({ length: 6 }, (_, i) => mk(from + i * 2, { who: id }));
    addBox('a2', mine('a2', 2000));
    addBox('a3', mine('a3', 3000));
    only('a2', 'a3');
    await poll();
    ok(S.pending === 0, '처음 보는 계정의 메일은 세지 않는다', S.pending);
    ok(book().includes('a2') && book().includes('a3'), '…주소록에는 지금처럼 들어간다');
    const before = book();
    const top2 = S.tops.get('a2').top;

    server.get('a2').fail = true;
    await poll();
    ok(S.errors.length === 1 && S.pending === 0, '실패 — 오류 한 줄, 세지 않는다', S.errors.length);
    ok((S.tops.get('a2') || {}).top === top2, '실패한 계정의 장부는 그대로', S.tops.get('a2'));
    ok(![...S.known].some((k) => k.startsWith('a2:')), '(known 에서는 그 계정이 빠졌다 — 경계가 없으면 다음 판에 전부 새 메일이 된다)');

    server.get('a2').fail = false;
    await poll();
    ok(S.errors.length === 0 && S.pending === 0, '다음 성공 — pending 0', S.pending);
    ok(book() === before, '…주소록 변화 0');

    // 실패한 사이에 온 메일은 놓치지 않는다
    server.get('a2').fail = true;
    await poll();
    add('a2', mk(2100, { who: 'late' }));
    server.get('a2').fail = false;
    await poll();
    ok(S.pending === 1, '실패한 사이 온 메일 한 통만 센다', S.pending);
    ok(book().includes('late2100@'), '…주소록에도 들어간다');
    S.pending = 0;
  }

  console.log('\n[3] 진짜 새 메일');
  {
    const before = store.contacts.length;
    add('a2', mk(2200, { who: 'fresh' }));
    await poll();
    ok(S.pending === 1, 'pending 1', S.pending);
    ok(store.contacts.length === before + 1 && book().includes('fresh2200@'), '주소록 +1', store.contacts.length - before);
    ok(S.messages.some((m) => m.uid === 2200), '화면 목록에 있다');
    ok(calls.spam.length === 0 && calls.read.length === 0, '규칙에 안 걸린 메일은 서버 동작 0');
    S.pending = 0;

    add('a2', mk(2203, { who: 'ad', at: 'spam.invalid' }));
    await poll();
    ok(JSON.stringify(calls.spam) === '[2203]', '스팸 규칙이 서버로 나간다', calls.spam);
    ok(S.pending === 0, '조용히 시킨 메일은 세지 않는다', S.pending);
    ok(!server.get('a2').msgs.some((m) => m.uid === 2203), '(서버에서 옮겨졌다)');

    add('a2', mk(2206, { who: 'bot', at: 'alert.invalid' }));
    await poll();
    ok(JSON.stringify(calls.read) === '[2206]', '자동 읽음도 서버로 나간다', calls.read);
    S.pending = 0;
    calls.spam.length = 0;
    calls.read.length = 0;
  }

  console.log('\n[4] 규칙을 바꾸면 그때 창에 있던 메일까지');
  {
    // 80통 — 규칙이 걸릴 메일이 창 아래(10~14번째)와 창 안(40~44번째)에 있다. 창은 마지막 45통(35번째부터)
    const msgs = [];
    for (let i = 0; i < 80; i++) {
      const uid = 4000 + i * 3;
      const later = (i >= 10 && i <= 14) || (i >= 40 && i <= 44);
      msgs.push(later ? mk(uid, { who: 'lt', at: 'later.invalid' }) : mk(uid));
    }
    addBox('a4', msgs);
    only('a4');
    await poll();
    ok(calls.spam.length === 0, '규칙 전 — 서버 동작 0');

    store.addMailRule({ field: 'from', match: '*@later.invalid', action: 'spam' });
    mailhub.forgetRuleWork();
    await poll();
    const inWindow = [40, 41, 42, 43, 44].map((i) => 4000 + i * 3);
    ok(asc(calls.spam) === asc(inWindow), '그때 창에 있던 다섯 통이 서버로 나간다', calls.spam);

    // 창이 밀려 더 옛 메일이 들어온다
    const box = server.get('a4');
    box.msgs = box.msgs.filter((m) => m.uid < 4000 + 50 * 3);
    await poll();
    const oldOnes = [10, 11, 12, 13, 14].map((i) => 4000 + i * 3);
    ok(oldOnes.every((u) => box.msgs.some((m) => m.uid === u)), '(옛 다섯 통이 이제 창 안에 있다)');
    ok(asc(calls.spam) === asc(inWindow), '그보다 옛 메일은 안 걸린다 — 서버에 그대로 남는다', calls.spam);
    ok(S.toSpam.length === 0, '…서버로 나갈 목록에도 없다', S.toSpam.length);
    ok(S.filtered >= 5, '…화면에서는 숨긴다', S.filtered);

    // 규칙을 다시 바꾸면 그때의 창이 새 바닥이다
    mailhub.forgetRuleWork();
    await poll();
    ok(asc(calls.spam) === asc([...inWindow, ...oldOnes]), '규칙을 또 바꾸면 그때 창에 있는 메일까지 걸린다', calls.spam);
    calls.spam.length = 0;
  }

  console.log('\n[5] UIDVALIDITY 변경');
  {
    addBox('a5', [mk(5000, { who: 'a5' }), mk(5002, { who: 'a5' })]);
    only('a5');
    await poll();
    S.pending = 0;
    const before = book();
    const b = server.get('a5');
    b.v = V + 1n;
    // 새 번호가 옛 바닥(5000)보다 작다 — 옛 바닥을 그대로 쓰면 규칙이 서버로 영영 안 나간다
    b.msgs = [mk(5, { who: 'renum' }), mk(7, { who: 'renum' }), mk(9, { who: 'renum' })];
    b.hi = 9;
    await poll();
    ok(S.pending === 0 && book() === before, '번호가 새로 매겨진 판은 세지 않고 주소록도 그대로', [S.pending, book() === before]);
    ok(S.tops.get('a5').top === 9 && S.tops.get('a5').v === String(V + 1n), '장부를 다시 잡는다', S.tops.get('a5'));
    add('a5', mk(12, { who: 'renum' }));
    await poll();
    ok(S.pending === 1, '다음 판부터 다시 센다', S.pending);
    S.pending = 0;
    add('a5', mk(15, { who: 'ad', at: 'spam.invalid' }));
    await poll();
    ok(JSON.stringify(calls.spam) === '[15]', '규칙의 바닥도 새 번호로 다시 잡혀 서버로 나간다', calls.spam);
  }

  console.log('\n[6] 옮기기를 멈춘 계정의 스팸 규칙');
  {
    // 알림을 모두 센다 — mailState.notice 는 마지막 하나만 남는다
    const notes = [];
    let cur = S.notice;
    Object.defineProperty(S, 'notice', { configurable: true, enumerable: true, get: () => cur, set: (v) => { cur = v; notes.push(v); } });
    const stubSpam = mail.moveToSpam;
    let stopped = true;
    let tries = 0;
    mail.moveToSpam = async (acc, uids) => {
      if (stopped) {
        tries += 1;
        throw Object.assign(new Error('이 서버에서는 옮기기를 멈췄습니다 — 시험 까닭'), { blocked: true });
      }
      return stubSpam(acc, uids);
    };
    calls.spam.length = 0;
    add('a5', mk(30, { who: 'ad', at: 'spam.invalid' }));
    await poll();
    await poll();
    await poll();
    const said = notes.filter((n) => n && /스팸|규칙/.test(n.text || ''));
    ok(tries >= 1 && said.length === 1 && !/다시 해봅니다/.test(said[0].text) && /다시 해 보기/.test(said[0].text) && /스팸 규칙/.test(said[0].text),
      '멈춘 계정 — 알림 한 번 · «다시 해봅니다» 없이 «다시 해 보기»로 풀 수 있다고 말한다', { tries, said });
    stopped = false;
    await poll();
    ok(JSON.stringify(calls.spam) === '[30]', '…«다시 해 보기»로 풀리면 다음 폴링에 바로 나간다 (실패로 세어 몇 분 미루지 않는다)', calls.spam);
    mail.moveToSpam = stubSpam;
    delete S.notice;
    S.notice = cur;
  }

  console.log('\n[끝]');
  ok(tails.forward > 0 && tails.backup > 0 && tails.prefetch > 0, '뒷일은 바꿔 끼운 것만 돌았다', tails);
  ok(BrowserWindow.getAllWindows().length === 0, '창은 하나도 안 떴다');
  ok(!Object.keys(require.cache).some((k) => /credstore\.js$/.test(k)), '자격 증명 관리자 코드는 실리지 않았다');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

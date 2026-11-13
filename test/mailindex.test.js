'use strict';
// PC 색인 — .hibi-index.jsonl 을 읽고 쓰는 일 (src/mailindex.js).
//
// 창도 Electron 도 쓰지 않는다 — main.js 를 싣지 않고, 임시 폴더로만 돈다. 메일 서버·자격 증명 관리자에도 가지 않는다.
// 가짜 계정 주소는 *.invalid 다. 쓰기·rename 실패는 fs.promises 를 바꿔 끼워 흉내 낸다.
//   [1]  왕복, 합치기, 마지막 값이 이김, seen:null 이 값을 덮지 않음
//   [2]  끝 줄이 잘려도 다음 줄을 보존, 중간 줄 깨짐은 수만 셈
//   [3]  메타 줄은 어디 있어도 읽음, readMeta, ensureMeta 는 한 번만
//   [4]  못 읽음과 없음을 가름 (폴더를 파일 자리에 둔다)
//   [5]  reconcile — 파일 있고 줄 없음, 줄 있고 파일 없음, 색인 삭제 후 전부 복구, 0바이트 .damaged, 1시간 넘은 .part,
//        서버가 말한 크기로 손상을 판정하지 않음. saveOne — 줄은 파일이 제 이름을 받은 뒤에 씀 삭제, .part 를 세지 않음
//   [6]  스캔 줄은 seen:null, 그 뒤에 들어와도 읽음 값을 잃지 않음
//   [7]  EUC-KR 머리에서 from 이 senderOf 와 같음, (제목 없음), 120자
//   [8]  rowFromFetch 가 mail.rowOf 칸을 그대로 씀
//   [9]  compact — 합쳐짐, rename 실패 주입에 원본 유지, rename 전에 fsync, 압축 중 덧붙인 줄 보존
//   [10] 동시 append 가 섞이지 않음
//   [11] 색인 파일이 uidFiles·uidsIn 에 안 걸림, 파일 이름 규칙이 mailbackup 과 같음, 비밀번호 칸 없음
//   [12] flush — 쓰기 실패 주입에 unwritten>0 이고 줄이 버퍼에 남음, 회복하면 써짐, 없는 폴더를 만듦, 잠김은 다시 함, 5,000줄 상한
//   [13] load — uid 가 정수가 아닌 줄을 버림
//   [14] readMeta 가 4KB 뒤의 메타도 찾음. fileMatches — 같음, 다름, Message-ID 없음, 0으로 찬 파일, 서버가 Message-ID 를 안 줬으면 크기로 봄
//   [15] reconcile — 0으로 찬 파일을 .damaged 로 돌림, 줄의 mid 와 파일이 다르면 file 을 안 채움, shouldStop
//        («폴더 mtime 이 색인보다 오래됐으면 읽지 않음»은 scanAccount 의 일이라 src/mailfill.js 와 함께 본다)
//   [16] pendingOf, terminal
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src', 'mail.js'));
const mailindex = require(path.join(ROOT, 'src', 'mailindex.js'));
const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mailindex-'));
const FILE = mailindex.INDEX_FILE;
let seq = 0;
const fresh = () => {
  const d = path.join(TMP, `d${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const idx = (d) => path.join(d, FILE);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rawMail = (id, subject = 'report') => Buffer.from(
  `Message-ID: <${id}@corp.invalid>\r\nDate: Mon, 27 Oct 2025 09:12:00 +0900\r\nFrom: Kim <kim@corp.invalid>\r\nTo: lee@corp.invalid\r\n`
  + `Subject: ${subject}\r\nMIME-Version: 1.0\r\n\r\nbody of ${id}\r\n`, 'latin1');
const META = { acc: 'a1', user: 'kim@corp.invalid', host: 'imap.corp.invalid', box: 'INBOX', uidValidity: '7', gen: 1, use: '' };

(async () => {
  console.log('\n[1] 왕복·합치기');
  {
    const d = fresh();
    mailindex.append(d, { uid: 5, at: 100, subject: 'a', seen: false, file: null, st: 'head' });
    mailindex.append(d, { uid: 5, file: 'x.eml', bytes: 9, st: 'file' });
    mailindex.append(d, { uid: 5, seen: true });
    mailindex.append(d, { uid: 5, seen: null });
    mailindex.append(d, { uid: 6, seen: null, st: 'head' });
    const f = await mailindex.flush(d);
    ok(f.unwritten === 0 && f.error === null, 'flush — 못 쓴 줄 0', f);
    const r = await mailindex.load(d);
    const row = r.rows.get(5);
    ok(row.at === 100 && row.subject === 'a' && row.file === 'x.eml' && row.st === 'file' && row.bytes === 9, '같은 UID 는 합친다', row);
    ok(row.seen === true, 'seen:null 은 이미 있는 값을 덮지 않는다', row.seen);
    ok(r.rows.get(6).seen === null, '…다른 값이 없으면 null 로 남는다');
    ok(r.lines === 5 && r.bad === 0 && r.rows.size === 2 && r.meta === null, '줄 5개, 행 2개', [r.lines, r.bad, r.rows.size]);

    mailindex.append(d, { uid: 5, subject: 'b', seen: false });
    await mailindex.flush(d);
    const r2 = await mailindex.load(d);
    ok(r2.rows.get(5).subject === 'b' && r2.rows.get(5).seen === false, '마지막 값이 이긴다', r2.rows.get(5).subject);
    const text = fs.readFileSync(idx(d), 'utf8');
    ok(text.startsWith('\n') && !text.endsWith('\n'), '쓰는 꼴은 줄 앞에 \\n 을 붙인 것', JSON.stringify(text.slice(0, 4)));
  }
  {
    const d = fresh();
    mailindex.append(d, { uid: 1, st: 'head' });
    ok(!fs.existsSync(idx(d)), '넣자마자 쓰지 않는다');
    // 정해진 시간을 재지 않고 조건을 기다린다 — PC 가 바쁘면 타이머가 늦게 깬다
    const realSet = global.setTimeout;
    const until = async (fn) => {
      const t0 = Date.now();
      while (!(await fn()) && Date.now() - t0 < 10_000) await new Promise((res) => realSet(res, 20));
      return !!(await fn());
    };
    ok(await until(() => fs.existsSync(idx(d))), '조금 뒤에 스스로 쓴다');
    // 타이머를 막아 둔다 — 그래도 써지면 50줄이 쓴 것이다
    global.setTimeout = () => ({ unref() {}, ref() {} });
    try {
      for (let i = 0; i < 50; i++) mailindex.append(d, { uid: 100 + i, st: 'head' });
      const sized = async () => (await mailindex.load(d)).rows.size === 51;
      ok(await until(sized), '50줄이면 타이머를 기다리지 않고 쓴다');
    } finally {
      global.setTimeout = realSet;
    }
  }

  console.log('\n[2] 잘린 줄');
  {
    const d = fresh();
    // 전원 차단으로 끝 줄이 잘린 파일
    fs.writeFileSync(idx(d), '{"uid":1,"st":"head"}\n{"uid":2,"st":"he');
    mailindex.append(d, { uid: 3, st: 'head' });
    await mailindex.flush(d);
    const r = await mailindex.load(d);
    ok(r.rows.has(1) && r.rows.has(3) && !r.rows.has(2) && r.bad === 1, '잘린 끝 줄이 다음 줄을 망치지 않는다', [...r.rows.keys()]);
  }
  {
    const d = fresh();
    fs.writeFileSync(idx(d), '{"uid":1,"st":"head"}\n깨진 줄\n\n\n{"uid":4,"st":"head"}\n');
    const r = await mailindex.load(d);
    ok(r.rows.size === 2 && r.bad === 1 && r.lines === 3, '중간 줄 깨짐은 수만 센다, 빈 줄은 건너뛴다', [r.rows.size, r.bad, r.lines]);
  }

  console.log('\n[3] 메타 줄');
  {
    const d = fresh();
    fs.writeFileSync(idx(d), `{"uid":1,"st":"head"}\n${JSON.stringify({ meta: 1, v: 1, ...META, uidValidity: '7' })}\n{"uid":2,"st":"head"}\n`
      + `${JSON.stringify({ meta: 1, v: 1, ...META, use: '\\Sent' })}\n`);
    const r = await mailindex.load(d);
    ok(r.meta && r.meta.use === '\\Sent' && r.rows.size === 2, '어디 있어도 읽고, 마지막 메타가 이긴다', r.meta && r.meta.use);
    const m = await mailindex.readMeta(d);
    ok(m && m.uidValidity === '7' && m.host === 'imap.corp.invalid', 'readMeta 는 첫 메타를 준다', m && m.uidValidity);
  }
  {
    const d = fresh();
    ok(await mailindex.readMeta(d) === null, '색인이 없으면 readMeta 는 null');
    fs.writeFileSync(idx(d), '{"uid":1,"st":"head"}\n');
    ok(await mailindex.readMeta(d) === null, '메타가 없어도 null');
  }
  {
    const d = fresh();
    const a = await mailindex.ensureMeta(d, { ...META, uidValidity: 1700000000n });
    const b = await mailindex.ensureMeta(d, { ...META, uidValidity: 1700000000n });
    await mailindex.flush(d);
    ok(a === true && b === false, '같은 메타는 한 번만 덧붙인다', [a, b]);
    const m = await mailindex.readMeta(d);
    ok(m && m.meta === 1 && m.v === 1 && m.uidValidity === '1700000000', 'BigInt UIDVALIDITY 를 글자로 적는다', m && m.uidValidity);
    const { use, ...noUse } = META;
    const c = await mailindex.ensureMeta(d, { ...noUse, uidValidity: '1700000000' });
    ok(c === false && use === '', '넘기지 않은 칸은 비교하지 않는다 (saveOne 은 폴더 역할을 모른다)', c);
    const e = await mailindex.ensureMeta(d, { ...META, uidValidity: '1700000000', use: '\\Sent' });
    await mailindex.flush(d);
    ok(e === true, '값이 달라지면 덧붙인다', e);
  }

  console.log('\n[4] 못 읽음과 없음');
  {
    const none = await mailindex.load(path.join(TMP, '없는-폴더'));
    ok(none.rows.size === 0 && none.lines === 0 && none.bad === 0 && none.meta === null, '없으면 빈 값', [none.rows.size, none.lines]);
    const d = fresh();
    fs.mkdirSync(idx(d));   // 파일 자리에 폴더 — 윈도우에서는 EISDIR 또는 EPERM 이다
    let code = '';
    try { await mailindex.load(d); } catch (e) { code = e.code; }
    ok(code === 'EISDIR' || code === 'EPERM', '못 읽으면 던진다', code);
    let code2 = '';
    try { await mailindex.readMeta(d); } catch (e) { code2 = e.code; }
    ok(code2 === 'EISDIR' || code2 === 'EPERM', 'readMeta 도 던진다', code2);
    let code3 = '';
    try { await mailindex.reconcile(d); } catch (e) { code3 = e.code; }
    ok(code3 === 'EISDIR' || code3 === 'EPERM', 'reconcile 도 던진다 — 그 폴더를 건너뛴다', code3);
    ok(fs.statSync(idx(d)).isDirectory(), '…덮어쓰지 않는다');
  }

  console.log('\n[5] reconcile');
  {
    const d = fresh();
    const put = (name, buf) => fs.writeFileSync(path.join(d, name), buf);
    const scanned = rawMail(100, 'scan me');
    put('20241027_0912_100_scan me.eml', scanned);
    put('20241027_0913_200.eml', rawMail(200));
    put('20241027_0914_300_empty.eml', Buffer.alloc(0));
    put('20241027_0915_400_short.eml', rawMail(400));
    put('20241027_0916_500_ok.eml', rawMail(500));
    put('~받는중-600-1-1.part', 'half');
    put('~받는중-700-1-2.part', 'half');
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(path.join(d, '~받는중-600-1-1.part'), old, old);
    fs.writeFileSync(idx(d), [
      JSON.stringify({ uid: 150, at: 1, subject: 's', mid: '<x@corp.invalid>', seen: true, file: '20241027_0900_150_사라진.eml', bytes: 5, st: 'file', via: 'new' }),
      JSON.stringify({ uid: 400, at: 1, subject: 's', mid: '<400@corp.invalid>', seen: true, file: '20241027_0915_400_short.eml', bytes: 99999, st: 'file', via: 'new' }),
      JSON.stringify({ uid: 500, at: 1, subject: 's', mid: '<500@corp.invalid>', seen: true, file: '20241027_0916_500_ok.eml', size: rawMail(500).length + 5000, bytes: rawMail(500).length, st: 'file', via: 'new' })
    ].join('\n'));

    const r = await mailindex.reconcile(d);
    ok(r.added === 2 && r.missing === 1 && r.damaged === 2 && r.parts === 1 && r.stopped === false, '센 값', r);
    const l = await mailindex.load(d);
    const s = l.rows.get(100);
    ok(s && s.file === '20241027_0912_100_scan me.eml' && s.st === 'file' && s.via === 'scan' && s.bytes === scanned.length, '파일이 있고 줄이 없으면 줄을 만든다', s);
    ok(s.seen === null, '…읽음은 모른다 (null)');
    ok(s.at === new Date(2024, 9, 27, 9, 12).getTime(), '…시각은 파일 이름의 분 단위 값', s.at);
    ok(s.subject === 'scan me' && s.from === 'Kim' && s.fromAddress === 'kim@corp.invalid' && s.to === 'lee@corp.invalid' && s.mid === '<100@corp.invalid>', '…머리 칸을 채운다', s);
    ok(l.rows.get(200).st === 'file', '제목 없는 이름(대체 길)도 줄이 된다');
    const gone = l.rows.get(150);
    ok(gone.file === null && gone.st === 'head', '줄은 file 인데 파일이 없으면 head 로 돌린다', gone);
    ok(!fs.existsSync(path.join(d, '20241027_0914_300_empty.eml')) && fs.existsSync(path.join(d, '20241027_0914_300_empty.eml.damaged')), '0바이트 파일은 .damaged 로 비킨다 (지우지 않는다)');
    ok(l.rows.get(300).file === null && l.rows.get(300).st === 'head', '…다시 받을 줄이 된다', l.rows.get(300));
    ok(fs.existsSync(path.join(d, '20241027_0915_400_short.eml.damaged')) && l.rows.get(400).st === 'head', '끝쪽 줄의 파일이 bytes 와 다르면 .damaged', l.rows.get(400));
    ok(l.rows.get(500).st === 'file' && fs.existsSync(path.join(d, '20241027_0916_500_ok.eml')), '맞는 파일은 그대로 둔다 — 서버가 말한 크기가 달라도 저장한 바이트와만 잰다');
    ok(!fs.existsSync(path.join(d, '~받는중-600-1-1.part')) && fs.existsSync(path.join(d, '~받는중-700-1-2.part')), '1시간 넘은 .part 만 지운다');
    ok(!l.rows.has(600) && !l.rows.has(700), '.part 는 메일로 세지 않는다');

    const again = await mailindex.reconcile(d);
    ok(again.added === 0 && again.missing === 0 && again.damaged === 0 && again.parts === 0, '두 번째는 할 일이 없다', again);

    fs.unlinkSync(idx(d));
    const back = await mailindex.reconcile(d);
    const l2 = await mailindex.load(d);
    ok(back.added === 3 && l2.rows.has(100) && l2.rows.has(200) && l2.rows.has(500) && l2.rows.get(500).st === 'file', '색인을 지워도 파일로 전부 복구한다', [...l2.rows.keys()]);
  }
  {
    const r = await mailindex.reconcile(path.join(TMP, '없는-폴더-2'));
    ok(r.added === 0 && !fs.existsSync(path.join(TMP, '없는-폴더-2')), '폴더가 없으면 할 일이 없고, 만들지도 않는다', r);
  }
  {
    // 줄은 파일이 제 이름을 받은 뒤에 쓴다. 먼저 쓰면 rename 이 막혔을 때 없는 파일을 가리키는 줄이 남는다
    const dir = fresh();
    const acc = { id: 'a1', name: '회사', user: 'kim@corp.invalid', host: 'imap.corp.invalid', port: 993 };
    mailbackup.patchState(dir, 'a1', 'INBOX', { uidValidity: '7', gen: 1, lowUid: 1, lastUid: 10 });
    const boxDir = mailbackup.boxDirFor(dir, acc, 'INBOX', 1);
    const msg = { mailbox: 'INBOX', uid: 11, receivedAt: Date.now(), subject: 'report', source: rawMail(11) };
    const real = fs.promises.rename;
    fs.promises.rename = async () => { throw Object.assign(new Error('막힘'), { code: 'EIO' }); };
    let threw = null;
    try { await mailbackup.saveOne(acc, dir, msg); } catch (e) { threw = e; }
    fs.promises.rename = real;
    await mailindex.flush(boxDir);
    const stuck = (await mailindex.load(boxDir)).rows.get(11);
    ok(!!threw && !(stuck && stuck.file), 'rename 이 막히면 없는 파일을 가리키는 줄이 안 남는다', stuck);
    await mailbackup.saveOne(acc, dir, msg);
    await mailindex.flush(boxDir);
    const saved = (await mailindex.load(boxDir)).rows.get(11);
    ok(saved.st === 'file' && fs.existsSync(path.join(boxDir, saved.file)), '…되면 줄이 가리키는 파일이 있다', saved.file);
  }

  console.log('\n[6] 스캔 줄의 읽음');
  {
    const d = fresh();
    mailindex.append(d, await mailindex.rowFromSource(rawMail(1), { uid: 1, at: 5, via: 'scan', file: 'a.eml', bytes: 3 }));
    await mailindex.flush(d);
    ok((await mailindex.load(d)).rows.get(1).seen === null, '스캔 줄은 seen:null');
    mailindex.append(d, { uid: 1, seen: true });
    mailindex.append(d, await mailindex.rowFromSource(rawMail(1), { uid: 1, at: 5, via: 'scan', file: 'a.eml', bytes: 3 }));
    await mailindex.flush(d);
    ok((await mailindex.load(d)).rows.get(1).seen === true, '늦게 들어온 스캔 줄이 읽음 값을 지우지 않는다');
  }

  console.log('\n[7] rowFromSource');
  {
    // «김철수» — EUC-KR 바이트를 base64 로
    const name = Buffer.from([0xB1, 0xE8, 0xC3, 0xB6, 0xBC, 0xF6]).toString('base64');
    const raw = Buffer.from(`From: =?EUC-KR?B?${name}?= <kim@corp.invalid>\r\nSubject: =?EUC-KR?B?${name}?=\r\nMessage-ID: <e@corp.invalid>\r\n\r\nbody\r\n`, 'latin1');
    const r = await mailindex.rowFromSource(raw, { uid: 7, at: 123, seen: true, via: 'open', file: 'f.eml', bytes: raw.length });
    ok(r.from === '김철수' && r.from === mail.senderOf({ from: [{ name: '김철수', address: 'kim@corp.invalid' }] }), 'EUC-KR 이름을 풀고 senderOf 와 같은 값을 쓴다', r.from);
    ok(r.subject === '김철수' && r.fromName === '김철수' && r.fromAddress === 'kim@corp.invalid', '제목·이름·주소', r);
    ok(r.uid === 7 && r.at === 123 && r.seen === true && r.via === 'open' && r.file === 'f.eml' && r.bytes === raw.length && r.st === 'file' && r.mid === '<e@corp.invalid>', '넘긴 칸', r);
    const noSubject = await mailindex.rowFromSource(Buffer.from('From: a@corp.invalid\r\n\r\nx', 'latin1'), { uid: 8, at: 1 });
    ok(noSubject.subject === '(제목 없음)' && noSubject.st === 'head' && noSubject.file === null && noSubject.bytes === undefined, '제목이 없으면 (제목 없음), 파일이 없으면 head', noSubject);
    ok(noSubject.from === 'a@corp.invalid', '이름이 없으면 주소', noSubject.from);
    const long = await mailindex.rowFromSource(Buffer.from(`Subject: ${'가나다라'.repeat(60)}\r\n\r\nx`, 'utf8'), { uid: 9, at: 1 });
    ok(long.subject.length === 120, '제목은 120자까지', long.subject.length);
    const noFrom = await mailindex.rowFromSource(Buffer.from('Subject: x\r\n\r\ny', 'latin1'), { uid: 10, at: 1 });
    ok(noFrom.from === '' && noFrom.fromAddress === '', '보낸 사람이 없어도 던지지 않는다');
    const when = await mailindex.rowFromSource(rawMail(11), { uid: 11 });
    ok(when.at === Date.parse('Mon, 27 Oct 2025 09:12:00 +0900'), '시각을 안 주면 Date 머리', when.at);
    // 첨부가 커도 앞 64KB만 본다
    const big = Buffer.concat([rawMail(12, 'big'), Buffer.alloc(3 * 1024 * 1024, 0x41)]);
    const b = await mailindex.rowFromSource(big, { uid: 12, at: 1, file: 'b.eml', bytes: big.length });
    ok(b.subject === 'big' && b.size === big.length, '큰 원문도 머리만 파싱한다', b.size);
  }

  console.log('\n[8] rowFromFetch');
  {
    const msg = {
      uid: 42, size: 2048, flags: new Set(['\\Seen']), internalDate: new Date(1730000000000),
      envelope: { subject: '제목', messageId: '<m@corp.invalid>', from: [{ name: '김철수', address: 'kim@corp.invalid' }], to: [{ address: 'lee@corp.invalid' }, { address: 'b@corp.invalid' }] }
    };
    const r = mailindex.rowFromFetch(msg, 'fill');
    const base = mail.rowOf(msg);
    ok(Object.keys(base).every((k) => r[k] === base[k]), 'mail.rowOf 칸을 그대로 쓴다', base);
    ok(r.to === 'lee@corp.invalid' && r.size === 2048 && r.mid === '<m@corp.invalid>' && r.file === null && r.st === 'head' && r.via === 'fill', '더한 칸', r);
    const thin = mailindex.rowFromFetch({ uid: 43, internalDate: 'not-a-date' }, 'new');
    ok(thin.to === '' && thin.size === 0 && thin.mid === '' && Number.isFinite(thin.at) && thin.subject === '(제목 없음)', '봉투가 없거나 날짜를 못 읽어도 던지지 않는다', thin);
  }

  console.log('\n[9] compact');
  {
    const d = fresh();
    const lines = [JSON.stringify({ meta: 1, v: 1, ...META })];
    for (let i = 0; i < 1100; i++) {
      for (const uid of [1, 2, 3]) lines.push(JSON.stringify({ uid, n: i, st: 'head', at: 1 }));
    }
    lines.push('깨진 줄');
    fs.writeFileSync(idx(d), lines.join('\n'));
    const before = await mailindex.load(d);
    const r = await mailindex.compact(d);
    const after = await mailindex.load(d);
    ok(r.done === true && r.before === 3302 && r.after === 4, '합친다', r);
    ok(same([...after.rows], [...before.rows]) && same(after.meta, before.meta) && after.bad === 0, '합친 값이 같다', [...after.rows.keys()]);
    ok(fs.readFileSync(idx(d), 'utf8').split('\n')[0].includes('"meta"'), '메타가 첫 줄로 간다');
    ok(!fs.existsSync(`${idx(d)}.tmp`), '.tmp 가 남지 않는다');

    const lean = await mailindex.compact(d);
    ok(lean.done === false && lean.error === null, '줄 수가 «행 수×1.5+1000» 아래면 하지 않는다', lean);
    const forced = await mailindex.compact(d, { force: true });
    ok(forced.done === true, 'force 면 한다', forced);
    mailindex.append(d, { uid: 4, st: 'head' });
    await mailindex.flush(d);
    ok((await mailindex.load(d)).rows.has(4), '압축 뒤에도 덧붙일 수 있다');
  }
  {
    const d = fresh();
    fs.writeFileSync(idx(d), '{"uid":1,"st":"head"}\n{"uid":1,"st":"file"}\n');
    const body = fs.readFileSync(idx(d));
    const real = fs.promises.rename;
    fs.promises.rename = async () => { throw Object.assign(new Error('잠김'), { code: 'EBUSY' }); };
    const r = await mailindex.compact(d, { force: true });
    fs.promises.rename = real;
    ok(r.done === false && /잠김/.test(r.error), 'rename 이 막히면 하지 않은 것으로 끝난다 — 다시 시도하지 않는다', r);
    ok(fs.readFileSync(idx(d)).equals(body), '…원본은 그대로', body.length);
    ok(!fs.existsSync(`${idx(d)}.tmp`), '….tmp 를 지운다');
  }
  {
    // 전원이 나가 0으로 찬 색인을 막는다. 전원 차단은 시험으로 못 재니 불렀는지와 차례만 본다
    const d = fresh();
    fs.writeFileSync(idx(d), '{"uid":1,"st":"head"}\n{"uid":1,"st":"file"}\n');
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
    const r = await mailindex.compact(d, { force: true });
    fs.promises.open = realOpen;
    fs.promises.rename = realRename;
    ok(r.done === true && same(order, ['sync', 'rename']), 'rename 전에 fsync 를 한다', order);
  }
  {
    const d = fresh();
    fs.writeFileSync(idx(d), '{"uid":1,"st":"head"}\n{"uid":1,"st":"file"}\n');
    const real = fs.promises.rename;
    // 압축이 파일을 바꾸기 직전에 덧붙인다 — 프라미스 줄이 없으면 이 줄이 사라진다
    fs.promises.rename = async (a, b) => {
      mailindex.append(d, { uid: 99, st: 'head' });
      await sleep(320);
      return real(a, b);
    };
    const r = await mailindex.compact(d, { force: true });
    fs.promises.rename = real;
    await mailindex.flush(d);
    const l = await mailindex.load(d);
    ok(r.done === true && l.rows.has(99) && l.rows.get(1).st === 'file', '압축 중 덧붙인 줄을 잃지 않는다', [...l.rows.keys()]);
  }
  {
    const r = await mailindex.compact(path.join(TMP, '없는-폴더-3'), { force: true });
    ok(r.done === false && r.error === null, '색인이 없으면 할 일이 없다', r);
  }

  console.log('\n[10] 동시 append');
  {
    const d = fresh();
    const writer = async (start) => {
      for (let i = 0; i < 400; i++) {
        mailindex.append(d, { uid: start + i, st: 'head', subject: 'ㄱ'.repeat(50) });
        if (i % 37 === 0) await new Promise((r) => setImmediate(r));
        if (i % 111 === 0) await mailindex.flush(d);
      }
    };
    await Promise.all([writer(1000), writer(2000), writer(3000)]);
    await mailindex.flush(d);
    const l = await mailindex.load(d);
    ok(l.rows.size === 1200 && l.bad === 0, '셋이 함께 넣어도 줄이 섞이지 않는다', [l.rows.size, l.bad]);
  }
  {
    const a = fresh();
    const b = fresh();
    await Promise.all([
      (async () => { for (let i = 1; i <= 120; i++) mailindex.append(a, { uid: i, st: 'head' }); })(),
      (async () => { for (let i = 1; i <= 120; i++) mailindex.append(b, { uid: i + 500, st: 'head' }); })()
    ]);
    await Promise.all([mailindex.flush(a), mailindex.flush(b)]);
    const [la, lb] = await Promise.all([mailindex.load(a), mailindex.load(b)]);
    ok(la.rows.size === 120 && lb.rows.size === 120 && la.rows.has(1) && !la.rows.has(501), '폴더가 다르면 따로 쓴다', [la.rows.size, lb.rows.size]);
  }

  console.log('\n[11] 파일 이름 규칙과 비밀번호 칸');
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, '20241027_0912_100_제목.eml'), rawMail(100));
    fs.writeFileSync(path.join(d, '20241027_0912_101_깨짐.eml.damaged'), 'x');
    fs.writeFileSync(path.join(d, '~받는중-102-1-1.part'), 'x');
    await mailindex.ensureMeta(d, META);
    mailindex.append(d, { uid: 103, st: 'head' });
    await mailindex.flush(d);
    fs.writeFileSync(`${idx(d)}.tmp`, 'x');
    const files = await mailbackup.uidFiles(d);
    ok(same([...files.keys()], [100]), 'uidFiles 에 색인·.tmp·.damaged·.part 가 안 걸린다', [...files.keys()]);
    ok(same([...mailbackup.uidsIn(d)], [100]), 'uidsIn 도 마찬가지', [...mailbackup.uidsIn(d)]);
    const pick = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').match(/const UID_IN_NAME = (.+);/)[1];
    ok(pick('mailindex.js') === pick('mailbackup.js'), '파일 이름 규칙이 mailbackup 과 같다', pick('mailindex.js'));
  }
  {
    const d = fresh();
    const r = mailindex.rowFromFetch({ uid: 1, envelope: { subject: 's', from: [{ address: 'a@corp.invalid' }] }, internalDate: new Date(1) }, 'new');
    await mailindex.ensureMeta(d, META);
    mailindex.append(d, r);
    await mailindex.flush(d);
    const text = fs.readFileSync(idx(d), 'utf8');
    ok(!/pass|pwd|token|secret|비밀/i.test(text), '색인에 비밀번호·토큰 칸이 없다');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mailindex.js'), 'utf8');
    ok(!/require\('(electron|\.\/store|\.\/evlog|\.\/mailbackup|\.\/mailtidy)'\)/.test(src), 'electron·store·evlog·mailbackup·mailtidy 를 싣지 않는다');
  }

  console.log('\n[12] flush');
  {
    const d = fresh();
    const real = fs.promises.appendFile;
    let calls = 0;
    fs.promises.appendFile = async () => { calls += 1; throw Object.assign(new Error('쓰기 실패'), { code: 'EIO' }); };
    mailindex.append(d, { uid: 1, st: 'head' });
    mailindex.append(d, { uid: 2, st: 'head' });
    const f = await mailindex.flush(d);
    ok(f.unwritten === 2 && /쓰기 실패/.test(f.error) && calls === 1, '쓰기가 실패하면 못 쓴 줄 수를 준다, 잠김이 아니면 기다리지 않는다', f);
    ok((await mailindex.load(d)).rows.size === 0, '…디스크에는 아직 없다 (load 는 버퍼를 안 본다)');
    mailindex.append(d, { uid: 3, st: 'head' });
    fs.promises.appendFile = real;
    const f2 = await mailindex.flush(d);
    const l = await mailindex.load(d);
    ok(f2.unwritten === 0 && f2.error === null && same([...l.rows.keys()], [1, 2, 3]), '회복하면 순서대로 써진다', [...l.rows.keys()]);
  }
  {
    const d = path.join(TMP, '새', '폴더', '깊이');
    mailindex.append(d, { uid: 1, st: 'head' });
    const f = await mailindex.flush(d);
    ok(f.unwritten === 0 && fs.existsSync(idx(d)), '없는 폴더에 쓰면 폴더를 만든다', f);
    const e = path.join(TMP, '새', '빈-폴더');
    const f2 = await mailindex.flush(e);
    ok(f2.unwritten === 0 && !fs.existsSync(e), '쓸 줄이 없으면 폴더를 만들지 않는다', f2);
  }
  {
    const d = fresh();
    const real = fs.promises.appendFile;
    let calls = 0;
    fs.promises.appendFile = async (...a) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('잠김'), { code: 'EBUSY' });
      return real(...a);
    };
    mailindex.append(d, { uid: 1, st: 'head' });
    const t0 = Date.now();
    const f = await mailindex.flush(d);
    fs.promises.appendFile = real;
    ok(f.unwritten === 0 && calls === 3 && Date.now() - t0 >= 600, '잠기면 0.2·0.5초 뒤 다시 한다', [calls, Date.now() - t0]);
    ok((await mailindex.load(d)).rows.has(1), '…줄이 한 번만 들어간다');
  }
  {
    const d = fresh();
    const real = fs.promises.appendFile;
    fs.promises.appendFile = async () => { throw Object.assign(new Error('쓰기 실패'), { code: 'EIO' }); };
    for (let i = 1; i <= 5100; i++) mailindex.append(d, { uid: i, st: 'head' });
    const f = await mailindex.flush(d);
    fs.promises.appendFile = real;
    ok(f.unwritten === 5000, '버퍼는 5,000줄까지 든다', f.unwritten);
    await mailindex.flush(d);
    const l = await mailindex.load(d);
    ok(l.rows.size === 5000 && !l.rows.has(100) && l.rows.has(5100), '…오래된 줄부터 버린다', [l.rows.size]);
  }

  console.log('\n[13] uid 가 정수가 아닌 줄');
  {
    const d = fresh();
    fs.writeFileSync(idx(d), '{"uid":"7","st":"head"}\n{"uid":null,"st":"head"}\n{"seq":9}\n{"uid":1.5}\n5\nnull\n{"uid":8,"st":"head"}\n');
    const l = await mailindex.load(d);
    ok(same([...l.rows.keys()], [8]) && l.bad === 6, '버리고 센다', [[...l.rows.keys()], l.bad]);
  }

  console.log('\n[14] readMeta·fileMatches');
  {
    const d = fresh();
    const lots = [];
    for (let i = 1; i <= 200; i++) lots.push(JSON.stringify({ uid: i, st: 'head', subject: 'x'.repeat(40) }));
    lots.push(JSON.stringify({ meta: 1, v: 1, ...META }));
    fs.writeFileSync(idx(d), lots.join('\n'));
    ok(fs.statSync(idx(d)).size > 4096, '메타 앞에 4KB 넘게 있다', fs.statSync(idx(d)).size);
    const m = await mailindex.readMeta(d);
    ok(m && m.uidValidity === '7', '4KB 뒤의 메타도 찾는다', m && m.uidValidity);
  }
  {
    const d = fresh();
    const put = (n, b) => { fs.writeFileSync(path.join(d, n), b); return path.join(d, n); };
    const a = put('a.eml', rawMail(1));
    ok(same(await mailindex.fileMatches(a, '<1@corp.invalid>'), { same: true, damaged: false }), '같음');
    ok((await mailindex.fileMatches(a, ' < 1@CORP.invalid > ')).same, '공백·꺾쇠·대소문자 차이는 같다');
    ok(same(await mailindex.fileMatches(a, '<2@corp.invalid>'), { same: false, damaged: false }), '다름');
    ok((await mailindex.fileMatches(a, '')).same === false, 'mid 가 없는데 파일에 Message-ID 가 있으면 다르다');
    const aSize = fs.statSync(a).size;
    ok((await mailindex.fileMatches(a, '', aSize)).same === true && (await mailindex.fileMatches(a, '', aSize + 1)).same === false, '…크기를 주면 크기로 본다 — 서버가 ENVELOPE 에 Message-ID 를 안 주는 곳이다');
    ok((await mailindex.fileMatches(a, '<2@corp.invalid>', aSize)).same === false, '…mid 가 있으면 크기가 같아도 mid 로 본다');
    const noId = put('b.eml', Buffer.from('From: a@corp.invalid\r\nSubject: x\r\n\r\ny\r\n', 'latin1'));
    ok((await mailindex.fileMatches(noId, '')).same === true && (await mailindex.fileMatches(noId, undefined)).same === true, 'mid 도 파일도 없으면 같다');
    ok((await mailindex.fileMatches(noId, '<1@corp.invalid>')).same === false, '파일에만 없으면 다르다');
    const folded = put('c.eml', Buffer.from('From: a@corp.invalid\r\nMESSAGE-ID:\r\n <folded@corp.invalid>\r\n\r\nMessage-ID: <body@corp.invalid>\r\n', 'latin1'));
    ok((await mailindex.fileMatches(folded, '<folded@corp.invalid>')).same === true, '접힌 머리를 펴고, 본문의 글은 보지 않는다');
    const zero = put('d.eml', Buffer.alloc(9000));
    ok(same(await mailindex.fileMatches(zero, '<1@corp.invalid>'), { same: false, damaged: true }), '0으로 찬 파일은 damaged');
    const tailZero = put('e.eml', Buffer.concat([rawMail(1), Buffer.alloc(8000)]));
    ok((await mailindex.fileMatches(tailZero, '<1@corp.invalid>')).damaged === true, '끝이 전부 0이어도 damaged');
    const empty = put('f.eml', Buffer.alloc(0));
    ok((await mailindex.fileMatches(empty, '')).damaged === true, '0바이트도 damaged');
    ok(same(await mailindex.fileMatches(path.join(d, '없음.eml'), ''), { same: false, damaged: false }), '없는 파일은 같다고 하지 않는다');
  }

  console.log('\n[15] reconcile — 파일 확인');
  {
    const d = fresh();
    const put = (n, b) => fs.writeFileSync(path.join(d, n), b);
    put('20241027_0912_1_zero.eml', Buffer.alloc(9000));
    put('20241027_0912_2_other.eml', rawMail(2));
    put('20241027_0912_3_same.eml', rawMail(3));
    put('20241027_0912_4_placeholder.eml', rawMail(4));
    put('20241027_0912_5_noid.eml', Buffer.from('Subject: x\r\n\r\ny\r\n', 'latin1'));
    fs.writeFileSync(idx(d), [
      JSON.stringify({ uid: 2, at: 1, mid: '<다른메일@corp.invalid>', seen: false, file: null, st: 'head', via: 'fill' }),
      JSON.stringify({ uid: 3, at: 1, mid: '<3@corp.invalid>', seen: false, file: null, st: 'head', via: 'fill' }),
      JSON.stringify({ uid: 4, st: 'head', via: 'fill' }),
      JSON.stringify({ uid: 5, st: 'head', via: 'fill' })
    ].join('\n'));
    const r = await mailindex.reconcile(d);
    const l = await mailindex.load(d);
    ok(fs.existsSync(path.join(d, '20241027_0912_1_zero.eml.damaged')) && l.rows.get(1).st === 'head' && r.damaged === 1, '0으로 찬 파일을 .damaged 로 돌린다', l.rows.get(1));
    ok(l.rows.get(2).file === null && l.rows.get(2).st === 'head' && fs.existsSync(path.join(d, '20241027_0912_2_other.eml')), '줄의 mid 와 파일이 다르면 file 을 안 채운다, 옛 파일은 건드리지 않는다', l.rows.get(2));
    ok(l.rows.get(3).file === '20241027_0912_3_same.eml' && l.rows.get(3).st === 'file' && l.rows.get(3).bytes === rawMail(3).length, '같으면 채운다', l.rows.get(3));
    ok(l.rows.get(4).st === 'head' && !l.rows.get(4).file, '자리표는 비교할 값이 없어 그대로 둔다 — 뒤 받기가 머리를 받은 뒤 확인한다', l.rows.get(4));
    ok(l.rows.get(5).st === 'head' && !l.rows.get(5).file, '…파일에 Message-ID 가 없어도 «둘 다 없음»으로 채우지 않는다', l.rows.get(5));
    ok(r.added === 1, '센 값', r);
  }
  {
    const d = fresh();
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(d, `20241027_0912_${i}_m.eml`), rawMail(i));
    let asked = 0;
    const r = await mailindex.reconcile(d, { shouldStop: () => ++asked > 2 });
    const l = await mailindex.load(d);
    ok(r.stopped === true && r.added === 2 && l.rows.size === 2, 'shouldStop 이면 멈추고 한 데까지 남긴다', r);
    const r2 = await mailindex.reconcile(d);
    ok(r2.stopped === false && r2.added === 3, '…다음에 나머지를 한다', r2);
  }

  console.log('\n[16] pendingOf·terminal');
  {
    const rows = new Map([
      [5, { uid: 5, st: 'head', at: 1 }],
      [9, { uid: 9, st: 'head', at: 1 }],
      [7, { uid: 7, st: 'head' }],                 // 자리표 — 머리를 아직 못 받았다
      [8, { uid: 8, st: 'file', at: 1, file: 'x' }],
      [6, { uid: 6, st: 'head', at: 1, srv: 'gone' }],
      [20, { uid: 20, st: 'head', at: 1 }],        // lastUid 위 — 곧 자동 저장이 받는다
      [3, { uid: 3, st: 'fail', at: 1 }],
      [2, { uid: 2, st: 'fail', at: 1, srv: 'gone' }],
      [4, { uid: 4, st: 'head', at: 1, srv: null }]
    ]);
    ok(same(mailindex.pendingOf(rows, { lastUid: 10 }), [9, 5, 4]), 'st:head, 서버에 있음, uid≤lastUid, at 있음 — 내림차순', mailindex.pendingOf(rows, { lastUid: 10 }));
    ok(same(mailindex.pendingOf(rows, { lastUid: 10, fillHead: true }), [9, 7, 5, 4]), 'fillHead 면 자리표도 받는다', mailindex.pendingOf(rows, { lastUid: 10, fillHead: true }));
    ok(same(mailindex.pendingOf(rows, { lastUid: 10, retry: new Set() }), [9, 5, 4, 3]), 'retry 가 Set 이면 st:fail 도 더한다', mailindex.pendingOf(rows, { lastUid: 10, retry: new Set() }));
    ok(same(mailindex.pendingOf(rows, { lastUid: 10, retry: new Set([3]) }), [9, 5, 4]), '…그 안에 든 것은 빼고', mailindex.pendingOf(rows, { lastUid: 10, retry: new Set([3]) }));
    ok(['file', 'fail', 'big', 'dup'].every((st) => mailindex.terminal({ st })) && mailindex.terminal({ st: 'head', srv: 'gone' }), 'terminal — 끝난 줄');
    ok(!mailindex.terminal({ st: 'head' }) && !mailindex.terminal({ st: 'head', srv: null }), 'terminal — st:head 는 아직이다');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

'use strict';
// 옮기기 도우미를 진짜 imapflow 로 — 선 위에 실제로 어떤 명령이 나가는가 (src/mailmove.js · src/mail.js friendly·warnCatcher).
//
// 이 시험이 띄운 작은 IMAP 서버(127.0.0.1, 평문, 임시 포트)에만 붙는다. 바깥 메일 서버에는 가지 않는다. 계정 값은 가짜(u / p).
// 창도 Electron 도 쓰지 않는다 — node 로도, npx electron 으로도 돈다.
//   [W1] MOVE 없음 + UIDPLUS — STATUS → UID COPY → STATUS → UID STORE +FLAGS.SILENT → UID EXPUNGE → UID SEARCH
//   [W2] MOVE 없음 + UIDPLUS 없음 — SEARCH DELETED 를 EXPUNGE 앞뒤로 본다
//   [W3] COPY 거절 — imapflow messageMove 는 원본을 지운다(대조), 도우미는 STORE·EXPUNGE 를 보내지 않는다, 막은 연결은 아무것도 안 보낸다
//   [W4] COPY 뒤 소켓이 끊김 — usable=false, unsure, 원본 그대로
//   [W5] STORE 뒤 끊김 → 다음 연결이 UID STORE -FLAGS.SILENT 로 푼다
//   [W6] PERMANENTFLAGS 에 \Deleted 없음 — COPY 도 안 보낸다
//   [W7] MOVE 거절의 서버 까닭 — mail.warnCatcher 가 imapflow 의 log.warn 에서 받아 오류 문구에 붙인다
//   [W8] 로그인 거절의 진짜 모양 — mail.friendly 가 responseText·serverResponseCode 를 읽는다
//   [W9] 복사 전·뒤 STATUS 에서 끊김, 첫 검색에서 끊김 — imapflow 는 false 를 준다. 멈춤(block)이 아니라 left·unsure
//   [W10] UIDPLUS 라면서 UID EXPUNGE 가 폴더 전체를 지우는 서버 — 알아채고 멈춘다
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { ImapFlow } = require('imapflow');
const mm = require(path.join(ROOT, 'src', 'mailmove.js'));
const mail = require(path.join(ROOT, 'src', 'mail.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

/** 작은 IMAP 서버 — imapflow 가 이 시험에서 보내는 명령만 안다 */
// dropOn: { cmd, n } — 그 명령의 n 번째가 오면 답하지 않고 끊는다   foreign: 남이 지움 표시만 해 둔 UID   uidExpungeAll: UID 지우기가 폴더 전체를 지움
function startServer({ caps, copyNo = false, dropAfter = null, perm = '\\Deleted \\Seen \\*', moveNo = null, loginNo = null, dropOn = null, foreign = [], uidExpungeAll = false }) {
  const boxes = {
    INBOX: { v: 1700000000, next: 1010, msgs: [...[1000, 1001, 1002].map((uid) => ({ uid, flags: new Set(), id: `m${uid}` })),
      ...foreign.map((uid) => ({ uid, flags: new Set(['\\Deleted']), id: `m${uid}` }))] },
    Trash: { v: 1700000001, next: 5000, msgs: [] }
  };
  const wire = [];
  const socks = new Set();
  const seen = {};
  const srv = net.createServer((sock) => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    let sel = null;
    let buf = '';
    const send = (s) => { if (!sock.destroyed) sock.write(s + '\r\n'); };
    send(`* OK [CAPABILITY ${caps}] fake ready`);
    const tok = (s) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|\(|\)|[^\s()"]+/g)]
      .filter((m) => m[0] !== '(' && m[0] !== ')')
      .map((m) => (m[1] !== undefined ? m[1] : m[0]));
    const set = (spec, box) => {
      const top = box.msgs.reduce((a, x) => Math.max(a, x.uid), 0);
      const want = new Set();
      for (const part of spec.split(',')) {
        const [a, b] = part.split(':').map((x) => (x === '*' ? top : Number(x)));
        if (b === undefined) want.add(a);
        else for (const x of box.msgs) if (x.uid >= Math.min(a, b) && x.uid <= Math.max(a, b)) want.add(x.uid);
      }
      return want;
    };
    const expunge = (box, only) => {
      for (let i = box.msgs.length - 1; i >= 0; i--) {
        const x = box.msgs[i];
        if (x.flags.has('\\Deleted') && (!only || only.has(x.uid))) { box.msgs.splice(i, 1); send(`* ${i + 1} EXPUNGE`); }
      }
    };
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let k;
      while ((k = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const t = tok(line);
        const tag = t[0];
        let cmd = (t[1] || '').toUpperCase();
        let args = t.slice(2);
        if (cmd === 'UID') { cmd = `UID ${(t[2] || '').toUpperCase()}`; args = t.slice(3); }
        wire.push(cmd === 'LOGIN' ? `${tag} LOGIN ***` : line);
        seen[cmd] = (seen[cmd] || 0) + 1;
        if (dropOn && dropOn.cmd === cmd && seen[cmd] === (dropOn.n || 1)) { sock.destroy(); return; }
        if (cmd === 'CAPABILITY') { send(`* CAPABILITY ${caps}`); send(`${tag} OK done`); }
        else if (cmd === 'LOGIN') send(loginNo ? `${tag} ${loginNo}` : `${tag} OK [CAPABILITY ${caps}] logged in`);
        else if (cmd === 'LIST' || cmd === 'LSUB') {
          const pat = args[1];
          if (pat === '') send(`* ${cmd} (\\Noselect) "/" ""`);
          else for (const n of Object.keys(boxes)) if (pat === '*' || pat === n) send(`* ${cmd} (\\HasNoChildren) "/" "${n}"`);
          send(`${tag} OK done`);
        } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
          sel = boxes[args[0]];
          send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
          send(`* OK [PERMANENTFLAGS (${perm})] ok`);
          send(`* ${sel.msgs.length} EXISTS`);
          send(`* OK [UIDVALIDITY ${sel.v}] ok`);
          send(`* OK [UIDNEXT ${sel.next}] ok`);
          send(`${tag} OK [${cmd === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] done`);
        } else if (cmd === 'STATUS') {
          const b = boxes[args[0]];
          send(`* STATUS "${args[0]}" (MESSAGES ${b.msgs.length} UIDNEXT ${b.next})`);
          send(`${tag} OK done`);
        } else if (cmd === 'UID SEARCH') {
          let list = sel.msgs.slice();
          for (let i = 0; i < args.length; i++) {
            const a = args[i].toUpperCase();
            if (a === 'UID') { const s = set(args[++i], sel); list = list.filter((x) => s.has(x.uid)); }
            else if (a === 'DELETED') list = list.filter((x) => x.flags.has('\\Deleted'));
            else if (a === 'UNDELETED') list = list.filter((x) => !x.flags.has('\\Deleted'));
          }
          send(`* SEARCH${list.map((x) => ` ${x.uid}`).join('')}`);
          send(`${tag} OK done`);
        } else if (cmd === 'UID COPY') {
          if (copyNo) { send(`${tag} NO [TRYCREATE] no such mailbox`); continue; }
          const s = set(args[0], sel);
          const dst = boxes[args[1]];
          const src = [];
          const out = [];
          for (const x of sel.msgs) if (s.has(x.uid)) { src.push(x.uid); out.push(dst.next); dst.msgs.push({ uid: dst.next++, flags: new Set(x.flags), id: x.id }); }
          if (dropAfter === 'COPY') { sock.destroy(); return; }
          send(`${tag} OK${/UIDPLUS/.test(caps) ? ` [COPYUID ${dst.v} ${src.join(',')} ${out.join(',')}]` : ''} copied`);
        } else if (cmd === 'UID MOVE') {
          if (moveNo) { send(`${tag} ${moveNo}`); continue; }
          const s = set(args[0], sel);
          const dst = boxes[args[1]];
          for (let i = sel.msgs.length - 1; i >= 0; i--) {
            const x = sel.msgs[i];
            if (!s.has(x.uid)) continue;
            dst.msgs.push({ uid: dst.next++, flags: new Set(x.flags), id: x.id });
            sel.msgs.splice(i, 1);
            send(`* ${i + 1} EXPUNGE`);
          }
          send(`${tag} OK moved`);
        } else if (cmd === 'UID STORE') {
          const s = set(args[0], sel);
          const op = args[1].toUpperCase();
          for (const x of sel.msgs) if (s.has(x.uid)) for (const f of args.slice(2)) { if (op.startsWith('-')) x.flags.delete(f); else x.flags.add(f); }
          if (dropAfter === 'STORE') { sock.destroy(); return; }
          send(`${tag} OK stored`);
        } else if (cmd === 'UID EXPUNGE') { expunge(sel, uidExpungeAll ? null : set(args[0], sel)); send(`${tag} OK expunged`); }
        else if (cmd === 'EXPUNGE') { expunge(sel, null); send(`${tag} OK expunged`); }
        else if (cmd === 'NOOP') send(`${tag} OK noop`);
        else if (cmd === 'LOGOUT') { send('* BYE bye'); send(`${tag} OK bye`); sock.end(); }
        else send(`${tag} BAD unknown ${cmd}`);
      }
    });
    sock.on('error', () => {});
  });
  const stop = () => { for (const s of socks) s.destroy(); srv.close(); };
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, stop, port: srv.address().port, boxes, wire })));
}

/** mail.connect 와 같은 받개를 단 진짜 ImapFlow — TLS 만 빼고 127.0.0.1 평문으로 */
async function client(port, { open = true } = {}) {
  const holder = {};
  const c = new ImapFlow({ host: '127.0.0.1', port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: mail.warnCatcher(holder), disableAutoIdle: true });
  holder.client = c;
  c.on('error', () => {});
  await c.connect();
  if (open) await c.mailboxOpen('INBOX', { readOnly: false });
  return c;
}
const ids = (b) => b.msgs.map((x) => x.id);
const cmdsOf = (wire) => wire.map((l) => l.replace(/^\S+ /, '')).filter((l) => !/^(CAPABILITY|LOGIN|LIST|LSUB|SELECT|EXAMINE|LOGOUT|NOOP|ID|ENABLE|NAMESPACE|COMPRESS)/.test(l));
const close = async (c) => { try { await c.logout(); } catch { try { c.close(); } catch { /* 이미 닫힘 */ } } };

(async () => {
  console.log('\n[W1] MOVE 없음 + UIDPLUS — 선 위의 명령');
  {
    const s = await startServer({ caps: 'IMAP4rev1 UIDPLUS' });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000, 1001, 1002], 'Trash', { accKey: 'w1', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(r.how === 'copy' && r.moved.length === 3 && s.boxes.INBOX.msgs.length === 0 && s.boxes.Trash.msgs.length === 3, '3통 옮김', { moved: r.moved, err: r.error });
    const want = ['STATUS Trash (UIDNEXT MESSAGES)', 'UID COPY 1000:1002 Trash', 'STATUS Trash (UIDNEXT MESSAGES)',
      'UID STORE 1000:1002 +FLAGS.SILENT (\\Deleted)', 'UID SEARCH DELETED', 'UID EXPUNGE 1000:1002', 'UID SEARCH UID 1000:1002'];
    // 폴더 이름을 따옴표로 싸는지는 imapflow 판마다 다를 수 있다 — 따옴표는 빼고 맞댄다
    const got = cmdsOf(s.wire).map((l) => l.replace(/"/g, '').replace(/\s+/g, ' '));
    ok(JSON.stringify(got) === JSON.stringify(want), '…STATUS → UID COPY → STATUS → UID STORE +FLAGS.SILENT → 남의 표시 세기 → UID EXPUNGE 그 UID → UID SEARCH', got);
  }

  console.log('\n[W2] MOVE 없음 + UIDPLUS 없음');
  {
    const s = await startServer({ caps: 'IMAP4rev1' });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000, 1001, 1002], 'Trash', { accKey: 'w2', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(r.how === 'copy' && r.moved.length === 3 && s.boxes.INBOX.msgs.length === 0 && s.boxes.Trash.msgs.length === 3, '3통 옮김', { moved: r.moved, err: r.error });
    const got = cmdsOf(s.wire);
    const at = (re) => got.findIndex((l) => re.test(l));
    ok(at(/^UID SEARCH DELETED/) === 0 && at(/^EXPUNGE$/) > at(/^UID STORE/) && got[at(/^EXPUNGE$/) - 1].startsWith('UID SEARCH DELETED') && !got.some((l) => /^UID EXPUNGE/.test(l)),
      '…남의 지움 표시를 먼저 보고, 폴더 지우기 바로 앞에서 다시 본다 (UID EXPUNGE 없음)', got);
  }

  console.log('\n[W3] COPY 거절');
  {
    const s = await startServer({ caps: 'IMAP4rev1', copyNo: true });
    const c = await client(s.port);
    const r = await c.messageMove([1000], 'Trash', { uid: true });
    await close(c);
    s.stop();
    ok(r === false && !ids(s.boxes.INBOX).includes('m1000') && !ids(s.boxes.Trash).includes('m1000'),
      '(대조) imapflow messageMove 는 false 를 주지만 1000 은 INBOX 에도 휴지통에도 없다 — 잃음', { r, inbox: ids(s.boxes.INBOX), wire: cmdsOf(s.wire) });
  }
  {
    const s = await startServer({ caps: 'IMAP4rev1', copyNo: true });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w3', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(r.left.length === 1 && ids(s.boxes.INBOX).includes('m1000') && !s.wire.some((l) => /STORE|EXPUNGE/.test(l)) && /TRYCREATE|no such mailbox/.test(r.error || ''),
      '…도우미는 STORE·EXPUNGE 를 보내지 않고 1000 이 남는다, 서버 글이 오류에 붙는다', { left: r.left, err: r.error });
  }
  {
    const s = await startServer({ caps: 'IMAP4rev1' });
    const c = await client(s.port);
    mm.guardFallback(c);
    const err = await c.messageMove([1000], 'Trash', { uid: true }).then(() => null, (e) => e.message);
    await close(c);
    s.stop();
    ok(/MOVE 대체 경로 막음/.test(err || '') && !s.wire.some((l) => /COPY|STORE|EXPUNGE/.test(l)) && ids(s.boxes.INBOX).length === 3,
      '…막은 연결에서는 누가 messageMove 를 불러도 아무것도 안 나간다', err);
  }

  console.log('\n[W4] COPY 뒤 소켓이 끊김');
  {
    const s = await startServer({ caps: 'IMAP4rev1 UIDPLUS', dropAfter: 'COPY' });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000, 1001], 'Trash', { accKey: 'w4', journal: mm.memJournal() });
    try { c.close(); } catch { /* 이미 닫힘 */ }
    s.stop();
    ok(!!r.unsure && c.usable === false && s.boxes.INBOX.msgs.length === 3 && !s.wire.some((l) => /STORE|EXPUNGE/.test(l)),
      'unsure · usable=false · 원본 3통 그대로 · STORE/EXPUNGE 없음', { unsure: r.unsure, usable: c.usable, err: r.error });
  }

  console.log('\n[W5] STORE 뒤 끊김 → 다음 연결이 내 표시를 푼다');
  {
    const s = await startServer({ caps: 'IMAP4rev1', dropAfter: 'STORE' });
    const j = mm.memJournal();
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000, 1001], 'Trash', { accKey: 'w5', journal: j });
    try { c.close(); } catch { /* 이미 닫힘 */ }
    const flagged = s.boxes.INBOX.msgs.filter((x) => x.flags.has('\\Deleted')).length;
    ok(!!r.unsure && flagged === 2 && j.dump().pending.length === 1, 'unsure · 원본 2통에 \\Deleted · 일지 1건', { flagged, err: r.error });
    // 다음 번 — 끊지 않는 서버로 같은 상태를 이어 쓴다
    const s2 = await startServer({ caps: 'IMAP4rev1' });
    s2.boxes.INBOX = s.boxes.INBOX;
    s2.boxes.Trash = s.boxes.Trash;
    s.stop();
    const c2 = await client(s2.port);
    const r2 = await mm.moveUids(c2, [1002], 'Trash', { accKey: 'w5', journal: j });
    await close(c2);
    s2.stop();
    const flagged2 = s2.boxes.INBOX.msgs.filter((x) => x.flags.has('\\Deleted')).length;
    ok(r2.undone === 2 && flagged2 === 0 && JSON.stringify(r2.moved) === '[1002]' && ids(s2.boxes.INBOX).length === 2,
      '다음 번: 2통을 풀고 1002 는 옮긴다 (1000·1001 은 원본 + 휴지통 복사본)', { r2: { undone: r2.undone, moved: r2.moved, err: r2.error }, inbox: ids(s2.boxes.INBOX), trash: ids(s2.boxes.Trash) });
    ok(cmdsOf(s2.wire).some((l) => /^UID STORE 1000:1001 -FLAGS\.SILENT \(\\Deleted\)$/.test(l)), '…UID STORE 1000:1001 -FLAGS.SILENT (\\Deleted)', cmdsOf(s2.wire));
  }

  console.log('\n[W6] PERMANENTFLAGS 에 \\Deleted 없음');
  {
    const s = await startServer({ caps: 'IMAP4rev1 UIDPLUS', perm: '\\Seen \\Flagged' });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w6', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(r.left.length === 1 && !!r.block && !s.wire.some((l) => /COPY|STORE|EXPUNGE/.test(l)), '복사도 하지 않는다 (imapflow 가 읽은 permanentFlags 를 본다)', { err: r.error });
  }

  console.log('\n[W7] MOVE 거절의 서버 까닭');
  {
    const s = await startServer({ caps: 'IMAP4rev1 MOVE UIDPLUS', moveNo: 'NO [THROTTLED] Too many commands, slow down' });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000, 1001], 'Trash', { accKey: 'w7', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(r.how === 'move' && r.left.length === 2 && /서버가 옮기기를 거부했습니다 — 서버가 잠시 속도를 제한했습니다/.test(r.error || ''),
      'imapflow 는 false 만 주지만 warnCatcher 가 받은 까닭을 붙인다', r.error);
  }

  console.log('\n[W8] 로그인 거절의 진짜 모양');
  {
    const s = await startServer({ caps: 'IMAP4rev1', loginNo: 'NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
    const e = await client(s.port, { open: false }).then(() => null, (x) => x);
    s.stop();
    ok(!!e && e.message === 'Command failed' && mail.friendly(e) === '로그인이 거절됐습니다 — 평소 비밀번호가 아닌 앱 비밀번호를 넣으세요',
      '«Command failed» 대신 로그인 거절 문구', e && { message: e.message, code: e.serverResponseCode, text: e.responseText, friendly: mail.friendly(e) });
  }
  {
    const s = await startServer({ caps: 'IMAP4rev1', loginNo: 'NO [ALERT] Too many simultaneous connections. (Failure)' });
    const e = await client(s.port, { open: false }).then(() => null, (x) => x);
    s.stop();
    ok(!!e && /^동시 연결이 너무 많습니다/.test(mail.friendly(e)), '동시 연결 초과', e && mail.friendly(e));
  }

  console.log('\n[W9] 끊김은 «서버가 못 함»이 아니다 — imapflow 의 status·search 는 명령 중에 끊기면 false 를 준다');
  for (const caps of ['IMAP4rev1', 'IMAP4rev1 UIDPLUS']) {
    const s = await startServer({ caps, dropOn: { cmd: 'STATUS', n: 1 } });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w9', journal: mm.memJournal() }).then((x) => x, (x) => ({ thrown: x.message }));
    try { c.close(); } catch { /* 이미 닫힘 */ }
    s.stop();
    ok(!r.thrown && JSON.stringify(r.left) === '[1000]' && !r.block && !r.unsure && !s.wire.some((l) => /COPY|STORE|EXPUNGE/.test(l)),
      `${caps} · 복사 전 STATUS 에서 끊김 — left, 멈추지 않음, COPY 를 안 보냄`, r.thrown ? r : { left: r.left, block: r.block, unsure: r.unsure, err: r.error });
  }
  for (const caps of ['IMAP4rev1', 'IMAP4rev1 UIDPLUS']) {
    const s = await startServer({ caps, dropOn: { cmd: 'STATUS', n: 2 } });
    const j = mm.memJournal();
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w9b', journal: j }).then((x) => x, (x) => ({ thrown: x.message }));
    try { c.close(); } catch { /* 이미 닫힘 */ }
    s.stop();
    ok(!r.thrown && !!r.unsure && JSON.stringify(r.kept) === '[1000]' && !r.block && !s.wire.some((l) => /STORE|EXPUNGE/.test(l)) && j.dump().pending.length === 0,
      `${caps} · 복사 뒤 STATUS 에서 끊김 — unsure·kept, 멈추지 않음, 지움 표시 없음`, r.thrown ? r : { kept: r.kept, block: r.block, unsure: r.unsure, pending: j.dump().pending });
  }
  {
    const s = await startServer({ caps: 'IMAP4rev1', dropOn: { cmd: 'UID SEARCH', n: 1 } });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w9c', journal: mm.memJournal() }).then((x) => x, (x) => ({ thrown: x.message }));
    try { c.close(); } catch { /* 이미 닫힘 */ }
    s.stop();
    ok(!r.thrown && JSON.stringify(r.left) === '[1000]' && !r.block && !s.wire.some((l) => /COPY/.test(l)),
      'IMAP4rev1 · 첫 UID SEARCH DELETED 에서 끊김 — 던지지 않고 left', r.thrown ? r : { left: r.left, err: r.error });
  }

  console.log('\n[W10] UIDPLUS 라면서 UID EXPUNGE 가 폴더 전체를 지우는 서버');
  {
    const s = await startServer({ caps: 'IMAP4rev1 UIDPLUS', foreign: [1005], uidExpungeAll: true });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w10', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(!!r.block && /다른 프로그램이 지움 표시만 해 둔 메일 1통/.test(r.block || '') && !ids(s.boxes.INBOX).includes('m1005'),
      '남의 지움 표시 m1005 가 함께 사라짐 — 알아채고 멈춘다 (다음 옮기기를 막는다)', { block: r.block, inbox: ids(s.boxes.INBOX), wire: cmdsOf(s.wire) });
  }
  {
    const s = await startServer({ caps: 'IMAP4rev1 UIDPLUS', foreign: [1005] });
    const c = await client(s.port);
    const r = await mm.moveUids(c, [1000], 'Trash', { accKey: 'w10b', journal: mm.memJournal() });
    await close(c);
    s.stop();
    ok(!r.block && JSON.stringify(r.moved) === '[1000]' && ids(s.boxes.INBOX).includes('m1005'), '(대조) 바른 서버 — 남의 표시는 남고 멈추지 않는다', { block: r.block, inbox: ids(s.boxes.INBOX) });
  }

  console.log(bad ? `\n실패 ${bad}` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})();

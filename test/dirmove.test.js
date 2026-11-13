'use strict';
// 백업 폴더 바꾸기 — «기존 메일 백업도 옮길까요?» (src/backup.js pickDir · src/backupmove.js · 기본 폴더 src/backuphome.js).
//
// 창을 하나도 띄우지 않는다. main.js 도 싣지 않는다 — backup.js 를 바로 부르고, 확인 창(popup.askUser)·폴더 고르기(dialog)·
// 휴지통(shell.trashItem)·기록(evlog.log)은 바꿔 끼운다. 휴지통은 이 시험의 임시 폴더 안 «bin» 으로 옮길 뿐이다.
// 메일 서버에는 붙지 않는다 (mail.connect 를 막는다). 가짜 계정 주소는 *.invalid 다. 홈·문서·데이터 폴더는 store 를 싣기 전에 임시로 옮긴다.
//   [1] 묻는 창 — 수·크기·문구·단추·초점·부모   [2] 옮기기(같은 볼륨) — 정리는 켜진 채, 지난 메일 답 그대로, 설정이 바뀌고 이전 폴더가 빈다
//   [3] 옮기는 동안(다른 볼륨·복사) — 이 폴더에 쓰는 일은 모두 쉬고, 읽는 일은 디스크를 보지 않는다. 상태에 진행 · 끝나면 휴지통
//   [4] 옮기지 않고 새 폴더만 쓰기 — 예전과 같다   [5] 그만두기·창 닫기 — 아무것도 안 바뀐다
//   [6] 묻지 않는 때 — 이전 폴더가 없거나 Hibi 것이 없다   [7] 옮길 수 없는 때(겹침·안쪽) — 새 폴더만 쓰기·그만두기만
//   [8] 복사가 실패하면 그대로   [9] 휴지통 실패·Hibi 것이 아닌 항목   [10] 도는 자동 백업을 멈추고 기다린다·색인 버퍼를 먼저 쓴다
//   [11] 이어 붙인 곳 (처리기의 부모 창·main.js 의 훅·기본 폴더)
//   [12] 설정 파일 저장이 실패하면 — 복사 길은 되돌리고 휴지통에 보내지 않는다, 바꿔 달기는 «옮기기 멈춤»이 디스크에 남는다
//   [13] 옮기다 멈춤(바꿔 달기를 되돌리지 못함) — 이 폴더에 쓰는 일을 모두 쉬고, 같은 새 폴더를 고르면 이어서
//   [14] 옮기는 동안 종료·업데이트 설치는 미룬다   [15] 옮기다 꺼진 뒤 다시 고르면 «이어서 옮기기» · 남의 조각
//   [16] «옮기기 멈춤»을 설정 파일에 남기지 못하면 바꿔 달지 않는다   [17] 늦게 멈추는 자동 백업을 끝까지 기다린다
//   [18] 기다리는 사이에 끝난 자동 백업은 서버 정리로 이어 가지 않는다
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, dialog, shell } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dirmove-'));
const HOME = path.join(tmp, 'home');
const DOCS = path.join(tmp, 'docs');
const USER = path.join(tmp, 'Hibi');
for (const d of [HOME, DOCS, USER]) fs.mkdirSync(d, { recursive: true });
app.setPath('appData', tmp);
app.setPath('userData', USER);
app.setPath('home', HOME);
app.setPath('documents', DOCS);

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return !!fn();
}
const gateOf = () => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; };

app.whenReady().then(async () => {
  // 시험이 만든 창 말고 다른 창이 생기면 보이기 전에 부수고 실패로 센다
  const strays = [];
  app.on('browser-window-created', (_e, w) => { strays.push(w.id); setImmediate(() => { if (!w.isDestroyed()) w.destroy(); }); });

  const store = require(path.join(ROOT, 'src', 'store.js'));
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  const lines = [];
  evlog.log = (s, m) => { lines.push(`${s}|${m}`); };
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  mail.connect = () => { throw new Error('시험: 서버에 붙지 않는다'); };
  let bodyFetches = 0;
  mail.fetchBody = async () => { bodyFetches += 1; return null; };
  const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
  const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
  const mailindex = require(path.join(ROOT, 'src', 'mailindex.js'));
  const mailfill = require(path.join(ROOT, 'src', 'mailfill.js'));
  const mailfwd = require(path.join(ROOT, 'src', 'mailfwd.js'));
  const tidyacct = require(path.join(ROOT, 'src', 'tidyacct.js'));
  const backupmove = require(path.join(ROOT, 'src', 'backupmove.js'));
  const backuphome = require(path.join(ROOT, 'src', 'backuphome.js'));
  const popup = require(path.join(ROOT, 'src', 'popup.js'));

  // ── 바꿔 끼우기 ──
  const backupCalls = [];
  let backupHang = 0;          // 0 이 아니면 그 ms 동안 shouldStop 을 보며 돈다
  let stopLag = 0;             // 멈추라는 것을 본 뒤 끝나기까지 걸리는 ms (쓰던 묶음을 마저 쓰는 셈)
  const stopSeen = [];
  mailbackup.backupAccount = async (acc, d, o = {}) => {
    backupCalls.push({ id: acc.id, at: Date.now(), onlyNew: !!o.onlyNew });
    if (backupHang) {
      const t0 = Date.now();
      while (Date.now() - t0 < backupHang) {
        if (o.shouldStop && o.shouldStop()) { stopSeen.push(Date.now()); if (stopLag) await sleep(stopLag); break; }
        await sleep(20);
      }
    }
    backupCalls[backupCalls.length - 1].end = Date.now();
    return { saved: 0, skipped: 0, seeded: 0, missing: 0, mailboxes: 0, stateError: null, stopped: true };
  };
  let fillCalls = 0;
  mailfill.fillAccount = async () => { fillCalls += 1; return { why: 'budget', heads: 0, saved: 0 }; };
  let carries = 0;
  const realCarry = mailtidy.carryMoved;
  mailtidy.carryMoved = (a, b) => { carries += 1; return realCarry(a, b); };
  // 서버 정리가 시작될 때 옮기는 중이었나 — 진짜 정리는 그대로 부른다 (mail.connect 가 막혀 바로 실패한다)
  const tidyCalls = [];
  const realTidyAll = mailtidy.tidyAll;
  mailtidy.tidyAll = (...a) => { tidyCalls.push({ at: Date.now(), moving: backup.moving() }); return realTidyAll(...a); };
  const asks = [];
  const parents = [];
  let answer = null;
  let askGate = null;
  popup.askUser = async (parent, o) => {
    asks.push(o);
    parents.push(parent);
    if (askGate) await askGate.promise;
    return typeof answer === 'function' ? answer(o) : answer;
  };
  let pickPath = null;
  let dialogs = 0;
  dialog.showOpenDialog = async () => { dialogs += 1; return { canceled: !pickPath, filePaths: pickPath ? [pickPath] : [] }; };
  const BIN = path.join(tmp, 'bin');
  fs.mkdirSync(BIN);
  const trashed = [];
  let trashFail = () => false;
  // 휴지통 안 이름 — 판마다 비우는 trashed 의 길이를 쓰면 앞 판에 보낸 같은 이름의 폴더와 부딪힌다
  let binSeq = 0;
  shell.trashItem = async (p) => {
    if (trashFail(p)) throw new Error('시험: 휴지통 막힘');
    trashed.push(path.basename(p));
    await fs.promises.rename(p, path.join(BIN, `${++binSeq}-${path.basename(p)}`));
  };
  ok(String(shell.trashItem).includes('trashed.push') && String(dialog.showOpenDialog).includes('dialogs'), '(휴지통·대화상자를 바꿔 끼웠다 — 진짜 휴지통으로 가지 않는다)');
  // 옮기기 — 시험이 고른 단계에서 붙잡거나 복사 길을 강제한다
  const realRun = backupmove.run;
  let runMode = 'real';        // 'copy' 면 바꿔 달기를 EXDEV 로 막는다
  let holdAt = 0;              // 이 번째 파일을 복사한 뒤 moveGate 를 기다린다
  let moveGate = null;
  let failAt = 0;              // 이 번째 복사에서 ENOSPC
  let afterRun = null;         // 옮기기가 끝난 뒤(설정을 바꾸기 전) 한 번 부른다 — 설정 저장을 막는 시험
  const runs = [];
  const codeErr = (code) => Object.assign(new Error(`${code}: 시험`), { code });
  const runOnce = (pl, o) => {
    if (runMode === 'split') {
      // 셋째 바꿔 달기가 막히고, 둘째 항목은 끝내 되돌리지 못한다 (백신이 잡은 셈)
      const names = pl.entries.map((e) => e.name);
      let fwd = 0;
      return realRun(pl, {
        ...o,
        retryMs: [1, 1],
        io: {
          rename: async (s, d) => {
            if (path.dirname(s) === pl.from) { fwd += 1; if (fwd === 3) throw codeErr('EPERM'); } else if (path.basename(s) === names[1]) throw codeErr('EBUSY');
            return fs.promises.rename(s, d);
          }
        }
      });
    }
    if (runMode !== 'copy') return realRun(pl, o);
    let n = 0;
    return realRun(pl, {
      ...o,
      io: {
        rename: async () => { throw codeErr('EXDEV'); },
        copyFile: async (s, d, f) => {
          n += 1;
          if (n === failAt) throw codeErr('ENOSPC');
          await fs.promises.copyFile(s, d, f);
          if (n === holdAt && moveGate) await moveGate.promise;
        }
      }
    });
  };
  backupmove.run = async (pl, o = {}) => {
    runs.push({ at: Date.now(), files: pl.files });
    const r = await runOnce(pl, o);
    if (afterRun) { const f = afterRun; afterRun = null; f(); }
    return r;
  };
  let probes = 0;
  const realProbe = backuphome.probe;
  backuphome.probe = (...a) => { probes += 1; return realProbe(...a); };

  const acct = (id, name, user) => ({ id, name, user, host: `imap.${id}.invalid`, port: 993, enabled: true });
  const A1 = acct('a1', '네이버', 'a@x.invalid');
  const A2 = acct('a2', '이카운트', 'b@y.invalid');
  let accounts = [A1, A2];
  const backup = require(path.join(ROOT, 'src', 'backup.js'));
  backup.init({
    mailAccountsForUse: () => accounts,
    refreshMail: () => {},
    isSettingsWin: () => true,
    accountLive: () => true,
    tidyTiming: { FIRST_MS: 0, START_MS: 50, AGAIN_MS: 50, KICK_SLACK_MS: 20, GAP_MS: 3600_000, STOP_GRACE_MS: 300, MAX_MS: 5000, WAIT_MAX_MS: 4000 }
  });
  const F = backup.fillState;
  // 자동 전달·본문 — main.js 처럼 «옮기는 중»을 넘긴다
  const autofwd = require(path.join(ROOT, 'src', 'autofwd.js'));
  let fwdCalls = 0;
  autofwd.init({ machine: () => 'pc', mailAccountsForUse: () => { fwdCalls += 1; return []; }, backupMoving: () => backup.moving() });
  const mailbody = require(path.join(ROOT, 'src', 'mailbody.js'));
  mailbody.init({ mailAccountsForUse: () => accounts, backupMoving: () => backup.moving() });

  store.mailAccounts.splice(0, store.mailAccounts.length, A1, A2);
  store.setSettings({ mailEnabled: true, mailAutoBackup: true });
  const parent = { isDestroyed: () => false, tag: 'settings-window' };
  const E = (id) => tidyacct.entryOf(store.settings.mailTidyAccounts, id);
  const ans = (id) => (store.settings.mailFill || {})[id];

  // ── 이전 폴더 만들기 ──
  const V = '1700000000';
  const mk = (f, content) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  const emlOf = (uid) => `Message-ID: <m${uid}@corp.invalid>\r\nDate: Thu, 02 Jan 2025 09:00:00 +0000\r\nFrom: Kim <kim@corp.invalid>\r\nSubject: report ${uid}\r\nMIME-Version: 1.0\r\n\r\nbody ${uid}\r\n`;
  let seq = 0;
  /** Hibi 백업이 든 이전 폴더 (계정 둘, 정리 기록) — 파일 수를 돌려준다 */
  function fill(old, { unknown = false } = {}) {
    let n = 0;
    for (const [acc, uids] of [[A1, [1, 2, 3]], [A2, [10, 11]]]) {
      const r = mailbackup.patchState(old, mailbackup.accountKey(acc), 'INBOX', { uidValidity: V, gen: 1, lowUid: 1, lastUid: uids[uids.length - 1] });
      if (r.error) throw new Error(r.error);
      const bd = mailbackup.boxDirFor(old, acc, 'INBOX', 1);
      for (const u of uids) { mk(path.join(bd, `20250102_0900_${u}_report ${u}.eml`), emlOf(u)); n += 1; }
      mk(path.join(bd, mailindex.INDEX_FILE), `\n${J({ meta: true, v: 1, uidValidity: V })}\n${uids.map((u) => J({ uid: u, st: 'file' })).join('\n')}`);
      n += 1;
    }
    mk(path.join(old, mailtidy.MOVED_FILE), J({ v: 1, keys: ['moved-key-1'] }));
    n += 2;   // backup-state.json + tidy-moved.json
    if (unknown) mk(path.join(old, 'my-notes.txt'), 'mine');
    return n;
  }
  // 옮기기 일지 — 견주기(snap)에서는 빼고 따로 본다
  const JOURNAL = backupmove.JOURNAL_FILE || '.hibi-옮기는중.json';
  function snap(dir) {
    const out = {};
    if (!fs.existsSync(dir)) return out;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (d === dir && e.name === JOURNAL) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) { out[`${path.relative(dir, f)}/`] = true; walk(f); } else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      }
    };
    walk(dir);
    return out;
  }
  /** 새 판 — 이전 폴더(Hibi 백업), 정리 켬(a1 30일·a2 7일), 지난 메일 답(a1 yes·a2 no) */
  const reset = async ({ unknown = false, content = true } = {}) => {
    await until(() => !backup.moving() && !backup.backupStatus().running);
    asks.length = 0;
    parents.length = 0;
    trashed.length = 0;
    runs.length = 0;
    lines.length = 0;
    answer = null;
    askGate = null;
    runMode = 'real';
    holdAt = 0;
    failAt = 0;
    afterRun = null;
    moveGate = null;
    trashFail = () => false;
    carries = 0;
    backupHang = 0;
    stopLag = 0;
    const old = path.join(tmp, `old${++seq}`);
    fs.mkdirSync(old, { recursive: true });
    const files = content ? fill(old, { unknown }) : 0;
    store.setGatedSettings({ mailBackupDir: old, mailTidyAccounts: {}, mailTidyResults: {}, mailMoveHalt: null });
    store.setTidyAccount('a1', { on: true, days: 30 });
    store.setTidyAccount('a2', { on: true, days: 7 });
    store.clearFillAnswers();
    store.setFillAnswer('a1', 'yes');
    store.setFillAnswer('a2', 'no');
    Object.assign(F, { nextAt: Date.now() + 999_999, scanned: true });
    const to = path.join(tmp, `새 폴더 ${seq}`);
    pickPath = to;
    return { old, to, files };
  };
  const MOVE_BUTTONS = ['옮기기', '옮기지 않고 새 폴더만 쓰기', '그만두기'];

  console.log('\n[1] 묻는 창');
  {
    const { old, to, files } = await reset();
    const before = snap(old);
    answer = 2;
    const s = await backup.pickDir(parent);
    const q = asks[0] || {};
    ok(asks.length === 1 && q.title === '기존 메일 백업도 옮길까요?', '이전 폴더에 Hibi 백업이 있으면 묻는다', q.title);
    const pl = await backupmove.plan(old, to, { known: [] , freeBytes: async () => 1e15 });
    ok(String(q.message).includes(`파일 ${files}개`) && String(q.message).includes(backupmove.sizeText(pl.bytes)), '…파일 수와 크기를 말한다', q.message);
    ok(String(q.detail).includes('다 옮긴 뒤 이전 폴더의 백업은 휴지통으로 보냅니다. 옮기는 동안 백업·정리·지난 메일 받기는 쉽니다.')
      && String(q.detail).includes(old) && String(q.detail).includes(to), '…휴지통·쉬는 일을 말하고 두 폴더를 보인다', q.detail);
    ok(J(q.buttons) === J(MOVE_BUTTONS) && q.defaultId === 0 && q.focusId === 0 && !q.danger, '단추 셋 — 칠과 초점은 «옮기기»', { buttons: q.buttons, d: q.defaultId, f: q.focusId });
    ok(parents[0] === parent, '…설정 창을 부모로 띄운다');
    ok(store.settings.mailBackupDir === old && E('a1').on && E('a2').on && ans('a1') === 'yes' && J(snap(old)) === J(before) && /그만뒀습니다/.test(s.message),
      '«그만두기» — 폴더·정리·답·파일 모두 그대로', s.message);
  }

  console.log('\n[2] 옮기기 — 같은 볼륨');
  {
    const { old, to, files } = await reset();
    const before = snap(old);
    // 뒤 받기의 기억 — 메일함 폴더 경로를 열쇠로 둔 것은 새 폴더로 옮겨 적어야 한다 (rebaseFill)
    const oldBox = mailbackup.boxDirFor(old, A1, 'INBOX', 1);
    const elsewhere = path.join(tmp, '다른 곳', 'INBOX');
    F.memo.set('a1', { miss: new Map([[oldBox, 5]]), scanned: new Set([oldBox, elsewhere]), why: 'budget' });
    answer = 0;
    const s = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === to && s.dir === to, '설정이 새 폴더로 바뀌었다', s.dir);
    const newBox = mailbackup.boxDirFor(to, A1, 'INBOX', 1);
    const m1 = F.memo.get('a1') || {};
    ok(m1.miss instanceof Map && m1.miss.get(newBox) === 5 && !m1.miss.has(oldBox) && m1.scanned instanceof Set && m1.scanned.has(newBox)
      && !m1.scanned.has(oldBox) && m1.scanned.has(elsewhere) && m1.why === 'budget',
      '뒤 받기 기억 — 메일함 폴더 열쇠는 새 폴더로 옮겨 적고, 밖의 열쇠와 나머지 기억은 그대로', { miss: [...(m1.miss || [])], scanned: [...(m1.scanned || [])] });
    F.memo.delete('a1');
    ok(E('a1').on && E('a1').days === 30 && E('a2').on && E('a2').days === 7, '서버 정리는 켜진 채 (사본이 같이 옮겨졌다)', [E('a1'), E('a2')]);
    ok(ans('a1') === 'yes' && ans('a2') === 'no', '지난 메일 답도 그대로', store.settings.mailFill);
    ok(J(snap(to)) === J(before) && !fs.existsSync(old), '파일이 바이트까지 그대로 옮겨지고 빈 이전 폴더는 지웠다', Object.keys(snap(to)).length);
    ok(carries === 0 && trashed.length === 0, '정리 기록을 옮겨 적지 않는다 (파일째 옮겼다) · 바꿔 달기라 휴지통에 보낼 것이 없다', { carries, trashed });
    ok(/메일 백업을 옮겼습니다/.test(s.message) && s.message.includes(`파일 ${files}개`) && !/지우지 마세요/.test(s.message), '답 — 옮겼다 (예전의 «지우지 마세요»는 없다)', s.message);
    const moved = lines.filter((l) => l.startsWith('메일|백업 폴더 옮김'));
    ok(moved.length === 1 && moved[0].includes(`파일 ${files}개`) && !lines.some((l) => l.includes('@')) && !lines.some((l) => l.includes(old)),
      '기록 한 줄 «백업 폴더 옮김 · 파일 n개 · 크기» — 주소·경로는 없다', lines);
    ok(!s.move.running && !backup.moving() && F.picking === false, '끝나면 옮기는 중이 풀린다');
    // 옮긴 폴더로 계속 쓴다 — 기록과 저장한 파일을 새 폴더에서 찾는다
    ok(mailbackup.loadState(to)[mailbackup.accountKey(A1)].INBOX.lastUid === 3 && !!mailbackup.savedFile(to, A1, 'INBOX', 2),
      '새 폴더의 기록·파일을 그대로 찾는다');
  }

  console.log('\n[3] 옮기는 동안 — 복사 길');
  {
    const { old, to, files } = await reset();
    const before = snap(old);
    // 자동 전달을 켜 둔다 (이 PC 에서 확인한 그대로) — 옮기는 동안은 시작하지 않아야 한다
    const TO = ['fwd@corp.invalid'];
    store.setForwardSettings({ mailForwardOn: true, mailForwardTo: TO, mailForwardAccounts: ['a1'], mailForwardFp: { a1: mailfwd.fpOf(A1, TO, 'pc') } });
    runMode = 'copy';
    holdAt = 3;
    moveGate = gateOf();
    answer = 0;
    const picking = backup.pickDir(parent);
    ok(await until(() => backup.moving() && backup.backupStatus().move.done === holdAt - 1), '(셋째 파일에서 붙잡았다)', backup.backupStatus().move);
    const st = backup.backupStatus();
    ok(st.move.running && st.move.phase === 'copy' && st.move.total === files && st.move.done === holdAt - 1 && st.move.totalBytes > 0, '상태에 진행 — 옮긴 수/전체', st.move);
    // 이 폴더에 쓰는 일
    const b0 = backupCalls.length;
    const sb = await backup.startBackup();
    ok(!sb.running && /옮기는 중/.test(sb.message), '«백업 시작» — 거절', sb.message);
    await backup.autoBackupNew({ now: true });
    ok(backupCalls.length === b0, '자동 백업 — 돌지 않는다', backupCalls.length - b0);
    await backup.autoBackupOne(A1, { mailbox: 'INBOX', uid: 99, receivedAt: Date.now(), subject: 'x', source: Buffer.from(emlOf(99)) });
    const has99 = (d) => fs.existsSync(mailbackup.boxDirFor(d, A1, 'INBOX', 1)) && fs.readdirSync(mailbackup.boxDirFor(d, A1, 'INBOX', 1)).some((f) => /_99_/.test(f));
    ok(!has99(old) && !has99(to), '열어본 메일 저장 — 어느 폴더에도 쓰지 않는다');
    const t = await backup.setTidy({ id: 'a1', days: 0 }, parent, { fromSettings: true });
    ok(t.tidy.messageKind === 'wait' && /옮기는 중/.test(t.tidy.message) && E('a1').days === 30, '서버 정리 «바로»로 — 거절 (확인 창 없이)', t.tidy.message);
    const f = await backup.setFill({ id: 'a2', on: true }, parent, { fromSettings: true });
    ok(f.fill.messageKind === 'wait' && /옮기는 중/.test(f.fill.message) && ans('a2') === 'no', '지난 메일 받기 켜기 — 거절', f.fill.message);
    F.nextAt = 0;
    await backup.fillTick();
    ok(fillCalls === 0, '지난 메일 회차 — 돌지 않는다', fillCalls);
    const d0 = dialogs;
    const again = await backup.pickDir(parent);
    ok(dialogs === d0 && /옮기는 중/.test(again.message), '폴더 고르기 — 대화상자도 열지 않고 거절', again.message);
    await autofwd.forwardNew({ now: true });
    ok(fwdCalls === 0, '자동 전달 — 시작하지 않는다 (백업 파일·정리 기록을 읽는다)', fwdCalls);
    bodyFetches = 0;
    const view = await mailbody.localOrServer(A1, { uid: 1, mailbox: 'INBOX', seen: true });
    ok(bodyFetches === 1 && view === null && !lines.some((l) => l.includes('디스크에서 바로 열음')), '메일 열기 — 옮기는 동안은 백업 파일을 읽지 않고 서버로', bodyFetches);
    // 본문 미리 받기 — 저장 안 된 옛 메일(a2 의 uid 5, 기록의 lastUid 11 아래)을 고르려면 백업 폴더의 기록을 읽는다. 옮기는 동안은 건너뛴다
    let prefetches = 0;
    const realFetchSources = mail.fetchSources;
    mail.fetchSources = async () => { prefetches += 1; return 0; };
    mailbody.init({ mailState: { messages: [{ accountId: 'a2', uid: 5, mailbox: 'INBOX' }], folders: [], groups: [], sent: { messages: [] } } });
    await mailbody.prefetchBodies();
    ok(prefetches === 0, '본문 미리 받기 — 옮기는 동안은 백업 폴더를 읽지 않고 건너뛴다', prefetches);
    ok(asks.length === 1, '…그 사이 확인 창은 하나도 더 뜨지 않았다', asks.length);
    moveGate.open();
    const s = await picking;
    ok(store.settings.mailBackupDir === to && J(snap(to)) === J(before) && !fs.existsSync(old), '끝 — 설정이 바뀌고, 사본이 그대로이고, 이전 폴더는 비어 지웠다', s.message);
    ok(J(trashed.slice().sort()) === J([mailbackup.STATE_FILE, mailtidy.MOVED_FILE, ...[A1, A2].map((a) => path.basename(path.dirname(mailbackup.boxDirFor(old, a, 'INBOX', 1))))].sort()),
      '…Hibi 항목(계정 폴더 둘·상태 파일·정리 기록)을 하나씩 휴지통으로', trashed);
    ok(/메일 백업을 옮겼습니다/.test(s.message) && /휴지통/.test(s.message), '…답에 휴지통으로 보냈다고 쓴다', s.message);
    ok(E('a1').on && E('a2').on && ans('a1') === 'yes' && ans('a2') === 'no', '…정리·답 그대로');
    await autofwd.forwardNew({ now: true });
    ok(fwdCalls === 1, '끝난 뒤 자동 전달은 다시 돈다', fwdCalls);
    bodyFetches = 0;
    const view2 = await mailbody.localOrServer(A1, { uid: 1, mailbox: 'INBOX', seen: true });
    ok(bodyFetches === 0 && !!view2 && lines.some((l) => l.includes('디스크에서 바로 열음')), '…메일 열기는 새 폴더의 파일에서', bodyFetches);
    await mailbody.prefetchBodies();
    ok(prefetches === 1, '…본문 미리 받기도 다시 돈다 (새 폴더의 기록으로 고른다)', prefetches);
    mail.fetchSources = realFetchSources;
    mailbody.init({ mailState: { messages: [], folders: [], groups: [], sent: null } });
    await backup.autoBackupNew({ now: true });
    ok(backupCalls.length === b0 + 2 && backupCalls.slice(-2).every((c) => c.onlyNew), '…자동 백업도 다시 돈다 (새 폴더로)', backupCalls.length - b0);
    store.setForwardSettings({ mailForwardOn: false });
  }

  console.log('\n[4] 옮기지 않고 새 폴더만 쓰기 — 예전과 같다');
  {
    const { old, to } = await reset();
    const before = snap(old);
    answer = 1;
    const s = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === to && !E('a1').on && !E('a2').on && E('a2').days === 7, '설정은 새 폴더, 모든 계정의 정리를 끈다 (기간은 남는다)', [E('a1'), E('a2')]);
    ok(ans('a1') === undefined && ans('a2') === undefined && F.listed.size === 0, '지난 메일 답을 지운다 (새 폴더에서 다시 묻는다)', store.settings.mailFill);
    ok(carries === 1 && fs.existsSync(path.join(to, mailtidy.MOVED_FILE)), '정리 기록은 새 폴더로 옮겨 적는다', carries);
    ok(/모든 계정/.test(s.message) && s.message.includes(old) && /지우지 마세요/.test(s.message), '…«이전 폴더(…)를 지우지 마세요»', s.message);
    ok(J(snap(old)) === J(before) && runs.length === 0 && trashed.length === 0, '이전 폴더는 그대로 — 옮기지도 휴지통에 보내지도 않는다');
  }

  console.log('\n[5] 그만두기 · 창 닫기');
  for (const a of [2, null]) {
    const { old, to } = await reset();
    const before = snap(old);
    answer = a;
    const s = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === old && E('a1').on && ans('a1') === 'yes' && J(snap(old)) === J(before) && runs.length === 0
      && (!fs.existsSync(to) || fs.readdirSync(to).length === 0), `${a === null ? '창을 닫으면(Esc)' : '«그만두기»면'} 아무것도 안 바뀐다`, s.message);
  }

  console.log('\n[6] 묻지 않는 때');
  {
    // Hibi 것이 없는 이전 폴더
    const { old, to } = await reset({ content: false });
    fs.writeFileSync(path.join(old, 'my-notes.txt'), 'mine');
    answer = 0;
    await backup.pickDir(parent);
    ok(asks.length === 0 && store.settings.mailBackupDir === to && !E('a1').on && fs.existsSync(path.join(old, 'my-notes.txt')), '사용자 파일만 있으면 묻지 않고 예전처럼 바꾼다');
    // 없어진 이전 폴더
    const r2 = await reset({ content: false });
    fs.rmdirSync(r2.old);
    await backup.pickDir(parent);
    ok(asks.length === 0 && store.settings.mailBackupDir === r2.to, '이전 폴더가 없으면 묻지 않는다');
    // 처음 고르기
    await reset({ content: false });
    store.setGatedSettings({ mailBackupDir: null });
    const first = path.join(tmp, '처음');
    pickPath = first;
    await backup.pickDir(parent);
    ok(asks.length === 0 && store.settings.mailBackupDir === first, '처음 고를 때는 묻지 않는다');
  }

  console.log('\n[7] 옮길 수 없는 때');
  {
    let { old, to } = await reset();
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'backup-state.json'), '{}');
    answer = 1;
    let s = await backup.pickDir(parent);
    let q = asks[0] || {};
    ok(q.title === '기존 메일 백업은 옮길 수 없습니다' && /이미/.test(q.message) && J(q.buttons) === J(['옮기지 않고 새 폴더만 쓰기', '그만두기']) && q.focusId === 1 && q.defaultId === 1,
      '새 폴더에 이미 Hibi 백업 — 새 폴더만 쓰기·그만두기 (초점은 그만두기)', q);
    ok(store.settings.mailBackupDir === old && E('a1').on && runs.length === 0, '…«그만두기»면 그대로', s.message);
    answer = 0;
    asks.length = 0;
    const before = snap(old);
    s = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === to && !E('a1').on && J(snap(old)) === J(before) && runs.length === 0, '…«새 폴더만 쓰기»면 예전처럼 바꾼다 (옮기지 않는다)');
    ({ old } = await reset());
    pickPath = path.join(old, '안쪽');
    answer = 1;
    s = await backup.pickDir(parent);
    q = asks[0] || {};
    ok(q.title === '기존 메일 백업은 옮길 수 없습니다' && /안에/.test(q.message) && store.settings.mailBackupDir === old, '새 폴더가 이전 폴더 안 — 옮기지 않는다', q.message);
  }

  console.log('\n[8] 복사가 실패하면 그대로');
  {
    const { old, to } = await reset();
    const before = snap(old);
    runMode = 'copy';
    failAt = 4;
    answer = 0;
    const s = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === old && E('a1').on && E('a2').on && ans('a1') === 'yes', '설정·정리·답 모두 그대로', s.dir);
    ok(J(snap(old)) === J(before) && fs.readdirSync(to).length === 0 && trashed.length === 0, '이전 폴더는 바이트까지 그대로, 새 폴더는 비었다', fs.readdirSync(to));
    ok(/옮기지 못했습니다/.test(s.message) && /ENOSPC/.test(s.message) && /그대로/.test(s.message), '답 — 까닭과 «그대로»', s.message);
    ok(lines.some((l) => l.startsWith('메일|백업 폴더 옮기기 실패')) && !lines.some((l) => l.includes('@') || l.includes(old)), '기록 — 주소·경로 없이', lines);
    ok(!backup.moving(), '옮기는 중이 풀렸다');
  }

  console.log('\n[9] 휴지통 실패 · Hibi 것이 아닌 항목');
  {
    const { old, to } = await reset({ unknown: true });
    runMode = 'copy';
    trashFail = (p) => path.basename(p) === mailtidy.MOVED_FILE;
    answer = 0;
    const s = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === to, '옮겼다');
    ok(s.message.includes('이전 폴더의 백업을 휴지통으로 보내지 못했습니다 — 새 폴더에 모두 옮겨졌으니 직접 지워도 됩니다'), '휴지통 실패를 말한다', s.message);
    ok(s.message.includes('Hibi 것이 아닌 항목 1개는 그대로 두었습니다'), 'Hibi 것이 아닌 항목을 말한다', s.message);
    ok(J(fs.readdirSync(old).sort()) === J([mailtidy.MOVED_FILE, 'my-notes.txt'].sort()), '…이전 폴더에는 못 보낸 것과 사용자 파일이 남는다', fs.readdirSync(old));
    ok(lines.filter((l) => l.startsWith('메일|백업 폴더 옮김')).length === 1, '기록은 한 줄');
    asks.length = 0;
    const q0 = await reset({ unknown: true });
    answer = 2;
    await backup.pickDir(parent);
    ok(String((asks[0] || {}).detail).includes('Hibi 것이 아닌 항목 1개는 그대로 둡니다'), '묻는 창도 남겨 둘 항목 수를 말한다', (asks[0] || {}).detail);
    ok(store.settings.mailBackupDir === q0.old, '(그만뒀다)');
  }

  console.log('\n[10] 도는 자동 백업을 멈추고 기다린다 · 색인 버퍼를 먼저 쓴다');
  {
    // 묻는 창이 떠 있는 사이에 자동 백업이 시작됐다 (폴링) — «옮기기»를 누르면 멈추기를 기다린 뒤 옮긴다
    const { to } = await reset();
    backupHang = 3000;
    let auto = null;
    let calls0 = 0;
    answer = () => {
      calls0 = backupCalls.length;
      auto = backup.autoBackupNew({ now: true });
      return 0;
    };
    const s = await backup.pickDir(parent);
    await auto;
    const mine = backupCalls.slice(calls0);
    const last = mine[mine.length - 1] || {};
    ok(mine.length >= 1 && stopSeen.length >= 1 && runs.length === 1 && last.end <= runs[0].at && runs[0].at - mine[0].at < 2500,
      '자동 백업은 «옮기는 중»을 보고 다음 묶음 앞에서 멈췄고, 끝난 뒤에 옮겼다', { calls: mine.length, stop: stopSeen.length, gap: runs[0] && runs[0].at - last.end });
    ok(store.settings.mailBackupDir === to && /옮겼습니다/.test(s.message), '…옮겼다', s.message);
    backupHang = 0;

    // 색인 줄이 버퍼(250ms)에 남은 채 옮기기 — 옮기기 전에 써야 한다. 늦게 써지면 이전 자리에 폴더가 다시 생긴다
    const r2 = await reset();
    const box = mailbackup.boxDirFor(r2.old, A1, 'INBOX', 1);
    answer = () => { mailindex.append(box, { uid: 77, st: 'file' }); return 0; };
    const s2 = await backup.pickDir(parent);
    ok(store.settings.mailBackupDir === r2.to && /옮겼습니다/.test(s2.message), '(옮겼다)', s2.message);
    await sleep(500);
    const idxFile = path.join(mailbackup.boxDirFor(r2.to, A1, 'INBOX', 1), mailindex.INDEX_FILE);
    const idx = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '';
    ok(idx.includes('"uid":77') && !fs.existsSync(r2.old), '버퍼에 있던 색인 줄은 옮기기 전에 써져 새 폴더에 있고, 이전 자리가 다시 생기지 않는다', { old: fs.existsSync(r2.old) });
  }

  console.log('\n[11] 이어 붙인 곳');
  {
    const backupSrc = fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    ok(/ipcMain\.handle\('mail:backup-pick', \(e\) => pickDir\(BrowserWindow\.fromWebContents\(e\.sender\)\)\)/.test(backupSrc), '처리기는 보낸 창을 확인 창의 부모로 넘긴다');
    ok(/mailbody\.init\(\{[^}]*backupMoving: \(\) => backup\.moving\(\)/.test(mainSrc) && /autofwd\.init\(\{[\s\S]*?backupMoving: \(\) => backup\.moving\(\)[\s\S]*?\}\);/.test(mainSrc),
      'main.js 가 본문·자동 전달에 «옮기는 중»을 넘긴다');
    // 기본 폴더 — 개발·시험 실행은 드라이브를 살피지 않는다
    await reset({ content: false });
    store.setGatedSettings({ mailBackupDir: null });
    probes = 0;
    backup.ensureLocalFirst();
    ok(probes === 0 && store.settings.mailBackupDir === path.join(USER, 'mail'), '개발 실행 — D: 를 살피지 않고 userData\\mail', { probes, dir: store.settings.mailBackupDir });
    ok(/dataDrive: \(\) => backuphome\.probe\('D'\)/.test(backupSrc), '패키지 실행은 D: 를 살펴 후보로 넘긴다');
    ok(strays.length === 0, '창은 하나도 뜨지 않았다', strays.length);
  }

  const RESUME_TITLE = '옮기다 멈춘 메일 백업을 이어서 옮길까요?';
  const RESUME_BUTTONS = ['이어서 옮기기', '그만두기'];
  // 설정 파일 저장 막기 — 임시 파일 자리를 폴더로(바꿔치기 실패), 원본은 읽기 전용(직접 쓰기 실패). 이 시험의 임시 userData 안이다
  const SETTINGS_FILE = path.join(USER, 'nunsseom.json');
  const breakSave = () => { fs.mkdirSync(`${SETTINGS_FILE}.tmp`); fs.chmodSync(SETTINGS_FILE, 0o444); };
  const fixSave = () => {
    fs.chmodSync(SETTINGS_FILE, 0o666);
    try { fs.rmdirSync(`${SETTINGS_FILE}.tmp`); } catch { /* 없으면 그만 */ }
  };
  const disk = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).settings;

  console.log('\n[12] 설정 파일 저장이 실패하면');
  {
    // 복사 길 — 이전 폴더는 그대로다. 설정을 이전 폴더로 되돌리고 휴지통으로 보내지 않는다
    const { old, to } = await reset();
    const before = snap(old);
    runMode = 'copy';
    afterRun = breakSave;
    answer = 0;
    let s;
    try { s = await backup.pickDir(parent); } finally { fixSave(); }
    ok(store.settings.mailBackupDir === old && disk().mailBackupDir === old, '복사 길 — 설정을 이전 폴더로 되돌린다 (메모리·디스크)', [store.settings.mailBackupDir, disk().mailBackupDir]);
    ok(trashed.length === 0 && J(snap(old)) === J(before), '…이전 폴더의 백업을 휴지통으로 보내지 않는다', trashed);
    ok(/설정 파일을 저장하지 못/.test(s.message) && /지우지 않았/.test(s.message), '…답이 그렇게 말한다', s.message);
    ok(fs.existsSync(path.join(to, JOURNAL)), '…새 폴더의 사본에는 일지가 남는다 (다시 고르면 이어서)');
    ok(E('a1').on && ans('a1') === 'yes' && !backup.moving(), '…정리·답 그대로, 옮기는 중도 풀렸다');
    asks.length = 0;
    runMode = 'real';
    answer = 0;
    const s2 = await backup.pickDir(parent);
    ok((asks[0] || {}).title === RESUME_TITLE && store.settings.mailBackupDir === to && disk().mailBackupDir === to && J(snap(to)) === J(before)
      && !fs.existsSync(path.join(to, JOURNAL)), '…같은 폴더를 다시 고르면 «이어서 옮기기» — 사본을 지우고 다시 옮겨 마친다', { title: (asks[0] || {}).title, msg: s2.message });

    // 바꿔 달기 — 백업은 이미 새 폴더에만 있다. 이번 실행은 새 폴더를 쓰고, 디스크에는 «옮기기 멈춤»이 남는다
    const r2 = await reset();
    const b2 = snap(r2.old);
    afterRun = breakSave;
    answer = 0;
    let s3;
    try { s3 = await backup.pickDir(parent); } finally { fixSave(); }
    const d = disk();
    ok(store.settings.mailBackupDir === r2.to && !store.settings.mailMoveHalt, '바꿔 달기 — 이번 실행은 새 폴더를 쓴다 (백업이 거기에만 있다)', store.settings.mailBackupDir);
    ok(d.mailBackupDir === r2.old && !!d.mailMoveHalt && d.mailMoveHalt.to === r2.to, '…디스크에는 «옮기기 멈춤»이 남아 다시 켜면 이 폴더에 쓰지 않는다', d.mailMoveHalt);
    ok(/설정 파일을 저장하지 못/.test(s3.message), '…답이 그렇게 말한다', s3.message);
    // 다시 켠 셈 — 디스크 값으로 돌린다
    store.setGatedSettings({ mailBackupDir: d.mailBackupDir, mailMoveHalt: d.mailMoveHalt });
    ok(backup.moving() && !!store.settings.mailMoveHalt, '(다시 켠 셈 — 멈춘 채)');
    asks.length = 0;
    answer = 0;
    const s4 = await backup.pickDir(parent);
    ok((asks[0] || {}).title === RESUME_TITLE && store.settings.mailBackupDir === r2.to && !store.settings.mailMoveHalt && J(snap(r2.to)) === J(b2) && !backup.moving(),
      '…같은 새 폴더를 다시 고르면 마친다', { title: (asks[0] || {}).title, msg: s4.message });
  }

  console.log('\n[13] 옮기다 멈춤 — 바꿔 달기를 되돌리지 못함');
  {
    const { old, to } = await reset();
    const before = snap(old);
    runMode = 'split';
    answer = 0;
    const s = await backup.pickDir(parent);
    const h = store.settings.mailMoveHalt;
    ok(store.settings.mailBackupDir === old && !!h && h.to === to && h.from === old && !!disk().mailMoveHalt, '설정은 이전 폴더 그대로, «옮기기 멈춤»을 남긴다 (디스크에도)', h);
    ok(/멈췄습니다/.test(s.message) && /다시 골라/.test(s.message), '답 — 멈췄고, 같은 새 폴더를 다시 고르면 이어서', s.message);
    ok(backup.moving(), '…그동안은 «옮기는 중»과 같다 (자동 전달·본문 읽기도 쉰다)');
    const b0 = backupCalls.length;
    await backup.autoBackupNew({ now: true });
    ok(backupCalls.length === b0, '자동 백업 — 돌지 않는다', backupCalls.length - b0);
    await backup.autoBackupOne(A1, { mailbox: 'INBOX', uid: 98, receivedAt: Date.now(), subject: 'x', source: Buffer.from(emlOf(98)) });
    const has98 = (dd) => fs.existsSync(mailbackup.boxDirFor(dd, A1, 'INBOX', 1)) && fs.readdirSync(mailbackup.boxDirFor(dd, A1, 'INBOX', 1)).some((f) => /_98_/.test(f));
    ok(!has98(old) && !has98(to), '열어본 메일 저장 — 어느 폴더에도 쓰지 않는다');
    const sb = await backup.startBackup();
    ok(!sb.running && /끝나지 않았/.test(sb.message), '«백업 시작» — 거절', sb.message);
    const t = await backup.setTidy({ id: 'a1', days: 0 }, parent, { fromSettings: true });
    ok(t.tidy.messageKind === 'wait' && E('a1').days === 30, '서버 정리 «바로»로 — 거절', t.tidy.message);
    const fl = await backup.setFill({ id: 'a2', on: true }, parent, { fromSettings: true });
    ok(fl.fill.messageKind === 'wait' && ans('a2') === 'no', '지난 메일 받기 켜기 — 거절', fl.fill.message);
    const fc = fillCalls;
    F.nextAt = 0;
    await backup.fillTick();
    ok(fillCalls === fc, '지난 메일 회차 — 돌지 않는다');
    store.setSettings({ mailMoveHalt: null });
    ok(!!store.settings.mailMoveHalt, '일반 설정 길로는 «옮기기 멈춤»을 지우지 못한다');
    // 다른 폴더 — 거절 (남은 것을 엉뚱한 곳으로 옮기지 않는다)
    pickPath = path.join(tmp, `딴 폴더 ${seq}`);
    asks.length = 0;
    const s2 = await backup.pickDir(parent);
    ok(asks.length === 0 && store.settings.mailBackupDir === old && String(s2.message).includes(to), '다른 폴더를 고르면 — 거절하고 그때 고른 새 폴더를 말한다', s2.message);
    // 같은 새 폴더 — 이어서
    pickPath = to;
    runMode = 'real';
    asks.length = 0;
    answer = 0;
    const s3 = await backup.pickDir(parent);
    const q = asks[0] || {};
    ok(q.title === RESUME_TITLE && J(q.buttons) === J(RESUME_BUTTONS), '같은 새 폴더 — «이어서 옮기기»를 묻는다 (새 폴더만 쓰기는 없다)', q.buttons);
    ok(store.settings.mailBackupDir === to && !store.settings.mailMoveHalt && !disk().mailMoveHalt && J(snap(to)) === J(before) && !backup.moving(), '…다 옮기고 멈춤을 푼다', s3.message);
    const b1 = backupCalls.length;
    await backup.autoBackupNew({ now: true });
    ok(backupCalls.length === b1 + 2, '…자동 백업이 다시 돈다', backupCalls.length - b1);
  }

  console.log('\n[14] 옮기는 동안 종료·업데이트 설치는 미룬다');
  {
    await reset();
    runMode = 'copy';
    holdAt = 2;
    moveGate = gateOf();
    answer = 0;
    let quits = 0;
    const realQuit = app.quit;
    app.quit = () => { quits += 1; };
    try {
      const picking = backup.pickDir(parent);
      ok(await until(() => backup.moving() && backup.backupStatus().move.done >= 1), '(옮기는 중에 붙잡았다)');
      let prevented = 0;
      const held = typeof backup.holdQuit === 'function' ? backup.holdQuit({ preventDefault: () => { prevented += 1; } }) : false;
      ok(held === true && prevented === 1 && quits === 0, '옮기는 중 종료 — before-quit 을 막는다', { held, prevented });
      ok(/끝나면 종료/.test(backup.backupStatus().message || ''), '…상태에 «끝나면 종료»', backup.backupStatus().message);
      const updater = require(path.join(ROOT, 'src', 'updater.js'));
      updater.init({ busy: () => (backup.moveRunning && backup.moveRunning() ? '메일 백업을 옮기는 중입니다 — 끝난 뒤 다시 눌러주세요.' : '') });
      const got = updater.installNow();
      ok(got === false && /옮기는 중/.test(updater.getState().message), '업데이트 «지금 설치» — 옮기는 중에는 하지 않는다', [got, updater.getState().message]);
      moveGate.open();
      await picking;
      ok(await until(() => quits === 1, 2000), '…옮기기가 끝나면 다시 종료한다', quits);
      ok(typeof backup.holdQuit === 'function' && backup.holdQuit({ preventDefault: () => { prevented += 1; } }) === false && prevented === 1, '옮기는 중이 아니면 막지 않는다');
    } finally {
      app.quit = realQuit;
    }
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    ok(/app\.on\('before-quit', \(e\) => backup\.holdQuit\(e\)\)/.test(mainSrc), 'main.js — before-quit 이 옮기는 중인지 본다');
    ok(/updater\.init\(\{[\s\S]*?busy: \(\) =>[^\n]*backup\.moveRunning\(\)/.test(mainSrc), 'main.js — 업데이트 설치도 옮기는 중인지 본다');
  }

  console.log('\n[15] 옮기다 꺼진 뒤 다시 고르면');
  {
    const { old, to } = await reset();
    const before = snap(old);
    fs.mkdirSync(to, { recursive: true });
    const pl = await backupmove.plan(old, to, { known: [], freeBytes: async () => 1e15, sameVolume: false });
    let n = 0;
    // 끝나지 않는다 — 셋째 파일에서 앱이 꺼진 셈
    realRun(pl, { io: { copyFile: async (s, d, f) => { n += 1; await fs.promises.copyFile(s, d, f); if (n === 3) await new Promise(() => {}); } } });
    ok(await until(() => n >= 3), '(셋째 파일에서 꺼진 셈)');
    runMode = 'copy';
    answer = 0;
    const s = await backup.pickDir(parent);
    const q = asks[0] || {};
    ok(q.title === RESUME_TITLE && J(q.buttons) === J(RESUME_BUTTONS) && q.focusId === 0, '겹침이 아니라 «이어서 옮기기» — 새 폴더만 쓰기는 내지 않는다', { title: q.title, buttons: q.buttons });
    ok(/지우고 다시/.test(String(q.detail)), '…남은 조각은 지우고 다시 복사한다고 말한다', q.detail);
    ok(store.settings.mailBackupDir === to && J(snap(to)) === J(before) && !fs.existsSync(path.join(to, JOURNAL)) && E('a1').on && ans('a1') === 'yes',
      '…다 옮겼다 — 정리·답 그대로', s.message);
    // 다른 곳에서 옮기다 멈춘 조각이 있는 폴더
    const r2 = await reset();
    fs.mkdirSync(r2.to, { recursive: true });
    fs.writeFileSync(path.join(r2.to, JOURNAL), J({ v: 1, from: path.join(tmp, '다른 폴더'), entries: ['x'], renamed: [] }));
    answer = 0;
    const s2 = await backup.pickDir(parent);
    const q2 = asks[0] || {};
    ok(q2.title === '기존 메일 백업은 옮길 수 없습니다' && J(q2.buttons) === J(['그만두기']) && store.settings.mailBackupDir === r2.old && E('a1').on,
      '다른 곳에서 옮기다 멈춘 조각이 있는 폴더 — 그만두기만 (새 폴더만 쓰기를 내지 않는다)', { buttons: q2.buttons, msg: s2.message });
  }

  console.log('\n[16] «옮기기 멈춤»을 설정 파일에 남기지 못하면 바꿔 달지 않는다');
  {
    const { old, to } = await reset();
    const before = snap(old);
    answer = 0;
    breakSave();
    let s;
    try { s = await backup.pickDir(parent); } finally { fixSave(); }
    const left = fs.existsSync(to) ? fs.readdirSync(to) : [];
    ok(runs.length === 1 && J(snap(old)) === J(before) && left.length === 0, '같은 볼륨 — 하나도 바꿔 달지 않았다 (이전 폴더 그대로, 새 폴더는 비었다)', left);
    ok(store.settings.mailBackupDir === old && disk().mailBackupDir === old && trashed.length === 0, '…설정은 이전 폴더 그대로 (메모리·디스크), 휴지통에도 보내지 않았다',
      [store.settings.mailBackupDir, disk().mailBackupDir]);
    ok(/설정 파일을 저장하지 못해/.test(String(s && s.message)), '…답이 그렇게 말한다', s && s.message);
    ok(E('a1').on && E('a2').on && ans('a1') === 'yes' && ans('a2') === 'no', '…정리·답 그대로');
    ok(store.settings.mailMoveHalt == null && !backup.moving() && !/멈췄습니다 — 설정/.test(String(s && s.message)),
      '…메모리에도 멈춤이 남지 않는다 (백업·정리가 쉬지 않는다)', { halt: store.settings.mailMoveHalt, msg: s && s.message });
    store.setGatedSettings({ mailMoveHalt: null });
  }

  console.log('\n[17] 멈추라는 것을 본 뒤 늦게 끝나는 자동 백업 — 끝나기를 기다린 뒤에 옮긴다');
  {
    const { to } = await reset();
    backupHang = 3000;
    stopLag = 400;
    let auto = null;
    let calls0 = 0;
    answer = () => {
      calls0 = backupCalls.length;
      auto = backup.autoBackupNew({ now: true });
      return 0;
    };
    const s = await backup.pickDir(parent);
    await auto;
    const mine = backupCalls.slice(calls0);
    const last = mine[mine.length - 1] || {};
    ok(mine.length >= 1 && runs.length === 1 && last.end <= runs[0].at, '자동 백업이 멈추는 데 시간이 걸려도 끝난 뒤에 옮긴다 (quietForMove)',
      { calls: mine.length, gap: runs[0] && runs[0].at - last.end });
    ok(store.settings.mailBackupDir === to && /옮겼습니다/.test(s.message), '…옮겼다', s.message);
    backupHang = 0;
    stopLag = 0;
  }

  console.log('\n[18] 옮기기를 기다리는 사이에 끝난 자동 백업은 서버 정리로 이어 가지 않는다');
  {
    // 정리할 때가 된 계정 하나를 더한다 (a1·a2 는 앞 판의 실패로 다음 정리 시각이 멀다)
    const A3 = acct('a3', '셋째', 'c@z.invalid');
    const { to } = await reset();
    accounts = [A1, A2, A3];
    store.mailAccounts.push(A3);
    store.setTidyAccount('a3', { on: true, days: 30 });
    tidyCalls.length = 0;
    backupHang = 3000;
    let auto = null;
    answer = () => {
      auto = backup.autoBackupNew({ now: true });
      return 0;
    };
    const s = await backup.pickDir(parent);
    await auto;
    ok(store.settings.mailBackupDir === to && /옮겼습니다/.test(s.message), '(옮겼다)', s.message);
    ok(!tidyCalls.some((c) => c.moving), '옮기는 동안에는 서버 정리를 시작하지 않는다 (runTidy 가 옮기기를 본다)', tidyCalls);
    backupHang = 0;
    await backup.autoBackupNew({ now: true });
    ok(tidyCalls.some((c) => !c.moving), '…(이 판의 정리는 때가 됐다 — 옮긴 뒤의 자동 백업은 정리로 이어 간다)', tidyCalls.length);
    accounts = [A1, A2];
    store.mailAccounts.splice(store.mailAccounts.indexOf(A3), 1);
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
});

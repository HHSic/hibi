'use strict';
// 자동 전달의 문 — 메인 쪽 확인 창·일반 설정 길 막기·지문·상태·폴링 순서 (src/autofwd.js · src/store.js).
//
// 창을 하나도 띄우지 않는다. main.js 도 싣지 않는다 — autofwd.js 를 바로 부르고,
// 메일 서버(mail.connect)·보내기(send.transportFor)·확인 창(popup.askUser)은 바꿔 끼운다.
// 진짜 메일 서버·자격 증명 관리자는 건드리지 않고, 진짜 메일은 보내지 않는다.
//   [1] 기본값  [2] 일반 설정 길은 전달 설정을 못 바꾼다  [3] 정해진 길(setForwardSettings)의 값 다듬기
//   [4] 메일 확인을 끄면 전달도 꺼진다  [6] 정적 검사  [19] 상태 모양  [7] 설정 창에서만
//   [11] 이상한 요청·꺼진 채 저장 안 함  [14] 메일 확인이 꺼져 있으면  [8] 켜기는 묻는다  [12] 확인 창이 떠 있으면
//   [10] 켜진 채 바꾸기  [13] 묻는 사이에 끄면  [9] 끄기는 묻지 않는다  [16] 끝에서 끝까지  [17] 도는 중에 끄기·이어 보내기
//   [18] 폴링 간격  [5] 계정 정리 (지우기·서버 바꾸기·다시 켜기)  [15] 복사된 설정  [20] 전달이 도는 동안 정리는 시작하지 않는다
//   [21] 쓸 수 있는 계정이 없으면  [22] 묻는 사이에 바뀐 구성은 저장하지 않는다  [23] 상태 줄의 «실패:» 는 진짜 실패만
//   [24] 겹친 방어 (메일 확인 꺼짐·받는 주소와 같은 계정)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwdgate-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));
const acct = (id, name, user, over = {}) => ({
  id, name, provider: 'custom', host: `imap.${id}.invalid`, port: 993, user, sealed: null,
  smtpHost: `smtp.${id}.invalid`, smtpPort: 465, fromAddress: user, fromName: '', signature: '', enabled: true, ...over
});
// 예전 버전이 남긴 설정 파일 — 자동 전달 키가 없다. 계정 셋 (지메일은 받는 주소와 같은 계정)
fs.mkdirSync(path.join(tmp, 'Hibi'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Hibi', 'nunsseom.json'), JSON.stringify({
  settings: { mailCount: 5, mailEnabled: true },
  mailAccounts: [acct('a1', '회사a1', 'a1@corp.example'), acct('a2', '회사a2', 'a2@corp.example'), acct('g1', '지메일', 'me@gmail.com')],
  layoutVersion: 4
}));
const STATE_DIR = path.join(tmp, 'state');

let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 200 ? `${s.slice(0, 200)}…` : s}` : ''));
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return !!fn();
}
const V = 1700000000n;
const TARGET = 'ai.inbox@gmail.com';

app.on('browser-window-created', (_e, w) => {
  console.error('  실패 창이 만들어졌다 — 이 시험은 창을 띄우지 않는다');
  bad++;
  try { w.destroy(); } catch { /* 이미 없다 */ }
});

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  const lines = [];
  const allLines = [];
  evlog.log = (s, m) => { lines.push(`${s}|${m}`); allLines.push(`${s}|${m}`); };
  const mail = require(path.join(ROOT, 'src', 'mail.js'));
  const send = require(path.join(ROOT, 'src', 'send.js'));
  const mailfwd = require(path.join(ROOT, 'src', 'mailfwd.js'));
  const popup = require(path.join(ROOT, 'src', 'popup.js'));
  const { makeServer } = require(path.join(ROOT, 'test', 'fixtures', 'fake-imap.js'));

  // ── 가짜 메일 서버·가짜 보내기 ──
  const box = () => ({ boxes: [{ path: 'INBOX', uidValidity: V, uidNext: 'auto', msgs: [] }] });
  const server = makeServer({ a1: box(), a2: box(), g1: box(), x1: box(), x2: box() });
  let uidSeq = 1000;
  const addMail = (id, subject, { date = new Date() } = {}) => {
    const uid = (uidSeq += 3);
    const raw = `Message-ID: <m${uid}@corp.example>\r\nDate: ${date.toUTCString()}\r\nFrom: Kim <kim@corp.example>\r\n`
      + `To: ${id}@corp.example\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nbody ${subject}\r\n`;
    server.box(id, 'INBOX').msgs.push({ uid, raw, date, flags: new Set(), labels: new Set() });
    return uid;
  };
  mail.connect = (acc) => server.connect(acc);
  const tx = {
    sent: [], delay: 0,
    async sendMail({ envelope, raw }) {
      if (tx.delay) await sleep(tx.delay);
      const e = failFor ? failFor(envelope) : null;
      if (e) throw e;
      tx.sent.push({ envelope, raw: raw.toString('latin1') });
      return { accepted: envelope.to, rejected: [] };
    },
    close() {}
  };
  send.transportFor = () => tx;
  const sentSubjects = () => tx.sent.map((s) => (s.raw.match(/^Subject: (.*)$/m) || [])[1]);

  const asks = [];
  let answer = 1;
  let gate = null;
  let failFor = null;   // (envelope) => Error|null — 보내는 계정마다 SMTP 오류를 흉내 낸다
  popup.askUser = async (parent, o) => {
    asks.push(o);
    if (gate) await gate.promise;
    return typeof answer === 'function' ? answer(o) : answer;
  };
  const hold = () => { let open; const promise = new Promise((r) => { open = r; }); gate = { promise, open: () => { gate = null; open(); } }; return gate; };

  let usable = () => store.mailAccounts.filter((a) => a.enabled !== false).map((a) => ({ ...a, pass: 'test-only' }));
  let settingsWc = { id: 'settings-wc' };
  const autofwd = require(path.join(ROOT, 'src', 'autofwd.js'));
  autofwd.init({
    mailAccountsForUse: () => usable(),
    isSettingsWin: (wc) => wc === settingsWc,
    stateDir: () => STATE_DIR,
    machine: () => 'test-pc',
    fwdTiming: { GAP_MS: 60_000, MORE_MS: 300, MAX_MS: 5000, AGAIN_MS: 100 }
  });
  const parent = { isDestroyed: () => false };
  const set = (req, o = {}) => autofwd.setForward(req, 'parent' in o ? o.parent : parent, { fromSettings: true, ...o });
  const S = () => autofwd.fwdStatus({ full: true });
  const F = () => {
    const s = store.settings;
    return { on: s.mailForwardOn, to: s.mailForwardTo, accounts: s.mailForwardAccounts, since: s.mailForwardSince, fp: s.mailForwardFp, last: s.mailForwardLast };
  };
  const fwdKeys = () => JSON.stringify(F());
  const disk = () => store.reloadFromDisk().settings || {};
  const fstate = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, mailfwd.STATE_FILE), 'utf8')); } catch { return null; } };
  /** 켜기·바꾸기 뒤에 곧바로 도는 실행(기준 잡기)이 끝나기를 기다린다 */
  const settle = async () => { await sleep(60); await until(() => !S().running); };
  const M = (r) => ({ on: r.on, kind: r.messageKind, msg: r.message });
  const accOf = (id) => store.mailAccounts.find((a) => a.id === id);
  const fpFor = (id, to, m = 'test-pc') => mailfwd.fpOf(accOf(id), to, m);
  const RESET = { mailForwardOn: false, mailForwardTo: [], mailForwardAccounts: [], mailForwardSince: {}, mailForwardFp: {}, mailForwardLast: null };

  console.log('\n[1] 기본값');
  ok(JSON.stringify(F()) === JSON.stringify({ on: false, to: [], accounts: [], since: {}, fp: {}, last: null }), '예전 설정 파일(키 없음)이어도 꺼짐·[]·{}·{}·null', F());
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'store.js'), 'utf8');
  ok(/mailForwardOn: false,/.test(storeSrc) && /mailForwardLast: null,/.test(storeSrc), 'DEFAULT_SETTINGS 에 꺼짐·기록 없음');

  console.log('\n[2] 일반 설정 길은 자동 전달 설정을 못 바꾼다');
  lines.length = 0;
  store.setSettings({
    mailForwardOn: true, mailForwardTo: ['evil@attacker.example'], mailForwardAccounts: ['a1'], mailForwardSince: { a1: 1 },
    mailForwardFp: { a1: 'f'.repeat(32) }, mailForwardLast: { sent: 9 }, mailCount: 9
  });
  ok(JSON.stringify(F()) === JSON.stringify({ on: false, to: [], accounts: [], since: {}, fp: {}, last: null }) && store.settings.mailCount === 9,
    '여섯 키는 그대로, mailCount 만 저장', F());
  const d2 = disk();
  ok(d2.mailCount === 9 && d2.mailForwardOn === false && JSON.stringify(d2.mailForwardTo) === '[]', '디스크에도 막힌 값은 없다', { on: d2.mailForwardOn, to: d2.mailForwardTo });
  ok(lines.some((l) => /자동 전달 설정\(.*\)은 일반 설정 길로 바꿀 수 없습니다 — 무시했습니다/.test(l)) && !lines.some((l) => /attacker|@/.test(l)),
    '기록에 «무시»가 남고 주소는 남지 않는다', lines);
  store.setGatedSettings({ mailForwardOn: true, mailForwardTo: ['evil@attacker.example'] });
  ok(store.settings.mailForwardOn === false && store.settings.mailForwardTo.length === 0, '서버 정리 길(setGatedSettings)도 전달 키를 무시한다');
  ok(JSON.stringify(store.FORWARD_SETTINGS) === JSON.stringify(['mailForwardOn', 'mailForwardTo', 'mailForwardAccounts', 'mailForwardSince', 'mailForwardFp', 'mailForwardLast'])
    && JSON.stringify(store.GATED_SETTINGS) === JSON.stringify(['mailServerTidy', 'mailTidyDays', 'mailBackupDir', 'mailTidyLast']), 'FORWARD_SETTINGS 여섯 키, GATED_SETTINGS 는 그대로 넷');

  console.log('\n[3] 정해진 길(setForwardSettings) — 값 다듬기');
  store.setForwardSettings({ mailForwardTo: ['A@Gmail.COM', 'bad', '한글@gmail.com', 'a%b@gmail.com', 'Kim@gmail.com', 'a@gmail.com', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io', 'f@x.io'] });
  ok(JSON.stringify(store.settings.mailForwardTo) === JSON.stringify(['a@gmail.com', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io']),
    '대문자는 소문자로, 이상한·한글·% 주소·켈빈 기호(U+212A)는 버리고, 중복을 지우고 5개까지', store.settings.mailForwardTo);
  ok(['me@x', 'a@b.c1', 'a..b@x.io', '.a@x.io', 'a@-x.io', 'a b@x.io', ''].every((x) => store.normFwdAddr(x) === '') && store.normFwdAddr(' Me@Example.ORG ') === 'me@example.org',
    'normFwdAddr — 최상위 도메인·점·하이픈·공백 규칙, 앞뒤 공백은 다듬는다');
  store.setForwardSettings({ mailForwardOn: true, mailForwardTo: [] });
  ok(store.settings.mailForwardOn === false, '켜짐인데 받는 주소가 없으면 꺼짐 (저장소가 마지막 방어선)');
  store.setForwardSettings({
    mailForwardAccounts: ['a1', 'bad id!', 5, 'a1', 'a2'],
    mailForwardSince: { a1: '12', 'bad id': 3, a2: 'x' },
    mailForwardFp: { a1: 'a'.repeat(32), a2: 'xyz', g1: 'A'.repeat(32) },
    mailForwardLast: { at: '5', sent: 'x', more: 1, capped: true, error: 'e'.repeat(300), total: '7', evil: 1 }
  });
  const s3 = store.settings;
  ok(JSON.stringify(s3.mailForwardAccounts) === '["a1","a2"]' && JSON.stringify(s3.mailForwardSince) === '{"a1":12,"a2":0}'
    && JSON.stringify(s3.mailForwardFp) === JSON.stringify({ a1: 'a'.repeat(32) }), 'id 규칙·since 숫자·fp 32 hex 만', [s3.mailForwardAccounts, s3.mailForwardSince, s3.mailForwardFp]);
  const l3 = s3.mailForwardLast;
  ok(l3.at === 5 && l3.sent === 0 && l3.more === false && l3.capped === true && l3.error.length === 200 && l3.total === 7 && !('evil' in l3),
    'mailForwardLast — 숫자·참거짓·200자·정해진 키만', l3);
  store.setForwardSettings({ mailForwardAccounts: 'a1', mailForwardSince: [1], mailForwardFp: null, mailForwardLast: 'x' });
  ok(JSON.stringify(F()) === JSON.stringify({ on: false, to: s3.mailForwardTo, accounts: [], since: {}, fp: {}, last: null }), '모양이 틀리면 빈 값', F());
  store.setForwardSettings(RESET);

  console.log('\n[4] «메일 확인하기»를 끄면 자동 전달도 꺼진다');
  store.setForwardSettings({ mailForwardOn: true, mailForwardTo: [TARGET], mailForwardAccounts: ['a1'], mailForwardFp: { a1: 'a'.repeat(32) } });
  lines.length = 0;
  store.setSettings({ mailEnabled: false });
  ok(store.settings.mailForwardOn === false && JSON.stringify(store.settings.mailForwardFp) === '{}' && lines.some((l) => /자동 전달 꺼짐 — «메일 확인하기»를 꺼서/.test(l)),
    '꺼지고 지문도 지워지고 기록이 남는다', { on: store.settings.mailForwardOn, lines });
  store.setSettings({ mailEnabled: true });
  ok(store.settings.mailForwardOn === false, '…다시 켜도 저절로 켜지지 않는다');
  // false 가 아닌 거짓 값(0·null·'')도 — mailhub 은 !mailEnabled 로 메일 확인을 끈다. 전달이 켜진 채 쉬다가 다시 켤 때 묻지 않고 돌면 안 된다
  for (const v of [0, null, '']) {
    store.setForwardSettings({ mailForwardOn: true, mailForwardTo: [TARGET], mailForwardAccounts: ['a1'], mailForwardFp: { a1: 'a'.repeat(32) } });
    store.setSettings({ mailEnabled: v });
    ok(store.settings.mailForwardOn === false && JSON.stringify(store.settings.mailForwardFp) === '{}' && store.settings.mailEnabled === false,
      `{ mailEnabled: ${JSON.stringify(v)} } 도 false 로 저장하고 자동 전달을 끈다`, { on: store.settings.mailForwardOn, enabled: store.settings.mailEnabled });
    store.setSettings({ mailEnabled: true });
  }
  store.setGatedSettings({ mailServerTidy: true });
  store.setSettings({ mailAutoBackup: 0 });
  ok(store.settings.mailServerTidy === false && store.settings.mailAutoBackup === false, '{ mailAutoBackup: 0 } 도 false 로 — 서버 정리도 꺼진다', { tidy: store.settings.mailServerTidy });
  store.setForwardSettings(RESET);

  console.log('\n[6] 정적 검사');
  {
    const srcDir = path.join(ROOT, 'src');
    const srcs = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);
    const fwdCallers = srcs.filter(([f, s]) => f !== 'store.js' && /setForwardSettings\(/.test(s)).map(([f]) => f);
    ok(JSON.stringify(fwdCallers) === '["autofwd.js"]', 'setForwardSettings( 를 부르는 곳은 autofwd.js 뿐', fwdCallers);
    const gatedCallers = srcs.filter(([f, s]) => f !== 'store.js' && /setGatedSettings\(/.test(s)).map(([f]) => f);
    ok(JSON.stringify(gatedCallers) === '["backup.js"]', 'setGatedSettings( 는 여전히 backup.js 뿐', gatedCallers);
    const assigns = srcs.filter(([f, s]) => f !== 'store.js' && /\.mailForward\w+\s*=[^=]/.test(s)).map(([f]) => f);
    ok(!assigns.length, 'store.js 밖에 .mailForward… = 대입이 없다', assigns);
    const pre = fs.readFileSync(path.join(srcDir, 'preload.js'), 'utf8');
    ok(/mailFwdStatus: \(\) => ipcRenderer\.invoke\('mail:fwd-status'\)/.test(pre) && /mailFwdSet: \(req\) => ipcRenderer\.invoke\('mail:fwd-set', req\)/.test(pre),
      'preload 에 mailFwdStatus · mailFwdSet');
    const mainSrc = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');
    const fwdInit = (mainSrc.match(/autofwd\.init\(\{[\s\S]*?\n\}\);/) || [''])[0];
    const bkInit = (mainSrc.match(/backup\.init\(\{[\s\S]*?\n\}\);/) || [''])[0];
    ok(/isSettingsWin: \(wc\) => isSettingsSender\(wc\)/.test(fwdInit) && /mailAccountsForUse: \(\) => mailhub\.mailAccountsForUse\(\)/.test(fwdInit),
      'main.js autofwd.init 에 isSettingsWin: (wc) => isSettingsSender(wc)', fwdInit.slice(0, 80));
    ok(/forwardBusy: \(\) => autofwd\.busy\(\)/.test(bkInit), 'main.js backup.init 에 forwardBusy: () => autofwd.busy()');
    ok(/autofwd\.isOn\(\) \? \[\{ label: '메일 자동 전달 켜짐', click: \(\) => openSettings\('mail'\) \}\]/.test(mainSrc), '트레이에 autofwd.isOn() 일 때 «메일 자동 전달 켜짐» → 설정 › 메일');
    const af = fs.readFileSync(path.join(srcDir, 'autofwd.js'), 'utf8');
    ok(/ipcMain\.handle\('mail:fwd-set'[\s\S]{0,200}fromSettings: !!host\.isSettingsWin\(e\.sender\) && mainFrameOf\(e\)/.test(af)
      && /ipcMain\.handle\('mail:fwd-status', \(e\) => fwdStatus\(\{ full: !!host\.isSettingsWin\(e\.sender\) \}\)\)/.test(af),
    'autofwd — fwd-set 은 설정 창의 본 문서(mainFrameOf)만, fwd-status 는 설정 창만 full');
    const hub = fs.readFileSync(path.join(srcDir, 'mailhub.js'), 'utf8');
    const refresh = (hub.match(/async function refreshMail\([\s\S]*?\n\}\n/) || [''])[0];
    ok(/autofwd\.forwardNew\(\)\.catch\(\(\) => \{\}\)\.then\(\(\) => autoBackupNew\(\)\)/.test(refresh) && !/^\s*autoBackupNew\(\);/m.test(hub),
      'mailhub refreshMail — 자동 전달 뒤에 자동 백업(그 끝에 정리), 따로 떨어진 autoBackupNew(); 는 없다');
    ok(/if \(!accounts\.length\) \{[\s\S]*?logSkip\(problems\);\s*\n[^\n]*\n\s*autofwd\.forwardNew\(\)\.catch\(\(\) => \{\}\);\s*\n\s*return;/.test(refresh),
      '…쓸 계정이 없어 일찍 돌아가는 길에서도 자동 전달을 부른다 (상태가 «시작 전»에 멈추지 않게)');
    const bk = fs.readFileSync(path.join(srcDir, 'backup.js'), 'utf8');
    const runTidy = (bk.match(/async function runTidy\([\s\S]*?tidy\.running = true;/) || [''])[0];
    ok(/\|\| host\.forwardBusy\(\)\) return;/.test(runTidy) && /forwardBusy: \(\) => false/.test(bk), 'backup.js runTidy 문에 host.forwardBusy(), 기본값은 false');
    const pop = fs.readFileSync(path.join(srcDir, 'popup.js'), 'utf8');
    ok(/kind: 'dialog'[^}]*focusId, armMs/.test(pop), 'src/popup.js 가 armMs 를 openPopup 데이터에 싣는다');
    const rpop = fs.readFileSync(path.join(ROOT, 'renderer', 'popup.js'), 'utf8');
    ok(/if \(e\.detail > 0 && performance\.now\(\) < armUntil\) return;/.test(rpop) && /onmousedown = \(e\) => \{ if \(performance\.now\(\) < armUntil\) e\.preventDefault\(\); \}/.test(rpop),
      'renderer/popup.js — 뜬 직후의 마우스 클릭(detail > 0)은 받지 않고, 그 누르기가 초점도 옮기지 않는다');
    const sendSrc = fs.readFileSync(path.join(srcDir, 'send.js'), 'utf8');
    ok(/module\.exports = \{[^}]*transportFor/.test(sendSrc), 'send.js 가 transportFor 를 내보낸다');
    ok(/ipcMain\.handle\('settings:get', \(\) => \(\{\s*settings: \{ \.\.\.store\.publicSettings\(\), autoLaunch/.test(mainSrc)
      && /settings: store\.publicSettings\(\)/.test(hub) && !/settings: store\.settings\b/.test(hub),
    'settings:get·mail:add 는 store.publicSettings() — 보낸 창을 보지 않는 처리기가 받는 주소·지문을 주지 않는다');
    const pub = store.publicSettings();
    ok(store.FORWARD_SETTINGS.every((k) => !(k in pub)) && 'mailEnabled' in pub, 'publicSettings 에는 mailForward* 키가 없다', Object.keys(pub).filter((k) => /^mailForward/.test(k)));
  }

  console.log('\n[19] 상태 모양');
  const KEYS = ['on', 'to', 'accounts', 'ready', 'why', 'stale', 'running', 'asking', 'at', 'sent', 'skipped', 'uncertain',
    'more', 'capped', 'error', 'total', 'max', 'message', 'messageKind'];
  {
    const s = S();
    ok(JSON.stringify(Object.keys(s)) === JSON.stringify(KEYS), 'FwdStatus 키 목록이 고정 계약과 같다', Object.keys(s));
    const a = s.accounts.find((x) => x.id === 'a1');
    ok(JSON.stringify(Object.keys(a)) === '["id","name","addr","on","self","enabled","changed","addrs"]' && a.name === '회사a1' && a.addr === 'a1@corp.example'
      && JSON.stringify(a.addrs) === '["a1@corp.example"]', 'accounts[] — id·name·addr·on·self·enabled·changed·addrs', a);
    ok(s.ready === true && s.why === '' && s.max === 5 && s.on === false && s.stale === false && s.at === 0 && s.error === null, '처음 — 준비됨·꺼짐·결과 없음', s);
  }

  console.log('\n[7] 설정 창에서만');
  {
    const n = asks.length;
    let r = await set({ on: true, to: [TARGET], accounts: ['a1'] }, { fromSettings: false });
    ok(S().messageKind === 'bad' && S().message === '자동 전달은 설정 창에서만 바꿀 수 있습니다.' && asks.length === n && !store.settings.mailForwardOn,
      '설정 창이 아닌 곳 → 거절 (답 글은 설정 창이 읽는 상태에 남는다)', M(S()));
    ok(r.to.length === 0 && r.accounts.length === 0 && r.message === '' && r.messageKind === '' && JSON.stringify(Object.keys(r)) === JSON.stringify(Object.keys(S())),
      '…설정 창이 아니면 답은 키는 같고 값을 비운 상태 (주소·계정·답 글 없음)', { to: r.to, accounts: r.accounts.length, msg: r.message });
    r = await set({ on: true, to: [TARGET], accounts: ['a1'] }, { parent: null });
    ok(r.messageKind === 'bad' && /설정 창에서만/.test(r.message) && asks.length === n && !store.settings.mailForwardOn, '부모 창이 없으면 → 거절', M(r));
  }

  console.log('\n[11] 이상한 요청 — 묻지 않고, 꺼진 채로는 저장하지 않는다');
  {
    const n = asks.length;
    const before = fwdKeys();
    const cases = [
      [{ to: [TARGET] }, '꺼진 채로는 저장하지 않습니다.'],
      [{ accounts: ['a1'] }, '꺼진 채로는 저장하지 않습니다.'],
      [{ on: true, to: ['bad'], accounts: ['a1'] }, '주소 형식이 이상합니다 — bad'],
      [{ on: true, to: ['한글@gmail.com'], accounts: ['a1'] }, '주소 형식이 이상합니다 — 한글@gmail.com'],
      [{ on: true, to: 'me%evil.example@relay.example', accounts: ['a1'] }, '주소 형식이 이상합니다 — me%evil.example@relay.example'],
      [{ on: true, to: ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io', 'f@x.io'], accounts: ['a1'] }, '받는 주소는 5개까지입니다.'],
      [{ on: true, to: [], accounts: ['a1'] }, '받는 주소를 넣어주세요.'],
      [{ on: true, to: [TARGET], accounts: ['nope'] }, '없는 계정이 섞여 있습니다.'],
      [{ on: true, to: [TARGET], accounts: 'a1' }, '없는 계정이 섞여 있습니다.'],
      [{ on: true, to: [TARGET], accounts: [] }, '전달할 계정을 골라주세요.'],
      [{ on: true, to: ['me@gmail.com'], accounts: ['a1', 'g1'] }, '지메일 계정은 받는 주소와 같아 고를 수 없습니다.']
    ];
    for (const [req, want] of cases) {
      const r = await set(req);
      ok(r.messageKind === 'bad' && r.message === want, `${JSON.stringify(req)} → «${want}»`, M(r));
    }
    ok(asks.length === n && fwdKeys() === before && JSON.stringify(disk().mailForwardTo) === '[]', '…묻지 않았고, 설정·디스크에 아무것도 바뀌지 않았다', { asks: asks.length - n });
    let threw = null;
    try {
      for (const req of [null, 5, 'x', { on: 'yes' }]) await set(req);
    } catch (e) { threw = e; }
    ok(!threw && asks.length === n && store.settings.mailForwardOn === false, 'null·5·글·{on:"yes"} 는 던지지 않고 바꾸지도 않는다', threw && threw.message);
  }

  console.log('\n[14] «메일 확인하기»가 꺼져 있으면');
  {
    store.setSettings({ mailEnabled: false });
    const n = asks.length;
    const r = await set({ on: true, to: [TARGET], accounts: ['a1'] });
    ok(r.messageKind === 'bad' && r.message === '«메일 확인하기»를 켜야 쓸 수 있습니다.' && r.ready === false && r.why === r.message && asks.length === n,
      '«bad», ready false, why 가 붙고 묻지 않는다', M(r));
    store.setSettings({ mailEnabled: true });
    ok(S().ready === true, '…다시 켜면 ready');
  }

  console.log('\n[12]·[8] 켜기는 묻는다');
  {
    // [12] 확인 창이 떠 있는 동안 또 요청하면
    const g = hold();
    answer = 1;
    const n = asks.length;
    const p = set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await until(() => asks.length === n + 1);
    const busy = S();
    const r2 = await set({ on: true, to: [TARGET], accounts: ['a1'] });
    ok(busy.asking === true && r2.messageKind === 'wait' && r2.message === '확인 창이 떠 있습니다 — 거기서 골라주세요.' && asks.length === n + 1,
      '[12] 확인 창이 떠 있는 동안의 두 번째 요청은 묻지 않고 «거기서 골라주세요»', M(r2));
    g.open();
    let r = await p;
    ok(r.on === false && r.messageKind === 'wait' && r.message === '그만뒀습니다 — 바뀐 것 없습니다.' && r.asking === false, '«그만두기» → 꺼진 채, asking 은 내려가 있다', M(r));
    ok(fwdKeys() === JSON.stringify({ on: false, to: [], accounts: [], since: {}, fp: {}, last: null }), '…주소·계정도 저장하지 않았다', F());
    const q = asks[asks.length - 1];
    ok(q.title === '자동 전달 켜기' && q.message === `새 메일을 ${TARGET} 으로 전달할까요?` && q.detail === '회사a1 · 회사a2 계정\n회사 메일이 회사 밖으로 나갑니다.'
      && JSON.stringify(q.buttons) === '["전달 켜기","그만두기"]' && q.danger === true && q.defaultId === 0 && q.focusId === 1 && q.armMs === 800,
    '확인 창 — 주소 그대로·계정 이름·두 줄 detail·빨간 «전달 켜기»·초점은 «그만두기»·armMs 800', q);
    answer = null;
    r = await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    ok(r.on === false && /그만뒀습니다/.test(r.message), '창을 그냥 닫음(null) → 꺼진 채', M(r));
    // 계정을 안 주면 기본 — 켜 둔 계정 중 받는 주소와 같은 계정(지메일)은 뺀다
    answer = 1;
    await set({ on: true, to: ['ME@gmail.com'] });
    const q2 = asks[asks.length - 1];
    ok(q2.message === '새 메일을 me@gmail.com 으로 전달할까요?' && q2.detail.split('\n')[0] === '회사a1 · 회사a2 계정', '계정을 안 주면 받는 주소와 같은 계정(지메일)은 빠진다 — 주소는 소문자로 보인다', q2);
    // 받아들인다
    answer = 0;
    const t0 = Date.now();
    r = await set({ on: true, to: ['AI.Inbox@Gmail.com'], accounts: ['a2', 'a1'] });
    const f = F();
    ok(r.on === true && r.messageKind === 'good' && r.message === '켰습니다 — 지금부터 오는 메일을 전달합니다.', '«전달 켜기» → 켜진다', M(r));
    ok(JSON.stringify(f.to) === JSON.stringify([TARGET]) && JSON.stringify(f.accounts) === '["a1","a2"]' && f.since.a1 >= t0 && f.since.a2 >= t0
      && f.fp.a1 === fpFor('a1', [TARGET]) && f.fp.a2 === fpFor('a2', [TARGET]) && f.last === null,
    '켜짐·받는 주소(소문자)·계정(store 순서)·계정마다 since 와 지문(32 hex)', f);
    const dk = disk();
    ok(dk.mailForwardOn === true && JSON.stringify(dk.mailForwardTo) === JSON.stringify([TARGET]), '…디스크에도');
    await settle();
    const st = fstate();
    ok(st && st.acc.a1 && st.acc.a2 && st.acc.a1.since === f.since.a1 && !st.acc.g1, '곧바로 기준을 잡는다 (전달 기록에 두 계정, 지메일은 없음)', st && Object.keys(st.acc));
    ok(lines.some((l) => /자동 전달 켬 · 받는 주소 1개 · 계정 2개/.test(l)) && !lines.some((l) => /ai\.inbox/.test(l)), '기록에 «자동 전달 켬 · 받는 주소 1개 · 계정 2개» — 주소는 적지 않는다', lines.filter((l) => /자동 전달/.test(l)));
    ok(S().stale === false && autofwd.isOn() === true && S().accounts.filter((a) => a.on).map((a) => a.id).join() === 'a1,a2', '상태 — 켜짐, 트레이용 isOn() 참, 계정 on', S().accounts.map((a) => [a.id, a.on]));
  }

  console.log('\n[10] 켜진 채 바꾸기');
  {
    const since0 = { ...F().since };
    let n = asks.length;
    answer = 1;
    let r = await set({ to: [TARGET, 'Second@Example.org'] });
    const q = asks[asks.length - 1];
    ok(asks.length === n + 1 && q.title === '자동 전달 바꾸기' && q.message === '새 메일을 second@example.org 으로도 전달할까요?'
      && q.detail === `회사a1 · 회사a2 계정 → ${TARGET}, second@example.org\n회사 메일이 회사 밖으로 나갑니다.` && q.buttons[0] === '바꾸기',
    '주소 더하기는 묻는다 — message 에 새 주소만', q);
    ok(r.messageKind === 'wait' && F().to.length === 1, '…그만두면 그대로', F().to);
    answer = 0;
    r = await set({ to: [TARGET, 'second@example.org'] });
    await settle();
    const two = [TARGET, 'second@example.org'];
    ok(r.messageKind === 'good' && r.message === '바꿨습니다.' && JSON.stringify(F().to) === JSON.stringify(two) && F().fp.a1 === fpFor('a1', two)
      && JSON.stringify(F().since) === JSON.stringify(since0), '…받아들이면 주소 2개, 지문은 새 받는 주소로, 보내던 계정의 since 는 그대로', F());
    n = asks.length;
    r = await set({ to: [TARGET] });
    ok(asks.length === n && r.message === '바꿨습니다.' && JSON.stringify(F().to) === JSON.stringify([TARGET]) && F().fp.a1 === fpFor('a1', [TARGET]) && F().fp.a2 === fpFor('a2', [TARGET]),
      '주소 빼기는 묻지 않고, 남은 계정의 지문을 새 받는 주소로 다시 적는다', F().fp);
    r = await set({ accounts: ['a1'] });
    ok(asks.length === n && r.message === '바꿨습니다.' && JSON.stringify(F().accounts) === '["a1"]' && !F().fp.a2 && F().since.a2 === undefined, '계정 빼기는 묻지 않는다 (그 계정의 since·지문도 뺀다)', F());
    r = await set({ accounts: ['a1'] });
    ok(asks.length === n && r.message === '' && r.messageKind === '', '같은 요청 → 바뀐 것 없음 (message 빈 글)', M(r));
    answer = 1;
    r = await set({ accounts: ['a1', 'a2'] });
    const q3 = asks[asks.length - 1];
    ok(asks.length === n + 1 && q3.message === '회사a2 계정 메일도 전달할까요?' && q3.detail.startsWith('회사a2 · 회사a1 계정 → '), '계정 더하기는 묻는다 — message 에 그 계정 이름, detail 에는 새 계정이 앞에', q3);
    ok(r.messageKind === 'wait' && JSON.stringify(F().accounts) === '["a1"]', '…그만두면 그대로');
    answer = 0;
    const t1 = Date.now();
    r = await set({ accounts: ['a1', 'a2'] });
    await settle();
    ok(r.message === '바꿨습니다.' && JSON.stringify(F().accounts) === '["a1","a2"]' && F().since.a1 === since0.a1 && F().since.a2 >= t1,
      '…받아들이면 그 계정의 since 만 새로 (보내던 계정은 그대로)', F().since);
    n = asks.length;
    r = await set({ to: [] });
    ok(asks.length === n && r.on === false && r.message === '받는 주소가 없어 껐습니다.' && JSON.stringify(F().fp) === '{}', '주소를 다 빼면 꺼진다 (묻지 않는다)', M(r));
    answer = 0;
    r = await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    r = await set({ accounts: [] });
    ok(r.on === false && r.message === '전달할 계정이 없어 껐습니다.', '계정을 다 빼도 꺼진다', M(r));
  }

  console.log('\n[13]·[9] 묻는 사이에 끄면 끈 것이 이긴다 · 끄기는 묻지 않는다');
  {
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    const g = hold();
    const n = asks.length;
    const p = set({ to: [TARGET, 'third@example.org'] });
    await until(() => asks.length === n + 1);
    const off = await autofwd.setForward({ on: false }, null, { fromSettings: false });
    ok(off.on === false && S().message === '껐습니다.' && asks.length === n + 1 && store.settings.mailForwardOn === false,
      '[9] 끄기는 묻지 않고 설정 창이 아니어도(부모 없어도) 된다', M(S()));
    ok(off.to.length === 0 && off.accounts.length === 0 && off.message === '', '…설정 창이 아니면 답에 주소·계정·답 글이 없다');
    ok(JSON.stringify(F().fp) === '{}' && JSON.stringify(F().to) === JSON.stringify([TARGET]), '…지문은 지우고 고른 주소·계정은 남긴다 (다시 켜면 다시 묻는다)', F());
    g.open();
    const r = await p;
    ok(r.on === false && r.messageKind === 'wait' && r.message === '그사이 꺼져 바꾸지 않았습니다.' && !F().to.includes('third@example.org'), '[13] 묻는 사이에 껐으면 «그사이 꺼져» — 주소도 더하지 않는다', M(r));
    const again = await autofwd.setForward({ on: false }, null, { fromSettings: false });
    ok(again.message === '' && again.on === false, '…이미 꺼져 있으면 끄기 요청은 바뀐 것 없음');
  }

  console.log('\n[16] 끝에서 끝까지');
  {
    answer = 0;
    lines.length = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    const s16 = tx.sent.length;
    addMail('a1', 'hello-one');
    addMail('a2', 'hello-two');
    addMail('g1', 'self-account');
    await autofwd.forwardNew({ now: true });
    const s = S();
    const got = sentSubjects().slice(s16);
    ok(got.length === 2 && got.every((x) => /^FW: hello-/.test(x)) && tx.sent.slice(s16).every((x) => JSON.stringify(x.envelope.to) === JSON.stringify([TARGET])),
      '두 계정의 새 메일을 받는 주소로 보냈다 (지메일 계정 메일은 보내지 않는다)', got);
    ok(s.at > 0 && s.sent === 2 && s.total === 2 && s.error === null && s.running === false, '상태 — at·sent·total', { at: s.at, sent: s.sent, total: s.total, error: s.error });
    const last = store.settings.mailForwardLast;
    ok(last && last.sent === 2 && last.total === 2 && last.at === s.at, 'mailForwardLast 가 저장됐다', last);
    ok(lines.some((l) => /자동 전달 · 2통 보냄/.test(l)) && !lines.some((l) => /hello|[^\s•]@[^\s•]/.test(l)), '기록에 «자동 전달 · 2통 보냄» — 제목·주소는 없다', lines);
    usable = (() => { const keep = usable; return () => { usable = keep; return []; }; })();
    await autofwd.forwardNew({ now: true });
    ok(S().error === '지금 쓸 수 있는 전달 계정이 없습니다' && S().total === 2, '쓸 계정이 없으면 «지금 쓸 수 있는 전달 계정이 없습니다»가 상태에 남는다', S().error);
  }

  console.log('\n[18] 폴링 간격');
  {
    const c0 = server.clients.length;
    await autofwd.forwardNew();
    ok(server.clients.length === c0, '방금 돈 뒤 간격(GAP_MS) 안의 두 번째 부르기는 건너뛴다', server.clients.length - c0);
    await autofwd.forwardNew({ now: true });
    ok(server.clients.length > c0 && S().error === null, '…now 면 돈다', server.clients.length - c0);
  }

  console.log('\n[17] 도는 중에 끄면 · 나머지는 이어서');
  {
    for (let i = 0; i < 3; i++) addMail('a1', `slow-${i}`);
    tx.delay = 200;
    const sent0 = tx.sent.length;
    const p = autofwd.forwardNew({ now: true });
    await until(() => tx.sent.length > sent0);
    ok(S().running === true && autofwd.fwdStatus().running === true, '(도는 중 — 상태 running)');
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
    await p;
    tx.delay = 0;
    const n17 = tx.sent.length - sent0;
    ok(n17 >= 1 && n17 < 3 && S().more === true, '도는 중에 끄면 남은 메일은 보내지 않는다', { sent: n17, more: S().more });
    // 다시 켜고 31통 — 30통 뒤 MORE_MS 뒤에 저절로 이어서
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1'] });
    await settle();
    const s1 = tx.sent.length;
    for (let i = 0; i < 31; i++) addMail('a1', `bulk-${i}`);
    await autofwd.forwardNew({ now: true });
    ok(tx.sent.length - s1 === 30 && S().more === true, '31통 → 30통 보내고 «나머지는 다음에»', tx.sent.length - s1);
    ok(await until(() => tx.sent.length - s1 === 31 && !S().running, 4000) && S().more === false, '…폴링을 기다리지 않고 MORE_MS 뒤 저절로 이어서 보낸다', tx.sent.length - s1);
    ok(S().total >= 31, '켠 뒤 보낸 수(total)가 이어진다', S().total);
  }

  console.log('\n[5] 계정 정리');
  {
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    // 서명만 바꾸면 그대로
    lines.length = 0;
    store.updateMailAccount('a1', { signature: '-- 김', smtpHost: 'SMTP.a1.invalid ' });
    ok(JSON.stringify(F().accounts) === '["a1","a2"]' && !lines.some((l) => /자동 전달에서 뺌/.test(l)), '서명만 저장(같은 smtp 값 — 대소문자·공백만 다름)하면 그대로', F().accounts);
    // 보내는 서버를 바꾸면 그 계정은 뺀다
    store.updateMailAccount('a2', { smtpHost: 'smtp.other.invalid' });
    const st5 = S();
    ok(JSON.stringify(F().accounts) === '["a1"]' && F().since.a2 === undefined && !!F().fp.a2 && st5.accounts.find((a) => a.id === 'a2').changed === true
      && lines.some((l) => /자동 전달에서 뺌 — 계정의 서버·주소를 바꿔서/.test(l)), '보내는 서버를 바꾸면 그 계정은 빠지고 changed: true (지문은 남는다)', st5.accounts.map((a) => [a.id, a.on, a.changed]));
    const s0 = tx.sent.length;
    addMail('a2', 'after-change');
    addMail('a1', 'a1-still');
    await autofwd.forwardNew({ now: true });
    ok(JSON.stringify(sentSubjects().slice(s0)) === '["FW: a1-still"]', '…forwardNew 가 그 계정으로는 0통 보낸다', sentSubjects().slice(s0));
    store.updateMailAccount('a2', { smtpHost: 'smtp.a2.invalid' });
    // 아이디를 바꾸면 — 마지막 계정이 빠지면 꺼진다
    store.updateMailAccount('a1', { user: 'a1-new@corp.example' });
    ok(F().on === false && JSON.stringify(F().accounts) === '[]' && JSON.stringify(F().fp) === '{}', '마지막 계정의 아이디를 바꾸면 자동 전달이 꺼진다', F());
    store.updateMailAccount('a1', { user: 'a1@corp.example' });
    // 비밀번호만 다시 넣기는 아무것도 건드리지 않는다
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    const before = fwdKeys();
    store.updateMailAccount('a1', { sealed: { v: 1, data: 'x' } });
    ok(fwdKeys() === before, '{ sealed } 만 바꾸는 요청은 아무것도 건드리지 않는다');
    // 계정을 껐다 켜면 그 계정은 «지금부터» — 꺼 둔 동안 온 메일은 보내지 않는다
    store.updateMailAccount('a1', { enabled: false });
    ok(fwdKeys() === before, '계정을 끄기만 하면 목록은 그대로');
    addMail('a1', 'while-off', { date: new Date(Date.now() - 5000) });
    lines.length = 0;
    const t5 = Date.now();
    store.updateMailAccount('a1', { enabled: true });
    ok(F().since.a1 >= t5 && lines.some((l) => /다시 켠 계정은 지금부터/.test(l)), '다시 켜면 그 계정 since 가 지금으로', F().since.a1 - t5);
    const s1 = tx.sent.length;
    await autofwd.forwardNew({ now: true });
    ok(!sentSubjects().slice(s1).includes('FW: while-off'), '…꺼져 있던 동안 온 메일은 보내지 않는다', sentSubjects().slice(s1));
    // 지우기 — 목록·since·지문에서 빼고, 마지막 계정이 빠지면 끈다
    store.addMailAccount(acct('x1', '임시1', 'x1@corp.example'));
    store.addMailAccount(acct('x2', '임시2', 'x2@corp.example'));
    answer = 0;
    await set({ accounts: ['a1', 'a2', 'x1'] });
    await settle();
    ok(F().accounts.includes('x1') && !!F().fp.x1 && !!F().since.x1, '(x1 을 더했다)', F().accounts);
    store.removeMailAccount('x1');
    ok(JSON.stringify(F().accounts) === '["a1","a2"]' && !F().fp.x1 && F().since.x1 === undefined && F().on === true, 'removeMailAccount — 목록·since·지문에서 뺀다 (남은 계정이 있으면 켜진 채)', F());
    await set({ accounts: ['x2'] });
    await settle();
    lines.length = 0;
    store.removeMailAccount('x2');
    ok(F().on === false && JSON.stringify(F().accounts) === '[]' && lines.some((l) => /전달하던 계정을 모두 지워서/.test(l)), '…마지막 계정을 지우면 끄고 기록한다', F());
  }

  console.log('\n[15] 복사된 설정 — 이 PC에서 확인하지 않은 구성은 보내지 않는다');
  {
    const s0 = tx.sent.length;
    const c0 = server.clients.length;
    store.setForwardSettings({ mailForwardOn: true, mailForwardTo: [TARGET], mailForwardAccounts: ['a1'], mailForwardSince: { a1: Date.now() }, mailForwardFp: {} });
    addMail('a1', 'copied-1');
    await autofwd.forwardNew({ now: true });
    ok(tx.sent.length === s0 && server.clients.length === c0 && S().stale === true && autofwd.isOn() === false && S().on === true,
      '지문 없는 설정 — 0통, 서버에도 붙지 않고, stale·트레이 isOn() 거짓', { stale: S().stale, isOn: autofwd.isOn() });
    store.setForwardSettings({ mailForwardFp: { a1: fpFor('a1', [TARGET], 'other-pc') } });
    await autofwd.forwardNew({ now: true });
    ok(tx.sent.length === s0 && S().stale === true && autofwd.isOn() === false, '다른 PC(other-pc)에서 만든 지문 — 0통, stale', S().accounts.map((a) => [a.id, a.on]));
    // 껐다 켜면 (물음) 이 PC 지문이 적히고 보낸다
    const n = asks.length;
    answer = 0;
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
    await set({ on: true, to: [TARGET], accounts: ['a1'] });
    await settle();
    addMail('a1', 'after-confirm');
    await autofwd.forwardNew({ now: true });
    ok(asks.length === n + 1 && S().stale === false && autofwd.isOn() === true && sentSubjects().slice(s0).includes('FW: after-confirm'), '…껐다 켜면(물음) 보낸다', sentSubjects().slice(s0));
    // 켜진 채 stale 이면 무엇을 바꿔도 묻는다 (지문이 안 맞던 계정은 «새로»)
    store.setForwardSettings({ mailForwardFp: { a1: fpFor('a1', [TARGET], 'other-pc') } });
    answer = 1;
    const r = await set({ to: [TARGET, 'x@example.org'] });
    const q = asks[asks.length - 1];
    ok(asks.length === n + 2 && /회사a1 계정 메일도/.test(q.message) && /x@example\.org/.test(q.message) && r.messageKind === 'wait', '…stale 인 채 바꾸면 지문이 안 맞던 계정도 «새로»로 묻는다', q.message);
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
  }

  console.log('\n[19b] 설정 창이 아닌 요청의 상태');
  {
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1'] });
    await settle();
    const full = autofwd.fwdStatus({ full: true });
    const part = autofwd.fwdStatus({ full: false });
    ok(JSON.stringify(Object.keys(part)) === JSON.stringify(KEYS) && part.to.length === 0 && part.accounts.length === 0 && part.at === 0 && part.sent === 0
      && part.total === 0 && part.error === null && part.message === '' && part.on === full.on && part.ready === full.ready && part.stale === full.stale,
    '키는 같고 to·accounts·숫자·error·message 는 비운다 — on·ready·why·stale·running 은 그대로', part);
    const h = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('mail:fwd-status');
    if (typeof h === 'function') {
      const other = await h({ sender: { id: 'mailview-wc' } });
      const mine = await h({ sender: settingsWc });
      ok(other.to.length === 0 && mine.to.length === 1 && mine.to[0] === TARGET, 'mail:fwd-status 처리기 — 설정 창에만 주소를 준다', { other: other.to, mine: mine.to });
    } else {
      ok(true, '(ipcMain 처리기 표를 볼 수 없어 처리기 직접 부르기는 건너뜀 — [6] 정적 검사로 본다)');
    }
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
  }

  console.log('\n[21] 쓸 수 있는 계정이 없으면 — 이유와 함께 막는다');
  {
    const n = asks.length;
    const ids = store.mailAccounts.map((a) => a.id);
    for (const id of ids) store.updateMailAccount(id, { enabled: false });
    ok(S().ready === false && S().why === '켜 둔 메일 계정이 없습니다.', '계정이 모두 꺼져 있으면 ready false · 까닭 한 줄', { ready: S().ready, why: S().why });
    let r = await set({ on: true, to: [TARGET], accounts: ['a1'] });
    ok(r.messageKind === 'bad' && r.message === '켜 둔 메일 계정이 없습니다.' && asks.length === n && store.settings.mailForwardOn !== true, '…켜기 → «bad», 묻지 않는다', M(r));
    for (const id of ids) store.updateMailAccount(id, { enabled: true });
    store.updateMailAccount('a2', { enabled: false });
    r = await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    ok(r.messageKind === 'bad' && r.message === '회사a2 계정은 꺼져 있어 고를 수 없습니다.' && asks.length === n, '꺼 둔 계정을 골라 켜기 → «bad», 묻지 않는다', M(r));
    answer = 1;
    await set({ on: true, to: [TARGET] });
    ok(asks.length === n + 1 && asks[asks.length - 1].detail.split('\n')[0] === '회사a1 계정', '계정을 안 고르면 꺼 둔 계정은 빠진다', asks[asks.length - 1].detail);
    store.updateMailAccount('a2', { enabled: true });
    // 비밀번호를 못 푸는 계정 — 켜 둔 계정이지만 쓸 수 있는 계정(mailAccountsForUse)에 없다
    const keep = usable;
    usable = () => keep().filter((a) => a.id !== 'a2');
    r = await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    usable = keep;
    ok(r.messageKind === 'bad' && r.message === '회사a2 계정은 지금 쓸 수 없습니다 — 계정 설정을 확인하세요.' && asks.length === n + 1, '비밀번호를 못 푸는 계정 → «bad», 묻지 않는다', M(r));
  }

  console.log('\n[22] 묻는 사이에 바뀐 구성은 저장하지 않는다');
  {
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    // 주소를 더하는 확인 창이 떠 있는 동안 a1 의 보내는 서버가 바뀐다 (mail:update 는 보낸 창을 보지 않는다)
    let g = hold();
    let n = asks.length;
    let p = set({ to: [TARGET, 'second@example.org'] });
    await until(() => asks.length === n + 1);
    store.updateMailAccount('a1', { smtpHost: 'smtp.evil.invalid' });
    g.open();
    let r = await p;
    ok(r.messageKind === 'wait' && r.message === '그사이 설정이 바뀌어 바꾸지 않았습니다 — 다시 눌러주세요.' && JSON.stringify(F().accounts) === '["a2"]'
      && JSON.stringify(F().to) === JSON.stringify([TARGET]) && !S().accounts.find((a) => a.id === 'a1').on,
    '묻는 사이 계정 서버가 바뀌면 «그사이 바뀌어» — 빠진 계정을 되살리지 않고, 바뀐 서버에 지문을 찍지 않는다', { msg: M(r), accounts: F().accounts, to: F().to });
    store.updateMailAccount('a1', { smtpHost: 'smtp.a1.invalid' });
    await set({ accounts: ['a1', 'a2'] });
    await settle();
    ok(JSON.stringify(F().accounts) === '["a1","a2"]', '(a1 을 다시 확인해 넣었다)', F().accounts);
    // 확인 창이 떠 있는 동안 들어온 «빼기만» — 확인 뒤에 되살아나지 않는다
    g = hold();
    n = asks.length;
    p = set({ to: [TARGET, 'second@example.org'] });
    await until(() => asks.length === n + 1);
    const rm = await set({ accounts: ['a1'] });
    ok(rm.message === '바꿨습니다.' && JSON.stringify(F().accounts) === '["a1"]', '(묻는 동안 계정 빼기는 묻지 않고 저장된다)', M(rm));
    g.open();
    r = await p;
    ok(r.messageKind === 'wait' && JSON.stringify(F().accounts) === '["a1"]' && JSON.stringify(F().to) === JSON.stringify([TARGET]),
      '…확인 뒤에도 뺀 계정이 되살아나지 않고 주소도 더하지 않는다', { msg: M(r), accounts: F().accounts, to: F().to });
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
  }

  console.log('\n[23] 상태 줄의 «실패:» 는 진짜 실패만 — 알림이 가리지 않는다');
  {
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1', 'a2'] });
    await settle();
    // a1 은 지난번 보내던 중 앱이 꺼졌다(«확인 안 됨» 알림), a2 는 보내는 서버 로그인이 거절된다
    const st = fstate();
    st.pending = { acc: 'a1', uid: st.acc.a1.lastUid, stage: 'send', n: 0, k: 'f'.repeat(24), at: Date.now() };
    fs.writeFileSync(path.join(STATE_DIR, mailfwd.STATE_FILE), JSON.stringify(st));
    addMail('a2', 'eauth-mail');
    failFor = (env) => (env.from === 'a2@corp.example'
      ? Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, response: '535 5.7.8 rejected' }) : null);
    await autofwd.forwardNew({ now: true });
    failFor = null;
    ok(/회사a2: 보내는 서버 로그인이 거절됐습니다/.test(S().error || '') && S().uncertain === 1,
      '«보내던 중 앱이 꺼져…» 알림이 아니라 a2 의 로그인 거절이 «실패:» 자리에 — «확인 안 됨 1통»은 숫자로', { error: S().error, uncertain: S().uncertain });
    await autofwd.forwardNew({ now: true });
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
  }

  console.log('\n[24] 겹친 방어 — 메일 확인 꺼짐·받는 주소와 같은 계정');
  {
    answer = 0;
    await set({ on: true, to: [TARGET], accounts: ['a1'] });
    await settle();
    // 옛 설정 파일 — 메일 확인은 꺼졌는데 전달은 켜져 있다 (setSettings 를 거치지 않은 값)
    store.settings.mailEnabled = false;
    addMail('a1', 'r1-mail-off');
    const s0 = tx.sent.length;
    const c0 = server.clients.length;
    await autofwd.forwardNew({ now: true });
    ok(tx.sent.length === s0 && server.clients.length === c0 && autofwd.isOn() === false, '메일 확인이 꺼져 있으면 전달이 켜져 있어도 0통·서버에 붙지 않는다', { sent: tx.sent.length - s0, clients: server.clients.length - c0 });
    store.settings.mailEnabled = true;
    await autofwd.forwardNew({ now: true });
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
    // 확인 창이 떠 있는 동안 메일 확인을 끈다 — 확인을 눌러도 켜지지 않는다 (확인 창은 모달이 아니다)
    const g = hold();
    const n = asks.length;
    const p = set({ on: true, to: [TARGET], accounts: ['a1'] });
    await until(() => asks.length === n + 1);
    store.setSettings({ mailEnabled: false });
    g.open();
    const r = await p;
    ok(r.on === false && r.messageKind === 'bad' && store.settings.mailForwardOn !== true, '묻는 사이 메일 확인을 끄면 확인을 눌러도 켜지지 않는다', M(r));
    store.setSettings({ mailEnabled: true });
    // 받는 주소와 같은 계정이 목록에 있다 (손으로 만든 상태) — 그 계정 메일은 자기에게 보내지 않는다
    const to = ['me@gmail.com'];
    store.setForwardSettings({ mailForwardOn: true, mailForwardTo: to, mailForwardAccounts: ['a1', 'g1'],
      mailForwardSince: { a1: Date.now(), g1: Date.now() }, mailForwardFp: { a1: fpFor('a1', to), g1: fpFor('g1', to) } });
    await autofwd.forwardNew({ now: true });
    const s1 = tx.sent.length;
    const mark = server.log.length;
    addMail('g1', 'r3-self-mail');
    addMail('a1', 'r3-a1-mail');
    await autofwd.forwardNew({ now: true });
    const got = sentSubjects().slice(s1);
    ok(!got.includes('FW: r3-self-mail') && got.includes('FW: r3-a1-mail') && !server.log.slice(mark).some((e) => e.acc === 'g1'),
      '받는 주소와 같은 계정(지메일)은 목록에 있어도 서버에 붙지 않고 보내지 않는다', got);
    await autofwd.setForward({ on: false }, null, { fromSettings: false });
  }

  console.log('\n[20] 전달이 도는 동안 서버 정리는 시작하지 않는다');
  {
    const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
    const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
    let tidyCalls = 0;
    mailtidy.tidyAll = async () => {
      tidyCalls += 1;
      return { moved: 0, kept: 0, unsaved: 0, unverified: 0, spared: 0, unread: 0, uncertain: 0, skippedBoxes: [], more: false, errors: [], aborted: false };
    };
    mailbackup.backupAccount = async () => ({ saved: 0, skipped: 0, seeded: 0, missing: 0, mailboxes: 0, stateError: null });
    const bdir = path.join(tmp, 'backup');
    fs.mkdirSync(bdir, { recursive: true });
    let busy = true;
    const backup = require(path.join(ROOT, 'src', 'backup.js'));
    backup.init({
      mailAccountsForUse: () => usable(), isSettingsWin: () => true, forwardBusy: () => busy,
      tidyTiming: { FIRST_MS: 0, GAP_MS: 0, QUICK_GAP_MS: 0, MORE_GAP_MS: 0 }
    });
    store.setSettings({ mailAutoBackup: true, mailEnabled: true });
    store.setGatedSettings({ mailBackupDir: bdir, mailServerTidy: true });
    await backup.autoBackupNew({ now: true });
    ok(tidyCalls === 0, 'forwardBusy 가 참이면 자동 백업 끝의 정리는 tidyAll 을 부르지 않는다', tidyCalls);
    busy = false;
    await backup.autoBackupNew({ now: true });
    ok(tidyCalls === 1, '…거짓이면 부른다', tidyCalls);
    store.setGatedSettings({ mailServerTidy: false });
  }

  ok(server.forbidden().length === 0, '처음부터 끝까지 금지 명령은 한 번도 불리지 않았다');
  ok(server.log.filter((e) => e.cmd === 'mailboxOpen').every((e) => e.readOnly), '…폴더는 늘 읽기 전용으로 열었다');
  ok(allLines.length > 0 && !allLines.some((l) => /[^\s•]@[^\s•]/.test(l)), '처음부터 끝까지 기록에 가려지지 않은 주소가 없다', allLines.filter((l) => /[^\s•]@[^\s•]/.test(l)));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

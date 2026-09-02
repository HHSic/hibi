const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 백업을 딴 파일로 뺀 뒤에도 배선이 그대로인가.
// mailbackup.js 자체는 안 건드렸으니 그 안까지는 안 들어간다 — 여기서는
// «IPC가 등록됐나»와 «autoBackupOne 이 제 인자로 saveOne 을 부르나»만 본다.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkup-'));
app.setPath('appData', tmp);

// main.js 가 backup.js 를 부르기 전에 가로챈다
const mailbackup = require(`${ROOT}/src/mailbackup.js`);
const calls = [];
mailbackup.saveOne = async (acc, dir, m) => { calls.push({ acc: acc && acc.id, dir, uid: m.uid, subject: m.subject, hasSource: !!m.source }); return { saved: true }; };

require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const backup = require(`${ROOT}/src/backup.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;

  const s0 = await wwc.executeJavaScript(`window.nunsseom.mailBackupStatus()`);
  ok(s0 && typeof s0 === 'object' && 'running' in s0, 'mail:backup-status 가 답한다 (IPC 등록됨)', { running: s0.running, dir: s0.dir });

  const dir = path.join(tmp, 'backupdir');
  fs.mkdirSync(dir, { recursive: true });
  store.setSettings({ mailBackupDir: dir, mailAutoBackup: true, mailEnabled: true });
  await sleep(300);
  const s1 = await wwc.executeJavaScript(`window.nunsseom.mailBackupStatus()`);
  ok(s1.dir === dir && s1.auto === true, '폴더·자동 켜짐이 반영된다', { dir: !!s1.dir, auto: s1.auto });

  // 자동 백업이 꺼져 있으면 아무 일도 안 해야 한다
  store.setSettings({ mailAutoBackup: false });
  await backup.autoBackupOne({ id: 'a1' }, { uid: 7, mailbox: 'INBOX', subject: 'x', source: Buffer.from('raw') });
  ok(calls.length === 0, '꺼져 있으면 저장하지 않는다', calls.length);

  store.setSettings({ mailAutoBackup: true, mailEnabled: true });
  await backup.autoBackupOne({ id: 'a1' }, { uid: 7, mailbox: 'INBOX', subject: '시험 메일', source: Buffer.from('raw') });
  ok(calls.length === 1, 'autoBackupOne 이 saveOne 을 부른다', calls.length);
  ok(calls[0] && calls[0].dir === dir && calls[0].uid === 7 && calls[0].hasSource,
    '폴더·uid·원문이 제대로 넘어간다', calls[0]);

  // 원문이 없으면 조용히 건너뛴다 (예전 동작 그대로)
  await backup.autoBackupOne({ id: 'a1' }, { uid: 8, mailbox: 'INBOX', subject: 'y' });
  ok(calls.length === 1, '원문이 없으면 건너뛴다', calls.length);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

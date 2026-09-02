// 메일 백업 — 받은 메일을 내 PC 폴더에 파일로 남긴다.
//
// 서버에서 지워져도 내 손에는 남게 하는 것이 목적이다. 그래서 저장은 «되는 만큼»
// 조용히 해 두고, 실패해도 메일 보기를 막지 않는다.
//
// 바깥에는 «한 통 저장»과 «새로 온 것 저장» 둘만 내준다.
// 나머지(폴더 고르기·전체 저장·진행 상황)는 여기서 IPC로 직접 받는다.

const { app, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const evlog = require('./evlog');
const mail = require('./mail');
const mailbackup = require('./mailbackup');

// 계정 목록은 main.js 가 들고 있다 (비밀번호를 푸는 곳이 거기다).
let host = { mailAccountsForUse: () => [] };
function init(h) { host = { ...host, ...h }; }

// 서버에 있는 메일을 .eml 파일로 내 PC에 내려둔다. 회사를 옮기거나 계정이 닫히면
// 웹메일에 있던 것은 같이 사라진다 — 파일로 남겨두면 그때도 열린다.
// 오래 걸리는 작업이라 상태를 남기고, 설정 화면이 그걸 들여다본다.
const backup = {
  running: false, stop: false,
  account: '', mailbox: '', done: 0, total: 0,
  saved: 0, skipped: 0, message: '', at: 0, dir: null
};

// 자동 백업은 사용자가 보고 있지 않을 때 도는 일이라 수동 진행률과 섞지 않는다.
// 여기 값만 따로 보여준다 — "언제 몇 통을 저장했는가".
const autoBackup = { at: 0, saved: 0, total: 0, error: null, seeded: 0 };

function backupStatus() {
  return {
    ...backup,
    dir: store.settings.mailBackupDir || null,
    auto: store.settings.mailAutoBackup === true,
    autoAt: autoBackup.at,
    autoSaved: autoBackup.saved,
    autoTotal: autoBackup.total,
    autoSeeded: autoBackup.seeded,
    autoError: autoBackup.error
  };
}

// 두 순간에 저장한다.
//  1) 새 메일이 들어왔을 때 — 폴링이 끝나면 새로 생긴 UID만 받아 둔다
//  2) 사용자가 메일을 열었을 때 — 본문을 이미 받아왔으므로 서버를 더 부르지 않는다
//
// 켜자마자 몇 년치를 몰래 받지는 않는다(onlyNew). 지난 메일은 «백업 시작»의 몫이다.
const AUTO_GAP_MS = 2 * 60_000;   // 폴링이 잦아도 이보다 자주 돌지 않는다
let autoRunAt = 0;

/**
 * 자동 백업이 실제로 돌 수 있는 상태인가.
 * 메일 확인이 꺼져 있으면 폴링이 없어 새 메일을 알 방법이 없다 — 화면에도 그대로 알린다.
 */
function autoBackupOn() {
  return store.settings.mailAutoBackup === true
    && !!store.settings.mailBackupDir
    && store.settings.mailEnabled === true;
}

/** 열어본 메일 한 통 — 이미 받아온 원문을 그대로 파일로 남긴다 */
async function autoBackupOne(acc, m) {
  if (!autoBackupOn() || !m || !m.source) return;
  // 전체 백업이 도는 중이면 손대지 않는다. 그쪽은 폴더 목록을 미리 읽어두고 쓰는데
  // 그 사이에 파일을 끼워 넣으면 같은 메일이 두 번 저장된다. 어차피 그쪽이 받아간다.
  if (backup.running || autoBackup.running) return;
  try {
    const r = await mailbackup.saveOne(acc, store.settings.mailBackupDir, {
      mailbox: m.mailbox, uid: m.uid, receivedAt: m.receivedAt,
      subject: m.subject, source: m.source
    });
    if (r.saved) {
      autoBackup.at = Date.now();
      autoBackup.saved = 1;
      autoBackup.total += 1;
      autoBackup.error = null;
      evlog.log('메일', `자동 백업 · 열어본 메일 저장 (uid ${m.uid})`);
    }
  } catch (e) {
    autoBackup.error = e.message;
    evlog.log('메일', `자동 백업 실패 · ${e.message}`);
  }
}

/**
 * 폴링 뒤 — 새로 들어온 것만 받아 둔다.
 * @param now 켜자마자 한 번은 간격을 무시하고 돈다 (그래야 «지금부터»가 진짜 지금이다)
 */
async function autoBackupNew({ now = false } = {}) {
  // 수동 백업이 도는 중이면 비켜준다. 같은 폴더에 둘이 쓰면 서로를 밟는다.
  if (!autoBackupOn() || backup.running || autoBackup.running) return;
  if (!now && Date.now() - autoRunAt < AUTO_GAP_MS) return;
  autoRunAt = Date.now();

  const dir = store.settings.mailBackupDir;
  const accounts = host.mailAccountsForUse();
  if (!accounts.length) return;

  // 폴더를 못 쓰면 10분마다 같은 실패를 반복해봐야 아무것도 안 바뀐다.
  // 한 번 알리고 멈춘다 — 폴더를 다시 고르면 그때 풀린다.
  const bad = backupDirProblem(dir);
  if (bad) {
    if (autoBackup.error !== bad) {
      autoBackup.error = bad;
      evlog.log('메일', `자동 백업 멈춤 · ${bad}`);
    }
    return;
  }

  autoBackup.running = true;
  let saved = 0;
  let seeded = 0;
  const failed = [];
  for (const acc of accounts) {
    // 계정 하나가 넘어져도 나머지는 받는다
    try {
      const r = await mailbackup.backupAccount(acc, dir, { onlyNew: true });
      saved += r.saved;
      seeded += r.seeded;
    } catch (e) {
      failed.push(`${acc.name || acc.user}: ${mail.friendly(e)}`);
    }
  }
  autoBackup.running = false;
  autoBackup.at = Date.now();
  autoBackup.saved = saved;
  autoBackup.total += saved;
  autoBackup.seeded = seeded;
  autoBackup.error = failed.length ? failed[0] : null;
  if (saved || seeded || failed.length) {
    evlog.log('메일', `자동 백업 · 새 메일 ${saved}통 저장`
      + (seeded ? ` · 폴더 ${seeded}곳을 «지금부터»로 표시 (지난 메일은 받지 않음)` : '')
      + (failed.length ? ` · 실패 ${failed.join(' / ')}` : ''));
  }
}

ipcMain.handle('mail:backup-status', () => backupStatus());

ipcMain.handle('mail:backup-pick', async () => {
  // 도는 중에 폴더를 바꾸면 절반은 저쪽, 절반은 이쪽에 남는다
  if (backup.running || autoBackup.running) {
    backup.message = '백업이 도는 중에는 폴더를 바꿀 수 없습니다';
    return backupStatus();
  }
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '메일을 저장할 폴더',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.settings.mailBackupDir || app.getPath('documents')
  });
  if (canceled || !filePaths[0]) return backupStatus();

  // 여기서 못 쓰는 곳인지 바로 확인한다. 나중에 백업을 눌렀을 때 실패하면
  // 원인이 폴더인지 서버인지 알 수 없다. (C:\Users 밑처럼 윈도우가 막는 자리가 있다)
  const bad = backupDirProblem(filePaths[0]);
  if (bad) { backup.message = bad; return backupStatus(); }

  store.setSettings({ mailBackupDir: filePaths[0] });
  backup.message = '';
  return backupStatus();
});

/**
 * 이 폴더에 정말 쓸 수 있나. 실제로 만들어 보고 지운다 —
 * 권한은 존재 여부만으로는 알 수 없다.
 * @returns 문제가 있으면 사람이 읽을 사유, 없으면 null
 */
function backupDirProblem(dir) {
  const probe = path.join(dir, '.hibi-쓰기확인');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    try { fs.unlinkSync(probe); } catch { /* 없으면 그만 */ }
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return `이 폴더에는 쓸 수 없습니다 — 윈도우가 막는 자리입니다 (${dir}).`
        + ' 문서 폴더 안처럼 내 폴더를 고르세요.';
    }
    return `이 폴더를 쓸 수 없습니다 — ${e.message}`;
  }
}

ipcMain.on('mail:backup-stop', () => { backup.stop = true; });
ipcMain.on('mail:backup-open', () => {
  if (store.settings.mailBackupDir) shell.openPath(store.settings.mailBackupDir);
});

ipcMain.handle('mail:backup-start', async () => {
  // 자리를 먼저 잡는다. await 뒤에 검사하면 두 번 빠르게 누른 사이에 둘 다 통과해
  // 같은 폴더에 백업이 두 개 돈다.
  if (backup.running) return backupStatus();
  backup.running = true;
  try {
    // 자동 백업이 돌고 있으면 끝나기를 잠깐 기다린다 — 같은 폴더를 둘이 쓰면 안 된다
    for (let i = 0; i < 60 && autoBackup.running; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (autoBackup.running) throw new Error('자동 백업이 도는 중입니다. 잠시 뒤 다시 눌러주세요');
    if (!store.settings.mailBackupDir) throw new Error('저장할 폴더를 먼저 고르세요');
    // 폴더는 고른 뒤에도 지워지거나 권한이 바뀔 수 있다 — 시작 전에 다시 본다
    const bad = backupDirProblem(store.settings.mailBackupDir);
    if (bad) throw new Error(bad);
    if (!host.mailAccountsForUse().length) throw new Error('쓸 수 있는 계정이 없습니다');
  } catch (e) {
    backup.running = false;
    backup.message = e.message;
    return backupStatus();
  }

  // 도는 동안 폴더가 바뀌어도 시작할 때 고른 곳에 끝까지 쓴다
  const dir = store.settings.mailBackupDir;
  const accounts = host.mailAccountsForUse();

  Object.assign(backup, {
    running: true, stop: false, account: '', mailbox: '',
    done: 0, total: 0, saved: 0, skipped: 0, message: '', at: Date.now()
  });
  evlog.log('메일', `백업 시작 · 계정 ${accounts.length}개 · ${dir}`);

  // 기다리지 않고 바로 상태를 돌려준다 — 몇 시간짜리가 될 수도 있다
  (async () => {
    try {
      // 계정마다 0부터 세므로, 화면에 보이는 숫자는 여기서 합산한다
      let saved = 0;
      let skipped = 0;
      let missing = 0;
      const failed = [];
      for (const acc of accounts) {
        if (backup.stop) break;
        backup.account = acc.name || acc.user;
        // 한 계정이 넘어져도 나머지는 받아야 한다. 여기서 통째로 중단하면
        // 비밀번호가 만료된 계정 하나 때문에 나머지 계정은 영영 백업되지 않는다.
        try {
          const r = await mailbackup.backupAccount(acc, dir, {
            onProgress: (p) => Object.assign(backup, p,
              { saved: saved + p.saved, skipped: skipped + p.skipped }),
            shouldStop: () => backup.stop
          });
          saved += r.saved;
          skipped += r.skipped;
          missing += r.missing;
          if (r.stateError) failed.push(`${backup.account}: 진행 기록 저장 실패 (${r.stateError})`);
        } catch (e) {
          failed.push(`${backup.account}: ${mail.friendly(e)}`);
          evlog.log('메일', `백업 실패 · ${backup.account} · ${mail.friendly(e)}`);
        }
        backup.saved = saved;
        backup.skipped = skipped;
      }
      backup.message = (backup.stop ? `멈췄습니다 — ${saved}통 저장` : `끝났습니다 — ${saved}통 저장`)
        + (missing ? ` · ${missing}통은 서버가 원문을 주지 않았습니다` : '')
        + (failed.length ? ` · 실패 ${failed.length}건: ${failed[0]}` : '');
      evlog.log('메일', `백업 ${backup.stop ? '중단' : '완료'} · ${saved}통`
        + (failed.length ? ` · 실패 ${failed.join(' / ')}` : ''));
    } catch (e) {
      backup.message = mail.friendly(e);
      evlog.log('메일', `백업 실패 · ${backup.message}`);
    } finally {
      backup.running = false;
      backup.mailbox = '';
    }
  })();

  return backupStatus();
});

module.exports = { init, autoBackupOne, autoBackupNew };

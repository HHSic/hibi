// 이벤트 기록 — 기본은 끔, 예전 기본값(켜짐)으로 저장된 설정은 한 번 끈다.
//
// 창 크기/이동 문제를 쫓던 동안 기본 켜짐이었다. 다 잡은 뒤에도 클릭·창 이동이 계속 파일에 쌓였다.
//   · 새로 설치 → 꺼짐
//   · 예전 버전(layoutVersion 3)이 켜짐으로 저장해 둔 것 → 꺼짐, 파일에도 꺼짐·버전 4로 남는다
//   · 그 뒤 사용자가 트레이에서 다시 켠 것(layoutVersion 4) → 켜진 채 둔다
// store.js 는 한 프로세스에서 설정을 한 번만 읽으므로, 경우마다 이 파일을 자식 Electron 으로 다시 띄운다.
// 창은 하나도 띄우지 않는다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 90_000).unref();

const ROOT = path.join(__dirname, '..');

// ── 자식: 주어진 데이터 폴더로 store 를 읽고 결과만 찍는다
if (process.env.EVLOG_DIR) {
  const dir = process.env.EVLOG_DIR;
  app.setPath('appData', dir);
  app.setPath('userData', path.join(dir, 'Hibi'));
  app.whenReady().then(() => {
    const store = require(path.join(ROOT, 'src', 'store.js'));
    const on = store.settings.eventLog;
    let disk = null;
    try { disk = JSON.parse(fs.readFileSync(path.join(dir, 'Hibi', 'nunsseom.json'), 'utf8')); } catch { /* 새로 설치면 아직 없을 수 있다 */ }
    console.log('RESULT ' + JSON.stringify({
      on,
      diskOn: disk && disk.settings ? disk.settings.eventLog : null,
      diskVersion: disk ? disk.layoutVersion : null
    }));
    app.exit(0);
  });
} else {
  let bad = 0;
  const ok = (c, m, x) => {
    console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
    if (!c) bad++;
  };

  /** 데이터 폴더를 만들고(설정 파일이 있으면 써 두고) 자식으로 읽어 본다 */
  const run = (saved) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlogoff-'));
    fs.mkdirSync(path.join(dir, 'Hibi'), { recursive: true });
    if (saved) fs.writeFileSync(path.join(dir, 'Hibi', 'nunsseom.json'), JSON.stringify(saved));
    // ELECTRON_RUN_AS_NODE 는 빈 값이어도 «노드로 돌아라»로 읽힌다 — 아예 뺀다
    const env = { ...process.env, EVLOG_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(process.execPath, [__filename], {
      env,
      encoding: 'utf8',
      timeout: 60_000
    });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시 폴더 */ }
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    if (!line) {
      console.error(r.stdout, r.stderr);
      return null;
    }
    return JSON.parse(line.slice('RESULT '.length));
  };

  app.whenReady().then(() => {
    console.log('\n[이벤트 기록 기본값]');
    const fresh = run(null);
    ok(!!fresh && fresh.on === false, '새로 설치하면 꺼져 있다', fresh);

    const old = run({ settings: { eventLog: true, overlayEnter: 'cat' }, layoutVersion: 3 });
    ok(!!old && old.on === false, '예전 버전이 켜짐으로 저장해 둔 것은 한 번 끈다', old);
    ok(!!old && old.diskOn === false && old.diskVersion === 4, '…설정 파일에도 꺼짐·버전 4로 남는다 (다음에 다시 끄지 않게)', old);

    const again = run({ settings: { eventLog: true }, layoutVersion: 4 });
    ok(!!again && again.on === true, '그 뒤 트레이에서 다시 켠 것은 켜진 채 둔다', again);

    console.log('\n[트레이 메뉴]');
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    ok(/label: '이벤트 기록',/.test(main) && !/문제 재현용/.test(main), "트레이 메뉴 이름은 «이벤트 기록» (괄호 설명 없음)");

    console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
    app.exit(bad ? 1 : 0);
  });
}

// Windows 로그인 시 자동 실행.
//
// app.setLoginItemSettings 를 쓰지 않는 이유:
// 그 API는 HKCU\...\Run 에 경로를 **따옴표 없이** 기록한다. 설치 경로에 공백이 있으면
// (예: C:\Program Files\nunsseom\눈쉼.exe) 값이 모호해지고, Electron 자신도 이를
// path="C:\Program", args=["Files\nunsseom\눈쉼.exe"] 로 잘못 파싱한다. 실측 확인함.
//
// 대신 시작 폴더에 바로가기(.lnk)를 만든다.
//   · 따옴표 문제가 없다 (경로가 링크 안에 구조적으로 담긴다)
//   · 상태 확인이 파일 존재 여부라 확실하다 (중복 상태를 따로 저장할 필요가 없다)
//   · 작업 관리자 '시작 앱' 목록에서 사용자가 직접 켜고 끌 수 있다
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

function linkPath() {
  return path.join(
    app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    `${app.getName()}.lnk`
  );
}

/** 지금 자동 실행이 켜져 있는가 — OS 상태가 곧 진실이다 */
function isEnabled() {
  if (process.platform !== 'win32') return false;
  try {
    return fs.existsSync(linkPath());
  } catch {
    return false;
  }
}

/**
 * 예전 방식(Run 레지스트리)으로 등록된 항목을 지운다 — 중복 실행 방지.
 *
 * getLoginItemSettings().openAtLogin 으로 먼저 확인하지 않는다:
 * 그 판정은 기록된 경로와 process.execPath 를 비교하는데, 예전 항목은 따옴표가 없어
 * Electron이 경로를 'C:\Program' 으로 잘못 잘라 읽는다. 그래서 항목이 남아 있어도
 * 항상 false가 나와 지울 기회를 놓친다. 이름으로 지우는 동작이므로 조건 없이 호출한다.
 */
function clearLegacyRunEntry() {
  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch {
    /* 지우지 못해도 치명적이지는 않다 */
  }
}

/**
 * 켜거나 끈 뒤 **실제** 상태를 돌려준다.
 * 실패를 조용히 넘기지 않기 위해 항상 다시 읽어서 확인한다.
 */
function setEnabled(on) {
  if (process.platform !== 'win32') return false;
  const p = linkPath();
  try {
    if (on) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      shell.writeShortcutLink(p, 'create', {
        target: process.execPath,
        cwd: path.dirname(process.execPath),
        description: '눈쉼 — 휴식 리마인더'
      });
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (e) {
    console.warn('[autolaunch] 변경 실패:', e.message);
  }
  clearLegacyRunEntry();
  return isEnabled();
}

/**
 * 예전 버전에서 설정값으로만 켜 두었던 경우를 실제 바로가기로 옮긴다.
 * @param {boolean} storedIntent 저장돼 있던 autoLaunch 값
 */
function migrate(storedIntent) {
  if (process.platform !== 'win32') return false;
  if (storedIntent && !isEnabled()) return setEnabled(true);
  clearLegacyRunEntry();
  return isEnabled();
}

module.exports = { isEnabled, setEnabled, migrate, linkPath };

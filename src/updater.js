// 자동 업데이트 — GitHub Releases에서 새 버전을 받아 설치한다.
//
// electron-builder가 릴리스에 올린 latest.yml을 보고 판단한다.
// 개발 중(패키징 전)에는 동작하지 않으므로 조용히 비활성화한다.

const { app } = require('electron');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6시간마다
const FIRST_CHECK_DELAY_MS = 20 * 1000;

let autoUpdater = null;
let timer = null;
let onStatus = () => {};

/** 현재 상태 — 설정 창이 그대로 보여준다 */
const state = {
  version: app.getVersion(),
  status: 'idle',      // idle | checking | available | downloading | ready | none | error | unsupported
  message: '',
  progress: 0,
  newVersion: null
};

function setState(patch) {
  Object.assign(state, patch);
  try { onStatus({ ...state }); } catch {}
}

function init({ onUpdate } = {}) {
  if (onUpdate) onStatus = onUpdate;

  if (!app.isPackaged) {
    setState({ status: 'unsupported', message: '개발 모드에서는 업데이트를 확인하지 않습니다' });
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    setState({ status: 'unsupported', message: '업데이터를 불러오지 못했습니다' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', message: '확인 중…' }));
  autoUpdater.on('update-available', (info) => setState({
    status: 'downloading', newVersion: info.version, progress: 0,
    message: `새 버전 ${info.version} 내려받는 중…`
  }));
  autoUpdater.on('update-not-available', () => setState({
    status: 'none', message: '최신 버전입니다', progress: 0
  }));
  autoUpdater.on('download-progress', (p) => setState({
    status: 'downloading', progress: Math.round(p.percent || 0),
    message: `내려받는 중 ${Math.round(p.percent || 0)}%`
  }));
  autoUpdater.on('update-downloaded', (info) => setState({
    status: 'ready', newVersion: info.version, progress: 100,
    message: `${info.version} 준비됨 — 다시 시작하면 적용됩니다`
  }));
  autoUpdater.on('error', (err) => setState({
    status: 'error', message: `확인 실패: ${String(err && err.message || err).slice(0, 120)}`
  }));
}

/** 배포처가 설정돼 있지 않으면 electron-updater가 에러를 던지므로 감싸서 호출한다 */
async function check({ silent = false } = {}) {
  if (!autoUpdater) {
    if (!silent) setState({ status: state.status === 'unsupported' ? 'unsupported' : 'error' });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    setState({ status: 'error', message: `확인 실패: ${String(e.message || e).slice(0, 120)}` });
  }
}

function startAuto(enabled) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!enabled || !autoUpdater) return;
  setTimeout(() => check({ silent: true }), FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => check({ silent: true }), CHECK_INTERVAL_MS);
}

/** 내려받아 둔 업데이트를 지금 설치 */
function installNow() {
  if (autoUpdater && state.status === 'ready') {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = { init, check, startAuto, installNow, getState: () => ({ ...state }) };

// 방해 금지 감지 — 지금 알림을 띄우면 안 되는 상황인지 판단한다.
//
// 두 가지를 본다.
//   1) Windows가 알려주는 알림 수신 상태 (SHQueryUserNotificationState)
//      전체화면 앱, D3D 전체화면(게임), 발표 모드, 집중 지원(방해 금지)을 한 번에 알려준다.
//      Windows 자신이 토스트를 띄울지 판단할 때 쓰는 API라 가장 신뢰할 만하다.
//   2) 사용자가 지정한 앱이 맨 앞에 있는지 (예: Zoom, PowerPoint)

const QUNS = {
  1: 'not-present',              // 화면 잠김 등
  2: 'busy',                     // 전체화면 앱 실행 중
  3: 'fullscreen-game',          // D3D 전체화면
  4: 'presentation',             // 발표 모드
  5: 'accepts',                  // 평상시 — 알림 OK
  6: 'quiet-time',               // 설치 직후 조용한 시간
  7: 'fullscreen-app'            // 전체화면 스토어 앱
};

// 'accepts'와 'quiet-time'을 뺀 나머지는 방해하지 않는다.
const BLOCKING = new Set(['not-present', 'busy', 'fullscreen-game', 'presentation', 'fullscreen-app']);

const LABEL = {
  'not-present': '화면 잠김',
  busy: '전체화면 앱',
  'fullscreen-game': '전체화면 게임',
  presentation: '발표 모드',
  'fullscreen-app': '전체화면 앱',
  app: '지정한 앱'
};

let api = null;
let failed = false;

function load() {
  if (api || failed) return api;
  if (process.platform !== 'win32') { failed = true; return null; }
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    api = {
      koffi,
      queryState: shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *pquns)'),
      getForegroundWindow: user32.func('size_t __stdcall GetForegroundWindow()'),
      getWindowThreadProcessId: user32.func(
        'uint32 __stdcall GetWindowThreadProcessId(size_t hWnd, _Out_ uint32 *lpdwProcessId)'),
      openProcess: kernel32.func('size_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      closeHandle: kernel32.func('bool __stdcall CloseHandle(size_t h)'),
      queryImageName: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(size_t h, uint32 flags, _Out_ char16_t *buf, _Inout_ uint32 *size)')
    };
  } catch (e) {
    console.warn('[dnd] native detection unavailable:', e.message);
    failed = true;
  }
  return api;
}

/** Windows가 보고하는 알림 수신 상태 */
function notificationState() {
  const a = load();
  if (!a) return 'accepts';
  try {
    const out = [0];
    if (a.queryState(out) !== 0) return 'accepts'; // S_OK가 아니면 판단 포기
    return QUNS[out[0]] || 'accepts';
  } catch {
    return 'accepts';
  }
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** 맨 앞 창의 실행 파일 이름 (소문자, 예: 'zoom.exe') */
function foregroundProcessName() {
  const a = load();
  if (!a) return null;
  let handle = 0;
  try {
    const hwnd = a.getForegroundWindow();
    if (!hwnd) return null;
    const pidOut = [0];
    a.getWindowThreadProcessId(hwnd, pidOut);
    if (!pidOut[0]) return null;

    handle = a.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pidOut[0]);
    if (!handle) return null;

    const buf = Buffer.alloc(1024 * 2); // UTF-16
    const sizeOut = [1024];
    if (!a.queryImageName(handle, 0, buf, sizeOut)) return null;
    const full = buf.toString('utf16le', 0, sizeOut[0] * 2);
    return full.split('\\').pop().toLowerCase();
  } catch {
    return null;
  } finally {
    if (handle) { try { a.closeHandle(handle); } catch {} }
  }
}

/**
 * 지금 방해하면 안 되는 상황인가?
 * @param {{enabled:boolean, apps:string[]}} cfg
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function check(cfg) {
  if (!cfg || !cfg.enabled) return { blocked: false, reason: null };

  const state = notificationState();
  if (BLOCKING.has(state)) return { blocked: true, reason: LABEL[state] };

  const apps = (cfg.apps || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (apps.length) {
    const fg = foregroundProcessName();
    if (fg && apps.some((a) => fg === a || fg === `${a}.exe` || fg.includes(a))) {
      return { blocked: true, reason: LABEL.app };
    }
  }
  return { blocked: false, reason: null };
}

module.exports = { check, notificationState, foregroundProcessName };

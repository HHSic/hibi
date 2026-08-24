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

// 자주 쓰이는 앱은 실행 파일 이름을 미리 담아 토글로 켜게 한다.
// 직접 입력하면 이름을 틀려도 조용히 넘어가므로(예: 'teams' → 실제는 ms-teams.exe)
// 검증된 이름을 목록으로 제공하는 편이 안전하다.
const PRESETS = [
  { id: 'zoom', name: 'Zoom', procs: ['zoom.exe'] },
  { id: 'teams', name: 'Microsoft Teams', procs: ['ms-teams.exe', 'teams.exe'] },
  { id: 'webex', name: 'Webex', procs: ['webex.exe', 'ciscocollabhost.exe', 'webexmta.exe'] },
  { id: 'slack', name: 'Slack', procs: ['slack.exe'] },
  { id: 'discord', name: 'Discord', procs: ['discord.exe'] },
  { id: 'powerpoint', name: 'PowerPoint', procs: ['powerpnt.exe'] },
  { id: 'obs', name: 'OBS Studio', procs: ['obs64.exe', 'obs32.exe'] },
  { id: 'teamviewer', name: 'TeamViewer', procs: ['teamviewer.exe'] },
  { id: 'anydesk', name: 'AnyDesk', procs: ['anydesk.exe'] },
  // 영상은 실행 파일로 가릴 수 없다 — 브라우저로 보면 전부 chrome.exe다.
  // 그걸 막으면 업무 중에도 다 막힌다. 그래서 창 제목으로 가른다.
  // (전체화면으로 보면 Windows가 이미 «전체화면»이라고 알려주므로 그때는 이게 없어도 된다)
  { id: 'youtube', name: 'YouTube', procs: [], titles: ['youtube'] },
  { id: 'netflix', name: 'Netflix', procs: [], titles: ['netflix'] },
  { id: 'tving', name: '티빙 · 웨이브 · 쿠팡플레이', procs: [],
    titles: ['tving', '티빙', 'wavve', '웨이브', '쿠팡플레이', 'coupang play'] },
  { id: 'twitch', name: 'Twitch · 치지직', procs: [], titles: ['twitch', '치지직', 'chzzk'] }
];

/** 짧은 말로 부분 일치를 허용하면 오탐이 나므로 최소 길이를 둔다 */
const MIN_FUZZY = 3;

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
/** 실행 파일 이름 → 프리셋 id (구버전 설정 이전용) */
const PRESET_BY_PROC = new Map();
for (const p of PRESETS) {
  for (const proc of p.procs || []) {
    PRESET_BY_PROC.set(proc, p.id);
    PRESET_BY_PROC.set(proc.replace(/\.exe$/, ''), p.id);
  }
}

/**
 * 프리셋 id와 직접 입력한 것을 실행 파일 이름 목록으로 합친다.
 *
 * 직접 입력한 것 중 «.exe»로 끝나지 않는 말은 창 제목으로 본다(resolveTitles).
 * 실행 파일과 제목은 성격이 달라서다 — 실행 파일은 이름이 맞아떨어져야 하고,
 * 제목은 그 말이 들어 있기만 하면 된다.
 */
function resolveApps({ presets = [], apps = [] } = {}) {
  const out = new Set();
  for (const id of presets) {
    const p = PRESET_BY_ID.get(id);
    if (p) for (const proc of p.procs || []) out.add(proc.toLowerCase());
  }
  for (const a of apps) {
    const s = String(a || '').trim().toLowerCase();
    if (s && s.endsWith('.exe')) out.add(s);
  }
  return [...out];
}

/** 창 제목에서 찾을 말들 */
function resolveTitles({ presets = [], apps = [] } = {}) {
  const out = new Set();
  for (const id of presets) {
    const p = PRESET_BY_ID.get(id);
    if (p) for (const t of p.titles || []) out.add(t.toLowerCase());
  }
  for (const a of apps) {
    const s = String(a || '').trim().toLowerCase();
    // «.exe»가 아니면 제목에서 찾는다. 너무 짧은 말은 아무 데나 걸려서 뺀다.
    if (s && !s.endsWith('.exe') && s.length >= MIN_FUZZY) out.add(s);
  }
  return [...out];
}

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
      // 창 제목 — 브라우저로 보는 것은 실행 파일이 다 chrome.exe라 이름으론 못 가른다.
      // «유튜브 보는 중»과 «업무 중»을 나누는 단서는 제목에만 있다.
      getWindowTextW: user32.func(
        'int __stdcall GetWindowTextW(size_t hWnd, _Out_ char16_t *buf, int max)'),
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

/** 맨 앞 창의 제목 (소문자). 못 읽으면 빈 글자 */
function foregroundTitle() {
  const a = load();
  if (!a) return '';
  try {
    const hwnd = a.getForegroundWindow();
    if (!hwnd) return '';
    const buf = Buffer.alloc(512 * 2);   // UTF-16, 제목은 이보다 길 일이 없다
    const n = a.getWindowTextW(hwnd, buf, 512);
    if (!n || n <= 0) return '';
    return buf.toString('utf16le', 0, n * 2).toLowerCase();
  } catch {
    return '';
  }
}

function matchesApp(fg, name) {
  if (!fg || !name) return false;
  if (fg === name || fg === `${name}.exe`) return true;
  return name.length >= MIN_FUZZY && fg.includes(name);
}

/**
 * 지금 방해하면 안 되는 상황인가?
 * @param {{enabled:boolean, presets?:string[], apps?:string[]}} cfg
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function check(cfg) {
  if (!cfg || !cfg.enabled) return { blocked: false, reason: null };

  const state = notificationState();
  if (BLOCKING.has(state)) return { blocked: true, reason: LABEL[state] };

  const names = resolveApps(cfg);
  if (names.length) {
    const fg = foregroundProcessName();
    if (fg) {
      // 어떤 앱 때문인지 이름으로 알려준다
      for (const p of PRESETS) {
        if (!(cfg.presets || []).includes(p.id)) continue;
        if ((p.procs || []).some((proc) => matchesApp(fg, proc.toLowerCase()))) {
          return { blocked: true, reason: p.name };
        }
      }
      if (names.some((n) => matchesApp(fg, n))) {
        return { blocked: true, reason: fg.replace(/\.exe$/, '') };
      }
    }
  }

  // 창 제목으로 가르는 것들 — 브라우저로 보는 영상이 여기 걸린다.
  // 실행 파일을 다 읽은 뒤에 본다: 앱 이름으로 아는 편이 사유가 더 분명하기 때문이다.
  const titles = resolveTitles(cfg);
  if (titles.length) {
    const title = foregroundTitle();
    if (title) {
      for (const p of PRESETS) {
        if (!(cfg.presets || []).includes(p.id)) continue;
        if ((p.titles || []).some((t) => title.includes(t.toLowerCase()))) {
          return { blocked: true, reason: p.name };
        }
      }
      const hit = titles.find((t) => title.includes(t));
      if (hit) return { blocked: true, reason: hit };
    }
  }
  return { blocked: false, reason: null };
}

module.exports = {
  check, notificationState, foregroundProcessName, foregroundTitle,
  PRESETS, PRESET_BY_PROC, resolveApps, resolveTitles
};

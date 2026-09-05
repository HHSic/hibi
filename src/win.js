// 창을 만들 때 여러 곳이 같이 쓰는 것들.
//
// 창마다 파일을 나누면 이 조각들 때문에 서로를 부르게 되고, 그러면 순환 참조가 생긴다.
// 아무에게도 안 기대는 것만 여기 모아 두면 어느 창 모듈에서든 마음 놓고 가져다 쓸 수 있다.
// (여기서 store·glass 말고 다른 우리 모듈을 부르기 시작하면 그 이점이 사라진다.)

const path = require('path');
const { screen, nativeTheme, shell } = require('electron');
const store = require('./store');
const glass = require('./glass');

const PRELOAD = path.join(__dirname, 'preload.js');
const page = (name) => path.join(__dirname, '..', 'renderer', name);

// 창 크기 = 카드 크기 + 그림자 여백(INSET*2) + 호버 컨트롤 띠(CONTROLS).
const PAD = glass.INSET * 2;
const PAD_H = PAD + glass.CONTROLS;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 화면이 창을 그릴 때 필요한 것 — 테마·유리 진하기·여백을 주소에 실어 보낸다 */
function glassQuery(extra) {
  return {
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    scrim: String(store.settings.scrim),
    inset: String(glass.INSET),
    ctlh: String(glass.CONTROLS),
    ...extra
  };
}

/**
 * 바깥 주소를 기본 브라우저로 넘긴다 — http/https 만.
 *
 * shell.openExternal 은 «주소»가 아니라 «윈도우에게 이걸 열어라»는 명령에 가깝다.
 * file: 이면 프로그램이 실행되고, \\서버\공유 면 붙는 순간 내 계정 이름과 암호 해시가
 * 그 서버로 간다. ms-msdt: 같은 프로토콜 처리기도 다 살아 있다.
 * 그래서 주소는 «어디서 왔든» 여기를 지나야 한다 — 메일 본문이든, 캘린더 파일이든,
 * 화면 쪽이 IPC 로 보내온 것이든 전부 남이 정할 수 있는 값이다.
 *
 * @returns {boolean} 실제로 열었나
 */
function openWeb(url) {
  const t = String(url || '').trim();
  if (!/^https?:\/\//i.test(t)) return false;
  // 스킴은 맞는데 호스트가 없는 것(http:///…)은 거른다
  try { if (!new URL(t).host) return false; } catch { return false; }
  shell.openExternal(t);
  return true;
}

/**
 * 우리 페이지 밖으로 못 나가게 막는다.
 * 메일 본문의 링크를 창 안에서 열면 그 순간 이 창이 브라우저가 된다 —
 * 주소창도 뒤로가기도 없는 브라우저. 바깥 주소는 기본 브라우저에 넘긴다.
 */
function lockToOurPage(win) {
  const ours = (url) => url.startsWith('file://');
  win.webContents.on('will-navigate', (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    openWeb(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openWeb(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

/**
 * 얼마나 크게 늘릴 수 있나. 고정 숫자로 막으면 큰 화면에서 답답하다 —
 * 그 창이 놓인 모니터의 작업 영역에 맞춘다.
 */
function maxSize(win) {
  try {
    const d = win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay();
    return { width: d.workAreaSize.width + PAD, height: d.workAreaSize.height + PAD };
  } catch {
    return { width: 2400, height: 1600 };
  }
}

/**
 * 새 창을 어디에 놓을까 — 정확히 같은 자리에 겹쳐 띄우면 둘이 하나처럼 보인다.
 * 기준 창을 주면 그 옆으로 조금씩 비껴 놓는다 (윈도우 기본 동작과 같은 모양).
 */
function cascadeFrom(width, height, from) {
  if (!from || from.isDestroyed()) return {};
  const b = from.getBounds();
  const step = 28;
  let x = b.x + step;
  let y = b.y + step;
  try {
    const area = screen.getDisplayMatching(b).workArea;
    // 화면 밖으로 나가면 다시 왼쪽 위로 돌아온다
    if (x + width > area.x + area.width || y + height > area.y + area.height) {
      x = area.x + step;
      y = area.y + step;
    }
  } catch { /* 모니터를 못 읽으면 그냥 비껴만 */ }
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = {
  PRELOAD, page, PAD, PAD_H, clamp,
  glassQuery, lockToOurPage, openWeb, maxSize, cascadeFrom
};

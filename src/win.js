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
 * 우리 페이지 밖으로 못 나가게 막는다.
 * 메일 본문의 링크를 창 안에서 열면 그 순간 이 창이 브라우저가 된다 —
 * 주소창도 뒤로가기도 없는 브라우저. 바깥 주소는 기본 브라우저에 넘긴다.
 */
function lockToOurPage(win) {
  const ours = (url) => url.startsWith('file://');
  win.webContents.on('will-navigate', (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
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
  glassQuery, lockToOurPage, maxSize, cascadeFrom
};

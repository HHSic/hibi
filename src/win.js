// 창을 만들 때 여러 곳이 같이 쓰는 것들.
//
// 창마다 파일을 나누면 이 조각들 때문에 서로를 부르게 되고, 그러면 순환 참조가 생긴다.
// 아무에게도 안 기대는 것만 여기 모아 두면 어느 창 모듈에서든 마음 놓고 가져다 쓸 수 있다.
// (여기서 store·glass 말고 다른 우리 모듈을 부르기 시작하면 그 이점이 사라진다.)

const path = require('path');
const { pathToFileURL } = require('url');
const { screen, nativeTheme, shell, BrowserWindow } = require('electron');
const store = require('./store');
const glass = require('./glass');

const PRELOAD = path.join(__dirname, 'preload.js');
const page = (name) => path.join(__dirname, '..', 'renderer', name);

// 창 크기 = 카드 크기 + 그림자 여백(INSET*2) + 호버 컨트롤 띠(CONTROLS).
const PAD = glass.INSET * 2;
const PAD_H = PAD + glass.CONTROLS;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 유리 진하기(scrim) — 저장값(슬라이더 40~98%)은 그대로 두고, 창에 «실제로 칠할 값»만 여기서 정한다.
// 이 계산은 여기 한 곳에만 둔다. 창마다 따로 +0.04 를 하던 때는 서로 어긋났다.
//   · 라이트는 0.90 아래로 안 내린다. 유리가 옅으면 흰 유리 너머로 어두운 배경화면이 비쳐
//     회색 글자가 묻힌다(«하얀 모드 글자가 안 읽힌다»). 0.90이면 #111 배경 위에서도 글자 토큰이 4.5:1을 넘는다.
//   · 다크는 예전과 똑같다 (0.40~0.98).
//   · 글이 빽빽한 창(설정·주식)은 0.04 더 진하게, 단 0.96까지.
const SCRIM = { min: 0.40, max: 0.98, lightFloor: 0.90, dense: 0.04, denseMax: 0.96, fallback: 0.92 };

/** 칠할 유리 알파. raw = 저장값(0~1), dark = 다크 테마인가, dense = 빽빽한 창인가 */
function effScrim(raw, dark, dense) {
  // null·빈 글자를 Number 로 읽으면 0 이 되어 가장 옅은 유리가 된다 — 숫자가 아니면 기본값으로
  const s = typeof raw === 'number' ? raw : parseFloat(raw);
  let a = Number.isFinite(s) ? s : SCRIM.fallback;
  a = clamp(a, dark ? SCRIM.min : SCRIM.lightFloor, SCRIM.max);
  if (dense) a = Math.min(SCRIM.denseMax, a + SCRIM.dense);
  // 0.92+0.04 가 0.9600000000000001 로 주소에 실리지 않게
  return Math.round(a * 1000) / 1000;
}

/** 지금 테마와 칠할 유리 진하기 — 창을 열 때(주소)와 바뀔 때(방송)가 같은 값을 쓴다 */
function glassState(raw = store.settings.scrim) {
  const dark = nativeTheme.shouldUseDarkColors;
  return { theme: dark ? 'dark' : 'light', scrim: effScrim(raw, dark, false), scrimDense: effScrim(raw, dark, true) };
}

/**
 * 화면이 창을 그릴 때 필요한 것 — 테마·유리 진하기·여백을 주소에 실어 보낸다.
 * scrim 은 저장값이 아니라 칠할 값이다. 빽빽한 창은 extra 에 dense: '1' 을 주면 진한 쪽을 받고,
 * 화면(renderer/theme.js)도 그 표시를 보고 이후 방송에서 같은 쪽을 고른다.
 */
function glassQuery(extra = {}) {
  const g = glassState();
  return {
    theme: g.theme,
    scrim: String(extra.dense === '1' ? g.scrimDense : g.scrim),
    inset: String(glass.INSET),
    ctlh: String(glass.CONTROLS),
    ...extra
  };
}

/**
 * 열린 창 전부에 테마·유리 진하기를 다시 알린다 — 윈도우 테마가 바뀌었을 때, 슬라이더를
 * 저장했거나 끄는 중(미리보기)일 때. raw 를 안 주면 저장값으로.
 * 누가 듣는지 가리지 않는다. 안 듣는 창(휴식 화면 등)은 그냥 흘려보낸다.
 */
function broadcastGlass(raw) {
  const g = glassState(raw);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('glass', g);
  }
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

// 우리 화면 파일이 놓인 곳. 여기 아래가 아니면 «우리 페이지»가 아니다.
const OURS = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href.toLowerCase();

/**
 * 이 주소가 «우리 화면 파일»인가.
 *
 * file:// 로 시작하면 우리 것이라고 보면 안 된다. 메일 본문에 이런 링크가 있으면
 *   <a href="//남의서버/공유/x.html">
 * 브라우저가 우리 페이지를 기준으로 풀어서 file://남의서버/공유/x.html 이 된다 (실측).
 * 그걸 통과시키면 이 창이 남의 페이지가 되는데, 이 창에는 preload 다리가 붙어 있다 —
 * 즉 남의 글이 메일 보내기와 첨부를 쥔다. 윈도우 공유에 붙는 순간 계정 해시도 나간다.
 * 그래서 «우리 renderer 폴더 아래»인지까지 본다.
 */
function isOurPage(url) {
  const t = String(url || '');
  if (!/^file:\/\//i.test(t)) return false;
  let href;
  try { href = new URL(t).href.toLowerCase(); } catch { return false; }
  // file://호스트/... 처럼 호스트가 붙은 것은 남의 공유다
  try { if (new URL(t).host) return false; } catch { return false; }
  return href.startsWith(OURS);
}

/**
 * 우리 페이지 밖으로 못 나가게 막는다.
 * 메일 본문의 링크를 창 안에서 열면 그 순간 이 창이 브라우저가 된다 —
 * 주소창도 뒤로가기도 없는 브라우저. 바깥 주소는 기본 브라우저에 넘긴다.
 */
function lockToOurPage(win) {
  const ours = isOurPage;
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
  SCRIM, effScrim, glassState, glassQuery, broadcastGlass,
  lockToOurPage, openWeb, isOurPage, maxSize, cascadeFrom
};

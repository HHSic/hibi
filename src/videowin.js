'use strict';
/**
 * 메일 속 영상을 앱 안에서 튼다 — YouTube 퍼가기(embed) 플레이어 창 하나.
 *
 * 메일 보기 창 안에서 틀지 않는다. 그 창은 preload 다리(메일 보내기·첨부)를 쥐고 있고 CSP 가 프레임을 막는다 —
 * 남의 페이지(YouTube)를 거기 들이면 그 다리가 남의 손에 닿는다. 그래서 다리 없는 창을 따로 띄운다:
 * preload 없음 · sandbox · 제 세션(메모리에만) · 그 영상의 embed 주소 밖으로는 못 나간다.
 * 창 안에서 다른 곳으로 가려는 링크(«YouTube에서 보기» 등)는 «사용자가 눌렀을 때만» 기본 브라우저로 넘긴다.
 *
 * 리퍼러 — embed 를 리퍼러 없이 열면 YouTube 가 «동영상 플레이어 구성 오류»(오류 153)를 띄운다.
 * 실측(Electron 33.4, 화면 밖 창, 소리 끔, 공개 시험 영상 M7lc1UVf-VE, start=5):
 *   리퍼러 없음                    → .ytp-error «동영상 플레이어 구성 오류», 재생 안 됨
 *   loadURL 의 httpReferrer        → 재생 (getPlayerState 1, 5초에서 8.5초까지 흘렀다), document.referrer 도 채워진다
 *   webRequest 로 Referer 머리만   → 재생, 다만 document.referrer 는 빈 채
 * httpReferrer 를 쓴다 — 이 창의 그 한 번 열기에만 걸리고(세션 전체에 갈고리를 안 건다), 페이지가 읽는
 * document.referrer 까지 맞는다. 값은 앱 ID(com.hyong.nunsseom)를 https 주소 꼴로 — 어느 앱이 퍼갔는지 밝힌다.
 *
 * 못 트는 영상(퍼가기 막음·삭제됨·연령 제한)은 embed 가 오류 덮개(.ytp-error)를 띄운다 — 실측 «이 동영상은 볼 수 없습니다.».
 * 메인이 격리된 세계(isolated world)에서 그 덮개를 보고, 뜨면 창을 닫고 YouTube 페이지를 브라우저로 연다.
 * 창은 하나만 둔다 — 새 영상을 누르면 떠 있는 창에서 갈아 끼운다 (사용자가 옮겨 둔 자리 그대로,
 * 쇼츠로 바뀌어 9:16 이 되면 지금 창의 가운데를 지키며 크기만 바꾼다).
 */
const { BrowserWindow, screen, session } = require('electron');
const evlog = require('./evlog');
const { openWeb } = require('./win');

const PARTITION = 'hibi-video';   // persist: 가 없다 — 메모리에만 있고, 앱을 끄면 쿠키째 사라진다
const REFERRER = 'https://com.hyong.nunsseom/';
const EMBED_HOST = 'www.youtube-nocookie.com';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// 오류 덮개를 보는 격리된 세계 — 0 은 페이지의 세계, 999 는 Electron 의 contextIsolation 이 쓴다
const PROBE_WORLD = 1001;
const WATCH_MS = 700;
const WATCH_TRIES = 20;          // 14초 — 그때까지 재생도 오류도 없으면 그만 본다
// 누른 지 이만큼 안에 연 새 창·이동만 사용자가 한 것으로 본다 — 크롬의 팝업 차단을 대신한다
const GESTURE_MS = 1500;
// 같은 영상을 이만큼 안에 또 누르면(더블클릭) 다시 부르지 않는다
const AGAIN_MS = 1000;
// 하위 프레임이 머물러도 되는 곳 — YouTube·Google 쪽만 (그 아래 호스트 포함)
const FRAME_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'google.com', 'doubleclick.net', 'googlesyndication.com', 'gstatic.com'];

/** 플레이어 창 만들기 — 옵션을 그대로 넘긴다 (시험이 이 함수로 창을 만들어 실제 webPreferences 를 잰다) */
function createWindow(opts) {
  return new BrowserWindow(opts);
}

let deps = {
  make: createWindow,
  web: openWeb,
  // 떠 있는 창을 앞으로 — 시험은 창을 화면에 올리지 않게 갈아 끼운다
  reveal: (win) => {
    if (win.isMinimized()) win.restore();
    win.moveTop();
    win.focus();
  }
};
/** 시험이 창 만들기·브라우저 열기·앞으로 가져오기를 갈아 끼운다 */
function init(h) { deps = { ...deps, ...h }; }

let slot = null;   // { win, video, seq, gaveUp, at, closing } — 떠 있는 플레이어 하나

function embedUrl(v) {
  const q = new URLSearchParams({ autoplay: '1', rel: '0' });
  if (v.start > 0) q.set('start', String(Math.floor(v.start)));
  return `https://${EMBED_HOST}/embed/${v.id}?${q}`;
}

/** 못 틀 때 브라우저로 열 YouTube 페이지 */
function watchUrl(v) {
  if (v.shorts) return `https://www.youtube.com/shorts/${v.id}`;
  return `https://www.youtube.com/watch?v=${v.id}${v.start > 0 ? `&t=${Math.floor(v.start)}s` : ''}`;
}

/** 이 주소가 «그 영상의 embed»인가 — 플레이어 창이 머물러도 되는 유일한 곳 */
function isEmbedFor(url, id) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  return u.protocol === 'https:' && u.hostname === EMBED_HOST && !u.port && !u.username && !u.password
    && u.pathname === `/embed/${id}`;
}

/** 하위 프레임이 가도 되는 곳인가 — YouTube·Google 의 https, 아니면 빈 프레임(about:blank·srcdoc) */
function frameAllowed(url) {
  const t = String(url || '');
  if (/^about:(blank|srcdoc)(?:[?#]|$)/i.test(t)) return true;
  let u;
  try { u = new URL(t); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  return FRAME_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** 허락할 권한 — 전체 화면만. 카메라·마이크·알림·위치는 영상 보기에 필요 없다 */
function permissionAllowed(permission) {
  return permission === 'fullscreen';
}

/**
 * 창 자리 — 그 모니터 작업 영역 가운데, 16:9(쇼츠는 9:16). 960×540(쇼츠 405×720)이 안 들어가면 비율대로 줄인다.
 * 제목줄이 붙으므로 작업 영역의 85% 안에 둔다. width·height 는 내용 크기다 (useContentSize).
 */
function boundsIn(area, shorts) {
  const ratio = shorts ? 9 / 16 : 16 / 9;
  const maxW = Math.floor(area.width * 0.85);
  const maxH = Math.floor(area.height * 0.85);
  let w = shorts ? 405 : 960;
  let h = Math.round(w / ratio);
  if (w > maxW) { w = maxW; h = Math.round(w / ratio); }
  if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
  return {
    x: area.x + Math.round((area.width - w) / 2),
    y: area.y + Math.round((area.height - h) / 2),
    width: w, height: h
  };
}

/**
 * 16:9 ↔ 9:16 이 바뀔 때 — 크기는 boundsIn 대로, 자리는 지금 창(cur, 내용 영역)의 가운데를 지킨다.
 * 사용자가 옮겨 둔 자리를 버리고 모니터 가운데로 튀지 않게. 작업 영역 밖으로 나가면 안으로 민다
 * (top = 제목줄 높이 — 제목줄이 작업 영역 위로 숨지 않게).
 */
/**
 * 영상 비율을 «내용 영역»에 건다. setAspectRatio 는 그냥 주면 제목줄·테두리까지 든 바깥 크기에 걸려,
 * 내용이 960×540 이 아니라 1013×540 이 되고 영상 양옆에 검은 띠가 생겼다 (실측). 바깥과 내용의 차이를 extraSize 로 준다.
 */
function keepRatio(win, shorts) {
  const o = win.getBounds();
  const c = win.getContentBounds();
  win.setAspectRatio(shorts ? 9 / 16 : 16 / 9, { width: Math.max(0, o.width - c.width), height: Math.max(0, o.height - c.height) });
}

function boundsAround(cur, area, shorts, top = 0) {
  const { width, height } = boundsIn(area, shorts);
  const cx = cur.x + cur.width / 2;
  const cy = cur.y + cur.height / 2;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(Math.round(cx - width / 2), area.x, area.x + area.width - width),
    y: clamp(Math.round(cy - height / 2), area.y + top, area.y + area.height - height),
    width, height
  };
}

/** 플레이어 창의 옵션 — 시험이 이 값을 그대로 잰다 */
function playerOptions(bounds) {
  return {
    ...bounds,
    useContentSize: true,
    minWidth: 240, minHeight: 180,
    title: '영상',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      // 이 창에는 다리를 놓지 않는다 — 남의 페이지(YouTube)를 여는 창이다
      preload: undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      partition: PARTITION,
      // 눌러서 연 영상이다 — 재생 단추를 한 번 더 누르게 하지 않는다
      autoplayPolicy: 'no-user-gesture-required'
    }
  };
}

const guarded = new WeakSet();
/** 플레이어 세션 — 처음 한 번 권한·장치·내려받기를 막는다 */
function videoSession() {
  const ses = session.fromPartition(PARTITION);
  if (guarded.has(ses)) return ses;
  guarded.add(ses);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permissionAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
  // HID·USB·직렬 장치 — 기본도 취소지만 영상 보기에 쓸 일이 없으니 못박는다
  ses.setDevicePermissionHandler(() => false);
  // 이 창에서는 아무것도 내려받지 않는다
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}

function areaOf(win) {
  try {
    const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    return d.workArea;
  } catch {
    return { x: 0, y: 0, width: 1280, height: 720 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 창을 닫는다 — 닫히는 중인 창은 곧바로 «떠 있는 플레이어»에서 뺀다.
 * close() 는 비동기라 'closed' 까지 수십~수백 ms(실측: 진짜 embed 재생 중 46·147·198ms) 창이 살아 있다.
 * 그 사이 새 영상이 오면 곧 없어질 창에 실려 사라졌다 (실측). 이제 그때는 새 창을 만든다.
 */
function closing(s) {
  s.closing = true;
  if (slot === s) slot = null;
}
function closePlayer(s) {
  closing(s);
  if (!s.win.isDestroyed()) s.win.close();
}

/** 못 틀었다 — 창을 닫고 YouTube 페이지를 브라우저로. 한 영상에 한 번만 */
function giveUp(s, why) {
  if (s.gaveUp === s.seq) return;
  s.gaveUp = s.seq;
  evlog.log('영상', `못 틀어 브라우저로 · ${why}`);
  const v = s.video;
  closePlayer(s);
  deps.web(watchUrl(v));
}

// 격리된 세계에서 본다 — 페이지 스크립트가 이 검사를 바꿔치기할 수 없다 (DOM 만 같이 본다)
const PROBE = `(() => {
  const e = document.querySelector('.ytp-error');
  const v = document.querySelector('video');
  return { error: !!e && e.getClientRects().length > 0, playing: !!v && (v.currentTime > 0 || !v.paused) };
})()`;

/** 다 불러온 뒤 몇 초 — 재생이 시작되면 그만, 오류 덮개가 뜨면 브라우저로 */
async function watch(s) {
  const seq = s.seq;
  for (let i = 0; i < WATCH_TRIES; i++) {
    await sleep(WATCH_MS);
    if (s.seq !== seq || s.closing || s.win.isDestroyed()) return;
    let r = null;
    try {
      r = await s.win.webContents.executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code: PROBE }]);
    } catch {
      return;
    }
    if (s.seq !== seq) return;
    if (r && r.error) { giveUp(s, 'embed'); return; }
    if (r && r.playing) return;
  }
}

/** 창을 그 영상의 embed 에 못박는다 */
function lock(win, s) {
  const wc = win.webContents;
  // 사용자가 마지막으로 누른 때. Electron 에는 크롬의 팝업 차단이 없다 — 실측(화면 밖 창): 가짜 embed 안의
  // 교차 출처 iframe(광고 꼴)이 누름 없이 setTimeout 으로 연 window.open 이 그대로 기본 브라우저로 갔다.
  // 그래서 누른 직후에 연 것만 넘기고, 넘기면 그 누름은 썼다 (누름 한 번에 창 하나).
  let lastInput = 0;
  wc.on('input-event', (_e, i) => {
    if (/^(mouseDown|mouseUp|rawKeyDown|keyDown|gestureTap)$/.test(i.type)) lastInput = Date.now();
  });
  const handOut = (url) => {
    if (Date.now() - lastInput >= GESTURE_MS) {
      evlog.log('영상', '누르지 않은 새 창·이동 막음');
      return;
    }
    lastInput = 0;
    deps.web(url);
  };
  // 새 창은 안 연다 — «YouTube에서 보기»·제목 링크는 기본 브라우저로 (openWeb 이 http(s) 만 넘긴다)
  wc.setWindowOpenHandler(({ url }) => {
    handOut(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isEmbedFor(url, s.video.id)) return;
    e.preventDefault();
    handOut(url);
  });
  // 하위 프레임은 YouTube·Google 쪽으로만 — 주소창 없는 이 창 안에 남의 페이지(가짜 로그인 등)가 그려지지 않게.
  // 실측: 막기 전에는 embed 안 iframe 이 phish.example 로 가서 플레이어 안에 그대로 그려졌다
  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || frameAllowed(e.url)) return;
    e.preventDefault();
  });
  // 서버가 딴 곳으로 넘기면(로그인·동의 화면 등) 여기서는 못 튼다 — 브라우저에 맡긴다
  wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    const main = typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame;
    if (!main || isEmbedFor(url, s.video.id)) return;
    e.preventDefault();
    giveUp(s, 'redirect');
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // 클라이언트 인증서를 내지 않는다 — Electron 기본값은 «저장소의 첫 인증서»를 보낸다.
  // 실측: 이 창 안의 <img> 가 인증서를 요구하는 TLS 서버에 닿자 윈도우 개인 저장소의 인증서(이름·회사·메일)가 갔다.
  // cb() 를 인자 없이 부르면 인증서 없이 이어 간다
  wc.on('select-client-certificate', (e, _url, _list, cb) => {
    e.preventDefault();
    cb();
  });
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    // -3 은 다른 영상으로 갈아 끼우며 앞 것을 끊은 것이다
    if (!isMainFrame || code === -3) return;
    giveUp(s, `load ${code}`);
  });
  wc.on('did-finish-load', () => { watch(s); });
  // 제목은 «영상»으로 둔다 — 페이지 제목으로 바뀌지 않게
  win.on('page-title-updated', (e) => e.preventDefault());
  // Esc 로 닫는다 (메일 보기 창과 같게). 전체 화면일 때는 Esc 가 전체 화면만 푼다
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !win.isFullScreen()) closePlayer(s);
  });
}

/**
 * 영상 하나를 튼다. video = { id, start, shorts } (linkopen.youtubeOf 가 준 것), near = 기준 창(메일 보기 창).
 * 떠 있는 플레이어가 있으면 거기서 갈아 끼운다. 돌려주는 것은 플레이어 창.
 */
function play(video, near) {
  const v = {
    id: String((video && video.id) || ''),
    start: Math.max(0, Math.floor(Number(video && video.start) || 0)),
    shorts: !!(video && video.shorts)
  };
  // 주소에 그대로 들어가는 값이다 — 번호 꼴이 아니면 안 연다
  if (!VIDEO_ID.test(v.id)) throw new Error('영상 번호가 아닙니다');
  videoSession();

  if (slot && !slot.closing && !slot.win.isDestroyed()) {
    const s = slot;
    // 썸네일을 두 번 누른 것 — 막 부르기 시작한 embed 를 처음부터 다시 부르지 않는다
    if (s.video.id === v.id && s.video.start === v.start && s.video.shorts === v.shorts && Date.now() - s.at < AGAIN_MS) {
      deps.reveal(s.win);
      return s.win;
    }
    const turned = s.video.shorts !== v.shorts;
    s.video = v;
    s.seq++;
    s.at = Date.now();
    if (turned) {
      const c = s.win.getContentBounds();
      const top = Math.max(0, c.y - s.win.getBounds().y);
      keepRatio(s.win, v.shorts);
      s.win.setContentBounds(boundsAround(c, areaOf(s.win), v.shorts, top));
    }
    s.win.loadURL(embedUrl(v), { httpReferrer: REFERRER }).catch(() => { /* did-fail-load 가 맡는다 */ });
    deps.reveal(s.win);
    evlog.log('영상', '플레이어 · 갈아 끼움');
    return s.win;
  }

  const win = deps.make(playerOptions(boundsIn(areaOf(near), v.shorts)));
  const s = { win, video: v, seq: 1, gaveUp: 0, at: Date.now(), closing: false };
  slot = s;
  win.removeMenu();
  keepRatio(win, v.shorts);
  lock(win, s);
  // 사용자가 X 로 닫을 때도 — 'close' 는 close() 안에서 바로 뜨고 'closed' 는 한참 뒤다
  win.on('close', () => closing(s));
  win.on('closed', () => { if (slot === s) slot = null; });
  win.loadURL(embedUrl(v), { httpReferrer: REFERRER }).catch(() => { /* did-fail-load 가 맡는다 */ });
  evlog.log('영상', '플레이어 열기');
  return win;
}

/** 떠 있는 플레이어 창 (없으면 null) */
function current() {
  return slot && !slot.closing && !slot.win.isDestroyed() ? slot.win : null;
}

module.exports = {
  PARTITION, REFERRER, EMBED_HOST, GESTURE_MS, FRAME_HOSTS,
  embedUrl, watchUrl, isEmbedFor, frameAllowed, permissionAllowed, boundsIn, boundsAround, playerOptions,
  createWindow, play, current, init
};

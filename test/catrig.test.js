// 만지는 고양이(renderer/anim/catrig.js)가 휴식 창에 약속대로 앉는가 — 영상 고양이 대신, 같은 자리에, 쉬고 깨고, 기록을 남긴다.
//
// 이 시험은 앱을 띄우지 않는다. 보이지 않는 창(show:false + offscreen)에 진짜 overlay.html 을 시험용 다리
// (test/fixtures/overlay-catrig-stub.js)로 띄운다 — 사용자 모니터에는 아무것도 안 뜨고, 소리도 안 낸다(그르렁 끔).
// 메인 쪽은 src/breakwin.js 만 불러 그 IPC 처리기(catrig:rig·pet·affinity)를 그대로 쓴다. 데이터 폴더는 임시로.
//   [1] 목록 — CAT_ENTERS 의 고양이마다 clip.js CLIPS 에 rig 가 있고, 그 폴더에 base.webp·eyes.webp·rig.json 이 있다. 한 마리 0.5MB 이하
//   [2] 자리 — 여러 화면 크기에서 구석 고양이는 화면 안·글 자리 밖·단추 줄 밖, 주인공은 오른쪽 아래 안내 칸 밖.
//       영상 프레임 알파와 리그 사진을 겹쳐 보면 같은 자리다 (IoU)
//   [3] 띄우기 — 고양이마다 휴식 창에 앉아 ready(webgl)·세계 크기를 알리고, 거울 고양이는 scale -1 1, 커서를 막지 않는다.
//       주인공은 안내·단추와 안 겹친다. 다른 모니터는 영상처럼 비워 둔다(주인공 자리도 안 켠다). 며칠 만에 보면 친밀도를 식혀 저장한다
//   [4] 쓰다듬기·휴식 끝 — 커서가 창 밖으로 나가도 혼자 숨쉰다. 진짜 커서로 쓰다듬다 휴식이 시간으로 끝나도(메인 endBreak)
//       쓰다듬은 횟수가 메인 store 까지 간다. 걷으면 사라진다. 손가락으로 떼며 쓸어도 센다
//   [4b] 혼자 두리번 — 진짜 고양이처럼 홱 돌고 멈춘다 (90% 까지 0.8초 안, 넘치지 않고, 구석 크기에서 그린 장 사이 건너뛰지 않는다).
//       쉬는 중·도는 중 누르면 고개를 든다
//   [4c] 쓰다듬는 눈 — 어느 부위든(이마·턱·등·엉덩이·몸·꼬리) 끝까지 감고 그대로 머문다. 손을 떼면 쉬는 꺼풀로 돌아온다.
//       경고엔 눈을 뜨고, 화나면 가늘게(0.375) 뜬 채 쓰다듬어도 안 감는다. 친밀도가 높으면 쉴 때 한 칸(0.125) 내려오고, 눈인사도 그대로다
//   [4d] 손 모양 커서 — 진짜 커서를 보내 고양이(몸·귀) 위에서만 grab, 빈 곳·알파 지도의 빈틈·단추·체크 줄(고양이 위여도)은 화살표.
//       쉬거나(pause·휴식 끝) 걷거나 GPU 를 잃거나 창 밖으로 나가거나 창 크기가 바뀌면 body 커서를 되돌린다. 손가락 톡도 남기지 않는다.
//       거울 고양이는 화면에 보이는 자리에서 손이 된다
//   [4e] 끊어 쓰다듬는 눈 — 쓸고 쉬는 손길(0.5+1.2초, 0.5+2초, 1+2.5초, 손가락도)에 눈이 감은 채다. 감는 중에 멈춰도 끝까지 감고, 손이 떠나면
//       마지막 손길 3초 뒤 쉬는 꺼풀까지 한 번에 뜬다. 경고·화남·settle 은 붙들지 않고, 붙든 동안 눈인사도 고개 돌림도 없다.
//       쓰다듬기로 안 잡힌 커서는 눈을 못 감기고, 천천히 다시 쓸면 창이 이어진다. 몸이 풀린 뒤 눈만 붙든 동안은 숨 빠르기로 돈다
//   [5] 물러나기 — WebGL 이 없거나 사진·rig.json 이 없으면 영상으로. 설정을 끄면 영상 그대로
//   [6] 기록 — 이번 휴식의 창이 아닌 창(휴식 창 페이지여도)·이상한 값은 버린다. 같은 고양이를 찍은 영상끼리 한 고양이로 센다.
//       다른 화면에 친밀도와 오늘 횟수를 나눈다
//   [6d] 오늘 친밀도에 든 횟수 — 경고 중 쓸기는 리그도 store 처럼 안 센다(창 안과 다음 휴식의 셈 바탕이 하나). 다른 화면이 알린 몫은
//       더 클 때만 받고, 그 바탕으로 친밀도를 셈한다
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 400_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const OVERLAY = path.join(ROOT, 'renderer', 'overlay.html');
const STUB = path.join(__dirname, 'fixtures', 'overlay-catrig-stub.js');
const BUDGET = 512 * 1024;   // 한 마리 사진·꺼풀·rig.json 합 — 설치 파일이 고양이마다 이만큼씩 커진다

// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에.
// 회색 고양이는 사흘 전에 마지막으로 봤다 (친밀도 0.5) — 휴식 창이 식혀 저장하는지 본다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catrig-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ago = new Date(); ago.setDate(ago.getDate() - 3);
fs.mkdirSync(path.join(tmp, 'Hibi'), { recursive: true });
// 손으로 고친 파일처럼 '__proto__' 이름도 하나 끼워 둔다 (JSON 글자로 — 객체 글자로 쓰면 프로토타입이 된다)
fs.writeFileSync(path.join(tmp, 'Hibi', 'nunsseom.json'), JSON.stringify({
  settings: { overlayEnter: 'cat-rb', soundVolume: 55 }, layoutVersion: 4,
  catRig: { cats: { grey: { affinity: 0.5, lastDay: dayKey(ago), today: 7, pets: 40 } }, days: {}, total: 40 }
}).replace('"cats":{', '"cats":{"__proto__":{"affinity":1},'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 진짜 메인 모듈 (src/breakwin.js) — app 이 준비된 뒤 부른다. 시험 창은 이것의 «이번 휴식의 창»으로 넣어야 기록을 받는다
let breakwin = null;
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const SINGLE = { mode: 'single', grouped: false, items: [{ name: '눈 휴식', emoji: '👀', color: '#5ac8fa', kind: 'short',
  headline: '20초 동안 먼 곳을 바라보세요', tip: ['20초 동안 먼 곳을 바라보세요', '6미터쯤 떨어진 곳에 초점을 맞추면 눈 근육이 풀립니다'], checklist: null }] };

/** 휴식 창 하나 — 창은 절반 크기에 확대 0.5 라 CSS 크기가 w×h 다 (모니터보다 큰 창은 윈도우가 자른다).
 *  adopt 가 아니면 메인이 모르는 창이다 (휴식 창 페이지여도 기록·rig.json 을 못 받는다) */
async function overlay(w, h, adopt = true) {
  const win = new BrowserWindow({ show: false, width: Math.round(w / 2), height: Math.round(h / 2), useContentSize: true, frame: false,
    webPreferences: { offscreen: true, preload: STUB, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  if (adopt) breakwin.adoptForTest(win);
  await win.loadFile(OVERLAY, { query: { display: '1', main: 'false' } });
  win.webContents.setFrameRate(30);
  win.webContents.setZoomFactor(0.5);
  await sleep(150);
  return win;
}
const js = (win, code) => win.webContents.executeJavaScript(code);

// 리그가 앉기를 기다려 잰다 — 들어오는 움직임(0.7초)이 끝난 뒤
const RIG_STATE = `(async () => {
  const E = window.nunsEnter;
  for (let i = 0; i < 100 && !(E.rigNow() && E.rigNow().handle); i++) await new Promise((r) => setTimeout(r, 50));
  const c = E.rigNow();
  const video = document.querySelectorAll('#curtain video').length;
  if (!c || !c.handle) return { none: true, video, cls: document.getElementById('curtain').className, hero: document.documentElement.classList.contains('ent-hero') };
  const ready = await c.handle.ready.catch((e) => ({ err: String(e) }));
  await new Promise((q) => setTimeout(q, 1900));
  const rig = await window.nunsseom.catRig(c.id);
  const world = window.nunsCatRig.worldOf(rig);
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? { l: b.left, t: b.top, r: b.right, b: b.bottom } : null; };
  const cv = c.box.querySelector('canvas');
  const mid = cv ? R(cv) : null;
  const under = mid ? document.elementFromPoint((mid.l + mid.r) / 2, (mid.t + mid.b) / 2) : null;
  const btn = document.getElementById('btn-skip');
  const br = R(btn);
  return { id: c.id, ready, world: { w: world.w, h: world.h }, mirrorWant: !!(rig.display && rig.display.mirror),
    canvas: !!cv, cin: cv ? cv.classList.contains('in') : false, scale: cv ? getComputedStyle(cv).scale : null,
    pe: cv ? getComputedStyle(cv).pointerEvents : null, underIsCat: !!under && (under === cv || c.box.contains(under)),
    btnFree: br ? document.elementFromPoint((br.l + br.r) / 2, (br.t + br.b) / 2) === btn : null,
    box: R(c.box), cv: R(cv), video, hero: document.documentElement.classList.contains('ent-hero'),
    glow: c.box.style.filter || '', W: innerWidth, H: innerHeight,
    content: ['kicker', 'headline', 'subline', 'list'].map((id) => R(document.getElementById(id))).filter(Boolean),
    buttons: [...document.querySelectorAll('.actions button')].filter((b) => getComputedStyle(b).display !== 'none').map(R).filter(Boolean),
    stage: +getComputedStyle(document.querySelector('.stage')).opacity };
})()`;
const hit = (a, b, pad = 0) => !!(a && b && a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad);
const inside = (a, W, H) => !!a && a.l >= -0.5 && a.t >= -0.5 && a.r <= W + 0.5 && a.b <= H + 0.5;

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  breakwin = require(path.join(ROOT, 'src', 'breakwin.js'));
  // 휴식 끝(endBreak)이 부르는 메인 쪽 — 스케줄러·트레이는 없다
  breakwin.init({ scheduler: { snooze() {}, rescheduleAll() {}, soonest: () => null, activeIds: () => [] }, updateTray() {}, pushTick() {} });
  const w0 = {};
  for (const rel of ['renderer/anim/clip.js', 'renderer/enter.js']) vm.runInNewContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { window: w0 }, { filename: rel });
  const CLIPS = w0.nunsClip.CLIPS;
  const rigIds = [...new Set(Object.values(CLIPS).map((c) => c.rig).filter(Boolean))];
  const rigs = {};
  for (const id of rigIds) rigs[id] = breakwin.rigJson(id);
  const firstClip = (rig) => Object.keys(CLIPS).find((k) => CLIPS[k].rig === rig);

  console.log('\n[1] 목록 — 고양이마다 사진 폴더');
  const noRig = breakwin.CAT_ENTERS.filter((id) => !CLIPS[id] || !CLIPS[id].rig);
  ok(noRig.length === 0, 'CAT_ENTERS 의 고양이마다 CLIPS 에 rig 가 있다', noRig);
  for (const id of rigIds) {
    const dir = path.join(breakwin.RIG_DIR, id);
    const files = ['base.webp', 'eyes.webp', 'rig.json'];
    const have = files.filter((f) => fs.existsSync(path.join(dir, f)));
    const bytes = have.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    ok(have.length === 3 && !!rigs[id], `${id}: base.webp·eyes.webp·rig.json 이 있고 rig.json 을 읽는다`, have);
    ok(bytes <= BUDGET, `${id}: 세 파일 합 0.5MB 이하`, +(bytes / 1024).toFixed(1) + 'KB');
  }
  const mirrored = rigIds.filter((id) => rigs[id] && rigs[id].display && rigs[id].display.mirror).sort();
  ok(JSON.stringify(mirrored) === JSON.stringify(['cat-lie', 'cat-loaf', 'cat-roll']), '머리가 오른쪽인 영상(엎드린·늘어진·식빵)은 거울로 보인다', mirrored);
  ok(breakwin.rigJson('../grey') === null && breakwin.rigJson('nope') === null && breakwin.rigJson(7) === null && breakwin.rigJson('__proto__') === null,
    '이상한 이름·없는 폴더는 rig.json 을 안 준다');

  console.log('\n[1b] 설정 → 휴식 창에 싣는 값');
  const cats0 = store.catRigCats();
  ok(cats0.grey && cats0.grey.daysAway === 3 && cats0.grey.affinity === 0.5 && cats0.grey.today === 0
    && Object.keys(cats0).join() === 'grey' && Object.getPrototypeOf(cats0) === Object.prototype,
    '저장된 친밀도와 «사흘 만»이 실린다 (지난날 센 몫은 오늘 0, 이상한 이름은 버린다)', cats0);
  const pl = breakwin.buildBreakPayload(['eye']).catRig;
  ok(store.settings.catTouch === true && store.settings.catPurr === true && pl && pl.purr === true && pl.volume === 0.55 && pl.cats.grey,
    '기본은 «고양이 만지기»·«골골 소리» 켜짐 — 소리 크기는 알림음 크기(55%)', pl && { purr: pl.purr, volume: pl.volume });
  ok(breakwin.catRigPayload({ catTouch: false }) === null, '«고양이 만지기»를 끄면 싣지 않는다 (예전 영상)');
  const quiet = breakwin.catRigPayload({ catTouch: true, catPurr: true, soundVolume: 0 });
  const nopurr = breakwin.catRigPayload({ catTouch: true, catPurr: false, soundVolume: 80 });
  const odd = breakwin.catRigPayload({ catTouch: true, soundVolume: 'x' });
  ok(quiet.purr === false && nopurr.purr === false && nopurr.volume === 0.8 && odd.volume === 0.55,
    '무음이거나 «골골 소리»를 끄면 그르렁 없음, 이상한 크기는 기본 55%', { quiet, nopurr: { purr: nopurr.purr, volume: nopurr.volume }, odd: odd.volume });

  // 쓰다듬기 기록 ← 시험 창의 다리가 보낸 것 (end 단추 알림은 받기만)
  ipcMain.on('test:end', () => {});

  console.log('\n[2] 자리 — 화면 크기마다');
  const win = await overlay(1920, 1080);
  const lay = await js(win, `(() => {
    const C = window.nunsClip, R = window.nunsCatRig, rigs = ${JSON.stringify(rigs)};
    const sizes = [[1920, 1080], [1366, 768], [1280, 720], [1280, 1024], [1440, 900], [2560, 1440], [3840, 2160], [3440, 1440], [1920, 1920], [1080, 1920], [768, 1366], [720, 1280]];
    const out = [];
    for (const [id, clip] of Object.entries(C.CLIPS)) {
      const rig = rigs[clip.rig];
      const world = R.worldOf(rig);
      const hero = clip.place && clip.place.mode === 'hero';
      for (const [w, h] of sizes) {
        const b = C.rigBox(w, h, clip, rig, world);
        const v = C.layout(w, h, clip);
        const text = b.x < w * 0.59 && b.x + b.w > w * 0.41 && b.y < h * 0.62 && b.y + b.h > h * 0.30;
        const btn = w >= 600 && b.x < w / 2 + 180 && b.x + b.w > w / 2 - 180 && b.y + b.h > h - 95;
        const inside = b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= w + 0.5 && b.y + b.h <= h + 0.5;
        const panel = !hero || h >= w || b.x + b.w <= w - C.heroPanelWidth(w) + 0.5;
        const aspect = Math.abs(b.w / b.h - world.w / world.h) < 0.01 * world.w / world.h;
        // 사진(여백 뺀) 폭이 영상 칸 폭에 견줘 — 영상 칸 안의 고양이 몫과 같은 크기인지 어림
        const src = C.rigSource(rig, clip);
        const k = b.w / world.w;
        const size = src ? +((rig.size.w * k) / ((src[2] - src[0]) * v.w / clip.width)).toFixed(3) : null;
        out.push({ id, size: w + 'x' + h, hero, text, btn, inside, panel, aspect, scale: size, src: !!src });
      }
    }
    return out;
  })()`);
  const corner = lay.filter((q) => !q.hero);
  const heroes = lay.filter((q) => q.hero);
  ok(lay.every((q) => q.src), '모든 고양이가 사진이 영상의 어디서 왔는지 안다 (source·display.video)', lay.filter((q) => !q.src).map((q) => q.id));
  ok(corner.every((q) => !q.text), '구석 고양이는 어떤 화면에서도 글 자리(가로 41~59%·세로 30~62%)를 안 덮는다', corner.filter((q) => q.text));
  ok(corner.every((q) => !q.btn), '구석 고양이는 가운데 아래 단추 줄을 가리지 않는다', corner.filter((q) => q.btn));
  ok(lay.every((q) => q.inside), '화면 밖으로 안 나간다', lay.filter((q) => !q.inside));
  ok(heroes.every((q) => q.panel), '주인공은 가로 화면에서 오른쪽 아래 안내 칸에 안 들어간다', heroes.filter((q) => !q.panel));
  ok(lay.every((q) => q.aspect), '리그 세계 비율을 지킨다 (찌그러지지 않는다)', lay.filter((q) => !q.aspect));
  ok(lay.every((q) => q.scale != null && Math.abs(q.scale - 1) < 0.001), '사진이 영상 속 고양이와 같은 크기로 그려진다 (화면 밖으로 밀어도 크기는 그대로)',
    [...new Set(lay.map((q) => q.scale))]);

  console.log('\n[2b] 영상 프레임과 겹쳐 보기');
  for (const id of rigIds) {
    const clipId = firstClip(id);
    const r = await js(win, `(async () => {
      const C = window.nunsClip, rig = ${JSON.stringify(rigs[id])}, clip = C.CLIPS[${JSON.stringify(clipId)}];
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = new URL(clip.url, document.baseURI).href;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('영상을 못 열었다')); });
      const t = rig.source && rig.source.time != null ? rig.source.time : 0;
      await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
      const W = v.videoWidth, H = v.videoHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(v, 0, 0);
      const va = x.getImageData(0, 0, W, H).data;
      const im = new Image(); im.src = C.RIG_DIR + ${JSON.stringify(id)} + '/base.webp'; await im.decode();
      const b = C.rigSource(rig, clip);
      const kx = (b[2] - b[0]) / rig.size.w, ky = (b[3] - b[1]) / rig.size.h;
      x.clearRect(0, 0, W, H);
      if (rig.display && rig.display.mirror) { x.translate(b[2], b[1]); x.scale(-kx, ky); } else { x.translate(b[0], b[1]); x.scale(kx, ky); }
      x.drawImage(im, 0, 0);
      const ta = x.getImageData(0, 0, W, H).data;
      let i = 0, u = 0;
      for (let p = 3; p < va.length; p += 4) { const A = va[p] > 128, B = ta[p] > 128; if (A && B) i++; if (A || B) u++; }
      return +(i / Math.max(1, u)).toFixed(3);
    })()`).catch((e) => ({ err: e.message }));
    ok(typeof r === 'number' && r >= 0.9, `${id}: 리그 사진이 영상 속 고양이(${clipId}, 고른 장)와 같은 자리에 겹친다 (IoU 0.9 이상)`, r);
  }
  win.destroy();

  console.log('\n[3] 휴식 창에 앉기 — 고양이마다');
  const catRigOf = () => ({ ...breakwin.catRigPayload(store.settings), purr: false, volume: 0 });
  const pay = (enter, extra) => ({ ...SINGLE, enter, enterOn: '1', durationSec: 20, endsAt: Date.now() + 20000, sound: { enabled: false },
    noEscape: false, catRate: 0.75, catRig: catRigOf(), ...extra });
  const begin = async (w, h, p) => {
    const win = await overlay(w, h);
    await js(win, `window.__begin(${JSON.stringify(p)})`);
    return { win, s: await js(win, RIG_STATE) };
  };
  for (const id of rigIds) {
    const clipId = firstClip(id);
    const { win, s } = await begin(1920, 1080, pay(clipId));
    const clip = CLIPS[clipId];
    const hero = clip.place && clip.place.mode === 'hero';
    ok(!s.none && s.ready && s.ready.mode === 'webgl' && s.canvas && s.video === 0, `${clipId}: 영상 대신 만지는 고양이(WebGL)가 앉는다`, s.none ? s : { ready: s.ready, video: s.video });
    if (s.none) { win.destroy(); continue; }
    ok(s.ready.width === s.world.w && s.ready.height === s.world.h, `${clipId}: ready 가 이 고양이의 세계 크기(worldOf)를 알린다`, { ready: s.ready, world: s.world });
    ok(s.ready.mirror === s.mirrorWant && (s.mirrorWant ? s.scale === '-1 1' : s.scale === 'none'), `${clipId}: 거울 ${s.mirrorWant ? '— 캔버스가 scale -1 1' : '아님'}`, { mirror: s.ready.mirror, scale: s.scale });
    ok(s.cin && s.stage > 0.95, `${clipId}: 들어오는 움직임(.in)으로 나타나고, 안내도 뜬다`, { in: s.cin, stage: s.stage });
    ok(s.pe === 'none' && !s.underIsCat && s.btnFree === true, `${clipId}: 고양이는 커서를 받지 않는다 — 단추·안내를 막지 않는다`, { pe: s.pe, underIsCat: s.underIsCat, btnFree: s.btnFree });
    ok(s.box && s.cv && Math.abs(s.box.l - s.cv.l) < 1.5 && Math.abs(s.box.r - s.cv.r) < 1.5 && Math.abs(s.box.b - s.cv.b) < 1.5, `${clipId}: 캔버스가 자리 상자를 채운다`, { box: s.box, cv: s.cv });
    ok(inside(s.cv, s.W, s.H) && !s.content.some((c) => hit(c, s.cv)) && !s.buttons.some((b) => hit(b, s.cv)), `${clipId}: 화면 안, 안내·단추와 안 겹친다`, s.cv);
    ok(s.hero === hero && !clip.glow === !s.glow && (!s.glow || /drop-shadow/.test(s.glow)), `${clipId}: 주인공 자리·빛(glow)이 영상과 같다`, { hero: s.hero, glow: s.glow });
    win.destroy();
  }

  console.log('\n[3b] 주인공 — 여러 화면');
  for (const clipId of Object.keys(CLIPS).filter((k) => CLIPS[k].place && CLIPS[k].place.mode === 'hero')) {
    for (const [w, h] of [[1366, 768], [2560, 1440], [1080, 1920]]) {
      const { win, s } = await begin(w, h, pay(clipId));
      const tag = `${clipId} ${w}x${h}`;
      if (s.none) { ok(false, `${tag}: 앉는다`, s); win.destroy(); continue; }
      ok(s.hero && inside(s.cv, s.W, s.H), `${tag}: 주인공 자리, 화면 안`, s.cv);
      ok(!s.content.some((c) => hit(c, s.cv)) && !s.buttons.some((b) => hit(b, s.cv)), `${tag}: 안내·단추와 안 겹친다`,
        { cat: s.cv, content: s.content.map((c) => Math.round(c.b)), buttons: s.buttons.map((b) => Math.round(b.b)) });
      win.destroy();
    }
  }

  console.log('\n[3c] 다른 모니터 · 친밀도');
  {
    // 영상처럼 마우스가 있는 화면 하나에만 앉는다 — 모니터마다 앉히면 같은 고양이가 화면 수만큼 뜨고 기분도 따로 논다
    for (const id of ['cat-rb', 'cat-loaf']) {
      const { win, s } = await begin(1920, 1080, pay(id, { enterOn: '2' }));
      ok(s.none && s.video === 0 && s.cls === 'curtain' && s.hero === false,
        `${id}: 마우스가 없는 다른 모니터는 비워 둔다 — 고양이도 영상도 없고, 안내는 가운데 그대로`, s.none ? { video: s.video, cls: s.cls, hero: s.hero } : { id: s.id, hero: s.hero });
      win.destroy();
    }
    const { win: w2, s: s2 } = await begin(1920, 1080, pay('blinds', { enterOn: '2' }));
    ok(s2.none && s2.video === 0 && s2.cls === 'curtain', '고양이가 아닌 연출이면 다른 모니터는 예전처럼 비워 둔다', s2);
    w2.destroy();
  }
  {
    await sleep(200);
    const g = store.catRigCats().grey;
    const want = 0.5 * Math.pow(0.97, 2);
    ok(g && Math.abs(g.affinity - want) < 1e-9 && g.daysAway === 0,
      '사흘 만에 본 회색 고양이 — 리그 규칙(affinityAfter)대로 식힌 친밀도를 저장하고, 오늘 본 날로 적는다', { g, want });
    const keys = [...new Set(rigIds.map((id) => breakwin.catKey(id)))];
    ok(keys.every((k) => store.catRigCats()[k]) && Object.keys(store.catRigCats()).length === keys.length,
      '본 고양이마다 친밀도가 생긴다 (처음 보는 고양이는 리그 기본값, 같은 고양이를 찍은 영상끼리는 하나)', Object.keys(store.catRigCats()));
  }

  console.log('\n[4] 쓰다듬기·휴식 끝·걷기');
  {
    const win = await overlay(1920, 1080);
    const r = await js(win, `(async () => {
      const E = window.nunsEnter, host = document.getElementById('curtain');
      const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
      const o = { purr: false, volume: 0, cats: {}, debug: true,
        rigOf: (id) => window.nunsseom.catRig(id),
        onPet: (id, p) => window.nunsseom.catPet({ rig: id, strokes: p.strokes, credited: p.credited }),
        onAffinity: (id, v) => window.nunsseom.catAffinity({ rig: id, value: v }) };
      await E.play('cat-rb', host, null, 20, { rig: o });
      for (let i = 0; i < 100 && !(E.rigNow() && E.rigNow().handle); i++) await sleep(50);
      const c = E.rigNow();
      await c.handle.ready;
      const d = () => { const s = c.handle.debug.stats(); return { running: s.running, raf: s.raf, timer: s.timer, draws: s.draws }; };
      await sleep(1200); const s1 = d();
      window.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null }));
      await sleep(1500); const s2 = d();
      const rig = c.handle.debug.rig();
      const head = c.handle.debug.where(rig.head.center[0], rig.head.center[1] - rig.head.ry * 0.35);
      return { s1, s2, head };
    })()`);
    ok(r.s2.running === true && r.s2.draws > r.s1.draws, '커서가 창 밖(다른 모니터)으로 나가도 재우지 않는다 — 혼자 숨쉰다', { s1: r.s1, s2: r.s2 });

    // 진짜 커서로 이마를 쓰다듬는다 — 창 좌표는 CSS 의 절반 (확대 0.5)
    const before = store.catRigStats();
    const [hx, hy] = r.head;
    const t0 = Date.now();
    while (Date.now() - t0 < 3600) {
      const ph = ((Date.now() - t0) / 900) * Math.PI * 2;
      const x = hx + Math.sin(ph) * 70;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x / 2), y: Math.round(hy / 2) });
      await sleep(16);
    }
    // 쓰다듬던 중에 휴식이 시간으로 끝난다 — 메인 tick 이 부르는 그 길 (손을 뗀 뒤 0.8초가 안 지나 리그는 아직 판을 안 알렸다)
    const p = await js(win, `(() => { const s = window.nunsEnter.rigNow().handle.debug.stats(); return { petting: s.petting, strokes: s.nStrokes }; })()`);
    breakwin.endBreak('done');
    const gone0 = win.isDestroyed();
    await sleep(700);
    const after = store.catRigStats();
    const n = after.total - before.total;
    ok(p.petting && p.strokes > 0 && n >= p.strokes && after.today - before.today === n,
      '쓰다듬던 중에 휴식이 시간으로 끝나도 그 판의 횟수가 메인 store 까지 간다 (오늘·모두)', { p, before: before.total, after: after.total });
    const g0 = before.cats.find((c) => c.id === 'grey');
    const g = after.cats.find((c) => c.id === 'grey');
    ok(g && g0 && g.affinity > g0.affinity, '오른 친밀도도 저장된다', { before: g0, after: g });
    ok(!gone0 && win.isDestroyed(), '창은 바로 없애지 않고 숨긴 뒤 잠깐 뒤에 닫는다', { right: gone0, later: win.isDestroyed() });
  }
  {
    const win = await overlay(1920, 1080);
    const z = await js(win, `(async () => {
      const E = window.nunsEnter, host = document.getElementById('curtain');
      await E.play('cat-rb', host, null, 20, { rig: { purr: false, volume: 0, cats: {}, rigOf: (id) => window.nunsseom.catRig(id) } });
      for (let i = 0; i < 100 && !(E.rigNow() && E.rigNow().handle); i++) await new Promise((q) => setTimeout(q, 50));
      const c = E.rigNow();
      await c.handle.ready;
      c.destroy();
      return { now: E.rigNow(), canvas: document.querySelectorAll('#curtain canvas').length, box: document.querySelectorAll('#curtain .ent-rig').length };
    })()`);
    ok(z.now === null && z.canvas === 0 && z.box === 0, '걷으면 캔버스·상자가 사라진다', z);
    win.destroy();
  }
  {
    // 손가락 — 뗄 때마다 relatedTarget 없는 pointerout 이 온다(마지막 move → pointerup → pointerout, 한 번에).
    // 리그 tick 이 마지막 move 를 읽기 전에 떼도 그 쓸기를 센다 (예전엔 pointerout 이 커서를 끊어 6번 쓸어도 0)
    const win = await overlay(1920, 1080);
    const n = await js(win, `(async () => {
      const E = window.nunsEnter, host = document.getElementById('curtain');
      const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
      await E.play('cat-rb', host, null, 20, { rig: { purr: false, volume: 0, cats: {}, debug: true, rigOf: (id) => window.nunsseom.catRig(id) } });
      for (let i = 0; i < 100 && !(E.rigNow() && E.rigNow().handle); i++) await sleep(50);
      const c = E.rigNow();
      await c.handle.ready;
      await sleep(900);
      const rig = c.handle.debug.rig();
      const [hx, hy] = c.handle.debug.where(rig.head.center[0], rig.head.center[1] - rig.head.ry * 0.35);
      const ev = (t, x) => window.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: hy, bubbles: true }));
      for (let k = 0; k < 6; k++) {
        ev('pointerdown', hx - 70);
        for (let i = 1; i <= 20; i++) { ev('pointermove', hx - 70 + i * 7); await sleep(16); }
        ev('pointermove', hx + 77); ev('pointerup', hx + 77); ev('pointerout', hx + 77);
        await sleep(180);
      }
      await sleep(1300);
      return c.handle.debug.stats().nStrokes;
    })()`);
    ok(n >= 6, '손가락으로 떼며 쓸어도 쓸기마다 센다 — 뗄 때 오는 pointerout 이 마지막 쓸기를 지우지 않는다', n);
    win.destroy();
  }

  console.log('\n[4b] 혼자 두리번 — 홱 돌고 멈춘다');
  {
    // 커서가 없는 창 — 혼자 두리번만 돈다. 3.5~8초를 기다리지 않게 debug.drift 로 바로 건다(왼쪽 끝에서 가만 → 오른쪽 끝, 0.9 rad).
    // 회색 고양이를 앱 구석 크기(1080p 에서 캔버스 476×510 기기 px)로 앉힌다 — 시험 창은 확대 0.5 라 상자를 그만큼 키운다.
    // 한 장 걸음은 «그린 장» 사이에서 잰다(debug.stats().draws 가 바뀐 표본끼리 — 안 그린 tick 의 상태 걸음은 화면에 안 보인다).
    // 코 둘레가 고개 1 rad 에 가로 14.5·세로 9.5 텍스처 px 가는 어림의 합(리그가 간격을 고르는 셈)을 화면 px 로.
    // 화면 갱신은 60Hz 로 — 다른 시험 창의 30 이면 리그가 가장 빠른 단계(화면 갱신마다)를 골라도 30fps 라 큰 두리번이 한 장에 0.7px 간다
    const win = await overlay(1920, 1080);
    win.webContents.setFrameRate(60);
    const d = await js(win, `(async () => {
      const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
      const dpr = devicePixelRatio || 1, host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:' + (476 / dpr) + 'px;height:' + (510 / dpr) + 'px';
      document.body.append(host);
      const rig = await window.nunsseom.catRig('grey');
      const h = window.nunsCatRig.mount(host, { base: window.nunsClip.RIG_DIR + 'grey/', rig, debug: true, sound: false });
      const r = await h.ready;
      await sleep(900);
      const S = () => h.debug.stats();
      const watch = (ms) => new Promise((done) => {
        const smp = [], t0 = performance.now();
        const f = () => { const t = performance.now() - t0, s = S(); smp.push([t, s.yaw, s.pitch, s.draws]); if (t < ms) requestAnimationFrame(f); else done(smp); };
        requestAnimationFrame(f);
      });
      h.debug.drift(-0.45, 0);
      await sleep(1500);
      const Y = 0.45, y0 = S().yaw, sw = Y - y0;
      const cv = host.querySelector('canvas'), kDev = h.debug.cfg().scale * cv.width / r.width;
      h.debug.drift(Y, 0);
      const smp = await watch(1600);
      const at = (q) => { const s = smp.find((x) => (x[1] - y0) / sw >= q); return s ? s[0] : null; };
      let over = 0, stepPx = 0, drawn = 0, last = smp[0];
      for (let i = 1; i < smp.length; i++) {
        over = Math.max(over, (smp[i][1] - y0) / sw - 1);
        if (smp[i][3] === last[3]) continue;
        stepPx = Math.max(stepPx, (Math.abs(smp[i][1] - last[1]) * 14.5 + Math.abs(smp[i][2] - last[2]) * 9.5) * kDev);
        drawn++; last = smp[i];
      }
      // 누르기 끄덕임 — 손가락 톡(이마). 도는 창이 끝난 뒤(쉬는 중)와 돌기 시작 0.15초 뒤(도는 창 안)
      const [tx, ty] = h.debug.where(rig.head.center[0], rig.head.center[1] - rig.head.ry * 0.35);
      const nod = async () => {
        const p0 = S().pitch;
        for (const t of ['pointerdown', 'pointerup']) window.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', pointerId: 9, isPrimary: true, clientX: tx, clientY: ty, bubbles: true }));
        const w = await watch(1000);
        return +Math.max(...w.map((x) => p0 - x[2])).toFixed(3);
      };
      const nodRest = await nod();
      await sleep(1500);
      h.debug.drift(0, 0);
      await sleep(150);
      const nodTurn = await nod();
      return { y0, t10: at(0.1), t90: at(0.9), over, stepPx, drawn, end: smp[smp.length - 1][1] - Y, canvas: [cv.width, cv.height], nodRest, nodTurn };
    })()`);
    const rise = d.t10 != null && d.t90 != null ? d.t90 - d.t10 : null;
    ok(Math.abs(d.y0 + 0.45) < 0.02 && d.t90 != null && d.t90 <= 800 && rise >= 150 && rise <= 600,
      '혼자 두리번은 홱 돈다 — 90% 까지 0.8초 안, 10~90% 0.15~0.6초 (예전 스프링 하나는 90% 2.4초·10~90% 2.1초)', { t10: d.t10 && Math.round(d.t10), t90: d.t90 && Math.round(d.t90), rise: rise && Math.round(rise), y0: +d.y0.toFixed(4) });
    ok(d.over < 0.02 && Math.abs(d.end) < 0.01 && d.stepPx < 0.6 && d.drawn >= 8,
      '돌고 나면 그 자리에 멈춘다 — 넘쳐 되돌지 않고, 구석 크기에서 그린 장 사이 화면 0.6px 넘게 건너뛰지 않는다 (예전엔 안 그린 tick 을 몰아 1px 남짓)',
      { over: +d.over.toFixed(4), end: +d.end.toFixed(4), stepPx: +d.stepPx.toFixed(2), drawn: d.drawn, canvas: d.canvas });
    ok(d.nodRest > 0.15 && d.nodTurn > 0.15,
      '누르면 고개를 든다 — 쉬는 중에도 두리번 도는 중에도 (빠른 두리번 스프링을 늘 걸면 0.03 rad 로 사라졌다)', { nodRest: d.nodRest, nodTurn: d.nodTurn });
    win.destroy();
  }

  // 진짜 커서 — 창 좌표는 CSS 의 절반 (확대 0.5)
  const mouseTo = (win, x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x / 2), y: Math.round(y / 2) });

  // 회색 고양이를 debug 로 앉혀 window.__h 에 둔다. 부위마다 가로로 가장 긴 토막을 리그의 부위 지도(debug.zone)에서 찾아 가운데 70% 를 오간다.
  // 눈을 오래 보려고 쓰다듬어도 경고가 안 오게 하고(tolMax), 경고·외면이 저절로 끝나지 않게 한다(warn·cool)
  const sit = async (cats, cfg) => {
    const win = await overlay(1920, 1080);
    const segs = await js(win, `(async () => {
      const E = window.nunsEnter, host = document.getElementById('curtain');
      await E.play('cat-rb', host, null, 20, { rig: { purr: false, volume: 0, cats: ${JSON.stringify(cats)}, debug: true, rigOf: (id) => window.nunsseom.catRig(id) } });
      for (let i = 0; i < 100 && !(E.rigNow() && E.rigNow().handle); i++) await new Promise((q) => setTimeout(q, 50));
      const h = window.__h = E.rigNow().handle;
      await h.ready;
      await new Promise((q) => setTimeout(q, 900));
      h.debug.moodCfg(${JSON.stringify(cfg)});
      const rig = h.debug.rig(), runs = {};
      for (let y = 2; y < rig.size.h; y += 4) {
        let cur = 'none', x0 = 0;
        for (let x = 2; x <= rig.size.w + 4; x += 4) {
          const z = x < rig.size.w ? h.debug.zone(x, y) : 'none';
          if (z === cur) continue;
          if (cur !== 'none' && (!runs[cur] || x - x0 > runs[cur].len)) runs[cur] = { len: x - x0, x: (x0 + x) / 2, y };
          cur = z; x0 = x;
        }
      }
      const out = {};
      for (const [z, r] of Object.entries(runs)) {
        const [a, y] = h.debug.where(r.x - r.len * 0.35, r.y), [b] = h.debug.where(r.x + r.len * 0.35, r.y);
        out[z] = { x: (a + b) / 2, y, amp: Math.abs(b - a) / 2, len: r.len };
      }
      return out;
    })()`);
    return { win, segs };
  };
  const stats = (win) => js(win, 'window.__h.debug.stats()');
  const swing = (win, seg, t) => mouseTo(win, seg.x + Math.sin((t / 900) * Math.PI * 2) * seg.amp, seg.y);
  const strokeFor = async (win, seg, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { swing(win, seg, Date.now() - t0); await sleep(16); }
  };
  // 눈을 다 감을 때까지 쓴다 — 걸린 ms, 못 감으면 null. 깜박임으로 잠깐 감은 것(content 가 아직 낮다)은 치지 않는다
  const strokeToClosed = async (win, seg) => {
    const t0 = Date.now();
    let next = 0;
    while (Date.now() - t0 < 9000) {
      const t = Date.now() - t0;
      swing(win, seg, t);
      await sleep(16);
      if (t < next) continue;
      next = t + 120;
      const s = await stats(win);
      if (s.lid >= 0.99 && s.content >= 0.945) return t;
    }
    return null;
  };
  // 40ms 마다 꺼풀을 적는다 — 쓰는 동안 곁에서 (깜박임은 꺼풀을 올리기만 하므로 «머문다» 는 최솟값으로 본다)
  const SMP_ON = `(() => { window.__smp = []; clearInterval(window.__smpT); const t0 = performance.now();
    window.__smpT = setInterval(() => { const s = window.__h.debug.stats(); window.__smp.push({ t: performance.now() - t0, lid: s.lid, zone: s.zone, mood: s.mood, greeting: s.greeting, greetings: s.greetings,
      eyeC: s.eyeC, eyeOn: s.eyeOn, content: s.content, petting: s.petting, restLid: s.restLid, ak: s.ak, yaw: s.yaw, pitch: s.pitch, gazeX: s.gazeX }); }, 40); })()`;
  const SMP_OFF = '(() => { clearInterval(window.__smpT); return window.__smp; })()';
  const lidOf = (rows) => rows.map((r) => r.lid);
  const median = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const fix3 = (v) => +v.toFixed(3);
  // 손을 뗀다 — 쉬는 꺼풀까지 돌아오면 걸린 ms (안 돌아오면 ms 는 null)
  const letGo = async (win) => {
    mouseTo(win, 10, 10);
    const t0 = Date.now();
    let s = await stats(win);
    while (Date.now() - t0 < 7000) {
      if (s.lid <= s.restLid + 0.005 && s.content < 0.05) return { ms: Date.now() - t0, lid: fix3(s.lid), restLid: s.restLid, mood: s.mood };
      await sleep(60);
      s = await stats(win);
    }
    return { ms: null, lid: fix3(s.lid), restLid: s.restLid, mood: s.mood };
  };

  console.log('\n[4c] 쓰다듬는 눈 — 어느 부위든 끝까지 감고, 손을 떼면 뜬다');
  {
    // 부위 몫(zmix): 0 이마, 1 턱·볼, 2 등, 3 엉덩이, 4 그 밖의 몸(꼬리도)
    const KIND = { head: 0, chin: 1, back: 2, rump: 3, body: 4, tail: 4 };
    const { win, segs } = await sit({}, { tolMax: 1e6, warn: 1e6, cool: 1e6, greetP: 0, spontP: 0, rippleP: 0 });
    const zones = Object.keys(KIND);
    ok(zones.every((z) => segs[z] && segs[z].len >= 150), '회색 고양이에 쓰다듬을 부위가 다 있다 (토막 길이는 텍스처 px)', Object.fromEntries(zones.map((z) => [z, segs[z] && segs[z].len])));
    for (const z of zones.filter((q) => segs[q])) {
      const tClosed = await strokeToClosed(win, segs[z]);
      await js(win, SMP_ON);
      await strokeFor(win, segs[z], 1400);
      const rows = await js(win, SMP_OFF);
      const s = await stats(win);
      const low = rows.length ? Math.min(...lidOf(rows)) : 0;
      const inZone = rows.filter((r) => r.zone === z).length / Math.max(1, rows.length);
      ok(tClosed !== null && rows.length >= 15 && low >= 0.99 && inZone >= 0.9 && s.petting && s.zmix[KIND[z]] > 0.5,
        `${z}: 쓰다듬으면 끝까지 감고(0.99 이상) 쓰는 동안 그대로 머문다 (예전엔 0.875, 엉덩이 0.75 에서 멈췄다)`,
        { tClosed, low: fix3(low), inZone: +inZone.toFixed(2), petting: s.petting, zmix: s.zmix });
      const g = await letGo(win);
      ok(g.ms !== null && g.lid <= 0.005, `${z}: 손을 떼면 쉬는 꺼풀(0)로 돌아온다`, g);
    }

    // 경고 — 손이 계속 쓸어도 눈을 번쩍 뜬다 (만지는 동안에만 경고가 머문다)
    {
      const tClosed = await strokeToClosed(win, segs.head);
      await js(win, 'window.__h.debug.mood("warning")');
      await js(win, SMP_ON);
      await strokeFor(win, segs.head, 1500);
      const rows = await js(win, SMP_OFF);
      const opened = rows.find((r) => r.lid < 0.1);
      const tail = rows.filter((r) => r.t >= 1000);
      ok(tClosed !== null && opened && opened.t <= 900 && tail.length >= 5 && tail.every((r) => r.mood === 'warning') && median(lidOf(tail)) < 0.02,
        '경고에 들면 쓰다듬는 중에도 0.9초 안에 눈을 뜬다', { tClosed, openedAt: opened && Math.round(opened.t), tail: tail.length ? fix3(median(lidOf(tail))) : null, mood: tail.length ? tail[tail.length - 1].mood : null });
      // 손을 떼고 WARN_QUIT(1.2초) 넘게 기다린다 — 쉼으로 가라앉아야 다음 판이 기분 좋은 데서 시작한다
      mouseTo(win, 10, 10);
      await sleep(1600);
      const g = await letGo(win);
      ok(g.ms !== null && g.lid <= 0.005 && g.mood === 'calm', '손을 떼면 경고가 가라앉고 눈은 뜬 그대로다', g);
    }
    // 화남 — 가늘게 뜬 채(칸 3) 머문다. 깜박임이 낀 몇 장을 빼면 쓰다듬어도 그대로다
    {
      const tClosed = await strokeToClosed(win, segs.head);
      await js(win, 'window.__h.debug.mood("annoyed")');
      await js(win, SMP_ON);
      await strokeFor(win, segs.head, 3000);
      const rows = await js(win, SMP_OFF);
      const tail = rows.filter((r) => r.t >= 1300);
      const near = tail.filter((r) => Math.abs(r.lid - 0.375) < 0.01).length / Math.max(1, tail.length);
      const low = tail.length ? Math.min(...lidOf(tail)) : 0;
      ok(tClosed !== null && tail.length >= 15 && near >= 0.7 && low >= 0.365,
        '화나면 가늘게(0.375) 뜬 채 쓰다듬어도 안 감는다', { tClosed, median: tail.length ? fix3(median(lidOf(tail))) : null, near: +near.toFixed(2), low: fix3(low), mood: tail.length ? tail[tail.length - 1].mood : null });
    }
    win.destroy();

    // 친밀도가 높은 고양이 — 쉴 때 꺼풀 한 칸(0.125)은 그대로, 쓰다듬으면 끝까지 감고 그 칸으로 돌아온다. 눈인사도 끝까지 감았다 그 칸으로
    {
      const { win, segs } = await sit({ grey: { affinity: 0.9, today: 0, daysAway: 0 } }, { tolMax: 1e6, greetP: 1, spontP: 0, greetCool: 0, rippleP: 0 });
      const t0 = Date.now();
      let s = await stats(win);
      while (Date.now() - t0 < 6000 && !(s.restLid === 0.125 && Math.abs(s.lid - 0.125) < 0.001)) { await sleep(60); s = await stats(win); }
      ok(s.restLid === 0.125 && Math.abs(s.lid - 0.125) < 0.001, '친밀도 0.9 — 쉴 때 꺼풀이 한 칸(0.125) 내려와 있다', { restLid: s.restLid, lid: fix3(s.lid) });
      const face = await js(win, '(() => { const c = window.__h.debug.rig().head.faceCenter; return window.__h.debug.where(c[0], c[1]); })()');
      mouseTo(win, 10, 10);
      await sleep(150);
      mouseTo(win, face[0], face[1]);
      await js(win, SMP_ON);
      const t1 = Date.now();
      s = await stats(win);
      while (Date.now() - t1 < 7000 && !(s.greetings > 0 && !s.greeting)) { await sleep(60); s = await stats(win); }
      const rows = await js(win, SMP_OFF);
      const inGreet = rows.filter((r) => r.greeting);
      const peak = inGreet.length ? Math.max(...lidOf(inGreet)) : 0;
      ok(s.greetings === 1 && peak >= 0.98, '얼굴 앞에 머문 커서에 눈인사 — 끝까지 감았다 뜬다', { greetings: s.greetings, peak: fix3(peak) });
      const tClosed = await strokeToClosed(win, segs.head);
      const g = await letGo(win);
      ok(tClosed !== null && g.ms !== null && Math.abs(g.lid - 0.125) < 0.006, '쓰다듬으면 끝까지 감고, 손을 떼면 0 이 아니라 쉬는 칸(0.125)으로 돌아온다', { tClosed, ...g });
      win.destroy();
    }
  }

  console.log('\n[4d] 손 모양 커서 — 고양이 위에서만, 단추는 화살표');
  {
    // 휴식 창 그대로(__begin) 앉히되 리그에 debug 만 켠다 — 부위·자리를 물으려고. 브라우저가 실제로 정한 커서도 받아 둔다(cursor-changed).
    // Electron 은 화살표를 'pointer', CSS 의 pointer(손가락)를 'hand' 라고 부른다
    const sitReal = async (clipId, extra) => {
      const win = await overlay(1920, 1080);
      const m = { win, real: null };
      win.webContents.on('cursor-changed', (_e, t) => { m.real = t; });
      await js(win, '(() => { const R = window.nunsCatRig, f = R.mount; R.mount = (h, o) => f(h, { ...o, debug: true }); })()');
      await js(win, `window.__begin(${JSON.stringify(pay(clipId, { durationSec: 120, endsAt: Date.now() + 120000, ...extra }))})`);
      m.s = await js(win, RIG_STATE);
      return m;
    };
    // 자리 — 화면 자리는 리그에 묻지 않고 캔버스 자리·거울에서 직접 잰다. 빈 곳·빈틈은 사진 알파(base.webp)와 메시 칸(rig.json grid)으로 고른다 —
    // 리그의 부위 지도로 고르면 알파 지도가 망가진 것을 못 본다.
    //   zones: 부위마다 가장 긴 토막의 가운데, empty: 상자 안 메시 밖에서 털과 가장 먼 곳, gap: 메시 칸은 찼는데 털은 없는 곳(칸 안 투명 여백)
    //   flip: 거울 고양이만 — 고양이 위인 텍스처 자리의, 화면 자리(on)와 거울을 안 풀면 잘못 갈 자리(off, 실제로는 빈 곳)
    const MAP = `(async () => {
      const c = window.nunsEnter.rigNow(), h = c.handle, rig = h.debug.rig(), cfg = h.debug.cfg(), W = cfg.world, zoneAt = h.debug.zone;
      const cv = c.box.querySelector('canvas'), b = cv.getBoundingClientRect();
      const mirror = getComputedStyle(cv).scale === '-1 1';
      const U = (x) => (x - W.x0) / W.w;
      const sx = (x) => b.left + (mirror ? 1 - U(x) : U(x)) * b.width, sy = (y) => b.top + (y - W.y0) / W.h * b.height;
      const scr = (x, y) => [sx(x), sy(y)];
      const im = new Image(); im.src = window.nunsClip.RIG_DIR + c.id + '/base.webp'; await im.decode();
      const cn = document.createElement('canvas'); cn.width = rig.size.w; cn.height = rig.size.h;
      const g = cn.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      const A = g.getImageData(0, 0, rig.size.w, rig.size.h).data, sw = rig.size.w, sh = rig.size.h;
      const clear = (x, y, r) => {
        for (let j = Math.max(0, y - r); j <= Math.min(sh - 1, y + r); j += 2) for (let i = Math.max(0, x - r); i <= Math.min(sw - 1, x + r); i += 2) if (A[(j * sw + i) * 4 + 3] > 16) return false;
        return true;
      };
      const G = rig.grid, filled = (x, y) => { const i = Math.floor(x * G.cols / sw), j = Math.floor(y * G.rows / sh); return i >= 0 && j >= 0 && i < G.cols && j < G.rows && ((parseInt(G.cells[j][i >> 2], 16) >> (3 - (i & 3))) & 1) === 1; };
      const runs = {};
      for (let y = 2; y < sh; y += 4) {
        let cur = 'none', x0 = 0;
        for (let x = 2; x <= sw + 4; x += 4) {
          const z = x < sw ? zoneAt(x, y) : 'none';
          if (z === cur) continue;
          if (cur !== 'none' && (!runs[cur] || x - x0 > runs[cur].len)) runs[cur] = { len: x - x0, x: Math.round((x0 + x) / 2), y };
          cur = z; x0 = x;
        }
      }
      const zones = {};
      for (const [z, r] of Object.entries(runs)) zones[z] = scr(r.x, r.y);
      const best = (want, rs) => {
        for (const r of rs) for (let y = 8; y < sh; y += 8) for (let x = 8; x < sw; x += 8) if (want(x, y) && clear(x, y, r)) return { tex: [x, y], clear: r, at: scr(x, y) };
        return null;
      };
      const empty = best((x, y) => !filled(x, y), [80, 60, 40, 24]);
      // 둘레(±8)까지 찬 칸만 — 칸 가장자리면 커서 반올림으로 빈 칸에 떨어져, 알파 지도가 망가져도 화살표로 통과한다
      const gap = best((x, y) => [-8, 0, 8].every((d) => [-8, 0, 8].every((e) => filled(x + d, y + e))), [24, 20, 16, 12]);
      let flip = null;
      if (mirror) {
        // 그 자리 둘레(±16)가 다 고양이 위이고, 거울 자리 둘레가 다 빈 곳인 텍스처 자리 중 가운데 것
        const around = (x, y, f) => [-16, 0, 16].every((d) => [-16, 0, 16].every((e) => f(zoneAt(x + d, y + e))));
        const mx = (x) => W.x0 + W.w - (x - W.x0);
        const all = [];
        for (let y = 8; y < sh; y += 8) for (let x = 8; x < sw; x += 8) if (A[(y * sw + x) * 4 + 3] > 128 && around(x, y, (z) => z !== 'none') && around(mx(x), y, (z) => z === 'none')) all.push([x, y]);
        const p = all[all.length >> 1];
        if (p) flip = { tex: p, n: all.length, zone: zoneAt(p[0], p[1]), on: scr(p[0], p[1]), off: [b.left + U(p[0]) * b.width, sy(p[1])], where: h.debug.where(p[0], p[1]) };
      }
      const R = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
      return { id: c.id, mirror, hit: cfg.on.hit, box: [b.left, b.top, b.right, b.bottom], zones, empty, gap, flip, headline: R('headline'), skip: R('btn-skip') };
    })()`;
    const look = (m, [x, y]) => js(m.win, `(() => {
      const e = document.elementFromPoint(${x}, ${y}), c = window.nunsEnter.rigNow();
      const s = c && c.handle ? c.handle.debug.stats() : null;
      return { el: e && (e.id || e.className || e.tagName), inBtn: !!(e && e.closest('button')), cursor: e && getComputedStyle(e).cursor, body: document.body.style.cursor, hand: s && s.hand, zone: s && s.zone };
    })()`);
    // 진짜 커서를 보낸다 — 리그가 다음 tick 에 읽으니 body 가 바라는 값이 될 때까지(1.5초까지) 기다려, 잠깐 뒤에도 그대로인지 본다.
    // 브라우저 커서는 마우스 이벤트 때 다시 정한다(보이지 않는 창) — 제자리 이벤트를 다시 넣어 받는다
    const hover = async (m, p, body, real) => {
      mouseTo(m.win, p[0], p[1]);
      const t0 = Date.now();
      let r = await look(m, p);
      while (r.body !== body && Date.now() - t0 < 1500) { await sleep(40); r = await look(m, p); }
      await sleep(120);
      r = await look(m, p);
      const t1 = Date.now();
      while (m.real !== real && Date.now() - t1 < 1000) { mouseTo(m.win, p[0], p[1]); await sleep(60); }
      r.real = m.real;
      return r;
    };
    const isHand = (r) => r.body === 'grab' && r.cursor === 'grab' && r.hand === true && r.real === 'grab';
    const isArrow = (r) => r.body === '' && r.cursor === 'default' && !r.hand && r.real === 'pointer';
    const handAt = (m, p) => hover(m, p, 'grab', 'grab');
    const arrowAt = (m, p) => hover(m, p, '', 'pointer');
    const inBox = (m, p) => p[0] > m.box[0] && p[0] < m.box[2] && p[1] > m.box[1] && p[1] < m.box[3];

    // 회색 고양이 — 부위마다 손, 빈 곳·글·단추는 화살표 (빈 곳은 손에서 옮겨 간다 — 되돌리는지까지 보려고)
    {
      const m = await sitReal('cat-rb');
      const map = await js(m.win, MAP);
      m.box = map.box;
      const back = map.zones.back;
      const parts = ['head', 'chin', 'earL', 'earR', 'back', 'rump', 'body', 'tail'];
      ok(parts.every((z) => map.zones[z]) && map.mirror === false, '회색 고양이의 부위가 다 있다', Object.keys(map.zones));
      for (const z of parts.filter((q) => map.zones[q])) {
        const r = await handAt(m, map.zones[z]);
        ok(isHand(r) && r.zone === z && r.el !== 'CANVAS', `${z} 위 — 손 모양 (요소는 고양이 위를 덮은 ${r.el}, 브라우저 커서 ${r.real})`, r);
      }
      const spots = [['상자 안 빈 곳', map.empty && map.empty.at], ['창 구석', [20, 20]], ['안내 글', map.headline], ['단추', map.skip]];
      for (const [name, p] of spots) {
        await handAt(m, back);
        const r = p ? await arrowAt(m, p) : {};
        ok(isArrow(r) && r.zone === 'none', `${name} — 화살표 (고양이에서 옮겨 오면 되돌린다)`, r);
      }
      ok(map.empty && inBox(m, map.empty.at), '그 빈 곳은 고양이 상자 안이다', map.empty);

      // 고양이 상자 안 단추 — 앱에서는 안 겹치게 앉으므로(시험 [3]) 단추를 고양이 위로 옮겨 본다. 리그는 손이어도 단추 위 커서는 화살표다
      await js(m.win, `(() => { const b = document.getElementById('btn-finish'), r = b.getBoundingClientRect();
        b.style.transform = 'translate(' + (${back[0]} - (r.left + r.width / 2)) + 'px,' + (${back[1]} - (r.top + r.height / 2)) + 'px)'; })()`);
      const onBtn = await hover(m, back, 'grab', 'pointer');
      ok(onBtn.inBtn && onBtn.body === 'grab' && onBtn.hand === true && onBtn.zone === 'back' && onBtn.cursor === 'default' && onBtn.real === 'pointer' && inBox(m, back),
        '고양이 상자 안, 고양이 위여도 단추 위는 화살표다 (body 는 손이어도 단추는 제 커서)', onBtn);
      await js(m.win, 'document.getElementById("btn-finish").style.transform = ""');
      const offBtn = await handAt(m, back);
      ok(isHand(offBtn) && !offBtn.inBtn, '단추를 치우면 같은 자리가 손 모양이다', offBtn);

      // 쉬기 — 바로 되돌리고, 쉬는 동안 커서가 움직여도 그대로. 깨면 다시 손
      const paused = await js(m.win, '(() => { const h = window.nunsEnter.rigNow().handle; h.pause(); return { body: document.body.style.cursor, hand: h.debug.stats().hand }; })()');
      const stillOff = await hover(m, map.zones.rump, '', 'pointer');
      ok(paused.body === '' && paused.hand === false && isArrow(stillOff), 'pause — 그 자리에서 body 커서를 되돌리고, 쉬는 동안 고양이 위를 지나도 손이 안 된다', { paused, stillOff });
      await js(m.win, 'window.nunsEnter.rigNow().handle.resume()');
      const back2 = await handAt(m, back);
      ok(isHand(back2), 'resume — 고양이 위면 다시 손 모양', back2);
      // 휴식 끝 신호(메인 endBreak → overlay:ending → pause) — 창을 숨기는 동안 손이 남지 않는다
      m.win.webContents.send('overlay:ending');
      const t2 = Date.now();
      let endBody = 'grab';
      while (endBody !== '' && Date.now() - t2 < 1500) { await sleep(40); endBody = await js(m.win, 'document.body.style.cursor'); }
      ok(endBody === '', '휴식 끝 신호 — body 커서를 되돌린다', endBody);
      await js(m.win, 'window.nunsEnter.rigNow().handle.resume()');
      await handAt(m, back);

      // 창 밖으로 나가면 — 손을 거둔다 (다른 모니터로 간 커서)
      await js(m.win, 'window.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null }))');
      const t3 = Date.now();
      let outBody = 'grab';
      while (outBody !== '' && Date.now() - t3 < 1500) { await sleep(40); outBody = await js(m.win, 'document.body.style.cursor'); }
      ok(outBody === '', '커서가 창 밖으로 나가면 손을 거둔다', outBody);
      // 고양이 위 move 바로 뒤에 나가도(진짜 입력) — tick 이 아직 못 읽은 move 로 손이 되살아나지 않는다. 돌아오면 다시 손
      let stuck = 0;
      for (let i = 1; i <= 4; i++) {
        const x = back[0] + i * 8;
        mouseTo(m.win, x, back[1]);
        m.win.webContents.sendInputEvent({ type: 'mouseLeave', x: Math.round(x / 2), y: Math.round(back[1] / 2) });
        await sleep(300);
        if (await js(m.win, 'document.body.style.cursor') !== '') stuck++;
      }
      const reIn = await handAt(m, back);
      ok(stuck === 0 && isHand(reIn), '고양이 위에서 움직이자마자 창 밖으로 나가도 손이 남지 않고, 돌아오면 다시 손 모양이다', { stuck, reIn });

      // 손가락 — 대고 쓰는 동안 손, 떼면(쓸기) 거둔다 (다음 커서가 올 때까지 남지 않게)
      const finger = await js(m.win, `(async () => {
        const ev = (t, x, y) => window.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
        const X = ${back[0]}, Y = ${back[1]}, body = () => document.body.style.cursor;
        ev('pointerdown', X, Y);
        let on = '';
        for (let i = 0; i < 30 && on !== 'grab'; i++) { ev('pointermove', X + i * 2, Y); await new Promise((q) => setTimeout(q, 40)); on = body(); }
        ev('pointerup', X + 40, Y);
        let off = on;
        for (let i = 0; i < 30 && off !== ''; i++) { await new Promise((q) => setTimeout(q, 40)); off = body(); }
        return { on, off };
      })()`);
      ok(finger.on === 'grab' && finger.off === '', '손가락 — 고양이 위를 쓰는 동안 손, 떼면 거둔다', finger);
      // 톡 — 대는 사이 살짝 떨려(move) 손이 됐어도 떼면 거둔다. 톡으로 잡혔는지(pokes)까지 본다 — 쓸기로 잡히면 이 갈래를 안 지난다
      const tap = await js(m.win, `(async () => {
        const ev = (t, x, y) => window.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true }));
        const X = ${back[0]}, Y = ${back[1]}, body = () => document.body.style.cursor, h = window.nunsEnter.rigNow().handle;
        const before = h.debug.stats().pokes;
        ev('pointerdown', X, Y);
        ev('pointermove', X + 3, Y);
        let during = '';
        for (let i = 0; i < 6 && during !== 'grab'; i++) { await new Promise((q) => setTimeout(q, 40)); during = body(); }
        ev('pointerup', X + 3, Y);
        await new Promise((q) => setTimeout(q, 150));
        let off = body();
        for (let i = 0; i < 30 && off !== ''; i++) { await new Promise((q) => setTimeout(q, 40)); off = body(); }
        return { during, off, pokes: h.debug.stats().pokes - before };
      })()`);
      ok(tap.during === 'grab' && tap.off === '' && tap.pokes === 1, '손가락 톡 — 살짝 떨렸어도 떼면 손을 거둔다', tap);

      // 걷기 — body 커서를 되돌린다. 걷은 뒤 고양이 자리를 지나도 손이 안 된다
      await handAt(m, back);
      const gone = await js(m.win, '(() => { window.nunsEnter.rigNow().destroy(); return { body: document.body.style.cursor, now: window.nunsEnter.rigNow() }; })()');
      const after = await hover(m, back, '', 'pointer');
      ok(gone.body === '' && gone.now === null && isArrow(after), 'destroy — body 커서를 되돌리고, 그 뒤 고양이 자리는 화살표다', { gone, after });
      m.win.destroy();
    }

    // GPU 를 잃으면 — 정지 그림으로 물러나며 커서를 듣지 않으니 손을 거둔다
    {
      const m = await sitReal('cat-rb');
      const map = await js(m.win, MAP);
      m.box = map.box;
      const on = await handAt(m, map.zones.back);
      const lost = await js(m.win, `(async () => {
        const cv = window.nunsEnter.rigNow().box.querySelector('canvas');
        (cv.getContext('webgl2') || cv.getContext('webgl')).getExtension('WEBGL_lose_context').loseContext();
        for (let i = 0; i < 40 && document.body.style.cursor !== ''; i++) await new Promise((q) => setTimeout(q, 50));
        return { body: document.body.style.cursor, canvas: !!window.nunsEnter.rigNow().box.querySelector('canvas'), hand: window.nunsEnter.rigNow().handle.debug.stats().hand };
      })()`);
      mouseTo(m.win, map.zones.head[0], map.zones.head[1]);
      await sleep(250);
      const still = await js(m.win, 'document.body.style.cursor');
      ok(isHand(on) && lost.body === '' && lost.hand === false && !lost.canvas && still === '', 'WebGL 을 잃으면 — body 커서를 되돌리고, 그 뒤 커서가 고양이 위를 지나도 그대로다', { lost, still });
      m.win.destroy();
    }

    // 창 크기가 바뀌면 — 커서를 안 움직여도 옛 부위로 손이 남지 않는다. 자리가 그대로인 transitionend 는 끊지 않는다(쓸기가 안 끊기게)
    {
      const m = await sitReal('cat-rb');
      const map = await js(m.win, MAP);
      m.box = map.box;
      const on = await handAt(m, map.zones.back);
      const same = await js(m.win, `(async () => {
        window.nunsEnter.rigNow().box.querySelector('canvas').dispatchEvent(new Event('transitionend'));
        await new Promise((q) => setTimeout(q, 300));
        return document.body.style.cursor;
      })()`);
      m.win.setContentSize(672, 378);
      const t0 = Date.now();
      let r = await look(m, map.zones.back);
      while (r.body !== '' && Date.now() - t0 < 1500) { await sleep(40); r = await look(m, map.zones.back); }
      ok(isHand(on) && same === 'grab' && r.body === '' && !r.hand, '창 크기가 바뀌면 손을 거둔다 (자리가 그대로면 안 끊는다)', { same, r });
      const map2 = await js(m.win, MAP);
      m.box = map2.box;
      const on2 = await handAt(m, map2.zones.back);
      ok(isHand(on2), '바뀐 자리의 고양이 위에서 다시 손 모양이다', { at: map2.zones.back, on2 });
      m.win.destroy();
    }

    // 체크 줄 — 단추처럼 눌리는 자리라 고양이 위여도 화살표다. 겹치는 화면이 드물어(768×1024, 7줄 이상) 줄을 고양이 위로 옮겨 본다
    {
      const p = breakwin.buildBreakPayload(['stretch', 'eye']);
      const m = await sitReal('cat-rb', { mode: p.mode, grouped: p.grouped, items: p.items });
      const map = await js(m.win, MAP);
      m.box = map.box;
      const back = map.zones.back;
      await js(m.win, `(() => { const e = document.querySelector('.list .item'), r = (e.style.animation = 'none', e.getBoundingClientRect());
        e.style.transform = 'translate(' + (${back[0]} - (r.left + r.width / 2)) + 'px,' + (${back[1]} - (r.top + r.height / 2)) + 'px)'; })()`);
      const r = await hover(m, back, 'grab', 'pointer');
      const onItem = await js(m.win, `!!document.elementFromPoint(${back[0]}, ${back[1]}).closest('.list .item')`);
      ok(onItem && r.body === 'grab' && r.hand === true && r.zone === 'back' && r.cursor === 'default' && r.real === 'pointer', '고양이 위 체크 줄은 화살표다 (body 는 손이어도 줄은 제 커서)', { onItem, r });
      m.win.destroy();
    }

    // 알파 지도가 있는 고양이 — 메시 칸은 찼어도 털이 없는 빈틈은 화살표. 거울 고양이는 화면 자리에서 손이 된다
    for (const rigId of ['grey', 'cat-lie', 'cat-black']) {
      const m = await sitReal(firstClip(rigId));
      const map = await js(m.win, MAP);
      m.box = map.box;
      const want = !!(rigs[rigId].display && rigs[rigId].display.mirror);
      ok(map.hit === true && map.mirror === want && map.gap && inBox(m, map.gap.at), `${rigId}: 알파 지도를 켰고(거울 ${want}), 메시 칸 안의 털 없는 자리가 있다`, { hit: map.hit, mirror: map.mirror, gap: map.gap });
      for (const z of ['head', 'earL', 'earR', 'back']) {
        const r = await handAt(m, map.zones[z]);
        ok(isHand(r) && r.zone === z, `${rigId}: ${z} 위 — 손 모양`, r);
      }
      if (map.gap) {
        const r = await arrowAt(m, map.gap.at);
        ok(isArrow(r) && r.zone === 'none', `${rigId}: 고양이 옆 빈틈(칸은 찼는데 털 ${map.gap.clear}px 안에 없다) — 화살표`, { r, gap: map.gap });
      }
      if (want) {
        ok(map.flip && Math.abs(map.flip.where[0] - map.flip.on[0]) < 1 && Math.abs(map.flip.where[1] - map.flip.on[1]) < 1, `${rigId}: 캔버스 자리·거울로 잰 화면 자리가 리그의 자리와 같다`, map.flip);
        if (map.flip) {
          const a = await handAt(m, map.flip.on);
          ok(isHand(a) && a.zone === map.flip.zone, `${rigId}: 거울로 보이는 화면 자리에서 손 모양`, { a, tex: map.flip.tex, at: map.flip.on });
          const c = await arrowAt(m, map.flip.off);
          ok(isArrow(c) && c.zone === 'none', `${rigId}: 거울을 안 풀었을 때의 자리(실제로는 빈 곳)는 화살표`, { c, at: map.flip.off });
        }
      }
      m.win.destroy();
    }
  }

  console.log('\n[4e] 끊어 쓰다듬는 눈 — 손을 멈춰도 감은 채, 손이 떠나면 한 번에 뜬다');
  {
    const KEEP = 3000;   // catrig.js LID_KEEP (ms) — 마지막 손길에서 이만큼 눈을 안 뜬다
    const CALM = { tolMax: 1e6, warn: 1e6, cool: 1e6, greetP: 0, spontP: 0, rippleP: 0 };
    const sstep = (c) => c * c * (3 - 2 * c);
    // 깜박임은 꺼풀을 눈 몫·쉬는 칸보다 올리기만 한다 — 그 표본을 빼면 눈 몫이 움직인 길만 남는다
    const noBlink = (rows) => rows.filter((r) => r.lid <= Math.max(sstep(r.eyeC), r.restLid, 0.375 * r.ak) + 0.005);
    const midOf = (rows) => rows.filter((r) => r.lid >= 0.35 && r.lid <= 0.85).length;
    const minLid = (rows) => (rows.length ? Math.min(...lidOf(rows)) : 0);
    // 다 감은 뒤 처음 내려갈 때까지
    const shutOf = (rows) => { const i = rows.findIndex((r) => r.lid < 0.99); return i < 0 ? rows : rows.slice(0, i); };
    // 뜨는 길 — 언제 내려가기 시작해 언제 쉬는 꺼풀에 닿나, 깜박임을 빼면 내려가기만 하나(up: 가장 크게 되오른 값)
    const opening = (rows) => {
      const i = rows.findIndex((r) => r.lid < 0.99);
      const tail = i < 0 ? [] : noBlink(rows.slice(i));
      let up = 0;
      for (let k = 1; k < tail.length; k++) up = Math.max(up, tail[k].lid - tail[k - 1].lid);
      const end = tail.find((r) => r.lid <= r.restLid + 0.005);
      return { from: i < 0 ? null : Math.round(rows[i].t), end: end ? Math.round(end.t) : null, up: fix3(up), last: tail.length ? fix3(tail[tail.length - 1].lid) : null };
    };
    // 뒤로 — 마지막 손길에서 KEEP 쯤에 내려가기 시작해 한 번에 쉬는 꺼풀까지 (뜨는 데 2.5초쯤 — 합 5.5초)
    const opensOnce = (o) => o.from !== null && o.from >= KEEP - 200 && o.from <= KEEP + 700 && o.end !== null && o.end >= KEEP + 1000 && o.end <= 7000 && o.up <= 0.01;
    // 한쪽으로만 간다 — 되돌아오지 않으니 쓸기로 안 잡힌다. dir 1 은 토막 왼쪽 끝에서 오른쪽 끝으로
    const pass = async (win, seg, dir, ms) => {
      const t0 = Date.now();
      for (;;) {
        const u = Math.min(1, (Date.now() - t0) / ms);
        mouseTo(win, seg.x + dir * seg.amp * (2 * u - 1), seg.y);
        if (u >= 1) return;
        await sleep(16);
      }
    };
    const leave = (win, x, y) => win.webContents.sendInputEvent({ type: 'mouseLeave', x: Math.round(x / 2), y: Math.round(y / 2) });
    const facePos = (win) => js(win, '(() => { const c = window.__h.debug.rig().head.faceCenter; return window.__h.debug.where(c[0], c[1]); })()');
    // 초당 tick·그린 장 — 다른 창이 도는 동안에도 이 창의 몫만 센다
    const rate = (win, ms) => js(win, `(async () => {
      const h = window.__h, a = h.debug.stats(), t0 = performance.now();
      await new Promise((q) => setTimeout(q, ${ms}));
      const b = h.debug.stats(), k = 1000 / (performance.now() - t0);
      return { ticks: +((b.ticks - a.ticks) * k).toFixed(1), draws: +((b.draws - a.draws) * k).toFixed(1), lv: b.lv.map((v, i) => v - a.lv[i]), lid: fix(b.lid), eyeC: fix(b.eyeC), content: fix(b.content) };
      function fix(v) { return +v.toFixed(3); }
    })()`);
    // 창마다 따로 잰다 — 거의 다 기다리는 시간이라 같이 돌려 시험 전체가 시간 제한(400초)을 넘지 않게 한다. 결과는 끝난 뒤 차례대로 적는다
    const together = async (...jobs) => {
      const logs = await Promise.all(jobs.map(async (job) => { const out = []; await job((c, m, x) => out.push([c, m, x])); return out; }));
      for (const log of logs) for (const [c, m, x] of log) ok(c, m, x);
    };

    // 사용자의 손길 — 쓸고(burst) 멈춘다(rest, 커서는 고양이 위 그 자리). 멈춘 자리에서 이어 쓴다 — 쉬고 나서 손이 뛰지 않게.
    // 왕복(period)이 짧으면 쓸 때마다 쓰다듬기로 다시 잡혀 content 가 오르내리고(옛 식이면 꺼풀도), 길면 한 번도 안 잡힌다 — 둘 다 본다.
    // oldMid: 옛 식(꺼풀 = content)이었다면 게슴츠레(0.35~0.85)에 든 표본 몫 — 이 손길이 정말 고치려던 손길인지 본다
    const rhythms = async (say) => {
      const { win, segs } = await sit({}, CALM);
      const tClosed = await strokeToClosed(win, segs.head);
      for (const [zone, burst, rest, period, wantOld] of [['head', 500, 1200, 450, 0.3], ['back', 500, 2000, 450, 0.1], ['rump', 1000, 2500, 900, 0.1], ['head', 500, 1200, 900, 0]]) {
        const seg = segs[zone], n = 3;
        let ph = 0;
        await js(win, SMP_ON);
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          while (Date.now() - t0 < burst) { mouseTo(win, seg.x + Math.sin(((ph + Date.now() - t0) / period) * Math.PI * 2) * seg.amp, seg.y); await sleep(16); }
          ph += burst;
          await sleep(rest);
        }
        const rows = await js(win, SMP_OFF);
        const old = rows.filter((r) => sstep(r.content) >= 0.35 && sstep(r.content) <= 0.85).length / Math.max(1, rows.length);
        const cMin = Math.min(...rows.map((r) => r.content));
        say(tClosed !== null && rows.length >= (burst + rest) * n / 60 && minLid(rows) >= 0.99 && midOf(rows) === 0 && cMin < 0.8 && old >= wantOld,
          `${zone} ${burst / 1000}초 쓸고 ${rest / 1000}초 쉬기 ${n}번 (왕복 ${period / 1000}초) — 눈은 내내 감은 채, 몸의 content 는 그대로 잦아든다`,
          { tClosed, n: rows.length, low: fix3(minLid(rows)), mid: midOf(rows), cMin: fix3(cMin), oldMid: +old.toFixed(2) });
      }
      win.destroy();
    };

    // 눈을 감은 채 손을 멈춘 동안 고개가 안 돈다 — 얼굴에서 먼 엉덩이를 쓸어 커서를 따라보면 크게 돌 자리에서 멈춘다.
    // 감은 동안 남는 고개 움직임은 쓰다듬던 자세(엉덩이는 strokeDir × 0.08 rad, |strokeDir| ≤ 1)가 content 를 따라 풀리는 것뿐이다 — 그 폭이 잣대다.
    // 재 보면 0.01~0.03 rad, 눈 몫 대신 content 를 빼면(고장) 커서·두리번을 따라 0.28~0.9 rad 돈다. 끄덕임은 엉덩이 자세에 없다(재 보면 0.01 rad, 고장 0.12~0.7)
    const headStill = async (say) => {
      const HEAD_YAW = 0.08, HEAD_PITCH = 0.04, HEAD_GAZE = 0.1;
      const { win, segs } = await sit({}, CALM);
      const seg = segs.rump, face = await facePos(win), far = seg.x > face[0] ? 1 : -1;
      const hold = async (name, stop, during, ms) => {
        const tClosed = await strokeToClosed(win, seg);
        await strokeFor(win, seg, 800);   // 쓰는 자세까지 가라앉힌다
        stop();
        await js(win, SMP_ON);
        if (during) await during();
        await sleep(ms);
        const rows = await js(win, SMP_OFF);
        const shut = shutOf(rows);
        const dev = (k) => (shut.length ? Math.max(...shut.map((r) => Math.abs(r[k] - shut[0][k]))) : 9);
        say(tClosed !== null && shut.length >= 50 && dev('yaw') <= HEAD_YAW && dev('pitch') <= HEAD_PITCH && dev('gazeX') <= HEAD_GAZE,
          `${name} — 눈을 감은 채 고개가 안 돈다 (고개 ${HEAD_YAW} rad·끄덕임 ${HEAD_PITCH} rad·눈동자 ${HEAD_GAZE} 안)`,
          { tClosed, shutMs: shut.length ? Math.round(shut[shut.length - 1].t) : null, yaw0: fix3(shut.length ? shut[0].yaw : 0), yaw: fix3(dev('yaw')), pitch: fix3(dev('pitch')), gazeX: fix3(dev('gazeX')) });
        return rows;
      };
      await hold('커서가 고양이 위에 멈춤', () => mouseTo(win, seg.x + far * seg.amp, seg.y), null, KEEP + 200);
      const off = await hold('커서가 고양이 밖으로 감', () => mouseTo(win, 10, 10), null, KEEP + 2400);
      const turned = Math.max(...off.filter((r) => r.lid < 0.5).map((r) => Math.abs(r.yaw)), 0);
      say(turned >= 0.25, '눈을 뜨고 나면 그 커서를 다시 따라본다 — 위 잣대가 헛돌지 않는다', { turned: fix3(turned) });
      // 창 밖 — 커서를 안 따르니 혼자 두리번 쪽이다. 3.5~8초를 기다리지 않고 멈춘 뒤 0.7초에 걸어 본다
      await hold('커서가 창 밖으로 나감', () => leave(win, seg.x, seg.y), async () => { await sleep(700); await js(win, 'window.__h.debug.drift(0.45, 0.2)'); }, KEEP - 500);
      win.destroy();
    };

    // 손가락 — 쓸 때마다 떼고(pointerup·pointerout), 쉬는 동안엔 손가락이 없다. 그래도 감은 채다
    const touch = async (say) => {
      const { win, segs } = await sit({}, CALM);
      const seg = segs.back;
      const r = await js(win, `(async () => {
        const h = window.__h, sleep = (ms) => new Promise((q) => setTimeout(q, ms));
        const X = ${seg.x}, Y = ${seg.y}, A = ${seg.amp};
        const ev = (t, x) => window.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: Y, bubbles: true }));
        const stroke = async (ms) => {
          ev('pointerdown', X - A);
          const t0 = performance.now();
          for (let u = 0; u < 1; u = (performance.now() - t0) / ms) { ev('pointermove', X - A + 2 * A * u); await sleep(16); }
          ev('pointermove', X + A); ev('pointerup', X + A); ev('pointerout', X + A);
        };
        const t0 = performance.now();
        let s = h.debug.stats();
        while (!(s.lid >= 0.99 && s.content >= 0.945) && performance.now() - t0 < 9000) { await stroke(320); await sleep(180); s = h.debug.stats(); }
        const tClosed = s.lid >= 0.99 && s.content >= 0.945 ? Math.round(performance.now() - t0) : null;
        ${SMP_ON};
        for (const rest of [1500, 1500, 1500, 2400, 2400]) { await stroke(400); await sleep(rest); }
        const rows = ${SMP_OFF};
        ${SMP_ON};
        await sleep(${KEEP + 900 - 2400});
        return { tClosed, rows, after: ${SMP_OFF} };
      })()`);
      const cMin = Math.min(...r.rows.map((q) => q.content));
      say(r.tClosed !== null && r.rows.length >= 150 && minLid(r.rows) >= 0.99 && midOf(r.rows) === 0 && cMin < 0.8,
        '손가락으로 0.4초 쓸고 떼고 1.5~2.4초 쉬기 — 눈은 내내 감은 채', { tClosed: r.tClosed, n: r.rows.length, low: fix3(minLid(r.rows)), mid: midOf(r.rows), cMin: fix3(cMin) });
      say(minLid(r.after) < 0.99, '손가락을 떼고 그대로 두면 3초 뒤 뜨기 시작한다', { last: fix3(r.after.length ? r.after[r.after.length - 1].lid : 1) });
      win.destroy();
    };

    // 지나가는 커서 · 쓰다 말고 멈춤 · 진짜로 떼기 — 차례대로 (앞 것이 눈을 다 뜬 뒤)
    const openClose = async (say) => {
      const { win, segs } = await sit({}, CALM);
      const seg = segs.back;
      await js(win, SMP_ON);
      await pass(win, seg, 1, 900);
      mouseTo(win, 10, 10);
      await sleep(1300);
      await pass(win, seg, -1, 900);
      mouseTo(win, 10, 10);
      await sleep(300);
      let rows = await js(win, SMP_OFF);
      say(rows.length >= 50 && Math.max(...rows.map((r) => r.eyeC)) === 0 && !rows.some((r) => r.petting || r.eyeOn) && noBlink(rows).every((r) => r.lid < 0.01),
        '쓰다듬기로 안 잡힌 채 지나가는 커서는 눈을 못 감긴다', { n: rows.length, eyeC: Math.max(...rows.map((r) => r.eyeC)), petting: rows.some((r) => r.petting) });

      // 쓰다듬기로 잡히자마자 멈춘다 — 그 자리(반쯤 감긴 채)에 서거나 되돌아가지 않고 끝까지 감은 뒤, 창이 끝나면 뜬다
      const t0 = Date.now();
      let s = await stats(win);
      while (!s.petting && Date.now() - t0 < 5000) { swing(win, seg, Date.now() - t0); await sleep(16); s = await stats(win); }
      await js(win, SMP_ON);
      await sleep(KEEP + 3400);
      rows = await js(win, SMP_OFF);
      const clean = noBlink(rows);
      const iUp = clean.findIndex((r) => r.lid >= 0.99);
      const rise = iUp < 0 ? clean : clean.slice(0, iUp);
      let down = 0;
      for (let k = 1; k < rise.length; k++) down = Math.max(down, rise[k - 1].lid - rise[k].lid);
      say(s.petting && rows.length >= 100 && clean.length > 0 && clean[0].lid < 0.5 && iUp >= 0 && clean[iUp].t <= 2600 && down <= 0.006,
        '감는 중에 손을 멈춰도 올라가기만 하고 끝까지 감는다', { lid0: clean.length ? fix3(clean[0].lid) : null, closedAt: iUp < 0 ? null : Math.round(clean[iUp].t), down: fix3(down) });
      const o = opening(iUp < 0 ? [] : rows.slice(rows.indexOf(clean[iUp])));
      say(opensOnce(o), '그 뒤 3초 창이 끝나면 한 번에 뜬다', o);

      // 진짜로 뗀다 — 마지막 손길부터 잰다
      const tClosed = await strokeToClosed(win, seg);
      await strokeFor(win, seg, 600);
      mouseTo(win, 10, 10);
      await js(win, SMP_ON);
      await sleep(7000);
      rows = await js(win, SMP_OFF);
      const g = opening(rows);
      say(tClosed !== null && rows.length >= 120 && minLid(rows.filter((r) => r.t < KEEP - 200)) >= 0.99 && opensOnce(g) && g.last <= 0.005 && midOf(noBlink(rows)) * 40 < 1000,
        '손을 떼면 3초 동안 감은 채, 그 뒤 쉬는 꺼풀(0)까지 되오르지 않고 한 번에 뜬다', { tClosed, ...g, midMs: midOf(noBlink(rows)) * 40 });
      win.destroy();
    };

    // 기분 — 붙든 동안 경고·화남·settle 이 오면 붙들지 않는다
    const moods = async (say) => {
      const { win, segs } = await sit({}, CALM);
      const seg = segs.back;

      // 경고 — 손을 멈춘 채 경고가 오면 0.9초 안에 뜨고, 가라앉은 뒤(WARN_QUIT) 손이 지나가도 혼자 다시 안 감는다
      let tClosed = await strokeToClosed(win, seg);
      mouseTo(win, seg.x - seg.amp, seg.y);   // 나중에 여기서 이어 간다 — 뛰어서 되돌아오면 왕복(쓰다듬기)으로 잡힌다
      await sleep(200);
      await js(win, 'window.__h.debug.mood("warning")');
      await js(win, SMP_ON);
      await sleep(1800);
      await pass(win, seg, 1, 700);
      await sleep(KEEP - 2200);
      let rows = await js(win, SMP_OFF);
      const opened = rows.find((r) => r.lid < 0.1);
      const calmed = rows.find((r) => r.mood === 'calm');
      const after = opened ? noBlink(rows.filter((r) => r.t > opened.t)) : [];
      say(tClosed !== null && opened && opened.t <= 900 && rows.some((r) => r.mood === 'warning'),
        '붙든 동안 경고가 오면 안 붙들고 0.9초 안에 뜬다', { tClosed, openedAt: opened && Math.round(opened.t), warned: rows.filter((r) => r.mood === 'warning').length });
      say(calmed && after.length >= 30 && after.every((r) => r.lid < 0.1) && !rows.some((r) => r.t > 150 && r.eyeOn) && rows[rows.length - 1].t >= 3000,
        '경고가 가라앉은 뒤에는 손이 다시 지나가도 혼자 안 감는다', { calmedAt: calmed && Math.round(calmed.t), most: after.length ? fix3(Math.max(...lidOf(after))) : null, eyeOn: rows.some((r) => r.t > 150 && r.eyeOn) });

      // 천천히 한쪽으로 다시 쓸면 창이 이어진다 — 쓰다듬기로 다시 잡히지 않아도 (멈춘 지 1.5초 + 2.6초 = 3초를 넘겨도 감은 채)
      tClosed = await strokeToClosed(win, seg);
      mouseTo(win, seg.x - seg.amp, seg.y);
      await js(win, SMP_ON);
      await sleep(1500);
      await pass(win, seg, 1, 2600);
      const restT = await js(win, 'window.__smp.length');
      await sleep(1000);
      rows = await js(win, SMP_OFF);
      say(tClosed !== null && restT >= 60 && rows[rows.length - 1].t >= KEEP + 1500 && minLid(rows) >= 0.99 && !rows.some((r) => r.t > 1200 && r.petting),
        '멈췄다가 천천히 한쪽으로 다시 쓸면 눈을 안 뜬다', { tClosed, ms: Math.round(rows[rows.length - 1].t), low: fix3(minLid(rows)), petting: rows.some((r) => r.t > 1200 && r.petting) });

      // settle — 붙든 동안 부르면 뜨며 돌아가고, 끝나면 눈 몫까지 0. resume 뒤 손이 지나가도 혼자 안 감는다
      tClosed = await strokeToClosed(win, seg);
      mouseTo(win, seg.x + seg.amp, seg.y);
      const st = await js(win, `(async () => {
        const h = window.__h, sleep = (ms) => new Promise((q) => setTimeout(q, ms));
        const pick = () => { const s = h.debug.stats(); return { lid: s.lid, eyeC: s.eyeC, eyeOn: s.eyeOn, content: s.content, settling: s.settling }; };
        await sleep(200);
        const before = pick();
        const done = h.settle(400);
        await sleep(200);
        const mid = pick();
        await done;
        await sleep(60);
        return { before, mid, end: pick() };
      })()`);
      say(tClosed !== null && st.before.lid >= 0.99 && st.before.eyeOn && !st.mid.eyeOn && st.mid.eyeC < st.before.eyeC && st.end.lid === 0 && st.end.eyeC === 0 && st.end.content === 0 && !st.end.eyeOn,
        'settle — 붙든 동안 불러도 안 붙들고, 끝나면 꺼풀·눈 몫이 0 이다', st);
      await js(win, 'window.__h.resume()');
      await js(win, SMP_ON);
      await sleep(900);
      await pass(win, seg, -1, 700);
      await sleep(KEEP - 1400);
      rows = await js(win, SMP_OFF);
      say(rows.length >= 50 && Math.max(...rows.map((r) => r.eyeC)) === 0 && noBlink(rows).every((r) => r.lid < 0.01),
        'resume 뒤 손이 지나가도 다시 감지 않는다', { n: rows.length, eyeC: Math.max(...rows.map((r) => r.eyeC)) });

      // 화남 — 맨 끝에 (외면이 안 끝나게 해 뒀다). 가늘게(0.375) 떠서 창이 끝날 때까지 그대로다
      tClosed = await strokeToClosed(win, seg);
      await sleep(200);
      await js(win, 'window.__h.debug.mood("annoyed")');
      await js(win, SMP_ON);
      await sleep(KEEP + 300);
      rows = await js(win, SMP_OFF);
      const tail = rows.filter((r) => r.t >= 1300);
      const near = tail.filter((r) => Math.abs(r.lid - 0.375) < 0.01).length / Math.max(1, tail.length);
      say(tClosed !== null && tail.length >= 30 && near >= 0.7 && minLid(tail) >= 0.365 && noBlink(tail).every((r) => r.lid < 0.39),
        '붙든 동안 화나면 안 붙들고 가늘게(0.375) 뜬 채 머문다', { tClosed, near: +near.toFixed(2), low: fix3(minLid(tail)), mood: rows.length ? rows[rows.length - 1].mood : null });
      win.destroy();
    };

    // 친밀도 0.9 — 쉬는 칸(0.125)으로 돌아오고, 눈인사는 붙든 동안 안 하고 뜬 뒤에 한다
    const fond = async (say) => {
      const { win, segs } = await sit({ grey: { affinity: 0.9, today: 0, daysAway: 0 } }, { tolMax: 1e6, greetP: 0, spontP: 0, rippleP: 0 });
      let tClosed = await strokeToClosed(win, segs.back);
      await strokeFor(win, segs.back, 600);
      mouseTo(win, 10, 10);
      await js(win, SMP_ON);
      await sleep(KEEP + 2400);
      let rows = await js(win, SMP_OFF);
      const g = opening(rows);
      say(tClosed !== null && minLid(rows.filter((r) => r.t < KEEP - 200)) >= 0.99 && g.from !== null && g.from >= KEEP - 200 && g.from <= KEEP + 700 && g.up <= 0.01 && Math.abs(g.last - 0.125) < 0.006 && noBlink(rows).every((r) => r.lid >= 0.12),
        '친밀도 0.9 — 3초 동안 감은 채, 뜨면 0 이 아니라 쉬는 칸(0.125)에 선다', { tClosed, ...g });

      // 눈인사 — 얼굴 앞에 멈춘 커서는 받을 자리다(greetP 1). 창 안에서 나갔다 들어와 먼저 건네기(spontP 1)도 건다.
      // 창이 끝난 뒤(3.5초) 다시 들어오면 content 는 거의 0 인데 눈은 아직 뜨는 중이다 — 여기서도 안 한다
      await js(win, 'window.__h.debug.moodCfg({ greetP: 1, spontP: 1, greetCool: 0 })');
      tClosed = await strokeToClosed(win, segs.head);
      const face = await facePos(win);
      const g0 = (await stats(win)).greetings;
      mouseTo(win, face[0], face[1]);
      await js(win, SMP_ON);
      for (const wait of [1000, 2400]) {
        await sleep(wait);
        leave(win, face[0], face[1]);
        await sleep(100);
        mouseTo(win, face[0], face[1]);
      }
      const t1 = Date.now();
      let s = await stats(win);
      while (Date.now() - t1 < 4500 && s.greetings === g0) { await sleep(60); s = await stats(win); }
      await sleep(120);   // 눈인사가 든 표본까지 적히게
      rows = await js(win, SMP_OFF);
      const i = rows.findIndex((r) => r.greetings > g0);
      const atFire = i > 0 ? rows[i - 1] : null;
      say(tClosed !== null && atFire !== null && atFire.eyeC < 0.07 && atFire.t >= KEEP + 1500,
        '붙든 동안·뜨는 중엔 눈인사를 안 한다 — 눈을 다 뜬 뒤에 한다', { tClosed, firedAt: atFire && Math.round(atFire.t), eyeC: atFire && fix3(atFire.eyeC), greetings: s.greetings - g0 });
      win.destroy();
    };

    // 값 — 쉬는 고양이 ↔ 붙든 고양이. 손을 멈추면 몸이 풀리는 4.3초(content)와 커서가 멈춘 뒤 2초는 tick 이 30fps 다(이 변경 전부터의 문턱) —
    // 그래도 눈은 이미 감겼고 몸만 조금 풀리니 그리는 장은 적다. 그 둘이 지난 뒤에도 눈이 붙들려 있는 자리(창 안에서 한쪽으로 다시 쓸었을 때)는
    // tick 까지 숨 빠르기다. 눈이 뜨는 동안은 30fps 로 돈다
    const cost = async (say) => {
      const { win, segs } = await sit({}, CALM);
      const seg = segs.back;
      const med = (rs, k) => median(rs.map((r) => r[k]));
      const mean = (rs, k) => +(rs.reduce((v, r) => v + r[k], 0) / rs.length).toFixed(1);
      const idle = [];   // 숨 한 번(2.7초) 남짓 — 그리는 장은 숨 어디쯤이냐에 따라 0~10장이다. tick 은 중앙값(깜박임 빼고), 그린 장은 평균으로 본다
      for (let i = 0; i < 6; i++) idle.push(await rate(win, 500));
      const tClosed = await strokeToClosed(win, seg);
      await strokeFor(win, seg, 800);
      mouseTo(win, seg.x - seg.amp, seg.y);   // 나중에 여기서 이어 간다 — 뛰어서 되돌아오면 왕복(쓰다듬기)으로 잡힌다
      const plain = await rate(win, 2600);
      await pass(win, seg, 1, 300);
      const shut = [];
      for (let k = 0; k < 3; k++) {
        await sleep(2150);
        shut.push(await rate(win, 350), await rate(win, 350));
        await pass(win, seg, k % 2 ? 1 : -1, 100);
      }
      await sleep(KEEP + 200);
      const open = await rate(win, 1000);
      say(tClosed !== null && plain.lid >= 0.99 && plain.draws <= 20,
        '손을 멈추고 붙든 3초 — 그리는 장은 30fps 에 안 붙는다 (tick 은 몸이 풀리는 동안 30fps)', plain);
      say(tClosed !== null && shut.every((r) => r.lid >= 0.99 && r.eyeC >= 0.99 && r.content < 0.01) && med(shut, 'ticks') <= med(idle, 'ticks') + 4 && med(shut, 'ticks') <= 22 && mean(shut, 'draws') <= mean(idle, 'draws') + 6,
        '몸이 다 풀린 뒤 눈만 붙든 동안은 쉬는 고양이처럼 숨 빠르기다 (초당 tick·그린 장)', { tClosed, idle: [med(idle, 'ticks'), mean(idle, 'draws')], shut: [med(shut, 'ticks'), mean(shut, 'draws')], lid: shut.map((r) => r.lid) });
      say(open.eyeC > 0.01 && open.eyeC < 0.9 && open.ticks >= 24,
        '눈이 뜨는 동안은 30fps — 꺼풀이 숨 빠르기로 뚝뚝 내려오지 않는다', open);
      win.destroy();
    };

    await together(rhythms, headStill, touch, cost);
    await together(openClose, moods, fond);
  }

  console.log('\n[5] 물러나기');
  const fallback = async (setup, opts, wantVideo) => {
    const win = await overlay(1920, 1080);
    const r = await js(win, `(async () => {
      const E = window.nunsEnter, C = window.nunsClip, host = document.getElementById('curtain');
      ${setup}
      const o = { purr: false, volume: 0, cats: {}, rigOf: (id) => window.nunsseom.catRig(id) };
      await E.play('cat', host, null, 20, { rig: o, ${opts} });
      let video = null;
      for (let i = 0; i < 80; i++) {
        await new Promise((q) => setTimeout(q, 100));
        video = host.querySelector('video.ent-clip');
        if (${wantVideo} ? video && video.readyState >= 2 : !host.querySelector('.ent-rig')) break;
      }
      await new Promise((q) => setTimeout(q, 300));
      return { video: host.querySelectorAll('video').length, ready: video ? video.readyState : -1, rig: host.querySelectorAll('.ent-rig, canvas').length,
        now: E.rigNow(), cls: host.className };
    })()`);
    win.destroy();
    return r;
  };
  const noGL = `const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, o) { return /webgl/.test(t) ? null : real.call(this, t, o); };`;
  const f1 = await fallback(noGL, '', true);
  ok(f1.video === 1 && f1.ready >= 2 && f1.rig === 0 && f1.now === null, 'WebGL 이 없으면(정지 그림 대신) 영상 고양이로 물러난다', f1);
  const f2 = await fallback(`const real = window.nunsseom.catRig; window.nunsseom.catRig = (id) => real(id === '__nope__' ? 'grey' : id);
      C.CLIPS.cat = { ...C.CLIPS.cat, rig: '__nope__' };`, '', true);
  ok(f2.video === 1 && f2.ready >= 2 && f2.rig === 0, '사진(base.webp)이 없으면 영상으로 물러난다', f2);
  const f3 = await fallback(`C.CLIPS.cat = { ...C.CLIPS.cat, rig: '__nope__' };`, '', true);
  ok(f3.video === 1 && f3.ready >= 2 && f3.rig === 0, 'rig.json 이 없으면(메인이 null) 영상으로 물러난다', f3);
  {
    const { win, s } = await begin(1920, 1080, pay('cat', { catRig: null }));
    const v = await js(win, `(async () => { const v = document.querySelector('#curtain video.ent-clip');
      for (let i = 0; i < 50 && v && v.readyState < 2; i++) await new Promise((q) => setTimeout(q, 100));
      return { video: !!v, ready: v ? v.readyState : -1, rig: document.querySelectorAll('#curtain .ent-rig').length }; })()`);
    ok(s.none && v.video && v.ready >= 2 && v.rig === 0, '«고양이 만지기»를 끄면(catRig 없음) 예전 영상 그대로', v);
    win.destroy();
  }

  console.log('\n[6] 기록 — 보낸 창과 값 거르기');
  {
    const win = await overlay(1920, 1080);
    const base = store.catRigStats();
    const baseCats = JSON.stringify(store.catRigCats());
    await js(win, `(() => {
      const n = window.nunsseom;
      for (const p of [null, 5, 'x', {}, { rig: 'nope', strokes: 3 }, { rig: 'grey', strokes: -1 }, { rig: 'grey', strokes: 1.5 }, { rig: 'grey', strokes: '5' },
        { rig: 'grey', strokes: 1e9 }, { rig: 'grey', strokes: NaN }, { rig: '__proto__', strokes: 3 }, { rig: '../grey', strokes: 3 }, { rig: 'grey' }]) n.catPet(p);
      for (const p of [null, { rig: 'grey', value: 1.5 }, { rig: 'grey', value: -0.1 }, { rig: 'grey', value: NaN }, { rig: 'grey', value: '0.5' },
        { rig: 'nope', value: 0.5 }, { rig: 'grey' }, { rig: 'constructor', value: 0.5 }]) n.catAffinity(p);
    })()`);
    await sleep(400);
    ok(JSON.stringify(store.catRigStats()) === JSON.stringify(base) && JSON.stringify(store.catRigCats()) === baseCats, '이상한 값은 모두 버린다 (store 그대로)');
    await js(win, `window.nunsseom.catPet({ rig: 'grey', strokes: 5, credited: 99 }); window.nunsseom.catAffinity({ rig: 'cat', value: 0.42 });`);
    await sleep(400);
    const a = store.catRigStats();
    const cc = store.catRigCats();
    ok(a.total === base.total + 5 && a.today === base.today + 5, '바른 값은 들어간다 — 오늘·모두 +5', { before: base.total, after: a.total });
    ok(cc.cat && cc.cat.affinity === 0.42 && cc.grey.today >= 5, '친밀도에 든 몫(credited)은 쓴 횟수로 묶는다, 친밀도는 그대로 저장', { cat: cc.cat, grey: cc.grey });
    win.destroy();

    // 휴식 창이 아닌 창 — 같은 다리를 쥐어도 기록·rig.json 을 못 건드린다
    const page = path.join(tmp, 'other.html');
    fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><body>남</body>');
    const other = new BrowserWindow({ show: false, width: 300, height: 200,
      webPreferences: { offscreen: true, preload: STUB, contextIsolation: false, sandbox: false } });
    await other.loadFile(page);
    const b2 = JSON.stringify(store.catRigStats());
    const got = await js(other, `(async () => { window.nunsseom.catPet({ rig: 'grey', strokes: 5, credited: 5 });
      window.nunsseom.catAffinity({ rig: 'grey', value: 1 }); return await window.nunsseom.catRig('grey'); })()`);
    await sleep(400);
    ok(JSON.stringify(store.catRigStats()) === b2 && got === null, '휴식 창이 아닌 창이 보낸 기록은 버리고, rig.json 도 안 준다', { rig: got });
    other.destroy();

    // 휴식 창 페이지(overlay.html)를 띄웠어도 메인이 띄운 이번 휴식의 창이 아니면 남이다 — 주소가 아니라 창으로 본다
    // (주소로 견주면 앱 경로에 8.3 짧은 이름·[ ] 가 들 때 진짜 휴식 창까지 남으로 쳤다)
    const stray = await overlay(1920, 1080, false);
    const b3 = JSON.stringify(store.catRigStats());
    const got3 = await js(stray, `(async () => { window.nunsseom.catPet({ rig: 'grey', strokes: 5, credited: 5 });
      return await window.nunsseom.catRig('grey'); })()`);
    await sleep(400);
    ok(JSON.stringify(store.catRigStats()) === b3 && got3 === null, '휴식 창 페이지여도 메인이 모르는 창이 보낸 기록은 버린다', { rig: got3 });
    stray.destroy();
  }

  console.log('\n[6b] 같은 고양이를 찍은 영상 — 기록은 한 고양이로');
  {
    ok(breakwin.catKey('cat-lie') === 'tabby-kitten' && breakwin.catKey('cat-roll') === 'tabby-kitten' && breakwin.catKey('grey') === 'grey' && breakwin.catKey('nope') === null,
      '엎드린·늘어진 아기 고양이는 rig.json 의 cat 이름 하나로 센다 — 나머지는 사진 폴더 이름', rigIds.map((id) => [id, breakwin.catKey(id)]));
    const win = await overlay(1920, 1080);
    const k0 = store.catRigStats().cats.find((c) => c.id === 'tabby-kitten');
    await js(win, `window.nunsseom.catPet({ rig: 'cat-lie', strokes: 2, credited: 2 }); window.nunsseom.catPet({ rig: 'cat-roll', strokes: 3, credited: 3 });`);
    await sleep(400);
    const st = store.catRigStats();
    const k1 = st.cats.find((c) => c.id === 'tabby-kitten');
    ok(k0 && k1 && k1.pets === k0.pets + 5 && !st.cats.some((c) => c.id === 'cat-lie' || c.id === 'cat-roll'),
      '두 사진 폴더에서 쓰다듬은 횟수가 한 고양이 기록에 쌓인다', { k0, k1 });
    win.destroy();
    store.setCatAffinity('tabby-kitten', 0.77);
    const { win: w2, s } = await begin(1920, 1080, pay('cat-roll'));
    const a = s.none ? null : await js(w2, 'window.nunsEnter.rigNow().handle.getAffinity()');
    ok(a !== null && Math.abs(a - 0.77) < 1e-9, '늘어진 아기 고양이로 앉아도 엎드린 고양이 때 오른 친밀도에서 시작한다', a);
    w2.destroy();
  }

  console.log('\n[6c] 다른 화면에 친밀도·오늘 횟수 나누기');
  {
    // B 에 고양이가 앉아 있고, 같은 휴식의 A 화면에서 같은 고양이를 쓰다듬었다 (커서 화면을 못 읽어 모든 화면이 그린 때)
    const { win: wb, s } = await begin(1920, 1080, pay('cat-rb'));
    const wa = await overlay(1920, 1080);
    await js(wa, `window.nunsseom.catPet({ rig: 'grey', strokes: 4, credited: 4 }); window.nunsseom.catAffinity({ rig: 'grey', value: 0.61 });`);
    await sleep(400);
    const b = s.none ? null : await js(wb, '(() => { const t = window.nunsEnter.rigNow().handle.stats(); return { affinity: t.affinity, today: t.todayStrokes }; })()');
    const want = store.catRigCats().grey.today;
    ok(b && b.affinity === 0.61 && b.today === want && want >= 4,
      '다른 화면에서 오른 친밀도와 오늘 친밀도에 든 횟수를 이 화면의 같은 고양이가 이어 받는다', { b, want });
    wa.destroy();
    wb.destroy();
  }

  console.log('\n[6d] 오늘 친밀도에 든 횟수 — 경고 중 쓸기는 빼고, 다른 화면과 같은 바탕');
  {
    // B 에는 같은 고양이가 앉아 알림만 받는다. A 에서 휴식 창처럼(메인이 실은 친밀도·오늘 몫으로) 앉혀 진짜 커서로 두 판 쓰다듬는다 —
    // 한 판은 기분 좋을 때, 한 판은 도중에 경고(경고 중 쓸기는 친밀도에 안 든다). 리그의 오늘 몫은 store 의 오늘 몫과 같아야 한다
    const { win: wb, s: sb } = await begin(1920, 1080, pay('cat-rb'));
    const wa = await overlay(1920, 1080);
    const cats = store.catRigCats();
    const today0 = cats.grey.today, total0 = store.catRigStats().total;
    const a = await js(wa, `(async () => {
      const E = window.nunsEnter, host = document.getElementById('curtain');
      const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
      window.__pets = []; window.__affs = [];
      const o = { purr: false, volume: 0, cats: ${JSON.stringify(cats)}, debug: true,
        rigOf: (id) => window.nunsseom.catRig(id),
        onPet: (id, p) => { window.__pets.push(p); window.nunsseom.catPet({ rig: id, strokes: p.strokes, credited: p.credited }); },
        onAffinity: (id, v) => { window.__affs.push(v); window.nunsseom.catAffinity({ rig: id, value: v }); } };
      await E.play('cat-rb', host, null, 20, { rig: o });
      for (let i = 0; i < 100 && !(E.rigNow() && E.rigNow().handle); i++) await sleep(50);
      const h = E.rigNow().handle;
      await h.ready;
      await sleep(900);
      // 경고는 길게(화내지 않게), 눈인사는 끈다 — 쓰다듬기 셈만 본다
      h.debug.moodCfg({ warn: 1e6, greetP: 0, spontP: 0 });
      const rig = h.debug.rig();
      const t = h.stats();
      return { head: h.debug.where(rig.head.center[0], rig.head.center[1] - rig.head.ry * 0.35), a0: t.affinity, today: t.todayStrokes };
    })()`);
    const [hx, hy] = a.head;
    const stroke = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const x = hx + Math.sin(((Date.now() - t0) / 900) * Math.PI * 2) * 70;
        wa.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x / 2), y: Math.round(hy / 2) });
        await sleep(16);
      }
      wa.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    };
    const st = () => js(wa, '(() => { const t = window.nunsEnter.rigNow().handle.stats(); return { aff: t.affinity, today: t.todayStrokes, strokes: t.strokes, mood: t.mood, pets: window.__pets }; })()');
    ok(a.today === today0, 'mount 의 todayStrokes 는 메인이 실은 오늘 몫이다', { rig: a.today, store: today0 });
    // 한 판 — 기분 좋을 때: 쓴 만큼 다 든다
    await stroke(2600);
    await sleep(1800);
    const s1 = await st();
    const p1 = s1.pets[0] || {};
    const want1 = await js(wa, `window.nunsCatRig.affinityAfter(${a.a0}, { strokes: ${p1.credited | 0}, todayBefore: ${a.today} })`);
    ok(s1.pets.length === 1 && p1.strokes > 0 && p1.credited === p1.strokes && s1.today === a.today + p1.credited && Math.abs(s1.aff - want1) < 1e-9,
      '기분 좋은 판 — 쓴 횟수가 다 오늘 몫에 들고, 친밀도는 규칙(affinityAfter, todayBefore = 오늘 몫)과 같다', { p1, today: s1.today, aff: s1.aff, want1 });
    // 두 판 — 도중에 경고: 경고 뒤 쓸기는 횟수(onPet strokes·stats)엔 들고 오늘 몫·친밀도엔 안 든다
    const t2 = Date.now();
    const half = stroke(3800);
    await sleep(1600);
    await js(wa, 'window.nunsEnter.rigNow().handle.debug.mood("warning")');
    await half;
    const warned = Date.now() - t2;
    await sleep(2200);
    const s2 = await st();
    const p2 = s2.pets[1] || {};
    const want2 = await js(wa, `window.nunsCatRig.affinityAfter(${s1.aff}, { strokes: ${p2.credited | 0}, todayBefore: ${s1.today} })`);
    ok(s2.pets.length === 2 && p2.strokes > p2.credited && p2.credited > 0 && s2.strokes === p1.strokes + p2.strokes,
      '경고가 든 판 — onPet·stats 횟수는 경고 중 쓸기까지 세고, 친밀도에 든 몫(credited)은 그 앞까지만', { p2, strokes: s2.strokes, ms: warned });
    ok(s2.today === s1.today + p2.credited && Math.abs(s2.aff - want2) < 1e-9,
      '경고 중 쓸기는 리그의 오늘 몫에도 안 든다 — 친밀도는 credited 와 그 앞 오늘 몫으로 셈한 값', { today: s2.today, wantToday: s1.today + p2.credited, notStrokes: s1.today + p2.strokes, aff: s2.aff, want2 });
    await sleep(300);
    const g = store.catRigCats().grey;
    ok(g.today - today0 === s2.today - a.today && g.today === s2.today && store.catRigStats().total - total0 === p1.strokes + p2.strokes,
      '리그의 오늘 몫과 store 의 오늘 몫이 같다 — 다음 휴식도 같은 바탕에서 셈한다 (모두 횟수엔 경고 중 쓸기도 든다)', { rig: s2.today, store: g.today, today0, total: store.catRigStats().total - total0 });
    const b = sb.none ? null : await js(wb, `(() => { const h = window.nunsEnter.rigNow().handle; const t0 = h.stats();
      h.setAffinity(t0.affinity, 3); const t1 = h.stats(); h.setAffinity(t0.affinity, t0.todayStrokes + 50); const t2 = h.stats();
      return { aff: t0.affinity, today: t0.todayStrokes, smaller: t1.todayStrokes, larger: t2.todayStrokes }; })()`);
    ok(b && Math.abs(b.aff - s2.aff) < 1e-12 && b.today === g.today && b.smaller === g.today && b.larger === g.today + 50,
      '다른 화면의 같은 고양이는 그 친밀도·오늘 몫을 이어 받는다 — 작은 몫은 무시하고 큰 몫만 받는다 (setAffinity)', { b, store: g.today, aff: s2.aff });
    wa.destroy();
    wb.destroy();
  }

  console.log('\n[7] 기록 창 이름');
  const keys7 = [...new Set(rigIds.map((id) => breakwin.catKey(id)))];
  const names = keys7.map((k) => [k, w0.nunsEnter.rigName(k)]);
  ok(names.every(([, n]) => n) && w0.nunsEnter.rigName('tabby-kitten') === '줄무늬 아기 고양이',
    '고양이마다 기록 창에 쓸 이름이 있다 (같은 고양이를 찍은 영상끼리는 한 이름)', names);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

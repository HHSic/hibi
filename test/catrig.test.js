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
//   [5] 물러나기 — WebGL 이 없거나 사진·rig.json 이 없으면 영상으로. 설정을 끄면 영상 그대로
//   [6] 기록 — 이번 휴식의 창이 아닌 창(휴식 창 페이지여도)·이상한 값은 버린다. 같은 고양이를 찍은 영상끼리 한 고양이로 센다.
//       다른 화면에 친밀도와 오늘 횟수를 나눈다
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 360_000).unref();
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

  console.log('\n[7] 기록 창 이름');
  const keys7 = [...new Set(rigIds.map((id) => breakwin.catKey(id)))];
  const names = keys7.map((k) => [k, w0.nunsEnter.rigName(k)]);
  ok(names.every(([, n]) => n) && w0.nunsEnter.rigName('tabby-kitten') === '줄무늬 아기 고양이',
    '고양이마다 기록 창에 쓸 이름이 있다 (같은 고양이를 찍은 영상끼리는 한 이름)', names);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

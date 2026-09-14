// 고양이 연출(누끼 딴 실제 촬영 영상, renderer/anim/clip.js + assets/enter/cat.webm)이 약속을 지키는가.
//
// 영상은 눈으로 다듬었다(프레임을 뽑아 테두리·이음새를 봤다). 다음에 누가 다시 굽거나 고쳐도
// 조용히 망가뜨리지 못하게, 잴 수 있는 것들을 여기 못 박는다:
//   · 파일이 VP9 + 알파이고, 길이가 적혀 있고, 프레임이 빠짐없이 고르게 들어 있다
//   · 배경은 정말 투명하고(윗줄·양옆), 몸은 불투명하다
//   · 끝에서 처음으로 넘어가는 이음새가 옆 프레임끼리의 차이만큼만 튄다 — 되풀이가 안 보인다
//   · loop 재생이 실제로 처음으로 돌아간다
//   · 어떤 화면 크기에서도 글 자리를 안 덮고 화면 밖으로 안 나간다
//   · enter.js 가 영상으로 띄우고, 영상이 안 열리면 옛 그림 없이 조용히 걷는다
// 이 시험은 앱을 띄우지 않는다 — 보이지 않는 창 하나에 clip.js 와 enter.js 만 싣는다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과'); process.exit(1); }, 150_000).unref();

const ROOT = path.join(__dirname, '..');
const URL_OF = (p) => 'file:///' + p.split(path.sep).join('/');
const FILE = path.join(ROOT, 'assets', 'enter', 'cat.webm');

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// ── WebM 상자 훑기 (EBML) — 코덱·알파·길이·프레임 시각 ──
function readVint(buf, p, keepMarker) {
  const b = buf[p];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  let v = keepMarker ? b : b & (mask - 1);
  let ones = (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + buf[p + i]; if (buf[p + i] !== 0xff) ones = false; }
  return { v, len, unknown: !keepMarker && ones };
}
function scanWebm(buf) {
  const MASTER = new Set([0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0, 0x1F43B675, 0xA0]);
  const r = { times: [], alphaMode: null, w: null, h: null, codec: null, duration: null, tcScale: 1e6 };
  let p = 0, clusterTc = 0;
  while (p < buf.length) {
    const id = readVint(buf, p, true); p += id.len;
    const sz = readVint(buf, p, false); p += sz.len;
    if (MASTER.has(id.v)) continue;
    const start = p, end = sz.unknown ? buf.length : p + sz.v;
    if (end > buf.length) break;
    const uint = () => { let x = 0; for (let i = start; i < end; i++) x = x * 256 + buf[i]; return x; };
    if (id.v === 0x2AD7B1) r.tcScale = uint();
    else if (id.v === 0x4489) r.duration = sz.v === 8 ? buf.readDoubleBE(start) : buf.readFloatBE(start);
    else if (id.v === 0xE7) clusterTc = uint();
    else if (id.v === 0xA3 || id.v === 0xA1) {
      const tr = readVint(buf, start, false);
      if (tr.v === 1) r.times.push(clusterTc + buf.readInt16BE(start + tr.len));
    } else if (id.v === 0x53C0) r.alphaMode = uint();
    else if (id.v === 0xB0) r.w = uint();
    else if (id.v === 0xBA) r.h = uint();
    else if (id.v === 0x86) r.codec = buf.toString('latin1', start, end);
    p = end;
  }
  return r;
}

app.whenReady().then(async () => {
  console.log('\n[파일]');
  const exists = fs.existsSync(FILE);
  ok(exists, 'assets/enter/cat.webm 이 있다');
  if (!exists) { app.exit(1); return; }
  const buf = fs.readFileSync(FILE);
  const mb = buf.length / 1048576;
  // 설치 파일이 이만큼 커진다 — 휴식 연출 하나에 넉넉히 준 몫
  ok(mb <= 6, '크기 6MB 이하', +mb.toFixed(2));
  const s = scanWebm(buf);
  const ms = s.tcScale / 1e6;
  const steps = [];
  const ts = s.times.slice().sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) steps.push((ts[i] - ts[i - 1]) * ms);
  const durMs = s.duration != null ? s.duration * ms : null;
  console.log('  ', JSON.stringify({ codec: s.codec, alphaMode: s.alphaMode, w: s.w, h: s.h, frames: ts.length, durMs,
    stepMin: Math.min(...steps), stepMax: Math.max(...steps) }));
  ok(s.codec === 'V_VP9', 'VP9 로 구웠다', s.codec);
  ok(s.alphaMode === 1, '알파(투명) 트랙이 있다', s.alphaMode);
  ok(durMs != null && durMs > 5000, '길이(Duration)가 적혀 있다 — 없으면 되풀이 재생이 흔들린다', durMs);
  ok(durMs != null && Math.abs(ts.length - durMs / (1000 / 30)) <= 2, '프레임 수가 길이×30 과 맞다 (빠진 프레임 없음)', { frames: ts.length, durMs });
  ok(steps.length > 0 && Math.max(...steps) <= 50, '프레임 사이가 고르다 (50ms 넘게 빈 곳 없음)', Math.max(...steps));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catclip-'));
  const page = path.join(dir, 'page.html');
  // base 를 renderer/ 로 — clip.js 의 '../assets/enter/cat.webm' 이 휴식 창에서와 똑같이 풀린다
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><base href="${URL_OF(path.join(ROOT, 'renderer'))}/">
<body style="margin:0"><div id="curtain" class="curtain" style="position:fixed;inset:0"></div>
<script src="anim/clip.js"></script>
<script src="enter.js"></script>
</body>`);
  const win = new BrowserWindow({ show: false, width: 1280, height: 720,
    webPreferences: { backgroundThrottling: false } });
  const errs = [];
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && 'message' in a[0] ? a[0] : null;
    const level = d ? d.level : a[1];
    const msg = d ? d.message : a[2];
    // 아래 «없는 파일» 시험이 일부러 내는 404 는 빼고 센다
    if ((level === 3 || level === 'error') && !/__없는파일__|ERR_FILE_NOT_FOUND/.test(msg)) errs.push(msg);
  });
  await win.loadFile(page);
  const js = (code) => win.webContents.executeJavaScript(code);

  console.log('\n[영상]');
  const v = await js(`(async () => {
    const clip = window.nunsClip.CLIPS.cat;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = new URL(clip.url, document.baseURI).href;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('영상을 못 열었다')); });
    const W = v.videoWidth, H = v.videoHeight, D = v.duration, FPS = 30;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    const seek = (t) => new Promise((res) => { v.onseeked = res; v.currentTime = t; });
    const grab = async (t) => { await seek(t); x.clearRect(0, 0, W, H); x.drawImage(v, 0, 0); return x.getImageData(0, 0, W, H).data; };
    const out = { W, H, D, dims: [clip.width, clip.height], shots: [] };
    for (const t of [0.2, D / 2, D - 0.2]) {
      const d = await grab(t);
      let clear = 0, n = 0, top = 0, side = 0, body = 0, bn = 0;
      for (let i = 3; i < d.length; i += 4 * 7) { n++; if (d[i] < 10) clear++; }
      for (let xx = 0; xx < W; xx++) top = Math.max(top, d[xx * 4 + 3]);
      for (let yy = 0; yy < H * 0.5; yy++) side = Math.max(side, d[yy * W * 4 + 3], d[(yy * W + W - 1) * 4 + 3]);
      for (let yy = Math.floor(H * 0.75); yy < H * 0.95; yy += 3) {
        for (let xx = Math.floor(W * 0.4); xx < W * 0.6; xx += 3) { bn++; if (d[(yy * W + xx) * 4 + 3] > 245) body++; }
      }
      out.shots.push({ t: +t.toFixed(2), clear: +(clear / n).toFixed(3), top, side, body: +(body / bn).toFixed(3) });
    }
    const N = Math.round(D * FPS);
    const dif = (a, b) => { let sum = 0, k = 0; for (let i = 0; i < a.length; i += 4 * 5) { for (let ch = 0; ch < 4; ch++) sum += Math.abs(a[i + ch] - b[i + ch]); k += 4; } return sum / k; };
    out.adj = [];
    for (const n of [30, 120, 210, N - 30]) out.adj.push(+dif(await grab((n + 0.5) / FPS), await grab((n + 1.5) / FPS)).toFixed(2));
    out.seam = +dif(await grab((N - 0.5) / FPS), await grab(0.5 / FPS)).toFixed(2);
    v.loop = true;
    await seek(Math.max(0, D - 0.4));
    out.wraps = await new Promise((res) => {
      const to = setTimeout(() => res(false), 4000);
      v.ontimeupdate = () => { if (v.currentTime < 0.5) { clearTimeout(to); res(true); } };
      v.play().catch((e) => { clearTimeout(to); res('play: ' + e.message); });
    });
    v.pause();
    return out;
  })()`).catch((e) => ({ err: e.message }));
  console.log('  ', JSON.stringify(v));
  if (v.err) {
    ok(false, '영상을 연다', v.err);
  } else {
    ok(v.W === v.dims[0] && v.H === v.dims[1], 'clip.js 에 적은 크기와 영상 크기가 같다', { video: [v.W, v.H], clipJs: v.dims });
    ok(v.shots.every((q) => q.top <= 16 && q.side <= 16), '윗줄·양옆은 투명하다 (배경이 남지 않았다)', v.shots.map((q) => [q.top, q.side]));
    ok(v.shots.every((q) => q.clear >= 0.2 && q.clear <= 0.8), '투명한 곳이 적당하다 (통째 네모도, 빈 영상도 아니다)', v.shots.map((q) => q.clear));
    ok(v.shots.every((q) => q.body >= 0.9), '앉은 몸(아래 가운데)은 불투명하다', v.shots.map((q) => q.body));
    const adjMax = Math.max(...v.adj);
    ok(v.seam <= adjMax * 2.5 + 1, '끝→처음 이음새가 옆 프레임 차이만큼만 튄다', { seam: v.seam, adj: v.adj });
    ok(v.wraps === true, 'loop 재생이 처음으로 돌아간다', v.wraps);
  }

  console.log('\n[자리]');
  const lay = await js(`(() => {
    const { layout, CLIPS } = window.nunsClip;
    const sizes = [[1920, 1080], [1366, 768], [1280, 1024], [2560, 1440], [3840, 2160], [3440, 1440], [1080, 1920], [768, 1366], [320, 180]];
    return sizes.map(([w, h]) => {
      const b = layout(w, h, CLIPS.cat);
      const hit = b.x < w * 0.59 && b.x + b.w > w * 0.41 && b.y < h * 0.62 && b.y + b.h > h * 0.30;
      const inside = b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= w + 0.5 && b.y + b.h <= h + 0.5;
      return { size: w + 'x' + h, hit, inside, big: +(b.h / Math.min(w, h)).toFixed(3),
        aspect: Math.abs(b.w / b.h - CLIPS.cat.width / CLIPS.cat.height) < 0.01 };
    });
  })()`);
  ok(lay.every((q) => !q.hit), '어떤 화면 크기에서도 글 자리(가로 41~59%·세로 30~62%)를 안 덮는다', lay.filter((q) => q.hit));
  ok(lay.every((q) => q.inside), '화면 밖으로 안 나간다', lay.filter((q) => !q.inside));
  ok(lay.every((q) => q.aspect), '영상 비율을 지킨다 (찌그러지지 않는다)', lay.filter((q) => !q.aspect));
  ok(lay.every((q) => q.big >= 0.3), '짧은 변의 30% 이상 크기로 보인다', lay.map((q) => q.big));

  console.log('\n[enter.js]');
  const e1 = await js(`(async () => {
    const host = document.getElementById('curtain');
    const E = window.nunsEnter;
    const ms = await E.play('cat', host, null, 20);
    const v = host.querySelector('video.ent-clip');
    const loaded = v ? await new Promise((res) => {
      if (v.readyState >= 2) { res(true); return; }
      v.addEventListener('loadeddata', () => res(true), { once: true });
      setTimeout(() => res(false), 5000);
    }) : false;
    await new Promise((r) => setTimeout(r, 50));
    return { ms, cover: E.coverMs('cat'), cls: host.className, video: host.querySelectorAll('video').length, loaded,
      vcls: v ? v.className : null, svg: !!host.querySelector('svg'), canvas: !!host.querySelector('canvas'),
      scene: !!E.sceneFor('cat'), clip: !!E.clipFor('cat'), inList: E.LIST.some((m) => m.id === 'cat') };
  })()`);
  ok(e1.cls === 'curtain on ent-clip-on' && e1.video === 1 && !e1.svg && !e1.canvas, '«고양이»는 영상 하나로 띄운다 (옛 SVG·캔버스 없음)', e1);
  ok(e1.loaded && /\bin\b/.test(e1.vcls || ''), '첫 프레임이 준비되면 나타난다', e1.vcls);
  ok(e1.ms === 700 + 260 && e1.cover === e1.ms, '휴식 내용은 도착(0.7초)+잠깐 뒤에 뜬다', e1.ms);
  ok(e1.clip && !e1.scene && e1.inList, '고르는 목록에 있고, 캔버스 장면이 아니라 영상으로 잡힌다', e1);

  const e2 = await js(`(async () => {
    const host = document.getElementById('curtain');
    host.textContent = '';
    const clip = window.nunsClip.CLIPS.cat;
    const real = clip.url;
    clip.url = '../assets/enter/__없는파일__.webm';
    try {
      const ms = await window.nunsEnter.play('cat', host, null, 20);
      const t0 = Date.now();
      const gone = await new Promise((res) => {
        const tick = () => {
          if (!host.querySelector('video')) { res(Date.now() - t0); return; }
          if (Date.now() - t0 > 5000) { res(-1); return; }
          setTimeout(tick, 50);
        };
        tick();
      });
      return { ms, gone, cls: host.className, svg: !!host.querySelector('svg'), kids: host.children.length };
    } finally { clip.url = real; }
  })()`);
  ok(e2.gone >= 0 && e2.cls === 'curtain' && !e2.svg && e2.kids === 0, '영상이 안 열리면 옛 그림 없이 조용히 걷는다', e2);

  if (errs.length) console.log('\n   콘솔 오류:', errs.slice(0, 5));
  ok(errs.length === 0, '콘솔 오류가 없다', errs.slice(0, 3));
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

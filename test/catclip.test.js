// 고양이 연출(누끼 딴 실제 촬영 영상, renderer/anim/clip.js + assets/enter/*.webm)이 약속을 지키는가.
//
// 영상은 눈으로 다듬었다(프레임을 뽑아 테두리·이음새를 봤다). 다음에 누가 다시 굽거나 새 고양이를
// 넣어도 조용히 망가뜨리지 못하게, clip.js 의 CLIPS 에 적힌 영상마다 잴 수 있는 것들을 못 박는다:
//   · 파일이 VP9 + 알파이고, 길이가 적혀 있고, 프레임이 빠짐없이 고르게 들어 있다
//   · 배경은 정말 투명하고(윗줄·양옆), 몸은 불투명하다
//   · 끝에서 처음으로 넘어가는 이음새가 옆 프레임끼리의 차이만큼만 튄다 — 되풀이가 안 보인다
//   · loop 재생이 실제로 처음으로 돌아간다
//   · 구석 자리는 어떤 화면 크기에서도 글 자리를 안 덮고 화면 밖으로 안 나간다
//     (주인공 자리는 test/herolayout.test.js 가 진짜 휴식 창으로 잰다)
//   · enter.js 가 영상으로 띄우고, 영상이 안 열리면 옛 그림 없이 조용히 걷는다
// 이 시험은 앱을 띄우지 않는다 — 보이지 않는 창 하나에 clip.js 와 enter.js 만 싣는다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과'); process.exit(1); }, 300_000).unref();

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const URL_OF = (p) => 'file:///' + p.split(path.sep).join('/');
// 설치 파일이 이만큼씩 커진다 — 휴식 연출 하나에 넉넉히 준 몫
const MAX_MB = 6;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catclip-'));
  const page = path.join(dir, 'page.html');
  // base 를 renderer/ 로 — clip.js 의 '../assets/enter/…' 주소가 휴식 창에서와 똑같이 풀린다
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><base href="${URL_OF(RENDERER)}/">
<body style="margin:0"><div id="curtain" class="curtain" style="position:fixed;inset:0"></div>
<script src="anim/clip.js"></script>
<script src="enter.js"></script>
</body>`);
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
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

  const clips = await js(`Object.entries(window.nunsClip.CLIPS).map(([id, c]) => ({ id, url: c.url, width: c.width, height: c.height, fps: c.fps || 30, mode: (c.place && c.place.mode) || 'corner', arrivalMs: c.arrivalMs, cut: c.cut || null }))`);
  ok(clips.length > 0, 'clip.js 에 영상이 적혀 있다', clips.map((c) => c.id));

  for (const clip of clips) {
    const tag = clip.id;
    console.log(`\n[${tag} — 파일]`);
    const file = path.resolve(RENDERER, clip.url);
    const exists = fs.existsSync(file);
    ok(exists, `${tag}: ${path.relative(ROOT, file)} 이 있다`);
    if (!exists) continue;
    const buf = fs.readFileSync(file);
    const mb = buf.length / 1048576;
    ok(mb <= MAX_MB, `${tag}: 크기 ${MAX_MB}MB 이하`, +mb.toFixed(2));
    const s = scanWebm(buf);
    const unit = s.tcScale / 1e6;
    const ts = s.times.slice().sort((a, b) => a - b);
    const steps = [];
    for (let i = 1; i < ts.length; i++) steps.push((ts[i] - ts[i - 1]) * unit);
    const durMs = s.duration != null ? s.duration * unit : null;
    console.log('  ', JSON.stringify({ codec: s.codec, alphaMode: s.alphaMode, w: s.w, h: s.h, frames: ts.length, durMs,
      stepMin: Math.min(...steps), stepMax: Math.max(...steps) }));
    ok(s.codec === 'V_VP9', `${tag}: VP9 로 구웠다`, s.codec);
    ok(s.alphaMode === 1, `${tag}: 알파(투명) 트랙이 있다`, s.alphaMode);
    ok(durMs != null && durMs > 2000, `${tag}: 길이(Duration)가 적혀 있다 — 없으면 되풀이 재생이 흔들린다`, durMs);
    ok(durMs != null && Math.abs(ts.length - durMs / (1000 / clip.fps)) <= 2, `${tag}: 프레임 수가 길이×${clip.fps} 과 맞다 (빠진 프레임 없음)`, { frames: ts.length, durMs, fps: clip.fps });
    ok(steps.length > 0 && Math.max(...steps) <= (1000 / clip.fps) * 1.5, `${tag}: 프레임 사이가 고르다 (한 프레임의 1.5배 넘게 빈 곳 없음)`, Math.max(...steps));

    console.log(`\n[${tag} — 영상]`);
    const v = await js(`(async () => {
      const clip = window.nunsClip.CLIPS[${JSON.stringify(tag)}];
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = new URL(clip.url, document.baseURI).href;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('영상을 못 열었다')); });
      const W = v.videoWidth, H = v.videoHeight, D = v.duration, FPS = ${clip.fps};
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      const seek = (t) => new Promise((res) => { v.onseeked = res; v.currentTime = t; });
      const grab = async (t) => { await seek(t); x.clearRect(0, 0, W, H); x.drawImage(v, 0, 0); return x.getImageData(0, 0, W, H).data; };
      const out = { W, H, D, shots: [] };
      // 몸이 원본 화면 끝에 잘린 영상(clip.cut)은 그 쪽 가장자리가 불투명한 게 맞다 — 그 쪽은 안 본다
      const cut = clip.cut || {};
      for (const t of [0.2, D / 2, D - 0.2]) {
        const d = await grab(t);
        let clear = 0, n = 0, top = 0, side = 0, seen = 0, solid = 0;
        for (let i = 3; i < d.length; i += 4 * 7) { n++; if (d[i] < 10) clear++; if (d[i] > 16) { seen++; if (d[i] > 240) solid++; } }
        if (!cut.top) for (let xx = 0; xx < W; xx++) top = Math.max(top, d[xx * 4 + 3]);
        for (let yy = 0; yy < H * 0.5; yy++) side = Math.max(side, cut.left ? 0 : d[yy * W * 4 + 3], cut.right ? 0 : d[(yy * W + W - 1) * 4 + 3]);
        out.shots.push({ t: +t.toFixed(2), clear: +(clear / n).toFixed(3), top, side, body: +(solid / Math.max(1, seen)).toFixed(3) });
      }
      const N = Math.round(D * FPS);
      const dif = (a, b) => { let sum = 0, k = 0; for (let i = 0; i < a.length; i += 4 * 5) { for (let ch = 0; ch < 4; ch++) sum += Math.abs(a[i + ch] - b[i + ch]); k += 4; } return sum / k; };
      out.adj = [];
      for (const n of [30, Math.floor(N * 0.35), Math.floor(N * 0.65), N - 30]) out.adj.push(+dif(await grab((n + 0.5) / FPS), await grab((n + 1.5) / FPS)).toFixed(2));
      out.seam = +dif(await grab((N - 0.5) / FPS), await grab(0.5 / FPS)).toFixed(2);
      // 되풀이 프레임 — 25fps 를 30fps 로 늘린 원본은 6장마다 같은 장이 끼어 1초에 5번 멈칫한다.
      // 연속 60장을 작게 풀어 바로 앞 장과 거의 같은 장을 찾고, 그 자리가 6장 간격으로 몰렸는지 본다
      // (가만히 있는 순간·핑퐁이 돌아서는 곳에서도 같은 장은 생기지만 간격이 규칙적이지 않다)
      {
        const sc = document.createElement('canvas'); sc.width = 160; sc.height = Math.max(1, Math.round(160 * H / W));
        const sx = sc.getContext('2d', { willReadFrequently: true });
        const M = Math.min(60, N - 1);
        const diffs = [];
        let prev = null;
        for (let n = 0; n <= M; n++) {
          await seek((n + 0.5) / FPS);
          sx.clearRect(0, 0, sc.width, sc.height); sx.drawImage(v, 0, 0, sc.width, sc.height);
          const cur = sx.getImageData(0, 0, sc.width, sc.height).data;
          if (prev) diffs.push(dif(prev, cur));
          prev = cur;
        }
        const med = diffs.slice().sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
        const dups = [];
        diffs.forEach((d, i) => { if (d < med * 0.15) dups.push(i + 1); });
        const byMod = [0, 0, 0, 0, 0, 0];
        for (const i of dups) byMod[i % 6]++;
        out.dups = { count: dups.length, byMod, median: +med.toFixed(3) };
      }
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
      ok(false, `${tag}: 영상을 연다`, v.err);
    } else {
      ok(v.W === clip.width && v.H === clip.height, `${tag}: clip.js 에 적은 크기와 영상 크기가 같다`, { video: [v.W, v.H], clipJs: [clip.width, clip.height] });
      ok(v.shots.every((q) => q.top <= 16 && q.side <= 16), `${tag}: 윗줄·양옆은 투명하다 (배경이 남지 않았다)`, v.shots.map((q) => [q.top, q.side]));
      // 화면 끝에 잘린 클로즈업은 고양이가 칸을 거의 채운다 — 투명한 곳이 적어도 된다
      const minClear = clip.cut ? 0.05 : 0.2;
      ok(v.shots.every((q) => q.clear >= minClear && q.clear <= 0.8), `${tag}: 투명한 곳이 적당하다 (통째 네모도, 빈 영상도 아니다)`, v.shots.map((q) => q.clear));
      // 앉았든 누웠든 — 보이는 점(알파 16 초과) 가운데 꽉 찬 점(240 초과)이 대부분이어야 한다. 누끼가 뭉개져 몸이 비치면 여기서 떨어진다
      ok(v.shots.every((q) => q.body >= 0.7), `${tag}: 몸은 비치지 않는다 (보이는 점의 70% 이상이 꽉 참)`, v.shots.map((q) => q.body));
      ok(v.seam <= Math.max(...v.adj) * 2.5 + 1, `${tag}: 끝→처음 이음새가 옆 프레임 차이만큼만 튄다`, { seam: v.seam, adj: v.adj });
      ok(v.wraps === true, `${tag}: loop 재생이 처음으로 돌아간다`, v.wraps);
      ok(!(v.dups.count >= 6 && Math.max(...v.dups.byMod) >= v.dups.count * 0.8), `${tag}: 6장마다 같은 프레임이 끼어 있지 않다 (멈칫거림)`, v.dups);
    }

    if (clip.mode === 'corner') {
      console.log(`\n[${tag} — 자리]`);
      const lay = await js(`(() => {
        const { layout, CLIPS } = window.nunsClip;
        const c = CLIPS[${JSON.stringify(tag)}];
        const sizes = [[1920, 1080], [1366, 768], [1280, 720], [1280, 1024], [1440, 900], [1536, 864], [2560, 1440], [3840, 2160], [3440, 1440], [1920, 1920], [1080, 1920], [768, 1366], [720, 1280], [320, 180]];
        return sizes.map(([w, h]) => {
          const b = layout(w, h, c);
          const hit = b.x < w * 0.59 && b.x + b.w > w * 0.41 && b.y < h * 0.62 && b.y + b.h > h * 0.30;
          // 단추 줄 — 가운데 아래, 폭 ±180px·높이 95px (실제 세 단추 «다 했어요 (0/7)»·«5분 뒤에»·«건너뛰기» + 여백)
          const btn = w >= 600 && b.x < w / 2 + 180 && b.x + b.w > w / 2 - 180 && b.y + b.h > h - 95;
          const inside = b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= w + 0.5 && b.y + b.h <= h + 0.5;
          return { size: w + 'x' + h, hit, btn, inside, big: +Math.max(b.h / Math.min(w, h), b.w / w).toFixed(3),
            aspect: Math.abs(b.w / b.h - c.width / c.height) < 0.01 };
        });
      })()`);
      ok(lay.every((q) => !q.hit), `${tag}: 어떤 화면 크기에서도 글 자리(가로 41~59%·세로 30~62%)를 안 덮는다`, lay.filter((q) => q.hit));
      ok(lay.every((q) => !q.btn), `${tag}: 가운데 아래 단추 줄을 가리지 않는다 (옆으로 긴 아기 고양이가 단추 뒤에 깔렸다)`, lay.filter((q) => q.btn));
      ok(lay.every((q) => q.inside), `${tag}: 화면 밖으로 안 나간다`, lay.filter((q) => !q.inside));
      ok(lay.every((q) => q.aspect), `${tag}: 영상 비율을 지킨다 (찌그러지지 않는다)`, lay.filter((q) => !q.aspect));
      ok(lay.every((q) => q.big >= 0.3), `${tag}: 짧은 변의 30% 이상 높이나 화면 폭의 30% 이상 폭으로 보인다`, lay.map((q) => q.big));
    }

    console.log(`\n[${tag} — enter.js]`);
    const e1 = await js(`(async () => {
      const host = document.getElementById('curtain');
      host.textContent = '';
      document.documentElement.classList.remove('ent-hero');
      const E = window.nunsEnter;
      const id = ${JSON.stringify(tag)};
      const ms = await E.play(id, host, null, 20);
      const v = host.querySelector('video.ent-clip');
      const loaded = v ? await new Promise((res) => {
        if (v.readyState >= 2) { res(true); return; }
        v.addEventListener('loadeddata', () => res(true), { once: true });
        setTimeout(() => res(false), 5000);
      }) : false;
      await new Promise((r) => setTimeout(r, 50));
      return { ms, cover: E.coverMs(id), cls: host.className, video: host.querySelectorAll('video').length, loaded,
        vcls: v ? v.className : null, svg: !!host.querySelector('svg'), canvas: !!host.querySelector('canvas'),
        scene: !!E.sceneFor(id), clip: !!E.clipFor(id), inList: E.LIST.some((m) => m.id === id),
        hero: document.documentElement.classList.contains('ent-hero') };
    })()`);
    ok(e1.cls === 'curtain on ent-clip-on' && e1.video === 1 && !e1.svg && !e1.canvas, `${tag}: 영상 하나로 띄운다 (옛 SVG·캔버스 없음)`, e1);
    ok(e1.loaded && /\bin\b/.test(e1.vcls || ''), `${tag}: 첫 프레임이 준비되면 나타난다`, e1.vcls);
    ok(e1.ms === clip.arrivalMs + 260 && e1.cover === e1.ms, `${tag}: 휴식 내용은 도착+잠깐 뒤에 뜬다`, { ms: e1.ms, arrivalMs: clip.arrivalMs });
    ok(e1.clip && !e1.scene && e1.inList, `${tag}: 고르는 목록에 있고, 캔버스 장면이 아니라 영상으로 잡힌다`, e1);
    ok(e1.hero === (clip.mode === 'hero'), `${tag}: 주인공 자리일 때만 html.ent-hero 가 붙는다`, { hero: e1.hero, mode: clip.mode });
  }

  console.log('\n[랜덤 고양이 — enter.js]');
  // 보통은 메인이 고양이를 골라 넘긴다 (test/catrandom.test.js). 화면 쪽이 «랜덤 고양이»를 그대로 받아도 고양이 영상 하나로 떠야 한다
  const e3 = await js(`(async () => {
    const host = document.getElementById('curtain');
    const E = window.nunsEnter;
    const urls = new Set(Object.values(window.nunsClip.CLIPS).map((c) => new URL(c.url, document.baseURI).href));
    const seen = new Set();
    let wrong = 0;
    for (let i = 0; i < 30; i++) {
      host.textContent = '';
      document.documentElement.classList.remove('ent-hero');
      await E.play('cat-random', host, null, 20);
      const vids = host.querySelectorAll('video.ent-clip');
      if (vids.length !== 1 || !urls.has(vids[0].src)) wrong++; else seen.add(vids[0].src);
    }
    host.textContent = '';
    document.documentElement.classList.remove('ent-hero');
    // 구석·가운데 회색 고양이처럼 한 영상을 두 자리가 같이 쓰기도 한다 — 뽑히는 id 가 가리키는 «서로 다른 영상» 수와 맞춘다
    const idUrls = new Set(E.catIds().map((id) => new URL(window.nunsClip.CLIPS[id].url, document.baseURI).href)).size;
    return { wrong, seen: seen.size, total: urls.size, idUrls, ids: E.catIds(), inList: E.LIST.some((m) => m.id === 'cat-random') };
  })()`);
  ok(e3.wrong === 0 && e3.inList, '«랜덤 고양이»를 화면 쪽에서 받아도 고양이 영상 하나로 띄운다', e3);
  ok(e3.seen >= Math.min(3, e3.total) && e3.idUrls === e3.total, '30번에 여러 고양이가 나온다 (뽑는 목록이 영상을 빠짐없이 가리킨다)', e3);

  console.log('\n[영상이 안 열리면]');
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

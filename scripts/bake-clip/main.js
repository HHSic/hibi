// 초록 배경 원본 영상 → 앱에 싣는 «바꾼» 투명 반복 영상 (VP9 알파 webm) 굽기.
// assets/enter/cat.webm 을 이것으로 만들었다 (왜 굽는지는 renderer/anim/clip.js 설명 참고).
//
//   BAKE_SRC=원본.mp4 BAKE_DIR=작업폴더 BAKE_OUT=assets/enter/cat.webm npx electron scripts/bake-clip/main.js
//   BAKE_MODE=tune BAKE_KEYS='[{"choke":2},{"choke":3}]' … 로 키 값 여럿을 한 장씩 비교해 볼 수 있다
//
// 원본: Pixabay 영상 116648 «Cat, Pet, Green Screen»의 1920x1080 파일
//   (https://pixabay.com/videos/cat-pet-green-screen-green-nature-116648/). 원본은 저장소에 넣지 않는다.
// 보이지 않는 창에서만 돈다 — 화면에 아무것도 띄우지 않는다. ffmpeg 가 없어도 된다(크로미움 MediaRecorder).
// 주소·경로는 환경 변수로 넘긴다 (명령줄 인자에 주소를 넣으면 electron.exe 가 127 로 꺼졌다).
//
// 지금까지 본 문제와 고친 것:
//   · 윤곽에 노란·초록 테 — 주황 털과 초록이 섞인 점은 빨강이 높아 «배경 우세도»가 낮게 나와 불투명으로 남았다.
//     → 문턱을 낮추고, 가장자리를 깎고(choke), 섞인 색을 풀고(unmix), 가장자리는 초록을 (r+b)/2 까지 누른다.
//   · 반복 이음새 — 자세가 다른 두 순간을 섞으면 머리가 둘로 보인다.
//     → 비슷한 두 순간이 있으면 짧게 섞고, 없으면 «가만히 있는 두 순간» 사이를 앞뒤로 오간다(핑퐁).
//   · 첫 프레임이 뭉개진다 — 실시간 VP9 인코더는 시작할 때 화질이 낮다.
//     → 반복을 두 바퀴 넘게 녹화하고, 예열이 끝난 뒤의 키프레임부터 한 바퀴만 잘라 새 webm 으로 다시 싼다.
//       내용이 한 바퀴 주기로 되풀이되니 어느 프레임에서 잘라도 이음새는 그대로 매끄럽다.
//   · MediaRecorder 출력엔 길이(Duration)가 없다 → 다시 쌀 때 써 넣는다.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const E = process.env;
// 빠진 값은 창을 띄우기 전에 알린다 — 메인 프로세스에서 던지면 오류 대화상자가 화면에 뜨고 멈춘다
if (!E.BAKE_SRC || ((E.BAKE_MODE || 'bake') !== 'tune' && !E.BAKE_OUT)) {
  console.error('BAKE_SRC(원본 영상)와 BAKE_OUT(출력 webm, tune 이 아니면)을 환경 변수로 주세요.');
  process.exit(1);
}
const fileUrl = (p) => 'file:///' + p.split(path.sep).join('/');
const DIR = path.resolve(E.BAKE_DIR || path.join(require('os').tmpdir(), 'bake-clip'));
const OUT = E.BAKE_OUT ? path.resolve(E.BAKE_OUT) : null;
const P = {
  src: fileUrl(path.resolve(E.BAKE_SRC)),
  mode: E.BAKE_MODE || 'bake',
  maxH: Number(E.BAKE_MAXH || 760),
  bps: Number(E.BAKE_BPS || 3.5e6),
  kfi: Number(E.BAKE_KFI || 150),
  warm: Number(E.BAKE_WARM || 30),
  loop: E.BAKE_LOOP || 'auto',
  minLoop: Number(E.BAKE_MINLOOP || 8),
  xf: Number(E.BAKE_XF || 0.4),
  pingMin: Number(E.BAKE_PINGMIN || 4.5),
  pingMax: Number(E.BAKE_PINGMAX || 7),
  // cat.webm 을 구운 키 값 — 여러 조합을 tune 으로 나란히 놓고 윤곽(귀·수염)이 가장 깨끗한 것을 골랐다
  key: E.BAKE_KEY ? JSON.parse(E.BAKE_KEY) : { choke: 2, fill: 8, edgeDespill: 8, low: 0.04, high: 0.22, unmix: 0.6 },
  keys: E.BAKE_KEYS ? JSON.parse(E.BAKE_KEYS) : null
};
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 1500000).unref();

// ── WebM (EBML) ─────────────────────────────────────────
const ID = {
  EBML: 0x1A45DFA3, SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, CLUSTER: 0x1F43B675,
  TIMECODE: 0xE7, SIMPLE: 0xA3, GROUP: 0xA0, BLOCK: 0xA1, REF: 0xFB, DURATION: 0x4489, TCSCALE: 0x2AD7B1, VOID: 0xEC
};
// 크기를 모르는(unknown-size) Cluster 는 다음 Segment 수준 상자에서 끝난다
const SEGMENT_LEVEL = new Set([0x114D9B74, ID.INFO, ID.TRACKS, ID.CLUSTER, 0x1C53BB6B, 0x1941A469, 0x1043A770, 0x1254C367]);

function readVint(buf, p, keepMarker) {
  const b = buf[p];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  let v = keepMarker ? b : b & (mask - 1);
  let ones = (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + buf[p + i]; if (buf[p + i] !== 0xff) ones = false; }
  return { v, len, unknown: !keepMarker && ones };
}
function el(buf, p) {
  const id = readVint(buf, p, true);
  const sz = readVint(buf, p + id.len, false);
  const start = p + id.len + sz.len;
  return { id: id.v, at: p, start, end: sz.unknown ? null : start + sz.v };
}
const uintAt = (buf, s, e) => { let x = 0; for (let i = s; i < e; i++) x = x * 256 + buf[i]; return x; };

function parseWebm(buf) {
  const head = el(buf, 0);
  if (head.id !== ID.EBML) throw new Error('EBML 머리가 아니다');
  const seg = el(buf, head.end);
  if (seg.id !== ID.SEGMENT) throw new Error('Segment 가 아니다');
  const segEnd = seg.end || buf.length;
  const w = { ebml: buf.subarray(0, head.end), info: null, tracks: null, blocks: [], tcScale: 1e6, alphaMode: null, codec: null };
  let p = seg.start;
  while (p < segEnd) {
    const e = el(buf, p);
    if (e.id === ID.CLUSTER) {
      const cEnd = e.end || segEnd;
      let q = e.start, tc = 0;
      while (q < cEnd) {
        const c = el(buf, q);
        if (e.end == null && SEGMENT_LEVEL.has(c.id)) break;
        if (c.id === ID.TIMECODE) tc = uintAt(buf, c.start, c.end);
        else if (c.id === ID.SIMPLE) {
          const tr = readVint(buf, c.start, false);
          w.blocks.push({ bytes: buf.subarray(c.at, c.end), relAt: c.start + tr.len - c.at, track: tr.v,
            t: tc + buf.readInt16BE(c.start + tr.len), key: !!(buf[c.start + tr.len + 2] & 0x80) });
        } else if (c.id === ID.GROUP) {
          let r = c.start, key = true, blk = null;
          while (r < c.end) {
            const g = el(buf, r);
            if (g.id === ID.BLOCK) {
              const tr = readVint(buf, g.start, false);
              blk = { relAt: g.start + tr.len - c.at, track: tr.v, rel: buf.readInt16BE(g.start + tr.len) };
            } else if (g.id === ID.REF) key = false;
            r = g.end;
          }
          if (blk) w.blocks.push({ bytes: buf.subarray(c.at, c.end), relAt: blk.relAt, track: blk.track, t: tc + blk.rel, key });
        }
        q = c.end;
      }
      p = e.end != null ? e.end : q;
    } else {
      if (e.end == null) throw new Error('크기를 모르는 상자: ' + e.id.toString(16));
      if (e.id === ID.INFO) {
        w.info = e;
        for (let q = e.start; q < e.end;) { const c = el(buf, q); if (c.id === ID.TCSCALE) w.tcScale = uintAt(buf, c.start, c.end); q = c.end; }
      } else if (e.id === ID.TRACKS) {
        w.tracks = buf.subarray(e.at, e.end);
        const s = buf.subarray(e.at, e.end);
        const am = s.indexOf(Buffer.from([0x53, 0xC0]));
        if (am >= 0) w.alphaMode = s[am + 3];
        const cd = s.indexOf(Buffer.from('V_VP'));
        if (cd >= 0) w.codec = s.toString('latin1', cd, cd + 5);
      }
      p = e.end;
    }
  }
  return w;
}

const idBytes = (id) => { const h = id.toString(16); return Buffer.from(h.length % 2 ? '0' + h : h, 'hex'); };
const vsize = (n) => { const b = Buffer.alloc(8); b[0] = 0x01; let x = n; for (let i = 7; i >= 1; i--) { b[i] = x & 0xff; x = Math.floor(x / 256); } return b; };
const elem = (id, payload) => Buffer.concat([idBytes(id), vsize(payload.length), payload]);
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };

/** 녹화본에서 [from, from+count) 프레임만 남겨 새 webm 으로 싼다 — 시각은 0 부터, 길이도 적는다 */
function remuxRange(buf, from, count, frameMs) {
  const w = parseWebm(buf);
  const vids = w.blocks.filter((b) => b.track === 1);
  const keep = vids.slice(from, from + count);
  if (keep.length !== count) throw new Error(`프레임이 모자라다: ${keep.length}/${count}`);
  if (!keep[0].key) throw new Error('자르는 첫 프레임이 키프레임이 아니다');
  const cut = keep[0].t;
  const kids = [];
  for (let q = w.info.start; q < w.info.end;) { const c = el(buf, q); if (c.id !== ID.DURATION) kids.push(buf.subarray(c.at, c.end)); q = c.end; }
  const unitsPerMs = 1e6 / w.tcScale;
  const dur = Buffer.alloc(8);
  dur.writeDoubleBE((keep[keep.length - 1].t - cut) + frameMs * unitsPerMs);
  const info = elem(ID.INFO, Buffer.concat([...kids, elem(ID.DURATION, dur)]));
  const clusters = [];
  for (let i = 0; i < keep.length; i += 30) {
    const part = keep.slice(i, i + 30);
    const ctc = part[0].t - cut;
    const items = [elem(ID.TIMECODE, u64(ctc))];
    for (const b of part) {
      const copy = Buffer.from(b.bytes);
      copy.writeInt16BE(b.t - cut - ctc, b.relAt);
      items.push(copy);
    }
    clusters.push(elem(ID.CLUSTER, Buffer.concat(items)));
  }
  return Buffer.concat([w.ebml, elem(ID.SEGMENT, Buffer.concat([info, w.tracks, ...clusters]))]);
}

function stats(buf) {
  const w = parseWebm(buf);
  const v = w.blocks.filter((b) => b.track === 1);
  const d = [];
  for (let i = 1; i < v.length; i++) d.push(v[i].t - v[i - 1].t);
  const s = d.slice().sort((a, b) => a - b);
  return {
    codec: w.codec, alphaMode: w.alphaMode, frames: v.length, keys: v.map((b, i) => (b.key ? i : -1)).filter((i) => i >= 0).slice(0, 12),
    stepMin: s[0], stepMedian: s[Math.floor(s.length / 2)], stepMax: s[s.length - 1], gapsOver50: d.filter((x) => x > 50).length
  };
}

app.whenReady().then(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const page = path.join(DIR, 'bake-clip.html');
  fs.writeFileSync(page, `<!doctype html><body><script>window.BAKE = ${JSON.stringify(P)};</script>
<script src="${fileUrl(path.join(__dirname, 'page.js'))}"></script></body>`);

  ipcMain.on('log', (_e, m) => console.log(' ', m));
  ipcMain.on('fail', (_e, m) => { console.error('실패:', m); app.exit(1); });
  ipcMain.on('webm', (e, { bytes, loopFrames }) => {
    try {
      bakeOut(e, bytes, loopFrames);
    } catch (err) {
      // 여기서 새면 오류 대화상자가 뜨고 화면 쪽은 'verify' 를 끝없이 기다린다
      console.error('실패:', (err && err.stack) || err);
      app.exit(1);
    }
  });
  function bakeOut(e, bytes, loopFrames) {
    const raw = Buffer.from(bytes);
    fs.writeFileSync(path.join(DIR, 'raw-recording.webm'), raw);
    const w = parseWebm(raw);
    const vids = w.blocks.filter((b) => b.track === 1);
    console.log('  녹화본:', (raw.length / 1048576).toFixed(2) + 'MB', JSON.stringify(stats(raw)));
    // 예열(P.warm 프레임)이 끝난 뒤 첫 키프레임에서 한 바퀴를 자른다
    let from = vids.findIndex((b, i) => i >= P.warm && b.key && i + loopFrames <= vids.length);
    const fallback = from < 0;
    if (fallback) from = 0;
    const out = remuxRange(raw, from, loopFrames, 1000 / 30);
    fs.writeFileSync(OUT, out);
    console.log('  구움:', OUT, (out.length / 1048576).toFixed(2) + 'MB', JSON.stringify({ from, fallback, ...stats(out) }));
    e.sender.send('verify', { url: fileUrl(OUT), from, fallback });
  }
  ipcMain.on('done', (_e, r) => {
    for (const [name, url] of Object.entries(r.shots || {})) {
      fs.writeFileSync(path.join(DIR, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
    delete r.shots;
    fs.writeFileSync(path.join(DIR, `report-${P.mode}.json`), JSON.stringify(r, null, 1));
    console.log(JSON.stringify(r, null, 1));
    app.exit(0);
  });
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadFile(page);
});

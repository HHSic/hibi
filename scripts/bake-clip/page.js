'use strict';
// scripts/bake-clip/main.js 가 보이지 않는 창에서 돌리는 쪽 — 누끼·자리 찾기·반복 고르기·녹화·검사.
const { ipcRenderer } = require('electron');
const P = window.BAKE;
const say = (m) => ipcRenderer.send('log', String(m));
// 원본과 같은 초당 프레임으로 굽는다 — 25fps 원본을 30fps 로 뽑으면 다섯 장마다 한 장이 겹쳐 걸음이 튄다
const FPS = P.fps || 30;
// 원본 영상의 컨테이너 초당 프레임 — 보통 FPS 와 같다. Pixabay 아기 고양이 영상은 25fps 로 찍은 것을 30fps 로
// 바꾸면서 6장마다 한 장(3번째)을 되풀이해 넣었다 — 그대로 구우면 1초에 5번 멈칫한다. srcFps 30 + drop 3/6 으로
// 그 장을 빼고 25fps 로 굽는다.
const SRC_FPS = P.srcFps || FPS;
const frameT = (i) => (i + 0.5) / SRC_FPS;   // 원본 i 번째 프레임의 한가운데 — 경계에 걸려 같은 프레임을 두 번 뽑지 않게
const outT = (n) => (n + 0.5) / FPS;         // 구운 영상 n 번째 프레임의 한가운데
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// flip — 좌우를 뒤집어 굽는다. 엉덩이가 원본 화면 끝에 잘린 고양이를, 잘린 쪽이 휴식 창 오른쪽 끝에
// 닿게 앉히려고 쓴다 (화면 밖에서 빼꼼 들어온 것처럼 보인다).
const VS = `
  attribute vec2 p;
  varying vec2 uv;
  varying vec2 oq;
  uniform vec4 crop;
  uniform float flip;
  void main() {
    vec2 q = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    oq = q;   // 출력 영상 좌표 (0=위, 1=아래) — 아래쪽을 서서히 지우는 데 쓴다
    if (flip > 0.5) q.x = 1.0 - q.x;
    uv = crop.xy + q * crop.zw;
    gl_Position = vec4(p, 0.0, 1.0);
  }`;
// blackScreen — 초록 대신 검은 바탕에서 찍은 영상. 배경 «우세도» 대신 밝기(가장 밝은 채널)로 가른다:
// 회색·갈색 털도 검은 천보다는 훨씬 밝다. 검은 바탕엔 번질 초록이 없으니 despill 은 하지 않는다.
const FS = `
  precision highp float;
  varying vec2 uv;
  varying vec2 oq;
  uniform sampler2D tex;
  uniform vec2 maskTexel;
  uniform float fadeBottom;
  uniform vec2 texel;
  uniform vec3 bg;
  uniform float low, high, darkFloor, choke, fill, unmix, edgeDespill, blackScreen, useMask, despillAll;
  uniform sampler2D maskTex;
  float keyA(vec2 st) {
    vec3 c = texture2D(tex, st).rgb;
    if (blackScreen > 0.5) return smoothstep(low, high, max(c.r, max(c.g, c.b)));
    float k = (c.g - max(c.r, c.b)) / max(c.g, darkFloor);
    return 1.0 - smoothstep(low, high, k);
  }
  float ringMin(vec2 st, float r) {
    vec2 d = texel * r;
    vec2 e = d * 0.7071;
    float m = 1.0;
    m = min(m, keyA(st + vec2(d.x, 0.0)));  m = min(m, keyA(st - vec2(d.x, 0.0)));
    m = min(m, keyA(st + vec2(0.0, d.y)));  m = min(m, keyA(st - vec2(0.0, d.y)));
    m = min(m, keyA(st + e));               m = min(m, keyA(st - e));
    m = min(m, keyA(st + vec2(e.x, -e.y))); m = min(m, keyA(st + vec2(-e.x, e.y)));
    return m;
  }
  void main() {
    vec3 c = texture2D(tex, uv).rgb;
    float a0 = keyA(uv);
    float a = a0;
    if (choke > 0.0) a = min(a0, mix(ringMin(uv, choke), a0, 0.35));
    if (fill > 0.0) a = max(a, step(0.5, ringMin(uv, fill)));
    // 검은 바탕 — 그늘진 가슴·등의 털은 밝기로는 바탕과 못 가른다(구멍이 숭숭 났다). CPU 가 저해상도로
    // «화면 가장자리와 이어지지 않은 빈 곳»을 메운 실루엣(maskTex)을 주면 그 안쪽은 불투명으로 채운다.
    // r = 구멍 메운 몸 안쪽(→ 불투명), a = 몸을 조금 넓힌 바깥 경계(→ 그 밖의 바탕 무늬·먼지는 지운다)
    if (useMask > 0.5) {
      // 저해상도(320px) 마스크를 그대로 쓰면 경계가 계단처럼 각졌다 — 둘레 9점 평균으로 부드럽게
      vec4 mt = vec4(0.0);
      for (int iy = -1; iy <= 1; iy++) {
        for (int ix = -1; ix <= 1; ix++) mt += texture2D(maskTex, uv + vec2(float(ix), float(iy)) * maskTexel * 1.5);
      }
      mt /= 9.0;
      a = max(a, smoothstep(0.35, 0.9, mt.r));
      a *= smoothstep(0.1, 0.6, mt.a);
    }
    vec3 f = c;
    if (unmix > 0.0 && a > 0.02) {
      vec3 u = clamp((c - (1.0 - a) * bg) / max(a, 0.4), 0.0, 1.0);
      f = mix(c, u, unmix * (1.0 - smoothstep(0.7, 1.0, a)));
      if (blackScreen < 0.5) f.g = max(f.g, min(c.g, (f.r + f.b) * 0.5));
    }
    if (blackScreen < 0.5) {
      float edge = edgeDespill > 0.0 ? 1.0 - ringMin(uv, edgeDespill) : 0.0;
      // 안쪽은 보통 max(r,b) 까지만 누른다(노란 눈이 누렇게 죽지 않게). 회색 줄무늬 털이 초록 조명을 흠뻑
      // 받은 영상은 그러면 몸 전체가 올리브색으로 남는다 — despillAll 을 올리면 안쪽도 (r+b)/2 쪽으로 누른다.
      float gIn = min(f.g, mix(max(f.r, f.b), (f.r + f.b) * 0.5, despillAll));
      float gEdge = min(f.g, (f.r + f.b) * 0.5);
      f.g = mix(gIn, gEdge, clamp(edge, 0.0, 1.0));
    }
    // 아래쪽 fadeBottom 만큼을 서서히 투명하게 — 화면 아래 끝에 앉는 큰 고양이의 배 밑이 딱 잘린 선·그늘 덩어리로
    // 보이지 않고 바닥으로 스며들게
    if (fadeBottom > 0.0) a *= 1.0 - smoothstep(1.0 - fadeBottom, 1.0, oq.y);
    gl_FragColor = vec4(f, a);
  }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function makeKeyer(canvas) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: false, preserveDrawingBuffer: true });
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const texParams = () => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // 1번 칸: 실루엣 마스크 (검은 바탕일 때만 쓴다)
  gl.activeTexture(gl.TEXTURE1);
  const maskTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  texParams();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, 1, 1, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, new Uint8Array([0, 255]));
  // 0번 칸: 영상 프레임
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  texParams();
  const NAMES = ['low', 'high', 'darkFloor', 'choke', 'fill', 'unmix', 'edgeDespill', 'blackScreen', 'flip', 'despillAll', 'fadeBottom'];
  const U = {};
  for (const n of [...NAMES, 'texel', 'bg', 'crop', 'useMask', 'maskTexel']) U[n] = gl.getUniformLocation(prog, n);
  gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'maskTex'), 1);
  gl.clearColor(0, 0, 0, 0);
  return {
    gl,
    draw(src, key, box, W, H, mask) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform2f(U.texel, 1 / W, 1 / H);
      gl.uniform3f(U.bg, key.bg[0], key.bg[1], key.bg[2]);
      for (const n of NAMES) gl.uniform1f(U[n], Number(key[n]) || 0);
      gl.uniform1f(U.useMask, mask ? 1 : 0);
      gl.uniform2f(U.maskTexel, mask ? 1 / mask.w : 0, mask ? 1 / mask.h : 0);
      if (mask) {
        gl.activeTexture(gl.TEXTURE1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, mask.w, mask.h, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, mask.data);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.uniform4f(U.crop, box[0] / W, box[1] / H, box[2] / W, box[3] / H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}

async function openVideo(url) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('영상을 못 열었다: ' + url)); });
  return v;
}
const seek = (v, t) => new Promise((r) => { v.onseeked = () => r(); v.currentTime = t; });
function canvas2d(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}
// 휴식 창 바탕을 흉내 — 어두운 쪽(보통)과 밝은 회색(밝은 바탕화면이 흐려진 경우)
function paint(ctx, x, y, w, h, kind) {
  if (kind === 'gray') { ctx.fillStyle = '#8f949c'; ctx.fillRect(x, y, w, h); return; }
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#2a3140'); g.addColorStop(1, '#141820');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(16,16,20,0.56)'; ctx.fillRect(x, y, w, h);
}
// 비교 그림 — 한 줄에 [전체(절반) 어두운 바탕][왼쪽 위 2배][왼쪽 가운데 2배 회색][전체(절반) 회색]
function makeSheet(ow, oh) {
  const zoomA = [Math.round(ow * 0.04), 0, Math.round(ow * 0.36), Math.round(oh * 0.3)];
  const zoomB = [0, Math.round(oh * 0.36), Math.round(ow * 0.32), Math.round(oh * 0.32)];
  return function sheet(rows) {
    const Z = 2, hw = Math.round(ow / 2), hh = Math.round(oh / 2);
    const rowH = Math.max(hh, zoomA[3] * Z, zoomB[3] * Z);
    const SW = hw * 2 + zoomA[2] * Z + zoomB[2] * Z + 30, SH = rows.length * rowH + (rows.length - 1) * 10;
    const [sc, s] = canvas2d(SW, SH);
    s.fillStyle = '#000'; s.fillRect(0, 0, SW, SH);
    rows.forEach((src, ri) => {
      const y = ri * (rowH + 10);
      let x = 0;
      paint(s, x, y, hw, hh, 'dark'); s.drawImage(src, 0, 0, ow, oh, x, y, hw, hh); x += hw + 10;
      s.imageSmoothingEnabled = false;
      paint(s, x, y, zoomA[2] * Z, zoomA[3] * Z, 'dark'); s.drawImage(src, ...zoomA, x, y, zoomA[2] * Z, zoomA[3] * Z); x += zoomA[2] * Z + 10;
      paint(s, x, y, zoomB[2] * Z, zoomB[3] * Z, 'gray'); s.drawImage(src, ...zoomB, x, y, zoomB[2] * Z, zoomB[3] * Z); x += zoomB[2] * Z + 10;
      s.imageSmoothingEnabled = true;
      paint(s, x, y, hw, hh, 'gray'); s.drawImage(src, 0, 0, ow, oh, x, y, hw, hh);
    });
    return sc.toDataURL('image/png');
  };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  if (P.framesDir) return mainFrames();
  const A = await openVideo(P.src);
  const B = await openVideo(P.src);
  const W = A.videoWidth, H = A.videoHeight;
  const NSRC = Math.floor(A.duration * SRC_FPS + 1e-6);
  // 쓸 구간 — 자리 찾기·반복 고르기·프레임 뽑기 모두 이 안에서만 한다
  const F0 = P.range ? Math.max(0, Math.floor(P.range[0] * SRC_FPS)) : 0;
  const F1 = P.range ? Math.min(NSRC, Math.floor(P.range[1] * SRC_FPS)) : NSRC;
  // 쓸 원본 프레임 번호 — 되풀이해 넣은 장(drop)은 뺀다. 아래 반복 고르기·프레임 만들기는 이 목록의 «자리»로 센다
  const SRC = [];
  for (let i = F0; i < F1; i++) if (!(P.drop && i % P.drop[1] === P.drop[0])) SRC.push(i);
  say(`원본 ${W}x${H} ${A.duration.toFixed(2)}s · 원본 ${SRC_FPS}fps → ${FPS}fps ≈ ${NSRC}프레임 · 쓸 구간 ${F0}~${F1} (${SRC.length}장)`);

  // ── 배경 색 ──
  await seek(A, frameT(F0 + 5));
  const [, px] = canvas2d(W, H);
  px.drawImage(A, 0, 0);
  const patch = (fx, fy) => {
    const d = px.getImageData(Math.floor(fx * W) - 5, Math.floor(fy * H) - 5, 10, 10).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return [r / 100, g / 100, b / 100];
  };
  const pts = [[0.02, 0.05], [0.98, 0.05], [0.02, 0.5], [0.98, 0.5], [0.5, 0.03], [0.2, 0.3], [0.8, 0.3]].map(([x, y]) => patch(x, y));
  const bg = [0, 1, 2].map((c) => pts.reduce((s, p) => s + p[c], 0) / pts.length);
  const key = { low: 0.03, high: 0.24, darkFloor: 0.12, choke: 1.5, fill: 6, unmix: 1, edgeDespill: 4, blackScreen: 0,
    ...(P.key || {}), flip: P.flip ? 1 : 0, bg: bg.map((v) => v / 255) };
  say(`배경 ${JSON.stringify(bg.map(Math.round))}${key.blackScreen ? ' (검은 바탕)' : ''}${key.flip ? ' · 좌우 뒤집음' : ''}`);

  const glc = document.createElement('canvas');
  const K = makeKeyer(glc);
  const gl = K.gl;

  // ── 검은 바탕: 구멍 메운 실루엣 ──
  // 원본 프레임을 320px 폭으로 줄여 «밝은 곳»을 잡고, 닫기(넓혔다 좁히기)로 작은 틈을 메운 뒤,
  // 화면 가장자리에서 번져 들어가 닿지 않는 빈 곳을 몸 안의 구멍으로 보고 채운다. 윤곽에서 몇 칸
  // 안쪽까지만 쓰고, 윤곽의 부드러운 털끝은 셰이더의 밝기 키에 맡긴다.
  const MW = 320, MH = Math.round((320 * H) / W);
  const [, mx] = canvas2d(MW, MH);
  function morph(src, r, erode) {
    const tmp = new Uint8Array(MW * MH), dst = new Uint8Array(MW * MH);
    const pre = new Int32Array(Math.max(MW, MH) + 1);
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) pre[x + 1] = pre[x] + src[y * MW + x];
      for (let x = 0; x < MW; x++) {
        const a = Math.max(0, x - r), b = Math.min(MW, x + r + 1), n = pre[b] - pre[a];
        tmp[y * MW + x] = erode ? (n === b - a ? 1 : 0) : (n > 0 ? 1 : 0);
      }
    }
    for (let x = 0; x < MW; x++) {
      for (let y = 0; y < MH; y++) pre[y + 1] = pre[y] + tmp[y * MW + x];
      for (let y = 0; y < MH; y++) {
        const a = Math.max(0, y - r), b = Math.min(MH, y + r + 1), n = pre[b] - pre[a];
        dst[y * MW + x] = erode ? (n === b - a ? 1 : 0) : (n > 0 ? 1 : 0);
      }
    }
    return dst;
  }
  function holeMask(video, k = key) {
    if (!k.blackScreen) return null;
    mx.drawImage(video, 0, 0, MW, MH);
    const d = mx.getImageData(0, 0, MW, MH).data;
    const N = MW * MH;
    const thr = (k.maskThr || 0.1) * 255;
    let on = new Uint8Array(N);
    for (let i = 0; i < N; i++) on[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) > thr ? 1 : 0;
    if (P.roi) {
      // 쓸 영역(원본 px) 밖은 처음부터 어두운 바탕으로 본다 — 바깥 경계 마스크도 0 이 되어 셰이더가 지운다
      const rx0 = (P.roi[0] / W) * MW, ry0 = (P.roi[1] / H) * MH, rx1 = (P.roi[2] / W) * MW, ry1 = (P.roi[3] / H) * MH;
      for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1) on[y * MW + x] = 0;
    }
    const R = k.maskClose || 6;
    on = morph(morph(on, R, false), R, true);
    // 닫기는 쓸 영역 경계를 넘어 부풀었다 줄어든다 — 경계에 걸친 틈(꼬리와 앞발 사이 그늘)이 막혀 몸으로 잡혔다.
    // 닫은 뒤에 영역 밖을 다시 비운다.
    if (P.roi) {
      const qx0 = (P.roi[0] / W) * MW, qy0 = (P.roi[1] / H) * MH, qx1 = (P.roi[2] / W) * MW, qy1 = (P.roi[3] / H) * MH;
      for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (x < qx0 || x >= qx1 || y < qy0 || y >= qy1) on[y * MW + x] = 0;
    }
    // 가장 큰 밝은 덩어리만 몸이다 — 바탕 천의 밝은 주름·먼지 같은 작은 덩어리는 버린다
    const label = new Int32Array(N);
    let best = 0, bestSize = 0, next = 0;
    for (let i0 = 0; i0 < N; i0++) {
      if (!on[i0] || label[i0]) continue;
      next++;
      let size = 0;
      const st = [i0];
      label[i0] = next;
      while (st.length) {
        const i = st.pop(), x = i % MW;
        size++;
        const nb = [x > 0 ? i - 1 : -1, x < MW - 1 ? i + 1 : -1, i - MW, i + MW];
        for (const j of nb) if (j >= 0 && j < N && on[j] && !label[j]) { label[j] = next; st.push(j); }
      }
      if (size > bestSize) { bestSize = size; best = next; }
    }
    // 밝은 덩어리가 하나도 없으면(best=0) 모든 점이 «0번 덩어리»와 같아 통째로 불투명해진다 — 빈 마스크를 준다
    if (!bestSize) return { w: MW, h: MH, data: new Uint8Array(N * 2) };
    for (let i = 0; i < N; i++) on[i] = label[i] === best ? 1 : 0;
    const outside = new Uint8Array(N);
    const stack = [];
    const push = (i) => { if (!on[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
    for (let x = 0; x < MW; x++) { push(x); push((MH - 1) * MW + x); }
    for (let y = 0; y < MH; y++) { push(y * MW); push(y * MW + MW - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % MW, y = (i / MW) | 0;
      if (x > 0) push(i - 1);
      if (x < MW - 1) push(i + 1);
      if (y > 0) push(i - MW);
      if (y < MH - 1) push(i + MW);
    }
    const filled = new Uint8Array(N);
    for (let i = 0; i < N; i++) filled[i] = outside[i] ? 0 : 1;
    const inner = morph(filled, k.maskInset || 3, true);
    const outer = morph(filled, k.maskOutset || 4, false);
    const out = new Uint8Array(N * 2);
    for (let i = 0; i < N; i++) { out[i * 2] = inner[i] ? 255 : 0; out[i * 2 + 1] = outer[i] ? 255 : 0; }
    return { w: MW, h: MH, data: out };
  }

  // ── 고양이 자리 (전 구간) — 원본 좌표로 재야 하니 뒤집지 않고 잰다 ──
  const findKey = { ...key, flip: 0, fadeBottom: 0 };
  const DW = 960, DH = Math.round((DW * H) / W);
  glc.width = DW; glc.height = DH;
  const buf = new Uint8Array(DW * DH * 4);
  let bx0 = DW, by0 = DH, bx1 = -1, by1 = -1, stripTop = DH;
  for (let i = F0 + 3; i < F1 - 3; i += 5) {
    await seek(A, frameT(i));
    K.draw(A, findKey, [0, 0, W, H], W, H, holeMask(A, findKey));
    gl.readPixels(0, 0, DW, DH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    for (let y = 0; y < DH; y++) {
      const row = (DH - 1 - y) * DW;
      let cnt = 0, rx0 = DW, rx1 = -1, edgeL = 0, edgeR = 0;
      const Z = Math.round(DW * 0.1);
      for (let x = 0; x < DW; x++) {
        if (buf[(row + x) * 4 + 3] > 140) {
          cnt++; if (x < rx0) rx0 = x; rx1 = x;
          if (x < Z) edgeL++; else if (x >= DW - Z) edgeR++;
        }
      }
      // 아래쪽에서 화면 양 끝까지 이어진 줄은 고양이가 아니라 앉은 받침(밝은 초록 띠)이다
      if (y > DH * 0.8 && edgeL > Z * 0.5 && edgeR > Z * 0.5) { stripTop = Math.min(stripTop, y); continue; }
      if (cnt >= 2) { bx0 = Math.min(bx0, rx0); bx1 = Math.max(bx1, rx1); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
    }
  }
  const sx = W / DW, sy = H / DH;
  let cx0 = bx0 * sx, cx1 = (bx1 + 1) * sx, cy0 = by0 * sy, cy1 = (Math.min(by1, stripTop - 1) + 1) * sy;
  const padX = (cx1 - cx0) * 0.05, padT = (cy1 - cy0) * 0.04;
  cx0 = Math.max(0, Math.floor(cx0 - padX)); cx1 = Math.min(W, Math.ceil(cx1 + padX));
  cy0 = Math.max(0, Math.floor(cy0 - padT)); cy1 = Math.min(H, Math.floor(cy1));
  if (P.roi) {
    cx0 = Math.max(cx0, P.roi[0]); cy0 = Math.max(cy0, P.roi[1]);
    cx1 = Math.min(cx1, P.roi[2]); cy1 = Math.min(cy1, P.roi[3]);
  }
  // 몸이 원본 화면 끝에 닿아 잘렸는가 — 앱이 그 쪽을 휴식 창 끝에 붙여 앉혀야 한다 (뒤집었으면 반대쪽)
  const touches = { left: cx0 <= 2, right: cx1 >= W - 2 };
  const cut = key.flip ? { left: touches.right, right: touches.left } : touches;
  const cw = cx1 - cx0, ch = cy1 - cy0;
  const scale = Math.min(1, P.maxH / ch);
  const ow = Math.round((cw * scale) / 2) * 2, oh = Math.round((ch * scale) / 2) * 2;
  const box = [cx0, cy0, cw, ch];
  glc.width = ow; glc.height = oh;
  say(`자리 ${JSON.stringify({ cx0, cy0, cw, ch })} → ${ow}x${oh} · 잘린 쪽 ${JSON.stringify(cut)}`);
  const keyed = async (v, i, k = key) => { await seek(v, frameT(i)); K.draw(v, k, box, W, H, holeMask(v, k)); return glc; };

  const shots = {};
  const sheet = makeSheet(ow, oh);
  const snap = (src) => { const [c, x] = canvas2d(ow, oh); x.drawImage(src, 0, 0); return c; };

  if (P.mode === 'tune') {
    const sets = P.keys || [{}];
    const times = [F0 + 5, Math.floor(F0 + (F1 - F0) * 0.6)];
    for (let si = 0; si < sets.length; si++) {
      const k = { ...key, ...sets[si] };
      const rows = [];
      for (const t of times) rows.push(snap(await keyed(A, t, k)));
      shots[`tune-${si}`] = sheet(rows);
    }
    ipcRenderer.send('done', { mode: 'tune', key, sets, box, out: [ow, oh], cut, shots });
    return;
  }

  return bakeLoop({ SRC, keyed, A, B, glc, ow, oh, sheet, shots, key, box, cut });
}

// ── 밖에서 만든 투명 프레임 묶음 (AI 누끼 등) ──────────────────────
// P.framesDir 의 PNG 들을 이름 순서대로 쓴다. 이미 투명하고 고양이 자리로 잘려 있다고 본다 — 누끼·자리 찾기는 안 한다.
async function mainFrames() {
  const fs = require('fs');
  const path = require('path');
  const names = fs.readdirSync(P.framesDir).filter((n) => /[.]png$/i.test(n)).sort();
  if (!names.length) throw new Error('프레임 PNG 가 없다: ' + P.framesDir);
  const blobs = names.map((n) => new Blob([fs.readFileSync(path.join(P.framesDir, n))], { type: 'image/png' }));
  const first = await createImageBitmap(blobs[0]);
  const W = first.width, H = first.height;
  first.close();
  const scale = Math.min(1, P.maxH / H);
  const ow = Math.round((W * scale) / 2) * 2, oh = Math.round((H * scale) / 2) * 2;
  const [glc, gx] = canvas2d(ow, oh);
  const keyed = async (_v, i) => {
    const b = await createImageBitmap(blobs[i]);
    gx.clearRect(0, 0, ow, oh);
    gx.drawImage(b, 0, 0, ow, oh);
    b.close();
    return glc;
  };
  say(`프레임 묶음 ${names.length}장 · ${W}x${H} → ${ow}x${oh} · ${FPS}fps`);
  return bakeLoop({ SRC: names.map((_n, i) => i), keyed, A: null, B: null, glc, ow, oh, sheet: makeSheet(ow, oh), shots: {},
    key: { framesDir: P.framesDir }, box: [0, 0, W, H], cut: { left: false, right: false } });
}

// ── 반복 고르기 · 프레임 만들기 · 녹화 · 검사 — 영상에서 누끼 딴 프레임이든 밖에서 만든 PNG 묶음이든 같다 ──
async function bakeLoop({ SRC, keyed, A, B, glc, ow, oh, sheet, shots, key, box, cut }) {
  const TW = 48, TH = Math.max(8, Math.round((TW * oh) / ow));
  const [, tx] = canvas2d(TW, TH);
  const STEP = 2;
  const thumbs = [];
  for (let i = 0; i < SRC.length; i += STEP) {
    await keyed(A, SRC[i]);
    tx.clearRect(0, 0, TW, TH);
    tx.drawImage(glc, 0, 0, TW, TH);
    const d = tx.getImageData(0, 0, TW, TH).data;
    const f = new Float32Array(d.length);
    for (let q = 0; q < d.length; q += 4) {
      const a = d[q + 3] / 255;
      f[q] = d[q] * a; f[q + 1] = d[q + 1] * a; f[q + 2] = d[q + 2] * a; f[q + 3] = d[q + 3];
    }
    thumbs.push({ frame: i, f });
  }
  const diff = (a, b) => { let s = 0; for (let q = 0; q < a.length; q++) s += Math.abs(a[q] - b[q]); return s / a.length; };
  const adj = [];
  for (let i = 0; i + 1 < thumbs.length; i++) adj.push(diff(thumbs[i].f, thumbs[i + 1].f));
  const baseline = median(adj);
  say(`움직임(2프레임 간격 차이) 곡선: ${adj.map((x) => x.toFixed(1)).join(' ')}`);

  // (1) 섞어 잇기 — 자세가 가장 비슷한 두 순간
  const XFn = Math.max(1, Math.round(P.xf * FPS));
  const minGap = Math.ceil((P.minLoop * FPS) / STEP);
  let xbest = null;
  for (let i = 0; i < thumbs.length; i++) {
    if (thumbs[i].frame < XFn + 3) continue;
    for (let j = i + minGap; j < thumbs.length; j++) {
      if (thumbs[j].frame > SRC.length - 3) continue;
      let s = 0, c = 0;
      for (let k2 = -2; k2 <= 2; k2++) {
        const a = thumbs[i + k2], b = thumbs[j + k2];
        if (a && b) { s += diff(a.f, b.f); c++; }
      }
      s /= c;
      if (!xbest || s < xbest.score) xbest = { i, j, score: s };
    }
  }
  // (2) 핑퐁 — 가만히 있는 두 순간 사이를 앞뒤로. 사이에는 움직임이 있는 편이 볼만하다.
  const still = (i) => { let s = 0, c = 0; for (let k2 = -1; k2 <= 1; k2++) if (adj[i + k2] != null) { s += adj[i + k2]; c++; } return s / c; };
  const PMIN = Math.round((P.pingMin * FPS) / STEP), PMAX = Math.round((P.pingMax * FPS) / STEP);
  let pbest = null;
  for (let i = 1; i + 2 < thumbs.length; i++) {
    for (let j = i + PMIN; j <= Math.min(i + PMAX, thumbs.length - 2); j++) {
      let inside = 0;
      for (let k2 = i; k2 < j; k2++) inside += adj[k2];
      inside /= j - i;
      const ends = still(i) + still(j);
      const score = ends - 0.5 * inside;
      if (!pbest || score < pbest.score) pbest = { i, j, score, ends, inside };
    }
  }
  if (!xbest && !pbest) throw new Error('영상이 너무 짧아 반복을 만들 수 없다 (BAKE_MINLOOP·BAKE_PINGMIN 을 줄여 볼 것)');
  const useX = !!xbest && (P.loop === 'xfade' || !pbest || (P.loop === 'auto' && xbest.score <= baseline * 1.6));
  say(`섞어 잇기 최선 ${xbest ? `${thumbs[xbest.i].frame}→${thumbs[xbest.j].frame} 차이 ${xbest.score.toFixed(2)}` : '없음'} (평소 ${baseline.toFixed(2)}) · ` +
    `핑퐁 최선 ${pbest ? `${thumbs[pbest.i].frame}↔${thumbs[pbest.j].frame} 끝 움직임 ${pbest.ends.toFixed(2)} 사이 ${pbest.inside.toFixed(2)}` : '없음'} → ${useX ? '섞어 잇기' : '핑퐁'}`);

  // ── 프레임 만들기 — 고유 프레임(frames)과 한 바퀴 순서(seq) ──
  const [fa, fax] = canvas2d(ow, oh);
  const [fb, fbx] = canvas2d(ow, oh);
  const frames = [];
  const seq = [];
  const toBlob = () => new Promise((r) => fa.toBlob(r, 'image/webp', 0.98));
  const t0 = performance.now();
  let loopInfo;
  if (useX) {
    const start = thumbs[xbest.i].frame, end = thumbs[xbest.j].frame, L = end - start;
    for (let n = 0; n < L; n++) {
      await keyed(A, SRC[start + n]);
      fax.clearRect(0, 0, ow, oh);
      const bi = n - (L - XFn);
      if (bi >= 0) {
        const w = (bi + 1) / XFn;
        fbx.clearRect(0, 0, ow, oh);
        fbx.drawImage(glc, 0, 0);
        await keyed(B, SRC[start + n - L]);
        fax.globalCompositeOperation = 'lighter';
        fax.globalAlpha = 1 - w; fax.drawImage(fb, 0, 0);
        fax.globalAlpha = w; fax.drawImage(glc, 0, 0);
        fax.globalAlpha = 1; fax.globalCompositeOperation = 'source-over';
      } else {
        fax.drawImage(glc, 0, 0);
      }
      frames.push(await toBlob());
      seq.push(n);
    }
    loopInfo = { kind: 'xfade', start, end, score: +xbest.score.toFixed(2), xfFrames: XFn };
  } else {
    const a = thumbs[pbest.i].frame, b = thumbs[pbest.j].frame, u = b - a + 1;
    for (let n = 0; n < u; n++) {
      await keyed(A, SRC[a + n]);
      fax.clearRect(0, 0, ow, oh);
      fax.drawImage(glc, 0, 0);
      frames.push(await toBlob());
    }
    for (let n = 0; n < u; n++) seq.push(n);
    for (let n = u - 2; n >= 1; n--) seq.push(n);
    loopInfo = { kind: 'pingpong', a, b, ends: +pbest.ends.toFixed(2), inside: +pbest.inside.toFixed(2) };
  }
  const L = seq.length;
  loopInfo.seconds = +(L / FPS).toFixed(3);
  say(`고유 프레임 ${frames.length}장 · 한 바퀴 ${L}프레임 (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

  // ── 굽기 — 두 바퀴 넘게 녹화한다 (앞은 인코더 예열, 뒤에서 한 바퀴를 자른다) ──
  const [R, rx] = canvas2d(ow, oh);
  const stream = R.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: P.bps, videoKeyFrameIntervalCount: P.kfi
  });
  const chunks = [];
  rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  const TOTAL = Math.max(2 * L, L + P.warm + P.kfi + 5) + 5;
  const decode = (i) => (i < TOTAL ? createImageBitmap(frames[seq[i % L]]) : Promise.resolve(null));
  const pend = [decode(0), decode(1)];
  rec.start(1000);
  await sleep(150);
  const tStart = performance.now() + 50;
  let late = 0, worst = 0;
  for (let i = 0; i < TOTAL; i++) {
    const bmp = await pend.shift();
    pend.push(decode(i + 2));
    const due = tStart + (i * 1000) / FPS;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    const lag = performance.now() - due;
    if (lag > 12) late++;
    worst = Math.max(worst, lag);
    rx.clearRect(0, 0, ow, oh);
    rx.drawImage(bmp, 0, 0);
    track.requestFrame();
    bmp.close();
  }
  await sleep(100);
  rec.stop();
  await stopped;
  say(`녹화 ${TOTAL}프레임 — 늦은 프레임 ${late}장, 가장 늦음 ${worst.toFixed(1)}ms`);
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const vr = await new Promise((r) => { ipcRenderer.once('verify', (_e, x) => r(x)); ipcRenderer.send('webm', { bytes, loopFrames: L }); });

  // ── 검사 — 잘라 다시 싼 파일을 연다 ──
  const V = await openVideo(vr.url);
  const [, cx] = canvas2d(ow, oh);
  const grab = async (n) => { await seek(V, outT(n)); cx.clearRect(0, 0, ow, oh); cx.drawImage(V, 0, 0); return cx.getImageData(0, 0, ow, oh); };
  const imgDiff = (a, b) => { let s = 0, c = 0; for (let q = 0; q < a.data.length; q += 16) { for (let k2 = 0; k2 < 4; k2++) s += Math.abs(a.data[q + k2] - b.data[q + k2]); c += 4; } return s / c; };
  const srcOf = async (n) => {
    const bmp = await createImageBitmap(frames[seq[(vr.from + n) % L]]);
    const [, x] = canvas2d(ow, oh); x.drawImage(bmp, 0, 0); bmp.close();
    return x.getImageData(0, 0, ow, oh);
  };
  // 화질 — 구운 프레임이 구우려던 프레임과 얼마나 다른가 (처음이 뭉개졌는지)
  const quality = {};
  for (const n of [0, 3, Math.floor(L / 2), L - 1]) quality[n] = +imgDiff(await grab(n), await srcOf(n)).toFixed(2);
  const nA = Math.min(100, L - 2);
  const f0 = await grab(0), fLast = await grab(L - 1), fm = await grab(Math.floor(L / 2)), fa1 = await grab(nA), fa2 = await grab(nA + 1);
  let corners = 0;
  for (const img of [f0, fa1, fLast]) for (const [qx, qy] of [[2, 2], [ow - 3, 2], [2, Math.round(oh * 0.5)], [ow - 3, Math.round(oh * 0.5)]]) corners = Math.max(corners, img.data[(qy * ow + qx) * 4 + 3]);
  const toCanvas = (img) => { const [c, x] = canvas2d(ow, oh); x.putImageData(img, 0, 0); return c; };
  shots['baked-sheet'] = sheet([toCanvas(f0), toCanvas(fm), toCanvas(fLast)]);

  V.loop = true;
  V.currentTime = Math.max(0, V.duration - 0.35);
  await new Promise((r) => { V.onseeked = r; });
  const wrapped = await new Promise((r) => {
    const to = setTimeout(() => r(false), 3000);
    V.ontimeupdate = () => { if (V.currentTime < 0.3) { clearTimeout(to); r(true); } };
    V.play().catch(() => { clearTimeout(to); r('play-failed'); });
  });
  V.pause();

  ipcRenderer.send('done', {
    mode: 'bake', key, box, out: [ow, oh], fps: FPS, cut, loop: loopInfo, frames: L, cutFrom: vr.from, cutFallback: vr.fallback,
    baseline: +baseline.toFixed(2), duration: V.duration, maxBgAlpha: corners, quality,
    seamDiff: +imgDiff(fLast, f0).toFixed(2), neighborDiff: +imgDiff(fa1, fa2).toFixed(2),
    loopWraps: wrapped, recorderLate: late, recorderWorstMs: +worst.toFixed(1), shots
  });
}
main().catch((e) => ipcRenderer.send('fail', e.stack || e.message));

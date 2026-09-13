'use strict';
/**
 * 줄타기 — 가면 쓴 곡예사가 줄을 쏘며 화면 위쪽을 건너와, 거미줄을 치고, 거꾸로 매달려 같이 쉰다.
 *
 * 예전 거미줄(enter.js)은 선 몇 가닥이 늘어날 뿐이라 «누가» 쳤는지가 없었다.
 * 여기선 사람이 줄을 쏘고, 매달리고, 놓고, 돌고, 붙는 과정을 보여준다 — 그래야 거미줄이
 * 배경이 되는 순간이 하나의 «사건»이 된다.
 *
 * 누구를 닮으면 안 된다. 그래서 옷은 짙은 청록 한 가지, 눈은 가느다란 호박색 띠 하나,
 * 무늬 없음. 대신 긴 목도리를 달았다 — 뒤따르는 움직임이 제일 잘 보이는 부분이다.
 *
 * 움직임은 전부 t 의 식이다 (엔진 약속). 그래서:
 *  - 흔들림은 진자 각을 Θ·cos(위상)으로 쓴다. 끝에서 느리고 바닥에서 빠른 것이 저절로 나온다.
 *  - 줄을 놓고 나는 구간은 3차 에르미트로 잇는다. 놓는 순간과 잡는 순간의 «속도»까지 맞춰야
 *    이음매에서 몸이 튀지 않는다 (위치만 맞추면 꺾인다 — 눈은 속도의 꺾임을 더 잘 본다).
 *  - 목도리는 «목이 조금 전에 움직이던 방향»의 반대로 흘린다. 목 위치가 t 의 식이니
 *    과거도 그냥 계산하면 된다 — 적분 없이 뒤따르는 움직임이 나온다.
 *  - 줄에 걸리는 충격·출렁임은 감쇠 진동 식.
 *
 * 인물은 짙은 청록 옷 두 톤(그늘·빛 받는 쪽)에, 빛을 향한 가장자리에만 가는 테두리 빛(림 라이트).
 * v1 은 같은 굵기의 캡슐을 이어 붙이고 온몸에 청록 테두리를 둘러 «그림 문자»처럼 보였다(사용자: 조잡해).
 * 이번엔 마디마다 앞뒤 굵기가 다른 근육 윤곽(어깨·이두·아래팔, 허벅지·종아리)과 역삼각형 몸통,
 * 달걀꼴 머리를 감싼 눈띠, 장갑·장화·이음선을 둔다. 채색은 여전히 어둡게 — 휴식 글 뒤에서 시끄럽지 않게.
 * 빛은 휴식 글이 뜨는 화면 가운데에서 온다고 두었다 — 매달려 쉴 때 글 쪽 가장자리가 밝다.
 */
(() => {
  const NA = window.nunsAnim;
  if (!NA || !NA.scenes) return;
  const { clamp, lerp, span, ease } = NA.fx;
  const TAU = Math.PI * 2;
  const HALF = Math.PI / 2;
  const DEG = Math.PI / 180;
  const smooth = ease.smooth;
  const frac = (x) => x - Math.floor(x);

  // ── 움직임 도구 ─────────────────────────────────────────

  /** 3차 에르미트 — 양 끝의 위치와 속도를 함께 맞춘다 (s: 0..1, T: 구간 길이) */
  function herm(p0, v0, p1, v1, T, s) {
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * T * v0
      + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * T * v1;
  }

  /**
   * 감쇠 계단 응답 — x=0 에서 0 으로 출발해 target 을 넘었다가 가라앉는다.
   * v0 는 출발 속도. 줄에 몸무게가 걸리는 순간(위치는 그대로, 속도만 있음)을 이음매 없이 쓴다.
   */
  function settle(x, target, v0, freq, damp) {
    if (x <= 0) return 0;
    const w = TAU * freq, e = Math.exp(-damp * x);
    const sn = Math.sin(w * x);
    return target * (1 - e * (Math.cos(w * x) + (damp / w) * sn)) + (v0 / w) * e * sn;
  }

  /**
   * 키 [[t, v, 멈춤?], ...] 을 캣멀-롬으로 잇는다. 키마다 멈추면(smoothstep) 로봇처럼
   * 딱딱 끊긴다 — 지나가는 키는 앞뒤 키를 보고 속도를 정해 흘러가게 한다.
   * 세 번째 값이 1 이면 그 키에서는 속도 0 (자세를 잠깐 «잡는» 곳).
   */
  function track(keys, t) {
    const n = keys.length;
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0;
    while (i < n - 2 && t >= keys[i + 1][0]) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    const T = k1[0] - k0[0];
    const m0 = (i > 0 && !k0[2]) ? (k1[1] - keys[i - 1][1]) / (k1[0] - keys[i - 1][0]) : 0;
    const m1 = (i + 2 < n && !k1[2]) ? (keys[i + 2][1] - k0[1]) / (keys[i + 2][0] - k0[0]) : 0;
    return herm(k0[1], m0, k1[1], m1, T, (t - k0[0]) / T);
  }

  /** 짧은 펄스 — 주기 per 마다 한 번, 길이 dur 동안 0→1→0. 경계에서 0 이라 이음매가 없다 */
  function pulse(t, per, dur, off = 0) {
    const p = frac((t + off) / per) * per;
    if (p > dur) return 0;
    return Math.sin((p / dur) * Math.PI) ** 2;
  }

  /**
   * 두 마디 IK — 어깨에서 손(또는 엉덩이에서 발)까지. 팔꿈치가 꺾일 방향은 (px,py) 쪽.
   * 손이 닿지 않으면 팔을 쭉 편 채 그 방향을 가리킨다.
   *
   * 팔꿈치 쪽을 «부호»로만 고르면, 꺾일 쪽이 팔 선과 거의 나란해지는 순간(몸이 돌 때) 팔꿈치가
   * 한 프레임에 반대편으로 건너뛴다. 그래서 꺾일 쪽이 팔 선에 수직인 정도만큼만 굽힌다 —
   * 나란해지면 팔이 곧게 «짧아져» 보이고(앞뒤로 꺾여 원근에 줄어든 것처럼), 튀지 않고 넘어간다.
   */
  function ik(sx, sy, tx, ty, l1, l2, px, py) {
    let dx = tx - sx, dy = ty - sy;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) { dx = 0; dy = 1; d = 1e-6; }
    const ux = dx / d, uy = dy / d;
    const dd = clamp(d, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9995);
    const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
    const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pl = Math.hypot(px, py);
    const q = pl > 1e-9 ? clamp((-uy * px + ux * py) / pl / 0.3, -1, 1) : 0;
    const b = hh * Math.sin(q * HALF);
    return [sx + ux * a - uy * b, sy + uy * a + ux * b, sx + ux * dd, sy + uy * dd];
  }

  // ── 몸 치수 (U = 화면 짧은 변 / 540) ──────────────────────
  // 길이만 여기 둔다 — 흔들기·매달리기 물리가 이 길이로 계산된다. 굵기는 아래 PROF·TORSO 표에.
  // 머리를 작게, 팔다리를 길게 — 곡예사 비율(머리 하나에 몸 7.5 쯤)이라야 쭉 뻗은 자세가 시원하게 읽힌다
  const RIG = {
    neck: 6.4, torso: 29, sh: 3.2,
    uarm: 18.5, farm: 17.5, thigh: 23.5, shin: 23, foot: 8.5
  };
  const HEAD_R = 7.2;                        // 머리 반 높이 (U) — 턱까지. 폭은 그보다 좁다
  const LEG = RIG.thigh + RIG.shin;          // 다리 전체 (U)
  const REACH = (RIG.uarm + RIG.farm) * 0.96; // 줄 잡은 팔 (U)
  const SHW = 11.5;                          // 정면일 때 어깨 관절이 가운데서 벌어지는 거리 (U)
  const GRIP0 = 3, GRIP1 = 27;               // V 를 잡은 손이 줄 따라 벌어지는 거리 — 옆모습·정면 (U)

  // ── 몸 모양 ─────────────────────────────────────────────
  // v1 은 굵기가 한결같은 캡슐(원통+반원)을 이어 붙여 막대 인형·그림 문자처럼 보였다.
  // 사람 몸은 마디 안에서도 굵기가 오르내리고, 앞뒤가 다르다: 어깨 세모근이 불룩하고 팔꿈치에서
  // 가늘어졌다가 아래팔 윗부분에서 다시 불룩, 손목에서 가늘다. 허벅지는 앞이, 종아리는 뒤가 불룩하다.
  // 그래서 마디마다 «앞쪽 굵기·뒤쪽 굵기» 표를 두고 그 점들을 곡선으로 잇는다.

  /** 마디별 굵기 [s, 앞, 뒤] — s: 마디 길이 비율(0 = 몸 쪽 관절), 굵기: 중심선에서 U */
  const PROF = {
    // 팔의 «앞»은 굽힘 안쪽(이두근). 어깨 쪽 시작을 조금 뒤로 빼 둥근 세모근 머리가 생긴다
    uarm: [[-0.02, 3.0, 3.2], [0.14, 3.6, 3.9], [0.34, 3.5, 3.6], [0.52, 3.3, 3.1], [0.76, 2.6, 2.7], [0.95, 2.3, 2.4], [1.02, 2.2, 2.3]],
    farm: [[0, 2.3, 2.4], [0.2, 2.8, 2.8], [0.45, 2.5, 2.4], [0.76, 1.95, 1.9], [1, 1.7, 1.7]],
    // 다리의 «앞»은 무릎이 향하는 쪽. 허벅지는 앞(넙다리네갈래근), 종아리는 뒤(장딴지근)가 불룩
    thigh: [[-0.04, 4.2, 4.7], [0.1, 5.0, 5.3], [0.34, 5.3, 4.7], [0.62, 4.4, 4.1], [0.87, 3.6, 3.4], [1.02, 3.4, 3.2]],
    shin: [[0, 3.3, 3.2], [0.2, 3.1, 4.2], [0.46, 2.8, 3.5], [0.72, 2.5, 2.6], [1, 2.2, 2.2]],
    neck: [[-0.3, 3.9, 4.1], [0.45, 3.0, 3.2], [1.1, 2.8, 3.0]]
  };
  /**
   * 몸통 [s, 옆모습 앞, 옆모습 뒤, 정면 반폭, 등뼈 앞뒤 휨] — s 는 골반(0)에서 목 밑(1)까지.
   * 옆모습에선 가슴·엉덩이가 앞뒤로 나오고 허리가 들어가며, 정면에선 어깨가 넓고 허리가 좁은 역삼각형.
   * 몸이 도는 정도(front)로 둘 사이를 섞는다 — 화면에서 몸통에 수직인 축 하나가 옆모습에선 앞뒤,
   * 정면에선 좌우이기 때문이다
   */
  const TORSO = [
    [-0.05, 3.6, 4.6, 4.0, -0.4],
    [0.05, 5.3, 6.4, 6.1, -0.4],
    [0.22, 5.0, 5.6, 5.9, -0.5],
    [0.40, 4.6, 4.3, 5.7, -0.8],
    [0.58, 5.6, 4.8, 6.9, -0.1],
    [0.74, 7.0, 6.0, 8.8, 0.8],
    [0.88, 6.3, 6.4, 10.8, 1.0],
    [0.97, 4.0, 4.8, 7.2, 0.7],
    [1.05, 2.9, 3.2, 3.3, 0.9]
  ];
  // 머리 — 옆모습(이마·눈띠·턱이 앞으로, 뒤통수가 뒤로)과 정면(위가 넓고 턱이 좁은 달걀).
  // 같은 순서의 점 14개라 고개를 돌리면 점끼리 섞여 부드럽게 돈다. 단위: 머리 반 높이, [앞, 위]
  const HEAD_S = [[0.05, 1], [0.52, 0.88], [0.8, 0.52], [0.9, 0.12], [0.88, -0.22], [0.78, -0.52], [0.58, -0.86],
    [0.22, -0.92], [-0.18, -0.72], [-0.52, -0.52], [-0.82, -0.14], [-0.88, 0.28], [-0.72, 0.68], [-0.38, 0.93]];
  const HEAD_F = [[0, 1], [0.46, 0.9], [0.72, 0.56], [0.78, 0.14], [0.74, -0.2], [0.6, -0.54], [0.32, -0.87],
    [0, -1], [-0.32, -0.87], [-0.6, -0.54], [-0.74, -0.2], [-0.78, 0.14], [-0.72, 0.56], [-0.46, 0.9]];
  // 손 — 줄을 쥔 주먹과 느슨하게 편 장갑 손. 같은 순서의 점 12개, [손목에서 손끝 쪽, 엄지 쪽] (U)
  // 주먹은 아래팔 끝보다 확실히 큰 덩어리여야 한다 — 손목과 같은 굵기면 2560 에서도 «막대 끝 혹»이었다.
  // 엄지 쪽에 볼록한 엄지 뭉치와 그 앞의 오목한 틈을 둔다: 가는 손가락 금은 줄이면 사라지지만 윤곽의 홈은 남는다
  const FIST = [[0, -2.1], [1.8, -2.9], [4.1, -3.2], [6.3, -2.8], [7.5, -1.4], [7.6, 0.5], [6.8, 2.0],
    [5.4, 2.1], [4.4, 3.5], [2.7, 3.7], [1.1, 2.9], [0, 2.1]];
  const OPEN = [[0, -1.8], [2.2, -2.2], [4.8, -2.2], [7.1, -1.7], [8.4, -0.8], [8.6, 0.4], [7.8, 1.3],
    [6.0, 1.7], [4.7, 2.4], [3.8, 3.5], [2.2, 3.0], [0.5, 2.0]];
  // 장화 — [발끝 쪽, 발바닥 쪽] (U). 발목이 원점
  const BOOT = [[-2.4, -3.3], [-2.9, -0.4], [-2.5, 2.1], [0.4, 2.7], [4.4, 2.5], [7.6, 1.9], [9.2, 0.9],
    [9.0, -0.5], [7.4, -1.2], [4.2, -1.8], [1.8, -3.4]];

  /**
   * 닫힌 점 고리를 부드러운 곡선으로 path 에 더한다 (점 사이 가운데를 지나는 2차 곡선).
   * 감는 방향을 늘 같게 맞춘다 — 조각마다 방향이 섞이면 nonzero 채우기에서 겹친 곳이 뚫린다.
   */
  function loop(p, pts) {
    const n = pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const q = area < 0 ? pts.slice().reverse() : pts;
    p.moveTo((q[n - 1][0] + q[0][0]) / 2, (q[n - 1][1] + q[0][1]) / 2);
    for (let i = 0; i < n; i++) {
      const a = q[i], b = q[(i + 1) % n];
      p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    p.closePath();
  }

  /** 굵기 표에서 s 자리의 [앞, 뒤] (선형) */
  function profAt(prof, s) {
    const n = prof.length;
    if (s <= prof[0][0]) return [prof[0][1], prof[0][2]];
    if (s >= prof[n - 1][0]) return [prof[n - 1][1], prof[n - 1][2]];
    let i = 0;
    while (i < n - 2 && s > prof[i + 1][0]) i++;
    const a = prof[i], b = prof[i + 1], k = (s - a[0]) / (b[0] - a[0]);
    return [lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  }

  /**
   * 마디 a→b 의 틀. ant 는 «앞쪽»을 가리키는 벡터이고 길이(0..1)만큼만 앞뒤를 다르게 한다 —
   * 팔다리를 곧게 펴 앞뒤를 알 수 없을 때 대칭으로 부드럽게 넘어가, 근육이 반대편으로 튀지 않는다.
   * 반환 [tx, ty, nx, ny, 길이, k] — k: +n 쪽이 앞쪽인 정도
   */
  function segFrame(a, b, ant) {
    let dx = b[0] - a[0], dy = b[1] - a[1];
    let L = Math.hypot(dx, dy);
    if (L < 1e-6) { dx = 0; dy = 1; L = 1e-6; } else { dx /= L; dy /= L; }
    const nx = -dy, ny = dx;
    const k = ant ? clamp(ant[0] * nx + ant[1] * ny, -1, 1) : 0;
    return [dx, dy, nx, ny, L, k];
  }
  const sideW = (prof, s, k) => {
    const w = profAt(prof, s), m = (w[0] + w[1]) / 2, d = (w[0] - w[1]) / 2;
    return [m + k * d, m - k * d];
  };

  /**
   * 팔다리 한 마디의 윤곽. s0..s1 로 일부만 잘라 쓸 수도 있다(장갑·장화 덧칠). 잘리지 않은 끝은
   * 반원으로 둥글린다 — 두 마디의 둥근 끝이 관절에서 겹쳐, 어떤 각으로 굽혀도 이음매가 매끈하다
   */
  function limbLoop(p, a, b, prof, U, ant, s0, s1) {
    const [tx, ty, nx, ny, L, k] = segFrame(a, b, ant);
    const first = prof[0][0], last = prof[prof.length - 1][0];
    const lo = s0 === undefined ? first : Math.max(first, s0);
    const hi = s1 === undefined ? last : Math.min(last, s1);
    const ss = [lo];
    for (const r of prof) if (r[0] > lo + 1e-3 && r[0] < hi - 1e-3) ss.push(r[0]);
    ss.push(hi);
    const P = [], M = [];
    for (const s of ss) {
      const [wp, wm] = sideW(prof, s, k);
      const cx = a[0] + tx * L * s, cy = a[1] + ty * L * s;
      P.push([cx + nx * wp * U, cy + ny * wp * U]);
      M.push([cx - nx * wm * U, cy - ny * wm * U]);
    }
    const pts = P.slice();
    const cap = (s, dir, from) => {
      const [wp, wm] = sideW(prof, s, k);
      const r = (wp + wm) / 2 * U;
      const cx = a[0] + tx * L * s, cy = a[1] + ty * L * s;
      for (const an of [45, 90, 135]) {
        const c = Math.cos(an * DEG) * from, sn = Math.sin(an * DEG);
        const w = (c > 0 ? wp : wm) * U;
        pts.push([cx + nx * w * c + tx * r * sn * dir, cy + ny * w * c + ty * r * sn * dir]);
      }
    };
    if (s1 === undefined || s1 >= last) cap(hi, 1, 1);
    for (let i = M.length - 1; i >= 0; i--) pts.push(M[i]);
    if (s0 === undefined || s0 <= first) cap(lo, -1, -1);
    loop(p, pts);
  }

  /** 마디를 가로지르는 이음선 — 원통을 감은 선이라 가운데가 bulge 만큼 휜다 */
  function crossSeam(sm, a, b, prof, U, ant, s, bulge) {
    const [tx, ty, nx, ny, L, k] = segFrame(a, b, ant);
    const [wp, wm] = sideW(prof, s, k);
    const cx = a[0] + tx * L * s, cy = a[1] + ty * L * s;
    const bl = bulge * (wp + wm) * U;
    sm.moveTo(cx + nx * wp * 0.97 * U, cy + ny * wp * 0.97 * U);
    sm.quadraticCurveTo(cx + tx * bl, cy + ty * bl, cx - nx * wm * 0.97 * U, cy - ny * wm * 0.97 * U);
  }

  /** 마디를 따라 내려가는 이음선 — side: 앞(+1)·뒤(-1) 굵기에 대한 비율 */
  function longSeam(sm, a, b, prof, U, ant, s0, s1, side) {
    const [tx, ty, nx, ny, L, k] = segFrame(a, b, ant);
    for (let i = 0; i <= 4; i++) {
      const s = lerp(s0, s1, i / 4);
      const [wp, wm] = sideW(prof, s, k);
      const o = (side > 0 ? wp : wm) * side * U;
      const x = a[0] + tx * L * s + nx * o, y = a[1] + ty * L * s + ny * o;
      if (i === 0) sm.moveTo(x, y); else sm.lineTo(x, y);
    }
  }

  /**
   * 관절이 굽은 쪽 — 가운데 관절 j 가 두 끝의 가운데에서 벗어난 방향(무릎·팔꿈치 끝이 향하는 쪽).
   * 곧게 펴면 길이가 0 으로 줄어 앞뒤 차이가 저절로 사라진다
   */
  function bendDir(a, j, b, scale) {
    const vx = j[0] - (a[0] + b[0]) / 2, vy = j[1] - (a[1] + b[1]) / 2;
    const d = Math.hypot(vx, vy);
    if (d < 1e-9) return [0, 0];
    const m = clamp(d / scale);
    return [vx / d * m, vy / d * m];
  }

  // ── 연출표 ─────────────────────────────────────────────
  // 초 단위. 1.6초 안에 두 번 흔들어 건너오고, 공중에서 돌며 양손으로 줄을 쏜다.
  // 글이 뜨는 1.8초엔 이미 왼쪽 위 꼭짓점에 매달려 있다 — 글과 동작이 겹치지 않게.
  const T = {
    att1: 0.11, catch1: 0.15, rel1: 0.60,
    shot2: 0.45, att2: 0.56, catch2: 0.74, rel2: 1.10,
    shotLR: 1.33, attL: 1.40, attR: 1.47, catchV: 1.52,
    inv0: 2.02, relV: 2.19, inv1: 2.32, impact: 2.64
  };

  // 몸 크기 배율. v1 은 건너오는 동안 몸이 줄 길이에 비해 작아 흔들기가 «점 하나가 날아간다»로만 읽혔다.
  // 나는 동안은 크게 두고, 거꾸로 뒤집혀 떨어지는 빠른 0.7초 사이에 조금 줄여 구석에서 쉴 때는
  // 화면을 누르지 않게 한다. 빨리 도는 중이라 크기가 변하는 것이 눈에 띄지 않는다
  const FIG_FLY = 1.42, FIG_REST = 1.2;
  function figK(t) { return lerp(FIG_FLY, FIG_REST, smooth(span(t, T.inv0, T.impact + 0.1))); }

  // 팔이 무엇을 하는지. m: 0=자세(FK), 1=줄 겨눔·잡음(anchors[k]), 2=꼭짓점 V 잡기, 3=팔짱.
  // b 는 앞 동작에서 넘어오는 시간 — 손 위치를 섞어 넘어가므로 순간이동이 없다.
  const ARM_F = [
    { t: -1, b: 0, m: 1, k: 0 },
    // 첫 줄을 놓으면 빈손도 곧장 다음 닻(A2) 쪽으로 뻗는다 — 두 팔이 같은 곳을 가리켜야 «잡으러 간다»가 읽힌다
    // 다만 앞팔과 똑같이 겨누면 옆모습에서 뒷팔이 앞팔 뒤에 통째로 숨는다 — 조금 낮게(몸 앞쪽), 팔꿈치를 굽혀
    { t: T.rel1, b: 0.08, m: 1, k: 1, rot: 0.42, r: 0.9 },
    { t: 0.80, b: 0.14, m: 0 },
    // 양손 쏘기 — 뒷손 겨눔을 등 쪽으로 비틀어 등 위로 뻗는다. 곧장 겨누면 가로누운 몸통을 따라 팔이 누워
    // 몸통 뒤에 숨었다(한 팔만 쏘는 것처럼 보였다)
    { t: T.shotLR - 0.03, b: 0.06, m: 1, k: 3, rot: -0.6, r: 0.9 },
    { t: 1.46, b: 0.07, m: 2, k: 3 },
    { t: T.relV - 0.04, b: 0.12, m: 0 },
    // 줄 끝 출렁임이 가라앉기 전에 팔짱으로 — 머리 양옆에 팔을 늘어뜨린 채 오래 두면 «바로 선 사람»으로 읽힌다
    { t: 2.9, b: 0.55, m: 3 }
  ];
  const ARM_N = [
    { t: -1, b: 0, m: 0 },
    { t: T.shot2 - 0.03, b: 0.06, m: 1, k: 1 },
    { t: T.rel2, b: 0.10, m: 0 },
    { t: T.shotLR - 0.03, b: 0.06, m: 1, k: 2 },
    { t: 1.44, b: 0.08, m: 2, k: 2 },
    { t: T.relV - 0.02, b: 0.12, m: 0 },
    { t: 3.0, b: 0.55, m: 3 }
  ];

  // 자세 곡선 — 각은 라디안. 엉덩이·어깨는 «앞으로»가 +, 무릎·팔꿈치는 굽힘이 +.
  // 흔들림 바닥에선 다리가 뒤로 끌리고, 끝에선 앞으로 차올리고, 나는 동안엔 웅크린다.
  const TR = {
    // 줄 끝에 걸려 출렁일 때(2.64~) 팔은 머리 «앞»으로 튕긴다. 머리 방향(≈π)으로 뻗었더니 옆모습에서
    // 두 팔이 머리를 덮어 머리가 사라졌다. 정면으로 돌고 나면 이 각이 그대로 늘어뜨린 «ㅅ» 팔이 된다
    // 0.75 의 뒷팔은 머리 위 줄 잡은 앞팔과 겹치지 않게 앞으로 덜 올리고(2.9→2.45) 팔꿈치를 굽힌다
    sF: [[0, 0.4], [0.6, 2.6], [0.75, 2.45], [0.95, 1.5], [1.12, 2.5], [1.3, 1.8], [2.1, 3.0], [2.3, 2.4], [2.64, 2.3], [2.85, 2.5], [3.1, 2.65]],
    eF: [[0, 0.3], [0.6, 0.3], [0.75, 1.0], [0.95, 1.4], [1.12, 0.3], [1.3, 0.6], [2.1, 0.2], [2.3, 0.6], [2.64, 0.5], [2.85, 0.5], [3.1, 0.35]],
    sN: [[0, -0.4], [0.2, -0.7], [0.35, -1.0], [0.42, 0.2], [1.1, 2.7], [1.2, 1.6], [1.3, 1.4], [2.1, 3.0], [2.3, 2.0], [2.64, 2.2], [2.9, 2.45], [3.2, 2.65]],
    eN: [[0, 0.8], [0.2, 0.5], [0.35, 0.3], [0.42, 0.3], [1.1, 0.4], [1.2, 1.9], [1.3, 1.0], [2.1, 0.2], [2.3, 0.8], [2.64, 0.4], [2.9, 0.5], [3.2, 0.35]],
    // 줄을 놓고 나는 동안(0.60~0.74)은 무릎을 가슴까지 끌어안는다 — 다리를 뻗고 있으면 다리가 앞장서
    // 떨어지는 것처럼 읽혔다. 다리가 작게 접히면 다음 줄로 뻗은 두 팔이 실루엣을 이긴다
    hipN: [[0, -0.2], [0.15, -0.1], [0.36, -0.75], [0.56, 0.9], [0.67, 2.1], [0.76, 0.5], [0.92, -0.75], [1.08, 0.9], [1.22, 2.0], [1.38, 1.7], [1.50, 0.3], [1.62, -0.5], [1.85, 0.25], [1.97, -0.3], [2.10, 1.9], [2.28, 0.1], [2.4, 0]],
    kneeN: [[0, 0.6], [0.15, 0.3], [0.36, 1.1], [0.56, 0.6], [0.67, 2.4], [0.76, 0.8], [0.92, 1.2], [1.08, 0.4], [1.22, 2.3], [1.38, 2.0], [1.50, 0.5], [1.62, 0.9], [1.85, 0.5], [1.97, 0.7], [2.10, 1.5], [2.28, 0.1], [2.4, 0]],
    hipF: [[0, 0.3], [0.15, 0.2], [0.36, -0.35], [0.56, 1.2], [0.67, 2.3], [0.76, 0.7], [0.92, -0.45], [1.08, 1.2], [1.22, 2.1], [1.38, 1.9], [1.50, -0.1], [1.62, 0.5], [1.85, -0.2], [1.97, -0.4], [2.10, 2.1], [2.28, 0.25], [2.64, 0.3], [2.8, 0.95], [3.2, 0.45]],
    kneeF: [[0, 1.0], [0.15, 0.7], [0.36, 1.5], [0.56, 0.9], [0.67, 2.5], [0.76, 1.1], [0.92, 1.6], [1.08, 0.8], [1.22, 2.4], [1.38, 2.2], [1.50, 0.4], [1.62, 0.4], [1.85, 0.9], [1.97, 0.9], [2.10, 1.8], [2.28, 0.3], [2.64, 0.6], [2.8, 2.0], [3.2, 1.5]],
    legIK: [[2.22, 0], [2.32, 1]],
    curl: [[0, 0.05], [1.2, 0.35], [1.4, 0.25], [1.52, 0], [1.97, -0.15], [2.1, 0.4], [2.3, 0], [2.64, 0, 1]],
    tilt: [[0, 0.1], [1.2, 0.5], [1.45, 0.1], [1.6, -0.15], [1.8, 0.05], [2.1, 0.4], [2.35, 0], [2.64, 0]],
    look: [[0, 1], [1.58, 1], [1.72, 0.12, 1], [1.95, 0.2], [2.06, 1], [2.7, 1], [3.2, 0.1]],
    // 몸이 이쪽으로 도는 정도 — 옆모습(0) → 정면(1).
    // V 에 두 손으로 매달릴 땐 3/4 쯤 돌아 줄을 넓게 잡는다. 옆모습 그대로면 머리 위로 올린
    // 두 팔이 머리를 꿰뚫은 막대처럼 보였다(글이 뜨는 순간이라 더 눈에 띄었다).
    // 다리를 넘기기 전엔 다시 옆모습, 줄 끝에 걸린 충격으로 돌아 정면에서 쉰다
    front: [[1.50, 0, 1], [1.68, 0.8, 1], [1.90, 0.8, 1], [2.04, 0, 1], [2.66, 0, 1], [3.05, 1, 1]]
  };

  // ── 몸의 길: 골반 위치 [x, y] + 몸이 향하는 각 a (골반→머리) ──────

  /** 꼭짓점 V — 몸무게가 걸리면 처지고 출렁인다 */
  function vAt(st, t) {
    let y = st.V0[1];
    if (t > T.catchV) y += settle(t - T.catchV, st.sagHang, st.dipV0, 2.3, 3.2);
    if (t > T.impact) y += settle(t - T.impact, st.sagDrop, st.vImp * 0.16, 1.8, 2.6);
    return [st.V0[0], y];
  }

  /** 진자 흔들림 — 줄 잡은 어깨가 닻 A 에서 L 만큼. 몸은 줄보다 조금 늦고 조금 더 기운다 */
  function evalSwing(st, sg, t) {
    const dph = (sg.ph1 - sg.ph0) / (sg.t1 - sg.t0);
    const ph = sg.ph0 + dph * (t - sg.t0);
    const th = sg.Th * Math.cos(ph);
    const dth = -sg.Th * Math.sin(ph) * dph;
    const sx = sg.A[0] + sg.L * sg.kx * Math.sin(th);
    const sy = sg.A[1] + sg.L * Math.cos(th);
    // 바닥에선 다리가 뒤에 끌리고(dth 항), 끝에선 줄보다 더 들린다(th 항) — 두 마디 진자의 늦음
    // 잡은 직후엔 날아오던 몸 방향이 남아 있다가(off) 줄에 끌려 임계 감쇠로 줄 방향에 맞춰진다
    let off = 0;
    if (sg.offK) {
      const tau = t - sg.t0, k = sg.offK;
      off = tau > 0 ? Math.exp(-k * tau) * (sg.off0 + (sg.offV + k * sg.off0) * tau) : sg.off0 + sg.offV * tau;
    }
    const a = Math.atan2(sg.A[1] - sy, sg.A[0] - sx) + 0.05 * dth - 0.16 * th + off;
    const TS = st.TS * figK(t);
    return [sx - Math.cos(a) * TS, sy - Math.sin(a) * TS, a];
  }

  /** V 에 두 손으로 매달림 — 날아온 속도 그대로 한 번 크게 흔들리고 가라앉는다 */
  function evalHangY(st, t) {
    const tau = Math.max(0, t - T.catchV);
    const om = TAU * 0.95, z = 1.6;
    const e = Math.exp(-z * tau);
    const psi = e * (st.psiV0 / om) * Math.sin(om * tau);
    const dpsi = e * st.psiV0 * (Math.cos(om * tau) - (z / om) * Math.sin(om * tau));
    const V = vAt(st, t);
    // 손을 줄 따라 벌려 잡은 만큼(어깨보다 바깥) 몸이 조금 더 내려와야 팔이 곧게 펴지지 않는다
    const fr = track(TR.front, t);
    const dh = GRIP0 + (GRIP1 - SHW) * fr;
    const g = figK(t);
    const r = Math.sqrt(REACH * REACH - dh * dh) * st.U * g;
    const sx = V[0] + Math.sin(psi) * r, sy = V[1] + Math.cos(psi) * r;
    const a = -HALF - psi + 0.12 * dpsi;
    return [sx - Math.cos(a) * st.TS * g, sy - Math.sin(a) * st.TS * g, a];
  }

  /** 거꾸로 떨어짐 — 발목에 붙인 줄이 V 에서 풀려 나간다. 등가속이라 끝으로 갈수록 빠르다 */
  function evalFall(st, t) {
    const tau = Math.max(0, t - T.inv1);
    const V = vAt(st, t);
    const fy = V[1] + 0.5 * st.gFall * tau * tau;
    return [V[0], fy + LEG * st.U * figK(t), HALF, V[0], fy];
  }

  /** 매달린 흔들림 각 — 충격 뒤 감쇠 + 끝없이 이어지는 느린 흔들림(주기가 서로 안 맞는 사인 둘) */
  function phiAt(t) {
    const tau = t - T.impact;
    if (tau <= 0) return 0;
    const hit = Math.exp(-0.9 * tau) * 0.06 * Math.sin(TAU * 0.46 * tau);
    const ramp = smooth(span(tau, 0.3, 4));
    // 13초마다 뒷다리를 차서(chans 의 pump) 한 번 더 흔든다. 다음 차기 직전엔 exp 가 거의 0 이라
    // 되풀이 경계에서 튀지 않는다
    const kp = frac((t + 2.0 - 0.55) / 13) * 13;
    const kick = 0.05 * Math.exp(-0.45 * kp) * Math.sin(TAU * kp / 4.6);
    // 흔들림이 작으면(처음엔 0.05) 멀리서 볼 땐 멈춘 그림 같았다 — 눈을 돌렸다 와도 «움직였다»가 보이게
    return hit + ramp * (0.08 * Math.sin(TAU * t / 4.6) + 0.035 * Math.sin(TAU * t / 11.3 + 1.3) + kick);
  }

  /** 줄 끝에 매달림 — 줄이 고무처럼 늘었다 줄고, 몸은 V 를 축으로 흔들린다 */
  function evalHang(st, t) {
    const tau = Math.max(0, t - T.impact);
    const ell = st.drop + settle(tau, st.stretch, st.vImp, 2.4, 3.6);
    const ph = phiAt(t);
    const dph = (phiAt(t + 0.01) - phiAt(t - 0.01)) / 0.02;
    const dx = Math.sin(ph), dy = Math.cos(ph);
    const V = vAt(st, t);
    const fx = V[0] + dx * ell, fy = V[1] + dy * ell;
    const L = LEG * st.U * figK(t);
    return [fx + dx * L, fy + dy * L, HALF - ph + 0.1 * dph, fx, fy];
  }

  function evalFly(sg, t) {
    const T0 = sg.t1 - sg.t0;
    const s = (t - sg.t0) / T0;
    if (s < 0) return [sg.p0[0] + sg.v0[0] * (t - sg.t0), sg.p0[1] + sg.v0[1] * (t - sg.t0), sg.p0[2] + sg.v0[2] * (t - sg.t0)];
    if (s > 1) return [sg.p1[0] + sg.v1[0] * (t - sg.t1), sg.p1[1] + sg.v1[1] * (t - sg.t1), sg.p1[2] + sg.v1[2] * (t - sg.t1)];
    let x = herm(sg.p0[0], sg.v0[0], sg.p1[0], sg.v1[0], T0, s);
    let y = herm(sg.p0[1], sg.v0[1], sg.p1[1], sg.v1[1], T0, s);
    const a = herm(sg.p0[2], sg.v0[2], sg.p1[2], sg.v1[2], T0, s);
    if (sg.bump) {
      // sin² 혹 — 양 끝에서 값도 기울기도 0 이라 이음매 속도를 건드리지 않고 궤적만 부풀린다
      const b = Math.sin(Math.PI * s) ** 2;
      x += sg.bump[0] * b; y += sg.bump[1] * b;
    }
    return [x, y, a];
  }

  function evalSeg(st, sg, t) {
    switch (sg.k) {
      case 'fly': return evalFly(sg, t);
      case 'swing': return evalSwing(st, sg, t);
      case 'hangY': return evalHangY(st, t);
      case 'fall': return evalFall(st, t);
      default: return evalHang(st, t);
    }
  }

  /** 구간 끝의 속도 — dir>0 이면 앞쪽 차분(구간 시작), <0 이면 뒤쪽 차분(구간 끝) */
  function derivSeg(st, sg, t, dir) {
    const e = 1e-3;
    const a = evalSeg(st, sg, dir > 0 ? t : t - e);
    const b = evalSeg(st, sg, dir > 0 ? t + e : t);
    return [(b[0] - a[0]) / e, (b[1] - a[1]) / e, (b[2] - a[2]) / e];
  }

  /** 두 구간을 잇는 비행 — 회전은 turns 에 가장 가까운 만큼(공중제비면 한 바퀴 가까이) */
  function mkFly(t0, t1, e0, d0, e1, d1, turns, bump) {
    const a1 = e1[2] + TAU * Math.round((e0[2] + turns - e1[2]) / TAU);
    return { k: 'fly', t0, t1, p0: e0, v0: d0, p1: [e1[0], e1[1], a1], v1: d1, bump };
  }

  function rootAt(st, t) {
    const segs = st.segs;
    let i = 0;
    while (i < segs.length - 1 && t >= segs[i].t1) i++;
    return evalSeg(st, segs[i], t);
  }

  // ── 준비: 화면 크기에 맞춘 무대 ─────────────────────────────

  /** hub 에서 an 방향으로 쏜 광선이 화면 밖으로 나가는 거리 */
  function rayBox(hx, hy, an, w, h) {
    const cx = Math.cos(an), cy = Math.sin(an);
    let d = 1e9;
    if (cx > 1e-6) d = Math.min(d, (w - hx) / cx);
    if (cx < -1e-6) d = Math.min(d, -hx / cx);
    if (cy > 1e-6) d = Math.min(d, (h - hy) / cy);
    if (cy < -1e-6) d = Math.min(d, -hy / cy);
    return Math.max(0, d);
  }

  /**
   * 원형 거미줄 하나 — 살(spoke)을 먼저, 그 위에 실(ring)을 감는다.
   * 실 간격은 안쪽이 촘촘하고 밖으로 갈수록 넓다. 진짜 거미줄이 그렇고, 무엇보다
   * 글 뒤(허브에서 먼 쪽)가 덜 복잡해진다.
   */
  function makeWeb(st, hx, hy, a0, a1, n, t0, rng, wrap, arrive) {
    const { w, h, S } = st;
    const spokes = [];
    // wrap: 한 바퀴 다 친 거미줄 — 마지막 살과 첫 살 사이에도 실을 건다
    const step = wrap ? (a1 - a0) / n : (a1 - a0) / (n - 1);
    let mid = 0, best = 9;
    for (let i = 0; i < n; i++) {
      const an = a0 + step * i + (rng() - 0.5) * step * 0.4;
      const len = rayBox(hx, hy, an, w, h) + 0.03 * S;
      spokes.push({ cx: Math.cos(an), cy: Math.sin(an), len });
      const da = Math.abs(Math.atan2(Math.sin(an - arrive), Math.cos(an - arrive)));
      if (da < best) { best = da; mid = i; }
    }
    const segN = wrap ? n : n - 1;
    const maxLen = Math.max(...spokes.map((s) => s.len));
    const rings = [];
    let r = 0.035 * S, gap = 0.026 * S;
    while (r < maxLen) {
      // 살마다 반지름을 조금씩 흔든다 — 자로 잰 동심원은 기계가 친 것처럼 보인다
      rings.push(spokes.map(() => r * (1 + (rng() - 0.5) * 0.07)));
      r += gap; gap *= 1.2;
    }
    // 다 쳐진 뒤의 모양은 미리 한 벌 만들어 둔다 — 짓는 동안만 매 프레임 조금씩 그린다
    const full = new Path2D();
    spokes.forEach((s) => { full.moveTo(hx, hy); full.lineTo(hx + s.cx * s.len, hy + s.cy * s.len); });
    rings.forEach((rad) => {
      for (let i = 0; i < segN; i++) webSeg(full, hx, hy, spokes, rad, i, 1);
    });
    const build = t0 + 0.42 + rings.length * 0.075 + 0.3;
    return { hx, hy, spokes, rings, full, maxLen, t0, build, wrap, segN, mid };
  }

  /** 실 한 칸 (살 i → i+1). 가운데를 허브 쪽으로 살짝 늘어뜨린다. k<1 이면 그만큼만 */
  function webSeg(p, hx, hy, spokes, rad, i, k, rev) {
    const n = spokes.length, i1 = (i + 1) % n;
    const s0 = spokes[i], s1 = spokes[i1];
    const r0 = rad[i], r1 = rad[i1];
    if (r0 > s0.len || r1 > s1.len) return;
    let x0 = hx + s0.cx * r0, y0 = hy + s0.cy * r0;
    let x1 = hx + s1.cx * r1, y1 = hy + s1.cy * r1;
    if (rev) { const sx = x0, sy = y0; x0 = x1; y0 = y1; x1 = sx; y1 = sy; }
    const qx = hx + ((x0 + x1) / 2 - hx) * 0.955, qy = hy + ((y0 + y1) / 2 - hy) * 0.955;
    p.moveTo(x0, y0);
    if (k >= 1) { p.quadraticCurveTo(qx, qy, x1, y1); return; }
    // 2차 곡선을 k 에서 자른다 (드 카스텔조)
    const ax = x0 + (qx - x0) * k, ay = y0 + (qy - y0) * k;
    const bx = qx + (x1 - qx) * k, by = qy + (y1 - qy) * k;
    p.quadraticCurveTo(ax, ay, ax + (bx - ax) * k, ay + (by - ay) * k);
  }

  /** 먼 도시 — 세 겹. 멀수록 옅고(안개), 가까울수록 어둡다. 창은 드문드문한 점 */
  function makeSkyline(st, rng) {
    const { w, h, S, U } = st;
    const defs = [
      { depth: 0.12, hMin: 0.10, hMax: 0.21, wMin: 0.030, wMax: 0.075, fill: 'rgba(150,182,210,0.032)', win: 0.05 },
      { depth: 0.30, hMin: 0.06, hMax: 0.17, wMin: 0.035, wMax: 0.085, fill: 'rgba(4,8,13,0.30)', win: 0.04 },
      { depth: 0.62, hMin: 0.025, hMax: 0.085, wMin: 0.05, wMax: 0.12, fill: 'rgba(2,5,9,0.48)', win: 0 }
    ];
    const capH = h * 0.30;
    return defs.map((L) => {
      const body = new Path2D(), win = new Path2D();
      const tw = [new Path2D(), new Path2D(), new Path2D()];
      const margin = st.pan * L.depth + 0.06 * S;
      let x = -margin;
      while (x < w + margin) {
        const bw = (L.wMin + rng() * (L.wMax - L.wMin)) * S;
        const bh = Math.min(capH, (L.hMin + rng() * (L.hMax - L.hMin)) * S);
        const top = h - bh;
        body.rect(x, top, bw + 0.6, bh + 1);
        const r = rng();
        if (r < 0.22) {
          const iw = bw * (0.45 + rng() * 0.3), ih = bh * (0.08 + rng() * 0.12);
          body.rect(x + (bw - iw) / 2, top - ih, iw, ih + 1);
        } else if (r < 0.34) {
          const ax = x + bw * (0.3 + rng() * 0.4);
          body.rect(ax - 0.6 * U, top - bh * 0.22, 1.2 * U, bh * 0.22 + 1);
        }
        if (L.win > 0) {
          const cw = 6.5 * U, chh = 8.5 * U;
          for (let yy = top + chh; yy < h - chh; yy += chh) {
            for (let xx = x + cw * 0.7; xx < x + bw - cw * 0.5; xx += cw) {
              if (rng() >= L.win) continue;
              const k = rng();
              (k < 0.15 ? tw[Math.floor(k / 0.05)] : win).rect(xx, yy, 1.7 * U, 2.3 * U);
            }
          }
        }
        x += bw + (rng() < 0.3 ? rng() * 0.02 * S : 0);
      }
      return { depth: L.depth, fill: L.fill, body, win, tw, lit: L.win > 0 };
    });
  }

  function setup({ w, h, rng }) {
    const S = Math.min(w, h);
    const U = S / 540;
    const st = { w, h, S, U, px: S / 1080, TS: (RIG.torso - RIG.sh) * U, pan: 0.09 * S };

    // 매달려 쉴 자리 V — 왼쪽 위. 글(가로 22~78%)과 초 표시(오른쪽 위)를 둘 다 피한다.
    const V0 = [clamp(0.14 * w, 0.12 * S, 0.30 * S), 0.06 * h + 0.03 * S];
    st.V0 = V0;
    // 쉬는 동안 목도리를 미는 바람 — 글 반대쪽(가까운 화면 가장자리)으로
    st.wind = V0[0] < w / 2 ? -1 : 1;
    // 흔들기 무대는 «오른쪽 밖 → V» 거리에 맞춰 늘이고 줄인다. 세로 화면에서 16:9 그대로
    // 그리면 두 번째 흔들림이 거꾸로(오른쪽으로) 가 버린다.
    const xStart = w + 0.16 * S;
    const D = xStart - V0[0];
    const xs = clamp(D / (1.62 * S), 0.5, 1.7);
    const ys = clamp(xs, 0.72, 1);
    const kx = clamp(xs / ys, 0.85, 1.35);
    const topY = 0.018 * S;
    const A1 = [xStart - 0.24 * D, topY];
    const A2 = [xStart - 0.61 * D, topY + 0.012 * S];
    // 왼쪽 허브는 구석에서 조금 안으로 — 구석에 붙이면 거미줄이 부채 한 조각으로만 보였다
    st.PL = [0.045 * w + 0.01 * S, 0.07 * h + 0.012 * S];
    st.PR = [w - 0.014 * w - 0.01 * S, 0.19 * h];
    st.anchors = [A1, A2, st.PL, st.PR];

    st.sagHang = 7 * U;
    st.dipV0 = 150 * U;
    st.sagDrop = 3 * U;
    st.psiV0 = -1.5;
    st.drop = 0.085 * S;
    st.stretch = 6 * U;
    const Tf = T.impact - T.inv1;
    st.gFall = 2 * st.drop / (Tf * Tf);
    st.vImp = st.gFall * Tf;

    const sw1 = { k: 'swing', t0: T.catch1, t1: T.rel1, A: A1, L: 0.31 * S * ys, kx, Th: 60 * DEG, ph0: Math.acos(55 / 60), ph1: Math.acos(-54 / 60) };
    const sw2 = { k: 'swing', t0: T.catch2, t1: T.rel2, A: A2, L: 0.28 * S * ys, kx, Th: 64 * DEG, ph0: Math.acos(50 / 64), ph1: Math.acos(-62 / 64) };
    const hy = { k: 'hangY', t0: T.catchV, t1: T.inv0 };
    const fall = { k: 'fall', t0: T.inv1, t1: T.impact };
    const hang = { k: 'hang', t0: T.impact, t1: 1e9 };
    const E = (sg, t) => evalSeg(st, sg, t);
    const Dv = (sg, t, dir) => derivSeg(st, sg, t, dir);

    const c1 = E(sw1, T.catch1), dc1 = Dv(sw1, T.catch1, 1);
    const fly0 = mkFly(0, T.catch1,
      [c1[0] - dc1[0] * T.catch1, c1[1] - dc1[1] * T.catch1 - 0.02 * S, c1[2] + 0.2],
      [dc1[0], dc1[1] * 0.5, 0], c1, dc1, 0, null);
    // 두 번째 줄을 잡을 때 몸은 놓을 때의 방향·회전을 그대로 갖고 온다. 줄 방향으로 억지로
    // 맞추면 0.14초 사이에 몸이 한 바퀴 가까이 뒤집혔다 (실제로 그랬다)
    const r1 = E(sw1, T.rel1), dr1 = Dv(sw1, T.rel1, -1);
    const c2 = E(sw2, T.catch2), dc2 = Dv(sw2, T.catch2, 1);
    let off0 = r1[2] + dr1[2] * (T.catch2 - T.rel1) - c2[2];
    off0 -= TAU * Math.round(off0 / TAU);
    // 다만 절반쯤은 나는 동안 미리 줄 쪽으로 몸을 세운다 — 전혀 안 돌리면 잡을 때까지 발이 앞장서
    // 떨어지는 것처럼 보였다. 나머지는 잡은 뒤 줄이 끌어 맞춘다
    sw2.off0 = off0 * 0.55; sw2.offV = dr1[2] - dc2[2]; sw2.offK = 11;
    const fly1 = mkFly(T.rel1, T.catch2, r1, dr1,
      E(sw2, T.catch2), Dv(sw2, T.catch2, 1), 0, [0, -0.012 * S]);
    // 마지막 비행은 뒤로 한 바퀴 가까이 돈다(공중제비) — 돌면서 양손으로 줄을 쏜다
    const fly2 = mkFly(T.rel2, T.catchV, E(sw2, T.rel2), Dv(sw2, T.rel2, -1),
      E(hy, T.catchV), Dv(hy, T.catchV, 1), 285 * DEG, [0, -0.07 * S]);
    // 거꾸로 뒤집기 — 다리를 앞으로 차올려 넘기며 발을 V 에 건다
    const inv = mkFly(T.inv0, T.inv1, E(hy, T.inv0), Dv(hy, T.inv0, -1),
      E(fall, T.inv1), [0, 0, 0], Math.PI, [-26 * U, -16 * U]);
    st.segs = [fly0, sw1, fly1, sw2, fly2, hy, inv, fall, hang];

    st.sky = makeSkyline(st, rng);

    // 줄 사건 — 어느 손이, 어느 닻에, 언제 쏘고 붙고 놓는가
    st.ropes = [
      { k: 0, hand: 'F', fire: -0.02, att: T.att1, rel: T.rel1 },
      { k: 1, hand: 'N', fire: T.shot2, att: T.att2, rel: T.rel2 },
      { k: 2, hand: 'N', fire: T.shotLR, att: T.attL, rel: 1e9 },
      { k: 3, hand: 'F', fire: T.shotLR, att: T.attR, rel: 1e9 }
    ];
    // 쏜 순간·놓은 순간의 손 위치 — 날아가는 줄머리와 튕겨 돌아가는 줄 끝이 여기서 출발한다
    for (const r of st.ropes) {
      const hand = (J) => (r.hand === 'N' ? J.armN.hand : J.armF.hand);
      r.from = hand(pose(st, Math.max(0, r.fire)));
      r.to = r.rel < 1e8 ? hand(pose(st, r.rel)) : null;
    }
    // 거미줄은 줄이 날아온 쪽에서부터 펼쳐진다. 왼쪽은 화면 안쪽에 떨어졌으니 한 바퀴 다 친다
    const from = (r, hub) => Math.atan2(r.from[1] - hub[1], r.from[0] - hub[0]);
    st.webs = [
      makeWeb(st, st.PL[0], st.PL[1], -180 * DEG, 180 * DEG, 16, T.attL, rng, true, from(st.ropes[2], st.PL)),
      makeWeb(st, st.PR[0], st.PR[1], 84 * DEG, 272 * DEG, 15, T.attR, rng, false, from(st.ropes[3], st.PR))
    ];
    return st;
  }

  // ── 자세 ─────────────────────────────────────────────────

  /** 쉬는 동안의 고개 돌림 — 9.4초에 한 번 글 쪽을 흘끗 봤다가 다시 이쪽을 본다 */
  function glance(t) {
    const p = frac((t - 0.7) / 9.4);
    return smooth(span(p, 0, 0.07)) * (1 - smooth(span(p, 0.27, 0.36)));
  }

  /** 시간에 따른 자세 값들. 쉬는 동안의 숨·흔들림은 여기서 곡선 위에 더한다 */
  function chans(t) {
    const idle = smooth(span(t, 3.2, 5.5));
    const breath = Math.sin(TAU * t / 3.7);
    const x = t - T.impact;
    // 줄 끝에 «툭» 걸리는 순간 상체가 앞으로 접혔다 펴진다
    const hit = x > 0 ? Math.exp(-3 * x) * Math.sin(TAU * 1.6 * x) : 0;
    // 손 인사 — 19초에 한 번, 머리 뒤에 괴었던 앞손을 풀어 이쪽으로 흔든다.
    // 5초 전엔 주기 위치가 창 밖(16초대)이라 0 — 착지 연출과 겹치지 않는다
    const wp = frac((t - 7.5) / 19) * 19;
    const wave = t > 5 ? smooth(span(wp, 0, 0.4)) * (1 - smooth(span(wp, 2.3, 2.8))) : 0;
    // 다리 굴리기 — 13초에 한 번 뒷다리를 접었다 차며 흔들림을 보탠다 (phiAt 의 kick 과 같은 박자)
    const pump = idle * pulse(t, 13, 1.1, 2.0);
    // 기지개 — 23초에 한 번, 늘어뜨린 두 팔을 아래로 쭉 뻗고 접었던 다리도 편다.
    // 쉬는 자세가 몇 분씩 이어지니 한 번씩은 멀리서도 «모양이 바뀌었다»가 보이는 동작이 있어야 한다
    const sp = frac((t - 15) / 23) * 23;
    const stretch = t > 14 ? smooth(span(sp, 0, 0.8)) * (1 - smooth(span(sp, 2.6, 3.5))) : 0;
    const legOpen = stretch * (1 - pump);
    return {
      sN: track(TR.sN, t), eN: track(TR.eN, t), sF: track(TR.sF, t), eF: track(TR.eF, t),
      hipN: track(TR.hipN, t), kneeN: track(TR.kneeN, t),
      hipF: lerp(track(TR.hipF, t) + idle * 0.1 * Math.sin(TAU * t / 4.9) + 0.6 * pump, 0.08, legOpen),
      kneeF: lerp(track(TR.kneeF, t) + idle * 0.14 * Math.sin(TAU * t / 6.1 + 1) + 0.9 * pump, 0.12, legOpen),
      wave, stretch,
      // 늘어뜨린 팔은 몸 흔들림보다 한 박자 늦게 흔들린다 (위상을 늦춘 사인 — 되풀이 이음매 없음)
      armSw: idle * (0.07 * Math.sin(TAU * t / 4.6 - 1.2) + 0.03 * Math.sin(TAU * t / 2.3 + 0.4)),
      legIK: track(TR.legIK, t),
      curl: track(TR.curl, t) + 0.45 * hit + idle * 0.025 * breath,
      tilt: track(TR.tilt, t) + 0.3 * hit + idle * (0.12 * Math.sin(TAU * t / 7.3 + 0.5) - 0.1 * stretch),
      look: track(TR.look, t) + 0.8 * idle * glance(t) * (1 - wave),
      // 29초에 한 번, 7초 동안 줄이 꼬이며 몸이 반쯤 돌았다 돌아온다 — 매달린 줄은 늘 조금씩 비틀린다.
      // 어깨 폭·«4»자 다리가 좁아졌다 넓어져, 한참 뒤에 다시 봐도 모양이 달라져 있다
      front: track(TR.front, t) - idle * 0.3 * pulse(t, 29, 7, -20),
      breath: 1 + idle * (0.04 * breath + 0.06 * stretch),
      blink: Math.max(pulse(t, 4.3, 0.16, 1.1), pulse(t, 11.7, 0.16, 5.0), stretch * stretch)
    };
  }

  // 팔을 «몸 틀»의 극좌표로 — [위팔 각, 위팔 길이(U), 아래팔 각, 아래팔 길이(U)].
  // 각은 골반 쪽(0)에서 몸 바깥쪽(+π/2)으로 잰다. 바깥쪽을 팔마다 뒤집어 두 팔이 같은 숫자로 좌우 대칭이 된다.
  // 팔짱 ↔ 늘어뜨림처럼 멀리 가는 동작을 손·팔꿈치 «자리»로 섞으면 중간에 팔꿈치가 어깨를 지나가며
  // 위팔이 0 으로 짧아진다(팔이 어깨에서 사라진다). 각으로 섞으면 팔이 돌아서 넘어간다.
  // 길이가 RIG 보다 짧은 것은 팔이 몸 앞으로 나와 원근에 줄어든 것
  // 아래팔을 길게 두면(19U) 손끝이 반대쪽 팔 바깥으로 삐져나와 가시처럼 보였다 — 손이 이두 위에서 끝나게
  const CROSS_N = [-0.077, 13.0, -1.80, 15.4];   // 앞팔 — 위에 포갠 팔. 손은 뒷팔 이두 위에 얹는다
  const CROSS_F = [-0.067, 15.0, -1.77, 15.3];   // 뒷팔 — 한 뼘 아래(골반 쪽). 손끝은 앞팔 겨드랑이 밑에 숨는다
  // 기지개 — 두 팔을 머리 너머로 모아 쭉. 넓게 벌리면 다시 «벌린 다리»로 읽혀서 좁게
  const STRETCH = [2.85, 18.5, 2.98, 17.5];

  function polarMix(a, b, k) {
    const ang = (x, y) => { let d = y - x; d -= TAU * Math.round(d / TAU); return x + d * k; };
    return [ang(a[0], b[0]), lerp(a[1], b[1], k), ang(a[2], b[2]), lerp(a[3], b[3], k)];
  }
  function bodyAxes(F, near) {
    const s = near ? 1 : -1;
    return [-F.tux, -F.tuy, F.fwx * s, F.fwy * s];   // 골반 쪽, 몸 바깥쪽
  }
  /** 극좌표 → [팔꿈치 x, y, 손 x, y] */
  function fromPolar(Sh, P, F, U, near) {
    const [dx, dy, ox, oy] = bodyAxes(F, near);
    const c0 = Math.cos(P[0]), s0 = Math.sin(P[0]), c1 = Math.cos(P[2]), s1 = Math.sin(P[2]);
    const ex = Sh[0] + (dx * c0 + ox * s0) * P[1] * U, ey = Sh[1] + (dy * c0 + oy * s0) * P[1] * U;
    return [ex, ey, ex + (dx * c1 + ox * s1) * P[3] * U, ey + (dy * c1 + oy * s1) * P[3] * U];
  }
  function toPolar(Sh, el, hd, F, U, near) {
    const [dx, dy, ox, oy] = bodyAxes(F, near);
    const ux = el[0] - Sh[0], uy = el[1] - Sh[1], vx = hd[0] - el[0], vy = hd[1] - el[1];
    return [Math.atan2(ux * ox + uy * oy, ux * dx + uy * dy), Math.hypot(ux, uy) / U,
      Math.atan2(vx * ox + vy * oy, vx * dx + vy * dy), Math.hypot(vx, vy) / U];
  }

  /** 팔 동작 한 가지의 손 자리와 팔꿈치가 꺾일 쪽 [hx, hy, px, py] (+ 팔꿈치를 직접 정하면 [ex, ey]) */
  function handFor(st, key, t, s, e, Sh, F, U, near, k) {
    if (key.m === 1) {
      const A = st.anchors[key.k];
      const dx = A[0] - Sh[0], dy = A[1] - Sh[1];
      const d = Math.hypot(dx, dy) || 1;
      let ux = dx / d, uy = dy / d;
      if (key.rot) {
        // 옆모습에선 두 어깨가 한 점이라, 두 손이 같은 닻을 겨누면 뒷팔이 앞팔 뒤에 통째로 숨었다(팔이 하나로 읽힘).
        // 뒷팔은 겨눔을 몸 앞(rot>0)·등(rot<0) 쪽으로 조금 비틀어 따로 보이게 한다.
        // 비틀 쪽을 부호로만 고르면 몸이 돌며 앞쪽이 겨눔과 나란해지는 순간 손이 반대로 튄다 —
        // 수직인 정도만큼만 비틀어 그 순간엔 부드럽게 0 으로 줄어든다 (ik 와 같은 방법)
        const q = clamp((-uy * F.fwx + ux * F.fwy) / 0.35, -1, 1);
        const an = key.rot * q, c = Math.cos(an), sn = Math.sin(an);
        const rx = ux * c - uy * sn, ry = uy * c + ux * sn;
        ux = rx; uy = ry;
      }
      const r = REACH * U * (key.r || 1);
      return [Sh[0] + ux * r, Sh[1] + uy * r, -F.tux * 0.4 + F.tuy * k, -F.tuy * 0.4 - F.tux * k];
    }
    if (key.m === 2) {
      // V 를 잡은 손 — 제 줄(앞손은 왼쪽 P_L, 뒷손은 오른쪽 P_R)을 따라 벌려 잡는다.
      // 몸이 3/4 로 돌면 손이 어깨보다 바깥에 있어 두 팔이 «Y» 로 벌어지고 그 사이에 머리가 보인다
      const V = vAt(st, t), A = st.anchors[key.k];
      const dx = A[0] - V[0], dy = A[1] - V[1], d = Math.hypot(dx, dy) || 1;
      const g = (GRIP0 + GRIP1 * F.front) * U;
      // 팔꿈치는 옆모습에선 뒤로, 정면에선 바깥으로. 앞손은 그 사이에 뒤→바깥으로 넘어간다
      // (넘어가는 순간은 ik 가 팔을 곧게 줄여 보여 준다 — 팔꿈치가 건너뛰지 않는다)
      const side = near ? lerp(-1, 1, F.front) : -1;
      return [V[0] + dx / d * g, V[1] + dy / d * g, -F.tux * 0.3 + F.fwx * side, -F.tuy * 0.3 + F.fwy * side];
    }
    if (key.m === 3) {
      // 거꾸로 매달려 쉴 때 — 가슴 앞에 팔짱.
      // 두 팔을 머리 양옆으로 늘어뜨렸더니(«ㅅ») 거꾸로 선 몸이 «바로 선 사람»으로 읽혔다: 늘어뜨린 두 팔이
      // 벌린 다리로, 그 사이의 머리·목도리가 사타구니에 달린 빛나는 고리로 보였다(검토 지적).
      // 팔짱을 끼면 머리 쪽 끝에는 머리와 목도리만 남아 어느 쪽이 머리인지 헷갈릴 수가 없고,
      // 매달린 채 느긋하게 기다리는 곡예사 모양도 된다.
      // 머리 뒤 깍지(처음 안)는 팔꿈치·손이 머리를 빙 둘러싸 머리·팔·어깨가 한 덩어리로 뭉쳤다
      const sk = F.stretch;
      let P = (near ? CROSS_N : CROSS_F).slice();
      P[0] += F.armSw * 0.35;
      if (sk > 0) P = polarMix(P, STRETCH, sk);
      if (near && F.wave > 0) {
        // 인사 — 팔짱을 풀어 팔꿈치를 옆으로 내밀고 아래팔을 하늘 쪽(거꾸로니 발 쪽)으로 세워 까딱까딱
        const sw = Math.sin(TAU * 2.1 * t);
        P = polarMix(P, [1.35, 17.5, 0.3 + 0.38 * sw, 17.5], F.wave);
      }
      const E = fromPolar(Sh, P, F, U, near);
      return [E[2], E[3], 0, 0, E[0], E[1]];
    }
    // 정해진 각(FK). 꺾임을 몸 축에 대해 도는 판으로 보고 화면에 비춘다 — k 가 ±1 이면 그냥 각대로,
    // 몸이 도는 중(|k|<1)이면 옆으로 벌어진 만큼이 줄어든다. 각을 k 배 하면 k=0 에서 팔이 쭉 펴져 튀었다
    const Dx = -F.tux, Dy = -F.tuy, Px = F.tuy, Py = -F.tux;
    const l1 = RIG.uarm * U, l2 = RIG.farm * U, se = s + e;
    const ex = Sh[0] + (Dx * Math.cos(s) - Px * k * Math.sin(s)) * l1;
    const ey = Sh[1] + (Dy * Math.cos(s) - Py * k * Math.sin(s)) * l1;
    const hx = ex + (Dx * Math.cos(se) - Px * k * Math.sin(se)) * l2;
    const hy = ey + (Dy * Math.cos(se) - Py * k * Math.sin(se)) * l2;
    return [hx, hy, ex - (Sh[0] + hx) / 2, ey - (Sh[1] + hy) / 2, ex, ey];
  }

  // 줄을 쥐는 동작(겨눔·잡음·V 잡기)이면 주먹, 나머지는 느슨하게 편 손
  const gripOf = (key) => (key.m === 1 || key.m === 2 ? 1 : 0);

  function armOf(st, keys, t, s, e, Sh, F, U, near, k) {
    let j = 0;
    while (j < keys.length - 1 && t >= keys[j + 1].t) j++;
    let q = handFor(st, keys[j], t, s, e, Sh, F, U, near, k);
    let grip = gripOf(keys[j]);
    const kj = keys[j];
    if (j > 0 && t < kj.t + kj.b) {
      const p = handFor(st, keys[j - 1], t, s, e, Sh, F, U, near, k);
      const bk = smooth(span(t, kj.t, kj.t + kj.b));
      if (p.length > 4 && q.length > 4) {
        // 둘 다 팔꿈치를 정한 자세(떨어질 때의 FK → 팔짱)면 각으로 섞는다 — 팔이 접히며 돌아 들어온다
        const P = polarMix(toPolar(Sh, [p[4], p[5]], [p[0], p[1]], F, U, near),
          toPolar(Sh, [q[4], q[5]], [q[0], q[1]], F, U, near), bk);
        const E = fromPolar(Sh, P, F, U, near);
        q = [E[2], E[3], 0, 0, E[0], E[1]];
      } else {
        q = [lerp(p[0], q[0], bk), lerp(p[1], q[1], bk), lerp(p[2], q[2], bk), lerp(p[3], q[3], bk)];
      }
      grip = lerp(gripOf(keys[j - 1]), grip, bk);
    }
    if (q.length > 4) {
      // 섞는 중이 아닌 FK 는 팔꿈치도 그대로 쓴다 — 비춰서 줄어든 팔을 ik 가 다시 꺾어 버리지 않게
      return { sh: Sh, elbow: [q[4], q[5]], hand: [q[0], q[1]], wrist: [lerp(q[4], q[0], 0.84), lerp(q[5], q[1], 0.84)], grip };
    }
    const r = ik(Sh[0], Sh[1], q[0], q[1], RIG.uarm * U, RIG.farm * U, q[2], q[3]);
    return {
      sh: Sh, elbow: [r[0], r[1]], hand: [r[2], r[3]],
      wrist: [lerp(r[0], r[2], 0.84), lerp(r[1], r[3], 0.84)], grip
    };
  }

  /** t 의 온몸 — 관절 좌표(px) 묶음 */
  function pose(st, t) {
    const U = st.U * figK(t), fc = -1;
    const r = rootAt(st, t);
    const c = chans(t);
    const px = r[0], py = r[1], a = r[2];
    const ta = a + fc * c.curl;
    const tux = Math.cos(ta), tuy = Math.sin(ta);
    const F = { a, ta, fc, tux, tuy, fwx: fc * -tuy, fwy: fc * tux };
    const pelvis = [px, py];
    const chest = [px + tux * RIG.torso * U, py + tuy * RIG.torso * U];
    const Sh = [px + tux * (RIG.torso - RIG.sh) * U, py + tuy * (RIG.torso - RIG.sh) * U];
    // 정면으로 돌면 어깨·엉덩이가 좌우로 벌어지고, 뒤쪽 팔다리의 꺾임은 반대편으로 넘어간다.
    // 넘어가는 동안(|kF|<1)은 꺾임을 화면에 비춘 만큼만 옆으로 편다 (leg·handFor 참고)
    const kN = fc, kF = lerp(fc, -fc, c.front);
    const sw = c.front * SHW * U;
    // 옆모습에서도 어깨 관절은 등뼈보다 조금 앞에 있다 (몸통 윤곽의 가슴 쪽 휨과 맞춘다)
    const sfw = (1 - c.front) * 0.9 * U;
    const ShN = [Sh[0] - tuy * fc * sw + F.fwx * sfw, Sh[1] + tux * fc * sw + F.fwy * sfw];
    const ShF = [Sh[0] + tuy * fc * sw + F.fwx * sfw, Sh[1] - tux * fc * sw + F.fwy * sfw];
    const ha = ta + fc * c.tilt;
    const hux = Math.cos(ha), huy = Math.sin(ha);
    const hfx = fc * -huy, hfy = fc * hux;
    // 정면일수록 목이 조금 길게 드러난다 — 넓어진 어깨와 머리 사이에 틈이 있어야 머리가 따로 읽힌다.
    // 다만 길면(v1 의 6.4U) 막대 위에 공을 얹은 것 같았다 — 머리를 제대로 그린 뒤로는 짧고 굵게
    // 거꾸로 매달린 뒤로는 목을 조금 더 드러낸다 — 어깨와 머리 사이에 틈(과 목도리 한 줄)이 보여야
    // 머리가 몸통 끝에 붙은 «공»이 아니라 목에 달린 머리로 읽힌다
    const nk = (RIG.neck - 1.6 + 1.2 * c.front + 1.8 * smooth(span(t, T.inv1, T.impact + 0.3))) * U;
    const headBase = [chest[0] + hux * nk, chest[1] + huy * nk];
    const head = [headBase[0] + hux * HEAD_R * 0.9 * U, headBase[1] + huy * HEAD_R * 0.9 * U];
    // 팔이 머리·몸을 기준으로 자리 잡는 동작(매달림·인사·기지개)에 넘기는 틀 — 프레임마다 새로 만든 객체
    F.wave = c.wave; F.front = c.front; F.stretch = c.stretch; F.armSw = c.armSw;

    // 다리 — 무릎은 몸 앞쪽으로 꺾인다. 줄에 발을 건 뒤로는 앞다리를 발 자리(IK)에 붙인다
    const pwx = -Math.sin(a), pwy = Math.cos(a);
    const Dx = -Math.cos(a), Dy = -Math.sin(a);   // 골반에서 발 쪽 (몸 아래)
    const Px = -Dy, Py = Dx;                       // 그 수직 — k=-1 이면 몸 앞쪽
    const hw = c.front * 3.7 * U;
    const leg = (side, hip, knee, k, tgt, wIK) => {
      const hx = px + pwx * side * hw, hy = py + pwy * side * hw;
      // 꺾인 다리를 «몸 축에 대해 도는 판»으로 보고 화면에 비춘다. |k|=1 이면 각을 그대로 쓴 것과 같고,
      // 몸이 도는 중이면 옆으로 벌어진 만큼만 줄어든다. 각에 k 를 곱했더니 k=0 을 지날 때
      // 뒷다리가 곧게 펴져 옆으로 쭉 튀어나왔다가 돌아갔다(0.1초 — 끊김으로 보였다)
      const tl = RIG.thigh * U, sl = RIG.shin * U, b2 = hip - knee;
      let kx = hx + (Dx * Math.cos(hip) - Px * k * Math.sin(hip)) * tl;
      let ky = hy + (Dy * Math.cos(hip) - Py * k * Math.sin(hip)) * tl;
      let ax = kx + (Dx * Math.cos(b2) - Px * k * Math.sin(b2)) * sl;
      let ay = ky + (Dy * Math.cos(b2) - Py * k * Math.sin(b2)) * sl;
      if (tgt && wIK > 0) {
        const q = ik(hx, hy, tgt[0], tgt[1], tl, sl, pwx * k, pwy * k);
        kx = lerp(kx, q[0], wIK); ky = lerp(ky, q[1], wIK);
        ax = lerp(ax, q[2], wIK); ay = lerp(ay, q[3], wIK);
      }
      // 발 — 정강이에 수직, 역시 비친 만큼. 정면에선 발끝이 이쪽을 향해 짧아 보인다
      const sd = Math.hypot(ax - kx, ay - ky) || 1;
      const fl = RIG.foot * (1 - 0.55 * c.front) * U / sd;
      return {
        hip: [hx, hy], knee: [kx, ky], ankle: [ax, ay],
        toe: [ax + k * (ay - ky) * fl, ay - k * (ax - kx) * fl],
        // 허벅지·정강이의 «앞»(무릎이 향하는 쪽) — 각을 조금 키웠을 때 무릎이 움직이는 방향이다.
        // 다리를 곧게 펴도 앞뒤가 정해져 있어, 허벅지 앞 근육과 종아리가 제자리를 지킨다
        thAnt: [-Dx * Math.sin(hip) - Px * k * Math.cos(hip), -Dy * Math.sin(hip) - Py * k * Math.cos(hip)],
        shAnt: [-Dx * Math.sin(b2) - Px * k * Math.cos(b2), -Dy * Math.sin(b2) - Py * k * Math.cos(b2)]
      };
    };
    const footT = r.length > 3 ? [r[3], r[4]] : null;
    const legN = leg(fc, c.hipN, c.kneeN, kN, footT, c.legIK);
    const legF = leg(-fc, c.hipF, c.kneeF, kF, null, 0);
    const armN = armOf(st, ARM_N, t, c.sN, c.eN, ShN, F, U, true, kN);
    const armF = armOf(st, ARM_F, t, c.sF, c.eF, ShF, F, U, false, kF);
    return {
      U, a, pelvis, chest, headBase, head, hux, huy, hfx, hfy,
      tu: [tux, tuy], fw: [F.fwx, F.fwy],
      look: c.look, blink: c.blink, breath: c.breath,
      legN, legF, armN, armF, footT, front: c.front,
      // 팔짱으로 넘어가는 순간부터 뒷팔도 몸통 앞에 그린다 — 가슴 앞을 가로지르는 아래팔이 몸통에 가려지면 안 된다.
      // 이때 뒷팔은 아직 머리 너머로 뻗어 있어 몸통과 겹치는 곳이 어깨 끝뿐이라 순서가 바뀌어도 티가 안 난다
      farTop: t >= ARM_F[ARM_F.length - 1].t
    };
  }

  /** 목도리가 매인 자리 — 몸통 길만으로 구한다 (과거 시각을 여러 번 물어봐야 해서 가볍게) */
  function neckAt(st, t) {
    const r = rootAt(st, t);
    const L = (RIG.torso + RIG.neck * 0.4) * st.U * figK(t);
    return [r[0] + Math.cos(r[2]) * L, r[1] + Math.sin(r[2]) * L];
  }

  // ── 그리기 ───────────────────────────────────────────────


  /** 카메라 — 건너오는 동안 따라 흘렀다가 멈춘다. 쉬는 동안은 아주 느리게 숨 쉬듯 */
  function camAt(st, t) {
    return -st.pan * (1 - ease.inOut(span(t, 0, 2.8))) + 0.01 * st.S * Math.sin(TAU * t / 41);
  }

  function drawSky(ctx, t, st) {
    const cam = camAt(st, t);
    ctx.globalAlpha = smooth(span(t, 0, 0.9));
    for (const L of st.sky) {
      ctx.save();
      ctx.translate(cam * L.depth, 0);
      ctx.fillStyle = L.fill;
      ctx.fill(L.body);
      if (L.lit) {
        ctx.fillStyle = 'rgba(255,205,140,0.15)';
        ctx.fill(L.win);
        // 몇 창은 느리게 켜졌다 꺼진다 — 세 묶음이 서로 다른 주기로
        for (let i = 0; i < 3; i++) {
          const k = 0.5 + 0.5 * Math.sin(TAU * t / (6.7 + i * 2.3) + i * 2.1);
          ctx.fillStyle = `rgba(190,225,255,${(0.04 + 0.16 * k * k).toFixed(3)})`;
          ctx.fill(L.tw[i]);
        }
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 거미줄 색 — 허브에서 멀수록 옅다 (글 뒤는 거의 안 보이게).
   * 쉬는 동안은 옅은 빛띠가 허브에서 바깥으로 7.2초에 한 번 지나간다. 띠 세기가 주기의
   * 처음과 끝에서 0 이라 되풀이 이음매가 안 보인다.
   */
  function webStyle(ctx, wb, t, fade) {
    const g = ctx.createRadialGradient(wb.hx, wb.hy, 0, wb.hx, wb.hy, wb.maxLen);
    const p = frac((t - 3.4) / 7.2);
    const band = p * 1.25 - 0.12;
    const amp = t > 3.4 ? 0.07 * Math.sin(Math.PI * p) ** 2 : 0;
    const N = 20;
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const base = 0.17 * Math.pow(1 - x, 1.9) + 0.03;
      const hi = amp * (1 - 0.6 * x) * Math.exp(-(((x - band) / 0.07) ** 2));
      g.addColorStop(x, `rgba(214,238,255,${((base + hi) * fade).toFixed(4)})`);
    }
    return g;
  }

  function drawWebs(ctx, t, st) {
    ctx.lineWidth = Math.max(0.75, 0.95 * st.px);
    for (const wb of st.webs) {
      if (t < wb.t0) continue;
      // 막 쳐진 실은 잠깐 더 밝다 — 퍼져 나가는 것이 «보이게». 다 쳐지면 배경 밝기로 가라앉는다
      // 글이 뜨는 동안에도 쳐지고 있으니, 막 쳐진 밝기는 과하지 않게
      const fresh = 1 + 0.75 * (1 - smooth(span(t, wb.t0 + 0.2, wb.build + 0.6)));
      ctx.strokeStyle = webStyle(ctx, wb, t, fresh);
      if (t >= wb.build) { ctx.stroke(wb.full); continue; }
      const p = new Path2D();
      const n = wb.spokes.length, segN = wb.segN, mid = wb.mid;
      // 살은 줄이 날아온 쪽 살부터 차례로 뻗는다 (붙은 자리에서 부채처럼 펼쳐지게)
      wb.spokes.forEach((s, i) => {
        const di = Math.abs(i - mid);
        const d = wb.t0 + (wb.wrap ? Math.min(di, n - di) : di) * 0.018;
        const k = ease.out(span(t, d, d + 0.42));
        if (k <= 0) return;
        p.moveTo(wb.hx, wb.hy);
        p.lineTo(wb.hx + s.cx * s.len * k, wb.hy + s.cy * s.len * k);
      });
      // 실은 안쪽부터 한 바퀴씩 — 번갈아 반대로 감아 한 올로 이어 감는 것처럼
      wb.rings.forEach((rad, j) => {
        const r0 = wb.t0 + 0.3 + j * 0.075;
        const k = span(t, r0, r0 + 0.3) * segN;
        if (k <= 0) return;
        for (let i = 0; i < segN; i++) {
          const kk = clamp(k - i, 0, 1);
          if (kk <= 0) break;
          const rev = j % 2 === 1;
          // 한 바퀴짜리는 날아온 살에서 출발해 돈다. 부채꼴은 끝에서 끝으로
          const idx = wb.wrap ? (rev ? (((mid - 1 - i) % n) + n) % n : (mid + i) % n) : (rev ? segN - 1 - i : i);
          webSeg(p, wb.hx, wb.hy, wb.spokes, rad, idx, kk, rev);
        }
      });
      ctx.stroke(p);
    }
  }

  /** 줄 한 가닥 — 넓고 옅은 번짐 위에 가는 심 */
  function strokeLine(ctx, U, x0, y0, x1, y1, a, cx, cy) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    if (cx === undefined) ctx.lineTo(x1, y1); else ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.strokeStyle = `rgba(140,225,255,${(a * 0.16).toFixed(3)})`;
    ctx.lineWidth = 4.2 * U;
    ctx.stroke();
    ctx.strokeStyle = `rgba(228,248,255,${a.toFixed(3)})`;
    ctx.lineWidth = 1.15 * U;
    ctx.stroke();
  }

  function drawRopes(ctx, t, st, J) {
    const U = st.U;
    const V = vAt(st, t);
    ctx.lineCap = 'round';
    for (const r of st.ropes) {
      if (t < r.fire) continue;
      const A = st.anchors[r.k];
      let hand = r.hand === 'N' ? J.armN.hand : J.armF.hand;
      if (t < r.att) {
        // 줄머리가 손에서 닻까지 날아간다 — 끝으로 갈수록 살짝 느려진다
        const k = Math.pow(span(t, r.fire, r.att), 0.8);
        strokeLine(ctx, U, hand[0], hand[1], lerp(r.from[0], A[0], k), lerp(r.from[1], A[1], k), 0.9);
      } else if (t < r.rel) {
        if (r.rel > 1e8) {
          // 양손 줄은 손을 놓으면 V 에 묶인 다리(bridge)가 되어 남는다 — 밝기도 거미줄 수준으로 가라앉힌다
          const k = smooth(span(t, T.relV - 0.06, T.relV + 0.02));
          hand = [lerp(hand[0], V[0], k), lerp(hand[1], V[1], k)];
          const a = lerp(0.85, 0.1, smooth(span(t, T.relV, T.relV + 1.8)));
          // 놓은 줄은 살짝 처진다 — 자로 그은 직선은 줄이 아니라 화면에 그은 금처럼 보였다.
          // 처짐은 느리게 조금 숨 쉬듯 변한다 (주기 함수라 이음매 없음)
          const len = Math.hypot(A[0] - hand[0], A[1] - hand[1]);
          const sag = k * len * (0.02 + 0.005 * Math.sin(TAU * t / 5.3 + r.k));
          strokeLine(ctx, U, hand[0], hand[1], A[0], A[1], a, (hand[0] + A[0]) / 2, (hand[1] + A[1]) / 2 + sag);
          continue;
        }
        strokeLine(ctx, U, hand[0], hand[1], A[0], A[1], 0.85);
      } else if (r.to) {
        // 놓은 줄 — 닻 쪽으로 튕겨 감기며 사라진다 (느슨하게 출렁이며)
        const k = span(t, r.rel, r.rel + 0.34);
        if (k < 1) {
          const q = ease.out(k);
          const ex = lerp(r.to[0], A[0], q), ey = lerp(r.to[1], A[1], q);
          const mx = (ex + A[0]) / 2, my = (ey + A[1]) / 2;
          const dx = A[0] - ex, dy = A[1] - ey, d = Math.hypot(dx, dy) || 1;
          const wig = 16 * U * (1 - q) * Math.sin(k * 11);
          strokeLine(ctx, U, ex, ey, A[0], A[1], 0.8 * (1 - k), mx - dy / d * wig, my + dx / d * wig);
        }
      }
    }
    // 발목 줄 — V 에서 발까지
    if (t > T.inv1 - 0.1 && J.footT) {
      const a = lerp(0.6, 0.34, smooth(span(t, T.impact, T.impact + 2)));
      strokeLine(ctx, U, V[0], V[1], J.legN.ankle[0], J.legN.ankle[1], a);
    }
  }

  /** 붙는 순간의 번쩍임과 닻에 남는 자국, 날아가는 줄머리 */
  function drawFlashes(ctx, t, st, J) {
    const U = st.U;
    ctx.lineCap = 'round';
    for (const r of st.ropes) {
      if (t < r.fire) continue;
      const A = st.anchors[r.k];
      if (t < r.att) {
        const k = Math.pow(span(t, r.fire, r.att), 0.8);
        const x = lerp(r.from[0], A[0], k), y = lerp(r.from[1], A[1], k);
        ctx.fillStyle = 'rgba(160,230,255,0.28)';
        ctx.beginPath(); ctx.arc(x, y, 5 * U, 0, TAU); ctx.fill();
        ctx.fillStyle = '#f2fcff';
        ctx.beginPath(); ctx.arc(x, y, 1.9 * U, 0, TAU); ctx.fill();
        // 쏘는 손목의 짧은 불빛
        const hk = span(t, r.fire, r.fire + 0.14);
        const hand = r.hand === 'N' ? J.armN.wrist : J.armF.wrist;
        ctx.fillStyle = `rgba(255,190,90,${(0.55 * (1 - hk)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(hand[0], hand[1], (2 + 4 * hk) * U, 0, TAU); ctx.fill();
        continue;
      }
      // 자국 — 흔들기용 닻은 놓으면 사라지고, 거미줄 허브는 옅게 남는다
      const keep = r.rel > 1e8 ? lerp(0.8, 0.4, smooth(span(t, r.att, r.att + 2))) : 0.8 * (1 - smooth(span(t, r.rel, r.rel + 0.8)));
      if (keep > 0.01) {
        ctx.fillStyle = `rgba(225,246,255,${keep.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(A[0], A[1], 1.8 * U, 0, TAU); ctx.fill();
      }
      const k = span(t, r.att, r.att + 0.3);
      if (k >= 1) continue;
      const q = ease.out(k), fade = (1 - k) * (1 - k);
      ctx.strokeStyle = `rgba(210,245,255,${(0.9 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.3 * U;
      ctx.beginPath(); ctx.arc(A[0], A[1], (2 + 13 * q) * U, 0, TAU); ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const an = i * TAU / 7 + r.k;
        const r0 = (2 + 4 * q) * U, r1 = (4 + 10 * q) * U;
        ctx.moveTo(A[0] + Math.cos(an) * r0, A[1] + Math.sin(an) * r0);
        ctx.lineTo(A[0] + Math.cos(an) * r1, A[1] + Math.sin(an) * r1);
      }
      ctx.stroke();
    }
  }

  /** 빠른 구간의 속도선과 잔상 — 흔들림 바닥에서만 켜진다 */
  function drawSpeed(ctx, t, st) {
    if (t > 2.9) return;
    const U = st.U;
    const p0 = rootAt(st, t), p1 = rootAt(st, t - 0.02);
    const vx = (p0[0] - p1[0]) / 0.02, vy = (p0[1] - p1[1]) / 0.02;
    const sp = Math.hypot(vx, vy) / U;
    const k = clamp((sp - 450) / 480);
    if (k <= 0) return;
    const ux = vx / (sp * U), uy = vy / (sp * U);
    // 몸 가운데 — 인물 크기 배율을 따른다
    const mk = figK(t);
    const mid = (q) => [q[0] + Math.cos(q[2]) * 15 * U * mk, q[1] + Math.sin(q[2]) * 15 * U * mk];
    // 잔상 — 지난 0.13초 동안 몸 가운데가 지나온 호. 끝으로 갈수록 가늘고 옅어지는 한 장의 띠로 칠한다.
    // 둥근 끝 선을 여러 번 겹쳐 그렸더니(v1) 동그라미가 줄줄이 달린 구슬 꿰미처럼 보였다
    const C = [];
    for (let i = 0; i <= 8; i++) C.push(mid(i ? rootAt(st, t - i * 0.016) : p0));
    const side = [], back = [];
    for (let i = 0; i <= 8; i++) {
      const a = C[Math.max(0, i - 1)], b = C[Math.min(8, i + 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1], d = Math.hypot(tx, ty) || 1;
      const hw = 7 * U * mk * (1 - i / 9) ** 1.3;
      side.push([C[i][0] - ty / d * hw, C[i][1] + tx / d * hw]);
      back.push([C[i][0] + ty / d * hw, C[i][1] - tx / d * hw]);
    }
    ctx.beginPath();
    ctx.moveTo(side[0][0], side[0][1]);
    for (let i = 1; i <= 8; i++) ctx.lineTo(side[i][0], side[i][1]);
    for (let i = 8; i >= 0; i--) ctx.lineTo(back[i][0], back[i][1]);
    ctx.closePath();
    const sg = ctx.createLinearGradient(C[0][0], C[0][1], C[8][0], C[8][1]);
    sg.addColorStop(0, `rgba(150,225,255,${(0.09 * k).toFixed(3)})`);
    sg.addColorStop(1, 'rgba(150,225,255,0)');
    ctx.fillStyle = sg;
    ctx.fill();
    // 속도선 — 몸 뒤로 가는 선 몇 가닥
    const c = mid(p0);
    const offs = [-16, -6, 5, 14];
    ctx.lineWidth = 1 * U;
    for (let i = 0; i < 4; i++) {
      const o = (offs[i] + 2.5 * Math.sin(t * 37 + i * 1.7)) * U;
      const back = (22 + 7 * i % 3 * 4) * U;
      const len = (26 + 18 * ((i * 7) % 4) / 3) * U * k;
      const bx = c[0] - ux * back - uy * o, by = c[1] - uy * back + ux * o;
      ctx.strokeStyle = `rgba(210,242,255,${(0.28 * k).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - ux * len, by - uy * len); ctx.stroke();
    }
  }

  // ── 인물 그리기 ─────────────────────────────────────────────
  // 옷은 짙은 청록 두 톤(그늘·빛 받는 쪽), 테두리 빛은 빛을 향한 가장자리에만.
  // v1 은 온몸을 같은 청록 테두리로 둘러서 «선으로 그린 그림 문자»처럼 보였다 — 사방에 두른 테두리는
  // 윤곽선이지 빛이 아니다. 한쪽에만 있어야 «빛을 받은 몸»이 된다.
  // 뒤쪽 팔다리는 한 톤 어둡게 해 앞뒤가 겹쳐도 갈린다.
  const RIM = [201, 243, 255];
  const PAL = {
    far: { dark: [7, 22, 28], lit: [16, 49, 58], rim: [170, 228, 245], rimA: 0.5, seamA: 0.16, dl: 2.6 },
    mid: { dark: [10, 31, 37], lit: [24, 67, 78], rim: RIM, rimA: 1, seamA: 0.3, dl: 4.4 },
    near: { dark: [12, 37, 44], lit: [29, 79, 91], rim: RIM, rimA: 1, seamA: 0.34, dl: 2.8 },
    scarf: { dark: [104, 44, 21], lit: [182, 90, 45], rim: [255, 228, 200], rimA: 0.8, seamA: 0, dl: 1.8 }
  };
  const SEAM = [120, 205, 220];
  // 장갑·장화·허리띠 — 옷 위에 반투명하게 덧칠해 한 톤 어둡게 (아래의 빛·그늘이 그대로 비친다)
  const GEAR = 'rgba(2,9,12,0.32)';
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
  const mixC = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

  /**
   * 한 덩어리(팔 하나, 몸통 하나…)를 빛에 맞춰 칠한다. 윤곽 path 를 빛 쪽·반대쪽으로 조금씩 밀어
   * 겹쳐 칠하는 것만으로 그늘 띠와 테두리 빛이 몸을 따라 생긴다 — 팔다리가 어느 각도로 돌아도
   * 따로 계산할 것이 없다.
   *   1) 바탕 어둡게 (가장자리 반투명 픽셀이 테두리색으로 물들지 않게)
   *   2) 윤곽 안으로 잘라 두고, 빛 쪽으로 민 윤곽을 테두리색으로 → 빛 반대쪽 가장자리엔 안 닿는다
   *   3) 빛 반대쪽으로 민 «온몸» 윤곽을 그늘색으로 → 온몸의 빛 쪽 가장자리에만 가는 테두리가 남는다
   *   4) 그 안으로 한 번 더 잘라, 빛 쪽으로 크게 민 제 윤곽을 밝은 옷색으로 → 그늘 쪽에 넓은 그늘 띠
   */
  function shade(ctx, p, all, prev, acc, sm, pal, lx, ly, U, extra) {
    const dr = 0.62 * U, dl = pal.dl * U;
    if (prev) {
      // 뒤에 먼저 그린 몸 위로만 어두운 맞닿음 선 — 앞 팔이 몸통 앞을 지날 때 둘이 한 덩어리로 붙지 않게.
      // 바깥(배경)으로는 긋지 않는다: 거기까지 그으면 다시 «윤곽선»이 된다
      ctx.save();
      ctx.clip(prev);
      ctx.strokeStyle = 'rgba(2,8,11,0.6)';
      ctx.lineWidth = 1.3 * U;
      ctx.stroke(p);
      ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = rgb(pal.dark);
    ctx.fill(p);
    ctx.clip(p);
    ctx.translate(lx * dr, ly * dr);
    ctx.fillStyle = rgb(pal.rim, pal.rimA);
    ctx.fill(p);
    ctx.translate(-2 * lx * dr, -2 * ly * dr);
    ctx.fillStyle = rgb(pal.dark);
    // 덮는 판은 «온몸» 실루엣 — 빛 쪽 가장자리라도 다른 몸 조각 앞에 겹친 곳이면 테두리 빛이 없다.
    // 조각마다 제 윤곽으로 테두리를 두르면 팔·다리가 몸통 앞을 지날 때마다 흰 금이 생겨 인형 관절처럼 보였다
    ctx.fill(all);
    ctx.clip(all);
    ctx.translate(lx * (dr + dl), ly * (dr + dl));
    ctx.fillStyle = rgb(pal.lit);
    ctx.fill(p);
    ctx.translate(-lx * dl, -ly * dl);
    if (acc) { ctx.fillStyle = GEAR; ctx.fill(acc); }
    if (sm && pal.seamA > 0) {
      ctx.strokeStyle = rgb(SEAM, pal.seamA);
      ctx.lineWidth = 0.5 * U;
      ctx.lineCap = 'round';
      ctx.stroke(sm);
    }
    if (extra) extra();
    ctx.restore();
  }

  /** 장갑 손 — 쥔 정도(grip)로 주먹과 편 손 사이를 섞는다. 엄지는 굽힘 안쪽(없으면 몸 앞) */
  function handLoop(p, A, U, ant, fw) {
    let dx = A.hand[0] - A.elbow[0], dy = A.hand[1] - A.elbow[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    let nx = -dy, ny = dx;
    if (2 * (ant[0] * nx + ant[1] * ny) + (fw[0] * nx + fw[1] * ny) < 0) { nx = -nx; ny = -ny; }
    const g = A.grip, wx = A.wrist[0], wy = A.wrist[1];
    const pts = [];
    for (let i = 0; i < FIST.length; i++) {
      const u = lerp(OPEN[i][0], FIST[i][0], g) * U, v = lerp(OPEN[i][1], FIST[i][1], g) * U;
      pts.push([wx + dx * u + nx * v, wy + dy * u + ny * v]);
    }
    loop(p, pts);
  }

  /** 장화 — 발끝을 조금 편다(곡예사의 발). 정면으로 돌면 발 길이가 비친 만큼 짧아진다 */
  function bootLoop(p, Lg, U, point) {
    const ax = Lg.ankle[0], ay = Lg.ankle[1];
    let sx = ax - Lg.knee[0], sy = ay - Lg.knee[1];
    const sl = Math.hypot(sx, sy) || 1;
    sx /= sl; sy /= sl;
    let fx = Lg.toe[0] - ax, fy = Lg.toe[1] - ay;
    const fl = Math.hypot(fx, fy);
    if (fl < 1e-6) { fx = -sy; fy = sx; } else { fx /= fl; fy /= fl; }
    const k = clamp(fl / (RIG.foot * U), 0.35, 1);
    const cs = Math.cos(point), sn = Math.sin(point);
    const ux = fx * cs + sx * sn, uy = fy * cs + sy * sn;      // 발끝 쪽
    const vx = -fx * sn + sx * cs, vy = -fy * sn + sy * cs;    // 발바닥 쪽
    loop(p, BOOT.map(([a, b]) => [ax + (ux * a * k + vx * b) * U, ay + (uy * a * k + vy * b) * U]));
  }

  function legShape(p, acc, sm, Lg, U) {
    const g = bendDir(Lg.hip, Lg.knee, Lg.ankle, RIG.thigh * U * 0.2);
    const gm = Math.hypot(g[0], g[1]);
    const tA = [g[0] + Lg.thAnt[0] * (1 - gm), g[1] + Lg.thAnt[1] * (1 - gm)];
    const sA = [g[0] + Lg.shAnt[0] * (1 - gm), g[1] + Lg.shAnt[1] * (1 - gm)];
    limbLoop(p, Lg.hip, Lg.knee, PROF.thigh, U, tA);
    limbLoop(p, Lg.knee, Lg.ankle, PROF.shin, U, sA);
    bootLoop(p, Lg, U, 0.38);
    // 장화 — 정강이 중간부터
    limbLoop(acc, Lg.knee, Lg.ankle, PROF.shin, U, sA, 0.52);
    bootLoop(acc, Lg, U, 0.38);
    crossSeam(sm, Lg.knee, Lg.ankle, PROF.shin, U, sA, 0.52, 0.22);
    // 허벅지 바깥 옆선
    longSeam(sm, Lg.hip, Lg.knee, PROF.thigh, U, tA, 0.14, 0.78, -0.25);
  }

  function armShape(p, acc, sm, A, U, fw) {
    // 팔의 «앞»(이두근)은 굽힘 안쪽 — 팔꿈치 끝이 향하는 쪽의 반대
    const g = bendDir(A.sh, A.elbow, A.hand, RIG.uarm * U * 0.22);
    const ant = [-g[0], -g[1]];
    limbLoop(p, A.sh, A.elbow, PROF.uarm, U, ant);
    limbLoop(p, A.elbow, A.wrist, PROF.farm, U, ant);
    handLoop(p, A, U, ant, fw);
    // 장갑 — 아래팔 끝부터
    limbLoop(acc, A.elbow, A.wrist, PROF.farm, U, ant, 0.72);
    handLoop(acc, A, U, ant, fw);
    crossSeam(sm, A.elbow, A.wrist, PROF.farm, U, ant, 0.72, 0.25);
  }

  /** 몸통의 s 자리 — [중심 x, y, 앞(+fw) 굵기 px, 뒤 굵기 px] */
  function torsoAt(J, U, s) {
    const n = TORSO.length;
    let i = 0;
    while (i < n - 2 && s > TORSO[i + 1][0]) i++;
    const a = TORSO[i], b = TORSO[i + 1];
    const k = clamp((s - a[0]) / (b[0] - a[0]), 0, 1);
    const fr = J.front;
    const br = s > 0.5 && s < 0.95 ? J.breath : 1;
    const col = (j) => lerp(a[j], b[j], k);
    const wp = lerp(col(1), col(3), fr) * br * U, wm = lerp(col(2), col(3), fr) * br * U;
    const off = col(4) * (1 - fr) * U, L = RIG.torso * U;
    return [J.pelvis[0] + J.tu[0] * s * L + J.fw[0] * off, J.pelvis[1] + J.tu[1] * s * L + J.fw[1] * off, wp, wm];
  }

  function torsoShape(p, acc, sm, J, U) {
    const fw = J.fw, fr = J.front;
    const P = [], M = [];
    for (const r of TORSO) {
      const [cx, cy, wp, wm] = torsoAt(J, U, r[0]);
      P.push([cx + fw[0] * wp, cy + fw[1] * wp]);
      M.push([cx - fw[0] * wm, cy - fw[1] * wm]);
    }
    loop(p, P.concat(M.reverse()));
    limbLoop(p, J.chest, J.headBase, PROF.neck, U, [J.hfx, J.hfy]);
    // 허리띠 — 골반 위 좁은 띠
    const band = (s0, s1, grow) => {
      const a = torsoAt(J, U, s0), b = torsoAt(J, U, s1), gU = grow * U;
      loop(acc, [
        [a[0] + fw[0] * (a[2] + gU), a[1] + fw[1] * (a[2] + gU)], [b[0] + fw[0] * (b[2] + gU), b[1] + fw[1] * (b[2] + gU)],
        [b[0] - fw[0] * (b[3] + gU), b[1] - fw[1] * (b[3] + gU)], [a[0] - fw[0] * (a[3] + gU), a[1] - fw[1] * (a[3] + gU)]
      ]);
    };
    band(0.07, 0.15, 0.3);
    const line = (s) => {
      const a = torsoAt(J, U, s);
      sm.moveTo(a[0] + fw[0] * a[2], a[1] + fw[1] * a[2]);
      sm.lineTo(a[0] - fw[0] * a[3], a[1] - fw[1] * a[3]);
    };
    line(0.155);
    // 옆판 이음선 — 정면에선 겨드랑이에서 허리띠로 좁아지는 두 줄(역삼각형 몸을 따라), 옆모습에선 두 줄이
    // 겹쳐 어깨 앞에서 등허리로 흐르는 옆선 하나. 가슴을 가로지르는 U 자는 거꾸로 매달리면 웃는 입처럼 보였다
    const at = (s, lat) => {
      const q = torsoAt(J, U, s);
      return [q[0] + fw[0] * lat * U, q[1] + fw[1] * lat * U];
    };
    for (const sd of [-1, 1]) {
      const A = at(lerp(0.9, 0.8, fr), lerp(4.6, 6.9 * sd, fr));
      const B = at(lerp(0.55, 0.46, fr), lerp(1.2, 4.6 * sd, fr));
      const C = at(lerp(0.2, 0.17, fr), lerp(-4.2, 4.3 * sd, fr));
      sm.moveTo(A[0], A[1]);
      sm.quadraticCurveTo(B[0], B[1], C[0], C[1]);
    }
  }

  function headShape(p, acc, sm, J, U) {
    const R = HEAD_R * U, lk = clamp(J.look, 0, 1);
    const P = (v, u) => [J.head[0] + (J.hfx * v + J.hux * u) * R, J.head[1] + (J.hfy * v + J.huy * u) * R];
    const pts = [];
    for (let i = 0; i < HEAD_S.length; i++) {
      pts.push(P(lerp(HEAD_F[i][0], HEAD_S[i][0], lk), lerp(HEAD_F[i][1], HEAD_S[i][1], lk)));
    }
    loop(p, pts);
    // 턱 가리개 이음선 — 귀 밑에서 턱 앞으로. 옆모습에서만 — 정면에선 눈띠 밑의 U 자가 웃는 입이 됐다
    if (lk > 0.3) {
      const a = P(-0.12, -0.08), b = P(0.44, -0.74), c = P(0.92, -0.3);
      sm.moveTo(a[0], a[1]);
      sm.quadraticCurveTo(b[0], b[1], c[0], c[1]);
    }
    // 정수리 능선 — 정면에서 가운데, 옆으로 돌면 이마 쪽으로 밀려나 가장자리에서 사라진다
    const r0 = P(lerp(0, 0.6, lk), 0.98 - 0.12 * lk), r1 = P(lerp(0, 0.9, lk), 0.36);
    sm.moveTo(r0[0], r0[1]);
    sm.lineTo(r1[0], r1[1]);
    // 귀 자리의 둥근 판 — 옆모습에서만 보인다
    if (lk > 0.05) {
      const e = P(lerp(-0.86, -0.24, lk), 0.02), er = 0.14 * R * lk;
      sm.moveTo(e[0] + er, e[1]);
      sm.arc(e[0], e[1], er, 0, TAU);
      acc.moveTo(e[0] + er * 0.6, e[1]);
      acc.arc(e[0], e[1], er * 0.6, 0, TAU);
    }
  }

  /**
   * 호박색 눈띠 — 머리 윤곽 안에 잘린 채 그려 머리를 «감싼» 띠가 된다. 정면에선 가운데 넓게 관자놀이로
   * 살짝 치켜 올라가고, 옆을 보면 얼굴 앞으로 몰려 앞끝이 윤곽 밖으로 넘어간다(잘려서 둘러 감긴 것처럼)
   */
  function visorBand(J, U, scale) {
    const R = HEAD_R * U, lk = clamp(J.look, 0, 1), open = 1 - 0.85 * J.blink;
    const vc = lerp(0, 0.52, lk), half = lerp(0.66, 0.54, lk);
    const top = [], bot = [];
    for (let i = 0; i <= 8; i++) {
      const q = -1 + i / 4, qb = (1 - q) / 2;
      const v = vc + q * half;
      // 정면: 가운데가 낮고 바깥으로 곧게 올라가는 V (둥글게 휘면 웃는 입처럼 보였다). 옆모습: 뒤로 치켜 올라간다
      const u = lerp(0.1 + 0.11 * Math.abs(q), 0.04 + 0.2 * qb * qb, lk);
      const th = lerp(0.11 - 0.07 * Math.abs(q) ** 1.5, 0.1 - 0.06 * qb * qb, lk) * scale * (0.15 + 0.85 * open);
      const cx = J.head[0] + (J.hfx * v + J.hux * u) * R, cy = J.head[1] + (J.hfy * v + J.huy * u) * R;
      top.push([cx + J.hux * th * R, cy + J.huy * th * R]);
      bot.push([cx - J.hux * th * R, cy - J.huy * th * R]);
    }
    const p = new Path2D();
    p.moveTo(top[0][0], top[0][1]);
    for (let i = 1; i <= 8; i++) p.lineTo(top[i][0], top[i][1]);
    for (let i = 8; i >= 0; i--) p.lineTo(bot[i][0], bot[i][1]);
    p.closePath();
    return p;
  }

  function drawVisor(ctx, J, U) {
    const open = 1 - 0.85 * J.blink;
    ctx.fillStyle = 'rgba(255,140,50,0.28)';
    ctx.fill(visorBand(J, U, 2.6));
    ctx.fillStyle = `rgba(255,178,82,${(0.35 + 0.65 * open).toFixed(3)})`;
    ctx.fill(visorBand(J, U, 1));
    ctx.fillStyle = `rgba(255,242,208,${(0.85 * open).toFixed(3)})`;
    ctx.fill(visorBand(J, U, 0.32));
  }

  /** 눈띠 빛이 얼굴 밖으로 조금 번진다 — 흐림 필터 대신 작은 방사 그라디언트 하나 */
  function visorGlow(ctx, J, U) {
    const R = HEAD_R * U, lk = clamp(J.look, 0, 1), open = 1 - 0.85 * J.blink;
    const v = lerp(0, 0.8, lk), u = 0.08;
    const x = J.head[0] + (J.hfx * v + J.hux * u) * R, y = J.head[1] + (J.hfy * v + J.huy * u) * R;
    const g = ctx.createRadialGradient(x, y, 0, x, y, R * 1.3);
    g.addColorStop(0, `rgba(255,160,70,${(0.2 * open).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,160,70,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R * 1.3, 0, TAU);
    ctx.fill();
  }

  /** 목에 감은 목도리 — 머리와 어깨 사이에 색 한 줄이 들어가면 거기가 «목»으로 읽힌다 */
  function drawCollar(ctx, J, U, root, lx, ly) {
    const cx = lerp(J.chest[0], J.headBase[0], 0.3), cy = lerp(J.chest[1], J.headBase[1], 0.3);
    const nx = -J.huy, ny = J.hux;
    const hw = (3.0 + 0.9 * J.front) * U;
    const p = new Path2D();
    limbLoop(p, [cx - nx * hw, cy - ny * hw], [cx + nx * hw, cy + ny * hw],
      [[0, 1.2, 1.2], [0.5, 1.6, 1.4], [1, 1.2, 1.2]], U, [-J.hux, -J.huy]);
    // 매듭 — 꼬리가 나오는 자리
    limbLoop(p, root, [root[0] + (root[0] - cx) * 0.08, root[1] + (root[1] - cy) * 0.08 + 0.4 * U],
      [[0, 1.8, 1.8], [1, 1.6, 1.6]], U, null);
    shade(ctx, p, p, null, null, null, PAL.scarf, lx, ly, U);
  }

  function drawFigure(ctx, st, J, root, lx, ly) {
    const U = J.U;
    // 작은 미리보기(320x180)에선 이음선이 픽셀 먼지가 될 뿐이라 뺀다
    const detail = U > 0.8;
    const mk = (build) => {
      const g = { p: new Path2D(), acc: new Path2D(), sm: new Path2D() };
      build(g.p, g.acc, g.sm);
      return g;
    };
    const legF = mk((p, acc, sm) => legShape(p, acc, sm, J.legF, U));
    const armF = mk((p, acc, sm) => armShape(p, acc, sm, J.armF, U, J.fw));
    const torso = mk((p, acc, sm) => torsoShape(p, acc, sm, J, U));
    const head = mk((p, acc, sm) => headShape(p, acc, sm, J, U));
    const legN = mk((p, acc, sm) => legShape(p, acc, sm, J.legN, U));
    const armN = mk((p, acc, sm) => armShape(p, acc, sm, J.armN, U, J.fw));
    const order = J.farTop ? [legF, torso, armF, head, legN, armN] : [legF, armF, torso, head, legN, armN];
    const all = new Path2D();
    for (const g of order) all.addPath(g.p);
    // 먼저 그린 조각들의 합 — 맞닿음 선은 여기에만
    // 맞닿음 선은 팔에만 — 다리와 몸통은 원래 이어진 살이라 선을 그으면 속옷 자국처럼 보였다
    let prev = null;
    const group = (g, pal, extra, contact) => {
      shade(ctx, g.p, all, contact ? prev : null, g.acc, detail ? g.sm : null, pal, lx, ly, U, extra);
      const np = new Path2D();
      if (prev) np.addPath(prev);
      np.addPath(g.p);
      prev = np;
    };
    // 정면으로 돌수록 «뒤쪽» 팔다리도 앞쪽만큼 가깝다 — 어두운 톤을 풀어 준다.
    // 덜 풀면(0.65) 정면으로 매달렸을 때 한쪽 허벅지 머리만 어둡게 튀어나와 혹처럼 보였다
    const fk = 0.92 * J.front;
    const far = {
      dark: mixC(PAL.far.dark, PAL.near.dark, fk), lit: mixC(PAL.far.lit, PAL.near.lit, fk),
      rim: mixC(PAL.far.rim, RIM, fk), rimA: lerp(PAL.far.rimA, 0.9, fk), seamA: lerp(PAL.far.seamA, 0.3, fk), dl: 2.6
    };
    group(legF, far);
    if (!J.farTop) group(armF, far, null, true);
    group(torso, PAL.mid);
    if (J.farTop) group(armF, far, null, true);
    drawCollar(ctx, J, U, root, lx, ly);
    group(head, PAL.mid, () => drawVisor(ctx, J, U), true);
    visorGlow(ctx, J, U);
    group(legN, PAL.near);
    group(armN, PAL.near, null, true);
  }

  /**
   * 목도리 중심선 — 마디마다 «조금 전 목의 속도»의 반대쪽으로 흘린다. 뒤 마디일수록 더 먼 과거를 본다.
   * 빠르면 뒤로 곧게 흐르고, 느리면 늘어져 바람에 흔들린다. 적분이 없어 어느 t 든 같은 모양.
   */
  function scarfPts(st, t, J) {
    const U = J.U;
    // 몸길이만큼 길게 — 짧으면(처음엔 몸의 1/3) 쉬는 동안 흔들려도 꼬리 하나가 달린 것처럼만 보였다
    const N = 13, seg = 6.3 * U;
    const idle = smooth(span(t, 3.2, 5.5));
    const hang = smooth(span(t, T.impact, T.impact + 0.9));
    // 매듭은 목 옆 — 정면일 땐 바람 쪽으로 비켜 매어, 거꾸로 매달린 머리 한가운데서 끈이 나오지 않게
    const root = [lerp(J.chest[0], J.headBase[0], 0.35) + st.wind * (4.5 + 1.5 * hang) * J.front * U, lerp(J.chest[1], J.headBase[1], 0.35)];
    const pts = [root];
    let x = root[0], y = root[1];
    // 머리 둘레 — 목도리 중심선이 이 안으로 들어오지 못한다. 떨어질 때 목도리가 머리를 한 바퀴 감아
    // 닫힌 고리가 됐고, 매달린 뒤엔 머리 바로 뒤로 곧게 흘러 «빛나는 공에 꼬리»로 읽혔다(검토 지적)
    const hr = (HEAD_R + 4.4) * U;
    let a0 = 0, aPrev = 0, aOut = 0;
    for (let i = 0; i < N; i++) {
      const tl = t - 0.028 * (i + 1);
      const a = neckAt(st, tl), b = neckAt(st, tl - 0.02);
      const vx = (a[0] - b[0]) / 0.02 / st.U, vy = (a[1] - b[1]) / 0.02 / st.U;
      const sp = Math.hypot(vx, vy);
      let dx = -vx / 260, dy = -vy / 260 + 1;
      const q = i / N, tail = 0.35 + q;
      dx += (0.5 * Math.sin(TAU * t / 6.3 + i * 0.45) + 0.22 * Math.sin(TAU * t / 2.9 + i * 0.9)) * tail;
      // 쉬는 동안엔 화면 가장자리 쪽으로 옅은 바람 — 머리 밑으로 곧게 떨어지면 몸에 붙은 꼬리처럼 읽혔다
      dx += idle * st.wind * (0.42 + 0.12 * Math.sin(TAU * t / 13.7)) * tail;
      // 매달린 뒤엔 첫 몇 마디를 바람 쪽 옆으로 뻗는다 — 매듭에서 곧장 떨어지면 머리 뒤를 지나 몸 가운데 선에
      // 걸린다. 옆으로 한 뼘 나간 뒤 떨어지면 머리와 떨어진 «목에서 날리는 천»이 된다
      dx += hang * st.wind * 1.25 * Math.max(0, 1 - i / 4.5);
      dy += 0.1 * Math.sin(TAU * t / 3.7 + i * 0.7);
      const flap = clamp(sp / 950) * 0.5 * Math.sin(i * 0.95 - t * 21);
      // 끝으로 갈수록 커지는 너울 — 천이 한 번씩 물결치는 게 멀리서도 보이게 (세기도 느리게 오르내린다)
      const ripple = idle * (0.2 + 0.12 * Math.sin(TAU * t / 9.1)) * q * Math.sin(TAU * t / 1.7 - i * 0.62);
      let an = Math.atan2(dy, dx) + flap + ripple;
      // 감김 제한 — 첫 마디 방향에서 휜 정도를 ±110° 쯤으로 부드럽게 눌러 담는다(tanh). 돌며 떨어질 때 지난
      // 속도를 따라가면 목도리가 한 바퀴를 넘게 말려 고리가 됐다. 반 바퀴 안쪽이면 고리는 닫힐 수 없다.
      // 딱 잘라 막았더니(clamp) 그 자리에서 천이 «ㄱ» 자로 꺾여 막대처럼 보였다 — 눌러 담으면 둥글게 휜다.
      // 휜 정도는 앞 마디에 이어 붙여(펼쳐) 잰다: -π..π 로 접으면 반 바퀴를 넘는 순간 부호가 뒤집혀 튄다
      // 한 마디에 꺾이는 각도 ±0.55 로 막는다 — 떨어지기 시작하는 순간(목 속도가 0 을 지나며 방향이 확 바뀜)
      // 이웃 마디 방향이 크게 달라 천이 모서리처럼 접혔다. 속도가 빠를 때 펄럭임(flap)은 이 안에 든다
      if (i === 0) { a0 = an; aPrev = an; aOut = an; } else {
        aPrev += an - aPrev - TAU * Math.round((an - aPrev) / TAU);
        const want = a0 + 1.9 * Math.tanh((aPrev - a0) / 1.9);
        aOut += clamp(want - aOut, -0.55, 0.55);
        an = aOut;
      }
      x += Math.cos(an) * seg; y += Math.sin(an) * seg;
      const hx = x - J.head[0], hy = y - J.head[1], hd = Math.hypot(hx, hy);
      if (hd < hr) {
        const m = hd > 1e-6 ? hr / hd : 0;
        x = hd > 1e-6 ? J.head[0] + hx * m : x + st.wind * hr;
        y = hd > 1e-6 ? J.head[1] + hy * m : y;
      }
      pts.push([x, y]);
    }
    return pts;
  }

  /**
   * 목도리 천 — 끝으로 갈수록 가늘어지는 띠. 천이 느리게 비틀려, 뒤집히는 자리에서 좁아지고(접힘)
   * 앞면은 밝게 뒷면은 어둡게 보인다. v1 의 한 색 납작한 띠는 «주황 선»이지 천이 아니었다
   */
  function drawScarf(ctx, t, J, pts, lx, ly) {
    const U = J.U, N = pts.length - 1;
    const L = [], R = [], face = [], nrm = [];
    for (let i = 0; i <= N; i++) {
      const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(N, i + 1)];
      const tx = pb[0] - pa[0], ty = pb[1] - pa[1], d = Math.hypot(tx, ty) || 1;
      const nx = -ty / d, ny = tx / d;
      const q = i / N;
      // 비틀림 위상 — 시간에 따라 천을 따라 흘러간다 (주기 함수만 써서 되풀이 이음매 없음)
      const tw = 0.6 + i * 0.52 - t * 1.6 + 0.7 * Math.sin(TAU * t / 5.3 + i * 0.33);
      const c = Math.cos(tw);
      const wdt = lerp(3.9, 1.1, q) * (0.38 + 0.62 * Math.abs(c)) * U;
      L.push([pts[i][0] + nx * wdt, pts[i][1] + ny * wdt]);
      R.push([pts[i][0] - nx * wdt, pts[i][1] - ny * wdt]);
      face.push(c);
      nrm.push([nx, ny]);
    }
    const base = new Path2D();
    base.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < N; i++) base.quadraticCurveTo(L[i][0], L[i][1], (L[i][0] + L[i + 1][0]) / 2, (L[i][1] + L[i + 1][1]) / 2);
    base.lineTo(L[N][0], L[N][1]);
    base.lineTo(R[N][0], R[N][1]);
    for (let i = N - 1; i > 0; i--) base.quadraticCurveTo(R[i][0], R[i][1], (R[i][0] + R[i - 1][0]) / 2, (R[i][1] + R[i - 1][1]) / 2);
    base.lineTo(R[0][0], R[0][1]);
    base.closePath();
    ctx.save();
    ctx.fillStyle = rgb(PAL.scarf.dark);
    ctx.fill(base);
    ctx.clip(base);
    // 밝은 앞면 — 한쪽 가장자리에서 천이 이쪽을 향한 만큼 안쪽까지. 한 덩어리로 칠해야 마디 사이에
    // 이음 금이 안 생긴다 (조각마다 칠했더니 사다리처럼 금이 보였다)
    const Mi = L.map((l, i) => {
      const k = clamp(0.5 + 0.5 * face[i]);
      return [lerp(l[0], R[i][0], k), lerp(l[1], R[i][1], k)];
    });
    const lit = new Path2D();
    lit.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < N; i++) lit.quadraticCurveTo(L[i][0], L[i][1], (L[i][0] + L[i + 1][0]) / 2, (L[i][1] + L[i + 1][1]) / 2);
    lit.lineTo(L[N][0], L[N][1]);
    lit.lineTo(Mi[N][0], Mi[N][1]);
    for (let i = N - 1; i > 0; i--) lit.quadraticCurveTo(Mi[i][0], Mi[i][1], (Mi[i][0] + Mi[i - 1][0]) / 2, (Mi[i][1] + Mi[i - 1][1]) / 2);
    lit.lineTo(Mi[0][0], Mi[0][1]);
    lit.closePath();
    ctx.fillStyle = rgb(PAL.scarf.lit, 0.95);
    ctx.fill(lit);
    // 접힌 자리 — 천이 뒤집히는 곳에 어두운 주름
    ctx.lineWidth = 0.7 * U;
    for (let i = 1; i < N; i++) {
      const k = 1 - Math.abs(face[i]) / 0.35;
      if (k <= 0) continue;
      ctx.strokeStyle = `rgba(40,12,4,${(0.55 * k).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(L[i][0], L[i][1]); ctx.lineTo(R[i][0], R[i][1]); ctx.stroke();
    }
    // 테두리 빛 — 빛을 향한 가장자리에만, 천이 이쪽을 향한 만큼
    ctx.lineWidth = 1.3 * U;
    ctx.lineCap = 'butt';
    for (let i = 0; i < N; i++) {
      const dn = nrm[i][0] * lx + nrm[i][1] * ly;
      const E = dn > 0 ? L : R;
      const a = clamp(Math.abs(dn) * 1.5) * (0.35 + 0.65 * Math.abs(face[i])) * 0.7;
      if (a < 0.02) continue;
      ctx.strokeStyle = rgb(PAL.scarf.rim, a);
      ctx.beginPath(); ctx.moveTo(E[i][0], E[i][1]); ctx.lineTo(E[i + 1][0], E[i + 1][1]); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 인물이 차지한 자리(CSS px) — 몸·팔다리·목도리만. 거미줄·도시는 뺀다.
   * 확대 검사(animlab ANIM_ZOOM)가 이걸로 인물 둘레를 잘라 본다. draw 와 같은 순수 함수.
   */
  function focus(t, w, h, st) {
    const J = pose(st, t), U = J.U;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (q, r) => {
      x0 = Math.min(x0, q[0] - r); y0 = Math.min(y0, q[1] - r);
      x1 = Math.max(x1, q[0] + r); y1 = Math.max(y1, q[1] + r);
    };
    add(J.head, HEAD_R * 1.05 * U);
    add(J.pelvis, 7 * U);
    add(J.chest, 10 * U);
    for (const A of [J.armN, J.armF]) { add(A.sh, 4.6 * U); add(A.elbow, 3.4 * U); add(A.hand, 7 * U); }
    for (const Lg of [J.legN, J.legF]) { add(Lg.hip, 6.2 * U); add(Lg.knee, 4.4 * U); add(Lg.ankle, 4 * U); add(Lg.toe, 6 * U); }
    for (const q of scarfPts(st, t, J)) add(q, 4 * U);
    const pad = 0.15 * Math.max(x1 - x0, y1 - y0);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }

  function draw(ctx, t, w, h, st) {
    ctx.save();
    drawSky(ctx, t, st);
    drawWebs(ctx, t, st);
    const J = pose(st, t);
    // 빛은 화면 가운데(휴식 글 자리)에서 — 매달려 쉴 때 글 쪽 가장자리가 밝다
    let lx = w * 0.5 - J.chest[0], ly = h * 0.47 - J.chest[1];
    const ld = Math.hypot(lx, ly) || 1;
    lx /= ld; ly /= ld;
    drawSpeed(ctx, t, st);
    drawRopes(ctx, t, st, J);
    const sc = scarfPts(st, t, J);
    drawScarf(ctx, t, J, sc, lx, ly);
    drawFigure(ctx, st, J, sc[0], lx, ly);
    drawFlashes(ctx, t, st, J);
    ctx.restore();
  }

  NA.scenes.swing = { arrival: 1.55, setup, draw, focus };
})();

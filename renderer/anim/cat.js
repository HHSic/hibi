'use strict';
/**
 * 등장 연출 — 고양이.
 *
 * 예전 고양이는 «귀 달린 네모»가 아래에서 솟는 SVG였다. 조잡하다는 말을 들었다 —
 * 움직이는 게 아니라 «밀려 올라오는» 그림이었기 때문이다. 이번엔 진짜 고양이처럼
 * 뼈대(갈비·골반·목·머리·다리 두 마디·꼬리 사슬)를 세우고, 매 프레임 그 뼈대 위로
 * 부드러운 곡선 살을 입힌다.
 *
 * 흐름: 왼쪽 밖에서 걸어 들어와 멈춤 → 우리를 보며 천천히 눈 깜빡 («믿는다»는 고양이 인사)
 *       → 쭉 기지개 + 하품 → 앉아 꼬리로 발 감기 → 식빵 자세로 내려앉아 꾸벅꾸벅 (계속).
 *
 * 모든 움직임은 t 의 식이다. 걸음은 setup 에서 «발을 언제 떼고 어디 딛는지» 표를 미리
 * 만들어 두고, draw 는 그 표를 읽기만 한다. 꼬리의 늦게 따라오는 휨은 «조금 전 시각의
 * 자세»를 마디마다 다시 계산해 얻는다 — 적분이 없으니 어느 시각이든 똑같이 그려진다.
 *
 * 좌표: 고양이 몸 기준 «단위»(U = min(w,h)/100 × CAT_SCALE) 로 모든 치수를 잡고, 그리기 직전에
 * translate·scale 한 번으로 화면에 올린다. 그래서 4K 든 세로 모니터든 비율이 같다.
 * 쉬는 자리는 왼쪽 아래 — 가운데 글·아래 단추·오른쪽 위 초를 비켜 앉는다.
 *
 * 칠은 «밤에 찍은 까만 고양이 사진»을 겨냥한다: 살은 배경보다 어둡고, 뒤 위에서 오는 차가운
 * 테두리 빛이 등·머리·귀·꼬리 윤곽 «안쪽»에 가늘게 맺히고, 등·어깨·엉덩이·정수리에 넓고 옅은
 * 윤기, 배와 턱 밑은 더 어둡다. 블러 없이 «밀린 실루엣 겹치기»와 타원 그라디언트만 쓴다 (아래 «빛»).
 * 그래서 4K 에서도 싸다.
 */
(() => {
  const NA = window.nunsAnim;
  if (!NA || !NA.scenes) return;

  // ── 작은 도구 ─────────────────────────────────────────
  // engine 의 fx 와 같은 것이지만, 이 파일만 따로 읽혀도(시험 도구) 돌도록 따로 둔다
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const span = (t, a, b) => clamp((t - a) / (b - a));
  const smooth = (k) => k * k * (3 - 2 * k);
  const inOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const outC = (k) => 1 - Math.pow(1 - k, 3);
  const inQ = (k) => k * k;
  /** 부드러운 혹 — a 에서 올라 b..c 동안 1, d 에서 다시 0. 끝이 정확히 0 이라 주기로 돌려도 안 튄다 */
  const bump = (t, a, b, c, d) => (t <= a || t >= d ? 0 : t < b ? smooth((t - a) / (b - a)) : t <= c ? 1 : smooth((d - t) / (d - c)));
  /** 감쇠 진동 — 멈춘 뒤 몸무게가 «출렁»하고 가라앉는 것 */
  const wob = (t, t0, amp, freq, damp) => (t < t0 ? 0 : amp * Math.exp(-damp * (t - t0)) * Math.sin(TAU * freq * (t - t0)));
  /** 양수 나머지 — 음수 t 에서도 주기 함수가 이어지게 */
  const mod = (a, n) => ((a % n) + n) % n;

  /**
   * 두 마디 역운동학 — 어깨(a)에서 손목(b)까지 길이 l1·l2 로 잇는 관절 자리.
   * side 로 무릎이 앞(+1)으로 꺾일지 뒤(-1)로 꺾일지 정한다 (앞다리 팔꿈치는 뒤, 뒷다리 무릎은 앞).
   * 닿지 않으면 쭉 편다 — 억지로 늘이면 다리가 고무처럼 보인다.
   */
  function ik(ax, ay, bx, by, l1, l2, side) {
    let dx = bx - ax, dy = by - ay;
    let d = Math.hypot(dx, dy) || 1e-6;
    const maxD = (l1 + l2) * 0.999;
    if (d > maxD) { dx *= maxD / d; dy *= maxD / d; d = maxD; }
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const ux = dx / d, uy = dy / d;
    // 진행 방향의 수직. y 가 아래로 자라는 좌표라 (uy,-ux) 가 «위쪽» 수직이다
    const px = uy * side, py = -ux * side;
    return [ax + ux * a + px * hh, ay + uy * a + py * hh];
  }

  /**
   * Catmull-Rom 을 베지어로 — 관절 점들을 «꺾이지 않고» 지나는 곡선.
   * 다리·꼬리 테두리를 이걸로 그어야 소시지를 이어 붙인 티가 안 난다.
   */
  function through(p, pts, from) {
    const n = pts.length;
    for (let i = from; i < n - 1; i++) {
      const p0 = pts[i - 1 < 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 < n ? i + 2 : n - 1];
      p.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]);
    }
  }

  /**
   * 굵기가 변하는 팔다리·꼬리 한 줄기. 점마다 좌우로 굵기만큼 벌린 두 곡선을 긋고 끝을 둥글게 닫는다.
   * 좌우 굵기(반폭)를 따로 받는다 — 다리는 뒤쪽(팔꿈치 뼈·발뒤꿈치)만 불룩하고 앞선은 거의 곧다.
   * 양쪽을 같이 부풀리면 관절이 «구슬 꿴 막대»처럼 보인다 (v1 의 다리가 그랬다).
   * wl 은 진행 방향의 왼쪽이다. 화면은 y 가 아래로 자라므로, 아래로 뻗는 다리에서는 뒤쪽이 된다.
   */
  function limb2(pts, wl, wr) {
    const n = pts.length;
    const L = new Array(n), R = new Array(n);
    let nx = 0, ny = -1, tx0 = 0, ty0 = 1, txn = 0, tyn = 1, got = false;
    for (let i = 0; i < n; i++) {
      const a = pts[i - 1 < 0 ? 0 : i - 1], b = pts[i + 1 < n ? i + 1 : n - 1];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty);
      if (l > 1e-6) {
        tx /= l; ty /= l; nx = -ty; ny = tx; txn = tx; tyn = ty;
        if (!got) { tx0 = tx; ty0 = ty; got = true; }
      }
      L[i] = [pts[i][0] + nx * wl[i], pts[i][1] + ny * wl[i]];
      R[i] = [pts[i][0] - nx * wr[i], pts[i][1] - ny * wr[i]];
    }
    const p = new Path2D();
    p.moveTo(L[0][0], L[0][1]);
    through(p, L, 0);
    // 끝 뚜껑 — 반원을 베지어 하나로 (조절점을 반폭의 4/3 만큼 앞으로)
    const le = L[n - 1], re = R[n - 1], ke = 1.33;
    p.bezierCurveTo(le[0] + txn * wl[n - 1] * ke, le[1] + tyn * wl[n - 1] * ke,
      re[0] + txn * wr[n - 1] * ke, re[1] + tyn * wr[n - 1] * ke, re[0], re[1]);
    R.reverse();
    through(p, R, 0);
    // 시작 끝도 둥글게 — 몸 밖으로 살짝 삐져나올 때 네모난 단면이 보이면 안 된다
    const rs = R[n - 1], ls = L[0];
    p.bezierCurveTo(rs[0] - tx0 * wr[0] * ke, rs[1] - ty0 * wr[0] * ke,
      ls[0] - tx0 * wl[0] * ke, ls[1] - ty0 * wl[0] * ke, ls[0], ls[1]);
    p.closePath();
    return p;
  }

  // ── 자세 ─────────────────────────────────────────────
  // 자세는 숫자 묶음이다. 키 사이를 섞을 수 있어야 «앉는 중»·«눕는 중» 같은 사이 동작이
  // 저절로 나온다. 몸 기준 좌표: x 앞(+), y 아래(+). 땅이 y=0.
  const FIELDS = [
    // 몸통 — 골반과 갈비를 따로 둬야 등뼈가 휜다 (기지개의 오목한 등, 식빵의 둥근 등)
    'hipX', 'hipY', 'hipRx', 'hipRy', 'ribX', 'ribY', 'ribRx', 'ribRy', 'arch', 'belly',
    // 머리 — yaw 는 우리 쪽으로 돌린 정도(라디안). 옆얼굴 0, 거의 정면 1.2
    'headX', 'headY', 'headRot', 'yaw', 'earN', 'earF', 'eye', 'mouth',
    // 발 — 딛는 자리. Meta 는 발등이 서 있나(0) 누웠나(1), Flex 는 앞발목이 접힌 정도
    'fnx', 'fny', 'fMetaN', 'fFlexN', 'ffx', 'ffy', 'fMetaF', 'fFlexF',
    'hnx', 'hny', 'hMetaN', 'hfx', 'hfy', 'hMetaF',
    // 꼬리 — 뿌리 각, 뿌리 쪽 휨, 고른 휨, 끝 갈고리
    'tA', 'tB', 'tC', 'tH'
  ];
  const I = {};
  FIELDS.forEach((f, i) => { I[f] = i; });
  const NF = FIELDS.length;

  // 선 자세. 다리 길이·몸통 비율은 실제 집고양이 치수(몸길이 45cm, 어깨높이 24cm)에서 옮겼다.
  const STAND = {
    hipX: -7.6, hipY: -15.2, hipRx: 6.2, hipRy: 5.1, ribX: 5.8, ribY: -14.4, ribRx: 7.4, ribRy: 6.7, arch: 1.1, belly: -0.3,
    headX: 17.8, headY: -22.4, headRot: 0.06, yaw: 0.12, earN: 0, earF: 0, eye: 1, mouth: 0,
    fnx: 8.6, fny: 0, fMetaN: 0, fFlexN: 0, ffx: 6.6, ffy: 0, fMetaF: 0, fFlexF: 0,
    hnx: -8.6, hny: 0, hMetaN: 0, hfx: -6.6, hfy: 0, hMetaF: 0,
    tA: -1.95, tB: 0.55, tC: 0.03, tH: 1.0
  };
  // 쭉 기지개 — 엉덩이는 높게, 가슴은 바닥 가까이, 등은 오목하게. 앞발은 멀리.
  const STRETCH = {
    hipX: -8.0, hipY: -15.6, ribX: 4.4, ribY: -8.0, ribRy: 5.8, arch: -2.4, belly: 0.0,
    headX: 16.4, headY: -12.6, headRot: -0.34, yaw: 0.05,
    fnx: 20.8, fMetaN: 0.62, ffx: 19.3, fMetaF: 0.62,
    tA: -1.6, tB: 0.45, tC: 0.03, tH: 0.9
  };
  // 앉은 자세 — 골반이 땅에, 뒷발등이 눕고, 앞다리는 곧게. 꼬리는 앞발을 감는다.
  // 꼬리 뿌리 각은 선 자세(-1.95, 위)에서 «뒤로» 돌아 내려와야 한다. 2.2 로 적으면 섞는 중에
  // 0(앞)을 지나 꼬리가 몸을 뚫고 휘두른다 — 그래서 한 바퀴 뺀 값으로 적는다.
  // 앉을 때 앞발은 한 걸음 물리고 뒷발은 끌어당긴다 — 선 자리 그대로 앉으면 앞다리가 비스듬히 누워 버린다.
  const SIT = {
    hipX: -11.0, hipY: -6.4, hipRx: 7.7, hipRy: 6.4, ribX: -3.2, ribY: -14.8, ribRx: 6.8, ribRy: 5.8, arch: 2.0, belly: 0.3,
    headX: 1.4, headY: -25.2, headRot: 0.02, yaw: 1.05,
    // 먼 앞발은 가까운 앞발보다 한 발 반 뒤에 — 1.2 만 물렸을 땐 먼 앞다리가 가까운 다리 뒤에 거의 다
    // 숨어 빛 띠 한 줄만 남았다. 조금 더 물려야 한 겹 뒤의 다리로 폭이 보인다.
    fnx: 3.2, fMetaN: 0, ffx: 1.1, fMetaF: 0,
    hnx: -5.2, hMetaN: 1, hfx: -4.2, hMetaF: 1,
    tA: 1.8 - TAU, tB: -1.35, tC: -0.05, tH: -0.45
  };
  // 식빵 — 발을 다 품고 둥글게. 등은 둥근 지붕, 머리는 가슴 위에 얹힌다. 눈은 반쯤.
  const LOAF = {
    hipX: -8.6, hipY: -6.4, hipRx: 6.6, hipRy: 6.4, ribX: 2.4, ribY: -7.4, ribRx: 7.6, ribRy: 7.2, arch: 2.2, belly: 0,
    headX: 10.4, headY: -15.6, headRot: 0.1, yaw: 0.85,
    fnx: 9.0, fMetaN: 1, ffx: 8.0, fMetaF: 1,
    hnx: -3.0, hMetaN: 1, hfx: -2.0, hMetaF: 1,
    tA: 1.75 - TAU, tB: -1.55, tC: -0.02, tH: -0.2
  };

  // 필드를 무리로 나눠 따로 키를 준다 — 한 무리의 키가 다른 무리의 흐름을 끊지 않게.
  // (발 하나를 드는 순간마다 몸통까지 «멈칫»하면 로봇처럼 보인다)
  const GROUPS = {
    body: ['hipX', 'hipY', 'hipRx', 'hipRy', 'ribX', 'ribY', 'ribRx', 'ribRy', 'arch', 'belly'],
    head: ['headX', 'headY', 'headRot', 'yaw'],
    face: ['earN', 'earF', 'eye', 'mouth'],
    fn: ['fnx', 'fny', 'fMetaN', 'fFlexN'],
    ff: ['ffx', 'ffy', 'fMetaF', 'fFlexF'],
    hn: ['hnx', 'hny', 'hMetaN'],
    hf: ['hfx', 'hfy', 'hMetaF'],
    tail: ['tA', 'tB', 'tC', 'tH']
  };
  const EASE = { io: inOut, out: outC, in: inQ, s: smooth, lin: (k) => k };

  // ── 시간표 ───────────────────────────────────────────
  // 걸음(0~1.4) → 멈춤·출렁 → 우리 쪽 보기·천천히 깜빡(2.3) → 기지개(3.4~6) + 하품
  // → 앉기(6.1~7.4) → 앉아서 깜빡·갸웃 → 식빵(9.7~11.5) → 꾸벅꾸벅 (영원히)
  const T_STOP = 1.38;
  const ARRIVAL = 1.45;
  const T_IDLE = 11.6;
  const pick = (o, extra) => Object.assign({}, o, extra || {});
  const STRETCH_DEEP = pick(STRETCH, { ribY: -7.5, hipY: -15.9, arch: -2.7, ribX: 3.8 });
  const SIT_MID = { hipX: -9.8, hipY: -10.0, ribX: 2.2, ribY: -14.0, arch: 0.2, belly: 0.3 };
  const LOAF_MID = { hipX: -10.2, hipY: -6.3, ribX: -0.6, ribY: -10.6, ribRx: 7.2, ribRy: 6.4, arch: 1.4, belly: 0.2 };

  // [시각, 이 키로 들어오는 가속, 값]. 값에 없는 필드는 앞 키 값을 이어 쓴다.
  const TRACKS = {
    body: [
      [0, 'io', STAND], [3.4, 'io', STAND], [4.45, 'io', STRETCH], [5.3, 's', STRETCH_DEEP],
      [6.05, 'io', STAND], [6.75, 'in', SIT_MID], [7.4, 'out', SIT],
      [9.7, 'io', SIT], [10.6, 'io', LOAF_MID], [11.5, 'io', LOAF]
    ],
    head: [
      [0, 'io', STAND], [1.45, 'io', STAND],
      [2.15, 'io', { yaw: 1.12, headRot: -0.03, headX: 17.2, headY: -23.1 }], [3.3, 'io', {}],
      [3.8, 'io', { yaw: 0.1, headRot: 0.12, headX: 17.7, headY: -21.4 }],
      [4.5, 'io', STRETCH], [5.25, 's', { headX: 16.9, headY: -13.6, headRot: -0.55, yaw: 0.08 }],
      [6.05, 'io', pick(STAND, { yaw: 0.35 })], [7.35, 'io', SIT], [8.85, 'io', {}],
      [9.3, 'io', { headRot: 0.24, headX: 1.8 }], [9.8, 'io', SIT], [11.5, 'io', LOAF]
    ],
    face: [
      [0, 'io', STAND], [4.45, 'io', {}], [4.65, 'io', { eye: 0.7 }],
      [4.95, 'io', { mouth: 1, eye: 0.06, earN: 0.42, earF: 0.42 }], [5.2, 's', {}],
      [5.5, 'io', { mouth: 0, eye: 0.92, earN: 0, earF: 0 }], [6.0, 'io', { eye: 1 }],
      [9.9, 'io', {}], [11.6, 'io', { eye: 0.42 }]
    ],
    fn: [
      [0, 'io', STAND], [3.45, 'io', {}],
      [3.72, 'io', { fnx: 14.8, fny: -2.4, fMetaN: 0.2, fFlexN: 0.9 }],
      [4.0, 'out', { fnx: STRETCH.fnx, fny: 0, fMetaN: STRETCH.fMetaN, fFlexN: 0 }], [5.3, 'io', {}],
      [5.58, 'io', { fnx: 13.4, fny: -2.2, fMetaN: 0.15, fFlexN: 0.9 }],
      [5.85, 'out', { fnx: 7.2, fny: 0, fMetaN: 0, fFlexN: 0 }], [6.55, 'io', {}],
      [6.85, 'io', { fnx: 5.0, fny: -1.8, fFlexN: 0.8 }], [7.1, 'out', { fnx: SIT.fnx, fny: 0, fFlexN: 0 }],
      [9.8, 'io', {}], [10.1, 'io', { fnx: 5.6, fny: -1.5, fFlexN: 0.7 }],
      [10.4, 'out', { fnx: LOAF.fnx, fny: 0, fFlexN: 0, fMetaN: 0.3 }], [11.3, 'io', { fMetaN: 1 }]
    ],
    ff: [
      [0, 'io', STAND], [3.68, 'io', {}],
      [3.96, 'io', { ffx: 13.4, ffy: -2.4, fMetaF: 0.2, fFlexF: 0.9 }],
      [4.24, 'out', { ffx: STRETCH.ffx, ffy: 0, fMetaF: STRETCH.fMetaF, fFlexF: 0 }], [5.5, 'io', {}],
      [5.78, 'io', { ffx: 11.8, ffy: -2.2, fMetaF: 0.15, fFlexF: 0.9 }],
      [6.05, 'out', { ffx: 5.8, ffy: 0, fMetaF: 0, fFlexF: 0 }], [6.75, 'io', {}],
      [7.02, 'io', { ffx: 3.6, ffy: -1.8, fFlexF: 0.8 }], [7.27, 'out', { ffx: SIT.ffx, ffy: 0, fFlexF: 0 }],
      [10.0, 'io', {}], [10.3, 'io', { ffx: 4.4, ffy: -1.5, fFlexF: 0.7 }],
      [10.6, 'out', { ffx: LOAF.ffx, ffy: 0, fFlexF: 0, fMetaF: 0.3 }], [11.4, 'io', { fMetaF: 1 }]
    ],
    hn: [[0, 'io', STAND], [6.2, 'io', {}], [7.35, 'io', SIT], [10.0, 'io', {}], [11.4, 'io', LOAF]],
    hf: [[0, 'io', STAND], [6.3, 'io', {}], [7.45, 'io', SIT], [10.1, 'io', {}], [11.5, 'io', LOAF]],
    tail: [
      [0, 'io', STAND], [1.5, 'io', {}], [2.4, 'io', { tA: -1.8, tB: 0.75, tC: 0.05, tH: 1.4 }], [3.4, 'io', {}],
      [4.45, 'io', STRETCH], [5.3, 's', {}], [6.0, 'io', STAND],
      [6.6, 'io', { tA: -2.75, tB: 0.2, tC: 0.1, tH: 0.7 }],
      // 내려오는 도중에 끝이 먼저 앞으로 말려 있어야 한다. 끝 마디는 0.5초 늦게 따라오므로, 뿌리가
      // 바닥을 따라 앞으로 갈 때 끝이 아직 «뒤로» 향해 있으면 바닥에서 접혀 뭉툭한 토막이 됐다.
      [7.1, 'in', { tA: -3.9, tB: -0.9, tC: -0.02, tH: -0.6 }], [7.6, 'out', SIT],
      [9.8, 'io', {}], [11.6, 'io', LOAF]
    ]
  };

  // 눈 깜빡임 — [시작, 감기, 머물기, 뜨기]. «천천히 깜빡»은 고양이가 «너 괜찮아»라고 하는 인사다.
  const BLINKS = [
    [2.3, 0.34, 0.24, 0.52], [3.15, 0.07, 0.03, 0.11], [6.9, 0.07, 0.03, 0.11],
    [7.9, 0.36, 0.26, 0.58], [9.15, 0.07, 0.03, 0.12]
  ];

  // ── 걸음 ─────────────────────────────────────────────
  // 몸의 위치 X(t): 일정한 속도로 오다가 끝에서 고르게 느려져 멈춘다.
  // cad: 멈추는 동안에도 발 박자는 이만큼(처음의 70%) 유지한다. 속도만큼 박자까지 느려지면
  // 마지막 0.4초 동안 네 발이 다 땅에 붙은 채 몸만 미끄러져 «썰매»처럼 보였다 (검토 지적).
  // 실제 고양이도 설 때는 보폭을 줄여 종종걸음으로 선다.
  const WALK = { xs: -31, rest: 27, t1: 0.82, stride: 25, beta: 0.6, cad: 0.7 };
  WALK.d = T_STOP - WALK.t1;
  WALK.v0 = (WALK.rest - WALK.xs) / (WALK.t1 + WALK.d / 2);
  WALK.f = WALK.v0 / WALK.stride;
  WALK.swing = (1 - WALK.beta) / WALK.f;

  function walkX(t) {
    const W = WALK;
    if (t < W.t1) return W.xs + W.v0 * t;
    if (t < T_STOP) { const u = t - W.t1; return W.xs + W.v0 * W.t1 + W.v0 * (u - (u * u) / (2 * W.d)); }
    return W.rest;
  }
  function walkSpeed(t) { return t < WALK.t1 ? 1 : t < T_STOP ? 1 - (t - WALK.t1) / WALK.d : 0; }
  /** 걸음 박자(보폭 단위). 느려지는 동안 박자는 cad 까지만 떨어진다 — 그만큼 보폭이 짧아진다 */
  function walkPhase(t) {
    const W = WALK;
    if (t < W.t1) return W.f * t;
    const u = Math.min(t, T_STOP) - W.t1;
    return W.f * (W.t1 + W.cad * u + (1 - W.cad) * (u - (u * u) / (2 * W.d)));
  }
  const walkRate = (t) => WALK.f * (WALK.cad + (1 - WALK.cad) * walkSpeed(t));

  /**
   * 네 발의 «뗌·디딤» 표. 걷는 순서는 고양이의 가로 순서(왼뒤, 왼앞, 오른뒤, 오른앞).
   * 디딘 발은 땅에 박혀 있어야 한다 — 몸이 나아가도 발이 미끄러지면 바로 가짜 티가 난다.
   * 그래서 디딤 자리는 «그때 몸 위치 + 보폭 절반»으로 딱 정해 두고, 떼기 전까지 안 움직인다.
   * 멈춘 뒤 제자리에서 어긋난 발은 한 번씩 «발을 모으는» 걸음으로 정리한다.
   */
  function buildGait() {
    const W = WALK;
    const phiEnd = walkPhase(T_STOP);
    const invPhi = (ph) => {
      if (ph <= 0) return ph / W.f;
      let a = 0, b = T_STOP;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (walkPhase(m) < ph) a = m; else b = m; }
      return (a + b) / 2;
    };
    const legs = [
      { key: 'hn', x: 'hnx', y: 'hny', meta: 'hMetaN', o: 0, lift: 2.1, hind: true },
      { key: 'fn', x: 'fnx', y: 'fny', meta: 'fFlexN', o: 0.25, lift: 2.5, hind: false },
      { key: 'hf', x: 'hfx', y: 'hfy', meta: 'hMetaF', o: 0.5, lift: 2.1, hind: true },
      { key: 'ff', x: 'ffx', y: 'ffy', meta: 'fFlexF', o: 0.75, lift: 2.5, hind: false }
    ];
    let end = 0, squareIdx = 0;
    for (const leg of legs) {
      const nx = STAND[leg.x];
      const target = W.rest + nx;
      const steps = [];
      for (let k = -2; k < 10; k++) {
        const phL = k + W.beta - leg.o;
        if (phL < -1.05) continue;
        if (phL >= phiEnd - 0.04) break;
        // 발이 떠 있는 시간은 그때 박자에 맞춘다 — 느려질수록 조금 길어진다
        const tL = invPhi(phL), tD = tL + (1 - W.beta) / walkRate(tL);
        const from = steps.length ? steps[steps.length - 1].to : walkX(tL) + nx - (W.stride * W.beta) / 2;
        // 디딤 자리는 «이번 디딤 동안 몸이 지나갈 길의 한가운데». 속도가 줄면 길이 짧아지니
        // 보폭도 저절로 짧아지고, 디딘 발은 여전히 한 치도 안 미끄러진다.
        // 다음 뗌이 멈춘 뒤라면 이게 마지막 걸음 — 곧장 선 자세의 자리에 딛는다 (따로 발 모으기가 필요 없다).
        let to;
        if (phL + 1 >= phiEnd - 0.04) to = target;
        else to = nx + (walkX(tD) + walkX(invPhi(phL + 1))) / 2;
        steps.push({ tL, tD, from, to });
      }
      const last = steps[steps.length - 1];
      if (Math.abs(last.to - target) > 0.5) {
        const tL = Math.max(last.tD + 0.03, T_STOP - 0.02 + 0.15 * squareIdx++);
        steps.push({ tL, tD: tL + 0.26, from: last.to, to: target });
      }
      leg.steps = steps;
      end = Math.max(end, steps[steps.length - 1].tD);
    }
    return { legs, end };
  }

  /** 발 하나의 자리 (몸 기준) — 표만 읽는다 */
  function footAt(leg, t, X) {
    const st = leg.steps;
    let x = st[0].from, y = 0, sw = 0;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      if (t < s.tL) { x = s.from; break; }
      if (t < s.tD) {
        const k = (t - s.tL) / (s.tD - s.tL);
        // 짧은 종종걸음도 발을 «든» 게 보여야 걸음으로 읽힌다 — 드는 높이에 바닥값을 둔다
        const reach = 0.4 + 0.6 * clamp(Math.abs(s.to - s.from) / (WALK.stride * 0.6));
        x = lerp(s.from, s.to, smooth(k));
        sw = Math.sin(Math.PI * k) * reach;
        // 발은 일찍 높이 떴다가 앞에서 사뿐히 내려앉는다 — 들어 올리는 곡선을 앞으로 기울인다
        y = -leg.lift * Math.pow(Math.sin(Math.PI * Math.pow(k, 0.8)), 1.2) * reach;
        break;
      }
      x = s.to;
    }
    return [x - X, y, sw];
  }

  // ── 자세 계산 ────────────────────────────────────────
  function buildTracks() {
    const out = [];
    for (const g in GROUPS) {
      const idx = GROUPS[g].map((f) => I[f]);
      const times = [], eases = [], vals = [];
      let prev = null;
      for (const [tk, e, v] of TRACKS[g]) {
        const row = idx.map((fi, j) => (v[FIELDS[fi]] != null ? v[FIELDS[fi]] : prev ? prev[j] : STAND[FIELDS[fi]]));
        times.push(tk); eases.push(EASE[e]); vals.push(row); prev = row;
      }
      out.push({ name: g, idx, times, eases, vals });
    }
    return out;
  }

  function evalTrack(tr, t, out) {
    const { times, vals, idx } = tr;
    const n = times.length;
    if (t <= times[0]) { for (let j = 0; j < idx.length; j++) out[idx[j]] = vals[0][j]; return; }
    if (t >= times[n - 1]) { for (let j = 0; j < idx.length; j++) out[idx[j]] = vals[n - 1][j]; return; }
    let i = 0;
    while (i < n - 2 && t >= times[i + 1]) i++;
    const k = tr.eases[i + 1]((t - times[i]) / (times[i + 1] - times[i]));
    const a = vals[i], b = vals[i + 1];
    for (let j = 0; j < idx.length; j++) out[idx[j]] = a[j] + (b[j] - a[j]) * k;
  }

  /** 한 번 «탁» — 0 에서 시작해 0 으로 끝나 주기로 돌려도 이음매가 없다 */
  const flick = (q, len) => (q > 0 && q < len ? Math.pow(Math.sin((Math.PI * q) / len), 2) : 0);

  /** 꼬리 네 값 (시각 t) — 마디마다 조금 전 시각으로 불러 «늦게 따라오는» 휨을 만든다 */
  function tailAt(S, t) {
    const o = new Float64Array(NF);
    evalTrack(S.tailTrack, t, o);
    let a = o[I.tA], c = o[I.tC], h = o[I.tH];
    const b = o[I.tB];
    const sr = walkSpeed(t), ph = walkPhase(t);
    // 걸을 때 엉덩이가 구르는 박자에 맞춰 꼬리가 흔들린다
    a += 0.09 * Math.sin(TAU * ph) * sr;
    h += 0.22 * Math.sin(TAU * ph + 1.2) * sr;
    // 멈춘 순간 꼬리는 관성으로 한 번 앞으로 쏠렸다 돌아온다
    h += wob(t, T_STOP, 0.5, 1.3, 2.6);
    // 서서 구경할 때 끝이 느긋하게 까딱
    h += 0.28 * Math.sin((TAU * (t - 1.5)) / 2.4) * bump(t, 1.5, 2.2, 3.1, 3.6);
    // 기지개 끝의 떨림 — 온몸에 힘이 들어간 순간
    a += 0.035 * Math.sin(TAU * 7.5 * t) * bump(t, 4.35, 4.6, 5.1, 5.35);
    // 앉은 뒤로는 끝만 가끔 «탁» 친다. 바닥에 누운 꼬리라 끝을 «들어» 올려야 보인다 (아래로 치면 땅에 묻힌다)
    const sitK = span(t, 7.5, 8.2);
    h -= sitK * (0.55 * flick(mod(t - 8.4, 5.3), 0.9) + 0.3 * flick(mod(t - 10.1, 7.9), 0.7));
    // 느린 휨 흔들림 — 마디마다 쌓이므로 작게. 0.025 였을 땐 식빵 옆구리를 타고 꼬리가
    // 반쯤 올라가 넓적다리 윤곽처럼 읽혔다.
    c += sitK * 0.01 * Math.sin((TAU * t) / 6.1);
    return [a, b, c, h];
  }

  function poseAt(S, t) {
    const p = new Float64Array(NF);
    for (const tr of S.tracks) evalTrack(tr, t, p);
    const X = walkX(t), sr = walkSpeed(t), ph = walkPhase(t);

    // 걷는 동안 발은 표에서. 떠 있는 동안 뒷발등은 접히고 앞발목은 꺾여 발바닥이 뒤를 본다.
    if (t < S.gait.end) {
      for (const leg of S.gait.legs) {
        const f = footAt(leg, t, X);
        p[I[leg.x]] = f[0]; p[I[leg.y]] = f[1];
        p[I[leg.meta]] += (leg.hind ? 0.4 : 1.0) * f[2];
      }
    }
    // 네 박자 걸음은 한 보폭에 몸이 두 번 내려앉는다. 어깨와 엉덩이는 박자가 어긋난다.
    const bob = TAU * 2 * ph;
    p[I.hipY] += 0.42 * sr * Math.cos(bob);
    p[I.ribY] += 0.42 * sr * Math.cos(bob + 1.4);
    // 머리는 거의 그대로 — 고양이는 걸어도 시선이 흔들리지 않는다
    p[I.headY] += 0.1 * sr * Math.cos(bob + 2.0);
    // 멈춤: 앞으로 쏠린 무게가 한 번 출렁이고 가라앉는다
    p[I.ribX] += wob(t, T_STOP - 0.05, 0.55, 1.5, 4.5);
    p[I.ribY] += wob(t, T_STOP, 0.35, 1.9, 4.0);
    p[I.hipY] += wob(t, T_STOP + 0.06, 0.25, 1.9, 4.0);
    p[I.headX] += wob(t, T_STOP, 0.45, 1.4, 4.2);

    // 숨 — 서 있을 땐 얕게, 잠들수록 깊게. 주기는 하나라 크기가 변해도 이음매가 없다.
    const breathAmt = span(t, 1.6, 3.0) * lerp(0.55, 1.0, span(t, 10.5, 12.5));
    const br = Math.sin((TAU * t) / 3.3);
    p[I.ribRy] += 0.34 * breathAmt * br;
    p[I.ribY] -= 0.22 * breathAmt * br;
    p[I.arch] += 0.3 * breathAmt * br;
    p[I.headY] -= 0.08 * breathAmt * br;

    // 눈 깜빡임
    let shut = 0;
    for (const [s, c, hd, o] of BLINKS) shut = Math.max(shut, bump(t, s, s + c, s + c + hd, s + c + hd + o));
    const idle = span(t, T_IDLE, T_IDLE + 1.2);
    // 졸 때: 8.7초마다 느린 깜빡, 23.3초마다 한 번 눈을 좀 더 떠 우리를 본다
    shut = Math.max(shut, idle * bump(mod(t - T_IDLE, 8.7), 4.0, 4.5, 4.9, 5.7));
    const peek = idle * bump(mod(t - T_IDLE, 23.3), 12.0, 12.8, 14.6, 15.6);
    // 꾸벅 — 17.9초마다 머리가 천천히 떨어졌다가 «흠칫» 하고 올라온다
    const qn = mod(t - T_IDLE, 17.9);
    const nod = idle * bump(qn, 6.0, 8.6, 8.9, 9.35);
    p[I.eye] = clamp((p[I.eye] + 0.4 * peek) * (1 - shut) * (1 - 0.75 * nod), 0, 1);
    p[I.headY] += 1.0 * nod + idle * 0.22 * Math.sin((TAU * t) / 6.6);
    p[I.headRot] += 0.14 * nod + idle * 0.035 * Math.sin((TAU * t) / 6.6 - 0.9);
    p[I.yaw] += -0.25 * nod + 0.12 * peek;

    // 귀 — 멈춰 우리를 볼 때 쫑긋, 기지개 전 한쪽 귀 돌리기, 앉아서 반대 귀 파닥, 졸 때 가끔 씰룩
    let eN = wob(t, 1.5, -0.22, 2.4, 3.5), eF = wob(t, 1.56, -0.2, 2.4, 3.5);
    eN += 0.6 * bump(t, 3.0, 3.12, 3.5, 3.85);
    eF += wob(t, 8.45, 0.55, 4.5, 6.0);
    eN += idle * (0.5 * flick(mod(t - T_IDLE - 1.4, 6.3), 0.32) + 0.3 * flick(mod(t - T_IDLE - 1.9, 6.3), 0.25));
    eF += idle * 0.55 * flick(mod(t - T_IDLE - 4.6, 9.7), 0.3);
    // 흠칫 깨는 순간 두 귀가 같이 선다
    eN -= idle * 0.3 * flick(qn - 8.75, 0.5);
    eF -= idle * 0.3 * flick(qn - 8.8, 0.5);
    p[I.earN] += eN; p[I.earF] += eF;
    return p;
  }

  // ── 살 입히기 ────────────────────────────────────────
  const HEAD_R = 4.7;
  // 화면 단위에 곱하는 고양이 크기. 앉은 키(귀 끝)가 짧은 변의 약 30% 가 되게 맞췄다.
  const CAT_SCALE = 0.92;
  const TAIL_N = 12;
  const TAIL_SEG = 2.05;
  // 발 한가운데의 높이. 발 모양을 따로 그리므로 v1(1.05)보다 낮다 — 발이 납작하게 땅을 딛는다.
  const PAW_R = 0.82;

  /** 머리 좌표계 — 머리 반지름 단위의 3D 점을 돌려(yaw) 옆에서 본 평면으로 눕힌다 */
  function headFrame(p) {
    const cy = Math.cos(p[I.yaw]), sy = Math.sin(p[I.yaw]);
    const cr = Math.cos(p[I.headRot]), sr = Math.sin(p[I.headRot]);
    const hx = p[I.headX], hy = p[I.headY];
    return {
      cy, sy, rot: p[I.headRot],
      pt(x, y, z) {
        const xx = (x * cy - z * sy) * HEAD_R, yy = y * HEAD_R;
        return [hx + xx * cr - yy * sr, hy + xx * sr + yy * cr];
      },
      /** 점이 우리 쪽을 보는 정도 (-1..1) — 먼 쪽 눈·귀 안쪽을 가릴지 정한다 */
      facing(nx, nz) { return nx * sy + nz * cy; }
    };
  }

  function torsoPath(p) {
    const c2x = p[I.hipX], c2y = p[I.hipY], c1x = p[I.ribX], c1y = p[I.ribY];
    let ux = c1x - c2x, uy = c1y - c2y;
    const d = Math.hypot(ux, uy) || 1;
    ux /= d; uy /= d;
    const nx = uy, ny = -ux; // 등 쪽
    const ang = Math.atan2(uy, ux);
    const r1 = p[I.ribRy], r2 = p[I.hipRy], R1 = p[I.ribRx], R2 = p[I.hipRx], k = d * 0.4, ar = p[I.arch], be = p[I.belly];
    // 오목한 등(기지개)에서 어깨 쪽 조절점까지 같이 끌어내리면 등선이 어깨에서 너무 깊게 꺼진다.
    // 어깨 쪽은 덜 끌어내린다.
    const ar1 = ar < 0 ? ar * 0.35 : ar;
    // 등선이 갈비·골반 타원과 «꺾이지 않고» 만나는 자리. 예전엔 등선을 두 타원의 꼭대기에 이었는데,
    // 휜 등(arch)만큼 등선은 비스듬히 들어오고 타원 꼭대기는 몸 축과 나란해서 거기서 각이 졌다 —
    // 테두리 빛 띠가 그 자리에서 턱처럼 끊겨 어깨(목 뿌리)와 식빵 엉덩이에 홈이 보였다 (검토 지적).
    // 그래서 등선이 들어오는 기울기와 타원의 기울기가 같아지는 자리까지 이음점을 타원을 따라 옮긴다.
    // 조절점은 예전과 같아서 등의 모양은 그대로이고 이음매만 매끈해진다.
    const f1 = Math.atan((ar1 / k) * (R1 / r1)), f2 = Math.atan((ar / k) * (R2 / r2));
    const s1 = Math.sin(f1), o1 = Math.cos(f1), s2 = Math.sin(f2), o2 = Math.cos(f2);
    // 타원 위 이음점 (몸 축 u, 등 쪽 n 으로 적은 것)
    const j1x = c1x + ux * R1 * s1 + nx * r1 * o1, j1y = c1y + uy * R1 * s1 + ny * r1 * o1;
    const j2x = c2x - ux * R2 * s2 + nx * r2 * o2, j2y = c2y - uy * R2 * s2 + ny * r2 * o2;
    // 그 자리의 타원 접선 (앞으로 가는 쪽)
    let t1x = ux * R1 * o1 - nx * r1 * s1, t1y = uy * R1 * o1 - ny * r1 * s1;
    let t2x = ux * R2 * o2 + nx * r2 * s2, t2y = uy * R2 * o2 + ny * r2 * s2;
    const l1 = Math.hypot(t1x, t1y) || 1, l2 = Math.hypot(t2x, t2y) || 1;
    t1x /= l1; t1y /= l1; t2x /= l2; t2y /= l2;
    const K1 = Math.hypot(k, ar1), K2 = Math.hypot(k, ar);
    const path = new Path2D();
    path.moveTo(j2x, j2y);
    path.bezierCurveTo(j2x + t2x * K2, j2y + t2y * K2, j1x - t1x * K1, j1y - t1y * K1, j1x, j1y);
    path.ellipse(c1x, c1y, R1, r1, ang, -Math.PI / 2 + f1, Math.PI / 2, false);
    path.bezierCurveTo(
      c1x - nx * r1 - ux * k - nx * be, c1y - ny * r1 - uy * k - ny * be,
      c2x - nx * r2 + ux * k - nx * be, c2y - ny * r2 + uy * k - ny * be,
      c2x - nx * r2, c2y - ny * r2);
    path.ellipse(c2x, c2y, R2, r2, ang, Math.PI / 2, Math.PI * 1.5 - f2, false);
    path.closePath();
    return { path, ux, uy, nx, ny, ang, d, j1: [j1x, j1y], t1: [t1x, t1y] };
  }

  /** 발끝 방향 — 발등이 설수록 발등에 수직, 누울수록 땅을 따라 앞으로 */
  function footDir(vx, vy, meta) {
    let fx = -vy * (1 - meta) + meta, fy = vx * (1 - meta);
    const l = Math.hypot(fx, fy) || 1;
    return [fx / l, fy / l];
  }

  /**
   * 땅을 디딘 발은 바닥과 평평하게. 발등 방향을 그대로 따르면 서 있는 발끝이 살짝 들려
   * 까치발처럼 보인다. 발이 뜰수록(lift) 발등 방향으로 돌아간다.
   */
  function flatFoot(f, lift, k) {
    const a = clamp(1 - lift / 1.2) * k;
    const x = lerp(f[0], 1, a), y = lerp(f[1], 0, a), l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  }

  /**
   * 발 — 둥근 발등, 평평한 바닥, 둥근 뒤꿈치, 앞쪽에 발가락 셋의 얕은 물결.
   * v1 은 다리 끝에 동그라미를 붙여 «막대 끝에 공»이었다. 뒤꿈치와 발가락이 보여야 체중을 받친 발로 읽힌다.
   * (fx,fy) 발끝 방향, s 크기 — 바닥은 한가운데에서 s 만큼 아래.
   */
  function pawPath(cx, cy, fx, fy, s) {
    const ux = fy, uy = -fx; // 발등 쪽
    const P = (a, b) => [cx + (fx * a + ux * b) * s, cy + (fy * a + uy * b) * s];
    const pa = new Path2D();
    const C = (q1, q2, q3) => pa.bezierCurveTo(q1[0], q1[1], q2[0], q2[1], q3[0], q3[1]);
    const Q = (q1, q2) => pa.quadraticCurveTo(q1[0], q1[1], q2[0], q2[1]);
    const m = P(-0.5, 0.9);
    pa.moveTo(m[0], m[1]);
    C(P(-0.95, 0.78), P(-1.14, 0.1), P(-1.06, -0.42));   // 뒤꿈치 뒷선
    C(P(-1.0, -0.86), P(-0.78, -1.0), P(-0.4, -1.0));    // 뒤꿈치 바닥
    const b = P(0.8, -1.0);
    pa.lineTo(b[0], b[1]);
    C(P(1.18, -1.0), P(1.44, -0.8), P(1.42, -0.42));     // 앞 발가락
    Q(P(1.58, -0.08), P(1.32, 0.2));                      // 가운데 발가락
    Q(P(1.42, 0.66), P(0.9, 0.76));                       // 위 발가락
    C(P(0.6, 0.9), P(0.35, 0.98), P(0.12, 0.95));         // 발등
    pa.closePath();
    return pa;
  }

  function frontLeg(p, B, near) {
    const px = p[near ? I.fnx : I.ffx], py = p[near ? I.fny : I.ffy];
    const meta = p[near ? I.fMetaN : I.fMetaF], flex = p[near ? I.fFlexN : I.fFlexF];
    const ax = p[I.ribX] + B.ux * p[I.ribRx] * 0.32 - B.nx * p[I.ribRy] * 0.2;
    const ay = p[I.ribY] + B.uy * p[I.ribRx] * 0.32 - B.ny * p[I.ribRy] * 0.2;
    // 먼 다리는 한 겹 뒤 — 조금 가늘고 발도 조금 작다
    const k = near ? 1 : 0.9;
    const pcx = px, pcy = py - PAW_R * k;
    let vx = lerp(-0.3, -2.2, meta), vy = lerp(-2.2, -0.35, meta);
    // 발목 꺾임: 발을 들면 발바닥이 뒤를 보도록 손목 아래가 접힌다
    const fa = 1.25 * flex, c = Math.cos(fa), s = Math.sin(fa);
    const rx = vx * c - vy * s, ry = vx * s + vy * c;
    const vl = Math.hypot(rx, ry) || 1;
    vx = (rx / vl) * 2.2; vy = (ry / vl) * 2.2;
    const wx = pcx + vx, wy = pcy + vy;
    const e = ik(ax, ay, wx, wy, 6.2, 6.6, -1);
    const f = flatFoot(footDir(vx / 2.2, vy / 2.2, meta), -py, 1 - flex);
    const A = [ax, ay], Wr = [wx, wy], M = [lerp(e[0], wx, 0.45), lerp(e[1], wy, 0.45)];
    // 위팔은 몸통에 묻히고, 팔꿈치 뼈에서 뒤로 불룩 → 앞팔이 가늘어짐 → 손목 뒤 패드의 작은 혹 → 발.
    // 마디마다 따로 긋고 둥근 끝으로 겹친다. 한 줄기로 이으면 발을 들어 손목이 확 꺾일 때 안쪽 윤곽이
    // 서로 엇갈려 손목에 톱니 같은 빛 조각이 생겼다.
    const fore = limb2([A, e, M, Wr], [2.9 * k, 1.95 * k, 1.6 * k, 1.2 * k], [2.9 * k, 1.6 * k, 1.4 * k, 1.05 * k]);
    const past = limb2([Wr, [lerp(wx, pcx, 0.7), lerp(wy, pcy, 0.7)]], [1.08 * k, 0.95 * k], [1.0 * k, 0.95 * k]);
    const paw = pawPath(pcx, pcy, f[0], f[1], PAW_R * k);
    // 위팔~팔꿈치는 몸통 무리에 같이 칠한다 — 가슴 아랫선이 끊기지 않고 앞다리로 흘러내린다.
    // (다리를 통째로 몸통 뒤에 두면 «소시지 아래 막대»처럼 배 선에서 다리가 뚝 잘려 나왔다)
    const upper = limb2([A, e, M], [2.9 * k, 1.95 * k, 1.6 * k], [2.9 * k, 1.6 * k, 1.4 * k]);
    return { hind: false, lower: [fore, past, paw], upper, paw: [pcx, py], lift: -py, j: [A, e, Wr], top: [pcx + f[1] * 0.55 * PAW_R, pcy - f[0] * 0.55 * PAW_R], f };
  }

  function hindLeg(p, B, near) {
    const px = p[near ? I.hnx : I.hfx], py = p[near ? I.hny : I.hfy], meta = p[near ? I.hMetaN : I.hMetaF];
    const ax = p[I.hipX] + B.ux * p[I.hipRx] * 0.05 - B.nx * p[I.hipRy] * 0.1;
    const ay = p[I.hipY] + B.uy * p[I.hipRx] * 0.05 - B.ny * p[I.hipRy] * 0.1;
    const k = near ? 1 : 0.9;
    const pcx = px, pcy = py - PAW_R * k;
    let vx = lerp(-1.0, -5.2, meta), vy = lerp(-5.1, -0.6, meta);
    const vl = Math.hypot(vx, vy) || 1;
    vx = (vx / vl) * 5.2; vy = (vy / vl) * 5.2;
    const kx = pcx + vx, ky = pcy + vy;
    const kn = ik(ax, ay, kx, ky, 6.3, 6.5, 1);
    const f = flatFoot(footDir(vx / 5.2, vy / 5.2, meta), -py, 1);
    const at = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
    const A = [ax, ay], J = [kx, ky], Cc = [pcx, pcy];
    // 넓적다리는 굵게 시작해 무릎에서 좁아지고, 정강이 뒤 근육 → 뒤로 튀어나온 발뒤꿈치 뼈 → 가는 발등.
    // v1 은 굵은 막대 + 따로 얹은 타원이라 넓적다리가 몸에 «붙인 풍선»처럼 보였다.
    // 넓적다리·정강이·발등을 따로 긋고 둥근 끝으로 겹친다 — 무릎과 발뒤꿈치가 저절로 둥근 관절이 되고,
    // 발목이 확 접혀도 윤곽이 엇갈리지 않는다.
    const upper = limb2([A, at(A, kn, 0.45), kn], [4.4 * k, 3.9 * k, 2.0 * k], [4.4 * k, 3.5 * k, 2.25 * k]);
    const shin = limb2([kn, at(kn, J, 0.45), J], [2.0 * k, 1.6 * k, 1.2 * k], [2.2 * k, 1.25 * k, 0.9 * k]);
    const foot = limb2([J, at(J, Cc, 0.5), at(J, Cc, 0.86)], [1.0 * k, 0.8 * k, 0.86 * k], [0.9 * k, 0.76 * k, 0.86 * k]);
    const paw = pawPath(pcx, pcy, f[0], f[1], PAW_R * k * 0.96);
    // 넓적다리(upper)는 몸통 무리에 같이 칠한다 — 배 선에서 넓적다리 살이 둥글게 이어져 내려온다
    return { hind: true, lower: [shin, foot, paw], upper, paw: [pcx, py], lift: -py, j: [A, kn, J], top: [pcx + f[1] * 0.55 * PAW_R, pcy - f[0] * 0.55 * PAW_R], f };
  }

  function tailPath(S, p, t, B) {
    const bx = p[I.hipX] - B.ux * p[I.hipRx] * 0.62 + B.nx * p[I.hipRy] * 0.3;
    const by = p[I.hipY] - B.uy * p[I.hipRx] * 0.62 + B.ny * p[I.hipRy] * 0.3;
    const pts = [[bx, by]], ws = [1.55];
    let x = bx, y = by;
    // 마디 i 는 lag 초씩 늦은 자세를 따른다 — 끝으로 갈수록 휘두름이 늦게 도착한다.
    // 단, 앉으며 꼬리가 바닥에 닿는 동안(7~8초)은 늦음을 줄인다. 뿌리는 이미 바닥을 따라 앞으로
    // 가는데 0.5초 늦은 끝이 아직 뒤를 향하면, 바닥 위에서 꼬리가 되접혀 혹과 뭉툭한 끝이 생겼다.
    const lag = 0.045 * (1 - 0.7 * bump(t, 6.8, 7.1, 7.8, 8.4));
    for (let i = 0; i < TAIL_N; i++) {
      const q = tailAt(S, t - i * lag);
      const k = i / TAIL_N;
      const th = q[0] + q[1] * (1 - Math.exp(-i / 1.8)) + q[2] * i + q[3] * Math.pow(k, 2.4);
      x += Math.cos(th) * TAIL_SEG; y += Math.sin(th) * TAIL_SEG;
      // 바닥을 뚫지 않게 — 감긴 꼬리는 땅을 따라 앞으로 미끄러진다. 파고든 만큼을 그냥 잘라 내면
      // 마디들이 한 점에 뭉쳐 꼬리 끝이 뭉툭하게 잘린 토막처럼 보였다. 잃은 길이를 앞으로 돌려준다.
      if (y > -1.2) { x += (y + 1.2) * 0.55; y = -1.2; }
      pts.push([x, y]);
      ws.push(lerp(1.4, 0.86, Math.pow(k, 0.8)));
    }
    return limb2(pts, ws, ws);
  }

  function neckPath(p, H, B) {
    // 목이 시작하는 등 — 등선이 갈비 타원과 만나는 이음점 (torsoPath 의 j1). 목덜미 선은 거기서
    // 등선의 접선(t1) 그대로 출발한다. 예전엔 갈비 꼭대기 조금 안쪽에서 몸 축 방향으로 출발해,
    // 들어오는 등선과 기울기도 자리도 조금씩 어긋나 어깨에 작은 턱이 남았다.
    const wx = B.j1[0], wy = B.j1[1];
    const cx = p[I.ribX] + B.ux * p[I.ribRx] * 0.9 - B.nx * p[I.ribRy] * 0.3;
    const cy = p[I.ribY] + B.uy * p[I.ribRx] * 0.9 - B.ny * p[I.ribRy] * 0.3;
    const nape = H.pt(-0.72, -0.28, 0), mid = H.pt(0, -0.1, 0), throat = H.pt(0.18, 0.78, 0);
    const path = new Path2D();
    path.moveTo(wx, wy);
    // 목덜미 선은 등선이 가던 방향 그대로 출발해 목덜미로 휜다 — 기지개처럼 머리가 등보다 낮아져도
    // 어깨에 «턱»이 지지 않는다 (v1 은 여기서 오목한 홈이 생겼다)
    const nd = Math.hypot(nape[0] - wx, nape[1] - wy) * 0.45;
    path.quadraticCurveTo(wx + B.t1[0] * nd, wy + B.t1[1] * nd, nape[0], nape[1]);
    path.lineTo(mid[0], mid[1]);
    path.lineTo(throat[0], throat[1]);
    // 가슴털 — 앞으로 불룩한 곡선을 얕은 물결 셋으로 나눠 긋는다. v1 은 여기에 뾰족한 털 뭉치 삼각형을
    // 얹었는데, 턱 밑에 검은 가시처럼 보여 «그림 오류»로 읽혔다. 물결은 끝이 둥글어 털 가장자리로 읽힌다.
    const qx = Math.max(throat[0], cx) + 1.3, qy = lerp(throat[1], cy, 0.55);
    const bz = (s) => [
      (1 - s) * (1 - s) * throat[0] + 2 * (1 - s) * s * qx + s * s * cx,
      (1 - s) * (1 - s) * throat[1] + 2 * (1 - s) * s * qy + s * s * cy];
    let prev = throat;
    for (const s of [0.34, 0.68, 1]) {
      const q = bz(s);
      const dx = q[0] - prev[0], dy = q[1] - prev[1], l = Math.hypot(dx, dy) || 1;
      // 바깥쪽(가슴 앞)으로 조금 부푼 조절점 — 깊이는 물결 길이에 비례해 작게
      const bulge = Math.min(0.3, l * 0.12);
      path.quadraticCurveTo((prev[0] + q[0]) / 2 + (dy / l) * bulge, (prev[1] + q[1]) / 2 - (dx / l) * bulge, q[0], q[1]);
      prev = q;
    }
    // 가슴 앞에서 곧장 등(어깨 위)으로 닫는다. v1 처럼 갈비 한가운데를 거쳐 닫으면 그 안쪽 선이
    // 위를 향해, 머리 무리의 테두리 빛 띠가 어깨를 가로지르는 흰 줄로 남았다. 이 선은 아래를 향하므로 띠가 없다.
    path.closePath();
    // 가슴털 윤기가 앉을 자리 — 물결 가운데보다 조금 안쪽
    const rm = bz(0.5);
    return { path, ruff: [lerp(rm[0], p[I.ribX], 0.2), lerp(rm[1], p[I.ribY], 0.2)] };
  }

  function earGeo(p, H, near) {
    const s = near ? 1 : -1;
    const e = p[near ? I.earN : I.earF];
    const bcx = -0.13, bcy = -0.62;
    const rot = (x, y) => {
      const dx = x - bcx, dy = y - bcy, c = Math.cos(-e), sn = Math.sin(-e);
      return [bcx + dx * c - dy * sn, bcy + dx * sn + dy * c];
    };
    const zOut = 0.35 * s * Math.max(0, e);
    // 귀 밑동은 앞뒤(x)로도, 안팎(z)으로도 벌어져 있다. 한쪽으로만 벌리면 옆에서는 넓어도
    // 우리 쪽으로 돌렸을 때 뿔처럼 가늘어진다 (실제로 그랬다).
    const bf = rot(0.3, -0.76), bb = rot(-0.5, -0.46), tp = rot(-0.14, -1.58);
    const F = H.pt(bf[0], bf[1], 0.24 * s), Bk = H.pt(bb[0], bb[1], 0.8 * s), Tp = H.pt(tp[0], tp[1], 0.6 * s + zOut);
    // 그래도 먼 귀는 비스듬히 돌면 밑동 두 점이 겹쳐 뿔이 된다. 귀는 오목한 컵이라 어느 쪽에서
    // 봐도 어느 정도 폭이 있다 — 귀 축에 수직으로 최소 폭을 보장한다.
    {
      const m0x = (F[0] + Bk[0]) / 2, m0y = (F[1] + Bk[1]) / 2;
      let ax = Tp[0] - m0x, ay = Tp[1] - m0y;
      const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
      const qx = -ay, qy = ax;
      const sep = (F[0] - Bk[0]) * qx + (F[1] - Bk[1]) * qy;
      const minW = 0.62 * HEAD_R, sg = sep >= 0 ? 1 : -1;
      if (Math.abs(sep) < minW) {
        const ex = (minW * sg - sep) / 2;
        F[0] += qx * ex; F[1] += qy * ex; Bk[0] -= qx * ex; Bk[1] -= qy * ex;
      }
    }
    const gx = (F[0] + Bk[0] + Tp[0]) / 3, gy = (F[1] + Bk[1] + Tp[1]) / 3;
    /** 두 점 사이 가운데를 귀 바깥쪽으로 k(길이 비율)만큼 민 조절점 — 귀가 어느 쪽으로 돌아도 «바깥»이 맞다 */
    const out = (a, b, k) => {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      let nx = -(b[1] - a[1]), ny = b[0] - a[0];
      if (nx * (mx - gx) + ny * (my - gy) < 0) { nx = -nx; ny = -ny; }
      return [mx + nx * k, my + ny * k];
    };
    // 끝은 살짝 둥글다 — 뾰족한 끝은 종이 뿔처럼 보인다
    const ta = [lerp(Tp[0], Bk[0], 0.13), lerp(Tp[1], Bk[1], 0.13)];
    const tb = [lerp(Tp[0], F[0], 0.11), lerp(Tp[1], F[1], 0.11)];
    const path = new Path2D();
    path.moveTo(Bk[0], Bk[1]);
    // 귀 바깥(뒤)선은 둥글게 부풀고, 안(앞)선은 거의 곧다. v1 은 뒷선이 안으로 오목해 뿔처럼 보였다.
    const cb = out(Bk, ta, 0.13), cf = out(tb, F, 0.035);
    path.quadraticCurveTo(cb[0], cb[1], ta[0], ta[1]);
    path.quadraticCurveTo(Tp[0], Tp[1], tb[0], tb[1]);
    path.quadraticCurveTo(cf[0], cf[1], F[0], F[1]);
    path.closePath();
    const vis = clamp((H.facing(0.85, 0.5 * s) - 0.45 * e) * 1.3);
    // 귀 안쪽 — 밑동 가운데에서 끝 쪽으로 좁아지는 컵
    const cxm = (F[0] + Bk[0]) / 2, cym = (F[1] + Bk[1]) / 2;
    const iB = [lerp(cxm, Bk[0], 0.62), lerp(cym, Bk[1], 0.62)];
    const iT = [lerp(cxm, Tp[0], 0.8), lerp(cym, Tp[1], 0.8)];
    const iF = [lerp(cxm, F[0], 0.5), lerp(cym, F[1], 0.5)];
    const inner = new Path2D();
    inner.moveTo(iB[0], iB[1]);
    const ci1 = out(iB, iT, 0.06);
    inner.quadraticCurveTo(ci1[0], ci1[1], iT[0], iT[1]);
    inner.quadraticCurveTo(lerp(iT[0], iF[0], 0.5), lerp(iT[1], iF[1], 0.5), iF[0], iF[1]);
    inner.closePath();
    // 귀 털 — 안쪽 앞선 밑에서 끝 쪽으로 부채처럼 뻗는 가는 흰 털 몇 올
    const fur = new Path2D();
    for (let i = 0; i < 4; i++) {
      const a0 = 0.12 + 0.12 * i;
      const s0 = [lerp(iF[0], iB[0], a0), lerp(iF[1], iB[1], a0)];
      const s1 = [lerp(s0[0], Tp[0], 0.5 + 0.06 * i), lerp(s0[1], Tp[1], 0.5 + 0.06 * i)];
      const cc = [lerp(s0[0], s1[0], 0.5) + (F[0] - Bk[0]) * 0.06, lerp(s0[1], s1[1], 0.5) + (F[1] - Bk[1]) * 0.06];
      fur.moveTo(s0[0], s0[1]);
      fur.quadraticCurveTo(cc[0], cc[1], s1[0], s1[1]);
    }
    return { path, inner, fur, vis, base: [cxm, cym], tip: Tp };
  }

  function headGeo(p, H) {
    const skull = new Path2D();
    const sk = H.pt(-0.05, -0.08, 0), ch = H.pt(0.1, 0.3, 0);
    skull.ellipse(sk[0], sk[1], HEAD_R * 1.0, HEAD_R * 0.88, H.rot, 0, TAU);
    const cheeks = new Path2D();
    cheeks.ellipse(ch[0], ch[1], HEAD_R * (0.98 + 0.1 * H.sy), HEAD_R * 0.6, H.rot, 0, TAU);
    // 얼굴 옆선: 이마 → 콧등 → 코끝 → 윗입술. 턱은 하품할 때 경첩을 중심으로 벌어진다.
    const jaw = p[I.mouth] * 0.55;
    const jr = (x, y) => {
      const hx = 0.05, hy = 0.28, dx = x - hx, dy = y - hy, c = Math.cos(jaw), s = Math.sin(jaw);
      return H.pt(hx + dx * c - dy * s, hy + dx * s + dy * c, 0);
    };
    const P = (x, y) => H.pt(x, y, 0);
    const b = P(0.0, 0.1), fo = P(0.6, -0.64), st = P(0.92, -0.24), nt = P(1.14, 0.06), li = P(1.05, 0.3), mc = P(0.55, 0.38);
    const c1 = P(0.86, -0.52), c2 = P(1.1, -0.14), c3 = P(1.17, 0.22);
    const muzzle = new Path2D();
    muzzle.moveTo(b[0], b[1]);
    muzzle.lineTo(fo[0], fo[1]);
    muzzle.quadraticCurveTo(c1[0], c1[1], st[0], st[1]);
    muzzle.quadraticCurveTo(c2[0], c2[1], nt[0], nt[1]);
    muzzle.quadraticCurveTo(c3[0], c3[1], li[0], li[1]);
    muzzle.lineTo(mc[0], mc[1]);
    muzzle.closePath();
    const ll = jr(1.0, 0.34), cn = jr(0.82, 0.6), jw = jr(0.2, 0.74), cc = jr(1.0, 0.56), mj = jr(0.55, 0.38);
    const chin = new Path2D();
    chin.moveTo(mj[0], mj[1]);
    chin.lineTo(ll[0], ll[1]);
    chin.quadraticCurveTo(cc[0], cc[1], cn[0], cn[1]);
    chin.lineTo(jw[0], jw[1]);
    chin.closePath();
    return { skull, cheeks, muzzle, chin, mouth: [mc, li, ll], nose: nt };
  }

  // ── 빛 ───────────────────────────────────────────────
  // 까만 고양이는 «까맣게» 칠하면 어두운 휴식 화면에서 사라진다. 그렇다고 회색으로 칠하면 까만 고양이가
  // 아니다. 밤에 찍은 까만 고양이 사진처럼: 살은 배경보다 어둡고, 빛은 둘뿐이다 —
  //   · 뒤 위에서 오는 차가운 테두리 빛 (등·머리·귀·꼬리 윗선에 가늘고 또렷하게)
  //   · 몸의 둥근 결을 따라 넓고 옅게 번지는 윤기 (등·어깨·엉덩이·정수리, 배는 더 어둡게)
  //
  // 테두리 빛은 블러 없이 만든다: 한 무리(겹치는 조각들)를 밝은 빛 색으로 칠하고, 그 위에 «빛 반대쪽으로
  // 조금씩 밀린 같은 실루엣»을 점점 어두운 색으로 source-atop 으로 덮는다. 밀린 거리만큼 빛을 향한
  // 가장자리에만 띠가 남는다 — 실루엣 «안쪽»에 맺히므로 역광 사진처럼 보인다 (v1 은 뒤로 밀린 실루엣을
  // 바깥에 깔아 스티커 테두리 같았다). 무리 안의 조각 경계에는 띠가 안 생긴다 (합친 실루엣이 밀리니까).
  // 덮는 실루엣은 먼저 칠한 무리 위로도 조금 번지는데, 그게 턱 밑·배 밑에 떨어지는 그늘이 된다.
  //
  // 무리는 뒤에서 앞으로: 먼 다리 → 몸통·꼬리·가까운 다리 → 먼 귀 → 목·머리.
  // 가까운 다리를 몸통과 한 무리로 칠하는 까닭: 따로 칠하면 다리 윗끝이나 관절 겹침마다 빛 띠가
  // 옆구리 위 선이나 무릎의 빛 고리로 남는다. 한 무리면 합친 실루엣의 바깥 가장자리에만 빛이 맺힌다.

  // [빛을 받는 윗부분, 가운데, 땅 가까이] — 세로 그라디언트 세 점. 불투명해야 실루엣이 비치지 않는다.
  const PAL_BODY = [
    ['#d6e1f4', '#9aa8c1', '#48505e'],   // 가장 바깥 — 또렷한 빛
    ['#7a879e', '#566075', '#2a2f38'],   // 번짐
    ['#2f3542', '#252a33', '#17191e'],   // 번짐 끝
    ['#181a20', '#14161b', '#0e0f13']    // 살
  ];
  // 앉아서 앞으로 감은 꼬리 — 땅 가까이 있어도 몸 앞에 놓인 줄기로 읽히게, 몸통 팔레트보다 아래쪽이 밝다
  const PAL_LOW = [
    ['#98a4b9', '#6a7588', '#454c59'],
    ['#485163', '#363d4a', '#262a32'],
    ['#2a303a', '#22262e', '#18191e'],
    ['#17191e', '#131519', '#0f1013']
  ];
  // 먼 다리 — 같은 고양이의 한 겹 뒤. 살은 가까운 다리보다 살짝 어둡고, 테두리 빛은 가까운 다리만큼
  // 또렷하게 둔다. 먼 다리는 땅 가까이, 배 그늘 속에 있어 세로 그라디언트의 아래쪽 색만 쓰인다 —
  // 예전 값(#5b6576 → 아래 #333944)은 휴식 화면의 어두운 바탕과 거의 같아서, 실제 밝기에서는 빛 띠가
  // 안 보이고 다리가 «까만 홈»으로 읽혔다 (검토 지적). 그래서 아래쪽 색을 특히 올렸다.
  const PAL_FAR = [
    ['#a9b4c8', '#8792a7', '#6f7a8e'],
    ['#4d5667', '#414959', '#363d4b'],
    ['#252a33', '#20242c', '#1b1e25'],
    ['#131519', '#111317', '#0f1013']
  ];
  const STEP_K = [0, 0.28, 0.6, 1];
  // 빛 반대쪽 밀림 (고양이 단위). 몸통은 위에서, 다리는 뒤에서, 머리는 거의 바로 위에서 받는다 —
  // 머리 무리의 밀림에 옆 성분이 크면 목덜미(몸에 붙은 안쪽 선)에도 띠가 생긴다.
  // 먼 다리는 가늘어서 띠가 얇으면 1080p 에서 한 픽셀도 안 된다 — 가로 밀림을 몸통의 두 배로.
  const D_BODY = [0.2, 0.48], D_HEAD = [0, 0.44], D_FAR = [0.44, 0.3];
  const LIT = '160,178,212';

  function palette(ctx, pal, top) {
    return pal.map((c) => {
      const g = ctx.createLinearGradient(0, top, 0, 0);
      g.addColorStop(0, c[0]); g.addColorStop(0.5, c[1]); g.addColorStop(1, c[2]);
      return g;
    });
  }

  /** 한 무리를 테두리 빛과 함께 칠한다 (위 «빛» 설명). */
  function paintGroup(ctx, paths, styles, d) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = styles[0];
    for (let j = 0; j < paths.length; j++) ctx.fill(paths[j]);
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 1; i < styles.length; i++) {
      const dx = d[0] * STEP_K[i], dy = d[1] * STEP_K[i];
      ctx.translate(dx, dy);
      ctx.fillStyle = styles[i];
      for (let j = 0; j < paths.length; j++) ctx.fill(paths[j]);
      ctx.translate(-dx, -dy);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 타원꼴로 번지는 빛(또는 그늘) 한 점. 부르는 쪽이 합성 방식을 정한다 (보통 source-atop). */
  function sheen(ctx, x, y, rx, ry, ang, rgb, a) {
    if (!(rx > 0.01) || !(ry > 0.01) || !(a > 0.002)) return;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang); ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.55, `rgba(${rgb},${a * 0.4})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  /** 두 점을 잇는 가늘고 긴 윤기 */
  function sheenAlong(ctx, a, b, half, rgb, al) {
    sheen(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, half,
      Math.atan2(b[1] - a[1], b[0] - a[0]), rgb, al);
  }

  /**
   * 먼 다리의 부피 — 먼 다리 무리만 칠한 «바로 뒤»에 부른다. 그때 캔버스에는 먼 다리밖에 없어서
   * source-atop 윤기가 가까운 다리·몸통에 번지지 않는다. 가까운 다리와 같은 자리(넓적다리·정강이·발등)에
   * 조금 더 밝게 — 빛 띠 하나로는 가는 다리가 «윤곽선 두른 홈»으로 남았다. 둥근 살이 보여야 한 겹 뒤의 다리다.
   * k: 앉아서 먼 앞다리가 가슴 뒤 좁은 틈으로만 보일 때도 발등 윤기는 남긴다 (발이 사라지지 않게).
   */
  function shadeFar(ctx, legs, k) {
    ctx.globalCompositeOperation = 'source-atop';
    for (const L of legs) {
      const [a, k1, k2] = L.j;
      sheenAlong(ctx, [lerp(a[0], k1[0], 0.45), lerp(a[1], k1[1], 0.45)], k1, L.hind ? 2.2 : 1.3, LIT, 0.07 * k);
      sheenAlong(ctx, k1, k2, L.hind ? 0.95 : 0.85, LIT, 0.1 * k);
      sheen(ctx, L.top[0], L.top[1], 1.2, 0.4, Math.atan2(L.f[1], L.f[0]), LIT, 0.2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 몸의 부피 — 무리를 다 칠한 뒤 한 번. 등·어깨·엉덩이·정수리의 윤기와 배·턱 밑의 어둠. */
  function shade(ctx, p, B, H, nk, legs) {
    const n = [B.nx, B.ny], u = [B.ux, B.uy];
    const c1 = [p[I.ribX], p[I.ribY]], c2 = [p[I.hipX], p[I.hipY]];
    const r1 = p[I.ribRy], r2 = p[I.hipRy], rm = (r1 + r2) / 2;
    const mx = (c1[0] + c2[0]) / 2, my = (c1[1] + c2[1]) / 2;
    ctx.globalCompositeOperation = 'source-atop';
    // 등 — 몸통 결을 따라 긴 타원. 등뼈 쪽에 치우쳐 둥근 원통으로 읽히게.
    sheen(ctx, mx + n[0] * rm * 0.5, my + n[1] * rm * 0.5, B.d * 0.55 + 6, rm * 0.85, B.ang, LIT, 0.13);
    // 어깨뼈와 엉덩이의 둥근 곳 — 걸을 때 이 두 혹이 번갈아 오르내리는 게 고양이 걸음의 맛이다
    sheen(ctx, c1[0] + n[0] * r1 * 0.42 + u[0] * 1.4, c1[1] + n[1] * r1 * 0.42 + u[1] * 1.4, 4.8, 3.8, B.ang, LIT, 0.1);
    sheen(ctx, c2[0] + n[0] * r2 * 0.3 - u[0] * 1.3, c2[1] + n[1] * r2 * 0.3 - u[1] * 1.3, 5.2, 4.6, B.ang, LIT, 0.11);
    // 배 쪽 어둠 — 배 한가운데 아래에 둔 넓은 타원 그늘. 배 선에서 가장 짙고 다리를 따라 내려가며
    // 옅어진다. 몸통 모양으로 오려 칠했을 땐 몸통과 겹친 넓적다리·위팔이 두 번 어두워져
    // 옆구리에 다리 윤곽선이 떠올랐다 — 오리지 않고 한 번에 번지게 칠해야 이음매가 없다.
    sheen(ctx, mx - n[0] * rm * 0.8, my - n[1] * rm * 0.8, B.d * 0.55 + 4, rm * 1.25, B.ang, '0,0,0', 0.55);
    // 다리의 살 — 넓적다리 바깥 둥근 살, 정강이·앞팔의 긴 근육, 발등. 테두리 빛만으로는 다리가
    // 윤곽선 두른 까만 막대로 읽혔다. 옅은 윤기 몇 점이 «둥근 다리»와 «발가락 달린 발»을 알려 준다.
    for (const L of legs) {
      const [a, k1, k2] = L.j;
      // 옅게 — 진하면 까만 털이 아니라 광택 플라스틱 관처럼 보였다
      sheenAlong(ctx, [lerp(a[0], k1[0], 0.45), lerp(a[1], k1[1], 0.45)], k1, L.hind ? 2.4 : 1.4, LIT, 0.055);
      sheenAlong(ctx, k1, k2, L.hind ? 1.0 : 0.9, LIT, 0.06);
      sheen(ctx, L.top[0], L.top[1], 1.15, 0.36, Math.atan2(L.f[1], L.f[0]), LIT, 0.09);
    }
    const R = HEAD_R;
    // 턱 밑 그늘 — 가슴 위로 떨어진다. 머리와 몸이 같은 까만색이라 이게 없으면 머리가 목에 «붙어» 보인다.
    const jw = H.pt(0.3, 0.98, 0);
    sheen(ctx, jw[0], jw[1], R * 0.95, R * 0.36, H.rot, '0,0,0', 0.5);
    // 가슴털 — 턱 그늘 아래, 앞으로 부푼 자리에 옅게
    sheen(ctx, nk.ruff[0], nk.ruff[1], 2.2, 3.0, B.ang + 1.2, LIT, 0.09);
    // 정수리 — 머리의 둥근 윗면
    const cr = H.pt(-0.12, -0.48, 0);
    sheen(ctx, cr[0], cr[1], R * 0.8, R * 0.42, H.rot, LIT, 0.2);
    // 콧등 — 이마에서 코끝으로 흐르는 가는 빛. 옆얼굴에서도, 돌린 얼굴에서도 코의 방향을 알려 준다.
    sheenAlong(ctx, H.pt(0.5, -0.62, 0), H.pt(1.1, -0.06, 0), R * 0.1, LIT, 0.2);
    // 가까운 뺨 — 광대 아래 둥근 살
    const ck = H.pt(0.32, 0.2, 0.6);
    sheen(ctx, ck[0], ck[1], R * 0.4, R * 0.26, H.rot, LIT, 0.08 * clamp(H.sy * 1.6));
    // 수염 뿌리 볼록살 둘 — 돌린 얼굴에서 주둥이가 평평한 판이 아니라 앞으로 나온 덩어리로 읽힌다
    const fk = clamp(H.sy * 1.2);
    for (const s of [-1, 1]) {
      const wp = H.pt(0.9, 0.3, 0.2 * s);
      sheen(ctx, wp[0], wp[1], R * 0.2, R * 0.14, H.rot, LIT, 0.09 * fk);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── 얼굴 ─────────────────────────────────────────────
  function drawEye(ctx, p, H, near) {
    const s = near ? 1 : -1;
    // 고양이 눈은 앞을 본다 (두 눈 시야가 겹치는 사냥꾼 눈). 눈알 자리는 옆으로 벌어져 있어도
    // 눈이 향하는 쪽은 거의 정면이라, 3/4 로 돌린 얼굴에서 먼 눈도 또렷한 아몬드로 보인다.
    // 예전엔 자리 방향(0.72, 0.69)을 그대로 써서 식빵 자세 내내 먼 눈이 «점 하나»였다.
    const vis = H.facing(0.9, 0.44 * s);
    if (vis < 0.08) return;
    const c = H.pt(0.56, -0.14, 0.42 * s);
    // 줄어드는 폭에도 바닥을 둔다 — 너무 가늘면 눈이 아니라 얼룩으로 읽힌다
    const ex = HEAD_R * 0.24 * (0.3 + 0.7 * Math.max(vis, 0.45)), ey = HEAD_R * 0.19;
    const open = p[I.eye];
    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate(H.rot);
    // 먼 눈이 나타날 때는 짧은 구간에서 또렷해진다 — 반투명한 얼룩으로 오래 머물지 않게
    ctx.globalAlpha = clamp((vis - 0.08) * 8);
    // 눈 둘레 그늘 — 눈두덩에 파묻힌 눈. 이게 없으면 밝은 눈이 까만 털 위에 붙인 스티커처럼 떴다.
    if (open > 0.06) {
      ctx.save();
      ctx.scale(1, 0.62);
      const sk = ctx.createRadialGradient(0, 0, ex * 0.7, 0, 0, ex * 1.6);
      sk.addColorStop(0, `rgba(3,4,6,${0.4 * open})`);
      sk.addColorStop(1, 'rgba(3,4,6,0)');
      ctx.fillStyle = sk;
      ctx.fillRect(-ex * 1.6, -ex * 1.6, ex * 3.2, ex * 3.2);
      ctx.restore();
    }
    const eye = new Path2D();
    // 아몬드 — 위아래를 3차 곡선으로. 2차 곡선 하나는 조절점이 한가운데 한 점이라 두 곧은 빗변이
    // 뾰족하게 만나는 «세모»가 됐다 (검토 지적). 조절점을 좌우로 벌리면 위가 둥근 지붕이 된다.
    // 바깥(뒤) 눈꼬리는 조금 높고 안(코 쪽) 눈꼬리는 조금 낮다 — 고양이 눈의 살짝 치켜 올라간 기울기.
    const oy = -ey * 0.1, iy = ey * 0.12;
    const hO = -ey * 1.66, hB = ey * 1.26;
    const topArc = (pth, dy) => pth.bezierCurveTo(-ex * 0.55, hO + oy * 0.5 + dy, ex * 0.42, hO + iy * 0.5 + dy, ex, iy + dy);
    eye.moveTo(-ex, oy);
    topArc(eye, 0);
    eye.bezierCurveTo(ex * 0.5, hB + iy * 0.5, -ex * 0.45, hB + oy * 0.5, -ex, oy);
    eye.closePath();
    // 윗눈꺼풀: 감을수록 «뜬 눈의 윗선과 같은 둥근 곡선»이 그대로 아래로 내려와 눈을 덮는다.
    // 예전엔 윗선 자체를 납작하게 폈더니, 반쯤 감은 순간(천천히 깜빡·졸음) 윗선이 곧은 빗변이 되어
    // 눈이 세모꼴 스티커로 보였다 (검토 지적). 둥근 눈꺼풀이 내려오면 보이는 눈은 양 끝이 좁아지는
    // 렌즈 꼴 — 졸린 고양이 눈 그대로다.
    const drop = (1 - Math.pow(open, 0.8)) * ey * 2.3;
    const lidY = 0.75 * hO + (oy + iy) * 0.5 + drop;
    if (open > 0.06) {
      // 어두운 화면에서 눈이 «빛을 받는» 느낌 — 아주 옅은 번짐
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, ex * 2.4);
      halo.addColorStop(0, `rgba(255,190,90,${0.1 * open})`);
      halo.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(-ex * 2.4, -ex * 2.4, ex * 4.8, ex * 4.8);
      ctx.save();
      ctx.clip(eye);
      // 눈꺼풀이 내려온 만큼은 아예 오려 낸다 (두 번 오리면 교집합). 눈 전체를 칠한 뒤 털색으로 덮었더니
      // 오린 가장자리로 금빛 실선이 새어 나오고, 덮은 털이 얼굴과 조금 달라 «눈화장»처럼 보였다.
      if (drop > 0.002) {
        const below = new Path2D();
        below.moveTo(-ex * 1.3, ey * 4);
        below.lineTo(-ex * 1.3, oy + drop);
        below.lineTo(-ex, oy + drop);
        topArc(below, drop);
        below.lineTo(ex * 1.3, iy + drop);
        below.lineTo(ex * 1.3, ey * 4);
        below.closePath();
        ctx.clip(below);
      }
      const g = ctx.createRadialGradient(-ex * 0.15, -ey * 0.4, 0, 0, 0, ex * 1.25);
      g.addColorStop(0, '#ffe08a');
      g.addColorStop(0.45, '#f0a834');
      g.addColorStop(1, '#8c4f10');
      ctx.fillStyle = g;
      ctx.fillRect(-ex, -ey * 2, ex * 2, ey * 4);
      // 동공 둘레가 조금 더 짙은 금빛 — 눈이 평평한 원판이 아니라 깊이가 있는 공으로 읽힌다
      const ring = ctx.createRadialGradient(ex * 0.12 * vis, 0, ex * 0.2, ex * 0.12 * vis, 0, ex * 0.8);
      ring.addColorStop(0, 'rgba(120,60,0,0.45)');
      ring.addColorStop(1, 'rgba(120,60,0,0)');
      ctx.fillStyle = ring;
      ctx.fillRect(-ex, -ey * 2, ex * 2, ey * 4);
      // 세로 동공 — 어두운 화면이라 가는 실선보다 조금 부푼 타원이 맞다. 가늘면 뱀 눈처럼 차갑다.
      // 졸릴수록 조금 더 넓어진다.
      const pw = ex * lerp(0.46, 0.28, open);
      ctx.fillStyle = '#060607';
      ctx.beginPath();
      ctx.ellipse(ex * 0.12 * vis, ey * 0.05, pw, ey * 1.6, 0, 0, TAU);
      ctx.fill();
      // 빛 맺힘 — 뒤쪽 위(테두리 빛이 오는 쪽)에 하나, 아래에 작게 하나. 눈꺼풀이 내려오면 같이 가려진다.
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(-ex * 0.38, -ey * 0.42, ey * 0.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(210,230,255,0.35)';
      ctx.beginPath();
      ctx.arc(ex * 0.35, ey * 0.45, ey * 0.11, 0, TAU);
      ctx.fill();
      // 윗눈꺼풀 그늘 — 눈꺼풀 선 바로 아래가 살짝 어두워야 눈두덩 아래 박힌 공으로 읽힌다
      const lid = ctx.createLinearGradient(0, lidY - ey * 0.4, 0, lidY + ey * 1.5);
      lid.addColorStop(0, 'rgba(12,6,0,0.62)');
      lid.addColorStop(1, 'rgba(12,6,0,0)');
      ctx.fillStyle = lid;
      ctx.fillRect(-ex, lidY - ey * 2, ex * 2, ey * 3.6);
      const lidLine = new Path2D();
      lidLine.moveTo(-ex, oy + drop);
      topArc(lidLine, drop);
      // 눈꺼풀 선 — 위·아래 모두 «보이는 눈» 안쪽으로만 긋는다 (오린 채로 두 배 굵기 → 안쪽 절반).
      // 아랫선을 오리지 않고 그었더니 반쯤 감은 눈에서 렌즈 밖으로 아랫선이 U 자로 남아 눈 밑 주름처럼 보였다.
      // 굵기도 예전(0.16 전체)보다 가늘다 — 굵은 새까만 테는 만화 스티커의 외곽선처럼 보였다.
      const low = new Path2D();
      low.moveTo(ex, iy);
      low.bezierCurveTo(ex * 0.5, hB + iy * 0.5, -ex * 0.45, hB + oy * 0.5, -ex, oy);
      ctx.lineWidth = 0.24;
      ctx.strokeStyle = 'rgba(4,5,7,0.82)';
      ctx.stroke(lidLine);
      ctx.stroke(low);
      ctx.restore();
    } else {
      // 감은 눈 — 까만 얼굴에선 안 보이니 테두리 빛만 가늘게
      ctx.beginPath();
      ctx.moveTo(-ex, 0.1 * ey);
      ctx.quadraticCurveTo(0, ey * 1.1, ex, -0.15 * ey);
      ctx.lineWidth = 0.13;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(175,195,225,0.34)';
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 수염 한 올 — 선 대신 뿌리가 굵고 끝이 0 인 가는 초승달을 채운다. 굵기가 같은 선은
   * 끝이 뭉툭해 철사처럼 보인다. b 뿌리, m 휨 조절점, e 끝, wd 뿌리 굵기.
   */
  function whisker(path, b, m, e, wd) {
    const dx = e[0] - b[0], dy = e[1] - b[1], l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * wd * 0.5, ny = (dx / l) * wd * 0.5;
    path.moveTo(b[0] + nx, b[1] + ny);
    path.quadraticCurveTo(m[0] + nx * 0.5, m[1] + ny * 0.5, e[0], e[1]);
    path.quadraticCurveTo(m[0] - nx * 0.5, m[1] - ny * 0.5, b[0] - nx, b[1] - ny);
    path.closePath();
  }

  function drawFace(ctx, p, H, G) {
    // 하품 — 입 안은 짙은 분홍, 혀, 송곳니 두 개
    if (p[I.mouth] > 0.03) {
      const [mc, li, ll] = G.mouth;
      ctx.fillStyle = '#3d151b';
      ctx.beginPath();
      ctx.moveTo(mc[0], mc[1]); ctx.lineTo(li[0], li[1]); ctx.lineTo(ll[0], ll[1]); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(196,104,118,0.9)';
      ctx.beginPath();
      ctx.moveTo(lerp(mc[0], ll[0], 0.25), lerp(mc[1], ll[1], 0.25));
      ctx.quadraticCurveTo(lerp(mc[0], li[0], 0.7), lerp(mc[1], li[1], 0.7) + 0.5, lerp(mc[0], ll[0], 0.95), lerp(mc[1], ll[1], 0.95));
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(240,238,232,0.92)';
      const tooth = (a, b, dir) => {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]); ctx.lineTo(lerp(a[0], b[0], 0.18), lerp(a[1], b[1], 0.18));
        ctx.lineTo(lerp(a[0], b[0], 0.08), lerp(a[1], b[1], 0.08) + dir * 0.55);
        ctx.closePath(); ctx.fill();
      };
      tooth(li, mc, 1);
      tooth(ll, mc, -1);
    }
    // 코 — 둥근 역삼각형. 옆에서는 콧등 끝의 작은 혹이고, 우리 쪽으로 돌수록 넓어지고 조금 내려앉는다.
    // 옆얼굴 윤곽의 코끝 자리(1.14, 0.06)를 돌린 얼굴에 그대로 쓰면 코가 먼 눈 바로 옆에 붙어
    // 눈가의 얼룩처럼 보였다 — 정면에 가까울수록 코는 두 눈 아래 가운데로 내려와야 얼굴이 된다.
    const nk = clamp(H.sy * 1.2);
    const nx0 = lerp(1.13, 1.0, nk), ny0 = lerp(0.02, 0.2, nk);
    const nw = 0.13 + 0.07 * H.sy;
    const nL = H.pt(nx0 - 0.05, ny0 - 0.04, nw), nR = H.pt(nx0 - 0.05, ny0 - 0.04, -nw);
    const nB = H.pt(nx0, ny0 + 0.08, 0), nT = H.pt(nx0, ny0 - 0.09, 0);
    const nose = new Path2D();
    nose.moveTo(nL[0], nL[1]);
    nose.quadraticCurveTo(nT[0], nT[1], nR[0], nR[1]);
    nose.quadraticCurveTo(lerp(nR[0], nB[0], 0.6), lerp(nR[1], nB[1], 0.6) - 0.05, nB[0], nB[1]);
    nose.quadraticCurveTo(lerp(nL[0], nB[0], 0.6), lerp(nL[1], nB[1], 0.6) - 0.05, nL[0], nL[1]);
    nose.closePath();
    ctx.fillStyle = '#231d21';
    ctx.fill(nose);
    // 코 위 작은 빛 — 촉촉한 코
    const nh = H.pt(nx0 - 0.02, ny0 - 0.05, nw * 0.2);
    ctx.fillStyle = 'rgba(205,215,235,0.4)';
    ctx.beginPath();
    ctx.ellipse(nh[0], nh[1], 0.16, 0.07, H.rot, 0, TAU);
    ctx.fill();
    // 입 — 코 밑에서 짧게 내려와 양쪽으로 갈라지는 선. 까만 털 위라 어두운 선은 안 보이니
    // 입술 가장자리에 맺힌 옅은 빛으로 긋는다. 하품 중에는 벌어진 입이 대신한다.
    if (p[I.mouth] < 0.05 && nk > 0.2) {
      const m0 = H.pt(nx0 - 0.01, ny0 + 0.1, 0), m1 = H.pt(nx0 - 0.04, ny0 + 0.2, 0);
      ctx.beginPath();
      ctx.moveTo(m0[0], m0[1]); ctx.lineTo(m1[0], m1[1]);
      for (const s of [-1, 1]) {
        const c1 = H.pt(nx0 - 0.06, ny0 + 0.28, 0.1 * s), e1 = H.pt(nx0 - 0.16, ny0 + 0.26, 0.24 * s);
        ctx.moveTo(m1[0], m1[1]); ctx.quadraticCurveTo(c1[0], c1[1], e1[0], e1[1]);
      }
      ctx.lineWidth = 0.07;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(150,166,194,${0.21 * nk})`;
      ctx.stroke();
    }

    // 수염 — 수염 뿌리 볼록살에서 옆·앞으로 뻗어 끝이 살짝 처진다.
    for (const s of [-1, 1]) {
      const base = H.pt(0.92, 0.3, 0.26 * s);
      // 가까운 쪽 수염은 얼굴을 돌릴수록 우리 쪽으로 뻗어 짧아진다. 짧아진 채로 진하게 그리면
      // 볼 위에 흉터 같은 갈고리 선이 생긴다 — 화면에 보이는 길이만큼 옅게.
      const tipN = H.pt(2.4, 0.42, 0.26 * s + 1.45 * s);
      const seen = clamp((Math.hypot(tipN[0] - base[0], tipN[1] - base[1]) / HEAD_R - 0.8) / 0.6);
      const alpha = s > 0 ? 0.55 * seen : (0.26 + 0.24 * H.sy) * (0.4 + 0.6 * seen);
      if (alpha < 0.02) continue;
      const wp = new Path2D();
      const cnt = s > 0 ? 4 : 3;
      for (let j = 0; j < cnt; j++) {
        const dy = -0.14 + (0.34 / (cnt - 1)) * j;
        const ln = 1.0 - 0.12 * Math.abs(j - 1);
        const b = H.pt(0.9, 0.28 + dy * 0.35, 0.26 * s);
        const e = H.pt(0.9 + 1.5 * ln, 0.3 + dy * 2.4 + 0.2, 0.26 * s + 1.45 * s * ln);
        const m = H.pt(0.9 + 0.85 * ln, 0.3 + dy * 1.2 - 0.1, 0.26 * s + 0.8 * s * ln);
        whisker(wp, b, m, e, 0.1);
      }
      ctx.fillStyle = `rgba(222,230,244,${alpha})`;
      ctx.fill(wp);
    }
    // (눈썹 수염은 뺐다 — 이 크기에선 머리 위 긁힌 자국이나 더듬이로 읽혔다)
    drawEye(ctx, p, H, false);
    drawEye(ctx, p, H, true);
  }

  // ── 장면 ─────────────────────────────────────────────
  function setup({ w, h }) {
    const portrait = h > w * 1.25;
    // 세로 모니터: 아래 구석은 단추와 겹친다. 글과 단추 사이 빈 띠(64~84%)에 세운다.
    // 그 띠는 꼬리를 세운 고양이 키와 거의 같아서, 조금 작게·조금 낮게·조금 왼쪽에 둔다.
    // 발은 단추 줄(가로 33% 부터)보다 왼쪽이라 땅선이 단추 윗선보다 살짝 낮아도 겹치지 않는다.
    const U = (Math.min(w, h) / 100) * CAT_SCALE * (portrait ? 0.94 : 1);
    // 가로 화면: 땅을 바닥에서 5.5% 위에. 선 채로 우리를 볼 때 귀·꼬리 끝이 글 구역 아랫선에서
    // 넉넉히 떨어지게 (7% 였을 땐 7px 차이로 스쳤다).
    const groundY = portrait ? h * 0.836 : h - Math.max(h * 0.055, 4 * U);
    const x0 = portrait ? -2.5 * U : 0;
    return Object.freeze({
      U, groundY, x0, dir: 1,
      tracks: buildTracks(),
      tailTrack: buildTracks().find((tr) => tr.name === 'tail'),
      gait: buildGait()
    });
  }

  function draw(ctx, t, w, h, S) {
    if (!S || !S.gait) return;
    const p = poseAt(S, t);
    const X = walkX(t);
    const U = S.U;
    ctx.save();
    ctx.translate(X * U + S.x0, S.groundY);
    ctx.scale(S.dir * U, U);

    const B = torsoPath(p);
    const H = headFrame(p);
    const fN = frontLeg(p, B, true), fF = frontLeg(p, B, false);
    const hN = hindLeg(p, B, true), hF = hindLeg(p, B, false);
    const E = earGeo(p, H, true), Ef = earGeo(p, H, false);
    const Hd = headGeo(p, H);
    const nk = neckPath(p, H, B);
    const tail = tailPath(S, p, t, B);

    const top = Math.min(p[I.headY] - 9, p[I.hipY] - 8);
    const body = palette(ctx, PAL_BODY, top);

    // 뒤에서 앞으로 (위 «빛» 설명)
    // 앉고 나면 먼 앞다리는 가슴과 가까운 앞다리 사이 좁은 틈으로만 보인다. 예전엔 여기서 빛 띠를
    // 30% 로 얇게 줄였는데, 그러면 띠가 머리카락 한 올 굵기의 선이 되어 다리가 아니라 «철사»나 그림자
    // 가장자리로 읽혔다 (검토 지적). 띠 굵기는 그대로 두어 둥근 다리의 가장자리로 보이게 하고,
    // 틈 속 정강이 윤기만 줄인다 (발등 윤기는 남는다).
    const farK = 1 - 0.5 * span(t, 6.3, 7.3);
    paintGroup(ctx, [fF.upper, hF.upper].concat(fF.lower, hF.lower), palette(ctx, PAL_FAR, top), D_FAR);
    shadeFar(ctx, [hF, fF], farK);
    // 가까운 다리는 몸통과 한 무리 — 넓적다리에서 발끝까지 윤곽이 끊기지 않고, 조각이 겹친 자리
    // (무릎·팔꿈치·발목)에 빛 띠나 이음매가 생기지 않는다. 마디별로 따로 칠했을 땐 관절마다 둥근 빛 고리가
    // 생겨 의족처럼 보였다.
    // 목도 몸통 무리에 넣는다. 머리 무리에 두면 (1) 등선과 목덜미 선의 빛 띠 굵기가 달라 어깨에서
    // 띠가 턱지고, (2) 아래로 밀린 목 실루엣이 바로 뒤 등의 빛 띠를 한 입 베어 물었다 — 그게 검토에서
    // 지적된 «어깨의 작은 턱»이었다. 한 무리면 등~목덜미가 한 윤곽이라 띠가 끊기지 않는다.
    paintGroup(ctx, [tail, B.path, nk.path, hN.upper, fN.upper].concat(hN.lower, fN.lower), body, D_BODY);
    paintGroup(ctx, [Ef.path], palette(ctx, PAL_FAR, top), D_HEAD);
    paintGroup(ctx, [E.path, Hd.skull, Hd.cheeks, Hd.muzzle, Hd.chin], body, D_HEAD);
    shade(ctx, p, B, H, nk, [hN, fN]);

    // 앉아 발을 감은 꼬리는 몸 «앞»에 있다. 같은 색이라 그대로는 몸에 묻히므로
    // 꼬리만 한 번 더 얹는다. 먼저 꼬리 아래로 옅은 그늘을 깔아 «몸 위에 놓인 둥근 줄기»로
    // 떨어뜨리고, 그 위에 테두리 빛과 살을 올린다 — 꼬리 모양으로 오린 채로(clip) 칠해 몸에 번지지 않게.
    const tailFront = span(t, 7.15, 7.5);
    if (tailFront > 0) {
      ctx.globalAlpha = tailFront;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.translate(0.12, 0.42); ctx.fill(tail); ctx.translate(-0.12, -0.42);
      ctx.save();
      ctx.clip(tail);
      const low = palette(ctx, PAL_LOW, top);
      for (let i = 0; i < low.length; i++) {
        const dx = D_BODY[0] * STEP_K[i], dy = D_BODY[1] * STEP_K[i];
        ctx.translate(dx, dy); ctx.fillStyle = low[i]; ctx.fill(tail); ctx.translate(-dx, -dy);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // 귀 안쪽 — 우리 쪽을 볼 때만. 옅은 살빛 컵 + 안쪽 가장자리에서 뻗는 흰 털 몇 올
    for (const e of [Ef, E]) {
      if (e.vis <= 0.02) continue;
      const g = ctx.createLinearGradient(e.base[0], e.base[1], e.tip[0], e.tip[1]);
      g.addColorStop(0, `rgba(40,30,36,${0.7 * e.vis})`);
      g.addColorStop(0.55, `rgba(128,90,102,${0.55 * e.vis})`);
      g.addColorStop(1, `rgba(150,110,120,${0.2 * e.vis})`);
      ctx.fillStyle = g;
      ctx.fill(e.inner);
      ctx.lineWidth = 0.055;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(206,214,230,${0.3 * e.vis})`;
      ctx.stroke(e.fur);
    }
    drawFace(ctx, p, H, Hd);

    // 바닥 그림자 — 다 그린 «뒤»에 깐다 (destination-over). 살을 칠할 때 쓴 source-atop 이
    // 그림자 위에도 얹히면 안 되기 때문이다. 넓게 옅은 것 하나 + 발마다 짙은 접지 점.
    ctx.globalCompositeOperation = 'destination-over';
    for (const L of [fN, fF, hN, hF]) {
      const a = 0.4 * clamp(1 - L.lift / 1.6);
      if (a <= 0.01) continue;
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.beginPath(); ctx.ellipse(L.paw[0] + 0.2, 0.1, 1.7, 0.42, 0, 0, TAU); ctx.fill();
    }
    const xs = [fN.paw[0], fF.paw[0], hN.paw[0], hF.paw[0], p[I.hipX] - p[I.hipRx], p[I.ribX] + p[I.ribRx]];
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const low = span(-p[I.hipY], 12, 5.5);
    ctx.save();
    ctx.translate((minX + maxX) / 2, 0.15);
    ctx.scale((maxX - minX) / 2 + 3.5, 1.7 + low * 0.5);
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    sg.addColorStop(0, `rgba(0,0,0,${0.42 + 0.18 * low})`);
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  NA.scenes.cat = { arrival: ARRIVAL, setup, draw };
})();

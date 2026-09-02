'use strict';
/**
 * 휴식 화면 등장 연출.
 *
 * 휴식은 «갑자기 화면을 뺏는» 일이다. 그냥 나타나면 놀라고, 너무 느리면 방해가 된다.
 * 그래서 무언가가 화면을 «덮었다가 걷히는» 짧은 연출을 둔다 — 덮이는 동안 눈이 옮겨오고,
 * 걷히면 이미 휴식 화면이 준비돼 있다.
 *
 * 그림 파일을 쓰지 않는다. 전부 SVG·CSS로 그린다 — 배포 크기도 안 늘고,
 * 화면 크기·비율(세로 모니터 포함)에 맞춰 그때그때 그릴 수 있다.
 *
 * 연출은 짧아야 한다. 20초 휴식에서 1초를 쓰면 5%다. 덮기 380 + 멈춤 60 + 걷기 300 ≈ 0.74초.
 * 덮기 안에서 그림이 «다 그려져야» 한다 — 안 그러면 그리다 만 채로 걷힌다 (실제로 그랬다).
 */

const MS = { cover: 380, hold: 60, lift: 300 };
const TOTAL = MS.cover + MS.hold + MS.lift;

/** 직접 넣은 연출인가 — 'my:<id>' 꼴 */
function isMine(id) { return typeof id === 'string' && id.startsWith('my:'); }

/** 고를 수 있는 것들 — 설정 화면이 이 목록을 그대로 쓴다.
 *  직접 넣은 파일은 여기 없다. 설정 화면이 store 의 enterCustom 을 뒤에 붙여 그린다. */
const LIST = [
  { id: 'fade', name: '기본', hint: '조용히 밝아집니다' },
  { id: 'web', name: '거미줄', hint: '모서리에서 거미줄이 날아와 화면을 덮습니다' },
  { id: 'cat', name: '고양이', hint: '고양이가 올라와 화면을 가립니다' },
  { id: 'blinds', name: '블라인드', hint: '가로 띠가 차례로 닫혔다 열립니다' },
  { id: 'random', name: '그때그때', hint: '올 때마다 다른 연출' }
];

const NS = 'http://www.w3.org/2000/svg';
const el = (n, at) => {
  const e = document.createElementNS(NS, n);
  for (const k in at) e.setAttribute(k, at[k]);
  return e;
};

/**
 * 이 연출이 «화면을 다 덮는 데» 걸리는 시간 — 휴식 내용은 그 뒤에 나타난다.
 * 직접 넣은 파일은 제 길이만큼 보여준다. 0.38초짜리 손그림 기준으로 잘라 버리면
 * 2초짜리 고양이가 시작하자마자 걷힌다.
 */
function coverMs(id, asset) {
  if (id === 'none' || id === 'fade') return 0;
  if (isMine(id)) return (asset && asset.ms ? asset.ms : 900) + MS.hold;
  return MS.cover + MS.hold;
}

// ── 거미줄 ──────────────────────────────────────────────
// 모서리 밖에서 줄이 날아와 한 점에 붙고, 거기서 거미줄이 화면 끝까지 퍼진다.
// 살이 먼저 뻗고 그 위를 실이 감는 순서라야 «쳐지는» 느낌이 난다.
function web(host, w, h) {
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'ent-svg' });
  // 붙는 자리는 오른쪽 위 — 웹슈터가 바깥에서 날아온 것처럼 보이게
  const ax = w * 0.82;
  const ay = h * 0.16;
  // 화면 어느 구석까지도 닿아야 한다 — 가장 먼 꼭짓점까지의 거리
  const far = Math.max(
    Math.hypot(ax, ay), Math.hypot(w - ax, ay),
    Math.hypot(ax, h - ay), Math.hypot(w - ax, h - ay)
  );

  const shot = el('line', { x1: w + 40, y1: -40, x2: ax, y2: ay, class: 'ent-shot' });
  const g = el('g', { class: 'ent-web' });
  const SPOKES = 14;
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * Math.PI * 2;
    g.append(el('line', {
      x1: ax, y1: ay,
      x2: ax + Math.cos(a) * far, y2: ay + Math.sin(a) * far,
      class: 'ent-spoke', style: `--d:${(i % 3) * 12}ms`
    }));
  }
  // 실 — 살 사이를 잇는 다각형. 원보다 다각형이 «손으로 친» 느낌이 난다.
  for (let r = 1; r <= 7; r++) {
    const rad = (far * r) / 7;
    const pts = [];
    for (let i = 0; i <= SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
      // 살짝 안쪽으로 처지게 — 팽팽한 다각형은 기계처럼 보인다
      const sag = rad * (i % 2 ? 0.965 : 1);
      pts.push(`${(ax + Math.cos(a) * sag).toFixed(1)},${(ay + Math.sin(a) * sag).toFixed(1)}`);
    }
    g.append(el('polyline', {
      points: pts.join(' '), class: 'ent-ring', style: `--d:${40 + r * 14}ms`
    }));
  }
  svg.append(shot, g);
  host.append(svg);
}

// ── 고양이 ──────────────────────────────────────────────
// 아래에서 실루엣이 올라와 화면을 가린다. 귀가 먼저 보이고 몸이 따라 올라오는 순서.
function cat(host, w, h) {
  const svg = el('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', class: 'ent-svg ent-cat' });
  // 몸통은 화면을 다 덮어야 하므로 아래로 길게 뺀다 (비율은 preserveAspectRatio로 늘린다)
  const body = 'M 50 6'
    + ' C 66 6 74 16 74 28'
    + ' C 74 38 68 44 68 52'
    + ' L 84 130 L 16 130 L 32 52'
    + ' C 32 44 26 38 26 28'
    + ' C 26 16 34 6 50 6 Z';
  const g = el('g', { class: 'ent-catg' });
  g.append(el('path', { d: body, class: 'ent-fill' }));
  // 귀 — 실루엣이라도 이것만 있으면 고양이로 읽힌다
  g.append(el('path', { d: 'M 30 14 L 26 0 L 42 8 Z', class: 'ent-fill' }));
  g.append(el('path', { d: 'M 70 14 L 74 0 L 58 8 Z', class: 'ent-fill' }));
  // 눈 — 덮이기 직전에 깜빡 뜬다. 이것 하나로 «키치»가 산다.
  // 반드시 몸통과 같은 <g> 안에 있어야 한다. 밖에 두면 머리는 올라오는데 눈만
  // 제자리에 떠 있다 (실제로 그랬다).
  g.append(el('ellipse', { cx: 41, cy: 24, rx: 3.4, ry: 4.6, class: 'ent-eye' }));
  g.append(el('ellipse', { cx: 59, cy: 24, rx: 3.4, ry: 4.6, class: 'ent-eye' }));
  svg.append(g);
  host.append(svg);
  void w; void h;
}

// ── 블라인드 ────────────────────────────────────────────
// 가로 띠가 차례로 닫혔다가 열린다. 가장 얌전한 «가리기».
function blinds(host) {
  const n = 9;
  for (let i = 0; i < n; i++) {
    const b = document.createElement('div');
    b.className = 'ent-blind';
    b.style.top = `${(i * 100) / n}%`;
    b.style.height = `${100 / n + 0.2}%`;
    b.style.setProperty('--d', `${i * 26}ms`);
    host.append(b);
  }
}

// ── 내 파일 ────────────────────────────────────────────
// 직접 넣은 그림·영상을 띄운다. 배경이 투명한 파일이면 그대로 비친다.
//
// 파일 하나만으로는 화면이 안 덮인다 — 누끼 딴 고양이는 가운데만 가린다.
// 그래서 뒤에 얇은 막을 같이 깔고, 그림은 잘리지 않게(contain) 얹는다.
function media(host, asset) {
  const veil = document.createElement('div');
  veil.className = 'ent-veil';
  host.append(veil);
  const isVid = asset.kind === 'video';
  const m = document.createElement(isVid ? 'video' : 'img');
  m.className = 'ent-media';
  if (isVid) {
    m.muted = true;               // 소리는 알림음이 따로 낸다
    m.playsInline = true;
    m.autoplay = true;
  }
  m.src = asset.url;
  host.append(m);
  // autoplay 가 막히는 경우가 있어 직접도 한 번 시킨다
  if (isVid) m.play().catch(() => { /* 못 틀면 첫 프레임이라도 남는다 */ });
}

const MAKERS = { web, cat, blinds };

/**
 * 연출을 재생한다. 다 걷히면 resolve.
 * 움직임을 줄여 달라는 설정이면 아무것도 안 하고 바로 끝낸다 — 그 설정을 켠 사람에게
 * 화면을 뒤덮는 애니메이션은 정확히 원치 않는 것이다.
 */
function play(id, host, asset) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pick = id;
  // 'random' 은 보통 main 이 미리 정해서 넘긴다 — 모니터마다 다른 게 나오면 안 되니까.
  // 그래도 못 정해서 오면 여기서 고른다.
  if (pick === 'random') {
    const opts = Object.keys(MAKERS);
    pick = opts[Math.floor(Math.random() * opts.length)];
  }
  const mine = isMine(pick) && asset && asset.url;
  if (reduce || (!mine && !MAKERS[pick])) return Promise.resolve(0);

  const cover = mine ? coverMs(pick, asset) - MS.hold : MS.cover;
  host.textContent = '';
  host.className = `curtain on ent-${mine ? 'media' : pick}`;
  host.style.setProperty('--cover', `${cover}ms`);
  host.style.setProperty('--lift', `${MS.lift}ms`);
  // 연출을 그리다 실패해도 휴식 화면은 떠야 한다. 여기서 새어 나가면 부르는 쪽의
  // 다음 줄(휴식 내용 그리기)이 통째로 건너뛰어져 빈 화면만 남는다 — 실제로 그랬다.
  try {
    if (mine) media(host, asset);
    else MAKERS[pick](host, window.innerWidth, window.innerHeight);
  } catch {
    host.className = 'curtain';
    host.textContent = '';
    return Promise.resolve(0);
  }

  const total = cover + MS.hold + MS.lift;
  return new Promise((done) => {
    setTimeout(() => host.classList.add('lift'), cover + MS.hold);
    setTimeout(() => {
      host.className = 'curtain';
      host.textContent = '';
      done(total);
    }, total);
  });
}

window.nunsEnter = { LIST, play, coverMs, isMine, TOTAL, MS };

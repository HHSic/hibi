'use strict';
/**
 * 휴식 화면 등장 연출.
 *
 * 휴식은 «갑자기 화면을 뺏는» 일이다. 그냥 나타나면 놀라고, 너무 느리면 방해가 된다.
 * 그래서 무언가가 화면에 «도착»하고, 그 위에 휴식 내용이 얹힌다.
 *
 * 그림 파일을 쓰지 않는다 — 배포 크기도 안 늘고, 화면 크기·비율(세로 모니터 포함)에
 * 맞춰 그때그때 그릴 수 있다.
 *
 * 고양이·웹스윙은 캔버스 장면(renderer/anim/)으로 그린다. 예전엔 SVG·CSS 키프레임이었는데
 * «조잡하다»는 말을 들었다 — 꼬리가 몸을 늦게 따라 휘거나 줄에 매달린 몸이 진자처럼
 * 흔들리는 것은 키프레임 몇 개로 안 나온다. 장면 파일이 없거나 깨지면 옛 SVG 로 물러난다.
 */

// 연출은 휴식 화면의 «배경»이다 — 도착해 화면을 채우고, 휴식 내내 그 자리에서 논다.
// 창이 닫힐 때 같이 사라진다. 휴식 내용(안내)은 그 «위에» 얹혀, 도착 직후 뜬다.
const MS = { cover: 900, hold: 260 };
const TOTAL = MS.cover + MS.hold;   // 휴식 길이를 모를 때의 기본

/** 설정 id → 캔버스 장면 이름. 설정에 저장된 id 는 그대로 두고 그리는 것만 바꾼다. */
const SCENE_OF = { cat: 'cat', web: 'swing' };

/** 이 id 를 그릴 캔버스 장면 — 없으면 null (엔진·장면 파일이 안 실렸다) */
function sceneFor(id) {
  const name = SCENE_OF[id];
  const a = window.nunsAnim;
  return name && a && a.scenes && a.scenes[name] && typeof a.scenes[name].draw === 'function'
    ? a.scenes[name] : null;
}

/** 이 연출이 화면을 채우는 데 걸리는 «도착» 시간 */
function arrivalMs(id, asset) {
  if (isMine(id)) return (asset && asset.ms) ? asset.ms : MS.cover;
  const scene = sceneFor(id);
  if (scene && scene.arrival > 0) return Math.round(scene.arrival * 1000);
  return MS.cover;
}

/** 직접 넣은 연출인가 — 'my:<id>' 꼴 */
function isMine(id) { return typeof id === 'string' && id.startsWith('my:'); }

/** 고를 수 있는 것들 — 설정 화면이 이 목록을 그대로 쓴다.
 *  직접 넣은 파일은 여기 없다. 설정 화면이 store 의 enterCustom 을 뒤에 붙여 그린다. */
const LIST = [
  { id: 'fade', name: '기본', hint: '조용히 밝아집니다' },
  { id: 'web', name: '웹스윙', hint: '가면 곡예사가 줄을 타고 날아와 거미줄을 치고 매달려 쉽니다' },
  { id: 'cat', name: '고양이', hint: '고양이가 걸어 들어와 곁에 앉아 함께 쉽니다' },
  { id: 'blinds', name: '블라인드', hint: '가로 띠가 내려와 배경이 됩니다' },
  { id: 'breathe', name: '호흡', hint: '숨 고르는 원이 계속 커졌다 작아집니다' },
  { id: 'tv', name: '브라운관', hint: '옛 TV처럼 켜져 배경이 됩니다' },
  { id: 'random', name: '그때그때', hint: '올 때마다 다른 연출' }
];

const NS = 'http://www.w3.org/2000/svg';
const el = (n, at) => {
  const e = document.createElementNS(NS, n);
  for (const k in at) e.setAttribute(k, at[k]);
  return e;
};

/**
 * 휴식 내용이 뜨기까지 기다리는 시간 — «도착 + 잠깐»뿐이다(짧다).
 * 연출은 배경이라 내용을 가리지 않으니, 내용은 도착 직후 뜨면 된다.
 * fade·none 은 채우지 않으므로 0.
 */
function coverMs(id, asset) {
  if (id === 'none' || id === 'fade') return 0;
  return arrivalMs(id, asset) + MS.hold;
}

// ── 옛 SVG 연출 (장면 파일이 없을 때 물러날 자리) ─────────────────

// 거미줄 — 모서리 밖에서 줄이 날아와 한 점에 붙고, 거기서 거미줄이 화면 끝까지 퍼진다.
function web(host, w, h) {
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'ent-svg' });
  const ax = w * 0.82;
  const ay = h * 0.16;
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
  for (let r = 1; r <= 7; r++) {
    const rad = (far * r) / 7;
    const pts = [];
    for (let i = 0; i <= SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
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

// 고양이 — 아래에서 실루엣이 올라와 화면을 가린다.
function cat(host, w, h) {
  const svg = el('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', class: 'ent-svg ent-cat' });
  const body = 'M 50 6'
    + ' C 66 6 74 16 74 28'
    + ' C 74 38 68 44 68 52'
    + ' L 84 130 L 16 130 L 32 52'
    + ' C 32 44 26 38 26 28'
    + ' C 26 16 34 6 50 6 Z';
  const g = el('g', { class: 'ent-catg' });
  g.append(el('path', { d: body, class: 'ent-fill' }));
  g.append(el('path', { d: 'M 30 14 L 26 0 L 42 8 Z', class: 'ent-fill' }));
  g.append(el('path', { d: 'M 70 14 L 74 0 L 58 8 Z', class: 'ent-fill' }));
  // 눈은 몸통과 같은 <g> 안에 — 밖에 두면 머리는 올라오는데 눈만 제자리에 떠 있다 (실제로 그랬다)
  g.append(el('ellipse', { cx: 41, cy: 24, rx: 3.4, ry: 4.6, class: 'ent-eye' }));
  g.append(el('ellipse', { cx: 59, cy: 24, rx: 3.4, ry: 4.6, class: 'ent-eye' }));
  svg.append(g);
  host.append(svg);
  void w; void h;
}

// ── 블라인드 ────────────────────────────────────────────
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
// 파일 하나만으로는 화면이 안 덮인다 — 뒤에 얇은 막을 같이 깔고, 그림은 잘리지 않게(contain) 얹는다.
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
    m.loop = true;                // 머무는 동안 멈춰 있지 않게 되풀이한다
  }
  m.src = asset.url;
  host.append(m);
  if (isVid) m.play().catch(() => { /* 못 틀면 첫 프레임이라도 남는다 */ });
}

// ── 호흡 ────────────────────────────────────────────────
function breathe(host) {
  const veil = document.createElement('div');
  veil.className = 'ent-veil';
  host.append(veil);
  const svg = el('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'xMidYMid meet', class: 'ent-svg ent-breathe' });
  svg.append(el('circle', { cx: 50, cy: 50, r: 15, class: 'ent-ring2' }));
  svg.append(el('circle', { cx: 50, cy: 50, r: 15, class: 'ent-ring2 rb' }));
  host.append(svg);
  const label = document.createElement('div');
  label.className = 'ent-breathe-label';
  label.textContent = '천천히 숨을 고르세요';
  host.append(label);
}

// ── 브라운관 ────────────────────────────────────────────
function tv(host) {
  const scr = document.createElement('div');
  scr.className = 'ent-tv-screen';
  const scan = document.createElement('div');
  scan.className = 'ent-tv-scan';
  host.append(scr, scan);
}

const MAKERS = { web, cat, blinds, breathe, tv };

/**
 * 연출을 재생한다. 내용이 뜰 시점(ms)으로 resolve.
 * 움직임을 줄여 달라는 설정이면 아무것도 안 하고 바로 끝낸다 — 그 설정을 켠 사람에게
 * 화면을 뒤덮는 애니메이션은 정확히 원치 않는 것이다.
 */
function play(id, host, asset, breakSec) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pick = id;
  // 'random' 은 보통 main 이 미리 정해서 넘긴다 — 모니터마다 다른 게 나오면 안 되니까.
  if (pick === 'random') {
    const opts = Object.keys(MAKERS);
    pick = opts[Math.floor(Math.random() * opts.length)];
  }
  const mine = isMine(pick) && asset && asset.url;
  if (reduce || (!mine && !MAKERS[pick])) return Promise.resolve(0);

  const scene = mine ? null : sceneFor(pick);
  const arrival = arrivalMs(pick, asset);
  host.textContent = '';
  host.className = `curtain on ent-${mine ? 'media' : pick}${scene ? ' ent-canvas-on' : ''}`;
  host.style.setProperty('--cover', `${arrival}ms`);
  // 연출을 그리다 실패해도 휴식 화면은 떠야 한다. 여기서 새어 나가면 부르는 쪽의
  // 다음 줄(휴식 내용 그리기)이 통째로 건너뛰어져 빈 화면만 남는다 — 실제로 그랬다.
  try {
    if (mine) {
      media(host, asset);
    } else if (scene) {
      // 휴식마다 조금씩 다르게 — 시드는 여기서 한 번 정한다 (draw 안에서는 무작위를 안 쓴다)
      window.nunsAnim.mount(host, scene, { seed: (Date.now() % 100000) + 1 });
    } else {
      MAKERS[pick](host, window.innerWidth, window.innerHeight);
    }
  } catch {
    // 캔버스 장면이 준비 중에 터지면 옛 SVG 로라도 보여준다
    host.textContent = '';
    if (scene && MAKERS[pick]) {
      try {
        host.className = `curtain on ent-${pick}`;
        host.style.setProperty('--cover', `${MS.cover}ms`);
        MAKERS[pick](host, window.innerWidth, window.innerHeight);
        return Promise.resolve(coverMs(pick, asset));
      } catch { /* 이것도 안 되면 아래로 */ }
    }
    host.className = 'curtain';
    host.textContent = '';
    return Promise.resolve(0);
  }

  void breakSec;
  // 연출은 배경으로 남는다 — 창이 닫힐 때 함께 사라지므로 여기서 걷지 않는다.
  return Promise.resolve(coverMs(pick, asset));
}

window.nunsEnter = { LIST, play, coverMs, isMine, sceneFor, TOTAL, MS };

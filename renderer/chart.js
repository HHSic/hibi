'use strict';
// 차트 화면.
//
// 여기서 하는 일: 창 배선(제목·기간 고르기·닫기·크기 조절)과 «자료를 받아 그리기» 호출.
// 실제로 선을 그리는 것은 draw() — 지금은 자리만 잡아 두었다.
//
// 자료 모양 (chart:data 가 주는 것):
//   { points: [{ t: <ms>, c: <종가> }, ...], range: '1mo', currency: 'USD', unsupported?: true }

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const root = document.documentElement;

root.style.setProperty('--radius', `${params.get('radius') || 16}px`);
if (params.get('scrim')) root.style.setProperty('--scrim-a', params.get('scrim'));

let cur = {
  ticker: params.get('ticker') || '',
  name: params.get('name') || '',
  market: params.get('market') || 'KR'
};
let range = params.get('range') || '1mo';

const RANGES = [
  { id: '1d', name: '1일' },
  { id: '5d', name: '5일' },
  { id: '1mo', name: '1개월' },
  { id: '6mo', name: '6개월' },
  { id: '1y', name: '1년' }
];

function head() {
  $('name').textContent = cur.name || cur.ticker;
  $('ticker').textContent = cur.ticker;
  document.title = `${cur.name || cur.ticker} 차트`;
}

function ranges() {
  const host = $('ranges');
  host.textContent = '';
  for (const r of RANGES) {
    const b = document.createElement('button');
    b.className = 'seg' + (r.id === range ? ' on' : '');
    b.textContent = r.name;
    b.onclick = () => {
      if (range === r.id) return;
      range = r.id;
      window.nunsseom.chartSetRange(range);
      ranges();
      load();
    };
    host.append(b);
  }
}

/** 값 요약 (맨 위 큰 숫자) */
function summary(pts) {
  const px = $('px');
  const pc = $('pc');
  if (!pts || pts.length < 2) { px.textContent = '—'; pc.textContent = ''; pc.className = 'pc flat'; return; }
  const first = pts[0].c;
  const last = pts[pts.length - 1].c;
  const diff = last - first;
  const rate = first ? (diff / first) * 100 : 0;
  px.textContent = last.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const up = diff > 0, dn = diff < 0;
  pc.className = 'pc ' + (up ? 'up' : dn ? 'dn' : 'flat');
  pc.textContent = `${up ? '+' : ''}${rate.toFixed(2)}% (${up ? '+' : ''}${diff.toLocaleString('en-US', { maximumFractionDigits: 2 })})`;
}

/**
 * 선을 그린다.
 *
 * TODO(차트): 여기를 채운다. points 를 받아 <svg> 로 꺾은선을 그리면 된다.
 *  - 세로는 최저~최고에 맞춰 여백을 조금 남기고, 가로는 점 개수에 맞춰 고르게
 *  - 오르면 빨강(--up) 내리면 파랑(--dn) — 한국식
 *  - 선 아래를 옅게 채우면 읽기 쉽다
 *  - 점이 많아도 화면 폭보다 촘촘히 그릴 필요는 없다 (솎아내기)
 */
function draw(pts) {
  const plot = $('plot');
  const old = plot.querySelector('svg');
  if (old) old.remove();
  if (!pts || !pts.length) return;
  // 아직 안 그린다 — 자료가 왔다는 것만 알린다.
  void pts;
}

let busy = false;
async function load() {
  if (busy) return;
  busy = true;
  const note = $('note');
  note.style.display = '';
  note.textContent = '불러오는 중…';
  try {
    const got = await window.nunsseom.chartData({ ticker: cur.ticker, market: cur.market, range });
    const pts = (got && got.points) || [];
    summary(pts);
    draw(pts);
    if (got && got.unsupported) note.textContent = '차트를 아직 못 불러옵니다';
    else if (!pts.length) note.textContent = got && got.error ? '불러오지 못했습니다' : '자료가 없습니다';
    else note.style.display = 'none';
  } catch {
    note.textContent = '불러오지 못했습니다';
  } finally {
    busy = false;
  }
}

// ── 창 배선 ──────────────────────────────────────────────
$('refresh').append(window.nunsIcon('chevron'));
$('close').append(window.nunsIcon('close'));
$('refresh').onclick = () => load();
$('close').onclick = () => window.nunsseom.chartClose();

// 다른 종목을 누르면 창은 그대로 두고 내용만 바꾼다
window.nunsseom.onChartShow((item) => {
  cur = { ticker: item.ticker, name: item.name, market: item.market };
  head();
  load();
});

// 오른쪽 아래를 끌어 크기 조절 (네이티브 리사이즈를 안 쓴다)
(() => {
  const grip = $('grip');
  let start = null;
  grip.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    const b = await window.nunsseom.chartBounds();
    if (!b) return;
    start = { x: e.screenX, y: e.screenY, b };
    const move = (ev) => {
      if (!start) return;
      window.nunsseom.chartSetBounds({
        x: start.b.x, y: start.b.y,
        width: start.b.width + (ev.screenX - start.x),
        height: start.b.height + (ev.screenY - start.y)
      });
    };
    const up = () => {
      start = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
})();

head();
ranges();
load();

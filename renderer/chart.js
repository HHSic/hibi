'use strict';
// 차트 화면.
//
// 여기서 하는 일: 창 배선(제목·기간·보기 고르기·닫기·크기 조절)과 «자료를 받아 그리기».
// 선·봉·거래량·축·십자선을 <svg> 로 직접 그린다 — 차트 라이브러리를 넣을 만한 그림이 아니고,
// 넣으면 배포물만 무거워진다.
//
// 자료 모양 (chart:data 가 주는 것):
//   { points: [{ t, o, h, l, c, v }, ...], range, currency, prevClose, krwRate, mode }
//   krwRate 가 있으면 «원화 보기»가 켜진 것 — 값에 곱해 그린다(거래량은 주식 수라 그대로).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const root = document.documentElement;

root.style.setProperty('--radius', `${params.get('radius') || 16}px`);
if (params.get('scrim')) root.style.setProperty('--scrim-a', params.get('scrim'));

let cur = {
  ticker: params.get('ticker') || '',
  name: params.get('name') || '',
  market: params.get('market') || 'KR',
  currency: null
};
let range = params.get('range') || '1mo';
let mode = 'auto';          // 'auto' | 'line' | 'candle'
let krwRate = null;         // 원화 보기가 켜졌을 때의 환율
let prevClose = null;       // 전일 종가 — 1일 차트의 기준선
let tooDense = false;       // 봉을 그리기엔 점이 촘촘해 선으로 넘긴 상태
/** 마지막으로 그린 점들 — 창 크기가 바뀌면 이것으로 다시 그린다 */
let last = [];
let again = 0;

const NS = 'http://www.w3.org/2000/svg';

const RANGES = [
  { id: '1d', name: '1일' },
  { id: '5d', name: '5일' },
  { id: '1mo', name: '1개월' },
  { id: '6mo', name: '6개월' },
  { id: '1y', name: '1년' }
];

const MODES = [
  { id: 'line', name: '선' },
  { id: 'candle', name: '봉' }
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

/** 지금 보기가 선인가 봉인가 — 'auto'는 1일만 선(5분봉은 심지가 뜻이 없다) */
function wantCandle() {
  if (mode === 'line') return false;
  if (mode === 'candle') return true;
  return range !== '1d';
}

function modes() {
  const host = $('modes');
  host.textContent = '';
  // 지금 «실제로 그려진» 보기 — 고른 것이 아니다.
  // 봉을 골랐어도 촘촘해 선으로 넘어갔으면 선이 켜져야 눈앞의 그림과 맞는다.
  const drawn = wantCandle() && !tooDense ? 'candle' : 'line';
  for (const m of MODES) {
    const b = document.createElement('button');
    const on = m.id === drawn;
    b.className = 'seg' + (on ? ' on' : '');
    b.textContent = m.name;
    // 봉을 그리기엔 촘촘해 선으로 넘어간 상태면, 눌러도 선이 나온다는 것을 미리 알린다
    if (m.id === 'candle' && tooDense) {
      b.disabled = true;
      b.title = '이 기간은 봉이 너무 촘촘해 선으로 보여줍니다';
    }
    b.onclick = () => {
      mode = m.id;
      window.nunsseom.chartSetMode(mode);
      if (last.length) draw(last);
      else modes();
    };
    host.append(b);
  }
}

/** 값 찍기 — 원화로 환산해 보는 중이면 소수점을 버린다(원 단위) */
function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const whole = krwRate != null || cur.currency === 'KRW' || cur.currency === 'JPY';
  return v.toLocaleString('en-US', { maximumFractionDigits: whole ? 0 : 2 });
}

/** 거래량은 자릿수가 커서 그대로 쓰면 축이 넘친다 */
function fmtVol(v) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString('en-US')}만`;
  return v.toLocaleString('en-US');
}

/** 그 점이 언제 것인가 — 하루·닷새는 시각이, 그 위로는 날짜가 궁금하다 */
function stamp(t) {
  const d = new Date(t);
  if (range === '1d' || range === '5d') {
    return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric' });
}

/** 가로축에 찍을 짧은 날짜 */
function shortStamp(t) {
  const d = new Date(t);
  if (range === '1d') return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 값 요약 (맨 위 큰 숫자). i를 주면 짚은 자리 값, 안 주면 마지막 값.
 *
 * 짚은 값을 여기 띄우는 이유: 460px 창에서 마우스를 따라다니는 말풍선은 차트를 가린다.
 * 자리는 이미 있으니 그 숫자만 바꾼다.
 */
function summary(view, i) {
  const px = $('px'), pc = $('pc'), oh = $('ohlc');
  if (!view || !view.length) {
    px.textContent = '—'; pc.textContent = ''; pc.className = 'pc flat'; oh.textContent = '';
    return;
  }
  const at = i == null ? view.length - 1 : i;
  const p = view[at];
  // 등락은 늘 «기간 첫 값» 대비다 — 짚어 보는 중에도 기준이 흔들리면 헷갈린다.
  // 다만 1일 차트는 전일 종가가 기준이라야 맞다.
  const k = krwRate || 1;
  const base = (range === '1d' && prevClose != null) ? prevClose * k : view[0].c;
  const diff = p.c - base;
  const pct = base ? (diff / base) * 100 : 0;
  px.textContent = fmt(p.c);
  const up = diff > 0, dn = diff < 0;
  pc.className = 'pc ' + (up ? 'up' : dn ? 'dn' : 'flat');
  pc.textContent = `${up ? '+' : ''}${pct.toFixed(2)}% (${up ? '+' : ''}${fmt(diff)})`;

  oh.textContent = '';
  const bits = i == null
    ? [['거래량', fmtVol(p.v)]]
    : [['시', fmt(p.o)], ['고', fmt(p.h)], ['저', fmt(p.l)], ['종', fmt(p.c)], ['량', fmtVol(p.v)]];
  for (const [k2, v] of bits) {
    oh.append(`${k2} `);
    const b = document.createElement('b');
    b.textContent = v;
    oh.append(b, '  ');
  }
  if (i != null) oh.append(stamp(p.t));
}

/**
 * 점이 폭보다 촘촘하면 솎아낸다.
 * 픽셀 하나에 점이 여럿 겹치면 선만 두꺼워 보이고 읽히는 것은 없다 (1년 = 243개, 실측).
 * 끝점은 반드시 남긴다 — 위의 큰 숫자가 끝점 값이라, 선 끝이 다르면 틀린 것처럼 보인다.
 */
function thin(pts, max) {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  const tail = pts[pts.length - 1];
  if (out[out.length - 1] !== tail) out.push(tail);
  return out;
}

function el(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  return n;
}
const txt = (attrs, s) => Object.assign(el('text', attrs), { textContent: s });

// 축에 내주는 자리. 값은 오른쪽, 날짜는 아래 — 봉차트의 흔한 배치다.
const AX_W = 52;
const AX_H = 15;
const VOL_FRAC = 0.22;      // 거래량 칸 높이
const VOL_GAP = 7;
const CANDLE_MIN = 3;       // 봉 하나가 이보다 좁으면 심지가 몸통을 덮는다 — 선으로 넘긴다

/**
 * 그린다.
 *
 * viewBox 를 «지금 화면 픽셀»로 잡고 preserveAspectRatio="none" 을 준다.
 * 창을 끄는 동안에는 늘어나 주고(다시 그릴 틈이 없다), 다 끌고 나면 ResizeObserver 가
 * 같은 점들로 다시 그려 글자와 선 굵기를 제 비율로 되돌린다.
 */
function draw(pts) {
  const plot = $('plot');
  const old = plot.querySelector('svg');
  if (old) old.remove();
  last = pts || [];
  if (!pts || !pts.length) { summary(null); modes(); return; }

  // 원화 보기면 값에 환율을 곱한다. 거래량은 주식 «수»라 그대로 둔다.
  const k = krwRate;
  const view0 = k ? pts.map((p) => ({ ...p, o: p.o * k, h: p.h * k, l: p.l * k, c: p.c * k })) : pts;

  const svg = el('svg', { preserveAspectRatio: 'none' });
  plot.append(svg);
  // 붙인 뒤에 잰다 — 붙이기 전에는 크기가 0이다. (0이 나오는 순간이 있어 대비값을 둔다)
  const W = Math.max(120, Math.round(svg.clientWidth || 600));
  const H = Math.max(80, Math.round(svg.clientHeight || 200));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const plotW = W - AX_W;
  const bodyH = H - AX_H;
  // 창이 납작하면 거래량을 접는다 — 억지로 넣으면 둘 다 못 읽는다
  const showVol = bodyH >= 190;
  const volH = showVol ? Math.round(bodyH * VOL_FRAC) : 0;
  const priceH = bodyH - volH - (showVol ? VOL_GAP : 0);

  // 봉은 솎으면 뜻이 깨진다(시·고·저·종이 섞인다) — 대신 너무 촘촘하면 선으로 넘긴다.
  const candleFit = plotW / pts.length >= CANDLE_MIN;
  const candle = wantCandle() && candleFit;
  tooDense = wantCandle() && !candleFit;
  const view = candle ? view0 : thin(view0, plotW);

  let lo = Infinity, hi = -Infinity;
  for (const p of view) {
    const a = candle ? p.l : p.c;
    const b = candle ? p.h : p.c;
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  const pc0 = (range === '1d' && prevClose != null) ? prevClose * (k || 1) : null;
  if (pc0 != null) { lo = Math.min(lo, pc0); hi = Math.max(hi, pc0); }
  // 하루 종일 값이 안 움직인 종목(거래 없음)은 폭이 0이라 나누기가 깨진다 — 억지로 폭을 준다
  if (!(hi - lo > 0)) { const w = Math.abs(hi) * 0.01 || 1; lo = hi - w; hi += w; }
  const pad = (hi - lo) * 0.08;   // 위아래 8% — 꼭짓점이 테두리에 붙으면 잘린 것처럼 보인다
  const top = hi + pad, bot = lo - pad;
  const yOf = (v) => ((top - v) / (top - bot)) * priceH;
  const step = plotW / Math.max(1, view.length);
  const xOf = (i) => (candle
    ? i * step + step / 2
    : (view.length < 2 ? plotW / 2 : (i / (view.length - 1)) * plotW));

  // 오름/내림은 솎기 전의 첫·끝으로 본다 — 위의 요약과 색이 달라지면 안 된다.
  // 한국식이다: 오르면 빨강, 내리면 파랑. 해외 종목도 같게 둔다 — 보는 사람이 한국 사람이다.
  const baseC = pc0 != null ? pc0 : view0[0].c;
  const color = view0[view0.length - 1].c >= baseC ? 'var(--up)' : 'var(--dn)';

  // ── 값 눈금 (오른쪽) ──
  const marks = [];
  const TICKS = priceH >= 150 ? 4 : 3;
  for (let i = 0; i < TICKS; i++) {
    const v = top - ((top - bot) * i) / (TICKS - 1);
    const gy = yOf(v);
    svg.append(el('line', { x1: 0, x2: plotW, y1: gy, y2: gy, stroke: 'var(--hairline)', 'stroke-width': 1 }));
    marks.push(txt({
      x: W - 4, y: Math.min(priceH - 1, Math.max(9, gy + 3)),
      fill: 'var(--tertiary)', 'font-size': 9.5, 'text-anchor': 'end'
    }, fmt(v)));
  }
  // 1일 차트의 기준선 — 이게 있어야 «지금 오른 건가»가 한눈에 보인다
  if (pc0 != null) {
    svg.append(el('line', {
      x1: 0, x2: plotW, y1: yOf(pc0), y2: yOf(pc0),
      stroke: 'var(--tertiary)', 'stroke-width': 1, 'stroke-dasharray': '3 3'
    }));
  }

  // ── 값 그리기 ──
  if (candle) {
    const bw = Math.max(1, Math.min(14, step * 0.68));
    for (let i = 0; i < view.length; i++) {
      const p = view[i];
      const x = xOf(i);
      const col = p.c >= p.o ? 'var(--up)' : 'var(--dn)';
      svg.append(el('line', { x1: x, x2: x, y1: yOf(p.h), y2: yOf(p.l), stroke: col, 'stroke-width': 1 }));
      const y1 = yOf(Math.max(p.o, p.c));
      const y2 = yOf(Math.min(p.o, p.c));
      svg.append(el('rect', {
        x: x - bw / 2, y: y1, width: bw,
        // 시가와 종가가 같은 봉은 높이가 0이라 안 보인다 — 최소 1px 은 남긴다
        height: Math.max(1, y2 - y1), fill: col
      }));
    }
  } else {
    let d = '';
    view.forEach((p, i) => { d += `${i ? 'L' : 'M'}${xOf(i).toFixed(1)} ${yOf(p.c).toFixed(1)}`; });
    if (view.length > 1) {
      // 선 아래를 옅게 — 오르내림 폭이 좁을 때 선 하나만으로는 어느 쪽이 위인지 안 잡힌다
      svg.append(el('path', {
        d: `${d}L${xOf(view.length - 1).toFixed(1)} ${priceH}L${xOf(0).toFixed(1)} ${priceH}Z`,
        fill: color, 'fill-opacity': 0.12, stroke: 'none'
      }));
    }
    svg.append(el('path', {
      d, fill: 'none', stroke: color, 'stroke-width': 1.6,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));
  }

  // ── 거래량 ──
  if (showVol) {
    let vmax = 0;
    for (const p of view) if (p.v > vmax) vmax = p.v;
    if (vmax > 0) {
      const vTop = priceH + VOL_GAP;
      const bw = Math.max(1, Math.min(14, step * (candle ? 0.68 : 0.9)));
      for (let i = 0; i < view.length; i++) {
        const p = view[i];
        if (!p.v) continue;
        const h = Math.max(1, (p.v / vmax) * volH);
        svg.append(el('rect', {
          x: xOf(i) - bw / 2, y: vTop + (volH - h), width: bw, height: h,
          fill: p.c >= p.o ? 'var(--up)' : 'var(--dn)', 'fill-opacity': 0.45
        }));
      }
      marks.push(txt({ x: W - 4, y: vTop + 9, fill: 'var(--tertiary)', 'font-size': 9, 'text-anchor': 'end' },
        fmtVol(vmax)));
    }
  }

  // ── 날짜 눈금 (아래) ──
  const XT = plotW >= 420 ? 4 : 2;
  for (let i = 0; i < XT; i++) {
    const at = Math.round((view.length - 1) * (i / (XT - 1)));
    const anchor = i === 0 ? 'start' : i === XT - 1 ? 'end' : 'middle';
    const x = i === 0 ? 1 : i === XT - 1 ? plotW - 1 : xOf(at);
    marks.push(txt({ x, y: H - 4, fill: 'var(--tertiary)', 'font-size': 9, 'text-anchor': anchor },
      shortStamp(view[at].t)));
  }
  // 글자는 그림 위에 얹는다 — 아래 채움이나 봉에 덮이면 값이 안 읽힌다
  for (const t of marks) svg.append(t);

  // ── 짚어 보기 ──
  // 십자선 + 오른쪽 값 배지. 값 자체는 머리글(#px·#ohlc)에 띄운다.
  const mark = el('g', { visibility: 'hidden' });
  const vbar = el('line', { y1: 0, y2: bodyH, stroke: 'var(--tertiary)', 'stroke-width': 1 });
  const hbar = el('line', { x1: 0, x2: plotW, stroke: 'var(--tertiary)', 'stroke-width': 1, 'stroke-dasharray': '2 3' });
  const dot = el('circle', { r: 2.8, fill: color, stroke: 'var(--scrim)', 'stroke-width': 1.5 });
  const badge = el('rect', { width: AX_W - 6, height: 13, rx: 3, fill: 'var(--fill-hi)' });
  const btxt = txt({ 'font-size': 9.5, fill: 'var(--label)', 'text-anchor': 'end' }, '');
  mark.append(vbar, hbar, dot, badge, btxt);
  svg.append(mark);

  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    if (!box.width) return;
    const mx = ((e.clientX - box.left) / box.width) * W;
    if (mx > plotW) return;             // 축 위에서는 짚지 않는다
    const i = candle
      ? Math.min(view.length - 1, Math.max(0, Math.floor(mx / step)))
      : Math.min(view.length - 1, Math.max(0, Math.round((mx / plotW) * (view.length - 1))));
    const x = xOf(i), y = yOf(view[i].c);
    vbar.setAttribute('x1', x); vbar.setAttribute('x2', x);
    hbar.setAttribute('y1', y); hbar.setAttribute('y2', y);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    badge.setAttribute('x', plotW + 3);
    badge.setAttribute('y', Math.min(priceH - 13, Math.max(0, y - 6.5)));
    btxt.setAttribute('x', W - 5);
    btxt.setAttribute('y', Math.min(priceH - 3, Math.max(10, y + 3)));
    btxt.textContent = fmt(view[i].c);
    mark.setAttribute('visibility', 'visible');
    summary(view, i);
  });
  svg.addEventListener('pointerleave', () => {
    mark.setAttribute('visibility', 'hidden');
    summary(view);
  });

  summary(view);
  modes();
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
    cur.currency = (got && got.currency) || null;
    krwRate = (got && got.krwRate) || null;
    prevClose = got && got.prevClose != null ? got.prevClose : null;
    if (got && got.mode) mode = got.mode;
    draw(pts);
    // 문구는 언제나 «지금 비어 있다면 그 까닭»을 들고 있게 둔다. 잘 그렸으면 숨기기만 하고
    // «불러오는 중…»은 남기지 않는다 — 숨은 문구가 그대로면 사람이 열어 보든 시험이 읽든
    // 아직 부르는 중인 것처럼 읽힌다.
    note.textContent = got && got.unsupported ? '차트를 아직 못 불러옵니다'
      : got && got.error ? '불러오지 못했습니다'
        : '자료가 없습니다';
    if (pts.length) note.style.display = 'none';
  } catch {
    note.textContent = '불러오지 못했습니다';
  } finally {
    busy = false;
  }
}

// ── 창 배선 ──────────────────────────────────────────────
$('refresh').textContent = '↻';   // 아이콘 목록에 새로고침이 없다 — 주식 창과 같은 글자를 쓴다
$('close').append(window.nunsIcon('close'));
$('refresh').onclick = () => load();
$('close').onclick = () => window.nunsseom.chartClose();

// 창 크기가 바뀌면 같은 점들로 다시 그린다 — viewBox 만으로 늘리면 글자가 눌린다.
// 끄는 동안 매 프레임 다시 그리면 아까우니 다음 프레임에 한 번만 그린다.
new ResizeObserver(() => {
  cancelAnimationFrame(again);
  again = requestAnimationFrame(() => { if (last.length) draw(last); });
}).observe($('plot'));

// 다른 종목을 누르면 창은 그대로 두고 내용만 바꾼다
window.nunsseom.onChartShow((item) => {
  cur = { ticker: item.ticker, name: item.name, market: item.market, currency: null };
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
modes();
load();

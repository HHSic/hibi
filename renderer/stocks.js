'use strict';
// 주식 창 — 관심 종목의 지금 값과 TOP 100.
//
// 관심 시세는 야후에서 오고 20분쯤 지연된다(머리글에 «몇 분 전»으로 적어 둔다).
// TOP 100 은 네이버 목록이라 거의 실시간이다(머리글에 그렇게 적는다).
// 값이 안 바뀌면 다시 그리지 않는다 — 매초 통째로 그리면 올려둔 마우스가 깜빡인다
// (메일 목록에서 실제로 그랬다).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const root = document.documentElement;
// 테마와 유리 진하기는 theme.js 가 입힌다. 글이 빽빽한 창이라 더 진하게(+0.04) 하는 것도 메인이 계산해 넘긴다 (dense=1).
const num = (k, d) => { const v = parseFloat(params.get(k)); return Number.isNaN(v) ? d : v; };
root.style.setProperty('--inset', num('inset', 12) + 'px');
root.style.setProperty('--r', num('radius', 18) + 'px');

let data = null;
let sig = '';
// 순위에서 마지막으로 그린 고르기 — 같은 고르기를 다시 그릴 때만 스크롤을 지킨다
let paintedTop = '';
// say 줄에 띄운 «새로 받지 못했습니다». 넣기 결과 같은 다른 말을 지우지 않으려고 기억해 둔다
let saidFail = '';

$('close').append(window.nunsIcon('close'));
// 아이콘 모음에 «다시 받기»가 없어 글자로 둔다 (받는 중에는 이게 돈다)
$('refresh').textContent = '↻';

function fmtPrice(r) {
  // 원화 보기를 켰고 환산가가 붙어 있으면 그것을 보여준다 (src/fx.js 가 붙인다).
  // 환율을 못 구했으면 krwPrice 가 없으므로 원래 통화 그대로 — 조용히 넘어간다.
  const krw = r.krwPrice != null;
  const v = krw ? r.krwPrice : r.price;
  if (v == null) return '—';
  // 원·엔은 소수점을 안 쓰는 게 보통이다. 다만 161.5처럼 오는 종목이 있어 한 자리는 살린다.
  const whole = krw || r.currency === 'KRW' || r.currency === 'JPY';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 1 : 2
  });
}

function fmtLag(box) {
  if (box.loading) return '받는 중…';
  if (box.lagSec == null) return '';
  if (box.lagSec < 90) return '방금';
  return `${Math.round(box.lagSec / 60)}분 전`;
}

// 이만큼 지난 줄은 «거의 실시간»이 아니다 (창을 닫았다 열거나 절전에서 깬 때). 보통은 주기 60초 + 틱 15초 안에 새로 온다
const TOP_STALE_MS = 3 * 60_000;

/** 받은 시각. 오늘이 아니면 날짜도 — 어제 15:30 을 오늘로 읽지 않게 */
function clock(at) {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 순위 보기의 머리글. 평소에는 출처(관심은 야후 20분 지연, 여기는 네이버)와 장 상태.
 * 못 받았거나 묵은 줄에 «거의 실시간 · 장중»을 쓰면 거짓말이다 — 받은 시각을 쓴다.
 * 실패는 say 줄에도 뜨지만 별 한 번에 덮이고 다시 안 뜨니 여기에 남는다.
 * 받는 중도 여기에 쓴다. 값이 그대로면 ↻ 를 눌렀는지 알 곳이 여기뿐이다.
 */
function topNote(box) {
  const state = box.loading ? '받는 중…' : box.error ? '새로 받지 못함' : '';
  if (!box.rows.length) return state || '받는 중…';
  const old = box.at && Date.now() - box.at >= TOP_STALE_MS;
  if (box.error || old) return [box.at ? `${clock(box.at)} 기준` : '', state].filter(Boolean).join(' · ');
  if (box.loading) return state;
  const st = box.status === 'OPEN' ? '장중' : box.status === 'CLOSE' ? '장 마감' : '';
  return ['네이버 · 거의 실시간', st].filter(Boolean).join(' · ');
}

/** 관심 목록의 종목번호. 파일이 깨져 null 이 섞여 있어도 여기서 터지지 않는다 — 까닭은 메인이 오류로 보낸다 */
const tickersOf = (box) => (box.watch || []).map((w) => w && w.ticker);

/** 값이 그대로면 다시 안 그린다 */
function sigOf(box) {
  if (!box) return 'none';
  // 순위는 받는 동안에도 줄이 그대로면 안 그린다 — 100줄을 1분마다 부수면 올려둔 마우스가 깜빡인다.
  // 줄이 없을 때만 «받는 중» 글이 바뀐다
  const loading = box.loading && !(box.view === 'top' && box.rows.length);
  return [
    box.view, box.topMarket, box.topSort,
    box.market, box.indexes ? 'i' : '', loading ? 'L' : '', box.error || '', box.lagSec ?? '',
    tickersOf(box).join(','),
    ...box.rows.map((r) => `${r.ticker}:${r.price ?? '-'}:${r.pct == null ? '-' : r.pct.toFixed(2)}:${r.error || ''}`
      + `:${r.rank ?? ''}:${r.metric ?? ''}:${r.krwPrice ?? ''}`)
  ].join('|');
}

/** 등락률 칸 — 관심과 순위가 같이 쓴다 */
function pcCell(r) {
  const pc = document.createElement('span');
  if (r.error) {
    pc.className = 'pc bad';
    pc.textContent = r.error;
  } else if (r.pct == null) {
    pc.className = 'pc flat';
    pc.textContent = '—';
  } else {
    const up = r.pct > 0.005;
    const dn = r.pct < -0.005;
    pc.className = 'pc ' + (up ? 'up' : dn ? 'dn' : 'flat');
    pc.textContent = (up ? '+' : '') + r.pct.toFixed(2) + '%';
  }
  return pc;
}

/** 줄이 있는데 새로 받지 못했으면 say 줄에 알린다. 줄이 없으면 목록 자리에 쓰므로 여기서는 안 한다 */
function sayTopFail(box) {
  const msg = box.view === 'top' && box.error && box.rows.length ? `순위를 새로 받지 못했습니다 — ${box.error}` : '';
  if (msg === saidFail) return;
  if (msg) say(msg, true);
  else if ($('say').textContent === saidFail) say('');
  saidFail = msg;
}

function topRowEl(r, watched) {
  const row = document.createElement('div');
  row.className = 'row top tap';
  row.title = [r.name, r.ticker, r.exchange, r.metric, '눌러서 차트'].filter(Boolean).join(' · ');
  row.onclick = () => window.nunsseom.chartOpen({ ticker: r.ticker, name: r.name, market: r.market, index: false });

  const rk = document.createElement('span');
  rk.className = 'rk';
  rk.textContent = r.rank;

  const nm = document.createElement('span');
  nm.className = 'nm';
  const b = document.createElement('b');
  b.textContent = r.name;
  nm.append(b);
  // ETF·ETN 은 네이버 순위 그대로 두되 알아볼 수 있게. 권리 증서는 본주 이름으로 와서 더 그렇다
  const tag = { etf: 'ETF', etn: 'ETN', right: '권리' }[r.kind];
  if (tag) {
    const kd = document.createElement('span');
    kd.className = 'kd';
    kd.textContent = tag;
    nm.append(kd);
  }
  if (r.metric) {
    const i = document.createElement('i');
    i.textContent = r.metric;
    nm.append(i);
  }

  const px = document.createElement('span');
  px.className = 'px';
  px.textContent = fmtPrice(r);

  const on = watched.has(r.ticker);
  const star = document.createElement('button');
  star.className = 'star' + (on ? ' on' : '');
  star.textContent = on ? '★' : '☆';
  star.title = on ? `${r.name} 관심에서 빼기` : `${r.name} 관심에 넣기`;
  star.setAttribute('aria-label', star.title);
  star.setAttribute('aria-pressed', String(on));
  star.onclick = (e) => { e.stopPropagation(); toggleStar(r, on); };

  row.append(rk, nm, px, pcCell(r), star);
  return row;
}

/** 순위 목록을 그린다. 줄이 하나도 없으면 까닭을 목록 자리에 */
function paintTop(box, list) {
  if (!box.rows.length) {
    const d = document.createElement('div');
    d.className = 'none';
    d.textContent = box.error ? `순위를 받지 못했습니다 — ${box.error}` : '순위를 받는 중…';
    list.append(d);
    return;
  }
  const watched = new Set(tickersOf(box));
  for (const r of box.rows) list.append(topRowEl(r, watched));
}

function paint() {
  const box = data;
  if (!box) return;
  const top = box.view === 'top';
  for (const b of document.querySelectorAll('.seg[data-view]')) {
    b.classList.toggle('on', b.dataset.view === (top ? 'top' : 'watch'));
  }
  for (const b of document.querySelectorAll('.seg[data-mk]')) {
    b.classList.toggle('on', b.dataset.mk === box.market);
    b.hidden = top;
  }
  for (const b of document.querySelectorAll('.seg[data-tm]')) {
    b.classList.toggle('on', b.dataset.tm === box.topMarket);
    b.hidden = !top;
  }
  $('sorts').hidden = !top;
  for (const b of document.querySelectorAll('.seg[data-ts]')) {
    b.classList.toggle('on', b.dataset.ts === box.topSort);
    // 미국에는 인기 목록이 없다
    b.hidden = b.dataset.ts === 'searchTop' && box.topMarket === 'US';
  }
  $('idx').hidden = top;
  $('idx').classList.toggle('on', !!box.indexes);
  // 국내 순위는 이미 원화라 눌러도 아무 일이 없다
  $('krw').hidden = top && box.topMarket !== 'US';
  $('krw').classList.toggle('on', !!box.krw);
  $('note').textContent = top ? topNote(box) : fmtLag(box);
  $('refresh').classList.toggle('spin', !!box.loading);
  sayTopFail(box);

  const next = sigOf(box);
  if (next === sig) return;
  sig = next;

  const list = $('list');
  const sel = top ? `${box.topMarket}:${box.topSort}` : '';
  // 다시 채운 뒤 제자리로 돌리려고 먼저 읽어 둔다
  const keep = top && sel === paintedTop ? list.scrollTop : 0;
  const leftTop = !top && paintedTop;
  paintedTop = sel;
  list.textContent = '';
  // 비운다고 스크롤이 0 이 되는 것은 아니다 — 레이아웃 전에는 옛 값이 남아 새 목록의 끝쪽에서 시작한다. 관심끼리 다시 그릴 때는 지금 그대로 둔다
  if (leftTop) list.scrollTop = 0;

  if (top) {
    paintTop(box, list);
    list.scrollTop = keep;
    return;
  }

  if (box.error) {
    const d = document.createElement('div');
    d.className = 'none';
    d.textContent = box.error;
    list.append(d);
    return;
  }
  // 관심 종목이 하나도 없을 때만 안내를 낸다.
  // «줄이 0개»로 보면 안 된다 — 지수가 켜져 있으면 네 줄이 늘 있어서 영영 안 나온다.
  const bare = !(box.watch && box.watch.length);

  let wasIndex = null;
  for (const r of box.rows) {
    if (wasIndex === true && !r.index) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      list.append(sep);
    }
    wasIndex = r.index;

    const row = document.createElement('div');
    row.className = 'row' + (r.index ? ' idx' : '') + (r.stale ? ' stale' : '');
    row.title = [r.name, r.symbol || r.ticker, r.session,
      r.stale ? '오늘 거래 없음' : null, '눌러서 차트'].filter(Boolean).join(' · ');
    // 눌러서 큰 차트. 지수도 연다 — 코스피 흐름을 보는 것이 종목만큼 자주 하는 일이다.
    // index 를 같이 넘겨야 한다: 지수 심볼(^KS11)에 «.KS»를 붙이면 아무것도 안 나온다.
    row.classList.add('tap');
    row.onclick = () => window.nunsseom.chartOpen({
      ticker: r.ticker, name: r.name, market: r.market, index: !!r.index
    });

    const nm = document.createElement('span');
    nm.className = 'nm';
    const b = document.createElement('b');
    b.textContent = r.name;
    nm.append(b);
    if (!r.index) {
      const i = document.createElement('i');
      i.textContent = r.ticker;
      nm.append(i);
    }

    const px = document.createElement('span');
    px.className = 'px';
    px.textContent = r.error ? '' : fmtPrice(r);

    row.append(nm, px, pcCell(r));

    // 지수는 지울 수 없다 — «지수» 단추로 통째로 끄고 켠다
    if (r.index) {
      row.append(document.createElement('span'));
    } else {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = `${r.name} 빼기`;
      del.onclick = (e) => { e.stopPropagation(); window.nunsseom.stocksRemove(r.ticker); };
      row.append(del);
    }
    list.append(row);
  }

  if (bare) {
    const d = document.createElement('div');
    d.className = 'none';
    d.append('관심 종목이 없습니다. 아래에 이름 일부를 쳐 보세요.');
    d.append(document.createElement('br'));
    // 옆 프로젝트에 목록이 이미 있으면 한 번에 가져올 수 있게 — 가져온 뒤로는 서로 상관없다
    const imp = document.createElement('button');
    imp.className = 'mini ghost';
    imp.style.marginTop = '8px';
    imp.textContent = 'algo-trader에서 가져오기';
    imp.title = 'watchlist.json 한 번 복사';
    imp.onclick = async () => {
      imp.disabled = true;
      say('가져오는 중…');
      try {
        const r = await window.nunsseom.stocksImport('');
        say(r.ok ? `${r.added}종목 가져왔습니다 (전체 ${r.total})` : r.message, !r.ok);
      } finally {
        imp.disabled = false;
      }
    };
    d.append(imp);
    list.append(d);
  }
}

window.nunsseom.onStocksData((box) => { data = box; paint(); });

for (const b of document.querySelectorAll('.seg[data-mk]')) {
  b.onclick = () => window.nunsseom.stocksSetApp({ stocksMarket: b.dataset.mk });
}
for (const b of document.querySelectorAll('.seg[data-view]')) {
  b.onclick = () => window.nunsseom.stocksSetApp({ stocksView: b.dataset.view });
}
for (const b of document.querySelectorAll('.seg[data-tm]')) {
  b.onclick = () => window.nunsseom.stocksSetApp({ stocksTopMarket: b.dataset.tm });
}
for (const b of document.querySelectorAll('.seg[data-ts]')) {
  b.onclick = () => window.nunsseom.stocksSetApp({ stocksTopSort: b.dataset.ts });
}
$('idx').onclick = () => window.nunsseom.stocksSetApp({ stocksIndexes: !(data && data.indexes) });
$('krw').onclick = () => window.nunsseom.stocksSetApp({ stocksKrw: !(data && data.krw) });

let busy = false;
$('refresh').onclick = async () => {
  if (busy) return;
  busy = true;
  try { await window.nunsseom.stocksRefresh(); } finally { busy = false; }
};
$('close').onclick = () => window.nunsseom.stocksClose();
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.nunsseom.stocksClose(); });

// ── 종목 넣기 ────────────────────────────────────────────
function say(msg, bad) {
  $('say').textContent = msg || '';
  $('say').classList.toggle('bad', !!bad);
}

let adding = false;
/** input에는 «고른 것»(객체)이나 «친 글자»(문자열)를 준다 */
async function add(pick) {
  const input = pick || $('q').value.trim();
  if (!input || adding) return;
  adding = true;
  $('btn-add').disabled = true;
  shut();
  say('찾는 중…');
  try {
    const r = await window.nunsseom.stocksAdd(input);
    if (!r.ok) { say(r.message, true); return; }
    if (!r.added) { say(r.message); return; }
    $('q').value = '';
    say(`${r.name} 넣었습니다`);
  } catch (e) {
    say(e.message || '넣지 못했습니다', true);
  } finally {
    adding = false;
    $('btn-add').disabled = false;
  }
}
$('btn-add').onclick = () => add();

// 순위 줄의 별. add() 를 안 쓴다 — 입력칸에 치던 글자를 지우면 안 되고, 찾는 동안 다른 줄의 별이 씹히면 안 된다
const starring = new Set();
async function toggleStar(r, on) {
  if (starring.has(r.ticker)) return;
  starring.add(r.ticker);
  try {
    if (on) {
      await window.nunsseom.stocksRemove(r.ticker);
      say(`${r.name} 뺐습니다`);
      return;
    }
    say('찾는 중…');
    // 객체로 넘겨야 «고른 것»으로 친다 — 글자로 넘기면 0162Z0 같은 국내 코드가 미국 종목으로 간다
    const a = await window.nunsseom.stocksAdd({ ticker: r.ticker, name: r.name, market: r.market });
    if (!a.ok || !a.added) say(a.message, !a.ok);
    else say(`${a.name} 넣었습니다`);
  } catch (e) {
    say(e.message || '바꾸지 못했습니다', true);
  } finally {
    starring.delete(r.ticker);
  }
}

// ── 이름으로 찾기 ────────────────────────────────────────
// 종목번호를 외우고 있는 사람은 없다. 치는 동안 찾아서 고르게 한다.
let hits = [];
let cur = -1;
let seq = 0;
let timer = null;

function shut() {
  hits = [];
  cur = -1;
  $('sug').classList.remove('on');
  $('sug').textContent = '';
}

function drawSug() {
  const box = $('sug');
  box.textContent = '';
  if (!hits.length) {
    const d = document.createElement('div');
    d.className = 'none2';
    d.textContent = '찾는 종목이 없습니다';
    box.append(d);
    box.classList.add('on');
    return;
  }
  hits.forEach((h, i) => {
    const it = document.createElement('div');
    it.className = 'it' + (i === cur ? ' on' : '');
    const b = document.createElement('b');
    b.textContent = h.name;
    const t = document.createElement('span');
    t.textContent = `${h.ticker} · ${h.exchange || (h.market === 'US' ? '해외' : '국내')}`;
    it.append(b, t);
    // 누르기 전에 입력칸에서 포커스가 빠지면 목록이 닫혀 클릭이 씹힌다
    it.addEventListener('pointerdown', (e) => e.preventDefault());
    it.onclick = () => add(h);
    box.append(it);
  });
  box.classList.add('on');
}

function move(step) {
  if (!hits.length) return;
  cur = (cur + step + hits.length) % hits.length;
  drawSug();
  const on = $('sug').querySelector('.it.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

$('q').addEventListener('input', () => {
  const q = $('q').value.trim();
  clearTimeout(timer);
  if (!q) { shut(); return; }
  // 한 글자 칠 때마다 부르면 낭비다 — 잠깐 멈출 때 한 번만 찾는다
  timer = setTimeout(async () => {
    const mine = ++seq;
    const r = await window.nunsseom.stocksSearch(q).catch(() => []);
    if (mine !== seq) return;        // 그새 더 쳤으면 옛 결과는 버린다
    if (!$('q').value.trim()) { shut(); return; }
    hits = r;
    cur = r.length ? 0 : -1;
    drawSug();
  }, 220);
});

$('q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Escape') { if (hits.length) { e.stopPropagation(); shut(); } }
  else if (e.key === 'Enter') {
    e.preventDefault();
    // 고른 것이 있으면 그것을, 없으면 친 글자를 그대로 (종목번호를 아는 사람도 있다)
    add(cur >= 0 && hits[cur] ? hits[cur] : undefined);
  }
});
$('q').addEventListener('blur', () => setTimeout(shut, 120));
// 창 안에서는 글자를 고를 수 있어야 한다 (body에 user-select: none이 걸려 있다)
$('q').style.userSelect = 'text';

// ── 창 옮기기·크기 조절 ──────────────────────────────────
// 투명 창에서는 네이티브 리사이즈가 폭주해서 직접 잡는다 (다른 창들과 같은 방식).
// 처리기를 거는 순서는 nunsDrag 가 맡는다 — 크기를 물어보는 동안 손을 떼도 안 남게.
window.nunsDrag($('head'), async (e) => {
  if (e.target.closest('button')) return null;
  const sx = e.screenX;
  const sy = e.screenY;
  const b = await window.nunsseom.stocksBounds();
  if (!b) return null;
  const ox = b.x;
  const oy = b.y;
  return (ev) => window.nunsseom.stocksMove({ x: ox + (ev.screenX - sx), y: oy + (ev.screenY - sy) });
});

for (const g of document.querySelectorAll('.grip')) {
  window.nunsDrag(g, async (e) => {
    e.preventDefault();
    const dir = g.dataset.dir;
    const sx = e.screenX;
    const sy = e.screenY;
    const b = await window.nunsseom.stocksBounds();
    if (!b) return null;
    return (ev) => {
      const w = dir === 's' ? b.width : Math.max(300, b.width + (ev.screenX - sx));
      const h = dir === 'e' ? b.height : Math.max(260, b.height + (ev.screenY - sy));
      window.nunsseom.stocksSetBounds({
        x: b.x, y: b.y,
        width: Math.min(w, b.maxWidth || w),
        height: Math.min(h, b.maxHeight || h)
      });
    };
  });
}

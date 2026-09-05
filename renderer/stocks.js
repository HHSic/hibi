'use strict';
// 주식 창 — 관심 종목의 지금 값.
//
// 시세는 야후에서 오고 20분쯤 지연된다(머리글에 «몇 분 전»으로 적어 둔다).
// 값이 안 바뀌면 다시 그리지 않는다 — 매초 통째로 그리면 올려둔 마우스가 깜빡인다
// (메일 목록에서 실제로 그랬다).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const root = document.documentElement;
root.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const num = (k, d) => { const v = parseFloat(params.get(k)); return Number.isNaN(v) ? d : v; };
root.style.setProperty('--inset', num('inset', 12) + 'px');
root.style.setProperty('--r', num('radius', 18) + 'px');
root.style.setProperty('--scrim-a', String(Math.min(0.96, num('scrim', 0.88) + 0.04)));

let data = null;
let sig = '';

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

/** 값이 그대로면 다시 안 그린다 */
function sigOf(box) {
  if (!box) return 'none';
  return [
    box.market, box.indexes ? 'i' : '', box.loading ? 'L' : '', box.error || '', box.lagSec ?? '',
    (box.watch || []).length,
    ...box.rows.map((r) => `${r.ticker}:${r.price ?? '-'}:${r.pct == null ? '-' : r.pct.toFixed(2)}:${r.error || ''}`)
  ].join('|');
}

function paint() {
  const box = data;
  if (!box) return;
  for (const b of document.querySelectorAll('.seg[data-mk]')) {
    b.classList.toggle('on', b.dataset.mk === box.market);
  }
  $('idx').classList.toggle('on', !!box.indexes);
  $('krw').classList.toggle('on', !!box.krw);
  $('note').textContent = fmtLag(box);
  $('refresh').classList.toggle('spin', !!box.loading);

  const next = sigOf(box);
  if (next === sig) return;
  sig = next;

  const list = $('list');
  list.textContent = '';

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

    row.append(nm, px, pc);

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
    d.append('아직 관심 종목이 없습니다. 아래에 이름을 쳐보세요 — «삼성», «에코프», «엔비디아»처럼 일부만 쳐도 찾아줍니다.');
    d.append(document.createElement('br'));
    // 옆 프로젝트에 목록이 이미 있으면 한 번에 가져올 수 있게 — 가져온 뒤로는 서로 상관없다
    const imp = document.createElement('button');
    imp.className = 'mini ghost';
    imp.style.marginTop = '8px';
    imp.textContent = 'algo-trader에서 가져오기';
    imp.title = '그쪽 watchlist.json을 한 번 복사해 옵니다 (그 뒤로는 따로 관리됩니다)';
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
$('head').addEventListener('pointerdown', async (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  const b = await window.nunsseom.stocksBounds();
  if (!b) return;
  const sx = e.screenX;
  const sy = e.screenY;
  const ox = b.x;
  const oy = b.y;
  const move = (ev) => window.nunsseom.stocksMove({ x: ox + (ev.screenX - sx), y: oy + (ev.screenY - sy) });
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

for (const g of document.querySelectorAll('.grip')) {
  g.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const b = await window.nunsseom.stocksBounds();
    if (!b) return;
    const dir = g.dataset.dir;
    const sx = e.screenX;
    const sy = e.screenY;
    const move = (ev) => {
      const w = dir === 's' ? b.width : Math.max(300, b.width + (ev.screenX - sx));
      const h = dir === 'e' ? b.height : Math.max(260, b.height + (ev.screenY - sy));
      window.nunsseom.stocksSetBounds({
        x: b.x, y: b.y,
        width: Math.min(w, b.maxWidth || w),
        height: Math.min(h, b.maxHeight || h)
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

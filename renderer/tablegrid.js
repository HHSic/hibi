'use strict';
/* global module */
// 표 편집 — 칸 지도 셈. 쓰기 창의 표 편집(노션의 간단한 표처럼: 행·열 넣고 빼기, 칸 합치기·나누기, 배경색, 머리글)이 쓴다.
//
// 표는 합친 칸(rowspan·colspan)이 있으면 줄마다 칸 수가 달라서, «몇째 열»을 말하려면 먼저 칸 지도
// (어느 자리를 어느 칸이 차지하나)를 펴야 한다. 여기서는 DOM 을 만지지 않는다 — 글자로 된 표 꼴(줄마다 칸)을 받아
// 지도로 펴고(tidy), 셈을 하고, 바뀐 표 꼴과 커서 둘 자리를 돌려준다. 쓰기 창(compose.js)이 그것을 본문에 넣는다.
// 그래서 node 로 시험한다 (test/tablegrid.test.js). 쓰기 창에서는 window.nunsGrid 로 쓴다.
//
// 표 꼴 (tidy 의 답):
//   { attrs, caption: { attrs, html } | null, cols: [{ attrs }] | null (열마다 하나), secs: [{ tag, attrs }],
//     meta: [{ sec, attrs }] (줄마다), h, w, items: [{ tag, r, c, rs, cs, attrs, html }] (칸마다 — 차지한 자리의 왼쪽 위가 r,c) }
// 셈의 답: { model, focus: { r, c } } · 표를 지울 때 { gone: true } · 못 할 때 { refused: 까닭 } 또는 null
(function (root) {
  const HEAD_FILL = '#f1f1ef';      // 머리글 채움 — 팔레트의 회색
  // 배경색 — 노션의 옅은 채움
  const PALETTE = [
    { name: '기본', color: null }, { name: '회색', color: '#f1f1ef' }, { name: '갈색', color: '#f4eeee' },
    { name: '주황', color: '#fbecdd' }, { name: '노랑', color: '#fbf3db' }, { name: '초록', color: '#edf3ec' },
    { name: '파랑', color: '#e7f3f8' }, { name: '보라', color: '#f6f3f9' }, { name: '분홍', color: '#faf1f5' },
    { name: '빨강', color: '#fdebec' }
  ];
  const MIN_W = 40;                 // 열 너비 — 이보다 좁게는 안 한다
  const MAX_SPAN = 1000;            // 크로미움도 1000 에서 자른다

  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const num = (v) => { const n = parseInt(str(v), 10); return Number.isFinite(n) ? n : 0; };

  // ── style 글 ──────────────────────────────
  /** style 글 → [[이름, 값]] — 따옴표·괄호 안의 ; 는 안 자른다. 이름은 작은 글자로 */
  function decls(style) {
    const out = [];
    let cur = '';
    let q = '';
    let depth = 0;
    const push = () => {
      const i = cur.indexOf(':');
      if (i > 0) {
        const p = cur.slice(0, i).trim().toLowerCase();
        const v = cur.slice(i + 1).trim();
        if (p && v) out.push([p, v]);
      }
      cur = '';
    };
    for (const ch of str(style)) {
      if (q) { if (ch === q) q = ''; cur += ch; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0) { push(); continue; }
      cur += ch;
    }
    push();
    return out;
  }
  /** 그 이름의 값 (여럿이면 뒤의 것 — CSS 처럼) */
  function getDecl(style, prop) {
    const p = prop.toLowerCase();
    let v = '';
    for (const [k, x] of decls(style)) if (k === p) v = x;
    return v;
  }
  /** 그 이름을 다 떼고, 값이 있으면 맨 뒤에 하나 붙인다 */
  function setDecl(style, prop, value) {
    const p = prop.toLowerCase();
    const list = decls(style).filter(([k]) => k !== p);
    if (value) list.push([p, value]);
    return list.map(([k, v]) => `${k}:${v}`).join(';');
  }
  /** 칸 attrs 의 style 을 고친다 — 비면 style 속성을 뗀다 */
  function editStyle(attrs, prop, value) {
    const s = setDecl(attrs.style, prop, value);
    if (s) attrs.style = s; else delete attrs.style;
  }

  /** 색이 같은가 — #rgb·#rrggbb·rgb() 를 맞춰 본다 */
  function hex(v) {
    const s = str(v).trim().toLowerCase();
    let m = s.match(/^#([0-9a-f]{3})$/);
    if (m) return `#${m[1].replace(/./g, (c) => c + c)}`;
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*1(?:\.0*)?\s*)?\)$/);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    return s;
  }
  const bold = (it) => it.tag === 'th' || /^(bold|bolder|[6-9]00)$/.test(getDecl(it.attrs.style, 'font-weight').toLowerCase());
  /** 칸에 채움 색이 있나 — background-color·bgcolor (투명은 없는 것) */
  const fillOf = (attrs) => {
    const v = (getDecl(attrs.style, 'background-color') || str(attrs.bgcolor)).trim().toLowerCase();
    return v && v !== 'transparent' && v !== 'none' && !/^rgba\(.*,\s*0\s*\)$/.test(v) ? v : '';
  };
  /** 머리글 칸 꼴인가 — 굵게(th 는 원래 굵다) + 채움 (켤 때 넣는 회색, 또는 사용자가 칠한 색 — 칠한 색은 켤 때 덮지 않는다) */
  const headLook = (it) => bold(it) && !!fillOf(it.attrs);

  /** 머리글 표시를 뗀다 — 켤 때 넣은 것(굵게·회색 채움·bgcolor)만. 사용자가 칠한 색은 남는다 */
  function stripHead(attrs, tag) {
    if (tag !== 'th' && /^(bold|700)$/.test(getDecl(attrs.style, 'font-weight').toLowerCase())) editStyle(attrs, 'font-weight', null);
    if (hex(getDecl(attrs.style, 'background-color')) === HEAD_FILL) editStyle(attrs, 'background-color', null);
    if (hex(attrs.bgcolor) === HEAD_FILL) delete attrs.bgcolor;
  }
  /** 머리글 꼴을 넣는다 — 굵게, 채움이 없을 때만 회색 (칠해 둔 색을 덮으면 끌 때 되돌릴 수 없다) */
  function putHead(attrs, tag) {
    if (tag !== 'th') editStyle(attrs, 'font-weight', 'bold');
    if (fillOf(attrs)) return;
    editStyle(attrs, 'background-color', HEAD_FILL);
    attrs.bgcolor = HEAD_FILL;
  }

  /** 칸 글이 비었나 — <br>·빈칸·&nbsp; 뿐이면 비었다. 그림·표·줄은 글이 없어도 내용이다 */
  function hasContent(html) {
    const s = str(html);
    if (/<(img|table|hr|video|audio|iframe|object|embed|svg)\b/i.test(s)) return true;
    return /[^\s ]/.test(s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' '));
  }

  // ── 지도 ──────────────────────────────────
  const copyAttrs = (a) => ({ ...(a || {}) });
  const cloneItem = (it) => ({ ...it, attrs: copyAttrs(it.attrs) });
  function clone(m) {
    return {
      attrs: copyAttrs(m.attrs),
      caption: m.caption ? { attrs: copyAttrs(m.caption.attrs), html: m.caption.html } : null,
      cols: m.cols ? m.cols.map((c) => ({ attrs: copyAttrs(c.attrs) })) : null,
      secs: m.secs.map((s) => ({ tag: s.tag, attrs: copyAttrs(s.attrs) })),
      meta: m.meta.map((x) => ({ ...x, attrs: copyAttrs(x.attrs) })),
      h: m.h,
      w: m.w,
      items: m.items.map(cloneItem)
    };
  }
  const sortItems = (m) => { m.items.sort((a, b) => a.r - b.r || a.c - b.c); return m; };

  /** 자리마다 그 자리를 차지한 칸 — h×w 의 2차원 배열 (빈 자리는 null) */
  function cells(m) {
    const g = Array.from({ length: m.h }, () => new Array(m.w).fill(null));
    for (const it of m.items) {
      for (let r = it.r; r < it.r + it.rs && r < m.h; r++) for (let c = it.c; c < it.c + it.cs && c < m.w; c++) g[r][c] = it;
    }
    return g;
  }

  /** 넓이 속성(px) — width 속성 또는 style 의 width:Npx */
  function widthOf(attrs) {
    const a = str(attrs && attrs.width).trim().match(/^(\d+)(px)?$/i);
    if (a) return Number(a[1]);
    const s = getDecl(attrs && attrs.style, 'width').match(/^(\d+(?:\.\d+)?)px$/i);
    return s ? Math.round(Number(s[1])) : 0;
  }
  /** 열마다 너비 — COL 이 있으면 COL, 없으면 그 열의 1칸짜리 칸 가운데 너비가 적힌 첫 칸. 모르면 0 */
  function colWidths(m) {
    return Array.from({ length: m.w }, (_, c) => {
      const col = m.cols && m.cols[c] ? widthOf({ width: m.cols[c].attrs.width }) : 0;
      if (col) return col;
      for (const it of m.items) if (it.c === c && it.cs === 1) { const w = widthOf(it.attrs); if (w) return w; }
      return 0;
    });
  }

  /** 새 빈 칸의 속성 — src 의 스타일을 따르되, 너비는 그 열(col) 것으로 (src 가 여러 열을 합친 칸이거나 다른 열이면) */
  function blankAttrs(src, col, m, widths) {
    const a = copyAttrs(src && src.attrs);
    if (src && (src.cs !== 1 || src.c !== col)) {
      const w = (widths || colWidths(m))[col] || 0;
      if (w) {
        if ('width' in a) a.width = String(w);
        if (getDecl(a.style, 'width')) editStyle(a, 'width', `${w}px`);
      } else {
        delete a.width;
        if (getDecl(a.style, 'width')) editStyle(a, 'width', null);
      }
    }
    return a;
  }

  /**
   * 읽은 표(줄마다 칸) → 지도. 브라우저가 표를 그리는 차례대로 놓는다:
   *   · 칸은 줄의 비어 있는 다음 자리부터. rowspan 은 구역(thead·tbody·tfoot) 끝에서 자르고, 0 이면 구역 끝까지
   *   · 겹치는 합침(아래 줄 칸의 colspan 이 위에서 내려온 칸 자리를 덮는 것)은 차지한 자리 앞에서 자른다
   *   · 들쭉날쭉한 줄의 빈 자리는 빈 칸으로 채운다 (왼쪽·위 칸의 스타일) — 지도는 늘 네모
   * raw: { attrs, caption, cols, secs, rows: [{ sec, attrs, ref?, cells: [{ tag, rs, cs, attrs, html, ref? }] }] }
   * ref 는 그대로 따라간다 (쓰기 창이 본문 칸을 찾을 때 쓴다 — HTML 에는 안 나간다)
   */
  function tidy(raw) {
    const R = raw || {};
    const secs = (R.secs && R.secs.length ? R.secs : [{ tag: 'tbody', attrs: {} }])
      .map((s) => ({ tag: /^(thead|tbody|tfoot)$/.test(s.tag) ? s.tag : 'tbody', attrs: copyAttrs(s.attrs) }));
    const rows = R.rows || [];
    const h = rows.length;
    const meta = rows.map((row) => {
      const x = { sec: Math.min(Math.max(num(row.sec), 0), secs.length - 1), attrs: copyAttrs(row.attrs) };
      if (row.ref) x.ref = row.ref;
      return x;
    });
    // 줄마다 그 구역이 끝나는 줄 (rowspan 이 넘지 못한다)
    const end = new Array(h);
    for (let r = h - 1; r >= 0; r--) end[r] = r + 1 < h && meta[r + 1].sec === meta[r].sec ? end[r + 1] : r + 1;
    const taken = Array.from({ length: h }, () => []);
    const items = [];
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row.cells || []) {
        while (taken[r][c]) c++;
        let rs = num(cell.rs);
        if (rs < 1) rs = end[r] - r;
        rs = Math.min(rs, end[r] - r, MAX_SPAN);
        let cs = Math.min(Math.max(num(cell.cs), 1), MAX_SPAN);
        for (let k = 1; k < rs; k++) if (taken[r + k][c]) { rs = k; break; }
        for (let k = 1; k < cs; k++) {
          let hit = false;
          for (let j = 0; j < rs; j++) if (taken[r + j][c + k]) hit = true;
          if (hit) { cs = k; break; }
        }
        for (let j = 0; j < rs; j++) for (let k = 0; k < cs; k++) taken[r + j][c + k] = true;
        const it = { tag: str(cell.tag).toLowerCase() === 'th' ? 'th' : 'td', r, c, rs, cs, attrs: copyAttrs(cell.attrs), html: str(cell.html) };
        if (cell.ref) it.ref = cell.ref;
        items.push(it);
        c += cs;
      }
    });
    const w = taken.reduce((n, t) => Math.max(n, t.length), 0);
    const m = { attrs: copyAttrs(R.attrs), caption: R.caption ? { attrs: copyAttrs(R.caption.attrs), html: str(R.caption.html) } : null, cols: null, secs, meta, h, w, items };
    // 들쭉날쭉한 줄 — 빈 자리를 채운다
    let g = null;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (taken[r][c]) continue;
        if (!g) g = cells(m);
        const src = (c > 0 && g[r][c - 1]) || (r > 0 && g[r - 1][c]) || null;
        const it = { tag: src ? src.tag : 'td', r, c, rs: 1, cs: 1, attrs: src ? blankAttrs(src, c, m) : {}, html: '' };
        items.push(it);
        g[r][c] = it;
      }
    }
    if (R.cols && R.cols.length && w) m.cols = Array.from({ length: w }, (_, c) => ({ attrs: copyAttrs(R.cols[c] && R.cols[c].attrs) }));
    return sortItems(m);
  }

  /** 지도가 바른가 — 자리마다 칸 하나, 칸은 표 안, 합침은 1 이상, rowspan 은 제 구역 안 */
  function check(m) {
    const seen = Array.from({ length: m.h }, () => new Array(m.w).fill(0));
    for (const it of m.items) {
      if (!(it.rs >= 1 && it.cs >= 1)) return { ok: false, why: `합침이 1보다 작다 ${it.r},${it.c}` };
      if (it.r < 0 || it.c < 0 || it.r + it.rs > m.h || it.c + it.cs > m.w) return { ok: false, why: `표 밖 ${it.r},${it.c} ${it.rs}x${it.cs}` };
      for (let r = it.r; r < it.r + it.rs; r++) {
        if (m.meta[r].sec !== m.meta[it.r].sec) return { ok: false, why: `구역을 넘는 rowspan ${it.r},${it.c}` };
        for (let c = it.c; c < it.c + it.cs; c++) seen[r][c] += 1;
      }
    }
    for (let r = 0; r < m.h; r++) for (let c = 0; c < m.w; c++) if (seen[r][c] !== 1) return { ok: false, why: `자리 ${r},${c} 를 ${seen[r][c]}칸이 차지` };
    if (m.meta.length !== m.h) return { ok: false, why: '줄 정보 수가 다르다' };
    if (m.cols && m.cols.length !== m.w) return { ok: false, why: 'COL 수가 다르다' };
    return { ok: true };
  }

  /** 고른 네모를 걸친 합친 칸이 다 들어갈 때까지 넓힌다 */
  function expand(m, rect) {
    let { r0, c0, r1, c1 } = rect;
    for (let again = true; again;) {
      again = false;
      for (const it of m.items) {
        const er = it.r + it.rs - 1;
        const ec = it.c + it.cs - 1;
        if (it.r > r1 || er < r0 || it.c > c1 || ec < c0) continue;
        if (it.r < r0 || er > r1 || it.c < c0 || ec > c1) {
          r0 = Math.min(r0, it.r); r1 = Math.max(r1, er); c0 = Math.min(c0, it.c); c1 = Math.max(c1, ec);
          again = true;
        }
      }
    }
    return { r0, c0, r1, c1 };
  }
  const inRect = (it, R) => it.r <= R.r1 && it.r + it.rs - 1 >= R.r0 && it.c <= R.c1 && it.c + it.cs - 1 >= R.c0;
  const clampRect = (m, R) => ({
    r0: Math.max(0, Math.min(R.r0, R.r1)), c0: Math.max(0, Math.min(R.c0, R.c1)),
    r1: Math.min(m.h - 1, Math.max(R.r0, R.r1)), c1: Math.min(m.w - 1, Math.max(R.c0, R.c1))
  });

  /**
   * 칸이 하나도 시작하지 않는 줄·열을 없앤다 — 지나가던 합친 칸은 준다. 없앤 열의 COL 너비는 왼쪽 열에 더한다
   * (extra — 열 사이의 칸 여백·선. 합치기가 주면 그만큼 더해 보이는 너비를 지킨다)
   */
  function normalize(m, extra = 0) {
    for (let r = m.h - 1; r >= 0; r--) {
      if (m.items.some((it) => it.r === r)) continue;
      for (const it of m.items) {
        if (it.r < r && it.r + it.rs > r) it.rs -= 1;
        else if (it.r > r) it.r -= 1;
      }
      m.meta.splice(r, 1);
      m.h -= 1;
    }
    for (let c = m.w - 1; c >= 0; c--) {
      if (m.items.some((it) => it.c === c)) continue;
      for (const it of m.items) {
        if (it.c < c && it.c + it.cs > c) it.cs -= 1;
        else if (it.c > c) it.c -= 1;
      }
      if (m.cols) {
        const wd = num(m.cols[c].attrs.width);
        const left = c > 0 ? m.cols[c - 1] : null;
        if (left && wd && num(left.attrs.width)) left.attrs.width = String(num(left.attrs.width) + wd + extra);
        m.cols.splice(c, 1);
      }
      m.w -= 1;
    }
    return m;
  }

  /** 새 줄에서 칸이 시작하는 첫 열 (그 줄이 다 합친 칸으로 덮였으면 0) */
  function firstCol(m, r) {
    let c = Infinity;
    for (const it of m.items) if (it.r === r) c = Math.min(c, it.c);
    return Number.isFinite(c) ? c : 0;
  }
  const fit = (n, max) => Math.max(0, Math.min(n, max - 1));

  // ── 셈 ────────────────────────────────────
  /**
   * 줄 넣기 — 줄 ref 의 위(above)·아래(below). 합친 칸을 지나는 자리는 그 칸을 늘리고(그 열에는 새 칸이 없다),
   * 나머지 열에는 ref 줄의 같은 열 칸의 스타일을 따른 빈 칸 (내용은 아니다).
   * 머리글 줄 아래에 넣으면 머리글 채움은 빼고, 머리글 줄 위에 넣으면 새 첫 줄이 머리글이 된다 (머리글은 첫 줄이다).
   * thead 의 마지막 줄 아래는 다음 구역(tbody)의 td 줄로.
   * opt.c — 커서를 둘 열 (없으면 새 줄의 첫 칸)
   */
  function insertRow(m0, ref, where, opt = {}) {
    if (!m0.h) return null;
    const m = clone(m0);
    const r = fit(ref, m.h);
    const i = where === 'above' ? r : r + 1;
    const g = cells(m0);
    const widths = colWidths(m0);
    const head = r === 0 && headerOnRaw(m0, 'row');
    const headCol = headerOnRaw(m0, 'col');   // 머리글 열도 켜져 있으면 첫 열 칸은 머리글 꼴 그대로 (insertCol 과 같다)
    let sec = m.meta[r].sec;
    let toBody = false;
    if (where !== 'above' && m.secs[sec].tag === 'thead' && (i >= m.h || m.meta[i].sec !== sec)) {
      const next = m.meta.find((x, k) => k > r && x.sec !== sec);
      if (next) { sec = next.sec; toBody = true; }
    }
    const grown = new Set();
    for (const it of m.items) {
      if (!toBody && it.r < i && it.r + it.rs > i) { it.rs += 1; for (let c = it.c; c < it.c + it.cs; c++) grown.add(c); }
      else if (it.r >= i) it.r += 1;
    }
    for (let c = 0; c < m.w; c++) {
      if (grown.has(c)) continue;
      const src = g[r][c];
      const attrs = blankAttrs(src, c, m0, widths);
      const tag = toBody ? 'td' : src.tag;
      if (((head && where !== 'above') || toBody) && !(headCol && c === 0)) stripHead(attrs, src.tag);
      if (headCol && c === 0 && !headLook({ tag, attrs })) putHead(attrs, tag);
      m.items.push({ tag, r: i, c, rs: 1, cs: 1, attrs, html: '' });
    }
    m.meta.splice(i, 0, { sec, attrs: copyAttrs(m0.meta[r].attrs) });
    m.h += 1;
    // 머리글 줄 위 — 머리글 꼴은 새 첫 줄이 받고, 옛 첫 줄(이제 둘째 줄)은 뗀다 (머리글 열의 첫 칸은 그대로)
    if (head && where === 'above') for (const it of m.items) if (it.r === 1 && !(headCol && it.c === 0)) stripHead(it.attrs, it.tag);
    sortItems(m);
    return { model: m, focus: { r: i, c: opt.c === undefined ? firstCol(m, i) : fit(opt.c, m.w) } };
  }

  /** 열 넣기 — insertRow 와 같은 규칙. COL 도 이웃 너비로 하나. opt.room·opt.extra 를 주면 종이보다 넓어질 때 열 너비를 줄인다 */
  function insertCol(m0, ref, where, opt = {}) {
    if (!m0.w) return null;
    const m = clone(m0);
    const c = fit(ref, m.w);
    const j = where === 'left' ? c : c + 1;
    const g = cells(m0);
    const head = c === 0 && headerOnRaw(m0, 'col');
    const headRow = headerOnRaw(m0, 'row');
    const grown = new Set();
    for (const it of m.items) {
      if (it.c < j && it.c + it.cs > j) { it.cs += 1; for (let r = it.r; r < it.r + it.rs; r++) grown.add(r); }
      else if (it.c >= j) it.c += 1;
    }
    for (let r = 0; r < m.h; r++) {
      if (grown.has(r)) continue;
      const src = g[r][c];
      const attrs = copyAttrs(src.attrs);
      if (src.cs !== 1) { delete attrs.width; if (getDecl(attrs.style, 'width')) editStyle(attrs, 'width', null); }
      if (head && where !== 'left' && !(headRow && r === 0)) stripHead(attrs, src.tag);
      m.items.push({ tag: src.tag, r, c: j, rs: 1, cs: 1, attrs, html: '' });
    }
    if (m.cols) m.cols.splice(j, 0, { attrs: copyAttrs(m0.cols[c].attrs) });
    m.w += 1;
    if (head && where === 'left') for (const it of m.items) if (it.c === 1 && !(headRow && it.r === 0)) stripHead(it.attrs, it.tag);
    sortItems(m);
    let out = m;
    if (opt.room > 0) {
      const ws = colWidths(m);
      if (ws.every((x) => x > 0)) {
        const fitted = fitWidths(ws, opt.room, opt.extra || 0);
        if (fitted.some((x, k) => x !== ws[k])) out = resize(m, fitted).model;
      }
    }
    return { model: out, focus: { r: opt.r === undefined ? 0 : fit(opt.r, out.h), c: j } };
  }

  /** 줄 지우기 — 거기서 시작한 rowspan 칸은 다음 줄로 내려가며 하나 준다, 지나가는 칸은 준다. 마지막 줄이면 표를 지운다 */
  function deleteRow(m0, ref, opt = {}) {
    if (m0.h <= 1) return { gone: true };
    const m = clone(m0);
    const r = fit(ref, m.h);
    m.items = m.items.filter((it) => {
      if (it.r === r) { if (it.rs > 1) { it.rs -= 1; return true; } return false; }
      if (it.r < r && it.r + it.rs > r) it.rs -= 1;
      else if (it.r > r) it.r -= 1;
      return true;
    });
    m.meta.splice(r, 1);
    m.h -= 1;
    normalize(m);
    sortItems(m);
    if (!m.h || !m.w) return { gone: true };
    return { model: m, focus: { r: fit(r, m.h), c: fit(opt.c || 0, m.w) } };
  }

  /** 열 지우기 — colspan 이 준다, COL 도 빠진다. 마지막 열이면 표를 지운다 */
  function deleteCol(m0, ref, opt = {}) {
    if (m0.w <= 1) return { gone: true };
    const m = clone(m0);
    const c = fit(ref, m.w);
    m.items = m.items.filter((it) => {
      if (it.c === c) { if (it.cs > 1) { it.cs -= 1; return true; } return false; }
      if (it.c < c && it.c + it.cs > c) it.cs -= 1;
      else if (it.c > c) it.c -= 1;
      return true;
    });
    if (m.cols) m.cols.splice(c, 1);
    m.w -= 1;
    normalize(m);
    sortItems(m);
    if (!m.h || !m.w) return { gone: true };
    return { model: m, focus: { r: fit(opt.r || 0, m.h), c: fit(c, m.w) } };
  }

  /** 줄 복제 — 바로 아래에 내용·스타일째. 경계를 지나는 합친 칸은 늘리고, 그 줄에서 끝나는 칸은 1줄짜리로 복제 */
  function duplicateRow(m0, ref, opt = {}) {
    if (!m0.h) return null;
    const m = clone(m0);
    const r = fit(ref, m.h);
    const add = [];
    for (const it of m.items) {
      const last = it.r + it.rs - 1;
      if (it.r <= r && last > r) it.rs += 1;
      else if (it.r > r) it.r += 1;
      else if (last === r) add.push({ ...cloneItem(it), r: r + 1, rs: 1 });
    }
    m.items.push(...add);
    m.meta.splice(r + 1, 0, { sec: m0.meta[r].sec, attrs: copyAttrs(m0.meta[r].attrs) });
    m.h += 1;
    sortItems(m);
    return { model: m, focus: { r: r + 1, c: fit(opt.c || 0, m.w) } };
  }

  /** 열 복제 — duplicateRow 와 같은 규칙. COL 도 */
  function duplicateCol(m0, ref, opt = {}) {
    if (!m0.w) return null;
    const m = clone(m0);
    const c = fit(ref, m.w);
    const add = [];
    for (const it of m.items) {
      const last = it.c + it.cs - 1;
      if (it.c <= c && last > c) it.cs += 1;
      else if (it.c > c) it.c += 1;
      else if (last === c) {
        const x = { ...cloneItem(it), c: c + 1, cs: 1 };
        if (it.cs !== 1) x.attrs = blankAttrs(it, c, m0);
        add.push(x);
      }
    }
    m.items.push(...add);
    if (m.cols) m.cols.splice(c + 1, 0, { attrs: copyAttrs(m0.cols[c].attrs) });
    m.w += 1;
    sortItems(m);
    return { model: m, focus: { r: fit(opt.r || 0, m.h), c: c + 1 } };
  }

  /** 합칠 수 있나 — 넓힌 네모에 칸이 둘 이상, 한 구역 안. { ok, why: 'one' | 'section', rect } */
  function canMerge(m, rect) {
    if (!m.h || !m.w) return { ok: false, why: 'one' };
    const R = expand(m, clampRect(m, rect));
    const inside = m.items.filter((it) => inRect(it, R));
    if (inside.length < 2) return { ok: false, why: 'one', rect: R };
    for (let r = R.r0; r <= R.r1; r++) if (m.meta[r].sec !== m.meta[R.r0].sec) return { ok: false, why: 'section', rect: R };
    return { ok: true, rect: R };
  }

  /** 칸 attrs 의 너비를 w(px)로 — width 속성·style 의 width 가운데 적혀 있던 것만 고친다. w 가 0 이면 둘 다 뗀다 */
  function setWidth(attrs, w) {
    if (w > 0) {
      if ('width' in attrs) attrs.width = String(w);
      if (getDecl(attrs.style, 'width')) editStyle(attrs, 'width', `${w}px`);
    } else {
      delete attrs.width;
      if (getDecl(attrs.style, 'width')) editStyle(attrs, 'width', null);
    }
  }

  /**
   * 칸 합치기 — 넓힌 네모의 왼쪽 위 칸이 rowspan·colspan 을 받고, 다른 칸의 글(빈 칸은 뺀다)을 <br> 로 이어 붙인다.
   * 스타일은 왼쪽 위 칸 것. 그 뒤 칸이 하나도 시작하지 않는 줄·열을 없앤다 (normalize).
   * 너비 — 열을 통째로 합쳐 한 열이 되면 합친 열 너비의 합(+ 사이 여백·선 opt.extra)을, 열이 남아 colspan 이면 너비를 뗀다
   * (왼쪽 위 칸의 낡은 너비가 남으면 표가 좁아지거나 엔진마다 열 너비가 엇갈린다 — resize 와 같은 규칙)
   */
  function merge(m0, rect, opt = {}) {
    const can = canMerge(m0, rect);
    if (!can.ok) return { refused: can.why };
    const R = can.rect;
    const extra = Math.max(0, Number(opt.extra) || 0);
    const w0 = colWidths(m0);
    const m = clone(m0);
    const inside = m.items.filter((it) => inRect(it, R));
    const head = inside.find((it) => it.r === R.r0 && it.c === R.c0);
    const parts = inside.filter((it) => hasContent(it.html)).map((it) => it.html);
    head.html = parts.join('<br>');
    head.rs = R.r1 - R.r0 + 1;
    head.cs = R.c1 - R.c0 + 1;
    m.items = m.items.filter((it) => it === head || !inRect(it, R));
    normalize(m, extra);
    if (R.c1 > R.c0) {
      const ws = w0.slice(R.c0, R.c1 + 1);
      if (head.cs > 1) setWidth(head.attrs, 0);
      else setWidth(head.attrs, ws.every((x) => x > 0) ? ws.reduce((a, b) => a + b, 0) + extra * (ws.length - 1) : 0);
    }
    sortItems(m);
    return { model: m, focus: { r: head.r, c: head.c } };
  }

  /** 칸 나누기 — 합친 칸을 1×1 로. 덮였던 자리에는 그 칸의 스타일을 따른 빈 칸, 글은 왼쪽 위에. 안 합친 칸이면 null */
  function split(m0, r, c) {
    const it0 = m0.items.find((it) => it.r === r && it.c === c);
    if (!it0 || (it0.rs === 1 && it0.cs === 1)) return null;
    const m = clone(m0);
    const widths = colWidths(m0);
    const it = m.items.find((x) => x.r === r && x.c === c);
    for (let rr = r; rr < r + it0.rs; rr++) {
      for (let cc = c; cc < c + it0.cs; cc++) {
        if (rr === r && cc === c) continue;
        m.items.push({ tag: it0.tag, r: rr, c: cc, rs: 1, cs: 1, attrs: blankAttrs(it0, cc, m0, widths), html: '' });
      }
    }
    it.rs = 1;
    it.cs = 1;
    if (it0.cs !== 1) it.attrs = blankAttrs(it0, c, m0, widths);
    sortItems(m);
    return { model: m, focus: { r, c } };
  }

  /** 네모에 걸친 칸들의 글을 비운다 — 구조는 그대로 (빈 칸은 HTML 에서 <br>) */
  function clear(m0, rect) {
    const m = clone(m0);
    const R = clampRect(m, rect);
    for (const it of m.items) if (inRect(it, R)) it.html = '';
    return { model: m, focus: { r: R.r0, c: R.c0 } };
  }

  /** 배경색 — background-color 와 bgcolor(아웃룩). null(기본)이면 둘 다 (background 줄임말 색까지) 뗀다 */
  function paint(m0, rect, color) {
    const m = clone(m0);
    const R = clampRect(m, rect);
    for (const it of m.items) {
      if (!inRect(it, R)) continue;
      editStyle(it.attrs, 'background', null);
      editStyle(it.attrs, 'background-color', color || null);
      if (color) it.attrs.bgcolor = color; else delete it.attrs.bgcolor;
    }
    return { model: m, focus: { r: R.r0, c: R.c0 } };
  }

  function headerOnRaw(m, kind) {
    const list = m.items.filter((it) => (kind === 'col' ? it.c === 0 : it.r === 0));
    return list.length > 0 && list.every(headLook);
  }
  /** 머리글이 켜졌나 — 첫 줄(kind 'row') 또는 첫 열('col')의 칸이 다 굵게 + 회색 */
  const headerOn = (m, kind) => headerOnRaw(m, kind);

  /** 머리글 켜고 끄기 — 첫 줄(또는 첫 열)에 굵게 + 회색 채움(+ bgcolor)을 넣거나, 그것만 뗀다 */
  function header(m0, kind, on) {
    const m = clone(m0);
    for (const it of m.items) {
      if (kind === 'col' ? it.c !== 0 : it.r !== 0) continue;
      if (on) putHead(it.attrs, it.tag); else stripHead(it.attrs, it.tag);
    }
    return { model: m, focus: { r: 0, c: 0 } };
  }

  /** 열 너비를 종이(room) 안으로 — 칸마다 안쪽 여백·테두리(extra)를 더한 합이 room 을 넘으면 같은 비율로 줄인다 (40px 아래로는 안 간다) */
  function fitWidths(widths, room, extra = 0, min = MIN_W) {
    const total = widths.reduce((a, b) => a + b, 0);
    const avail = room - extra * widths.length;
    if (total <= avail) return widths.slice();
    const k = avail / total;
    return widths.map((x) => Math.max(min, Math.floor(x * k)));
  }

  /**
   * 열 너비를 적는다 — COL 이 있으면 COL 에, 그 열의 1칸짜리 칸마다 width 속성 + style (받는 사람도 보게).
   * 여러 열을 합친 칸은 너비를 뗀다 (열 너비가 정한다). 표의 너비(px·%)도 뗀다
   */
  function resize(m0, widths) {
    const m = clone(m0);
    const ws = Array.from({ length: m.w }, (_, c) => Math.max(MIN_W, Math.round(Number(widths[c]) || 0)));
    if (m.cols) m.cols.forEach((col, c) => { col.attrs.width = String(ws[c]); });
    for (const it of m.items) {
      if (it.cs === 1) {
        it.attrs.width = String(ws[it.c]);
        editStyle(it.attrs, 'width', `${ws[it.c]}px`);
      } else {
        delete it.attrs.width;
        if (getDecl(it.attrs.style, 'width')) editStyle(it.attrs, 'width', null);
      }
    }
    delete m.attrs.width;
    if (getDecl(m.attrs.style, 'width')) editStyle(m.attrs, 'width', null);
    return { model: m, focus: null };
  }

  /** Tab 차례 — 줄 차례로 칸마다 한 번 (합친 칸이 덮은 자리는 건너뛴다) */
  const order = (m) => m.items.slice().sort((a, b) => a.r - b.r || a.c - b.c);

  // ── HTML ──────────────────────────────────
  const esc = (v) => str(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 속성 이름 — 글자로 시작하는 보통 이름만, on* (실행되는 것)은 안 쓴다
  const NAME = /^[a-z][a-z0-9_.:-]*$/i;
  const attrText = (a) => Object.entries(a || {}).filter(([k]) => NAME.test(k) && !/^on/i.test(k)).map(([k, v]) => ` ${k.toLowerCase()}="${esc(v)}"`).join('');

  /** 표 꼴 → HTML. 빈 칸은 <br> (커서가 들어가고 줄 높이가 산다). extra 는 표 속성 맨 앞에 (쓰기 창이 새 표를 찾는 표식) */
  function toHtml(m, extra) {
    let s = `<table${attrText({ ...(extra || {}), ...m.attrs })}>`;
    if (m.caption) s += `<caption${attrText(m.caption.attrs)}>${m.caption.html}</caption>`;
    if (m.cols && m.cols.length) s += `<colgroup>${m.cols.map((c) => `<col${attrText(c.attrs)}>`).join('')}</colgroup>`;
    const byRow = Array.from({ length: m.h }, () => []);
    for (const it of order(m)) if (byRow[it.r]) byRow[it.r].push(it);
    let r = 0;
    while (r < m.h) {
      const sec = m.meta[r].sec;
      const st = m.secs[sec] || { tag: 'tbody', attrs: {} };
      s += `<${st.tag}${attrText(st.attrs)}>`;
      for (; r < m.h && m.meta[r].sec === sec; r++) {
        s += `<tr${attrText(m.meta[r].attrs)}>`;
        for (const it of byRow[r]) {
          const span = `${it.rs > 1 ? ` rowspan="${it.rs}"` : ''}${it.cs > 1 ? ` colspan="${it.cs}"` : ''}`;
          s += `<${it.tag}${span}${attrText(it.attrs)}>${it.html || '<br>'}</${it.tag}>`;
        }
        s += '</tr>';
      }
      s += `</${st.tag}>`;
    }
    return `${s}</table>`;
  }

  const api = {
    HEAD_FILL, PALETTE, MIN_W,
    tidy, cells, check, expand, canMerge, toHtml, order, colWidths, fitWidths, headerOn, hasContent,
    insertRow, insertCol, deleteRow, deleteCol, duplicateRow, duplicateCol, merge, split, clear, paint, header, resize,
    getDecl, setDecl
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object' && root.document) root.nunsGrid = api;
})(typeof window !== 'undefined' ? window : globalThis);

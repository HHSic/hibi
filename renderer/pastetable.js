'use strict';
/* global module */
// 본문에 표 붙여넣기 — 엑셀·구글 시트·워드·한글·웹 페이지에서 복사한 표를 «표로» 넣는다.
//
// 예전엔 표를 붙이면 탭으로 이은 글만 들어갔다. 그렇다고 클립보드의 HTML 을 그대로 넣으면 남의 class·글꼴·
// mso-* 스타일과 바깥 그림 주소까지 딸려 와 메일이 깨지고, 바깥 주소는 열어 본 사실을 흘린다.
// 그래서 허락한 태그·속성·스타일만 «맞춘 꼴로» 새로 짓는다 (인용문의 quoteInto 와 같은 방식):
//   · 클립보드 HTML 은 DOMParser 로 읽기만 한다 — 스크립트가 돌지 않고, 그림·스타일시트를 받아오지 않는다
//   · 엑셀·리브레오피스는 <style> 의 class 규칙(.xl65{…})에, 구글 시트·워드·한글은 인라인 style 에 서식을 둔다.
//     <style> 은 new CSSStyleSheet().replaceSync 로 읽고(어디에도 붙이지 않으니 아무것도 받아오지 않는다),
//     element.matches 로 맞는 규칙을 차례대로 입힌 뒤 인라인 style 을 위에 얹는다
//   · 나가는 것은 정해 둔 것뿐 — 색은 #hex·rgb()·rgba()·이름, 길이는 px, 테두리는 1~3px solid/dashed/dotted/double
//   · 메일 프로그램은 이 창의 CSS 를 모른다 — 보일 것은 전부 칸마다 인라인으로 (아웃룩이 보는 속성도 같이)
//
// 글자만 다루는 셈은 node 로도 시험한다 (test/tablepure.test.js). DOM 을 다시 짓는 build 는 쓰기 창에서 돈다
// (test/tablepaste.test.js). 쓰기 창에서는 window.nunsTable 로 쓴다.
(function (root) {
  const MAX_CELLS = 2000;            // 이보다 칸이 많으면 표 대신 글로 — 편집이 굳고 메일도 무거워진다
  const MAX_HTML = 1000000;          // 다듬은 HTML 이 이보다 길어도 글로
  // 옅은 회색 선 하나 — 테두리 없는 붙인 표와 «표» 단추로 넣는 새 표(blank)가 같이 쓴다 (노션의 표 선 언저리)
  const LINE = '#dcdcd9';
  const GRID = `1px solid ${LINE}`;  // 테두리가 하나도 없는 표 — 엑셀 격자선은 테두리가 아니라 복사에 안 온다
  const GRID_ATTR = '1px solid #808080';   // 칸 테두리는 없고 <table border="1"> 인 표 — 브라우저가 그리는 회색 선
  const PAD = '4px 8px';
  const NEW_PAD = '6px 10px';        // 새 표의 안쪽 여백 — 노션처럼 조금 넉넉하게 (붙인 표는 엑셀처럼 촘촘한 PAD)
  const COL_W = 120;                 // 새 표의 열 너비 (px) — 받는 사람도 같은 너비로 본다
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const XHTML = 'http://www.w3.org/1999/xhtml';

  // 바깥을 부르거나 실행되는 값 — 이런 것이 든 선언은 통째로 버린다. \ 는 CSS 이스케이프(\75 rl( = url()로 숨길 수 있어서,
  // 눈에 안 보이는 글자(제어·폭 없는 글자)는 낱말을 쪼개 숨길 수 있어서 같이 막는다
  const RISKY = /url\s*\(|expression\s*\(|behavior|javascript\s*:|vbscript\s*:|-moz-binding|@import|\\|[\u0000-\u0008\u000b\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/i;
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const risky = (v) => RISKY.test(str(v));
  /** 낱말 값 — 앞뒤 빈칸·따옴표를 떼고 작은 글자로 (한글은 font-weight:"bold" 처럼 따옴표를 친다) */
  const kw = (v) => str(v).trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase();

  /**
   * style 글 → [[이름, 값], …]. 따옴표·괄호 안의 ; 는 안 자른다. !important 는 뗀다.
   * 바깥을 부르는 것(url·expression·behavior·javascript: …)이 든 선언은 통째로 버린다.
   */
  function parseDecls(text) {
    const s = str(text).replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
    const out = [];
    let cur = '';
    let q = '';
    let depth = 0;
    const push = () => {
      const i = cur.indexOf(':');
      if (i > 0) {
        const p = cur.slice(0, i).trim().toLowerCase();
        const v = cur.slice(i + 1).replace(/!\s*important\s*$/i, '').trim();
        if (/^-?[a-z][a-z0-9-]*$/.test(p) && v && !risky(p) && !risky(v)) out.push([p, v]);
      }
      cur = '';
    };
    for (const ch of s) {
      if (q) {
        if (ch === q) q = '';
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0) { push(); continue; }
      cur += ch;
    }
    push();
    return out;
  }

  /** 값을 빈칸으로 나눈다 — 괄호 안(rgb(1, 2, 3))은 안 자른다 */
  function tokens(v) {
    const out = [];
    let cur = '';
    let depth = 0;
    for (const ch of str(v)) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (/\s/.test(ch) && depth === 0) {
        if (cur) out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  const STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
  const isWidth = (t) => /^(\d*\.?\d+)(px|pt|pc|in|cm|mm|em|rem)?$/.test(t) || /^(thin|medium|thick)$/.test(t);

  /** border 줄임말 한 변 — 순서는 아무래도 된다 (워드는 «solid windowtext 1.0pt»). 빠진 것은 CSS 처음값 */
  function borderBits(v) {
    const b = { width: 'medium', style: 'none', color: '' };
    for (const t of tokens(v)) {
      const k = t.toLowerCase();
      if (STYLES.has(k)) b.style = k;
      else if (isWidth(k)) b.width = k;
      else b.color = t;
    }
    return b;
  }

  // background 줄임말에 오는 낱말 중 색 이름처럼 생긴 것
  const BG_WORDS = new Set(['repeat', 'scroll', 'fixed', 'local', 'top', 'bottom', 'left', 'right', 'center', 'cover', 'contain',
    'space', 'round', 'border', 'padding', 'content', 'text', 'auto', 'none']);

  /** 1~4값 줄임말 → 위·오른쪽·아래·왼쪽 */
  const box = (vals) => {
    const [a, b = a, c = a, d = b] = vals;
    return [a, b, c, d];
  };

  /**
   * style 글 → 낱낱의 이름(longhand)과 값. <style> 규칙은 CSSOM 이 이미 펴서 주므로 같은 꼴로 맞춘다:
   * border·border-변·border-width/style/color, background(색만), text-decoration(→ -line), white-space(→ text-wrap-mode)
   */
  function declsOf(text) {
    const m = {};
    const side = (s, b) => {
      m[`border-${s}-width`] = b.width;
      m[`border-${s}-style`] = b.style;
      m[`border-${s}-color`] = b.color;
    };
    for (const [p, v] of parseDecls(text)) {
      let x;
      if (p === 'border') {
        const b = borderBits(v);
        for (const s of SIDES) side(s, b);
      } else if ((x = p.match(/^border-(top|right|bottom|left)$/))) {
        side(x[1], borderBits(v));
      } else if ((x = p.match(/^border-(width|style|color)$/))) {
        const vals = box(tokens(v));
        SIDES.forEach((s, i) => { m[`border-${s}-${x[1]}`] = vals[i]; });
      } else if (p === 'background') {
        // 줄임말은 빠진 것을 처음값으로 되돌린다 — 색이 없으면 투명. repeat·center 같은 낱말은 색이 아니다
        const ts = tokens(v);
        m['background-color'] = ts.find((t) => /^(#|rgba?\()/i.test(t) && !!color(t))
          || ts.find((t) => !!color(t) && !BG_WORDS.has(t.toLowerCase())) || 'transparent';
      } else if (p === 'text-decoration') {
        m['text-decoration-line'] = tokens(v).map((t) => t.toLowerCase()).filter((t) => /^(underline|line-through|overline|none)$/.test(t)).join(' ') || 'none';
      } else if (p === 'white-space') {
        m['text-wrap-mode'] = /^(nowrap|pre)$/.test(kw(v)) ? 'nowrap' : 'wrap';
      } else {
        m[p] = v;
      }
    }
    return m;
  }

  const NOT_COLOR = new Set(['auto', 'inherit', 'initial', 'unset', 'revert', 'transparent', 'currentcolor', 'none', 'invert', 'normal']);

  /** 색 — #rrggbb · rgba(r, g, b, a) · 이름만. windowtext(엑셀·워드의 «글자색 그대로»)는 검정. 못 쓰는 것은 '' */
  function color(v) {
    const s = str(v).trim().toLowerCase();
    if (!s || risky(s)) return '';
    if (s === 'windowtext') return '#000000';
    let m = s.match(/^#([0-9a-f]{3})$/);
    if (m) return `#${m[1].replace(/./g, (c) => c + c)}`;
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/);
    if (m) {
      const c = [m[1], m[2], m[3]].map(Number);
      if (c.some((n) => n > 255)) return '';
      const a = m[4] === undefined ? 1 : Math.min(1, Number(m[4]));
      if (!(a > 0)) return '';
      if (a >= 1) return `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
      return `rgba(${c.join(', ')}, ${Math.round(a * 100) / 100})`;
    }
    if (/^[a-z]{3,20}$/.test(s) && !NOT_COLOR.has(s)) return s;
    return '';
  }

  const UNIT = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

  /** 길이 → «Npx» (pt·cm 도 px 로). % 는 pct 일 때만 (표 너비 — 100% 까지). 0·음수·모르는 꼴은 '' */
  function px(v, { pct = false, max = 4000 } = {}) {
    const m = str(v).trim().toLowerCase().match(/^(\d*\.?\d+)(px|pt|pc|in|cm|mm|%)?$/);
    if (!m) return '';
    const n = Number(m[1]);
    if (m[2] === '%') return pct && n > 0 ? `${Math.min(100, Math.round(n))}%` : '';
    const p = Math.round(n * UNIT[m[2] || 'px']);
    return p > 0 ? `${Math.min(p, max)}px` : '';
  }

  /** 테두리 두께 → 0(없음)·1·2·3px. 0.5pt·1pt → 1, 1.5pt → 2, 2.25pt 이상 → 3 (엑셀의 가는·중간·굵은 선) */
  function borderWidth(v) {
    const s = kw(v);
    if (!s || s === 'medium' || s === 'initial' || s === 'thick') return 3;
    if (s === 'thin') return 1;
    const m = s.match(/^(\d*\.?\d+)(px|pt|pc|in|cm|mm)?$/);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!(n > 0)) return 0;
    const unit = m[2] || 'px';
    if (unit === 'px') return Math.min(3, Math.max(1, Math.round(n)));
    const pt = n * UNIT[unit] * 0.75;
    return pt <= 1 ? 1 : pt < 2.25 ? 2 : 3;
  }

  /** 테두리 모양 — solid·dashed·dotted·double. 입체 선(inset 등)은 solid, none·hidden·모르는 것은 '' */
  function borderStyle(v) {
    const s = kw(v);
    if (/^(solid|dashed|dotted|double)$/.test(s)) return s;
    if (/^(groove|ridge|inset|outset)$/.test(s)) return 'solid';
    return '';
  }

  /** 한 변 → «Npx 모양 색» 또는 '' (없음). 색이 없으면 글자색(fb), 그것도 없으면 검정 — CSS 의 currentColor */
  function side(w, s, c, fb) {
    const st = borderStyle(s);
    const n = borderWidth(w);
    if (!st || !n) return '';
    return `${n}px ${st} ${color(c) || color(fb) || '#000000'}`;
  }

  /** 굵기 → bold · normal · '' */
  function weight(v) {
    const s = kw(v);
    if (s === 'bold' || s === 'bolder') return 'bold';
    if (s === 'normal' || s === 'lighter') return 'normal';
    if (/^\d{3}$/.test(s)) return Number(s) >= 600 ? 'bold' : 'normal';
    return '';
  }

  /** 밑줄·취소선 → ['u','s'] — style 의 text-decoration 은 크로미움 insertHTML 이 text-decoration-line 으로 고쳐 써서 메일 프로그램이 못 읽는다 (실측). 태그로 넣는다 */
  function deco(m) {
    const t = ` ${kw((m && (m['text-decoration-line'] || m['text-decoration'])) || '').replace(/\s+/g, ' ')} `;
    const out = [];
    if (t.includes(' underline ')) out.push('u');
    if (t.includes(' line-through ')) out.push('s');
    return out;
  }

  /** 줄바꿈 안 함 — CSSOM 은 white-space 를 text-wrap-mode 로 편다 (크로미움 130). 옛 꼴(white-space)도 본다 */
  function nowrapOf(m) {
    const t = kw(m['text-wrap-mode'] || m['text-wrap'] || '');
    if (t) return t === 'nowrap';
    return /^(nowrap|pre)$/.test(kw(m['white-space'] || ''));
  }

  const get = (m) => (k) => (m && m[k] !== undefined && m[k] !== null ? String(m[k]) : '');

  /**
   * 칸(td·th)에 남길 스타일 — 정한 차례로: 테두리 · 배경 · 글자색 · 맞춤 · 굵기 · 기울임 · 너비.
   * 기본값과 같은 것(td 의 보통 굵기·왼쪽 맞춤, th 의 굵게)은 안 적는다 — 적으면 크로미움 insertHTML 이 «쓸데없는 것»으로 보고
   * 그 칸의 style 을 통째로 다시 써서(rgb(…)·text-wrap-mode) 메일 프로그램이 못 읽는 꼴이 된다 (실측).
   * 같은 까닭으로 줄바꿈 안 함은 nowrap 속성으로(nowrap), 밑줄·취소선은 <u>·<s> 로(deco) 돌려준다.
   * @returns { parts: [[이름, 값]], visible: 테두리가 한 변이라도 있나, bg: bgcolor 속성에 쓸 #hex, nowrap, width: px 정수, deco }
   */
  function cellParts(map, { th = false } = {}) {
    const g = get(map);
    const parts = [];
    const text = color(g('color'));
    const sides = SIDES.map((s) => side(g(`border-${s}-width`), g(`border-${s}-style`), g(`border-${s}-color`), text));
    if (sides.every((x) => x && x === sides[0])) parts.push(['border', sides[0]]);
    else SIDES.forEach((s, i) => { if (sides[i]) parts.push([`border-${s}`, sides[i]]); });
    const bg = color(g('background-color'));
    if (bg) parts.push(['background-color', bg]);
    if (text) parts.push(['color', text]);
    const ta = kw(g('text-align'));
    const align = /center$/.test(ta) ? 'center' : /right$|^end$/.test(ta) ? 'right' : ta === 'justify' ? 'justify'
      : /left$|^start$/.test(ta) && th ? 'left' : '';
    if (align) parts.push(['text-align', align]);
    const va = kw(g('vertical-align'));
    if (/^(top|middle|bottom|baseline)$/.test(va)) parts.push(['vertical-align', va]);
    const fw = weight(g('font-weight'));
    if (th ? fw === 'normal' : fw === 'bold') parts.push(['font-weight', fw]);
    if (/^(italic|oblique)/.test(kw(g('font-style')))) parts.push(['font-style', 'italic']);
    const w = px(g('width'));
    if (w) parts.push(['width', w]);
    return {
      parts, visible: sides.some(Boolean), bg: /^#[0-9a-f]{6}$/.test(bg) ? bg : '',
      nowrap: nowrapOf(map || {}), width: w ? parseInt(w, 10) : 0, deco: deco(map)
    };
  }

  /** 표에 남길 스타일 — border-collapse 는 늘, 너비는 px 또는 100% 까지의 % */
  function tableParts(map) {
    const parts = [['border-collapse', 'collapse']];
    const w = px(get(map)('width'), { pct: true });
    if (w) parts.push(['width', w]);
    return { parts, width: /px$/.test(w) ? parseInt(w, 10) : 0 };
  }

  /** 글자 태그(b·i·span·a …)에 남길 스타일 — 굵기 · 기울임 · 글자색 · 배경. 밑줄·취소선은 deco */
  function inlineParts(map) {
    const g = get(map);
    const parts = [];
    const fw = weight(g('font-weight'));
    if (fw) parts.push(['font-weight', fw]);
    const fs = kw(g('font-style'));
    if (/^(italic|oblique)/.test(fs)) parts.push(['font-style', 'italic']);
    else if (fs === 'normal') parts.push(['font-style', 'normal']);
    const c = color(g('color'));
    if (c) parts.push(['color', c]);
    const bg = color(g('background-color'));
    if (bg) parts.push(['background-color', bg]);
    return { parts, deco: deco(map) };
  }

  /** 칸 안 문단(p·div)에 남길 스타일 — 맞춤만 (한글·워드는 칸의 가운데 맞춤을 <p> 에 둔다) */
  function blockParts(map) {
    const t = kw(get(map)('text-align'));
    return { parts: /^(left|center|right|justify)$/.test(t) ? [['text-align', t]] : [] };
  }

  /** 숨긴 것 — display:none (엑셀이 숨긴 행·열) · mso-hide:all (워드가 숨긴 글) */
  const hidden = (map) => !!map && (kw(map.display) === 'none' || kw(map['mso-hide']) === 'all');

  /** colspan·rowspan·span — 1~1000 정수 (크로미움도 1000 에서 자른다). 못 쓰는 것은 0 (안 적는다) */
  function span(v) {
    const s = str(v).trim();
    if (!/^\d+$/.test(s)) return 0;
    const n = Number(s);
    return n >= 1 ? Math.min(n, 1000) : 0;
  }

  /** width 속성 — px 정수만 (4000 까지) */
  function widthAttr(v) {
    const m = str(v).trim().toLowerCase().match(/^(\d+)(px)?$/);
    if (!m) return 0;
    const n = Number(m[1]);
    return n > 0 ? Math.min(n, 4000) : 0;
  }

  /** 링크 — 사람이 눌러 갈 수 있는 곳(http·https·mailto)만. 나머지는 링크를 벗기고 글만 남긴다 */
  function href(v) {
    const s = str(v).trim();
    return /^(https?:\/\/|mailto:)/i.test(s) && !/[\u0000-\u0020\u007f]/.test(s) ? s : '';
  }

  /** <style> 글 — HTML 주석 표시(엑셀은 규칙을 <!-- --> 로 감싼다)와 @import 를 뗀다 */
  function cssForSheet(css) {
    return str(css).replace(/<!--|-->/g, ' ').replace(/@import\b[^;]*;?/gi, ' ').replace(/@charset\b[^;]*;?/gi, ' ');
  }

  /** 윈도우 CF_HTML 머리(Version:0.9 StartHTML:…)가 붙어 오면 뗀다 — 남으면 표 앞에 글로 들어간다 */
  function stripCfHeader(html) {
    const s = str(html);
    return /^Version:\d/.test(s) ? s.replace(/^Version:[\s\S]*?(?=<)/, '') : s;
  }

  const tooBig = ({ cells = 0, htmlLength = 0 } = {}) => cells > MAX_CELLS || htmlLength > MAX_HTML;
  const comma = (n) => String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const bigText = (n) => `표가 커서 글로 붙였습니다 (${comma(n)}칸)`;
  // Gmail 은 html 이 102KB 를 넘으면 뒷부분을 «전체 메시지 보기» 뒤로 접는다 (서명·인용문까지). 칸마다 인라인 스타일을 적어서
  // 서식 있는 엑셀 표는 500칸 남짓이면 넘는다 — 넘으면 붙일 때 알린다 (막지는 않는다)
  const HEAVY = 100000;
  const utf8Length = (s) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(str(s)).length : unescape(encodeURIComponent(str(s))).length);
  const heavy = (html) => utf8Length(html) > HEAVY;
  const doneText = ({ tables = 1, rows = 0, cols = 0, heavy: big = false } = {}) => (tables > 1 ? `표 ${tables}개를 붙였습니다` : `표를 붙였습니다 (${rows}×${cols})`)
    + (big ? ' — 메일이 커서 Gmail 에서는 뒷부분이 접혀 보일 수 있습니다' : '');
  /** 다듬기 전에 HTML 글자만으로 칸을 센다 — 아주 큰 표에 글도 같이 왔으면 다듬지 않고 바로 글로 붙이려고 */
  const countCells = (html) => (str(html).match(/<t[dh][\s>/]/gi) || []).length;
  /**
   * 숨긴 행·열·글이 있을 수 있나 — style 속성의 display:none · mso-hide:all (엑셀은 숨긴 것을 이렇게 싣는다).
   * <style> 안의 것은 안 본다 — 엑셀은 늘 rt{display:none} 를 두는데 그건 숨긴 칸이 아니다
   */
  const mayHide = (html) => /style\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)(display\s*:\s*none|mso-hide\s*:\s*all)/i.test(str(html));
  const styleText = (parts) => (parts || []).map(([p, v]) => `${p}:${v}`).join(';');
  const rowsText = (rows) => (rows || []).map((r) => r.join('\t')).join('\n');

  /**
   * «표» 단추로 넣는 빈 표 — 붙인 표와 같은 꼴(cellpadding·cellspacing 0, border-collapse, 칸마다 인라인 선·너비·여백)과 같은 선(GRID).
   * 너비는 width 속성과 style 둘 다 — 메일 프로그램마다 보는 것이 다르다. 빈 칸은 <br> (커서가 들어가고 줄 높이가 산다).
   * 줄·열은 1~20.
   */
  function blank(rows, cols, w = COL_W) {
    const n = (v) => Math.min(20, Math.max(1, Math.round(Number(v)) || 1));
    const width = Math.max(1, Math.round(Number(w)) || COL_W);
    const td = `<td width="${width}" style="${styleText([['border', GRID], ['width', `${width}px`], ['padding', NEW_PAD]])}"><br></td>`;
    return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tbody>${`<tr>${td.repeat(n(cols))}</tr>`.repeat(n(rows))}</tbody></table>`;
  }

  // ── DOM 다시 짓기 ─────────────────────────────

  // 통째로 버린다 (안의 글까지) — 코드·그림·입력 칸·문서 머리·워드의 <o:p>
  const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'XML', 'O:P', 'IMG', 'PICTURE',
    'SOURCE', 'TRACK', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'PARAM', 'MAP', 'AREA',
    'INPUT', 'BUTTON', 'SELECT', 'OPTION', 'OPTGROUP', 'TEXTAREA', 'DATALIST', 'OUTPUT', 'PROGRESS', 'METER', 'DIALOG', 'SLOT']);
  // SVG·MathML 처럼 HTML 이 아닌 것과 워드의 VML 그림(v:shape …)도 통째로
  const dropped = (el) => el.namespaceURI !== XHTML || DROP.has(el.tagName.toUpperCase()) || /^V:/i.test(el.tagName);
  // FONT 는 span 으로 다시 짓는다 (리브레오피스의 글자색 <font color>, 엑셀의 칸 안 일부 서식 <font class="font6">)
  const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'SPAN', 'A', 'FONT']);
  // 워드 글머리 기호 — 기호 글꼴(Wingdings 등)의 글자로 실린다 (●=l, ➢=Ø, ✓=ü …). 글꼴을 떼면 l·Ø·ü 가 보이므로 보이는 기호로 바꾼다
  const WINGDINGS = { l: '●', n: '■', q: '❑', u: '◆', v: '❖', 'Ø': '➢', 'ü': '✓', '§': '▪' };
  // 줄을 바꾸는 태그 — 표 밖에서는 글 줄을 가르고, 칸 안에서는 p 말고는 div 로 (껍데기는 벗기되 줄은 지킨다)
  const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'PRE',
    'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'ADDRESS', 'CENTER', 'FIGURE', 'FIGCAPTION', 'HR', 'TABLE',
    'TR', 'CAPTION', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY']);
  const blockish = (n) => !!n && n.nodeType === 1 && BLOCKS.has(n.tagName.toUpperCase());

  /** <style> 들의 규칙 — 맞춰 볼 선택자와, 낱낱으로 편 선언 (바깥을 부르는 값은 뺀다) */
  function sheetRules(doc, Sheet) {
    const rules = [];
    if (typeof Sheet !== 'function') return rules;
    for (const st of doc.querySelectorAll('style')) {
      let sheet;
      try {
        sheet = new Sheet();
        sheet.replaceSync(cssForSheet(st.textContent));
      } catch { continue; }
      for (const r of sheet.cssRules) {
        // 스타일 규칙만 — @page·@media·@font-face 는 안 본다
        if (r.type !== 1 || !r.selectorText || !r.style) continue;
        const m = {};
        for (let i = 0; i < r.style.length; i++) {
          const p = r.style[i];
          const v = r.style.getPropertyValue(p);
          if (v && !risky(v)) m[p] = v;
        }
        if (Object.keys(m).length) rules.push({ sel: r.selectorText, m });
      }
    }
    return rules;
  }

  /**
   * 클립보드 HTML → 넣을 HTML. 표가 없거나, 표가 «빈 칸뿐이고 테두리도 없거나», 스프레드시트가 아닌 테두리 없는 한 열짜리
   * 배치용 표뿐이면 ok:false (보통 붙여넣기로).
   * @param env { DOMParser, CSSStyleSheet, document } — 없으면 창의 것
   * @returns { ok, big, single, tables, rows, cols, cells, hidden, html, text }
   *   big  — 칸이 MAX_CELLS 를 넘거나 다듬은 HTML 이 MAX_HTML 을 넘는다 (html 은 비운다 — 글로 붙인다)
   *   single — 테두리도 합친 칸도 없는 칸 하나뿐 (엑셀 칸 하나) — ok 는 false, 표가 아니라 text 를 글로 붙인다
   *   rows·cols — 첫 표의 줄 수·칸 수(합친 칸은 펴서, 숨긴 것은 빼고), cells — 보이는 칸 수, text — 표에서 뽑은 글 (탭·줄)
   *   hidden — 숨긴 행·열·칸 수. 0 이 아니면 클립보드 글(엑셀은 숨긴 것까지 싣는다) 대신 text 를 써야 한다
   */
  function build(html, env) {
    const E = env || {};
    const Parser = E.DOMParser || root.DOMParser;
    const Sheet = E.CSSStyleSheet || root.CSSStyleSheet;
    const out = (E.document || root.document).implementation.createHTMLDocument('');
    const src = new Parser().parseFromString(stripCfHeader(html), 'text/html');
    const none = { ok: false, big: false, single: false, tables: 0, rows: 0, cols: 0, cells: 0, hidden: 0, html: '', text: '' };
    const top = [...src.querySelectorAll('table')].filter((t) => !t.parentElement || !t.parentElement.closest('table'));
    if (!top.length) return none;

    const rules = sheetRules(src, Sheet);
    const cache = new Map();
    /** 그 요소에 입혀진 스타일 — 맞는 규칙을 차례대로, 그 위에 인라인 style */
    const styleOf = (el) => {
      if (cache.has(el)) return cache.get(el);
      const m = {};
      for (const r of rules) {
        let hit = false;
        try { hit = el.matches(r.sel); } catch { hit = false; }
        if (hit) Object.assign(m, r.m);
      }
      Object.assign(m, declsOf(el.getAttribute('style')));
      cache.set(el, m);
      return m;
    };
    const shown = (el) => !hidden(styleOf(el));
    /** 보이는 글만 — 버리는 것(script·style·svg …)과 숨긴 것의 글은 뺀다. textContent 는 <script> 안의 글까지 준다 */
    const plainOf = (n) => {
      let s = '';
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1 && !dropped(c) && shown(c)) s += c.tagName.toUpperCase() === 'BR' ? ' ' : plainOf(c);
      }
      return s;
    };

    /**
     * 원본 표의 칸 지도 — 엑셀은 숨긴 행·열의 칸도 싣고(display:none), 합친 칸의 colspan·rowspan 은 숨긴 것까지 센다.
     * 숨긴 것을 빼고 넣으려면 합친 칸이 걸친 «보이는» 행·열 수로 다시 세야 한다 (안 그러면 그 줄의 칸이 옆으로 밀린다).
     *   rows — 줄마다 { tr, sec, off(숨김) }, at — 칸마다 원본 자리 { r, c, rs, cs }, colOff — 숨긴 열 (COL 이 숨었거나,
     *   보이는 줄에서 그 열의 안 합친 칸이 모두 숨었다), vis(자리) — 보이는 행·열 수로 다시 센 { rs, cs }, hidden — 숨긴 것 수
     */
    const layouts = new Map();
    const layoutOf = (t) => {
      if (layouts.has(t)) return layouts.get(t);
      const rows = [];
      const scan = (from, off) => {
        for (const c of from.children) {
          if (dropped(c)) continue;
          const tag = c.tagName.toUpperCase();
          if (tag === 'TR') rows.push({ tr: c, sec: from, off: off || !shown(c) });
          else if (!['TABLE', 'CAPTION', 'COLGROUP', 'COL', 'TD', 'TH'].includes(tag)) scan(c, off || !shown(c));
        }
      };
      scan(t, false);
      // 줄마다 그 구역의 끝 줄 — rowspan 은 구역(thead·tbody·tfoot)을 못 넘는다, 0 이면 구역 끝까지
      const end = new Array(rows.length);
      for (let r = rows.length - 1; r >= 0; r--) end[r] = r + 1 < rows.length && rows[r + 1].sec === rows[r].sec ? end[r + 1] : r;
      const taken = rows.map(() => []);
      const at = new Map();
      rows.forEach((row, r) => {
        let c = 0;
        for (const cell of row.tr.children) {
          const tag = cell.tagName.toUpperCase();
          if (tag !== 'TD' && tag !== 'TH') continue;
          while (taken[r][c]) c += 1;
          const cs = span(cell.getAttribute('colspan')) || 1;
          const rsv = str(cell.getAttribute('rowspan')).trim();
          const rs = Math.min(rsv === '0' ? end[r] - r + 1 : span(rsv) || 1, end[r] - r + 1);
          for (let j = 0; j < rs; j++) for (let k = 0; k < cs; k++) taken[r + j][c + k] = true;
          at.set(cell, { r, c, rs, cs });
          c += cs;
        }
      });
      const w = taken.reduce((n, x) => Math.max(n, x.length), 0);
      const colOff = new Array(w).fill(false);
      let k = 0;
      const mark = (el, off) => {
        const n = span(el.getAttribute('span')) || 1;
        for (let i = 0; i < n; i++, k++) if (off && k < w) colOff[k] = true;
      };
      for (const g of t.children) {
        const tag = g.tagName.toUpperCase();
        if (tag === 'COL') mark(g, !shown(g));
        else if (tag === 'COLGROUP') {
          const cols = [...g.children].filter((x) => x.tagName.toUpperCase() === 'COL');
          if (cols.length) for (const x of cols) mark(x, !shown(g) || !shown(x));
          else mark(g, !shown(g));
        }
      }
      const byCol = Array.from({ length: w }, () => []);
      for (const [cell, p] of at) if (p.cs === 1 && !rows[p.r].off) byCol[p.c].push(cell);
      byCol.forEach((list, c) => { if (!colOff[c] && list.length && list.every((cell) => !shown(cell))) colOff[c] = true; });
      const vis = (p) => {
        let cs = 0;
        let rs = 0;
        for (let x = p.c; x < p.c + p.cs; x++) if (!colOff[x]) cs += 1;
        for (let y = p.r; y < p.r + p.rs; y++) if (!rows[y].off) rs += 1;
        return { rs, cs };
      };
      const hiddenN = rows.filter((x) => x.off).length + colOff.filter(Boolean).length + [...at.keys()].filter((cell) => !shown(cell)).length;
      const L = { rows, at, colOff, vis, hidden: hiddenN };
      layouts.set(t, L);
      return L;
    };
    /** 표 하나의 글 — 보이는 행·열만, 합친 칸은 왼쪽 위 자리에 글 (나머지 자리는 빈 칸 — 엑셀 글 몫처럼 열이 맞는다) */
    const tableText = (t) => {
      const L = layoutOf(t);
      let n = 0;
      const rowAt = L.rows.map((x) => (x.off ? -1 : n++));
      let m = 0;
      const colAt = L.colOff.map((off) => (off ? -1 : m++));
      const g = Array.from({ length: n }, () => new Array(m).fill(''));
      for (const [cell, p] of L.at) {
        if (!shown(cell)) continue;
        let y = p.r;
        while (y < p.r + p.rs && rowAt[y] < 0) y += 1;
        let x = p.c;
        while (x < p.c + p.cs && colAt[x] < 0) x += 1;
        if (y < p.r + p.rs && x < p.c + p.cs) g[rowAt[y]][colAt[x]] = plainOf(cell).replace(/\s+/g, ' ').trim();
      }
      return rowsText(g);
    };
    /** 표에서 뽑은 글 — 칸은 탭, 줄은 줄바꿈 (클립보드에 글이 없거나, 숨긴 것이 있어 클립보드 글을 못 쓸 때) */
    const textOf = () => top.filter(shown).map(tableText).join('\n');
    /** 숨긴 행·열·칸 수 (숨긴 표는 하나로) */
    const hiddenOf = () => top.reduce((n, t) => n + (shown(t) ? layoutOf(t).hidden : 1), 0);

    const srcCells = src.querySelectorAll('td, th').length;
    if (srcCells > MAX_CELLS) return { ...none, ok: true, big: true, cells: srcCells, hidden: hiddenOf(), text: textOf() };

    // 스프레드시트에서 온 표인가 — 엑셀(ProgId=Excel.Sheet·x:num), 구글 시트, 리브레오피스(generator·sdval).
    // 스프레드시트의 격자선은 테두리가 아니라 복사에 안 온다 — 이것만 테두리 없는 칸에 옅은 선을 긋는다.
    // 그 밖의 테두리 없는 표(HTML 메일·웹·서명의 배치용 표)는 선 없이 두고, 한 열짜리는 표로 안 넣는다 (예전처럼 글로)
    const sheet = /\sx:(num|str|fmla)\b/i.test(str(html)) || !!src.querySelector(['meta[name="ProgId" i][content^="Excel" i]',
      'meta[name="generator" i][content*="LibreOffice" i]', 'meta[name="generator" i][content*="OpenOffice" i]',
      'google-sheets-html-origin', '[data-sheets-value]', '[sdval]', '[sdnum]'].join(','));
    /** 워드 목록의 기호·번호 (<span style='mso-list:Ignore'>) — 기호 글꼴이면 보이는 기호로, 번호(1. 가.)는 글 그대로 */
    const listMark = (m) => /ignore/i.test(str(m && m['mso-list']));
    const bullet = (el) => {
      const glyph = plainOf(el).replace(/[\s ]+/g, ' ').trim();
      let font = '';
      for (let x = el; x && !font && x !== src.body; x = x.parentElement) font = kw(styleOf(x)['font-family'] || '');
      if (/wingdings|webdings|symbol/.test(font)) return `${WINGDINGS[glyph] || '•'} `;
      return glyph ? `${glyph} ` : '';
    };

    const stats = { tables: 0, rows: 0, cols: 0, cells: 0, hidden: 0, ok: false, lined: false, spanned: false };
    /** 표시용 속성(align 등)은 style 이 없을 때만 — CSS 가 이긴다 */
    const withAttr = (m, el, prop, attr) => (m[prop] === undefined && el.getAttribute(attr) ? { ...m, [prop]: el.getAttribute(attr) } : m);

    /** 칸·문단 안의 것 — 허락한 태그만 새로 짓고, 모르는 태그는 껍데기만 벗긴다 */
    const inline = (from, into) => {
      for (const c of [...from.childNodes]) {
        if (c.nodeType === 3) {
          // 소스의 들여쓰기(줄바꿈·빈칸뿐인 글)는 칸 맨 앞·뒤나 문단 사이에서 버린다
          if (/^[ \t\r\n\f]*$/.test(c.nodeValue)
            && (!c.previousSibling || !c.nextSibling || blockish(c.previousSibling) || blockish(c.nextSibling))) continue;
          into.append(out.createTextNode(c.nodeValue));
          continue;
        }
        if (c.nodeType !== 1 || dropped(c)) continue;
        const m = styleOf(c);
        if (hidden(m)) continue;
        const tag = c.tagName.toUpperCase();
        if (listMark(m)) {
          into.append(out.createTextNode(bullet(c)));
        } else if (tag === 'TABLE') {
          into.append(table(c, false));
        } else if (tag === 'BR') {
          // 엑셀의 칸 안 줄바꿈 <br style='mso-data-placement:same-cell'> 도 그냥 <br>
          into.append(out.createElement('br'));
        } else if (BLOCKS.has(tag)) {
          const el = out.createElement(tag === 'P' ? 'p' : 'div');
          const parts = blockParts(withAttr(m, c, 'text-align', 'align')).parts;
          // 워드·한글의 칸마다 <p> — 메일 프로그램의 기본 문단 여백이 붙으면 표가 부풀어 오른다
          if (tag === 'P') parts.unshift(['margin', '0']);
          if (parts.length) el.setAttribute('style', styleText(parts));
          inline(c, el);
          into.append(el);
        } else if (INLINE.has(tag)) {
          const link = tag === 'A' ? href(c.getAttribute('href')) : '';
          const ip = inlineParts(tag === 'FONT' ? withAttr(m, c, 'color', 'color') : m);
          // 주소가 못 쓰는 링크 · 남길 것이 없는 span·font(글꼴·크기만) — 껍데기를 벗긴다
          if ((tag === 'A' && !link) || ((tag === 'SPAN' || tag === 'FONT') && !ip.parts.length && !ip.deco.length)) {
            inline(c, into);
            continue;
          }
          const el = out.createElement(tag === 'FONT' ? 'span' : tag.toLowerCase());
          if (link) el.setAttribute('href', link);
          if (ip.parts.length) el.setAttribute('style', styleText(ip.parts));
          let inner = el;
          for (const d of ip.deco) {
            if ((d === 'u' && tag === 'U') || (d === 's' && (tag === 'S' || tag === 'STRIKE'))) continue;
            const x = out.createElement(d);
            inner.append(x);
            inner = x;
          }
          inline(c, inner);
          into.append(el);
        } else {
          inline(c, into);
        }
      }
    };

    /** 표 하나 — 칸 스타일은 다 모은 뒤에 적는다 (테두리가 하나도 없으면 격자선을 칸마다 넣어야 해서) */
    function table(t, isTop) {
      const ctx = { cells: [], rows: 0, cols: 0 };
      const L = layoutOf(t);
      const borderAttr = span(t.getAttribute('border'));
      const tm = styleOf(t);
      let tp = tableParts(tm);
      if (tp.parts.length < 2) tp = tableParts({ width: t.getAttribute('width') || '' });
      const el = out.createElement('table');
      el.setAttribute('cellpadding', '0');
      el.setAttribute('cellspacing', '0');
      if (tp.width) el.setAttribute('width', String(tp.width));
      el.setAttribute('style', styleText(tp.parts));

      /** v — 보이는 행·열 수로 다시 센 합침 (layoutOf) */
      const cell = (c, th, rowBg, v) => {
        let m = styleOf(c);
        m = withAttr(m, c, 'background-color', 'bgcolor');
        m = withAttr(m, c, 'text-align', 'align');
        m = withAttr(m, c, 'vertical-align', 'valign');
        if (c.hasAttribute('nowrap') && m['text-wrap-mode'] === undefined && m['white-space'] === undefined) m = { ...m, 'text-wrap-mode': 'nowrap' };
        const p = cellParts(m, { th });
        const parts = p.parts.slice();
        let bg = p.bg;
        // 행에 칠한 배경 — 칸이 제 배경이 없으면 칸에 (메일 프로그램마다 tr 배경을 다르게 다룬다)
        if (rowBg && !parts.some(([k]) => k === 'background-color')) {
          const at = parts.findIndex(([k]) => !k.startsWith('border'));
          parts.splice(at < 0 ? parts.length : at, 0, ['background-color', rowBg]);
          bg = /^#[0-9a-f]{6}$/.test(rowBg) ? rowBg : '';
        }
        const td = out.createElement(th ? 'th' : 'td');
        if (v.cs > 1) td.setAttribute('colspan', String(v.cs));
        if (v.rs > 1) td.setAttribute('rowspan', String(v.rs));
        if (v.cs > 1 || v.rs > 1) stats.spanned = true;
        const w = p.width || widthAttr(c.getAttribute('width'));
        if (w) td.setAttribute('width', String(w));
        // 아웃룩(워드 엔진)이 보는 속성도 같이 — 배경은 bgcolor, 줄바꿈 안 함은 nowrap
        if (bg) td.setAttribute('bgcolor', bg);
        if (p.nowrap) td.setAttribute('nowrap', '');
        let into = td;
        for (const d of p.deco) {
          const x = out.createElement(d);
          into.append(x);
          into = x;
        }
        inline(c, into);
        ctx.cells.push({ el: td, parts, visible: p.visible });
        return td;
      };

      const row = (tr) => {
        const rm = styleOf(tr);
        const rowBg = color(rm['background-color']) || color(tr.getAttribute('bgcolor'));
        const r = out.createElement('tr');
        let cols = 0;
        for (const c of tr.children) {
          const tag = c.tagName.toUpperCase();
          if ((tag !== 'TD' && tag !== 'TH') || !shown(c)) continue;
          // 숨긴 행·열만 걸친 칸은 빼고, 숨긴 것을 가로지르는 합친 칸은 보이는 행·열 수로
          const p = L.at.get(c);
          const v = p ? L.vis(p) : { rs: span(c.getAttribute('rowspan')) || 1, cs: span(c.getAttribute('colspan')) || 1 };
          if (!v.rs || !v.cs) continue;
          r.append(cell(c, tag === 'TH', rowBg, v));
          cols += v.cs;
        }
        ctx.rows += 1;
        ctx.cols = Math.max(ctx.cols, cols);
        return r;
      };

      const section = (from, into) => {
        for (const c of from.children) {
          if (dropped(c) || !shown(c)) continue;
          const tag = c.tagName.toUpperCase();
          if (tag === 'CAPTION') {
            const cap = out.createElement('caption');
            inline(c, cap);
            into.append(cap);
          } else if (tag === 'COLGROUP') {
            const g = out.createElement('colgroup');
            section(c, g);
            if (!g.children.length && !c.querySelector('col')) {
              // COL 없는 colgroup (리브레오피스 <colgroup span="2" width="85">) — span 만큼 COL 을 지어 너비를 옮긴다.
              // 빼면 너비가 사라지고, 너비 없는 것을 빼면 뒤 열의 COL 이 한 칸씩 당겨진다
              const n = span(c.getAttribute('span')) || 1;
              const w = widthAttr(c.getAttribute('width')) || parseInt(px(styleOf(c).width), 10) || 0;
              for (let i = 0; i < n; i++) {
                const col = out.createElement('col');
                if (w) col.setAttribute('width', String(w));
                g.append(col);
              }
            }
            if (g.children.length) into.append(g);
          } else if (tag === 'COL') {
            const col = out.createElement('col');
            const w = widthAttr(c.getAttribute('width')) || parseInt(px(styleOf(c).width), 10) || 0;
            if (w) col.setAttribute('width', String(w));
            const n = span(c.getAttribute('span'));
            if (n > 1) col.setAttribute('span', String(n));
            into.append(col);
          } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
            const s = out.createElement(tag.toLowerCase());
            section(c, s);
            if (s.children.length) into.append(s);
          } else if (tag === 'TR') {
            into.append(row(c));
          } else {
            // 표 안에 낀 모르는 껍데기(form 등) — 안쪽에서 줄을 찾는다
            section(c, into);
          }
        }
      };
      section(t, el);
      // 칸·COL 에 너비가 있으면 표의 px 너비는 안 적는다 — 엑셀은 표 너비를 칸 너비의 합으로 적는데 우리가 칸마다 여백을 더해서
      // 표 너비가 모자라고, 그리는 엔진마다(표 너비를 지키나, 칸 너비를 지키나) 열 너비가 달라진다. % 너비는 그대로
      if (tp.width && (ctx.cells.some((c) => c.el.hasAttribute('width')) || el.querySelector('col[width]'))) {
        el.removeAttribute('width');
        el.setAttribute('style', styleText(tp.parts.filter(([k]) => k !== 'width')));
      }

      const visible = ctx.cells.some((c) => c.visible);
      for (const c of ctx.cells) {
        const parts = c.parts.slice();
        // 테두리가 하나도 없는 표 — <table border> 면 브라우저가 그리던 회색 선, 스프레드시트면 격자선, 그 밖(배치용 표)은 선 없이
        if (!visible && (borderAttr > 0 || sheet)) parts.unshift(['border', borderAttr > 0 ? GRID_ATTR : GRID]);
        parts.push(['padding', PAD]);
        c.el.setAttribute('style', styleText(parts));
      }
      stats.cells += ctx.cells.length;
      if (isTop) {
        stats.tables += 1;
        stats.hidden += L.hidden;
        if (stats.tables === 1) {
          stats.rows = ctx.rows;
          stats.cols = ctx.cols;
        }
        const lined = visible || borderAttr > 0;
        if (lined) stats.lined = true;
        // 넣을 만한 표 — 글이 든 칸이 있거나, 테두리를 그어 둔 표 (빈 칸뿐이고 테두리도 없으면 엑셀 빈 칸 — 예전처럼 안 넣는다).
        // 스프레드시트가 아닌 테두리 없는 한 열짜리 표는 HTML 메일의 배치용 표다 — 표로 안 센다 (그것뿐이면 예전처럼 글로)
        const layoutOnly = !lined && !sheet && ctx.cols <= 1;
        if (!layoutOnly && (lined || ctx.cells.some((c) => /\S/.test(c.el.textContent)))) stats.ok = true;
      }
      return el;
    }

    // 표 밖의 글은 줄 글로 — 줄마다 <div>
    const host = out.createElement('div');
    let lines = [''];
    const brk = () => { if (lines[lines.length - 1] !== '') lines.push(''); };
    const flush = () => {
      for (const l of lines) {
        const s = l.replace(/\s+/g, ' ').trim();
        if (!s) continue;
        const d = out.createElement('div');
        d.textContent = s;
        host.append(d);
      }
      lines = [''];
    };
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          lines[lines.length - 1] += c.nodeValue;
          continue;
        }
        if (c.nodeType !== 1 || dropped(c) || !shown(c)) continue;
        const tag = c.tagName.toUpperCase();
        if (listMark(styleOf(c))) {
          lines[lines.length - 1] += bullet(c);
          continue;
        }
        if (tag === 'TABLE') {
          flush();
          host.append(table(c, true));
          continue;
        }
        if (tag === 'BR') {
          lines.push('');
          continue;
        }
        const block = BLOCKS.has(tag);
        if (block) brk();
        walk(c);
        if (block) brk();
      }
    };
    walk(src.body);
    flush();

    if (!stats.ok) return { ...none, tables: stats.tables, hidden: stats.hidden };
    // 칸 하나뿐인 표 (테두리도 합친 칸도 없고 표 밖 글도 없다 — 엑셀 칸 하나를 복사한 것) — 표가 아니라 그 글로.
    // 문장 가운데에 숫자 하나를 옮기는 일이 흔한데, 표로 넣으면 문장이 세 줄로 갈리고 상자가 생긴다
    if (stats.tables === 1 && stats.cells === 1 && !stats.lined && !stats.spanned && host.children.length === 1) {
      return { ...none, single: true, tables: 1, rows: 1, cols: 1, cells: 1, hidden: stats.hidden, text: textOf() };
    }
    const made = host.innerHTML;
    const res = { ok: true, big: false, single: false, tables: stats.tables, rows: stats.rows, cols: stats.cols, cells: stats.cells, hidden: stats.hidden, html: made, text: textOf() };
    if (tooBig({ cells: stats.cells, htmlLength: made.length })) return { ...res, big: true, html: '' };
    return res;
  }

  const api = {
    MAX_CELLS, MAX_HTML, LINE, GRID, GRID_ATTR, PAD, NEW_PAD, COL_W, blank,
    parseDecls, declsOf, risky, color, px, borderWidth, borderStyle, side, cellParts, tableParts, inlineParts, blockParts,
    hidden, span, widthAttr, href, cssForSheet, stripCfHeader, tooBig, bigText, doneText, styleText, rowsText, build,
    HEAVY, heavy, countCells, mayHide
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object' && root.document) root.nunsTable = api;
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';
// 라이트 모드 배선 지킴이 — 창을 하나도 안 띄우고 파일만 읽는다 (node 로 돌려도 되고 npm test 로 돌려도 된다).
//
// 라이트 모드에서 글자가 안 읽히던 까닭은 창마다 색·테마·유리 진하기를 따로 칠한 데 있었다.
// 이제 라이트 색 이름은 renderer/tokens.css 한 곳, 테마·진하기 입히기는 renderer/theme.js 한 곳이다.
// 누가 페이지에서 다시 따로 칠하면 화면은 멀쩡히 뜨면서 조용히 예전으로 돌아가므로, 그 길목을 못 박는다.
//   [1] 유리 창마다 tokens.css·theme.js 를 페이지 <style> 보다 먼저 싣고, CSP 가 그 둘을 막지 않는다 (휴식 화면은 안 싣는다)
//   [2] data-theme·--scrim-a·?theme 는 theme.js 만 만진다. 위젯만 받던 옛 'scrim' 통로는 없다
//   [3] 페이지 라이트 블록이 공용 이름을 되풀이하지 않는다 (정해 둔 예외만) — 되풀이하면 tokens.css 값을 덮는다
//   [4] 다크 전용 짙은 글자(#06231d·#08110f)를 쓰는 규칙마다 «같은 선택자»의 라이트 덮어쓰기가 있다 — 라이트 강조색 위에서 2.4:1
//       (라이트 쪽에 :not(…) 을 더 붙이는 것만 된다. 더 좁은 선택자는 정해 둔 예외만)
//   [5] 인라인 색(style.color·background*·fill·stroke, setProperty('color'·공용 이름))에는 var(…)·inherit 글자만 넣는다
//       — 인라인은 테마 규칙을 이긴다. 데이터 색은 --c·--type·--tint 같은 재료로만 넘긴다
//   [6] var(--secondary-label) 을 쓰는 페이지는 그 정의를 받는다
//   [7] tokens.css 라이트 글자색은 불투명하고, 가장 나쁜 유리(라이트 바닥 + #111 배경화면)에서 4.5:1 에 3% 여유가 있다
// 실제로 계산된 값이 맞는지는 lighttheme.test.js 가 화면 밖 창으로 잰다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const GLASS = ['widget', 'settings', 'stats', 'stocks', 'compose', 'mailview', 'popup', 'chart'];
const LIGHT = ':root[data-theme="light"]';

// ── 읽기 도구 ──────────────────────────────────────
const noCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const noHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const styleOf = (html) => [...noHtmlComments(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => noCssComments(m[1])).join('\n');
const inlineScriptsOf = (html) => [...noHtmlComments(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).join('\n');

/** 괄호 밖의 구분자로만 자른다 — :not(.a, .b) 나 rgba(…) 안의 쉼표·쌍반점은 그대로 둔다 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** CSS 규칙을 평평하게 — @media 안의 규칙도 꺼내고, @keyframes 안의 from/to 는 뺀다 */
function cssRules(css) {
  const rules = [];
  const stack = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') { stack.push(buf.trim()); buf = ''; } else if (ch === '}') {
      const sel = stack.pop();
      const body = buf.trim();
      buf = '';
      if (sel && !sel.startsWith('@') && body && !stack.some((s) => s.startsWith('@keyframes'))) {
        const decls = splitTop(body, ';').map((d) => {
          const i = d.indexOf(':');
          return i < 0 ? null : { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
        }).filter(Boolean);
        rules.push({ sels: splitTop(sel, ','), decls });
      }
    } else buf += ch;
  }
  return rules;
}
const varsOf = (rules, sel) => {
  const m = {};
  for (const r of rules) if (r.sels.includes(sel)) for (const d of r.decls) if (d.prop.startsWith('--')) m[d.prop] = d.value;
  return m;
};

/** 대입문의 오른쪽 — 문자열·괄호를 건너뛰며 첫 쌍반점(또는 400자)까지 */
function rhsAt(src, from) {
  let depth = 0;
  let q = null;
  let i = from;
  for (; i < src.length && i - from < 400; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') q = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; } else if (ch === ';' && depth === 0) break;
  }
  return src.slice(from, i);
}

// 화면 쪽 스크립트 — renderer/*.js 와 HTML 안의 <script>. anim/ 은 테마와 상관없는 연출 그림이라 뺀다.
const rendererJs = fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: `renderer/${f}`, src: read(`renderer/${f}`) }));
const rendererHtml = fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => f.endsWith('.html'))
  .map((f) => ({ name: `renderer/${f}`, html: read(`renderer/${f}`) }));
const scripts = [
  ...rendererJs,
  ...rendererHtml.map((h) => ({ name: `${h.name} <script>`, src: inlineScriptsOf(h.html) }))
];

// ── [1] 싣는 순서와 CSP ─────────────────────────────
console.log('\n[1] 유리 창이 tokens.css·theme.js 를 페이지 스타일보다 먼저 싣는다');
ok(fs.existsSync(path.join(ROOT, 'renderer', 'tokens.css')) && fs.existsSync(path.join(ROOT, 'renderer', 'theme.js')),
  'renderer/tokens.css 와 renderer/theme.js 가 있다');
for (const p of GLASS) {
  const html = noHtmlComments(read(`renderer/${p}.html`));
  const link = html.search(/<link\s+rel="stylesheet"\s+href="tokens\.css"\s*>/);
  const script = html.search(/<script\s+src="theme\.js"\s*><\/script>/);
  const style = html.indexOf('<style');
  // 페이지 스크립트가 theme.js 보다 먼저 돌면 data-theme 없이 첫 화면을 그린다
  const firstPageScript = [...html.matchAll(/<script\s+src="([^"]+)"/g)].find((m) => m[1] !== 'theme.js' && !/^(icons|drag|sound|safehtml|pickfield)\.js$|^anim\//.test(m[1]));
  const inline = html.search(/<script>(?!<\/script>)/);
  const firstJs = Math.min(...[firstPageScript ? firstPageScript.index : Infinity, inline < 0 ? Infinity : inline]);
  ok(link >= 0 && script > link && style > script && firstJs > script,
    `${p}.html — tokens.css → theme.js → 페이지 <style> 순서, 페이지 스크립트는 그 뒤`, { link, script, style, firstJs });

  const csp = (html.match(/http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/) || [])[1] || '';
  const dir = (name) => (csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) || []).slice(1);
  ok(dir('script-src').includes('file:') && dir('style-src').includes('file:'),
    `${p}.html — CSP 가 file: 스크립트·스타일을 허락한다 (theme.js·tokens.css 가 조용히 막히지 않게)`, { script: dir('script-src'), style: dir('style-src') });
}
{
  const html = noHtmlComments(read('renderer/overlay.html'));
  ok(!/tokens\.css|theme\.js/.test(html), 'overlay.html — 휴식 화면은 테마와 상관없이 늘 어두워 둘 다 싣지 않는다');
}

// ── [2] 테마·진하기는 theme.js 만 ───────────────────
console.log('\n[2] data-theme·--scrim-a·?theme 는 theme.js 만 만진다');
const THEME_WRITES = [
  [/dataset\.theme\s*=(?!=)/, 'dataset.theme = …'],
  [/setAttribute\(\s*['"]data-theme/, "setAttribute('data-theme', …)"],
  [/(?:set|remove)Property\(\s*['"]--scrim-a['"]/, "setProperty('--scrim-a', …)"],
  // 앱 모드를 바꾸면 주소는 그대로인데 테마만 바뀐다 — ?theme 를 읽은 값은 곧 낡는다
  [/\.get\(\s*['"]theme['"]\s*\)/, "params.get('theme')"]
];
for (const [re, what] of THEME_WRITES) {
  const hits = scripts.filter((s) => s.name !== 'renderer/theme.js' && re.test(s.src)).map((s) => s.name);
  ok(!hits.length, `theme.js 밖에 ${what} 가 없다`, hits.length ? hits : undefined);
}
{
  const theme = read('renderer/theme.js');
  ok(/dataset\.theme\s*=/.test(theme) && /setProperty\('--scrim-a'/.test(theme) && /onGlass/.test(theme),
    'theme.js 가 그 일을 한다 (data-theme · --scrim-a · onGlass 구독)');
  const preload = read('src/preload.js');
  ok(/\bonGlass:/.test(preload) && /\bpreviewScrim:/.test(preload), 'preload 가 onGlass·previewScrim 을 내놓는다');
  const settingsJs = read('renderer/settings.js');
  ok(/nunsseom\.previewScrim\(/.test(settingsJs), '설정 창이 슬라이더를 끄는 동안 previewScrim 을 부른다');
  const old = [...scripts, { name: 'src/preload.js', src: preload }, { name: 'src/main.js', src: read('src/main.js') },
    ...fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).map((f) => ({ name: `test/fixtures/${f}`, src: read(`test/fixtures/${f}`) }))]
    .filter((s) => /\bonScrim\b|send\(\s*['"]scrim['"]/.test(s.src)).map((s) => s.name);
  ok(!old.length, "위젯만 받던 옛 onScrim / 'scrim' 통로가 어디에도 없다", old.length ? old : undefined);
}

// ── [3] 페이지 라이트 블록 ───────────────────────────
console.log('\n[3] 페이지 라이트 블록이 공용 이름을 되풀이하지 않는다');
const tokenRules = cssRules(noCssComments(read('renderer/tokens.css')));
const TOK_DEFAULT = varsOf(tokenRules, ':root');
const TOK_LIGHT = varsOf(tokenRules, LIGHT);
ok(Object.keys(TOK_LIGHT).length >= 15, `tokens.css 라이트 블록을 읽었다 (${Object.keys(TOK_LIGHT).length}개)`);
// 창마다 일부러 다르게 둔 것 — 설정은 파랑을 지키고 판을 회색으로, 위젯은 칩 모양을 지키는 진한 채움
const PAGE_OWN = {
  settings: ['--accent', '--accent-fill', '--scrim'],
  widget: ['--fill', '--fill-hi', '--bar-idle']
};
for (const p of GLASS) {
  const own = varsOf(cssRules(styleOf(read(`renderer/${p}.html`))), LIGHT);
  const dup = Object.keys(own).filter((n) => n in TOK_LIGHT && !(PAGE_OWN[p] || []).includes(n));
  ok(!dup.length, `${p}.html — 라이트 블록에 공용 이름 없음${PAGE_OWN[p] ? ` (예외 ${PAGE_OWN[p].join(' ')})` : ''}`, dup.length ? dup : undefined);
}

// ── [4] 다크 전용 짙은 글자 ──────────────────────────
console.log('\n[4] #06231d·#08110f 를 쓰는 규칙마다 같은 선택자의 라이트 덮어쓰기가 있다');
const DARK_INK = /#06231d|#08110f/i;
/** 선택자를 칸(compound)으로 — 칸마다 앞 잇개(' ' > + ~), :not(…) 을 뺀 토큰 모음, :not(…) 모음 */
function selParts(sel) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let comb = '';
  const push = () => {
    if (!cur) return;
    const nots = [];
    const bare = cur.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, (m) => { nots.push(m.replace(/\s+/g, '')); return ''; });
    const toks = bare.match(/[.#]?[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^()]*\))?|\*/g) || [];
    parts.push({ comb: parts.length ? comb || ' ' : '', toks: new Set(toks), nots: new Set(nots) });
    cur = '';
    comb = '';
  };
  for (const ch of sel.trim()) {
    if (depth === 0 && /[\s>+~]/.test(ch)) { push(); if (!/\s/.test(ch)) comb = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    cur += ch;
  }
  push();
  return parts;
}
/** 라이트 선택자가 다크 선택자와 같은 요소를 «빠짐없이» 가리키는가 — 칸 수·잇개·토큰이 같고, 다크의 :not(…) 은 다 있다.
 *  라이트 쪽에 :not(…) 을 더 붙이는 것만 된다 (예: button.act:not(.ghost) — ghost 는 짙은 글자를 안 쓴다) */
const sameSel = (light, dark) => light.length === dark.length && dark.every((d, i) => {
  const l = light[i];
  return l.comb === d.comb && l.toks.size === d.toks.size && [...d.toks].every((t) => l.toks.has(t))
    && [...d.nots].every((t) => l.nots.has(t));
});
const kind = (prop) => (/^background/.test(prop) ? 'background' : prop);
const normSel = (s) => s.replace(/\s+/g, ' ').trim();
// 같은 선택자가 아니어도 되는 곳 — 짙은 글자가 실제로 보이는 상태만 덮어도 되는 까닭이 있어야 한다.
// [창, 다크 선택자, 속성, 라이트 선택자, 까닭, [그 까닭이 아직 참인지 볼 파일, 정규식]]
const NARROW_OK = [
  ['compose', '.prow .mark', 'color', '.prow.on .mark',
    '체크 글자(✓)는 고른 줄(.prow.on)에만 들어간다 — 안 고른 줄의 .mark 는 비어 있어 짙은 글자가 칠할 것이 없다',
    ['renderer/compose.js', /row\.className = 'prow' \+ \(chosen\.has\(c\.address\) \? ' on' : ''\);[\s\S]{0,200}mark\.textContent = chosen\.has\(c\.address\) \? '✓' : '';/]]
];
const narrowUsed = new Set();
for (const p of GLASS) {
  const rules = cssRules(styleOf(read(`renderer/${p}.html`)));
  const lights = rules.flatMap((r) => r.sels.filter((s) => s.startsWith(`${LIGHT} `))
    .map((s) => ({ sel: normSel(s.slice(LIGHT.length + 1)), parts: selParts(s.slice(LIGHT.length + 1)), decls: r.decls })));
  for (const r of rules) {
    for (const d of r.decls.filter((x) => DARK_INK.test(x.value))) {
      // 라이트 규칙이 같은 속성을 짙은 글자 아닌 값으로 칠한다
      const paints = (l) => l.decls.some((x) => kind(x.prop) === kind(d.prop) && !DARK_INK.test(x.value));
      for (const sel of r.sels.filter((s) => !s.startsWith(LIGHT))) {
        const want = selParts(sel);
        const hit = lights.find((l) => sameSel(l.parts, want) && paints(l));
        if (hit) {
          ok(true, `${p}.html — «${sel} { ${d.prop}: ${d.value} }» 에 라이트 «${hit.sel}» 덮어쓰기가 있다`);
          continue;
        }
        const ex = NARROW_OK.find((e) => e[0] === p && normSel(e[1]) === normSel(sel) && kind(e[2]) === kind(d.prop));
        if (!ex) {
          // 더 좁은 라이트 선택자(.foo.rare)는 흔한 상태(.foo)를 다크 글자로 남긴다
          ok(false, `${p}.html — «${sel} { ${d.prop}: ${d.value} }» 에 같은 선택자의 라이트 덮어쓰기가 있다`,
            { 비슷한_라이트: lights.filter(paints).map((l) => l.sel).slice(0, 4) });
          continue;
        }
        narrowUsed.add(ex);
        const exHit = lights.some((l) => l.sel === normSel(ex[3]) && paints(l));
        const still = ex[5][1].test(read(ex[5][0]));
        ok(exHit && still, `${p}.html — «${sel} { ${d.prop}: ${d.value} }» 는 정해 둔 좁은 덮어쓰기 «${ex[3]}» — ${ex[4]}`,
          exHit && still ? undefined : { 라이트_규칙: exHit, 까닭_그대로: still, 볼_파일: ex[5][0] });
      }
    }
  }
}
for (const ex of NARROW_OK) {
  ok(narrowUsed.has(ex), `좁은 덮어쓰기 예외 «${ex[0]}.html ${ex[1]} → ${ex[3]}» 가 아직 필요하다 (같은 선택자로 덮었거나 규칙이 없어졌으면 목록에서 뺀다)`);
}

// ── [5] 데이터 색을 인라인으로 박지 않는다 ────────────
console.log('\n[5] 인라인 색에는 var(…)·inherit 글자만 — 데이터 색은 --c·--type·--tint 같은 재료로만 넘긴다');
{
  /** 식의 맨 바깥 글자만 cb(i, ch) 로 — 문자열·템플릿·괄호 안은 건너뛴다. cb 가 false 면 멈춘다 */
  const scanTop = (s, cb) => {
    let depth = 0;
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') q = ch;
      else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (depth === 0 && cb(i, ch) === false) return;
    }
  };
  // 삼항식의 ? — 옵셔널 체이닝(?.)·?? 는 뺀다
  const isTernaryQ = (s, i) => s[i] === '?' && s[i + 1] !== '.' && s[i + 1] !== '?' && s[i - 1] !== '?';
  /** 인라인에 넣어도 되는 값인가 — 테마 규칙이 푸는 글자(var(…)·inherit)나 지우기('')만. 삼항식이면 갈래마다 본다 */
  const allowedValue = (expr, prop) => {
    const e = expr.trim();
    let qi = -1;
    scanTop(e, (i) => { if (isTernaryQ(e, i)) { qi = i; return false; } return true; });
    if (qi >= 0) {
      // 조건은 무엇이든 된다. 이 ? 에 짝인 : 를 찾아 두 갈래를 따로 본다
      const rest = e.slice(qi + 1);
      let nest = 0;
      let ci = -1;
      scanTop(rest, (i, ch) => {
        if (isTernaryQ(rest, i)) nest++;
        else if (ch === ':') { if (nest === 0) { ci = i; return false; } nest--; }
        return true;
      });
      return ci >= 0 && allowedValue(rest.slice(0, ci), prop) && allowedValue(rest.slice(ci + 1), prop);
    }
    const lit = e.match(/^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$|^`([^`]*)`$/);
    if (!lit) return false; // 이름·호출·더하기 — 무엇이 들어올지 모른다
    const text = lit[1] ?? lit[2] ?? lit[3];
    const head = text.split('${')[0];
    if (text === '') return true; // 지우기 — 스타일시트 값으로 돌아간다
    if (/^var\(/.test(head) || /^inherit\b/.test(head)) return true;
    // 휴식 화면 배경 그림 — 색이 아니라 그림 주소다
    return /^background-?image$/i.test(prop) && /^url\(/.test(head);
  };
  /** 부르기의 인자들 — from 은 여는 괄호 바로 뒤. 맨 바깥 쉼표로 자른다 */
  const argsAt = (src, from) => {
    const body = rhsAt(src, from);
    const cuts = [];
    scanTop(body, (i, ch) => { if (ch === ',') cuts.push(i); return true; });
    return [-1, ...cuts].map((c, k) => body.slice(c + 1, k < cuts.length ? cuts[k] : undefined).trim());
  };
  // 공용 색 이름(tokens.css)을 인라인으로 박으면 라이트 블록을 이긴다 — --accent 만이 아니다
  const TOKEN_NAMES = new Set([...Object.keys(TOK_DEFAULT), ...Object.keys(TOK_LIGHT)]);
  const colorProp = (name) => /^(color|background(-[\w-]+)?|fill|stroke)$/i.test(name) || TOKEN_NAMES.has(name);

  // 정해 둔 예외 — [스크립트 이름, 오른쪽 식의 앞머리, 까닭, 그 까닭이 아직 참인지 볼 정규식(같은 스크립트에서)]
  const INLINE_OK = [
    ['renderer/stats.html <script>', '`color-mix(in srgb, ${accent} ',
      "잔디 칸 진하기 — accent 는 load() 에서 늘 'var(--accent)' 라 색은 테마 규칙이 푼다. 박는 것은 섞는 비율(%)뿐",
      /const accent = 'var\(--accent\)';/]
  ];
  const inlineUsed = new Set();
  const inline = [];
  const props = [];
  const judge = (s, what, prop, value, list) => {
    if (allowedValue(value, prop)) return;
    const ex = INLINE_OK.find((x) => x[0] === s.name && value.trim().startsWith(x[1]));
    if (ex && ex[3].test(s.src)) { inlineUsed.add(ex); return; }
    list.push(`${s.name}: ${what} ${value.replace(/\s+/g, ' ').slice(0, 70)}`);
  };
  for (const s of scripts) {
    for (const m of s.src.matchAll(/\.style\.(color|background\w*|fill|stroke)\s*=(?!=)/g)) {
      judge(s, `.style.${m[1]} =`, m[1], rhsAt(s.src, m.index + m[0].length), inline);
    }
    for (const m of s.src.matchAll(/\.style\.setProperty\(\s*(['"`])([^'"`]+)\1\s*,/g)) {
      if (!colorProp(m[2])) continue;
      const args = argsAt(s.src, m.index + m[0].indexOf('(') + 1);
      judge(s, `.style.setProperty('${m[2]}',`, m[2], args[1] || '', props);
    }
  }
  ok(!inline.length, 'style.color / style.background* / style.fill / style.stroke 에 var(…)·inherit 아닌 값을 넣지 않는다',
    inline.length ? inline : undefined);
  ok(!props.length, "setProperty('color'·'background*'·'fill'·'stroke'·공용 이름(--accent 등), …) 에 var(…)·inherit 아닌 값을 넣지 않는다 — 통계는 --type 으로 넘긴다",
    props.length ? props : undefined);
  for (const ex of INLINE_OK) {
    ok(inlineUsed.has(ex), `인라인 예외 «${ex[0]} ${ex[1]}…» 가 아직 필요하고 까닭이 그대로다 (${ex[2]})`);
  }
}

// ── [6] --secondary-label ───────────────────────────
console.log('\n[6] var(--secondary-label) 은 정의를 받는다');
ok(!!TOK_DEFAULT['--secondary-label'], 'tokens.css :root 가 --secondary-label 기본값을 둔다', TOK_DEFAULT['--secondary-label']);
for (const h of rendererHtml) {
  if (!/var\(--secondary-label\)/.test(h.html)) continue;
  const html = noHtmlComments(h.html);
  ok(/href="tokens\.css"/.test(html) || /--secondary-label\s*:/.test(styleOf(html)), `${h.name} — 쓰는 곳에 정의가 있다`);
}

// ── [7] tokens.css 라이트 값의 대비 ───────────────────
console.log('\n[7] tokens.css 라이트 글자색 — 가장 나쁜 유리에서 4.5:1 + 3% 여유');
{
  // WCAG 2.x, sRGB 에서 겹쳐 칠한다 (scratchpad 의 설계 계산과 같은 방식)
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (rgb, a, bg) => rgb.map((v, i) => v * a + bg[i] * (1 - a));
  const parse = (s, alphaVar) => {
    const h = s.match(/^#([0-9a-f]{6})$/i);
    if (h) return { rgb: [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)), a: 1 };
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*(var\(--scrim-a\)|[\d.]+)\s*)?\)$/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : /var\(--scrim-a\)/.test(m[4]) ? alphaVar : Number(m[4]);
    return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a };
  };
  // 라이트 유리 바닥은 메인이 정한다 (src/win.js SCRIM.lightFloor) — 그 값을 그대로 쓴다
  const floor = Number((read('src/win.js').match(/lightFloor:\s*([\d.]+)/) || [])[1]);
  ok(floor >= 0.85 && floor < 1, `src/win.js 의 라이트 바닥을 읽었다 (${floor})`);
  const scrim = parse(TOK_LIGHT['--scrim'] || '', floor);
  const fill = parse(TOK_LIGHT['--fill'] || '', 1);
  ok(!!scrim && !!fill, 'tokens.css 의 --scrim·--fill 을 읽었다', { scrim: TOK_LIGHT['--scrim'], fill: TOK_LIGHT['--fill'] });
  if (scrim && fill) {
    const glass = over(scrim.rgb, scrim.a, [17, 17, 17]);
    const onFill = over(fill.rgb, fill.a, glass);
    const HEAD = 1.03;
    const text = ['--label', '--secondary', '--tertiary', '--accent', '--danger', '--sun', '--up', '--dn', '--unread'];
    for (const n of text) {
      const c = parse(TOK_LIGHT[n] || '', 1);
      if (!c) { ok(false, `${n} 를 읽었다`, TOK_LIGHT[n]); continue; }
      // R1 — 반투명 글자는 반투명 유리 위에서 대비가 두 번 깎인다. --label(검정 .90)만 예전 그대로 둔다
      if (n !== '--label') ok(c.a === 1 && /^#/.test(TOK_LIGHT[n]), `${n} ${TOK_LIGHT[n]} — 알파 없는 불투명 색`);
      const g = ratio(over(c.rgb, c.a, glass), glass);
      const f = ratio(over(c.rgb, c.a, onFill), onFill);
      ok(g >= 4.5 * HEAD && f >= 4.5 * HEAD, `${n} ${TOK_LIGHT[n]} — 유리 ${g.toFixed(2)}, 채움 위 ${f.toFixed(2)} (필요 ${(4.5 * HEAD).toFixed(3)})`);
    }
    const af = parse(TOK_LIGHT['--accent-fill'] || '', 1);
    const danger = parse(TOK_LIGHT['--danger'] || '', 1);
    const idle = parse(TOK_LIGHT['--bar-idle'] || '', 1);
    if (af) {
      ok(ratio([255, 255, 255], af.rgb) >= 4.5 * HEAD, `#fff 글자 on --accent-fill ${TOK_LIGHT['--accent-fill']} — ${ratio([255, 255, 255], af.rgb).toFixed(2)}`);
      ok(ratio(af.rgb, glass) >= 3 * HEAD, `--accent-fill 채움이 유리와 갈린다 — ${ratio(af.rgb, glass).toFixed(2)} (필요 ${(3 * HEAD).toFixed(2)})`);
    }
    if (danger) ok(ratio([255, 255, 255], danger.rgb) >= 4.5 * HEAD, `#fff 글자 on --danger — ${ratio([255, 255, 255], danger.rgb).toFixed(2)}`);
    if (idle) {
      const r = ratio(over(idle.rgb, idle.a, glass), glass);
      ok(r >= 3 * HEAD, `--bar-idle 막대가 유리와 갈린다 — ${r.toFixed(2)} (필요 ${(3 * HEAD).toFixed(2)})`);
    }
  }
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

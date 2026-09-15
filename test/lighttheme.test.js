// 유리 창 여덟 개가 라이트·다크 색 이름을 제대로 받는가 — 화면 밖(offscreen) 창에서 «계산된 값»을 잰다.
//
// 라이트 색은 renderer/tokens.css 한 곳에서 정하고, 테마·유리 진하기는 renderer/theme.js 가 입힌다.
// 페이지에 옛 라이트 블록이 남거나 싣는 순서가 틀어지면 파일만 봐서는 모른다 (theme-guard.test.js 는 파일을 본다).
//   · ?theme=light 로 열면 공용 이름이 tokens.css 값과 같다 (설정·위젯은 정해 둔 예외만 다르다)
//   · ?theme=dark 로 열면 바꾸기 전(9478dd4)에 찍어 둔 다크 값 그대로다 (test/fixtures/lighttheme-dark-9478dd4.json).
//     일부러 바꾼 다크 값은 DARK_CHANGES 에 새 값과 까닭을 적은 것만 다르다 — 라이트 값이 새지 않고, 다크가 조용히 안 바뀐다
//   · --scrim-a 는 주소에 실린 칠할 값(src/win.js effScrim)이고, 유리색 --scrim 의 알파도 그 값이다
//   · 'glass' 방송(onGlass)이 오면 다시 열지 않고 테마·진하기가 바뀌고, 다시 오면 되돌아온다. 빈 방송은 무시한다
//   · 설정 창: 라이트에서 90 아래는 라벨에 «· 라이트 90%», 테마가 바뀌면 라벨도 따라간다.
//     슬라이더를 끄는 동안 미리보기는 한 프레임에 한 번만 나간다
//   · tokens.css·theme.js 가 CSP 에 막히지 않고, theme.js 가 오류를 내지 않는다
// 앱(main.js)은 안 띄운다 — 사용자 모니터에는 아무것도 안 뜬다. 주소는 진짜 src/win.js glassQuery 로 만들고,
// 방송도 진짜 glassState 모양 그대로 보낸다. preload 대신 test/fixtures/glass-bridge-stub.js 를 쓴다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 420_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lighttheme-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const until = async (fn, ms = 5000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

// ── 기대값: 파일에서 읽는다 ─────────────────────────
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const varsIn = (css, selRe) => {
  const m = css.match(selRe);
  const out = {};
  if (!m) return out;
  for (const d of m[1].split(';')) {
    const i = d.indexOf(':');
    if (i > 0 && d.slice(0, i).trim().startsWith('--')) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
};
const ROOT_RE = /(?:^|\n)\s*:root\s*\{([^}]*)\}/;
const LIGHT_RE = /:root\[data-theme="light"\]\s*\{([^}]*)\}/;
const tokensCss = noComments(fs.readFileSync(path.join(ROOT, 'renderer', 'tokens.css'), 'utf8'));
const TOK_DEFAULT = varsIn(tokensCss, ROOT_RE);
const TOK_LIGHT = varsIn(tokensCss, LIGHT_RE);
const NAMES = [...new Set([...Object.keys(TOK_LIGHT), ...Object.keys(TOK_DEFAULT)])];
const pageDark = (file) => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => noComments(m[1])).join('\n');
  return varsIn(css, ROOT_RE);
};

// 창마다 일부러 다르게 둔 라이트 값 — 설정은 파랑을 지키고 판을 회색으로, 위젯은 칩 모양을 지키는 진한 채움
const PAGE_LIGHT = {
  settings: { '--accent': '#005ecb', '--accent-fill': '#007aff', '--scrim': 'rgba(242, 242, 247, var(--scrim-a))' },
  widget: { '--fill': 'rgba(120, 120, 128, 0.18)', '--fill-hi': 'rgba(120, 120, 128, 0.32)', '--bar-idle': 'rgba(60, 60, 67, 0.64)' }
};

// 메인이 실제로 넘기는 것과 같은 모양의 추가 주소 값. dense 는 글이 빽빽한 창(설정·주식)
const PAGES = [
  { id: 'widget', file: 'widget.html', extra: { radius: '26' } },
  { id: 'settings', file: 'settings.html', extra: { radius: '20', dense: '1', tab: 'app' } },
  { id: 'stats', file: 'stats.html', extra: { radius: '20' } },
  { id: 'stocks', file: 'stocks.html', extra: { radius: '18', dense: '1' } },
  { id: 'compose', file: 'compose.html', extra: { radius: '20' } },
  { id: 'mailview', file: 'mailview.html', extra: { radius: '20' } },
  { id: 'popup', file: 'popup.html', extra: {} },
  { id: 'chart', file: 'chart.html', extra: { radius: '16' } }
];

// ── 다크 기대값: 지금 파일이 아니라 바꾸기 전(9478dd4)에 찍어 둔 값 ──
// 지금 파일에서 읽으면 누가 페이지 :root 나 tokens.css 기본값을 바꿔도 기대값이 같이 바뀌어 시험이 못 잡는다.
const DARK_SNAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lighttheme-dark-9478dd4.json'), 'utf8'));

// 9478dd4 에 없던 tokens.css :root 기본값 (글자 그대로 박는다 — tokens.css 에서 읽으면 기본값이 바뀌어도 모른다).
// 그 창이 이 이름을 한 번도 읽지 않으면 새로 생겨도 화면은 그대로라 따로 적지 않는다. 읽는 창은 DARK_CHANGES 에 적는다.
const NEW_DEFAULTS = {
  '--accent-fill': 'var(--accent)',
  '--tint-ink': 'color-mix(in srgb, var(--tint, #5ecfb6) 86%, white)',
  '--tint-fill': 'oklch(from var(--tint, #5ecfb6) 0.50 c h)',
  '--quaternary': 'var(--tertiary)',
  '--secondary-label': 'var(--secondary)',
  '--separator': 'var(--hairline)'
};

// 일부러 바꾼 다크 값 — [새 값(글자 그대로), 까닭]. 여기 없는 이름은 9478dd4 스냅숏과 같아야 한다.
const DARK_CHANGES = {
  widget: {
    '--separator': ['var(--hairline)', '정의 없이 쓰던 이름 (9478dd4 widget.html .macts) — 다크 메일 계정 줄 밑줄이 이제 그려진다 (design §7)'],
    '--tint-fill': [NEW_DEFAULTS['--tint-fill'], '지금 쉬기·.upchip.armed 의 흰 글자 채움 — 검정 섞은 틴트 위 2.58~3.22 가 두 테마 모두 5.49 로 (design §7)'],
    '--tint-ink': [NEW_DEFAULTS['--tint-ink'], '라이트 규칙에서만 읽는다. 다크 기본값은 예전 다크 틴트 글자 color-mix(tint 86%, white) 와 같다']
  },
  settings: {
    '--secondary-label': ['var(--secondary)', '정의 없이 쓰던 이름 (9478dd4 settings.html 344·368·448) — 이제 --secondary 로 보인다 (design §7)'],
    '--fill': ['rgba(255, 255, 255, 0.08)', '정의 없이 쓰던 이름 (9478dd4 settings.html 279·297) — 이제 옅은 채움이 그려진다 (design §7)'],
    '--danger': ['#ff8f8f', '.msg.bad 글자 #ff9a9a·지우기 칩·bookMsg 를 한 이름으로 — 같은 분홍 (design §7). 예전 --sun 은 여전히 정의 없음'],
    '--accent-fill': ['var(--accent)', '스위치·슬라이더·탭 채움이 --accent 대신 이 이름을 읽는다 — 다크는 --accent 그대로라 같은 색']
  },
  stats: { '--accent-fill': ['var(--accent)', '라이트 흰 글자 채움용 이름 — 다크는 --accent 그대로'] },
  stocks: { '--accent-fill': ['var(--accent)', '라이트 흰 글자 채움용 이름 — 다크는 --accent 그대로'] },
  compose: { '--accent-fill': ['var(--accent)', '라이트 흰 글자 채움용 이름 — 다크는 --accent 그대로'] },
  chart: { '--accent-fill': ['var(--accent)', '라이트 흰 글자 채움용 이름 — 다크는 --accent 그대로'] },
  popup: {
    '--accent-fill': ['var(--accent)', '.btn.go 채움이 이 이름을 읽는다 — 다크는 --accent 그대로라 같은 색'],
    '--quaternary': ['var(--tertiary)', '라이트 .item.off 에서만 읽는다 — 다크 기본값은 --tertiary 와 같다']
  },
  mailview: { '--unread': ['#f5a623', '.seen.unread 에 박혀 있던 #f5a623 을 이름으로 — 라이트가 덮을 수 있게. 다크는 같은 색'] }
};

/** 그 창(html + 제 스크립트)이 이름을 읽는가 — var(--x) · var(--x, …) · '--x' */
const pageReads = (file) => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s !== 'theme.js' && !s.startsWith('anim/'));
  const text = [html, ...srcs.map((s) => fs.readFileSync(path.join(ROOT, 'renderer', s), 'utf8'))].join('\n');
  return new Set(NAMES.filter((n) => [`var(${n})`, `var(${n},`, `'${n}'`, `"${n}"`].some((t) => text.includes(t))));
};

/** 이름 → 기대 값(글자 그대로, 페이지 안에서 풀어 비교). null = 정의가 없어야 한다 */
function expected(P, theme) {
  const dark = pageDark(P.file);
  const out = {};
  if (theme === 'light') {
    for (const n of NAMES) out[n] = (PAGE_LIGHT[P.id] || {})[n] ?? TOK_LIGHT[n] ?? dark[n] ?? TOK_DEFAULT[n];
    return out;
  }
  const snap = DARK_SNAP.pages[P.id] || {};
  const own = DARK_CHANGES[P.id] || {};
  const reads = pageReads(P.file);
  for (const n of NAMES) {
    if (own[n]) out[n] = own[n][0];
    else if (snap[n] === null && NEW_DEFAULTS[n] && !reads.has(n)) out[n] = NEW_DEFAULTS[n];
    else out[n] = snap[n] ?? null;
  }
  return out;
}

// 스냅숏·예외 목록이 시험이 읽는 이름을 다 덮는가 — 창을 띄우기 전에 본다
{
  console.log('\n[다크 스냅숏]');
  for (const P of PAGES) {
    const snap = DARK_SNAP.pages[P.id];
    const missing = snap ? NAMES.filter((n) => !(n in snap)) : NAMES;
    ok(!missing.length, `${P.id} — 이름 ${NAMES.length}개가 모두 9478dd4 스냅숏에 있다 (없는 이름은 스냅숏을 다시 찍거나 DARK_CHANGES 에 적는다)`,
      missing.length ? missing : undefined);
    const own = DARK_CHANGES[P.id] || {};
    const reads = pageReads(P.file);
    const unexplained = Object.entries(own).filter(([, v]) => !Array.isArray(v) || v.length !== 2 || !v[0] || !String(v[1]).trim()).map(([n]) => n);
    ok(!unexplained.length, `${P.id} — 다크 변경 ${Object.keys(own).length}개마다 새 값과 까닭이 있다`, unexplained.length ? unexplained : undefined);
    // 창이 읽지도 않는데 적어 둔 기본값 예외는 낡은 것이다
    const stale = Object.keys(own).filter((n) => snap && snap[n] === null && NEW_DEFAULTS[n] === own[n][0] && !reads.has(n));
    ok(!stale.length, `${P.id} — 읽지 않는 이름을 DARK_CHANGES 에 남겨 두지 않았다`, stale.length ? stale : undefined);
  }
}

// 페이지 안에서 — 같은 자리(html 바로 밑)의 탐침에 var(--이름)과 기대 글자를 각각 칠해 계산된 색끼리 비교한다.
// 글자 그대로 비교하면 공백·var() 풀림 차이로 거짓 실패가 난다.
const READ = (want) => `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const probe = document.createElement('i');
  root.appendChild(probe);
  const res = (v) => { probe.style.color = ''; probe.style.color = v; return getComputedStyle(probe).color; };
  const out = { theme: root.dataset.theme, scrimA: root.style.getPropertyValue('--scrim-a').trim(), bad: [] };
  for (const [n, w] of Object.entries(${JSON.stringify(want)})) {
    const raw = cs.getPropertyValue(n).trim();
    // 기대 글자가 없는 이름을 가리키면(예: --accent 가 없는 위젯의 var(--accent)) 계산된 값도 비어 있어야 한다
    probe.style.setProperty('--want', w === null ? 'var(--이름-없음)' : w);
    if (!getComputedStyle(probe).getPropertyValue('--want').trim()) {
      if (raw) out.bad.push({ n, want: w === null ? '(정의 없음)' : w + ' (풀면 없음)', raw });
      continue;
    }
    const got = res('var(' + n + ')');
    const exp = res(w);
    if (!raw || got !== exp) out.bad.push({ n, want: w, exp, got, raw });
  }
  out.scrim = res('var(--scrim)');
  out.tokensLinked = [...document.styleSheets].some((s) => /\\/tokens\\.css$/.test(s.href || ''));
  probe.remove();
  return out;
})()`;
const alphaOf = (c) => { const m = String(c).match(/rgba\([^)]*,\s*([\d.]+)\)/); return m ? Number(m[1]) : 1; };
const scrimOk = (s, want) => Number(s.scrimA) === want && Math.abs(alphaOf(s.scrim) - want) < 0.006;

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  const win = require(path.join(ROOT, 'src', 'win.js'));

  let current = {};
  ipcMain.on('stub:glass', (e) => { e.returnValue = current; });
  const setTheme = async (t) => {
    nativeTheme.themeSource = t;
    await until(() => nativeTheme.shouldUseDarkColors === (t === 'dark'), 2000, 20);
  };
  // 설정 창의 'settings:get' 과 같은 꼴 — 이 시험과 상관없는 칸은 비워 둔다
  const settingsData = (raw) => ({
    settings: { ...store.settings, scrim: raw, autoLaunch: false },
    reminders: store.reminders,
    custom: store.custom,
    calendars: [],
    enterCustom: [],
    calendarStatus: {},
    dndPresets: [],
    update: null,
    types: reminders.TYPES.map((t) => ({ id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind, headline: t.headline }))
  });
  const label = (v, theme) => (theme === 'light' && v < 90 ? `${v}% · 라이트 90%` : `${v}%`);

  for (const P of PAGES) {
    console.log(`\n[${P.id}]`);
    const w = new BrowserWindow({ show: false, width: 480, height: 720,
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'glass-bridge-stub.js'),
        contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    const csp = [];
    const themeErr = [];
    w.webContents.on('console-message', (_e, level, msg, _line, src) => {
      const m = String(msg);
      if (/Content Security Policy|Refused to/i.test(m)) csp.push(m.slice(0, 160));
      else if (level >= 2 && (/theme\.js$/.test(String(src || '')) || /tokens\.css|theme\.js/.test(m))) themeErr.push(m.slice(0, 160));
    });
    const js = (c) => w.webContents.executeJavaScript(c);
    const load = async (query) => {
      let last = null;
      for (let k = 0; k < 3; k++) {
        try { await w.loadFile(path.join(ROOT, 'renderer', P.file), { query }); return; } catch (e) { last = e; await sleep(300); }
      }
      throw last;
    };
    const dense = P.extra.dense === '1';

    for (const theme of ['light', 'dark']) {
      const other = theme === 'light' ? 'dark' : 'light';
      for (const raw of [0.40, 0.92, 0.98]) {
        await setTheme(theme);
        store.setSettings({ scrim: raw });
        current = P.id === 'settings' ? { settings: settingsData(raw) } : {};
        const query = win.glassQuery(P.extra);
        const wantA = win.effScrim(raw, theme === 'dark', dense);
        await load(query);

        const s1 = await js(READ(expected(P, theme)));
        ok(s1.theme === theme && scrimOk(s1, wantA) && s1.tokensLinked && !s1.bad.length,
          `${theme} · 저장 ${raw} → ?scrim=${query.scrim} · --scrim-a ${s1.scrimA} · 유리 알파 ${alphaOf(s1.scrim)} · 색 이름 ${NAMES.length}개가 ${theme === 'light' ? 'tokens.css' : `9478dd4 다크 (정해 둔 변경 ${Object.keys(DARK_CHANGES[P.id] || {}).length}개)`} 값`,
          s1.theme !== theme || !scrimOk(s1, wantA) || !s1.tokensLinked || s1.bad.length
            ? { theme: s1.theme, scrimA: s1.scrimA, scrim: s1.scrim, wantA, tokensLinked: s1.tokensLinked, bad: s1.bad.slice(0, 4) } : undefined);

        // 윈도우 앱 모드가 바뀌었다 — 메인은 새 테마로 glassState 를 계산해 보낸다 (다른 저장값으로 진하기도 바뀌게)
        await setTheme(other);
        const g = win.glassState(0.5);
        const wantB = dense ? g.scrimDense : g.scrim;
        const heard = await js(`window.__glass(${JSON.stringify(g)})`);
        await sleep(0);
        const s2 = await js(READ(expected(P, other)));
        await setTheme(theme);
        const g2 = win.glassState(raw);
        await js(`window.__glass(null); window.__glass(${JSON.stringify(g2)})`);
        const s3 = await js(READ(expected(P, theme)));
        ok(heard === 1 && s2.theme === other && scrimOk(s2, wantB) && !s2.bad.length
          && s3.theme === theme && scrimOk(s3, wantA) && !s3.bad.length,
          `  방송 ${JSON.stringify(g)} → ${other} · --scrim-a ${s2.scrimA}, 되돌림 → ${theme} · ${s3.scrimA} (다시 열지 않음)`,
          heard === 1 && !s2.bad.length && !s3.bad.length && scrimOk(s2, wantB) && scrimOk(s3, wantA) ? undefined
            : { heard, s2: { theme: s2.theme, scrimA: s2.scrimA, scrim: s2.scrim, wantB, bad: s2.bad.slice(0, 3) },
              s3: { theme: s3.theme, scrimA: s3.scrimA, bad: s3.bad.slice(0, 3) } });

        if (P.id === 'settings') {
          // 라벨 — 실제로 칠하는 값을 같이 적고, 앱 모드가 바뀌면 다시 열지 않아도 붙였다 뗀다
          const v = Math.round(raw * 100);
          const outText = () => js("document.getElementById('out-scrim').textContent");
          const l1 = await until(async () => { const t = await outText(); return t ? t : null; });
          await js(`window.__glass(${JSON.stringify(g)})`);
          const l2 = await until(async () => { const t = await outText(); return t === label(v, other) ? t : null; }, 1000);
          await js(`window.__glass(${JSON.stringify(g2)})`);
          const l3 = await until(async () => { const t = await outText(); return t === label(v, theme) ? t : null; }, 1000);
          ok(l1 === label(v, theme) && l2 === label(v, other) && l3 === label(v, theme),
            `  유리 진하기 라벨 «${l1}» → ${other} «${l2}» → ${theme} «${l3}»`, { want: [label(v, theme), label(v, other), label(v, theme)] });
        }
      }
    }

    if (P.id === 'settings') {
      // 끄는 동안의 미리보기 — 한 프레임에 여러 번 움직여도 마지막 값 하나만 나간다. 저장(setApp)은 놓을 때만
      await setTheme('light');
      store.setSettings({ scrim: 0.92 });
      current = { settings: settingsData(0.92) };
      await load(win.glassQuery(P.extra));
      await until(() => js("document.getElementById('out-scrim').textContent"));
      const pv = await js(`(async () => {
        window.__preview.length = 0;
        window.__setApp = [];
        const el = document.getElementById('scrim');
        for (const v of [56, 58, 60]) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
        await new Promise((r) => setTimeout(r, 300));
        const sent = window.__preview.slice();
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { sent, saved: window.__setApp.slice(), out: document.getElementById('out-scrim').textContent };
      })()`);
      ok(JSON.stringify(pv.sent) === '[0.6]' && pv.out === '60% · 라이트 90%',
        '끄는 동안 previewScrim 이 한 프레임에 한 번, 마지막 값(0.6)으로 나간다 — 라벨도 따라간다', pv);
      ok(pv.saved.length === 1 && pv.saved[0].scrim === 0.6, '놓으면(change) 그때 저장한다', pv.saved);
    }

    ok(!csp.length, `${P.file} — CSP 위반 없음 (tokens.css·theme.js 가 막히지 않는다)`, csp.length ? csp.slice(0, 3) : undefined);
    ok(!themeErr.length, `${P.file} — theme.js·tokens.css 쪽 콘솔 오류 없음`, themeErr.length ? themeErr.slice(0, 3) : undefined);
    w.destroy();
  }

  nativeTheme.themeSource = 'system';
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

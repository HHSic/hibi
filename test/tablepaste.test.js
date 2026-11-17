'use strict';
// 지킴이 — 무엇보다 먼저 (불러오다 터지면 Electron 이 사용자 화면에 오류 창을 띄운다 — 띄우지 않고 실패로 끝낸다)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
require('electron').dialog.showErrorBox = () => {};
// 메일 쓰기 창에 표 붙여넣기 — 진짜 renderer/compose.html 에 가짜 붙여넣기를 넣어 본다.
//
// 예전엔 엑셀·구글 시트·워드·한글에서 표를 복사해 붙이면 탭으로 이은 글만 들어갔다. 이제 표로 넣는다:
//   [1] 엑셀 365 → 표 하나 (같이 실려 온 그림은 버린다), class·mso·글꼴 없음, 테두리·합친 칸은 그대로, 숨긴 열은 빠진다,
//       알림 «표를 붙였습니다 (4×3)», 커서는 표 바로 뒤, Ctrl+Z 한 번에 표가 빠진다, 임시 저장에도 표가 간다
//   [2] 구글 시트 · [3] 워드 · [4] 한글 · [5] 보통 웹 표 — 각자의 꼴에서 남길 것만
//   [6] 나쁜 HTML — 바깥 주소·실행되는 것은 하나도 안 남고, 붙이는 동안 바깥으로 나가는 요청이 없다
//   [7] 엑셀 빈 칸 — 테두리 없는 빈 칸은 예전처럼 표를 안 넣는다, 테두리를 그은 빈 칸은 빈 표 틀로
//   [8] 커서가 표 칸 안 → 글로 (표 안에 표를 만들지 않는다)
//   [9] Ctrl+Shift+V → 글로 (글이 없으면 보통 붙여넣기), 키 표시는 다음 붙여넣기 하나만 · 1초 뒤엔 사라진다
//  [10] 큰 표 (2000칸 넘음 · 100만 글자 넘음) → 글로 + «표가 커서 글로 붙였습니다 (n칸)»
//  [11] 보낼 때 (bodyForSend) — 표와 인라인 스타일이 그대로, 글 몫(plainText)은 탭·줄로 나뉜다
//  [12] 표 둘 → «표 2개를 붙였습니다»
//
// 사용자 모니터에는 아무것도 안 뜬다 — 창은 숨김·화면 밖(offscreen)이다. 앱(main.js)은 안 띄운다.
// preload 대신 test/fixtures/compose-bridge-stub.js — 보내기·임시 저장 부탁은 기록만 하고 메인에 안 간다.
// 진짜 클립보드는 안 건드린다 — 붙여넣기는 화면 안에서 만든 DataTransfer 를 실은 ClipboardEvent 로만, 키는 KeyboardEvent 로만 흉내 낸다.
// 바깥으로 나가는 요청은 이 창의 세션에서 모두 막고 센다 (file:·data: 만 통과).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const C = require('./fixtures/table-clips.js');

setTimeout(() => { console.error('시간 초과'); app.exit(1); }, 300_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tablepaste-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

// npm test 는 실패 줄만 보여 준다 — TABLE_TEST_LOG 에 파일을 주면 모든 줄을 거기에도 적는다
if (process.env.TABLE_TEST_LOG) {
  for (const k of ['log', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      try { fs.appendFileSync(process.env.TABLE_TEST_LOG, `${a.map(String).join(' ')}\n`); } catch { /* 적지 못해도 시험은 간다 */ }
      orig(...a);
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${s.length > 300 ? `${s.slice(0, 300)}…` : s}` : ''));
  if (!c) bad++;
};
const until = async (fn, ms = 8000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

const BASE = {
  accountId: 'a1', title: '새 메일', to: 'friend@example.invalid', subject: '시험', signature: '',
  accounts: [{ id: 'a1', name: '시험 계정', from: 'me@example.invalid' }], attachments: []
};

// 화면 안에서 쓰는 도구 — 붙여넣기·키 흉내, 커서 놓기, 표 읽기
const HELP = `(() => {
  const body = document.getElementById('body');
  const attrsOf = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  // 표 하나를 읽기 쉬운 꼴로 — 칸마다 태그·글·style·속성, 칸 안의 HTML
  const tableOf = (t, live) => ({
    attrs: attrsOf(t),
    cols: [...t.querySelectorAll(':scope > colgroup > col, :scope > col')].map(attrsOf),
    caption: t.caption ? t.caption.textContent : null,
    rows: [...t.rows].filter((r) => r.closest('table') === t).map((r) => ({ attrs: attrsOf(r), cells: [...r.cells].map((c) => {
      const o = { tag: c.tagName, text: c.textContent, inner: c.innerHTML, style: c.getAttribute('style') || '', attrs: attrsOf(c) };
      if (live) {
        const cs = getComputedStyle(c);
        o.cs = { bt: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor, br: cs.borderRightWidth + ' ' + cs.borderRightStyle,
          bb: cs.borderBottomWidth + ' ' + cs.borderBottomStyle, bl: cs.borderLeftWidth + ' ' + cs.borderLeftStyle,
          bg: cs.backgroundColor, fw: cs.fontWeight, ta: cs.textAlign, ws: cs.whiteSpace, color: cs.color, pad: cs.paddingTop + ' ' + cs.paddingLeft };
        // 테두리 두께는 적힌 값으로 본다 — 계산값은 화면 배율에 맞춰 기기 픽셀로 깎인다 (배율 1.5 에서 1px → 0.666667px)
        const sp = c.style;
        o.sp = { bt: sp.borderTopWidth + ' ' + sp.borderTopStyle + ' ' + sp.borderTopColor, bl: sp.borderLeftWidth + ' ' + sp.borderLeftStyle,
          bb: sp.borderBottomWidth + ' ' + sp.borderBottomStyle };
      }
      return o;
    }) }))
  });
  const read = (root, live) => ({
    html: root.innerHTML,
    tables: [...root.querySelectorAll('table')].filter((t) => !t.parentElement.closest('table')).map((t) => tableOf(t, live)),
    nested: root.querySelectorAll('table table').length,
    lines: [...root.children].filter((e) => e.tagName === 'DIV').map((d) => d.textContent)
  });
  window.__t = {
    async png(w, h) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, w, h);
      const b = await new Promise((res) => c.toBlob(res, 'image/png'));
      return new File([b], 'image.png', { type: 'image/png' });
    },
    paste({ text, html, files } = {}) {
      const dt = new DataTransfer();
      if (text !== undefined) dt.setData('text/plain', text);
      if (html !== undefined) dt.setData('text/html', html);
      for (const f of files || []) dt.items.add(f);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      body.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    // 키 누름 흉내 — 본문에 KeyboardEvent 만 보낸다 (진짜 키 입력도, 클립보드도 안 건드린다)
    key(o) {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...o });
      body.dispatchEvent(ev);
      return true;
    },
    ctrlShiftV(extra) { return this.key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, ...(extra || {}) }); },
    // 본문을 html (없으면 «가나다라» 한 줄)로 두고 커서를 sel 안의 글 at 자리에 (기본 #l1 의 «가나|다라»)
    reset(html, sel, at) {
      const doc = new DOMParser().parseFromString('<body>' + (html || '<div id="l1">가나다라</div>') + '</body>', 'text/html');
      body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
      body.focus();
      const host = body.querySelector(sel || '#l1');
      const t = host ? host.firstChild : null;
      const r = document.createRange();
      if (t && t.nodeType === 3) r.setStart(t, at === undefined ? (sel ? t.length : 2) : at);
      else if (host) r.setStart(host, 0); else r.setStart(body, 0);
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.getElementById('msg').textContent = '';
      document.getElementById('msg').className = 'msg';
      window.__calls.send.length = 0; window.__calls.draft.length = 0; window.__calls.drop.length = 0;
      return true;
    },
    body(live) { return read(body, live); },
    built(html) {
      const got = window.nunsTable.build(html);
      const doc = new DOMParser().parseFromString('<body>' + (got.html || '') + '</body>', 'text/html');
      return { got: { ok: got.ok, big: got.big, tables: got.tables, rows: got.rows, cols: got.cols, cells: got.cells, text: got.text, len: (got.html || '').length }, ...read(doc.body, false) };
    },
    imgs() { return body.querySelectorAll('img').length; },
    text() { return body.innerText; },
    seq() {
      const out = [];
      const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c.nodeValue); else if (c.nodeName === 'TABLE') out.push('[TABLE]'); else if (c.nodeName === 'IMG') out.push('[IMG]'); else walk(c); } };
      walk(body);
      return out.join('');
    },
    caret() {
      const s = getSelection(); const n = s.anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      return { inBody: !!(n && body.contains(n)), inCell: !!(el && el.closest('td,th')), text: n && n.nodeType === 3 ? n.nodeValue : (el ? el.tagName : null), off: s.anchorOffset,
        prevIsTable: !!(el && ((el.previousElementSibling && el.previousElementSibling.tagName === 'TABLE') || (n.nodeType === 1 && n.childNodes[s.anchorOffset - 1] && n.childNodes[s.anchorOffset - 1].nodeName === 'TABLE'))) };
    },
    msg() { const m = document.getElementById('msg'); return { kind: m.className, text: m.textContent }; }
  };
  return true;
})()`;

app.whenReady().then(async () => {
  let current = BASE;
  ipcMain.on('stub:compose', (e) => { e.returnValue = current; });

  // 바깥으로 나가는 요청을 센다 — file:·data: 말고는 다 막는다 (막아도 세어 둔다)
  const net = [];
  session.fromPartition('tablepaste').webRequest.onBeforeRequest((d, cb) => {
    const local = /^(file|data|devtools):/i.test(d.url);
    if (!local) net.push(d.url);
    cb({ cancel: !local });
  });

  const w = new BrowserWindow({
    show: false, width: 640, height: 760,
    webPreferences: { offscreen: true, partition: 'tablepaste', preload: path.join(__dirname, 'fixtures', 'compose-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false }
  });
  for (const k of ['show', 'showInactive', 'focus', 'moveTop', 'maximize']) w[k] = () => {};
  const wc = w.webContents;
  const js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(String(msg).slice(0, 200)); });

  async function open(payload) {
    current = payload;
    await w.loadFile(path.join(ROOT, 'renderer', 'compose.html'), { query: { radius: '20', theme: 'dark' } });
    const ready = await until(() => js(`document.getElementById('ttl').textContent === ${JSON.stringify(payload.title)}`));
    if (!ready) throw new Error('쓰기 창이 안 그려졌다');
    await js(HELP);
  }
  const J = (v) => JSON.stringify(v);
  const paste = (o) => js(`(async () => __t.paste({ text: ${J(o.text)}, html: ${J(o.html)}, files: ${o.png ? '[await __t.png(200, 60)]' : '[]'} }))()`);
  const OFF = /class=|mso|font-family|font-size|height|x:num|x:fmla|xl6|lang=|data-|on[a-z]+=|<img|<font|<o:p|<style|<col[^>]*style/i;

  await open(BASE);
  ok(await js(`typeof window.nunsTable === 'object' && typeof window.nunsTable.build === 'function'`), 'compose.html 이 pastetable.js 를 싣는다 (window.nunsTable)');
  ok(await js(`(() => { const s = [...document.scripts].map((x) => x.getAttribute('src')); return s.indexOf('pastetable.js') >= 0 && s.indexOf('pastetable.js') < s.indexOf('compose.js'); })()`),
    '  compose.js 보다 먼저 싣는다');
  const net0 = net.length;

  console.log('\n[1] 엑셀 365 → 표');
  await js('__t.reset()');
  const prevented = await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML, png: true });
  ok(prevented === true, '붙여넣기 기본 동작은 막는다');
  await sleep(300);
  let b = await js('__t.body(true)');
  ok(b.tables.length === 1 && b.nested === 0, '표 하나가 들어갔다', { tables: b.tables.length });
  ok((await js('__t.imgs()')) === 0, '  같이 실려 온 그림(비트맵)은 안 들어갔다');
  ok(!OFF.test(b.html), '  class·mso·글꼴·높이·x:num·<img>·<font>·<o:p> 가 하나도 없다', (b.html.match(OFF) || [])[0]);
  ok(!/숨김열|비밀/.test(b.html), '  숨긴 열(display:none)은 빠졌다');
  let m = await js('__t.msg()');
  ok(m.text === '표를 붙였습니다 (4×3)' && m.kind === 'msg', '  알림 «표를 붙였습니다 (4×3)»', m);
  const xt = b.tables[0] || { rows: [], cols: [], attrs: {} };
  const texts = xt.rows.map((r) => r.cells.map((c) => c.text));
  ok(JSON.stringify(texts) === JSON.stringify([['이름', '부서', '금액'], ['김민수', '영업1팀', '1,200,000'], ['홍길동', '800,000'], ['합계', '2,000,000']]),
    '  칸 글 그대로 (숨긴 열 없이, 합친 칸 그대로)', texts);
  const h0 = (xt.rows[0] || { cells: [] }).cells[0] || { cs: {}, attrs: {}, style: '' };
  ok(h0.sp && h0.sp.bt === '1px solid rgb(0, 0, 0)' && /^1px solid/.test(h0.sp.bl) && /solid rgb\(0, 0, 0\)$/.test(h0.cs.bt), '  머리 칸 테두리 .5pt solid windowtext → 1px 검정', { sp: h0.sp, cs: h0.cs.bt });
  ok(h0.cs.bg === 'rgb(255, 255, 0)' && h0.attrs.bgcolor === '#ffff00', '  채우기 색 → background-color + bgcolor="#ffff00"', { bg: h0.cs.bg, attr: h0.attrs.bgcolor });
  ok(h0.cs.fw === '700' && h0.cs.ta === 'center', '  굵게 · 가운데', { fw: h0.cs.fw, ta: h0.cs.ta });
  ok(/border/.test(h0.style) && /padding/.test(h0.style), '  테두리·안쪽 여백이 칸의 style 에 (메일 프로그램은 창 CSS 를 모른다)', h0.style);
  ok(h0.cs.pad === '4px 8px', '  안쪽 여백 4px 8px', h0.cs.pad);
  ok('nowrap' in h0.attrs && h0.cs.ws === 'nowrap', '  줄바꿈 안 함 (엑셀 td{white-space:nowrap}) → nowrap 속성', { attrs: h0.attrs, ws: h0.cs.ws });
  const h1 = (xt.rows[0] || { cells: [] }).cells[1] || { cs: {} };
  ok(h1.cs.bl && h1.cs.bl.startsWith('0px') && h1.sp && /^1px solid/.test(h1.sp.bt) && !/solid/.test(h1.sp.bl), '  인라인 border-left:none 은 class 규칙 위에서 이긴다', { cs: h1.cs, sp: h1.sp });
  const dep = (xt.rows[1] || { cells: [] }).cells[1] || { attrs: {}, cs: {}, inner: '' };
  ok(dep.attrs.rowspan === '2' && /<br>/.test(dep.inner), '  rowspan=2 · 칸 안 줄바꿈(<br style=mso-data-placement>) → <br>', { attrs: dep.attrs, inner: dep.inner });
  ok(dep.sp && dep.sp.bb === '2px solid' && dep.cs.br && dep.cs.br.startsWith('0px') && !('nowrap' in dep.attrs), '  1.5pt 아래 테두리 → 2px, 오른쪽 none, white-space:normal 은 nowrap 아님', { cs: dep.cs, attrs: dep.attrs });
  const sum = (xt.rows[3] || { cells: [] }).cells[0] || { attrs: {} };
  ok(sum.attrs.colspan === '2', '  colspan=2 그대로', sum.attrs);
  const amt = (xt.rows[1] || { cells: [] }).cells[2] || { cs: {} };
  ok(amt.cs.ta === 'right', '  숫자 칸 align=right → 오른쪽 맞춤', amt.cs);
  ok(JSON.stringify(xt.cols) === JSON.stringify([{ width: '64', span: '2' }, { width: '128' }]), '  열 너비 — <col width=64 span=2>, 숨긴 열의 col 은 빠진다', xt.cols);
  // 표 너비(192pt = 256px)는 일부러 안 적는다 — 칸·COL 너비가 정한다 (칸마다 여백을 더해서 256px 로는 모자라 엔진마다 열 너비가 달라진다 · tablefix [보3])
  ok(xt.attrs.cellpadding === '0' && xt.attrs.cellspacing === '0' && /border-collapse:\s*collapse/.test(xt.attrs.style || '') && !/width/.test(xt.attrs.style || '') && !('width' in xt.attrs),
    '  표 — cellpadding/cellspacing 0, border-collapse, 표 px 너비는 안 적는다 (칸·COL 너비가 있다)', xt.attrs);
  let car = await js('__t.caret()');
  ok(car.inBody && !car.inCell && car.text === '다라' && car.off === 0, '  커서는 표 바로 뒤 (뒤따르던 «다라» 앞)', car);
  await js(`document.execCommand('insertText', false, 'X'); true`);
  ok(/\[TABLE\]X다라$/.test(await js('__t.seq()')), '  이어 치면 표 뒤에 들어간다', await js('__t.seq()'));
  ok(net.length === net0, '  붙이는 동안 바깥 요청 없음', net.slice(net0));
  const drafted = await until(async () => {
    const d = await js('window.__calls.draft.length ? window.__calls.draft[window.__calls.draft.length - 1].bodyHtml : ""');
    return /<table/.test(d) ? d : null;
  }, 4000);
  ok(!!drafted, '  임시 저장(손이 멈추면)에 표가 간다 — 붙이면 input 이 온다');
  await js(`document.execCommand('undo'); document.execCommand('undo'); true`);
  ok((await js('__t.body().tables.length')) === 0 && (await js('__t.seq()')) === '가나다라', '  Ctrl+Z 두 번 (X, 표) → 표가 빠지고 원래 «가나다라»', await js('__t.seq()'));

  console.log('\n[1b] 엑셀 — 다듬은 HTML (build) 을 바로 본다');
  let o = await js(`__t.built(${J(C.EXCEL_HTML)})`);
  ok(o.got.ok && o.got.tables === 1 && o.got.rows === 4 && o.got.cols === 3 && o.got.cells === 10, 'build — ok · 표 1 · 4×3 · 보이는 칸 10', o.got);
  const c0 = o.tables[0].rows[0].cells[0];
  ok(c0.style === 'border:1px solid #000000;background-color:#ffff00;color:black;text-align:center;vertical-align:middle;font-weight:bold;width:64px;padding:4px 8px',
    '  머리 칸 style — 허락한 것만, 맞춘 꼴', c0.style);
  ok(c0.attrs.width === '64' && c0.attrs.bgcolor === '#ffff00' && 'nowrap' in c0.attrs && Object.keys(c0.attrs).sort().join() === 'bgcolor,nowrap,style,width',
    '  머리 칸 속성 — width · bgcolor · nowrap · style 뿐', c0.attrs);
  ok(!OFF.test(o.html) && !/white-space|text-wrap/.test(o.html), '  다듬은 HTML 에 class·mso·글꼴·white-space 가 없다', (o.html.match(OFF) || o.html.match(/white-space|text-wrap/) || [])[0]);
  ok(!/<img|<font|<style|<meta|<link/i.test(o.html), '  img·font·style·meta·link 없음');

  console.log('\n[2] 구글 시트');
  o = await js(`__t.built(${J(C.SHEETS_HTML)})`);
  const st = o.tables[0] || { rows: [], cols: [], attrs: {} };
  ok(o.got.ok && o.tables.length === 1 && st.rows.length === 3, '표 하나 · 3줄', o.got);
  ok(!/data-sheets|google-sheets|table-layout|overflow|Arial|class=|target=/i.test(o.html), '  data-sheets-* · google-sheets-html-origin · 글꼴 · overflow · class · target 없음', (o.html.match(/data-sheets|google-sheets|table-layout|overflow|Arial|class=|target=/i) || [])[0]);
  ok(JSON.stringify(st.cols) === JSON.stringify([{ width: '120' }, { width: '80' }]), '  colgroup 너비 그대로', st.cols);
  const s00 = st.rows[0].cells[0];
  ok(/background-color:#d9ead3/.test(s00.style) && /font-weight:bold/.test(s00.style) && s00.attrs.bgcolor === '#d9ead3', '  머리 칸 배경·굵게', s00);
  ok(/border:1px solid #cccccc/.test(s00.style), '  <style> 의 td{border:1px solid #cccccc} 가 칸마다 인라인으로', s00.style);
  const s10 = st.rows[1].cells[0];
  ok(/color:#ff0000/.test(s10.style) && /font-style:italic/.test(s10.style) && /^<u><s>사과<\/s><\/u>$/.test(s10.inner), '  빨강·기울임 + 밑줄·취소선은 <u><s>', s10);
  ok(/text-align:right/.test(st.rows[1].cells[1].style), '  숫자 오른쪽 맞춤');
  const s20 = st.rows[2].cells[0];
  ok(/border-bottom:2px solid #000000/.test(s20.style) && /border-top:1px solid #cccccc/.test(s20.style), '  인라인 border-bottom 이 규칙 위에서 이긴다', s20.style);
  ok(s20.inner === '<a href="https://example.invalid/pear">배</a>', '  링크는 href 만', s20.inner);
  ok(!/width:0px/.test(st.attrs.style || ''), '  width:0px 는 버린다', st.attrs);
  await js('__t.reset()');
  await paste({ text: C.SHEETS_TEXT, html: C.SHEETS_HTML, png: true });
  b = await js('__t.body(true)');
  ok(b.tables.length === 1 && (await js('__t.imgs()')) === 0 && (await js('__t.msg().text')) === '표를 붙였습니다 (3×2)', '  붙이면 표 하나 · 그림 없음 · «(3×2)»', await js('__t.msg()'));

  console.log('\n[3] 워드');
  o = await js(`__t.built(${J(C.WORD_HTML)})`);
  const wt = o.tables[0] || { rows: [], attrs: {} };
  ok(o.got.ok && o.tables.length === 1 && wt.rows.length === 2 && o.got.cols === 2, '표 하나 · 2×2', o.got);
  ok(JSON.stringify(o.lines) === JSON.stringify(['회의 안건']), '  표 앞 문단은 글 한 줄로, 뒤의 빈 줄(&nbsp;)은 버린다', o.lines);
  ok(!/MsoNormal|MsoTableGrid|mso|o:p|lang=|class=|<span[^>]*font-family/i.test(o.html), '  MsoNormal·mso-border-alt·<o:p>·lang 없음', (o.html.match(/MsoNormal|MsoTableGrid|mso|o:p|lang=|class=/i) || [])[0]);
  const w00 = wt.rows[0].cells[0];
  ok(/^border:1px solid #000000;background-color:#d9e2f3/.test(w00.style) && w00.attrs.width === '301' && /vertical-align:top/.test(w00.style), '  border:solid windowtext 1.0pt → 1px 검정, 배경, valign=top, width=301', w00);
  ok(/^<p style="(margin:0;text-align:center|text-align:center;margin:0)"><b>항목<\/b><\/p>$/.test(w00.inner), '  칸 안 문단 — 가운데 맞춤 · margin:0 · <b> 그대로, 글꼴만 있던 span 은 벗긴다', w00.inner);
  const w01 = wt.rows[0].cells[1];
  ok(!/border-left/.test(w01.style) && /border-top:1px solid #000000/.test(w01.style), '  border-left:none 은 왼쪽 테두리 없음', w01.style);
  ok(/<span style="color:red">Q4 <\/span>예산/.test(w01.inner), '  색 span 은 남긴다', w01.inner);
  ok(wt.rows[1].cells[0].text.trim() === '' && /<i>검토 중<\/i>/.test(wt.rows[1].cells[1].inner), '  빈 칸 · <i> 그대로', wt.rows[1].cells.map((c) => c.inner));

  console.log('\n[4] 한글 (한컴)');
  o = await js(`__t.built(${J(C.HWP_HTML)})`);
  const ht = o.tables[0] || { rows: [], attrs: {} };
  ok(o.got.ok && o.tables.length === 1 && o.got.rows === 2 && o.got.cols === 2, '대문자 태그도 표 하나 · 2×2', o.got);
  ok(!/HStyle|class=|font-family|height|padding:1/i.test(o.html) && !/<[A-Z]/.test(o.html), '  HStyle0·글꼴·높이 없음, 태그는 작은 글자', (o.html.match(/HStyle|class=|font-family|height/i) || [])[0]);
  const k00 = ht.rows[0].cells[0];
  ok(/border-top:1px solid #000000/.test(k00.style) && /border-bottom:2px double #000000/.test(k00.style) && /background-color:#e5e5e5/.test(k00.style) && /width:113px/.test(k00.style),
    '  0.4pt → 1px · 이중선 1.4pt → 2px double · 배경 #e5e5e5 · 너비 113px', k00.style);
  ok(/^<p style="(margin:0;text-align:center|text-align:center;margin:0)"><span style="font-weight:bold">구분<\/span><\/p>$/.test(k00.inner), '  문단 가운데 맞춤 · 따옴표 친 font-weight:"bold" 도 굵게', k00.inner);
  ok(!/border-top/.test(ht.rows[1].cells[0].style) && /<span style="color:#0000ff">11월 20일<\/span>/.test(ht.rows[1].cells[1].inner), '  border-top:none · 파란 글자', ht.rows[1].cells.map((c) => [c.style, c.inner]));

  console.log('\n[5] 보통 웹 표');
  o = await js(`__t.built(${J(C.WEB_HTML)})`);
  const bt = o.tables[0] || { rows: [], attrs: {} };
  ok(o.got.ok && o.tables.length === 1 && bt.caption === '2026년' && bt.rows[0].cells[0].tag === 'TH', '표 · caption · th 그대로', { caption: bt.caption, tag: bt.rows[0] && bt.rows[0].cells[0].tag });
  ok(!/class=|\sid=|data-|onclick|scope=|rel=|target=|<img|x\.example/i.test(o.html), '  class·id·data-*·onclick·scope·rel·target·<img>·바깥 주소 없음', (o.html.match(/class=|\sid=|data-|onclick|scope=|rel=|target=|<img|x\.example/i) || [])[0]);
  ok(/width:100%/.test(bt.attrs.style || ''), '  표 너비 150% → 100%', bt.attrs);
  ok(JSON.stringify(o.lines) === JSON.stringify(['지점 목록', '출처: 사내 위키']), '  표 앞뒤 글은 줄로', o.lines);
  const wb = bt.rows[1].cells;
  ok(/background-color:#eeeeee/.test(wb[0].style) && wb[0].attrs.bgcolor === '#eeeeee', '  bgcolor → background-color + bgcolor', wb[0]);
  ok(wb[1].inner.trim() === '<a href="https://example.invalid/gangnam">지도</a>', '  https 링크는 href 만 남기고 그림은 뺀다', wb[1].inner);
  const links = bt.rows[2].cells[0].inner;
  ok(/<a href="mailto:help@example.invalid">문의<\/a>/.test(links) && !/javascript/i.test(links) && /나쁜 링크/.test(links) && /상대 주소/.test(links) && (links.match(/<a /g) || []).length === 1,
    '  mailto 는 남기고, javascript:·// 주소 링크는 글만 남긴다', links);
  ok(/border:1px solid #808080/.test(wb[0].style) && /border:1px solid #808080/.test(bt.rows[0].cells[0].style), '  칸 테두리가 없고 border="1" 인 표 → 칸마다 1px #808080', wb[0].style);
  // 예전엔 테두리 없는 표면 어디서 왔든 격자선을 그었다 — 이제 스프레드시트(엑셀 격자선은 테두리가 아니라 복사에 안 온다)만.
  // 그 밖의 테두리 없는 표는 HTML 메일·서명의 배치용 표라 선 없이 (자세한 것은 tablefix [붙3])
  o = await js(`__t.built(${J('<meta name=ProgId content=Excel.Sheet><table><tr><td>가</td><td>나</td></tr></table>')})`);
  ok(o.got.ok && o.tables[0].rows[0].cells.every((c) => /border:1px solid #dcdcd9/.test(c.style) && /padding:4px 8px/.test(c.style)),
    '  엑셀의 테두리 없는 표 → 칸마다 1px #dcdcd9 (새 표와 같은 선) · padding 4px 8px', o.tables[0].rows[0].cells.map((c) => c.style));
  o = await js(`__t.built(${J('<table><tr><td>가</td><td>나</td></tr></table>')})`);
  ok(o.got.ok && o.tables[0].rows[0].cells.every((c) => !/border/.test(c.style) && /padding:4px 8px/.test(c.style)),
    '  스프레드시트가 아닌 테두리 없는 표 → 선 없이 · padding 4px 8px', o.tables[0].rows[0].cells.map((c) => c.style));

  console.log('\n[6] 나쁜 HTML');
  const netH = net.length;
  o = await js(`__t.built(${J(C.HOSTILE_HTML)})`);
  ok(o.got.ok && o.tables.length === 1, '표는 들어간다', o.got);
  ok(o.got.text === 'a\tbc\nd\te', '  표에서 뽑은 글(클립보드에 글이 없을 때 쓴다)에도 script·math·svg 의 글은 없다', o.got.text);
  const EVIL = /x\.example|url\(|expression|behavior|javascript|binding|svg|onload|onerror|iframe|object|input|video|math|script|<img|@import|background=|base|refresh/i;
  ok(!EVIL.test(o.html), '  바깥 주소·url()·expression·behavior·javascript:·svg·on*·iframe·object·input·video·script·img 하나도 없다', (o.html.match(EVIL) || [])[0]);
  const ev = o.tables[0].rows[0].cells;
  ok(/color:blue/.test(ev[0].style) && !/color:red/.test(ev[0].style), '  인라인 color:blue 가 class 의 red 를 이긴다', ev[0].style);
  ok(/background-color:#00ff00/.test(ev[1].style), '  url 과 섞인 class 배경에서 색만 (#00ff00)', ev[1].style);
  ok(ev[1].text === 'bc', '  나쁜 링크는 글만 (b·c), 나머지는 통째로 빠진다', ev[1].inner);
  await js('__t.reset()');
  await paste({ text: 'a\tbc\nd\te', html: C.HOSTILE_HTML });
  await sleep(500);
  b = await js('__t.body()');
  ok(b.tables.length === 1 && !EVIL.test(b.html), '  붙여도 본문에 나쁜 것이 없다', (b.html.match(EVIL) || [])[0]);
  ok(net.length === netH, '  다듬고 붙이는 동안 바깥 요청 0 (file: 만)', net.slice(netH));

  console.log('\n[7] 엑셀 빈 칸');
  await js('__t.reset()');
  await paste({ text: '\t\r\n', html: C.EXCEL_EMPTY_HTML, png: true });
  await sleep(400);
  ok((await js('__t.body().tables.length')) === 0 && (await js('__t.imgs()')) === 0, '테두리 없는 빈 칸 + 비트맵 → 표도 그림도 안 넣는다 (예전 그대로)', await js('__t.seq()'));
  await js('__t.reset()');
  await paste({ text: '\t\r\n', html: C.EXCEL_EMPTY_BORDER_HTML, png: true });
  await sleep(300);
  b = await js('__t.body(true)');
  ok(b.tables.length === 1 && b.tables[0].rows[0].cells.length === 2 && (await js('__t.imgs()')) === 0 && /^1px solid rgb\(0, 0, 0\)/.test(b.tables[0].rows[0].cells[0].sp.bt),
    '테두리를 그은 빈 칸 → 빈 표 틀 (테두리 그대로)', b.tables[0] && b.tables[0].rows[0].cells.map((c) => c.sp.bt));

  console.log('\n[8] 커서가 표 칸 안');
  await js(`__t.reset('<table><tbody><tr><td id="c1">칸</td><td>둘</td></tr></tbody></table><div id="l1">가나다라</div>', '#c1')`);
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML, png: true });
  await sleep(300);
  b = await js('__t.body()');
  const c1 = await js(`document.getElementById('c1') ? document.getElementById('c1').innerText : ''`);
  ok(b.tables.length === 1 && b.nested === 0 && (await js('__t.imgs()')) === 0, '표 안에 표를 만들지 않는다 (그림도 안 넣는다)', { tables: b.tables.length, nested: b.nested });
  ok(/^칸이름\s+부서\s+금액/.test(c1), '  그 칸에 글로 (탭으로 나뉜 글)', c1.slice(0, 40));

  console.log('\n[9] Ctrl+Shift+V');
  await js('__t.reset()');
  await js('__t.ctrlShiftV()');
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML, png: true });
  await sleep(300);
  ok((await js('__t.body().tables.length')) === 0 && (await js('__t.imgs()')) === 0 && /^가나이름\s+부서\s+금액/.test(await js('__t.seq()')), 'Ctrl+Shift+V 뒤 붙여넣기 → 글로', (await js('__t.seq()')).slice(0, 30));
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML, png: true });
  await sleep(300);
  ok((await js('__t.body().tables.length')) === 1, '  키 표시는 붙여넣기 하나만 — 다음 붙여넣기는 다시 표');
  await js('__t.reset()');
  await js('__t.ctrlShiftV()');
  await js(`(async () => __t.paste({ text: '', files: [await __t.png(120, 80)] }))()`);
  ok(!!(await until(() => js('__t.imgs() === 1'), 8000)), '  글이 없으면 보통 붙여넣기로 (그림)');
  await js('__t.reset()');
  await js('__t.ctrlShiftV()');
  await sleep(1200);
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  await sleep(300);
  ok((await js('__t.body().tables.length')) === 1, '  1초 지나면 키 표시는 사라진다 → 표');
  await js('__t.reset()');
  await js('__t.ctrlShiftV({ isComposing: true })');
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  await sleep(300);
  ok((await js('__t.body().tables.length')) === 1, '  한글 조합 중의 키는 안 센다');
  await js('__t.reset()');
  await js(`__t.key({ key: 'v', code: 'KeyV', ctrlKey: true })`);
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  await sleep(300);
  ok((await js('__t.body().tables.length')) === 1, '  Ctrl+V (Shift 없이) → 표');

  console.log('\n[10] 큰 표');
  const big = C.bigTable(41, 50);
  await js('__t.reset()');
  await paste({ text: '큰\t표', html: big, png: true });
  await sleep(500);
  m = await js('__t.msg()');
  ok((await js('__t.body().tables.length')) === 0 && (await js('__t.imgs()')) === 0 && /^가나큰\s+표다라$/.test(await js('__t.seq()')), '2050칸 → 글로', (await js('__t.seq()')).slice(0, 30));
  ok(m.kind.includes('bad') && m.text === '표가 커서 글로 붙였습니다 (2,050칸)', '  «표가 커서 글로 붙였습니다 (2,050칸)»', m);
  const long = C.bigTable(10, 10, (r, c) => `${r}${c}`.padEnd(10500, '가'));
  ok(long.length > 1000000, `  (긴 표 HTML ${long.length.toLocaleString()} 글자 · 100칸)`);
  await js('__t.reset()');
  await paste({ text: '', html: long });
  await sleep(500);
  m = await js('__t.msg()');
  const seqLong = await js('__t.seq()');
  ok((await js('__t.body().tables.length')) === 0 && m.text === '표가 커서 글로 붙였습니다 (100칸)', '다듬은 HTML 이 100만 글자 넘음 → 글로 «(100칸)»', m);
  const rowsLong = ((await js('__t.text()')).match(/\n/g) || []).length;
  ok(/^가나00가+\s+01가+/.test(seqLong) && rowsLong >= 9, '  글 칸이 비어 있으면 표에서 뽑은 글(탭·줄)로', `${seqLong.slice(0, 20)}… 줄바꿈 ${rowsLong}`);

  console.log('\n[11] 보낼 때 — bodyForSend · plainText');
  await js('__t.reset()');
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML, png: true });
  await sleep(300);
  const sent = await js(`(async () => { const r = await bodyForSend(); const doc = new DOMParser().parseFromString(r.html, 'text/html');
    const td = doc.querySelector('td'); return { html: r.html, text: r.text, inline: r.inline.length, tds: doc.querySelectorAll('td').length, style: td && td.getAttribute('style'), bgcolor: td && td.getAttribute('bgcolor') }; })()`);
  ok(/<table/.test(sent.html) && sent.tds === 10 && sent.inline === 0, '보내는 html 에 표 (칸 10 · 그림 0)', { tds: sent.tds, inline: sent.inline });
  ok(/border[^;]*1px solid/.test(sent.style || '') && /padding:\s*4px 8px/.test(sent.style || '') && sent.bgcolor === '#ffff00', '  칸 style 에 테두리·여백, bgcolor 속성 그대로', sent);
  // 감싸는 div 와 표에는 본문 글꼴·크기·줄 높이·색을 일부러 적는다 (quirks 로 그리는 메일 프로그램 · tablefix [보2]) — 그것 말고는 없다
  const BODY_FONT = "font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:14px;line-height:1.7;color:#1a1a1a";
  ok(!OFF.test(sent.html.replace(/^<div style="[^"]*">/, '').split(BODY_FONT).join('')), '  class·mso·글꼴 없음 (감싸는 div 와 표의 본문 글꼴 말고)', (sent.html.replace(/^<div style="[^"]*">/, '').split(BODY_FONT).join('').match(OFF) || [])[0]);
  const lines = String(sent.text).split('\n');
  // 글 몫은 칸 지도를 펴서 — 합친 칸이 덮은 자리는 빈 칸 (엑셀 글 몫처럼 열이 맞는다 · tablefix [보4])
  ok(lines.includes('이름\t부서\t금액') && lines.includes('합계\t\t2,000,000') && lines[0] === '가나', '  글 몫(plainText) — 줄마다 탭으로 나뉜 칸', lines.slice(0, 6));

  console.log('\n[12] 표 둘');
  await js('__t.reset()');
  // 테두리 없는 한 칸짜리 표는 배치용 표·칸 하나로 보고 글로 붙인다 (tablefix [붙3]·[붙4]) — 테두리를 그은 표 둘로
  await paste({ text: 'a\nb', html: '<table border="1"><tr><td>a</td></tr></table><p>사이</p><table border="1"><tr><td>b</td></tr></table>' });
  await sleep(300);
  ok((await js('__t.body().tables.length')) === 2 && (await js('__t.msg().text')) === '표 2개를 붙였습니다', '«표 2개를 붙였습니다»', await js('__t.msg()'));
  car = await js('__t.caret()');
  ok(car.inBody && !car.inCell, '  커서는 칸 밖', car);

  console.log('\n[13] 빈 첫 줄에 붙이기 — 커서가 서명 안으로 가지 않는다');
  await js(`__t.reset('<div id="l1"><br></div><div class="sig"><br><div>서명</div></div>', '#l1')`);
  await paste({ text: C.SHEETS_TEXT, html: C.SHEETS_HTML });
  await sleep(300);
  car = await js(`(() => { const c = __t.caret(); const n = getSelection().anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); c.inSig = !!(el && el.closest('.sig')); return c; })()`);
  ok((await js('__t.body().tables.length')) === 1 && car.inBody && !car.inCell && !car.inSig, '표 뒤 새 줄에 커서 (서명 밖)', car);
  await js(`document.execCommand('insertText', false, 'Y'); true`);
  ok(/\[TABLE\]Y\n?서명$/.test(await js('__t.seq()')) || /\[TABLE\]Y/.test(await js('__t.seq()')), '  이어 치면 표 뒤에', await js('__t.seq()'));

  ok(net.length === net0, '시험 내내 바깥 요청 0', net.slice(net0, net0 + 4));
  const bads = errors.filter((e) => !/Autofill|DevTools/.test(e));
  ok(!bads.length, '쓰기 창 콘솔에 오류 없음', bads.slice(0, 4));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); app.exit(1); });

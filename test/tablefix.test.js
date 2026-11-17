'use strict';
// 지킴이 — 무엇보다 먼저 (불러오다 터지면 Electron 이 사용자 화면에 오류 창을 띄운다 — 띄우지 않고 실패로 끝낸다)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
require('electron').dialog.showErrorBox = () => {};
// 표 붙여넣기·표 편집·보내기 — 세 검토에서 나온 문제를 하나씩 다시 해 본다 (진짜 renderer/compose.html 에서).
//
// 붙여넣기
//   [붙1] 숨긴 행·열을 가로지르는 합친 칸 — colspan·rowspan 을 보이는 행·열 수로 다시 센다 (안 그러면 줄이 옆으로 밀린다)
//   [붙2] 표 뒤에 글이 이어지는 붙여넣기 — 커서는 붙인 글 끝, 글로 끝나면 빈 줄을 덧붙이지 않는다
//   [붙3] 테두리 없는 배치용 표 — 스프레드시트가 아니면 회색 격자를 긋지 않는다, 한 열짜리는 글로
//   [붙4] 엑셀 칸 하나 — 표가 아니라 글로 (끝 줄바꿈 없이)
//   [붙5] 숨긴 행·열이 있으면 글로 붙이는 길(칸 안 커서·큰 표)에도 숨긴 것이 안 들어간다
//   [붙6] 워드 글머리 기호 — l·Ø·ü 가 아니라 ●·➢·✓, 번호는 그대로
//   [붙7] <font color> 색과 COL 없는 <colgroup width> 너비
//   [붙8] 아주 큰 표에 글도 왔으면 다듬지 않고 바로 글로
// 표 편집
//   [편1] 크로미움이 칸 style 을 고쳐 쓰는 표 — DOM 대체 길 없이 Ctrl+Z·Ctrl+Y 가 바르게 (표가 둘이 되지 않는다)
//   [편2] 종이보다 넓은 표의 너비 끌기 — 넓히려다 좁아지지 않고, 다른 열 너비를 잰 값으로 고쳐 쓰지 않는다
//   [편3] 한 칸 안 Shift+누르기 — 글 고르기를 늘리는 기본 동작은 막지 않는다
//   [편4] 작은 창의 오른쪽 클릭 메뉴 — 카드 안에서 굴러서 끝까지 고를 수 있다
//   [편6] 열을 통째로 합쳐도 표 너비가 그대로 (COL 없는 «표» 단추 표)
//   [편7] 칸을 고른 채 Ctrl+A → Delete 는 전체에 (고른 칸만이 아니라)
//   [편8] 끌어 고르다 처음 칸으로 돌아오면 칸 고르기가 풀린다
//   [편9] 고른 칸이 굴러서 안 보이면 막대도 숨는다
//   [편10] 너비 끌기는 제목 칸의 포커스와 칸 안 커서 자리를 그대로 둔다
//   [편12] 칸 안 커서에서 «표»로 넣은 새 표와 옛 표 사이에 빈 줄
//   [편13] 겹치는 합침이 든 웹 표 — 내용 지우기 한 번에 칸 배치가 바뀌지 않는다
// 보내기
//   [보1] 긴 낱말이 든 칸 — 쓰기 창과 받는 쪽(표준 모드)의 열 너비가 같다
//   [보2] doctype 없이 그리는 메일 프로그램(quirks) — 표 글자가 14px·줄 높이 그대로
//   [보3] 엑셀 표 — 칸·COL 너비가 있으면 표 px 너비는 적지 않는다
//   [보4] 글 몫 — 표는 줄마다 칸을 탭으로 (빈 칸·칸 안 줄바꿈·합친 칸에도 열이 맞는다)
//   [보6] 답장·전달·다시 보내기 — 칸의 nowrap 이 남는다
//   [보7] 다듬은 표가 100KB 를 넘으면 «Gmail 에서는 접혀 보일 수 있다» 고 알린다
// (머리글 행·열과 머리글 배경색은 칸 지도 셈이라 tablegrid.test.js 가 본다)
//
// 사용자 모니터에는 아무것도 안 뜬다 — 창은 숨김·화면 밖(offscreen)이다. 앱(main.js)은 안 띄운다.
// preload 대신 test/fixtures/compose-bridge-stub.js — 보내기·임시 저장 부탁은 기록만 하고 메인에 안 간다.
// 진짜 클립보드·키보드·마우스는 안 건드린다 — 화면 안에서 만든 ClipboardEvent·KeyboardEvent·MouseEvent 만 보낸다.
// 바깥으로 나가는 요청은 이 창의 세션에서 모두 막고 센다 (file:·data: 만 통과).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const C = require('./fixtures/table-clips.js');

setTimeout(() => { console.error('시간 초과'); app.exit(1); }, 300_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tablefix-'));
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
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${s.length > 360 ? `${s.slice(0, 360)}…` : s}` : ''));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const BASE = {
  accountId: 'a1', title: '새 메일', to: 'friend@example.invalid', subject: '시험', signature: '',
  accounts: [{ id: 'a1', name: '시험 계정', from: 'me@example.invalid' }], attachments: []
};

// 시험 표 — 칸마다 같은 선·여백 (새 표와 같은 꼴). rows: 줄마다 칸 글, 칸은 '가' 또는 { t, rs, cs }
const S = 'border:1px solid #dcdcd9;padding:6px 10px';
function tbl(rows, { id = 'T', w = 100, style = '' } = {}) {
  const cell = (c) => {
    const o = typeof c === 'string' ? { t: c } : c;
    return `<td${o.rs ? ` rowspan="${o.rs}"` : ''}${o.cs ? ` colspan="${o.cs}"` : ''} width="${w}" style="${S};width:${w}px${style}">${o.t || '<br>'}</td>`;
  };
  return `<table id="${id}" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tbody>${rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody></table>`;
}
const T3 = tbl([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
const L1 = '<div id="l1">가나다라</div>';

// 화면 안에서 쓰는 도구 — 붙여넣기·마우스·키 흉내, 커서 놓기, 표·도구 읽기
const HELP = `(() => {
  const body = document.getElementById('body');
  const attrsOf = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const tables = () => [...body.querySelectorAll('table')].filter((t) => !t.parentElement.closest('table'));
  const T = (i) => (typeof i === 'string' ? body.querySelector(i) : tables()[i || 0]);
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const fire = (el, type, x, y, o = {}) => {
    const K = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const ev = new K(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: o.button || 0, buttons: o.buttons || 0, shiftKey: !!o.shift });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const vis = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { on: e.classList.contains('on') && r.width > 0 && getComputedStyle(e).display !== 'none', l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const read = (root) => ({
    html: root.innerHTML,
    tables: [...root.querySelectorAll('table')].filter((t) => !t.parentElement.closest('table')).map((t) => ({
      attrs: attrsOf(t), cols: [...t.querySelectorAll(':scope > colgroup > col, :scope > col')].map(attrsOf),
      rows: [...t.rows].filter((r) => r.closest('table') === t).map((r) => [...r.cells].map((c) => ({ text: c.textContent.trim(), inner: c.innerHTML, style: c.getAttribute('style') || '', attrs: attrsOf(c) })))
    })),
    lines: [...root.children].filter((e) => e.tagName === 'DIV').map((d) => d.textContent)
  });
  window.__t = {
    reset(html, sel, at) {
      const doc = new DOMParser().parseFromString('<body>' + (html || '<div id="l1">가나다라</div>') + '</body>', 'text/html');
      body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
      body.scrollTop = 0;
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
      window.__calls.send.length = 0; window.__calls.draft.length = 0;
      body.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    paste({ text, html } = {}) {
      const dt = new DataTransfer();
      if (text !== undefined) dt.setData('text/plain', text);
      if (html !== undefined) dt.setData('text/html', html);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      body.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    built(html) {
      const got = window.nunsTable.build(html);
      const doc = new DOMParser().parseFromString('<body>' + (got.html || '') + '</body>', 'text/html');
      const { html: _h, ...rest } = got;
      return { got: { ...rest, len: (got.html || '').length }, ...read(doc.body) };
    },
    body() { return read(body); },
    msg() { const m = document.getElementById('msg'); return { kind: m.className, text: m.textContent }; },
    cell(ti, r, k) { return T(ti).rows[r].cells[k]; },
    cellXY(ti, r, k) { return center(this.cell(ti, r, k)); },
    move(x, y, o) { const el = document.elementFromPoint(x, y) || document.documentElement; return fire(el, 'mousemove', x, y, o); },
    moveCell(ti, r, k, o) { const p = this.cellXY(ti, r, k); return this.move(p.x, p.y, o); },
    downCell(ti, r, k, o = {}) { const c = this.cell(ti, r, k); const p = center(c); return fire(c, 'mousedown', p.x, p.y, { buttons: 1, ...o }); },
    up(x, y) { const el = document.elementFromPoint(x, y) || document.documentElement; return fire(el, 'mouseup', x, y); },
    press(sel, o = {}) {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return null;
      const p = center(el);
      const pd = fire(el, 'pointerdown', p.x, p.y, { buttons: 1, ...o });
      const md = fire(el, 'mousedown', p.x, p.y, { buttons: 1, ...o });
      fire(el, 'mouseup', p.x, p.y, o);
      fire(el, 'click', p.x, p.y, o);
      return { pd, md };
    },
    hover(sel) { const el = document.querySelector(sel); const p = center(el); fire(el, 'mouseover', p.x, p.y); fire(el, 'mousemove', p.x, p.y); return true; },
    key(o) { const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...o }); (document.activeElement || body).dispatchEvent(ev); return ev.defaultPrevented; },
    ctx(ti, r, k) { const c = this.cell(ti, r, k); const p = center(c); return fire(c, 'contextmenu', p.x, p.y, { button: 2 }); },
    menus() {
      return [...document.querySelectorAll('.tg-menu')].map((m) => { const r = m.getBoundingClientRect(); return {
        items: [...m.querySelectorAll('.mi')].map((i) => { const q = i.getBoundingClientRect(); return { label: i.textContent.replace(/▸/g, '').trim(), on: i.classList.contains('on'), t: q.top, b: q.bottom }; }),
        rect: { l: r.left, t: r.top, r: r.right, b: r.bottom }, scroll: m.scrollHeight > m.clientHeight + 1 }; });
    },
    pickItem(label) {
      const ms = [...document.querySelectorAll('.tg-menu')];
      for (let k = ms.length - 1; k >= 0; k--) {
        const it = [...ms[k].querySelectorAll('.mi')].find((i) => i.textContent.replace(/▸/g, '').trim() === label);
        if (it) { const p = center(it); fire(it, 'mouseover', p.x, p.y); fire(it, 'mousedown', p.x, p.y, { buttons: 1 }); fire(it, 'mouseup', p.x, p.y); fire(it, 'click', p.x, p.y); return true; }
      }
      return null;
    },
    tools() { return { bar: vis('tg-cellbar'), layer: vis('tg-layer'), size: vis('tg-size') }; },
    lit() { return body.querySelectorAll('.tg-on').length; },
    cellRect(ti, r, k) { return this.cell(ti, r, k).getBoundingClientRect().toJSON(); },
    tableRect(ti) { return T(ti).getBoundingClientRect().toJSON(); },
    grid(ti) { const t = T(ti); return [...t.rows].filter((r) => r.closest('table') === t).map((r) => [...r.cells].map((c) => ({ text: c.innerText.trim(), html: c.innerHTML, rs: c.rowSpan, cs: c.colSpan, style: c.getAttribute('style') || '', attrs: attrsOf(c) }))); },
    texts(ti) { return this.grid(ti).map((r) => r.map((c) => c.text)); },
    ntables() { return tables().length; },
    caret() {
      const s = getSelection(); const n = s.focusNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); const c = el && el.closest('td,th');
      return { inBody: !!(n && body.contains(n)), inCell: !!c, row: c ? c.parentElement.rowIndex : -1, col: c ? c.cellIndex : -1,
        node: n && n.nodeType === 3 ? n.nodeValue : (el ? el.tagName : null), off: s.focusOffset, collapsed: s.isCollapsed, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) };
    },
    caretIn(ti, r, k, off) {
      const c = this.cell(ti, r, k); const rg = document.createRange(); const t = c.firstChild;
      if (t && t.nodeType === 3) rg.setStart(t, off === undefined ? t.length : off); else rg.setStart(c, 0);
      rg.collapse(true); body.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); return true;
    },
    seq() {
      const out = [];
      const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c.nodeValue); else if (c.nodeName === 'TABLE') out.push('[TABLE]'); else walk(c); } };
      walk(body);
      return out.join('');
    },
    kids() { return [...body.childNodes].map((n) => n.nodeName + (n.id ? '#' + n.id : '') + ':' + (n.nodeName === 'TABLE' ? '' : (n.textContent || '').trim())); }
  };
  return true;
})()`;

// 받는 쪽 흉내 — 보낸 html 을 창 CSS 없이 따로 그린 뒤 잰다 (표준 모드: doctype 있음, quirks: 없음)
const MEASURE = `(() => {
  const t = document.querySelector('table');
  if (!t) return null;
  const cells = [...t.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10);
  const td = getComputedStyle(t.rows[0].cells[0]);
  return { mode: document.compatMode, tw: Math.round(t.getBoundingClientRect().width * 10) / 10, cells, fs: td.fontSize, lh: td.lineHeight };
})()`;

app.whenReady().then(async () => {
  let current = BASE;
  ipcMain.on('stub:compose', (e) => { e.returnValue = current; });

  const net = [];
  session.fromPartition('tablefix').webRequest.onBeforeRequest((d, cb) => {
    const local = /^(file|data|devtools):/i.test(d.url);
    if (!local) net.push(d.url);
    cb({ cancel: !local });
  });

  const opts = { offscreen: true, partition: 'tablefix', contextIsolation: false, sandbox: false, backgroundThrottling: false };
  const w = new BrowserWindow({ show: false, width: 640, height: 760, webPreferences: { ...opts, preload: path.join(__dirname, 'fixtures', 'compose-bridge-stub.js') } });
  const view = new BrowserWindow({ show: false, width: 640, height: 760, webPreferences: { ...opts } });
  for (const win of [w, view]) for (const k of ['show', 'showInactive', 'focus', 'moveTop', 'maximize']) win[k] = () => {};
  const wc = w.webContents;
  // 실패하면 어느 스크립트였는지 같이 적는다
  const js = (c) => wc.executeJavaScript(c).catch((e) => { throw new Error(`${e.message} — ${String(c).slice(0, 160)} — ${errors.slice(-2).join(" | ")}`); });
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(String(msg).slice(0, 200)); });
  const until = async (fn, ms = 4000, step = 40) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(step);
    }
  };

  async function open(payload) {
    current = payload;
    await w.loadFile(path.join(ROOT, 'renderer', 'compose.html'), { query: { radius: '20', theme: 'dark' } });
    const ready = await until(() => js(`document.getElementById('ttl').textContent === ${JSON.stringify(payload.title)}`), 8000);
    if (!ready) throw new Error('쓰기 창이 안 그려졌다');
    await js(HELP);
  }
  const J = (v) => JSON.stringify(v);
  const frames = async () => { await sleep(20); await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
  const reset = async (html, sel, at) => { await js(`__t.reset(${J(html)}, ${J(sel)}, ${J(at)})`); await frames(); };
  const paste = async (o) => { const p = await js(`__t.paste(${J(o)})`); await sleep(250); return p; };
  const built = (html) => js(`__t.built(${J(html)})`);
  const key = (o) => js(`__t.key(${J(o)})`);
  const grid = (ti = 0) => js(`__t.grid(${J(ti)})`);
  const texts = (ti = 0) => js(`__t.texts(${J(ti)})`);
  const caret = () => js('__t.caret()');
  const hoverCell = async (r, k, ti = 0) => { await js(`__t.moveCell(${J(ti)}, ${r}, ${k})`); await sleep(30); };
  /** 편집 명령 하나 (undo·redo·selectAll) */
  const cmd = async (name) => { await js(`document.execCommand(${J(name)}); true`); await sleep(40); };
  /** 손잡이 메뉴로 셈 하나 */
  const gripOp = async (kind, r, k, label) => {
    await hoverCell(r, k);
    await js(`__t.press('#tg-${kind}')`);
    await sleep(20);
    const got = await js(`__t.pickItem(${J(label)})`);
    await sleep(40);
    return got;
  };
  /** 칸 (r,k) 의 오른쪽 선을 dx 만큼 끈다 — 너비 손잡이를 띄우고 mousedown·mousemove·mouseup */
  const drag = async (r, k, dx, ti = 0) => {
    const c = await js(`__t.cellRect(${J(ti)}, ${r}, ${k})`);
    const y = (c.top + c.bottom) / 2;
    await js(`__t.move(${c.right - 1}, ${y})`);
    await sleep(20);
    const md = await js(`(() => { const e = document.getElementById('tg-size'); if (!e.classList.contains('on')) return 'off'; const r = e.getBoundingClientRect(); const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 1 }); e.dispatchEvent(ev); return ev.defaultPrevented; })()`);
    await js(`__t.move(${c.right + dx}, ${y}, { buttons: 1 })`);
    await js(`__t.up(${Math.max(1, c.right + dx)}, ${y})`);
    await sleep(50);
    return md;
  };
  /** 보낸 html 을 받는 쪽처럼 따로 그려 잰다 — std 면 doctype 을 붙인다 */
  const viewSent = async (html, width, std) => {
    const doc = `${std ? '<!DOCTYPE html>' : ''}<html><head><meta charset="utf-8"></head><body style="margin:0"><div style="width:${width}px">${html}</div></body></html>`;
    await view.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`);
    try { return await view.webContents.executeJavaScript(MEASURE); } catch (e) { return { err: String(e && e.message) }; }
  };

  await open(BASE);
  const net0 = net.length;

  // ───────────── 붙여넣기 ─────────────
  console.log('\n[붙1] 숨긴 행·열을 가로지르는 합친 칸');
  let o = await built(C.EXCEL_SPAN_HIDDEN_HTML);
  const sp = (o.tables[0] || { rows: [] }).rows.map((r) => r.map((c) => `${c.text}${c.attrs.colspan ? `/c${c.attrs.colspan}` : ''}${c.attrs.rowspan ? `/r${c.attrs.rowspan}` : ''}`));
  ok(same(sp, [['A1', 'B1:D1/c2', 'E1'], ['A2:A4/r2', 'C2', 'D2', 'E2'], ['C4', 'D4', 'E4'], ['A5', 'C5', 'D5', 'E5']]),
    '숨긴 열 B 를 걸친 B1:D1 은 colspan 2, 숨긴 3행을 걸친 A2:A4 는 rowspan 2', sp);
  ok(o.got.rows === 4 && o.got.cols === 4, '  알림의 크기도 보이는 행·열 (4×4)', o.got);
  const pos = await js(`(() => { const doc = new DOMParser().parseFromString('<body>' + window.nunsTable.build(${J(C.EXCEL_SPAN_HIDDEN_HTML)}).html + '</body>', 'text/html');
    const raw = { attrs: {}, caption: null, cols: null, secs: [{ tag: 'tbody', attrs: {} }], rows: [...doc.querySelector('table').rows].map((tr) => ({ sec: 0, attrs: {}, cells: [...tr.cells].map((c) => ({ tag: 'td', rs: c.rowSpan, cs: c.colSpan, attrs: {}, html: c.textContent })) })) };
    const m = window.nunsGrid.tidy(raw); return { w: m.w, map: window.nunsGrid.cells(m).map((r) => r.map((it) => it.html)) }; })()`);
  ok(pos.w === 4 && same(pos.map[3], ['A5', 'C5', 'D5', 'E5']) && same(pos.map[0], ['A1', 'B1:D1', 'B1:D1', 'E1']) && same(pos.map[2], ['A2:A4', 'C4', 'D4', 'E4']),
    '  칸 지도가 네모 — A5 는 첫 열, E1 은 E2 위', pos);
  ok(o.got.hidden > 0, '  숨긴 것이 있다고 알려 준다 (got.hidden)', o.got.hidden);
  ok(o.got.text === 'A1\tB1:D1\t\tE1\nA2:A4\tC2\tD2\tE2\n\tC4\tD4\tE4\nA5\tC5\tD5\tE5', '  표에서 뽑은 글도 숨긴 것 없이 열을 맞춰', o.got.text);

  console.log('\n[붙2] 표 뒤에 글이 이어지는 붙여넣기');
  const TRAIL = '<p>앞</p><table border="1"><tr><td>칸1</td><td>칸2</td></tr></table><p>뒤 문단</p>';
  await reset();
  await paste({ text: '앞\n칸1\t칸2\n뒤 문단', html: TRAIL });
  await js(`document.execCommand('insertText', false, 'X'); true`);
  let seq = await js('__t.seq()');
  ok(/\[TABLE\].*뒤 문단X다라$/.test(seq), '이어 치면 붙인 글 끝에 (뒤 문단 앞이 아니라)', seq);
  await reset('<div id="l1"><br></div><div id="sig">서명</div>', '#l1');
  await paste({ text: '칸1\t칸2\n끝 글', html: '<table border="1"><tr><td>칸1</td><td>칸2</td></tr></table><p>끝 글</p>' });
  const blanks = await js(`[...document.querySelectorAll('#body div')].filter((d) => d.childNodes.length === 1 && d.firstChild.nodeName === 'BR').length`);
  await js(`document.execCommand('insertText', false, 'X'); true`);
  ok(blanks === 0 && /\[TABLE\]끝 글X서명$/.test(await js('__t.seq()')), '  글로 끝나면 빈 줄을 덧붙이지 않는다 (서명 앞 빈 줄 없음, 커서는 «끝 글» 뒤)', { blanks, seq: await js('__t.seq()'), kids: await js('__t.kids()') });
  let kids;
  await reset();
  await paste({ text: '칸1\t칸2', html: '<table border="1"><tr><td>칸1</td><td>칸2</td></tr></table>' });
  await js(`document.execCommand('insertText', false, 'Y'); true`);
  ok(/\[TABLE\]Y다라$/.test(await js('__t.seq()')), '  표로 끝나면 예전처럼 표 바로 뒤에', await js('__t.seq()'));

  console.log('\n[붙3] 테두리 없는 배치용 표');
  await reset();
  await paste({ text: C.LAYOUT_MAIL_TEXT, html: C.LAYOUT_MAIL_HTML });
  ok((await js('__t.ntables()')) === 0 && /주문하신 상품/.test(await js('__t.seq()')), 'HTML 메일의 한 열짜리 배치용 표 → 글로 (예전처럼)', await js('__t.seq()'));
  o = await built(C.OUTLOOK_SIG_HTML);
  ok(o.got.ok && o.tables.length === 1 && o.tables[0].rows[0].every((c) => !/border/.test(c.style)), '아웃룩 서명(두 칸·border=0) → 표는 두되 회색 격자는 안 긋는다', o.tables[0] && o.tables[0].rows[0].map((c) => c.style));
  o = await built('<table><tr><td>가</td><td>나</td></tr></table>');
  ok(o.got.ok && o.tables[0].rows[0].every((c) => !/border/.test(c.style)), '  스프레드시트 표시가 없는 테두리 없는 표 → 선 없이', o.tables[0] && o.tables[0].rows[0].map((c) => c.style));
  o = await built(C.EXCEL_PLAIN_HTML);
  ok(o.got.ok && o.tables[0].rows[0].every((c) => /border:1px solid #dcdcd9/.test(c.style)), '  엑셀(ProgId=Excel.Sheet)의 테두리 없는 칸 → 격자선 #dcdcd9 그대로', o.tables[0] && o.tables[0].rows[0].map((c) => c.style));

  console.log('\n[붙4] 엑셀 칸 하나');
  await reset('<div id="l1">이번 달 매출은 원입니다.</div>', '#l1', 9);
  await paste({ text: C.EXCEL_ONE_TEXT, html: C.EXCEL_ONE_HTML });
  ok((await js('__t.ntables()')) === 0 && (await js('__t.seq()')) === '이번 달 매출은 1,234,000원입니다.', '문장 가운데 → 표가 아니라 글로, 끝 줄바꿈 없이', await js('__t.seq()'));
  o = await built(C.EXCEL_ONE_BORDER_HTML);
  ok(o.got.ok && o.tables.length === 1, '  테두리를 그은 칸 하나는 표로', o.got);

  console.log('\n[붙5] 숨긴 행·열 — 글로 붙이는 길');
  await reset(`<table><tbody><tr><td id="c1">칸</td><td>둘</td></tr></tbody></table>${L1}`, '#c1');
  await paste({ text: C.EXCEL_SPAN_HIDDEN_TEXT, html: C.EXCEL_SPAN_HIDDEN_HTML });
  const c1 = await js(`document.getElementById('c1') ? document.getElementById('c1').innerText : ''`);
  ok(/C2/.test(c1) && !/B2|B3|C3/.test(c1), '칸 안 커서 → 글로, 숨긴 행·열의 글은 없다', c1);
  const bigHidden = C.bigTable(41, 50).replace('<table><tr>', "<table><tr style='display:none'><td class=xl66>숨은글</td></tr><tr>");
  await reset();
  await paste({ text: '숨은글\n큰\t표', html: bigHidden });
  seq = await js('__t.seq()');
  ok((await js('__t.ntables()')) === 0 && !/숨은글/.test(seq) && /0-0/.test(seq), '  큰 표 → 글로, 숨긴 줄의 글은 없다', seq.slice(0, 40));

  console.log('\n[붙6] 워드 글머리 기호');
  o = await built(C.WORD_LIST_HTML);
  ok(same(o.lines, ['➢ 일정 확인', '✓ 예산 확정', '1. 첫째']), '표 밖 — Ø·ü 는 ➢·✓, 번호 1. 은 그대로', o.lines);
  const wcell = ((o.tables[0] || { rows: [[{}]] }).rows[0][0] || {}).text || '';
  ok(/^● ?견적서 보내기$/.test(wcell.replace(/\s+/g, ' ')), '  칸 안 — l 은 ●', wcell);

  console.log('\n[붙7] <font color> · <colgroup width>');
  o = await built(C.CALC_HTML);
  const cc = (o.tables[0] || { rows: [[]], cols: [] });
  ok(/<span style="color:#ff0000">사과<\/span>/.test((cc.rows[0][0] || {}).inner || ''), '리브레오피스 <font color="#FF0000"> → 빨간 글 (span)', cc.rows[0][0]);
  ok(same(cc.cols.map((c) => c.width), ['120', '85', '85']), '  COL 없는 <colgroup width span> → 열마다 너비', cc.cols);
  o = await built(C.EXCEL_FONT_HTML);
  const fi = ((o.tables[0] || { rows: [[]] }).rows[0][0] || {}).inner || '';
  ok(/<span style="font-weight:bold;color:red">주의<\/span>/.test(fi), '  엑셀 칸 안 일부 빨강·굵게 (<font class="font6">)', fi);

  console.log('\n[붙8] 아주 큰 표에 글도 왔으면');
  await js(`(() => { const k = window.nunsTable; if (!k.__orig) { k.__orig = k.build; k.build = (...a) => { window.__builds = (window.__builds || 0) + 1; return k.__orig(...a); }; } window.__builds = 0; return true; })()`);
  await reset();
  await paste({ text: '큰\t표', html: C.bigTable(41, 50) });
  ok((await js('window.__builds')) === 0 && /^가나큰\s+표다라$/.test(await js('__t.seq()')) && (await js('__t.msg().text')) === '표가 커서 글로 붙였습니다 (2,050칸)', '글이 있으면 다듬지 않고 바로 글로 (같은 알림)', { builds: await js('window.__builds'), msg: await js('__t.msg()') });
  await reset();
  await paste({ text: '', html: C.bigTable(41, 50) });
  ok((await js('window.__builds')) === 1, '  글이 없으면 표에서 글을 뽑아야 하니 다듬는다', await js('window.__builds'));
  await js('window.nunsTable.build = window.nunsTable.__orig; delete window.nunsTable.__orig; true');

  // ───────────── 표 편집 ─────────────
  console.log('\n[편1] 크로미움이 칸 style 을 고쳐 쓰는 표 — Ctrl+Z·Ctrl+Y');
  const REWRITE = ';text-align:left;font-weight:normal;white-space:nowrap;font-size:14px';
  await reset(L1 + tbl([['a', 'b'], ['c', 'd']], { w: 120, style: REWRITE }));
  const style0 = (await grid())[0][0].style;
  const fb0 = await js('tgStats.fallbacks');
  await gripOp('row', 1, 0, '아래에 행 넣기');
  ok(same(await texts(), [['a', 'b'], ['c', 'd'], ['', '']]), '아래에 행 넣기', await texts());
  ok((await js('tgStats.fallbacks')) === fb0 && !/되돌릴 수 없습니다/.test(await js('__t.msg().text')), '  DOM 대체 길을 안 쓴다 («되돌릴 수 없습니다» 없음)', { fb: await js('tgStats.fallbacks'), msg: await js('__t.msg()') });
  ok((await grid())[0][0].style === style0, '  칸 style 은 바란 그대로 (크로미움이 고쳐 쓴 것을 되돌렸다)', (await grid())[0][0].style);
  await cmd('undo');
  ok((await js('__t.ntables()')) === 1 && same(await texts(), [['a', 'b'], ['c', 'd']]), '  Ctrl+Z 한 번 → 넣기 전', { n: await js('__t.ntables()'), t: await texts() });
  await cmd('redo');
  ok((await js('__t.ntables()')) === 1 && same(await texts(), [['a', 'b'], ['c', 'd'], ['', '']]), '  Ctrl+Y → 표 하나, 줄 넣은 꼴 (표가 둘이 되지 않는다)', { n: await js('__t.ntables()'), t: await texts() });
  ok((await grid())[0][0].style === style0, '  다시 하기 뒤에도 칸 style 그대로', (await grid())[0][0].style);
  await reset(L1 + tbl([['a', 'b'], ['c', 'd']], { w: 120, style: REWRITE }));
  await js('__t.caretIn(0, 1, 1)');
  await js(`document.execCommand('insertText', false, 'Z'); true`);
  await gripOp('col', 0, 0, '복제');
  ok(same(await texts(), [['a', 'a', 'b'], ['c', 'c', 'dZ']]), '친 뒤 열 복제', await texts());
  await cmd('undo');
  ok((await js('__t.ntables()')) === 1 && same(await texts(), [['a', 'b'], ['c', 'dZ']]), '  Ctrl+Z → 복제 전 (친 글은 남는다)', await texts());
  await cmd('undo');
  ok(same(await texts(), [['a', 'b'], ['c', 'd']]), '  Ctrl+Z 한 번 더 → 친 글도 빠진다', await texts());
  await cmd('redo');
  await cmd('redo');
  ok((await js('__t.ntables()')) === 1 && same(await texts(), [['a', 'a', 'b'], ['c', 'c', 'dZ']]), '  Ctrl+Y 두 번 → 표 하나', { n: await js('__t.ntables()'), t: await texts() });

  console.log('\n[편2] 종이보다 넓은 표의 너비 끌기');
  const wideCell = (n) => `<td width="64" style="border:1px solid #000000;width:64px;padding:4px 8px">${n}</td>`;
  const WIDE = `<table id="W" cellpadding="0" cellspacing="0" width="576" style="border-collapse:collapse;width:576px"><colgroup><col width="64" span="9"></colgroup><tbody>${[0, 1].map((r) => `<tr>${Array.from({ length: 9 }, (_, k) => wideCell(`${r}${k}`)).join('')}</tr>`).join('')}</tbody></table>`;
  await reset(L1 + WIDE);
  const md = await drag(0, 2, 30);
  let g = await grid();
  ok(md === true && g[0].every((c) => Number(c.attrs.width) >= 64) && g[1].every((c) => Number(c.attrs.width) >= 64), '오른쪽으로 끌어도 어느 열도 좁아지지 않는다 (64 아래로 안 간다)', { md, w: g[0].map((c) => c.attrs.width) });
  await reset(L1 + WIDE);
  await drag(0, 2, -20);
  g = await grid();
  ok(Number(g[0][2].attrs.width) < 64 && Number(g[0][2].attrs.width) >= 40 && g[0].filter((c, k) => k !== 2).every((c) => c.attrs.width === '64'), '  왼쪽으로 끌면 그 열만 좁아지고 다른 열은 64 그대로', g[0].map((c) => c.attrs.width));

  console.log('\n[편3] 한 칸 안 Shift+누르기');
  await reset(L1 + tbl([['abcdef', 'b'], ['c', 'd']]));
  await js('__t.caretIn(0, 0, 0, 2)');
  const shiftSame = await js('__t.downCell(0, 0, 0, { shift: true })');
  ok(shiftSame === false && (await js('__t.lit()')) === 0, '같은 칸 Shift+누르기 — 기본 동작(글 고르기 늘리기)을 막지 않는다', { prevented: shiftSame, lit: await js('__t.lit()') });
  await js('__t.caretIn(0, 0, 0, 2)');
  ok((await js('__t.downCell(0, 1, 1, { shift: true })')) === true && (await js('__t.lit()')) === 4, '  다른 칸 Shift+누르기는 예전처럼 칸 고르기', await js('__t.lit()'));

  console.log('\n[편4] 작은 창의 오른쪽 클릭 메뉴');
  w.setSize(380, 320);
  await sleep(150);
  await reset(L1 + T3);
  await js('__t.ctx(0, 1, 1)');
  await sleep(30);
  let ms = await js('__t.menus()');
  const card = await js(`document.querySelector('.card').getBoundingClientRect().toJSON()`);
  ok(ms.length === 1 && ms[0].rect.b <= card.bottom + 0.5 && ms[0].rect.t >= card.top - 0.5, '메뉴가 카드 안에 들어간다', { menu: ms[0] && ms[0].rect, card: { t: card.top, b: card.bottom } });
  ok(ms[0] && ms[0].scroll, '  다 안 들어가면 메뉴 안에서 굴린다', ms[0] && ms[0].scroll);
  await key({ key: 'ArrowUp' });
  ms = await js('__t.menus()');
  const lastOn = ms[0] && ms[0].items.find((i) => i.on);
  ok(lastOn && lastOn.label === '표 지우기' && lastOn.t >= ms[0].rect.t - 0.5 && lastOn.b <= ms[0].rect.b + 0.5, '  ↑ 로 맨 끝 «표 지우기» — 보이는 자리로 굴러 온다', { on: lastOn, rect: ms[0] && ms[0].rect });
  await key({ key: 'Escape' });
  w.setSize(640, 760);
  await sleep(150);

  console.log('\n[편6] 열을 통째로 합쳐도 표 너비 그대로');
  await reset(L1);
  await js(`__t.press('#btn-table')`);
  await key({ key: 'ArrowRight' }); await key({ key: 'ArrowRight' });
  await key({ key: 'Enter' });
  await sleep(40);
  await js(`(() => { const t = document.querySelector('#body table'); [...t.rows[0].cells].forEach((c, i) => { c.textContent = 'abc'[i]; }); return true; })()`);
  const tw0 = (await js('__t.tableRect(0)')).width;
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  await js(`__t.press('#tg-merge')`);
  await sleep(40);
  g = await grid();
  const tw1 = (await js('__t.tableRect(0)')).width;
  ok(g[0].length === 2 && Math.abs(tw1 - tw0) <= 2, '1×3 새 표의 앞 두 칸 합치기 — 표 너비가 줄지 않는다', { tw0, tw1, w: g[0].map((c) => c.attrs.width) });
  ok(Number(g[0][0].attrs.width) > 200 && g[0][0].style.includes(`width:${g[0][0].attrs.width}px`), '  합친 칸 너비 = 두 열 + 사이 여백·선 (속성 + style)', g[0][0]);

  console.log('\n[편7] 칸을 고른 채 Ctrl+A → Delete');
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  await js(`__t.up(${(await js('__t.cellXY(0, 0, 1)')).x}, ${(await js('__t.cellXY(0, 0, 1)')).y})`);
  ok((await js('__t.lit()')) === 2, '(칸 둘을 골랐다)');
  await key({ key: 'a', code: 'KeyA', ctrlKey: true });
  await cmd('selectAll');
  ok((await js('__t.lit()')) === 0, 'Ctrl+A — 칸 고르기가 풀린다', await js('__t.lit()'));
  ok(!(await key({ key: 'Delete', code: 'Delete' })) && same(await texts(), [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]), '  Delete 는 막지 않는다 (기본 동작 — 전체 지우기에 맡긴다)', await texts());
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  await cmd('selectAll');
  ok(!(await key({ key: 'Delete', code: 'Delete' })) && (await js('__t.lit()')) === 0, '  키 없이 글 고르기가 표 밖으로 넓어졌어도 — Delete 는 칸 고르기를 풀고 기본 동작으로', await js('__t.lit()'));

  console.log('\n[편8] 끌어 고르다 처음 칸으로');
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  const two = await js('__t.lit()');
  await js('__t.moveCell(0, 0, 0, { buttons: 1 })');
  ok(two === 2 && (await js('__t.lit()')) === 0, '(0,1)로 끌면 2칸, 처음 칸으로 돌아오면 풀린다', { two, back: await js('__t.lit()') });

  console.log('\n[편9] 고른 칸이 굴러서 안 보이면');
  const lines = Array.from({ length: 40 }, (_, i) => `<div>줄 ${i}</div>`).join('');
  await reset(L1 + lines + T3 + lines);
  await js(`(() => { const b = document.getElementById('body'); const t = b.querySelector('table'); b.scrollTop += t.getBoundingClientRect().top - b.getBoundingClientRect().top - 80; b.dispatchEvent(new Event('scroll')); return true; })()`);
  await frames();
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  await frames();
  const barOn = (await js('__t.tools()')).bar.on;
  await js(`(() => { const b = document.getElementById('body'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); return true; })()`);
  await frames();
  const t9 = await js('__t.tools()');
  ok(barOn && (await js('__t.lit()')) === 4 && !t9.bar.on, '보일 때는 막대, 표가 굴러 나가면 막대도 숨는다', { barOn, bar: t9.bar, table: await js('__t.tableRect(0).top') });

  console.log('\n[편10] 너비 끌기 — 포커스·커서 자리');
  await reset(L1 + tbl([['abcdef', 'b', 'c'], ['d', 'e', 'f']]));
  await js(`document.getElementById('subject').focus(); true`);
  await drag(0, 0, 20);
  ok(Number((await grid())[0][0].attrs.width) > 100 && (await caret()).active === 'subject', '제목 칸에서 쓰다가 끌어도 포커스는 제목 칸', { w: (await grid())[0][0].attrs.width, car: await caret() });
  await reset(L1 + tbl([['abcdef', 'b', 'c'], ['d', 'e', 'f']]));
  await js('__t.caretIn(0, 0, 0, 3)');
  await drag(0, 1, 20);
  const car = await caret();
  ok(Number((await grid())[0][1].attrs.width) > 100 && car.inCell && car.row === 0 && car.col === 0 && car.node === 'abcdef' && car.off === 3, '  칸 안 커서는 같은 칸 같은 자리 (3번째)', car);

  console.log('\n[편12] 칸 안 커서에서 «표»');
  await reset(L1 + tbl([['x', 'y']], { id: 'old' }) + '<div id="l2">아래</div>', '#old td');
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  await sleep(30);
  kids = await js('__t.kids()');
  const oi = kids.indexOf('TABLE#old:');
  ok(oi >= 0 && kids[oi + 1] === 'DIV:' && kids[oi + 2] === 'TABLE:' && (await caret()).inCell, '옛 표와 새 표 사이에 빈 줄 (커서는 새 표 첫 칸)', kids);

  console.log('\n[편14] 표 바로 뒤 빈 줄에서 «표»·표 붙이기 — 두 표가 붙지 않는다');
  // 두 바깥 표 사이 틈 (px) 과 그 사이 빈 줄 수. 틈이 글 한 줄만큼 있어야 사이에 글을 쓸 수 있다
  const gap = () => js(`(() => { const ts = [...document.getElementById('body').querySelectorAll('table')].filter((t) => !t.parentElement.closest('table')); if (ts.length < 2) return { n: ts.length, gap: -1 }; const a = ts[ts.length - 2].getBoundingClientRect(); const b = ts[ts.length - 1].getBoundingClientRect(); return { n: ts.length, gap: Math.round(b.top - a.bottom) }; })()`);
  const AFTER = L1 + tbl([['x', 'y']], { id: 'old' }) + '<div id="l2"><br></div>';
  await reset(AFTER, '#l2');
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  await sleep(30);
  let gp = await gap();
  ok(gp.n === 2 && gp.gap >= 14 && (await caret()).inCell, '표 뒤 빈 줄에서 «표» → 사이에 빈 줄 (커서는 새 표 첫 칸)', gp);
  await cmd('undo');
  gp = await gap();
  ok(gp.n === 1, '  Ctrl+Z 한 번에 새 표가 빠진다', gp);
  await reset(AFTER, '#l2');
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  gp = await gap();
  ok(gp.n === 2 && gp.gap >= 14, '표 뒤 빈 줄에서 표 붙이기 → 사이에 빈 줄', gp);
  await reset(L1 + '<div id="l2"><br></div>', '#l2');
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  await sleep(30);
  gp = await gap();
  ok(gp.n === 2 && gp.gap >= 14 && (await caret()).inCell, '표를 붙이고 바로 «표» → 사이에 빈 줄', gp);
  // 커서가 줄 안이 아니라 본문 끝 자리(본문, 자식 수)에 있어도 같다
  await reset(L1 + '<div id="l2"><br></div>', '#l2');
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  await js(`(() => { const b = document.getElementById('body'); const r = document.createRange(); r.selectNodeContents(b); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  await sleep(30);
  gp = await gap();
  ok(gp.n === 2 && gp.gap >= 14 && (await caret()).inCell, '  커서가 본문 끝 자리여도 사이에 빈 줄', gp);
  await reset(L1 + tbl([['x', 'y']], { id: 'old' }) + '<div id="l2">아래</div>', '#l2');
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  await sleep(30);
  kids = await js('__t.kids()');
  ok(!kids.slice(kids.indexOf('TABLE#old:') + 1).slice(0, 1).includes('DIV:'), '  표 뒤 글 줄 끝에서 «표»는 그대로 (빈 줄을 더하지 않는다)', kids);

  console.log('\n[편13] 겹치는 합침이 든 웹 표');
  await reset(`${L1}<table id="T" border="1"><tbody><tr><td>A</td><td rowspan="2">B</td><td>C</td></tr><tr><td colspan="3">D</td></tr></tbody></table>`);
  await js('__t.ctx(0, 0, 0)');
  await js(`__t.pickItem('내용 지우기')`);
  await sleep(40);
  g = await grid();
  ok(same(g.map((r) => r.map((c) => `${c.text}/${c.rs}x${c.cs}`)), [['/1x1', 'B/2x1', 'C/1x1'], ['D/1x3']]), '(0,0) 내용 지우기 — 그 칸 글만 빠지고 D 는 colspan 3 그대로, 새 칸 없음', g.map((r) => r.map((c) => `${c.text}/${c.rs}x${c.cs}`)));
  await cmd('undo');
  ok((await texts())[0][0] === 'A', '  Ctrl+Z 한 번에 돌아간다', await texts());

  // ───────────── 보내기 ─────────────
  console.log('\n[보1] 긴 낱말이 든 칸 — 받는 쪽 너비');
  const LONG = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghij';
  await reset(`<div id="l1">위 글</div>${await js('window.nunsTable.blank(2, 3, 120)')}`);
  await js(`(() => { const c = document.querySelector('#body table').rows[0].cells; c[0].textContent = '이름'; c[2].textContent = ${J(LONG)}; return true; })()`);
  const room = await js(`(() => { const b = document.getElementById('body'); const cs = getComputedStyle(b); return b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); })()`);
  const here = await js(`(() => { const t = document.querySelector('#body table'); return { tw: Math.round(t.getBoundingClientRect().width * 10) / 10, cells: [...t.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10) }; })()`);
  const sent = await js(`(async () => { try { return (await bodyForSend()).html; } catch (e) { return '오류 ' + e.message; } })()`);
  ok(/word-break:\s*keep-all/.test(sent) && /overflow-wrap:\s*anywhere/.test(sent) && /line-height:\s*1\.7/.test(sent), '감싸는 div 가 쓰기 창 .body 와 같은 줄바꿈·줄 높이', sent.slice(0, 200));
  let there = await viewSent(sent, room, true);
  ok(there && there.mode === 'CSS1Compat' && Math.abs(there.tw - here.tw) <= 2 && there.cells.every((x, k) => Math.abs(x - here.cells[k]) <= 2), '  받는 쪽(표준 모드)에서도 열 너비가 쓰기 창과 같다', { here, there });

  console.log('\n[보2] doctype 없이 그리는 메일 프로그램 (quirks)');
  there = await viewSent(sent, room, false);
  ok(there && there.mode === 'BackCompat' && there.fs === '14px' && Math.abs(parseFloat(there.lh) - 23.8) < 0.6, '표 글자 14px · 줄 높이 1.7 (23.8px)', there);
  await reset('<div id="l1">위 글</div><div style="font-size:12px"><table><tbody><tr><td>작은 글</td></tr></tbody></table></div>');
  const small = await js('(async () => (await bodyForSend()).html)()');
  there = await viewSent(small, room, false);
  const thereStd = await viewSent(small, room, true);
  ok(there && there.fs === '12px' && thereStd.fs === '12px', '  표를 감싼 글이 정한 크기(12px)는 그대로 — quirks 에서도', { quirks: there, std: thereStd });

  console.log('\n[보3] 엑셀 표의 너비');
  o = await built(C.EXCEL_HTML);
  const xa = (o.tables[0] || { attrs: {} }).attrs;
  ok(!('width' in xa) && !/width/.test(xa.style || '') && same(o.tables[0].cols.map((c) => c.width), ['64', '128']), '칸·COL 너비가 있으면 표 px 너비는 적지 않는다 (COL·칸 너비는 그대로)', { attrs: xa, cols: o.tables[0].cols });
  o = await built(C.WEB_HTML);
  ok(/width:100%/.test(o.tables[0].attrs.style || ''), '  % 너비 표(웹)는 그대로', o.tables[0].attrs);

  console.log('\n[보4] 글 몫 (plainText)');
  await reset(`<div id="l1">위 글</div>${await js('window.nunsTable.blank(3, 2, 120)')}<div>아래</div>`);
  let plain = await js('plainText()');
  ok(plain === '위 글\n\t\n\t\n\t\n아래', '빈 3×2 표 — 줄마다 탭 하나 (빈 줄이 끼지 않는다)', plain);
  await reset();
  await paste({ text: C.EXCEL_TEXT, html: C.EXCEL_HTML });
  plain = await js('plainText()');
  const pl = plain.split('\n');
  ok(pl.includes('이름\t부서\t금액') && pl.includes('김민수\t영업 1팀\t1,200,000') && pl.includes('홍길동\t\t800,000') && pl.includes('합계\t\t2,000,000'),
    '  엑셀 표 — 칸 안 줄바꿈은 빈칸, 합친 칸이 덮은 자리는 빈 칸 (열이 맞는다)', pl);
  await open({ ...BASE, to: '', title: '답장', quoteHead: '누가 썼다', quoteHtml: '<p>원문</p><table border="1"><tr><td>q1</td><td><br></td></tr></table>' });
  plain = await js('plainText()');
  // 끝의 빈 칸 탭은 글 몫 맨 끝이라 trim 으로 빠진다 (예전부터 글 몫은 앞뒤 빈칸을 뗀다)
  ok(/^> q1\t?$/m.test(plain) && /^> 원문$/m.test(plain) && !/^q1/m.test(plain), '  인용문 안의 표도 «> » 가 붙는다', plain);

  console.log('\n[보6] 답장·전달·다시 보내기의 nowrap');
  const q6 = await js(`quoteInto(document.createElement('div'), '<table><tr><td nowrap>a</td><th nowrap="nowrap">b</th></tr></table><div nowrap>c</div>').innerHTML`);
  ok((q6.match(/<t[dh] nowrap/g) || []).length === 2 && !/<div nowrap/.test(q6), '칸의 nowrap 은 남는다 (값이 비어도) — 칸 말고는 안 남긴다', q6);
  await open(BASE);

  console.log('\n[보7] 다듬은 표가 100KB 를 넘으면');
  await reset();
  await paste({ text: '', html: C.bigTable(30, 60) });
  let m7 = await js('__t.msg()');
  ok((await js('__t.ntables()')) === 1 && /^표를 붙였습니다 \(30×60\)/.test(m7.text) && /Gmail/.test(m7.text), '«Gmail 에서는 접혀 보일 수 있다»를 같이 알린다', m7);
  await reset();
  await paste({ text: C.SHEETS_TEXT, html: C.SHEETS_HTML });
  m7 = await js('__t.msg()');
  ok(m7.text === '표를 붙였습니다 (3×2)', '  작은 표는 예전 알림 그대로', m7);

  ok(net.length === net0, '시험 내내 바깥 요청 0', net.slice(net0, net0 + 4));
  const bads = errors.filter((e) => !/Autofill|DevTools/.test(e));
  ok(!bads.length, '쓰기 창 콘솔에 오류 없음', bads.slice(0, 4));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); app.exit(1); });

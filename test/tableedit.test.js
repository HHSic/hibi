'use strict';
// 지킴이 — 무엇보다 먼저 (불러오다 터지면 Electron 이 사용자 화면에 오류 창을 띄운다 — 띄우지 않고 실패로 끝낸다)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
require('electron').dialog.showErrorBox = () => {};
// 메일 쓰기 창의 표 편집 — 진짜 renderer/compose.html 에 가짜 마우스·키를 넣어 본다.
//
// 사용자: «노션의 표만들기 같은 것», «칸 합치기». 칸 지도 셈은 tablegrid.test.js 가 따로 본다. 여기서는 화면:
//   [1] «표» 단추 — 8×8 고르개 (마우스·화살표·Enter·Esc·바깥 누르기), 커서 자리에 R×C 표, 커서는 첫 칸, Ctrl+Z 한 번에 빠진다,
//       붙인 표와 같은 선(#dcdcd9)·여백 6px 10px·px 너비, 종이보다 넓지 않다, 표 안이면 그 표 바로 뒤에 (표 안에 표를 안 만든다),
//       커서가 본문 밖이면 «그림» 단추가 넣는 자리에
//   [2] 손잡이 — 마우스를 올린 줄·열, 마우스가 없으면 커서의 줄·열, 둘 다 표 밖이면 숨는다, 본문을 넘지 않는다, 본문 굴림을 따라간다
//   [3] 손잡이 메뉴 — 줄·열을 고르고(칸에 표시) 위·아래·왼쪽·오른쪽에 넣기·복제·지우기·배경색·내용 지우기·머리글, 누른 것이 커서를 안 뺏는다,
//       셈 하나는 Ctrl+Z 한 번에 돌아간다
//   [4] + 띠 — 끝에 열·줄
//   [5] 열 너비 끌기 — px 너비가 COL 과 그 열 칸에 (속성 + style), 40px 아래로 안 간다, 표가 종이보다 넓어지지 않는다
//   [6] 칸 끌어 고르기·Shift+누르기 — 네모, 합친 칸을 다 담게 넓힌다, 글 고르기는 접힌다, Esc·바깥 누르기·치기로 풀린다, Delete 는 내용만 지운다
//   [7] 칸 합치기·나누기 — 고른 칸 위 막대, 구역(thead·tbody)을 넘으면 못 합친다 (까닭을 title 로)
//   [8] 배경색 — 팔레트 10가지, background-color + bgcolor, «기본»은 뗀다
//   [9] 머리글 켜기·끄기 — 첫 줄·첫 열, 켤 때 넣은 것만 뗀다
//  [10] 오른쪽 클릭 메뉴 — 키보드로 (화살표·Enter·Esc·하위 메뉴), 창 안에 머문다, 표 지우기
//  [11] Tab·Shift+Tab — 다음·앞 칸 (합친 칸이 덮은 자리는 건너뛴다), 마지막 칸에서 Tab 은 줄을 하나 더
//  [12] 편집 표시(고른 칸·손잡이·메뉴)는 보내는 html·임시 저장·글 몫·«쓰던 글이 있나»에 안 들어간다
//  [13] 엑셀에서 붙인 표(표 붙여넣기)도 같은 도구로 고친다
//  [14] 인용문·서명 안의 표도 고친다
//
// 사용자 모니터에는 아무것도 안 뜬다 — 창은 숨김·화면 밖(offscreen)이다. 앱(main.js)은 안 띄운다.
// preload 대신 test/fixtures/compose-bridge-stub.js — 보내기·임시 저장 부탁은 기록만 하고 메인에 안 간다.
// 진짜 클립보드·진짜 키보드·마우스는 안 건드린다 — 화면 안에서 만든 MouseEvent·KeyboardEvent·ClipboardEvent 만 보낸다.
// 바깥으로 나가는 요청은 이 창의 세션에서 모두 막고 센다 (file:·data: 만 통과).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const C = require('./fixtures/table-clips.js');

setTimeout(() => { console.error('시간 초과'); app.exit(1); }, 300_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tableedit-'));
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

const BASE = {
  accountId: 'a1', title: '새 메일', to: 'friend@example.invalid', subject: '시험', signature: '',
  accounts: [{ id: 'a1', name: '시험 계정', from: 'me@example.invalid' }], attachments: []
};

// 시험 표 — 칸마다 같은 선·여백 (새 표와 같은 꼴). rows: 줄마다 칸 글, 칸은 '가' 또는 { t, rs, cs }
const S = 'border:1px solid #dcdcd9;padding:6px 10px';
function tbl(rows, { id = 'T', w = 100, cols = false, head = false } = {}) {
  const cell = (c, tag = 'td') => {
    const o = typeof c === 'string' ? { t: c } : c;
    return `<${tag}${o.rs ? ` rowspan="${o.rs}"` : ''}${o.cs ? ` colspan="${o.cs}"` : ''} width="${w}" style="${S};width:${w}px">${o.t || '<br>'}</${tag}>`;
  };
  const n = Math.max(...rows.map((r) => r.reduce((k, c) => k + ((typeof c === 'object' && c.cs) || 1), 0)));
  const cg = cols ? `<colgroup>${`<col width="${w}">`.repeat(n)}</colgroup>` : '';
  const body = rows.map((r, i) => `<tr>${r.map((c) => cell(c, head && i === 0 ? 'th' : 'td')).join('')}</tr>`);
  const sec = head ? `<thead>${body[0]}</thead><tbody>${body.slice(1).join('')}</tbody>` : `<tbody>${body.join('')}</tbody>`;
  return `<table id="${id}" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${cg}${sec}</table>`;
}
const T3 = tbl([['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
const L1 = '<div id="l1">가나다라</div>';

// 화면 안에서 쓰는 도구 — 마우스·키 흉내, 커서 놓기, 표·도구 읽기
const HELP = `(() => {
  const body = document.getElementById('body');
  const attrsOf = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  window.__asks = 0;
  { const k = window.nunsseom; const orig = k.composeAsk; k.composeAsk = (...a) => { window.__asks += 1; return orig(...a); }; }
  const tables = () => [...body.querySelectorAll('table')].filter((t) => !t.parentElement.closest('table'));
  const T = (i) => (typeof i === 'string' ? body.querySelector(i) : tables()[i || 0]);
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const fire = (el, type, x, y, o = {}) => {
    const K = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const ev = new K(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: o.button || 0, buttons: o.buttons || 0, shiftKey: !!o.shift });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const vis = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { on: e.classList.contains('on') && r.width > 0 && getComputedStyle(e).display !== 'none', l: r.left, t: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
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
      window.__calls.send.length = 0; window.__calls.draft.length = 0;
      window.__asks = 0; window.__calls.close = 0;
      body.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    cell(ti, r, k) { return T(ti).rows[r].cells[k]; },
    cellXY(ti, r, k) { return center(this.cell(ti, r, k)); },
    move(x, y, o) { const el = document.elementFromPoint(x, y) || document.documentElement; return fire(el, 'mousemove', x, y, o); },
    moveCell(ti, r, k, o) { const p = this.cellXY(ti, r, k); return this.move(p.x, p.y, o); },
    downCell(ti, r, k, o = {}) { const c = this.cell(ti, r, k); const p = center(c); return fire(c, 'mousedown', p.x, p.y, { buttons: 1, ...o }); },
    up(x, y) { const el = document.elementFromPoint(x, y) || document.documentElement; return fire(el, 'mouseup', x, y); },
    // 요소 누르기 — pointerdown·mousedown(막았나)·mouseup·click
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
    downAt(sel) { const el = document.querySelector(sel); const p = center(el); return fire(el, 'mousedown', p.x, p.y, { buttons: 1 }); },
    hover(sel) { const el = document.querySelector(sel); const p = center(el); fire(el, 'mouseover', p.x, p.y); fire(el, 'mousemove', p.x, p.y); return true; },
    key(o) { const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...o }); (document.activeElement || body).dispatchEvent(ev); return ev.defaultPrevented; },
    ctx(ti, r, k, x, y) { const c = this.cell(ti, r, k); const p = center(c); return fire(c, 'contextmenu', x === undefined ? p.x : x, y === undefined ? p.y : y, { button: 2 }); },
    menus() {
      return [...document.querySelectorAll('.tg-menu')].map((m) => { const r = m.getBoundingClientRect(); return {
        items: [...m.querySelectorAll('.mi')].map((i) => ({ label: i.textContent.replace(/▸/g, '').trim(), on: i.classList.contains('on'), off: i.getAttribute('aria-disabled') === 'true', title: i.title })),
        rect: { l: r.left, t: r.top, r: r.right, b: r.bottom } }; });
    },
    active() { const ms = this.menus(); const m = ms[ms.length - 1]; const it = m && m.items.find((i) => i.on); return it ? it.label : null; },
    pickItem(label) {
      const ms = [...document.querySelectorAll('.tg-menu')];
      for (let k = ms.length - 1; k >= 0; k--) {
        const it = [...ms[k].querySelectorAll('.mi')].find((i) => i.textContent.replace(/▸/g, '').trim() === label);
        if (it) { const p = center(it); fire(it, 'mouseover', p.x, p.y); const md = fire(it, 'mousedown', p.x, p.y, { buttons: 1 }); fire(it, 'mouseup', p.x, p.y); fire(it, 'click', p.x, p.y); return { md }; }
      }
      return null;
    },
    tools() {
      const bar = document.getElementById('tg-cellbar');
      const btn = (id) => { const b = document.getElementById(id); return { on: !!b && b.offsetParent !== null && getComputedStyle(b).display !== 'none', off: !!b && b.disabled, title: b ? b.title : '' }; };
      return { layer: vis('tg-layer'), row: vis('tg-row'), col: vis('tg-col'), addC: vis('tg-add-col'), addR: vis('tg-add-row'), size: vis('tg-size'), bar: vis('tg-cellbar'),
        merge: btn('tg-merge'), split: btn('tg-split'), paint: btn('tg-paint'), wipe: btn('tg-wipe'), bodyRect: body.getBoundingClientRect().toJSON(),
        barRect: document.querySelector('.bar').getBoundingClientRect().toJSON(), footRect: document.querySelector('.foot').getBoundingClientRect().toJSON(), barOn: !!bar };
    },
    lit() { return body.querySelectorAll('.tg-on').length; },
    litTexts() { return [...body.querySelectorAll('.tg-on')].map((c) => c.innerText.trim()); },
    rowRect(ti, r) { return T(ti).rows[r].getBoundingClientRect().toJSON(); },
    cellRect(ti, r, k) { return this.cell(ti, r, k).getBoundingClientRect().toJSON(); },
    tableRect(ti) { return T(ti).getBoundingClientRect().toJSON(); },
    grid(ti) { const t = T(ti); return [...t.rows].filter((r) => r.closest('table') === t).map((r) => [...r.cells].map((c) => ({ text: c.innerText.trim(), html: c.innerHTML, rs: c.rowSpan, cs: c.colSpan, style: c.getAttribute('style') || '', attrs: attrsOf(c), tag: c.tagName }))); },
    texts(ti) { return this.grid(ti).map((r) => r.map((c) => c.text)); },
    cols(ti) { return [...T(ti).querySelectorAll(':scope > colgroup > col')].map((c) => c.getAttribute('width')); },
    ntables() { return tables().length; },
    nested() { return body.querySelectorAll('table table').length; },
    caret() {
      const s = getSelection(); const n = s.focusNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); const c = el && el.closest('td,th');
      const t = c && c.closest('table');
      return { inBody: !!(n && body.contains(n)), inCell: !!c, table: t ? tables().indexOf(t) : -1, row: c ? c.parentElement.rowIndex : -1, col: c ? c.cellIndex : -1,
        text: c ? c.innerText.trim() : (n && n.nodeType === 3 ? n.nodeValue : (el ? el.tagName : null)), off: s.focusOffset, collapsed: s.isCollapsed, id: el && el.id };
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
    pick() { const p = document.getElementById('tg-pick'); return { on: p.classList.contains('on'), squares: p.querySelectorAll('.sq').length, lit: p.querySelectorAll('.sq.on').length, lbl: document.getElementById('tg-lbl').textContent }; }
  };
  return true;
})()`;

app.whenReady().then(async () => {
  let current = BASE;
  ipcMain.on('stub:compose', (e) => { e.returnValue = current; });

  const net = [];
  session.fromPartition('tableedit').webRequest.onBeforeRequest((d, cb) => {
    const local = /^(file|data|devtools):/i.test(d.url);
    if (!local) net.push(d.url);
    cb({ cancel: !local });
  });

  const w = new BrowserWindow({
    show: false, width: 640, height: 760,
    webPreferences: { offscreen: true, partition: 'tableedit', preload: path.join(__dirname, 'fixtures', 'compose-bridge-stub.js'),
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
    const ready = await until(() => js(`document.getElementById('ttl').textContent === ${JSON.stringify(payload.title)}`), 8000);
    if (!ready) throw new Error('쓰기 창이 안 그려졌다');
    await js(HELP);
  }
  const J = (v) => JSON.stringify(v);
  // 본문을 갈아 끼운 뒤 손잡이는 다음 그림 차례(requestAnimationFrame)에 다시 그린다 — 한 차례 기다린다
  // 두 그림 차례(requestAnimationFrame)를 기다린다 — selectionchange 는 따로 오는 일이라 조금 쉰 뒤에
  const frames = async () => { await sleep(20); await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'); };
  const reset = async (html, sel, at) => { await js(`__t.reset(${J(html)}, ${J(sel)}, ${J(at)})`); await frames(); };
  const tools = () => js('__t.tools()');
  const texts = (ti = 0) => js(`__t.texts(${J(ti)})`);
  const grid = (ti = 0) => js(`__t.grid(${J(ti)})`);
  const caret = () => js('__t.caret()');
  const key = (o) => js(`__t.key(${J(o)})`);
  const hoverCell = async (r, k, ti = 0) => { await js(`__t.moveCell(${J(ti)}, ${r}, ${k})`); await sleep(30); };
  const undo = async () => { await js(`document.execCommand('undo'); true`); await sleep(30); };
  /** 손잡이 메뉴로 셈 하나 — 칸 (r,k) 에 마우스를 올리고 줄(row)·열(col) 손잡이를 누른 뒤 메뉴에서 고른다 */
  const gripOp = async (kind, r, k, label, sub) => {
    await hoverCell(r, k);
    const p = await js(`__t.press('#tg-${kind}')`);
    await sleep(20);
    const items = (await js('__t.menus()')).map((m) => m.items.map((i) => i.label));
    const lit = await js('__t.lit()');
    const got = await js(`__t.pickItem(${J(label)})`);
    if (sub) { await sleep(20); await js(`__t.pickItem(${J(sub)})`); }
    await sleep(40);
    return { p, items, lit, picked: !!got };
  };

  await open(BASE);

  console.log('\n[0] 싣기');
  ok(await js(`typeof window.nunsGrid === 'object' && typeof window.nunsGrid.tidy === 'function'`), 'compose.html 이 tablegrid.js 를 싣는다 (window.nunsGrid)');
  ok(await js(`(() => { const s = [...document.scripts].map((x) => x.getAttribute('src')); return s.indexOf('tablegrid.js') >= 0 && s.indexOf('tablegrid.js') < s.indexOf('compose.js'); })()`), '  compose.js 보다 먼저');
  ok(await js(`(() => { const b = document.getElementById('btn-table'); return !!b && b.textContent === '표' && b.previousElementSibling && b.previousElementSibling.id === 'btn-image'; })()`), '«표» 단추가 «그림» 바로 뒤에 있다');
  ok(await js(`(() => { const l = document.getElementById('tg-layer'); return !!l && !document.getElementById('body').contains(l); })()`), '  손잡이 층은 본문 밖에 있다');
  const net0 = net.length;

  console.log('\n[1] «표» 단추 — 8×8 고르개');
  await reset(L1);
  let pr = await js(`__t.press('#btn-table')`);
  ok(pr && (pr.pd || pr.md), '«표»를 눌러도 본문 커서를 안 뺏는다 (pointerdown/mousedown 을 막는다)', pr);
  let pk = await js('__t.pick()');
  ok(pk.on && pk.squares === 64 && pk.lbl === '1 × 1', '고르개가 열린다 — 64칸, «1 × 1»', pk);
  await js(`__t.hover('.tg-pick .sq[data-r="3"][data-c="4"]')`);
  pk = await js('__t.pick()');
  ok(pk.lbl === '3 × 4' && pk.lit === 12, '마우스를 올리면 «3 × 4» · 12칸 표시', pk);
  ok(await key({ key: 'ArrowDown' }) && (await js('__t.pick().lbl')) === '4 × 4', '  ↓ → «4 × 4»', await js('__t.pick()'));
  await key({ key: 'ArrowRight' });
  ok((await js('__t.pick().lbl')) === '4 × 5', '  → → «4 × 5»', await js('__t.pick()'));
  await key({ key: 'ArrowUp' }); await key({ key: 'ArrowLeft' });
  ok((await js('__t.pick().lbl')) === '3 × 4', '  ↑ ← → «3 × 4»');
  ok(await key({ key: 'Escape' }) && !(await js('__t.pick().on')), 'Esc — 고르개만 닫는다', await js('__t.pick()'));
  await sleep(50);
  ok((await js('window.__asks + window.__calls.close')) === 0 && (await js('__t.ntables()')) === 0, '  창을 닫지 않고 표도 안 넣는다');
  await js(`__t.press('#btn-table')`);
  await js(`__t.downAt('#subject')`);
  ok(!(await js('__t.pick().on')), '바깥을 누르면 닫는다');
  await js(`__t.press('#btn-table')`);
  await js(`__t.hover('.tg-pick .sq[data-r="3"][data-c="4"]')`);
  pr = await js(`__t.press('.tg-pick .sq[data-r="3"][data-c="4"]')`);
  await sleep(40);
  let g = await grid();
  ok(!(await js('__t.pick().on')) && g.length === 3 && g.every((r) => r.length === 4), '눌러서 3×4 표를 넣는다', g.map((r) => r.length));
  ok(pr.md === true, '  고르개 칸을 눌러도 커서를 안 뺏는다', pr);
  ok((await js('__t.seq()')) === '가나[TABLE]다라', '  커서 자리(«가나|다라»)에', await js('__t.seq()'));
  let car = await caret();
  ok(car.inCell && car.row === 0 && car.col === 0, '  커서는 첫 칸', car);
  const c0 = g[0][0];
  ok(/border:1px solid #dcdcd9/.test(c0.style) && /padding:6px 10px/.test(c0.style) && /width:\d+px/.test(c0.style) && /^\d+$/.test(c0.attrs.width) && c0.html === '<br>',
    '  칸 — 붙인 표와 같은 선 #dcdcd9 · 여백 6px 10px · px 너비 (속성 + style) · 빈 칸은 <br>', c0);
  ok(Number(c0.attrs.width) === 120, '  열 너비 120px (종이 안에 들어갈 때)', c0.attrs.width);
  ok((await js(`__t.tableRect(0).width <= document.getElementById('body').clientWidth - 32 + 1`)), '  표가 종이보다 넓지 않다', await js('__t.tableRect(0).width'));
  await undo();
  ok((await js('__t.ntables()')) === 0 && (await js('__t.seq()')) === '가나다라', '  Ctrl+Z 한 번에 빠진다', await js('__t.seq()'));
  await reset(L1);
  await js(`__t.press('#btn-table')`);
  await key({ key: 'ArrowRight' }); await key({ key: 'ArrowDown' });
  ok(await key({ key: 'Enter' }), 'Enter — 넣는다 (키를 막는다)');
  g = await grid();
  ok(g.length === 2 && g[0].length === 2 && (await caret()).inCell, '  키보드로 2×2', g.map((r) => r.length));
  await reset(L1 + tbl([['x', 'y']], { id: 'old' }) + '<div>아래</div>', '#old td');
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  ok((await js('__t.ntables()')) === 2 && (await js('__t.nested()')) === 0, '커서가 표 안이면 — 표 안에 표를 만들지 않는다', { n: await js('__t.ntables()'), nested: await js('__t.nested()') });
  // 두 표 사이에는 빈 줄 하나 — 붙어 있으면 사이에 글을 쓸 자리가 없다 (tablefix [편12])
  ok(await js(`(() => { const d = document.getElementById('old').nextElementSibling; return !!d && d.tagName === 'DIV' && !d.textContent.trim() && d.nextElementSibling === document.querySelectorAll('#body table')[1]; })()`), '  그 표 바로 뒤에 넣는다 (사이에 빈 줄)', await js('__t.seq()'));
  ok((await caret()).table === 1, '  커서는 새 표의 첫 칸', await caret());
  await reset(L1);
  await js(`document.getElementById('subject').focus(); true`);
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Enter' });
  car = await caret();
  ok((await js('__t.ntables()')) === 1 && car.inCell && (await js(`document.activeElement === document.getElementById('body')`)), '커서가 본문 밖이면 «그림» 단추처럼 본문에 넣고 첫 칸으로', car);
  await reset(L1);
  await js(`__t.press('#btn-table')`);
  await js(`__t.hover('.tg-pick .sq[data-r="2"][data-c="8"]')`);
  await js(`__t.press('.tg-pick .sq[data-r="2"][data-c="8"]')`);
  g = await grid();
  ok(g[0].length === 8 && Number(g[0][0].attrs.width) < 120 && Number(g[0][0].attrs.width) >= 40, '8열 — 종이에 맞게 열을 좁힌다 (40px 아래로는 안 간다)', g[0][0].attrs.width);
  ok((await js(`__t.tableRect(0).width <= document.getElementById('body').clientWidth - 32 + 1`)), '  표가 종이보다 넓지 않다', await js('__t.tableRect(0).width'));

  console.log('\n[2] 손잡이 — 마우스·커서의 줄과 열');
  await reset(L1 + T3);
  let t0 = await tools();
  ok(!t0.layer.on && !t0.row.on && !t0.col.on, '커서·마우스가 표 밖이면 손잡이가 없다', t0.row);
  await hoverCell(1, 1);
  t0 = await tools();
  let row1 = await js('__t.rowRect(0, 1)');
  let cell11 = await js('__t.cellRect(0, 1, 1)');
  let tr = await js('__t.tableRect(0)');
  ok(t0.row.on && t0.row.cy > row1.top && t0.row.cy < row1.bottom && t0.row.r <= tr.left + 1, '줄 손잡이 — 마우스를 올린 줄 왼쪽', { grip: t0.row, row1, tl: tr.left });
  ok(t0.col.on && t0.col.cx > cell11.left && t0.col.cx < cell11.right && Math.abs(t0.col.cy - tr.top) <= 2, '열 손잡이 — 그 열 윗선에 걸쳐 (윗줄 글을 안 가린다)', { grip: t0.col, cell11, tt: tr.top });
  ok(t0.addC.on && t0.addC.l >= tr.right - 1 && t0.addR.on && t0.addR.t >= tr.bottom - 1, '+ 띠 — 오른쪽 끝·아래 끝', { addC: t0.addC, addR: t0.addR, tr });
  ok(t0.layer.t >= t0.bodyRect.top - 0.5 && t0.layer.b <= t0.bodyRect.bottom + 0.5 && t0.layer.t >= t0.barRect.bottom - 0.5 && t0.layer.b <= t0.footRect.top + 0.5,
    '  손잡이 층은 본문(종이) 안 — 서식 막대·아래 줄을 덮지 않는다', { layer: t0.layer, body: t0.bodyRect, bar: t0.barRect.bottom, foot: t0.footRect.top });
  await js(`__t.hover('#btn-link')`);
  await sleep(30);
  t0 = await tools();
  ok(!t0.row.on && !t0.col.on && !t0.addC.on, '마우스가 표에서 멀어지면 (커서도 표 밖) 숨는다', t0.row);
  await js('__t.caretIn(0, 2, 0)');
  await frames();
  t0 = await tools();
  const row2 = await js('__t.rowRect(0, 2)');
  const cell20 = await js('__t.cellRect(0, 2, 0)');
  ok(t0.row.on && t0.row.cy > row2.top && t0.row.cy < row2.bottom && t0.col.on && t0.col.cx > cell20.left && t0.col.cx < cell20.right, '마우스가 없으면 커서의 줄·열에 (키보드로도 쓴다)', { row: t0.row, col: t0.col });
  ok(!t0.addC.on && !t0.addR.on, '  + 띠는 마우스를 올렸을 때만');
  const lines = Array.from({ length: 40 }, (_, i) => `<div>줄 ${i}</div>`).join('');
  await reset(L1 + lines + T3 + lines);
  await js(`(() => { const b = document.getElementById('body'); const t = b.querySelector('table'); b.scrollTop += t.getBoundingClientRect().top - b.getBoundingClientRect().top - 80; b.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(40);
  await hoverCell(1, 1);
  t0 = await tools();
  row1 = await js('__t.rowRect(0, 1)');
  ok(t0.row.on && Math.abs(t0.row.cy - (row1.top + row1.bottom) / 2) < 3, '굴린 본문에서도 줄 옆에', { grip: t0.row.cy, row: (row1.top + row1.bottom) / 2 });
  await js(`(() => { const b = document.getElementById('body'); b.scrollTop -= 30; b.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(40);
  t0 = await tools();
  row1 = await js('__t.rowRect(0, 1)');
  ok(Math.abs(t0.row.cy - (row1.top + row1.bottom) / 2) < 3, '  본문을 굴리면 따라간다', { grip: t0.row.cy, row: (row1.top + row1.bottom) / 2 });
  await js(`(() => { const b = document.getElementById('body'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); return true; })()`);
  await sleep(40);
  t0 = await tools();
  ok(!t0.row.on || (t0.row.cy >= t0.layer.t && t0.row.cy <= t0.layer.b), '  표가 본문 밖으로 굴러 나가면 손잡이도 본문 밖에 그리지 않는다', { grip: t0.row, layer: t0.layer });

  console.log('\n[3] 손잡이 메뉴');
  await reset(L1 + T3);
  let op = await gripOp('row', 1, 1, '아래에 행 넣기');
  ok(op.p && op.p.md === true, '손잡이를 눌러도 커서·포커스를 안 뺏는다 (mousedown 을 막는다)', op.p);
  ok(same(op.items[0], ['위에 행 넣기', '아래에 행 넣기', '복제', '지우기', '배경색', '내용 지우기']), '  줄 메뉴 (첫 줄이 아니면 머리글 없음)', op.items);
  ok(op.lit === 3, '  누르면 그 줄 칸이 다 고른 표시', op.lit);
  g = await grid();
  ok(same(g.map((r) => r.map((c) => c.text)), [['a', 'b', 'c'], ['d', 'e', 'f'], ['', '', ''], ['g', 'h', 'i']]), '아래에 행 넣기', g.map((r) => r.map((c) => c.text)));
  ok(g[2].every((c, k) => c.style === g[1][k].style && c.html === '<br>'), '  새 칸은 이웃 칸의 스타일만 (내용은 아니다)', g[2]);
  car = await caret();
  ok(car.inCell && car.row === 2, '  커서는 새 줄', car);
  ok((await js('__t.lit()')) === 0 && (await js('__t.menus().length')) === 0, '  고른 표시·메뉴는 걷힌다');
  ok(!!(await until(async () => /<table/.test(await js('window.__calls.draft.length ? window.__calls.draft[window.__calls.draft.length - 1].bodyHtml : ""')) && (await js('window.__calls.draft[window.__calls.draft.length - 1].bodyHtml')).split('<tr').length === 5, 3000)),
    '  input 이 와서 임시 저장에 바뀐 표가 간다');
  await undo();
  ok(same(await texts(), [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]), '  Ctrl+Z 한 번에 돌아간다', await texts());
  ok((await js('tgStats.fallbacks')) === 0, '  insertHTML 이 표를 그대로 넣었다 (DOM 으로 바꾼 일 없음)', await js('tgStats.fallbacks'));
  await reset(L1 + T3);
  op = await gripOp('row', 0, 0, '위에 행 넣기');
  ok(same(await texts(), [['', '', ''], ['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]) && op.items[0].includes('머리글 켜기'), '위에 행 넣기 · 첫 줄 메뉴에는 «머리글 켜기»', { t: await texts(), items: op.items[0] });
  await reset(L1 + T3);
  await gripOp('row', 1, 0, '복제');
  ok(same(await texts(), [['a', 'b', 'c'], ['d', 'e', 'f'], ['d', 'e', 'f'], ['g', 'h', 'i']]), '복제 — 내용째', await texts());
  await reset(L1 + T3);
  await gripOp('row', 1, 0, '지우기');
  ok(same(await texts(), [['a', 'b', 'c'], ['g', 'h', 'i']]), '줄 지우기', await texts());
  await reset(L1 + T3);
  await gripOp('row', 1, 0, '내용 지우기');
  ok(same(await texts(), [['a', 'b', 'c'], ['', '', ''], ['g', 'h', 'i']]), '내용 지우기 — 줄은 남는다', await texts());
  await reset(L1 + T3);
  op = await gripOp('row', 1, 0, '배경색', '파랑');
  g = await grid();
  ok(g[1].every((c) => /background-color:#e7f3f8/.test(c.style) && c.attrs.bgcolor === '#e7f3f8') && !g[0][0].attrs.bgcolor, '배경색 ▸ 파랑 — 그 줄 칸에 background-color + bgcolor', g[1].map((c) => [c.style, c.attrs.bgcolor]));
  await reset(L1 + T3);
  op = await gripOp('col', 0, 1, '오른쪽에 열 넣기');
  ok(same(op.items[0], ['왼쪽에 열 넣기', '오른쪽에 열 넣기', '복제', '지우기', '배경색', '내용 지우기']), '열 메뉴', op.items);
  ok(same(await texts(), [['a', 'b', '', 'c'], ['d', 'e', '', 'f'], ['g', 'h', '', 'i']]), '오른쪽에 열 넣기', await texts());
  ok((await caret()).col === 2, '  커서는 새 열', await caret());
  await reset(L1 + T3);
  await gripOp('col', 0, 1, '왼쪽에 열 넣기');
  ok(same(await texts(), [['a', '', 'b', 'c'], ['d', '', 'e', 'f'], ['g', '', 'h', 'i']]), '왼쪽에 열 넣기', await texts());
  await reset(L1 + T3);
  await gripOp('col', 0, 2, '복제');
  ok(same(await texts(), [['a', 'b', 'c', 'c'], ['d', 'e', 'f', 'f'], ['g', 'h', 'i', 'i']]), '열 복제', await texts());
  await reset(L1 + T3);
  op = await gripOp('col', 0, 1, '지우기');
  ok(same(await texts(), [['a', 'c'], ['d', 'f'], ['g', 'i']]) && op.lit === 3, '열 지우기 (누를 때 그 열 칸 3개 표시)', { t: await texts(), lit: op.lit });
  await reset(L1 + tbl([['a', 'b']]));
  await gripOp('row', 0, 0, '지우기');
  ok((await js('__t.ntables()')) === 0, '하나 남은 줄을 지우면 표가 없어진다', await js('__t.seq()'));
  await undo();
  ok((await js('__t.ntables()')) === 1, '  Ctrl+Z 로 돌아온다');

  console.log('\n[4] + 띠');
  await reset(L1 + T3);
  await hoverCell(1, 1);
  pr = await js(`__t.press('#tg-add-col')`);
  ok(pr.md === true && same(await texts(), [['a', 'b', 'c', ''], ['d', 'e', 'f', ''], ['g', 'h', 'i', '']]), '오른쪽 + 띠 — 끝에 열 (누른 것이 커서를 안 뺏는다)', { pr, t: await texts() });
  await hoverCell(1, 1);
  await js(`__t.press('#tg-add-row')`);
  ok(same(await texts(), [['a', 'b', 'c', ''], ['d', 'e', 'f', ''], ['g', 'h', 'i', ''], ['', '', '', '']]), '아래 + 띠 — 끝에 줄', await texts());

  console.log('\n[5] 열 너비 끌기');
  for (const withCols of [false, true]) {
    await reset(L1 + tbl([['a', 'b', 'c'], ['d', 'e', 'f']], { cols: withCols }));
    const r0 = await js('__t.cellRect(0, 0, 0)');
    await js(`__t.move(${r0.right - 1}, ${(r0.top + r0.bottom) / 2})`);
    await sleep(20);
    t0 = await tools();
    ok(t0.size.on && Math.abs(t0.size.cx - r0.right) < 5, `${withCols ? '[COL] ' : ''}칸 오른쪽 선 가까이 — 너비 손잡이`, { size: t0.size, edge: r0.right });
    const md = await js(`(() => { const e = document.getElementById('tg-size'); const r = e.getBoundingClientRect(); const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 1 }); e.dispatchEvent(ev); return ev.defaultPrevented; })()`);
    await js(`__t.move(${r0.right + 59}, ${(r0.top + r0.bottom) / 2}, { buttons: 1 })`);
    await js(`__t.up(${r0.right + 59}, ${(r0.top + r0.bottom) / 2})`);
    await sleep(40);
    g = await grid();
    const w0 = Number(g[0][0].attrs.width);
    ok(md === true && Math.abs(w0 - 160) <= 2 && g[0][0].style.includes(`width:${w0}px`) && Number(g[1][0].attrs.width) === w0, '  60px 끌면 그 열이 160px — 그 열 칸마다 width 속성 + style', { md, w0, s: g[0][0].style, below: g[1][0].attrs.width });
    ok(g[0].slice(1).every((c) => /^\d+$/.test(c.attrs.width) && c.style.includes(`width:${c.attrs.width}px`)), '  다른 열도 px 로 적는다 (받는 사람도 같은 너비)', g[0].map((c) => c.attrs.width));
    if (withCols) ok(Number((await js('__t.cols(0)'))[0]) === w0, '  COL 에도', await js('__t.cols(0)'));
    await undo();
    ok(Number((await grid())[0][0].attrs.width) === 100, '  Ctrl+Z 한 번에 돌아간다', (await grid())[0][0].attrs.width);
  }
  await reset(L1 + tbl([['a', 'b', 'c'], ['d', 'e', 'f']]));
  for (const [dx, label] of [[2000, '아주 넓게 끌어도 표는 종이 안'], [-1000, '아주 좁게 끌어도 40px']]) {
    const r0 = await js('__t.cellRect(0, 0, 0)');
    await js(`__t.move(${r0.right - 1}, ${(r0.top + r0.bottom) / 2})`);
    await js(`(() => { const e = document.getElementById('tg-size'); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 3, clientY: r.top + r.height / 2, buttons: 1 })); return true; })()`);
    await js(`__t.move(${r0.right + dx}, ${(r0.top + r0.bottom) / 2}, { buttons: 1 })`);
    await js(`__t.up(${Math.max(1, r0.right + dx)}, ${(r0.top + r0.bottom) / 2})`);
    await sleep(40);
    const tw = await js('__t.tableRect(0).width');
    const room = await js(`document.getElementById('body').clientWidth - 32`);
    g = await grid();
    if (dx > 0) ok(tw <= room + 1, label, { tw, room, w: g[0].map((c) => c.attrs.width) });
    else ok(Number(g[0][0].attrs.width) === 40, label, g[0].map((c) => c.attrs.width));
  }
  {
    // 이미 40px 인 열을 더 좁게 끌면 아무것도 안 한다 — 표를 갈아 끼우지 않는다 (쓸데없는 되돌리기 칸이 안 생긴다).
    // 표 노드에 HTML 에 안 나가는 표시(__keep)를 달아 두고, 끈 뒤에도 같은 노드인지 본다
    await js(`(() => { document.querySelector('#body table').__keep = 1; return true; })()`);
    const r0 = await js('__t.cellRect(0, 0, 0)');
    await js(`__t.move(${r0.right - 1}, ${(r0.top + r0.bottom) / 2})`);
    await js(`(() => { const e = document.getElementById('tg-size'); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 3, clientY: r.top + r.height / 2, buttons: 1 })); return true; })()`);
    await js(`__t.move(${r0.right - 30}, ${(r0.top + r0.bottom) / 2}, { buttons: 1 })`);
    await js(`__t.up(${r0.right - 30}, ${(r0.top + r0.bottom) / 2})`);
    await sleep(40);
    g = await grid();
    ok((await js(`document.querySelector('#body table').__keep === 1`)) && Number(g[0][0].attrs.width) === 40,
      '  40px 인 열을 더 좁게 끌면 그대로 (표를 다시 넣지 않는다 — 되돌리기 칸이 안 생긴다)', g[0].map((c) => c.attrs.width));
  }

  console.log('\n[6] 칸 끌어 고르기 · Shift+누르기');
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  ok((await js('__t.lit()')) === 4 && same((await js('__t.litTexts()')).sort(), ['a', 'b', 'd', 'e']), '끌어서 2×2 를 고른다', await js('__t.litTexts()'));
  ok((await caret()).collapsed, '  글 고르기는 접힌다 (칸 고르기만 보인다)', await caret());
  t0 = await tools();
  ok(t0.bar.on && t0.merge.on && !t0.merge.off && t0.paint.on && t0.wipe.on, '  고른 칸 위 막대 — 칸 합치기 · 배경색 · 내용 지우기', t0);
  let cr = await js('__t.cellRect(0, 0, 0)');
  ok(t0.bar.b <= cr.top + 1 || t0.bar.t >= (await js('__t.cellRect(0, 1, 1)')).bottom - 1, '  막대는 고른 칸 위(자리가 없으면 아래)에', { bar: t0.bar, top: cr.top });
  await js(`__t.up(${(await js('__t.cellXY(0, 1, 1)')).x}, ${(await js('__t.cellXY(0, 1, 1)')).y})`);
  pr = await js('__t.downCell(0, 2, 2, { shift: true })');
  ok(pr === true && (await js('__t.lit()')) === 9, 'Shift+누르기 — 처음 칸부터 네모로 넓힌다 (3×3)', { pr, lit: await js('__t.lit()') });
  ok(await key({ key: 'Escape' }) && (await js('__t.lit()')) === 0, 'Esc — 칸 고르기가 풀린다');
  await sleep(40);
  ok((await js('window.__asks + window.__calls.close')) === 0, '  창은 안 닫는다 (닫을지도 안 묻는다)');
  const MERGED = tbl([['a', 'b', 'c'], ['d', { t: 'e', rs: 2, cs: 2 }], ['g']]);
  await reset(L1 + MERGED);
  await js('__t.downCell(0, 0, 1)');
  await js('__t.moveCell(0, 1, 0, { buttons: 1 })');
  ok((await js('__t.lit()')) === 6, '합친 칸에 걸치면 그 칸이 다 들어가게 넓힌다 (b→d 가 3×3 이 된다)', await js('__t.litTexts()'));
  await js('__t.downCell(0, 0, 0)');
  await js('__t.downCell(0, 1, 1, { shift: true })');
  ok((await js('__t.lit()')) === 6, '  Shift+누르기도 넓힌다', await js('__t.litTexts()'));
  await js(`__t.downAt('#l1')`);
  ok((await js('__t.lit()')) === 0, '바깥을 누르면 풀린다');
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  ok(!(await key({ key: 'x' })), '글자를 치면 — 키는 그대로 가고');
  await js(`document.execCommand('insertText', false, 'x'); true`);
  ok((await js('__t.lit()')) === 0 && (await texts())[0][0] === 'ax' && (await texts())[1][1] === 'e', '  칸 고르기는 풀리고 글은 처음 칸에', await texts());
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  ok(await key({ key: 'Delete' }), 'Delete — 고른 칸의 내용을 지운다');
  await sleep(30);
  ok(same(await texts(), [['', '', 'c'], ['', '', 'f'], ['g', 'h', 'i']]), '  구조는 그대로', await texts());
  await undo();
  ok(same(await texts(), [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]), '  Ctrl+Z 한 번에 돌아간다', await texts());
  await js('__t.downCell(0, 1, 1)');
  await js('__t.moveCell(0, 2, 2, { buttons: 1 })');
  ok(await key({ key: 'Backspace' }) && same(await texts(), [['a', 'b', 'c'], ['d', '', ''], ['g', '', '']]), 'Backspace 도', await texts());
  // 칸을 끌어 고르면 글 고르기가 접힌다 — 예전처럼 끌어서 복사할 수 있게, 고른 칸을 표(HTML)와 탭·줄 글로 싣는다.
  // 진짜 클립보드는 안 건드린다 — 화면 안에서 만든 DataTransfer 를 실은 ClipboardEvent 로만
  await reset(L1 + MERGED);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  const clip = (type) => js(`(() => { const dt = new DataTransfer(); const ev = new ClipboardEvent(${J(type)}, { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('body').dispatchEvent(ev); return { prevented: ev.defaultPrevented, text: dt.getData('text/plain'), html: dt.getData('text/html') }; })()`);
  let cp = await clip('copy');
  ok(cp.prevented && cp.text === 'a\tb' && /^<table/.test(cp.html) && (cp.html.match(/<td/g) || []).length === 2 && !/tg-on|data-tg/.test(cp.html), '복사 — 고른 칸을 탭 글과 표로 (편집 표시 없이)', cp);
  await js('__t.downCell(0, 0, 1)');
  await js('__t.moveCell(0, 1, 0, { buttons: 1 })');
  cp = await clip('copy');
  ok(cp.text === 'a\tb\tc\nd\te\t\ng\t\t' && /rowspan="2" colspan="2"/.test(cp.html), '  합친 칸은 왼쪽 위에 글, 나머지 자리는 빈 칸 (엑셀처럼) · 표에는 합친 칸 그대로', cp);
  cp = await clip('cut');
  ok(cp.prevented && cp.text === 'a\tb\tc\nd\te\t\ng\t\t' && same(await texts(), [['', '', ''], ['', ''], ['']]), '잘라내기 — 싣고 내용을 지운다 (구조는 그대로)', { cp, t: await texts() });
  await reset(L1);
  cp = await clip('copy');
  ok(!cp.prevented && cp.text === '', '  칸을 안 골랐으면 보통 복사 (건드리지 않는다)', cp);

  console.log('\n[7] 칸 합치기 · 나누기');
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  pr = await js(`__t.press('#tg-merge')`);
  await sleep(30);
  g = await grid();
  ok(pr.md === true && g[0][0].rs === 2 && g[0][0].cs === 2 && g[0][0].html === 'a<br>b<br>d<br>e' && g.flat().length === 6, '칸 합치기 — 왼쪽 위 칸에 rowspan·colspan, 글은 <br> 로 이어서', g.map((r) => r.map((c) => [c.html, c.rs, c.cs])));
  // 두 열을 걸친 칸에 왼쪽 위 칸의 낡은 너비(100px)가 남으면 엔진마다 열 너비가 엇갈린다 — 뗀다 (열 너비가 정한다 · tablegrid [15])
  ok(g[0][0].style === S && !('width' in g[0][0].attrs), '  왼쪽 위 칸의 스타일 (두 열을 걸친 칸의 낡은 너비는 뗀다)', g[0][0]);
  car = await caret();
  ok(car.inCell && car.row === 0 && car.col === 0, '  커서는 합친 칸', car);
  t0 = await tools();
  ok(t0.bar.on && t0.split.on && !t0.merge.on, '커서가 합친 칸에 있으면 막대에 «칸 나누기»', t0);
  await js(`__t.press('#tg-split')`);
  await sleep(30);
  g = await grid();
  ok(g.flat().length === 9 && g.flat().every((c) => c.rs === 1 && c.cs === 1) && g[0][0].html === 'a<br>b<br>d<br>e' && g[0][1].html === '<br>' && g[1][1].style === g[0][0].style,
    '칸 나누기 — 다 1×1, 글은 왼쪽 위에, 새 칸은 같은 스타일', g.map((r) => r.map((c) => c.text)));
  await undo();
  g = await grid();
  ok(g[0][0].rs === 2 && g.flat().length === 6, '  Ctrl+Z — 나누기 전(합친 칸)으로', g.map((r) => r.length));
  await undo();
  ok(same(await texts(), [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]), '  한 번 더 — 합치기 전으로', await texts());
  await reset(L1 + tbl([['h1', 'h2'], ['b1', 'b2'], ['c1', 'c2']], { head: true }));
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 0, { buttons: 1 })');
  t0 = await tools();
  ok(t0.merge.on && t0.merge.off && /머리글/.test(t0.merge.title), '머리글 줄(thead)과 본문 줄은 못 합친다 — 단추가 꺼지고 까닭을 title 로', t0.merge);
  await js(`__t.press('#tg-merge')`);
  ok((await grid()).flat().length === 6, '  눌러도 안 합쳐진다');

  console.log('\n[8] 배경색');
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  await js(`__t.press('#tg-paint')`);
  let ms = await js('__t.menus()');
  ok(ms.length === 1 && same(ms[0].items.map((i) => i.label), ['기본', '회색', '갈색', '주황', '노랑', '초록', '파랑', '보라', '분홍', '빨강']), '팔레트 — 기본과 노션의 옅은 채움 9가지', ms[0] && ms[0].items.map((i) => i.label));
  await js(`__t.pickItem('노랑')`);
  await sleep(30);
  g = await grid();
  ok([g[0][0], g[0][1], g[1][0], g[1][1]].every((c) => /background-color:#fbf3db/.test(c.style) && c.attrs.bgcolor === '#fbf3db') && !g[2][2].attrs.bgcolor, '노랑 — 고른 칸에 background-color + bgcolor', g.map((r) => r.map((c) => c.attrs.bgcolor || '')));
  ok((await js('__t.lit()')) === 4, '  칸 고르기는 그대로 (이어서 다른 것을 할 수 있다)', await js('__t.lit()'));
  await js(`__t.press('#tg-paint')`);
  await js(`__t.pickItem('기본')`);
  await sleep(30);
  g = await grid();
  ok(g.flat().every((c) => !/background/.test(c.style) && !c.attrs.bgcolor), '기본 — 둘 다 뗀다', g[0][0]);

  console.log('\n[9] 머리글');
  await reset(L1 + T3);
  const before9 = (await grid()).map((r) => r.map((c) => c.style));
  await gripOp('row', 0, 0, '머리글 켜기');
  g = await grid();
  ok(g[0].every((c) => /font-weight:bold/.test(c.style) && /background-color:#f1f1ef/.test(c.style) && c.attrs.bgcolor === '#f1f1ef') && g[1].every((c) => !/bold/.test(c.style)), '머리글 켜기 — 첫 줄 굵게 + 회색 (인라인)', g[0].map((c) => c.style));
  op = await gripOp('row', 0, 0, '머리글 끄기');
  g = await grid();
  ok(same(g.map((r) => r.map((c) => c.style)), before9) && g[0].every((c) => !c.attrs.bgcolor), '머리글 끄기 — 켤 때 넣은 것만 뗀다', g[0].map((c) => c.style));
  await gripOp('col', 0, 0, '머리글 켜기');
  g = await grid();
  ok(g.every((r) => /font-weight:bold/.test(r[0].style) && r[0].attrs.bgcolor === '#f1f1ef') && !/bold/.test(g[0][1].style), '열 손잡이 — 첫 열 머리글', g.map((r) => r[0].style));

  console.log('\n[10] 오른쪽 클릭 메뉴 — 키보드');
  await reset(L1 + T3);
  pr = await js('__t.ctx(0, 1, 1)');
  ms = await js('__t.menus()');
  const labels = ms[0] ? ms[0].items.map((i) => i.label) : [];
  ok(pr === true && ms.length === 1, '칸에서 오른쪽 클릭 — 메뉴가 뜬다 (기본 메뉴는 막는다)', labels);
  ok(['위에 행 넣기', '아래에 행 넣기', '왼쪽에 열 넣기', '오른쪽에 열 넣기', '행 지우기', '열 지우기', '칸 합치기', '칸 나누기', '배경색', '머리글 행 켜기', '머리글 열 켜기', '내용 지우기', '표 지우기'].every((l) => labels.includes(l)),
    '  모든 동작이 있다', labels);
  ok((await js('__t.active()')) === '위에 행 넣기', '  첫 칸이 골라져 있다', await js('__t.active()'));
  const offs = ms[0].items.filter((i) => i.off).map((i) => i.label);
  ok(offs.includes('칸 합치기') && offs.includes('칸 나누기'), '  칸 하나에서는 합치기·나누기가 꺼져 있다', offs);
  ok(await key({ key: 'ArrowDown' }) && (await js('__t.active()')) === '아래에 행 넣기', '  ↓', await js('__t.active()'));
  ok(await key({ key: 'Enter' }), '  Enter');
  await sleep(30);
  ok(same(await texts(), [['a', 'b', 'c'], ['d', 'e', 'f'], ['', '', ''], ['g', 'h', 'i']]) && (await js('__t.menus().length')) === 0, '  → 아래에 행 넣기', await texts());
  await reset(L1 + T3);
  await js('__t.ctx(0, 1, 1)');
  ok(await key({ key: 'Escape' }) && (await js('__t.menus().length')) === 0, 'Esc — 메뉴만 닫는다');
  await sleep(40);
  ok((await js('window.__asks + window.__calls.close')) === 0, '  창은 안 닫는다');
  await js('__t.ctx(0, 1, 1)');
  for (let i = 0; i < 20 && (await js('__t.active()')) !== '배경색'; i++) await key({ key: 'ArrowDown' });
  ok((await js('__t.active()')) === '배경색', '  ↓ 로 «배경색»까지 (꺼진 것은 건너뛴다)');
  await key({ key: 'ArrowRight' });
  ms = await js('__t.menus()');
  ok(ms.length === 2 && (await js('__t.active()')) === '기본', '  → 하위 메뉴(팔레트)가 열리고 첫 칸', ms.map((m) => m.items.length));
  await key({ key: 'ArrowDown' }); await key({ key: 'ArrowDown' });
  ok((await js('__t.active()')) === '갈색', '  ↓↓ «갈색»');
  await key({ key: 'ArrowLeft' });
  ok((await js('__t.menus().length')) === 1 && (await js('__t.active()')) === '배경색', '  ← 하위 메뉴만 닫힌다');
  await key({ key: 'ArrowRight' }); await key({ key: 'ArrowDown' }); await key({ key: 'ArrowDown' });
  await key({ key: 'Enter' });
  await sleep(30);
  g = await grid();
  ok(/background-color:#f4eeee/.test(g[1][1].style) && g[1][1].attrs.bgcolor === '#f4eeee' && !g[1][0].attrs.bgcolor, '  Enter → 그 칸에 갈색', g[1].map((c) => c.attrs.bgcolor || ''));
  await reset(L1 + T3);
  const corner = await js(`(() => ({ x: innerWidth - 3, y: innerHeight - 3, w: innerWidth, h: innerHeight }))()`);
  await js(`__t.ctx(0, 2, 2, ${corner.x}, ${corner.y})`);
  ms = await js('__t.menus()');
  ok(ms.length === 1 && ms[0].rect.l >= 0 && ms[0].rect.t >= 0 && ms[0].rect.r <= corner.w && ms[0].rect.b <= corner.h, '창 구석에서 열어도 메뉴는 창 안에', { rect: ms[0] && ms[0].rect, corner });
  await js(`__t.pickItem('표 지우기')`);
  await sleep(30);
  ok((await js('__t.ntables()')) === 0, '표 지우기', await js('__t.seq()'));
  await reset(L1 + T3);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  await js('__t.ctx(0, 0, 1)');
  ms = await js('__t.menus()');
  ok((await js('__t.lit()')) === 2 && ms[0] && !ms[0].items.find((i) => i.label === '칸 합치기').off, '고른 칸 안에서 오른쪽 클릭 — 고르기는 그대로, 칸 합치기가 켜진다', ms[0] && ms[0].items.filter((i) => !i.off).map((i) => i.label));
  await js(`__t.pickItem('칸 합치기')`);
  await sleep(30);
  g = await grid();
  ok(g[0][0].cs === 2 && g[0][0].html === 'a<br>b', '  → 합친다', g[0].map((c) => [c.html, c.cs]));
  await js('__t.caretIn(0, 0, 0)');
  await js('__t.ctx(0, 0, 0)');
  ms = await js('__t.menus()');
  ok(!ms[0].items.find((i) => i.label === '칸 나누기').off, '합친 칸에서는 칸 나누기가 켜진다');
  await js(`__t.pickItem('칸 나누기')`);
  await sleep(30);
  ok((await grid())[0].length === 3, '  → 나눈다', (await grid())[0].length);
  await js('__t.ctx(0, 0, 0)');
  await js(`__t.pickItem('머리글 열 켜기')`);
  await sleep(30);
  ok((await grid()).every((r) => r[0].attrs.bgcolor === '#f1f1ef'), '머리글 열 켜기', (await grid()).map((r) => r[0].attrs.bgcolor));

  console.log('\n[11] Tab · Shift+Tab');
  await reset(L1 + T3);
  await js('__t.caretIn(0, 0, 0)');
  ok(await key({ key: 'Tab', code: 'Tab' }), 'Tab — 칸 안에서는 막고');
  car = await caret();
  ok(car.inCell && car.row === 0 && car.col === 1 && car.text === 'b' && car.off === 0, '  다음 칸 맨 앞으로', car);
  ok(await key({ key: 'Tab', code: 'Tab', shiftKey: true }) && (await caret()).col === 0, 'Shift+Tab — 앞 칸', await caret());
  await js('__t.caretIn(0, 0, 2)');
  await key({ key: 'Tab', code: 'Tab' });
  car = await caret();
  ok(car.row === 1 && car.col === 0, '  줄 끝에서는 다음 줄 첫 칸', car);
  await reset(L1 + tbl([['a', { t: 'b', cs: 2 }], [{ t: 'c', rs: 2 }, 'd', 'e'], ['f', 'g']]));
  await js('__t.caretIn(0, 0, 1)');
  await key({ key: 'Tab', code: 'Tab' });
  ok((await caret()).text === 'c', '합친 칸이 덮은 자리는 건너뛴다 (b → c)', await caret());
  await js('__t.caretIn(0, 1, 2)');
  await key({ key: 'Tab', code: 'Tab' });
  ok((await caret()).text === 'f', '  e → f (c 가 덮은 자리 건너뜀)', await caret());
  await js('__t.caretIn(0, 2, 1)');
  await key({ key: 'Tab', code: 'Tab' });
  await sleep(30);
  g = await grid();
  car = await caret();
  ok(g.length === 4 && car.inCell && car.row === 3 && car.col === 0, '마지막 칸에서 Tab — 줄을 하나 더 만들고 그 첫 칸으로', { rows: g.length, car });
  await js('__t.caretIn(0, 0, 0, 0)');
  ok(!(await key({ key: 'Tab', code: 'Tab', isComposing: true })), '한글 조합 중의 Tab 은 건드리지 않는다');
  await reset(L1);
  ok(!(await key({ key: 'Tab', code: 'Tab' })), '표 밖의 Tab 은 예전 그대로 (막지 않는다)');

  console.log('\n[12] 편집 표시는 본문 밖으로 안 나간다');
  await reset(L1 + T3);
  const plain0 = await js('plainText()');
  const dirty0 = await js('dirty()');
  await hoverCell(1, 1);
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 1, 1, { buttons: 1 })');
  await js('__t.ctx(0, 0, 0)');
  ok((await js('__t.lit()')) === 4 && (await js('__t.menus().length')) === 1 && (await tools()).row.on, '(고른 칸 4 · 메뉴 · 손잡이가 떠 있는 동안)');
  ok(/tg-on/.test(await js(`document.getElementById('body').innerHTML`)), '  본문 DOM 에는 고른 칸 표시가 있다 (떼는 길을 시험한다)');
  const sent12 = await js(`(async () => (await bodyForSend()).html)()`);
  ok(!/tg-|data-tg|class=""/.test(sent12), '보내는 html 에 편집 표시가 없다', (sent12.match(/tg-[a-z]+|data-tg[a-z-]*|class=""/) || [])[0]);
  ok(!/tg-|data-tg|class=""/.test(await js('draftNow().bodyHtml')), '임시 저장 html 에도 없다');
  await js('saveDraftNow(); true');
  ok(!/tg-|class=""/.test(await js('window.__calls.draft.length ? window.__calls.draft[window.__calls.draft.length - 1].bodyHtml : ""')), '  메인에 보낸 임시 저장에도 없다');
  ok((await js('plainText()')) === plain0 && !/⋮|＋|칸 합치기|배경색/.test(await js('plainText()')), '글 몫(plainText)은 그대로', await js('plainText()'));
  ok((await js('dirty()')) === dirty0, '«쓰던 글이 있나»도 그대로 (고르기만으로 바뀌지 않는다)', { before: dirty0, after: await js('dirty()') });
  await key({ key: 'Escape' }); await key({ key: 'Escape' });
  ok(!/tg-on|class=""/.test(await js(`document.getElementById('body').innerHTML`)), '고르기를 풀면 본문 DOM 에도 흔적(class="")이 없다');
  await reset('<div id="l1"><br></div>');
  const base12 = await js(`(() => { context.bodyHtml = document.getElementById('body').innerHTML.trim(); return dirty(); })()`);
  await js(`__t.press('#btn-table')`);
  await key({ key: 'Escape' });
  ok(base12 === false && (await js('dirty()')) === false, '고르개를 열었다 닫기만 하면 쓰던 글이 생기지 않는다');

  console.log('\n[13] 엑셀에서 붙인 표도 같은 도구로');
  await reset();
  await js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${J(C.EXCEL_TEXT)}); dt.setData('text/html', ${J(C.EXCEL_HTML)});
    document.getElementById('body').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  await sleep(200);
  g = await grid();
  ok(g.length === 4 && g[0][0].text === '이름', '(엑셀 표를 붙였다)', g.map((r) => r.map((c) => c.text)));
  const head0 = g[0][0];
  await gripOp('row', 1, 0, '아래에 행 넣기');
  g = await grid();
  ok(g.length === 5 && g[0][0].style === head0.style && g[0][0].attrs.bgcolor === '#ffff00', '손잡이로 줄 넣기 — 붙인 표의 스타일은 그대로', { rows: g.length, s: g[0][0].style });
  await js('__t.downCell(0, 0, 0)');
  await js('__t.moveCell(0, 0, 1, { buttons: 1 })');
  await js(`__t.press('#tg-merge')`);
  await sleep(30);
  g = await grid();
  ok(g[0][0].cs === 2 && g[0][0].html === '이름<br>부서', '  칸 합치기도', g[0].map((c) => [c.html, c.cs]));
  ok((await js('tgStats.fallbacks')) === 0, '  insertHTML 이 붙인 표의 마크업도 그대로 넣었다', await js('tgStats.fallbacks'));

  console.log('\n[14] 인용문·서명 안의 표');
  await open({ ...BASE, to: '', title: '답장', signature: '<table style="border-collapse:collapse"><tr><td>서명1</td><td>서명2</td></tr></table>',
    quoteHead: '누가 썼다', quoteHtml: '<p>원문</p><table border="1"><tr><td>q1</td><td>q2</td></tr><tr><td>q3</td><td>q4</td></tr></table>' });
  ok((await js('__t.ntables()')) === 2, '(서명 표 · 인용문 표)', await js('__t.seq()'));
  await hoverCell(0, 0, 1);
  t0 = await tools();
  ok(t0.row.on && t0.col.on, '인용문 표 칸에 마우스 — 손잡이', t0.row);
  await js(`__t.press('#tg-row')`);
  await js(`__t.pickItem('아래에 행 넣기')`);
  await sleep(30);
  ok(same(await texts(1), [['q1', 'q2'], ['', ''], ['q3', 'q4']]) && (await js(`!!document.querySelector('#body blockquote table')`)), '  인용문 표에 줄 넣기 (인용문 안 그대로)', await texts(1));
  await hoverCell(0, 1, 0);
  await js(`__t.press('#tg-add-col')`);
  await sleep(30);
  ok(same(await texts(0), [['서명1', '서명2', '']]) && (await js(`!!document.querySelector('#body .sig table')`)), '서명 표에 열 넣기 (서명 안 그대로)', await texts(0));

  ok((await js('tgStats.fallbacks')) === 0, '시험 내내 insertHTML 대신 DOM 으로 바꾼 일 없음 (셈마다 Ctrl+Z 한 번)', await js('tgStats.fallbacks'));
  ok(net.length === net0, '시험 내내 바깥 요청 0', net.slice(net0, net0 + 4));
  const bads = errors.filter((e) => !/Autofill|DevTools/.test(e));
  ok(!bads.length, '쓰기 창 콘솔에 오류 없음', bads.slice(0, 4));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); app.exit(1); });

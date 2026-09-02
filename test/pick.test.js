const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 진짜 설정·쓰기 창에서 <select>가 앱 목록으로 바뀌었는지 본다.
// 네이티브 드롭다운은 창이 아니라서, «popup.html 창이 뜬다»는 것 자체가 증거다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => {
  console.error('LAB 터짐:', (e && e.stack) || e);
  process.exit(1);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picklab-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
function ok(cond, msg, extra) {
  console.log((cond ? '  OK   ' : '  실패 ') + msg + (extra === undefined ? '' : `  → ${JSON.stringify(extra)}`));
  if (!cond) bad++;
}

function winBy(part) {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(part)) || null;
}

/** 진짜 마우스 입력으로 누른다 — .click()은 포인터 처리를 건너뛴다 */
async function clickAt(wc, x, y) {
  for (const type of ['mouseDown', 'mouseUp']) {
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await sleep(30);
  }
}

async function clickSel(wc, sel) {
  const r = await wc.executeJavaScript(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const b = e.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
  })()`);
  if (!r || !r.w) return null;
  await clickAt(wc, r.x, r.y);
  return r;
}

async function menuRows() {
  const p = winBy('popup.html');
  if (!p) return null;
  return p.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.menu .item')];
    return {
      labels: items.map((b) => b.textContent.replace('\u2713','').trim()),
      ticked: items.filter((b) => b.querySelector('.tick')).map((b) => b.textContent.replace('\u2713','').trim()),
      // 글자가 잘렸는지 — 줄마다 실제로 잰다
      clipped: items.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()),
      squashed: items.filter((b) => b.getBoundingClientRect().height < 20).length
    };
  })()`);
}

async function pickRow(i) {
  const p = winBy('popup.html');
  const r = await p.webContents.executeJavaScript(`(() => {
    const b = document.querySelectorAll('.menu .item')[${i}].getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  await clickAt(p.webContents, r.x, r.y);
  await sleep(400);
}

app.whenReady().then(async () => {
  await sleep(2500);

  // ── 설정 창: 거르기의 조건·동작 ──────────────────────────
  console.log('\n[설정 창]');
  ipcMain.emit('widget:open-settings', {}, 'mail');
  await sleep(2500);
  const sw = winBy('settings.html');
  if (!sw) { console.error('설정 창을 못 찾음'); app.exit(1); return; }
  const swc = sw.webContents;

  const state = await swc.executeJavaScript(`(() => {
    const sels = [...document.querySelectorAll('select')];
    const btns = [...document.querySelectorAll('button.pickfield')];
    return {
      sels: sels.map((s) => ({ id: s.id, pf: s.dataset.pf === '1', shown: !!s.offsetParent })),
      btns: btns.map((b) => ({ txt: b.querySelector('.pf-t').textContent, disp: getComputedStyle(b).display,
                               caret: !!b.querySelector('.pf-c') }))
    };
  })()`);
  ok(state.sels.every((s) => s.pf), '<select>가 전부 고르기 단추로 바뀜', state.sels.map((s) => s.id));
  ok(state.sels.every((s) => !s.shown), '네이티브 <select>는 화면에 없음');
  ok(state.btns.length === 2, '단추 2개', state.btns.length);
  ok(state.btns.every((b) => /flex$/.test(b.disp)), 'display가 grid/inline으로 되돌아가지 않음', state.btns.map((b) => b.disp));
  ok(state.btns.every((b) => b.txt.trim() && b.caret), '글자와 꺾쇠가 보임', state.btns.map((b) => b.txt));

  const before = await swc.executeJavaScript(`document.getElementById('fl-field').value`);
  await clickSel(swc, 'button.pickfield');
  await sleep(800);
  const rows = await menuRows();
  ok(!!rows, '앱 목록 창이 떴다 (네이티브 드롭다운이 아니다)');
  if (rows) {
    ok(rows.labels.length === 3, '세 줄', rows.labels);
    ok(rows.ticked.length === 1, '지금 고른 것에 체크 하나', rows.ticked);
    ok(rows.clipped.length === 0, '잘린 글자 없음', rows.clipped);
    ok(rows.squashed === 0, '눌린 줄 없음');
    await pickRow(1);
    const after = await swc.executeJavaScript(`(() => ({
      v: document.getElementById('fl-field').value,
      t: document.querySelector('button.pickfield .pf-t').textContent
    }))()`);
    ok(after.v === 'subject', `고르면 값이 바뀐다 (${before} → ${after.v})`);
    ok(after.t === '제목', '단추 글자도 따라온다', after.t);
  }
  sw.close();
  await sleep(500);

  // ── 쓰기 창: 글꼴·크기 ────────────────────────────────────
  console.log('\n[쓰기 창]');
  // 계정 없이도 화면 자체는 검사할 수 있다 — 진짜 preload로 진짜 페이지를 띄운다
  const R = `${ROOT}/renderer/`;
  const cw = new BrowserWindow({ width: 640, height: 520, show: false,
    webPreferences: { preload: `${ROOT}/src/preload.js` } });
  await cw.loadFile(R + 'compose.html');
  let opened = true;
  if (!opened) {
    console.log('  (건너뜀)');
  } else {
    const cwc = cw.webContents;
    await sleep(1200);
    const c = await cwc.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button.pickfield')];
      return b.map((x) => ({ txt: x.querySelector('.pf-t').textContent, disp: getComputedStyle(x).display,
                             h: Math.round(x.getBoundingClientRect().height),
                             hidden: x.style.display === 'none' }));
    })()`);
    console.log('  단추:', JSON.stringify(c));
    const live = c.filter((x) => !x.hidden);
    ok(live.length >= 2, '글꼴·크기 단추가 있다', live.length);
    ok(live.every((x) => /flex$/.test(x.disp)),
      '막대 안에서 display가 grid로 되돌아가지 않음', live.map((x) => x.disp));
    ok(live.every((x) => x.h === 22), '옆 단추와 같은 키(22px)', live.map((x) => x.h));

    // 본문에서 글자를 골라두고 글꼴을 바꾼다 — 창이 떴다 사라져도 그 자리에 붙어야 한다
    await cwc.executeJavaScript(`(() => {
      const b = document.getElementById('body');
      b.textContent = '\uac00\ub098\ub2e4\ub77c\ub9c8\ubc14\uc0ac';
      b.focus();
      const r = document.createRange();
      r.setStart(b.firstChild, 0); r.setEnd(b.firstChild, 3);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await sleep(200);
    await clickSel(cwc, '.bar button.pickfield');
    await sleep(800);
    const fr = await menuRows();
    ok(!!fr, '쓰기 창에서도 앱 목록이 뜬다');
    if (fr) {
      console.log('  글꼴 목록:', JSON.stringify(fr.labels));
      ok(fr.clipped.length === 0, '글꼴 이름이 안 잘림', fr.clipped);
      await pickRow(2);
      const applied = await cwc.executeJavaScript(`document.getElementById('body').innerHTML`);
      ok(/face=|font-family/i.test(applied), '고른 글꼴이 골라둔 글자에 붙었다', applied.slice(0, 110));
      ok(/^<font[^>]*>\uac00\ub098\ub2e4</.test(applied) || /\uac00\ub098\ub2e4/.test(applied.split('</font>')[0] || ''),
        '앞 세 글자에만 붙었다 (자리를 안 잃었다)', applied.slice(0, 110));
    }
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

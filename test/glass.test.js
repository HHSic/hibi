const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 유리 진하기 규칙 — 창을 하나도 안 띄우고 계산과 배선만 잰다.
//
// 라이트 모드에서 글자가 안 읽힌 까닭 하나는 유리가 너무 옅어질 수 있던 것이었다.
// 그래서 «칠할 값»은 src/win.js effScrim 한 곳에서만 정하고, 창은 받은 값을 칠하기만 한다 (renderer/theme.js).
// 여기서 보는 것:
//   [1] effScrim — 라이트 바닥 0.90, 다크는 예전 그대로, 빽빽한 창 +0.04 (최대 0.96)
//   [2] glassQuery — 주소의 ?scrim 이 저장값이 아니라 칠할 값인가 (테마를 바꿔 가며)
//   [3] broadcastGlass — 살아 있는 창에만 같은 모양으로 가나, 윈도우 테마가 바뀌면 따라가나
//   [4] theme.js — 주소와 방송을 문서에 입히나, 다리가 없거나 가짜여도 안 멈추나
//   [5] 배선 — preload·main 이 약속한 이름으로 서로를 부르나
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { app, nativeTheme, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glasslab-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const store = require(`${ROOT}/src/store.js`);
const glass = require(`${ROOT}/src/glass.js`);
const win = require(`${ROOT}/src/win.js`);

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

app.whenReady().then(async () => {
  console.log('\n[1] effScrim — 칠할 유리 알파');
  const { effScrim } = win;
  const LIGHT = false;
  const DARK = true;
  for (const [raw, dark, dense, want, why] of [
    [0.40, LIGHT, false, 0.90, '라이트는 0.90 아래로 안 내린다'],
    [0.92, LIGHT, false, 0.92, '기본값은 그대로'],
    [0.98, LIGHT, false, 0.98, '위쪽은 슬라이더가 그대로 먹는다'],
    [0.40, LIGHT, true, 0.94, '빽빽한 창은 바닥에서 +0.04'],
    [0.92, LIGHT, true, 0.96, '빽빽한 창 기본값'],
    [0.40, DARK, false, 0.40, '다크는 예전처럼 0.40까지'],
    [0.40, DARK, true, 0.44, '다크 빽빽한 창도 예전과 같다'],
    [0.98, DARK, true, 0.96, '빽빽한 창은 0.96에서 멈춘다'],
    ['x', LIGHT, false, 0.92, '숫자가 아니면 기본값'],
    ['x', DARK, false, 0.92, '숫자가 아니면 기본값 (다크)'],
    [null, DARK, false, 0.92, 'null 을 0 으로 읽지 않는다'],
    ['', LIGHT, false, 0.92, '빈 글자를 0 으로 읽지 않는다'],
    [undefined, LIGHT, true, 0.96, '값이 없으면 기본값 (빽빽한 창)'],
    ['0.5', DARK, false, 0.5, '주소·IPC 에서 온 글자 숫자도 읽는다'],
    [1.5, DARK, false, 0.98, '너무 크면 0.98'],
    [0.1, DARK, false, 0.40, '너무 작으면 0.40']
  ]) {
    const got = effScrim(raw, dark, dense);
    ok(got === want, `(${JSON.stringify(raw)}, ${dark ? 'dark' : 'light'}${dense ? ', dense' : ''}) = ${want} — ${why}`, got);
  }
  ok(String(effScrim(0.92, LIGHT, true)) === '0.96', '0.92+0.04 가 소수 찌꺼기 없이 "0.96" 으로 적힌다', String(effScrim(0.92, LIGHT, true)));

  // 다크는 예전 모습 그대로여야 한다 — 저장될 수 있는 값 전부(슬라이더 40~98, 1%씩)를 옛 계산과 맞춰 본다
  let diff = null;
  for (let v = 40; v <= 98 && !diff; v++) {
    const s = v / 100;
    if (effScrim(s, DARK, false) !== s) diff = ['일반', s, effScrim(s, DARK, false)];
    const old = Math.min(0.96, s + 0.04);   // 예전 settings.js·stocks.js 가 화면에서 하던 계산
    if (!diff && Math.abs(effScrim(s, DARK, true) - old) > 1e-9) diff = ['빽빽', s, effScrim(s, DARK, true), old];
  }
  ok(!diff, '다크: 슬라이더 40~98 전부 예전과 같은 값 (일반=저장값, 빽빽=min(0.96, s+0.04))', diff || undefined);
  ok(win.SCRIM && win.SCRIM.lightFloor === 0.90, 'SCRIM 상수를 내보낸다', win.SCRIM);

  console.log('\n[2] glassQuery — 주소의 ?scrim 은 칠할 값이다');
  const setTheme = async (t) => { nativeTheme.themeSource = t; await sleep(80); };
  for (const [theme, stored, plain, dense] of [
    ['light', 0.40, '0.9', '0.94'],
    ['light', 0.92, '0.92', '0.96'],
    ['light', 0.98, '0.98', '0.96'],
    ['dark', 0.40, '0.4', '0.44'],
    ['dark', 0.92, '0.92', '0.96']
  ]) {
    await setTheme(theme);
    ok(nativeTheme.shouldUseDarkColors === (theme === 'dark'), `(준비) 테마를 ${theme} 로 바꿨다`, nativeTheme.shouldUseDarkColors);
    store.setSettings({ scrim: stored });
    const a = win.glassQuery({ radius: '20' });
    const b = win.glassQuery({ radius: '20', dense: '1', tab: 'look' });
    ok(a.theme === theme && a.scrim === plain && a.radius === '20' && a.dense === undefined,
      `${theme} · 저장 ${stored} → ?scrim=${plain}`, a);
    ok(b.theme === theme && b.scrim === dense && b.dense === '1' && b.tab === 'look',
      `${theme} · 저장 ${stored} · dense → ?scrim=${dense} 이고 ?dense=1 도 실린다`, b);
  }
  const q0 = win.glassQuery();
  ok(q0.inset === String(glass.INSET) && q0.ctlh === String(glass.CONTROLS) && typeof q0.scrim === 'string',
    '인자 없이 불러도 되고 여백 값은 예전 그대로', q0);

  console.log('\n[3] broadcastGlass — 열린 창 전부에, 같은 모양으로');
  const sent = [];
  const fake = (name, dead, wcDead) => ({
    isDestroyed: () => !!dead,
    webContents: { isDestroyed: () => !!wcDead, send: (ch, g) => sent.push({ name, ch, g }) }
  });
  const fakes = [fake('widget'), fake('closed', true), fake('crashed', false, true), fake('settings')];
  const realAll = BrowserWindow.getAllWindows;
  BrowserWindow.getAllWindows = () => fakes;
  ok(BrowserWindow.getAllWindows() === fakes, '(준비) 창 목록을 가짜로 바꿨다');

  await setTheme('light');
  store.setSettings({ scrim: 0.5 });
  win.broadcastGlass();
  ok(sent.map((s) => s.name).join() === 'widget,settings', '닫혔거나 내용이 죽은 창은 건너뛴다', sent.map((s) => s.name));
  ok(sent.every((s) => s.ch === 'glass'), "채널 이름은 'glass'");
  ok(same(sent[0] && sent[0].g, { theme: 'light', scrim: 0.9, scrimDense: 0.94 }),
    '인자 없으면 저장값 0.5 — 라이트 바닥이 걸린 값이 간다', sent[0] && sent[0].g);

  sent.length = 0;
  win.broadcastGlass(0.97);
  ok(same(sent[0] && sent[0].g, { theme: 'light', scrim: 0.97, scrimDense: 0.96 }), '미리보기 값을 주면 그 값으로', sent[0] && sent[0].g);
  ok(store.settings.scrim === 0.5, '미리보기는 저장값을 안 바꾼다', store.settings.scrim);
  ok(same(win.glassState(), { theme: 'light', scrim: 0.9, scrimDense: 0.94 }), 'glassState() 도 저장값으로 계산한다', win.glassState());

  // main.js 와 같은 배선 — 윈도우 앱 모드가 바뀌면 다시 알린다
  sent.length = 0;
  const onUpdated = () => win.broadcastGlass();
  nativeTheme.on('updated', onUpdated);
  await setTheme('dark');
  await sleep(200);
  nativeTheme.removeListener('updated', onUpdated);
  const last = sent[sent.length - 1];
  ok(!!last && same(last.g, { theme: 'dark', scrim: 0.5, scrimDense: 0.54 }),
    "테마가 바뀌면 'updated' 로 다크 값이 다시 간다", last && last.g);
  BrowserWindow.getAllWindows = realAll;
  nativeTheme.themeSource = 'system';

  console.log('\n[4] renderer/theme.js — 받은 값을 문서에 입힌다');
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme.js'), 'utf8');
  // 창 없이 돌린다 — theme.js 가 쓰는 것(document·location·window)만 흉내 낸다
  const runTheme = (search, bridge) => {
    const props = {};
    const root = { dataset: {}, style: { setProperty: (k, v) => { props[k] = v; } } };
    const ctx = { document: { documentElement: root }, location: { search }, URLSearchParams };
    ctx.window = ctx;
    if (bridge !== undefined) ctx.nunsseom = bridge;
    let threw = null;
    try { vm.runInNewContext(code, ctx); } catch (e) { threw = e.message; }
    return { root, props, threw };
  };
  {
    let cb = null;
    const r = runTheme('?theme=light&scrim=0.9&inset=12', { onGlass: (f) => { cb = f; } });
    ok(!r.threw && r.root.dataset.theme === 'light' && r.props['--scrim-a'] === '0.9',
      '처음엔 주소대로 (theme=light, --scrim-a 0.9)', { threw: r.threw, theme: r.root.dataset.theme, props: r.props });
    ok(typeof cb === 'function', "'glass' 방송을 구독한다");
    if (cb) {
      cb({ theme: 'dark', scrim: 0.4, scrimDense: 0.44 });
      ok(r.root.dataset.theme === 'dark' && r.props['--scrim-a'] === '0.4', '방송이 오면 테마·진하기가 바뀐다 (일반 창은 scrim)',
        { theme: r.root.dataset.theme, props: r.props });
      let threw = null;
      try { cb(undefined); } catch (e) { threw = e.message; }
      ok(!threw && r.root.dataset.theme === 'dark', '빈 방송은 무시한다', threw || undefined);
    }
  }
  {
    let cb = null;
    const r = runTheme('?theme=dark&scrim=0.96&dense=1', { onGlass: (f) => { cb = f; } });
    ok(r.props['--scrim-a'] === '0.96', '빽빽한 창도 처음엔 주소 값 그대로 (메인이 이미 더했다)', r.props);
    if (cb) cb({ theme: 'light', scrim: 0.9, scrimDense: 0.94 });
    ok(r.root.dataset.theme === 'light' && r.props['--scrim-a'] === '0.94', '?dense=1 이면 방송에서 scrimDense 를 고른다', r.props);
  }
  {
    const r = runTheme('', undefined);
    ok(!r.threw && r.root.dataset.theme === 'dark' && !('--scrim-a' in r.props),
      '다리가 없어도 안 멈추고, 주소가 비면 다크·페이지 기본 진하기', { threw: r.threw, theme: r.root.dataset.theme, props: r.props });
    const r2 = runTheme('?theme=light', {});
    ok(!r2.threw && r2.root.dataset.theme === 'light', 'onGlass 가 없는 다리에서도 안 멈춘다', r2.threw || undefined);
    // test/fixtures/*-bridge-stub.js 와 같은 Proxy 다리
    const proxy = new Proxy({}, { get: (t, k) => (typeof k === 'string' && k.startsWith('on') ? () => {} : () => Promise.resolve(null)) });
    const r3 = runTheme('?theme=light&scrim=0.92', proxy);
    ok(!r3.threw && r3.root.dataset.theme === 'light' && r3.props['--scrim-a'] === '0.92', '시험용 Proxy 다리에서도 안 멈춘다', r3.threw || undefined);
    const r4 = runTheme('?theme=light&scrim=x', undefined);
    ok(!r4.threw && r4.root.dataset.theme === 'light' && !('--scrim-a' in r4.props), '숫자가 아닌 scrim 은 칠하지 않는다', r4.props);
  }

  console.log('\n[5] 배선 — 약속한 이름으로 서로를 부르나');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const preload = read('src/preload.js');
  const main = read('src/main.js');
  const stockwin = read('src/stockwin.js');
  ok(/onGlass:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('glass'/.test(preload), "preload: onGlass 가 'glass' 를 듣는다");
  ok(/previewScrim:\s*\(v\)\s*=>\s*ipcRenderer\.send\('glass:preview'/.test(preload), "preload: previewScrim 이 'glass:preview' 로 보낸다");
  ok(!/onScrim/.test(preload), 'preload: 위젯만 받던 옛 onScrim 은 없다');
  ok(/ipcMain\.on\('glass:preview'/.test(main), "main: 'glass:preview' 를 받는다");
  ok(/nativeTheme\.on\('updated'/.test(main), 'main: 윈도우 테마 변화를 듣는다');
  ok(!/send\('scrim'/.test(main), "main: 위젯에만 가던 'scrim' 은 없다");
  ok(/page\('settings\.html'\)[\s\S]{0,300}dense: '1'/.test(main), 'main: 설정 창은 dense');
  ok(/page\('stocks\.html'\)[^\n]*dense: '1'/.test(stockwin), 'stockwin: 주식 창은 dense');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

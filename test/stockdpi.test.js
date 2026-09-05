const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 확대 배율 150%에서 주식 창이 «계속 커지는지» 잰다.
//
// 창 크기를 바꾸는 길은 그립 드래그 하나뿐이고, 그 계산은 누르는 순간의 크기(b)를
// 붙잡아 두므로 이론상 누적될 수 없다. 그런데도 커진다면, 어긋나는 것은 «단위»다:
//   · 렌더러가 쓰는 e.screenX 는 무슨 픽셀인가 (CSS 픽셀? 진짜 화면 픽셀?)
//   · 메인이 setBounds 에 주는 값은 DIP 다
// 이 둘의 배율이 다르면 마우스보다 빨리 자란다. 그래서 여기서는
//   (1) 두 단위가 실제로 같은지 재고
//   (2) «움직이지 않는» 마우스로 여러 번 move 를 보내 크기가 자라는지 보고
//   (3) 같은 거리를 끌었을 때 100% 와 150% 가 같은 만큼 커지는지 견준다.
//
// 배율은 --force-device-scale-factor 로 강제한다. 이 시험은 그 값을 바꿔 가며
// 자기 자신을 두 번 돌린다 (기계의 진짜 배율에 기대지 않게).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
// 조용히 멈추는 것이 제일 나쁘다 — 닫힌 창에 executeJavaScript 를 하면 여기로 온다
process.on('unhandledRejection', (e) => { console.error('LAB 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과 — 어딘가 멈췄다'); process.exit(1); }, 180_000).unref();

const SCALE = Number(process.env.HIBI_SCALE || '1.5');
app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));
app.commandLine.appendSwitch('high-dpi-support', '1');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `stockdpi-${String(SCALE).replace('.', '_')}-`));
app.setPath('appData', tmp);

require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

/**
 * 잡았다 놓기를 n 번 되풀이한다. 한 번도 «안 움직이고».
 *
 * 이게 사용자가 말한 «계속 커진다»를 가장 가깝게 흉내 낸다: 창 가장자리를 여러 번
 * 집었다 놓는데 크기가 조금씩 자란다면, 한 번의 왕복마다 남는 오차가 있다는 뜻이다.
 * 150% 에서는 화면좌표가 소수로 온다(601.3333… 실측) — 그 소수가 정수로 접히는
 * 자리마다 반올림이 한 번씩 생긴다.
 */
async function grabRelease(wc, dir, times, jitter) {
  return wc.executeJavaScript(`(async () => {
    const g = document.querySelector('.grip.' + ${JSON.stringify(dir)});
    const mk = (type, sx, sy) => new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      screenX: sx, screenY: sy, clientX: 5, clientY: 5
    });
    // 150% 에서 크로미움이 실제로 주는 모양의 좌표 — 1/1.5 격자 위의 소수
    const grid = (n) => Math.round(n * 1.5) / 1.5;
    const out = [];
    for (let i = 0; i < ${times}; i++) {
      const base = grid(400 + i * ${jitter});
      g.dispatchEvent(mk('pointerdown', base, base));
      await new Promise((r) => setTimeout(r, 260));
      window.dispatchEvent(mk('pointermove', base, base));   // 제자리
      await new Promise((r) => setTimeout(r, 80));
      window.dispatchEvent(mk('pointerup', base, base));
      await new Promise((r) => setTimeout(r, 120));
      out.push(base);
    }
    return out;
  })()`);
}

/** 그립을 잡고, 준 만큼 화면좌표를 옮기고, 놓는다 — 진짜 이벤트로 */
async function dragGrip(wc, dir, steps) {
  return wc.executeJavaScript(`(async () => {
    const g = document.querySelector('.grip.' + ${JSON.stringify(dir)});
    if (!g) return { error: '그립 없음' };
    const S0 = { x: 400, y: 300 };
    const mk = (type, sx, sy) => new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      screenX: sx, screenY: sy, clientX: 5, clientY: 5
    });
    g.dispatchEvent(mk('pointerdown', S0.x, S0.y));
    // 그립 처리기가 bounds 를 «기다렸다가» move 를 걸므로, 그 전에 쏘면 다 흘린다
    await new Promise((r) => setTimeout(r, 400));
    for (const [dx, dy] of ${JSON.stringify(steps)}) {
      window.dispatchEvent(mk('pointermove', S0.x + dx, S0.y + dy));
      await new Promise((r) => setTimeout(r, 60));
    }
    window.dispatchEvent(mk('pointerup', S0.x, S0.y));
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true };
  })()`);
}

app.whenReady().then(async () => {
  await sleep(2500);
  const disp = screen.getPrimaryDisplay();
  console.log(`\n=== 강제 배율 ${SCALE} · 전자가 본 scaleFactor ${disp.scaleFactor} ===`);
  ok(Math.abs(disp.scaleFactor - SCALE) < 0.001, `배율이 실제로 ${SCALE} 로 걸렸다`, disp.scaleFactor);

  // 주식 기능을 켜고 창을 연다
  store.setSettings({ stocksEnabled: true });
  await sleep(400);
  ipcMain.emit('stocks:open', {});
  for (let i = 0; i < 40 && !winBy('stocks.html'); i++) await sleep(200);
  const sw = winBy('stocks.html');
  if (!sw) { console.log('주식 창이 안 열렸다'); app.exit(1); return; }
  await sleep(1500);
  const wc = sw.webContents;

  console.log('\n[1] 렌더러의 화면좌표와 메인의 DIP 가 같은 자로 재는가');
  const b0 = sw.getBounds();
  const view = await wc.executeJavaScript(
    '({ dpr: window.devicePixelRatio, sx: window.screenX, sy: window.screenY,'
    + ' iw: window.innerWidth, ih: window.innerHeight })');
  console.log(`   메인 getBounds : x=${b0.x} y=${b0.y} w=${b0.width} h=${b0.height}  (DIP)`);
  console.log(`   렌더러 window  : screenX=${view.sx} screenY=${view.sy}`
    + ` inner=${view.iw}x${view.ih} dpr=${view.dpr}`);
  // 창의 왼쪽 위는 하나뿐이다. 두 자가 같다면 같은 숫자가 나와야 한다.
  const dx = Math.abs(view.sx - b0.x);
  const dy = Math.abs(view.sy - b0.y);
  ok(dx <= 2 && dy <= 2,
    '렌더러 screenX 와 메인 DIP 가 같은 자다 (다르면 끄는 거리부터 어긋난다)',
    { 메인: [b0.x, b0.y], 렌더러: [view.sx, view.sy], 차이: [dx, dy] });

  console.log('\n[2] 마우스를 «안 움직이고» move 만 열 번 — 크기가 자라나');
  // 아직 한 번도 안 끌었으면 저장된 크기가 없다. 기준을 만들려고 살짝 끌어 둔다.
  await dragGrip(wc, 'se', [[4, 4]]);
  await sleep(300);
  const before = { ...store.settings.stocksSize };
  const sizeNow = () => ({ ...store.settings.stocksSize });
  await dragGrip(wc, 'se', Array.from({ length: 10 }, () => [0, 0]));
  const after = sizeNow();
  ok(before.width === after.width && before.height === after.height,
    '제자리 move 로는 안 커진다 (커지면 되먹임 고리다)', { 전: before, 후: after });

  console.log('\n[3] 같은 거리를 끌면 배율과 무관하게 같은 만큼 커진다');
  const start = sizeNow();
  await dragGrip(wc, 'se', [[20, 20], [40, 40], [60, 60], [80, 80], [100, 100]]);
  const end = sizeNow();
  const grew = { w: end.width - start.width, h: end.height - start.height };
  console.log(`   100 만큼 끌었더니  가로 +${grew.w}  세로 +${grew.h}`);
  ok(Math.abs(grew.w - 100) <= 3 && Math.abs(grew.h - 100) <= 3,
    '끈 만큼만 커진다 (배율이 곱해지면 여기서 150 이 나온다)', grew);

  console.log('\n[4] 끝난 뒤 창이 «요청한 크기»로 있는가 (되읽어도 안 부푼다)');
  const asked = sizeNow();
  const real = sw.getBounds();
  const again = await new Promise((r) => {
    ipcMain.emit('stocks:bounds');   // 핸들러는 invoke 라 직접 못 부른다 — 창에서 부른다
    wc.executeJavaScript('window.nunsseom.stocksBounds()').then(r);
  });
  console.log(`   요청 ${asked.width}x${asked.height} · getBounds ${real.width}x${real.height}`
    + ` · 다시 물으니 ${again.width}x${again.height}`);
  ok(again.width === asked.width && again.height === asked.height,
    '다시 물어도 요청한 값 그대로 (여기가 어긋나면 다음 드래그가 그만큼 부푼다)',
    { 요청: [asked.width, asked.height], 되읽음: [again.width, again.height] });

  console.log('\n[5] 열고 닫고 다시 열어도 안 자란다');
  const sizeA = sizeNow();
  ipcMain.emit('stocks:close');
  await sleep(1200);
  ipcMain.emit('stocks:open', {});
  for (let i = 0; i < 30 && !winBy('stocks.html'); i++) await sleep(200);
  await sleep(1200);
  const sw2 = winBy('stocks.html');
  const sizeB = sw2 ? sw2.getBounds() : null;
  ok(sizeB && Math.abs(sizeB.width - sizeA.width) <= 2 && Math.abs(sizeB.height - sizeA.height) <= 2,
    '다시 열어도 같은 크기', { 닫기전: sizeA, 다시연뒤: sizeB && { width: sizeB.width, height: sizeB.height } });

  console.log('\n[6] 잡았다 놓기를 여러 번 — 한 번도 안 움직였는데 자라나');
  const swNow = winBy('stocks.html');
  if (!swNow) { ok(false, '[6] 을 하려면 창이 열려 있어야 한다'); app.exit(1); return; }
  const wcNow = swNow.webContents;

  // 실제 크로미움이 150% 에서 주는 screenX 는 소수다 (601.3333740234375 실측).
  // 그 소수가 정수 창 크기로 접히는 왕복마다 오차가 남는지 본다.
  const c0 = { ...store.settings.stocksSize };
  const pts = await grabRelease(wcNow, 'se', 12, 0);
  const c1 = { ...store.settings.stocksSize };
  console.log(`   제자리로 12번 잡았다 놓음 · 쓴 좌표 ${JSON.stringify(pts.slice(0, 3))}…`);
  console.log(`   ${c0.width}x${c0.height}  →  ${c1.width}x${c1.height}`);
  ok(c0.width === c1.width && c0.height === c1.height,
    '제자리로 12번 잡았다 놔도 그대로', { 전: c0, 후: c1, 자란값: { w: c1.width - c0.width, h: c1.height - c0.height } });

  console.log('\n[7] 조금씩 흔들며 잡았다 놓기 — 왕복마다 반올림이 쌓이나');
  const d0 = { ...store.settings.stocksSize };
  await grabRelease(wcNow, 'se', 12, 1);   // 잡는 자리를 1씩 옮겨 가며
  const d1 = { ...store.settings.stocksSize };
  console.log(`   ${d0.width}x${d0.height}  →  ${d1.width}x${d1.height}`);
  // 잡는 «자리»가 달라도 안 움직였으니 크기는 그대로여야 한다
  ok(d0.width === d1.width && d0.height === d1.height,
    '잡는 자리를 옮겨도 제자리면 크기는 그대로', { 전: d0, 후: d1, 자란값: { w: d1.width - d0.width, h: d1.height - d0.height } });

  console.log('\n[8] 그립을 «톡» 눌렀다 떼면 — 처리기가 남아 붙어 있나');
  // 그립 처리기는 창 크기를 IPC 로 물어보고 «그 답이 온 뒤에» pointermove/pointerup 을 건다.
  // 그보다 먼저 손을 떼면, 떼는 것을 들을 처리기가 아직 없다 — 그래서 안 지워지고 남는다.
  // 남은 처리기는 단추를 안 눌러도 도는 데다, 자기가 잡아 둔 «옛 크기»를 기준으로 삼는다.
  // 그 뒤로는 창 위에서 마우스를 움직이기만 해도 크기가 튄다.
  const wc8 = winBy('stocks.html').webContents;
  const leak = await wc8.executeJavaScript(`(async () => {
    // 얼마나 붙어 있는지 세려고 addEventListener 를 잠깐 엿본다
    const add = window.addEventListener.bind(window);
    const rm = window.removeEventListener.bind(window);
    let live = 0;
    window.addEventListener = (t, f, o) => { if (t === 'pointermove') live++; return add(t, f, o); };
    window.removeEventListener = (t, f, o) => { if (t === 'pointermove') live--; return rm(t, f, o); };

    const g = document.querySelector('.grip.se');
    const mk = (type, sx, sy) => new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      screenX: sx, screenY: sy, clientX: 5, clientY: 5
    });
    // «톡» 다섯 번 — 누르자마자 뗀다 (IPC 답이 오기 전에)
    for (let i = 0; i < 5; i++) {
      g.dispatchEvent(mk('pointerdown', 400, 400));
      window.dispatchEvent(mk('pointerup', 400, 400));   // 곧바로
      await new Promise((r) => setTimeout(r, 300));      // IPC 답은 이제야 온다
    }
    const stuck = live;
    // 이제 «단추를 안 누른 채» 마우스만 움직여 본다
    const before = [window.innerWidth, window.innerHeight];
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, button: -1, buttons: 0,            // 아무 단추도 안 눌림
      screenX: 900, screenY: 900, clientX: 50, clientY: 50
    }));
    await new Promise((r) => setTimeout(r, 500));
    return { stuck, before, after: [window.innerWidth, window.innerHeight] };
  })()`);
  console.log(`   «톡» 5번 뒤 남아 있는 pointermove 처리기: ${leak.stuck}개`);
  console.log(`   단추를 안 누른 채 마우스만 움직였더니 ${leak.before.join('x')} → ${leak.after.join('x')}`);
  ok(leak.stuck === 0, '톡 눌렀다 떼면 처리기가 안 남는다', { 남은개수: leak.stuck });
  ok(leak.before[0] === leak.after[0] && leak.before[1] === leak.after[1],
    '단추를 안 누르고 움직이면 크기가 안 바뀐다', { 전: leak.before, 후: leak.after });

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

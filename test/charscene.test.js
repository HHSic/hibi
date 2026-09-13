const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 캐릭터 연출(고양이·웹스윙)이 «진짜 휴식 창»에서 캔버스로 그려지는가.
//
// 장면 파일은 renderer/anim/ 에서 따로 확인한다(프레임을 뽑아 눈으로 봄). 여기서는 붙임새를 본다:
//   · 휴식 창이 엔진과 장면을 실었나 (script 태그 순서, CSP)
//   · 연출이 옛 SVG 가 아니라 캔버스로 그려졌나 — 캔버스에 실제로 픽셀이 찼나
//   · 도착 시각(arrival)에 맞춰 휴식 내용이 떴나, 그 뒤에도 연출이 살아 움직이나
//   · 그리다 터지지 않았나 (엔진은 터지면 조용히 멈춘다 — 멈췄는지 픽셀 변화로 본다)
//   · 장면이 깨지면 옛 SVG 로 물러나나
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, screen } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('LAB 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과'); process.exit(1); }, 240_000).unref();

const OUT = process.env.HIBI_TEST_OUT || os.tmpdir();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charscene-'));
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
// 연출은 마우스가 있는 화면에서만 그린다
const cursorWin = () => {
  const id = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  return BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay')
    && w.webContents.getURL().includes(`display=${id}`)) || null;
};
async function until(fn, ms = 15000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// 캔버스에 찬 픽셀 — 칸을 성기게 훑어 불투명한 점의 수와 간단한 지문을 돌려준다
const PROBE = `(() => {
  const c = document.getElementById('curtain');
  const cv = c.querySelector('canvas.ent-canvas');
  const out = { cls: c.className, canvas: !!cv, svg: !!c.querySelector('svg'),
    stage: getComputedStyle(document.querySelector('.stage')).opacity,
    head: (document.getElementById('headline').textContent || '').trim() };
  if (cv) {
    const x = cv.getContext('2d');
    const d = x.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0, sig = 2166136261;
    for (let i = 3; i < d.length; i += 4 * 97) {
      if (d[i] > 8) lit++;
      sig = Math.imul(sig ^ d[i - 1] ^ d[i], 16777619) >>> 0;
    }
    out.lit = lit; out.sig = sig; out.size = [cv.width, cv.height];
  }
  return out;
})()`;

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;
  await wwc.executeJavaScript('window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })');
  store.setReminder('eye', { durationSec: 20 });

  for (const kind of ['cat', 'web']) {
    console.log(`\n[${kind}]`);
    store.setSettings({ overlayEnter: kind });
    await sleep(300);
    ipcMain.emit('widget:break-now', {}, 'eye');
    const ov = await until(async () => cursorWin(), 8000, 50);
    if (!ov) { ok(false, `${kind}: 휴식 창이 안 떴다`); continue; }
    const wc = ov.webContents;

    const loaded = await until(() => wc.executeJavaScript(
      `(() => { const a = window.nunsAnim; const s = window.nunsEnter && window.nunsEnter.sceneFor(${JSON.stringify(kind)});
        return a && s ? { scenes: Object.keys(a.scenes), arrival: s.arrival } : null; })()`), 8000);
    ok(!!loaded, `${kind}: 엔진과 장면이 실렸다`, loaded);
    if (!loaded) { ipcMain.emit('overlay:done'); await sleep(800); continue; }

    // 도착 중 — 캔버스가 붙고 픽셀이 찼나, 내용은 아직 숨었나
    const early = await until(async () => {
      const p = await wc.executeJavaScript(PROBE);
      return p && p.canvas && p.lit > 0 ? p : null;
    }, 6000, 50);
    ok(!!early, `${kind}: 캔버스로 그려졌다 (옛 SVG 아님)`, early && { cls: early.cls, svg: early.svg, lit: early.lit });
    ok(early && /ent-canvas-on/.test(early.cls), `${kind}: 커튼이 캔버스 모드다`, early && early.cls);

    // 내용이 도착 시각 즈음에 떴나 — 너무 늦으면 «9초 동안 아무 창도 안 뜬다»가 된다
    const t0 = Date.now();
    const shown = await until(async () => {
      const p = await wc.executeJavaScript(PROBE);
      return p && Number(p.stage) > 0.9 && p.head ? p : null;
    }, 8000, 50);
    const waited = Date.now() - t0;
    ok(!!shown, `${kind}: 휴식 내용이 떴다`, shown && shown.head);
    ok(loaded.arrival >= 1.2 && loaded.arrival <= 1.8, `${kind}: 도착은 1.2~1.8초 사이`, loaded.arrival);
    ok(waited < loaded.arrival * 1000 + 2500, `${kind}: 내용이 도착 뒤 곧 뜬다`, `${waited}ms`);

    // 도착 뒤에도 살아 움직이나 — 1초 간격 두 장의 지문이 달라야 한다
    await sleep(2500);
    const a = await wc.executeJavaScript(PROBE);
    await sleep(1100);
    const b = await wc.executeJavaScript(PROBE);
    ok(a.canvas && b.canvas && a.lit > 0 && b.lit > 0, `${kind}: 머무는 동안에도 그림이 있다`, { a: a.lit, b: b.lit });
    ok(a.sig !== b.sig, `${kind}: 머무는 동안에도 움직인다 (엔진이 멈추지 않았다)`, { a: a.sig, b: b.sig });

    // 휴식 창 전체를 찍어 남긴다 — 캔버스는 CSS 애니와 달리 capturePage 에 찍힌다
    fs.writeFileSync(path.join(OUT, `charscene-${kind}.png`), (await wc.capturePage()).toPNG());

    ipcMain.emit('overlay:done');
    await until(async () => !cursorWin(), 5000, 100);
    await sleep(600);
  }

  console.log('\n[장면이 깨지면 옛 SVG 로 물러난다]');
  store.setSettings({ overlayEnter: 'cat' });
  await sleep(300);
  ipcMain.emit('widget:break-now', {}, 'eye');
  const ov2 = await until(async () => cursorWin(), 8000, 50);
  if (ov2) {
    // 창이 뜨는 즉시 장면을 망가뜨려 본다 — 시작 신호보다 먼저 닿지 못할 수 있으니
    // play 를 직접 다시 불러 확인한다
    const r = await ov2.webContents.executeJavaScript(`(() => {
      const s = window.nunsAnim.scenes.cat;
      const keep = s.setup;
      s.setup = () => { throw new Error('일부러'); };
      const host = document.getElementById('curtain');
      return window.nunsEnter.play('cat', host, null, 20).then((ms) => {
        s.setup = keep;
        return { ms, cls: host.className, svg: !!host.querySelector('svg'), canvas: !!host.querySelector('canvas') };
      });
    })()`);
    ok(r.svg && !r.canvas && r.ms > 0, '장면 준비가 터지면 옛 SVG 고양이로 그린다', r);
    ipcMain.emit('overlay:done');
    await sleep(800);
  } else {
    ok(false, '물러나기 시험용 휴식 창이 안 떴다');
  }

  console.log('\n[설정 화면 미리보기]');
  // 고르기 전에 움직임을 볼 수 있어야 한다 — 이름만으로는 «웹스윙»이 뭔지 모른다
  store.setSettings({ overlayEnter: 'cat' });
  await sleep(300);
  ipcMain.emit('widget:open-settings', {}, 'app');
  const sw = await until(async () => winBy('settings.html'), 8000);
  if (!sw) {
    ok(false, '설정 창이 안 떴다');
  } else {
    const swc = sw.webContents;
    const prev = `(() => {
      const b = document.getElementById('enter-preview');
      const cv = b.querySelector('canvas');
      let lit = 0;
      if (cv) {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4 * 13) if (d[i] > 8) lit++;
      }
      return { shown: !b.hidden, scene: b.classList.contains('scene'), canvases: b.querySelectorAll('canvas').length, lit };
    })()`;
    const p1 = await until(async () => {
      const p = await swc.executeJavaScript(prev);
      return p && p.canvases === 1 && p.lit > 0 ? p : null;
    }, 8000);
    ok(!!p1 && p1.shown && p1.scene, '고양이를 고른 채 열면 미리보기가 움직인다', p1);

    const clickChip = (name) => swc.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('#enter-pick .mini')].find((x) => x.textContent === ${JSON.stringify(name)});
      if (b) b.click();
      return !!b;
    })()`);
    ok(await clickChip('웹스윙'), '«웹스윙»을 누를 수 있다');
    const p2 = await until(async () => {
      const p = await swc.executeJavaScript(prev);
      return p && p.canvases === 1 && p.lit > 0 ? p : null;
    }, 8000);
    // 캔버스가 쌓이면 안 보이는 쪽이 뒤에서 계속 그린다
    ok(!!p2 && p2.canvases === 1, '다른 연출로 바꾸면 미리보기도 바뀐다 (캔버스는 하나만)', p2);

    ok(await clickChip('기본'), '«기본»을 누를 수 있다');
    const p3 = await until(async () => {
      const p = await swc.executeJavaScript(prev);
      return p && !p.shown && p.canvases === 0 ? p : null;
    }, 5000);
    ok(!!p3, '장면이 없는 연출이면 미리보기를 걷는다', p3);
    sw.close();
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

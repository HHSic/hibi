const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 고양이 연출(누끼 딴 실제 영상)이 «진짜 휴식 창»에 붙는가. 끈 웹스윙은 어디서도 안 보이는가.
//
// 영상 자체(투명·이음새·자리 계산)는 test/catclip.test.js 가 보이지 않는 창에서 본다. 여기서는 붙임새를 본다:
//   · 휴식 창이 clip.js 를 실었나 (script 태그 순서, CSP 의 media-src)
//   · 커튼에 영상이 붙어 실제로 재생되나 — 시각이 흐르고, 프레임에 불투명한 점이 있나
//   · 도착 시각에 맞춰 휴식 내용이 떴나, 영상이 휴식 안내·단추를 가리지 않나
//   · 영상이 안 열리면 조용히 걷나
// 주의: 전체화면 휴식 창을 실제로 띄운다 — 사용자가 PC 를 쓰는 중이면 먼저 물어보고 돌린다.
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
    // fn 이 곧바로 던지는 경우도 잡는다 — 없어진 창에 executeJavaScript 를 부르면
    // 약속을 돌려주기 전에 던져서 .catch 가 못 받는다 (실제로 그렇게 죽었다)
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// 커튼의 영상 — 재생 상태, 불투명한 점의 수, 휴식 안내·단추와 겹치는지
const PROBE = `(() => {
  const c = document.getElementById('curtain');
  const v = c.querySelector('video.ent-clip');
  const out = { cls: c.className, videos: c.querySelectorAll('video').length, svg: !!c.querySelector('svg'),
    canvas: !!c.querySelector('canvas'),
    stage: getComputedStyle(document.querySelector('.stage')).opacity,
    head: (document.getElementById('headline').textContent || '').trim() };
  if (v) {
    out.ready = v.readyState; out.t = v.currentTime; out.paused = v.paused; out.in = v.classList.contains('in');
    out.opacity = getComputedStyle(v).opacity;
    if (v.readyState >= 2) {
      const k = document.createElement('canvas'); k.width = 96; k.height = 96;
      const x = k.getContext('2d'); x.drawImage(v, 0, 0, 96, 96);
      const d = x.getImageData(0, 0, 96, 96).data;
      let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) lit++;
      out.lit = lit;
    }
    const r = v.getBoundingClientRect();
    const hit = (el) => {
      if (!el) return false;
      const q = el.getBoundingClientRect();
      return q.width > 0 && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top;
    };
    out.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    out.coversHead = hit(document.getElementById('headline'));
    out.coversButtons = [...document.querySelectorAll('.actions button')].some(hit);
  }
  return out;
})()`;

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;
  // 사용자가 쓰고 있는 PC 에서 돌면, 전체화면 휴식 창이 뜬 사이에 사용자가 Enter·Esc·단추로
  // 닫을 수 있다 (탐침으로 확인: 창을 없앤 것은 화면이 보낸 overlay:skip·done 이었다).
  // 닫기를 막는 설정(breakNoEscape)은 쓰지 않는다 — 사용자가 자기 화면을 못 치우게 된다.
  await wwc.executeJavaScript('window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })');
  store.setReminder('eye', { durationSec: 20 });

  console.log('\n[고양이]');
  store.setSettings({ overlayEnter: 'cat' });
  await sleep(300);
  // 사용자가 휴식 창을 닫으면 다시 띄우지 않는다 — 한 번 «다시 띄우기»를 넣었다가, 닫을 때마다
  // 또 떠서 사용자를 괴롭혔다. 밖에서 닫히면 실패로만 알린다.
  ipcMain.emit('widget:break-now', {}, 'eye');
  const ov = await until(async () => cursorWin(), 8000, 50);
  if (!ov) {
    ok(false, '고양이: 휴식 창이 안 떴다');
  } else {
    const wc = ov.webContents;
    const loaded = await until(() => wc.executeJavaScript(
      `(() => { const c = window.nunsEnter && window.nunsEnter.clipFor && window.nunsEnter.clipFor('cat');
        return c ? { arrivalMs: c.arrivalMs, scenes: !!window.nunsAnim } : null; })()`), 8000);
    ok(!!loaded, '고양이: 휴식 창이 영상 모듈(clip.js)을 실었다', loaded);
    ok(!!loaded && !loaded.scenes, '고양이: 캔버스 엔진은 싣지 않는다 (코드로 그린 고양이는 은퇴)', loaded);

    if (loaded) {
      // 영상이 붙고 첫 프레임이 찼나
      const early = await until(async () => {
        const p = await wc.executeJavaScript(PROBE);
        return p && p.videos === 1 && p.ready >= 2 && p.lit > 0 ? p : null;
      }, 6000, 50);
      ok(!!early, '고양이: 커튼에 영상이 붙어 첫 프레임이 찼다', early);
      ok(!!early && early.cls === 'curtain on ent-clip-on' && !early.svg && !early.canvas, '고양이: 옛 SVG·캔버스가 아니라 영상이다', early && early.cls);

      // 내용이 도착 시각 즈음에 떴나
      const t0 = Date.now();
      const shown = await until(async () => {
        const p = await wc.executeJavaScript(PROBE);
        return p && Number(p.stage) > 0.9 && p.head ? p : null;
      }, 8000, 50);
      const waited = Date.now() - t0;
      ok(!!shown, '고양이: 휴식 내용이 떴다', shown && shown.head);
      ok(waited < loaded.arrivalMs + 2500, '고양이: 내용이 도착 뒤 곧 뜬다', `${waited}ms`);

      // 머무는 동안 재생되나 — 1초 사이에 시각이 흐르고 멈추지 않았어야 한다
      await sleep(2500);
      if (ov.isDestroyed()) {
        ok(false, '고양이: 머무는 동안 휴식 창이 밖에서 닫혔다 (다시 돌려 볼 것)');
      } else {
        const a = await wc.executeJavaScript(PROBE);
        await sleep(1100);
        if (ov.isDestroyed()) {
          ok(false, '고양이: 머무는 동안 휴식 창이 밖에서 닫혔다 (다시 돌려 볼 것)');
        } else {
          const b = await wc.executeJavaScript(PROBE);
          console.log('  ', JSON.stringify(b));
          ok(!b.paused && a.t !== b.t && b.lit > 0, '고양이: 머무는 동안 계속 재생된다', { a: a.t, b: b.t, paused: b.paused });
          ok(b.in && Number(b.opacity) > 0.95, '고양이: 다 나타났다', { in: b.in, opacity: b.opacity });
          ok(!b.coversHead && !b.coversButtons, '고양이: 휴식 안내·단추를 가리지 않는다', { rect: b.rect, head: b.coversHead, buttons: b.coversButtons });
          fs.writeFileSync(path.join(OUT, 'charscene-cat.png'), (await wc.capturePage()).toPNG());
        }
      }
    }
    if (!ov.isDestroyed()) {
      ipcMain.emit('overlay:done');
      await until(async () => !cursorWin(), 5000, 100);
    }
    await sleep(600);
  }

  console.log('\n[영상이 안 열리면 조용히 걷는다]');
  store.setSettings({ overlayEnter: 'cat' });
  await sleep(300);
  ipcMain.emit('widget:break-now', {}, 'eye');
  const ov2 = await until(async () => cursorWin(), 8000, 50);
  if (ov2) {
    const r = await until(() => ov2.webContents.executeJavaScript(`(async () => {
      const clip = window.nunsClip.CLIPS.cat;
      const real = clip.url;
      clip.url = '../assets/enter/__없는파일__.webm';
      const host = document.getElementById('curtain');
      try {
        const ms = await window.nunsEnter.play('cat', host, null, 20);
        for (let i = 0; i < 100 && host.querySelector('video'); i++) await new Promise((q) => setTimeout(q, 50));
        return { ms, cls: host.className, video: !!host.querySelector('video'), svg: !!host.querySelector('svg') };
      } finally { clip.url = real; }
    })()`), 8000);
    ok(!!r && !r.video && !r.svg && r.cls === 'curtain', '영상이 안 열리면 옛 그림 없이 커튼을 걷는다', r);
    if (!ov2.isDestroyed()) ipcMain.emit('overlay:done');
    await sleep(800);
  } else {
    ok(false, '물러나기 시험용 휴식 창이 안 떴다');
  }

  console.log('\n[끈 연출 — 웹스윙은 어디서도 안 보인다]');
  // 소스는 남기고 비활성화했다. 예전에 골라 저장해 둔 사람도 «기본»으로 떠야 한다.
  store.setSettings({ overlayEnter: 'web' });
  await sleep(300);
  ipcMain.emit('widget:break-now', {}, 'eye');
  const ov3 = await until(async () => cursorWin(), 8000, 50);
  if (!ov3) {
    ok(false, '끈 연출 시험용 휴식 창이 안 떴다');
  } else {
    const d = await until(() => ov3.webContents.executeJavaScript(`window.nunsseom.getBreakPayload().then((p) => {
      const c = document.getElementById('curtain');
      return { enter: p.enter, cls: c.className, canvas: !!c.querySelector('canvas'), svg: !!c.querySelector('svg'),
               video: !!c.querySelector('video'),
               swingLoaded: !!(window.nunsAnim && window.nunsAnim.scenes && window.nunsAnim.scenes.swing),
               head: (document.getElementById('headline').textContent || '').trim() };
    })`).then((x) => (x && x.head ? x : null)), 8000);
    ok(!!d && d.enter === 'fade', '저장된 «웹스윙»은 메인이 «기본»으로 돌린다', d && d.enter);
    ok(!!d && !/ent-web/.test(d.cls) && !d.canvas && !d.svg && !d.video, '휴식 창에 거미줄·곡예사가 안 그려진다', d && d.cls);
    ok(!!d && !d.swingLoaded, '휴식 창이 웹스윙 장면 파일을 싣지 않는다', d && d.swingLoaded);
    const rnd = await ov3.webContents.executeJavaScript(
      '({ list: window.nunsEnter.LIST.map((m) => m.id), eff: window.nunsEnter.effective("web") })');
    ok(!rnd.list.includes('web') && rnd.eff === 'fade', '고르는 목록에 없고, 끈 id 는 기본으로 풀린다', rnd);
    if (!ov3.isDestroyed()) ipcMain.emit('overlay:done');
    await until(async () => !cursorWin(), 5000, 100);
    await sleep(600);
  }
  // «그때그때»가 웹스윙을 뽑지 않는다 — 메인이 고르는 자리를 여러 번 불러 본다
  const breakwin = require(`${ROOT}/src/breakwin.js`);
  if (typeof breakwin.resolveEnter === 'function') {
    const picks = new Set();
    for (let i = 0; i < 200; i++) picks.add(breakwin.resolveEnter('random'));
    ok(!picks.has('web'), '«그때그때» 200번에 웹스윙이 한 번도 안 나온다', [...picks]);
  } else {
    // 내보내지 않았으면 소스를 읽어 확인한다 — 뽑는 목록에 'web' 이 없어야 한다
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'breakwin.js'), 'utf8');
    const pool = (src.match(/const pool = \[([^\]]*)\]/) || [])[1] || '';
    ok(pool && !/'web'/.test(pool), '«그때그때» 뽑는 목록에 웹스윙이 없다 (소스 확인)', pool);
  }

  console.log('\n[설정 화면 미리보기]');
  store.setSettings({ overlayEnter: 'web' });
  await sleep(300);
  ipcMain.emit('widget:open-settings', {}, 'app');
  const swWeb = await until(async () => winBy('settings.html'), 8000);
  if (swWeb) {
    const chipsWeb = await until(() => swWeb.webContents.executeJavaScript(`(() => {
      const all = [...document.querySelectorAll('#enter-pick .mini')];
      return all.length ? { names: all.map((b) => b.textContent),
        on: all.filter((b) => !b.classList.contains('ghost')).map((b) => b.textContent) } : null;
    })()`), 8000);
    ok(!!chipsWeb && !chipsWeb.names.includes('웹스윙'), '설정 목록에 «웹스윙»이 없다', chipsWeb && chipsWeb.names);
    ok(!!chipsWeb && chipsWeb.on.includes('기본'), '웹스윙을 골라 뒀던 사람에게는 «기본»이 켜져 보인다', chipsWeb && chipsWeb.on);
    swWeb.close();
    await until(async () => !winBy('settings.html'), 5000, 100);
  } else {
    ok(false, '설정 창이 안 떴다 (끈 연출 확인)');
  }
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
      const vids = b.querySelectorAll('video');
      const v = vids[0];
      return { shown: !b.hidden, scene: b.classList.contains('scene'), videos: vids.length, canvases: b.querySelectorAll('canvas').length,
        ready: v ? v.readyState : 0, paused: v ? v.paused : null };
    })()`;
    // 고르기 전에 움직임을 볼 수 있어야 한다 — 이름만으로는 무엇이 뜨는지 모른다
    const p1 = await until(async () => {
      const p = await swc.executeJavaScript(prev);
      return p && p.videos === 1 && p.ready >= 2 && !p.paused ? p : null;
    }, 8000);
    ok(!!p1 && p1.shown && p1.scene && p1.canvases === 0, '고양이를 고른 채 열면 미리보기에 영상이 돈다', p1);

    const clickChip = (name) => swc.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('#enter-pick .mini')].find((x) => x.textContent === ${JSON.stringify(name)});
      if (b) b.click();
      return !!b;
    })()`);
    ok(await clickChip('기본'), '«기본»을 누를 수 있다');
    const p3 = await until(async () => {
      const p = await swc.executeJavaScript(prev);
      return p && !p.shown && p.videos === 0 ? p : null;
    }, 5000);
    ok(!!p3, '보여 줄 것이 없는 연출이면 미리보기를 걷는다', p3);

    // 다시 고양이로 — 영상이 쌓이면 안 보이는 쪽이 디코더를 붙잡고 계속 돈다
    ok(await clickChip('앉은 고양이'), '«고양이»를 다시 누를 수 있다');
    await clickChip('앉은 고양이');
    const p2 = await until(async () => {
      const p = await swc.executeJavaScript(prev);
      return p && p.videos >= 1 && p.ready >= 2 ? p : null;
    }, 8000);
    ok(!!p2 && p2.videos === 1, '같은 연출을 두 번 눌러도 미리보기 영상은 하나만', p2);
    sw.close();
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

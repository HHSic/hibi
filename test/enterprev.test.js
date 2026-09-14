// 설정 화면 «등장 연출» 미리보기 — 고른 연출이 칸에 제대로 보이는가. 특히 «랜덤 고양이»는 고양이들을 5초마다 돌려 보여 준다.
//
// 진짜 settings.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/settings-bridge-stub.js 가 설정 값을 넘긴다.
//   · «랜덤 고양이»를 고르면 그 칸만 켜지고, 첫 고양이 영상이 보인다
//   · 5초마다 다음 고양이로 바뀐다
//   · 영상이 안 열리는 고양이는 건너뛴다 — 칸은 계속 보이고 돌리기도 이어진다
//   · 다 안 열리면 칸을 감추고, 더는 바꾸지 않는다
//   · 다른 연출로 바꾸면 돌리던 것이 멈춘다. 고양이 하나를 고르면 돌리지 않는다
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 180_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprev-'));
app.setPath('appData', tmp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const until = async (fn, ms = 8000, step = 100) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const reminders = require(path.join(ROOT, 'src', 'reminders.js'));
  // main.js 의 'settings:get' 과 같은 꼴 — 미리보기와 상관없는 칸은 비워 둔다
  const data = {
    settings: { ...store.settings, overlayEnter: 'cat-random', autoLaunch: false },
    reminders: store.reminders,
    custom: store.custom,
    calendars: [],
    enterCustom: [],
    calendarStatus: {},
    dndPresets: [],
    update: null,
    types: reminders.TYPES.map((t) => ({ id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind, headline: t.headline }))
  };
  ipcMain.on('stub:settings', (e) => { e.returnValue = data; });

  const win = new BrowserWindow({ show: false, width: 900, height: 900,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'settings-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 3) errs.push({ msg: String(msg).slice(0, 200), file: path.basename(String(src || '')), line });
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'), { query: { tab: 'app' } });
  const js = (c) => win.webContents.executeJavaScript(c);

  const state = () => js(`(() => {
    const box = document.getElementById('enter-preview');
    const v = box.querySelector('video');
    return { hidden: box.hidden, src: v ? decodeURIComponent(v.src.split('/').pop()) : null, ready: v ? v.readyState : -1,
      on: [...document.querySelectorAll('#enter-pick .mini:not(.ghost)')].map((b) => b.textContent),
      hint: document.getElementById('enter-hint').textContent };
  })()`);
  const shown = (want) => until(async () => {
    const s = await state();
    return s.src && s.ready >= 2 && (!want || s.src === want) ? s : null;
  });
  const click = (name) => js(`[...document.querySelectorAll('#enter-pick .mini')].find((b) => b.textContent === ${JSON.stringify(name)}).click()`);
  // 고양이 영상 주소를 없는 파일로 바꿔 «안 열리는 영상»을 만든다 — 끝에 되돌린다
  const breakClips = (ids) => js(`(() => { const C = window.nunsClip.CLIPS;
    for (const id of ${JSON.stringify(ids)}) { if (!C[id].__real) C[id].__real = C[id].url; C[id].url = '../assets/enter/__없는파일__' + id + '.webm'; } })()`);
  const fixClips = () => js(`(() => { const C = window.nunsClip.CLIPS;
    for (const id in C) if (C[id].__real) { C[id].url = C[id].__real; delete C[id].__real; } })()`);

  const ids = await until(() => js('window.nunsEnter && window.nunsEnter.catIds ? window.nunsEnter.catIds() : null'));
  const files = await js(`window.nunsEnter.catIds().map((id) => window.nunsEnter.clipFor(id).url.split('/').pop())`);
  ok(ids.length >= 3, '돌려 볼 고양이가 셋 이상 있다', ids);

  console.log('\n[랜덤 고양이 미리보기]');
  const s0 = await shown();
  ok(!!s0 && s0.on.length === 1 && s0.on[0] === '랜덤 고양이', '«랜덤 고양이» 칸만 켜져 있다', s0 && s0.on);
  ok(!!s0 && !s0.hidden && s0.src === files[0], '첫 고양이 영상이 보인다', { s0, want: files[0] });
  ok(!!s0 && /무작위/.test(s0.hint), '설명이 «랜덤 고양이» 것이다', s0 && s0.hint);
  const t1 = Date.now();
  const s1 = await until(async () => { const s = await state(); return s.src && s.src !== files[0] ? s : null; }, 8000, 100);
  const dt = Date.now() - t1;
  ok(!!s1 && s1.src === files[1] && !s1.hidden && dt > 3000, '5초쯤 뒤 다음 고양이로 바뀐다', { src: s1 && s1.src, want: files[1], ms: dt });

  console.log('\n[영상이 안 열리는 고양이]');
  // 첫째·셋째를 깨뜨리고 다시 고른다 — 첫째는 바로 건너뛰어 둘째가, 5초 뒤엔 셋째를 건너뛰어 넷째가 나와야 한다
  await breakClips([ids[0], ids[2]]);
  await click('랜덤 고양이');
  const s2 = await until(async () => { const s = await state(); return s.src === files[1] && s.ready >= 2 ? s : null; }, 4000, 50);
  ok(!!s2 && !s2.hidden, '안 열리는 첫 고양이는 바로 건너뛰고 둘째를 보여 준다', s2 || await state());
  const s3 = await until(async () => { const s = await state(); return s.src === files[3] && s.ready >= 2 ? s : null; }, 9000, 100);
  ok(!!s3 && !s3.hidden, '돌리기가 이어지고, 안 열리는 셋째도 건너뛴다', s3 || await state());

  console.log('\n[하나만 열리면]');
  // 둘째만 남기고 다 깨뜨린다 — 남은 한 마리를 5초마다 처음부터 다시 읽지 않아야 한다
  await breakClips(ids.filter((_id, k) => k !== 1));
  await click('랜덤 고양이');
  const s10 = await until(async () => { const s = await state(); return s.src === files[1] && s.ready >= 2 ? s : null; }, 5000, 50);
  ok(!!s10 && !s10.hidden, '남은 한 마리가 보인다', s10 || await state());
  // 첫 차례(5초)에는 아직 안 열어 본 고양이들을 한 바퀴 열어 보고(안 열림) 건너뛰어 남은 한 마리로 돌아온다.
  // 그 뒤 차례부터는 더 열어 볼 게 없으니 영상을 건드리지 않아야 한다 — 거기서부터 잰다
  await sleep(6000);
  const s10b = await until(async () => { const s = await state(); return s.src === files[1] && s.ready >= 2 ? s : null; }, 5000, 50);
  ok(!!s10b && !s10b.hidden, '안 열리는 고양이들을 한 바퀴 건너뛰고 남은 한 마리로 돌아온다', s10b || await state());
  await js(`(() => { const v = document.querySelector('#enter-preview video'); window.__reloads = 0;
    v.addEventListener('loadstart', () => { window.__reloads++; }); })()`);
  await sleep(11000);
  const s11 = await state();
  const reloads = await js('window.__reloads');
  ok(s11.src === files[1] && !s11.hidden && reloads === 0, '5초가 지나도 같은 영상을 다시 읽지 않는다', { src: s11.src, reloads });
  await fixClips();

  console.log('\n[다 안 열리면]');
  await breakClips(ids);
  await click('랜덤 고양이');
  const s4 = await until(async () => { const s = await state(); return s.hidden ? s : null; }, 5000, 50);
  ok(!!s4, '모든 고양이 영상이 안 열리면 칸을 감춘다', s4 || await state());
  const src4 = (await state()).src;
  await sleep(6000);
  const s5 = await state();
  ok(s5.hidden && s5.src === src4, '감춘 뒤로는 영상을 더 바꾸지 않는다 (돌리기 멈춤)', { before: src4, after: s5.src });
  await fixClips();

  console.log('\n[다른 연출로 바꾸면]');
  await click('랜덤 고양이');
  await shown(files[0]);
  await click('블라인드');
  await sleep(300);
  const s6 = await state();
  ok(s6.hidden && s6.src === null, '영상이 없는 연출은 미리보기를 감추고 영상을 뗀다', s6);
  await sleep(5500);
  const s7 = await state();
  ok(s7.src === null, '떼어 낸 뒤 돌리기가 되살아나지 않는다', s7);
  await click('러시안블루');
  const s8 = await shown('cat-rb.webm');
  await sleep(5500);
  const s9 = await state();
  ok(!!s8 && s9.src === 'cat-rb.webm' && !s9.hidden && s9.on[0] === '러시안블루', '고양이 하나를 고르면 그 영상만 — 돌리지 않는다', { s8, s9 });
  const saved = await js('window.__setApp || []');
  ok(saved.some((p) => p.overlayEnter === 'cat-random') && saved[saved.length - 1].overlayEnter === 'cat-rb',
    '고른 것이 저장 요청으로 나간다', saved);

  // 없는 파일을 일부러 연 «불러오기 실패» 말고, 미리보기 코드에서 난 오류가 없어야 한다
  const ours = errs.filter((e) => /^(settings|enter|clip)\.js$/.test(e.file));
  ok(ours.length === 0, '미리보기 쪽 콘솔 오류가 없다', ours.slice(0, 5));
  if (errs.length > ours.length) console.log('   (그 밖의 콘솔 오류 — 일부러 연 없는 파일·시험용 다리가 비워 둔 값)', errs.filter((e) => !ours.includes(e)).slice(0, 4));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const FIX = `${ROOT}/test/fixtures`;
// 내 파일 등장 연출 — 고르기 → 넣기 → 진짜 휴식에 뜨기 → 지우기.
const path = require('path'); const fs = require('fs'); const os = require('os');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, screen } = electron;
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myenter-'));
app.setPath('appData', tmp);
let hide = false;
app.on('browser-window-created', (_e, w) => { if (hide) { try { w.setOpacity(0); } catch { /* 무시 */ } } });
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

// 연출을 그리는 창 = 마우스가 있는 화면의 창
const cursorWin = () => {
  const id = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  return BrowserWindow.getAllWindows()
    .find((w) => w.webContents.getURL().includes('overlay') && w.webContents.getURL().includes(`display=${id}`)) || null;
};
const until = async (f, n = 80) => { for (let i = 0; i < n; i++) { const v = await f(); if (v) return v; await sleep(50); } return null; };

// 파일 고르기 창은 눌러줄 수 없으니, 고른 셈 치고 경로를 돌려준다
let PICK = null;
electron.dialog.showOpenDialog = async () => (PICK ? { canceled: false, filePaths: [PICK] } : { canceled: true, filePaths: [] });

app.whenReady().then(async () => {
  await sleep(2500);
  hide = true;
  await winBy('widget.html').webContents.executeJavaScript(`window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })`);
  store.setReminder('eye', { durationSec: 6 });   // 연출은 휴식의 절반 — 짧게 잡아 빨리 끝낸다

  PICK = path.join(FIX, 'cat-alpha.webm');
  ipcMain.emit('widget:open-settings', {}, 'app');
  const sw = await until(async () => winBy('settings.html'));
  const wc = sw.webContents;
  await sleep(2500);

  // ── 넣기 ──
  await wc.executeJavaScript(`[...document.querySelectorAll('#enter-pick .mini')].find(b=>b.textContent==='＋ 내 파일').click()`);
  await until(async () => store.enterCustom.length > 0);
  const item = store.enterCustom[0];
  ok(!!item, '파일이 목록에 들어갔다', item);
  ok(store.settings.overlayEnter === `my:${item.id}`, '넣자마자 그것이 골라진다', store.settings.overlayEnter);
  ok(item.ms === 900, '길이를 못 읽는 파일은 기본값으로 채운다', item.ms);
  const copied = path.join(app.getPath('userData'), 'enters', item.file);
  ok(fs.existsSync(copied), '원본이 아니라 앱 폴더로 복사됐다', item.file);

  const ui = await wc.executeJavaScript(`(() => ({
    chips: [...document.querySelectorAll('#enter-pick .mini')].map(b=>b.textContent),
    on: [...document.querySelectorAll('#enter-pick .mini:not(.ghost)')].map(b=>b.textContent),
    prevOn: !document.getElementById('enter-preview').hidden,
    prevTag: document.querySelector('#enter-preview > *')?.tagName || null,
    hint: document.getElementById('enter-hint').textContent
  }))()`);
  console.log('  ', JSON.stringify(ui));
  ok(ui.chips.includes('cat-alpha') && ui.chips.includes('지우기'), '목록에 이름과 지우기가 나온다', ui.chips);
  ok(ui.prevOn && ui.prevTag === 'VIDEO', '미리보기가 영상으로 뜬다', [ui.prevOn, ui.prevTag]);
  ok(/영상 · 0\.9초/.test(ui.hint), '설명이 길이를 알려준다', ui.hint);

  // ── 진짜 휴식에 뜨는가 ──
  ipcMain.emit('widget:break-now', {}, 'eye');
  const ov = await until(async () => cursorWin());
  if (!ov) { ok(false, '휴식 창이 안 뜸'); app.exit(1); return; }
  // 영상이 돌기 시작할 때까지 기다린다 — 고정 대기로는 파일 읽는 속도를 탄다.
  // 덮는 시간이 900ms 이므로 그 안에서만 본다.
  const probe = `(() => {
    const c = document.getElementById('curtain');
    const v = c.querySelector('video');
    return { cls: c.className, veil: !!c.querySelector('.ent-veil'), vid: !!v,
             playing: v ? v.currentTime > 0 : false, w: v ? v.videoWidth : 0,
             delay: getComputedStyle(document.documentElement).getPropertyValue('--enter-delay').trim(),
             stage: getComputedStyle(document.querySelector('.stage')).opacity };
  })()`;
  let mid = null;
  for (let i = 0; i < 8; i++) {
    mid = await ov.webContents.executeJavaScript(probe).catch(() => null);
    if (mid && mid.playing && mid.w > 0) break;
    await sleep(80);
  }
  if (!mid) mid = { cls: '?', veil: false, vid: false, playing: false, w: 0, delay: '?', stage: '?' };
  void 0;
  console.log('  덮는 중', JSON.stringify(mid));
  ok(/ent-media/.test(mid.cls) && mid.veil && mid.vid, '내 영상이 화면을 덮는다', mid.cls);
  ok(mid.playing && mid.w === 640, '영상이 실제로 돌아간다', [mid.playing, mid.w]);
  // 기대 지연은 enter.js 가 직접 계산하게 한다 (휴식 6초 → 절반의 덮는 시간).
  const want = await ov.webContents.executeJavaScript(
    `window.nunsseom.getBreakPayload().then(p =>
       window.nunsEnter.coverMs(p.enter, p.enterAsset, p.durationSec) + 'ms')`);
  ok(mid.delay === want, '휴식 내용은 덮는 시간만큼 기다린다', { 실제: mid.delay, 기대: want });
  ok(Number(mid.stage) < 0.5, '덮인 동안은 휴식 내용이 아직 안 보인다', mid.stage);

  // 이제 연출은 배경으로 남는다 — 걷히길 기다리지 않고, 내용이 그 위에 뜨는 것을 본다.
  let after = null;
  for (let i = 0; i < 60; i++) {
    if (ov.isDestroyed()) break;
    const st = await ov.webContents.executeJavaScript(`(() => ({
      on: document.getElementById('curtain').classList.contains('on'),
      kids: document.getElementById('curtain').children.length,
      head: (document.getElementById('headline').textContent || '').trim(),
      stage: getComputedStyle(document.querySelector('.stage')).opacity
    }))()`).catch(() => null);
    if (!st) break;
    after = st;
    if (Number(st.stage) > 0.9) break;
    await sleep(100);
  }
  if (!after) { ok(false, '휴식 창을 못 읽음'); after = { on: false, kids: 0, head: '', stage: '0' }; }
  ok(after.head.length > 0 && Number(after.stage) > 0.9, '휴식 내용이 그 위에 떴다', after.head);
  ok(after.on && after.kids > 0, '내 영상이 배경으로 남는다', { on: after.on, kids: after.kids });
  ipcMain.emit('overlay:done');
  await sleep(500);

  // ── 지우기 ──
  await wc.executeJavaScript(`[...document.querySelectorAll('#enter-pick .mini')].find(b=>b.textContent==='지우기').click()`);
  await until(async () => store.enterCustom.length === 0);
  ok(store.enterCustom.length === 0, '목록에서 빠졌다');
  ok(!fs.existsSync(copied), '파일도 지워졌다');
  ok(store.settings.overlayEnter === 'fade', '지운 것을 고른 채로 남지 않는다', store.settings.overlayEnter);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

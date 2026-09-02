const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 미리 찍어두기가 실제로 먹히는지 — 예정된 휴식이 «제 시각에» 뜨는가.
// 주기 20초짜리 알림을 걸어두고, 몇 ms 늦게 뜨는지 잰다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fast2-'));
app.setPath('appData', tmp);

let watching = false;
const born = [];   // 안 씀 (창은 미리 만들어진다)
const shown = [];
app.on('browser-window-created', (_e, win) => {
  if (!watching) return;
  const t = Date.now();
  try { win.setOpacity(0); } catch { /* 무시 */ }
  win.webContents.once('dom-ready', () => {
    if (!String(win.webContents.getURL()).includes('overlay')) return;
    win.once('show', () => shown.push({ made: t, at: Date.now() }));
  });
});

require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const reminders = require(`${ROOT}/src/reminders.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

const ticks = [];
app.whenReady().then(async () => {
  await sleep(2500);
  watching = true;

  const wwc = winBy('widget.html').webContents;
  const orig = wwc.send.bind(wwc);
  wwc.send = (ch, ...a) => { if (ch === 'tick') ticks.push({ t: Date.now(), d: a[0] }); return orig(ch, ...a); };

  ipcMain.emit('widget:open-settings', {});
  await sleep(3000);
  const swc = winBy('settings.html').webContents;
  // 자리 비움·방해 금지에 걸리지 않게
  await swc.executeJavaScript('window.nunsseom.setApp({ idlePauseSec: 36000, dndEnabled: false })');
  for (const t of reminders.TYPES) {
    await swc.executeJavaScript(`window.nunsseom.setReminder(${JSON.stringify(t.id)}, { enabled: false })`);
  }
  // 눈 휴식만 90초 주기로 — 미리 찍기(1분 전)가 반드시 한 번 돈다
  await swc.executeJavaScript(
    'window.nunsseom.setReminder(\'eye\', { enabled: true, intervalMin: 2, durationSec: 10 })');
  await sleep(1200);

  console.log('\n예정된 휴식이 «제 시각에» 뜨는지 — 두 번 잰다\n');
  const results = [];
  for (let round = 1; round <= 2; round++) {
    // 다음 휴식을 90초 뒤로 당겨 놓는다 (미리 찍기 창인 60초를 지나오게)
    shown.length = 0;
    await swc.executeJavaScript(
      'window.nunsseom.setReminder(\'eye\', { intervalMin: 2, durationSec: 10 })');
    await sleep(600);

    // 예정 시각을 알아낸다 (위젯이 남은 시간을 알려준다)
    const startAt = Date.now();
    let due = null;
    for (let i = 0; i < 900 && !shown.length; i++) {
      await sleep(200);
      const d = ticks[ticks.length - 1].d;
      if (!d.empty && d.remaining <= 0 && !due) due = Date.now();
      if (Date.now() - startAt > 160_000) break;
    }
    if (!shown.length) { console.log(`  ${round}회  (안 떴다)`); continue; }

    // 예정 시각 = 마지막으로 remaining>0 이던 tick의 다음 초
    // remaining은 초 단위로 반올림돼 온다 (±500ms). 여러 개의 가운데값을 쓰면 그 오차가 걷힌다.
    const guesses = ticks.filter((x) => x.t > startAt && !x.d.empty && x.d.remaining > 0)
      .map((x) => x.t + x.d.remaining * 1000).sort((a, b) => a - b);
    const target = guesses.length ? guesses[Math.floor(guesses.length / 2)] : null;
    const first = shown[0];
    const late = target ? (first.at - target) / 1000 : null;
    const early = (first.at - first.made) / 1000;   // 창이 미리 만들어져 있었나
    results.push({ late, draw: 0 });
    console.log(`  ${round}회  화면이 보이기까지 ${late === null ? '?' : `${late >= 0 ? '+' : ''}${late.toFixed(2)}초`}`
      + `  ·  창은 ${early.toFixed(1)}초 전에 이미 만들어져 있었다`);

    ipcMain.emit('overlay:done');
    await sleep(3000);
  }

  if (results.length) {
    const worstLate = Math.max(...results.map((r) => Math.abs(r.late)));
    // tick이 1초마다 도니 예정 시각과 최대 1초까지 어긋난다 (이건 예전부터 그랬다).
    // 여기서 보는 건 «그 위에 로딩이 더 얹히지 않는가»다.
    ok(worstLate < 1.2, '예정 시각에서 1.2초 안 (처음엔 로딩만 3.0초가 더 붙었다)', worstLate.toFixed(2));
  } else {
    ok(false, '한 번도 못 쟀다');
  }

  // 배경이 실제로 깔렸는지 (미리 찍은 것을 썼는지)
  shown.length = 0;
  ipcMain.emit('widget:break-now', {}, 'eye');
  let bg = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const ov = winBy('overlay');
    if (!ov) continue;
    bg = await ov.webContents.executeJavaScript(
      `(() => { const b = document.getElementById('backdrop');
        return { 그림: !!b.style.backgroundImage && b.style.backgroundImage !== 'none',
                 보임: b.classList.contains('ready'), 그려짐: !!document.querySelector('.card, .wrap, h1') }; })()`);
    if (bg && bg.그림) { console.log(`   배경이 ${((i + 1) * 0.5).toFixed(1)}초 만에 깔림`); break; }
  }
  ok(bg && bg.그림 && bg.보임, '배경 사진도 제대로 깔린다 (수동 휴식은 그 자리에서 찍는다)', bg);
  ipcMain.emit('overlay:done');
  await sleep(600);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

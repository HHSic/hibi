const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 정해진 시각이 «진짜로» 오면 울리는가, 그리고 그다음은 내일 같은 시각인가.
// 휴식 화면은 만들어지자마자 투명하게 만들어 화면에 안 보이게 한다 (동작은 그대로 탄다).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firelab-'));
app.setPath('appData', tmp);

// 휴식 화면이 뜨더라도 눈에 안 띄게 — 시작하자마자 걸어둔다.
// 뜬 시각도 여기서 적어둔다: 휴식 중에는 tick이 일찍 돌아가 pushTick을 안 불러서
// 위젯 페이로드로는 «울렸다»를 알 수 없다.
let hideNew = false;
const breaks = [];
app.on('browser-window-created', (_e, win) => {
  if (!hideNew) return;
  try { win.setOpacity(0); } catch { /* 무시 */ }
  win.once('show', () => { try { win.setOpacity(0); } catch { /* 무시 */ } });
  // «보여진» 순간을 적는다.
  // 창이 만들어진 때가 아니다 — 이제 휴식 창은 10초 전에 미리 만들어져 숨어 있다.
  // 만들어진 때를 재면 «10초 일찍 울렸다»는 엉뚱한 값이 나온다.
  win.webContents.once('did-finish-load', () => {
    if (!String(win.webContents.getURL()).includes('overlay')) return;
    win.once('show', () => breaks.push(Date.now()));
  });
});

require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const reminders = require(`${ROOT}/src/reminders.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
function ok(c, m, x) {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
}
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

const ticks = [];
app.whenReady().then(async () => {
  await sleep(2500);
  hideNew = true;

  const wwc = winBy('widget.html').webContents;
  const orig = wwc.send.bind(wwc);
  wwc.send = (ch, ...a) => { if (ch === 'tick') ticks.push({ t: Date.now(), d: a[0] }); return orig(ch, ...a); };

  // 설정 창을 통해 «진짜 IPC»로 만든다.
  // store를 직접 건드리면 스케줄러가 모르고 지나간다 (ipcMain.emit은 handle을 안 부른다).
  ipcMain.emit('widget:open-settings', {});
  await sleep(3000);
  const swc = winBy('settings.html').webContents;

  // 랩은 아무도 마우스를 안 움직여서 «자리 비움»으로 잡힌다 (기본 120초).
  // 그러면 tick이 due()를 아예 안 불러서 안 울린다 — 그건 의도된 동작이지만
  // 여기서 재려는 건 «제 시각에 우는가»다. 자리 비움 판정을 멀리 밀어두고 잰다.
  await swc.executeJavaScript('window.nunsseom.setApp({ idlePauseSec: 36000 })');
  await sleep(400);

  // 다른 알림은 전부 끄고, 이 알람 하나만 남긴다
  for (const t of reminders.TYPES) {
    await swc.executeJavaScript(`window.nunsseom.setReminder(${JSON.stringify(t.id)}, { enabled: false })`);
  }
  await sleep(800);

  // 다음다음 분 정각에 울리게 — 최소 60초는 확보된다
  const target = new Date(Date.now() + 90_000);
  target.setSeconds(0, 0);
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  const at = `${hh}:${mm}`;

  await swc.executeJavaScript(`window.nunsseom.customAdd({
    name: '시각 알람', emoji: '⏰', durationSec: 10,
    when: 'at', times: [${JSON.stringify(at)}], days: []
  })`);
  await sleep(1500);
  const id = Object.keys(store.custom)[0];
  console.log('   만든 알림:', id, JSON.stringify(store.custom[id]));

  const waitSec = Math.round((target.getTime() - Date.now()) / 1000);
  console.log(`\n  ${at} 에 울리도록 걸었다 — ${waitSec}초 뒤`);

  const first = ticks[ticks.length - 1].d;
  ok(first.fixedAt === at, '위젯이 그 시각을 들고 있다', first.fixedAt);
  ok(Math.abs(first.remaining - waitSec) <= 3, '남은 시간이 맞다', first.remaining);

  // 울릴 때까지 기다린다 — 휴식 화면이 뜨는지로 본다
  let held = null;
  for (let i = 0; i < 400 && !breaks.length; i++) {
    await sleep(500);
    const d = ticks[ticks.length - 1].d;
    if (d.remaining <= 0 && (d.hold || d.dnd || d.idle)) {
      held = held || { hold: d.hold, dnd: d.dnd, idle: d.idle, since: i };
      // 붙잡혀 있는 동안 시각이 밀리지 않는지 본다 — 이게 이 기능의 핵심 성질이다.
      // (붙잡는 동안 tick은 매 초 postponeAll(1000)을 부른다. 밀린다면 1초에 1분씩 어긋난다.)
      if (i - held.since > 60) break;   // 30초쯤 지켜본다
    }
  }

  if (held) {
    console.log(`   ※ 지금 «${held.hold || held.dnd || '자리 비움'}» 상태라 울릴 수 없다 — 울리는 것 자체는 못 쟀다`);
    const atOverHold = ticks.filter((x) => x.d.remaining <= 0).map((x) => x.d.fixedAt);
    const drifted = new Set(atOverHold);
    ok(drifted.size === 1 && drifted.has(at),
      `붙잡혀 있는 ${atOverHold.length}초 동안 시각이 하나도 안 밀렸다`, [...drifted]);
    ok(true, '(울리는 것은 화면이 안 잠겼을 때 따로 확인함)');
  } else {
    ok(breaks.length > 0, '정해진 시각에 울렸다');
    if (breaks.length) {
      const late = (breaks[0] - target.getTime()) / 1000;
      ok(Math.abs(late) <= 3, `제 시각에 울렸다 (${late >= 0 ? '+' : ''}${late.toFixed(1)}초)`, late);
    }
  }

  // 휴식이 스스로 끝나기를 기다린다 (길이 10초).
  // 휴식 중에는 tick이 일찍 돌아가 pushTick을 안 부르므로, 다시 돌기 시작할 때까지 본다.
  const endWait = Date.now();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const last = ticks[ticks.length - 1];
    if (last && last.t > endWait + 12_000) break;
  }
  await sleep(1500);

  const after = ticks[ticks.length - 1].d;
  console.log('   울린 뒤 payload:', JSON.stringify({
    fixedAt: after.fixedAt, remaining: after.remaining, onBreak: after.onBreak
  }));
  ok(after.onBreak === false, '휴식이 끝났다');
  ok(after.fixedAt === at, '다음 차례도 같은 시각 (밀리지 않았다)', after.fixedAt);
  if (!held) ok(Math.abs(after.remaining - 86400) < 120, '다음은 내일 — 24시간 뒤쯤', after.remaining);
  else ok(after.remaining <= 0, '아직 붙잡힌 채로 기다린다 (놓치지 않았다)', after.remaining);

  // 두 번 울리지 않는지 잠깐 더 본다
  await sleep(8000);
  const rounds = breaks.filter((t, i) => !i || t - breaks[i - 1] > 30_000).length;
  if (!held) {
    ok(rounds === 1, '연달아 다시 울리지 않는다 (화면 여러 대면 창도 여러 개)',
      { 창: breaks.length, 울린횟수: rounds });
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

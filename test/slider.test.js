const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 슬라이더를 직접 그리기로 했으니, 진짜 설정 창에서 정말 그려지는지 눈으로 재본다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slidelab-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
function ok(c, m, x) {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
}

app.whenReady().then(async () => {
  await sleep(2500);
  ipcMain.emit('widget:open-settings', {}, 'look');
  await sleep(2800);
  const sw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'));
  if (!sw) { console.error('설정 창 없음'); app.exit(1); return; }
  const wc = sw.webContents;

  // 모든 판을 펼쳐 놓고 잰다 — 안 보이는 칸은 0x0으로 나와서 잰 값이 거짓이 된다
  await wc.executeJavaScript(`(() => {
    for (const p of document.querySelectorAll('.pane,.tabpane,[data-pane]')) p.style.display = 'block';
    for (const w of document.querySelectorAll('.rem-wrap')) w.classList.add('open');
  })()`);
  await sleep(500);

  const r = await wc.executeJavaScript(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('input[type=range]')) {
      const cs = getComputedStyle(el);
      out.push({
        id: el.id,
        appearance: cs.appearance || cs.webkitAppearance,
        pct: el.style.getPropertyValue('--fill-pct').trim(),
        value: el.value, min: el.min, max: el.max,
        // 정말 «칠해지는지»를 본다 — 없는 변수를 하나 쓰면 background 선언 전체가
        // 무효가 되어 막대가 통째로 사라진다. 값만 보고 넘어가면 못 잡는다.
        track: getComputedStyle(el, '::-webkit-slider-runnable-track').backgroundImage,
        thumb: getComputedStyle(el, '::-webkit-slider-thumb').backgroundColor,
        h: Math.round(el.getBoundingClientRect().height),
        w: Math.round(el.getBoundingClientRect().width)
      });
    }
    return out;
  })()`);

  console.log(JSON.stringify(r, null, 0).replace(/\},\{/g, '},\n   {'));
  ok(r.length >= 7, `슬라이더 ${r.length}개 (알림마다 주기·길이가 더 있다)`, r.length);
  ok(r.every((x) => x.appearance === 'none'), '윈도우 기본 막대를 안 쓴다', r.map((x) => x.appearance));
  ok(r.every((x) => /%$/.test(x.pct)), '채운 길이가 전부 정해져 있다', r.map((x) => x.pct));
  ok(r.every((x) => /linear-gradient/.test(x.track || '')),
    '막대가 실제로 칠해진다 (사라지지 않았다)', [...new Set(r.map((x) => x.track))]);
  ok(r.every((x) => !/rgba\(0, 0, 0, 0\)|^none$/.test(x.thumb || 'none')),
    '손잡이도 칠해진다', [...new Set(r.map((x) => x.thumb))]);
  ok(r.every((x) => {
    const want = (Number(x.value) - Number(x.min)) / (Number(x.max) - Number(x.min)) * 100;
    return Math.abs(parseFloat(x.pct) - want) < 0.01;
  }), '채운 길이가 값과 맞는다');
  const shown = r.filter((x) => x.w > 0);
  ok(shown.length > 0, `보이는 슬라이더 ${shown.length}개를 실제로 쟀다`);
  ok(shown.every((x) => x.w > 40 && x.h >= 14), '납작해지거나 사라지지 않았다', shown.map((x) => `${x.w}x${x.h}`));

  // 끌면 따라오는지 — 값을 바꾸고 input을 일으킨다 (사용자가 끄는 것과 같은 경로)
  const drag = await wc.executeJavaScript(`(() => {
    const el = document.getElementById('scrim');
    el.value = el.max;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { pct: el.style.getPropertyValue('--fill-pct').trim(), out: document.getElementById('out-scrim').textContent };
  })()`);
  ok(drag.pct === '100%', '끝까지 끌면 100%까지 찬다', drag);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 최악의 경우 둘: 6줄짜리 달, 메일이 많아 패널이 300px 상한에 닿을 때.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calclip3-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

const MEASURE = `(() => {
  const card = document.getElementById('card').getBoundingClientRect();
  const cal = document.getElementById('cal'); cal.scrollTop = 0;
  const days = [...document.querySelectorAll('#cal-grid .cday')];
  const last = days[days.length - 1].getBoundingClientRect();
  const wd = document.querySelector('.calwd').getBoundingClientRect();
  const mp = document.getElementById('mailpanel').getBoundingClientRect();
  return { rows: Math.round(days.length / 7), clippedPx: Math.max(0, Math.round(last.bottom - card.bottom)),
           headerTopInside: wd.top >= card.top, mailH: Math.round(mp.height), winH: innerHeight,
           calClient: cal.clientHeight, calScroll: cal.scrollHeight };
})()`;

app.whenReady().then(async () => {
  await sleep(2500);
  const w = winBy('widget.html'); const wc = w.webContents; w.show();
  store.setSettings({ mailEnabled: true, mailShow: true });
  await sleep(1500);
  await wc.executeJavaScript(`document.getElementById('btn-mail').click()`); await sleep(800);
  await wc.executeJavaScript(`document.getElementById('btn-cal').click()`); await sleep(800);
  await wc.executeJavaScript(`document.getElementById('cal-month').click()`); await sleep(900);

  console.log('\n[6줄짜리 달]');
  let m = null;
  for (let i = 0; i < 14; i++) {
    m = await wc.executeJavaScript(MEASURE);
    if (m.rows === 6) break;
    await wc.executeJavaScript(`document.getElementById('cal-next').click()`); await sleep(700);
  }
  console.log('  ', JSON.stringify(m));
  ok(m.rows === 6, '6줄짜리 달을 찾았다', m.rows);
  ok(m.clippedPx === 0, '6줄이어도 아래가 안 잘린다', m.clippedPx);
  ok(m.headerTopInside, '요일 머리글이 위로 안 밀려난다');
  fs.writeFileSync(path.join(OUT, 'calclip-6rows.png'), (await wc.capturePage()).toPNG());

  console.log('\n[메일이 많을 때 — 패널 300px 상한]');
  // 진짜 메일은 없으니 목록에 줄을 잔뜩 넣고 «메일 패널 크기 다시 재기»를 부른다
  await wc.executeJavaScript(`(() => {
    const list = document.getElementById('mp-list');
    for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.textContent = '메일 ' + i; d.style.padding = '6px'; list.append(d); }
  })()`);
  await wc.executeJavaScript(`document.getElementById('mp-refresh').dispatchEvent(new Event('resize'))`);
  // resizeForMail 은 모듈 안 함수라 직접 못 부른다 — 패널 토글로 다시 재게 한다
  await wc.executeJavaScript(`document.getElementById('btn-mail').click()`); await sleep(500);
  await wc.executeJavaScript(`document.getElementById('btn-mail').click()`); await sleep(900);
  await wc.executeJavaScript(`(() => {
    const list = document.getElementById('mp-list');
    for (let i = 0; i < 40; i++) { const d = document.createElement('div'); d.textContent = '메일 ' + i; d.style.padding = '6px'; list.append(d); }
  })()`);
  await sleep(600);
  const full = await wc.executeJavaScript(MEASURE);
  console.log('  ', JSON.stringify(full));
  ok(full.mailH <= 300 + 1, '메일 패널이 300px 을 안 넘는다 (main 의 상한과 같다)', full.mailH);
  ok(full.calClient >= 96, '달력이 최소 몫(6rem)은 받는다', full.calClient);
  fs.writeFileSync(path.join(OUT, 'calclip-fullmail.png'), (await wc.capturePage()).toPNG());

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

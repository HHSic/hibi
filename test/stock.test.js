const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 주식 패널이 진짜 앱에서 뜨는지 — 켜고, 받고, 그려지는 것까지 본다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stocklab-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;

  console.log('\n[설정에서 켜기]');
  ipcMain.emit('widget:open-settings', {}, 'stock');
  await sleep(3000);
  const sw = winBy('settings.html');
  if (!sw) { console.error('설정 창 없음'); app.exit(1); return; }
  const swc = sw.webContents;

  const tabs = await swc.executeJavaScript(
    `[...document.querySelectorAll('.tabs button')].map((b) => b.textContent)`);
  ok(tabs.includes('주식'), '주식 탭이 생겼다', tabs);
  const paneShown = await swc.executeJavaScript(
    `getComputedStyle(document.getElementById('pane-stock')).display`);
  ok(paneShown !== 'none', '주식 판이 열렸다', paneShown);

  await swc.executeJavaScript(`window.nunsseom.setApp({ stocksEnabled: true })`);
  await sleep(500);
  await swc.executeJavaScript(`window.nunsseom.stocksRefresh()`);
  await sleep(6000);

  const listed = await swc.executeJavaScript(`(async () => {
    const fresh = await window.nunsseom.getSettings();
    return { rows: (fresh.stocks.rows || []).length, err: fresh.stocks.error };
  })()`);
  ok(listed.rows > 0, '관심 종목을 읽었다', listed);

  console.log('\n[위젯 패널]');
  // 패널을 편다
  await wwc.executeJavaScript(`document.getElementById('btn-stock').click()`);
  await sleep(1500);

  const st = await wwc.executeJavaScript(`(() => {
    const card = document.getElementById('card');
    const p = document.getElementById('stockpanel');
    const rows = [...p.querySelectorAll('.strow')];
    return {
      on: card.classList.contains('stockon'),
      shown: getComputedStyle(p).display,
      btnShown: getComputedStyle(document.getElementById('btn-stock')).display,
      rows: rows.length,
      note: document.getElementById('sp-note').textContent,
      first: rows.slice(0, 4).map((r) => r.textContent.trim().replace(/\\s+/g, ' ')),
      // 값이 잘려 보이지 않는지 줄마다 잰다
      clipped: rows.filter((r) => {
        const nm = r.querySelector('.nm');
        return nm && nm.scrollWidth > nm.clientWidth + 1;
      }).length,
      squashed: rows.filter((r) => r.getBoundingClientRect().height < 10).length,
      overflow: p.scrollWidth > p.clientWidth + 1
    };
  })()`);
  console.log('  ', JSON.stringify(st, null, 0).slice(0, 400));
  ok(st.on && st.shown === 'flex', '패널이 열렸다');
  ok(st.btnShown !== 'none', '머리글에 주식 단추가 보인다');
  ok(st.rows >= 20, '줄이 다 그려졌다', st.rows);
  ok(st.squashed === 0, '눌린 줄 없음');
  ok(!st.overflow, '가로로 삐져나오지 않음');

  // 매초 다시 그리지 않는지 (예전에 메일에서 호버 깜빡임이 났던 문제)
  const before = await wwc.executeJavaScript(
    `document.querySelectorAll('#stockpanel .strow')[0].dataset.mark = 'x'`);
  await sleep(3500);
  const kept = await wwc.executeJavaScript(
    `document.querySelectorAll('#stockpanel .strow')[0].dataset.mark === 'x'`);
  ok(kept, '값이 안 바뀌면 다시 그리지 않는다 (호버가 안 깜빡인다)', { before, kept });

  await sleep(2500);
  const listShown = await swc.executeJavaScript(
    `document.querySelectorAll('#stock-list .rem').length`);
  ok(listShown > 0, '설정의 관심 종목 목록도 채워졌다 (창을 열어둔 채로)', listShown);
  const ph = await swc.executeJavaScript(
    `document.getElementById('stocksRoot').placeholder`);
  ok(!/[	]/.test(ph), '경로 예시에 이상한 글자가 없다', ph);

  const scroll = await wwc.executeJavaScript(`(() => {
    const l = document.getElementById('sp-list');
    l.scrollTop = 9999;
    return { h: l.clientHeight, sh: l.scrollHeight, top: l.scrollTop,
             ov: getComputedStyle(l).overflowY };
  })()`);
  ok(scroll.sh > scroll.h && scroll.top > 0, '목록이 세로로 굴러간다 (다 못 보여도 아래를 볼 수 있다)', scroll);

  const img = await wwc.capturePage();
  fs.writeFileSync(path.join(OUT, 'stock-widget.png'), img.toPNG());
  const s2 = await swc.capturePage();
  fs.writeFileSync(path.join(OUT, 'stock-settings.png'), s2.toPNG());
  console.log('   찍음: stock-widget.png, stock-settings.png');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

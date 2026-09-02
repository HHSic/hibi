const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 주식 «창»이 제대로 열리고 종목을 넣고 뺄 수 있는지 — 진짜 앱에서 본다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwin-'));
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

/** 조건이 될 때까지 기다린다 (정해진 시간으로 재면 네트워크 느린 날 깨진다) */
async function until(fn, ms = 25000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(250);
  }
}

app.whenReady().then(async () => {
  await sleep(2500);
  const wwc = winBy('widget.html').webContents;

  console.log('\n[꺼져 있을 때]');
  const off = await wwc.executeJavaScript(
    `getComputedStyle(document.getElementById('btn-stock')).display`);
  ok(off === 'none', '위젯에 주식 단추가 안 보인다', off);
  ipcMain.emit('stocks:open');
  await sleep(1200);
  ok(!winBy('stocks.html'), '꺼져 있으면 창도 안 열린다');

  console.log('\n[일반 설정에서 켜기]');
  ipcMain.emit('widget:open-settings', {}, 'app');
  await sleep(2800);
  const swc = winBy('settings.html').webContents;
  const hasSw = await swc.executeJavaScript(`!!document.getElementById('stocksEnabled')`);
  ok(hasSw, '일반 탭에 «주식 시세» 스위치가 있다');
  await swc.executeJavaScript(`document.getElementById('stocksEnabled').click()`);
  await sleep(1500);
  ok(store.settings.stocksEnabled === true, '켜짐이 저장됐다', store.settings.stocksEnabled);
  const on = await wwc.executeJavaScript(
    `getComputedStyle(document.getElementById('btn-stock')).display`);
  ok(on !== 'none', '위젯에 단추가 나타났다', on);

  console.log('\n[창 열기]');
  await wwc.executeJavaScript(`document.getElementById('btn-stock').click()`);
  for (let i = 0; i < 40 && !winBy('stocks.html'); i++) await sleep(200);
  const sw2 = winBy('stocks.html');
  ok(!!sw2, '주식 창이 열렸다');
  if (!sw2) { app.exit(1); return; }
  const cwc = sw2.webContents;
  await until(async () => await cwc.executeJavaScript(`document.querySelectorAll('.row').length`));
  await sleep(600);

  const st = await cwc.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    return {
      rows: rows.length,
      note: document.getElementById('note').textContent,
      segOn: [...document.querySelectorAll('.seg.on')].map((b) => b.textContent),
      first: rows.slice(0, 3).map((r) => r.textContent.trim().replace(/\\s+/g, ' ')),
      clipped: rows.filter((r) => { const n = r.querySelector('.nm'); return n && n.scrollWidth > n.clientWidth + 1; }).length,
      overflow: document.querySelector('.card').scrollWidth > document.querySelector('.card').clientWidth + 1
    };
  })()`);
  console.log('  ', JSON.stringify(st).slice(0, 300));
  ok(st.rows === 4, '처음엔 지수 4줄만 (관심 종목은 비어 있다)', st.rows);
  ok(!st.overflow, '가로로 안 삐져나온다');

  console.log('\n[종목 넣고 빼기]');
  await cwc.executeJavaScript(`(() => {
    const q = document.getElementById('q');
    q.value = '005930';
    document.getElementById('btn-add').click();
  })()`);
  await until(() => store.stocksWatch.length === 1);
  await until(async () => !/찾는 중/.test(
    await cwc.executeJavaScript(`document.getElementById('say').textContent`)));
  const added = store.stocksWatch;
  ok(added.length === 1 && added[0].name === '삼성전자',
    '005930을 넣으니 한글 이름으로 들어갔다', added);
  const say1 = await cwc.executeJavaScript(`document.getElementById('say').textContent`);
  ok(/삼성전자/.test(say1), '넣었다고 알려준다', say1);

  await cwc.executeJavaScript(`(() => {
    const q = document.getElementById('q');
    q.value = '없는종목';
    document.getElementById('btn-add').click();
  })()`);
  await until(async () => /못 찾/.test(
    await cwc.executeJavaScript(`document.getElementById('say').textContent`)));
  const say2 = await cwc.executeJavaScript(`(() => ({
    say: document.getElementById('say').textContent,
    bad: document.getElementById('say').classList.contains('bad')
  }))()`);
  ok(say2.bad && /못 찾/.test(say2.say), '없는 종목은 안 넣고 알려준다', say2);
  ok(store.stocksWatch.length === 1, '목록에 안 들어갔다', store.stocksWatch.length);

  // 다시 켤 때 남아 있는지 (store의 blank/load 둘 다 고쳐야 하는 함정)
  const reread = JSON.parse(fs.readFileSync(
    path.join(tmp, 'Hibi (개발)', 'nunsseom.json'), 'utf8'));
  ok(Array.isArray(reread.stocksWatch) && reread.stocksWatch.length === 1,
    '파일에도 남았다 (다음에 켜도 안 사라진다)', reread.stocksWatch);

  const st2 = await until(async () => {
    const n = await cwc.executeJavaScript(`document.querySelectorAll('.row').length`);
    return n === 5 ? n : 0;
  }) || await cwc.executeJavaScript(`document.querySelectorAll('.row').length`);
  ok(st2 === 5, '지수 4 + 삼성전자 1 = 5줄', st2);

  const img = await cwc.capturePage();
  fs.writeFileSync(path.join(OUT, 'stockwin.png'), img.toPNG());
  console.log('   찍음: stockwin.png');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

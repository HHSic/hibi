const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 일본·홍콩 종목을 이름으로 찾아 넣고, 값·장 상태·지수가 맞는지
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asia-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

async function type(wc, text) {
  await wc.executeJavaScript(`(() => { const q = document.getElementById('q'); q.value=''; q.focus(); })()`);
  for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(40); }
  // 디바운스(220ms) + 네이버 왕복이 있다. 뜰 때까지 기다린다 — 정해진 시간으로 재면 흔들린다.
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const n = await wc.executeJavaScript(`document.querySelectorAll('#sug .it').length`);
    if (n) return n;
  }
  return 0;
}
async function key(wc, k) { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(60); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); }

app.whenReady().then(async () => {
  await sleep(2500);
  store.setSettings({ stocksEnabled: true });
  ipcMain.emit('stocks:open');
  for (let i = 0; i < 40 && !winBy('stocks.html'); i++) await sleep(200);
  const w = winBy('stocks.html');
  w.setSize(420, 560); w.show(); w.focus();
  await sleep(5000);
  const wc = w.webContents;

  console.log('\n[지수는 처음엔 넷만]');
  const i0 = await wc.executeJavaScript(
    `[...document.querySelectorAll('.row.idx .nm b')].map((x) => x.textContent)`);
  ok(i0.length === 4 && !i0.includes('닛케이225'), '일본 종목이 없으면 닛케이도 없다', i0);

  console.log('\n[«토요타»로 찾아 넣기]');
  await type(wc, '토요타');
  const sug = await wc.executeJavaScript(
    `[...document.querySelectorAll('#sug .it')].map((x) => x.textContent.trim())`);
  console.log('  ', JSON.stringify(sug.slice(0, 3)));
  const jp = await wc.executeJavaScript(`(() => {
    const its = [...document.querySelectorAll('#sug .it')];
    const i = its.findIndex((x) => /7203/.test(x.textContent));
    return i;
  })()`);
  ok(jp >= 0, '도쿄 상장(7203)이 후보에 있다', jp);
  for (let i = 0; i < jp; i++) await key(wc, 'Down');
  await key(wc, 'Return');
  await sleep(9000);
  const t = store.stocksWatch.find((x) => x.ticker === '7203');
  ok(t && t.market === 'JP', '일본 종목으로 들어갔다', t);

  console.log('\n[«텐센트»로 찾아 넣기]');
  await type(wc, '텐센트');
  await key(wc, 'Return');
  await sleep(9000);
  const hk = store.stocksWatch.find((x) => x.market === 'HK');
  ok(!!hk, '홍콩 종목이 들어갔다', hk);

  await sleep(4000);
  const rows = await wc.executeJavaScript(`(() => {
    const out = [];
    for (const r of document.querySelectorAll('.row')) {
      out.push({
        nm: r.querySelector('.nm b').textContent,
        px: r.querySelector('.px').textContent,
        pc: r.querySelector('.pc').textContent,
        idx: r.classList.contains('idx'),
        title: r.title
      });
    }
    return { out, overflow: document.querySelector('.card').scrollWidth > document.querySelector('.card').clientWidth + 1,
             clipped: [...document.querySelectorAll('.row .nm')].filter((n) => n.scrollWidth > n.clientWidth + 1).length };
  })()`);
  for (const r of rows.out) console.log(`   ${r.idx ? '※' : ' '} ${r.nm.padEnd(12)} ${r.px.padStart(11)} ${r.pc.padStart(8)}   ${r.title.split(' · ').slice(-1)[0]}`);
  const names = rows.out.map((r) => r.nm);
  ok(names.includes('닛케이225') && names.includes('항셍'), '일본·홍콩 지수가 따라 나왔다');
  ok(!rows.overflow, '가로로 안 삐져나온다');
  ok(rows.clipped === 0, '이름이 안 잘린다', rows.clipped);
  const jpRow = rows.out.find((r) => r.nm === '토요타자동차');
  ok(jpRow && !/\./.test(jpRow.px), '엔화는 소수점 없이', jpRow && jpRow.px);

  fs.writeFileSync(path.join(OUT, 'stock-asia.png'), (await wc.capturePage()).toPNG());
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

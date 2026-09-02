const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 슬라이더 막대가 «정말 칠해지는지»는 픽셀로만 알 수 있다.
// getComputedStyle은 ::-webkit-slider-runnable-track을 안 보여주고,
// --fill-pct 같은 값은 background 선언이 통째로 무효가 돼도 그대로 남는다.
// (실제로 그랬다: 없는 변수 하나 때문에 막대가 전부 사라졌는데 값 검사는 다 통과했다.)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlab-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
function ok(c, m, x) {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${x}`));
  if (!c) bad++;
}

app.whenReady().then(async () => {
  await sleep(2500);
  ipcMain.emit('widget:open-settings', {});
  await sleep(3000);
  const sw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'));
  if (!sw) { console.error('설정 창 없음'); app.exit(1); return; }
  const wc = sw.webContents;

  // «눈 휴식»을 펼치고 주기 슬라이더를 화면 안으로
  const rect = await wc.executeJavaScript(`(() => {
    const w = document.querySelector('.rem-wrap');
    w.classList.add('open');
    const el = w.querySelector('input[type=range]');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top),
             width: Math.round(r.width), height: Math.round(r.height),
             pct: el.style.getPropertyValue('--fill-pct') };
  })()`);
  await sleep(600);
  console.log('  슬라이더 자리:', JSON.stringify(rect));

  const img = await wc.capturePage(rect);
  const size = img.getSize();
  const buf = img.toBitmap();          // BGRA
  const stride = size.width * 4;
  const mid = Math.floor(size.height / 2);

  const px = (x, y) => {
    const i = y * stride + x * 4;
    return [buf[i + 2], buf[i + 1], buf[i]];    // R,G,B
  };
  const key = (c) => c.join(',');

  // 가운데 가로줄을 훑는다
  const runs = [];
  let prev = null;
  for (let x = 0; x < size.width; x++) {
    const k = key(px(x, mid));
    if (k !== prev) { runs.push({ k, n: 1, from: x }); prev = k; }
    else runs[runs.length - 1].n++;
  }
  const uniq = new Set(runs.map((r) => r.k));
  console.log(`  가운데 줄의 색 ${uniq.size}가지, 구간 ${runs.length}개`);
  console.log('  ', runs.filter((r) => r.n > 2).map((r) => `${r.k}×${r.n}`).join('  '));

  // 배경은 창 어딘가 빈 곳에서 가져온다 (슬라이더 바로 위)
  const bgImg = await wc.capturePage({ x: rect.x, y: rect.y - 6, width: 8, height: 3 });
  const bgBuf = bgImg.toBitmap();
  const bg = [bgBuf[2], bgBuf[1], bgBuf[0]];
  console.log('  둘레 배경색:', bg.join(','));

  const notBg = runs.filter((r) => r.k !== key(bg));
  ok(uniq.size >= 3, `막대가 보인다 — 배경 말고 다른 색이 ${uniq.size - 1}가지 이상`, uniq.size);
  ok(notBg.some((r) => r.n >= 10), '길게 이어진 막대 구간이 있다',
    notBg.map((r) => r.n).sort((a, b) => b - a).slice(0, 3).join(','));

  // 왼쪽(찬 쪽)과 오른쪽(빈 쪽)의 색이 달라야 한다
  const fill = parseFloat(rect.pct) || 0;
  const cut = Math.round(size.width * fill / 100);
  if (cut > 6 && cut < size.width - 20) {
    const left = key(px(Math.max(1, cut - 4), mid));
    const right = key(px(Math.min(size.width - 2, cut + 24), mid));
    ok(left !== right, `찬 쪽과 빈 쪽 색이 다르다 (${left} vs ${right})`);
  } else {
    // 채운 비율이 너무 작으면 값을 키워 다시 본다
    await wc.executeJavaScript(`(() => {
      const el = document.querySelector('.rem-wrap.open input[type=range]');
      el.value = Math.round((Number(el.min) + Number(el.max)) / 2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    const im2 = await wc.capturePage(rect);
    const b2 = im2.toBitmap();
    const p2 = (x) => [b2[mid * stride + x * 4 + 2], b2[mid * stride + x * 4 + 1], b2[mid * stride + x * 4]];
    const left = key(p2(Math.round(size.width * 0.25)));
    const right = key(p2(Math.round(size.width * 0.85)));
    ok(left !== right, `반쯤 채웠을 때 찬 쪽과 빈 쪽 색이 다르다 (${left} vs ${right})`);
  }

  fs.writeFileSync(path.join(OUT, 'slider-strip.png'),
    img.resize({ width: size.width * 3, quality: 'best' }).toPNG());
  console.log('  찍음: slider-strip.png');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

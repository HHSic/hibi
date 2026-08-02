'use strict';
/**
 * 앱 아이콘 생성기.
 *
 * 아이콘이 바이너리로만 있어 색 하나 바꾸려 해도 다시 만들 수가 없었다.
 * 여기서 SVG 한 벌로 build/icon.png · build/icon.ico · assets/tray.png를 모두 만든다.
 *
 *   npm run icon
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZE = 32;

// 그래파이트 — 무채색이라 어떤 바탕화면에도 붙고, 트레이에서도 조용하다
const PALETTE = { from: '#5c6473', to: '#1c1f26', hand: '#f5a623', face: '#eaf6f4' };

function iconSvg(size) {
  const { from, to, hand, face } = PALETTE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)"/>
  <g fill="none" stroke="${face}" stroke-width="13" stroke-linecap="round">
    <circle cx="128" cy="140" r="66" fill="${face}" stroke="none"/>
    <circle cx="84" cy="88" r="26" fill="${face}" stroke="none"/>
    <circle cx="172" cy="88" r="26" fill="${face}" stroke="none"/>
    <path d="M118 62h20" stroke-width="11"/>
    <path d="M74 200l-10 10M182 200l10 10" stroke-width="11"/>
  </g>
  <circle cx="128" cy="140" r="54" fill="url(#bg)"/>
  <g stroke="${hand}" stroke-width="12" stroke-linecap="round" fill="none">
    <path d="M128 106v34"/>
    <path d="M128 140l30 10"/>
  </g>
  <circle cx="128" cy="140" r="7" fill="${face}"/>
</svg>`;
}

/**
 * 256px로 한 번만 그리고 나머지 크기는 축소해서 만든다.
 * 크기마다 창을 띄우면 16px 같은 것은 Windows 최소 창 크기에 걸려 캡처가 어긋난다.
 */
async function renderBase() {
  const SIZE = 256;
  const tmp = path.join(app.getPath('temp'), `hibi-icon-${process.pid}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block}</style>${iconSvg(SIZE)}`);

  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000',
    useContentSize: true
  });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  win.destroy();
  try { fs.unlinkSync(tmp); } catch { /* 임시 파일은 남아도 무해 */ }
  return img;
}

/** PNG를 그대로 담는 ICO (Vista 이후 표준 방식) */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;   // 0 == 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;                        // 팔레트 없음
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);           // planes
    dir.writeUInt16LE(32, o + 6);          // bpp
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const base = await renderBase();
  // 배율이 100%가 아닌 PC에서는 캡처가 그만큼 크게 나온다 (150%면 256 → 384).
  // 항상 원하는 크기로 다시 맞춰야 ICO 항목이 실제 크기와 어긋나지 않는다.
  const entries = ICO_SIZES.map((size) => {
    const png = base.resize({ width: size, height: size, quality: 'best' }).toPNG();
    process.stdout.write(`  ${size}px (${png.length} bytes)\n`);
    return { size, png };
  });

  const png256 = entries.find((e) => e.size === 256).png;
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png256);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(entries));
  fs.writeFileSync(path.join(ROOT, 'assets', 'tray.png'),
    entries.find((e) => e.size === TRAY_SIZE).png);

  console.log('완료 — build/icon.png · build/icon.ico · assets/tray.png');
  app.quit();
});

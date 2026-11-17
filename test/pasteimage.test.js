'use strict';
// 지킴이 — 무엇보다 먼저 (불러오다 터지면 Electron 이 사용자 화면에 오류 창을 띄운다 — 띄우지 않고 실패로 끝낸다)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
require('electron').dialog.showErrorBox = () => {};
// 메일 쓰기 창에 그림 붙여넣기 — 진짜 renderer/compose.html 에 가짜 붙여넣기를 넣어 본다.
//
// 사용자: «메일 작성할때 이미지 붙이기 기능». 예전엔 본문 붙여넣기가 글자만 받아서
// 화면 캡처(Win+Shift+S)·브라우저 «이미지 복사»를 붙이면 아무것도 안 들어갔다.
//   [1] 화면 캡처 PNG → 커서 자리에 본문 그림 (data:), 이름 «붙여넣은 그림 YYYYMMDD-HHMMSS.png», 알림 한 줄.
//       화면 배율이 2면 width 를 반으로 (HiDPI 캡처가 화면에서 본 크기로), 1이면 width 없음
//   [2] 엑셀 칸 꼴 (글 + 표 HTML + 그림) → 표 (그림은 버린다 — 자세한 것은 tablepaste.test.js). 글만 붙이기도 예전 그대로
//   [3] 워드 그림 꼴 (글 없음, HTML <img file://>, PNG) → 그림. file:// 주소는 안 들어간다
//   [4] 브라우저 «이미지 복사» 꼴 (글은 주소, HTML <img https>, PNG) → 그림. 바깥 주소는 안 들어간다
//   [5] 5MB 넘는 그림 → JPEG 로 줄여 5MB 아래로, «커서 줄였습니다 (… → …)»
//   [6] WebP → PNG 로 바꿔 넣는다 (아웃룩이 WebP 를 못 그린다)
//   [7] SVG → 경로가 없으면 거절, 있으면 첨부 (본문에는 안 넣는다)
//   [8] 그림 아닌 파일 — 경로가 있으면 끌어다 놓기와 같은 길(composeDropFiles)로 첨부, 없으면 «파일 첨부»로 안내
//   [9] 5MB 넘는 움직이는 GIF — 펴서 줄이지 않는다 (경로 없으면 거절)
//  [10] 잇달아 두 번 붙여도 차례대로 커서 자리에 (섞이지 않는다), 한 번에 두 장도 차례대로. 파일 이름은 그대로, 막아서 넣는다
//  [11] 보낼 때 (bodyForSend) — data: 그림은 cid 로, max-width:100%;height:auto 를 원래 style 에 더해서, width 는 그대로,
//       WebP 인용 그림은 PNG 로, 같은 그림은 cid 하나
//  [12] 첨부 합계 경고에 본문 그림 바이트도 들어간다
//  [13] 임시 저장 — 본문이 2MB 를 넘으면 큰 그림부터 자리표로 바꿔 적는다 (잘린 HTML 을 적지 않는다).
//       그 초안을 이어 쓰면 «임시 저장에 본문 그림 n개는 담지 못했습니다 — 다시 붙여 주세요», 자리표가 남은 채로는 안 보낸다
//  [14] «그림» 단추 — 5MB 넘는 그림도 말 없이 빠지지 않고 줄여 넣는다. 메인이 뺀 것은 까닭과 함께 알린다
//
// 사용자 모니터에는 아무것도 안 뜬다 — 창은 숨김·화면 밖(offscreen)이다. 앱(main.js)은 안 띄운다.
// preload 대신 test/fixtures/compose-bridge-stub.js — 보내기·임시 저장·첨부 부탁은 기록만 하고 메인에 안 간다.
// 진짜 클립보드는 안 건드린다 — 붙여넣기는 화면 안에서 만든 DataTransfer 를 실은 ClipboardEvent 로만 흉내 낸다.
// 그림은 화면 안에서 캔버스로 만든다. 주소는 지어낸 것이다 (.invalid · x.example).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 400_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasteimage-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

// npm test 는 실패 줄만 보여 준다 — PASTE_TEST_LOG 에 파일을 주면 모든 줄을 거기에도 적는다
if (process.env.PASTE_TEST_LOG) {
  for (const k of ['log', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      try { fs.appendFileSync(process.env.PASTE_TEST_LOG, `${a.map(String).join(' ')}\n`); } catch { /* 적지 못해도 시험은 간다 */ }
      orig(...a);
    };
  }
}

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${s.length > 220 ? `${s.slice(0, 220)}…` : s}` : ''));
  if (!c) bad++;
};
const until = async (fn, ms = 8000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

const BASE = {
  accountId: 'a1', title: '새 메일', to: 'friend@example.invalid', subject: '시험', signature: '',
  accounts: [{ id: 'a1', name: '시험 계정', from: 'me@example.invalid' }], attachments: []
};
// 임시 저장 자리표 — renderer/pastepick.js·src/store.js 와 같은 표식 (data-pic-gone)
const GONE = '<span data-pic-gone="1">그림 자리</span>';

// 화면 안에서 쓰는 도구 — 그림 만들기, 붙여넣기 흉내, 커서 놓기, 본문 그림 읽기
const HELP = `(() => {
  const body = document.getElementById('body');
  const blobOf = (w, h, paint, type = 'image/png', q) => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h); c.toBlob((b) => res(b), type, q);
  });
  const solid = (color) => (x, w, h) => { x.fillStyle = color; x.fillRect(0, 0, w, h); };
  const noise = (x, w, h) => {
    const d = x.createImageData(w, h); const a = d.data;
    for (let i = 0; i < a.length; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(a.length, i + 65536)));
    for (let i = 3; i < a.length; i += 4) a[i] = 255;
    x.putImageData(d, 0, 0);
  };
  const dataUrlOf = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  window.__testPaths = {};
  window.__t = {
    async png(w, h, color = '#3a7', name = 'image.png') { return new File([await blobOf(w, h, solid(color))], name, { type: 'image/png' }); },
    async noisePng(w, h, name = 'image.png') { return new File([await blobOf(w, h, noise)], name, { type: 'image/png' }); },
    async noiseDataUrl(w, h) { return dataUrlOf(await blobOf(w, h, noise)); },
    async webp(w, h, name = 'image.webp') { return new File([await blobOf(w, h, solid('#c33'), 'image/webp', 0.9)], name, { type: 'image/webp' }); },
    async webpDataUrl(w, h) { return dataUrlOf(await blobOf(w, h, solid('#36c'), 'image/webp', 0.9)); },
    async noiseWebp(w, h, q = 0.5, name = 'image.webp') { return new File([await blobOf(w, h, noise, 'image/webp', q)], name, { type: 'image/webp' }); },
    async noiseWebpDataUrl(w, h, q = 0.5) { return dataUrlOf(await blobOf(w, h, noise, 'image/webp', q)); },
    withPath(f, p) { f.__testPath = p; window.__testPaths[f.name] = p; return f; },
    // 손으로 치는 것처럼 — 지금 커서 자리에 글을 넣는다 (input 도 온다)
    type(text) { document.execCommand('insertText', false, text); return true; },
    // 커서를 그 요소의 맨 끝에
    caretEnd(sel) {
      const el = body.querySelector(sel);
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    },
    async pngDataUrl(w, h, color) { return dataUrlOf(await blobOf(w, h, solid(color))); },
    file(text, name, type, testPath) {
      const f = new File([text], name, { type });
      if (testPath) { f.__testPath = testPath; window.__testPaths[name] = testPath; }
      return f;
    },
    // 5MB 넘는 움직이는 GIF — 두 장 + 큰 주석 덩어리 (꼴은 맞다)
    bigAnimGif() {
      const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0];
      const frame = [0x21, 0xF9, 4, 0, 0, 0, 0, 0, 0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
      const loop = [0x21, 0xFF, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0];
      const blocks = 22000;   // 255 바이트 덩어리 × 22000 ≈ 5.6MB
      const out = new Uint8Array(head.length + loop.length + 2 + blocks * 256 + 1 + frame.length * 2 + 1);
      let p = 0;
      const put = (arr) => { out.set(arr, p); p += arr.length; };
      put(head); put(loop); put([0x21, 0xFE]);
      for (let i = 0; i < blocks; i++) { out[p++] = 255; p += 255; }
      put([0]); put(frame); put(frame); put([0x3B]);
      return new File([out.subarray(0, p)], 'image.gif', { type: 'image/gif' });
    },
    paste({ text, html, files } = {}) {
      const dt = new DataTransfer();
      if (text !== undefined) dt.setData('text/plain', text);
      if (html !== undefined) dt.setData('text/html', html);
      for (const f of files || []) dt.items.add(f);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      body.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    // 본문을 html (없으면 «가나다라» 한 줄)로 두고 커서를 «가나|다라» 에 놓는다 — 시험이 지은 HTML 만 넣는다
    reset(html) {
      const doc = new DOMParser().parseFromString('<body>' + (html || '<div id="l1">가나다라</div>') + '</body>', 'text/html');
      body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
      const t = body.querySelector('#l1') ? body.querySelector('#l1').firstChild : null;
      body.focus();
      const r = document.createRange();
      if (t) r.setStart(t, 2); else r.setStart(body, 0);
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.getElementById('msg').textContent = '';
      document.getElementById('msg').className = 'msg';
      window.__calls.send.length = 0; window.__calls.draft.length = 0; window.__calls.drop.length = 0;
      attachments = []; renderFiles();
    },
    imgs() {
      // «그림 넣는 중…» 표식(작은 그림)은 본문 그림이 아니다
      return [...body.querySelectorAll('img:not([data-paste-slot])')].map((i) => {
        const src = i.getAttribute('src') || '';
        const m = src.match(/^data:([^;,]+);base64,(.*)$/);
        const b64 = m ? m[2] : '';
        const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
        return { type: m ? m[1] : src.slice(0, 30), bytes: m ? Math.floor(b64.length * 3 / 4) - pad : 0,
          name: i.getAttribute('data-name'), width: i.getAttribute('width'), nw: i.naturalWidth, nh: i.naturalHeight };
      });
    },
    // 본문을 차례대로 — 글은 글 그대로, 그림은 [IMG:가로]
    seq(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3) { if (c.nodeValue) out.push(c.nodeValue); }
          else if (c.nodeName === 'IMG') out.push(c.hasAttribute('data-paste-slot') ? '[SLOT]' : '[IMG:' + c.naturalWidth + ']');
          else walk(c);
        }
      };
      walk(sel ? body.querySelector(sel) : body);
      return out.join('');
    },
    msg() { const m = document.getElementById('msg'); return { kind: m.className, text: m.textContent }; },
    chips() { return [...document.querySelectorAll('#files .file:not(.over) b')].map((b) => b.textContent); }
  };
  return true;
})()`;

app.whenReady().then(async () => {
  let current = BASE;
  ipcMain.on('stub:compose', (e) => { e.returnValue = current; });

  const w = new BrowserWindow({
    show: false, width: 640, height: 760,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'compose-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false }
  });
  for (const k of ['show', 'showInactive', 'focus', 'moveTop', 'maximize']) w[k] = () => {};
  const wc = w.webContents;
  const js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(String(msg).slice(0, 200)); });

  async function open(payload) {
    current = payload;
    await w.loadFile(path.join(ROOT, 'renderer', 'compose.html'), { query: { radius: '20', theme: 'dark' } });
    const ready = await until(() => js(`document.getElementById('ttl').textContent === ${JSON.stringify(payload.title)}`));
    if (!ready) throw new Error('쓰기 창이 안 그려졌다');
    await js(HELP);
  }
  const imgsWhen = (n, ms = 10000) => until(async () => {
    const l = await js('__t.imgs()');
    return l.length >= n ? l : null;
  }, ms);
  const msgWhen = (re, ms = 10000) => until(async () => {
    const m = await js('__t.msg()');
    return re.test(m.text) ? m : null;
  }, ms);

  await open(BASE);
  ok(await js(`typeof window.nunsPaste === 'object' && !!document.querySelector('script[src="pastepick.js"]')`),
    'compose.html 이 pastepick.js 를 싣는다 (window.nunsPaste)');

  console.log('\n[1] 화면 캡처 PNG → 커서 자리에 본문 그림');
  // 화면 밖 창도 주 모니터의 배율을 따른다 — 배율 1 로 못박고 본다 (배율 2 는 아래에서 따로)
  console.log(`  (이 PC 의 화면 배율 ${await js('window.devicePixelRatio')})`);
  await js('Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 }); true');
  await js('__t.reset()');
  const prevented = await js('(async () => __t.paste({ text: "", files: [await __t.png(300, 200)] }))()');
  ok(prevented === true, '붙여넣기 기본 동작은 막는다 (크로미움이 제멋대로 넣지 않게)');
  let imgs = await imgsWhen(1);
  ok(imgs && imgs.length === 1 && imgs[0].type === 'image/png' && imgs[0].nw === 300, '그림 하나가 data:image/png 로 들어갔다', imgs);
  ok(imgs && /^붙여넣은 그림 \d{8}-\d{6}\.png$/.test(imgs[0].name), '  이름 «붙여넣은 그림 YYYYMMDD-HHMMSS.png»', imgs && imgs[0].name);
  ok(imgs && imgs[0].width === null, '  화면 배율 1 → width 없음', imgs && imgs[0].width);
  ok(await js('__t.seq()') === '가나[IMG:300]다라', '  커서 자리(가나|다라)에 들어갔다', await js('__t.seq()'));
  let m = await msgWhen(/그림 1개를 붙였습니다/);
  ok(m && m.kind === 'msg', '  알림 «그림 1개를 붙였습니다»', m || await js('__t.msg()'));

  await js('__t.reset(); Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 2 }); true');
  await js('(async () => __t.paste({ files: [await __t.png(400, 300)] }))()');
  imgs = await imgsWhen(1);
  ok(imgs && imgs[0].width === '200' && imgs[0].nw === 400, '화면 배율 2 → width = 400/2 = 200 (픽셀은 그대로 400)', imgs);
  await js('Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 }); true');

  console.log('\n[2] 엑셀 칸 꼴 → 표 (그림은 버린다)');
  // 예전엔 «글만»이었다 — 이제 표로 넣는다 (renderer/pastetable.js · tablepaste.test.js). 같이 실려 온 그림은 여전히 안 들어간다
  await js('__t.reset()');
  await js(`(async () => __t.paste({ text: '1월\\t2월', html: '<table><tr><td>1월</td><td>2월</td></tr></table>', files: [await __t.png(200, 40)] }))()`);
  await sleep(600);
  imgs = await js('__t.imgs()');
  let seq = await js('__t.seq()');
  const cells2 = await js('[...document.querySelectorAll("#body table td")].map((td) => td.textContent)');
  ok(imgs.length === 0 && seq === '가나1월2월다라' && JSON.stringify(cells2) === '["1월","2월"]', '글 + 표 + 그림 → 표 (그림은 안 들어간다)', { imgs: imgs.length, seq, cells2 });
  await js('__t.reset()');
  await js(`__t.paste({ text: '그냥 글' })`);
  ok(await js('__t.seq()') === '가나그냥 글다라', '글만 붙이기 — 예전 그대로', await js('__t.seq()'));
  await js('__t.reset()');
  await js(`__t.paste({ text: '<b>태그</b>', html: '<b>태그</b>' })`);
  ok(await js('__t.seq()') === '가나<b>태그</b>다라' && await js('!document.querySelector("#body b")'), '  HTML 은 안 넣는다 — 글자로만');

  console.log('\n[3] 워드 그림 꼴 → 그림');
  await js('__t.reset()');
  await js(`(async () => __t.paste({ text: '', html: '<html><body><!--StartFragment--><img width=200 height=100 src="file:///C:/x/clip_image002.png"><!--EndFragment--></body></html>', files: [await __t.png(200, 100)] }))()`);
  imgs = await imgsWhen(1);
  ok(imgs && imgs.length === 1 && imgs[0].type === 'image/png', '글 없음 + HTML <img> + PNG → 본문 그림', imgs);
  ok(!(await js('document.getElementById("body").innerHTML.includes("file:")')), '  file:// 주소는 본문에 없다');

  console.log('\n[4] 브라우저 «이미지 복사» 꼴 → 그림');
  await js('__t.reset()');
  await js(`(async () => __t.paste({ text: 'https://x.example/cat.png', html: '<img src="https://x.example/cat.png" alt="고양이">', files: [await __t.png(160, 120)] }))()`);
  imgs = await imgsWhen(1);
  ok(imgs && imgs.length === 1 && imgs[0].nw === 160, '글은 주소, HTML 은 <img> 뿐 + PNG → 본문 그림', imgs);
  ok(!(await js('document.getElementById("body").innerHTML.includes("x.example")')), '  바깥 주소는 본문에 없다 (글로도 그림으로도)');

  console.log('\n[5] 5MB 넘는 그림 → JPEG 로 줄인다');
  await js('__t.reset()');
  const bigSize = await js(`(async () => { const f = await __t.noisePng(2000, 2000); window.__big = f; return f.size; })()`);
  ok(bigSize > 5 * MB, `  만든 그림 ${(bigSize / MB).toFixed(1)}MB (5MB 넘음)`);
  await js('__t.paste({ files: [window.__big] })');
  imgs = await imgsWhen(1, 60000);
  ok(imgs && imgs[0].type === 'image/jpeg' && imgs[0].bytes <= 5 * MB, '본문 그림은 JPEG · 5MB 이하', imgs && { type: imgs[0].type, mb: (imgs[0].bytes / MB).toFixed(2) });
  ok(imgs && /\.jpg$/.test(imgs[0].name) && Math.max(imgs[0].nw, imgs[0].nh) >= 800, '  이름은 .jpg, 긴 변 800px 이상', imgs && imgs[0]);
  m = await msgWhen(/줄였습니다/, 5000);
  ok(m && /그림 1개를 붙였습니다 · 1개는 커서 줄였습니다 \(\d+\.\dMB → [\d.]+(MB|KB)\)/.test(m.text), '  알림 «… 1개는 커서 줄였습니다 (x MB → y MB)»', m || await js('__t.msg()'));

  console.log('\n[6] WebP → PNG');
  await js('__t.reset()');
  await js('(async () => __t.paste({ files: [await __t.webp(120, 90)] }))()');
  imgs = await imgsWhen(1);
  ok(imgs && imgs[0].type === 'image/png' && imgs[0].nw === 120 && /\.png$/.test(imgs[0].name), 'WebP 를 PNG 로 바꿔 넣었다', imgs);

  console.log('\n[7] SVG');
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  await js('__t.reset()');
  await js(`__t.paste({ files: [__t.file(${JSON.stringify(SVG)}, 'logo.svg', 'image/svg+xml')] })`);
  m = await msgWhen(/SVG/);
  ok(m && m.kind.includes('bad') && (await js('__t.imgs()')).length === 0 && (await js('__calls.drop.length')) === 0,
    '경로 없는 SVG → 본문에 안 넣고 거절 (알림)', m || await js('__t.msg()'));
  await js('__t.reset()');
  await js(`__t.paste({ files: [__t.file(${JSON.stringify(SVG)}, 'logo.svg', 'image/svg+xml', 'C:\\\\fake\\\\logo.svg')] })`);
  let chips = await until(async () => { const c = await js('__t.chips()'); return c.length ? c : null; });
  ok(chips && chips[0] === 'logo.svg' && (await js('__t.imgs()')).length === 0 && JSON.stringify(await js('__calls.drop')) === '[["logo.svg"]]',
    '경로 있는 SVG → 첨부 (끌어다 놓기와 같은 composeDropFiles)', { chips, drop: await js('__calls.drop') });

  console.log('\n[8] 그림 아닌 파일');
  await js('__t.reset()');
  await js(`__t.paste({ files: [__t.file('%PDF-1.4', 'report.pdf', 'application/pdf', 'C:\\\\fake\\\\report.pdf')] })`);
  chips = await until(async () => { const c = await js('__t.chips()'); return c.length ? c : null; });
  ok(chips && chips[0] === 'report.pdf' && JSON.stringify(await js('__calls.drop')) === '[["report.pdf"]]', '경로 있는 PDF → composeDropFiles 로 첨부 칩', { chips, drop: await js('__calls.drop') });
  m = await msgWhen(/첨부했습니다/, 3000);
  ok(!!m, '  알림 «파일 1개를 첨부했습니다»', m || await js('__t.msg()'));
  await js('__t.reset()');
  await js(`__t.paste({ files: [__t.file('메모', 'memo.txt', 'text/plain')] })`);
  m = await msgWhen(/파일 첨부/);
  ok(m && m.kind.includes('bad') && (await js('__calls.drop.length')) === 0 && (await js('__t.chips()')).length === 0,
    '경로 없는 파일 → 첨부 안 함, «파일 첨부»로 안내', m || await js('__t.msg()'));

  console.log('\n[9] 5MB 넘는 움직이는 GIF');
  await js('__t.reset()');
  const gifSize = await js('(() => { const f = __t.bigAnimGif(); window.__gif = f; return f.size; })()');
  await js('__t.paste({ files: [window.__gif] })');
  m = await msgWhen(/GIF/);
  ok(gifSize > 5 * MB && m && m.kind.includes('bad') && (await js('__t.imgs()')).length === 0,
    `${(gifSize / MB).toFixed(1)}MB 움직이는 GIF (경로 없음) → 펴서 줄이지 않고 거절`, m || await js('__t.msg()'));

  console.log('\n[10] 잇달아 붙이기 · 한 번에 여러 장 · 파일 이름');
  await js('__t.reset()');
  await js(`(async () => {
    const a = await __t.png(300, 200, '#c00');
    const b = await __t.png(120, 80, '#00c');
    __t.paste({ files: [a] });
    __t.paste({ files: [b] });
  })()`);
  imgs = await imgsWhen(2);
  seq = await js('__t.seq()');
  ok(imgs && seq === '가나[IMG:300][IMG:120]다라', '두 번 붙인 것이 붙인 차례대로 커서 자리에', seq);
  ok(imgs && imgs.length === 2 && imgs[0].name !== imgs[1].name && imgs.every((i) => /^붙여넣은 그림 /.test(i.name)), '  이름이 겹치지 않는다', imgs && imgs.map((i) => i.name));
  await js('__t.reset()');
  await js(`(async () => __t.paste({ files: [await __t.png(50, 50), await __t.png(70, 70, '#0a0', 'x.png')] }))()`);
  await imgsWhen(2);
  ok(await js('__t.seq()') === '가나[IMG:50][IMG:70]다라', '한 번에 두 장 → 차례대로', await js('__t.seq()'));
  await js('__t.reset()');
  await js(`(async () => {
    const f = await __t.png(64, 48, '#999', 'q"x <y>.png');
    f.__testPath = 'C:\\\\fake\\\\q.png'; window.__testPaths[f.name] = f.__testPath;
    const g = await __t.png(65, 48, '#999', "r&d 'v2'.png");
    g.__testPath = 'C:\\\\fake\\\\r.png'; window.__testPaths[g.name] = g.__testPath;
    __t.paste({ files: [f, g] });
  })()`);
  imgs = await imgsWhen(2);
  ok(imgs && imgs[0].name === 'q_x _y_.png' && imgs[1].name === "r&d 'v2'.png", '경로 있는 그림 파일은 제 이름 그대로 (경로·따옴표·꺾쇠는 _), 막아서 넣는다', imgs && imgs.map((i) => i.name));
  ok(await js('document.querySelectorAll("#body img").length === 2 && ![...document.querySelectorAll("#body img")].some((i) => i.attributes.length > 2)'),
    '  이름이 속성을 깨고 나오지 않는다 (src·data-name 뿐)');

  console.log('\n[11] 보낼 때 — cid · style · width · 형식');
  const webpUrl = await js('__t.webpDataUrl(40, 30)');
  const dupUrl = await js('__t.pngDataUrl(20, 20, "#123")');
  await js(`__t.reset('<div id="l1">본문</div><img src="${dupUrl}" style="border:1px solid red" width="10"><img src="${dupUrl}"><blockquote><img src="${webpUrl}"></blockquote>')`);
  const out = await js(`(async () => {
    const r = await bodyForSend();
    const doc = new DOMParser().parseFromString(r.html, 'text/html');
    return { inline: r.inline.map((a) => ({ cid: a.cid, type: a.contentType, ok64: /^[A-Za-z0-9+/]+={0,2}$/.test(a.base64) && a.base64.length % 4 === 0, filename: a.filename })),
      imgs: [...doc.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), style: i.getAttribute('style') || '', width: i.getAttribute('width') })),
      hasData: /data:/.test(r.html) };
  })()`);
  ok(out.inline.length === 2 && out.inline.every((a) => /^img\d+@hibi$/.test(a.cid) && a.ok64), 'cid 그림 둘 (같은 그림 둘은 cid 하나)', out.inline);
  ok(out.inline[1] && out.inline[1].type === 'image/png' && out.inline[0].type === 'image/png', '  WebP 인용 그림은 PNG 로 바꿔 보낸다', out.inline.map((a) => a.type));
  ok(!out.hasData && out.imgs.every((i) => /^cid:img\d+@hibi$/.test(i.src)), '  본문에는 cid: 만 (data: 없음)', out.imgs.map((i) => i.src));
  ok(out.imgs.every((i) => /max-width:\s*100%/.test(i.style) && /height:\s*auto/.test(i.style)), '  그림마다 max-width:100%;height:auto', out.imgs.map((i) => i.style));
  ok(/border:\s*1px solid red/.test(out.imgs[0].style) && out.imgs[0].width === '10', '  원래 style 은 살리고 width 도 그대로', out.imgs[0]);
  // 화면 그림 가운데 data-name 은 보낼 때 이름이 된다 (이 창에서 같은 초에 붙인 것이 앞에 있었으면 (n) 이 붙는다)
  await js('__t.reset()');
  await js('(async () => __t.paste({ files: [await __t.png(30, 30)] }))()');
  const shown = await imgsWhen(1);
  const sentNames = await js('(async () => (await bodyForSend()).inline.map((a) => a.filename))()');
  ok(sentNames.length === 1 && /^붙여넣은 그림 \d{8}-\d{6}( \(\d+\))?\.png$/.test(sentNames[0]) && shown && sentNames[0] === shown[0].name,
    '  붙여넣은 그림의 이름(data-name)이 첨부 이름으로', sentNames);

  console.log('\n[12] 첨부 합계 경고 — 본문 그림 바이트도 센다');
  await js('__t.reset(); attachMax = 300 * 1024; renderFiles();');
  ok(!(await js('!!document.querySelector("#files .over")')), '  아무것도 없으면 경고 없음');
  const pic = await js('__t.noiseDataUrl(400, 400)');
  await js(`__t.reset('<div id="l1">가나다라</div><img src="${pic}">'); document.getElementById('body').dispatchEvent(new Event('input', { bubbles: true }));`);
  const over = await until(() => js('(document.querySelector("#files .over") || {}).textContent || ""'), 3000);
  ok(over && /본문 그림/.test(over) && /300KB까지만/.test(over), '첨부는 없어도 본문 그림이 한도를 넘으면 경고 (본문 그림 포함)', over || await js('document.getElementById("files").textContent'));
  await js(`attachMax = 25 * 1024 * 1024; __t.reset(); document.getElementById('body').dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(600);
  ok(!(await js('!!document.querySelector("#files .over")')), '  그림을 지우면 경고도 사라진다');

  console.log('\n[13] 임시 저장 — 잘린 HTML 을 적지 않는다');
  const big = await js('__t.noiseDataUrl(900, 900)');
  const small = await js('__t.pngDataUrl(8, 8, "#0f0")');
  ok(big.length > 2 * MB, `  큰 그림 data: 주소 ${(big.length / MB).toFixed(1)}MB (임시 저장 한도 2MB 넘음)`);
  await js(`__t.reset('<div id="l1">가나다라</div><img src="${big}" data-name="big.png"><div>사이 글</div><img src="${small}" data-name="small.png"><div>끝 표시 END-MARK</div>'); saveDraftNow();`);
  const draft = await until(() => js('__calls.draft[__calls.draft.length - 1] || null'), 3000);
  const dh = draft ? String(draft.bodyHtml || '') : '';
  ok(draft && dh.length <= 2 * MB, '적은 본문은 2MB 이하', draft && dh.length);
  ok(/data-pic-gone="1"/.test(dh) && !dh.includes(big.slice(30, 2000)), '  큰 그림은 자리표로 바뀌었다');
  ok(dh.includes(small) && /END-MARK/.test(dh) && /사이 글/.test(dh), '  작은 그림·글은 그대로 (뒤쪽 글까지 잘리지 않았다)');
  const srcs = [...dh.matchAll(/src="data:[^;]+;base64,([^"]*)"/g)].map((x) => x[1]);
  ok(srcs.length === 1 && srcs.every((b) => b.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b)), '  남은 data: 그림은 온전하다 (중간에 잘린 base64 없음)', srcs.map((b) => b.length));

  await open({ ...BASE, title: '이어 쓰기', restored: true, restoredAt: Date.now(), restoredPicsGone: 2,
    bodyHtml: `<div>쓰던 글</div>${GONE}<div>둘째</div>${GONE}` });
  m = await msgWhen(/임시 저장에 본문 그림 2개는 담지 못했습니다 — 다시 붙여 주세요/);
  ok(!!m, '이어 쓰기 알림 «임시 저장에 본문 그림 2개는 담지 못했습니다 — 다시 붙여 주세요»', m || await js('__t.msg()'));
  await js(`document.getElementById('send').click()`);
  m = await msgWhen(/그림 자리/, 3000);
  ok(m && m.kind.includes('bad') && (await js('__calls.send.length')) === 0, '  자리표가 남아 있으면 보내지 않고 알린다', m || await js('__t.msg()'));
  await js(`document.querySelectorAll('[data-pic-gone]').forEach((e) => e.remove()); document.getElementById('send').click()`);
  const sentOne = await until(() => js('__calls.send.length === 1'), 3000);
  ok(!!sentOne, '  자리표를 지우면 보낸다');

  console.log('\n[14] «그림» 단추 — 5MB 넘는 것도 줄여 넣는다');
  await open(BASE);
  await js('__t.reset()');
  const pickUrl = await js('__t.noiseDataUrl(2000, 2000)');
  const webp2 = await js('__t.webpDataUrl(64, 64)');
  await js(`window.__pickResult = { images: [
    { filename: 'big.png', contentType: 'image/png', size: ${Math.floor(pickUrl.length * 3 / 4)}, dataUrl: ${JSON.stringify(pickUrl)} },
    { filename: '로고.webp', contentType: 'image/webp', size: 100, dataUrl: ${JSON.stringify(webp2)} }
  ], skipped: [{ name: 'huge.png', why: '30MB가 넘는 그림은 넣을 수 없습니다' }] }; document.getElementById('btn-image').click();`);
  imgs = await imgsWhen(2, 60000);
  ok(imgs && imgs[0].type === 'image/jpeg' && imgs[0].bytes <= 5 * MB && imgs[0].name === 'big.jpg', '5MB 넘는 그림 → JPEG 로 줄여 넣었다 (big.jpg)', imgs && imgs.map((i) => ({ t: i.type, mb: (i.bytes / MB).toFixed(2), n: i.name })));
  ok(imgs && imgs[1].type === 'image/png' && imgs[1].name === '로고.png', '  WebP 는 PNG 로 (로고.png)', imgs && imgs[1]);
  ok(await js('__t.seq()') === `가나[IMG:${imgs ? imgs[0].nw : 0}][IMG:64]다라`, '  커서 자리에 차례대로', await js('__t.seq()'));
  m = await msgWhen(/huge\.png/, 3000);
  ok(m && /줄였습니다/.test(m.text) && /30MB/.test(m.text), '  알림 — 줄인 것과 메인이 뺀 것(huge.png)을 같이', m || await js('__t.msg()'));

  // ── 검토에서 나온 것 ── (큰 잡음 그림은 줄이는 데 1~2초 걸린다 — «붙이는 중»을 만드는 데 쓴다)
  const pending = () => js('[...document.querySelectorAll("#body [data-paste-slot]")].length');
  const settled = (ms = 30000) => until(async () => (await js('typeof pasteJobs === "object" && (pasteJobs.size === 0 || pasteJobs.length === 0)')) && !(await pending()), ms);
  const makeBig = () => js('(async () => { window.__big = await __t.noisePng(2000, 2000); return window.__big.size; })()');

  console.log('\n[15] 붙이는 중에 보내기·닫기');
  await open(BASE);
  await js('__t.reset()');
  await makeBig();
  // 막는 말은 누른 그 자리에서 나온다 (그림이 들어오면 알림이 바뀌므로 바로 읽는다)
  m = await js('__t.paste({ files: [window.__big] }); document.getElementById("send").click(); __t.msg()');
  await sleep(400);
  ok((await js('__calls.send.length')) === 0 && /붙이는 중/.test(m.text) && m.kind.includes('bad'), '그림이 들어가기 전에 보내기 → 안 보내고 «붙이는 중»이라 알린다', { sent: await js('__calls.send.length'), m });
  await imgsWhen(1, 30000);
  await settled();
  await js('document.getElementById("send").click(); true');
  const sent15 = await until(() => js('__calls.send.length === 1 ? __calls.send[0] : null'), 5000);
  ok(sent15 && sent15.inline && sent15.inline.length === 1 && /cid:img1@hibi/.test(sent15.html), '  다 들어간 뒤 보내기 → 그림이 실려 나간다', sent15 && { inline: sent15.inline.length });

  await open(BASE);
  await js('__t.reset(); context.bodyHtml = document.getElementById("body").innerHTML.trim(); true');
  ok((await js('dirty()')) === false, '  (붙이기 전에는 «쓰던 글» 없음)');
  await makeBig();
  await js('__t.paste({ files: [window.__big] }); true');
  ok((await js('dirty()')) === true, '붙이는 중이면 «쓰던 글»이 있다 (다른 «쓰기»가 와도 묻는다)');
  m = await js('tryClose(); __t.msg()');
  await sleep(300);
  ok((await js('__calls.close')) === 0 && /붙이는 중/.test(m.text), '붙이는 중에 닫기 → 닫지 않고 «붙이는 중»이라 알린다', { close: await js('__calls.close'), m });
  // 검증에서 더함 — 붙일 때 띄운 «그림을 붙이는 중…»도 /붙이는 중/ 에 맞으므로, 막는 말 자체를 본다
  ok(m.kind.includes('bad') && m.text === '그림을 붙이는 중입니다 — 다 들어간 뒤 닫아 주세요', '  (검증) 막는 말 «다 들어간 뒤 닫아 주세요» (묻지 않고 막는다)', m);
  await imgsWhen(1, 30000);
  await settled();
  await js('tryClose(); true');
  await sleep(300);
  ok((await js('__calls.close')) === 0, '  다 들어간 뒤 닫기 → 그림이 있으니 묻는다 (시험 답은 «취소»)');

  console.log('\n[16] 기다리는 동안 다른 자리에 붙이기·치기 — 제 자리에 들어간다');
  await js('__t.reset()');
  await makeBig();
  await js(`(async () => {
    const small = await __t.png(55, 40, '#09c');
    __t.paste({ files: [window.__big] });
    __t.caretEnd('#l1');
    __t.paste({ files: [small] });
  })()`);
  await imgsWhen(2, 30000);
  await settled();
  seq = await js('__t.seq()');
  ok(/^가나\[IMG:\d{3,4}\]다라\[IMG:55\]$/.test(seq), '큰 그림을 가나|다라 에, 기다리는 동안 줄 끝에 작은 그림 → 가나[큰]다라[작은]', seq);
  await js('__t.reset()');
  await js('__t.paste({ files: [window.__big] }); __t.caretEnd("#l1"); __t.paste({ text: "끝" }); true');
  await imgsWhen(1, 30000);
  await settled();
  seq = await js('__t.seq()');
  ok(/^가나\[IMG:\d{3,4}\]다라끝$/.test(seq), '  줄 끝에 글 «끝» → 가나[큰]다라끝', seq);
  await js('__t.reset()');
  await js('__t.paste({ files: [window.__big] }); __t.type("abc"); __t.paste({ text: "T" }); true');
  await imgsWhen(1, 30000);
  await settled();
  seq = await js('__t.seq()');
  ok(/^가나\[IMG:\d{3,4}\]abcT다라$/.test(seq), '  붙인 자리에서 abc 치고 글 T 붙이기 → 가나[큰]abcT다라', seq);

  console.log('\n[17] 그림이 들어와도 커서·포커스를 빼앗지 않는다');
  await js(`__t.reset('<div id="l1">가나다라</div><div id="l2">마바사</div>')`);
  await js('__t.paste({ files: [window.__big] }); __t.caretEnd("#l2"); __t.type("XYZ"); true');
  await imgsWhen(1, 30000);
  await settled();
  await js('__t.type("Q")');
  const l17 = await js('({ l1: __t.seq("#l1"), l2: __t.seq("#l2") })');
  ok(l17.l2 === '마바사XYZQ' && /^가나\[IMG:\d{3,4}\]다라$/.test(l17.l1), '다른 줄에서 치던 자리 그대로 — 그림이 들어온 뒤 친 Q 도 그 줄에', l17);
  await js('__t.reset()');
  await js('__t.paste({ files: [window.__big] }); document.getElementById("subject").focus(); __t.type("abc"); true');
  await imgsWhen(1, 30000);
  await settled();
  const act = await js('document.activeElement && document.activeElement.id');
  await js('__t.type("Q")');
  const subj = await js('document.getElementById("subject").value');
  ok(act === 'subject' && /abcQ$/.test(subj) && (await js('__t.imgs().length')) === 1, '  제목 칸에서 치는 중이면 포커스는 제목 칸에 남는다', { act, subj });

  console.log('\n[18] 비트맵 + 같은 그림의 디스크 파일 → 한 장');
  await js('__t.reset()');
  await js(`(async () => __t.paste({ text: '', html: '<img src="https://x.example/cat.png">',
    files: [await __t.png(200, 200), __t.withPath(await __t.png(200, 200, '#3a7', 'cat.png'), 'C:\\\\fake\\\\cat.png')] }))()`);
  m = await msgWhen(/붙였습니다/);
  await settled();
  imgs = await js('__t.imgs()');
  ok(imgs.length === 1 && imgs[0].name === 'cat.png' && /그림 1개를/.test(m ? m.text : ''), '비트맵은 버리고 파일(cat.png)만', { imgs: imgs.map((i) => i.name), m });

  console.log('\n[19] 이어 쓰기 자리표 — 그 자리에 다시 붙이면 그림으로 바뀐다');
  const HOLE = require(path.join(ROOT, 'renderer', 'pastepick.js')).PLACEHOLDER;
  const restored = { ...BASE, title: '이어 쓰기', restored: true, restoredAt: Date.now(), restoredPicsGone: 1,
    bodyHtml: `<div id="l1">쓰던 글</div><div id="l2">${HOLE}</div><div>끝</div>` };
  await open(restored);
  ok(await js('document.querySelector("[data-pic-gone]").getAttribute("contenteditable") === "false"'), '자리표는 편집 안 되는 덩어리 (contenteditable=false)');
  for (const where of ['After', 'Before']) {
    if (where === 'Before') await open(restored);
    await js(`(() => { const h = document.querySelector('[data-pic-gone]'); document.getElementById('body').focus();
      const r = document.createRange(); r.setStart${where}(h); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
    await js('(async () => __t.paste({ files: [await __t.png(120, 80)] }))()');
    await imgsWhen(1);
    await settled();
    const st = await js('({ holes: document.querySelectorAll("[data-pic-gone]").length, inL2: !!document.querySelector("#l2 img") })');
    ok(st.holes === 0 && st.inL2, `  자리표 바로 ${where === 'After' ? '뒤' : '앞'}에 커서 → 자리표가 그림으로 바뀐다`, st);
    await js('__calls.send.length = 0; document.getElementById("send").click(); true');
    ok(!!(await until(() => js('__calls.send.length === 1'), 5000)), '    그대로 보낸다');
  }
  await open(restored);
  await js(`(() => { const t = document.getElementById('l1').firstChild; document.getElementById('body').focus();
    const r = document.createRange(); r.setStart(t, 2); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
  await js('(async () => __t.paste({ files: [await __t.png(121, 80)] }))()');
  await imgsWhen(1);
  await settled();
  await js('document.getElementById("send").click(); true');
  m = await msgWhen(/점선 상자/, 3000);
  ok(m && m.kind.includes('bad') && (await js('__calls.send.length')) === 0, '  다른 데 붙였으면 자리표가 남는다 — 안내는 실제 동작대로 («점선 상자» · 그 자리에 붙이면 바뀐다)', m || await js('__t.msg()'));
  // 자리표 옆에 붙이는 중에 임시 저장 — 자리표에 단 번호(data-pic-take)·표식은 안 적는다. 그런 초안을 이어 써도 남지 않는다
  await open(restored);
  await makeBig();
  await js(`(() => { const h = document.querySelector('[data-pic-gone]'); document.getElementById('body').focus();
    const r = document.createRange(); r.setStartAfter(h); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    __t.paste({ files: [window.__big] }); document.getElementById('subject').value += ' 고침'; saveDraftNow(); return true; })()`);
  const d19 = await js('__calls.draft[__calls.draft.length - 1] || null');
  ok(d19 && /data-pic-gone/.test(d19.bodyHtml) && !/data-pic-take|data-paste-slot/.test(d19.bodyHtml), '  붙이는 중 임시 저장 — 자리표는 남고, 번호·표식은 없다', d19 && d19.bodyHtml.replace(/style="[^"]*"/g, '').slice(0, 200));
  await settled();
  const slotHtml = require(path.join(ROOT, 'renderer', 'pastepick.js')).slotHtml;
  await open({ ...restored, bodyHtml: `<div id="l1">쓰던 글</div><div id="l2">${HOLE.replace('<span data-pic-gone="1"', '<span data-pic-gone="1" data-pic-take="1"')}${slotHtml(1)}</div>` });
  ok(await js('!document.querySelector("[data-pic-take], [data-paste-slot]") && !!document.querySelector("[data-pic-gone]")'), '  번호·표식이 남은 초안을 이어 써도 — 이 창에서는 치운다 (자리표는 그대로)');

  console.log('\n[20] WebP 가 커지면 «줄였습니다»라 하지 않는다');
  await open(BASE);
  await js('__t.reset()');
  const webpSize = await js('(async () => { window.__nwebp = await __t.noiseWebp(1400, 1400, 0.5); return window.__nwebp.size; })()');
  await js('__t.paste({ files: [window.__nwebp] }); true');
  imgs = await imgsWhen(1, 30000);
  m = await msgWhen(/붙였습니다/, 5000);
  ok(imgs && imgs[0].type === 'image/jpeg' && imgs[0].bytes >= webpSize, `  (전제: ${(webpSize / MB).toFixed(1)}MB WebP → PNG 가 5MB 를 넘어 JPEG, 결과가 더 크다)`, imgs && { webp: webpSize, out: imgs[0].bytes, type: imgs[0].type });
  ok(m && m.text === '그림 1개를 붙였습니다', '알림에 «커서 줄였습니다 (작은 → 큰)» 이 없다', m);

  console.log('\n[21] 화면 배율 width — 브라우저 «이미지 복사» 그림에는 안 단다');
  await js('__t.reset(); Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1.5 }); true');
  await js(`(async () => __t.paste({ text: 'https://x.example/a.png', html: '<img src="https://x.example/a.png">', files: [await __t.png(600, 100)] }))()`);
  imgs = await imgsWhen(1);
  ok(imgs && imgs[0].nw === 600 && imgs[0].width === null, '배율 1.5 + HTML <img> 와 함께 온 비트맵 → width 없음 (원래 픽셀 그대로)', imgs);
  await js('__t.reset()');
  await js('(async () => __t.paste({ files: [await __t.png(600, 100)] }))()');
  imgs = await imgsWhen(1);
  ok(imgs && imgs[0].width === '400', '  HTML 없는 비트맵(캡처) → width = 600/1.5 = 400', imgs);
  await js('Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 }); true');

  console.log('\n[22] 엑셀 빈 칸 → 그림 안 넣는다');
  await js('__t.reset()');
  await js(`(async () => __t.paste({ text: '\\t\\r\\n', html: '<table><tr><td></td><td></td></tr></table>', files: [await __t.png(128, 40)] }))()`);
  await sleep(600);
  ok((await js('__t.imgs()')).length === 0, '공백 글 + <img> 없는 표 + 비트맵 → 그림 없음', await js('__t.seq()'));

  console.log('\n[23] 거절 안내 — 항목마다');
  await js('__t.reset()');
  await js(`__t.paste({ files: [new File([new Uint8Array(${31 * MB})], 'image.png', { type: 'image/png' })] })`);
  m = await msgWhen(/30MB/);
  ok(m && /^붙여넣은 그림 — 그림이 너무 큽니다 \(30MB 넘음\) · 파일로 저장한 뒤 «파일 첨부»로 붙여 주세요$/.test(m.text), '30MB 넘는 클립보드 그림 → «파일로 저장한 뒤 «파일 첨부»로»', m);
  await js('__t.reset()');
  await js(`(() => { const f = __t.file('', 'photos', '', 'C:\\\\fake\\\\photos'); f.__testSkip = '폴더는 붙일 수 없습니다'; __t.paste({ files: [f] }); return true; })()`);
  m = await msgWhen(/폴더/);
  ok(m && m.text === 'photos — 폴더는 붙일 수 없습니다', '  메인이 뺀 폴더 → 안내 꼬리 없음', m);
  await js('__t.reset()');
  await js(`__t.paste({ files: [__t.file('x', '', 'application/octet-stream')] })`);
  m = await msgWhen(/붙여넣을 수 없습니다/);
  ok(m && m.text.startsWith('붙여넣은 파일 — '), '  이름 없는 그림 아닌 파일 → «붙여넣은 파일»', m);

  console.log('\n[24] 그림 주소만 온 붙여넣기');
  await js('__t.reset()');
  ok(await js(`__t.paste({ text: '', html: '<img src="https://x.example/a.png">' })`), '  기본 동작은 막는다 (바깥 주소를 안 부른다)');
  m = await msgWhen(/그림 주소만/, 3000);
  ok(m && m.kind.includes('bad') && (await js('__t.imgs()')).length === 0, '아무것도 안 들어가지만 그렇다고 알린다', m || await js('__t.msg()'));

  console.log('\n[25] 인용문의 큰 WebP — 보낼 때 5MB 아래로');
  const qWebp = await js('__t.noiseWebpDataUrl(1400, 1400, 0.5)');
  await js(`__t.reset('<div id="l1">답장</div><blockquote><img src="${qWebp}"></blockquote>')`);
  const q25 = await js(`(async () => { const r = await bodyForSend();
    return { gone: r.gone, inline: r.inline.map((a) => ({ type: a.contentType, bytes: Math.floor(a.base64.length * 3 / 4) })) }; })()`);
  ok(q25.gone === 0 && q25.inline.length === 1 && ['image/png', 'image/jpeg'].includes(q25.inline[0].type) && q25.inline[0].bytes <= 5 * MB,
    `${(qWebp.length * 0.75 / MB).toFixed(1)}MB WebP 인용 그림 → PNG·JPEG 5MB 이하 (메인이 거절하지 않는다)`, q25);

  console.log('\n[26] 임시 저장 — DOMParser 없이, 본문은 한 번만 읽고, «그림 넣는 중» 표식은 안 적는다');
  const big26 = await js('__t.noiseDataUrl(900, 900)');
  await js(`__t.reset('<div id="l1">가나다라</div><img src="${big26}" data-name="big.png"><div>끝</div>')`);
  const cnt = await js(`(() => {
    const b = document.getElementById('body');
    const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    let reads = 0; let parsers = 0;
    Object.defineProperty(b, 'innerHTML', { configurable: true, get() { reads++; return d.get.call(this); }, set(v) { d.set.call(this, v); } });
    const P0 = window.DOMParser;
    window.DOMParser = function (...a) { parsers++; return new P0(...a); };
    try { saveDraftNow(); } finally { delete b.innerHTML; window.DOMParser = P0; }
    const last = __calls.draft[__calls.draft.length - 1];
    return { reads, parsers, holes: (String(last && last.bodyHtml).match(/data-pic-gone/g) || []).length };
  })()`);
  ok(cnt.parsers === 0 && cnt.reads <= 1 && cnt.holes === 1, '큰 그림 본문 저장 — DOMParser 0번, 본문 innerHTML 1번 읽기, 자리표 1개', cnt);
  await js('__t.reset()');
  await makeBig();
  await js('__t.paste({ files: [window.__big] }); saveDraftNow(); true');
  const d26 = await js('__calls.draft[__calls.draft.length - 1] || null');
  ok(d26 && !/data-paste-slot|그림 넣는 중/.test(d26.bodyHtml), '  붙이는 중에 저장해도 «그림 넣는 중» 표식은 안 적는다', d26 && d26.bodyHtml.slice(0, 160));
  await imgsWhen(1, 30000);
  await settled();

  console.log('\n[27] 보낼 때 — 이름의 방향 글자·확장자, 매개변수 있는 data:, base64 아닌 data:');
  const p27 = await js('__t.pngDataUrl(20, 20, "#a50")');
  const b27 = await js('__t.pngDataUrl(21, 21, "#05a")');
  const svg27 = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="9"><rect width="12" height="9" fill="#c00"/></svg>');
  const set27 = await js(`(() => { try {
    __t.reset('<div id="l1">가나다</div><blockquote><img id="q2" src="data:image/png;name=a.png;base64,${b27.split(',')[1]}"><img id="q3" src="data:image/svg+xml,${svg27}"></blockquote>');
    const i = document.createElement('img'); i.src = ${JSON.stringify(p27)}; i.setAttribute('data-name', '사진\\u202Egnp.exe');
    document.getElementById('l1').append(i);
    return true;
  } catch (e) { return String(e && e.stack || e); } })()`);
  ok(set27 === true, '  (본문 차리기)', set27);
  const o27 = await js(`(async () => { const r = await bodyForSend(); return { gone: r.gone, names: r.inline.map((a) => a.filename), types: r.inline.map((a) => a.contentType), hasData: /data:/.test(r.html) }; })()`);
  ok(o27.names[0] === '사진gnp.png', '이름의 U+202E 는 빼고, 형식과 안 맞는 .exe 는 .png 로', o27.names);
  ok(o27.names.length === 3 && !o27.hasData && o27.gone === 0 && o27.types.every((t) => t === 'image/png'),
    '  data:image/png;name=…;base64 · data:image/svg+xml,… 도 cid 로 (html 에 data: 가 안 남는다)', o27);

  console.log('\n[28] 되돌리기 — 붙인 그림이 빠지고 «그림 넣는 중…» 표식은 안 남는다');
  await js('__t.reset()');
  await js('(async () => __t.paste({ files: [await __t.png(60, 40)] }))()');
  await imgsWhen(1);
  await settled();
  const u28 = await js(`(() => { document.execCommand('undo');
    return { imgs: __t.imgs().length, slots: document.querySelectorAll('#body [data-paste-slot]').length, seq: __t.seq() }; })()`);
  ok(u28.imgs === 0 && u28.slots === 0 && u28.seq === '가나다라', 'Ctrl+Z 한 번 → 그림이 빠지고 표식도 없다', u28);
  await js('__t.reset()');
  await makeBig();
  await js('__t.paste({ files: [window.__big] }); document.execCommand("undo"); true');
  await settled();
  m = await js('__t.msg()');
  ok((await js('__t.imgs().length')) === 0 && /자리를 지워서 그림을 넣지 않았습니다/.test(m.text), '붙이는 중에 Ctrl+Z → 표식이 빠지고 그림은 안 넣는다고 알린다', m);

  // ── 검증(돌연변이 시험)에서 더한 것 — 살아남은 돌연변이를 잡는다 ──
  console.log('\n[29] 검증 — «그림» 단추로 고르는 중 · 경로 있는 움직이는 GIF · 이어 쓰기 본문 그림 합계');
  await open(BASE);
  await js('__t.reset(); context.bodyHtml = document.getElementById("body").innerHTML.trim(); true');
  // 대화상자가 떠 있는 동안 (고른 답이 아직 안 옴) — 본문에는 아직 «그림 넣는 중…» 표식이 없다
  await js('window.__pickResult = new Promise((r) => { window.__releasePick = r; }); document.getElementById("btn-image").click(); true');
  await until(() => js('__calls.pick === 1'), 3000);
  const d29 = await js('({ dirty: dirty(), same: document.getElementById("body").innerHTML.trim() === context.bodyHtml })');
  ok(d29.dirty === true && d29.same === true, '«그림» 단추로 고르는 중 (본문은 그대로) → «쓰던 글»이 있다 (다른 «쓰기»가 와도 묻는다)', d29);
  await js('window.__releasePick({ images: [], skipped: [] }); true');
  await settled();
  ok((await js('dirty()')) === false, '  고르기를 그만두면 다시 «쓰던 글» 없음');

  await js('__t.reset()');
  await js(`(() => { const g = __t.bigAnimGif(); const f = __t.withPath(new File([g], 'anim.gif', { type: 'image/gif' }), 'C:\\\\fake\\\\anim.gif');
    __t.paste({ files: [f] }); return true; })()`);
  chips = await until(async () => { const c = await js('__t.chips()'); return c.length ? c : null; }, 15000);
  await settled();
  ok(chips && chips[0] === 'anim.gif' && (await js('__t.imgs()')).length === 0 && JSON.stringify(await js('__calls.drop')) === '[["anim.gif"]]',
    '5MB 넘는 움직이는 GIF (경로 있음) → 펴서 줄이지 않고 첨부 (끌어다 놓기와 같은 composeDropFiles)', { chips, drop: await js('__calls.drop') });

  const pic29 = await js('__t.noiseDataUrl(400, 400)');
  await open({ ...BASE, title: '이어 쓰기', restored: true, restoredAt: Date.now(), bodyHtml: `<div>쓰던 글</div><img src="${pic29}" data-name="a.png">` });
  ok((await js('__t.imgs().length')) === 1, '  (이어 쓰기 본문에 그림 하나)');
  // 본문을 고치기 전 (input 이 한 번도 안 옴) — 연 순간 센 값으로 경고가 나와야 한다
  await js('attachMax = 300 * 1024; renderFiles(); true');
  const over29 = await js('(document.querySelector("#files .over") || {}).textContent || ""');
  ok(/본문 그림/.test(over29) && /300KB까지만/.test(over29), '이어 쓰기 본문에 담겨 온 그림도 연 순간부터 합계에 센다', over29 || await js('document.getElementById("files").textContent'));
  await js('attachMax = 25 * 1024 * 1024; renderFiles(); true');

  console.log('\n[30] 검증 — 보낼 때: 원래 height 는 지킨다 · 남은 «그림 넣는 중» 표식은 안 보낸다 · 못 그리는 그림은 뺀다 · 5MB 넘는 PNG 는 줄인다');
  await open(BASE);
  const sm30 = await js('__t.pngDataUrl(20, 20, "#abc")');
  const slot30 = require(path.join(ROOT, 'renderer', 'pastepick.js')).slotHtml(9);
  await js(`__t.reset(${JSON.stringify(`<div id="l1">가나${slot30}다라</div><img src="${sm30}" style="height:40px"><img src="data:image/tiff;base64,SUkqAAgAAAA=">`)})`);
  const o30 = await js(`(async () => { const r = await bodyForSend(); const doc = new DOMParser().parseFromString(r.html, 'text/html');
    return { gone: r.gone, n: r.inline.length, hasData: /data:/.test(r.html), slot: /paste-slot|그림 넣는 중/.test(r.html),
      styles: [...doc.querySelectorAll('img')].map((i) => i.getAttribute('style') || '') }; })()`);
  ok(!o30.slot && o30.n === 1, '«그림 넣는 중…» 표식은 보내는 그림이 아니다 (cid 그림으로 안 바뀐다)', o30);
  ok(o30.styles.length === 1 && /height:\s*40px/.test(o30.styles[0]) && /max-width:\s*100%/.test(o30.styles[0]), '  원래 style 의 height 는 그대로 두고 max-width 만 더한다', o30.styles);
  ok(o30.gone === 1 && !o30.hasData, '  못 그리는 TIFF data: 그림은 빼고 (gone 1), html 에 data: 가 안 남는다', o30);
  await js(`(async () => { window.__big30 = await __t.noiseDataUrl(2000, 2000); __t.reset('<div id="l1">답장</div>');
    const i = document.createElement('img'); i.src = window.__big30; document.getElementById('body').append(i); return true; })()`);
  const b30 = await js(`(async () => { const r = await bodyForSend();
    return { src: Math.floor(window.__big30.length * 3 / 4), inline: r.inline.map((a) => ({ type: a.contentType, bytes: Math.floor(a.base64.length * 3 / 4) })) }; })()`);
  ok(b30.src > 5 * MB && b30.inline.length === 1 && b30.inline[0].type === 'image/jpeg' && b30.inline[0].bytes <= 5 * MB,
    '본문에 남은 5MB 넘는 PNG (이어 쓰기·인용문) → 보낼 때 5MB 아래 JPEG 로 (메인이 거절하지 않는다)', b30);
  await js('window.__big30 = null; __t.reset(); true');

  console.log('\n[31] 검증 — 원래 크기 JPEG 도 5MB 를 넘으면 더 줄인다 · 투명한 곳은 흰 바탕');
  await open(BASE);
  await js('__t.reset()');
  const s31 = await js('(async () => { window.__huge = await __t.noisePng(2800, 2800); return window.__huge.size; })()');
  await js('__t.paste({ files: [window.__huge] }); true');
  imgs = await imgsWhen(1, 90000);
  await settled(60000);
  ok(s31 > 5 * MB && s31 <= 30 * MB && imgs && imgs[0].type === 'image/jpeg' && imgs[0].bytes <= 5 * MB && imgs[0].nw < 2800 && imgs[0].nw >= 800,
    `2800×2800 잡음 PNG (${(s31 / MB).toFixed(1)}MB · 원래 크기 JPEG 도 5MB 넘음) → 더 작게 줄여 5MB 이하`, imgs && { type: imgs[0].type, mb: (imgs[0].bytes / MB).toFixed(2), nw: imgs[0].nw });
  await js('window.__huge = null; __t.reset()');
  await js(`(async () => {
    const c = document.createElement('canvas'); c.width = 2000; c.height = 2000;
    const x = c.getContext('2d'); const d = x.createImageData(2000, 2000); const a = d.data;
    for (let i = 0; i < a.length; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(a.length, i + 65536)));
    for (let i = 3; i < a.length; i += 4) a[i] = 255;
    x.putImageData(d, 0, 0); x.clearRect(0, 0, 300, 2000);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    window.__holeSize = b.size;
    __t.paste({ files: [new File([b], 'image.png', { type: 'image/png' })] });
    return true;
  })()`);
  imgs = await imgsWhen(1, 60000);
  await settled(60000);
  const px31 = await js(`(() => { const i = document.querySelector('#body img:not([data-paste-slot])'); if (!i) return [];
    const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const x = c.getContext('2d'); x.drawImage(i, 0, 0);
    return [...x.getImageData(20, Math.round(c.height / 2), 1, 1).data]; })()`);
  ok(imgs && imgs[0].type === 'image/jpeg' && (await js('window.__holeSize')) > 5 * MB && px31.length === 4 && px31.slice(0, 3).every((v) => v >= 235),
    '투명한 곳이 있는 큰 PNG → JPEG 로 줄일 때 투명한 곳은 흰색 (검게 나오지 않는다)', { px: px31, type: imgs && imgs[0].type, mb: ((await js('window.__holeSize')) / MB).toFixed(1) });

  const bads = errors.filter((e) => !/Autofill|DevTools/.test(e));
  ok(!bads.length, '쓰기 창 콘솔에 오류 없음', bads.slice(0, 4));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
}).catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });

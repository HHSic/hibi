'use strict';
// 메일 보기 창의 첨부 칸 — «첨부»와 «본문 그림»을 따로 보여 주는가.
//
// 사용자 보고: «표에 그냥 붙여서 두면 되는데 이미지가 다 맨날 첨부파일처럼 됨».
// 실측(Outlook 메일 한 통): 본문 그림 84장이 칩 84개로 첨부 칸을 덮었다 — 진짜 첨부는 0개였다.
// 이제 첨부 칸은 두 무리다:
//   · «첨부 N개» — 진짜로 붙어 온 파일만. 그림이면 작은 그림, 전부 보기·저장 칩 (예전 그대로)
//   · «본문 그림 M개 · 펼치기» — 접어 둔 한 줄. 누르면(마우스·Enter·Space) 칩이 나오고 다시 누르면 접힌다
//   진짜 첨부가 없으면 첨부 칸은 그 한 줄뿐이고, 아무것도 없으면 칸이 아예 안 보인다.
//   머리말은 본문 그림을 «첨부»라고 부르지 않는다.
// 표 속 그림은 제 칸(<td>) 안에 있고 첨부 칸을 덮지 않는다 (renderer/safehtml.js · .body 의 contain:paint).
// Word 가 v:shapes 로 이은 짝(VML 원본 ↔ 본문의 <img>)은 하나로 센다 — «본문 그림 N개»가 본문에 보이는 수와 같고,
// 칩의 «저장»은 원본을 저장한다 ([2-2]). 창에 넘기는 꼴은 메인과 같은 mail.viewPayload 로 만든다.
//
// 진짜 renderer/mailview.html 을 화면 밖(offscreen) 창에 띄워 잰다 — 사용자 모니터에는 아무것도 안 뜬다.
// 앱(main.js)은 안 띄운다. preload 대신 test/fixtures/mailview-bridge-stub.js 를 쓴다 (저장·미리보기 부탁은 기록만).
// 메일은 지어낸 것이다. 첨부 목록은 진짜 src/mail.js 가 만든다 (buildViewHtml → attachmentsForView, 메인과 같은 길).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 150_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailatts-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const mail = require(path.join(ROOT, 'src', 'mail.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 160 ? `${s.slice(0, 160)}…` : s}` : ''));
  if (!c) bad++;
};
const until = async (fn, ms = 5000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

// 1×1 PNG — 뒤에 글자를 덧붙이면 그림은 그대로 그려지고 바이트(해시)만 달라진다
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const png = (tag) => Buffer.concat([PNG, Buffer.from(tag)]);
const cidAtt = (name, content, extra = {}) => ({
  contentType: 'image/png', related: true, filename: name, content, size: content.length,
  cid: `${name}@01DB0000.00000000`, contentId: `<${name}@01DB0000.00000000>`, ...extra
});
const fileAtt = (name, type, disposition, extra = {}) => ({
  contentType: type, related: false, filename: name, content: png(name), size: PNG.length + name.length,
  contentDisposition: disposition, ...extra
});

// Word(Outlook) 꼴 — 칸마다 VML(주석 안)과 띄운 <img>(<![if !vml]> 사이)로 그림을 두 번 싣는다
// shapeId 를 주면 Word 처럼 VML 모양과 보이는 <img> 를 v:shapes 로 잇는다 (VML 쪽이 원본 그림)
const floatCell = (vmlName, imgName, label, shapeId) => '<td style="width:300px"><p class=MsoNormal>'
  + `<!--[if gte vml 1]><v:shape${shapeId ? ` id="${shapeId}"` : ''} style='position:absolute;width:300pt;height:200pt'>`
  + `<v:imagedata src="cid:${vmlName}@01DB0000.00000000" o:title=""/></v:shape><![endif]-->`
  + '<![if !vml]><span style=\'mso-ignore:vglayout;position:absolute;z-index:251636736;'
  + 'margin-left:5px;margin-top:6px;width:200px;height:133px\'>'
  + `<img width=200 height=133 alt="${label}" src="cid:${imgName}@01DB0000.00000000"${shapeId ? ` v:shapes="${shapeId}"` : ''}></span><![endif]>`
  + `${label} 설명</p></td>`;
const WORD = '<html><head><style><!--\n p.MsoNormal{margin:0cm;font-size:10.0pt}\n--></style></head><body>'
  + '<p class=MsoNormal>점검 결과를 알려 드립니다.</p>'
  + `<table border=1 cellspacing=0 cellpadding=0><tr>${floatCell('image001.png', 'image002.png', '그림 하나')}</tr>`
  + `<tr>${floatCell('image003.png', 'image004.png', '그림 둘')}</tr></table>`
  + '<p class=MsoNormal>끝.</p></body></html>';

/** 메인(mailwin.js)이 창에 넘기는 것과 같은 꼴 — viewFromSource 가 주는 모양에 mailwin 이 부르는 그 함수(mail.viewPayload) */
function payload(html, attachments) {
  const v = mail.buildViewHtml({ html, attachments }, { allowRemote: false });
  return mail.viewPayload({
    subject: '지어낸 메일', from: '보낸 사람', at: Date.UTC(2026, 9, 20, 4, 13), uid: 7, mailbox: 'INBOX',
    to: '', cc: '', text: '', html: v.html, blockedRemote: v.blockedRemote,
    attachments, shown: v.shown, missed: v.missed, twins: v.twins, source: Buffer.from('원문')
  }, { accountId: 'acc-test', seen: true });
}

// Word 가 v:shapes 로 이은 꼴 — 칸마다 VML 원본(크다, 바이트 다름)과 본문의 <img>. 실측 메일이 이 꼴이었다 (42쌍)
const LINKED = '<html><head><style><!--\n p.MsoNormal{margin:0cm}\n--></style></head><body>'
  + '<table border=1 cellspacing=0 cellpadding=0>'
  + [1, 2, 3].map((n) => `<tr>${floatCell(`image00${2 * n - 1}.png`, `image00${2 * n}.png`, `그림 ${n}`, `그림_x0020_${n}`)}</tr>`).join('')
  + '</table></body></html>';

const SCENES = {
  // 진짜 첨부 0 · 본문 그림 넷 중 하나(003)는 002 와 같은 바이트 → 목록에는 셋 (001 은 VML 짝, 바이트 다름)
  outlook: () => payload(WORD, [
    cidAtt('image001.png', png('vml-1')), cidAtt('image002.png', png('pic-1')),
    cidAtt('image003.png', png('pic-1')), cidAtt('image004.png', png('pic-2'))
  ]),
  // 진짜 첨부 셋(Outlook PDF + Content-ID · Apple Mail inline PDF · 그림 첨부) + 본문 그림 둘
  mixed: () => payload(WORD, [
    fileAtt('report.pdf', 'application/pdf', 'attachment', { cid: 'report.pdf@x', contentId: '<report.pdf@x>' }),
    cidAtt('image002.png', png('pic-1')), cidAtt('image004.png', png('pic-2')),
    fileAtt('scan.pdf', 'application/pdf', 'inline'),
    fileAtt('shot.png', 'image/png', 'attachment')
  ]),
  // 진짜 첨부만
  filesOnly: () => payload('<p>글만</p>', [fileAtt('report.pdf', 'application/pdf', 'attachment')]),
  // 아무것도 없음
  none: () => payload('<p>글만</p>', []),
  // v:shapes 로 이어진 짝 셋 — 본문에 보이는 것은 셋, 원본 셋은 목록에 안 세우고 «저장»이 대신 저장한다
  linked: () => payload(LINKED, [1, 2, 3, 4, 5, 6].map((k) => cidAtt(`image00${k}.png`, png(k % 2 ? `original-${k}`.repeat(40) : `shown-${k}`)))),
  // 글로만 된 메일 (HTML 없음) — 본문 상자의 경계가 글 모드를 망가뜨리지 않는가
  plain: () => ({ ...payload('', []), text: Array.from({ length: 120 }, (_, i) => `${i + 1}번째 줄`).join('\n') }),
  // 세정기를 지나도 남을 수 있는 «아주 위에 그리기»(z-index) 를 품은 본문 — 창 가장자리 리사이즈 존을 못 가린다
  zwall: () => payload('<div style="position:relative;z-index:2147483647;height:3000px;margin:-40px;background:#0f0">벽</div>', [])
};

app.whenReady().then(async () => {
  let current = {};
  ipcMain.on('stub:mailview', (e) => { e.returnValue = current; });

  const w = new BrowserWindow({ show: false, width: 460, height: 640,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'mailview-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const wc = w.webContents;
  const js = (c) => wc.executeJavaScript(c);
  const errors = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(String(msg).slice(0, 160)); });

  async function open(scene, theme = 'dark') {
    current = SCENES[scene]();
    await w.loadFile(path.join(ROOT, 'renderer', 'mailview.html'), { query: { radius: '20', theme } });
    const ready = await until(() => js(`document.getElementById('subject').textContent === '지어낸 메일'
      && (!${JSON.stringify(!!current.html)} || !!document.querySelector('#body.rich'))`));
    if (!ready) throw new Error(`${scene} 창이 안 그려졌다`);
    await sleep(50);
    return current;
  }
  /** 첨부 칸의 지금 모습 */
  const STATE = `(() => {
    const $ = (id) => document.getElementById(id);
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]') && el.getClientRects().length > 0;
    const atts = $('atts');
    const tog = $('inl-tog');
    const r = atts.getBoundingClientRect();
    return {
      atts: shown(atts), bare: atts.classList.contains('bare'), attsH: Math.round(r.height),
      text: atts.innerText,
      cap: shown($('atts-cap')) ? $('atts-cap').textContent : null,
      shots: [...$('shots').querySelectorAll('img')].filter(shown).length,
      files: [...$('files').querySelectorAll('.file')].filter(shown).map((b) => b.firstChild.textContent),
      inl: shown($('inl')),
      tog: shown(tog) ? tog.textContent : null,
      expanded: tog.getAttribute('aria-expanded'),
      controls: tog.getAttribute('aria-controls'),
      inlFiles: [...$('inl-files').querySelectorAll('.file')].filter(shown).map((b) => b.firstChild.textContent),
      inlAll: $('inl-files').querySelectorAll('.file').length,
      focus: document.activeElement ? (document.activeElement.id || document.activeElement.className) : ''
    };
  })()`;
  const state = () => js(STATE);
  const centerOf = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  const click = async (sel) => {
    const [x, y] = await centerOf(sel);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
  };
  // 화면 밖 창이라도 키는 초점을 가진 webContents 로만 간다 (tidyui·enterprev 와 같은 방식)
  const CHAR = { Enter: '\r', Space: ' ' };
  const key = async (keyCode) => {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (CHAR[keyCode]) wc.sendInputEvent({ type: 'char', keyCode: CHAR[keyCode] });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await sleep(80);
  };

  // ── [1] Outlook 꼴 — 진짜 첨부 없음 ─────────────────
  console.log('\n[1] 진짜 첨부가 없는 Outlook 꼴 메일 — 첨부 칸은 접힌 한 줄뿐');
  const p1 = await open('outlook');
  ok(p1.attachments.length === 3 && p1.attachments.every((a) => a.inline),
    '메인이 넘긴 목록: 본문 그림 셋 (같은 바이트 짝 하나는 빠짐)', p1.attachments.map((a) => [a.index, a.filename, a.dup]));
  let s = await state();
  ok(s.atts && s.bare, '첨부 칸이 보이고, 진짜 첨부가 없다는 표시(bare)가 붙는다', { atts: s.atts, bare: s.bare });
  ok(s.cap === null && s.shots === 0 && !s.files.length, '  «첨부» 머리말·그림 칸·첨부 칩 칸은 안 보인다', { cap: s.cap, files: s.files });
  ok(s.tog === '본문 그림 3개 · 펼치기' && s.expanded === 'false' && s.controls === 'inl-files',
    '«본문 그림 3개 · 펼치기» 한 줄 (aria-expanded=false)', { tog: s.tog, expanded: s.expanded });
  ok(!s.inlFiles.length && s.inlAll === 3, '  처음엔 접혀 있다 — 칩 셋은 만들어 두되 안 보인다', { visible: s.inlFiles, all: s.inlAll });
  ok(!/첨부/.test(s.text), '첨부 칸 어디에도 «첨부»라는 말이 없다', s.text);
  ok(s.attsH <= 40, `  큰 빈 칸이 없다 — 첨부 칸 높이 ${s.attsH}px`, s.attsH);

  // 표 속 그림이 제 칸 안에 있고 첨부 칸을 덮지 않는다
  const geo = await js(`(() => {
    const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const body = document.getElementById('body');
    const atts = document.getElementById('atts');
    // 메일은 본문 상자 안 감싸개의 그림자 뿌리에 들어 있다 (safehtml.js nunsMountMail)
    const root = body.querySelector('.mail').shadowRoot;
    const imgs = [...root.querySelectorAll('img')].map((img) => ({ alt: img.alt, img: R(img), td: R(img.closest('td')),
      pos: getComputedStyle(img.parentElement).position }));
    const a = atts.getBoundingClientRect();
    const hit = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
    return { imgs, body: R(body), atts: R(atts), hitAtts: !!hit && atts.contains(hit) };
  })()`);
  const inside = (a, b) => a.l >= b.l - 1 && a.t >= b.t - 1 && a.r <= b.r + 1 && a.b <= b.b + 1;
  ok(geo.imgs.length === 2 && geo.imgs.every((g) => g.pos === 'static' && inside(g.img, g.td)),
    '본문의 그림 둘이 제 표 칸(<td>) 안에 흐름대로 놓인다', geo.imgs.map((g) => [g.alt, g.pos, inside(g.img, g.td)]));
  ok(geo.hitAtts && geo.body.b <= geo.atts.t + 1, '  그림이 첨부 칸을 덮지 않는다 (첨부 칸 가운데를 누르면 첨부 칸이 잡힌다)', geo.hitAtts);

  // 마우스로 펼치고 접기
  await click('#inl-tog');
  s = await state();
  ok(s.expanded === 'true' && s.tog === '본문 그림 3개 · 접기'
    && JSON.stringify(s.inlFiles) === '["image001.png","image002.png","image004.png"]',
  '누르면 펼친다 — «접기»로 바뀌고 칩 셋이 원래 순서로 보인다', { tog: s.tog, files: s.inlFiles });
  // 칩은 원래 첨부 번호로 메인에 부탁한다 (같은 바이트라 빠진 003 이 있어도 번호가 안 밀린다)
  await js('window.__calls.length = 0');
  await click('#inl-files .fpair:nth-child(3) .fsave');
  await click('#inl-files .fpair:nth-child(1) .file');
  const calls = await js('window.__calls');
  ok(JSON.stringify(calls) === '[["save",3],["preview",0]]', '  «저장»·«보기»가 원래 번호(3·0)로 부탁한다', calls);
  await click('#inl-tog');
  s = await state();
  ok(s.expanded === 'false' && s.tog === '본문 그림 3개 · 펼치기' && !s.inlFiles.length, '다시 누르면 접힌다', { tog: s.tog });

  // 키보드 — 단추라서 Tab 으로 닿고 Enter·Space 로 연다
  wc.focus();
  await js("document.getElementById('inl-tog').focus()");
  await key('Enter');
  s = await state();
  ok(s.expanded === 'true' && s.inlFiles.length === 3, 'Enter 로 펼친다', s.expanded);
  await key('Tab');
  // 화면 밖 창은 문서가 OS 초점을 못 가져서(document.hasFocus() false) :focus-visible 이 저절로는 안 맞는다.
  // 초점이 칩으로 갔는지는 activeElement 로 보고, 테두리는 개발자 도구처럼 그 상태를 걸어 놓고 잰다
  const inChip = await js("!!document.activeElement.closest('#inl-files') && document.activeElement.classList.contains('file')");
  const ring = {};
  wc.debugger.attach('1.3');
  try {
    const cdp = (m, p) => wc.debugger.sendCommand(m, p);
    await cdp('DOM.enable');
    await cdp('CSS.enable');
    const { root } = await cdp('DOM.getDocument', { depth: -1 });
    for (const sel of ['#inl-tog', '#inl-files .file', '#inl-files .fsave']) {
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
      ring[sel] = await js(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(sel)}));
        return c.outlineStyle + ' ' + c.outlineWidth + ' ' + c.outlineColor; })()`);
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
  } finally {
    wc.debugger.detach();
  }
  const accent = await js(`(() => { const p = document.createElement('span'); p.style.color = 'var(--accent)';
    document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
  ok(inChip && Object.values(ring).every((v) => v === `solid 2px ${accent}`),
    '  Tab 이 펼친 첫 칩으로 가고, 단추·칩에 초점 테두리(강조색 2px)가 보인다', { inChip, ring, accent });
  wc.focus();
  await js("document.getElementById('inl-tog').focus()");
  await key('Space');
  s = await state();
  ok(s.expanded === 'false' && !s.inlFiles.length, 'Space 로 접는다', s.expanded);
  await key('Tab');
  const fv2 = await js('document.activeElement && document.activeElement.closest("#inl-files") ? "칩" : (document.activeElement.id || document.activeElement.tagName)');
  ok(fv2 !== '칩', '  접힌 칩에는 Tab 이 안 간다', fv2);

  // ── [2] 진짜 첨부 + 본문 그림 ──────────────────────
  console.log('\n[2] 진짜 첨부와 본문 그림이 같이 온 메일 — 두 무리로 따로');
  const p2 = await open('mixed');
  s = await state();
  ok(!s.bare && s.cap === '첨부 3개 · 그림 1', '머리말은 진짜 첨부만 센다 — «첨부 3개 · 그림 1»', s.cap);
  ok(JSON.stringify(s.files) === '["report.pdf","scan.pdf","shot.png"]' && s.shots === 1,
    '  Content-ID 붙은 Outlook PDF · Apple Mail inline PDF · 그림 첨부가 첨부 칩으로, 그림 첨부는 작은 그림도', { files: s.files, shots: s.shots });
  ok(s.tog === '본문 그림 2개 · 펼치기' && !s.inlFiles.length, '본문 그림은 따로 접힌 한 줄 — «본문 그림 2개 · 펼치기»', s.tog);
  ok(!/본문/.test(s.cap), '  «첨부» 머리말에 본문 그림이 섞이지 않는다');
  await js('window.__calls.length = 0');
  await click('#files .fpair:nth-child(1) .file');
  const pdfIdx = p2.attachments.find((a) => a.filename === 'report.pdf').index;
  ok(JSON.stringify(await js('window.__calls')) === JSON.stringify([['preview', pdfIdx]]), '  첨부 칩 «보기»는 예전처럼 원래 번호로 미리보기를 부탁한다', pdfIdx);
  await click('#files .fpair:nth-child(3) .file');
  ok(await js("document.getElementById('lightbox').classList.contains('on')"), '  그림 첨부 «보기»는 창 안에서 크게 (예전 그대로)');
  await click('#lightbox');

  // ── [2-2] Word 가 v:shapes 로 이은 짝 ─────────────────
  console.log('\n[2-2] v:shapes 로 이어진 짝 — 본문에 보이는 수만 센다, «저장»은 원본을');
  const pL = await open('linked');
  s = await state();
  ok(pL.attachments.length === 3 && pL.attachments.every((a) => a.inline && !a.dup),
    '메인이 넘긴 목록: 본문 그림 셋 (원본 셋은 목록에 안 선다)', pL.attachments.map((a) => [a.index, a.orig]));
  ok(s.tog === '본문 그림 3개 · 펼치기', '«본문 그림 3개» — 본문에 보이는 수와 같다 (예전엔 짝까지 세어 6개)', s.tog);
  const nImg = await js("document.getElementById('body').querySelector('.mail').shadowRoot.querySelectorAll('img').length");
  ok(nImg === 3, '  본문에 그려진 그림도 셋', nImg);
  await click('#inl-tog');
  await js('window.__calls.length = 0');
  await click('#inl-files .fpair:nth-child(1) .fsave');
  await click('#inl-files .fpair:nth-child(1) .file');
  const lc = await js('window.__calls');
  ok(JSON.stringify(lc) === '[["save",0],["preview",1]]', '  첫 칩: «저장»은 원본(0번), «보기»는 본문의 그림(1번)', lc);
  const svTitle = await js("document.querySelector('#inl-files .fpair:nth-child(1) .fsave').title");
  ok(/원본/.test(svTitle), '  «저장» 툴팁이 원본을 저장한다고 말한다', svTitle);

  // ── [3] 진짜 첨부만 / 아무것도 없음 ───────────────
  console.log('\n[3] 진짜 첨부만 · 아무것도 없음');
  await open('filesOnly');
  s = await state();
  ok(s.cap === '첨부 1개' && !s.inl && !s.bare, '진짜 첨부만 있으면 «첨부 1개», 본문 그림 줄은 없다', { cap: s.cap, inl: s.inl });
  await open('none');
  s = await state();
  ok(!s.atts, '아무것도 없으면 첨부 칸이 안 보인다 (예전 그대로)', s.atts);

  // ── [4] 라이트·다크 — 공용 색 이름을 쓴다 ───────────
  console.log('\n[4] 라이트·다크');
  const colors = {};
  for (const theme of ['dark', 'light']) {
    await open('outlook', theme);
    colors[theme] = await js(`(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--tertiary)';
      document.getElementById('atts').append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const tog = document.getElementById('inl-tog');
      return { theme: document.documentElement.dataset.theme, tog: getComputedStyle(tog).color, want };
    })()`);
    ok(colors[theme].theme === theme && colors[theme].tog === colors[theme].want,
      `${theme} — «본문 그림» 줄 글자는 --tertiary (${colors[theme].tog})`, colors[theme]);
  }
  ok(colors.dark.tog !== colors.light.tog, '  테마에 따라 색이 바뀐다 (tokens.css 가 덮는다)');

  // ── [5] 본문 상자의 경계(position:relative · contain:paint)가 다른 것을 안 망가뜨리나 ──
  console.log('\n[5] 본문 상자 경계 — 글 모드 · 그림 크게 보기 · 리사이즈 존');
  await open('plain');
  const pl = await js(`(() => { const b = document.getElementById('body');
    const before = b.scrollHeight > b.clientHeight; b.scrollTop = 200;
    return { rich: b.classList.contains('rich'), ws: getComputedStyle(b).whiteSpace, scrolls: before, top: b.scrollTop,
      lines: b.textContent.split('\\n').length }; })()`);
  ok(!pl.rich && pl.ws === 'pre-wrap' && pl.scrolls && pl.top === 200 && pl.lines === 120,
    '글 모드: 줄바꿈 그대로(pre-wrap), 넘치면 본문 상자 안에서 스크롤된다', pl);

  await open('mixed');
  // 작은 그림은 1×1 이라 손으로 맞히기 어렵다 — 같은 그림의 칩 «보기»로 연다 (dataUrl 이 있으면 바로 크게)
  await click('#files .fpair:nth-child(3) .file');
  const lb = await js(`(() => { const l = document.getElementById('lightbox'); const r = l.getBoundingClientRect();
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return { on: l.classList.contains('on'), full: r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight,
      top: !!hit && l.contains(hit) }; })()`);
  ok(lb.on && lb.full && lb.top, '그림 크게 보기는 여전히 창 전체를 덮는다 (본문 상자에 갇히지 않는다)', lb);
  await click('#lightbox');

  await open('zwall');
  const rz = await js(`(() => {
    const out = {};
    for (const z of document.querySelectorAll('.rz')) {
      const r = z.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
      const hit = document.elementFromPoint(x, y);
      out[z.dataset.dir] = hit === z;
    }
    const b = document.getElementById('body').getBoundingClientRect();
    const head = document.elementFromPoint(b.left + 30, b.top - 20);
    out.head = !!head && !!head.closest('.head');
    return out; })()`);
  ok(Object.values(rz).every(Boolean), '메일이 z-index 를 아무리 올려도 리사이즈 존 여덟 곳과 머리글이 잡힌다', rz);

  ok(!errors.length, '창에서 오류가 안 났다', errors.slice(0, 3));

  // 눈으로 볼 사진 — 시험 임시 폴더에만 남긴다
  await open('mixed');
  await click('#inl-tog');
  const shot = await w.webContents.capturePage();
  const out = path.join(tmp, 'mailatts-mixed.png');
  fs.writeFileSync(out, shot.toPNG());
  console.log(`\n  사진: ${out}`);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

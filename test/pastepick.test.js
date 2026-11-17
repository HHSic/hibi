'use strict';
// 본문에 그림 붙여넣기 — 무엇을 붙일지 정하는 셈(renderer/pastepick.js)만 본다. 창을 하나도 안 띄운다
// (node 로 돌려도 되고 npm test 로 돌려도 된다). 진짜 쓰기 창에서 붙여 보는 것은 pasteimage.test.js.
//
// 사용자: «메일 작성할때 이미지 붙이기 기능». 예전엔 붙여넣기가 글자만 받아서 화면 캡처(Win+Shift+S)·
// 브라우저의 «이미지 복사»를 붙이면 아무것도 안 들어갔다. 그렇다고 클립보드의 그림을 다 받으면
// 엑셀 칸·워드 글을 복사했을 때 같이 실려 오는 그림(비트맵)이 글 대신 들어간다. 그래서 가른다:
//   [1] kindOf·mimeOf — 그대로 넣을 것(PNG·JPEG·GIF) / PNG 로 바꿀 것(WebP·BMP·AVIF·ICO) / SVG / 못 그리는 그림 / 그림 아닌 파일
//   [2] visibleText — 클립보드 HTML 에서 «보이는 글»만 (주석·<style>·태그는 뺀다)
//   [3] decide — 글이 있으면 글 (엑셀·워드), 글 없이 그림만이면 그림, 브라우저 «이미지 복사» 꼴은 그림,
//       SVG·못 그리는 그림·그림 아닌 파일은 경로가 있으면 첨부, 없으면 거절
//   [4] shrinkSteps — 줄이는 차례 (긴 변 800px 아래로는 안 간다)
//   [5] 이름 — 붙여넣은 그림 이름(겹치면 (2)), 파일 이름 다듬기, data-name 막기
//   [6] gifFrames — 움직이는 GIF 가리기
//   [7] dataUrlBytes·inlineBytes — 본문 그림의 실제 바이트 (같은 그림은 한 번)
//   [8] pickDrops — 임시 저장에 다 안 들어가면 큰 그림부터 뺀다 (글은 자르지 않는다)
//   [9] summary — 알림 한 줄
//  [10] sendableType — 보낼 수 있는 형식 (별칭 image/jpg·image/x-png 도 맞춘다)
// npm test 는 이 파일도 Electron 으로 돌린다 — 처음 불러오다 터지면 Electron 이 오류 창을 띄우고 멈춘다.
// 터지면 바로 실패로 끝낸다 (오류 창 없이)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });

const path = require('path');

const ROOT = path.join(__dirname, '..');
let P;
try {
  P = require(path.join(ROOT, 'renderer', 'pastepick.js'));
} catch (e) {
  console.error('  실패 renderer/pastepick.js 를 못 불러왔다 —', e.message);
  process.exit(1);
}

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MB = 1024 * 1024;

console.log('\n[0] 한도');
ok(P.IMAGE_MAX === 5 * MB && P.HARD_MAX === 30 * MB && P.MIN_SIDE === 800 && P.DRAFT_HTML_MAX === 2 * MB,
  '그림 하나 5MB · 읽는 한도 30MB · 줄여도 긴 변 800px · 임시 저장 본문 2MB',
  { IMAGE_MAX: P.IMAGE_MAX, HARD_MAX: P.HARD_MAX, MIN_SIDE: P.MIN_SIDE, DRAFT_HTML_MAX: P.DRAFT_HTML_MAX });

console.log('\n[1] kindOf · mimeOf');
{
  const cases = [
    ['image/png', 'image.png', 'keep', 'image/png'],
    ['image/jpeg', 'a.jpg', 'keep', 'image/jpeg'],
    ['image/jpg', 'a.jpg', 'keep', 'image/jpeg'],
    ['image/pjpeg', 'a.jpg', 'keep', 'image/jpeg'],
    ['image/x-png', 'a.png', 'keep', 'image/png'],
    ['IMAGE/GIF', 'a.gif', 'keep', 'image/gif'],
    ['image/webp', 'a.webp', 'png', 'image/webp'],
    ['image/bmp', 'a.bmp', 'png', 'image/bmp'],
    ['image/avif', 'a.avif', 'png', 'image/avif'],
    ['image/x-icon', 'a.ico', 'png', 'image/x-icon'],
    ['image/vnd.microsoft.icon', 'a.ico', 'png', 'image/vnd.microsoft.icon'],
    ['image/svg+xml', 'a.svg', 'svg', 'image/svg+xml'],
    ['image/tiff', 'a.tif', 'other', 'image/tiff'],
    ['image/heic', 'a.heic', 'other', 'image/heic'],
    ['application/pdf', 'a.pdf', 'file', 'application/pdf'],
    ['text/plain', 'a.txt', 'file', 'text/plain'],
    // 탐색기에서 복사한 파일은 형식이 빈 채로 올 때가 있다 — 확장자로 본다
    ['', 'photo.JPG', 'keep', 'image/jpeg'],
    ['', 'shot.png', 'keep', 'image/png'],
    ['', 'x.webp', 'png', 'image/webp'],
    ['', 'logo.svg', 'svg', 'image/svg+xml'],
    ['', 'scan.tiff', 'other', 'image/tiff'],
    ['', 'report.hwp', 'file', ''],
    ['', '', 'file', '']
  ];
  for (const [type, name, kind, mime] of cases) {
    ok(P.kindOf(type, name) === kind && P.mimeOf(type, name) === mime, `${type || '(빈 형식)'} · ${name || '(이름 없음)'} → ${kind} · ${mime || '(없음)'}`,
      [P.kindOf(type, name), P.mimeOf(type, name)]);
  }
}

console.log('\n[2] visibleText — 보이는 글만');
{
  ok(P.visibleText('<html><body><!--StartFragment--><img src="https://x.example/a.png"><!--EndFragment--></body></html>').trim() === '',
    '브라우저 «이미지 복사» 꼴 — 보이는 글 없음');
  ok(P.visibleText('<table><tr><td>1</td><td>2</td></tr></table>').replace(/\s/g, '') === '12', '엑셀 표 — 칸의 글이 보인다');
  const word = '<html><head><style><!-- p.MsoNormal{margin:0} --></style></head><body><p class=MsoNormal>'
    + '<!--[if gte vml 1]><v:shape><v:imagedata src="file:///C:/x/clip_image001.png"/></v:shape><![endif]-->'
    + '<![if !vml]><img width=200 height=100 src="file:///C:/x/clip_image002.png" alt="그림 설명"><![endif]><o:p>&nbsp;</o:p></p></body></html>';
  ok(P.visibleText(word).trim() === '', '워드 그림 꼴 — <style>·VML 주석·alt·&nbsp; 는 보이는 글이 아니다', P.visibleText(word));
  ok(/\S/.test(P.visibleText('<p>&amp;</p>')), '  &amp; 같은 글자 참조는 보이는 글이다');
}

console.log('\n[3] decide — 글인가 그림인가');
const png = (o = {}) => ({ type: 'image/png', name: 'image.png', size: 120_000, hasPath: false, ...o });
{
  let d = P.decide({ text: '', html: '', files: [png()] });
  ok(d.mode === 'files' && same(d.items.map((i) => i.action), ['inline']), '화면 캡처 (글 없이 PNG 하나) → 본문 그림', d);
  ok(d.items[0].index === 0 && d.items[0].kind === 'keep' && d.items[0].mime === 'image/png', '  번호·종류·형식을 같이 준다', d.items[0]);

  d = P.decide({ text: '1\t2\r\n', html: '<table><tr><td>1</td><td>2</td></tr></table>', files: [png()] });
  ok(d.mode === 'text' && d.text === '1\t2\r\n', '엑셀 칸 (글 + 표 HTML + 그림) → 글만', d);

  d = P.decide({ text: '보고서 첫 줄', html: '<p>보고서 첫 줄</p><img src="file:///C:/x/a.png">', files: [png()] });
  ok(d.mode === 'text', '워드 글+그림 섞어 복사 (보이는 글 있음) → 글', d.mode);

  d = P.decide({ text: '', html: '<img src="file:///C:/x/clip_image002.png">', files: [png()] });
  ok(d.mode === 'files' && d.items[0].action === 'inline', '워드 그림만 (글 없음, HTML <img>, PNG) → 그림', d);

  d = P.decide({ text: 'https://x.example/a.png', html: '<img src="https://x.example/a.png">', files: [png()] });
  ok(d.mode === 'files' && d.items[0].action === 'inline', '브라우저 «이미지 복사» (글은 주소, HTML 은 <img> 뿐, PNG) → 그림', d);

  d = P.decide({ text: 'https://x.example/a.png', html: '<img src="https://x.example/a.png">', files: [] });
  ok(d.mode === 'text', '  그림 파일이 없으면 주소 글 그대로 (바깥 주소를 불러오지 않는다)', d.mode);

  d = P.decide({ text: 'https://x.example/a.svg', html: '<img src="https://x.example/a.svg">', files: [{ type: 'image/svg+xml', name: 'a.svg', size: 10 }] });
  ok(d.mode === 'text', '  예외는 넣을 수 있는 그림일 때만 — SVG 뿐이면 글', d.mode);

  d = P.decide({ text: '   \n', html: '', files: [] });
  ok(d.mode === 'text' && d.text === '   \n', '글만 있으면 예전 그대로 글 (빈칸도)', d);

  d = P.decide({ text: '', html: '', files: [] });
  ok(d.mode === 'text' && d.text === '', '아무것도 없으면 빈 글 (아무것도 안 넣는다)', d);

  d = P.decide({ text: '', html: '', files: [
    { type: 'image/webp', name: 'a.webp', size: 10 },
    { type: 'image/svg+xml', name: 'b.svg', size: 10, hasPath: true },
    { type: 'image/svg+xml', name: 'c.svg', size: 10 },
    { type: 'image/tiff', name: 'd.tif', size: 10, hasPath: true },
    { type: 'image/heic', name: 'e.heic', size: 10 },
    { type: 'application/pdf', name: 'f.pdf', size: 10, hasPath: true },
    { type: 'application/pdf', name: 'g.pdf', size: 10 },
    png({ size: 31 * MB, hasPath: true }),
    // 경로 있는 그림과 같이 오면 이름 없는 비트맵(image.png)은 빠진다 ([11]) — 여기서는 이름 있는 것으로 «경로 없는 큰 그림»을 본다
    png({ size: 31 * MB, name: 'big.png' })
  ] });
  ok(d.mode === 'files' && same(d.items.map((i) => i.action),
    ['inline', 'attach', 'refuse', 'attach', 'refuse', 'attach', 'refuse', 'attach', 'refuse']),
  'WebP → 본문 · SVG/TIFF/HEIC/PDF/30MB 넘는 그림 → 경로 있으면 첨부, 없으면 거절', d.items.map((i) => i.action));
  ok(d.items.filter((i) => i.action === 'refuse').every((i) => typeof i.why === 'string' && i.why.length > 4),
    '  거절에는 까닭이 붙는다', d.items.filter((i) => i.action === 'refuse').map((i) => i.why));
  ok(d.items[2].why === P.WHY.svg && d.items[4].why === P.WHY.format && d.items[6].why === P.WHY.noPath && d.items[8].why === P.WHY.huge,
    '  까닭: SVG · 형식 · 경로 없음 · 너무 큼');
  ok(same(P.fallback(true, 'x'), { action: 'attach', why: 'x' }) && same(P.fallback(false, 'x'), { action: 'refuse', why: 'x' }),
    'fallback — 그려 보다 안 되면 경로 있으면 첨부, 없으면 거절');
}

console.log('\n[4] shrinkSteps — 줄이는 차례');
{
  const s = P.shrinkSteps(4000, 3000);
  ok(same(s[0], { w: 4000, h: 3000 }), '처음은 원래 크기 그대로 (JPEG 로만 바꿔 본다)', s[0]);
  ok(s.every((x, i) => i === 0 || Math.max(x.w, x.h) < Math.max(s[i - 1].w, s[i - 1].h)), '  갈수록 작아진다');
  ok(Math.max(s[s.length - 1].w, s[s.length - 1].h) === 800 && s.every((x) => Math.max(x.w, x.h) >= 800), '  마지막은 긴 변 800px — 그 아래로는 안 간다',
    s.map((x) => `${x.w}x${x.h}`));
  ok(Math.abs(s[2].w / s[2].h - 4 / 3) < 0.01, '  가로세로 비는 그대로', s[2]);
  ok(same(P.shrinkSteps(700, 500), [{ w: 700, h: 500 }]), '이미 긴 변이 800px 아래면 원래 크기 하나뿐');
  ok(same(P.shrinkSteps(1000, 400).slice(-1)[0], { w: 800, h: 320 }), '긴 변 1000 → … → 800', P.shrinkSteps(1000, 400));
}

console.log('\n[5] 이름');
{
  const when = new Date(2026, 10, 17, 14, 5, 12);
  ok(P.pastedName(when, 'png', new Set()) === '붙여넣은 그림 20261117-140512.png', '붙여넣은 그림 YYYYMMDD-HHMMSS.png', P.pastedName(when, 'png', new Set()));
  const taken = new Set(['붙여넣은 그림 20261117-140512.png', '붙여넣은 그림 20261117-140512 (2).png']);
  ok(P.pastedName(when, 'png', taken) === '붙여넣은 그림 20261117-140512 (3).png', '  같은 이름이 있으면 (2)·(3) …', P.pastedName(when, 'png', taken));
  ok(P.pastedName(when, 'jpg', taken) === '붙여넣은 그림 20261117-140512.jpg', '  확장자가 다르면 다른 이름');
  ok(P.isGenericName('image.png') && P.isGenericName('') && P.isGenericName('IMAGE.JPG') && !P.isGenericName('견적서.png'),
    'isGenericName — 크로미움이 클립보드 그림에 붙이는 «image.png» 꼴');
  ok(P.safeName('a/b\\c:d*e?f"g<h>i|j.png') === 'a_b_c_d_e_f_g_h_i_j.png', 'safeName — 경로·특수 글자는 _ 로', P.safeName('a/b\\c:d*e?f"g<h>i|j.png'));
  ok(P.safeName('\u0000\u001f보고서\u007f.png') === '보고서.png', '  제어 글자는 뺀다');
  ok(P.safeName('', 'png') === '그림.png' && P.safeName('   ', 'jpg') === '그림.jpg' && P.safeName('...', 'gif') === '그림.gif', '  빈 이름은 «그림.확장자»');
  const long = P.safeName(`${'가'.repeat(300)}.png`);
  ok(long.length <= 120 && long.endsWith('.png'), '  너무 긴 이름은 줄이되 확장자는 남긴다', long.length);
  ok(P.withExt('견적.webp', 'png') === '견적.png' && P.withExt('사진.JPEG', 'jpg') === '사진.jpg' && P.withExt('이름없음', 'png') === '이름없음.png',
    'withExt — 형식을 바꾸면 확장자도');
  ok(P.escAttr(`a&b"c'd<e>`) === 'a&amp;b&quot;c&#39;d&lt;e&gt;', 'escAttr — 속성 값에 넣을 때 막는다', P.escAttr(`a&b"c'd<e>`));
}

console.log('\n[6] gifFrames — 움직이는 GIF');
{
  const head = (flags = 0) => [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, flags, 0, 0];
  const frame = () => [0x21, 0xF9, 4, 0, 0, 0, 0, 0,  0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0,  2, 2, 0x44, 0x01, 0];
  const one = Uint8Array.from([...head(), ...frame(), 0x3B]);
  const two = Uint8Array.from([...head(), 0x21, 0xFF, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0, ...frame(), ...frame(), 0x3B]);
  const gct = Uint8Array.from([...head(0x80), 0, 0, 0, 255, 255, 255, ...frame(), 0x3B]);
  ok(P.gifFrames(one) === 1, '한 장짜리 GIF → 1', P.gifFrames(one));
  ok(P.gifFrames(two) >= 2, '두 장(NETSCAPE 되풀이) → 2 이상', P.gifFrames(two));
  ok(P.gifFrames(gct) === 1, '전체 색표가 있어도 → 1', P.gifFrames(gct));
  ok(P.gifFrames(Uint8Array.from([1, 2, 3])) === -1 && P.gifFrames(Uint8Array.from(Buffer.from('\x89PNG\r\n\x1a\nxxxxxxx', 'latin1'))) === -1,
    'GIF 가 아니면 -1');
}

console.log('\n[7] dataUrlBytes · inlineBytes');
{
  const b64 = Buffer.alloc(1000, 7).toString('base64');
  const u = `data:image/png;base64,${b64}`;
  ok(P.dataUrlBytes(u) === 1000, 'data: 주소 → 실제 바이트 (base64 를 풀어 센다)', P.dataUrlBytes(u));
  ok(P.dataUrlBytes(`data:image/png;base64,${Buffer.alloc(1001, 7).toString('base64')}`) === 1001
    && P.dataUrlBytes(`data:image/png;base64,${Buffer.alloc(1002, 7).toString('base64')}`) === 1002, '  끝의 = 채움도 맞게');
  ok(P.dataUrlBytes('cid:img1@hibi') === 0 && P.dataUrlBytes('https://x.example/a.png') === 0 && P.dataUrlBytes('') === 0, '  data: 가 아니면 0');
  ok(P.inlineBytes([u, u, 'cid:x', `data:image/gif;base64,${Buffer.alloc(500).toString('base64')}`]) === 1500, 'inlineBytes — 같은 그림은 한 번만 센다 (보낼 때 cid 하나)');
}

console.log('\n[8] pickDrops — 임시 저장에서 뺄 그림');
{
  let r = P.pickDrops([100, 5000, 300], 6000, 2000, 50);
  ok(same(r, { drop: [1], fits: true }), '큰 것부터 하나만 빼면 들어간다 → 그것만', r);
  r = P.pickDrops([100, 5000, 3000], 9000, 2000, 50);
  ok(same(r, { drop: [1, 2], fits: true }), '둘을 빼야 들어가면 둘', r);
  r = P.pickDrops([100], 900, 2000, 50);
  ok(same(r, { drop: [], fits: true }), '이미 들어가면 아무것도 안 뺀다', r);
  r = P.pickDrops([100, 200], 9000, 2000, 50);
  ok(same(r.drop, [0, 1]) && r.fits === false, '다 빼도 안 들어가면 fits:false (글이 너무 길다)', r);
  ok(/data-pic-gone="1"/.test(P.PLACEHOLDER) && !/data:|<img/i.test(P.PLACEHOLDER) && P.PLACEHOLDER.length < 400,
    'PLACEHOLDER — 작은 표시 (data-pic-gone), 그림은 없다', P.PLACEHOLDER.length);
}

console.log('\n[9] summary — 알림 한 줄');
{
  let s = P.summary({ inlined: 2, shrunk: [{ from: 8.2 * MB, to: 1.9 * MB }] });
  ok(s.kind === '' && s.text === '그림 2개를 붙였습니다 · 1개는 커서 줄였습니다 (8.2MB → 1.9MB)', '붙임 + 줄임', s);
  s = P.summary({ inlined: 1 });
  ok(s.kind === '' && s.text === '그림 1개를 붙였습니다', '붙임만', s);
  s = P.summary({ attached: 2 });
  ok(s.kind === '' && s.text === '파일 2개를 첨부했습니다', '첨부만', s);
  s = P.summary({ refused: [{ name: 'a.svg', why: P.WHY.svg }] });
  ok(s.kind === 'bad' && s.text.startsWith('a.svg — SVG') && s.text.includes('«파일 첨부»'), '거절 → bad, «파일 첨부»로 안내', s);
  s = P.summary({ inlined: 1, refused: [{ name: '붙여넣은 그림', why: P.WHY.noPath }] });
  ok(s.kind === 'bad' && s.text.startsWith('그림 1개를 붙였습니다 · 붙여넣은 그림 —'), '붙임 + 거절 같이', s);
  s = P.summary({});
  ok(s.kind === '' && s.text === '', '아무 일도 없으면 빈 줄', s);
}

console.log('\n[10] sendableType');
ok(P.sendableType('image/png') === 'image/png' && P.sendableType('IMAGE/JPEG') === 'image/jpeg' && P.sendableType('image/jpg') === 'image/jpeg'
  && P.sendableType('image/pjpeg') === 'image/jpeg' && P.sendableType('image/x-png') === 'image/png' && P.sendableType('image/gif') === 'image/gif',
'PNG·JPEG·GIF (별칭 포함) → 그 형식');
ok(P.sendableType('image/webp') === '' && P.sendableType('image/svg+xml') === '' && P.sendableType('text/html') === '' && P.sendableType('') === '',
  '그 밖은 빈 값 — 보낼 때 PNG 로 바꾸거나 뺀다');

// ── 검토에서 나온 것 (붙여넣기 판단·알림·이름·임시 저장) ──
console.log('\n[11] decide — 비트맵과 같은 그림의 디스크 파일이 함께 오면 파일만');
{
  // 파이어폭스 «이미지 복사»·사진 앱은 비트맵(image.png)과 그 그림 파일(경로 있음)을 같이 싣는다 — 두 장 들어가면 안 된다
  let d = P.decide({ text: '', html: '<img src="https://x.example/cat.png">', files: [png(), png({ name: 'cat.png', hasPath: true })] });
  ok(d.mode === 'files' && d.items.length === 1 && d.items[0].index === 1 && d.items[0].action === 'inline',
    '비트맵 + 경로 있는 cat.png → cat.png 하나만', d);
  d = P.decide({ text: '', html: '', files: [png(), { type: 'application/pdf', name: 'a.pdf', size: 10, hasPath: true }] });
  ok(d.mode === 'files' && d.items.length === 2, '  경로 있는 것이 그림이 아니면 비트맵은 그대로', d.items && d.items.map((i) => i.index));
  d = P.decide({ text: '', html: '', files: [png({ name: '견적.png' }), png({ name: 'cat.png', hasPath: true })] });
  ok(d.mode === 'files' && d.items.length === 2, '  이름 있는 그림(사람이 붙인 이름)은 빼지 않는다', d.items && d.items.map((i) => i.index));
}

console.log('\n[12] decide — 엑셀 빈 칸 · 그림 주소만 · 화면 캡처 표시');
{
  // 엑셀 빈 칸: 글은 탭·줄바꿈뿐, 표 HTML 에 <img> 없음, 빈 표를 찍은 비트맵 — 그림이 아니다
  let d = P.decide({ text: '\t\r\n', html: '<table><tr><td></td><td></td></tr></table>', files: [png()] });
  ok(d.mode === 'text' && d.text === '\t\r\n', '엑셀 빈 칸 (공백 글 + <img> 없는 표 + 비트맵) → 글 모드 (그림 안 넣음)', d);
  d = P.decide({ text: '\r\n', html: '<p class=MsoNormal><o:p>&nbsp;</o:p></p>', files: [png()] });
  ok(d.mode === 'text', '  워드 빈 줄 (<p> 뿐) + 비트맵 → 글 모드', d.mode);
  d = P.decide({ text: '', html: '<img src="https://x.example/a.png">', files: [] });
  ok(d.mode === 'text' && d.text === '' && d.urlOnly === true, '그림 주소만 (비트맵 없음, HTML <img> 뿐) → urlOnly 로 알린다', d);
  ok(typeof P.WHY.urlOnly === 'string' && /그림 주소만/.test(P.WHY.urlOnly), '  알림 «그림 주소만 왔습니다 …»', P.WHY.urlOnly);
  d = P.decide({ text: '', html: '', files: [] });
  ok(!d.urlOnly, '  빈 붙여넣기는 urlOnly 아님');
  // 화면 배율 width 는 HTML 없이 비트맵만 온 것(캡처 도구)에만
  d = P.decide({ text: '', html: '', files: [png()] });
  ok(d.items[0].screen === true, '비트맵만 (HTML 없음) → screen (화면 캡처)', d.items[0]);
  d = P.decide({ text: '', html: '<img src="https://x.example/a.png">', files: [png()] });
  ok(d.items[0].screen === false, '  브라우저 «이미지 복사» (HTML <img>) → screen 아님 (그림의 원래 픽셀)', d.items[0]);
  d = P.decide({ text: '', html: '', files: [png({ name: 'shot.png', hasPath: true })] });
  ok(d.items[0].screen === false, '  경로 있는 파일 → screen 아님', d.items[0]);
}

console.log('\n[13] 거절 안내 — 항목마다 맞는 말');
{
  let d = P.decide({ text: '', html: '', files: [png({ size: 31 * MB }), { type: 'application/pdf', name: 'g.pdf', size: 10 }, { type: 'image/svg+xml', name: 'c.svg', size: 10 }] });
  ok(d.items.every((i) => i.action === 'refuse' && i.hint === 'save'), '경로 없는 것(클립보드에만 있는 그림·파일) → hint save', d.items.map((i) => i.hint));
  ok(P.hintFor(P.WHY.broken, 'clip') === '' && P.hintFor(P.WHY.tooBig, 'clip') === 'save' && P.hintFor(P.WHY.anim, 'disk') === 'attach'
    && P.hintFor(P.WHY.broken, 'disk') === '', 'hintFor — 못 읽은 그림은 안내 없음, 클립보드는 save, 디스크 파일은 attach');
  let s = P.summary({ refused: [{ name: '붙여넣은 그림', why: P.WHY.huge, hint: 'save' }] });
  ok(s.kind === 'bad' && s.text.endsWith('파일로 저장한 뒤 «파일 첨부»로 붙여 주세요'), '클립보드 그림 → «파일로 저장한 뒤 «파일 첨부»로»', s);
  s = P.summary({ refused: [{ name: '사진', why: '폴더는 붙일 수 없습니다', hint: '' }] });
  ok(s.kind === 'bad' && !s.text.includes('파일 첨부') && s.text === '사진 — 폴더는 붙일 수 없습니다', '폴더·못 읽은 것 → 안내 꼬리 없음', s);
  s = P.summary({ refused: [{ name: 'big.gif', why: P.WHY.anim, hint: 'attach' }] });
  ok(s.text.endsWith(' · «파일 첨부»로 붙여 주세요') && !s.text.includes('저장한 뒤'), '디스크 파일 → «파일 첨부»로', s);
  s = P.summary({ refused: [{ name: 'a', why: 'x', hint: 'attach' }, { name: 'b', why: 'y', hint: 'save' }] });
  ok((s.text.match(/파일 첨부/g) || []).length === 1 && s.text.endsWith('파일로 저장한 뒤 «파일 첨부»로 붙여 주세요'), '  섞이면 안내는 한 번 (저장 쪽)', s);
  ok(P.labelFor('', 'file', false) === '붙여넣은 파일' && P.labelFor('image.png', 'keep', false) === '붙여넣은 그림'
    && P.labelFor('', 'keep', false) === '붙여넣은 그림' && P.labelFor('a/b.pdf', 'file', true) === 'a_b.pdf',
  'labelFor — 이름 없는 그림 아닌 파일은 «붙여넣은 파일»', [P.labelFor('', 'file', false), P.labelFor('a/b.pdf', 'file', true)]);
}

console.log('\n[14] summary — 커지면 «줄였습니다»라 하지 않는다 · 자리를 지운 붙여넣기');
{
  let s = P.summary({ inlined: 1, shrunk: [{ from: 1.7 * MB, to: 3.0 * MB }] });
  ok(s.text === '그림 1개를 붙였습니다', 'WebP 1.7MB → JPEG 3.0MB — «줄였습니다» 없음', s);
  s = P.summary({ inlined: 2, shrunk: [{ from: 8.2 * MB, to: 1.9 * MB }, { from: 1 * MB, to: 2 * MB }] });
  ok(s.text === '그림 2개를 붙였습니다 · 1개는 커서 줄였습니다 (8.2MB → 1.9MB)', '  줄어든 것만 센다', s);
  s = P.summary({ dropped: 1 });
  ok(/자리를 지워서 그림을 넣지 않았습니다/.test(s.text), '«그림 넣는 중» 자리를 지웠으면 그렇다고 알린다', s);
}

console.log('\n[15] 이름 — 방향 바꾸는 글자·C1·줄 구분 · 형식과 맞는 확장자');
{
  ok(P.safeName('사진\u202egnp.exe') === '사진gnp.exe', 'safeName — U+202E(RLO) 를 뺀다', P.safeName('사진\u202egnp.exe'));
  ok(P.safeName('a\u0085b\u2028c\u2029d\u200ee\u200ff\u2066g\u2069h\u061ci\ufeffj.png') === 'abcdefghij.png', '  C1(U+0085)·줄 구분·LRM/RLM·격리·BOM 도 뺀다',
    P.safeName('a\u0085b\u2028c\u2029d\u200ee\u200ff\u2066g\u2069h\u061ci\ufeffj.png'));
  ok(P.nameFor('사진\u202egnp.exe', 'image/png') === '사진gnp.png', 'nameFor — 형식과 안 맞는 확장자(.exe)는 형식 확장자로', P.nameFor('사진\u202egnp.exe', 'image/png'));
  ok(P.nameFor('x.jpeg', 'image/jpeg') === 'x.jpeg' && P.nameFor('x.JPG', 'image/jpeg') === 'x.JPG' && P.nameFor('a.png', 'image/gif') === 'a.gif'
    && P.nameFor('b.png', 'image/png') === 'b.png' && P.nameFor('', 'image/jpeg') === '그림.jpg',
  '  맞는 것은 그대로, 다르면 바꾼다', [P.nameFor('a.png', 'image/gif'), P.nameFor('', 'image/jpeg')]);
}

console.log('\n[16] 자리표·붙이는 중 표식·임시 저장 본문 (draftHtml)');
{
  ok(/contenteditable="false"/.test(P.PLACEHOLDER), 'PLACEHOLDER 는 contenteditable="false" — 커서가 안에 못 들어가고 한 덩어리로 지워진다');
  const slot = P.slotHtml(7);
  ok(/^<img\b/.test(slot) && /data-paste-slot="7"/.test(slot) && /alt="그림 넣는 중…"/.test(slot) && /src="data:image\/svg\+xml,/.test(slot)
    && !/style=/.test(slot) && !/["'<>]/.test(P.SLOT_SRC.slice(5)),
  'slotHtml — «그림 넣는 중…» 표식 (글 사이에 한 덩어리로 끼는 작은 그림, data: 만, 테두리는 CSS)', slot.slice(0, 80));
  ok(P.stripSlots(`<div>가나${P.slotHtml(1)}다라${P.slotHtml(22)}</div>`) === '<div>가나다라</div>', 'stripSlots — 표식을 걷어낸다');
  const marked = P.PLACEHOLDER.replace('<span data-pic-gone="1"', '<span data-pic-gone="1" data-pic-take="3"');
  ok(P.stripSlots(`<div>${marked}</div><p> data-pic-take="3" 은 글</p>`) === `<div>${P.PLACEHOLDER}</div><p> data-pic-take="3" 은 글</p>`,
    '  자리표에 달아 둔 번호(data-pic-take)도 지운다 — 글은 안 건드린다');
  const b64 = (n) => Buffer.alloc(n, 3).toString('base64');
  const small = `<img src="data:image/png;base64,${b64(30)}" data-name="s.png">`;
  const big = `<img alt="가&gt;나" src="data:image/png;base64,${b64(3000)}" data-name="b.png">`;
  const html = `<div>앞${P.slotHtml(3)}</div>${big}<div>사이</div>${small}<div>END</div>`;
  let r = P.draftHtml(html, 2000);
  ok(r.dropped === 1 && r.html === `<div>앞</div>${P.PLACEHOLDER}<div>사이</div>${small}<div>END</div>`,
    'draftHtml — 넘으면 큰 그림만 자리표로, 나머지 글자는 한 글자도 안 바뀐다, 표식은 지운다', r.dropped);
  r = P.draftHtml(`<div>짧다${P.slotHtml(4)}</div>`, 2000);
  ok(r.dropped === 0 && r.html === '<div>짧다</div>', '  한도 안이면 표식만 지운다', r);
  r = P.draftHtml(`<img alt='a>b' src="data:image/png;base64,${b64(3000)}"><p>끝</p>`, 2000);
  ok(r.dropped === 1 && r.html === `${P.PLACEHOLDER}<p>끝</p>`, '  속성 값 안의 «>» 에서 끊기지 않는다', r.html.slice(0, 80));
}

// ── 검증(돌연변이 시험)에서 더한 것 — 살아남은 돌연변이를 잡는다 ──
console.log('\n[17] draftHtml — 넘쳐도 글은 한 글자도 자르지 않는다 (자르는 것은 메인이 본문을 비우는 쪽으로)');
{
  const b64 = (n) => Buffer.alloc(n, 5).toString('base64');
  const longText = `<div>${'가'.repeat(3000)}END-T</div>`;
  let r = P.draftHtml(longText, 2000);
  ok(r.dropped === 0 && r.html === longText, '그림 없이 글만 한도를 넘음 → 그대로 돌려준다 (잘라서 2000자로 만들지 않는다)', { len: r.html.length, dropped: r.dropped });
  const big = `<img src="data:image/png;base64,${b64(3000)}">`;
  const html = `<div>${'나'.repeat(2500)}END-U</div>${big}<p>꼬리</p>`;
  r = P.draftHtml(html, 2000);
  ok(r.dropped === 1 && r.html === `<div>${'나'.repeat(2500)}END-U</div>${P.PLACEHOLDER}<p>꼬리</p>`,
    '  그림을 다 빼도 넘으면 → 그림은 자리표, 글은 끝까지 그대로 (메인이 본문을 비운다)', { len: r.html.length, dropped: r.dropped });
}

console.log('\n[18] decide — 엑셀 빈 칸 규칙은 «온 파일이 모두 경로 없는 비트맵»일 때만');
{
  const d = P.decide({ text: '', html: '<p class=MsoNormal></p>', files: [png(), { type: 'application/pdf', name: 'a.pdf', size: 10, hasPath: true }] });
  ok(d.mode === 'files' && d.items.length === 2 && d.items[0].action === 'inline' && d.items[1].action === 'attach',
    '글 꼴 HTML + 비트맵 + 경로 있는 PDF → 글 모드가 아니다 (그림은 본문, PDF 는 첨부)', d);
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

'use strict';
// 지킴이 — 무엇보다 먼저. npm test 는 이 파일도 Electron 으로 돌린다: 처음 불러오다 터지면 Electron 이 오류 창을 띄우고 멈춘다.
// 터지면 오류 창 없이 실패로 끝낸다 (node 로 돌리면 require('electron') 은 경로 글자라 app·dialog 가 없다)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
{ const E = require('electron'); if (E && typeof E === 'object' && E.dialog) E.dialog.showErrorBox = () => {}; }
// 표 붙여넣기 — 글자만 다루는 셈(renderer/pastetable.js)을 본다. 창을 하나도 안 띄운다
// (node 로 돌려도 되고 npm test 로 돌려도 된다). 진짜 쓰기 창에 붙여 보는 것은 tablepaste.test.js.
//
// 엑셀·구글 시트·워드·한글에서 표를 복사해 붙이면 예전엔 탭으로 이은 글만 들어갔다. 이제 표로 넣는다 —
// 그러려면 남이 만든 스타일을 «허락한 것만, 맞춘 꼴로» 다시 적어야 한다:
//   [1] parseDecls — style 글을 [이름, 값] 으로 (따옴표·괄호 안의 ; 는 안 자른다, !important 는 뗀다, 바깥을 부르는 것은 버린다)
//   [2] declsOf — border·background·text-decoration 줄임말을 낱낱이 (border-top-width …)
//   [3] color — #hex·rgb()·rgba()·이름만. windowtext 는 #000000, auto·transparent 같은 것은 버린다
//   [4] px — pt·cm 를 px 로, % 는 표에만 (100% 까지)
//   [5] borderWidth·borderStyle·side — 0.5pt·1pt → 1px, 1.5pt → 2px, 2.25pt 이상 → 3px · solid/dashed/dotted/double/none
//   [6] cellParts — 칸에 남길 스타일 (글꼴·크기·높이·안쪽 여백·mso-* 은 버린다), 줄바꿈 안 함은 nowrap 속성으로, 밑줄·취소선은 <u>·<s> 로
//   [7] tableParts·inlineParts·blockParts·hidden
//   [8] span·widthAttr·href — 속성 값 다듬기
//   [9] cssForSheet·stripCfHeader — <style> 글에서 @import·<!-- --> 를 뗀다, CF_HTML 머리를 뗀다
//  [10] tooBig·bigText·doneText — 큰 표는 글로 (2000칸·100만 글자), 알림 한 줄
//  [11] styleText·rowsText
//  [12] 나쁜 값 몰아넣기 — 어떤 값이 와도 나가는 글은 안전한 글자뿐
const path = require('path');

const ROOT = path.join(__dirname, '..');
let T;
try {
  T = require(path.join(ROOT, 'renderer', 'pastetable.js'));
} catch (e) {
  console.error('  실패 renderer/pastetable.js 를 못 불러왔다 —', e.message);
  process.exit(1);
}

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] parseDecls');
{
  ok(same(T.parseDecls('color:red; Font-Weight : 700'), [['color', 'red'], ['font-weight', '700']]), '이름은 작은 글자로, 앞뒤 빈칸은 뗀다', T.parseDecls('color:red; Font-Weight : 700'));
  ok(same(T.parseDecls('color:red !important;width:10px'), [['color', 'red'], ['width', '10px']]), '!important 는 뗀다', T.parseDecls('color:red !important;width:10px'));
  ok(same(T.parseDecls('font-family:"a;b";color:blue'), [['font-family', '"a;b"'], ['color', 'blue']]), '따옴표 안의 ; 는 안 자른다', T.parseDecls('font-family:"a;b";color:blue'));
  ok(same(T.parseDecls('color:rgb(1, 2, 3);x:y'), [['color', 'rgb(1, 2, 3)'], ['x', 'y']]), '괄호 안은 그대로');
  ok(same(T.parseDecls('/* 주석; */color:red'), [['color', 'red']]), '주석은 뗀다', T.parseDecls('/* 주석; */color:red'));
  ok(same(T.parseDecls(''), []) && same(T.parseDecls(null), []) && same(T.parseDecls(';;:;  ;a:;:b'), []), '빈 것·부스러기 → 빈 목록', T.parseDecls(';;:;  ;a:;:b'));
  ok(same(T.parseDecls('mso-pattern:black none;border:none'), [['mso-pattern', 'black none'], ['border', 'none']]), 'mso-* 도 읽기는 한다 (나갈 때 버린다)');
  const hostile = 'background:url(https://x.example/a.png);color:red;width:expression(alert(1));behavior:url(x.htc);'
    + '-moz-binding:url(x.xml);background-image:\\75 rl(x);x:javascript:alert(1);y:vbscript:z;color:green';
  ok(same(T.parseDecls(hostile), [['color', 'red'], ['color', 'green']]), '바깥을 부르는 것·실행되는 것·\\ 이스케이프는 통째로 버린다', T.parseDecls(hostile));
  ok(T.risky('URL( x )') && T.risky('Expression(1)') && T.risky('behavior') && T.risky('JavaScript:') && T.risky('@import x') && T.risky('a\\b') && !T.risky('#ff0000') && !T.risky('1px solid windowtext'),
    'risky — url( · expression( · behavior · javascript: · @import · \\');
}

console.log('\n[2] declsOf — 줄임말 펴기');
{
  let m = T.declsOf('border:.5pt solid windowtext');
  ok(['top', 'right', 'bottom', 'left'].every((s) => m[`border-${s}-width`] === '.5pt' && m[`border-${s}-style`] === 'solid' && m[`border-${s}-color`] === 'windowtext'),
    'border:.5pt solid windowtext → 네 변 모두', m);
  m = T.declsOf('border:solid windowtext 1.0pt;border-left:none');
  ok(m['border-top-width'] === '1.0pt' && m['border-top-color'] === 'windowtext' && m['border-left-style'] === 'none',
    '워드 꼴 (순서가 달라도) + border-left:none', m);
  m = T.declsOf('border-top:2px dashed #f00;border-bottom:double #000000 1.4pt');
  ok(m['border-top-width'] === '2px' && m['border-top-style'] === 'dashed' && m['border-top-color'] === '#f00'
    && m['border-bottom-style'] === 'double' && m['border-bottom-width'] === '1.4pt' && m['border-left-style'] === undefined, '한 변씩', m);
  m = T.declsOf('border:solid #000');
  ok(m['border-top-width'] === 'medium', '두께가 빠진 border → medium (CSS 처음값)', m);
  m = T.declsOf('border-width:1px 2px;border-style:solid none;border-color:#000 #fff #111');
  ok(m['border-top-width'] === '1px' && m['border-right-width'] === '2px' && m['border-bottom-width'] === '1px' && m['border-left-width'] === '2px'
    && m['border-top-style'] === 'solid' && m['border-left-style'] === 'none'
    && m['border-top-color'] === '#000' && m['border-right-color'] === '#fff' && m['border-bottom-color'] === '#111' && m['border-left-color'] === '#fff',
  'border-width/style/color 1~4값', m);
  m = T.declsOf('background:#FFFF00');
  ok(m['background-color'] === '#FFFF00', 'background:#FFFF00 → background-color', m);
  m = T.declsOf('background:#d9e2f3 none repeat scroll 0 0');
  ok(m['background-color'] === '#d9e2f3', 'background 에 색이 섞여 있으면 색만', m);
  m = T.declsOf('background:url(https://x.example/a.png) #fff');
  ok(m['background-color'] === undefined && !Object.values(m).some((v) => /url/i.test(v)), 'url 이 든 background 는 통째로 버린다', m);
  m = T.declsOf('text-decoration:underline line-through');
  ok(m['text-decoration-line'] === 'underline line-through', 'text-decoration → text-decoration-line', m);
  m = T.declsOf('white-space:nowrap;display:none;mso-hide:all');
  ok(m['text-wrap-mode'] === 'nowrap' && m.display === 'none' && m['mso-hide'] === 'all', 'white-space → text-wrap-mode (CSSOM 이 펴 주는 꼴과 같게), 나머지는 그대로', m);
}

console.log('\n[3] color');
{
  const cases = [
    ['#FFF', '#ffffff'], ['#FFFF00', '#ffff00'], ['windowtext', '#000000'], ['WindowText', '#000000'],
    ['rgb(255, 255, 0)', '#ffff00'], ['rgb(0,0,0)', '#000000'], ['rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.5)'], ['rgba(10,20,30,1)', '#0a141e'],
    ['rgba(0, 0, 0, 0)', ''], ['transparent', ''], ['auto', ''], ['inherit', ''], ['initial', ''], ['currentcolor', ''], ['none', ''],
    ['red', 'red'], ['Black', 'black'], ['url(x)', ''], ['expression(1)', ''], ['#12345', ''], ['#ggg', ''],
    ['javascript:alert(1)', ''], ['rgb(300, 0, 0)', ''], ['rgb(-1, 0, 0)', ''], ['"red"', ''], ['', ''], [null, ''], ['#ff0000; background:url(x)', '']
  ];
  for (const [v, want] of cases) ok(T.color(v) === want, `color(${JSON.stringify(v)}) → ${JSON.stringify(want)}`, T.color(v));
}

console.log('\n[4] px');
{
  const cases = [
    ['48pt', {}, '64px'], ['96pt', {}, '128px'], ['13.5pt', {}, '18px'], ['64', {}, '64px'], ['120px', {}, '120px'], ['2.54cm', {}, '96px'],
    ['150%', { pct: true }, '100%'], ['50%', { pct: true }, '50%'], ['50%', {}, ''], ['0', {}, ''], ['0px', {}, ''], ['auto', {}, ''],
    ['expression(1)', {}, ''], ['-5px', {}, ''], ['99999px', {}, '4000px'], ['1e3px', {}, ''], ['', {}, ''], ['12px 3px', {}, '']
  ];
  for (const [v, o, want] of cases) ok(T.px(v, o) === want, `px(${JSON.stringify(v)}, ${JSON.stringify(o)}) → ${JSON.stringify(want)}`, T.px(v, o));
}

console.log('\n[5] borderWidth · borderStyle · side');
{
  const w = [['.5pt', 1], ['0.5pt', 1], ['1pt', 1], ['1.0pt', 1], ['0.4pt', 1], ['1.4pt', 2], ['1.5pt', 2], ['2pt', 2], ['2.25pt', 3], ['3pt', 3], ['6pt', 3],
    ['1px', 1], ['0.5px', 1], ['2px', 2], ['5px', 3], ['thin', 1], ['medium', 3], ['thick', 3], ['initial', 3], ['', 3], ['0', 0], ['0pt', 0], ['0px', 0], ['url(x)', 0]];
  for (const [v, want] of w) ok(T.borderWidth(v) === want, `borderWidth(${JSON.stringify(v)}) → ${want}`, T.borderWidth(v));
  const s = [['solid', 'solid'], ['DASHED', 'dashed'], ['dotted', 'dotted'], ['double', 'double'], ['none', ''], ['hidden', ''],
    ['inset', 'solid'], ['outset', 'solid'], ['groove', 'solid'], ['ridge', 'solid'], ['windowtext', ''], ['', '']];
  for (const [v, want] of s) ok(T.borderStyle(v) === want, `borderStyle(${JSON.stringify(v)}) → ${JSON.stringify(want)}`, T.borderStyle(v));
  ok(T.side('.5pt', 'solid', 'windowtext') === '1px solid #000000', "side('.5pt','solid','windowtext') → 1px solid #000000", T.side('.5pt', 'solid', 'windowtext'));
  ok(T.side('1.5pt', 'solid', 'rgb(0, 0, 0)') === '2px solid #000000', '1.5pt → 2px', T.side('1.5pt', 'solid', 'rgb(0, 0, 0)'));
  ok(T.side('1.4pt', 'double', '#000000') === '2px double #000000', 'double 은 그대로', T.side('1.4pt', 'double', '#000000'));
  ok(T.side('1px', 'none', '#000') === '' && T.side('0', 'solid', '#000') === '' && T.side('1px', 'hidden', '#000') === '', 'none·hidden·0 → 없음');
  ok(T.side('1px', 'solid', 'initial', '#123456') === '1px solid #123456' && T.side('1px', 'solid', '') === '1px solid #000000', '색이 없으면 글자색, 그것도 없으면 #000000');
  ok(T.side('1px', 'solid', 'url(https://x.example/a)') === '1px solid #000000', '나쁜 색은 버리고 기본색');
}

console.log('\n[6] cellParts');
{
  // 엑셀 머리 칸 — CSSOM 이 펴 준 꼴 (td 규칙 + .xl65 + 인라인)
  const excel = {
    'border-top-width': '0.5pt', 'border-top-style': 'solid', 'border-top-color': 'windowtext',
    'border-right-width': '0.5pt', 'border-right-style': 'solid', 'border-right-color': 'windowtext',
    'border-bottom-width': '0.5pt', 'border-bottom-style': 'solid', 'border-bottom-color': 'windowtext',
    'border-left-width': '0.5pt', 'border-left-style': 'solid', 'border-left-color': 'windowtext',
    'border-image-source': 'initial', 'background-color': 'rgb(255, 255, 0)', 'background-image': 'initial',
    color: 'black', 'font-weight': '700', 'font-style': 'normal', 'text-decoration-line': 'none', 'text-align': 'center', 'vertical-align': 'middle',
    'text-wrap-mode': 'nowrap', 'white-space-collapse': 'collapse', 'font-family': '"맑은 고딕", monospace', 'font-size': '11pt',
    'padding-top': '1px', 'mso-number-format': 'General', height: '13.5pt', width: '48pt', position: 'absolute', 'margin-left': '3px'
  };
  let c = T.cellParts(excel, {});
  ok(T.styleText(c.parts) === 'border:1px solid #000000;background-color:#ffff00;color:black;text-align:center;vertical-align:middle;font-weight:bold;width:64px',
    '엑셀 머리 칸 → 허락한 것만 · 맞춘 꼴 · 정한 차례', T.styleText(c.parts));
  ok(c.visible === true && c.bg === '#ffff00' && c.nowrap === true && c.width === 64 && same(c.deco, []), '  visible · bg · nowrap(속성으로) · width', c);
  ok(!/font-family|font-size|height|padding|margin|mso|position|white-space|text-wrap/.test(T.styleText(c.parts)), '  글꼴·크기·높이·여백·mso·position·white-space 는 안 나간다');
  c = T.cellParts({ ...excel, 'border-left-style': 'none' }, {});
  ok(T.styleText(c.parts).startsWith('border-top:1px solid #000000;border-right:1px solid #000000;border-bottom:1px solid #000000;background-color'),
    '변이 다르면 변마다 (없는 변은 안 적는다)', T.styleText(c.parts));
  c = T.cellParts({ 'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none', 'border-top-width': 'initial' }, {});
  ok(c.visible === false && same(c.parts, []), 'border:none → 테두리 없음 (visible false)', c);
  c = T.cellParts({ 'font-weight': '400', 'font-style': 'normal', 'text-align': 'left' }, {});
  ok(same(c.parts, []), 'td 의 font-weight 400·font-style normal·text-align left 는 기본값이라 안 적는다 (크로미움 insertHTML 이 style 을 다시 쓰지 않게)', c.parts);
  c = T.cellParts({ 'font-weight': '400', 'text-align': 'left' }, { th: true });
  ok(T.styleText(c.parts) === 'text-align:left;font-weight:normal', 'th 는 거꾸로 — 기본이 굵게·가운데라 normal·left 를 적는다', T.styleText(c.parts));
  c = T.cellParts({ 'font-weight': 'bold' }, { th: true });
  ok(same(c.parts, []), 'th 의 bold 는 기본값', c.parts);
  c = T.cellParts({ 'text-align': 'general', 'vertical-align': 'super', 'font-weight': '"bold"', 'font-style': 'italic' }, {});
  ok(T.styleText(c.parts) === 'font-weight:bold;font-style:italic', 'general·super 는 버리고, 따옴표 친 "bold"(한글) 는 bold', T.styleText(c.parts));
  c = T.cellParts({ 'text-decoration-line': 'underline line-through' }, {});
  ok(same(c.deco, ['u', 's']) && same(c.parts, []), '밑줄·취소선 → <u>·<s> (style 의 text-decoration 은 insertHTML 이 text-decoration-line 으로 바꿔 버린다)', c);
  c = T.cellParts({ 'text-decoration': 'underline' }, {});
  ok(same(c.deco, ['u']), '  text-decoration 꼴도', c.deco);
  c = T.cellParts({ 'white-space': 'nowrap' }, {});
  ok(c.nowrap === true && same(c.parts, []), 'white-space:nowrap → nowrap 속성 (style 에는 안 적는다)', c);
  c = T.cellParts({ 'white-space': 'normal', 'text-wrap-mode': 'wrap' }, {});
  ok(c.nowrap === false, 'white-space:normal → 줄바꿈 함', c);
  c = T.cellParts({ 'border-top-width': '1pt', 'border-top-style': 'solid', color: '#336699' }, {});
  ok(T.styleText(c.parts) === 'border-top:1px solid #336699;color:#336699', '색 없는 테두리는 글자색', T.styleText(c.parts));
  c = T.cellParts({ 'background-color': 'rgba(0, 0, 0, 0.25)' }, {});
  ok(T.styleText(c.parts) === 'background-color:rgba(0, 0, 0, 0.25)' && c.bg === '', 'rgba 배경은 style 에만 (bgcolor 속성은 #hex 만)', c);
  c = T.cellParts({ width: '50%' }, {});
  ok(same(c.parts, []) && c.width === 0, '칸 너비 % 는 버린다', c);
}

console.log('\n[7] tableParts · inlineParts · blockParts · hidden');
{
  let t = T.tableParts({ width: '192pt' });
  ok(T.styleText(t.parts) === 'border-collapse:collapse;width:256px' && t.width === 256, '표 — border-collapse 는 늘, 너비 px', t);
  t = T.tableParts({ width: '150%' });
  ok(T.styleText(t.parts) === 'border-collapse:collapse;width:100%' && t.width === 0, '  % 는 100% 까지 (width 속성은 px 만)', t);
  t = T.tableParts({ width: '0px', 'font-family': 'Arial', 'table-layout': 'fixed', background: 'x' });
  ok(T.styleText(t.parts) === 'border-collapse:collapse', '  0px·글꼴·table-layout 은 버린다', T.styleText(t.parts));
  let i = T.inlineParts({ color: 'red', 'font-family': '"맑은 고딕"', 'font-size': '10pt', 'font-weight': '700', 'background-color': '#ffff00', 'font-style': 'italic', 'text-decoration-line': 'underline' });
  ok(T.styleText(i.parts) === 'font-weight:bold;font-style:italic;color:red;background-color:#ffff00' && same(i.deco, ['u']), '글자 꾸밈 — 굵기·기울임·색·배경, 밑줄은 <u>', i);
  i = T.inlineParts({ 'font-family': '"맑은 고딕"', 'font-size': '10pt' });
  ok(same(i.parts, []) && same(i.deco, []), '  글꼴·크기만 있는 span → 남길 것 없음 (껍데기를 벗긴다)', i);
  i = T.inlineParts({ 'font-weight': 'normal', 'font-style': 'normal' });
  ok(T.styleText(i.parts) === 'font-weight:normal;font-style:normal', '  글자 태그의 normal 은 남긴다 (굵은 칸 안의 보통 글자)', T.styleText(i.parts));
  const b = T.blockParts({ 'text-align': 'center', margin: '0cm', 'font-size': '10pt' });
  ok(T.styleText(b.parts) === 'text-align:center', '문단 — 가운데 맞춤만 (한글·워드는 칸 맞춤이 <p> 에 있다)', b);
  ok(T.hidden({ display: 'none' }) && T.hidden({ display: ' NONE ' }) && T.hidden({ 'mso-hide': 'all' }) && !T.hidden({ display: 'block' }) && !T.hidden({}),
    'hidden — display:none · mso-hide:all');
}

console.log('\n[8] span · widthAttr · href');
{
  ok(T.span('2') === 2 && T.span(' 3 ') === 3 && T.span('1') === 1, 'span — 정수');
  ok(T.span('0') === 0 && T.span('-1') === 0 && T.span('abc') === 0 && T.span('2.5') === 0 && T.span('') === 0 && T.span(null) === 0, '  0·음수·글자·소수 → 0 (안 적는다)');
  ok(T.span('5000') === 1000, '  1000 넘으면 1000', T.span('5000'));
  ok(T.widthAttr('64') === 64 && T.widthAttr('64px') === 64 && T.widthAttr('50%') === 0 && T.widthAttr('-1') === 0 && T.widthAttr('0') === 0 && T.widthAttr('9999') === 4000,
    'widthAttr — px 정수만, 4000 까지');
  const h = [['https://example.invalid/a', 'https://example.invalid/a'], [' http://example.invalid ', 'http://example.invalid'], ['mailto:a@example.invalid', 'mailto:a@example.invalid'],
    ['MAILTO:a@example.invalid', 'MAILTO:a@example.invalid'], ['javascript:alert(1)', ''], [' JaVaScRiPt:alert(1)', ''], ['java\tscript:alert(1)', ''], ['vbscript:x', ''],
    ['data:text/html,x', ''], ['//x.example/a', ''], ['/rel', ''], ['file:///C:/x', ''], ['', ''], [null, '']];
  for (const [v, want] of h) ok(T.href(v) === want, `href(${JSON.stringify(v)}) → ${JSON.stringify(want)}`, T.href(v));
}

console.log('\n[9] cssForSheet · stripCfHeader');
{
  const css = T.cssForSheet('<!--table {x:y}\n@import url(https://x.example/a.css);\n@import "b.css";\n.xl65 {color:red}\n-->');
  ok(!/@import|<!--|-->/.test(css) && /\.xl65 \{color:red\}/.test(css), '@import · <!-- --> 를 떼고 규칙은 그대로', css);
  const h = T.stripCfHeader('Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000291\r\nStartFragment:0000000141\r\nEndFragment:0000000255\r\n<html><body>x</body></html>');
  ok(h === '<html><body>x</body></html>', 'CF_HTML 머리를 뗀다', h);
  ok(T.stripCfHeader('<html>a</html>') === '<html>a</html>' && T.stripCfHeader('Versions of x <b>') === 'Versions of x <b>', '  머리가 없으면 그대로');
}

console.log('\n[10] tooBig · bigText · doneText');
{
  ok(T.MAX_CELLS === 2000 && T.MAX_HTML === 1000000, '한도 — 2000칸 · 100만 글자');
  ok(T.tooBig({ cells: 2001 }) && !T.tooBig({ cells: 2000, htmlLength: 1000000 }) && T.tooBig({ cells: 3, htmlLength: 1000001 }), 'tooBig');
  ok(T.bigText(2050) === '표가 커서 글로 붙였습니다 (2,050칸)', 'bigText', T.bigText(2050));
  ok(T.doneText({ tables: 1, rows: 3, cols: 4 }) === '표를 붙였습니다 (3×4)', 'doneText — 표 하나', T.doneText({ tables: 1, rows: 3, cols: 4 }));
  ok(T.doneText({ tables: 2, rows: 3, cols: 4 }) === '표 2개를 붙였습니다', 'doneText — 둘 이상', T.doneText({ tables: 2 }));
  // 테두리 없는 붙인 표와 «표» 단추로 넣는 새 표가 같은 옅은 회색 선 하나를 쓴다 (노션의 #dcdcd9 언저리)
  ok(T.LINE === '#dcdcd9' && T.GRID === `1px solid ${T.LINE}` && T.PAD === '4px 8px', '격자선·안쪽 여백 값 — 선 색은 새 표와 같은 LINE', { LINE: T.LINE, GRID: T.GRID });
}

console.log('\n[10b] blank — «표» 단추로 넣는 빈 표 (붙인 표와 같은 꼴·선)');
{
  ok(T.NEW_PAD === '6px 10px' && T.COL_W === 120, '새 표 — 안쪽 여백 6px 10px · 열 너비 120px', { pad: T.NEW_PAD, w: T.COL_W });
  const cell = `<td width="120" style="border:${T.GRID};width:120px;padding:6px 10px"><br></td>`;
  ok(T.blank(2, 3) === `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tbody><tr>${cell.repeat(3)}</tr><tr>${cell.repeat(3)}</tr></tbody></table>`,
    '2×3 — 칸마다 선·너비(속성과 style)·여백, 빈 칸은 <br>', T.blank(2, 3));
  ok(/width="80" style="[^"]*width:80px/.test(T.blank(1, 1, 80)), '너비를 주면 그 너비로', T.blank(1, 1, 80));
  ok((T.blank(0, 0).match(/<td/g) || []).length === 1 && (T.blank(99, 99).match(/<tr>/g) || []).length === 20 && (T.blank(1, 99).match(/<td/g) || []).length === 20,
    '줄·열은 1~20 으로 자른다');
}

console.log('\n[11] styleText · rowsText');
{
  ok(T.styleText([['a', 'b'], ['c', 'd']]) === 'a:b;c:d' && T.styleText([]) === '', 'styleText');
  ok(T.rowsText([['a', 'b'], ['c'], []]) === 'a\tb\nc\n', 'rowsText — 탭과 줄', JSON.stringify(T.rowsText([['a', 'b'], ['c'], []])));
}

console.log('\n[12] 나쁜 값 몰아넣기 — 나가는 글은 안전한 글자뿐');
{
  const evil = ['url(https://x.example/a)', 'expression(alert(1))', 'javascript:alert(1)', 'behavior:url(x)', '\\75 rl(x)', '"><img src=x onerror=alert(1)>',
    '</style><script>alert(1)</script>', 'red;background:url(x)', 'rgb(1,2,3) url(x)', '#fff\\', 'calc(1px + url(x))', 'var(--x)', 'attr(data-x)',
    'image-set("x" 1x)', '1px solid url(x)', '100px; position:fixed', '-webkit-calc(1px)', 'e\u0000xpression(1)', 'u\u200brl(x)'];
  const keys = ['color', 'background-color', 'width', 'text-align', 'vertical-align', 'font-weight', 'font-style', 'text-decoration-line', 'white-space',
    'border-top-width', 'border-top-style', 'border-top-color', 'display'];
  const SAFE = /^[a-z0-9#(),.%:;\s-]*$/;
  const outs = [];
  for (const v of evil) {
    const m = {};
    for (const k of keys) m[k] = v;
    for (const s of ['right', 'bottom', 'left']) { m[`border-${s}-width`] = v; m[`border-${s}-style`] = v; m[`border-${s}-color`] = v; }
    outs.push(T.styleText(T.cellParts(m, {}).parts), T.styleText(T.cellParts(m, { th: true }).parts), T.styleText(T.tableParts(m).parts),
      T.styleText(T.inlineParts(m).parts), T.styleText(T.blockParts(m).parts), T.color(v), T.px(v, { pct: true }), T.side(v, v, v), T.href(v),
      T.styleText(T.cellParts(T.declsOf(`color:${v};border:${v};background:${v};width:${v}`), {}).parts));
  }
  const badOut = outs.filter((s) => !SAFE.test(s) || /url|expression|script|behavior|import|attr|var\(|calc|image|position|\\/i.test(s));
  ok(!badOut.length, `${evil.length}가지 나쁜 값 × 모든 다듬개 → 나가는 글에 위험한 것이 없다`, badOut.slice(0, 4));
}

console.log('\n[13] 큰 표 미리 세기 · 숨긴 것 · 무게 (검토에서 나온 것)');
{
  // 아주 큰 표에 글도 왔으면 다듬지 않고 글로 — 그 전에 HTML 글자만으로 칸을 센다
  ok(typeof T.countCells === 'function' && T.countCells('<table><tr><td>a</td><TD x=1>b</TD><th>c</th></tr></table><p>td</p>') === 3, 'countCells — <td·<th 를 센다 (태그 이름만, 글자 «td» 는 안 센다)', T.countCells && T.countCells('<td>a</td><TD x=1>b</TD><th>c</th><p>td</p>'));
  // 엑셀은 <style> 에 늘 rt{display:none} 를 둔다 — 그건 숨긴 칸이 아니다. 숨긴 행·열은 style 속성에 온다
  ok(typeof T.mayHide === 'function' && !T.mayHide('<style>rt{display:none;}</style><table><tr><td>a</td></tr></table>'), 'mayHide — <style> 의 display:none 은 숨긴 칸이 아니다');
  ok(T.mayHide && T.mayHide("<tr height=0 style='display:none'><td>a</td></tr>") && T.mayHide('<td style="border-top:none;\r\n  display:none">b</td>') && T.mayHide("<span style='mso-hide:all'>x</span>"), '  style 속성의 display:none · mso-hide:all 은 숨긴 것');
  // 다듬은 표가 Gmail 의 102KB 잘림 언저리를 넘나 — UTF-8 바이트로 (한글은 3바이트)
  ok(typeof T.heavy === 'function' && !T.heavy('가'.repeat(30000)) && T.heavy('가'.repeat(40000)) && !T.heavy('a'.repeat(90000)) && T.heavy('a'.repeat(110000)), 'heavy — UTF-8 100KB 넘으면 무겁다 (한글 3바이트)');
  ok(typeof T.doneText === 'function' && /Gmail/.test(T.doneText({ rows: 3, cols: 2, heavy: true })) && T.doneText({ rows: 3, cols: 2 }) === '표를 붙였습니다 (3×2)', '  doneText — 무거우면 «Gmail 에서는 접혀 보일 수 있다» 를 덧붙인다', T.doneText({ rows: 3, cols: 2, heavy: true }));
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

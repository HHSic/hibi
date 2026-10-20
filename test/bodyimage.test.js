'use strict';
// «본문 그림»과 «첨부» 가르기 — 창을 하나도 안 띄운다 (node 로 돌려도 되고 npm test 로 돌려도 된다).
//
// 사용자 보고: 표에 붙어 있어야 할 그림이 «맨날 첨부파일처럼» 아래 첨부 칸에 깔렸다.
// 실측(Outlook «Microsoft Word 15» 메일 한 통): 그림 84장이 전부 image/jpeg · related · Content-ID,
// 그중 본문에 보이는 것은 42장뿐이고 나머지 42장은 주석 속 VML(<v:imagedata src="cid:…">)만 가리켰다.
// 진짜 첨부는 0개였다. 예전 판정(related·cid·Content-ID·disposition inline 중 하나면 본문 그림)은
//   · VML 짝까지 «본문 그림»으로 세고
//   · Outlook 이 Content-ID 를 달아 보낸 진짜 첨부(PDF)와 Apple Mail 의 inline PDF 를 본문 그림으로 숨겼다.
// 이제는 «본문에 실제로 그려지는가»(buildViewHtml 의 shown)를 먼저 보고 가른다 — 그 약속을 잰다.
//
// 여기 HTML·메일은 전부 그 꼴만 흉내 낸 지어낸 것이다 (진짜 메일의 글·주소·그림은 한 조각도 없다).
//   [1] visibleHtml — 주석·<style> 안은 «그려지지 않는 곳», Word 의 <![if !vml]> 사이는 그려지는 곳
//   [2] buildViewHtml — VML 주석 안의 cid 는 shown 도 아니고 data URL 로 채우지도 않는다. <!-- --> 로 싼 Word CSS 는 그대로.
//       못 그린 것(missed)·v:shapes 로 이어진 짝(twins)·화면이 안 그리는 자리(data-src·button·svg …)·열쇠 겹침(cid 가 이름을 이긴다)
//   [3] attachmentsForView — 본문 그림 / 첨부 / 같은 바이트 짝 빼기 / 이어진 짝 빼기(orig) / missed 는 첨부 /
//       번호 그대로 / dataUrl 규칙 그대로 / 이름 없는 그림은 «그림N.확장자» / «복사»가 실을 첨부(realAttachmentsOf)
//   [4] viewFromSource → viewPayload — 지어낸 .eml 원문 하나로 끝에서 끝까지 (서버에서 받든 백업 .eml 에서 읽든 이 길이다).
//       mailwin·composewin·mailhub 가 이 길을 쓰는지는 소스로 본다 (그 모듈들은 창을 띄운다)
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mail = require(path.join(ROOT, 'src', 'mail.js'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 그림 바이트 — 내용은 상관없고 «같은가 다른가»만 본다
const bytes = (tag, n = 64) => Buffer.from(tag.repeat(Math.ceil(n / tag.length)).slice(0, n));
const IMG_A = bytes('A');
const IMG_B = bytes('B');
const IMG_C = bytes('C');

/** mailparser 가 주는 첨부 꼴 그대로 */
const att = (o) => ({
  contentType: 'image/jpeg', related: false, contentDisposition: undefined,
  cid: undefined, contentId: undefined, filename: undefined, ...o,
  size: (o.content || Buffer.alloc(0)).length
});
const cidAtt = (name, content, extra = {}) => att({
  filename: name, content, related: true,
  cid: `${name}@01DB0000.00000000`, contentId: `<${name}@01DB0000.00000000>`, ...extra
});

// Word(Outlook) 메일의 뼈대 — CSS 를 <!-- --> 로 싸고, 그림을 VML(주석 안)과 <img>(<![if !vml]> 사이)로 두 번 싣는다
const WORD_STYLE = '<style><!--\n p.MsoNormal{margin:0cm;font-size:10.0pt}\n'
  + ' li{mso-level-number-position:left}\n--></style>';
// Word 는 모양마다 id 를 따로 단다 (그림_x0020_1, 그림_x0020_2 …) — 보이는 <img> 의 v:shapes 가 그 id 를 가리킨다
const floatCell = (vmlName, imgName, shapeId = '그림_x0020_1') => '<td><p class=MsoNormal>'
  + `<!--[if gte vml 1]><v:shape id="${shapeId}" o:spid="_x0000_s1026" type="#_x0000_t75" style='position:absolute;width:300pt;height:200pt'>`
  + `<v:imagedata src="cid:${vmlName}@01DB0000.00000000" o:title=""/></v:shape><![endif]-->`
  + '<![if !vml]><span style=\'mso-ignore:vglayout;position:absolute;z-index:251636736;'
  + 'margin-left:5px;margin-top:6px;width:400px;height:266px\'>'
  + `<img width=400 height=266 src="cid:${imgName}@01DB0000.00000000" v:shapes="${shapeId}"></span>`
  + '<![endif]>설명</p></td>';
const wordHtml = (cells) => `<html><head>${WORD_STYLE}</head><body><table><tr>${cells.join('')}</tr></table></body></html>`;

console.log('\n[1] visibleHtml — 브라우저가 그리는 부분만 남기는가');
{
  const v = mail.visibleHtml;
  ok(!/cid:a/.test(v('<p>x</p><!-- <img src="cid:a"> --><p>y</p>')), '주석 안은 뺀다');
  ok(/<p>y<\/p>/.test(v('<p>x</p><!-- <img src="cid:a"> --><p>y</p>')), '  주석 뒤는 남긴다');
  ok(!/cid:a/.test(v('<style>.a{}/* src="cid:a" */</style><p>y</p>')), '<style> 안은 뺀다');
  ok(/cid:b/.test(v('<style><!-- .a{color:red} --></style><img src="cid:b">')),
    '  <style> 안의 <!-- --> 는 주석이 아니다 — 뒤의 그림을 삼키지 않는다');
  ok(/cid:b/.test(v('<!-- <style> --><img src="cid:b">')), '  주석 안의 <style> 은 꾸밈이 아니다 — 뒤의 그림을 삼키지 않는다');
  ok(/cid:b/.test(v('<![if !vml]><img src="cid:b"><![endif]>')), 'Word 의 <![if !vml]> … <![endif]> 사이는 그려지는 곳이다');
  ok(!/cid:a/.test(v('<p>x</p><!-- 안 닫은 주석 <img src="cid:a">')), '안 닫은 주석은 끝까지 주석이다 (브라우저와 같게)');
  ok(/cid:b/.test(v('<!--><img src="cid:b"><!-- x -->')), '  <!--> 는 빈 주석이다 — 뒤를 삼키지 않는다');
  ok(!/cid:a/.test(v('<SCRIPT>var s="<img src=cid:a>"</SCRIPT>')) && !/cid:a/.test(v('<template><img src="cid:a"></template>')),
    '<script>·<template> 안도 뺀다 (대소문자 상관없이)');
}

console.log('\n[2] buildViewHtml — 본문에 그려지는 것만 shown 으로 센다');
{
  // 칸 둘: 칸마다 VML 이 001/003, <img> 가 002/004 를 가리킨다 (Word 가 실제로 이렇게 번호를 붙인다)
  const list = [cidAtt('image001.png', IMG_A), cidAtt('image002.jpg', IMG_B),
    cidAtt('image003.png', IMG_C), cidAtt('image004.jpg', IMG_B)];
  const html = wordHtml([floatCell('image001.png', 'image002.jpg', '그림_x0020_1'),
    floatCell('image003.png', 'image004.jpg', '그림_x0020_2')]);
  const v = mail.buildViewHtml({ html, attachments: list }, { allowRemote: false });
  ok(JSON.stringify(v.shown) === '[1,3]', 'VML(주석) 만 가리키는 그림은 shown 이 아니다 — <img> 가 가리키는 것만', v.shown);
  ok((v.html.match(/<img[^>]+src="data:image\/jpeg;base64,/g) || []).length === 2, '  본문 <img> 둘은 data URL 로 바뀐다');
  ok(/p\.MsoNormal\{margin:0cm;font-size:10\.0pt\}/.test(v.html) && /<style><!--/.test(v.html),
    '<!-- --> 로 싼 Word CSS 는 그대로 남는다 (그리는 HTML 에서는 아무것도 안 지운다)');
  ok(v.blockedRemote === 0, '  인터넷 그림 막기 숫자는 그대로 (0)', v.blockedRemote);
  // 주석 속 VML 의 cid 는 data URL 로 채우지 않는다 — 안 그려질 바이트가 창과 답장·전달 인용문까지 가던 것
  // (실측 — 만든 HTML 2746KB 중 주석 속이 2060KB, data URL 42개. 인용문 상한을 넘겨 HTML 인용이 글 인용으로 물러났다)
  const comments = (v.html.match(/<!--[\s\S]*?-->/g) || []).join('');
  ok(!/data:image/.test(comments) && (comments.match(/cid:image00[13]\.png/g) || []).length === 2,
    '주석 속 VML 의 cid 는 그대로 둔다 — 주석 안 data URL 0개', { dataInComments: (comments.match(/data:image/g) || []).length });
  {
    // 큰 그림으로 재 보면 차이가 크기로 보인다 — VML 짝 바이트가 HTML 에 안 실린다
    const bigA = Buffer.alloc(600 * 1024, 3);
    const bigB = Buffer.alloc(200 * 1024, 4);
    const sized = mail.buildViewHtml({ html: wordHtml([floatCell('image001.png', 'image002.jpg')]),
      attachments: [cidAtt('image001.png', bigA), cidAtt('image002.jpg', bigB)] });
    const kb = Math.round(sized.html.length / 1024);
    ok(kb < 300, `  VML 원본(600KB)은 HTML 에 안 실린다 — 본문 그림(200KB)만, HTML ${kb}KB`, kb);
  }
  // Word 가 v:shapes 로 이어 둔 짝 — 주석 속 <v:shape id=X> 의 원본(A) ↔ 보이는 <img v:shapes="X">(B)
  ok(JSON.stringify(v.twins) === '{"0":1,"2":3}', 'v:shapes 로 이어진 짝을 찾는다 — { VML 원본: 본문 <img> }', v.twins);
  ok(JSON.stringify(v.missed) === '[]', '  본문이 가리켰는데 못 그린 것은 없다', v.missed);

  // 열쇠 맞추기 — 바꿔 넣는 것과 같은 규칙: 꺾쇠·대소문자·파일 이름
  const keys = [
    att({ filename: 'photo.png', content: IMG_A, contentType: 'image/png', related: true }),
    att({ contentId: '<IMAGE005.PNG@X>', cid: 'IMAGE005.PNG@X', content: IMG_B, contentType: 'image/png', related: true })
  ];
  const k = mail.buildViewHtml({ html: '<p><img src="cid:photo.png"><img src=\'cid:image005.png@x\'></p>', attachments: keys });
  ok(JSON.stringify(k.shown) === '[0,1]', '파일 이름·Content-ID(꺾쇠·대문자)로 가리켜도 shown 이다', k.shown);

  // 그려지지 않는 자리들
  const hid = [cidAtt('a.png', IMG_A), cidAtt('b.png', IMG_B), cidAtt('c.png', IMG_C)];
  const h = mail.buildViewHtml({
    html: '<style>/* <img src="cid:a.png@01DB0000.00000000"> */</style>'
      + '<!-- <img src="cid:b.png@01DB0000.00000000"> -->'
      + '<p style="background:url(cid:c.png@01DB0000.00000000)">x</p>',
    attachments: hid
  });
  ok(JSON.stringify(h.shown) === '[]', '<style> 안 · 주석 안 · CSS url(cid:) 은 그려지지 않는다 — shown 이 비어 있다', h.shown);
  ok(JSON.stringify(h.missed) === '[2]', '  보이는 곳의 url(cid:) 은 «가리켰지만 못 그린 것»(missed)이다 — <style>·주석 속 것은 아니다', h.missed);

  // 그림이 아니거나 너무 큰 것은 바꿔 넣지 않으니(본문에서 지워진다) shown 도 아니다 — 대신 missed 다
  const big = Buffer.alloc(3 * 1024 * 1024 + 1, 1);
  const nb = mail.buildViewHtml({
    html: '<img src="cid:big.jpg@01DB0000.00000000"><img src="cid:doc.pdf@01DB0000.00000000">',
    attachments: [cidAtt('big.jpg', big), cidAtt('doc.pdf', IMG_A, { contentType: 'application/pdf' })]
  });
  ok(JSON.stringify(nb.shown) === '[]', '3MB 넘는 그림·그림 아닌 것을 가리키면 shown 이 아니다 (본문에서 지워진다)', nb.shown);
  ok(JSON.stringify(nb.missed) === '[0,1]', '  그 둘은 missed — 본문이 그리려다 못 그린 것', nb.missed);
  ok(JSON.stringify(mail.buildViewHtml({ html: '', attachments: hid }).shown) === '[]', '  본문이 없으면 shown 은 빈 배열');

  // 가리키는 꼴 — 따옴표 없는 src, %인코딩한 cid (RFC 2392 꼴). 바꿔 넣는 것도 같이 된다
  const forms = [att({ cid: 'a@1', content: IMG_A, contentType: 'image/png', related: true }),
    att({ cid: 'image001.png@01DB.0', content: IMG_B, contentType: 'image/png', related: true })];
  const fv = mail.buildViewHtml({ html: '<p><img src=cid:a@1 alt=x><img src="cid:image001.png%4001DB.0"></p>', attachments: forms });
  ok(JSON.stringify(fv.shown) === '[0,1]' && (fv.html.match(/src="data:image\/png;base64,/g) || []).length === 2,
    '따옴표 없는 src=cid:… · %인코딩한 cid:…%40… 도 그림이 제자리에 들어가고 shown 이다', fv.shown);

  // 화면이 안 그리는 자리 — 속성 이름의 끝부분(data-src), 세정기가 안쪽째 버리는 태그(button·select·svg), <input type=image>
  const one = [att({ cid: 'a@1', filename: 'a.png', content: IMG_A, contentType: 'image/png', contentDisposition: 'attachment' })];
  const notDrawn = [
    ['<img data-src="cid:a@1">', '[]', '[]'],
    ['<button><img src="cid:a@1"></button>', '[]', '[]'],
    ['<select><option>x<img src="cid:a@1"></option></select>', '[]', '[]'],
    ['<svg><image src="cid:a@1"/></svg>', '[]', '[]'],
    ['<input type=image src="cid:a@1">', '[]', '[0]'],
    ['<td background="cid:a@1">x</td>', '[]', '[0]']
  ];
  for (const [h0, wantShown, wantMissed] of notDrawn) {
    const r = mail.buildViewHtml({ html: `<p>글</p>${h0}<p>끝</p>`, attachments: one });
    const kinds = mail.attachmentsForView(one, r.shown, { missed: r.missed, twins: r.twins });
    ok(JSON.stringify(r.shown) === wantShown && JSON.stringify(r.missed) === wantMissed && kinds[0] && !kinds[0].inline,
      `${h0} → 그려지지 않는다 — 진짜 첨부는 «첨부»로 남는다`, { shown: r.shown, missed: r.missed, inline: kinds[0] && kinds[0].inline });
  }
  // 스스로 닫은 <svg/> 는 안을 품지 않는다 — 그 뒤를 삼키면 뒤 그림이 본문에서 사라진다 (브라우저는 그린다)
  const after = mail.buildViewHtml({ html: '<p><svg width="9"/>x</p><p><img src="cid:a@1"></p><svg></svg>', attachments: one });
  ok(/<img src="data:image\/png;base64,/.test(after.html) && JSON.stringify(after.shown) === '[0]',
    '  <svg/> 뒤의 그림도 제자리에 들어가고 shown 이다', { shown: after.shown });

  // 열쇠 겹침 — 진짜 첨부의 파일 이름이 본문 그림의 cid 와 같을 때 (cid 를 파일 이름 그대로 쓰는 발송기)
  for (const [label, list2, want] of [
    ['본문 그림이 앞', [att({ cid: 'photo.jpg', filename: 'photo.jpg', content: IMG_A, related: true }),
      att({ filename: 'photo.jpg', content: IMG_B, contentDisposition: 'attachment' })], 0],
    ['진짜 첨부가 앞', [att({ filename: 'photo.jpg', content: IMG_B, contentDisposition: 'attachment' }),
      att({ cid: 'photo.jpg', filename: 'photo.jpg', content: IMG_A, related: true })], 1]
  ]) {
    const r = mail.buildViewHtml({ html: '<p><img src="cid:photo.jpg"></p>', attachments: list2 });
    const kinds = mail.attachmentsForView(list2, r.shown, { missed: r.missed, twins: r.twins });
    const real = kinds.find((k) => k.index !== want);
    ok(JSON.stringify(r.shown) === `[${want}]` && r.html.includes(IMG_A.toString('base64')) && !r.html.includes(IMG_B.toString('base64'))
      && real && !real.inline,
    `${label}: cid 가 파일 이름을 이긴다 — 본문엔 related 그림, 같은 이름의 진짜 첨부는 «첨부»`, { shown: r.shown, real: real && real.inline });
  }
}

console.log('\n[3] attachmentsForView — 본문 그림 / 첨부');
{
  const big = Buffer.alloc(3 * 1024 * 1024 + 1, 7);
  const list = [
    /* 0 */ cidAtt('image001.png', IMG_A),                                     // VML 짝, 바이트 다름 → 본문 그림(dup)
    /* 1 */ cidAtt('image002.jpg', IMG_B),                                     // 본문에 그려짐 → 본문 그림
    /* 2 */ cidAtt('image003.png', IMG_B),                                     // VML 짝, 1 과 같은 바이트 → 목록에서 뺀다
    /* 3 */ att({ filename: 'report.pdf', contentType: 'application/pdf', content: IMG_C,   // Outlook 첨부 + Content-ID
      contentDisposition: 'attachment', cid: 'report.pdf@x', contentId: '<report.pdf@x>' }),
    /* 4 */ att({ filename: 'scan.pdf', contentType: 'application/pdf', content: IMG_A,     // Apple Mail inline PDF
      contentDisposition: 'inline' }),
    /* 5 */ att({ filename: 'shot.png', contentType: 'image/png', content: IMG_C,           // Outlook 그림 첨부 + Content-ID
      contentDisposition: 'attachment', cid: 'shot.png@x', contentId: '<shot.png@x>', related: true }),
    /* 6 */ att({ filename: 'photo.jpg', content: IMG_A, contentDisposition: 'inline' }),   // Apple Mail inline 그림 (안 가리킴)
    /* 7 */ att({ filename: 'huge.jpg', content: big, contentDisposition: 'attachment' }),  // 큰 그림 첨부
    /* 8 */ cidAtt('image009.png', IMG_C),                                      // VML 짝끼리 같은 바이트 — 앞의 0 과는 다름
    /* 9 */ cidAtt('image010.png', IMG_C),                                      //   → 8 은 남고 9 는 뺀다
    /* 10 */ att({ filename: 'notes.txt', contentType: 'text/plain', content: IMG_A })     // 그냥 첨부
  ];
  const shown = [1];
  const v = mail.attachmentsForView(list, shown);
  const by = Object.fromEntries(v.map((a) => [a.index, a]));

  ok(by[1] && by[1].inline && !by[1].dup && by[1].dataUrl === null, '본문에 그려진 related 그림 → 본문 그림 (dataUrl 없음)', by[1]);
  ok(by[0] && by[0].inline && by[0].dup === true, 'VML 짝 · 바이트 다름 → 본문 그림 (dup)', by[0]);
  ok(!by[2], 'VML 짝 · 본문 그림과 같은 바이트 → 목록에서 뺀다');
  ok(by[8] && by[8].dup && !by[9], 'VML 짝끼리 같은 바이트 → 앞의 것만 남는다');
  ok(by[3] && !by[3].inline && by[3].dataUrl === null, 'Outlook PDF (Content-ID · disposition attachment) → 첨부', by[3]);
  ok(by[4] && !by[4].inline, 'Apple Mail inline PDF (본문이 안 가리킴) → 첨부', by[4]);
  ok(by[5] && !by[5].inline && /^data:image\/png;base64,/.test(by[5].dataUrl || ''),
    'Outlook 그림 첨부 (related 여도 disposition attachment · 안 그려짐) → 첨부 + 작은 그림(dataUrl)', by[5] && by[5].inline);
  ok(by[6] && !by[6].inline && /^data:image\/jpeg;base64,/.test(by[6].dataUrl || ''),
    'Apple Mail inline 그림 (related 아님 · 안 가리킴) → 첨부 + dataUrl', by[6] && by[6].inline);
  ok(by[7] && !by[7].inline && by[7].dataUrl === null, '  3MB 넘는 그림 첨부는 dataUrl 없음 (전과 같다)', by[7] && by[7].dataUrl);
  ok(by[10] && !by[10].inline && by[10].dataUrl === null, '  그림 아닌 첨부는 dataUrl 없음');
  ok(v.every((a) => list[a.index] && a.size === list[a.index].content.length
      && a.contentType === String(list[a.index].contentType).toLowerCase()),
    'index 는 원래 첨부 배열의 번호다 (뺀 것이 있어도 밀리지 않는다)', v.map((a) => a.index));
  ok(JSON.stringify(v.map((a) => a.index)) === '[0,1,3,4,5,6,7,8,10]', '  목록 순서는 원래 순서 그대로', v.map((a) => a.index));
  ok(v.every((a) => ['index', 'filename', 'size', 'contentType', 'inline', 'dataUrl'].every((k) => k in a)),
    '  예전 칸(index·filename·size·contentType·inline·dataUrl)은 그대로 있다');
  ok(!('content' in v[0]), '  원본 바이트는 화면으로 안 간다');
  ok(v.filter((a) => a.inline).length === 3 && v.filter((a) => !a.inline).length === 6,
    '본문 그림 3 · 첨부 6', { inline: v.filter((a) => a.inline).length, files: v.filter((a) => !a.inline).length });

  // Set 으로 줘도 같다
  ok(JSON.stringify(mail.attachmentsForView(list, new Set([1]))) === JSON.stringify(v), 'shown 을 Set 으로 줘도 같다');

  // shown 을 모를 때(예전 부르는 곳) — 짝을 가리지 않는다. related 그림은 본문 그림, 나머지는 첨부
  const legacy = mail.attachmentsForView(list);
  ok(legacy.length === list.length && legacy.every((a) => a.dup === false), 'shown 을 안 주면 짝(dup)을 가리지 않고 아무것도 안 뺀다');
  ok(legacy[1].inline && legacy[0].inline && !legacy[3].inline && !legacy[4].inline, '  그때도 Content-ID·inline PDF 는 첨부');

  // 빈 것
  ok(JSON.stringify(mail.attachmentsForView([], [])) === '[]' && JSON.stringify(mail.attachmentsForView(null)) === '[]',
    '첨부가 없으면 빈 목록');

  // 본문이 가리켰지만 못 그린 것(missed) — 짝이 아니라 «첨부». 예전엔 «본문에는 따로 안 보이는 짝»으로 접혀 어디에도 안 보였다
  const huge = cidAtt('image001.png', big, { filename: undefined, contentType: 'image/png' });   // Outlook 에 붙여 넣은 3MB 넘는 화면 캡처
  const bg = cidAtt('bg.png', IMG_A, { contentType: 'image/png' });
  const vb = mail.buildViewHtml({
    html: '<p><img src="cid:image001.png@01DB0000.00000000"></p><table><tr><td background="cid:bg.png@01DB0000.00000000">x</td></tr></table>',
    attachments: [huge, bg]
  });
  const vm = mail.attachmentsForView([huge, bg], vb.shown, { missed: vb.missed, twins: vb.twins });
  ok(JSON.stringify(vb.missed) === '[0,1]' && vm.length === 2 && vm.every((a) => !a.inline && !a.dup),
    '3MB 넘는 본문 그림 · background="cid:" 그림 → «첨부» (짝으로 접지 않는다)', vm.map((a) => [a.index, a.inline, a.dup]));
  ok(vm[1].dataUrl && !vm[0].dataUrl, '  작은 쪽은 작은 그림(dataUrl)도, 3MB 넘는 쪽은 없음 (전과 같다)');
  // 이름 없는 그림은 크기와 상관없이 «그림N.확장자» — 본문 그림을 «첨부»라 부르지 않는다
  ok(vm[0].filename === '그림1.png', '이름 없는 3MB 넘는 그림의 이름은 «그림1.png» (예전 «첨부1»)', vm[0].filename);
  ok(mail.attachmentName({ contentType: 'image/jpeg' }, 4) === '그림5.jpg'
    && mail.attachmentName({ contentType: 'application/pdf' }, 2) === '첨부3'
    && mail.attachmentName({ contentType: 'image/x-unknown' }, 0) === '그림1'
    && mail.attachmentName({ filename: 'a.pdf', contentType: 'image/png' }, 0) === 'a.pdf',
  '  attachmentName — 그림N.jpg · 첨부N · 모르는 그림 형식은 확장자 없이 · 이름이 있으면 그 이름');

  // Word 가 v:shapes 로 이어 둔 짝 — 바이트가 달라도 같은 그림이다. 목록에는 본문 쪽 하나만, 원본은 orig 로
  // (실측 — 짝 42장이 전부 본문 쪽과 다른 큰 그림이라 «본문 그림 84개»가 됐다. 본문에 보이는 것은 42장)
  const cells = [];
  const wlist = [];
  for (let n = 0; n < 3; n++) {
    const vml = `image${String(2 * n + 1).padStart(3, '0')}.png`;
    const pic = `image${String(2 * n + 2).padStart(3, '0')}.jpg`;
    cells.push(floatCell(vml, pic, `그림_x0020_${n + 1}`));
    wlist.push(cidAtt(vml, bytes(`orig-${n}`, 900)), cidAtt(pic, bytes(`shown-${n}`, 300)));
  }
  const wv = mail.buildViewHtml({ html: wordHtml(cells), attachments: wlist });
  const wl = mail.attachmentsForView(wlist, wv.shown, { missed: wv.missed, twins: wv.twins });
  ok(JSON.stringify(wv.shown) === '[1,3,5]' && wl.length === 3 && wl.every((a) => a.inline && !a.dup),
    'v:shapes 로 이어진 짝 셋 → 목록은 본문에 보이는 셋뿐 (본문 그림 3개)', wl.map((a) => [a.index, a.dup]));
  ok(JSON.stringify(wl.map((a) => [a.index, a.orig])) === '[[1,0],[3,2],[5,4]]',
    '  본문 쪽 칸에 원본(VML)의 번호가 orig 로 달린다 — 원래 첨부 번호 그대로', wl.map((a) => [a.index, a.orig]));
  // 이어지지 않은 짝(바이트 다름)은 예전처럼 dup 으로 남는다 — 위 list 의 0번
  ok(!('orig' in by[1]), '  이어진 짝이 없으면 orig 칸이 없다');

  // «복사(다시 쓰기)»가 실을 첨부 — 보기 창의 «첨부»와 같은 것
  const carry = mail.realAttachmentsOf(list, shown);
  const viewFiles = v.filter((a) => !a.inline).map((a) => list[a.index]).filter((a) => a.filename);
  ok(carry.length === viewFiles.length && carry.every((a, k) => a === viewFiles[k]),
    'realAttachmentsOf = 보기 창이 «첨부»로 보여 주는 것 (inline PDF·related 여도 disposition attachment 인 그림·안 가리킨 inline 그림 포함)',
    carry.map((a) => a.filename));
  ok(carry.some((a) => a.filename === 'scan.pdf') && carry.some((a) => a.filename === 'shot.png')
    && carry.some((a) => a.filename === 'photo.jpg') && !carry.some((a) => a.filename === 'image002.jpg'),
  '  scan.pdf · shot.png · photo.jpg 는 싣고, 본문에 그려진 image002 는 안 싣는다 (본문에 이미 있다)');
  const nonRel = [att({ filename: 'nonrel.png', cid: 'nr@1', contentType: 'image/png', content: IMG_A }),
    att({ filename: 'notes.txt', contentType: 'text/plain', content: IMG_B, contentDisposition: 'attachment' })];
  const nr = mail.buildViewHtml({ html: '<img src="cid:nr@1">', attachments: nonRel });
  ok(JSON.stringify(mail.realAttachmentsOf(nonRel, nr.shown, nr).map((a) => a.filename)) === '["notes.txt"]',
    '  related 가 아니어도 본문에 그려진 그림은 복사본에 두 번 싣지 않는다');
}

console.log('\n[4] viewFromSource — 지어낸 Outlook 꼴 .eml 하나로 끝에서 끝까지');
(async () => {
  const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
  const html = wordHtml([floatCell('image001.png', 'image002.jpg')]);
  const eml = [
    'From: "Sender" <sender@example.invalid>',
    'To: <me@example.invalid>',
    'Subject: synthetic',
    'Date: Tue, 20 Oct 2026 13:13:00 +0900',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/related; boundary="REL"; type="text/html"',
    '',
    '--REL',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from(html, 'utf8')),
    '--REL',
    'Content-Type: image/png; name="image001.png"',
    'Content-ID: <image001.png@01DB0000.00000000>',
    'Content-Transfer-Encoding: base64',
    '',
    b64(IMG_A),
    '--REL',
    'Content-Type: image/jpeg; name="image002.jpg"',
    'Content-ID: <image002.jpg@01DB0000.00000000>',
    'Content-Transfer-Encoding: base64',
    '',
    b64(IMG_B),
    '--REL--',
    '',
    '--MIX',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-ID: <report.pdf@01DB0000.00000000>',
    'Content-Transfer-Encoding: base64',
    '',
    b64(IMG_C),
    '--MIX--',
    ''
  ].join('\r\n');

  const view = await mail.viewFromSource(Buffer.from(eml), { allowRemote: false });
  const names = (view.attachments || []).map((a) => a.filename);
  ok(JSON.stringify(names) === '["image001.png","image002.jpg","report.pdf"]', 'mailparser 가 첨부 셋을 그 순서로 준다', names);
  ok(JSON.stringify(view.shown) === '[1]', 'view.shown — <img> 가 가리킨 image002 만', view.shown);
  ok(JSON.stringify(view.twins) === '{"0":1}' && JSON.stringify(view.missed) === '[]', 'view.twins — image001(VML) 은 image002 의 원본', view.twins);
  ok(/<img[^>]+src="data:image\/jpeg;base64,/.test(view.html) && /<style><!--/.test(view.html), '  본문 그림은 제자리에, Word CSS 도 그대로');

  // 보기 창에 넘기는 꼴 — mailwin 이 부르는 그 함수(viewPayload)로 만든다
  const payload = mail.viewPayload(view, { accountId: 'acc-x', fromSelf: false, seen: true });
  const list = payload.attachments;
  const pick = (n) => list.find((a) => a.filename === n);
  ok(!('source' in payload) && !('shown' in payload) && !('missed' in payload) && !('twins' in payload),
    'viewPayload — 원문 버퍼와 본문 그림 번호(shown·missed·twins)는 화면으로 안 간다');
  ok(payload.accountId === 'acc-x' && payload.seen === true && payload.subject === 'synthetic' && payload.html === view.html,
    '  창이 더 알아야 할 것(accountId·seen)은 얹고, 나머지는 그대로');
  ok(list.every((a) => !('content' in a)), '  첨부 바이트는 화면으로 안 간다');
  ok(pick('image002.jpg') && pick('image002.jpg').inline && !pick('image002.jpg').dup && pick('image002.jpg').orig === 0,
    '  image002 → 본문 그림, 원본(image001)의 번호를 orig 로');
  ok(!pick('image001.png'), '  image001 (v:shapes 로 이어진 VML 원본) → 목록에서 빠진다 — 본문 그림 1개');
  ok(pick('report.pdf') && !pick('report.pdf').inline, '  report.pdf (Content-ID 가 있어도) → 첨부');
  ok(list.length === 2, '  목록은 둘 (본문 그림 1 · 첨부 1)', list.map((a) => a.filename));

  // mailwin 이 실제로 이 길을 쓰는가 — 창을 띄우는 모듈이라 소스로 본다 (shown 을 안 넘기면 짝 표시·빼기가 사라진다)
  const fs = require('fs');
  const winSrc = fs.readFileSync(path.join(ROOT, 'src', 'mailwin.js'), 'utf8');
  ok(/slot\.payload = mail\.viewPayload\(m, \{/.test(winSrc) && !/attachmentsForView\(/.test(winSrc),
    'mailwin.js 는 mail.viewPayload(m, …) 로 화면 꼴을 만든다 (attachmentsForView 를 따로 부르지 않는다)');
  // «복사»도 보기 창과 같은 판정으로 — 보기 창에서는 화면 목록의 «첨부», 목록 메뉴에서는 realAttachmentsOf
  const composeSrc = fs.readFileSync(path.join(ROOT, 'src', 'composewin.js'), 'utf8');
  const hubSrc = fs.readFileSync(path.join(ROOT, 'src', 'mailhub.js'), 'utf8');
  ok(/files: \(v\.attachments \|\| \[\]\)\.filter\(\(a\) => !a\.inline\)\.map\(\(a\) => slot\.files\[a\.index\]\)/.test(composeSrc)
    && /files: mail\.realAttachmentsOf\(m\.attachments, m\.shown, \{ missed: m\.missed, twins: m\.twins \}\)/.test(hubSrc)
    && !/a\.related|contentDisposition !== 'inline'/.test(composeSrc),
  '«복사»(보기 창·목록 메뉴)는 보기 창과 같은 판정으로 첨부를 고른다 — 옛 기준(related·disposition inline)은 없다');
  // 목록 메뉴의 «복사»가 실을 것 = 보기 창의 «첨부»
  const carried = mail.realAttachmentsOf(view.attachments, view.shown, view);
  ok(JSON.stringify(carried.map((a) => a.filename)) === JSON.stringify(list.filter((a) => !a.inline).map((a) => a.filename)),
    '  같은 메일에서 «복사»가 실을 첨부 = 보기 창의 «첨부» (report.pdf)', carried.map((a) => a.filename));

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });

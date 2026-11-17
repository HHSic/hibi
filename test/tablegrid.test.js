'use strict';
// 지킴이 — 무엇보다 먼저. npm test 는 이 파일도 Electron 으로 돌린다: 처음 불러오다 터지면 Electron 이 오류 창을 띄우고 멈춘다.
// 터지면 오류 창 없이 실패로 끝낸다 (node 로 돌리면 require('electron') 은 경로 글자라 app·dialog 가 없다)
process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); try { require('electron').app.exit(1); } catch { process.exit(1); } });
{ const E = require('electron'); if (E && typeof E === 'object' && E.dialog) E.dialog.showErrorBox = () => {}; }
// 표 편집 — 칸 지도 셈(renderer/tablegrid.js)을 본다. 창을 하나도 안 띄운다 (node 로 돌려도 되고 npm test 로 돌려도 된다).
// 진짜 쓰기 창에서 손잡이·메뉴·끌어 고르기를 해 보는 것은 tableedit.test.js.
//
// 사용자: «노션의 표만들기 같은 것», «칸 합치기». 표는 합친 칸(rowspan·colspan)이 있으면 줄마다 칸 수가 달라서,
// 행·열을 넣고 빼려면 먼저 «칸 지도»(어느 자리를 어느 칸이 차지하나)를 펴야 한다:
//   [1] tidy — 지도 펴기: 합친 칸, 들쭉날쭉한 줄(빈 자리는 칸을 채운다), 겹치는 합침(자른다), 구역(thead·tbody) 끝에서 자르는 rowspan, rowspan=0
//   [2] toHtml — 다시 HTML 로 (빈 칸은 <br>, 속성 값은 이스케이프, on* 속성은 안 쓴다, 표시 속성은 맨 앞)
//   [3] insertRow — 합친 칸을 지나면 그 칸을 늘린다, 새 칸은 이웃 칸의 스타일만 (내용은 아니다), 머리글 아래면 머리글 채움은 빼고,
//       머리글 위면 머리글이 새 첫 줄로 옮긴다, thead 마지막 줄 아래는 tbody 로
//   [4] insertCol — 같은 규칙, COL 도 같이, 종이보다 넓어지면 줄인다
//   [5] deleteRow — 거기서 시작한 rowspan 칸은 다음 줄로 내려가며 하나 준다, 지나가는 칸은 준다, 마지막 줄이면 표를 지운다
//   [6] deleteCol — colspan 이 준다, COL 도 빠진다, 마지막 열이면 표를 지운다
//   [7] duplicateRow·duplicateCol — 내용과 스타일을 그대로, 경계를 지나는 합친 칸은 늘린다
//   [8] merge — 합친 칸에 걸치면 고른 네모를 넓힌다, 다른 칸의 글은 <br> 로 이어 붙인다 (빈 칸은 뺀다), 왼쪽 위 칸의 스타일,
//       칸이 하나도 시작하지 않는 줄·열은 없앤다 (COL 너비는 왼쪽 열에 더한다), 구역을 넘어 합치지 않는다
//   [9] split — 합친 칸을 1×1 로, 빈 자리에 같은 스타일의 빈 칸, 글은 왼쪽 위에 그대로
//  [10] paint·header·clear — 배경색은 background-color + bgcolor, «기본»은 둘 다 뗀다, 머리글은 굵게 + 회색을 켜고 끈다 (그것만)
//  [11] resize·colWidths·fitWidths — 너비는 COL 과 그 열 칸의 width 속성 + style 에
//  [12] order — Tab 차례 (합친 칸이 덮은 자리는 건너뛴다)
//  [13] getDecl·setDecl — style 글 고치기
//  [14] 막 굴리기 — 정해 둔 씨앗으로 아무 표에 아무 셈을 잇달아 해도 지도는 네모이고 겹치는 칸이 없다,
//       합쳤다 나누면 글이 다 남고 칸이 다 돌아온다
//  [16] 돌연변이 시험에서 나온 것 — 너비가 적힌 합친 칸을 나누면 왼쪽 위 칸도 제 열 너비, 채움 없는 굵은 첫 줄은 머리글이 아니다,
//       머리글 행·열을 둘 다 켠 표의 thead 아래 줄도 첫 칸은 머리글 꼴
const path = require('path');

const ROOT = path.join(__dirname, '..');
let G;
try {
  G = require(path.join(ROOT, 'renderer', 'tablegrid.js'));
} catch (e) {
  console.error('  실패 renderer/tablegrid.js 를 못 불러왔다 —', e.message);
  process.exit(1);
}

let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${s.length > 400 ? `${s.slice(0, 400)}…` : s}` : ''));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 시험용 표 — 줄마다 칸 글. 칸은 '가' 또는 { t:'가', rs, cs, style, tag, attrs }. secs 로 줄마다 구역을 준다
function raw(rows, opt = {}) {
  const secs = opt.secs || [{ tag: 'tbody', attrs: {} }];
  return {
    attrs: opt.attrs || { style: 'border-collapse:collapse' },
    caption: opt.caption || null,
    cols: opt.cols ? opt.cols.map((w) => ({ attrs: w ? { width: String(w) } : {} })) : null,
    secs,
    rows: rows.map((r, i) => ({
      sec: opt.rowSecs ? opt.rowSecs[i] : 0,
      attrs: {},
      cells: r.map((c) => {
        const o = typeof c === 'string' ? { t: c } : c;
        const attrs = { ...(o.attrs || {}) };
        if (o.style !== undefined) attrs.style = o.style;
        return { tag: o.tag || 'td', rs: o.rs === undefined ? 1 : o.rs, cs: o.cs === undefined ? 1 : o.cs, attrs, html: o.t === undefined ? '' : o.t };
      })
    }))
  };
}
const T = (rows, opt) => G.tidy(raw(rows, opt));
// 지도 그림 — 자리마다 그 자리를 차지한 칸의 글
const pic = (m) => G.cells(m).map((row) => row.map((it) => (it ? it.html : null)));
const spans = (m) => m.items.map((it) => `${it.r},${it.c} ${it.rs}x${it.cs} ${it.html}`);
const okGrid = (m, label) => { const v = G.check(m); ok(v.ok, `${label} — 지도가 네모이고 겹치는 칸이 없다`, v.ok ? undefined : v.why); };

console.log('\n[1] tidy — 지도 펴기');
{
  let m = T([['a', 'b'], ['c', 'd']]);
  ok(m.h === 2 && m.w === 2 && same(pic(m), [['a', 'b'], ['c', 'd']]), '2×2', pic(m));
  okGrid(m, '  2×2');
  m = T([[{ t: 'a', rs: 2 }, { t: 'b', cs: 2 }], ['c', 'd']]);
  ok(same(pic(m), [['a', 'b', 'b'], ['a', 'c', 'd']]), '합친 칸 — 아래 줄의 칸은 비어 있는 자리부터', pic(m));
  m = T([['a', 'b', 'c'], [{ t: 'd', style: 'color:#ff0000' }]]);
  ok(same(pic(m), [['a', 'b', 'c'], ['d', '', '']]) && m.items.filter((it) => it.r === 1 && it.c > 0).every((it) => it.attrs.style === 'color:#ff0000' && it.html === ''),
    '들쭉날쭉한 줄 — 빈 자리를 왼쪽 칸 스타일의 빈 칸으로 채운다', spans(m));
  okGrid(m, '  채운 뒤');
  m = T([['a', { t: 'b', rs: 2 }], [{ t: 'c', cs: 3 }]]);
  ok(same(pic(m), [['a', 'b', ''], ['c', 'b', '']]) || same(pic(m), [['a', 'b'], ['c', 'b']]), '겹치는 합침 — 차지한 자리 앞에서 colspan 을 자른다', pic(m));
  okGrid(m, '  자른 뒤');
  m = T([[{ t: 'h', rs: 3 }, 'x'], ['b1', 'y']], { secs: [{ tag: 'thead', attrs: {} }, { tag: 'tbody', attrs: {} }], rowSecs: [0, 1] });
  ok(same(pic(m), [['h', 'x'], ['b1', 'y']]) && m.items[0].rs === 1, 'rowspan 은 구역(thead) 끝에서 자른다', spans(m));
  m = T([[{ t: 'a', rs: 0 }, 'b'], ['c'], ['d']]);
  ok(same(pic(m), [['a', 'b'], ['a', 'c'], ['a', 'd']]), 'rowspan=0 — 구역 끝까지', pic(m));
  m = T([[{ t: 'h', tag: 'th' }, 'x']], { cols: [64, 80] });
  ok(m.items[0].tag === 'th' && same(m.cols.map((c) => c.attrs.width), ['64', '80']), 'th 는 그대로, COL 은 열마다', m.cols);
  m = T([['a']], { cols: [64, 80, 90] });
  ok(m.w === 1 && m.cols.length === 1, 'COL 이 열보다 많으면 열 수에 맞춘다', m.cols);
  m = T([['a', 'b', 'c']], { cols: [64] });
  ok(m.cols.length === 3 && m.cols[0].attrs.width === '64' && !m.cols[1].attrs.width, 'COL 이 모자라면 빈 COL 로 채운다', m.cols);
  m = G.tidy({ rows: [] });
  ok(m.h === 0 && m.w === 0 && G.check(m).ok, '줄이 없는 표', m);
}

console.log('\n[2] toHtml');
{
  const m = T([[{ t: 'a<b>굵</b>', rs: 2, attrs: { width: '120', bgcolor: '#f1f1ef' }, style: 'border:1px solid #dcdcd9' }, ''], ['c']], {
    attrs: { cellpadding: '0', style: 'border-collapse:collapse', title: 'x"&<y>', onclick: 'alert(1)' }, cols: [120, 80],
    caption: { attrs: {}, html: '제목' }
  });
  const h = G.toHtml(m, { 'data-tg-new': '1' });
  const want = '<table data-tg-new="1" cellpadding="0" style="border-collapse:collapse" title="x&quot;&amp;&lt;y&gt;"><caption>제목</caption>'
    + '<colgroup><col width="120"><col width="80"></colgroup><tbody>'
    + '<tr><td rowspan="2" width="120" bgcolor="#f1f1ef" style="border:1px solid #dcdcd9">a<b>굵</b></td><td><br></td></tr>'
    + '<tr><td>c</td></tr></tbody></table>';
  ok(h === want, '표시 속성은 맨 앞, 빈 칸은 <br>, 속성 값 이스케이프, on* 속성은 안 쓴다', h);
  const m2 = T([[{ t: 'h', tag: 'th' }], ['b']], { secs: [{ tag: 'thead', attrs: {} }, { tag: 'tbody', attrs: { class: 'x' } }], rowSecs: [0, 1] });
  ok(G.toHtml(m2) === '<table style="border-collapse:collapse"><thead><tr><th>h</th></tr></thead><tbody class="x"><tr><td>b</td></tr></tbody></table>', 'thead·tbody 구역', G.toHtml(m2));
}

console.log('\n[3] insertRow');
{
  const S = 'border:1px solid #dcdcd9;padding:6px 10px';
  let m = T([[{ t: 'a', style: S }, { t: 'b', style: `${S};color:#0000ff` }], ['c', 'd']]);
  let r = G.insertRow(m, 0, 'below', { c: 1 });
  ok(same(pic(r.model), [['a', 'b'], ['', ''], ['c', 'd']]), '아래에 — 빈 줄', pic(r.model));
  ok(r.model.items.filter((it) => it.r === 1).map((it) => it.attrs.style).join('|') === `${S}|${S};color:#0000ff`, '  새 칸은 같은 열 이웃 칸의 스타일만 (내용은 아니다)', spans(r.model));
  ok(same(r.focus, { r: 1, c: 1 }), '  커서는 새 줄, 같은 열', r.focus);
  ok(m.h === 2 && same(pic(m), [['a', 'b'], ['c', 'd']]), '  받은 지도는 안 바꾼다');
  r = G.insertRow(m, 0, 'above');
  ok(same(pic(r.model), [['', ''], ['a', 'b'], ['c', 'd']]) && same(r.focus, { r: 0, c: 0 }), '위에 — 맨 앞 줄', { p: pic(r.model), f: r.focus });
  okGrid(r.model, '  위에');

  m = T([[{ t: 'a', rs: 2 }, 'b'], ['c'], ['d', 'e']]);
  r = G.insertRow(m, 0, 'below');
  ok(same(pic(r.model), [['a', 'b'], ['a', ''], ['a', 'c'], ['d', 'e']]) && r.model.items[0].rs === 3, '합친 칸을 지나면 그 칸을 늘린다 (그 열에는 새 칸이 없다)', spans(r.model));
  ok(same(r.focus, { r: 1, c: 1 }), '  커서는 새 줄의 첫 칸', r.focus);
  okGrid(r.model, '  늘린 뒤');
  r = G.insertRow(m, 1, 'below');
  ok(same(pic(r.model), [['a', 'b'], ['a', 'c'], ['', ''], ['d', 'e']]) && r.model.items[0].rs === 2, '합친 칸의 끝 줄 아래 — 늘리지 않는다', pic(r.model));

  const H = 'font-weight:bold;background-color:#f1f1ef';
  m = T([[{ t: 'h1', style: `${S};${H}`, attrs: { bgcolor: '#f1f1ef' } }, { t: 'h2', style: `${S};${H}`, attrs: { bgcolor: '#f1f1ef' } }], ['c', 'd']]);
  ok(G.headerOn(m, 'row') && !G.headerOn(m, 'col'), 'headerOn — 첫 줄이 굵게 + 회색');
  r = G.insertRow(m, 0, 'below');
  const nw = r.model.items.filter((it) => it.r === 1);
  ok(nw.every((it) => it.attrs.style === S && !it.attrs.bgcolor), '머리글 줄 아래 — 머리글 채움·굵게는 안 따라온다', nw.map((it) => it.attrs));
  ok(G.headerOn(r.model, 'row'), '  머리글은 그대로 첫 줄');
  r = G.insertRow(m, 0, 'above');
  ok(G.headerOn(r.model, 'row') && r.model.items.filter((it) => it.r === 1).every((it) => it.attrs.style === S && !it.attrs.bgcolor),
    '머리글 줄 위 — 새 첫 줄이 머리글, 옛 첫 줄은 머리글 채움을 뗀다', spans(r.model).concat(r.model.items.map((it) => it.attrs.style)));

  m = T([[{ t: 'h', tag: 'th' }, { t: 'h2', tag: 'th' }], ['b', 'c']], { secs: [{ tag: 'thead', attrs: {} }, { tag: 'tbody', attrs: {} }], rowSecs: [0, 1] });
  r = G.insertRow(m, 0, 'below');
  ok(r.model.meta[1].sec === 1 && r.model.items.filter((it) => it.r === 1).every((it) => it.tag === 'td'), 'thead 마지막 줄 아래 — tbody 의 td 줄로', { meta: r.model.meta.map((x) => x.sec), s: spans(r.model) });
  ok(/<thead><tr><th>h<\/th><th>h2<\/th><\/tr><\/thead><tbody><tr><td><br><\/td><td><br><\/td><\/tr><tr><td>b/.test(G.toHtml(r.model)), '  HTML 도 그 꼴', G.toHtml(r.model));
  m = T([[{ t: 'h', tag: 'th' }]], { secs: [{ tag: 'thead', attrs: {} }], rowSecs: [0] });
  r = G.insertRow(m, 0, 'below');
  ok(r.model.h === 2 && r.model.meta[1].sec === 0, '  뒤에 구역이 없으면 thead 에 그대로', r.model.meta);
}

console.log('\n[4] insertCol');
{
  let m = T([[{ t: 'a', style: 'x:1' }, 'b'], [{ t: 'c', style: 'y:2' }, 'd']], { cols: [64, 80] });
  let r = G.insertCol(m, 0, 'right', { r: 1 });
  ok(same(pic(r.model), [['a', '', 'b'], ['c', '', 'd']]), '오른쪽에 — 빈 열', pic(r.model));
  ok(same(r.model.items.filter((it) => it.c === 1).map((it) => it.attrs.style), ['x:1', 'y:2']), '  새 칸은 같은 줄 이웃 칸의 스타일만', spans(r.model));
  ok(same(r.model.cols.map((c) => c.attrs.width), ['64', '64', '80']), '  COL 도 이웃 너비로 하나 더', r.model.cols);
  ok(same(r.focus, { r: 1, c: 1 }), '  커서는 새 열, 같은 줄', r.focus);
  r = G.insertCol(m, 0, 'left');
  ok(same(pic(r.model), [['', 'a', 'b'], ['', 'c', 'd']]) && same(r.focus, { r: 0, c: 0 }), '왼쪽에', pic(r.model));
  m = T([[{ t: 'a', cs: 2 }], ['b', 'c']]);
  r = G.insertCol(m, 0, 'right');
  ok(same(pic(r.model), [['a', 'a', 'a'], ['b', '', 'c']]) && r.model.items[0].cs === 3, '합친 칸을 지나면 늘린다', spans(r.model));
  okGrid(r.model, '  늘린 뒤');
  m = T([[{ t: 'a', attrs: { width: '120' }, style: 'width:120px' }, { t: 'b', attrs: { width: '120' }, style: 'width:120px' }]]);
  r = G.insertCol(m, 1, 'right', { room: 300, extra: 21 });
  const ws = G.colWidths(r.model);
  ok(ws.length === 3 && ws.reduce((a, b) => a + b + 21, 0) <= 300 && ws.every((w) => w >= 40), '종이(300px)보다 넓어지면 열 너비를 줄인다', ws);
  ok(r.model.items.every((it) => it.attrs.style === `width:${it.attrs.width}px`), '  줄인 너비는 width 속성과 style 에 같이', r.model.items.map((it) => it.attrs));
  const H = 'font-weight:bold;background-color:#f1f1ef';
  m = T([[{ t: 'h', style: H, attrs: { bgcolor: '#f1f1ef' } }, 'x'], [{ t: 'h2', style: H, attrs: { bgcolor: '#f1f1ef' } }, 'y']]);
  ok(G.headerOn(m, 'col'), 'headerOn(col)');
  r = G.insertCol(m, 0, 'right');
  ok(r.model.items.filter((it) => it.c === 1).every((it) => !it.attrs.style && !it.attrs.bgcolor), '머리글 열 오른쪽 — 머리글 채움은 안 따라온다', spans(r.model));
}

console.log('\n[5] deleteRow');
{
  let m = T([[{ t: 'a', rs: 3 }, 'b'], ['c'], ['d']]);
  let r = G.deleteRow(m, 0, { c: 1 });
  ok(same(pic(r.model), [['a', 'c'], ['a', 'd']]) && r.model.items[0].rs === 2 && r.model.items[0].r === 0, '거기서 시작한 rowspan 칸은 다음 줄로 내려가며 하나 준다', spans(r.model));
  ok(same(r.focus, { r: 0, c: 1 }), '  커서는 그 자리 줄', r.focus);
  r = G.deleteRow(m, 1);
  ok(same(pic(r.model), [['a', 'b'], ['a', 'd']]) && r.model.items[0].rs === 2, '지나가는 합친 칸은 준다', spans(r.model));
  okGrid(r.model, '  지운 뒤');
  r = G.deleteRow(m, 2);
  ok(same(r.focus, { r: 1, c: 0 }), '마지막 줄을 지우면 커서는 그 위 줄', r.focus);
  r = G.deleteRow(T([['a', 'b']]), 0);
  ok(r.gone === true, '하나 남은 줄을 지우면 표를 지운다', r);
  m = T([[{ t: 'a', rs: 2 }, 'b'], ['c']]);
  r = G.deleteCol(m, 1);
  ok(r.model.h === 1 && r.model.items[0].rs === 1, '칸이 하나도 시작하지 않는 줄은 없앤다 (합친 칸은 준다)', spans(r.model));
}

console.log('\n[6] deleteCol');
{
  let m = T([[{ t: 'a', cs: 3 }], ['b', 'c', 'd']], { cols: [10, 20, 30] });
  let r = G.deleteCol(m, 0, { r: 1 });
  ok(same(pic(r.model), [['a', 'a'], ['c', 'd']]) && r.model.items[0].cs === 2, 'colspan 이 준다 (시작한 열을 지워도 칸은 남는다)', spans(r.model));
  ok(same(r.model.cols.map((c) => c.attrs.width), ['20', '30']), '  COL 도 빠진다', r.model.cols);
  ok(same(r.focus, { r: 1, c: 0 }), '  커서', r.focus);
  r = G.deleteCol(m, 1);
  ok(same(pic(r.model), [['a', 'a'], ['b', 'd']]), '지나가는 colspan 이 준다', pic(r.model));
  r = G.deleteCol(T([['a'], ['b']]), 0);
  ok(r.gone === true, '하나 남은 열을 지우면 표를 지운다', r);
}

console.log('\n[7] duplicateRow · duplicateCol');
{
  let m = T([[{ t: 'a', rs: 2, style: 's1' }, { t: 'b', style: 's2' }], [{ t: 'c', style: 's3' }]]);
  let r = G.duplicateRow(m, 0, { c: 1 });
  ok(same(pic(r.model), [['a', 'b'], ['a', 'b'], ['a', 'c']]) && r.model.items[0].rs === 3, '경계를 지나는 합친 칸은 늘리고, 끝나는 칸은 내용·스타일째 복제', spans(r.model));
  ok(r.model.items.find((it) => it.r === 1).attrs.style === 's2', '  스타일도', spans(r.model));
  ok(same(r.focus, { r: 1, c: 1 }), '  커서는 복제한 줄', r.focus);
  r = G.duplicateRow(m, 1);
  ok(same(pic(r.model), [['a', 'b'], ['a', 'c'], ['a', 'c']]) && r.model.items[0].rs === 2 && r.model.items.filter((it) => it.html === 'a').length === 2,
    '합친 칸의 끝 줄 복제 — 그 칸도 1줄짜리로 복제', spans(r.model));
  okGrid(r.model, '  복제 뒤');
  m = T([[{ t: 'a', cs: 2 }], ['b', 'c']], { cols: [10, 20] });
  r = G.duplicateCol(m, 1);
  ok(same(pic(r.model), [['a', 'a', 'a'], ['b', 'c', 'c']]) && same(r.model.cols.map((c) => c.attrs.width), ['10', '20', '20']), '열 복제 — COL 도', { p: pic(r.model), c: r.model.cols });
  okGrid(r.model, '  열 복제 뒤');
}

console.log('\n[8] merge');
{
  let m = T([['a', 'b', 'c'], ['d', { t: 'e', rs: 2, cs: 2 }], ['g']]);
  ok(same(G.expand(m, { r0: 0, c0: 0, r1: 1, c1: 1 }), { r0: 0, c0: 0, r1: 2, c1: 2 }), 'expand — 걸친 합친 칸을 다 담을 때까지 넓힌다', G.expand(m, { r0: 0, c0: 0, r1: 1, c1: 1 }));
  m = T([[{ t: 'a', style: 'S', attrs: { bgcolor: '#fbecdd' } }, 'b', ''], ['<br>', 'e', 'f'], ['g', 'h', 'i']]);
  let r = G.merge(m, { r0: 0, c0: 0, r1: 1, c1: 1 });
  const head = r.model.items[0];
  ok(head.rs === 2 && head.cs === 2 && head.html === 'a<br>b<br>e', '왼쪽 위 칸에 다른 칸 글을 <br> 로 이어 붙인다 (빈 칸은 뺀다)', spans(r.model));
  ok(head.attrs.style === 'S' && head.attrs.bgcolor === '#fbecdd', '  왼쪽 위 칸의 스타일', head.attrs);
  ok(same(pic(r.model), [['a<br>b<br>e', 'a<br>b<br>e', ''], ['a<br>b<br>e', 'a<br>b<br>e', 'f'], ['g', 'h', 'i']]) && same(r.focus, { r: 0, c: 0 }), '  지도', pic(r.model));
  okGrid(r.model, '  합친 뒤');
  m = T([['', 'b'], ['c', '']]);
  r = G.merge(m, { r0: 0, c0: 0, r1: 1, c1: 1 });
  ok(r.model.items.length === 1 && r.model.items[0].html === 'b<br>c', '왼쪽 위가 비었으면 다른 칸 글만', spans(r.model));
  m = T([['a', 'b'], ['c', 'd']], { cols: [100, 50] });
  r = G.merge(m, { r0: 0, c0: 0, r1: 1, c1: 1 });
  ok(r.model.h === 1 && r.model.w === 1 && r.model.items[0].rs === 1 && r.model.items[0].cs === 1 && same(r.model.cols.map((c) => c.attrs.width), ['150']),
    '다 합치면 1×1 — 칸이 시작하지 않는 줄·열을 없애고 COL 너비는 왼쪽 열에 더한다', { s: spans(r.model), c: r.model.cols });
  m = T([['a', 'b', 'c'], ['d', 'e', 'f']]);
  r = G.merge(m, { r0: 0, c0: 1, r1: 1, c1: 1 });
  ok(same(pic(r.model), [['a', 'b<br>e', 'c'], ['d', 'b<br>e', 'f']]) && r.model.h === 2, '세로로 합치기', pic(r.model));
  m = T([['h1', 'h2'], ['b1', 'b2']], { secs: [{ tag: 'thead', attrs: {} }, { tag: 'tbody', attrs: {} }], rowSecs: [0, 1] });
  const why = G.canMerge(m, { r0: 0, c0: 0, r1: 1, c1: 0 });
  r = G.merge(m, { r0: 0, c0: 0, r1: 1, c1: 0 });
  ok(!why.ok && why.why === 'section' && r.refused === 'section' && !r.model, '구역(thead·tbody)을 넘어서는 못 합친다', { why, r });
  ok(G.canMerge(T([['a', 'b']]), { r0: 0, c0: 0, r1: 0, c1: 0 }).why === 'one', '한 칸은 못 합친다');
  ok(G.canMerge(T([['a', 'b']]), { r0: 0, c0: 0, r1: 0, c1: 1 }).ok, '두 칸은 된다');
}

console.log('\n[9] split');
{
  const m = T([[{ t: 'a', rs: 2, cs: 2, style: 'S', attrs: { bgcolor: '#e7f3f8' } }, 'c'], ['f'], ['g', 'h', 'i']]);
  const r = G.split(m, 0, 0);
  ok(same(pic(r.model), [['a', '', 'c'], ['', '', 'f'], ['g', 'h', 'i']]), '합친 칸을 1×1 로, 빈 자리는 새 칸', pic(r.model));
  ok(r.model.items.filter((it) => it.html === '').every((it) => it.attrs.style === 'S' && it.attrs.bgcolor === '#e7f3f8'), '  새 칸은 합친 칸의 스타일', spans(r.model));
  ok(same(r.focus, { r: 0, c: 0 }), '  커서는 왼쪽 위', r.focus);
  okGrid(r.model, '  나눈 뒤');
  ok(G.split(T([['a']]), 0, 0) === null, '안 합친 칸은 나눌 것이 없다 (null)');
}

console.log('\n[10] paint · header · clear');
{
  const S = 'border:1px solid #dcdcd9;padding:6px 10px';
  let m = T([[{ t: 'a', style: S }, { t: 'b', style: S }], [{ t: 'c', style: S }, { t: 'd', style: S }]]);
  let r = G.paint(m, { r0: 0, c0: 0, r1: 0, c1: 1 }, '#fbecdd');
  ok(r.model.items.filter((it) => it.r === 0).every((it) => it.attrs.style === `${S};background-color:#fbecdd` && it.attrs.bgcolor === '#fbecdd') && !r.model.items[2].attrs.bgcolor,
    '배경색 — background-color 와 bgcolor (아웃룩)', r.model.items.map((it) => it.attrs));
  r = G.paint(r.model, { r0: 0, c0: 0, r1: 0, c1: 0 }, null);
  ok(r.model.items[0].attrs.style === S && !('bgcolor' in r.model.items[0].attrs), '«기본»은 둘 다 뗀다', r.model.items[0].attrs);
  m = T([[{ t: 'a', style: `${S};background:#123456` }]]);
  ok(G.paint(m, { r0: 0, c0: 0, r1: 0, c1: 0 }, null).model.items[0].attrs.style === S, '  background 줄임말 색도 뗀다');
  m = T([[{ t: 'a', style: S }, { t: 'b', style: S }], [{ t: 'c', style: S }, 'd']]);
  r = G.header(m, 'row', true);
  ok(r.model.items.filter((it) => it.r === 0).every((it) => it.attrs.style === `${S};font-weight:bold;background-color:#f1f1ef` && it.attrs.bgcolor === '#f1f1ef') && G.headerOn(r.model, 'row'),
    '머리글 켜기 — 첫 줄 굵게 + 회색 (인라인)', r.model.items.map((it) => it.attrs));
  const off = G.header(r.model, 'row', false);
  ok(same(off.model.items.map((it) => it.attrs), m.items.map((it) => it.attrs)) && !G.headerOn(off.model, 'row'), '머리글 끄기 — 켤 때 넣은 것만 뗀다 (다른 스타일은 그대로)', off.model.items.map((it) => it.attrs));
  r = G.header(m, 'col', true);
  ok(r.model.items.filter((it) => it.c === 0).every((it) => /font-weight:bold;background-color:#f1f1ef$/.test(it.attrs.style)) && G.headerOn(r.model, 'col') && !G.headerOn(r.model, 'row'), '머리글 열', spans(r.model));
  m = T([[{ t: 'h', tag: 'th' }]]);
  r = G.header(m, 'row', true);
  ok(r.model.items[0].attrs.style === 'background-color:#f1f1ef' && G.headerOn(r.model, 'row'), 'th 는 이미 굵다 — 회색만 (크로미움이 기본값 굵게를 보면 style 을 다시 쓴다)', r.model.items[0].attrs);
  m = T([['a', 'b'], ['c', 'd']]);
  r = G.clear(m, { r0: 0, c0: 0, r1: 1, c1: 0 });
  ok(same(pic(r.model), [['', 'b'], ['', 'd']]) && /<td><br><\/td><td>b/.test(G.toHtml(r.model)), '내용 지우기 — 구조는 그대로, 빈 칸은 <br>', pic(r.model));
  ok(G.PALETTE.length === 10 && G.PALETTE[0].color === null && G.PALETTE[1].name === '회색' && G.PALETTE[1].color === '#f1f1ef' && G.PALETTE[9].color === '#fdebec', '팔레트 — 기본·회색 … 빨강', G.PALETTE);
}

console.log('\n[11] resize · colWidths · fitWidths');
{
  const m = T([[{ t: 'a', attrs: { width: '64' } }, { t: 'b', cs: 2, attrs: { width: '99' }, style: 'width:99px' }], ['c', 'd', 'e']], { cols: [64, 64, 64], attrs: { width: '400', style: 'border-collapse:collapse;width:100%' } });
  const r = G.resize(m, [100, 50, 60]);
  ok(same(r.model.cols.map((c) => c.attrs.width), ['100', '50', '60']), 'COL 너비', r.model.cols);
  ok(r.model.items.filter((it) => it.cs === 1).every((it) => it.attrs.width === String([100, 50, 60][it.c]) && it.attrs.style === `width:${[100, 50, 60][it.c]}px`), '  그 열 칸마다 width 속성 + style', spans(r.model).concat(r.model.items.map((it) => it.attrs)));
  ok(!('width' in r.model.items[1].attrs) && !r.model.items[1].attrs.style, '  합친 칸(colspan)은 너비를 뗀다', r.model.items[1].attrs);
  ok(!('width' in r.model.attrs) && r.model.attrs.style === 'border-collapse:collapse', '  표 너비(%·px)는 뗀다 — 열 너비가 정한다', r.model.attrs);
  ok(same(G.colWidths(r.model), [100, 50, 60]), 'colWidths');
  ok(same(G.colWidths(T([[{ t: 'a', attrs: { width: '70' } }, 'b'], ['c', { t: 'd', style: 'width:33px' }]])), [70, 33]), 'colWidths — COL 이 없으면 1칸짜리 칸의 width·style');
  ok(same(G.fitWidths([120, 120, 120], 1000, 21), [120, 120, 120]), 'fitWidths — 들어가면 그대로');
  const f = G.fitWidths([120, 120, 120, 120], 300, 21);
  ok(f.reduce((a, b) => a + b + 21, 0) <= 300 && f.every((w) => w >= 40), 'fitWidths — 종이 안으로', f);
  ok(G.fitWidths([120, 120], 50, 21).every((w) => w === 40), '  40px 아래로는 안 줄인다');
}

console.log('\n[12] order — Tab 차례');
{
  const m = T([[{ t: 'a', rs: 2 }, 'b', 'c'], [{ t: 'd', cs: 2 }]]);
  ok(same(G.order(m).map((it) => it.html), ['a', 'b', 'c', 'd']), '줄 차례, 합친 칸이 덮은 자리는 건너뛴다', G.order(m).map((it) => it.html));
}

console.log('\n[13] getDecl · setDecl');
{
  ok(G.getDecl('border:1px solid #000;Background-Color: #FFF ', 'background-color') === '#FFF', 'getDecl — 이름은 작은 글자로');
  ok(G.setDecl('a:1;b:2', 'a', '3') === 'b:2;a:3', 'setDecl — 바꾸면 맨 뒤로', G.setDecl('a:1;b:2', 'a', '3'));
  ok(G.setDecl('a:1;b:2;a:4', 'a', null) === 'b:2', 'setDecl — null 이면 뗀다 (겹친 것까지)');
  ok(G.setDecl('font-family:"a;b";c:d', 'c', 'e') === 'font-family:"a;b";c:e', '  따옴표 안의 ; 는 안 자른다', G.setDecl('font-family:"a;b";c:d', 'c', 'e'));
  ok(G.setDecl('', 'x', 'y') === 'x:y' && G.setDecl(undefined, 'x', null) === '', '  빈 것');
}

console.log('\n[14] 막 굴리기 — 씨앗 20261117');
{
  // mulberry32 — 정해 둔 씨앗이면 늘 같은 차례
  let seed = 20261117;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (n) => Math.floor(rnd() * n);
  let n = 0;
  // 아무 표 — 들쭉날쭉, 합친 칸, 겹치는 합침, 구역 둘
  const randomRaw = () => {
    const h = 1 + int(6);
    const rows = [];
    for (let r = 0; r < h; r++) {
      const cells = [];
      const k = 1 + int(5);
      for (let c = 0; c < k; c++) cells.push({ t: `t${n++}`, rs: rnd() < 0.2 ? 2 + int(3) : 1, cs: rnd() < 0.2 ? 2 + int(3) : 1 });
      rows.push(cells);
    }
    const two = rnd() < 0.3 && h > 1;
    return raw(rows, two ? { secs: [{ tag: 'thead', attrs: {} }, { tag: 'tbody', attrs: {} }], rowSecs: rows.map((_, i) => (i === 0 ? 0 : 1)) } : {});
  };
  const texts = (m) => m.items.map((it) => it.html).join('<br>').split('<br>').filter(Boolean).sort();
  const pickRect = (m) => {
    const r0 = int(m.h); const c0 = int(m.w);
    return { r0, c0, r1: Math.min(m.h - 1, r0 + int(3)), c1: Math.min(m.w - 1, c0 + int(3)) };
  };
  let fails = [];
  let steps = 0;
  let merges = 0;
  let splits = 0;
  for (let k = 0; k < 300 && fails.length < 3; k++) {
    let m = G.tidy(randomRaw());
    const v0 = G.check(m);
    if (!v0.ok) { fails.push({ k, at: 'tidy', why: v0.why }); continue; }
    for (let s = 0; s < 25; s++) {
      const before = texts(m);
      const op = int(13);
      const r = int(m.h); const c = int(m.w);
      let res = null;
      let name = '';
      if (op === 0) { name = 'insertRow'; res = G.insertRow(m, r, rnd() < 0.5 ? 'above' : 'below'); }
      else if (op === 1) { name = 'insertCol'; res = G.insertCol(m, c, rnd() < 0.5 ? 'left' : 'right'); }
      else if (op === 2) { name = 'deleteRow'; res = G.deleteRow(m, r); }
      else if (op === 3) { name = 'deleteCol'; res = G.deleteCol(m, c); }
      else if (op === 4) { name = 'duplicateRow'; res = G.duplicateRow(m, r); }
      else if (op === 5) { name = 'duplicateCol'; res = G.duplicateCol(m, c); }
      else if (op === 6 || op === 7) { name = 'merge'; res = G.merge(m, pickRect(m)); if (res && res.model) merges++; }
      else if (op === 8) { name = 'split'; const it = G.cells(m)[r][c]; res = G.split(m, it.r, it.c); if (res) splits++; }
      else if (op === 9) { name = 'paint'; res = G.paint(m, pickRect(m), G.PALETTE[int(10)].color); }
      else if (op === 10) { name = 'header'; res = G.header(m, rnd() < 0.5 ? 'row' : 'col', rnd() < 0.5); }
      else if (op === 11) { name = 'clear'; res = G.clear(m, pickRect(m)); }
      else { name = 'resize'; res = G.resize(m, Array.from({ length: m.w }, () => 40 + int(200))); }
      steps++;
      if (!res || res.refused) continue;
      if (res.gone) break;
      const v = G.check(res.model);
      if (!v.ok) { fails.push({ k, s, name, why: v.why, before: spans(m) }); break; }
      if (res.focus && !(res.focus.r >= 0 && res.focus.r < res.model.h && res.focus.c >= 0 && res.focus.c < res.model.w)) { fails.push({ k, s, name, why: 'focus 밖', focus: res.focus }); break; }
      // 글을 지우지 않는 셈은 글이 그대로 (합치기는 이어 붙이므로 같은 글 모음)
      if (['insertRow', 'insertCol', 'merge', 'split', 'paint', 'header', 'resize'].includes(name) && !same(texts(res.model), before)) {
        fails.push({ k, s, name, why: '글이 바뀌었다', before, after: texts(res.model) });
        break;
      }
      m = res.model;
    }
  }
  ok(!fails.length, `아무 표 300개 × 아무 셈 25번 (${steps}번, 합치기 ${merges} · 나누기 ${splits}) — 지도는 늘 네모, 겹침 없음, 글은 그대로`, fails.slice(0, 2));
  // 합쳤다 나누기 — 글이 다 남고 1×1 칸이 다 돌아온다
  fails = [];
  for (let k = 0; k < 200; k++) {
    const h = 1 + int(5); const w = 1 + int(5);
    const m = T(Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => (rnd() < 0.25 ? '' : `${r}.${c}`))));
    const rect = pickRect(m);
    const mg = G.merge(m, rect);
    if (!mg || !mg.model) continue;
    const it = G.cells(mg.model)[mg.focus.r][mg.focus.c];
    const sp = G.split(mg.model, it.r, it.c) || mg;
    const all = texts(m);
    const back = texts(sp.model);
    const full = sp.model.items.every((x) => x.rs === 1 && x.cs === 1) && sp.model.items.length === sp.model.h * sp.model.w && G.check(sp.model).ok;
    if (!same(all, back) || !full) fails.push({ k, rect, all, back, full, s: spans(sp.model) });
  }
  ok(!fails.length, '합쳤다 나누기 200번 — 글이 다 남고, 칸은 다 1×1, 지도는 네모', fails.slice(0, 2));
}

console.log('\n[15] 검토에서 나온 것');
{
  const H = 'font-weight:bold;background-color:#f1f1ef';
  const hc = (t) => ({ t, style: H, attrs: { bgcolor: '#f1f1ef' } });
  // 머리글 행과 머리글 열을 둘 다 켠 표 — 행을 넣어도 머리글 열이 끊기지 않는다
  let m = T([[hc('h0'), hc('h1'), hc('h2')], [hc('a'), 'b', 'c'], [hc('d'), 'e', 'f']]);
  ok(G.headerOn(m, 'row') && G.headerOn(m, 'col'), '(머리글 행·열 둘 다 켰다)');
  for (const where of ['below', 'above']) {
    const r = G.insertRow(m, 0, where);
    ok(G.headerOn(r.model, 'row') && G.headerOn(r.model, 'col'), `머리글 행 ${where === 'below' ? '아래' : '위'}에 행 넣기 — 머리글 행·열 둘 다 그대로`, r.model.items.filter((it) => it.c === 0).map((it) => [it.r, it.attrs.style || '']));
  }
  // 열을 통째로 합치면 지운 열의 너비를 합친 칸에 (사이 여백·선 extra 까지) — 표가 좁아지지 않게
  const W = (w) => ({ attrs: { width: String(w) }, style: `width:${w}px` });
  m = T([[{ t: 'a', ...W(120) }, { t: 'b', ...W(120) }, { t: 'c', ...W(120) }]]);
  let r = G.merge(m, { r0: 0, c0: 0, r1: 0, c1: 1 }, { extra: 21 });
  ok(r.model.w === 2 && r.model.items[0].attrs.width === '261' && r.model.items[0].attrs.style === 'width:261px', 'COL 없는 표 — 두 열을 합치면 120+120+21 = 261 (속성 + style)', r.model.items.map((it) => it.attrs));
  m = T([[{ t: 'a', ...W(120) }, { t: 'b', ...W(120) }, { t: 'c', ...W(120) }]], { cols: [120, 120, 120] });
  r = G.merge(m, { r0: 0, c0: 0, r1: 0, c1: 1 }, { extra: 21 });
  ok(same(r.model.cols.map((c) => c.attrs.width), ['261', '120']) && r.model.items[0].attrs.width === '261', '  COL 있는 표 — COL 과 칸 너비가 같이 261', { cols: r.model.cols, a: r.model.items[0].attrs });
  m = T([[{ t: 'a', ...W(160) }, { t: 'b', ...W(120) }, { t: 'c', ...W(120) }], [{ t: 'd', ...W(160) }, { t: 'e', ...W(120) }, { t: 'f', ...W(120) }]]);
  r = G.merge(m, { r0: 0, c0: 0, r1: 0, c1: 1 }, { extra: 21 });
  ok(r.model.items[0].cs === 2 && !('width' in r.model.items[0].attrs) && !r.model.items[0].attrs.style, '  열이 남는 합치기(colspan 2) — 낡은 width 는 뗀다 (열 너비가 정한다)', r.model.items[0].attrs);
  // 머리글을 켰다 꺼도 칠해 둔 배경색이 남는다 · 머리글 줄을 칠해도 머리글은 그대로
  m = T([['a', 'b'], ['c', 'd']]);
  r = G.paint(m, { r0: 0, c0: 0, r1: 0, c1: 1 }, '#fbecdd');
  r = G.header(r.model, 'row', true);
  ok(G.headerOn(r.model, 'row') && r.model.items.filter((it) => it.r === 0).every((it) => /font-weight:bold/.test(it.attrs.style) && it.attrs.bgcolor === '#fbecdd'), '주황 줄에 머리글 켜기 — 굵게만 더하고 주황은 그대로', r.model.items.map((it) => it.attrs));
  r = G.header(r.model, 'row', false);
  ok(!G.headerOn(r.model, 'row') && r.model.items.filter((it) => it.r === 0).every((it) => it.attrs.bgcolor === '#fbecdd' && /background-color:#fbecdd/.test(it.attrs.style) && !/bold/.test(it.attrs.style)), '  끄면 굵게만 떼고 주황은 남는다', r.model.items.map((it) => it.attrs));
  r = G.header(m, 'row', true);
  r = G.paint(r.model, { r0: 0, c0: 0, r1: 0, c1: 1 }, '#fbf3db');
  ok(G.headerOn(r.model, 'row'), '  머리글 줄을 노랑으로 칠해도 머리글은 켜진 채 (메뉴가 «끄기»)', r.model.items.map((it) => it.attrs));
}

console.log('\n[16] 돌연변이 시험에서 나온 것');
{
  const W = (w) => ({ attrs: { width: String(w) }, style: `width:${w}px` });
  // 너비가 적힌 합친 칸(엑셀의 colspan 칸) 나누기 — 왼쪽 위 칸도 제 열 너비로 (합친 너비 200 이 남으면 표가 넓어진다)
  const m = T([[{ t: 'a', cs: 2, ...W(200) }], [{ t: 'b', ...W(120) }, { t: 'c', ...W(80) }]]);
  const r = G.split(m, 0, 0);
  ok(r.model.items[0].attrs.width === '120' && r.model.items[0].attrs.style === 'width:120px' && r.model.items[1].attrs.width === '80' && r.model.items[1].attrs.style === 'width:80px',
    '너비가 적힌 합친 칸 나누기 — 칸마다 제 열 너비 (왼쪽 위 칸도)', r.model.items.map((it) => it.attrs));
  okGrid(r.model, '  나눈 뒤');
  // 굵기만 있고 채움이 없는 첫 줄(웹 표의 th · 굵은 글)은 머리글로 안 본다 — 메뉴가 «켜기», 켜면 회색이 들어간다
  const bare = T([[{ t: 'h', tag: 'th' }, { t: 'i', style: 'font-weight:bold' }], ['a', 'b']]);
  ok(!G.headerOn(bare, 'row'), '채움 없는 굵은 첫 줄 — 머리글 꺼짐으로 본다');
  ok(G.headerOn(G.header(bare, 'row', true).model, 'row'), '  켜면 회색 채움이 들어가 켜짐');
  // 머리글 행(thead 의 th)·열을 둘 다 켠 표 — thead 아래에 넣은 줄은 tbody 의 td 가 된다. th 의 굵기는 태그 몫이라 style 에 없으니
  // 머리글 열의 첫 칸에는 굵게를 넣어야 머리글 열이 안 끊긴다
  const HF = 'background-color:#f1f1ef';
  const th = (t) => ({ t, tag: 'th', style: HF, attrs: { bgcolor: '#f1f1ef' } });
  const hb = (t) => ({ t, style: `font-weight:bold;${HF}`, attrs: { bgcolor: '#f1f1ef' } });
  const mh = T([[th('h0'), th('h1')], [hb('a'), 'b'], [hb('c'), 'd']], { secs: [{ tag: 'thead', attrs: {} }, { tag: 'tbody', attrs: {} }], rowSecs: [0, 1, 1] });
  ok(G.headerOn(mh, 'row') && G.headerOn(mh, 'col'), '(thead 머리글 행 · 머리글 열 둘 다 켰다)');
  const ir = G.insertRow(mh, 0, 'below');
  const nc = ir.model.items.find((it) => it.r === 1 && it.c === 0);
  ok(nc && nc.tag === 'td' && /font-weight:bold/.test(nc.attrs.style || '') && G.headerOn(ir.model, 'col'), '  thead 아래에 넣은 줄의 첫 칸 — td 라도 굵게 + 채움 (머리글 열 그대로)', nc && nc.attrs);
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

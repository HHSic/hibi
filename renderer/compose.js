'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// 테마와 유리 진하기는 theme.js 가 입힌다 — 메인이 정한 값(라이트 바닥 0.90)을 받고, 창을 연 뒤 테마가 바뀌어도 따라간다
document.documentElement.style.setProperty('--inset', (params.get('inset') || '12') + 'px');
document.documentElement.style.setProperty('--r', (params.get('radius') || '20') + 'px');

// { path, filename, size } — 고른 파일. 원문 첨부(복사·답장·전달)는 { id, filename, size, carried } —
// 바이트는 메인에만 있고 여기엔 id 뿐이다. 칩을 빼면 그 id 가 안 가고, 메인은 온 id 만 싣는다.
let attachments = [];
let context = null;            // 답장이면 원문 정보
let sending = false;

/** 받은 메일의 글을 인용문으로 넣을 때 — 남이 쓴 것이므로 태그로 살아나면 안 된다 */
function say(kind, text) {
  $('msg').className = 'msg' + (kind ? ' ' + kind : '');
  $('msg').textContent = text || '';
}

const fmtSize = (n) => (n > 1048576
  ? `${(n / 1048576).toFixed(1)}MB`
  : `${Math.max(1, Math.round(n / 1024))}KB`);

// 붙여넣은 그림을 어떻게 받을지 정하는 셈 — renderer/pastepick.js (compose.html 이 먼저 싣는다)
const kit = window.nunsPaste;

// 메인이 알려준다 (compose:limits). 못 받으면 서버들이 대체로 거절하는 25MB로 둔다.
let attachMax = 25 * 1024 * 1024;
let imageMax = kit.IMAGE_MAX;              // 본문 그림 하나 — 넘으면 줄여 넣는다
let draftHtmlMax = kit.DRAFT_HTML_MAX;     // 임시 저장 본문 — 넘으면 큰 그림부터 자리표로
// 본문 그림 바이트 — 첨부 합계 경고에 같이 센다 (보낼 때 메인도 같이 센다)
let inlineBytes = 0;
window.nunsseom.composeLimits?.().then((l) => {
  if (!l) return;
  if (l.imageMax) imageMax = l.imageMax;
  if (l.draftHtmlMax) draftHtmlMax = l.draftHtmlMax;
  if (l.attachMax) { attachMax = l.attachMax; renderFiles(); }
}).catch(() => {});

function renderFiles() {
  const host = $('files');
  host.textContent = '';
  for (const [i, a] of attachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'file';
    const nm = document.createElement('b');
    nm.textContent = a.filename;
    const sz = document.createElement('span');
    sz.textContent = fmtSize(a.size);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '빼기';
    del.onclick = () => { attachments.splice(i, 1); renderFiles(); };
    chip.append(nm, sz, del);
    host.append(chip);
  }
  // 합계는 넘쳤을 때만 보여준다 — 평소엔 칩만으로 충분하다.
  // 보내기를 누른 «뒤에» 알려주면, 다 쓰고 나서 되돌리게 된다.
  // 본문 그림도 메일 크기다 — 붙여넣은 캡처 몇 장이면 첨부 없이도 넘는다.
  const total = attachments.reduce((n, a) => n + (a.size || 0), 0) + inlineBytes;
  if (total > attachMax) {
    const warn = document.createElement('span');
    warn.className = 'file over';
    warn.textContent = `모두 ${fmtSize(total)}${inlineBytes ? ' (본문 그림 포함)' : ''} — ${fmtSize(attachMax)}까지만 보낼 수 있습니다`;
    host.append(warn);
  }
}

/** 이미 있는 것은 빼고 넣는다 (같은 파일을 두 번 끌어다 놔도 하나) */
function addFiles(list) {
  let added = 0;
  for (const f of list || []) {
    if (attachments.some((a) => a.path === f.path)) continue;
    attachments.push(f);
    added++;
  }
  if (added) renderFiles();
  return added;
}

// ── 서식 막대 ───────────────────────────────────────
// contenteditable + execCommand는 낡은 API지만 Chromium에서 그대로 돌고,
// 여기서 만들 것은 «메일 본문 HTML» 하나뿐이라 편집기를 새로 짜는 값을 하지 않는다.
const body = $('body');
function keepFocus(e) { e.preventDefault(); }     // 막대를 눌러도 커서를 본문에 둔다
function run(cmd, value) {
  body.focus();
  document.execCommand(cmd, false, value);
  paintBar();
}

function paintBar() {
  for (const b of document.querySelectorAll('.bar button[data-cmd]')) {
    let on = false;
    try { on = document.queryCommandState(b.dataset.cmd); } catch { on = false; }
    b.classList.toggle('on', !!on);
  }
}

for (const b of document.querySelectorAll('.bar button[data-cmd]')) {
  b.addEventListener('pointerdown', keepFocus);
  b.onclick = () => run(b.dataset.cmd);
}
for (const el of [$('color'), $('btn-image'), $('btn-link')]) {
  el.addEventListener('pointerdown', keepFocus);
}

// 글꼴·크기는 앱 목록을 띄워서 고른다 (pickfield.js). 그 목록은 별개의 창이라
// 고르는 동안 이 창이 포커스를 잃는다 — 돌아왔을 때 어디에 서식을 걸어야 하는지
// 모르면 엉뚱한 데 붙는다. 그래서 목록이 뜨기 전에 잡아둔 자리를 적어둔다.
let mark = null;
function markSpot() {
  const s = getSelection();
  mark = s && s.rangeCount && body.contains(s.getRangeAt(0).commonAncestorContainer)
    ? s.getRangeAt(0).cloneRange() : null;
}
function runAtMark(cmd, value) {
  body.focus();
  if (mark) {
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(mark);
  }
  document.execCommand(cmd, false, value);
  paintBar();
}
for (const el of [$('font'), $('size')]) el.addEventListener('pf-open', markSpot);
$('font').onchange = () => runAtMark('fontName', $('font').value);
$('size').onchange = () => runAtMark('fontSize', $('size').value);
$('color').oninput = () => run('foreColor', $('color').value);
body.addEventListener('keyup', paintBar);
body.addEventListener('mouseup', paintBar);

$('btn-link').onclick = () => {
  const url = prompt('링크 주소', 'https://');
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { say('bad', 'http/https 주소만 넣을 수 있습니다'); return; }
  run('createLink', url);
};

// ── 본문 그림 — 붙여넣기·«그림» 단추 ─────────────────────
// 화면에서는 data: 로 보이고, 보낼 때 cid 첨부로 바뀐다 (bodyForSend).
// 무엇을 받을지(글인가 그림인가, 넣을까 첨부할까)는 pastepick.js 가 정하고, 여기서는 그림을 읽고 줄여 넣는다.

/** 커서가 본문 안에 있으면 그 자리 (복사본) */
function caretRange() {
  const s = getSelection();
  if (!s || !s.rangeCount) return null;
  const r = s.getRangeAt(0);
  return body.contains(r.commonAncestorContainer) ? r.cloneRange() : null;
}

/** data: 주소를 그림으로 읽는다 — 못 읽으면 거절된 약속 */
function decodeImage(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** data: 주소의 바이트 — 움직이는 GIF 인지 볼 때만 쓴다 */
function dataBytes(url) {
  const bin = atob(String(url).slice(String(url).indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 캔버스에 다시 그려 굽는다 (JPEG 면 흰 바탕 — 투명한 곳이 검게 나오지 않게). 못 구우면 null */
function redraw(img, w, h, type, quality) {
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, w, h);
    c.toBlob((b) => {
      c.width = 0;   // 큰 캔버스 메모리를 바로 놓는다
      c.height = 0;
      resolve(b && b.type === type ? b : null);
    }, type, quality);
  });
}

/**
 * 그린 그림을 imageMax(5MB) 아래로 굽는다 — png 면 먼저 PNG 로, 넘으면 흰 바탕 JPEG 0.9 로 원래 크기부터 줄여 가며.
 * 줄여도 긴 변이 800px 아래로 가야 하면 거절한다. 붙여넣기·«그림» 단추·보낼 때(인용문의 WebP 등)가 같이 쓴다.
 * @returns { blob, mime, w } 또는 { why }
 */
async function fitImage(img, w0, h0, png) {
  if (png) {
    const b = await redraw(img, w0, h0, 'image/png');
    if (!b) return { why: kit.WHY.broken };
    if (b.size <= imageMax) return { blob: b, mime: 'image/png', w: w0 };
  }
  for (const st of kit.shrinkSteps(w0, h0)) {
    const b = await redraw(img, st.w, st.h, 'image/jpeg', 0.9);
    if (!b) return { why: kit.WHY.broken };
    if (b.size <= imageMax) return { blob: b, mime: 'image/jpeg', w: st.w };
  }
  return { why: kit.WHY.tooBig };
}

/**
 * 그림 하나를 본문에 넣을 꼴로 — 그대로 / PNG 로 바꿔 / JPEG 로 줄여 (fitImage).
 * 그림 하나는 imageMax(5MB) 아래로 — «그림» 단추와 같은 한도다.
 * 움직이는 GIF 는 펴지 않는다 (캔버스로 그리면 첫 장만 남는다).
 * @param src { kind, mime, size, blob? , dataUrl? }
 * @returns { dataUrl, mime, w, w0, shrunk? } 또는 { why }
 */
async function prepareImage(src) {
  let dataUrl = src.dataUrl;
  if (!dataUrl) dataUrl = await readDataUrl(new Blob([src.blob], { type: src.mime }));
  let img;
  try { img = await decodeImage(dataUrl); } catch { return { why: kit.WHY.broken }; }
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) return { why: kit.WHY.broken };
  if (src.kind === 'keep' && src.size <= imageMax) return { dataUrl, mime: src.mime, w: w0, w0 };
  if (src.kind === 'keep' && src.mime === 'image/gif') {
    const bytes = src.blob ? new Uint8Array(await src.blob.arrayBuffer()) : dataBytes(dataUrl);
    if (kit.gifFrames(bytes) !== 1) return { why: kit.WHY.anim };
  }
  const fit = await fitImage(img, w0, h0, src.kind === 'png');
  if (fit.why) return fit;
  const out = { dataUrl: await readDataUrl(fit.blob), mime: fit.mime, w: fit.w, w0 };
  // «줄였다»는 말은 실제로 작아졌을 때만 — WebP 를 PNG 로 바꾸다 5MB 를 넘어 JPEG 가 되면 원래보다 커지기도 한다
  if (fit.mime === 'image/jpeg' && fit.blob.size < src.size) out.shrunk = { from: src.size, to: fit.blob.size };
  return out;
}

// 이 창에서 붙인 그림 이름 — 같은 초에 두 번 붙여도 «붙여넣은 그림 …»이 겹치지 않게
const namesUsed = new Set();

/**
 * 넣을 그림들을 차례로 읽고 줄여 <img> 로 — 여러 장을 한꺼번에 펴면 큰 캔버스가 겹친다.
 * @param items [{ src, label, bitmap, screen, hasPath, from, file? }]
 *   bitmap — 클립보드 그림 (이름을 지어 붙인다) · screen — 캡처 도구 그림 (화면 배율만큼 width 를 줄인다)
 *   from — 'clip'(클립보드에만 있음) · 'disk'(디스크의 파일) — 못 넣을 때 하는 안내가 다르다 (kit.hintFor)
 * @returns { html, pics: [{ src, name, width }], attach: [File] } — 알림에 쓸 것은 res 에 쌓는다 (kit.summary)
 */
async function picturesHtml(items, res) {
  // 이름은 다 줄인 «뒤에» 짓는다 — 잇달아 붙인 두 붙여넣기가 같이 줄이는 중이면 시작할 때 본 목록에는 서로가 없다.
  // namesUsed 는 지을 때마다 바로 보므로 겹치지 않는다
  const inBody = new Set([...body.querySelectorAll('img[data-name]')].map((i) => i.getAttribute('data-name')));
  const taken = { has: (n) => namesUsed.has(n) || inBody.has(n) };
  const pics = [];
  const attach = [];
  for (const it of items) {
    const got = await prepareImage(it.src).catch(() => ({ why: kit.WHY.broken }));
    if (got.why) {
      // 못 넣는 그림 — 디스크의 파일이면 첨부로 (끌어다 놓기와 같은 길), 아니면 까닭과 따를 수 있는 안내를 말한다
      if (it.file && kit.fallback(it.hasPath, got.why).action === 'attach') attach.push(it.file);
      else res.refused.push({ name: it.label, why: got.why, hint: kit.hintFor(got.why, it.from) });
      continue;
    }
    const ext = got.mime === 'image/jpeg' ? 'jpg' : got.mime === 'image/gif' ? 'gif' : 'png';
    const name = it.bitmap ? kit.pastedName(new Date(), ext, taken) : kit.nameFor(it.src.name, got.mime);
    namesUsed.add(name);
    // 화면 배율이 1보다 큰 화면의 캡처는 픽셀이 배율만큼 많다 — 화면에서 본 크기로 보이게 width 를 준다.
    // 캡처 도구 그림(HTML 없이 비트맵만)에만 — 브라우저 «이미지 복사»·워드 그림은 원래 픽셀이라 그대로 둔다
    const dpr = window.devicePixelRatio || 1;
    const width = it.screen && dpr > 1 ? Math.min(got.w, Math.round(got.w0 / dpr)) : 0;
    pics.push({ src: got.dataUrl, name, width });
    res.inlined += 1;
    if (got.shrunk) res.shrunk.push(got.shrunk);
  }
  const html = pics.map((p) => `<img src="${p.src}" data-name="${kit.escAttr(p.name)}"${p.width ? ` width="${p.width}"` : ''}>`).join('');
  return { html, pics, attach };
}

/** 붙여넣기에서 못 넣은 파일을 첨부로 — 끌어다 놓기와 같은 길이라 메인의 «고른 것만 보낸다» 잠금이 그대로 산다 */
async function attachPasted(files, res) {
  if (!files.length) return;
  const r = await window.nunsseom.composeDropFiles(files).catch(() => null);
  if (!r) {
    for (const f of files) res.refused.push({ name: kit.labelFor(f.name, 'file', false), why: '첨부하지 못했습니다', hint: '' });
    return;
  }
  const added = addFiles(r.files);
  res.attached += added;
  if (!added && r.files && r.files.length) res.already = true;
  // 메인이 뺀 것(폴더 등) — «파일 첨부»로도 안 되니 안내는 달지 않는다
  for (const s of r.skipped || []) res.refused.push({ name: s.name, why: s.why, hint: '' });
}

// ── 붙이는 중인 그림 ──
// 큰 그림은 읽고 줄이는 데 1~2초 걸린다. 붙이는 순간 커서 자리에 «그림 넣는 중…» 표식을 넣고, 다 되면 그 표식을 그림으로 바꾼다.
// 자리를 Range 로 들고 기다리면 그사이 같은 줄에 글이 들어와 글자 노드가 쪼개질 때 엉뚱한 데로 접혔다 —
// 표식은 편집을 따라 같이 움직인다. 커서는 표식 뒤에 둔다: 이어 치는 글·다음 붙여넣기는 그림 뒤로 간다.
// 표식은 노드가 아니라 번호(data-paste-slot)로 찾는다 — 크로미움의 execCommand 는 넣은 자리 뒤의 같은 줄을
// 새 노드로 다시 지어서, 들고 있던 노드는 떨어져 나간다 (실측). 번호 같은 속성은 그대로 따라온다.
const pasteJobs = new Set();        // 아직 본문에 안 들어간 붙여넣기 — 있는 동안은 보내지도 닫지도 않는다
let pasteChain = Promise.resolve();
let slotSeq = 0;
// 한글 입력 중(조합 중)에 커서를 옮기면 치던 글자가 깨진다 — 그때는 커서를 건드리지 않고 넣는다 (place)
let composing = false;
body.addEventListener('compositionstart', () => { composing = true; });
body.addEventListener('compositionend', () => { composing = false; });

const slotOf = (id) => (id ? body.querySelector(`img[data-paste-slot="${id}"]`) : null);
// 그림이 들어가면 없앨 이어 쓰기 자리표 — 붙인 순간 번호를 달아 둔다 (data-pic-take)
const holeOf = (id) => (id ? body.querySelector(`[data-pic-gone][data-pic-take="${id}"]`) : null);

/** «그림 넣는 중…» 표식 노드 — kit.slotHtml 과 같은 꼴 (execCommand 가 표식을 떨어뜨렸을 때 손으로 넣는 몫) */
function slotNode(id) {
  const s = document.createElement('img');
  s.className = 'pasting';
  s.setAttribute('data-paste-slot', String(id));
  s.alt = '그림 넣는 중…';
  s.src = kit.SLOT_SRC;
  return s;
}

/** 커서가 이어 쓰기 자리표(그림 자리) 안이나 바로 앞·뒤에 있으면 그 자리표 */
function holeAt(r) {
  const el = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const inside = el(r.startContainer) && el(r.startContainer).closest('[data-pic-gone]');
  if (inside && body.contains(inside)) return inside;
  const c = r.startContainer;
  const o = r.startOffset;
  let prev = null;
  let next = null;
  if (c.nodeType === 3) {
    if (o === 0) prev = c.previousSibling;
    if (o === c.length) next = c.nextSibling;
  } else {
    prev = c.childNodes[o - 1] || null;
    next = c.childNodes[o] || null;
  }
  const is = (n) => !!n && n.nodeType === 1 && n.matches('[data-pic-gone]');
  return is(prev) ? prev : is(next) ? next : null;
}

/**
 * 붙일 자리에 «그림 넣는 중…» 표식을 넣는다 — 되돌리기(Ctrl+Z)에 실리게 execCommand 로.
 * 고른 글이 있으면 그 글을 바꾼다. 커서가 이어 쓰기 자리표(그림 자리) 안이나 바로 옆이면, 그림이 들어갈 때
 * 그 자리표를 없앤다 (자리표의 안내대로 «그 자리에 다시 붙이면» 그림이 된다).
 * @param range 넣을 자리 (없으면 지금 커서, 그것도 본문 밖이면 본문 맨 앞)
 * @returns 표식 번호
 */
function makeSlot(range) {
  const sel = getSelection();
  let r = range && body.contains(range.startContainer) ? range : caretRange();
  if (!r) {
    body.focus();
    r = caretRange();
  }
  if (!r) {
    r = document.createRange();
    r.selectNodeContents(body);
    r.collapse(true);
  }
  const id = ++slotSeq;
  const hole = r.collapsed ? holeAt(r) : null;
  if (hole) {
    hole.setAttribute('data-pic-take', String(id));
    // 예전 자리표(편집되던 것) 안에 커서가 있었으면 그 바로 뒤로 — 자리표를 없앨 때 그림까지 같이 지워지지 않게
    if (hole.contains(r.startContainer)) {
      r = document.createRange();
      r.setStartAfter(hole);
      r.collapse(true);
    }
  }
  if (document.activeElement !== body) body.focus();
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand('insertHTML', false, kit.slotHtml(id));
  let slot = slotOf(id);
  if (!slot) {
    // 크로미움이 표식을 떨어뜨렸으면 손으로 넣는다 (이때는 되돌리기에 안 실린다)
    slot = slotNode(id);
    const here = caretRange() || r;
    here.deleteContents();
    here.insertNode(slot);
  }
  const after = document.createRange();
  after.setStartAfter(slot);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  return id;
}

/** 커서가 표식 바로 뒤인가 (붙이고 그대로 기다린 경우) — 같은 자리를 가리키는 두 꼴을 다 본다 */
function rightAfter(r, slot) {
  if (!r.collapsed) return false;
  const c = r.startContainer;
  if (c === slot.parentNode) return c.childNodes[r.startOffset - 1] === slot;
  return c.nodeType === 3 && r.startOffset === 0 && c.previousSibling === slot;
}

// 줄(문단) — 커서와 표식이 다른 줄이면 execCommand 가 다시 짓는 «표식 뒤의 같은 줄»에 커서가 없다
const LINE = 'div,p,li,blockquote,pre,td,th,h1,h2,h3,h4,h5,h6';
function lineOf(n) {
  const e = n && (n.nodeType === 1 ? n : n.parentElement);
  const b = e && e.closest(LINE);
  return b && body.contains(b) ? b : body;
}
function otherLine(r, slot) {
  const a = lineOf(r.startContainer);
  const b = lineOf(slot);
  return a !== b && !a.contains(b) && !b.contains(a);
}

/**
 * 표식 자리에 그림을 넣는다. 사용자가 그사이 옮겨 간 커서·칸은 그대로 둔다 — 그림이 들어오는 순간 커서가 튀지 않게.
 *   · 본문에서 커서가 표식 바로 뒤(붙이고 기다림)거나 다른 줄이면 execCommand 로 넣는다 — 되돌리기(Ctrl+Z)에 실린다.
 *     크로미움은 넣은 자리 뒤의 같은 줄을 새로 지으므로, 그 줄 안에 커서가 있으면 이 길을 안 쓴다
 *   · 그 밖(같은 줄의 다른 자리, 제목·받는 사람 칸, 한글 조합 중)은 표식 노드를 그림으로 바꾼다 — 커서·포커스가 그대로다
 * 그림이 들어가면 붙인 자리의 이어 쓰기 자리표도 없앤다.
 * @param out { html, pics } — picturesHtml 의 답
 * @returns 넣었나 — 표식이 지워졌으면(그 자리를 지웠다·되돌렸다) false
 */
function place(id, out) {
  const slot = slotOf(id);
  if (!slot) {
    const h = holeOf(id);
    if (h) h.removeAttribute('data-pic-take');
    return false;
  }
  if (out.html) {
    const sel = getSelection();
    const keep = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const waited = !!keep && rightAfter(keep, slot);
    if (document.activeElement === body && !composing && keep && (waited || otherLine(keep, slot))) {
      const at = document.createRange();
      at.setStartBefore(slot);
      at.collapse(true);
      sel.removeAllRanges();
      sel.addRange(at);
      document.execCommand('insertHTML', false, out.html);
      const left = slotOf(id);
      if (left) left.remove();
      // 기다리던 사람의 커서는 execCommand 가 둔 자리(그림 바로 뒤)가 맞다 — 다른 줄에 있던 커서만 되돌린다
      if (!waited && body.contains(keep.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(keep);
      }
    } else {
      const imgs = (out.pics || []).map((p) => {
        const i = document.createElement('img');
        i.src = p.src;
        i.setAttribute('data-name', p.name);
        if (p.width) i.setAttribute('width', String(p.width));
        return i;
      });
      slot.replaceWith(...imgs);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const h = holeOf(id);
    if (h) h.remove();
  } else {
    slot.remove();
    const h = holeOf(id);
    if (h) h.removeAttribute('data-pic-take');
  }
  return true;
}

/** 주인 없는 표식을 치운다 — 다 끝난 뒤 되돌리기·다시 하기로 살아난 «그림 넣는 중…», 남은 자리표 번호 */
function sweepSlots() {
  const live = new Set([...pasteJobs].map((j) => String(j.slot)).filter((v) => v !== '0'));
  for (const s of body.querySelectorAll('[data-paste-slot]')) if (!live.has(s.getAttribute('data-paste-slot'))) s.remove();
  for (const h of body.querySelectorAll('[data-pic-take]')) if (!live.has(h.getAttribute('data-pic-take'))) h.removeAttribute('data-pic-take');
}

/** 본문을 통째로 갈아 끼울 때 (다른 초안·새로 쓰기) — 기다리던 붙여넣기는 넣지 않고 말도 하지 않는다 */
function dropPending() {
  for (const j of pasteJobs) j.cancelled = true;
}

/**
 * 붙여넣기 하나를 차례에 올린다. 그림을 읽고 줄이는 일은 바로 시작하고, 표식을 그림으로 바꾸는 것은 붙인 차례대로.
 * @param prepare (job) => Promise<{ html?, pics?, finish?(placed) }> — «그림» 단추는 고른 뒤에 job.slot 을 단다
 * @param slot 붙인 순간 넣어 둔 표식의 번호 (makeSlot) — 0 이면 표식 없음
 */
function queuePaste(prepare, slot = 0) {
  const job = { slot, cancelled: false };
  pasteJobs.add(job);
  const ready = Promise.resolve().then(() => prepare(job)).catch(() => ({ failed: true }));
  pasteChain = pasteChain
    .then(async () => {
      const out = (await ready) || {};
      if (job.cancelled || out.failed) {
        const s = slotOf(job.slot);
        if (s) s.remove();
        if (out.failed && !job.cancelled) say('bad', '붙이지 못했습니다');
        return;
      }
      const placed = job.slot ? place(job.slot, out) : !out.html;
      if (out.finish) await out.finish(placed);
    })
    .catch(() => say('bad', '붙이지 못했습니다'))
    .finally(() => {
      pasteJobs.delete(job);
      // 그림이 들어가며 흩어진 «그림 자리» 번호 같은 것이 남지 않게
      if (!pasteJobs.size) sweepSlots();
    });
}

/** 표식을 지워 그림이 안 들어갔으면 알림에서도 뺀다 */
function notPlaced(res) {
  res.dropped = res.inlined ? 1 : 0;
  res.inlined = 0;
  res.shrunk = [];
}

/** 클립보드의 파일들 — items 와 files 양쪽에 같은 것이 오기도 한다 (하나로) */
function clipFiles(cd) {
  const out = [];
  const seen = new Set();
  const put = (f) => {
    if (!f) return;
    const key = `${f.name}\n${f.size}\n${f.type}`;
    if (out.includes(f) || seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const it of Array.from(cd.items || [])) if (it.kind === 'file') put(it.getAsFile());
  for (const f of Array.from(cd.files || [])) put(f);
  return out;
}

/** 파일마다 디스크의 진짜 파일인가 (preload — 경로 글자는 안 받는다). 모르면 아니라고 본다 */
function filesHavePath(files) {
  try {
    const r = window.nunsseom.composeFileHasPath?.(files);
    return Array.isArray(r) ? files.map((_f, i) => !!r[i]) : files.map(() => false);
  } catch { return files.map(() => false); }
}

/** 본문 그림 바이트를 다시 센다 — 바뀌었으면 첨부 합계 경고도 다시 그린다 */
function countInline() {
  const n = kit.inlineBytes([...body.querySelectorAll('img:not([data-paste-slot])')].map((i) => i.getAttribute('src') || ''));
  if (n !== inlineBytes) { inlineBytes = n; renderFiles(); }
}
// 그림을 넣거나 지우면 input 이 온다 — 글자를 칠 때마다 세지 않게 손이 멈추면 센다
let countTimer = null;
body.addEventListener('input', (e) => {
  // 되돌리기(Ctrl+Z)로 그림을 빼면 크로미움이 그 자리의 «그림 넣는 중…» 표식까지 되살린다 — 다 끝난 붙여넣기의 것이면 바로 치운다
  if (e.inputType && e.inputType.startsWith('history')) sweepSlots();
  clearTimeout(countTimer);
  countTimer = setTimeout(() => { sweepSlots(); countInline(); }, 300);
});

$('btn-image').onclick = () => {
  // 고르는 동안(대화상자) 본문은 못 만진다 — 누른 순간의 커서 자리를 들고 있다가, 그림이 오면 거기에 «그림 넣는 중…»을 놓는다
  const here = caretRange();
  queuePaste(async (job) => {
    const got = await window.nunsseom.composePickImage();
    // 예전 꼴(배열)도 받는다
    const images = Array.isArray(got) ? got : (got && got.images) || [];
    const res = { inlined: 0, shrunk: [], attached: 0, refused: [], dropped: 0 };
    // 메인이 뺀 것 (너무 큼·못 읽음·한 번에 너무 많음) — 까닭이 곧 안내다
    for (const s of (got && !Array.isArray(got) && got.skipped) || []) res.refused.push({ name: s.name, why: s.why, hint: '' });
    if (!images.length && !res.refused.length) return {};
    if (images.length) {
      job.slot = makeSlot(here);
      say('', '그림을 넣는 중…');
    }
    const pics = await picturesHtml(images.map((im) => ({
      src: {
        name: im.filename, kind: kit.kindOf(im.contentType, im.filename), mime: kit.mimeOf(im.contentType, im.filename),
        size: im.size || kit.dataUrlBytes(im.dataUrl), dataUrl: im.dataUrl
      },
      label: kit.safeName(im.filename), bitmap: false, screen: false, hasPath: false, from: 'disk'
    })), res);
    return {
      html: pics.html,
      pics: pics.pics,
      finish: (placed) => {
        if (!placed) notPlaced(res);
        const s = kit.summary(res);
        say(s.kind, s.text);
      }
    };
  });
};

// 붙여넣기 — 글이 있으면 글만 (엑셀 칸·워드 글을 복사하면 그 모양을 찍은 그림도 같이 오는데, 그건 버린다).
// 글 없이 그림만 왔으면(화면 캡처·«이미지 복사») 본문 그림으로. 남이 만든 HTML 은 절대 넣지 않는다 —
// 남의 스타일과 바깥 그림 주소까지 딸려 들어와 메일이 깨지고, 바깥 주소는 열어 본 사실을 흘린다.
body.addEventListener('paste', (e) => {
  e.preventDefault();
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  const text = cd.getData('text/plain') || '';
  const html = cd.getData('text/html') || '';
  const files = clipFiles(cd);
  const paths = files.length ? filesHavePath(files) : [];
  const plan = kit.decide({
    text, html, files: files.map((f, i) => ({ type: f.type, name: f.name, size: f.size, hasPath: paths[i] }))
  });
  if (plan.mode === 'text') {
    // 글은 바로 커서 자리에 — 앞 그림이 아직 줄이는 중이어도 그 자리(«그림 넣는 중…»)는 노드라 섞이지 않는다
    if (plan.text) document.execCommand('insertText', false, plan.text);
    else if (plan.urlOnly) say('bad', kit.WHY.urlOnly);
    return;
  }
  const res = { inlined: 0, shrunk: [], attached: 0, refused: [], dropped: 0 };
  const labelOf = (it) => kit.labelFor(files[it.index].name, it.kind, paths[it.index]);
  const inline = plan.items.filter((it) => it.action === 'inline');
  // 붙인 자리는 지금 정한다 — «그림 넣는 중…» 표식을 넣고 커서는 그 뒤로
  const slot = inline.length ? makeSlot() : 0;
  if (inline.length) say('', '그림을 붙이는 중…');
  queuePaste(async () => {
    const attach = plan.items.filter((it) => it.action === 'attach').map((it) => files[it.index]);
    for (const it of plan.items) if (it.action === 'refuse') res.refused.push({ name: labelOf(it), why: it.why, hint: it.hint });
    const pics = await picturesHtml(inline.map((it) => {
      const f = files[it.index];
      return {
        src: { name: f.name, kind: it.kind, mime: it.mime, size: f.size, blob: f },
        label: labelOf(it), bitmap: !paths[it.index] && kit.isGenericName(f.name), screen: !!it.screen,
        hasPath: !!paths[it.index], file: f, from: 'clip'
      };
    }), res);
    return {
      html: pics.html,
      pics: pics.pics,
      finish: async (placed) => {
        if (!placed) notPlaced(res);
        await attachPasted([...attach, ...pics.attach], res);
        const s = kit.summary(res);
        if (s.text) say(s.kind, s.text);
        else if (inline.length) say('', '');
      }
    };
  }, slot);
});

/**
 * 그려서 보낼 꼴로 — PNG 로 굽고, 5MB 를 넘으면 JPEG 로 줄인다 (fitImage — 붙여넣기와 같은 길).
 * 인용문의 3000×2000 WebP 사진(289KB)을 원래 크기 PNG 로 구우면 14MB 가 되어 메인이 보내기를 통째로 거절했다.
 * 못 그리거나 줄여도 안 되면 null (빼고 보낸 뒤 알린다). 움직이는 GIF 는 펴면 첫 장만 남으니 null.
 */
async function redrawPart(src, gif) {
  try {
    const img = await decodeImage(src);
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) return null;
    if (gif && kit.gifFrames(dataBytes(src)) !== 1) return null;
    const fit = await fitImage(img, w0, h0, true);
    if (fit.why) return null;
    const url = await readDataUrl(fit.blob);
    return { contentType: fit.mime, base64: url.slice(url.indexOf(',') + 1) };
  } catch { return null; }
}

/**
 * 보낼 수 있는 형식으로 — PNG·JPEG·GIF 는 그대로(별칭만 맞춘다), 그 밖에 크로미움이 그리는 것
 * (인용문·서명에 담겨 온 WebP·BMP·SVG …)과 5MB 를 넘는 것은 다시 굽는다 (redrawPart).
 * 메인은 PNG·JPEG·GIF, 하나 5MB 남짓까지만 받는다 (composewin inlineOf).
 */
async function sendablePart(type, b64) {
  const clean = b64.replace(/\s+/g, '');
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, '=');
  const t = kit.sendableType(type);
  if (t && kit.dataUrlBytes(`data:${t};base64,${padded}`) <= imageMax) return { contentType: t, base64: padded };
  return redrawPart(`data:${type || 'image/png'};base64,${clean}`, t === 'image/gif');
}

/**
 * 본문 HTML에서 data: 그림을 떼어내 cid 첨부로 바꾼다.
 * 그림마다 max-width:100%;height:auto 를 원래 style 에 더한다 — 웹메일에서 창보다 넓은 캡처가 삐져나오지 않게
 * (width 속성은 그대로 — 화면 배율로 맞춘 크기를 지킨다).
 * @returns { html, text, inline, gone } — gone 은 보낼 수 없는 형식이라 뺀 그림 수
 */
async function bodyForSend() {
  // cloneNode로 만들면 복제된 <img>가 cid: 주소를 진짜로 불러오려 들어 콘솔이 더러워진다.
  // DOMParser로 뜬 문서는 그림을 부르지 않는다 — 고쳐 쓰기에만 쓴다.
  const doc = new DOMParser().parseFromString(
    `<body>${body.innerHTML}</body>`, 'text/html');
  const clone = doc.body;
  // «그림 넣는 중…» 표식은 안 보낸다 (붙이는 중에는 보내기를 막지만, 되돌리기로 살아난 것이 남았을 수 있다)
  for (const s of [...clone.querySelectorAll('[data-paste-slot]')]) s.remove();
  const inline = [];
  // 같은 그림(서명 로고처럼 인용문에 두 번 나오는 것)은 cid 하나로 — 그림마다 새로 달면 같은 바이트가 여러 번 실린다
  const cidOf = new Map();
  let n = 0;
  let gone = 0;
  for (const img of [...clone.querySelectorAll('img')]) {
    const src = (img.getAttribute('src') || '').trim();
    if (!/^data:/i.test(src)) continue;
    if (!cidOf.has(src)) {
      // data:형식[;매개변수…];base64,자료 — 인용문에는 «;name=a.png» 같은 매개변수가 붙은 꼴도 온다.
      // base64 가 아닌 꼴(data:image/svg+xml,<svg…>)은 그려서 PNG 로. 어느 꼴이든 html 에 data: 를 남기지 않는다
      const m = src.match(/^data:([^;,]*)((?:;[^;,]*)*?);base64,([\s\S]*)$/i);
      const part = m ? await sendablePart(m[1], m[3]) : await redrawPart(src, false);
      if (part) {
        n += 1;
        const cid = `img${n}@hibi`;
        const ext = part.contentType === 'image/jpeg' ? 'jpg' : part.contentType.split('/')[1];
        const given = img.getAttribute('data-name');
        inline.push({
          cid, contentType: part.contentType, base64: part.base64,
          // 이름은 다듬고(방향 바꾸는 글자 등은 뺀다) 확장자는 형식에 맞춘다 — 메인이 받는 꼴로
          filename: given ? kit.nameFor(given, part.contentType) : `그림${n}.${ext}`
        });
        cidOf.set(src, cid);
      } else {
        cidOf.set(src, null);
      }
    }
    const cid = cidOf.get(src);
    if (!cid) { img.remove(); gone += 1; continue; }
    img.setAttribute('src', `cid:${cid}`);
    img.removeAttribute('data-name');
    if (!img.style.maxWidth) img.style.maxWidth = '100%';
    if (!img.style.height) img.style.height = 'auto';
  }
  return {
    html: `<div style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:14px;`
      + `line-height:1.65;color:#1a1a1a">${clone.innerHTML}</div>`,
    text: plainText(),
    inline,
    gone
  };
}

// ── 주소록 ──────────────────────────────────────────
// 보낸 주소와 받은 메일의 보낸 사람이 자동으로 쌓인다. 손으로 채우게 하면 아무도 안 채운다.
// 찾기는 이름으로도 된다 — 주소를 외우는 사람은 없다.
let contacts = [];
window.nunsseom.mailContacts().then((l) => { contacts = l || []; });

/** 지금 커서가 있는 항목 (쉼표로 나뉜 것 중 마지막) */
function currentTerm(input) {
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const start = Math.max(upto.lastIndexOf(','), upto.lastIndexOf(';')) + 1;
  return { start, text: upto.slice(start).trim() };
}

function search(term) {
  const q = term.toLowerCase();
  if (!q) return [];
  return contacts
    .filter((c) => c.address.includes(q) || String(c.name || '').toLowerCase().includes(q))
    .sort((a, b) => {
      // 이름이 그 글자로 시작하는 사람을 먼저 — «김»을 치면 김부장이 위로
      const as = String(a.name || '').toLowerCase().startsWith(q) ? 0 : 1;
      const bs = String(b.name || '').toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || (b.used || 1) - (a.used || 1);
    })
    .slice(0, 8);
}

function bindBook(inputId, boxId) {
  const input = $(inputId);
  const box = $(boxId);
  let hits = [];
  let at = -1;

  const close = () => { box.classList.remove('on'); box.textContent = ''; at = -1; };

  const put = (c) => {
    const { start } = currentTerm(input);
    const after = input.value.slice(input.selectionStart ?? input.value.length);
    const head = input.value.slice(0, start);
    input.value = `${head}${head && !/[,;]\s*$/.test(head) ? ', ' : ''}${c.address}, ${after.trim()}`
      .replace(/,\s*$/, ', ');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    close();
  };

  const paint = () => {
    box.textContent = '';
    hits.forEach((c, i) => {
      const it = document.createElement('div');
      it.className = 'it' + (i === at ? ' on' : '');
      const b = document.createElement('b');
      b.textContent = c.name || c.address;
      const s = document.createElement('span');
      s.textContent = c.name ? c.address : '';
      it.append(b, s);
      // mousedown이어야 한다 — click은 blur가 먼저 나서 목록이 닫힌 뒤에 온다
      it.addEventListener('mousedown', (e) => { e.preventDefault(); put(c); });
      box.append(it);
    });
    box.classList.toggle('on', hits.length > 0);
  };

  input.addEventListener('input', () => {
    hits = search(currentTerm(input).text);
    at = hits.length ? 0 : -1;
    paint();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!box.classList.contains('on')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); at = (at + 1) % hits.length; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); at = (at - 1 + hits.length) % hits.length; paint(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (at >= 0) { e.preventDefault(); put(hits[at]); }
    } else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
}
bindBook('to', 'book-to');
bindBook('cc', 'book-cc');
bindBook('bcc', 'book-bcc');

// ── 주소록에서 골라 넣기 ─────────────────────────
// 타이핑으로 찾는 것만으로는 «누가 있었더라»가 안 풀린다. 목록을 펴놓고 고르게 한다.
const chosen = new Set();

function addTo(fieldId, list) {
  const input = $(fieldId);
  const have = input.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  for (const a of list) if (!have.includes(a)) have.push(a);
  input.value = have.join(', ') + (have.length ? ', ' : '');
  if (fieldId !== 'to') {
    $('row-cc').classList.remove('hide');
    $('row-bcc').classList.remove('hide');
    $('btn-cc').style.display = 'none';
  }
}

function paintPicker() {
  const host = $('pk-list');
  const q = $('pk-find').value.trim().toLowerCase();
  const hits = contacts
    .filter((c) => !q || c.address.includes(q) || String(c.name || '').toLowerCase().includes(q))
    .sort((a, b) => (b.used || 1) - (a.used || 1) || b.at - a.at)
    .slice(0, 200);

  host.textContent = '';
  if (!hits.length) {
    const p = document.createElement('div');
    p.className = 'none';   // 모양은 compose.html .plist .none
    p.textContent = contacts.length
      ? '찾는 사람이 없습니다'
      : '주소록이 비어 있습니다';
    host.append(p);
  }
  for (const c of hits) {
    const row = document.createElement('div');
    row.className = 'prow' + (chosen.has(c.address) ? ' on' : '');
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = chosen.has(c.address) ? '✓' : '';
    const who = document.createElement('span');
    who.className = 'who';
    const nm = document.createElement('b');
    nm.textContent = c.name || c.address;
    const ad = document.createElement('span');
    ad.textContent = c.name ? c.address : '';
    who.append(nm, ad);
    row.append(mark, who);
    row.onclick = () => {
      if (chosen.has(c.address)) chosen.delete(c.address); else chosen.add(c.address);
      paintPicker();
    };
    // 한 명만 넣을 때 두 번 클릭이면 끝난다
    row.ondblclick = () => { chosen.add(c.address); putChosen('to'); };
    host.append(row);
  }
  $('pk-cnt').textContent = chosen.size ? `${chosen.size}명 골랐습니다` : '고른 사람 없음';
}

function putChosen(where) {
  if (!chosen.size) { $('pk-find').focus(); return; }
  addTo(where, [...chosen]);
  chosen.clear();
  $('picker').classList.remove('on');
  $('pk-find').value = '';
}

$('btn-open-book').onclick = () => {
  chosen.clear();
  $('pk-find').value = '';
  paintPicker();
  $('picker').classList.add('on');
  $('pk-find').focus();
};
$('pk-close').onclick = () => { $('picker').classList.remove('on'); chosen.clear(); };
$('pk-find').oninput = paintPicker;
$('pk-find').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); putChosen('to'); }
};
for (const b of document.querySelectorAll('.pfoot [data-put]')) {
  b.onclick = () => putChosen(b.dataset.put);
}

/**
 * 붙여넣은·저장된 HTML에서 «실행되는 것»을 걷어낸다.
 * 서명은 웹메일에서 통째로 복사해 오는 일이 많고, 이 창에는 메일 보내기와
 * 파일 첨부가 달려 있다 — 거기 딸려 온 스크립트가 돌면 안 된다.
 */
function cleanPasted(input) {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(link|meta|base)\b[^>]*>/gi, '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ')
    .replace(/(href|src|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'")
    .replace(/(href|src|xlink:href)\s*=\s*javascript:[^\s>]*/gi, '$1="#"');
}

/**
 * 글로만 읽는 곳으로 나갈 몫.
 *
 * 화면에서는 인용문에 세로줄을 그어 구분하지만, 글에는 선을 그을 수 없다.
 * 글로 받는 쪽에서는 «> »가 그 자리를 대신한다 — 이게 없으면 내가 쓴 글과
 * 남이 쓴 글이 한 덩어리로 붙어버린다.
 */
function plainText() {
  let text = (body.innerText || '').trim();
  for (const q of body.querySelectorAll('blockquote')) {
    const raw = (q.innerText || '').trim();
    if (!raw) continue;
    const marked = raw.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
    // 첫 자리만 바꾼다. 인용문의 글 그대로를 찾는 것이라 엉뚱한 데가 걸릴 일은 없다.
    text = text.replace(raw, () => marked);
  }
  return text;
}

/** 여러 줄 글을 글자 노드로만 넣는다 — 남이 쓴 글 안의 태그가 살아날 자리를 없앤다 */
function linesInto(host, text) {
  String(text || '').split('\n').forEach((line, i) => {
    if (i) host.append(document.createElement('br'));
    host.append(document.createTextNode(line));
  });
  return host;
}

/*
 * 인용문에 살려둘 태그와 속성.
 *
 * cleanPasted는 «위험한 것을 지우는» 방식이다. 지우는 쪽은 빠뜨린 모양이 하나라도 있으면
 * 그대로 샌다. 인용문은 남이 보낸 글이므로 반대로 간다 — 여기 적힌 것만 새로 지어 올리고,
 * 나머지는 애초에 만들지 않는다. 회사 메일 서명이 표·색·굵기로 짜여 있어서 이만큼은 살린다.
 */
const QUOTE_TAGS = new Set([
  'DIV', 'P', 'SPAN', 'BR', 'HR', 'PRE', 'CODE', 'BLOCKQUOTE', 'CENTER',
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUP', 'SUB', 'SMALL', 'FONT',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL',
  'A', 'IMG'
]);
const QUOTE_ATTRS = new Set([
  'style', 'align', 'valign', 'width', 'height', 'colspan', 'rowspan',
  'bgcolor', 'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing', 'span'
]);

/** 인용문 안의 링크 — 사람이 눌러서 갈 수 있는 곳만 */
function quoteHref(v) {
  return /^\s*(https?:|mailto:)/i.test(String(v || '')) ? String(v).trim() : '';
}

/** 인용문 안의 그림 — 메일에 담겨 온 것(data:)만. 바깥 주소는 열어본 사실을 흘린다. */
function quoteSrc(v) {
  return /^\s*data:image\//i.test(String(v || '')) ? String(v).trim() : '';
}

/** style 속성 — 바깥을 부르거나 창 밖으로 삐져나오는 것만 걷어낸다 */
function quoteStyle(v) {
  const s = String(v || '');
  if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:|position\s*:\s*(fixed|absolute)/i.test(s)) {
    return s.replace(/(url\s*\([^)]*\)|expression\s*\([^)]*\))/gi, '')
      .replace(/(behavior|position)\s*:[^;]*;?/gi, '');
  }
  return s;
}

/**
 * 남이 보낸 HTML을 허락한 것만 골라 다시 지어 host 안에 넣는다.
 *
 * DOMParser는 글을 문서로 읽기만 한다 — 스크립트를 돌리지도, 그림을 받아오지도 않는다.
 * 목록에 없는 태그는 껍데기만 벗기고 안쪽 글은 살린다. 표 하나 때문에 본문이 통째로
 * 사라지면 인용문의 뜻이 없다.
 */
function quoteInto(host, html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const copy = (src, into) => {
    for (const node of src.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        into.append(document.createTextNode(node.nodeValue));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName.toUpperCase();
      if (!QUOTE_TAGS.has(tag)) {
        // 안쪽 글만 건져 올린다. 단 이 셋은 안쪽이 «글»이 아니라 코드다.
        if (!['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(tag)) copy(node, into);
        continue;
      }
      const el = document.createElement(tag.toLowerCase());
      for (const at of node.attributes) {
        const name = at.name.toLowerCase();
        const val = name === 'style' ? quoteStyle(at.value)
          : name === 'href' && tag === 'A' ? quoteHref(at.value)
            : name === 'src' && tag === 'IMG' ? quoteSrc(at.value)
              : name === 'alt' && tag === 'IMG' ? at.value
                : QUOTE_ATTRS.has(name) ? at.value : '';
        if (val) el.setAttribute(name, val);
      }
      // 주소가 살아남지 못한 그림은 빈 네모로 남는다 — 아예 넣지 않는다
      if (tag === 'IMG' && !el.getAttribute('src')) continue;
      copy(node, el);
      into.append(el);
    }
  };
  copy(doc.body, host);
  return host;
}

/**
 * 서명 — 본문 끝에 붙인다. 답장이면 인용문 위에 온다.
 * 서식 있는 HTML이다 (웹메일에서 복사해 온 색·표·그림이 그대로 들어 있다).
 * 옛 서명은 그냥 글이었으므로 태그가 없으면 줄바꿈만 살려 넣는다.
 */
function signatureNode(sig) {
  const raw = String(sig || '').trim();
  if (!raw) return null;
  const wrap = document.createElement('div');
  wrap.className = 'sig';
  wrap.append(document.createElement('br'));

  if (/<[a-z!/]/i.test(raw)) {
    const holder = document.createElement('div');
    holder.innerHTML = cleanPasted(raw);
    wrap.append(holder);
  } else {
    raw.split('\n').forEach((l) => {
      const d = document.createElement('div');
      if (l) d.textContent = l; else d.append(document.createElement('br'));
      wrap.append(d);
    });
  }
  return wrap;
}

$('btn-cc').onclick = () => {
  // 참조·숨은참조는 평소엔 자리만 차지한다 — 누를 때 같이 펼친다
  $('row-cc').classList.remove('hide');
  $('row-bcc').classList.remove('hide');
  $('btn-cc').style.display = 'none';
  $('cc').focus();
};

$('attach').onclick = async () => {
  addFiles(await window.nunsseom.composeAttach());
};

// ── 끌어다 놓기 ────────────────────────────
// 창 어디에 놓아도 첨부가 된다. 본문(contenteditable)에 놓으면 크로미움이 제멋대로
// file:// 그림을 끼워 넣으려 하므로, 창 전체에서 기본 동작을 먼저 막는다.
//
// 경로는 화면이 만지지 않는다 — preload 가 진짜 File 객체에서 뽑아 메인으로 바로
// 보낸다. 그래야 «대화상자로 고른 것만 보낸다»는 잠금이 그대로 산다.
(() => {
  const card = document.querySelector('.card');
  let depth = 0;   // dragenter/leave 는 자식 위를 지날 때마다 오간다 — 세어야 안 깜빡인다

  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || [])
    .includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    card.classList.add('dropping');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) card.classList.remove('dropping');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    card.classList.remove('dropping');
    // FileList 를 그대로 넘기면 다리(contextBridge)를 건너다 빈 껍데기가 된다 —
    // 파일은 하나도 안 붙는데 오류도 안 난다 (실측). 배열로 바꿔 넘겨야 File 이 살아간다.
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const r = await window.nunsseom.composeDropFiles(files).catch(() => null);
    if (!r) { say('bad', '첨부하지 못했습니다'); return; }
    const added = addFiles(r.files);
    if (r.skipped && r.skipped.length) {
      say('bad', r.skipped.map((s) => `${s.name} — ${s.why}`).join(' · '));
    } else if (added) {
      say('', `${added}개 붙였습니다`);
    } else if (r.files && r.files.length) {
      say('', '이미 붙어 있습니다');
    }
  });
})();

// ── 임시 저장 ─────────────────────────────
// 긴 메일을 쓰다 창을 닫거나 앱이 죽으면 그것으로 끝이었다.
// 손이 멈추면 메인에 적어둔다. 다음에 «쓰기»를 누르면 그대로 나온다.
let saveTimer = null;
let savedOnce = false;

/** @param html 본문 HTML — saveDraftNow 가 한 번 읽어 넘긴다 (그림이 크면 innerHTML 한 번에 0.1초) */
function draftNow(html = body.innerHTML) {
  return {
    accountId: (context && context.accountId) || '',
    kind: (context && context.kind) || 'new',
    title: $('ttl').textContent || '',
    to: $('to').value,
    cc: $('cc').value,
    bcc: $('bcc').value,
    subject: $('subject').value,
    bodyHtml: draftBody(html),
    inReplyTo: (context && context.inReplyTo) || '',
    references: (context && context.references) || '',
    // 경로는 안 보낸다 — 메인은 «대화상자로 골람 파일»만 보내게 되어 있고,
    // 저장해 둔 경로를 다시 믿으면 그 문이 열린다. 이름만 남긴다.
    attachNames: attachments.filter((a) => !a.carried).map((a) => a.filename),
    // 원문 첨부(답장·전달·복사)도 이름만 — id 는 이 창이 닫히면 쓸모없다. 디스크에 없는 파일이라
    // 이어 쓸 때 «다시 붙여주세요»라고 할 수 없어 따로 적는다 (noteRestored)
    carriedNames: attachments.filter((a) => a.carried).map((a) => a.filename)
  };
}

/**
 * 임시 저장할 본문 — 설정 파일 하나에 담기므로 한도(draftHtmlMax)가 있다. 넘으면 큰 그림부터 자리표로 바꾼다.
 * 예전엔 메인이 한도에서 잘라 적어서, 붙여넣은 캡처 하나면 base64 한가운데가 잘려 이어 쓸 때 그림이 깨지고
 * 그 뒤의 글(서명·인용문)까지 사라졌다. 글은 자르지 않는다 — 그림을 다 빼도 넘으면 메인이 본문을 비우고 그렇다고 적는다.
 * 손이 멈출 때마다 몇 MB 를 메인에 보내지 않게 하는 몫도 있다. «그림 넣는 중…» 표식은 적지 않는다.
 * 직렬화한 글에서 바로 고친다 (kit.draftHtml) — 예전엔 DOMParser 로 다시 읽고 다시 써서 그림이 몇십 MB 면 0.5초씩 굳었다.
 */
function draftBody(html) {
  return kit.draftHtml(html, draftHtmlMax).html;
}

/** 빈 초안은 적지 않는다 — 새 메일을 열자마자 쓸데없는 것이 생기면 안 된다 */
function worthSaving(html) {
  return dirty(html);
}

function saveDraftSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraftNow, 1200);
}

function saveDraftNow() {
  clearTimeout(saveTimer);
  // 본문은 한 번만 읽는다 — 쓰던 글이 있나 보는 데와 적는 데가 같이 쓴다
  const html = body.innerHTML;
  if (worthSaving(html)) {
    window.nunsseom.composeDraftSave(draftNow(html));
    savedOnce = true;
  } else if (savedOnce) {
    // 다 지우고 빈 창이 됐으면 임시 저장도 비운다
    window.nunsseom.composeDraftClear();
    savedOnce = false;
  }
}

/**
 * 쓰던 글이 있나 — 있으면 함부로 버리지 않는다. 붙이는 중인 그림이 있어도 쓰던 글이다.
 * @param html 본문 HTML (이미 읽어 둔 것이 있으면) — 없으면 여기서 읽는다
 */
function dirty(html) {
  if (pasteJobs.size) return true;
  const base = context || {};
  // 처음 채워진 값과 비교한다. 복사(다시 보내기)는 참조·첨부가, 답장·전달은 원문 첨부가 처음부터
  // 차 있으므로, 비어 있는 것과 비교하면 아무것도 안 고쳤는데도 «쓰던 글이 있다»가 되어 닫을 때마다 묻는다.
  // 첨부는 개수가 아니라 «무엇이» 붙어 있나로 본다 — 하나 빼고 하나 붙이면 개수는 같아도 고친 것이다.
  const keyOf = (a) => (a.carried ? `c:${a.id}` : `p:${a.path}`);
  const startAtts = (Array.isArray(base.attachments) ? base.attachments : []).map(keyOf).join('\n');
  return $('to').value !== (base.to || '')
    || $('cc').value !== (base.cc || '') || $('bcc').value !== (base.bcc || '')
    || $('subject').value !== (base.subject || '')
    || (html === undefined ? body.innerHTML : html).trim() !== (base.bodyHtml || '')
    || attachments.map(keyOf).join('\n') !== startAtts;
}

let asking = false;

async function tryClose() {
  // 보내는 중에 닫으면 결과를 아무도 못 본다. 이미 나갔는지도 모른 채 또 쓰게 된다.
  if (sending) { say('bad', '보내는 중입니다 — 끝나면 닫아주세요'); return; }
  // 붙이는 그림이 아직 안 들어갔으면 — 지금 닫으면 그 그림이 사라진다 («저장»을 골라도 아직 안 들어간 그림은 안 담긴다)
  if (pasteJobs.size) { say('bad', '그림을 붙이는 중입니다 — 다 들어간 뒤 닫아 주세요'); return; }
  // 쓸 것이 없으면 묻지 않는다
  if (!dirty()) { window.nunsseom.composeClose(); return; }
  // Esc를 연타해도 대화상자가 곹쳐 뜨지 않게
  if (asking) return;
  asking = true;
  let answer;
  try {
    answer = await window.nunsseom.composeAsk('close');
  } finally {
    asking = false;
  }
  if (answer === 'cancel') return;
  if (answer === 'save') {
    saveDraftNow();
  } else {
    // «저장 안 함»은 진짜로 안 남기는 것이어야 한다 —
    // 쓰는 동안 적어둔 것까지 같이 지운다. 안 그러면 대답이 아무 뜻도 없다.
    clearTimeout(saveTimer);
    window.nunsseom.composeDraftClear();
    savedOnce = false;
  }
  window.nunsseom.composeClose();
}

$('close').onclick = tryClose;
document.addEventListener('keydown', (e) => {
  // 한글 입력 중 Esc는 후보창을 닫는 키다 — 그걸 창 닫기로 받으면 글이 날아간다
  if (e.key === 'Escape' && !e.isComposing) {
    // 주소록이 열려 있으면 그것부터 닫는다 — 창까지 같이 닫히면 쓰던 글이 날아간다
    if ($('picker').classList.contains('on')) {
      $('picker').classList.remove('on');
      chosen.clear();
      return;
    }
    tryClose();
  }
  // 긴 글을 쓰다 보면 마우스로 버튼을 찾아가는 게 번거롭다
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.repeat) send();
});

async function send() {
  if (sending) return;
  // 붙이는 그림이 아직 안 들어갔으면 — 지금 보내면 그 그림 없이 나가고, 창이 닫힌 뒤에야 그림이 본문에 든다
  if (pasteJobs.size) {
    say('bad', '그림을 붙이는 중입니다 — 다 들어간 뒤 보내 주세요');
    return;
  }
  sweepSlots();
  // 임시 저장에 못 담은 그림 자리가 남아 있으면 — 그대로 보내면 받는 사람에게 «그림 자리» 글이 간다.
  // 자리표는 편집 안 되는 덩어리라 그 바로 앞·뒤에 붙이면 그림으로 바뀌고, 지우면 한 번에 지워진다 (makeSlot)
  const holes = body.querySelectorAll('[data-pic-gone]').length;
  if (holes) {
    say('bad', `본문에 그림 자리(점선 상자)가 ${holes}개 남아 있습니다 — 그 자리에 그림을 다시 붙이면 바뀝니다. 필요 없으면 상자를 지운 뒤 보내 주세요`);
    return;
  }
  sending = true;
  $('send').disabled = true;
  say('', '보내는 중…');
  let ok = false;
  try {
    const { gone, ...content } = await bodyForSend();
    const r = await window.nunsseom.composeSend({
      to: $('to').value, cc: $('cc').value, bcc: $('bcc').value,
      subject: $('subject').value,
      ...content,
      attachments,
      inReplyTo: context && context.inReplyTo,
      references: context && context.references
    });
    ok = !!(r && r.ok);
    if (ok) {
      // 나갔으면 임시 저장은 메인이 지운다. 여기서 또 적으면 방금 보낸 메일이
      // 다음에 다시 떠서 두 번 보내게 된다.
      clearTimeout(saveTimer);
      savedOnce = false;
      // 일부만 갔거나 보낸편지함에 못 넣었으면 그건 읽고 넘어가야 한다 —
      // 1초 뒤 창이 사라지면 아무도 못 본다. 보낼 수 없는 형식이라 뺀 그림(인용문의 TIFF 같은 것)도 같다.
      const warn = [r.warn, gone ? `보낼 수 없는 형식의 그림 ${gone}개는 빼고 보냈습니다` : ''].filter(Boolean).join(' · ');
      if (warn) {
        say('bad', `${r.message} · ${warn}`);
        $('send').textContent = '닫기';
        $('send').disabled = false;
        $('send').onclick = () => window.nunsseom.composeClose();
      } else {
        say('good', r.message || '보냈습니다');
        setTimeout(() => window.nunsseom.composeClose(), 1200);
      }
    } else {
      say('bad', (r && r.message) || '보내지 못했습니다');
    }
  } finally {
    sending = false;
    // 보낸 뒤에는 버튼을 다시 살리지 않는다 — 창이 닫히기 전 그 짧은 틈에
    // 한 번 더 눌리면 같은 메일이 두 번 나간다.
    if (!ok) $('send').disabled = false;
  }
}
$('send').onclick = send;

/** 다른 곳에서 «쓰기»를 또 눌렀을 때 — 쓰던 글이 있으면 물어본다 */
window.nunsseom.onComposeReplace(async (next) => {
  // 이 초안을 안 받으면 메인에 말한다 — 안 그러면 그 원문 첨부 바이트가 창이 닫힐 때까지 메인에 남는다
  const drop = () => window.nunsseom.composeDropReplace(next && next.carryKey);
  if (sending) { drop(); return; }
  if (dirty()) {
    if (asking) { drop(); return; }
    asking = true;
    let answer;
    try { answer = await window.nunsseom.composeAsk('replace'); } finally { asking = false; }
    if (answer !== 'discard') { drop(); return; }
    // 새 초안이 이 칸을 차지한다 — 적어둔 것을 먼저 지우고 간다
    clearTimeout(saveTimer);
    window.nunsseom.composeDraftClear();
    savedOnce = false;
  }
  window.nunsseom.composeAcceptReplace(next);
  fill(next);
});

// ── 제목줄을 끌어 창 옮기기 ─────────────────────────
// -webkit-app-region: drag 는 그 안의 버튼 클릭까지 먹어버려 직접 만든다.
(() => {
  const head = $('head');
  let from = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    from = { sx: e.screenX, sy: e.screenY };
    window.nunsseom.composeBounds().then((b) => { if (from) { from.x = b.x; from.y = b.y; } });
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!from || from.x === undefined) return;
    window.nunsseom.composeMove({
      x: from.x + (e.screenX - from.sx),
      y: from.y + (e.screenY - from.sy)
    });
  });
  const done = (e) => {
    if (!from) return;
    from = null;
    try { head.releasePointerCapture(e.pointerId); } catch { /* 이미 놓았다 */ }
  };
  head.addEventListener('pointerup', done);
  head.addEventListener('pointercancel', done);
})();

// ── 크기 조절 ───────────────────────────────────────
for (const zone of document.querySelectorAll('.rz')) {
  // 처리기 거는 순서는 nunsDrag 가 맡는다 — 크기를 물어보는 동안 손을 떼도 안 남게.
  window.nunsDrag(zone, async (e) => {
    e.preventDefault();
    const dir = zone.dataset.dir;
    const sx = e.screenX;
    const sy = e.screenY;
    const start = await window.nunsseom.composeBounds();
    if (!start) return null;
    return (ev) => {
      const dx = ev.screenX - sx;
      const dy = ev.screenY - sy;
      let { x, y, width, height } = start;
      if (dir.includes('e')) width = start.width + dx;
      if (dir.includes('s')) height = start.height + dy;
      if (dir.includes('w')) { width = start.width - dx; x = start.x + dx; }
      if (dir.includes('n')) { height = start.height - dy; y = start.y + dy; }
      window.nunsseom.composeSetBounds({ x, y, width, height, dir });
    };
  });
}

/** 보내는 사람 칸 — 계정이 여럿이고 새 메일이면 고를 수 있게 한다 */
function setupFrom(d) {
  const list = d.accounts || [];
  const cur = list.find((a) => a.id === d.accountId) || list[0] || {};
  const show = (a) => (a.label ? `${a.label} <${a.from}>` : a.from) || '(주소 없음)';
  $('from').value = show(cur);
  if (!cur.from) {
    say('bad', '보내는 사람 주소가 없습니다 — 설정 › 메일에서 넣어주세요');
    $('send').disabled = true;
  }
  const sel = $('acc');
  sel.textContent = '';
  // 답장·전달은 받은 계정으로 고정이다. 새 메일만 고를 수 있다.
  if (!d.pickable || list.length < 2) { sel.style.display = 'none'; return; }
  sel.style.display = '';
  for (const a of list) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    if (a.id === cur.id) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => {
    const a = list.find((x) => x.id === sel.value);
    if (!a) return;
    $('from').value = show(a);
    $('send').disabled = !a.from;
    window.nunsseom.composeSetAccount(a.id);
    // 계정마다 서명이 다르다 — 계정을 바꾸면 서명도 그 계정 것으로 갈아끼운다
    const old = body.querySelector('.sig');
    const next = signatureNode((d.signatures || {})[a.id]);
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) body.append(next);
  };
}

/**
 * 이어쓰는 중이라고 알려준다.
 * 말 없이 예전 글이 떠 있으면 «이게 왜 여기 있지»가 된다.
 * 버리고 새로 쓸 길도 같이 둔다.
 */
function noteRestored(d) {
  const when = d.restoredAt ? new Date(d.restoredAt) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = when
    ? `${when.getMonth() + 1}월 ${when.getDate()}일 ${pad(when.getHours())}:${pad(when.getMinutes())}`
    : '';
  const names = (d.restoredNames || []).filter(Boolean);
  // 원문 첨부는 디스크에 없다 — «파일 첨부»로는 못 붙인다. 붙는 길을 말한다
  const carried = (d.restoredCarried || []).filter(Boolean);
  // 임시 저장 칸에 다 안 들어가 자리표로 바꾼 그림 · 글만으로 넘쳐 비운 본문 (store.setMailDraft) — 보내기 전에 알아야 한다
  const picsGone = Number(d.restoredPicsGone) || 0;
  say(picsGone || d.restoredBodyGone ? 'bad' : '', `쓰다 만 글을 이어서 씁니다${stamp ? ` · ${stamp}` : ''}`
    + (names.length ? ` · 첨부 ${names.length}개는 다시 붙여주세요 (${names.join(', ').slice(0, 60)})` : '')
    + (carried.length ? ` · 원문 첨부 ${carried.length}개는 메일에서 다시 답장·전달해야 붙습니다 (${carried.join(', ').slice(0, 60)})` : '')
    + (picsGone ? ` · 임시 저장에 본문 그림 ${picsGone}개는 담지 못했습니다 — 다시 붙여 주세요` : '')
    + (d.restoredBodyGone ? ' · 본문이 너무 길어 임시 저장에 담지 못했습니다' : ''));

  const btn = document.createElement('button');
  btn.className = 'act ghost';
  btn.id = 'btn-fresh';
  btn.textContent = '새로 쓰기';
  btn.title = '쓰던 글 버리고 새로 시작';
  btn.onclick = async () => {
    if (await window.nunsseom.composeAsk('discard') !== 'discard') return;
    clearTimeout(saveTimer);
    window.nunsseom.composeDraftClear();
    savedOnce = false;
    $('to').value = '';
    $('cc').value = '';
    $('bcc').value = '';
    $('subject').value = '';
    context = { ...context, to: '', cc: '', bcc: '', subject: '', restored: false, inReplyTo: '', references: '' };
    dropPending();
    body.textContent = '';
    const first = document.createElement('div');
    first.append(document.createElement('br'));
    body.append(first);
    const sig = signatureNode(context.signature);
    if (sig) body.append(sig);
    context.bodyHtml = body.innerHTML.trim();
    countInline();
    $('ttl').textContent = '새 메일';
    btn.remove();
    say('', '');
    $('to').focus();
  };
  $('msg').after(btn);
}

function fill(d) {
  if (!d) { say('bad', '계정을 찾을 수 없습니다'); $('send').disabled = true; return; }
  $('ttl').textContent = d.title || '새 메일';
  setupFrom(d);
  $('to').value = d.to || '';
  // 참조·숨은참조는 반드시 비운다 — 남겨두면 앞 초안의 수신자가 접힌 채 따라간다
  $('cc').value = '';
  $('bcc').value = '';
  $('row-cc').classList.add('hide');
  $('row-bcc').classList.add('hide');
  $('btn-cc').style.display = '';
  // 답장이면 원문의 참조가 딸려 온다 (메인이 내 주소·받는 사람을 뺐다). 펼쳐 둔다 — 접어 두면
  // 누가 같이 받는지 모른 채 보낸다. 숨은참조 칸도 같이 편다 (참조 단추가 사라지므로 — 주소록에서 넣을 때와 같게).
  // 이어 쓰기·복사는 아래에서 제 참조를 채운다
  if (d.cc && !d.restored && !d.reuse) {
    $('cc').value = d.cc;
    $('row-cc').classList.remove('hide');
    $('row-bcc').classList.remove('hide');
    $('btn-cc').style.display = 'none';
  }
  $('subject').value = d.subject || '';
  // 답장 인용문은 서식 있는 본문에 인용 블록으로 넣는다
  // 인용문은 남이 쓴 글이다. 문자열로 이어 붙이지 않고 글자 노드로 넣어
  // 그 안의 태그가 살아날 여지를 아예 없앤다.
  // 앞 초안에 붙이던 그림은 이 초안에 넣지 않는다
  dropPending();
  body.textContent = '';
  // 커서가 설 빈 줄 — 여기부터 쓴다.
  // <br>이 없으면 빈 div는 높이가 0으로 접혀서, 커서가 아래 서명 블록 안으로 들어간다.
  // 그러면 사용자가 친 글이 서명 안에 섞여 들어간다 (실제로 그랬다).
  const first = document.createElement('div');
  first.append(document.createElement('br'));
  body.append(first);
  // 서명은 내가 쓸 자리 바로 아래, 인용문 위에 온다 (답장 맨 밑에 달리면 아무도 안 읽는다)
  const sig = signatureNode(d.signature);
  if (sig) body.append(sig);
  // 인용문 — «누가 언제 썼다» 한 줄, 그 아래 원문.
  // 원문 서식(quoteHtml)이 있으면 그걸 쓴다. 웹메일이 기계로 만들어 함께 보내는
  // text/plain은 표를 글로 옮긴 것이라 빈 줄과 두 번씩 적힌 주소로 가득하다.
  if (d.quoteHead) {
    const h = document.createElement('div');
    h.className = 'qhead';
    linesInto(h, d.quoteHead);
    body.append(h);
  }
  if (d.quoteHtml || d.text) {
    const q = document.createElement('blockquote');
    if (d.quoteHtml) quoteInto(q, d.quoteHtml);
    else linesInto(q, d.text);
    body.append(q);
  }
  // 이어쓰기면 저장된 본문을 그대로 올린다 (서명·인용문은 이미 그 안에 있다)
  if (d.restored && d.bodyHtml) {
    body.innerHTML = cleanPasted(d.bodyHtml);
    // 붙이던 중에 적힌 초안이면 표식·자리표 번호가 남아 있을 수 있다 — 이 창의 번호와 엉키지 않게 치운다
    for (const s of body.querySelectorAll('[data-paste-slot]')) s.remove();
    for (const h of body.querySelectorAll('[data-pic-take]')) h.removeAttribute('data-pic-take');
    $('cc').value = d.cc || '';
    $('bcc').value = d.bcc || '';
    if (d.cc) { $('row-cc').classList.remove('hide'); $('btn-cc').style.display = 'none'; }
    if (d.bcc) $('row-bcc').classList.remove('hide');
  }
  // 복사(다시 보내기)면 원문을 통째로 편집 가능한 본문으로 올린다.
  // 방금 붙인 빈 줄·서명은 버린다 — 서명은 원문 안에 이미 있다.
  // 인용 블록이 아니라 «내 글»이므로, 남이 준 HTML을 다룰 때와 같은 허용목록으로
  // 새로 지어 넣는다(quoteInto). 글만 있으면 글자 노드로.
  if (d.reuse) {
    body.textContent = '';
    if (d.bodyHtml) quoteInto(body, d.bodyHtml);
    else linesInto(body, d.bodyText);
    $('cc').value = d.cc || '';
    if (d.cc) { $('row-cc').classList.remove('hide'); $('btn-cc').style.display = 'none'; }
  }
  d.bodyHtml = body.innerHTML.trim();
  // 복사·답장·전달이면 원문 첨부가 딸려 온다(메인이 실어 보낸다). 새 메일은 빈 채로 시작한다.
  attachments = Array.isArray(d.attachments) ? d.attachments.slice() : [];
  // 이어 쓰기·인용문에 담겨 온 본문 그림도 합계에 센다
  inlineBytes = kit.inlineBytes([...body.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''));
  renderFiles();
  // 너무 커서·많아서 못 실은 원문 첨부가 있으면 열자마자 말한다 — 보낸 뒤에 알면 늦다
  say(d.carryNote ? 'bad' : '', d.carryNote || '');
  context = d;
  if (d.restored) noteRestored(d);
  // 손이 멈추면 적어둔다. 붙여넣기·글자판 모두 input으로 올라온다.
  for (const id of ['to', 'cc', 'bcc', 'subject']) $(id).addEventListener('input', saveDraftSoon);
  body.addEventListener('input', saveDraftSoon);
  // 답장이면 본문 맨 위에서 쓰기 시작한다 (인용문은 아래에 있다)
  // 커서는 언제나 첫 줄 안에 둔다. body 기준으로 잡으면 브라우저가 알아서
  // «글이 있는 첫 자리»로 옮겨버려 서명 안으로 들어간다.
  const putCaret = () => {
    body.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    // 복사(다시 보내기)면 빈 첫 줄을 지우고 원문을 올렸으므로 first가 없다 —
    // 그때는 본문 맨 앞에 선다. 답장·새 메일이면 여전히 그 빈 줄이 첫 자리다.
    if (first.isConnected) r.setStart(first, 0);
    else r.setStart(body, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  // 복사면 받는사람·제목이 이미 차 있고 대개 본문을 고친다 — 본문 맨 앞에 선다.
  if (d.to || d.reuse) putCaret(); else $('to').focus();
  body.onfocus = putCaretOnce;
  function putCaretOnce() {
    body.onfocus = null;
    // 받는 사람부터 채우고 본문으로 넘어온 첫 순간에도 첫 줄에 선다
    if (!body.contains(window.getSelection().anchorNode)) putCaret();
  }
  paintBar();
}

window.nunsseom.composeData().then(fill);

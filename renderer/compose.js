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
for (const el of [$('color'), $('btn-image'), $('btn-table'), $('btn-link')]) {
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

/** 넣을 자리 — range(본문 안이면), 아니면 지금 커서, 그것도 본문 밖이면 본문에 포커스를 준 뒤의 커서, 그래도 없으면 본문 맨 앞.
 *  «그림» 단추·붙여넣은 그림·«표» 단추가 같은 자리에 넣는다 */
function insertSpot(range) {
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
  return r;
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
  let r = insertSpot(range);
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

// ── 표 붙여넣기 ──
// 엑셀·구글 시트·워드·한글에서 복사한 표는 표로 넣는다 (예전엔 탭으로 이은 글만 들어갔다).
// 클립보드 HTML 을 그대로 넣지는 않는다 — pastetable.js 가 DOMParser 로 읽어 허락한 태그·속성·스타일만 새로 지은 것을 넣는다.
const tableKit = window.nunsTable;

// Ctrl+Shift+V — 서식 없이 글로만. 붙여넣기 이벤트에는 어느 키로 붙였는지가 없어서, 키를 누른 순간을 적어 두고
// 바로 다음 붙여넣기 하나가 가져간다 (1초가 지나면 버린다). 한글 조합 중의 키는 안 센다
let plainAt = 0;
body.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyV' && !e.isComposing && !composing) plainAt = Date.now();
});
function takePlain() {
  const on = !!plainAt && Date.now() - plainAt < 1000;
  plainAt = 0;
  return on;
}

/** 커서가 본문의 표 안(칸)인가 — 거기에 표를 넣으면 표 안에 표가 생긴다 */
function caretInTable() {
  const r = caretRange();
  if (!r) return false;
  const el = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  return [r.startContainer, r.endContainer].some((n) => {
    const c = el(n) && el(n).closest('td, th, table');
    return !!c && body.contains(c);
  });
}

/** 커서 뒤로 같은 줄에 남은 것이 없나 — 없으면 표 뒤에 빈 줄을 같이 넣는다 (커서가 표 마지막 칸이나 서명 안으로 가지 않게) */
function lineEndsHere(r) {
  const line = lineOf(r.endContainer);
  const rest = document.createRange();
  rest.setStart(r.endContainer, r.endOffset);
  rest.setEnd(line, line.childNodes.length);
  const f = rest.cloneContents();
  return !/\S/.test(f.textContent) && !f.querySelector('img, table, hr, [data-pic-gone]');
}

/**
 * 커서가 표 바로 뒤(빈 줄)에 있나 — 거기에 표를 넣으면 크로미움이 그 빈 줄을 새 표로 바꿔 두 표가 붙는다. 그러면 사이에
 * 글을 쓸 줄이 없고 받는 쪽에서도 한 표처럼 보인다. 표를 붙인 직후 커서가 바로 이 자리라 «붙이고 바로 표 넣기»에서 흔하다
 */
function rightAfterTable(r) {
  if (!r) return false;
  let c = r.startContainer;
  let at = r.startOffset;
  // 줄 상자 바로 뒤 자리(본문 끝을 통째로 고른 것 등)면 그 상자의 맨 끝으로 내려가 본다 — 크로미움도 거기에 넣는다
  while (c.nodeType === 1 && at > 0) {
    const prev = c.childNodes[at - 1];
    if (prev.nodeName === 'TABLE') return true;
    if (prev.nodeType !== 1 || !prev.matches(LINE) || prev.matches('td, th')) break;
    c = prev;
    at = prev.childNodes.length;
  }
  const line = lineOf(c);
  if (line === body || line.matches('td, th')) return false;
  if (/\S/.test(line.textContent) || line.querySelector('img, table, hr, [data-pic-gone]')) return false;
  let p = line.previousSibling;
  while (p && p.nodeType === 3 && !/\S/.test(p.nodeValue)) p = p.previousSibling;
  return !!p && p.nodeName === 'TABLE';
}

/** 커서를 표 바로 뒤로 — 뒤따르는 줄의 맨 앞. insertHTML 은 커서를 표의 마지막 칸 안에 둔다 (실측) */
function caretAfterTable(t) {
  const r = document.createRange();
  const next = t.nextSibling;
  const text = next && (next.nodeType === 3 ? next : next.firstChild && next.firstChild.nodeType === 3 ? next.firstChild : null);
  if (text) r.setStart(text, 0);
  else if (next) r.setStart(next, 0);
  else r.setStartAfter(t);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

/**
 * 붙여넣기에 표가 있으면 표로 넣는다. 넣었으면(글로 대신 넣었어도) true, 표로 볼 것이 없으면 false (보통 붙여넣기로).
 *   · 커서가 표 칸 안이면 글로 — 표 안에 표를 만들지 않는다
 *   · 너무 큰 표(2000칸·다듬은 HTML 100만 글자 넘음)는 글로, 그렇다고 알린다
 *   · execCommand('insertHTML') 로 넣는다 — Ctrl+Z 한 번에 빠지고, input 이 와서 임시 저장·합계도 다시 센다.
 *     크로미움은 넣을 때 표·인라인 스타일을 지킨다 (실측). 기본값과 같은 스타일을 적으면 그 칸의 style 을 다시 쓰므로
 *     pastetable.js 가 그런 것은 안 적는다
 */
function pasteTable(text, html) {
  // 아주 큰 표에 글도 같이 왔으면 다듬지 않고 바로 글로 — 다듬어도 글로 붙일 것이라 그만큼 멈추기만 한다 (2만 칸이면 1초 남짓).
  // 숨긴 행·열이 있을 수 있으면 숨긴 것을 빼야 하니 다듬는다
  if (text && !tableKit.mayHide(html)) {
    const n = tableKit.countCells(html);
    if (n > tableKit.MAX_CELLS) {
      document.execCommand('insertText', false, text);
      say('bad', tableKit.bigText(n));
      return true;
    }
  }
  let got;
  try { got = tableKit.build(html); } catch { return false; }
  // 엑셀은 숨긴 행·열의 글까지 클립보드 글에 싣는다 — 숨긴 것이 있으면 표에서 뽑은 글(숨긴 것은 뺐다)로
  const plain = got.hidden ? got.text : text || got.text;
  if (got.single) {
    // 칸 하나 (엑셀 칸 하나) — 표가 아니라 글로. 엑셀 글 몫 끝의 줄바꿈은 뗀다 (문장 가운데에 숫자 하나를 붙이는 일이 흔하다)
    const one = String(plain || '').replace(/[\r\n]+$/, '');
    if (one) document.execCommand('insertText', false, one);
    return true;
  }
  if (!got.ok) return false;
  const asText = () => { if (plain) document.execCommand('insertText', false, plain); };
  if (caretInTable()) { asText(); return true; }
  if (got.big) {
    asText();
    say('bad', tableKit.bigText(got.cells));
    return true;
  }
  let r = caretRange();
  if (!r) { body.focus(); r = caretRange(); }
  const known = new Set(body.querySelectorAll('table'));
  // 표로 끝나면 표 뒤에 빈 줄을 같이 넣고 커서를 표 바로 뒤로. 글로 끝나면(워드·웹의 «앞 문단 + 표 + 뒤 문단») insertHTML 이 둔
  // 커서 — 붙인 글 끝 — 를 그대로 둔다 (보통 붙여넣기처럼). 빈 줄도 안 덧붙인다
  const endsTable = /<\/table>\s*$/i.test(got.html);
  // 표로 시작하는데 커서가 표 바로 뒤 빈 줄이면 앞에 빈 줄 — 두 표가 붙지 않게
  const lead = /^\s*<table/i.test(got.html) && rightAfterTable(r) ? '<div><br></div>' : '';
  document.execCommand('insertHTML', false, lead + got.html + (endsTable && r && lineEndsHere(r) ? '<div><br></div>' : ''));
  const added = [...body.querySelectorAll('table')].filter((t) => !known.has(t) && !t.parentElement.closest('table'));
  // 크로미움이 표를 떨어뜨렸으면 글로라도
  if (!added.length) { asText(); return true; }
  if (endsTable) caretAfterTable(added[added.length - 1]);
  // 다듬은 표가 Gmail 이 접는 크기(약 100KB)를 넘으면 같이 알린다
  const heavy = tableKit.heavy(got.html);
  say(heavy ? 'bad' : '', tableKit.doneText({ ...got, heavy }));
  return true;
}

// 붙여넣기 — 표가 있으면 표로 (위 pasteTable). 아니면 글이 있으면 글만 (엑셀 칸·워드 글을 복사하면 그 모양을 찍은 그림도
// 같이 오는데, 그건 버린다). 글 없이 그림만 왔으면(화면 캡처·«이미지 복사») 본문 그림으로. 남이 만든 HTML 은 그대로 넣지 않는다 —
// 남의 스타일과 바깥 그림 주소까지 딸려 들어와 메일이 깨지고, 바깥 주소는 열어 본 사실을 흘린다.
body.addEventListener('paste', (e) => {
  e.preventDefault();
  const plainKey = takePlain();
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  const text = cd.getData('text/plain') || '';
  const html = cd.getData('text/html') || '';
  // Ctrl+Shift+V — 글로만 (글이 없으면 보통 붙여넣기로)
  if (plainKey && text) {
    document.execCommand('insertText', false, text);
    return;
  }
  // 표 — 같이 실려 온 그림(엑셀·워드가 그 표를 찍어 같이 싣는 비트맵)은 버린다
  if (/<table\b/i.test(html) && pasteTable(text, html)) return;
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

// ── 표 편집 ──────────────────────────────────────
// 노션의 간단한 표처럼 — «표» 단추로 넣고, 마우스를 올린 줄·열의 손잡이(⋮⋮)와 + 띠, 오른쪽 클릭 메뉴로 행·열을 넣고 빼고,
// 칸을 끌어 골라 합치고 나눈다. 칸 지도 셈(합친 칸까지 펴서 «몇째 열»을 보는 것)은 tablegrid.js (window.nunsGrid) 가 한다 —
// 여기서는 본문 표를 그 꼴로 읽고(readRaw) 셈의 답을 본문에 넣는다(commit).
//   · 바뀐 표는 표를 통째로 골라 execCommand('insertHTML') 로 갈아 끼운다 — Ctrl+Z 한 번에 돌아가고, input 이 와서 임시 저장·합계가 다시 돈다.
//     크로미움은 합친 칸·인라인 스타일·bgcolor·너비를 그대로 넣는다 (실측 — 본문 가운데·맨 앞·맨 뒤·혼자·인용문·서명·표 안 표).
//     그래도 넣은 표가 바란 꼴과 다르면 되돌리고 DOM 으로 바로 바꾼다 (그 한 번은 되돌리기에 안 실린다 — tgStats.fallbacks 로 세고 알린다)
//   · 손잡이·띠·막대·메뉴·고르개는 본문 밖(.tg-layer · .card)에 그린다. 본문에 들어가는 편집 표시는 고른 칸의 tg-on 뿐이고,
//     임시 저장·보내기·«쓰던 글이 있나»는 그것을 떼고 본다 (editorFree)
//   · 누르는 것은 모두 mousedown 을 막는다 — 본문 커서·포커스를 안 뺏는다
const grid = window.nunsGrid;
const tgLayer = $('tg-layer');
const tgCard = document.querySelector('.card');
const CELL_EXTRA = 21;    // 새 표 칸의 안쪽 여백(10px × 2) + 선 1px — 종이에 맞출 때 열 너비에 더해 센다
const MOD_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'];
let tgStamp = 0;          // 본문이 바뀔 때마다 하나씩 — 칸 지도 캐시를 버린다
// fallbacks — insertHTML 이 표를 못 넣어 DOM 으로 바꾼 횟수 (그 한 번은 되돌리기에 안 실린다)
// synced — 크로미움이 넣으면서 고쳐 쓴 표를 넣은 노드 그대로 바란 꼴로 되돌린 횟수 (되돌리기는 그대로 된다)
const tgStats = { fallbacks: 0, synced: 0 };
let tgHot = null;         // 마우스가 올라간 표
let tgHotRow = 0;
let tgHotCol = 0;
let tgShown = null;       // 손잡이를 그린 자리 — { table, r, c } (손잡이를 누르면 이 줄·열)
let tgEdge = null;        // 너비 손잡이를 그린 경계 — { table, col } (그 열의 오른쪽 선)
let tgSel = null;         // 칸 여럿 고르기 — { table, anchor(처음 칸), rect }
let tgLine = null;        // 손잡이로 고른 줄·열 — { table, kind, r, c } (메뉴가 떠 있는 동안)
let tgDrag = null;        // 칸에서 누른 채 끄는 중 — { table, anchor }
let tgAnchor = null;      // Shift+누르기의 처음 칸
let tgSize = null;        // 열 너비 끄는 중
let tgMenus = [];         // 열린 메뉴 (하위 메뉴가 뒤에)
let tgRaf = 0;
const tgPick = { open: false, r: 1, c: 1, here: null };
const tgMaps = new WeakMap();

const elOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
/** 본문 표의 칸 (td·th) — 본문 밖이면 null */
function cellOf(n) {
  const e = elOf(n);
  const c = e && e.closest('td, th');
  return c && body.contains(c) ? c : null;
}
/** 커서가 있는 칸 */
function caretCell() {
  const s = getSelection();
  return s && s.rangeCount ? cellOf(s.focusNode) : null;
}
/** 본문의 가장 바깥 표 (표 안 표면 바깥 것) */
function outerTable(n) {
  const e = elOf(n);
  let t = e && e.closest('table');
  if (!t || !body.contains(t)) return null;
  for (let up = t.parentElement.closest('table'); up && body.contains(up); up = up.parentElement.closest('table')) t = up;
  return t;
}
function caretInto(cell, atEnd) {
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(!atEnd);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

/**
 * 본문 표 → tablegrid 가 받는 꼴. full 이 아니면 칸 자리만 (마우스를 따라 그릴 때 — 칸 HTML·속성은 안 읽는다).
 * 편집 표시(tg-on · data-tg-*)는 안 읽는다 — 다시 넣는 HTML 에 섞이지 않게
 */
function readRaw(t, full) {
  const attrsOf = (el, skip) => {
    const o = {};
    if (!full) return o;
    for (const a of el.attributes) {
      const n = a.name.toLowerCase();
      if ((skip && skip.includes(n)) || n.startsWith('data-tg-')) continue;
      if (n === 'class') {
        const v = a.value.split(/\s+/).filter((k) => k && k !== 'tg-on').join(' ');
        if (v) o.class = v;
        continue;
      }
      o[n] = a.value;
    }
    return o;
  };
  const raw = { attrs: attrsOf(t), caption: null, cols: null, secs: [], rows: [] };
  const cols = [];
  const spanOf = (el) => Math.min(1000, Math.max(1, parseInt(el.getAttribute('span'), 10) || 1));
  const addRow = (tr, sec) => raw.rows.push({
    sec, attrs: attrsOf(tr), ref: tr,
    cells: [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map((c) => ({
      tag: c.tagName.toLowerCase(), rs: c.rowSpan, cs: c.colSpan, attrs: attrsOf(c, ['rowspan', 'colspan']), html: full ? c.innerHTML : '', ref: c
    }))
  });
  let loose = -1;   // 구역 없이 표에 바로 든 줄 — tbody 하나로 본다
  for (const ch of t.children) {
    const tag = ch.tagName;
    if (tag === 'CAPTION') {
      if (full) raw.caption = { attrs: attrsOf(ch), html: ch.innerHTML };
    } else if (tag === 'COLGROUP' || tag === 'COL') {
      const list = tag === 'COL' ? [ch] : [...ch.children].filter((x) => x.tagName === 'COL');
      if (!list.length) for (let i = 0; i < spanOf(ch); i++) cols.push({ attrs: {} });
      for (const col of list) for (let i = 0; i < spanOf(col); i++) cols.push({ attrs: attrsOf(col, ['span']) });
    } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      raw.secs.push({ tag: tag.toLowerCase(), attrs: attrsOf(ch) });
      loose = -1;
      for (const tr of ch.children) if (tr.tagName === 'TR') addRow(tr, raw.secs.length - 1);
    } else if (tag === 'TR') {
      if (loose < 0) { raw.secs.push({ tag: 'tbody', attrs: {} }); loose = raw.secs.length - 1; }
      addRow(ch, loose);
    }
  }
  if (cols.length) raw.cols = cols;
  return raw;
}

/** 칸 자리 지도 (가벼운 것 — 본문이 바뀌면 다시 읽는다) */
function mapOf(t) {
  const got = tgMaps.get(t);
  if (got && got.stamp === tgStamp) return got.m;
  const m = grid.tidy(readRaw(t, false));
  tgMaps.set(t, { stamp: tgStamp, m });
  return m;
}
const itemOf = (m, cell) => m.items.find((it) => it.ref === cell) || null;
/** 지도 자리 (r,c) 를 차지한 본문 칸 */
function cellAt(t, r, c) {
  const m = mapOf(t);
  if (!m.h || !m.w) return null;
  const it = grid.cells(m)[Math.max(0, Math.min(r, m.h - 1))][Math.max(0, Math.min(c, m.w - 1))];
  return it && it.ref ? it.ref : null;
}
/** 지금 커서의 지도 자리 (그 표 안일 때) */
function caretSpot(t) {
  const cc = caretCell();
  if (!cc || cc.closest('table') !== t) return null;
  const it = itemOf(mapOf(t), cc);
  return it ? { r: it.r, c: it.c } : null;
}
/** 열 경계 x (화면 좌표) — 칸 끝에서 모은다. 합친 칸뿐인 열은 사이를 고르게 나눈다 */
function edgesOf(t, m) {
  const e = new Array(m.w + 1).fill(null);
  for (const it of m.items) {
    if (!it.ref) continue;
    const r = it.ref.getBoundingClientRect();
    if (e[it.c] === null) e[it.c] = r.left;
    if (e[it.c + it.cs] === null) e[it.c + it.cs] = r.right;
  }
  const tr = t.getBoundingClientRect();
  if (e[0] === null) e[0] = tr.left;
  if (e[m.w] === null) e[m.w] = tr.right;
  for (let i = 1; i < m.w; i++) {
    if (e[i] !== null) continue;
    let j = i + 1;
    while (e[j] === null) j++;
    e[i] = e[i - 1] + (e[j] - e[i - 1]) / (j - i + 1);
  }
  return e;
}
const rowsOf = (m) => m.meta.map((x) => (x.ref ? x.ref.getBoundingClientRect() : null));
/** 표가 들어 있는 칸(본문·인용문·칸)의 안쪽 너비 — 표가 이보다 넓어지지 않게 */
function roomOf(host) {
  const p = host && body.contains(host) ? host : body;
  const cs = getComputedStyle(p);
  return Math.max(0, p.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - 1);
}
/** 열마다 지금 너비(칸 안쪽, px)와 칸마다 더해지는 여백·선 */
function measureCols(t, m) {
  const any = m.items.find((it) => it.ref);
  const cs0 = any ? getComputedStyle(any.ref) : null;
  const extra = cs0 ? ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((n, k) => n + (parseFloat(cs0[k]) || 0), 0) : CELL_EXTRA;
  const ed = edgesOf(t, m);
  const widths = Array.from({ length: m.w }, (_, c) => {
    const it = m.items.find((x) => x.c === c && x.cs === 1 && x.ref);
    const w = it ? parseFloat(getComputedStyle(it.ref).width) : ed[c + 1] - ed[c] - extra;
    return Math.max(grid.MIN_W, Math.round(w || 0));
  });
  return { widths, extra };
}
/** 열 넣기가 종이보다 넓어지면 줄이게 — tablegrid.insertCol 의 room·extra */
function fitOpt(t) {
  const m = mapOf(t);
  return { room: roomOf(t.parentElement), extra: m.w ? measureCols(t, m).extra : CELL_EXTRA };
}

/** 본문 HTML 에서 편집기만 쓰는 표시(고른 칸의 tg-on)를 뗀다 — 임시 저장·보내기·«쓰던 글이 있나»가 본다 */
function editorFree(html) {
  const s = String(html || '');
  if (!s.includes('tg-on')) return s;
  return s.replace(/ class="([^"]*)"/g, (all, v) => {
    const list = v.split(/\s+/).filter(Boolean);
    const keep = list.filter((k) => k !== 'tg-on');
    if (keep.length === list.length) return all;
    return keep.length ? ` class="${keep.join(' ')}"` : '';
  });
}

/** 고른 칸 표시를 다 걷는다 — 칸에 class 가 원래 없었으면 빈 class="" 도 남기지 않는다 */
function clearCells() {
  for (const c of body.querySelectorAll('.tg-on')) {
    c.classList.remove('tg-on');
    if (!c.classList.length) c.removeAttribute('class');
  }
  body.classList.remove('tg-cells');
  tgSel = null;
}
/** 글 고르기가 칸 고르기의 처음 칸 안에 접혀 있나 — 아니면(Ctrl+A 등으로 넓어졌으면) 칸 고르기는 낡았다 */
function inAnchor() {
  const s = getSelection();
  return !!tgSel && !!s && s.rangeCount > 0 && s.isCollapsed && tgSel.anchor.isConnected && tgSel.anchor.contains(s.focusNode);
}
function markCells(items) {
  for (const it of items) if (it.ref) it.ref.classList.add('tg-on');
}
const inRect = (it, R) => it.r <= R.r1 && it.r + it.rs - 1 >= R.r0 && it.c <= R.c1 && it.c + it.cs - 1 >= R.c0;

/** 네모 rect 를 고른다 (합친 칸을 다 담게 넓혀서). 칸이 하나뿐이면(합친 칸 하나는 빼고) 고르지 않는다 */
function selectRect(t, rect, anchor) {
  const m = mapOf(t);
  const R = grid.expand(m, rect);
  const inside = m.items.filter((it) => inRect(it, R));
  clearCells();
  if (inside.length < 2 && !(inside[0] && (inside[0].rs > 1 || inside[0].cs > 1))) return;
  markCells(inside);
  body.classList.add('tg-cells');
  const a = anchor && anchor.isConnected ? anchor : (inside.find((it) => it.ref) || {}).ref || null;
  if (!a) return;
  tgSel = { table: t, anchor: a, rect: R };
  // 글 고르기는 처음 칸 안에 접어 둔다 — 칸 고르기만 보이고, 치면 그 칸에 들어간다
  const s = getSelection();
  if (a && !(s.isCollapsed && s.rangeCount && a.contains(s.focusNode))) caretInto(a, true);
}
function selectCells(t, a, b) {
  const m = mapOf(t);
  const ia = itemOf(m, a);
  const ib = itemOf(m, b);
  if (!ia || !ib) return;
  selectRect(t, {
    r0: Math.min(ia.r, ib.r), c0: Math.min(ia.c, ib.c),
    r1: Math.max(ia.r + ia.rs, ib.r + ib.rs) - 1, c1: Math.max(ia.c + ia.cs, ib.c + ib.cs) - 1
  }, a);
}

/**
 * 표 t 를 html(표 하나)로 갈아 끼운다 — 표를 골라 insertHTML (되돌리기 한 번). 새 표를 돌려준다.
 * 크로미움은 넣으면서 문맥과 같은 값의 칸 style 을 «쓸데없다»고 떼고 그 칸의 style 을 rgb()·긴 이름으로 다시 쓴다
 * (text-align:left · font-weight:normal · white-space:nowrap · 본문과 같은 font-size — 인용문·서명 표에 흔하다, 실측).
 * 그러면 넣은 표 노드는 그대로 두고 그 속성과 안쪽만 바란 꼴로 바꾼다 — 되돌리기·다시 하기는 이 표 노드를 통째로 빼고 넣으므로
 * 둘 다 바르다 (예전처럼 되돌린 뒤 DOM 으로 바꾸면 다시 하기가 같은 표를 하나 더 넣었다). insertHTML 이 표를 못 넣었을 때만
 * DOM 으로 바로 바꾼다 (그 한 번은 되돌리기에 안 실린다 — tgStats.fallbacks 로 세고 알린다)
 */
function commit(t, html) {
  const fresh = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.firstElementChild;
  if (!fresh || fresh.tagName !== 'TABLE') return null;
  if (document.activeElement !== body) body.focus();
  const sel = getSelection();
  const r = document.createRange();
  r.selectNode(t);
  sel.removeAllRanges();
  sel.addRange(r);
  const did = document.execCommand('insertHTML', false, String(html).replace(/^<table/i, '<table data-tg-new="1"'));
  let nt = body.querySelector('table[data-tg-new]');
  if (nt) {
    nt.removeAttribute('data-tg-new');
    if (nt.outerHTML !== fresh.outerHTML) {
      for (const a of [...nt.attributes]) if (!fresh.hasAttribute(a.name)) nt.removeAttribute(a.name);
      for (const a of fresh.attributes) if (nt.getAttribute(a.name) !== a.value) nt.setAttribute(a.name, a.value);
      nt.replaceChildren(...[...fresh.childNodes].map((n) => document.importNode(n, true)));
      tgStats.synced += 1;
    }
  } else {
    if (did && !t.isConnected) document.execCommand('undo');
    if (!t.isConnected) return null;
    nt = document.importNode(fresh, true);
    t.replaceWith(nt);
    tgStats.fallbacks += 1;
    say('', '표를 고쳤습니다 — 이번 고침은 Ctrl+Z 로 되돌릴 수 없습니다');
    body.dispatchEvent(new Event('input', { bubbles: true }));
  }
  tgStamp += 1;
  return nt;
}

/** 셈이 칸 배치를 안 바꿨나 — 칸마다 자리·합침이 같고, 글·속성이 바뀐 칸은 다 본문 칸이다 (tidy 가 채운 빈 칸이 아니다) */
function sameShape(a, b) {
  const J = (v) => JSON.stringify(v || null);
  if (a.h !== b.h || a.w !== b.w || a.items.length !== b.items.length || J(a.attrs) !== J(b.attrs) || J(a.cols) !== J(b.cols)
    || J(a.caption) !== J(b.caption) || J(a.meta.map((x) => [x.sec, x.attrs])) !== J(b.meta.map((x) => [x.sec, x.attrs]))) return false;
  return a.items.every((it, i) => {
    const x = b.items[i];
    if (x.ref !== it.ref || x.r !== it.r || x.c !== it.c || x.rs !== it.rs || x.cs !== it.cs || x.tag !== it.tag) return false;
    return !!it.ref || (x.html === it.html && J(x.attrs) === J(it.attrs));
  });
}

/**
 * 칸 배치를 안 바꾸는 셈(내용 지우기·배경색·머리글)의 새 표 — 본문 표의 사본에서 바뀐 칸의 글·속성만 고친다.
 * 지도(tidy)로 다시 지으면 겹치는 합침이 든 웹 표는 tidy 가 자른 꼴로 바뀐다 — 그려진 꼴을 그대로 두려고
 */
function patched(t, m0, m1) {
  const copy = t.cloneNode(true);
  const live = [...t.querySelectorAll('td, th')];
  const dup = [...copy.querySelectorAll('td, th')];
  const J = (v) => JSON.stringify(v || {});
  m1.items.forEach((it, i) => {
    const was = m0.items[i];
    const c = it.ref ? dup[live.indexOf(it.ref)] : null;
    if (!c) return;
    if (it.html !== was.html) {
      if (!it.html) c.replaceChildren(document.createElement('br'));
      else c.replaceChildren(...[...new DOMParser().parseFromString(`<body>${it.html}</body>`, 'text/html').body.childNodes].map((n) => document.importNode(n, true)));
    }
    if (J(it.attrs) !== J(was.attrs)) {
      for (const a of [...c.attributes]) if (a.name !== 'rowspan' && a.name !== 'colspan' && !(a.name in it.attrs)) c.removeAttribute(a.name);
      for (const [k, v] of Object.entries(it.attrs)) c.setAttribute(k, v);
    }
  });
  for (const x of [copy, ...copy.querySelectorAll('[class]')]) {
    x.classList.remove('tg-on');
    if (x.hasAttribute('class') && !x.classList.length) x.removeAttribute('class');
  }
  return copy.outerHTML;
}

/** 칸 안 글 자리 — 칸 맨 앞부터 커서까지 글자 수 */
function offsetIn(cell, r) {
  if (!cell || !r || !cell.contains(r.startContainer)) return 0;
  const x = document.createRange();
  x.selectNodeContents(cell);
  x.setEnd(r.startContainer, r.startOffset);
  return x.toString().length;
}
/** 칸 안 n 번째 글자 자리에 커서 (글이 모자라면 칸 끝) */
function placeIn(cell, n) {
  const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let left = n;
  for (let tx = w.nextNode(); tx; tx = w.nextNode()) {
    if (left <= tx.length) {
      const r = document.createRange();
      r.setStart(tx, left);
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    left -= tx.length;
  }
  caretInto(cell, n > 0);
}

/** 칸마다 열 너비에 더해지는 여백·선 (그려진 칸 너비 − 안쪽 너비) — 열을 통째로 합칠 때 사이 여백·선만큼 너비를 더한다 */
function cellExtra(t) {
  const c = t.querySelector('td, th');
  if (!c) return CELL_EXTRA;
  const x = c.getBoundingClientRect().width - parseFloat(getComputedStyle(c).width);
  return Number.isFinite(x) && x >= 0 ? Math.round(x) : CELL_EXTRA;
}

/** 표 지우기 — 표를 골라 지운다 (되돌리기 한 번) */
function dropTable(t) {
  if (document.activeElement !== body) body.focus();
  const r = document.createRange();
  r.selectNode(t);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.execCommand('delete');
  if (t.isConnected) {
    t.remove();
    body.dispatchEvent(new Event('input', { bubbles: true }));
  }
  tgStamp += 1;
  tgHot = null;
  paintTools();
}

/**
 * 표 셈 하나 — op(m) 은 tablegrid 셈의 답 ({ model, focus } · { gone } · 못 하면 null·{ refused }).
 * 표를 통째로 바꿔 넣고, 커서를 셈이 말한 칸(없으면 커서가 있던 칸)에 둔다.
 *   opt.keep — 칸 고르기를 새 표에 다시 (배경색을 칠한 뒤 이어서 다른 것을 하게)
 *   opt.stay — 커서를 셈 전 자리에 둔다 (너비 끌기): 표 밖이면 그 자리, 이 표 칸 안이면 새 표의 같은 칸 같은 글자 자리
 * 칸 배치를 안 바꾸는 셈은 지도로 다시 짓지 않고 바뀐 칸만 고친 사본을 넣는다 (patched)
 */
function runOp(t, op, opt = {}) {
  if (!t || !t.isConnected || !body.contains(t)) return null;
  const spot = caretSpot(t);
  const before = caretRange();
  const at = spot && before ? offsetIn(caretCell(), before) : 0;
  let m0 = null;
  let res = null;
  try { m0 = grid.tidy(readRaw(t, true)); res = op(m0); } catch { res = null; }
  if (!res || res.refused) return null;
  closeMenus();
  clearCells();
  tgLine = null;
  if (res.gone) { dropTable(t); return null; }
  const nt = commit(t, sameShape(m0, res.model) ? patched(t, m0, res.model) : grid.toHtml(res.model));
  if (!nt) return null;
  if (opt.stay && spot) {
    const cell = cellAt(nt, spot.r, spot.c);
    if (cell) placeIn(cell, at);
  } else if (opt.stay && before && body.contains(before.startContainer)) {
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(before);
  } else {
    const f = res.focus || spot || { r: 0, c: 0 };
    const cell = cellAt(nt, f.r, f.c);
    if (cell) caretInto(cell);
  }
  if (opt.keep) selectRect(nt, opt.keep, cellAt(nt, opt.keep.r0, opt.keep.c0));
  if (tgHot === t) tgHot = nt;
  paintTools();
  return nt;
}

// ── 메뉴 (손잡이·오른쪽 클릭·배경색) ──
// 포커스는 본문에 둔 채 키는 document 의 붙잡기(capture) 단계에서 받는다 — 화살표·Enter·Esc 가 본문으로 안 간다
const usable = (m, i) => { const it = m.items[i]; return !!it && it !== '-' && !it.disabled; };
function nextItem(m, from, dir) {
  const n = m.items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (usable(m, i)) return i;
  }
  return -1;
}
function focusItem(m, i) {
  m.at = i;
  m.rows.forEach((row, k) => { if (row) row.classList.toggle('on', k === i); });
  // 작은 창에서는 메뉴가 굴러간다 — 키보드로 고른 줄이 보이게 메뉴만 굴린다 (scrollIntoView 는 카드까지 굴린다)
  const row = m.rows[i];
  if (row && m.el.scrollHeight > m.el.clientHeight) {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < m.el.scrollTop) m.el.scrollTop = top;
    else if (bottom > m.el.scrollTop + m.el.clientHeight) m.el.scrollTop = bottom - m.el.clientHeight;
  }
}
function closeMenus(from = 0) {
  for (const m of tgMenus.splice(from)) m.el.remove();
  if (!tgMenus.length && tgLine) {
    tgLine = null;
    clearCells();
    paintTools();
  }
}
/** 메뉴를 (x,y) 에 연다 — 창(카드) 안으로 당긴다. 하위 메뉴가 오른쪽에 안 들어가면 flipX(부모 왼쪽)로 */
function openMenu(items, x, y, level = 0, flipX) {
  closeMenus(level);
  const el = document.createElement('div');
  el.className = 'tg-menu';
  el.setAttribute('role', 'menu');
  const m = { el, items, at: -1, rows: [], level };
  items.forEach((it, i) => {
    if (it === '-') {
      el.append(document.createElement('hr'));
      m.rows.push(null);
      return;
    }
    const row = document.createElement('div');
    row.className = 'mi';
    row.setAttribute('role', 'menuitem');
    if (it.swatch !== undefined) {
      const sw = document.createElement('span');
      sw.className = 'sw';
      if (it.swatch) sw.style.setProperty('--c', it.swatch);
      row.append(sw);
    }
    const lb = document.createElement('span');
    lb.textContent = it.label;
    row.append(lb);
    if (it.sub) {
      const s = document.createElement('span');
      s.className = 'sub';
      s.textContent = '▸';
      row.append(s);
    }
    if (it.disabled) row.setAttribute('aria-disabled', 'true');
    if (it.title) row.title = it.title;
    row.addEventListener('mouseover', () => {
      if (m.at === i || !tgMenus.includes(m)) return;
      focusItem(m, usable(m, i) ? i : -1);
      if (it.sub && usable(m, i)) openSub(m, i); else closeMenus(m.level + 1);
    });
    row.addEventListener('click', () => pickItem(m, i));
    el.append(row);
    m.rows.push(row);
  });
  el.addEventListener('mousedown', keepFocus);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  tgCard.append(el);
  const cr = tgCard.getBoundingClientRect();
  // 카드보다 길면(작은 창) 카드 높이로 자르고 메뉴 안에서 굴린다 — 카드는 넘친 것을 감춰서 아래 줄을 못 누른다
  el.style.maxHeight = `${Math.max(60, Math.floor(cr.height - 8))}px`;
  let left = x - cr.left;
  if (left + el.offsetWidth > cr.width - 4 && flipX !== undefined) left = flipX - cr.left - el.offsetWidth;
  left = Math.max(4, Math.min(left, cr.width - el.offsetWidth - 4));
  const top = Math.max(4, Math.min(y - cr.top, cr.height - el.offsetHeight - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  tgMenus.push(m);
  focusItem(m, nextItem(m, -1, 1));
  return m;
}
function openSub(m, i) {
  const r = m.rows[i].getBoundingClientRect();
  openMenu(m.items[i].sub, r.right + 2, r.top - 4, m.level + 1, r.left - 2);
}
function pickItem(m, i) {
  if (!usable(m, i)) return;
  const it = m.items[i];
  if (it.sub) { openSub(m, i); return; }
  closeMenus();
  it.act();
}
/** 배경색 하위 메뉴 — 기본(없음)과 노션의 옅은 채움 */
const palette = (fn) => grid.PALETTE.map((p) => ({ label: p.name, swatch: p.color || '', act: () => fn(p.color) }));
const headOf = (t, kind) => grid.headerOn(grid.tidy(readRaw(t, true)), kind);
const rowRect = (r) => (m) => ({ r0: r, c0: 0, r1: r, c1: m.w - 1 });
const colRect = (c) => (m) => ({ r0: 0, c0: c, r1: m.h - 1, c1: c });

/** 줄 손잡이 메뉴 — 줄 r (c 는 커서를 둘 열) */
function rowMenu(t, r, c) {
  const items = [
    { label: '위에 행 넣기', act: () => runOp(t, (m) => grid.insertRow(m, r, 'above', { c })) },
    { label: '아래에 행 넣기', act: () => runOp(t, (m) => grid.insertRow(m, r, 'below', { c })) },
    { label: '복제', act: () => runOp(t, (m) => grid.duplicateRow(m, r, { c })) },
    { label: '지우기', act: () => runOp(t, (m) => grid.deleteRow(m, r, { c })) },
    '-',
    { label: '배경색', sub: palette((color) => runOp(t, (m) => grid.paint(m, rowRect(r)(m), color))) },
    { label: '내용 지우기', act: () => runOp(t, (m) => grid.clear(m, rowRect(r)(m))) }
  ];
  if (r === 0) {
    const on = headOf(t, 'row');
    items.push('-', { label: on ? '머리글 끄기' : '머리글 켜기', act: () => runOp(t, (m) => grid.header(m, 'row', !on)) });
  }
  return items;
}
/** 열 손잡이 메뉴 — 열 c (r 은 커서를 둘 줄) */
function colMenu(t, c, r) {
  const items = [
    { label: '왼쪽에 열 넣기', act: () => runOp(t, (m) => grid.insertCol(m, c, 'left', { r, ...fitOpt(t) })) },
    { label: '오른쪽에 열 넣기', act: () => runOp(t, (m) => grid.insertCol(m, c, 'right', { r, ...fitOpt(t) })) },
    { label: '복제', act: () => runOp(t, (m) => grid.duplicateCol(m, c, { r })) },
    { label: '지우기', act: () => runOp(t, (m) => grid.deleteCol(m, c, { r })) },
    '-',
    { label: '배경색', sub: palette((color) => runOp(t, (m) => grid.paint(m, colRect(c)(m), color))) },
    { label: '내용 지우기', act: () => runOp(t, (m) => grid.clear(m, colRect(c)(m))) }
  ];
  if (c === 0) {
    const on = headOf(t, 'col');
    items.push('-', { label: on ? '머리글 끄기' : '머리글 켜기', act: () => runOp(t, (m) => grid.header(m, 'col', !on)) });
  }
  return items;
}
const MERGE_WHY = {
  section: '머리글 줄(thead)과 본문 줄은 합칠 수 없습니다 — 따로 골라 합쳐 주세요',
  one: '칸을 둘 이상 고르면 합칠 수 있습니다'
};
/** 고른 칸이 합친 칸 하나뿐이면 그 칸 */
function oneMerged() {
  if (!tgSel) return null;
  const m = mapOf(tgSel.table);
  const inside = m.items.filter((it) => inRect(it, tgSel.rect));
  return inside.length === 1 && inside[0].ref ? inside[0].ref : null;
}
/** 오른쪽 클릭 메뉴 — 모든 동작. 고른 칸이 있으면 합치기·배경색·내용 지우기는 그 칸들에, 아니면 누른 칸에 */
function ctxMenu(cell) {
  const t = cell.closest('table');
  const full = grid.tidy(readRaw(t, true));
  const it = full.items.find((x) => x.ref === cell);
  if (!it) return [];
  const { r, c } = it;
  const rEnd = it.r + it.rs - 1;
  const cEnd = it.c + it.cs - 1;
  const sel = tgSel && tgSel.table === t ? tgSel.rect : null;
  const rect = sel || { r0: r, c0: c, r1: rEnd, c1: cEnd };
  const can = sel ? grid.canMerge(full, sel) : { ok: false, why: 'one' };
  const one = sel ? oneMerged() : (it.rs > 1 || it.cs > 1 ? cell : null);
  const oneIt = one ? full.items.find((x) => x.ref === one) : null;
  const hr = grid.headerOn(full, 'row');
  const hc = grid.headerOn(full, 'col');
  return [
    { label: '위에 행 넣기', act: () => runOp(t, (m) => grid.insertRow(m, r, 'above', { c })) },
    { label: '아래에 행 넣기', act: () => runOp(t, (m) => grid.insertRow(m, rEnd, 'below', { c })) },
    { label: '왼쪽에 열 넣기', act: () => runOp(t, (m) => grid.insertCol(m, c, 'left', { r, ...fitOpt(t) })) },
    { label: '오른쪽에 열 넣기', act: () => runOp(t, (m) => grid.insertCol(m, cEnd, 'right', { r, ...fitOpt(t) })) },
    '-',
    { label: '행 복제', act: () => runOp(t, (m) => grid.duplicateRow(m, rEnd, { c })) },
    { label: '열 복제', act: () => runOp(t, (m) => grid.duplicateCol(m, cEnd, { r })) },
    { label: '행 지우기', act: () => runOp(t, (m) => grid.deleteRow(m, r, { c })) },
    { label: '열 지우기', act: () => runOp(t, (m) => grid.deleteCol(m, c, { r })) },
    '-',
    { label: '칸 합치기', disabled: !can.ok, title: can.ok ? '' : MERGE_WHY[can.why], act: () => runOp(t, (m) => grid.merge(m, sel, { extra: cellExtra(t) })) },
    { label: '칸 나누기', disabled: !oneIt, title: oneIt ? '' : '합친 칸에서 나눌 수 있습니다', act: () => runOp(t, (m) => grid.split(m, oneIt.r, oneIt.c)) },
    '-',
    { label: '배경색', sub: palette((color) => runOp(t, (m) => grid.paint(m, rect, color), { keep: sel })) },
    { label: hr ? '머리글 행 끄기' : '머리글 행 켜기', act: () => runOp(t, (m) => grid.header(m, 'row', !hr)) },
    { label: hc ? '머리글 열 끄기' : '머리글 열 켜기', act: () => runOp(t, (m) => grid.header(m, 'col', !hc)) },
    { label: '내용 지우기', act: () => runOp(t, (m) => grid.clear(m, rect)) },
    '-',
    { label: '표 지우기', act: () => { clearCells(); dropTable(t); } }
  ];
}

// ── 손잡이·띠·막대 그리기 ──
function placeTool(el, on, x, y, w, h) {
  el.classList.toggle('on', !!on);
  if (!on) return;
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  if (w !== undefined) el.style.width = `${Math.round(w)}px`;
  if (h !== undefined) el.style.height = `${Math.round(h)}px`;
}
/** 다음 그림 차례에 한 번 그린다 — 창이 가려져 그림 차례가 안 오면 60ms 뒤에라도 */
function paintSoon() {
  if (tgRaf) return;
  const run = () => {
    if (!tgRaf) return;
    cancelAnimationFrame(tgRaf.frame);
    clearTimeout(tgRaf.timer);
    tgRaf = 0;
    paintTools();
  };
  tgRaf = { frame: requestAnimationFrame(run), timer: setTimeout(run, 60) };
}
/**
 * 손잡이·+ 띠·너비 손잡이·고른 칸 막대를 그린다. 어느 줄·열인가 — 메뉴가 떠 있는 줄·열, 마우스를 올린 칸, 커서가 있는 칸 차례.
 * 층은 본문 자리에 맞춰 두고(종이 밖으로 안 나간다), 그릴 자리가 본문 밖으로 굴러 나간 것은 숨긴다
 */
function paintTools() {
  const els = { row: $('tg-row'), col: $('tg-col'), addC: $('tg-add-col'), addR: $('tg-add-row'), size: $('tg-size'), bar: $('tg-cellbar') };
  if (tgHot && (!tgHot.isConnected || !body.contains(tgHot))) tgHot = null;
  if (tgSel && !tgSel.table.isConnected) clearCells();
  if (tgLine && !tgLine.table.isConnected) tgLine = null;
  const cc = caretCell();
  let t = null;
  let r = 0;
  let c = 0;
  if (tgLine) ({ table: t, r, c } = tgLine);
  else if (tgHot) { t = tgHot; r = tgHotRow; c = tgHotCol; }
  else if (cc) {
    t = cc.closest('table');
    const it = itemOf(mapOf(t), cc);
    if (it) ({ r, c } = it);
  }
  const hover = !!t && tgHot === t;
  const barCell = !tgSel && cc && (cc.rowSpan > 1 || cc.colSpan > 1) ? cc : null;
  tgShown = null;
  if (!t && !tgSel && !barCell && !tgSize) {
    tgLayer.classList.remove('on');
    return;
  }
  tgLayer.classList.add('on');
  tgLayer.style.left = `${body.offsetLeft}px`;
  tgLayer.style.top = `${body.offsetTop}px`;
  tgLayer.style.width = `${body.clientWidth}px`;
  tgLayer.style.height = `${body.clientHeight}px`;
  const L = tgLayer.getBoundingClientRect();
  const seen = (x, y) => x >= -1 && x <= L.width + 1 && y >= -1 && y <= L.height + 1;
  let m = null;
  let tr = null;
  let ed = null;
  if (t) {
    m = mapOf(t);
    if (!m.h || !m.w) t = null;
  }
  if (t) {
    r = Math.min(r, m.h - 1);
    c = Math.min(c, m.w - 1);
    tgShown = { table: t, r, c };
    tr = t.getBoundingClientRect();
    ed = edgesOf(t, m);
    const rr = rowsOf(m)[r];
    if (rr) {
      const gh = Math.min(20, Math.max(12, rr.height - 2));
      const x = tr.left - L.left - 15;
      const y = rr.top - L.top + (rr.height - gh) / 2;
      placeTool(els.row, seen(x + 13, y + gh / 2), Math.max(0, x), y, undefined, gh);
    } else placeTool(els.row, false);
    // 열 손잡이는 표 윗선에 걸친다 (노션처럼) — 선 위에 두면 표 바로 위 글 줄을 가린다
    const gx = (ed[c] + ed[c + 1]) / 2 - L.left - 11;
    const gy = tr.top - L.top - 6;
    placeTool(els.col, seen(gx + 11, gy + 6), gx, Math.max(0, gy));
    els.row.classList.toggle('lit', !!tgLine && tgLine.kind === 'row');
    els.col.classList.toggle('lit', !!tgLine && tgLine.kind === 'col');
    // + 띠 — 마우스를 올렸을 때만
    placeTool(els.addC, hover, tr.right - L.left + 3, tr.top - L.top, 12, tr.height);
    placeTool(els.addR, hover, tr.left - L.left, tr.bottom - L.top + 3, tr.width, 12);
  } else {
    for (const k of ['row', 'col', 'addC', 'addR']) placeTool(els[k], false);
  }
  // 너비 손잡이 — 열 오른쪽 선 가까이 (끄는 중이면 끄는 선에)
  const se = tgSize ? { table: tgSize.table, col: tgSize.col } : tgEdge;
  if (se && se.table.isConnected && (tgSize || (hover && se.table === t))) {
    const sm = mapOf(se.table);
    const sx = edgesOf(se.table, sm)[Math.min(se.col, sm.w - 1) + 1];
    const st = se.table.getBoundingClientRect();
    placeTool(els.size, true, sx - L.left - 3, st.top - L.top, 7, st.height);
  } else placeTool(els.size, false);
  paintCellBar(els.bar, L, barCell);
}
/** 고른 칸 위 막대 — 칸 여럿이면 합치기·배경색·내용 지우기, 커서가 합친 칸에 있으면(또는 그 칸 하나만 골랐으면) 나누기 */
function paintCellBar(bar, L, barCell) {
  let box = null;
  if (tgSel) {
    const m = mapOf(tgSel.table);
    for (const it of m.items) {
      if (!it.ref || !inRect(it, tgSel.rect)) continue;
      const q = it.ref.getBoundingClientRect();
      box = box ? { left: Math.min(box.left, q.left), top: Math.min(box.top, q.top), right: Math.max(box.right, q.right), bottom: Math.max(box.bottom, q.bottom) } : { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
    }
  } else if (barCell) {
    box = barCell.getBoundingClientRect();
  }
  // 고른 칸이 본문 밖으로 굴러 나갔으면 막대도 숨긴다 (손잡이처럼) — 종이 끝에 붙어 떠 있지 않게
  if (!box || box.bottom < L.top || box.top > L.bottom) { placeTool(bar, false); return; }
  const one = tgSel ? oneMerged() : barCell;
  $('tg-merge').classList.toggle('hide', !tgSel || !!one);
  $('tg-split').classList.toggle('hide', !one);
  $('tg-paint').classList.toggle('hide', !tgSel);
  $('tg-wipe').classList.toggle('hide', !tgSel);
  if (tgSel && !one) {
    const can = grid.canMerge(mapOf(tgSel.table), tgSel.rect);
    $('tg-merge').disabled = !can.ok;
    $('tg-merge').title = can.ok ? '고른 칸을 하나로' : MERGE_WHY[can.why];
  }
  placeTool(bar, true, 0, 0);
  const bw = bar.offsetWidth;
  const bh = bar.offsetHeight;
  let y = box.top - L.top - bh - 4;
  if (y < 2) y = box.bottom - L.top + 4;
  placeTool(bar, true, Math.max(2, Math.min(box.left - L.left, L.width - bw - 2)), Math.min(y, L.height - bh - 2));
}

// ── 마우스 ──
/** 표 둘레(손잡이·띠가 서는 자리)까지 — 표에서 손잡이로 옮겨 가는 동안 손잡이가 사라지지 않게 */
function nearTable(t, x, y) {
  const q = t.getBoundingClientRect();
  return x >= q.left - 24 && x <= q.right + 20 && y >= q.top - 20 && y <= q.bottom + 20;
}
document.addEventListener('mousemove', (e) => {
  if (tgSize) return;   // 너비를 끄는 중은 아래 window 처리기가 맡는다
  const target = e.target && e.target.nodeType === 1 ? e.target : null;
  const cell = cellOf(target);
  const onTool = !!(target && target.closest('.tg-layer > div'));
  let t = cell ? cell.closest('table') : null;
  if (!t && tgHot && tgHot.isConnected && (onTool || nearTable(tgHot, e.clientX, e.clientY))) t = tgHot;
  tgHot = t;
  tgEdge = null;
  if (t) {
    const m = mapOf(t);
    if (m.h && m.w) {
      const ri = rowsOf(m).findIndex((q) => q && e.clientY >= q.top && e.clientY < q.bottom);
      if (ri >= 0) tgHotRow = ri;
      const ed = edgesOf(t, m);
      for (let k = 0; k < m.w; k++) if (e.clientX >= ed[k] && e.clientX < ed[k + 1]) tgHotCol = k;
      // 열 오른쪽 선 가까이 — 너비 손잡이
      const q = t.getBoundingClientRect();
      if (e.clientY >= q.top && e.clientY <= q.bottom) for (let k = 1; k <= m.w; k++) if (Math.abs(e.clientX - ed[k]) <= 4) tgEdge = { table: t, col: k - 1 };
    }
  }
  // 칸에서 누른 채 다른 칸으로 — 칸 고르기
  // 처음 칸으로 돌아오면 칸 고르기를 풀고 칸 하나(글 고르기)로
  if (tgDrag && (e.buttons & 1) && cell && cell.closest('table') === tgDrag.table) {
    if (cell !== tgDrag.anchor) selectCells(tgDrag.table, tgDrag.anchor, cell);
    else if (tgSel) clearCells();
  }
  paintTools();
});
body.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;   // 오른쪽 클릭은 contextmenu 가 맡는다
  const cell = cellOf(e.target);
  if (cell && e.shiftKey) {
    const t = cell.closest('table');
    const cc = caretCell();
    const a = tgAnchor && tgAnchor.isConnected && tgAnchor.closest('table') === t ? tgAnchor : cc && cc.closest('table') === t ? cc : null;
    // 다른 칸이면 칸 고르기. 같은 칸 안이면 막지 않는다 — 칸 안 글 고르기를 늘리는 기본 동작 (굵게·복사할 글 고르기)
    if (a && a !== cell) {
      e.preventDefault();   // 글 고르기를 늘리지 않고 칸을 고른다
      selectCells(t, a, cell);
      paintTools();
      return;
    }
  }
  clearCells();
  tgDrag = cell ? { table: cell.closest('table'), anchor: cell } : null;
  tgAnchor = cell;
  paintSoon();
});
window.addEventListener('mouseup', () => {
  tgDrag = null;
  // 끄는 동안 크로미움이 늘린 글 고르기를 처음 칸에 다시 접는다
  if (tgSel && tgSel.anchor && tgSel.anchor.isConnected && !getSelection().isCollapsed) caretInto(tgSel.anchor, true);
});
body.addEventListener('contextmenu', (e) => {
  let cell = cellOf(e.target);
  let x = e.clientX;
  let y = e.clientY;
  if (!cell && e.target === body) {
    // 메뉴 키(Shift+F10)로 열면 커서 칸에
    cell = caretCell();
    if (cell) { const q = cell.getBoundingClientRect(); x = q.left + 8; y = q.bottom - 4; }
  }
  if (!cell) return;
  e.preventDefault();
  if (tgSel && !(tgSel.table === cell.closest('table') && cell.classList.contains('tg-on'))) clearCells();
  openMenu(ctxMenu(cell), x, y);
  paintTools();
});
document.addEventListener('mousedown', (e) => {
  const t = e.target && e.target.nodeType === 1 ? e.target : null;
  if (tgPick.open && !(t && t.closest('#tg-pick, #btn-table'))) closePick();
  if (tgMenus.length && !(t && t.closest('.tg-menu'))) closeMenus();
}, true);
body.addEventListener('scroll', () => { closeMenus(); paintTools(); });
window.addEventListener('resize', () => paintTools());
document.addEventListener('selectionchange', () => { if (!tgSize) paintSoon(); });
body.addEventListener('input', (e) => {
  tgStamp += 1;
  // 되돌리기로 살아난 옛 칸의 고른 표시는 걷는다
  if (e.inputType && e.inputType.startsWith('history') && !tgSel && !tgLine) clearCells();
  paintSoon();
});

for (const id of ['tg-row', 'tg-col', 'tg-add-col', 'tg-add-row']) $(id).addEventListener('mousedown', keepFocus);
for (const b of $('tg-cellbar').querySelectorAll('button')) b.addEventListener('mousedown', keepFocus);
/** 손잡이를 누르면 — 그 줄·열 칸을 다 고른 표시로, 메뉴를 연다 */
function openLine(kind) {
  const s = tgShown;
  if (!s || !s.table.isConnected) return;
  clearCells();
  const m = mapOf(s.table);
  markCells(m.items.filter((it) => (kind === 'row' ? it.r <= s.r && it.r + it.rs > s.r : it.c <= s.c && it.c + it.cs > s.c)));
  const g = $(kind === 'row' ? 'tg-row' : 'tg-col').getBoundingClientRect();
  const spot = caretSpot(s.table);
  if (kind === 'row') openMenu(rowMenu(s.table, s.r, spot ? spot.c : s.c), g.right + 4, g.top);
  else openMenu(colMenu(s.table, s.c, spot ? spot.r : s.r), g.left, g.bottom + 4);
  tgLine = { table: s.table, kind, r: s.r, c: s.c };
  paintTools();
}
$('tg-row').addEventListener('click', () => openLine('row'));
$('tg-col').addEventListener('click', () => openLine('col'));
$('tg-add-col').addEventListener('click', () => {
  const s = tgShown;
  if (s) runOp(s.table, (m) => grid.insertCol(m, m.w - 1, 'right', { r: s.r, ...fitOpt(s.table) }));
});
$('tg-add-row').addEventListener('click', () => {
  const s = tgShown;
  if (s) runOp(s.table, (m) => grid.insertRow(m, m.h - 1, 'below', { c: s.c }));
});
$('tg-merge').addEventListener('click', () => {
  const s = tgSel;
  if (s && !$('tg-merge').disabled) runOp(s.table, (m) => grid.merge(m, s.rect, { extra: cellExtra(s.table) }));
});
$('tg-split').addEventListener('click', () => {
  const cell = tgSel ? oneMerged() : caretCell();
  if (!cell) return;
  const t = cell.closest('table');
  const it = itemOf(mapOf(t), cell);
  if (it) runOp(t, (m) => grid.split(m, it.r, it.c));
});
$('tg-paint').addEventListener('click', () => {
  const s = tgSel;
  if (!s) return;
  const q = $('tg-paint').getBoundingClientRect();
  openMenu(palette((color) => runOp(s.table, (m) => grid.paint(m, s.rect, color), { keep: s.rect })), q.left, q.bottom + 4);
});
$('tg-wipe').addEventListener('click', () => {
  const s = tgSel;
  if (s) runOp(s.table, (m) => grid.clear(m, s.rect));
});

// ── 열 너비 끌기 ──
// 끄는 동안은 칸의 width 를 바로 고쳐 보여 주고, 놓으면 고치기 전으로 되돌린 뒤 셈(resize)으로 한 번에 넣는다 —
// 그래야 Ctrl+Z 한 번이 끌기 전으로 간다. 열 너비는 40px 아래로 안 가고, 표는 들어 있는 칸(종이)보다 넓어지지 않는다
$('tg-size').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const ed = tgEdge;
  if (!ed || !ed.table.isConnected) return;
  const t = ed.table;
  const m = grid.tidy(readRaw(t, true));
  const meas = measureCols(t, m);
  // 열마다 적힌 너비(COL·칸)와 잰 너비 가운데 큰 것 — 종이보다 넓은 표는 크로미움이 칸을 줄여 그려서 잰 값이 적힌 값보다 작다.
  // 잰 값으로 적으면 끈 적 없는 열까지 줄어든다 (받는 사람이 보는 표도 줄어든다)
  const decl = grid.colWidths(m);
  const widths = meas.widths.map((x, k) => Math.max(x, decl[k] || 0));
  const els = [t, ...t.querySelectorAll(':scope > colgroup > col, :scope > col'), ...m.items.map((it) => it.ref).filter(Boolean)];
  tgSize = {
    table: t, col: ed.col, x0: e.clientX, m, widths, extra: meas.extra, room: roomOf(t.parentElement), now: widths,
    // 끄는 동안 포커스는 그대로(mousedown 을 막는다) — 놓은 뒤 셈이 본문에 포커스를 주므로, 제목 칸 등에 있었으면 되돌린다
    focus: document.activeElement,
    saved: els.map((el) => [el, el.getAttribute('width'), el.getAttribute('style')])
  };
});
window.addEventListener('mousemove', (e) => {
  const s = tgSize;
  if (!s) return;
  const others = s.widths.reduce((n, w, k) => (k === s.col ? n : n + w + s.extra), 0);
  // 끄는 열의 위쪽 한도는 지금 너비 아래로 내리지 않는다 — 이미 종이보다 넓은 표는 넓히지는 못하고 좁히기만 된다
  const max = Math.max(s.widths[s.col], grid.MIN_W, Math.floor(s.room - others - s.extra));
  const w = Math.max(grid.MIN_W, Math.min(max, Math.round(s.widths[s.col] + e.clientX - s.x0)));
  s.now = s.widths.map((x, k) => (k === s.col ? w : x));
  // 보여 주기만 — 놓을 때 되돌린다
  const res = grid.resize(s.m, s.now).model;
  for (const it of res.items) {
    if (!it.ref) continue;
    for (const a of ['width', 'style']) if (it.attrs[a] === undefined) it.ref.removeAttribute(a); else it.ref.setAttribute(a, it.attrs[a]);
  }
  let k = 0;
  for (const col of s.table.querySelectorAll(':scope > colgroup > col, :scope > col')) {
    if (s.now[k] !== undefined) col.setAttribute('width', String(s.now[k]));
    k += Math.max(1, parseInt(col.getAttribute('span'), 10) || 1);
  }
  s.table.removeAttribute('width');
  if (s.m.attrs.style !== undefined) {
    const st = grid.setDecl(s.m.attrs.style, 'width', null);
    if (st) s.table.setAttribute('style', st); else s.table.removeAttribute('style');
  }
  paintTools();
});
window.addEventListener('mouseup', () => {
  const s = tgSize;
  if (!s) return;
  tgSize = null;
  for (const [el, w, st] of s.saved) {
    if (w === null) el.removeAttribute('width'); else el.setAttribute('width', w);
    if (st === null) el.removeAttribute('style'); else el.setAttribute('style', st);
  }
  if (s.now.some((x, k) => x !== s.widths[k])) {
    runOp(s.table, (m) => grid.resize(m, s.now), { stay: true });
    const f = s.focus;
    if (f && f !== body && f !== document.body && f.isConnected && !body.contains(f) && typeof f.focus === 'function') f.focus();
  }
  paintTools();
});

// ── 키 ──
body.addEventListener('keydown', (e) => {
  if (e.isComposing || composing) {
    if (tgSel) clearCells();
    return;
  }
  // Ctrl+A, 또는 글 고르기가 이미 칸 고르기 밖으로 넓어졌으면 — 칸 고르기를 풀고 키는 기본 동작에 맡긴다
  // (안 그러면 Ctrl+A 뒤 Delete 가 본문 전체가 아니라 고른 칸 내용만 지운다)
  if (tgSel && (!inAnchor() || ((e.ctrlKey || e.metaKey) && e.code === 'KeyA'))) {
    clearCells();
    paintTools();
    return;
  }
  if (tgSel) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const s = tgSel;
      runOp(s.table, (m) => grid.clear(m, s.rect));
      return;
    }
    if (e.key === 'Escape') {
      // 창 닫기(Esc)까지 가지 않게
      e.preventDefault();
      e.stopPropagation();
      clearCells();
      paintTools();
      return;
    }
    if (MOD_KEYS.includes(e.key) || e.ctrlKey || e.metaKey) return;   // 바로 가기 키는 그대로
    // 치기·화살표 — 고르기를 풀고 처음 칸에서 이어 간다
    const a = tgSel.anchor;
    clearCells();
    if (a && a.isConnected) caretInto(a, true);
    paintTools();
    if (e.key !== 'Tab') return;
  }
  // Tab — 칸 안에서만 다음·앞 칸으로 (표 밖은 예전 그대로)
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const cell = caretCell();
    if (!cell) return;
    e.preventDefault();
    const t = cell.closest('table');
    const list = grid.order(mapOf(t)).filter((it) => it.ref);
    const i = list.findIndex((it) => it.ref === cell);
    const j = i + (e.shiftKey ? -1 : 1);
    if (i >= 0 && j >= list.length) runOp(t, (m) => grid.insertRow(m, m.h - 1, 'below'));
    else if (i >= 0 && j >= 0) caretInto(list[j].ref);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (tgPick.open) {
    const k = e.key;
    if (k === 'ArrowDown') tgPick.r = Math.min(8, tgPick.r + 1);
    else if (k === 'ArrowUp') tgPick.r = Math.max(1, tgPick.r - 1);
    else if (k === 'ArrowRight') tgPick.c = Math.min(8, tgPick.c + 1);
    else if (k === 'ArrowLeft') tgPick.c = Math.max(1, tgPick.c - 1);
    else if (k === 'Enter') insertTable(tgPick.r, tgPick.c);
    else if (k === 'Escape') closePick();
    else {
      if (!MOD_KEYS.includes(k)) closePick();
      return;
    }
    paintPick();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!tgMenus.length) return;
  const m = tgMenus[tgMenus.length - 1];
  const k = e.key;
  if (k === 'ArrowDown') focusItem(m, nextItem(m, m.at, 1));
  else if (k === 'ArrowUp') focusItem(m, nextItem(m, m.at, -1));
  else if (k === 'Enter' || k === ' ') pickItem(m, m.at);
  else if (k === 'ArrowRight') { if (usable(m, m.at) && m.items[m.at].sub) openSub(m, m.at); }
  else if (k === 'ArrowLeft') { if (tgMenus.length > 1) closeMenus(tgMenus.length - 1); }
  else if (k === 'Escape') closeMenus(tgMenus.length > 1 ? tgMenus.length - 1 : 0);
  else {
    if (!MOD_KEYS.includes(k)) closeMenus();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}, true);

// 칸 여럿을 고른 채 복사(Ctrl+C)·잘라내기(Ctrl+X) — 글 고르기는 접혀 있으므로 고른 칸을 표(HTML)와 탭·줄 글로 싣는다.
// 합친 칸은 글 몫에서 왼쪽 위 자리에만 글을 둔다 (엑셀처럼). 잘라내기는 구조는 두고 내용만 지운다
function copyCells(e, cut) {
  const s = tgSel;
  if (!s || !s.table.isConnected || !e.clipboardData) return;
  // 글 고르기가 칸 고르기 밖으로 넓어졌으면(Ctrl+A 등) 보통 복사로
  if (!inAnchor()) { clearCells(); paintTools(); return; }
  const m = grid.tidy(readRaw(s.table, true));
  const R = s.rect;
  const h = R.r1 - R.r0 + 1;
  const w = R.c1 - R.c0 + 1;
  const items = m.items.filter((it) => inRect(it, R)).map((it) => ({ ...it, r: it.r - R.r0, c: it.c - R.c0 }));
  const { id: _id, ...attrs } = m.attrs;
  const part = {
    attrs, caption: null, cols: m.cols ? m.cols.slice(R.c0, R.c1 + 1) : null, secs: [{ tag: 'tbody', attrs: {} }],
    meta: Array.from({ length: h }, (_, k) => ({ sec: 0, attrs: m.meta[R.r0 + k].attrs })), h, w, items
  };
  const text = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => {
    const it = items.find((x) => x.r === r && x.c === c);
    return it && it.ref ? it.ref.innerText.replace(/\s+/g, ' ').trim() : '';
  }).join('\t')).join('\n');
  e.preventDefault();
  e.clipboardData.setData('text/html', grid.toHtml(part));
  e.clipboardData.setData('text/plain', text);
  if (cut) runOp(s.table, (mm) => grid.clear(mm, R));
}
body.addEventListener('copy', (e) => copyCells(e, false));
body.addEventListener('cut', (e) => copyCells(e, true));

// ── «표» 단추 — 8×8 고르개 ──
for (let r = 1; r <= 8; r++) {
  for (let c = 1; c <= 8; c++) {
    const q = document.createElement('div');
    q.className = 'sq';
    q.dataset.r = String(r);
    q.dataset.c = String(c);
    $('tg-grid').append(q);
  }
}
function paintPick() {
  for (const q of $('tg-grid').children) q.classList.toggle('on', Number(q.dataset.r) <= tgPick.r && Number(q.dataset.c) <= tgPick.c);
  $('tg-lbl').textContent = `${tgPick.r} × ${tgPick.c}`;
}
function openPick() {
  closeMenus();
  // 고르는 동안 본문을 누르면 닫힌다 — 연 순간의 커서 자리에 넣는다 («그림» 단추와 같다)
  tgPick.here = caretRange();
  tgPick.r = 1;
  tgPick.c = 1;
  paintPick();
  const p = $('tg-pick');
  p.classList.add('on');
  const b = $('btn-table').getBoundingClientRect();
  const cr = tgCard.getBoundingClientRect();
  p.style.left = `${Math.max(4, Math.min(b.left - cr.left, cr.width - p.offsetWidth - 4))}px`;
  p.style.top = `${b.bottom - cr.top + 4}px`;
  tgPick.open = true;
}
function closePick() {
  $('tg-pick').classList.remove('on');
  tgPick.open = false;
}
/**
 * 빈 표를 넣는다 — 붙인 표와 같은 꼴(pastetable.blank), insertHTML 이라 Ctrl+Z 한 번에 빠진다. 커서는 첫 칸.
 * 커서가 표 안이면 그 표(가장 바깥 표) 바로 뒤에 — 표 안에 표를 만들지 않는다. 열 너비는 120px, 종이에 안 들어가면 좁힌다
 */
function insertTable(rows, cols) {
  closePick();
  let r = insertSpot(tgPick.here && tgPick.here.startContainer.isConnected ? tgPick.here : null);
  const inT = outerTable(r.startContainer);
  if (inT) {
    r = document.createRange();
    r.setStartAfter(inT);
    r.collapse(true);
  }
  const host = elOf(r.startContainer);
  const room = roomOf((host && host.closest('blockquote, td, th')) || body);
  const w = Math.max(grid.MIN_W, Math.min(tableKit.COL_W, Math.floor(room / cols) - CELL_EXTRA));
  let html = tableKit.blank(rows, cols, w).replace('<table', '<table data-tg-new="1"');
  // 표 안에서 넣거나 커서가 표 바로 뒤 빈 줄이면 옛 표 바로 뒤 — 두 표가 붙어 사이에 글을 쓸 줄이 없지 않게 빈 줄을 앞에 둔다
  if (inT || rightAfterTable(r)) html = `<div><br></div>${html}`;
  if (lineEndsHere(r)) html += '<div><br></div>';
  if (document.activeElement !== body) body.focus();
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.execCommand('insertHTML', false, html);
  const t = body.querySelector('table[data-tg-new]');
  if (!t) return;
  t.removeAttribute('data-tg-new');
  tgStamp += 1;
  caretInto(t.rows[0].cells[0]);
  paintTools();
}
$('tg-pick').addEventListener('mousedown', keepFocus);
$('tg-grid').addEventListener('mouseover', (e) => {
  const q = e.target.closest('.sq');
  if (!q) return;
  tgPick.r = Number(q.dataset.r);
  tgPick.c = Number(q.dataset.c);
  paintPick();
});
$('tg-grid').addEventListener('click', (e) => {
  const q = e.target.closest('.sq');
  if (q) insertTable(Number(q.dataset.r), Number(q.dataset.c));
});
$('btn-table').onclick = () => (tgPick.open ? closePick() : openPick());

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
// 보내는 본문의 글꼴·크기·줄 높이·색 — 쓰기 창 .body 와 같게 (compose.html). 감싸는 div 와 표마다 인라인으로 적는다
const BODY_FONT = [['font-family', "'맑은 고딕','Malgun Gothic',sans-serif"], ['font-size', '14px'], ['line-height', '1.7'], ['color', '#1a1a1a']];

async function bodyForSend() {
  // cloneNode로 만들면 복제된 <img>가 cid: 주소를 진짜로 불러오려 들어 콘솔이 더러워진다.
  // DOMParser로 뜬 문서는 그림을 부르지 않는다 — 고쳐 쓰기에만 쓴다.
  // 표 편집의 고른 칸 표시(tg-on)는 떼고 (editorFree)
  const doc = new DOMParser().parseFromString(
    `<body>${editorFree(body.innerHTML)}</body>`, 'text/html');
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
  // 표마다 글꼴·크기·줄 높이·색을 인라인으로 — doctype 없이 문서로 그리는 메일 프로그램(quirks 모드)은 표가 감싼 div 의 글꼴을
  // 물려받지 않아 표 안 글자만 16px·줄 높이 normal 이 된다 (아웃룩도 div 글꼴을 칸에 안 물려준다고 알려져 있다).
  // 표를 감싼 것이 적어 둔 값(인용문의 12px 등)이 있으면 그 값을, 없으면 본문 값을 — 표준 모드에서 보이는 것과 같게.
  // CSSOM 은 색을 rgb() 로 고쳐 쓰므로 style 글을 직접 고친다
  for (const t of clone.querySelectorAll('table')) {
    let st = t.getAttribute('style') || '';
    for (const [p, base] of BODY_FONT) {
      if (grid.getDecl(st, p)) continue;
      let v = '';
      for (let up = t.parentElement; up && up !== clone && !v; up = up.parentElement) v = grid.getDecl(up.getAttribute('style'), p);
      st = grid.setDecl(st, p, v || base);
    }
    t.setAttribute('style', st);
  }
  // 감싸는 div 는 쓰기 창 .body 와 같은 글꼴·줄 높이·줄바꿈 — word-break·overflow-wrap 이 다르면 긴 낱말(주소·계좌번호)이 든
  // 표 칸이 받는 쪽에서만 넓어져 열 너비가 쓰기 창과 크게 달라진다
  return {
    html: `<div style="${BODY_FONT.map(([p, v]) => `${p}:${v}`).join(';')};word-break:keep-all;overflow-wrap:anywhere">${clone.innerHTML}</div>`,
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
  let text = textWithTables(body).trim();
  for (const q of body.querySelectorAll('blockquote')) {
    const raw = textWithTables(q).trim();
    if (!raw) continue;
    const marked = raw.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
    // 첫 자리만 바꾼다. 인용문의 글 그대로를 찾는 것이라 엉뚱한 데가 걸릴 일은 없다.
    text = text.replace(raw, () => marked);
  }
  return text;
}

/**
 * 표 하나의 글 몫 — 줄마다 칸을 탭으로. innerText 로는 빈 칸(<br>)이 빈 줄이 되고, 칸 안 줄바꿈이 줄을 가르고,
 * 합친 칸 아래 줄의 칸이 앞 열로 당겨진다. 칸 지도를 펴서: 칸 글은 빈칸 하나로 접고, 빈 칸과 합친 칸이 덮은 자리는 '' (열이 맞는다)
 */
function tableText(t) {
  const m = grid.tidy(readRaw(t, false));
  return grid.cells(m).map((row, r) => row.map((it, c) => (it && it.ref && it.r === r && it.c === c
    ? (it.ref.innerText || '').replace(/\s+/g, ' ').trim() : '')).join('\t')).join('\n');
}

/** el 의 글 (innerText) — 그 안의 가장 바깥 표는 tableText 로 바꿔서. 표의 innerText 를 앞에서부터 차례로 찾아 바꾼다 */
function textWithTables(el) {
  let text = el.innerText || '';
  let from = 0;
  for (const t of el.querySelectorAll('table')) {
    const up = t.parentElement.closest('table');
    if (up && el.contains(up)) continue;
    let raw = t.innerText || '';
    let i = raw ? text.indexOf(raw, from) : -1;
    if (i < 0 && raw.trim()) {
      raw = raw.trim();
      i = text.indexOf(raw, from);
    }
    if (i < 0) continue;
    const mine = tableText(t);
    text = text.slice(0, i) + mine + text.slice(i + raw.length);
    from = i + mine.length;
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
  'bgcolor', 'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing', 'span', 'nowrap'
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
        // 칸의 nowrap 은 값 없이 온다 (<td nowrap>) — 빈 값이어도 남긴다 (붙인 엑셀 표의 줄바꿈 안 함이 답장·전달에서 빠지지 않게)
        if (val || (name === 'nowrap' && (tag === 'TD' || tag === 'TH'))) el.setAttribute(name, val);
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
    bodyHtml: draftBody(editorFree(html)),
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
    // 표 편집의 고른 칸 표시(tg-on)는 쓴 글이 아니다 (editorFree)
    || editorFree(html === undefined ? body.innerHTML : html).trim() !== (base.bodyHtml || '')
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

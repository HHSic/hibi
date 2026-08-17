'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.style.setProperty('--scrim-a', params.get('scrim') || '0.86');
document.documentElement.style.setProperty('--inset', (params.get('inset') || '12') + 'px');
document.documentElement.style.setProperty('--r', (params.get('radius') || '20') + 'px');

let attachments = [];          // { path, filename, size }
let context = null;            // 답장이면 원문 정보
let sending = false;

/** 받은 메일의 글을 인용문으로 넣을 때 — 남이 쓴 것이므로 태그로 살아나면 안 된다 */
function say(kind, text) {
  $('msg').className = 'msg' + (kind ? ' ' + kind : '');
  $('msg').textContent = text || '';
}

function renderFiles() {
  const host = $('files');
  host.textContent = '';
  for (const [i, a] of attachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'file';
    const nm = document.createElement('b');
    nm.textContent = a.filename;
    const sz = document.createElement('span');
    sz.textContent = a.size > 1048576
      ? `${(a.size / 1048576).toFixed(1)}MB`
      : `${Math.max(1, Math.round(a.size / 1024))}KB`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '빼기';
    del.onclick = () => { attachments.splice(i, 1); renderFiles(); };
    chip.append(nm, sz, del);
    host.append(chip);
  }
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
for (const el of [$('font'), $('size'), $('color'), $('btn-image'), $('btn-link')]) {
  el.addEventListener('pointerdown', keepFocus);
}
$('font').onchange = () => run('fontName', $('font').value);
$('size').onchange = () => run('fontSize', $('size').value);
$('color').oninput = () => run('foreColor', $('color').value);
body.addEventListener('keyup', paintBar);
body.addEventListener('mouseup', paintBar);

$('btn-link').onclick = () => {
  const url = prompt('링크 주소', 'https://');
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { say('bad', 'http/https 주소만 넣을 수 있습니다'); return; }
  run('createLink', url);
};

$('btn-image').onclick = async () => {
  const picked = await window.nunsseom.composePickImage();
  if (!picked || !picked.length) return;
  body.focus();
  for (const im of picked) {
    // 화면에서는 data:로 보이고, 보낼 때 cid 첨부로 바뀐다
    document.execCommand('insertHTML', false,
      `<img src="${im.dataUrl}" data-name="${im.filename.replace(/"/g, '&quot;')}">`);
  }
};

// 붙여넣기는 글자만 받는다 — 다른 앱에서 통째로 복사하면 남의 스타일과
// 바깥 그림 주소까지 딸려 들어와 메일이 깨진다.
body.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

/** 본문 HTML에서 data: 그림을 떼어내 cid 첨부로 바꾼다 */
function bodyForSend() {
  // cloneNode로 만들면 복제된 <img>가 cid: 주소를 진짜로 불러오려 들어 콘솔이 더러워진다.
  // DOMParser로 뜬 문서는 그림을 부르지 않는다 — 고쳐 쓰기에만 쓴다.
  const doc = new DOMParser().parseFromString(
    `<body>${body.innerHTML}</body>`, 'text/html');
  const clone = doc.body;
  const inline = [];
  let n = 0;
  for (const img of clone.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const m = src.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    n += 1;
    const cid = `img${n}@hibi`;
    inline.push({
      cid, contentType: m[1], base64: m[2],
      filename: img.getAttribute('data-name') || `그림${n}.${(m[1].split('/')[1] || 'png')}`
    });
    img.setAttribute('src', `cid:${cid}`);
    img.removeAttribute('data-name');
  }
  return {
    html: `<div style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;font-size:14px;`
      + `line-height:1.65;color:#1a1a1a">${clone.innerHTML}</div>`,
    text: (body.innerText || '').trim(),
    inline
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
    p.className = 'none';
    p.style.padding = '10px 8px';
    p.style.color = 'var(--tertiary)';
    p.style.fontSize = '12px';
    p.textContent = contacts.length
      ? '찾는 사람이 없습니다'
      : '아직 비어 있습니다 — 메일을 주고받으면 쌓입니다';
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
  const picked = await window.nunsseom.composeAttach();
  for (const f of picked || []) {
    if (!attachments.some((a) => a.path === f.path)) attachments.push(f);
  }
  renderFiles();
};

/** 쓰던 글이 있나 — 있으면 함부로 버리지 않는다 */
function dirty() {
  const base = context || {};
  return $('to').value !== (base.to || '')
    || $('cc').value !== '' || $('bcc').value !== ''
    || $('subject').value !== (base.subject || '')
    || body.innerHTML.trim() !== (base.bodyHtml || '')
    || attachments.length > 0;
}

function tryClose() {
  // 보내는 중에 닫으면 결과를 아무도 못 본다. 이미 나갔는지도 모른 채 또 쓰게 된다.
  if (sending) { say('bad', '보내는 중입니다 — 끝나면 닫아주세요'); return; }
  if (dirty() && !confirm('쓰던 내용을 버리고 닫을까요?')) return;
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
  sending = true;
  $('send').disabled = true;
  say('', '보내는 중…');
  let ok = false;
  try {
    const r = await window.nunsseom.composeSend({
      to: $('to').value, cc: $('cc').value, bcc: $('bcc').value,
      subject: $('subject').value,
      ...bodyForSend(),
      attachments,
      inReplyTo: context && context.inReplyTo,
      references: context && context.references
    });
    ok = !!(r && r.ok);
    if (ok) {
      // 일부만 갔거나 보낸편지함에 못 넣었으면 그건 읽고 넘어가야 한다 —
      // 1초 뒤 창이 사라지면 아무도 못 본다.
      if (r.warn) {
        say('bad', `${r.message} · ${r.warn}`);
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
window.nunsseom.onComposeReplace((next) => {
  if (sending) return;
  if (dirty() && !confirm('쓰던 내용을 버리고 새로 쓸까요?')) return;
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
  zone.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    const dir = zone.dataset.dir;
    const start = await window.nunsseom.composeBounds();
    const sx = e.screenX;
    const sy = e.screenY;
    const move = (ev) => {
      const dx = ev.screenX - sx;
      const dy = ev.screenY - sy;
      let { x, y, width, height } = start;
      if (dir.includes('e')) width = start.width + dx;
      if (dir.includes('s')) height = start.height + dy;
      if (dir.includes('w')) { width = start.width - dx; x = start.x + dx; }
      if (dir.includes('n')) { height = start.height - dy; y = start.y + dy; }
      window.nunsseom.composeSetBounds({ x, y, width, height, dir });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/** 보내는 사람 칸 — 계정이 여럿이고 새 메일이면 고를 수 있게 한다 */
function setupFrom(d) {
  const list = d.accounts || [];
  const cur = list.find((a) => a.id === d.accountId) || list[0] || {};
  const show = (a) => (a.label ? `${a.label} <${a.from}>` : a.from) || '(주소 없음)';
  $('from').value = show(cur);
  if (!cur.from) {
    say('bad', '보내는 사람 주소가 없습니다 — 설정 → 메일에서 넣어주세요');
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
  $('subject').value = d.subject || '';
  // 답장 인용문은 서식 있는 본문에 인용 블록으로 넣는다
  // 인용문은 남이 쓴 글이다. 문자열로 이어 붙이지 않고 글자 노드로 넣어
  // 그 안의 태그가 살아날 여지를 아예 없앤다.
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
  if (d.text) {
    const q = document.createElement('blockquote');
    String(d.text).split('\n').forEach((line, i) => {
      if (i) q.append(document.createElement('br'));
      q.append(document.createTextNode(line));
    });
    body.append(q);
  }
  d.bodyHtml = body.innerHTML.trim();
  attachments = [];
  renderFiles();
  say('', '');
  context = d;
  // 답장이면 본문 맨 위에서 쓰기 시작한다 (인용문은 아래에 있다)
  // 커서는 언제나 첫 줄 안에 둔다. body 기준으로 잡으면 브라우저가 알아서
  // «글이 있는 첫 자리»로 옮겨버려 서명 안으로 들어간다.
  const putCaret = () => {
    body.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(first, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  if (d.to) putCaret(); else $('to').focus();
  body.onfocus = putCaretOnce;
  function putCaretOnce() {
    body.onfocus = null;
    // 받는 사람부터 채우고 본문으로 넘어온 첫 순간에도 첫 줄에 선다
    if (!body.contains(window.getSelection().anchorNode)) putCaret();
  }
  paintBar();
}

window.nunsseom.composeData().then(fill);

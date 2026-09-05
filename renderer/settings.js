'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const root = document.documentElement;
root.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const num = (k, d) => { const v = parseFloat(params.get(k)); return Number.isNaN(v) ? d : v; };
root.style.setProperty('--inset', num('inset', 12) + 'px');
root.style.setProperty('--r', num('radius', 20) + 'px');
// 설정 창은 내용이 많아 위젯보다 약간 더 불투명하게 둔다
root.style.setProperty('--scrim-a', String(Math.min(0.96, num('scrim', 0.92) + 0.04)));

const fmtInterval = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60}시간` : `${m}분`);
const fmtDuration = (sec) => (sec >= 60 ? `${Math.round(sec / 60)}분` : `${sec}초`);

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
/** 요일 목록을 짧게 — 자주 쓰는 묶음은 이름으로 부른다 */
function fmtDays(days) {
  const d = Array.isArray(days) ? [...new Set(days)].sort((a, b) => a - b) : [];
  if (!d.length || d.length === 7) return '매일';
  if (d.length === 5 && d.every((x) => x >= 1 && x <= 5)) return '평일';
  if (d.length === 2 && d.includes(0) && d.includes(6)) return '주말';
  return d.map((x) => DAY_NAMES[x]).join('');
}
/** «언제 우는가»를 한 줄로. 주기 알림이면 예전 그대로 «20분». */
function fmtTiming(def) {
  if (!def || def.when !== 'at') return fmtInterval(def ? def.intervalMin : 0);
  const t = [...(def.times || [])].sort();
  if (!t.length) return '시각 없음';
  return `${fmtDays(def.days)} ${t.join(', ')}`;
}

let data = null;

// 메일 탭은 settings-mail.js 가 그린다 (이 파일이 1,652줄이라 갈라냈다).
// 공유하는 것의 주인은 여기다 — 저쪽은 이걸 거쳐 빌려 쓴다.
window.nunsSet = {
  get data() { return data; },
  bindSwitch: (k) => bindSwitch(k),
  fillRange: (el) => fillRange(el)
};

/**
 * 문서의 모든 <script> 가 끝난 뒤에 한다.
 *
 * 여러 파일로 나눈 화면 코드에서 «다음 파일이 만든 것»을 부를 때 필요하다.
 * <script> 하나하나는 따로 도는 일감이라, 그 사이에 IPC 답 같은 것이 끼어들 수 있다 —
 * 그 답 안에서 다음 파일의 전역을 부르면 아직 없다. 실제로 그랬다.
 */
function afterScripts(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

/**
 * 슬라이더의 «지나온 쪽»만 색이 차게 한다.
 * 막대를 윈도우 기본 모양 대신 직접 그리기 때문에, 얼마나 찼는지를 CSS에 알려줘야 한다.
 * 슬라이더는 세 군데서 따로 만들어져서 한 곳을 빠뜨리기 쉽다 — 그래서 끄는 동안에는
 * 아래 한 줄이 종류를 안 가리고 전부 챙긴다.
 */
function fillRange(el) {
  const lo = Number(el.min || 0);
  const hi = Number(el.max || 100);
  const pct = hi > lo ? ((Number(el.value) - lo) / (hi - lo)) * 100 : 0;
  el.style.setProperty('--fill-pct', `${Math.max(0, Math.min(100, pct))}%`);
}
document.addEventListener('input', (e) => {
  if (e.target && e.target.type === 'range') fillRange(e.target);
}, true);


// ── 알림 종류 행 만들기 ────────────────────────────
function buildRow(type, cfg) {
  const wrap = document.createElement('div');
  wrap.className = 'rem-wrap';
  wrap.style.setProperty('--rc', type.color);

  const row = document.createElement('div');
  row.className = 'rem' + (cfg.enabled ? '' : ' off');

  const g = window.nunsMark(type, 'g');
  g.style.color = type.color;

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = type.name;
  const sub = document.createElement('small');
  sub.textContent = type.headline || '';
  nm.append(sub);

  const val = document.createElement('span');
  val.className = 'val';
  const paintVal = () => {
    val.textContent = `${fmtTiming(cfg)} · ${fmtDuration(cfg.durationSec)}`;
  };
  paintVal();

  const sw = document.createElement('button');
  sw.className = 'sw' + (cfg.enabled ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(!!cfg.enabled));
  sw.setAttribute('aria-label', `${type.name} 켜기/끄기`);
  sw.onclick = (e) => {
    e.stopPropagation();
    cfg.enabled = !cfg.enabled;
    sw.classList.toggle('on', cfg.enabled);
    sw.setAttribute('aria-checked', String(cfg.enabled));
    row.classList.toggle('off', !cfg.enabled);
    window.nunsseom.setReminder(type.id, { enabled: cfg.enabled });
    renderReminders(); // 켜진/꺼진 그룹 간 이동
  };

  row.append(g, nm, val, sw);

  // 상세 (주기 · 길이)
  const detail = document.createElement('div');
  detail.className = 'detail';

  const mkSlider = (label, key, min, max, step, fmt) => {
    const dr = document.createElement('div');
    dr.className = 'drow';
    const lb = document.createElement('span');
    lb.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = cfg[key];
    fillRange(input);
    input.setAttribute('aria-label', `${type.name} ${label}`);
    const out = document.createElement('span');
    out.className = 'out';
    out.textContent = fmt(cfg[key]);
    input.oninput = () => { out.textContent = fmt(Number(input.value)); };
    input.onchange = () => {
      cfg[key] = Number(input.value);
      paintVal();
      window.nunsseom.setReminder(type.id, { [key]: cfg[key] });
    };
    dr.append(lb, input, out);
    return dr;
  };

  detail.append(
    mkSlider('주기', 'intervalMin', 5, 240, 5, fmtInterval),
    mkSlider('길이', 'durationSec', 10, 300, 10, fmtDuration)
  );

  row.onclick = () => wrap.classList.toggle('open');
  wrap.append(row, detail);
  return wrap;
}

function renderReminders(openId) {
  const on = $('grp-on');
  const off = $('grp-off');
  on.textContent = '';
  off.textContent = '';
  // 기본 알림
  for (const type of data.types) {
    const cfg = data.reminders[type.id];
    if (!cfg) continue;
    (cfg.enabled ? on : off).append(buildRow(type, cfg));
  }
  // 사용자 지정 알림도 같은 켜진/꺼진 목록에 섞는다
  for (const id of Object.keys(data.custom || {})) {
    const def = data.custom[id];
    (def.enabled === false ? off : on).append(buildCustomRow(id, def, id === openId));
  }
  const hasOn = on.childElementCount > 0;
  const hasOff = off.childElementCount > 0;
  $('sec-on').style.display = hasOn ? '' : 'none';
  on.style.display = hasOn ? '' : 'none';
  $('sec-off').style.display = hasOff ? '' : 'none';
  off.style.display = hasOff ? '' : 'none';
}

function buildCustomRow(id, def, startOpen) {
  const meta = { glyph: 'custom', emoji: def.emoji || null };
  const wrap = document.createElement('div');
  wrap.className = 'rem-wrap' + (startOpen ? ' open' : '');
  wrap.style.setProperty('--rc', def.color || 'var(--accent)');

  const row = document.createElement('div');
  row.className = 'rem' + (def.enabled === false ? ' off' : '');

  const g = window.nunsMark(meta, 'g');
  g.style.color = def.color || 'var(--accent)';

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = def.name || '내 알림';
  const sub = document.createElement('small');
  sub.textContent = def.headline || '';
  nm.append(sub);

  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = `${fmtTiming(def)} · ${fmtDuration(def.durationSec)}`;

  const sw = document.createElement('button');
  sw.className = 'sw' + (def.enabled === false ? '' : ' on');
  sw.setAttribute('role', 'switch');
  sw.onclick = async (e) => {
    e.stopPropagation();
    def.enabled = def.enabled === false;
    data.custom = await window.nunsseom.customUpdate(id, { enabled: def.enabled });
    renderReminders(); // 켜진/꺼진 목록 간 이동
  };

  row.append(g, nm, val, sw);
  row.onclick = () => wrap.classList.toggle('open');

  // 편집 상세 — 이름, 이모지, 주기, 길이, 삭제
  const detail = document.createElement('div');
  detail.className = 'detail';

  const nameRow = document.createElement('div');
  nameRow.className = 'drow wide';
  const nlab = document.createElement('span');
  nlab.className = 'lbl2';
  nlab.textContent = '이름';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'cust-name';
  nameInput.value = def.name || '';
  nameInput.onclick = (e) => e.stopPropagation();
  nameInput.onchange = async () => {
    def.name = nameInput.value.trim() || '내 알림';
    nm.firstChild.textContent = def.name;
    data.custom = await window.nunsseom.customUpdate(id, { name: def.name, headline: def.name });
  };
  nameRow.append(nlab, nameInput);

  const emojiGrid = document.createElement('div');
  emojiGrid.className = 'emoji-grid';
  emojiGrid.onclick = (e) => e.stopPropagation();
  for (const emo of window.NUNS_EMOJI) {
    const b = document.createElement('button');
    b.textContent = emo;
    if (emo === def.emoji) b.classList.add('on');
    b.onclick = async () => {
      def.emoji = emo;
      emojiGrid.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const ng = window.nunsMark({ glyph: 'custom', emoji: emo }, 'g');
      ng.style.color = def.color || 'var(--accent)';
      g.replaceWith(ng);
      data.custom = await window.nunsseom.customUpdate(id, { emoji: emo });
    };
    emojiGrid.append(b);
  }

  const mkSlider = (label, key, min, max, step, fmt) => {
    const dr = document.createElement('div');
    dr.className = 'drow';
    const lb = document.createElement('span');
    lb.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = def[key];
    fillRange(input);
    input.onclick = (e) => e.stopPropagation();
    const out = document.createElement('span');
    out.className = 'out';
    out.textContent = fmt(def[key]);
    input.oninput = () => { out.textContent = fmt(Number(input.value)); };
    input.onchange = async () => {
      def[key] = Number(input.value);
      val.textContent = `${fmtTiming(def)} · ${fmtDuration(def.durationSec)}`;
      data.custom = await window.nunsseom.customUpdate(id, { [key]: def[key] });
    };
    dr.append(lb, input, out);
    return dr;
  };

  const delRow = document.createElement('div');
  delRow.className = 'drow wide';
  delRow.style.marginTop = '4px';
  const del = document.createElement('button');
  del.className = 'cust-del';
  del.textContent = '이 알림 삭제';
  del.onclick = async (e) => {
    e.stopPropagation();
    data.custom = await window.nunsseom.customRemove(id);
    renderReminders();
  };
  delRow.append(document.createElement('span'), del);

  // ── 언제 울릴지 ──────────────────────────────────────────
  // 주기마다(20분마다)와 정해진 시각(매일 09:00)은 서로 다른 물건이라 칸을 갈라 보여준다.
  const save = async (patch) => {
    Object.assign(def, patch);
    val.textContent = `${fmtTiming(def)} · ${fmtDuration(def.durationSec)}`;
    data.custom = await window.nunsseom.customUpdate(id, patch);
  };

  const everyBox = document.createElement('div');
  const atBox = document.createElement('div');
  const paintMode = (mode) => {
    everyBox.style.display = mode === 'at' ? 'none' : '';
    atBox.style.display = mode === 'at' ? '' : 'none';
  };
  const modeOf = () => (def.when === 'at' ? 'at' : 'every');

  const whenRow = document.createElement('div');
  whenRow.className = 'drow wide';
  whenRow.onclick = (e) => e.stopPropagation();
  const wlab = document.createElement('span');
  wlab.className = 'lbl2';
  wlab.textContent = '언제';
  const whenPick = document.createElement('div');
  whenPick.className = 'helprow';
  const modeBtns = new Map();
  for (const [mode, text] of [['every', '주기마다'], ['at', '정해진 시각']]) {
    const b = document.createElement('button');
    b.className = 'mini' + (modeOf() === mode ? '' : ' ghost');
    b.textContent = text;
    b.onclick = async () => {
      if (modeOf() === mode) return;
      for (const [k, btn] of modeBtns) btn.classList.toggle('ghost', k !== mode);
      paintMode(mode);
      await save({ when: mode });
    };
    modeBtns.set(mode, b);
    whenPick.append(b);
  }
  whenRow.append(wlab, whenPick);

  everyBox.append(mkSlider('주기', 'intervalMin', 5, 240, 5, fmtInterval));

  // ── 정해진 시각: 시각 목록 + 요일 ────────────────────────
  const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  // 분은 5분 단위로만. 예순 줄짜리 목록은 고르기가 더 힘들다.
  const MINS = Array.from({ length: 12 }, (_, k) => String(k * 5).padStart(2, '0'));

  const timesBox = document.createElement('div');

  const mkPick = (opts, cur) => {
    const sel = document.createElement('select');
    sel.className = 'cust-name';
    sel.style.width = '58px';
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o;
      op.textContent = o;
      if (o === cur) op.selected = true;
      sel.append(op);
    }
    return sel;
  };

  const mkTimeRow = (value, i) => {
    const dr = document.createElement('div');
    dr.className = 'drow wide';
    dr.onclick = (e) => e.stopPropagation();
    const lb = document.createElement('span');
    lb.className = 'lbl2';
    lb.textContent = i ? '' : '시각';

    const [hh, mm] = String(value).split(':');
    // 5분 단위로 맞춰 보여준다 — 예전 값이나 손으로 넣은 값이 07이어도 목록엔 05가 있다
    const near5 = String((Math.round(Number(mm) / 5) * 5) % 60).padStart(2, '0');
    const hSel = mkPick(HOURS, hh);
    const mSel = mkPick(MINS, near5);
    const colon = document.createElement('span');
    colon.className = 'sep2';
    colon.textContent = ':';

    const commit = async () => {
      const next = [...(def.times || [])];
      next[i] = `${hSel.value}:${mSel.value}`;
      await save({ times: next });
      drawTimes();          // 이른 순으로 다시 세워야 하므로 통째로 다시 그린다
    };
    hSel.onchange = commit;
    mSel.onchange = commit;

    const del = document.createElement('button');
    del.className = 'mini ghost';
    del.textContent = '지우기';
    del.onclick = async () => {
      await save({ times: (def.times || []).filter((_, k) => k !== i) });
      drawTimes();
    };

    const box = document.createElement('div');
    box.className = 'helprow';
    box.append(hSel, colon, mSel, del);
    dr.append(lb, box);
    return dr;
  };

  function drawTimes() {
    timesBox.textContent = '';
    const list = [...(def.times || [])].sort();
    if (!list.length) {
      const dr = document.createElement('div');
      dr.className = 'drow wide';
      const lb = document.createElement('span');
      lb.className = 'lbl2';
      lb.textContent = '시각';
      const warn = document.createElement('span');
      warn.className = 'hint';
      warn.textContent = '아직 시각이 없습니다 — 하나 넣기 전까지는 울리지 않아요.';
      dr.append(lb, warn);
      timesBox.append(dr);
    }
    list.forEach((t, i) => timesBox.append(mkTimeRow(t, i)));
    // 방금 만든 <select>도 앱 목록으로 바꿔준다 (네이티브 드롭다운이 뜨지 않게)
    window.nunsPickFields(timesBox);
  }

  const addRow = document.createElement('div');
  addRow.className = 'drow wide';
  addRow.onclick = (e) => e.stopPropagation();
  const addBtn = document.createElement('button');
  addBtn.className = 'mini ghost';
  addBtn.textContent = '＋ 시각 추가';
  addBtn.onclick = async () => {
    const next = [...(def.times || [])];
    if (next.length >= 12) return;
    next.push('09:00');
    await save({ times: next });
    drawTimes();
  };
  addRow.append(document.createElement('span'), addBtn);

  const dayRow = document.createElement('div');
  dayRow.className = 'drow wide';
  dayRow.onclick = (e) => e.stopPropagation();
  const dlab = document.createElement('span');
  dlab.className = 'lbl2';
  dlab.textContent = '요일';
  const chips = document.createElement('div');
  chips.className = 'helprow';
  // 저장은 «매일»을 빈 배열로 둔다. 화면에서는 일곱 개가 모두 켜진 모습이 곧 매일이다.
  const picked = new Set(def.days && def.days.length ? def.days : [0, 1, 2, 3, 4, 5, 6]);
  const dayBtns = [];
  for (let d = 0; d < 7; d++) {
    const b = document.createElement('button');
    b.className = 'mini day' + (picked.has(d) ? '' : ' ghost');
    b.textContent = DAY_NAMES[d];
    b.onclick = async () => {
      if (picked.has(d)) picked.delete(d);
      else picked.add(d);
      // 하나도 안 고르면 울릴 날이 없어진다 — 마지막 하나는 못 끄게 둔다
      if (!picked.size) { picked.add(d); return; }
      dayBtns.forEach((x, k) => x.classList.toggle('ghost', !picked.has(k)));
      await save({ days: picked.size === 7 ? [] : [...picked].sort((x, y) => x - y) });
    };
    dayBtns.push(b);
    chips.append(b);
  }
  dayRow.append(dlab, chips);

  atBox.append(timesBox, addRow, dayRow);
  drawTimes();
  paintMode(modeOf());

  detail.append(nameRow, emojiGrid, whenRow, everyBox, atBox,
    mkSlider('길이', 'durationSec', 10, 300, 10, fmtDuration),
    delRow);

  wrap.append(row, detail);
  return wrap;
}

$('btn-custom-add').onclick = async () => {
  const custom = await window.nunsseom.customAdd({
    name: '내 알림', emoji: window.NUNS_EMOJI[0], intervalMin: 60, durationSec: 30
  });
  data.custom = custom;
  const newId = Object.keys(custom).sort().pop();
  renderReminders(newId); // 새로 만든 것은 켜진 목록에 펼친 채로
  document.querySelector('.rem-wrap.open')?.scrollIntoView({ block: 'center' });
};

/**
 * 휴식 화면이 어떻게 등장할지.
 *
 * 기본 연출 목록은 enter.js 가, 직접 넣은 파일은 data.enterCustom 이 들고 있다.
 * 둘을 한 줄에 같이 놓는다 — 고르는 사람에게는 어차피 같은 종류의 선택이다.
 */
function renderEnter() {
  const host = $('enter-pick');
  host.textContent = '';
  const cur = data.settings.overlayEnter || 'fade';
  const mine = data.enterCustom || [];

  const pick = (id) => {
    data.settings.overlayEnter = id;
    window.nunsseom.setApp({ overlayEnter: id });
    renderEnter();
  };
  const chip = (id, label) => {
    const b = document.createElement('button');
    b.className = 'mini' + (cur === id ? '' : ' ghost');
    b.textContent = label;
    b.onclick = () => pick(id);
    host.append(b);
    return b;
  };

  for (const m of window.nunsEnter.LIST) chip(m.id, m.name);
  for (const m of mine) chip(`my:${m.id}`, m.name);

  const add = document.createElement('button');
  add.className = 'mini ghost';
  add.textContent = '＋ 내 파일';
  add.onclick = () => addEnterFile(add);
  host.append(add);

  // 고른 것이 내 파일이면 지울 수 있어야 한다
  const own = mine.find((m) => `my:${m.id}` === cur);
  if (own) {
    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = '지우기';
    del.onclick = async () => {
      const r = await window.nunsseom.enterRemove(own.id);
      data.enterCustom = r.list;
      data.settings.overlayEnter = r.overlayEnter;
      renderEnter();
    };
    host.append(del);
  }

  const built = window.nunsEnter.LIST.find((m) => m.id === cur);
  $('enter-hint').textContent = built ? built.hint
    : own ? `${own.kind === 'video' ? '영상' : '그림'} · ${(own.ms / 1000).toFixed(1)}초 동안 화면을 덮습니다`
      : '';
  renderEnterPreview(own);
}

/** 넣은 파일이 무엇인지 눈으로 확인시켜 준다 — 이름만으로는 알 수 없다 */
function renderEnterPreview(item) {
  const box = $('enter-preview');
  box.textContent = '';
  box.hidden = !item;
  if (!item) return;
  const m = document.createElement(item.kind === 'video' ? 'video' : 'img');
  if (item.kind === 'video') { m.muted = true; m.loop = true; m.autoplay = true; m.playsInline = true; }
  m.src = item.url;
  box.append(m);
  if (item.kind === 'video') m.play().catch(() => { /* 첫 프레임만 보여도 된다 */ });
}

/**
 * 파일을 골라 넣는다.
 *
 * 고르기와 넣기를 나눈 이유는 길이 때문이다 — 영상이 몇 초짜리인지는 화면 쪽에서만
 * 잴 수 있어서, 먼저 주소를 받아 재보고 그 길이와 함께 넣는다.
 * 길이를 못 읽는 파일도 있다(만든 도구에 따라 헤더가 비어 있다). 그때는 기본값으로 둔다.
 */
async function addEnterFile(btn) {
  btn.disabled = true;
  try {
    const got = await window.nunsseom.enterPick();
    if (!got) return;
    if (got.error) { $('enter-hint').textContent = got.error; return; }
    const ms = got.kind === 'video' ? await videoMs(got.url) : 900;
    const r = await window.nunsseom.enterAdd({ path: got.path, name: got.name, ms });
    if (r.error) { $('enter-hint').textContent = r.error; return; }
    data.enterCustom = r.list;
    const last = r.list[r.list.length - 1];
    data.settings.overlayEnter = `my:${last.id}`;
    window.nunsseom.setApp({ overlayEnter: `my:${last.id}` });
    renderEnter();
  } finally {
    btn.disabled = false;
  }
}

/** 영상 길이(ms). 못 읽으면 0을 주고, 넣는 쪽이 기본값으로 채운다. */
function videoMs(url) {
  return new Promise((done) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const give = (n) => done(Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0);
    v.onloadedmetadata = () => give(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 2500);   // 안 읽히는 파일에 매달리지 않는다
    v.src = url;
  });
}

/** 켜기/끄기 스위치를 설정 키에 묶는다 */
function bindSwitch(key) {
  const el = $(key);
  if (!el) return;
  let on = !!data.settings[key];
  const paint = () => {
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
  };
  paint();
  el.onclick = () => {
    on = !on;
    paint();
    window.nunsseom.setApp({ [key]: on });
    // 메일을 켜면 다음 주기를 기다리지 않고 바로 한 번 확인한다
    if (key === 'mailEnabled' && on) window.nunsseom.mailRefresh();
    // 켜자마자 무슨 일이 일어나는지 바로 알려준다
    if (key === 'mailAutoBackup') window.nunsSetMail.loadBackup();
  };
}

// ── 자동 실행 ─────────────────────────────────────
// OS 상태(시작 폴더 바로가기)가 진실이므로, 누른 뒤 실제 상태를 다시 읽어 그린다.
// 실패하면 스위치가 스스로 돌아가므로 조용히 실패하는 일이 없다.
function bindAutoLaunch() {
  const el = $('autoLaunch');
  const note = $('autoLaunch-note');
  let busy = false;

  const paint = (on) => {
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
  };
  paint(!!data.settings.autoLaunch);

  el.onclick = async () => {
    if (busy) return;
    busy = true;
    const want = !el.classList.contains('on');
    paint(want);
    if (note) note.textContent = '';
    try {
      const actual = await window.nunsseom.autoLaunchSet(want);
      paint(actual);
      data.settings.autoLaunch = actual;
      if (note && actual !== want) {
        note.textContent = want ? '등록하지 못했습니다' : '해제하지 못했습니다';
      }
    } finally {
      busy = false;
    }
  };
}

// ── 방해 금지 앱 목록 ─────────────────────────────
function renderDndApps() {
  const host = $('dnd-list');
  host.textContent = '';
  const on = new Set(data.settings.dndPresets || []);
  const custom = data.settings.dndApps || [];

  const row = (label, sub, isOn, onToggle, onDelete) => {
    const el = document.createElement('div');
    el.className = 'cal';

    const who = document.createElement('div');
    who.className = 'who';
    const b = document.createElement('b');
    b.textContent = label;
    who.append(b);
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      who.append(s);
    }

    const sw = document.createElement('button');
    sw.className = 'sw' + (isOn ? ' on' : '');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(isOn));
    sw.setAttribute('aria-label', `${label} 감지`);
    sw.onclick = onToggle;

    el.append(who, sw);

    if (onDelete) {
      const del = document.createElement('button');
      del.className = 'del';
      del.setAttribute('aria-label', `${label} 삭제`);
      del.append(window.nunsIcon('close'));
      del.onclick = onDelete;
      el.append(del);
    } else {
      el.append(document.createElement('span'));
    }
    host.append(el);
  };

  for (const p of data.dndPresets || []) {
    // 실행 파일로 아는 것과 창 제목으로 아는 것을 구별해 보여준다 —
    // 무엇을 보고 판단하는지 알아야 안 걸릴 때 이유를 짐작할 수 있다.
    const sub = (p.procs || []).length
      ? p.procs.join(', ')
      : `창 제목: ${(p.titles || []).join(', ')}`;
    row(p.name, sub, on.has(p.id), () => {
      const next = new Set(data.settings.dndPresets || []);
      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
      data.settings.dndPresets = [...next];
      window.nunsseom.setApp({ dndPresets: data.settings.dndPresets });
      renderDndApps();
    });
  }

  // 직접 추가한 앱은 항상 켜진 상태이고, 끄는 대신 삭제한다
  for (const name of custom) {
    row(name, '직접 추가', true, () => removeCustom(name), () => removeCustom(name));
  }

  if (!(data.dndPresets || []).length && !custom.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '감지할 앱이 없습니다.';
    host.append(p);
  }
}

function removeCustom(name) {
  data.settings.dndApps = (data.settings.dndApps || []).filter((n) => n !== name);
  window.nunsseom.setApp({ dndApps: data.settings.dndApps });
  renderDndApps();
}

$('btn-dnd-add').onclick = () => {
  const input = $('dnd-custom');
  const name = input.value.trim().toLowerCase();
  if (!name) return;
  const list = data.settings.dndApps || [];
  if (!list.includes(name)) list.push(name);
  data.settings.dndApps = list;
  window.nunsseom.setApp({ dndApps: list });
  input.value = '';
  renderDndApps();
};
$('dnd-custom').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-dnd-add').click();
});

// ── 캘린더 ────────────────────────────────────────
function fmtWhen(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderCalendars(list, status) {
  const host = $('cal-list');
  host.textContent = '';

  if (!list || !list.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '아직 없습니다. 아래에서 iCal 주소를 추가하세요.';
    host.append(p);
  } else {
    for (const c of list) {
      const row = document.createElement('div');
      row.className = 'cal';

      const who = document.createElement('div');
      who.className = 'who';
      const b = document.createElement('b');
      b.textContent = c.name || '캘린더';
      const s = document.createElement('small');
      s.textContent = c.url;
      who.append(b, s);

      const sw = document.createElement('button');
      sw.className = 'sw' + (c.enabled !== false ? ' on' : '');
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', `${c.name} 사용`);
      sw.onclick = async () => {
        const r = await window.nunsseom.calUpdate(c.id, { enabled: !(c.enabled !== false) });
        renderCalendars(r.calendars, r.status);
      };

      const del = document.createElement('button');
      del.className = 'del';
      del.setAttribute('aria-label', `${c.name} 삭제`);
      del.append(window.nunsIcon('close'));
      del.onclick = async () => {
        const r = await window.nunsseom.calRemove(c.id);
        renderCalendars(r.calendars, r.status);
      };

      row.append(who, sw, del);
      host.append(row);
    }
  }

  // 상태 배너 — 지금 일정 중인지 / 다음 일정 / 오류
  const old = document.getElementById('cal-banner');
  if (old) old.remove();
  if (!status) return;
  const parts = [];
  if (status.current) parts.push(`지금 <b>${status.current.summary}</b> 진행 중 (${fmtWhen(status.current.end)}까지)`);
  else if (status.next) parts.push(`다음 일정 <b>${status.next.summary}</b> · ${fmtWhen(status.next.start)}`);
  else if (status.count === 0 && list && list.length) parts.push('앞뒤 이틀 안에 일정이 없습니다');
  // 못 받아왔을 때도 달력은 그대로 보인다 — 그것이 언제 것인지 말해줘야
  // «오늘 일정이 왜 안 뜨지»를 혼자 헤매지 않는다.
  if (status.stale && status.fetchedAt) {
    parts.push(`지금 보이는 일정은 <b>${fmtWhen(status.fetchedAt)}</b>에 받아둔 것입니다 (새로 못 받았습니다)`);
  }
  for (const e of status.errors || []) parts.push(`<b>${e.name || '캘린더'}</b> 읽기 실패: ${e.message}`);
  if (!parts.length) return;

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.id = 'cal-banner';
  // 안전하게 조립 (innerHTML 대신)
  for (const [i, text] of parts.entries()) {
    if (i) banner.append(document.createElement('br'));
    const frag = text.split(/<b>|<\/b>/);
    frag.forEach((chunk, k) => {
      if (k % 2 === 1) {
        const bb = document.createElement('b');
        bb.textContent = chunk;
        banner.append(bb);
      } else if (chunk) {
        banner.append(chunk);
      }
    });
  }
  host.after(banner);
}

// 이름은 받지 않는다 — 캘린더가 가진 이름을 메인에서 읽어 붙인다
async function addCalendar(url) {
  const msg = $('cal-msg');
  if (!url) { msg.textContent = '주소를 붙여넣으세요'; return; }
  msg.textContent = '확인 중…';
  $('btn-cal-add').disabled = true;
  try {
    const t = await window.nunsseom.calTest(url);
    if (!t.ok) { msg.textContent = t.message; return; }
    const r = await window.nunsseom.calAdd('', url);
    data.calendars = r.calendars;
    renderCalendars(r.calendars, r.status);
    $('cal-url').value = '';
    $('cal-paste').style.display = 'none';
    msg.textContent = t.message;
  } finally {
    $('btn-cal-add').disabled = false;
  }
}

$('btn-cal-add').onclick = () => addCalendar($('cal-url').value.trim());
$('btn-help-google').onclick = () => window.nunsseom.calOpenHelp('google');
$('btn-help-notion').onclick = () => window.nunsseom.calOpenHelp('notion');
$('btn-help-outlook').onclick = () => window.nunsseom.calOpenHelp('outlook');
$('btn-cal-file').onclick = async () => {
  const p = await window.nunsseom.calPickFile();
  if (p) { $('cal-url').value = p; addCalendar(p); }
};

// 복사해 온 주소가 있으면 띄워준다. 창을 열 때와 다시 활성화될 때 살핀다.
let pasteUrl = null;
async function checkClipboard() {
  const found = await window.nunsseom.calClipboard();
  pasteUrl = found ? found.url : null;
  $('cal-paste').style.display = found ? 'flex' : 'none';
  if (found) $('cal-paste-url').textContent = found.raw;
}
$('btn-cal-paste').onclick = () => { if (pasteUrl) addCalendar(pasteUrl); };
window.addEventListener('focus', checkClipboard);
checkClipboard();

// ── 기록 ──────────────────────────────────────────
function paintStats(s) {
  if (!s) return;
  const t = s.today || { done: 0, skipped: 0 };
  $('st-today').textContent = `오늘 ${t.done}회 완료 · ${t.skipped}회 건너뜀`;
  const week = s.week || [];
  const sum = week.reduce((a, b) => a + b, 0);
  $('st-week').textContent = week.length ? `최근 7일 합계 ${sum}회` : '';
}

$('btn-reset-today').onclick = async () => {
  paintStats(await window.nunsseom.statsResetToday());
};

// 전체 삭제는 되돌릴 수 없으므로 한 번 더 누르게 한다
let armed = false;
let armTimer = null;
const allBtn = $('btn-reset-all');
allBtn.onclick = async () => {
  if (!armed) {
    armed = true;
    allBtn.textContent = '한 번 더 누르면 삭제';
    allBtn.classList.add('armed');
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armed = false;
      allBtn.textContent = '전체 삭제';
      allBtn.classList.remove('armed');
    }, 4000);
    return;
  }
  clearTimeout(armTimer);
  armed = false;
  allBtn.textContent = '전체 삭제';
  allBtn.classList.remove('armed');
  paintStats(await window.nunsseom.statsResetAll());
};

// ── 업데이트 ──────────────────────────────────────
function paintUpdate(s) {
  if (!s) return;
  $('up-ver').textContent = `버전 ${s.version}`;
  $('up-msg').textContent = s.message || '';
  const btn = $('btn-update');
  if (s.status === 'ready') {
    btn.textContent = '설치하고 다시 시작';
    btn.onclick = () => window.nunsseom.updateInstall();
  } else {
    btn.textContent = '업데이트 확인';
    btn.onclick = async () => { paintUpdate(await window.nunsseom.updateCheck()); };
  }
  btn.disabled = s.status === 'checking' || s.status === 'downloading';
}
window.nunsseom.onUpdateStatus(paintUpdate);

// ── 일반 설정 ─────────────────────────────────────
function renderSounds() {
  const host = $('sound-list');
  host.textContent = '';
  for (const s of window.nunsSound.LIST) {
    const b = document.createElement('button');
    b.className = 'mini' + (data.settings.soundName === s.id ? '' : ' ghost');
    b.textContent = s.name;
    b.onclick = () => {
      data.settings.soundName = s.id;
      window.nunsseom.setApp({ soundName: s.id });
      window.nunsSound.play(s.id, data.settings.soundVolume ?? 55);
      renderSounds();
    };
    host.append(b);
  }
}

function bindAppRow(id, fmt, toValue, toStore) {
  const input = $(id);
  const out = $('out-' + id);
  const paint = () => { out.textContent = fmt(Number(input.value)); fillRange(input); };
  input.value = toValue(data.settings);
  paint();
  input.oninput = paint;
  input.onchange = () => window.nunsseom.setApp(toStore(Number(input.value)));
}

/**
 * −/+ 가 붙은 숫자 칸. 상한이 없는 값에 쓴다.
 * 빈 칸이나 글자를 넣고 나가면 min으로 되돌린다 — 숫자가 아닌 값이 저장되면
 * 다음 실행에서 목록이 통째로 비어 보인다.
 */
function bindAppNum(id, { min = 1, max = Infinity, toValue, toStore }) {
  const input = $(id);
  const clamp = (v) => Math.max(min, Math.min(max, Math.round(v) || min));
  input.value = clamp(toValue(data.settings));
  const commit = (v) => {
    input.value = clamp(v);
    window.nunsseom.setApp(toStore(Number(input.value)));
  };
  input.onchange = () => commit(Number(input.value));
  input.onblur = () => { input.value = clamp(Number(input.value)); };
  $(id + '-dn').onclick = () => commit(Number(input.value) - 1);
  $(id + '-up').onclick = () => commit(Number(input.value) + 1);
}

window.nunsseom.getSettings().then((d) => {
  data = d;
  renderReminders();
  bindAppRow('scrim', (v) => `${v}%`, (s) => Math.round((s.scrim ?? 0.62) * 100), (v) => ({ scrim: v / 100 }));
  bindAppRow('radius', (v) => `${v}px`, (s) => s.radius ?? 26, (v) => ({ radius: v }));
  bindAppRow('idlePauseSec', (v) => `${v}초`, (s) => s.idlePauseSec ?? 120, (v) => ({ idlePauseSec: v }));

  bindAppRow('calendarLeadMin', (v) => (v ? `${v}분` : '없음'),
    (s) => s.calendarLeadMin ?? 5, (v) => ({ calendarLeadMin: v }));
  bindAppRow('calendarJoinMin', (v) => (v ? `${v}분` : '없음'),
    (s) => s.calendarJoinMin ?? 10, (v) => ({ calendarJoinMin: v }));

  bindAppRow('soundVolume', (v) => (v ? `${v}%` : '무음'),
    (s) => s.soundVolume ?? 55, (v) => ({ soundVolume: v }));
  renderSounds();
  renderEnter();
  bindAppRow('mailPollMin', (v) => `${v}분`, (s) => s.mailPollMin ?? 10, (v) => ({ mailPollMin: v }));
  bindAppNum('mailCount', {
    min: 1,
    toValue: (s) => s.mailCount ?? 5,
    toStore: (v) => ({ mailCount: v })
  });
  // settings-mail.js 는 이 파일 «다음»에 오는 별개 <script> 다. 우리는 지금
  // getSettings() 의 답 안에 있고, 그 답은 두 <script> 사이에 끼어들 수 있다 —
  // 그러면 여기서 nunsSetMail 이 아직 없어 터지고, 아래 bindSwitch 들이 통째로
  // 안 걸린다 (주식 스위치가 안 먹었다. CSP 를 켜니 매번 그랬다).
  // DOMContentLoaded 는 문서의 모든 <script> 가 끝난 뒤에 온다 — 순서를 보장받는 자리다.
  afterScripts(() => {
    window.nunsSetMail.loadMail();
    window.nunsSetMail.loadBackup();
  });

  for (const key of ['dndEnabled', 'autoUpdate', 'calendarBusy', 'calendarAllDay',
                     'calendarLead', 'calendarShow', 'soundEnabled', 'breakNoEscape',
                     'mailEnabled', 'mailShow', 'mailRemoteImages', 'mailAutoBackup',
                     'mailPerAccount', 'stocksEnabled']) {
    bindSwitch(key);
  }
  bindAutoLaunch();

  renderDndApps();

  renderCalendars(data.calendars, data.calendarStatus);
  paintUpdate(data.update);
  window.nunsseom.statsGet().then(paintStats);
});

// ── 탭 ───────────────────────────────────────────
const TABS = ['rem', 'cal', 'mail', 'app'];
function showTab(which) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('on', t === which);
    $(`pane-${t}`).style.display = t === which ? '' : 'none';
  }
}
for (const t of TABS) $(`tab-${t}`).onclick = () => showTab(t);
// 위젯의 ⚙에서 바로 필터로 올 수 있게 — 열자마자 탭을 또 찾게 하면 «어디 있지»가 된다.
// 창이 이미 떠 있으면 주소로는 못 바꾸니 메인이 따로 알려준다.
if (TABS.includes(params.get('tab'))) showTab(params.get('tab'));
if (window.nunsseom.onSettingsTab) {
  window.nunsseom.onSettingsTab((t) => { if (TABS.includes(t)) showTab(t); });
}

$('btn-done').append(window.nunsIcon('close'));
$('btn-done').onclick = () => window.nunsseom.closeSettings();
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.nunsseom.closeSettings();
});

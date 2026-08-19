'use strict';
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

// 틱 핸들러가 이 값들을 건드린다. 틱은 스크립트가 끝나기 전에도 도착할 수 있으므로
// 반드시 등록보다 위에서 선언해야 한다 (여기서 TDZ로 위젯 전체가 죽은 적이 있다).
const mailCard = document.getElementById('card');
let lastMailBox = null;
let lastMailRender = '';
const params = new URLSearchParams(location.search);

root.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const num = (key, fallback) => {
  const v = parseFloat(params.get(key));
  return Number.isNaN(v) ? fallback : v;
};

const INSET = num('inset', 12);
const CTLH = num('ctlh', 36);
root.style.setProperty('--inset', INSET + 'px');
root.style.setProperty('--ctlh', CTLH + 'px');
root.style.setProperty('--scrim-a', String(num('scrim', 0.92)));
root.style.setProperty('--r', num('radius', 26) + 'px');

window.nunsseom.onScrim((v) => root.style.setProperty('--scrim-a', String(v)));
window.nunsseom.onRadius((v) => root.style.setProperty('--r', v + 'px'));

// ── 크기대 판정 + 스케일 ───────────────────────────
// 폭·높이 중 더 제약적인 쪽에 맞춰 스케일하고(핵심 수정), 크기대별로 레이아웃을 바꾼다.
const BASE = { w: 244, h: 110 };
const REGIMES = ['r-micro', 'r-base', 'r-wide', 'r-tall', 'r-large'];

function regimeFor(w, h) {
  const aspect = w / h;
  if (h < 96 || w < 200) return 'r-micro';
  if (w >= 320 && h >= 150) return 'r-large';
  if (aspect <= 1.45) return 'r-tall';
  if (aspect >= 2.7) return 'r-wide';
  return 'r-base';
}

// ── 이벤트 기록 (트레이에서 켤 때만) ────────────────
// 창 크기 / 창 이동 / UI 스케일은 서로 다른 경로라, 한 줄로 같이 찍어야 구분된다.
let dbg = false;
const dlog = (src, msg) => { if (dbg) window.nunsseom.debugLog(src, msg); };
let rawHooked = false;
window.nunsseom.onDebugMode?.((on) => {
  dbg = on;
  if (!on) return;
  dlog('위젯', `기록 시작 · 창 안쪽 ${window.innerWidth}x${window.innerHeight}`
    + ` · rem ${getComputedStyle(root).fontSize} · dpr ${window.devicePixelRatio}`);
  if (rawHooked) return;
  rawHooked = true;
  // 어느 요소를 눌렀든 남긴다 — 카드/존 핸들러가 아예 안 걸리는 경우를 보려면 필요하다
  const name = (el) => {
    if (!el || !el.tagName) return '?';
    const c = String((el.className && (el.className.baseVal ?? el.className)) || '').trim().split(/\s+/)[0];
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : '');
  };
  for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    document.addEventListener(t, (e) => {
      dlog('입력', `${t} 대상 ${name(e.target)} · 창안 ${Math.round(e.clientX)},${Math.round(e.clientY)}`
        + ` · 화면 ${e.screenX},${e.screenY} · 버튼 ${e.button}`);
    }, true);
  }
});

function layout() {
  // 크기대 판정은 창이 아니라 실제 카드 크기(여백·컨트롤 띠 제외) 기준
  const w = window.innerWidth - INSET * 2;
  const h = window.innerHeight - INSET * 2 - CTLH;
  // 상한을 낮게 잡는다 — 커진 공간은 글자를 2배로 키우는 데 쓰는 게 아니라
  // 내용(칩·주간 리듬)을 더 보여주는 데 쓴다. 애플 위젯 패밀리와 같은 원칙.
  const scale = Math.min(Math.max(Math.min(w / BASE.w, h / BASE.h), 0.72), 1.3);
  root.style.fontSize = (16 * scale).toFixed(3) + 'px';

  const r = regimeFor(w, h);
  const card = $('card');
  for (const c of REGIMES) card.classList.toggle(c, c === r);
  // "UI가 커졌다"가 창 때문인지 스케일 때문인지 구분하려면 둘을 같이 봐야 한다
  dlog('UI', `창안쪽 ${window.innerWidth}x${window.innerHeight}`
    + ` · 카드 ${Math.round(w)}x${Math.round(h)} · 스케일 ${scale.toFixed(3)} · 크기대 ${r}`);
}
layout();
window.addEventListener('resize', layout);

// 발동 30초 전부터는 그 알림도 라벨바에 올린다
const IMMINENT_SEC = 30;
const MAX_TAGS = 3;

// ── 아이콘 주입 ────────────────────────────────────
function setGlyph(host, name, cls) {
  host.textContent = '';
  host.append(window.nunsIcon(name, cls));
}
setGlyph($('btn-set'), 'gear');
setGlyph($('btn-hide'), 'minus');
$('btn-now').prepend(window.nunsIcon('eye'));

let pauseState = null;
function setPauseIcon(paused) {
  if (pauseState === paused) return;
  pauseState = paused;
  $('btn-pause').textContent = '';
  $('btn-pause').append(paused ? window.nunsIconFilled('play') : window.nunsIcon('pause'));
}

// ── 업데이트 칩 ────────────────────────────────────
// 실수로 재시작되지 않도록 두 번 누르게 한다.
// 첫 tick이 동기로 들어올 수 있으므로 tick 핸들러보다 먼저 선언해 둔다.
const upchip = $('upchip');
let upVersion = null;
let upArmed = false;
let upTimer = null;

function paintChip(label, armed) {
  upchip.textContent = '';
  upchip.append(window.nunsIcon(armed ? 'check' : 'download'));
  const t = document.createElement('span');
  t.textContent = label;
  upchip.append(t);
  upchip.classList.toggle('armed', armed);
}

function showUpdate(info) {
  const card = $('card');
  if (!info || !info.ready) {
    card.classList.remove('has-update');
    upVersion = null;
    return;
  }
  if (upVersion === info.version) return; // 이미 표시 중
  upVersion = info.version;
  upArmed = false;
  paintChip(`업데이트 ${info.version}`, false);
  card.classList.add('has-update');
}

upchip.onclick = (e) => {
  e.stopPropagation();
  if (!upArmed) {
    upArmed = true;
    paintChip('설치하고 재시작', true);
    clearTimeout(upTimer);
    upTimer = setTimeout(() => {
      upArmed = false;
      paintChip(`업데이트 ${upVersion}`, false);
    }, 5000);
    return;
  }
  clearTimeout(upTimer);
  paintChip('설치 중…', true);
  window.nunsseom.updateInstall();
};
// 칩을 눌러도 카드 클릭(시트 열기)이 따라오지 않게
upchip.addEventListener('pointerdown', (e) => e.stopPropagation());

// ── 렌더 ──────────────────────────────────────────
let lastTypeId = null;

/**
 * 라벨바를 그린다.
 * 기본은 가장 이른 알림 하나. 여기에 (a) 30초 안에 발동할 것과
 * (b) 다음 휴식에 함께 묶일 것을 옆으로 붙인다.
 */
function renderTags(d) {
  const host = $('tags');
  host.textContent = '';

  const addTag = (mark, name, color, cls) => {
    const tag = document.createElement('span');
    tag.className = 'tag' + (cls ? ' ' + cls : '');
    if (mark) {
      const g = window.nunsMark(mark, 'g');
      if (color) g.style.color = color;
      tag.append(g);
    }
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    tag.append(nm);
    host.append(tag);
    return tag;
  };

  if (d.paused) { addTag(d.type || null, '일시정지됨', null); return; }
  if (d.idle) { addTag(d.type || null, '자리 비움', null); return; }

  // 방해 금지 — 알림이 밀렸는지와 무관하게 켜져 있는 동안 계속 알린다.
  // 이유(발표 모드 / Zoom / 일정 이름)는 넓은 크기에서만 덧붙인다.
  const quiet = d.hold || d.dnd;
  if (quiet) {
    addTag('sleep', d.hold ? '방해 금지 · 대기 중' : '방해 금지', null);
    const why = addTag(null, quiet, null, 'why');
    why.title = quiet;
    return;
  }

  addTag(d.type, d.type.name, d.type.color,
    d.remaining <= IMMINENT_SEC ? 'imminent' : null);

  const bundle = new Set(d.bundle || []);
  const extras = (d.upcoming || []).filter((t) =>
    t.id !== d.type.id && (t.remaining <= IMMINENT_SEC || bundle.has(t.id)));

  for (const t of extras.slice(0, MAX_TAGS - 1)) {
    addTag(t, t.name, t.color, t.remaining <= IMMINENT_SEC ? 'imminent' : null);
  }
  const hidden = extras.length - (MAX_TAGS - 1);
  if (hidden > 0) addTag(null, `+${hidden}`, null, 'more');
}

/** 남은 시간을 사람이 읽는 형태로 */
function fmtLeft(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`;
  return `${sec}초`;
}

function renderSheet(list) {
  const host = $('sheet-rows');
  host.textContent = '';
  if (!list || !list.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '켜진 알림이 없어요';
    host.append(p);
    return;
  }
  list.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === 0 ? ' next' : '');
    const g = window.nunsMark(t, 'g');
    g.style.color = t.color;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = t.name;
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = fmtLeft(t.remaining || 0);
    row.append(g, nm, tm);
    // 항목을 누르면 그 종류의 기록 상세로
    row.style.cursor = 'default';
    row.onclick = (e) => { e.stopPropagation(); window.nunsseom.openStats(t.id); };
    host.append(row);
  });
}

// ── 오늘 일정 ──────────────────────────────────────
// 캘린더를 읽어놓고 음소거에만 쓰던 걸, 시트에서 눈으로도 보게 한다.
const hhmm = (ms) => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

function renderSchedule(list) {
  const host = $('sched-rows');
  const sec = $('sched');
  // CSS 기본이 none이라 ''로 비우면 도로 숨는다 — 명시적으로 켠다
  if (!list || !list.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  host.textContent = '';
  // 끝난 일정은 하나까지만 남기고 접는다 — 남은 하루가 먼저 보여야 한다
  const rest = list.filter((e) => !e.done);
  const show = rest.length ? rest : list.slice(-1);
  for (const e of show.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'row ev' + (e.now ? ' now' : '');
    const dot = document.createElement('span');
    dot.className = 'evdot';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = e.summary;
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = e.allDay ? '종일' : hhmm(e.start);
    row.append(dot, nm, tm);
    host.append(row);
  }
}

function renderChips(list, bundleIds) {
  const host = $('chips');
  host.textContent = '';
  const bundled = new Set(bundleIds || []);
  for (const t of list.slice(0, 4)) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (bundled.has(t.id) ? ' on' : '');
    chip.append(window.nunsMark(t, 'g'));
    const label = document.createElement('span');
    label.textContent = t.name;
    chip.append(label);
    host.append(chip);
  }
}

function renderWeek(days) {
  const host = $('week');
  host.textContent = '';
  const max = Math.max(1, ...days);
  days.forEach((v, i) => {
    const bar = document.createElement('i');
    bar.style.height = Math.max(8, (v / max) * 100) + '%';
    if (i === days.length - 1) bar.className = 'hi';
    host.append(bar);
  });
}

window.nunsseom.onTick((d) => {
  const card = $('card');

  if (d.empty) {
    card.classList.add('paused');
    $('time').textContent = '--:--';
    $('tags').textContent = '켜진 알림 없음';
    $('count').textContent = '';
    root.style.setProperty('--p', '0%');
    setPauseIcon(!!d.paused);
    renderSheet([]);
    renderSchedule(d.schedule);
    return;
  }

  const m = Math.floor(d.remaining / 60);
  const s = d.remaining % 60;
  $('time').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const pct = Math.max(0, Math.min(100, (1 - d.remaining / d.total) * 100));
  root.style.setProperty('--p', pct.toFixed(2) + '%');
  root.style.setProperty('--tint', d.type.color);

  if (d.type.id !== lastTypeId) {
    lastTypeId = d.type.id;
    $('btn-now').firstChild.replaceWith(window.nunsMark(d.type));
  }
  renderTags(d);

  const ct = $('count');
  ct.textContent = '';
  ct.append('오늘 ');
  const b = document.createElement('b');
  b.textContent = String(d.today.done);
  ct.append(b, '회');

  // 방해 금지는 완전히 멈춘 상태가 아니므로 paused보다 약하게 표시한다
  card.classList.toggle('paused', d.paused || d.idle || !!d.hold);
  card.classList.toggle('quiet', !d.paused && !d.idle && !d.hold && !!d.dnd);
  setPauseIcon(d.paused);

  if (d.upcoming) {
    renderChips(d.upcoming, d.bundle && d.bundle.length ? d.bundle : [d.type.id]);
    renderSheet(d.upcoming);
  }
  renderSchedule(d.schedule);
  renderMail(d.mail);
  showUpdate(d.update);
  if (d.week) renderWeek(d.week);
});

$('btn-pause').onclick = () => window.nunsseom.togglePause();
$('btn-now').onclick = () => window.nunsseom.breakNow(lastTypeId);
$('btn-set').onclick = () => window.nunsseom.openSettings();
$('sheet-stats').onclick = (e) => { e.stopPropagation(); window.nunsseom.openStats(null); };
$('sheet-cal').onclick = (e) => { e.stopPropagation(); toggleCal(true); };

// ── 달력 ────────────────────────────────────────────
// 카드 안에서 아래로 늘어난다. 별도 창이 아니라 위젯이 길어지는 방식.
const calEl = $('cal');
const calCard = $('card');
let calMode = 'month';                     // 'month' | 'week'
let calAnchor = new Date();                // 보고 있는 달/주의 기준 날짜
let calSel = dayKey(new Date());
let calData = null;

function dayKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
const hh = (ms) => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

function eventsOn(d) {
  if (!calData) return [];
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = from + 86400000;
  return calData.events
    .filter((e) => e.start < to && e.end > from)
    .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
}

async function loadCal() {
  // 일정을 못 받아와도 격자는 그린다 — 빈 달력이 아무것도 없는 것보다 낫다
  try {
    calData = await window.nunsseom.calMonth(calAnchor.getFullYear(), calAnchor.getMonth());
  } catch {
    calData = { events: [], hasCalendar: false };
  }
  paintCal();
}

function paintCal() {
  const grid = $('cal-grid');
  grid.textContent = '';
  const todayK = dayKey(new Date());

  let cells = [];
  if (calMode === 'week') {
    const s = new Date(calAnchor);
    s.setDate(s.getDate() - s.getDay());
    for (let i = 0; i < 7; i++) cells.push(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i));
    $('cal-ttl').textContent =
      `${cells[0].getMonth() + 1}월 ${cells[0].getDate()}일 – ${cells[6].getMonth() + 1}월 ${cells[6].getDate()}일`;
  } else {
    const y = calAnchor.getFullYear(), m = calAnchor.getMonth();
    const lead = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const total = Math.ceil((lead + days) / 7) * 7;
    for (let i = 0; i < total; i++) cells.push(new Date(y, m, i - lead + 1));
    $('cal-ttl').textContent = `${y}년 ${m + 1}월`;
  }

  for (const d of cells) {
    const out = calMode === 'month' && d.getMonth() !== calAnchor.getMonth();
    const cell = document.createElement('div');
    cell.className = 'cday' + (out ? ' out' : '') + (d.getDay() === 0 ? ' sun' : '')
      + (dayKey(d) === todayK ? ' today' : '') + (dayKey(d) === calSel ? ' on' : '');
    const num = document.createElement('span');
    num.textContent = d.getDate();
    const dots = document.createElement('span');
    dots.className = 'cdots';
    for (let k = 0; k < Math.min(3, eventsOn(d).length); k++) dots.append(document.createElement('i'));
    cell.append(num, dots);
    cell.onclick = (e) => {
      e.stopPropagation();
      calSel = dayKey(d);
      if (out) { calAnchor = new Date(d); loadCal(); return; }
      paintCal();
    };
    // 빈 날짜를 두 번 누르면 그 날 오전 10시로 새 일정 만들기 화면을 연다
    cell.ondblclick = (e) => {
      e.stopPropagation();
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0);
      window.nunsseom.calNewEvent({ start: s.getTime(), end: s.getTime() + 3600000 });
    };
    grid.append(cell);
  }

  // 선택한 날의 일정
  const host = $('cal-list');
  host.textContent = '';
  const list = eventsOn(fromKey(calSel));
  if (calData && !calData.hasCalendar) {
    const p = document.createElement('div');
    p.className = 'calempty';
    p.textContent = '설정에서 캘린더를 연결하세요';
    host.append(p);
    return;
  }
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'calempty';
    p.textContent = '일정 없음';
    host.append(p);
    return;
  }
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'cev';
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = e.allDay ? '종일' : hh(e.start);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = e.summary;
    row.append(tm, nm);
    row.title = '두 번 누르면 웹에서 엽니다';
    row.ondblclick = (ev2) => {
      ev2.stopPropagation();
      window.nunsseom.calOpenEvent(e);
    };
    host.append(row);
  }
}

// 열어보지 않고 뱃지만 지우고 싶을 때가 있다 (광고 메일).
// 목록에서 오른쪽 클릭하면 그 한 통이, 머리글의 «모두 읽음»을 누르면 전부 읽음이 된다.
let markingRead = false;

async function markRead(opts) {
  if (markingRead) return;
  markingRead = true;
  try {
    const r = await window.nunsseom.mailMarkRead(opts);
    // 결과는 메인이 틱으로 실어 보낸다 (paintNote) — 여기서 글자를 바꾸면 1초 뒤 덮인다
    dlog('메일', r && r.ok === false
      ? `읽음 표시 실패 · ${r.message}`
      : `읽음 표시 · ${(r && r.changed) || 0}통`);
  } finally {
    markingRead = false;
  }
}

/** 메인이 보내준 결과 한 줄 */
function paintNote(box) {
  const nt = (box && box.notice) || null;
  for (const id of ['mail-note', 'mp-note']) {
    const el = $(id);
    if (!el) continue;
    el.textContent = nt ? nt.text : '';
    // 위젯이 좁아 글이 잘린다 — 전체는 올려두면 보이게
    el.title = nt ? nt.text : '';
    el.className = 'note' + (nt ? ' ' + nt.kind : '');
  }
}

function attachMailRow(row, m) {
  // 임시보관함의 줄은 메일이 아니라 «쓰다 만 것»이다 — 서버에서 열 것이 없다.
  // 한 번만 눌러도 쓰기 창이 열리게 한다 (둘째 눌러 여는 것은 «읽는» 일이다).
  if (m.draft) {
    row.title = '누르면 이어서 씁니다';
    row.onclick = (e) => { e.stopPropagation(); window.nunsseom.composeOpen({ kind: 'new' }); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.nunsseom.mailRowMenu({ ...m });
    };
    return;
  }
  row.ondblclick = (e) => { e.stopPropagation(); window.nunsseom.mailOpen(m); };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // m.seen은 마지막으로 그렸을 때의 값이다. 방금 눌러 흐려진 줄을 또 누르면
    // 틱이 오기 전이라 m.seen은 아직 false다 — 화면 상태도 같이 봐야 한다.
    const seen = m.seen || row.classList.contains('read');
    window.nunsseom.mailRowMenu({ ...m, seen });
  };
}

// ── 메일 폴더 ──────────────────────────────────────
// 한 목록에 다 쏟으면 광고가 자리를 다 먹는다. 그렇다고 규칙으로 걸러 «없애»면,
// 너무 넓게 잡았을 때 알아챌 방법이 없다 — 조용히 사라지는 메일이 제일 위험하다.
// 그래서 폴더로 나눈다. 숨긴 것도 폴더 하나일 뿐이고, 언제든 열어볼 수 있다.
let mailFolder = 'in';
// 보낸메일함을 불러와 달라고 했고 아직 결과가 안 왔다.
// 이걸 안 들고 있으면 «비어 있음»과 «아직 안 왔음»을 구별할 수 없어서,
// 누르자마자 «보낸 메일이 없습니다»가 떴다 (실제로 그랬다).
let sentAsked = false;

/** 틱이 올 때마다 — 결과가 왔거나 실패했으면 다시 누를 수 있게 풀어준다 */
function noteSent(box) {
  const f = ((box && box.folders) || []).find((x) => x.id === 'sent');
  if (f && (!f.lazy || f.error)) sentAsked = false;
}

/** 폴더가 비었을 때 뭐라고 할지 — 이유가 다르면 말도 달라야 한다 */
function emptyWord(f, box) {
  if (!f) return '새 메일 없음';
  if (f.id === 'sent') {
    if (f.loading || (f.lazy && sentAsked)) return '보낸 메일을 불러오는 중…';
    // 사유가 있으면 그게 먼저다. 계정이 없을 때 lazy가 안 풀려서
    // «누르면 불러옵니다» ↔ «불러오는 중»만 오갈 뿐 이유는 끝내 안 나왔다.
    if (f.error) return f.error;
    if (f.lazy) return '누르면 보낸 메일을 불러옵니다';
    return '보낸 메일이 없습니다';
  }
  if (f.id === 'draft') return '쓰다 만 글이 없습니다';
  if (f.id === 'in') {
    return box && box.filtered ? `새 메일 없음 · 필터가 ${box.filtered}통 숨김` : '새 메일 없음';
  }
  return '이 폴더는 비어 있어요';
}

/**
 * 지금 보고 있는 폴더.
 * 규칙을 지워 폴더가 사라졌으면 «메일»로 돌아오고, 그 사실을 기억한다 —
 * 안 그러면 나중에 규칙을 다시 만들었을 때 엉뚱하게 숨김 폴더에서 시작한다.
 */
function currentFolder(box) {
  const list = (box && box.folders) || [];
  const found = list.find((f) => f.id === mailFolder);
  if (found) return found;
  mailFolder = list.length ? list[0].id : 'in';
  return list[0] || null;
}

/**
 * 폴더 줄. 아웃룩의 폴더 창을 좁은 위젯에 맞게 한 줄로 눕힌 것.
 * @param cls 시트와 패널이 쓰는 칩 클래스가 같다 — 둘 다 이 함수를 쓴다
 */
function folderStrip(box, redraw) {
  // 탭은 옆으로 굴러가되, ⚙는 자리를 지킨다 — 폴더가 늘면 톱니가 화면 밖으로
  // 밀려나가 필터 관리로 갈 길이 사라졌다 (좋은 폭에서는 안 보이는 문제였다).
  const wrap = document.createElement('div');
  wrap.className = 'mailtabs';
  const strip = document.createElement('div');
  strip.className = 'mtabs';
  for (const f of (box && box.folders) || []) {
    const on = f.id === (currentFolder(box) || {}).id;
    const b = document.createElement('button');
    b.className = 'mtab' + (on ? ' on' : '') + (f.id === 'hidden' ? ' dim' : '');
    // 숫자는 언제나 «그 폴더에 몇 통»이다. 안 읽은 수를 섞어 쓰면 3줄인데 2라고 적히는
    // 일이 생겨서 무슨 수인지 알 수 없게 된다. 안 읽은 것이 있다는 표시는 점으로 따로 한다.
    b.append(`${f.name} ${f.count}`);
    if (f.unread) {
      const dot = document.createElement('i');
      dot.className = 'mdot';
      b.append(dot);
    }
    b.title = `${f.name} · ${f.count}통`
      + (f.unread ? ` · 안 읽음 ${f.unread}` : '')
      + (f.id === 'hidden' ? '\n규칙이 걸러낸 것들입니다. 오른쪽 클릭해서 그 규칙을 끌 수 있어요.' : '');
    b.onclick = (e) => {
      e.stopPropagation();
      mailFolder = f.id;
      // 보낸메일함은 폴링에 안 실린다 — 처음 누를 때 가져온다.
      // 이미 보낸 요청이 돌고 있으면 또 보내지 않는다. 느린 서버에 같은 명령을
      // 두 번 보내면 그만큼 더 기다리게 될 뿐이다.
      if (f.lazy && !f.loading && !sentAsked) {
        sentAsked = true;
        window.nunsseom.mailSent();   // 결과는 다음 틱에 실려 온다
      }
      redraw();
    };
    strip.append(b);
  }
  if (!strip.children.length) return null;

  // 옆으로 넘기는 길 — 보통 마우스에는 가로 휠이 없으므로
  // 세로 휠을 가로로 바꿔 준다. 가로 휠(터치패드)이 오면 그걸 쓴다.
  strip.addEventListener('wheel', (e) => {
    if (strip.scrollWidth <= strip.clientWidth) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    strip.scrollLeft += d;
    e.preventDefault();     // 위젯 전체가 스크롤되지 않게
  }, { passive: false });

  // 어느 쪽에 더 있는지 후위에 표시한다 (자리를 안 차지하는 힐말이다)
  const syncEdges = () => {
    const room = strip.scrollWidth - strip.clientWidth;
    strip.classList.toggle('more-l', room > 1 && strip.scrollLeft > 1);
    strip.classList.toggle('more-r', room > 1 && strip.scrollLeft < room - 1);
  };
  strip.addEventListener('scroll', syncEdges);
  // 그려진 뒤에야 폭을 안다
  requestAnimationFrame(() => {
    // 고른 탭이 안 보이는 자리에 있으면 끌어다 놓는다
    const on = strip.querySelector('.mtab.on');
    if (on) {
      const right = on.offsetLeft + on.offsetWidth - strip.clientWidth;
      if (on.offsetLeft < strip.scrollLeft) strip.scrollLeft = on.offsetLeft;
      else if (right > strip.scrollLeft) strip.scrollLeft = right;
    }
    syncEdges();
  });

  const gear = document.createElement('button');
  gear.className = 'mtab gear';
  gear.textContent = '⚙';
  gear.title = '필터 규칙 관리';
  gear.onclick = (e) => { e.stopPropagation(); window.nunsseom.openSettings('mail'); };
  wrap.append(strip, gear);
  return wrap;
}

/** 규칙에 걸려서 여기 있는 메일이면, 왜 그런지 한 줄 덧붙인다 */
function whyLine(m) {
  if (!m.byRule) return null;
  const s = document.createElement('small');
  s.className = 'why';
  s.textContent = m.byRule.why || '';
  return s;
}

/** 새 메일 — 일정과 같은 모양으로 아래에 붙인다 */
function renderMail(box) {
  const sec = $('mailbox');
  const folders = (box && box.folders) || [];
  const cur = currentFolder(box);
  const key = box ? `${box.unread}:${folders.length}:${cur ? cur.id + cur.count : '-'}` : 'none';
  lastMailBox = box;
  noteSent(box);    // 보낸메일함 결과가 왔는지 먼저 본다
  paintNote(box);   // 목록이 비어 아래에서 일찍 빠져나가도 결과는 보여야 한다
  if (mailCard.classList.contains('mailon')) paintMailPanel();
  if (key !== lastMailRender) {
    lastMailRender = key;
    dlog('메일', box
      ? `받음 · 안읽음 ${box.unread} · 폴더 ${folders.map((f) => `${f.name}(${f.count})`).join(' ') || '없음'}`
      : '받은 것 없음 (설정이 꺼져 있거나 계정 없음)');
  }
  // 패널이 켜져 있으면 시트에도 넣을 이유가 없다 — 같은 목록이 두 번 겹쳐 보인다
  if (!box || !folders.length || mailCard.classList.contains('mailon')) {
    sec.style.display = 'none';
    return;
  }
  sec.style.display = 'block';
  $('mail-ttl').textContent = box.unread ? `메일 · 안 읽음 ${box.unread}` : '메일';
  $('mail-allread').style.display = box.unread ? '' : 'none';
  const host = $('mail-rows');
  host.textContent = '';
  // 폴더가 «메일» 하나뿐이면 줄을 안 그린다 — 규칙을 안 쓰는 사람에게는 없던 것과 같아야 한다
  if (folders.length > 1) {
    const strip = folderStrip(box, () => renderMail(lastMailBox));
    if (strip) host.append(strip);
  }
  for (const m of (cur && cur.items) || []) {
    const row = document.createElement('div');
    // 읽은 메일은 한 톤 죽여서 안 읽은 것이 먼저 눈에 들어오게 한다
    row.className = 'row ev mail' + (m.seen ? ' read' : ' now');
    const dot = document.createElement('span');
    dot.className = 'evdot';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.append(m.subject);
    nm.title = m.from ? `${m.from} · ${m.subject}` : m.subject;
    const why = cur.id === 'hidden' ? whyLine(m) : null;
    if (why) nm.append(why);
    row.append(dot, nm);
    row.title = '두 번 누르면 열립니다 · 오른쪽 클릭하면 메뉴가 나옵니다';
    attachMailRow(row, m);
    host.append(row);
  }
  if (cur && !cur.items.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = emptyWord(cur, box);
    host.append(p);
  }
}

function shift(dir) {
  const d = new Date(calAnchor);
  if (calMode === 'week') d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir, 1);
  calAnchor = d;
  loadCal();
}

function setMode(mode) {
  calMode = mode;
  $('cal-week').classList.toggle('on', mode === 'week');
  $('cal-month').classList.toggle('on', mode === 'month');
  window.nunsseom.setApp({ calendarMode: mode });
  resizeForCal();
  paintCal();
}

/** 달력을 켜고 끌 때 위젯 높이를 그만큼 늘리고 줄인다.
    필요한 높이는 실제로 그려본 뒤 재야 정확하다 (칸이 정사각형이라 폭에 따라 달라진다) */
function resizeForCal() {
  const on = calCard.classList.contains('calon');
  requestAnimationFrame(() => {
    const needed = on ? Math.ceil(calEl.scrollHeight) : 0;
    window.nunsseom.calPanel({ on, needed });
  });
}

function toggleCal(force) {
  const on = force !== undefined ? force : !calCard.classList.contains('calon');
  calCard.classList.toggle('calon', on);
  calCard.classList.remove('open');            // 시트와 동시에 열리면 겹친다
  window.nunsseom.setApp({ calendarPanel: on });
  resizeForCal();
  if (on) loadCal();
}

// 지난번에 켜 둔 상태를 이어간다
if (params.get('calmode') === 'week') {
  calMode = 'week';
  $('cal-week').classList.add('on');
  $('cal-month').classList.remove('on');
}
if (params.get('calpanel') === '1') {
  calCard.classList.add('calon');
  loadCal().then(resizeForCal);
}

$('btn-cal').append(window.nunsIcon('calendar'));
$('btn-cal').onclick = () => toggleCal();

// ── 메일 패널 ──────────────────────────────────────
// 시트를 열어야만 보이면 "안 뜬다"가 된다. 달력과 같은 방식으로 겉면에 펼친다.
function paintMailPanel() {
  const box = lastMailBox;
  const host = $('mp-list');
  host.textContent = '';
  $('mp-ttl').textContent = box && box.unread ? `메일 · 안 읽음 ${box.unread}` : '메일';
  paintNote(box);
  $('mp-allread').style.display = box && box.unread ? '' : 'none';
  const folders = (box && box.folders) || [];
  const cur = currentFolder(box);
  if (!folders.length) {
    const p = document.createElement('div');
    p.className = 'calempty';
    p.textContent = box ? '새 메일 없음' : '설정에서 메일을 연결하세요';
    host.append(p);
    return;
  }
  // 폴더가 «메일» 하나뿐이면 줄을 안 그린다 — 규칙을 안 쓰면 없던 것과 같아야 한다
  if (folders.length > 1) {
    const strip = folderStrip(box, () => { paintMailPanel(); resizeForMail(); });
    if (strip) host.append(strip);
  }
  for (const m of (cur && cur.items) || []) {
    const row = document.createElement('div');
    row.className = 'cev mailrow' + (m.seen ? ' read' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.append(m.subject);
    // 보낸 사람은 좁은 위젯에서 제목 자리를 잡아먹는다 — 열어보면 나온다
    nm.title = m.from ? `${m.from} · ${m.subject}` : m.subject;
    // 숨김 폴더에서는 «왜 사라졌나»가 제목만큼 중요하다
    const why = cur.id === 'hidden' ? whyLine(m) : null;
    if (why) nm.append(why);
    row.append(nm);
    row.title = '두 번 누르면 열립니다 · 오른쪽 클릭하면 메뉴가 나옵니다';
    attachMailRow(row, m);
    host.append(row);
  }
  if (cur && !cur.items.length) {
    const p = document.createElement('div');
    p.className = 'calempty';
    p.textContent = emptyWord(cur, box);
    host.append(p);
  }
}

// 보여줄 개수에 상한이 없으므로, 목록이 길다고 위젯이 화면 끝까지 자라면 안 된다.
// 여기까지만 늘리고 나머지는 목록 안에서 굴린다.
const MAIL_PANEL_MAX = 300;

function resizeForMail() {
  const on = mailCard.classList.contains('mailon');
  requestAnimationFrame(() => {
    const needed = on ? Math.min(MAIL_PANEL_MAX, Math.ceil($('mailpanel').scrollHeight)) : 0;
    window.nunsseom.calPanel({ on, needed, which: 'mail' });
  });
}

function toggleMail(force) {
  const on = force !== undefined ? force : !mailCard.classList.contains('mailon');
  mailCard.classList.toggle('mailon', on);
  mailCard.classList.remove('open');
  window.nunsseom.setApp({ mailPanel: on });
  if (on) paintMailPanel();
  resizeForMail();
}

$('btn-mail').append(window.nunsIcon('mail'));
$('btn-mail').onclick = () => toggleMail();
for (const id of ['mail-allread', 'mp-allread']) {
  $(id).onclick = (e) => { e.stopPropagation(); markRead({}); };
  // 시트가 열려 있을 때 눌러도 시트가 닫히면 안 된다
  $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
}
// 주기(몇 분)를 기다리지 않고 지금 확인한다. 결과는 머리글 알림 줄에 뜬다.
let refreshing = false;
for (const id of ['mail-refresh', 'mp-refresh']) {
  $(id).onclick = async (e) => {
    e.stopPropagation();
    if (refreshing) return;
    refreshing = true;
    try { await window.nunsseom.mailRefresh(); } finally { refreshing = false; }
  };
  $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
}
for (const id of ['mail-write', 'mp-write']) {
  $(id).onclick = (e) => {
    e.stopPropagation();
    const m = (lastMailBox && lastMailBox.messages && lastMailBox.messages[0]) || null;
    window.nunsseom.composeOpen({ kind: 'new', accountId: m && m.accountId });
  };
  $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
}
$('mailpanel').addEventListener('pointerdown', (e) => e.stopPropagation());
if (params.get('mailpanel') === '1') {
  mailCard.classList.add('mailon');
  setTimeout(resizeForMail, 300);
}
$('cal-prev').onclick = (e) => { e.stopPropagation(); shift(-1); };
$('cal-next').onclick = (e) => { e.stopPropagation(); shift(1); };
$('cal-week').onclick = (e) => { e.stopPropagation(); setMode('week'); };
$('cal-month').onclick = (e) => { e.stopPropagation(); setMode('month'); };
// 달력 안을 눌러도 카드 이동/시트 토글로 새지 않게
calEl.addEventListener('pointerdown', (e) => e.stopPropagation());
window.nunsseom.onCalChanged?.(() => { if (calCard.classList.contains('calon')) loadCal(); });
window.nunsseom.onCalShow?.(() => toggleCal(true));
// 새 메일 알림을 눌러 들어온 경우 — 메일 패널을 펴서 바로 보이게
window.nunsseom.onMailShow?.(() => toggleMail(true));
$('btn-hide').onclick = () => window.nunsseom.hideWidget();

// ── 카드: 클릭하면 예정된 알림 시트, 끌면 창 이동 ──
// app-region: drag는 OS가 마우스 이벤트를 가져가 클릭을 못 받으므로 직접 구현한다.
const cardEl = $('card');
let press = null;
let dragging = false;

cardEl.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  // 컨트롤·시트 위에서는 카드 이동/토글 로직을 돌리지 않는다.
  // (시트를 포함하지 않으면 카드가 포인터를 가로채 시트 버튼 클릭이 먹힌다)
  if (e.target.closest('.ctlwrap, .sheet')) return;
  // 오른쪽아래 모서리(그립 표시 자리)는 OS 리사이즈 몫이다.
  // 여기서 창을 움직이기 시작하면 리사이즈하려던 손이 창을 끌어버린다.
  const gr = $('grip').getBoundingClientRect();
  if (e.clientX >= gr.left && e.clientY >= gr.top) return;
  dragging = false;
  const pos = await window.nunsseom.getWidgetPos();
  press = { sx: e.screenX, sy: e.screenY, x: pos.x, y: pos.y };
  try { cardEl.setPointerCapture(e.pointerId); } catch {}
  dlog('카드', `down 화면 ${e.screenX},${e.screenY} · 창 @${pos.x},${pos.y}`
    + ` · 대상 ${e.target.tagName}.${e.target.className?.baseVal ?? e.target.className}`);
});

// 시트가 열린 상태에서 빈 곳(버튼·행이 아닌 곳)을 누르면 닫는다
$('sheet').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#sheet-stats, .rows .row')) {
    cardEl.classList.remove('open');
  }
});

cardEl.addEventListener('pointermove', (e) => {
  if (!press) return;
  const dx = e.screenX - press.sx;
  const dy = e.screenY - press.sy;
  if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) { dragging = true; dlog('카드', '이동 시작'); }
  if (dragging) window.nunsseom.moveWidget({ x: press.x + dx, y: press.y + dy });
});

const endPress = (e) => {
  if (!press) return;
  const wasDrag = dragging;
  press = null;
  dragging = false;
  try { cardEl.releasePointerCapture(e.pointerId); } catch {}
  if (!wasDrag) cardEl.classList.toggle('open'); // 끌지 않았으면 클릭 = 시트 토글
  dlog('카드', wasDrag ? 'up (이동으로 끝)' : `up → 시트 ${cardEl.classList.contains('open') ? '열림' : '닫힘'}`);
};
cardEl.addEventListener('pointerup', endPress);
cardEl.addEventListener('pointercancel', endPress);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cardEl.classList.remove('open');
});

// ── 가장자리·모서리 리사이즈 ───────────────────────
// OS 네이티브 리사이즈는 쓰지 않는다. 투명·프레임 없는 창에서는 버튼을 누른 채
// 가만히 있어도 창이 저 혼자 최대치까지 자라는 문제가 있다. 여기서 직접 계산한다.
// 화면 좌표(screenX/Y) 기준이라 창이 움직여도 값이 흔들리지 않는다.
let rz = null;

for (const zone of document.querySelectorAll('.rz')) {
  zone.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();               // 카드의 이동/토글 로직으로 새지 않게
    try { zone.setPointerCapture(e.pointerId); } catch {}
    const b = await window.nunsseom.getWidgetBounds();
    rz = { dir: zone.dataset.dir, sx: e.screenX, sy: e.screenY, ...b };
    dlog('리사이즈', `down(${rz.dir}) 화면 ${e.screenX},${e.screenY}`
      + ` · 시작 ${b.width}x${b.height} @${b.x},${b.y}`);
  });

  zone.addEventListener('pointermove', (e) => {
    if (!rz) return;
    const dx = e.screenX - rz.sx;
    const dy = e.screenY - rz.sy;
    let { x, y, width, height } = rz;
    if (rz.dir.includes('e')) width = rz.width + dx;
    if (rz.dir.includes('s')) height = rz.height + dy;
    if (rz.dir.includes('w')) { width = rz.width - dx; x = rz.x + dx; }
    if (rz.dir.includes('n')) { height = rz.height - dy; y = rz.y + dy; }
    window.nunsseom.setWidgetBounds({ x, y, width, height, dir: rz.dir });
    dlog('리사이즈', `move(${rz.dir}) 화면 ${e.screenX},${e.screenY} · 이동량 ${dx},${dy}`
      + ` → 요청 ${Math.round(width)}x${Math.round(height)} @${Math.round(x)},${Math.round(y)}`);
  });

  const endRz = (e) => {
    if (!rz) return;
    dlog('리사이즈', `${e.type}(${rz.dir}) 끝`);
    rz = null;
    try { zone.releasePointerCapture(e.pointerId); } catch {}
  };
  zone.addEventListener('pointerup', endRz);
  zone.addEventListener('pointercancel', endRz);
}

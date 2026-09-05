'use strict';
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

// 틱 핸들러가 이 값들을 건드린다. 틱은 스크립트가 끝나기 전에도 도착할 수 있으므로
// 반드시 등록보다 위에서 선언해야 한다 (여기서 TDZ로 위젯 전체가 죽은 적이 있다).
const mailCard = document.getElementById('card');

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
// 달력 패널은 widget-cal.js 가 그린다 (이 파일이 1,300줄이라 갈라냈다).
// 공유하는 것의 주인은 여기다 — 카드 요소와 «칸 높이 다시 재기»는 카드 배치의 몫이지
// 달력·메일 어느 한쪽 것이 아니다.
window.nunsW = {
  card: mailCard,
  params: new URLSearchParams(location.search),
  num: (k, d) => { const v = parseFloat(window.nunsW.params.get(k)); return Number.isNaN(v) ? d : v; },
  resizeForCal: () => resizeForCal(),
  pinnedAny: () => pinnedAny(),
  dlog: (...a) => dlog(...a)
};

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
// 이보다 멀면 초 단위 카운트다운이 의미가 없다 — 정해진 시각 알림은 시계처럼 보여준다
const CLOCK_SEC = 3600;
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

  // 정해진 시각 알림이 한참 남았으면 «09:00»을 그대로 보여준다.
  // 카운트다운으로 두면 «1200:00»이 되는데, 그건 아무에게도 도움이 안 된다.
  // 한 시간 안으로 들어오면 다시 초까지 세는 카운트다운으로 바뀐다.
  if (d.fixedAt && d.remaining > CLOCK_SEC) {
    $('time').textContent = d.fixedAt;
  } else {
    const m = Math.floor(d.remaining / 60);
    const s = d.remaining % 60;
    $('time').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

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
  // widget-mail.js 는 이 파일 다음에 오는 별개 <script> 다. tick 은 1초마다 오므로
  // 그 사이에 낀 첫 tick 하나쯤은 흘려도 된다 — 대신 여기서 터져 아래 줄들이
  // 통째로 안 도는 일은 없어야 한다 (설정 창에서 실제로 그랬다).
  window.nunsWMail?.renderMail(d.mail);
  $('btn-stock').style.display = d.stocksOn ? '' : 'none';
  showUpdate(d.update);
  if (d.week) renderWeek(d.week);
});

$('btn-pause').onclick = () => window.nunsseom.togglePause();
$('btn-now').onclick = () => window.nunsseom.breakNow(lastTypeId);
$('btn-set').onclick = () => window.nunsseom.openSettings();
$('sheet-stats').onclick = (e) => { e.stopPropagation(); window.nunsseom.openStats(null); };
$('sheet-cal').onclick = (e) => { e.stopPropagation(); window.nunsWCal.toggleCal(true); };

// ── 달력 ────────────────────────────────────────────
// 카드 안에서 아래로 늘어난다. 별도 창이 아니라 위젯이 길어지는 방식.
const calCard = $('card');
function resizeForCal() {
  const on = calCard.classList.contains('calon');
  requestAnimationFrame(() => {
    const needed = on ? Math.ceil(window.nunsWCal.calEl.scrollHeight) : 0;
    // 각 칸이 «얼마나 필요한지»를 더해 창 높이를 잡는데, 그 합이 실제 배치와 늘 맞지는
    // 않는다 — 메일 칸은 scrollHeight 가 제 여백을 덜 세어 27px이라 말하고 실제로는
    // 48px을 쓴다. 그래서 그려본 뒤 «모자란 만큼»을 같이 보내 그것만큼 더 받는다.
    const short = on ? Math.max(0, window.nunsWCal.calEl.scrollHeight - window.nunsWCal.calEl.clientHeight) : 0;
    window.nunsseom.calPanel({ on, needed, short, pinned: pinnedAny() });
  });
}

const SPLIT = {
  inner: { css: '--inner-h', key: 'panelInnerH', el: () => document.querySelector('.inner'), min: 64 },
  mail: { css: '--mail-h', key: 'panelMailH', el: () => $('mailpanel'), min: 40 }
};
const CAL_MIN = 90;   // 달력이 이보다 좁아지면 주 이름만 남아 쓸모가 없다

/**
 * 이 손잡이가 잡는 «위 칸».
 * 메일 칸 위는 늘 쉬는 칸이지만, 달력 칸 위는 메일이 꺼져 있으면 쉬는 칸이다.
 * 고정으로 두면 메일을 껐을 때 달력 손잡이가 아무것도 안 움직인다.
 */
function splitAbove(gripId) {
  if (gripId === 'grip-inner') return 'inner';
  return calCard.classList.contains('mailon') ? 'mail' : 'inner';
}

/**
 * 남는 높이를 내주는 칸 — 맨 아래 켜진 칸이 늘 «1fr»이라 그것이 준다.
 * 위 칸을 늘리는 만큼 이 칸이 줄고, 최소에 닿으면 거기서 멈춘다.
 */
function splitElastic() {
  if (calCard.classList.contains('calon')) return { el: $('cal'), min: CAL_MIN };
  if (calCard.classList.contains('mailon')) return { el: $('mailpanel'), min: SPLIT.mail.min };
  return null;
}

function pinnedAny() {
  return !!(calCard.style.getPropertyValue('--inner-h') || calCard.style.getPropertyValue('--mail-h'));
}

function setSplit(which, px) {
  const s = SPLIT[which];
  if (px == null) calCard.style.removeProperty(s.css);
  else calCard.style.setProperty(s.css, `${Math.round(px)}px`);
  window.nunsseom.setApp({ [s.key]: px == null ? null : Math.round(px) });
}

function bindSplit(id) {
  const grip = $(id);
  if (!grip) return;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();       // 안 막으면 창이 통째로 끌려간다
    const which = splitAbove(id);
    const s = SPLIT[which];
    const el = s.el();
    const flex = splitElastic();
    if (!el || !flex || flex.el === el) return;
    const y0 = e.clientY;
    const h0 = el.getBoundingClientRect().height;
    const room = Math.max(0, flex.el.getBoundingClientRect().height - flex.min);
    grip.classList.add('on');
    // 손잡이는 9px밖에 안 된다 — 조금만 빨리 끌어도 포인터가 밖으로 나간다.
    // 그래서 창 전체에서 듣는다 (setPointerCapture 는 창을 벗어나면 놓친다).
    const move = (ev) => {
      const want = h0 + (ev.clientY - y0);
      calCard.style.setProperty(s.css, `${Math.round(Math.max(s.min, Math.min(h0 + room, want)))}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      grip.classList.remove('on');
      const now = calCard.style.getPropertyValue(s.css);
      if (now) window.nunsseom.setApp({ [s.key]: parseInt(now, 10) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  // 두 번 누르면 «알아서»로
  grip.addEventListener('dblclick', (e) => { e.stopPropagation(); setSplit(splitAbove(id), null); });
}

bindSplit('grip-inner');
bindSplit('grip-mail');

// 지난번에 끌어 둔 높이를 이어간다
if (params.get('innerh')) calCard.style.setProperty('--inner-h', `${parseInt(params.get('innerh'), 10)}px`);
if (params.get('mailh')) calCard.style.setProperty('--mail-h', `${parseInt(params.get('mailh'), 10)}px`);

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
// 누르기마다 번호를 매긴다 — 늦게 온 IPC 답이 이미 끝난 판을 되살리지 못하게
let rzSeq = 0;

for (const zone of document.querySelectorAll('.rz')) {
  zone.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();               // 카드의 이동/토글 로직으로 새지 않게
    try { zone.setPointerCapture(e.pointerId); } catch {}
    // 크기를 물어보는 동안(IPC) 손을 뗄 수 있다. 그때 endRz 는 rz 가 아직 없어서
    // 그냥 지나가고, 답이 온 뒤에 rz 가 «켜진 채로» 남는다 — 그 뒤로는 단추를 안
    // 눌러도 zone 위에서 움직이기만 하면 창이 커진다. 주식 창에서 실제로 그랬다.
    // 그래서 이 누르기가 아직 살아 있는지 표로 확인하고 넣는다.
    const token = ++rzSeq;
    const b = await window.nunsseom.getWidgetBounds();
    if (token !== rzSeq) return;           // 벌써 뗐거나 다시 눌렸다 — 없던 일로
    rz = { dir: zone.dataset.dir, sx: e.screenX, sy: e.screenY, ...b };
    dlog('리사이즈', `down(${rz.dir}) 화면 ${e.screenX},${e.screenY}`
      + ` · 시작 ${b.width}x${b.height} @${b.x},${b.y}`);
  });

  zone.addEventListener('pointermove', (e) => {
    if (!rz) return;
    // 단추를 안 누른 채 오는 움직임은 이미 끝난 것이다 (up 을 놓쳤을 때의 두 번째 문)
    if (!(e.buttons & 1)) { rz = null; rzSeq++; return; }
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
    rzSeq++;                 // 아직 안 온 답이 있어도 이 판은 끝났다
    if (!rz) return;
    dlog('리사이즈', `${e.type}(${rz.dir}) 끝`);
    rz = null;
    try { zone.releasePointerCapture(e.pointerId); } catch {}
  };
  zone.addEventListener('pointerup', endRz);
  zone.addEventListener('pointercancel', endRz);
}

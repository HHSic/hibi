// 위젯 안 달력 패널.
//
// widget.js 가 1,300줄이라 갈라냈다. 달력과 메일은 서로 부르는 데가 한 군데도 없다 —
// 붙어 보였던 것은 (1) 같은 #card 를 mailCard·calCard 두 이름으로 잡고 있었고,
// (2) shift() 같은 달력 함수가 메일 구간 안에 놓여 있었기 때문이다.
//
// 공유하는 것은 widget.js 가 주인이다: 카드 요소와 «칸 높이 다시 재기»(nw.resizeForCal).
// 칸 높이는 달력 것이 아니라 카드 배치의 몫이라 코어에 남겼다.

(() => {
'use strict';

const nw = window.nunsW;
const $ = (id) => document.getElementById(id);

const calEl = $('cal');

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
  // 격자를 다 그렸으면 높이를 다시 잰다. 달마다 줄 수가 다르다(5줄·6줄) — 모드를 바꿀 때만
  // 재면 ‹ ›로 6줄짜리 달에 들어섰을 때 창은 그대로고 아래 한 줄이 잘린다 (실측 30px).
  // 반드시 아래 두 return 보다 앞이어야 한다 — 일정 없는 달이면 거기서 끝나 버린다.
  // nw.resizeForCal 은 rAF 안에서 재므로, 뒤에 붙는 일정 목록까지 포함한 값이 잡힌다.
  nw.resizeForCal();
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
  nw.resizeForCal();
  paintCal();
}

/** 달력을 켜고 끌 때 위젯 높이를 그만큼 늘리고 줄인다.
    필요한 높이는 실제로 그려본 뒤 재야 정확하다 (칸이 정사각형이라 폭에 따라 달라진다) */

function toggleCal(force) {
  const on = force !== undefined ? force : !nw.card.classList.contains('calon');
  nw.card.classList.toggle('calon', on);
  nw.card.classList.remove('open');            // 시트와 동시에 열리면 겹친다
  window.nunsseom.setApp({ calendarPanel: on });
  nw.resizeForCal();
  if (on) loadCal();
}

// 지난번에 켜 둔 상태를 이어간다
if (nw.params.get('calmode') === 'week') {
  calMode = 'week';
  $('cal-week').classList.add('on');
  $('cal-month').classList.remove('on');
}
if (nw.params.get('calpanel') === '1') {
  nw.card.classList.add('calon');
  loadCal().then(nw.resizeForCal);
}

$('btn-cal').append(window.nunsIcon('calendar'));
$('btn-cal').onclick = () => toggleCal();

// ── 메일 패널 ──────────────────────────────────────
// 시트를 열어야만 보이면 "안 뜬다"가 된다. 달력과 같은 방식으로 겉면에 펼친다.
/**
 * 지금 목록이 «무엇을 그리고 있나»를 한 줄로. 이것이 같으면 다시 그릴 이유가 없다.
 *
 * 틱은 1초마다 온다. 그때마다 목록을 통째로 헐고 다시 지으면
 *  - 마우스를 올려둔 줄이 사라졌다 생겨서 깜빡인다
 *  - 글을 끌어 고르던 것이 풀린다
 * 그래서 바뀐 것이 있을 때만 짓는다.
 */

// widget.js 가 부르는 것들
window.nunsWCal = { calEl, loadCal, setMode, shift, toggleCal, get mode() { return calMode; } };
})();

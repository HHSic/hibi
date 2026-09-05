// 위젯 안 메일 패널 — 계정·폴더 띠, 목록, 더 보기, 읽음 표시.
//
// widget.js 에서 갈라냈다. 달력과는 서로 부르는 데가 한 군데도 없다 —
// 붙어 보였던 것은 같은 #card 를 mailCard·calCard 두 이름으로 잡고 있어서였다.
//
// 공유하는 것은 widget.js 가 주인이다: 카드 요소·칸 높이 계산·기록.

(() => {
'use strict';

const nw = window.nunsW;
const $ = (id) => document.getElementById(id);

let lastMailBox = null;

let lastMailRender = '';

let markingRead = false;

async function markRead(opts) {
  if (markingRead) return;
  markingRead = true;
  try {
    const r = await window.nunsseom.mailMarkRead(opts);
    // 결과는 메인이 틱으로 실어 보낸다 (paintNote) — 여기서 글자를 바꾸면 1초 뒤 덮인다
    nw.dlog('메일', r && r.ok === false
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
// 계정별로 나눠 볼 때 지금 고른 계정. 빈 값이면 첫 계정을 쓴다.

let mailAccount = '';
// 보낸메일함을 불러와 달라고 했고 아직 결과가 안 왔다.
// 이걸 안 들고 있으면 «비어 있음»과 «아직 안 왔음»을 구별할 수 없어서,
// 누르자마자 «보낸 메일이 없습니다»가 떴다 (실제로 그랬다).

let sentAsked = false;
// 서버에서 더 받아올 수 있는 폴더. 나머지는 이미 받아둔 것을 나눈 칸이라
// «더 보기»가 뜻이 없다 (숨김·묶음·임시보관함).

const CAN_MORE = new Set(['in', 'sent']);
// 계정별로 나눠 보는 중이면 받은편지함 칸의 id가 «acc:m1»처럼 된다.
// 그것도 받은편지함이므로 더 부를 수 있어야 한다 — 나눠 봤다고 «더 보기»가 죽으면 안 된다.

const canMore = (id) => CAN_MORE.has(id) || String(id || '').startsWith('acc:');
// 서버에 무엇을 더 달라고 할지 — 계정 칸도 결국 받은편지함을 늘리는 것이다

const moreKind = (id) => (id === 'sent' ? 'sent' : 'in');
// «더 보기»를 부르는 중인가 — 스크롤은 연속으로 터져서 막지 않으면 수십 번 부른다.
// 부르는 것은 한 번에 하나뿐이라 이것만 전역이다.

let moreBusy = false;
// 아래 둘은 폴더마다 따로 든다. 하나로 두면 받은편지함에서 끝까지 내려간 순간
// 보낸메일함도 «끝»으로 잠긴다 — 한 번도 안 내려가 봤는데도.
// 끝에서 이만큼 안쪽이면 «바닥»으로 친다. 딱 맞게 재면 배율이 100%가 아닐 때
// 소수점 때문에 영영 안 닿는다.

const SLACK = 40;

const moreDone = new Set();    // 서버가 «마지막»이라고 한 폴더

const pulled = new Map();      // 폴더 → 바닥에서 지금까지 더 굴린 양

let paintedFolder = null;      // 지금 목록에 그려져 있는 폴더 (바뀌면 맨 위로 돌린다)

let paintedSig = '';           // 지금 그려져 있는 목록의 모양 — 같으면 다시 안 그린다

let sheetSig = '';             // 시트 목록 몫

/** 새로 읽었으니 «더 없음»도 «이미 불렀음»도 푼다 */

function rearmMore() {
  moreDone.clear();
  pulled.clear();
}

/**
 * 바닥에 닿은 뒤 «한 번 더» 굴려야 이전 메일을 부른다.
 * 받은편지함과 보낸메일함에서만 한다 — 나머지는 서버에 더 부를 것이 없다.
 *
 * 예전엔 바닥에 닿는 순간 곧바로 불렀다. 그런데 바닥은 그냥 읽다 보면 닿는 자리라,
 * 마지막 줄을 읽으려던 것뿐인데 느린 서버를 부르는 일이 잦았다.
 * 이제 바닥에서 더 굴린 양을 모아 PULL_NEED를 넘을 때 부른다 — «더 볼래»라는 뜻이
 * 분명한 손짓일 때만.
 *
 * 스크롤 사건이 아니라 휠을 듣는 이유: 바닥에서는 더 굴려도 scrollTop이 안 변해서
 * 스크롤 사건으로는 «더 굴렸다»를 알 수 없다. 덤으로, 목록을 다시 그릴 때 나는
 * 가짜 스크롤 사건에 휘말리지도 않는다.
 */

const PULL_NEED = 120;          // 바닥에서 이만큼 더 굴려야 부른다 (휠 두어 칸)

function hookMore(host, folderId) {
  // 더 부를 수 없는 폴더로 옮기면 반드시 떼준다 — 그냥 두면 숨김 폴더를 보는
  // 중에도 이전 메일을 불러온다 (실제로 그랬다).
  host.onscroll = null;
  if (!canMore(folderId)) { host.onwheel = null; return; }

  host.onwheel = async (e) => {
    if (moreBusy || moreDone.has(folderId)) return;
    // 위로 굴리면 «더 볼래»가 아니다 — 모아둔 것을 버린다
    if (e.deltaY <= 0) { pulled.set(folderId, 0); return; }

    const room = host.scrollHeight - host.clientHeight;
    // 굴릴 자리가 없으면 «바닥까지 내려갔다»는 말 자체가 성립하지 않는다
    if (room <= SLACK) return;
    // 진짜 바닥일 때만 센다. 여기서는 넉넉히 잡을 이유가 없다 —
    // 사용자가 실제로 끝까지 내린 뒤라야 한다.
    if (host.scrollTop < room - 2) { pulled.set(folderId, 0); return; }

    // 휠은 기기에 따라 줄/쪽 단위로 오기도 한다 — 픽셀로 맞춘다
    const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
    const sum = (pulled.get(folderId) || 0) + e.deltaY * step;
    if (sum < PULL_NEED) { pulled.set(folderId, sum); return; }
    pulled.set(folderId, 0);

    moreBusy = true;
    try {
      const r = await window.nunsseom.mailMore(moreKind(folderId));
      // «지금은 못 한다»와 «서버에 더 없다»는 다르다.
      // 아직 첫 목록이 안 왔거나 앞의 읽기가 안 끝난 것은 잠깐의 일인데,
      // 이걸 «끝»으로 적어버리면 새로고침을 누르기 전까지 그 폴더가 조용히 죽는다.
      if (r && r.retry) return;
      // 더 없다고 했으면 그만 묻는다. 새로고침을 누르면 다시 풀린다.
      if (!r || r.ok === false || r.more === false) moreDone.add(folderId);
    } finally {
      moreBusy = false;
    }
  };
}

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
/** 계정별로 나눠 보는 중인가 */

function splitOn(box) {
  return !!(box && box.accounts && box.accounts.length);
}

/** 지금 고른 계정 (안 나눌 때는 null) */

function currentAccount(box) {
  if (!splitOn(box)) return null;
  const list = box.accounts;
  return list.find((a) => a.id === mailAccount) || list[0];
}

/** 지금 고른 계정에 속한 폴더들 */

function foldersOf(box) {
  const list = (box && box.folders) || [];
  if (!splitOn(box)) return list;
  const acc = currentAccount(box);
  const mine = list.filter((f) => f.acct === (acc && acc.id));
  // 그 계정 몫이 하나도 없으면(있을 수 없지만) 빈 화면 대신 전체를 보여준다
  return mine.length ? mine : list;
}

function currentFolder(box) {
  const list = foldersOf(box);
  const found = list.find((f) => f.id === mailFolder);
  if (found) return found;
  mailFolder = list.length ? list[0].id : 'in';
  return list[0] || null;
}

/**
 * 계정 줄 — 계정별로 나눠 볼 때만 폴더 줄 위에 얹는다.
 * 계정을 먼저 고르고, 그 안에서 받은·숨김·보낸을 고른다.
 * (한 줄에 다 펼치면 계정 둘에 일곱 칸이 되어 좁은 위젯에서 읽을 수가 없다)
 */

function accountStrip(box, redraw) {
  if (!splitOn(box)) return null;
  const cur = currentAccount(box);
  const strip = document.createElement('div');
  strip.className = 'macts';
  for (const a of box.accounts) {
    // 그 계정 몫의 안 읽은 수를 계정 칩에 모아 보여준다 —
    // 폴더를 열어보지 않고도 어느 계정에 새 메일이 있는지 알아야 한다.
    const mine = (box.folders || []).filter((f) => f.acct === a.id);
    const unread = mine.reduce((s, f) => s + (f.unread || 0), 0);
    const b = document.createElement('button');
    b.className = 'mact' + (cur && a.id === cur.id ? ' on' : '');
    b.append(a.name);
    if (unread) {
      const dot = document.createElement('i');
      dot.className = 'mdot';
      b.append(dot);
    }
    b.title = `${a.name}${unread ? ` · 안 읽음 ${unread}` : ''}`;
    b.onclick = (e) => {
      e.stopPropagation();
      if (mailAccount === a.id) return;
      mailAccount = a.id;
      // 계정을 옮기면 폴더는 그 계정의 첫 칸(받은)으로 — 앞 계정에서 «숨김»을 보고 있었다고
      // 새 계정도 숨김으로 열면 «메일이 하나도 없다»처럼 보인다.
      mailFolder = 'in';
      redraw();
    };
    strip.append(b);
  }
  return strip.children.length ? strip : null;
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
  for (const f of foldersOf(box)) {
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
  if (nw.card.classList.contains('mailon')) paintMailPanel();
  if (key !== lastMailRender) {
    lastMailRender = key;
    nw.dlog('메일', box
      ? `받음 · 안읽음 ${box.unread} · 폴더 ${folders.map((f) => `${f.name}(${f.count})`).join(' ') || '없음'}`
      : '받은 것 없음 (설정이 꺼져 있거나 계정 없음)');
  }
  // 패널이 켜져 있으면 시트에도 넣을 이유가 없다 — 같은 목록이 두 번 겹쳐 보인다
  if (!box || !folders.length || nw.card.classList.contains('mailon')) {
    sec.style.display = 'none';
    return;
  }
  sec.style.display = 'block';
  $('mail-ttl').textContent = box.unread ? `메일 · 안 읽음 ${box.unread}` : '메일';
  $('mail-allread').style.display = box.unread ? '' : 'none';
  const host = $('mail-rows');
  // 시트 목록도 틱마다 다시 지으면 마우스를 올려둔 줄이 깜빡인다 — 패널과 같은 규칙
  const sig = mailSig(box);
  if (sig === sheetSig && host.childElementCount) return;
  sheetSig = sig;
  host.textContent = '';
  // 계정 줄이 먼저, 폴더 줄이 그 아래
  const acts = accountStrip(box, () => renderMail(lastMailBox));
  if (acts) host.append(acts);
  // 폴더가 «메일» 하나뿐이면 줄을 안 그린다 — 규칙을 안 쓰는 사람에게는 없던 것과 같아야 한다
  if (foldersOf(box).length > 1) {
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

function mailSig(box) {
  if (!box) return 'none';
  const cur = currentFolder(box);
  const tabs = foldersOf(box)
    .map((f) => `${f.id}${f.name}${f.count}/${f.unread}${f.loading ? 'L' : ''}${f.lazy ? 'Z' : ''}`)
    .join('|');
  const accs = (box.accounts || []).map((a) => `${a.id}${a.name}`).join('|');
  // 줄 하나하나가 그대로인지까지 본다 — 읽음이 바뀌면 색이 달라져야 한다
  const rows = ((cur && cur.items) || [])
    .map((m) => `${m.accountId}:${m.uid}:${m.seen ? 1 : 0}${m.byRule ? 'r' : ''}`)
    .join(',');
  return [mailAccount, mailFolder, box.unread, accs, tabs, rows].join('~');
}

function paintMailPanel() {
  const box = lastMailBox;
  const host = $('mp-list');
  // 머리글과 안내 줄은 언제나 새로 쓴다 — 글자만 바뀌므로 깜빡이지 않는다
  $('mp-ttl').textContent = box && box.unread ? `메일 · 안 읽음 ${box.unread}` : '메일';
  paintNote(box);
  $('mp-allread').style.display = box && box.unread ? '' : 'none';

  // 목록이 그대로면 손대지 않는다. 손대는 순간 마우스가 올라간 줄이 깜빡인다.
  const sig = mailSig(box);
  if (sig === paintedSig && host.childElementCount) return;
  paintedSig = sig;

  host.textContent = '';
  const folders = (box && box.folders) || [];
  const cur = currentFolder(box);
  if (!folders.length) {
    const p = document.createElement('div');
    p.className = 'calempty';
    p.textContent = box ? '새 메일 없음' : '설정에서 메일을 연결하세요';
    host.append(p);
    // 여기서 그냥 돌아가면 직전 폴더에 묶인 스크롤 처리기가 그대로 살아 있는다.
    // 폴더가 사라졌는데도 그 폴더로 «더 보기»를 부르게 된다.
    hookMore(host, null);
    return;
  }
  // 계정 줄이 먼저, 폴더 줄이 그 아래
  const acts = accountStrip(box, () => { paintMailPanel(); resizeForMail(); });
  if (acts) host.append(acts);
  // 폴더가 «메일» 하나뿐이면 줄을 안 그린다 — 규칙을 안 쓰면 없던 것과 같아야 한다
  if (foldersOf(box).length > 1) {
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
  // 폴더를 옮겼으면 목록을 맨 위로 돌린다.
  // 내려둔 자리를 물려주면 «보낸메일함 탭을 눌렀을 뿐인데 이미 바닥»이 되어,
  // 손도 안 댔는데 이전 메일을 불러온다 (실제로 그랬다).
  if (cur && cur.id !== paintedFolder) {
    paintedFolder = cur.id;
    host.scrollTop = 0;
    pulled.set(cur.id, 0);
  }
  // 끝까지 내려가면 이전 메일을 더 불러온다
  hookMore(host, cur && cur.id);
}

// 보여줄 개수에 상한이 없으므로, 목록이 길다고 위젯이 화면 끝까지 자라면 안 된다.
// 여기까지만 늘리고 나머지는 목록 안에서 굴린다.

const MAIL_PANEL_MAX = 300;

function resizeForMail() {
  const on = nw.card.classList.contains('mailon');
  requestAnimationFrame(() => {
    const needed = on ? Math.min(MAIL_PANEL_MAX, Math.ceil($('mailpanel').scrollHeight)) : 0;
    window.nunsseom.calPanel({ on, needed, which: 'mail', pinned: nw.pinnedAny() });
  });
}

/**
 * 칸 사이를 끌어 세로 길이를 바꾼다.
 *
 * 창 높이는 그대로 두고 «나누는 비율»만 바꾼다 — 끌 때마다 창까지 자라면
 * 화면을 잡아먹는다. 늘어난 만큼은 달력이 내주고, 달력이 최소에 닿으면 거기서 멈춘다.
 *
 * 한 번이라도 직접 조절하면 자동 맞춤은 멈춘다. 안 그러면 달력을 다시 그릴 때마다
 * «내용에 맞춘 높이»로 창이 되돌아가, 방금 넓혀 둔 메일 칸이 도로 좁아진다.
 * 두 번 누르면 그 칸만 다시 «알아서»로 돌아간다.
 */

function toggleMail(force) {
  const on = force !== undefined ? force : !nw.card.classList.contains('mailon');
  nw.card.classList.toggle('mailon', on);
  nw.card.classList.remove('open');
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
    rearmMore();
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
if (nw.params.get('mailpanel') === '1') {
  nw.card.classList.add('mailon');
  setTimeout(resizeForMail, 300);
}
// ── 주식 — 별도 창으로 연다 ──────────────────────────────
// 위젯 안에 패널로 두면 늘 눈앞에 값이 떠 있게 된다. 이 앱은 «끊고 쉬게 하는» 앱이라
// 그건 취지와 반대다. 볼 때만 열어 보게 창으로 뺐다.
$('btn-stock').append(window.nunsIcon('chart'));
$('btn-stock').onclick = () => window.nunsseom.stocksOpen();
$('btn-stock').style.display = 'none';   // 설정에서 켜야 나온다

$('cal-prev').onclick = (e) => { e.stopPropagation(); window.nunsWCal.shift(-1); };
$('cal-next').onclick = (e) => { e.stopPropagation(); window.nunsWCal.shift(1); };
$('cal-week').onclick = (e) => { e.stopPropagation(); window.nunsWCal.setMode('week'); };
$('cal-month').onclick = (e) => { e.stopPropagation(); window.nunsWCal.setMode('month'); };
// 달력 안을 눌러도 카드 이동/시트 토글로 새지 않게
window.nunsWCal.calEl.addEventListener('pointerdown', (e) => e.stopPropagation());
window.nunsseom.onCalChanged?.(() => { if (nw.card.classList.contains('calon')) window.nunsWCal.loadCal(); });
window.nunsseom.onCalShow?.(() => window.nunsWCal.toggleCal(true));
// 새 메일 알림을 눌러 들어온 경우 — 메일 패널을 펴서 바로 보이게
window.nunsseom.onMailShow?.(() => toggleMail(true));
$('btn-hide').onclick = () => window.nunsseom.hideWidget();

// ── 카드: 클릭하면 예정된 알림 시트, 끌면 창 이동 ──
// app-region: drag는 OS가 마우스 이벤트를 가져가 클릭을 못 받으므로 직접 구현한다.

// widget.js 가 부르는 것
window.nunsWMail = { renderMail };
})();

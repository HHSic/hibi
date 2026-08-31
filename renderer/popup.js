'use strict';
/**
 * 물어보는 창과 오른쪽 클릭 메뉴 — 앱과 같은 마감으로 그린다.
 *
 * 지금까지 이 둘만 윈도우 기본 UI였다. 나머지가 다 유리 마감인데 여기서만
 * 회색 상자가 튀어나오면 그 순간 «다른 앱»처럼 보인다.
 *
 * 이 창은 내용을 다 그린 뒤 «나는 이만한 크기가 필요하다»를 메인에 알린다.
 * 메인이 그만큼 창을 잡아주므로, 글이 길어지든 메뉴가 늘든 잘리지 않는다.
 */
const card = document.getElementById('card');
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') document.documentElement.dataset.theme = 'light';
if (q.get('scrim')) document.documentElement.style.setProperty('--scrim-a', q.get('scrim'));
if (q.get('inset')) document.documentElement.style.setProperty('--inset', q.get('inset') + 'px');

let answered = false;
/** 한 번만 답한다 — 엔터와 클릭이 겹쳐 두 번 가면 안 된다 */
function answer(value) {
  if (answered) return;
  answered = true;
  window.nunsseom.popupPick(value);
}

// 창 밖을 누르거나 Esc — «그만두기»와 같다.
// 메뉴는 아무것도 안 고른 것, 물어보는 창은 취소 단추를 누른 것으로 친다.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); answer(null); }
});

/**
 * 그린 뒤 실제로 필요한 크기를 알려준다 (그림자 여백 포함).
 *
 * 카드가 아니라 그 «안»을 재야 한다 — 카드는 height:100%라 언제나 창과 같은 크기다.
 * 그걸 재면 «지금 창 크기가 필요하다»는 동어반복이 되어 크기가 영영 안 맞는다.
 *
 * 물어보는 창은 폭을 먼저 못박고 높이만 잰다. 글은 폭에 따라 줄 수가 달라지므로,
 * 최종 폭으로 놓고 재지 않으면 잰 높이가 맞지 않는다.
 */
const DIALOG_W = 360;
function reportSize(kind) {
  const inset = parseFloat(q.get('inset') || '12');
  const want = kind === 'menu' ? 0 : DIALOG_W;
  // 아직 안 보이는 창이라 잠깐 넓혀 놓고 재도 사용자 눈에는 안 띈다
  if (want) document.body.style.width = want + 'px';
  requestAnimationFrame(() => {
    const inner = card.firstElementChild;
    const w = want || Math.ceil(inner.scrollWidth);
    const h = Math.ceil(inner.scrollHeight);
    document.body.style.width = '';
    window.nunsseom.popupSize({ width: w + (want ? 0 : inset * 2), height: h + inset * 2 });
  });
}

function drawDialog(d) {
  document.documentElement.style.setProperty('--r', '16px');
  const box = document.createElement('div');
  box.className = 'dlg';

  if (d.title) {
    const t = document.createElement('div');
    t.className = 'ttl';
    t.textContent = d.title;
    box.append(t);
  }
  const m = document.createElement('div');
  m.className = 'msg';
  m.textContent = d.message || '';
  box.append(m);
  if (d.detail) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = d.detail;
    box.append(s);
  }

  const row = document.createElement('div');
  row.className = 'row';
  // 버튼 순서는 부르는 쪽이 준 그대로다 — 답도 그 자리 번호로 돌려준다.
  // 화면에서는 «하기»가 오른쪽 끝에 오도록 뒤집어 그린다 (윈도우 관행).
  const list = (d.buttons || ['확인']).map((label, i) => ({ label, i }));
  for (const b of [...list].reverse()) {
    const btn = document.createElement('button');
    btn.className = 'btn'
      + (b.i === (d.defaultId ?? 0) ? (d.danger ? ' bad' : ' go') : '');
    btn.textContent = b.label;
    btn.onclick = () => answer(b.i);
    row.append(btn);
  }
  box.append(row);
  card.append(box);

  // 기본 단추에 초점을 둔다 — 엔터로 바로 답할 수 있게
  requestAnimationFrame(() => {
    const go = card.querySelector('.btn.go, .btn.bad') || card.querySelector('.btn');
    if (go) go.focus();
  });
  reportSize('dialog');
}

function drawMenu(d) {
  document.documentElement.style.setProperty('--r', '12px');
  const box = document.createElement('div');
  box.className = 'menu';
  for (const it of d.items || []) {
    if (it.type === 'separator') {
      const s = document.createElement('div');
      s.className = 'sep';
      box.append(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'item' + (it.danger ? ' bad' : '') + (it.enabled === false ? ' off' : '');
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    if (it.enabled === false) b.disabled = true;
    else b.onclick = () => answer(it.id);
    box.append(b);
  }
  card.append(box);
  reportSize('menu');
}

window.nunsseom.popupData().then((d) => {
  if (!d) { answer(null); return; }
  if (d.kind === 'menu') drawMenu(d);
  else drawDialog(d);
});

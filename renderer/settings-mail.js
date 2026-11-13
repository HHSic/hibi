// 설정 창 — 메일 탭.
//
// settings.js 가 1,652줄이라 읽기 어려워져 메일 계통(계정·서명·필터·주소록·백업)만
// 갈라냈다. 렌더러에는 번들러가 없으므로 icons.js·enter.js 처럼 <script> 하나를 더 읽고
// window 에 이름을 하나 내주는 방식으로 잇는다.
//
// 공유하는 것은 settings.js 가 주인이다 — 여기서는 nunsSet 을 거쳐 빌려 쓴다.
// data 는 «지금 값»을 봐야 하므로 getter 로 받는다 (복사하면 갱신을 못 본다).

// 일반 <script> 는 전역을 나눠 쓴다 — settings.js 도 $ 를 선언하므로, 감싸지 않으면
// «Identifier '$' has already been declared» 로 이 파일이 통째로 파싱 실패한다.
// (실제로 그랬다: 메일 탭이 아무것도 안 그려졌다.) pickfield.js 와 같은 방식으로 가둔다.
(() => {
'use strict';

const nunsSet = window.nunsSet;
const $ = (id) => document.getElementById(id);

// ── 메일 ─────────────────────────────────────────
let mailData = { accounts: [], presets: [], status: {} };
let mailPreset = null;

function renderMailPresets() {
  const host = $('mail-presets');
  host.textContent = '';
  for (const p of mailData.presets) {
    const b = document.createElement('button');
    b.className = 'mini' + (mailPreset && mailPreset.id === p.id ? '' : ' ghost');
    b.textContent = p.name;
    b.onclick = () => {
      mailPreset = p;
      if (p.host) $('mail-host').value = p.host;
      $('mail-port').value = String(p.port || 993);
      if (p.smtpHost) $('mail-smtp-host').value = p.smtpHost;
      $('mail-smtp-port').value = String(p.smtpPort || 465);
      $('mail-note').textContent = p.note || '';
      renderMailPresets();
    };
    host.append(b);
  }
  // 앱 비밀번호 받으러 가는 링크
  if (mailPreset && mailPreset.help) {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = '비밀번호 발급 페이지 열기';
    b.onclick = () => window.nunsseom.openUrl(mailPreset.help);
    host.append(b);
  }
  // IMAP을 켜러 가는 링크 — 비밀번호를 제대로 넣어도 이걸 안 켜면 안 된다.
  // 두 곳을 다녀와야 하는 곳(네이버)에서 한 곳만 알려주면 나머지 반을 혼자 찾아야 한다.
  if (mailPreset && mailPreset.setup) {
    const b = document.createElement('button');
    b.className = 'mini ghost';
    b.textContent = '메일 환경설정 열기';
    b.onclick = () => window.nunsseom.openUrl(mailPreset.setup);
    host.append(b);
  }
}

function renderMailModes() {
  const host = $('mail-mode');
  host.textContent = '';
  const modes = [
    { id: 'batch', name: '모아서', hint: '정해진 시각(10·14·17시)에만 모아서 알립니다.' },
    { id: 'instant', name: '바로', hint: '새 메일이 오면 곧바로 알립니다.' }
  ];
  const cur = nunsSet.data.settings.mailMode || 'batch';
  for (const m of modes) {
    const b = document.createElement('button');
    b.className = 'mini' + (cur === m.id ? '' : ' ghost');
    b.textContent = m.name;
    b.onclick = () => {
      nunsSet.data.settings.mailMode = m.id;
      window.nunsseom.setApp({ mailMode: m.id });
      renderMailModes();
    };
    host.append(b);
  }
  const sel = modes.find((m) => m.id === cur);
  $('mail-mode-hint').textContent = sel ? sel.hint : '';
}

function renderMailScope() {
  const host = $('mail-scope');
  host.textContent = '';
  const opts = [
    { unread: false, name: '최근 온 메일', hint: '읽음과 상관없이 최근 메일을 보여줍니다.' },
    { unread: true, name: '안 읽은 것만', hint: '안 읽은 메일만 보여줍니다.' }
  ];
  const cur = nunsSet.data.settings.mailOnlyUnread === true;
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'mini' + (cur === o.unread ? '' : ' ghost');
    b.textContent = o.name;
    b.onclick = () => {
      nunsSet.data.settings.mailOnlyUnread = o.unread;
      window.nunsseom.setApp({ mailOnlyUnread: o.unread });
      window.nunsseom.mailRefresh();
      renderMailScope();
    };
    host.append(b);
  }
  const sel = opts.find((o) => o.unread === cur);
  $('mail-scope-hint').textContent = sel ? sel.hint : '';
}

/**
 * 켜고 끄거나 지운 뒤 «쓸 수 있는 계정이 없다»는 말을 새로 받는다.
 * 계정 목록만 돌려받으면 위쪽 안내가 옛 판단을 들고 있게 된다 (다 끈 뒤에도 안 뜨거나, 켠 뒤에도 남거나).
 */
async function syncMailStatus() {
  try {
    const d = await window.nunsseom.mailGet();
    if (d && d.status) mailData.status = d.status;
  } catch { /* 안내 한 줄이 늦을 뿐이다 — 목록은 이미 새것이다 */ }
}

// 계정 id → 고치는 줄. 계정 목록은 켜고 끄기·지우기·서명 저장·추가 때마다 통째로 다시 그려진다.
// 고치는 줄까지 그때마다 새로 만들면, 느린 서버를 1분 넘게 기다리는 도중에 칸이 접히고 다시 쓸 수 있게 돼
// 같은 계정으로 두 번 보내게 됐고, 먼저 보낸 것의 결과는 떨어져 나간 줄에 적혀 끝내 안 보였다.
// 만든 줄을 그대로 다시 붙이면 입력·기다림·결과가 그 자리에 남는다.
const fixLines = new Map();
// 비밀번호 다시 넣기가 도는 계정 id — 그동안 그 계정의 «삭제»를 막는다 (비밀번호는 담지 않는다)
const repassBusy = new Set();

/** 목록에서 그 계정의 줄 — 다시 그려졌을 수 있으니 붙들고 있지 말고 그때그때 찾는다 */
function acctRow(id) {
  return [...$('mail-accounts').querySelectorAll('.rem.acct')].find((r) => r.dataset.id === id) || null;
}

/** 목록 맨 위 안내 — 한 번 만들어 다시 그려도 그대로 쓴다.
 *  글이 이미 든 채로 새로 끼워진 알림 자리는 화면 읽기 프로그램이 못 읽고 넘어가는 일이 흔하다. */
let acctNote = null;
function noteEl() {
  if (!acctNote) {
    acctNote = document.createElement('div');
    acctNote.className = 'msg acct-note';
    acctNote.id = 'mail-acct-msg';
    acctNote.setAttribute('role', 'status');
    acctNote.setAttribute('aria-live', 'polite');
    // 성공한 뒤 옮겨 갈 줄이 없으면 초점이 여기로 온다
    acctNote.tabIndex = -1;
  }
  return acctNote;
}

function setNote(kind, text) {
  const note = noteEl();
  if (!text) { note.className = 'msg acct-note'; note.textContent = ''; return; }
  // 같은 말을 다시 쓰면 화면 읽기 프로그램이 또 읽는다 — 다시 그릴 때마다 되풀이되지 않게 바뀔 때만 쓴다
  if (note.textContent === text && note.classList.contains(kind) && note.classList.contains('show')) return;
  mailMsg(kind, text, note);
}

/** 고치는 줄을 버린다 — 넣다 만 비밀번호를 떨어져 나간 칸에 남기지 않는다 */
function dropFix(id) {
  const input = fixLines.get(id)?.querySelector('input');
  if (input) input.value = '';
  fixLines.delete(id);
}

/** 다시 그려도 두는 고치는 줄 — 까닭이 바뀌었으면 새로 만든다 (도는 중이면 그대로: 끝나면 결과가 다시 그린다) */
function fixLineOf(a) {
  const key = [a.problem, a.canRepass ? 1 : 0, a.problemHint || '', a.name || ''].join('|');
  const old = fixLines.get(a.id);
  if (old && (old.dataset.key === key || repassBusy.has(a.id))) return old;
  if (old) dropFix(a.id);
  const box = fixLine(a);
  box.dataset.key = key;
  fixLines.set(a.id, box);
  return box;
}

/**
 * 못 쓰는 계정 아래에 붙는 «고치는 줄» — 무엇이 문제인지와 고치는 길을 한곳에.
 *
 * 비밀번호가 이 PC에서 안 풀리면 예전에는 지우고 다시 넣는 수밖에 없었고,
 * 그러면 서명과 계정에 매인 것이 같이 사라졌다. 여기서 비밀번호만 다시 넣는다.
 * 단추를 계정 줄에 하나 더 넣으면 좁은 설정 창에서 이름 칸이 짓눌려 한 줄 아래로 뺐다.
 */
function fixLine(a) {
  const box = document.createElement('div');
  box.className = 'acct-fix';
  const top = document.createElement('div');
  top.className = 'upline';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = a.problemHint || '';
  top.append(hint);
  box.append(top);
  if (!a.canRepass) return box;

  const formId = `repass-${a.id}`;
  const open = document.createElement('button');
  open.className = 'mini ghost';
  open.textContent = '비밀번호 다시 넣기';
  open.setAttribute('aria-expanded', 'false');
  open.setAttribute('aria-controls', formId);
  top.append(open);

  const form = document.createElement('div');
  form.className = 'repass';
  form.id = formId;
  form.hidden = true;
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'cust-name';
  input.placeholder = '앱 비밀번호';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `${a.name} 비밀번호`);
  const save = document.createElement('button');
  save.className = 'mini';
  save.textContent = '저장';
  const cancel = document.createElement('button');
  cancel.className = 'mini ghost';
  cancel.textContent = '취소';
  form.append(input, save, cancel);
  // 진행·결과는 이 줄 바로 아래에 — 아래쪽 «추가» 칸의 안내 자리는 여기서 안 보인다
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.setAttribute('role', 'status');
  msg.setAttribute('aria-live', 'polite');
  box.append(form, msg);

  const show = (on) => {
    form.hidden = !on;
    open.hidden = on;
    open.setAttribute('aria-expanded', String(on));
    if (on) { input.focus(); return; }
    // 닫을 때 비밀번호를 칸에 남기지 않는다
    input.value = '';
    msg.className = 'msg';
    msg.textContent = '';
    open.focus();
  };
  const busy = (on) => {
    if (on) repassBusy.add(a.id); else repassBusy.delete(a.id);
    input.disabled = on; save.disabled = on; cancel.disabled = on;
    // 확인하는 동안 계정을 지우면 결과가 갈 곳이 없다 — 그 줄의 «삭제»도 같이 막는다
    const del = acctRow(a.id)?.querySelector('.mini');
    if (del) del.disabled = on;
  };

  const submit = async () => {
    if (save.disabled || repassBusy.has(a.id)) return;
    const pass = input.value;
    if (!pass) { mailMsg('bad', '비밀번호를 넣으세요', msg); input.focus(); return; }
    busy(true);
    mailMsg('wait', '연결 확인 중…', msg);
    let r = null;
    try {
      r = await window.nunsseom.mailRepass({ id: a.id, pass });
    } catch (e) {
      r = { ok: false, message: (e && e.message) || '저장하지 못했습니다' };
    }
    busy(false);
    if (r && r.ok) {
      input.value = '';
      // 고쳐졌으니 이 줄은 버린다 — 다시 그릴 때 새 모양(문제 없음)으로 나온다
      dropFix(a.id);
      if (Array.isArray(r.accounts)) mailData.accounts = r.accounts;
      if (r.status) mailData.status = r.status;
      renderMailAccounts();
      loadBackup().catch(() => {});   // 계정을 쓸 수 있게 되면 메인이 폴더와 자동 저장을 맞춘다 (계정 추가와 같다)
      // 다시 그리면 이 줄은 사라진다 — 결과는 목록 맨 위에 남긴다 (다시 그린 «뒤에» 써야 지워지지 않는다).
      // 파일에 못 적었으면 이번 실행에서만 되는 것이라 빨강으로
      setNote(r.saved === false ? 'bad' : 'good', r.message || '비밀번호를 다시 저장했습니다');
      // 초점이 있던 칸이 사라져 body 로 떨어진다 — 고친 계정의 스위치로, 없으면 안내 줄로 옮긴다
      if (!document.activeElement || document.activeElement === document.body) {
        (acctRow(a.id)?.querySelector('.sw') || noteEl()).focus();
      }
      return;
    }
    // 기다리는 동안 계정이 꺼졌거나 지워져 이 줄이 목록에서 빠졌다 — 넣어 둔 비밀번호를 남기지 않고 버린다
    if (!box.isConnected) {
      input.value = '';
      if (fixLines.get(a.id) === box) fixLines.delete(a.id);
      return;
    }
    mailMsg('bad', (r && r.message) || '저장하지 못했습니다', msg);
    // 기다리는 동안 다른 곳에서 쓰고 있었으면 초점을 빼앗지 않는다 (칸이 막혀 있던 동안 초점은 body 로 갔다)
    const here = document.activeElement;
    if (!here || here === document.body || box.contains(here)) {
      input.select();
      input.focus();
    }
  };

  open.onclick = () => show(true);
  save.onclick = submit;
  cancel.onclick = () => show(false);
  input.addEventListener('keydown', (e) => {
    // 한글 입력을 끝내는 Enter 는 «저장»이 아니다
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  // Esc 는 칸 전체에서 받는다 — 입력칸에만 달면 Tab 으로 «저장»·«취소»에 간 뒤의 Esc 가
  // 창 전체의 Esc(설정 닫기)까지 올라가 설정 창이 통째로 닫혔다. 입력만 접는다
  form.addEventListener('keydown', (e) => {
    if (e.isComposing || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (!cancel.disabled) show(false);
  });
  return box;
}

function renderMailAccounts() {
  const host = $('mail-accounts');
  // 고치는 줄 안에 초점이 있었으면(다른 계정을 고치던 중) 다시 붙인 뒤 되돌린다 — 떼는 순간 body 로 떨어진다
  const had = document.activeElement;
  const refocus = had && [...fixLines.values()].some((b) => b.contains(had)) ? had : null;
  const note = noteEl();
  // 안내 자리는 남기고 나머지만 지운다
  for (const el of [...host.children]) if (el !== note) el.remove();
  if (note.parentNode !== host) host.prepend(note);
  if (!mailData.accounts.length) {
    setNote('', '');
    for (const id of [...fixLines.keys()]) if (!repassBusy.has(id)) dropFix(id);
    const p = document.createElement('div');
    p.className = 'col';
    p.innerHTML = '';
    const t = document.createElement('span');
    t.className = 'lbl';
    t.textContent = mailData.status.canStore
      ? '아직 없습니다. 아래에서 계정을 추가하세요.'
      : '이 PC에서는 비밀번호를 안전하게 저장할 수 없어 메일을 쓸 수 없습니다.';
    p.append(t);
    host.append(p);
    return;
  }
  // 목록 맨 위 안내 — 쓸 수 있는 계정이 하나도 없으면 왜 없는지와 무엇을 할지를 먼저 말한다.
  // 말은 메인이 정한다(위젯 알림·기록과 같은 말). 계정마다 까닭이 있을 때만 믿는다 — 옛 판단이 남지 않게.
  const blocked = mailData.accounts.every((a) => a.problem) ? (mailData.status.blocked || '') : '';
  setNote(blocked ? 'bad' : '', blocked);

  const shown = new Set();
  for (const a of mailData.accounts) {
    // 꺼진 계정은 예전 모습 그대로 — 스위치가 이미 말한다
    const need = !!a.problem && a.problem !== 'off';
    const row = document.createElement('div');
    row.className = 'rem acct' + (a.enabled === false ? ' off' : '') + (need ? ' need' : '');
    row.dataset.id = a.id;
    const g = document.createElement('span');
    g.className = 'g';
    g.append(window.nunsIcon('mail'));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = a.name;
    const sub = document.createElement('small');
    sub.textContent = `${a.host}:${a.port}`;
    // 좁은 창에서는 주소가 …으로 줄어든다 — 전체는 올려 보면 나온다
    sub.title = sub.textContent;
    nm.append(sub);
    const val = document.createElement('span');
    val.className = 'val';
    const err = (mailData.status.errors || []).find((e) => e.name === a.name);
    // 못 쓰는 까닭이 먼저다 — 접속 오류는 접속을 해 봤을 때의 이야기다
    val.textContent = need ? (a.problemText || '') : err ? err.message.slice(0, 24) : '';
    if (need) val.title = a.problemHint || '';
    // 오류는 회색 설명과 섞이지 않게 빨강으로 (settings.html .rem .val.bad)
    if (need || err) val.classList.add('bad');
    const sw = document.createElement('button');
    sw.className = 'sw' + (a.enabled === false ? '' : ' on');
    sw.setAttribute('aria-label', `${a.name} ${a.enabled === false ? '켜기' : '끄기'}`);
    sw.onclick = async () => {
      mailData.accounts = await window.nunsseom.mailUpdate(a.id, { enabled: a.enabled === false });
      await syncMailStatus();
      renderMailAccounts();
      // 다시 켠 계정은 메인이 자동 전달의 «지금부터»를 새로 잡는다 — 계정 단추도 새 모양으로
      loadFwd();
      loadBackup().catch(() => {});   // 지난 메일 줄도 그 계정을 따라간다
    };
    const del = document.createElement('button');
    del.className = 'mini ghost';
    del.textContent = '삭제';
    // 비밀번호를 확인하는 중에는 못 지운다 — 끝나면 풀린다
    del.disabled = repassBusy.has(a.id);
    del.onclick = async () => {
      mailData.accounts = await window.nunsseom.mailRemove(a.id);
      await syncMailStatus();
      renderMailAccounts();
      // 지운 계정은 자동 전달에서도 빠진다 (마지막 계정이면 메인이 끈다)
      loadFwd();
    };
    row.append(g, nm, val, sw, del);
    host.append(row);
    if (need) { host.append(fixLineOf(a)); shown.add(a.id); }
  }
  // 고쳐졌거나 지워진 계정의 줄은 버린다 — 도는 중인 것만 끝날 때까지 둔다
  for (const id of [...fixLines.keys()]) if (!shown.has(id) && !repassBusy.has(id)) dropFix(id);
  if (refocus && refocus.isConnected && document.activeElement !== refocus) refocus.focus();
}

async function loadMail() {
  mailData = await window.nunsseom.mailGet();
  if (!mailPreset) mailPreset = mailData.presets[0] || null;
  if (mailPreset) {
    if (mailPreset.host) $('mail-host').value = mailPreset.host;
    $('mail-port').value = String(mailPreset.port || 993);
    if (mailPreset.smtpHost) $('mail-smtp-host').value = mailPreset.smtpHost;
    $('mail-smtp-port').value = String(mailPreset.smtpPort || 465);
    $('mail-note').textContent = mailPreset.note || '';
  }
  renderMailPresets();
  renderMailScope();
  renderMailModes();
  renderMailAccounts();
  renderSigAccs();
  loadBook();
  loadRules();
  loadFwd();
}

/**
 * 안내 한 줄. 기본 자리는 «추가» 칸 아래(#mail-msg)이고, 계정 줄에서 고칠 때는 그 줄의 자리를 넘긴다.
 * 모양 이름(msg·acct-note)은 두고 상태(bad·good·wait)만 갈아 끼운다.
 */
function mailMsg(kind, text, el = $('mail-msg')) {
  if (!el) return;
  el.classList.remove('bad', 'good', 'wait');
  el.classList.add('show');
  if (kind) el.classList.add(kind);
  el.textContent = text;
}

function mailForm() {
  return {
    provider: mailPreset ? mailPreset.id : 'custom',
    name: mailPreset && mailPreset.id !== 'custom' ? mailPreset.name : $('mail-host').value.trim(),
    host: $('mail-host').value.trim(),
    port: Number($('mail-port').value) || 993,
    user: $('mail-user').value.trim(),
    pass: $('mail-pass').value,
    // 보내기 쪽은 비워둬도 된다 — 받는 서버에서 짐작한다
    smtpHost: $('mail-smtp-host').value.trim(),
    smtpPort: Number($('mail-smtp-port').value) || 0,
    fromAddress: $('mail-from').value.trim(),
    fromName: $('mail-from-name').value.trim()
  };
}

function mailFormOk(acc) {
  if (!acc.host) { mailMsg('bad', '서버 주소를 넣으세요'); return false; }
  if (!acc.user) { mailMsg('bad', '아이디를 넣으세요'); return false; }
  if (!acc.pass) { mailMsg('bad', '비밀번호를 넣으세요'); return false; }
  return true;
}

$('btn-mail-test').onclick = async () => {
  const acc = mailForm();
  if (!mailFormOk(acc)) return;
  mailMsg('wait', '연결 확인 중…');
  $('btn-mail-test').disabled = true;
  try {
    const r = await window.nunsseom.mailTest(acc);
    // 테스트는 확인만 한다. 여기서 끝난 줄 알고 떠나면 계정이 저장되지 않는다.
    mailMsg(r.ok ? 'good' : 'bad',
      r.ok ? `${r.message} — «추가»를 눌러 저장하세요` : r.message);
    $('btn-mail-add').classList.toggle('urge', r.ok);
  } finally {
    $('btn-mail-test').disabled = false;
  }
};

// ── 계정별 보내는 사람 · 서명 ─────────────────────
// 계정을 넣고 나면 고칠 방법이 없었다 — 서명은 물론 SMTP 주소도 못 바꿨다.
let sigId = null;

function renderSigAccs() {
  const host = $('sig-accs');
  host.textContent = '';
  if (!mailData.accounts.length) {
    host.textContent = '계정을 먼저 추가하세요';
    $('sig-edit').style.display = 'none';
    return;
  }
  if (!mailData.accounts.some((a) => a.id === sigId)) sigId = mailData.accounts[0].id;
  for (const a of mailData.accounts) {
    const b = document.createElement('button');
    b.className = 'mini' + (a.id === sigId ? '' : ' ghost');
    b.textContent = a.name || a.user;
    b.onclick = () => { sigId = a.id; renderSigAccs(); };
    host.append(b);
  }
  const a = mailData.accounts.find((x) => x.id === sigId);
  $('sig-edit').style.display = '';
  // 이미 등록된 계정이면 서버도 보내는 주소도 계정에서 나온다 — 다시 넣게 하지 않는다.
  // 무엇이 실제로 쓰이는지만 한 줄로 보여주고, 다를 때만 «고치기»로 연다.
  $('ed-summary').textContent =
    `보내는 서버 ${a.smtpResolved || '(없음)'}:${a.smtpPortResolved || 465}`
    + ` · 보내는 사람 ${a.fromResolved || '(설정 필요)'}`
    + (a.fromName ? ` (${a.fromName})` : '');
  $('ed-smtp-host').value = a.smtpHost || '';
  $('ed-smtp-host').placeholder = a.smtpResolved || 'smtp.example.com';
  $('ed-smtp-port').value = a.smtpPort ? String(a.smtpPort) : '';
  $('ed-smtp-port').placeholder = String(a.smtpPortResolved || 465);
  $('ed-from').value = a.fromAddress || '';
  $('ed-from').placeholder = a.fromResolved || '보내는 주소';
  $('ed-from-name').value = a.fromName || '';
  setSig(a.signature || '');
  $('ed-msg').textContent = '';
  // 보낼 주소를 못 찾는 계정은 접어두면 안 된다 — 그대로 두면 보내기가 안 된다
  const mustFix = !a.fromResolved || !a.smtpResolved;
  $('ed-server').style.display = mustFix ? '' : 'none';
  $('btn-ed-more').textContent = mustFix ? '접기' : '고치기';
}

function sigForm() {
  return {
    id: sigId,
    smtpHost: $('ed-smtp-host').value.trim(),
    smtpPort: Number($('ed-smtp-port').value) || 0,
    fromAddress: $('ed-from').value.trim(),
    fromName: $('ed-from-name').value.trim(),
    signature: getSig()
  };
}

/**
 * 붙여넣은 HTML에서 «실행되는 것»을 걷어낸다.
 * 붙여넣는 순간에 걸러야 해서 메인을 기다릴 수 없다 — 화면 안에 둔다.
 * 저장할 때 메인이 한 번 더 거른다(그쪽이 최종 판정이다).
 */
function cleanPasted(input) {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet)[\s\S]*?<\/>/gi, '')
    .replace(/<(link|meta|base)[^>]*>/gi, '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ')
    .replace(/(href|src|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'")
    .replace(/(href|src|xlink:href)\s*=\s*javascript:[^\s>]*/gi, '$1="#"');
}

// 서명은 서식이 있는 HTML이다. 웹메일에서 복사해 오면 색·표·그림이 그대로 따라온다.
// 소스를 직접 고치고 싶을 때를 위해 «HTML» 토글도 둔다 (웹메일에도 같은 게 있다).
function setSig(html) {
  const box = $('ed-sig');
  // 옛 서명은 그냥 글이었다 — 태그가 없으면 줄바꿈만 살려 넣는다
  const looksHtml = /<[a-z!/]/i.test(html);
  if (looksHtml) {
    box.innerHTML = cleanPasted(html);
  } else {
    box.textContent = '';
    String(html).split(String.fromCharCode(10)).forEach((line, i) => {
      if (i) box.append(document.createElement('br'));
      box.append(document.createTextNode(line));
    });
  }
  $('ed-sig-src').value = box.innerHTML;
  if (sigSrcOn()) toggleSigSrc(false);
}

/**
 * 지금 소스 보기인가 — 화면에서 그대로 읽는다.
 * 모듈 수준 let으로 두면 그걸 쓰는 함수가 선언 줄보다 먼저 불릴 때 통째로 터진다
 * (여기서 실제로 «Cannot access before initialization»으로 저장 버튼까지 죽었다).
 */
function sigSrcOn() {
  return $('ed-sig-src').style.display !== 'none';
}

function getSig() {
  return sigSrcOn() ? $('ed-sig-src').value : $('ed-sig').innerHTML;
}

function toggleSigSrc(on) {
  if (on) $('ed-sig-src').value = $('ed-sig').innerHTML;
  else $('ed-sig').innerHTML = cleanPasted($('ed-sig-src').value);
  $('ed-sig').style.display = on ? 'none' : '';
  $('ed-sig-src').style.display = on ? '' : 'none';
  $('btn-sig-src').classList.toggle('ghost', !on);
}
$('btn-sig-src').onclick = () => toggleSigSrc(!sigSrcOn());

// 붙여넣기는 서식을 살린다 — 서명은 «그대로 오는 것»이 전부다.
// 다만 스크립트 같은 건 걷어낸다 (웹메일에서 통째로 복사하면 딸려 온다).
$('ed-sig').addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const html = dt.getData('text/html');
  if (!html) return;                       // 글자만 붙여넣는 건 브라우저에 맡긴다
  e.preventDefault();
  document.execCommand('insertHTML', false, cleanPasted(html));
});

$('btn-ed-more').onclick = () => {
  const on = $('ed-server').style.display === 'none';
  $('ed-server').style.display = on ? '' : 'none';
  $('btn-ed-more').textContent = on ? '접기' : '고치기';
};

$('btn-ed-save').onclick = async () => {
  const p = sigForm();
  mailData.accounts = await window.nunsseom.mailUpdate(sigId, p);
  renderMailAccounts();
  renderSigAccs();
  // renderSigAccs가 안내를 지우므로 그 뒤에 적는다
  $('ed-msg').textContent = '저장했습니다';
  // 보내는 서버·주소를 바꾼 계정은 메인이 자동 전달에서 뺀다 — 계정 단추가 옛 모습으로 남지 않게
  loadFwd();
};
$('btn-ed-test').onclick = async () => {
  $('ed-msg').textContent = '확인 중…';
  const r = await window.nunsseom.mailSmtpTest(sigForm());
  $('ed-msg').textContent = r.message;
};

// ── 필터 ──────────────────────────────────────────
// 만들기는 위젯의 오른쪽 클릭이 주된 길이다. 여기는 «무엇이 걸려 있나»를 보고 끄고 지우는 곳.
let rulesData = { rules: [], actions: {}, filtered: 0, groups: [] };

function renderRules() {
  const sel = $('fl-action');
  if (!sel.options.length) {
    for (const [id, name] of Object.entries(rulesData.actions)) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = name;
      sel.append(o);
    }
  }
  const sum = $('fl-sum');
  const bits = [];
  if (rulesData.filtered) bits.push(`지금 ${rulesData.filtered}통 숨김`);
  for (const g of rulesData.groups) bits.push(`${g.name} ${g.count}통`);
  sum.textContent = bits.length
    ? bits.join(' · ')
    : '메일 목록에서 오른쪽 클릭하면 바로 규칙을 만듭니다.';

  const host = $('fl-list');
  host.textContent = '';
  if (!rulesData.rules.length) {
    const p = document.createElement('div');
    p.className = 'col';
    p.textContent = '아직 규칙이 없습니다';
    p.style.fontSize = '11.5px';
    p.style.color = 'var(--tertiary)';
    host.append(p);
    return;
  }
  const where = { from: '보낸사람', subject: '제목', any: '아무 데나' };
  for (const r of rulesData.rules) {
    const row = document.createElement('div');
    row.className = 'rem';
    const g = document.createElement('span');
    g.className = 'g emoji';
    g.textContent = r.action === 'spam' ? '🚫' : r.action === 'group' ? '📦' : '🧹';
    // 고칠 수 없는 값이므로 입력칸처럼 보이면 안 된다 — 눌러보고 «왜 안 써지지» 하게 된다.
    // 조건이 길어 잘리는 일이 없도록 동작은 아랫줄로 내린다 («*@stcdev....»만 보이면 쓸모없다)
    const nm = document.createElement('span');
    nm.className = 'nm flcond' + (r.on === false ? ' off' : '');
    const wh = document.createElement('span');
    wh.className = 'flwhere';
    wh.textContent = where[r.field] || r.field;
    const mt = document.createElement('span');
    mt.className = 'flmatch';
    mt.textContent = r.match;
    const sub = document.createElement('small');
    sub.textContent = (rulesData.actions[r.action] || r.action) + (r.label ? ` → ${r.label}` : '');
    nm.append(wh, mt, sub);
    // 지우기 전에 잠깐 꺼보고 확인할 수 있어야 한다 — 규칙은 잘못 만들기 쉽다
    const off = document.createElement('button');
    off.className = 'mini ghost';
    off.textContent = r.on === false ? '켜기' : '끄기';
    off.onclick = async () => {
      rulesData = await window.nunsseom.mailRuleUpdate(r.id, { on: r.on === false });
      renderRules();
    };
    const del = document.createElement('button');
    del.className = 'mini ghost';
    del.textContent = '삭제';
    del.onclick = async () => {
      rulesData = await window.nunsseom.mailRuleRemove(r.id);
      renderRules();
    };
    row.append(g, nm, off, del);
    host.append(row);
  }
}

$('btn-fl-add').onclick = async () => {
  const match = $('fl-match').value.trim();
  if (!match) { $('fl-match').focus(); return; }
  rulesData = await window.nunsseom.mailRuleAdd({
    field: $('fl-field').value,
    match,
    action: $('fl-action').value,
    label: $('fl-label').value.trim()
  });
  $('fl-match').value = '';
  $('fl-label').value = '';
  renderRules();
};

async function loadRules() {
  rulesData = await window.nunsseom.mailRules();
  renderRules();
}

// ── 주소록 ────────────────────────────────────────
let book = [];

function renderBook() {
  const host = $('cb-list');
  const q = $('cb-find').value.trim().toLowerCase();
  const hits = book
    .filter((c) => !q || c.address.includes(q) || String(c.name || '').toLowerCase().includes(q))
    .slice(0, 60);
  host.textContent = '';
  if (!hits.length) {
    const p = document.createElement('div');
    p.className = 'col';
    p.textContent = book.length ? '찾는 사람이 없습니다' : '주소록이 비어 있습니다';
    p.style.fontSize = '11.5px';
    p.style.color = 'var(--tertiary)';
    host.append(p);
    return;
  }
  for (const c of hits) {
    const row = document.createElement('div');
    row.className = 'rem acct';
    const g = document.createElement('span');
    g.className = 'g emoji';
    g.textContent = '📇';
    const nm = document.createElement('input');
    nm.className = 'cust-name';
    nm.value = c.name || '';
    nm.placeholder = '이름';
    // 이름을 여기서 고쳐두면 쓸 때 그 이름으로 찾힌다
    nm.onchange = async () => {
      book = await window.nunsseom.mailContactSave({ address: c.address, name: nm.value.trim() });
    };
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = c.address;
    // 좁은 창에서는 주소가 …으로 잘린다. 잘린 것을 확인할 길은 남겨둔다.
    val.title = c.address;
    const del = document.createElement('button');
    del.className = 'mini ghost';
    del.textContent = '삭제';
    del.title = `${c.address} 지우기`;
    del.onclick = async () => { book = await window.nunsseom.mailContactRemove(c.address); renderBook(); };
    row.append(g, nm, val, del);
    host.append(row);
  }
}

$('cb-find').oninput = renderBook;
$('btn-cb-add').onclick = async () => {
  const addr = $('cb-addr').value.trim();
  if (!addr.includes('@')) { $('cb-addr').focus(); return; }
  book = await window.nunsseom.mailContactSave({ address: addr, name: $('cb-name').value.trim() });
  $('cb-name').value = '';
  $('cb-addr').value = '';
  renderBook();
};

async function loadBook() {
  book = await window.nunsseom.mailContacts();
  renderBook();
}

/** 파일로 주고받기 — 결과를 반드시 말해준다. 조용히 끝나면 «된 건가»가 된다. */
function bookMsg(kind, text) {
  const el = $('cb-msg');
  el.textContent = text || '';
  // --sun 은 이 창에 정의가 없어 라이트에서도 다크용 분홍(#ff8f8f, 1.9:1)이 나왔다
  el.style.color = kind === 'bad' ? 'var(--danger)'
    : kind === 'good' ? 'var(--accent)' : 'var(--tertiary)';
}

$('btn-cb-import').onclick = async () => {
  bookMsg('', '불러오는 중…');
  $('btn-cb-import').disabled = true;
  try {
    const r = await window.nunsseom.mailContactsImport();
    if (r && r.canceled) { bookMsg('', ''); return; }
    if (r && r.contacts) { book = r.contacts; renderBook(); }
    bookMsg(r && r.ok ? 'good' : 'bad', (r && r.message) || '불러오지 못했습니다');
  } finally {
    $('btn-cb-import').disabled = false;
  }
};

$('btn-cb-export').onclick = async () => {
  bookMsg('', '저장하는 중…');
  $('btn-cb-export').disabled = true;
  try {
    const r = await window.nunsseom.mailContactsExport();
    if (r && r.canceled) { bookMsg('', ''); return; }
    bookMsg(r && r.ok ? 'good' : 'bad', (r && r.message) || '저장하지 못했습니다');
  } finally {
    $('btn-cb-export').disabled = false;
  }
};

// 보내기는 받기와 서버가 달라 따로 확인해야 한다. 메일을 보내지는 않고 로그인만 해 본다.
$('btn-smtp-test').onclick = async () => {
  const acc = mailForm();
  if (!mailFormOk(acc)) return;
  mailMsg('wait', '보내기 서버 확인 중…');
  $('btn-smtp-test').disabled = true;
  try {
    const r = await window.nunsseom.mailSmtpTest(acc);
    mailMsg(r.ok ? 'good' : 'bad', r.message);
  } finally {
    $('btn-smtp-test').disabled = false;
  }
};

$('btn-mail-add').onclick = async () => {
  const acc = mailForm();
  if (!mailFormOk(acc)) return;
  mailMsg('wait', '연결 확인 중…');
  $('btn-mail-add').disabled = true;
  try {
    const r = await window.nunsseom.mailAdd(acc);
    mailMsg(r.ok ? 'good' : 'bad', r.ok ? `${r.message} · 메일 확인을 켰습니다` : r.message);
    if (r.ok) {
      mailData.accounts = r.accounts;
      if (r.settings) { nunsSet.data.settings = r.settings; nunsSet.bindSwitch('mailEnabled'); }
      $('mail-user').value = '';
      $('mail-pass').value = '';
      renderMailAccounts();
      // 새 계정은 자동 전달의 «보낼 계정» 단추에도 나와야 한다 (켜진 채라면 고르지 않은 채로)
      loadFwd();
      // 메인이 방금 폴더를 잡고 자동 저장을 켰다 — auto:false 때는 폴링이 없어 다시 안 읽으면 «아직 정하지 않았습니다»에 멈춘다
      loadBackup().catch(() => {});
    }
  } finally {
    $('btn-mail-add').disabled = false;
  }
};

// ── 메일 백업 ────────────────────────────────────
// 몇 시간 걸릴 수도 있는 작업이라, 열려 있는 동안만 상태를 물어본다.
let backupTimer = null;
// 폴더 고르기 부탁이 아직 안 돌아왔다 (묻는 창·옮기기) — 그동안은 상태를 자주 읽는다
let backupPicking = false;

/** "몇 분 전" — 자동 백업이 살아 있다는 걸 보여주는 게 목적이라 대충이면 된다 */
function agoText(at) {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

function paintAuto(st) {
  const el = $('backup-auto');
  // 지난 메일 칸과 «백업 시작»은 메일 확인이 꺼지면 안 보인다 — 어디로 갔는지 여기서 말한다
  if (!st.auto) {
    el.textContent = '메일 확인을 켜면 새 메일과 열어 본 메일을 저장하고, 지난 메일도 받을 수 있습니다.';
    return;
  }
  if (!st.dir) {
    el.textContent = '저장할 폴더를 먼저 고르세요.';
    return;
  }
  // 폴링이 없으면 새 메일이 온 것도 모른다 — «도는 중»이라고 말하면 거짓말이 된다.
  // 메인의 값을 본다. 창을 열 때 받은 설정은 스위치를 켜고 꺼도 안 바뀌어 거꾸로 말하게 된다 (옛 메인이면 그 값뿐이다)
  const checking = st.mailEnabled === undefined ? nunsSet.data.settings.mailEnabled : st.mailEnabled;
  if (!checking) {
    el.textContent = '«메일 확인하기»가 꺼져 있어 자동 저장하지 못합니다. 켜면 지난 메일도 받을 수 있습니다.';
    return;
  }
  if (st.autoError) {
    el.textContent = `자동 백업 실패 — ${st.autoError}`;
    return;
  }
  if (!st.autoAt) {
    el.textContent = '새 메일과 열어 본 메일을 저장합니다.';
    return;
  }
  el.textContent = `자동 저장 중 · ${agoText(st.autoAt)} ${st.autoSaved}통`
    + (st.autoTotal ? ` · 켠 뒤 모두 ${st.autoTotal}통` : '');
}

// ── 서버 정리 ────────────────────────────────────
// PC에 저장이 확인된 메일을 서버 휴지통으로 옮긴다 — 계정마다 따로 켠다. 받은 지 7·30·90일 지난 것, 또는 «바로»(0: 읽은 것만).
// 서버의 메일을 움직이는 일이라 켜기·기간 줄이기·«바로»로(또는 «바로»에서) 바꾸기는 메인이 그 계정을 세어 보고
// 확인 창으로 묻는다 — 여기서는 부탁만 하고 답을 그린다. 0은 거짓 값이라 `days || …` 꼴로 다루지 않는다.
// 누르자마자 스위치를 미리 칠하지 않는다: 확인 창에서 그만두면 스위치가 거짓말을 하게 된다.
// setApp 으로는 이 값을 못 바꾼다 (메인 store 가 버린다) — 늘 mailTidySet({ id, … }) 으로만 보낸다.
let tidyBusy = 0;               // 답을 기다리는 켜는 쪽 부탁 수 — 그동안 또 켜거나 기간을 누르면 확인 창이 겹친다 (모든 계정 하나)
const tidyOffBusy = new Set();  // 끄기 부탁의 답을 기다리는 계정 — 끄기는 다른 부탁(최대 20초 세는 중)을 기다리는 사이에도 보낸다
let tidyLast = null;            // 마지막으로 받은 st.tidy — 누를 때 «지금 값»과 견준다
let tidyMsgTimer = null;
const TIDY_PICKS = [0, 7, 30, 90];
const TIDY_DAY_MS = 86_400_000;

/**
 * 고른 기간의 뜻 — «바로»는 날짜가 아니라 읽음으로 고르므로 글이 통째로 다르다.
 * 보낸 메일은 늘 읽음(\Seen)이다 — 받은 메일 이야기로만 읽히지 않게 따로 말한다.
 * @param everyMin 메인이 계산한 «바로»의 실제 주기(분) — 메일 확인 주기를 길게 둔 사람에게 «몇 분 안에»는 거짓말이다.
 *   옛 메인이라 없으면 숫자 없이 말한다
 */
function tidyTail(days, everyMin) {
  const every = Number.isFinite(everyMin) && everyMin > 0 ? `약 ${everyMin}분마다` : '새 메일 확인 때마다';
  return days === 0
    ? `읽은 메일과 보낸 메일을 ${every} 옮깁니다. 안 읽은·별표·중요 메일은 남깁니다.`
    : `받은 지 ${days}일 지난 메일을 읽음과 상관없이 옮깁니다. 별표·중요 메일은 남깁니다.`;
}

/**
 * 계정 한 줄의 상태 — 무엇이 막고 있는지를 먼저, 그다음 마지막 실행이 무엇을 했는지.
 * 순서: 꺼짐(빈 줄 — 옛 설정에서 옮겨 와 꺼 뒀으면 그 까닭) · 쓸 수 없음(조건·계정) · 멈춤 · 지난 메일로 쉼 · 도는 중 · 아직 안 돔 · 옮김 ·
 * 기간이 안 지남 · PC에 없음 · Gmail 중요 · 안 읽음 · 실패.
 * 남긴 메일은 «저장 안 됨»과 «확인 안 됨»을 나눠 말한다 — 앞의 것은 «지난 메일 받기»로 풀리고 뒤의 것은 안 풀린다.
 * «바로»에서 안 읽어 남긴 것(unread)은 경고가 아니다 — 지금 설정이 «바로»일 때만 말한다 (기간 정리는 안 읽은 메일도 옮긴다).
 * 일부러 남긴 것(spared — Gmail이 저절로 붙인 중요 표시가 흔하다)도 사실로 적는다 — 읽은 메일이 까닭 없이 남아 보이지 않게
 */
function tidyLine(a, t) {
  // 옛 설정에서 옮겨 온 켜짐을 메인이 껐다 (MOVE 없는 서버의 복사 길은 묻지 않았다) — 꺼진 줄이어도 왜 꺼졌는지 말한다
  // 복사 길 안내 줄(.tidycopy)이 이미 보이면 같은 말을 되풀이하지 않는다
  if (!a.on) {
    if (!a.copyAsk) return '';
    return a.copyPath ? '꺼 둠 — 다시 켜면 이 방식으로 옮길지 묻습니다'
      : '꺼 둠 — 이 서버는 옮기기(MOVE)가 없어 복사한 뒤 지웁니다. 다시 켜면 그 방식으로 옮길지 묻습니다';
  }
  if (!t.ready) return '쉬는 중';
  // 비밀번호가 없거나 이 PC 에서 못 푸는 계정 — 정리가 영영 돌지 않는다. «다음 자동 백업 뒤»라고 하면 거짓이다
  if (a.usable === false) return '계정을 지금 쓸 수 없어 정리하지 않습니다 — 설정 › 메일을 확인하세요';
  if (a.blocked) return '옮기기를 멈춰 정리하지 않습니다';
  if (a.held) return '쉬는 중 — 지난 메일을 받는 동안 이 계정은 정리를 쉽니다';
  if (a.running) return '정리 중…';
  if (!a.at) return '켜짐 · 다음 자동 백업 뒤 정리';
  const ran = Number.isFinite(a.ranDays) ? a.ranDays : a.days;
  const what = ran === 0 ? '읽은 메일' : `${ran}일 지난 메일`;
  const unread = a.unread && a.days === 0 && ran === 0;
  const others = Math.max(0, (a.spared || 0) - (a.important || 0));
  const young = ran > 0 && a.oldest > 0 && a.at - a.oldest < ran * TIDY_DAY_MS;
  // 머리 — 옮긴 것이 없으면 왜 없는지를 앞에 둔다
  let head;
  if (a.moved > 0) head = 'moved';
  else if (!a.kept && !a.spared && !a.unread && !a.error && !a.more && young) head = 'young';
  else if (a.unsaved > 0) head = 'unsaved';
  else if (a.important > 0) head = 'important';
  else if (unread) head = 'unread';
  else if (a.error) head = 'error';
  else head = 'none';
  const ago = agoText(a.at);
  const lead = {
    moved: `${ago} · ${a.moved}통 휴지통으로`,
    young: `${ago} · 저장된 메일 중 ${ran}일 지난 것 0통 — 가장 오래된 것 ${Math.max(0, Math.floor((a.at - a.oldest) / TIDY_DAY_MS))}일 전`,
    unsaved: `${ago} · ${what} ${a.unsaved}통이 PC에 없음 — «지난 메일 받기» 필요`,
    important: `${ago} · ${a.gmail ? 'Gmail이 ' : ''}중요 표시한 ${a.important}통은 남김`,
    unread: `${ago} · 안 읽은 ${a.unread}통은 읽을 때까지 남김`,
    error: `${ago} · 실패: ${a.error}`,
    none: `${ago} · 0통 휴지통으로`
  }[head];
  return lead
    + (unread && head !== 'unread' ? ` · 안 읽은 ${a.unread}통 남김` : '')
    + (head === 'important' ? (others ? ` · 별표 등 ${others}통 남김` : '') : a.spared ? ` · 별표·중요 등 ${a.spared}통 남김` : '')
    + (a.unsaved && head !== 'unsaved' ? ` · 저장 안 된 ${a.unsaved}통 남김(«지난 메일 받기» 필요)` : '')
    + (a.unverified ? ` · 확인 안 된 ${a.unverified}통 남김` : '')
    + (a.more ? ' · 나머지는 다음에' : '')
    + skippedText(a)
    + (a.error && head !== 'error' ? ` · 실패: ${a.error}` : '');
}

/**
 * 건너뛴 폴더 — PC 에 저장 기록이 없는 폴더(저장된 메일이 하나도 없는 계정이 흔하다)는 까닭과 언제 대상이 되는지 말한다.
 * 나머지(번호가 바뀌었거나 못 읽은 폴더)는 수만
 */
function skippedText(a) {
  const all = a.skippedBoxes || 0;
  const none = Math.min(all, a.unsavedBoxes || 0);
  const rest = all - none;
  return (none ? ` · PC에 저장 기록이 없는 폴더 ${none}곳 건너뜀 — 새 메일이 저장되면 대상이 됩니다` : '')
    + (rest ? ` · 폴더 ${rest}곳${none ? ' 더' : ''} 건너뜀` : '');
}

/** 계정 줄의 틀 — 한 번만 만든다. 다시 칠할 때 단추를 다시 만들지 않아 누른 단추에 초점이 남는다 */
function tidyRowEl(id) {
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text) x.textContent = text;
    return x;
  };
  const row = el('div', 'tidyrow');
  row.dataset.id = id;
  const head = el('div', 'tidyhead');
  const sw = el('button', 'sw');
  sw.setAttribute('role', 'switch');
  // 멈춘 까닭 줄도 잇는다 — 막힌 스위치가 왜 안 켜지는지 읽히게
  sw.setAttribute('aria-describedby', `tidy-tail-${id} tidy-state-${id} tidy-why-${id}`);
  sw.onclick = () => { const a = tidyAcc(id); if (a) setTidy({ id, on: !a.on }, sw); };
  head.append(el('span', 'tidyname'), sw);
  const days = el('div', 'tidydays');
  const group = el('div', 'helprow');
  group.setAttribute('role', 'group');
  for (const d of TIDY_PICKS) {
    const b = el('button', 'mini ghost', d === 0 ? '바로' : `${d}일`);
    b.dataset.days = String(d);
    b.onclick = () => setTidy({ id, days: d }, b);
    group.append(b);
  }
  days.append(el('span', 'lbl', '옮기는 때'), group);
  const tail = el('span', 'hint tidytail');
  tail.id = `tidy-tail-${id}`;
  const copy = el('span', 'hint tidycopy', '이 서버는 옮기기(MOVE)가 없어 복사한 뒤 지웁니다.');
  const caps = el('span', 'hint tidycaps');
  const gmail = el('span', 'hint tidygmail', 'Gmail은 라벨 폴더에서 옮겨도 메일 자체가 휴지통으로 가 모든 라벨에서 빠집니다.');
  const state = el('span', 'hint tidystate');
  state.id = `tidy-state-${id}`;
  const stop = el('div', 'tidystop');
  const retry = el('button', 'mini ghost', '다시 해 보기');
  retry.onclick = () => setTidy({ id, retry: true }, retry);
  const why = el('span', 'hint tidywhy');
  why.id = `tidy-why-${id}`;
  stop.append(why, retry);
  row.append(head, days, tail, copy, caps, gmail, state, stop);
  return row;
}

/** 마지막으로 받은 상태에서 그 계정 줄 */
function tidyAcc(id) {
  return tidyLast && Array.isArray(tidyLast.accounts) ? tidyLast.accounts.find((a) => a.id === id) || null : null;
}

/**
 * 계정 줄을 칠한다. #tidy-msg(부탁에 대한 답)는 건드리지 않는다 —
 * 폴링이 2~20초마다 다시 칠하므로, 여기서 지우면 확인 창 결과가 읽기도 전에 사라진다.
 * 줄은 지난 메일 줄(paintFill)처럼 한 번 만들고 칠만 바꾼다 — 제자리를 지켜 초점을 잃지 않는다
 */
function paintTidy(st) {
  const t = st.tidy;
  // 서버 정리를 모르는 메인(옛 모양 포함)이거나 계정이 없으면 감춘 채로 둔다 (마크업이 처음부터 hidden 이다)
  if (!t || !Array.isArray(t.accounts) || !t.accounts.length) {
    tidyLast = t && Array.isArray(t.accounts) ? t : null;
    $('tidy-wrap').hidden = true;
    return;
  }
  tidyLast = t;
  $('tidy-wrap').hidden = false;
  // 쓸 수 없는 까닭은 한 번만 — 꺼진 계정만 있어도 보인다 (켤 수 없는 까닭이다)
  const why = !t.ready && t.why ? t.why : '';
  $('tidy-why').textContent = why;
  $('tidy-why').hidden = !why;
  const busy = tidyBusy > 0;
  const host = $('tidy-rows');
  const ids = t.accounts.map((a) => a.id);
  for (const r of [...host.children]) if (!ids.includes(r.dataset.id)) r.remove();
  t.accounts.forEach((a, i) => {
    let row = [...host.children].find((r) => r.dataset.id === a.id);
    if (!row) row = tidyRowEl(a.id);
    // 제자리에 있으면 옮기지 않는다 — 옮기면 그 안의 단추가 초점을 잃는다
    if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
    row.querySelector('.tidyname').textContent = a.name;
    const sw = row.querySelector('.sw');
    sw.classList.toggle('on', a.on);
    sw.setAttribute('aria-checked', String(a.on));
    sw.setAttribute('aria-label', `${a.name} 서버 정리`);
    sw.setAttribute('aria-busy', String(busy || t.asking || tidyOffBusy.has(a.id)));
    // 켜진 스위치는 묻는 중이어도, 답을 기다리는 중이어도, 조건이 모자라도 늘 끌 수 있어야 한다 — 막는 것은 «켜기»뿐이다.
    // (기간 줄이기를 세는 20초 동안에도 그만둘 길이 있어야 한다. 메인도 그 사이의 끄기를 받는다)
    sw.setAttribute('aria-disabled', String(a.on ? tidyOffBusy.has(a.id) : busy || t.asking || !t.ready || !!a.blocked));
    // 멈춘 계정은 기간을 골라도 옮기지 않는다 — 까닭과 «다시 해 보기»만 보인다
    const daysRow = row.querySelector('.tidydays');
    daysRow.hidden = !!a.blocked;
    const group = daysRow.querySelector('[role="group"]');
    group.setAttribute('aria-label', `${a.name} 옮기는 때`);
    for (const b of group.querySelectorAll('button')) {
      const on = Number(b.dataset.days) === a.days;
      b.className = 'mini' + (on ? '' : ' ghost');
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-disabled', String(busy || t.asking));
    }
    const tail = row.querySelector('.tidytail');
    tail.textContent = tidyTail(a.days, t.everyMin);
    tail.hidden = !!a.blocked;
    row.querySelector('.tidycopy').hidden = !a.copyPath || !!a.blocked;
    // 서버 기능 — 복사 길이거나 멈춘 계정에만. 요약(MOVE·UIDPLUS)을 보이고 전체 줄은 풍선 도움말로 (사용자가 그대로 옮겨 알려 줄 수 있게)
    const capsEl = row.querySelector('.tidycaps');
    const showCaps = !!a.caps && (a.copyPath || !!a.blocked);
    capsEl.hidden = !showCaps;
    capsEl.textContent = showCaps ? `서버 기능: ${String(a.caps).split(' · ').slice(0, 2).join(' · ')}` : '';
    capsEl.title = showCaps ? String(a.caps) : '';
    row.querySelector('.tidygmail').hidden = !a.gmail;
    const line = tidyLine(a, t);
    const state = row.querySelector('.tidystate');
    state.textContent = line;
    state.hidden = !line;
    const stop = row.querySelector('.tidystop');
    stop.hidden = !a.blocked;
    stop.querySelector('.tidywhy').textContent = a.blocked ? `이 서버에서 옮기기를 멈췄습니다 — ${a.blocked}` : '';
    const retry = stop.querySelector('button');
    retry.setAttribute('aria-label', `${a.name} 다시 해 보기`);
    retry.setAttribute('aria-disabled', String(busy || t.asking));
  });
}

/**
 * 메인에 부탁한다 — 한 계정의 켜기·끄기({id, on}), 기간({id, days}), «다시 해 보기»({id, retry}).
 * 켜기와 기간 줄이기는 메인이 그 계정을 세고(최대 20초) 확인 창을 띄운 뒤에야 답이 온다. 그동안 무엇을 하는지 먼저 말한다.
 * «바로»(0)에서 기간으로 바꾸는 것도 묻는다 — 기간 정리는 «바로»가 남기던 안 읽은 오래된 메일도 옮긴다 (backup.js setTidy).
 */
async function setTidy(req, el) {
  const a = tidyAcc(req.id);
  if (!a || (el && el.getAttribute('aria-disabled') === 'true')) return;
  // 끄기는 다른 부탁의 답을 기다리는 중에도 보낸다 (같은 계정의 끄기를 두 번 보내지는 않는다).
  // 켜기·기간·다시 해 보기는 하나씩만 — 겹치면 확인 창이 둘 뜬다
  const off = req.on === false;
  if (off ? tidyOffBusy.has(a.id) : tidyBusy > 0) return;
  // 이미 고른 기간을 다시 누른 것은 부탁이 아니다
  if (req.days !== undefined && req.days === a.days) return;
  const risky = (req.on === true && !a.on)
    || (req.days !== undefined && a.on && (req.days < a.days || a.days === 0));
  const msg = $('tidy-msg');
  clearTimeout(tidyMsgTimer);
  if (off) tidyOffBusy.add(a.id);
  else tidyBusy += 1;
  paintTidy({ tidy: tidyLast });
  if (risky) mailMsg('wait', `${a.name} · 옮길 메일을 세는 중… (최대 20초)`, msg);
  let st = null;
  try {
    st = await window.nunsseom.mailTidySet(req);
  } catch {
    st = null;   // 답이 없던 것과 같게 — 아래에서 다시 누르라고 말한다
  } finally {
    if (off) tidyOffBusy.delete(a.id);
    else tidyBusy -= 1;
  }
  if (!st) {
    if (tidyLast) paintTidy({ tidy: tidyLast });
    mailMsg('bad', '응답이 없습니다 — 잠시 뒤 다시 눌러주세요.', msg);
    return;
  }
  paintBackup(st);
  // «다시 해 보기»가 멈춤을 풀면 누른 단추가 감춰진다 — 초점이 문서로 빠지지 않게 그 줄의 스위치로 옮긴다
  const stopBox = req.retry && el ? el.closest('.tidystop') : null;
  const lost = !document.activeElement || document.activeElement === el || document.activeElement === document.body;
  if (stopBox && stopBox.hidden && lost) {
    const sw = el.closest('.tidyrow') && el.closest('.tidyrow').querySelector('.sw');
    if (sw) sw.focus();
  }
  // 끄기의 답이 먼저 와 걸어 둔 걷기 타이머가 뒤에 온 답을 일찍 걷지 않게
  clearTimeout(tidyMsgTimer);
  const said = st.tidy && st.tidy.message;
  if (!said) { msg.classList.remove('show'); return; }
  mailMsg(st.tidy.messageKind, said, msg);
  // 실패는 읽고 고칠 때까지 남기고, 나머지는 잠시 뒤 걷는다
  if (st.tidy.messageKind !== 'bad') tidyMsgTimer = setTimeout(() => msg.classList.remove('show'), 10_000);
}

// ── 지난 메일 받기 ────────────────────────────────
// 서버의 지난 메일을 뒤에서 조금씩 이 PC로 받는다 — 계정마다 한 줄. 몇 년치를 내려받고 그동안 서버 정리를 쉬게 하는 일이라
// 받기와 정리 허용은 메인이 확인 창으로 묻는다 — 여기서는 부탁만 하고 답을 그린다 (서버 정리와 같다).
// setApp 으로는 이 값을 못 바꾼다 (메인 store 가 버린다) — 늘 mailFillSet 으로만 보낸다.
let fillBusy = false;      // 켜는 쪽 부탁의 답을 기다리는 중 — 겹치면 확인 창이 둘 뜬다. 멈추기는 그 사이에도 보낸다
let fillLast = null;       // 마지막으로 받은 st.fill — 답을 기다리는 동안 단추를 다시 칠할 때 쓴다
let fillMsgTimer = null;

const FILL_STOP = { label: '멈추기', kind: 'ghost', req: { on: false } };
// 옛 메일이 서버에서 옮겨지기 시작하는 단추라 지우기 계열처럼 빨갛게 둔다. 확인은 메인이 받는다
const FILL_RELEASE = { label: '정리 허용', kind: 'ghost danger', req: { release: true } };

/** 바이트 → GB 숫자. 10GB 아래는 소수 한 자리 — «0GB»처럼 없는 것으로 읽히지 않게 */
function fillGB(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb < 10 ? Math.max(0.1, gb).toFixed(1) : String(Math.round(gb));
}

/**
 * 이름 뒤에 올 글과 단추. 받는 일의 상태(state)보다 답(answer)을 먼저 본다 — 멈춘 직후에는 끝나 가는 회차가 아직 running 이지만
 * 사용자가 들어야 할 말은 «멈췄습니다»다. 남은 수를 모르면(left:null) 그 조각을 뺀다 — 첫 메일 확인 전이나 못 연 폴더가 있을 때다
 */
function fillBase(a) {
  // 아직 안 연 폴더의 서버 수를 더한 값은 위로 잡은 것이다 — «약»이라고 하면 옛 «백업 시작» 기록에서 크게 틀린다
  const left = a.left == null ? '' : ` · 남은 ${a.leftRough ? '최대' : '약'} ${a.left}통`;
  // asked 는 «알림을 띄웠다»는 표시일 뿐 답이 아니다
  if (!a.answer || a.answer === 'asked') {
    if (!a.listed) return { text: '첫 메일 확인이 끝나면 물어봅니다', buttons: [] };
    const ask = { label: '정하기', kind: '', req: { on: true } };
    return a.left > 0
      ? { text: `지난 메일 최대 ${a.left}통 · 아직 정하지 않았습니다`, buttons: [ask] }
      : { text: '지난 메일을 받을지 아직 정하지 않았습니다', buttons: [ask] };
  }
  // 못 받은 메일을 하루에 한 번 다시 부르는 회차는 다 받은 뒤에도 돈다 — 그동안은 도는 줄을 보인다
  const again = a.answer === 'yes' && (a.state === 'running' || a.state === 'yielding');
  if (a.done && !again) {
    // «모두 받았습니다 · 못 받음 n통»은 제 말을 뒤집는다. 대부분을 못 받았을 수도 있다
    const text = a.failed ? `지난 메일 받기를 마쳤습니다 · 못 받음 ${a.failed}통`
      : a.unfillable ? '받을 수 있는 지난 메일을 모두 받았습니다' : '지난 메일을 모두 받았습니다';
    // 다시 부르는 회차는 답이 yes 일 때만 돈다 — 멈춘 계정은 이 단추가 없으면 되돌릴 길이 없다
    return { text, buttons: a.answer === 'paused' && a.canRetry ? [{ label: '다시 받기', kind: '', req: { on: true } }] : [] };
  }
  if (a.answer === 'paused') {
    return { text: `멈췄습니다${left}`, buttons: [{ label: '이어 받기', kind: '', req: { on: true } }, ...(a.canRelease ? [FILL_RELEASE] : [])] };
  }
  if (a.answer === 'no') {
    return { text: `받지 않음 — 새 메일과 열어 본 메일만 저장합니다${left}`, buttons: [{ label: '받기', kind: '', req: { on: true } }] };
  }
  const stop = [FILL_STOP];
  switch (a.state) {
    case 'running':
      if (a.done) return { text: '못 받은 메일을 다시 받는 중', buttons: stop };
      // 느린 서버는 연결만 1분이 넘는다 — 그동안 «목록을 받는 중»이라고 하지 않는다
      if (a.phase === 'head') return { text: `지난 메일 목록을 받는 중${left}`, buttons: stop };
      if (a.phase !== 'body') return { text: `서버에 연결하는 중${left}`, buttons: stop };
      return { text: `지난 메일 받는 중 · ${a.box} · 이번에 ${a.saved}통${left}${a.leftBytes > 0 ? ` · 약 ${fillGB(a.leftBytes)}GB` : ''}`, buttons: stop };
    case 'yielding':
      return { text: `메일 확인이 끝나면 이어 받습니다${a.done ? '' : left}`, buttons: stop };
    case 'unusable':
      return { text: `계정을 지금 쓸 수 없어 쉬는 중입니다${left}`, buttons: stop };
    case 'retry':
      // 쓰기·상태·폴더 오류는 연결 탓이 아니다 — «연결 실패»라고 하면 사용자가 서버를 의심한다
      if (a.retryPlain) return { text: `${a.error ? `${a.error} · ` : ''}${a.retryMin}분 뒤 다시 합니다`, buttons: stop };
      return { text: `연결 실패${a.error ? ` — ${a.error}` : ''} · ${a.retryMin}분 뒤 다시 합니다`, buttons: stop };
    case 'refused':
      // 메인이 둔 까닭(하루 한도·웹 로그인·IMAP 꺼짐·동시 연결)이 있으면 그것을 — «로그인 거절»로 바꾸면 비밀번호를 의심하게 된다
      if (a.error) return { text: `${a.error} · ${a.retryMin}분 뒤 다시 합니다`, buttons: stop };
      return { text: `서버가 잠시 로그인을 거절했습니다 · ${a.retryMin}분 뒤 다시 합니다`, buttons: stop };
    case 'auth':
      return { text: '로그인이 거절돼 멈췄습니다 — 비밀번호를 확인하세요', buttons: stop };
    case 'disk':
      // 다른 폴더를 고르면 답을 다시 묻고 처음부터 받는다 — «이어 받습니다»라고 하면 며칠치 일을 잃는 줄 모르고 고른다
      if (a.needBytes) return { text: `약 ${fillGB(a.needBytes)}GB가 더 필요한데 공간이 모자라 멈췄습니다 · 비우면 이어 받습니다. 다른 폴더를 고르면 처음부터 다시 묻고 받습니다`, buttons: stop };
      // 바닥은 비울 양이 아니라 남겨야 할 양이다. 바닥을 재기 전에 쓰기가 먼저 실패했으면 숫자가 없다 — 지어내지 않는다
      return { text: `공간이 모자라 멈췄습니다 · ${a.floorBytes ? `여유 공간이 ${Math.ceil(a.floorBytes / 1024 ** 3)}GB를 넘으면` : '비우면'} 이어 받습니다`, buttons: stop };
    default:
      return { text: `잠시 뒤 이어 받습니다${left}`, buttons: stop };
  }
}

/** 계정 한 줄의 글·둘째 줄·단추 */
function fillView(a) {
  const base = fillBase(a);
  const tail = (a.holdsTidy ? ' · 서버 정리 쉬는 중' : '') + (a.stuckDays ? ` · ${a.stuckDays}일째 나아가지 못함` : '');
  // 폴링 결과와 회차 결과에 같은 폴더가 겹쳐 올 수 있다 — 같은 글을 두 폴더로 세지 않는다
  const errors = [...new Set(a.boxErrors || [])];
  return {
    text: `${a.name} · ${base.text}${tail}`,
    // 못 받은 메일은 폴더 오류가 아니다. 다 받았으면 완료 줄이 말한다
    sub: [
      errors.length ? `못 연 폴더 ${errors.length}개 — ${errors[0]}` : '',
      a.failed && !a.done ? `못 받은 메일 ${a.failed}통` : '',
      a.unfillable ? `메일 번호를 안 주는 폴더 ${a.unfillable}개는 지난 메일을 받지 못합니다` : ''
    ].filter(Boolean).join(' · '),
    // 나아가지 못하는 동안 정리가 쉰다. 메일함이 차기 전에 사용자가 풀 길이 있어야 한다
    buttons: a.stuckDays && !base.buttons.includes(FILL_RELEASE) ? [...base.buttons, FILL_RELEASE] : base.buttons
  };
}

/** 줄의 틀 — 한 번만 만든다. 단추가 둘을 넘는 상태는 없다 (이어 받기·멈추기 + 정리 허용) */
function fillRowEl(id) {
  const row = document.createElement('div');
  row.className = 'fillrow';
  row.dataset.id = id;
  const txt = document.createElement('div');
  txt.className = 'filltxt';
  const line = document.createElement('span');
  line.className = 'hint fillline';
  const sub = document.createElement('span');
  sub.className = 'hint fillsub';
  txt.append(line, sub);
  const btns = document.createElement('span');
  btns.className = 'helprow';
  for (let i = 0; i < 2; i++) {
    const b = document.createElement('button');
    b.onclick = () => { if (b.fillReq) setFill({ id, ...b.fillReq }, b); };
    btns.append(b);
  }
  row.append(txt, btns);
  return row;
}

/**
 * 계정 줄을 칠한다. #fill-msg(부탁에 대한 답)는 건드리지 않는다 — 폴링이 다시 칠할 때 지우면 읽기도 전에 사라진다.
 * 줄과 단추를 다시 만들지 않고 글만 바꾼다 — 멈추기가 이어 받기로 바뀌어도 누른 단추에 초점이 남는다
 */
function paintFill(st) {
  const f = st.fill;
  fillLast = f || null;
  // 뒤 받기를 모르는 메인이면 감춘 채로 둔다 (마크업이 처음부터 hidden 이다).
  // 메일 확인이 꺼져 있으면(on:false) 돌 일이 없다 — «잠시 뒤 이어 받습니다»는 거짓말이 되고, 까닭은 위 안내 줄이 말한다
  if (!f || !f.on || !f.accounts.length) {
    $('fill-wrap').hidden = true;
    return;
  }
  $('fill-wrap').hidden = false;
  // 묻는 창의 한 줄뿐이면 묻지 않고 켜지는 길(자동 저장·자동 yes)에서는 영영 못 본다
  $('fill-onedrive').hidden = !f.oneDrive;
  const host = $('fill-rows');
  const ids = f.accounts.map((a) => a.id);
  for (const r of [...host.children]) if (!ids.includes(r.dataset.id)) r.remove();
  f.accounts.forEach((a, i) => {
    let row = [...host.children].find((r) => r.dataset.id === a.id);
    if (!row) row = fillRowEl(a.id);
    // 제자리에 있으면 옮기지 않는다 — 옮기면 그 안의 단추가 초점을 잃는다
    if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
    const view = fillView(a);
    row.querySelector('.fillline').textContent = view.text;
    const sub = row.querySelector('.fillsub');
    sub.textContent = view.sub;
    sub.hidden = !view.sub;
    [...row.querySelectorAll('button')].forEach((b, n) => {
      const want = view.buttons[n];
      b.hidden = !want;
      b.fillReq = want ? want.req : null;
      if (!want) return;
      b.textContent = want.label;
      b.className = `mini ${want.kind}`.trim();
      b.setAttribute('aria-label', `${a.name} ${want.label}`);
      // 멈추기는 언제든 눌린다 — 막는 것은 켜는 쪽뿐이다 (서버 정리의 끄기와 같다)
      b.setAttribute('aria-disabled', String(want.req.on !== false && (fillBusy || f.asking)));
    });
  });
}

/** 메인에 부탁한다 — {id, on} 또는 {id, release}. 받기·정리 허용은 확인 창의 답이 와야 끝난다 */
async function setFill(req, el) {
  const off = req.on === false;
  if (!off && (fillBusy || (el && el.getAttribute('aria-disabled') === 'true'))) return;
  const msg = $('fill-msg');
  if (!off) {
    fillBusy = true;
    paintFill({ fill: fillLast });
  }
  let st = null;
  try {
    st = await window.nunsseom.mailFillSet(req);
  } catch {
    st = null;   // 답이 없던 것과 같게 — 아래에서 다시 누르라고 말한다
  } finally {
    if (!off) fillBusy = false;
  }
  clearTimeout(fillMsgTimer);
  if (!st) {
    paintFill({ fill: fillLast });
    mailMsg('bad', '응답이 없습니다 — 잠시 뒤 다시 눌러주세요.', msg);
    return;
  }
  paintBackup(st);
  const said = st.fill && st.fill.message;
  if (!said) { msg.classList.remove('show'); return; }
  mailMsg(st.fill.messageKind, said, msg);
  // 실패는 읽고 고칠 때까지 남기고, 나머지는 잠시 뒤 걷는다
  if (st.fill.messageKind !== 'bad') fillMsgTimer = setTimeout(() => msg.classList.remove('show'), 10_000);
}

function paintBackup(st) {
  // 답이 없으면(메인이 아직 안 떴거나 시험용 다리) 지금 그림을 그대로 둔다
  if (!st) return;
  $('backup-dir').textContent = st.dir || '아직 정하지 않았습니다';
  paintAuto(st);
  $('btn-backup-open').style.display = st.dir ? '' : 'none';
  $('btn-backup-start').style.display = st.running ? 'none' : '';
  // 지난 메일은 계정 줄이 받는다. 둘 다 보이면 같은 일을 하는 길이 둘이고, 이쪽은 묻지도 쉬지도 않는다
  if (st.fill) $('btn-backup-start').style.display = 'none';
  $('btn-backup-stop').style.display = st.running ? '' : 'none';
  // 메일 백업을 옮기는 동안 — 폴더 고르기·열기·백업 시작을 막고 진행 줄을 보인다 (옛 메인은 st.move 가 없다)
  const mv = st.move && st.move.running ? st.move : null;
  $('btn-backup-start').disabled = !st.dir || !!mv;
  $('btn-backup-pick').disabled = !!mv;
  $('btn-backup-open').disabled = !!mv;

  // 끝난 뒤에도 막대를 비우지 않는다 — 어디까지 갔는지가 결과의 일부다
  const pct = mv ? (mv.total ? Math.min(100, (mv.done / mv.total) * 100) : 0)
    : st.total ? Math.min(100, (st.done / st.total) * 100) : 0;
  $('backup-bar').style.width = `${pct}%`;

  if (mv) {
    $('backup-state').textContent = mv.phase === 'wait' ? '메일 백업을 옮기는 중 — 다른 작업이 끝나기를 기다립니다'
      : mv.phase === 'verify' ? `메일 백업을 옮기는 중 — 사본 ${mv.total}개를 확인합니다`
        : mv.phase === 'trash' ? '메일 백업을 옮기는 중 — 이전 폴더의 백업을 휴지통으로 보내는 중'
          : `메일 백업을 옮기는 중 — ${mv.done}/${mv.total}개`;
  } else if (st.running && st.waiting) {
    // 서버 정리·자동 백업이 비켜 주기를 기다리는 중 — 말없이 멈춰 보이지 않게 무엇을 기다리는지 쓴다
    $('backup-state').textContent = st.waiting;
  } else if (st.running) {
    const where = [st.account, st.mailbox].filter(Boolean).join(' · ');
    $('backup-state').textContent = st.total
      ? `${where} — ${st.done}/${st.total} · 저장 ${st.saved}통`
      : `${where || '연결 중'} — 저장 ${st.saved}통`;
  } else if (st.message) {
    $('backup-state').textContent = st.message;
  } else {
    $('backup-state').textContent = '메일 한 통이 파일 하나(.eml)로 저장됩니다.';
  }
  paintTidy(st);
  paintFill(st);

  // 도는 동안은 자주, 자동 백업만 켜져 있으면 가끔 — 화면이 멈춰 보이지 않을 만큼만.
  // 서버 정리가 돌거나 확인 창을 띄운 동안은 그 사이 — 끝나면 결과 줄이 곧 바뀌어야 한다
  clearTimeout(backupTimer);
  // 폴더를 고르는 부탁이 아직 안 돌아왔으면(묻는 창·옮기기) 1초마다 — 옮기기의 진행 줄이 그 사이에 보여야 한다
  if (st.running || mv) backupTimer = setTimeout(loadBackup, 800);
  else if (backupPicking) backupTimer = setTimeout(loadBackup, 1000);
  else if (st.tidy && (st.tidy.running || st.tidy.asking)) backupTimer = setTimeout(loadBackup, 2000);
  else if (st.fill && st.fill.accounts.some((a) => a.state === 'running')) backupTimer = setTimeout(loadBackup, 2000);
  else if (st.auto && st.dir) backupTimer = setTimeout(loadBackup, 20000);
}

async function loadBackup() {
  paintBackup(await window.nunsseom.mailBackupStatus());
}

// 고르는 부탁은 묻는 창·옮기기가 끝나야 돌아온다 (몇 분일 수 있다) — 그동안 상태를 따로 읽어 진행 줄을 그린다
$('btn-backup-pick').onclick = async () => {
  if (backupPicking) return;
  backupPicking = true;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(loadBackup, 1000);
  let st = null;
  try {
    st = await window.nunsseom.mailBackupPick();
  } finally {
    backupPicking = false;
  }
  paintBackup(st);
};
$('btn-backup-open').onclick = () => window.nunsseom.mailBackupOpen();
$('btn-backup-start').onclick = async () => paintBackup(await window.nunsseom.mailBackupStart());
$('btn-backup-stop').onclick = () => { window.nunsseom.mailBackupStop(); loadBackup(); };

// «메일 확인하기»를 끄면 메인이 모든 계정의 서버 정리도 끈다 — 스위치가 옛 모습으로 남지 않게 다시 읽는다.
// settings.js 의 bindSwitch 는 onclick 을 쓰고 다시 묶기도 하므로 덮이지 않게 리스너로 단다.
// 그 onclick 보다 먼저 불리므로 한 박자 늦춰, setApp 이 메인에 먼저 닿게 한다
$('mailEnabled').addEventListener('click', () => setTimeout(loadBackup, 0));

// ── 자동 전달 ────────────────────────────────────
// 새로 오는 메일을 정해 둔 주소로 보낸다 (Gmail 로 모아 AI 가 읽게 하는 쓰임). 메일이 회사 밖으로 나가는 설정이라
// 켜기·주소 더하기·계정 더하기는 메인이 정확한 주소와 계정을 보여 주고 확인 창으로 묻는다 — 여기서는 부탁만 하고 답을 그린다.
// 누르자마자 스위치를 미리 칠하지 않는다: 확인 창에서 그만두면 스위치가 거짓말을 하게 된다 (서버 정리와 같다).
// 꺼진 채 적은 주소·고른 계정은 메인에 보내지 않는다 — 메인은 확인 창을 지난 값만 저장하므로 켜는 부탁에 함께 싣는다.
// setApp 으로는 이 값을 못 바꾼다 (메인 store 가 버린다) — 늘 mailFwdSet 으로만 보낸다.
let fwdLast = null;        // 마지막으로 받은 상태 — 누를 때 «지금 값»과 견준다
let fwdBusy = false;       // 켜기·바꾸기 답을 기다리는 중 — 그동안 또 누르면 확인 창이 겹친다
let fwdOffBusy = false;    // 끄기 답을 기다리는 중 — 끄기는 확인 창이 떠 있는(다른 부탁을 기다리는) 사이에도 보낸다
let fwdDirty = false;      // 받는 주소 칸을 고치는 중 — 다시 칠할 때 덮지 않는다
let fwdPick = null;        // 꺼진 채 고른 계정 id (Set) — 화면에만 둔다. null 이면 지난번 것이나 기본값을 보인다
let fwdTimer = null;
let fwdMsgTimer = null;

/**
 * 받는 주소 칸 → { list, bad }. 쉼표·쌍반점·빈칸으로 나누고 소문자로, 겹친 것은 하나로.
 * 겉모양만 본다 — 엄격한 검사는 메인이 다시 한다. '%' 는 받지 않는다 (오래된 중계 서버는 «a%b@relay» 를 b 로 보낸다).
 * 영문인지는 소문자로 바꾸기 «전에» 본다 — 켈빈 기호(K)처럼 바꾸면 영문이 되는 글자를 막는다
 */
function fwdParse(text) {
  const list = [];
  let bad = '';
  for (const raw of String(text || '').split(/[,;\s]+/)) {
    if (!raw) continue;
    const s = raw.toLowerCase();
    if (!/^[\x21-\x7e]+$/.test(raw) || !/^[^\s@<>,;%]+@[^\s@<>,;.]+(\.[^\s@<>,;.]+)+$/.test(s)) {
      if (!bad) bad = raw;
      continue;
    }
    if (!list.includes(s)) list.push(s);
  }
  return { list, bad };
}

/** 켜기·바꾸기 전에 화면에서 먼저 막는 것 — 메인도 같은 말로 막는다 */
function fwdProblem({ list, bad }, max) {
  if (bad) return `주소 형식이 이상합니다 — ${bad.slice(0, 60)}`;
  if (!list.length) return '받는 주소를 넣어주세요.';
  if (list.length > max) return `받는 주소는 ${max}개까지입니다.`;
  return '';
}

const sameList = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * 상태 한 줄 — 꺼져 있으면 왜 못 켜는지만, 켜져 있으면 마지막으로 무엇을 했는지.
 * stale 은 «켜짐»으로 저장돼 있지만 이 PC에서 확인한 계정이 하나도 없는 것이다 (다른 PC에서 복사·로밍된 설정 등) —
 * 메인은 보내지 않는다. 스위치는 켜진 채로 두고 껐다 켜게 한다 (켤 때 다시 묻는다)
 */
function fwdLine(t) {
  if (!t.on) return t.ready ? '' : (t.why || '');
  if (!t.ready) return `쉬는 중 — ${t.why}`;
  if (t.stale) return '쉬는 중 — 이 PC에서 다시 켜 주세요';
  if (t.running) return '전달 중…';
  if (!t.at) return '켜짐 · 다음 메일 확인 때 시작';
  const changed = t.accounts.filter((a) => a.changed).length;
  // 이번 실행 수는 보냈을 때만 — 새 메일이 없는 폴링마다 «0통»이 앞에 서지 않게
  return `전달 · ${agoText(t.at)}`
    + (t.sent ? ` · ${t.sent}통` : '')
    + (t.total > t.sent ? ` · 켠 뒤 ${t.total}통` : '')
    + (t.skipped ? ` · 건너뜀 ${t.skipped}통` : '')
    + (t.uncertain ? ` · 확인 안 됨 ${t.uncertain}통` : '')
    + (t.capped ? ' · 오늘 한도 · 내일 이어서' : t.more ? ' · 나머지는 다음에' : '')
    + (changed ? ` · 설정 바뀐 계정 ${changed}개 빠짐` : '')
    + (t.error ? ` · 실패: ${t.error}` : '');
}

/**
 * 받는 주소와 같은 계정 id — 제 주소로 전달하면 고리가 된다. 고를 수 없다.
 * 켜져 있으면 메인이 확인한 주소로(a.self), 꺼져 있으면 칸에 적힌 주소로 가린다 — 메인(isSelf)처럼 보내는 주소와
 * 주소꼴 아이디를 다 본다(a.addrs). 보내는 주소만 보면 켜기를 눌렀을 때 메인이 거절한다
 */
function fwdSelf(t, typed) {
  const own = (a) => (Array.isArray(a.addrs) ? a.addrs : [a.addr]).filter(Boolean);
  return new Set(t.accounts.filter((a) => (t.on ? a.self : own(a).some((x) => typed.includes(x)))).map((a) => a.id));
}

/**
 * 지금 고른 계정 id. 켜져 있으면 메인이 확인한 그대로(on), 꺼져 있으면 화면에서 고른 것(fwdPick).
 * 아직 안 골랐으면 지난번에 고른 것, 그것도 없으면 켜진 계정 전부를 보인다 — 받는 주소와 같은 계정은 늘 뺀다
 */
function fwdChosen(t, self) {
  // 꺼진 채 고를 때는 꺼 둔 계정을 넣지 않는다 — 켜도 보내지 못한다 (메인도 거절한다)
  const usable = (id) => t.on || (t.accounts.find((a) => a.id === id) || {}).enabled !== false;
  let ids;
  if (t.on) ids = t.accounts.filter((a) => a.on).map((a) => a.id);
  else if (fwdPick) ids = [...fwdPick];
  else {
    ids = t.accounts.filter((a) => a.on && !self.has(a.id) && usable(a.id)).map((a) => a.id);
    if (!ids.length) ids = t.accounts.filter((a) => a.enabled !== false && !self.has(a.id)).map((a) => a.id);
  }
  return new Set(ids.filter((id) => !self.has(id) && usable(id)));
}

/** 계정 단추 — 칠만 바꿔 누른 단추에 초점이 남게 하고, 계정이 바뀌었을 때만 다시 만든다 */
function paintFwdAccs(t, typed, busy) {
  const host = $('fwd-accs');
  const key = JSON.stringify(t.accounts.map((a) => [a.id, a.name]));
  if (host.dataset.key !== key) {
    host.textContent = '';
    host.dataset.key = key;
    for (const a of t.accounts) {
      const b = document.createElement('button');
      b.className = 'mini ghost';
      b.dataset.id = a.id;
      b.textContent = a.name;
      b.onclick = () => fwdAccClick(a.id, b);
      host.append(b);
    }
  }
  const self = fwdSelf(t, typed);
  const chosen = fwdChosen(t, self);
  for (const b of host.querySelectorAll('button')) {
    const a = t.accounts.find((x) => x.id === b.dataset.id);
    if (!a) continue;
    const on = chosen.has(a.id);
    // 꺼 둔 계정은 더할 수 없다. 이미 전달 중이면(켠 뒤에 껐다) 눌러서 뺄 수는 있다
    const off = a.enabled === false && !on;
    b.className = 'mini' + (on ? '' : ' ghost');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-disabled', String(self.has(a.id) || off || busy));
    const why = self.has(a.id) ? '받는 주소와 같은 계정'
      : off ? '꺼 둔 계정'
        : a.changed ? '계정 설정이 바뀌어 빠짐 — 다시 누르면 확인합니다' : '';
    if (why) b.title = why; else b.removeAttribute('title');
  }
}

/**
 * 스위치·받는 주소·계정 단추·상태 줄을 칠한다. #fwd-msg(부탁에 대한 답)는 건드리지 않는다 —
 * 폴링이 2~20초마다 다시 칠하므로, 여기서 지우면 확인 창 결과가 읽기도 전에 사라진다.
 */
function paintFwd(t) {
  clearTimeout(fwdTimer);
  // 자동 전달을 모르는 메인(옛 메인)이거나 답이 없으면 감춘 채로 둔다 (마크업이 처음부터 hidden 이다)
  if (!t || !Array.isArray(t.accounts) || !Array.isArray(t.to)) {
    fwdLast = null;
    $('fwd-sec').hidden = true;
    $('fwd-group').hidden = true;
    return;
  }
  fwdLast = t;
  $('fwd-sec').hidden = false;
  $('fwd-group').hidden = false;
  const busy = fwdBusy || !!t.asking;
  const sw = $('mailForwardOn');
  sw.classList.toggle('on', !!t.on);
  sw.setAttribute('aria-checked', String(!!t.on));
  sw.setAttribute('aria-busy', String(busy || fwdOffBusy));
  // 켜진 스위치는 묻는 중이어도, 답을 기다리는 중이어도, 이 PC에서 확인 안 된(stale) 설정이어도 늘 끌 수 있어야 한다
  sw.setAttribute('aria-disabled', String(!t.on && (busy || !t.ready)));
  // 받는 주소 칸 — 켜져 있으면 메인이 확인한 그대로를 보인다. 고치는 중이거나 쓰는 중이면 덮지 않는다.
  // 꺼져 있으면 사용자가 적던 글이다 — 빈 칸일 때만 지난번에 확인한 주소를 채워 둔다
  const input = $('fwd-to');
  if (!fwdDirty && document.activeElement !== input && (t.on || !input.value)) input.value = t.to.join(', ');
  const typed = fwdParse(input.value).list;
  const save = $('btn-fwd-save');
  save.hidden = !(t.on && fwdDirty && !sameList(typed, t.to));
  save.setAttribute('aria-disabled', String(busy));
  paintFwdAccs(t, typed, busy);
  const line = fwdLine(t);
  $('fwd-state').textContent = line;
  $('fwd-state').hidden = !line;
  // 도는 중·묻는 중이면 자주, 켜져 있으면 가끔 — 결과 줄이 멈춰 보이지 않을 만큼만
  if (t.running || t.asking) fwdTimer = setTimeout(loadFwd, 2000);
  else if (t.on) fwdTimer = setTimeout(loadFwd, 20000);
}

async function loadFwd() {
  let st = null;
  try {
    st = await window.nunsseom.mailFwdStatus();
  } catch {
    st = null;   // 옛 preload(부르기가 없음)·메인 오류 — 감춘다
  }
  paintFwd(st);
}

/** 화면에서 막은 까닭 — 실패는 고칠 때까지 남긴다 */
function fwdSay(kind, text) {
  clearTimeout(fwdMsgTimer);
  mailMsg(kind, text, $('fwd-msg'));
}

/**
 * 메인에 부탁한다 — {on:true,to,accounts} / {to} / {accounts} / {on:false}.
 * 켜기·주소 더하기·계정 더하기는 확인 창이 닫힌 뒤에야 답이 온다. 그동안 어디를 봐야 하는지 먼저 말한다.
 */
async function setFwd(req) {
  const t = fwdLast;
  if (!t) return;
  // 끄기는 다른 부탁의 답을 기다리는 중에도 보낸다 (같은 끄기를 두 번 보내지는 않는다).
  // 켜기·바꾸기는 하나씩만 — 겹치면 확인 창이 둘 뜬다
  const off = req.on === false;
  if (off ? fwdOffBusy : fwdBusy) return;
  const risky = (req.on === true && !t.on)
    || (Array.isArray(req.to) && req.to.some((x) => !t.to.includes(x)))
    || (Array.isArray(req.accounts) && req.accounts.some((id) => !t.accounts.some((a) => a.id === id && a.on)));
  const msg = $('fwd-msg');
  clearTimeout(fwdMsgTimer);
  if (off) fwdOffBusy = true; else fwdBusy = true;
  paintFwd(t);
  if (risky) mailMsg('wait', '확인 창에서 골라주세요.', msg);
  let st = null;
  try {
    st = await window.nunsseom.mailFwdSet(req);
  } catch {
    st = null;   // 답이 없던 것과 같게 — 아래에서 다시 누르라고 말한다
  } finally {
    if (off) fwdOffBusy = false; else fwdBusy = false;
  }
  if (!st || !Array.isArray(st.accounts)) {
    if (fwdLast) paintFwd(fwdLast);
    mailMsg('bad', '응답이 없습니다 — 잠시 뒤 다시 눌러주세요.', msg);
    return;
  }
  if (st.messageKind === 'good') {
    // 받아들였다 — 칸과 고른 계정을 메인이 저장한 그대로로 되돌린다 (고치던 글·꺼진 채 고른 것은 끝났다)
    fwdDirty = false;
    fwdPick = null;
    if (Array.isArray(st.to)) $('fwd-to').value = st.to.join(', ');
  }
  paintFwd(st);
  // 끄기의 답이 먼저 와 걸어 둔 걷기 타이머가 뒤에 온 답을 일찍 걷지 않게
  clearTimeout(fwdMsgTimer);
  if (!st.message) { msg.classList.remove('show'); return; }
  mailMsg(st.messageKind, st.message, msg);
  // 실패는 읽고 고칠 때까지 남기고, 나머지는 잠시 뒤 걷는다
  if (st.messageKind !== 'bad') fwdMsgTimer = setTimeout(() => msg.classList.remove('show'), 10_000);
}

/** «바꾸기»·칸의 Enter — 켜진 채 받는 주소 바꾸기. 더한 주소가 있으면 메인이 묻는다 */
function fwdSaveTo() {
  const t = fwdLast;
  if (!t || !t.on || $('btn-fwd-save').getAttribute('aria-disabled') === 'true') return;
  const parsed = fwdParse($('fwd-to').value);
  const bad = fwdProblem(parsed, t.max || 5);
  if (bad) { fwdSay('bad', bad); return; }
  if (sameList(parsed.list, t.to)) { fwdDirty = false; paintFwd(t); return; }
  setFwd({ to: parsed.list });
}

function fwdAccClick(id, b) {
  const t = fwdLast;
  if (!t || b.getAttribute('aria-disabled') === 'true') return;
  const self = fwdSelf(t, fwdParse($('fwd-to').value).list);
  const cur = fwdChosen(t, self);
  if (cur.has(id)) cur.delete(id); else cur.add(id);
  const ids = t.accounts.map((a) => a.id).filter((x) => cur.has(x));
  // 꺼진 채라면 화면에만 적어 둔다 — 켤 때 한꺼번에 묻는다
  if (!t.on) { fwdPick = new Set(ids); paintFwd(t); return; }
  setFwd({ accounts: ids });
}

$('mailForwardOn').onclick = (e) => {
  const t = fwdLast;
  if (!t || e.currentTarget.getAttribute('aria-disabled') === 'true') return;
  if (t.on) { setFwd({ on: false }); return; }
  const parsed = fwdParse($('fwd-to').value);
  const bad = fwdProblem(parsed, t.max || 5);
  if (bad) { fwdSay('bad', bad); return; }
  const self = fwdSelf(t, parsed.list);
  const pick = fwdChosen(t, self);
  const accounts = t.accounts.map((a) => a.id).filter((id) => pick.has(id));
  if (!accounts.length) { fwdSay('bad', '보낼 계정을 골라주세요.'); return; }
  setFwd({ on: true, to: parsed.list, accounts });
};
$('btn-fwd-save').onclick = fwdSaveTo;
$('fwd-to').addEventListener('input', () => {
  fwdDirty = true;
  // «바꾸기» 단추와 받는 주소와 같은 계정 표시를 따라 바꾼다
  if (fwdLast) paintFwd(fwdLast);
});
$('fwd-to').addEventListener('keydown', (e) => {
  // 한글 입력을 끝내는 Enter 는 «바꾸기»가 아니다
  if (e.isComposing || e.key !== 'Enter') return;
  e.preventDefault();
  fwdSaveTo();
});
// «메일 확인하기»를 끄면 메인이 자동 전달도 끈다 — 위 서버 정리와 같은 까닭으로 한 박자 늦춰 다시 읽는다
$('mailEnabled').addEventListener('click', () => setTimeout(loadFwd, 0));

// settings.js 의 첫 그리기가 앞의 둘을 부른다 (loadMail 이 끝에 loadFwd 를 부른다)
window.nunsSetMail = { loadMail, loadBackup, loadFwd };
})();

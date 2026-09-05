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
    { id: 'batch', name: '모아서', hint: '정해진 시각(10·14·17시)에만 요약해서 알립니다. 일하는 흐름을 끊지 않습니다.' },
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
    { unread: false, name: '최근 온 메일', hint: '읽었든 안 읽었든 마지막에 온 메일을 보여줍니다.' },
    { unread: true, name: '안 읽은 것만', hint: '안 읽은 메일만 보여줍니다. 다 읽으면 목록이 비워집니다.' }
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

function renderMailAccounts() {
  const host = $('mail-accounts');
  host.textContent = '';
  if (!mailData.accounts.length) {
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
  for (const a of mailData.accounts) {
    const row = document.createElement('div');
    row.className = 'rem acct' + (a.enabled === false ? ' off' : '');
    const g = document.createElement('span');
    g.className = 'g';
    g.append(window.nunsIcon('mail'));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = a.name;
    const sub = document.createElement('small');
    sub.textContent = `${a.host}:${a.port}`;
    nm.append(sub);
    const val = document.createElement('span');
    val.className = 'val';
    const err = (mailData.status.errors || []).find((e) => e.name === a.name);
    val.textContent = err ? err.message.slice(0, 24) : '';
    const sw = document.createElement('button');
    sw.className = 'sw' + (a.enabled === false ? '' : ' on');
    sw.onclick = async () => {
      mailData.accounts = await window.nunsseom.mailUpdate(a.id, { enabled: a.enabled === false });
      renderMailAccounts();
    };
    const del = document.createElement('button');
    del.className = 'mini ghost';
    del.textContent = '삭제';
    del.onclick = async () => {
      mailData.accounts = await window.nunsseom.mailRemove(a.id);
      renderMailAccounts();
    };
    row.append(g, nm, val, sw, del);
    host.append(row);
  }
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
}

function mailMsg(kind, text) {
  const el = $('mail-msg');
  el.className = 'msg show ' + kind;
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
  if (!acc.pass) { mailMsg('bad', '비밀번호를 넣으세요 (앱 비밀번호가 필요할 수 있어요)'); return false; }
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
      r.ok ? `${r.message} — 이제 «추가»를 눌러 저장하세요` : r.message);
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
    : '위젯은 몇 줄만 보입니다. 메일 목록에서 오른쪽 클릭하면 그 자리에서 규칙이 만들어집니다.';

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
    p.textContent = book.length ? '찾는 사람이 없습니다' : '아직 비어 있습니다 — 메일을 주고받으면 쌓입니다';
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
  el.style.color = kind === 'bad' ? 'var(--sun, #ff8f8f)'
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
    }
  } finally {
    $('btn-mail-add').disabled = false;
  }
};

// ── 메일 백업 ────────────────────────────────────
// 몇 시간 걸릴 수도 있는 작업이라, 열려 있는 동안만 상태를 물어본다.
let backupTimer = null;

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
  if (!st.auto) {
    el.textContent = '지난 메일은 아래 «백업 시작»을 한 번 눌러주세요.';
    return;
  }
  if (!st.dir) {
    el.textContent = '저장할 폴더를 먼저 골라야 자동 백업이 돕니다.';
    return;
  }
  // 폴링이 없으면 새 메일이 온 것도 모른다 — «도는 중»이라고 말하면 거짓말이 된다
  if (!nunsSet.data.settings.mailEnabled) {
    el.textContent = '위쪽 «메일 확인하기»가 꺼져 있어 새 메일을 자동 저장하지 못합니다.';
    return;
  }
  if (st.autoError) {
    el.textContent = `자동 백업 실패 — ${st.autoError}`;
    return;
  }
  if (!st.autoAt) {
    el.textContent = '켜졌습니다. 지금부터 오는 메일과 열어본 메일을 저장합니다'
      + ' (지난 메일은 «백업 시작»을 눌러주세요).';
    return;
  }
  el.textContent = `자동 저장 중 · ${agoText(st.autoAt)} ${st.autoSaved}통`
    + (st.autoTotal ? ` · 켠 뒤 모두 ${st.autoTotal}통` : '');
}

function paintBackup(st) {
  $('backup-dir').textContent = st.dir || '아직 정하지 않았습니다';
  paintAuto(st);
  $('btn-backup-open').style.display = st.dir ? '' : 'none';
  $('btn-backup-start').style.display = st.running ? 'none' : '';
  $('btn-backup-stop').style.display = st.running ? '' : 'none';
  $('btn-backup-start').disabled = !st.dir;

  // 끝난 뒤에도 막대를 비우지 않는다 — 어디까지 갔는지가 결과의 일부다
  const pct = st.total ? Math.min(100, (st.done / st.total) * 100) : 0;
  $('backup-bar').style.width = `${pct}%`;

  if (st.running) {
    const where = [st.account, st.mailbox].filter(Boolean).join(' · ');
    $('backup-state').textContent = st.total
      ? `${where} — ${st.done}/${st.total} · 저장 ${st.saved}통`
      : `${where || '연결 중'} — 저장 ${st.saved}통`;
  } else if (st.message) {
    $('backup-state').textContent = st.message;
  } else {
    $('backup-state').textContent = '메일 한 통이 파일 하나(.eml)로 저장됩니다.';
  }

  // 도는 동안은 자주, 자동 백업만 켜져 있으면 가끔 — 화면이 멈춰 보이지 않을 만큼만
  clearTimeout(backupTimer);
  if (st.running) backupTimer = setTimeout(loadBackup, 800);
  else if (st.auto && st.dir) backupTimer = setTimeout(loadBackup, 20000);
}

async function loadBackup() {
  paintBackup(await window.nunsseom.mailBackupStatus());
}

$('btn-backup-pick').onclick = async () => paintBackup(await window.nunsseom.mailBackupPick());
$('btn-backup-open').onclick = () => window.nunsseom.mailBackupOpen();
$('btn-backup-start').onclick = async () => paintBackup(await window.nunsseom.mailBackupStart());
$('btn-backup-stop').onclick = () => { window.nunsseom.mailBackupStop(); loadBackup(); };

// settings.js 의 첫 그리기가 이 둘을 부른다
window.nunsSetMail = { loadMail, loadBackup };
})();

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

let data = null;

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
    val.textContent = `${fmtInterval(cfg.intervalMin)} · ${fmtDuration(cfg.durationSec)}`;
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
  val.textContent = `${fmtInterval(def.intervalMin)} · ${fmtDuration(def.durationSec)}`;

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
    input.onclick = (e) => e.stopPropagation();
    const out = document.createElement('span');
    out.className = 'out';
    out.textContent = fmt(def[key]);
    input.oninput = () => { out.textContent = fmt(Number(input.value)); };
    input.onchange = async () => {
      def[key] = Number(input.value);
      val.textContent = `${fmtInterval(def.intervalMin)} · ${fmtDuration(def.durationSec)}`;
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

  detail.append(nameRow, emojiGrid,
    mkSlider('주기', 'intervalMin', 5, 240, 5, fmtInterval),
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
    if (key === 'mailAutoBackup') loadBackup();
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
    row(p.name, p.procs.join(', '), on.has(p.id), () => {
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
}

function renderMailModes() {
  const host = $('mail-mode');
  host.textContent = '';
  const modes = [
    { id: 'batch', name: '모아서', hint: '정해진 시각(10·14·17시)에만 요약해서 알립니다. 일하는 흐름을 끊지 않습니다.' },
    { id: 'instant', name: '바로', hint: '새 메일이 오면 곧바로 알립니다.' }
  ];
  const cur = data.settings.mailMode || 'batch';
  for (const m of modes) {
    const b = document.createElement('button');
    b.className = 'mini' + (cur === m.id ? '' : ' ghost');
    b.textContent = m.name;
    b.onclick = () => {
      data.settings.mailMode = m.id;
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
  const cur = data.settings.mailOnlyUnread === true;
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'mini' + (cur === o.unread ? '' : ' ghost');
    b.textContent = o.name;
    b.onclick = () => {
      data.settings.mailOnlyUnread = o.unread;
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
    const del = document.createElement('button');
    del.className = 'mini ghost';
    del.textContent = '삭제';
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
      if (r.settings) { data.settings = r.settings; bindSwitch('mailEnabled'); }
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
  if (!data.settings.mailEnabled) {
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

function bindAppRow(id, fmt, toValue, toStore) {
  const input = $(id);
  const out = $('out-' + id);
  const paint = () => { out.textContent = fmt(Number(input.value)); };
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
  bindAppRow('mailPollMin', (v) => `${v}분`, (s) => s.mailPollMin ?? 10, (v) => ({ mailPollMin: v }));
  bindAppNum('mailCount', {
    min: 1,
    toValue: (s) => s.mailCount ?? 5,
    toStore: (v) => ({ mailCount: v })
  });
  loadMail();
  loadBackup();

  for (const key of ['dndEnabled', 'autoUpdate', 'calendarBusy', 'calendarAllDay',
                     'calendarLead', 'calendarShow', 'soundEnabled',
                     'mailEnabled', 'mailShow', 'mailRemoteImages', 'mailAutoBackup']) {
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

// 설정·통계·위젯 위치를 userData 폴더의 JSON 파일에 저장한다.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const reminders = require('./reminders');
const grass = require('./grass');

const FILE = () => path.join(app.getPath('userData'), 'nunsseom.json');

// 앱 이름(눈쉼 → Hibi)이 바뀌면 userData 폴더도 바뀐다.
// 새 폴더에 설정이 없고 예전 폴더에 있으면 한 번만 복사해 온다.
// (한 번 실행되면 새 파일이 생기므로 다시 실행되지 않는다)
function migrateUserDataFolder() {
  try {
    const target = FILE();
    if (fs.existsSync(target)) return;
    const legacyDir = path.join(app.getPath('appData'), '눈쉼');
    const legacy = path.join(legacyDir, 'nunsseom.json');
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target);
      console.log('[store] 이전 설정을 옮겨왔습니다:', legacy, '→', target);
    }
  } catch (e) {
    console.warn('[store] 설정 이전 실패:', e.message);
  }
}
migrateUserDataFolder();

const DEFAULT_SETTINGS = {
  idlePauseSec: 120,   // 이 시간 이상 자리 비움이면 타이머 정지
  // 실시간 블러가 없으므로 틴트가 가독성을 담당한다.
  // 0.86 이하로 내리면 글자 많은 배경 위에서 뒤 내용이 비쳐 읽기 어려워진다(실측).
  scrim: 0.92,
  radius: 26,          // 위젯 코너 반경 (DIP)
  grassWeeks: 15,      // 기록 창 잔디 기간 (주)
  autoLaunch: false,   // Windows 로그인 시 자동 실행
  // 이벤트 기록 — 창 크기/이동 문제를 쫓는 중이라 당분간 기본 켜짐.
  // 끄면 비용이 0이고, 켜져 있어도 파일 크기는 evlog가 상한을 지킨다.
  eventLog: true,

  // 방해 금지 — 전체화면/발표/집중지원 중이면 알림을 미룬다
  dndEnabled: true,
  dndPresets: [],      // 목록에서 켠 앱 id (dnd.PRESETS 참고)
  dndApps: [],         // 직접 입력한 실행 파일 이름

  // 캘린더 — 일정 중에는 알림을 미룬다
  calendarBusy: true,
  calendarAllDay: false,   // 종일 일정도 '바쁨'으로 볼지
  // 일정 사이 빈 시간에 휴식을 배치한다.
  // 회의 직전에 띄우면 쉬다 말고 들어가야 하므로, 휴식이 온전히 들어갈 자리가 없으면 미룬다.
  calendarLead: true,
  calendarLeadMin: 5,      // 일정 시작 이만큼 전부터는 새로 띄우지 않는다 (분)
  calendarJoinMin: 10,     // 일정 사이가 이보다 좁으면 이어진 하나로 본다 (분)
  calendarShow: true,      // 위젯 시트에 오늘 일정 보여주기
  calendarPanel: false,    // 위젯에 달력 펼쳐두기
  calendarMode: 'month',   // 달력 보기 단위 — 'month' | 'week'
  // 메일 — 오는 족족 알리면 쉼을 위한 위젯이 방해 도구가 된다.
  // 기본은 "모아서" — 정해진 시각과 휴식 때만 요약해서 보여준다.
  mailEnabled: false,
  mailShow: true,          // 위젯 시트에 메일 보여주기
  mailOnlyUnread: false,   // 안 읽은 것만 볼지, 최근 온 것을 모두 볼지
  mailCount: 5,            // 위젯에 몇 통까지 보여줄지 (상한 없음 — 많으면 그만큼 느려질 뿐)
  mailBackupDir: null,     // 메일 백업 폴더 (없으면 아직 정하지 않음)
  mailAutoBackup: false,   // 새로 오는 메일과 열어본 메일을 자동으로 저장할지
  mailPanel: false,        // 위젯 겉면에 메일 펼쳐두기 (클릭 없이 보이게)
  mailViewSize: null,      // 메일 보기 창을 마지막으로 조절한 크기
  composeSize: null,       // 메일 쓰기 창을 마지막으로 조절한 크기
  // 인터넷에서 받아오는 그림. 켜면 메일이 원래대로 보이지만,
  // 불러오는 순간 "열어봤다"가 보낸 사람에게 전달된다.
  mailRemoteImages: true,
  mailMode: 'batch',       // 'batch' | 'instant'
  mailTimes: [10, 14, 17], // 모아서 알릴 시각 (시)
  mailPollMin: 10,         // 서버를 몇 분마다 확인할지

  // 알림음 — 화면만으로는 다른 창을 보고 있을 때 놓친다
  soundEnabled: true,
  soundName: 'chime',      // renderer/sound.js의 LIST 참고
  soundVolume: 55,         // 0~100

  autoUpdate: true         // 자동으로 업데이트 확인
};

let cache = null;

// 저장 포맷 버전. 창 높이 계산 방식이 바뀌면 올린다.
//  1 → 창 높이 = 카드 + 여백
//  2 → 창 높이 = 카드 + 여백 + 호버 컨트롤 띠
//  3 → 방해 금지 앱을 자유 입력에서 프리셋 목록 + 직접 입력으로 분리
const LAYOUT_VERSION = 3;

function blank() {
  return {
    layoutVersion: LAYOUT_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    reminders: reminders.defaultConfig(),
    custom: {},          // 사용자 지정 알림
    calendars: [],       // [{ id, name, url, enabled }]
    mailAccounts: [],    // [{ id, name, provider, host, port, user, sealed, enabled }]
    contacts: [],        // [{ address, name, at, used }]
    mailRules: [],       // [{ id, on, field, match, action, label }]
    mailDraft: null,     // 쓰다 말은 메일 한 통
    stats: {},           // { 'YYYY-MM-DD': { done, skipped } }
    widgetPos: null,
    widgetSize: null,
    session: null        // 종료 직전 상태 (업데이트 재시작 후 이어가기용)
  };
}

function load() {
  if (cache) return cache;
  const base = blank();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = {
      // 구버전에서 쓰던 키가 영구히 남지 않도록 알려진 키만 취한다.
      // 여기에 새 목록을 적는 걸 잊으면, 저장은 되는데 다음에 켤 때 사라진다 —
      // 주소록이 실제로 그랬다. 목록을 늘릴 때는 blank()와 여기를 같이 고쳐야 한다.
      settings: pickKnown(base.settings, raw.settings),
      // 새 버전에서 추가된 종류가 있어도 기본값이 채워지도록 병합
      reminders: mergeReminders(base.reminders, raw.reminders),
      custom: raw.custom || {},
      calendars: Array.isArray(raw.calendars) ? raw.calendars : [],
      mailAccounts: Array.isArray(raw.mailAccounts) ? raw.mailAccounts : [],
      contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
      mailRules: Array.isArray(raw.mailRules) ? raw.mailRules : [],
      mailDraft: raw.mailDraft || null,
      stats: raw.stats || {},
      widgetPos: raw.widgetPos || null,
      widgetSize: raw.widgetSize || null,
      session: raw.session || null,
      layoutVersion: raw.layoutVersion || 1
    };
    migrate(cache);
  } catch {
    cache = base;
  }
  return cache;
}

/**
 * v1에서 저장한 창 높이는 컨트롤 띠를 포함하지 않는다.
 * 그대로 쓰면 카드가 띠 높이만큼 짧아지므로 한 번 보정한다.
 */
function migrate(s) {
  if (s.layoutVersion >= LAYOUT_VERSION) return;

  if (s.layoutVersion < 2 && s.widgetSize && s.widgetSize.height) {
    const { CONTROLS } = require('./glass');
    s.widgetSize = { ...s.widgetSize, height: s.widgetSize.height + CONTROLS };
  }

  // 자유 입력해 둔 이름 중 알려진 앱은 프리셋 토글로 옮긴다
  if (s.layoutVersion < 3 && Array.isArray(s.settings.dndApps) && s.settings.dndApps.length) {
    const { PRESET_BY_PROC } = require('./dnd');
    const presets = new Set(s.settings.dndPresets || []);
    const rest = [];
    for (const raw of s.settings.dndApps) {
      const name = String(raw || '').trim().toLowerCase();
      if (!name) continue;
      const id = PRESET_BY_PROC.get(name);
      if (id) presets.add(id);
      else rest.push(name);
    }
    s.settings.dndPresets = [...presets];
    s.settings.dndApps = rest;
  }

  s.layoutVersion = LAYOUT_VERSION;
  save();
}

function pickKnown(defaults, saved) {
  const out = { ...defaults };
  if (!saved) return out;
  for (const key of Object.keys(defaults)) {
    if (saved[key] !== undefined) out[key] = saved[key];
  }
  return out;
}

function mergeReminders(defaults, saved) {
  const out = {};
  for (const id of Object.keys(defaults)) {
    out[id] = { ...defaults[id], ...((saved && saved[id]) || {}) };
  }
  return out;
}

/**
 * 설정 저장.
 *
 * 예전에는 실패해도 콘솔에만 찍고 넘어갔다. 그래서 "설정을 바꿨는데 다음에 켜면
 * 사라진다"는 증상이 생겨도 원인을 알 길이 없었다. 이제 기록에 남긴다.
 *
 * 임시 파일에 쓰고 바꿔치기한다 — 쓰는 도중에 앱이 죽어도 설정이 반쯤 잘리지 않고,
 * 백신·동기화 프로그램이 원본을 잠깐 잡고 있어도 덜 실패한다.
 */
function save() {
  const target = FILE();
  const tmp = target + '.tmp';
  try {
    const body = JSON.stringify(cache, null, 2);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
  } catch (e) {
    // 바꿔치기가 막히면 곧바로 덮어쓰기라도 시도한다
    try {
      fs.writeFileSync(target, JSON.stringify(cache, null, 2));
    } catch (e2) {
      console.error('store save failed:', e2);
      try { require('./evlog').log('저장', `설정 저장 실패 — ${e2.code || ''} ${e2.message}`); } catch {}
      return false;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return true;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = {
  /** 파일에 실제로 무엇이 들어 있는지 (저장이 됐는지 확인용) */
  reloadFromDisk() {
    try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return { mailAccounts: [] }; }
  },

  get settings() { return load().settings; },
  setSettings(patch) {
    const s = load();
    s.settings = { ...s.settings, ...patch };
    save();
    return s.settings;
  },

  get reminders() { return load().reminders; },
  setReminder(id, patch) {
    const s = load();
    s.reminders[id] = { ...(s.reminders[id] || {}), ...patch };
    save();
    return s.reminders[id];
  },

  get custom() { return load().custom; },
  setCustom(id, def) {
    const s = load();
    if (def == null) delete s.custom[id];
    else s.custom[id] = { ...(s.custom[id] || {}), ...def };
    save();
    return s.custom;
  },
  /** 새 사용자 지정 알림 — id를 생성해 저장하고 { id, custom } 반환 */
  addCustom(def) {
    const s = load();
    const id = `u${Date.now().toString(36)}`;
    s.custom[id] = {
      name: def.name || '내 알림',
      emoji: def.emoji || null,
      color: def.color || '#e3c08a',
      kind: def.kind === 'long' ? 'long' : 'short',
      intervalMin: Math.max(1, Math.round(def.intervalMin || 60)),
      durationSec: Math.max(5, Math.round(def.durationSec || 30)),
      headline: def.headline || def.name || '잠깐 쉬어요',
      enabled: true
    };
    save();
    return { id, custom: s.custom };
  },

  get calendars() { return load().calendars; },
  addCalendar(cal) {
    const s = load();
    const id = `c${Date.now().toString(36)}`;
    s.calendars.push({ id, name: cal.name || '캘린더', url: cal.url, enabled: true });
    save();
    return s.calendars;
  },
  updateCalendar(id, patch) {
    const s = load();
    const c = s.calendars.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
    save();
    return s.calendars;
  },
  removeCalendar(id) {
    const s = load();
    s.calendars = s.calendars.filter((x) => x.id !== id);
    save();
    return s.calendars;
  },

  get mailAccounts() { return load().mailAccounts; },
  addMailAccount(acc) {
    const s = load();
    const id = `m${Date.now().toString(36)}`;
    s.mailAccounts.push({
      id, name: acc.name || acc.user || '메일',
      provider: acc.provider || 'custom',
      host: acc.host, port: Number(acc.port) || 993,
      user: acc.user, sealed: acc.sealed || null,
      // 보내기(SMTP)는 받기와 서버가 다르다. 비워두면 받는 서버에서 유추한다.
      smtpHost: acc.smtpHost || '', smtpPort: Number(acc.smtpPort) || 0,
      fromAddress: acc.fromAddress || '', fromName: acc.fromName || '',
      signature: acc.signature || '',   // 쓸 때 본문 끝에 자동으로 붙는다
      enabled: true
    });
    save();
    return s.mailAccounts;
  },
  updateMailAccount(id, patch) {
    const s = load();
    const a = s.mailAccounts.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
    save();
    return s.mailAccounts;
  },
  /**
   * 메일 필터 — 위젯에 무엇을 보일지 정하는 규칙.
   * 광고·자동알림이 스무 줄을 다 차지하면 정작 볼 메일이 밀려난다.
   */
  get mailRules() { return load().mailRules || []; },
  addMailRule(rule) {
    const s = load();
    if (!Array.isArray(s.mailRules)) s.mailRules = [];
    s.mailRules.push({
      id: `f${Date.now().toString(36)}`,
      on: true,
      field: rule.field || 'from',
      match: String(rule.match || '').slice(0, 200),
      action: rule.action || 'hide',
      label: String(rule.label || '').slice(0, 40)
    });
    save();
    return s.mailRules;
  },
  updateMailRule(id, patch) {
    const s = load();
    const r = (s.mailRules || []).find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    save();
    return s.mailRules || [];
  },
  removeMailRule(id) {
    const s = load();
    s.mailRules = (s.mailRules || []).filter((x) => x.id !== id);
    save();
    return s.mailRules;
  },

  /**
   * 쓰다 말은 메일 한 통.
   *
   * 쓰기 창이 하나뿐이므로 칸도 하나다. «지금 쓰기 창에 들어 있는 것»을
   * 그대로 들고 있다가, 다음에 새 메일을 열 때 돌려준다. 보내면 비운다.
   *
   * 첨부파일 경로는 일부러 안 담는다 — 메인은 «대화상자로 골람 파일»만
   * 보내도록 막아둔다. 저장해 둔 경로를 다시 믿어버리면 그 문이 열린다.
   * 이름만 남겨 «다시 붙여주세요»라고 말한다.
   */
  get mailDraft() { return load().mailDraft; },
  setMailDraft(d) {
    const s = load();
    const str = (v, n) => String(v === null || v === undefined ? '' : v).slice(0, n);
    s.mailDraft = d ? {
      at: Date.now(),
      accountId: str(d.accountId, 60),
      kind: d.kind === 'reply' || d.kind === 'forward' ? d.kind : 'new',
      title: str(d.title, 20),
      to: str(d.to, 2000),
      cc: str(d.cc, 2000),
      bcc: str(d.bcc, 2000),
      subject: str(d.subject, 500),
      // 본문은 그림이 base64로 들어있을 수 있어 큼직하다.
      // 설정 파일 하나에 다 들어가므로 상한을 둔다 (넘으면 저장 자체를 안 한다).
      bodyHtml: str(d.bodyHtml, 2 * 1024 * 1024),
      inReplyTo: str(d.inReplyTo, 500),
      references: str(d.references, 2000),
      attachNames: (Array.isArray(d.attachNames) ? d.attachNames : [])
        .slice(0, 20).map((n) => str(n, 120))
    } : null;
    save();
    return s.mailDraft;
  },
  clearMailDraft() {
    const s = load();
    s.mailDraft = null;
    save();
  },

  /**
   * 주소록 — 보낸 적 있는 주소를 자동으로 모은다.
   * 따로 입력하게 하면 아무도 안 채운다. 한 번 보내고 나면 다음부터 자동완성된다.
   */
  get contacts() { return load().contacts || []; },
  rememberContacts(list) {
    const s = load();
    if (!Array.isArray(s.contacts)) s.contacts = [];
    let changed = false;
    for (const one of list || []) {
      const address = String(one.address || '').trim().toLowerCase();
      if (!address || !address.includes('@')) continue;
      const found = s.contacts.find((c) => c.address === address);
      if (found) {
        found.at = Date.now();
        found.used = (found.used || 1) + 1;
        // 사람이 직접 고친 이름은 건드리지 않는다
        if (one.name && !found.pinned && one.name !== found.name) {
          found.name = String(one.name).slice(0, 60);
        }
      } else {
        s.contacts.push({ address, name: String(one.name || '').slice(0, 60), at: Date.now(), used: 1 });
      }
      changed = true;
    }
    if (!changed) return s.contacts;
    // 자주 쓴 것과 최근 쓴 것을 앞에 두고, 너무 불어나지 않게 자른다
    s.contacts.sort((a, b) => (b.used || 1) - (a.used || 1) || b.at - a.at);
    s.contacts = s.contacts.slice(0, 500);
    save();
    return s.contacts;
  },
  /** 사람이 직접 고친 이름 — 자동으로 모은 것보다 우선한다 */
  saveContact({ address, name }) {
    const s = load();
    if (!Array.isArray(s.contacts)) s.contacts = [];
    const key = String(address || '').trim().toLowerCase();
    if (!key || !key.includes('@')) return s.contacts;
    const found = s.contacts.find((c) => c.address === key);
    if (found) {
      found.name = String(name || '').slice(0, 60);
      found.pinned = true;          // 다음에 자동 수집이 덮어쓰지 못하게
    } else {
      s.contacts.push({
        address: key, name: String(name || '').slice(0, 60),
        at: Date.now(), used: 1, pinned: true
      });
    }
    save();
    return s.contacts;
  },
  removeContact(address) {
    const s = load();
    s.contacts = (s.contacts || []).filter((c) => c.address !== String(address).toLowerCase());
    save();
    return s.contacts;
  },

  removeMailAccount(id) {
    const s = load();
    s.mailAccounts = s.mailAccounts.filter((x) => x.id !== id);
    save();
    return s.mailAccounts;
  },

  get session() { return load().session; },
  setSession(s) { load().session = s; save(); },
  clearSession() { load().session = null; save(); },

  get widgetPos() { return load().widgetPos; },
  setWidgetPos(pos) { load().widgetPos = pos; save(); },
  get widgetSize() { return load().widgetSize; },
  setWidgetSize(size) { load().widgetSize = size; save(); },

  bumpStat(kind, count = 1) {
    const s = load();
    const key = todayKey();
    if (!s.stats[key]) s.stats[key] = { done: 0, skipped: 0 };
    s.stats[key][kind] += count;
    save();
  },
  /** 완료한 알림 종류들을 기록 — done 합계와 종류별 카운트를 함께 올린다 */
  recordDone(ids) {
    const s = load();
    const key = todayKey();
    if (!s.stats[key]) s.stats[key] = { done: 0, skipped: 0 };
    const day = s.stats[key];
    if (!day.byType) day.byType = {};
    for (const id of ids || []) {
      day.done += 1;
      day.byType[id] = (day.byType[id] || 0) + 1;
    }
    save();
  },
  todayStats() {
    return load().stats[todayKey()] || { done: 0, skipped: 0 };
  },
  /** 잔디 데이터 — typeId 가 null 이면 전체 */
  grassSeries(weeks, typeId) {
    return grass.series(load().stats, weeks, typeId || null);
  },
  /** { current, best } 연속 기록 */
  streaks(typeId) {
    const st = load().stats;
    return {
      current: grass.currentStreak(st, typeId || null),
      best: grass.bestStreak(st, typeId || null)
    };
  },
  /** 오늘 특정 종류 횟수 */
  todayCount(typeId) {
    const day = load().stats[todayKey()];
    if (!day) return 0;
    return typeId ? (day.byType && day.byType[typeId]) || 0 : day.done || 0;
  },
  /** 오늘 횟수만 0으로 */
  resetToday() {
    const s = load();
    s.stats[todayKey()] = { done: 0, skipped: 0 };
    save();
    return s.stats[todayKey()];
  },
  /** 전체 기록 삭제 */
  resetAllStats() {
    const s = load();
    s.stats = {};
    save();
  },
  /** 최근 n일 완료 수 (오래된 것 → 최신) */
  recentDays(n = 7) {
    const s = load();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push((s.stats[key] || {}).done || 0);
    }
    return out;
  }
};

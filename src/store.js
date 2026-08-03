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
  mailShow: true,          // 위젯 시트에 새 메일 보여주기
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
      // 구버전에서 쓰던 키가 영구히 남지 않도록 알려진 키만 취한다
      settings: pickKnown(base.settings, raw.settings),
      // 새 버전에서 추가된 종류가 있어도 기본값이 채워지도록 병합
      reminders: mergeReminders(base.reminders, raw.reminders),
      custom: raw.custom || {},
      calendars: Array.isArray(raw.calendars) ? raw.calendars : [],
      mailAccounts: Array.isArray(raw.mailAccounts) ? raw.mailAccounts : [],
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

function save() {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('store save failed:', e);
  }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = {
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

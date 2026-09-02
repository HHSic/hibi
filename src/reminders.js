// 알림 종류 정의와 스케줄러.
// 종류마다 자기 타이머를 따로 돌리고, 동시에 걸린 것들은 한 번의 휴식 화면으로 묶는다.

// 하나가 발동할 때, 곧 올 다른 알림도 함께 당겨서 한 번에 처리한다.
// 주기가 20분/1시간/2시간처럼 다르면 "정확히 겹치는" 경우가 거의 없어서
// 시간 창을 좁게 두면 사실상 묶이지 않는다. 그래서 각 알림의 주기에 비례한
// 창(주기의 20%, 최대 10분)을 쓴다 — 방해 횟수도 줄어든다.
const BUNDLE_RATIO = 0.35;
const BUNDLE_MAX_MS = 15 * 60 * 1000;
const BUNDLE_MIN_MS = 2 * 60 * 1000;

/**
 * 정해진 시각을 놓쳤을 때 얼마나 늦게까지 울려주나.
 *
 * 회의가 끝나거나 자리에서 돌아온 «직후»에 울리는 건 맞다 — 조금 늦어도 쓸모가 있다.
 * 하지만 세 시간 지난 «아침 스트레칭»은 알림이 아니라 방해다. 그런 건 버리고
 * 다음 차례로 넘긴다.
 */
const MISS_GRACE_MS = 30 * 60 * 1000;

/** 주기가 아니라 «정해진 시각»에 우는 알림인가 */
function isFixed(cfg) {
  return !!(cfg && cfg.when === 'at');
}

/**
 * 'HH:MM' 목록을 [시, 분]으로. 이상한 값은 버리고, 이른 순으로 정렬해 중복을 없앤다.
 * 정렬은 보기 좋으라고 하는 게 아니다 — nextTimeAfter가 «그날 중 처음 오는 것»을
 * 앞에서부터 훑어 찾기 때문에, 순서가 어긋나면 엉뚱한 시각을 고른다.
 */
function parseTimes(times) {
  const out = [];
  for (const t of Array.isArray(times) ? times : []) {
    const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    out.push([h, min]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.filter((v, i) => !i || v[0] !== out[i - 1][0] || v[1] !== out[i - 1][1]);
}

/** 요일 제한 (0=일 … 6=토). 비었으면 «매일»이라는 뜻으로 null */
function parseDays(days) {
  if (!Array.isArray(days) || !days.length) return null;
  const set = new Set();
  for (const d of days) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set.size ? set : null;
}

/**
 * from 다음에 처음 오는 «그 시각». 정해둔 시각이 없으면 null.
 *
 * 날짜를 하루씩 넘기며 찾는다. 서머타임이 있는 곳에서도 09:00은 그날의 09:00이어야 하므로
 * epoch 산술로 24시간씩 더하지 않고 Date 생성자로 매일 새로 만든다.
 * 8일까지만 본다 — 어떤 요일이든 7일 안에 반드시 한 번은 온다.
 */
function nextTimeAfter(cfg, from = Date.now()) {
  const times = parseTimes(cfg && cfg.times);
  if (!times.length) return null;
  const days = parseDays(cfg && cfg.days);
  const base = new Date(from);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    if (days && !days.has(day.getDay())) continue;
    for (const [h, m] of times) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
      if (t > from) return t;
    }
  }
  return null;
}

/**
 * kind: 'short' → 짧은 안내 + 카운트다운
 *       'long'  → 체크리스트형 긴 휴식
 */
const TYPES = [
  {
    id: 'eye',
    name: '눈 휴식',
    glyph: 'eye',
    color: '#5ecfb6',
    kind: 'short',
    defaults: { enabled: true, intervalMin: 20, durationSec: 20 },
    headline: '먼 곳을 바라보세요',
    tips: [
      ['창밖, 6m보다 먼 곳을 바라보세요', '초점을 멀리 두는 것만으로 눈 근육이 풀려요'],
      ['눈을 지그시 감아보세요', '감은 채로 천천히 숨을 세 번'],
      ['천천히 10번 깜빡이기', '건조해진 눈에 눈물막을 다시 입혀요'],
      ['눈동자로 크게 원 그리기', '시계 방향 두 번, 반대로 두 번'],
      ['먼 곳 → 가까운 곳 초점 왕복', '창밖과 손끝을 번갈아 바라보세요']
    ]
  },
  {
    id: 'tears',
    name: '인공눈물',
    glyph: 'drop',
    color: '#6bb8ff',
    kind: 'short',
    defaults: { enabled: true, intervalMin: 120, durationSec: 30 },
    headline: '인공눈물 한 방울',
    tips: [
      ['인공눈물을 한 방울 넣으세요', '넣고 나서 30초쯤 천천히 깜빡여 주세요'],
      ['눈물 넣고 눈을 감아보세요', '눈꺼풀을 굴려 골고루 퍼지게']
    ]
  },
  {
    id: 'posture',
    name: '자세 교정',
    glyph: 'posture',
    color: '#c9a0f5',
    kind: 'short',
    defaults: { enabled: false, intervalMin: 45, durationSec: 15 },
    headline: '등을 펴세요',
    tips: [
      ['등을 펴고 턱을 살짝 당기세요', '모니터 상단이 눈높이와 같은지 확인'],
      ['골반을 의자 깊이 넣어 앉으세요', '발바닥 전체가 바닥에 닿게']
    ]
  },
  {
    id: 'water',
    name: '물 마시기',
    glyph: 'water',
    color: '#4fd1e0',
    kind: 'short',
    defaults: { enabled: false, intervalMin: 60, durationSec: 20 },
    headline: '물 한 잔',
    tips: [
      ['물 한 잔을 채워 마시세요', '눈물막도 몸의 수분에서 나옵니다']
    ]
  },
  {
    id: 'stretch',
    name: '스트레칭',
    glyph: 'stretch',
    color: '#f0a93b',
    kind: 'long',
    defaults: { enabled: true, intervalMin: 60, durationSec: 60 },
    headline: '몸을 늘려주세요',
    checklist: ['목을 좌우로 천천히 기울이기', '어깨를 뒤로 크게 돌리기', '허리를 좌우로 비틀기', '손목·손가락 펴기']
  },
  {
    id: 'stand',
    name: '일어서기',
    glyph: 'stand',
    color: '#57c97a',
    kind: 'long',
    defaults: { enabled: false, intervalMin: 50, durationSec: 120 },
    headline: '잠깐 일어나 걷기',
    checklist: ['자리에서 일어나기', '조금 걷다 오기', '창밖 멀리 바라보기']
  },
  {
    id: 'wrist',
    name: '손목 풀기',
    glyph: 'wrist',
    color: '#ff9448',
    kind: 'short',
    defaults: { enabled: false, intervalMin: 40, durationSec: 20 },
    headline: '손목을 풀어주세요',
    tips: [
      ['손목을 천천히 돌리세요', '양쪽 각각 다섯 바퀴씩'],
      ['손가락을 쭉 펴고 5초 유지', '손등을 부드럽게 눌러 늘리기']
    ]
  },
  {
    id: 'breath',
    name: '심호흡',
    glyph: 'breath',
    color: '#e3c08a',
    kind: 'short',
    defaults: { enabled: false, intervalMin: 90, durationSec: 40 },
    headline: '천천히 숨을 쉬세요',
    tips: [
      ['4초 들이쉬고 6초 내쉬기', '세 번만 반복해 보세요']
    ]
  }
];

const byId = new Map(TYPES.map((t) => [t.id, t]));

function getType(id) { return byId.get(id) || null; }

/** 사용자 지정 종류를 포함한, 화면 표시용 메타 */
function meta(id, custom) {
  const t = getType(id);
  if (t) return { id: t.id, name: t.name, glyph: t.glyph, color: t.color, kind: t.kind };
  const c = custom && custom[id];
  return c
    ? { id, name: c.name || '알림', glyph: 'custom', emoji: c.emoji || null, color: c.color || '#e3c08a', kind: c.kind || 'short' }
    : { id, name: '알림', glyph: 'custom', emoji: null, color: '#e3c08a', kind: 'short' };
}

/** 종류별 설정 기본값 */
function defaultConfig() {
  const out = {};
  for (const t of TYPES) out[t.id] = { ...t.defaults };
  return out;
}

/**
 * 종류별 타이머를 관리한다.
 * config: { [id]: { enabled, intervalMin, durationSec } }
 * custom: { [id]: { name, color, kind, intervalMin, durationSec, headline, tips? } }
 */
class Scheduler {
  constructor(getConfig, getCustom) {
    this.getConfig = getConfig;
    this.getCustom = getCustom || (() => ({}));
    this.nextAt = new Map(); // id -> epoch ms
    this.reset();
  }

  /** 활성화된 모든 종류의 id */
  activeIds() {
    const cfg = this.getConfig();
    const custom = this.getCustom();
    const ids = [];
    for (const t of TYPES) if (cfg[t.id] && cfg[t.id].enabled) ids.push(t.id);
    for (const id of Object.keys(custom)) if (custom[id].enabled !== false) ids.push(id);
    return ids;
  }

  cfgOf(id) {
    const cfg = this.getConfig();
    if (cfg[id]) return cfg[id];
    const c = this.getCustom()[id];
    // 여기서 고른 것만 스케줄러에 보인다 — when/times/days를 빠뜨리면
    // 저장은 되는데 영영 안 울리는 알림이 된다.
    return c
      ? {
        enabled: c.enabled !== false,
        intervalMin: c.intervalMin,
        durationSec: c.durationSec,
        when: c.when,
        times: c.times,
        days: c.days
      }
      : null;
  }

  /** 전체 재스케줄 */
  reset(from = Date.now()) {
    this.nextAt.clear();
    for (const id of this.activeIds()) this.schedule(id, from);
  }

  schedule(id, from = Date.now()) {
    const c = this.cfgOf(id);
    if (!c) { this.nextAt.delete(id); return; }
    if (isFixed(c)) {
      const at = nextTimeAfter(c, from);
      // 시각을 하나도 안 정했으면 울릴 때가 없다 — 켜져 있어도 목록에서 빼둔다
      if (at == null) this.nextAt.delete(id);
      else this.nextAt.set(id, at);
      return;
    }
    this.nextAt.set(id, from + Math.max(1, c.intervalMin) * 60_000);
  }

  /**
   * 놓친 «정해진 시각»을 정리한다. 매 초 부른다.
   *
   * 멈춰 있거나 자리를 비운 동안 그 시각이 지나갔을 수 있다. 조금 늦은 것은 그대로 둬서
   * 돌아오는 즉시 울리게 하고, 한참 지난 것은 버리고 다음 차례로 넘긴다.
   * @returns {string[]} 건너뛴 id들
   */
  catchUp(now = Date.now()) {
    const skipped = [];
    for (const [id, at] of this.nextAt) {
      if (now - at <= MISS_GRACE_MS) continue;
      if (!isFixed(this.cfgOf(id))) continue;
      this.schedule(id, now);
      skipped.push(id);
    }
    return skipped;
  }

  /**
   * 이 알림의 «한 바퀴»가 몇 ms인가 — 위젯 고리가 얼마나 찼는지 그리는 데 쓴다.
   * 정해진 시각이면 이번 차례에서 다음 차례까지 (매일이면 24시간).
   */
  periodMsOf(id, at = Date.now()) {
    const c = this.cfgOf(id);
    if (!c) return 20 * 60_000;
    if (!isFixed(c)) return Math.max(1, c.intervalMin) * 60_000;
    const after = nextTimeAfter(c, at);
    return after ? after - at : 24 * 60 * 60_000;
  }

  /** 설정이 바뀌었을 때 — 새로 켜진 건 예약하고, 꺼진 건 제거 */
  sync() {
    const active = new Set(this.activeIds());
    for (const id of [...this.nextAt.keys()]) if (!active.has(id)) this.nextAt.delete(id);
    for (const id of active) if (!this.nextAt.has(id)) this.schedule(id);
  }

  /** 자리 비움 등으로 카운트다운을 미룰 때 */
  postponeAll(ms) {
    for (const [id, at] of this.nextAt) {
      // 정해진 시각은 밀지 않는다. 자리를 비웠다고 09:00이 09:37이 되면 안 되고,
      // 한 번 밀리면 그 뒤로 영영 어긋난 시각에 운다 — 여기서 미룬 값이 다음 기준이 되므로.
      // 대신 그 시각이 지나가 버린 건 catchUp()이 따로 정리한다.
      if (isFixed(this.cfgOf(id))) continue;
      this.nextAt.set(id, at + ms);
    }
  }

  /** 가장 먼저 도래하는 종류 */
  soonest() {
    let best = null;
    for (const [id, at] of this.nextAt) {
      if (!best || at < best.at) best = { id, at };
    }
    return best;
  }

  /** id가 t 시점의 휴식에 함께 묶일 수 있는지 */
  bundleWindowOf(id) {
    const c = this.cfgOf(id);
    if (!c) return 0;
    // 정해진 시각은 앞당겨 묶지 않는다 — 10시 알림이 9시 55분에 울리면 그건 10시가 아니다.
    // (뒤로 묶이는 건 괜찮다. 10시에 울릴 때 곧 올 다른 알림을 데려가는 건 그대로 둔다.)
    if (isFixed(c)) return 0;
    const intervalMs = Math.max(1, c.intervalMin) * 60_000;
    return Math.min(Math.max(intervalMs * BUNDLE_RATIO, BUNDLE_MIN_MS), BUNDLE_MAX_MS);
  }

  /** t 시점에 함께 발동할 종류들 — 가장 이른 것 + 곧 올 것들 */
  bundleAt(t) {
    const first = this.soonest();
    if (!first) return [];
    const ids = [first.id];
    for (const [id, at] of this.nextAt) {
      if (id === first.id) continue;
      if (at - t <= this.bundleWindowOf(id)) ids.push(id);
    }
    return ids;
  }

  /** 지금 발동해야 할 종류들 (묶음). 아직 때가 아니면 빈 배열 */
  due(now = Date.now()) {
    const first = this.soonest();
    if (!first || first.at > now) return [];
    return this.bundleAt(now);
  }

  /** 다음 휴식에 함께 묶일 예정인 종류들 — 위젯에 미리 보여주기 위함 */
  nextBundle() {
    const first = this.soonest();
    return first ? this.bundleAt(first.at) : [];
  }

  /** 발동한 종류들을 다시 예약 */
  rescheduleAll(ids, from = Date.now()) {
    for (const id of ids) this.schedule(id, from);
  }

  /** 스누즈 — 지정 시간 뒤로 */
  snooze(ids, ms, from = Date.now()) {
    for (const id of ids) this.nextAt.set(id, from + ms);
  }
}

module.exports = {
  TYPES, getType, meta, defaultConfig, Scheduler,
  isFixed, parseTimes, parseDays, nextTimeAfter, MISS_GRACE_MS
};

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
    ? { id, name: c.name || '알림', glyph: 'custom', color: c.color || '#e3c08a', kind: c.kind || 'short' }
    : { id, name: '알림', glyph: 'custom', color: '#e3c08a', kind: 'short' };
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
    return c ? { enabled: c.enabled !== false, intervalMin: c.intervalMin, durationSec: c.durationSec } : null;
  }

  /** 전체 재스케줄 */
  reset(from = Date.now()) {
    this.nextAt.clear();
    for (const id of this.activeIds()) this.schedule(id, from);
  }

  schedule(id, from = Date.now()) {
    const c = this.cfgOf(id);
    if (!c) { this.nextAt.delete(id); return; }
    this.nextAt.set(id, from + Math.max(1, c.intervalMin) * 60_000);
  }

  /** 설정이 바뀌었을 때 — 새로 켜진 건 예약하고, 꺼진 건 제거 */
  sync() {
    const active = new Set(this.activeIds());
    for (const id of [...this.nextAt.keys()]) if (!active.has(id)) this.nextAt.delete(id);
    for (const id of active) if (!this.nextAt.has(id)) this.schedule(id);
  }

  /** 자리 비움 등으로 카운트다운을 미룰 때 */
  postponeAll(ms) {
    for (const [id, at] of this.nextAt) this.nextAt.set(id, at + ms);
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

module.exports = { TYPES, getType, meta, defaultConfig, Scheduler };

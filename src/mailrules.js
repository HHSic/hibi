'use strict';
/**
 * 메일 필터 — «이 메일을 어떻게 다룰까»를 정한다.
 *
 * 서버를 부르지 않는 순수 계산이다. 받은 목록에 도장을 찍어 돌려줄 뿐이고,
 * 실제로 숨기거나 옮기는 일은 부르는 쪽이 한다. 그래야 규칙 자체를 시험할 수 있다.
 *
 * 위젯은 몇 줄만 보이는 좁은 화면이다. 광고·자동알림·결재통보가 스무 줄을 다 차지하면
 * 정작 봐야 할 메일이 밀려난다. 그걸 걷어내는 게 이 파일의 목적이다.
 */

/** 규칙 하나가 볼 수 있는 곳 */
const FIELDS = ['from', 'subject', 'any'];
const FIELD_NAMES = { from: '보낸사람', subject: '제목', any: '아무 데나' };

/** 할 수 있는 일 */
const ACTIONS = ['hide', 'group', 'mute', 'read', 'spam'];

const ACTION_NAMES = {
  hide: '숨기기',
  group: '묶기',
  mute: '알림 안 함',
  read: '자동 읽음',
  spam: '스팸으로'
};

/**
 * 사람이 적은 조건을 정규식으로 바꾼다.
 * `*`만 특별하게 다룬다 — 정규식을 배우게 할 수는 없다.
 *   "(광고)"        → 제목에 그 글자가 들어가면
 *   "*@stcdev.com"  → 그 도메인에서 온 것 전부
 *
 * `*`를 잠깐 딴 글자로 바꿔뒀다가 마지막에 `.*`로 편다. 그 딴 글자로는
 * 메일 제목에 절대 안 들어가는 것을 써야 한다 — 처음엔 공백을 썼는데,
 * 그러면 «정산 자료»라고 적은 조건이 «정산자료보고»에도 걸려버린다.
 * 소스에 진짜 NUL 바이트를 넣으면 git이 이 파일을 바이너리로 보고 변경 내역을
 * 못 보여준다(실제로 그랬다). 그래서 이름 붙인 상수로 둔다.
 */
const STAR = '\u0000';

function toMatcher(pattern) {
  const raw = String(pattern || '').trim();
  if (!raw) return null;
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? STAR : '\\' + c));
  const body = escaped.split(STAR).join('.*');
  try {
    return new RegExp(body, 'i');
  } catch {
    return null;
  }
}

/** 규칙이 볼 글자 — 보낸사람은 이름과 주소를 모두 본다 */
function haystack(msg, field) {
  const from = `${msg.fromName || ''} ${msg.fromAddress || ''} ${msg.from || ''}`.trim();
  if (field === 'from') return from;
  if (field === 'subject') return String(msg.subject || '');
  return `${from} ${msg.subject || ''}`;
}

/** 규칙 하나가 이 메일에 걸리는가 */
function hits(rule, msg) {
  if (!rule || rule.on === false) return false;
  const re = toMatcher(rule.match);
  if (!re) return false;
  return re.test(haystack(msg, FIELDS.includes(rule.field) ? rule.field : 'any'));
}

/**
 * «어느 규칙이 이걸 잡았나»를 메일에 붙여둘 표.
 * 숨긴 메일을 보여줄 때 왜 숨겼는지 말해주고, 거기서 그 규칙을 바로 끄게 하려면 필요하다.
 * 규칙 객체를 통째로 붙이지 않는다 — 화면으로 건너가는 값은 작고 납작해야 한다.
 */
function stamp(rule) {
  if (!rule) return null;
  const field = FIELDS.includes(rule.field) ? rule.field : 'any';
  const match = String(rule.match || '');
  return {
    id: rule.id || '',
    field,
    match,
    action: rule.action,
    label: String(rule.label || ''),
    // 화면에 그대로 쓸 한 줄. 여기서 만들어 보내야 화면 코드가 이 모듈을 몰라도 된다
    // (렌더러는 src/를 require 할 수 없다).
    why: `${ACTION_NAMES[rule.action] || rule.action} · ${FIELD_NAMES[field] || field} ${match}`
  };
}

/**
 * 목록에 도장을 찍는다.
 *
 * 한 메일에 규칙이 여러 개 걸릴 수 있다. 그때는 «더 센 것»이 이긴다 —
 * 스팸으로 보낼 메일을 화면에만 숨기고 두면 서버에는 그대로 쌓인다.
 * 세기: spam > hide > group. mute·read는 세기와 무관하게 함께 붙는다.
 *
 * 걸린 메일은 원본을 고치지 않고 byRule을 붙인 사본으로 돌려준다 —
 * 부르는 쪽이 같은 배열을 다시 쓰는 일이 있어서 원본을 건드리면 두 번째부터 결과가 달라진다.
 *
 * @returns {{ visible, hidden, groups, spam, read, mutedUids }}
 */
function apply(messages, rules) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.on !== false) : [];
  const visible = [];
  const hidden = [];
  const spam = [];
  const read = [];
  const mutedUids = new Set();
  const groups = new Map();   // 이름 → 메일들

  for (const msg of messages || []) {
    const matched = list.filter((r) => hits(r, msg));
    if (!matched.length) { visible.push(msg); continue; }

    if (matched.some((r) => r.action === 'mute')) mutedUids.add(msg.uid);

    const strong = matched.find((r) => r.action === 'spam')
      || matched.find((r) => r.action === 'hide')
      || matched.find((r) => r.action === 'group');

    // 도장은 «가장 센 것»으로 찍는다. 센 것이 없으면 걸린 첫 규칙 —
    // 알림만 끈 메일도 «왜 조용한가»를 말해줄 수 있어야 한다.
    const marked = { ...msg, byRule: stamp(strong || matched[0]) };

    if (matched.some((r) => r.action === 'read')) read.push(marked);
    if (!strong) { visible.push(marked); continue; }

    if (strong.action === 'spam') { spam.push(marked); hidden.push(marked); continue; }
    if (strong.action === 'hide') { hidden.push(marked); continue; }

    // 묶기 — 이름을 안 정했으면 조건 글자를 그대로 쓴다
    const name = String(strong.label || strong.match || '묶음').trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(marked);
  }

  return {
    visible,
    hidden,
    spam,
    read,
    mutedUids,
    groups: [...groups].map(([name, items]) => ({ name, items }))
  };
}

/**
 * 폴더로 나눈다 — 아웃룩의 폴더 창처럼 한 번에 한 칸만 본다.
 *
 * 위젯에 한 목록만 보이면, 숨긴 메일은 «어딘가로 사라진 것»이 된다.
 * 규칙이 너무 넓게 잡았을 때 알아챌 방법이 없으면 필터는 위험한 기능이다.
 * 숨김을 폴더로 만들어 두면 언제든 열어볼 수 있고, 거기서 규칙을 되돌릴 수 있다.
 *
 * @param cap 폴더 하나에 담을 최대 통수 (위젯이 좁다)
 */
/**
 * @param accounts 주면 계정마다 칸을 하나씩 낸다([{id,name}]). 안 주면 하나로 합친다.
 *   메일이 한 통도 없는 계정도 칸은 낸다 — 안 그러면 계정이 사라진 것처럼 보인다.
 */
function folders(result, cap = 50, { accounts = null } = {}) {
  const box = (id, name, items) => ({
    id,
    name,
    items: items.slice(0, cap),
    count: items.length,
    unread: items.filter((m) => !m.seen).length
  });

  // 한 계정 몫의 칸들 — 받은 / 묶음 / 숨김.
  // acct를 달아 둔다. 화면은 계정을 먼저 고르고 그 안에서 폴더를 고르므로,
  // id는 «어떤 종류의 칸인가»만 뜻하고(받은·숨김·묶음) 계정은 acct로 가른다.
  const setFor = (visible, groups, hidden, acct) => {
    const o = [{ ...box('in', acct ? '받은' : '메일', visible), acct }];
    for (const g of groups) {
      if (g.items.length) o.push({ ...box('g:' + g.name, g.name, g.items), acct });
    }
    // 숨길 것이 없으면 빈 폴더를 만들지 않는다 — 좁은 자리에 쓸모없는 칸이 는다
    if (hidden.length) o.push({ ...box('hidden', '숨김', hidden), acct });
    return o;
  };

  if (!accounts || !accounts.length) {
    return setFor(result.visible, result.groups, result.hidden, '');
  }

  const out = [];
  const mine = (list, id) => list.filter((m) => m.accountId === id);
  for (const a of accounts) {
    out.push(...setFor(
      mine(result.visible, a.id),
      result.groups.map((g) => ({ name: g.name, items: mine(g.items, a.id) })),
      mine(result.hidden, a.id),
      a.id
    ));
  }
  // 계정을 지웠는데 목록에 남은 메일 — 조용히 사라지면 안 된다
  const known = new Set(accounts.map((a) => a.id));
  const orphans = result.visible.filter((m) => !known.has(m.accountId));
  if (orphans.length) out.push({ ...box('in', '받은', orphans), acct: '(그 밖)' });
  return out;
}

/** 오른쪽 클릭으로 규칙을 만들 때 쓸 기본값 */
function ruleFor(msg, action) {
  const addr = String(msg && msg.fromAddress || '').trim();
  const domain = addr.includes('@') ? '*@' + addr.split('@')[1] : '';
  return {
    field: 'from',
    match: addr || String((msg && msg.from) || '').trim(),
    domain,
    action: ACTIONS.includes(action) ? action : 'hide',
    on: true
  };
}

/** 규칙 한 줄을 사람이 읽는 말로 — «왜 사라졌나»를 답해야 한다 */
function describe(rule) {
  const s = stamp(rule);
  return s ? s.why : '';
}

module.exports = {
  apply, folders, hits, toMatcher, ruleFor, describe,
  FIELDS, ACTIONS, ACTION_NAMES, FIELD_NAMES
};

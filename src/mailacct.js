'use strict';
// 메일 계정 — «지금 쓸 수 있나», 못 쓰면 «왜 못 쓰나».
//
// 예전에는 비밀번호를 못 푼 계정을 말없이 빼기만 했다. 그래서 계정이 둘 다 저장돼 있는데
// «쓸 수 있는 계정이 없습니다»만 떴고, 꺼진 건지 비밀번호가 안 풀리는 건지 알 길이 없었다
// (기록에도 «저장된 계정 2개»뿐이었다). 까닭을 한 가지로 정해 두고, 화면·알림·기록이 같은 말을 쓴다.
//
// electron 을 부르지 않는다 — 비밀번호 풀기(open)와 «이 PC에서 풀 수 있나»(available)는
// 부르는 쪽이 넘겨준다. 그래야 창 없이, node 로도 시험할 수 있다.

/**
 * 못 쓰는 까닭. 앞에 있을수록 먼저 본다.
 *   off        — 사용자가 꺼 둠 (일부러 한 일이라 고칠 것이 없다)
 *   incomplete — 서버 주소나 아이디가 비어 있음 (비밀번호만으로는 못 고친다)
 *   nostore    — 이 PC에서 비밀번호를 풀고 잠그는 기능(DPAPI)을 못 씀
 *   nopass     — 저장된 비밀번호가 없음
 *   locked     — 저장은 돼 있는데 이 PC에서 풀리지 않음 (윈도우 암호를 초기화했거나 파일을 옮겨 온 경우)
 */
const PROBLEMS = ['off', 'incomplete', 'nostore', 'nopass', 'locked'];

/** 섞여 있을 때 먼저 말하는 차례 — summary 와 기록의 셈이 같은 차례를 쓴다 (까닭은 summary 주석) */
const PRIORITY = ['nostore', 'locked', 'nopass', 'incomplete', 'off'];

/** 계정 줄에 붙이는 짧은 말 — 꺼짐은 스위치가 이미 말하므로 비워 둔다 */
const LABEL = {
  off: '',
  incomplete: '서버·아이디 없음',
  nostore: '비밀번호 저장 불가',
  nopass: '비밀번호 없음',
  locked: '비밀번호 다시 필요'
};

/**
 * 계정 줄 아래에 붙이는 설명 — 무엇을 하면 되는지까지. 짧게 쓴다:
 * 계정마다 붙고, 쓸 수 있는 계정이 없으면 목록 맨 위에 summary 가 한 번 더 나온다.
 */
const HINT = {
  off: '',
  incomplete: '서버 주소나 아이디가 비어 있습니다 — 지우고 다시 추가해 주세요.',
  nostore: '이 PC에서는 비밀번호를 안전하게 저장할 수 없습니다.',
  nopass: '저장된 비밀번호가 없습니다. 넣어도 서명·설정은 그대로입니다.',
  // 윈도우 암호를 «바꾸는» 것으로는 안 생긴다 — 관리자가 초기화했거나, 파일을 다른 PC·사용자에서 옮겨 온 경우다
  locked: '저장된 비밀번호가 이 PC에서 풀리지 않습니다 (윈도우 암호 초기화·설정 파일 이동 등).'
    + ' 다시 넣어도 서명·설정은 그대로입니다.'
};

/** 기록(evlog)에 세어 적는 이름 */
const COUNT = {
  off: '꺼짐',
  incomplete: '서버·아이디 없음',
  nostore: '저장 불가',
  nopass: '비밀번호 없음',
  locked: '비밀번호 못 풂'
};

/**
 * 계정 하나를 가른다. 비밀번호는 한 번만 푼다 — 푼 값이 필요한 쪽(접속)이 그대로 쓴다.
 * @param account 저장된 계정 (sealed 포함)
 * @param env { available: 이 PC에서 풀 수 있나, open: sealed → 평문|null }
 * @returns {{ problem: null|string, pass: string|null }}
 */
function check(account, { available = false, open = null } = {}) {
  const a = account || {};
  if (a.enabled === false) return { problem: 'off', pass: null };
  if (!a.host || !a.user) return { problem: 'incomplete', pass: null };
  // 못 쓰는 PC에서는 저장된 것이 있든 없든 풀 수 없다 — «다시 넣기»로도 안 고쳐진다
  if (!available) return { problem: 'nostore', pass: null };
  if (!a.sealed) return { problem: 'nopass', pass: null };
  let pass = null;
  try { pass = typeof open === 'function' ? open(a.sealed) : null; } catch { pass = null; }
  if (!pass) return { problem: 'locked', pass: null };
  return { problem: null, pass };
}

/** null(쓸 수 있음) | 'off' | 'incomplete' | 'nostore' | 'nopass' | 'locked' */
function classify(account, env) {
  return check(account, env).problem;
}

/** 비밀번호를 다시 넣으면 고쳐지는 까닭인가 */
function fixable(problem) {
  return problem === 'locked' || problem === 'nopass';
}

const label = (problem) => LABEL[problem] || '';
const hint = (problem) => HINT[problem] || '';

/** 화면에 보이는 계정 이름만 쓴다 — 아이디·서버는 싣지 않는다 */
function nameOf(account) {
  const n = String((account && account.name) || '').trim();
  return n || '이름 없는';
}

/** «회사»·«개인» / «회사» 외 2개 */
function names(group) {
  const list = group.map((x) => `«${nameOf(x.account)}»`);
  return list.length <= 2 ? list.join('·') : `${list[0]} 외 ${list.length - 1}개`;
}

/** 기록용 — «비밀번호 못 풂 2 · 꺼짐 1» (쓸 수 있는 계정은 세지 않는다) */
function tally(list) {
  const items = (list || []).filter((x) => x && x.problem);
  return PRIORITY
    .map((p) => [p, items.filter((x) => x.problem === p).length])
    .filter(([, n]) => n)
    .map(([p, n]) => `${COUNT[p]} ${n}`)
    .join(' · ');
}

const NONE = '메일 계정이 없습니다 — 설정 › 메일에서 추가하세요';

/**
 * 쓸 수 있는 계정이 없을 때 사용자에게 할 말 한 줄.
 *
 * 까닭이 섞여 있으면 «고치면 메일이 다시 오는 것»을 먼저 말한다:
 *   저장 불가(PC 전체 문제) → 못 풂 → 비밀번호 없음 → 서버·아이디 없음 → 꺼짐.
 * 꺼진 계정은 사용자가 일부러 끈 것이라 맨 뒤다 — 켜 둔 계정이 망가진 게 더 급하다.
 * 계정 이름은 까닭이 계정마다 다를 때만 붙인다 (전부 같으면 «어느 것»이 필요 없다).
 *
 * @param list [{ account: { name }, problem }] — 계정 전부
 * @returns 할 말. 쓸 수 있는 계정이 하나라도 있으면 ''.
 */
function summary(list) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return NONE;
  const bad = items.filter((x) => x.problem);
  if (bad.length < items.length) return '';
  const of = (p) => bad.filter((x) => x.problem === p);
  // 까닭이 계정마다 다를 때만 이름을 댄다
  const who = (group) => (group.length < bad.length ? names(group) : '');

  if (of('nostore').length) return '이 PC에서는 비밀번호를 안전하게 저장할 수 없습니다';
  const locked = of('locked');
  if (locked.length) {
    const w = who(locked);
    return `${w ? `${w} 계정의 ` : ''}저장된 비밀번호를 이 PC에서 풀 수 없습니다`
      + ' — 설정 › 메일에서 «비밀번호 다시 넣기»를 눌러 주세요';
  }
  const nopass = of('nopass');
  if (nopass.length) {
    const w = who(nopass);
    return `${w ? `${w} 계정에 ` : ''}저장된 비밀번호가 없습니다`
      + ' — 설정 › 메일에서 «비밀번호 다시 넣기»를 눌러 주세요';
  }
  const incomplete = of('incomplete');
  if (incomplete.length) {
    const w = who(incomplete);
    return `${w ? `${w} 계정에` : '메일 계정에'} 서버 주소나 아이디가 비어 있습니다`
      + ' — 설정 › 메일에서 지우고 다시 추가해 주세요';
  }
  // 남은 것은 꺼짐뿐이다
  return bad.length > 1
    ? '메일 계정이 모두 꺼져 있습니다 (설정 › 메일에서 켜세요)'
    : '메일 계정이 꺼져 있습니다 (설정 › 메일에서 켜세요)';
}

module.exports = { PROBLEMS, PRIORITY, NONE, check, classify, fixable, label, hint, tally, summary };

'use strict';
// 메일 계정 가르기 — 창을 하나도 안 띄우고 src/mailacct.js 만 부른다 (node 로도, npx electron 으로도 돈다).
//
// «메일 계정이 등록돼 있는데 갑자기 쓸 수 있는 계정이 없다»는 말을 들었다. 기록에는 30초마다
// «건너뜀 — 쓸 수 있는 계정 없음 (저장된 계정 2개)»뿐이었다 — 비밀번호를 못 푼 계정을 말없이 빼서
// 꺼진 건지, 비밀번호가 안 풀리는 건지 알 길이 없었다. 이제 까닭을 하나로 정하고 할 말을 만든다.
//   [1] classify — 갈래마다 (꺼짐 → 빈칸 → 저장 불가 → 비밀번호 없음 → 못 풂 → 쓸 수 있음)
//   [2] check — 비밀번호는 한 번만 풀고, 꺼졌거나 못 쓰는 PC면 아예 풀지 않는다
//   [3] summary — 할 말 한 줄. 섞이면 고칠 수 있는 것부터, 계정마다 다를 때만 이름을 댄다
//   [4] tally — 기록에 적는 셈
//   [5] 실제로 겪은 판 — 계정 둘 다 비밀번호가 이 PC에서 안 풀린다
//   [6] 비밀번호를 Windows 자격 증명 관리자에 둔 뒤 — DPAPI 가 깨져도 «저장 불가»가 아니고,
//       항목이 없어졌거나 옛 값이 안 풀리면 «비밀번호 다시 넣기»로 고친다
//       (진짜 자격 증명 관리자는 credstore.test.js·mailrepass.test.js 가 만진다 — 여기서는 풀기를 흉내 낸다)
const path = require('path');
const acct = require(path.join(__dirname, '..', 'src', 'mailacct.js'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 저장된 계정 모양 (store.addMailAccount 와 같은 칸)
const base = (over = {}) => ({
  id: 'm1', name: '회사', provider: 'custom', host: 'imap.corp.example', port: 993,
  user: 'kim@corp.example', sealed: 'c2VhbGVk', enabled: true, ...over
});
const opens = (plain) => {
  const f = (sealed) => { f.calls.push(sealed); return plain; };
  f.calls = [];
  return f;
};
const ENV = (open = opens('비밀')) => ({ available: true, open });

// ── [1] classify ─────────────────────────────────
console.log('\n[1] classify — 갈래마다');
ok(acct.classify(base(), ENV()) === null, '다 갖췄고 풀리면 null (쓸 수 있음)');
ok(acct.classify(base({ enabled: undefined }), ENV()) === null, 'enabled 가 없으면 켜진 것으로 본다 (예전 계정)');
ok(acct.classify(base({ enabled: false }), ENV()) === 'off', '꺼 두면 off');
ok(acct.classify(base({ enabled: false, host: '', sealed: null }), { available: false }) === 'off',
  '꺼진 계정은 다른 게 망가져 있어도 off (일부러 끈 것이 먼저다)');
ok(acct.classify(base({ host: '' }), ENV()) === 'incomplete', '서버 주소가 비면 incomplete');
ok(acct.classify(base({ user: '' }), ENV()) === 'incomplete', '아이디가 비면 incomplete');
ok(acct.classify(base({ host: undefined, user: undefined }), ENV()) === 'incomplete', '둘 다 없어도 incomplete');
ok(acct.classify(base(), { available: false, open: opens('비밀') }) === 'nostore', '이 PC에서 못 풀고 못 잠그면 nostore');
ok(acct.classify(base({ sealed: null }), { available: false }) === 'nostore', '저장된 게 없어도 PC 가 못 쓰면 nostore (다시 넣어도 안 된다)');
ok(acct.classify(base(), undefined) === 'nostore', 'env 를 안 주면 못 쓰는 PC 로 본다');
ok(acct.classify(base({ sealed: null }), ENV()) === 'nopass', '저장된 비밀번호가 없으면 nopass');
ok(acct.classify(base({ sealed: '' }), ENV()) === 'nopass', '빈 값도 nopass');
ok(acct.classify(base(), ENV(opens(null))) === 'locked', '풀기가 null 이면 locked');
ok(acct.classify(base(), ENV(opens(''))) === 'locked', '풀기가 빈 글이면 locked');
ok(acct.classify(base(), ENV(() => { throw new Error('DPAPI'); })) === 'locked', '풀기가 터져도 locked (앱은 안 죽는다)');
ok(acct.classify(base(), { available: true }) === 'locked', '풀기를 안 주면 locked');
ok(acct.classify(null, ENV()) === 'incomplete', '계정이 없으면(null) incomplete');
for (const p of acct.PROBLEMS) ok(acct.PRIORITY.includes(p), `PRIORITY 에 ${p} 가 있다`);
ok(acct.PRIORITY.length === acct.PROBLEMS.length, 'PRIORITY 와 PROBLEMS 가 같은 까닭들이다');

// ── [2] check ────────────────────────────────────
console.log('\n[2] check — 비밀번호는 한 번만, 필요할 때만 푼다');
{
  const f = opens('app-pass');
  const r = acct.check(base(), { available: true, open: f });
  ok(r.problem === null && r.pass === 'app-pass', '쓸 수 있으면 푼 비밀번호를 같이 준다', { problem: r.problem });
  ok(f.calls.length === 1 && f.calls[0] === 'c2VhbGVk', '한 번만, 저장된 값으로 푼다', f.calls.length);
  const off = opens('x');
  acct.check(base({ enabled: false }), { available: true, open: off });
  ok(off.calls.length === 0, '꺼진 계정은 풀지 않는다');
  const nost = opens('x');
  acct.check(base(), { available: false, open: nost });
  ok(nost.calls.length === 0, '못 쓰는 PC 에서는 풀지 않는다');
  const inc = opens('x');
  acct.check(base({ user: '' }), { available: true, open: inc });
  ok(inc.calls.length === 0, '빈칸 계정은 풀지 않는다');
  const lk = acct.check(base(), ENV(opens(null)));
  ok(lk.problem === 'locked' && lk.pass === null, '못 풀면 pass 는 null');
}
ok(acct.fixable('locked') && acct.fixable('nopass'), 'locked·nopass 는 비밀번호를 다시 넣으면 고쳐진다');
ok(!['off', 'incomplete', 'nostore', null, undefined].some((p) => acct.fixable(p)), '나머지는 다시 넣어도 안 고쳐진다');
ok(acct.label('locked') === '비밀번호 다시 필요', '못 풂 줄 글자', acct.label('locked'));
ok(acct.label('off') === '' && acct.hint('off') === '', '꺼짐은 줄에 따로 쓰지 않는다 (스위치가 말한다)');
ok(acct.label(null) === '' && acct.hint(null) === '', '쓸 수 있으면 빈 글');
for (const p of ['incomplete', 'nostore', 'nopass', 'locked']) {
  ok(!!acct.label(p) && !!acct.hint(p), `${p} — 줄 글자와 설명이 있다`, { label: acct.label(p) });
}

// ── [3] summary ──────────────────────────────────
console.log('\n[3] summary — 할 말 한 줄');
const E = (name, problem, id = name) => ({ account: { id, name }, problem });
const LOCKED = '저장된 비밀번호를 이 PC에서 풀 수 없습니다 — 설정 › 메일에서 «비밀번호 다시 넣기»를 눌러 주세요';
const cases = [
  ['계정이 없다', [], '메일 계정이 없습니다 — 설정 › 메일에서 추가하세요'],
  ['null 도 없는 것', null, '메일 계정이 없습니다 — 설정 › 메일에서 추가하세요'],
  ['하나라도 쓸 수 있으면 빈 말', [E('회사', null), E('개인', 'locked')], ''],
  ['다 못 풂 — 이름 없이', [E('회사', 'locked'), E('개인', 'locked')], LOCKED],
  ['하나뿐인 계정이 못 풂', [E('회사', 'locked')], LOCKED],
  ['다 꺼짐', [E('회사', 'off'), E('개인', 'off')], '메일 계정이 모두 꺼져 있습니다 (설정 › 메일에서 켜세요)'],
  ['하나뿐인 계정이 꺼짐', [E('회사', 'off')], '메일 계정이 꺼져 있습니다 (설정 › 메일에서 켜세요)'],
  ['저장 불가', [E('회사', 'nostore'), E('개인', 'nostore')], '이 PC에서는 비밀번호를 안전하게 저장할 수 없습니다'],
  ['저장 불가가 가장 먼저 (꺼짐·빈칸과 섞여도)', [E('회사', 'off'), E('개인', 'nostore'), E('옛', 'incomplete')],
    '이 PC에서는 비밀번호를 안전하게 저장할 수 없습니다'],
  ['켜 둔 계정의 못 풂이 꺼진 것보다 먼저 — 이름을 댄다', [E('회사', 'off'), E('개인', 'locked')],
    `«개인» 계정의 ${LOCKED}`],
  ['못 풂이 비밀번호 없음보다 먼저', [E('회사', 'nopass'), E('개인', 'locked')], `«개인» 계정의 ${LOCKED}`],
  ['비밀번호 없음', [E('회사', 'nopass')],
    '저장된 비밀번호가 없습니다 — 설정 › 메일에서 «비밀번호 다시 넣기»를 눌러 주세요'],
  ['비밀번호 없음이 빈칸보다 먼저', [E('옛', 'incomplete'), E('회사', 'nopass')],
    '«회사» 계정에 저장된 비밀번호가 없습니다 — 설정 › 메일에서 «비밀번호 다시 넣기»를 눌러 주세요'],
  ['빈칸', [E('옛', 'incomplete')],
    '메일 계정에 서버 주소나 아이디가 비어 있습니다 — 설정 › 메일에서 지우고 다시 추가해 주세요'],
  ['빈칸이 꺼짐보다 먼저', [E('옛', 'incomplete'), E('회사', 'off')],
    '«옛» 계정에 서버 주소나 아이디가 비어 있습니다 — 설정 › 메일에서 지우고 다시 추가해 주세요'],
  ['둘이면 이름 둘', [E('회사', 'locked'), E('개인', 'locked'), E('옛', 'off')], `«회사»·«개인» 계정의 ${LOCKED}`],
  ['셋 넘으면 «외 n개»', [E('가', 'locked'), E('나', 'locked'), E('다', 'locked'), E('라', 'off')],
    `«가» 외 2개 계정의 ${LOCKED}`],
  ['이름이 비면 «이름 없는»', [E('', 'locked', 'm9'), E('개인', 'off')], `«이름 없는» 계정의 ${LOCKED}`]
];
for (const [what, list, want] of cases) {
  const got = acct.summary(list);
  ok(got === want, what, got === want ? undefined : { got, want });
}
{
  // 계정 이름 말고는 아무것도 싣지 않는다 — 아이디·서버는 화면이 이미 보여주는 곳에만
  const list = [{ account: base({ name: '회사' }), problem: 'locked' }, { account: base({ id: 'm2', name: '개인' }), problem: 'off' }];
  const s = acct.summary(list);
  ok(!/corp\.example|kim@|c2VhbGVk/.test(s), '할 말에 아이디·서버·잠긴 값이 들어가지 않는다', s);
}

// ── [4] tally ────────────────────────────────────
console.log('\n[4] tally — 기록에 적는 셈');
ok(acct.tally([E('a', 'locked'), E('b', 'locked')]) === '비밀번호 못 풂 2', '못 풂 둘', acct.tally([E('a', 'locked'), E('b', 'locked')]));
{
  const t = acct.tally([E('a', 'off'), E('b', 'locked'), E('c', null), E('d', 'nostore'), E('e', 'incomplete'), E('f', 'nopass')]);
  ok(t === '저장 불가 1 · 비밀번호 못 풂 1 · 비밀번호 없음 1 · 서버·아이디 없음 1 · 꺼짐 1',
    '섞이면 summary 와 같은 차례, 쓸 수 있는 것은 안 센다', t);
}
ok(acct.tally([]) === '' && acct.tally(null) === '' && acct.tally([E('a', null)]) === '', '셀 것이 없으면 빈 글');

// ── [5] 실제로 겪은 판 ────────────────────────────
console.log('\n[5] 계정 둘 다 비밀번호가 이 PC에서 안 풀린다');
{
  // DPAPI 키가 바뀌면 safeStorage.decryptString 이 던진다 — secret.open 은 그걸 null 로 바꾼다
  const secretOpen = () => null;
  const stored = [base({ id: 'm1', name: '회사' }), base({ id: 'm2', name: '개인', sealed: 'b3RoZXI=' })];
  const checks = stored.map((a) => ({ account: { id: a.id, name: a.name }, ...acct.check(a, { available: true, open: secretOpen }) }));
  const usable = checks.filter((c) => !c.problem);
  ok(usable.length === 0, '쓸 수 있는 계정이 없다 (예전과 같이 빠진다)');
  ok(checks.every((c) => c.problem === 'locked'), '둘 다 locked 로 가려진다');
  const line = `건너뜀 — 쓸 수 있는 계정 없음 (저장된 계정 ${checks.length}개 · ${acct.tally(checks)})`;
  ok(line === '건너뜀 — 쓸 수 있는 계정 없음 (저장된 계정 2개 · 비밀번호 못 풂 2)', '기록 한 줄에 까닭이 들어간다', line);
  ok(acct.summary(checks) === LOCKED, '사용자에게는 «비밀번호 다시 넣기»를 하라고 말한다', acct.summary(checks));
  ok(checks.every((c) => acct.fixable(c.problem)), '두 계정 모두 설정에서 비밀번호만 다시 넣으면 된다');
}

// ── [6] 자격 증명 관리자에 둔 뒤 ──────────────────
console.log('\n[6] 비밀번호를 자격 증명 관리자에 둔 뒤');
{
  // secret.open 흉내 — 'wincred:' 는 자격 증명 관리자에서 찾고(없으면 null), 옛 값은 DPAPI 로 푼다.
  // 이 PC처럼 DPAPI 가 깨졌으면 옛 값은 늘 null 이다
  const vault = new Map([['Hibi/mail/m1', 'app-pass']]);
  const secretOpen = (sealed) => (String(sealed).startsWith('wincred:') ? vault.get(String(sealed).slice(8)) || null : null);
  // secret.available = 자격 증명 관리자 || DPAPI — 자격 증명 관리자가 되면 DPAPI 가 깨져도 참이다
  const env = { available: true, open: secretOpen };
  const inVault = base({ id: 'm1', sealed: 'wincred:Hibi/mail/m1' });
  const gone = base({ id: 'm2', name: '개인', sealed: 'wincred:Hibi/mail/m2' });
  const oldBlob = base({ id: 'm3', name: '옛', sealed: 'b2xkLWRwYXBp' });
  const r = acct.check(inVault, env);
  ok(r.problem === null && r.pass === 'app-pass', '자격 증명 관리자에 있으면 쓸 수 있다', { problem: r.problem });
  ok(acct.classify(gone, env) === 'locked', '표시는 있는데 항목이 없어졌으면 locked (nostore 가 아니다)');
  ok(acct.classify(oldBlob, env) === 'locked', 'DPAPI 가 깨져 옛 값이 안 풀리면 locked (nostore 가 아니다)');
  ok(acct.fixable(acct.classify(gone, env)) && acct.fixable(acct.classify(oldBlob, env)), '둘 다 «비밀번호 다시 넣기»로 고친다');
  ok(acct.classify(base({ sealed: null }), env) === 'nopass', '표시가 없으면 여전히 nopass');
  ok(acct.classify(inVault, { available: false, open: secretOpen }) === 'nostore',
    'nostore 는 잠가 둘 곳이 하나도 없을 때뿐이다 (자격 증명 관리자도 DPAPI 도 못 씀)');
  const checks = [inVault, gone, oldBlob].map((a) => ({ account: { id: a.id, name: a.name }, ...acct.check(a, env) }));
  ok(acct.summary(checks) === '', '하나라도 쓸 수 있으면 할 말이 없다');
  const broken = checks.slice(1);
  ok(acct.summary(broken) === LOCKED && acct.tally(broken) === '비밀번호 못 풂 2', '못 쓰는 것만 남으면 «다시 넣기»를 하라고 한다',
    { summary: acct.summary(broken), tally: acct.tally(broken) });
  ok(/Windows 자격 증명/.test(acct.hint('locked')) && /서명·설정은 그대로/.test(acct.hint('locked')),
    'locked 설명이 윈도우 자격 증명 문제도 까닭으로 든다', acct.hint('locked'));
  ok(!/wincred|Hibi\/mail/.test(acct.summary(broken) + acct.hint('locked') + acct.label('locked')), '할 말에 저장 위치 이름이 새지 않는다');
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

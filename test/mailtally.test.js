'use strict';
// 메일 셈하기 — «무엇이 새로 왔나»와 «무엇을 다시 해볼까» (src/mailtally.js).
//
// 창도 Electron 도 쓰지 않는다 — main.js 를 싣지 않고, 메일 서버·자격 증명 관리자에도 가지 않는 순수 계산이다.
//   [1] 지금 동작 잠금 — 인자 셋인 freshCount, known 이 null 이면 0, 조용히 시킨 열쇠 제외, WorkLog 의 재시도·포기
//   [2] 경계 — 장부가 있는 계정은 uid > top 만 센다. 처음 보는 계정은 0
//   [3] 폴링 실패 — 실패한 계정의 장부는 그대로이고, 다음 성공 때 창의 안 읽은 메일이 새 메일로 안 잡힌다
//   [4] UIDVALIDITY 변경 — 그 판은 세지 않고 장부를 다시 잡는다
//   [5] isNew — 첫 폴링과 처음 보는 계정은 주소록에 넣고, 창으로 밀려 들어온 옛 메일은 넣지 않는다
//   [6] 규칙의 바닥 — 창의 최솟값까지만 서버 동작이 나간다
//   [7] 소스 검사 — 선언보다 먼저 쓴 이름이 없다 (eslint.config.js 의 핵심 규칙)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mailtally = require(path.join(ROOT, 'src', 'mailtally.js'));

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const msg = (accountId, uid, seen = false) => ({ accountId, uid, seen });
const keys = (list) => new Set(list.map(mailtally.keyOf));

console.log('\n[1] 지금 동작 잠금');
{
  ok(mailtally.keyOf(msg('a', 7)) === 'a:7' && mailtally.keyOf({ uid: 7 }) === ':7', '열쇠는 계정:uid — UID 는 계정마다 따로 돈다');
  const list = [msg('a', 1), msg('a', 2, true), msg('b', 1)];

  const first = mailtally.freshCount(list, null, new Set());
  ok(first.fresh === 0 && first.primed === false && first.known.size === 3, 'known 이 null(첫 폴링)이면 0 — 쌓여 있던 메일은 새 메일이 아니다', first.fresh);

  const seenAll = mailtally.freshCount(list, keys(list), new Set());
  ok(seenAll.fresh === 0 && seenAll.primed === true, '지난번에 본 것뿐이면 0', seenAll.fresh);

  const more = [...list, msg('a', 3), msg('a', 4, true), msg('b', 2), msg('b', 3)];
  const r = mailtally.freshCount(more, keys(list), new Set());
  ok(r.fresh === 3, '지난번에 없던 것 중 안 읽은 것만 센다 (읽은 것 제외)', r.fresh);
  ok(r.known.size === 7 && r.known.has('b:3'), 'known 은 이번 목록으로 통째로 바뀐다', r.known.size);

  const q = mailtally.freshCount(more, keys(list), new Set(['a:3', 'b:2']));
  ok(q.fresh === 1, '조용히 시킨 열쇠는 세지 않는다', q.fresh);
  ok(mailtally.freshCount(more, keys(list)).fresh === 3, 'quiet 를 안 줘도 된다');
  ok(mailtally.freshCount(null, new Set()).fresh === 0, '목록이 없어도 0');

  // 지금의 약점도 그대로 잠근다 — 인자 셋이면 이 동작이다. 경계는 네 번째 인자를 줄 때만 걸린다
  const failed = mailtally.freshCount([msg('b', 1), msg('b', 2)], new Set(['a:1']), new Set());
  ok(failed.fresh === 2, '인자 셋: known 에서 빠진 계정의 안 읽은 메일은 전부 새 메일이 된다', failed.fresh);
}
{
  const NOW = 1_000_000;
  const log = new mailtally.WorkLog({ tries: 3, retryMs: 100 });
  const m = msg('a', 1);
  const k = mailtally.keyOf(m);
  ok(log.ready('spam', k, NOW) && log.pick('spam', [m], NOW).length === 1, '처음에는 해 봐도 된다');
  ok(JSON.stringify(log.bad('spam', [k], NOW)) === '{"n":1,"giveUp":false}', '첫 실패는 그만두지 않는다');
  ok(!log.ready('spam', k, NOW + 99) && log.ready('spam', k, NOW + 100), '실패한 것은 시간을 두고 다시');
  ok(log.ready('read', k, NOW), '동작마다 따로 센다');
  log.bad('spam', [k], NOW + 100);
  const third = log.bad('spam', [k], NOW + 200);
  ok(third.n === 3 && third.giveUp === true && !log.ready('spam', k, NOW + 100000), '세 번 실패하면 그만둔다', third);
  log.ok('read', [k]);
  ok(!log.ready('read', k, NOW) && log.pick('read', [m], NOW).length === 0, '서버가 받아준 것은 다시 안 한다');
  log.clear();
  ok(log.ready('spam', k, NOW) && log.ready('read', k, NOW), '규칙이 바뀌면 판단을 전부 버린다');
  const healed = new mailtally.WorkLog({ tries: 3, retryMs: 100 });
  healed.bad('spam', [k], NOW);
  healed.ok('spam', [k]);
  ok(healed.fail.size === 0, '성공하면 실패 기록이 지워진다');
}

/** 폴링 한 번의 결과처럼 — 계정 하나 */
const polled = (id, top, v, uids = []) => ({ id, top, uidValidity: v, messages: uids.map((u) => msg(id, u)) });
const V = 1700000000n;
const countWith = (list, known, tops, results) => mailtally.freshCount(list, known, new Set(), mailtally.boundsFor(tops, results)).fresh;

console.log('\n[2] 경계');
{
  const tops = new Map([['a', { top: 100, v: String(V) }]]);
  const known = new Set(['a:100']);
  const list = [msg('a', 100), msg('a', 90), msg('a', 101), msg('a', 102, true), msg('new', 500)];
  const r = mailtally.freshCount(list, known, new Set(), tops);
  ok(r.fresh === 1, 'uid > top 인 안 읽은 메일만 — 경계 아래의 옛 메일(90)·읽은 메일·처음 보는 계정은 세지 않는다', r.fresh);
  ok(r.known.size === 5 && r.primed === true, 'known 은 그대로 이번 목록으로 바뀐다', r.known.size);
  ok(mailtally.freshCount(list, null, new Set(), tops).fresh === 0, 'known 이 null 이면 경계와 상관없이 0');
  ok(mailtally.freshCount([msg('a', 101)], new Set(), new Set(['a:101']), tops).fresh === 0, '조용히 시킨 열쇠는 경계 위라도 세지 않는다');
  ok(mailtally.freshCount([msg('a', 101)], new Set(), new Set(), new Map()).fresh === 0, '빈 장부를 주면 전부 처음 보는 계정 — 0');

  const a = mailtally.topsAfter(null, [polled('a', 100, V, [90, 100])]);
  ok(JSON.stringify([...a]) === JSON.stringify([['a', { top: 100, v: String(V) }]]), '장부에는 uidNext-1 과 UIDVALIDITY 글이 적힌다', [...a]);
  const b = mailtally.topsAfter(a, [polled('a', 0, V, [90, 120])]);
  ok(b.get('a').top === 120, 'top 을 모르면(UIDNEXT 없음) 창의 최댓값', b.get('a'));
  const c = mailtally.topsAfter(b, [polled('a', 0, V, [])]);
  ok(c.get('a').top === 120, '창이 비어도 경계는 내려가지 않는다 — 안 읽은 메일을 다 읽으면 창의 최댓값이 줄어든다', c.get('a'));
  ok(a.get('a').top === 100 && a !== b, '옛 장부를 고치지 않고 새 Map 을 준다');
  const none = mailtally.topsAfter(null, [polled('z', 0, V, [])]);
  ok(none.get('z').top === 0, '빈 폴더의 첫 폴링은 0', none.get('z'));
}

console.log('\n[3] 폴링 실패');
{
  // 첫 폴링: 두 계정 다 성공
  let tops = mailtally.topsAfter(new Map(), [polled('a', 50, V, [48, 50]), polled('b', 70, V, [65, 70])]);
  let known = new Set(['a:48', 'a:50', 'b:65', 'b:70']);
  // 둘째: b 가 실패 — results 에 b 가 없다. known 에서 b 가 빠진다
  const second = [polled('a', 50, V, [48, 50])];
  const r2 = mailtally.freshCount([msg('a', 48), msg('a', 50)], known, new Set(), mailtally.boundsFor(tops, second));
  known = r2.known;
  tops = mailtally.topsAfter(tops, second);
  ok(r2.fresh === 0 && !known.has('b:70') && (tops.get('b') || {}).top === 70, '실패한 계정의 장부는 그대로 남는다', [...tops]);
  // 셋째: b 가 돌아온다 — 창의 안 읽은 메일은 known 에 없지만 경계 아래다
  const third = [polled('a', 50, V, [48, 50]), polled('b', 70, V, [65, 70])];
  const list3 = [msg('a', 48), msg('a', 50), msg('b', 65), msg('b', 70)];
  ok(mailtally.freshCount(list3, known, new Set()).fresh === 2, '(비교) 경계가 없으면 2통이 새 메일로 잡힌다 — 이것이 고치려는 일이다');
  ok(countWith(list3, known, tops, third) === 0, '다음 성공 때 창의 안 읽은 메일이 새 메일로 안 잡힌다');
  // 그 사이 진짜 새 메일이 왔으면 그것은 센다
  const third2 = [polled('b', 72, V, [65, 70, 72])];
  ok(countWith([msg('b', 65), msg('b', 70), msg('b', 72)], known, tops, third2) === 1, '실패한 사이에 온 메일은 놓치지 않는다');
}

console.log('\n[4] UIDVALIDITY 변경');
{
  const tops = mailtally.topsAfter(new Map(), [polled('a', 1000, V, [990, 1000])]);
  const known = new Set(['a:990', 'a:1000']);
  // 번호가 새로 매겨졌다 — 작은 번호로도, 큰 번호로도 온다
  const after = [polled('a', 2000, V + 1n, [5, 1500, 2000])];
  const list = [msg('a', 5), msg('a', 1500), msg('a', 2000)];
  ok(mailtally.freshCount(list, known, new Set(), tops).fresh === 2, '(비교) 옛 장부 그대로 재면 옛 메일이 새 메일이 된다');
  ok(countWith(list, known, tops, after) === 0, '그 판은 세지 않는다');
  const next = mailtally.topsAfter(tops, after);
  ok(next.get('a').top === 2000 && next.get('a').v === String(V + 1n), '장부를 이번 값으로 다시 잡는다', next.get('a'));
  const down = mailtally.topsAfter(tops, [polled('a', 7, V + 1n, [5, 7])]);
  ok(down.get('a').top === 7, '번호가 작아져도 다시 잡는다 (내려가지 않는 규칙은 같은 번호일 때만)', down.get('a'));
  const later = [polled('a', 2001, V + 1n, [5, 1500, 2000, 2001])];
  ok(countWith([...list, msg('a', 2001)], new Set(list.map(mailtally.keyOf)), next, later) === 1, '다음 판부터 다시 센다');
  ok(!mailtally.isNew(mailtally.boundsFor(tops, after), msg('a', 2000)), '바뀐 판에는 주소록에도 넣지 않는다');
  ok(mailtally.renumbered(tops, after[0]) && !mailtally.renumbered(next, after[0]), 'renumbered — 장부와 다를 때만 참', after[0].id);
  ok(!mailtally.renumbered(new Map(), after[0]) && !mailtally.renumbered(null, after[0]), '장부에 없는 계정은 새로 매긴 것이 아니다');

  // UIDVALIDITY 를 빠뜨린 답 하나를 번호가 바뀐 것으로 읽지 않는다 — 그러면 그 판의 진짜 새 메일을 놓친다
  const holed = [polled('a', 1001, undefined, [1000, 1001])];
  ok(countWith([msg('a', 1000), msg('a', 1001)], known, tops, holed) === 1, 'UIDVALIDITY 가 빠진 답은 바뀐 것으로 치지 않는다');
  const kept = mailtally.topsAfter(tops, holed);
  ok(kept.get('a').v === String(V) && kept.get('a').top === 1001, '…장부의 v 는 그대로', kept.get('a'));
  const blank = mailtally.topsAfter(new Map(), [polled('a', 3, undefined, [3])]);
  ok(blank.get('a').v === '' && mailtally.topsAfter(blank, [polled('a', 4, V, [4])]).get('a').top === 4, '처음부터 안 주던 서버는 빈 값으로 둔다', blank.get('a'));
}

console.log('\n[5] isNew');
{
  const tops = new Map([['a', { top: 100, v: String(V) }]]);
  ok(mailtally.isNew(new Map(), msg('a', 1)) && mailtally.isNew(null, msg('a', 1)), '첫 폴링(장부 없음)은 넣는다');
  ok(mailtally.isNew(tops, msg('new', 1)), '처음 보는 계정은 넣는다 — 지금과 같다');
  ok(!mailtally.isNew(tops, msg('a', 90)), '창으로 밀려 들어온 옛 메일은 넣지 않는다');
  ok(!mailtally.isNew(tops, msg('a', 100)), '경계의 메일 자체도 넣지 않는다 — 지난번에 이미 있었다');
  ok(mailtally.isNew(tops, msg('a', 101)), '경계 위의 메일은 넣는다');
}

console.log('\n[6] 규칙의 바닥');
{
  const floors = new Map();
  mailtally.noteFloors(floors, [msg('a', 30), msg('a', 20), msg('b', 7)]);
  ok(floors.get('a') === 20 && floors.get('b') === 7, '계정마다 창의 최솟값', [...floors]);
  mailtally.noteFloors(floors, [msg('a', 5), msg('c', 9)]);
  ok(floors.get('a') === 20 && floors.get('c') === 9, '이미 있는 계정은 그대로, 없는 계정만 적는다 — 창이 밀려도 바닥은 안 내려간다', [...floors]);
  mailtally.noteFloors(floors, []);
  ok(!floors.has('d'), '메일이 없는 계정은 적지 않는다');
  ok(mailtally.aboveFloor(floors, msg('a', 20)) && mailtally.aboveFloor(floors, msg('a', 21)), '바닥과 그 위는 서버 동작이 나간다');
  ok(!mailtally.aboveFloor(floors, msg('a', 19)), '그 아래 옛 메일은 안 나간다');
  ok(!mailtally.aboveFloor(floors, msg('없음', 19)), '바닥을 모르면 안 나간다');
}

console.log('\n[7] 소스 검사');
{
  // 부르는 때는 모듈을 다 실은 뒤라 위 구역은 다 지나간다. 그래도 이 규칙은 실제로 위젯을 죽인 실수를 잡는 규칙이라 시험으로 잠근다.
  // 옵션은 eslint.config.js 와 같게 적는다 — 고장 사본(mutate-final.js)에는 그 파일이 없다
  const { Linter } = require('eslint');
  const text = fs.readFileSync(path.join(ROOT, 'src', 'mailtally.js'), 'utf8');
  const found = new Linter().verify(text, [{
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' },
    rules: { 'no-use-before-define': ['error', { functions: false, classes: true, variables: true }] }
  }], { filename: 'mailtally.js' });
  ok(found.length === 0, '선언보다 먼저 쓴 이름이 없다', found.map((m) => `${m.line}:${m.column} ${m.message}`));
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

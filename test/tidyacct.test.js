'use strict';
// 서버 정리 — 계정마다의 설정을 다루는 순수 함수 (src/tidyacct.js).
//
// 창도 Electron 도 쓰지 않는다. node 로도, npx electron 으로도 돈다.
//   [1] 다듬기 — normDays · normEntry · normMap · normResult · entryOf
//   [2] 옛 설정 옮기기 (migrate)   [3] 계정을 고친 뒤 (afterUpdate) · 모두 끄기
//   [4] 간격 (gapMs) · 차례 (dueOrder) · 상한 나누기 (capShare)   [5] mailtidy.DAYS 와 같은 목록
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tidyacct = require(path.join(ROOT, 'src', 'tidyacct.js'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] 다듬기');
{
  const { normDays, normMap, normResult, entryOf } = tidyacct;
  ok([0, 7, 30, 90].every((d) => normDays(d) === d) && Object.is(normDays(-0), 0), '0·7·30·90 은 그대로, -0 은 0');
  ok(['7', '0', 15, null, undefined, false, '', 1, NaN].every((v) => normDays(v) === 30), "'7'·'0'·15·null·false·'' 는 30");
  const raw = JSON.parse('{"__proto__":{"on":true},"a1":{"on":"yes","days":"7"},"a2":{"on":true,"days":0},"bad id":{"on":true},"a3":5,"a4":[1]}');
  const m = normMap(raw);
  ok(same(m, { a1: { on: false, days: 30 }, a2: { on: true, days: 0 } }), "'yes' 는 꺼짐, '7' 은 30, 0 은 0, __proto__·«bad id»·숫자·배열은 버림", m);
  ok(Object.getPrototypeOf(m) === Object.prototype && !('on' in Object.prototype), '…__proto__ 열쇠로 원형이 바뀌지 않는다');
  const many = {};
  for (let i = 0; i < 60; i++) many[`a${i}`] = { on: true, days: 7 };
  ok(Object.keys(normMap(many)).length === 50, '50개까지만', Object.keys(normMap(many)).length);
  ok(same(normMap({ a1: { on: true }, a2: { on: true } }, ['a2']), { a2: { on: true, days: 30 } }), '계정 목록을 주면 그 계정만 남긴다');
  ok(same(normMap(null), {}) && same(normMap([]), {}) && same(normMap('x'), {}), '객체가 아니면 빈 맵');
  ok(same(entryOf({ a1: { on: true, days: 7 } }, 'a1'), { on: true, days: 7 }) && same(entryOf({}, 'a9'), { on: false, days: 30 })
    && same(entryOf(null, 'a1'), { on: false, days: 30 }) && same(entryOf({ __proto__: null }, '__proto__'), { on: false, days: 30 }),
  'entryOf — 없는 계정·이상한 맵은 꺼짐·30일');
  ok(same(entryOf({ toString: { on: true } }, 'toString'), { on: true, days: 30 }) && same(entryOf({}, 'toString'), { on: false, days: 30 }),
    '…원형의 이름(toString)은 제 항목이 있을 때만');
  const r = normResult({ at: '5', moved: 'x', more: 1, error: 'e'.repeat(300), important: 3.7, flagged: -2, oldest: 99, blocked: 'yes', days: 0 });
  ok(r.at === 5 && r.moved === 0 && r.more === false && r.error.length === 200 && r.important === 3 && r.flagged === 0
    && r.oldest === 99 && r.blocked === false && r.days === 0 && r.kept === 0 && r.unread === 0 && r.skippedBoxes === 0,
  'normResult — 숫자는 0 이상 정수, more·blocked 는 참일 때만, 오류는 200자, 기간은 목록 값', r);
  ok(normResult(null) === undefined && normResult([1]) === undefined && normResult({}).error === null, '…객체가 아니면 없음, 빈 오류는 null');
  // 기록 없는 폴더는 건너뛴 폴더 안의 몫이다 — 손으로 고친 파일이 «건너뜀 1곳 중 기록 없음 5곳»을 그리지 않게
  ok(normResult({ skippedBoxes: 2, unsavedBoxes: 5 }).unsavedBoxes === 2 && normResult({ skippedBoxes: 3, unsavedBoxes: 1 }).unsavedBoxes === 1,
    '…unsavedBoxes 는 skippedBoxes 를 넘지 않는다');
  ok(same(Object.keys(tidyacct.normResults({ a1: { moved: 1 }, a2: 'x', 'bad id': {} })), ['a1']), 'normResults — 계정 열쇠·객체만');
}

console.log('\n[2] 옛 설정 옮기기');
{
  const READY = { mailEnabled: true, mailAutoBackup: true, mailBackupDir: 'D:\\mail' };
  const ACCS = [{ id: 'mEc', name: '이카운트' }, { id: 'mNv', name: '네이버' }, { id: 'mGm', name: 'Gmail' }, { id: 'mOff', name: '옛 계정', enabled: false }];
  let r = tidyacct.migrate({ ...READY, mailServerTidy: true, mailTidyDays: 7 }, ACCS);
  // 옛 확인 창은 MOVE 없는 서버(이카운트)를 «옮기지 않음»으로 셌다 — 복사한 뒤 지우는 방식은 묻지 않았다는 표시(copyAsk)를 단다
  ok(same(r.map, { mEc: { on: true, days: 7, copyAsk: true }, mNv: { on: true, days: 7, copyAsk: true }, mGm: { on: true, days: 7, copyAsk: true }, mOff: { on: false, days: 7 } }),
    '옛 켜짐·7일, 계정 넷(하나는 꺼짐) → 켜진 계정 셋은 켜짐·7일·«복사 길은 묻지 않음», 꺼진 계정은 꺼짐·7일', r.map);
  ok(r.note === '서버 정리 설정을 계정마다로 옮김 · 켜짐 3개 · 7일 · MOVE 없는 서버는 옮기기 전에 다시 묻습니다', '기록 — 몇 개를 켰는지와 기간', r.note);
  ok(same(tidyacct.normEntry({ on: true, days: 7, copyAsk: true }), { on: true, days: 7, copyAsk: true })
    && same(tidyacct.normEntry({ on: false, days: 7, copyAsk: true }), { on: false, days: 7 })
    && same(tidyacct.normEntry({ on: true, days: 7, copyAsk: 'yes' }), { on: true, days: 7 }),
  'copyAsk 는 켜진 항목의 true 만 남긴다 (꺼지면 다시 켤 때 묻는다)');
  ok(same(tidyacct.entryOf(r.map, 'mEc'), { on: true, days: 7, copyAsk: true }) && same(tidyacct.allOff(r.map).mEc, { on: false, days: 7 }),
    '…entryOf 는 표시를 주고, allOff 는 표시도 뗀다');
  r = tidyacct.migrate({ ...READY, mailServerTidy: true, mailTidyDays: 0 }, ACCS);
  ok(r.map.mNv.days === 0 && /· 바로( · |$)/.test(r.note), '옛 «바로»(0)는 0 그대로', r.note);
  r = tidyacct.migrate({ ...READY, mailEnabled: false, mailServerTidy: true, mailTidyDays: 30 }, ACCS);
  ok(!tidyacct.anyOn(r.map) && r.note === '서버 정리 설정을 계정마다로 옮김 · 켜짐 0개 · 30일 (조건이 모자라 모두 꺼 둠)',
    '옛 켜짐인데 메일 확인이 꺼져 있었으면 모두 끄고 «조건이 모자라 모두 꺼 둠»', r.note);
  for (const k of ['mailAutoBackup', 'mailBackupDir']) {
    r = tidyacct.migrate({ ...READY, [k]: k === 'mailBackupDir' ? '' : false, mailServerTidy: true }, ACCS);
    ok(!tidyacct.anyOn(r.map) && /모두 꺼 둠/.test(r.note), `…${k} 가 모자라도 모두 끈다`);
  }
  r = tidyacct.migrate({ ...READY, mailServerTidy: false, mailTidyDays: 15 }, ACCS);
  ok(!tidyacct.anyOn(r.map) && r.map.mNv.days === 30 && r.note === null, '옛 꺼짐·15일 → 모두 꺼짐·30일, 기록 없음', r);
  r = tidyacct.migrate({ ...READY, mailServerTidy: 'true' }, ACCS);
  ok(!tidyacct.anyOn(r.map) && r.note === null, "옛 값이 'true'(글)이면 꺼짐으로 본다");
  ok(tidyacct.migrate({ mailTidyAccounts: {}, mailServerTidy: true, ...READY }, ACCS) === null, '이미 계정마다면 옮기지 않는다 (옛 키가 켜짐이어도)');
  r = tidyacct.migrate({ mailTidyAccounts: 'x', mailServerTidy: true, ...READY }, ACCS);
  ok(r && r.map.mNv.on === true, '…맵이 객체가 아니면 아직 안 옮긴 것으로 본다');
  r = tidyacct.migrate(undefined, undefined);
  ok(r && same(r.map, {}) && r.note === null, '설정·계정이 없으면 빈 맵');
  r = tidyacct.migrate({ ...READY, mailServerTidy: true }, [{ id: '__proto__' }, { id: 'bad id!' }, null, { id: 'ok.1' }, { id: 'ok.1' }]);
  ok(same(Object.keys(r.map), ['ok.1']) && /켜짐 1개/.test(r.note), '이상한 id·겹친 id 는 건너뛴다', r);
}

console.log('\n[3] 계정을 고친 뒤 · 모두 끄기');
{
  const on = { on: true, days: 30 };
  const base = { id: 'a1', host: 'imap.naver.com', user: 'kim', port: 993, enabled: true };
  let u = tidyacct.afterUpdate(on, base, { ...base, name: '네이버 회사', sealed: 'new' });
  ok(u.entry.on === true && u.why === null, '이름·비밀번호만 바꾸면 그대로', u);
  for (const [k, v] of [['host', 'imap.other.com'], ['user', 'lee'], ['port', 143], ['mailbox', 'Work']]) {
    u = tidyacct.afterUpdate(on, base, { ...base, [k]: v });
    ok(u.entry.on === false && u.entry.days === 30 && /서버·아이디를 바꿔서/.test(u.why), `${k} 가 바뀌면 끄고 까닭을 남긴다 (기간은 둔다)`, u);
  }
  u = tidyacct.afterUpdate(on, base, { ...base, host: ' IMAP.Naver.com ', port: '993', user: 'KIM' });
  ok(u.entry.on === true && u.why === null, '대소문자·공백·«993» 글자 차이는 바뀐 것이 아니다', u);
  u = tidyacct.afterUpdate(on, base, { ...base, enabled: false });
  ok(u.entry.on === false && /계정을 꺼서/.test(u.why), '계정을 끄면 그 계정의 정리도 끈다', u);
  u = tidyacct.afterUpdate(on, { ...base, enabled: false }, { ...base, enabled: false, name: 'x' });
  ok(u.entry.on === true && u.why === null, '…이미 꺼져 있던 계정의 이름만 바꾸면 그대로');
  u = tidyacct.afterUpdate({ on: false, days: 7 }, base, { ...base, host: 'x' });
  ok(u.entry.on === false && u.entry.days === 7 && u.why === null, '꺼진 계정은 바뀌어도 기록하지 않는다');
  u = tidyacct.afterUpdate(undefined, base, base);
  ok(same(u.entry, { on: false, days: 30 }), '항목이 없으면 꺼짐·30일');
  u = tidyacct.afterUpdate({ on: true, days: 30, copyAsk: true }, base, { ...base, name: 'x' });
  ok(same(u.entry, { on: true, days: 30, copyAsk: true }) && u.why === null, '이름만 바꾸면 «복사 길은 묻지 않음» 표시도 그대로', u);
  u = tidyacct.afterUpdate({ on: true, days: 30, copyAsk: true }, base, { ...base, host: 'x' });
  ok(same(u.entry, { on: false, days: 30 }), '…서버를 바꿔 끄면 표시도 뗀다', u);
  const m0 = { a1: { on: true, days: 30 }, a2: { on: true, days: 0 }, a3: { on: false, days: 7 } };
  const off = tidyacct.allOff(m0);
  ok(!tidyacct.anyOn(off) && off.a2.days === 0 && off.a3.days === 7 && m0.a1.on === true, 'allOff — 모두 끄고 기간은 남긴다, 원래 맵은 그대로', off);
  ok(tidyacct.anyOn(m0) && !tidyacct.anyOn({}) && !tidyacct.anyOn({ a1: { on: 'yes' } }), "anyOn — 'yes' 는 켜짐이 아니다");
}

console.log('\n[4] 간격 · 차례 · 상한 나누기');
{
  const T = { GAP_MS: 3, MORE_GAP_MS: 2, QUICK_GAP_MS: 1 };
  ok(tidyacct.gapMs(0, false, T) === 1 && tidyacct.gapMs(0, true, T) === 1 && tidyacct.gapMs(30, true, T) === 2 && tidyacct.gapMs(30, false, T) === 3,
    'gapMs — «바로»는 늘 짧게, 남았으면 중간, 아니면 길게');
  const accs = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }];
  const at = { a1: 500, a2: 100, a3: 900, a4: 100 };
  const d = tidyacct.dueOrder(accs, (a) => at[a.id], 600).map((a) => a.id);
  ok(same(d, ['a2', 'a4', 'a1']), 'dueOrder — 때가 된 계정만, 오래 기다린 차례로 (같으면 설정 순서)', d);
  ok(same(tidyacct.dueOrder(accs, () => 1000, 600), []) && same(tidyacct.dueOrder(null, () => 0, 1), []), '…때가 안 됐으면 빈 목록');
  ok(tidyacct.capShare(300, 2) === 150 && tidyacct.capShare(300, 1) === 300 && tidyacct.capShare(150, 1) === 150
    && tidyacct.capShare(2, 3) === 1 && tidyacct.capShare(0, 2) === 0 && tidyacct.capShare(-5, 2) === 0 && tidyacct.capShare(300, 0) === 300,
  'capShare — 남은 양 ÷ 남은 계정 (올림), 남은 것이 없으면 0');
  // 뒤 계정이 남긴 몫을 앞 계정이 못 쓰더라도 합은 늘 남은 양 안이다
  let worst = 0;
  for (let left = 0; left <= 40; left++) {
    for (let n = 1; n <= 7; n++) {
      let l = left;
      for (let k = n; k >= 1; k--) l -= tidyacct.capShare(l, k);
      worst = Math.min(worst, l);
    }
  }
  ok(worst === 0, '…모든 계정이 제 몫을 다 써도 합이 남은 양을 넘지 않는다', worst);
}

console.log('\n[5] 같은 목록');
{
  const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
  ok(same(tidyacct.TIDY_DAYS, mailtidy.DAYS), 'TIDY_DAYS 와 mailtidy.DAYS 가 같다', tidyacct.TIDY_DAYS);
  ok(same(tidyacct.PATH_KEYS, ['host', 'port', 'user', 'mailbox']), '정리에서 빼는 계정 값 — 서버·포트·아이디·폴더');
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

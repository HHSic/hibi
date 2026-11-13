'use strict';
// 서버 정리 — 옛 하나짜리 스위치를 계정마다로 옮기기 (src/store.js load · src/tidyacct.js migrate).
//
// 창을 띄우지 않는다. main.js 도 싣지 않는다. 데이터 폴더는 임시 폴더이고, 시험마다 설정 파일을 써 두고
// store.js 를 require 캐시에서 지워 다시 싣는다 — 앱을 새로 켠 것과 같다. 메일 서버에는 가지 않는다.
//   [1] 옛 켜짐·7일·조건 갖춤 — 켜진 계정은 모두 켜짐·7일, 꺼진 계정은 꺼짐, 옛 키는 디스크에서 사라지고 기록이 남는다
//   [2] 다시 실으면 다시 옮기지 않는다   [3] 옛 버전으로 내려갔다 올라온 파일은 다시 옮긴다 (그 버전에서 끈 것도 따른다)
//   [4] 조건이 모자라면 모두 끈다   [5] 손으로 고친 맵·지운 계정의 결과는 실을 때 다듬는다
//   [6] 기록이 켜져 있으면 실을 때 바로 남긴다 · 옛 layoutVersion 옮기기와 같이 돌아도 된다
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidymigrate-'));
const HIBI = path.join(tmp, 'Hibi');
const FILE = path.join(HIBI, 'nunsseom.json');
app.setPath('appData', tmp);
app.setPath('userData', HIBI);
fs.mkdirSync(HIBI, { recursive: true });

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STORE = path.join(ROOT, 'src', 'store.js');

/** 설정 파일을 써 두고 store 를 새로 싣는다 — 앱을 다시 켠 것과 같다 */
function fresh(raw) {
  if (raw) fs.writeFileSync(FILE, JSON.stringify(raw));
  delete require.cache[require.resolve(STORE)];
  const store = require(STORE);
  void store.settings;   // 여기서 실린다
  return store;
}
const disk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const acct = (id, over = {}) => ({ id, name: `회사${id}`, provider: 'custom', host: `imap.${id}.invalid`, port: 993, user: `${id}@corp.example`, enabled: true, ...over });
const READY = { mailEnabled: true, mailAutoBackup: true, mailBackupDir: path.join(tmp, 'mail') };
const ACCS = [acct('a1'), acct('a2'), acct('g1', { name: 'Gmail', host: 'imap.gmail.com' }), acct('x1', { enabled: false })];
const LAST = { at: 5, moved: 3, kept: 1951, unsaved: 1951, error: '이카운트: 이 서버는 «옮기기»(MOVE)를 지원하지 않아 정리하지 않았습니다' };

app.whenReady().then(() => {
  const evlog = require(path.join(ROOT, 'src', 'evlog.js'));
  const logged = [];
  evlog.log = (s, m) => { logged.push(`${s}|${m}`); };

  console.log('\n[1] 옛 켜짐·7일·조건 갖춤');
  let store = fresh({ settings: { mailCount: 5, ...READY, mailServerTidy: true, mailTidyDays: 7, mailTidyLast: LAST }, mailAccounts: ACCS, layoutVersion: 4 });
  // 옛 확인 창은 MOVE 없는 서버를 «옮기지 않음»으로 셌다 — 켠 항목에는 «복사 길은 묻지 않음»(copyAsk)을 단다 (정리가 옮기기 전에 끄고 다시 묻는다)
  ok(same(store.settings.mailTidyAccounts, { a1: { on: true, days: 7, copyAsk: true }, a2: { on: true, days: 7, copyAsk: true }, g1: { on: true, days: 7, copyAsk: true }, x1: { on: false, days: 7 } }),
    '켜진 계정 셋은 켜짐·7일, 꺼 둔 계정은 꺼짐·7일 — 지금 도는 범위 그대로', store.settings.mailTidyAccounts);
  ok(same(store.settings.mailTidyResults, {}), '옛 합계 결과는 계정마다 나눌 수 없어 빈 맵으로 시작한다', store.settings.mailTidyResults);
  ok(!('mailServerTidy' in store.settings) && !('mailTidyDays' in store.settings) && !('mailTidyLast' in store.settings), '옛 키는 메모리에 없다');
  const d1 = disk();
  ok(!('mailServerTidy' in d1.settings) && !('mailTidyDays' in d1.settings) && !('mailTidyLast' in d1.settings)
    && same(d1.settings.mailTidyAccounts, store.settings.mailTidyAccounts) && same(d1.settings.mailTidyResults, {}),
  '디스크에서 옛 세 키가 사라지고 계정 맵이 적혔다 — 옛 버전으로 내려가도 옛 스위치가 없어 정리는 꺼진 채', Object.keys(d1.settings).filter((k) => /Tidy/.test(k)));
  ok(d1.settings.mailCount === 5 && d1.mailAccounts.length === 4, '…다른 설정과 계정은 그대로');
  const notes1 = store.takeLoadNotes();
  ok(same(notes1, [['설정', '서버 정리 설정을 계정마다로 옮김 · 켜짐 3개 · 7일 · MOVE 없는 서버는 옮기기 전에 다시 묻습니다']]) && !logged.length,
    '기록이 꺼져 있을 때 실렸으면 기록할 말을 들고 있다가 내준다 (main.js 가 기록을 켠 뒤 남긴다)', { notes1, logged });
  ok(same(store.takeLoadNotes(), []), '…한 번 내주면 비운다');

  console.log('\n[2] 다시 실으면 다시 옮기지 않는다');
  const before = fs.readFileSync(FILE, 'utf8');
  store = fresh(null);
  ok(same(store.settings.mailTidyAccounts.a1, { on: true, days: 7, copyAsk: true }) && same(store.takeLoadNotes(), []) && fs.readFileSync(FILE, 'utf8') === before,
    '맵이 있으면 그대로 — 기록도, 다시 쓰기도 없다');
  store.setTidyAccount('a2', { on: false });
  store = fresh(null);
  ok(store.settings.mailTidyAccounts.a2.on === false && store.settings.mailTidyAccounts.a1.on === true, '…옮긴 뒤 끈 계정은 다시 실어도 꺼진 채 (옛 키로 되살아나지 않는다)', store.settings.mailTidyAccounts);
  ok(same(store.settings.mailTidyAccounts.a2, { on: false, days: 7 }), '…끄면 «복사 길은 묻지 않음» 표시도 뗀다 (다시 켤 때 확인 창이 묻는다)', store.settings.mailTidyAccounts.a2);
  store.setTidyAccount('a1', { days: 30 });
  ok(same(store.settings.mailTidyAccounts.a1, { on: true, days: 30, copyAsk: true }), '켜진 채 기간만 바꾸면 (기간 늘리기 — 묻지 않는 길) 표시는 그대로', store.settings.mailTidyAccounts.a1);
  store.setTidyAccount('a1', { on: true, days: 7 });
  ok(same(store.settings.mailTidyAccounts.a1, { on: true, days: 7 }), '확인 창을 거친 켜기·줄이기(on 을 주는 길)는 표시를 뗀다', store.settings.mailTidyAccounts.a1);
  {
    // 옛 키가 남아 있어도(누가 손으로 넣었다) 맵이 있으면 따르지 않는다
    const raw = disk();
    raw.settings.mailServerTidy = true;
    raw.settings.mailTidyDays = 0;
    store = fresh(raw);
    ok(store.settings.mailTidyAccounts.a2.on === false && store.settings.mailTidyAccounts.a1.days === 7 && !('mailServerTidy' in store.settings),
      '맵과 옛 키가 같이 있으면 맵을 따른다', store.settings.mailTidyAccounts);
  }

  console.log('\n[3] 옛 버전으로 내려갔다 올라온 파일');
  {
    // 옛 버전은 모르는 키(계정 맵)를 저장할 때 버린다 — 그 버전에서 정리를 켰으면 그 값으로 다시 옮긴다
    store = fresh({ settings: { mailCount: 5, ...READY, mailServerTidy: true, mailTidyDays: 30 }, mailAccounts: ACCS, layoutVersion: 4 });
    ok(same(store.settings.mailTidyAccounts, { a1: { on: true, days: 30, copyAsk: true }, a2: { on: true, days: 30, copyAsk: true }, g1: { on: true, days: 30, copyAsk: true }, x1: { on: false, days: 30 } })
      && same(store.takeLoadNotes(), [['설정', '서버 정리 설정을 계정마다로 옮김 · 켜짐 3개 · 30일 · MOVE 없는 서버는 옮기기 전에 다시 묻습니다']]), '맵이 없고 옛 스위치가 켜져 있으면 다시 옮긴다', store.settings.mailTidyAccounts);
    // 그 버전에서 껐으면 모두 끈다 (기간은 옛 값)
    store = fresh({ settings: { mailCount: 5, ...READY, mailServerTidy: false, mailTidyDays: 90 }, mailAccounts: ACCS, layoutVersion: 4 });
    ok(!Object.values(store.settings.mailTidyAccounts).some((x) => x.on) && store.settings.mailTidyAccounts.a1.days === 90 && same(store.takeLoadNotes(), []),
      '옛 스위치가 꺼져 있으면 모두 꺼짐 — 기록은 남기지 않는다', store.settings.mailTidyAccounts);
    ok(!('mailTidyDays' in disk().settings) && !!disk().settings.mailTidyAccounts, '…그래도 옛 키는 지우고 맵을 적는다');
  }

  console.log('\n[4] 조건이 모자라면 모두 끈다');
  for (const [k, v] of [['mailEnabled', false], ['mailAutoBackup', false], ['mailBackupDir', null]]) {
    store = fresh({ settings: { ...READY, [k]: v, mailServerTidy: true, mailTidyDays: 7 }, mailAccounts: ACCS, layoutVersion: 4 });
    const notes = store.takeLoadNotes();
    ok(!Object.values(store.settings.mailTidyAccounts).some((x) => x.on) && same(notes, [['설정', '서버 정리 설정을 계정마다로 옮김 · 켜짐 0개 · 7일 (조건이 모자라 모두 꺼 둠)']]),
      `${k} 가 모자라면 — 옛 버전에서도 돌지 않던 정리라 모두 끄고 «조건이 모자라 모두 꺼 둠»`, notes);
  }

  console.log('\n[5] 손으로 고친 맵 · 지운 계정의 결과');
  {
    const raw = {
      settings: {
        ...READY,
        mailTidyAccounts: { a1: { on: 'yes', days: '7' }, a2: { on: true, days: 0 }, zz: { on: true, days: 7 }, 'bad id': { on: true } },
        mailTidyResults: { a1: { at: 9, moved: '4', error: 'e'.repeat(300) }, zz: { moved: 1 } }
      },
      mailAccounts: ACCS,
      layoutVersion: 4
    };
    store = fresh(raw);
    ok(same(store.settings.mailTidyAccounts, { a1: { on: false, days: 30 }, a2: { on: true, days: 0 } }),
      "'yes' 는 꺼짐·'7' 은 30 · 지금 없는 계정(zz)·이상한 열쇠는 버린다 · 0(바로)은 0", store.settings.mailTidyAccounts);
    const r = store.settings.mailTidyResults;
    ok(Object.keys(r).length === 1 && r.a1.moved === 4 && r.a1.error.length === 200 && same(store.takeLoadNotes(), []), '결과도 다듬고 지운 계정 것은 버린다', r);
  }

  console.log('\n[6] 기록이 켜져 있으면 바로 남긴다 · 옛 layoutVersion 옮기기와 같이');
  {
    const desc = Object.getOwnPropertyDescriptor(evlog, 'enabled');
    Object.defineProperty(evlog, 'enabled', { get: () => true, configurable: true });
    logged.length = 0;
    store = fresh({ settings: { ...READY, eventLog: true, mailServerTidy: true, mailTidyDays: 90 }, mailAccounts: [acct('a1')], layoutVersion: 3 });
    Object.defineProperty(evlog, 'enabled', desc);
    ok(same(logged, ['설정|서버 정리 설정을 계정마다로 옮김 · 켜짐 1개 · 90일 · MOVE 없는 서버는 옮기기 전에 다시 묻습니다']) && same(store.takeLoadNotes(), []), '기록이 켜져 있으면 실을 때 바로 남기고 들고 있지 않는다', logged);
    ok(same(store.settings.mailTidyAccounts, { a1: { on: true, days: 90, copyAsk: true } }) && disk().layoutVersion === 4 && store.settings.eventLog === false,
      '옛 layoutVersion(3) 옮기기도 같이 돈다 — 둘 다 디스크에 적힌다', { map: store.settings.mailTidyAccounts, v: disk().layoutVersion });
    // 읽을 수 없는 파일 — 옮길 것도 없이 기본값
    fs.writeFileSync(FILE, '{broken');
    store = fresh(null);
    ok(same(store.settings.mailTidyAccounts, {}) && same(store.takeLoadNotes(), []), '깨진 파일이면 빈 맵 — 옮기지 않는다');
  }

  // 임시 폴더 — 만든 파일만 하나씩 지운다
  try {
    for (const f of fs.readdirSync(HIBI)) fs.unlinkSync(path.join(HIBI, f));
    fs.rmdirSync(HIBI);
    fs.rmdirSync(tmp);
  } catch { /* 임시 폴더 — 남아도 해가 없다 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

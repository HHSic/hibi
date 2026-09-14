const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// «랜덤 고양이» — 휴식마다 고양이 영상 가운데 하나가 나오는가.
//
// 고르는 건 메인(src/breakwin.js resolveEnter)이 한다 — 모니터마다 다른 고양이가 나오면 안 되니까.
// 메인은 화면 쪽 파일(renderer/anim/clip.js)을 못 읽어 고양이 id 를 따로 적어 두므로, 둘이 어긋나지 않는지도 본다.
// 이 시험은 창을 띄우지 않는다 — 화면 쪽 파일은 vm 에서 읽기만 한다.
// (화면 쪽이 «랜덤 고양이»를 그대로 받았을 때 영상으로 뜨는지는 catclip.test.js 가 본다)
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { app } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
// whenReady 안에서 던지면 promise 거부로 새어 나가 시간 초과까지 붙잡는다 — 바로 떨어뜨린다
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catrandom-'));
app.setPath('appData', tmp);

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * 화면 쪽 스크립트들을 창 없이 차례로 읽어, 함께 붙인 window 를 돌려준다 (휴식 창에서처럼 clip.js 다음 enter.js).
 * document·matchMedia 는 함수 안에서만 쓰여 부르지 않는다.
 */
function loadRenderer(rels) {
  const window = {};
  for (const rel of rels) vm.runInNewContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { window }, { filename: rel });
  return window;
}

app.whenReady().then(() => {
  const breakwin = require(`${ROOT}/src/breakwin.js`);
  const win = loadRenderer(['renderer/anim/clip.js', 'renderer/enter.js']);
  const clipIds = Object.keys(win.nunsClip.CLIPS).sort();
  const { LIST, DISABLED, catIds } = win.nunsEnter;

  console.log('\n[목록이 서로 맞다]');
  ok(sameSet(breakwin.CAT_ENTERS, clipIds), '메인의 고양이 목록(CAT_ENTERS)이 clip.js CLIPS 와 같다', { main: breakwin.CAT_ENTERS, clips: clipIds });
  ok(sameSet(breakwin.DISABLED_ENTER, DISABLED), '끈 연출 목록이 메인과 화면 쪽에서 같다', { main: [...breakwin.DISABLED_ENTER], renderer: [...DISABLED] });
  ok(sameSet(catIds(), breakwin.CAT_ENTERS.filter((c) => !breakwin.DISABLED_ENTER.has(c))),
    '화면 쪽 catIds() 가 메인이 뽑는 고양이와 같다', { renderer: catIds() });
  ok(LIST.some((m) => m.id === 'cat-random' && m.name === '랜덤 고양이'), '설정 목록에 «랜덤 고양이»가 있다', LIST.map((m) => m.name));
  ok(clipIds.every((id) => LIST.some((m) => m.id === id)), '고양이마다 따로 고르는 칸도 그대로 있다',
    clipIds.filter((id) => !LIST.some((m) => m.id === id)));

  console.log('\n[랜덤 고양이]');
  const N = 600;
  const picks = Array.from({ length: N }, () => breakwin.resolveEnter('cat-random'));
  const count = {};
  for (const p of picks) count[p] = (count[p] || 0) + 1;
  ok(picks.every((p) => clipIds.includes(p)), `${N}번 모두 고양이 영상 id 다 (다른 연출·«랜덤 고양이» 그대로가 안 나온다)`, count);
  ok(clipIds.every((id) => count[id] > 0), '모든 고양이가 한 번 이상 나온다', count);
  const even = N / clipIds.length;
  ok(clipIds.every((id) => count[id] >= even * 0.6 && count[id] <= even * 1.4), '한 고양이로 쏠리지 않는다 (고르게 ±40%)', count);
  const repeats = picks.filter((p, i) => i > 0 && p === picks[i - 1]).length;
  ok(repeats === 0, '같은 고양이가 두 번 연달아 나오지 않는다', repeats);

  console.log('\n[고양이 하나를 끄면]');
  // 끈 연출(DISABLED)은 «랜덤 고양이»·«그때그때»에서도 안 뽑혀야 한다 — 잠깐 하나를 꺼 보고 되돌린다
  breakwin.DISABLED_ENTER.add('cat-roll');
  try {
    const off = Array.from({ length: 300 }, () => breakwin.resolveEnter('cat-random'));
    const offRnd = Array.from({ length: 300 }, () => breakwin.resolveEnter('random'));
    ok(!off.includes('cat-roll') && off.every((p) => clipIds.includes(p)), '끈 고양이는 «랜덤 고양이»에서 안 나온다', [...new Set(off)]);
    ok(!offRnd.includes('cat-roll'), '끈 고양이는 «그때그때»에서도 안 나온다', [...new Set(offRnd)]);
  } finally {
    breakwin.DISABLED_ENTER.delete('cat-roll');
  }

  console.log('\n[다른 설정은 그대로]');
  ok(breakwin.resolveEnter('cat') === 'cat' && breakwin.resolveEnter('cat-rb') === 'cat-rb', '고양이 하나를 고르면 그 고양이만 나온다');
  ok(breakwin.resolveEnter('web') === 'fade', '끈 연출(웹스윙)은 여전히 기본으로');
  const rnd = new Set(Array.from({ length: 300 }, () => breakwin.resolveEnter('random')));
  ok(!rnd.has('cat-random') && !rnd.has('random') && !rnd.has('web'),
    '«그때그때»는 «랜덤 고양이»·자기 자신·끈 연출을 그대로 내보내지 않는다', [...rnd]);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

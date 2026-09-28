// «고양이 움직임» — 설정 catSpeed 가 휴식 창에 어떤 재생 빠르기로 실리는가.
//
// 고양이 영상은 찍은 빠르기 그대로 트는데도 «너무 빠르게 움직인다»는 말을 들어 고를 수 있게 했다:
// 보통(1배) · 느리게(0.75배, 기본) · 아주 느리게(0.6배).
//   · 메인(src/breakwin.js catRate)이 설정 값을 배수로 바꾼다. 모르는 값은 기본(0.75)으로 본다
//   · buildBreakPayload 가 그 배수를 catRate 로 싣는다 (overlay.html → enter.js play → clip.js mount)
//   · 예전 설정 파일(catSpeed 가 없다)을 읽어도 기본 «느리게»가 채워진다
//   · 화면 쪽 표(renderer/anim/clip.js RATES·rateOf)가 메인과 같다 — 설정 미리보기는 그 표를 쓴다
// 이 시험은 창을 띄우지 않는다 — 화면 쪽 파일은 vm 에서 읽기만 한다.
// (영상에 실제로 들어가는지는 catclip.test.js, 설정 화면 단추·미리보기는 enterprev.test.js 가 본다)
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { app } = require('electron');

process.on('uncaughtException', (e) => { console.error((e && e.stack) || e); process.exit(1); });
// whenReady 안에서 던지면 promise 거부로 새어 나가 시간 초과까지 붙잡는다 — 바로 떨어뜨린다
process.on('unhandledRejection', (e) => { console.error((e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60_000).unref();

const ROOT = path.join(__dirname, '..');
// 실제 설정을 건드리지 않게 데이터 폴더를 임시로 — store.js 가 require 시점에 경로를 읽으므로 그 전에
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catspeed-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));
// 예전 버전이 남긴 설정 파일 — catSpeed 가 없다 (업데이트한 사람)
fs.mkdirSync(path.join(tmp, 'Hibi'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'Hibi', 'nunsseom.json'), JSON.stringify({ settings: { overlayEnter: 'cat' }, layoutVersion: 3 }));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 기대값 — 사용자가 고른 세 가지. 이상한 값은 모두 기본(느리게)으로
const WANT = { normal: 1, slow: 0.75, slower: 0.6 };
const GARBAGE = ['fast', '', 'Slow', ' slow', null, undefined, 0.6, 1, true, {}, [], 'toString', '__proto__', 'constructor', 'hasOwnProperty'];

app.whenReady().then(() => {
  const store = require(path.join(ROOT, 'src', 'store.js'));
  const breakwin = require(path.join(ROOT, 'src', 'breakwin.js'));

  console.log('\n[설정 기본값]');
  ok(store.settings.catSpeed === 'slow', '예전 설정 파일(catSpeed 없음)을 읽어도 기본 «느리게»가 채워진다', store.settings.catSpeed);
  ok(store.settings.overlayEnter === 'cat', '다른 설정은 그대로 읽힌다', store.settings.overlayEnter);

  console.log('\n[메인 — catRate]');
  for (const [k, v] of Object.entries(WANT)) ok(breakwin.catRate(k) === v, `'${k}' → ${v}`, breakwin.catRate(k));
  const odd = GARBAGE.map((g) => [String(g), breakwin.catRate(g)]);
  ok(odd.every(([, r]) => r === 0.75), '모르는 값은 모두 기본 0.75 (던지지 않는다)', odd);
  ok(JSON.stringify(breakwin.CAT_RATES) === JSON.stringify(WANT), '배수 표가 사용자가 고른 세 가지와 같다', breakwin.CAT_RATES);

  console.log('\n[메인 — 휴식 창에 싣는 값]');
  const payloadRate = (speed) => {
    store.setSettings({ catSpeed: speed });
    return breakwin.buildBreakPayload(['eye']).catRate;
  };
  ok(breakwin.buildBreakPayload(['eye']).catRate === 0.75, '처음(기본)은 0.75 를 싣는다', breakwin.buildBreakPayload(['eye']).catRate);
  for (const [k, v] of Object.entries(WANT)) ok(payloadRate(k) === v, `catSpeed '${k}' → payload.catRate ${v}`, payloadRate(k));
  ok(payloadRate('zoom') === 0.75 && payloadRate(null) === 0.75, '손으로 고친 이상한 값도 0.75 로 싣는다', [payloadRate('zoom'), payloadRate(null)]);
  ok(store.settings.catSpeed === null, '읽는 쪽이 기본으로 볼 뿐 저장 값은 고치지 않는다', store.settings.catSpeed);
  // 다른 연출·내 파일이어도 값은 실린다 — 쓰는 건 화면 쪽이 고양이 영상에만 쓴다
  store.setSettings({ catSpeed: 'slower', overlayEnter: 'blinds' });
  const pb = breakwin.buildBreakPayload(['eye']);
  ok(pb.catRate === 0.6 && pb.enter === 'blinds' && pb.enterAsset === null, '연출과 따로 실린다 (블라인드여도 0.6 — 화면 쪽이 고양이에만 쓴다)', { catRate: pb.catRate, enter: pb.enter });
  store.setSettings({ catSpeed: 'slow', overlayEnter: 'cat' });

  console.log('\n[화면 쪽 표와 같다]');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'renderer', 'anim', 'clip.js'), 'utf8'), { window }, { filename: 'clip.js' });
  const C = window.nunsClip;
  ok(JSON.stringify({ ...C.RATES }) === JSON.stringify(breakwin.CAT_RATES), 'clip.js RATES 가 메인 CAT_RATES 와 같다', { renderer: C.RATES, main: breakwin.CAT_RATES });
  ok(C.DEFAULT_SPEED === 'slow' && C.DEFAULT_SPEED === store.settings.catSpeed, '화면 쪽 기본도 «느리게»', C.DEFAULT_SPEED);
  const all = [...Object.keys(WANT), ...GARBAGE];
  const diff = all.filter((g) => C.rateOf(g) !== breakwin.catRate(g)).map(String);
  ok(diff.length === 0, 'rateOf 가 어떤 값에서도 메인 catRate 와 같다', diff);
  ok(Object.keys(WANT).every((k) => C.speedOf(k) === k) && GARBAGE.every((g) => C.speedOf(g) === 'slow'),
    'speedOf — 아는 값은 그대로, 모르는 값은 «느리게» (설정 화면의 켜진 단추)', GARBAGE.map((g) => C.speedOf(g)));

  console.log('\n[설정 화면 단추]');
  // 설정 화면(renderer/settings.js CAT_SPEEDS)이 세 가지를 모두, 그 순서로 보여 주는가 — 파일만 읽는다
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'settings.js'), 'utf8');
  const m = src.match(/const CAT_SPEEDS = \[([\s\S]*?)\];/);
  const ids = m ? [...m[1].matchAll(/id: '([^']+)', name: '([^']+)'/g)].map((x) => [x[1], x[2]]) : [];
  ok(JSON.stringify(ids) === JSON.stringify([['normal', '보통'], ['slow', '느리게'], ['slower', '아주 느리게']]),
    '설정 화면 단추가 보통·느리게·아주 느리게 — 표의 id 와 같다', ids);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

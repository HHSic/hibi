// 큰 고양이(주인공) 배치 — 고양이는 화면 가운데에 크게, 휴식 안내·단추는 오른쪽 아래 구석으로.
//
// 진짜 overlay.html 을 화면 밖(offscreen) 창에 여러 크기로 띄워 잰다. 사용자 모니터에는 아무것도
// 안 뜬다. 모니터보다 큰 창은 윈도우가 잘라 버려서, 창은 절반 크기로 만들고 확대 0.5 로 CSS 크기를 맞춘다.
//   · 고양이가 휴식 안내·단추와 겹치지 않는다 (8px 여유)
//   · 안내·단추·고양이가 화면 안에 있고, 남은 시간(오른쪽 위)과도 안 겹친다
//   · 칸이 넘치지 않고, 넘치지도 않는데 글자를 줄이지 않는다 (예전에 올라오는 애니 18px 로 줄였다)
//   · 세로 화면은 안내가 위로, 고양이는 아래로
//   · 연출을 안 그리는 다른 모니터는 예전처럼 가운데 그대로
// 주인공 영상(cat-loaf, 큰 식빵 고양이)이 있으면 그걸로, 없으면 앉은 고양이(cat)를 주인공 자리로 바꿔 대신 쓴다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('LAB 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과'); process.exit(1); }, 300_000).unref();
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const OUT = process.env.HIBI_TEST_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'herolayout-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const SINGLE = { mode: 'single', grouped: false, items: [{ name: '눈 휴식', emoji: '👀', color: '#5ac8fa', kind: 'short',
  headline: '20초 동안 먼 곳을 바라보세요', tip: ['20초 동안 먼 곳을 바라보세요', '6미터쯤 떨어진 곳에 초점을 맞추면 눈 근육이 풀립니다'], checklist: null }] };
const CHECK = { mode: 'checklist', grouped: false, items: [{ name: '긴 휴식', emoji: '🧘', color: '#34c759', kind: 'long', headline: '일어나서 몸을 풀어요',
  checklist: ['자리에서 일어나기', '어깨 크게 돌리기 10번', '목을 좌우로 천천히 늘리기', '물 한 잔 마시기', '창밖 먼 곳 20초 보기', '허리 뒤로 젖히기', '손목·손가락 풀기'] }] };

const MEASURE = `(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
  const v = document.querySelector('#curtain video.ent-clip');
  const stage = document.querySelector('.stage');
  return { W: innerWidth, H: innerHeight, hero: document.documentElement.classList.contains('ent-hero'),
    video: R(v), ready: v ? v.readyState : -1, vin: v ? v.classList.contains('in') : false,
    content: ['kicker', 'headline', 'subline', 'list'].map((id) => R(document.getElementById(id))).filter(Boolean),
    buttons: [...document.querySelectorAll('.actions button')].filter((b) => getComputedStyle(b).display !== 'none').map(R).filter(Boolean),
    count: R(document.querySelector('.breath')),
    stageOpacity: +getComputedStyle(stage).opacity, overflow: stage.scrollHeight > stage.clientHeight + 1,
    dense: document.body.className.trim() };
})()`;
const hit = (a, b, pad = 0) => !!(a && b && a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad);
const inside = (a, W, H) => !!a && a.l >= -0.5 && a.t >= -0.5 && a.r <= W + 0.5 && a.b <= H + 0.5;
const cx = (a) => (a.l + a.r) / 2;

async function open(s) {
  const win = new BrowserWindow({ show: false, width: Math.round(s.w / 2), height: Math.round(s.h / 2), useContentSize: true, frame: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'overlay-bridge-stub.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'renderer', 'overlay.html'), { query: { display: '1', main: 'false' } });
  win.webContents.setFrameRate(30);
  win.webContents.setZoomFactor(0.5);
  await sleep(150);
  const js = (c) => win.webContents.executeJavaScript(c);
  const payload = { ...s.p, enter: 'cat', enterOn: s.enterOn || '1', durationSec: 20, endsAt: Date.now() + 20000, sound: { enabled: false }, noEscape: false };
  await js(`(() => {
    const p = ${JSON.stringify(payload)};
    const C = window.nunsClip.CLIPS;
    if (${!!s.hero}) {
      if (C['cat-loaf'] && C['cat-loaf'].place && C['cat-loaf'].place.mode === 'hero') p.enter = 'cat-loaf';
      else C.cat = { ...C.cat, place: { mode: 'hero', height: 0.8 } };
    }
    window.__begin(p);
  })()`);
  let m = null;
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    m = await js(MEASURE);
    if ((s.enterOn === '2' || m.ready >= 2) && m.stageOpacity > 0.95 && m.buttons.length) break;
  }
  await sleep(900);   // 목록 줄이 차례로 올라오는 애니가 끝나게
  m = await js(MEASURE);
  return { win, m };
}

app.whenReady().then(async () => {
  const sizes = [[1920, 1080], [1366, 768], [2560, 1440], [1280, 1024], [1080, 1920]];
  for (const [w, h] of sizes) {
    for (const [mname, p] of [['한 줄', SINGLE], ['체크리스트', CHECK]]) {
      const tag = `${w}x${h} ${mname}`;
      const { win, m } = await open({ w, h, p, hero: true });
      const portrait = h > w;
      console.log(`\n[주인공 ${tag}]`);
      ok(m.W === w && m.H === h, `${tag}: 창 CSS 크기`, [m.W, m.H]);
      // 안내·단추가 안 뜨면 아래 «안 겹친다» 검사들은 빈 목록이라 저절로 통과한다 — 먼저 떴는지 본다
      ok(m.stageOpacity > 0.95 && m.content.length >= 2 && m.buttons.length >= 1, `${tag}: 휴식 안내와 단추가 떴다`,
        { opacity: m.stageOpacity, content: m.content.length, buttons: m.buttons.length });
      ok(m.hero, `${tag}: html.ent-hero 가 붙었다`);
      ok(!!m.video && m.ready >= 2 && m.vin, `${tag}: 고양이 영상이 떴다`, { ready: m.ready, in: m.vin });
      ok(inside(m.video, m.W, m.H) && m.content.every((c) => inside(c, m.W, m.H)) && m.buttons.every((b) => inside(b, m.W, m.H)),
        `${tag}: 고양이·안내·단추가 화면 안에 있다`);
      ok(!m.content.some((c) => hit(c, m.video, 8)) && !m.buttons.some((b) => hit(b, m.video, 8)), `${tag}: 고양이가 안내·단추를 가리지 않는다`,
        { video: m.video && [m.video.l, m.video.t, m.video.r, m.video.b].map(Math.round) });
      ok(!m.content.some((c) => hit(c, m.count, 4)), `${tag}: 남은 시간(오른쪽 위)과 안 겹친다`);
      ok(!m.overflow && m.dense === '', `${tag}: 넘치지 않고, 괜히 글자를 줄이지 않는다`, { overflow: m.overflow, dense: m.dense });
      if (portrait) {
        const textBottom = Math.max(...m.content.map((c) => c.b), ...m.buttons.map((b) => b.b));
        ok(m.video && textBottom < m.video.t, `${tag}: 세로 화면은 안내가 위, 고양이가 아래`, { textBottom: Math.round(textBottom), catTop: m.video && Math.round(m.video.t) });
      } else {
        const rightmost = Math.min(...m.buttons.map((b) => b.l), ...m.content.map((c) => c.l));
        ok(m.buttons.every((b) => b.r > w * 0.8) && m.buttons.every((b) => b.b > h * 0.85), `${tag}: 단추가 오른쪽 아래 구석에 있다`);
        ok(rightmost > w * 0.6, `${tag}: 안내가 오른쪽 칸에 모였다`, Math.round(rightmost));
        // 크게 — 높이가 화면의 45% 넘거나(앉은 고양이), 폭이 60% 넘거나(옆으로 긴 식빵 고양이)
        ok(m.video && Math.abs(cx(m.video) - w / 2) < w * 0.17 && ((m.video.b - m.video.t) > h * 0.45 || (m.video.r - m.video.l) > w * 0.6),
          `${tag}: 고양이가 가운데 가까이 크게 나온다`,
          { cx: m.video && Math.round(cx(m.video)), hRatio: m.video && +((m.video.b - m.video.t) / h).toFixed(2), wRatio: m.video && +((m.video.r - m.video.l) / w).toFixed(2) });
      }
      if (w === 1920 || portrait) fs.writeFileSync(path.join(OUT, `herolayout-${w}x${h}-${p.mode}.png`), (await win.webContents.capturePage()).toPNG());
      win.destroy();
    }
  }

  console.log('\n[연출을 안 그리는 다른 모니터]');
  {
    const { win, m } = await open({ w: 1920, h: 1080, p: SINGLE, hero: true, enterOn: '2' });
    ok(!m.hero && !m.video, '다른 모니터에는 주인공 자리가 안 켜진다', { hero: m.hero, video: !!m.video });
    const mid = m.content.map(cx);
    ok(mid.length && mid.every((x) => Math.abs(x - 960) < 4), '휴식 안내는 예전처럼 가운데', mid.map(Math.round));
    win.destroy();
  }

  console.log('\n[구석 자리는 그대로]');
  {
    const { win, m } = await open({ w: 1920, h: 1080, p: CHECK, hero: false });
    ok(!m.hero && !!m.video && m.video.l > 1920 * 0.6, '구석 고양이는 오른쪽 아래, 주인공 자리는 안 켜진다', { hero: m.hero, video: m.video && Math.round(m.video.l) });
    ok(m.content.map(cx).every((x) => Math.abs(x - 960) < 4), '휴식 안내는 가운데 그대로');
    ok(m.content.length >= 2 && m.buttons.length >= 1, '구석 자리에서도 안내와 단추가 떴다', { content: m.content.length, buttons: m.buttons.length });
    ok(!m.content.some((c) => hit(c, m.video, 8)) && !m.buttons.some((b) => hit(b, m.video, 8)), '구석 고양이도 안내·단추를 가리지 않는다');
    win.destroy();
  }

  console.log('\n[영상이 안 열리면 안내가 가운데로 돌아온다]');
  {
    const win = new BrowserWindow({ show: false, width: 960, height: 540, frame: false, useContentSize: true,
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'overlay-bridge-stub.js'), contextIsolation: false, sandbox: false } });
    await win.loadFile(path.join(ROOT, 'renderer', 'overlay.html'), { query: { display: '1', main: 'false' } });
    win.webContents.setZoomFactor(0.5);
    await sleep(150);
    const r = await win.webContents.executeJavaScript(`(async () => {
      window.nunsClip.CLIPS.cat = { ...window.nunsClip.CLIPS.cat, url: '../assets/enter/__없는파일__.webm', place: { mode: 'hero', height: 0.8 } };
      window.__begin(${JSON.stringify({ ...SINGLE, enter: 'cat', enterOn: '1', durationSec: 20, endsAt: Date.now() + 20000, sound: { enabled: false } })});
      const first = document.documentElement.classList.contains('ent-hero');
      for (let i = 0; i < 60 && document.querySelector('#curtain video'); i++) await new Promise((q) => setTimeout(q, 50));
      return { first, after: document.documentElement.classList.contains('ent-hero'), video: !!document.querySelector('#curtain video') };
    })()`);
    ok(r.first && !r.after && !r.video, '주인공 영상이 실패하면 ent-hero 를 떼고 영상도 걷는다', r);
    win.destroy();
  }

  console.log(`\n   화면 사진: ${OUT}`);
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

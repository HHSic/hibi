const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 캐릭터 장면(renderer/anim/*.js)이 엔진과의 약속을 지키는가.
//
// 장면은 «눈으로» 다듬었다 (프레임을 그림 파일로 뽑아 봤다). 그 결과를 다음에 누가 고쳐도
// 조용히 망가뜨리지 못하게, 눈 대신 잴 수 있는 것들을 여기 못 박는다:
//   · draw 는 t 만의 함수다 — 같은 t 는 같은 그림 (다른 프레임을 먼저 그려도)
//   · 어떤 화면 크기·어떤 시각에서도 안 터진다 (세로 모니터, 초광폭, 아주 작은 미리보기 칸,
//     한 시간 뒤까지 — 휴식은 길 수 있다)
//   · 도착은 1.2~1.8초 (휴식 내용이 도착 직후 뜬다 — 늦으면 «한참 아무것도 안 뜬다»)
//   · 머무는 동안에도 움직인다 (멈춘 그림이 아니다)
//   · 도착 뒤 글 자리를 밝게 덮지 않는다 (휴식 안내가 읽혀야 한다)
//   · 4K 에서도 가볍다
// 이 시험은 앱을 띄우지 않는다. 빈 창에 엔진과 장면만 싣고 잰다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과'); process.exit(1); }, 200_000).unref();

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 지금은 휴식 창·설정 화면이 어느 장면도 싣지 않는다 — cat(코드로 그린 고양이)은 실제 영상
// (anim/clip.js, test/catclip.test.js)으로 바꿨고, swing(웹스윙)은 끈 연출이다. 파일은 남겨 두었으니
// 다시 쓸 때 깨져 있지 않도록 약속 검사는 계속 한다.
const SCENES = ['cat', 'swing'];

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenecontract-'));
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body>
<script src="file:///${ROOT}/renderer/anim/engine.js"></script>
${SCENES.map((s) => `<script src="file:///${ROOT}/renderer/anim/${s}.js"></script>`).join('\n')}
</body>`);
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  const errs = [];
  win.webContents.on('console-message', (...a) => {
    const d = typeof a[0] === 'object' && a[0] && 'message' in a[0] ? a[0] : null;
    if ((d ? d.level : a[1]) === 3 || (d && d.level === 'error')) errs.push(d ? d.message : a[2]);
  });
  await win.loadFile(page);
  const js = (code) => win.webContents.executeJavaScript(code);

  for (const id of SCENES) {
    console.log(`\n[${id}]`);
    const has = await js(`!!(window.nunsAnim.scenes[${JSON.stringify(id)}])`);
    ok(has, `${id}: 장면이 실렸다`, has ? undefined : errs.slice(0, 3));
    if (!has) continue;

    const r = await js(`(() => {
      const s = window.nunsAnim.scenes[${JSON.stringify(id)}];
      const { renderAt, rng } = window.nunsAnim;
      const out = { arrival: s.arrival, throws: [] };

      // ── 어떤 크기·어떤 시각에서도 안 터진다 ──
      const sizes = [[1920, 1080], [1080, 1920], [3440, 1440], [1366, 768], [320, 180], [168, 95]];
      const times = [0, 0.016, 0.3, 0.8, s.arrival, s.arrival + 0.26, 2.5, 5, 9, 12, 24, 41, 60, 301.7, 3600];
      for (const [w, h] of sizes) {
        for (const t of times) {
          try { renderAt(s, t, w, h, { scale: w > 1000 ? 0.25 : 1 }); }
          catch (e) { out.throws.push(w + 'x' + h + '@' + t + ': ' + e.message); }
        }
      }

      // ── 결정성 ──
      const sig = (cv) => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 5) h = Math.imul(h ^ d[i], 16777619) >>> 0;
        return h;
      };
      const a = sig(renderAt(s, 3.3, 640, 360));
      const b = sig(renderAt(s, 3.3, 640, 360));
      const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360;
      const x = cv.getContext('2d');
      const st = s.setup ? s.setup({ w: 640, h: 360, rng: rng(7) }) : {};
      for (const t of [9, 0.5, 14, 60]) { x.clearRect(0, 0, 640, 360); s.draw(x, t, 640, 360, st); }
      x.clearRect(0, 0, 640, 360); s.draw(x, 3.3, 640, 360, st);
      out.detFresh = a === b;
      out.detAfter = a === sig(cv);

      // ── 그림이 있고, 머무는 동안에도 움직인다 ──
      const lit = (cv) => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4 * 11) if (d[i] > 8) n++;
        return n;
      };
      out.litArrive = lit(renderAt(s, s.arrival + 1, 960, 540));
      out.litLate = lit(renderAt(s, 60, 960, 540));
      out.moving = [[30, 31.3], [120, 121.7], [3600, 3601.1]].map(([p, q]) =>
        sig(renderAt(s, p, 640, 360)) !== sig(renderAt(s, q, 640, 360)));

      // ── 도착 뒤 글 자리를 밝게 덮지 않는다 ──
      // 글 자리(실측 x 41~59%, y 30~62%)에서 «밝고 진한» 점의 비율. 흐린 거미줄은 괜찮다.
      const bright = (t, w, h) => {
        const c = renderAt(s, t, w, h);
        const d = c.getContext('2d').getImageData(0, 0, w, h).data;
        let hit = 0, all = 0;
        for (let yy = Math.floor(h * 0.30); yy < h * 0.62; yy += 3) {
          for (let xx = Math.floor(w * 0.41); xx < w * 0.59; xx += 3) {
            const i = (yy * w + xx) * 4;
            all++;
            const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
            if (d[i + 3] > 110 && lum > 0.45) hit++;
          }
        }
        return +(hit / all * 100).toFixed(2);
      };
      out.textBright = [];
      for (const [w, h] of [[960, 540], [540, 960]]) {
        for (const t of [s.arrival + 0.6, 4, 8, 13, 24, 60]) out.textBright.push(bright(t, w, h));
      }

      // ── 가벼운가 ──
      for (const [nm, w, h] of [['1080p', 1920, 1080], ['4K', 3840, 2160]]) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const xx = c.getContext('2d');
        const st2 = s.setup ? s.setup({ w, h, rng: rng(7) }) : {};
        const ts = [0.2, 0.7, 1.3, 3, 7, 12, 30, 90];
        // 한 번 데운다 — 첫 그리기는 경로·그라디언트 준비로 느리다
        s.draw(xx, 1, w, h, st2);
        const t0 = performance.now();
        let n = 0;
        for (let k = 0; k < 3; k++) for (const t of ts) { xx.clearRect(0, 0, w, h); s.draw(xx, t, w, h, st2); n++; }
        xx.getImageData(0, 0, 1, 1);
        out['ms' + nm] = +((performance.now() - t0) / n).toFixed(2);
      }
      return out;
    })()`);

    console.log('  ', JSON.stringify({ ...r, throws: r.throws.length }));
    ok(r.throws.length === 0, `${id}: 어떤 크기·시각에서도 안 터진다`, r.throws.slice(0, 3));
    ok(r.arrival >= 1.2 && r.arrival <= 1.8, `${id}: 도착은 1.2~1.8초`, r.arrival);
    ok(r.detFresh && r.detAfter, `${id}: draw 는 t 만의 함수다`, { fresh: r.detFresh, after: r.detAfter });
    ok(r.litArrive > 0 && r.litLate > 0, `${id}: 도착 뒤와 1분 뒤에도 그림이 있다`, { a: r.litArrive, b: r.litLate });
    ok(r.moving.every(Boolean), `${id}: 머무는 동안에도 움직인다 (30초·2분·1시간 뒤)`, r.moving);
    // 한 점이라도 글 자리를 스치는 순간은 있을 수 있다. «계속 덮는»지를 본다.
    const worst = Math.max(...r.textBright);
    ok(worst <= 3, `${id}: 도착 뒤 글 자리를 밝게 덮지 않는다 (최대 3%)`, r.textBright);
    // 시험 기계는 다른 일도 한다 — 장면에 준 예산(4ms·10ms)보다 넉넉히 둔다
    ok(r.ms1080p <= 8, `${id}: 1080p 한 프레임 8ms 안`, r.ms1080p);
    ok(r.ms4K <= 20, `${id}: 4K 한 프레임 20ms 안`, r.ms4K);
  }

  if (errs.length) console.log('\n   콘솔 오류:', errs.slice(0, 5));
  ok(errs.length === 0, '장면을 싣는 동안 콘솔 오류가 없다', errs.slice(0, 3));
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

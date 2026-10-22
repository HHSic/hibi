'use strict';
// 메일 속 영상 링크 — 누르면 앱 안 플레이어로 (src/linkopen.js · src/videowin.js · src/win.js lockToOurPage).
//
// 사용자 보고: 소식지 본문이 «재생 단추가 그려진 썸네일» 그림 하나인데, 누르면 브라우저로만 간다 — «우리 메일쪽에서 재생되게 못하나?».
// 그 링크는 클릭 추적 주소라 따라가 봐야 영상인지 안다. 그래서 잰다:
//   [1] YouTube 주소 읽기 — 모든 꼴, 시작 시각, 영상이 아닌 YouTube 페이지, 닮은꼴 호스트
//   [2] 쿼리에 실린 영상 — 추적 주소를 안 부르고 읽는다 («공유하기» 주소는 빼고)
//   [3] <meta refresh> · 머리의 Refresh · location 스크립트 읽기
//   [4] 리다이렉트 풀기의 규칙 (가짜 한 단계로) — 영상을 만나면 거기서 멈추고 YouTube 에는 안 묻는다, 5단계, 시간, 스킴,
//       알려진 추적 주소만 · 다른 사이트와 일회용 링크는 안 부른다 · 사설·루프백은 안 부른다 · 쿠키 확인 바운스
//   [5] 진짜 네트워크(Electron net)로 127.0.0.1 의 지어낸 서버를 따라간다 — 쿠키·리퍼러·윈도우 인증 안 싣기, 본문 안 받기
//   [6] 누른 링크 열기 — 영상이면 플레이어, 아니면 «끝 주소»를 브라우저로, 실패하면 «원래 주소»를 브라우저로.
//       목록 밖의 링크와 일회용 링크는 앱이 안 부른다 (토큰을 앱이 써 버리면 누른 것이 사라진다)
//   [7] 플레이어 창 — 옵션·세션·리퍼러·못박기(누른 것만 브라우저로)·하위 프레임·권한·인증서·내려받기·못 틀 때 브라우저로·창 하나
//   [8] 메일 보기 창에서 진짜로 눌러 본다 (진짜 renderer/mailview.html, 화면 밖 창) — «여는 중…» 알약까지
//   [9] 배선 — mailwin.js 가 보기 창의 링크를 이 길로 보낸다 (mailwin 시험은 창을 띄우므로 글로 본다)
//
// 화면에는 아무것도 안 뜬다: 창은 전부 show:false (+ offscreen). 플레이어도 videowin.init({ make }) 로 그렇게 만든다.
// 앱(main.js)은 안 띄운다. 진짜 메일·진짜 추적 주소는 안 쓴다 — 리다이렉트는 127.0.0.1 의 지어낸 서버다.
// YouTube 도 부르지 않는다 — 플레이어 세션에 protocol.handle 로 지어낸 embed 페이지를 준다.
// 두 세션 모두 127.0.0.1 밖으로 가는 http 는 webRequest 로 끊고 적는다 — 끝에서 그 기록이 비었는지 본다.
// (진짜 YouTube 에서 재생되는지는 시험 밖에서 화면 밖 창으로 쟀다 — 오프라인이라고 이 시험이 깨지면 안 된다.)
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const { app, BrowserWindow, session, screen } = require('electron');

// 진짜 브라우저는 절대 안 띄운다 — 배선이 깨져 openWeb(shell.openExternal)까지 가면 여기 남는다
const external = [];
require('electron').shell.openExternal = async (u) => { external.push(u); };

process.on('uncaughtException', (e) => { console.error('시험 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('시험 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 170_000).unref();
app.on('window-all-closed', () => {});
// 혹시 새 창이 열리려 하면 막는다 — 보이는 창이 사용자 모니터에 뜨지 않게. 각 창은 제 손잡이를 다시 건다
app.on('web-contents-created', (_e, wc) => wc.setWindowOpenHandler(() => ({ action: 'deny' })));

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkopen-'));
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'Hibi'));

const linkopen = require(path.join(ROOT, 'src', 'linkopen.js'));
const videowin = require(path.join(ROOT, 'src', 'videowin.js'));
const { lockToOurPage, blockWindowsLogin } = require(path.join(ROOT, 'src', 'win.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  const s = x === undefined ? '' : JSON.stringify(x);
  console.log((c ? '  OK   ' : '  실패 ') + m + (s ? `  → ${c && s.length > 160 ? `${s.slice(0, 160)}…` : s}` : ''));
  if (!c) bad++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const until = async (fn, ms = 5000, step = 50) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

const VID = 'M7lc1UVf-VE';   // YouTube IFrame API 안내의 공개 시험 영상 (여기서는 번호로만 쓴다)
const yt = (id, start = 0, shorts = false) => ({ id, start, shorts });
// 시험 서버(127.0.0.1)를 «추적 주소»로 친다 — 진짜 목록(linkopen.TRACKERS)에는 없다
const local127 = (u) => { try { return new URL(u).hostname === '127.0.0.1'; } catch { return false; } };
const noDns = async () => [];

// ── 지어낸 리다이렉트 서버 (127.0.0.1) ─────────────────────
const hits = [];
let server;
let BASE = '';
let PORT = 0;
let DEAD = 0;        // 닫힌 포트 — 연결 실패
let tokenUsed = false;
function route(req, res) {
  const u = new URL(req.url, BASE);
  hits.push({ path: u.pathname + u.search, headers: req.headers });
  const p = u.pathname;
  const go = (code, loc, extra = {}) => { res.writeHead(code, { Location: loc, ...extra }); res.end(); };
  const html = (body, extra = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  // 윈도우 인증을 요구한다 — Authorization 이 오면 도전(Type2) 없이 바로 403 (해시가 든 Type3 은 만들어지지 않는다)
  const winAuth = (scheme) => {
    if (req.headers.authorization) { res.writeHead(403); return res.end(); }
    res.writeHead(401, { 'WWW-Authenticate': scheme, 'Content-Type': 'text/plain' });
    return res.end('no');
  };
  if (p === '/r1') return go(302, '/r2');
  if (p === '/r2') return go(301, `${BASE}/r3`);
  if (p === '/r3') return go(303, '/final');
  if (p === '/final' || p === '/article' || p === '/plain' || p === '/signin' || p === '/expired') return html('<!doctype html><title>기사</title><p>끝</p>');
  if (p === '/c1') return go(302, '/c2', { 'Set-Cookie': 'trk=1; Path=/' });
  if (p === '/c2') return html('<p>쿠키 확인</p>');
  // 쿠키 확인 바운스 — 200 껍데기가 쿠키를 심고 같은 사이트로 넘긴다 (3xx 의 Set-Cookie 는 Electron 이 안 보여 준다)
  if (p === '/c3') return html('<meta http-equiv="refresh" content="0; url=/c4">', { 'Set-Cookie': 'b=1; Path=/' });
  if (p === '/c4') return html('<p>쿠키가 없어 다시 확인</p>');
  if (p === '/m1') return html('<html><head><meta http-equiv="refresh" content="0; url=/m2"></head><body>잠시만요</body></html>');
  if (p === '/m2') return go(302, `https://www.youtube.com/watch?v=${VID}&t=1m5s`);
  if (p === '/m3') return html('<meta content="0;URL=\'/final?a=1&amp;b=2\'" http-equiv="Refresh">');
  if (p === '/m4') return html('<meta http-equiv="refresh" content="30; url=/final">');   // 30초 뒤 — 넘겨 주기가 아니다
  const bigBody = `<meta http-equiv="refresh" content="0; url=/final">${'x'.repeat(200 * 1024)}`;
  if (p === '/big') return html(bigBody, { 'Content-Length': Buffer.byteLength(bigBody) });
  if (p === '/bigchunk') {
    // 길이를 안 밝히고 두 번에 나눠 쓴다 (chunked)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write(bigBody.slice(0, 100 * 1024));
    setTimeout(() => res.end(bigBody.slice(100 * 1024)), 50);
    return;
  }
  if (p === '/biggzip') {
    // 압축은 작고(Content-Length 검사를 지난다) 풀면 200KB
    const gz = zlib.gzipSync(Buffer.from(bigBody));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    return res.end(gz);
  }
  if (p === '/hr') return html('<p>잠시만요</p>', { Refresh: '0; url=/final' });
  if (p === '/hr-plain') { res.writeHead(200, { 'Content-Type': 'text/plain', Refresh: '0;url=/final' }); return res.end(); }
  if (p === '/js1') return html(`<p>잠시만 기다려 주세요</p><script>location.replace("https://www.youtube.com/watch?v=${VID}&t=7")</script>`);
  if (p === '/js2') return html(`<script>window.location.href = 'https:\\/\\/youtu.be\\/${VID}?t=8';</script>`);
  if (p === '/js-onload') return html(`<body onload="location.replace('https://www.youtube.com/watch?v=${VID}&amp;t=9')">이동 중</body>`);
  if (p === '/js-article') {
    return html(`<h1>기사</h1><p>${'오늘의 소식을 전합니다. '.repeat(60)}</p>`
      + '<button onclick="go()">사러 가기</button><script>function go() { location.href = \'https://shop.example/\'; }</script>');
  }
  if (p.startsWith('/loop/')) return go(302, `/loop/${Number(p.slice(6)) + 1}`);
  if (p === '/hang') return;   // 답하지 않는다
  if (p === '/stream') {
    // 머리는 바로, 본문은 3초에 걸쳐 — 머리만 보고 끊는지 본다
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    let n = 0;
    const t = setInterval(() => { res.write(Buffer.alloc(1024)); if (++n >= 30) { clearInterval(t); res.end(); } }, 100);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (p === '/bad-file') return go(302, 'file:///C:/Windows/win.ini');
  if (p === '/bad-msdt') return go(302, 'ms-msdt:/id PCWDiagnostic');
  if (p === '/auth') { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"', 'Content-Type': 'text/plain' }); return res.end('no'); }
  if (p === '/ntlm') return winAuth('NTLM');
  if (p === '/neg') return winAuth('Negotiate');
  if (p === '/ntlm-img') return winAuth(['Negotiate', 'NTLM']);
  if (p === '/ntlm-page') return html(`<img src="/ntlm-img?${u.searchParams.get('n')}" width="40" height="40">`);
  if (p === '/trk') return go(302, '/article');
  if (p === '/trk-yt') return go(302, `https://youtu.be/${VID}?t=42`);
  if (p === '/slowtrk') { setTimeout(() => go(302, `https://www.youtube.com/watch?v=${VID}&t=90`), 700); return; }
  // 일회용 로그인 링크를 감싼 추적 — GET 한 번에 토큰을 쓰고 쿠키를 심는다 (실측 probe4 꼴)
  if (p === '/p4trk') return go(302, '/login?token=T1');
  if (p === '/login') {
    if (u.searchParams.get('token') !== 'T1' || tokenUsed) return go(302, '/expired');
    tokenUsed = true;
    return go(302, '/home', { 'Set-Cookie': 'sid=S1; Path=/' });
  }
  if (p === '/home') return /sid=S1/.test(req.headers.cookie || '') ? html('<p>로그인됨</p>') : go(302, '/signin');
  if (p === '/magic') return go(302, '/home', { 'Set-Cookie': 'sid=S1; Path=/' });
  // 추적 → 다른 사이트(localhost)의 일회용 주소 — 낱말로는 모른다
  if (p === '/xtrk') return go(302, `http://localhost:${PORT}/l/abc`);
  if (p === '/l/abc') return html('<p>한 번만</p>');
  if (p === '/t1') return go(302, '/t2');
  if (p === '/t2') return go(302, '/hang');
  if (p === '/b1') return go(302, `http://127.0.0.1:${DEAD}/dest`);
  res.writeHead(404); res.end();
}
const hitsOf = (prefix) => hits.filter((h) => h.path.startsWith(prefix));

app.whenReady().then(async () => {
  server = http.createServer(route);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = `http://127.0.0.1:${PORT}`;
  {
    const dead = http.createServer();
    await new Promise((res) => dead.listen(0, '127.0.0.1', res));
    DEAD = dead.address().port;
    await new Promise((res) => dead.close(res));
  }
  // 링크 풀기 세션이 혹시라도 https 를 부르면 여기 걸린다 — 진짜 바깥으로 안 나간다
  const linkHttps = [];
  session.fromPartition(linkopen.PARTITION).protocol.handle('https', (req) => {
    linkHttps.push(req.url);
    return new Response('막음', { status: 599 });
  });
  // http 는 protocol.handle 에 안 걸린다 (실측: 이름 풀이까지 갔다) — 127.0.0.1 밖이면 끊고 적는다
  const outside = [];
  for (const p of [linkopen.PARTITION, videowin.PARTITION]) {
    session.fromPartition(p).webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => {
      let u = null;
      try { u = new URL(d.url); } catch { /* 아래에서 끊는다 */ }
      if (u && (u.protocol === 'https:' || u.hostname === '127.0.0.1')) return cb({});   // https 는 protocol.handle 이 받는다
      outside.push(d.url);
      return cb({ cancel: true });
    });
  }

  // ── [1] YouTube 주소 읽기 ───────────────────────────
  console.log('\n[1] YouTube 주소 읽기');
  const YT_CASES = [
    [`https://www.youtube.com/watch?v=${VID}`, yt(VID)],
    [`https://youtube.com/watch?v=${VID}&t=90`, yt(VID, 90)],
    [`http://www.youtube.com/watch?feature=share&v=${VID}&t=1m30s`, yt(VID, 90)],
    [`https://m.youtube.com/watch?v=${VID}&t=1h2m3s`, yt(VID, 3723)],
    [`https://music.youtube.com/watch?v=${VID}&list=RDAMVM`, yt(VID)],
    [`https://WWW.YOUTUBE.COM/watch?v=${VID}`, yt(VID)],
    [`https://www.youtube.com./watch?v=${VID}`, yt(VID)],
    [`https://www.youtube.com/watch?v=${VID}#t=75`, yt(VID, 75)],
    [`https://youtu.be/${VID}`, yt(VID)],
    [`https://youtu.be/${VID}?si=abc&t=42`, yt(VID, 42)],
    [`https://www.youtube.com/shorts/${VID}`, yt(VID, 0, true)],
    [`https://youtube.com/shorts/${VID}?feature=share`, yt(VID, 0, true)],
    [`https://www.youtube.com/embed/${VID}?start=30`, yt(VID, 30)],
    [`https://www.youtube.com/live/${VID}?t=10s`, yt(VID, 10)],
    [`https://www.youtube.com/v/${VID}`, yt(VID)],
    [`https://www.youtube-nocookie.com/embed/${VID}?start=5`, yt(VID, 5)],
    [`https://youtube-nocookie.com/embed/${VID}`, yt(VID)],
    [`https://www.youtube.com/attribution_link?a=x&u=%2Fwatch%3Fv%3D${VID}%26feature%3Dshare`, yt(VID)],
    [`https://www.youtube.com/watch?v=${VID}&time_continue=12`, yt(VID, 12)],
    // 영상이 아닌 YouTube 페이지 — 브라우저로
    ['https://www.youtube.com/', null],
    ['https://www.youtube.com/@channel', null],
    ['https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw', null],
    ['https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs', null],
    ['https://www.youtube.com/embed/videoseries?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs', null],
    ['https://www.youtube.com/embed/live_stream?channel=UC_x5XG1OV2P6uZZ5FSM9Ttw', null],
    ['https://www.youtube.com/watch?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs', null],
    ['https://www.youtube.com/watch?v=short', null],
    ['https://www.youtube.com/results?search_query=cat', null],
    [`https://www.youtube.com/watch/${VID}`, null],
    [`https://www.youtube.com/shorts/${VID}/extra`, null],
    [`https://youtu.be/${VID}/extra`, null],
    [`https://www.youtube-nocookie.com/watch?v=${VID}`, null],
    // 닮은꼴 — 남의 주소
    [`https://youtube.com.evil.example/watch?v=${VID}`, null],
    [`https://evil.example/youtube.com/watch?v=${VID}`, null],
    [`https://www.youtube.com@evil.example/watch?v=${VID}`, null],
    [`https://notyoutube.com/watch?v=${VID}`, null],
    [`https://www.youtube.co/watch?v=${VID}`, null],
    [`https://youtube.com-evil.example/watch?v=${VID}`, null],
    [`https://youtu.be.evil.example/${VID}`, null],
    [`https://www.youtube.com:8443/watch?v=${VID}`, null],
    [`javascript:alert(1)//www.youtube.com/watch?v=${VID}`, null],
    [`ftp://www.youtube.com/watch?v=${VID}`, null],
    ['', null], [null, null]
  ];
  for (const [u, want] of YT_CASES) {
    const got = linkopen.youtubeOf(u);
    ok(same(got, want), `${String(u).slice(0, 90)} → ${want ? `${want.id}${want.start ? ` @${want.start}s` : ''}${want.shorts ? ' 쇼츠' : ''}` : '영상 아님'}`, same(got, want) ? undefined : got);
  }
  ok(linkopen.seconds('2m') === 120 && linkopen.seconds('1m30') === 90 && linkopen.seconds('abc') === 0 && linkopen.seconds('') === 0,
    '시작 시각 «2m»=120 · «1m30»=90 · 못 읽으면 0');

  // ── [2] 쿼리에 실린 영상 ────────────────────────────
  console.log('\n[2] 쿼리에 실린 영상 — 추적 주소를 안 부르고 읽는다');
  const enc = encodeURIComponent;
  const W = `https://www.youtube.com/watch?v=${VID}&t=15`;
  const P_CASES = [
    [`https://trk.example/c?u=${enc(W)}`, yt(VID, 15)],
    [`https://trk.example/c?id=7&url=${enc(enc(W))}`, yt(VID, 15)],                        // 두 번 인코딩
    [`https://trk.example/c?r=${enc(`https://trk2.example/x?dest=${enc(W)}`)}`, yt(VID, 15)],  // 추적 안의 추적
    [`https://trk.example/c?d=${Buffer.from(W).toString('base64url')}`, yt(VID, 15)],         // base64 로 싼 것
    [`https://trk.example/c#url=${enc(`https://youtu.be/${VID}`)}`, yt(VID)],
    [`https://trk.example/c?u=${enc(`https://www.youtube.com/shorts/${VID}`)}`, yt(VID, 0, true)],
    [`https://trk.example/c?u=${enc('https://www.youtube.com/@channel')}`, null],
    [`https://trk.example/c?u=${enc(`https://youtube.com.evil.example/watch?v=${VID}`)}`, null],
    [`https://trk.example/c?u=${enc(`www.youtube.com/watch?v=${VID}`)}`, null],              // 스킴 없는 글자는 주소로 안 본다
    ['https://trk.example/procresponse?a=Zm9vYmFyYmF6cXV4cXV1eA', null],                     // 알 수 없는 값
    // «공유하기» — 영상 주소를 싣지만 목적지는 공유 화면이다
    [`https://www.facebook.com/sharer/sharer.php?u=${enc(W)}`, null],
    [`https://twitter.com/intent/tweet?url=${enc(W)}`, null],
    [`https://www.linkedin.com/sharing/share-offsite/?url=${enc(W)}`, null],
    [`https://sharer.kakao.com/talk/friends/picker/link?url=${enc(W)}`, null],
    [`https://band.us/plugin/share?body=${enc(W)}`, null]
  ];
  for (const [u, want] of P_CASES) {
    const got = linkopen.youtubeInParams(u);
    ok(same(got, want), `${u.slice(0, 96)} → ${want ? want.id : '없음'}`, same(got, want) ? undefined : got);
  }

  // ── [3] meta refresh · Refresh 머리 · location 스크립트 ──
  console.log('\n[3] <meta http-equiv="refresh"> · Refresh 머리 · location 스크립트 읽기');
  const M_CASES = [
    ['<meta http-equiv="refresh" content="0; url=https://a.example/x">', 'https://a.example/x'],
    ['<META HTTP-EQUIV="Refresh" CONTENT="0;URL=/next">', '/next'],
    ['<meta content="1; url=\'https://a.example/?a=1&amp;b=2\'" http-equiv="refresh">', 'https://a.example/?a=1&b=2'],
    ['<meta http-equiv=refresh content=0;url=https://a.example/y>', 'https://a.example/y'],
    ['<meta http-equiv="refresh" content="5">', null],               // 다시 부르기일 뿐
    ['<meta http-equiv="refresh" content="30; url=/later">', null],  // 오래 기다렸다 넘기는 것은 진짜 페이지
    ['<meta name="viewport" content="0; url=/no">', null],
    ['<p>no meta</p>', null]
  ];
  for (const [h, want] of M_CASES) {
    const got = linkopen.metaRefresh(h);
    ok(got === want, `${h.slice(0, 70)} → ${want}`, got === want ? undefined : got);
  }
  ok(linkopen.refreshTarget('0; url=/final') === '/final' && linkopen.refreshTarget('0;url=/final') === '/final'
    && linkopen.refreshTarget('5') === null && linkopen.refreshTarget('30; url=/x') === null && linkopen.refreshTarget(undefined) === null,
  'Refresh 머리 값 — «0; url=…» 만 넘김 (그냥 «5»·30초는 아님)');
  const J_CASES = [
    ['<script>location.replace("https://a.example/x")</script>', 'https://a.example/x'],
    ["<script>window.location.href='https://a.example/x';</script>", 'https://a.example/x'],
    ['<script>document.location = "https://a.example/x"</script>', 'https://a.example/x'],
    ["<script>top.location.assign('https://a.example/x')</script>", 'https://a.example/x'],
    ['<body onload="location.replace(\'https://a.example/y?a=1&amp;b=2\')">잠시만요</body>', 'https://a.example/y?a=1&b=2'],
    ["<script>location.href='https:\\/\\/a.example\\/z';</script>", 'https://a.example/z'],    // JSON 꼴로 \/ 를 쓴 것
    ["<script>foo.location = 'https://a.example/'</script>", null],                            // 남의 물건
    ["<script>location.href = '/rel'</script>", null],                                         // 글자 그대로인 절대 주소만
    ["<script>location.href = 'https://a.example/' + id</script>", null],                      // 글자 덧셈 — 앞 조각만 잡힌다
    ["<script>if (location.href == 'https://a.example/') {}</script>", null],                  // 견주기
    [`<p>${'긴 기사 '.repeat(100)}</p><script>function go(){ location.href = 'https://shop.example/'; }</script>`, null]   // 글이 있는 진짜 페이지
  ];
  for (const [h, want] of J_CASES) {
    const got = linkopen.jsRedirect(h);
    ok(got === want, `location 스크립트 ${h.slice(0, 64)} → ${want}`, got === want ? undefined : got);
  }

  // ── [4] 풀기 규칙 (가짜 한 단계) ─────────────────────
  console.log('\n[4] 리다이렉트 풀기의 규칙 — 가짜 한 단계로 (이름 풀이도 가짜)');
  {
    // 가짜 hop 으로 돌릴 때도 진짜 DNS 에 묻지 않게 lookup 을 갈아 끼운다
    const R = (u, o = {}) => linkopen.resolve(u, { lookup: noDns, ...o });
    const asked = [];
    const map = {
      'https://t.example/a': { location: '/b' },
      'https://t.example/b': { refresh: `https://www.youtube.com/watch?v=${VID}&t=20` }
    };
    const hop = async (u) => { asked.push(u); return map[u] || { status: 200 }; };
    const r = await R('https://t.example/a', { hop });
    ok(r.ok && same(r.video, yt(VID, 20)) && r.hops === 2, '3xx → meta refresh → 영상: 영상에서 멈춘다', r);
    ok(same(asked, ['https://t.example/a', 'https://t.example/b']), '  YouTube 에는 안 묻는다 (부른 것은 추적 둘뿐)', asked);

    const loopAsked = [];
    const r2 = await R('https://t.example/0', { hop: async (u) => { loopAsked.push(u); return { location: `/${Number(u.split('/').pop()) + 1}` }; } });
    ok(r2.ok && r2.more && r2.hops === 5 && r2.url === 'https://t.example/5' && loopAsked.length === 5,
      '5단계를 넘으면 그만 — 부른 것은 5번, 아직 안 부른 다음 주소를 준다', { r2, n: loopAsked.length });

    const r3 = await R('https://t.example/s', { hop: async () => ({ location: 'file:///C:/x.exe' }) });
    ok(!r3.ok && r3.error === 'scheme', 'file: 로 넘기면 거기서 그만 (error: scheme)', r3);
    const r4 = await R('https://t.example/s', { hop: async () => ({ location: 'data:text/html,hi' }) });
    ok(!r4.ok && r4.error === 'scheme', 'data: 로 넘겨도 그만', r4);

    const t0 = Date.now();
    const r5 = await R('https://t.example/slow', { timeoutMs: 300, hop: async (u, left) => { await sleep(Math.min(left, 200)); return { location: '/again' }; } });
    ok(!r5.ok && r5.error === 'timeout' && Date.now() - t0 < 800, '전체 시간 안에 못 끝내면 timeout (한 단계씩은 남은 시간만 받는다)', { r5, ms: Date.now() - t0 });
    ok(r5.last === 'https://t.example/again', '  실패에 «막힌 단계의 주소»(last)를 싣는다 — 추적 단계는 이미 지났다', r5.last);
    const r6 = await R('https://t.example/x', { hop: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
    ok(!r6.ok && r6.error === 'ECONNREFUSED', '연결 실패는 그 까닭으로', r6);
    const r7 = await R('https://t.example/x', { hop: async () => ({ status: 200 }) });
    ok(r7.ok && r7.url === 'https://t.example/x' && r7.hops === 0 && !r7.video, '넘기지 않으면 그 주소가 끝', r7);
    ok(linkopen.MAX_HOPS === 5 && linkopen.TIMEOUT_MS <= 5000, `기본값: 5단계 · ${linkopen.TIMEOUT_MS}ms`);

    // 어디까지 부르나 — 알려진 추적 주소 · 같은 사이트 · 다른 사이트 · 일회용 링크
    const TRK = 'https://tr.maillink.co.kr/procresponse?a=opaque';
    const chain = (m) => { const a = []; return { asked: a, hop: async (u) => { a.push(u); return m[u] || { status: 200 }; } }; };
    let c = chain({ [TRK]: { location: 'https://news.example.com/story/1' } });
    let x = await R(TRK, { hop: c.hop });
    ok(x.ok && x.unfetched && x.url === 'https://news.example.com/story/1' && x.hops === 1 && same(c.asked, [TRK]),
      '추적 → 다른 사이트(기사): 그 주소는 부르지 않고 넘긴다 — 브라우저가 처음이자 한 번만 부른다', { x, asked: c.asked });
    c = chain({ [TRK]: { location: 'https://bit.ly/abc' }, 'https://bit.ly/abc': { location: `https://youtu.be/${VID}?t=3` } });
    x = await R(TRK, { hop: c.hop });
    ok(x.ok && same(x.video, yt(VID, 3)) && same(c.asked, [TRK, 'https://bit.ly/abc']), '  추적 → 단축 주소(bit.ly, 목록에 있다) → youtu.be: 따라가서 영상', { x, asked: c.asked });
    c = chain({ [TRK]: { location: 'https://trs.maillink.co.kr/next?b=1' } });
    x = await R(TRK, { hop: c.hop });
    ok(x.ok && !x.unfetched && x.url === 'https://trs.maillink.co.kr/next?b=1' && c.asked.length === 2, '  같은 사이트(maillink.co.kr)의 다음 단계는 부른다', { x, asked: c.asked });
    c = chain({ [TRK]: { location: '/login?token=T1' } });
    x = await R(TRK, { hop: c.hop });
    ok(x.ok && x.unfetched && x.url === 'https://tr.maillink.co.kr/login?token=T1' && same(c.asked, [TRK]),
      '  같은 사이트여도 일회용 링크 꼴(/login?token=)은 부르지 않는다', { x, asked: c.asked });

    // 쿠키 확인 바운스 — 쿠키를 심고 같은 사이트로 넘기면, 쿠키 없이 끝까지 간 오류 페이지 대신 그 단계부터 브라우저가
    c = chain({ 'https://a.example/bounce': { location: '/check', cookie: true }, 'https://a.example/check': { location: '/error' } });
    x = await R('https://a.example/bounce', { hop: c.hop });
    ok(x.ok && x.cookie && x.url === 'https://a.example/bounce', '쿠키 확인 바운스: 끝(/error)이 아니라 쿠키를 심은 단계(/bounce)를 넘긴다', x);
    c = chain({ [TRK]: { location: 'https://news.example.com/a', cookie: true } });
    x = await R(TRK, { hop: c.hop });
    ok(x.ok && !x.cookie && x.url === 'https://news.example.com/a', '  쿠키를 심었어도 다른 사이트로 넘기면 그 끝 주소 그대로', x);

    // 사설·루프백 — 부르지 않고 그 주소를 그대로 (브라우저로 넘어가 사용자가 주소를 본다)
    const LOCAL = ['http://127.0.0.1:9/x', 'http://[::1]/admin', 'http://169.254.169.254/latest/meta-data', 'http://192.168.0.1/',
      'http://localhost:9222/json', 'http://nas/share', 'http://2130706433/', 'http://0x7f.1/', 'http://10.0.0.5/', 'http://172.16.3.4/',
      'http://100.64.1.1/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[::ffff:192.168.0.1]/', 'http://printer.local/'];
    const leaks = [];
    for (const u of LOCAL) {
      const a = [];
      const y = await R(u, { hop: async (h) => { a.push(h); return { status: 200 }; } });
      if (!(y.ok && y.local && y.hops === 0 && !a.length && y.url === u)) leaks.push({ u, y, a });
    }
    ok(!leaks.length, `사설·루프백·링크로컬·한 낱말 이름 ${LOCAL.length}가지: 시작 주소여도 부르지 않는다 (2130706433·0x7f.1 은 127.0.0.1)`, leaks);
    const PUB = ['http://8.8.8.8/', 'http://[2001:4860::8888]/', 'http://172.32.0.1/', 'http://100.128.0.1/', 'https://www.example.com/'];
    ok(PUB.every((u) => !linkopen.hostLocal(u)), '  공인 주소는 막지 않는다 (172.32 · 100.128 · 2001:…)', PUB.filter((u) => linkopen.hostLocal(u)));
    c = chain({ [TRK]: { location: 'https://bit.ly/rebind' } });
    x = await R(TRK, { hop: c.hop, lookup: async (h) => (h === 'bit.ly' ? ['10.1.2.3'] : ['203.0.113.7']) });
    ok(x.ok && x.local && x.url === 'https://bit.ly/rebind' && same(c.asked, [TRK]), '  가는 길에 이름이 사설 주소로 풀리면(10.1.2.3) 그 단계는 부르지 않는다', { x, asked: c.asked });
    c = chain({});
    x = await R('https://127.0.0.1.nip.example/x', { hop: c.hop, lookup: async () => ['::ffff:127.0.0.1'] });
    ok(x.ok && x.local && !c.asked.length, '  시작 주소의 이름이 루프백으로 풀려도(::ffff:127.0.0.1) 안 부른다', x);

    // 낱말·사이트·목록
    const TR = [['https://tr.maillink.co.kr/x', true], ['https://trs.maillink.co.kr/x', true], ['http://bit.ly/a', true],
      ['https://us5.list-manage.com/track/click', true], ['https://u1.ct.sendgrid.net/ls/click', true],
      ['https://maillink.co.kr.evil.example/', false], ['https://evilbit.ly/', false], ['https://www.example.com/', false], ['ftp://bit.ly/x', false]];
    ok(TR.every(([u, w]) => linkopen.isTracker(u) === w), '알려진 추적·단축 주소 목록 — 그 호스트와 그 아래만 (닮은꼴 아님)', TR.filter(([u, w]) => linkopen.isTracker(u) !== w));
    const ST = [['https://tr.maillink.co.kr/', 'maillink.co.kr'], ['https://a.b.example.com/', 'example.com'], ['https://news.bbc.co.uk/', 'bbc.co.uk'],
      ['http://127.0.0.1:5/', '127.0.0.1'], ['http://localhost:3/', 'localhost']];
    ok(ST.every(([u, w]) => linkopen.siteOf(u) === w), '사이트 — 등록 도메인 (co.kr·co.uk 는 한 단 더)', ST.map(([u]) => linkopen.siteOf(u)));
    const OS = [['https://x.example/login?token=T1', true], ['https://x.example/sign-in', true], ['https://x.example/magic_link?x=1', true],
      ['https://x.example/verify-email', true], ['https://x.example/a?confirmation_token=x', true], ['https://x.example/unsubscribe', true],
      ['https://tr.maillink.co.kr/procresponse?a=xx', false], ['https://us5.list-manage.com/track/click?u=1&id=2&e=3', false],
      ['https://bit.ly/3authX', false], ['https://x.example/story/1?utm_source=x', false]];
    ok(OS.every(([u, w]) => linkopen.oneShot(u) === w), '일회용 링크 꼴 — 경로 조각·쿼리 이름의 낱말로 (값은 안 본다)', OS.filter(([u, w]) => linkopen.oneShot(u) !== w));
  }

  // ── [5] 진짜 네트워크로 따라가기 ──────────────────────
  console.log('\n[5] Electron net 으로 127.0.0.1 의 지어낸 서버를 따라간다');
  {
    // 시험 서버가 127.0.0.1 이라 사설 주소 막기를 이 시험에서만 연다
    const RL = (u, o = {}) => linkopen.resolve(u, { allowLocal: true, ...o });
    const linkSes = session.fromPartition(linkopen.PARTITION);
    ok(!/^persist:/.test(linkopen.PARTITION) && linkSes.isPersistent() === false, `링크 풀기 세션 ${linkopen.PARTITION} — 메모리에만 (persist: 아님)`,
      { partition: linkopen.PARTITION, persistent: linkSes.isPersistent() });

    let r = await RL(`${BASE}/r1`);
    ok(r.ok && r.url === `${BASE}/final` && r.hops === 3, '302 → 301 → 303 → 200: 끝 주소', r);

    r = await RL(`${BASE}/c1`);
    const c2 = hitsOf('/c2')[0];
    ok(r.ok && c2 && !c2.headers.cookie, '추적 서버가 심은 쿠키를 다음 단계에 안 싣는다', c2 && c2.headers.cookie);
    const jar = await linkSes.cookies.get({});
    ok(jar.length === 0, '  세션 저장소에도 쿠키가 안 남는다', jar.map((k) => k.name));
    r = await RL(`${BASE}/c3`);
    ok(r.ok && r.cookie && r.url === `${BASE}/c3`, '200 껍데기가 쿠키를 심고 같은 사이트로 넘기면 — 브라우저는 그 단계(/c3)부터 (쿠키 확인 바운스)', r);
    const anyRef = hits.filter((h) => h.headers.referer || h.headers.authorization || h.headers.cookie);
    ok(!anyRef.length, '  어느 단계에도 Referer·Authorization·Cookie 가 없다', anyRef.map((h) => h.path));
    const ua = String(hitsOf('/r1')[0].headers['user-agent'] || '');
    ok(ua && !/Electron\/|Hibi\//i.test(ua), '  UA 에 Electron·앱 이름이 없다 (보통 크롬처럼)', ua.slice(0, 120));

    r = await RL(`${BASE}/m1`);
    ok(r.ok && same(r.video, yt(VID, 65)) && r.hops === 2, 'meta refresh → 302 → YouTube: 영상 (1m5s → 65초)', r);
    r = await RL(`${BASE}/m3`);
    ok(r.ok && r.url === `${BASE}/final?a=1&b=2` && r.hops === 1, '상대 주소 · &amp; 를 푼 meta refresh', r);
    r = await RL(`${BASE}/m4`);
    ok(r.ok && r.url === `${BASE}/m4` && r.hops === 0, '30초 뒤 refresh 는 따라가지 않는다', r);
    r = await RL(`${BASE}/big`);
    ok(r.ok && r.url === `${BASE}/big` && r.hops === 0, '64KB 넘는 HTML 은 안 읽는다 (그 안의 refresh 도 안 따른다)', r);
    r = await RL(`${BASE}/bigchunk`);
    ok(r.ok && r.url === `${BASE}/bigchunk` && r.hops === 0, '  길이를 안 밝힌(chunked) 200KB 도 — 앞 64KB 의 refresh 를 안 따른다', r);
    r = await RL(`${BASE}/biggzip`);
    ok(r.ok && r.url === `${BASE}/biggzip` && r.hops === 0, '  gzip 으로 작게 와서 풀면 200KB 인 것도', r);

    r = await RL(`${BASE}/hr`);
    ok(r.ok && r.url === `${BASE}/final` && r.hops === 1, '머리의 Refresh: 0; url=/final 도 한 단계 (브라우저도 따라간다 — 안 보면 추적을 두 번 친다)', r);
    r = await RL(`${BASE}/hr-plain`);
    ok(r.ok && r.url === `${BASE}/final` && r.hops === 1, '  HTML 이 아니고 본문이 없어도', r);

    r = await RL(`${BASE}/js1`);
    ok(r.ok && same(r.video, yt(VID, 7)) && r.hops === 1, '200 HTML 의 location.replace("https://www.youtube.com/…&t=7"): 영상', r);
    r = await RL(`${BASE}/js2`);
    ok(r.ok && same(r.video, yt(VID, 8)), '  window.location.href = \'https:\\/\\/youtu.be\\/…\' (\\/ 꼴)', r);
    r = await RL(`${BASE}/js-onload`);
    ok(r.ok && same(r.video, yt(VID, 9)), '  <body onload="location.replace(…)">', r);
    r = await RL(`${BASE}/js-article`);
    ok(r.ok && r.url === `${BASE}/js-article` && r.hops === 0, '  글이 있는 진짜 페이지의 «누르면 가는» 스크립트는 넘김이 아니다', r);

    const before = hitsOf('/loop/').length;
    r = await RL(`${BASE}/loop/0`);
    ok(r.ok && r.more && r.url === `${BASE}/loop/5` && hitsOf('/loop/').length - before === 5,
      '끝없는 넘김: 5번 부르고 그만, 다음 주소(/loop/5)를 준다', { r, n: hitsOf('/loop/').length - before });

    let t0 = Date.now();
    r = await RL(`${BASE}/hang`, { timeoutMs: 600 });
    ok(!r.ok && r.error === 'timeout' && Date.now() - t0 < 1500, '답 없는 서버: 시간 초과', { r, ms: Date.now() - t0 });

    t0 = Date.now();
    r = await RL(`${BASE}/stream`);
    const ms = Date.now() - t0;
    ok(r.ok && r.url === `${BASE}/stream` && ms < 1500, `HTML 이 아닌 답은 머리만 보고 끊는다 (${ms}ms — 본문은 3초짜리)`, r);

    r = await RL(`${BASE}/bad-file`);
    ok(!r.ok, 'Location: file:/// → 실패로 (그 주소를 열지 않는다)', r);
    r = await RL(`${BASE}/bad-msdt`);
    ok(!r.ok, 'Location: ms-msdt: → 실패로', r);

    t0 = Date.now();
    r = await RL(`${BASE}/auth`);
    ok(r.ok && r.url === `${BASE}/auth` && r.status === 401 && Date.now() - t0 < 2000, '401 은 이름·암호를 묻지 않고 그 자리가 끝', r);

    // 윈도우 통합 인증 — 아무 곳에나 계정으로 인증을 거는 설정('*')에서도 링크 풀기는 Authorization 을 안 싣는다 (credentials:'omit').
    // 이 값은 네트워크 서비스 전체에 걸린다 — 아래 blockWindowsLogin 이 다시 끈다
    linkSes.allowNTLMCredentialsForDomains('*');
    for (const p of ['/ntlm', '/neg']) {
      const n0 = hitsOf(p).length;
      r = await RL(`${BASE}${p}`);
      const got = hitsOf(p).slice(n0);
      ok(r.ok && r.status === 401 && got.length >= 1 && got.every((h) => !h.headers.authorization),
        `  401 WWW-Authenticate: ${p === '/ntlm' ? 'NTLM' : 'Negotiate'} — 윈도우 계정으로 인증을 걸지 않는다`, { r, auth: got.map((h) => h.headers.authorization || '') });
    }
    // 메일 보기 창 꼴(기본 세션의 원격 그림) — 앱 시작 때의 blockWindowsLogin() 뒤에는 그림에 인증이 안 실린다
    {
      const nw = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
      const imgHits = (n) => hits.filter((h) => h.path === `/ntlm-img?${n}`);
      await nw.loadURL(`${BASE}/ntlm-page?n=1`);
      await until(() => imgHits(1).length && !nw.webContents.isLoading(), 3000);
      await sleep(300);
      const pre = imgHits(1).some((h) => h.headers.authorization);
      console.log(`         (참고: 끄기 전 '*' 설정에서는 그림 요청에 Authorization 이 ${pre ? '실렸다' : '안 실렸다'})`);
      blockWindowsLogin();
      await nw.loadURL(`${BASE}/ntlm-page?n=2`);
      await until(() => imgHits(2).length && !nw.webContents.isLoading(), 3000);
      await sleep(300);
      const post = imgHits(2);
      ok(post.length >= 1 && post.every((h) => !h.headers.authorization), 'blockWindowsLogin 뒤 기본 세션의 원격 그림에 Authorization: NTLM·Negotiate 가 없다',
        post.map((h) => h.headers.authorization || ''));
      nw.destroy();
    }

    r = await RL(`http://127.0.0.1:${DEAD}/x`);
    ok(!r.ok && r.error, '닫힌 포트: 실패', r);

    r = await RL(`${BASE}/trk-yt`);
    ok(r.ok && same(r.video, yt(VID, 42)), '추적 → youtu.be: 영상', r);

    // 사설 막기를 열지 않으면 — 127.0.0.1 · [::1] · localhost 의 시험 서버도 부르지 않는다
    const n1 = hits.length;
    const L = [`${BASE}/r1`, `http://[::1]:${PORT}/admin`, `http://localhost:${PORT}/admin`];
    const lr = [];
    for (const u of L) lr.push(await linkopen.resolve(u));
    ok(lr.every((x, i) => x.ok && x.local && x.url === L[i] && x.hops === 0) && hits.length === n1,
      '진짜 net 으로도: 사설 막기를 안 열면 127.0.0.1·[::1]·localhost 는 부르지 않고 그 주소를 그대로', { lr, hits: hits.length - n1 });
    ok(!linkHttps.length, '  풀기 세션은 https 를 한 번도 안 불렀다 (YouTube 에 안 묻는다)', linkHttps);
  }

  // ── [6] 누른 링크 열기 ──────────────────────────────
  console.log('\n[6] 누른 링크 열기 — 영상이면 플레이어, 아니면 브라우저');
  {
    const played = [];
    const opened = [];
    const resolved = [];
    const realResolve = linkopen.resolve;
    const O = { allowLocal: true, tracked: local127 };
    const viaReal = (extra = {}) => (u) => { resolved.push(u); return realResolve(u, { ...O, ...extra }); };
    linkopen.init({ play: (v) => played.push(v), web: (u) => opened.push(u), resolve: viaReal(), tracked: local127 });
    const reset = () => { played.length = 0; opened.length = 0; resolved.length = 0; };
    const busyLog = [];
    const busy = (on) => busyLog.push(on);

    let r = await linkopen.openLink(`https://youtu.be/${VID}?t=3`, { busy });
    ok(r.how === 'play' && same(played, [yt(VID, 3)]) && !resolved.length && !opened.length && !busyLog.length,
      'YouTube 주소: 바로 튼다 — 풀지도, 알리지도 않는다', { r, played, resolved });
    reset();

    let n0 = hits.length;
    r = await linkopen.openLink(`${BASE}/procresponse?a=x&url=${enc(`https://www.youtube.com/watch?v=${VID}`)}`, { busy });
    ok(r.how === 'play' && same(played, [yt(VID)]) && !resolved.length && hits.length === n0,
      '쿼리에 영상: 튼다 — 추적 서버에는 안 간다', { r, hits: hits.length - n0 });
    reset();

    r = await linkopen.openLink(`${BASE}/trk`, { busy });
    ok(r.how === 'web' && same(opened, [`${BASE}/article`]) && !played.length, '추적 → 기사: «끝 주소»를 브라우저로 (추적을 두 번 안 친다)', { r, opened });
    ok(same(busyLog, [true, false]), '  푸는 동안 알린다 (true → false)', busyLog);
    reset();

    r = await linkopen.openLink(`${BASE}/m1`);
    ok(r.how === 'play' && same(played, [yt(VID, 65)]) && !opened.length, '추적 → meta refresh → YouTube: 튼다', { r, played });
    reset();

    r = await linkopen.openLink(`${BASE}/js1`);
    ok(r.how === 'play' && same(played, [yt(VID, 7)]) && !opened.length, '추적 → 200 HTML 의 location.replace → YouTube: 7초부터 튼다', { r, played });
    reset();

    r = await linkopen.openLink(`${BASE}/bad-msdt`);
    ok(r.how === 'web' && same(opened, [`${BASE}/bad-msdt`]), '풀다 실패: «원래 주소»를 브라우저로 (누른 것이 안 사라진다)', { r, opened });
    reset();

    linkopen.init({ resolve: viaReal({ timeoutMs: 400 }) });
    r = await linkopen.openLink(`${BASE}/hang`);
    ok(r.how === 'web' && r.error === 'timeout' && same(opened, [`${BASE}/hang`]), '시간 초과: 원래 주소를 브라우저로', { r, opened });
    reset();

    // 추적 단계를 지난 뒤에 막히면 — 막힌 그 단계부터 (추적 서버는 이미 우리가 쳤다)
    linkopen.init({ resolve: viaReal({ timeoutMs: 600 }) });
    n0 = hitsOf('/t1').length;
    r = await linkopen.openLink(`${BASE}/t1`);
    ok(r.how === 'web' && same(opened, [`${BASE}/hang`]) && hitsOf('/t1').length - n0 === 1,
      '/t1 → /t2 → /hang 시간 초과: 브라우저는 /hang 부터 — /t1 은 한 번만 맞는다', { r, opened, t1: hitsOf('/t1').length - n0 });
    reset();
    linkopen.init({ resolve: viaReal() });
    r = await linkopen.openLink(`${BASE}/b1`);
    ok(r.how === 'web' && same(opened, [`http://127.0.0.1:${DEAD}/dest`]), '  /b1 → 닫힌 포트: 브라우저는 그 목적지부터', { r, opened });
    reset();

    linkopen.init({ resolve: async (u) => { resolved.push(u); throw new Error('터짐'); } });
    r = await linkopen.openLink(`${BASE}/trk`);
    ok(r.how === 'web' && same(opened, [`${BASE}/trk`]), '푸는 쪽이 터져도 원래 주소를 브라우저로', { r, opened });
    reset();
    linkopen.init({ resolve: viaReal() });

    // 공유 주소는 쿼리를 안 본다 — 추적 목록에도 없으니 앱은 부르지 않는다
    const share = `https://www.facebook.com/sharer/sharer.php?u=${enc(`https://www.youtube.com/watch?v=${VID}`)}`;
    r = await linkopen.openLink(share);
    ok(r.how === 'web' && !played.length && same(opened, [share]) && !resolved.length, '«페이스북에 공유» 단추: 영상이 아니라 공유 화면 (풀지도 않는다)', { r, opened });
    reset();

    r = await linkopen.openLink('mailto:someone@example.com');
    ok(r.how === 'web' && same(opened, ['mailto:someone@example.com']) && !resolved.length, 'http(s) 가 아니면 예전 그대로 (openWeb 에 맡긴다)', { r, opened });
    reset();

    // 목록 밖의 링크는 앱이 안 부른다 — 진짜 목록으로 (127.0.0.1 은 거기 없다)
    linkopen.init({ tracked: linkopen.isTracker });
    n0 = hits.length;
    r = await linkopen.openLink(`${BASE}/plain?token=ONE`);
    ok(r.how === 'web' && same(opened, [`${BASE}/plain?token=ONE`]) && hits.length === n0 && !resolved.length,
      '추적 목록 밖의 평범한 링크: 앱은 한 번도 안 부르고 원래 주소를 브라우저로', { r, hits: hits.length - n0 });
    reset();
    linkopen.init({ tracked: local127 });
    n0 = hits.length;
    r = await linkopen.openLink(`${BASE}/magic?token=1`);
    ok(r.how === 'web' && same(opened, [`${BASE}/magic?token=1`]) && hits.length === n0,
      '  추적 주소여도 일회용 링크 꼴(/magic?token=)이면 앱은 안 부른다', { r, hits: hits.length - n0 });
    reset();

    // 실측 probe4 꼴: 추적 → /login?token=T1 (토큰 소모 + Set-Cookie) → /home → /signin
    tokenUsed = false;
    r = await linkopen.openLink(`${BASE}/p4trk`);
    ok(r.how === 'web' && same(opened, [`${BASE}/login?token=T1`]) && hitsOf('/login').length === 0 && !tokenUsed,
      '추적 → 일회용 로그인: 앱은 /login 을 안 부르고 브라우저에 /login?token=T1 을 — 토큰은 브라우저가 처음 쓴다', { r, opened, login: hitsOf('/login').length });
    reset();
    r = await linkopen.openLink(`${BASE}/xtrk`);
    ok(r.how === 'web' && same(opened, [`http://localhost:${PORT}/l/abc`]) && hitsOf('/l/abc').length === 0,
      '  추적 → 다른 사이트(localhost)의 주소: 낱말이 없어도 부르지 않고 넘긴다', { r, opened });
    reset();

    // 두 번 눌러도 한 번만 — 푸는 사이 같은 링크
    const [a, b] = await Promise.all([linkopen.openLink(`${BASE}/trk`), linkopen.openLink(`${BASE}/trk`)]);
    ok(a.how === 'web' && b.how === 'busy' && opened.length === 1, '푸는 사이 또 누르면 한 번만 연다', { a, b, opened });
    reset();

    r = await linkopen.openLink(`${BASE}/loop/0`);
    ok(r.how === 'web' && same(opened, [`${BASE}/loop/5`]), '5단계를 다 쓰면 아직 안 부른 다음 주소(/loop/5)를 브라우저로 (원래 주소가 아니다)', { r, opened });
    reset();

    // 플레이어가 터져도 링크는 브라우저로 — 영상은 이미 아니까 추적 주소가 아니라 그 영상의 YouTube 페이지를
    linkopen.init({ play: () => { throw new Error('창 못 만듦'); } });
    n0 = hitsOf('/m1').length;
    r = await linkopen.openLink(`${BASE}/m1`);
    ok(r.how === 'web' && same(opened, [`https://www.youtube.com/watch?v=${VID}&t=65s`]) && hitsOf('/m1').length - n0 === 1,
      '플레이어가 터지면 브라우저로 — 추적(/m1)을 다시 치지 않고 watch 주소(65초째)', { r, opened });
    reset();
    // 바로 영상인 링크에서 터지면 — opener 가 받아 그 주소를 브라우저로
    linkopen.opener(null)(`https://youtu.be/${VID}?t=4`);
    await until(() => opened.length, 2000);
    ok(same(opened, [`https://youtu.be/${VID}?t=4`]), '  바로 영상인 링크에서 터져도 opener 가 그 주소를 브라우저로 (누른 것이 안 사라진다)', opened);
    reset();
    linkopen.init({ play: (v) => played.push(v) });

    // «여는 중…» 알약 — 링크 둘을 이어 누르면 둘 다 끝나야 걷는다
    const sent = [];
    const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, s) => sent.push([ch, s]) } };
    linkopen.init({ resolve: async (u) => { await sleep(u.endsWith('A') ? 250 : 800); return { ok: true, url: u, hops: 0 }; } });
    const op = linkopen.opener(fakeWin);
    op(`${BASE}/pillA`);
    await sleep(80);
    op(`${BASE}/pillB`);
    await until(() => opened.length === 1, 2000);
    const mid = sent.slice();
    await until(() => opened.length === 2, 3000);
    ok(same(mid, [['mail:link', 'wait']]) && same(sent, [['mail:link', 'wait'], ['mail:link', '']]),
      '알약: A 가 먼저 끝나도 B 가 남았으면 안 걷는다 — wait 한 번, 둘 다 끝나고 \'\' 한 번', { mid, sent });
    reset();
    linkopen.init({ resolve: realResolve, tracked: linkopen.isTracker });
  }

  // ── [7] 플레이어 창 ─────────────────────────────────
  console.log('\n[7] 플레이어 창 — 다리 없는 따로 창, 그 영상의 embed 에 못박기');
  {
    const ses = session.fromPartition(videowin.PARTITION);
    const asked = [];
    const hold = [];   // 끝나지 않는 그림 요청 (갈아 끼울 때의 -3 을 만든다)
    const full = 'position:fixed;inset:0;display:block';
    const PAGE = {
      OKVIDEO0001: '<video></video><p>재생 중</p>',
      SHORTSVID01: '<p>쇼츠</p>',
      ERRVIDEO001: '<div class="ytp-error"><div class="ytp-error-content-wrap-reason">이 동영상은 볼 수 없습니다.</div></div>',
      HIDERR00001: '<div class="ytp-error" style="display:none"></div><video></video>',
      SUBHANG0001: '<p>그림 기다리는 중</p><img src="https://www.youtube-nocookie.com/hang.png">',
      NAVVIDEO001: '<script>setTimeout(() => { location.href = "https://evil.example/nav"; }, 50);</script>',
      POPVIDEO001: '<script>setTimeout(() => { window.__w = window.open("https://www.youtube.com/watch?v=POPVIDEO001"); }, 50);</script>',
      CLICKPOP001: `<a href="https://www.youtube.com/watch?v=CLICKPOP001" target="_blank" style="${full}">YouTube에서 보기</a>`,
      CLICKNAV001: `<a href="https://www.youtube.com/watch?v=CLICKNAV001" style="${full}">제목</a>`,
      FRAMEVID001: '<iframe src="https://phish.example/inside-frame"></iframe><iframe src="https://www.youtube.com/okframe"></iframe>',
      PERMVIDEO01: `<script>
        window.__perm = {};
        Notification.requestPermission().then((r) => { window.__perm.notif = r; });
        navigator.permissions.query({ name: 'geolocation' }).then((s) => { window.__perm.geo = s.state; });
        navigator.mediaDevices.getUserMedia({ video: true }).then(() => { window.__perm.cam = 'granted'; }, (e) => { window.__perm.cam = e.name; });
      </script>`
    };
    ses.protocol.handle('https', (req) => {
      const u = new URL(req.url);
      asked.push({ url: req.url, referer: req.headers.get('referer') || req.referrer || '' });
      if (u.pathname === '/hang.png') return new Promise((r) => hold.push(r));
      const m = u.hostname === videowin.EMBED_HOST && u.pathname.match(/^\/embed\/([\w-]{11})$/);
      if (m && m[1] === 'REDIRVIDEO1') return new Response(null, { status: 302, headers: { Location: 'https://evil.example/after-redirect' } });
      // 망 오류(오프라인·DNS 꼴) — did-fail-load
      if (m && m[1] === 'NETFAILVID1') return Response.error();
      if (m && PAGE[m[1]] !== undefined) {
        return new Response(`<!doctype html><html><head><title>가짜 YouTube</title></head><body>${PAGE[m[1]]}</body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response('없음', { status: 404 });
    });

    const made = [];
    const opened = [];
    let reveals = 0;
    const web = (u) => opened.push(u);
    videowin.init({
      make: (o) => {
        made.push(o);
        // 화면에 안 올린다 — 옵션은 그대로 두고 show·offscreen 만 덧씌운다
        return new BrowserWindow({ ...o, show: false, webPreferences: { ...o.webPreferences, offscreen: true } });
      },
      web,
      reveal: () => { reveals++; }
    });
    const windowsNow = () => BrowserWindow.getAllWindows().length;
    const n0 = windowsNow();

    const w = videowin.play(yt('OKVIDEO0001', 7), null);
    const o = made[0];
    const wp = o.webPreferences;
    ok(o.title === '영상' && wp.preload === undefined && wp.sandbox === true && wp.contextIsolation === true
      && wp.nodeIntegration === false && wp.webSecurity === true && wp.nodeIntegrationInSubFrames === false && wp.webviewTag === false,
    '옵션: 제목 «영상» · preload 없음 · sandbox · contextIsolation · nodeIntegration 끔 · webSecurity', { title: o.title, wp });
    ok(wp.allowRunningInsecureContent === false && wp.plugins === false && wp.navigateOnDragDrop === false && wp.spellcheck === false
      && wp.safeDialogs === true && wp.autoplayPolicy === 'no-user-gesture-required',
    '  혼합 콘텐츠·플러그인·끌어 놓기 이동 끔 · 맞춤법 끔 · 대화 상자 막기 · 자동 재생');
    ok(wp.partition === 'hibi-video' && !/^persist:/.test(wp.partition) && ses.isPersistent() === false,
      '  제 세션 hibi-video — 메모리에만 (persist: 아님)', { partition: wp.partition, persistent: ses.isPersistent() });
    ok(Math.abs(o.width / o.height - 16 / 9) < 0.01 && o.width <= 960 && o.useContentSize === true,
      `  16:9 내용 크기 ${o.width}×${o.height}`, { w: o.width, h: o.height });

    await until(() => w.webContents.getURL().includes('/embed/OKVIDEO0001'), 5000);
    await until(() => !w.webContents.isLoading(), 5000);
    ok(w.webContents.getURL() === videowin.embedUrl(yt('OKVIDEO0001', 7))
      && /autoplay=1/.test(w.webContents.getURL()) && /start=7/.test(w.webContents.getURL()) && /rel=0/.test(w.webContents.getURL()),
    'youtube-nocookie embed 를 autoplay=1 · start=7 · rel=0 으로 연다', w.webContents.getURL());
    const lp = w.webContents.getLastWebPreferences();
    ok(lp.sandbox === true && lp.contextIsolation === true && lp.nodeIntegration === false && lp.webSecurity !== false && !lp.preload,
      '  만들어진 창의 실제 webPreferences 도 그렇다', { sandbox: lp.sandbox, ci: lp.contextIsolation, ni: lp.nodeIntegration, preload: lp.preload });
    const ref = await w.webContents.executeJavaScript('document.referrer');
    const okAsk = asked.find((a) => a.url.includes('/embed/OKVIDEO0001'));
    ok(ref === videowin.REFERRER, `페이지의 document.referrer = ${videowin.REFERRER} (없으면 YouTube 가 오류 153)`, ref);
    ok(okAsk && okAsk.referer === videowin.REFERRER, '  embed 요청에도 Referer 가 실린다', okAsk && okAsk.referer);
    await sleep(300);
    ok(w.getTitle() === '영상', '페이지 제목이 «가짜 YouTube»여도 창 제목은 «영상»', w.getTitle());

    // 누르지 않은 이동·새 창 — 크롬이면 팝업 차단이 막았을 것. 조용히 막고 브라우저도 안 연다
    const w2 = videowin.play(yt('NAVVIDEO001'), null);
    ok(w2 === w && made.length === 1 && windowsNow() === n0 + 1 && reveals === 1, '새 영상은 떠 있는 창에서 갈아 끼운다 (창 하나)', { same: w2 === w, made: made.length, reveals });
    await until(() => w.webContents.getURL().includes('NAVVIDEO001') && !w.webContents.isLoading(), 4000);
    await sleep(800);
    ok(!opened.length && w.webContents.getURL().includes('/embed/NAVVIDEO001') && !asked.some((a) => a.url.startsWith('https://evil.example/nav')),
      '누르지 않은 location 이동: 막고 브라우저도 안 연다 (창은 embed 그대로)', { opened, url: w.webContents.getURL() });

    videowin.play(yt('POPVIDEO001'), null);
    await until(() => w.webContents.getURL().includes('POPVIDEO001') && !w.webContents.isLoading(), 4000);
    await sleep(800);
    ok(!opened.length && windowsNow() === n0 + 1, '누르지 않은 window.open: 막고 브라우저도 안 연다 — 창은 그대로 하나', { opened, windows: windowsNow() - n0 });

    // 사용자가 누른 것 — «YouTube에서 보기»(새 창)·제목 링크(이동)는 브라우저로
    const clickPlayer = () => {
      w.webContents.sendInputEvent({ type: 'mouseDown', x: 60, y: 60, button: 'left', clickCount: 1 });
      w.webContents.sendInputEvent({ type: 'mouseUp', x: 60, y: 60, button: 'left', clickCount: 1 });
    };
    videowin.play(yt('CLICKPOP001'), null);
    await until(() => w.webContents.getURL().includes('CLICKPOP001') && !w.webContents.isLoading(), 4000);
    clickPlayer();
    await until(() => opened.length, 3000);
    ok(same(opened, ['https://www.youtube.com/watch?v=CLICKPOP001']) && windowsNow() === n0 + 1,
      '누른 «YouTube에서 보기»(target=_blank): 새 창은 막고 그 주소를 브라우저로', { opened });
    opened.length = 0;
    videowin.play(yt('CLICKNAV001'), null);
    await until(() => w.webContents.getURL().includes('CLICKNAV001') && !w.webContents.isLoading(), 4000);
    clickPlayer();
    await until(() => opened.length, 3000);
    ok(same(opened, ['https://www.youtube.com/watch?v=CLICKNAV001']) && w.webContents.getURL().includes('/embed/CLICKNAV001'),
      '누른 제목 링크(창 안 이동): 막고 그 주소를 브라우저로 (창은 embed 그대로)', { opened, url: w.webContents.getURL() });
    opened.length = 0;

    // 하위 프레임 — YouTube·Google 쪽만
    videowin.play(yt('FRAMEVID001'), null);
    await until(() => w.webContents.getURL().includes('FRAMEVID001') && !w.webContents.isLoading(), 4000);
    await sleep(500);
    const frames = w.webContents.mainFrame.framesInSubtree.map((f) => f.url);
    ok(!asked.some((a) => a.url.startsWith('https://phish.example')) && asked.some((a) => a.url === 'https://www.youtube.com/okframe')
      && !frames.some((f) => f.includes('phish.example')),
    '하위 프레임: phish.example 은 막고 www.youtube.com 은 둔다 (주소창 없는 창 안에 남의 페이지가 안 그려진다)', frames);
    ok(videowin.frameAllowed('about:blank') && videowin.frameAllowed('https://googleads.g.doubleclick.net/x')
      && !videowin.frameAllowed('http://www.youtube.com/') && !videowin.frameAllowed('https://youtube.com.evil.example/')
      && !videowin.frameAllowed('https://x@www.youtube.com/'),
    '  frameAllowed — https 의 YouTube·Google 과 그 아래만 (http·닮은꼴·이름 붙은 주소는 아님)');

    videowin.play(yt('PERMVIDEO01'), null);
    const perm = await until(async () => {
      if (!w.webContents.getURL().includes('PERMVIDEO01') || w.webContents.isLoading()) return null;
      const p = await w.webContents.executeJavaScript('window.__perm || null');
      return p && p.notif && p.geo && p.cam ? p : null;
    }, 9000);
    ok(perm && perm.notif === 'denied' && perm.geo === 'denied' && perm.cam === 'NotAllowedError',
      '권한: 알림·위치·카메라 모두 거절', perm);
    ok(videowin.permissionAllowed('fullscreen') === true
      && ['media', 'notifications', 'geolocation', 'clipboard-read', 'openExternal', 'pointerLock', 'midiSysex'].every((p) => !videowin.permissionAllowed(p)),
    '  허락하는 것은 전체 화면 하나');
    let prevented = false;
    ses.emit('will-download', { preventDefault: () => { prevented = true; } }, { getFilename: () => 'x.bin' }, w.webContents);
    ok(prevented, '내려받기는 막는다 (will-download 에서 preventDefault)');
    let certPrevented = false;
    let certArgs = null;
    w.webContents.emit('select-client-certificate', { preventDefault: () => { certPrevented = true; } }, 'https://ads.example/', [{ subjectName: 'CN=me' }],
      (...a) => { certArgs = a; });
    ok(w.webContents.listenerCount('select-client-certificate') >= 1 && certPrevented && same(certArgs, []),
      '클라이언트 인증서: 기본값(«저장소의 첫 인증서»)을 막고 인증서 없이 이어 간다', { n: w.webContents.listenerCount('select-client-certificate'), certArgs });

    // 같은 영상을 1초 안에 또 누르면(더블클릭) 다시 부르지 않고 앞으로만
    const embedsOf = (s) => asked.filter((a) => a.url.includes('/embed/OKVIDEO0001') && a.url.includes(`start=${s}`)).length;
    const rv0 = reveals;
    videowin.play(yt('OKVIDEO0001', 11), null);
    videowin.play(yt('OKVIDEO0001', 11), null);
    await until(() => w.webContents.getURL().includes('start=11') && !w.webContents.isLoading(), 4000);
    await sleep(200);
    ok(embedsOf(11) === 1 && reveals - rv0 === 2, '같은 영상을 이어 두 번: embed 는 한 번만 부르고 창만 앞으로', { embeds: embedsOf(11), reveals: reveals - rv0 });

    // 쇼츠 — 9:16 로 바뀐다. 사용자가 옮겨 둔 자리(가운데)는 지킨다
    const area = screen.getDisplayMatching(w.getBounds()).workArea;
    w.setContentBounds({ x: area.x + 60, y: area.y + 90, width: 960, height: 540 });
    await sleep(100);
    const cur = w.getContentBounds();
    const top = Math.max(0, cur.y - w.getBounds().y);
    videowin.play(yt('SHORTSVID01', 0, true), null);
    await sleep(200);
    const cs = w.getContentSize();
    ok(Math.abs(cs[0] / cs[1] - 9 / 16) < 0.02, `쇼츠는 9:16 (${cs[0]}×${cs[1]})`, cs);
    const want = videowin.boundsAround(cur, area, true, top);
    const nb = w.getContentBounds();
    ok(Math.abs(nb.x - want.x) <= 2 && Math.abs(nb.y - want.y) <= 2 && Math.abs((nb.x + nb.width / 2) - (cur.x + cur.width / 2)) <= 2,
      '  비율이 바뀌어도 모니터 가운데로 튀지 않고 지금 창의 가운데를 지킨다 (작업 영역 밖이면 안으로)', { cur, want, now: nb });
    const ba = videowin.boundsAround({ x: 1800, y: 900, width: 960, height: 540 }, { x: 0, y: 0, width: 1920, height: 1040 }, true, 30);
    ok(ba.x + ba.width <= 1920 && ba.y + ba.height <= 1040 && ba.y >= 30, '  boundsAround — 오른쪽 아래 구석이면 작업 영역 안으로 민다', ba);

    // 숨은 오류 덮개는 오류가 아니다 — 정상 재생을 닫으면 안 된다
    videowin.play(yt('HIDERR00001'), null);
    await until(() => w.webContents.getURL().includes('HIDERR00001') && !w.webContents.isLoading(), 4000);
    await sleep(2200);
    ok(!w.isDestroyed() && !opened.length, '숨은(display:none) .ytp-error 는 오류로 안 본다 — 창은 그대로, 브라우저 안 연다', { destroyed: w.isDestroyed(), opened });

    // 그림이 아직 오는 중에 갈아 끼우면 main frame 에 did-fail-load -3 이 온다 — 끊은 것이지 못 튼 것이 아니다
    const fails = [];
    w.webContents.on('did-fail-load', (_e, code, _d, _u, main) => { if (main) fails.push(code); });
    videowin.play(yt('SUBHANG0001'), null);
    await until(() => hold.length, 4000);
    videowin.play(yt('OKVIDEO0001', 13), null);
    await until(() => w.webContents.getURL().includes('start=13') && !w.webContents.isLoading(), 4000);
    await sleep(500);
    ok(!w.isDestroyed() && !opened.length && fails.includes(-3), '갈아 끼울 때의 -3 은 넘긴다 — 창은 그대로, 브라우저 안 연다', { fails, destroyed: w.isDestroyed(), opened });

    // 못 트는 영상 — 오류 덮개가 뜨면 창을 닫고 YouTube 페이지를 브라우저로.
    // 그 브라우저 열기와 같은 틱에 새 영상이 오면(링크 풀기가 마침 끝났다) — 닫히는 창이 아니라 새 창에 띄운다
    let raced = null;
    videowin.init({ web: (u) => { web(u); if (!raced && u.includes('ERRVIDEO001')) raced = videowin.play(yt('OKVIDEO0001', 4), null); } });
    videowin.play(yt('ERRVIDEO001', 12), null);
    const gone = await until(() => w.isDestroyed() && opened.length, 6000);
    ok(gone && same(opened, ['https://www.youtube.com/watch?v=ERRVIDEO001&t=12s']),
      '오류 덮개(.ytp-error) → 창을 닫고 watch 주소(시작 시각째)를 브라우저로', { opened, destroyed: w.isDestroyed() });
    await sleep(300);
    ok(raced && raced !== w && !raced.isDestroyed() && made.length === 2 && videowin.current() === raced,
      '  닫히는 중에 온 새 영상은 새 창으로 — 앞 창의 closed 가 새 창을 지우지 않는다', { made: made.length, current: videowin.current() === raced });
    videowin.init({ web });
    // 사용자가 X 로 닫는 것(close())과 같은 틱에 온 영상도 — 'close' 에서 곧바로 빼므로 새 창으로
    raced.close();
    const again = videowin.play(yt('OKVIDEO0001', 5), null);
    ok(again !== raced && made.length === 3 && videowin.current() === again, '  X 로 닫는 중에 온 영상도 새 창으로', { made: made.length });
    await until(() => raced.isDestroyed(), 3000);
    ok(videowin.current() === again, '  닫힌 앞 창이 새 창을 «떠 있는 플레이어»에서 지우지 않는다');
    again.destroy();
    opened.length = 0;

    // 서버가 딴 곳으로 넘기면 — 따라가지 않고 브라우저로
    const w3 = videowin.play(yt('REDIRVIDEO1'), null);
    ok(made.length === 4, '창을 닫은 뒤에는 새 창을 만든다', made.length);
    const gone3 = await until(() => w3.isDestroyed() && opened.length, 6000);
    ok(gone3 && same(opened, ['https://www.youtube.com/watch?v=REDIRVIDEO1']) && !asked.some((a) => a.url.startsWith('https://evil.example')),
      'embed 가 딴 곳으로 넘기면 따라가지 않고(evil.example 안 부름) 브라우저로', { opened, evil: asked.filter((a) => a.url.includes('evil')).map((a) => a.url) });
    opened.length = 0;

    // 망 오류(오프라인·DNS) — 창을 닫고 브라우저로
    const w4 = videowin.play(yt('NETFAILVID1', 9), null);
    const gone4 = await until(() => w4.isDestroyed() && opened.length, 6000);
    ok(gone4 && same(opened, ['https://www.youtube.com/watch?v=NETFAILVID1&t=9s']) && videowin.current() === null,
      'embed 를 못 불러오면(did-fail-load) 창을 닫고 watch 주소를 브라우저로', { opened, destroyed: w4.isDestroyed() });
    opened.length = 0;

    // 새 창 자리 — 메일 보기 창이 있는 모니터에
    // 주 모니터가 아닌 것이 있으면 그것으로 — 주 모니터 길(play(…, null))과 갈라 잰다
    const ds = screen.getAllDisplays();
    const prim = screen.getPrimaryDisplay();
    const disp = ds.find((d) => d.id !== prim.id) || prim;
    const wa = disp.workArea;
    const near = new BrowserWindow({ show: false, x: wa.x + 40, y: wa.y + 40, width: 500, height: 400, webPreferences: { offscreen: true } });
    const w5 = videowin.play(yt('OKVIDEO0001'), near);
    const o5 = made[made.length - 1];
    ok(made.length === 6 && o5.x >= wa.x && o5.y >= wa.y && o5.x + o5.width <= wa.x + wa.width && o5.y + o5.height <= wa.y + wa.height,
      `새 플레이어는 메일 보기 창이 있는 모니터(${disp === prim ? '주 모니터뿐' : '주 모니터가 아닌 것'})의 작업 영역 안에 뜬다`, { o5: { x: o5.x, y: o5.y, w: o5.width, h: o5.height }, wa });
    w5.destroy();
    near.destroy();

    // 이상한 번호는 주소에 안 넣는다
    let threw = false;
    try { videowin.play({ id: '../../x?a=b' }, null); } catch { threw = true; }
    ok(threw && made.length === 6, '영상 번호 꼴이 아니면 창을 안 만든다');

    // 진짜 창 만들기(기본 factory) — 시험의 가짜 make 가 아니라 운영이 쓰는 함수로 만든 창의 실제 webPreferences
    const cw = videowin.createWindow({ ...videowin.playerOptions(videowin.boundsIn(wa, false)), show: false });
    const cp = cw.webContents.getLastWebPreferences() || {};
    ok(cp.sandbox === true && cp.contextIsolation === true && cp.nodeIntegration === false && !cp.preload && cp.webSecurity !== false
      && cp.allowRunningInsecureContent === false && cp.nodeIntegrationInSubFrames === false && cp.webviewTag === false && cp.safeDialogs === true
      && cw.webContents.session === ses,
    'createWindow(운영의 기본 factory)로 만든 창: sandbox · contextIsolation · preload 없음 · 혼합 콘텐츠 끔 · 하위 프레임 node 끔 · hibi-video 세션',
    { sandbox: cp.sandbox, ci: cp.contextIsolation, ni: cp.nodeIntegration, preload: cp.preload, insecure: cp.allowRunningInsecureContent, sub: cp.nodeIntegrationInSubFrames });
    // (plugins·navigateOnDragDrop·spellcheck 는 getLastWebPreferences 에 안 나온다 — 위의 playerOptions 검사가 잰다)
    cw.destroy();

    // 머물러도 되는 곳 — 그 영상의 embed 뿐
    const E = [
      ['https://www.youtube-nocookie.com/embed/OKVIDEO0001?autoplay=1', true],
      ['https://www.youtube-nocookie.com/embed/OTHERVIDEO1', false],
      ['http://www.youtube-nocookie.com/embed/OKVIDEO0001', false],
      ['https://www.youtube-nocookie.com.evil.example/embed/OKVIDEO0001', false],
      ['https://www.youtube-nocookie.com:444/embed/OKVIDEO0001', false],
      ['https://x@www.youtube-nocookie.com/embed/OKVIDEO0001', false],
      ['https://www.youtube.com/embed/OKVIDEO0001', false],
      ['https://www.youtube-nocookie.com/embed/OKVIDEO0001/../../evil', false]
    ];
    ok(E.every(([u, want]) => videowin.isEmbedFor(u, 'OKVIDEO0001') === want), 'isEmbedFor — 그 영상의 embed 만 (닮은꼴·http·포트·딴 영상은 아님)',
      E.filter(([u, want]) => videowin.isEmbedFor(u, 'OKVIDEO0001') !== want));

    // 창 크기 — 작업 영역에 맞춘다
    const B = [
      [{ x: 0, y: 0, width: 1920, height: 1040 }, false, { x: 480, y: 250, width: 960, height: 540 }],
      [{ x: 1920, y: 0, width: 1280, height: 680 }, false],   // 작은 모니터 — 85% 안
      [{ x: 0, y: 0, width: 1920, height: 1040 }, true, { x: 758, y: 160, width: 405, height: 720 }],
      [{ x: -1080, y: 0, width: 1080, height: 600 }, true]    // 왼쪽 모니터, 낮은 화면의 쇼츠
    ];
    for (const [ar, shorts, wantB] of B) {
      const b = videowin.boundsIn(ar, shorts);
      const ratio = shorts ? 9 / 16 : 16 / 9;
      const fits = b.width <= ar.width * 0.85 + 1 && b.height <= ar.height * 0.85 + 1
        && b.x >= ar.x && b.y >= ar.y && b.x + b.width <= ar.x + ar.width && b.y + b.height <= ar.y + ar.height;
      ok(fits && Math.abs(b.width / b.height - ratio) < 0.02 && (!wantB || same(b, wantB)),
        `boundsIn ${ar.width}×${ar.height}@${ar.x}${shorts ? ' 쇼츠' : ''} → ${b.width}×${b.height} at ${b.x},${b.y}`, b);
    }
    ok(videowin.watchUrl(yt(VID, 0, true)) === `https://www.youtube.com/shorts/${VID}` && videowin.watchUrl(yt(VID, 61)) === `https://www.youtube.com/watch?v=${VID}&t=61s`,
      'watchUrl — 쇼츠·시작 시각');
    for (const r of hold) r(new Response('', { status: 404 }));
  }

  // ── [8] 메일 보기 창에서 진짜로 눌러 본다 ─────────────
  console.log('\n[8] 메일 보기 창(진짜 mailview.html, 화면 밖)에서 눌러 본다');
  {
    const played = [];
    const opened = [];
    linkopen.init({ play: (v, near) => played.push({ ...v, near: !!near }), web: (u) => opened.push(u),
      resolve: (u) => linkopen.resolve(u, { allowLocal: true, tracked: local127 }), tracked: local127 });
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const html = '<table width="600"><tr><td>'
      + `<a href="${BASE}/slowtrk?a=opaque" target="_blank" title="썸네일"><img src="data:image/png;base64,${PNG}" width="300" height="170" alt="영상 보기"></a>`
      + '</td></tr></table>'
      + `<p><a href="${BASE}/trk" title="기사">기사 읽기</a></p>`
      + `<p><a href="https://www.youtube.com/watch?v=${VID}&amp;t=30" target="_blank" title="바로">바로 보기</a></p>`;
    const payload = { subject: '지어낸 소식지', from: '보낸 사람', at: Date.UTC(2026, 9, 22, 1, 0), uid: 1, mailbox: 'INBOX',
      accountId: 'acc-test', seen: true, to: '', cc: '', text: '', html, attachments: [] };
    const { ipcMain } = require('electron');
    ipcMain.on('stub:mailview', (e) => { e.returnValue = payload; });
    const w = new BrowserWindow({ show: false, width: 700, height: 640,
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'fixtures', 'mailview-bridge-stub.js'),
        contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    lockToOurPage(w, { openUrl: linkopen.opener(w) });
    const wc = w.webContents;
    const js = (c) => wc.executeJavaScript(c);
    await w.loadFile(path.join(ROOT, 'renderer', 'mailview.html'), { query: { radius: '20', theme: 'dark' } });
    const ready = await until(() => js(`!!document.querySelector('#body .mail') && !!document.querySelector('#body .mail').shadowRoot.querySelector('a[title="바로"]')`));
    ok(ready, '본문이 그려졌다 (그림 링크 · 글 링크 · YouTube 링크)');
    const center = (title) => js(`(() => { const a = document.querySelector('#body .mail').shadowRoot.querySelector('a[title="${title}"]');
      const r = (a.querySelector('img') || a).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    const click = async (title) => {
      const [x, y] = await center(title);
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    };
    const note = () => js(`(() => { const n = document.getElementById('linknote'); return n.hidden ? '' : n.textContent; })()`);

    // 1) 썸네일 그림 (target=_blank, 느린 추적 → YouTube)
    await click('썸네일');
    const shown = await until(async () => (await note()) === '여는 중…', 2000, 30);
    ok(!!shown, '그림을 누르면 «여는 중…» 알약이 뜬다 (추적 주소를 푸는 동안)');
    await until(() => played.length, 4000);
    ok(same(played, [{ id: VID, start: 90, shorts: false, near: true }]) && !opened.length,
      '  추적 너머가 YouTube 라 플레이어로 (90초부터, 기준 창 = 이 메일 창)', { played, opened });
    const hidden = await until(async () => (await note()) === '', 1000, 30);
    ok(hidden !== null, '  다 풀면 알약이 걷힌다');
    played.length = 0;

    // 2) 글 링크 (target 없음 → will-navigate 길)
    await click('기사');
    await until(() => opened.length, 4000);
    ok(same(opened, [`${BASE}/article`]) && !played.length, '글 링크(창 안 이동 길)도 같은 길 — 끝 주소를 브라우저로', { opened });
    opened.length = 0;

    // 3) YouTube 링크 그대로
    const n0 = hits.length;
    await click('바로');
    await until(() => played.length, 2000);
    ok(same(played, [{ id: VID, start: 30, shorts: false, near: true }]) && hits.length === n0, 'YouTube 링크는 바로 플레이어로 (아무 데도 안 묻는다)', { played });
    ok(wc.getURL().includes('mailview.html'), '메일 창은 제 페이지 그대로 (남의 페이지로 안 바뀐다)', wc.getURL().slice(-40));
    ok(BrowserWindow.getAllWindows().length === 1 + (videowin.current() ? 1 : 0), '새 창이 안 생겼다 (메일 창 하나뿐)', BrowserWindow.getAllWindows().length);
    w.destroy();
    linkopen.init({ resolve: linkopen.resolve, tracked: linkopen.isTracker });
  }

  // ── [9] 배선 ────────────────────────────────────────
  console.log('\n[9] 배선 — 메일 보기 창의 링크가 이 길로 간다');
  {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    // 주석 속 글자에 맞지 않게 주석을 지우고 본다 (주소 속 // 도 잘리지만 아래 검사에는 상관없다)
    const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const mw = code(read('src/mailwin.js'));
    const at = mw.indexOf('function openMailView(');
    const body = at >= 0 ? mw.slice(at, mw.indexOf('\nfunction ', at + 10)) : '';
    const wired = body.match(/lockToOurPage\(win, \{ openUrl: linkopen\.opener\(win\) \}\)/g) || [];
    const locks = body.match(/lockToOurPage\(/g) || [];
    ok(/require\('\.\/linkopen'\)/.test(mw) && wired.length === 1 && locks.length === 1,
      'mailwin.js — openMailView 가 보기 창을 lockToOurPage(win, { openUrl: linkopen.opener(win) }) 로 한 번 잠근다 (주석 빼고)', { wired: wired.length, locks: locks.length });
    const wj = read('src/win.js');
    const lock = wj.slice(wj.indexOf('function lockToOurPage'), wj.indexOf('function maxSize'));
    ok(/const open = opts\.openUrl \|\| openWeb/.test(lock) && (lock.match(/\bopen\(url\)/g) || []).length === 2 && !/openWeb\(url\)/.test(lock),
      'win.js — 창 안 이동·새 창 열기 둘 다 그 openUrl 로 (안 주면 예전처럼 openWeb)');
    ok(/onMailLink:\s*\(cb\) => ipcRenderer\.on\('mail:link'/.test(read('src/preload.js')), "preload — onMailLink 가 'mail:link' 를 듣는다");
    const mv = read('renderer/mailview.html');
    ok(/nunsseom\.onMailLink\(/.test(mv) && /id="linknote"/.test(mv) && /여는 중…/.test(mv), 'mailview.html — 알약(#linknote)과 «여는 중…»');
    const vw = code(read('src/videowin.js'));
    ok(/httpReferrer: REFERRER/.test(vw) && !/onBeforeSendHeaders/.test(vw), 'videowin.js — 리퍼러는 loadURL 의 httpReferrer 로 (세션 갈고리 없음)');
    ok(/make: createWindow,/.test(vw) && /function createWindow\(opts\) \{\s*return new BrowserWindow\(opts\);\s*\}/.test(vw),
      'videowin.js — 운영의 창 만들기는 createWindow(옵션을 그대로 넘긴다) — 위에서 그 함수로 만든 창을 쟀다');
    const mj = code(read('src/main.js'));
    const ready = mj.slice(mj.indexOf('app.whenReady().then('), mj.indexOf('app.whenReady().then(') + 400);
    ok(/blockWindowsLogin\(\);/.test(ready) && /blockWindowsLogin \} = require\('\.\/win'\)/.test(mj),
      'main.js — 앱이 준비되면 맨 먼저 blockWindowsLogin() (메일 원격 그림이 윈도우 계정으로 인증을 안 건다)');
  }

  ok(!external.length, '진짜 브라우저(shell.openExternal)는 한 번도 안 불렸다', external);
  ok(!outside.length && !linkHttps.length, '링크·플레이어 세션이 127.0.0.1 밖으로 낸 http 요청 없음 · 링크 세션의 https 없음', { outside, linkHttps });

  server.closeAllConnections();
  server.close();
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

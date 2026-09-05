const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 남이 보낸 메일 HTML이 실제로 «실행되지 않는지» 본다.
//
// 두 겹을 따로, 그리고 겹쳐서 잰다:
//   1. src/mail.js buildViewHtml — 메인의 정규식 세정 (첫 관문)
//   2. renderer/safehtml.js — 진짜 DOM 에서 훑는 세정 (주 방어)
// (src/htmlclean.js 는 이 길에 없다 — 그건 «내가 쓴 서명·보내는 메일»용이다.)
// 그냥 문자열 비교로 끝내지 않는다. 진짜 창을 띄워 본문을 넣고,
// 핸들러가 실제로 «불렸는지»를 창 안에서 세어 본다 — 그게 뚫렸다는 유일한 증거다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanlab-'));
app.setPath('appData', tmp);

const mail = require(`${ROOT}/src/mail.js`);

/** 받은 메일이 메인에서 씻기는 그대로 — 첫 관문 */
const gate = (html) => mail.buildViewHtml({ html, attachments: [] }, { allowRemote: true }).html;

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 뚫리면 창 안에서 무엇이든 «불린다». 그 부름을 세도록 만든 미끼들.
const ATTACKS = [
  ['따옴표 뒤 onerror (공백 없음)', '<img src="x"onerror="window.PWNED++">'],
  ['홑따옴표 뒤 onerror', "<img src='x'onerror='window.PWNED++'>"],
  ['따옴표 없는 onerror', '<img src=x onerror=window.PWNED++>'],
  ['안 닫은 script', '<script>window.PWNED++'],
  ['닫은 script', '<script>window.PWNED++<\/script>'],
  ['대소문자 섞은 script', '<ScRiPt>window.PWNED++<\/ScRiPt>'],
  ['svg onload', '<svg onload="window.PWNED++"></svg>'],
  ['body onload', '<body onload="window.PWNED++">'],
  ['iframe srcdoc', '<iframe srcdoc="&lt;script&gt;parent.PWNED++&lt;/script&gt;"></iframe>'],
  ['iframe javascript:', '<iframe src="javascript:parent.PWNED++"></iframe>'],
  ['object data', '<object data="javascript:window.PWNED++"></object>'],
  ['form + formaction', '<form><button formaction="javascript:window.PWNED++">x</button></form>'],
  ['style expression', '<div style="width:expression(window.PWNED++)">x</div>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:window.PWNED++">'],
  ['base 로 링크 바꾸기', '<base href="javascript:window.PWNED++//">'],
  ['details ontoggle', '<details open ontoggle="window.PWNED++">x</details>'],
  ['input onfocus autofocus', '<input autofocus onfocus="window.PWNED++">'],
  ['video onerror', '<video><source onerror="window.PWNED++"></video>'],
  ['이중으로 감싼 script', '<scr<script>ipt>window.PWNED++<\/script>'],
  ['주석으로 끊기', '<img src="x" o<!-- -->nerror="window.PWNED++">'],
  ['개행 넣은 onerror', '<img src="x"\nonerror="window.PWNED++">'],
  ['탭 넣은 onerror', '<img src="x"\tonerror="window.PWNED++">'],
  ['널문자 섞기', '<img src="x" on\u0000error="window.PWNED++">'],
  ['백틱', '<img src=`x`onerror=window.PWNED++>'],
  // <style> 은 안쪽 CSS 를 씻으려고 따로 다루는데, 그러다 속성 검사를 건너뛰어 뚫렸었다.
  // 앞 글자가 따옴표라 메인의 정규식도 못 잡는다 — 두 관문이 같은 자리에서 나란히 샜다.
  ['style 에 붙은 onload', '<style a="b"onload="window.PWNED++">p{color:red}</style>'],
  ['style 에 붙은 onanimationstart',
    '<style a="b"onanimationstart="window.PWNED++">style{display:block;animation:z .01s}'
    + '@keyframes z{from{opacity:1}to{opacity:1}}</style>'],
  ['style 에 공백으로 붙은 onload', '<style onload="window.PWNED++">p{color:red}</style>'],
];

// <style> 안의 것들은 «불렸나»로 못 잰다 — 크로미움에서 CSS 는 코드를 돌리지 않는다
// (expression() 은 옛 IE 것). 그러니 «남았나»로 본다.
const CSS_KILL = [
  ['@import', '<style>@import url("//evil.example/x.css");</style>', /@import/i],
  ['expression()', '<style>.a{width:expression(alert(1))}</style>', /expression\s*\(/i],
  ['behavior:', '<style>.a{behavior:url(x.htc)}</style>', /behavior\s*:/i],
  ['-moz-binding', '<style>.a{-moz-binding:url(x.xml)}</style>', /-moz-binding/i],
  ['style 안 javascript:', '<style>.a{background:url(javascript:alert(1))}</style>', /javascript:/i],
];

// 링크로 새 창을 열어 밖으로 나가려는 것들 — 부름은 안 세지고, 「남았나」로 본다
const LINKS = [
  ['javascript: 링크', '<a href="javascript:alert(1)">x</a>'],
  ['엔티티 탭 javascript:', '<a href="java&#9;script:alert(1)">x</a>'],
  ['엔티티 십진 javascript:', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['엔티티 십육진 javascript:', '<a href="&#x6a;avascript:alert(1)">x</a>'],
  ['개행 섞은 javascript:', '<a href="java\nscript:alert(1)">x</a>'],
  ['data:text/html 링크', '<a href="data:text/html,<script>alert(1)<\/script>">x</a>'],
  ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
  ['file: 로 내 파일 열기', '<a href="file:///C:/Windows/win.ini">x</a>'],
  ['그림 data:text/html', '<img src="data:text/html,<script>alert(1)<\/script>">'],
];

// 이건 살아 있어야 한다 — 다 막아 놓고 메일이 안 읽히면 소용없다
const KEEP = [
  ['보통 글', '<p>button on the table</p>', ['button on the table']],
  ['보통 링크', '<a href="https://a.com">누르기</a>', ['누르기', 'https://a.com']],
  ['보통 그림', '<img src="https://a.com/p.png" alt="사진">', ['a.com/p.png']],
  ['표', '<table><tr><td>가</td><td>나</td></tr></table>', ['가', '나']],
  ['글자 꾸밈', '<div style="color:#f00;font-size:14px">빨강</div>', ['빨강', 'color']],
  ['data: 그림', '<img src="data:image/png;base64,iVBORw0KGgo=">', ['data:image/png']],
  ['목록', '<ul><li>하나</li><li>둘</li></ul>', ['하나', '둘']],
  ['굵게 · 기울임', '<b>굵게</b> <i>기울임</i>', ['굵게', '기울임']],
  // HTML 메일은 꾸밈을 <style> 로 싣는다. 이걸 버리면 회사 메일이 통째로 무너진다.
  ['style 태그', '<style>.a{color:#f00}</style><p class="a">빨강</p>', ['color:#f00', '빨강']],
  ['style 안의 그림', '<style>.b{background:url(https://a.com/p.png)}</style><p class="b">x</p>',
    ['a.com/p.png']],
  ['form 안의 글', '<form><p>신청서 안내</p></form>', ['신청서 안내']],
  // 회사 서명의 전화번호 · 소식지의 noscript 대체 그림 — 다 막고 안 읽히면 소용없다
  ['전화 링크', '<a href="tel:+821012345678">010-1234-5678</a>', ['tel:+821012345678']],
  ['noscript 대체 내용', '<noscript><img src="https://a.com/hero.png" alt="상품"></noscript>',
    ['a.com/hero.png']],
];

// 메일이 이 창의 요소를 가로채면 안 된다 — 본문은 #body 안에 들어가는데,
// 창이 쓰는 #saved·#blocked·#lightbox 는 그 뒤에 있어서 앞선 것이 이긴다.
// 가로채이면 「저장했습니다」 안내와 그림 확대가 조용히 죽는다.
const CLOBBER = [
  ['id 가로채기', '<div id="saved">x</div><div id="lightbox">y</div>', /\sid=/i],
  ['name 가로채기', '<div name="body">x</div>', /\sname=/i],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 700, height: 500,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'mailview.html'));
  const wc = win.webContents;
  await new Promise((r) => setTimeout(r, 800));

  // 시험용 무대를 만든다. 진짜 mailview 의 세정기를 그대로 쓴다.
  const ready = await wc.executeJavaScript('typeof window.nunsSafeHtml');
  ok(ready === 'function', 'mailview 가 safehtml.js 를 싣고 있다', ready);
  if (ready !== 'function') { console.log('\n실을 수 없으니 더 못 잰다'); app.exit(1); return; }

  /** 본문을 넣고, 뭐가 «불렸는지» 세어 돌려준다 */
  async function tryIt(html) {
    return wc.executeJavaScript(`(async () => {
      window.PWNED = 0;
      const host = document.getElementById('body');
      host.replaceChildren(window.nunsSafeHtml(${JSON.stringify(html)}));
      // onerror·onload·ontoggle 은 다음 차례에 돈다. 두 프레임 기다렸다 센다.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 120));
      const out = { pwned: window.PWNED, html: host.innerHTML };
      host.replaceChildren();
      return out;
    })()`);
  }

  console.log('\n[1] 정규식 세정만 — mail.js buildViewHtml (첫 관문)');
  let regexHoles = 0;
  for (const [name, src] of ATTACKS.concat(LINKS)) {
    const out = gate(src);
    const leak = /\bon[a-z]+\s*=/i.test(out) || /<script/i.test(out) || /javascript:/i.test(out);
    if (leak) { regexHoles++; console.log(`   샘  ${name}  → ${JSON.stringify(out.slice(0, 70))}`); }
  }
  console.log(`   ${ATTACKS.length + LINKS.length}개 중 ${regexHoles}개가 정규식을 지나갔다`
    + ' (지나가도 된다 — 뒤에 DOM 세정이 있다)');

  console.log('\n[2] DOM 세정 — 진짜 창에서 «불렸는지»를 센다');
  for (const [name, src] of ATTACKS) {
    const r = await tryIt(src);
    ok(r.pwned === 0, name, r.pwned ? { 불림: r.pwned, 남은것: r.html.slice(0, 80) } : undefined);
  }

  console.log('\n[3] 두 겹 겹쳐서 — 진짜 길과 같은 순서 (메인 → 창)');
  for (const [name, src] of ATTACKS) {
    const r = await tryIt(gate(src));
    ok(r.pwned === 0, `겹침: ${name}`, r.pwned ? { 불림: r.pwned } : undefined);
  }

  console.log('\n[4] 밖으로 나가는 링크 — 위험한 스킴이 남았나');
  for (const [name, src] of LINKS) {
    const r = await tryIt(src);
    const left = /javascript:|vbscript:|data:text\/html|file:/i.test(r.html);
    ok(!left, name, left ? { 남은것: r.html.slice(0, 90) } : undefined);
  }

  console.log('\n[4-2] <style> 안의 위험한 규칙은 남지 않나');
  for (const [name, src, re] of CSS_KILL) {
    const r = await tryIt(gate(src));
    ok(!re.test(r.html), name, re.test(r.html) ? { 남은것: r.html.slice(0, 90) } : undefined);
  }

  console.log('\n[4-3] 메일이 창의 요소 이름을 가로채지 못하나');
  for (const [name, src, re] of CLOBBER) {
    const r = await tryIt(gate(src));
    ok(!re.test(r.html), name, re.test(r.html) ? { 남은것: r.html.slice(0, 90) } : undefined);
  }

  console.log('\n[5] 정상 메일은 그대로 읽히나 (다 막고 안 읽히면 소용없다)');
  for (const [name, src, must] of KEEP) {
    const r = await tryIt(gate(src));
    const missing = must.filter((m) => !r.html.includes(m));
    ok(!missing.length, name, missing.length ? { 사라짐: missing, 남은것: r.html.slice(0, 90) } : undefined);
  }

  console.log('\n[6] 링크는 rel 이 붙나 (새 창이 이 창의 다리를 쥐면 안 된다)');
  const r6 = await tryIt('<a href="https://a.com" target="_blank">x</a>');
  ok(/rel="noopener noreferrer"/.test(r6.html), 'rel="noopener noreferrer" 가 붙는다', r6.html);

  console.log('\n[7] 아주 큰 본문에서도 안 죽나');
  const big = '<p>가</p>'.repeat(4000) + '<img src="x"onerror="window.PWNED++">';
  const t0 = Date.now();
  const r7 = await tryIt(big);
  const ms = Date.now() - t0;
  ok(r7.pwned === 0, `4천 줄짜리에서도 막힌다 (${ms}ms)`, r7.pwned || undefined);
  ok(ms < 4000, '4초 안에 끝난다', ms);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

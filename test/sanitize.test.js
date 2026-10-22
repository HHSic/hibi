const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 남이 보낸 메일 HTML이 실제로 «실행되지 않는지» 본다.
//
// 두 겹을 따로, 그리고 겹쳐서 잰다:
//   1. src/mail.js buildViewHtml — 메인의 정규식 세정 (첫 관문)
//   2. renderer/safehtml.js — 진짜 DOM 에서 훑는 세정 (주 방어)
// (src/htmlclean.js 는 이 길에 없다 — 그건 «내가 쓴 서명·보내는 메일»용이다.)
// 그냥 문자열 비교로 끝내지 않는다. 진짜 창을 띄워 본문을 넣고,
// 핸들러가 실제로 «불렸는지»를 창 안에서 세어 본다 — 그게 뚫렸다는 유일한 증거다.
// [8] 은 «실행»이 아니라 «자리»를 잰다 — 메일이 띄운 것(position)이 본문 상자를 벗어나 창을 덮지 않는가
// (이스케이프·주석으로 감춘 position 포함). [8-2] 메일 <style> 이 창(본문 상자의 경계·첨부 칸·그림 크게 보기·글꼴)을
// 고르지 못하는가 — 메일은 본문 상자 안 그림자 뿌리에 들어간다. [8-3] 띄우던 그림의 음수 여백이 그림을 옆 칸으로 밀지 않는가.
// 창은 show:false 로만 띄운다 (사용자 모니터에는 아무것도 안 뜬다). 앱(main.js)은 안 싣는다.
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
  // 이스케이프한 @import — 정규식(/@import/)은 지나가는데 브라우저는 @import 로 읽는다 (아래 [4-2] 에서 그것도 잰다).
  // 주소는 없는 로컬 파일이다 — 새더라도 바깥(남의 서버)으로는 안 나간다
  ['이스케이프한 @import', '<style>@\\69mport "nope-sanlab.css";p{color:red}</style>', /@import|nope-sanlab/i],
  // 창 전체에 걸리는 «등록» — 문서에 들어가면 창의 색 이름(--scrim)을 다시 정의한다
  ['@property', '<style>@property --scrim{syntax:"<color>";inherits:false;initial-value:#f0f}p{color:red}</style>', /@property/i],
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
  // (<style> 은 브라우저가 읽은 것을 다시 적은 글로 남는다 — #f00 은 rgb(255, 0, 0) 으로 적힌다)
  ['style 태그', '<style>.a{color:#f00}</style><p class="a">빨강</p>', ['.a { color: rgb(255, 0, 0); }', '빨강']],
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

  /** 본문을 창과 같은 길(씻기 → 본문 상자 안 그림자 뿌리)로 넣고, 뭐가 «불렸는지» 세어 돌려준다 */
  async function tryIt(html) {
    return wc.executeJavaScript(`(async () => {
      window.PWNED = 0;
      const host = document.getElementById('body');
      const root = window.nunsMountMail(host, window.nunsSafeHtml(${JSON.stringify(html)}));
      // onerror·onload·ontoggle 은 다음 차례에 돈다. 두 프레임 기다렸다 센다.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 120));
      const out = { pwned: window.PWNED, html: root.innerHTML };
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
  // 위의 이스케이프한 @import 가 지어낸 걱정이 아님을 — 씻지 않은 채 넣으면 브라우저는 진짜 @import 로 읽는다
  const rawImport = await wc.executeJavaScript(`(() => {
    const box = document.createElement('div');
    document.body.append(box);
    const root = box.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = '@\\\\69mport "nope-sanlab.css";';
    root.append(st);
    const r = st.sheet && st.sheet.cssRules[0];
    const name = r ? r.constructor.name : null;
    box.remove();
    return name;
  })()`);
  ok(rawImport === 'CSSImportRule', '  (대조) 씻지 않으면 @\\69mport 는 브라우저에게 CSSImportRule 이다', rawImport);

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

  // ── 띄워 놓은 것 ─────────────────────────────────
  // Outlook(Word)은 «글 앞에 놓은» 그림을 position:absolute 인 span 으로 싣는다 (실측 — 표 칸마다 한 장).
  // 그대로 두면 그림이 제 칸에 자리를 안 차지하고, 본문 스크롤을 안 따라오고, 창 아래 첨부 칸 위에 그려졌다.
  // 아래는 그 꼴을 흉내 낸 «지어낸» 메일이다 — 진짜 메일 글은 한 줄도 없다.
  console.log('\n[8] 띄워 놓은 것은 본문 자리에 붙는가 (Outlook 표 속 그림)');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const WORD_FLOAT = '<table border=1 cellspacing=0 cellpadding=0 style="width:480px">'
    + '<tr><td style="width:470px;padding:0 5px"><p class=MsoNormal>'
    + '<!--[if gte vml 1]><v:shape style="position:absolute;width:300pt;height:200pt">'
    + '<v:imagedata src="cid:image001.png@01DB0000.00000000" o:title=""/></v:shape><![endif]-->'
    + '<![if !vml]><span style=\'mso-ignore:vglayout;position:absolute;z-index:251636736;'
    + 'margin-left:5px;margin-top:6px;width:400px;height:266px\'>'
    + `<img width=400 height=266 src="${PNG}" alt="떠 있던 그림" v:shapes="그림_x0020_1"></span><![endif]>`
    + '그림 설명 글</p></td></tr>'
    + '<tr><td><p class=MsoNormal>다음 칸</p></td></tr></table>'
    + '<p>뒤 글</p>'.repeat(80);

  /**
   * 본문을 진짜 길(메인 정규식 → 창 세정기 → 본문 상자 안 그림자 뿌리)로 넣고 자리를 잰다. 첨부 칸은 칩 하나로 띄워 둔다.
   * raw 면 세정기만 건너뛴다 — 그림자 뿌리와 본문 상자의 CSS(마지막 방어선)만 잰다.
   */
  async function layoutOf(html, { raw = false } = {}) {
    return wc.executeJavaScript(`(() => {
      const host = document.getElementById('body');
      host.classList.add('rich');
      host.scrollTop = 0;
      let frag;
      if (${raw}) {
        const d = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
        frag = document.createDocumentFragment();
        frag.append(...d.head.childNodes, ...d.body.childNodes);
      } else frag = window.nunsSafeHtml(${JSON.stringify(html)});
      const root = window.nunsMountMail(host, frag);
      const atts = document.getElementById('atts');
      atts.style.display = 'block';
      const chip = document.createElement('button');
      chip.className = 'file';
      chip.textContent = '보고서.pdf';
      document.getElementById('files').replaceChildren(chip);
      const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
      const mid = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
      // 창의 머리글·첨부 칸·위아래 가장자리 — 거기서 손에 잡히는 것이 메일이면 안 된다
      const spots = {
        머리글: mid(document.querySelector('.head')),
        첨부칸: mid(atts),
        첨부칩: mid(chip),
        닫기: mid(document.getElementById('close')),
        왼쪽위: [4, 4],
        아래끝: [innerWidth / 2, innerHeight - 3]
      };
      const leak = Object.entries(spots).filter(([, [x, y]]) => {
        const hit = document.elementFromPoint(x, y);
        return hit && host.contains(hit);
      }).map(([k]) => k);
      const img = root.querySelector('img[alt="떠 있던 그림"]');
      // 창의 것이 메일 CSS 에 흔들리지 않았나 — 본문 상자의 경계, 첨부 칸, 그림 크게 보기, 머리글 글꼴, 카드 바탕
      const bs = getComputedStyle(host);
      const out = {
        body: R(host), leak,
        box: { contain: bs.contain, position: bs.position, display: bs.display, transform: bs.transform },
        atts: getComputedStyle(atts).display, attsH: Math.round(atts.getBoundingClientRect().height),
        lightbox: getComputedStyle(document.getElementById('lightbox')).display,
        headFont: getComputedStyle(document.querySelector('.subject')).fontFamily,
        card: getComputedStyle(document.querySelector('.card')).backgroundColor
      };
      if (img) {
        const td = img.closest('td');
        out.img = R(img);
        out.td = R(td);
        out.spanPos = getComputedStyle(img.parentElement).position;
        out.spanStyle = img.parentElement.getAttribute('style');
        host.scrollTop = 120;
        out.scrolled = host.scrollTop;
        out.img2 = R(img);
      }
      const ov = root.querySelector('.ov') || root.querySelector('div');
      if (ov) out.ovPos = getComputedStyle(ov).position;
      host.scrollTop = 0;
      atts.style.display = 'none';
      document.getElementById('files').replaceChildren();
      host.replaceChildren();
      host.classList.remove('rich');
      return out;
    })()`);
  }
  const inside = (a, b, tol = 1) => a && b && a.l >= b.l - tol && a.t >= b.t - tol && a.r <= b.r + tol && a.b <= b.b + tol;

  const calm = await layoutOf('<p>보통 글</p>');   // 메일 CSS 가 없을 때의 창 — 아래에서 «안 흔들렸나»의 기준
  ok(calm.box.contain === 'paint' && calm.box.position === 'relative', '(기준) 본문 상자는 relative · contain:paint', calm.box);

  const f = await layoutOf(gate(WORD_FLOAT));
  ok(f.img && f.spanPos === 'static', '띄우던 span 이 흐름 안(static)으로 돌아온다', f.spanPos);
  ok(f.spanStyle && /width: 400px/.test(f.spanStyle) && /margin-left: 5px/.test(f.spanStyle)
    && !/position|z-index/i.test(f.spanStyle), '  position·z-index 만 떼고 너비·여백은 둔다', f.spanStyle);
  ok(inside(f.img, f.td), '그림이 제 표 칸(<td>) 안에 있다', { img: f.img, td: f.td });
  ok(f.td && f.td.h >= 266, '  표 줄이 그림 높이만큼 자란다 (자리를 차지한다)', f.td && f.td.h);
  ok(inside(f.img, f.body), '그림이 본문 상자 안에 있다', { img: f.img, body: f.body });
  ok(f.scrolled > 0 && Math.abs((f.img.t - f.img2.t) - f.scrolled) <= 1,
    '본문을 스크롤하면 그림도 같이 움직인다', { scrolled: f.scrolled, before: f.img && f.img.t, after: f.img2 && f.img2.t });
  ok(!f.leak.length, '창 머리글·첨부 칸·가장자리를 누르면 메일이 아니라 창이 잡힌다', f.leak);

  const COVERS = [
    ['style 속성 position:fixed + top/left', '<div style="position:fixed;top:0;left:0;right:0;bottom:0;'
      + 'width:100%;height:100%;z-index:2147483647;background:#f00">덮개</div>'],
    ['style 속성 position:absolute + 음수 top', '<div style="position:absolute;top:-400px;left:-50px;'
      + 'width:3000px;height:3000px;z-index:99999;background:#f00">덮개</div>'],
    ['<style> 의 position:fixed !important',
      '<style>.ov{ position : fixed !important; inset:0; z-index:2147483647; background:#f00 }</style>'
      + '<div class="ov">덮개</div>'],
    ['<style> 의 position:absolute', '<style>div.ov{position:absolute;top:0;left:0;width:3000px;height:3000px}</style>'
      + '<div class="ov">덮개</div>'],
    ['<style> 의 position:sticky', '<style>.ov{position:sticky;top:0;height:3000px}</style><div class="ov">덮개</div>'],
  ];
  // 브라우저는 이름 속 이스케이프를 풀고 주석을 건너뛴다 — 글자로 «position:» 을 찾는 판은 이것들을 놓쳤다
  const BOX = 'top:0;left:0;width:3000px;height:3000px;z-index:2147483647;background:#f00';
  const ESCAPES = [
    ['style 속성 posi\\tion:fixed', `<div class="ov" style="posi\\tion:fixed;${BOX}">덮개</div>`],
    ['style 속성 \\70 osition:fixed', `<div class="ov" style="\\70 osition:fixed;${BOX}">덮개</div>`],
    ['style 속성 p\\osition:fixed', `<div class="ov" style="p\\osition:fixed;${BOX}">덮개</div>`],
    ['style 속성 /*:*/position:absolute', `<div class="ov" style="/*:*/position:absolute;${BOX}">덮개</div>`],
    ['<style> posi\\tion:fixed', `<style>.ov{posi\\tion:fixed;${BOX}}</style><div class="ov">덮개</div>`],
    ['<style> \\70 osition:fixed', `<style>.ov{\\70 osition:fixed;${BOX}}</style><div class="ov">덮개</div>`],
    ['<style> p\\osition:fixed', `<style>.ov{p\\osition:fixed;${BOX}}</style><div class="ov">덮개</div>`],
    ['<style> position/**/:fixed', `<style>.ov{position/**/:fixed;${BOX}}</style><div class="ov">덮개</div>`],
    ['<style> @media 안의 fixed', `<style>@media all{.ov{position:fixed;${BOX}}}</style><div class="ov">덮개</div>`],
    ['<style> 중첩 규칙 안의 fixed', `<style>.w{& .ov{position:fixed;${BOX}}}</style><div class="w"><div class="ov">덮개</div></div>`],
    ['<style> var() 로 감춘 fixed', `<style>.ov{--p:fixed;position:var(--p);${BOX}}</style><div class="ov">덮개</div>`],
  ];
  for (const [name, src] of COVERS.concat(ESCAPES)) {
    const r = await layoutOf(gate(src));
    ok(r.ovPos === 'static' && !r.leak.length, `${name} → static, 창을 못 덮는다`,
      r.ovPos === 'static' && !r.leak.length ? undefined : { pos: r.ovPos, leak: r.leak });
  }
  // 세정기에서 하나라도 새면 — 본문 상자(position:relative + contain:paint)가 마지막 방어선이다
  for (const [name, src] of COVERS.slice(0, 3).concat(ESCAPES.slice(0, 1), ESCAPES.slice(7, 8))) {
    const r = await layoutOf(src, { raw: true });
    ok(r.ovPos !== 'static' && !r.leak.length, `세정기를 건너뛰어도: ${name} 은 본문 상자 밖에 안 그려진다`,
      r.ovPos !== 'static' && !r.leak.length ? undefined : { pos: r.ovPos, leak: r.leak });
  }

  // ── 메일 CSS 가 창을 고르기 ─────────────────────────
  // 메일의 <style> 은 범위가 없다. 창의 문서에 바로 넣던 때는 이 한 줄들로 본문 상자의 경계가 꺼지고(덮개가 머리글·닫기·첨부 칸을 덮었다),
  // 진짜 첨부 칸이 숨고, 창 전체가 메일의 덮개로 덮였다 (실측 — 지어낸 메일). 이제 메일은 그림자 뿌리 안이라 창을 못 고른다.
  console.log('\n[8-2] 메일 CSS 가 창(본문 상자·첨부 칸·그림 크게 보기·머리글)을 못 건드리나');
  const RED_FIXED = `<div class="ov" style="position:fixed;inset:0;${BOX}">덮개</div>`;
  const RED_MARGIN = '<div style="margin-top:-2000px;height:3000px;background:#f00">덮개</div>';
  const APP_CSS = [
    ['.body 의 경계 끄기 + fixed 덮개', '<style>.body{contain:none!important;position:static!important;overflow:visible!important}'
      + `.ov{position:fixed;${BOX}}</style>${RED_FIXED}`, (r) => r.box.contain === 'paint' && r.box.position === 'relative'],
    ['#body 의 경계 끄기 + 음수 margin 덮개', '<style>#body{contain:none!important;overflow:visible!important}</style>' + RED_MARGIN,
      (r) => r.box.contain === 'paint'],
    ['#body{display:contents} + 음수 margin 덮개', '<style>#body{display:contents!important}</style>' + RED_MARGIN,
      (r) => r.box.display === 'block'],
    ['.body{transform:translateY(160px)}', `<style>.body{transform:translateY(160px)}</style>${'<p>글</p>'.repeat(40)}`,
      (r) => r.box.transform === 'none'],
    [':host 를 fixed 로 띄우기', `<style>:host{position:fixed!important;${BOX}}</style><p>글</p>`, () => true],
    [':host 를 아래로 밀기', `<style>:host{transform:translateY(400px)!important;background:#f00}</style>${'<p>글</p>'.repeat(40)}`, () => true],
    ['.atts{display:none}', '<style>.atts{display:none!important}</style><p>글</p>', (r) => r.atts === 'block' && r.attsH > 0],
    ['.lightbox{display:grid}', '<style>.lightbox{display:grid!important;background:#f0f}</style><p>글</p>', (r) => r.lightbox === 'none'],
    ['* · body 로 창 글꼴 바꾸기', '<style>*{font-family:serif!important}body{font-family:monospace!important}</style><p>글</p>',
      (r) => r.headFont === calm.headFont],
    ['@property 로 창 색 이름 바꾸기', '<style>@property --scrim{syntax:"<color>";inherits:false;initial-value:#f0f}</style><p>글</p>',
      (r) => r.card === calm.card],
  ];
  for (const [name, src, fine] of APP_CSS) {
    for (const raw of [false, true]) {
      const r = await layoutOf(raw ? src : gate(src), { raw });
      const good = !r.leak.length && fine(r) && r.atts === 'block' && r.lightbox === 'none' && r.headFont === calm.headFont;
      ok(good, `${raw ? '세정기를 건너뛰어도: ' : ''}${name} → 창은 그대로, 덮개는 본문 상자 안`,
        good ? undefined : { leak: r.leak, box: r.box, atts: r.atts, lightbox: r.lightbox, font: r.headFont, card: r.card });
    }
  }

  // ── 흐름으로 되돌린 것의 음수 여백 ─────────────────
  // Word 는 기준점보다 왼쪽에 놓은 그림을 음수 margin-left 로 적는다. 흐름으로 되돌린 인라인 span 에 그대로 두면
  // 그림이 제 칸 밖 왼쪽 칸에 그려졌다 (실측 — 지어낸 2칸 표). 띄우던 것의 음수 여백만 0 으로, 양수는 그대로.
  console.log('\n[8-3] 띄우던 그림의 음수 여백 — 그림이 제 칸 밖으로 밀려나지 않나');
  const twoCells = (span, css = '') => `${css}<table style="width:500px"><tr><td style="width:240px">왼쪽 칸 글</td>`
    + `<td style="width:240px">${span}<img alt="떠 있던 그림" width=100 height=60 src="${PNG}"></span>오른쪽 글</td></tr></table>`;
  const NEG = [
    ['margin-left:-180px', twoCells('<span style="position:absolute;margin-left:-180px">')],
    ['margin:-6px 0 0 -180px (단축형)', twoCells('<span style="position:absolute;margin:-6px 0 0 -180px">')],
    ['margin-left:-20pt', twoCells('<span style="position:absolute;margin-left:-20pt;margin-top:-4.5pt">')],
    ['<style> 의 absolute + 음수 margin', twoCells('<span class="fl">', '<style>.fl{position:absolute;margin-left:-180px}</style>')],
  ];
  for (const [name, src] of NEG) {
    const r = await layoutOf(gate(src));
    ok(r.img && inside(r.img, r.td), `${name} → 그림이 제 칸(<td>) 안에 있다`, { img: r.img, td: r.td });
  }

  console.log('\n[8-4] Word 가 그림 자리를 비워 둔 칸 — Outlook 처럼 겹쳐 둔다');
  // 진짜 Outlook 메일의 꼴(실측): 바깥 칸 안에 «글 앞» 그림 span 이 있고, 바로 뒤에 같은 크기의 빈 안쪽 표
  // (높이 222pt, 맨 아래에 점수 글)가 온다. Word 는 그림을 그 표 위에 겹친다. 흐름으로 내리면 그림 밑에
  // 빈 표가 따로 남아 점수 글이 그림에서 270px 떨어졌다 — 칸에 들어맞으면 띄운 채 둔다.
  const RESERVED = (css = '') => `${css}<table border=1 cellspacing=0 cellpadding=0 style="width:480px">`
    + '<tr><td style="width:470px;padding:0 5px"><p class=MsoNormal>'
    + '<![if !vml]><span style=\'mso-ignore:vglayout;position:absolute;z-index:251636736;'
    + 'margin-left:5px;margin-top:6px;width:400px;height:266px\'>'
    // Word 는 그림 크기를 style 로도 적는다 (width:4.1666in 꼴) — 여기선 px 로. 시험 그림(PNG)은 정사각이라 비율을 박아 둔다
    + `<img width=400 height=266 style="width:400px;height:266px" src="${PNG}" alt="떠 있던 그림"></span><![endif]></p>`
    + '<table class=MsoNormalTable border=0 cellspacing=0 cellpadding=0><tr style="height:222pt">'
    + '<td width=420 valign=bottom style="width:315pt;border:solid windowtext 1pt;height:222pt">'
    + '<p class=MsoNormal><span class="score">점수 글</span></p></td></tr></table>'
    + '</td></tr><tr><td><p class=MsoNormal>다음 칸</p></td></tr></table>'
    + '<p>뒤 글</p>'.repeat(60);
  const reservedOf = async (html) => wc.executeJavaScript(`(() => {
    const host = document.getElementById('body');
    host.classList.add('rich');
    host.scrollTop = 0;
    const root = window.nunsMountMail(host, window.nunsSafeHtml(${JSON.stringify(html)}));
    const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const img = root.querySelector('img[alt="떠 있던 그림"]');
    const out = {
      pos: getComputedStyle(img.parentElement).position,
      img: R(img), outer: R(img.closest('td')), inner: R(root.querySelector('.MsoNormalTable td')),
      score: R(root.querySelector('.score')), body: R(host)
    };
    host.scrollTop = 150;
    out.scrolled = host.scrollTop;
    out.img2 = R(img);
    host.scrollTop = 0;
    host.replaceChildren();
    host.classList.remove('rich');
    return out;
  })()`);
  const rv = await reservedOf(gate(RESERVED()));
  ok(rv.pos === 'absolute', '자리가 비워진 칸에서는 띄운 채 둔다 (Outlook 과 같은 모습)', rv.pos);
  ok(inside(rv.img, rv.outer), '…그림은 제 바깥 칸 안에 있다', { img: rv.img, outer: rv.outer });
  ok(rv.img.t >= rv.inner.t - 1 && rv.img.t < rv.inner.t + 40 && rv.img.l >= rv.inner.l - 1,
    '…그림이 비워 둔 안쪽 표 위에 겹친다', { img: rv.img, inner: rv.inner });
  ok(rv.score.t - rv.img.b < 60 && rv.score.t > rv.img.t, '…점수 글이 제 그림 바로 밑에 붙어 있다', { img: rv.img, score: rv.score });
  ok(rv.outer.h < 400, '…표 줄이 그림 + 빈 표 두 겹으로 자라지 않는다', rv.outer.h);
  ok(inside(rv.img, rv.body), '…본문 상자 안에 있다', { img: rv.img, body: rv.body });
  ok(rv.scrolled > 0 && Math.abs((rv.img.t - rv.img2.t) - rv.scrolled) <= 1, '…본문을 스크롤하면 같이 움직인다',
    { scrolled: rv.scrolled, before: rv.img.t, after: rv.img2.t });
  const rvCss = await reservedOf(gate(RESERVED('<style>span{top:-600px !important;left:-600px !important}</style>')));
  ok(rvCss.pos === 'absolute' && inside(rvCss.img, rvCss.outer), '메일 CSS 가 top·left 를 걸어도 띄운 그림을 못 옮긴다',
    { img: rvCss.img, outer: rvCss.outer });
  // 그림이 자리보다 크면(비율이 달라 다 읽은 뒤 더 높아지는 경우 포함) 흐름으로 내린다
  const tall = await reservedOf(gate(RESERVED().replace('style="width:400px;height:266px"', 'style="width:400px;height:330px"')));
  ok(tall.pos === 'static' && inside(tall.img, tall.outer), '그림이 비워 둔 자리보다 크면 흐름으로 내려 칸 안에 둔다', { pos: tall.pos, img: tall.img, outer: tall.outer });
  // 자리가 없는 칸(위 [8] 의 WORD_FLOAT)은 흐름으로 내린다 — 겹쳐 두면 아래 줄을 덮는다
  ok(f.spanPos === 'static' && f.td.h >= 266, '(대조) 자리가 없는 칸에서는 흐름으로 내려 칸이 그림만큼 자란다', { pos: f.spanPos, td: f.td.h });

  console.log('\n[8-5] 못 불러온 그림은 깨진 상자 대신 감춘다');
  // id 는 세정기가 뗀다 — class 로 찾는다. 못 푸는 data: 그림으로 «불러오기 실패»를 만든다 (바깥 주소는 시험에서 부르지 않는다)
  const BAD = 'data:image/png;base64,AAAAAAAA';
  const broken = await wc.executeJavaScript(`(async () => {
    const host = document.getElementById('body');
    host.classList.add('rich');
    const root = window.nunsMountMail(host, window.nunsSafeHtml(${JSON.stringify(
    `<p>앞 글</p><img class="t-small" src="${BAD}" width=1 height=0><table><tr><td><img class="t-big" src="${BAD}" width=200 height=100></td></tr></table>`
      + `<img class="t-good" src="${PNG}" width=10 height=10><img class="t-nosrc" alt="빈 그림">`)}));
    await new Promise((r) => setTimeout(r, 400));
    const cs = (id) => { const el = root.querySelector('.t-' + id); const s = getComputedStyle(el); return { d: s.display, v: s.visibility, h: Math.round(el.getBoundingClientRect().height) }; };
    const out = { small: cs('small'), big: cs('big'), good: cs('good'), nosrc: cs('nosrc') };
    host.replaceChildren();
    host.classList.remove('rich');
    return out;
  })()`);
  ok(broken.small.d === 'none', '크기 없는(1×0) 못 불러온 그림은 자리째 감춘다 — 깨진 상자가 안 남는다', broken.small);
  ok(broken.big.v === 'hidden' && broken.big.d !== 'none' && broken.big.h >= 90, '크기를 정한 못 불러온 그림은 자리는 두고 감춘다 (표가 안 무너진다)', broken.big);
  ok(broken.good.d !== 'none' && broken.good.v === 'visible', '(대조) 제대로 불러온 그림은 그대로 보인다', broken.good);
  ok(broken.nosrc.d === 'none', '주소가 없는 그림도 감춘다', broken.nosrc);

  // 띄운 것과 상관없는 꾸밈은 글자 하나 안 바뀐다
  const styleOf = async (html, sel) => wc.executeJavaScript(`(() => {
    const box = document.createElement('div');
    box.append(window.nunsSafeHtml(${JSON.stringify(html)}));
    const el = box.querySelector(${JSON.stringify(sel)});
    // 브라우저가 읽은 선언 — 글 꼴(공백·따옴표)이 아니라 뜻으로 본다
    const decl = el && el.getAttribute('style') !== null
      ? Object.fromEntries([...el.style].map((p) => [p, el.style.getPropertyValue(p) + (el.style.getPropertyPriority(p) ? ' !' : '')])) : null;
    const css = [...box.querySelectorAll('style')].map((s) => s.textContent).join('\\n');
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const rules = {};
    const walk = (list) => { for (const r of list) { if (r.selectorText) rules[r.selectorText] = r.style.cssText; if (r.cssRules) walk(r.cssRules); } };
    walk(sheet.cssRules);
    return { style: el ? el.getAttribute('style') : null, decl, css, rules, html: box.innerHTML };
  })()`);
  const plain = 'color:#f00;mso-level-number-position:left;background:url(data:image/png;base64,iVBORw0KGgo=);font-size:14px';
  const s1 = await styleOf(`<p style="${plain}">x</p>`, 'p');
  ok(s1.style === plain, '띄우지 않은 style 은 그대로 (mso-level-number-position·url(data:…;base64) 포함)', s1.style);
  const s2 = await styleOf('<span style="POSITION : Absolute !important; TOP:10px; Left : 5px; z-index:9;'
    + ' inset-inline-start:3px; width:400px;height:266px;margin-left:5px;color:blue;'
    + 'background:url(data:image/png;base64,iVBORw0KGgo=)">x</span>', 'span');
  const d2 = s2.decl || {};
  ok(!['position', 'top', 'left', 'z-index', 'inset-inline-start'].some((p) => p in d2)
    && d2.width === '400px' && d2.height === '266px' && d2['margin-left'] === '5px' && d2.color === 'blue'
    && /url\("data:image\/png;base64,iVBORw0KGgo="\)/.test(d2['background-image'] || ''),
  '대소문자·공백·!important 를 섞어도 띄우기만 뗀다 (url 안의 ; 는 안 자른다)', d2);
  const s3 = await styleOf('<span style="position:relative;top:2px;color:#333">x</span>', 'span');
  ok(s3.style === 'position:relative;top:2px;color:#333', 'position:relative 는 그대로 둔다 (흐름 안이다)', s3.style);
  const s4 = await styleOf('<span style="position:sticky;top:0;font-weight:bold">x</span>', 'span');
  ok(s4.decl && !('position' in s4.decl) && !('top' in s4.decl) && s4.decl['font-weight'] === 'bold', 'position:sticky 도 뗀다', s4.decl);
  const s5 = await styleOf('<span style="position:fixed;top:0">x</span>', 'span');
  ok(s5.style === null, '띄우기만 있던 style 은 통째로 없어진다', s5.style);
  // 이스케이프·주석으로 감춘 position 도 브라우저가 읽은 이름으로 본다
  const s9 = await styleOf('<span style="posi\\tion:absolute;to\\70:3px;width:10px">x</span>', 'span');
  ok(s9.decl && !('position' in s9.decl) && !('top' in s9.decl) && s9.decl.width === '10px',
    'style 속성의 posi\\tion · to\\70 (이스케이프) 도 떼고 너비는 둔다', s9.decl);
  // 띄우던 것의 여백 — 음수는 0 으로, 양수는 그대로. 띄우지 않은 것의 음수 여백은 건드리지 않는다
  const sA = await styleOf('<span style="position:absolute;margin:-6px 0 0 -180px;width:10px">x</span>', 'span');
  ok(sA.decl && sA.decl['margin-left'] === '0px' && sA.decl['margin-top'] === '0px' && sA.decl.width === '10px',
    '띄우던 것의 음수 여백(단축형 성분 포함)은 0 으로', sA.decl);
  const sB = await styleOf('<span style="position:absolute;margin-left:5px;margin-top:4.5pt">x</span>', 'span');
  ok(sB.decl && sB.decl['margin-left'] === '5px' && sB.decl['margin-top'] === '4.5pt', '  양수 여백은 그대로 (Outlook 실측 5px·4.5pt)', sB.decl);
  const sC = await styleOf('<span style="margin-left:-20px;color:red">x</span>', 'span');
  ok(sC.style === 'margin-left:-20px;color:red', '  띄우지 않은 것의 음수 여백은 손대지 않는다', sC.style);

  const s6 = await styleOf('<style><!--\n li{mso-level-number-position:left}\n .a{position:relative;top:2px}\n'
    + ' .b{ position : fixed ; top:0 }\n .c{position:absolute!important;color:red}\n p{background-position:0 0}\n'
    + ' p.MsoNormal{margin:0cm;font-size:10.0pt}\n .d{position:absolute;margin-left:-30px}\n--></style><p class="a">x</p>', 'p');
  const R6 = s6.rules;
  ok(R6['.a'] === 'position: relative; top: 2px;' && /^position: static;/.test(R6['.b'] || '')
    && R6['.c'] === 'position: static !important; color: red;' && /background-position: 0px 0px/.test(R6.p || '')
    && /font-size: 10pt/.test(R6['p.MsoNormal'] || '') && /position: static; margin-left: 0px/.test(R6['.d'] || '')
    && !/fixed|absolute/.test(s6.css),
  '<style> 은 띄우는 규칙만 static 으로 (음수 여백은 0) — Word 의 <!-- --> 안 꾸밈은 그대로 읽힌다', R6);
  const sF = await styleOf('<style>@font-face{font-family:x;src:local(Arial)}p{color:red}</style><p>x</p>', 'p');
  ok(!/@font-face/.test(sF.css) && /color: red/.test(sF.css), '  @font-face 는 뺀다 — 나머지 꾸밈은 남는다', sF.css);

  // 원래 막던 것은 그대로 막는다
  const s7 = await styleOf('<span style="position:absolute;background:url(javascript:alert(1))" onclick="x()">x</span>', 'span');
  ok(!/javascript:|onclick/i.test(s7.html), '  띄운 것에 붙은 javascript: url()·on* 도 그대로 막힌다', s7.html);
  const s8 = await styleOf('<span style="position:absolute;behavior:url(x.htc)">x</span>', 'span');
  ok(s8.style === null, '  behavior: 가 섞이면 style 통째로 버린다 (전과 같다)', s8.style);
  const r8 = await tryIt(gate('<span style="position:absolute;z-index:9"><img src="x"onerror="window.PWNED++"></span>'));
  ok(r8.pwned === 0, '  띄운 span 안의 onerror 도 안 불린다', r8.pwned || undefined);
  // <style> 의 url() 은 다시 적은 뒤에도 씻긴다 — 이스케이프한 url( 로 감춘 바깥 주소
  const sU = await styleOf('<style>.u{background:\\75 rl(//evil.example/p.png)}</style><p class="u">x</p>', 'p');
  ok(!/evil\.example/.test(sU.css), '  <style> 의 \\75 rl(//…) (이스케이프한 url) 도 바깥 주소가 남지 않는다', sU.css);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

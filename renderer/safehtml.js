// 남이 보낸 HTML을 화면에 넣기 직전에 DOM으로 한 번 더 훑는다.
//
// src/htmlclean.js 가 첫 관문이지만 그건 정규식이라 원리적으로 완전할 수 없다.
// 실제로 <img src="x"onerror=…> 가 뚫렸었다 — 따옴표가 값을 끝내니 공백 없이도
// 새 속성이 된다. 다음 우회가 없다고 볼 근거가 없으니, 여기서는 «지우기»가 아니라
// «허락한 것만 남기기»로 뒤집는다.
//
// 이게 중요한 까닭: 메일 본문이 들어가는 창은 preload 다리(메일 보내기·파일 첨부)를
// 쥐고 있고, CSP 가 script-src 에 'unsafe-inline' 을 두고 있어 인라인 이벤트 핸들러를
// 막아주지 못한다. 즉 여기가 마지막 문이다.
//
// DOMParser 로 «따로 떼어낸 문서»에 파싱하므로, 훑는 동안에는 그림도 안 불러오고
// 스크립트도 안 돈다. 다 씻은 뒤에야 진짜 화면으로 옮긴다.

(() => {
  'use strict';

  // 메일에 쓰이는 것만 남긴다. 여기 없는 태그는 껍데기만 벗기고 안쪽 글은 살린다.
  const OK_TAG = new Set([
    'style',   // HTML 메일은 꾸밈을 <style> 로 싣는다 — 버리면 글이 무너진다. 안쪽은 씻는다.
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
    'dd', 'del', 'div', 'dl', 'dt', 'em', 'figure', 'figcaption', 'font', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's',
    'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'tr', 'u', 'ul', 'wbr'
  ]);
  // 통째로 버릴 것 — 안쪽 글까지 같이 버린다 (스크립트의 내용은 읽을 글이 아니다).
  //
  // input·button 따위를 버리는 까닭: 메일 안의 양식은 어차피 안 돈다.
  // 보내기를 누르면 창이 «옮겨가기»가 되는데, 그건 win.js 가 막고 기본 브라우저로
  // 넘긴다 — 즉 남이 만든 로그인 화면이 진짜 브라우저에서 열린다. 그 길을 끊는다.
  // form 은 껍데기만 벗긴다 (소식지 본문이 form 안에 들어 있는 일이 흔하다).
  const KILL = new Set(['script', 'iframe', 'object', 'embed', 'applet', 'link',
    'meta', 'base', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'template',
    // <title> 은 파서가 <head> 로 옮기는데, 우리는 머리도 가져오므로 제목 글자가
    // 본문 맨 위에 그대로 찍힌다. 메일 본문에서 제목 태그는 볼 일이 없다.
    //
    // noscript 는 여기 넣지 않는다. 스크립트를 아예 안 돌리는 화면이니, 소식지가
    // <script>로 그리던 그림의 «대신 보여줄 것»이 바로 그 안에 있다. 지우면 그림이
    // 통째로 사라진다. 모르는 태그와 같이 껍데기만 벗기고 안쪽 글은 살린다.
    'title']);

  // background 는 뺐다 — <td background="https://…"> 로 인터넷 그림을 부른다.
  // 메인의 「인터넷 그림 막기」는 태그 이름으로 거르기 때문에 이 속성을 못 본다.
  //
  // id 도 뺀다. 잠깐 넣었었다 — 메일의 <style> 이 id 로 거는 일이 있어서. 그런데
  // 메일 본문은 이 창의 #body «안»에 들어가고, 창이 쓰는 #saved·#blocked·#lightbox 는
  // 그 «뒤»에 있다. getElementById 는 앞에 있는 것을 주므로, 메일이 <div id="saved">
  // 하나만 품고 있어도 「저장했습니다」 안내와 그림 확대가 조용히 죽는다.
  // id 로 거는 꾸밈이 어긋나는 쪽이 낫다.
  const OK_ATTR = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign',
    'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'color', 'face', 'size',
    'bgcolor', 'dir', 'lang', 'style', 'class', 'target', 'rel']);

  /** 주소가 안전한가 — 엔티티·제어문자로 감춘 스킴을 펴서 본다 */
  function safeUrl(v) {
    const flat = String(v || '')
      .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_m, d) => String.fromCharCode(Number(d)))
      .replace(/[\s\u0000-\u0020]/g, '')
      .toLowerCase();
    if (!flat) return false;
    // «나쁜 것만 막기»로는 모자라다. 스킴이 아예 없는 주소가 더 위험하다:
    //   <a href="//남의서버/공유/x.html">
    // 이 창은 file:// 로 열려 있어서 브라우저가 이걸 file://남의서버/공유/x.html 로 푼다.
    // 그러면 이 창(메일 보내기·첨부를 쥔 창)이 남의 페이지가 되고, 윈도우 공유에 붙는
    // 순간 내 계정 해시까지 나간다 (win.js isOurPage 참고). 상대 경로도 우리 앱 폴더
    // 안을 가리키게 된다. 메일 본문에 쓸모 있는 상대 주소는 없으니 허락한 스킴만 통과.
    if (flat.startsWith('#')) return true;              // 본문 안 앵커
    if (/^https?:\/\/[^/]/.test(flat)) return true;     // 진짜 바깥 주소
    if (/^data:image\//.test(flat)) return true;        // 메일에 담겨 온 그림
    // 연락처 스킴은 눌러도 이 앱에서는 아무 일도 안 일어난다 (openWeb 이 http/https 만
    // 넘긴다). 그래도 남겨 둔다 — 회사 서명의 전화번호가 링크째 사라지면 글이 어색해진다.
    if (/^(mailto|tel|sms|callto):/.test(flat)) return true;
    return false;
  }

  /** style 속성에서 실행될 수 있는 것을 뺀다 */
  function safeStyle(v) {
    const s = String(v || '');
    if (/expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/i.test(s)) return '';
    // url(...) 안의 스킴도 본다
    return s.replace(/url\s*\(([^)]*)\)/gi, (whole, inner) => {
      const u = inner.trim().replace(/^["']|["']$/g, '');
      return safeUrl(u) ? whole : 'none';
    });
  }

  // ── 띄워 놓은 것 붙잡기 ─────────────────────────────
  // 메일이 position 으로 띄운 것은 본문 자리에 두지 않는다. Outlook(Word)은 «글 앞에 놓은»
  // 그림을 이렇게 싣는다 (실측 — 표 칸마다 그림 한 장, 42장):
  //   <span style="mso-ignore:vglayout;position:absolute;z-index:251636736;
  //                margin-left:5px;margin-top:6px;width:400px;height:266px"><img …></span>
  // 그대로 두면 그림이 제 칸에 자리를 차지하지 않고, 본문이 스크롤돼도 따라오지 않고,
  // 창 아래 첨부 칸 위에까지 겹쳐 그려졌다. 흐름 안(static)으로 되돌리면 제 칸에 붙는다.
  // fixed·sticky 도 같다 — 메일이 창의 어느 자리에 무엇을 붙일지 정하게 둘 까닭이 없다.
  //
  // 흐름 안에 머무는 값만 남긴다. 나머지(absolute·fixed·sticky·var(…) 처럼 미리 알 수 없는 것)는 뗀다.
  //
  // 글자로 따지지 않는다 — 브라우저가 읽은 선언(CSSStyleDeclaration)에 대고 본다.
  // 처음엔 정규식으로 «position:» 을 찾았는데, 브라우저는 이름 속 이스케이프를 풀고 주석을 건너뛴다:
  //   posi\tion:fixed   \70 osition:fixed   p\osition:fixed   /*:*/position:absolute   position/**/:fixed
  // 실측(지어낸 메일) — 다섯 꼴 모두 정규식 판을 지나 fixed·absolute 로 살아남았다. 브라우저가 읽은 것을 보면 끝이 없는 꼴 찾기가 없다.
  const FLOW_POS = /^(static|relative|initial|inherit|unset|revert|revert-layer)$/i;
  // 띄운 것에만 뜻이 있는 자리 잡기 — 흐름으로 되돌린 요소에서는 같이 뗀다 (브라우저가 푼 낱 이름으로 본다 — inset 은 top·right·bottom·left 로 풀린다).
  // 너비·높이·양수 여백은 둔다 (인라인 span 의 여백은 해가 없고, 없는 배치를 지어내지 않는다).
  const PIN_ONLY = /^(top|right|bottom|left|z-index|inset(-(block|inline)(-(start|end))?)?)$/;
  // 흐름으로 되돌린 것의 여백은 «0 이상»만 둔다. Word 는 기준점보다 왼쪽에 놓은 그림을 음수 margin-left 로 적는데,
  // 흐름 안의 인라인 span 에 그 값이 그대로 걸리면 그림이 제 칸 밖 옆 칸으로 밀려난다
  // (실측 — 지어낸 2칸 표, margin-left:-180px · margin:-6px 0 0 -180px 에서 그림이 왼쪽 칸에 그려졌다).
  // 음수·calc()·var() 처럼 0 이상인지 모르는 값은 0 으로 둔다.
  const OK_MARGIN = /^(auto|\+?(\d+\.?\d*|\.\d+)([a-z]+|%)?)$/i;

  // Word «글 앞» 그림 중 일단 띄운 채 둔 것 — 넣은 뒤 칸에 들어맞는지 재 본다 (settleFloats)
  const keptFloat = new WeakSet();

  const floats = (st) => {
    const v = st.getPropertyValue('position').trim();
    return !!v && !FLOW_POS.test(v);
  };
  /** 흐름으로 되돌린 선언 묶음에서 0 이상이 아닌 여백을 0 으로 */
  function noNegMargin(st) {
    for (const p of [...st]) {
      if (/^margin-/.test(p) && !OK_MARGIN.test(st.getPropertyValue(p).trim())) {
        st.setProperty(p, '0', st.getPropertyPriority(p));
      }
    }
  }

  /**
   * style 속성 — 띄워 놓았으면 position 과 자리 잡기를 떼어 흐름으로 되돌린다.
   * 띄우지 않은 style 은 손대지 않는다 (글자 하나 안 바뀐다). 고친 것은 브라우저가 다시 적은 글이 된다
   * (모르는 mso-* 선언은 그때 빠진다 — 브라우저가 어차피 안 쓰는 것이다).
   */
  function unpinStyle(el, raw) {
    const st = el.style;
    if (!floats(st)) return;
    // 예외 하나 — Word 의 «글 앞» 그림(mso-ignore:vglayout + absolute)은 띄운 채 둔다.
    // Word 는 그 그림 자리에 같은 크기의 빈 안쪽 표(높이 222pt, 맨 아래 점수 글)를 깔고 그림을 그 위에 겹친다.
    // 흐름으로 내리면 그림 밑에 그 빈 표가 따로 남아, 점수 글이 제 그림에서 270px 떨어져 다음 줄 설명처럼 보였다
    // (실측 — 진짜 메일, 표 한 줄 296px → 510px). 자리 잡기(top·left…)만 떼서 «제자리(정적 위치) + Word 의 여백»에
    // 놓으면 Outlook 과 같은 모습이 된다. 기준 상자는 창의 #body(position:relative · contain:paint)라
    // 본문과 같이 스크롤되고 본문 밖에는 그려지지 않는다. 메일 CSS 가 top 등을 걸어도 못 옮기게 auto 를 !important 로 박는다.
    // 다만 칸에 그림이 들어갈 자리가 없으면 겹쳐 둘 수 없다 — 그건 넣은 뒤에 재 보고 흐름으로 내린다 (nunsMountMail · settleFloats).
    if (/mso-ignore\s*:\s*vglayout/i.test(String(raw || '')) && st.getPropertyValue('position').trim().toLowerCase() === 'absolute') {
      for (const p of [...st]) if (PIN_ONLY.test(p)) st.removeProperty(p);
      for (const p of ['top', 'right', 'bottom', 'left']) st.setProperty(p, 'auto', 'important');
      st.setProperty('position', 'absolute', 'important');
      keptFloat.add(el);
      return;
    }
    toFlow(st);
  }

  /** 띄운 것을 흐름으로 — position 과 자리 잡기를 떼고, 0 이상이 아닌 여백은 0 으로 */
  function toFlow(st) {
    // position 이 여럿이어도 브라우저가 이긴 것 하나로 읽어 둔다 — 떼면 끝이다
    st.removeProperty('position');
    for (const p of [...st]) if (PIN_ONLY.test(p)) st.removeProperty(p);
    noNegMargin(st);
  }

  // 메일 CSS 에서 통째로 뺄 규칙 — 그 메일만이 아니라 창 전체에 걸리는 «등록»이다.
  // @property 는 문서에 넣으면 창의 색 이름(--scrim 등)을 다시 정의한다 (실측 — 카드 바탕이 메일이 정한 색이 됐다).
  // 지금은 그림자 뿌리(아래 nunsMountMail) 안이라 브라우저가 무시하지만, 넣는 자리가 바뀌어도 새지 않게 여기서 뺀다.
  // @font-face 도 같다 — 글꼴을 부르는 주소(file://남의서버/…)가 바깥으로 나가는 길이 될 수 있다 (font-src 가 file: 을 연다).
  const DROP_RULE = (r) => (typeof CSSPropertyRule !== 'undefined' && r instanceof CSSPropertyRule)
    || (typeof CSSFontFaceRule !== 'undefined' && r instanceof CSSFontFaceRule);

  /** 규칙 목록을 안쪽(@media·@supports·중첩 규칙)까지 훑어 띄우는 규칙을 static 으로 — 고친 것이 있으면 true */
  function unpinRules(list, owner) {
    let changed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (DROP_RULE(r)) { owner.deleteRule(i); changed = true; continue; }
      // 떼지 않고 static 으로 고쳐 쓴다 — 떼면 더 약한 규칙의 absolute 가 도로 이긴다
      if (r.style && floats(r.style)) {
        r.style.setProperty('position', 'static', r.style.getPropertyPriority('position'));
        noNegMargin(r.style);
        changed = true;
      }
      if (r.cssRules) changed = unpinRules(r.cssRules, r) || changed;
    }
    return changed;
  }

  /**
   * <style> 안 — 브라우저 파서(CSSStyleSheet)로 읽어 규칙마다 본다.
   * 돌려주는 글은 언제나 «브라우저가 읽은 것을 다시 적은 것»이다 (고친 것이 없어도).
   * 원문을 그대로 두면, 파서가 읽은 것과 정규식이 본 것이 어긋나는 틈이 남는다:
   *   @\69mport "…"  — 이스케이프한 @import 는 앞의 정규식(/@import/)을 지나는데 브라우저는 @import 로 읽는다.
   *   replaceSync 는 @import 를 버리므로, 다시 적은 글에는 처음부터 없다.
   * 다시 적은 글도 한 번 더 씻는다 — url(…) 이 «url("…")» 꼴로 펴져 있어 감춘 주소까지 보인다.
   * Word 가 CSS 를 싸는 <!-- --> 와 모르는 mso-* 선언은 이때 빠진다 (브라우저가 어차피 안 쓰는 것이다).
   * 못 읽으면 통째로 버린다.
   */
  function unpinCss(css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      unpinRules(sheet.cssRules, sheet);
      return safeStyle([...sheet.cssRules].map((r) => r.cssText).join('\n'));
    } catch {
      return '';
    }
  }

  function scrub(root) {
    // 뒤에서부터 훑는다 — 지우면서 앞으로 가면 건너뛰는 노드가 생긴다
    const all = [...root.querySelectorAll('*')].reverse();
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (KILL.has(tag)) { el.remove(); continue; }
      if (tag === 'style') {
        // 안쪽 규칙을 씻는다. CSS 로는 코드가 안 돌지만(expression() 은 옛 IE 것),
        // url() 로 바깥을 부르는 순간 «내가 이 메일을 열었다»가 보낸 사람에게 간다.
        //
        // 여기서 continue 로 빠져나가면 안 된다. 아래 속성 훑기가 on* 을 떼는 «유일한»
        // 자리라, 건너뛰면 <style> 만 속성 검사를 안 받는다. 실제로 이게 뚫렸다:
        //   <style a="b"onload="…">   앞 글자가 따옴표라 메인의 정규식도 못 잡는다
        // 그래서 안쪽만 씻고, 속성은 아래 공통 길로 내려보낸다.
        const css = safeStyle(el.textContent);
        // 띄우는 규칙(position:fixed 등)은 static 으로 — 나머지 꾸밈은 그대로 둔다
        const clean = css && unpinCss(css);
        if (!clean) { el.remove(); continue; }
        el.textContent = clean;
      } else if (!OK_TAG.has(tag)) {
        // 모르는 태그는 껍데기만 벗기고 안쪽 글은 남긴다 (표가 통째로 사라지면 안 읽힌다)
        el.replaceWith(...el.childNodes);
        continue;
      }
      for (const at of [...el.attributes]) {
        const name = at.name.toLowerCase();
        // on* 은 무조건. 허락 목록에 없는 것도 뺀다 — 여기가 «허락한 것만» 이다.
        if (name.startsWith('on') || !OK_ATTR.has(name)) { el.removeAttribute(at.name); continue; }
        if (name === 'style') {
          const v = safeStyle(at.value);
          if (!v.trim()) { el.removeAttribute('style'); continue; }
          el.setAttribute('style', v);
          // 띄워 놓은 것은 흐름으로 되돌린다 (Outlook 의 «글 앞» 그림이 표 칸 밖으로 새던 것).
          // 떼어낸 문서라도 브라우저가 style 을 읽어 둔다 — 이스케이프·주석을 푼 뒤의 이름으로 본다
          unpinStyle(el, v);
          if (!String(el.getAttribute('style') || '').trim()) el.removeAttribute('style');
        } else if (name === 'href' || name === 'src') {
          if (!safeUrl(at.value)) el.removeAttribute(at.name);
        }
      }
      // 바깥으로 나가는 링크는 새 창 취급 — 이 창이 남의 페이지로 바뀌면 다리를 쥐게 된다
      if (tag === 'a' && el.getAttribute('href')) {
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return root;
  }

  /**
   * 남이 준 HTML → 화면에 넣어도 되는 조각.
   * 넣는 쪽은 nunsMountMail(el, nunsSafeHtml(html)) 처럼 쓴다 — 창의 문서에 바로 넣지 않는다 (아래 참고).
   */
  window.nunsSafeHtml = (html) => {
    // 따로 떼어낸 문서에 파싱한다 — 훑는 동안 그림도 안 부르고 스크립트도 안 돈다
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    // 머리와 몸을 둘 다 훑는다. 파서는 맨 앞의 <style> 을 <head> 로 옮겨 놓는다 —
    // 몸만 가져가면 HTML 메일의 꾸밈이 통째로 사라진다 (실측).
    scrub(doc.head);
    scrub(doc.body);
    const frag = document.createDocumentFragment();
    // 머리에서 살아남는 것은 씻긴 <style> 뿐이다 (link·meta·base 는 위에서 지웠다)
    frag.append(...doc.head.childNodes);
    frag.append(...doc.body.childNodes);
    return frag;
  };

  // ── 메일 본문을 넣는 자리 ────────────────────────────
  // 메일의 <style> 은 범위가 없다. 창의 문서에 그대로 넣으면 그 규칙이 창 전체에 걸린다.
  // 실측(지어낸 메일, 세정기를 다 지난 것):
  //   .body{contain:none!important;position:static!important}  본문 상자의 경계(contain:paint)가 꺼져
  //                                       띄운 덮개가 머리글·닫기·첨부 칸을 덮었다 (#body{…} 도 같다)
  //   .body{transform:translateY(160px)}  본문이 첨부 칸 위로 내려와 그려졌다
  //   .atts{display:none!important}       진짜 첨부 칸이 사라졌다
  //   .lightbox{display:grid!important}   창 전체가 메일이 정한 덮개로 덮였다
  // 그래서 본문 상자 안에 감싸개를 하나 두고, 그 그림자 뿌리(shadow root) 안에 메일을 넣는다.
  // 그림자 안의 규칙은 그 안의 것만 고른다 — 창의 머리글·첨부 칸·#body 는 아예 못 고른다.
  // 메일이 :host 로 꾸밀 수 있는 것은 감싸개뿐이고, 감싸개는 #body 안에 있다. #body 의 contain:paint 는
  // 창의 규칙이라 메일이 못 끈다 — 감싸개를 fixed 로 띄워도 본문 상자 밖에는 못 그린다.
  // (그림자 안의 id 는 창의 getElementById 와도 안 섞인다.)

  // 메일 종이의 기본 꾸밈 — 그림자 밖의 규칙은 안으로 안 들어가므로 여기서 따로 건다.
  // 예전 .body.rich img 등과 같은 세기(:host(.mail) img = 0,2,1)라, 메일의 흔한 규칙(img{…})에 지지 않는다.
  // 창의 맨 앞 규칙(* { margin:0; padding:0; box-sizing:border-box })도 예전엔 메일 안까지 걸렸다 — 그 모습 그대로 두려고
  // 다시 건다. 다만 가장 약하게(층 @layer 안 — 메일의 어떤 규칙에도 진다). 빼면 <p>·<ul> 의 기본 여백이 돌아와
  // 같은 메일이 예전보다 성기게 보인다 (실측 — 지어낸 Word 표에서 그림이 본문 상자 아래로 2px 밀렸다).
  const PAPER_CSS = `
    @layer reset { :host(.mail) * { box-sizing: border-box; margin: 0; padding: 0; } }
    :host(.mail) img { max-width: 100%; height: auto; }
    :host(.mail) table { max-width: 100%; border-collapse: collapse; }
    :host(.mail) td, :host(.mail) th { padding: 2px 6px; }
    /* 종이가 테마와 상관없이 흰색이라 창의 강조색을 쓰면 안 된다 — 다크 민트는 흰 종이 위 2.2:1 */
    :host(.mail) a { color: #00664e; }
    :host(.mail) * { max-width: 100%; }
  `;
  let paper = null;

  /**
   * 씻은 조각(nunsSafeHtml 의 결과)을 본문 상자 host 에 넣는다 — 감싸개의 그림자 뿌리 안으로.
   * 돌려주는 것은 그 그림자 뿌리다 (시험이 안을 들여다본다). host 의 원래 내용은 갈아 끼운다.
   */
  window.nunsMountMail = (host, frag) => {
    const wrap = document.createElement('div');
    wrap.className = 'mail';
    const root = wrap.attachShadow({ mode: 'open' });
    if (!paper) {
      paper = new CSSStyleSheet();
      paper.replaceSync(PAPER_CSS);
    }
    // 메일의 <style> 보다 뒤에 놓인다 — 세기가 같으면 이쪽이 이긴다 (예전처럼)
    root.adoptedStyleSheets = [paper];
    // 옮기면 조각이 빈다 — 띄운 채 둔 그림은 넣기 전에 골라 둔다
    const kept = [...frag.querySelectorAll('*')].filter((el) => keptFloat.has(el));
    root.append(frag);
    host.replaceChildren(wrap);
    settleFloats(kept);
    return root;
  };

  /**
   * 띄운 채 둔 Word 그림이 제 표 칸 안에 들어맞게 놓고, 안 되면 흐름으로 내린다.
   * 겹쳐 두는 것은 Word 가 그 자리를 비워 둔 때(칸 안에 같은 크기의 빈 표)만 맞다. 자리가 없는데 겹쳐 두면
   * 그림이 칸 밖으로 나가 아래 줄 글을 덮는다 — 그때는 흐름에 붙여 칸이 그림만큼 자라게 하는 쪽이 낫다.
   * 표 칸 밖(문단 위)에 띄운 그림도 흐름으로 내린다 — 덮을 글이 무엇인지 알 수 없다.
   *
   * 칸이 그림보다 좁으면 칸 폭에 맞게 줄인다. 보기 창은 Outlook 보다 좁아서, 400px 그림이 322px 칸에 들어가지
   * 못해 42장이 모두 흐름으로 내려갔다 (실측 — 진짜 메일, 창 폭 1000px). 줄이면 높이도 줄어 비워 둔 자리 안에 든다.
   * 창 크기가 바뀌면 다시 맞춘다 — 원래 크기(Word 가 적은 값)에서 다시 줄인다.
   * 크기는 style 의 width/height 로 정해져 있어 그림을 다 읽기 전에도 잴 수 있다.
   */
  const floatSize = new WeakMap();
  const floating = (el) => !!el.style.getPropertyValue('position');

  /** 그림을 칸 안에 놓아 본다 — 들어맞으면 true (띄운 채), 아니면 false */
  function placeFloat(el) {
    const cell = el.parentElement && el.parentElement.closest('td, th');
    if (!cell || !el.isConnected) return false;
    let o = floatSize.get(el);
    if (!o) {
      const cs = getComputedStyle(el);
      o = { w: parseFloat(cs.width) || 0, h: parseFloat(cs.height) || 0 };
      floatSize.set(el, o);
    }
    if (!o.w || !o.h) return false;
    const size = (k) => {
      el.style.setProperty('width', `${Math.floor(o.w * k)}px`);
      el.style.setProperty('height', `${Math.floor(o.h * k)}px`);
    };
    // 그림이 span 보다 클 수 있다 (span 은 266px 인데 그림은 제 비율대로 더 높다) — 둘을 합쳐 잰다
    const box = () => {
      const rs = [el, ...el.querySelectorAll('img')].map((x) => x.getBoundingClientRect()).filter((r) => r.width && r.height);
      return rs.length ? {
        l: Math.min(...rs.map((r) => r.left)), r: Math.max(...rs.map((r) => r.right)),
        t: Math.min(...rs.map((r) => r.top)), b: Math.max(...rs.map((r) => r.bottom))
      } : null;
    };
    size(1);
    let a = box();
    const c = cell.getBoundingClientRect();
    if (!a) return false;
    if (a.r > c.right + 1) {
      // 너무 작게 줄이지는 않는다 — 반 아래로 줄여야 하면 흐름에 붙여 칸 폭대로 보이는 편이 낫다
      const k = (c.right - 1 - a.l) / (a.r - a.l);
      if (k < 0.5) return false;
      size(k);
      a = box();
      if (!a) return false;
    }
    return a.l >= c.left - 1 && a.r <= c.right + 1 && a.t >= c.top - 1 && a.b <= c.bottom + 1;
  }

  function settleFloats(list) {
    if (!list.length) return;
    // 먼저 다 놓아 보고 나서 내린다 — 하나를 내리면 칸이 자라 뒤의 것의 판정이 바뀐다
    const drop = list.filter((el) => !placeFloat(el));
    for (const el of drop) toFlow(el.style);
    const live = list.filter((el) => !drop.includes(el));
    if (!live.length) return;
    // 그림을 다 읽으면 크기가 바뀔 수 있다 (width·height 속성의 비율과 실제 그림의 비율이 다르면) — 그때 한 번 더 놓는다
    for (const el of live) {
      for (const img of el.querySelectorAll('img')) {
        if (img.complete) continue;
        img.addEventListener('load', () => {
          if (floating(el) && !placeFloat(el)) toFlow(el.style);
        }, { once: true });
      }
    }
    // 창 크기가 바뀌면 칸 폭도 바뀐다 — 다시 놓는다. 메일을 갈아 끼워 다 떨어져 나가면 그만 본다
    const host = live[0].getRootNode().host;
    const box = host && host.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const on = live.filter((el) => el.isConnected && floating(el));
      if (!on.length) { ro.disconnect(); return; }
      const out = on.filter((el) => !placeFloat(el));
      for (const el of out) toFlow(el.style);
    });
    ro.observe(box);
  }
})();

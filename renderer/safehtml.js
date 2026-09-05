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
        if (!css) { el.remove(); continue; }
        el.textContent = css;
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
          if (v) el.setAttribute('style', v); else el.removeAttribute('style');
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
   * 넣는 쪽은 el.replaceChildren(nunsSafeHtml(html)) 처럼 쓴다.
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
})();

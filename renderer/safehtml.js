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
    'meta', 'base', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'template']);

  const OK_ATTR = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign',
    'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'color', 'face', 'size',
    'bgcolor', 'background', 'dir', 'lang', 'style', 'class', 'target', 'rel']);

  /** 주소가 안전한가 — 엔티티·제어문자로 감춘 스킴을 펴서 본다 */
  function safeUrl(v) {
    const flat = String(v || '')
      .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_m, d) => String.fromCharCode(Number(d)))
      .replace(/[\s\u0000-\u0020]/g, '')
      .toLowerCase();
    if (!flat) return false;
    if (/^(javascript|vbscript|file|about|blob):/.test(flat)) return false;
    // data: 는 그림만 (data:text/html 로 창을 통째로 바꿀 수 있다)
    if (flat.startsWith('data:')) return /^data:image\//.test(flat);
    return true;
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
        const css = safeStyle(el.textContent);
        if (css) el.textContent = css; else el.remove();
        continue;
      }
      if (!OK_TAG.has(tag)) {
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
        } else if (name === 'href' || name === 'src' || name === 'background') {
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

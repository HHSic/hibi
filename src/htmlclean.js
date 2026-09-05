'use strict';
/**
 * 남이 준 HTML에서 «실행되는 것»을 걷어낸다.
 *
 * 따로 파일로 둔 이유: 이걸 preload에서도 써야 한다(서명을 붙여넣는 순간에 걸러야 하므로
 * IPC를 기다릴 수 없다). mail.js를 부르면 imapflow·mailparser가 창마다 딸려 올라온다.
 * 여기는 아무것도 require하지 않는다.
 *
 * ── 이것만으로는 부족하다 ─────────────────────────────
 * 정규식으로 HTML을 씻는 것은 원리적으로 완전할 수 없다. 실제로 이런 것들이 뚫렸다:
 *   <img src="x"onerror="alert(1)">   따옴표가 값을 끝내니 공백 없이도 새 속성이 된다
 *   <script>alert(1)                  닫는 태그가 없으면 짝 맞추기에 안 걸린다
 *   <a href="java&#9;script:…">       엔티티로 감춘 스킴
 * 아래에서 이 셋을 막았지만, 다음 우회가 없다고 보장할 수 없다.
 *
 * ── 여기가 지키는 것과 안 지키는 것 ────────────────────
 * 여기를 지나는 것은 «내가 쓴 서명»과 «내가 보내는 메일»이다 (mailhub, send.js).
 * 받은 메일 본문은 여기로 오지 않는다 — 그건 mail.js 의 buildViewHtml 이 씻고,
 * 화면에 넣기 직전에 renderer/safehtml.js 가 DOM 으로 한 번 더 훑는다.
 * 남이 보낸 글의 주 방어는 그 safehtml 이다. 시험은 test/sanitize.test.js.
 */
function cleanHtml(input) {
  const html = String(input || '');
  if (!html) return '';

  const stripped = html
    // 통째로 위험한 태그 (짝이 맞을 때)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet)[\s\S]*?<\/\1>/gi, '')
    .replace(/@import[^;]+;/gi, '')
    // 짝이 없는 여는 태그도 지운다 — 위의 짝 맞추기는 닫는 태그가 있어야 걸린다.
    // <script>alert(1) 처럼 안 닫으면 그대로 살아남았다 (실측).
    .replace(/<\/?(?:script|iframe|object|embed|applet|link|meta|base|form)\b[^>]*>/gi, '');

  // 속성을 건드리는 일은 «태그 안에서만» 한다.
  //
  // 예전에는 글 전체에 대고 정규식을 돌렸다. 앞 조건을 «낱말 글자가 아니면»으로
  // 넓혔더니, 태그 밖의 멀쩡한 글자까지 속성으로 보고 먹어 버렸다 (실측):
  //   href="…?once=1"              → href="…?      뒷부분이 통째로 사라진다
  //   <p>서비스가 online= 상태</p>  → <p>서비스가  >
  // 여기를 지나는 것은 «내가 쓴 서명»과 «내가 보내는 메일»이라, 이런 삼킴은 곧
  // 내 글이 깨지는 것이다. 그래서 태그 조각만 골라 그 안에서만 손본다.
  // 태그 조각을 고를 때 «따옴표 안의 꺾쇠»에 속으면 안 된다. [^>]* 로만 잡으면
  //   <img src="x>" onerror="alert(1)">
  // 에서 src 값 안의 > 를 태그 끝으로 보고, 뒤의 onerror 는 태그 밖으로 남아
  // 손도 안 대고 살아남는다 (실측). 그래서 따옴표 구간을 통째로 건너뛰며 읽는다.
  return stripped.replace(/<[a-zA-Z!/](?:"[^"]*"|'[^']*'|[^>"'])*>?/g, scrubTag);
}

/** 태그 하나(`<…>`) 안에서 이벤트 속성과 위험한 스킴을 걷어낸다 */
function scrubTag(tag) {
  return tag
    // 이벤트 속성.
    // 앞이 «공백이나 슬래시»라고만 보면 안 된다 — 따옴표가 값을 끝내므로
    // <img src="x"onerror=…> 는 공백 없이도 새 속성이 된다. 실제로 이게 뚫렸다.
    // 따옴표 뒤도 속성 자리로 본다. 태그 안이라 «online=» 같은 글은 여기 안 온다.
    .replace(/([\s/"'])on[a-z]+\s*=\s*"[^"]*"/gi, '$1')
    .replace(/([\s/"'])on[a-z]+\s*=\s*'[^']*'/gi, '$1')
    // 따옴표 없는 값. 여기서 = 뒤의 공백까지 먹으면 안 된다 —
    //   <div onclick= class="keep">   → class 까지 같이 지워진다 (실측)
    // 값이 비어 있어도 괜찮다. onclick= 만 지우고 뒤는 그대로 둔다.
    .replace(/([\s/"'])on[a-z]+\s*=[^\s>]*/gi, '$1')
    // 위험한 스킴. 엔티티·제어문자로 감출 수 있어(java&#9;script:) 값 안의
    // 엔티티와 공백류를 먼저 지우고 본다.
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (whole, attr, _raw, dq, sq, bare) => {
        const val = dq != null ? dq : sq != null ? sq : bare || '';
        const bare2 = val
          .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&#(\d+);?/g, (_m, d) => String.fromCharCode(Number(d)))
          .replace(/[\s\u0000-\u0020]/g, '')
          .toLowerCase();
        if (/^(javascript|vbscript|data:text\/html)/.test(bare2)) return `${attr}="#"`;
        return whole;
      });
}

module.exports = { cleanHtml };

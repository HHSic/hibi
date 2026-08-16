'use strict';
/**
 * 남이 준 HTML에서 «실행되는 것»을 걷어낸다.
 *
 * 따로 파일로 둔 이유: 이걸 preload에서도 써야 한다(서명을 붙여넣는 순간에 걸러야 하므로
 * IPC를 기다릴 수 없다). mail.js를 부르면 imapflow·mailparser가 창마다 딸려 올라온다.
 * 여기는 아무것도 require하지 않는다.
 */
function cleanHtml(input) {
  const html = String(input || '');
  if (!html) return '';

  return html
    // 통째로 위험한 태그
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(link|meta|base)\b[^>]*>/gi, '')
    .replace(/@import[^;]+;/gi, '')
    // 이벤트 속성. 앞이 공백이라고만 보면 안 된다 —
    // 따옴표 뒤에는 «/»도 속성 구분자로 통해서 <img src="x"/onerror=…> 가 살아남는다.
    .replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ')
    // javascript: 링크
    .replace(/(href|src|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'")
    .replace(/(href|src|xlink:href)\s*=\s*javascript:[^\s>]*/gi, '$1="#"');
}

module.exports = { cleanHtml };

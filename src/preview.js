'use strict';
/**
 * 첨부 미리보기 — 저장하지 않고 그 자리에서 본다.
 *
 * 무엇을 보여줄 수 있나로 갈린다.
 *   그림  → 메일 안에 이미 담겨 있다 (본문 창이 data:로 바로 그린다)
 *   글    → 여기서 글자로 풀어 돌려준다. HTML이어도 «글자»로만 보여준다 —
 *           첨부로 온 HTML을 렌더링하면 그건 남이 보낸 페이지를 여는 것이다.
 *   PDF   → 크로미움 뷰어를 쓴다. 임시 파일로 떨군 뒤 창 하나를 띄운다.
 *   나머지 → 못 한다고 말한다.
 *
 * «시스템 기본 앱으로 열기»는 일부러 넣지 않았다. 첨부는 남이 보낸 파일이고,
 * 그걸 셸에 넘기는 순간 .exe·.scr·매크로 문서가 그대로 실행된다.
 * 저장은 사용자가 대화상자로 자리를 고르는 일이라 그것과 다르다.
 */
const path = require('path');

/** 글자로 풀어 볼 만한 것 — 확장자와 타입 둘 다 본다 (타입이 엉터리인 메일이 많다) */
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|javascript|x-sh))/i;
const TEXT_EXT = /\.(txt|log|csv|tsv|md|json|xml|ya?ml|ini|cfg|conf|srt|vtt|sql|html?|css|js|ts|py|java|c|h|cpp|cs)$/i;

/** 글로 보여줄 상한 — 이보다 크면 창이 멈춘다 */
const TEXT_MAX = 256 * 1024;
/** PDF 상한 — 임시 파일로 떨구는 것이라 무한정 받을 수 없다 */
const PDF_MAX = 40 * 1024 * 1024;

function extOf(name) {
  const m = String(name || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0].toLowerCase() : '';
}

/** 이 첨부를 어떻게 보여줄까 */
function kindOf(att) {
  const type = String((att && att.contentType) || '').toLowerCase();
  const name = String((att && att.filename) || '');
  const size = att && att.content ? att.content.length : 0;

  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || extOf(name) === '.pdf') {
    return size <= PDF_MAX ? 'pdf' : 'toobig';
  }
  if (TEXT_TYPES.test(type) || TEXT_EXT.test(name)) {
    return size <= TEXT_MAX ? 'text' : 'toobig';
  }
  return 'none';
}

/**
 * 미리보기에 쓸 임시 파일 이름.
 * 원래 이름을 그대로 쓰면 «..\..\» 같은 것이 섞여 들어올 수 있다 — 남이 지은 이름이다.
 * 내용에서 뽑은 값으로 짓고 확장자만 살린다 (크로미움이 확장자로 뷰어를 고른다).
 */
function tempName(att, ext) {
  const buf = att.content;
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(buf.length / 4096));
  for (let i = 0; i < buf.length; i += step) {
    h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
  }
  return `${h.toString(36)}_${buf.length}${ext}`;
}

/** 안전한 임시 경로 — 폴더 밖으로 나가지 못한다 */
function tempPathFor(dir, att, ext) {
  const p = path.join(dir, tempName(att, ext));
  const rel = path.relative(dir, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return p;
}

module.exports = { kindOf, extOf, tempName, tempPathFor, TEXT_MAX, PDF_MAX, TEXT_TYPES, TEXT_EXT };

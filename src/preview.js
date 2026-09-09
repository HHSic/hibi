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
 * 여기서 못 그리는 것(hwp·docx·zip 따위)은 임시 파일로 떨궈 «기본 앱으로 열기»를
 * 내준다. 예전에는 이 길을 아예 막아 두었다 — 남이 보낸 파일을 셸에 넘기면
 * .exe·.scr·매크로 문서가 그대로 실행되기 때문이다. 이제는 열되, 그 위험을 셋으로 나눈다.
 *   1. 허락한 확장자만 (모르는 것은 안 연다 — 막을 것을 나열하는 쪽은 늘 뚫린다)
 *   2. 확장자를 «윈도우가 보는 대로» 골라낸다 (끝의 점·공백, 스트림 문법, 방향 바꾸기 글자)
 *   3. 인터넷에서 온 표(Mark-of-the-Web)를 붙여 오피스가 보호된 보기로 열게 한다
 * 저장은 여전히 따로다 — 사용자가 대화상자로 자리를 고른다.
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
  // 끝의 점·공백을 먼저 뗀다 — 윈도우가 그렇게 하기 때문이다.
  // 안 떼면 «보고서.pdf.» 가 확장자 없는 것으로 보여 PDF 로 안 열린다
  // (타입이 엉터리인 메일에서는 이 확장자가 유일한 단서다).
  const m = String(name || '').replace(/[. ]+$/, '').match(/\.[a-z0-9]+$/i);
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

// ── 기본 앱으로 열기 ─────────────────────────────────────
/**
 * 윈도우가 «실제로 실행할 이름»을 골라낸다.
 *
 * 남이 지은 이름이라 눈속임이 섞여 온다. 여기서 걷어내는 것들:
 *   보고서.pdf.exe        → .exe  (마지막 확장자가 진짜다)
 *   보고서.exe.           → .exe  (윈도우는 끝의 점을 떼고 실행한다)
 *   "보고서.exe   "       → .exe  (끝의 공백도 뗀다)
 *   보고서.txt:악성.exe   → .txt  (콜론 뒤는 NTFS 스트림 문법이다)
 *   보고서<U+202E>txt.exe → .exe  (방향 바꾸기 글자를 넣어 눈에는 .txt 로 보이게 한 것.
 *                                  이 주석에 그 글자를 그대로 적으면 git 이 이 파일을
 *                                  바이너리로 보고 변경 내역을 못 보여준다.)
 *   보고서.ｅｘｅ         → null  (전각·유사 글자는 아스키가 아니라 걸러진다)
 * 못 알아보면 null 을 준다 — 그리고 null 은 «안 연다»로 간다.
 */
function openExt(filename) {
  let s = String(filename || '');
  // 눈속임용 보이지 않는 글자 (방향 바꾸기·너비 없는 것)를 먼저 없앤다
  s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.split(/[\\/]/).pop();      // 경로처럼 생긴 것은 마지막 조각만
  s = s.split(':')[0];             // 콜론 뒤는 스트림 이름이다
  s = s.replace(/[. ]+$/, '');     // 끝의 점·공백은 윈도우가 뗀다
  // 아스키 글자·숫자만 확장자로 인정한다. 전각이나 유사 글자는 여기서 떨어진다.
  const m = s.match(/\.([A-Za-z0-9]{1,12})$/);
  return m ? `.${m[1].toLowerCase()}` : null;
}

/**
 * 기본 앱으로 넘겨도 되는 것.
 *
 * 허락 목록으로만 간다. «위험한 것을 나열해 막기»는 새 형식이 늘 때마다 뚫린다 —
 * 윈도우에는 두 번 눌러 뭔가를 실행하는 확장자가 백 가지가 넘고 계속 늘어난다.
 */
const OPEN_ALLOW = new Set([
  // 문서
  '.pdf', '.hwp', '.hwpx', '.doc', '.docx', '.rtf', '.odt',
  '.xls', '.xlsx', '.ods', '.csv', '.tsv',
  '.ppt', '.pptx', '.odp',
  // 글·자료
  '.txt', '.log', '.md', '.json', '.xml', '.yml', '.yaml', '.ini', '.srt', '.vtt',
  // 그림 (앱에서 이미 그리지만, 앱이 못 읽는 형식도 있다)
  // .svg 는 뺐다 — 기본 앱이 보통 브라우저이고, SVG 안에는 스크립트를 담을 수 있다.
  // 앱 안에서는 그림으로 그려도 되지만(그때는 CSP 가 막는다), 셸에 넘기면 그냥 돈다.
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic',
  // 소리·영상
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi',
  // 묶음
  '.zip', '.7z', '.rar', '.alz', '.egg', '.tar', '.gz', '.bz2', '.xz'
]);

/**
 * 허락 목록에 있어도 «한 번 더 물어야» 하는 것.
 * 매크로를 담을 수 있거나, 열자마자 바깥을 부르는 형식들이다.
 * (매크로가 아예 안 되는 형식은 여기 없다 — .docx 는 매크로를 못 담는다.)
 */
const OPEN_WARN = new Set(['.hwp', '.hwpx', '.doc', '.xls', '.ppt', '.rtf']);

/**
 * 이 첨부를 기본 앱으로 열 수 있나.
 * @returns {{ ok: boolean, ext?: string, warn?: boolean, why?: string }}
 */
function openable(att) {
  const ext = openExt(att && att.filename);
  if (!ext) {
    return { ok: false, why: '확장자를 알 수 없어 열지 않습니다 — 저장한 뒤 확인해주세요' };
  }
  if (!OPEN_ALLOW.has(ext)) {
    return { ok: false, ext, why: `${ext} 은 열지 않습니다 — 저장한 뒤 확인해주세요` };
  }
  return { ok: true, ext, warn: OPEN_WARN.has(ext) };
}

module.exports = {
  kindOf, extOf, tempName, tempPathFor, TEXT_MAX, PDF_MAX, TEXT_TYPES, TEXT_EXT,
  openExt, openable, OPEN_ALLOW, OPEN_WARN
};

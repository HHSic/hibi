'use strict';
/* global module */
// 본문에 그림 붙여넣기 — «무엇을 어떻게 붙일까»를 정하는 셈만 여기 둔다.
//
// 캔버스·클립보드·DOM 은 쓰기 창(compose.js)이 만진다. 여기는 글자와 숫자만 다뤄서
// node 로도 시험할 수 있다 (test/pastepick.test.js). 쓰기 창에서는 window.nunsPaste 로 쓴다.
//
// 가장 조심할 것: 엑셀 칸·워드 글을 복사하면 클립보드에 글과 함께 «그 모양을 찍은 그림»도 실린다.
// 그림부터 보면 표를 붙였는데 사진이 들어간다. 그래서 글이 있으면 글이 이긴다 —
// 단 브라우저의 «이미지 복사»처럼 HTML 이 그림 하나뿐이고 보이는 글이 없으면 그림이다.
(function (root) {
  const MB = 1024 * 1024;
  const IMAGE_MAX = 5 * MB;          // 본문 그림 하나 — «그림» 단추와 같다. 메인(composewin)도 이 값으로 막는다
  const HARD_MAX = 30 * MB;          // 이보다 큰 그림은 읽지도 않는다 (메인의 그림 고르기도 같다)
  const MIN_SIDE = 800;              // 줄여도 긴 변이 이보다 작아지면 못 읽는 그림이 된다 — 거기서 멈춘다
  const DRAFT_HTML_MAX = 2 * MB;     // 임시 저장 본문 — 메인(store.setMailDraft)과 같은 값
  const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

  // 별칭 — 옛 프로그램이 붙이는 이름도 같은 형식이다
  const ALIAS = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' };
  // 크로미움이 그릴 수는 있지만 메일로는 안 되는 것 — PNG 로 바꿔 넣는다 (아웃룩은 WebP 를 못 그리고 BMP 는 크다)
  const TO_PNG = ['image/webp', 'image/bmp', 'image/x-ms-bmp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon'];
  // 형식이 빈 채로 오는 파일(탐색기 복사 등)은 확장자로 본다
  const BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
    svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif'
  };

  /** 거절할 때 하는 말 — 뒤에 어떻게 하면 되는지(HINT)가 한 번 붙는다 (summary) */
  const WHY = {
    svg: 'SVG 그림은 본문에 넣을 수 없습니다',
    format: '이 형식의 그림은 본문에 넣을 수 없습니다',
    noPath: '이 파일은 붙여넣을 수 없습니다',
    huge: '그림이 너무 큽니다 (30MB 넘음)',
    tooBig: '줄여도 5MB를 넘습니다',
    anim: '움직이는 GIF가 5MB를 넘습니다',
    broken: '그림을 읽지 못했습니다',
    // 구글 문서·웹 페이지에서 그림을 골라 복사하면 그림 없이 주소(<img src=https…>)만 온다 — 바깥 주소는 부르지 않는다
    urlOnly: '그림 주소만 왔습니다 — 그림에서 «이미지 복사»를 하거나, 저장한 뒤 «그림» 단추로 넣어 주세요'
  };

  /**
   * 거절 뒤에 붙일 안내 — 따를 수 있는 말만 한다.
   *   save   — 클립보드에만 있는 것 (화면 캡처·브라우저에서 복사한 파일): 디스크에 없으니 먼저 저장해야 한다
   *   attach — 디스크에 있는 파일 («그림» 단추로 고른 것): «파일 첨부»로 바로 붙는다
   * 못 읽은 그림·폴더처럼 첨부해도 안 되는 것에는 안내를 달지 않는다 ('').
   */
  const HINT = {
    save: '파일로 저장한 뒤 «파일 첨부»로 붙여 주세요',
    attach: '«파일 첨부»로 붙여 주세요'
  };

  // 임시 저장에 못 담은 그림 자리 — 이어 쓸 때 어디에 있었는지 보이고, 남은 채로는 보내지 않는다 (compose.js send).
  // 편집 안 되는 덩어리(contenteditable=false)다 — 커서가 글자 사이로 들어가 그림이 그 안에 끼거나 반쪽만 지워지지 않는다.
  // 그 바로 앞·뒤에 그림을 붙이면 이 자리표가 그림으로 바뀐다 (compose.js). 메인(store.js)도 같은 표식을 쓴다
  const PLACEHOLDER = '<span data-pic-gone="1" contenteditable="false" style="display:inline-block;padding:1px 8px;border:1px dashed #b0b4ba;'
    + 'border-radius:6px;color:#6b7078;font-size:12px">그림 자리 — 다시 붙여 주세요</span>';

  /**
   * 붙이는 중인 그림의 자리 — «그림 넣는 중…». 붙이는 순간 커서 자리에 넣고, 다 줄이면 그림으로 바꾼다.
   * 자리를 Range 로 들고 있으면 앞에 글이 들어와 글자 노드가 쪼개질 때 엉뚱한 데로 접힌다 — 노드는 편집을 따라 같이 움직인다.
   * 작은 그림(<img>)으로 둔다: 글 사이에 한 덩어리로 끼고 한 번에 지워진다. 편집 안 되는 <span> 은 execCommand 가
   * 줄(div)을 둘로 쪼개고 그 사이에 넣어서 쓸 수 없었다 (실측). 글자는 SVG 로 그린다 (CSP 가 data: 그림만 받는다).
   * 테두리는 compose.html 의 .pasting. 임시 저장·보내기·합계에는 안 들어간다 (stripSlots · compose.js)
   */
  const SLOT_SRC = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="92" height="18">'
    + '<text x="46" y="13" text-anchor="middle" font-size="12" font-family="Malgun Gothic, sans-serif" fill="#6b7078">그림 넣는 중…</text></svg>')}`;
  const slotHtml = (id) => `<img class="pasting" data-paste-slot="${Number(id) || 0}" alt="그림 넣는 중…" src="${SLOT_SRC}">`;
  const SLOT_TAG = /<img\b[^>]*\bdata-paste-slot="[^"]*"[^>]*>/gi;
  // 붙이는 중에 «그 자리의 이어 쓰기 자리표는 그림이 들어가면 없앤다»고 달아 두는 번호 (compose.js makeSlot) — 창 안에서만 뜻이 있다
  const GONE_TAG = /<span\b[^>]*\bdata-pic-gone="1"[^>]*>/gi;
  /** 직렬화한 본문에서 «그림 넣는 중…» 표식과 자리표에 달아 둔 번호를 걷어낸다 (임시 저장에 남으면 다음 창의 번호와 엉킨다) */
  const stripSlots = (html) => String(html || '').replace(SLOT_TAG, '')
    .replace(GONE_TAG, (tag) => tag.replace(/\sdata-pic-take="[^"]*"/gi, ''));

  const extOf = (name) => {
    const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
    return m ? m[1].toLowerCase() : '';
  };

  /** 형식 이름을 맞춘다 — 빈 형식이면 확장자로 */
  function mimeOf(type, name) {
    const t = String(type || '').trim().toLowerCase();
    if (t) return ALIAS[t] || t;
    return BY_EXT[extOf(name)] || '';
  }

  /**
   * 어떻게 다룰까
   *   keep  — 그대로 본문에 (PNG·JPEG·GIF)
   *   png   — PNG 로 바꿔 본문에 (WebP·BMP·AVIF·ICO)
   *   svg   — 본문에는 안 넣는다 (스크립트를 품을 수 있고, 받는 쪽도 대개 못 그린다)
   *   other — 크로미움이 못 그리는 그림 (TIFF·HEIC …)
   *   file  — 그림이 아닌 파일
   */
  function kindOf(type, name) {
    const t = mimeOf(type, name);
    if (INLINE_TYPES.includes(t)) return 'keep';
    if (TO_PNG.includes(t)) return 'png';
    if (t === 'image/svg+xml') return 'svg';
    if (t.startsWith('image/')) return 'other';
    return 'file';
  }

  /** 보낼 수 있는 형식이면 맞춘 이름, 아니면 '' (보낼 때 PNG 로 바꾸거나 뺀다) */
  function sendableType(type) {
    const t = String(type || '').trim().toLowerCase();
    const n = ALIAS[t] || t;
    return INLINE_TYPES.includes(n) ? n : '';
  }

  /** 클립보드 HTML 에서 «화면에 보이는 글»만 — 주석·<style>·태그·속성(alt 포함)은 글이 아니다 */
  function visibleText(html) {
    return String(html || '')
      .replace(/<!--[\s\S]*?(-->|$)/g, '')
      .replace(/<(style|script|title|head|template)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&(nbsp|#160|#x0*a0);/gi, ' ')
      .replace(/&[#a-z0-9]+;/gi, '_');
  }

  /** 그려 보다 안 되면 — 경로가 있으면 첨부로, 없으면 거절 */
  function fallback(hasPath, why) {
    return { action: hasPath ? 'attach' : 'refuse', why };
  }

  /**
   * 거절 안내의 종류 — from: 'clip'(클립보드에만 있는 것) · 'disk'(디스크의 파일).
   * 못 읽은 그림은 저장해도·첨부해도 안 되니 안내가 없다
   */
  function hintFor(why, from) {
    if (why === WHY.broken) return '';
    return from === 'disk' ? 'attach' : 'save';
  }

  /** 알림에 쓸 이름 — 클립보드에서 온 이름 없는 것은 «붙여넣은 그림»·«붙여넣은 파일» */
  function labelFor(name, kind, hasPath) {
    if (!hasPath && isGenericName(name)) return kind === 'file' ? '붙여넣은 파일' : '붙여넣은 그림';
    return safeName(name);
  }

  const isPic = (f) => f.kind === 'keep' || f.kind === 'png';
  // HTML 이 «글의 꼴»(표·문단·줄)인가 — 그림을 가리키지 않는 HTML 과 함께 온 비트맵은 그 글을 찍은 그림이다
  const TEXT_TAGS = /<(table|tr|td|th|p|div|li|ul|ol|h[1-6]|pre|br|span|font)\b/i;

  /**
   * 붙여넣기 하나를 어떻게 받을까.
   * @param files [{ type, name, size, hasPath }] — hasPath 는 preload 가 «진짜 파일이 뒤에 있나»만 알려 준 것
   * @returns { mode: 'text', text, urlOnly? } | { mode: 'files', items: [{ index, kind, mime, action, why?, hint?, screen? }] }
   *   action: inline(본문 그림) · attach(끌어다 놓기와 같은 길로 첨부) · refuse(못 붙인다 — why, hint)
   *   screen: HTML 없이 비트맵만 온 것 (캡처 도구) — 화면 배율만큼 픽셀이 많으니 화면에서 본 크기로 보이게 한다
   *   urlOnly: 그림 없이 그림 주소(HTML <img>)만 왔다 — 아무것도 안 넣지만 알린다
   */
  function decide({ text = '', html = '', files = [] } = {}) {
    let list = (files || []).map((f, index) => {
      const kind = kindOf(f && f.type, f && f.name);
      const hasPath = !!(f && f.hasPath);
      return {
        index, kind, mime: mimeOf(f && f.type, f && f.name), hasPath, size: Number(f && f.size) || 0,
        // 크로미움이 클립보드 비트맵에 붙이는 이름(image.png)에 경로도 없다 — 사람이 고른 파일이 아니다
        bitmap: !hasPath && isGenericName(f && f.name) && (kind === 'keep' || kind === 'png')
      };
    });
    // 비트맵과 그 그림의 디스크 파일이 함께 오는 앱이 있다 (파이어폭스 «이미지 복사»·사진 앱) — 파일만 쓴다 (두 장이 되지 않게)
    if (list.some((f) => f.hasPath && isPic(f))) list = list.filter((f) => !f.bitmap);
    const t = String(text || '');
    const h = String(html || '');
    const hasText = /\S/.test(t);
    const htmlImg = /<img\b/i.test(h);
    // 브라우저 «이미지 복사» — 글 칸엔 그림 주소가 오기도 하지만 HTML 은 <img> 하나뿐이다
    const pictureOnly = htmlImg && !/\S/.test(visibleText(h)) && list.some(isPic);
    if ((hasText && !pictureOnly) || !list.length) {
      return !hasText && !list.length && htmlImg && !/\S/.test(visibleText(h)) ? { mode: 'text', text: t, urlOnly: true } : { mode: 'text', text: t };
    }
    // 엑셀 빈 칸·워드 빈 줄: 글은 공백뿐이고 HTML 은 그림 없는 표·문단, 그것을 찍은 비트맵 — 그림이 아니다
    if (h && !htmlImg && TEXT_TAGS.test(h) && list.every((f) => f.bitmap)) return { mode: 'text', text: t };
    const items = list.map((f) => {
      const base = { index: f.index, kind: f.kind, mime: f.mime };
      const no = (why) => {
        const r = fallback(f.hasPath, why);
        return r.action === 'refuse' ? { ...base, ...r, hint: hintFor(why, 'clip') } : { ...base, ...r };
      };
      if (isPic(f)) return f.size > HARD_MAX ? no(WHY.huge) : { ...base, action: 'inline', screen: f.bitmap && !h.trim() };
      return no(f.kind === 'svg' ? WHY.svg : f.kind === 'other' ? WHY.format : WHY.noPath);
    });
    return { mode: 'files', items };
  }

  /** 줄이는 차례 — 원래 크기(JPEG 로만 바꿔 본다)부터 0.8배씩, 마지막은 긴 변 MIN_SIDE */
  function shrinkSteps(w, h, minSide = MIN_SIDE) {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    const long = Math.max(W, H);
    const at = (k) => ({ w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) });
    const steps = [{ w: W, h: H }];
    if (long <= minSide) return steps;
    for (let k = 0.8; long * k >= minSide; k *= 0.8) steps.push(at(k));
    const last = steps[steps.length - 1];
    if (Math.max(last.w, last.h) > minSide) steps.push(at(minSide / long));
    return steps;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /** 클립보드 그림 이름 — «붙여넣은 그림 20261117-140512.png», 이 메일 안에서 겹치면 (2)·(3) */
  function pastedName(now, ext, taken) {
    const d = now instanceof Date ? now : new Date();
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const has = (n) => (taken && typeof taken.has === 'function' ? taken.has(n) : Array.isArray(taken) && taken.includes(n));
    const base = `붙여넣은 그림 ${stamp}`;
    let name = `${base}.${ext}`;
    for (let k = 2; has(name); k++) name = `${base} (${k}).${ext}`;
    return name;
  }

  /** 크로미움이 클립보드 그림에 붙이는 이름 («image.png») — 사람이 붙인 이름이 아니다 */
  function isGenericName(name) {
    const s = String(name || '').trim();
    return !s || /^image\.[A-Za-z0-9]{1,5}$/i.test(s);
  }

  // 이름에 못 오는 글자 — 제어 글자(C0·C1), 줄·문단 구분, 글자 방향을 바꾸는 표시(RLO 등)와 BOM.
  // 방향 표시가 있으면 «사진\u202egnp.exe» 가 받는 쪽에 «사진exe.png» 처럼 보인다. 메인(composewin inlineOf)도 같은 글자를 막는다
  const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

  /** 첨부 이름으로 쓸 수 있게 — 경로·특수 글자는 _, 제어·방향 글자는 빼고, 너무 길면 줄인다 (확장자는 남긴다) */
  function safeName(name, fallbackExt = 'png') {
    let s = String(name || '')
      .replace(BAD_NAME_CHARS, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
      .replace(/^\.+/, '')
      .trim();
    if (!s) s = `그림.${fallbackExt}`;
    if (s.length > 120) {
      const m = s.match(/\.[A-Za-z0-9]{1,8}$/);
      const ext = m ? m[0] : '';
      s = s.slice(0, 120 - ext.length) + ext;
    }
    return s;
  }

  /** 형식을 바꿨으면 확장자도 */
  function withExt(name, ext) {
    return `${String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '')}.${ext}`;
  }

  // 형식마다 받는 확장자 — 첫째가 바꿀 때 쓰는 것. 메인(composewin)도 같은 표로 맞춘다
  const EXT_OF = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/gif': ['gif'] };

  /** 보낼 그림의 이름 — 다듬고(safeName), 확장자가 형식과 다르면(.exe 등) 형식 확장자로 */
  function nameFor(name, contentType) {
    const exts = EXT_OF[sendableType(contentType)] || ['png'];
    const s = safeName(name, exts[0]);
    return exts.includes(extOf(s)) ? s : withExt(s, exts[0]);
  }

  /** 속성 값에 넣을 때 */
  function escAttr(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * GIF 의 장 수 — 둘 이상이면 움직이는 그림이다 (둘을 세면 더 안 센다). GIF 가 아니거나 꼴이 깨졌으면 -1.
   * 움직이는 GIF 는 캔버스로 줄이면 첫 장만 남는다 — 5MB 를 넘으면 펴지 않고 첨부로 보낸다.
   */
  function gifFrames(b) {
    if (!b || b.length < 13) return -1;
    const sig = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (sig !== 'GIF87a' && sig !== 'GIF89a') return -1;
    let p = 13;
    if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
    let frames = 0;
    // 덩어리들(크기 바이트 + 내용)을 0 이 나올 때까지 건너뛴다
    const skip = () => {
      while (p < b.length) {
        const n = b[p++];
        if (!n) return true;
        p += n;
      }
      return false;
    };
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x3B) break;
      if (t === 0x21) {
        p++;
        if (!skip()) break;
      } else if (t === 0x2C) {
        if (p + 9 > b.length) break;
        const f = b[p + 8];
        p += 9;
        if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
        p++;   // LZW 첫 부호 길이
        frames++;
        if (frames > 1 || !skip()) break;
      } else {
        break;
      }
    }
    return frames || -1;
  }

  /** data: 주소가 품은 바이트 수 (base64 를 풀었을 때) — data: 가 아니면 0 */
  function dataUrlBytes(src) {
    const s = String(src || '');
    if (!/^data:[^,]*;base64,/i.test(s)) return 0;
    const b64 = s.slice(s.indexOf(',') + 1).replace(/\s+/g, '');
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
  }

  /** 본문 그림 바이트 합 — 같은 그림은 보낼 때 cid 하나라 한 번만 센다 */
  function inlineBytes(srcs) {
    let n = 0;
    for (const s of new Set((srcs || []).filter(Boolean))) n += dataUrlBytes(s);
    return n;
  }

  /**
   * 임시 저장에 다 안 들어갈 때 뺄 그림 — 큰 것부터, 들어갈 때까지만. 작은 서명 로고는 남는다.
   * @param sizes 그림마다 HTML 에서 차지하는 글자 수
   * @returns { drop: [번호], fits } — 다 빼도 안 들어가면 fits:false (글이 너무 길다 — 메인이 본문을 비운다)
   */
  function pickDrops(sizes, htmlLen, max, placeholderLen = PLACEHOLDER.length) {
    const order = (sizes || []).map((_s, i) => i).sort((a, b) => sizes[b] - sizes[a]);
    let total = htmlLen;
    const drop = [];
    for (const i of order) {
      if (total <= max) break;
      total = total - sizes[i] + placeholderLen;
      drop.push(i);
    }
    return { drop: drop.sort((a, b) => a - b), fits: total <= max };
  }

  // <img …> 태그 하나 — 따옴표째 통으로 잡는다 (속성 값 안의 «>» 에서 끊기지 않게). 메인(store.js)도 같은 꼴로 잡는다
  const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

  /**
   * 임시 저장할 본문 — 직렬화한 글에서 바로 고친다 (DOMParser 로 다시 읽고 다시 쓰지 않는다:
   * 그림이 몇십 MB 면 손이 멈출 때마다 화면이 0.5초씩 굳었다). 고친 곳 밖의 글자는 한 글자도 안 바뀐다.
   *   · «그림 넣는 중…» 표식은 걷어낸다 (stripSlots)
   *   · max 를 넘으면 큰 data: 그림부터 자리표(PLACEHOLDER)로 — 글은 자르지 않는다 (pickDrops)
   * @returns { html, dropped }
   */
  function draftHtml(html, max = DRAFT_HTML_MAX) {
    const s = stripSlots(html);
    if (s.length <= max) return { html: s, dropped: 0 };
    const pics = [];
    for (const m of s.matchAll(IMG_TAG)) {
      if (/\ssrc\s*=\s*["']?\s*data:/i.test(m[0])) pics.push({ at: m.index, len: m[0].length });
    }
    const plan = pickDrops(pics.map((p) => p.len), s.length, max);
    if (!plan.drop.length) return { html: s, dropped: 0 };
    let out = '';
    let from = 0;
    for (const k of plan.drop) {
      out += s.slice(from, pics[k].at) + PLACEHOLDER;
      from = pics[k].at + pics[k].len;
    }
    return { html: out + s.slice(from), dropped: plan.drop.length };
  }

  const fmtSize = (n) => (n > MB ? `${(n / MB).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

  /**
   * 붙인 뒤 알림 한 줄 — «그림 2개를 붙였습니다 · 1개는 커서 줄였습니다 (8.2MB → 1.9MB)».
   * 줄었다는 말은 실제로 작아진 것만 한다 (WebP 를 PNG·JPEG 로 바꾸면 더 커지기도 한다).
   * 못 붙인 것이 있으면 이름 — 까닭을 대고, 따를 수 있는 안내(HINT)를 한 번 붙인다 (bad).
   * refused 의 hint 가 없으면(예전 꼴) attach 로 본다. dropped — «그림 넣는 중…» 자리를 지워서 안 넣은 붙여넣기 수
   */
  function summary({ inlined = 0, shrunk = [], attached = 0, already = false, refused = [], dropped = 0 } = {}) {
    const parts = [];
    const smaller = (shrunk || []).filter((s) => s && s.to < s.from);
    if (inlined) {
      parts.push(`그림 ${inlined}개를 붙였습니다`
        + (smaller.length ? ` · ${smaller.length}개는 커서 줄였습니다 (${smaller.map((s) => `${fmtSize(s.from)} → ${fmtSize(s.to)}`).join(', ')})` : ''));
    }
    if (dropped) parts.push('붙이던 자리를 지워서 그림을 넣지 않았습니다');
    if (attached) parts.push(`파일 ${attached}개를 첨부했습니다`);
    else if (already) parts.push('이미 붙어 있습니다');
    if (refused.length) {
      for (const r of refused) parts.push(`${r.name} — ${r.why}`);
      const hints = refused.map((r) => (r.hint === undefined ? 'attach' : r.hint));
      if (hints.includes('save')) parts.push(HINT.save);
      else if (hints.includes('attach')) parts.push(HINT.attach);
    }
    return { kind: refused.length ? 'bad' : '', text: parts.join(' · ') };
  }

  const api = {
    IMAGE_MAX, HARD_MAX, MIN_SIDE, DRAFT_HTML_MAX, INLINE_TYPES, WHY, HINT, PLACEHOLDER,
    kindOf, mimeOf, sendableType, visibleText, decide, fallback, hintFor, labelFor, shrinkSteps,
    pastedName, isGenericName, safeName, withExt, nameFor, escAttr, gifFrames,
    dataUrlBytes, inlineBytes, pickDrops, draftHtml, SLOT_SRC, slotHtml, stripSlots, summary, fmtSize
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object' && root.document) root.nunsPaste = api;
})(typeof window !== 'undefined' ? window : globalThis);

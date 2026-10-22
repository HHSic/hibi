'use strict';
/**
 * 메일 본문의 링크를 누르면 어디로 보낼까 — 영상이면 앱 안의 플레이어(videowin.js)로, 아니면 기본 브라우저로.
 *
 * 소식지는 영상 주소를 그대로 싣지 않는다. 실측(사용자가 받은 소식지 한 통, HTML 1.8KB): 본문이 큰 그림 하나이고
 * 그 그림이 «재생 단추가 그려진 썸네일»인데, 링크는 클릭 추적 주소(tr.maillink.co.kr/procresponse?a=…)다.
 * 주소만 봐서는 영상인지 모른다 — 따라가 봐야 안다. 그래서 세 단계로 본다.
 *   1. 주소 자체가 YouTube 영상이면 바로 튼다 (아무 데도 안 묻는다).
 *   2. 쿼리 값에 YouTube 영상 주소가 실려 있으면 그걸 튼다 — 추적 서버에는 안 간다
 *      (추적 주소는 목적지를 ?url=… 처럼 싣는 일이 많다).
 *   3. «알려진 클릭 추적·단축 주소»일 때만, 사용자가 눌렀으니까 리다이렉트를 따라가 본다 — 최대 5번, 4초 안에.
 *      끝이 영상이면 틀고, 아니면 «끝 주소»를 브라우저로 연다 (추적 서버를 두 번 치지 않게).
 *      풀다가 실패하면 원래 주소를 브라우저로 연다 — 누른 것이 사라지는 게 제일 나쁘다.
 *
 * 그 밖의 링크는 앱이 부르지 않는다 — 예전처럼 원래 주소를 브라우저로 넘긴다.
 * 실측(창 없는 Electron, 127.0.0.1 지어낸 서버): 아무 링크나 앱이 먼저 GET 하면 매직 로그인·메일 인증·암호 재설정 같은
 * 일회용 링크의 토큰을 앱이 써 버린다. 세션 쿠키는 버리는 세션에만 남고, 브라우저에는 «링크 만료»나 로그인 화면이 뜬다.
 * 같은 까닭으로 따라가다가도 «다른 사이트로 넘기는 곳»은 부르지 않는다 — 추적 주소가 넘겨 주는 목적지(기사·로그인)는
 * 브라우저가 처음이자 한 번만 부르게 둔다. 영상이면 튼다. 또 다른 추적·단축 주소면 계속 따라간다.
 * 사설망·루프백(공유기·NAS·localhost)도 부르지 않는다 — 사용자 눈에 안 보이는 GET 이 거기 닿을 까닭이 없다.
 *
 * 따라가는 요청은 따로 떼어 둔 세션으로만 보낸다. 메모리에만 있는 칸(partition)이고 쿠키·인증을 안 싣는다 —
 * 추적 서버가 심은 쿠키가 다른 창으로 따라오면 안 된다. 본문은 받지 않는다 (머리만 보고 끊는다).
 * 작은 HTML(64KB 이하)만 읽어 <meta http-equiv="refresh"> 와 «넘겨 주기 껍데기»의 location 스크립트를 한 단계로 친다.
 */
const { net, session } = require('electron');
const evlog = require('./evlog');
const { openWeb } = require('./win');
const videowin = require('./videowin');

const PARTITION = 'hibi-link';   // persist: 가 없다 — 메모리에만 있고, 앱을 끄면 사라진다
const MAX_HOPS = 5;
const TIMEOUT_MS = 4000;          // 링크 전체를 푸는 데 드는 시간 — 넘으면 원래 주소를 브라우저로
const HTML_MAX = 64 * 1024;
// 이보다 오래 기다렸다 넘기는 refresh 는 «넘겨 주기»가 아니라 진짜 페이지다
const REFRESH_MAX_S = 5;
// location 스크립트를 넘김으로 치는 페이지 — 보이는 글이 이보다 짧은 «잠시만 기다려 주세요» 껍데기만
const JS_TEXT_MAX = 400;

// ── YouTube 주소 읽기 ─────────────────────────────────
// 호스트는 «정확히» 이것들만. 끝이 같거나 경로에 youtube.com 이 든 것(youtube.com.evil.example,
// evil.example/youtube.com/watch)은 남의 주소다.
const YT = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const YT_NOCOOKIE = new Set(['youtube-nocookie.com', 'www.youtube-nocookie.com']);
const YT_SHORT = new Set(['youtu.be', 'www.youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// /embed/ 뒤에 오지만 영상 번호가 아닌 것 — 둘 다 마침 11자라 번호 꼴 검사를 지난다
const NOT_VIDEO = new Set(['videoseries', 'live_stream']);

/** 시작 시각 «90» «90s» «1m30s» «1h2m3s» → 초. 못 읽으면 0 */
function seconds(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 0;
  if (/^\d+s?$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/**
 * 이 주소가 YouTube 영상 하나인가 → { id, start, shorts } | null.
 * 채널·재생목록·검색 같은 «영상이 아닌» YouTube 페이지는 null (브라우저로 간다).
 */
function youtubeOf(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const segs = u.pathname.split('/').filter(Boolean);
  let id = null;
  let shorts = false;
  if (YT_SHORT.has(host)) {
    if (segs.length === 1) id = segs[0];
  } else if (YT.has(host)) {
    if (segs.length === 1 && segs[0] === 'watch') id = u.searchParams.get('v');
    else if (segs.length === 2 && ['embed', 'shorts', 'live', 'v'].includes(segs[0])) {
      id = segs[1];
      shorts = segs[0] === 'shorts';
    } else if (segs.length === 1 && segs[0] === 'attribution_link') {
      // YouTube 가 «공유»에 쓰는 제 주소 — 목적지가 u=/watch?v=… 로 실린다 (제 사이트 안의 경로만)
      const inner = u.searchParams.get('u') || '';
      if (inner.startsWith('/') && !inner.startsWith('//')) return youtubeOf(new URL(inner, 'https://www.youtube.com').href);
    }
  } else if (YT_NOCOOKIE.has(host)) {
    if (segs.length === 2 && (segs[0] === 'embed' || segs[0] === 'v')) id = segs[1];
  } else {
    return null;
  }
  if (!id || !VIDEO_ID.test(id) || NOT_VIDEO.has(id)) return null;
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  const start = seconds(u.searchParams.get('t') || u.searchParams.get('start') || u.searchParams.get('time_continue')
    || hash.get('t') || hash.get('start'));
  return { id, start, shorts };
}

// «공유하기» 주소 — 영상 주소를 쿼리에 싣지만 목적지는 공유 화면이다.
// 소식지의 «페이스북에 공유» 단추를 눌렀는데 영상이 뜨면 안 된다.
const SHARE = /(^|[./])(share|sharer|sharing|intent|submit)([./?]|$)|\/pin\/create/i;

/** 쿼리 값 하나에서 꺼낼 수 있는 주소들 — 한 번 더 인코딩된 것(%253A)과 base64 로 싼 것까지 */
function unwrap(v) {
  const out = [];
  let s = String(v || '').trim();
  for (let i = 0; i < 3 && s; i++) {
    if (/^https?:\/\//i.test(s)) { out.push(s); break; }
    let d;
    try { d = decodeURIComponent(s); } catch { break; }
    if (d === s) break;
    s = d.trim();
  }
  const b = String(v || '').trim();
  if (/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(b)) {
    const t = Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (/^https?:\/\/[\x21-\x7e]+$/.test(t)) out.push(t);
  }
  return out;
}

/** 주소의 쿼리(와 # 뒤) 값에 실린 YouTube 영상 — 추적 주소를 안 부르고 목적지를 읽는다 */
function youtubeInParams(raw, depth = 0) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (SHARE.test(u.hostname + u.pathname)) return null;
  const values = [...u.searchParams.values(), ...new URLSearchParams(u.hash.replace(/^#/, '')).values()];
  for (const v of values) {
    for (const cand of unwrap(v)) {
      const y = youtubeOf(cand);
      if (y) return y;
      // 추적 주소 안에 또 추적 주소가 실린 꼴 — 두 겹까지
      if (depth < 2) {
        const n = youtubeInParams(cand, depth + 1);
        if (n) return n;
      }
    }
  }
  return null;
}

/** 주소가 곧 영상이거나 쿼리에 영상을 싣고 있으면 그 영상 */
function videoIn(url) {
  return youtubeOf(url) || youtubeInParams(url);
}

// ── 앱이 불러도 되는 주소 ───────────────────────────────
const hostOf = (raw) => {
  try { return new URL(String(raw || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
};

/**
 * 알려진 클릭 추적·단축 주소 — 이 호스트(와 그 아래)만 앱이 먼저 부른다.
 * 목록 밖의 추적 주소는 예전처럼 브라우저로 간다 (영상이면 브라우저에서 보게 될 뿐, 누른 것은 안 사라진다).
 */
const TRACKERS = [
  'maillink.co.kr',            // 사용자가 받은 소식지 (tr.·trs.maillink.co.kr)
  'stibee.com', 'stib.ee',     // 스티비
  'list-manage.com',           // 메일침프 (…us1.list-manage.com/track/click)
  'ct.sendgrid.net',           // SendGrid
  'mlsend.com',                // MailerLite
  'rs6.net',                   // Constant Contact
  'hubspotlinks.com',          // HubSpot
  // 단축 주소
  'bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'buff.ly', 'lnkd.in', 'rebrand.ly', 'cutt.ly', 'is.gd',
  'me2.do', 'naver.me', 'han.gl', 'vo.la', 'url.kr'
];
function isTracker(raw) {
  if (!/^https?:\/\//i.test(String(raw || '').trim())) return false;
  const h = hostOf(raw);
  return !!h && TRACKERS.some((d) => h === d || h.endsWith(`.${d}`));
}

// 두 단짜리 국가 도메인의 둘째 단 — co.kr·or.kr·co.uk·com.au 는 그 앞까지가 한 사이트다
const SLD = new Set(['co', 'or', 'ne', 'go', 'ac', 're', 'pe', 'com', 'net', 'org', 'gov', 'edu', 'mil', 'ltd', 'plc']);
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 등록 도메인(«사이트») — tr.maillink.co.kr → maillink.co.kr, a.b.example.com → example.com. IP 는 그대로 */
function siteOf(raw) {
  const h = hostOf(raw);
  if (!h || h.startsWith('[') || V4.test(h)) return h;
  const p = h.split('.');
  const n = p.length >= 3 && p[p.length - 1].length === 2 && SLD.has(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join('.');
}
const sameSite = (a, b) => { const s = siteOf(a); return !!s && s === siteOf(b); };

// 한 번 쓰면 끝나는 링크의 낱말 — 경로 조각이나 쿼리 «이름»에 있으면 앱은 그 주소를 부르지 않는다
// (값은 안 본다 — 추적 주소의 불투명한 값에 우연히 든 글자로 막으면 안 된다)
const ONE_SHOT = new Set(['token', 'code', 'otp', 'magic', 'verify', 'verification', 'confirm', 'confirmation',
  'activate', 'activation', 'reset', 'login', 'logon', 'signin', 'signup', 'auth', 'oauth', 'sso', 'approve',
  'unsubscribe', 'unsub', 'optout', 'invite', 'password']);
function oneShot(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  const names = [...u.pathname.split('/'), ...u.searchParams.keys()];
  return names.some((name) => {
    let s;
    try { s = decodeURIComponent(name).toLowerCase(); } catch { s = name.toLowerCase(); }
    // «sign-in»·«magic_link»·«verify-email» — 붙여 읽은 것과 낱말 하나하나를 다 본다
    return ONE_SHOT.has(s.replace(/[^a-z]/g, '')) || s.split(/[^a-z]+/).some((w) => ONE_SHOT.has(w));
  });
}

// ── 사설·루프백 주소 ─────────────────────────────────
function v4Of(s) {
  const m = String(s).match(V4);
  if (!m) return null;
  const a = m.slice(1).map(Number);
  return a.every((n) => n <= 255) ? a : null;
}
function v6Of(s) {
  let t = String(s).toLowerCase();
  const tail = t.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const a = v4Of(tail[1]);
    if (!a) return null;
    t = `${t.slice(0, -tail[1].length)}${((a[0] << 8) | a[1]).toString(16)}:${((a[2] << 8) | a[3]).toString(16)}`;
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const g = [...head, ...Array(fill).fill('0'), ...rest].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((n) => Number.isInteger(n)) ? g : null;
}
const v4Local = ([a, b]) => a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128)
  || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
function v6Local(g) {
  if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return true;          // :: · ::1
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true;
  // ::ffff:192.168.0.1 처럼 IPv4 를 감싼 것
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return v4Local([g[6] >> 8, g[6] & 255]);
  return false;
}
/** 주소 글자 하나(1.2.3.4 · ::1)가 사설·루프백·링크로컬·멀티캐스트인가 */
function addrLocal(addr) {
  const s = String(addr || '').replace(/^\[|\]$/g, '');
  const a = v4Of(s);
  if (a) return v4Local(a);
  const g = v6Of(s);
  return g ? v6Local(g) : false;
}
/**
 * 이 주소의 호스트가 내 컴퓨터나 사내망을 가리키는가 — 이름만 보고.
 * WHATWG URL 이 2130706433 · 0x7f.1 · 127.1 을 127.0.0.1 로 풀어 주므로 그런 꼴도 걸린다.
 */
function hostLocal(raw) {
  const h = hostOf(raw);
  if (!h) return true;
  if (h.startsWith('[')) return v6Of(h.slice(1, -1)) ? addrLocal(h) : true;
  if (v4Of(h)) return addrLocal(h);
  // 점 없는 한 낱말 이름(nas·intranet)은 사내망 이름이다 — 윈도우가 «인트라넷»으로 본다
  if (!h.includes('.')) return true;
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local');
}

// ── 리다이렉트 따라가기 ─────────────────────────────────
const ENTITY = { amp: '&', quot: '"', apos: '\'', lt: '<', gt: '>' };
const unentity = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : all;
  }
  return ENTITY[e.toLowerCase()] || all;
});

/** refresh 값 «0; url=…» → 주소 (상대 주소일 수 있다) | null. «5» 만 있거나 오래 기다리는 것은 넘겨 주기가 아니다 */
function refreshTarget(content) {
  const r = String(content || '').match(/^\s*(\d*(?:\.\d+)?)\s*[;,]\s*(?:url\s*=\s*)?(.+)$/i);
  if (!r || Number(r[1] || 0) > REFRESH_MAX_S) return null;
  const url = r[2].trim().replace(/^['"]|['"]$/g, '').trim();
  return url || null;
}

/** HTML 앞머리의 <meta http-equiv="refresh" content="0; url=…"> → 주소 (상대 주소일 수 있다) | null */
function metaRefresh(html) {
  const s = String(html || '').slice(0, HTML_MAX);
  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?\s*refresh\b/i.test(tag)) continue;
    const c = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const url = refreshTarget(unentity(c ? (c[1] ?? c[2] ?? c[3]) : ''));
    if (url) return url;
  }
  return null;
}

// location = '…' · location.href = '…' · location.replace('…') · location.assign('…') — 글자 그대로인 절대 주소만.
// 앞이 «foo.location» 이면 남의 물건이다 (window·document·top·self·parent 만). 뒤에 + 가 붙으면 글자 덧셈이다 —
// 앞 조각(사이트 첫 화면)만 잡히므로 안 친다
const JS_GO = /(?<![\w$.])(?:(?:window|document|top|self|parent)\.)?location(?:\.href)?\s*=\s*(['"])(https?:\\?\/\\?\/[^'"\s<>]+)\1(?!\s*\+)|(?<![\w$.])(?:(?:window|document|top|self|parent)\.)?location\.(?:replace|assign)\(\s*(['"])(https?:\\?\/\\?\/[^'"\s<>]+)\3\s*\)/;

/**
 * «잠시만 기다려 주세요» 껍데기가 스크립트로 넘기는 주소 → 절대 주소 | null.
 * 국내 메일 발송 서비스의 추적 주소는 200 HTML 안의 location.replace(…) 로 넘기는 일이 흔하다 — 3xx 만 보면 못 푼다.
 * 글이 있는 진짜 페이지의 «누르면 가는» 스크립트를 넘김으로 보면 안 되므로, 보이는 글이 짧은 페이지만 본다.
 * 주소를 글자 덧셈으로 만드는 꼴은 못 읽는다 — 그때는 예전처럼 그 주소를 브라우저로 연다.
 */
function jsRedirect(html) {
  const s = String(html || '').slice(0, HTML_MAX);
  const text = s.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|\s+/gi, ' ').trim();
  if (text.length > JS_TEXT_MAX) return null;
  const codes = [...s.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]);
  const onload = s.match(/<body\b[^>]*\bonload\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (onload) codes.push(unentity(onload[1] ?? onload[2]));
  for (const code of codes) {
    const g = code.match(JS_GO);
    if (g) return (g[2] || g[4]).replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  }
  return null;
}

let linkSes = null;
function linkSession() {
  if (linkSes) return linkSes;
  linkSes = session.fromPartition(PARTITION);
  // 앱 이름·Electron 이 박힌 UA 를 «사람이 아닌 것»으로 보고 다른 답을 주는 곳이 있다 — 그냥 크롬처럼 보인다
  try { linkSes.setUserAgent(linkSes.getUserAgent().replace(/\s(?:Electron|Hibi|hibi)\/\S+/g, '')); } catch { /* 그대로 */ }
  return linkSes;
}

/**
 * 이름이 사설 주소로 풀리는가(127.0.0.1.nip.io 꼴) — 부르기 전에 미리 푼다 → 주소 글자들.
 * 못 풀면 빈 배열 — 그때는 netHop 이 제 오류(ERR_NAME_NOT_RESOLVED)로 끝낸다.
 */
async function dnsLookup(host) {
  const ses = linkSession();
  if (typeof ses.resolveHost !== 'function') return [];
  try {
    const r = await ses.resolveHost(host);
    return ((r && r.endpoints) || []).map((e) => e.address);
  } catch {
    return [];
  }
}

const header = (res, name) => {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
};
const setsCookie = (headers) => Object.keys(headers || {}).some((k) => k.toLowerCase() === 'set-cookie');

/**
 * 한 단계 — GET 을 보내 머리만 보고 끊는다. → { status, location? , refresh?, cookie? }
 * 3xx 는 따라가지 않고(redirect: 'manual') 주소만 받는다. 다음 단계는 resolve 가 직접 검사한 뒤 보낸다.
 * cookie = 이 답이 쿠키를 심으려 했다 (우리는 안 받는다 — resolve 가 브라우저에 넘길 주소를 고를 때 본다).
 * 3xx 의 Set-Cookie 는 알 수 없다 — 실측(Electron 33.4): 'redirect' 의 머리에도 webRequest 에도 Set-Cookie 가 빠져 온다.
 * 200 (Refresh 머리·meta refresh·location 스크립트로 넘기는 껍데기)의 Set-Cookie 만 보인다.
 */
function netHop(url, ms) {
  return new Promise((resolve, reject) => {
    let req = null;
    let timer = null;
    let settled = false;
    const done = (err, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.abort(); } catch { /* 이미 끝났다 */ }
      if (err) reject(err); else resolve(v);
    };
    timer = setTimeout(() => done(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    try {
      req = net.request({
        url, method: 'GET', session: linkSession(),
        // 쿠키·인증을 안 싣고 안 받는다. 리퍼러도 안 보낸다 (어느 앱에서 눌렀는지 알릴 까닭이 없다)
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        redirect: 'manual'
      });
    } catch (e) {
      done(e);
      return;
    }
    req.setHeader('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    // followRedirect 를 안 부르면 그 자리에서 끊긴다 — 주소만 들고 나온다
    req.on('redirect', (status, _method, redirectUrl) => done(null, { status, location: redirectUrl }));
    req.on('login', (_info, cb) => cb());   // 이름·암호는 주지 않는다
    req.on('error', (e) => done(e));
    req.on('response', (res) => {
      const cookie = setsCookie(res.headers);
      // 머리의 «Refresh: 0; url=…» — 브라우저는 이것도 따라간다. 안 보면 그 추적 주소를 브라우저가 한 번 더 친다.
      // 본문이 없거나 HTML 이 아니어도 걸리므로 아래의 «HTML 이 아니면 끊는다»보다 먼저 본다
      const hr = refreshTarget(header(res, 'refresh'));
      if (hr) {
        done(null, { status: res.statusCode, refresh: hr, cookie });
        return;
      }
      const type = String(header(res, 'content-type') || '');
      const len = Number(header(res, 'content-length'));
      // HTML 이 아니거나 크면 본문을 안 받는다 — 머리가 온 지금 끊는다
      if ((type && !/text\/html|application\/xhtml\+xml/i.test(type)) || len > HTML_MAX) {
        done(null, { status: res.statusCode, cookie });
        return;
      }
      const chunks = [];
      let size = 0;
      const finish = () => {
        const html = Buffer.concat(chunks).toString('utf8');
        done(null, { status: res.statusCode, refresh: metaRefresh(html) || jsRedirect(html), cookie });
      };
      res.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        // 길이를 안 밝히고(chunked) 오거나 압축이 풀려 커진 본문 — 64KB 를 넘으면 넘겨 주기 껍데기가 아니다.
        // 실측: 같은 200KB 본문이 Content-Length 로 오면 안 읽고, chunked·gzip 으로 오면 앞 64KB 의 refresh 를 따라갔다
        if (size > HTML_MAX) done(null, { status: res.statusCode, cookie });
      });
      res.on('end', finish);
      res.on('error', (e) => done(e));
    });
    req.end();
  });
}

/** 부르기 전 검사 — 이 주소가 내 컴퓨터·사내망인가 (이름으로, 그리고 이름을 풀어서) */
async function isLocal(url, lookup, ms) {
  if (hostLocal(url)) return true;
  const h = hostOf(url);
  if (v4Of(h) || h.startsWith('[') || ms <= 0) return false;
  let timer = null;
  const addrs = await Promise.race([
    Promise.resolve(lookup(h)).catch(() => []),
    new Promise((r) => { timer = setTimeout(() => r([]), ms); })
  ]);
  clearTimeout(timer);
  return (addrs || []).some(addrLocal);
}

/**
 * 리다이렉트를 따라가 끝 주소를 찾는다.
 *   { ok: true, url, hops, video? }  — url 이 브라우저에 넘길 주소. video 가 있으면 가는 길에 만난 영상 (그 주소는 안 불렀다)
 *       more: true      5번을 다 썼다 — url 은 아직 안 부른 다음 주소 (브라우저가 이어 간다)
 *       unfetched: true 다른 사이트로 넘기거나 일회용 링크 꼴이라 url 을 부르지 않았다 (브라우저가 처음 부른다)
 *       local: true     사설·루프백 주소라 url 을 부르지 않았다
 *       cookie: true    같은 사이트의 앞 단계가 쿠키를 심었다 — 쿠키가 있어야 다음 단계가 되므로 url 은 그 단계다
 *   { ok: false, error, hops, last? } — 시간 초과·연결 실패·http(s) 가 아닌 곳으로 넘김.
 *       last = 실패한 그 단계의 주소. 앞 단계(추적)는 이미 우리가 불렀으니, 브라우저는 여기서 이어 가면 된다
 * o.hop·o.lookup 은 시험이 갈아 끼운다 (기본은 진짜 네트워크). o.tracked = 다른 사이트여도 따라갈 주소인가.
 * o.allowLocal 은 시험만 쓴다 — 시험 서버가 127.0.0.1 이다.
 */
async function resolve(start, o = {}) {
  const hop = o.hop || netHop;
  const lookup = o.lookup || dnsLookup;
  const tracked = o.tracked || isTracker;
  const maxHops = o.maxHops ?? MAX_HOPS;
  const deadline = Date.now() + (o.timeoutMs ?? TIMEOUT_MS);
  // 쿠키를 심은 단계 (이미 부른 주소들). 쿠키 확인 바운스(/bounce → 쿠키 → /check)를 쿠키 없이 따라가면 오류 페이지로
  // 끝난다 — 그 오류 페이지 대신, 쿠키를 심은 단계부터 브라우저가 다시 가게 한다. 다른 사이트의 끝 주소는 그대로 둔다.
  // (netHop 이 Set-Cookie 를 볼 수 있는 200 껍데기만 — 3xx 의 쿠키는 Electron 이 안 보여 준다)
  const cookies = [];
  const handoff = (u, extra) => {
    const c = cookies.find((x) => sameSite(x, u));
    return c && c !== u ? { ...extra, url: c, cookie: true } : { ...extra, url: u };
  };
  let url = String(start);
  for (let n = 0; ; n++) {
    // 다음 주소가 영상이면 거기서 멈춘다 — YouTube 에는 묻지 않는다
    if (n > 0) {
      const v = videoIn(url);
      if (v) return { ok: true, url, hops: n, video: v };
    }
    if (n >= maxHops) return handoff(url, { ok: true, hops: n, more: true });
    if (!o.allowLocal && await isLocal(url, lookup, deadline - Date.now())) return handoff(url, { ok: true, hops: n, local: true });
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, error: 'timeout', hops: n, last: handoff(url).url };
    let r;
    try {
      r = await hop(url, left);
    } catch (e) {
      return { ok: false, error: (e && (e.code || e.message)) || 'error', hops: n, last: handoff(url).url };
    }
    if (r && r.cookie) cookies.push(url);
    const next = r && (r.location || r.refresh);
    if (!next) return handoff(url, { ok: true, hops: n, status: r && r.status });
    let abs;
    try { abs = new URL(next, url); } catch { return { ok: false, error: 'bad-location', hops: n + 1 }; }
    // file: · data: · ms-msdt: 같은 곳으로 넘기면 거기서 그만둔다 — 그런 주소를 우리가 열 까닭이 없다
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return { ok: false, error: 'scheme', hops: n + 1 };
    const to = abs.href;
    // 부를지 — 같은 사이트의 다음 단계이거나 또 다른 추적·단축 주소일 때만. 다른 사이트(기사·로그인)와 일회용 링크 꼴은
    // 부르지 않고 브라우저에 넘긴다 — 토큰과 쿠키가 브라우저 쪽에 남는다 (실측: 추적 → /login?token → Set-Cookie → /home)
    if (!videoIn(to) && (oneShot(to) || (!sameSite(url, to) && !tracked(to)))) {
      return handoff(to, { ok: true, hops: n + 1, unfetched: true });
    }
    url = to;
  }
}

// ── 누른 링크 열기 ─────────────────────────────────────
let deps = {
  play: (video, near) => videowin.play(video, near),
  web: openWeb,
  resolve,
  // 풀어 볼 주소인가 — 시험은 127.0.0.1 의 지어낸 서버를 추적 주소로 친다
  tracked: isTracker
};
/** 시험이 플레이어·브라우저·풀기를 갈아 끼운다 */
function init(h) { deps = { ...deps, ...h }; }

const pending = new Set();   // 푸는 중인 주소 — 두 번 눌러도 브라우저가 두 번 뜨지 않게

/**
 * 누른 링크 하나를 연다. o.near = 영상 창을 띄울 기준 창, o.busy(true|false) = 푸는 동안 알림.
 * → { how: 'play' | 'web' | 'busy', url?, video?, hops?, error? }
 */
async function openLink(url, o = {}) {
  const busy = o.busy || (() => {});
  const t = String(url || '').trim();
  // http(s) 가 아니면 예전 그대로 — openWeb 이 판단한다 (mailto: 등은 안 연다)
  if (!/^https?:\/\//i.test(t)) {
    deps.web(t);
    return { how: 'web', url: t };
  }
  const direct = videoIn(t);
  if (direct) {
    deps.play(direct, o.near);
    evlog.log('메일', '링크 → 영상');
    return { how: 'play', video: direct, hops: 0 };
  }
  // 알려진 추적·단축 주소가 아니면 앱은 부르지 않는다 — 예전처럼 원래 주소를 브라우저로
  if (!deps.tracked(t) || oneShot(t)) {
    deps.web(t);
    return { how: 'web', url: t, hops: 0 };
  }
  if (pending.has(t)) return { how: 'busy' };
  pending.add(t);
  busy(true);
  try {
    const r = await deps.resolve(t);
    if (r && r.ok) {
      const v = r.video || videoIn(r.url);
      if (v) {
        try {
          deps.play(v, o.near);
        } catch (e) {
          // 영상은 이미 안다 — 추적 주소를 다시 치지 말고 그 영상의 YouTube 페이지를 (시작 시각째)
          const w = videowin.watchUrl(v);
          deps.web(w);
          evlog.log('메일', '링크 → 영상 · 플레이어 못 띄워 브라우저로');
          return { how: 'web', url: w, video: v, hops: r.hops, error: (e && e.message) || 'play' };
        }
        evlog.log('메일', `링크 → 영상 (${r.hops}단계)`);
        return { how: 'play', video: v, hops: r.hops };
      }
      deps.web(r.url);
      evlog.log('메일', `링크 → 브라우저 (${r.hops}단계${r.more ? '+' : ''}${r.unfetched ? ' · 끝은 브라우저가' : ''}${r.local ? ' · 사내망' : ''})`);
      return { how: 'web', url: r.url, hops: r.hops };
    }
    // 앞 단계(추적)를 지나 뒤에서 막혔으면(시간 초과·연결 실패) 막힌 그 주소부터 — 추적 서버는 이미 우리가 쳤다.
    // 스킴·주소 꼴이 틀린 넘김이면 원래 주소를 (그 넘김은 브라우저도 안 따른다)
    const back = r && r.last && !/^(scheme|bad-location)$/.test(r.error) ? r.last : t;
    deps.web(back);
    evlog.log('메일', `링크 풀기 실패 → ${back === t ? '원래 주소로' : '막힌 단계부터'} · ${r ? r.error : '?'}`);
    return { how: 'web', url: back, error: r ? r.error : 'error' };
  } catch (e) {
    deps.web(t);
    return { how: 'web', url: t, error: (e && e.message) || 'error' };
  } finally {
    pending.delete(t);
    busy(false);
  }
}

/**
 * 메일 보기 창 하나의 «바깥 주소 열기» — win.lockToOurPage 의 openUrl 로 건넨다.
 * 푸는 동안 그 창에 'mail:link' 로 알린다 ('wait' → '') — 창이 «여는 중…»을 띄운다.
 * 링크 둘을 이어 누르면 둘 다 끝나야 '' 를 보낸다 — 먼저 끝난 쪽이 알약을 걷으면 «눌러도 아무 일 없는» 듯 보인다.
 */
function opener(win) {
  let n = 0;   // 이 창에서 푸는 중인 링크 수
  const tell = (on) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('mail:link', on ? 'wait' : '');
    } catch { /* 닫힌 창 */ }
  };
  const busy = (on) => {
    if (on) { if (n++ === 0) tell(true); } else if (n > 0 && --n === 0) tell(false);
  };
  return (url) => {
    openLink(url, { near: win, busy }).catch(() => deps.web(url));
  };
}

module.exports = {
  PARTITION, MAX_HOPS, TIMEOUT_MS, HTML_MAX, TRACKERS,
  seconds, youtubeOf, youtubeInParams, videoIn, metaRefresh, refreshTarget, jsRedirect,
  isTracker, siteOf, sameSite, oneShot, addrLocal, hostLocal,
  netHop, resolve, openLink, opener, init
};

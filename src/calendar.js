// 캘린더 연동 — iCalendar(.ics) 구독 주소를 읽어 "지금 일정 중인지"를 판단한다.
//
// OAuth 대신 ICS를 쓰는 이유: Google 캘린더·Notion 캘린더·Outlook·Apple이 모두
// 비공개 iCal 주소를 제공한다. 앱 등록도, 토큰 갱신도, 사용자 동의 화면도 필요 없고
// 주소 하나로 모든 서비스를 동일하게 다룰 수 있다.
//
// 반복 일정(RRULE)은 회의에서 매우 흔하므로 지원한다. 다만 전체 RFC 5545를 구현하지 않고
// 조회 구간(오늘 앞뒤 며칠) 안에서만 전개한다.

const https = require('https');
const http = require('http');
const fs = require('fs');

const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * 내 PC에 있는 .ics 파일인가.
 * 로컬 캘린더 앱(Outlook·Thunderbird 등)에서 내보낸 파일을 그대로 쓰게 해준다.
 * 인터넷이 없어도 되고, 계정 연동도 필요 없다.
 */
function isLocalPath(s) {
  const t = String(s || '').trim();
  return /^[a-z]:[\\/]/i.test(t)      // C:\...
    || /^\\\\/.test(t)                 // \\서버\공유
    || /^file:\/\//i.test(t);
}

function localPath(s) {
  const t = String(s || '').trim();
  if (!/^file:\/\//i.test(t)) return t;
  try { return decodeURIComponent(new URL(t).pathname.replace(/^\/([a-z]:)/i, '$1')); }
  catch { return t; }
}

// ── 가져오기 ────────────────────────────────────────────
function fetchText(url, redirects = 0) {
  if (isLocalPath(url)) {
    return fs.promises.readFile(localPath(url), 'utf8').then((text) => {
      if (text.length > MAX_BYTES) throw new Error('파일이 너무 큽니다');
      return text;
    });
  }
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('리디렉션이 너무 많습니다'));
    let mod;
    try {
      // webcal://은 사실상 https
      const normalized = url.replace(/^webcal:\/\//i, 'https://');
      const u = new URL(normalized);
      mod = u.protocol === 'http:' ? http : https;
      const req = mod.get(normalized, { timeout: FETCH_TIMEOUT_MS }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, normalized).href, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) { req.destroy(); return reject(new Error('파일이 너무 큽니다')); }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('시간 초과')); });
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ── 파싱 ────────────────────────────────────────────────
/** 접힌 줄(다음 줄이 공백으로 시작)을 펼친다 */
/**
 * 사람이 붙여넣는 온갖 형태를 ICS 주소로 바꾼다.
 * "iCal 비공개 주소"를 정확히 찾아오는 사람은 드물다. 보통은 캘린더 ID나
 * 브라우저 주소창 URL을 붙여넣는데, 그걸 거절하면 거기서 포기하게 된다.
 */
function normalizeUrl(input) {
  let s = String(input || '').trim()
    .replace(/^[<"']+|[>"']+$/g, '');  // <주소>, "주소" 처럼 감싸 붙여넣는 경우

  // 내 PC의 파일은 손대지 않는다 — 폴더 이름에 공백이 흔하다
  if (isLocalPath(s)) return localPath(s);

  s = s.replace(/\s+/g, '');
  if (!s) return '';

  s = s.replace(/^webcal:\/\//i, 'https://');

  // 캘린더 ID만 붙여넣은 경우 — abc@group.calendar.google.com, me@gmail.com
  if (/^[^\s/:]+@[^\s/:]+\.[a-z]{2,}$/i.test(s)) {
    return `https://calendar.google.com/calendar/ical/${encodeURIComponent(s)}/public/basic.ics`;
  }

  let u;
  try { u = new URL(s); } catch { return s; }

  if (/(^|\.)calendar\.google\.com$/i.test(u.hostname)) {
    // 임베드/공유 주소: ...&src=<캘린더ID>
    const src = u.searchParams.get('src');
    if (src) {
      return `https://calendar.google.com/calendar/ical/${encodeURIComponent(src)}/public/basic.ics`;
    }
    // 구독 주소: ...?cid=<base64 캘린더ID>
    const cid = u.searchParams.get('cid');
    if (cid) {
      let id = cid;
      try { id = Buffer.from(cid, 'base64').toString('utf8'); } catch { /* 평문 cid도 있다 */ }
      if (/@/.test(id)) {
        return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
      }
    }
  }
  return u.toString();
}

/** 붙여넣은 것이 캘린더 주소처럼 보이는가 (클립보드 감지용) */
function looksLikeCalendar(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 500 || /\s/.test(s)) return false;
  return /^webcal:/i.test(s)
    || /\.ics(\?|$)/i.test(s)
    || /calendar\.google\.com/i.test(s)
    || /outlook\.(office|live)\.com.*\/calendar/i.test(s)
    || /^[^\s/:]+@(group\.calendar\.google\.com|gmail\.com)$/i.test(s);
}

// ── 웹에서 열기 ─────────────────────────────────────────
// 일정을 고치려면 원래 OAuth 쓰기 권한이 필요하다. 그런데 사용자는 이미 브라우저에서
// 자기 캘린더에 로그인해 있다. 그 화면을 열어주기만 하면 인증 문제 없이 수정·생성이 된다.

/** 구독 주소에서 Google 캘린더 ID를 뽑는다 (.../ical/<ID>/private-xxx/basic.ics) */
function googleCalendarId(icsUrl) {
  const m = String(icsUrl || '').match(/calendar\.google\.com\/calendar\/ical\/([^/]+)\//i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * 일정을 열 수 있는 웹 주소.
 *  1) ICS가 URL을 줬으면 그대로 — 가장 확실하다
 *  2) Google이면 UID와 캘린더 ID로 편집 주소를 조립한다 (비공식 방식이라 실패할 수 있다)
 *  3) 둘 다 아니면 그 날짜의 캘린더 화면 — 정확하진 않아도 항상 열린다
 */
function eventLink(ev, icsUrl) {
  if (!ev) return null;
  if (ev.url) return ev.url;

  const calId = googleCalendarId(icsUrl);
  if (calId && ev.uid) {
    const eventId = String(ev.uid).replace(/@google\.com$/i, '');
    if (eventId) {
      const token = Buffer.from(`${eventId} ${calId}`, 'utf8')
        .toString('base64').replace(/=+$/, '');
      return `https://calendar.google.com/calendar/u/0/r/eventedit/${token}`;
    }
  }
  if (calId) return dayLink(ev.start);
  return null;
}

/** 그 날짜의 Google 캘린더 화면 */
function dayLink(at) {
  const d = new Date(at || Date.now());
  return `https://calendar.google.com/calendar/u/0/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 새 일정 만들기 — Google이 공식 지원하는 형식이라 안정적이다 */
function newEventLink(start, end) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
      + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  };
  const s = new Date(start);
  const e = end ? new Date(end) : new Date(s.getTime() + 3600000);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&dates=${stamp(s)}/${stamp(e)}`;
}

/** 캘린더가 스스로 밝힌 이름 — 사용자가 이름을 지어내지 않아도 되게 */
function calendarName(icsText) {
  const m = unfold(String(icsText || '')).match(/^X-WR-CALNAME[^:]*:(.*)$/mi);
  if (!m) return '';
  return m[1].trim().replace(/\\,/g, ',').replace(/\\n/gi, ' ').slice(0, 40);
}

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

/** "DTSTART;TZID=Asia/Seoul:20260101T090000" → {name, params, value} */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: parts[0].toUpperCase(), params, value };
}

/**
 * ICS 날짜를 Date로. 형식은 세 가지.
 *   20260101          → 종일 (로컬 자정)
 *   20260101T090000   → 로컬 시각 (TZID가 있어도 로컬로 간주 — 아래 주석 참고)
 *   20260101T000000Z  → UTC
 *
 * TZID를 정확히 해석하려면 tz 데이터베이스가 필요하다. 여기서는 사용자가 자기 캘린더를
 * 자기 PC 시간대로 보는 일반적인 경우를 가정해 로컬로 취급한다.
 */
function parseDate(value, params) {
  const v = String(value).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = hh === undefined;
  if (z) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)), allDay: false };
  }
  return {
    date: new Date(+y, +mo - 1, +d, allDay ? 0 : +hh, allDay ? 0 : +mm, allDay ? 0 : +ss),
    allDay: allDay || (params && params.VALUE === 'DATE')
  };
}

/** "PT1H30M" / "P1D" 같은 기간을 ms로 */
function parseDuration(v) {
  const m = String(v).match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, neg, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 604800 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return neg ? -ms : ms;
}

/** VEVENT 목록으로 파싱 */
function parseEvents(icsText) {
  const lines = unfold(icsText).split('\n');
  const events = [];
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;

    const p = parseLine(line);
    if (!p) continue;

    switch (p.name) {
      case 'DTSTART': {
        const d = parseDate(p.value, p.params);
        if (d) { cur.start = d.date; cur.allDay = d.allDay; }
        break;
      }
      case 'DTEND': {
        const d = parseDate(p.value, p.params);
        if (d) cur.end = d.date;
        break;
      }
      case 'DURATION': {
        const ms = parseDuration(p.value);
        if (ms != null) cur.durationMs = ms;
        break;
      }
      case 'SUMMARY':
        cur.summary = p.value.replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
        break;
      case 'RRULE':
        cur.rrule = p.value;
        break;
      case 'EXDATE': {
        for (const one of p.value.split(',')) {
          const d = parseDate(one, p.params);
          if (d) cur.exdates.push(d.date.getTime());
        }
        break;
      }
      case 'UID':
        cur.uid = p.value.trim();
        break;
      // 일정을 웹에서 열 수 있는 원본 링크. Notion 등은 이걸 넣어준다.
      case 'URL':
        if (/^https?:\/\//i.test(p.value.trim())) cur.url = p.value.trim();
        break;
      case 'STATUS':
        cur.status = p.value.toUpperCase();
        break;
      case 'TRANSP':
        cur.transp = p.value.toUpperCase();
        break;
      default:
        break;
    }
  }
  return events;
}

// ── 반복 전개 ───────────────────────────────────────────
const DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(v) {
  const out = {};
  for (const part of String(v).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

/** 이벤트 하나를 [from, to] 구간 안의 실제 발생들로 전개 */
function expand(ev, from, to) {
  const durMs = ev.durationMs != null
    ? ev.durationMs
    : (ev.end ? ev.end - ev.start : (ev.allDay ? 86400000 : 3600000));

  const push = (startDate, out) => {
    const s = startDate.getTime();
    if (ev.exdates.includes(s)) return;
    const e = s + durMs;
    if (e > from && s < to) {
      out.push({
        start: s, end: e,
        summary: ev.summary || '(제목 없음)',
        allDay: !!ev.allDay,
        uid: ev.uid || null,
        url: ev.url || null
      });
    }
  };

  const out = [];
  if (!ev.rrule) {
    push(ev.start, out);
    return out;
  }

  const r = parseRRule(ev.rrule);
  const freq = (r.FREQ || '').toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
  const untilParsed = r.UNTIL ? parseDate(r.UNTIL, {}) : null;
  const until = untilParsed ? untilParsed.date.getTime() : null;
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => DAY_INDEX[d.slice(-2).toUpperCase()]).filter((n) => n != null) : null;

  // 구간 끝을 넘어서면 멈춘다. 안전장치로 최대 반복 횟수도 둔다.
  const LIMIT = 2000;
  let emitted = 0;
  const cursor = new Date(ev.start);

  for (let i = 0; i < LIMIT; i++) {
    const t = cursor.getTime();
    if (until != null && t > until) break;
    if (t > to) break;
    if (count != null && emitted >= count) break;

    if (freq === 'WEEKLY' && byDay) {
      // 이 주(週)의 지정 요일들을 모두 발생시킨다
      const weekStart = new Date(cursor);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      for (const dow of byDay) {
        const occ = new Date(weekStart);
        occ.setDate(weekStart.getDate() + dow);
        occ.setHours(cursor.getHours(), cursor.getMinutes(), cursor.getSeconds(), 0);
        if (occ.getTime() < ev.start.getTime()) continue;
        if (until != null && occ.getTime() > until) continue;
        if (count != null && emitted >= count) break;
        push(occ, out);
        emitted++;
      }
    } else {
      push(cursor, out);
      emitted++;
    }

    switch (freq) {
      case 'DAILY': cursor.setDate(cursor.getDate() + interval); break;
      case 'WEEKLY': cursor.setDate(cursor.getDate() + 7 * interval); break;
      case 'MONTHLY': cursor.setMonth(cursor.getMonth() + interval); break;
      case 'YEARLY': cursor.setFullYear(cursor.getFullYear() + interval); break;
      default: return out; // 지원하지 않는 FREQ — 첫 발생만
    }
  }
  return out;
}

/** ICS 텍스트에서 [from, to] 구간의 일정 목록을 뽑는다 */
function occurrencesIn(icsText, from, to, { includeAllDay = false } = {}) {
  const out = [];
  for (const ev of parseEvents(icsText)) {
    if (ev.status === 'CANCELLED') continue;
    if (ev.transp === 'TRANSPARENT') continue;   // "한가함"으로 표시된 일정은 방해로 치지 않음
    if (ev.allDay && !includeAllDay) continue;   // 종일 일정은 회의가 아니므로 기본 제외
    out.push(...expand(ev, from, to));
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 구독 주소들을 읽어 오늘 앞뒤 구간의 일정을 모은다.
 * @param {{url:string,name?:string,enabled?:boolean}[]} calendars
 */
async function loadOccurrences(calendars, { windowDays = 2, includeAllDay = false } = {}) {
  const now = Date.now();
  const from = now - windowDays * 86400000;
  const to = now + windowDays * 86400000;

  const results = [];
  const errors = [];
  const sources = [];   // 달력 화면에서 다른 달을 펼치려면 원문이 있어야 한다
  for (const cal of calendars || []) {
    if (!cal || !cal.url || cal.enabled === false) continue;
    try {
      const text = await fetchText(cal.url);
      sources.push({ name: cal.name || '캘린더', url: cal.url, text });
      const occ = occurrencesIn(text, from, to, { includeAllDay });
      results.push(...occ.map((o) => ({ ...o, calendar: cal.name || '캘린더', calUrl: cal.url })));
    } catch (e) {
      errors.push({ url: cal.url, name: cal.name, message: e.message });
    }
  }
  results.sort((a, b) => a.start - b.start);
  return { occurrences: results, errors, sources, fetchedAt: now };
}

/** 이미 받아둔 원문에서 임의 구간을 펼친다 (달력에서 달을 넘길 때 다시 받지 않게) */
function expandRange(sources, from, to, { includeAllDay = true } = {}) {
  const out = [];
  for (const s of sources || []) {
    try {
      out.push(...occurrencesIn(s.text, from, to, { includeAllDay })
        .map((o) => ({ ...o, calendar: s.name, calUrl: s.url })));
    } catch { /* 한 캘린더가 깨져도 나머지는 보여준다 */ }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 지금 진행 중인 일정 (없으면 null) */
function currentEvent(occurrences, at = Date.now()) {
  return (occurrences || []).find((o) => o.start <= at && at < o.end) || null;
}

/** 다음에 시작할 일정 */
function nextEvent(occurrences, at = Date.now()) {
  return (occurrences || []).find((o) => o.start > at) || null;
}

module.exports = {
  loadOccurrences, occurrencesIn, parseEvents, currentEvent, nextEvent, fetchText,
  normalizeUrl, looksLikeCalendar, calendarName, expandRange, isLocalPath,
  eventLink, newEventLink, dayLink, googleCalendarId
};

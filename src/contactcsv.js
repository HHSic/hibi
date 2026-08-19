'use strict';
/**
 * 주소록 ↔ CSV — 아웃룩·엑셀과 주고받는다.
 *
 * 어려운 건 CSV 문법이 아니라 두 가지다.
 *
 * 하나, **인코딩**. 한국어 윈도우의 아웃룩·엑셀은 CSV를 UTF-8이 아니라 CP949로 내보낸다.
 * 그걸 UTF-8로 읽으면 이름이 통째로 깨진다. 반대로 우리가 UTF-8을 BOM 없이 쓰면
 * 엑셀이 CP949로 읽어서 또 깨진다. 그래서 읽을 때는 알아보고, 쓸 때는 BOM을 붙인다.
 *
 * 둘, **머리글 이름이 제각각**이다. 영문 아웃룩은 "E-mail Address",
 * 한국어 아웃룩은 "전자 메일 주소", 구글은 "E-mail 1 - Value"다.
 * 이름도 «성/이름»으로 갈려 있고 한국어는 붙여 쓰고 영문은 띄어 쓴다.
 */
const csv = require('./csv');

// CP949를 읽으려면 필요하다. 없어도 앱은 돌아야 한다 — UTF-8 파일은 그대로 읽힌다.
let iconv = null;
try { iconv = require('iconv-lite'); } catch { /* 없으면 CP949 파일만 못 읽는다 */ }

const BOM = '﻿';

/** 머리글 비교용 — 대소문자·공백·점을 무시한다 */
function norm(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s._]+/g, ' ');
}

const FULL_NAME = new Set([
  'name', 'display name', 'full name', 'contact name', 'nickname',
  '표시 이름', '표시이름', '전자 메일 표시 이름', '이름 전체', '성명'
]);
// 한국어 아웃룩의 «이름»은 First Name이다 — 전체 이름이 아니다
const FIRST_NAME = new Set(['first name', 'given name', '이름']);
const LAST_NAME = new Set(['last name', 'family name', 'surname', '성']);

/** 전자 메일 칸인가 — 번호가 붙은 것(E-mail 2 …)도 받는다 */
function isEmailHeader(h) {
  const s = norm(h);
  if (/^e-?mail\s*\d*\s*(address)?$/.test(s)) return true;
  if (/^e-?mail\s*\d*\s*- value$/.test(s)) return true;
  if (/^전자\s*메일\s*\d*\s*주소$/.test(s)) return true;
  if (/^(이메일|메일)\s*\d*\s*(주소)?$/.test(s)) return true;
  if (s === '주소' || s === 'address') return true;
  return false;
}

const HANGUL = /^[가-힣]+$/;

/** 성과 이름을 한 이름으로 — 한국어는 붙이고(홍+길동), 영문은 띄운다(Gil Hong) */
function joinName(first, last) {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  if (!f) return l;
  if (!l) return f;
  return HANGUL.test(f) && HANGUL.test(l) ? l + f : `${f} ${l}`;
}

/** 이름 하나를 성/이름으로 — 내보낼 때 아웃룩이 알아보게 */
function splitName(name) {
  const s = String(name || '').trim();
  if (!s) return { first: '', last: '' };
  // 한국어 이름은 첫 글자가 성인 경우가 압도적이다 (복성은 알아낼 방법이 없다)
  if (HANGUL.test(s) && s.length >= 2 && s.length <= 5) {
    return { last: s.slice(0, 1), first: s.slice(1) };
  }
  const i = s.lastIndexOf(' ');
  if (i > 0) return { first: s.slice(0, i), last: s.slice(i + 1) };
  return { first: s, last: '' };
}

/**
 * 바이트를 글자로.
 * BOM이 있으면 UTF-8, 없으면 UTF-8로 읽어보고 깨진 글자가 나오면 CP949로 다시 읽는다.
 * (CP949 한글을 UTF-8로 읽으면 거의 반드시 U+FFFD가 나온다)
 */
function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return { text: b.slice(3).toString('utf8'), encoding: 'utf8' };
  }
  const asUtf8 = b.toString('utf8');
  if (!asUtf8.includes('�')) return { text: asUtf8, encoding: 'utf8' };
  if (iconv && iconv.encodingExists('cp949')) {
    return { text: iconv.decode(b, 'cp949'), encoding: 'cp949' };
  }
  // 마지막 수단 — 깨진 채로라도 주소는 ASCII라 살아남는다
  return { text: asUtf8, encoding: 'utf8?' };
}

/**
 * 글자를 바이트로 — 엑셀이 한글을 제대로 열도록 BOM을 붙인 UTF-8.
 * BOM이 없으면 엑셀이 CP949로 읽어서 한글이 통째로 깨진다.
 */
function encode(text) {
  return Buffer.from(BOM + String(text || ''), 'utf8');
}

/** 머리글이 아니라 이미 자료인가 — 주소가 들어 있으면 머리글일 리 없다 */
function looksLikeData(row) {
  return (row || []).some((c) => String(c || '').includes('@'));
}

/**
 * CSV 글자 → 주소록.
 * @returns {{ contacts, total, skipped, columns, headerless }}
 *   contacts  [{ address, name }] — 주소 하나에 한 줄 (아웃룩은 한 사람에 메일이 셋까지 있다)
 *   skipped   주소가 없거나 @가 없어 버린 줄 수
 */
function toContacts(text) {
  const rows = csv.parse(String(text || '').replace(/^﻿/, ''));
  if (!rows.length) return { contacts: [], total: 0, skipped: 0, columns: [], headerless: false };

  // 머리글이 없는 파일도 있다 (이름,주소 두 칸짜리를 손으로 만든 경우)
  const headerless = looksLikeData(rows[0]);
  const body = headerless ? rows : rows.slice(1);
  const header = headerless ? [] : rows[0].map((h) => String(h || '').trim());

  const emailAt = [];
  let fullAt = -1, firstAt = -1, lastAt = -1;
  header.forEach((h, i) => {
    const s = norm(h);
    if (isEmailHeader(h)) { emailAt.push(i); return; }
    if (fullAt < 0 && FULL_NAME.has(s)) fullAt = i;
    if (firstAt < 0 && FIRST_NAME.has(s)) firstAt = i;
    if (lastAt < 0 && LAST_NAME.has(s)) lastAt = i;
  });

  const out = [];
  let skipped = 0;
  const seen = new Set();

  for (const row of body) {
    // 머리글로 못 찾았으면 «@가 든 칸»을 주소로, 그 아닌 첫 칸을 이름으로 본다
    let mails = emailAt.map((i) => row[i]).filter(Boolean);
    let name = fullAt >= 0 ? row[fullAt] : joinName(row[firstAt], row[lastAt]);
    if (!mails.length) {
      const guess = (row || []).map((c, i) => [String(c || ''), i]).filter(([c]) => c.includes('@'));
      mails = guess.map(([c]) => c);
      if (!name) {
        const taken = new Set(guess.map(([, i]) => i));
        name = (row || []).find((c, i) => !taken.has(i) && String(c || '').trim()) || '';
      }
    }
    if (!mails.length) { skipped++; continue; }

    for (const raw of mails) {
      // «홍길동 <hong@x.com>» 같은 모양도 받는다
      const m = String(raw).match(/<([^>]+)>/);
      const address = String(m ? m[1] : raw).trim().toLowerCase();
      if (!address.includes('@') || /\s/.test(address)) { skipped++; continue; }
      if (seen.has(address)) continue;      // 한 파일 안의 중복은 첫 것만
      seen.add(address);
      out.push({ address, name: String(name || '').trim().slice(0, 60) });
    }
  }

  return {
    contacts: out,
    total: body.length,
    skipped,
    columns: header,
    headerless
  };
}

/**
 * 주소록 → CSV 글자.
 * 아웃룩이 알아보는 칸 이름을 쓰고, 우리 이름을 그대로 담는 Name 칸도 같이 둔다 —
 * 성/이름 쪼개기는 짐작이라 되돌릴 때 손실이 생긴다. Name이 있으면 그대로 돌아온다.
 */
function fromContacts(list) {
  const rows = [['First Name', 'Last Name', 'Name', 'E-mail Address']];
  for (const c of list || []) {
    const address = String((c && c.address) || '').trim();
    if (!address) continue;
    const name = String((c && c.name) || '').trim();
    const { first, last } = splitName(name);
    rows.push([first, last, name, address]);
  }
  return csv.format(rows);
}

module.exports = {
  toContacts, fromContacts, decode, encode,
  joinName, splitName, isEmailHeader, norm
};

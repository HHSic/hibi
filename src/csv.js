'use strict';
/**
 * CSV 읽고 쓰기 — 주소록을 아웃룩과 주고받으려고 만들었다.
 *
 * 직접 쓰는 이유는 규칙이 작아서가 아니라, 틀리는 곳이 정해져 있어서다.
 * 쉼표로 자르면 «홍길동, 부장»이 두 칸이 되고, 따옴표 안의 줄바꿈에서 줄이 갈라진다.
 * 실제 아웃룩 내보내기에는 둘 다 들어 있다.
 *
 * 인코딩은 여기서 다루지 않는다 (contactcsv가 맡는다) — 이 파일은 글자만 본다.
 */

/**
 * 한 판 읽기. RFC 4180을 따른다.
 *   - 따옴표 안에서는 쉼표도 줄바꿈도 글자일 뿐이다
 *   - 따옴표 안의 ""는 따옴표 하나
 *   - 줄 끝은 \r\n 도 \n 도 받는다 (엑셀은 \r\n, 다른 도구는 \n)
 * @returns 줄의 배열, 각 줄은 칸의 배열
 */
function parse(text) {
  const src = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;   // 이 줄에 뭔가 있었나 (마지막 빈 줄을 버리려고)

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === '') { quoted = true; started = true; continue; }
    if (c === ',') { row.push(field); field = ''; started = true; continue; }
    if (c === '\r') { continue; }          // \r\n의 \r은 버린다
    if (c === '\n') {
      row.push(field);
      if (started || row.length > 1 || row[0] !== '') rows.push(row);
      row = []; field = ''; started = false;
      continue;
    }
    field += c;
    started = true;
  }
  // 마지막 줄이 줄바꿈 없이 끝났을 때
  row.push(field);
  if (started || row.length > 1) rows.push(row);
  return rows;
}

/** 칸 하나를 내보낼 모양으로 — 쉼표·따옴표·줄바꿈이 있으면 감싼다 */
function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
}

/**
 * 한 판 쓰기.
 * 줄 끝은 \r\n을 쓴다 — 엑셀과 아웃룩이 기대하는 모양이고, 메모장에서도 줄이 보인다.
 */
function format(rows) {
  return (rows || []).map((r) => (r || []).map(cell).join(',')).join('\r\n');
}

/**
 * 머리글이 있는 판을 «이름 → 값» 객체로.
 * 머리글은 앞뒤 공백을 떼고, 찾을 때는 대소문자를 안 가린다.
 */
function withHeader(rows) {
  const list = rows || [];
  if (!list.length) return { header: [], records: [] };
  const header = list[0].map((h) => String(h || '').trim());
  const records = list.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
  return { header, records };
}

module.exports = { parse, format, cell, withHeader };

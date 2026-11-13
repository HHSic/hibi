'use strict';
// 메일 백업 옮기기 — 이전 백업 폴더에서 Hibi 가 만든 것만 새 폴더로 옮긴다.
//
// 폴더째 옮기지 않는다. 사용자가 자기 파일이 든 폴더를 백업 폴더로 골랐을 수 있다 — 그 파일은 그 자리에 둔다.
// Hibi 것: 맨 위의 상태·기록 파일(backup-state.json·tidy-moved.json 과 그 .tmp·.bak·.broken, 쓰기 확인 파일)과
// 계정 폴더(설정에 있는 계정의 폴더 이름, 또는 맨 위에 메일함 폴더만 있고 메일함 안에 Hibi 파일만 — 색인·Hibi 이름꼴 .eml·
// 받는 중 조각 — 있는 폴더. 사용자 파일이 하나라도 섞이면 사용자 폴더로 보고 그대로 둔다).
//
// 같은 볼륨이면 항목마다 바꿔 단다(rename — 빠르고 원자적). 다른 볼륨(EXDEV)이거나 바꿔 달기가 막히면 파일마다 복사하고
// (COPYFILE_EXCL·수정 시각 유지·디스크로 내리기) 크기와 수(1MB 미만은 바이트까지)를 확인한다. 하나라도 틀리면 이번에 만든 것만
// 지우고(깊은 것부터, 폴더는 비었을 때만) 이전 폴더는 건드리지 않는다. 이전 폴더를 휴지통으로 보내는 일(cleanup)은 부르는 쪽이
// 설정을 바꾼 뒤에 따로 부른다 — 설정을 못 바꿨는데 원본이 사라지면 안 된다.
//
// 도중에 앱이 꺼질 수 있다 (종료·업데이트·윈도우 종료·작업 관리자). 그래서
//   - 옮기기 전에 새 폴더에 일지(JOURNAL_FILE — 이전 폴더·항목 이름·바꿔 단 항목)를 먼저 쓰고, 부르는 쪽이 설정을 바꾼 뒤 finish 로 지운다.
//     다음에 같은 폴더를 고르면 plan 이 일지를 보고 «겹침»이 아니라 «이어서»로 본다: 바꿔 단 항목은 다 옮긴 것으로, 복사하다 만
//     조각은 지우고 다시 복사한다 (일지에 적힌 이름이고, 이전 폴더에 원본이 있고, Hibi 꼴일 때만 — 아니면 손대지 않고 거절한다).
//   - 계정 폴더를 먼저, 상태 파일·정리 기록을 맨 나중에 옮긴다 (메일함 안에서는 색인을 맨 나중에). 조각만 보고는 «다 받은 백업»처럼
//     보이지 않게 — 상태 파일은 «어디까지 받았나»를 말한다.
//   - 바꿔 달기 전에 부르는 쪽이 «옮기기 멈춤»을 설정에 남긴다 (hold.on). 바꿔 달기는 이전 폴더를 비우므로, 도중에 꺼지거나 되돌리지
//     못하면 이전 폴더가 갈린다 — 그동안 그 폴더에 쓰면 안 된다. 다 되돌리면 푼다 (hold.off).
//
// Electron·store 를 싣지 않는다 (node 로 시험한다). 휴지통·남은 공간·파일 함수는 부르는 쪽이 넘기거나 시험이 바꿔 끼운다.
// 일지만은 fs 로 바로 쓴다 — 시험이 바꿔 끼운 rename(EXDEV 흉내)이 일지까지 막지 않게.
// 사유 글에는 경로를 넣지 않는다 — 계정 폴더 이름에 메일 주소가 들어 있다. 오류 번호(code)만 붙인다.

const fs = require('fs');
const path = require('path');
const { STATE_FILE } = require('./mailbackup');
const { MOVED_FILE } = require('./mailtidy');
const { INDEX_FILE } = require('./mailindex');

const PROBE_FILE = '.hibi-쓰기확인';
/** 새 폴더에 두는 옮기기 일지 — 옮기기가 끝나 설정을 바꾼 뒤에 지운다 */
const JOURNAL_FILE = '.hibi-옮기는중.json';
/** Hibi 가 백업 폴더 맨 위에 쓰는 파일 */
const OWN_FILES = [
  STATE_FILE, `${STATE_FILE}.tmp`, `${STATE_FILE}.bak`, `${STATE_FILE}.broken`,
  MOVED_FILE, `${MOVED_FILE}.tmp`, PROBE_FILE
];
// src/mailbackup.js 의 UID_IN_NAME 과 같은 이름꼴 — 메일함 폴더 안의 저장한 메일
const MAIL_NAME = /^\d{8}_\d{4}_\d+(?:_.*)?\.eml$/;
// src/mailfill.js·mailbackup.js 가 받는 중에 두는 조각
const PART_NAME = /^~받는중-.*\.part$/;
// 탐색기가 두는 파일 — 사용자 것으로 치지 않는다
const JUNK = new Set(['desktop.ini', 'thumbs.db']);
const SMALL = 1024 * 1024;                 // 이보다 작은 파일은 바이트까지 견준다 (상태·기록 파일)
const MARGIN_MIN = 256 * 1024 ** 2;        // 복사할 때 남길 여유 — 크기의 2% 와 이것 중 큰 것
const LOOK_BOXES = 2000;                   // 설정에 없는 계정 폴더를 볼 때 들여다볼 메일함 폴더 수 상한 (넘으면 사용자 폴더로 본다)
// 되돌리기가 잠겼을 때(백신·탐색기 미리보기가 안의 파일을 잡음) 다시 해 보는 간격
const RETRY_MS = [100, 300, 1000, 2000];
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

const win = () => process.platform === 'win32';
const key = (x) => (win() ? String(x).toLowerCase() : String(x));
const full = (x) => key(path.resolve(String(x)));

/** child 가 parent 안인가 (같은 폴더는 아니다). 윈도우는 대소문자를 가리지 않는다. 드라이브 뿌리도 된다 */
function inside(child, parent) {
  const c = full(child);
  const p = full(parent);
  if (c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 사람이 읽는 크기 — 1.16GB · 5.0MB · 12KB */
function sizeText(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.round(n / 1024)}KB`;
}

/** 복사에 필요한 공간 — 크기 + 여유 */
function needBytes(bytes) {
  return bytes + Math.max(MARGIN_MIN, Math.round(bytes * 0.02));
}

async function defaultFree(dir) {
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const codeOf = (e) => (e && e.code) || 'ERR';
const junk = (n) => JUNK.has(String(n).toLowerCase());

/** 메일함 폴더 안의 Hibi 파일인가 — 색인(과 그 .tmp)·이름꼴 .eml(과 망가져 비켜 둔 .damaged)·받는 중 조각 */
function hibiBoxFile(n) {
  return n === INDEX_FILE || n === `${INDEX_FILE}.tmp` || MAIL_NAME.test(n.replace(/\.damaged$/, '')) || PART_NAME.test(n);
}

/** 메일함 폴더 꼴 — hibi: Hibi 파일만 있다 · empty: 비었다 · other: 하위 폴더나 다른 파일이 섞였다 */
async function boxShape(dir, io) {
  let list;
  try { list = await io.readdir(dir, { withFileTypes: true }); } catch { return 'other'; }
  let shape = 'empty';
  for (const e of list) {
    if (junk(e.name)) continue;
    if (e.isDirectory() || !hibiBoxFile(e.name)) return 'other';
    shape = 'hibi';
  }
  return shape;
}

/** 계정 폴더 꼴 — 맨 위에는 메일함 폴더만, 메일함 안에는 Hibi 파일만. hibi: 흔적이 있다 · empty: 빈 꼴 · other: 사용자 것이 섞였다 */
async function accountShape(dir, io) {
  let list;
  try { list = await io.readdir(dir, { withFileTypes: true }); } catch { return 'other'; }
  let shape = 'empty';
  let boxes = 0;
  for (const e of list) {
    if (junk(e.name)) continue;
    if (!e.isDirectory() || ++boxes > LOOK_BOXES) return 'other';
    const s = await boxShape(path.join(dir, e.name), io);
    if (s === 'other') return 'other';
    if (s === 'hibi') shape = 'hibi';
  }
  return shape;
}

/**
 * 맨 위 폴더 하나가 Hibi 계정 폴더인가 — 설정의 계정 이름이거나, Hibi 꼴이고 흔적이 있다.
 * 사용자 폴더 안에 Hibi 메일 몇 통을 복사해 둔 것(맨 위에 문서가 있거나 메일함에 메모가 섞인 것)은 사용자 것이다 — 옮기면
 * «그대로 둡니다»라고 한 파일이 말없이 자리를 옮기고 휴지통에도 들어간다
 */
async function isAccountDir(dir, name, known, io) {
  if (known.has(key(name))) return true;
  return (await accountShape(dir, io)) === 'hibi';
}

/** 폴더 안의 파일 수·크기. 바로가기 연결(심볼릭 링크·정션)이 있으면 던진다 — 복사가 링크 너머를 끌고 오면 안 된다 */
async function measure(dir, io) {
  let files = 0;
  let bytes = 0;
  for (const e of await io.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    const st = await io.lstat(f);
    if (st.isSymbolicLink()) throw Object.assign(new Error('link'), { code: 'ELINK' });
    if (st.isDirectory()) {
      const m = await measure(f, io);
      files += m.files;
      bytes += m.bytes;
    } else {
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

/** 일지 속 이름 — 맨 위 항목 이름 하나 (경로 조각·. ·.. 은 받지 않는다 — 이 이름으로 새 폴더의 조각을 지운다) */
const plainNames = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x && x !== '.' && x !== '..' && !/[\\/:]/.test(x));

/**
 * 새 폴더의 일지를 읽는다.
 * @returns null (없다) · { from, entries, renamed } · { bad: true } (있는데 못 읽거나 꼴이 틀리다)
 */
async function readJournal(to, io = fs.promises) {
  let raw;
  try {
    raw = await io.readFile(path.join(to, JOURNAL_FILE), 'utf8');
  } catch (e) {
    return codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR' ? null : { bad: true };
  }
  try {
    const j = JSON.parse(raw);
    const renamed = j && j.renamed === undefined ? [] : j && j.renamed;
    if (j && j.v === 1 && typeof j.from === 'string' && j.from && plainNames(j.entries) && plainNames(renamed)) {
      return { from: j.from, entries: j.entries, renamed };
    }
  } catch { /* 아래 */ }
  return { bad: true };
}

/** 일지를 쓴다 — 임시 파일에 쓰고 디스크로 내린 뒤 바꿔치기 (도중에 꺼져도 반쯤 쓴 일지가 남지 않게) */
async function writeJournal(pl, renamed) {
  const file = path.join(pl.to, JOURNAL_FILE);
  const tmp = `${file}.tmp`;
  const names = [...new Set([...(pl.journal || []), ...(pl.done || []), ...pl.entries.map((e) => e.name)])];
  const body = JSON.stringify({ v: 1, from: path.resolve(pl.from), entries: names, renamed: renamed.slice(), at: Date.now() });
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  await fs.promises.rename(tmp, file);
}

/** 일지를 지운다 (없으면 그만) — 지웠거나 없으면 true */
async function dropJournal(dir) {
  const file = path.join(dir, JOURNAL_FILE);
  await fs.promises.unlink(`${file}.tmp`).catch(() => {});
  try {
    await fs.promises.unlink(file);
    return true;
  } catch (e) {
    return codeOf(e) === 'ENOENT';
  }
}

async function exists(p, io) {
  try { await io.lstat(p); return true; } catch (e) { return codeOf(e) !== 'ENOENT'; }
}

/** 새 폴더에 남은 조각이 우리 꼴인가 — 링크가 아니고, 파일 항목은 파일, 계정 폴더는 Hibi 꼴(비어도 된다) */
async function looksOurs(p, dir, io) {
  let st;
  try { st = await io.lstat(p); } catch { return false; }
  if (st.isSymbolicLink()) return false;
  if (!dir) return st.isFile();
  return st.isDirectory() && (await accountShape(p, io)) !== 'other';
}

/** 조각 크기 (못 세면 0) — 지우고 다시 복사할 때 공간 계산에서 돌려받는다 */
async function sizeOf(p, dir, io) {
  try { return dir ? (await measure(p, io)).bytes : (await io.lstat(p)).size; } catch { return 0; }
}

/**
 * 무엇을 옮길지 센다. 아무것도 바꾸지 않는다.
 * @param from 이전 백업 폴더   @param to 새 폴더 (이미 있어야 한다 — 부르는 쪽이 쓰기 확인으로 만든다)
 * @param o.known     설정에 있는 계정의 폴더 이름들
 * @param o.freeBytes (dir) => 남은 바이트 — 기본은 statfs
 * @param o.sameVolume 같은 볼륨인가 — 주지 않으면 두 폴더의 장치 번호로 본다
 * @returns { from, to, entries: [{ name, dir, files, bytes }], unknown, files, bytes, sameVolume, need, collide, problem,
 *            resume, done, stale, partial, journal }
 *          problem 이 있으면 옮길 수 없다 (사람이 읽는 까닭). 이전 폴더가 없거나 못 읽으면 entries 가 빈다.
 *          resume: 새 폴더에 이 이전 폴더의 일지가 있다 — done 은 지난번에 바꿔 단 항목(새 폴더에 있다), stale 은 복사하다 만 조각
 *          (지우고 다시 복사한다). partial: 맞지 않는 조각이 있어 거절했다 — «새 폴더만 쓰기»도 내면 안 된다 (조각을 백업으로 쓰게 된다)
 */
async function plan(from, to, { known = [], freeBytes = defaultFree, sameVolume = null, io: given = {} } = {}) {
  const io = { ...fs.promises, ...given };
  const out = {
    from, to, entries: [], unknown: [], files: 0, bytes: 0, sameVolume: false, need: 0, collide: [], problem: null,
    resume: false, done: [], stale: [], partial: false, journal: []
  };
  // 새 폴더의 일지 — 지난번 옮기기가 끝나지 않았다 (꺼졌거나 되돌리지 못했거나 설정을 못 바꿨다)
  const j = await readJournal(to, io);
  if (j && (j.bad || full(j.from) !== full(from))) {
    out.partial = true;
    out.problem = '고른 폴더에 다른 곳에서 옮기다 멈춘 메일 백업 조각이 있어 쓸 수 없습니다 — 그 폴더를 비우거나 다른 폴더를 고르세요.';
    return out;
  }
  if (j) {
    out.resume = true;
    out.journal = j.entries.slice();
  }
  let list = [];
  try {
    if ((await io.stat(from)).isDirectory()) list = await io.readdir(from, { withFileTypes: true });
  } catch {
    list = [];
  }
  const knownSet = new Set((known || []).map(key));
  const own = new Set(OWN_FILES.map(key));
  try {
    for (const e of list) {
      const f = path.join(from, e.name);
      const st = await io.lstat(f);
      if (st.isSymbolicLink()) { out.unknown.push(e.name); continue; }
      if (st.isFile() && own.has(key(e.name))) {
        out.entries.push({ name: e.name, dir: false, files: 1, bytes: st.size });
      } else if (st.isDirectory() && await isAccountDir(f, e.name, knownSet, io)) {
        const m = await measure(f, io);
        out.entries.push({ name: e.name, dir: true, ...m });
      } else {
        out.unknown.push(e.name);
      }
    }
  } catch (e) {
    out.problem = codeOf(e) === 'ELINK'
      ? '이전 폴더의 백업에 바로가기 연결(링크)이 섞여 있어 옮길 수 없습니다.'
      : `이전 폴더의 일부를 읽지 못해 옮길 수 없습니다 (${codeOf(e)}).`;
    return out;
  }
  // 계정 폴더를 먼저, 상태 파일·정리 기록은 맨 나중 — 도중에 꺼져도 새 폴더의 조각이 «다 받은 백업»처럼 보이지 않게
  out.entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  for (const e of out.entries) {
    out.files += e.files;
    out.bytes += e.bytes;
  }

  // 지난번 조각 — 일지에 적힌 이름만 본다
  let staleBytes = 0;
  if (out.resume) {
    const inFrom = new Set(list.map((e) => key(e.name)));
    const byName = new Map(out.entries.map((e) => [key(e.name), e]));
    const renamed = new Set(j.renamed.map(key));
    for (const name of j.entries) {
      const there = path.join(to, name);
      if (!(await exists(there, io))) continue;
      const k = key(name);
      if (renamed.has(k) && !inFrom.has(k)) { out.done.push(name); continue; }
      const e = byName.get(k);
      if (!renamed.has(k) && e && await looksOurs(there, e.dir, io)) {
        out.stale.push(e.name);
        staleBytes += await sizeOf(there, e.dir, io);
        continue;
      }
      // 원본이 없는 조각(그것이 남은 사본일 수 있다)·꼴이 다른 것 — 손대지 않는다
      out.partial = true;
      out.problem = '고른 폴더에 지난번에 옮기다 멈춘 조각이 있는데 이전 폴더와 맞지 않아 옮길 수 없습니다 — 두 폴더를 확인하세요.';
      return out;
    }
  }
  if (!out.entries.length) return out;

  if (inside(to, from)) { out.problem = '새 폴더가 이전 폴더 안에 있어 옮길 수 없습니다.'; return out; }
  if (inside(from, to)) { out.problem = '이전 폴더가 새 폴더 안에 있어 옮길 수 없습니다.'; return out; }
  let there = [];
  try { there = await io.readdir(to); } catch (e) {
    out.problem = `새 폴더를 읽지 못해 옮길 수 없습니다 (${codeOf(e)}).`;
    return out;
  }
  const names = new Set(there.map(key));
  const ours = new Set(out.stale.map(key));
  out.collide = out.entries.filter((e) => names.has(key(e.name)) && !ours.has(key(e.name))).map((e) => e.name);
  if (out.collide.length) {
    out.problem = `고른 폴더에 이미 Hibi 메일 백업이 있어 옮길 수 없습니다 — 겹치는 항목 ${out.collide.length}개.`;
    return out;
  }
  if (typeof sameVolume === 'boolean') {
    out.sameVolume = sameVolume;
  } else {
    try { out.sameVolume = (await io.stat(from)).dev === (await io.stat(to)).dev; } catch { out.sameVolume = false; }
  }
  out.need = needBytes(out.bytes);
  if (!out.sameVolume) out.problem = await spaceProblem(to, out.need, freeBytes, staleBytes);
  return out;
}

/** 복사할 공간이 있나 — 없거나 모르면 까닭. back: 지우고 다시 복사할 조각의 크기 (지우면 돌아온다) */
async function spaceProblem(to, need, freeBytes, back = 0) {
  let free;
  try { free = Number(await freeBytes(to)); } catch { free = NaN; }
  if (!Number.isFinite(free)) return '새 폴더의 남은 공간을 알 수 없어 옮기지 않았습니다.';
  if (free + back < need) return `새 폴더의 드라이브에 공간이 모자랍니다 — ${sizeText(need)} 필요, ${sizeText(free + back)} 남음.`;
  return null;
}

/** 잠김(EBUSY·EPERM·EACCES)이면 잠깐씩 다시 해 본다 */
async function retry(fn, delays) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delays.length || !LOCKED.has(codeOf(e))) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

/** 새 폴더의 지난번 조각 하나를 지운다 — 깊은 것부터. 링크는 따라가지 않고 멈춘다 */
async function removeTree(p, io) {
  const st = await io.lstat(p);
  if (st.isSymbolicLink()) throw Object.assign(new Error('link'), { code: 'ELINK' });
  if (!st.isDirectory()) { await io.unlink(p); return; }
  for (const n of await io.readdir(p)) await removeTree(path.join(p, n), io);
  await io.rmdir(p);
}

/**
 * 옮긴다. 이전 폴더는 바꿔 달기일 때만 비고, 복사일 때는 그대로 둔다 (cleanup 이 휴지통으로 보낸다).
 * 새 폴더에 일지를 먼저 쓴다 — 성공해도 남는다. 부르는 쪽이 설정을 바꾼 뒤 finish 로 지운다.
 * @param o.onProgress ({ phase: 'rename'|'copy'|'verify', done, total, bytes, totalBytes }) — 던져도 옮기기는 이어 간다
 * @param o.io        fs.promises 의 함수를 바꿔 끼운다 (rename·copyFile·open·stat·…) — 시험이 실패를 흉내 낸다
 * @param o.freeBytes 바꿔 달기가 막혀 복사로 갈 때 공간을 다시 본다
 * @param o.retryMs   되돌리기가 잠겼을 때 다시 해 보는 간격
 * @param o.hold      { on: async () => 남겼나, off: async () => {} } — 바꿔 달기 전에 «옮기기 멈춤»을 남기고(남기지 못하면 옮기지 않는다),
 *                    다 되돌리면 푼다. 바꿔 단 채 끝나면(성공·split) 부르는 쪽이 푼다
 * @returns { ok, mode: 'rename'|'copy', files, bytes, error?, left?, split?, stuck? } — left 는 실패 뒤 새 폴더에서 못 지운 수,
 *          split 이면 stuck 에 새 폴더에 남은(되돌리지 못한) 항목 이름
 */
async function run(pl, { onProgress = () => {}, io: given = {}, freeBytes = defaultFree, retryMs = RETRY_MS, hold = null } = {}) {
  const io = { ...fs.promises, ...given };
  if (pl.problem) return { ok: false, mode: null, files: 0, bytes: 0, error: pl.problem };
  const done0 = pl.done || [];
  const stale = pl.stale || [];
  if (!pl.entries.length && !(pl.resume && done0.length)) return { ok: true, mode: 'rename', files: 0, bytes: 0 };
  // 새 폴더에 남는 우리 것 — 지난번에 바꿔 단 항목부터. 이것이 비면 실패 때 일지도 지운다
  const renamed = done0.slice();
  try {
    await writeJournal(pl, renamed);
  } catch (e) {
    return { ok: false, mode: null, files: 0, bytes: 0, error: `새 폴더에 옮기기 일지를 쓰지 못했습니다 (${codeOf(e)})` };
  }
  // 지난번에 복사하다 만 조각 — 지우고 다시 복사한다 (plan 이 일지·원본·꼴을 보고 골랐다)
  for (const name of stale) {
    try {
      await removeTree(path.join(pl.to, name), io);
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') {
        return { ok: false, mode: null, files: 0, bytes: 0, error: `지난번에 옮기다 남은 조각을 지우지 못했습니다 (${codeOf(e)})` };
      }
    }
  }
  if (!pl.entries.length) return { ok: true, mode: 'rename', files: 0, bytes: 0 };
  // 실패로 끝날 때 — 새 폴더에 우리 것이 하나도 남지 않았으면 일지도 지운다.
  // 바꿔 단 항목이 남았거나 복사 조각을 다 못 지웠으면 남긴다 (다음에 고를 때 알아보고 이어서·지우고)
  const quit = async (res) => {
    if (!res.ok && !renamed.length && !(res.left > 0)) await dropJournal(pl.to);
    return res;
  };
  const prog = { phase: '', done: 0, total: pl.files, bytes: 0, totalBytes: pl.bytes };
  const tell = (phase) => {
    prog.phase = phase;
    try { onProgress({ ...prog }); } catch { /* 화면 쪽 오류는 옮기기를 멈추지 않는다 */ }
  };
  const src = (e) => path.join(pl.from, e.name);
  const dst = (e) => path.join(pl.to, e.name);

  if (pl.sameVolume) {
    // 바꿔 달면 이전 폴더가 빈다 — 그 전에 «옮기기 멈춤»을 남긴다. 도중에 꺼지거나 되돌리지 못해도 다시 켤 때 그 폴더에 쓰지 않게
    let held = true;
    try { held = hold ? await hold.on() : true; } catch { held = false; }
    if (!held) return quit({ ok: false, mode: 'rename', files: 0, bytes: 0, error: '설정 파일을 저장하지 못해 옮기지 않았습니다' });
    const done = [];
    let failed = null;
    for (const e of pl.entries) {
      try {
        // 윈도우의 rename 은 같은 이름의 파일을 덮어쓴다 — 계획 뒤에 생긴 것이라도 덮지 않는다
        if (await exists(dst(e), io)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        await io.rename(src(e), dst(e));
      } catch (err) {
        failed = err;
        break;
      }
      done.push(e);
      renamed.push(e.name);
      // 못 적으면 다음 계획이 그 항목을 «원본 없는 조각»으로 보고 손대지 않는다 (거절) — 지우지는 않는다
      await writeJournal(pl, renamed).catch(() => {});
      prog.done += e.files;
      prog.bytes += e.bytes;
      tell('rename');
    }
    if (!failed) return { ok: true, mode: 'rename', files: prog.done, bytes: prog.bytes };
    // 되돌린다 — 바꿔 단 것을 거꾸로. 잠김은 잠깐씩 다시 해 보고, 하나가 끝내 안 돼도 나머지는 되돌린다
    const stuck = [];
    for (const e of done.reverse()) {
      try {
        await retry(() => io.rename(dst(e), src(e)), retryMs);
        renamed.splice(renamed.indexOf(e.name), 1);
      } catch (back) {
        stuck.push({ name: e.name, code: codeOf(back) });
      }
    }
    await writeJournal(pl, renamed).catch(() => {});
    if (stuck.length) {
      return {
        ok: false, mode: 'rename', files: 0, bytes: 0, split: true, stuck: stuck.map((s) => s.name),
        error: `옮기다 막혔고 ${stuck.length}개를 되돌리지 못했습니다 (${codeOf(failed)} · ${stuck[0].code}) — 일부가 새 폴더에 있습니다`
      };
    }
    // 이번에 바꿔 단 것은 다 되돌렸다 — 지난번에 바꿔 단 것도 없으면 이전 폴더는 온전하다. 멈춤을 푼다
    if (!renamed.length && hold) {
      try { await hold.off(); } catch { /* 못 풀면 다음에 고를 때 이어서 마친다 */ }
    }
    if (codeOf(failed) === 'EEXIST') return quit({ ok: false, mode: 'rename', files: 0, bytes: 0, error: '새 폴더에 같은 이름이 생겨 옮기지 않았습니다 (EEXIST)' });
    // 다른 볼륨이거나 바꿔 달기가 막혔다 (백신이 파일을 잡는 등) — 복사로. 그때 공간을 본다
    const space = await spaceProblem(pl.to, needBytes(pl.bytes), freeBytes);
    if (space) return quit({ ok: false, mode: 'copy', files: 0, bytes: 0, error: space });
    prog.done = 0;
    prog.bytes = 0;
  }
  return quit(await copyAll(pl, io, prog, tell));
}

/** 폴더 안 항목의 복사 차례 — 하위 폴더, 파일, 색인은 맨 나중 (색인이 «받았다»고 적은 메일이 조각에 없게) */
function copyRank(e) {
  if (e.isDirectory()) return 0;
  return e.name.startsWith(INDEX_FILE) ? 2 : 1;
}

/** 복사 길 — 만든 것을 적어 두고, 틀리면 그것만 지운다 */
async function copyAll(pl, io, prog, tell) {
  const madeFiles = [];
  const madeDirs = [];
  const copied = [];     // { from, to, size }
  const dirTimes = [];   // { to, atime, mtime } — 다 쓴 뒤 맞춘다 (파일을 넣으면 폴더 시각이 바뀐다)
  let stage = '복사하지';
  // 사본을 디스크로 내린다 — 확인은 OS 캐시에서 읽으므로 이것 없이는 «디스크에 있다»를 모른다. 곧 원본이 휴지통으로 간다.
  // 읽기 전용 원본은 사본도 읽기 전용이라 쓰기로 못 연다 — 잠깐 풀고 내린 뒤 되돌린다. 폴더는 윈도우에서 내릴 수 없어 그만둔다
  const syncFile = async (d, mode) => {
    let fh;
    let relaxed = false;
    try {
      fh = await io.open(d, 'r+');
    } catch (e) {
      if (!LOCKED.has(codeOf(e))) throw e;
      await io.chmod(d, (mode & 0o777) | 0o200);
      relaxed = true;
      fh = await io.open(d, 'r+');
    }
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (relaxed) await io.chmod(d, mode & 0o777);
  };
  const copyOne = async (s, d) => {
    const st = await io.stat(s);
    try {
      await io.copyFile(s, d, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      // 반쯤 쓴 사본은 우리 것이다. 이미 있던 것(EEXIST)은 남의 것이라 지우지 않는다
      if (codeOf(e) !== 'EEXIST') madeFiles.push(d);
      throw e;
    }
    madeFiles.push(d);
    await syncFile(d, st.mode);
    await io.utimes(d, st.atime, st.mtime);
    copied.push({ from: s, to: d, size: st.size });
    prog.done += 1;
    prog.bytes += st.size;
    tell('copy');
  };
  const copyTree = async (s, d) => {
    const st = await io.stat(s);
    await io.mkdir(d);
    madeDirs.push(d);
    dirTimes.push({ to: d, atime: st.atime, mtime: st.mtime });
    const list = await io.readdir(s, { withFileTypes: true });
    list.sort((a, b) => copyRank(a) - copyRank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      const from = path.join(s, e.name);
      const to = path.join(d, e.name);
      const ls = await io.lstat(from);
      if (ls.isSymbolicLink()) throw Object.assign(new Error('link'), { code: 'ELINK' });
      if (ls.isDirectory()) await copyTree(from, to);
      else await copyOne(from, to);
    }
  };
  try {
    for (const e of pl.entries) {
      const s = path.join(pl.from, e.name);
      const d = path.join(pl.to, e.name);
      if (e.dir) await copyTree(s, d);
      else await copyOne(s, d);
    }
    stage = '확인하지';
    tell('verify');
    for (const c of copied) {
      const st = await io.stat(c.to);
      if (st.size !== c.size) throw Object.assign(new Error('size'), { code: 'ESIZE' });
      if (c.size < SMALL) {
        const [a, b] = await Promise.all([io.readFile(c.from), io.readFile(c.to)]);
        if (!a.equals(b)) throw Object.assign(new Error('bytes'), { code: 'EBYTES' });
      }
    }
    if (copied.length !== pl.files) throw Object.assign(new Error('count'), { code: 'ECOUNT' });
    // 폴더 시각 — 깊은 것부터. 못 맞춰도 옮기기는 성공이다 (옛 파일 스캔이 한 번 더 돌 뿐)
    for (const t of dirTimes.slice().reverse()) {
      try { await io.utimes(t.to, t.atime, t.mtime); } catch { /* 그만이다 */ }
    }
    return { ok: true, mode: 'copy', files: copied.length, bytes: prog.bytes };
  } catch (e) {
    let left = 0;
    for (const f of madeFiles.reverse()) {
      try { await io.unlink(f); } catch (u) { if (codeOf(u) !== 'ENOENT') left += 1; }
    }
    for (const d of madeDirs.reverse()) {
      try { await io.rmdir(d); } catch (u) { if (codeOf(u) !== 'ENOENT') left += 1; }
    }
    const code = codeOf(e);
    const why = code === 'ESIZE' ? '사본의 크기가 원본과 다릅니다'
      : code === 'EBYTES' ? '사본의 내용이 원본과 다릅니다'
        : code === 'ECOUNT' ? '옮기는 동안 파일 수가 바뀌었습니다'
          : code === 'ELINK' ? '바로가기 연결(링크)이 섞여 있습니다'
            : code === 'EEXIST' ? '새 폴더에 같은 이름이 생겼습니다'
              : `파일을 ${stage} 못했습니다`;
    // 못 지운 것이 남으면(left) 부르는 쪽이 일지도 남긴다 — 다음에 고를 때 그 조각을 알아보고 지운다
    return { ok: false, mode: 'copy', files: 0, bytes: 0, left, error: `${why} (${code})` };
  }
}

/**
 * 옮기기를 마친다 — 새 폴더의 일지를 지운다. 부르는 쪽이 설정을 새 폴더로 바꾸고 저장한 뒤에 부른다.
 * @returns 지웠나 (없었어도 true)
 */
async function finish(pl) {
  return dropJournal(pl.to);
}

/**
 * 옮긴 뒤 — 복사했으면 이전 폴더의 그 항목들을 하나씩 휴지통으로 보낸다. 그다음 이전 폴더가 비었으면 지운다 (비었을 때만).
 * 부르는 쪽이 설정을 새 폴더로 바꾼 뒤에 부른다.
 * @param o.trash (path) => Promise — Electron shell.trashItem. 실패하면 그 항목은 그 자리에 둔다
 * @returns { trashFailed: [이름], removed }
 */
async function cleanup(pl, res, { trash, io: given = {} } = {}) {
  const io = { ...fs.promises, ...given };
  const trashFailed = [];
  if (res && res.ok && res.mode === 'copy') {
    for (const e of pl.entries) {
      try { await trash(path.join(pl.from, e.name)); } catch { trashFailed.push(e.name); }
    }
  }
  let removed = false;
  if (res && res.ok) {
    try { await io.rmdir(pl.from); removed = true; } catch { removed = false; }
  }
  return { trashFailed, removed };
}

module.exports = {
  PROBE_FILE, JOURNAL_FILE, OWN_FILES, INDEX_FILE, plan, run, finish, cleanup, readJournal, dropJournal, inside, sizeText, needBytes
};

'use strict';
// Windows 자격 증명 관리자 — 메일 비밀번호를 OS 가 지키는 곳에 둔다.
//
// 예전에는 Electron safeStorage(DPAPI)로 잠근 값을 설정 파일에 바로 적었다. 그런데 이 PC의 DPAPI 가
// «마스터 키를 가져올 수 없음»으로 깨지자, 잠근 값은 못 풀고 새로 잠그지도 못해 메일이 통째로 멈췄다.
// 자격 증명 관리자(CredWriteW/CredReadW)는 그때도 멀쩡했다 — gh 도 토큰을 거기 두고 읽는다.
//
// 여기서 정해 둔 것:
//   · 종류는 일반 자격 증명(CRED_TYPE_GENERIC), 이 PC에만 둔다(CRED_PERSIST_LOCAL_MACHINE).
//     ENTERPRISE 로 두면 로밍 프로필을 따라 다른 PC로 간다 — 비밀번호가 돌아다니면 안 된다.
//   · 사용자 이름 칸에는 비밀이 아닌 고정 이름('Hibi')을, 비밀번호 칸에는 UTF-8 바이트를 그대로 둔다.
//     자격 증명 관리자 화면에서 고치거나 cmdkey 로 넣은 값은 UTF-16LE 로 들어간다 — 읽을 때 가려 읽는다(text).
//   · 이름이 «Hibi/», «Hibi (개발)/», «Hibi-test/»로 시작하는 항목만 쓰고 읽고 지운다.
//     이 모듈이 gh·git 같은 남의 항목을 건드릴 길 자체를 막아 둔다.
//
// 던지지 않는다. 못 쓰는 곳(윈도우가 아니거나 koffi·advapi32 를 못 실음)이면 available 이 거짓이고,
// 실패는 false/null 로 돌려준다. 비밀번호는 어디에도 적지 않는다 — lastError 에는 오류 번호만 남긴다.

const TYPE_GENERIC = 1;             // CRED_TYPE_GENERIC
const PERSIST_LOCAL_MACHINE = 2;    // CRED_PERSIST_LOCAL_MACHINE — 로밍하지 않는다
/** CRED_MAX_CREDENTIAL_BLOB_SIZE (5 × 512 바이트) — 넘으면 윈도우가 받지 않는다 */
const MAX_BLOB = 5 * 512;
/** 사용자 이름 칸 — 비밀이 아니다. 자격 증명 관리자 화면에서 무엇의 항목인지 알아보게만 */
const USER = 'Hibi';
const ERROR_NOT_FOUND = 1168;

/** 이 모듈이 만질 수 있는 이름의 앞머리 */
const OURS = /^Hibi(?: \(개발\)|-test)?\//;
/** 이름에 두면 안 되는 것 — 찾기 무늬(*)와 제어 문자 */
const BAD = /[*\p{Cc}]/u;
/** 항목 이름 — 우리 앞머리 뒤에 무언가가 있고, BAD 는 없다 */
const ours = (target) => typeof target === 'string' && target.length <= 256
  && OURS.test(target) && target.replace(OURS, '').length > 0 && !BAD.test(target);

let api;            // undefined: 아직 안 봄 · null: 못 씀
let lastError = 0;  // 마지막 실패의 윈도우 오류 번호 (기록용 — 비밀은 없다)

function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    // 이름 없는 형으로 둔다 — koffi 의 형 이름은 프로세스 전체에서 하나라, 다른 모듈과 겹치면 싣기가 실패한다
    const FILETIME = koffi.struct({ low: 'uint32_t', high: 'uint32_t' });
    const CRED = koffi.struct({
      Flags: 'uint32_t',
      Type: 'uint32_t',
      TargetName: 'const char16_t *',
      Comment: 'const char16_t *',
      LastWritten: FILETIME,
      CredentialBlobSize: 'uint32_t',
      CredentialBlob: 'void *',
      Persist: 'uint32_t',
      AttributeCount: 'uint32_t',
      Attributes: 'void *',
      TargetAlias: 'const char16_t *',
      UserName: 'const char16_t *'
    });
    const str16 = 'const char16_t *';
    api = {
      koffi,
      CRED,
      write: advapi32.func('__stdcall', 'CredWriteW', 'int', [koffi.pointer(CRED), 'uint32_t']),
      read: advapi32.func('__stdcall', 'CredReadW', 'int',
        [str16, 'uint32_t', 'uint32_t', koffi.out(koffi.pointer('void *'))]),
      del: advapi32.func('__stdcall', 'CredDeleteW', 'int', [str16, 'uint32_t', 'uint32_t']),
      enumerate: advapi32.func('__stdcall', 'CredEnumerateW', 'int',
        [str16, 'uint32_t', koffi.out(koffi.pointer('uint32_t')), koffi.out(koffi.pointer('void *'))]),
      free: advapi32.func('__stdcall', 'CredFree', 'void', ['void *']),
      lastError: kernel32.func('__stdcall', 'GetLastError', 'uint32_t', [])
    };
  } catch (e) {
    console.warn('[credstore] 자격 증명 관리자를 쓸 수 없습니다:', e.message);
    api = null;
  }
  return api;
}

/** 실패한 호출 바로 뒤에 오류 번호를 떠 둔다 */
function note(a) {
  try { lastError = a.lastError() >>> 0; } catch { lastError = -1; }
}

/**
 * 비밀번호를 쓴다 (있으면 덮어쓴다).
 * @returns 됐으면 true. 빈 값·2560바이트 넘는 값·깨진 글자(짝 없는 서로게이트)·NUL 은 받지 않는다.
 */
function write(target, plain) {
  lastError = 0;
  const a = load();
  if (!a || !ours(target) || typeof plain !== 'string' || !plain) return false;
  // 짝 없는 서로게이트는 UTF-8 로 바꾸면서 �로 바뀐다 — 저장은 되는데 다른 비밀번호가 된다
  if (typeof plain.isWellFormed === 'function' && !plain.isWellFormed()) return false;
  // NUL 은 비밀번호에 올 수 없다. 받지 않아야 «0 바이트가 있으면 우리가 쓴 것이 아니다»가 선다 (text)
  if (plain.includes('\0')) return false;
  const blob = Buffer.from(plain, 'utf8');
  try {
    if (blob.length > MAX_BLOB) return false;
    const ok = a.write({
      Flags: 0,
      Type: TYPE_GENERIC,
      TargetName: target,
      Comment: null,
      LastWritten: { low: 0, high: 0 },
      CredentialBlobSize: blob.length,
      CredentialBlob: blob,
      Persist: PERSIST_LOCAL_MACHINE,
      AttributeCount: 0,
      Attributes: null,
      TargetAlias: null,
      UserName: USER
    }, 0);
    if (!ok) note(a);
    return !!ok;
  } catch {
    return false;
  } finally {
    blob.fill(0);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16 = new TextDecoder('utf-16le', { fatal: true });

/**
 * 비밀번호 칸의 바이트 → 글자 (못 읽으면 null).
 * 우리는 UTF-8 로 쓰고 NUL 은 받지 않는다(write) — 0 바이트가 있으면 우리가 쓴 것이 아니다.
 * 자격 증명 관리자 화면의 «편집»이나 cmdkey 는 UTF-16LE 로 넣는데, 그걸 UTF-8 로 읽으면 'a\0b\0…'이 되어
 * «풀렸다»고 여긴 채 로그인에서 틀린다 (계정이 «비밀번호 다시 필요»로 나오지도 않는다).
 * 그래서 짝수 길이면 UTF-16LE 로 읽고, 아니면 못 읽은 것으로 친다. 읽은 글자에 NUL 이 있어도 못 읽은 것이다.
 */
function text(bytes) {
  const s = bytes.includes(0) ? (bytes.length % 2 === 0 ? utf16.decode(bytes) : null) : utf8.decode(bytes);
  return s && !s.includes('\0') ? s : null;
}

/**
 * 비밀번호를 읽는다. 없거나(ERROR_NOT_FOUND) 못 읽으면 null — 던지지 않는다.
 * 윈도우가 준 사본과 옮겨 담은 바이트는 글자로 바꾼 뒤 0 으로 덮고 돌려준다.
 */
function read(target) {
  lastError = 0;
  const a = load();
  if (!a || !ours(target)) return null;
  const out = [null];
  try {
    if (!a.read(target, TYPE_GENERIC, 0, out)) { note(a); return null; }
  } catch {
    return null;
  }
  const p = out[0];
  if (!p) return null;
  let bytes = null;
  try {
    const c = a.koffi.decode(p, a.CRED);
    const n = c.CredentialBlobSize >>> 0;
    if (c.Type !== TYPE_GENERIC || !n || n > MAX_BLOB || !c.CredentialBlob) return null;
    // decode 는 사본을 준다 (Electron 은 바깥 메모리를 바로 보는 view 를 막는다)
    bytes = a.koffi.decode(c.CredentialBlob, 'uint8_t', n);
    try { a.koffi.encode(c.CredentialBlob, 'uint8_t', new Uint8Array(n), n); } catch { /* 지우기는 할 수 있는 만큼만 */ }
    return text(bytes);
  } catch {
    return null;
  } finally {
    if (bytes && typeof bytes.fill === 'function') bytes.fill(0);
    try { a.free(p); } catch { /* 무시 */ }
  }
}

/** 지운다. 지웠으면 true — 원래 없었으면(ERROR_NOT_FOUND) false 이고 lastError 가 1168 이다 */
function remove(target) {
  lastError = 0;
  const a = load();
  if (!a || !ours(target)) return false;
  try {
    const ok = a.del(target, TYPE_GENERIC, 0);
    if (!ok) note(a);
    return !!ok;
  } catch {
    return false;
  }
}

/**
 * 이름이 prefix 로 시작하는 우리 항목들의 이름 — 비밀번호는 읽지 않는다 (정리·시험 확인용).
 * prefix 도 우리 앞머리로 시작해야 한다 («Hibi-test/» 처럼).
 */
function list(prefix) {
  lastError = 0;
  const a = load();
  if (!a || typeof prefix !== 'string' || !OURS.test(prefix) || BAD.test(prefix)) return [];
  const count = [0];
  const out = [null];
  try {
    if (!a.enumerate(`${prefix}*`, 0, count, out)) { note(a); return []; }
  } catch {
    return [];
  }
  try {
    const n = count[0] >>> 0;
    if (!n || !out[0]) return [];
    const ptrs = a.koffi.decode(out[0], 'void *', n);
    return Array.from(ptrs, (p) => a.koffi.decode(p, a.CRED))
      .filter((c) => c.Type === TYPE_GENERIC && typeof c.TargetName === 'string' && c.TargetName.startsWith(prefix))
      .map((c) => c.TargetName);
  } catch {
    return [];
  } finally {
    try { a.free(out[0]); } catch { /* 무시 */ }
  }
}

module.exports = {
  /** 이 PC에서 자격 증명 관리자를 부를 수 있나 (처음 물을 때 한 번 싣고 기억한다) */
  get available() { return !!load(); },
  /** 마지막 실패의 윈도우 오류 번호 — 성공했거나 아직 안 불렀으면 0 */
  get lastError() { return lastError; },
  MAX_BLOB,
  ERROR_NOT_FOUND,
  write,
  read,
  remove,
  list
};

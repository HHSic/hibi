'use strict';
// 메일 백업 폴더의 기본 자리 — 아직 폴더를 고르지 않은 사람에게 줄 후보를 먼저 쓸 곳부터 고른다.
//
// 메일은 몇 년치가 쌓이면 몇 GB 다. 시스템 드라이브(C:)를 채우면 윈도우가 멎는다 — 그래서 쓸 만한 D: 가 있으면 거기를 먼저 쓴다.
// «쓸 만한»은 좁게 본다: 이 PC에 붙은 고정 드라이브, 시스템 드라이브가 아님, NTFS·ReFS, 2GB 넘게 남음, 클라우드 동기화 뿌리가 아님.
// Google Drive 는 G: 를 «고정»·FAT32 로 붙인다 — 파일 시스템으로 걸러진다. USB·네트워크·CD·RAM 디스크는 종류로 걸러진다.
//
// 드라이브 살피기(probe)는 koffi 로 kernel32 의 GetDriveTypeW·GetVolumeInformationW 를 부른다. 던지지 않는다 — 못 보면 null 이고
// 그러면 D: 후보만 빠진다. 시험은 api·statfs 를 바꿔 끼운다 (진짜 D: 를 부르지 않게).
// Electron·store 를 싣지 않는다 — node 로 시험한다.

const path = require('path');
const fs = require('fs');

const FILL_MAIL_DIR = 'Hibi 메일';
const DRIVE_FIXED = 3;                 // GetDriveTypeW — 이 PC에 붙은 고정 디스크
const MIN_FREE = 2 * 1024 ** 3;        // D: 를 기본 자리로 고르는 바닥
const GOOD_FS = ['NTFS', 'REFS'];
const ONEDRIVE_ENV = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];
// 클라우드 동기화 뿌리를 알리는 환경 변수 — OneDrive 셋과 Google Drive 이름꼴
const CLOUD_ENV = /^(onedrive\w*|google_?drive\w*)$/i;
const FS_NAME_LEN = 64;                // 파일 시스템 이름 칸 (글자 수) — MAX_PATH+1 이 권장이지만 이름은 짧다

const norm = (x) => path.resolve(String(x)).toLowerCase();
/** p 가 root 와 같거나 그 안인가 — 대소문자를 가리지 않는다. 드라이브 뿌리(D:\)도 된다 */
function within(p, root) {
  const full = norm(p);
  const r = norm(root);
  return full === r || full.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 그 경로가 OneDrive 안인가 — 대소문자를 가리지 않는다. «OneDriveBackup» 같은 옆 폴더는 안이 아니다 */
function underOneDrive(p, env) {
  return ONEDRIVE_ENV.some((k) => !!env && !!env[k] && within(p, env[k]));
}

/** 그 경로가 클라우드 동기화 뿌리(OneDrive·Google Drive 환경 변수) 안인가. 빈 값은 무시한다 */
function underCloud(p, env) {
  return Object.entries(env || {}).some(([k, v]) => CLOUD_ENV.test(k) && typeof v === 'string' && v.trim() !== '' && within(p, v));
}

let api;   // undefined: 아직 안 봄 · null: 못 씀
/** kernel32 의 두 함수 — 이름 없는 형만 쓴다 (koffi 의 형 이름은 프로세스 전체에서 하나라 다른 모듈과 겹치면 싣기가 실패한다) */
function loadApi() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      driveType: kernel32.func('__stdcall', 'GetDriveTypeW', 'uint32_t', ['const char16_t *']),
      // 볼륨 이름·일련번호·최대 길이·플래그는 받지 않는다 (null) — 파일 시스템 이름만 버퍼로 받는다
      volumeInfo: kernel32.func('__stdcall', 'GetVolumeInformationW', 'int',
        ['const char16_t *', 'void *', 'uint32_t', 'void *', 'void *', 'void *', 'void *', 'uint32_t'])
    };
  } catch {
    api = null;
  }
  return api;
}

/**
 * 드라이브 하나를 살핀다 — { root, type, fs, free } (못 보면 null). 던지지 않는다.
 * 고정 드라이브가 아니면 볼륨 정보·공간을 읽지 않는다 — 빈 카드 리더·CD 를 건드리면 «디스크 없음» 창이 뜰 수 있다.
 * @param letter 드라이브 글자 하나 ('D')
 * @param o.api    { driveType, volumeInfo } — 시험이 바꿔 끼운다. 주지 않으면 진짜 kernel32
 * @param o.statfs (root) => { bavail, bsize } — 기본 fs.statfsSync
 */
function probe(letter, { api: given, statfs = fs.statfsSync } = {}) {
  try {
    if (!/^[A-Za-z]$/.test(String(letter || ''))) return null;
    const k = given === undefined ? loadApi() : given;
    if (!k) return null;
    const root = `${String(letter).toUpperCase()}:\\`;
    const type = Number(k.driveType(root));
    if (type !== DRIVE_FIXED) return { root, type, fs: '', free: 0 };
    const buf = Buffer.alloc((FS_NAME_LEN + 1) * 2);
    const got = k.volumeInfo(root, null, 0, null, null, null, buf, FS_NAME_LEN + 1);
    const name = got ? buf.toString('utf16le').split('\0')[0] : '';
    const s = statfs(root);
    return { root, type, fs: name, free: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/** 살핀 드라이브를 기본 자리로 쓸 수 있나 — 고정·시스템 드라이브 아님·NTFS/ReFS·2GB 이상. 시스템 드라이브를 모르면 쓰지 않는다 */
function usable(info, env) {
  if (!info || typeof info !== 'object' || !/^[A-Za-z]:\\$/.test(String(info.root || ''))) return false;
  const sys = String((env && env.SystemDrive) || '').trim().toUpperCase();
  if (!/^[A-Z]:$/.test(sys) || info.root.slice(0, 2).toUpperCase() === sys) return false;
  return info.type === DRIVE_FIXED
    && GOOD_FS.includes(String(info.fs || '').toUpperCase())
    && Number.isFinite(Number(info.free)) && Number(info.free) >= MIN_FREE;
}

/**
 * 기본 폴더 후보, 먼저 쓸 곳부터. 개발·시험 실행은 userData 만 쓴다 — npm test 가 진짜 홈·D: 에 폴더를 만들면 안 된다.
 * 쓸 만한 D: 가 있으면 맨 앞에 D:\Hibi 메일. 그다음 홈, 문서(OneDrive 안이면 건너뛴다 — 묻지 않고 메일을 클라우드에 올리게 된다), userData.
 * userData 는 제거 때 지우지 않는다 (package.json nsis.deleteAppDataOnUninstall)
 * @param dataDrive 살핀 결과({ root, type, fs, free }) 또는 살피는 함수 — 함수는 패키지 실행에서만 부른다. 던지면 D: 만 빠진다
 */
function defaultDirs({ home, docs, userData, env, packaged, dataDrive }) {
  const out = [];
  if (packaged && dataDrive) {
    let info = null;
    try { info = typeof dataDrive === 'function' ? dataDrive() : dataDrive; } catch { info = null; }
    if (usable(info, env)) {
      const d = path.join(info.root, FILL_MAIL_DIR);
      if (!underCloud(d, env)) out.push(d);
    }
  }
  if (packaged && home) out.push(path.join(home, FILL_MAIL_DIR));
  if (packaged && docs && !underOneDrive(docs, env)) out.push(path.join(docs, FILL_MAIL_DIR));
  out.push(path.join(userData, 'mail'));
  return out;
}

module.exports = { FILL_MAIL_DIR, DRIVE_FIXED, MIN_FREE, defaultDirs, underOneDrive, underCloud, usable, probe, loadApi };

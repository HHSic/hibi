'use strict';
/**
 * 비밀번호 저장.
 *
 * 메일 비밀번호를 설정 파일에 평문으로 두면, 그 파일을 복사해 간 사람이 그대로 쓴다.
 * Electron safeStorage는 Windows에서 DPAPI를 쓰므로 그 PC의 그 사용자만 풀 수 있다.
 * 다른 PC로 파일을 옮기면 복호화가 실패한다 — 그게 의도한 동작이다.
 *
 * safeStorage를 못 쓰는 환경이면 저장하지 않는다. 평문으로 대신 저장하지는 않는다.
 */
const { safeStorage } = require('electron');

module.exports = {
  get available() {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  },

  /** 평문 → 저장용 문자열 (실패하면 null) */
  seal(plain) {
    if (!plain || !this.available) return null;
    try { return safeStorage.encryptString(String(plain)).toString('base64'); } catch { return null; }
  },

  /** 저장용 문자열 → 평문 (실패하면 null) */
  open(sealed) {
    if (!sealed || !this.available) return null;
    try { return safeStorage.decryptString(Buffer.from(String(sealed), 'base64')); } catch { return null; }
  }
};

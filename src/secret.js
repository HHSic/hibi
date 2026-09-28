'use strict';
/**
 * 비밀번호 저장.
 *
 * 메일 비밀번호를 설정 파일에 평문으로 두면, 그 파일을 복사해 간 사람이 그대로 쓴다.
 *
 * 비밀번호는 Windows 자격 증명 관리자에 둔다 (credstore.js). 그 PC의 그 사용자만 꺼낼 수 있고,
 * 이 PC에만 둔다(로밍하지 않는다). 설정 파일에는 «어디에 뒀나»만 적는다 —
 * 'wincred:Hibi/mail/<계정 id>' 꼴이고, 비밀은 들어 있지 않다.
 *
 * 0.9.66까지는 Electron safeStorage(DPAPI)로 잠근 값을 설정 파일에 바로 적었다(«옛 값»). 그런데 DPAPI 가
 * 깨진 PC(«마스터 키를 가져올 수 없음»)에서는 잠근 값을 못 풀고 새로 잠그지도 못해 메일이 통째로 멈췄다.
 * 옛 값도 여전히 풀어 본다 — 풀리면 mailhub 가 자격 증명 관리자로 옮겨 적는다.
 * 자격 증명 관리자를 못 쓰는 곳(윈도우가 아닌 개발 PC 등)에서는 예전처럼 safeStorage 로 잠근다.
 *
 * 둘 다 못 쓰면 저장하지 않는다. 평문으로 대신 저장하지는 않는다.
 */
const { app, safeStorage } = require('electron');
const credstore = require('./credstore');

/** 설정 파일에 적는 «자격 증명 관리자에 뒀다»는 표시 */
const REF = 'wincred:';
/** 계정 id 꼴 — 항목 이름에 그대로 들어간다 */
const KEY = /^[\w.-]{1,64}$/;
/** 시험이 쓰는 이름 앞머리 — 이 꼴이 아니면 HIBI_CRED_NS 를 받지 않는다 */
const TEST_NS = /^Hibi-test\/[\w.-]{1,64}$/;
/** 개발 실행의 이름 앞머리 */
const DEV_NS = 'Hibi (개발)';

/**
 * 자격 증명 관리자 안의 이름 앞머리. 설치본은 'Hibi', 개발 실행은 'Hibi (개발)' —
 * 개발 실행이 설치본의 비밀번호를 덮어쓰거나 지우지 않게 한다 (설정 폴더를 따로 쓰는 것과 같은 까닭).
 * 시험은 HIBI_CRED_NS 로 'Hibi-test/<임의>' 아래에만 쓴다. 이 변수는 개발 실행에서만 받는다 —
 * 설치본이 그 변수가 남은 셸에서 켜지면 저장된 계정이 모두 잠긴 것처럼 보이고,
 * 거기서 다시 넣은 진짜 비밀번호가 'Hibi-test/' 아래에 들어가 시험 뒷정리에 지워진다.
 */
function namespace() {
  if (app && app.isPackaged) return 'Hibi';
  const env = String(process.env.HIBI_CRED_NS || '').trim();
  return TEST_NS.test(env) ? env : DEV_NS;
}

/** 마지막 실패의 윈도우 오류 번호 (기록용 — 비밀은 없다). 되돌리기 같은 뒷일이 덮어쓰지 않게 따로 든다 */
let lastError = 0;

const isRef = (sealed) => typeof sealed === 'string' && sealed.startsWith(REF);
/**
 * 이 실행이 맡은 항목인가. 설정 파일이 남의 항목(gh·git 등)을 가리켜도 꺼내거나 지우지 않는다 —
 * 꺼낸 값은 설정 파일에 적힌 서버로 보내지기 때문이다.
 */
function mine(target) {
  const head = `${namespace()}/mail/`;
  return target.length > head.length && target.startsWith(head);
}

/** 옛 방식 — Electron safeStorage(DPAPI). 시험이 갈아 끼울 수 있게 내보낸다 */
const legacy = {
  get available() {
    try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; }
  },
  /** 평문 → 설정 파일에 적을 값 (실패하면 null) */
  seal(plain) {
    if (!plain || !this.available) return null;
    try { return safeStorage.encryptString(String(plain)).toString('base64'); } catch { return null; }
  },
  /** 설정 파일의 값 → 평문 (실패하면 null) */
  open(sealed) {
    if (!sealed || !this.available) return null;
    try { return safeStorage.decryptString(Buffer.from(String(sealed), 'base64')); } catch { return null; }
  }
};

module.exports = {
  /** 이 PC에서 비밀번호를 잠가 둘 곳이 있나 — 자격 증명 관리자나 safeStorage 중 하나라도 */
  get available() { return credstore.available || this.legacy.available; },
  /** 자격 증명 관리자를 쓸 수 있나 (옛 값을 옮길 수 있나) */
  get wincred() { return credstore.available; },
  /** 자격 증명 관리자 안의 이름 앞머리 */
  get namespace() { return namespace(); },
  /** 자격 증명 관리자의 마지막 오류 번호 (기록용) */
  get lastError() { return lastError; },
  legacy,
  isRef,
  /** 옛 값(safeStorage 로 잠가 설정 파일에 적은 것)인가 — 자격 증명 관리자로 옮길 거리 */
  isLegacy(sealed) { return typeof sealed === 'string' && !!sealed && !isRef(sealed); },
  /** 'wincred:' 값이 가리키는 항목 이름 (아니면 '') — 시험·기록용, 비밀이 아니다 */
  targetOf(sealed) { return isRef(sealed) ? sealed.slice(REF.length) : ''; },

  /**
   * 평문 → 설정 파일에 적을 값 (실패하면 null).
   * key 는 계정 id — 자격 증명 관리자 안의 이름이 된다. 같은 key 로 다시 잠그면 덮어쓴다.
   * 자격 증명 관리자에 못 쓰면 safeStorage 로 잠근 옛 값을 준다 (그것도 안 되면 null).
   */
  seal(plain, key) {
    if (!plain) return null;
    if (credstore.available) {
      const ref = this.sealRef(plain, key);
      if (ref) return ref;
    }
    return this.legacy.seal(plain);
  },

  /**
   * 자격 증명 관리자에만 잠근다 — 옛 값을 옮길 때. 못 하면 null.
   * 못 했을 때는 해 보기 전 모습으로 돌려 둔다. 이름이 계정 id 로 정해져 있어 같은 항목을 덮어쓰므로,
   * 쓰고 나서 확인에 실패한 채 두면 «저장된 값은 그대로»라던 계정이 시험하지 않은 새 값을 쓰게 되고,
   * 새 계정이면 가리키는 계정 없는 비밀번호가 남는다.
   */
  sealRef(plain, key) {
    lastError = 0;
    if (!plain || typeof plain !== 'string' || !credstore.available || !KEY.test(String(key || ''))) return null;
    const target = `${namespace()}/mail/${key}`;
    // 덮어쓰기 전에 지금 값을 떠 둔다 — 없으면(ERROR_NOT_FOUND) 되돌릴 때 지운다
    const before = credstore.read(target);
    const absent = before === null && credstore.lastError === credstore.ERROR_NOT_FOUND;
    if (!credstore.write(target, plain)) {
      lastError = credstore.lastError;
      return null;   // 못 썼으면 바뀐 것이 없다
    }
    // 읽어 봐서 같아야 «저장했다» — 썼다는데 못 꺼내면 다음 실행에서 또 잠긴다
    if (credstore.read(target) === plain) return REF + target;
    lastError = credstore.lastError;
    // 없던 항목이면 지우고, 있던 값은 되돌린다. 있었는데 못 읽던 값이면 되돌릴 것이 없어 그대로 둔다
    if (before !== null) credstore.write(target, before);
    else if (absent) credstore.remove(target);
    return null;
  },

  /** 설정 파일의 값 → 평문 (실패하면 null — 자격 증명 관리자에서 항목이 지워졌어도 null) */
  open(sealed) {
    if (!sealed) return null;
    if (isRef(sealed)) {
      const target = sealed.slice(REF.length);
      if (!mine(target)) return null;
      const plain = credstore.read(target);
      lastError = credstore.lastError;
      return plain;
    }
    return this.legacy.open(sealed);
  },

  /**
   * 자격 증명 관리자의 항목을 지운다 (계정을 지울 때). 옛 값은 설정 파일에만 있으니 할 일이 없다.
   * @returns 이제 항목이 없으면 true — 원래 없었어도 true
   */
  remove(sealed) {
    lastError = 0;
    if (!isRef(sealed)) return false;
    const target = sealed.slice(REF.length);
    if (!mine(target)) return false;
    if (credstore.remove(target) || credstore.lastError === credstore.ERROR_NOT_FOUND) return true;
    lastError = credstore.lastError;
    return false;
  },

  /**
   * 이 실행에서 주인 없는 항목을 치워도 되나. 개발 실행의 기본 앞머리('Hibi (개발)')에서는 안 된다 —
   * 임시 설정 폴더로 도는 창 시험들도 같은 앞머리를 써서, 거기서 «설정에 없는 항목»을 치우면
   * 개발용 설정에 있는 계정의 비밀번호까지 지운다.
   */
  get sweepable() { return credstore.available && namespace() !== DEV_NS; },

  /**
   * 설정의 어느 계정도 가리키지 않는 항목을 지운다 — 계정을 추가하다 앱이 죽었거나,
   * 설정 저장이 실패해 비밀번호만 남은 것. keep 은 설정(메모리·파일)에 적힌 잠긴 값들.
   * @returns 지운 개수 (치우지 않았으면 null)
   */
  sweep(keep) {
    if (!this.sweepable) return null;
    const want = new Set((keep || []).filter(isRef).map((s) => s.slice(REF.length)));
    let n = 0;
    for (const target of credstore.list(`${namespace()}/mail/`)) {
      if (mine(target) && !want.has(target) && credstore.remove(target)) n++;
    }
    return n;
  }
};

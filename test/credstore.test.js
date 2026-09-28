'use strict';
// Windows 자격 증명 관리자 — 창을 하나도 안 띄우고 src/credstore.js 만 부른다 (node 로도, npx electron 으로도 돈다).
//
// 이 PC의 DPAPI 가 깨져(«마스터 키를 가져올 수 없음») safeStorage 로 잠근 메일 비밀번호를 못 풀게 됐다.
// 이제 비밀번호는 자격 증명 관리자에 둔다. 여기서는 진짜 자격 증명 관리자에 쓰고 읽고 지워 본다.
//
// 지키는 것 — 진짜 자격 증명 관리자를 만지므로:
//   · 'Hibi-test/<임의>/' 아래에만, 시험용 값만 쓴다. 남의 항목(gh·git·진짜 'Hibi/')은 읽지도 지우지도 않는다
//   · 끝나면(실패해도) 쓴 것을 다 지우고, 'Hibi-test/' 아래에 남은 것이 없는지 다시 본다
//   · 비밀번호는 화면에 찍지 않는다 — 맞았나·틀렸나만
//
//   [1] 쓰고 읽기 · 덮어쓰기 · 지우기
//   [2] 여러 나라 글자 · 긴 비밀번호 · 2560바이트 한도 · NUL
//   [2-2] 자격 증명 관리자 화면·cmdkey 로 넣은 값(UTF-16LE)을 UTF-8 로 잘못 읽지 않는다
//   [3] 없는 항목 — 읽으면 null, 지우면 false (ERROR_NOT_FOUND)
//   [4] 우리 이름이 아닌 것은 부르지도 않는다
//   [5] 이 PC에만 둔다(로밍 안 함) · 사용자 이름 칸은 비밀이 아니다
//   [6] 치우기 — 남은 'Hibi-test' 항목이 없다
const path = require('path');
const crypto = require('crypto');
const cred = require(path.join(__dirname, '..', 'src', 'credstore.js'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const NS = `Hibi-test/${crypto.randomBytes(6).toString('hex')}`;
const T = (name) => `${NS}/${name}`;
const written = new Set();
const put = (name, value) => { written.add(T(name)); return cred.write(T(name), value); };

function main() {
  if (process.platform !== 'win32') {
    ok(!cred.available, '윈도우가 아니면 쓸 수 없다고 말한다');
    ok(cred.write(T('x'), 'dummy') === false && cred.read(T('x')) === null && cred.remove(T('x')) === false,
      '못 쓰는 곳에서도 던지지 않는다');
    return;
  }
  ok(cred.available, '자격 증명 관리자를 부를 수 있다 (시험 전제)');
  if (!cred.available) return;
  console.log(`   (이름 앞머리 ${NS})`);

  console.log('\n[1] 쓰고 읽기 · 덮어쓰기 · 지우기');
  ok(put('a', 'dummy-pass-1') === true, '쓴다');
  ok(cred.read(T('a')) === 'dummy-pass-1', '같은 값으로 읽힌다');
  ok(put('a', 'dummy-pass-2') === true && cred.read(T('a')) === 'dummy-pass-2', '같은 이름에 다시 쓰면 덮어쓴다');
  ok(put('b', 'dummy-other') === true && cred.read(T('a')) === 'dummy-pass-2' && cred.read(T('b')) === 'dummy-other',
    '이름이 다르면 따로 둔다');
  const names = cred.list(`${NS}/`).sort();
  ok(JSON.stringify(names) === JSON.stringify([T('a'), T('b')]), 'list — 우리 앞머리 아래 이름만, 값 없이', names.map((n) => n.slice(NS.length)));
  ok(cred.remove(T('a')) === true && cred.lastError === 0, '지운다');
  ok(cred.read(T('a')) === null, '지운 것은 null');
  ok(cred.read(T('b')) === 'dummy-other', '다른 항목은 그대로');

  console.log('\n[2] 여러 나라 글자 · 긴 비밀번호 · 2560바이트 한도');
  for (const [name, v] of [
    ['ko', '한글-비밀번호-테스트'],
    ['mix', 'Pässwörd-日本語-😀-ÆØÅ-́e'],
    ['space', '  앞뒤 빈칸도 그대로  '],
    ['sym', `!@#$%^&*()_+-=[]{}|;':",./<>?\`~\\`]
  ]) {
    ok(put(name, v) === true && cred.read(T(name)) === v, `그대로 돌아온다 — ${name}`);
  }
  ok(cred.MAX_BLOB === 2560, '한도는 2560바이트 (CRED_MAX_CREDENTIAL_BLOB_SIZE)');
  const max = 'x'.repeat(2560);
  ok(put('max', max) === true && cred.read(T('max')) === max, '딱 2560바이트는 된다');
  ok(put('over', 'x'.repeat(2561)) === false && cred.read(T('over')) === null, '2561바이트는 받지 않는다 (쓰지도 않는다)');
  const ko853 = '가'.repeat(853);   // 2559바이트
  ok(put('ko853', ko853) === true && cred.read(T('ko853')) === ko853, '한글 853자(2559바이트)는 된다');
  ok(put('ko854', '가'.repeat(854)) === false, '한글 854자(2562바이트) — 글자 수가 아니라 바이트로 잰다');
  ok(put('empty', '') === false && cred.read(T('empty')) === null, '빈 값은 받지 않는다');
  ok(cred.write(T('num'), 1234) === false && cred.write(T('nul'), null) === false, '글자가 아니면 받지 않는다');
  ok(put('lone', 'ab\uD800cd') === false, '짝 없는 서로게이트는 받지 않는다 (저장되면 다른 비밀번호가 된다)');
  ok(put('nul', 'ab\u0000cd') === false && cred.read(T('nul')) === null, 'NUL 이 든 값은 받지 않는다');
  ok(put('a', 'dummy-long-then-short-' + 'y'.repeat(2000)) && put('a', 's') && cred.read(T('a')) === 's',
    '긴 값 뒤에 짧은 값을 덮어써도 뒤꼬리가 남지 않는다');

  console.log('\n[2-2] 자격 증명 관리자 화면·cmdkey 로 넣은 값 (UTF-16LE)');
  // 화면의 «편집»이나 cmdkey 는 비밀번호 칸에 UTF-16LE 를 넣는다. UTF-8 로 읽으면 'd\0u\0…'이 되어
  // «풀렸다»고 여긴 채 로그인에서 틀린다 — 제대로 읽거나, 못 읽으면 null(«비밀번호 다시 필요»)이어야 한다
  ok(rawPut('u16', Buffer.from('dummy-u16-pass', 'utf16le')) && cred.read(T('u16')) === 'dummy-u16-pass',
    '영문 — UTF-16LE 로 읽는다 (NUL 이 섞인 글자가 아니다)');
  ok(rawPut('u16ko', Buffer.from('가나다-dummy', 'utf16le')) && cred.read(T('u16ko')) === '가나다-dummy', '한글 — UTF-16LE 로 읽는다');
  ok(rawPut('u16odd', Buffer.from([0x61, 0x00, 0x62])) && cred.read(T('u16odd')) === null, '0 바이트가 있는데 홀수 길이면 못 읽음 (null)');
  ok(rawPut('u16nul', Buffer.from('ab\u0000cd', 'utf16le')) && cred.read(T('u16nul')) === null, '읽은 글자에 NUL 이 있으면 못 읽음 (null)');
  ok(put('u16', 'dummy-back-to-utf8') && cred.read(T('u16')) === 'dummy-back-to-utf8', '그 위에 다시 쓰면 UTF-8 로 돌아온다');

  console.log('\n[3] 없는 항목');
  ok(cred.read(T('missing')) === null && cred.lastError === cred.ERROR_NOT_FOUND, '없는 것을 읽으면 null (오류 1168)', cred.lastError);
  ok(cred.remove(T('missing')) === false && cred.lastError === cred.ERROR_NOT_FOUND, '없는 것을 지우면 false (오류 1168)', cred.lastError);
  ok(cred.list(`${NS}/nothing-here/`).length === 0, '없는 앞머리로 찾으면 빈 목록');

  console.log('\n[4] 우리 이름이 아닌 것');
  // 모두 있을 리 없는 이름이다 — 혹시 있어도 부르기 전에 막힌다
  const odd = `zz-not-hibi-${crypto.randomBytes(4).toString('hex')}`;
  for (const t of [odd, `hibi-test/${odd}`, `Hibi-test${odd}`, 'Hibi-test/', `Hibiscus/${odd}`, `${NS}/*`, `${NS}/a\u0000b`, '', null, 42]) {
    ok(cred.write(t, 'dummy') === false && cred.read(t) === null && cred.remove(t) === false, `거절 — ${JSON.stringify(t)}`);
  }
  ok(cred.list('').length === 0 && cred.list('*').length === 0 && cred.list('git').length === 0 && cred.list(`${NS}*`).length === 0,
    'list 도 우리 앞머리로만 찾는다');
  ok(cred.write(`${NS}/${'k'.repeat(300)}`, 'dummy') === false, '너무 긴 이름은 받지 않는다');

  console.log('\n[5] 이 PC에만 · 사용자 이름 칸');
  const meta = peek(T('b'));
  ok(!!meta && meta.Persist === 2, 'CRED_PERSIST_LOCAL_MACHINE (2) — 로밍 프로필을 따라가지 않는다', meta && meta.Persist);
  ok(!!meta && meta.Type === 1 && meta.UserName === 'Hibi', '일반 자격 증명, 사용자 이름 칸은 «Hibi» (비밀이 아니다)', meta && { type: meta.Type, user: meta.UserName });
}

/** credstore 를 거치지 않고 advapi32 를 바로 부르는 것 — 이 시험의 앞머리 아래에만 쓴다 */
let rawApi;
function raw() {
  if (rawApi) return rawApi;
  const koffi = require('koffi');
  const advapi32 = koffi.load('advapi32.dll');
  const CRED = koffi.struct({
    Flags: 'uint32_t', Type: 'uint32_t', TargetName: 'const char16_t *', Comment: 'const char16_t *',
    LastWritten: koffi.struct({ low: 'uint32_t', high: 'uint32_t' }), CredentialBlobSize: 'uint32_t',
    CredentialBlob: 'void *', Persist: 'uint32_t', AttributeCount: 'uint32_t', Attributes: 'void *',
    TargetAlias: 'const char16_t *', UserName: 'const char16_t *'
  });
  rawApi = {
    koffi, CRED,
    read: advapi32.func('__stdcall', 'CredReadW', 'int',
      ['const char16_t *', 'uint32_t', 'uint32_t', koffi.out(koffi.pointer('void *'))]),
    write: advapi32.func('__stdcall', 'CredWriteW', 'int', [koffi.pointer(CRED), 'uint32_t']),
    free: advapi32.func('__stdcall', 'CredFree', 'void', ['void *'])
  };
  return rawApi;
}

/**
 * 자격 증명 관리자 화면·cmdkey 가 하듯 바이트를 그대로 넣는다 (시험용 값만, 이 시험의 앞머리 아래에만).
 * credstore.write 는 늘 UTF-8 로 쓰므로 UTF-16LE 칸은 이렇게만 만들 수 있다.
 */
function rawPut(name, bytes) {
  const target = T(name);
  if (!target.startsWith(`${NS}/`)) return false;
  written.add(target);
  try {
    const a = raw();
    return !!a.write({
      Flags: 0, Type: 1, TargetName: target, Comment: null, LastWritten: { low: 0, high: 0 },
      CredentialBlobSize: bytes.length, CredentialBlob: bytes, Persist: 2,
      AttributeCount: 0, Attributes: null, TargetAlias: null, UserName: 'Hibi'
    }, 0);
  } catch (e) {
    console.log('   (바로 쓰지 못함:', e.message, ')');
    return false;
  }
}

/** 시험이 쓴 항목 하나의 겉모양 — 값(비밀번호 칸)은 읽지 않는다 */
function peek(target) {
  try {
    if (!target.startsWith(`${NS}/`)) return null;
    const a = raw();
    const out = [null];
    if (!a.read(target, 1, 0, out)) return null;
    try {
      const c = a.koffi.decode(out[0], a.CRED);
      return { Type: c.Type, Persist: c.Persist, UserName: c.UserName };
    } finally { a.free(out[0]); }
  } catch (e) {
    console.log('   (겉모양을 못 읽음:', e.message, ')');
    return null;
  }
}

try {
  main();
} catch (e) {
  ok(false, `시험 터짐 — ${(e && e.message) || e}`);
} finally {
  if (process.platform === 'win32' && cred.available) {
    console.log('\n[6] 치우기');
    for (const t of new Set([...written, ...cred.list(`${NS}/`)])) cred.remove(t);
    const mine = cred.list(`${NS}/`);
    ok(mine.length === 0, '이 시험이 쓴 항목이 하나도 남지 않았다', mine.length);
    const any = cred.list('Hibi-test/');
    ok(any.length === 0, '«Hibi-test/» 아래에 남은 항목이 없다', any.length);
  }
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

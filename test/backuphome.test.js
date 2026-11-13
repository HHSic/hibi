'use strict';
// 메일 백업 폴더의 기본 자리 — 후보 차례와 D: 드라이브 살피기 (src/backuphome.js).
//
// 창도 Electron 도 쓰지 않는다. node 로도, npx electron 으로도 돈다.
// 진짜 D: 드라이브는 부르지 않는다 — 드라이브 살피기는 바꿔 끼운 kernel32 로만 시험한다.
// 진짜 kernel32 는 시스템 드라이브(C:)에만 한 번 부른다 (읽기만 한다).
//   [1] 후보 차례 — D: 가 있을 때·없을 때, 개발 실행   [2] D: 를 건너뛰는 때 — 종류·파일 시스템·공간·시스템 드라이브·클라우드·살피기 실패
//   [3] probe — 바꿔 끼운 kernel32   [4] 진짜 kernel32 형 선언과 시스템 드라이브 한 번
const path = require('path');

const ROOT = path.join(__dirname, '..');
const home = require(path.join(ROOT, 'src', 'backuphome.js'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const J = JSON.stringify;
const GB = 1024 ** 3;

const base = { home: 'C:\\Users\\me', docs: 'C:\\Users\\me\\Documents', userData: 'C:\\Data\\Hibi', env: { SystemDrive: 'C:' }, packaged: true };
const D = (o = {}) => ({ root: 'D:\\', type: 3, fs: 'NTFS', free: 120 * GB, ...o });
const OLD = ['C:\\Users\\me\\Hibi 메일', 'C:\\Users\\me\\Documents\\Hibi 메일', 'C:\\Data\\Hibi\\mail'];

console.log('\n[1] 후보 차례');
{
  ok(J(home.defaultDirs({ ...base, dataDrive: D() })) === J(['D:\\Hibi 메일', ...OLD]), '패키지 + 쓸 만한 D: — D:\\Hibi 메일, 홈, 문서, userData 차례', home.defaultDirs({ ...base, dataDrive: D() }));
  ok(J(home.defaultDirs(base)) === J(OLD), 'D: 를 안 주면 예전 그대로 — 홈, 문서, userData', home.defaultDirs(base));
  ok(J(home.defaultDirs({ ...base, dataDrive: null })) === J(OLD), '…null 도 예전 그대로');
  let calls = 0;
  const probe = () => { calls += 1; return D(); };
  ok(J(home.defaultDirs({ ...base, packaged: true, dataDrive: probe })) === J(['D:\\Hibi 메일', ...OLD]) && calls === 1, '살피기 함수를 주면 한 번 부른다', calls);
  calls = 0;
  ok(J(home.defaultDirs({ ...base, packaged: false, dataDrive: probe })) === J(['C:\\Data\\Hibi\\mail']) && calls === 0,
    '개발·시험 실행은 userData 뿐 — 드라이브를 살피지도 않는다', calls);
  ok(J(home.defaultDirs({ ...base, packaged: false, dataDrive: D() })) === J(['C:\\Data\\Hibi\\mail']), '…결과를 줘도 userData 뿐');
  const od = { SystemDrive: 'C:', OneDrive: 'c:\\users\\ME\\onedrive' };
  ok(J(home.defaultDirs({ ...base, docs: 'C:\\Users\\me\\OneDrive\\Documents', env: od, dataDrive: D() })) === J(['D:\\Hibi 메일', 'C:\\Users\\me\\Hibi 메일', 'C:\\Data\\Hibi\\mail']),
    '문서 폴더가 OneDrive 안이면 예전처럼 건너뛴다 — D: 는 그대로 맨 앞');
  ok(home.FILL_MAIL_DIR === 'Hibi 메일' && home.MIN_FREE === 2 * GB && home.DRIVE_FIXED === 3, '폴더 이름·2GB·DRIVE_FIXED(3)', [home.FILL_MAIL_DIR, home.MIN_FREE, home.DRIVE_FIXED]);
}

console.log('\n[2] D: 를 건너뛰는 때');
{
  const only = (info, env = base.env) => J(home.defaultDirs({ ...base, env, dataDrive: info })) === J(OLD);
  for (const [type, what] of [[0, '알 수 없음'], [1, '없음(루트 없음)'], [2, '이동식(USB)'], [4, '네트워크'], [5, 'CD'], [6, 'RAM 디스크']]) {
    ok(only(D({ type })), `종류 ${type} (${what}) — 건너뛴다`);
  }
  ok(only(D({ fs: 'FAT32' })), 'FAT32 — 건너뛴다 (Google Drive 가 고정 드라이브로 붙인 G: 꼴)');
  ok(only(D({ fs: 'exFAT' })) && only(D({ fs: '' })) && only(D({ fs: 'CDFS' })), 'exFAT·빈 이름·CDFS — 건너뛴다');
  ok(!only(D({ fs: 'ReFS' })) && !only(D({ fs: 'ntfs' })), 'ReFS·소문자 ntfs 는 쓴다');
  ok(only(D({ free: 2 * GB - 1 })) && !only(D({ free: 2 * GB })), '남은 공간 2GB 미만이면 건너뛰고, 2GB 이상이면 쓴다');
  ok(only(D({ free: NaN })) && only(D({ free: undefined })), '남은 공간을 모르면 건너뛴다');
  ok(only(D(), { SystemDrive: 'D:' }) && only(D(), { SystemDrive: 'd:' }), 'D: 가 시스템 드라이브면 건너뛴다 (대소문자 안 가림)');
  ok(only(D(), {}), '시스템 드라이브를 모르면 건너뛴다');
  ok(only(D(), { SystemDrive: 'C:', OneDrive: 'D:\\' }) && only(D(), { SystemDrive: 'C:', OneDriveCommercial: 'd:\\' }), 'OneDrive 가 D: 를 통째로 쓰면 건너뛴다');
  ok(only(D(), { SystemDrive: 'C:', GoogleDrive: 'D:\\' }), 'Google Drive 뿌리가 D: 면 건너뛴다');
  ok(!only(D(), { SystemDrive: 'C:', OneDrive: 'D:\\OneDrive' }), 'OneDrive 가 D: 의 한 폴더면 D:\\Hibi 메일 은 그 밖이다 — 쓴다');
  ok(only(() => { throw new Error('koffi 없음'); }), '살피기가 던지면 건너뛴다 (던지지 않는다)');
  ok(only(() => null) && only(() => undefined), '살피기가 null 이면 건너뛴다');
  ok(only({ root: 'C:\\', type: 3, fs: 'NTFS', free: 100 * GB }), '뿌리가 시스템 드라이브(C:)면 건너뛴다');
  ok(only(D({ root: '\\\\server\\share\\' })) && only(D({ root: 'D:' })) && only('D:\\'), '뿌리 꼴이 이상하면 건너뛴다');
  ok(home.underCloud('D:\\Hibi 메일', { GoogleDrive: 'D:\\' }) && !home.underCloud('D:\\Hibi 메일', { GoogleDriveBackup: '' })
    && !home.underCloud('D:\\Hibi 메일', { OneDrive: 'D:\\OneDrive' }) && home.underCloud('D:\\OneDrive\\x', { OneDrive: 'D:\\OneDrive' }),
  'underCloud — 그 뿌리와 그 안만, 빈 값은 무시');
  ok(home.underOneDrive('C:\\Users\\me\\OneDrive', { OneDrive: 'c:\\users\\ME\\onedrive' }) && !home.underOneDrive('C:\\Users\\me\\OneDriveBackup\\x', { OneDrive: 'C:\\Users\\me\\OneDrive' }),
    'underOneDrive — 예전과 같다 (옆 폴더는 아니다)');
}

console.log('\n[3] probe — 바꿔 끼운 kernel32');
{
  const fake = (o = {}) => {
    const calls = [];
    return {
      calls,
      driveType: (root) => { calls.push(['type', root]); if (o.typeThrows) throw new Error('x'); return o.type == null ? 3 : o.type; },
      volumeInfo: (root, nameBuf, nameLen, serial, maxComp, flags, fsBuf, fsLen) => {
        calls.push(['vol', root, fsLen]);
        if (o.volFail) return 0;
        fsBuf.write(`${o.fs == null ? 'NTFS' : o.fs}\0`, 'utf16le');
        return 1;
      }
    };
  };
  const statfs = (free) => (root) => { if (free instanceof Error) throw free; return { bavail: free / 4096, bsize: 4096, root }; };
  let a = fake();
  let info = home.probe('D', { api: a, statfs: statfs(120 * GB) });
  ok(J(info) === J({ root: 'D:\\', type: 3, fs: 'NTFS', free: 120 * GB }), 'D: — 고정·NTFS·남은 공간', info);
  ok(a.calls[0][1] === 'D:\\' && a.calls[1][1] === 'D:\\' && a.calls[1][2] >= 32, '…뿌리 «D:\\» 로 부르고, 파일 시스템 이름 칸을 넉넉히 준다', a.calls);
  a = fake({ type: 2 });
  info = home.probe('D', { api: a, statfs: statfs(120 * GB) });
  ok(info && info.type === 2 && info.fs === '' && a.calls.length === 1, '고정 드라이브가 아니면 볼륨 정보·공간을 읽지 않는다 (빈 카드 리더가 «디스크 없음»을 띄우지 않게)', a.calls);
  ok(home.probe('D', { api: fake({ typeThrows: true }), statfs: statfs(GB) }) === null, 'GetDriveTypeW 가 던지면 null');
  info = home.probe('D', { api: fake({ volFail: true }), statfs: statfs(120 * GB) });
  ok(info && info.fs === '' && !home.usable(info, { SystemDrive: 'C:' }), '볼륨 정보를 못 읽으면 파일 시스템 이름이 비어 쓰지 않는다', info);
  ok(home.probe('D', { api: fake(), statfs: statfs(new Error('EIO')) }) === null, '남은 공간을 못 읽으면 null');
  info = home.probe('G', { api: fake({ fs: 'FAT32' }), statfs: statfs(100 * GB) });
  ok(info && info.fs === 'FAT32' && !home.usable(info, { SystemDrive: 'C:' }), 'Google Drive 꼴(고정·FAT32) — 읽기는 하되 쓰지 않는다', info);
  ok(home.probe('DD', { api: fake() }) === null && home.probe('1', { api: fake() }) === null && home.probe('', { api: fake() }) === null, '드라이브 글자가 이상하면 부르지도 않는다');
  ok(home.probe('D', { api: null }) === null, 'kernel32 를 못 실으면 null');
  ok(home.usable(D(), { SystemDrive: 'C:' }) === true && home.usable(null, {}) === false, 'usable — 참·거짓');
}

console.log('\n[4] 진짜 kernel32 — 형 선언과 시스템 드라이브 한 번 (D: 는 부르지 않는다)');
if (process.platform !== 'win32') {
  ok(home.loadApi() === null, '윈도우가 아니면 null');
} else {
  const api = home.loadApi();
  ok(!!api && typeof api.driveType === 'function' && typeof api.volumeInfo === 'function', 'GetDriveTypeW·GetVolumeInformationW 를 선언했다 (이름 없는 형)');
  ok(home.loadApi() === api, '…한 번만 싣는다');
  const sys = String(process.env.SystemDrive || '').slice(0, 1);
  if (/^[A-Za-z]$/.test(sys) && sys.toUpperCase() !== 'D') {
    const info = home.probe(sys);
    ok(!!info && info.type === 3 && /^(NTFS|ReFS)$/i.test(info.fs) && info.free > 0, `시스템 드라이브(${sys}:) — 고정·${info && info.fs}·남은 공간을 읽는다`, info && { type: info.type, fs: info.fs });
    ok(!home.usable(info, process.env), '…시스템 드라이브라 쓰지 않는다');
  } else {
    ok(true, '(시스템 드라이브를 몰라 진짜 부르기는 건너뜀)');
  }
}

console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

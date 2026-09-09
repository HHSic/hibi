const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 첨부를 «기본 앱으로 열기».
//
// 이 기능은 남이 보낸 파일을 이 PC 의 앱에 넘긴다. 그래서 세 가지를 잰다.
//  1. 확장자 판정 — 윈도우가 실제로 실행할 이름을 골라내는가.
//     이름은 보낸 사람이 지은 것이라 눈속임이 섞여 온다 (보고서.pdf.exe, 끝의 점,
//     NTFS 스트림 문법, 방향 바꾸기 글자). 여기서 틀리면 곧바로 실행이다.
//  2. 허락 목록 — 모르는 것은 안 연다. 막을 것을 나열하는 쪽은 새 형식마다 뚫린다.
//  3. 인터넷에서 온 표(Mark-of-the-Web) — 우리가 직접 쓴 임시 파일에는 이 표가 없어서
//     오피스가 보호된 보기를 안 걸고 그냥 연다. 붙이는지, 그리고 «순서»가 맞는지 본다
//     (본문을 나중에 쓰면 표가 지워진다 — 실측).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const preview = require(`${ROOT}/src/preview.js`);

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

const RLO = '‮';   // 방향 바꾸기 — 눈에 보이는 순서를 뒤집는다
const ZWSP = '​';  // 너비 없는 공백

console.log('\n[1] 윈도우가 실제로 실행할 확장자를 골라내는가');
const cases = [
  ['보고서.pdf', '.pdf'],
  ['보고서.PDF', '.pdf'],
  ['보고서.pdf.exe', '.exe'],            // 마지막이 진짜다
  ['보고서.exe.', '.exe'],               // 윈도우는 끝의 점을 뗀다
  ['보고서.exe   ', '.exe'],             // 끝의 공백도 뗀다
  ['보고서.exe . . ', '.exe'],
  ['보고서.txt:악성.exe', '.txt'],        // 콜론 뒤는 스트림 이름
  [`보고서${RLO}txt.exe`, '.exe'],        // 눈에는 .txt 로 보이지만 실제는 .exe
  [`보고서.ex${ZWSP}e`, '.exe'],          // 너비 없는 글자를 끼운 것
  ['..\\..\\Windows\\System32\\calc.exe', '.exe'],
  ['/etc/passwd', null],                 // 확장자가 없다
  ['보고서', null],
  // 이름 전체가 확장자인 파일(«.docx»)은 윈도우도 확장자로 본다. 그대로 인정한다 —
  // 안전에는 차이가 없다. «.exe» 도 같은 길로 들어와 허락 목록에서 걸린다.
  ['.docx', '.docx'],
  ['.exe', '.exe'],
  ['보고서.ｅｘｅ', null],                // 전각은 아스키가 아니다
  ['보고서.exeexeexeexeexe', null],       // 12자 넘음
  ['', null],
  [null, null]
];
for (const [name, want] of cases) {
  const got = preview.openExt(name);
  ok(got === want, `${JSON.stringify(name)} → ${want}`, got === want ? undefined : got);
}

console.log('\n[2] 허락한 것만 연다 (모르는 것은 안 연다)');
const should = [
  ['보고서.pdf', true], ['계약서.hwp', true], ['자료.xlsx', true], ['사진.png', true],
  ['묶음.zip', true], ['영상.mp4', true], ['메모.txt', true],
  ['악성.exe', false], ['악성.scr', false], ['악성.bat', false], ['악성.cmd', false],
  ['악성.ps1', false], ['악성.vbs', false], ['악성.js', false], ['악성.hta', false],
  ['악성.lnk', false], ['악성.msi', false], ['악성.reg', false], ['악성.iso', false],
  ['악성.docm', false], ['악성.xlsm', false], ['악성.pptm', false],   // 매크로 문서
  ['악성.settingcontent-ms', false], ['악성.url', false], ['악성.chm', false],
  // SVG 는 그림처럼 보이지만 안에 스크립트를 담는다. 기본 앱이 브라우저면 그게 돈다.
  ['악성.svg', false],
  // 매크로를 담는 옛 엑셀 이진 형식 — 이름에 m 이 없어 눈에 안 띈다
  ['악성.xlsb', false],
  // 열자마자 바깥 자료를 끌어오는 엑셀 질의 형식
  ['악성.iqy', false], ['악성.slk', false],
  ['악성.html', false], ['악성.mhtml', false], ['악성.jar', false],
  ['보고서.pdf.exe', false],            // 눈속임
  ['보고서', false],                     // 확장자 없음
  ['보고서.duh', false]                  // 모르는 것
];
for (const [name, want] of should) {
  const r = preview.openable({ filename: name });
  ok(r.ok === want, `${name} → ${want ? '연다' : '안 연다'}`, r.ok === want ? undefined : r);
}

console.log('\n[3] 위험한 갈래는 한 번 더 묻게 표시된다');
for (const [name, warn] of [['계약서.hwp', true], ['옛문서.doc', true], ['옛서식.rtf', true],
  ['자료.xlsx', false], ['보고서.pdf', false], ['사진.png', false]]) {
  const r = preview.openable({ filename: name });
  ok(r.ok && r.warn === warn, `${name} → ${warn ? '묻는다' : '바로 연다'}`, r);
}

console.log('\n[4] 임시 파일 이름은 보낸 사람이 아니라 우리가 짓는다');
const nasty = { filename: '..\\..\\..\\Windows\\System32\\evil.exe', content: Buffer.alloc(64, 3) };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-'));
const p1 = preview.tempPathFor(dir, nasty, '.pdf');
ok(!!p1 && path.dirname(p1) === dir, '임시 폴더 안에만 만든다', p1 && path.dirname(p1));
ok(!!p1 && !/evil|Windows|System32/i.test(path.basename(p1)),
  '보낸 사람이 지은 이름은 안 쓴다', p1 && path.basename(p1));
ok(!!p1 && path.extname(p1) === '.pdf', '확장자는 우리가 정한 것을 쓴다', p1 && path.extname(p1));

console.log('\n[5] 인터넷에서 온 표(Mark-of-the-Web)를 붙인다 — 순서까지');
const ZONE = '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=about:internet\r\n';
const streamsOf = (f) => {
  try {
    return execFileSync('cmd', ['/c', 'dir', '/r', f], { encoding: 'utf8' })
      .split(/\r?\n/).filter((l) => /:\$DATA/.test(l)).map((l) => l.trim());
  } catch { return []; }
};
// 제품이 하는 순서 — 본문 먼저, 표 나중
const good = path.join(dir, 'good.docx');
fs.writeFileSync(good, Buffer.alloc(512, 1));
fs.writeFileSync(`${good}:Zone.Identifier`, ZONE);
ok(streamsOf(good).some((l) => /Zone\.Identifier/i.test(l)), '표가 붙는다', streamsOf(good));
ok(fs.readFileSync(`${good}:Zone.Identifier`, 'utf8').includes('ZoneId=3'), '값이 ZoneId=3 이다');
ok(fs.statSync(good).size === 512, '본문은 그대로다', fs.statSync(good).size);

// 거꾸로 하면 지워진다는 것도 못 박아 둔다 — 이 순서를 누가 바꾸면 여기서 걸린다
const wrong = path.join(dir, 'wrong.docx');
fs.writeFileSync(wrong, Buffer.alloc(0));
fs.writeFileSync(`${wrong}:Zone.Identifier`, ZONE);
fs.writeFileSync(wrong, Buffer.alloc(512, 2));      // 본문을 나중에
ok(!streamsOf(wrong).some((l) => /Zone\.Identifier/i.test(l)),
  '본문을 나중에 쓰면 표가 지워진다 (그래서 제품은 본문을 먼저 쓴다)', streamsOf(wrong));

console.log('\n[6] 제품 코드가 정말 그 순서로, 그리고 실패하면 안 열게 되어 있나');
// 함수 «정의»가 아니라 «부르는 자리»를 봐야 한다 — 정의는 파일 위쪽에 있어서
// 그냥 indexOf 로 찾으면 순서를 거꾸로 읽는다 (이 시험이 실제로 그렇게 헛짚었다).
const all = fs.readFileSync(path.join(__dirname, '..', 'src', 'mailwin.js'), 'utf8');
const hStart = all.indexOf("ipcMain.handle('mail:open-attachment'");
const src = hStart >= 0 ? all.slice(hStart) : '';
ok(!!src, '핸들러를 찾았다');
const iWrite = src.indexOf('fs.writeFileSync(file, a.content);          // 본문 먼저');
const iMark = src.indexOf('markFromInternet(file)');
const iOpen = src.indexOf('await shell.openPath(file)');
ok(iWrite > 0 && iMark > iWrite, '본문 쓰기가 표 붙이기보다 앞에 있다', { 본문: iWrite, 표: iMark });
ok(iMark > 0 && iOpen > iMark, '표를 붙인 뒤에 연다', { 표: iMark, 열기: iOpen });
// 표를 못 붙였으면 열지 않아야 한다. 예전에는 그냥 열고 메시지만 바꿨다 —
// 그러면 보호된 보기 없이 남의 문서를 여는 일을 조용히 해 주는 셈이다.
ok(/if\s*\(!markFromInternet\(file\)\)/.test(src),
  '표를 못 붙이면 열지 않고 되돌린다 (fail-closed)');
ok(src.slice(iMark, iOpen).includes('return {'),
  '거절하는 return 이 열기보다 먼저 있다');
// 되읽어 확인하는지 (썼다고 믿지 않는다)
ok(/readFileSync\(ads, 'utf8'\)/.test(all), '붙인 표를 되읽어 확인한다 (함수 정의에서)');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ }
console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
process.exit(bad ? 1 : 0);

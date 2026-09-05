const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 캘린더 주소를 가져올 때, 남의 서버가 우리를 «내 컴퓨터 안»으로 돌려보낼 수 있나.
//
// 구독 주소는 사용자가 붙여넣는 남의 주소다. 그 서버가 302로
//   Location: file:///C:/…/설정파일
//   Location: \\남의서버\공유\아무거나
// 를 주면, 우리가 그 파일을 읽어 준다. 앞의 것은 내 파일이 새는 길이고,
// 뒤의 것은 파일을 읽지 못해도 이미 샌 것이다 — 윈도우가 공유에 붙는 순간
// 내 계정 이름과 암호 해시를 그 서버에 넘긴다.
//
// 여기서는 진짜 http 서버를 띄워 진짜로 돌려보내 보고, 무엇이 읽혔는지 본다.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const calendar = require(`${ROOT}/src/calendar.js`);

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};

// 새면 안 되는 «비밀 파일»을 하나 만들어 둔다
const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calsec-'));
const secretFile = path.join(secretDir, 'secret.txt');
const SECRET = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:비밀번호는 hunter2\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
fs.writeFileSync(secretFile, SECRET, 'utf8');

const fileUrl = `file:///${secretFile.split(path.sep).join('/')}`;
const winPath = secretFile;

let hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  const where = new URL(req.url, 'http://127.0.0.1').searchParams.get('to');
  if (where) { res.writeHead(302, { Location: where }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/calendar' });
  res.end('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:정상\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
});

/** 한 주소를 실제로 가져와 본다 — 가져오는 길 자체를 잰다 */
async function grab(url) {
  try {
    const text = await calendar.fetchText(url);
    return { leaked: String(text).includes('hunter2'), err: [] };
  } catch (e) {
    return { leaked: false, err: [e.message] };
  }
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`   시험용 서버 ${base}`);
  console.log(`   비밀 파일 ${secretFile}\n`);

  console.log('[1] 평범한 주소는 그대로 가져온다');
  const plain = await grab(`${base}/cal.ics`);
  ok(!plain.leaked && !plain.err.length, '정상 ICS 는 잘 읽힌다', plain.err);

  console.log('\n[2] 남의 서버가 file:// 로 돌려보낼 때');
  for (const [name, to] of [
    ['file:/// 절대 주소', fileUrl],
    ['file:// 대문자', fileUrl.replace(/^file/, 'FILE')],
  ]) {
    const r = await grab(`${base}/x.ics?to=${encodeURIComponent(to)}`);
    ok(!r.leaked, `${name} — 내 파일을 안 읽는다`, r.leaked ? { 샘: to } : undefined);
  }

  console.log('\n[3] 남의 서버가 UNC 공유로 돌려보낼 때');
  // 윈도우 공유(\\서버\공유)에 붙으면 그 순간 내 계정 이름과 암호 해시가 넘어간다.
  // 다만 여기까지 오지 않는다 — new URL 이 역슬래시를 슬래시로 바꿔
  // \\호스트\공유\x → http://호스트/공유/x 인 «평범한 http 주소»가 된다 (실측).
  // 그러니 볼 것은 «파일 시스템으로 갔는가»다. 갔다면 ENOENT 같은 파일 오류가 난다.
  // 진짜 남의 서버로 나가면 안 되니 있지도 않은 이름을 쓴다.
  // 헤더에는 ASCII 만 들어간다 (한글을 넣으면 서버가 못 보낸다)
  const unc = '\\\\no-such-host.example\\share\\x.ics';
  const r3 = await grab(`${base}/x.ics?to=${encodeURIComponent(unc)}`);
  const wentToDisk = r3.err.some((m) => /ENOENT|EPERM|EACCES|EISDIR|scandir|no such file/i.test(m));
  ok(!wentToDisk && !r3.leaked, '파일 시스템으로 가지 않는다 (평범한 http 주소가 된다)', r3.err);

  console.log('\n[4] 처음부터 file:// 을 넣는 건 되어야 한다 (내 .ics 파일 쓰기)');
  const mine = await grab(fileUrl);
  ok(mine.leaked, '내가 직접 고른 파일은 읽힌다', mine.err);

  console.log('\n[5] 남의 서버가 webcal:// 로 돌려보낼 때');
  const r5 = await grab(`${base}/x.ics?to=${encodeURIComponent(`webcal://127.0.0.1:${server.address().port}/ok.ics`)}`);
  ok(!r5.leaked, 'webcal 은 https 일 뿐 — 파일이 안 샌다', r5.err);

  server.close();
  try { fs.rmSync(secretDir, { recursive: true, force: true }); } catch { /* 무시 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
});

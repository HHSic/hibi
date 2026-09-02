const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 날짜를 누르면 뜨는 일정 설명이 잘리는가.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'callist-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

const M = `(() => {
  const card = document.getElementById('card');
  const cal = document.getElementById('cal');
  const list = document.getElementById('cal-list');
  const rows = [...list.children].map((el) => {
    const b = el.getBoundingClientRect();
    return { 글: (el.textContent || '').trim().slice(0, 18), 아래: Math.round(b.bottom) };
  });
  const cb = card.getBoundingClientRect();
  return {
    창: innerHeight, 달력칸: Math.round(cal.getBoundingClientRect().height),
    달력내용: cal.scrollHeight, 모자람: Math.max(0, cal.scrollHeight - cal.clientHeight),
    일정수: rows.length,
    카드아래: Math.round(cb.bottom),
    잘린일정: rows.filter((r) => r.아래 > Math.round(cb.bottom) + 1).map((r) => r.글)
  };
})()`;

/** 오늘 날짜로 일정 몇 개를 담은 .ics 를 만든다 (줄바꿈은 LF — calendar.js 가 맞춰 읽는다) */
function makeIcs() {
  const now = new Date();
  const day = (n) => {
    const x = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    const p2 = (v) => String(v).padStart(2, '0');
    return `${x.getFullYear()}${p2(x.getMonth() + 1)}${p2(x.getDate())}`;
  };
  const p2 = (v) => String(v).padStart(2, '0');
  const rows = [
    [0, '팀 회의 — 3분기 계획 검토와 다음 스프린트 배분', '회의실 A. 지난 회의록 먼저 읽어올 것'],
    [0, '치과 예약', '스케일링. 보험카드 챙기기'],
    [0, '저녁 약속 — 오래 기다린 그 집', '7시, 을지로. 예약 이름은 본인'],
    [1, '내일 아침 운동', '']
  ].map(([off, name, desc], i) => [
    'BEGIN:VEVENT', `UID:t${i}@hibi`, `DTSTAMP:${day(0)}T090000Z`,
    `DTSTART:${day(off)}T${p2(9 + i)}0000`, `DTEND:${day(off)}T${p2(10 + i)}0000`,
    `SUMMARY:${name}`, `DESCRIPTION:${desc}`, 'END:VEVENT'
  ].join('\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//hibi//test//KO',
    ...rows, 'END:VCALENDAR', ''].join('\n');
}

app.whenReady().then(async () => {
  await sleep(2500);
  const w = winBy('widget.html'); const wc = w.webContents; w.show();
  // 일정은 «오늘»이어야 의미가 있다 — 파일로 담아두면 날짜가 굳으므로 그때그때 만든다
  const ics = path.join(tmp, 'events.ics');
  fs.writeFileSync(ics, makeIcs(), 'utf8');
  store.setSettings({ mailEnabled: true, mailShow: true });
  // 달력은 설정 창을 통해 넣는다 — 저장소에 직접 넣으면 main 이 다시 읽지 않는다
  const { ipcMain } = require('electron');
  ipcMain.emit('widget:open-settings', {}, 'cal');
  let sw = null;
  for (let i = 0; i < 80 && !sw; i++) { await sleep(50); sw = winBy('settings.html'); }
  const added = await sw.webContents.executeJavaScript(
    `window.nunsseom.calAdd('시험', ${JSON.stringify(ics)})`);
  console.log('  달력 넣음:', JSON.stringify(added && added.calendars ? added.calendars.length : added), ics);
  await sleep(1800);
  sw.close();
  await sleep(400);
  await wc.executeJavaScript(`document.getElementById('btn-mail').click()`); await sleep(700);
  await wc.executeJavaScript(`document.getElementById('btn-cal').click()`); await sleep(700);
  await wc.executeJavaScript(`document.getElementById('cal-month').click()`); await sleep(2500);

  // 오늘을 누른다 (일정 3개가 붙어 있다)
  await wc.executeJavaScript(`document.querySelector('#cal-grid .cday.today').click()`);
  await sleep(1500);
  let m = await wc.executeJavaScript(M);
  console.log('  오늘 누른 뒤', JSON.stringify(m));
  // 한 번 더 재본다 — 창이 자라며 두 번에 걸쳐 맞춰질 수 있다
  await sleep(1200);
  m = await wc.executeJavaScript(M);
  console.log('  잠시 뒤   ', JSON.stringify(m));
  ok(m.일정수 >= 3, '일정이 붙었다', m.일정수);
  ok(m.모자람 === 0, '달력 칸에 다 들어간다', m.모자람);
  ok(m.잘린일정.length === 0, '잘린 일정이 없다', m.잘린일정);

  fs.writeFileSync(path.join(OUT, 'callist.png'), (await wc.capturePage()).toPNG());
  console.log(bad ? bad + '개 실패' : '모두 통과');
  app.exit(bad ? 1 : 0);
});

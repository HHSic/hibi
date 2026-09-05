const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
const OUT = process.env.HIBI_TEST_OUT || require('os').tmpdir();
// 정해진 시각 알람을 진짜 설정 창에서 만들어 보고, 진짜 위젯에 무엇이 찍히는지 본다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alarmlab-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
function ok(c, m, x) {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
}
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

async function clickAt(wc, x, y) {
  for (const type of ['mouseDown', 'mouseUp']) {
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await sleep(40);
  }
}
/** 글자로 단추를 찾아 진짜 마우스로 누른다 */
async function clickText(wc, sel, text) {
  const at = await wc.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!at) return false;
  await sleep(250);
  const at2 = await wc.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await clickAt(wc, at2.x, at2.y);
  return true;
}
/** 앱 목록(popup.html)에서 글자로 골라 누른다 */
async function pickMenuText(text) {
  for (let i = 0; i < 20 && !winBy('popup.html'); i++) await sleep(150);
  const p = winBy('popup.html');
  if (!p) return false;
  await sleep(400);
  const at = await p.webContents.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll('.menu .item')]
      .find((e) => e.textContent.replace('\u2713','').trim() === ${JSON.stringify(text)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!at) return false;
  await clickAt(p.webContents, at.x, at.y);
  await sleep(600);
  return true;
}

const seen = [];
app.whenReady().then(async () => {
  await sleep(2500);

  // 위젯에 찍히는 것을 엿본다
  const wwc = winBy('widget.html').webContents;
  const orig = wwc.send.bind(wwc);
  wwc.send = (ch, ...a) => { if (ch === 'tick') seen.push(a[0]); return orig(ch, ...a); };

  ipcMain.emit('widget:open-settings', {});
  await sleep(3000);
  const sw = winBy('settings.html');
  if (!sw) { console.error('설정 창 없음'); app.exit(1); return; }
  const wc = sw.webContents;

  console.log('\n[새 알림 만들어 «정해진 시각»으로 바꾸기]');
  await clickText(wc, 'button', '＋ 새 알림 만들기') || await wc.executeJavaScript(`document.getElementById('btn-custom-add').click()`);
  await sleep(1200);
  const ids = Object.keys(store.custom);
  ok(ids.length === 1, '알림이 하나 생겼다', ids);
  const id = ids[0];
  ok(store.custom[id].when === 'every', '처음엔 «주기마다»', store.custom[id].when);

  ok(await clickText(wc, '.mini', '정해진 시각'), '«정해진 시각» 단추를 눌렀다');
  await sleep(900);
  ok(store.custom[id].when === 'at', '방식이 저장됐다', store.custom[id].when);

  const boxes = await wc.executeJavaScript(`(() => {
    const d = document.querySelector('.rem-wrap.open .detail');
    const rows = [...d.querySelectorAll('.drow')].map((r) => r.textContent.trim().slice(0, 30));
    return { rows, sliderShown: [...d.querySelectorAll('input[type=range]')].filter((x) => x.getBoundingClientRect().width > 0).length };
  })()`);
  console.log('   보이는 줄:', JSON.stringify(boxes.rows));
  ok(boxes.sliderShown === 1, '«주기» 슬라이더는 감춰지고 «길이»만 남는다', boxes.sliderShown);
  ok(boxes.rows.some((r) => r.includes('아직 시각이 없')), '시각이 없다고 알려준다');

  console.log('\n[시각 넣기]');
  ok(await clickText(wc, '.mini', '＋ 시각 추가'), '«시각 추가»를 눌렀다');
  await sleep(900);
  ok(JSON.stringify(store.custom[id].times) === '["09:00"]', '09:00이 들어갔다', store.custom[id].times);

  // 시(hour) 목록을 앱 메뉴로 열어 15로 바꾼다
  const hourAt = await wc.executeJavaScript(`(() => {
    const b = document.querySelector('.rem-wrap.open button.pickfield');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: b.querySelector('.pf-t').textContent };
  })()`);
  ok(!!hourAt, '시각 칸이 앱 고르기 단추로 나온다 (네이티브 드롭다운 아님)', hourAt && hourAt.txt);
  if (hourAt) {
    await sleep(300);
    await clickAt(wc, hourAt.x, hourAt.y);
    ok(await pickMenuText('15'), '목록에서 15시를 골랐다');
    await sleep(700);
    ok(JSON.stringify(store.custom[id].times) === '["15:00"]', '15:00으로 바뀌었다', store.custom[id].times);
  }

  console.log('\n[요일 고르기]');
  const before = JSON.stringify(store.custom[id].days);
  ok(await clickText(wc, '.mini.day', '일'), '«일»요일을 껐다');
  await sleep(800);
  ok(JSON.stringify(store.custom[id].days) === '[1,2,3,4,5,6]',
    `일요일이 빠졌다 (${before} → ${JSON.stringify(store.custom[id].days)})`);

  const sum = await wc.executeJavaScript(`document.querySelector('.rem-wrap.open .val').textContent`);
  console.log('   목록에 보이는 요약:', JSON.stringify(sum));
  ok(/15:00/.test(sum) && !/분$/.test(sum.split('·')[0]), '요약이 «시각»으로 나온다', sum);

  console.log('\n[위젯에 무엇이 찍히나]');
  // 일요일을 도로 켠다. 아래에서 «한 바퀴 = 24시간»을 재는데, 일요일이 빠진 채로
  // 토요일에 걸리면 다음 차례가 월요일이라 48시간이 맞다 — 검사가 요일을 타면 안 된다.
  ok(await clickText(wc, '.mini.day', '일'), '«일»요일을 도로 켰다');
  await sleep(800);
  // 이 앱에서 «매일»은 요일을 하나도 안 고른 상태([])다 — 일곱 개를 다 담지 않는다
  const backDays = store.custom[id].days;
  ok(!backDays.length || backDays.length === 7, '매일로 돌아왔다', backDays);

  // 다른 알림을 다 끄면 이 알람이 다음 차례가 된다
  for (const t of require(`${ROOT}/src/reminders.js`).TYPES) {
    store.setReminder(t.id, { enabled: false });
  }
  // 지금부터 다섯 시간쯤 뒤로 옮겨 «한참 남은» 상태를 만든다
  const far = new Date(Date.now() + 5 * 3600_000);
  const hh = String(far.getHours()).padStart(2, '0');
  const mm = String(Math.floor(far.getMinutes() / 5) * 5).padStart(2, '0');
  await wc.executeJavaScript(`window.nunsseom.customUpdate(${JSON.stringify(id)}, { times: [${JSON.stringify(`${hh}:${mm}`)}] })`);
  await sleep(2500);

  const last = seen[seen.length - 1];
  console.log('   위젯 payload:', JSON.stringify({
    empty: last.empty, fixedAt: last.fixedAt, remaining: last.remaining, total: last.total,
    name: last.type && last.type.name
  }));
  ok(last.fixedAt === `${hh}:${mm}`, '위젯이 «몇 시»를 받는다', last.fixedAt);
  ok(Number.isFinite(last.total) && last.total > 0, 'total이 제대로 된 숫자다 (NaN 아님)', last.total);
  ok(last.total === 24 * 3600, '한 바퀴는 24시간', last.total);
  ok(Math.abs(last.remaining - 5 * 3600) < 400, '남은 시간이 다섯 시간쯤', last.remaining);

  const shown = await winBy('widget.html').webContents.executeJavaScript(
    `document.getElementById('time').textContent`);
  ok(shown === `${hh}:${mm}`, `위젯 숫자가 «${hh}:${mm}»으로 보인다 (1200:00이 아니라)`, shown);

  const img = await winBy('widget.html').webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'alarm-widget.png'), img.toPNG());
  const s2 = await sw.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'alarm-settings.png'), s2.toPNG());
  console.log('   찍음: alarm-widget.png, alarm-settings.png');

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

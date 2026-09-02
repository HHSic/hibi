const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 메일 보기 창을 딴 파일로 뺀 뒤에도 IPC가 살아 있고 배선이 그대로인가
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailwin-'));
app.setPath('appData', tmp);
require(`${ROOT}/src/main.js`);
const mailwin = require(`${ROOT}/src/mailwin.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => { console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`)); if (!c) bad++; };
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

app.whenReady().then(async () => {
  await sleep(2500);
  const wc = winBy('widget.html').webContents;

  // 계정 없는 메일을 열면 «계정을 찾을 수 없다»로 창이 뜬다 — 열리는 것 자체를 본다
  const r = await wc.executeJavaScript(`window.nunsseom.mailOpen({ accountId: 'nope', uid: 1, mailbox: 'INBOX' })`);
  ok(r === true, 'mail:open 이 답한다 (IPC 등록됨)', r);
  let mw = null;
  for (let i = 0; i < 30 && !mw; i++) { await sleep(200); mw = winBy('mailview.html'); }
  ok(!!mw, '보기 창이 실제로 뜬다');
  if (mw) {
    await sleep(1500);
    const d = await mw.webContents.executeJavaScript(`window.nunsseom.mailViewData()`);
    ok(d && /계정/.test(d.error || ''), '창이 제 자리(slot)를 찾아 데이터를 받는다', d && d.error);
    const b = await mw.webContents.executeJavaScript(`window.nunsseom.mailViewBounds()`);
    ok(b && b.width > 0, 'mailview:bounds 가 답한다', b && { w: b.width });
  }

  // 휴지통·slotOf 가 모듈에서 내보내진다
  ok(typeof mailwin.doTrash === 'function' && typeof mailwin.slotOf === 'function', 'doTrash·slotOf 내보냄');
  const t = await mailwin.doTrash({ accountId: 'nope', uid: 1, mailbox: 'INBOX' }, null);
  ok(t && t.moved === false, '없는 계정이면 안 옮기고 답한다', t);

  // smtp 시험이 composewin 으로 옮겨진 뒤에도 IPC 가 산다
  const s = await wc.executeJavaScript(`window.nunsseom.mailSmtpTest({ id: 'nope' })`);
  ok(s && s.ok === false && /비밀번호/.test(s.message), 'mail:smtp-test 가 답한다', s);

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

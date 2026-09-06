const ROOT = require('path').join(__dirname, '..').split(require('path').sep).join('/');
// 첨부를 끌어다 놓기.
//
// 여기서 지키려는 것이 둘이다.
//  1. 편함 — 창 어디에 놓아도 붙고, 같은 걸 두 번 놔도 하나고, 한도를 넘으면
//     보내기를 누르기 «전에» 알려준다.
//  2. 잠금 — 첨부 경로는 화면이 정하지 못한다. 그 창이 뚫리면 이 PC의 아무 파일이나
//     메일에 실어 보낼 수 있기 때문이다 (그래서 메인에 attachOk 목록이 있다).
//     끌어다 놓기를 붙이면서 이 잠금이 풀리기 쉬운데, preload 가 «진짜 File 객체»에서만
//     경로를 뽑게 해서 막았다. 그게 정말 그런지 여기서 잰다.
//
// 진짜 OS 끌어놓기는 시험에서 못 만든다. 그래서 층을 나눠 잰다:
//   · 다리(preload) 와 메인 IPC 는 진짜로 부른다
//   · 화면 쪽 동작(테두리·중복·합계)은 다리를 잠깐 가짜로 바꿔 놓고 잰다
// 가짜로 바꾼 자리는 아래에 그렇다고 적어 둔다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error('LAB 터짐:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('LAB 약속 깨짐:', (e && e.stack) || e); process.exit(1); });
setTimeout(() => { console.error('LAB 시간 초과'); process.exit(1); }, 180_000).unref();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'droplab-'));
app.setPath('appData', tmp);

require(`${ROOT}/src/main.js`);
const store = require(`${ROOT}/src/store.js`);
const secret = require(`${ROOT}/src/secret.js`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const winBy = (p) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(p)) || null;

// 붙일 진짜 파일들
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dropfiles-'));
const small = path.join(box, '보고서.pdf');
const other = path.join(box, '사진.png');
const folder = path.join(box, '폴더');
fs.writeFileSync(small, Buffer.alloc(1234, 7));
fs.writeFileSync(other, Buffer.alloc(4321, 9));
fs.mkdirSync(folder);

app.whenReady().then(async () => {
  await sleep(2500);
  // 계정이 없으면 쓰기 창이 안 열린다. 진짜 경로와 같은 모양으로 하나 심는다
  // (연결은 하지 않는다 — 여기서 보는 것은 첨부이지 보내기가 아니다).
  store.addMailAccount({
    name: '시험', provider: 'custom', host: 'imap.example.com', port: 993,
    user: 'me@example.com', sealed: secret.seal('nope'), from: 'me@example.com', sender: '나'
  });
  await sleep(500);

  // compose:open 은 handle 이라 emit 으로는 안 열린다 — 위젯에서 부른다 (진짜 길)
  const wwc = winBy('widget.html').webContents;
  await wwc.executeJavaScript(`window.nunsseom.composeOpen({ kind: 'new' })`);
  for (let i = 0; i < 40 && !winBy('compose.html'); i++) await sleep(200);
  const cw = winBy('compose.html');
  if (!cw) { console.log('쓰기 창이 안 열렸다'); app.exit(1); return; }
  await sleep(1500);
  const wc = cw.webContents;

  console.log('\n[1] 다리는 «진짜 File» 에서만 경로를 뽑는다 (여기가 잠금이다)');
  const faked = await wc.executeJavaScript(`(async () => {
    // 화면이 지어낸 것들 — 경로 글자, 가짜 객체, 진짜처럼 생긴 File
    const fake = [
      'C:\\\\Windows\\\\win.ini',
      { name: 'win.ini', path: 'C:\\\\Windows\\\\win.ini' },
      new File(['x'], 'win.ini')          // 진짜 File 이지만 디스크에 없는 것
    ];
    const r = await window.nunsseom.composeDropFiles(fake).catch((e) => ({ error: String(e) }));
    return r;
  })()`);
  ok(faked && Array.isArray(faked.files) && faked.files.length === 0,
    '지어낸 경로·가짜 객체·디스크에 없는 File 은 하나도 안 붙는다', faked);

  console.log('\n[2] 메인은 폴더와 상대경로를 거른다');
  const viaMain = await wc.executeJavaScript(
    `window.nunsseom.composeDropFiles.length`);   // 있는지만 확인용
  ok(typeof viaMain === 'number', '다리에 composeDropFiles 가 있다');
  // 메인 핸들러를 직접 부른다 — 진짜 끌어놓기가 닿는 바로 그 자리
  // 메인 핸들러를 직접 부른다. _invokeHandlers 는 Electron 내부 것이라, 모양이 바뀌면
  // 조용히 통과하지 않도록 여기서 먼저 확인하고 멈춘다.
  const im = require('electron').ipcMain;
  const handlers = im._invokeHandlers;
  if (!handlers || typeof handlers.get !== 'function' || !handlers.get('compose:attach-dropped')) {
    ok(false, 'compose:attach-dropped 핸들러를 못 찾았다 (Electron 내부 모양이 바뀐 듯)');
    app.exit(1); return;
  }
  const call = (paths) => handlers.get('compose:attach-dropped')(null, paths);
  const r2 = await call([small, folder, '상대경로.txt', '', null]);
  ok(r2.files.length === 1 && r2.files[0].filename === '보고서.pdf' && r2.files[0].size === 1234,
    '진짜 파일 하나만 붙는다 (크기도 맞다)', r2.files);
  ok(r2.skipped.some((s) => s.why.includes('폴더')), '폴더는 까닭을 붙여 돌려준다', r2.skipped);

  console.log('\n[3] 끌고 오는 동안 «놓아도 된다»가 보인다');
  const drag = await wc.executeJavaScript(`(async () => {
    const card = document.querySelector('.card');
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.txt'));
    const fire = (t) => window.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    const out = {};
    fire('dragenter');
    out.들어올때 = card.classList.contains('dropping');
    fire('dragover');
    fire('dragleave');
    await new Promise((r) => setTimeout(r, 30));
    out.나갈때 = card.classList.contains('dropping');
    // 자식 위를 지나며 여러 번 오가도 깜빡이지 않아야 한다
    fire('dragenter'); fire('dragenter'); fire('dragleave');
    out.두번들어와한번나감 = card.classList.contains('dropping');
    fire('dragleave');
    await new Promise((r) => setTimeout(r, 30));
    out.마저나감 = card.classList.contains('dropping');
    return out;
  })()`);
  ok(drag.들어올때 === true, '끌고 들어오면 테두리가 뜬다', drag);
  ok(drag.나갈때 === false, '나가면 사라진다', drag);
  ok(drag.두번들어와한번나감 === true && drag.마저나감 === false,
    '자식 위를 오가도 안 깜빡인다 (깊이를 센다)', drag);

  console.log('\n[4] 진짜 경로를 가진 파일을 놓는다 (다리 → 메인 → 화면 전부)');
  // contextBridge 로 내준 것은 얼어 있어 가짜로 못 바꾼다. 그래서 흉내내지 않고,
  // DevTools 프로토콜로 «디스크에 있는 진짜 파일»을 파일칸에 넣어 File 을 얻는다.
  // 그 File 은 진짜 경로를 가지므로 webUtils 가 경로를 내준다 — 진짜 길 그대로다.
  await wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('DOM.enable');
  async function dropReal(paths) {
    const { result } = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => { let i = document.getElementById('__t');
        if (!i) { i = document.createElement('input'); i.type = 'file'; i.multiple = true;
                  i.id = '__t'; i.style.display = 'none'; document.body.append(i); }
        return i; })()`
    });
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: paths, objectId: result.objectId });
    return wc.executeJavaScript(`(async () => {
      const dt = new DataTransfer();
      for (const f of document.getElementById('__t').files) dt.items.add(f);
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise((r) => setTimeout(r, 500));
      return {
        chips: [...document.querySelectorAll('#files .file:not(.over)')].map((e) => e.querySelector('b').textContent),
        say: document.getElementById('msg').textContent,
        warn: (document.querySelector('#files .file.over') || {}).textContent || ''
      };
    })()`);
  }

  const d1 = await dropReal([small]);
  ok(d1.chips.length === 1 && d1.chips[0] === '보고서.pdf', '놓은 파일이 붙는다', d1);
  ok(/1개/.test(d1.say), '몇 개 붙었는지 알려준다', d1.say);

  const d2 = await dropReal([small]);
  ok(d2.chips.length === 1, '같은 파일을 또 놔도 하나 그대로', d2);
  ok(/이미/.test(d2.say), '이미 있다고 알려준다', d2.say);

  const d3 = await dropReal([other]);
  ok(d3.chips.length === 2 && d3.chips.includes('사진.png'), '다른 파일은 더해진다', d3);

  console.log('\n[5] 한도를 넘으면 보내기를 누르기 «전에» 알려준다');
  const bigFile = path.join(box, '큰파일.zip');
  fs.writeFileSync(bigFile, Buffer.alloc(26 * 1024 * 1024, 1));
  const d4 = await dropReal([bigFile]);
  ok(!!d4.warn, '한도를 넘으면 합계 경고가 뜬다', d4.warn);
  ok(/25(\.0)?MB/.test(d4.warn) && /MB까지만/.test(d4.warn),
    '얼마인지와 얼마까지인지를 같이 말한다', d4.warn);

  console.log('\n[5-2] 폴더를 놓으면 까닭을 말한다');
  const d5 = await dropReal([folder]);
  ok(/폴더/.test(d5.say), '폴더는 못 붙인다고 알려준다', d5.say);

  try { await wc.debugger.detach(); } catch { /* 이미 떨어졌으면 됐다 */ }


  console.log('\n[6] 파일이 아닌 것을 끌면 아무 일도 없다 (글자 끌기 등)');
  const textDrag = await wc.executeJavaScript(`(async () => {
    const card = document.querySelector('.card');
    const dt = new DataTransfer();
    dt.setData('text/plain', '그냥 글자');
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 50));
    return card.classList.contains('dropping');
  })()`);
  ok(textDrag === false, '글자를 끌면 테두리가 안 뜬다', textDrag);

  try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* 무시 */ }
  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  app.exit(bad ? 1 : 0);
});

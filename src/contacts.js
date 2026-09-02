// 주소록 — 자주 주고받는 사람의 이름과 주소.
//
// 쓰기 창의 자동완성과 설정 화면이 쓴다. 모으는 것은 store 가 한다
// (메일을 받고 보낼 때마다 조금씩 쌓인다) — 여기는 «보여주고 고치고 옮기는» 쪽만 맡는다.
//
// 원래 main.js 의 «본문 곳간» 구역 안에 있었다. 이름과 아무 상관이 없었다.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const store = require('./store');
const evlog = require('./evlog');
const contactcsv = require('./contactcsv');

// 파일 고르기 창을 어느 창 위에 띄울지 (설정 창이 열려 있으면 그 위에)
let host = { parentWin: () => null };
function init(h) { host = { ...host, ...h }; }

/** 주소록 — 쓰기 창의 자동완성과 설정 화면이 쓴다 */
ipcMain.handle('mail:contacts', () => store.contacts);
ipcMain.handle('mail:contact-save', (_e, c) => store.saveContact(c || {}));
ipcMain.handle('mail:contact-remove', (_e, address) => store.removeContact(address));

/**
 * 주소록 가져오기 — 아웃룭·구글·엑셀이 내보낸 CSV를 그대로 받는다.
 * 덮어쓰지 않고 합친다 — 이미 있는 사람은 이름만 채워 넣는다.
 * 지우지는 않는다: 가져오기로 주소록이 줄어들면 되돌릴 길이 없다.
 */
ipcMain.handle('mail:contacts-import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(host.parentWin() || undefined, {
    title: '주소록 불러오기',
    filters: [{ name: '주소록 (CSV)', extensions: ['csv', 'txt'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true, contacts: store.contacts };

  let raw;
  try {
    raw = fs.readFileSync(filePaths[0]);
  } catch (e) {
    return { ok: false, message: `파일을 읽지 못했습니다 — ${e.message}`, contacts: store.contacts };
  }
  if (raw.length > 8 * 1024 * 1024) {
    return { ok: false, message: '파일이 너무 큽니다 (8MB까지)', contacts: store.contacts };
  }

  const { text, encoding } = contactcsv.decode(raw);
  const r = contactcsv.toContacts(text);
  if (!r.contacts.length) {
    return {
      ok: false,
      message: r.total
        ? `주소를 찾지 못했습니다 — ${r.total}줄을 봤지만 메일 주소가 없었습니다`
        : '빈 파일입니다',
      contacts: store.contacts
    };
  }

  const before = new Set(store.contacts.map((c) => c.address));
  for (const c of r.contacts) {
    // 이름 없는 줄이 이미 있던 이름을 지우면 안 된다. saveContact는 준 값을 그대로
    // 덮어쓰므로, 빈 이름이면 있던 것을 그대로 다시 넣는다.
    const had = store.contacts.find((x) => x.address === c.address);
    store.saveContact({ address: c.address, name: c.name || (had && had.name) || '' });
  }
  const added = store.contacts.filter((c) => !before.has(c.address)).length;
  const updated = r.contacts.length - added;

  evlog.log('메일', `주소록 가져오기 · ${encoding} · 새로 ${added} · 이미있음 ${updated}`
    + (r.skipped ? ` · 버림 ${r.skipped}` : ''));

  return {
    ok: true,
    contacts: store.contacts,
    added,
    updated,
    skipped: r.skipped,
    encoding,
    message: `${added}명 넣음`
      + (updated ? ` · ${updated}명은 이미 있어 이름만 갱신` : '')
      + (r.skipped ? ` · ${r.skipped}줄은 주소가 없어 건너뜀` : '')
      + (encoding === 'cp949' ? ' · CP949로 읽음' : '')
  };
});

/** 주소록 내보내기 — 엑셀이 한글을 제대로 열도록 BOM을 붙인 UTF-8 */
ipcMain.handle('mail:contacts-export', async () => {
  const list = store.contacts;
  if (!list.length) return { ok: false, message: '내보낼 주소가 없습니다' };

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const { canceled, filePath } = await dialog.showSaveDialog(host.parentWin() || undefined, {
    title: '주소록 내보내기',
    defaultPath: `Hibi 주소록 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.csv`,
    filters: [{ name: '주소록 (CSV)', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(filePath, contactcsv.encode(contactcsv.fromContacts(list)));
  } catch (e) {
    return { ok: false, message: `저장하지 못했습니다 — ${e.message}` };
  }
  evlog.log('메일', `주소록 내보내기 · ${list.length}명 → ${filePath}`);
  return { ok: true, path: filePath, count: list.length, message: `${list.length}명 내보냈습니다` };
});

module.exports = { init };

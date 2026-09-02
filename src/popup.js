// 물어보는 창 · 오른쪽 클릭 메뉴.
//
// 윈도우 기본 대화상자(dialog.showMessageBox)와 기본 메뉴(Menu.popup)를 안 쓴다.
// 유리 마감으로 만든 앱 한가운데 회색 네모가 뜨면 그 순간 남의 프로그램처럼 보인다.
// 대신 우리 페이지를 띄운 작은 창을 쓴다 — renderer/popup.html.
//
// 여기는 «어떻게 보여줄까»만 안다. 무엇을 물을지는 부르는 쪽이 정한다.

const { BrowserWindow, ipcMain, screen } = require('electron');
const glass = require('./glass');
const { PRELOAD, page, glassQuery, lockToOurPage, maxSize, clamp } = require('./win');

const popups = new Map();   // webContents.id → { win, data, done }

/**
 * 팝업 창 하나를 띄우고 사용자가 고를 때까지 기다린다.
 *
 * 창을 따로 띄우는 이유: 위젯은 270px밖에 안 된다. 그 안에 겹쳐 그리면 긴 메뉴도
 * 두 줄짜리 물음도 들어가지 않는다. 창이면 부모 밖으로 나갈 수 있다.
 *
 * @param at 화면 좌표 {x,y}. 주면 그 자리(메뉴), 없으면 부모 한가운데(물음).
 */
function openPopup(parent, data, at) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 320, height: 160,
      show: false,
      frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true,
      // 부모 위에 뜨고, 부모를 따라 다닌다. 모달로 두지 않는 이유는
      // 투명 창에서 모달이 그림자·둥근 모서리를 망가뜨리기 때문이다.
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      alwaysOnTop: true,
      ...glass.windowOptions(),
      webPreferences: { preload: PRELOAD }
    });
    const id = win.webContents.id;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      popups.delete(id);
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    popups.set(id, { win, data, done, at });

    // 창 밖을 누르면 그만둔 것으로 — 메뉴는 이게 없으면 빠져나갈 길이 없다
    win.on('blur', () => done(null));
    win.on('closed', () => done(null));

    lockToOurPage(win);
    win.loadFile(page('popup.html'), { query: glassQuery({}) });
  });
}

/** 앱 마감의 «물어보기» — 고른 단추 번호를 준다 (그만두면 null) */
async function askUser(parent, { title, message, detail, buttons, defaultId = 0, danger = false }) {
  const r = await openPopup(parent, {
    kind: 'dialog', title, message, detail, buttons, defaultId, danger
  });
  return typeof r === 'number' ? r : null;
}

/** 앱 마감의 오른쪽 클릭 메뉴 — 고른 항목의 id를 준다 (그만두면 null) */
function pickFromMenu(parent, items, at) {
  return openPopup(parent, { kind: 'menu', items }, at);
}

ipcMain.handle('popup:data', (e) => {
  const p = popups.get(e.sender.id);
  return p ? p.data : null;
});

// 화면이 «이만큼 필요하다»고 하면 그때 크기를 잡고 보여준다.
// 먼저 보여주고 크기를 고치면 창이 한 번 튀어 보인다.
ipcMain.on('popup:size', (e, { width, height }) => {
  const p = popups.get(e.sender.id);
  if (!p || p.win.isDestroyed()) return;
  const cap = maxSize(p.win);
  const w = Math.round(clamp(width || 320, 200, Math.min(560, cap.width)));
  const h = Math.round(clamp(height || 160, 90, cap.height));

  // 화면 밖으로 나가지 않게 — 커서 옆에 띄우는 메뉴가 특히 그렇다
  const area = screen.getDisplayNearestPoint(
    p.at || screen.getCursorScreenPoint()).workArea;
  let x;
  let y;
  if (p.at) {
    x = p.at.x;
    y = p.at.y;
  } else if (p.win.getParentWindow() && !p.win.getParentWindow().isDestroyed()) {
    const b = p.win.getParentWindow().getBounds();
    x = b.x + Math.round((b.width - w) / 2);
    y = b.y + Math.round((b.height - h) / 2);
  } else {
    x = area.x + Math.round((area.width - w) / 2);
    y = area.y + Math.round((area.height - h) / 2);
  }
  x = Math.round(clamp(x, area.x, area.x + area.width - w));
  y = Math.round(clamp(y, area.y, area.y + area.height - h));

  p.win.setBounds({ x, y, width: w, height: h });
  p.win.show();
  p.win.focus();
});

/**
 * 아무 창이나 앱 마감의 고르기 목록을 띄울 수 있게.
 * 네이티브 <select>를 대신한다 — 그 드롭다운은 CSS로 손댈 수 없어서
 * 유리 마감 한가운데 윈도우 기본 목록이 튀어나온다.
 */
ipcMain.handle('ui:menu', (e, items) => pickFromMenu(
  BrowserWindow.fromWebContents(e.sender), items || [], screen.getCursorScreenPoint()));

ipcMain.on('popup:pick', (e, value) => {
  const p = popups.get(e.sender.id);
  if (p) p.done(value === undefined ? null : value);
});

module.exports = { askUser, pickFromMenu };

// 기록 창 — 통계 + 종류별 상세.
//
// 바깥에는 «열기»와 «기록이 바뀌었다고 알리기»만 내준다. 창 안의 조작(주 수 바꾸기·
// 지금 쉬기·닫기)은 여기서 IPC 로 직접 받는다.

const { BrowserWindow, ipcMain } = require('electron');
const store = require('./store');
const glass = require('./glass');
const reminders = require('./reminders');
const { PRELOAD, page, PAD, clamp, glassQuery, lockToOurPage } = require('./win');

let statsWin = null;

// 스케줄러와 «지금 쉬기»는 main.js 가 들고 있다. 순환 require 대신 시작할 때 받아 둔다.
let host = { scheduler: null, startBreak: () => {} };
function init(h) { host = { ...host, ...h }; }

function openStats(focusType) {
  if (statsWin && !statsWin.isDestroyed()) {
    statsWin.focus();
    if (focusType) statsWin.webContents.send('stats:focus', focusType);
    return;
  }
  statsWin = new BrowserWindow({
    width: 316 + PAD,      // 15주 잔디에 맞춰 폭을 좁게 (더 긴 기간은 가로 스크롤)
    height: 452 + PAD,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...glass.windowOptions(),
    webPreferences: { preload: PRELOAD }
  });
  // 우리 페이지 밖으로 못 나가게 (남의 주소로 가면 이 창이 다리를 쥔 브라우저가 된다)
  lockToOurPage(statsWin);
  statsWin.loadFile(page('stats.html'), {
    query: glassQuery({ radius: '20', focus: focusType || '' })
  });
  statsWin.on('closed', () => { statsWin = null; });
}

/** 위젯 안 달력을 펼친다 (별도 창을 두지 않고 위젯이 길어진다) */
// 구독 주소는 15분마다 다시 읽는다. 그런데 사용자가 방금 일정을 고치고 달력을 열면
// 그때까지 옛 내용을 보게 된다 — 열 때 한 번 더 읽는다. 너무 자주 부르지는 않는다.

function statsPayloadFull(typeId) {
  const custom = store.custom;
  const weeks = store.settings.grassWeeks || 15;
  const active = host.scheduler.activeIds();
  const now = Date.now();

  const tabs = active.map((id) => {
    const at = host.scheduler.nextAt.get(id);
    return {
      ...reminders.meta(id, custom),
      remaining: at ? Math.max(0, Math.round((at - now) / 1000)) : null
    };
  });

  const sel = typeId && active.includes(typeId) ? typeId : null;
  const g = store.grassSeries(weeks, sel);
  const st = store.streaks(sel);

  return {
    weeks,
    selected: sel,
    tabs,
    grass: g.cells,
    max: g.max,
    streak: st,
    today: store.todayCount(sel),
    detail: sel ? tabs.find((t) => t.id === sel) : null
  };
}

ipcMain.handle('stats:data', (_e, typeId) => statsPayloadFull(typeId));
ipcMain.on('stats:set-weeks', (_e, weeks) => {
  store.setSettings({ grassWeeks: clamp(Math.round(weeks), 4, 53) });
});
ipcMain.on('stats:break-now', (_e, id) => { if (id) host.startBreak([id]); });
ipcMain.on('stats:close', () => statsWin && statsWin.close());

ipcMain.on('widget:open-stats', (_e, id) => openStats(id || null));

/** 기록이 바뀌었다 (휴식을 마쳤다) — 열려 있으면 다시 그리게 한다 */
function notifyChanged() {
  if (statsWin && !statsWin.isDestroyed()) statsWin.webContents.send('stats:changed');
}

/** 디버그 모드 방송처럼 «열려 있는 창 목록»에 끼워 넣을 때 */
function win() { return statsWin && !statsWin.isDestroyed() ? statsWin : null; }

module.exports = { init, openStats, notifyChanged, win };

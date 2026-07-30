const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nunsseom', {
  // 위젯
  onTick: (cb) => ipcRenderer.on('tick', (_e, data) => cb(data)),
  onScrim: (cb) => ipcRenderer.on('scrim', (_e, v) => cb(v)),
  onRadius: (cb) => ipcRenderer.on('radius', (_e, v) => cb(v)),
  togglePause: () => ipcRenderer.send('widget:toggle-pause'),
  breakNow: (id) => ipcRenderer.send('widget:break-now', id),
  openSettings: () => ipcRenderer.send('widget:open-settings'),
  hideWidget: () => ipcRenderer.send('widget:hide'),
  resizeWidget: (size) => ipcRenderer.send('widget:resize', size),
  getWidgetSize: () => ipcRenderer.invoke('widget:get-size'),
  getWidgetPos: () => ipcRenderer.invoke('widget:get-pos'),
  moveWidget: (pos) => ipcRenderer.send('widget:move', pos),

  // 오버레이
  getOverlayBg: (displayId) => ipcRenderer.invoke('overlay:get-bg', displayId),
  getBreakPayload: () => ipcRenderer.invoke('overlay:get-payload'),
  snooze: () => ipcRenderer.send('overlay:snooze'),
  skip: () => ipcRenderer.send('overlay:skip'),
  finish: () => ipcRenderer.send('overlay:done'),

  // 설정
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApp: (patch) => ipcRenderer.send('settings:set-app', patch),
  setReminder: (id, patch) => ipcRenderer.send('settings:set-reminder', { id, patch }),
  closeSettings: () => ipcRenderer.send('settings:close'),

  // 캘린더
  calAdd: (name, url) => ipcRenderer.invoke('cal:add', { name, url }),
  calUpdate: (id, patch) => ipcRenderer.invoke('cal:update', { id, patch }),
  calRemove: (id) => ipcRenderer.invoke('cal:remove', id),
  calRefresh: () => ipcRenderer.invoke('cal:refresh'),
  calTest: (url) => ipcRenderer.invoke('cal:test', url),

  // 자동 실행 (OS 상태를 그대로 읽고 쓴다)
  autoLaunchGet: () => ipcRenderer.invoke('autolaunch:get'),
  autoLaunchSet: (on) => ipcRenderer.invoke('autolaunch:set', on),

  // 기록
  statsGet: () => ipcRenderer.invoke('stats:get'),
  statsResetToday: () => ipcRenderer.invoke('stats:reset-today'),
  statsResetAll: () => ipcRenderer.invoke('stats:reset-all'),

  // 업데이트
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateInstall: () => ipcRenderer.send('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s))
});

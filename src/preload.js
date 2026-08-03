const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nunsseom', {
  // 위젯
  onTick: (cb) => ipcRenderer.on('tick', (_e, data) => cb(data)),
  onScrim: (cb) => ipcRenderer.on('scrim', (_e, v) => cb(v)),
  onRadius: (cb) => ipcRenderer.on('radius', (_e, v) => cb(v)),
  togglePause: () => ipcRenderer.send('widget:toggle-pause'),
  breakNow: (id) => ipcRenderer.send('widget:break-now', id),
  openSettings: () => ipcRenderer.send('widget:open-settings'),
  openStats: (id) => ipcRenderer.send('widget:open-stats', id),
  hideWidget: () => ipcRenderer.send('widget:hide'),

  // 기록 창
  statsData: (typeId) => ipcRenderer.invoke('stats:data', typeId),
  statsSetWeeks: (weeks) => ipcRenderer.send('stats:set-weeks', weeks),
  statsBreakNow: (id) => ipcRenderer.send('stats:break-now', id),
  statsClose: () => ipcRenderer.send('stats:close'),
  onStatsChanged: (cb) => ipcRenderer.on('stats:changed', () => cb()),
  onStatsFocus: (cb) => ipcRenderer.on('stats:focus', (_e, id) => cb(id)),
  resizeWidget: (size) => ipcRenderer.send('widget:resize', size),
  getWidgetSize: () => ipcRenderer.invoke('widget:get-size'),
  getWidgetPos: () => ipcRenderer.invoke('widget:get-pos'),
  getWidgetBounds: () => ipcRenderer.invoke('widget:get-bounds'),
  setWidgetBounds: (b) => ipcRenderer.send('widget:set-bounds', b),

  // 이벤트 기록 (트레이에서 켤 때만 동작)
  debugLog: (source, message) => ipcRenderer.send('debug:log', { source, message }),
  onDebugMode: (cb) => ipcRenderer.on('debug:mode', (_e, on) => cb(on)),
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
  customAdd: (def) => ipcRenderer.invoke('settings:custom-add', def),
  customUpdate: (id, patch) => ipcRenderer.invoke('settings:custom-update', { id, patch }),
  customRemove: (id) => ipcRenderer.invoke('settings:custom-remove', id),
  closeSettings: () => ipcRenderer.send('settings:close'),

  // 캘린더
  calAdd: (name, url) => ipcRenderer.invoke('cal:add', { name, url }),
  calUpdate: (id, patch) => ipcRenderer.invoke('cal:update', { id, patch }),
  calRemove: (id) => ipcRenderer.invoke('cal:remove', id),
  calRefresh: () => ipcRenderer.invoke('cal:refresh'),
  calTest: (url) => ipcRenderer.invoke('cal:test', url),
  calClipboard: () => ipcRenderer.invoke('cal:clipboard'),
  calMonth: (year, month) => ipcRenderer.invoke('cal:month', { year, month }),
  openCalendar: () => ipcRenderer.send('cal:open'),
  calPanel: (info) => ipcRenderer.send('cal:panel', info),
  calOpenEvent: (ev) => ipcRenderer.invoke('cal:open-event', ev),
  calNewEvent: (range) => ipcRenderer.invoke('cal:new-event', range),
  onCalShow: (cb) => ipcRenderer.on('cal:show', () => cb()),
  onCalChanged: (cb) => ipcRenderer.on('cal:changed', () => cb()),
  calOpenHelp: (which) => ipcRenderer.invoke('cal:open-help', which),

  // 메일 (비밀번호는 메인에서만 다룬다)
  mailGet: () => ipcRenderer.invoke('mail:get'),
  mailTest: (acc) => ipcRenderer.invoke('mail:test', acc),
  mailAdd: (acc) => ipcRenderer.invoke('mail:add', acc),
  mailUpdate: (id, patch) => ipcRenderer.invoke('mail:update', { id, patch }),
  mailRemove: (id) => ipcRenderer.invoke('mail:remove', id),
  mailRefresh: () => ipcRenderer.invoke('mail:refresh'),
  mailOpen: (msg) => ipcRenderer.invoke('mail:open', msg),
  mailViewData: () => ipcRenderer.invoke('mail:view-data'),
  mailViewClose: () => ipcRenderer.send('mail:view-close'),
  mailSaveAttachment: (i) => ipcRenderer.invoke('mail:save-attachment', i),
  mailReveal: (p) => ipcRenderer.send('mail:reveal', p),
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url),

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

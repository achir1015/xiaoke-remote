'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('xk', {
  settings: { get: inv('settings:get'), set: inv('settings:set'), newDeviceId: inv('settings:newDeviceId') },
  sys: { info: inv('sys:info'), permissions: inv('sys:permissions'), askMicrophone: inv('sys:askMicrophone'), openPrivacy: inv('sys:openPrivacy') },
  cap: { sources: inv('cap:sources'), windows: inv('cap:windows'), screenshot: inv('cap:screenshot') },
  input: {
    event: (ev) => ipcRenderer.send('input:event', ev),
    session: inv('input:session'),
    setDisplay: inv('input:setDisplay'),
    log: inv('input:log'),
  },
  fs: {
    roots: inv('fs:roots'), list: inv('fs:list'), openRead: inv('fs:openRead'), openWrite: inv('fs:openWrite'),
    mkdir: inv('fs:mkdir'), delete: inv('fs:delete'), run: inv('fs:run'),
  },
  io: { read: inv('io:read'), write: inv('io:write'), close: inv('io:close') },
  local: {
    pickFiles: inv('local:pickFiles'), pickFolder: inv('local:pickFolder'), openRead: inv('local:openRead'), readAll: inv('local:readAll'),
    saveTo: inv('local:saveTo'), openIncoming: inv('local:openIncoming'), reveal: inv('local:reveal'), open: inv('local:open'),
  },
  teach: { prepare: inv('teach:prepare') },
  folders: { installArea: inv('folders:installArea') },
  win: { fullscreen: inv('win:fullscreen'), attention: inv('win:attention'), minimize: inv('win:minimize'), restore: inv('win:restore') },
  clip: { read: inv('clip:read'), write: inv('clip:write') },
  openExternal: inv('app:openExternal'),
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  setConfig: (patch) => ipcRenderer.send('cfg:set', patch),
  onConfig: (cb) => ipcRenderer.on('cfg:changed', (_e, c) => cb(c)),
  onPassthrough: (cb) => ipcRenderer.on('ui:passthrough', (_e, v) => cb(v)),
  openSettings: () => ipcRenderer.send('ui:settings'),
  closeSettings: () => ipcRenderer.send('ui:close-settings'),
  openMenu: () => ipcRenderer.send('ui:menu'),
  getLogin: () => ipcRenderer.invoke('app:login'),
  setLogin: (v) => ipcRenderer.send('app:set-login', v)
});

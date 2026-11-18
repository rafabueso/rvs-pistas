'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (c, ...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('descargador', {
  checkUpdate: () => invoke('update:check'),
  openUpdate: () => invoke('update:open'),
  readClipboard: () => invoke('clipboard:read'),
  probe: (url) => invoke('probe', url),
  folder: () => invoke('folder:get'),
  chooseFolder: () => invoke('folder:choose'),
  download: (opts, onProgress) => {
    const l = (_e, evt) => { if (onProgress) onProgress(evt); };
    ipcRenderer.on('engine:progress', l);
    return invoke('download', opts).finally(() => ipcRenderer.removeListener('engine:progress', l));
  },
  cancel: () => invoke('cancel'),
  show: (p) => invoke('shell:show', p),
  recent: () => invoke('recent:list'),
  removeRecent: (p) => invoke('recent:remove', p),
  showRecent: (p, which) => invoke('recent:show', { path: p, which }),
  pickFile: () => invoke('file:pick'),
  karaoke: (opts, onProgress) => {
    const l = (_e, evt) => { if (onProgress) onProgress(evt); };
    ipcRenderer.on('engine:progress', l);
    return invoke('karaoke', opts).finally(() => ipcRenderer.removeListener('engine:progress', l));
  },
});

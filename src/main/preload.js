'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Cada llamada devuelve { ok, data } o { ok: false, error: { code, message } }.
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('pistas', {
  checkUpdate: () => invoke('update:check'),
  openUpdate: () => invoke('update:open'),
  readClipboard: () => invoke('clipboard:read'),
  probe: (url) => invoke('probe', url),
  pickFile: () => invoke('file:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  process: (opts, onProgress) => {
    const listener = (_e, id, evt) => { if (id === opts.jobId && onProgress) onProgress(evt); };
    ipcRenderer.on('engine:progress', listener);
    return invoke('process', opts).finally(() => ipcRenderer.removeListener('engine:progress', listener));
  },
  cancel: (jobId) => invoke('process:cancel', jobId),
  library: () => invoke('library:list'),
  remove: (id) => invoke('library:delete', id),
  saveExport: (wav, format, name) => invoke('export:save', { wav, format, name }),
  showInFolder: (p) => invoke('shell:show', p),
});

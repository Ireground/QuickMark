const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qmNative', {
  list: (coll) => ipcRenderer.invoke('db:list', coll),
  get: (coll, id) => ipcRenderer.invoke('db:get', coll, id),
  set: (coll, id, data) => ipcRenderer.invoke('db:set', coll, id, data),
  update: (coll, id, patch) => ipcRenderer.invoke('db:update', coll, id, patch),
  del: (coll, id) => ipcRenderer.invoke('db:del', coll, id),
  upload: (buf, type) => ipcRenderer.invoke('asset:upload', buf, type),
  saveFile: (name, buf) => ipcRenderer.invoke('file:save', name, buf)
});

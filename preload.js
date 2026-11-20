const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bloom', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  setLayout: (layout) => ipcRenderer.send('win:layout', layout),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: (busy) => ipcRenderer.send('win:close', busy),
  show: () => ipcRenderer.send('win:show'),
  quit: () => ipcRenderer.send('app:quit'),
  onLayout: (fn) => ipcRenderer.on('layout', (_e, l) => fn(l)),
  onMaximized: (fn) => ipcRenderer.on('maximized', (_e, m) => fn(m))
});

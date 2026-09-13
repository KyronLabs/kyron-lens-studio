// src/main/preload.cjs
//
// The whole surface the renderer is given. Four calls and a menu channel.
//
// Written out by name rather than exposing ipcRenderer: a renderer that can
// invoke arbitrary channels is a renderer that can do whatever the main
// process can, and the point of keeping this short is that somebody can read
// it and know what the window is able to do.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  openProject: () => ipcRenderer.invoke('open-project'),
  saveProject: (text) => ipcRenderer.invoke('save-project', text),
  importArtwork: () => ipcRenderer.invoke('import-artwork'),
  publish: (plan) => ipcRenderer.invoke('publish', plan),
  onMenu: (handler) => {
    ipcRenderer.on('menu', (_event, action) => handler(action));
  },
});

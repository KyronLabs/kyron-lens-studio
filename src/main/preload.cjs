// src/main/preload.cjs
//
// The whole surface the renderer is given. Six calls.
//
// Written out by name rather than exposing ipcRenderer: a renderer that can
// invoke arbitrary channels is a renderer that can do whatever the main
// process can, and the point of keeping this short is that somebody can read
// it and know what the window is able to do.
//
// Four of them touch the disk only where a person picked the place. The two
// artwork calls reach the network, and reach only the Kyron artwork library --
// main.js checks every URL against the catalogue it fetched, so `artworkFetch`
// is not a way to ask the main process to request an arbitrary address.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  openProject: () => ipcRenderer.invoke('open-project'),
  saveProject: (text) => ipcRenderer.invoke('save-project', text),
  importArtwork: () => ipcRenderer.invoke('import-artwork'),
  publish: (plan) => ipcRenderer.invoke('publish', plan),
  artworkCatalogue: () => ipcRenderer.invoke('artwork-catalogue'),
  artworkFetch: (url) => ipcRenderer.invoke('artwork-fetch', url),
});

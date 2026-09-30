'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = ['island:frame', 'state:update', 'media:tick', 'system:tick', 'helper:event', 'toast'];

/**
 * The renderer is a plain web page: it can read a state snapshot, fire named
 * actions and receive pushes. No Node, no raw ipcRenderer.
 */
contextBridge.exposeInMainWorld('island', {
  getState: () => ipcRenderer.invoke('state:request'),
  action: (name, args = {}) => ipcRenderer.send('action', { name, args }),
  requestSize: (size) => ipcRenderer.send('island:request-size',
    typeof size === 'number' ? { width: size } : size ?? {}),
  pointer: (inside) => ipcRenderer.send('island:pointer', { inside }),
  drag: (phase, deltaY) => ipcRenderer.send('island:drag', { phase, deltaY: deltaY ?? 0 }),
  on: (channel, listener) => {
    if (!INBOUND.includes(channel)) throw new Error(`channel ${channel} is not available`);
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

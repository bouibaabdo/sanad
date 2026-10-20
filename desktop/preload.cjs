const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sanadDesktop', {
  isDesktop: true,
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSignalOrigin: () => ipcRenderer.invoke('signal:get-origin'),
  setSignalOrigin: (origin) => ipcRenderer.invoke('signal:set-origin', origin),
  getPreferences: () => ipcRenderer.invoke('settings:get'),
  savePreferences: (settings) => ipcRenderer.invoke('settings:save', settings),
  getDeviceIdentity: () => ipcRenderer.invoke('device:get'),
  clearSharedDisplay: () => ipcRenderer.invoke('display:clear-selection'),
  setDevicePassword: (password) => ipcRenderer.invoke('device:set-password', password),
  registerDeviceSession: (offer) => ipcRenderer.invoke('device:register', offer),
  getDeviceAnswer: () => ipcRenderer.invoke('device:answer'),
  unregisterDeviceSession: () => ipcRenderer.invoke('device:unregister'),
  requestControl: (scopes) => ipcRenderer.invoke('control:request', scopes),
  applyInput: (command) => ipcRenderer.invoke('control:input', command),
  revokeControl: () => ipcRenderer.invoke('control:revoke'),
  releaseInput: () => ipcRenderer.invoke('control:release'),
  platform: process.platform,
  onInputError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('control:error', listener);
    return () => ipcRenderer.removeListener('control:error', listener);
  },
});

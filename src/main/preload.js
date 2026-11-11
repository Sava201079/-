'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Тема нужна до первой отрисовки, поэтому читаем её синхронно (theme.js ставит data-theme на <html>).
let theme = 'light';
try { theme = ipcRenderer.sendSync('settings:theme') || 'light'; } catch { /* останется светлая */ }

contextBridge.exposeInMainWorld('api', {
  theme,
  info: call('app:info'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  getVersions: call('versions:list'),

  play: call('play:start'),
  cancel: call('play:cancel'),
  stop: call('play:stop'),
  onProgress: listen('play:progress'),
  onState: listen('play:state'),
  onLog: listen('play:log'),

  skins: {
    list: call('skins:list'),
    get: call('skins:get'),
    create: call('skins:create'),
    save: call('skins:save'),
    remove: call('skins:remove'),
    setActive: call('skins:setActive'),
    import: call('skins:import'),
    export: call('skins:export'),
    fetchNick: call('skins:fetchNick'),
  },

  accounts: {
    list: call('accounts:list'),
    addOffline: call('accounts:addOffline'),
    rename: call('accounts:rename'),
    setActive: call('accounts:setActive'),
    remove: call('accounts:remove'),
    elyLogin: call('accounts:elyLogin'),
    cancelLogin: call('accounts:loginCancel'),
  },
  openExternal: call('shell:openExternal'),
  copy: call('app:copy'),

  friends: {
    get: call('friends:get'),
    enable: call('friends:enable'),
    setConfig: call('friends:setConfig'),
    sync: call('friends:sync'),
    request: call('friends:request'),
    accept: call('friends:accept'),
    decline: call('friends:decline'),
    remove: call('friends:remove'),
    newCode: call('friends:newCode'),
    setHidden: call('friends:setHidden'),
    setAvatar: call('friends:setAvatar'),
    delete: call('friends:delete'),
    onState: listen('friends:state'),
  },

  pickDir: call('dialog:pickDir'),
  pickJava: call('dialog:pickJava'),
  openGameDir: call('shell:openGameDir'),

  win: {
    minimize: call('win:minimize'),
    toggleMaximize: call('win:toggleMaximize'),
    close: call('win:close'),
    onMaximized: listen('win:maximized'),
  },
});

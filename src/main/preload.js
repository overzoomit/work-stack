const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('work', {
  app: {
    info: invoke('app:info'),
    pickFolder: invoke('app:pickFolder'),
    openExternal: (url) => ipcRenderer.send('app:openExternal', url),
    copy: (text) => ipcRenderer.send('app:copy', text),
    paste: invoke('app:paste'),
    // Path of a file dropped on the window (File.path is gone since Electron 32).
    pathForFile: (file) => webUtils.getPathForFile(file),
    onFocus: listen('app:focus'),
  },
  projects: {
    load: invoke('projects:load'),
    save: invoke('projects:save'),
  },
  pty: {
    create: invoke('pty:create'),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    ack: (id, chars) => ipcRenderer.send('pty:ack', id, chars),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    cwd: invoke('pty:cwd'),
    onData: listen('pty:data'),
    onExit: listen('pty:exit'),
  },
  git: {
    root: invoke('git:root'),
    status: invoke('git:status'),
    log: invoke('git:log'),
    branches: invoke('git:branches'),
    commit: invoke('git:commit'),
    containing: invoke('git:containing'),
    fileDiff: invoke('git:fileDiff'),
    action: invoke('git:action'),
    watch: (repo) => ipcRenderer.send('git:watch', repo),
    unwatch: (repo) => ipcRenderer.send('git:unwatch', repo),
    onChanged: listen('git:changed'),
  },
  fs: {
    list: invoke('fs:list'),
    read: invoke('fs:read'),
    create: invoke('fs:create'),
    rename: invoke('fs:rename'),
    move: invoke('fs:move'),
    copyIn: invoke('fs:copyIn'),
    trash: invoke('fs:trash'),
    openPath: invoke('fs:openPath'),
    reveal: invoke('fs:reveal'),
  },
  run: {
    detect: invoke('run:detect'),
  },
  agents: {
    list: invoke('agents:list'),
    events: invoke('agents:events'),
    stop: invoke('agents:stop'),
    hasHistory: invoke('agents:hasHistory'),
    available: invoke('agents:available'),
    onUpdate: listen('agents:update'),
  },
});

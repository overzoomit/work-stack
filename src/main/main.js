const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const { PtyManager } = require('./pty');
const git = require('./git');
const fsops = require('./fsops');
const store = require('./store');
const runconfigs = require('./runconfigs');
const { AgentWatcher } = require('./agents');
const { GitWatcher } = require('./gitwatch');

// Debug/tests: keep state separate from the real profile.
if (process.env.WORK_USER_DATA) app.setPath('userData', process.env.WORK_USER_DATA);
const TEST_MODE = !!(process.env.WORK_SCREENSHOT || process.env.WORK_EVAL);

const ptys = new PtyManager();
let win = null;
let agents = null;
const gitWatcher = new GitWatcher((repo) => send('git:changed', repo));
let state = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 640,
    title: 'Work',
    backgroundColor: '#0c0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    // Automated test runs must never steal focus (and keystrokes) from the user.
    show: !TEST_MODE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  if (TEST_MODE) win.showInactive();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('focus', () => send('app:focus'));

  if (process.env.WORK_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  // Debug: WORK_SCREENSHOT=/path/file.png saves a capture a few seconds after load.
  if (process.env.WORK_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(process.env.WORK_SCREENSHOT, img.toPNG());
    }, Number(process.env.WORK_SCREENSHOT_DELAY || 5000)));
  }
  // Debug: WORK_EVAL runs a snippet in the page once it has booted.
  if (process.env.WORK_EVAL) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(() => win.webContents.executeJavaScript(process.env.WORK_EVAL)
        .then((r) => r !== undefined && console.log('[eval]', r))
        .catch((e) => console.error('[eval]', e)), 2000));
  }
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.error(`[renderer] ${e.message}`);
  });
}

// ── Projects ─────────────────────────────────────────────────
ipcMain.handle('projects:load', () => state);
ipcMain.handle('projects:save', (_e, next) => {
  state = { ...state, ...next };
  fsops.setRoots(state.projects.map((p) => p.path));
  store.save(state);
});

// ── Terminals ────────────────────────────────────────────────
ipcMain.handle('pty:create', (_e, opts) =>
  ptys.create(opts, (id, data) => send('pty:data', id, data), (id, code) => send('pty:exit', id, code)));
ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
ipcMain.on('pty:kill', (_e, id) => ptys.kill(id));
ipcMain.handle('pty:cwd', (_e, id) => ptys.cwd(id));

// ── Git ──────────────────────────────────────────────────────
ipcMain.handle('git:root', (_e, cwd) => git.root(cwd));
ipcMain.handle('git:status', (_e, repo, opts) => git.status(repo, opts));
ipcMain.handle('git:log', (_e, repo) => git.log(repo));
ipcMain.handle('git:branches', (_e, repo) => git.branches(repo));
ipcMain.handle('git:commit', (_e, repo, hash) => git.commit(repo, hash));
ipcMain.handle('git:containing', (_e, repo, hash) => git.containing(repo, hash));
ipcMain.handle('git:fileDiff', (_e, repo, spec) => git.fileDiff(repo, spec));
ipcMain.handle('git:action', (_e, repo, name, params) => git.action(repo, name, params));
ipcMain.on('git:watch', (_e, repo) => gitWatcher.watch(repo));
ipcMain.on('git:unwatch', (_e, repo) => gitWatcher.unwatch(repo));

// ── File system (Project tree) ───────────────────────────────
ipcMain.handle('fs:list', (_e, dir) => fsops.list(dir));
ipcMain.handle('fs:read', (_e, file) => fsops.read(file));
ipcMain.handle('fs:create', (_e, parent, name, dir) => fsops.create(parent, name, dir));
ipcMain.handle('fs:rename', (_e, from, name) => fsops.rename(from, name));
ipcMain.handle('fs:move', (_e, from, toDir) => fsops.move(from, toDir));
ipcMain.handle('fs:trash', (_e, p) => fsops.trash(p));
ipcMain.handle('fs:openPath', (_e, p) => fsops.openPath(p));
ipcMain.handle('fs:reveal', (_e, p) => fsops.reveal(p));

// ── Run configurations ───────────────────────────────────────
ipcMain.handle('run:detect', (_e, dir) => runconfigs.detect(dir));

// ── Agents ───────────────────────────────────────────────────
ipcMain.handle('agents:list', () => agents?.list() ?? []);

// Which agent CLIs are installed, resolved through a login shell so
// nvm / ~/.local/bin paths are found like in a normal terminal.
ipcMain.handle('agents:available', (_e, commands) => new Promise((resolve) => {
  const safe = commands.filter((c) => /^[\w.-]+$/.test(c));
  const shell = process.env.SHELL || '/bin/bash';
  const script = safe.map((c) => `command -v ${c} >/dev/null 2>&1 && echo ${c}`).join('; ');
  require('child_process').execFile(shell, ['-lc', `${script}; true`], { timeout: 8000 }, (_err, stdout) => {
    resolve((stdout || '').split('\n').filter((c) => safe.includes(c)));
  });
}));

// ── App ──────────────────────────────────────────────────────
ipcMain.handle('app:info', () => ({
  home: os.homedir(),
  cwd: process.env.WORK_CWD || process.cwd(),
  platform: process.platform,
}));
ipcMain.handle('app:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('app:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('app:paste', () => clipboard.readText());

app.whenReady().then(() => {
  state = store.load();
  fsops.setRoots(state.projects.map((p) => p.path));
  createWindow();
  agents = new AgentWatcher((list) => send('agents:update', list));
  agents.start();
});

app.on('window-all-closed', () => {
  agents?.stop();
  gitWatcher.stop();
  ptys.killAll();
  app.quit();
});

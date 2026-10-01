// window.work: the backend's API over Tauri's IPC. Positional arguments
// become the named ones each Rust command takes.
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const { listen: on } = window.__TAURI__.event;

  // Every command is timed here: a slow one (over 2 s) and a failed one go to
  // the log. The folder picker and the log export wait for the user.
  const waitsForUser = new Set(['app_pick_folder', 'app_export_log']);
  const call = (cmd, ...names) => (...args) => {
    const start = performance.now();
    const slow = () => {
      const ms = Math.round(performance.now() - start);
      if (ms > 2000 && !waitsForUser.has(cmd)) log('warn', `lento: ${cmd} ${ms} ms`);
    };
    return invoke(cmd, Object.fromEntries(names.map((n, i) => [n, args[i]]))).then(
      (r) => { slow(); return r; },
      // A git action's error is git's stderr (hooks quoting a commit message):
      // the backend already logged it without that part.
      (e) => { slow(); log('warn', cmd === 'git_action' ? `${cmd} fallito` : `${cmd} fallito: ${e?.message ?? e}`); throw e; },
    );
  };
  // Fire and forget, like ipcRenderer.send: a failure has no caller to reach.
  const send = (cmd, ...names) => (...args) => { call(cmd, ...names)(...args).catch(() => {}); };
  const listen = (event) => (cb) => {
    const off = on(event, (e) => cb(...e.payload));
    return () => off.then((un) => un());
  };

  // Terminal output and exits come through one channel, in order: [id, text] or [id, null, code].
  const ptyData = new Set();
  const ptyExit = new Set();
  let ptyChannel = null;
  const ptyListen = (set) => (cb) => {
    if (!ptyChannel) {
      ptyChannel = new Channel();
      ptyChannel.onmessage = ([id, text, code]) => {
        if (text === null) ptyExit.forEach((f) => f(id, code));
        else ptyData.forEach((f) => f(id, text));
      };
      invoke('pty_subscribe', { channel: ptyChannel });
    }
    set.add(cb);
    return () => set.delete(cb);
  };

  // Errors and warnings go to the terminal that started Work.
  const log = (level, msg) => invoke('debug_log', { level, msg: String(msg) }).catch(() => {});
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = (...args) => { orig(...args); log(level, args.join(' ')); };
  }
  window.addEventListener('error', (e) => log('error', e.error?.stack || e.message));
  window.addEventListener('unhandledrejection', (e) => log('error', e.reason?.stack || e.reason));

  // A JS stall: the 1 s timer fires late. Only with the page visible, since
  // WebKit slows the timers of hidden pages on purpose.
  let tick = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - tick > 3000 && document.visibilityState === 'visible') log('warn', `renderer fermo ${Math.round(now - tick)} ms`);
    tick = now;
  }, 1000);
  document.addEventListener('visibilitychange', () => { tick = performance.now(); });

  // Files dragged in from outside carry only their names in the page, matched
  // here with their paths: macOS keeps them on the drag pasteboard (read as
  // the drag enters), Linux sends them as text/uri-list with the drop.
  let dropped = [];
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types.includes('Files')) invoke('app_drop_paths').then((p) => { dropped = p; }, () => {});
  }, true);
  window.addEventListener('drop', (e) => {
    const uris = (e.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/).filter((u) => u.startsWith('file://'));
    if (uris.length) dropped = uris.map((u) => decodeURIComponent(new URL(u).pathname));
  }, true);

  window.work = {
    app: {
      info: call('app_info'),
      stats: call('app_stats'),
      pickFolder: call('app_pick_folder'),
      exportLog: call('app_export_log'),
      revealExport: call('app_reveal_export'),
      openExternal: send('app_open_external', 'url'),
      copy: send('app_copy', 'text'),
      paste: call('app_paste'),
      pathForFile: (file) => dropped.find((p) => p.split('/').pop() === file.name) || null,
      onFocus: listen('app:focus'),
      onOpen: listen('app:open'),
      onLogExported: listen('log:exported'),
      onLogExportFailed: listen('log:export-failed'),
      onStalled: listen('diag:stalled'),
    },
    projects: {
      load: call('projects_load'),
      save: call('projects_save', 'next'),
    },
    pty: {
      create: call('pty_create', 'opts'),
      write: send('pty_write', 'id', 'data'),
      ack: send('pty_ack', 'id', 'chars'),
      resize: send('pty_resize', 'id', 'cols', 'rows'),
      kill: send('pty_kill', 'id'),
      cwd: call('pty_cwd', 'id'),
      onData: ptyListen(ptyData),
      onExit: ptyListen(ptyExit),
    },
    git: {
      root: call('git_root', 'cwd'),
      status: call('git_status', 'repo', 'opts'),
      log: call('git_log', 'repo'),
      branches: call('git_branches', 'repo'),
      commit: call('git_commit', 'repo', 'hash'),
      containing: call('git_containing', 'repo', 'hash'),
      fileDiff: call('git_file_diff', 'repo', 'spec'),
      action: call('git_action', 'repo', 'name', 'params'),
      watch: send('git_watch', 'repo'),
      unwatch: send('git_unwatch', 'repo'),
      onChanged: listen('git:changed'),
    },
    fs: {
      list: call('fs_list', 'dir'),
      read: call('fs_read', 'file'),
      files: call('fs_files', 'root'),
      grep: call('fs_grep', 'root', 'query'),
      create: call('fs_create', 'parent', 'name', 'dir'),
      rename: call('fs_rename', 'from', 'name'),
      move: call('fs_move', 'from', 'toDir'),
      copyIn: call('fs_copy_in', 'srcs', 'toDir'),
      trash: call('fs_trash', 'path'),
      openPath: call('fs_open_path', 'path'),
      reveal: call('fs_reveal', 'path'),
    },
    run: {
      detect: call('run_detect', 'dir'),
    },
    agents: {
      list: call('agents_list'),
      events: call('agents_events', 'id'),
      stop: call('agents_stop', 'id'),
      hasHistory: call('agents_has_history', 'dir'),
      available: call('agents_available', 'commands'),
      onUpdate: listen('agents:update'),
    },
  };
})();

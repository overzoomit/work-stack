// window.work: the backend's API over Tauri's IPC. Positional arguments
// become the named ones each Rust command takes.
(() => {
  const { invoke, Channel } = window.__TAURI__.core;
  const { listen: on } = window.__TAURI__.event;

  const call = (cmd, ...names) => (...args) => invoke(cmd, Object.fromEntries(names.map((n, i) => [n, args[i]])));
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

  // A file dropped from outside carries no path in the page: Tauri reports the
  // paths of a native drop, matched here by name.
  let dropped = [];
  on('tauri://drag-drop', (e) => { dropped = e.payload.paths || []; });

  window.work = {
    app: {
      info: call('app_info'),
      stats: call('app_stats'),
      pickFolder: call('app_pick_folder'),
      openExternal: send('app_open_external', 'url'),
      copy: send('app_copy', 'text'),
      paste: call('app_paste'),
      pathForFile: (file) => dropped.find((p) => p.split('/').pop() === file.name) || null,
      onFocus: listen('app:focus'),
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

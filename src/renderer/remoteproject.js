// Remote project identity and validation. Kept free of DOM imports so it can
// be unit-tested in Node; the dialog and the IPC live in remotedialog.js/app.js.
//
// A remote project has no local folder: `path` is a stable ssh:// identity used
// by state.json, tabs and pane ownership, while `remote` carries the settings
// the backend needs to build the SSH command.

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SESSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const MAX_PATH = 4096;

const text = (v) => String(v ?? '').trim();

// Returns `{ ok: true, remote }` or `{ ok: false, error }`; the same rules as
// RemoteProject::validate on the Rust side, so a value that passes here can
// never carry shell syntax into the SSH command.
export function normalizeRemote(input = {}) {
  const host = text(input.host);
  const user = text(input.user);
  const path = text(input.remotePath || input.path);
  const sessionName = text(input.sessionName);
  const rawPort = text(input.port);
  if (!HOST_RE.test(host)) {
    return { ok: false, error: 'Host must be an SSH alias or IP address (letters, numbers, . - _).' };
  }
  if (user && !USER_RE.test(user)) {
    return { ok: false, error: 'User may contain only letters, numbers, - and _.' };
  }
  const port = rawPort ? Number(rawPort) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be a number between 1 and 65535.' };
  }
  if (!path.startsWith('/')) {
    return { ok: false, error: 'Remote path must be absolute and start with /.' };
  }
  if (path.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(path)) {
    return { ok: false, error: 'Remote path contains control characters or is too long.' };
  }
  if (sessionName && !SESSION_RE.test(sessionName)) {
    return {
      ok: false,
      error: 'Session name may contain only letters, numbers, - and _ (max 64).',
    };
  }
  const remote = { host, remotePath: path };
  if (user) remote.user = user;
  if (port !== 22) remote.port = port;
  if (sessionName) remote.sessionName = sessionName;
  return { ok: true, remote };
}

// Stable identity for state.json and project tabs. It contains no credentials;
// an ssh:// URL is only a key, never passed to fs/git as a local folder.
export function remotePathFor(remote) {
  const user = remote?.user ? `${remote.user}@` : '';
  const port = remote?.port ? `:${remote.port}` : '';
  const path = remote?.remotePath || '';
  return `ssh://${user}${remote?.host || ''}${port}${path.startsWith('/') ? '' : '/'}${path}`;
}

export function isRemoteProject(project) {
  return Boolean(project?.remote);
}

export function remoteLabel(remote) {
  if (!remote) return '';
  const user = remote.user ? `${remote.user}@` : '';
  const port = remote.port ? `:${remote.port}` : '';
  return `${user}${remote.host}${port}:${remote.remotePath}`;
}

export function remoteHostBadge(remote) {
  return remote ? `🌐 ${remote.host}` : '';
}

export function remoteSessionName(remote) {
  return remote?.sessionName || '';
}

// "/home/me/src" → "~/src". Only a whole leading home folder is replaced:
// "/home/meg" and "/data/home/me" stay as they are.
export function tildify(path, home) {
  if (!path || !home) return path || '';
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

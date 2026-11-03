// Remote project identity and validation: the same rules the Rust backend
// applies before building the SSH command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRemote, remotePathFor, remoteLabel, remoteHostBadge, isRemoteProject,
} from '../src/renderer/remoteproject.js';

test('accetta un alias di ~/.ssh/config e applica i default', () => {
  const result = normalizeRemote({ host: ' server-vps ', remotePath: '/srv/app' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remote, { host: 'server-vps', remotePath: '/srv/app' });
});

test('normalizza utente, porta e nome sessione', () => {
  const result = normalizeRemote({
    host: '10.0.0.5', user: 'deploy', port: '2222', remotePath: '/srv/app', sessionName: 'work-stack',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remote, {
    host: '10.0.0.5', user: 'deploy', port: 2222, remotePath: '/srv/app', sessionName: 'work-stack',
  });
});

test('rifiuta valori che potrebbero raggiungere la shell', () => {
  const bad = [
    { host: '-oProxyCommand=sh', remotePath: '/srv/app' },
    { host: 'vps; rm -rf /', remotePath: '/srv/app' },
    { host: 'vps', user: 'a b', remotePath: '/srv/app' },
    { host: 'vps', user: 'a;rm', remotePath: '/srv/app' },
    { host: 'vps', remotePath: 'relative/path' },
    { host: 'vps', remotePath: '/srv/\napp' },
    { host: 'vps', port: '70000', remotePath: '/srv/app' },
    { host: 'vps', port: 'abc', remotePath: '/srv/app' },
    { host: 'vps', remotePath: '/srv/app', sessionName: 'bad:name' },
    { host: 'vps', remotePath: '/srv/app', sessionName: '-oX' },
  ];
  for (const input of bad) assert.equal(normalizeRemote(input).ok, false, JSON.stringify(input));
});

test('l’identità ssh:// è stabile e distingue host, porta e percorso', () => {
  const a = normalizeRemote({ host: 'vps', user: 'deploy', port: 2222, remotePath: '/srv/app' }).remote;
  const b = normalizeRemote({ host: 'vps', user: 'deploy', port: 2222, remotePath: '/srv/app' }).remote;
  const c = normalizeRemote({ host: 'vps', user: 'deploy', port: 22, remotePath: '/srv/app' }).remote;
  const d = normalizeRemote({ host: 'vps', user: 'deploy', port: 2222, remotePath: '/srv/other' }).remote;
  assert.equal(remotePathFor(a), remotePathFor(b));
  assert.equal(remotePathFor(a), 'ssh://deploy@vps:2222/srv/app');
  assert.notEqual(remotePathFor(a), remotePathFor(c));
  assert.notEqual(remotePathFor(a), remotePathFor(d));
  assert.equal(remoteLabel(a), 'deploy@vps:2222:/srv/app');
  assert.equal(remoteHostBadge(a), '🌐 vps');
});

test('riconosce solo i progetti con configurazione remota', () => {
  assert.equal(isRemoteProject({ remote: { host: 'vps' } }), true);
  assert.equal(isRemoteProject({ path: '/tmp' }), false);
  assert.equal(isRemoteProject(null), false);
});

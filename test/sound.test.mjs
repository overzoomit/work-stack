// Sound feedback: the preference (off by default, profile), the synthesized
// cues, and which state changes are allowed to play one. No real AudioContext
// is needed: the tests pass a recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The preference lives in the webview's localStorage; tests keep an in-memory one.
const stored = new Map();
globalThis.localStorage = {
  getItem: (k) => (stored.has(k) ? stored.get(k) : null),
  setItem: (k, v) => stored.set(k, String(v)),
  removeItem: (k) => stored.delete(k),
};

const {
  DEFAULT_SOUND_SETTINGS,
  createSoundWatcher,
  doneActions,
  fillSoundSettings,
  getSoundSettings,
  needsYouKey,
  newNeedsYouKeys,
  normalizeSoundSettings,
  notesFor,
  playSound,
  setSoundSettings,
  soundSettingsFrom,
} = await import('../src/renderer/sound.js');

class FakeParam {
  constructor() {
    this.value = 0;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.events.push(['set', v, t]);
  }
  exponentialRampToValueAtTime(v, t) {
    this.value = v;
    this.events.push(['ramp', v, t]);
  }
}

class FakeOscillator {
  constructor(context) {
    this.context = context;
    this.type = 'sine';
    this.frequency = new FakeParam();
    this.started = null;
    this.stopped = null;
    this.connected = [];
  }
  connect(node) {
    this.connected.push(node);
    return node;
  }
  start(t) {
    this.started = t;
  }
  stop(t) {
    this.stopped = t;
  }
}

class FakeGain {
  constructor() {
    this.gain = new FakeParam();
    this.connected = [];
  }
  connect(node) {
    this.connected.push(node);
    return node;
  }
}

class FakeContext {
  constructor() {
    this.currentTime = 5;
    this.state = 'running';
    this.destination = { name: 'destination' };
    this.oscillators = [];
    this.resumed = 0;
  }
  createOscillator() {
    const osc = new FakeOscillator(this);
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    return new FakeGain();
  }
  resume() {
    this.resumed++;
    this.state = 'running';
  }
}

const on = (profile = 'cyberpunk') => ({ enabled: true, profile });

test('sounds are off by default and the default profile is cyberpunk', () => {
  stored.clear();
  assert.deepEqual(DEFAULT_SOUND_SETTINGS, { enabled: false, profile: 'cyberpunk' });
  assert.deepEqual(getSoundSettings(), DEFAULT_SOUND_SETTINGS);
  assert.equal(DEFAULT_SOUND_SETTINGS.enabled, false, 'an existing install stays silent');
});

test('normalization keeps only a known profile and a real boolean', () => {
  assert.deepEqual(normalizeSoundSettings({ enabled: true, profile: 'minimal' }), {
    enabled: true,
    profile: 'minimal',
  });
  assert.deepEqual(normalizeSoundSettings({ enabled: 'yes', profile: 'trance' }), {
    enabled: false,
    profile: 'cyberpunk',
  });
  assert.deepEqual(normalizeSoundSettings(null), { enabled: false, profile: 'cyberpunk' });
  assert.deepEqual(normalizeSoundSettings({ enabled: true, profile: 'silent' }), {
    enabled: true,
    profile: 'silent',
  });
});

test('the preference is saved and read back', () => {
  stored.clear();
  setSoundSettings({ enabled: true, profile: 'minimal' });
  assert.deepEqual(getSoundSettings(), { enabled: true, profile: 'minimal' });
  setSoundSettings({ enabled: false, profile: 'nonsense' });
  assert.deepEqual(getSoundSettings(), { enabled: false, profile: 'cyberpunk' });
  // A corrupted value falls back instead of breaking every toast.
  stored.set('work.sound', '{rotto');
  assert.deepEqual(getSoundSettings(), DEFAULT_SOUND_SETTINGS);
});

test('every event has notes in both profiles, none in silent', () => {
  for (const profile of ['cyberpunk', 'minimal']) {
    for (const event of ['needsYou', 'ticketDone', 'release', 'error']) {
      const notes = notesFor(event, profile);
      assert.ok(notes.length > 0, `${profile}/${event}`);
      for (const n of notes) {
        assert.ok(n.freq > 0, `${profile}/${event}: frequency`);
        assert.ok(n.dur > 0, `${profile}/${event}: duration`);
        assert.ok(n.gain > 0 && n.gain < 0.1, `${profile}/${event}: a cue, not an alarm`);
      }
    }
  }
  assert.deepEqual(notesFor('needsYou', 'silent'), []);
  assert.deepEqual(notesFor('unknown', 'cyberpunk'), []);
  assert.deepEqual(notesFor('needsYou', 'unknown-profile'), []);
});

test('notesFor hands out copies: a caller cannot edit the cue', () => {
  const notes = notesFor('needsYou', 'cyberpunk');
  notes[0].freq = 1;
  assert.notEqual(notesFor('needsYou', 'cyberpunk')[0].freq, 1);
});

test('a disabled preference or the silent profile plays nothing', () => {
  for (const settings of [
    { enabled: false, profile: 'cyberpunk' },
    { enabled: false, profile: 'minimal' },
    { enabled: true, profile: 'silent' },
  ]) {
    const ctx = new FakeContext();
    assert.equal(playSound('needsYou', { settings, context: ctx }), false);
    assert.equal(ctx.oscillators.length, 0, JSON.stringify(settings));
  }
});

test('an enabled preference schedules the cue with a soft envelope', () => {
  const ctx = new FakeContext();
  assert.equal(playSound('needsYou', { settings: on('cyberpunk'), context: ctx }), true);
  const notes = notesFor('needsYou', 'cyberpunk');
  assert.equal(ctx.oscillators.length, notes.length);
  const first = ctx.oscillators[0];
  assert.equal(first.type, 'triangle');
  assert.equal(first.frequency.value, 659.25);
  assert.ok(first.started >= ctx.currentTime, 'scheduled from the context clock');
  assert.ok(first.stopped > first.started);
  const gain = first.connected[0];
  assert.equal(gain.connected[0], ctx.destination, 'the envelope reaches the output');
  assert.equal(gain.gain.events[0][0], 'set');
  assert.equal(gain.gain.events.at(-1)[0], 'ramp');
});

test('minimal and cyberpunk are different cues', () => {
  assert.notDeepEqual(notesFor('ticketDone', 'cyberpunk'), notesFor('ticketDone', 'minimal'));
});

test('a suspended context is resumed before the cue', () => {
  const ctx = new FakeContext();
  ctx.state = 'suspended';
  playSound('release', { settings: on('minimal'), context: ctx });
  assert.equal(ctx.resumed, 1);
});

test('Needs You fires once per new blocked prompt, not on every refresh', () => {
  const played = [];
  const watcher = createSoundWatcher({ play: (event) => played.push(event) });
  const first = [{ target: 'dev1', prompt_type: 'confirmation', question: 'Proceed?' }];
  assert.equal(watcher.dogwatch('a', first).length, 1);
  assert.deepEqual(played, ['needsYou']);
  assert.deepEqual(watcher.dogwatch('a', first), [], 'the same prompt is not announced twice');
  assert.deepEqual(played, ['needsYou']);

  const second = [...first, { target: 'dev2', question: 'Which branch?' }];
  assert.equal(watcher.dogwatch('a', second).length, 1);
  assert.deepEqual(played, ['needsYou', 'needsYou']);

  // Answered: the set empties, so the next prompt is news again.
  watcher.dogwatch('a', []);
  watcher.dogwatch('a', first);
  assert.deepEqual(played, ['needsYou', 'needsYou', 'needsYou']);
});

test('Needs You memory is per project', () => {
  const played = [];
  const watcher = createSoundWatcher({ play: (event) => played.push(event) });
  const prompt = [{ target: 'dev1', question: 'Proceed?' }];
  watcher.dogwatch('a', prompt);
  watcher.dogwatch('b', []);
  assert.deepEqual(watcher.dogwatch('a', prompt), [], 'another project update must not reset A');
  assert.deepEqual(played, ['needsYou']);

  assert.equal(watcher.dogwatch('b', prompt).length, 1, 'same prompt in B is news for B');
  assert.deepEqual(played, ['needsYou', 'needsYou']);

  watcher.dogwatch('a', []);
  assert.deepEqual(watcher.dogwatch('b', prompt), [], 'answering in A does not reset B');
});

test('a different question on the same window is a new prompt', () => {
  assert.notEqual(
    needsYouKey({ target: 'dev1', question: 'A?' }),
    needsYouKey({ target: 'dev1', question: 'B?' }),
  );
  const fresh = newNeedsYouKeys([needsYouKey({ target: 'dev1', question: 'A?' })], [
    { target: 'dev1', question: 'B?' },
  ]);
  assert.equal(fresh.length, 1);
});

test('ticket Done fires the ticket cue, other transitions do not', () => {
  const played = [];
  const watcher = createSoundWatcher({ play: (event) => played.push(event) });
  const done = [{ issue: 58, id: 'u1', from: 'in progress', to: 'done' }];
  assert.equal(doneActions({ actions: [{ to: 'test' }, ...done] }).length, 1);
  assert.equal(watcher.plane({ actions: [{ to: 'test' }] }).length, 0);
  assert.deepEqual(played, []);
  assert.equal(watcher.plane({ actions: done }).length, 1);
  assert.deepEqual(played, ['ticketDone']);
  assert.equal(watcher.plane({}).length, 0);
});

test('release and error have their own cue', () => {
  const played = [];
  const watcher = createSoundWatcher({ play: (event) => played.push(event) });
  watcher.release();
  watcher.error();
  assert.deepEqual(played, ['release', 'error']);
});

test('the Settings controls round-trip the same preference', () => {
  const controls = {};
  const root = {
    querySelector(selector) {
      controls[selector] ??= {};
      return controls[selector];
    },
  };
  root.querySelector('.st-sound-enabled').checked = true;
  root.querySelector('.st-sound-profile').value = 'minimal';
  assert.deepEqual(soundSettingsFrom(root), { enabled: true, profile: 'minimal' });

  fillSoundSettings(root, { enabled: false, profile: 'silent' });
  assert.equal(root.querySelector('.st-sound-enabled').checked, false);
  assert.equal(root.querySelector('.st-sound-profile').value, 'silent');
});

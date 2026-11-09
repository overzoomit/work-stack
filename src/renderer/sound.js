// Sound feedback: short cues synthesized with the Web Audio API. No audio
// files are shipped or fetched: each cue is a handful of oscillators with a
// light ADSR envelope, so turning sounds on costs nothing at install time.
//
// The preference lives with the other UI preferences (localStorage, like the
// terminal appearance): the Settings dialog edits it and this module owns it.
// Sounds are opt-in: the default is off so an existing install stays silent.

export const SILENT_PROFILE = 'silent';
export const DEFAULT_SOUND_SETTINGS = { enabled: false, profile: 'cyberpunk' };
export const SOUND_PROFILES = ['cyberpunk', 'minimal', SILENT_PROFILE];
export const SOUND_EVENTS = ['needsYou', 'ticketDone', 'release', 'error'];

const STORAGE_KEY = 'work.sound';

// Each note is { freq, type, at, dur, gain } with times in seconds relative to
// the cue. Gains stay low: these are cues, not notifications that own the room.
const NOTES = {
  cyberpunk: {
    needsYou: [
      { freq: 659.25, type: 'triangle', at: 0, dur: 0.09, gain: 0.05 },
      { freq: 987.77, type: 'triangle', at: 0.1, dur: 0.12, gain: 0.05 },
    ],
    ticketDone: [
      { freq: 523.25, type: 'sine', at: 0, dur: 0.1, gain: 0.045 },
      { freq: 659.25, type: 'sine', at: 0.08, dur: 0.1, gain: 0.045 },
      { freq: 783.99, type: 'sine', at: 0.16, dur: 0.1, gain: 0.045 },
      { freq: 1046.5, type: 'triangle', at: 0.24, dur: 0.18, gain: 0.05 },
    ],
    release: [
      { freq: 880, type: 'triangle', at: 0, dur: 0.12, gain: 0.04 },
      { freq: 1174.66, type: 'triangle', at: 0.1, dur: 0.12, gain: 0.04 },
      { freq: 1567.98, type: 'sine', at: 0.2, dur: 0.22, gain: 0.045 },
    ],
    error: [
      { freq: 220, type: 'sawtooth', at: 0, dur: 0.12, gain: 0.035 },
      { freq: 164.81, type: 'sawtooth', at: 0.12, dur: 0.2, gain: 0.035 },
    ],
  },
  minimal: {
    needsYou: [
      { freq: 880, type: 'sine', at: 0, dur: 0.1, gain: 0.05 },
      { freq: 880, type: 'sine', at: 0.14, dur: 0.1, gain: 0.05 },
    ],
    ticketDone: [
      { freq: 523.25, type: 'sine', at: 0, dur: 0.12, gain: 0.045 },
      { freq: 783.99, type: 'sine', at: 0.12, dur: 0.16, gain: 0.045 },
    ],
    release: [
      { freq: 659.25, type: 'sine', at: 0, dur: 0.12, gain: 0.04 },
      { freq: 987.77, type: 'sine', at: 0.12, dur: 0.18, gain: 0.04 },
    ],
    error: [
      { freq: 220, type: 'sine', at: 0, dur: 0.12, gain: 0.035 },
      { freq: 164.81, type: 'sine', at: 0.14, dur: 0.2, gain: 0.035 },
    ],
  },
};

// Bad or hand-edited values fall back to the safe default instead of muting
// by accident: only `silent` (or the off switch) turns sounds off.
export function normalizeSoundSettings(settings = {}) {
  const profile = SOUND_PROFILES.includes(settings?.profile)
    ? settings.profile
    : DEFAULT_SOUND_SETTINGS.profile;
  return { enabled: settings?.enabled === true, profile };
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getSoundSettings() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    return normalizeSoundSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS };
  }
}

export function setSoundSettings(settings) {
  const next = normalizeSoundSettings(settings);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted: the choice still applies to this run.
  }
  return next;
}

// The Settings dialog reads and fills the same controls.
export function soundSettingsFrom(root) {
  return normalizeSoundSettings({
    enabled: root?.querySelector('.st-sound-enabled')?.checked === true,
    profile: root?.querySelector('.st-sound-profile')?.value,
  });
}

export function fillSoundSettings(root, settings = getSoundSettings()) {
  const s = normalizeSoundSettings(settings);
  const enabled = root?.querySelector('.st-sound-enabled');
  const profile = root?.querySelector('.st-sound-profile');
  if (enabled) enabled.checked = s.enabled;
  if (profile) profile.value = s.profile;
}

// The notes of a cue for a profile; silent or unknown events have none.
export function notesFor(event, profile) {
  const notes = NOTES[profile]?.[event];
  return notes ? notes.map((n) => ({ ...n })) : [];
}

// Schedules the notes on an AudioContext. Kept separate from playSound so the
// envelope never depends on how the context was obtained.
export function scheduleNotes(notes, context, start) {
  const t0 = start ?? context.currentTime;
  for (const note of notes) {
    const osc = context.createOscillator();
    const env = context.createGain();
    const begin = t0 + (note.at || 0);
    const end = begin + Math.max(0.02, note.dur || 0.1);
    const peak = Math.max(0.0002, note.gain ?? 0.05);
    osc.type = note.type || 'sine';
    osc.frequency.setValueAtTime(note.freq, begin);
    env.gain.setValueAtTime(0.0001, begin);
    env.gain.exponentialRampToValueAtTime(peak, begin + Math.min(0.02, (end - begin) / 3));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env);
    env.connect(context.destination);
    osc.start(begin);
    osc.stop(end + 0.02);
  }
}

let context = null;

function audioContext() {
  if (context) return context;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

// Plays one cue. Returns false when the preference is off (or the profile is
// silent), when the event has no cue, or when the platform has no audio.
// A `context` can be passed by tests; `settings` overrides the saved choice.
export function playSound(event, { settings = null, context: ctx = null } = {}) {
  const s = normalizeSoundSettings(settings ?? getSoundSettings());
  if (!s.enabled || s.profile === SILENT_PROFILE) return false;
  const notes = notesFor(event, s.profile);
  if (!notes.length) return false;
  const audio = ctx || audioContext();
  if (!audio) return false;
  try {
    if (audio.state === 'suspended') audio.resume?.();
    scheduleNotes(notes, audio, audio.currentTime + 0.01);
    return true;
  } catch {
    // A page without audio permission must never break the UI.
    return false;
  }
}

// ── What deserves a cue ──────────────────────────────────────
// Detection is kept pure and separate from playback so it can be tested
// without an AudioContext.

export function needsYouKey(entry = {}) {
  const prompt = entry?.prompt ? { target: entry.target, ...entry.prompt } : entry || {};
  return `${prompt.target ?? ''}\u0000${prompt.prompt_type ?? ''}\u0000${prompt.question ?? ''}`;
}

// The prompts in `pending` that were not there before: a cue fires once per
// newly blocked window, not on every 3 s refresh of the same prompt.
export function newNeedsYouKeys(previous, pending = []) {
  const before = previous instanceof Set ? previous : new Set(previous || []);
  const fresh = [];
  for (const entry of pending || []) {
    const key = needsYouKey(entry);
    if (!before.has(key)) fresh.push(key);
  }
  return [...new Set(fresh)];
}

// The plane-dogwatch report lists a "done" action only in the cycle a ticket
// reaches Done: exactly the moment for the cue.
export function doneActions(report) {
  return (report?.actions || []).filter(
    (action) => String(action?.to || '').toLowerCase() === 'done',
  );
}

// Wires the events to the cues while remembering, per project, the prompts already seen.
export function createSoundWatcher({ play = playSound } = {}) {
  const seenByProject = new Map();
  return {
    dogwatch(project, pending = []) {
      const keys = newNeedsYouKeys(seenByProject.get(project), pending);
      if (pending?.length) seenByProject.set(project, new Set(pending.map(needsYouKey)));
      else seenByProject.delete(project);
      if (keys.length) play('needsYou');
      return keys;
    },
    plane(report) {
      const done = doneActions(report);
      if (done.length) play('ticketDone');
      return done;
    },
    release() {
      return play('release');
    },
    error() {
      return play('error');
    },
  };
}

// Manages the state of the diode (LED) in project tabs:
// Pulsing green when a tmux terminal or agent is working; orange when idle.
import { agentStateFor } from './agentsview.js';
import { runningIn } from './run.js';

const projectActivity = new Map(); // path -> timestamp
const activityTimers = new Map();

export function recordProjectActivity(path, onQuiet) {
  if (!path) return;
  projectActivity.set(path, Date.now());
  clearTimeout(activityTimers.get(path));
  if (onQuiet) {
    activityTimers.set(path, setTimeout(onQuiet, 2300));
  }
}

export function isProjectWorking(p) {
  if (!p) return false;
  if (agentStateFor(p.path) === 'working') return true;
  if (runningIn(p)) return true;
  const last = projectActivity.get(p.path) || 0;
  return Date.now() - last < 2200;
}

export function projectLedHtml(p) {
  const working = isProjectWorking(p);
  const state = working ? 'working' : 'idle';
  const title = working ? 'Tmux terminal working' : 'Idle (no tmux terminal working)';
  return `<span class="ptab-led ${state}" title="${title}"></span>`;
}

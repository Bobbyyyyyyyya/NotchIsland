'use strict';

/**
 * Live activities.
 *
 * The island is meant to react to what happens on the Mac the way the iPhone
 * reacts to a call or a timer: something arrives, the island opens on its own
 * with a small animation, two or more events share the housing side by side and
 * can be swiped away, and then it collapses back to the idle pill.
 *
 * This module is pure so the rules can be unit tested; the caller keeps the
 * timers and the island state machine.
 */

let nextId = 1;

/** User started countdown timers, kept here so they survive a state rebuild. */
const timers = new Map();

/**
 * How long the "fully charged" state stays on screen. Long enough for the bar to
 * snap green and the check to read as done, short enough that the island folds
 * back to the idle pill by itself.
 */
const CHARGE_FULL_HOLD_MS = 3800;
/** Same idea for a finished transfer: the check gets a moment, then it is gone. */
const TRANSFER_DONE_HOLD_MS = 1700;

/** Stamp of the first derive() that saw a full battery on cable, 0 otherwise. */
let chargeFullAt = 0;

/**
 * File transfers, shown with the AirDrop animation.
 *
 * macOS publishes no event for a finished AirDrop that an app is allowed to see,
 * so nothing here discovers one on its own. The transfer is real state with a
 * real clock; it is started by an action, which today only the tray menu and the
 * self test call. Point `startTransfer` at a real file copy later and the
 * animation is already correct.
 */
const transfers = new Map();

function startTransfer ({ name = 'AirPods Pro', bytes = 24_000_000, durationMs = 6000 } = {}) {
  const id = `transfer-${nextId++}`;
  transfers.set(id, {
    id,
    name,
    bytes,
    durationMs: Math.max(600, durationMs),
    startedAt: Date.now(),
    doneAt: 0,
  });
  return id;
}

function cancelTransfer (id) {
  transfers.delete(id);
}

function liveTransfers () {
  return [...transfers.values()];
}

/**
 * A transfer sprints away from zero and then crawls, which is both what a real
 * one does over AirDrop and what makes the bar look like it is moving.
 */
function transferState (transfer) {
  const elapsed = Date.now() - transfer.startedAt;
  if (elapsed >= transfer.durationMs) {
    if (!transfer.doneAt) transfer.doneAt = Date.now();
    return { progress: 1, done: true, doneFor: Date.now() - transfer.doneAt };
  }
  const ratio = clamp01(elapsed / transfer.durationMs);
  return { progress: 1 - (1 - ratio) ** 2.2, done: false };
}

function clamp01 (value) {
  return Math.min(Math.max(value, 0), 1);
}

function formatBytes (bytes) {
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

function startTimer (minutes) {
  const id = `timer-${nextId++}`;
  timers.set(id, {
    id,
    label: `${minutes} minute timer`,
    endsAt: Date.now() + minutes * 60_000,
    startedAt: Date.now(),
    paused: false,
    remaining: minutes * 60_000,
  });
  return id;
}

function pauseTimer (id) {
  const timer = timers.get(id);
  if (!timer || timer.paused) return;
  timer.remaining = Math.max(timer.remaining - (Date.now() - (timer.startedAt ?? Date.now())), 0);
  timer.paused = true;
  return timer;
}

function resumeTimer (id) {
  const timer = timers.get(id);
  if (!timer || !timer.paused) return;
  // Push the deadline out by however long the pause lasted, otherwise resuming
  // would hand the timer its whole duration back and it would start over.
  timer.endsAt = Date.now() + timer.remaining;
  timer.startedAt = Date.now();
  timer.paused = false;
  return timer;
}

function cancelTimer (id) {
  timers.delete(id);
}

function timerState (timer) {
  const remaining = timer.paused
    ? timer.remaining
    : Math.max(timer.endsAt - Date.now(), 0);
  const total = Math.max(timer.endsAt - (timer.startedAt ?? timer.endsAt - timer.remaining), 1);
  return {
    remaining: Math.round(remaining / 1000),
    progress: Math.min(Math.max(1 - remaining / total, 0), 1),
  };
}

function liveTimers () {
  return [...timers.values()].map((timer) => ({ timer, ...timerState(timer) }));
}

/**
 * An app update is the one thing here that arrives uninvited, so it is also the
 * one thing worth opening the island for: a small pill in the row first, and the
 * full panel the moment there is a new version, downloading or ready to install.
 *
 * Only the states that ask for something count. A failed check and a machine
 * that is already up to date stay out of the island entirely — the island
 * opening every launch to say "nothing" would be worse than saying nothing.
 */
function updateActivity (update) {
  if (!update) return null;
  switch (update.state) {
    case 'available':
      return {
        id: 'update',
        kind: 'update',
        title: `Notch Island ${update.version}`,
        subtitle: 'New version available',
        progress: null,
        icon: 'download',
        dismissible: true,
        interactive: true,
      };
    case 'downloading':
      return {
        id: 'update',
        kind: 'update',
        title: `Notch Island ${update.version}`,
        subtitle: `Downloading ${Math.round((update.progress ?? 0) * 100)}%`,
        progress: update.progress ?? 0,
        icon: 'download',
        dismissible: true,
        interactive: true,
      };
    case 'ready':
      return {
        id: 'update',
        kind: 'update',
        title: `Notch Island ${update.version}`,
        subtitle: 'Restart to install',
        // A full bar, so the eye reads it the same way as a finished transfer:
        // the work is done, only the restart is left.
        progress: 1,
        icon: 'download',
        dismissible: true,
        interactive: true,
      };
    default:
      return null;
  }
}

/**
 * Turns the current system state into the list of activities the island shows.
 *
 * @param {object} state the main process snapshot
 * @returns {Array<object>} activities, most important first
 */
function derive (state) {
  const activities = [];
  const now = Date.now();

  const update = updateActivity(state.update);
  if (update) activities.push(update);

  for (const { timer, remaining, progress } of liveTimers()) {
    if (remaining <= 0) {
      timers.delete(timer.id);
      continue;
    }
    activities.push({
      id: timer.id,
      kind: 'timer',
      title: timer.label,
      subtitle: formatCountdown(remaining),
      progress,
      icon: 'timer',
      dismissible: true,
      interactive: true,
    });
  }

  for (const transfer of transfers.values()) {
    const { progress, done } = transferState(transfer);
    if (done && now - transfer.doneAt > TRANSFER_DONE_HOLD_MS) {
      transfers.delete(transfer.id);
      continue;
    }
    activities.push({
      id: transfer.id,
      kind: 'transfer',
      title: `Sending to ${transfer.name}`,
      subtitle: done ? 'Sent' : `${formatBytes(transfer.bytes * progress)} of ${formatBytes(transfer.bytes)}`,
      progress,
      done,
      icon: 'airdrop',
      dismissible: !done,
      interactive: true,
    });
  }

  const { media } = state;
if (media.title && media.rate > 0) {
     activities.push({
       id: 'media',
       kind: 'media',
       title: media.title,
       subtitle: media.artist || null,
      artwork: media.artwork,
      progress: media.duration ? Math.min(media.elapsed / media.duration, 1) : null,
      icon: 'music',
      // Music is never thrown away by a swipe, it just leaves the island.
      dismissible: true,
      interactive: true,
    });
  }

  const accessory = (state.bluetooth?.devices ?? [])
    .filter((device) => device.connected && device.battery >= 0)
    .sort((a, b) => a.battery - b.battery)[0];
  if (accessory) {
    activities.push({
      id: `bt-${accessory.address}`,
      kind: 'bluetooth',
      title: accessory.name,
      subtitle: accessory.charging ? 'Charging' : `${Math.round(accessory.battery * 100)}%`,
      progress: accessory.battery,
      icon: 'bluetooth',
      dismissible: true,
      interactive: true,
    });
  }

  if (state.input?.active?.length) {
    activities.push({
      id: `mic-${state.input.active[0]}`,
      kind: 'mic',
      title: 'Microphone in use',
      subtitle: state.input.active[0],
      icon: 'mic',
      dismissible: false,
      interactive: true,
    });
  }

  // Charging is the one activity that retires itself: once the battery is full
  // the bar snaps green, holds for a moment so that reads as "done", and then the
  // island has nothing left to show and folds away.
  //
  // It is also the one activity the arrangement decides about, because the charger
  // is the one thing the island cannot be talked out of: taking the charging item
  // out of the row means the island stops opening for it and stops breathing at
  // the edge, which is the only way to turn it off.
  const battery = state.battery;
  if (arranged(state, 'charging')) {
    if (battery?.charging && battery.level < 1) {
      chargeFullAt = 0;
      activities.push(chargingActivity(battery));
    } else if (battery?.charging && battery.level >= 1) {
      if (!chargeFullAt) chargeFullAt = now;
      if (now - chargeFullAt < CHARGE_FULL_HOLD_MS) activities.push(chargingActivity(battery, true));
    } else {
      chargeFullAt = 0;
    }
  } else {
    chargeFullAt = 0;
  }

  return activities;
}

/**
 * Whether an item is in the island row.
 *
 * It reads the row off the main process state, because that is what `derive` is
 * handed — not the snapshot, which carries the same thing for the renderer. A row
 * that has not been filled in yet counts as everything being in use, so the
 * charger is never the thing that silently disappears before the first
 * preferences are read.
 */
function arranged (state, id) {
  const row = state.compact;
  if (!row) return true;
  return Array.isArray(row) ? row.includes(id) : [...(row.right ?? []), ...(row.left ?? [])].includes(id);
}

function chargingActivity (battery, full = false) {
  return {
    id: 'charging',
    kind: 'battery',
    title: full ? 'Fully charged' : 'Charging',
    subtitle: `${Math.round(battery.level * 100)}%`,
    progress: battery.level,
    full,
    icon: 'battery',
    dismissible: true,
    interactive: false,
  };
}

function formatCountdown (seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')} left`;
}

/**
 * Whether the island should open by itself right now.
 *
 * Only while it is folded, or while it is already showing another event. A panel
 * the user opened is the island doing what it was asked to, and replacing it — a
 * battery filling up, say — is not an answer to anything they asked. The event
 * still has its bubble in the row, and a tap on that opens it.
 */
function shouldPresent (islandState) {
  return islandState === 'compact' || String(islandState ?? '').startsWith('activity:');
}

/** Ids that were not present before, i.e. events worth opening the island for. */
function freshIds (previous, next) {
  const known = new Set(previous.map((activity) => activity.id));
  return next.filter((activity) => !known.has(activity.id)).map((activity) => activity.id);
}

module.exports = {
  derive,
  freshIds,
  startTimer,
  pauseTimer,
  resumeTimer,
  cancelTimer,
  liveTimers,
  startTransfer,
  cancelTransfer,
  liveTransfers,
  transferState,
  formatBytes,
  formatCountdown,
  updateActivity,
  arranged,
  shouldPresent,
  CHARGE_FULL_HOLD_MS,
  TRANSFER_DONE_HOLD_MS,
};

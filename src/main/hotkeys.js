'use strict';

const { globalShortcut } = require('electron');

/**
 * Global hotkeys.
 *
 * F7/F8/F9 and F10/F11/F12 are the keys the user asked for, but a few macOS
 * setups hand those to the system or another app first. Every action therefore
 * has a list of candidates: the plain function key first, a modifier variant
 * next, and the system Media* accelerator last. The settings panel shows which
 * combination actually ended up registered.
 */

const ACTIONS = {
  'media.previous': { label: 'Previous track', keys: ['F7', 'F6'], media: 'MediaPreviousTrack' },
  'media.playPause': { label: 'Play / pause', keys: ['F8'], media: 'MediaPlayPause' },
  'media.next': { label: 'Next track', keys: ['F9'], media: 'MediaNextTrack' },
  'volume.down': { label: 'Volume down', keys: ['F10'], media: 'MediaVolumeDown' },
  'volume.up': { label: 'Volume up', keys: ['F11'], media: 'MediaVolumeUp' },
  'volume.mute': { label: 'Mute', keys: ['F12'], media: 'VolumeMute' },
  'island.toggle': { label: 'Expand / collapse the island', keys: ['CommandOrControl+Alt+Space'], media: null },
  'island.clipboard': { label: 'Clipboard history', keys: ['CommandOrControl+Alt+C'], media: null },
  'island.volume': { label: 'Volume panel', keys: ['CommandOrControl+Alt+V'], media: null },
  'island.mic': { label: 'Microphone panel', keys: ['CommandOrControl+Alt+M'], media: null },
  'island.player': { label: 'Player panel', keys: ['CommandOrControl+Alt+P'], media: null },
  'island.layout': { label: 'Arrange the island', keys: ['CommandOrControl+Alt+L'], media: null },
};

class Hotkeys {
  constructor (onAction) {
    this.onAction = onAction;
    this.registered = new Map();
    this._dedupe = new Map();
  }

  /** Re-registers everything; call after a preferences change. */
  apply (prefs) {
    globalShortcut.unregisterAll();
    this.registered.clear();

    if (prefs.hotkeys.enabled === false) return this.status();

    const modifier = prefs.hotkeys.modifier ?? '';
    for (const [action, definition] of Object.entries(ACTIONS)) {
      const candidates = [
        ...definition.keys.map((key) => (modifier ? withModifier(key, modifier) : key)),
        ...(definition.keys.length && modifier ? definition.keys : []),
        ...(definition.media && prefs.hotkeys.mediaKeys ? [definition.media] : []),
      ];

      for (const accelerator of candidates) {
        try {
          if (globalShortcut.register(accelerator, () => this.trigger(action, accelerator))) {
            this.registered.set(action, accelerator);
            break;
          }
        } catch {
          // Invalid accelerator for this platform; try the next candidate.
        }
      }
    }
    return this.status();
  }

  /**
   * Electron delivers a key to both the global shortcut and the focused window
   * in some situations; ignore an action that repeats within 200 ms.
   */
  trigger (action, accelerator) {
    const now = Date.now();
    if (now - (this._dedupe.get(action) ?? 0) < 200) return;
    this._dedupe.set(action, now);
    this.onAction(action, accelerator);
  }

  status () {
    return Object.fromEntries(
      Object.entries(ACTIONS).map(([action, definition]) => [
        action,
        { label: definition.label, accelerator: this.registered.get(action) ?? null },
      ]),
    );
  }

  unregisterAll () {
    globalShortcut.unregisterAll();
    this.registered.clear();
  }
}

function withModifier (accelerator, modifier) {
  const parts = accelerator.split('+');
  const key = parts.pop();
  return [...parts, modifier, key].join('+');
}

module.exports = { Hotkeys, ACTIONS };

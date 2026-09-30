'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  version: 1,

  island: {
    // 'notch' keeps the island inside the cutout, 'pill' lets it grow around it.
    style: 'pill',
    maxWidth: 560,
    expandedHeight: 240,
    hoverToExpand: true,
    hideOnFullscreen: false,
    hideMenuBar: true,
    clickPassThrough: true,
    cornerRadius: 0,
  },

  // Order matters: this is the row of little widgets inside the compact island.
  widgets: ['media', 'bluetooth', 'volume', 'mic', 'battery', 'meeting', 'clipboard', 'clock', 'airdrop', 'cpu'],

  hotkeys: {
    enabled: true,
    // Some setups cannot hand F7…F12 to an app; this adds a modifier as a fallback.
    modifier: '',
    // Also claim the system Media* keys so the player works while unfocused.
    mediaKeys: false,
  },

  media: {
    // 'auto' uses the system bridge and falls back to a local MusicKit player.
    engine: 'auto',
    musickitToken: '',
  },

  launchAtLogin: false,
  debug: false,
};

function file () {
  return path.join(app.getPath('userData'), 'preferences.json');
}

let cached = null;

function load () {
  if (cached) return cached;
  try {
    cached = merge(structuredClone(DEFAULTS), JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    cached = structuredClone(DEFAULTS);
  }
  return cached;
}

function save (patch) {
  cached = merge(load(), patch);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cached, null, 2));
  } catch (error) {
    console.error('[prefs] could not persist preferences:', error.message);
  }
  return cached;
}

function get (key) {
  const prefs = load();
  return key ? key.split('.').reduce((value, part) => value?.[part], prefs) : prefs;
}

function merge (target, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = merge(target[key] ?? {}, value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

module.exports = { DEFAULTS, get, load, save, file };

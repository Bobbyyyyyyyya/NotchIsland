'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const layout = require('./layout');

const DEFAULTS = {
  version: 2,

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

  // Where everything goes: the surfaces of the current profile, and the profiles
  // themselves. `prefs.layout` is a cache of the active profile, kept in step by
  // `saveLayout` so the rest of the app can read the arrangement without knowing
  // that profiles exist.
  layout: { ...layout.normalise(null) },
  profiles: {},
  profile: layout.DEFAULT_PROFILE,

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

  updates: {
    // Once per launch, silently; the island asks before the app restarts.
    autoCheck: true,
    autoDownload: true,
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
  if (migrate(cached)) write(cached);
  return cached;
}

/**
 * Brings a preferences file written by an older version up to date, and says
 * whether it changed anything.
 *
 * The only one there has been is the island row: it used to be a single ordered
 * list of widget ids, which is the arrangement this app shipped with, so the
 * default layout is exactly what that list said. The order survives, and so does
 * the split across the two arms — which the counting used to make, and which is
 * therefore the split a migrated profile has to start with.
 */
function migrate (prefs) {
  if (prefs.version >= 2) return false;
  const stored = Array.isArray(prefs.widgets) ? prefs.widgets : layout.DEFAULT_LAYOUT.compact;
  prefs.layout = {
    ...layout.normalise(null),
    compact: layout.normaliseSurface('compact', stored),
    // The arrangement is exactly the old widget list, so it starts out dating from
    // before the charger became an item. Normalising straight away then brings it
    // up to date, which is what puts the charger back and leaves the file holding
    // the real arrangement rather than a claim about one.
    version: 1,
  };
  prefs.layout = layout.normalise(prefs.layout);
  prefs.version = 2;
  delete prefs.widgets;
  return true;
}

function save (patch) {
  cached = merge(load(), patch);
  write(cached);
  return cached;
}

function write (prefs) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(prefs, null, 2));
  } catch (error) {
    console.error('[prefs] could not persist preferences:', error.message);
  }
}

function get (key) {
  const prefs = load();
  return key ? key.split('.').reduce((value, part) => value?.[part], prefs) : prefs;
}

// ---------------------------------------------------------------- the layout

/** Every profile, cleaned, and which one is in use. */
function layoutProfiles () {
  const prefs = load();
  return layout.profiles(prefs.profiles, prefs.profile);
}

/**
 * Stores an arrangement against the profile in use and keeps `prefs.layout` in
 * step with it, so everything else can read the current arrangement without
 * knowing that profiles exist at all.
 */
function setLayout (next) {
  const current = layoutProfiles();
  const clean = layout.normalise(next);
  return save({
    layout: clean,
    profiles: { ...current.all, [current.active]: clean },
  });
}

function useProfile (name) {
  const current = layoutProfiles();
  if (!current.all[name]) return current;
  save({ profile: name, layout: current.all[name] });
  return layoutProfiles();
}

function newProfile (name) {
  const prefs = load();
  const result = layout.addProfile(prefs.profiles, prefs.profile, name);
  save({ profiles: result.stored, profile: result.active, layout: result.stored[result.active] });
  return layoutProfiles();
}

function renameProfile (from, to) {
  const prefs = load();
  const result = layout.renameProfile(prefs.profiles, prefs.profile, from, to);
  save({ profiles: result.stored, profile: result.active, layout: result.stored[result.active] });
  return layoutProfiles();
}

function deleteProfile (name) {
  const prefs = load();
  const result = layout.removeProfile(prefs.profiles, prefs.profile, name);
  save({ profiles: result.stored, profile: result.active, layout: result.stored[result.active] });
  return layoutProfiles();
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

module.exports = {
  DEFAULTS,
  get,
  load,
  save,
  file,
  migrate,
  layoutProfiles,
  setLayout,
  useProfile,
  newProfile,
  renameProfile,
  deleteProfile,
};

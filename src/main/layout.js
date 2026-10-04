'use strict';

/**
 * Where everything goes.
 *
 * The island used to have one ordered list of widgets and split it across the two
 * arms of the housing by counting, which left nothing to say about where a given
 * thing should end up. This module is the whole arrangement instead: a *surface*
 * is a place items live, an item is `{ id, side }`, and `side` is which arm of the
 * housing it hugs — the one thing that only the compact row cares about.
 *
 * A *profile* is a named set of surfaces. Switching profiles swaps all of them at
 * once, which is what makes "home", "work" and "film" possible without touching a
 * preference five times.
 *
 * Everything here is a plain function on plain data so the rules can be tested
 * without an island: the renderer only ever draws what this module decides.
 */

/**
 * What can be arranged, and what can be put in it.
 *
 * `side` marks the surfaces where left and right of the housing are separate
 * choices; on the others the order is all there is.
 */
const SURFACES = {
  compact: {
    label: 'Island row',
    sides: true,
    items: [
      { id: 'media', label: 'Music', icon: 'music', sizes: ['big', 'small'] },
      { id: 'bluetooth', label: 'Bluetooth', icon: 'bluetooth' },
      { id: 'volume', label: 'Volume', icon: 'volumeHigh' },
      { id: 'mic', label: 'Microphone', icon: 'mic' },
      { id: 'battery', label: 'Battery', icon: 'battery' },
      {
        id: 'charging',
        label: 'Charging',
        icon: 'batteryBolt',
        // Not really a widget: the charger is an event, so what this decides is
        // whether the island says anything about it at all.
        note: 'the island opening for the charger, and the ring that fills beside it',
      },
      { id: 'meeting', label: 'Meeting', icon: 'mic' },
      { id: 'clipboard', label: 'Clipboard', icon: 'clipboard' },
      { id: 'clock', label: 'Clock', icon: 'clock' },
      { id: 'airdrop', label: 'AirDrop', icon: 'airdrop' },
      { id: 'cpu', label: 'CPU', icon: 'cpu' },
    ],
  },
  quick: {
    label: 'Quick controls',
    sides: false,
    items: [
      { id: 'volume', label: 'Sound', icon: 'volumeLow', panel: 'volume' },
      { id: 'mic', label: 'Microphone', icon: 'mic', panel: 'mic' },
      { id: 'bluetooth', label: 'Bluetooth', icon: 'bluetooth', panel: 'bluetooth' },
      { id: 'player', label: 'Player', icon: 'music', panel: 'player' },
      { id: 'clipboard', label: 'Clipboard', icon: 'clipboard', panel: 'clipboard' },
      { id: 'settings', label: 'Settings', icon: 'gear', panel: 'settings' },
      { id: 'timer', label: 'Timer', icon: 'timer', panel: null },
    ],
  },
  settings: {
    label: 'Settings',
    sides: false,
    items: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'hotkeys', label: 'Hotkeys' },
      { id: 'updates', label: 'Updates' },
      // The switch for every mod that is loaded. It is a section like any other, so
      // it can be moved or left out with the rest.
      { id: 'mods', label: 'Mods' },
      { id: 'system', label: 'System' },
    ],
  },
};

/**
 * How many items one side of the housing may hold.
 *
 * A rule rather than a setting, because a row that can grow without end is a row
 * that ends up carrying things nobody looks at: the island sheds widgets from the
 * outside in, so what the arrangement says and what actually fits stop agreeing.
 * Six in the row is what keeps it a pill beside the housing rather than a shelf
 * across it.
 */
const MAX_PER_SIDE = 3;

/** How big each compact item starts, where it can be drawn at more than one size. */
const DEFAULT_SIZES = { media: 'big' };

/**
 * Which arm each compact item starts on.
 *
 * This is where the counting split used to land: the widgets before `meeting` sat
 * to the right of the housing and the rest to its left, which is why `battery` is
 * on the right here and `charging` — which arrives in between them — is too.
 */
const DEFAULT_SIDES = {
  media: 'right',
  volume: 'right',
  battery: 'right',
  clock: 'left',
  clipboard: 'left',
  bluetooth: 'left',
  mic: 'left',
  charging: 'left',
  meeting: 'left',
  airdrop: 'left',
  cpu: 'left',
};

/**
 * The arrangement the island ships with, which is the one it had before any of
 * this: the widgets in their old order, split where the counting split used to
 * fall. A fresh install and a migrated one must agree on every detail, or the
 * island would rearrange itself under someone who never touched it.
 */
const DEFAULT_LAYOUT = {
  compact: [
    // Three a side, so the row is six items wide. The rest are in the palette from
    // the first launch rather than being dropped out of a row that was too long.
    'media', 'volume', 'battery', 'clock', 'clipboard', 'bluetooth',
  ],
  quick: ['volume', 'mic', 'bluetooth', 'player', 'clipboard', 'settings', 'timer'],
  settings: ['appearance', 'hotkeys', 'updates', 'mods', 'system'],
};

/**
 * Bumped when an item is added to a surface, so an existing layout gains it
 * rather than never seeing it. The version is what a profile carries, not the
 * preferences file, since each profile is arranged on its own.
 */
const LAYOUT_VERSION = 2;

/** Items added after version 1, in the order they should land at the end. */
const ADDED_IN = {
  2: { compact: ['charging'] },
};

function surfaceNames () {
  return Object.keys(SURFACES);
}

/**
 * Items a surface can carry: the ones the app ships, plus the ones a mod added.
 *
 * A mod registers a widget the same way a built-in one is registered, and the
 * arrangement has to be able to hold it — otherwise a mod that draws a widget cannot
 * be put in the row, which is the one thing it is for. The main process is what adds
 * them, because it is the one that knows which mods are loaded.
 */
const added = {};

function addItem (surface, item) {
  added[surface] = [...(added[surface] ?? []), item];
  return item;
}

function itemsOf (surface) {
  return [...(SURFACES[surface]?.items ?? []), ...(added[surface] ?? [])];
}

function itemDef (surface, id) {
  return itemsOf(surface).find((item) => item.id === id) ?? null;
}

function sideOf (surface, id) {
  if (!SURFACES[surface]?.sides) return null;
  return DEFAULT_SIDES[id] ?? 'right';
}

/** The sizes an item can be drawn at, largest first. */
function sizesOf (surface, id) {
  return itemDef(surface, id)?.sizes ?? [];
}

function sizeOf (layout, surface, id) {
  const sizes = sizesOf(surface, id);
  if (!sizes.length) return null;
  const wanted = normalise(layout).sizes[id];
  return sizes.includes(wanted) ? wanted : sizes[0];
}

/**
 * A surface as a list of placements, in order.
 *
 * Unknown ids go (they belong to a version of the app that is gone) and duplicates
 * with it, but an item that is missing stays missing: removing something from the
 * island has to stay removed, which is the whole point of being able to arrange
 * it. A new item only arrives through `upgrade`.
 */
function normaliseSurface (surface, ids) {
  const known = new Set(itemsOf(surface).map((item) => item.id));
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Brings a stored surface up to date with the items the current app knows.
 *
 * A surface that was never stored falls back to the shipped arrangement, but an
 * empty one stays empty: taking everything out of a surface is a thing the layout
 * editor allows on purpose, and it must not be undone by a later launch.
 */
function upgradeSurface (surface, ids, version) {
  const out = normaliseSurface(surface, ids === undefined ? DEFAULT_LAYOUT[surface] : ids);
  for (const [since, added] of Object.entries(ADDED_IN)) {
    if (Number(since) <= version) continue;
    for (const id of added[surface] ?? []) {
      if (!out.includes(id) && itemDef(surface, id)) out.push(id);
    }
  }
  return out;
}

/**
 * Holds one side to the limit, leaving the surplus out of the surface entirely so it
 * goes back to the palette rather than sitting in a list where nothing shows it. An
 * item that is already on the side keeps its place: the limit is about what fits,
 * not about reshuffling someone's island the moment the rule arrived.
 */
function holdToLimit (ids, sides) {
  const kept = [];
  const counts = { right: 0, left: 0 };
  for (const id of ids) {
    const side = sides[id] ?? sideOf('compact', id);
    if (counts[side] >= MAX_PER_SIDE) continue;
    counts[side] += 1;
    kept.push(id);
  }
  return kept;
}

/** Every surface of a profile, cleaned and up to date. */
function normalise (layout) {
  const source = layout ?? {};
  // A layout that does not say what version it is has nothing to catch up on.
  // Reading that as "as old as possible" would quietly put back anything a version
  // of the app once removed, which is the opposite of what an emptied surface asks
  // for. Every file this app writes carries a version, so the default only ever
  // applies to something hand-written.
  const version = Number(source.version ?? LAYOUT_VERSION);
  const out = { version: LAYOUT_VERSION, sides: {}, sizes: {} };
  for (const surface of surfaceNames()) {
    out[surface] = upgradeSurface(surface, source[surface], version);
  }
  // The arms are stored per item rather than per surface, so a single `sides` map
  // covers every surface that has them. Anything else in it — an item from a surface
  // that was removed, a side that is not a side — goes. A surface with sides is then
  // held to the limit, which is what makes the rule absolute rather than a thing the
  // editor happens to observe.
  for (const [id, side] of Object.entries(source.sides ?? {})) {
    if (side !== 'left' && side !== 'right') continue;
    out.sides[id] = side;
  }
  for (const surface of surfaceNames()) {
    if (SURFACES[surface]?.sides) out[surface] = holdToLimit(out[surface], out.sides);
  }
  // Sizes are per item and per surface, so an item that cannot be drawn at that
  // size any more loses the setting rather than keeping a word nobody can read.
  for (const surface of surfaceNames()) {
    for (const [id, size] of Object.entries(source.sizes ?? {})) {
      if (sizesOf(surface, id).includes(size)) out.sizes[id] = size;
    }
  }
  return out;
}

/**
 * Puts an item somewhere in a surface.
 *
 * `index` is the gap it lands in, counted over the surface as it stands with the
 * item taken out — so dragging a widget one place to the right does not depend on
 * whether it started left or right of the housing.
 */
function place (layout, surface, id, index, side = null) {
  const next = normalise(layout);
  if (!itemDef(surface, id)) return next;
  const without = next[surface].filter((entry) => entry !== id);
  const at = Math.min(Math.max(index, 0), without.length);
  without.splice(at, 0, id);
  next[surface] = without;
  if (sideOf(surface, id) !== null) next.sides[id] = side === 'left' ? 'left' : 'right';
  return next;
}

/** Takes an item out of a surface entirely. */
function remove (layout, surface, id) {
  const next = normalise(layout);
  next[surface] = next[surface].filter((entry) => entry !== id);
  return next;
}

/**
 * The order and side of a surface, ready for the renderer: one list per arm for a
 * surface that has arms, and a plain list for one that does not.
 */
function arranged (layout, surface) {
  const clean = normalise(layout);
  const ids = clean[surface];
  if (!SURFACES[surface]?.sides) return ids;
  const sides = clean.sides ?? {};
  return {
    right: ids.filter((id) => (sides[id] ?? sideOf(surface, id)) !== 'left'),
    left: ids.filter((id) => (sides[id] ?? sideOf(surface, id)) === 'left'),
  };
}

/**
 * Writes two arms back into a surface, in the order the renderer showed them.
 *
 * The surface is stored as one list and the arms are read off it, so putting a
 * set of arms back means writing that list out again — right arm first, because
 * that is the order they already came in.
 */
function fromArms (layout, surface, arms = {}) {
  const next = normalise(layout);
  const keep = (list) => (Array.isArray(list) ? list : []).filter((id) => itemDef(surface, id));
  const right = keep(arms.right);
  const left = keep(arms.left);
  const seen = new Set();
  next[surface] = [...right, ...left].filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const id of next[surface]) {
    if (sideOf(surface, id) !== null) next.sides[id] = left.includes(id) ? 'left' : 'right';
  }
  return next;
}

/**
 * Whether a side has room for one more item — or for an item that is already on it,
 * which only ever moves around within the room it already has.
 */
function canPlace (current, surface, id, arm) {
  const order = arranged(current, surface);
  if (Array.isArray(order)) return false;
  const side = arm === 'left' ? 'left' : 'right';
  return order[side].filter((entry) => entry !== id).length < MAX_PER_SIDE;
}

/** How full each side is, and how full it may be. */
function fullness (current, surface) {
  const order = arranged(current, surface);
  if (Array.isArray(order)) return null;
  return {
    right: { used: order.right.length, max: MAX_PER_SIDE },
    left: { used: order.left.length, max: MAX_PER_SIDE },
  };
}

/** The items a surface has room for that it is not carrying. */
function available (layout, surface) {
  return itemsOf(surface)
    .filter((item) => !normalise(layout)[surface].includes(item.id))
    .map((item) => item.id);
}

/**
 * One change to an arrangement, described the way the editor sees it.
 *
 * The editor works in arms rather than in the stored list, because that is what a
 * person can see: an item sits in a row of items on one side of the housing, or
 * the other. So `place` is a gap on an arm, `side` is a crossing to the other one,
 * and `remove` is the bin. Which list the item really lives in, and which arm that
 * lands it on, is arithmetic done once, here.
 */
function change (current, edit = {}) {
  const clean = normalise(current);
  const surface = edit.surface;
  if (!surface || !itemsOf(surface).length) return clean;
  if (edit.op === 'remove') return remove(clean, surface, edit.id);
  if (edit.op === 'size') {
    const sizes = sizesOf(surface, edit.id);
    const next = sizes.includes(edit.size) ? edit.size : sizes[0];
    if (!next) return clean;
    return { ...clean, sizes: { ...clean.sizes, [edit.id]: next } };
  }

  const order = arranged(clean, surface);
  if (Array.isArray(order)) {
    // No arms here: the surface is one list, so a gap is a gap in it.
    return place(clean, surface, edit.id, edit.index);
  }

  const arms = { right: [...order.right], left: [...order.left] };
  const from = arms.right.includes(edit.id) ? 'right' : arms.left.includes(edit.id) ? 'left' : null;
  const arm = edit.op === 'side'
    ? (edit.side === 'left' ? 'left' : 'right')
    : (edit.arm === 'left' ? 'left' : 'right');

  // A side with no room is a refusal, not a queue: the arrangement is handed back
  // exactly as it was. Trimming it here instead would drop whichever item happened
  // to be past the limit — which, with the arms stored as one list, is as likely to
  // be the very item being moved as anything else. `canPlace` already ignores the
  // item being placed, so moving something around within a full side still works.
  if (!canPlace(clean, surface, edit.id, arm)) return clean;

  // An item that moves is lifted out of wherever it was first: leaving a copy
  // behind would put it on both arms, and the arms are read back off one list, so
  // it would then belong to whichever side happened to come first.
  if (from) arms[from] = arms[from].filter((id) => id !== edit.id);

  if (edit.op === 'side') {
    // A crossing goes to the far end rather than into a gap: there is no gap to
    // aim at, and landing at the end is where a hand expects a thing it threw.
    if (!from || from === arm) return clean;
    arms[arm].push(edit.id);
    return fromArms(clean, surface, arms);
  }

  const gap = Math.min(Math.max(Number(edit.index) || 0, 0), arms[arm].length);
  arms[arm].splice(gap, 0, edit.id);
  return fromArms(clean, surface, arms);
}

// ---------------------------------------------------------------- profiles

const DEFAULT_PROFILE = 'default';

function profileName (name) {
  const trimmed = String(name ?? '').trim().slice(0, 24);
  return trimmed || 'Untitled';
}

/** Every profile, cleaned, with the one in use marked. */
function profiles (stored, active) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const names = [...new Set([DEFAULT_PROFILE, ...Object.keys(source)])];
  const out = {};
  for (const name of names) {
    out[name] = normalise(source[name] ?? DEFAULT_LAYOUT);
  }
  return { active: out[active] ? active : DEFAULT_PROFILE, all: out };
}

/** A new profile that starts as a copy of the one in use, under a free name. */
function addProfile (stored, active, name) {
  const { active: current, all } = profiles(stored, active);
  const base = profileName(name);
  let candidate = base;
  for (let n = 2; all[candidate]; n++) candidate = `${base} ${n}`;
  all[candidate] = structuredClone(all[current]);
  return { stored: all, active: candidate };
}

function renameProfile (stored, active, from, to) {
  const { active: current, all } = profiles(stored, active);
  if (!all[from] || from === DEFAULT_PROFILE) return { stored: all, active: current };
  const name = profileName(to);
  if (all[name]) return { stored: all, active: current };
  const next = {};
  for (const [key, layout] of Object.entries(all)) {
    next[key === from ? name : key] = layout;
  }
  return { stored: next, active: current === from ? name : current };
}

/** The last profile cannot be deleted: something has to be there to fall back on. */
function removeProfile (stored, active, name) {
  const { active: current, all } = profiles(stored, active);
  if (name === DEFAULT_PROFILE || !all[name] || Object.keys(all).length < 2) {
    return { stored: all, active: current };
  }
  delete all[name];
  return { stored: all, active: current === name ? DEFAULT_PROFILE : current };
}

module.exports = {
  SURFACES,
  MAX_PER_SIDE,
  DEFAULT_LAYOUT,
  DEFAULT_SIDES,
  DEFAULT_SIZES,
  DEFAULT_PROFILE,
  LAYOUT_VERSION,
  surfaceNames,
  itemsOf,
  itemDef,
  sideOf,
  addItem,
  sizesOf,
  sizeOf,
  normalise,
  normaliseSurface,
  available,
  place,
  remove,
  arranged,
  fromArms,
  canPlace,
  fullness,
  change,
  profiles,
  profileName,
  addProfile,
  renameProfile,
  removeProfile,
};

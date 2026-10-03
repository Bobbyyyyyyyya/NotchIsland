'use strict';

const test = require('node:test');
const assert = require('node:assert');
const layout = require('../src/main/layout');
const activities = require('../src/main/activities');

const ALL_COMPACT = layout.DEFAULT_LAYOUT.compact;

/** A quiet machine, so the charger is the only thing that could happen. */
const base = {
  media: { title: '', artist: '', album: '', artwork: null, duration: 0, elapsed: 0, rate: 0 },
  input: { muted: false, active: [] },
  battery: { level: 0.5, charging: true },
  bluetooth: { devices: [] },
};

test('a fresh arrangement is the one the island shipped with', () => {
  const clean = layout.normalise(null);
  assert.deepStrictEqual(clean.compact, ALL_COMPACT);
  assert.deepStrictEqual(clean.quick, layout.DEFAULT_LAYOUT.quick);
  assert.deepStrictEqual(clean.settings, layout.DEFAULT_LAYOUT.settings);
  // The arms are where the counting used to put them: everything up to the
  // charger on the right of the housing, the rest on the left.
  assert.deepStrictEqual(layout.arranged(clean, 'compact'), {
    right: ['media', 'bluetooth', 'volume', 'mic', 'battery', 'charging'],
    left: ['meeting', 'clipboard', 'clock', 'airdrop', 'cpu'],
  });
});

test('a surface that was never stored falls back, an emptied one does not', () => {
  const clean = layout.normalise({ compact: [], settings: [], version: layout.LAYOUT_VERSION });
  assert.deepStrictEqual(clean.compact, [], 'removing everything has to stay removed');
  assert.deepStrictEqual(clean.settings, []);
  assert.deepStrictEqual(clean.quick, layout.DEFAULT_LAYOUT.quick, 'this one was never touched');
});

test('an item added in a later version reaches a layout that predates it', () => {
  // The charger became an item in version 2, so a row arranged before that has to
  // gain it — otherwise the one thing the island always showed would be the one
  // thing that quietly disappeared on upgrade.
  const old = { compact: ['media', 'battery'], version: 1 };
  assert.deepStrictEqual(layout.normalise(old).compact, ['media', 'battery', 'charging']);
  // And a layout arranged since is left exactly as its owner left it, including
  // one they emptied themselves.
  assert.deepStrictEqual(
    layout.normalise({ ...old, version: layout.LAYOUT_VERSION }).compact,
    ['media', 'battery'],
  );
  assert.deepStrictEqual(layout.normalise({ compact: [], version: layout.LAYOUT_VERSION }).compact, []);
});

test('unknown ids and duplicates are dropped', () => {
  const clean = layout.normalise({ compact: ['clock', 'clock', 'nonsense', 'cpu'] });
  // `charging` was added in version 2, so an older layout still gains it: the
  // charger must not be the thing that silently disappears on upgrade.
  assert.deepStrictEqual(clean.compact, ['clock', 'cpu', 'charging']);
});

test('the charger is an item, so it can be taken out', () => {
  const without = layout.remove(layout.normalise(null), 'compact', 'charging');
  assert.deepStrictEqual(layout.arranged(without, 'compact'), {
    right: ['media', 'bluetooth', 'volume', 'mic', 'battery'],
    left: ['meeting', 'clipboard', 'clock', 'airdrop', 'cpu'],
  });
});

test('a stale side does not survive', () => {
  const clean = layout.normalise({ compact: ALL_COMPACT, sides: { clock: 'left', cpu: 'sideways' } });
  assert.deepStrictEqual(clean.sides, { clock: 'left' });
});

// ---------------------------------------------------------------- arranging

const armsOf = (l) => layout.arranged(l, 'compact');

test('an item can be dropped into a gap on an arm', () => {
  const moved = layout.change(layout.normalise(null), { surface: 'compact', id: 'cpu', arm: 'right', index: 0 });
  assert.deepStrictEqual(armsOf(moved).right[0], 'cpu');
});

test('an item can cross the housing', () => {
  const crossed = layout.change(layout.normalise(null), { surface: 'compact', id: 'clock', op: 'side', side: 'right' });
  assert.ok(armsOf(crossed).right.includes('clock'));
  assert.ok(!armsOf(crossed).left.includes('clock'));
});

test('an item put on the other arm does not stay on both', () => {
  // `cpu` starts on the left; dropping it at the front of the right has to lift
  // it off the left rather than copy it there.
  const moved = layout.change(layout.normalise(null), { surface: 'compact', id: 'cpu', arm: 'right', index: 0 });
  const arms = armsOf(moved);
  assert.ok(!arms.left.includes('cpu'));
  assert.deepStrictEqual([...arms.right, ...arms.left].length, new Set([...arms.right, ...arms.left]).size);
});

test('nothing is lost by a long series of moves', () => {
  let current = layout.normalise(null);
  const moves = [
    { id: 'cpu', arm: 'right', index: 0 },
    { id: 'clock', op: 'side', side: 'right' },
    { id: 'meeting', op: 'remove' },
    { id: 'meeting', arm: 'left', index: 0 },
    { id: 'mic', arm: 'left', index: 0 },
    { id: 'media', arm: 'left', index: 2 },
  ];
  for (const move of moves) current = layout.change(current, { surface: 'compact', ...move });
  const arms = armsOf(current);
  const every = [...arms.right, ...arms.left];
  assert.deepStrictEqual(every.length, ALL_COMPACT.length);
  assert.deepStrictEqual(new Set(every).size, every.length);
  for (const id of ALL_COMPACT) assert.ok(every.includes(id), `${id} went missing`);
});

test('crossing to the arm an item is already on changes nothing', () => {
  const before = layout.normalise(null);
  assert.deepStrictEqual(layout.change(before, { surface: 'compact', id: 'clock', op: 'side', side: 'left' }), before);
});

test('an unknown item is not arranged anywhere', () => {
  const clean = layout.normalise(null);
  const junk = layout.change(clean, { surface: 'compact', id: 'teleporter' });
  assert.deepStrictEqual(armsOf(junk), armsOf(clean));
  assert.ok(!junk.compact.includes('teleporter'));
  assert.deepStrictEqual(layout.change(clean, { surface: 'nowhere', id: 'clock' }), clean);
});

test('a surface without arms is one list', () => {
  const quick = layout.change(layout.normalise(null), { surface: 'quick', id: 'player', index: 0 });
  assert.strictEqual(layout.arranged(quick, 'quick')[0], 'player');
  const gone = layout.change(quick, { surface: 'quick', op: 'remove', id: 'player' });
  assert.ok(!layout.arranged(gone, 'quick').includes('player'));
});

test('an empty arm is a place, not a missing one', () => {
  const allLeft = layout.normalise({
    compact: ALL_COMPACT,
    sides: Object.fromEntries(ALL_COMPACT.map((id) => [id, 'left'])),
  });
  const arms = layout.arranged(allLeft, 'compact');
  assert.deepStrictEqual(arms.right, []);
  assert.strictEqual(arms.left.length, ALL_COMPACT.length);
});

test('a layout from before the charger existed gains it, and keeps it on disk', () => {
  // This is what the migration in prefs.js does: the old widget list becomes an
  // arrangement dated from before `charging` was an item, which then brings it up
  // to date. Claiming to be current instead would leave an upgrading user without
  // the one thing the island had always shown.
  const migrated = layout.normalise({
    compact: ['media', 'battery', 'clipboard'],
    quick: layout.DEFAULT_LAYOUT.quick,
    settings: layout.DEFAULT_LAYOUT.settings,
    version: 1,
  });
  assert.deepStrictEqual(layout.arranged(migrated, 'compact'), {
    right: ['media', 'battery', 'charging'],
    left: ['clipboard'],
  });
  assert.strictEqual(layout.normalise(migrated).compact.includes('charging'), true, 'and it is idempotent');
});

test('an event never takes the island away from a panel the user opened', () => {
  // The one that was reported: the charger filled up while the battery panel was
  // open and the island put its own big charge bar on top of it.
  assert.strictEqual(activities.shouldPresent('compact'), true, 'a folded island reacts on its own');
  assert.strictEqual(activities.shouldPresent('activity:charging'), true, 'one event may replace another');
  for (const panel of ['player', 'settings', 'battery', 'volume', 'layout', 'quick']) {
    assert.strictEqual(activities.shouldPresent(panel), false, `${panel} is the island doing as it was asked`);
  }
  // An activity panel is named `activity:<id>`, and nothing else starts that way.
  assert.strictEqual(activities.shouldPresent('activity:timer-3'), true);
  assert.strictEqual(activities.shouldPresent(undefined), false);
});

test('a widget can be more than one size, and the size is stored', () => {
  const big = layout.normalise(null);
  assert.strictEqual(layout.sizeOf(big, 'compact', 'media'), 'big');
  const small = layout.change(big, { surface: 'compact', id: 'media', op: 'size', size: 'small' });
  assert.strictEqual(layout.sizeOf(small, 'compact', 'media'), 'small');
  // Moving it does not resize it: two independent choices.
  const moved = layout.change(small, { surface: 'compact', id: 'media', arm: 'left', index: 0 });
  assert.strictEqual(layout.sizeOf(moved, 'compact', 'media'), 'small');
});

test('an item that cannot be resized says so instead of inventing one', () => {
  const clean = layout.normalise(null);
  assert.strictEqual(layout.sizeOf(clean, 'compact', 'volume'), null);
  assert.deepStrictEqual(layout.sizesOf('compact', 'volume'), []);
  const resized = layout.change(clean, { surface: 'compact', id: 'volume', op: 'size', size: 'small' });
  assert.deepStrictEqual(resized.sizes, {}, 'a size nothing can be drawn at is not stored');
});

test('a size a later version cannot draw is dropped', () => {
  const clean = layout.normalise({ sizes: { media: 'gigantic', volume: 'small' } });
  assert.deepStrictEqual(clean.sizes, {});
});

test('the charger is an item, so the island can stop saying anything about it', () => {
  // The main process only keeps the charge activity while the row carries it.
  assert.ok(activities.derive({ ...base, battery: { level: 0.5, charging: true } }).some((a) => a.kind === 'battery'));
  const carried = { layout: { arranged: { compact: { right: ['charging'], left: [] } } } };
  assert.ok(activities.derive({ ...base, ...carried }).some((a) => a.kind === 'battery'));
  const removed = { layout: { arranged: { compact: { right: [], left: [] } } } };
  assert.strictEqual(activities.derive({ ...base, ...removed }).some((a) => a.kind === 'battery'), false);
});

test('the palette knows what a surface is not carrying', () => {
  const thin = layout.remove(layout.normalise(null), 'compact', 'cpu');
  assert.ok(layout.available(thin, 'compact').includes('cpu'));
  assert.ok(!layout.available(thin, 'compact').includes('mic'));
});

// ---------------------------------------------------------------- profiles

test('there is always a default profile, even with nothing stored', () => {
  const { active, all } = layout.profiles(undefined, undefined);
  assert.strictEqual(active, 'default');
  assert.deepStrictEqual(Object.keys(all), ['default']);
});

test('a profile that is not there falls back to the default', () => {
  assert.strictEqual(layout.profiles({}, 'Work').active, 'default');
});

test('a new profile is a copy of the one in use', () => {
  const arranged = layout.change(layout.normalise(null), { surface: 'compact', id: 'cpu', arm: 'right', index: 0 });
  const { stored, active } = layout.addProfile({ default: arranged }, 'default', 'Work');
  assert.strictEqual(active, 'Work');
  assert.deepStrictEqual(armsOf(stored.Work), armsOf(arranged));
});

test('a new profile gets a free name', () => {
  const first = layout.addProfile({}, 'default', 'Work');
  const second = layout.addProfile(first.stored, first.active, 'Work');
  assert.strictEqual(second.active, 'Work 2');
});

test('a profile can be renamed, unless it is the default one', () => {
  const created = layout.addProfile({}, 'default', 'Work');
  const renamed = layout.renameProfile(created.stored, created.active, 'Work', 'Office');
  assert.strictEqual(renamed.active, 'Office');
  assert.ok(!renamed.stored.Work);
  const refused = layout.renameProfile(created.stored, 'default', 'default', 'Nope');
  assert.strictEqual(refused.stored.default.default, undefined, 'the default keeps its name');
  assert.ok(refused.stored.default);
});

test('the last profile cannot be deleted', () => {
  const only = layout.removeProfile({}, 'default', 'default');
  assert.ok(only.stored.default);
  assert.strictEqual(only.active, 'default');
});

test('deleting the profile in use falls back to the default', () => {
  const created = layout.addProfile({}, 'default', 'Work');
  const deleted = layout.removeProfile(created.stored, created.active, 'Work');
  assert.strictEqual(deleted.active, 'default');
  assert.ok(!deleted.stored.Work);
});

test('deleting another profile leaves the one in use alone', () => {
  const created = layout.addProfile({}, 'default', 'Work');
  const other = layout.addProfile(created.stored, 'default', 'Film');
  const deleted = layout.removeProfile(other.stored, 'Work', 'Film');
  assert.strictEqual(deleted.active, 'Work');
  assert.ok(deleted.stored.Work);
});

test('a blank name is not a name', () => {
  assert.strictEqual(layout.profileName('   '), 'Untitled');
  assert.strictEqual(layout.profileName(''), 'Untitled');
  assert.strictEqual(layout.profileName('a'.repeat(80)).length, 24, 'and not an endless one');
});

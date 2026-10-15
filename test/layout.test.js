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

test('a fresh arrangement is three a side, and the rest is in the palette', () => {
  const clean = layout.normalise(null);
  assert.deepStrictEqual(clean.compact, ALL_COMPACT);
  assert.deepStrictEqual(clean.quick, layout.DEFAULT_LAYOUT.quick);
  assert.deepStrictEqual(clean.settings, layout.DEFAULT_LAYOUT.settings);
  assert.deepStrictEqual(layout.arranged(clean, 'compact'), {
    right: ['media', 'volume', 'battery'],
    left: ['clock', 'clipboard', 'bluetooth'],
  });
  // Nothing is lost by being off the row: it is one drag away.
  assert.deepStrictEqual(layout.available(clean, 'compact'), ['mic', 'charging', 'meeting', 'airdrop', 'cpu', 'thermal', 'mediaSmall', 'mediaBig']);
  assert.strictEqual(layout.available(clean, 'compact').length
    + layout.arranged(clean, 'compact').right.length
    + layout.arranged(clean, 'compact').left.length,
  layout.itemsOf('compact').length);
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
  assert.deepStrictEqual(layout.normalise(old).compact, ['media', 'battery', 'charging', 'thermal']);
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
  assert.deepStrictEqual(clean.compact, ['clock', 'cpu']);
});

test('a layout that says nothing about its version has nothing to catch up on', () => {
  // Reading a missing version as "as old as possible" would put back anything a
  // version of the app once added, which is the opposite of what an emptied surface
  // asks for — and every file this app writes carries a version, so the default
  // only ever applies to something hand-written.
  assert.deepStrictEqual(layout.normalise({ compact: [] }).compact, []);
  assert.deepStrictEqual(layout.normalise({ compact: ['media'] }).compact, ['media']);
  // One that does say: the charger was added in version 2, so a layout from before
  // it still gains it rather than the indicator quietly disappearing on upgrade.
  assert.deepStrictEqual(layout.normalise({ compact: ['media'], version: 1 }).compact, ['media', 'charging', 'thermal']);
});

test('the charger is an item, so it can be taken out', () => {
  // It is off the row by default, and taking out what *is* there makes room for it.
  const clean = layout.normalise(null);
  const without = layout.remove(clean, 'compact', 'clock');
  const withCharge = layout.change(without, { surface: 'compact', id: 'charging', arm: 'left', index: 0 });
  assert.ok(layout.arranged(withCharge, 'compact').left.includes('charging'));
});

test('a stale side does not survive', () => {
  const clean = layout.normalise({ compact: ALL_COMPACT, sides: { clock: 'left', cpu: 'sideways' } });
  assert.deepStrictEqual(clean.sides, { clock: 'left' });
});

// ---------------------------------------------------------------- arranging

const armsOf = (l) => layout.arranged(l, 'compact');

test('an item can be dropped into a gap on an arm', () => {
  const roomy = layout.normalise({ compact: ['media', 'volume'], version: layout.LAYOUT_VERSION });
  const moved = layout.change(roomy, { surface: 'compact', id: 'cpu', arm: 'right', index: 0 });
  assert.deepStrictEqual(armsOf(moved).right[0], 'cpu');
});

test('an item can cross the housing', () => {
  // From a row with room on both sides, which is not the default any more.
  const roomy = layout.normalise({ compact: ['media', 'clock'], version: layout.LAYOUT_VERSION });
  const crossed = layout.change(roomy, { surface: 'compact', id: 'clock', op: 'side', side: 'right' });
  assert.ok(armsOf(crossed).right.includes('clock'));
  assert.ok(!armsOf(crossed).left.includes('clock'));
});

test('an empty arm is a place, not a missing one', () => {
  const allLeft = layout.normalise({
    compact: ['clock', 'clipboard', 'bluetooth'],
    sides: Object.fromEntries(['clock', 'clipboard', 'bluetooth'].map((id) => [id, 'left'])),
    version: layout.LAYOUT_VERSION,
  });
  const arms = layout.arranged(allLeft, 'compact');
  assert.deepStrictEqual(arms.right, []);
  assert.strictEqual(arms.left.length, 3);
  assert.strictEqual(layout.canPlace(allLeft, 'compact', 'media', 'right'), true, 'and there is room on it');
});

test('an item put on the other arm does not stay on both', () => {
  // `cpu` starts on the left; dropping it at the front of the right has to lift
  // it off the left rather than copy it there.
  const moved = layout.change(layout.normalise(null), { surface: 'compact', id: 'cpu', arm: 'right', index: 0 });
  const arms = armsOf(moved);
  assert.ok(!arms.left.includes('cpu'));
  assert.deepStrictEqual([...arms.right, ...arms.left].length, new Set([...arms.right, ...arms.left]).size);
});

test('nothing is lost while there is room on both sides', () => {
  // Two a side, so every move below lands: the point of this is that reordering
  // does not quietly drop things on its own.
  let current = layout.normalise({ compact: ['media', 'clock', 'volume', 'cpu'], version: layout.LAYOUT_VERSION });
  const before = armsOf(current);
  for (const move of [
    { id: 'cpu', arm: 'right', index: 0 },
    { id: 'clock', op: 'side', side: 'right' },
    { id: 'media', arm: 'left', index: 1 },
    { id: 'cpu', arm: 'left', index: 0 },
  ]) current = layout.change(current, { surface: 'compact', ...move });
  const arms = armsOf(current);
  const every = [...arms.right, ...arms.left];
  assert.deepStrictEqual(every.length, 4);
  assert.deepStrictEqual(new Set(every).size, every.length);
  assert.notDeepStrictEqual(arms, before, 'and it did move something');
});

test('a drop onto a full side is refused, and said so rather than done quietly', () => {
  const full = layout.normalise(null);
  assert.strictEqual(layout.canPlace(full, 'compact', 'mic', 'right'), false, 'right is full');
  assert.strictEqual(layout.canPlace(full, 'compact', 'mic', 'left'), false, 'so is left');
  // An item already on a side may still be moved within it: it is not adding room.
  assert.strictEqual(layout.canPlace(full, 'compact', 'media', 'right'), true);
  // And the refusal is real: the arrangement does not change.
  const tried = layout.change(full, { surface: 'compact', id: 'mic', arm: 'right', index: 0 });
  assert.deepStrictEqual(armsOf(tried), armsOf(full));
});

test('one side may hold three and no more, whatever it is asked', () => {
  let current = layout.normalise({ compact: [], version: layout.LAYOUT_VERSION });
  for (const [id, arm] of [['media', 'right'], ['volume', 'right'], ['battery', 'right'], ['mic', 'right']]) {
    current = layout.change(current, { surface: 'compact', id, arm, index: 0 });
  }
  assert.deepStrictEqual(armsOf(current).right, ['battery', 'volume', 'media']);
  assert.deepStrictEqual(armsOf(current).left, []);
  assert.ok(layout.available(current, 'compact').includes('mic'), 'the fourth went back to the palette');
});

test('an arrangement from before the rule is trimmed, keeping the first on each side', () => {
  // This is what happens to a row arranged when a side could hold anything: the
  // items already on it keep their places and the surplus goes to the palette.
  // `mic` starts on the left, so it is the fourth item on that side and goes back
  // to the palette, while the three before it keep their places.
  const trimmed = layout.normalise({
    compact: ['media', 'volume', 'battery', 'mic', 'clock', 'clipboard', 'bluetooth', 'airdrop'],
    version: layout.LAYOUT_VERSION,
  });
  assert.deepStrictEqual(armsOf(trimmed), {
    right: ['media', 'volume', 'battery'],
    left: ['mic', 'clock', 'clipboard'],
  });
  assert.deepStrictEqual(layout.available(trimmed, 'compact'), ['bluetooth', 'charging', 'meeting', 'airdrop', 'cpu', 'thermal', 'mediaSmall', 'mediaBig']);
});

test('a surface with no sides has no limit', () => {
  const clean = layout.normalise(null);
  assert.strictEqual(layout.fullness(clean, 'quick'), null);
  assert.deepStrictEqual(layout.arranged(clean, 'quick'), layout.DEFAULT_LAYOUT.quick);
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

test('a layout from before the charger existed gains it, and keeps it on disk', () => {
  // This is what the migration in prefs.js does: the old widget list becomes an
  // arrangement dated from before `charging` was an item, which then brings it up
  // to date. Claiming to be current instead would leave an upgrading user without
  // the one thing the island had always shown.
  const migrated = layout.normalise({
    compact: ['media', 'battery', 'clock', 'clipboard'],
    quick: layout.DEFAULT_LAYOUT.quick,
    settings: layout.DEFAULT_LAYOUT.settings,
    version: 1,
  });
  assert.deepStrictEqual(layout.arranged(migrated, 'compact'), {
    right: ['media', 'battery'],
    left: ['clock', 'clipboard', 'charging'],
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

test('the limit is reported per side, so the editor can show it', () => {
  const full = layout.fullness(layout.normalise(null), 'compact');
  assert.deepStrictEqual(full, { right: { used: 3, max: 3 }, left: { used: 3, max: 3 } });
  const roomy = layout.fullness(layout.remove(layout.normalise(null), 'compact', 'volume'), 'compact');
  assert.deepStrictEqual(roomy.right, { used: 2, max: 3 });
  // A surface that is one list has no sides, and says so rather than counting one.
  assert.strictEqual(layout.fullness(layout.normalise(null), 'quick'), null);
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
  // `derive` is handed the main process state, not the snapshot, so the row has to
  // be read off `state.compact` — which is what put this back in the island when the
  // gate was reading a key the state never had.
  const row = (compact) => ({ ...base, compact: layout.arranged({ compact }, 'compact') });
  assert.ok(activities.derive({ ...base, battery: { level: 0.5, charging: true } }).some((a) => a.kind === 'battery'),
    'a state with no row yet is not the place the charger disappears');
  assert.ok(activities.derive(row(['charging'])).some((a) => a.kind === 'battery'), 'carried, it shows');
  assert.strictEqual(activities.derive(row([])).some((a) => a.kind === 'battery'), false, 'taken out, it does not');
  assert.strictEqual(activities.derive(row(['media', 'volume'])).some((a) => a.kind === 'battery'), false,
    'and a row without it is still a row without it');
  // Whatever else is happening, the charger is the only thing that decides this.
  assert.ok(activities.derive(row(['charging', 'media'])).some((a) => a.kind === 'battery'));
});

test('the palette knows what a surface is not carrying', () => {
  const thin = layout.remove(layout.normalise(null), 'compact', 'volume');
  assert.ok(layout.available(thin, 'compact').includes('volume'));
  assert.ok(!layout.available(thin, 'compact').includes('media'));
  // Which frees a place on the side it was on.
  assert.strictEqual(layout.canPlace(thin, 'compact', 'cpu', 'right'), true);
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

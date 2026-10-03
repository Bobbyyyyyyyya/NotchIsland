'use strict';

const test = require('node:test');
const assert = require('node:assert');
const layout = require('../src/main/layout');

const ALL_COMPACT = layout.DEFAULT_LAYOUT.compact;

test('a fresh arrangement is the one the island shipped with', () => {
  const clean = layout.normalise(null);
  assert.deepStrictEqual(clean.compact, ALL_COMPACT);
  assert.deepStrictEqual(clean.quick, layout.DEFAULT_LAYOUT.quick);
  assert.deepStrictEqual(clean.settings, layout.DEFAULT_LAYOUT.settings);
  // The arms are where the counting used to put them: ten widgets, first five
  // right of the housing, the rest left.
  assert.deepStrictEqual(layout.arranged(clean, 'compact'), {
    right: ['media', 'bluetooth', 'volume', 'mic', 'battery'],
    left: ['meeting', 'clipboard', 'clock', 'airdrop', 'cpu'],
  });
});

test('a surface that was never stored falls back, an emptied one does not', () => {
  const clean = layout.normalise({ compact: [], settings: [], version: 1 });
  assert.deepStrictEqual(clean.compact, [], 'removing everything has to stay removed');
  assert.deepStrictEqual(clean.settings, []);
  assert.deepStrictEqual(clean.quick, layout.DEFAULT_LAYOUT.quick, 'this one was never touched');
});

test('unknown ids and duplicates are dropped', () => {
  const clean = layout.normalise({ compact: ['clock', 'clock', 'nonsense', 'cpu'] });
  assert.deepStrictEqual(clean.compact, ['clock', 'cpu']);
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

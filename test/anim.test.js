'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lerp, easeOutQuint, interpolateRect, spring } = require('../src/main/anim');

test('lerp interpolates linearly', () => {
  assert.strictEqual(lerp(0, 100, 0), 0);
  assert.strictEqual(lerp(0, 100, 0.5), 50);
  assert.strictEqual(lerp(20, 20, 0.7), 20);
});

test('easing starts and ends exactly on the bounds', () => {
  assert.strictEqual(easeOutQuint(0), 0);
  assert.strictEqual(easeOutQuint(1), 1);
  assert.ok(easeOutQuint(0.5) > 0.5, 'ease-out should be past halfway at 50%');
});

test('the tween never overshoots and clamps outside its window', () => {
  const from = { x: 100, y: 0, width: 220, height: 38 };
  const to = { x: 40, y: 0, width: 420, height: 266 };

  assert.deepStrictEqual(interpolateRect(from, to, -50, 190), from);
  assert.deepStrictEqual(interpolateRect(from, to, 5000, 190), to);

  const middle = interpolateRect(from, to, 95, 190);
  assert.ok(middle.width > 220 && middle.width < 420);
  assert.ok(middle.x < 100 && middle.x > 40);
  assert.strictEqual(middle.y, 0, 'the island is pinned to the top of the screen');
});

test('every frame is an integer number of pixels', () => {
  const from = { x: 0, y: 0, width: 220, height: 38 };
  const to = { x: -13, y: 0, width: 441.6, height: 265.5 };
  for (let elapsed = 0; elapsed <= 200; elapsed += 7) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.strictEqual(Number.isInteger(interpolateRect(from, to, elapsed, 190)[key]), true);
    }
  }
});

test('a spring comes to rest on its target', () => {
  const advance = spring(0, 400);
  let value = 0;
  for (let elapsed = 0; elapsed <= 4000; elapsed += 10) value = advance(elapsed);
  assert.strictEqual(value, null, 'the spring reports rest once it has settled');
});

test('retargeting a spring in flight carries its momentum', () => {
  const advance = spring(0, 400);
  for (let elapsed = 0; elapsed <= 70; elapsed += 7) advance(elapsed);
  const before = advance(70);
  assert.ok(before !== null && before > 0 && before < 400);

  advance.retarget(900);
  const after = advance(77);
  assert.ok(after !== null, 'the spring is still moving');
  assert.ok(after >= before, 'the new target does not throw the velocity away');
});

test('retargeting to where the spring already is does nothing', () => {
  const advance = spring(0, 400);
  for (let elapsed = 0; elapsed <= 4000; elapsed += 10) advance(elapsed);
  assert.strictEqual(advance(4010), null);

  advance.retarget(400);
  assert.strictEqual(advance(4020), null, 'a rest stays at rest');
});

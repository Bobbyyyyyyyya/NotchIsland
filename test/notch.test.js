'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { notchFromReading } = require('../src/main/notch');

/**
 * These mirror the real readings from a 14" MacBook Pro in its 1800x1169 scaled
 * mode, where AppKit reports a 220 x 38 pt camera housing.
 */
const display = { x: 0, y: 0, width: 1800 };

test('derives the notch from the auxiliary screen areas', () => {
  const rect = notchFromReading(display, {
    hasNotch: true, width: 1800, left: 790, right: 790, top: 38,
  });
  assert.deepStrictEqual(rect, { x: 790, y: 0, width: 220, height: 38, detected: true });
});

test('accounts for a display that is not at the screen origin', () => {
  const rect = notchFromReading({ x: -1512, y: 0, width: 1512 }, {
    hasNotch: true, width: 1512, left: 663, right: 663, top: 32,
  });
  assert.deepStrictEqual(rect, { x: -849, y: 0, width: 186, height: 32, detected: true });
});

test('reports no notch for displays without a camera housing', () => {
  const rect = notchFromReading(display, { hasNotch: false, width: 2560, left: 0, right: 0, top: 0 });
  assert.strictEqual(rect.detected, false);
  assert.strictEqual(rect.width, 0);
});

test('rejects impossible readings', () => {
  const tooWide = notchFromReading(display, { hasNotch: true, width: 1800, left: 10, right: 10, top: 38 });
  assert.strictEqual(tooWide.detected, false);

  const noHeight = notchFromReading(display, { hasNotch: true, width: 1800, left: 790, right: 790, top: 0 });
  assert.strictEqual(noHeight.detected, false);

  const negative = notchFromReading(display, { hasNotch: true, width: 1800, left: 1200, right: 1200, top: 38 });
  assert.strictEqual(negative.detected, false);
});

test('survives a missing reading', () => {
  assert.strictEqual(notchFromReading(display, undefined).detected, false);
});

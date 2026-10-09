'use strict';

const test = require('node:test');
const assert = require('node:assert');

const deeplink = require('../src/main/deeplink');

/**
 * Deep links: the narrow door other apps knock on.
 *
 * Anything untrusted arrives as a string — a URL, an argv entry, garbage —
 * so the parser is strict about what it accepts and total about what it
 * refuses: a panel that is not on the list, a number outside its range and
 * a scheme that is not ours all come back null, never half an action.
 */

test('a panel link opens that panel', () => {
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://open/player'), {
    name: 'panel.open', args: { state: 'player' },
  });
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://open/close'), {
    name: 'panel.open', args: { state: 'compact' },
  });
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://open/mod:example'), {
    name: 'panel.open', args: { state: 'mod:example' },
  }, 'a mod panel opens by its id');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://open/mod:'), null, 'but not an empty one');
});

test('a toast carries one line', () => {
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://toast?message=Backup%20done'), {
    name: 'toast', args: { message: 'Backup done' },
  });
  const long = deeplink.parseDeepLink(`notch-island://toast?message=${'x'.repeat(500)}`);
  assert.strictEqual(long.args.message.length, deeplink.TOAST_MAX, 'a paragraph is cut, not refused');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://toast'), null, 'silence says nothing');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://toast?message=%20%20'), null, 'and neither does blank');
});

test('a timer counts minutes inside its range', () => {
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://timer?minutes=25'), {
    name: 'timer.start', args: { minutes: 25 },
  });
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://timer'), {
    name: 'timer.start', args: { minutes: deeplink.TIMER_DEFAULT },
  });
  assert.strictEqual(deeplink.parseDeepLink('notch-island://timer?minutes=0'), null, 'no zero-minute timer');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://timer?minutes=9999'), null, 'no week-long one either');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://timer?minutes=soon'), null, 'and no word-shaped one');
});

test('anything else is not a link', () => {
  assert.deepStrictEqual(deeplink.parseDeepLink('notch-island://open/settings'), {
    name: 'panel.open', args: { state: 'settings' },
  }, 'a known panel passes');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://open/launch-missiles'), null, 'an unknown panel does not');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://explode'), null, 'an unknown command does not');
  assert.strictEqual(deeplink.parseDeepLink('https://example.com'), null, 'another scheme does not');
  assert.strictEqual(deeplink.parseDeepLink('notch-island://%'), null, 'nor does a broken URL');
  assert.strictEqual(deeplink.parseDeepLink('--dev'), null, 'argv noise is simply not a link');
  assert.strictEqual(deeplink.parseDeepLink(''), null);
  assert.strictEqual(deeplink.parseDeepLink(null), null);
  assert.strictEqual(deeplink.parseDeepLink(undefined), null);
});

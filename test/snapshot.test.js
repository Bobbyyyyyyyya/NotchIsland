'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { copyState, trimForPush, MAX_PUSH_BYTES } = require('../src/main/snapshot');

const COVER = `data:image/jpeg;base64,${'A'.repeat(40_000)}`;

/** A state heavy enough that the artwork has to go, plus a clipboard to spare. */
function heavyState () {
  return {
    media: { title: 'Blinding Lights', artwork: COVER },
    clipboard: { lastSeen: 'x', items: Array.from({ length: 25 }, (_, i) => ({ text: 'y'.repeat(40_000), time: i })) },
    activities: [],
  };
}

test('the state this builds is really over the limit', () => {
  // A guard on the guard: a trim that is never reached would make every test
  // below pass for the wrong reason.
  const bytes = Buffer.byteLength(JSON.stringify(copyState(heavyState())));
  assert.ok(bytes > MAX_PUSH_BYTES, `${bytes} bytes should be over ${MAX_PUSH_BYTES}`);
});

test('the payload shares nothing with the state it came from', () => {
  const state = heavyState();
  const payload = copyState(state);
  assert.notStrictEqual(payload.media, state.media);
  assert.notStrictEqual(payload.clipboard, state.clipboard);
  assert.notStrictEqual(payload.clipboard.items, state.clipboard.items);
  assert.notStrictEqual(payload.activities, state.activities);
  assert.deepStrictEqual(payload, state, 'and it still carries the same values');
});

test('a payload that fits is handed over as it is', () => {
  const payload = copyState({ media: { title: 'Blinding Lights', artwork: COVER }, clipboard: { items: [] }, activities: [] });
  assert.strictEqual(trimForPush(payload), payload, 'so the common case copies nothing');
});

test('an oversized payload gives up the history before the cover', () => {
  const state = heavyState();
  const payload = trimForPush(copyState(state));
  assert.strictEqual(payload.media.artwork, COVER, 'a 160 pt cover costs less than a copied block');
  assert.strictEqual(payload.media.title, 'Blinding Lights');
  assert.ok(payload.clipboard.items.length < 25, 'and the history is shortened');
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= MAX_PUSH_BYTES);
});

test('one copied megabyte does not cost the cover', () => {
  const state = {
    media: { title: 'Blinding Lights', artwork: COVER },
    clipboard: { lastSeen: 'x', items: [{ text: 'z'.repeat(1_500_000), time: 1 }] },
    activities: [],
  };
  const payload = trimForPush(copyState(state));
  assert.strictEqual(payload.clipboard.items.length, 0, 'the megabyte is what goes');
  assert.strictEqual(payload.media.artwork, COVER);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= MAX_PUSH_BYTES);
});

test('the cover is the last thing to go', () => {
  // With everything else gone there is still nothing else left to give up, so a
  // limit below the size of the payload has to cost the artwork.
  const state = { media: { title: 'Blinding Lights', artwork: COVER }, clipboard: { items: [] }, activities: [] };
  const payload = trimForPush(copyState(state), 1024);
  assert.strictEqual(payload.media.artwork, null);
  assert.strictEqual(payload.media.title, 'Blinding Lights', 'the song stays');
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 1024);
});

test('trimming a payload cannot reach the state behind it', () => {
  // The whole point: a player does not hand the same artwork over twice, so a
  // cover lost here would stay lost and the island would show a ring for the rest
  // of the session.
  const state = heavyState();
  trimForPush(copyState(state));
  assert.strictEqual(state.media.artwork, COVER, 'the cover is still there');
  assert.strictEqual(state.clipboard.items.length, 25, 'and so is the history');
});

test('trimming twice is the same as trimming once', () => {
  const state = heavyState();
  const once = trimForPush(copyState(state));
  const twice = trimForPush(once);
  assert.strictEqual(twice, once, 'a trimmed payload fits, so it is left alone');
});

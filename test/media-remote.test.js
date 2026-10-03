'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MediaRemoteBridge } = require('../src/main/media-remote');

/** Feeds the bridge the frames an adapter sends and reports the message it saw. */
function feed (bridge, payload, diff = true) {
  let message = null;
  bridge.once('event', (event) => { message = event; });
  bridge._ingest({ payload, diff });
  return message;
}

function bridge () {
  return new MediaRemoteBridge();
}

const ART_A = 'QUJD';
const ART_B = 'REVG';

// ---------------------------------------------------------------- the cover

test('a cover that arrives after the title is kept', () => {
  const b = bridge();
  feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'Blinding Lights' });
  const message = feed(b, { artworkData: ART_A, artworkMimeType: 'image/jpeg' });
  assert.strictEqual(message.artworkData, `data:image/jpeg;base64,${ART_A}`);
});

test('a cover that arrives before its own title is kept too', () => {
  // MediaRemote loads the image before the title as often as after it, so this
  // ordering is the one that decides whether a song ever gets a sleeve.
  const b = bridge();
  const first = feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, artworkData: ART_A });
  assert.strictEqual(first.artworkData, null, 'nothing is shown while there is no title');
  const message = feed(b, { title: 'Blinding Lights' });
  assert.strictEqual(message.artworkData, `data:image/jpeg;base64,${ART_A}`);
});

test("the previous track's cover is not left under the next title", () => {
  const b = bridge();
  feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'Blinding Lights', artworkData: ART_A });
  const message = feed(b, { title: 'After Hours' });
  assert.strictEqual(message.artworkData, null);
});

test('a new cover replaces the old one', () => {
  const b = bridge();
  feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'One', artworkData: ART_A });
  const message = feed(b, { title: 'Two', artworkData: ART_B });
  assert.strictEqual(message.artworkData, `data:image/jpeg;base64,${ART_B}`);
});

test('a cover the frame takes back is gone', () => {
  const b = bridge();
  feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'Blinding Lights', artworkData: ART_A });
  const message = feed(b, { artworkData: null });
  assert.strictEqual(message.artworkData, null);
});

test('a cover survives the framework unloading and reloading it', () => {
  // The adapter keeps handing the same cover over while the item has not
  // changed, so an unload in between must not look like a track change.
  const b = bridge();
  feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'Blinding Lights', artworkData: ART_A });
  const message = feed(b, { artworkData: null, title: 'Blinding Lights' });
  assert.strictEqual(message.artworkData, null, 'the frame did ask for it back');
  // …and a later frame that carries it again is the one that puts it on screen.
  assert.strictEqual(feed(b, { artworkData: ART_A }).artworkData, `data:image/jpeg;base64,${ART_A}`);
});

// ---------------------------------------------------------------- the feed

test('no title means nothing is shown at all', () => {
  const b = bridge();
  const message = feed(b, { bundleIdentifier: 'com.apple.Music', playing: true });
  assert.strictEqual(message.title, '');
  assert.strictEqual(message.empty, true);
});

test('a full frame replaces what came before it', () => {
  const b = bridge();
  feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'One', artworkData: ART_A });
  const message = feed(b, { bundleIdentifier: 'com.apple.Music', playing: true, title: 'Two' }, false);
  assert.strictEqual(message.title, 'Two');
  assert.strictEqual(message.artworkData, null, 'a full frame says everything, so there is nothing left over');
});

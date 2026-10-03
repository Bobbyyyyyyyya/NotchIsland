'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TrackCover } = require('../src/main/artwork');

const ART_A = 'data:image/jpeg;base64,QUJD';
const ART_B = 'data:image/jpeg;base64,REVG';

const song = (title, artworkData, rest = {}) => ({ title, artist: 'The Weeknd', album: 'After Hours', ...rest, artworkData });

test('the cover a frame brings is the cover on screen', () => {
  const cover = new TrackCover();
  assert.strictEqual(cover.take(song('Blinding Lights', ART_A)), ART_A);
});

test('a frame without a cover does not take the one on screen away', () => {
  // MediaRemote unloads the image and loads it again a moment later, and the
  // adapter sends an explicit null while it is gone. That is a moment in the
  // life of a track, not the absence of one.
  const cover = new TrackCover();
  cover.take(song('Blinding Lights', ART_A));
  assert.strictEqual(cover.take(song('Blinding Lights', null)), ART_A);
  assert.strictEqual(cover.take(song('Blinding Lights', undefined)), ART_A);
});

test('the cover survives a title that is still settling', () => {
  // Some players publish the title a beat after everything else. The first frame
  // is a different song as far as the identity goes, so there is nothing to keep
  // — but the second frame is the same one and its cover is what shows.
  const cover = new TrackCover();
  assert.strictEqual(cover.take(song('', null)), null);
  assert.strictEqual(cover.take(song('Blinding Lights', ART_A)), ART_A);
});

test('the next song never wears this one', () => {
  const cover = new TrackCover();
  cover.take(song('Blinding Lights', ART_A));
  assert.strictEqual(cover.take(song('After Hours', null)), null, 'a stale sleeve is worse than none');
  assert.strictEqual(cover.take(song('After Hours', ART_B)), ART_B);
});

test('two songs with the same title are still two songs', () => {
  const cover = new TrackCover();
  cover.take(song('Blinding Lights', ART_A));
  // A live version of a song has a different sleeve, and the album is the only
  // thing in the frame that says so.
  assert.strictEqual(cover.take(song('Blinding Lights', null, { album: 'Live' })), null);
  assert.strictEqual(cover.take(song('Blinding Lights', ART_B, { album: 'Live' })), ART_B);
});

test('a player that reports no cover at all keeps the ring', () => {
  const cover = new TrackCover();
  assert.strictEqual(cover.take(song('Nothing', null)), null);
  assert.strictEqual(cover.take(song('Also Nothing', null)), null);
});

test('an ended session starts the next one clean', () => {
  const cover = new TrackCover();
  cover.take(song('Blinding Lights', ART_A));
  cover.reset();
  // Same song again after a stop: the frame has to bring its cover back.
  assert.strictEqual(cover.take(song('Blinding Lights', null)), null);
  assert.strictEqual(cover.take(song('Blinding Lights', ART_A)), ART_A);
});

'use strict';

/**
 * A song's cover, and how long it belongs on screen.
 *
 * MediaRemote hands the artwork over separately from the rest of the session,
 * and it takes it away again while the item itself has not changed: the adapter
 * sends a frame with an explicit `artworkData: null` whenever the image is
 * unloaded, which is a moment in the life of a track and not the absence of one.
 * It patches most of that over on its own, but not all of it, and a player that
 * does not have the system's attention never gets an image loaded at all.
 *
 * So a frame without a cover says nothing about whether the song has one. Only a
 * *different song* may take the cover on screen away — which is also the only
 * rule that cannot leave a stale sleeve under the next title, and that failure is
 * worse than a missing one.
 */

/** What makes a frame the same song as the one before it. */
function trackIdentity (frame) {
  return [frame.title ?? '', frame.artist ?? '', frame.album ?? ''].join('|');
}

class TrackCover {
  constructor () {
    this.identity = null;
    this.artwork = null;
  }

  /** The cover to show for this frame. */
  take (frame) {
    const identity = trackIdentity(frame);
    const changed = identity !== this.identity;
    this.identity = identity;
    if (frame.artworkData) this.artwork = frame.artworkData;
    else if (changed) this.artwork = null;
    return this.artwork;
  }

  /**
   * Forgets everything. The session ended rather than paused, so the next song
   * has to bring its own cover.
   */
  reset () {
    this.identity = null;
    this.artwork = null;
  }
}

module.exports = { TrackCover, trackIdentity };

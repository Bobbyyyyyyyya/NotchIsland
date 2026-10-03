'use strict';

/**
 * The payload the renderer is handed.
 *
 * `push` trims what does not fit, and a trim that reached the real state would
 * take a song's cover with it for the rest of the session. A player does not hand
 * the same artwork over twice, so there would be nothing to put back: the
 * thumbnail would show once and then be gone — which is exactly what a shallow
 * copy of the state produces, since `payload.media` *is* `state.media`.
 *
 * Hence `copyState`, and hence these two functions instead of a few lines in the
 * middle of `push`: the rule is worth stating once and checking.
 */

/** Biggest payload we are willing to hand to the renderer. */
const MAX_PUSH_BYTES = 900_000;

/** How much of the clipboard history a trimmed payload keeps. */
const TRIMMED_CLIPBOARD_ITEMS = 5;

function fits (payload, maxBytes) {
  return Buffer.byteLength(JSON.stringify(payload)) <= maxBytes;
}

function withClipboardItems (payload, count) {
  return { ...payload, clipboard: { ...payload.clipboard, items: payload.clipboard.items.slice(0, count) } };
}

/**
 * A copy of the state that shares nothing with it.
 *
 * Every nested object the renderer can be sent is copied, and that is the whole
 * point: whatever happens to the payload on its way out, the state it was taken
 * from is untouched.
 */
function copyState (state) {
  return {
    ...state,
    media: { ...state.media },
    clipboard: { ...state.clipboard, items: [...(state.clipboard?.items ?? [])] },
    activities: [...(state.activities ?? [])],
  };
}

/**
 * Fits the payload inside what a push can carry.
 *
 * The history goes first and the cover goes last, because the two are not the
 * same kind of thing: a clipboard entry can be any size a program copied, while
 * a cover is a 160 pt thumbnail that costs about as much as one of them. A song's
 * sleeve is the one thing in the payload the island cannot do without, so it
 * outlives twenty copies of something the user scrolled past — and it is still
 * the first thing to go when a single copied megabyte leaves no room at all.
 *
 * @returns the payload itself when it already fits, so the common case copies
 * nothing, and a trimmed copy when it does not.
 */
function trimForPush (payload, maxBytes = MAX_PUSH_BYTES) {
  if (fits(payload, maxBytes)) return payload;
  const short = withClipboardItems(payload, TRIMMED_CLIPBOARD_ITEMS);
  if (fits(short, maxBytes)) return short;
  const bare = withClipboardItems(short, 0);
  if (fits(bare, maxBytes)) return bare;
  return { ...bare, media: { ...bare.media, artwork: null } };
}

module.exports = { copyState, trimForPush, MAX_PUSH_BYTES, TRIMMED_CLIPBOARD_ITEMS };

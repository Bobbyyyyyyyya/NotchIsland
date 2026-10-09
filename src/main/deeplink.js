'use strict';

/**
 * Deep links: the narrow door other apps knock on.
 *
 * Any program that can open a URL can drive the island this way — a script, a
 * shortcut, a browser — with no dependency and no shared folder:
 *
 *   notch-island://open/player            open the island on a panel
 *   notch-island://toast?message=…        say one line in the island's voice
 *   notch-island://timer?minutes=5        start a countdown
 *
 * The parser hands back what `run` already understands, or null for anything
 * it does not recognise — including the Electron flags that ride along in a
 * second-instance argv, which are simply not links. Everything untrusted is
 * validated here: panels against a whitelist, numbers into a range, text cut
 * to a length, so a hostile or sloppy sender cannot do more than ask.
 */

const SCHEME = 'notch-island:';

/** Panels a link may open. Everything else is not a panel. */
const PANELS = new Set([
  'quick', 'player', 'volume', 'mic', 'bluetooth', 'battery',
  'clipboard', 'clock', 'settings', 'layout', 'compact',
]);

/** A toast is one line, not a paragraph. */
const TOAST_MAX = 140;

/** A countdown between a minute and three hours. */
const TIMER_MIN = 1;
const TIMER_MAX = 180;
const TIMER_DEFAULT = 5;

function panelTarget (name) {
  const panel = String(name ?? '').replace(/^\/+/, '');
  if (panel === 'close') return 'compact';
  return PANELS.has(panel) ? panel : null;
}

/**
 * Parses a deep link into an action call, or null when it is not one.
 *
 * @param {unknown} raw whatever arrived — a URL, an argv entry, anything
 * @returns {{ name: string, args: object } | null}
 */
function parseDeepLink (raw) {
  if (typeof raw !== 'string' || !raw.toLowerCase().startsWith(SCHEME)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== SCHEME) return null;
  const command = url.hostname.toLowerCase();

  if (command === 'open') {
    const panel = panelTarget(url.pathname);
    if (!panel) return null;
    return { name: 'panel.open', args: { state: panel } };
  }

  if (command === 'toast') {
    const message = (url.searchParams.get('message') ?? '').trim();
    if (!message) return null;
    return { name: 'toast', args: { message: message.slice(0, TOAST_MAX) } };
  }

  if (command === 'timer') {
    const rawMinutes = url.searchParams.get('minutes');
    if (rawMinutes === null || rawMinutes === '') return { name: 'timer.start', args: { minutes: TIMER_DEFAULT } };
    const minutes = Math.floor(Number(rawMinutes));
    if (!Number.isFinite(minutes) || minutes < TIMER_MIN || minutes > TIMER_MAX) return null;
    return { name: 'timer.start', args: { minutes } };
  }

  return null;
}

module.exports = { parseDeepLink, SCHEME, PANELS, TOAST_MAX, TIMER_MIN, TIMER_MAX, TIMER_DEFAULT };

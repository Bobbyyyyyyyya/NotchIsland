'use strict';

const { execFile } = require('node:child_process');

/**
 * Notch (camera housing) detection.
 *
 * AppKit exposes the cutout through public API since macOS 12:
 *
 *   - `NSScreen.auxiliaryTopLeftArea` / `auxiliaryTopRightArea`
 *     "The unobscured portion of the top-left/right corner of the screen."
 *     Both are `nil` on displays without a camera housing.
 *   - `NSScreen.safeAreaInsets.top` — the height of the housing.
 *
 * So:  notchWidth = frame.width - auxLeft.width - auxRight.width
 *      notchHeight = auxLeft.height (== safeAreaInsets.top)
 *
 * The values are reported in points of the *current* display mode, which means
 * the numbers follow the user's "scaled resolution" setting for free.
 *
 * Electron cannot call AppKit directly, so the read happens through JavaScript
 * for Automation (`osascript -l JavaScript`), which ships with every macOS and
 * needs no extra permission. Results are cached; call `invalidate()` whenever
 * displays change.
 */

const OSASCRIPT = '/usr/bin/osascript';

const JXA_SOURCE = `
ObjC.import('AppKit');
var screens = $.NSScreen.screens;
var count = screens.count;
var result = [];
for (var i = 0; i < count; i++) {
  var s = screens.objectAtIndex(i);
  var frame = s.frame;
  var auxLeft = s.auxiliaryTopLeftArea;
  var auxRight = s.auxiliaryTopRightArea;
  var id = Number(s.deviceDescription.objectForKey('NSScreenNumber'));
  result.push({
    id: id,
    main: s.isMainScreen,
    x: frame.origin.x,
    y: frame.origin.y,
    width: frame.size.width,
    height: frame.size.height,
    scale: Number(s.backingScaleFactor),
    hasNotch: auxLeft !== null && auxRight !== null,
    left: auxLeft ? auxLeft.size.width : 0,
    right: auxRight ? auxRight.size.width : 0,
    top: Number(s.safeAreaInsets.top)
  });
}
JSON.stringify(result);
`;

/**
 * Fills in the notch rectangle for one display. Pure, so it is unit tested.
 *
 * @param {{x: number, width: number}} displayBounds Electron display bounds
 * @param {object} screenReading one entry from the JXA probe
 * @returns {{x: number, y: number, width: number, height: number, detected: boolean}}
 */
function notchFromReading (displayBounds, screenReading) {
  if (!screenReading?.hasNotch) {
    return { x: 0, y: 0, width: 0, height: 0, detected: false };
  }

  const width = screenReading.width - screenReading.left - screenReading.right;
  const height = screenReading.top;

  if (!(width > 0) || !(height > 0) || width > screenReading.width * 0.9) {
    return { x: 0, y: 0, width: 0, height: 0, detected: false };
  }

  return {
    x: round(displayBounds.x + (displayBounds.width - width) / 2),
    y: displayBounds.y,
    width: round(width),
    height: round(height),
    detected: true,
  };
}

/** Runs the AppKit probe; resolves with an array of per-display readings. */
function probeScreens () {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', JXA_SOURCE], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error(`notch probe failed: ${error.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`notch probe returned garbage: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

let cache = null;

/** Cached probe, refreshed on demand. */
async function screens () {
  if (cache) return cache;
  cache = await probeScreens().catch(() => []);
  return cache;
}

/** Drops the cache; call this on display-added/removed/metrics-changed. */
function invalidate () {
  cache = null;
}

/** True when at least one attached display has a camera housing. */
async function hasNotchedDisplay (screen) {
  try {
    const readings = await screens();
    const ids = new Set(screen.getAllDisplays().map((display) => display.id));
    return readings.some((reading) => ids.has(reading.id) && reading.hasNotch);
  } catch {
    return false;
  }
}

/**
 * Notch rectangle for `display`, in Electron screen coordinates.
 *
 * @param {import('electron').Screen} screen
 * @param {import('electron').Display} display
 * @returns {Promise<{x: number, y: number, width: number, height: number, detected: boolean}>}
 */
async function detectNotch (screen, display) {
  const readings = await screens();
  const reading = readings.find((entry) => entry.id === display.id)
    ?? readings.find((entry) => entry.hasNotch && entry.main)
    ?? readings.find((entry) => entry.hasNotch);

  if (!reading) return { x: 0, y: 0, width: 0, height: 0, detected: false };
  return notchFromReading(display.bounds, reading);
}

function round (value) {
  return Math.round(value * 100) / 100;
}

module.exports = { detectNotch, hasNotchedDisplay, invalidate, notchFromReading, screens, probeScreens };

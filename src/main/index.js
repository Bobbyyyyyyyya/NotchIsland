'use strict';

const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, systemPreferences, Tray } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const activities = require('./activities');
const layout = require('./layout');
const prefs = require('./prefs');
const { TrackCover } = require('./artwork');
const { HelperBridge } = require('./helper');
const { Hotkeys } = require('./hotkeys');
const { Island } = require('./island');
const { MediaRemoteBridge } = require('./media-remote');
const { copyState, trimForPush } = require('./snapshot');
const mods = require('./mods');
const { Updater } = require('./updater');

/**
 * Notch Island — a Dynamic Island for the MacBook camera housing.
 *
 * The main process owns every privileged concern: the overlay window, the notch
 * geometry, global hotkeys, the CoreAudio/MediaPlayer helper and the clipboard
 * history. The renderer is a plain web page that asks for actions and renders
 * whatever snapshot it is handed.
 */

const CLIPBOARD_HISTORY_LIMIT = 25;
const CLIPBOARD_POLL_MS = 1000;
const BATTERY_POLL_MS = 2_000;
const CPU_POLL_MS = 3000;

const helper = new HelperBridge();
const mediaRemote = new MediaRemoteBridge();
const island = new Island(prefs);
const hotkeys = new Hotkeys(handleHotkey);
const updater = new Updater(prefs);

/** The cover on screen, and the song it belongs to. */
const cover = new TrackCover();

/** The activity id the update owns; it never retires on its own. */
const UPDATE_ACTIVITY = 'update';

const state = {
  media: { title: '', artist: '', album: '', artwork: null, duration: 0, elapsed: 0, rate: 0, playbackState: 0, source: '', preferredApp: null, controlled: false },
  volume: { value: 0, muted: false },
  input: { muted: false, volume: 1, active: [] },
  devices: { list: [], output: 0, input: 0 },
  battery: { level: 1, charging: false, minutes: -1, full: true },
  bluetooth: { devices: [] },
  airdrop: { live: false },
  activities: [],
  clipboard: { items: [], lastSeen: '' },
  system: { cpu: 0, micAccess: 'unknown', displays: 0 },
  helper: { available: false, reason: 'starting', capabilities: {} },
  hotkeys: {},
  compact: { right: [], left: [] },
  // What the loaded mods brought: ids, labels and icons, never code. The main process
  // runs no mod code, so this is the whole of what a mod is here — enough to arrange
  // it, and enough to list it in the settings with a switch.
  mods: [],
  update: { ...updater.status(), current: app.getVersion() },
};

/** Ids the user swiped away; they may come back after a while. */
const dismissed = new Map();

let tray = null;
let mediaTimer = null;
let clipboardTimer = null;
let cpuTimer = null;

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => island.window?.show());
  app.whenReady().then(bootstrap);
}

async function bootstrap () {
  app.dock?.hide();

  island.create();
  await island.syncDisplays();
  island.resize(null, { animate: false });

  createTray();
  // The radio items mirror the panel the island is showing, so they are
  // rebuilt whenever it changes instead of only once at startup.
  island.onStateChange = () => refreshTrayMenu();
  helper.on('status', (status) => {
    state.helper = status;
    syncControl();
    push();
  });
  helper.on('event', onHelperEvent);
  helper.start();

  // A new version is a live activity like any other: the updater's status turns
  // into a bubble, and `push` opens the island on it by itself.
  updater.on('status', (status) => {
    state.update = { ...status, current: app.getVersion() };
    refreshTrayMenu();
    push();
  });

  // MediaRemote is refused to this process on macOS 15.4 and up, so now
  // playing data and transport come from the perl-hosted adapter. The helper
  // keeps owning volume, devices and the media keys it does receive.
  mediaRemote.on('event', onHelperEvent);
  mediaRemote.on('status', () => { syncControl(); push(); });
  mediaRemote.start();

  applyPreferences();
  startPolling();
  mods.ensure();
  updater.start();

  if (process.argv.includes('--shot')) await captureReference();
  if (process.argv.includes('--selftest')) await selftest();

  // The notch moves when the display layout or its scaling changes.
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, async () => {
      await island.syncDisplays();
      island.resize(null, { animate: false });
      push();
    });
  }
  powerMonitor.on('shutdown', () => helper.stop());
}

app.on('window-all-closed', () => {
  // Menu bar app: closing the island window keeps the process alive.
});

app.on('before-quit', () => {
  clearInterval(mediaTimer);
  clearInterval(clipboardTimer);
  clearInterval(cpuTimer);
  hotkeys.unregisterAll();
  helper.stop();
  mediaRemote.stop();
});

/**
 * `npm run dev -- --selftest` checks the parts that are hard to see: the notch
 * measurement, the hotkey registrations, the system bridge and the drag
 * gesture. Exits with a non-zero code when something is off.
 */
async function selftest () {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

  const frameOf = () => ({ ...island.frame });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  check('notch detected', island.notch.detected && island.notch.width > 100,
    `${island.notch.width}x${island.notch.height} pt`);

  const expected = {
    'media.previous': 'F7',
    'media.playPause': 'F8',
    'media.next': 'F9',
    'volume.down': 'F10',
    'volume.up': 'F11',
    'volume.mute': 'F12',
  };
  for (const [action, key] of Object.entries(expected)) {
    const bound = state.hotkeys[action]?.accelerator;
    check(`${state.hotkeys[action]?.label ?? action} is ${key}`, bound === key, bound ?? 'unavailable');
  }

  // The bridge compiles on first launch, so give it a moment to come up.
  for (let attempt = 0; attempt < 40 && !helper.status().available; attempt++) await wait(250);
  check('system bridge', helper.status().available, helper.status().reason ?? 'ok');
  // Without the adapter the player has no feed at all on macOS 15.4 and up.
  for (let attempt = 0; attempt < 100 && !mediaRemote.status().available; attempt++) await wait(250);
  check('media adapter', mediaRemote.status().available, mediaRemote.status().reason ?? 'ok');
  helper.send('devices');
  await wait(400);
  check('audio devices', state.devices.list.length > 0, `${state.devices.list.length} found`);
  for (let attempt = 0; attempt < 30 && !batteryReported; attempt++) await wait(200);
  check('battery reported', batteryReported && state.battery.level >= 0 && state.battery.level <= 1,
    `${Math.round(state.battery.level * 100)}%`);

  // The updater refuses to look for an update in a launch that was never
  // packaged, and says so rather than failing quietly: that is the whole of what
  // it can be checked for here, since there is no feed to check against.
  check('updater knows it is unpackaged', state.update.state === 'unsupported', state.update.state);
  check('updater status reaches the renderer', Boolean(state.update.current), state.update.current);

  // Dragging an open island down must collapse it again.
  run('panel.open', { state: 'player' });
  await wait(950);
  const open = frameOf();
  island.beginDrag();
  island.drag(60);
  const dragged = frameOf();
  island.endDrag();
  await wait(950);
  const collapsed = frameOf();
  check('drag shrinks the island', dragged.height < open.height - 10, `${open.height} -> ${dragged.height}`);
  check('drag down collapses', collapsed.height < open.height - 40, `-> ${collapsed.height}`);

  // Dragging the compact island up must open it.
  island.beginDrag();
  island.drag(-40);
  island.endDrag();
  await wait(950);
  check('drag up opens', island.state !== 'compact' && island.frame.height > collapsed.height,
    `${island.state} @ ${island.frame.height}`);

  // Live activities: a timer has to appear, open the island and count down.
  run('timer.start', { minutes: 5 });
  await wait(400);
  const timer = state.activities.find((activity) => activity.id.startsWith('timer-'));
  check('timer becomes an activity', Boolean(timer), timer?.subtitle);
  check('island opens for the activity', island.state === `activity:${timer?.id}`, island.state);

  run('timer.start', { minutes: 10 });
  await wait(300);
  check('two activities split the island', state.activities.length >= 2, `${state.activities.length} active`);

  run('panel.open', { state: 'quick' });
  await wait(350);
  check('long press controls open', island.state === 'quick', island.state);

  // An AirDrop has to fill, finish and take itself off the island again. The
  // retirement lands on a one second tick, so the wait has to outlast the
  // transfer plus its done hold plus that tick.
  run('transfer.start', { name: 'iPad', bytes: 8_000_000, durationMs: 700 });
  await wait(500);
  const sending = state.activities.find((activity) => activity.kind === 'transfer');
  check('transfer becomes an activity', Boolean(sending), sending?.subtitle);
  check('transfer fills', (sending?.progress ?? 0) > 0, `${Math.round((sending?.progress ?? 0) * 100)}%`);
  check('island opens for the transfer', island.state === `activity:${sending?.id}`, island.state);
  await wait(3000);
  check('transfer retires itself', !state.activities.some((activity) => activity.kind === 'transfer'));
  check('island folds away after it', island.state === 'compact', island.state);

  // A full battery is the one activity that ends on its own too. The helper
  // keeps polling the real battery, and a countdown timer pushes every second,
  // so without `capturing` the staged full battery is overwritten and re-derived
  // away before the check lands.
  const battery = state.battery;
  capturing = true;
  state.battery = { ...battery, charging: true, level: 1, full: true };
  push({ announce: false });
  await wait(250);
  check('a full battery reports itself', state.activities.some((activity) => activity.full === true),
    state.activities.find((activity) => activity.id === 'charging')?.title ?? 'none');
  state.battery = battery;
  capturing = false;
  push({ announce: false });
  await wait(200);

  for (const activity of state.activities.filter((entry) => entry.id.startsWith('timer-'))) {
    run('timer.cancel', { id: activity.id });
  }
  await wait(300);
  check('dismissing clears the island', !state.activities.some((entry) => entry.id.startsWith('timer-')));

  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  (${result.detail})` : ''}`);
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
}

/**
 * Development helper: `npm run dev -- --shot` writes a PNG of the island for
 * every panel to the user data folder, so the layout can be reviewed without a
 * screenshot round trip.
 *
 * The two animations that only exist while something is happening cannot be
 * photographed on demand, so the states they need are staged here.
 */
const SHOTS = [
  { name: 'compact' },
  { name: 'player' },
  { name: 'volume' },
  { name: 'mic' },
  { name: 'bluetooth' },
  { name: 'battery' },
  { name: 'clipboard' },
  { name: 'clock' },
  { name: 'settings' },
  { name: 'quick' },
  {
    name: 'compact-charging',
    state: 'compact',
    prepare: (battery) => { state.battery = { ...battery, charging: true, level: 0.62, full: false }; },
  },
  {
    name: 'compact-transfer',
    // Long enough that it is still running, but far enough along to show the bar
    // and the dots. The capture happens 900 ms later.
    prepare: () => {
      const id = activities.startTransfer({ name: 'iPad', bytes: 24_000_000, durationMs: 2640 });
      return 'compact';
    },
  },
  {
    // The charger as a row item, half filled: the amber it starts in, on its way to
    // the green a full battery snaps to.
    name: 'compact-charging-item',
    prepare: () => {
      prefs.load().layout = layout.normalise({
        ...prefs.get('layout'),
        compact: ['media', 'battery', 'charging', 'volume', 'clock', 'cpu'],
      });
      state.battery = { ...state.battery, charging: true, level: 0.62, full: false };
      return 'compact';
    },
  },
  {
    // The same song small: the glyph on its own, no sleeve, for a crowded row.
    name: 'compact-media-small',
    prepare: () => {
      prefs.load().layout = layout.normalise({
        ...prefs.get('layout'),
        compact: ['media', 'volume', 'battery', 'cpu'],
      });
      prefs.load().layout.sizes.media = 'small';
      state.media = { ...STAGED_MEDIA, rate: 0, artwork: COVER };
      return 'compact';
    },
  },
  {
    name: 'compact-timer',
    prepare: () => { activities.startTimer(25); return 'compact'; },
  },
  {
    name: 'activity-charging',
prepare: (battery) => {
       state.battery = { ...battery, charging: true, level: 0.62, full: false };
       return 'activity:charging';
    },
  },
  {
name: 'activity-full',
     prepare: (battery) => {
       state.battery = { ...battery, charging: true, level: 1, full: true };
       return 'activity:charging';
    },
  },
  {
    name: 'activity-timer',
    prepare: () => `activity:${activities.startTimer(25)}`,
  },
  {
    name: 'activity-transfer',
    // 900 ms into a 2640 ms transfer is roughly 60% on the eased curve.
    prepare: () => {
      const id = activities.startTransfer({ name: 'iPad', bytes: 24_000_000, durationMs: 2640 });
      return `activity:${id}`;
    },
  },
  {
    name: 'activity-sent',
    // Past the end, but inside the done hold, so the check is still flashing.
    prepare: () => {
      const id = activities.startTransfer({ name: 'iPad', bytes: 24_000_000, durationMs: 600 });
      return `activity:${id}`;
    },
  },
  {
    name: 'compact-bubbles',
    // Three activities at once: an accessory, a recording app and a transfer.
    // More bubbles than fit side by side, which is the case that must still read
    // as one pill instead of spilling past its edges.
    prepare: () => {
      state.bluetooth = {
        devices: [{ address: 'AA-BB', name: 'AirPods Pro', connected: true, battery: 0.44, charging: false }],
      };
      state.input = { muted: false, volume: 0.8, active: ['Voice Memos'] };
      activities.startTransfer({ name: 'iPad', bytes: 24_000_000, durationMs: 9000 });
      return 'compact';
    },
  },
  {
    // Last, because it rewrites the widget row: the redesigned icons all in one
    // place, with album art to sit inside its progress ring. The preference is
    // only touched in memory, so the row goes back to the user's own on quit.
    name: 'compact-widgets',
    prepare: () => {
      prefs.load().layout = layout.normalise({
        ...prefs.get('layout'),
        compact: ['media', 'bluetooth', 'volume', 'mic', 'battery', 'clipboard', 'clock', 'cpu'],
      });
      state.media = {
        ...state.media,
        title: 'Blinding Lights',
        artist: 'The Weeknd',
        // Paused on purpose: with `rate` at zero the song stops being a live
        // activity, so the widgets keep the row to themselves.
        rate: 0,
        playbackState: 1,
        duration: 246,
        elapsed: 74,
        artwork: COVER,
      };
      return 'compact';
    },
  },
  {
    name: 'airdrop-live',
    // The wireless link is up: the widget shows that AirDrop is reachable.
    // That is the whole of what macOS lets us honestly report about it.
    prepare: () => {
      prefs.load().layout = layout.normalise({ ...prefs.get('layout'), compact: ['airdrop', 'volume', 'battery'] });
      state.airdrop = { live: true };
      return 'compact';
    },
  },
  {
    // The only shot with a sleeve in a bubble. A player reports the song before
    // its cover, so this is the case that has to survive a bubble being built
    // first and painted with the cover afterwards.
    name: 'compact-bubble-artwork',
    prepare: () => {
      prefs.load().layout = layout.normalise({ ...prefs.get('layout'), compact: ['volume', 'battery'] });
      state.bluetooth = {
        devices: [{ address: 'AA-BB', name: 'AirPods Pro', connected: true, battery: 0.44, charging: false }],
      };
      // The one thing `compact-widgets` avoids: a zero `rate` keeps the song from
      // becoming a live activity, and this shot is precisely about that bubble.
      state.media = { ...STAGED_MEDIA, rate: 1, playbackState: 1, elapsed: 74 };
      return 'compact';
    },
  },
  {
    name: 'bt-hello',
    // A device that was not connected a moment ago: the widget greets it, then
    // settles back to its battery. No battery reported means no activity takes
    // the row over, so this shot is the greeting itself.
    prepare: () => {
      // A short row, so the greeting has room and nothing else is dropped.
      prefs.load().layout = layout.normalise({ ...prefs.get('layout'), compact: ['bluetooth', 'volume', 'battery'] });
      state.bluetooth = {
        devices: [
          { address: 'AA-BB', name: 'AirPods Pro', connected: true, battery: -1, charging: false },
        ],
      };
      return 'compact';
    },
  },
  {
    // The editor has more in it than any other panel — a profile row, the surface
    // tabs, two arms around a housing and a palette — so it is the one worth
    // looking at before shipping a change to it.
    name: 'layout',
    prepare: () => {
      prefs.load().layout = layout.normalise({
        ...prefs.get('layout'),
        compact: ['media', 'volume', 'battery', 'clock', 'cpu'],
      });
      return 'layout';
    },
  },
  {
    // The update is on the island, so the small pill steps aside: what is being
    // photographed is the half-downloaded state as a bubble.
    name: 'compact-update-downloading',
    prepare: () => {
      prefs.load().layout = layout.normalise({ ...prefs.get('layout'), compact: ['volume', 'battery'] });
      state.update = { ...state.update, state: 'downloading', version: '1.1.0', progress: 0.62 };
      return 'compact';
    },
  },
  {
    // The other half: once the panel has been folded away the pill is all that
    // is left of the update, and it is the way back into it.
    name: 'compact-update-snoozed',
    prepare: () => {
      prefs.load().layout = layout.normalise({ ...prefs.get('layout'), compact: ['volume', 'battery'] });
      state.update = { ...state.update, state: 'ready', version: '1.1.0', progress: 1 };
      dismissed.set('update', Infinity);
      return 'compact';
    },
  },
  {
    name: 'activity-update-available',
    prepare: () => {
      state.update = { ...state.update, state: 'available', version: '1.1.0', progress: null };
      return 'activity:update';
    },
  },
  {
    // Downloaded and waiting: the bar is full and the only question left is when
    // to restart, so the panel offers exactly that and nothing else.
    name: 'activity-update-ready',
    prepare: () => {
      state.update = { ...state.update, state: 'ready', version: '1.1.0', progress: 1 };
      return 'activity:update';
    },
  },
];

/* A stand-in sleeve: the helper's artwork arrives as a data URL, so the shot
   needs one too, and an SVG gradient keeps it to a line of source. */
const COVER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23ff4d6d'/><stop offset='1' stop-color='%23ffc371'/></linearGradient></defs><rect width='64' height='64' fill='url(%23g)'/></svg>";

const STAGED_MEDIA = {
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  rate: 0,
  playbackState: 1,
  duration: 246,
  elapsed: 74,
  artwork: COVER,
};

async function captureReference () {
  const target = path.join(app.getPath('userData'), 'shot');
  fs.mkdirSync(target, { recursive: true });
  // The helper reads the battery on a two-second timer and `capturing` blocks
  // that feed, so a shot taken straight after launch would photograph the
  // launch default of 100 % instead of the machine it is running on.
  for (let attempt = 0; attempt < 30 && !batteryReported; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  capturing = true;
  // The page must be live before the panels can be captured.
  if (island.window.webContents.isLoading()) {
    await new Promise((resolve) => island.window.webContents.once('did-finish-load', resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const battery = state.battery;
  // Music is idle while the shots are taken, so the media card is staged for
  // the player panel and the widget row. A zero `rate` keeps the song from
  // becoming a live activity, which would open over the capture.
  state.media = STAGED_MEDIA;
  // Accessories and recording apps are staged by a shot as well, so the machine
  // gets its own state back before the next one starts.
  const bluetooth = state.bluetooth;
  const input = state.input;
  const airdrop = state.airdrop;
  const update = state.update;
  const stagedLayout = prefs.get('layout');

  for (const shot of SHOTS) {
    // An activity opening on its own would hijack the capture, and a transfer
    // left over from the previous shot would sit in the next one.
    clearTimeout(activityTimer);
    for (const live of activities.liveTransfers()) activities.cancelTransfer(live.id);
    for (const timer of activities.liveTimers()) activities.cancelTimer(timer.timer.id);
    // A staged battery belongs to the shot that asked for it: everything else
    // goes back to what the machine actually reports. Music goes back to the
    // staged track with `rate` at zero, which is deliberately not an activity, so
    // a shot that stages a playing song does not open a bubble over the next one.
    state.battery = battery;
    state.media = STAGED_MEDIA;
    state.bluetooth = bluetooth;
    state.input = input;
    state.airdrop = airdrop;
    state.update = update;
    prefs.load().layout = stagedLayout;
    dismissed.delete('update');
    // A staged shot may return the state it needs, since a transfer only exists
    // under an id the module just made up.
    const staged = shot.prepare?.(battery) ?? null;
    island.setState(shot.state ?? staged ?? shot.name);
    island.resize(null, { animate: false });
    push({ announce: false });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const image = await island.window.webContents.capturePage();
    fs.writeFileSync(path.join(target, `${shot.name}.png`), image.toPNG());
    fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify(snapshot(), null, 2));
    const report = await island.window.webContents.executeJavaScript(`(() => {
      const arm = (id) => {
        const node = document.getElementById(id);
        return { children: node.childElementCount, scroll: node.scrollWidth, w: Math.round(node.getBoundingClientRect().width) };
      };
      // The charge and transfer bars cannot be reviewed from a PNG by eye, so
      // the report measures them: where they are, how full they are and what
      // colour they ended up.
      const box = (sel) => {
        const node = document.querySelector(sel);
        if (!node || node.hidden || !node.getClientRects().length) return null;
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const css = (sel, prop) => {
        const node = document.querySelector(sel);
        return node ? getComputedStyle(node).getPropertyValue(prop).trim() : null;
      };
      return JSON.stringify({
        state: document.getElementById('island').dataset.state,
        activePanel: document.querySelector('.panel.active')?.dataset.panel ?? 'none',
        activePanels: [...document.querySelectorAll('.panel.active')].map((p) => p.dataset.panel),
        island: document.getElementById('island').getBoundingClientRect().width,
        left: arm('armLeft'), right: arm('armRight'), gap: Math.round(document.getElementById('notchGap').getBoundingClientRect().width),
        requested: window.__island.view.frame.width,
        widths: window.__island.view.widths,
        chargeGlow: document.getElementById('island').classList.contains('charge-glow'),
        layout: (() => {
          const out = {};
          for (const sel of ['#island', '.panels', '.panel.active', '.compact']) {
            const node = document.querySelector(sel);
            if (!node) continue;
            const s = getComputedStyle(node);
            out[sel] = {
              offset: node.offsetWidth,
              rect: Math.round(node.getBoundingClientRect().width * 100) / 100,
              css: s.width, transform: s.transform, flexDir: s.flexDirection, align: s.alignItems,
            };
          }
          return out;
        })(),
        charge: {
          block: box('#chargeBar'), battery: box('#chargeBar .charge-battery'),
          level: box('#chargeBar .charge-level'),
          colour: css('#chargeBar .charge-level', 'background-color'),
          bolt: document.getElementById('chargeBolt')?.childElementCount ?? 0,
          full: document.getElementById('chargeBar')?.classList.contains('full') ?? null,
          state: document.getElementById('chargeState')?.textContent,
          glow: css('#island', '--glow'),
        },
        xfer: {
          block: box('#transferBar'), icon: box('#transferIcon'),
          fill: box('#transferBar .xfer-fill'),
          dotFrom: box('#transferBar .xfer-dot.from'), dotTo: box('#transferBar .xfer-dot.to'),
          progress: css('#transferBar', '--progress'),
          done: document.getElementById('transferBar')?.classList.contains('done') ?? null,
          check: document.getElementById('transferCheck')?.childElementCount ?? 0,
          caption: document.getElementById('transferCaption')?.textContent,
        },
        mini: {
          bar: box('.mini-bar'), fill: box('.mini-bar > i.fill'),
          dotFrom: box('.mini-bar > i.dot.from'), dotTo: box('.mini-bar > i.dot.to'),
          progress: css('.mini-bar', '--progress'),
          sent: document.querySelector('.bubble.sent') !== null,
        },
      });
    })()`);
    console.log(`[${shot.name}] ${report}`);
  }
  state.battery = battery;
  state.update = update;
  prefs.load().layout = stagedLayout;
  dismissed.delete('update');
  capturing = false;
  console.log(`screenshots written to ${target}`);
  app.quit();
}

// ---------------------------------------------------------------- hotkeys

function applyPreferences () {
  state.hotkeys = hotkeys.apply(prefs.load());
  // The activities are derived from `state`, not from the snapshot, so the row the
  // user arranged has to be on the state itself: it is what decides whether the
  // charger says anything at all.
  state.compact = compactRow();
  app.setLoginItemSettings({ openAtLogin: prefs.get('launchAtLogin') === true, openAsHidden: true });
  refreshTrayMenu();
  push();
}

/** What is in the island row, as the activities ask for it. */
function compactRow () {
  return layout.arranged(prefs.get('layout'), 'compact');
}

function handleHotkey (action) {
  switch (action) {
    case 'media.previous': run('media.previous'); break;
    case 'media.playPause': run('media.playPause'); break;
    case 'media.next': run('media.next'); break;
    case 'volume.down': run('volume.nudge', { delta: -0.0625 }); break;
    case 'volume.up': run('volume.nudge', { delta: 0.0625 }); break;
    case 'volume.mute': run('volume.mute'); break;
    case 'island.toggle': toggleIsland(); break;
    default:
      if (action.startsWith('island.')) run('panel.open', { state: action.slice('island.'.length) });
  }
}

/** How long an activity keeps the island open before it folds away again. */
const ACTIVITY_LINGER_MS = 4500;
let activityTimer = null;

/**
 * Set while `--shot` is staging its scenes: the helper keeps publishing the real
 * battery every couple of seconds, and that would pull the staged charging state
 * out from under the capture (and fold the panel it just opened).
 */
let capturing = false;

/**
 * The helper reads the system battery on a two-second timer, so `state.battery`
 * still holds its initial value for the first couple of seconds of a launch.
 * The selftest waits on this instead of guessing how long that takes.
 */
let batteryReported = false;

function refreshActivities () {
  const now = Date.now();
  for (const [id, until] of dismissed) if (until < now) dismissed.delete(id);

  const previous = state.activities;
  const next = activities
    .derive(state)
    .filter((activity) => !dismissed.has(activity.id));
  state.activities = next;

  // A finished transfer and a full battery both retire themselves. When the island
  // is sitting on one of those, it has to fold away instead of showing an empty
  // activity panel.
  if (island.state.startsWith('activity:')
    && !next.some((activity) => island.state === `activity:${activity.id}`)) {
    run('panel.open', { state: 'compact' });
  }

  return activities.freshIds(previous, next);
}

/**
 * Opens the island for an event on its own, the way the iPhone island reacts to
 * a call. It folds back to the idle pill unless the pointer is resting on it.
 */
function presentActivity (id) {
  const activity = state.activities.find((entry) => entry.id === id);
  if (!activity) return;
  if (!activities.shouldPresent(island.state)) return;
  island.lastPanel = 'player';
  run('panel.open', { state: `activity:${id}` });
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    if (island.state.startsWith('activity:')) run('panel.open', { state: 'compact' });
  }, ACTIVITY_LINGER_MS);
}

function toggleIsland () {
  const next = island.state === 'compact' ? (state.media.title ? 'player' : 'settings') : 'compact';
  run('panel.open', { state: next });
}

// ---------------------------------------------------------------- actions

/**
 * Every interaction in the UI funnels through here, so the renderer never needs
 * to know whether something happens in this process or in the helper.
 */
const actions = {
  'media.playPause': () => run('media.command', { command: 'togglePlayPause' }),
  'media.play': () => run('media.command', { command: 'play' }),
  'media.pause': () => run('media.command', { command: 'pause' }),
  'media.next': () => run('media.command', { command: 'next' }),
  'media.previous': () => run('media.command', { command: 'previous' }),
  'media.seek': ({ seconds }) => run('media.command', { command: 'seek', value: seconds }),

  'volume.set': ({ value }) => helper.send('volume', { value }),
  'volume.nudge': ({ delta }) => helper.send('nudgeVolume', { value: delta }),
  'volume.mute': () => helper.send('mute'),
  'output.set': ({ id }) => helper.send('setOutput', { id }),
  'output.cycle': () => cycleDevice(false),

  'input.set': ({ id }) => helper.send('setInput', { id }),
  'input.mute': () => helper.send('muteInput'),
  'input.volume': ({ value }) => helper.send('inputVolume', { value }),
  'input.cycle': () => cycleDevice(true),

  'timer.start': ({ minutes }) => {
    const id = activities.startTimer(minutes);
    push();
    setTimeout(() => presentActivity(id), 60);
  },
  'timer.pause': ({ id }) => { activities.pauseTimer(id); push(); },
  'timer.resume': ({ id }) => { activities.resumeTimer(id); push(); },
  'timer.cancel': ({ id }) => {
    activities.cancelTimer(id);
    run('panel.open', { state: 'compact' });
    push({ announce: false });
  },
  'activity.dismiss': ({ id }) => {
    if (id?.startsWith('timer-')) activities.cancelTimer(id);
    else if (id?.startsWith('transfer-')) activities.cancelTransfer(id);
    // An update does not go away on its own, so "Later" has to mean something
    // that lasts: dismissed until the app is started again, when it is checked
    // and announced once more if it is still there.
    else dismissed.set(id, id === UPDATE_ACTIVITY ? Infinity : Date.now() + ACTIVITY_LINGER_MS);
    if (island.state === `activity:${id}`) run('panel.open', { state: 'compact' });
    else push();
  },

  // ---------------------------------------------------------------- updates

  'update.check': () => updater.check(),
  'update.download': () => updater.download(),
  'update.install': () => { updater.install(); },

  // A finished AirDrop is not something an app is allowed to hear about, so this
  // is started by hand. The animation is real; only the trigger is ours.
  'transfer.start': ({ name, bytes, durationMs } = {}) => {
    const id = activities.startTransfer({ name, bytes, durationMs });
    push();
    setTimeout(() => presentActivity(id), 60);
    return id;
  },
  'transfer.cancel': ({ id }) => {
    activities.cancelTransfer(id);
    if (island.state === `activity:${id}`) run('panel.open', { state: 'compact' });
    push({ announce: false });
  },

  'player.open': () => {
    const app = state.media.preferredApp ?? 'Music';
    shell.openExternal(`${app.toLowerCase().replace(/\s+/g, '')}://`);
  },
  'media.command': ({ command, ...rest }) => {
    // Give the user feedback: with nothing playing the system has nowhere to
    // send the command, which otherwise looks like a broken button.
    if (!state.media.title) {
      island.send('toast', { message: 'Nothing is playing' });
      return;
    }
    // The adapter is the only path that reaches the player on macOS 15.4+; the
    // helper is kept for the versions where its command centre still works.
    if (!mediaRemote.command(command, rest.value)) helper.send(command, rest);
  },

  'bluetooth.connect': ({ address }) => helper.send('btConnect', { address }),
  'bluetooth.disconnect': ({ address }) => helper.send('btDisconnect', { address }),
  'bluetooth.refresh': () => helper.send('bluetooth'),

  'clipboard.copy': ({ text }) => { clipboard.writeText(text).catch(() => {}); },
  'clipboard.paste': ({ index = 0 }) => {
    const item = state.clipboard.items[index];
    if (item) clipboard.writeText(item.text).catch(() => {});
  },
  'clipboard.clear': () => {
    state.clipboard.items = [];
    push();
  },

  'panel.open': ({ state: panel }) => {
    island.setState(panel === 'compact' ? 'compact' : panel);
    island.resize();
  },
  // Folds the island back to the idle pill. The panel close buttons and the
  // fold-away chevron both funnel through here.
  'close': () => run('panel.open', { state: 'compact' }),
  'island.toggle': () => toggleIsland(),

  'prefs.set': ({ patch }) => {
    prefs.save(patch);
    applyPreferences();
    island.syncDisplays().then(() => island.resize(null, { animate: false }));
  },
  'helper.retry': () => helper.start(),
  'shell.open': ({ target }) => shell.openExternal(target),

  // ------------------------------------------------------------- the layout

  /**
   * Everything the layout editor can do, because they all end in the same two
   * things: an arrangement in the preferences and an island that has to be
   * measured and drawn again. Splitting it up would only move that pair around.
   */
  'layout.set': ({ change }) => {
    prefs.setLayout(layout.change(prefs.get('layout'), change));
    layoutChanged();
  },  'layout.reset': () => {
    prefs.setLayout(layout.normalise(null));
    layoutChanged();
  },

  // ------------------------------------------------------------- the mods
  //
  // The renderer hands over what its mods registered, and this is where it becomes
  // part of the island: the widgets join the row the user arranges, and the panels
  // join the list the tray and the radio menu draw from.

  // `registered` rather than `mods`: destructuring the argument under the module's
  // own name would shadow the module, and `mods.sync` would then be a property of the
  // metadata array — which is how a rename became a crash on the first mod loaded.
  'mods.set': ({ mods: registered }) => {
    state.mods = Array.isArray(registered) ? registered : [];
    mods.sync(state, prefs, layout);
  },
  'mods.toggle': ({ name, on }) => {
    prefs.save({ mods: { ...prefs.get('mods'), [name]: on !== false } });
    // The switch has to reach the arrangement, not just the preferences: a mod that
    // is off takes its widgets out of the row, and that is the whole of the switch.
    mods.sync(state, prefs, layout);
    applyPreferences();
  },
  'layout.profile': ({ name }) => {
    prefs.useProfile(name);
    layoutChanged();
  },
  'layout.newProfile': ({ name }) => {
    prefs.newProfile(name);
    layoutChanged();
  },
  'layout.renameProfile': ({ from, to }) => {
    prefs.renameProfile(from, to);
    layoutChanged();
  },
  'layout.deleteProfile': ({ name }) => {
    prefs.deleteProfile(name);
    layoutChanged();
  },
};

/**
 * An arrangement changes what the island is, so it is measured and drawn again
 * from scratch, and the tray has to hear about it: the profile menu is where the
 * island is switched without opening anything.
 */
function layoutChanged () {
  applyPreferences();
  island.syncDisplays().then(() => island.resize(null, { animate: false }));
  push();
}

function run (name, args = {}) {
  const action = actions[name];
  if (!action) {
    console.warn('[actions] unknown action', name);
    return;
  }
  action(args);
}

/** Transport buttons are live whenever either path can deliver a command. */
function syncControl () {
  state.media.controlled = mediaRemote.available || helper.status().available;
}

function cycleDevice (isInput) {
  const list = state.devices.list.filter((device) => device.input === isInput);
  if (list.length < 2) return;
  const current = list.findIndex((device) => device.isDefault);
  const next = list[(current + 1) % list.length];
  helper.send(isInput ? 'setInput' : 'setOutput', { id: next.id });
}

ipcMain.handle('state:request', () => snapshot());
ipcMain.handle('mods:list', () => mods.load());
ipcMain.on('action', (_event, { name, args }) => run(name, args ?? {}));
  ipcMain.on('island:request-size', (_event, { width, height, shift }) => island.resize(width, { height, shift }));
ipcMain.on('island:pointer', (_event, { inside }) => {
  island.setInteractive(inside);
  island.setHovering(inside && island.state === 'compact');
});
ipcMain.on('island:drag', (_event, { phase, deltaY }) => {
  if (phase === 'start') island.beginDrag();
  else if (phase === 'move') island.drag(deltaY);
  else island.endDrag();
});

// ---------------------------------------------------------------- data flow

function onHelperEvent (message) {
  switch (message.event) {
    case 'nowPlaying':
      // The helper keeps reporting an empty feed because mediaremoted refuses
      // it. While the adapter is up that is noise, and it would clear the song.
      if (message.via !== 'adapter' && mediaRemote.available) break;
      if (message.empty) cover.reset();
      state.media = {
        title: message.title ?? '',
        artist: message.artist ?? '',
        album: message.album ?? '',
        // A frame without a cover is not a song without one. MediaRemote sends the
        // artwork on its own schedule and takes it away again for a moment while
        // the item stays the same, so only the next song is allowed to take the
        // cover on screen away — otherwise a track that does have one spends most
        // of its length as a music note.
        artwork: message.empty ? null : cover.take(message),
        duration: message.duration ?? 0,
        elapsed: message.elapsed ?? 0,
        rate: message.rate ?? 0,
        playbackState: message.state ?? 0,
        source: message.source ?? '',
        preferredApp: message.preferredApp ?? null,
        controlled: state.media.controlled,
      };
      break;
    case 'volume':
      state.volume = { value: message.value, muted: message.muted };
      break;
    case 'devices':
      state.volume = { value: message.volume, muted: message.muted };
      state.input = { muted: message.inputMuted, volume: message.inputVolume, active: message.activeInputs ?? [] };
      state.devices = { list: message.devices ?? [], output: message.output, input: message.input };
      break;
    case 'input':
      state.input = { muted: message.muted, volume: message.volume, active: message.active ?? [] };
      break;
    case 'battery':
      batteryReported = true;
      if (!capturing) {
        state.battery = { level: message.battery.level, charging: message.battery.charging, minutes: message.battery.minutes, full: message.battery.full };
      }
      break;
    case 'bluetooth':
       state.bluetooth = { devices: message.devices ?? [] };
       break;
    case 'airdrop':
       // The interface being up is not a transfer. macOS has no public feed for
       // AirDrop, and `awdl0` is present whenever AirDrop is switched on, so
       // treating it as one had the island opening a send that never happened
       // every time the interface blinked. All it honestly proves is that
       // AirDrop is reachable, which is what the widget says. The animation is
       // still started by hand from the tray (`transfer.start`).
       state.airdrop = { live: Boolean(message.transferring) };
       break;
     case 'call':
       if (message.incoming) {
         activities.startTimer(15);
         push();
         const timer = state.activities.find((a) => a.id.startsWith('timer-'));
         presentActivity(timer?.id);
       }
       break;
      case 'mediaKey':
       // The user pressed a media key and macOS routed it to us: forward it on.
       if (!mediaRemote.command(message.key, message.value)) {
         helper.send(message.key, message.value === undefined ? {} : { value: message.value });
       }
       break;

    case 'toast':
      island.send('toast', message);
      break;
    default:
      break;
  }
  push();
}

function startPolling () {
  helper.send('devices');
  helper.send('input');
  helper.send('battery');
  helper.send('bluetooth');

  // Elapsed time has to be advanced locally between now-playing updates, but
  // only while something is actually playing.
  mediaTimer = setInterval(() => {
    if (state.media.duration > 0 && state.media.rate > 0) {
      state.media.elapsed = Math.min(state.media.duration, state.media.elapsed + 1);
    }
    island.send('media:tick', { elapsed: state.media.elapsed, playing: state.media.rate > 0 });
  }, 1000);

  // A slow full refresh keeps timers, clock and percentages honest. Countdown
  // timers need a faster tick to move their progress.
  setInterval(() => {
    if (activities.liveTimers().length) push();
  }, 1000);

  // A transfer is the one thing that has to look continuous rather than stepped,
  // so while one is in flight the island gets a much finer tick. The bar itself
  // eases between these, which is what hides the seam.
  setInterval(() => {
    if (activities.liveTransfers().length) push();
  }, 250);
  setInterval(push, 10_000);

  if (process.argv.includes('--dev')) {
    let frames = 0;
    setInterval(() => {
      console.log(`[perf] window frames in the last second: ${frames}`);
      frames = 0;
    }, 1000);
    island.onFrame = () => { frames += 1; };
  }

  clipboardTimer = setInterval(pollClipboard, CLIPBOARD_POLL_MS);
  cpuTimer = setInterval(() => {
    const cpus = os.cpus();
    const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    const total = cpus.reduce((sum, cpu) => {
      const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
      return sum + user + nice + sys + cpuIdle + irq;
    }, 0);
    state.system.cpu = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    island.send('system:tick', { cpu: state.system.cpu });
  }, CPU_POLL_MS);

  setInterval(() => {
    state.system.micAccess = systemPreferences.getMediaAccessStatus('microphone');
    state.system.displays = screen.getAllDisplays().length;
    push();
  }, BATTERY_POLL_MS);
}

async function pollClipboard () {
  const text = await clipboard.readText().catch(() => '');
  if (!text || text === state.clipboard.lastSeen) return;
  state.clipboard.lastSeen = text;
  const items = [{ text, time: Date.now(), kind: kindOf(text) }, ...state.clipboard.items.filter((item) => item.text !== text)];
  state.clipboard.items = items.slice(0, CLIPBOARD_HISTORY_LIMIT);
  push();
}

function kindOf (text) {
  if (/^https?:\/\//i.test(text)) return 'link';
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(text)) return 'email';
  if (/[\n\r]/.test(text)) return 'text';
  if (text.length <= 6) return 'code';
  return 'text';
}

/**
 * The size every item that can be more than one size is drawn at, resolved against
 * the items this version knows. An item with no choice is simply not in here.
 */
function sizesOf (current) {
  const clean = layout.normalise(current);
  const out = {};
  for (const item of layout.itemsOf('compact')) {
    const size = layout.sizeOf(clean, 'compact', item.id);
    if (size) out[item.id] = size;
  }
  return out;
}

function snapshot () {
  const profiles = prefs.layoutProfiles();
  return copyState({
    ...state,
    // The renderer reads this back: while `--shot` composes a scene the pointer
    // must not fold the panel it just opened. A cursor resting on the notch makes
    // the island fire a mouseleave whenever it changes size, and the capture
    // photographs the compact pill instead of the panel.
    capturing,
    prefs: prefs.load(),
    geometry: island.geometry(),
    helper: helper.status(),
    // What can be arranged where, and what is arranged where. The renderer draws
    // the editor from this and nothing else, so a surface added to the layout
    // module shows up without the renderer knowing anything about it.
    layout: {
      surfaces: layout.SURFACES,
      arranged: {
        ...Object.fromEntries(
          layout.surfaceNames().map((surface) => [surface, layout.arranged(prefs.get('layout'), surface)]),
        ),
        compact: state.compact ?? compactRow(),
      },
      // How full each side is, and how full it may be. The editor draws the counter
      // from this and refuses a drop onto a side that is full, so the rule is
      // visible before it is felt.
      limit: layout.MAX_PER_SIDE,
      fullness: layout.fullness(prefs.get('layout'), 'compact'),
      profile: profiles.active,
      profiles: Object.keys(profiles.all),
      // Dynamic max width for the island (allows growing/shrinking with content)
      maxWidth: island.dynamicMaxWidth,
    },
  });
}

let lastPush = '';

function push ({ announce = true } = {}) {
  const fresh = refreshActivities();
  const payload = trimForPush(snapshot());
  const encoded = JSON.stringify(payload);
  // The helper polls a few things several times a minute; re-rendering an
  // unchanged island is pure waste.
  if (encoded === lastPush) return;
  lastPush = encoded;
  if (announce && fresh.length) presentActivity(fresh[0]);
  try {
    island.send('state:update', payload);
  } catch (error) {
    console.error('[push] could not deliver the state snapshot:', error.message);
  }
}

// ---------------------------------------------------------------- tray

function trayIcon () {
  const file = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');
  const image = nativeImage.createFromPath(file);
  image.setTemplateImage(true);
  return image;
}

function createTray () {
  tray = new Tray(trayIcon());
  tray.setToolTip('Notch Island');
  refreshTrayMenu();
  tray.on('click', () => toggleIsland());
}

function refreshTrayMenu () {
  if (!tray) return;
  const panel = island.state === 'compact' ? null : island.state;
tray.setContextMenu(Menu.buildFromTemplate([
     { label: 'Open the island', click: () => run('panel.open', { state: 'settings' }) },
     // macOS keeps the AirDrop handshake private, so the animation is demonstrated
     // from here rather than discovered.
     { label: 'Show an AirDrop transfer', click: () => run('transfer.start', {}) },
     { type: 'separator' },
     { label: 'Timer: 5 min', click: () => run('timer.start', { minutes: 5 }) },
     { label: 'Timer: 10 min', click: () => run('timer.start', { minutes: 10 }) },
     { label: 'Timer: 25 min', click: () => run('timer.start', { minutes: 25 }) },
     { type: 'separator' },
     ...['quick', 'player', 'volume', 'mic', 'bluetooth', 'battery', 'clipboard', 'clock', 'settings'].map((id) => ({
      label: labelForPanel(id),
      type: 'radio',
      checked: panel === id,
      click: () => run('panel.open', { state: id }),
    })),
    { type: 'separator' },
    { label: 'Arrange the island…', click: () => run('panel.open', { state: 'layout' }) },
    ...profileMenuItems(),
    {
      label: 'Expand on hover',
      type: 'checkbox',
      checked: prefs.get('island.hoverToExpand') !== false,
      click: (item) => run('prefs.set', { patch: { island: { hoverToExpand: item.checked } } }),
    },
    {
      label: 'Fill the notch (compact shape)',
      type: 'checkbox',
      checked: prefs.get('island.style') === 'notch',
      click: (item) => run('prefs.set', { patch: { island: { style: item.checked ? 'notch' : 'pill' } } }),
    },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: prefs.get('launchAtLogin') === true,
      click: (item) => run('prefs.set', { patch: { launchAtLogin: item.checked } }),
    },
    { type: 'separator' },
    ...updateMenuItems(),
    { type: 'separator' },
    { label: 'Quit Notch Island', accelerator: 'Command+Q', click: () => app.quit() },
  ]));
}

/**
 * Switching arrangement without opening anything: a profile is a whole set of
 * surfaces, so one item here replaces editing three lists by hand.
 */
function profileMenuItems () {
  const { active, all } = prefs.layoutProfiles();
  const names = Object.keys(all);
  if (names.length < 2) return [];
  return [{
    label: 'Profile',
    submenu: names.map((name) => ({
      label: name,
      type: 'radio',
      checked: name === active,
      click: () => run('layout.profile', { name }),
    })),
  }];
}

/**
 * The island is where an update announces itself, but the tray is where it is
 * asked for: there has to be a way to check without waiting for a launch, and a
 * way to install without hunting for the panel.
 */
function updateMenuItems () {
  const { state: updateState, version } = state.update;
  if (updateState === 'ready') {
    return [
      {
        label: version ? `Restart and install ${version}` : 'Restart and install',
        click: () => run('update.install'),
      },
    ];
  }
  if (updateState === 'downloading' || updateState === 'checking') {
    return [{ label: 'Checking for updates…', enabled: false }];
  }
  return [{
    label: updateState === 'error' ? 'Retry update check' : 'Check for Updates…',
    click: () => run('update.check'),
  }];
}

function labelForPanel (id) {
  return {
    quick: 'Quick controls',
    player: 'Player',
    volume: 'Sound',
    mic: 'Microphone',
    bluetooth: 'Bluetooth',
    battery: 'Battery',
    clipboard: 'Clipboard',
    clock: 'Clock',
    settings: 'Settings',
  }[id] ?? id;
}

app.on('before-quit', refreshTrayMenu);

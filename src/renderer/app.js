'use strict';

/* global island, icon */

/**
 * Renderer. Everything privileged lives in the main process; this file renders
 * the state it is handed and turns clicks into named actions.
 */

const api = window.island;

const el = (id) => document.getElementById(id);
const root = el('island');

const PANEL_WIDTH = 420;
/** The arranging panel holds a palette and two arms, so it is given more room. */
const LAYOUT_WIDTH = 540;

const view = {
  state: 'compact',
  frame: { width: 220, islandHeight: 32 },
  notch: { width: 0, height: 0, detected: false },
  maxWidth: 440,
  style: 'pill',
  hoverToExpand: true,
  layout: null,
  surface: { right: [], left: [] },
  pinned: false,
  lastPanel: 'player',
  snapshot: null,
  widgetNodes: new Map(),
  bubbleNodes: new Map(),
  bubbleCount: 0,
  tightBubbles: 0,
  widgetSignature: '',
  appliedState: 'compact',
  connectedBluetooth: null,
  bluetoothHello: null,
  sections: {},
  band: 38,
  lastActivity: null,
};

// ---------------------------------------------------------------- helpers

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/* The charge colour walks from amber to green as the battery fills. It is
   computed here rather than in CSS so the same value can drive the bolt, the
   meter, the bar and the halo around the island. */
const CHARGE_FROM = [255, 159, 10];
const CHARGE_TO = [48, 209, 88];

/* The colour a feature's progress bar wears, so the panel says the same thing
   in the same colour as the bubble beside the housing. */
const PROGRESS_TINT = {
  timer: 'var(--orange)',
  media: 'var(--purple)',
  bluetooth: 'var(--blue)',
  transfer: 'var(--blue)',
  update: 'var(--green)',
  mic: 'var(--red)',
};

/**
 * Whether an update is worth a place in the island. A machine that is already up
 * to date, and a check that failed, both stay silent: the island opening every
 * launch to say "nothing" would be worse than saying nothing at all.
 */
function hasSomethingToAnnounce (update) {
  return ['available', 'downloading', 'ready'].includes(update?.state);
}

function chargeColor (level) {
  // Nothing happens until the battery is worth mentioning, and full is full green.
  const t = clamp((clamp(level, 0, 1) - 0.1) / 0.85, 0, 1);
  const rgb = CHARGE_FROM.map((from, index) => Math.round(from + (CHARGE_TO[index] - from) * t));
  return {
    base: `rgb(${rgb.join(' ')})`,
    soft: `rgb(${rgb.join(' ')} / 0.22)`,
  };
}

/** Applies the charge colour to a node and everything inside it. */
function tintCharge (node, level) {
  const { base, soft } = chargeColor(level);
  node.style.setProperty('--charge', base);
  node.style.setProperty('--charge-soft', soft);
}

/** The addresses currently connected, so the next render can spot an arrival. */
function connectedAddresses (devices) {
  return new Set(devices.filter((device) => device.connected).map((device) => device.address));
}

/**
 * A device that just connected says so in the row for a few seconds: the widget
 * swells, the icon gives its ripple and the pill reads "Connected to …" before it
 * settles back to the battery percentage. The greeting lives in the view rather
 * than in the node, so a re-render cannot take it away halfway.
 */
const HELLO_MS = 2600;
let helloTimer = null;

function greetBluetooth (name) {
  view.bluetoothHello = name;
  clearTimeout(helloTimer);
  helloTimer = setTimeout(() => {
    if (view.bluetoothHello !== name) return;
    view.bluetoothHello = null;
    if (!view.snapshot) return;
    renderWidgets(view.snapshot);
    requestSize(); // the pill was wider than the circle it turns back into
  }, HELLO_MS);
}

function timecode (seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function relativeTime (stamp) {
  const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

let toastTimer = null;
function toast (message) {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 1400);
}

// ---------------------------------------------------------------- widgets

const WIDGETS = {
  media: {
    label: 'Music',
    render (state) {
      const { title, artwork, playbackState } = state.media;
      if (!title && playbackState <= 0) return null;
      const node = document.createElement('button');
      const size = widgetSize('media');
      node.className = `widget${playbackState <= 0 ? ' dim' : ''}${size === 'small' ? ' small' : ''}`;
      node.dataset.panelOpen = 'player';
      // Big: album art inside a ring of playback progress — one round thing, no
      // label, because the island names the song by its cover. Small: the glyph on
      // its own, for a row that has more in it than the art can spare room for.
      if (artwork && size !== 'small') {
        const ring = document.createElement('span');
        ring.className = 'ring';
        ring.style.setProperty('--progress', String(progressOf(state.media)));
        const image = document.createElement('img');
        image.className = 'ring-art';
        image.src = artwork;
        ring.append(image);
        node.append(ring);
      } else {
        node.insertAdjacentHTML('beforeend', icon('music', { size: 14 }));
      }
      node.title = title || 'Apple Music';
      return node;
    },
  },

  charging: {
    label: 'Charging',
    render (state) {
      // The charger is the one widget that only exists while it is true: the level
      // and the bolt, in the amber the island fills with. It is here because the
      // arrangement says so — take it out and the island stops opening for the
      // charger as well, so there is one switch for the whole thing.
      const { level, charging } = state.battery;
      if (!charging) return null;
      const node = document.createElement('button');
      node.className = 'widget readout charge-widget';
      node.dataset.panelOpen = 'battery';
      tintCharge(node, level);
      const bolt = document.createElement('span');
      bolt.className = 'charging';
      bolt.innerHTML = icon(level >= 1 ? 'checkFill' : 'batteryBolt', { size: 11, filled: true });
      node.append(bolt);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${Math.round(level * 100)}%`;
      node.append(label);
      node.title = level >= 1 ? 'Fully charged' : `Charging · ${Math.round(level * 100)}%`;
      return node;
    },
  },

  volume: {
    label: 'Volume',
    render (state) {
      const node = document.createElement('button');
      node.className = `widget readout${state.volume.muted ? ' dim' : ''}`;
      node.dataset.panelOpen = 'volume';
      const level = state.volume.muted ? 0 : state.volume.value;
      node.insertAdjacentHTML('beforeend', icon(level > 0.5 ? 'volumeHigh' : level > 0.02 ? 'volumeLow' : 'volumeMute', { size: 14 }));
      // A mute is not an alarm: the number just reads 0, the way the label
      // does. The red alarm tint is saved for things worth a warning.
      const label = document.createElement('span');
      label.className = 'label';
      // The battery and the CPU both wear a %, so the volume does too: a bare
      // number next to two percentages reads as a different kind of thing.
      label.textContent = state.volume.muted ? 'Mute' : `${Math.round(state.volume.value * 100)}%`;
      node.append(label);
      node.title = state.volume.muted ? 'Muted' : 'Output volume';
      return node;
    },
  },

  mic: {
    label: 'Mic',
    render (state) {
      const node = document.createElement('button');
      const live = state.input.active.length > 0;
      node.className = `widget${state.input.muted ? ' dim' : ''}${live ? ' alert' : ''}`;
      node.dataset.panelOpen = 'mic';
      node.insertAdjacentHTML('beforeend', icon(state.input.muted ? 'micOff' : 'mic', { size: 14 }));
      node.title = state.input.muted ? 'Microphone off' : live ? `Live: ${state.input.active.join(', ')}` : 'Microphone';
      return node;
    },
  },

  battery: {
    label: 'Battery',
    render (state) {
      const { level, charging, minutes } = state.battery;
      const node = document.createElement('div');
      node.className = 'widget readout';
      node.dataset.panelOpen = 'battery';
      const percent = Math.round(level * 100);
      if (charging) {
        const bolt = document.createElement('span');
        bolt.className = 'charging';
        bolt.innerHTML = icon('batteryBolt', { size: 11, filled: true });
        node.append(bolt);
        node.classList.add('is-charging');
      }
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${percent}%`;
      node.append(label);
      node.title = minutes > 0 && !charging ? `${minutes} min left` : `${percent}%`;
      if (percent <= 20 && !charging) node.classList.add('alert');
      return node;
    },
  },

  bluetooth: {
    label: 'Bluetooth',
    render (state) {
      const devices = state.bluetooth.devices ?? [];
      // The interesting one is a connected accessory that reports a battery:
      // AirPods, Magic Mouse, Magic Keyboard, Trackpad.
      const tracked = devices
        .filter((device) => device.connected && device.battery >= 0)
        .sort((a, b) => a.battery - b.battery)[0];

      // A device that was not connected a moment ago is the one worth greeting,
      // whatever its battery is doing. The first render only learns what is
      // already there: nothing says hello to what was paired before launch.
      const seen = view.connectedBluetooth;
      const arrived = seen && devices.find((device) => device.connected && !seen.has(device.address));
      view.connectedBluetooth = new Set(devices.filter((device) => device.connected).map((device) => device.address));
      if (arrived) greetBluetooth(arrived.name);

      const node = document.createElement('button');
      const low = tracked && tracked.battery <= 0.2;
      const hello = view.bluetoothHello;
      node.className = `widget${tracked || hello ? ' readout' : ''}${low ? ' alert' : ''}${tracked && tracked.charging ? ' is-charging' : ''}${hello ? ' bt-hello' : ''}`;
      node.dataset.panelOpen = 'bluetooth';
      node.insertAdjacentHTML('beforeend', icon('bluetooth', { size: 14 }));
      if (hello) {
        // The row is a tight space, so the widget carries only the name and the
        // full "Connected to …" is what the activity bubble says — that one owns
        // the island while the accessory is there.
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = hello;
        node.append(label);
        node.classList.add('bt-connect');
        node.title = `Connected to ${hello}`;
        return node;
      }
      if (tracked && tracked.charging) {
        const charging = document.createElement('span');
        charging.className = 'charging';
        charging.innerHTML = icon('batteryBolt', { size: 11, filled: true });
        node.append(charging);
        tintCharge(node, tracked.battery);
      }
      if (tracked) {
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = `${Math.round(tracked.battery * 100)}%`;
        node.append(label);
      }
      node.title = tracked ? `${tracked.name} ${Math.round(tracked.battery * 100)}%` : 'No accessory connected';
      // An Apple accessory that just connected gets a little hello: the icon
      // ripples once, the way a device acknowledges a pairing. Only when the
      // connected device actually changes, not on every battery tick.
      if (tracked && view.lastBluetooth !== tracked.address) {
        view.lastBluetooth = tracked.address;
        node.classList.add('bt-connect');
      }
      if (!tracked) node.classList.add('dim');
      return node;
    },
  },

  meeting: {
    label: 'Meeting',
    render (state) {
      const active = state.input.active;
      const node = document.createElement('button');
      node.className = `widget${active.length ? ' alert' : ' dim'}`;
      node.dataset.panelOpen = 'mic';
      if (active.length) {
        node.insertAdjacentHTML('beforeend', '<span class="pulse"></span>');
      } else {
        node.insertAdjacentHTML('beforeend', icon('mic', { size: 14 }));
      }
      node.title = active.length ? active.join(', ') : 'No active meeting';
      return node;
    },
  },

  airdrop: {
    label: 'AirDrop',
    render (state) {
      // AirDrop earns a place in the row while the wireless link is live, and
      // only then: macOS gives no way to watch an actual transfer, so this is
      // the one honest thing to say about it.
      if (!state.airdrop?.live) return null;
      const node = document.createElement('div');
      node.className = 'widget';
      node.insertAdjacentHTML('beforeend', icon('airdrop', { size: 14 }));
      node.title = 'AirDrop is ready';
      return node;
    },
  },

  clipboard: {
    label: 'Clipboard',
    render (state) {
      const [latest] = state.clipboard.items;
      if (!latest) return null;
      const node = document.createElement('button');
      node.className = 'widget readout';
      node.dataset.panelOpen = 'clipboard';
      node.insertAdjacentHTML('beforeend', icon(kindIcon(latest.kind), { size: 14 }));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = latest.text.replace(/\s+/g, ' ').trim().slice(0, 8) || 'Copied';
      node.append(label);
      node.title = latest.text;
      return node;
    },
  },

  update: {
    label: 'Update',
    render (state) {
      const update = state.update;
      // While the island is showing the update itself the bubble beside the
      // housing says it, so this pill would only repeat it. It takes over once
      // the panel has been folded away: the small icon is how the update gets
      // its island back.
      if (!hasSomethingToAnnounce(update)) return null;
      if ((state.activities ?? []).some((activity) => activity.id === 'update')) return null;

      const node = document.createElement('button');
      const ready = update.state === 'ready';
      // `keep` is the marker `requestSize` reads: an update that is ready to
      // install is as much the thing that just happened as the greeting is, so it
      // is never the widget the row gives up.
      node.className = 'widget readout keep';
      node.dataset.panelOpen = 'activity:update';
      node.insertAdjacentHTML('beforeend', icon(ready ? 'restart' : 'download', { size: 14 }));
      if (update.state === 'downloading') {
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = `${Math.round((update.progress ?? 0) * 100)}%`;
        node.append(label);
      }
      node.title = ready ? 'Restart to install' : 'A new version is available';
      return node;
    },
  },

  clock: {
    label: 'Clock',
    render () {
      const node = document.createElement('div');
      node.className = 'widget readout';
      node.dataset.panelOpen = 'clock';
      const now = new Date();
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      node.append(label);
      node.title = 'Clock';
      return node;
    },
  },

  cpu: {
    label: 'CPU',
    render (state) {
      const node = document.createElement('div');
      node.className = 'widget readout';
      node.dataset.panelOpen = 'settings';
      node.insertAdjacentHTML('beforeend', icon('cpu', { size: 14 }));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${Math.round(state.system.cpu)}%`;
      node.append(label);
      node.title = 'CPU load';
      return node;
    },
  },
};

/**
 * What a bubble says about itself. A timer wears its countdown — the number is
 * the whole point of it — and everything else wears its name.
 */
function bubbleLabel (activity) {
  if (activity.kind === 'timer') return (activity.subtitle || activity.title).replace(/ left$/, '');
  // An update wears its progress the way a timer wears its countdown: the
  // percentage is the whole point of it, the version is only in the panel.
  if (activity.kind === 'update') return activity.subtitle ?? activity.title;
  // A device that just connected says so here too, for the same few seconds:
  // whether the greeting lands on the widget pill or on this bubble, it reads
  // "Connected to …" the moment the accessory shows up.
  if (activity.kind === 'bluetooth' && view.bluetoothHello === activity.title) {
    return `Connected to ${activity.title}`;
  }
  return activity.title;
}

/**
 * One live activity as a small bubble next to the housing. It can be swiped
 * sideways to dismiss, which is how the island gets rid of a single event
 * without opening anything.
 */
function bubble (activity) {
  const node = document.createElement('button');
  node.className = 'bubble';
  node.dataset.activity = activity.id;
  node.dataset.kind = activity.kind;

  // A transfer says everything with its logo and bar, so it carries no label.
  if (activity.kind !== 'transfer') {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = bubbleLabel(activity);
    node.append(label);
  }

  node.title = activity.subtitle ?? activity.title;

  node.addEventListener('click', (event) => {
    if (node.dataset.swiped) return;
    event.stopPropagation();
    openPanel(`activity:${activity.id}`);
  });
  bindSwipe(node, activity);
  paintBubble(node, activity);
  return node;
}

/**
 * What a bubble wears in front of its label, and the one thing in it that has to
 * be able to change after the node was built.
 *
 * A bubble node is built once and kept, because the transfer dots and the charge
 * bar are animations that must not restart on every state push. That reuse is
 * also why this exists: a player reports the song before its cover, so the first
 * render of a bubble has nothing to put a sleeve in, and without a way to swap
 * the whole thing out the cover simply never turned up — until the app was
 * restarted. The same is true in the other direction: a cover that disappears has
 * to take the sleeve away instead of leaving it behind under the next title.
 */
function bubbleVisual (activity) {
  if (activity.artwork) return 'thumb';
  // Charging and transferring get a little bar instead of a ring, because what
  // matters there is the level walking from amber to green and the two dots
  // closing on each other.
  if (activity.kind === 'transfer') return 'transfer';
  const hasProgress = activity.progress !== null && activity.progress !== undefined;
  if (hasProgress && activity.kind === 'battery') return 'charge';
  if (hasProgress) return 'ring';
  if (activity.kind === 'mic') return 'live';
  return 'glyph';
}

function paintBubble (node, activity) {
  const visual = bubbleVisual(activity);
  if (node.dataset.visual !== visual) {
    node.dataset.visual = visual;
    // Only the visual is replaced, and all of it: a transfer is two elements, so
    // dropping the first match would leave the other behind under the next title.
    // The label and the listeners stay, and so do the animations inside whichever
    // visual is already there.
    for (const child of node.querySelectorAll('.thumb, .ring, .mini-bar, .live, .icon')) child.remove();
    node.style.removeProperty('--charge');
    if (visual === 'thumb') {
      const image = document.createElement('img');
      image.className = 'thumb';
      image.alt = '';
      image.src = activity.artwork;
      node.prepend(image);
    } else if (visual === 'transfer') {
      // A transfer bubble is just the AirDrop logo and its bar — the same two
      // things the panel shows, small enough to sit beside the housing. The bar
      // is AirDrop blue, not the amber-to-green of a charge.
      node.style.setProperty('--charge', '#2f8bff');
      node.insertAdjacentHTML('afterbegin', icon('airdrop', { size: 18 }));
      node.insertAdjacentHTML('afterbegin',
        '<span class="mini-bar"><i class="fill"></i><i class="dot from"></i><i class="dot to"></i></span>');
    } else if (visual === 'charge') {
      node.insertAdjacentHTML('afterbegin', '<span class="mini-bar"><i class="fill"></i></span>');
      tintCharge(node, activity.progress);
    } else if (visual === 'ring') {
      const ring = document.createElement('div');
      ring.className = 'ring';
      ring.append(document.createElement('i'));
      node.prepend(ring);
    } else if (visual === 'live') {
      node.insertAdjacentHTML('afterbegin', '<span class="live"></span>');
    } else {
      node.insertAdjacentHTML('afterbegin', icon(activity.icon, { size: 15 }));
    }
  }

  // Everything below moves inside a visual that is already there, so the transfer
  // dots and the charge bar keep their animation across renders.
  const thumb = node.querySelector('.thumb');
  if (thumb && thumb.getAttribute('src') !== activity.artwork) thumb.src = activity.artwork;
  const mini = node.querySelector('.mini-bar');
  if (mini) {
    mini.style.setProperty('--progress', String(clamp(activity.progress ?? 0, 0, 1)));
    // Only a charge bar walks amber to green; a transfer bar stays AirDrop blue.
    if (activity.kind === 'battery') tintCharge(node, activity.progress);
  }
  const ring = node.querySelector('.ring');
  if (ring) ring.style.setProperty('--progress', activity.progress);
  // A finished transfer stops chasing and lights up blue, the same moment the
  // check flashes in the panel.
  if (activity.kind === 'transfer') node.classList.toggle('sent', Boolean(activity.done));
}

/**
 * Bubbles are reused between renders so the transfer dots and the charge bar
 * keep animating instead of restarting on every state push.
 */
function renderBubbles (state) {
  const seen = new Set();
  const nodes = [];
  for (const activity of state.activities ?? []) {
    seen.add(activity.id);
    let node = view.bubbleNodes.get(activity.id);
    if (!node) {
      node = bubble(activity);
      view.bubbleNodes.set(activity.id, node);
    }
    updateBubble(node, activity);
    nodes.push(node);
  }
  for (const id of [...view.bubbleNodes.keys()]) {
    if (!seen.has(id)) view.bubbleNodes.delete(id);
  }
  return nodes;
}

function updateBubble (node, activity) {
  const label = node.querySelector('.label');
  const want = bubbleLabel(activity);
  if (label && label.textContent !== want) label.textContent = want;
  if (node.dataset.kind !== activity.kind) node.dataset.kind = activity.kind;
  node.title = activity.subtitle ?? activity.title;
  paintBubble(node, activity);
}

/** Horizontal drag to dismiss. */
function bindSwipe (node, activity) {
  let start = null;
  node.addEventListener('pointerdown', (event) => {
    start = { x: event.clientX, moved: 0 };
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener('pointermove', (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < 6 && node.dataset.swiped !== '1') return;
    start.moved = dx;
    node.classList.add('dragging');
    node.style.transform = `translateX(${dx}px)`;
  });
  const release = () => {
    if (!start) return;
    const { moved } = start;
    start = null;
    node.classList.remove('dragging');
    if (Math.abs(moved) > 46) {
      node.dataset.swiped = '1';
      node.classList.add('dismissed');
      suppressClick = true;
      api.action('activity.dismiss', { id: activity.id });
      return;
    }
    node.style.transform = '';
  };
  node.addEventListener('pointerup', release);
  node.addEventListener('pointercancel', release);
}

/** Bounces the widgets whose headline value changed since the last render. */
function popChangedWidgets (nodes, state) {
  const arms = surfaceArms(state, 'compact');
  const ids = [...arms.right, ...arms.left];
  // Keyed by widget rather than by position: a row that was rearranged has the same
  // widgets in different places, and comparing them slot by slot called every one of
  // them changed. Moving something is not the same as something moving.
  const values = new Map(ids.map((id) => [id, widgetValue(state, id)]));

  const previous = view.widgetValues;
  view.widgetValues = values;
  if (!previous) return;

  const changed = ids.filter((id) => previous.get(id) !== values.get(id));
  if (!changed.length) return;
  for (const node of nodes) {
    if (!changed.includes(node.dataset.widget)) continue;
    node.classList.remove('pop');
    void node.offsetWidth; // restart the animation
    node.classList.add('pop');
  }
  // Volume and the microphone move several times a second while a key is held, and
  // every step of them used to shove the whole island. They stay local: only a change
  // in what the row actually says may push the pill.
  if (changed.some((id) => id !== 'volume' && id !== 'mic')) nudge();
}

/** What a widget says, for the comparison that decides whether it bounces. */
function widgetValue (state, id) {
  if (id === 'media') return state.media.title;
  if (id === 'clipboard') return state.clipboard.items[0]?.text ?? '';
  if (id === 'volume') return `${Math.round(state.volume.value * 100)}${state.volume.muted}`;
  if (id === 'mic') return `${state.input.muted}${state.input.active.join()}`;
  if (id === 'battery') return `${Math.round(state.battery.level * 100)}${state.battery.charging ? 'c' : ''}`;
  if (id === 'bluetooth') return state.bluetooth.devices.map((device) => device.battery).join();
  return '';
}

/** The little push the island gives when its content changes underneath it. */
let nudgeTimer = null;
function nudge () {
  root.classList.remove('nudge');
  void root.offsetWidth;
  root.classList.add('nudge');
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => root.classList.remove('nudge'), 460);
}

function kindIcon (kind) {
  return { link: 'link', email: 'text', code: 'text' }[kind] ?? 'clipboard';
}

function progressOf (media) {
  if (!media.duration) return 0;
  return clamp(media.elapsed / media.duration, 0, 1);
}

// ---------------------------------------------------------------- render

function render (snapshot) {
  view.snapshot = snapshot;
  view.maxWidth = snapshot.prefs.island.maxWidth;
  view.style = snapshot.prefs.island.style;
  view.hoverToExpand = snapshot.prefs.island.hoverToExpand;
  view.layout = snapshot.layout ?? null;
  view.surface = snapshot.layout?.arranged?.compact ?? { right: [], left: [] };
  view.notch = snapshot.geometry.notch;
  syncPanelWidth();

  renderWidgets(snapshot);
  renderPlayer(snapshot);
  renderSound(snapshot);
  renderMic(snapshot);
  renderBluetooth(snapshot);
  renderClipboard(snapshot);
  renderSettings(snapshot);
  renderArranging();
  syncPanels();
  requestSize();
}

/**
 * Fills both arms.
 *
 * Which arm a widget sits on, and in what order, is no longer a guess: the layout
 * says so, and the layout editor is where that is decided. What happens in a row
 * when it does not fit is still decided here — `requestSize` sheds from whichever
 * arm is widest, so a crowded island loses the detail it can spare.
 *
 * Live activities sit on the right arm in front of the widgets rather than being
 * counted into the row: an event must never be dropped because of an arrangement,
 * and putting it where the counting used to put it would move every widget in the
 * island one place along whenever something happened.
 *
 * Nodes are reused between renders so the meters and the transfer dots keep
 * animating.
 */
function renderWidgets (state) {
  const arms = surfaceArms(state, 'compact');
  const row = [...arms.right, ...arms.left];
  const signature = row.join(',');
  if (signature !== view.widgetSignature) {
    view.widgetSignature = signature;
    view.widgetNodes.clear();
  }

  // The update pill is not a preference: it is the same status light the update
  // bubble is, for the moment there is no bubble because the island is not open.
  // It rides in front of the right arm and is not part of the arrangement.
  const withStatus = [...arms.right, ...(hasSomethingToAnnounce(state.update) ? ['update'] : [])];

  const built = {};
  for (const id of [...withStatus, ...arms.left]) {
    const widget = WIDGETS[id] ?? modWidgetDef(id);
    if (!widget) continue;
    const fresh = widget.render(state);
    if (!fresh) {
      view.widgetNodes.delete(id);
      continue;
    }
    const previous = view.widgetNodes.get(id);
    if (previous) previous.replaceWith(fresh);
    fresh.dataset.widget = id;
    view.widgetNodes.set(id, fresh);
    built[id] = fresh;
  }
  for (const id of [...view.widgetNodes.keys()]) {
    if (!built[id]) view.widgetNodes.delete(id);
  }

  const bubbles = renderBubbles(state);
  root.classList.toggle('bubbles', bubbles.length > 0);
  view.bubbleCount = bubbles.length;

  el('armRight').replaceChildren(...bubbles, ...withStatus.map((id) => built[id]).filter(Boolean));
  el('armLeft').replaceChildren(...arms.left.map((id) => built[id]).filter(Boolean));
  // A bubble must not bounce because the volume changed.
  popChangedWidgets(Object.values(built), state);
  requestSize();
}

/**
 * One surface as the renderer needs it: the widgets it names, split into the arms
 * it has. A surface the main process has not sent yet comes back empty rather than
 * throwing, so the island is never blank while a profile is being loaded.
 */
/**
 * The size a widget is drawn at, which the arrangement decides for the ones that
 * can be more than one size. Anything without a choice comes back null, so a
 * widget cannot accidentally be shrunk.
 */
function widgetSize (id) {
  return view.layout?.sizes?.[id] ?? null;
}

function surfaceArms (state, surface) {
  const arranged = state?.layout?.arranged?.[surface];
  // A mod widget is carried the same way a built-in one is: it is in the arrangement
  // or it is not, and the renderer is the one that knows how to draw it.
  const carries = (id) => Boolean(WIDGETS[id]) || modWidgets.has(id);
  if (Array.isArray(arranged)) return { right: arranged.filter(carries), left: [] };
  return {
    right: (arranged?.right ?? []).filter(carries),
    left: (arranged?.left ?? []).filter(carries),
  };
}

/** The definition a mod widget draws from, for the one place that needs it. */
function modWidgetDef (id) {
  const widget = modWidgets.get(id);
  return widget ? { render: (state) => widget.render(state) } : null;
}

/**
 * Everything a surface can carry: what the app ships, and what the mods added.
 *
 * The palette offers what is not in use, so a mod widget that has not been placed yet
 * has to be in here — otherwise it can be registered and never put in the row.
 */
function surfaceItems (surface) {
  return [...layoutItems(surface), ...(surface === 'compact' ? [...modWidgets.values()] : [])];
}

/** A surface as a plain list, for the panels that are one. */
function surfaceList (state, surface) {
  const arranged = state?.layout?.arranged?.[surface];
  return Array.isArray(arranged) ? [...arranged] : [];
}

function renderPlayer (state) {
  const { media } = state;
  const playing = media.rate > 0;
  root.classList.toggle('playing', playing);

  const artwork = el('artwork');
  const image = el('artworkImage');
  if (media.artwork && image.dataset.src !== media.artwork) {
    image.src = media.artwork;
    image.dataset.src = media.artwork;
    artwork.classList.add('has-image');
  } else if (!media.artwork) {
    image.removeAttribute('src');
    delete image.dataset.src;
    artwork.classList.remove('has-image');
  }
  el('artworkFallback').innerHTML = icon('music', { size: 24 });

  el('playerTitle').textContent = media.title || (media.playbackState > 0 ? 'Playing music' : 'Nothing playing');
el('playerSub').textContent = media.artist
     || (media.playbackState > 0 ? (media.preferredApp || 'Apple Music') : (state.media.controlled ? 'Press play with F8' : 'Install the system bridge for control'));

  el('progressFill').style.width = `${progressOf(media) * 100}%`;
  el('elapsed').textContent = timecode(media.elapsed);
  el('duration').textContent = timecode(media.duration);

  el('buttonPlay').innerHTML = icon(playing ? 'pause' : 'play', { size: 19, filled: true });
  el('buttonPlay').classList.toggle('waiting', Boolean(state.media.pending));
  el('buttonPrevious').innerHTML = icon('previous', { size: 17, filled: true });
  el('buttonNext').innerHTML = icon('next', { size: 17, filled: true });
  for (const button of ['buttonPlay', 'buttonPrevious', 'buttonNext']) {
    el(button).disabled = !state.media.controlled;
  }

  // With no app publishing a session the transport keys have nothing to talk to,
  // so offer the one action that does work: open a player.
  const hint = el('playerHint');
  hint.hidden = Boolean(media.title) || !state.helper.available;
  hint.querySelector('.app-name').textContent = state.media.preferredApp ?? 'Music';

  const output = state.devices.list.find((device) => device.isDefault && !device.input);
  el('outputChip').innerHTML = `${icon('volumeLow', { size: 14 })}<span class="name">${escapeHtml(output?.name ?? 'System output')}</span>${icon('chevron', { size: 12 })}`;
}

function renderSound (state) {
  const { volume } = state;
  el('volumeFill').style.width = `${clamp(volume.muted ? 0 : volume.value, 0, 1) * 100}%`;
  el('volumeValue').textContent = volume.muted ? 'Muted' : `${Math.round(volume.value * 100)}%`;
  el('volumeIconLow').innerHTML = icon(volume.muted ? 'volumeMute' : volume.value > 0.5 ? 'volumeHigh' : 'volumeLow', { size: 17 });
  el('volumeMute').innerHTML = icon(volume.muted ? 'volumeMute' : 'volumeLow', { size: 16 });
  el('volumeMute').classList.toggle('on', volume.muted);
  el('outputList').replaceChildren(...deviceRows(state, false));
}

function renderMic (state) {
  const { input } = state;
  el('micFill').style.width = `${clamp(input.volume, 0, 1) * 100}%`;
  el('micValue').textContent = `${Math.round(input.volume * 100)}%`;
  el('micIcon').innerHTML = icon(input.muted ? 'micOff' : 'mic', { size: 17 });
  el('micMute').innerHTML = icon(input.muted ? 'micOff' : 'mic', { size: 16 });
  el('micMute').classList.toggle('on', input.muted);

  const banner = el('micBanner');
  if (input.active.length) {
    banner.classList.add('show');
    banner.innerHTML = `<span class="pulse"></span><span>In use by ${escapeHtml(input.active[0])}</span>`;
  } else {
    banner.classList.remove('show');
    banner.textContent = '';
  }
  el('inputList').replaceChildren(...deviceRows(state, true));
}

function deviceRows (state, isInput) {
  const list = state.devices.list.filter((device) => device.input === isInput);
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = isInput ? 'No input devices found' : 'No output devices found';
    return [empty];
  }
  return list.map((device) => {
    const row = document.createElement('button');
    row.className = `device${device.isDefault ? ' active' : ''}`;
    row.innerHTML = `${icon(isInput ? 'mic' : 'volumeLow', { size: 14 })}<span class="name">${escapeHtml(device.name)}</span>`;
    if (device.inUse) row.insertAdjacentHTML('beforeend', '<span class="badge">live</span>');
    row.addEventListener('click', () => {
      api.action(isInput ? 'input.set' : 'output.set', { id: device.id });
      toast(`Using ${device.name}`);
    });
    return row;
  });
}

function renderBluetooth (state) {
  const devices = state.bluetooth.devices ?? [];
  el('bluetoothEmpty').hidden = devices.length > 0;
  const list = el('bluetoothList');
  if (!devices.length) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(...devices
    .slice()
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
    .map(bluetoothRow));
}

/**
 * One accessory: name, battery, and the two actions macOS offers — connect or
 * disconnect, plus jumping the audio output to it.
 */
function bluetoothRow (device) {
  const row = document.createElement('div');
  row.className = `device${device.connected ? ' active' : ''}`;
  const percent = device.battery >= 0 ? Math.round(device.battery * 100) : null;
  row.innerHTML =
    `${icon('bluetooth', { size: 14 })}` +
    `<span class="name">${escapeHtml(device.name)}</span>` +
    (percent === null
      ? ''
      : `<span class="device-battery${device.battery <= 0.2 ? ' low' : ''}">${percent}%</span>`);

  const action = document.createElement('button');
  action.className = 'text-button';
  action.textContent = device.connected ? 'Disconnect' : 'Connect';
  action.addEventListener('click', () => {
    api.action(device.connected ? 'bluetooth.disconnect' : 'bluetooth.connect', { address: device.address });
    toast(device.connected ? `Disconnecting ${device.name}` : `Connecting ${device.name}`);
  });
  row.append(action);
  return row;
}

function renderClipboard (state) {
  const list = el('clipboardList');
  const items = state.clipboard.items;
  list.replaceChildren(...(items.length ? items.map(clipRow) : [emptyNode('Copy something to see it here')]));
}

function clipRow (item, index) {
  const row = document.createElement('button');
  row.className = 'clip';
  row.innerHTML =
    `<span class="kind">${icon(kindIcon(item.kind), { size: 14 })}</span>` +
    `<span class="body"><span class="text">${escapeHtml(item.text)}</span>` +
    `<span class="time">${relativeTime(item.time)}</span></span>`;
  row.addEventListener('click', () => {
    api.action('clipboard.paste', { index });
    toast('Copied back to the clipboard');
  });
  return row;
}

function emptyNode (message) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = message;
  return node;
}

function renderSettings (state) {
  const prefs = state.prefs;
  el('styleSelect').value = prefs.island.style;
  el('hoverToggle').checked = prefs.island.hoverToExpand !== false;
  el('mediaKeysToggle').checked = prefs.hotkeys.mediaKeys === true;
  el('loginToggle').checked = prefs.launchAtLogin === true;

  // Which widgets are in the row, and where, is the layout's business now; this
  // panel only decides in which order its own sections read.
  arrangeSettingsSections(state);

  const hotkeys = el('hotkeyList');
  hotkeys.replaceChildren(...Object.entries(state.hotkeys).map(([, info]) => {
    const row = document.createElement('div');
    row.className = `hotkey${info.accelerator ? '' : ' missing'}`;
    row.innerHTML = `<span>${escapeHtml(info.label)}</span><kbd>${info.accelerator ? escapeHtml(info.accelerator) : 'unavailable'}</kbd>`;
    return row;
  }));

  const notchInfo = state.geometry.notch;
  el('facts').innerHTML = [
    ['Notch', notchInfo.detected ? `${Math.round(notchInfo.width)} × ${Math.round(notchInfo.height)} pt` : 'not detected'],
    ['System bridge', state.helper.available ? 'ready' : escapeHtml(state.helper.reason ?? 'unavailable')],
    ['Microphone access', state.system.micAccess],
    ['Displays', state.system.displays],
  ].map(([key, value]) => `<div>${key} <b>${value}</b></div>`).join('');
  el('retryHelper').hidden = state.helper.available;

  renderUpdates(state);
  renderMods(state);
  arrangeSettingsSections(state);
}

/**
 * A switch per mod.
 *
 * The switch is the whole of what the main process knows how to do with a mod: it can
 * take its widgets out of the row and put them back. What a mod does while it is on is
 * up to the mod.
 */
function renderMods (state) {
  const list = el('modList');
  // A section the arrangement leaves out is detached rather than hidden, so the switch
  // is gone with it. Drawing it anyway would put a control on an island that has no
  // panel to open — and would throw on the first push after the section was moved out.
  if (!list) return;
  const switches = state.prefs.mods ?? {};
  if (!modList.length) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'No mods yet. Put a .js file in the mods folder and restart.';
    list.replaceChildren(note);
    return;
  }
  list.replaceChildren(...modList.map((mod) => {
    const row = document.createElement('label');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = mod.name;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'switch';
    box.checked = switches[mod.id] !== false;
    box.addEventListener('change', () => api.action('mods.toggle', { name: mod.id, on: box.checked }));
    row.append(name, box);
    return row;
  }));
}

/** The settings blocks, kept so one left out of the arrangement can come back. */
let settingsBlocks = null;

/**
 * The settings sections in the order the layout says, and only those.
 *
 * The blocks are moved rather than rebuilt, so a checkbox inside one of them does
 * not lose whatever it was doing halfway through a click. They are also collected
 * once and remembered: a section the arrangement leaves out is detached, and
 * looking for it again would find nothing — so taking a section out of Settings
 * would be a way to delete it for good.
 */
function arrangeSettingsSections (state) {
  const scroll = el('settingsScroll');
  const wanted = surfaceList(state, 'settings');
  const signature = wanted.join(',');
  if (scroll.dataset.arrangement === signature) return;
  scroll.dataset.arrangement = signature;
  if (!settingsBlocks) {
    settingsBlocks = new Map();
    for (const block of scroll.querySelectorAll('.settings-block')) {
      settingsBlocks.set(block.dataset.section, block);
    }
  }
  scroll.replaceChildren(...wanted.map((id) => settingsBlocks.get(id)).filter(Boolean));
}

/**
 * The island announces an update; this is where it is asked about. Nothing here
 * opens by itself, so a machine that is already current simply says so and stops.
 */
function renderUpdates (state) {
  const update = state.update ?? {};
  el('updateFacts').innerHTML = [
    ['Version', escapeHtml(update.current ?? '')],
    ['Status', escapeHtml(updateStatus(update))],
  ].map(([key, value]) => `<div>${key} <b>${value}</b></div>`).join('');

  el('autoUpdateToggle').checked = state.prefs.updates.autoCheck !== false;
  el('updateCheck').disabled = update.state === 'checking' || update.state === 'downloading';
  el('updateCheck').textContent = el('updateCheck').disabled
    ? (update.state === 'downloading' ? 'Downloading…' : 'Checking…')
    : (update.state === 'error' ? 'Retry' : 'Check for updates');
  el('updateInstall').hidden = update.state !== 'ready';
}

function updateStatus (update) {
  switch (update.state) {
    case 'unsupported': return update.error ?? 'only in the packaged app';
    case 'checking': return 'checking…';
    case 'available': return `${update.version} is available`;
    case 'downloading': return `downloading ${Math.round((update.progress ?? 0) * 100)}%`;
    case 'ready': return `${update.version} is ready to install`;
    case 'error': return update.error ?? 'the check failed';
    case 'current': return update.checkedAt ? `up to date, checked ${relativeTime(update.checkedAt)}` : 'up to date';
    default: return 'not checked yet';
  }
}

function syncPanels () {
  const [head, tail] = view.state.split(':');
  const active = view.state === 'compact' ? null : head === 'activity' ? 'activity' : head;
  const collapse = el('islandCollapse');
  if (collapse && !collapse.childElementCount) collapse.innerHTML = icon('chevron', { size: 12 });
  for (const panel of root.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.dataset.panel === active);
  }
  // The clock only ticks while it is on screen; the panel that wants it asks
  // again at the bottom, and the activity branch returns before that.
  stopClock();
  if (active === 'activity') {
    renderActivity(view.snapshot, tail);
    return;
   }
   // The halo belongs to the charging activity only: it must not keep breathing
   // once another panel is open, or the island would animate forever.
   root.classList.remove('charge-glow');
   view.lastActivity = null;
   if (active === 'battery') renderBattery(view.snapshot);
   if (active === 'quick') renderQuick(view.snapshot);
   if (active === 'clock') startClock();
  if (active === 'mod') renderModPanel(tail);
}

/**
 * Hands the panel to the mod that owns it.
 *
 * The mod draws; the island opens, titles and closes. A mod that throws while drawing
 * gets a panel that says so rather than taking the island down with it — the same
 * reason a mod that throws on load is left out.
 */
function renderModPanel (id) {
  const panel = modPanels.get(id);
  el('modPanelTitle').textContent = panel?.label ?? id;
  const body = el('modPanelBody');
  body.replaceChildren();
  if (!panel) {
    body.textContent = 'This mod is not loaded.';
    return;
  }
  try {
    panel.render(view.snapshot, body);
  } catch (error) {
    console.error(`[mods] ${id} could not draw its panel:`, error.message);
    body.textContent = 'This mod could not draw its panel.';
  }
}

/**
 * The clock panel: the time, large, with the seconds counting along beside it.
 * The tick is chained onto the wall clock's own second so the digits do not
 * drift a frame behind.
 */
const CLOCK_DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long', month: 'long', day: 'numeric',
});
let clockTimer = null;

function renderClock () {
  const now = new Date();
  const time = el('clockTime');
  const seconds = el('clockSeconds');
  const date = el('clockDate');
  if (!time || !seconds || !date) return;
  time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  seconds.textContent = String(now.getSeconds()).padStart(2, '0');
  date.textContent = CLOCK_DATE.format(now);
}

function startClock () {
  if (clockTimer) return;
  const tick = () => {
    renderClock();
    clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 4);
  };
  tick();
}

function stopClock () {
  clearTimeout(clockTimer);
  clockTimer = null;
}

function renderBattery (state) {
   const { level, charging, minutes } = state.battery;
   const percent = Math.round(level * 100);
   const full = Boolean(state.battery.full);
   const { base, soft } = chargeColor(level);
   const charge = el('batteryPanel');
   if (charge) {
     charge.style.setProperty('--charge', base);
     charge.style.setProperty('--charge-soft', soft);
   }
   const levelEl = el('batteryPanelLevel');
   if (levelEl) levelEl.style.setProperty('--level', String(level));
   const bolt = el('batteryPanelBolt');
   if (bolt) {
     bolt.innerHTML = icon(full ? 'checkFill' : 'batteryBolt', { size: 25, filled: true });
   }
  const stateEl = el('batteryPanelState');
  // Never repeat the percentage beside itself: without a time estimate the old
  // fallback was the same number the line under it already showed.
  if (stateEl) {
    stateEl.textContent = full
      ? 'Fully charged'
      : charging
        ? 'Charging'
        : (minutes > 0 ? `${minutes} min left` : 'On battery');
  }
   const pctEl = el('batteryPanelPercent');
   if (pctEl) pctEl.textContent = `${percent}%`;
 }

 /** Pulls the device out of a title like "Sending to iPad". */
 function transferName (title) {
  const match = /sending to (.+)$/i.exec(title ?? '');
  return match ? match[1] : title ?? 'device';
}

/** The activity the island opened on its own, in full. */
function renderActivity (state, id) {
  const activity = (state?.activities ?? []).find((entry) => entry.id === id);
  const progress = el('activityProgress');
  const charge = el('chargeBar');
  const transfer = el('transferBar');

  if (!activity) {
    el('activityTitle').textContent = 'Nothing new';
    el('activitySub').textContent = '';
    el('activitySub').hidden = true;
    el('activityHead').hidden = false;
    el('activityIcon').hidden = true;
    progress.hidden = true;
    charge.hidden = true;
    transfer.hidden = true;
    el('activityActions').replaceChildren();
    return;
  }

  // Charging and transferring get their own bars instead of the plain progress
  // line, so the one-shot animations can start from a clean slate every time the
  // island presents them.
  if (view.lastActivity !== id) {
    view.lastActivity = id;
    charge.classList.remove('full');
    transfer.classList.remove('done');
    void charge.offsetWidth;
  }

  const isCharge = activity.kind === 'battery';
  const isTransfer = activity.kind === 'transfer';
  const level = clamp(activity.progress ?? 0, 0, 1);

  // Charging and transferring both bring their own headline — a battery with
  // its numbers, a logo with its caption — so the head would only repeat them.
  el('activityHead').hidden = isTransfer || isCharge;
  const iconBox = el('activityIcon');
  iconBox.hidden = false;
  iconBox.dataset.kind = activity.kind;
  iconBox.classList.toggle('wave', !activity.artwork && activity.kind === 'mic');
  if (activity.artwork) {
    // Cover art, not a glyph: the island says "this song" with its sleeve.
    if (iconBox.dataset.art !== activity.artwork) {
      iconBox.dataset.art = activity.artwork;
      delete iconBox.dataset.icon;
      const image = document.createElement('img');
      image.src = activity.artwork;
      image.alt = '';
      iconBox.replaceChildren(image);
    }
  } else {
    delete iconBox.dataset.art;
    if (iconBox.dataset.icon !== activity.icon || iconBox.querySelector('img')) {
      iconBox.dataset.icon = activity.icon;
      iconBox.innerHTML = icon(activity.icon, { size: 22 });
    }
  }
  el('activityTitle').textContent = activity.title;
  el('activitySub').textContent = activity.subtitle ?? '';
  el('activitySub').hidden = !activity.subtitle;
  el('activityDismiss').innerHTML = icon('close', { size: 15 });
  el('activityDismiss').dataset.id = activity.id;

  const hasProgress = activity.progress !== null && activity.progress !== undefined;
  progress.hidden = !hasProgress || isCharge || isTransfer;
  if (!progress.hidden) {
    el('activityFill').style.width = `${activity.progress * 100}%`;
    el('activityFill').style.background = PROGRESS_TINT[activity.kind] ?? '#fff';
  }

  // --- charging: a battery that fills, walks amber to green, and settles full
  charge.hidden = !isCharge;
  root.classList.toggle('charge-glow', isCharge);
  if (isCharge) {
    const { base, soft } = chargeColor(level);
    root.style.setProperty('--glow', soft);
    charge.style.setProperty('--charge', base);
    charge.style.setProperty('--charge-soft', soft);
    el('chargeLevel').style.setProperty('--level', String(level));
    el('chargePercent').textContent = `${Math.round(level * 100)}%`;
    const full = Boolean(activity.full);
    el('chargeState').textContent = full ? 'Fully charged' : 'Charging';
    // The bolt sits on the fill, so it turns dark once there is fill to sit on
    // and stays white while the battery is still mostly empty.
    const bolt = el('chargeBolt');
    if (!bolt.dataset.mode || bolt.dataset.mode !== (full ? 'full' : 'charge')) {
      bolt.dataset.mode = full ? 'full' : 'charge';
      bolt.innerHTML = icon(full ? 'checkFill' : 'batteryBolt', { size: 25, filled: true });
    }
    bolt.style.color = full ? '#fff' : level > 0.3 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.95)';
    charge.classList.toggle('full', full);
  }

  // --- transfer: the logo, and the bar the animation plays on
  transfer.hidden = !isTransfer;
  if (isTransfer) {
    transfer.style.setProperty('--progress', String(level));
    const wasDone = transfer.classList.contains('done');
    transfer.classList.toggle('done', Boolean(activity.done));
    if (activity.done && !wasDone) {
      // The check and the fill replay once per toggle, so put the class back on
      // after a reflow.
      transfer.classList.remove('done');
      void transfer.offsetWidth;
      transfer.classList.add('done');
    }
    const iconBox = el('transferIcon');
    if (!iconBox.childElementCount) iconBox.innerHTML = icon('airdrop', { size: 36 });
    const caption = el('transferCaption');
    const sub = el('transferSub');
    const wantCaption = activity.done ? `Sent to ${transferName(activity.title)}` : activity.title;
    const wantSub = activity.done ? 'Delivered' : (activity.subtitle ?? '');
    if (caption.textContent !== wantCaption) caption.textContent = wantCaption;
    if (sub.textContent !== wantSub) sub.textContent = wantSub;
    const check = el('transferCheck');
    if (activity.done && !check.childElementCount) check.innerHTML = icon('checkFill', { size: 14, filled: true });
    if (!activity.done) check.replaceChildren();
  }

  const actions = [];
  if (activity.kind.startsWith('timer-') || activity.id.startsWith('timer-')) {
    actions.push(quickButton('Pause', 'pause', () => api.action('timer.pause', { id: activity.id })));
    actions.push(quickButton('Cancel', 'close', () => api.action('timer.cancel', { id: activity.id })));
  } else if (activity.kind === 'bluetooth') {
    actions.push(quickButton('Disconnect', 'bluetooth', () => {
      const device = (view.snapshot.bluetooth.devices ?? []).find((entry) => activity.id === `bt-${entry.address}`);
      if (device) api.action('bluetooth.disconnect', { address: device.address });
    }));
  } else if (activity.kind === 'mic') {
    actions.push(quickButton('Open microphone', 'mic', () => openPanel('mic')));
  } else if (activity.kind === 'media') {
    actions.push(quickButton('Open player', 'music', () => openPanel('player')));
  } else if (activity.kind === 'update') {
    // The one activity whose two states ask for different things: there is
    // nothing to press while the download is still running, and everything to
    // press once it is on disk.
    const update = view.snapshot?.update ?? {};
    if (update.state === 'available') {
      actions.push(quickButton('Download', 'download', () => api.action('update.download', {})));
    }
    if (update.state === 'ready') {
      actions.push(quickButton('Restart now', 'restart', () => api.action('update.install', {})));
    }
    actions.push(quickButton('Later', 'close', () => api.action('activity.dismiss', { id: activity.id })));
  } else if (isCharge) {
    // The battery carries no other control, so the panel offers the one thing
    // left: putting the island back to sleep.
    actions.push(quickButton('Dismiss', 'close', () => api.action('activity.dismiss', { id: activity.id })));
  }
  el('activityActions').replaceChildren(...actions);
}

function quickButton (label, iconName, onClick) {
  const button = document.createElement('button');
  button.className = 'quick-timer';
  button.innerHTML = `${icon(iconName, { size: 14 })} ${label}`;
  button.addEventListener('click', onClick);
  return button;
}

/** Long press opens this: the controls you reach for most. */
/**
 * What each quick control says. The order they appear in is the layout's, and the
 * ones it does not name are not drawn at all — so a control can be taken off the
 * long press without losing it.
 */
/** The panel each quick control opens; the timer starts five minutes instead. */
const QUICK_PANELS = {
  volume: 'volume',
  mic: 'mic',
  bluetooth: 'bluetooth',
  player: 'player',
  clipboard: 'clipboard',
  settings: 'settings',
};

const QUICK_CAPTIONS = {
  volume (state) {
    const output = (state.devices.list ?? []).find((device) => device.isDefault && !device.input);
    return { glyph: icon('volumeLow', { size: 17 }), caption: output?.name ?? 'Sound' };
  },
  mic (state) {
    return { glyph: icon(state.input.muted ? 'micOff' : 'mic', { size: 17 }), caption: state.input.muted ? 'Mic off' : 'Mic on' };
  },
  bluetooth (state) {
    const accessory = (state.bluetooth?.devices ?? []).find((device) => device.connected && device.battery >= 0);
    return { glyph: icon('bluetooth', { size: 17 }), caption: accessory?.name ?? 'Bluetooth' };
  },
  player (state) {
    return { glyph: icon('music', { size: 17 }), caption: state.media.title ?? 'Player' };
  },
  clipboard () {
    return { glyph: icon('clipboard', { size: 17 }), caption: 'Clipboard' };
  },
  settings () {
    return { glyph: icon('gear', { size: 17 }), caption: 'Settings' };
  },
};

/** The timer control counts down whatever is running, and offers to start one. */
function timerCaption (running) {
  const countdown = running[0]?.subtitle;
  return `${icon('timer', { size: 17 })}<span class="caption">${escapeHtml(countdown ?? 'Timer')}</span>`;
}

function renderQuick (state) {
  // The grid is filled in the order the layout names, and a control it does not
  // name disappears: this is the surface for what a long press reaches for.
  const wanted = surfaceList(state, 'quick');
  const rows = el('quickRows');
  if (rows.dataset.arrangement !== wanted.join(',')) {
    rows.dataset.arrangement = wanted.join(',');
    rows.replaceChildren();
    // The grid is rows of three; the last one may be short, which is what makes an
    // arrangement of seven look the way it does today.
    for (let at = 0; at < wanted.length; at += 3) {
      const row = document.createElement('div');
      row.className = 'quick';
      for (const id of wanted.slice(at, at + 3)) {
        const button = document.createElement('button');
        button.className = 'quick-item';
        button.dataset.quick = id;
        const panel = QUICK_PANELS[id];
        if (panel) {
          button.dataset.panelOpen = panel;
        } else {
          // No panel to open, so the control does the one thing it is for.
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            api.action('timer.start', { minutes: 5 });
          });
        }
        row.append(button);
      }
      rows.append(row);
    }
  }
  for (const id of wanted) {
    const say = QUICK_CAPTIONS[id]?.(state);
    if (!say) continue;
    for (const button of rows.querySelectorAll(`[data-quick="${id}"]`)) {
      button.innerHTML = `${say.glyph}<span class="caption">${escapeHtml(say.caption)}</span>`;
    }
  }

  const timers = el('quickTimers');
  if (!timers.dataset.ready) {
    timers.dataset.ready = '1';
    for (const minutes of [5, 10, 25]) {
      const button = document.createElement('button');
      button.className = 'quick-timer';
      button.textContent = `${minutes} min`;
      button.addEventListener('click', () => api.action('timer.start', { minutes }));
      timers.append(button);
    }
  }

  const running = (state.activities ?? []).filter((activity) => activity.id.startsWith('timer-'));
  for (const button of rows.querySelectorAll('[data-quick="timer"]')) {
    button.innerHTML = timerCaption(running);
  }
  el('quickActive').replaceChildren(...running.map((activity) => {
    const row = document.createElement('div');
    row.className = 'quick-active-row';
    row.innerHTML = `${icon('timer', { size: 14 })}<span>${escapeHtml(activity.subtitle)}</span><span class="spacer"></span>`;
    const cancel = document.createElement('button');
    cancel.className = 'text-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => api.action('timer.cancel', { id: activity.id }));
    row.append(cancel);
    return row;
  }));
}

/**
 * While the island changes shape the compact widgets dissolve into the panel
 * instead of simply disappearing, which is what makes the transition read as
 * one object rather than two.
 */
let morphTimer = null;
function markMorph () {
  if (root.classList.contains('morphing')) return;
  root.classList.add('morphing');
  clearTimeout(morphTimer);
  morphTimer = setTimeout(() => root.classList.remove('morphing'), 480);
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

// ---------------------------------------------------------------- geometry

/** Writes a custom property only when it actually moves; every write is a
 *  style invalidation, and a tween sets most of them every frame. */
function setVar (name, value) {
  if (root.style.getPropertyValue(name) === value) return;
  root.style.setProperty(name, value);
}

function applyFrame (frame) {
  const stateChanged = frame.state !== view.appliedState;
  view.frame = frame;
  view.state = frame.state;
  view.notch = frame.notch;
  view.band = bandHeight();
  syncPanelWidth();
  setVar('--island-w', `${frame.width}px`);
  setVar('--island-h', `${frame.islandHeight}px`);
  setVar('--band', `${view.band}px`);
  setVar('--notch-w', `${gapWidth()}px`);
  if (frame.radius !== undefined) setVar('--radius', formatRadius(frame.radius));
  // Everything below answers the question "what is the island showing", which
  // only changes when the state does. Doing it per frame would relayout the
  // panel in the middle of the very animation it belongs to.
  if (stateChanged) markMorph();
  view.appliedState = frame.state;
  if (root.dataset.state !== frame.state) root.dataset.state = frame.state;
  if (root.dataset.style !== view.style) root.dataset.style = view.style;
  if (stateChanged) syncPanels();
}

/** The black strip that hides the camera housing, in both island states. */
function bandHeight () {
  const configured = view.snapshot?.prefs?.island?.compactHeight ?? 0;
  return Math.max(30, view.notch.height || 0, configured);
}

/** Width the housing itself occupies; the window stays centred on it. */
function gapWidth () {
  if (!view.notch.detected) return 0;
  return Math.min(view.notch.width, view.frame.width);
}

function formatRadius (value) {
  if (Array.isArray(value)) return value.map((part) => `${part}px`).join(' ');
  return `${value}px`;
}

/**
 * Natural width of an arm's content. Widgets never shrink, so this measurement
 * does not depend on how wide the island happens to be right now.
 */
function armContentWidth (arm, keep = null) {
  let total = 0;
  for (const child of arm.children) {
    if (keep && !keep(child)) continue;
    total += child.offsetWidth + 3;
  }
  return total;
}

/** Bubbles are wider than widgets, so the island measures them the same way. */
function compactWidth (keep = null) {
  const EDGE = 4; // breathing room between the widgets and the island's edge
  const left = armContentWidth(el('armLeft'), keep);
  const right = armContentWidth(el('armRight'), keep);
  // The island is centred on the housing, so each arm only ever gets half of
  // (width - notch). Both arms must fit their half, which means the island has
  // to be as wide as the *larger* arm — not the sum of the two, which is what
  // used to let a wide bubble spill out past the island's edge.
  return EDGE * 2 + gapWidth() + 2 * Math.max(left, right);
}

/** Natural height of the open panel, measured from its last child. */
function panelHeight () {
  const panel = root.querySelector('.panel.active');
  if (!panel) return 0;
  // The last *visible* child: empty sections are display:none and would report
  // a zero rectangle, which would collapse the island.
  const visible = [...panel.children].filter((child) => child.getClientRects().length > 0);
  const last = visible[visible.length - 1];
  if (!last) return 0;
  const content = last.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
  return Math.ceil(content) + 12 + view.band;
}

let lastSizeRequest = '';

/**
 * The width an open island settles at, clamped exactly the way the main process
 * clamps it. The panel lays itself out at that width from the first frame of the
 * opening animation, so the copy never reflows while the island is still narrow.
 */
function expandedWidth () {
  const { width, detected } = view.notch ?? { width: 0, detected: false };
  const maximum = Math.max(view.maxWidth, width + 24);
  const minimum = detected ? width : 200;
  // The editor is the one panel with a palette and two arms to show at once, so it
  // asks for the room it needs — as far as the island is willing to grow.
  const wanted = view.state === 'layout' ? LAYOUT_WIDTH : PANEL_WIDTH;
  return Math.round(Math.min(Math.max(Math.min(view.maxWidth, wanted), minimum), maximum));
}

function syncPanelWidth () {
  const wanted = `${expandedWidth()}px`;
  if (root.style.getPropertyValue('--panel-w') === wanted) return; // nothing to relayout
  root.style.setProperty('--panel-w', wanted);
}

function requestSize () {
  const ask = (size) => {
    const key = JSON.stringify(size);
    if (key === lastSizeRequest) return; // the window is already there
    lastSizeRequest = key;
    api.requestSize(size);
  };

  if (view.state !== 'compact') {
    // The panel only needs as much height as its content. `scrollHeight` cannot
    // be used here: it reports the box height, which is whatever the island
    // happens to be right now, so the panel would never shrink again.
    root.classList.remove('bubbles-tight');
    ask({ width: expandedWidth(), height: panelHeight() });
    return;
  }

  const left = el('armLeft');
  const right = el('armRight');

  // A bubble is never dropped — an event that vanishes because the row is a
  // little too full loses the whole point. What it sheds instead are the words:
  // that is the difference between a tight row and one that spills past the
  // island's edge and gets clipped.
  //
  // Once the row has been too full it stays wordless until there is room again.
  // Measuring with the labels hidden would say it fits and bring them straight
  // back, which is the overflow this is here to prevent. Only the bubbles are
  // measured: widgets now share the row, so the total width says nothing about
  // whether a bubble's own words fit.
  const onlyBubbles = (node) => node.classList.contains('bubble');
  if (root.classList.contains('bubbles') && compactWidth(onlyBubbles) > view.maxWidth) {
    view.tightBubbles = view.bubbleCount;
  } else if (!root.classList.contains('bubbles')) {
    view.tightBubbles = 0;
  }
  root.classList.toggle('bubbles-tight',
    view.tightBubbles > 0 && view.bubbleCount >= view.tightBubbles);

  // The compact island is width limited: when the widgets do not fit, the widest
  // arm gives up its last widget until they do. The real Dynamic Island drops
  // detail in exactly the same way. Activity bubbles are never dropped — hiding
  // an event because it is a little too wide would lose the whole point.
  while (compactWidth() > view.maxWidth && left.children.length + right.children.length > 2) {
    // The greeting keeps its place: it is the thing that just happened, and the
    // row is full because of it. An update waiting to be installed keeps its
    // place for the same reason. Everything else goes first, from whichever arm
    // has the most to give, so nothing is ever pushed past the island's edge.
    const arms = [left, right].sort((a, b) => armContentWidth(b) - armContentWidth(a));
    const droppable = (node) => !node.classList.contains('bubble')
      && !node.classList.contains('bt-hello')
      && !node.classList.contains('keep');
    const candidate = arms
      .map((arm) => [...arm.children].reverse().find(droppable))
      .find(Boolean) ?? arms
      .map((arm) => [...arm.children].reverse().find((child) => !child.classList.contains('bubble')))
      .find(Boolean);
    if (!candidate) break; // only bubbles left; never drop an active event
    candidate.remove();
  }

  const need = Math.max(compactWidth(), view.notch.width || 0);
  // Kept for the --shot report, which is how the layout gets reviewed.
  view.widths = {
    left: armContentWidth(left),
    right: armContentWidth(right),
    kids: `${left.children.length}/${right.children.length}`,
    need: Math.round(need),
    island: view.frame.width,
    max: view.maxWidth,
  };
  ask({ width: need });
}

// ---------------------------------------------------------------- panels

function openPanel (name) {
  if (name === 'close' || name === view.state) {
    forgetPanel();
    api.action('panel.open', { state: 'compact' });
    return;
  }
  view.pinned = true;
  view.lastPanel = name;
  api.action('panel.open', { state: name });
}

/**
 * Forgets the panel that was open.
 *
 * Folding the island on its own — by hovering away, by a drag, by the hotkey —
 * leaves it remembered, which is what makes hovering go back to what you were
 * looking at. *Closing* a panel is not that: it is an answer to a question, and
 * hovering straight afterwards must not put the same panel back on its own, every
 * time, over whatever you are doing now.
 */
function forgetPanel () {
  view.pinned = false;
  view.lastPanel = 'player';
}

// --- drag: pulling the island down collapses it, pulling up opens it
let drag = null;
let pressTimer = null;
root.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  // The editor handles its own pointers: a press in there is picking an item up,
  // and a held one would otherwise open the quick controls over the panel.
  if (event.target.closest('[data-panel="layout"]')) return;
  // Sliders, progress bars, bubbles and inputs keep their own behaviour: they
  // capture the pointer and a held press would fight it. A widget is different —
  // the arms are made of widgets, so excluding them too would leave the compact
  // island with nowhere to be long-pressed at all.
  if (!event.target.closest('.widget')
    && event.target.closest('button, .slider, .progress, input, select')) return;

  // A long press reveals the extra controls without opening a panel first.
  pressTimer = setTimeout(() => {
    pressTimer = null;
    drag = { moved: true, long: true };
    suppressClick = true;
    root.classList.add('pressed');
    openPanel('quick');
  }, 420);

  drag = { startY: event.clientY, moved: false };
});
root.addEventListener('pointermove', (event) => {
  if (pressTimer && drag && Math.abs(event.clientY - drag.startY) > 5) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
});
root.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const deltaY = event.clientY - drag.startY;
  if (!drag.moved && Math.abs(deltaY) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    root.classList.add('dragging');
    api.drag('start');
  }
  api.drag('move', deltaY);
});
function endDrag () {
  clearTimeout(pressTimer);
  pressTimer = null;
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  root.classList.remove('dragging');
  root.classList.remove('pressed');
  if (!moved) return;
  api.drag('end');
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);

let suppressClick = false;
el('playerHint')?.addEventListener('click', () => api.action('player.open', {}));
el('islandCollapse')?.addEventListener('click', () => api.action('close', {}));

document.addEventListener('click', (event) => {
  if (event.detail === 0) return; // keyboard activation, let the buttons handle it
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (root.classList.contains('dragging')) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action) {
    event.stopPropagation();
    // The chevron and every panel's close button land here rather than in
    // `openPanel`, so this is the other half of forgetting a closed panel.
    if (action === 'close') forgetPanel();
    api.action(action, {});
    return;
  }
  const panel = event.target.closest('[data-panel-open]')?.dataset.panelOpen;
  if (panel) {
    event.stopPropagation();
    openPanel(panel);
    return;
  }
// Clicking the body of the island toggles it, like tapping the Dynamic Island.
// Only while it is folded, though: an open panel is already something to look at,
// so a click inside one belongs to whatever is under it — a switch, a list row, or
// a gap in the arrangement.
    if (view.state === 'compact'
        && event.target.closest('#island')
        && !event.target.closest('.widget')) {
        view.pinned = false;
        api.action('island.toggle', {});
    }
});

document.addEventListener('change', (event) => {
  const { id, value, checked } = event.target;
  if (id === 'styleSelect') api.action('prefs.set', { patch: { island: { style: value } } });
  if (id === 'hoverToggle') api.action('prefs.set', { patch: { island: { hoverToExpand: checked } } });
  if (id === 'mediaKeysToggle') api.action('prefs.set', { patch: { hotkeys: { mediaKeys: checked } } });
  if (id === 'loginToggle') api.action('prefs.set', { patch: { launchAtLogin: checked } });
  if (id === 'autoUpdateToggle') api.action('prefs.set', { patch: { updates: { autoCheck: checked } } });
});

el('retryHelper').addEventListener('click', () => api.action('helper.retry', {}));
bindArrangeDrag();
el('updateCheck').addEventListener('click', () => api.action('update.check', {}));
el('updateInstall').addEventListener('click', () => api.action('update.install', {}));

// ---------------------------------------------------------------- arranging

/**
 * The layout editor.
 *
 * Everything the island shows is now decided by an arrangement the user can see
 * and change, and this is where they change it: the surface being arranged is
 * drawn as it will look, and items are dragged into the gap they belong in.
 *
 * Dragging is done with pointers rather than HTML5 drag and drop, because the
 * island resizes itself while a drag is in flight and the native drag image has
 * no idea anything moved underneath. The arrangement is never edited here: every
 * drop is a message to the main process, which owns the layout and answers with
 * the new one, which is then drawn like everything else.
 */

/** How far a pointer has to travel before a press turns into a drag. */
const DRAG_SLOP = 4;

/** What is being arranged, and what is currently being dragged. */
const arranging = {
  surface: 'compact',
  drag: null,
  signature: '',
};

function surfaceOf (id) {
  return view.layout?.surfaces?.[id] ?? null;
}

function layoutItems (id = arranging.surface) {
  return surfaceOf(id)?.items ?? [];
}

/** The surface being arranged as the editor needs it: a list, or two arms. */
function layoutOrder (id = arranging.surface) {
  const arrangedSurface = view.layout?.arranged?.[id] ?? { right: [], left: [] };
  return Array.isArray(arrangedSurface) ? arrangedSurface : [...(arrangedSurface.right ?? []), ...(arrangedSurface.left ?? [])];
}

function layoutArmOf (widgetId, id = arranging.surface) {
  const surface = view.layout?.arranged?.[id];
  if (Array.isArray(surface) || !surface) return '';
  return (surface.left ?? []).includes(widgetId) ? 'left' : 'right';
}

/**
 * The whole editor, from the same snapshot as everything else.
 *
 * It is redrawn only when the arrangement or the surface being looked at has
 * actually changed: a state push arrives several times a second while something
 * is going on, and rebuilding a panel nobody is looking at is work for nothing.
 */
function renderArranging () {
  if (!surfaceOf(arranging.surface)) arranging.surface = Object.keys(view.layout?.surfaces ?? {})[0] ?? 'compact';
  // The signature is what keeps a panel nobody is looking at from being rebuilt
  // several times a second while something is going on.
  const signature = [
    arranging.surface,
    view.layout?.profile,
    (view.layout?.profiles ?? []).join(','),
    JSON.stringify(view.layout?.arranged ?? {}),
    // Sizes are part of what the editor is drawing: without them a resize would
    // leave the badge showing the size it was before.
    JSON.stringify(view.layout?.sizes ?? {}),
  ].join('|');
  if (arranging.signature === signature) return;
  arranging.signature = signature;
  renderProfiles();
  renderSurfaceTabs();
  renderCount();
  renderSurfaceStage();
  renderPalette();
}

/**
 * How much room each side has, in the title bar.
 *
 * It is the one number that decides whether a drop will be taken, so it belongs
 * where it can be read without hunting for it — and it turns amber as a side fills
 * up rather than only when it is full, which is the warning that arrives before the
 * refusal.
 */
function renderCount () {
  const full = view.layout?.fullness;
  const limit = view.layout?.limit;
  const node = el('layoutCount');
  if (!full || !limit) {
    // A surface that is one list has no sides to count, so it counts as a whole.
    const carried = view.layout?.arranged?.[arranging.surface]?.length ?? 0;
    const total = (view.layout?.surfaces?.[arranging.surface]?.items ?? []).length;
    node.textContent = `${carried} of ${total}`;
    node.dataset.tight = '';
    return;
  }
  // Counted from what is actually drawn, not from the arrangement: a widget with
  // nothing to say — an empty clipboard, AirDrop that is not live — is in the
  // arrangement and not on the island, and a counter that counts it is a counter
  // that lies about the row it is describing.
  const shown = shownBySide();
  const left = shown.left ?? full.left.used;
  const right = shown.right ?? full.right.used;
  const quiet = (full.left.used - left) + (full.right.used - right);
  node.textContent = quiet
    ? `Left ${left}/${full.left.max} · Right ${right}/${full.right.max} · ${quiet} quiet`
    : `Left ${left}/${full.left.max} · Right ${right}/${full.right.max}`;
  const worst = Math.max(full.left.used, full.right.used);
  node.dataset.tight = worst >= full.right.max ? 'full' : worst >= full.right.max - 1 ? 'near' : '';
}

/**
 * How many widgets each side is actually drawing.
 *
 * The arrangement is what the user decided; the island is what there is to say. The
 * two differ whenever a widget is in the arrangement and has nothing to show, and
 * the difference is the whole reason this is counted here rather than in the layout.
 */
function shownBySide () {
  const arms = surfaceArms(view.snapshot ?? {}, 'compact');
  // `renderWidgets` has already drawn the row by the time this runs, and it keeps
  // the widgets it drew in `view.widgetNodes` — a widget that returned nothing is
  // simply not in there. Asking the cache rather than rendering again keeps this from
  // running a widget twice, which matters for the one that greets a device.
  const count = (ids) => ids.filter((id) => view.widgetNodes.has(id)).length;
  return { left: count(arms.left), right: count(arms.right) };
}

/**
 * A profile is a whole set of surfaces, so switching one is the coarse move and
 * the surface tabs under it are the fine ones.
 */
function renderProfiles () {
  const names = view.layout?.profiles ?? [];
  const active = view.layout?.profile;
  const row = el('layoutProfiles');
  row.replaceChildren(...names.map((name) => {
    const button = document.createElement('button');
    button.className = `chip${name === active ? ' on' : ''}`;
    button.textContent = name;
    button.title = name === active ? 'The arrangement in use' : `Switch to ${name}`;
    button.addEventListener('click', () => api.action('layout.profile', { name }));
    return button;
  }));

  const add = document.createElement('button');
  add.className = 'chip';
  add.textContent = 'New';
  add.title = 'Copy this arrangement into a new profile';
  add.addEventListener('click', () => api.action('layout.newProfile', { name: `Profile ${names.length + 1}` }));
  row.append(add);

  if (names.length > 1) {
    const drop = document.createElement('button');
    drop.className = 'chip';
    drop.textContent = 'Delete';
    drop.title = `Delete ${active}`;
    drop.addEventListener('click', () => api.action('layout.deleteProfile', { name: active }));
    row.append(drop);
  }
}

function renderSurfaceTabs () {
  el('layoutTabs').replaceChildren(...Object.entries(view.layout?.surfaces ?? {}).map(([id, surface]) => {
    const button = document.createElement('button');
    button.className = `chip${id === arranging.surface ? ' on' : ''}`;
    button.textContent = surface.label;
    button.addEventListener('click', () => {
      arranging.surface = id;
      renderSurfaceTabs();
      renderSurfaceStage();
      renderPalette();
    });
    return button;
  }));
}

/**
 * The surface as it will look. The island row really is drawn around a housing
 * with an arm on each side, because which arm an item sits on is the whole reason
 * the row is arranged rather than just listed. Everything else is one list, which
 * is all the other surfaces are.
 */
function renderSurfaceStage () {
  const host = el('layoutSurface');
  host.dataset.arms = surfaceOf(arranging.surface)?.sides ? '1' : '0';
  if (surfaceOf(arranging.surface)?.sides) {
    const arrangedSurface = view.layout?.arranged?.[arranging.surface] ?? {};
    host.replaceChildren(
      layoutSide('left', 'Left', arrangedSurface.left ?? []),
      layoutHousing(),
      layoutSide('right', 'Right', arrangedSurface.right ?? []),
    );
    return;
  }
  const list = document.createElement('div');
  list.className = 'layout-list';
  for (const id of layoutOrder()) list.append(layoutSlot(id));
  host.replaceChildren(list);
}

/** The camera housing, drawn to scale so the arms read as arms. */
function layoutHousing () {
  const node = document.createElement('div');
  node.className = 'layout-housing';
  const notch = view.notch?.detected ? Math.round(view.notch.width) : 96;
  node.style.width = `${clamp(notch, 60, 160)}px`;
  return node;
}

/**
 * One side of the housing: a named bubble with the items on it, and a name to say
 * what it is even when it is empty.
 *
 * The bubble is a drop target in its own right, not just the gaps between its
 * items. That is the whole reason it is here: an arm with nothing on it was two
 * thin lines with nothing to aim at, so the way to put something on the other side
 * of the housing was to move something there first. Now you drag it onto the side
 * you want, whether or not anything is on it yet.
 */
function layoutSide (side, label, ids) {
  const node = document.createElement('div');
  node.className = 'layout-side';
  node.dataset.side = side;

  const arm = document.createElement('div');
  arm.className = 'layout-arm';
  // A gap between every pair of items and at both ends, so an item can land
  // anywhere in the side rather than only at its edges. Each one knows its own
  // index, which is what the drop sends.
  arm.append(layoutGap(side, 0));
  ids.forEach((id, at) => {
    // Every slot is drawn, including the ones with nothing to say: an arrangement
    // that says three and a row that shows one is a question nobody can answer
    // unless the empty place is visible as a place.
    const item = layoutItems().find((entry) => entry.id === id);
    // From the same cache the counter reads, so the preview and the island agree on
    // what is there without drawing any widget twice.
    arm.append(view.widgetNodes.has(id)
      ? layoutSlot(id)
      : layoutEmpty(`${item?.label ?? id} — nothing to show`));
    arm.append(layoutGap(side, at + 1));
  });
  if (!ids.length) arm.append(layoutEmpty('Drop here'));

  const name = document.createElement('div');
  name.className = 'layout-side-name';
  // The count lives beside the side it is about, so the title bar answers "how full
  // is the row" and the bubble answers "which side".
  name.textContent = `${label} ${ids.length}/${view.layout?.limit ?? '–'}`;
  if (view.layout?.limit && ids.length >= view.layout.limit) node.classList.add('full');

  node.append(arm, name);
  return node;
}

function layoutEmpty (message) {
  const node = document.createElement('div');
  node.className = 'layout-arm-empty';
  node.textContent = message;
  return node;
}

/** A drop target: the place an item lands when it is let go here. */
function layoutGap (side, index) {
  const node = document.createElement('div');
  node.className = 'layout-gap';
  node.dataset.index = String(index);
  if (side) node.dataset.side = side;
  return node;
}

function layoutSlot (id) {
  const item = layoutItems().find((entry) => entry.id === id);
  const node = document.createElement('div');
  const sizes = item?.sizes ?? [];
  const size = sizes.length ? widgetSize(id) : null;
  node.className = `layout-item${sizes.length > 1 ? ' sizeable' : ''}`;
  node.dataset.id = id;
  node.dataset.side = layoutArmOf(id);
  if (size) node.dataset.size = size;
  node.title = item?.note
    ?? (sizes.length > 1
      ? `${item.label} — tap to make it ${size === sizes[0] ? sizes[1] : sizes[0]}`
      : item?.label ?? id);
  node.innerHTML = `${layoutGlyph(item)}<span class="label">${escapeHtml(item?.label ?? id)}</span>`
    + (sizes.length > 1 ? `<span class="layout-size">${size === sizes[0] ? 'L' : 'S'}</span>` : '')
    + '<button class="layout-remove" title="Take it out"></button>';
  const remove = node.querySelector('.layout-remove');
  remove.innerHTML = icon('close', { size: 11 });
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    api.action('layout.set', { change: { op: 'remove', surface: arranging.surface, id } });
  });
  return node;
}

/**
 * Steps an item through its sizes. A tap is the right gesture for this because a
 * drag is what moves the item, and the two cannot be confused: nothing is
 * rearranged until the pointer has actually travelled.
 */
function cycleWidgetSize (id) {
  const sizes = layoutItems().find((entry) => entry.id === id)?.sizes ?? [];
  // Only something the row already carries has a size to change; a tap on the
  // palette is a press with nothing behind it, and does nothing at all.
  if (sizes.length < 2 || !layoutOrder().includes(id)) return;
  const at = Math.max(0, sizes.indexOf(widgetSize(id)));
  api.action('layout.set', { change: { surface: arranging.surface, id, op: 'size', size: sizes[(at + 1) % sizes.length] } });
}

function layoutGlyph (item) {
  return item?.icon ? icon(item.icon, { size: 14 }) : '<span class="layout-dot"></span>';
}

/** Everything the surface is not carrying: the palette the rest is dragged from. */
function renderPalette () {
  const carrying = new Set(layoutOrder());
  const spare = surfaceItems(arranging.surface).filter((item) => !carrying.has(item.id));
  const host = el('layoutPalette');
  if (!spare.length) {
    const note = document.createElement('div');
    note.className = 'layout-empty';
    note.textContent = 'Everything this surface has is in use';
    host.replaceChildren(note);
    return;
  }
  host.replaceChildren(...spare.map((item) => {
    const node = document.createElement('div');
    node.className = 'layout-item loose';
    node.dataset.id = item.id;
    node.innerHTML = `${layoutGlyph(item)}<span class="label">${escapeHtml(item.label)}</span>`;
    return node;
  }));
}

/**
 * The drag itself.
 *
 * A press turns into a drag once the pointer has travelled far enough, because the
 * island is also dragged sideways to fold away and a tap still has to be a tap.
 * The dragged item keeps its place in the list — a lifted ghost, so the layout
 * does not jump around under the hand — and the gap it would land in opens up.
 * On release the arrangement is sent off and the answer arrives as a state push
 * like any other.
 */
function bindArrangeDrag () {
  let press = null;

  root.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('.layout-item');
    if (!item || event.target.closest('.layout-remove')) return;
    press = { item, x: event.clientX, y: event.clientY, live: false };
  });

  root.addEventListener('pointermove', (event) => {
    if (!press) return;
    if (!press.live) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
      press.live = true;
      arranging.drag = press;
      press.item.classList.add('lifting');
      root.classList.add('arranging');
      // The ghost says what is being dragged, so a hand that has lifted a widget
      // out of the palette can see what it picked up.
      const ghost = el('arrangeGhost');
      ghost.textContent = press.item.querySelector('.label')?.textContent ?? press.item.dataset.id;
      ghost.hidden = false;
    }
    moveArrangeDrag(event);
  });

  const release = (event) => {
    if (!press) return;
    const { item, live } = press;
    press = null;
    arranging.drag = null;
    item.classList.remove('lifting');
    root.classList.remove('arranging');
    el('arrangeGhost').hidden = true;
    for (const node of root.querySelectorAll('.layout-gap.over, .layout-side.over')) node.classList.remove('over');
    if (!live) {
      // A press that never travelled is a tap, and on an item that can be more
      // than one size that is what it means.
      cycleWidgetSize(item.dataset.id);
      return;
    }
    const target = layoutTargetUnder(event.clientX, event.clientY);
    if (target) dropArranged(item.dataset.id, target);
  };

  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
}

function moveArrangeDrag (event) {
  const ghost = el('arrangeGhost');
  ghost.style.left = `${event.clientX}px`;
  ghost.style.top = `${event.clientY}px`;
  // The gap the item would land in lights up, so the drop is never a guess.
  const target = layoutTargetUnder(event.clientX, event.clientY);
  const side = target?.closest?.('.layout-side') ?? null;
  for (const node of root.querySelectorAll('.layout-gap')) {
    const owner = node.closest('.layout-side');
    const open = !owner || sideHasRoom(owner, arranging.drag?.item?.dataset.id);
    node.classList.toggle('over', node === target && open);
    if (owner) owner.classList.toggle('full', !open);
  }
  for (const side of root.querySelectorAll('.layout-side')) side.classList.toggle('over', side.contains(target));
}

/**
 * Where a dragged item would land.
 *
 * A gap first, because it says exactly where the item goes between two others. A
 * gap is a thin line, so it gets a generous radius: the hand is aiming at the
 * space between two things, not at a line.
 *
 * Failing that — and on a surface with no arms at all — whatever side the pointer
 * is over, which lands the item at the end of that side. That is what makes an
 * empty side work: without it, the only way to put something on the other side of
 * the housing was to move something there first.
 */
function layoutTargetUnder (x, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of root.querySelectorAll('.layout-gap')) {
    const box = node.getBoundingClientRect();
    const distance = Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2));
    if (distance <= Math.max(box.height, 14) + 10 && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  if (best) return best;

  for (const side of root.querySelectorAll('.layout-side')) {
    const box = side.getBoundingClientRect();
    if (x < box.left - 8 || x > box.right + 8 || y < box.top - 8 || y > box.bottom + 8) continue;
    // A side with no room is not a place to put anything, so it is not a place to
    // aim at either: it stops lighting up and the drop is refused with a reason
    // rather than quietly doing nothing.
    if (sideHasRoom(side, arranging.drag?.item?.dataset.id)) {
      return bestGapFor(side);
    }
    return null;
  }

  for (const row of root.querySelectorAll('.layout-list')) {
    const box = row.getBoundingClientRect();
    if (x < box.left - 8 || x > box.right + 8 || y < box.top - 8 || y > box.bottom + 8) continue;
    return row.querySelector('.layout-gap') ?? { dataset: { index: String(row.childElementCount) } };
  }
  return null;
}

/**
 * Whether a side still has room for the item being dragged, which is not the same as
 * whether it is full: an item already on that side only ever moves within the room it
 * already has.
 */
function sideHasRoom (side, id) {
  const limit = view.layout?.limit;
  if (!limit) return true;
  const arm = side.querySelector('.layout-arm');
  // `querySelectorAll` hands back a NodeList, which has no `filter` — and calling it
  // one throws on every drag, which is how a rule about room became a crash.
  const carried = arm
    ? Array.from(arm.querySelectorAll('.layout-item')).filter((item) => item.dataset.id !== id).length
    : 0;
  return carried < limit;
}

function bestGapFor (side) {
  const gaps = side.querySelectorAll('.layout-gap');
  return gaps[gaps.length - 1] ?? null;
}

function dropArranged (id, target) {
  if (!target?.dataset) return;
  // The limit is a rule, so it is enforced here as well as in the layout: a drop
  // onto a side with no room is refused with a reason instead of appearing to work.
  if (target.dataset.side && !sideHasRoom(target.closest('.layout-side'), id)) {
    toast(`${target.dataset.side === 'left' ? 'Left' : 'Right'} already holds ${view.layout?.limit} — take one out first`);
    return;
  }
  const change = { surface: arranging.surface, id, index: Number(target.dataset.index) };
  // A gap belongs to the side it sits in, so dropping one there also says which
  // side of the housing the item ends up on.
  if (target.dataset.side) change.arm = target.dataset.side;
  api.action('layout.set', { change });
}

// ---------------------------------------------------------------- hover

let hoverTimer = null;
root.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    if (view.snapshot?.capturing) return;
    if (view.hoverToExpand && view.state === 'compact' && !view.pinned) {
        openPanel(view.lastPanel ?? 'player');
    }
});
root.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    // The shots drive the island from the main process; a pointer that happens to
    // sit on the notch would fold every panel between the setState and the
    // capture.
    if (view.snapshot?.capturing) return;
    if (view.pinned) return;
    hoverTimer = setTimeout(() => {
        if (view.state !== 'compact' && !view.pinned) api.action('panel.open', { state: 'compact' });
    }, 220);
});

// ---------------------------------------------------------------- sliders

function bindSlider (node, onChange, onCommit) {
  if (!node) return;
  let dragging = false;
  const valueAt = (event) => {
    const rect = node.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  };
  node.addEventListener('pointerdown', (event) => {
    dragging = true;
    node.setPointerCapture(event.pointerId);
    onChange(valueAt(event));
  });
  node.addEventListener('pointermove', (event) => {
    if (dragging) onChange(valueAt(event));
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    node.releasePointerCapture?.(event.pointerId);
    onCommit?.(valueAt(event));
  };
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
}

bindSlider(el('volumeSlider'), (value) => api.action('volume.set', { value }));
bindSlider(el('micSlider'), (value) => api.action('input.volume', { value }));
bindSlider(el('progress'), (ratio) => {
  const media = view.snapshot?.media;
  if (media?.duration) el('progressFill').style.width = `${ratio * 100}%`;
}, (ratio) => {
  const media = view.snapshot?.media;
  if (media?.duration) api.action('media.seek', { seconds: ratio * media.duration });
});

// ---------------------------------------------------------------- pointer

/**
 * The window is click-through by default; the main process only lets clicks in
 * while the pointer is over the island.
 */
/**
 * The housing is a physical hole: it renders nothing and it must not swallow
 * clicks either, otherwise whatever sits behind it (a menu, a video) becomes
 * unclickable. Only the arms and the panels count as interactive.
 */
function isInteractiveAt (x, y) {
    if (y > bandHeight()) return true; // panel area
    if (view.state !== 'compact') return true; // collapse button is in the band when expanded
    const gap = gapWidth() / 2;
    const centre = view.frame.width / 2;
    return Math.abs(x - centre) > gap;
}

let pointerInside = false;
function reportPointer (interactive) {
  if (interactive === pointerInside) return;
  pointerInside = interactive;
  api.pointer(interactive);
}

document.addEventListener('mousemove', (event) => {
  reportPointer(event.clientX < view.frame.width && isInteractiveAt(event.clientX, event.clientY));
});
document.addEventListener('mouseleave', () => reportPointer(false));

// ---------------------------------------------------------------- wiring

let lastFrameState = null;
let framesSeen = 0;
api.on('island:frame', (frame) => {
  framesSeen += 1;
  applyFrame(frame);
  // Only a state change needs a new measurement: the size is already correct for
  // every animation frame in between.
  if (frame.state !== lastFrameState) {
    lastFrameState = frame.state;
    requestSize();
  }
});

api.on('state:update', (snapshot) => {
  render(snapshot);
  requestSize();
});

api.on('media:tick', ({ elapsed, playing }) => {
  const media = view.snapshot?.media;
  if (!media) return;
  el('elapsed').textContent = timecode(elapsed);
  el('progressFill').style.width = `${progressOf({ ...media, elapsed }) * 100}%`;
  root.classList.toggle('playing', Boolean(playing));
});

api.on('toast', ({ message }) => toast(message));

api.on('system:tick', ({ cpu }) => {
  const media = view.snapshot?.media;
  if (media) view.snapshot.system.cpu = cpu;
  const label = root.querySelector('.widget[data-widget="cpu"] .label');
  if (label) label.textContent = `${Math.round(cpu)}%`;
});

setInterval(() => {
  // The clock is the one widget that shows the time passing, so the row has to be
  // drawn again — but only while the row is what is on screen.
  const compact = surfaceArms(view.snapshot ?? {}, 'compact');
  if ((compact.right.includes('clock') || compact.left.includes('clock')) && view.state === 'compact') {
    render(view.snapshot);
  }
  if (el('clipboardList').childElementCount) renderClipboard(view.snapshot);
}, 10_000);

loadMods().finally(() => api.getState()).then((snapshot) => {
  render(snapshot);
  // A frame may already have arrived while the page was loading; it is newer
  // than this snapshot, so it wins.
  if (framesSeen === 0) {
    applyFrame({
      ...snapshot.geometry.frame,
      islandHeight: snapshot.geometry.frame.height - 26,
      state: snapshot.geometry.state,
      notch: snapshot.geometry.notch,
    });
    lastFrameState = snapshot.geometry.state;
  }
  requestSize();
});

// ---------------------------------------------------------------- mods

/**
 * What the loaded mods brought.
 *
 * A mod registers through `window.islandMod`, which is on the page rather than in the
 * preload: mod code runs in the renderer's main world, and the preload's world cannot
 * see it. The main process is told the metadata afterwards, so a mod can be arranged
 * without the main process ever running mod code.
 */
const modWidgets = new Map();
const modPanels = new Map();
const modList = [];

window.islandMod = {
  /**
   * Called by a mod file. `widgets` and `panels` are definitions; the render
   * functions stay here, in the renderer, which is the only place they can run.
   */
  register (definition = {}) {
    const mod = {
      id: definition.id ?? 'mod',
      name: definition.name ?? definition.id ?? 'Mod',
    };
    for (const widget of definition.widgets ?? []) {
      if (!widget?.id) continue;
      modWidgets.set(widget.id, { ...widget, mod: mod.id, name: mod.name });
    }
    for (const panel of definition.panels ?? []) {
      if (!panel?.id) continue;
      modPanels.set(panel.id, { ...panel, mod: mod.id, name: mod.name });
    }
    if (!modList.some((entry) => entry.id === mod.id)) modList.push(mod);
    syncMods();
  },
  /** Fires one of the actions the island already has. */
  action: (name, args) => api.action(name, args ?? {}),
  /** The state the island is showing, as of the last push. */
  state: () => view.snapshot,
};

/**
 * Hands the main process the metadata for everything the mods registered.
 *
 * Only ids, labels and icons — never a render function. The main process runs no mod
 * code, so this is the whole of what a mod is there: enough to arrange it, and enough
 * to list it in the settings with a switch.
 */
function syncMods () {
  const items = [
    ...[...modWidgets.values()].map((widget) => ({
      mod: widget.mod, id: widget.id, kind: 'widget', label: widget.label ?? widget.id, icon: widget.icon,
    })),
    ...[...modPanels.values()].map((panel) => ({
      mod: panel.mod, id: panel.id, kind: 'panel', label: panel.label ?? panel.id,
    })),
  ];
  api.action('mods.set', { mods: items });
}

/**
 * Loads every mod file and runs it.
 *
 * A mod that throws is left out and said so, because a mod that breaks on load would
 * otherwise take the island down with it — and the point of a boundary is that what is
 * behind it cannot.
 */
async function loadMods () {
  let files = [];
  try {
    files = await api.mods.load();
  } catch (error) {
    console.error('[mods] could not read the mods folder:', error.message);
    return;
  }
  for (const file of files) {
    try {
      // A mod is loaded as a module from a blob rather than eval'd, because the page's
      // content security policy does not allow eval and a mod is not allowed to ask for
      // it. A blob is the narrowest thing that runs: the code is the app's own, in a URL
      // the app made, and it carries no origin of its own to reach back to.
      //
      // A module rather than a script tag, so a mod that tried to import something would
      // fail on the import rather than on something it reached by accident.
      const url = URL.createObjectURL(new Blob([file.source], { type: 'text/javascript' }));
      try {
        await import(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error(`[mods] ${file.name} did not load:`, error.message);
    }
  }
}

// Expose a tiny surface for debugging from the devtools console.
window.__island = { view, api };

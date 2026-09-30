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

const view = {
  state: 'compact',
  frame: { width: 220, islandHeight: 32 },
  notch: { width: 0, height: 0, detected: false },
  maxWidth: 440,
  style: 'pill',
  hoverToExpand: true,
  widgets: [],
  pinned: false,
  lastPanel: 'player',
  snapshot: null,
  widgetNodes: new Map(),
  bubbleNodes: new Map(),
  widgetSignature: '',
  appliedState: 'compact',
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
  mic: 'var(--red)',
};

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
      node.className = `widget${playbackState <= 0 ? ' dim' : ''}`;
      node.dataset.panelOpen = 'player';
      // Album art inside a ring of playback progress: one round thing, no
      // label — the island names the song by its cover.
      if (artwork) {
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
      label.textContent = state.volume.muted ? 'Mute' : `${Math.round(state.volume.value * 100)}`;
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

      const node = document.createElement('button');
      const low = tracked && tracked.battery <= 0.2;
      node.className = `widget${tracked ? ' readout' : ''}${low ? ' alert' : ''}${tracked && tracked.charging ? ' is-charging' : ''}`;
      node.dataset.panelOpen = 'bluetooth';
      node.insertAdjacentHTML('beforeend', icon('bluetooth', { size: 14 }));
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
        label.textContent = `${Math.round(tracked.battery * 100)}`;
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
      // AirDrop only earns a place in the row while a transfer is actually
      // running; the transfer bubble takes the island over for that stretch.
      const live = state.activities.some((a) => a.kind === 'transfer');
      if (!live) return null;
      const node = document.createElement('div');
      node.className = 'widget';
      node.insertAdjacentHTML('beforeend', icon('airdrop', { size: 14 }));
      node.title = 'AirDrop';
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

  // Charging and transferring get a little bar instead of a ring, because what
  // matters there is the level walking from amber to green and the two dots
  // closing on each other.
  const bar = activity.kind === 'transfer' || activity.kind === 'battery';

  if (activity.artwork) {
    const image = document.createElement('img');
    image.className = 'thumb';
    image.src = activity.artwork;
    node.append(image);
  } else if (activity.kind === 'transfer') {
    // A transfer bubble is just the AirDrop logo and its bar — the same two
    // things the panel shows, small enough to sit beside the housing. The bar
    // is AirDrop blue, not the amber-to-green of a charge.
    node.style.setProperty('--charge', '#2f8bff');
    node.insertAdjacentHTML('beforeend', icon('airdrop', { size: 18 }));
    node.insertAdjacentHTML('beforeend',
      '<span class="mini-bar"><i class="fill"></i><i class="dot from"></i><i class="dot to"></i></span>');
  } else if (bar && activity.progress !== null && activity.progress !== undefined) {
    node.insertAdjacentHTML('beforeend',
      '<span class="mini-bar"><i class="fill"></i></span>');
    tintCharge(node, activity.progress);
  } else if (activity.progress !== null && activity.progress !== undefined) {
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.setProperty('--progress', activity.progress);
    ring.append(document.createElement('i'));
    node.append(ring);
  } else if (activity.kind === 'mic') {
    node.insertAdjacentHTML('beforeend', '<span class="live"></span>');
  } else {
    node.insertAdjacentHTML('beforeend', icon(activity.icon, { size: 15 }));
  }

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
  return node;
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

  const artwork = node.querySelector('.thumb');
  if (artwork && artwork.getAttribute('src') !== activity.artwork) artwork.src = activity.artwork;

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

/** Bounces a widget when its headline value changed since the last render. */
function popChangedWidgets (nodes, state) {
  const signature = state.prefs.widgets.map((id) => {
    if (id === 'media') return state.media.title;
    if (id === 'clipboard') return state.clipboard.items[0]?.text ?? '';
    if (id === 'volume') return `${Math.round(state.volume.value * 100)}${state.volume.muted}`;
    if (id === 'mic') return `${state.input.muted}${state.input.active.join()}`;
    if (id === 'battery') return `${Math.round(state.battery.level * 100)}${state.battery.charging ? 'c' : ''}`;
    if (id === 'bluetooth') return state.bluetooth.devices.map((device) => device.battery).join();
    return '';
  }).join('|');

  if (view.widgetValues !== undefined && view.widgetValues !== signature) {
    for (const node of nodes) {
      node.classList.remove('pop');
      void node.offsetWidth; // restart the animation
      node.classList.add('pop');
    }
    nudge();
  }

  // A volume change gets its own squash, the way the system volume HUD pulses.
  const volume = Math.round(state.volume.value * 100) + (state.volume.muted ? 'm' : '');
  if (view.lastVolume !== undefined && view.lastVolume !== volume) pulse('volume');
  view.lastVolume = volume;

  const muted = `${state.input.muted}${state.input.active.join()}`;
  if (view.lastMuted !== undefined && view.lastMuted !== muted) pulse('mic');
  view.lastMuted = muted;

  view.widgetValues = signature;
}

/** One shot animation class; restarting it needs a reflow in between. */
function pulse (name) {
  const node = root;
  const className = `pulse-${name}`;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  setTimeout(() => node.classList.remove(className), 620);
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

const WIDGET_ORDER = ['media', 'bluetooth', 'volume', 'mic', 'battery', 'meeting', 'clipboard', 'clock', 'airdrop', 'cpu'];

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
  view.widgets = snapshot.prefs.widgets;
  view.notch = snapshot.geometry.notch;
  syncPanelWidth();

  renderWidgets(snapshot);
  renderPlayer(snapshot);
  renderSound(snapshot);
  renderMic(snapshot);
  renderBluetooth(snapshot);
  renderClipboard(snapshot);
  renderSettings(snapshot);
  syncPanels();
  requestSize();
}

/**
 * Fills both arms. Live activities take the housing over; when there are none the
 * widgets come back. Everything hugs the notch: the first half sits to its right,
 * the rest to its left, so the island reads as one pill with the camera cut into
 * its middle. Nodes are reused between renders so the meters and the transfer
 * dots keep animating.
 */
function renderWidgets (state) {
  const wanted = state.prefs.widgets.filter((id) => WIDGETS[id]);
  const signature = wanted.join(',');
  if (signature !== view.widgetSignature) {
    view.widgetSignature = signature;
    view.widgetNodes.clear();
  }

  const widgets = [];
  for (const id of wanted) {
    const fresh = WIDGETS[id].render(state);
    if (!fresh) {
      view.widgetNodes.delete(id);
      continue;
    }
    const previous = view.widgetNodes.get(id);
    if (previous) previous.replaceWith(fresh);
    fresh.dataset.widget = id;
    view.widgetNodes.set(id, fresh);
    widgets.push(fresh);
  }
  for (const id of [...view.widgetNodes.keys()]) {
    if (!wanted.includes(id)) view.widgetNodes.delete(id);
  }

  // While something is happening the island shows the event, not the widgets:
  // the same takeover the iPhone does with a call or a timer.
  const bubbles = renderBubbles(state);
  const rendered = bubbles.length ? bubbles : widgets;
  root.classList.toggle('bubbles', bubbles.length > 0);

  const split = Math.ceil(rendered.length / 2);
  el('armLeft').replaceChildren(...rendered.slice(split));
  el('armRight').replaceChildren(...rendered.slice(0, split));
  // A bubble must not bounce because the volume changed, so the pop only ever
  // lands on widgets even while the activities own the row.
  popChangedWidgets(bubbles.length ? widgets : rendered, state);
  requestSize();
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
     || (media.playbackState > 0 ? 'Apple Music' : (state.helper.available ? 'Press play with F8' : 'Install the system bridge for control'));

  el('progressFill').style.width = `${progressOf(media) * 100}%`;
  el('elapsed').textContent = timecode(media.elapsed);
  el('duration').textContent = timecode(media.duration);

  el('buttonPlay').innerHTML = icon(playing ? 'pause' : 'play', { size: 19, filled: true });
  el('buttonPlay').classList.toggle('waiting', Boolean(state.media.pending));
  el('buttonPrevious').innerHTML = icon('previous', { size: 17, filled: true });
  el('buttonNext').innerHTML = icon('next', { size: 17, filled: true });
  for (const button of ['buttonPlay', 'buttonPrevious', 'buttonNext']) {
    el(button).disabled = !state.helper.available;
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

  const toggles = el('widgetToggles');
  toggles.replaceChildren(...WIDGET_ORDER.map((id) => {
    const button = document.createElement('button');
    const on = prefs.widgets.includes(id);
    button.className = `widget-toggle${on ? ' on' : ''}`;
    button.textContent = WIDGETS[id].label;
    button.addEventListener('click', () => {
      const next = on ? prefs.widgets.filter((widget) => widget !== id) : [...prefs.widgets, id];
      api.action('prefs.set', { patch: { widgets: next } });
    });
    return button;
  }));

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
   if (stateEl) stateEl.textContent = charging ? (full ? 'Fully charged' : 'Charging') : `${minutes > 0 ? `${minutes} min left` : `${percent}%`}`;
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
function renderQuick (state) {
  const output = (state.devices.list ?? []).find((device) => device.isDefault && !device.input);
  const accessory = (state.bluetooth?.devices ?? []).find((device) => device.connected && device.battery >= 0);
  el('quickOutput').innerHTML = `${icon('volumeLow', { size: 17 })}<span class="caption">${escapeHtml(output?.name ?? 'Sound')}</span>`;
  el('quickMic').innerHTML = `${icon(state.input.muted ? 'micOff' : 'mic', { size: 17 })}<span class="caption">${state.input.muted ? 'Mic off' : 'Mic on'}</span>`;
  el('quickBluetooth').innerHTML = `${icon('bluetooth', { size: 17})}<span class="caption">${accessory ? escapeHtml(accessory.name) : 'Bluetooth'}</span>`;
  el('quickPlayer').innerHTML = `${icon('music', { size: 17 })}<span class="caption">${state.media.title ? escapeHtml(state.media.title) : 'Player'}</span>`;
  el('quickClipboard').innerHTML = `${icon('clipboard', { size: 17 })}<span class="caption">Clipboard</span>`;
  el('quickSettings').innerHTML = `${icon('gear', { size: 17 })}<span class="caption">Settings</span>`;

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
  el('quickTimer').innerHTML = running.length
    ? `${icon('timer', { size: 17 })}<span class="caption">${escapeHtml(running[0].subtitle)}</span>`
    : `${icon('timer', { size: 17 })}<span class="caption">Timer</span>`;
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
  morphTimer = setTimeout(() => root.classList.remove('morphing'), 260);
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
function armContentWidth (arm) {
  let total = 0;
  for (const child of arm.children) total += child.offsetWidth + 3;
  return total;
}

/** Bubbles are wider than widgets, so the island measures them the same way. */
function compactWidth () {
  const EDGE = 4; // breathing room between the widgets and the island's edge
  const left = armContentWidth(el('armLeft'));
  const right = armContentWidth(el('armRight'));
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
  return Math.round(Math.min(Math.max(Math.min(view.maxWidth, PANEL_WIDTH), minimum), maximum));
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
    ask({ width: expandedWidth(), height: panelHeight() });
    return;
  }

  const left = el('armLeft');
  const right = el('armRight');

  // The compact island is width limited: when the widgets do not fit, the widest
  // arm gives up its last widget until they do. The real Dynamic Island drops
  // detail in exactly the same way. Activity bubbles are never dropped — hiding
  // an event because it is a little too wide would lose the whole point.
  while (compactWidth() > view.maxWidth && left.children.length + right.children.length > 2) {
    const widest = armContentWidth(left) >= armContentWidth(right) ? left : right;
    const candidate = [...widest.children].reverse().find((child) => !child.classList.contains('bubble'));
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
    view.pinned = false;
    api.action('panel.open', { state: 'compact' });
    return;
  }
  view.pinned = true;
  view.lastPanel = name;
  api.action('panel.open', { state: name });
}

// --- drag: pulling the island down collapses it, pulling up opens it
let drag = null;
let pressTimer = null;
root.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  // Buttons, sliders and bubbles keep their own behaviour.
  if (event.target.closest('button, .slider, .progress, input, select')) return;

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
el('quickTimer')?.addEventListener('click', () => api.action('timer.start', { minutes: 5 }));

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
    if (event.target.closest('#island') && !event.target.closest('.widget')) {
        view.pinned = view.state !== 'compact';
        api.action('island.toggle', {});
    }
});

document.addEventListener('change', (event) => {
  const { id, value, checked } = event.target;
  if (id === 'styleSelect') api.action('prefs.set', { patch: { island: { style: value } } });
  if (id === 'hoverToggle') api.action('prefs.set', { patch: { island: { hoverToExpand: checked } } });
  if (id === 'mediaKeysToggle') api.action('prefs.set', { patch: { hotkeys: { mediaKeys: checked } } });
  if (id === 'loginToggle') api.action('prefs.set', { patch: { launchAtLogin: checked } });
});

el('retryHelper').addEventListener('click', () => api.action('helper.retry', {}));

// ---------------------------------------------------------------- hover

let hoverTimer = null;
root.addEventListener('mouseenter', () => {
  clearTimeout(hoverTimer);
  if (view.hoverToExpand && view.state === 'compact' && !view.pinned) {
    openPanel(view.lastPanel ?? 'player');
  }
});
root.addEventListener('mouseleave', () => {
  clearTimeout(hoverTimer);
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
  if (label && view.widgets.includes('cpu')) label.textContent = `${Math.round(cpu)}%`;
});

setInterval(() => {
  if (view.widgets.includes('clock') && view.state === 'compact') render(view.snapshot);
  if (el('clipboardList').childElementCount) renderClipboard(view.snapshot);
}, 10_000);

api.getState().then((snapshot) => {
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

// Expose a tiny surface for debugging from the devtools console.
window.__island = { view, api };

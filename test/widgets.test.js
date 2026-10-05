'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const layout = require('../src/main/layout');

/**
 * The widgets, rendered.
 *
 * The renderer has no test infrastructure — it touches `document` at module scope, so
 * it cannot be required. But three of the bugs found in the widgets were invisible
 * from the outside: a label missing its unit, a size setting with nothing behind it,
 * and a row that bounced every widget when it was rearranged. All three are things a
 * render can be asked about, so there is a render here to ask.
 *
 * The DOM below is deliberately small. It is enough to build a node, give it a class
 * and some text, and put it in an arm — which is all a widget does.
 */

class NodeList extends Array {
  constructor (items) { super(...items); }
  item (index) { return this[index] ?? null; }
}

class Node {
  constructor (tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.classes = new Set();
    this.dataset = {};
    this.style = { props: {}, setProperty (key, value) { this.props[key] = value; } };
    this.attributes = {};
    this._text = '';
    this.title = '';
    // The widgets reach for this directly, so the stub has to answer it.
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }
  set className (value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className () { return [...this.classes].join(' '); }
  set textContent (value) { this._text = String(value ?? ''); }
  get textContent () {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this._text;
  }
  set innerHTML (value) {
    this._html = value;
    this.children = [];
    // The markup the widgets build is a known set of tags with known classes; this
    // reads just enough of it for a test to ask what a widget put in its arm.
    for (const match of String(value).matchAll(/<(\w+)([^>]*)>/g)) {
      const node = new Node(match[1]);
      const cls = /class="([^"]*)"/.exec(match[2]);
      if (cls) node.className = cls[1];
      this.append(node);
    }
  }
  get innerHTML () { return this._html ?? ''; }
  get childElementCount () { return this.children.length; }
  append (...kids) {
    for (const kid of kids) { kid.parent = this; this.children.push(kid); }
  }
  prepend (kid) { kid.parent = this; this.children.unshift(kid); }
  remove () {
    if (this.parent) this.parent.children = this.parent.children.filter((kid) => kid !== this);
  }
  replaceChildren (...kids) { this.children = []; for (const kid of kids) this.append(kid); }
  replaceWith (kid) {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    this.parent.children.splice(at, 1, kid);
    kid.parent = this.parent;
  }
  insertAdjacentHTML (where, markup) {
    const node = new Node('span');
    const cls = /class="([^"]*)"/.exec(markup);
    if (cls) node.className = cls[1];
    else if (markup.startsWith('<svg')) node.className = 'icon';
    if (where === 'afterbegin') this.prepend(node);
    else this.append(node);
  }
  contains (node) {
    return node === this || this.children.some((kid) => kid.contains(node));
  }
  closest (selector) {
    const wanted = selector.trim().replace(/^\./, '');
    let node = this;
    while (node) {
      if (node.classes.has(wanted)) return node;
      node = node.parent;
    }
    return null;
  }
  addEventListener () {}
  setAttribute (key, value) { this.attributes[key] = String(value); }
  getAttribute (key) { return this.attributes[key]; }
  matches (selector) {
    return selector.split(',').some((part) => this.classes.has(part.trim().replace(/^\./, '')));
  }
  querySelector (selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll (selector) {
    const found = [];
    const walk = (node) => {
      for (const kid of node.children) {
        if (kid.matches(selector)) found.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return new NodeList(found);
  }
}

const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const byId = new Map();
const root = new Node('div');
for (const [, id] of page.matchAll(/\bid="([A-Za-z0-9]+)"/g)) {
  const node = new Node('div');
  node.attributes.id = id;
  byId.set(id, node);
  root.append(node);
}

function grab (name) {
  const from = app.indexOf(`function ${name} (`);
  if (from < 0) throw new Error(`not found: ${name}`);
  let depth = 0;
  const start = app.indexOf('{', from);
  for (let n = start; n < app.length; n++) {
    if (app[n] === '{') depth++;
    else if (app[n] === '}' && --depth === 0) return app.slice(from, n + 1);
  }
  throw new Error(`unbalanced: ${name}`);
}

const wFrom = app.indexOf('const WIDGETS = {');
let wDepth = 0;
const wStart = app.indexOf('{', wFrom);
let wEnd = 0;
for (let n = wStart; n < app.length; n++) {
  if (app[n] === '{') wDepth++;
  else if (app[n] === '}' && --wDepth === 0) { wEnd = n + 1; break; }
}

const sent = [];
const view = {
  snapshot: null, widgetSignature: '', widgetNodes: new Map(), widgetValues: undefined,
  connectedBluetooth: null, bluetoothHello: null,
  layout: null, state: 'compact', maxWidth: 560,
  notch: { detected: true, width: 220, height: 38 }, frame: { width: 300, islandHeight: 32 },
};
const sandbox = {
  document: {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new Node(tag),
  },
  root,
  el: (id) => byId.get(id) ?? null,
  api: { action: (name, args) => sent.push({ name, args }) },
  icon: () => '<svg class="icon"></svg>',
  clamp: (value, lo, hi) => Math.min(Math.max(value, lo), hi),
  escapeHtml: (value) => String(value ?? ''),
  layout,
  view,
  hasSomethingToAnnounce: (update) => ['available', 'downloading', 'ready'].includes(update?.state),
  surfaceArms: null, modWidgetDef: null, widgetSize: null,
  popChangedWidgets () {},
  renderBubbles: () => [],
  requestSize () {},
  tintCharge (node) { node.style.setProperty('--charge', 'rgb(255 200 88)'); },
  kindIcon: () => 'clipboard',
  progressOf: (media) => (media.duration ? media.elapsed / media.duration : 0),
  greetBluetooth () {},
  nudge () {},
};

const code = [
  'const modWidgets = new Map();',
  'const modPanels = new Map();',
  'const modList = [];',
  grab('widgetSize'),
  grab('surfaceArms'),
  grab('modWidgetDef'),
  grab('popChangedWidgets'),
  grab('widgetValue'),
  grab('isHexColor'),
  grab('hexToRgb'),
  grab('textOn'),
  grab('tintWash'),
  grab('applyTint'),
  grab('syncPicker'),
  grab('pickSwatch'),
  grab('renderPrivacy'),
  app.slice(wFrom, wEnd),
  grab('renderWidgets'),
].join('\n\n');

const api = new Function(...Object.keys(sandbox), `${code}\nreturn { renderWidgets, surfaceArms, widgetSize, popChangedWidgets, isHexColor, textOn, tintWash, syncPicker, pickSwatch };`)(...Object.values(sandbox));

const base = {
  media: { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', artwork: null, duration: 246, elapsed: 74, rate: 1, playbackState: 1 },
  volume: { value: 0.5, muted: false },
  input: { muted: false, volume: 1, active: [] },
  devices: { list: [], output: 0, input: 0 },
  battery: { level: 0.62, charging: false, minutes: -1, full: false },
  bluetooth: { devices: [] },
  airdrop: { live: false },
  activities: [], clipboard: { items: [], lastSeen: '' },
  hotkeys: {}, system: { cpu: 12, micAccess: 'unknown', displays: 1 },
  update: { state: 'idle', current: '1.0.0' },
  prefs: { island: { style: 'pill', hoverToExpand: true, maxWidth: 560 }, hotkeys: {}, updates: {}, mods: {} },
  geometry: { notch: { detected: true, width: 220, height: 38 }, frame: { width: 300, islandHeight: 32 } },
  layout: {
    surfaces: layout.SURFACES,
    arranged: { compact: layout.arranged(layout.normalise(null), 'compact'), quick: layout.DEFAULT_LAYOUT.quick, settings: layout.DEFAULT_LAYOUT.settings },
    sizes: { media: 'big' }, limit: layout.MAX_PER_SIDE,
    fullness: layout.fullness(layout.normalise(null), 'compact'),
    profile: 'default', profiles: ['default'],
  },
};

/** Renders the row and reports what is in it. */
function row (state) {
  view.snapshot = state;
  view.layout = state.layout;
  try {
    api.renderWidgets(state);
  } catch (error) {
    const widget = /at Object\.render \(eval[^\n]*$/.exec(error.stack)?.[0] ?? '';
    console.error('RENDER FAILED:', error.message, '\n', error.stack.split('\n').slice(0, 4).join('\n'));
    throw error;
  }
  const arm = (id) => byId.get(id).children.filter((kid) => kid.classes.has('widget'));
  return {
    right: arm('armRight').map((widget) => ({ id: widget.dataset.widget, className: widget.className, text: widget.textContent, title: widget.title, children: widget.children })),
    left: arm('armLeft').map((widget) => ({ id: widget.dataset.widget, className: widget.className, text: widget.textContent, title: widget.title, children: widget.children })),
  };
}

const shows = (state, id) => {
  const { right, left } = row(state);
  return [...right, ...left].find((widget) => widget.id === id) ?? null;
};

// ---------------------------------------------------------------- the bugs

test('the volume wears the same unit as the battery and the CPU', () => {
  const volume = shows(base, 'volume');
  assert.match(volume.text, /%$/, 'a bare number next to two percentages reads as a different thing');
  assert.strictEqual(shows(base, 'battery').text, '62%');
});

test('a Bluetooth accessory’s level is a percentage too', () => {
  const connected = { ...base, bluetooth: { devices: [{ address: 'AA', name: 'AirPods Pro', connected: true, battery: 0.44, charging: false }] } };
  assert.strictEqual(shows(connected, 'bluetooth').text, '44%');
});

test('the small form of the music widget is the small form', () => {
  const small = { ...base, layout: { ...base.layout, sizes: { media: 'small' } } };
  const widget = shows(small, 'media');
  assert.ok(widget.className.includes('small'), 'it is marked as one');
  // And it draws the glyph rather than a sleeve there is no room for.
  assert.ok(!widget.children.some((kid) => kid.classes.has('ring')), 'and no ring inside it');
});

test('rearranging the row does not bounce every widget in it', () => {
  // The comparison is keyed by widget rather than by position: a row that was rearranged
  // has the same widgets in different places, and comparing them slot by slot called all
  // of them changed.
  const first = { ...base, layout: { ...base.layout, arranged: { ...base.layout.arranged, compact: { right: ['media', 'volume'], left: ['clock', 'bluetooth'] } } } };
  row(first);
  const poppedAfterFirst = [...byId.get('armLeft').children, ...byId.get('armRight').children]
    .filter((kid) => kid.classes.has('pop')).map((kid) => kid.dataset.widget);

  const rearranged = { ...first, layout: { ...first.layout, arranged: { ...first.layout.arranged, compact: { right: ['volume', 'media'], left: ['bluetooth', 'clock'] } } } };
  row(rearranged);
  const popped = [...byId.get('armLeft').children, ...byId.get('armRight').children]
    .filter((kid) => kid.classes.has('pop')).map((kid) => kid.dataset.widget);

  assert.deepStrictEqual(poppedAfterFirst, []);
  assert.deepStrictEqual(popped, [], 'moving something is not the same as something moving');
});

// ------------------------------------------------------------- the conditions

test('a widget with nothing to say says nothing', () => {
  // The clipboard, AirDrop and the charger are all conditional: they are in the
  // arrangement, and they are not on the island, and the difference is the point.
  assert.strictEqual(shows(base, 'clipboard'), null, 'an empty clipboard');
  assert.strictEqual(shows(base, 'airdrop'), null, 'AirDrop that is not live');
  assert.strictEqual(shows(base, 'charging'), null, 'a charger that is not plugged in');

  const busy = {
    ...base,
    clipboard: { items: [{ text: 'hello', time: 1, kind: 'text' }], lastSeen: 'hello' },
    airdrop: { live: true },
    battery: { level: 0.62, charging: true, minutes: -1, full: false },
    layout: {
      ...base.layout,
      arranged: {
        ...base.layout.arranged,
        compact: { right: ['media', 'clipboard', 'airdrop'], left: ['battery', 'charging', 'clock'] },
      },
    },
  };
  assert.ok(shows(busy, 'clipboard'), 'once there is something copied');
  assert.ok(shows(busy, 'airdrop'), 'and once AirDrop is reachable');
  assert.ok(shows(busy, 'charging'), 'and once the charger is in');
});

test('a paused song disappears', () => {
  const paused = { ...base, media: { ...base.media, rate: 0, playbackState: 0 } };
  const widget = shows(paused, 'media');
  assert.strictEqual(widget, null, 'it disappears from the row when paused');
});

test('a streaming camera wears a green dot that cannot be arranged away', () => {
  const dots = (state) => byId.get('armRight').children.filter((kid) => kid.classes.has('privacy-dot'));
  assert.strictEqual(dots(base).length, 0, 'silence wears nothing');
  const live = { ...base, camera: { active: true } };
  row(live);
  assert.strictEqual(dots(live).length, 1, 'one dot while streaming');
  assert.ok(dots(live)[0].classes.has('camera'), 'and it is the green one');
  assert.strictEqual(dots(live)[0].title, 'Camera in use');
  // A layout that never heard of the dot still carries it: it is drawn by the
  // island, not arranged into it.
  const unarranged = { ...live, layout: { ...live.layout, arranged: { ...live.layout.arranged, compact: { right: [], left: [] } } } };
  row(unarranged);
  assert.strictEqual(dots(unarranged).length, 1, 'no arrangement takes it away');
});

test('a held microphone wears an orange dot', () => {
  const dots = (state) => byId.get('armRight').children.filter((kid) => kid.classes.has('privacy-dot'));
  const live = { ...base, input: { ...base.input, active: ['Voice Memos'] } };
  row(live);
  assert.strictEqual(dots(live).length, 1, 'one dot while held');
  assert.ok(dots(live)[0].classes.has('mic'), 'and it is the orange one');
  assert.strictEqual(dots(live)[0].title, 'In use by Voice Memos');
});

test('a picked colour stays readable', () => {
  assert.strictEqual(api.textOn('#000000'), '#ffffff', 'white on black');
  assert.strictEqual(api.textOn('#ffffff'), '#1c1c1e', 'near-black on white');
  assert.strictEqual(api.textOn('#0a84ff'), '#ffffff', 'white on bluetooth blue');
  assert.strictEqual(api.tintWash('#bf5af2', 0.22), 'rgba(191, 90, 242, 0.22)');
  assert.ok(!api.isHexColor('red') && !api.isHexColor('#fff') && !api.isHexColor(null), 'only #rrggbb paints');
});

test('a tinted widget wears its colour', () => {
  const tinted = { ...base, prefs: { ...base.prefs, island: { ...base.prefs.island, tints: { media: '#ff0000' } } } };
  row(tinted);
  const kids = byId.get('armRight').children;
  const media = kids.find((kid) => kid.dataset.widget === 'media');
  assert.strictEqual(media.dataset.tinted, '1', 'it is marked as tinted');
  assert.strictEqual(media.style.props['--wtint-bg'], 'rgba(255, 0, 0, 0.22)');
  assert.strictEqual(media.style.props['--wtint-fg'], '#ffffff', 'readable on red');
  const volume = kids.find((kid) => kid.dataset.widget === 'volume');
  assert.strictEqual(volume.dataset.tinted, undefined, 'untinted widgets never know');
});

test('a picker being used keeps what the finger chose', () => {
  // A state push re-rendering the panel underneath the native popup must not
  // throw the pick away before its change event even fires.
  const node = { value: '#ff0000' };
  sandbox.document.activeElement = node;
  api.syncPicker(node, '#000000');
  assert.strictEqual(node.value, '#ff0000', 'a focused control is not stomped');
  sandbox.document.activeElement = null;
  api.syncPicker(node, '#000000');
  assert.strictEqual(node.value, '#000000', 'an idle control still syncs');
});

test('a swatch click becomes the prefs patch its strip stands for', () => {
  sent.length = 0;
  api.pickSwatch({ dataset: { pick: 'tint:media', swatch: '#ff0000' } });
  api.pickSwatch({ dataset: { pick: 'accent', swatch: '' } });
  api.pickSwatch({ dataset: { pick: 'pill', swatch: '#000000' } });
  assert.deepStrictEqual(sent.map((call) => call.args.patch), [
    { island: { tints: { media: '#ff0000' } } },
    { island: { accent: null } },
    { island: { pill: '#000000' } },
  ]);
});

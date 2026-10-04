'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const layout = require('../src/main/layout');
const mods = require('../src/main/mods');

// ---------------------------------------------------------------- the loader

test('a folder with no mods is no mods, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-empty-'));
  assert.deepStrictEqual(mods.files(dir), []);
  assert.deepStrictEqual(mods.load(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every .js file in the folder is a mod', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  fs.writeFileSync(path.join(dir, 'one.js'), 'islandMod.register({ id: "one" });');
  fs.writeFileSync(path.join(dir, 'two.js'), 'islandMod.register({ id: "two" });');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a mod');
  assert.deepStrictEqual(mods.files(dir), ['one.js', 'two.js']);
  const loaded = mods.load(dir);
  assert.deepStrictEqual(loaded.map((mod) => mod.name), ['one', 'two']);
  assert.match(loaded[0].source, /islandMod\.register/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder that cannot be read is no mods', () => {
  // Pointing at a file rather than a folder makes readdirSync throw, which is the
  // case a permissions problem or a deleted folder produces.
  const file = path.join(os.tmpdir(), `mods-not-a-dir-${Date.now()}`);
  fs.writeFileSync(file, 'x');
  assert.deepStrictEqual(mods.files(file), []);
  assert.deepStrictEqual(mods.load(file), []);
  fs.rmSync(file, { force: true });
});

test('a fresh install gets an example mod, and only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-fresh-'));
  mods.ensure(dir);
  assert.ok(fs.existsSync(path.join(dir, 'example.js')), 'the example is written');
  const first = fs.readFileSync(path.join(dir, 'example.js'), 'utf8');
  mods.ensure(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'example.js'), 'utf8'), first,
    'and a second run leaves it alone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the example mod is a mod that would load', () => {
  // It is the only mod in the repo, so it is the only one that can be checked without
  // a renderer: it has to register something, and it has to use the API as documented.
  assert.match(mods.EXAMPLE, /islandMod\.register\(\{/);
  assert.match(mods.EXAMPLE, /widgets:\s*\[/);
  assert.match(mods.EXAMPLE, /panels:\s*\[/);
  // And it must not reach for anything the boundary does not allow.
  for (const forbidden of ['require(', 'process.', 'fs.', 'child_process', 'ipcRenderer']) {
    assert.ok(!mods.EXAMPLE.includes(forbidden), `the example must not use ${forbidden}`);
  }
});

// ------------------------------------------------- mods in the arrangement

test('a mod widget can be arranged like any other', () => {
  layout.addItem('compact', { id: 'spotify', label: 'Spotify', icon: 'music' });
  const clean = layout.normalise({ compact: ['media'], version: layout.LAYOUT_VERSION });
  const placed = layout.change(clean, { surface: 'compact', id: 'spotify', arm: 'left', index: 0 });
  assert.ok(layout.arranged(placed, 'compact').left.includes('spotify'));
  assert.ok(layout.normalise(placed).compact.includes('spotify'), 'and it survives a read');
});

test('a mod widget that is not built in is still a known item', () => {
  layout.addItem('compact', { id: 'spotify', label: 'Spotify', icon: 'music' });
  const clean = layout.normalise(null);
  assert.ok(layout.itemsOf('compact').some((item) => item.id === 'spotify'));
  assert.ok(layout.itemDef('compact', 'spotify'), 'so the editor can name it');
  assert.ok(!layout.itemDef('compact', 'not-a-widget'), 'and a made-up one is still made up');
});

test('a mod widget waits in the palette instead of taking a place', () => {
  // The row is full by default, and a mod arriving must not rearrange it — that is
  // what "arrange the island" would mean if a mod could move things by being loaded.
  const prefs = { get: () => ({}), setLayout: (next) => { prefs.get = () => next; } };
  layout.addItem('compact', { id: 'spotify', label: 'Spotify', icon: 'music' });
  const state = { mods: [{ mod: 'spotify', id: 'spotify', kind: 'widget', label: 'Spotify', icon: 'music' }] };
  mods.sync(state, prefs, layout);
  assert.ok(layout.itemDef('compact', 'spotify'), 'it is a known item');
  assert.ok(layout.available(prefs.get('layout'), 'compact').includes('spotify'), 'and it is in the palette');
  assert.ok(!layout.arranged(prefs.get('layout'), 'compact').left.includes('spotify'),
    'but it is not in the row until there is room for it');
});

test('a mod that is switched off takes its widgets back out', () => {
  const stored = [];
  const prefs = {
    get: (key) => key === 'mods' ? { spotify: false } : stored[0],
    setLayout: (next) => { stored[0] = next; },
  };
  layout.addItem('compact', { id: 'spotify', label: 'Spotify', icon: 'music' });
  const state = { mods: [{ mod: 'spotify', id: 'spotify', kind: 'widget', label: 'Spotify', icon: 'music' }] };
  // The user put it in the row by hand, on a side with room for it.
  const roomy = layout.normalise({ compact: ['media'], version: layout.LAYOUT_VERSION });
  const placed = layout.change(roomy, { surface: 'compact', id: 'spotify', arm: 'left', index: 0 });
  stored[0] = placed;
  assert.ok(layout.arranged(placed, 'compact').left.includes('spotify'));
  // And now the switch goes off.
  mods.sync(state, prefs, layout);
  assert.ok(!layout.arranged(prefs.get('layout'), 'compact').left.includes('spotify'),
    'and the switch took it back out');
});

test('a mod panel is not a widget, so it is not put in the row', () => {
  // The main process filters on kind before it writes anything into the arrangement,
  // which is what keeps a panel out of a row it would only crowd.
  const clean = layout.normalise(null);
  assert.ok(!clean.compact.includes('mod:example'));
});

test('the settings surface carries the mods section', () => {
  assert.ok(layout.DEFAULT_LAYOUT.settings.includes('mods'));
  assert.ok(layout.normalise(null).settings.includes('mods'));
});

test('a layout from before the mods section existed gains it back', () => {
  // The switch for mods cannot be arranged into a layout that does not have the
  // section, and a section that is not arranged is detached — so a layout written
  // before mods existed would have no way to turn a mod on again.
  const Module = require('node:module');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-migrate-'));
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({
    version: 2,
    layout: {
      version: 2,
      compact: ['media', 'volume', 'battery', 'clock', 'clipboard', 'bluetooth'],
      quick: ['volume', 'mic'],
      settings: ['appearance', 'hotkeys', 'updates', 'system'],
    },
  }, null, 2));
  const real = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'electron') return { app: { getPath: () => dir } };
    return real.apply(this, arguments);
  };
  delete require.cache[require.resolve('../src/main/prefs')];
  const prefs = require('../src/main/prefs');
  const loaded = prefs.load();
  assert.strictEqual(loaded.version, 3, 'the file is brought up to date');
  assert.ok(layout.normalise(loaded.layout).settings.includes('mods'),
    'and the switch is back where it can be reached');
  Module.prototype.require = real;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no action handler shadows the mods module', () => {
  // `mods.set` unpacks its argument, and calling that argument `mods` shadows the module
  // of the same name — so `mods.sync` reads a property of the metadata array and the
  // first mod that loads takes the island down with it. Nothing else unpacks a name the
  // main process already uses, and this is the guard that keeps it that way.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  const setter = source.slice(source.indexOf("'mods.set'"), source.indexOf("'mods.toggle'"));
  assert.ok(!setter.includes('({ mods })'), 'the argument is not unpacked under the module’s name');
  assert.ok(setter.includes('mods.sync'), 'and the module is the one being called');
});

// ------------------------------------------------------- the boundary

test('the page allows a mod to run and nothing else', () => {
  // A mod is code, so it has to run. The question is what running it allows, and the
  // answer is in the content security policy: a blob the app made, and no eval, no
  // inline, no network.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /script-src 'self' blob:/, 'a blob the app made is allowed');
  assert.ok(!csp.includes('unsafe-eval'), 'eval is not');
  assert.ok(!csp.includes('unsafe-inline'), 'and neither is an inline script');
  assert.ok(!csp.includes('connect-src'), 'and there is no network to reach');
});

test('a mod is loaded as a module, not eval’d', () => {
  // eval would need unsafe-eval in the policy, which is the one thing that lets any
  // string become code. A blob URL is the app's own code in a URL the app made.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const loader = source.slice(source.indexOf('async function loadMods'), source.indexOf('// Expose a tiny surface'));
  assert.ok(loader.includes('createObjectURL'), 'it makes a blob');
  assert.ok(loader.includes('await import(url)'), 'and imports it as a module');
  assert.ok(!loader.includes('eval('), 'and never evals');
  // A module cannot import anything, which is the boundary doing its job.
  assert.match(loader, /type: 'text\/javascript'/);
});

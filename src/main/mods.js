'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Mods: widgets and panels that are not part of the app.
 *
 * A mod is a JavaScript file in the user's mods folder. It runs in the renderer —
 * which has no Node, no file access and no network — and registers what it brings
 * through an API the app hands it. The main process never runs mod code: it only
 * carries the *metadata*, so a mod that wants to be arranged can be arranged, and a
 * mod that breaks can be turned off.
 *
 * The boundary is the renderer itself. A mod can draw, read the state it is handed
 * and fire the actions the app already has. It cannot read a file, open a socket, or
 * reach the main process except through the API on `window.islandMod`. That is the
 * whole of the sandbox, and it is the same wall the renderer already sits behind.
 */

const MODS_DIR = 'mods';

/** The example a fresh install gets, so there is something to copy and change. */
const EXAMPLE = `// An example mod: a widget in the island row, and a panel to open.
//
// A mod runs in the renderer — no Node, no files, no network. It is handed the state
// the island already has, and it can fire the actions the island already has.
//
// A widget's render returns a node, or null to leave the slot empty. A panel's render
// fills the panel the island opens. Both are called again on every state push, so a
// mod that keeps state should keep it on the definition, not in a closure it expects
// to survive.

islandMod.register({

  id: 'example',
  name: 'Example',

  widgets: [
    {
      id: 'example',
      label: 'Example',
      // Open this mod's panel when the widget is clicked.
      panel: 'mod:example',
      render: (state) => {
        const node = document.createElement('button');
        node.className = 'widget readout';
        // A mod widget opens its own panel the way a built-in one opens its own.
        node.dataset.panelOpen = 'mod:example';
        node.textContent = \`Battery \${Math.round(state.battery.level * 100)}%\`;
        return node;
      },
    },
  ],

  panels: [
    {
      id: 'example',
      label: 'Example',
      render: (state, el) => {
        el.textContent = \`This panel belongs to a mod. The island is on screen \${state.geometry.frame.width} pt.\`;
      },
    },
  ],

});
`;

function dir () {
  return path.join(app.getPath('userData'), MODS_DIR);
}

/** The mod files in a folder. An unreadable folder is no mods, not an error. */
function files (target = dir()) {
  try {
    return fs.readdirSync(target).filter((name) => name.endsWith('.js')).sort();
  } catch {
    return [];
  }
}

/**
 * Reads every mod file.
 *
 * @returns {Array<{ name: string, source: string }>}
 */
function load (target = dir()) {
  return files(target).map((name) => ({
    name: name.replace(/\.js$/, ''),
    source: fs.readFileSync(path.join(target, name), 'utf8'),
  }));
}

/**
 * Makes sure the folder exists, with an example in it.
 *
 * The example is only written when there is not one already: a folder the user has
 * already put a mod in should not gain a second file they did not ask for.
 */
function ensure (target = dir()) {
  fs.mkdirSync(target, { recursive: true });
  const example = path.join(target, 'example.js');
  if (!fs.existsSync(example)) fs.writeFileSync(example, EXAMPLE);
}

/**
 * Puts the loaded mods into the arrangement.
 *
 * A mod widget has to be a known item before it can be placed, which is the chicken and
 * egg of arranging something that is not built in. Registered here, and left in the
 * palette: a mod widget waits for room rather than taking it, so the row the user
 * arranged is never rearranged by a mod arriving.
 *
 * @param {object} state the main process state, which carries `state.mods`
 * @param {object} prefs the preferences module
 * @param {object} layout the layout module
 */
function sync (state, prefs, layout) {
  const switches = prefs.get('mods') ?? {};

  for (const mod of state.mods ?? []) {
    if (mod.kind === 'widget' && switches[mod.mod] !== false && !layout.itemDef('compact', mod.id)) {
      layout.addItem('compact', { id: mod.id, label: mod.label ?? mod.id, icon: mod.icon });
    }
  }

  // A mod that is switched off takes its widgets back out, so the switch is a switch and
  // not a filter. Only its own widgets — never anything the user put there by hand.
  const off = (state.mods ?? [])
    .filter((mod) => mod.kind === 'widget' && switches[mod.mod] === false)
    .map((mod) => mod.id);
  if (!off.length) return;
  const stored = prefs.get('layout');
  const before = layout.normalise(stored).compact;
  const compact = before.filter((id) => !off.includes(id));
  if (compact.length === before.length) return;
  prefs.setLayout(layout.normalise({ ...stored, compact }));
}

module.exports = { dir, files, load, ensure, sync, EXAMPLE, MODS_DIR };

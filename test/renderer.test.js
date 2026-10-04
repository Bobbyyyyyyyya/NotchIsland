'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The renderer's DOM traps.
 *
 * The renderer has no test infrastructure of its own — it is one long file that
 * touches `document` at module scope, so it cannot be required from a test. What it
 * can be is read, and the mistakes it is most likely to make are the ones a DOM
 * makes for you: a `NodeList` is not an array, and a `closest` that returns null is
 * not a node.
 *
 * These are the two that have actually bitten, so they are the two that are checked.
 */

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

test('a NodeList is never treated as an array', () => {
  // `querySelectorAll` hands back a NodeList: iterable, indexable, and nothing else.
  // `filter`, `map`, `reduce`, `some`, `every` and `find` are all Array methods, and
  // calling one of them on a NodeList throws — on every drag, in the case of the
  // layout editor, which is how a rule about room became a crash that repeated.
  const offenders = [...app.matchAll(/querySelectorAll\([^)]*\)\s*\.\s*(filter|map|reduce|some|every|find)\s*\(/g)];
  assert.deepStrictEqual(offenders.map((m) => m[1]), [],
    `querySelectorAll(...).${offenders[0]?.[1]}() is not a thing — wrap it in Array.from`);
});

test('the renderer only asks for elements the page has', () => {
  // `el` is `getElementById`, which returns null when nothing matches — and reading
  // anything off null throws at the worst possible moment. An id that is in the page
  // is always there; one that is not is a panel that is not open, a widget that is not
  // in the row, a bubble that has not been built, and those have to be checked.
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const inPage = new Set([...page.matchAll(/\bid="([A-Za-z0-9]+)"/g)].map((m) => m[1]));
  // The lookbehind matters: `openPanel('mic')` ends in `el('mic')`, and matching that
  // would be a function name, not a lookup.
  const asked = [...new Set([...app.matchAll(/(?<![A-Za-z0-9])el\('([A-Za-z0-9]+)'\)/g)].map((m) => m[1]))];
  const missing = asked.filter((id) => !inPage.has(id));
  assert.deepStrictEqual(missing, [],
    `el('${missing[0]}') is asked for but is not in the page — it is null until something puts it there`);
});

test('the counter counts what is drawn, not what is arranged', () => {
  // A widget with nothing to say — an empty clipboard, AirDrop that is not live — is
  // in the arrangement and not on the island. Counting it made the counter say 3/3
  // over a row showing one, which is a counter that lies about the row it describes.
  assert.ok(app.includes('function shownBySide'), 'and it asks what is actually there');
  const counter = app.slice(app.indexOf('function renderCount'), app.indexOf('function shownBySide'));
  assert.ok(counter.includes('shownBySide()'), 'the counter consults it');
  assert.ok(counter.includes('quiet'), 'and says how many are quiet rather than hiding it');
  // The preview keeps every slot as an item, including one that is quiet, so it can
  // still be dragged or taken out.
  const side = app.slice(app.indexOf('function layoutSide'), app.indexOf('function layoutEmpty'));
  assert.ok(side.includes('layoutSlot(id, { quiet:'), 'a quiet slot is still an item');
  const slot = app.slice(app.indexOf('function layoutSlot'), app.indexOf('function cycleWidgetSize'));
  assert.ok(slot.includes('layout-quiet'), 'and it is marked as quiet');
});

test('the arrangement cannot spill out of the app', () => {
  // The editor is a row of flexible boxes in a narrow panel. Without wrapping and
  // shrinkable items, a side with several widgets forces its arm wider than the app
  // and the rest of the row either scrolls out of reach or disappears.
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const block = (selector) => {
    // Match only a selector at the start of a line. A substring match would find a
    // qualified rule such as `.layout-side.full > .layout-arm` instead.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = styles.match(new RegExp(`(^|\\n)${escaped}\\s*{([\\s\\S]*?)\\n}`, 'm'));
    assert.ok(match, `${selector} is styled`);
    return match[2];
  };
  assert.match(block('.layout-arm'), /flex-wrap:\s*wrap/, 'an arm wraps instead of forcing the row wider');
  assert.match(block('.layout-item'), /max-width:\s*100%/, 'an item stays inside its arm');
  assert.match(block('.layout-surface'), /overflow:\s*hidden/, 'the surface clips what it cannot fit');
});

test('the layout editor only asks for things the main process sends', () => {
  // The editor reads `view.layout`, which the snapshot fills in. A key the main
  // process does not send reads as undefined, which is how a whole panel can come up
  // empty with nothing to say why.
  const layout = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'layout.js'), 'utf8');
  const sent = [...app.matchAll(/view\.layout\??\.([a-zA-Z]+)/g)].map((m) => m[1]);
  const known = ['surfaces', 'arranged', 'sizes', 'limit', 'fullness', 'profile', 'profiles'];
  for (const key of new Set(sent)) {
    assert.ok(known.includes(key), `view.layout.${key} is read but not in the list the snapshot sends`);
  }
  // And the ones the snapshot sends are the ones the layout module can answer for.
  for (const key of ['surfaces', 'arranged', 'sizes', 'limit', 'fullness']) {
    assert.ok(layout.includes(key), `the snapshot sends ${key} but layout.js has no such thing`);
  }
});

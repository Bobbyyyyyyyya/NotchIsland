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
  // The preview draws every slot too, so an empty place is a place rather than a gap.
  const side = app.slice(app.indexOf('function layoutSide'), app.indexOf('function layoutEmpty'));
  assert.ok(side.includes('layoutEmpty'), 'a slot with nothing to say is still drawn');
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

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const activities = require('../src/main/activities');
const { Updater } = require('../src/main/updater');
const { appUpdateConfig, channelManifest } = require('../tools/update-feed');

const base = {
  media: { title: '', artist: '', artwork: null, duration: 0, elapsed: 0, rate: 0 },
  input: { muted: false, active: [] },
  battery: { level: 0.5, charging: false },
  bluetooth: { devices: [] },
};

/** An electron-updater stand-in: the same events, nothing behind them. */
function fakeAutoUpdater () {
  const emitter = new (require('node:events').EventEmitter)();
  emitter.autoDownload = false;
  emitter.autoInstallOnAppQuit = true;
  emitter.quitAndInstall = (...args) => { emitter.installed = args; };
  emitter.checkForUpdates = () => { emitter.checks = (emitter.checks ?? 0) + 1; return Promise.resolve(null); };
  emitter.downloadUpdate = () => Promise.resolve([]);
  return emitter;
}

const prefs = { get: () => undefined };

// ---------------------------------------------------------------- the activity

test('an update only becomes an activity when it asks for something', () => {
  for (const state of ['idle', 'checking', 'current', 'error', 'unsupported']) {
    assert.strictEqual(activities.derive({ ...base, update: { state } }).length, 0, state);
  }
});

test('a new version opens the island with a download to ask for', () => {
  const [update] = activities.derive({ ...base, update: { state: 'available', version: '1.1.0' } });
  assert.strictEqual(update.id, 'update');
  assert.strictEqual(update.title, 'Notch Island 1.1.0');
  assert.strictEqual(update.subtitle, 'New version available');
  assert.strictEqual(update.progress, null);
});

test('a download carries its own progress', () => {
  const [update] = activities.derive({ ...base, update: { state: 'downloading', version: '1.1.0', progress: 0.42 } });
  assert.strictEqual(update.progress, 0.42);
  assert.strictEqual(update.subtitle, 'Downloading 42%');
});

test('a downloaded update reads as finished, not as started', () => {
  const [update] = activities.derive({ ...base, update: { state: 'ready', version: '1.1.0', progress: 1 } });
  assert.strictEqual(update.progress, 1);
  assert.strictEqual(update.subtitle, 'Restart to install');
});

test('the update is announced before anything else happens', () => {
  const list = activities.derive({
    ...base,
    media: { ...base.media, title: 'Hey Jude', rate: 1, duration: 200, elapsed: 50 },
    update: { state: 'ready', version: '1.1.0', progress: 1 },
  });
  assert.strictEqual(list[0].id, 'update');
});

// ---------------------------------------------------------------- the updater

test('an unpackaged launch never asks the network for anything', async () => {
  const auto = fakeAutoUpdater();
  const updater = new Updater(prefs, { autoUpdater: auto, packaged: false });
  assert.strictEqual(updater.status().state, 'unsupported');
  await updater.check();
  assert.strictEqual(auto.checks, undefined);
  assert.match(updater.status().error, /packaged/);
});

test('a check walks from checking to a version, then to downloading', async () => {
  const auto = fakeAutoUpdater();
  const updater = new Updater(prefs, { autoUpdater: auto, packaged: true });
  const seen = [];
  updater.on('status', (status) => seen.push(status.state));

  const check = updater.check();
  assert.deepStrictEqual(seen, ['checking']);
  auto.emit('update-available', { version: '1.1.0' });
  await check;
  assert.strictEqual(updater.status().version, '1.1.0');
  assert.strictEqual(updater.status().state, 'available');
  assert.ok(seen.includes('available'));

  await updater.download();
  assert.strictEqual(updater.status().state, 'downloading');
  assert.strictEqual(updater.status().progress, 0);
});

test('the very last progress step is never throttled away', async () => {
  const auto = fakeAutoUpdater();
  const updater = new Updater(prefs, { autoUpdater: auto, packaged: true });
  await updater.check();
  auto.emit('update-available', { version: '1.1.0' });

  // Two events inside the same tick: the second one is 100 % and has to land, or
  // the bar stops one step short of done and never says anything again.
  auto.emit('download-progress', { percent: 50, bytesPerSecond: 1000 });
  auto.emit('download-progress', { percent: 100, bytesPerSecond: 1000 });
  assert.strictEqual(updater.status().progress, 1);
});

test('a ready update installs and relaunches the app', async () => {
  const auto = fakeAutoUpdater();
  const updater = new Updater(prefs, { autoUpdater: auto, packaged: true });
  await updater.check();
  auto.emit('update-available', { version: '1.1.0' });
  auto.emit('update-downloaded', { version: '1.1.0' });
  assert.strictEqual(updater.status().state, 'ready');
  assert.ok(updater.install());
  assert.deepStrictEqual(auto.installed, [false, true]);

  // The app quits a moment later, which is long enough to be clicked twice, and a
  // second installer would write to the bundle the first one is replacing.
  assert.strictEqual(updater.install(), false);
  assert.deepStrictEqual(auto.installed, [false, true]);
  // Nothing is asked again either: the version on disk is the whole story.
  await updater.check();
  assert.strictEqual(auto.checks, 1);
});

test('a failed check is reported as an error, not as an update', async () => {
  const auto = fakeAutoUpdater();
  const updater = new Updater(prefs, { autoUpdater: auto, packaged: true });
  auto.emit('error', new Error('rate limited'));
  assert.strictEqual(updater.status().state, 'error');
  assert.strictEqual(updater.status().error, 'rate limited');
  assert.strictEqual(activities.updateActivity(updater.status()), null);
});

// ---------------------------------------------------------------- the feed

test('the app is told which repository to ask', () => {
  const manifest = appUpdateConfig({ owner: 'someone', repo: 'notch-island' });
  assert.match(manifest, /^provider: github$/m);
  assert.match(manifest, /^owner: someone$/m);
  assert.match(manifest, /^repo: notch-island$/m);
});

test('the release manifest lists the zip it was built from', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-feed-'));
  const zip = path.join(dir, 'Notch Island-darwin-arm64.zip');
  fs.writeFileSync(zip, Buffer.from('not a real zip, but it has a length'));
  const manifest = channelManifest({ zip, version: '1.2.3' });

  assert.match(manifest, /^version: 1\.2\.3$/m);
  assert.match(manifest, /url: Notch Island-darwin-arm64\.zip/);
  assert.match(manifest, /^path: Notch Island-darwin-arm64\.zip$/m);
  assert.match(manifest, /sha512: [\w+/=]+/);
  // The size has to be the size of the file that is uploaded, not of the app it
  // came from, or the download is thrown away after it finishes.
  assert.match(manifest, new RegExp(`size: ${fs.statSync(zip).size}\\b`));

  fs.rmSync(dir, { recursive: true, force: true });
});

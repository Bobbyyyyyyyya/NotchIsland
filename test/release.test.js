'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The release wiring.
 *
 * A build is only as releasable as its configuration: an unsigned DMG gets the
 * Gatekeeper warning, an unnotarized one too, and a bundle without the media
 * adapter has no transport controls. None of that can be seen without running
 * a full `make`, so the parts that decide it are checked here instead — with
 * the secrets cleared, because a checkout without them must stay buildable
 * (unsigned) rather than fail.
 */

const CONFIG = path.join(__dirname, '..', 'forge.config.js');

function loadFresh () {
  delete require.cache[require.resolve(CONFIG)];
  return require(CONFIG);
}

function withoutSecrets (run) {
  const names = ['APPLE_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

test('a checkout without secrets builds with an ad-hoc signature', () => {
  const config = withoutSecrets(loadFresh);
  assert.strictEqual(config.packagerConfig.osxSign.identity, '-', 'no identity, ad-hoc still signs');
  assert.strictEqual(config.packagerConfig.osxSign.hardenedRuntime, false, 'ad-hoc cannot ask for hardened runtime');
  assert.ok(!config.packagerConfig.osxNotarize, 'no credentials, no notarization');
});

test('an identity signs hardened with the repo entitlements', () => {
  const saved = process.env.APPLE_IDENTITY;
  process.env.APPLE_IDENTITY = 'Developer ID Application: Example (TEAMID)';
  let config;
  try {
    config = loadFresh();
  } finally {
    if (saved === undefined) delete process.env.APPLE_IDENTITY;
    else process.env.APPLE_IDENTITY = saved;
  }
  const sign = config.packagerConfig.osxSign;
  assert.ok(sign && typeof sign === 'object', 'signing switches on');
  assert.strictEqual(sign.identity, 'Developer ID Application: Example (TEAMID)');
  assert.strictEqual(sign.hardenedRuntime, true, 'notarization refuses anything softer');
  assert.ok(fs.existsSync(sign.entitlements), 'the entitlements it names are in the repo');
});

test('Apple ID credentials switch notarization on', () => {
  const saved = {
    APPLE_ID: process.env.APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
  };
  process.env.APPLE_ID = 'person@example.com';
  process.env.APPLE_APP_SPECIFIC_PASSWORD = 'aaaa-bbbb-cccc-dddd';
  process.env.APPLE_TEAM_ID = 'TEAMID';
  let config;
  try {
    config = loadFresh();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const notarize = config.packagerConfig.osxNotarize;
  assert.ok(notarize && typeof notarize === 'object', 'notarization switches on');
  assert.strictEqual(notarize.teamId, 'TEAMID');
});

test('the bundle carries everything the app runs', () => {
  const config = withoutSecrets(loadFresh);
  const resources = (config.packagerConfig.extraResource ?? []).map((entry) => String(entry));
  assert.ok(resources.some((entry) => entry.endsWith(`${path.sep}helper`)), 'the helper source, compiled on first run');
  assert.ok(resources.some((entry) => entry.endsWith(`${path.sep}mediaremote`)), 'the media adapter, or packaged builds lose transport controls');
  const makers = config.makers.map((maker) => maker.name);
  assert.ok(makers.includes('@electron-forge/maker-dmg'), 'the DMG people download');
  assert.ok(makers.includes('@electron-forge/maker-zip'), 'the zip the updater feeds on');
});

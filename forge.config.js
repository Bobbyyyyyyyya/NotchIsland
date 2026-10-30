const path = require('node:path');
const { repository } = require('./tools/update-feed');

const feed = repository();

/**
 * Signing and notarization are what keep Gatekeeper quiet about the DMG.
 * Everything secret comes from the environment so none of it can end up in
 * the repository: a local build without them stays unsigned, exactly like now.
 *
 *   APPLE_IDENTITY                'Developer ID Application: … (TEAMID)'
 *   APPLE_ID                      the Apple ID that notarizes
 *   APPLE_APP_SPECIFIC_PASSWORD   an app-specific password for it
 *   APPLE_TEAM_ID                 the Developer ID team
 *
 * …or, for CI, an App Store Connect API key instead of the password triple:
 *
 *   APPLE_API_KEY                 path to the .p8 file
 *   APPLE_API_KEY_ID              the key id
 *   APPLE_API_ISSUER              the issuer id
 */
const identity = process.env.APPLE_IDENTITY || null;
const notarizePassword = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
  ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    }
  : null;
const notarizeKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  ? {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    }
  : null;

/**
 * @type {import('@electron-forge/cli').ForgeConfig}
 */
module.exports = {
  packagerConfig: {
    name: 'Notch Island',
    executableName: 'notch-island',
    appBundleId: 'nl.notchisland.app',
    appCategoryType: 'public.app-category.utilities',
    icon: path.join(__dirname, 'assets', 'icon'),
    // The helper is compiled on first run, so its source travels with the app.
    // The media adapter travels too: without it a packaged build has no
    // transport controls at all.
    extraResource: [
      path.join(__dirname, 'tools', 'helper'),
      path.join(__dirname, 'tools', 'mediaremote'),
    ],
    // Compiles the helper and the MediaRemote adapter into Resources, so a
    // released build runs without the Xcode Command Line Tools on the user's
    // Mac. A build where clang is missing still ships, pieces and all.
    afterCopy: [
      require('./tools/build-native').afterCopyHook,
    ],
    extendInfo: {
      NSAppleEventsUsageDescription:
        'Notch Island needs Apple Events permission to control your music player.',
      NSMicrophoneUsageDescription:
        'Notch Island needs microphone access to show and toggle microphone input.',
      LSUIElement: true,
    },
    // Registers notch-island:// in the packaged app, so other programs can
    // open panels, toast a line and start timers with a URL.
    protocols: [{ name: 'Notch Island URL', schemes: ['notch-island'] }],
    // Without a real identity we still want a signature: unsigned apps are
    // what Gatekeeper greets with “…is damaged”. `-` asks codesign for an
    // ad-hoc signature, which is enough for the app to open with the normal
    // right-click → Open prompt.
    osxSign: identity
      ? {
          identity,
          hardenedRuntime: true,
          entitlements: path.join(__dirname, 'entitlements.plist'),
          'entitlements-inherit': path.join(__dirname, 'entitlements.plist'),
        }
      : {
          identity: '-',
          identityValidation: false,
          hardenedRuntime: false,
        },
    osxNotarize: notarizeKey ?? notarizePassword ?? undefined,
  },
  rebuildConfig: {},
  hooks: {
    /**
     * The DMG that ships from this machine has to open on a Mac that never saw
     * it before. Packager's ad-hoc signing left the framework and the main
     * executable with signatures macOS refused to load together ("different
     * Team IDs"), so the app died at launch with nothing on screen. Re-signing
     * the whole bundle in one pass makes the signatures agree, which is what
     * Gatekeeper and the loader both want.
     */
    postPackage: async (_forgeConfig, { platform, outputPaths }) => {
      const { execFileSync } = require('node:child_process');
      const fs = require('node:fs');
      if (platform !== 'darwin') return;
      for (const out of outputPaths) {
        // Forge hands over the versioned directory; the bundle to sign is the
        // .app inside it — or the path itself when it already is one.
        const apps = out.endsWith('.app')
          ? [out]
          : fs.readdirSync(out).filter((name) => name.endsWith('.app')).map((name) => path.join(out, name));
        for (const appPath of apps) {
          execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
        }
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      format: 'ULFO',
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        // `owner`/`name` are Forge's names for the repository; without them the
        // publisher says so itself, which is the right thing to happen to a
        // checkout that has never been published.
        repository: feed ? { owner: feed.owner, name: feed.repo } : undefined,
        // A draft release is invisible to the updater: it reads the atom feed of
        // published releases only. Publishing has to be the end of `npm run
        // dist`, not a follow-up click in a browser.
        draft: false,
        prerelease: false,
        generateReleaseNotes: true,
      },
    },
  ],
  plugins: [
    // Writes app-update.yml into the build and latest-mac.yml into the release.
    { name: './tools/forge-plugin-update-feed', config: {} },
  ],
};


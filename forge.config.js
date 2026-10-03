const path = require('node:path');
const { repository } = require('./tools/update-feed');

const feed = repository();

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
    extraResource: [path.join(__dirname, 'tools', 'helper')],
    extendInfo: {
      NSAppleEventsUsageDescription:
        'Notch Island needs Apple Events permission to control your music player.',
      NSMicrophoneUsageDescription:
        'Notch Island needs microphone access to show and toggle microphone input.',
      LSUIElement: true,
    },
    osxSign: false,
  },
  rebuildConfig: {},
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


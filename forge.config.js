const path = require('node:path');

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
  plugins: [],
};

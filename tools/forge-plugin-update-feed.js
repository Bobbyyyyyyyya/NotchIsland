'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { appUpdateConfig, channelManifest, repository } = require('./update-feed');

/**
 * Teaches Forge about the update feed.
 *
 * Two hooks, one idea. Before the app is finished, `app-update.yml` goes into the
 * bundle so a built copy knows where to look. After everything is made,
 * `latest-mac.yml` is written next to the mac zip and pushed onto the make
 * result, which is how it becomes a release asset the next launch can find.
 *
 * It has to be a `postMake` hook and not a maker: Forge runs makers
 * concurrently, so there is no maker that can count on the zip already existing.
 */
class UpdateFeedPlugin {
  name = 'update-feed';
  // Forge 8 treats instances carrying this marker as ready-made plugins and
  // skips its module resolution, which wants devDependencies-style packages.
  __isElectronForgePlugin = true;

  constructor (config = {}) {
    this.config = config;
  }

  init (dir, forgeConfig) {
    this.dir = dir;
    this.forgeConfig = forgeConfig;
  }

  getHooks () {
    return {
      packageAfterCopy: async (_config, buildPath, _electronVersion, _platform, _arch) => this.writeAppConfig(buildPath),
      postMake: async (_forgeConfig, makeResults) => this.writeChannelFile(makeResults),
    };
  }

  /**
   * Forge hands over the app folder, for instance
   * `Notch Island.app/Contents/Resources/app`: the updater reads
   * `app-update.yml` from the Resources folder one level up.
   */
  async writeAppConfig (buildPath) {
    const feed = repository();
    if (!feed) {
      // Packaging is also what a developer does to look at their own build, and
      // that has to keep working without a remote. The app simply has no feed.
      console.warn('[update-feed] no GitHub repository found, the build will not update itself');
      return;
    }
    const target = path.join(path.dirname(path.resolve(buildPath)), 'app-update.yml');
    await fs.writeFile(target, appUpdateConfig(feed));
    console.log(`[update-feed] ${path.relative(process.cwd(), target)} → ${feed.owner}/${feed.repo}`);
  }

  async writeChannelFile (makeResults) {
    const feed = repository();
    if (!feed) {
      throw new Error('Cannot publish an update feed: no GitHub repository is configured. Add an origin remote or set GITHUB_REPOSITORY.');
    }
    for (const result of makeResults) {
      if (result.platform !== 'darwin') continue;
      const zip = result.artifacts.find((artifact) => artifact.endsWith('.zip'));
      if (!zip) continue;
      const target = path.join(path.dirname(zip), 'latest-mac.yml');
      await fs.writeFile(target, channelManifest({ zip, version: result.packageJSON.version }));
      result.artifacts.push(target);
      console.log(`[update-feed] ${path.relative(process.cwd(), target)}`);
    }
  }
}

module.exports = UpdateFeedPlugin;

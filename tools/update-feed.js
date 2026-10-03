'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * The update feed.
 *
 * electron-updater finds a new version by reading `latest-mac.yml` off the latest
 * GitHub release, and a packaged build learns where to look from `app-update.yml`
 * inside its own bundle. Forge's GitHub publisher uploads whatever the makers
 * produced and knows nothing about either file, so both are written here:
 *
 *   - `appUpdateConfig()`  goes into `Contents/Resources` before the app is
 *     finished, which is where the updater looks for it.
 *   - `channelManifest()`  goes next to the zip and is published as a release
 *     asset, which is where the updater looks for the next version.
 *
 * Everything here is a plain function so the format can be tested without running
 * a build.
 */

/**
 * The GitHub repository that releases are published to and checked against.
 *
 * `GITHUB_REPOSITORY` wins because a release workflow knows its own repository
 * without asking git; otherwise the origin remote is read. A checkout without a
 * remote is a real state for a project that has not been published yet, so this
 * returns null and the caller decides whether that is worth a warning.
 *
 * @returns {{ owner: string, repo: string } | null}
 */
function repository () {
  const value = process.env.GITHUB_REPOSITORY ?? origin();
  if (!value) return null;
  const [owner, repo] = value.trim().replace(/\.git$/, '').replace(/^git\+/, '').split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** `owner/repo` out of the origin remote, or null when there is none to ask. */
function origin () {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = url.match(/github\.com[:/]([^/]+)\/(.+)$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * The manifest that ships inside the app. This is the only thing that tells a
 * built copy of Notch Island which repository to ask; without it the updater has
 * nothing to go on and refuses to do anything.
 */
function appUpdateConfig (feed) {
  return [
    'provider: github',
    `owner: ${feed.owner}`,
    `repo: ${feed.repo}`,
    // The cache lives beside the download helper's other state; naming it keeps
    // the folder stable when the product name changes.
    'updaterCacheDirName: notch-island-updater',
    '',
  ].join('\n');
}

/**
 * The manifest a release publishes. electron-updater reads the file list, and
 * hashes the zip it downloads against it, so the digest has to be the one of the
 * artifact that was actually uploaded — which is why the plugin computes this
 * after `make`, from the zip on disk, rather than from the app it was built from.
 *
 * @param {object} options
 * @param {string} options.zip absolute path to the mac zip
 * @param {string} options.version the version being released
 */
function channelManifest ({ zip, version }) {
  const buffer = fs.readFileSync(zip);
  const sha512 = crypto.createHash('sha512').update(buffer).digest('base64');
  const url = path.basename(zip);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${buffer.byteLength}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
}

module.exports = { repository, appUpdateConfig, channelManifest };

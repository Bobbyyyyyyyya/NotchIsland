'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { FRAMEWORKS } = require('../src/main/helper');
const { ADAPTER_SOURCES } = require('../src/main/media-remote');

/**
 * Compiles the native pieces into the app's Resources at build time.
 *
 * Shipping prebuilt means the user's Mac does not need the Xcode Command Line
 * Tools at all — the runner that made the release always has clang, so that is
 * where the compile belongs. At runtime a prebuilt binary is used as-is; the
 * compile-on-first-run path in `helper.js` and `media-remote.js` remains as the
 * fallback for builds made without a toolchain (and for development).
 *
 * The flags mirror what the runtime compile in `helper.js` and
 * `media-remote.js` does, and everything is signed ad hoc so a quarantined copy
 * still runs.
 */
const CLANG = '/usr/bin/clang';

function buildNativeResources (resourcesDir) {
  if (!fs.existsSync(CLANG)) return null;

  const sourceRoot = path.join(__dirname);
  const helperSource = path.join(sourceRoot, 'helper', 'NotchHelper.m');
  const mediaRoot = path.join(sourceRoot, 'mediaremote');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';

  // -- the helper ------------------------------------------------------------
  const helperDir = path.join(resourcesDir, 'helper-prebuilt');
  fs.mkdirSync(helperDir, { recursive: true });
  const helperBinary = path.join(helperDir, 'NotchHelper');
  if (!fs.existsSync(helperSource)) throw new Error(`native build: missing ${helperSource}`);
  execFileSync(CLANG, [
    '-fobjc-arc', '-O2', '-w',
    ...FRAMEWORKS,
    helperSource, '-o', helperBinary,
  ], { stdio: 'pipe' });
  execFileSync('codesign', ['--force', '--sign', '-', helperBinary], { stdio: 'pipe' });

  // -- the MediaRemote adapter framework -------------------------------------
  const frameworkDir = path.join(resourcesDir, 'mediaremote-prebuilt', 'MediaRemoteAdapter.framework');
  const binaryDir = path.join(frameworkDir, 'Versions', 'A');
  fs.mkdirSync(path.join(binaryDir, 'Headers'), { recursive: true });
  fs.mkdirSync(path.join(binaryDir, 'Resources'), { recursive: true });
  const binary = path.join(binaryDir, 'MediaRemoteAdapter');

  const sources = ADAPTER_SOURCES.map((file) => path.join(mediaRoot, 'src', file));
  for (const source of sources) {
    if (!fs.existsSync(source)) throw new Error(`native build: missing ${source}`);
  }
  execFileSync(CLANG, [
    '-arch', arch,
    '-fobjc-arc', '-fvisibility=default', '-O2', '-w',
    '-I', path.join(mediaRoot, 'include'),
    '-I', path.join(mediaRoot, 'src'),
    ...sources,
    '-dynamiclib', '-o', binary,
    '-framework', 'Foundation',
    '-framework', 'AppKit',
    '-framework', 'UniformTypeIdentifiers',
    '-install_name', '@rpath/MediaRemoteAdapter.framework/Versions/A/MediaRemoteAdapter',
  ], { stdio: 'pipe' });

  // A versioned framework layout, identical to what the runtime build checks in.
  fs.copyFileSync(path.join(mediaRoot, 'include', 'MediaRemoteAdapter.h'),
    path.join(binaryDir, 'Headers', 'MediaRemoteAdapter.h'));
  for (const [link, target] of [
    ['Versions/Current', 'A'],
    ['MediaRemoteAdapter', 'Versions/Current/MediaRemoteAdapter'],
    ['Headers', 'Versions/Current/Headers'],
    ['Resources', 'Versions/Current/Resources'],
  ]) {
    const at = path.join(frameworkDir, link);
    try { fs.unlinkSync(at); } catch {}
    fs.symlinkSync(target, at);
  }
  fs.chmodSync(helperBinary, 0o755);
  fs.chmodSync(binary, 0o755);
  execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'pipe' });

  return { helper: helperBinary, framework: frameworkDir };
}

/**
 * A Forge afterCopy hook: the app folder handed to the hook is
 * `Notch Island.app/Contents/Resources/app`, so its parent is the Resources
 * directory the prebuilt helpers belong in.
 */
function afterCopyHook (buildPath) {
  try {
    const resources = path.dirname(buildPath);
    return buildNativeResources(resources);
  } catch (error) {
    // A build without native pieces must still ship: the runtime keeps its
    // compile-on-first-run fallback, and `console.warn` is loud enough here.
    console.warn(`[native] prebuilt resources skipped: ${error.message}`);
    return null;
  }
}

module.exports = { buildNativeResources, afterCopyHook };

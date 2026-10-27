'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { app } = require('electron');

/**
 * Now playing information for macOS 15.4 and up.
 *
 * Since macOS 15.4 `mediaremoted` refuses every client whose bundle identifier
 * does not start with `com.apple.`, so loading MediaRemote from inside this app
 * returns `kMRMediaRemoteFrameworkErrorDomain Code=3` and the now playing feed
 * stays empty. Signing the app does not help; the check is on the bundle id.
 *
 * `ungive/mediaremote-adapter` (BSD-3-Clause, see `tools/mediaremote/LICENSE`)
 * gets around that by letting a system platform binary do the talking:
 * `/usr/bin/perl` is reported to mediaremoted as `com.apple.perl5` and is
 * therefore allowed. The framework the script dlopens is ours, the connection
 * is perl's. The sources are vendored in `tools/mediaremote` and compiled into
 * the user-data directory on first run, exactly like the helper.
 */

const CLANG = '/usr/bin/clang';
const PERL = '/usr/bin/perl';

/** How long a blocked handover may keep the previous app on screen. */
const HANDOVER_GRACE_MS = 5000;

const ADAPTER_SOURCES = [
  'adapter/elected.m',
  'adapter/env.m',
  'adapter/get.m',
  'adapter/globals.m',
  'adapter/keys.m',
  'adapter/now_playing.m',
  'adapter/probe.m',
  'adapter/repeat.m',
  'adapter/seek.m',
  'adapter/send.m',
  'adapter/shuffle.m',
  'adapter/speed.m',
  'adapter/stream.m',
  'adapter/test.m',
  'private/MediaRemote.m',
  'utility/Debounce.m',
  'utility/helpers.m',
];

// kMRCommand ids from the adapter's documented table.
const COMMAND_IDS = {
  play: 0,
  pause: 1,
  togglePlayPause: 2,
  stop: 3,
  next: 4,
  previous: 5,
};

const APP_NAMES = {
  'com.apple.Music': 'Music',
  'com.apple.iTunes': 'Music',
  'com.apple.podcasts': 'Podcasts',
  'com.spotify.client': 'Spotify',
  'com.apple.TV': 'TV',
  'com.apple.QuickTimePlayerX': 'QuickTime Player',
  'com.apple.Safari': 'Safari',
  'com.google.Chrome': 'Chrome',
  'com.microsoft.edgemac': 'Edge',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.Browser': 'Brave',
  'com.vlc.vlc': 'VLC',
  'com.duckduckgo.macos.browser': 'DuckDuckGo',
  'com.operasoftware.Opera': 'Opera',
  'company.thebrowser.Browser': 'Arc',
  'com.kagi.kagimacOS': 'Kagi',
  'com.agilebits.onepassword7': '1Password',
};

/**
 * A readable player name. Media from a web page reports itself as
 * `com.apple.WebKit.GPU`, so the parent bundle id is the one worth naming.
 */
function appNameFor (bundleId) {
  if (!bundleId) return null;
  if (APP_NAMES[bundleId]) return APP_NAMES[bundleId];
  const last = String(bundleId).split('.').pop();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : null;
}

class MediaRemoteBridge extends EventEmitter {
  constructor () {
    super();
    this.process = null;
    this.available = false;
    this.reason = 'starting';
    this.current = {};
    this._restarts = 0;
    this._stopping = false;
    this._launching = false;
    this._trackKey = null;
    this._artworkKey = null;
    this._handoverTimer = null;
    this._commandErrorLogged = false;
  }

  get sourceRoot () {
    const packaged = path.join(process.resourcesPath, 'mediaremote');
    return fs.existsSync(packaged)
      ? packaged
      : path.join(app.getAppPath(), 'tools', 'mediaremote');
  }

  get scriptPath () {
    return path.join(this.sourceRoot, 'bin', 'mediaremote-adapter.pl');
  }

  get frameworkPath () {
    return path.join(app.getPath('userData'), 'helper', 'MediaRemoteAdapter.framework');
  }

  get binaryPath () {
    return path.join(this.frameworkPath, 'Versions', 'A', 'MediaRemoteAdapter');
  }

  /**
   * Builds the adapter framework from the vendored sources, when stale. The
   * compile is async on purpose: clang costs seconds on a cold cache, and
   * blocking the main process for those froze the whole island at launch.
   */
  build () {
    if (!fs.existsSync(CLANG)) throw new Error('clang is not installed (install the Xcode Command Line Tools)');
    if (!fs.existsSync(this.scriptPath)) throw new Error(`adapter script missing at ${this.scriptPath}`);

    const sources = ADAPTER_SOURCES.map((file) => path.join(this.sourceRoot, 'src', file));
    for (const source of sources) {
      if (!fs.existsSync(source)) throw new Error(`adapter source missing at ${source}`);
    }

    const binary = this.binaryPath;
    const newest = Math.max(...sources.map((file) => fs.statSync(file).mtimeMs),
      fs.statSync(path.join(this.sourceRoot, 'include', 'MediaRemoteAdapter.h')).mtimeMs);
    const needsBuild = !fs.existsSync(binary) || newest > fs.statSync(binary).mtimeMs;
    if (!needsBuild) return Promise.resolve(binary);

    fs.mkdirSync(path.dirname(binary), { recursive: true });
    const frameworkDir = path.dirname(path.dirname(path.dirname(binary)));
    fs.mkdirSync(path.join(frameworkDir, 'Versions', 'A', 'Headers'), { recursive: true });
    fs.mkdirSync(path.join(frameworkDir, 'Versions', 'A', 'Resources'), { recursive: true });

    return new Promise((resolve, reject) => {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      const result = spawn(CLANG, [
        '-arch', arch,
        '-fobjc-arc', '-fvisibility=default', '-O2', '-w',
        '-I', path.join(this.sourceRoot, 'include'),
        '-I', path.join(this.sourceRoot, 'src'),
        ...sources,
        '-dynamiclib', '-o', binary,
        '-framework', 'Foundation',
        '-framework', 'AppKit',
        '-framework', 'UniformTypeIdentifiers',
        '-install_name', '@rpath/MediaRemoteAdapter.framework/Versions/A/MediaRemoteAdapter',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      result.stderr.on('data', (chunk) => { stderr += chunk; });
      result.on('error', (error) => reject(new Error(`adapter build failed: ${error.message}`)));
      result.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`adapter build failed: ${(stderr || '').split('\n').slice(-3).join(' ')}`));
          return;
        }

        // A versioned framework layout, which is what the script expects to find.
        try {
          fs.copyFileSync(path.join(this.sourceRoot, 'include', 'MediaRemoteAdapter.h'),
            path.join(frameworkDir, 'Versions', 'A', 'Headers', 'MediaRemoteAdapter.h'));
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
          fs.chmodSync(binary, 0o755);
          resolve(binary);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  start () {
    if (this.process || this._launching) return;
    this._stopping = false;
    this._launching = true;
    this.build()
      .then((binary) => {
        this._launching = false;
        // A stop() that ran while clang was busy must not leave a child behind.
        if (this.process || this._stopping) return;
        this._spawn(binary);
      })
      .catch((error) => {
        this._launching = false;
        this._setStatus(false, error.message);
        console.warn('[media] unavailable:', error.message);
      });
  }

  _spawn (binary) {
    const child = spawn(PERL, [
      this.scriptPath, this.frameworkPath, 'stream', '--debounce=150',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child;
    this._launching = false;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === 'data') this._ingest(message);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn('[media]', text);
    });
    child.on('exit', (code) => {
      this.process = null;
      if (this._stopping) return;
      // The script only exits non-zero when the adapter stopped working, which
      // is worth reporting instead of silently showing an empty player.
      this._setStatus(false, `adapter exited (${code})`);
      if (this._restarts < 3) {
        this._restarts += 1;
        setTimeout(() => this.start(), 2000 * this._restarts);
      }
    });
    this._restarts = 0;
    this._setStatus(true, null);
  }

  _setStatus (available, reason) {
    this.available = available;
    this.reason = reason;
    this.emit('status', this.status());
  }

  /**
   * Merges one streamed payload. With `diff` set the payload only carries the
   * keys that changed, and a `null` value means the key went away.
   */
  _ingest (message) {
    const payload = message.payload ?? {};
    const hadArtwork = Object.prototype.hasOwnProperty.call(payload, 'artworkData');

    // mediaremoted only ever hands out the app that registered last, not the
    // one that is audible, and a page full of media elements registers a lot.
    // A playing entry is therefore given up only to something that is playing
    // as well, or to its own app going quiet. The adapter publishes that final
    // state itself when a client loses the election, so the normal handover
    // needs no grace period at all; the timer only covers the case where that
    // update never arrives, which would otherwise freeze the screen on a track
    // that has already ended.
    if (this.current.playing && this.current.title) {
      const title = 'title' in payload ? payload.title : this.current.title;
      const playing = 'playing' in payload ? payload.playing : this.current.playing;
      const bundle = 'bundleIdentifier' in payload ? payload.bundleIdentifier : this.current.bundleIdentifier;
      const foreign = bundle !== this.current.bundleIdentifier;
      // A payload that says something is playing always wins, even when the
      // application reports no title: a page playing sound usually has none,
      // and dropping that frame is what made the player fold while the sound
      // kept going. Only a payload that is silent has to wait out the grace
      // period, so a track change with a beat of silence in between does not
      // clear the screen either.
      if (!playing && (foreign || !title)) {
        if (this._handoverTimer == null) {
          this._handoverTimer = setTimeout(() => {
            this._handoverTimer = null;
            if (this.current.playing && this.current.title) {
              this.current.playing = false;
              this.current.playbackRate = 0;
              this.emit('event', this._toMessage());
            }
          }, HANDOVER_GRACE_MS);
        }
        return;
      }
    }
    if (this._handoverTimer != null) {
      clearTimeout(this._handoverTimer);
      this._handoverTimer = null;
    }

    if (message.diff) {
      for (const [key, value] of Object.entries(payload)) {
        if (value === null) delete this.current[key];
        else this.current[key] = value;
      }
    } else {
      this.current = { ...payload };
    }

    const current = this.current;
    const trackKey = current.uniqueIdentifier ?? current.contentItemIdentifier ?? current.title ?? null;
    // MediaRemote hands over the cover before the title as often as after it, so
    // the cover is tied to the title it arrived under: that is the only thing
    // that tells a leftover from the previous track apart from one that is early.
    const artworkHere = typeof current.artworkData === 'string' && current.artworkData.length > 0;

    if (trackKey !== this._trackKey) {
      this._trackKey = trackKey;
      // A track change drops the previous cover, but only one that has already
      // been seen under a *different* title. A cover that arrived before its own
      // title has no title to be stale against, and throwing it away is how a
      // song that does have artwork ends up with none for as long as the adapter
      // does not happen to send it again.
      if (!hadArtwork && this._artworkKey !== null && this._artworkKey !== trackKey) {
        delete current.artworkData;
        this._artworkKey = null;
      }
    }

    if (artworkHere) this._artworkKey = trackKey;
    else if (!current.artworkData) this._artworkKey = null;

    this.emit('event', this._toMessage());
  }

  _toMessage () {
    const current = this.current;
    const base = {
      event: 'nowPlaying',
      via: 'adapter',
      empty: true,
      title: '',
      artist: '',
      album: '',
      artworkData: null,
      duration: 0,
      elapsed: 0,
      rate: 0,
      state: 0,
      source: '',
      preferredApp: null,
    };
    if (!current.title) return base;

    const playing = Boolean(current.playing);
    const rate = current.playbackRate > 0 ? current.playbackRate : 1;
    let artworkData = null;
    if (typeof current.artworkData === 'string' && current.artworkData.length) {
      artworkData = `data:${current.artworkMimeType || 'image/jpeg'};base64,${current.artworkData}`;
    }

    return {
      ...base,
      empty: false,
      title: current.title ?? '',
      artist: current.artist ?? '',
      album: current.album ?? '',
      artworkData,
      duration: current.duration ?? 0,
      elapsed: current.elapsedTime ?? 0,
      rate: playing ? rate : 0,
      state: playing ? 1 : 0,
      source: current.bundleIdentifier ?? '',
      preferredApp: appNameFor(current.parentApplicationBundleIdentifier || current.bundleIdentifier),
    };
  }

  /**
   * Runs one transport command. Each call is a separate process because the
   * script has no stdin protocol, so it answers and exits.
   */
  command (name, value) {
    if (!this.available || !fs.existsSync(this.scriptPath)) return false;

    const args = name === 'seek'
      ? ['seek', String(Math.max(0, Math.round(Number(value ?? 0) * 1e6)))]
      : COMMAND_IDS[name] !== undefined ? ['send', String(COMMAND_IDS[name])] : null;
    if (!args) return false;
    // Aim the command at the application the player is showing. Without a
    // target it reaches whatever MediaRemote has in front, which on a Mac that
    // runs a browser next to the music is usually the browser.
    if (args[0] === 'send' && typeof this.current.bundleIdentifier === 'string'
        && this.current.bundleIdentifier) {
      args.push(this.current.bundleIdentifier);
    }

    const child = spawn(PERL, [this.scriptPath, this.frameworkPath, ...args],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text && !this._commandErrorLogged) {
        this._commandErrorLogged = true;
        console.warn('[media] command failed:', text);
      }
    });
    child.on('error', () => {});
    return true;
  }

  status () {
    return { available: this.available, reason: this.reason, compiled: fs.existsSync(this.binaryPath) };
  }

  stop () {
    this._stopping = true;
    if (this._handoverTimer != null) clearTimeout(this._handoverTimer);
    this._handoverTimer = null;
    try { this.process?.stdout?.removeAllListeners('data'); } catch {}
    this.process?.kill('SIGTERM');
    this.process = null;
    this.available = false;
  }
}

module.exports = { MediaRemoteBridge };

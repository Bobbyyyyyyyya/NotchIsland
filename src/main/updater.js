'use strict';

const { EventEmitter } = require('node:events');
const { app } = require('electron');

/**
 * The auto-updater.
 *
 * electron-updater does the talking; this module decides when to talk. The island
 * already has one way of announcing that something happened — a live activity —
 * so every state the updater can be in is flattened into a single plain status
 * object, and `activities.derive` turns that into a bubble and a panel. The
 * renderer never touches the updater itself: it reads the status out of the
 * snapshot and fires named actions, like everything else.
 *
 * A check happens once per launch and the download follows it silently. The app
 * is a menu bar extra that is rarely quit, so an update that only lands on quit
 * would take days to arrive; the island says "restart to install" instead and the
 * user decides when. Quitting normally still installs it, because
 * `autoInstallOnAppQuit` is left on.
 */

const REASON_UNPACKAGED = 'Only the packaged app can update itself';

/**
 * Progress arrives far faster than anyone can read it, and every event ends in a
 * full state push to the renderer. A download is a few hundred kilobytes per
 * second of noise, so it is throttled to this and then always given a last word.
 */
const PROGRESS_MIN_MS = 200;

class Updater extends EventEmitter {
  /**
   * @param {object} prefs the preferences module
   * @param {object} [options]
   * @param {object} [options.autoUpdater] a stand-in for electron-updater's
   * @param {boolean} [options.packaged] whether this is a real build
   */
  constructor (prefs, { autoUpdater, packaged } = {}) {
    super();
    this.prefs = prefs;
    this.packaged = packaged ?? Boolean(app?.isPackaged);
    this._auto = null;
    this._wired = false;
    this._installing = false;
    if (autoUpdater) {
      this._auto = autoUpdater;
      this._wire(autoUpdater);
    }
    this._lastProgressAt = 0;
    this._status = {
      /** idle | checking | available | downloading | ready | current | error | unsupported */
      state: this.packaged ? 'idle' : 'unsupported',
      version: null,
      /** 0…1 while downloading, 1 once the update is on disk. */
      progress: null,
      speed: 0,
      error: null,
      checkedAt: 0,
    };
  }

  /** The status as the snapshot carries it. */
  status () {
    return { ...this._status };
  }

  /** True while there is a download or an install the user can act on. */
  get busy () {
    return this._status.state === 'checking' || this._status.state === 'downloading';
  }

  /**
   * electron-updater exports one singleton and pulls in the whole network stack
   * with it, so it is only required once there is a reason to. Requiring it in a
   * development launch would work, but there is nothing there to update.
   */
  client () {
    if (!this._auto) {
      this._auto = require('electron-updater').autoUpdater;
      this._wire(this._auto);
    }
    return this._auto;
  }

  /** Called once per launch, shortly after the island is up. */
  start ({ delayMs = 8000 } = {}) {
    if (!this.packaged) return;
    if (this.prefs.get('updates.autoCheck') === false) return;
    // Not on the first tick: a launch is the moment the machine is busiest with
    // login items, and the answer is not needed that soon.
    const timer = setTimeout(() => this.check(), delayMs);
    timer.unref?.();
  }

  /** Looks for a newer release. Safe to call from the tray or the settings panel. */
  check () {
    if (!this.packaged) {
      this._set({ state: 'unsupported', error: REASON_UNPACKAGED });
      return Promise.resolve(null);
    }
    // A check that is already running would be thrown away by electron-updater
    // anyway, and an update on disk must not be looked past.
    if (this.busy || this._status.state === 'ready') return Promise.resolve(null);

    const updater = this.client();
    updater.autoDownload = this.prefs.get('updates.autoDownload') !== false;
    this._set({ state: 'checking', error: null, progress: null });
    return updater.checkForUpdates().catch(() => null);
  }

  /** Downloads a release that was found but not fetched automatically. */
  download () {
    if (this._status.state !== 'available') return Promise.resolve(null);
    this._set({ state: 'downloading', progress: 0 });
    return this.client().downloadUpdate().catch(() => null);
  }

  /**
   * Hands the app over to the installer and starts the new version. A menu bar
   * app has no window to reopen, but without it the user would have to find the
   * icon themselves after quitting.
   *
   * The app quits on its own a moment later, which is long enough for a double
   * click to ask twice; the installer replaces the app in place, so the second
   * attempt would be a second installer writing to the same bundle.
   */
  install () {
    if (this._status.state !== 'ready' || this._installing) return false;
    this._installing = true;
    this.client().quitAndInstall(false, true);
    return true;
  }

  _wire (updater) {
    if (this._wired) return;
    this._wired = true;

    updater.autoDownload = this.prefs.get('updates.autoDownload') !== false;
    updater.autoInstallOnAppQuit = true;

    updater.on('checking-for-update', () => {
      this._set({ state: 'checking', error: null });
    });

    updater.on('update-available', (info) => {
      this._set({ state: 'available', version: info?.version ?? null, error: null, progress: null });
    });

    updater.on('update-not-available', () => {
      this._set({ state: 'current', version: null, error: null, progress: null, checkedAt: Date.now() });
    });

    updater.on('download-progress', (progress) => {
      const percent = Math.min(Math.max(progress?.percent ?? 0, 0), 100);
      const now = Date.now();
      // The last tenth percent is always let through, so the bar cannot stop
      // one step short of done.
      if (percent < 100 && now - this._lastProgressAt < PROGRESS_MIN_MS) return;
      this._lastProgressAt = now;
      this._set({ state: 'downloading', progress: percent / 100, speed: progress?.bytesPerSecond ?? 0 });
    });

    updater.on('update-downloaded', (info) => {
      this._set({ state: 'ready', version: info?.version ?? this._status.version, progress: 1, speed: 0 });
    });

    updater.on('error', (error) => {
      this._set({ state: 'error', error: error?.message ?? String(error), progress: null });
    });
  }

  _set (patch) {
    this._status = { ...this._status, ...patch };
    this.emit('status', this.status());
  }
}

module.exports = { Updater, REASON_UNPACKAGED, PROGRESS_MIN_MS };

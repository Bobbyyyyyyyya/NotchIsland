'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { app } = require('electron');

/**
 * Manages `NotchHelper`, the Objective-C companion that talks to CoreAudio and
 * the MediaPlayer remote command centre.
 *
 * The binary is compiled on first run with the system clang and cached in the
 * app's user-data directory, so nothing has to be shipped pre-built. If the
 * toolchain is missing the app still runs; it just loses device control and the
 * UI hides the affected panels.
 */

const CLANG = '/usr/bin/clang';
const FRAMEWORKS = [
  '-framework', 'Foundation',
  '-framework', 'AppKit',
  '-framework', 'MediaPlayer',
  '-framework', 'CoreAudio',
  '-framework', 'CoreMedia',
  '-framework', 'CoreMediaIO',
  '-framework', 'IOKit',
  '-framework', 'IOBluetooth',
  '-framework', 'SystemConfiguration',
];

class HelperBridge extends EventEmitter {
  constructor () {
    super();
    this.process = null;
    this.available = false;
    this.reason = 'starting';
    this.capabilities = {};
    this._restartTimer = null;
  }

  get sourcePath () {
    const packaged = path.join(process.resourcesPath, 'helper', 'NotchHelper.m');
    return fs.existsSync(packaged)
      ? packaged
      : path.join(app.getAppPath(), 'tools', 'helper', 'NotchHelper.m');
  }

  get binaryPath () {
    return path.join(app.getPath('userData'), 'helper', 'NotchHelper');
  }

  /**
   * Compiles the helper when the source is newer than the cached binary.
   *
   * The compile is async on purpose: clang takes a while on a cold cache, and
   * blocking the main process for those seconds froze everything the island
   * does at the exact moment the user decides whether the app is any good.
   */
  compile () {
    const source = this.sourcePath;
    if (!fs.existsSync(source)) throw new Error(`helper source missing at ${source}`);
    if (!fs.existsSync(CLANG)) throw new Error('clang is not installed (install the Xcode Command Line Tools)');

    const binary = this.binaryPath;
    const needsBuild = !fs.existsSync(binary)
      || fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs;

    if (!needsBuild) return Promise.resolve(binary);

    return new Promise((resolve, reject) => {
      fs.mkdir(path.dirname(binary), { recursive: true }, () => {});
      const result = spawn(CLANG, [
        '-fobjc-arc', '-O2', '-w',
        ...FRAMEWORKS,
        source, '-o', binary,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      result.stderr.on('data', (chunk) => { stderr += chunk; });
      result.on('error', (error) => reject(new Error(`helper build failed: ${error.message}`)));
      result.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`helper build failed: ${(stderr || '').split('\n').slice(-3).join(' ')}`));
          return;
        }
        fs.chmod(binary, 0o755, () => resolve(this.binaryPath));
      });
    });
  }

  start () {
    if (this.process || this._launching) return;
    this._launching = true;
    const settle = () => { this._launching = false; };
    let binary;
    try {
      binary = this.compile();
    } catch (error) {
      this.available = false;
      this.reason = error.message;
      settle();
      console.warn('[helper] unavailable:', error.message);
      this.emit('status', this.status());
      return;
    }

    Promise.resolve(binary).then((resolved) => {
      settle();
      // A stop() that ran while clang was busy would otherwise leave a child behind.
      if (this.process || this._stopping) return;
      this._stopping = false;
      const child = spawn(resolved, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = child;
      child.stdin?.on('error', () => {});
    }, (error) => {
      this.available = false;
      this.reason = error.message;
      settle();
      console.warn('[helper] unavailable:', error.message);
      this.emit('status', this.status());
    }).then(() => {      const child = this.process;
      if (!child) return;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.event === 'hello') {
        this.available = true;
        this.reason = null;
        this.capabilities = message.capabilities ?? {};
        this.emit('status', this.status());
      }
      this.emit('event', message);
    });

      child.stderr.on('data', (chunk) => console.warn('[helper]', String(chunk).trim()));
      child.on('exit', (code) => {
        this.process = null;
        this.available = false;
        this.reason = `helper exited (${code})`;
        this.emit('status', this.status());
        // Guard against a crash loop; give up after a few quick restarts.
        if (this._restarts < 3) {
          this._restarts = (this._restarts ?? 0) + 1;
          clearTimeout(this._restartTimer);
          this._restartTimer = setTimeout(() => this.start(), 2000 * this._restarts);
        }
      });
    });
  }

  _restarts = 0;

  /** True while clang is busy: a stop() in that window has to linger. */
  _launching = false;

  send (command, args = {}) {
    if (!this.process?.stdin?.writable) return false;
    try {
      this.process.stdin.write(`${JSON.stringify({ cmd: command, ...args })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  status () {
    return {
      available: this.available,
      reason: this.reason,
      capabilities: this.capabilities,
      compiled: fs.existsSync(this.binaryPath),
    };
  }

stop () {
    this._stopping = true;
    clearTimeout(this._restartTimer);
    try { this.process?.stdin?.removeAllListeners('error'); } catch {}
    this.process?.kill();
    this.process = null;
  }
}

module.exports = { HelperBridge };

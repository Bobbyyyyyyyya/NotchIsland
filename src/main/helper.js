'use strict';

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
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

  /** Compiles the helper when the source is newer than the cached binary. */
  compile () {
    const source = this.sourcePath;
    if (!fs.existsSync(source)) throw new Error(`helper source missing at ${source}`);
    if (!fs.existsSync(CLANG)) throw new Error('clang is not installed (install the Xcode Command Line Tools)');

    const binary = this.binaryPath;
    const needsBuild = !fs.existsSync(binary)
      || fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs;

    if (needsBuild) {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      const result = spawnSync(CLANG, [
        '-fobjc-arc', '-O2', '-w',
        ...FRAMEWORKS,
        source, '-o', binary,
      ], { encoding: 'utf8', timeout: 120000 });
      if (result.status !== 0) {
        throw new Error(`helper build failed: ${(result.stderr || '').split('\n').slice(-3).join(' ')}`);
      }
    }
    fs.chmodSync(binary, 0o755);
    return binary;
  }

  start () {
    if (this.process) return;
    let binary;
    try {
      binary = this.compile();
    } catch (error) {
      this.available = false;
      this.reason = error.message;
      console.warn('[helper] unavailable:', error.message);
      this.emit('status', this.status());
      return;
    }

const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    child.stdin?.on("error", () => {});

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
  }

  _restarts = 0;

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
    clearTimeout(this._restartTimer);
    try { this.process?.stdin?.removeAllListeners('error'); } catch {}
    this.process?.kill();
    this.process = null;
  }
}

module.exports = { HelperBridge };

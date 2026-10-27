'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const RECOVERY_ARGUMENT = '--opencluely-recovery';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (first, second) => typeof first === 'string' && typeof second === 'string' &&
  path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase();

function recoverySession(argv) {
  const index = argv.indexOf(RECOVERY_ARGUMENT);
  if (index === -1) return null;
  return typeof argv[index + 1] === 'string' && UUID.test(argv[index + 1]) ? argv[index + 1] : '';
}

function readJSON(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writePrivate(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery data must use a real directory.');
  const temporary = path.join(directory, `.write-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function prepareDirectory(helperPath, directory) {
  return new Promise((resolve, reject) => {
    execFile(helperPath, ['--prepare', directory], { windowsHide: true, timeout: 8000, maxBuffer: 16384 }, error => {
      if (error) reject(new Error('The private automatic reopening directory could not be prepared.'));
      else resolve();
    });
  });
}
function launchHelper(helperPath, statePath, sessionId) {
  const child = spawn(helperPath, ['--state', statePath, '--session', sessionId], {
    detached: true, windowsHide: true, stdio: 'ignore'
  });
  // The ready marker, not a successful spawn(), confirms native initialization.
  child.on('error', () => {});
  child.unref();
  return child;
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function verifyHelper(helperPath, readyPath, sessionId) {
  return new Promise(resolve => {
    execFile(helperPath, ['--verify-helper', readyPath, '--session', sessionId], {
      windowsHide: true, timeout: 5000, maxBuffer: 16384
    }, error => resolve(!error));
  });
}

// This is an ordinary user-owned process, never a service, scheduled task or
// privileged process. Quit completely disarms its session before exiting.
class WindowsRecovery {
  constructor({ available = false, directory, executablePath, helperPath, pid = process.pid,
    onChange = () => {}, prepare = prepareDirectory, launch = launchHelper, isAlive = processAlive, verify = verifyHelper,
    readyTimeout = 8000, stopTimeout = 3000 }) {
    if (!path.isAbsolute(directory) || !path.isAbsolute(executablePath) || !path.isAbsolute(helperPath)) {
      throw new Error('Automatic reopening requires absolute local paths.');
    }
    this.available = available; this.directory = directory; this.executablePath = executablePath;
    this.helperPath = helperPath; this.pid = pid; this.onChange = onChange;
    this.prepare = prepare; this.launch = launch; this.isAlive = isAlive; this.verify = verify;
    this.readyTimeout = readyTimeout; this.stopTimeout = stopTimeout;
    this.statePath = path.join(directory, 'state.json');
    this.readyPath = path.join(directory, 'helper.json');
    this.enabled = false; this.busy = false; this.error = ''; this.sessionId = null;
    this.pending = null; this.sessionEnding = false; this.generation = 0;
  }
  status() {
    // Refresh only when the UI requests state; no healthy-state polling timer.
    if (this.enabled && !this.busy && !this.helperReady(this.sessionId)) {
      this.enabled = false;
      this.error = 'Automatic reopening has stopped. Turn it on again to resume.';
    }
    return { available: this.available, enabled: this.enabled, busy: this.busy, error: this.error };
  }
  changed() { this.onChange(this.status()); }
  readState() { return readJSON(this.statePath); }
  acceptsSession(sessionId) {
    const state = this.readState();
    return typeof sessionId === 'string' && UUID.test(sessionId) && state?.version === 1 &&
      state.enabled === true && state.sessionId === sessionId && samePath(state.executablePath, this.executablePath);
  }
  shouldResumeAfterSessionEnd() {
    const state = this.readState();
    return !!this.sessionId && state?.version === 1 && state.sessionId === this.sessionId &&
      samePath(state.executablePath, this.executablePath) && state.enabled === false &&
      state.reason === 'windows-session-end' && state.wasEnabled === true;
  }
  writeState(enabled) {
    writePrivate(this.statePath, { version: 1, sessionId: this.sessionId, enabled,
      pid: this.pid, executablePath: this.executablePath });
  }
  helperReady(sessionId) {
    const ready = readJSON(this.readyPath);
    return ready?.version === 1 && ready.sessionId === sessionId &&
      samePath(ready.executablePath, this.helperPath) && this.isAlive(ready.pid);
  }
  async waitForReady(sessionId, failed = () => false) {
    const deadline = Date.now() + this.readyTimeout;
    while (Date.now() < deadline) {
      if (failed() || this.sessionEnding || !this.acceptsSession(sessionId)) throw new Error('The automatic reopening session has stopped.');
      if (this.helperReady(sessionId) && await this.verify(this.helperPath, this.readyPath, sessionId)) return;
      await delay(25);
    }
    throw new Error('The automatic reopening helper did not start.');
  }
  async waitForStop(sessionId) {
    const deadline = Date.now() + this.stopTimeout;
    while (this.helperReady(sessionId) && Date.now() < deadline) {
      // An abandoned marker whose PID was reused is not a running helper.
      if (!await this.verify(this.helperPath, this.readyPath, sessionId)) return;
      await delay(25);
    }
    // State was already disarmed. A slow/terminated helper cannot use it to reopen.
    if (this.helperReady(sessionId)) throw new Error('Reopening is paused, but its helper has not stopped yet. Try turning it off again.');
  }
  operation(action) {
    if (this.busy) return Promise.reject(new Error('Automatic reopening is already changing. Please wait.'));
    this.busy = true; this.error = ''; this.changed();
    this.pending = Promise.resolve().then(action).catch(error => {
      this.error = error.message || 'Automatic reopening could not be changed.';
      throw error;
    }).finally(() => { this.busy = false; this.pending = null; this.changed(); });
    return this.pending;
  }
  enable({ sessionId = null } = {}) {
    if (this.sessionEnding) return Promise.reject(new Error('Automatic reopening cannot start while signing out.'));
    if (!this.available) return Promise.reject(new Error('Automatic reopening is available in the installed Windows app.'));
    const generation = this.generation;
    return this.operation(async () => {
      if (sessionId && !this.acceptsSession(sessionId)) throw new Error('This automatic reopening session has stopped.');
      if (this.enabled && this.helperReady(this.sessionId) && await this.verify(this.helperPath, this.readyPath, this.sessionId)) {
        if (this.sessionEnding || generation !== this.generation) throw new Error('Automatic reopening cannot start while signing out.');
        return this.status();
      }
      this.enabled = false;
      if (!sessionId) {
        const previous = this.readState();
        if (previous) {
          writePrivate(this.statePath, { ...previous, enabled: false });
          await this.waitForStop(previous.sessionId);
        }
      }
      if (this.sessionEnding || generation !== this.generation) throw new Error('Automatic reopening cannot start while signing out.');
      this.sessionId = sessionId || randomUUID();
      try {
        fs.accessSync(this.helperPath, fs.constants.R_OK);
        await this.prepare(this.helperPath, this.directory);
        // Recheck after the native ACL operation: a concurrent pause/logoff wins.
        if (this.sessionEnding || generation !== this.generation || (sessionId && !this.acceptsSession(sessionId))) throw new Error('Session ended.');
        this.writeState(true);
        let startupFailed = false;
        const adopted = this.helperReady(this.sessionId) && await this.verify(this.helperPath, this.readyPath, this.sessionId);
        if (this.sessionEnding || generation !== this.generation) throw new Error('Session ended.');
        if (!adopted) {
          const token = this.sessionId;
          const helper = this.launch(this.helperPath, this.statePath, token);
          const failed = () => {
            startupFailed = true;
            if (this.sessionId !== token || this.generation !== generation || this.busy || !this.enabled) return;
            this.enabled = false;
            this.error = 'Automatic reopening has stopped. Turn it on again to resume.';
            this.changed();
          };
          helper?.once?.('exit', failed);
          helper?.once?.('error', failed);
        }
        if (!adopted) await this.waitForReady(this.sessionId, () => startupFailed);
        if (this.sessionEnding || generation !== this.generation) throw new Error('Session ended.');
        this.enabled = true;
        return this.status();
      } catch {
        try { this.writeState(false); } catch { try { fs.rmSync(this.statePath, { force: true }); } catch {} }
        this.enabled = false;
        throw new Error('Automatic reopening could not start. Try turning it on again, or reopen the app.');
      }
    });
  }
  disable() {
    if (!this.available) return Promise.resolve(this.status());
    return this.operation(async () => {
      const previous = this.readState();
      let disarmed = false;
      try {
        if (previous) {
          // An owner pause supersedes a native shutdown marker, even if the
          // helper received the Windows session query before the GUI did.
          const paused = { ...previous, enabled: false };
          delete paused.reason; delete paused.wasEnabled;
          writePrivate(this.statePath, paused);
        }
        disarmed = true;
      } catch { try { fs.rmSync(this.statePath, { force: true }); disarmed = true; } catch {} }
      if (!disarmed) throw new Error('Recovery state could not be cleared. Check disk space and try turning reopening off again.');
      this.enabled = false;
      if (previous) await this.waitForStop(previous.sessionId);
      return this.status();
    });
  }
  async stopForQuit() {
    if (this.pending) { try { await this.pending; } catch {} }
    if (this.available) await this.disable();
  }
  async keepForQuit() {
    if (this.pending) { try { await this.pending; } catch {} }
    // Pausing reopening and Windows session end take precedence over relaunch.
    if (!this.available || this.sessionEnding || !this.enabled) return false;
    const generation = this.generation, token = this.sessionId;
    return this.operation(async () => {
      const verified = this.acceptsSession(token) && this.helperReady(token) &&
        await this.verify(this.helperPath, this.readyPath, token);
      if (this.sessionEnding || this.generation !== generation || !this.acceptsSession(token)) return false;
      if (!verified) throw new Error('Automatic reopening is unavailable. Keep the app open, re-enable reopening, or choose Quit completely.');
      return true;
    });
  }
  disarmForSessionEnd({ terminal = true } = {}) {
    this.generation++;
    this.sessionEnding = terminal;
    try {
      const previous = this.readState();
      if (previous) writePrivate(this.statePath, { ...previous, enabled: false });
    } catch { try { fs.rmSync(this.statePath, { force: true }); } catch {} }
    this.enabled = false;
    // Never await helper shutdown while Windows is ending the login session.
    this.changed();
  }
}

module.exports = { WindowsRecovery, RECOVERY_ARGUMENT, recoverySession, writePrivate };

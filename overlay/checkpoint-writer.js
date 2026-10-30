'use strict';

// Small synchronous state snapshots only. A dirty snapshot is throttled during
// continuous changes; transient disk failures retry without waiting for input.
// Timers never keep the app alive or launch another process.
class CheckpointWriter {
  constructor({ write, report = () => {}, interval = 1000, maximumRetryDelay = 30000 }) {
    if (typeof write !== 'function' || !Number.isFinite(interval) || interval < 1 ||
        !Number.isFinite(maximumRetryDelay) || maximumRetryDelay < interval) throw new TypeError('Invalid checkpoint configuration.');
    this.write = write; this.report = report; this.interval = interval;
    this.maximumRetryDelay = maximumRetryDelay;
    this.dirty = false; this.timer = null; this.retryDelay = interval;
  }
  schedule(delay) {
    if (!this.dirty || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
    this.timer.unref?.();
  }
  mark() { this.dirty = true; this.schedule(this.interval); }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.dirty) return true;
    try {
      this.write(); this.dirty = false; this.retryDelay = this.interval;
      return true;
    } catch {
      this.schedule(this.retryDelay);
      this.retryDelay = Math.min(this.maximumRetryDelay, this.retryDelay * 2);
      try { this.report(); } catch { /* Reporting must not interrupt a retry. */ }
      return false;
    }
  }
  cancel() {
    clearTimeout(this.timer); this.timer = null;
    this.dirty = false; this.retryDelay = this.interval;
  }
}

module.exports = { CheckpointWriter };

'use strict';

// Guards cooperative app quits only. Signals and OS force termination bypass this.
class QuitGuard {
  constructor({ enabled, confirm, prepare = async () => {}, quit, blocked = () => {} }) {
    this.enabled = enabled; this.confirm = confirm; this.quit = quit; this.blocked = blocked;
    this.prepare = prepare;
    this.approved = false; this.sessionEnding = false; this.pending = null; this.pendingMode = null;
  }
  preventQuit() {
    if (this.approved || this.sessionEnding || !this.enabled()) return false;
    this.blocked();
    return true;
  }
  allowSessionEnd() { this.sessionEnding = true; }
  cancelSessionEnd() { this.sessionEnding = false; }
  requestQuit({ stopCompletely = false } = {}) {
    if (this.pending) return this.pendingMode === stopCompletely ? this.pending : Promise.reject(Object.assign(
      new Error('Another Quit action is already in progress. Finish or cancel it before choosing a different action.'), { code: 'quit_action_busy' }));
    this.pendingMode = stopCompletely;
    // Defer callbacks until pending is assigned, so duplicate requests share one dialog.
    this.pending = Promise.resolve().then(async () => {
      const options = { stopCompletely };
      if (!this.sessionEnding && (this.enabled() || stopCompletely) && !(await this.confirm(options))) return false;
      // Keep external quit requests blocked until supervision is ready or has
      // been deliberately stopped. A failed preparation leaves the app open.
      await this.prepare(options);
      this.approved = true;
      try { await this.quit(options); } catch (error) { this.approved = false; throw error; }
      return true;
    }).finally(() => { this.pending = null; this.pendingMode = null; });
    return this.pending;
  }
}

module.exports = { QuitGuard };

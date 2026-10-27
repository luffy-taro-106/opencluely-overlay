'use strict';

// Guards cooperative app quits only. Signals and OS force termination bypass this.
class QuitGuard {
  constructor({ enabled, confirm, quit, blocked = () => {} }) {
    this.enabled = enabled; this.confirm = confirm; this.quit = quit; this.blocked = blocked;
    this.approved = false; this.sessionEnding = false; this.pending = null;
  }
  preventQuit() {
    if (this.approved || this.sessionEnding || !this.enabled()) return false;
    this.blocked();
    return true;
  }
  allowSessionEnd() { this.sessionEnding = true; }
  cancelSessionEnd() { this.sessionEnding = false; }
  requestQuit() {
    if (this.pending) return this.pending;
    // Defer callbacks until pending is assigned, so duplicate requests share one dialog.
    this.pending = Promise.resolve().then(async () => {
      if (!this.sessionEnding && this.enabled() && !(await this.confirm())) return false;
      this.approved = true;
      try { await this.quit(); } catch (error) { this.approved = false; throw error; }
      return true;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

module.exports = { QuitGuard };

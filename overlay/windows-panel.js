'use strict';

// Electron maps setFocusable(false) to Windows' WS_EX_NOACTIVATE behavior.
// Pointer interaction remains available. Windows needs foreground keyboard
// focus for ordinary typing; grant it only after the owner requests an input.
// No keyboard hooks, browser injection, input forwarding or focus polling.
class WindowsPanel {
  constructor(window, enabled = process.platform === 'win32') {
    this.window = window; this.enabled = enabled; this.keyboardFocus = false; this.passThrough = false;
  }
  apply(passThrough = this.passThrough) {
    this.passThrough = passThrough;
    if (passThrough) this.keyboardFocus = false;
    const focusable = !passThrough && (!this.enabled || this.keyboardFocus);
    if (this.window.isFocusable() !== focusable) this.window.setFocusable(focusable);
    this.window.setSkipTaskbar?.(true);
    if (!focusable && this.window.isFocused()) this.window.blur();
    return this.status();
  }
  allowKeyboard() {
    if (this.passThrough) throw new Error('Turn off click-through before typing in the overlay.');
    this.keyboardFocus = true;
    this.apply();
    return this.status();
  }
  releaseKeyboard() {
    this.keyboardFocus = false;
    return this.apply();
  }
  handleBlur(onChange = () => {}) {
    // Win32 delivers blur while its native activation transition is in flight.
    // Defer style changes until Windows has assigned the next focused window.
    setImmediate(() => {
      if (this.window.isDestroyed?.() || this.window.isFocused()) return;
      this.releaseKeyboard(); onChange();
    });
  }
  status() {
    return { available: this.enabled, preventsActivation: this.enabled && !this.keyboardFocus,
      keyboardFocus: this.keyboardFocus, focusable: this.window.isFocusable(), typingRequiresActivation: this.enabled };
  }
}
module.exports = { WindowsPanel };

# Windows 2.5.2 interrupted-work recovery

The encrypted checkpoint format introduced in the 21 October 2026 Mac port is preserved. Version 2.5.2 improves save scheduling without changing providers, authentication or process-relaunch behavior.

The main process owns provider connections. A renderer crash reloads the interface without aborting a healthy answer. The installed Windows recovery helper can reopen a terminated main process while automatic reopening remains enabled. Ordinary Quit retains the verified helper; Quit completely and session end disarm it. Pausing remains available in Settings and the tray. The helper is not automatically relaunched if it is terminated.

With conversation restoration enabled, interrupted-work.enc stores the submitted question, partial output, provider/model, request ID, attachment names and a hash of the completed conversation. Windows DPAPI encryption uses Electron safeStorage. Keys, image pixels and unsent drafts are excluded. Checkpoints occur at request start, about once per second during output, and on completion/cancellation.

After reopening, the partial answer is marked interrupted. No provider request is automatically resent. Image questions require reattachment before retry. A different conversation cannot inherit the checkpoint, and a completed request cannot appear twice. Clearing the current conversation or disabling restoration removes its checkpoint and pending writes.

Writes use exclusive unique staging files, flush before atomic replacement, and preserve the preceding committed file if a write or rename fails. Failed checkpoint writes now retry after the normal interval, then double delays to a maximum of 30 seconds. A quiet stream still retries, newer text replaces pending older text, clean state stays idle, and clearing the checkpoint cancels retries. Window geometry uses the same throttled writer at approximately 350 ms, so continuous dragging cannot indefinitely postpone a save. Suspend and session-end notifications flush pending text and geometry without blocking the OS transition.

Removing a saved file also removes its abandoned staging files. Recent unsaved output, drafts and image pixels can still be lost. Scheduling, disk failures, power loss and severe resource exhaustion can prevent saving. This is not a zero-data-loss guarantee, backup system or protection against repeated process termination. See [the architecture and source structure](RECOVERY-ARCHITECTURE.md).

Run npm test, npm run test:desktop, npm run test:interruption, and npm run test:recovery. Tests use disposable profiles and mocked provider generation. The interruption harness terminates its own fixture, then launches a fresh Electron process and checks native encrypted restoration without resending.

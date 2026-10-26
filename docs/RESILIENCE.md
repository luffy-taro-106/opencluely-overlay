# Windows 2.3.5 interrupted-work recovery

Ported from Mac commit f5da45024c1e64171663f903c536a6435efa658e on 21 October 2026.

The main process owns provider connections. A renderer crash reloads the interface without aborting a healthy answer. The installed Windows recovery helper can reopen an unexpectedly terminated main process while automatic reopening remains enabled. Confirmed Quit and session end disarm the helper; pausing it remains available in Settings and the tray.

With conversation restoration enabled, interrupted-work.enc stores the submitted question, partial output, provider/model, request ID, attachment names and a hash of the completed conversation. Windows DPAPI encryption uses Electron safeStorage. Keys, image pixels and unsent drafts are excluded. Checkpoints occur at request start, about once per second during output, and on completion/cancellation.

After reopening, the partial answer is marked interrupted. No provider request is automatically resent. Image questions require reattachment before retry. A different conversation cannot inherit the checkpoint, and a completed request cannot appear twice. Clearing the current conversation or disabling restoration removes its checkpoint and pending writes.

Writes use exclusive unique staging files, flush before atomic replacement, and preserve the preceding committed file if a write or rename fails. Removing a saved file also removes its abandoned staging files. Recent unsaved output can still be lost; this is not a backup system or protection against repeated process termination.

Run npm test, npm run test:desktop, npm run test:interruption, and npm run test:recovery. Tests use disposable profiles and mocked provider generation. The interruption harness terminates its own fixture, then launches a fresh Electron process and checks native encrypted restoration without resending.

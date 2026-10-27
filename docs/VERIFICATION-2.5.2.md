# Windows recovery checkpoints — 2.5.2

Verified on 27 October 2026. This update improves ordinary state preservation. It retains the existing independent Windows recovery helper and existing Quit/pause/shutdown semantics. Reciprocal process resurrection, continuous mutual pings, process hiding, injection and termination-control bypass were not added.

## Changes

- `CheckpointWriter` throttles dirty snapshots and retries failed synchronous saves after the normal interval, doubling subsequent delays to a maximum of 30 seconds. A quiet stream still retries; successful saves reset the delay. Clean state stays idle, and timers do not prolong app lifetime.
- Interrupted answers use this writer with their existing encrypted checkpoint format and approximately one-second save interval. Clear/history opt-out cancels retries.
- Window position uses the same writer at approximately 350 ms. Continuous movement no longer indefinitely postpones saving.
- Sleep and session-end notifications synchronously flush pending window and answer state. They do not block sleep/shutdown or automatically resend a question.
- Existing topmost `screen-saver` level, account/provider flows, text/image generation, startup and encrypted storage formats remain unchanged.

## Final automated runs

| Check | Passed |
| --- | ---: |
| Unit, provider/authentication, storage, lifecycle and native Codex checks | 153 |
| Desktop, new-process restoration and four Quit/session-end paths | 46 |
| Native Windows helper integration | 5 |
| Actual Electron forced-exit and encrypted restoration | 1 |
| **Total** | **205** |

The final runs have no failed or skipped checks. The desktop suite covers continuous movement and synchronous suspend checkpoints, plus the existing provider/model/image/account regressions. The forced-exit fixture deliberately fails one encrypted save, waits for an automatic retry without another answer delta, terminates its own Electron process, and verifies saved history, partial text, provider configuration and window position in a fresh process. It never contacts a real AI provider or resends the interrupted question.

A new geometry assertion initially exposed existing Windows constructor frame rounding. A separate native-window probe on this 125% display observed up to four DIP of size adjustment. The final test requires exact saved bounds and restored x/y coordinates, and allows up to four DIP only for the native window width/height. No window-sizing production code was changed to mask this adjustment.

The dependency audit reports zero known vulnerabilities. The existing renderer console-error check passes; Chromium emits GPU diagnostics during some fixture exits. No user reboot or simulation-app termination test is claimed.

## Installed package and profile

The per-user installer exited 0 and installed version `2.5.2.0`. All 24 installed overlay files match the tested source. The bundled native Codex client initializes successfully with an isolated temporary profile.

A full private profile backup was retained outside tracked source. Saved API credentials and Chromium encryption state are byte-identical to the backup. All 28 previously saved conversation messages remain present and unchanged; the profile now contains 30 messages across the current conversation and two archived chats. Changed encrypted chat bytes therefore do not indicate lost data. The selected ChatGPT provider/model and existing connected account remain readable. Verification prints counts/status only, never keys, tokens or conversation contents. It does not perform personal provider generation.

The user cycled automatic reopening off and on and confirmed **Enabled / running** on 27 October 2026. A fresh installed helper process was independently observed after that action. This confirms the reported UI status and a running helper, but the separate file-based identity check remains **unresolved**: the recovery record visible to the tools still points to an older PID/session, and verification against that record does not pass. The cause of that discrepancy has not been established; no claim that the live helper passed native identity verification is made.

The app's capture-protected window exposes no usable accessibility controls, so the automation did not click recovery settings, disable capture protection or force-terminate the user's current app to test it. Source/native fixture passes must not be presented as proof of continuous operation of this particular running instance.

## Installer

`dist/OpenCluely-Overlay-Setup-2.5.2.exe` — 223,674,062 bytes, unsigned local development build.

```text
SHA-256 d40cf4d8c26df361891108fec73bb270ff265b927991c80a67f61dd06d6dc573
```

Receipts and the private backup are under the task's `work/resilience-2.5.2-2026-10-27/` directory. This verification preceded source publication; consult repository history for publication status. See [architecture and structural code](RECOVERY-ARCHITECTURE.md) and [owner recovery controls](AUTOMATIC-REOPENING.md).

No zero-data-loss or uninterrupted-execution guarantee is made. Uncommitted output, drafts and image pixels may be lost; disk/CPU exhaustion, Windows policy and termination of the helper can prevent recovery.

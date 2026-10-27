# OpenCluely diagnostics — 2.5.3

## Use

Open Settings and choose **Start recording**. Reproduce the problem, then choose **Export diagnostic report** to save a local JSON file. **Stop recording** stops collection. Recording is off on every launch, keeps at most 200 events in memory, and does not install a service or run a polling loop. Starting again begins a new recording. Exporting while recording is off still provides the current app-health snapshot and any retained events from this session.

The report includes only OpenCluely information. It omits prompts, answers, API keys, tokens, account identities, screenshots, raw arguments, raw return values, error messages, command lines and filesystem/profile paths. File labels are fixed relative component names. Export is local; the application does not upload the report. Reports still contain technical metadata such as PIDs, timestamps, resource usage and display geometry.

## Requested feature coverage

This is an app-owned diagnostic implementation, not the full proposed enterprise monitoring product. “Not implemented” below does not imply that every omitted feature is prohibited.

| Requested area | Available in this build | Not implemented in this build |
| --- | --- | --- |
| 1. API instrumentation | Explicit tracing around OpenCluely IPC actions; UTC timestamps, sequence/call IDs, duration, success/error status, return **type**, main-process CPU delta, bounded history and recording status. | Native API interception, cross-process hooks, argument/return **values**, cross-version behavior baselines and global instrumentation-conflict detection. |
| 2. Process diagnostics | A snapshot of OpenCluely's Electron-owned processes, PID, process type, CPU usage and working-set metrics using `app.getAppMetrics()`. | System-wide inventory, other-app executable paths, process trees, signatures, cross-source reconciliation and continuous process history. |
| 3. Window diagnostics | OpenCluely's bounds, visibility, minimized/focused/topmost state, and monitor resolution/scaling/rotation snapshots. | Other-app windows, global keyboard-focus tracking, desktop-wide Z-order/hierarchy enumeration and continuous window history. |
| 4. Module diagnostics | SHA-256 and readable/missing/access-error status for fixed OpenCluely components; bounded PE architecture/format/section-count inspection of its recovery helper when available. | Other-process DLL inventory, import/export parsing, dynamic module-load tracing, memory-to-file comparison and trusted-baseline integrity alerts. |
| 5. Health/recovery | Existing owner-controlled helper/backoff, saved-state restoration, checkpoint dirty/retry/failure/last-save status, and optional app lifecycle events. | Reciprocal resurrection, a new helper-restart policy, new restart-count limits, or a claim that cached “enabled” state proves live native-helper health. |
| 6. Capture diagnostics | Timing/outcome of app-owned capture IPC actions when recording; the overlay's configured capture-protection flag and display metadata. | Capture images in reports, inspection of other apps' capture settings, cross-API capture compatibility tests, reference-image comparison and capture-exclusion bypass. |
| 7. Session/display changes | Optional lock/unlock, sleep/resume, session-end/cancellation and display-change events. Lock notifications save pending state without stopping a healthy answer; unlock reapplies the ordinary window configuration. | Secure-desktop access, desktop/session switching, forced session reconnection and a cross-session compatibility matrix. |
| 8. Release/security | Runtime versions, component hashes, direct-dependency inventory in app reports; a generated CycloneDX production SBOM, dependency-audit result, installer checksum and separately inspected release signature status accompany the build. | Authenticode verification inside the app, full import/export/string analysis, continuous binary-integrity monitoring, and signed build-provenance attestations. |

Native API interception, injection or enumeration/capture tampering to conceal OpenCluely or defeat another application's controls are excluded. Quit completely, owner pause and Windows shutdown remain available. There is no attempt to become a protected/critical process or acquire extra privileges. General signature verification, owned-binary analysis and controlled compatibility tests are legitimate potential extensions; they are simply not implemented here.

## Source

- `overlay/diagnostics.js`: `Diagnostics` is the complete explicit in-process recorder; `ownProcessMetrics`, `checkpointStatus`, `inspectOwnFile` and `inspectPE` provide bounded projections/inspection.
- `overlay/main.js`: trusted IPC call-site instrumentation, local report assembly/export, fixed component selection, and session/display notifications.
- `overlay/checkpoint-writer.js`: observable save status without changing recovery scheduling.
- `overlay/preload.js` and `overlay/ui/`: recording/export controls. Existing trusted-main-frame IPC checks apply to both new operations.
- `tests/diagnostics.test.js` and the desktop suite: privacy, recording lifecycle, concurrency, bounded history, known-file inspection, export/cancellation and lock/unlock tests.

No caller can select an arbitrary target PID, executable, function address or DLL through the diagnostics bridge. The module does not patch a function, change an executable or access another process's address space.

## Measurement limits

Call durations include asynchronous waits. The `ask` IPC action completes when submission is accepted; its span does not measure the full streamed provider response. CPU deltas describe all main-process work during the call, including overlapping calls. The instrumentation timer measures only recorder preparation/completion work; it is a partial observation, not an isolated overhead benchmark. Process metrics are sampled on export, not a continuous live inventory. Recording stopped during a call can leave a start event without a finish event; old completions never contaminate a restarted recording.

File hashes identify observed component bytes and do not establish authenticity. The PE summary validates basic headers only; it is not a complete executable validator. Component reads are limited to 2 MiB and never include profile files. The report explicitly marks signature verification, remote-provider availability, capture compatibility and native-helper identity as unverified. It does not send test questions or silently authenticate to a provider.

Production SBOM regeneration from the installed dependency tree:

```powershell
npm run --silent sbom > OpenCluely.sbom.cyclonedx.json
```

This represents production components installed for the current platform, not every optional platform variant or bundled runtime component. The in-app direct-dependency list is a smaller inventory and is labeled accordingly.

## Documented interfaces

- [Electron app metrics](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics) and [ProcessMetric fields](https://www.electronjs.org/docs/latest/api/structures/process-metric).
- [Node process CPU usage](https://nodejs.org/api/process.html#processcpuusagepreviousvalue).
- [Electron power/session notifications](https://www.electronjs.org/docs/latest/api/power-monitor).

See the [verification record](VERIFICATION-2.5.3.md) for tested behavior and installation status.

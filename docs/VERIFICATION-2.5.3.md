# App-owned diagnostics — 2.5.3

Verified on 27 October 2026. This update implements opt-in instrumentation of OpenCluely's own IPC actions and a redacted local diagnostic export. It does not implement the full proposed system-wide framework. See the [eight-area coverage table](DIAGNOSTICS.md) for precise inclusions, omissions and measurement limits.

## Behavior

- Recording starts only through the new Settings button and resets to off on launch. History is limited to 200 in-memory events. Stop/restart cannot import late results from an earlier recording.
- Reports contain call IDs/timestamps/timing/outcomes/types, app-owned Electron resource metrics, the overlay's state, display geometry, checkpoint health, runtime versions, fixed-component SHA-256 values and helper PE metadata when available.
- Tests verify that private question/answer text, fixture keys, raw arguments and profile paths do not appear in exported JSON. Reports exclude account identity, tokens, image pixels and raw error bodies by construction.
- Lock notifications flush pending state without interrupting a healthy answer. Unlock reapplies the existing window configuration. Sleep/shutdown handling and the existing owner-controlled watchdog remain intact.
- Native hooks, injection, other-app inventory, global focus/window surveillance, capture bypass, privileged persistence and reciprocal resurrection are absent.

## Automated validation

| Suite | Passed |
| --- | ---: |
| Unit, provider/auth, storage, lifecycle, diagnostics and native Codex checks | 163 |
| Desktop, new-process restoration, diagnostic export and Quit/session-end checks | 49 |
| Native Windows recovery integration | 5 |
| Actual Electron forced exit and encrypted restoration | 1 |
| **Total** | **218** |

No checks failed or were skipped. The desktop report contains zero renderer console errors. Some fixture exits emit Chromium GPU diagnostics; these are separate from renderer console failures. Lock/unlock and session-end notifications were delivered to fixtures; the user's workstation was not locked, shut down or restarted. No personal AI request was generated.

Additional package checks verify all 25 overlay files against the build source. A fresh Electron process successfully reads the diagnostic module and fixed files inside the ASAR package and identifies the unpacked recovery helper as x64 PE32+. These package checks do not use the user's profile.

`npm audit` reports zero known vulnerabilities. The production CycloneDX 1.5 SBOM contains five installed dependency components and excludes developer dependencies. It represents the installed Windows dependency tree, not every optional platform variant or every bundled runtime library. See [the SBOM](releases/2.5.3.sbom.cyclonedx.json).

## Local release artifact

`dist/OpenCluely-Overlay-Setup-2.5.3.exe` — 223,677,318 bytes.

```text
SHA-256 c9a4533e7e59ba9b18e9a0c3783b4a2cd6180d33c4e0b88869a73698f167bcc1
```

Windows Authenticode inspection reports **NotSigned** for the installer and helper. Signature verification is not implemented inside the app's diagnostic export; that report explicitly marks it unverified. File hashes and local build records are not signed provenance attestations.

The package-input SHA-256 recorded with the build is `1f1d6a6eeafe0f4e40f4ae4399b5e4337661763c7d247969e648bb23104406a6`. Build tools were Node 24.14.1 and Electron 44.9.3. Source/security scanning found no secrets in the inspected source or existing history. Test/build receipts are retained outside tracked source.

## Installation and remaining limits

This 2.5.3 installer has been built and package-checked; it has not automatically replaced the user's running 2.5.2 installation. Choose Quit completely before installing it, then use Settings → Start recording / Export diagnostic report. Existing profiles and provider formats have not changed.

The earlier 2.5.2 live-helper file/identity discrepancy remains unresolved. This update does not repair or claim to independently verify it. Diagnostic reports distinguish cached recovery-enabled state from verified native health. A full runtime compatibility matrix, isolated instrumentation overhead benchmark, in-app signature checks and complete binary/module auditing are not claimed.

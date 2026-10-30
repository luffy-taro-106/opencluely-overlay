# Restore OpenCluely 2.5.2 — 28 October 2026

This is the historical restoration record. The later [30 October appearance patch](APPEARANCE.md) adds the saved dark/light toggle and small focus-request guards to this base.

The requested base is the actual original 2.5.2 implementation, rather than a newer build with a changed version label. The Git history combines the 2.5.2 checkpoint work and later 2.5.3 diagnostics in commit `d56c8f93b46fd559c1d7a699aad8179ecd9b9bfc`; its revert is 2.5.0, not 2.5.2. Therefore the runtime was recovered from the locally retained original 2.5.2 installer.

Original installer SHA-256:

```text
d40cf4d8c26df361891108fec73bb270ff265b927991c80a67f61dd06d6dc573
```

This matches the original [2.5.2 installation record](VERIFICATION-2.5.2.md). All 24 original overlay files were restored byte-for-byte before making the requested shortcut change. The Electron 44.9.3 architecture, HTML Settings, provider/account flows, image handling, encrypted state, checkpoint writer, native recovery helper, Quit controls and original shortcuts remain. Native Windows Forms Settings and the later performance/diagnostics modules are absent. Build/test support comes from the associated Git history, with diagnostic-only additions removed.

## Only runtime modification

`overlay/main.js`, inside `registerShortcuts`, registers these additional Windows accelerators:

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+O | Show overlay passively; it never toggles a visible overlay off. |
| Ctrl+Shift+C | Hide overlay to tray; it does not terminate the assistant. |
| Ctrl+Shift+S | Run the same screenshot callback as Ctrl+Alt+S. |

The original Ctrl+Alt+Space, Ctrl+Alt+T, Ctrl+Alt+I and Ctrl+Alt+S registrations are retained. Screenshot previews still require an explicit Ask before contacting a provider. Shortcut conflicts use the original warning behavior; no global keyboard hook or alternate capture path is added.

## Installation status

The registered per-user NSIS uninstaller removed 2.5.4 successfully (exit 0). The rebuilt 2.5.2 installer completed successfully (exit 0). Registry and standard per-user/machine program-folder checks show one installed OpenCluely version: **2.5.2**, executable product version **2.5.2.0**, at:

```text
C:\Users\Ashok chilka\AppData\Local\Programs\OpenCluely Overlay\OpenCluely Overlay.exe
```

The application launches and responds. Its original recovery helper runs from the same installation. All 24 installed runtime files match source; 23 are byte-identical to the original package and the remaining file differs only in `registerShortcuts`. No native Settings host is installed. The Start-menu shortcut targets this executable.

The profile was backed up privately before uninstall (71 files). Decryption and preservation checks confirm API-key records, the saved account and active account selection, all 30 existing conversation messages, and both archived chats. No credentials, account identifiers or conversation text are exported in the verification receipts.

All 205 existing checks pass: 153 unit checks, 46 desktop checks, 5 native recovery checks and 1 forced-exit/restoration check. An initial disposable-profile desktop run encountered a temporary `EBUSY` file-rename error; the rerun passed without changing production storage behavior. All seven shortcuts registered successfully with Windows, and a separate handler check verifies their routing and shared screenshot callback. The user confirmed all physical shortcuts work; Ctrl+Shift+O initially did not appear to respond, then was confirmed working during investigation without another code change. Its transient cause is unestablished.

The desktop input tool was unavailable, so automated physical key presses are not claimed. Actual saved-account sign-in and paid AI generation were not automated. The original 2.5.2 limitations remain.

Restoration and installation receipts are retained locally under the task's `work/restore-2.5.2-2026-10-28/` directory. Source and original installer backups are outside the active project. Automatic approval review rejected cleanup of the old 2.5.3/2.5.4 build artifacts with the reason `blocked by policy`; those uninstalled artifacts and rollback backups remained outside the active installed application. At the end of that restoration task, nothing had been committed, pushed or released.

Rebuilt installer SHA-256 (original 2.5.2 plus the three shortcut aliases):

```text
abf89c95a55514ec3c6c0aca5af67d23db597c90bce3117d3ad20a12b4dc2085
```

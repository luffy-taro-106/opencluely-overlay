# Windows Quit and reopening — 2.5.1

Verified on 26 October 2026. This update changes only Quit/reopening behavior and its controls. Provider authentication, model discovery, text/image generation, stored chats, overlay focus and capture behavior remain as in 2.5.0.

## Resulting behavior

- **Quit and reopen** confirms the action, verifies the existing recovery helper, and leaves supervision enabled while the current app exits. The helper attempts to start a replacement in the tray; Ctrl+Alt+Space shows it again.
- **Quit completely…** confirms and stops both the app and its helper. It remains available while reopening is paused.
- Pausing reopening is respected. When quit protection is disabled, an allowed external cooperative Quit still prepares the verified reopening path.
- Conflicting overlapping Quit choices receive a clear busy error instead of silently changing the confirmed choice. Quit controls are disabled while recovery is changing.
- Windows shutdown/sign-out are allowed. Canceled shutdown restores prior reopening, unless the owner paused it.

The existing native helper already monitors process exit and retries with bounded backoff. No injection, process-name concealment, API hooking, security exclusions, privileged service or security-control evasion was added. If another app also terminates the helper, reopening cannot be guaranteed. A terminated answer returns only its last saved text for review and manual retry; generation is not automatically resent.

## Validation

| Final checks | Passed |
| --- | ---: |
| Unit, provider/model/authentication, storage, lifecycle and native Codex checks | 143 |
| Desktop, restart, complete exit, ordinary Quit, external Quit and session-end paths | 44 |
| Native Windows helper, normal-exit relaunch, forced-exit recovery and session-end checks | 5 |
| Actual Electron forced-termination and encrypted interrupted-answer restoration | 1 |
| **Total** | **193** |

No checks failed or were skipped. The desktop suite recorded zero renderer console errors. npm audit reported zero vulnerabilities. The normal-exit native test observed a successful process exit and a replacement PID, followed by no further relaunch after complete stop. The shutdown tests deliver session-end notifications; they do not shut down the user's computer.

Installed version `2.5.1.0` was checked separately: all 23 overlay files match the built source, the window is responsive/topmost/passive with capture exclusion enabled, startup is preserved, and the recovery helper's native process/session identity verifies. Existing keys and saved conversations remain readable. A pre-install profile backup was retained privately outside tracked source.

The installed window's capture protection and limited accessibility tree prevented the Computer Use tool from inspecting its buttons, so no manual installed-window Quit click is claimed. Renderer/IPC Quit tests and a native helper normal-exit relaunch test passed independently.

## Local installer

`dist/OpenCluely-Overlay-Setup-2.5.1.exe` — 223,673,534 bytes.

```text
SHA-256 41b6ecb2c51c2ab9e806def34ba4a8d629fd5b92155a36cb5695fc99662efe54
```

This is an unsigned local development build. A separately rebuilt installer may have a different digest. See [automatic reopening and owner controls](AUTOMATIC-REOPENING.md).

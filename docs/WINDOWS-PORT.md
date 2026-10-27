# Windows 2.5.3 app diagnostics — 27 October 2026

Built locally with opt-in, app-owned call instrumentation and a redacted local report. All 218 suite checks pass, and packaged components match source. The running user installation has not been replaced by this build. See [feature coverage](DIAGNOSTICS.md) and [verification/installation status](VERIFICATION-2.5.3.md).

---

# Windows 2.5.2 checkpoint update — 27 October 2026

Installed locally with bounded failed-save retries, continuous-movement position checkpoints and a synchronous flush before suspend. Existing helper and Quit semantics are preserved. All 205 automated checks pass. The user confirmed Enabled / running and a fresh helper process was observed; the separate file-based identity check remains unresolved. See [the verification record](VERIFICATION-2.5.2.md) and [architecture/source structure](RECOVERY-ARCHITECTURE.md).

---

# Windows 2.3.8 update — 24 October 2026

Reference: Mac commit `5fd5ab805d465f04586831d67b782853566a8859`, including live-model and reasoning changes from `16c0e5f`. The Windows-specific focus controller uses Electron/Win32 no-activation behavior. Ordinary display, screenshot restoration, pointer controls and leaving click-through remain passive. A genuine click in an editable field, Ctrl+Alt+T or the explicit tray typing action enables ordinary Windows keyboard focus. Returning to another app releases it. Typing temporarily activates the overlay; the Mac inactive-application/key-panel behavior is not claimed on Windows. See [focus behavior](NONACTIVATING-PANEL.md).

Validation so far: 82 source/model/provider/controller tests, four native Windows recovery tests, and ten isolated GUI focus checks passed. The GUI checks use disposable Chromium windows and an actual desktop click to return focus. They verify unchanged browser blur count on passive display, overlay-only typing, no text leakage to the browser field, automatic release on browser return, click-through, and hide/restore. No provider generation or user credential was used. The complete desktop regression suite remains blocked when launched inside the command sandbox; the focus checks ran through the supported native desktop tool.

The Windows native recovery helper and its existing retry timing are preserved. The Mac one-minute retry change is outside this browser-focus adaptation.

Installed successfully on 24 October 2026 in `C:\Program Files\OpenCluely Overlay`; installer exited 0. All 19 installed overlay files match the tested source byte-for-byte, and the native recovery helper is included. The installed UI restores the existing conversation and Gemini 3.5 Flash Lite selection, exposes reasoning effort, and confirms the Ctrl+Alt+T typing state. The encrypted provider profile was preserved. Installer SHA-256: `ee7f0292a5e2106d82bf5a9f6269f6ac8832c888e3fbc022598b4f4a19b6ef1a`.

---

# Windows 2.3.5 port record

## 21 October 2026 update

Ported the full latest Mac changeset from [luffy-taro-106/mac-godsplan, f5da450](https://github.com/luffy-taro-106/mac-godsplan/commit/f5da45024c1e64171663f903c536a6435efa658e) onto Windows base `e4f7b83` in [luffy-taro-106/opencluely-overlay](https://github.com/luffy-taro-106/opencluely-overlay).

- Ten ordered image attachments through upload, paste, drag/drop and repeated screenshots; individual removal, bounded memory, names-only persistence and legacy compatibility.
- The Mac plain chat interface without the previous logo/heading/slogans.
- Independent app and code-box opacity, each 10%–100%, including streamed and nested code blocks.
- Encrypted interrupted-answer checkpoints, flushed atomic saves, manual retry with image reattachment, and healthy generation preserved through renderer crashes.
- Windows C# recovery, canceled-shutdown handling, Ctrl+Alt shortcuts, DPAPI, startup behavior, installer identity and existing profile compatibility preserved.

Validation on this laptop:

| Check | Result |
| --- | --- |
| Unit/process/provider/controller tests | 68 passed; 0 failed, skipped or canceled. |
| Dependency audit | 0 known vulnerabilities across production and development dependencies. |
| C# helper build and capability/identity probe | Compiled; native probe test passed. |
| Native recovery integration | Three fixtures could not prepare private-directory ACLs under the Codex sandbox account; these are failed/blocked checks, not claimed passes. |
| Desktop and native encrypted restoration | Blocked before application startup by Electron's restricted-token read check and unavailable DPAPI under the separate Codex sandbox Windows account. No desktop pass is claimed. |
| Windows x64 NSIS installer | Built successfully, unsigned. |
| Packaged source | All 18 overlay files match the source byte-for-byte; helper included outside ASAR; test fixtures excluded. |
| Installer SHA-256 | `b00b52f15b918fcdcc1e8761052b420006944b1b4d2e7ff8645cac265f63c33d` |
| Installation in the owner's Windows session | Installed through the native Windows installer in `C:\Program Files\OpenCluely Overlay`; version 2.3.5.0; all 18 installed files match source. |
| Installed UI and helper | Chat running; native helper running and UI reports automatic reopening on. Ten-image attachment control and independent app/code opacity controls observed. Public Desktop and Start-menu shortcuts present. |
| Live provider access | Claude currently shows key setup required. No user API keys were supplied or live paid generation tested. All three provider integrations remain available. |

Electron 44.7.0 was downloaded through the HTTPS npm mirror and verified against the checksum bundled in the pinned Electron npm package: `eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c`. Certificate verification remained enabled. Direct installation-folder writes remained denied after requesting filesystem access; the native computer-use tool successfully opened the installer in the desktop session. The installed app and native helper are running. Full automated desktop/helper/interruption checks should still be repeated from the owner's normal interactive Windows account. API keys must be entered there so DPAPI uses the correct Windows identity. No real API key or paid generation request was used during this port.

## Historical Windows 2.3 validation

The remaining record describes the earlier 17 October port, not new 2.3.5 test results on this laptop.

Port prepared on 17 October 2026 from [ashokchilka99/mac-godsplan](https://github.com/ashokchilka99/mac-godsplan), reference commit [`f2b35228b67e0b22816ce779bc41c7503f24665d`](https://github.com/ashokchilka99/mac-godsplan/commit/f2b35228b67e0b22816ce779bc41c7503f24665d), the Mac 2.3 source. The Windows repository remains [ashokchilka99/opencluely-overlay](https://github.com/ashokchilka99/opencluely-overlay). This is a Windows adaptation; it does not package the Mac Swift helper or LaunchAgent.

## Feature mapping

| Mac 2.3 feature | Windows adaptation |
| --- | --- |
| Text and image answers | OpenAI API, Claude and Gemini with provider-native streaming and image payloads. |
| Provider model dropdowns and custom IDs | Per-provider model choices, custom IDs and saved selections; account access and quota still apply. |
| Local saved provider keys | Metadata API check before replacement; Windows DPAPI via Electron safeStorage; failed checks preserve the saved key. |
| Overlay across ordinary applications | Windows topmost window, tray lifetime, compact view and opacity; no repeated focus stealing or app injection. |
| Click-through and shortcuts | Pointer/focus pass-through; Ctrl+Alt+Space, Ctrl+Alt+I and Ctrl+Alt+S. |
| Upload, clipboard, drag/drop, screenshot preview | PNG/JPEG validation, bounded image memory, display selection and explicit send. |
| Capture protection | Windows `WDA_EXCLUDEFROMCAPTURE` requested by default; verify the actual meeting or recording preview. |
| New chat and saved conversations | Encrypted current chat and archives, reopen/delete controls, legacy conversation migration; image pixels are never saved. |
| Normal Quit protection | Enabled by default; ordinary close hides to tray, cooperative Quit is guarded, explicit Quit asks for confirmation. |
| Reopen after unexpected termination | Windows C#/.NET Framework helper with process-exit events, state-change notifications and bounded retry backoff. |
| Pause and explicit Quit controls | Immediate Settings/tray pause; 2.5.1 preserves the helper for ordinary Quit and disarms it for Quit completely; next manual app open enables recovery again. |
| Start at login | Existing per-user Windows Run registration with `--background`, separate from recovery. |
| macOS session/permission integration | Windows session-end handling; Mac Screen Recording settings, Keychain, Dock/Spaces and launchctl code are not used. |
| Renderer and process reliability | Sandboxed renderer, caller-checked IPC, renderer recovery, single instance, suspend cancellation and display-boundary recovery. |

The ordinary Windows user can stop the app and helper. Windows shutdown and sign-out remain available. This port does not promise immunity to Task Manager, an administrator, forced termination, every third-party app, exclusive fullscreen windows or unsupported capture methods.

## Upgrade and packaging

Version 2.3 retains `com.opencluely.overlay`, **OpenCluely Overlay**, the existing executable location, and `%APPDATA%\OpenCluely Overlay`. Preserve the entire profile during an upgrade so safeStorage can restore credentials and conversations. An existing saved provider/model selection is retained. Legacy `conversation.enc` supplies existing completed history when no current archive store is available; successful saves produce encrypted `chats.enc`.

`node scripts/build-recovery.js` compiles the Windows C# helper before Electron Builder packages it outside the ASAR archive. The expected Windows installer is `OpenCluely-Overlay-Setup-2.3.0.exe`. Source and generated tests never read real user keys or enable production recovery. Windows desktop and native helper checks use temporary profiles and fixture processes.

## Current validation status

Checked on Windows 11 x64 on 17 October 2026. The checks below cover this port; [version 2.1 results](VERIFICATION.md) remain a historical record.

| Check | Status for Windows 2.3 |
| --- | --- |
| Source unit checks, provider transport and validation | 54 passed |
| Interactive Electron checks, provider/model UI, archives and restart | 24 passed, including confirmed Quit and fresh-process restoration; no skipped checks or renderer console errors |
| Cooperative Quit and explicit Quit control | Active answer survives blocked Quit, canceled Quit and separate-process WM_CLOSE; confirmed Quit exits normally |
| Windows native helper termination/reopening/pause/session-end tests | 4 passed, including repeated forced fixture exits, pause, session-end marking and stale state rejection |
| Dependency audit | 0 known vulnerabilities across production and development dependencies |
| Windows x64 packaging and helper inclusion | Setup built; source matches app.asar and helper is included outside ASAR |
| Installed upgrade and preservation of existing profile/startup | Installed 2.3.0; credentials, completed conversation, preferences and Local State preserved byte-for-byte during upgrade; saved Gemini key restored and authenticated; startup remains enabled |
| Installed native window and helper | Responsive; topmost and WDA_EXCLUDEFROMCAPTURE verified on the actual window; recovery enabled with native helper identity verified |
| Public source and installer | Version 2.3.0 source is maintained in this Windows repository; see Releases for the installer and SHA256SUMS.txt |
| Full computer reboot/sign-in | Not claimed as tested |
| Every meeting client, third-party closing tool, live paid AI model | Not claimed as tested |

Total automated checks: **82 passed**. Provider generation in the automated suite uses mock responses and test keys. The saved user Gemini key was separately restored and verified with a metadata request after installation; no live paid OpenAI or Claude generation was required. The helper's forced-termination tests use disposable fixture processes, not the user's installed app.

Canceled Windows shutdown is covered in both helper-first and overlay-first orderings. A native shutdown marker distinguishes that case from a killed helper; explicit pause clears the marker. A blocked close leaves an answer running, while explicit Quit waits for recovery cleanup. Source tests use isolated profiles and never enable production recovery.

The Windows GUI automation helper was unavailable during the installed-app check, so installed validation used native window attributes, helper identity verification, responsive process checks and encrypted profile restoration. The real interface and owner controls were exercised in the isolated Electron desktop suite. Both installer and helper are unsigned development builds.

## Reproduce

On Windows x64 with Node.js 22.12+ and Git:

```powershell
npm ci
npm test
npm run test:desktop
npm run test:recovery
npm audit
npm run build:win
```

Desktop checks need an interactive Windows desktop. The native helper tests act only on their fixture processes. Generated outputs stay outside Git. Provider/model access, answer quality and capture behavior still depend on the selected provider and the actual Windows/meeting configuration.

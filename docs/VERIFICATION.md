# OpenCluely Overlay 2.1 — verification

**Historical report for version 2.1.0.** These results do not validate the Windows 2.3 port, its OpenAI integration, conversation archives, quit guard, or native recovery helper. Current port status is recorded in [WINDOWS-PORT.md](WINDOWS-PORT.md).

Built, installed and checked on Windows 11 x64 on 14 October 2026.

## Results

| Check | Result |
| --- | --- |
| Node unit tests | 19 passed |
| Native Electron integration and process-restart checks | 13 passed |
| Renderer console errors in integration suite | 0 |
| npm dependency audit, including build dependencies | 0 known vulnerabilities |
| Windows x64 installer packaging and upgrade | Successful |
| Packaged files and Markdown/sanitizer libraries | Verified in app.asar |
| Packaged application startup | Started in tray, app-ready logged, process responsive |
| Saved Gemini key restored and verified through the installed provider code | Successful; encrypted key and history files preserved byte-for-byte during upgrade |
| Live Gemini text request after earlier user configuration | Successful with Gemini 3.5 Flash |
| Visible overlay and Settings excluded from native screen capture | Passed with a controlled background and real captured pixel checks |
| Installed application's native Windows capture affinity | 0x11, WDA_EXCLUDEFROMCAPTURE |
| New key replacement and restart persistence | Passed; separate provider keys preserved, rejected keys and disk errors retain prior saved key |
| Installed app registration for Windows sign-in | Exact startup command registered and executable enabled |
| Physical Ctrl+Alt+Space after background launch | User confirmed the overlay opens |
| Executable product metadata | OpenCluely Overlay, version 2.1.0 |
| Code signing | Unsigned development build |

The native checks exercise topmost configuration, close-to-tray, click-through/focusability, compact restoration, DPAPI encryption, verified key replacement through the real Settings form, rollback after rejection or disk failure, separate provider keys, a fresh Electron process reading the saved replacement, image paste/preview/submission, sanitized Markdown and code rendering, follow-up image context, duplicate request prevention, cancellation, caller isolation, forced renderer-crash recovery, real display capture, key removal and bounded caches. Renderer drafts/caches use a nonpersistent in-memory session.

Unit tests cover settings/question validation, capture-protection migration defaults, metadata-only key verification for both providers, authentication/network/timeout errors without exposing keys, image signatures and dimension limits, monitor bounds, context and storage limits, fragmented Unicode streaming, provider image payloads, empty/blocked/partial responses, retry limits, cancellation, deadlines and corrupt files.

AI responses and candidate keys in the automated suite were mocked. The existing saved user key was separately restored with Windows safeStorage and accepted by the real Gemini models API after the upgrade. After earlier user configuration, a real Gemini 3.5 Flash text request returned an answer. Gemini 3.8 Flash returned temporary availability errors, so the running app retains the tested model. Live Claude calls, live image question accuracy, every meeting client/capture mode, startup following a full PC reboot, exclusive fullscreen modes, and long-duration performance under every workload are not claimed as tested.

Capture protection is enabled by default and can be changed in Settings. Windows capture-affinity was read from the installed executable's actual visible window and returned 0x11. The desktop suite confirmed that capture shows the overlay when disabled and the background when enabled, including while Settings is open. Protection remained enabled through click-through and renderer recovery. [Microsoft documents the supported capture paths and limitations](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity); verify the preview in your meeting client. Native file pickers and system dialogs are outside this overlay's coverage.

No finite test suite guarantees zero bugs. Windows can stop the process, and an ordinary overlay cannot cover UAC/security screens. The build includes recovery and clear errors for the failures it can handle.

## Reproduce

From the source folder, with Node.js 22.12+:

```powershell
npm ci
npm test
npm run test:desktop
npm audit
npm run build:win
```

See [setup and privacy documentation](../README-OVERLAY.md). The root SHA256SUMS.txt records the 2.1.0 setup executable's hash. Electron download certificate checks remained enabled; the development runtime download was verified against the published package checksum.

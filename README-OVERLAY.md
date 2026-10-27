# OpenCluely Overlay 2.5.3 for Windows

A Windows desktop assistant that stays above your apps and answers text and image questions using **OpenAI / ChatGPT**, **Claude**, or **Gemini**.

Built from [arth-agrawal/OpenCluely](https://github.com/arth-agrawal/OpenCluely), based on [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely), with the updated [Mac 2.3 features](https://github.com/luffy-taro-106/mac-godsplan) adapted for Windows. The current source uses the `overlay/` implementation, focused on text and images. See the [Windows parity and validation record](docs/WINDOWS-PORT.md) for the reference revision and current status.

## Get started

1. Install an available Windows setup from [Releases](https://github.com/luffy-taro-106/opencluely-overlay/releases). The current source build produces `dist/OpenCluely-Overlay-Setup-2.5.3.exe`. Check the [port record](docs/WINDOWS-PORT.md) for validation and publication status.
2. Click the gear, choose OpenAI / ChatGPT, Claude, or Gemini, select a model, enter your provider API key, and save. The app checks API access before saving it encrypted on this device. Save a separate key for each provider you use. Saved keys restore after the app or computer restarts. To replace a key, enter the new key and save; a failed check preserves the previous key. Leave the field blank to keep it.
3. Type a question and press Enter. Shift+Enter adds a new line.
4. For an image question, use the image button, paste from the clipboard, drag an image onto the window, or take a screenshot. Preview the image, optionally type a question, and press Enter. With no text, the assistant reads and answers the question in the image.

These are unsigned development builds; Windows may show a publisher warning. Public distribution should use a trusted code-signing certificate. API usage is billed by your provider. A chat subscription may not include API credits.

## Overlay behavior

- Stays above ordinary desktop windows. Drag the title bar to move it and use the edges to resize.
- Showing the overlay, taking a screenshot and using pointer controls preserve browser focus. Click the question or another editable field to type normally; Windows temporarily activates the overlay for keyboard input. Clicking back in the browser restores passive behavior automatically. See [Windows focus behavior](docs/NONACTIVATING-PANEL.md).
- The pointer button enables click-through, allowing mouse and keyboard input to reach the app underneath. Use Ctrl+Alt+I or the tray to interact again.
- The compact button collapses the conversation to a small toolbar.
- The minus button, Escape, and the normal close action hide to the tray. The process and active answer keep running. Settings and the tray provide separate **Quit and reopen** and **Quit completely** actions when installed recovery is available.
- **Protect against normal Quit requests** is enabled by default, including for existing profiles. Cooperative external Quit requests are rejected. With automatic reopening enabled, **Quit and reopen** confirms and preserves the verified helper so it can reopen the app hidden in the tray. **Quit completely** confirms and stops both. **Keep running** is the default choice in both dialogs. If reopening is paused, ordinary Quit leaves it paused and stops the app.
- Enable Start in tray when I sign in in the installed app to launch with Windows. This option is disabled in portable/source builds because their executable path may be temporary.
- The installed app enables **Reopen automatically after Quit, a crash or forced termination** whenever you open it. Pause reopening immediately in Settings or the tray. A manual app open enables it again; showing the overlay with its shortcut preserves the pause. See [helper operation and emergency stop](docs/AUTOMATIC-REOPENING.md).
- Closing other apps does not close this assistant. Recovery uses a separate owner-controlled, per-user helper, without administrator access or a Windows service. It does not control, inject into, or repeatedly refocus other apps.
- Hide overlay from screen sharing and recordings is enabled by default, including for existing profiles. It protects the overlay and its in-window Settings, and stays enabled after sleep, recovery and restart. You can turn it off in Settings.

| Action | Shortcut |
| --- | --- |
| Show / hide | Ctrl+Alt+Space |
| Type a question | Ctrl+Alt+T |
| Toggle click-through | Ctrl+Alt+I |
| Screenshot | Ctrl+Alt+S |

If another app has registered a shortcut, Settings shows a warning and the tray/buttons remain available. The Screenshot button uses the display selected in Settings; the global shortcut captures the display under the pointer. Screenshots are previewed, and nothing is sent until you ask.

## Text and image handling

- OpenAI, Claude and Gemini stream answers into the current conversation. Switch using the provider selector.
- Attach up to ten PNG/JPEG images per question, each up to 10 MB and 32 megapixels. Upload, paste, drag/drop and repeated screenshots append in order. Preview or remove individual images before sending. Images are converted to JPEG and capped at 2560 pixels on the longest side and 4 MiB each.
- Follow-ups include up to ten images, with historical images bounded to a combined 20 MiB context budget. The cache holds at most twenty images and protects queued/active attachments from eviction. Restored conversations keep names; reattach pixels after restarting.
- App opacity and code-box opacity each range independently from 10% to 100%. Both preferences persist, and code can remain fully readable with the surrounding interface faded.
- Requests include at most eight previous completed exchanges, bounded to about 48,000 text characters. Incomplete/cancelled answers do not enter model context.
- Stop cancels the active request. Temporary failures are retried up to twice, only before output arrives. Requests have a two-minute total deadline. Interrupted output requires an explicit retry.
- Each configured provider refreshes its available chat-model catalog on launch. Refresh models / check key in Settings repeats that metadata check. Per-model reasoning effort is available in Settings and beside the chat model, and each selection is remembered independently.
- Each provider has a model dropdown and remembers its selection. A custom-ID option remains available. Build-time defaults are `gpt-6.1-sol`, `claude-sonnet-5-5`, and `gemini-3.8-flash`; existing profiles retain their saved selections. Model availability, vision support, billing and quota depend on your account. The app never silently switches models or providers.
- **New chat** resets the composer and context. With restoration enabled, the previous completed conversation is encrypted and saved first. Reopen or delete previous chats in Settings. Opening a previous chat archives the current completed conversation. Stop an active answer before changing conversations.
- Answers support Markdown, code blocks, copying and Markdown export. Generated HTML is sanitized; remote images and scripts are blocked. Clicking a generated link copies it for you to open in your own browser.

## Privacy

Text and attached images go directly to your selected AI provider over HTTPS when you ask. There is no application backend or telemetry. Retention and costs depend on your provider account. Recent images can be sent again as follow-up context during the current session.

Saved keys stay in the native process and do not return in renderer state or exports. Keys and optional saved conversation text are encrypted with Windows DPAPI through Electron safeStorage. This protects files from other Windows users; other processes running as your user may still be able to decrypt them. If encryption is unavailable, the app refuses to persist keys/history instead of saving plaintext.

Images stay in bounded memory and are never written to conversation history. Reopening restores text and image names, but you must reattach pixels. With restoration enabled, submitted questions and partial output are encrypted in `interrupted-work.enc`, checkpointed about once per second, and shown as interrupted after reopening. Restoration never automatically resends a provider request. Disabling restoration removes saved current, archived and unfinished chats from disk. Clear conversation clears only the current chat and releases its images; previous chats remain available. Archives are bounded to 100 chats and about 3 MB of text. Exports are plaintext Markdown saved only when you choose Export.

Data lives in `%APPDATA%/OpenCluely Overlay`. Version 2.3 restores legacy `conversation.enc` text and migrates it into the encrypted `chats.enc` current-chat/archive store on the next successful save. Keep the entire existing profile when upgrading; it contains encryption state needed to restore saved keys and history. Renderer drafts and caches use an in-memory browser session. Diagnostics are size-bounded and contain lifecycle/error categories, not prompts, image pixels, keys or provider response bodies. Recovery state contains process/session information, not provider keys or conversations.

Key verification makes a metadata request to the selected provider's models API, with the key in an HTTPS header. It does not generate an answer or send your conversation. API access checks do not guarantee billing credit, quota, or access to every model. There is no verification call at startup; a saved key can be used immediately when the app starts.

Capture exclusion uses Electron's content protection and Windows `WDA_EXCLUDEFROMCAPTURE`. Windows 10 version 2004 or newer removes the window from supported capture paths; older versions can show a blank rectangle. Meeting apps and capture modes vary, so check the sharing preview or a private recording before relying on it. Native file pickers, system dialogs, and external camera photographs are outside this overlay's protection. See [Electron's window API](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable) and [Microsoft's capture-affinity documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity).

## Reliability and limits

Includes a single-instance lock, close-to-tray lifetime, a cooperative quit guard, owner-controlled main-process reopening, renderer crash recovery with loop limits, suspend cancellation, resume handling, bounded caches, checked IPC callers, monitor-boundary recovery, and atomic settings/history writes. Screenshots are taken only when requested, previewed before sending, and never captured on a timer.

Normal close protection handles cooperative requests. Task Manager, process termination, shutdown/sign-out, and sufficiently privileged software can still stop the app or its helper. Recovery attempts to reopen the app after ordinary Quit or an unexpected exit while enabled; repeated terminations can keep interrupting it. **Quit completely**, pausing recovery, shutdown and sign-out remain under your control. There is no guarantee against every third-party closing tool or capture method.

The app cannot run while the computer sleeps or is off. UAC/security screens and some exclusive fullscreen applications prevent ordinary overlays. Sleep cancels active requests; retry after resume. Renderer recovery preserves a healthy request in the main process. Main-process termination loses its connection, unsent draft, image pixels and output since the latest successful checkpoint. Saved partial text and completed conversations restore when restoration is enabled. Login startup remains a separate preference and starts the app after Windows sign-in, not before the computer is powered on.

AI answers can be wrong, especially with blurry images. The assistant is instructed to identify unclear text and uncertainty. No finite test suite can guarantee a bug-free app or smooth behavior above every application.

## Develop and build

Use Node.js 22.12 or newer and Git. In PowerShell or Command Prompt:

```powershell
npm ci
npm start
npm test
npm run test:desktop
npm run test:recovery
npm run build:win
```

Build on Windows x64. The packaging command runs `node scripts/build-recovery.js` before Electron Builder to compile the C# helper with the Windows .NET Framework compiler. No separately installed .NET SDK, administrator account, Python, Whisper, microphone or audio setup is required. The launch script clears `ELECTRON_RUN_AS_NODE` for the child. Dependencies are pinned in `package-lock.json`.

The installed app works independently of this source folder. Generated builds are excluded from Git and distributed through Releases. Desktop test artifacts stay in `.test-output/`, which is also excluded from Git. Keep the entire `%APPDATA%/OpenCluely Overlay` profile when upgrading so Windows can restore encrypted keys and history.

Desktop and helper tests use temporary profiles and fixture processes. Development and ordinary desktop runs do not enable installed-app recovery. Automated AI responses and candidate keys are mocked. Tests are intended to cover Windows topmost/tray behavior, click-through, compact sizing, DPAPI, key replacement and rollback, new-process restoration, provider/model controls, archives, image input, safe rendering, cancellation, checked IPC, capture exclusion, quit protection, and recovery lifecycle. The [Windows port record](docs/WINDOWS-PORT.md) distinguishes completed checks from pending validation; the [2.1 report](docs/VERIFICATION.md) is historical. Tests do not establish compatibility with every meeting client, paid API/model access, a full reboot, or uninterrupted operation under every workload.

If your network cannot download GitHub release assets, use an HTTPS mirror for the build process. The development Electron binary for this build was obtained through the npm mirror and verified against Electron's published checksum. Certificate validation stayed enabled.

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run build:win
```

## Source

- overlay/main.js: lifecycle, native images, IPC, requests and tray.
- overlay/providers.js: provider payloads, streaming, deadlines and retries.
- overlay/core.js: validation, window bounds and context limits.
- overlay/storage.js: encrypted persistence and atomic writes.
- overlay/models.js: provider names and bundled model choices.
- overlay/platform.js: Windows controls and platform descriptions.
- overlay/quit-guard.js: cooperative quit approval and session-end handling.
- overlay/recovery.js and overlay/native/: Windows helper control and process recovery.
- overlay/preload.js: limited renderer bridge.
- overlay/ui/: local interface with no external assets or renderer networking.
- tests/: unit tests and Windows integration suite.
- Git history and upstream repositories: original implementation for reference.

## References and license

[Electron window API](https://www.electronjs.org/docs/latest/api/browser-window), [app lifecycle](https://www.electronjs.org/docs/latest/api/app), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [OpenAI API](https://platform.openai.com/docs/api-reference), [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding).

Apache-2.0. See LICENSE and NOTICE. The original README described MIT, while the supplied LICENSE contains Apache-2.0; this package follows the supplied LICENSE and preserves upstream attribution.

# OpenCluely Overlay 2.5.2 for Windows

Based on the verified original 2.5.2 Electron implementation, with the three requested Ctrl+Shift shortcut aliases and a saved dark/light appearance toggle. Light mode uses neutral white surfaces for white workspaces; dark mode keeps the original palette. Typing behavior is unchanged, with redundant focus requests removed. All original Ctrl+Alt shortcuts remain. Newer native Settings, performance and diagnostic modules are absent. See [appearance and focus](docs/APPEARANCE.md), [restoration provenance](docs/RESTORE-2.5.2.md), [original 2.5.2 validation](docs/VERIFICATION-2.5.2.md), [recovery architecture](docs/RECOVERY-ARCHITECTURE.md), and [account setup](docs/CHATGPT-SIGN-IN.md). The source produces `dist/OpenCluely-Overlay-Setup-2.5.2.exe`; older download links below refer to earlier public releases.

Windows desktop assistant for text and image questions using **ChatGPT, Codex, OpenAI API, Claude, or Gemini**, adapted from the updated [Mac version](https://github.com/luffy-taro-106/mac-godsplan).

- Always-on-top overlay with tray controls, click-through, compact view, and global shortcuts.
- Browser focus preserved when showing the overlay and using pointer controls; clicking a text field automatically enables normal Windows typing.
- Live account model catalogs and per-model reasoning controls from the updated Mac version.
- Browser sign-in for ChatGPT plan usage and the official Codex client, with independent model lists and locally protected credentials. Account eligibility and usage limits apply.
- Text questions, image upload/paste/drop, screenshots, and streamed answers.
- Up to ten ordered image attachments per question, with individual previews and removal.
- Independent app and code-box opacity from 10% to 100%, and the same plain chat interface as Mac 2.3.8.
- Encrypted interrupted-answer checkpoints and continued generation across renderer crashes.
- Provider-specific model presets and custom model IDs.
- Separate provider keys, checked before saving with Windows encryption.
- New chat and encrypted conversation archives that can be reopened or deleted.
- Capture exclusion and protection against normal Quit requests, enabled by default.
- An owner-controlled Windows helper that reopens the installed app after ordinary Quit, a crash or forced termination while recovery is enabled.
- Optional launch after Windows sign-in, separate from automatic reopening.

Download the [Windows 2.3.8 installer](https://github.com/luffy-taro-106/opencluely-overlay/releases/download/v2.3.8/OpenCluely-Overlay-Setup-2.3.8.exe) or the [complete Codex setup bundle](https://github.com/luffy-taro-106/opencluely-overlay/releases/download/v2.3.8/OpenCluely-Windows-2.3.8-Codex-Setup.zip), including the installer, source, setup guides, and SHA-256 verification manifest.

Build the Windows installer as `dist/OpenCluely-Overlay-Setup-2.5.2.exe`. These are unsigned development builds. See the [restoration record](docs/RESTORE-2.5.2.md) for the installed result and the [Windows port status](docs/WINDOWS-PORT.md) for earlier history.

See [setup, controls, privacy and development](README-OVERLAY.md), [automatic reopening and emergency stop](docs/AUTOMATIC-REOPENING.md), and [startup and shortcuts](docs/STARTUP.md).

**Ctrl+Alt+Space** shows or hides the running overlay. Closing the window hides it to the tray. With automatic reopening enabled, confirming **Quit and reopen** exits the current instance and the helper reopens it hidden in the tray; use the shortcut to show it again. Confirm **Quit completely** in Settings or the tray to stop both the overlay and helper. Pausing reopening is respected, and Windows shutdown and sign-out remain available. Stopping the helper can prevent recovery.

For source development, use Node.js 22.12 or newer:

```powershell
npm ci
npm start
npm test
npm run test:desktop
npm run test:recovery
npm run test:interruption
npm run build:win
```

The build compiles the small C# recovery helper with the Windows .NET Framework compiler before packaging. Desktop checks require an interactive Windows session. Test outputs stay in the ignored `.test-output/` directory. Keys, local conversations, dependencies, and generated builds are excluded from Git.

Based on [arth-agrawal/OpenCluely](https://github.com/arth-agrawal/OpenCluely), [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely), and [luffy-taro-106/mac-godsplan](https://github.com/luffy-taro-106/mac-godsplan). The original implementation remains available in Git history. Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

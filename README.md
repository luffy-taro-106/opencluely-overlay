# OpenCluely Overlay 2.4.1 for Windows

Version 2.4 adds a separate **ChatGPT account** connection with browser sign-in, encrypted sessions, saved account switching and account-specific model discovery. See [ChatGPT setup and credential handling](docs/CHATGPT-SIGN-IN.md). This is a local build; the published 2.3.8 downloads below are the previous release.

Version 2.4.1 replaces Windows native dropdown popups with in-window menus so provider, model, reasoning and saved-account choices work while the overlay preserves browser focus.

Windows desktop assistant for text and image questions using **OpenAI / ChatGPT, Claude, or Gemini**, adapted from the updated [Mac version](https://github.com/luffy-taro-106/mac-godsplan).

- Always-on-top overlay with tray controls, click-through, compact view, and global shortcuts.
- Browser focus preserved when showing the overlay and using pointer controls; clicking a text field automatically enables normal Windows typing.
- Live account model catalogs and per-model reasoning controls from the updated Mac version.
- Text questions, image upload/paste/drop, screenshots, and streamed answers.
- Up to ten ordered image attachments per question, with individual previews and removal.
- Independent app and code-box opacity from 10% to 100%, and the same plain chat interface as Mac 2.3.8.
- Encrypted interrupted-answer checkpoints and continued generation across renderer crashes.
- Provider-specific model presets and custom model IDs.
- Separate provider keys, checked before saving with Windows encryption.
- New chat and encrypted conversation archives that can be reopened or deleted.
- Capture exclusion and protection against normal Quit requests, enabled by default.
- An owner-controlled Windows helper that reopens the installed app after an unexpected exit.
- Optional launch after Windows sign-in, separate from automatic reopening.

Download the [Windows 2.3.8 installer](https://github.com/luffy-taro-106/opencluely-overlay/releases/download/v2.3.8/OpenCluely-Overlay-Setup-2.3.8.exe) or the [complete Codex setup bundle](https://github.com/luffy-taro-106/opencluely-overlay/releases/download/v2.3.8/OpenCluely-Windows-2.3.8-Codex-Setup.zip), including the installer, source, setup guides, and SHA-256 verification manifest.

Build the Windows installer as `dist/OpenCluely-Overlay-Setup-2.3.8.exe`. These are unsigned development builds. See the [Windows port status](docs/WINDOWS-PORT.md) for the reference revision and validation record.

See [setup, controls, privacy and development](README-OVERLAY.md), [automatic reopening and emergency stop](docs/AUTOMATIC-REOPENING.md), and [startup and shortcuts](docs/STARTUP.md).

**Ctrl+Alt+Space** shows or hides the running overlay. Closing the window hides it to the tray. Confirm **Quit OpenCluely** in Settings or the tray to stop both the overlay and automatic reopening. Windows shutdown and sign-out remain available. Windows can force terminate the app or helper; recovery does not make it immune to termination.

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

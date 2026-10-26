# Current build

Version 2.5.0 incorporates upstream in-page combobox controls, replacing the 2.3.9 base-select implementation described below. The current pointer regression verifies first-click opening, provider changes, browser focus preservation, model options, disabled state, viewport bounds and persistence across state refreshes. Both account connections use these controls.

# Windows dropdown fix — 2.3.9

Native provider and model menus failed to open reliably from the Windows overlay because its passive window uses `WS_EX_NOACTIVATE`. Earlier tests assigned select values through JavaScript; they did not exercise opening a menu and clicking an option.

Windows now uses Chromium's in-page select picker (`appearance: base-select`). Provider, model, reasoning, display and archived-chat controls retain their existing HTML select semantics, value handling and accessibility. The menus stay inside the overlay window, use bounded scrolling and support normal selection and dismissal. Simply opening the overlay still preserves browser focus. Clicking the question or API-key field still explicitly enables typing.

Only Windows selects opt into this behavior. No activation timer, keyboard hook, browser injection, API transport or credential format was added. The implementation uses the Chromium feature documented by [Chrome for Developers](https://developer.chrome.com/blog/a-customizable-select).

## Validation on 26 October 2026

- Reproduced the original failure with a pointer-driven regression test before applying the fix.
- **82 source tests and 30 desktop checks passed**, with no failures, skipped checks or renderer console errors.
- The new desktop check opens provider, model, quick reasoning, Settings provider/model/reasoning and screenshot-display menus, clicks their options, verifies saved settings, and verifies that the browser retains focus. It also exercises outside-click and Escape dismissal.
- Real Windows mouse clicks in a disposable copy of the same main/preload/renderer opened provider and model menus, selected OpenAI and GPT-6 Luna, and opened the Settings provider menu. The window stayed nonfocusable and did not take keyboard focus. The fixture contained only a test key and did not access the user's profile or a live provider.
- The existing desktop suite covers image upload/paste/drop, ten attachments, streaming, cancel/retry, renderer recovery, encrypted keys, chat archives, capture exclusion, click-through, compact mode and explicit Quit.
- Installer exited 0. Installed version is **2.3.9.0**, and all **19 overlay files match the tested source**.
- The installed native helper identity was verified, recovery remains enabled, and the visible installed window is responsive, topmost, passive and excluded from capture with affinity `0x11`. Startup at Windows sign-in still points to the installed executable.
- Encrypted credentials, `Local State`, `chats.enc` and `conversation.enc` were preserved byte-for-byte. Provider/model selections were preserved. The saved Gemini key decrypts and authenticates; both archived chats restore. No paid generation request was needed for this UI-only fix.

The user profile currently selects OpenAI, for which no key is saved. Gemini has the saved, authenticated key. Select Gemini to use it, or save a separate key in Settings for Claude/OpenAI.

## Installed build

Installer: `dist/OpenCluely-Overlay-Setup-2.3.9.exe`

SHA-256: `d5a689d7893d857b1781ddc3679b87e32166599cc04ef06052afe42806fe6a9b`

The complete pre-install profile backup and detailed verification records are in the workspace's `work/dropdown-fix-2.3.9-2026-10-26` directory. Source changes have not been pushed. This remains an unsigned development build. A full reboot, every third-party app and every meeting client were not tested. The first-run encryption limitation documented in the 2.3.8 setup report remains unchanged.

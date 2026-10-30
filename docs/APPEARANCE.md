# Appearance and focus — 30 October 2026

This is a small patch on the restored 2.5.2 Electron application. It does not restore the later Forms Settings, diagnostics or performance modules. Dependencies and provider/account/storage architecture are unchanged.

## Light and dark

The sun/moon toggle is in the top bar and remains available in compact view. Dark mode retains the original palette and is the default for existing profiles. Light mode uses neutral white surfaces to sit comfortably against white browser pages and documents, with restrained green accents. It does not inspect the app underneath or automatically match its content.

The palette follows [Microsoft Fluent's guidance on neutral surfaces and restrained accents](https://fluent2.microsoft.design/color/). The exact shades below are project choices, checked against [WCAG 2.2 text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum).

| Role | Light color | Reason |
| --- | --- | --- |
| Main surface | `#FFFFFF` | Matches ordinary white documents and pages. |
| Controls / composer | `#FAFAFA` | Subtle separation without a dark panel. |
| Code surface | `#F5F5F5` | Keeps code distinct while staying light. |
| Primary text | `#242424` | Charcoal; measured CSS contrast 15.52:1 against white. |
| Secondary text | `#616161` | Readable gray; 6.19:1 against white. |
| Accent text / primary buttons | `#245F42` | Restrained green; 7.53:1 against white. |
| Dividers | `#DEDEDE` | Quiet structural boundaries; text/icons communicate controls. |

The light rules cover conversation cards, code/copy controls, dropdown lists, Settings, confirmation dialogs, image previews, errors, warnings and loading/status elements. A pre-existing Settings label selector typo was corrected so labels remain properly spaced.

Existing app and code opacity settings remain independent. The ratios above compare the computed opaque CSS colors, not arbitrary desktop compositions. Reducing opacity or placing the overlay over varied content can lower effective contrast; this is not a claim of complete WCAG conformance.

`theme` is a validated `dark`/`light` preference in the existing atomic preferences store. An allowlisted, main-frame-authenticated `set-theme` IPC route saves only the appearance change, without stopping an active answer, validating a key, preparing a provider or changing native focus. Failed writes leave the previous theme intact. A concurrent key-save transaction preserves the most recent toolbar selection. No new polling, network call or dependency is introduced.

## Focus

The user chose to retain normal keyboard focus behavior. Showing, reading, scrolling, theme selection and other pointer controls use the existing passive overlay. Clicking an editable field, Ctrl+Alt+T and the explicit tray typing action may activate OpenCluely. Native file dialogs and browser sign-in also need ordinary interaction. There is no promise that Chrome stays focused while the user types in OpenCluely.

The renderer skips an unnecessary focus request when its editor already owns keyboard focus. Main separately checks native window/webContents focus before calling their focus methods. There is no keyboard hook, browser injection, focus-restoration loop or input forwarding. See [the focus contract](NONACTIVATING-PANEL.md).

## Validation

- 154 unit checks and 48 desktop checks pass on the local Windows machine, with zero renderer console errors.
- The desktop checks compare actual computed light colors, cover both palettes and the open light model menu/Settings, and generate disposable-profile previews for visual review.
- Tests verify persistence across renderer reload and a fresh Electron process, invalid values, failed writes, a theme change during a provider save, and uninterrupted streaming.
- An isolated Chromium-window fixture retains focus and its blur count during a theme toggle. Repeated focus requests within the active editor issue no redundant native focus calls. These fixture checks do not prove behavior in every third-party application.
- Source tests use disposable accounts/data and fixture answers. No live user sign-in or paid AI answer is required.

Build with the existing `npm run build:win` script; output remains `dist/OpenCluely-Overlay-Setup-2.5.2.exe`. The version stays 2.5.2 as requested; this is a customized build, not the byte-identical original installer. Existing public installers may predate this patch.

# OpenCluely 2.5.0 verification

Checked on Windows on 26 October 2026. This version incorporates upstream login commit `723ad56`, adds the separate Codex account connection, and preserves the Windows security and recovery updates.

| Final automated checks | Passed |
| --- | ---: |
| Unit, OAuth/JWT/callback/refresh/revocation, model/provider, storage/lifecycle, and native Codex integration | 128 |
| Desktop renderer/IPC, both account interfaces, text/image routing, passive dropdowns, restart and confirmed Quit | 41 |
| Native Windows recovery and session-end supervision | 4 |
| Actual Electron forced termination and encrypted interrupted-answer restoration | 1 |
| **Total** | **174** |

The final runs had no failed or skipped checks. The desktop suite recorded zero renderer console errors, and npm audit reported zero vulnerabilities, including development dependencies.

## Account and model checks

The ChatGPT tests exercise real loopback callback handling with isolated OAuth fixtures, including state/PKCE binding, signed identity validation, declined plan permission, account switching, encrypted persistence, rotating refresh serialization, revocation, cancellation and offline recovery. Responses tests cover text/images, supported request fields, streaming completion, quota/error handling and prevention of automatic duplicate generation or API-billing fallback.

The Codex tests use the pinned official client 0.164.0. Native checks initialize fresh isolated profiles, obtain and cancel a managed login URL without browser consent, and inspect a question request against a local fixture server. The outgoing fixture request has no computer tools. Desktop tests verify connection-specific catalogs, selected reasoning, text/image routing, cancellation and sign-out during an answer.

Personal browser sign-in and actual ChatGPT/Codex subscription inference remain unverified. The automated account fixtures do not establish any particular account's eligibility, model access or quota. See [account setup and limits](CHATGPT-SIGN-IN.md).

## Installed Windows build

- Product version `2.5.0.0`, Electron `44.9.3`; the Codex native binary is included and initializes from the installed package.
- All 23 overlay files match their source files exactly.
- Existing encrypted credentials, conversations and Chromium encryption state were preserved across the upgrade. The existing provider key authenticated through its model endpoint without generating an answer.
- Startup still launches the installed app with `--background` after Windows sign-in.
- The installed window is responsive, topmost and passive, with Windows capture exclusion set to affinity 17.
- Automatic reopening is enabled, and the native recovery helper's process/session/executable identity verifies.

The local installer is `dist/OpenCluely-Overlay-Setup-2.5.0.exe` (223,672,883 bytes), SHA-256:

```text
b281879c46f3a15ee7cfc74f429b78de7c7f879b9e2fe269353c5d5af027f3a8
```

This is an unsigned development build. A new CI build can have a different digest. Capture behavior varies by sharing client; third-party process termination and Windows shutdown remain possible. The first-run encryption limitation recorded in earlier setup notes is unchanged. Automated checks do not establish absence of all future bugs.

## Reproduce

```powershell
npm ci
npm test
npm run test:desktop
npm run test:recovery
npm run test:interruption
npm run build:win
```

Desktop checks require an interactive Windows session. Test profiles and artifacts stay outside tracked source. The installer and dependencies are excluded from Git; the Windows workflow builds installers as downloadable Actions artifacts.

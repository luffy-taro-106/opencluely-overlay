# Automatic reopening on Windows 2.3

The installed Windows app enables automatic reopening whenever you open OpenCluely. A separate per-user helper watches its existing main process. If that process exits unexpectedly, the helper attempts to reopen it. This recovers from an interruption; it does not prevent Windows or another authorized process from terminating the app.

## Owner controls

- Turn off **Reopen automatically after a crash or forced termination** in Settings, or use **Reopen automatically** in the tray. The change takes effect immediately, independently of Save settings, including during an active answer. Pausing recovery leaves the overlay running.
- Choose **Quit OpenCluely** in Settings or the tray and confirm the prompt to stop recovery and the app. Canceling the prompt leaves both running. Quit waits for an in-progress recovery change before disarming it.
- Manually opening the app enables recovery again, including opening an already running app. Merely showing the overlay through its shortcut or existing window preserves the pause.
- **Start in tray when I sign in** remains a separate Windows startup preference. Recovery does not create or enable a login entry.
- Windows shutdown, restart and sign-out are allowed. The app and helper disarm recovery for session end rather than trying to outlive the login session.
- If Windows cancels shutdown, previously active recovery is restored. An explicit pause takes precedence over that restoration.

Recovery is available in the installed app. Source, development tests and portable builds do not register production recovery. The feature uses your account without administrator privileges, a scheduled task, or a Windows service. It does not modify another application's settings or stop another application's processes.

## Operation

`recovery-helper-win32-x64.exe` is a small C# program built for the Windows .NET Framework 4.x runtime available on Windows 10/11. It subscribes to process-exit notifications and watches its private state directory for changes. A noninteractive native window receives Windows session-end notifications. There is no healthy-process polling timer and no screen capture in the helper.

The first reopening attempt waits about two seconds. Repeated rapid failures back off to about 4, 8, 16, then 30 seconds. A replacement process must publish its PID within a bounded 10-second handshake. After 60 healthy seconds, the rapid-failure backoff resets. Windows startup scheduling can add delay; reopening is not instantaneous or guaranteed.

The helper checks the expected executable, Windows login session and observed process identity rather than searching for a generic process name. The app publishes state atomically with a random recovery-session token. A delayed automatic launch with a paused or stale token exits before reading credentials or showing the interface. This coordinates a recovery run; it is not a security boundary against software already running with full access to your Windows account.

Disabling recovery disarms its state before waiting for the helper to stop. The overlay remains running. A confirmed Quit then closes the overlay. If the helper itself is killed, Windows does not automatically resurrect it: this design is an ordinary owner-controlled user process, not an unkillable service. Reopening the app or explicitly enabling recovery can start a new helper.

State lives under:

```text
%APPDATA%\OpenCluely Overlay\recovery\state.json
%APPDATA%\OpenCluely Overlay\recovery\helper.json
```

These files describe the recovery session and process readiness. They do not contain provider keys, prompts, conversations or images. Do not delete the entire OpenCluely profile to stop recovery; the profile also contains your encrypted credentials and history.

## Emergency stop

First use Settings or the tray when available. If the interface cannot stay open long enough, this PowerShell command removes only the recovery state, causing the helper to stop and invalidating pending automatic launches:

```powershell
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'OpenCluely Overlay\recovery\state.json') -Force -ErrorAction SilentlyContinue
```

If necessary, use Task Manager to end **recovery-helper-win32-x64.exe**, then **OpenCluely Overlay**. Opening OpenCluely manually enables recovery again. To uninstall, pause recovery, quit the app, and use the Windows uninstaller. The uninstaller preserves the profile by default.

## Limits and verification

With restoration enabled, 2.3.5 encrypts submitted questions and partial output at request start, about once per second while streaming, and on completion/cancellation. Reopening restores the last successful text checkpoint for review and manual retry; it never resends automatically. Unsent drafts, image pixels and output since the last successful save can still be lost. No recovery runs while the computer is off or asleep. Windows session termination, missing files, policy restrictions, terminating the helper, or repeated process kills can prevent reopening. See [resilience details](RESILIENCE.md).

The [Windows port record](WINDOWS-PORT.md) lists current validation. Actual reboot, long-duration use, every third-party closing tool and every meeting client's capture behavior require separate validation. See [Electron's Windows session-end events](https://www.electronjs.org/docs/latest/api/browser-window#event-query-session-end-windows) and [Windows process wait behavior](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.enableraisingevents).

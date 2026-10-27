# Automatic reopening on Windows 2.5.2

The installed Windows app enables automatic reopening whenever you open OpenCluely. A separate per-user helper watches its main process. It attempts to reopen the app after a crash, forced termination, or ordinary Quit. The helper remains a visible, ordinary user-owned Windows process. Windows or another authorized process can terminate it.

## Owner controls

- Turn off **Reopen automatically after Quit, a crash or forced termination** in Settings, or use **Reopen automatically** in the tray. The change takes effect immediately, independently of Save settings, including during an active answer. Pausing recovery leaves the overlay running.
- **Quit and reopen** closes the current app process while preserving its verified recovery helper. The replacement starts in the tray and the existing shortcut shows it again. Saved chats and settings restore. An unfinished answer returns as saved text for review and manual retry; a terminated network request cannot keep streaming and is never automatically resent.
- **Quit completely…** in Settings or the tray asks for confirmation, then stops both the app and its helper. Canceling keeps both running. These actions wait for a pending recovery change; a failed verification leaves the app open. If reopening is paused, ordinary Quit also stops the app.
- Manually opening the app enables recovery again, including opening an already running app. Merely showing the overlay through its shortcut or existing window preserves the pause.
- **Start in tray when I sign in** remains a separate Windows startup preference. Recovery does not create or enable a login entry.
- Windows shutdown, restart and sign-out are allowed. The app and helper disarm recovery for session end rather than trying to outlive the login session.
- If Windows cancels shutdown, previously active recovery is restored. An explicit pause takes precedence over that restoration.

Recovery is available in the installed app. Source, development tests and portable builds do not register production recovery. The feature uses your account without administrator privileges, a scheduled task, or a Windows service. It does not hide processes, inject into other apps, modify another application's settings, or stop another application's processes.

## Operation

`recovery-helper-win32-x64.exe` is a small C# program built for the Windows .NET Framework 4.x runtime available on Windows 10/11. It subscribes to process-exit notifications and watches its private state directory for changes. A noninteractive native window receives Windows session-end notifications. There is no healthy-process polling timer and no screen capture in the helper.

The first reopening attempt waits about two seconds. Repeated rapid failures back off to about 4, 8, 16, then 30 seconds. A replacement process must publish its PID within a bounded 10-second handshake. After 60 healthy seconds, the rapid-failure backoff resets. Windows startup scheduling can add delay; reopening is not instantaneous or guaranteed.

The helper checks the expected executable, Windows login session and observed process identity rather than searching for a generic process name. The app publishes state atomically with a random recovery-session token. A delayed automatic launch with a paused or stale token exits before reading credentials or showing the interface. This coordinates a recovery run; it is not a security boundary against software already running with full access to your Windows account.

Disabling recovery disarms its state before waiting for the helper to stop. The overlay remains running. **Quit completely** disarms it before closing the overlay. If the helper itself is killed, Windows does not automatically resurrect it. Reopening the app or explicitly enabling recovery can start a new helper.

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

If necessary, use Task Manager to end **recovery-helper-win32-x64.exe**, then **OpenCluely Overlay**. Opening OpenCluely manually enables recovery again. To uninstall, choose **Quit completely** and confirm, then use the Windows uninstaller. The uninstaller preserves the profile by default.

## Limits and verification

With restoration enabled, submitted questions and partial output are encrypted at request start, about once per second while streaming, and on completion/cancellation. Version 2.5.2 retries failed state saves with bounded delay even if output pauses, checkpoints window position during continuous movement, and flushes pending state on suspend notifications. Reopening restores the last successful text checkpoint for review and manual retry; it never resends automatically. Unsent drafts, image pixels and output since the last successful save can still be lost. No recovery runs while the computer is off or asleep. Windows session termination, missing files, policy restrictions, terminating the helper, or repeated process kills can prevent reopening. See [resilience details](RESILIENCE.md) and [recovery architecture](RECOVERY-ARCHITECTURE.md).

The [Windows port record](WINDOWS-PORT.md) lists current validation. Actual reboot, long-duration use, every third-party closing tool and every meeting client's capture behavior require separate validation. See [Electron's Windows session-end events](https://www.electronjs.org/docs/latest/api/browser-window#event-query-session-end-windows) and [Windows process wait behavior](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.enableraisingevents).

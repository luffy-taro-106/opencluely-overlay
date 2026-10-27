# Windows 2.5.1 startup and shortcuts

Install the Windows setup executable from Releases, open Settings, and enable **Start in tray when I sign in**. The app registers `com.opencluely.overlay` under the current user's Windows startup entries, pointing to the installed executable with `--background`.

The default executable location is `%LOCALAPPDATA%\Programs\OpenCluely Overlay\OpenCluely Overlay.exe`. Source and portable builds disable startup registration because their paths may be temporary.

After restarting the computer, sign in to Windows and allow startup applications to load. **Ctrl+Alt+Space** then shows or hides the overlay. **Ctrl+Alt+I** toggles click-through, and **Ctrl+Alt+S** captures a screenshot for preview. If a shortcut conflicts with another app, use the tray menu and check the warning in Settings.

Closing or hiding the overlay keeps it running in the tray. With automatic reopening enabled, confirming **Quit and reopen** exits the current instance and leaves its verified helper running; the app reopens hidden in the tray. **Ctrl+Alt+Space** shows it again. If reopening is paused, ordinary Quit leaves it paused. To stop the overlay and helper, choose **Quit completely** and confirm. Canceling either Quit prompt keeps both running. Windows shutdown and sign-out are allowed without confirmation.

The installed app also enables [automatic reopening](AUTOMATIC-REOPENING.md) each time you open it. This restores the app after ordinary Quit or an unexpected exit while the helper is running. Pause it immediately through Settings or the tray; manually opening the app again enables it. The helper creates no login item, scheduled task or Windows service. Changing recovery does not change **Start in tray when I sign in**.

Task Manager and sufficiently privileged software can stop either process. Recovery does not make either process immune to termination. Nothing runs while the laptop is off or asleep. A pending answer is canceled during sleep and can be retried after waking.

Keys and optional saved conversation text restore from `%APPDATA%\OpenCluely Overlay`. Preserve this entire profile when moving or upgrading the app; do not commit it to Git or share it.

Historical version 2.1 check, 14 October 2026: the installed startup command and enabled status were checked, and the user confirmed the physical shortcut opened the overlay. A full reboot was not performed during that verification. This does not establish version 2.3 reboot behavior; see the [current port validation](WINDOWS-PORT.md).

Programmatic startup checks need to account for [Electron's Windows lookup issue for paths containing spaces](https://releases.electronjs.org/pr/54364). The actual startup command must quote the executable path.

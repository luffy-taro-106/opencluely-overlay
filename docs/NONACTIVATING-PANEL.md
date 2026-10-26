# Windows browser-focus behavior

In 2.4.1, dropdowns use in-window listboxes instead of native Windows select popups. Provider, model, reasoning, display, account and saved-chat selections can therefore open and choose an option without activating the overlay. Keyboard interaction remains available after explicitly focusing the overlay. State refreshes preserve an open menu when its choices have not changed.

Adapted from Mac reference 5fd5ab805d465f04586831d67b782853566a8859 on 24 October 2026.

Normal opening, Ctrl+Alt+Space, leaving click-through, screenshot restoration and tray opening use showInactive. The native window starts nonfocusable: Electron maps this to WS_EX_NOACTIVATE and suppresses ordinary mouse activation. Reading, scrolling and pointer controls therefore do not request keyboard focus. Actual browser behavior should be checked in the browser and page being used.

A real pointer click on the question, custom model or API-key field explicitly requests ordinary Windows keyboard focus. Ctrl+Alt+T and the tray's Show and type a question action do the same. This happens automatically without a separate mode switch. Returning to another application restores passive behavior through a deferred blur handler; hiding, renderer recovery and click-through also release keyboard focus. Reapplying settings avoids redundant native focus calls, and the app remains out of the taskbar.

Windows does not provide the Mac AppKit distinction between an inactive application and a key panel receiving ordinary typing. Consequently typing in a Windows text field temporarily activates OpenCluely and may blur the browser. This port does not claim to keep a browser focused while typing in the overlay. Native file dialogs and other explicitly activated windows can also change focus.

The implementation configures only its own window through supported Electron/Win32 behavior. It has no global keyboard hook, browser extension, website injection, keyboard forwarding, or focus-stealing timer. Drafts and passwords are never routed to the underlying browser. No screen, browser or operating-system security settings are changed.

References: [Electron window focusability](https://www.electronjs.org/docs/latest/api/browser-window#winsetfocusablefocusable), [Win32 extended window styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles), and [Electron native implementation](https://github.com/electron/electron/blob/v44.7.0/shell/browser/native_window_views.cc).

// An ordinary, user-controlled Windows process. There is no service, task,
// elevated component, injected code, process protection or anti-termination API.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class RecoveryFiles
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16384 };
    internal static readonly string UserSid = WindowsIdentity.GetCurrent().User.Value;

    internal static string Canonical(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || value.StartsWith(@"\\"))
            throw new InvalidDataException("Recovery requires a local absolute path.");
        return Path.GetFullPath(value);
    }
    internal static bool SamePath(string first, string second)
    {
        try { return String.Equals(Canonical(first), Canonical(second), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
    internal static bool SafeDirectory(string directory)
    {
        try
        {
            for (var current = new DirectoryInfo(Canonical(directory)); current != null; current = current.Parent)
                if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0) return false;
            return Directory.Exists(directory);
        }
        catch { return false; }
    }
    internal static void Prepare(string directory)
    {
        directory = Canonical(directory);
        Directory.CreateDirectory(directory);
        if (!SafeDirectory(directory)) throw new InvalidDataException("Recovery directory is not a real local directory.");
        var owner = new SecurityIdentifier(UserSid);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(owner);
        foreach (var sid in new[] { owner, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(directory, security);
    }
    internal static Dictionary<string, object> Read(string file)
    {
        try
        {
            var info = new FileInfo(file);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length > 16384) return null;
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream, Encoding.UTF8))
                return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }
        catch { return null; }
    }
    internal static void Write(string file, object value)
    {
        string temporary = Path.Combine(Path.GetDirectoryName(file), ".write-" + Guid.NewGuid().ToString());
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                writer.Write(Json.Serialize(value));
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else File.Move(temporary, file);
        }
        finally { try { File.Delete(temporary); } catch { } }
    }
    internal static string Text(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) ? result as string : null;
    }
    internal static int Number(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) && result is int ? (int)result : 0;
    }
    internal static bool Enabled(Dictionary<string, object> value)
    {
        object enabled;
        return value != null && value.TryGetValue("enabled", out enabled) && enabled is bool && (bool)enabled;
    }
    internal static string MutexName(string statePath)
    {
        using (var hash = SHA256.Create())
            return @"Local\OpenCluelyRecovery-" + BitConverter.ToString(hash.ComputeHash(
                Encoding.UTF8.GetBytes(UserSid + "|" + statePath.ToUpperInvariant()))).Replace("-", "");
    }
}

internal sealed class ProcessIdentity : IDisposable
{
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    internal Process Process;
    internal long Birth;
    internal string Executable;
    internal static ProcessIdentity Find(int pid, string expected)
    {
        Process process = null;
        try
        {
            if (pid <= 0) return null;
            process = Process.GetProcessById(pid);
            if (process.HasExited || process.SessionId != Process.GetCurrentProcess().SessionId) { process.Dispose(); return null; }
            string executable = process.MainModule.FileName;
            if (!RecoveryFiles.SamePath(executable, expected)) { process.Dispose(); return null; }
            IntPtr token;
            if (!OpenProcessToken(process.Handle, 8 /* TOKEN_QUERY */, out token)) { process.Dispose(); return null; }
            try
            {
                using (var identity = new WindowsIdentity(token))
                    if (identity.User.Value != RecoveryFiles.UserSid) { process.Dispose(); return null; }
            }
            finally { CloseHandle(token); }
            return new ProcessIdentity { Process = process, Executable = executable, Birth = process.StartTime.ToUniversalTime().Ticks };
        }
        catch { if (process != null) process.Dispose(); return null; }
    }
    public void Dispose() { if (Process != null) Process.Dispose(); }
}

internal sealed class SessionWindow : NativeWindow, IDisposable
{
    private readonly Action sessionEnd;
    internal SessionWindow(Action sessionEnd)
    {
        this.sessionEnd = sessionEnd;
        // A hidden top-level window receives session broadcasts. A message-only
        // HWND does not. No visible window, taskbar button or input focus.
        CreateHandle(new CreateParams { Caption = "OpenCluely recovery", Style = 0, ExStyle = 0x08000080 });
    }
    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0011 /* WM_QUERYENDSESSION */)
        {
            sessionEnd();
            message.Result = new IntPtr(1); // Never veto Windows logoff/shutdown.
            return;
        }
        if (message.Msg == 0x0016 /* WM_ENDSESSION */ && message.WParam != IntPtr.Zero) sessionEnd();
        base.WndProc(ref message);
    }
    public void Dispose() { DestroyHandle(); }
}

internal sealed class RecoverySupervisor : IDisposable
{
    private readonly string statePath, readyPath, directory, sessionId, executablePath;
    private readonly Control dispatcher = new Control();
    private FileSystemWatcher watcher;
    private ProcessIdentity watched;
    private System.Windows.Forms.Timer retryTimer, handshakeTimer;
    private SessionWindow sessionWindow;
    private bool stopped;
    private int rapidFailures;
    private DateTime watchStarted;

    internal RecoverySupervisor(string statePath, string sessionId)
    {
        this.statePath = RecoveryFiles.Canonical(statePath);
        this.directory = Path.GetDirectoryName(this.statePath);
        this.readyPath = Path.Combine(directory, "helper.json");
        this.sessionId = sessionId;
        var initial = ReadState();
        if (initial == null) throw new InvalidDataException("The recovery session is stopped.");
        executablePath = RecoveryFiles.Canonical(RecoveryFiles.Text(initial, "executablePath"));
        if (!executablePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(executablePath))
            throw new InvalidDataException("The application is unavailable.");
        // Capture immutable target/session values once. State changes may only
        // publish a new matching PID or disable this session, never retarget it.
        IntPtr ignored = dispatcher.Handle;
    }
    private Dictionary<string, object> ReadState()
    {
        if (!RecoveryFiles.SafeDirectory(directory)) return null;
        var value = RecoveryFiles.Read(statePath);
        if (RecoveryFiles.Number(value, "version") != 1 || !RecoveryFiles.Enabled(value) ||
            RecoveryFiles.Text(value, "sessionId") != sessionId) return null;
        var executable = RecoveryFiles.Text(value, "executablePath");
        if (executablePath != null && !RecoveryFiles.SamePath(executable, executablePath)) return null;
        return value;
    }
    private void Post(Action action)
    {
        if (stopped) return;
        try { dispatcher.BeginInvoke(action); } catch (InvalidOperationException) { }
    }
    internal bool Start()
    {
        sessionWindow = new SessionWindow(EndSession);
        watcher = new FileSystemWatcher(directory, "state.json");
        watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Security;
        watcher.Changed += (sender, args) => Post(Reconcile);
        watcher.Created += (sender, args) => Post(Reconcile);
        watcher.Deleted += (sender, args) => Post(Reconcile);
        watcher.Renamed += (sender, args) => Post(Reconcile);
        watcher.Error += (sender, args) => Post(Stop); // Fail closed when observation is lost.
        watcher.EnableRaisingEvents = true;
        RecoveryFiles.Write(readyPath, new { version = 1, sessionId = sessionId, pid = Process.GetCurrentProcess().Id,
            executablePath = Process.GetCurrentProcess().MainModule.FileName,
            startTimeTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString() });
        Reconcile();
        return !stopped;
    }
    private void ClearRetry()
    {
        if (retryTimer != null) { retryTimer.Stop(); retryTimer.Dispose(); retryTimer = null; }
    }
    private void ClearHandshake()
    {
        if (handshakeTimer != null) { handshakeTimer.Stop(); handshakeTimer.Dispose(); handshakeTimer = null; }
    }
    private void Reconcile()
    {
        if (stopped) return;
        var state = ReadState();
        if (state == null || !File.Exists(executablePath)) { Stop(); return; }
        var identity = ProcessIdentity.Find(RecoveryFiles.Number(state, "pid"), executablePath);
        if (identity != null)
        {
            ClearRetry(); ClearHandshake();
            if (watched != null && identity.Process.Id == watched.Process.Id && identity.Birth == watched.Birth)
            { identity.Dispose(); return; }
            Watch(identity);
            return;
        }
        if (watched != null)
        {
            if ((DateTime.UtcNow - watchStarted).TotalSeconds >= 60) rapidFailures = 0;
            watched.Dispose(); watched = null;
        }
        if (retryTimer != null || handshakeTimer != null) return;
        retryTimer = new System.Windows.Forms.Timer { Interval = Math.Min(30000, 2000 * (1 << Math.Min(rapidFailures, 4))) };
        retryTimer.Tick += (sender, args) => { ClearRetry(); Reopen(); };
        retryTimer.Start();
    }
    private void Watch(ProcessIdentity identity)
    {
        if (watched != null) watched.Dispose();
        watched = identity; watchStarted = DateTime.UtcNow;
        identity.Process.Exited += (sender, args) => Post(() =>
        {
            if (watched == identity) Reconcile();
        });
        try { identity.Process.EnableRaisingEvents = true; }
        catch { Reconcile(); }
        // Holding the process handle and comparing the recorded birth time
        // prevents a recycled PID from being confused with this process.
        if (identity.Process.HasExited) Post(Reconcile);
    }
    private void Reopen()
    {
        if (stopped) return;
        var state = ReadState();
        if (state == null || !File.Exists(executablePath)) { Stop(); return; }
        var running = ProcessIdentity.Find(RecoveryFiles.Number(state, "pid"), executablePath);
        if (running != null) { Watch(running); return; }
        rapidFailures = Math.Min(rapidFailures + 1, 4);
        try
        {
            var start = new ProcessStartInfo(executablePath, "--background --opencluely-recovery " + sessionId) {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(executablePath)
            };
            // No shell, arguments from disk, key material or inherited Node flags.
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            using (var child = Process.Start(start)) { }
            handshakeTimer = new System.Windows.Forms.Timer { Interval = 10000 };
            handshakeTimer.Tick += (sender, args) => { ClearHandshake(); Reconcile(); };
            handshakeTimer.Start();
        }
        catch { Reconcile(); }
    }
    private void EndSession()
    {
        // Synchronous disk disarm wins over queued retry/process/file events.
        var state = RecoveryFiles.Read(statePath);
        if (RecoveryFiles.Text(state, "sessionId") == sessionId)
        {
            try {
                // Record a native-first Windows query distinctly from an owner
                // pause or helper failure, so a canceled shutdown may restore
                // only recovery that was enabled before this query.
                if (RecoveryFiles.Enabled(state)) {
                    state["reason"] = "windows-session-end";
                    state["wasEnabled"] = true;
                }
                state["enabled"] = false; RecoveryFiles.Write(statePath, state);
            }
            catch { try { File.Delete(statePath); } catch { } }
        }
        Stop();
    }
    private void Stop()
    {
        if (stopped) return;
        stopped = true;
        ClearRetry(); ClearHandshake();
        if (watcher != null) { watcher.Dispose(); watcher = null; }
        if (watched != null) { watched.Dispose(); watched = null; }
        var ready = RecoveryFiles.Read(readyPath);
        if (RecoveryFiles.Text(ready, "sessionId") == sessionId && RecoveryFiles.Number(ready, "pid") == Process.GetCurrentProcess().Id)
            try { File.Delete(readyPath); } catch { }
        Application.ExitThread();
    }
    public void Dispose()
    {
        Stop();
        if (sessionWindow != null) sessionWindow.Dispose();
        dispatcher.Dispose();
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--prepare") { RecoveryFiles.Prepare(args[1]); return 0; }
            if (args.Length == 1 && args[0] == "--probe")
            {
                Console.WriteLine("{\"version\":1,\"platform\":\"win32\",\"processEvents\":true,\"sessionEvents\":true}"); return 0;
            }
            if (args.Length == 4 && args[0] == "--verify-helper" && args[2] == "--session")
            {
                var readyPath = RecoveryFiles.Canonical(args[1]);
                if (!RecoveryFiles.SafeDirectory(Path.GetDirectoryName(readyPath))) return 1;
                var ready = RecoveryFiles.Read(readyPath);
                var executable = Process.GetCurrentProcess().MainModule.FileName;
                if (RecoveryFiles.Number(ready, "version") != 1 || RecoveryFiles.Text(ready, "sessionId") != args[3] ||
                    !RecoveryFiles.SamePath(RecoveryFiles.Text(ready, "executablePath"), executable)) return 1;
                using (var identity = ProcessIdentity.Find(RecoveryFiles.Number(ready, "pid"), executable))
                    return identity != null && RecoveryFiles.Text(ready, "startTimeTicks") == identity.Birth.ToString() ? 0 : 1;
            }
            if (args.Length == 2 && args[0] == "--process-identity")
            {
                int pid;
                if (!Int32.TryParse(args[1], out pid)) return 1;
                string executable;
                using (var process = Process.GetProcessById(pid)) executable = process.MainModule.FileName;
                using (var identity = ProcessIdentity.Find(pid, executable))
                {
                    if (identity == null) return 1;
                    Console.WriteLine(RecoveryFiles.Json.Serialize(new { pid = pid, executablePath = identity.Executable,
                        startTimeTicks = identity.Birth.ToString(), sessionId = Process.GetCurrentProcess().SessionId }));
                }
                return 0;
            }
            Guid session;
            if (args.Length != 4 || args[0] != "--state" || args[2] != "--session" || !Guid.TryParseExact(args[3], "D", out session)) return 1;
            string statePath = RecoveryFiles.Canonical(args[1]);
            using (var mutex = new Mutex(false, RecoveryFiles.MutexName(statePath)))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(5000); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) return 0;
                try
                {
                    using (var supervisor = new RecoverySupervisor(statePath, args[3]))
                    { if (supervisor.Start()) Application.Run(); }
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch { return 1; } // No user data, prompts or provider secrets in logs.
    }
}

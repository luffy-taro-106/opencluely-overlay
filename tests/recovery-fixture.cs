// Disposable native app used only by recovery-native.test.js. It never reads
// OpenCluely's production profile or credentials and opens no visible window.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class RecoveryFixture
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private delegate bool EnumWindow(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr param);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);

    private static void Write(string file, object value)
    {
        var temporary = file + "." + Process.GetCurrentProcess().Id + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
    }
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--query-session-end")
            {
                uint target = UInt32.Parse(args[1]);
                bool sent = false;
                EnumWindows((hwnd, unused) => {
                    uint pid;
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (pid == target) {
                        IntPtr result;
                        sent = SendMessageTimeout(hwnd, 0x0011, IntPtr.Zero, IntPtr.Zero, 2, 2000, out result) != IntPtr.Zero;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
                return sent ? 0 : 1;
            }
            var configFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fixture-config.json");
            var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
            string statePath = (string)config["statePath"], eventPath = (string)config["eventPath"], token = (string)config["sessionId"];
            int index = Array.IndexOf(args, "--opencluely-recovery");
            bool recovered = index >= 0;
            if (recovered)
            {
                if (index + 1 >= args.Length || args[index + 1] != token || !File.Exists(statePath)) return 0;
                var previous = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(statePath));
                if (!(bool)previous["enabled"] || (string)previous["sessionId"] != token) return 0;
            }
            var record = new { pid = Process.GetCurrentProcess().Id, recovered = recovered, time = DateTime.UtcNow.ToString("o") };
            File.AppendAllText(eventPath, Json.Serialize(record) + "\n", new UTF8Encoding(false));
            Write(statePath, new { version = 1, sessionId = token, enabled = true, pid = record.pid,
                executablePath = Process.GetCurrentProcess().MainModule.FileName });
            Application.Run();
            return 0;
        }
        catch { return 1; }
    }
}

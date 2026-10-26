using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

// Test-only native sender. It can address only a window owned by the Electron
// process that launched this fixture, never an arbitrary application or broadcast.
internal static class RequestClose
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int informationClass,
        out ProcessBasicInformation information, int informationLength, out int returnLength);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

    private static int Main(string[] args)
    {
        try
        {
            int targetPid;
            ulong rawHandle;
            if (args.Length != 2 || !Int32.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out targetPid) || targetPid <= 0 ||
                !UInt64.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out rawHandle) || rawHandle == 0 || rawHandle == 0xffff ||
                (IntPtr.Size == 4 && rawHandle > UInt32.MaxValue))
                throw new InvalidOperationException("Expected the parent Electron PID and its window handle in decimal.");

            using (Process self = Process.GetCurrentProcess())
            {
                ProcessBasicInformation information;
                int returned;
                int size = Marshal.SizeOf(typeof(ProcessBasicInformation));
                if (NtQueryInformationProcess(self.Handle, 0, out information, size, out returned) != 0 || returned != size ||
                    information.UniqueProcessId.ToInt64() != self.Id || information.InheritedFromUniqueProcessId.ToInt64() != targetPid)
                    throw new InvalidOperationException("The target must be the Electron process that launched this test fixture.");
            }

            using (Process target = Process.GetProcessById(targetPid))
            {
                if (!String.Equals(Path.GetFileName(target.MainModule.FileName), "electron.exe", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The target must be a development Electron test process.");
            }

            IntPtr window = new IntPtr(unchecked((long)rawHandle));
            uint ownerPid;
            if (GetWindowThreadProcessId(window, out ownerPid) == 0 || ownerPid != (uint)targetPid)
                throw new InvalidOperationException("The supplied window does not belong to the parent Electron process.");

            const uint WmClose = 0x0010;
            const uint AbortIfHungAndBlock = 0x0003;
            UIntPtr messageResult;
            if (SendMessageTimeout(window, WmClose, UIntPtr.Zero, IntPtr.Zero, AbortIfHungAndBlock, 5000, out messageResult) == IntPtr.Zero)
                throw new InvalidOperationException("The normal close request failed or timed out.");
            Console.WriteLine("Normal WM_CLOSE delivered to parent Electron test window.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Native close fixture failed: " + error.Message);
            return 1;
        }
    }
}

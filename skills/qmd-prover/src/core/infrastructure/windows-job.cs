// Join a non-breakaway Job before starting any adapter. The handle is never inherited.
// Process teardown closes KILL_ON_JOB_CLOSE and terminates the complete descendant tree.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public static class ShadowJob {
    private static IntPtr job;
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr h, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr h, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    private static void Enter() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr memory = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, memory, false);
            if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
        } catch { CloseHandle(job); throw; }
        finally { Marshal.FreeHGlobal(memory); }
    }

    private static string Quote(string value) {
        var b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\', slashes * 2 + 1);
            else b.Append('\\', slashes);
            b.Append(c); slashes = 0;
        }
        b.Append('\\', slashes * 2); b.Append('"');
        return b.ToString();
    }

    public static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            Enter(); // Failure aborts before any adapter is launched.
            var header = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Console.ReadLine());
            var args = (System.Collections.IEnumerable)header["args"];
            var quoted = new List<string>();
            foreach (object argument in args) quoted.Add(Quote((string)argument));
            string payload = Console.In.ReadToEnd();
            var native = new Process();
            native.StartInfo.FileName = (string)header["command"];
            native.StartInfo.Arguments = String.Join(" ", quoted);
            native.StartInfo.UseShellExecute = false;
            native.StartInfo.RedirectStandardInput = true;
            native.StartInfo.RedirectStandardOutput = true;
            native.StartInfo.RedirectStandardError = true;
            native.StartInfo.CreateNoWindow = true;
            if (!native.Start()) throw new InvalidOperationException("Could not start contained adapter");
            Task stdout = native.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            Task stderr = native.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            byte[] bytes = Encoding.UTF8.GetBytes(payload);
            native.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
            native.StandardInput.BaseStream.Close();
            native.WaitForExit();
            Task.WaitAll(stdout, stderr);
            return native.ExitCode;
        } catch (Exception error) {
            Console.Error.WriteLine("Windows Job supervisor failed: " + error.Message);
            return 1;
        }
        // Do not dispose the Job handle: keep it alive until process teardown.
    }
}

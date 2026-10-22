# Private supervisor: join a non-breakaway Job before starting ANY adapter.
# The sole job handle is deliberately not inherited. Windows closes it when this
# supervisor exits or is killed, terminating adapters and their CLI descendants.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
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
    public static void Enter() {
        job = CreateJobObject(IntPtr.Zero, null); // default non-inheritable handle
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr memory = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, memory, false);
            if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
        } catch { CloseHandle(job); throw; }
        finally { Marshal.FreeHGlobal(memory); }
        // Retain this handle until process teardown. Closing it explicitly would also
        // kill this supervisor before its intended exit code can be published.
    }
    public static string Quote(string value) {
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
}
'@
try {
    [ShadowJob]::Enter() # Failure is fatal: no uncontained fallback is permitted.
    $header = [Console]::In.ReadLine() | ConvertFrom-Json
    $payload = [Console]::In.ReadToEnd()
    $native = New-Object System.Diagnostics.Process
    $native.StartInfo.FileName = $header.command
    $native.StartInfo.Arguments = (($header.args | ForEach-Object { [ShadowJob]::Quote([string]$_) }) -join ' ')
    $native.StartInfo.UseShellExecute = $false
    $native.StartInfo.RedirectStandardInput = $true
    $native.StartInfo.RedirectStandardOutput = $true
    $native.StartInfo.RedirectStandardError = $true
    $native.StartInfo.CreateNoWindow = $true
    if (-not $native.Start()) { throw 'Could not start contained adapter' }
    $stdout = $native.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
    $stderr = $native.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $native.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $native.StandardInput.BaseStream.Close()
    $native.WaitForExit()
    # Do not wait for descendant-owned pipe handles indefinitely. Process teardown
    # closes the job handle and kills any descendants left after the adapter exits.
    # Completed adapter output is drained before exit; running descendants are killed
    # by the parent's deadline if they keep these streams open.
    [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($stdout, $stderr))
    [Environment]::Exit($native.ExitCode)
} catch {
    [Console]::Error.WriteLine('Windows Job supervisor failed: ' + $_.Exception.Message)
    [Environment]::Exit(1)
}

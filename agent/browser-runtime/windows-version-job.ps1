param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$WorkerPath,
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [int]$CleanupTimeoutMs = 500
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class YeaftBrowserJob {
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const int JobObjectBasicAccountingInformation = 1;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint PROCESS_SET_QUOTA = 0x0100;
    public const uint PROCESS_TERMINATE = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public Int64 TotalUserTime;
        public Int64 TotalKernelTime;
        public Int64 ThisPeriodTotalUserTime;
        public Int64 ThisPeriodTotalKernelTime;
        public UInt32 TotalPageFaultCount;
        public UInt32 TotalProcesses;
        public UInt32 ActiveProcesses;
        public UInt32 TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(
        IntPtr job,
        int infoClass,
        IntPtr info,
        UInt32 length
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryInformationJobObject(
        IntPtr job,
        int infoClass,
        IntPtr info,
        UInt32 length,
        out UInt32 returnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);

    public static string QuoteArgument(string value) {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) {
            return value;
        }
        var output = new StringBuilder();
        output.Append('"');
        var slashes = 0;
        foreach (var ch in value) {
            if (ch == '\\') {
                slashes++;
            } else if (ch == '"') {
                output.Append('\\', slashes * 2 + 1);
                output.Append('"');
                slashes = 0;
            } else {
                output.Append('\\', slashes);
                slashes = 0;
                output.Append(ch);
            }
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }
}
'@

function Throw-Win32Error([string]$Operation) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "$Operation failed with Win32 error $code"
}

$job = [IntPtr]::Zero
$workerHandle = [IntPtr]::Zero
$worker = $null
$resultLine = $null
try {
  $job = [YeaftBrowserJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { Throw-Win32Error 'CreateJobObject' }

  $limit = New-Object YeaftBrowserJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $basicLimit = $limit.BasicLimitInformation
  $basicLimit.LimitFlags = [YeaftBrowserJob]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $limit.BasicLimitInformation = $basicLimit
  $limitSize = [Runtime.InteropServices.Marshal]::SizeOf($limit)
  $limitPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($limitSize)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($limit, $limitPtr, $false)
    if (-not [YeaftBrowserJob]::SetInformationJobObject(
      $job,
      [YeaftBrowserJob]::JobObjectExtendedLimitInformation,
      $limitPtr,
      [uint32]$limitSize
    )) { Throw-Win32Error 'SetInformationJobObject' }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($limitPtr)
  }

  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $NodePath
  $start.Arguments = [YeaftBrowserJob]::QuoteArgument($WorkerPath) + ' ' + [YeaftBrowserJob]::QuoteArgument($ExecutablePath)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true

  $worker = New-Object System.Diagnostics.Process
  $worker.StartInfo = $start
  if (-not $worker.Start()) { throw 'Windows version worker did not start' }
  $workerHandle = [YeaftBrowserJob]::OpenProcess(
    [YeaftBrowserJob]::PROCESS_SET_QUOTA -bor [YeaftBrowserJob]::PROCESS_TERMINATE,
    $false,
    [uint32]$worker.Id
  )
  if ($workerHandle -eq [IntPtr]::Zero) { Throw-Win32Error 'OpenProcess' }
  if (-not [YeaftBrowserJob]::AssignProcessToJobObject($job, $workerHandle)) {
    Throw-Win32Error 'AssignProcessToJobObject'
  }

  $worker.StandardInput.WriteLine('go')
  $worker.StandardInput.Close()
  $resultLine = $worker.StandardOutput.ReadLine()
  if ([string]::IsNullOrWhiteSpace($resultLine)) {
    if (-not $worker.HasExited) {
      [void][YeaftBrowserJob]::TerminateJobObject($job, 1)
      $worker.WaitForExit()
    }
    $workerError = $worker.StandardError.ReadToEnd()
    throw "Windows version worker returned no result ($($worker.ExitCode)): $workerError"
  }

  if (-not [YeaftBrowserJob]::TerminateJobObject($job, 1)) {
    Throw-Win32Error 'TerminateJobObject'
  }

  $accounting = New-Object YeaftBrowserJob+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
  $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
  $accountingPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($accountingSize)
  try {
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1, $CleanupTimeoutMs))
    do {
      [uint32]$returned = 0
      if (-not [YeaftBrowserJob]::QueryInformationJobObject(
        $job,
        [YeaftBrowserJob]::JobObjectBasicAccountingInformation,
        $accountingPtr,
        [uint32]$accountingSize,
        [ref]$returned
      )) { Throw-Win32Error 'QueryInformationJobObject' }
      $accounting = [Runtime.InteropServices.Marshal]::PtrToStructure(
        $accountingPtr,
        [type][YeaftBrowserJob+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION]
      )
      if ($accounting.ActiveProcesses -eq 0) { break }
      Start-Sleep -Milliseconds 10
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($accounting.ActiveProcesses -ne 0) {
      throw "Windows Browser Runtime job still has $($accounting.ActiveProcesses) active process(es)"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($accountingPtr)
  }

  [Console]::Out.WriteLine($resultLine)
} finally {
  if ($workerHandle -ne [IntPtr]::Zero) { [void][YeaftBrowserJob]::CloseHandle($workerHandle) }
  if ($job -ne [IntPtr]::Zero) { [void][YeaftBrowserJob]::CloseHandle($job) }
  if ($null -ne $worker) { $worker.Dispose() }
}

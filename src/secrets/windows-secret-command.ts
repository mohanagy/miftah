import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { resolveExecutablePath } from "./executable-resolver.js";

const maximumRequestBytes = 16 * 1024;
const maximumArgumentCount = 128;
const requestEnvironmentName = "MIFTAH_SECRET_RUNNER_REQUEST";

export interface WindowsSecretCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export interface ResolvedWindowsSecretCommand extends WindowsSecretCommand {
  readonly launcher: string;
}

const windowsJobBootstrap = String.raw`$ErrorActionPreference = 'Stop'
$source = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($source)) { exit 1 }
& ([ScriptBlock]::Create($source))`;
const encodedWindowsJobBootstrap = Buffer.from(windowsJobBootstrap, "utf16le").toString("base64");

/**
 * Resolves Windows provider executables before spawn so Node never performs a
 * current-directory lookup for a bare command.
 */
export async function resolveWindowsSecretCommand(
  command: WindowsSecretCommand
): Promise<ResolvedWindowsSecretCommand | undefined> {
  const launcher = trustedPowerShellExecutable();
  if (launcher === undefined) return undefined;

  const executable = await resolveTargetExecutable(command.executable, command.environment, launcher);
  if (executable === undefined || isBatchFile(executable)) return undefined;
  return { ...command, executable, launcher };
}

/**
 * Starts a fixed helper which joins a kill-on-close Job Object before it
 * creates the provider process. The helper source contains no command data.
 */
export function spawnWindowsSecretCommand(command: ResolvedWindowsSecretCommand): ChildProcess {
  const request = encodeRequest(command);
  if (request === undefined) throw new Error("Invalid Windows secret command request");

  const child = spawn(
    command.launcher,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedWindowsJobBootstrap],
    {
      env: helperEnvironment(command.environment, request),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] as const
    }
  );
  child.stdin.on("error", () => undefined);
  child.stdin.end(windowsJobHelper, "utf8");
  return child;
}

async function resolveTargetExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  launcher: string
): Promise<string | undefined> {
  const pathQualified =
    executable.includes("/") || executable.includes("\\") || win32.isAbsolute(executable);
  if (pathQualified) return win32.isAbsolute(executable) ? executable : undefined;
  if (executable.toLocaleLowerCase("en-US") === "powershell.exe") return launcher;
  return resolveExecutablePath(executable, { environment, platform: "win32" });
}

function trustedPowerShellExecutable(): string | undefined {
  const systemRoot = environmentValue(process.env, "SystemRoot") ?? environmentValue(process.env, "windir") ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot)) return undefined;
  const executable = win32.join(
    win32.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return existsSync(executable) ? executable : undefined;
}

function isBatchFile(executable: string): boolean {
  const extension = win32.extname(executable).toLocaleLowerCase("en-US");
  return extension === ".bat" || extension === ".cmd";
}

function encodeRequest(command: ResolvedWindowsSecretCommand): string | undefined {
  if (command.args.length > maximumArgumentCount || containsNul(command.executable)) return undefined;
  if (command.args.some(containsNul)) return undefined;

  const request = Buffer.from(
    JSON.stringify({
      executable: command.executable,
      arguments: command.args
    }),
    "utf8"
  );
  if (request.byteLength > maximumRequestBytes) return undefined;
  return request.toString("base64");
}

function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

function helperEnvironment(environment: NodeJS.ProcessEnv, request: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment };
  for (const name of ["SystemRoot", "windir", "ComSpec", "TEMP", "TMP"]) {
    if (environmentValue(result, name) === undefined) {
      const inherited = environmentValue(process.env, name);
      if (inherited !== undefined) setEnvironmentValue(result, name, inherited);
    }
  }
  setEnvironmentValue(result, requestEnvironmentName, request);
  return result;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName && value !== undefined) return value;
  }
  return undefined;
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const candidateName of Object.keys(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName) delete environment[candidateName];
  }
  environment[name] = value;
}

const windowsJobHelper = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${requestEnvironmentName}'
try {
  $encodedRequest = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encodedRequest) -or $encodedRequest.Length -gt 21848) { exit 1 }
  $requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  $request = $requestJson | ConvertFrom-Json
  if ($null -eq $request -or $null -eq $request.executable -or $null -eq $request.arguments) { exit 1 }
  $source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MiftahSecretJob
{
    private const uint JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
    private static IntPtr job;

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    public static bool Initialize()
    {
        IntPtr createdJob = CreateJobObjectW(IntPtr.Zero, null);
        if (createdJob == IntPtr.Zero) return false;

        IntPtr information = IntPtr.Zero;
        try
        {
            JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            information = Marshal.AllocHGlobal(length);
            Marshal.StructureToPtr(limits, information, false);
            if (!SetInformationJobObject(createdJob, JobObjectExtendedLimitInformationClass, information, (uint)length)) return false;
            if (!AssignProcessToJobObject(createdJob, GetCurrentProcess())) return false;
            job = createdJob;
            createdJob = IntPtr.Zero;
            return true;
        }
        finally
        {
            if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
            if (createdJob != IntPtr.Zero) CloseHandle(createdJob);
        }
    }

    public static int Run(string executable, string[] arguments)
    {
        if (String.IsNullOrEmpty(executable) || executable.IndexOf('\0') >= 0 || !Path.IsPathRooted(executable)) return 1;
        string extension = Path.GetExtension(executable);
        if (String.Equals(extension, ".bat", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase)) return 1;
        if (arguments == null) return 1;
        foreach (string argument in arguments)
        {
            if (argument == null || argument.IndexOf('\0') >= 0) return 1;
        }

        IntPtr attributeList = IntPtr.Zero;
        IntPtr inheritedHandles = IntPtr.Zero;
        bool initializedAttributeList = false;
        ProcessInformation processInformation = new ProcessInformation();
        try
        {
            IntPtr standardInput = GetStdHandle(-10);
            IntPtr standardOutput = GetStdHandle(-11);
            IntPtr standardError = GetStdHandle(-12);
            if (!IsValidHandle(standardInput) || !IsValidHandle(standardOutput) || !IsValidHandle(standardError)) return 1;
            if (!SetHandleInformation(standardInput, HandleFlagInherit, HandleFlagInherit) ||
                !SetHandleInformation(standardOutput, HandleFlagInherit, HandleFlagInherit) ||
                !SetHandleInformation(standardError, HandleFlagInherit, HandleFlagInherit)) return 1;

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero) return 1;
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize)) return 1;
            initializedAttributeList = true;

            inheritedHandles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(inheritedHandles, 0, standardInput);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size, standardOutput);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size * 2, standardError);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(0x00020002),
                inheritedHandles,
                new IntPtr(IntPtr.Size * 3),
                IntPtr.Zero,
                IntPtr.Zero
            )) return 1;

            StartupInfoEx startupInfo = new StartupInfoEx();
            startupInfo.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startupInfo.StartupInfo.dwFlags = StartfUseStdHandles;
            startupInfo.StartupInfo.hStdInput = standardInput;
            startupInfo.StartupInfo.hStdOutput = standardOutput;
            startupInfo.StartupInfo.hStdError = standardError;
            startupInfo.lpAttributeList = attributeList;

            StringBuilder commandLine = BuildCommandLine(executable, arguments);
            if (!CreateProcessW(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateNoWindow | ExtendedStartupInfoPresent,
                IntPtr.Zero,
                null,
                ref startupInfo,
                out processInformation
            )) return 1;

            WaitForSingleObject(processInformation.hProcess, 0xFFFFFFFF);
            uint exitCode;
            if (!GetExitCodeProcess(processInformation.hProcess, out exitCode) || exitCode > 255) return 1;
            return (int)exitCode;
        }
        finally
        {
            if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
            if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
            if (attributeList != IntPtr.Zero)
            {
                if (initializedAttributeList) DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (inheritedHandles != IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandles);
        }
    }

    private static bool IsValidHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != InvalidHandleValue;
    }

    private static StringBuilder BuildCommandLine(string executable, string[] arguments)
    {
        StringBuilder commandLine = new StringBuilder();
        AppendArgument(commandLine, executable);
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            AppendArgument(commandLine, argument);
        }
        return commandLine;
    }

    private static void AppendArgument(StringBuilder output, string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
        {
            output.Append(argument);
            return;
        }

        output.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
            }
            else if (character == '"')
            {
                output.Append('\\', backslashes * 2 + 1);
                output.Append('"');
                backslashes = 0;
            }
            else
            {
                output.Append('\\', backslashes);
                output.Append(character);
                backslashes = 0;
            }
        }
        output.Append('\\', backslashes * 2);
        output.Append('"');
    }
}
'@
  Add-Type -TypeDefinition $source
  if (-not [MiftahSecretJob]::Initialize()) { exit 1 }
  $arguments = @($request.arguments | ForEach-Object {
    if ($null -eq $_) { throw 'Invalid argument' }
    [string]$_
  })
  $exitCode = [MiftahSecretJob]::Run([string]$request.executable, [string[]]$arguments)
  exit $exitCode
} catch {
  exit 1
}`;

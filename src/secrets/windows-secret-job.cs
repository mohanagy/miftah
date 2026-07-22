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
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        IntPtr pipeAttributes,
        uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr handle,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped
    );

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
        return Run(executable, arguments, null);
    }

    public static int Run(string executable, string[] arguments, byte[] standardInput)
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
        IntPtr providerInput = IntPtr.Zero;
        IntPtr providerInputWriter = IntPtr.Zero;
        bool initializedAttributeList = false;
        ProcessInformation processInformation = new ProcessInformation();
        try
        {
            IntPtr standardOutput = GetStdHandle(-11);
            IntPtr standardError = GetStdHandle(-12);
            if (!IsValidHandle(standardOutput) || !IsValidHandle(standardError)) return 1;
            if (!SetHandleInformation(standardOutput, HandleFlagInherit, HandleFlagInherit) ||
                !SetHandleInformation(standardError, HandleFlagInherit, HandleFlagInherit)) return 1;
            if (standardInput == null)
            {
                providerInput = GetStdHandle(-10);
                if (!IsValidHandle(providerInput) ||
                    !SetHandleInformation(providerInput, HandleFlagInherit, HandleFlagInherit)) return 1;
            }
            else
            {
                if (!CreatePipe(out providerInput, out providerInputWriter, IntPtr.Zero, 0)) return 1;
                if (!SetHandleInformation(providerInput, HandleFlagInherit, HandleFlagInherit) ||
                    !SetHandleInformation(providerInputWriter, HandleFlagInherit, 0)) return 1;
            }

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero) return 1;
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize)) return 1;
            initializedAttributeList = true;

            inheritedHandles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(inheritedHandles, 0, providerInput);
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
            startupInfo.StartupInfo.hStdInput = providerInput;
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

            if (standardInput != null)
            {
                CloseHandle(providerInput);
                providerInput = IntPtr.Zero;
                uint written = 0;
                if (standardInput.Length > 0 &&
                    (!WriteFile(
                        providerInputWriter,
                        standardInput,
                        (uint)standardInput.Length,
                        out written,
                        IntPtr.Zero
                    ) || written != (uint)standardInput.Length)) return 1;
                CloseHandle(providerInputWriter);
                providerInputWriter = IntPtr.Zero;
            }

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
            if (providerInput != IntPtr.Zero) CloseHandle(providerInput);
            if (providerInputWriter != IntPtr.Zero) CloseHandle(providerInputWriter);
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

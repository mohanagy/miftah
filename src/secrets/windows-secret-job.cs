using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class MiftahSecretJob
{
    private const int MaximumRequestBytes = 16 * 1024;
    private const int MaximumArgumentCount = 128;
    private const string RequestEnvironmentName = "MIFTAH_SECRET_RUNNER_REQUEST";
    private const string StandardInputEnvironmentName = "MIFTAH_SECRET_RUNNER_STDIN";
    private const string PrivateConfigWriteRequestEnvironmentName = "MIFTAH_CONFIG_PRIVATE_FILE_WRITE_REQUEST";
    private const byte PrivateConfigWriteRequestVersion = 3;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileShareReadWrite = 0x00000003;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
    private static IntPtr job;

    private sealed class SecretRequest
    {
        public readonly string Executable;
        public readonly string[] Arguments;

        public SecretRequest(string executable, string[] arguments)
        {
            Executable = executable;
            Arguments = arguments;
        }
    }

    private sealed class PrivateConfigWriteRequest
    {
        public readonly string Path;
        public readonly long ByteLength;
        public readonly long CommitDeadlineUtcMilliseconds;

        public PrivateConfigWriteRequest(string path, long byteLength, long commitDeadlineUtcMilliseconds)
        {
            Path = path;
            ByteLength = byteLength;
            CommitDeadlineUtcMilliseconds = commitDeadlineUtcMilliseconds;
        }
    }

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

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
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
    private static extern IntPtr CreateFileW(
        string path,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation information);

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

    public static int Main(string[] arguments)
    {
        if (arguments != null && arguments.Length == 1 &&
            String.Equals(arguments[0], "--write-private-config", StringComparison.Ordinal))
        {
            return RunPrivateConfigWrite();
        }
        if (arguments == null || arguments.Length != 0) return 1;
        try
        {
            string encodedRequest = Environment.GetEnvironmentVariable(
                RequestEnvironmentName,
                EnvironmentVariableTarget.Process
            );
            string encodedStandardInput = Environment.GetEnvironmentVariable(
                StandardInputEnvironmentName,
                EnvironmentVariableTarget.Process
            );
            Environment.SetEnvironmentVariable(RequestEnvironmentName, null, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable(StandardInputEnvironmentName, null, EnvironmentVariableTarget.Process);

            SecretRequest request = DecodeRequest(encodedRequest);
            if (request == null) return 1;
            byte[] standardInput = DecodeStandardInput(encodedStandardInput);
            if (encodedStandardInput != null && standardInput == null) return 1;
            if (!Initialize()) return 1;
            return Run(request.Executable, request.Arguments, standardInput);
        }
        catch
        {
            return 1;
        }
    }

    private static SecretRequest DecodeRequest(string encodedRequest)
    {
        if (String.IsNullOrEmpty(encodedRequest)) return null;
        byte[] payload = Convert.FromBase64String(encodedRequest);
        if (payload.Length == 0 || payload.Length > MaximumRequestBytes) return null;
        UTF8Encoding utf8 = new UTF8Encoding(false, true);
        using (MemoryStream input = new MemoryStream(payload, false))
        using (BinaryReader reader = new BinaryReader(input, utf8))
        {
            if (reader.ReadByte() != 1) return null;
            string executable = ReadString(reader, input, utf8);
            if (executable == null || executable.Length == 0 || executable.IndexOf('\0') >= 0) return null;
            int argumentCount = reader.ReadInt32();
            if (argumentCount < 0 || argumentCount > MaximumArgumentCount) return null;
            string[] requestArguments = new string[argumentCount];
            for (int index = 0; index < argumentCount; index++)
            {
                string argument = ReadString(reader, input, utf8);
                if (argument == null || argument.IndexOf('\0') >= 0) return null;
                requestArguments[index] = argument;
            }
            if (input.Position != input.Length) return null;
            return new SecretRequest(executable, requestArguments);
        }
    }

    private static string ReadString(BinaryReader reader, MemoryStream input, UTF8Encoding utf8)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > MaximumRequestBytes || input.Length - input.Position < length) return null;
        return utf8.GetString(reader.ReadBytes(length));
    }

    private static byte[] DecodeStandardInput(string encodedStandardInput)
    {
        if (encodedStandardInput == null) return null;
        byte[] standardInput = Convert.FromBase64String(encodedStandardInput);
        return standardInput.Length <= MaximumRequestBytes ? standardInput : null;
    }

    private static int RunPrivateConfigWrite()
    {
        try
        {
            string encodedRequest = Environment.GetEnvironmentVariable(
                PrivateConfigWriteRequestEnvironmentName,
                EnvironmentVariableTarget.Process
            );
            Environment.SetEnvironmentVariable(
                PrivateConfigWriteRequestEnvironmentName,
                null,
                EnvironmentVariableTarget.Process
            );
            PrivateConfigWriteRequest request = DecodePrivateConfigWriteRequest(encodedRequest);
            return request == null ? 1 : WritePrivateConfigurationFile(request);
        }
        catch
        {
            return 1;
        }
    }

    private static PrivateConfigWriteRequest DecodePrivateConfigWriteRequest(string encodedRequest)
    {
        if (String.IsNullOrEmpty(encodedRequest)) return null;
        byte[] payload = Convert.FromBase64String(encodedRequest);
        if (payload.Length == 0 || payload.Length > MaximumRequestBytes) return null;
        UTF8Encoding utf8 = new UTF8Encoding(false, true);
        using (MemoryStream input = new MemoryStream(payload, false))
        using (BinaryReader reader = new BinaryReader(input, utf8))
        {
            if (reader.ReadByte() != PrivateConfigWriteRequestVersion) return null;
            string path = ReadString(reader, input, utf8);
            if (String.IsNullOrEmpty(path) || path.IndexOf('\0') >= 0 || !Path.IsPathRooted(path)) return null;
            long byteLength = reader.ReadInt64();
            long commitDeadlineUtcMilliseconds = reader.ReadInt64();
            if (byteLength < 0 || commitDeadlineUtcMilliseconds < 0 || input.Position != input.Length) return null;
            return new PrivateConfigWriteRequest(Path.GetFullPath(path), byteLength, commitDeadlineUtcMilliseconds);
        }
    }

    private static int WritePrivateConfigurationFile(PrivateConfigWriteRequest request)
    {
        List<IntPtr> directoryHandles = new List<IntPtr>();
        string temporaryPath = null;
        bool temporaryCreated = false;
        bool finalCreated = false;
        FileStream stream = null;
        int result = 1;
        try
        {
            FileInfo target = new FileInfo(request.Path);
            DirectoryInfo directory = target.Directory;
            if (directory == null || String.IsNullOrEmpty(target.Name)) return 1;

            List<string> directoryChain = new List<string>();
            DirectoryInfo component = directory;
            while (component != null)
            {
                directoryChain.Add(component.FullName);
                DirectoryInfo parent = component.Parent;
                if (parent == null || String.Equals(parent.FullName, component.FullName, StringComparison.OrdinalIgnoreCase)) break;
                component = parent;
            }
            directoryChain.Reverse();
            foreach (string path in directoryChain)
            {
                IntPtr handle = OpenDirectoryWithoutDeleteSharing(path);
                if (!IsValidHandle(handle)) return 1;
                directoryHandles.Add(handle);
            }

            if (!IsPrivatePath(directory.FullName, true, true, true)) return 1;
            DirectoryInfo ancestor = directory.Parent;
            bool firstAncestor = true;
            while (ancestor != null)
            {
                DirectoryInfo parent = ancestor.Parent;
                if (parent == null || String.Equals(parent.FullName, ancestor.FullName, StringComparison.OrdinalIgnoreCase)) break;
                if (!IsPrivatePath(ancestor.FullName, true, firstAncestor, false)) return 1;
                firstAncestor = false;
                ancestor = parent;
            }

            // A prior helper can be terminated after its atomic move but before
            // Node observes its exit. An already-private exact match is therefore
            // a safe idempotent completion, never an overwrite.
            if (File.Exists(request.Path) || Directory.Exists(request.Path))
            {
                return MatchesExistingPrivateConfigurationFile(request) ? 0 : 2;
            }
            if (!HasTimeForPrivateConfigCommit(request)) return 1;
            SecurityIdentifier identity = WindowsIdentity.GetCurrent().User;
            if (identity == null) return 1;
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(identity);
            security.SetAccessRule(new FileSystemAccessRule(
                identity,
                FileSystemRights.FullControl,
                AccessControlType.Allow
            ));
            temporaryPath = Path.Combine(
                directory.FullName,
                "." + target.Name + "." + Guid.NewGuid().ToString("N") + ".tmp"
            );
            stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileSystemRights.FullControl,
                FileShare.None,
                4096,
                FileOptions.WriteThrough,
                security
            );
            temporaryCreated = true;

            Stream input = Console.OpenStandardInput();
            byte[] buffer = new byte[65536];
            long remaining = request.ByteLength;
            while (remaining > 0)
            {
                if (!HasTimeForPrivateConfigCommit(request)) return 1;
                int count = (int)Math.Min((long)buffer.Length, remaining);
                int read = input.Read(buffer, 0, count);
                if (read <= 0) return 1;
                stream.Write(buffer, 0, read);
                remaining -= read;
            }
            if (input.ReadByte() != -1) return 1;
            stream.Flush(true);
            stream.Dispose();
            stream = null;
            if (!IsPrivatePath(temporaryPath, false, true, true)) return 1;
            if (!HasTimeForPrivateConfigCommit(request)) return 1;
            File.Move(temporaryPath, request.Path);
            temporaryCreated = false;
            finalCreated = true;
            result = 0;
            return 0;
        }
        catch (IOException exception)
        {
            return (exception.HResult & 0xFFFF) == 80 || (exception.HResult & 0xFFFF) == 183 ? 2 : 1;
        }
        catch
        {
            return 1;
        }
        finally
        {
            if (stream != null) stream.Dispose();
            if (result != 0 && temporaryCreated && temporaryPath != null)
            {
                try { File.Delete(temporaryPath); } catch { }
            }
            if (result != 0 && finalCreated)
            {
                try { File.Delete(request.Path); } catch { }
            }
            foreach (IntPtr handle in directoryHandles)
            {
                if (IsValidHandle(handle)) CloseHandle(handle);
            }
        }
    }

    private static bool MatchesExistingPrivateConfigurationFile(PrivateConfigWriteRequest request)
    {
        Stream input = Console.OpenStandardInput();
        FileStream existing = null;
        bool matches = false;
        try
        {
            if (File.Exists(request.Path) && IsPrivatePath(request.Path, false, true, true))
            {
                existing = new FileStream(request.Path, FileMode.Open, FileAccess.Read, FileShare.Read);
                matches = existing.Length == request.ByteLength;
            }
            byte[] inputBuffer = new byte[4096];
            byte[] existingBuffer = new byte[4096];
            long remaining = request.ByteLength;
            while (remaining > 0)
            {
                int count = (int)Math.Min((long)inputBuffer.Length, remaining);
                int inputRead = input.Read(inputBuffer, 0, count);
                if (inputRead <= 0) return false;
                if (matches)
                {
                    int offset = 0;
                    while (offset < inputRead)
                    {
                        int existingRead = existing.Read(existingBuffer, offset, inputRead - offset);
                        if (existingRead <= 0)
                        {
                            matches = false;
                            break;
                        }
                        for (int index = offset; index < offset + existingRead; index++)
                        {
                            if (inputBuffer[index] != existingBuffer[index]) matches = false;
                        }
                        offset += existingRead;
                    }
                }
                remaining -= inputRead;
            }
            if (input.ReadByte() != -1) return false;
            return matches && existing != null && existing.ReadByte() == -1;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (existing != null) existing.Dispose();
        }
    }

    private static bool HasTimeForPrivateConfigCommit(PrivateConfigWriteRequest request)
    {
        const long UnixEpochMilliseconds = 62135596800000L;
        long utcMilliseconds = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond - UnixEpochMilliseconds;
        return utcMilliseconds < request.CommitDeadlineUtcMilliseconds;
    }

    private static IntPtr OpenDirectoryWithoutDeleteSharing(string path)
    {
        IntPtr handle = CreateFileW(
            path,
            FileReadAttributes,
            FileShareReadWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint,
            IntPtr.Zero
        );
        if (!IsValidHandle(handle)) return IntPtr.Zero;
        FileInformation information;
        if (!GetFileInformationByHandle(handle, out information) ||
            (information.Attributes & (FileAttributeDirectory | FileAttributeReparsePoint)) != FileAttributeDirectory)
        {
            CloseHandle(handle);
            return IntPtr.Zero;
        }
        return handle;
    }

    private static bool IsPrivatePath(string path, bool directory, bool requireCurrentOwner, bool requireProtected)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0 ||
            directory != ((attributes & FileAttributes.Directory) != 0)) return false;
        SecurityIdentifier identity = WindowsIdentity.GetCurrent().User;
        if (identity == null) return false;
        AccessControlSections sections = AccessControlSections.Access | AccessControlSections.Owner;
        FileSystemSecurity security = directory
            ? (FileSystemSecurity)Directory.GetAccessControl(path, sections)
            : File.GetAccessControl(path, sections);
        SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner == null || !IsTrustedIdentity(owner.Value, identity.Value) ||
            (requireCurrentOwner && !String.Equals(owner.Value, identity.Value, StringComparison.Ordinal))) return false;
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.DiscretionaryAcl == null || !security.AreAccessRulesCanonical ||
            (requireProtected && !security.AreAccessRulesProtected)) return false;
        int restrictedRights = directory
            ? (int)(
                FileSystemRights.WriteData |
                FileSystemRights.AppendData |
                FileSystemRights.DeleteSubdirectoriesAndFiles |
                FileSystemRights.Delete |
                FileSystemRights.WriteAttributes |
                FileSystemRights.WriteExtendedAttributes |
                FileSystemRights.ChangePermissions |
                FileSystemRights.TakeOwnership
            )
            : (int)(
                FileSystemRights.ReadData |
                FileSystemRights.ReadExtendedAttributes |
                FileSystemRights.ReadAttributes |
                FileSystemRights.WriteData |
                FileSystemRights.AppendData |
                FileSystemRights.Delete |
                FileSystemRights.WriteAttributes |
                FileSystemRights.WriteExtendedAttributes |
                FileSystemRights.ChangePermissions |
                FileSystemRights.TakeOwnership
            );
        AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (AuthorizationRule authorizationRule in rules)
        {
            FileSystemAccessRule rule = authorizationRule as FileSystemAccessRule;
            if (rule == null) return false;
            string ruleIdentity = rule.IdentityReference.Value;
            if (rule.AccessControlType != AccessControlType.Allow || IsTrustedIdentity(ruleIdentity, identity.Value)) continue;
            if ((String.Equals(ruleIdentity, "S-1-3-0", StringComparison.Ordinal) ||
                 String.Equals(ruleIdentity, "S-1-3-1", StringComparison.Ordinal)) &&
                (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            if (((int)rule.FileSystemRights & restrictedRights) != 0) return false;
        }
        return true;
    }

    private static bool IsTrustedIdentity(string value, string currentIdentity)
    {
        return String.Equals(value, currentIdentity, StringComparison.Ordinal) ||
            String.Equals(value, "S-1-5-18", StringComparison.Ordinal) ||
            String.Equals(value, "S-1-5-32-544", StringComparison.Ordinal) ||
            String.Equals(value, "S-1-3-4", StringComparison.Ordinal) ||
            String.Equals(value, "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", StringComparison.Ordinal);
    }

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
        bool ownsProviderInput = false;
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
                ownsProviderInput = true;
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
            if (ownsProviderInput && providerInput != IntPtr.Zero) CloseHandle(providerInput);
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

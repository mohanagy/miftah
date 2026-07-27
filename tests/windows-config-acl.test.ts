import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowsAclMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  spawn: vi.fn()
}));

const windowsSecretJobMocks = vi.hoisted(() => ({
  resolveCheckedWindowsSecretJobExecutable: vi.fn<() => Promise<string | undefined>>()
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: windowsAclMocks.existsSync
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: windowsAclMocks.spawn
}));

vi.mock("../src/secrets/windows-secret-command.js", () => ({
  resolveCheckedWindowsSecretJobExecutable: windowsSecretJobMocks.resolveCheckedWindowsSecretJobExecutable
}));

import {
  copyWindowsConfigSecurityDescriptor,
  copyWindowsConfigSecurityDescriptors,
  createWindowsPrivateDirectoryInPrivateParent,
  createWindowsPrivateMigrationDirectory,
  secureWindowsConfigFile,
  writeWindowsPrivateConfigFile,
  verifyWindowsConfigPathSecurity,
  verifyWindowsConfigPathsSecurity
} from "../src/cli/windows-config-acl.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function createChild(): EventEmitter & { readonly kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { readonly kill: ReturnType<typeof vi.fn> };
  Object.assign(child, { kill: vi.fn() });
  return child;
}

function createWritableChild(): EventEmitter & {
  readonly kill: ReturnType<typeof vi.fn>;
  readonly stdin: EventEmitter & { readonly end: ReturnType<typeof vi.fn> };
} {
  const child = createChild();
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  return Object.assign(child, { stdin });
}

function decodePrivateFileWriteRequest(encoded: string): { readonly version: number; readonly path: string; readonly byteLength: number } {
  const payload = Buffer.from(encoded, "base64");
  let offset = 0;
  const version = payload.readUInt8(offset);
  offset += 1;
  const pathLength = payload.readInt32LE(offset);
  offset += 4;
  const path = payload.subarray(offset, offset + pathLength).toString("utf8");
  offset += pathLength;
  const byteLength = Number(payload.readBigInt64LE(offset));
  offset += 8;
  expect(offset).toBe(payload.byteLength);
  return { version, path, byteLength };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  windowsAclMocks.existsSync.mockReturnValue(true);
  windowsSecretJobMocks.resolveCheckedWindowsSecretJobExecutable.mockResolvedValue(
    "C:\\Program Files\\Miftah\\windows-secret-job.exe"
  );
});

afterEach(() => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  windowsAclMocks.existsSync.mockReset();
  windowsAclMocks.spawn.mockReset();
  windowsSecretJobMocks.resolveCheckedWindowsSecretJobExecutable.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Windows migration ACL boundary", () => {
  it("verifies a current-user-owned non-reparse configuration path without exposing ACL details", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(verifyWindowsConfigPathSecurity("C:\\Users\\miftah\\.config\\miftah", "directory")).resolves.toBe(true);

    const [, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
    expect(Buffer.from(options?.env?.MIFTAH_CONFIG_ACL_REQUEST ?? "", "base64").toString("utf8")).toBe(
      "verify-private-path\u0000directory\u0000C:\\Users\\miftah\\.config\\miftah"
    );
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("verify-private-path");
    expect(command).toContain("WindowsIdentity]::GetCurrent().User");
    expect(command).toContain("FileAttributes]::ReparsePoint");
    expect(command).toContain("S-1-5-18");
    expect(command).toContain("S-1-5-32-544");
    expect(command).toContain("S-1-3-4");
    expect(command).toContain("S-1-3-0");
    expect(command).toContain("S-1-3-1");
    expect(command).toContain("GetAccessRules");
    expect(command).toContain("AreAccessRulesCanonical");
    expect(command).toContain("ReadExtendedAttributes");
    expect(command).toContain("DeleteSubdirectoriesAndFiles");
    expect(command).not.toContain("Write-Output");
  });

  it("fails closed when Windows configuration-path verification cannot establish trusted ACLs", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });

    await expect(verifyWindowsConfigPathSecurity("C:\\Users\\miftah\\.config\\miftah\\gsc.json", "file")).resolves.toBe(false);
  });

  it("verifies multiple stable private paths in one trusted helper without relaxing either check", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(verifyWindowsConfigPathsSecurity([
      { path: "C:\\Users\\miftah\\.config\\miftah", kind: "directory" },
      { path: "C:\\Users\\miftah\\.config\\miftah\\gsc.json", kind: "file" }
    ])).resolves.toBe(true);

    expect(windowsAclMocks.spawn).toHaveBeenCalledOnce();
    const [, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
    expect(Buffer.from(options?.env?.MIFTAH_CONFIG_ACL_REQUEST ?? "", "base64").toString("utf8")).toBe(
      "verify-private-paths\u0000directory\u0000C:\\Users\\miftah\\.config\\miftah\u0000file\u0000C:\\Users\\miftah\\.config\\miftah\\gsc.json"
    );
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("verify-private-paths");
    expect(command).toContain("for ($index = 1; $index -lt $fields.Count; $index += 2)");
    expect(command).toContain("Test-MiftahPrivatePath $path $kind");
    expect(command).toContain("Test-MiftahAncestors ([System.IO.DirectoryInfo]::new($fields[2]).Parent)");
  });

  it("fails closed before launch for an empty or NUL-containing batch verification request", async () => {
    await expect(verifyWindowsConfigPathsSecurity([])).resolves.toBe(false);
    await expect(verifyWindowsConfigPathsSecurity([
      { path: "C:\\Users\\miftah\\.config\\miftah\u0000unexpected", kind: "directory" }
    ])).resolves.toBe(false);
    await expect(verifyWindowsConfigPathsSecurity([
      { path: "C:\\Users\\miftah\\.config\\miftah.json", kind: "file" },
      { path: "C:\\Users\\miftah\\.config\\miftah", kind: "directory" }
    ])).resolves.toBe(false);

    expect(windowsAclMocks.spawn).not.toHaveBeenCalled();
  });

  it("fails closed when source descriptor verification fails", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });

    await expect(copyWindowsConfigSecurityDescriptor("C:\\config\\source.json", "C:\\config\\target.json")).resolves.toBe(false);
  });

  it("applies and verifies a current-user-only descriptor to an exclusively created configuration file", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(secureWindowsConfigFile("C:\\Users\\miftah\\.config\\miftah\\miftah.json")).resolves.toBe(true);

    const [, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
    expect(Buffer.from(options?.env?.MIFTAH_CONFIG_ACL_REQUEST ?? "", "base64").toString("utf8")).toBe(
      "secure-private-file\u0000C:\\Users\\miftah\\.config\\miftah\\miftah.json"
    );
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("secure-private-file");
    expect(command).toContain("FileSecurity]::new()");
    expect(command).toContain("SetAccessRuleProtection($true, $false)");
    expect(command).toContain("FileSystemRights]::FullControl");
    expect(command).toContain("File]::SetAccessControl");
    expect(command).toContain("AreAccessRulesProtected");
    expect(command).toContain("Test-MiftahPrivatePath $path 'file' $null $true");
    expect(command).not.toContain("$actual = [System.IO.File]::GetAccessControl($path, $verifySections)");
  });

  it("writes one new private configuration file through the checked no-delete directory chain helper", async () => {
    const child = createWritableChild();
    windowsAclMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(writeWindowsPrivateConfigFile(
      "C:\\Users\\miftah\\.config\\miftah\\miftah.json",
      "{\"version\":\"3\"}\n"
    )).resolves.toBe("written");

    const [launcher, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(launcher).toBe("C:\\Program Files\\Miftah\\windows-secret-job.exe");
    expect(args).toEqual(["--write-private-config"]);
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"]
    });
    expect(options?.env?.MIFTAH_CONFIG_ACL_REQUEST).toBeUndefined();
    expect(decodePrivateFileWriteRequest(options?.env?.MIFTAH_CONFIG_PRIVATE_FILE_WRITE_REQUEST ?? "")).toEqual({
      version: 2,
      path: "C:\\Users\\miftah\\.config\\miftah\\miftah.json",
      byteLength: 16
    });
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from("{\"version\":\"3\"}\n", "utf8"));
  });

  it("reports an existing configuration file without falling back to a pathname write", async () => {
    const child = createWritableChild();
    windowsAclMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 2));
      return child;
    });

    await expect(writeWindowsPrivateConfigFile("C:\\Users\\miftah\\miftah.json", "{}\n")).resolves.toBe("exists");
  });

  it("creates and verifies a current-user-only private directory before returning", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateMigrationDirectory("C:\\config\\.miftah-private")).resolves.toBe(true);

    const [, args] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("create-private-directory");
    expect(command).toContain("Test-MiftahPrivatePath $directory 'directory' $expected $true");
    expect(command).not.toContain("$actual = $directory.GetAccessControl()");
    expect(command).toContain("[string]$expectedSddl = $null");
    expect(command).toContain("[bool]$requireProtected = $false");
    expect(command).toContain("$expectedSddl.Length -gt 0");
  });

  it("checks an immediate private parent in the same trusted helper before creating its child directory", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateDirectoryInPrivateParent(
      "C:\\Users\\miftah\\.config",
      "C:\\Users\\miftah\\.config\\miftah"
    )).resolves.toBe(true);

    expect(windowsAclMocks.spawn).toHaveBeenCalledOnce();
    const [, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
    expect(Buffer.from(options?.env?.MIFTAH_CONFIG_ACL_REQUEST ?? "", "base64").toString("utf8")).toBe(
      "create-private-directory-in-private-parent\u0000C:\\Users\\miftah\\.config\u0000C:\\Users\\miftah\\.config\\miftah"
    );
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("create-private-directory-in-private-parent");
    expect(command).toContain("GetDirectoryName([System.IO.Path]::GetFullPath($directory.FullName))");
    expect(command).toContain("Test-MiftahPrivatePath $parent 'directory'");
    expect(command).toContain("Test-MiftahPrivatePath $directory 'directory' $expected $true");
  });

  it("requires a trusted non-mutable ancestor chain before accepting a private path", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateDirectoryInPrivateParent(
      "C:\\Users\\miftah\\.config",
      "C:\\Users\\miftah\\.config\\miftah"
    )).resolves.toBe(true);

    const [, args] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("function Test-MiftahAncestors");
    expect(command).toContain("Test-MiftahPrivatePath $ancestor.FullName 'directory' $null $false $false");
    expect(command).toContain("Test-MiftahAncestors $parent.Parent");
  });

  it("keeps the encoded ACL helper below the conservative Windows command-line budget", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateDirectoryInPrivateParent(
      "C:\\Users\\miftah\\.config",
      "C:\\Users\\miftah\\.config\\miftah"
    )).resolves.toBe(true);

    const [, args] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    // `-EncodedCommand` consumes most of the CreateProcess command line by
    // itself. Keep room for the absolute System32 launcher and fixed flags.
    expect(args?.[4].length).toBeLessThanOrEqual(30_000);
  });

  it("fails closed before launch when the parent-checked directory request contains a NUL byte", async () => {
    await expect(createWindowsPrivateDirectoryInPrivateParent(
      "C:\\Users\\miftah\\.config\u0000unexpected",
      "C:\\Users\\miftah\\.config\\miftah"
    )).resolves.toBe(false);

    expect(windowsAclMocks.spawn).not.toHaveBeenCalled();
  });

  it("copies a non-null binary descriptor and verifies the persisted access rules", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(copyWindowsConfigSecurityDescriptor("C:\\config\\source.json", "C:\\config\\target.json")).resolves.toBe(true);

    const [, args] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("RawSecurityDescriptor");
    expect(command).toContain("$null -eq $sourceRaw.DiscretionaryAcl");
    expect(command).toContain("GetSecurityDescriptorBinaryForm");
    expect(command).toContain("$targetAcl.SetSecurityDescriptorBinaryForm");
    expect(command).toContain("$sourceAcl.GetAccessRules");
    expect(command).toContain("$verifiedAcl.GetAccessRules");
    expect(command).toContain("$sourceRule.IdentityReference.Value -cne $verifiedRule.IdentityReference.Value");
    expect(command).not.toContain("$verifiedAcl.GetSecurityDescriptorBinaryForm");
  });

  it("copies a source descriptor onto both exclusively created migration files in one helper", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(
      copyWindowsConfigSecurityDescriptors("C:\\config\\source.json", [
        "C:\\config\\backup.json",
        "C:\\config\\candidate.json"
      ])
    ).resolves.toBe(true);

    expect(windowsAclMocks.spawn).toHaveBeenCalledOnce();
    const [, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
    expect(Buffer.from(options?.env?.MIFTAH_CONFIG_ACL_REQUEST ?? "", "base64").toString("utf8")).toBe(
      "copy-file-security-batch\u0000C:\\config\\source.json\u0000C:\\config\\backup.json\u0000C:\\config\\candidate.json"
    );
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).toContain("copy-file-security-batch");
    expect(command).toContain("foreach ($target in $targets)");
  });

  it("fails closed before launch when either batch target contains a NUL byte", async () => {
    await expect(
      copyWindowsConfigSecurityDescriptors("C:\\config\\source.json", [
        "C:\\config\\backup.json\u0000unexpected",
        "C:\\config\\candidate.json"
      ])
    ).resolves.toBe(false);
    await expect(
      copyWindowsConfigSecurityDescriptors("C:\\config\\source.json", [
        "C:\\config\\backup.json",
        "C:\\config\\candidate.json\u0000unexpected"
      ])
    ).resolves.toBe(false);

    expect(windowsAclMocks.spawn).not.toHaveBeenCalled();
  });

  it("fails closed rather than replacing malformed Unicode in a private directory path", async () => {
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateMigrationDirectory("C:\\config\\\uD800")).resolves.toBe(false);
    expect(windowsAclMocks.spawn).not.toHaveBeenCalled();
  });

  it("kills an unverified ACL helper that exceeds its bounded execution time", async () => {
    vi.useFakeTimers();
    const child = createChild();
    windowsAclMocks.spawn.mockReturnValue(child);

    const result = createWindowsPrivateMigrationDirectory("C:\\config\\.miftah-migrate-transaction");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("uses the trusted launcher with a module-free minimal environment", async () => {
    vi.stubEnv("MIFTAH_UNRELATED_SECRET", "test-secret-sentinel");
    vi.stubEnv("PSModulePath", "C:\\attacker\\modules");
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateMigrationDirectory("C:\\config\\.miftah-migrate-transaction")).resolves.toBe(true);

    const [launcher, args, options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(launcher).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)]);
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: "ignore" });
    expect(options?.env).not.toHaveProperty("MIFTAH_UNRELATED_SECRET");
    expect(options?.env).not.toHaveProperty("PSModulePath");
    const command = Buffer.from(args?.[4] ?? "", "base64").toString("utf16le");
    expect(command).not.toContain("ConvertFrom-Json");
    expect(command).not.toContain("New-Object");
  });

  it("does not let caller-supplied Windows-root overrides choose the ACL helper launcher", async () => {
    vi.stubEnv("SystemRoot", "C:\\attacker");
    vi.stubEnv("windir", "C:\\attacker");
    windowsAclMocks.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(createWindowsPrivateMigrationDirectory("C:\\config\\.miftah-migrate-transaction")).resolves.toBe(true);

    const [launcher, , options] = windowsAclMocks.spawn.mock.calls[0] ?? [];
    expect(launcher).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(options?.env).toMatchObject({ SystemRoot: "C:\\Windows", windir: "C:\\Windows" });
  });
});

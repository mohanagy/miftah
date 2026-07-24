import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowsAclMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  spawn: vi.fn()
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: windowsAclMocks.existsSync
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: windowsAclMocks.spawn
}));

import {
  copyWindowsConfigSecurityDescriptor,
  createWindowsPrivateMigrationDirectory,
  secureWindowsConfigFile,
  verifyWindowsConfigPathSecurity
} from "../src/cli/windows-config-acl.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function createChild(): EventEmitter & { readonly kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { readonly kill: ReturnType<typeof vi.fn> };
  Object.assign(child, { kill: vi.fn() });
  return child;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  windowsAclMocks.existsSync.mockReturnValue(true);
});

afterEach(() => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  windowsAclMocks.existsSync.mockReset();
  windowsAclMocks.spawn.mockReset();
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
    expect(command).toContain("Test-MiftahPrivatePath $path 'file'");
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

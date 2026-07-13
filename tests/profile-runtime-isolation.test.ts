import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ProfileConfig } from "../src/config/types.js";
import { buildContainerIsolationArguments, ProfileRuntimeIsolation } from "../src/isolation/profile-runtime-isolation.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import { mergeProfileIsolation } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const unsupportedChmod = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: (path: Parameters<typeof actual.chmod>[0], mode: Parameters<typeof actual.chmod>[1]) => {
      if (unsupportedChmod.enabled) {
        throw Object.assign(new Error("simulated unsupported chmod"), { code: "EOPNOTSUPP" });
      }
      return actual.chmod(path, mode);
    }
  };
});

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const supportsNativeProfileRuntimeIsolation = process.platform !== "win32";

interface IsolationReport {
  home: string;
  xdgConfigHome: string;
  xdgCacheHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
  xdgRuntimeDir: string;
  credentialPath: string;
  credential: string;
}

async function readReport(path: string): Promise<IsolationReport> {
  return JSON.parse(await readFile(path, "utf8")) as IsolationReport;
}

describe("profile runtime isolation", () => {
  it.skipIf(!supportsNativeProfileRuntimeIsolation)("namespaces runtime state by canonical config file rather than only its directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-config-identity-"));
    const workConfigPath = join(directory, "work.miftah.json");
    const personalConfigPath = join(directory, "personal.miftah.json");
    await writeFile(workConfigPath, "{}", "utf8");
    await writeFile(personalConfigPath, "{}", "utf8");
    const workRedactor = new SecretRedactor();
    const personalRedactor = new SecretRedactor();

    try {
      const work = await new ProfileRuntimeIsolation({ configPath: workConfigPath, redactor: workRedactor }).prepare(
        "default",
        "default",
        {},
        "stdio"
      );
      const personal = await new ProfileRuntimeIsolation({ configPath: personalConfigPath, redactor: personalRedactor }).prepare(
        "default",
        "default",
        {},
        "stdio"
      );

      expect(dirname(work.environment.HOME!)).not.toBe(dirname(personal.environment.HOME!));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("wires configuration-relative file isolation through the production runtime factory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-runtime-"));
    const credentialsDirectory = join(directory, "credentials");
    const configPath = join(directory, "miftah.json");
    const sourcePath = join(credentialsDirectory, "oauth.json");
    const reportPath = join(directory, "report.json");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(sourcePath, "runtime-factory-oauth-secret", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "runtime-isolation",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
        profiles: {
          work: {
            env: { TEST_ISOLATION_REPORT_PATH: reportPath },
            isolation: {
              files: [
                {
                  source: "credentials/oauth.json",
                  destination: "credentials/oauth.json",
                  environment: "OAUTH_CREDENTIAL_PATH"
                }
              ]
            }
          }
        }
      }),
      "utf8"
    );

    const runtime = await createRuntime(configPath);
    try {
      await runtime.manager.get("work");
      expect((await readReport(reportPath)).credential).toBe("runtime-factory-oauth-secret");
    } finally {
      await runtime.manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("adds named-upstream file mappings to the profile isolation tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-bundle-"));
    const credentialsDirectory = join(directory, "credentials");
    const configPath = join(directory, "miftah.json");
    const reportPath = join(directory, "report.json");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(join(credentialsDirectory, "base.json"), "profile-base-secret", "utf8");
    await writeFile(join(credentialsDirectory, "github.json"), "github-target-secret", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "bundle-isolation",
        defaultProfile: "work",
        upstreams: { github: { transport: "stdio", command: process.execPath, args: [fixture] } },
        profiles: {
          work: {
            env: { TEST_ISOLATION_REPORT_PATH: reportPath },
            isolation: {
              files: [{ source: "credentials/base.json", destination: "credentials/base.json", environment: "BASE_CREDENTIAL_PATH" }]
            },
            upstreams: {
              github: {
                isolation: {
                  files: [
                    {
                      source: "credentials/github.json",
                      destination: "credentials/github.json",
                      environment: "OAUTH_CREDENTIAL_PATH"
                    }
                  ]
                }
              }
            }
          }
        }
      }),
      "utf8"
    );

    const runtime = await createRuntime(configPath);
    try {
      await runtime.manager.get("work", "github");
      const report = await readReport(reportPath);
      expect(report.credential).toBe("github-target-secret");
      await expect(readFile(join(dirname(report.home), "credentials", "base.json"), "utf8")).resolves.toBe("profile-base-secret");
    } finally {
      await runtime.manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("materializes independent owner-restricted credential homes before each STDIO profile starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-"));
    const credentialsDirectory = join(directory, "credentials");
    const configPath = join(directory, "miftah.json");
    const workSource = join(credentialsDirectory, "work-oauth.json");
    const personalSource = join(credentialsDirectory, "personal-oauth.json");
    const workReportPath = join(directory, "work-report.json");
    const personalReportPath = join(directory, "personal-report.json");
    const workCredential = '{"refresh_token":"work-oauth-secret"}';
    const personalCredential = '{"refresh_token":"personal-oauth-secret"}';
    await writeFile(configPath, "{}", "utf8");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(workSource, workCredential, "utf8");
    await writeFile(personalSource, personalCredential, "utf8");

    const stderr: string[] = [];
    const redactor = new SecretRedactor();
    const profiles: Record<string, ProfileConfig> = {
      work: {
        env: {
          HOME: "unsafe-work-home",
          XDG_CONFIG_HOME: "unsafe-work-xdg",
          TEST_ISOLATION_REPORT_PATH: workReportPath,
          TEST_ISOLATION_EMIT_CREDENTIAL: "true",
          TEST_ISOLATION_EMIT_CREDENTIAL_FIELD: "refresh_token"
        },
        isolation: {
          files: [
            {
              source: "credentials/work-oauth.json",
              destination: "credentials/oauth.json",
              environment: "OAUTH_CREDENTIAL_PATH"
            }
          ]
        }
      },
      personal: {
        env: {
          HOME: "unsafe-personal-home",
          XDG_CONFIG_HOME: "unsafe-personal-xdg",
          TEST_ISOLATION_REPORT_PATH: personalReportPath,
          TEST_ISOLATION_EMIT_CREDENTIAL: "true",
          TEST_ISOLATION_EMIT_CREDENTIAL_FIELD: "refresh_token"
        },
        isolation: {
          files: [
            {
              source: "credentials/personal-oauth.json",
              destination: "credentials/oauth.json",
              environment: "OAUTH_CREDENTIAL_PATH"
            }
          ]
        }
      }
    };
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });
    const manager = new UpstreamProcessManager(
      { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles,
      { startupTimeoutMs: 1_000, redactor, isolation, onStderr: (_profile, message) => stderr.push(message) }
    );

    try {
      await manager.get("work");
      await manager.get("personal");

      const [work, personal] = await Promise.all([readReport(workReportPath), readReport(personalReportPath)]);
      expect(work.credential).toBe(workCredential);
      expect(personal.credential).toBe(personalCredential);
      expect(work.credentialPath).not.toBe(personal.credentialPath);
      expect(dirname(work.home)).not.toBe(dirname(personal.home));
      expect(work.home).not.toBe("unsafe-work-home");
      expect(work.xdgConfigHome).not.toBe("unsafe-work-xdg");
      expect(work.xdgConfigHome).toContain(dirname(work.home));
      expect(work.xdgCacheHome).toContain(dirname(work.home));
      expect(work.xdgDataHome).toContain(dirname(work.home));
      expect(work.xdgStateHome).toContain(dirname(work.home));
      expect(work.xdgRuntimeDir).toContain(dirname(work.home));
      expect(stderr.join("\n")).not.toContain(workCredential);
      expect(stderr.join("\n")).not.toContain(personalCredential);
      expect(stderr.join("\n")).not.toContain("work-oauth-secret");
      expect(stderr.join("\n")).not.toContain("personal-oauth-secret");
      expect(stderr.join("\n")).toContain("[REDACTED]");
      expect(redactor.redactText(workCredential)).toContain("[REDACTED]");

      if (process.platform !== "win32") {
        expect((await stat(work.home)).mode & 0o777).toBe(0o700);
        expect((await stat(personal.home)).mode & 0o777).toBe(0o700);
        expect((await stat(work.credentialPath)).mode & 0o777).toBe(0o600);
        expect((await stat(personal.credentialPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("atomically rematerializes mapped files on restart and never deletes source files or runtime state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-restart-"));
    const credentialsDirectory = join(directory, "credentials");
    const configPath = join(directory, "miftah.json");
    const sourcePath = join(credentialsDirectory, "oauth.json");
    const reportPath = join(directory, "report.json");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(configPath, "{}", "utf8");
    await writeFile(sourcePath, "first-oauth-secret", "utf8");

    const redactor = new SecretRedactor();
    const manager = new UpstreamProcessManager(
      { transport: "stdio", command: process.execPath, args: [fixture] },
      {
        work: {
          env: { TEST_ISOLATION_REPORT_PATH: reportPath },
          isolation: {
            files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json", environment: "OAUTH_CREDENTIAL_PATH" }]
          }
        }
      },
      {
        startupTimeoutMs: 1_000,
        redactor,
        isolation: new ProfileRuntimeIsolation({ configPath, redactor })
      }
    );

    try {
      await manager.get("work");
      const first = await readReport(reportPath);
      await writeFile(sourcePath, "second-oauth-secret", "utf8");
      await manager.restart("work");
      const second = await readReport(reportPath);

      expect(first.credential).toBe("first-oauth-secret");
      expect(second.credential).toBe("second-oauth-secret");
      expect(second.credentialPath).toBe(first.credentialPath);
      expect(await readFile(sourcePath, "utf8")).toBe("second-oauth-secret");

      await manager.close();
      const finalStats = await stat(second.credentialPath);
      expect(finalStats.isFile()).toBe(true);
    } finally {
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed without exposing an escaped source path or its content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-escape-"));
    const configPath = join(directory, "miftah.json");
    const secret = "outside-profile-oauth-secret";
    const outsidePath = join(dirname(directory), "outside-oauth.json");
    await writeFile(configPath, "{}", "utf8");
    await writeFile(outsidePath, secret, "utf8");
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });

    try {
      let failure: unknown;
      try {
        await isolation.prepare(
          "work",
          "default",
          {
            files: [{ source: "../outside-oauth.json", destination: "credentials/oauth.json", environment: "OAUTH_CREDENTIAL_PATH" }]
          },
          "stdio"
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "UPSTREAM_START_FAILED" });
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message).not.toContain(outsidePath);
      expect(message).not.toContain(secret);
    } finally {
      await rm(outsidePath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("rejects a configuration-root source symlink before reading its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-symlink-"));
    const configPath = join(directory, "miftah.json");
    const credentialsDirectory = join(directory, "credentials");
    const externalPath = join(dirname(directory), "external-oauth.json");
    const linkPath = join(credentialsDirectory, "oauth.json");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(configPath, "{}", "utf8");
    await writeFile(externalPath, "external-oauth-secret", "utf8");
    await symlink(externalPath, linkPath);
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });

    try {
      await expect(
        isolation.prepare(
          "work",
          "default",
          { files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }] },
          "stdio"
        )
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      expect(redactor.redactText("external-oauth-secret")).toBe("external-oauth-secret");
    } finally {
      await rm(externalPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("rejects a group- or world-writable mapped credential source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-writable-source-"));
    const configPath = join(directory, "miftah.json");
    const credentialsDirectory = join(directory, "credentials");
    const sourcePath = join(credentialsDirectory, "oauth.json");
    const secret = "writable-source-oauth-secret";
    await writeFile(configPath, "{}", "utf8");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(sourcePath, secret, "utf8");
    await chmod(sourcePath, 0o666);
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });

    try {
      const initial = await isolation.prepare("work", "default", {}, "stdio");
      const destination = join(dirname(initial.environment.HOME!), "credentials", "oauth.json");
      let failure: unknown;
      try {
        await isolation.prepare(
          "work",
          "default",
          { files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }] },
          "stdio"
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "UPSTREAM_START_FAILED" });
      expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(secret);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(redactor.redactText(secret)).toBe(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("rejects a mapped credential below a group- or world-writable source directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-writable-source-directory-"));
    const configPath = join(directory, "miftah.json");
    const credentialsDirectory = join(directory, "credentials");
    const sourcePath = join(credentialsDirectory, "oauth.json");
    const secret = "writable-source-directory-oauth-secret";
    await writeFile(configPath, "{}", "utf8");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(sourcePath, secret, "utf8");
    await chmod(directory, 0o755);
    await chmod(credentialsDirectory, 0o777);
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });

    try {
      const initial = await isolation.prepare("work", "default", {}, "stdio");
      const destination = join(dirname(initial.environment.HOME!), "credentials", "oauth.json");
      let failure: unknown;
      try {
        await isolation.prepare(
          "work",
          "default",
          { files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }] },
          "stdio"
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "UPSTREAM_START_FAILED" });
      expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(secret);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(redactor.redactText(secret)).toBe(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("does not claim a pre-existing target runtime directory without its ownership marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-marker-"));
    const configPath = join(directory, "miftah.json");
    await writeFile(configPath, "{}", "utf8");
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });

    try {
      const initial = await isolation.prepare("work", "default", {}, "stdio");
      const root = dirname(initial.environment.HOME!);
      const markerPath = join(root, ".miftah-profile-isolation.json");
      const sentinelPath = join(root, "user-owned.txt");
      await rm(markerPath);
      await writeFile(sentinelPath, "do-not-overwrite", "utf8");

      await expect(isolation.prepare("work", "default", {}, "stdio")).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("do-not-overwrite");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects mapped files that would override a managed isolation environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-reserved-environment-"));
    const configPath = join(directory, "miftah.json");
    const credentialsDirectory = join(directory, "credentials");
    await writeFile(configPath, "{}", "utf8");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(join(credentialsDirectory, "oauth.json"), "reserved-environment-secret", "utf8");
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor });

    try {
      await expect(
        isolation.prepare(
          "work",
          "default",
          {
            files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json", environment: "home" }]
          },
          "stdio"
        )
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      expect(redactor.redactText("reserved-environment-secret")).toBe("reserved-environment-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")(
    "rejects a pre-existing runtime tree owned by another user",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-owner-"));
      const configPath = join(directory, "miftah.json");
      await writeFile(configPath, "{}", "utf8");
      const ownerUid = process.getuid!();
      const initial = new ProfileRuntimeIsolation({ configPath, redactor: new SecretRedactor() });
      const mismatchedOwner = new ProfileRuntimeIsolation({
        configPath,
        redactor: new SecretRedactor(),
        ownerUid: ownerUid + 1
      });

      try {
        await initial.prepare("work", "default", {}, "stdio");
        await expect(mismatchedOwner.prepare("work", "default", {}, "stdio")).rejects.toMatchObject({
          code: "UPSTREAM_START_FAILED"
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("fails closed for Windows profile isolation until a restrictive DACL can be installed and verified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-windows-dacl-"));
    const configPath = join(directory, "miftah.json");
    await writeFile(configPath, "{}", "utf8");
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor: new SecretRedactor(), platform: "win32" });

    try {
      await expect(isolation.prepare("work", "default", {}, "stdio")).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("fails closed when the filesystem cannot enforce restrictive runtime modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-unsupported-chmod-"));
    const credentialsDirectory = join(directory, "credentials");
    const configPath = join(directory, "miftah.json");
    await writeFile(configPath, "{}", "utf8");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(join(credentialsDirectory, "oauth.json"), "unsupported-chmod-oauth-secret", "utf8");
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor: new SecretRedactor() });

    try {
      unsupportedChmod.enabled = true;
      await expect(
        isolation.prepare(
          "work",
          "default",
          { files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }] },
          "stdio"
        )
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
    } finally {
      unsupportedChmod.enabled = false;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["darwin"] as const)(
    "rejects %s-equivalent runtime destinations before materializing either file",
    async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-windows-"));
    const configPath = join(directory, "miftah.json");
    const credentialsDirectory = join(directory, "credentials");
    await writeFile(configPath, "{}", "utf8");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(join(credentialsDirectory, "first.json"), "first-secret", "utf8");
    await writeFile(join(credentialsDirectory, "second.json"), "second-secret", "utf8");
    const redactor = new SecretRedactor();
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor, platform });

    try {
      await expect(
        isolation.prepare(
          "work",
          "default",
          {
            files: [
              { source: "credentials/first.json", destination: "credentials/oauth", environment: "FIRST_CREDENTIAL_PATH" },
              { source: "credentials/second.json", destination: "credentials/oauth.", environment: "SECOND_CREDENTIAL_PATH" }
            ]
          },
          "stdio"
        )
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    }
  );

  it("generates ordered read-only Docker bind mounts and container environment bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-docker-"));
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "xdg", "config"), { recursive: true });
    await mkdir(join(root, "credentials"), { recursive: true });
    await writeFile(join(root, "credentials", "oauth.json"), "container-oauth-secret", "utf8");

    try {
      const canonicalRoot = await realpath(root);
      await expect(
        buildContainerIsolationArguments(
          "/usr/local/bin/docker",
          ["run", "-it", "--rm", "registry.example/mcp@sha256:abc", "stdio"],
          root,
          [
            { source: "home", destination: "/home/miftah" },
            { source: "xdg/config", destination: "/var/lib/miftah/config" },
            {
              source: "credentials/oauth.json",
              destination: "/run/miftah/oauth.json",
              environment: "OAUTH_CREDENTIAL_PATH"
            }
          ],
          {}
        )
      ).resolves.toEqual([
        "run",
        "--mount",
        `type=bind,src=${join(canonicalRoot, "home")},dst=/home/miftah,readonly`,
        "--env",
        "HOME=/home/miftah",
        "--env",
        "USERPROFILE=/home/miftah",
        "--mount",
        `type=bind,src=${join(canonicalRoot, "xdg", "config")},dst=/var/lib/miftah/config,readonly`,
        "--env",
        "XDG_CONFIG_HOME=/var/lib/miftah/config",
        "--mount",
        `type=bind,src=${join(canonicalRoot, "credentials", "oauth.json")},dst=/run/miftah/oauth.json,readonly`,
        "--env",
        "OAUTH_CREDENTIAL_PATH=/run/miftah/oauth.json",
        "-it",
        "--rm",
        "registry.example/mcp@sha256:abc",
        "stdio"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicitly writable Podman mounts and unrelated container environment bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-podman-"));
    await mkdir(join(root, "appdata"), { recursive: true });

    try {
      const canonicalRoot = await realpath(root);
      await expect(
        buildContainerIsolationArguments(
          "podman.exe",
          ["run", "-e", "UNRELATED=value", "image", "stdio"],
          root,
          [{ source: "appdata", destination: "/var/lib/app", readOnly: false }],
          {},
          "linux"
        )
      ).resolves.toEqual([
        "run",
        "--mount",
        `type=bind,src=${join(canonicalRoot, "appdata")},dst=/var/lib/app`,
        "--env",
        "APPDATA=/var/lib/app",
        "-e",
        "UNRELATED=value",
        "image",
        "stdio"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not give a case-distinct runtime path generated HOME/XDG semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-container-case-"));
    await mkdir(join(root, "Home"), { recursive: true });

    try {
      const args = await buildContainerIsolationArguments(
        "docker",
        ["run", "image"],
        root,
        [{ source: "Home", destination: "/case-distinct" }],
        {}
      );
      expect(args).toEqual([
        "run",
        "--mount",
        `type=bind,src=${join(await realpath(root), "Home")},dst=/case-distinct,readonly`,
        "image"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("returns generated Docker argv from the prepared profile target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-prepared-container-"));
    const configPath = join(directory, "miftah.json");
    const credentialsDirectory = join(directory, "credentials");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(configPath, "{}", "utf8");
    await writeFile(join(credentialsDirectory, "oauth.json"), "prepared-container-oauth-secret", "utf8");
    const isolation = new ProfileRuntimeIsolation({ configPath, redactor: new SecretRedactor() });

    try {
      const prepared = await isolation.prepare(
        "work",
        "default",
        {
          files: [
            {
              source: "credentials/oauth.json",
              destination: "credentials/oauth.json",
              environment: "OAUTH_CREDENTIAL_PATH"
            }
          ],
          containerVolumes: [
            {
              source: "credentials/oauth.json",
              destination: "/run/miftah/oauth.json",
              environment: "OAUTH_CREDENTIAL_PATH"
            }
          ]
        },
        "stdio",
        "docker",
        ["run", "image", "stdio"],
        {}
      );

      expect(prepared.args).toEqual([
        "run",
        "--mount",
        `type=bind,src=${prepared.environment.OAUTH_CREDENTIAL_PATH},dst=/run/miftah/oauth.json,readonly`,
        "--env",
        "OAUTH_CREDENTIAL_PATH=/run/miftah/oauth.json",
        "image",
        "stdio"
      ]);
      expect(prepared.suppressStderr).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe container commands, mounts, and generated environment conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-container-reject-"));
    await mkdir(join(root, "home"), { recursive: true });
    const volume = [{ source: "home", destination: "/home/miftah" }];

    try {
      await expect(buildContainerIsolationArguments(process.execPath, ["run", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["run", "--mount", "type=tmpfs,dst=/x", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["run", "--env=HOME=/unsafe", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["run", "-itv", "/host:/mnt", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["run", "-iteHOME=/unsafe", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["run", "--tmpfs", "/home/miftah", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["run", "--device", "/dev/fuse", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
      await expect(buildContainerIsolationArguments("docker", ["create", "image"], root, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Docker mount grammar collisions from generated host paths and duplicate destinations", async () => {
    const commaRoot = await mkdtemp(join(tmpdir(), "miftah,profile-isolation-container-"));
    const regularRoot = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-container-duplicate-"));
    await mkdir(join(commaRoot, "home"), { recursive: true });
    await mkdir(join(regularRoot, "home"), { recursive: true });
    await mkdir(join(regularRoot, "appdata"), { recursive: true });

    try {
      await expect(
        buildContainerIsolationArguments("docker", ["run", "image"], commaRoot, [
          { source: "home", destination: "/home/miftah" }
        ])
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(
        buildContainerIsolationArguments("docker", ["run", "image"], regularRoot, [
          { source: "home", destination: "/shared" },
          { source: "appdata", destination: "/shared" }
        ])
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
    } finally {
      await rm(commaRoot, { recursive: true, force: true });
      await rm(regularRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!supportsNativeProfileRuntimeIsolation)("rejects remote container engines and a symlinked runtime root", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-profile-isolation-container-engine-"));
    const linkedRoot = join(dirname(root), `${basename(root)}-link`);
    await mkdir(join(root, "home"), { recursive: true });
    await symlink(root, linkedRoot);
    const volume = [{ source: "home", destination: "/home/miftah" }];

    try {
      await expect(
        buildContainerIsolationArguments("docker", ["run", "image"], root, volume, { DOCKER_HOST: "ssh://remote.example" })
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(
        buildContainerIsolationArguments("docker", ["run", "image"], root, volume, { DOCKER_CONFIG: "/tmp/remote-context" })
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(
        buildContainerIsolationArguments("podman", ["run", "image"], root, volume, { CONTAINER_HOST: "tcp://remote.example" })
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(
        buildContainerIsolationArguments("podman", ["run", "image"], root, volume, { PODMAN_CONNECTIONS_CONF: "/tmp/remote-context" })
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(
        buildContainerIsolationArguments("podman", ["run", "image"], root, volume, {}, "darwin")
      ).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(buildContainerIsolationArguments("docker", ["run", "image"], linkedRoot, volume)).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
    } finally {
      await rm(linkedRoot, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a named-upstream volume that reuses a profile file binding for another path", () => {
    expect(() =>
      mergeProfileIsolation(
        {
          files: [{ source: "credentials/profile.json", destination: "credentials/profile.json", environment: "OAUTH_CREDENTIAL_PATH" }]
        },
        {
          containerVolumes: [
            { source: "credentials/other.json", destination: "/run/miftah/oauth.json", environment: "OAUTH_CREDENTIAL_PATH" }
          ]
        }
      )
    ).toThrow(/UPSTREAM_START_FAILED/u);

    expect(() =>
      mergeProfileIsolation(
        {
          files: [{ source: "credentials/profile.json", destination: "credentials/profile.json", environment: "OAUTH_CREDENTIAL_PATH" }]
        },
        {
          containerVolumes: [
            { source: "credentials/profile.json", destination: "/run/miftah/oauth.json", environment: "OAUTH_CREDENTIAL_PATH" }
          ]
        }
      )
    ).not.toThrow();
  });
});

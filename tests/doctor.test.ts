import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { DOCTOR_CODES, type DoctorCheck, type DoctorCode } from "../src/cli/doctor-report.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const fixtureDirectory = resolve(`.doctor-integration-${process.pid}`);

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for upstream shutdown.");
      await delay(10);
    }
  }
}

async function writeConfig(
  name: string,
  config: Record<string, unknown>,
  env?: Record<string, string>
): Promise<{ directory: string; configPath: string; environmentPath?: string }> {
  const directory = join(fixtureDirectory, name);
  const configPath = join(directory, "miftah.json");
  const environmentPath = env ? join(directory, ".env") : undefined;
  await mkdir(directory, { recursive: true });
  if (environmentPath) {
    await writeFile(environmentPath, `${Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
    if (process.platform !== "win32") await chmod(environmentPath, 0o600);
  }
  await writeFile(configPath, JSON.stringify(config));
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  return { directory, configPath, environmentPath };
}

function stdioUpstream(env: Record<string, string> = {}) {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env
  };
}

function baseConfig(upstream: Record<string, unknown>, profiles: Record<string, unknown> = { default: {} }) {
  return {
    version: "1",
    name: "doctor-integration",
    defaultProfile: "default",
    upstream,
    profiles,
    process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 }
  };
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, code: DoctorCode): DoctorCheck {
  const found = report.checks.find((item) => item.code === code);
  if (!found) throw new Error(`Expected ${code} check.`);
  return found;
}

afterEach(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true });
});

describe("doctor readiness runner", () => {
  it("reports a healthy real stdio runtime and closes its child process", async () => {
    const shutdownPath = join(fixtureDirectory, "healthy", "upstream-ended");
    const auditPath = join(fixtureDirectory, "healthy", "audit", "events.jsonl");
    const { configPath } = await writeConfig(
      "healthy",
      {
        ...baseConfig(
          stdioUpstream({
            TEST_ACCOUNT_NAME: "secretref:dotenv://MIFTAH_DOCTOR_ACCOUNT",
            TEST_SHUTDOWN_END_PATH: shutdownPath
          })
        ),
        secrets: { envFiles: [".env"] },
        audit: { path: auditPath }
      },
      { MIFTAH_DOCTOR_ACCOUNT: "ready-account" }
    );

    const report = await runDoctor(configPath);

    expect(report).toMatchObject({ overallStatus: "healthy", ok: true });
    for (const code of [
      DOCTOR_CODES.CONFIGURATION,
      DOCTOR_CODES.SECRET_REFERENCES,
      DOCTOR_CODES.CANARY,
      DOCTOR_CODES.EXECUTABLE,
      DOCTOR_CODES.STARTUP,
      DOCTOR_CODES.TOOLS_DISCOVERY,
      DOCTOR_CODES.RESOURCES_DISCOVERY,
      DOCTOR_CODES.PROMPTS_DISCOVERY,
      DOCTOR_CODES.AUDIT_WRITABLE,
      DOCTOR_CODES.AUDIT_PERMISSIONS,
      DOCTOR_CODES.CLEAN_SHUTDOWN
    ]) {
      expect(check(report, code).status).toBe("pass");
    }
    await waitForFile(shutdownPath);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(configPath);
    expect(serialized).not.toContain(auditPath);
    expect(serialized).not.toContain("ready-account");
  });

  it("degrades instead of failing when a real optional discovery capability fails", async () => {
    const shutdownPath = join(fixtureDirectory, "degraded", "upstream-ended");
    const { configPath } = await writeConfig(
      "degraded",
      baseConfig(
        stdioUpstream({
          TEST_FAIL_LIST_RESOURCES: "true",
          TEST_SHUTDOWN_END_PATH: shutdownPath
        })
      )
    );

    const report = await runDoctor(configPath);

    expect(report).toMatchObject({ overallStatus: "degraded", ok: true });
    expect(check(report, DOCTOR_CODES.RESOURCES_DISCOVERY).status).toBe("warning");
    expect(check(report, DOCTOR_CODES.CLEAN_SHUTDOWN).status).toBe("pass");
    await waitForFile(shutdownPath);
  });

  it("uses only the wrapper-visible first page of paginated upstream tools", async () => {
    const toolCountPath = join(fixtureDirectory, "tools-pages", "tool-list-count");
    const { configPath } = await writeConfig(
      "tools-pages",
      baseConfig(stdioUpstream({ TEST_PAGINATE_TOOLS: "true", TEST_LIST_TOOLS_COUNT_PATH: toolCountPath }))
    );

    const report = await runDoctor(configPath);

    await expect(readFile(toolCountPath, "utf8")).resolves.toBe("1\n");
    expect(check(report, DOCTOR_CODES.TOOLS_DISCOVERY)).toMatchObject({
      status: "warning",
      explanation: "Tool discovery returned a cursor. Additional tool pages are not currently exposed by the wrapper.",
      remediation: "Use only the currently exposed tools until the wrapper supports additional tool pages."
    });
    expect(report.overallStatus).toBe("degraded");
  });

  it("probes constrained profiles sequentially and closes every child", async () => {
    const alternateToolCountPath = join(fixtureDirectory, "sequential-profiles", "alternate-tool-list-count");
    const defaultToolCountPath = join(fixtureDirectory, "sequential-profiles", "default-tool-list-count");
    const alternateShutdownPath = join(fixtureDirectory, "sequential-profiles", "alternate-upstream-ended");
    const defaultShutdownPath = join(fixtureDirectory, "sequential-profiles", "default-upstream-ended");
    const { configPath } = await writeConfig("sequential-profiles", {
      version: "1",
      name: "doctor-sequential-profiles",
      defaultProfile: "default",
      upstreams: { primary: stdioUpstream() },
      profiles: {
        alternate: {
          upstreams: {
            primary: {
              env: {
                TEST_LIST_TOOLS_COUNT_PATH: alternateToolCountPath,
                TEST_SHUTDOWN_END_PATH: alternateShutdownPath
              }
            }
          }
        },
        default: {
          upstreams: {
            primary: {
              env: {
                TEST_LIST_TOOLS_COUNT_PATH: defaultToolCountPath,
                TEST_SHUTDOWN_END_PATH: defaultShutdownPath
              }
            }
          }
        }
      },
      process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, maxConcurrentProfiles: 1 }
    });

    const report = await runDoctor(configPath);

    expect(report.checks.filter((item) => item.code === DOCTOR_CODES.STARTUP)).toHaveLength(2);
    expect(report.checks.filter((item) => item.code === DOCTOR_CODES.STARTUP).every((item) => item.status === "pass")).toBe(true);
    await expect(readFile(alternateToolCountPath, "utf8")).resolves.toBe("1\n");
    await expect(readFile(defaultToolCountPath, "utf8")).resolves.toBe("1\n");
    expect(check(report, DOCTOR_CODES.CLEAN_SHUTDOWN).status).toBe("pass");
    await waitForFile(alternateShutdownPath);
    await waitForFile(defaultShutdownPath);
  });

  it("fails strict tool discovery readiness when profile capacity cannot support every profile", async () => {
    const alternateShutdownPath = join(fixtureDirectory, "strict-capacity", "alternate-upstream-ended");
    const defaultShutdownPath = join(fixtureDirectory, "strict-capacity", "default-upstream-ended");
    const { configPath } = await writeConfig("strict-capacity", {
      version: "1",
      name: "doctor-strict-capacity",
      defaultProfile: "default-profile-identifier",
      upstreams: { primary: stdioUpstream() },
      profiles: {
        "alternate-profile-identifier": {
          upstreams: {
            primary: { env: { TEST_SHUTDOWN_END_PATH: alternateShutdownPath } }
          }
        },
        "default-profile-identifier": {
          upstreams: {
            primary: { env: { TEST_SHUTDOWN_END_PATH: defaultShutdownPath } }
          }
        }
      },
      tooling: { toolDiscoveryMode: "strict" },
      process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, maxConcurrentProfiles: 1 }
    });

    const report = await runDoctor(configPath);
    const strictCapacityCheck = report.checks.find(
      (item) => item.code === DOCTOR_CODES.TOOLS_DISCOVERY && item.status === "error"
    );

    expect(report).toMatchObject({ overallStatus: "failed", ok: false });
    expect(strictCapacityCheck).toMatchObject({
      target: "strict tool discovery",
      explanation: "Strict tool discovery requires all profiles to be available at the same time.",
      remediation: "Increase maxConcurrentProfiles or use permissive tool discovery."
    });
    expect(report.checks.filter((item) => item.code === DOCTOR_CODES.STARTUP)).toHaveLength(2);
    expect(report.checks.filter((item) => item.code === DOCTOR_CODES.TOOLS_DISCOVERY && item.status === "pass")).toHaveLength(2);
    expect(check(report, DOCTOR_CODES.CLEAN_SHUTDOWN).status).toBe("pass");
    expect(JSON.stringify(strictCapacityCheck)).not.toContain("alternate-profile-identifier");
    expect(JSON.stringify(strictCapacityCheck)).not.toContain("default-profile-identifier");
    await waitForFile(alternateShutdownPath);
    await waitForFile(defaultShutdownPath);
  });

  it("accepts a relative executable resolved from its configured working directory", async () => {
    if (process.platform === "win32") return;

    const { directory, configPath } = await writeConfig(
      "relative-executable",
      {
        ...baseConfig(
          { transport: "stdio", command: "./local-upstream.mjs", args: [] },
          { default: { cwd: "." } }
        ),
        process: { startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000 }
      }
    );
    const localUpstream = join(directory, "local-upstream.mjs");
    await writeFile(localUpstream, `#!/usr/bin/env node\n${await readFile(fixture, "utf8")}`);
    await chmod(localUpstream, 0o700);

    const report = await runDoctor(configPath);

    expect(check(report, DOCTOR_CODES.EXECUTABLE).status).toBe("pass");
    expect(check(report, DOCTOR_CODES.STARTUP).status).toBe("pass");
  });

  it("fails clean-shutdown readiness when the real manager times out closing a child", async () => {
    const { configPath } = await writeConfig(
      "shutdown-timeout",
      {
        ...baseConfig(stdioUpstream({ TEST_SHUTDOWN_DELAY_MS: "500" })),
        process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 50 }
      }
    );

    const report = await runDoctor(configPath);

    expect(check(report, DOCTOR_CODES.CLEAN_SHUTDOWN).status).toBe("error");
    expect(report.overallStatus).toBe("failed");
  });

  it("requires every post-close health entry to be stopped", async () => {
    const doctorSource = await readFile(new URL("../src/cli/doctor.ts", import.meta.url), "utf8");

    expect(doctorSource).toContain('health.processState === "stopped"');
  });

  it("returns safe failures for a missing executable without throwing", async () => {
    const { configPath } = await writeConfig(
      "missing-executable",
      baseConfig({ transport: "stdio", command: "miftah-doctor-missing-executable", args: [] })
    );

    const report = await runDoctor(configPath);

    expect(report).toMatchObject({ overallStatus: "failed", ok: false });
    expect(check(report, DOCTOR_CODES.EXECUTABLE).status).toBe("error");
    expect(check(report, DOCTOR_CODES.STARTUP).status).toBe("error");
    expect(check(report, DOCTOR_CODES.TOOLS_DISCOVERY).status).toBe("skipped");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(configPath);
    expect(serialized).not.toContain("miftah-doctor-missing-executable");
  });

  it("does not leak secrets when initialization fails", async () => {
    const secret = "doctor-initialize-secret";
    const { configPath } = await writeConfig(
      "secret-failure",
      {
        ...baseConfig(
          stdioUpstream({
            API_TOKEN: "secretref:dotenv://MIFTAH_DOCTOR_SECRET",
            TEST_FAIL_INITIALIZE: "true"
          })
        ),
        secrets: { envFiles: [".env"] }
      },
      { MIFTAH_DOCTOR_SECRET: secret }
    );

    const report = await runDoctor(configPath);

    expect(report.overallStatus).toBe("failed");
    expect(check(report, DOCTOR_CODES.STARTUP).status).toBe("error");
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("does not expose configured profile or upstream identifiers in report targets", async () => {
    const profileName = "profile-doctor-identifier-secret";
    const upstreamName = "upstream-doctor-identifier-secret";
    const { configPath } = await writeConfig(
      "identifier-safety",
      {
        version: "1",
        name: "doctor-identifier-safety",
        defaultProfile: profileName,
        upstreams: { [upstreamName]: stdioUpstream() },
        profiles: { [profileName]: {} },
        process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 }
      }
    );

    const report = await runDoctor(configPath);

    expect(report.overallStatus).toBe("healthy");
    expect(JSON.stringify(report)).not.toContain(profileName);
    expect(JSON.stringify(report)).not.toContain(upstreamName);
  });

  it("reports profile tool schema differences as warnings or strict errors", async () => {
    const profiles = {
      default: {},
      alternate: { env: { TEST_WHOAMI_SCHEMA: "account" } }
    };
    const permissive = await writeConfig(
      "permissive-schema",
      {
        ...baseConfig(stdioUpstream(), profiles),
        tooling: { toolDiscoveryMode: "permissive" }
      }
    );
    const strict = await writeConfig(
      "strict-schema",
      {
        ...baseConfig(stdioUpstream(), profiles),
        tooling: { toolDiscoveryMode: "strict" }
      }
    );

    const permissiveReport = await runDoctor(permissive.configPath);
    const strictReport = await runDoctor(strict.configPath);

    expect(check(permissiveReport, DOCTOR_CODES.SCHEMA_DIFFERENCE).status).toBe("warning");
    expect(permissiveReport.overallStatus).toBe("degraded");
    expect(check(strictReport, DOCTOR_CODES.SCHEMA_DIFFERENCE).status).toBe("error");
    expect(strictReport.overallStatus).toBe("failed");
  });

  it("reports a reserved management tool collision under the fail strategy", async () => {
    const { configPath } = await writeConfig(
      "collision",
      {
        ...baseConfig(stdioUpstream({ TEST_INCLUDE_MANAGEMENT_TOOL: "true" })),
        tooling: { collisionStrategy: "fail" }
      }
    );

    const report = await runDoctor(configPath);

    expect(report.overallStatus).toBe("failed");
    expect(check(report, DOCTOR_CODES.COLLISION).status).toBe("error");
    expect(JSON.stringify(report)).not.toContain("miftah_health");
  });
});

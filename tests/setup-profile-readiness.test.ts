import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditTrail } from "../src/audit/audit-trail.js";
import { runProfileReadiness } from "../src/setup/profile-readiness.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFakeUvx(directory: string, fixtureEnvironment: Record<string, string>): Promise<string> {
  const fixture = pathToFileURL(resolve(process.cwd(), "tests", "fixtures", "fake-upstream-runtime.mjs")).href;
  const wrapper = join(directory, "fake-uvx.mjs");
  await writeFile(
    wrapper,
    `Object.assign(process.env, ${JSON.stringify(fixtureEnvironment)});\nawait import(${JSON.stringify(fixture)});\n`
  );
  if (process.platform === "win32") {
    const command = join(directory, "uvx.cmd");
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${wrapper}"\r\n`);
    return directory;
  }

  const command = join(directory, "uvx");
  await writeFile(command, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(wrapper).href)});\n`);
  await chmod(command, 0o755);
  return directory;
}

interface ReadinessFixtureOptions {
  /** Test-only inherited process environment for the fake upstream. It never becomes adapter configuration. */
  readonly environment?: Record<string, string>;
  /** Actual selected-profile configuration, used only by resolution-boundary regressions. */
  readonly profileEnvironment?: Record<string, string>;
  readonly unrelatedProfileEnvironment?: Record<string, string>;
  readonly policies?: Record<string, unknown>;
  readonly profilePolicy?: string;
  readonly tooling?: Record<string, unknown>;
  readonly security?: Record<string, unknown>;
  readonly identity?: Record<string, unknown>;
  readonly auditPath?: string;
}

async function createReadinessFixture(options: ReadinessFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "miftah-setup-readiness-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "gsc.json");
  const auditPath = options.auditPath ?? join(directory, "audit.jsonl");
  const callPath = join(directory, "safe-read-call.json");
  const startPath = join(directory, "upstream-started");
  const fixtureEnvironment = {
    TEST_INCLUDE_SAFE_READ_TOOL: "true",
    TEST_SAFE_READ_CALL_PATH: callPath,
    TEST_START_COUNT_PATH: startPath,
    ...options.environment
  };
  const commandDirectory = await createFakeUvx(directory, fixtureEnvironment);
  const inheritedEnvironment = {
    PATH: `${commandDirectory}${delimiter}${process.env.PATH ?? ""}`
  };
  await writeFile(configPath, JSON.stringify({
    version: "3",
    name: "gsc",
    defaultProfile: "google-work",
    upstream: {
      transport: "stdio",
      command: "uvx",
      args: ["mcp-search-console@0.3.2"]
    },
    profiles: {
      "google-work": {
        ...(options.profileEnvironment === undefined ? {} : { env: options.profileEnvironment }),
        ...(options.profilePolicy === undefined ? {} : { policy: options.profilePolicy }),
        ...(options.identity === undefined ? {} : { identity: options.identity })
      },
      ...(options.unrelatedProfileEnvironment === undefined
        ? {}
        : { unrelated: { env: options.unrelatedProfileEnvironment } })
    },
    ...(options.policies === undefined ? {} : { policies: options.policies }),
    ...(options.tooling === undefined ? {} : { tooling: options.tooling }),
    ...(options.security === undefined ? {} : { security: options.security }),
    audit: {
      enabled: true,
      path: auditPath,
      format: "jsonl",
      includeArguments: false,
      failureMode: "fail-closed"
    }
  }));
  return {
    directory,
    configPath,
    auditPath,
    callPath,
    startPath,
    run: (target: Parameters<typeof runProfileReadiness>[1] = { profile: "google-work" }) =>
      withInheritedEnvironment(inheritedEnvironment, () => runProfileReadiness(configPath, target))
  };
}

async function withInheritedEnvironment<T>(environment: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(environment)) process.env[key] = value;
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("setup profile readiness", () => {
  it("performs one adapter-declared empty-object read call without exposing its response", async () => {
    const response = "safe-read-response-that-must-not-escape";
    const fixture = await createReadinessFixture({ environment: { TEST_SAFE_READ_RESPONSE: response } });

    await expect(fixture.run()).resolves.toEqual({
      status: "ready",
      profile: "google-work",
      upstream: "default",
      adapter: "Google Search Console",
      safeRead: { status: "passed", tool: "get_capabilities" },
      identity: { status: "unavailable" }
    });

    await expect(readFile(fixture.callPath, "utf8")).resolves.toBe(JSON.stringify({
      name: "get_capabilities",
      arguments: {}
    }));
    const audit = await readFile(fixture.auditPath, "utf8");
    expect(audit).toContain('"operation":"setup/profile-readiness"');
    expect(audit).toContain('"name":"get_capabilities"');
    expect(audit).toContain('"routingSource":"setup-profile"');
    expect(audit).toContain('"riskSource":"trusted-provider-adapter"');
    expect(audit).not.toContain(response);
    expect(audit).not.toContain('"arguments"');
  });

  it("fails closed on the audit preflight before starting the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-setup-readiness-audit-"));
    temporaryDirectories.push(root);
    const blockedParent = join(root, "not-a-directory");
    await writeFile(blockedParent, "regular file");
    const fixture = await createReadinessFixture({ auditPath: join(blockedParent, "audit.jsonl") });

    await expect(fixture.run()).rejects.toMatchObject({
      code: "AUDIT_WRITE_FAILED"
    });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails the audit preflight before resolving a selected profile secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-setup-readiness-audit-secret-"));
    temporaryDirectories.push(root);
    const blockedParent = join(root, "not-a-directory");
    await writeFile(blockedParent, "regular file");
    const fixture = await createReadinessFixture({
      auditPath: join(blockedParent, "audit.jsonl"),
      profileEnvironment: { GSC_OAUTH_CLIENT_SECRETS_FILE: "secretref:env://MIFTAH_SETUP_READINESS_SELECTED_SECRET_MISSING" }
    });

    await expect(fixture.run()).rejects.toMatchObject({
      code: "AUDIT_WRITE_FAILED"
    });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resolve unrelated profile secrets while checking the selected profile", async () => {
    const fixture = await createReadinessFixture({
      unrelatedProfileEnvironment: {
        TOKEN: "secretref:env://MIFTAH_SETUP_READINESS_UNRELATED_SECRET_MISSING"
      }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "ready",
      profile: "google-work",
      upstream: "default"
    });
    await expect(readFile(fixture.startPath, "utf8")).resolves.toBe("1\n");
  });

  it("does not launch a child when a configured PATH invalidates adapter trust", async () => {
    const fixture = await createReadinessFixture({
      profileEnvironment: { PATH: "/untrusted-provider-bin" }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "unsupported",
      safeRead: { status: "unavailable", errorCode: "PROFILE_READINESS_UNSUPPORTED" }
    });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.callPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks audit writability before opening an unsupported readiness audit scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-setup-readiness-unsupported-audit-"));
    temporaryDirectories.push(root);
    const blockedParent = join(root, "not-a-directory");
    await writeFile(blockedParent, "regular file");
    const fixture = await createReadinessFixture({
      auditPath: join(blockedParent, "audit.jsonl"),
      profileEnvironment: { PATH: "/untrusted-provider-bin" }
    });
    const beginOperation = vi.spyOn(AuditTrail.prototype, "beginOperation");

    await expect(fixture.run()).rejects.toMatchObject({
      code: "AUDIT_WRITE_FAILED",
      message: "AUDIT_WRITE_FAILED: profile readiness did not complete"
    });
    expect(beginOperation).not.toHaveBeenCalled();
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start or call a provider when policy denies the declared probe", async () => {
    const fixture = await createReadinessFixture({
      policies: { readonly: { deny: ["get_capabilities"] } },
      profilePolicy: "readonly",
      profileEnvironment: { GSC_OAUTH_CLIENT_SECRETS_FILE: "secretref:env://MIFTAH_SETUP_READINESS_SELECTED_SECRET_MISSING" }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "blocked",
      safeRead: { status: "blocked", tool: "get_capabilities", errorCode: "POLICY_BLOCKED" }
    });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.callPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a human confirmation rather than auto-calling a confirmed probe", async () => {
    const fixture = await createReadinessFixture({
      policies: { reviewed: { requireConfirmation: ["get_capabilities"] } },
      profilePolicy: "reviewed",
      profileEnvironment: { GSC_OAUTH_CLIENT_SECRETS_FILE: "secretref:env://MIFTAH_SETUP_READINESS_SELECTED_SECRET_MISSING" }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "confirmation-required",
      safeRead: { status: "confirmation-required", tool: "get_capabilities", errorCode: "POLICY_CONFIRMATION_REQUIRED" }
    });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.callPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors a local destructive override instead of calling the adapter-declared probe", async () => {
    const fixture = await createReadinessFixture({
      tooling: { toolRiskOverrides: { get_capabilities: "destructive" } },
      security: { requireExplicitProfileForDestructive: true }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "blocked",
      safeRead: { status: "blocked", errorCode: "POLICY_BLOCKED" }
    });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await readFile(fixture.auditPath, "utf8");
    expect(audit).toContain('"riskSource":"local-override"');
  });

  it("does not call a probe whose discovered schema requires an argument", async () => {
    const fixture = await createReadinessFixture({
      environment: { TEST_SAFE_READ_SCHEMA: "all-of-required" }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "unsupported",
      safeRead: { status: "unavailable", tool: "get_capabilities", errorCode: "TOOL_SCHEMA_MISMATCH" }
    });
    await expect(readFile(fixture.startPath, "utf8")).resolves.toBe("1\n");
    await expect(readFile(fixture.callPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not call a probe whose upstream annotations contradict the adapter contract", async () => {
    const fixture = await createReadinessFixture({
      environment: {
        TEST_SAFE_READ_ANNOTATIONS: JSON.stringify({ readOnlyHint: false, destructiveHint: false })
      }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "unsupported",
      safeRead: { status: "unavailable", tool: "get_capabilities", errorCode: "TOOL_SCHEMA_MISMATCH" }
    });
    await expect(readFile(fixture.callPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a configured identity as verified without returning raw identity output", async () => {
    const fixture = await createReadinessFixture({
      environment: {
        TEST_INCLUDE_IDENTITY_TOOL: "true",
        TEST_IDENTITY_RESPONSE: JSON.stringify({
          login: "identity-login",
          untrusted: "raw-identity-response-that-must-not-escape"
        })
      },
      tooling: { toolRiskOverrides: { identity: "read" } },
      identity: {
        maxAgeMs: 60_000,
        expected: { login: "identity-login" },
        probe: { tool: "identity", resultFormat: "json" }
      }
    });

    const report = await fixture.run();
    expect(report).toMatchObject({
      status: "ready",
      safeRead: { status: "passed", tool: "get_capabilities" },
      identity: { status: "verified" }
    });
    expect(JSON.stringify(report)).not.toContain("identity-login");
    const audit = await readFile(fixture.auditPath, "utf8");
    expect(audit).not.toContain("raw-identity-response-that-must-not-escape");
  });

  it("verifies configured identity before the declared safe read and does not probe a mismatched account", async () => {
    const fixture = await createReadinessFixture({
      environment: {
        TEST_INCLUDE_IDENTITY_TOOL: "true",
        TEST_IDENTITY_RESPONSE: JSON.stringify({ login: "wrong-account" })
      },
      tooling: { toolRiskOverrides: { identity: "read" } },
      identity: {
        maxAgeMs: 60_000,
        expected: { login: "expected-account" },
        probe: { tool: "identity", resultFormat: "json" }
      }
    });

    await expect(fixture.run()).resolves.toMatchObject({
      status: "identity-failed",
      safeRead: { status: "unavailable", tool: "get_capabilities" },
      identity: { status: "failed", errorCode: "IDENTITY_MISMATCH" }
    });
    await expect(readFile(fixture.callPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start a provider when readiness is already cancelled", async () => {
    const fixture = await createReadinessFixture();
    const controller = new AbortController();
    controller.abort("test cancellation before start");

    await expect(
      fixture.run({ profile: "google-work", signal: controller.signal })
    ).rejects.toMatchObject({ code: "UPSTREAM_CALL_FAILED" });
    await expect(readFile(fixture.startPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels selected secret-plugin resolution when the caller disconnects", async () => {
    const fixture = await createReadinessFixture();
    const pluginPath = join(fixture.directory, "hanging-secret-plugin.mjs");
    const startedPath = join(fixture.directory, "secret-plugin-started");
    await writeFile(
      pluginPath,
      `import { writeFileSync } from "node:fs";
export default {
  apiVersion: "1",
  id: "hanging-secret",
  kind: "secret-provider",
  async resolve() {
    writeFileSync(${JSON.stringify(startedPath)}, "started");
    await new Promise(() => setTimeout(() => {}, 60_000));
  }
};\n`,
      "utf8"
    );
    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      profiles: Record<string, { env?: Record<string, string> }>;
      plugins?: unknown;
    };
    config.profiles["google-work"]!.env = {
      GSC_OAUTH_CLIENT_SECRETS_FILE: "secretref:hanging-secret://account"
    };
    config.plugins = {
      timeoutMs: 1_000,
      allowlist: [{ id: "hanging-secret", kind: "secret-provider", path: "./hanging-secret-plugin.mjs" }]
    };
    await writeFile(fixture.configPath, JSON.stringify(config));

    const controller = new AbortController();
    const pending = fixture.run({ profile: "google-work", signal: controller.signal });
    const settlement = pending.then(
      () => ({ kind: "fulfilled" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    );
    try {
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test caller disconnect during secret resolution");
      const outcome = await Promise.race([
        settlement,
        new Promise<{ readonly kind: "timed-out" }>((resolve) => setTimeout(() => resolve({ kind: "timed-out" }), 250))
      ]);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.error).toMatchObject({ code: "UPSTREAM_CALL_FAILED" });
      }
    } finally {
      await settlement;
    }
  });

  it("cancels a startup promptly when the caller disconnects during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-setup-readiness-startup-cancel-"));
    temporaryDirectories.push(root);
    const gatePath = join(root, "startup-gate");
    const readyPath = join(root, "startup-ready");
    await writeFile(gatePath, "hold");
    const fixture = await createReadinessFixture({
      environment: {
        TEST_HANG_ON_START_PATH: gatePath,
        TEST_HANG_ON_START_READY_PATH: readyPath
      }
    });
    const controller = new AbortController();
    const pending = fixture.run({ profile: "google-work", signal: controller.signal });

    try {
      await expect.poll(async () => access(readyPath).then(() => true, () => false), { timeout: 5_000 }).toBe(true);
      controller.abort("test caller disconnect");
      const outcome = await Promise.race([
        pending.then(
          () => ({ kind: "fulfilled" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error })
        ),
        new Promise<{ readonly kind: "timed-out" }>((resolve) => setTimeout(() => resolve({ kind: "timed-out" }), 250))
      ]);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.error).toMatchObject({ code: "UPSTREAM_CALL_FAILED" });
      }
    } finally {
      await rm(gatePath, { force: true });
      await pending.catch(() => undefined);
    }
  });

  it("cancels an in-flight probe and closes its child process", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-setup-readiness-cancel-"));
    temporaryDirectories.push(root);
    const startedPath = join(root, "call-started");
    const shutdownPath = join(root, "shutdown-ended");
    const fixture = await createReadinessFixture({
      environment: {
        TEST_CALL_TOOL_DELAY_MS: "1000",
        TEST_CALL_TOOL_STARTED_PATH: startedPath,
        TEST_SHUTDOWN_END_PATH: shutdownPath
      }
    });
    const controller = new AbortController();
    const pending = fixture.run({ profile: "google-work", signal: controller.signal });

    try {
      // This verifies an observable protocol boundary, not a startup latency contract. Coverage
      // runs many process fixtures concurrently, so give the child a bounded chance to reach it.
      await expect.poll(async () => access(startedPath).then(() => true, () => false), { timeout: 5_000 }).toBe(true);
      controller.abort("test cancellation");
      await expect(pending).rejects.toMatchObject({ code: "UPSTREAM_CALL_FAILED" });
      await expect.poll(async () => access(shutdownPath).then(() => true, () => false)).toBe(true);
    } finally {
      controller.abort("test cleanup");
      await pending.catch(() => undefined);
    }
  });
});

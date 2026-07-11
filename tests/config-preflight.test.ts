import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/cli/create-runtime.js";
import { MiftahError } from "../src/utils/errors.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

async function waitFor<Value>(
  read: () => Value | Promise<Value>,
  matches: (value: Value) => boolean,
  timeoutMs = 2_000
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!matches(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lifecycle state; last value: ${JSON.stringify(value)}`);
    }
    await delay(10);
    value = await read();
  }
  return value;
}

describe("configuration preflight", () => {
  it("rejects invalid references before loading secret sources or starting an upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-preflight-"));
    const configPath = join(directory, "miftah.json");
    const sentinelPath = join(directory, "upstream-started");
    const upstreamLauncher = [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(sentinelPath)}, "started");`,
      `await import(${JSON.stringify(pathToFileURL(fixture).href)});`
    ].join(" ");
    const config = {
      version: "1",
      name: "preflight",
      defaultProfile: "default",
      upstream: {
        transport: "stdio",
        command: process.execPath,
        args: ["--input-type=module", "--eval", upstreamLauncher]
      },
      profiles: { default: {} }
    };
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        routing: { rules: [{ when: {}, profile: "missing" }] },
        secrets: { envFiles: ["missing.env"] }
      })
    );

    await expect(createRuntime(configPath)).rejects.toMatchObject({ code: "ROUTING_PROFILE_NOT_FOUND" });
    await expect(access(sentinelPath)).rejects.toThrow();

    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        routing: { rules: [{ when: {}, profile: "default" }] },
        secrets: { envFiles: ["missing.env"] }
      })
    );
    await expect(createRuntime(configPath)).rejects.toMatchObject({ code: "SECRET_PROVIDER_FAILED" });

    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        routing: { rules: [{ when: {}, profile: "default" }] }
      })
    );
    const runtime = await createRuntime(configPath);
    try {
      await runtime.manager.get("default");
      await expect(access(sentinelPath)).resolves.toBeUndefined();
    } finally {
      await runtime.manager.close();
    }
  });

  it("resolves dotenv-backed credentials for named upstreams before startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-named-upstream-"));
    const configPath = join(directory, "miftah.json");
    const secretSuffix = `${process.pid}_${Date.now()}`;
    const accountKey = `MIFTAH_TEST_ACCOUNT_${secretSuffix}`;
    const authorizationKey = `MIFTAH_TEST_AUTHORIZATION_${secretSuffix}`;
    await writeFile(
      join(directory, ".env"),
      `${accountKey}=named-upstream\n${authorizationKey}=Bearer named-upstream\n`
    );
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "named-upstream",
        defaultProfile: "default",
        upstreams: {
          primary: {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            env: { TEST_ACCOUNT_NAME: `secretref:dotenv://${accountKey}` },
            headers: { Authorization: `secretref:dotenv://${authorizationKey}` }
          }
        },
        profiles: { default: {} },
        secrets: { envFiles: [".env"] }
      })
    );

    const runtime = await createRuntime(configPath);
    try {
      expect(runtime.config.upstreams?.primary?.headers).toEqual({ Authorization: "Bearer named-upstream" });
      const session = await runtime.manager.get("default", "primary");
      await expect(session.callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "named-upstream" }]
      });
    } finally {
      await runtime.manager.close();
    }
  });

  it("redacts dotenv secrets assigned to noncredential upstream configuration keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-runtime-redaction-"));
    const configPath = join(directory, "miftah.json");
    const secretKey = `MIFTAH_TEST_COOKIE_${process.pid}_${Date.now()}`;
    const secret = "runtime-cookie-secret";
    await writeFile(join(directory, ".env"), `${secretKey}=${secret}\n`);
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "runtime-redaction",
        defaultProfile: "default",
        upstream: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture],
          env: {
            TEST_ERROR_MESSAGE: `secretref:dotenv://${secretKey}`,
            TEST_FAIL_LIST_TOOLS: "true"
          }
        },
        profiles: { default: {} },
        secrets: { envFiles: [".env"] }
      })
    );

    const runtime = await createRuntime(configPath);
    try {
      let failure: unknown;
      try {
        await runtime.manager.listTools("default");
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof MiftahError)) throw new Error("Expected a Miftah tool-list failure");
      const cause = failure.details?.cause;
      if (typeof cause !== "string") throw new Error("Expected a redacted capability diagnostic cause");
      expect(cause).not.toContain(secret);
      expect(cause).toContain("[REDACTED]");
      expect(runtime.manager.getSecretValues()).toContain(secret);
    } finally {
      await runtime.manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("wires supported lifecycle settings from configuration into the process manager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-lifecycle-runtime-"));
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "lifecycle-runtime",
        defaultProfile: "default",
        upstream: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture]
        },
        profiles: { default: {} },
        process: {
          startupTimeoutMs: 1_000,
          shutdownTimeoutMs: 100,
          idleTimeoutMs: 50,
          restartOnCrash: true,
          maxRestarts: 2,
          maxConcurrentProfiles: 1
        }
      })
    );

    const runtime = await createRuntime(configPath);
    try {
      await runtime.manager.get("default");
      const health = await waitFor(
        () => runtime.manager.listHealth(),
        (entries) => entries.some((entry) => entry.processState === "stopped" && entry.lastStopReason === "idle")
      );
      expect(health).toMatchObject([
        { profile: "default", processState: "stopped", lastStopReason: "idle" }
      ]);
    } finally {
      await runtime.manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

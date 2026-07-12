import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load-config.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";
import { MiftahError } from "../src/utils/errors.js";

const malformedFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "malformed-upstream.mjs");

function expectMiftahError(error: unknown, code: MiftahError["code"]): void {
  expect(error).toBeInstanceOf(MiftahError);
  expect(error).toMatchObject({ code });
}

describe("negative integration paths", () => {
  it("reports an unreadable configuration file with CONFIG_NOT_FOUND", async () => {
    const configPath = join(tmpdir(), `miftah-missing-config-${process.pid}-${Date.now()}.json`);
    const failure = await loadConfig(configPath).catch((error: unknown) => error);

    expectMiftahError(failure, "CONFIG_NOT_FOUND");
  });

  it("reports malformed configuration JSON with CONFIG_INVALID_JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-invalid-config-"));
    const configPath = join(directory, "miftah.json");
    try {
      await writeFile(configPath, '{"version":');

      const failure = await loadConfig(configPath).catch((error: unknown) => error);
      expectMiftahError(failure, "CONFIG_INVALID_JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports missing environment secret references with SECRET_ENV_MISSING", async () => {
    const resolver = new SecretResolver({ environment: {} });

    await expect(resolver.resolveValue("secretref:env://MIFTAH_MISSING_NEGATIVE_PATH_SECRET")).rejects.toMatchObject({
      code: "SECRET_ENV_MISSING"
    });
  });

  it("rejects unsupported secret reference providers with SECRET_PROVIDER_FAILED", async () => {
    const resolver = new SecretResolver({ environment: {} });

    await expect(resolver.resolveValue("secretref:unsupported://credential")).rejects.toMatchObject({
      code: "SECRET_PROVIDER_FAILED"
    });
  });

  it("rejects a malformed MCP initialize response without exposing configured secrets", async () => {
    const secret = "malformed-response-secret";
    const manager = new UpstreamProcessManager(
      { transport: "stdio", command: process.execPath, args: [malformedFixture] },
      { work: { env: { API_TOKEN: secret, TEST_MALFORMED_SECRET: secret } } },
      { startupTimeoutMs: 1_000 }
    );

    try {
      const failure = await manager.get("work").catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "UPSTREAM_INIT_FAILED" });
      expect(`${failure instanceof Error ? failure.message : ""} ${JSON.stringify(failure)}`).not.toContain(secret);
    } finally {
      await manager.close();
    }
  });
});

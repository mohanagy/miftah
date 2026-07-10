import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/cli/create-runtime.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

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
});

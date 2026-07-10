import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/cli/create-runtime.js";

describe("configuration preflight", () => {
  it("rejects invalid references before loading secret sources or starting an upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-preflight-"));
    const configPath = join(directory, "miftah.json");
    const sentinelPath = join(directory, "upstream-started");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "preflight",
        defaultProfile: "default",
        upstream: {
          transport: "stdio",
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "started")`]
        },
        profiles: { default: {} },
        routing: { rules: [{ when: {}, profile: "missing" }] },
        secrets: { envFiles: ["missing.env"] }
      })
    );

    await expect(createRuntime(configPath)).rejects.toMatchObject({ code: "ROUTING_PROFILE_NOT_FOUND" });
    await expect(access(sentinelPath)).rejects.toThrow();
  });
});

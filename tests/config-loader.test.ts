import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load-config.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";

describe("config loading and secret resolution", () => {
  it("loads JSON configs and resolves profile secrets from an env file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-"));
    const envFile = join(directory, ".env");
    const configFile = join(directory, "miftah.json");
    await writeFile(envFile, "WORK_TOKEN=from-dotenv\n");
    await writeFile(
      configFile,
      JSON.stringify({
        version: "1",
        name: "test",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node" },
        profiles: { work: { env: { TOKEN: "${WORK_TOKEN}" } } }
      })
    );

    const config = await loadConfig(configFile);
    const resolver = new SecretResolver({ envFiles: [envFile], environment: {} });
    await resolver.load();
    expect(resolver.resolveMap(config.profiles.work!.env!)).toEqual({ TOKEN: "from-dotenv" });
  });

  it("rejects plaintext secret references unless explicitly enabled", () => {
    const resolver = new SecretResolver({ environment: {}, allowPlaintextSecrets: false });
    expect(() => resolver.resolveValue("secretref:plain://visible")).toThrow(/PLAINTEXT/);
  });
});

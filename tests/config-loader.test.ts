import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load-config.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";

const plaintextReferencePattern = /PLAINTEXT/u;

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
    await expect(resolver.resolveMap(config.profiles.work!.env!)).resolves.toEqual({ TOKEN: "from-dotenv" });
  });

  it("rejects plaintext secret references unless explicitly enabled", async () => {
    const resolver = new SecretResolver({ environment: {}, allowPlaintextSecrets: false });
    await expect(resolver.resolveValue("secretref:plain://visible")).rejects.toThrow(plaintextReferencePattern);
  });

  it("resolves a relative root upstream working directory in a v2 config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-v2-"));
    const configFile = join(directory, "miftah.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: "2",
        name: "v2-paths",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", cwd: "./root-provider" },
        profiles: { work: {} }
      })
    );

    const config = await loadConfig(configFile);

    expect(config.upstream?.cwd).toBe(join(directory, "root-provider"));
  });

  it("resolves a relative named upstream working directory in a v2 config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-v2-"));
    const configFile = join(directory, "miftah.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: "2",
        name: "v2-named-upstream-path",
        defaultProfile: "work",
        upstreams: {
          worker: { transport: "stdio", command: "node", cwd: "./worker-provider" }
        },
        profiles: { work: {} }
      })
    );

    const config = await loadConfig(configFile);

    expect(config.upstream).toBeUndefined();
    expect(config.upstreams?.worker?.cwd).toBe(join(directory, "worker-provider"));
  });
});

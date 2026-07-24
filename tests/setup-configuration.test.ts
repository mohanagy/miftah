import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSetupConfigurationPlan,
  publishSetupConfigurationPlan
} from "../src/setup/setup-configuration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("setup configuration plan", () => {
  it("validates and binds serialized configuration bytes before publication", () => {
    const plan = createSetupConfigurationPlan({
      configPath: "configs/example.json",
      cwd: "/workspace",
      config: {
        version: "3",
        name: "example",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: "node", args: [] },
        profiles: { default: {} }
      }
    });

    expect(plan).toEqual({
      path: "/workspace/configs/example.json",
      content:
        '{\n  "version": "3",\n  "name": "example",\n  "defaultProfile": "default",\n  "upstream": {\n    "transport": "stdio",\n    "command": "node",\n    "args": []\n  },\n  "profiles": {\n    "default": {}\n  }\n}\n'
    });
  });

  it("creates a new owner-only configuration without replacing an existing path", async () => {
    const directory = await mkdtempForTest();
    const path = join(directory, "miftah.json");
    const plan = createSetupConfigurationPlan({
      configPath: path,
      config: {
        version: "3",
        name: "example",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: "node", args: [] },
        profiles: { default: {} }
      }
    });

    await publishSetupConfigurationPlan(plan);

    await expect(readFile(path, "utf8")).resolves.toBe(plan.content);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await expect(publishSetupConfigurationPlan(plan)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

async function mkdtempForTest(): Promise<string> {
  const directory = join(tmpdir(), `miftah-setup-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  temporaryDirectories.push(directory);
  return directory;
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProfileListCommand } from "../src/cli/profile-list-command.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("profile list command", () => {
  it("loads configuration only and returns the redacted account inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-list-"));
    directories.push(directory);
    const configPath = join(directory, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.mjs"] },
      profiles: {
        work: {
          description: "Work analytics account",
          env: { API_TOKEN: "secretref:env://WORK_API_TOKEN" }
        },
        personal: { description: "Personal analytics account" }
      }
    }, null, 2)}\n`);

    const report = await runProfileListCommand({ configPath });

    expect(report).toEqual({
      defaultProfile: "work",
      profiles: [
        { name: "personal", description: "Personal analytics account" },
        { name: "work", description: "Work analytics account" }
      ]
    });
    expect(JSON.stringify(report)).not.toContain("WORK_API_TOKEN");
  });
});

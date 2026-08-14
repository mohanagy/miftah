import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
let directory = "";
let cliEntry = "";

function parseJsonToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("Expected one text tool result.");
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectFreshProcess(configPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, "serve", "--config", configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "profile-state-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Fresh Miftah STDIO process did not connect: ${stderr || "no stderr"}`, { cause: error });
  }
  return client;
}

async function writeConfig(
  path: string,
  state?: { readonly persistActiveProfile: true; readonly scope: "workspace" }
): Promise<void> {
  await writeFile(path, JSON.stringify({
    version: "1",
    name: "profile-state-stdio",
    defaultProfile: "work",
    upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
    profiles: { work: {}, personal: {} },
    security: { allowProfileSwitchingFromMcp: true },
    ...(state === undefined ? {} : { state })
  }));
}

beforeAll(async () => {
  directory = await mkdtemp(join(process.cwd(), ".profile-state-stdio-test-"));
  cliEntry = join(directory, "miftah-cli.mjs");
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ["src/cli/main.ts"],
    outfile: cliEntry,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    packages: "external",
    define: { __MIFTAH_VERSION__: JSON.stringify("profile-state-stdio-test") },
    logLevel: "silent"
  });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("active profile lifetime over fresh STDIO processes", () => {
  it("returns to the configured default when process-scoped state has no durable record", async () => {
    const configPath = join(directory, "process.miftah.json");
    await writeConfig(configPath);

    const first = await connectFreshProcess(configPath);
    try {
      expect(await first.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        content: [{
          type: "text",
          text: "Active profile changed from work to personal. Scope: process. This selection ends with the current Miftah process; a fresh process starts from the configured default profile."
        }]
      });
    } finally {
      await first.close();
    }

    const second = await connectFreshProcess(configPath);
    try {
      expect(parseJsonToolResult(await second.callTool({ name: "miftah_current_profile", arguments: {} }))).toMatchObject({
        activeProfile: "work",
        scope: "process",
        persistence: "temporary",
        survivesProcessRestart: false,
        restartBehavior: "configured-default"
      });
    } finally {
      await second.close();
    }
  });

  it("restores a workspace-scoped switch in a second fresh STDIO process", async () => {
    const configPath = join(directory, "workspace.miftah.json");
    await writeConfig(configPath, { persistActiveProfile: true, scope: "workspace" });

    const first = await connectFreshProcess(configPath);
    try {
      expect(await first.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        content: [{
          type: "text",
          text: "Active profile changed from work to personal. Scope: workspace. This durable selection is restored by a fresh Miftah process for this configuration."
        }]
      });
    } finally {
      await first.close();
    }

    const second = await connectFreshProcess(configPath);
    try {
      expect(parseJsonToolResult(await second.callTool({ name: "miftah_current_profile", arguments: {} }))).toMatchObject({
        activeProfile: "personal",
        selectionSource: "persisted-workspace",
        scope: "workspace",
        persistence: "durable",
        survivesProcessRestart: true,
        restartBehavior: "restore-selection"
      });
    } finally {
      await second.close();
    }
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evidencePath = fileURLToPath(
  new URL("./fixtures/named-host-v1.1.3-evidence.json", import.meta.url)
);
const recorderPath = fileURLToPath(
  new URL("./fixtures/named-host-stdio-recorder.mjs", import.meta.url)
);
const recorderParserPath = fileURLToPath(
  new URL("./fixtures/named-host-recorder-parser.mjs", import.meta.url)
);
const fakeUpstreamPath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const fakeUpstreamBundlePath = fileURLToPath(
  new URL("./fixtures/fake-upstream-bundled.mjs", import.meta.url)
);
const desktopLauncherPath = fileURLToPath(
  new URL("./fixtures/named-host-desktop-launcher.mjs", import.meta.url)
);

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describe("v1.1.3 named-host evidence", () => {
  it("isolates concurrent Desktop host sessions into separate evidence directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-named-host-desktop-"));
    try {
      const recorderStubPath = join(directory, "recorder-stub.mjs");
      const fakeMiftahCliPath = join(directory, "miftah-cli.js");
      const stubUpstreamPath = join(directory, "fake-upstream.mjs");
      await writeFile(
        recorderStubPath,
        `
          import { readFile, writeFile } from "node:fs/promises";
          const [outputPath, command, cliPath, configFlag, configPath] = process.argv.slice(2);
          const config = JSON.parse(await readFile(configPath, "utf8"));
          await writeFile(outputPath, JSON.stringify({
            command,
            cliPath,
            configFlag,
            configPath,
            config,
            environment: {
              secret: process.env.DESKTOP_EVIDENCE_SECRET ?? null,
              home: process.env.HOME,
              xdgConfigHome: process.env.XDG_CONFIG_HOME,
              xdgRuntimeDir: process.env.XDG_RUNTIME_DIR
            }
          }));
        `
      );

      const launch = () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              desktopLauncherPath,
              directory,
              process.execPath,
              recorderStubPath,
              fakeMiftahCliPath,
              stubUpstreamPath
            ],
            {
              env: { ...process.env, DESKTOP_EVIDENCE_SECRET: "must-not-pass" },
              stdio: ["ignore", "ignore", "pipe"]
            }
          );
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.once("error", reject);
          child.once("close", (exitCode) => {
            if (exitCode === 0) resolve();
            else reject(new Error(`Desktop launcher exited ${String(exitCode)}: ${stderr}`));
          });
        });

      await Promise.all([launch(), launch()]);

      const instanceDirectories = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("instance-"))
        .map((entry) => join(directory, entry.name));
      expect(instanceDirectories).toHaveLength(2);

      const records = await Promise.all(
        instanceDirectories.map(async (instanceDirectory) =>
          JSON.parse(await readFile(join(instanceDirectory, "record.json"), "utf8"))
        )
      );
      for (const record of records) {
        expect(record).toMatchObject({
          command: process.execPath,
          cliPath: fakeMiftahCliPath,
          configFlag: "--config",
          config: {
            version: "1",
            name: "desktop-evidence-425",
            defaultProfile: "work",
            upstream: {
              transport: "stdio",
              command: process.execPath,
              args: [stubUpstreamPath]
            },
            profiles: {
              work: { env: { TEST_ACCOUNT_NAME: "desktop-evidence-fixture" } }
            }
          }
        });
        const normalizedConfigPath = record.configPath.replaceAll("\\", "/");
        const normalizedAuditPath = record.config.audit.path.replaceAll("\\", "/");
        const normalizedInitializedPath =
          record.config.profiles.work.env.TEST_INITIALIZED_PATH.replaceAll("\\", "/");
        expect(normalizedConfigPath).toMatch(/\/instance-[^/]+\/miftah\.json$/);
        expect(normalizedAuditPath).toMatch(/\/instance-[^/]+\/audit\.jsonl$/);
        expect(normalizedInitializedPath).toMatch(
          /\/instance-[^/]+\/upstream-initialized$/
        );
        expect(record.environment).toMatchObject({ secret: null });
        expect(record.environment.home.replaceAll("\\", "/")).toMatch(/\/instance-[^/]+$/);
        expect(record.environment.xdgConfigHome.replaceAll("\\", "/")).toMatch(
          /\/instance-[^/]+\/xdg-config$/
        );
        expect(record.environment.xdgRuntimeDir.replaceAll("\\", "/")).toMatch(
          /\/instance-[^/]+\/xdg-runtime$/
        );
      }
      expect(records[0].configPath).not.toBe(records[1].configPath);
      expect(records[0].config.audit.path).not.toBe(records[1].config.audit.path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves UTF-8 metadata split across arbitrary input chunks", async () => {
    const { createLineRecorder } = await import(
      new URL("./fixtures/named-host-recorder-parser.mjs", import.meta.url).href
    );
    const messages: unknown[] = [];
    const recordLines = createLineRecorder();
    const message = Buffer.from(
      `${JSON.stringify({ serverInfo: { name: "fixture-sérver", version: "1.0.0" } })}\n`,
      "utf8"
    );
    const splitAt = message.indexOf(Buffer.from([0xc3])) + 1;

    recordLines("server", message.subarray(0, splitAt), (value: unknown) => messages.push(value));
    expect(messages).toEqual([]);
    recordLines("server", message.subarray(splitAt), (value: unknown) => messages.push(value));

    expect(messages).toEqual([
      { serverInfo: { name: "fixture-sérver", version: "1.0.0" } }
    ]);
  });

  it("buffers tiny incomplete chunks until a complete line arrives", async () => {
    const { createLineRecorder } = await import(
      new URL("./fixtures/named-host-recorder-parser.mjs", import.meta.url).href
    );
    const messages: unknown[] = [];
    const recordLines = createLineRecorder();
    const message = Buffer.from(
      `${JSON.stringify({ serverInfo: { name: "chunked-server", version: "1.0.0" } })}\n`,
      "utf8"
    );

    for (const byte of message.subarray(0, -1)) {
      recordLines("server", Buffer.from([byte]), (value: unknown) => messages.push(value));
    }
    expect(messages).toEqual([]);
    recordLines("server", message.subarray(-1), (value: unknown) => messages.push(value));

    expect(messages).toEqual([
      { serverInfo: { name: "chunked-server", version: "1.0.0" } }
    ]);
  });

  it("preserves discovered server metadata when later responses omit it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-named-host-recorder-"));
    try {
      const outputPath = join(directory, "record.json");
      const server = String.raw`
        let buffer = "";
        let pendingWrite = Promise.resolve();
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline === -1) return;
            const request = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            const result = request.method === "server/discover"
              ? { supportedVersions: ["2026-07-28"], _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture-sérver", version: "1.0.0" } } }
              : { tools: [] };
            const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n", "utf8");
            pendingWrite = pendingWrite.then(() => new Promise((resolve) => {
              if (request.method === "server/discover") {
                const splitAt = response.indexOf(Buffer.from([0xc3])) + 1;
                process.stdout.write(response.subarray(0, splitAt));
                setTimeout(() => {
                  process.stdout.write(response.subarray(splitAt));
                  resolve();
                }, 10);
              } else {
                process.stdout.write(response);
                resolve();
              }
            }));
          }
        });
      `;
      const recorder = spawn(
        process.execPath,
        [recorderPath, outputPath, process.execPath, "-e", server],
        { stdio: ["pipe", "ignore", "pipe"] }
      );
      let stderr = "";
      recorder.stderr.setEncoding("utf8");
      recorder.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "fixture-client", version: "1.0.0" }
      };
      recorder.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } })}\n`
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      recorder.stdin.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } })}\n`
      );
      const exitCode = await new Promise<number | null>((resolve) => recorder.once("close", resolve));

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const record = JSON.parse(await readFile(outputPath, "utf8"));
      expect(record.server).toEqual({
        name: "fixture-sérver",
        version: "1.0.0",
        negotiatedProtocol: "2026-07-28"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records exact bounded Codex CLI and Claude Code outcomes", async () => {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));

    expect(evidence).toMatchObject({
      issues: [423, 425],
      recordedAt: "2026-08-23",
      classification: "named-host-runtime",
      package: {
        name: "@lubab/miftah",
        version: "1.1.3",
        integrity:
          "sha512-kqA/x/bUlS8wDN3MMd7H2RJyyELSrADDg3IiubUOSX3uAc2NeZ1TYavzVNj+H2LUhlFE2lZ54FTpEb/5w7pK2g==",
        provenancePredicate: "https://slsa.dev/provenance/v1"
      },
      environment: { os: "macOS 26.3", architecture: "arm64", node: "22.22.3" },
      clients: [
        {
          host: "Codex CLI",
          hostVersion: "0.148.0",
          clientInfo: { name: "codex-mcp-client", version: "0.148.0" },
          era: "initialized",
          protocol: "2025-06-18",
          initializedNotification: true,
          operations: {
            "tools/list": { requests: 1, success: 1, error: 0 },
            "tools/call": { requests: 1, success: 1, error: 0 }
          },
          markers: {
            upstreamInitialized: true,
            toolList: true,
            toolCall: true,
            upstreamShutdown: true
          },
          serverProcess: { exitCode: null, signal: "SIGTERM", spawnError: null },
          toolResultMatchedFixture: true
        },
        {
          host: "Claude Code",
          hostVersion: "2.1.235",
          clientInfo: { name: "claude-code", version: "2.1.235" },
          era: "modern",
          protocol: "2026-07-28",
          initializedNotification: false,
          operations: {
            "prompts/list": { requests: 1, success: 1, error: 0 },
            "resources/list": { requests: 1, success: 1, error: 0 },
            "tools/list": { requests: 1, success: 1, error: 0 },
            "tools/call": { requests: 1, success: 1, error: 0 }
          },
          markers: {
            upstreamInitialized: true,
            toolList: true,
            toolCall: true,
            upstreamShutdown: true
          },
          serverProcess: { exitCode: 0, signal: null, spawnError: null },
          toolResultMatchedFixture: true
        },
        {
          host: "Claude Desktop",
          hostVersion: "1.34493.1",
          hostBuild: "1.34493.1",
          bundleId: "com.anthropic.claudefordesktop",
          clientInfo: { name: "claude-ai", version: "0.1.0" },
          era: "initialized",
          protocol: "2025-11-25",
          initializedNotification: true,
          operations: {
            "prompts/list": { requests: 1, success: 1, error: 0 },
            "resources/list": { requests: 1, success: 1, error: 0 },
            "tools/list": { requests: 1, success: 1, error: 0 },
            "tools/call": { requests: 1, success: 1, error: 0 }
          },
          markers: {
            upstreamInitialized: true,
            toolList: true,
            toolCall: true,
            upstreamShutdown: true
          },
          serverProcess: { exitCode: null, signal: "SIGTERM", spawnError: null },
          toolResultMatchedFixture: true,
          companionSessions: [
            {
              clientInfo: {
                name: "local-agent-mode-miftah-evidence-425",
                version: "1.0.0"
              },
              protocol: "2025-11-25",
              operations: {
                "tools/list": { requests: 1, success: 1, error: 0 }
              }
            }
          ]
        }
      ]
    });
  });

  it("binds the normalized record to the reviewed fixtures and excludes raw host data", async () => {
    const [
      evidenceText,
      recorder,
      recorderParser,
      fakeUpstream,
      fakeUpstreamBundle,
      desktopLauncher
    ] = await Promise.all([
      readFile(evidencePath, "utf8"),
      readFile(recorderPath),
      readFile(recorderParserPath),
      readFile(fakeUpstreamPath),
      readFile(fakeUpstreamBundlePath),
      readFile(desktopLauncherPath)
    ]);
    const evidence = JSON.parse(evidenceText);

    expect(sha256(recorder)).toBe(evidence.recorder.sha256);
    expect(sha256(recorderParser)).toBe(evidence.recorder.parserSha256);
    expect(sha256(fakeUpstream)).toBe(evidence.upstream.entrySha256);
    expect(sha256(fakeUpstreamBundle)).toBe(evidence.upstream.bundleSha256);
    expect(sha256(desktopLauncher)).toBe(evidence.recorder.desktopLauncherSha256);
    expect(evidence.privacy).toMatchObject({
      rawHostTranscriptCommitted: false,
      rawAuditCommitted: false
    });
    expect(evidenceText).not.toMatch(/\/Users\/|\/private\/tmp\/|\/tmp\//);
    expect(evidenceText).not.toMatch(
      /"(?:session_id|session-id|request_id|request-id|total_cost|api_key|api-key)"/i
    );
  });
});

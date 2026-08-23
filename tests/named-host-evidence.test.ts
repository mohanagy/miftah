import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evidencePath = fileURLToPath(
  new URL("./fixtures/named-host-v1.1.3-evidence.json", import.meta.url)
);
const recorderPath = fileURLToPath(
  new URL("./fixtures/named-host-stdio-recorder.mjs", import.meta.url)
);
const fakeUpstreamPath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const fakeUpstreamBundlePath = fileURLToPath(
  new URL("./fixtures/fake-upstream-bundled.mjs", import.meta.url)
);

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describe("v1.1.3 named-host evidence", () => {
  it("records exact bounded Codex CLI and Claude Code outcomes", async () => {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));

    expect(evidence).toMatchObject({
      issue: 423,
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
        }
      ]
    });
  });

  it("binds the normalized record to the reviewed fixtures and excludes raw host data", async () => {
    const [evidenceText, recorder, fakeUpstream, fakeUpstreamBundle] = await Promise.all([
      readFile(evidencePath, "utf8"),
      readFile(recorderPath),
      readFile(fakeUpstreamPath),
      readFile(fakeUpstreamBundlePath)
    ]);
    const evidence = JSON.parse(evidenceText);

    expect(sha256(recorder)).toBe(evidence.recorder.sha256);
    expect(sha256(fakeUpstream)).toBe(evidence.upstream.entrySha256);
    expect(sha256(fakeUpstreamBundle)).toBe(evidence.upstream.bundleSha256);
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

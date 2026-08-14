import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const compatibilityUrl = new URL("../docs/mcp-compatibility.md", import.meta.url);
const retirementEvidenceUrl = new URL("../docs/legacy-retirement-evidence.md", import.meta.url);
const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const packageLockUrl = new URL("../package-lock.json", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const inspectorGateUrl = new URL("../scripts/check-inspector-interop.mjs", import.meta.url);

describe("MCP compatibility documentation contract", () => {
  it("names every owned, rejected, or deferred protocol feature by era", async () => {
    const documentation = await readFile(compatibilityUrl, "utf8");

    for (const contract of [
      "`initialize` then `notifications/initialized`",
      "`Mcp-Session-Id`",
      "Routing headers and cache hints",
      "Roots",
      "Sampling",
      "Logging",
      "Resource subscriptions and update notifications",
      "List-changed notifications",
      "Progress and cancellation",
      "Multi Round-Trip Requests",
      "Tasks extension",
      "MCP Apps",
      "Enterprise Managed Authorization"
    ]) {
      expect(documentation).toContain(contract);
    }
    expect(documentation).toContain("Standalone downstream HTTP+SSE");
    expect(documentation).toContain("Upstream legacy SSE");
    expect(documentation).toContain("Not implemented, proxied, or advertised");
  });

  it("keeps tested client claims exact and untested hosts explicit", async () => {
    const documentation = await readFile(compatibilityUrl, "utf8");
    const lockfile = JSON.parse(await readFile(packageLockUrl, "utf8")) as {
      packages: Record<string, { version?: string }>;
    };

    for (const name of ["client", "core", "server", "node", "server-legacy"]) {
      expect(lockfile.packages[`node_modules/@modelcontextprotocol/${name}`]?.version).toBe("2.0.0");
    }
    expect(documentation).toContain("MCP Inspector | `2.1.0`");
    expect(documentation).toContain("Claude Code | `2.1.228` observed on macOS");
    expect(documentation).toContain("Claude Desktop | `1.26832.0` observed on macOS");
    expect(documentation).toContain("VS Code | `1.132.0` (`df53daabb18cd157bdb08c7f01c34df936cf12f4`, arm64)");
    expect(documentation).toContain("Cursor | Not installed in the audit environment");
    expect(documentation).toContain("protocol compatibility remains unclaimed");
    expect(documentation).toContain("No version or runtime compatibility claim");
  });

  it("pins the packaged Inspector gate and keeps retirement outside v1.1", async () => {
    const [documentation, changelog, manifestText, workflow, inspectorGate] = await Promise.all([
      readFile(compatibilityUrl, "utf8"),
      readFile(changelogUrl, "utf8"),
      readFile(packageUrl, "utf8"),
      readFile(workflowUrl, "utf8"),
      readFile(inspectorGateUrl, "utf8")
    ]);
    const manifest = JSON.parse(manifestText) as { scripts?: Record<string, string> };

    expect(manifest.scripts?.["test:inspector"]).toContain("check-inspector-interop.mjs");
    expect(inspectorGate).toContain("@modelcontextprotocol/inspector@2.1.0");
    expect(inspectorGate).toContain('"--transport", "http"');
    expect(workflow).toContain("Test packaged MCP Inspector interoperability");
    expect(workflow).toContain("matrix.node == '22'");
    expect(workflow).toContain("npm run test:inspector");
    expect(documentation).toContain("Stateless protocol, stateful Miftah application");
    expect(documentation).toContain("Miftah does not claim that an MRTR continuation can resume in another process");
    expect(documentation).toContain("retirement gate #388");
    expect(documentation).toContain("major-version release plan");
    expect(changelog).toContain("[#368]");
    expect(changelog).toContain("[#388]");
  });

  it("keeps the retirement decision evidence-backed and explicitly deferred", async () => {
    const [documentation, retirementEvidence] = await Promise.all([
      readFile(compatibilityUrl, "utf8"),
      readFile(retirementEvidenceUrl, "utf8")
    ]);

    expect(documentation).toContain("legacy compatibility retirement evidence ledger");
    for (const contract of [
      "No removal is authorized",
      "@lubab/miftah@1.1.2",
      "Initialized `2025-11-25` serving over STDIO",
      "Initialized `2025-11-25` Streamable HTTP sessions",
      "Roots-derived routing context",
      "Resource subscriptions and list-changed notifications",
      'Upstream `transport: "sse"`',
      "Public SDK v1 `createMiftahRuntime` host path",
      "Rollback status: pending",
      "`named-host-runtime`",
      "explicit maintainer approval"
    ]) {
      expect(retirementEvidence).toContain(contract);
    }
  });
});

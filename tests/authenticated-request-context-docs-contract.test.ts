import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const libraryApiPath = fileURLToPath(new URL("../docs/library-api.md", import.meta.url));
const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const protocolReleaseVersion = "1.1.0";

describe("authenticated request-context documentation contract", () => {
  it("documents the trusted host boundary and the no-fallback compatibility path", async () => {
    const documentation = await readFile(libraryApiPath, "utf8");

    expect(documentation).toContain("createAuthenticatedRequestContextBoundary");
    expect(documentation).toContain("VerifiedHttpRequestClaims");
    expect(documentation).toContain("does not parse MCP `clientInfo`, arbitrary headers");
    expect(documentation).toContain("profile-scoped or operator-locked endpoint");
    expect(documentation).toContain("it is not an authorization credential");
    expect(documentation).toContain("accepts both the modern request-scoped protocol path and the legacy session-aware path");
    expect(documentation).toContain("does not synthesize verified per-chat claims");
  });

  it("records the additive security boundary under the v1.1.0 protocol release", async () => {
    const changelog = await readFile(changelogPath, "utf8");
    const escapedVersion = protocolReleaseVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const heading = changelog.match(new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
    expect(heading?.index).toBeTypeOf("number");
    const releaseStart = heading?.index ?? 0;
    const releaseEnd = changelog.indexOf("\n## ", releaseStart + (heading?.[0].length ?? 0));
    const protocolRelease = changelog.slice(releaseStart, releaseEnd < 0 ? undefined : releaseEnd);

    expect(protocolRelease).toContain("[#376]");
    expect(protocolRelease).toContain("for modern stateless handling");
    expect(protocolRelease).toContain("never falls back to MCP `clientInfo`");
    expect(protocolRelease).toContain("embedding hosts supply them through the public server factory");
  });
});

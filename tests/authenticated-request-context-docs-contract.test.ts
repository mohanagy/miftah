import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const libraryApiPath = fileURLToPath(new URL("../docs/library-api.md", import.meta.url));
const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const packageManifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

/** Returns the dated changelog section for an exact package version. */
function releaseNotes(changelog: string, version: string): string {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = changelog.match(new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
  if (heading?.index === undefined) return "";
  const end = changelog.indexOf("\n## ", heading.index + heading[0].length);
  return changelog.slice(heading.index, end < 0 ? undefined : end);
}

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

  it("records the additive security boundary under the package release", async () => {
    const changelog = await readFile(changelogPath, "utf8");
    const manifest = JSON.parse(await readFile(packageManifestPath, "utf8")) as { version: string };
    const currentRelease = releaseNotes(changelog, manifest.version);

    expect(currentRelease).toContain("[#376]");
    expect(currentRelease).toContain("for modern stateless handling");
    expect(currentRelease).toContain("never falls back to MCP `clientInfo`");
    expect(currentRelease).toContain("embedding hosts supply them through the public server factory");
  });
});

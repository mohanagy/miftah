import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const libraryApiPath = fileURLToPath(new URL("../docs/library-api.md", import.meta.url));
const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

describe("authenticated request-context documentation contract", () => {
  it("documents the trusted host boundary and the no-fallback compatibility path", async () => {
    const documentation = await readFile(libraryApiPath, "utf8");

    expect(documentation).toContain("createAuthenticatedRequestContextBoundary");
    expect(documentation).toContain("VerifiedHttpRequestClaims");
    expect(documentation).toContain("does not parse MCP `clientInfo`, arbitrary headers");
    expect(documentation).toContain("profile-scoped or operator-locked endpoint");
    expect(documentation).toContain("it is not an authorization credential");
    expect(documentation).toContain("remains the documented legacy session-aware path");
  });

  it("records the additive security boundary under the next release", async () => {
    const changelog = await readFile(changelogPath, "utf8");
    const [, afterUnreleased = ""] = changelog.split(/^## \[Unreleased\]\s*$/mu);
    const unreleased = afterUnreleased.split(/^## \[/mu, 1)[0] ?? "";

    expect(unreleased).toContain("[#376]");
    expect(unreleased).toContain("future modern stateless handling");
    expect(unreleased).toContain("never falls back to MCP `clientInfo`");
  });
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const libraryApiPath = fileURLToPath(new URL("../docs/library-api.md", import.meta.url));
const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const protocolReleaseVersion = "1.1.0";

describe("profile-context handle documentation contract", () => {
  it("documents the trusted modern host and deployment-wide fail-closed boundary", async () => {
    const documentation = await readFile(libraryApiPath, "utf8");

    expect(documentation).toContain("ProfileContextHandleService");
    expect(documentation).toContain("verified request result through the MCP SDK `authInfo`");
    expect(documentation).toContain("must enable a concrete audit journal");
    expect(documentation).toContain("same atomic `ProfileContextKeyringSnapshot`");
    expect(documentation).toContain("provide shared revocation storage");
    expect(documentation).toContain("strips either form before audit argument capture");
    expect(documentation).toContain("is not operation authorization or idempotency");
    expect(documentation).toContain("does not enable trusted `modernProfileContext` claims");
  });

  it("records the production boundary alongside protocol negotiation", async () => {
    const changelog = await readFile(changelogPath, "utf8");
    const escapedVersion = protocolReleaseVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const heading = changelog.match(new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
    expect(heading?.index).toBeTypeOf("number");
    const releaseStart = heading?.index ?? 0;
    const releaseEnd = changelog.indexOf("\n## ", releaseStart + (heading?.[0].length ?? 0));
    const protocolRelease = changelog.slice(releaseStart, releaseEnd < 0 ? undefined : releaseEnd);

    expect(protocolRelease).toContain("[#377]");
    expect(protocolRelease).toContain("opt-in production profile-context boundary");
    expect(protocolRelease).toContain("an embedding host enables the boundary through `createMiftahServerFactory`");
  });
});

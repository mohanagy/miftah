import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const libraryApiPath = fileURLToPath(new URL("../docs/library-api.md", import.meta.url));
const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const packageManifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

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
    const manifest = JSON.parse(await readFile(packageManifestPath, "utf8")) as { version: string };
    const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const heading = changelog.match(new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
    expect(heading?.index).toBeTypeOf("number");
    const releaseStart = heading?.index ?? 0;
    const releaseEnd = changelog.indexOf("\n## ", releaseStart + (heading?.[0].length ?? 0));
    const currentRelease = changelog.slice(releaseStart, releaseEnd < 0 ? undefined : releaseEnd);

    expect(currentRelease).toContain("[#377]");
    expect(currentRelease).toContain("opt-in production profile-context boundary");
    expect(currentRelease).toContain("an embedding host enables the boundary through `createMiftahServerFactory`");
  });
});

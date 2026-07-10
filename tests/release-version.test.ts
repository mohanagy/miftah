import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseVersion = "0.1.1";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function releaseNotes(changelog: string, version: string): string {
  const heading = `## [${version}] - `;
  const start = changelog.indexOf(heading);

  if (start < 0) {
    throw new Error(`Unable to find the ${version} changelog entry.`);
  }

  const end = changelog.indexOf("\n## ", start + heading.length);
  return changelog.slice(start, end < 0 ? undefined : end);
}

describe("v0.1.1 release artifacts", () => {
  it("aligns package and MCP handshake versions", () => {
    const manifest = JSON.parse(readRepositoryFile("package.json")) as { version: string };

    expect(manifest.version).toBe(releaseVersion);
    expect(readRepositoryFile("src/mcp/server/miftah-server.ts")).toContain(
      `version: "${manifest.version}"`
    );
    expect(readRepositoryFile("src/upstream/upstream-process-manager.ts")).toContain(
      `version: "${manifest.version}"`
    );
  });

  it("documents every hotfix while retaining the experimental package status", () => {
    const notes = releaseNotes(readRepositoryFile("CHANGELOG.md"), releaseVersion);

    for (const issue of ["#1", "#2", "#3", "#4", "#5"]) {
      expect(notes).toContain(issue);
    }
    expect(notes).toMatch(/policy.*fails?\s+closed|fails?\s+closed.*policy/iu);
    expect(notes).toMatch(/redact/iu);
    expect(notes).toMatch(/GitHub.*preset|preset.*GitHub/iu);
    expect(notes).toMatch(/multi.upstream/iu);
    expect(readRepositoryFile("README.md")).toContain("experimental and pre-1.0");
  });
});

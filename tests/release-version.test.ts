import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseVersion = "1.0.0";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function releaseNotes(changelog: string, version: string): string {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = changelog.match(
    new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu")
  );

  if (!match || match.index === undefined) {
    throw new Error(`Unable to find the ${version} changelog entry.`);
  }

  const end = changelog.indexOf("\n## ", match.index + match[0].length);
  return changelog.slice(match.index, end < 0 ? undefined : end);
}

describe("v1.0.0 release artifacts", () => {
  it.each([
    {
      name: "a non-zero-padded date",
      changelog: "## [1.0.0] - 2026-8-11\n\n### Changed\n"
    },
    {
      name: "a heading that does not start its line",
      changelog: "Release candidate: ## [1.0.0] - 2026-08-11\n\n### Changed\n"
    }
  ])("rejects $name", ({ changelog }) => {
    expect(() => releaseNotes(changelog, releaseVersion)).toThrow(
      `Unable to find the ${releaseVersion} changelog entry.`
    );
  });

  it("derives MCP, upstream, and CLI metadata from one package version", () => {
    const manifest = JSON.parse(readRepositoryFile("package.json")) as { version: string };
    const lockfile = JSON.parse(readRepositoryFile("package-lock.json")) as {
      packages?: Record<string, { version?: string }>;
      version?: string;
    };
    const versionModule = readRepositoryFile("src/version.ts");
    const packageVersion = readRepositoryFile("build/package-version.ts");

    expect(manifest.version).toBe(releaseVersion);
    expect(lockfile.version).toBe(releaseVersion);
    expect(lockfile.packages?.[""]?.version).toBe(releaseVersion);
    expect(packageVersion).toContain('import packageManifest from "../package.json" with { type: "json" }');
    expect(packageVersion).toContain("export const packageVersion = packageManifest.version");
    expect(versionModule).toContain("export const MIFTAH_VERSION = __MIFTAH_VERSION__");

    for (const path of ["tsup.config.ts", "vitest.config.ts"]) {
      const source = readRepositoryFile(path);
      expect(source).toContain('import { packageVersion } from "./build/package-version.js"');
      expect(source).toContain("__MIFTAH_VERSION__");
      expect(source).not.toContain(`"${manifest.version}"`);
    }

    for (const path of [
      "src/mcp/server/miftah-server.ts",
      "src/upstream/upstream-process-manager.ts",
      "src/cli/main.ts"
    ]) {
      const source = readRepositoryFile(path);
      expect(source).toContain("MIFTAH_VERSION");
      expect(source).not.toContain(`"${manifest.version}"`);
    }
  });

  it("documents the stable v1 contract and its evidence boundary", () => {
    const changelog = readRepositoryFile("CHANGELOG.md");
    const notes = releaseNotes(changelog, releaseVersion);

    expect(notes).toContain("### Changed");
    expect(notes).toContain("[#39](https://github.com/mohanagy/miftah/issues/39)");
    expect(notes).toContain("[#373](https://github.com/mohanagy/miftah/issues/373)");
    expect(notes).toContain("stable Semantic Versioning contract");
    for (const dependency of ["fast-uri", "ip-address", "hono", "brace-expansion", "nanoid"]) {
      expect(notes).toContain(dependency);
    }
    expect(notes).toContain("5/5 completed external workflows");
    expect(notes).toContain("3 returning participants");
    expect(notes).toContain("3 unaided evaluators");
    expect(notes).toContain("maintainer attestation");
    expect(notes).toContain("not independently inspected");
    expect(notes).toContain("protected OIDC publication");

    const readme = readRepositoryFile("README.md");
    const compatibilityGuide = readRepositoryFile("docs/presets-and-clients.md");
    const libraryGuide = readRepositoryFile("docs/library-api.md");

    expect(readme).toContain("Use the right account with the MCP servers you already trust");
    expect(readme).toContain("stable v1 release line");
    expect(readme).toContain("closed by maintainer attestation");
    expect(readme).not.toContain("experimental and pre-1.0");
    expect(readme).toContain(`npm install -g @lubab/miftah@${releaseVersion}`);
    expect(compatibilityGuide).toContain(`Miftah package version: \`${releaseVersion}\``);
    expect(libraryGuide).toContain("Starting with Miftah 1.0, these public surfaces follow Semantic Versioning");
    expect(libraryGuide).toContain("requires a new major release");
  });
});

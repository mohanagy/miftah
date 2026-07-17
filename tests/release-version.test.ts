import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseVersion = "0.2.1";

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

describe("v0.2.1 release artifacts", () => {
  it.each([
    "## [0.2.1] - 2026-7-17\n\n### Fixed\n",
    "Release candidate: ## [0.2.1] - 2026-07-17\n\n### Fixed\n"
  ])("requires a dated release heading at the start of a line", (changelog) => {
    expect(() => releaseNotes(changelog, releaseVersion)).toThrow(
      "Unable to find the 0.2.1 changelog entry."
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

  it("documents the full release while retaining the experimental package status", () => {
    const changelog = readRepositoryFile("CHANGELOG.md");
    const notes = releaseNotes(changelog, releaseVersion);

    expect(notes).toContain("### Fixed");
    for (const issue of ["#79", "#80"]) {
      expect(notes).toContain(issue);
    }
    expect(notes).toMatch(/OAuth support boundary/iu);
    expect(notes).toMatch(/threat.model/iu);
    expect(notes).toMatch(/does not (?:implement|run).*native OAuth/iu);
    expect(notes).toMatch(/upstream.owned|provider.owned/iu);
    expect(readRepositoryFile("README.md")).toContain("experimental and pre-1.0");
  });
});

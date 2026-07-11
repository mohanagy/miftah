import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPresetConfig, PRESET_CATALOG } from "../src/config/presets.js";
import { validateConfig } from "../src/config/validate-config.js";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function parseRepositoryJson(path: string): unknown {
  return JSON.parse(readRepositoryFile(path)) as unknown;
}

function unreleasedSection(changelog: string): string {
  const afterHeading = changelog.split(/^## \[Unreleased\]\s*$/mu)[1];
  if (afterHeading === undefined) {
    throw new Error("CHANGELOG.md must contain an Unreleased section.");
  }
  const nextRelease = afterHeading.search(/^## \[/mu);
  return nextRelease === -1 ? afterHeading : afterHeading.slice(0, nextRelease);
}

describe("preset documentation contract", () => {
  it("keeps the catalog, generated examples, onboarding docs, provenance, and changelog aligned", () => {
    const compatibility = readRepositoryFile("docs/presets-and-clients.md");
    const readme = readRepositoryFile("README.md");
    const cli = readRepositoryFile("docs/cli.md");
    const changelog = readRepositoryFile("CHANGELOG.md");
    const packageManifest = parseRepositoryJson("package.json") as { version: string };

    expect(compatibility).toContain(`Catalog version: \`${PRESET_CATALOG.version}\``);
    expect(compatibility).toContain(`Miftah package version: \`${packageManifest.version}\``);
    for (const preset of Object.keys(PRESET_CATALOG.presets)) {
      expect(compatibility).toContain(`\`${preset}\``);
    }

    for (const [name, preset] of [
      ["generic", "generic"],
      ["github", "github"],
      ["sentry", "sentry"]
    ] as const) {
      const example = parseRepositoryJson(`examples/${name}.miftah.json`);
      expect(example).toEqual(buildPresetConfig(name, preset));
      expect(() => validateConfig(example)).not.toThrow();
    }

    for (const requiredFact of [
      "@modelcontextprotocol/server-everything@2026.7.4",
      "ghcr.io/github/github-mcp-server:v1.5.0",
      "--read-only",
      "repos,issues,pull_requests",
      "@sentry/mcp-server@0.36.0",
      "--skills=inspect",
      "https://github.com/github/github-mcp-server",
      "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server",
      "https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#read-only-mode",
      "https://github.com/github/github-mcp-server#tool-configuration",
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pull-by-digest",
      "https://github.com/getsentry/sentry-mcp/tree/0.36.0",
      "https://registry.npmjs.org/@sentry/mcp-server/0.36.0",
      "https://github.com/getsentry/sentry-mcp/blob/0.36.0/packages/mcp-server/src/cli/usage.ts",
      "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
      "https://www.npmjs.com/package/@modelcontextprotocol/server-everything",
      "https://code.claude.com/docs/en/mcp",
      "https://cursor.com/docs/mcp",
      "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
      "https://code.visualstudio.com/docs/agents/reference/mcp-configuration"
    ]) {
      expect(compatibility).toContain(requiredFact);
    }

    expect(readme).toContain("docs/presets-and-clients.md");
    expect(cli).toContain("presets-and-clients.md");
    for (const option of [
      "--interactive",
      "--client",
      "--credential-env",
      "--npm-package",
      "--docker-image",
      "--url",
      "--header-name",
      "--header-prefix"
    ]) {
      expect(cli).toContain(option);
    }

    const unreleased = unreleasedSection(changelog);
    expect(unreleased).toMatch(/\[#19\][\s\S]*catalog[\s\S]*onboarding/iu);
  });
});

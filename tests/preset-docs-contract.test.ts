import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPresetConfig, PRESET_CATALOG } from "../src/config/presets.js";
import { validateConfig } from "../src/config/validate-config.js";
import { changelogIssueEntry } from "./helpers/changelog.js";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function parseRepositoryJson(path: string): unknown {
  return JSON.parse(readRepositoryFile(path)) as unknown;
}

describe("preset documentation contract", () => {
  it("keeps the catalog, generated examples, onboarding docs, provenance, and changelog aligned", () => {
    const compatibility = readRepositoryFile("docs/presets-and-clients.md");
    const readme = readRepositoryFile("README.md");
    const cli = readRepositoryFile("docs/cli.md");
    const claudeDesktop = readRepositoryFile("docs/claude-desktop.md");
    const providerAdapters = readRepositoryFile("docs/provider-adapters.md");
    const oauthSupport = readRepositoryFile("docs/oauth-support.md");
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
      "mcp-search-console@0.3.2",
      "GSC_OAUTH_CLIENT_SECRETS_FILE",
      "GSC_CONFIG_DIR"
    ]) {
      expect(compatibility).toContain(requiredFact);
    }
    for (const sourceLink of [
      "[GitHub MCP source](https://github.com/github/github-mcp-server)",
      "[GitHub IDE setup](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server)",
      "[GitHub read-only mode](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#read-only-mode)",
      "[GitHub tool configuration](https://github.com/github/github-mcp-server#tool-configuration)",
      "[GitHub Container registry pull by digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pull-by-digest)",
      "[Sentry MCP source at `0.36.0`](https://github.com/getsentry/sentry-mcp/tree/0.36.0)",
      "[Sentry package metadata at `0.36.0`](https://registry.npmjs.org/@sentry/mcp-server/0.36.0)",
      "[Sentry `0.36.0` CLI usage](https://github.com/getsentry/sentry-mcp/blob/0.36.0/packages/mcp-server/src/cli/usage.ts)",
      "[MCP Everything source](https://github.com/modelcontextprotocol/servers/tree/main/src/everything)",
      "[MCP Everything npm package](https://www.npmjs.com/package/@modelcontextprotocol/server-everything)",
      "[Google Search Console MCP source](https://github.com/AminForou/mcp-gsc)",
      "[Google Search Console MCP package](https://pypi.org/project/mcp-search-console/0.3.2/)",
      "[uv tool version pinning](https://docs.astral.sh/uv/guides/tools/#installing-tools)",
      "[Claude Code MCP](https://code.claude.com/docs/en/mcp)",
      "[Cursor MCP](https://cursor.com/docs/mcp)",
      "[VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)",
      "[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)"
    ]) {
      expect(compatibility).toContain(sourceLink);
    }

    expect(readme).toContain("[Preset and client compatibility](docs/presets-and-clients.md)");
    expect(cli).toContain("[preset and client compatibility](presets-and-clients.md)");
    expect(claudeDesktop).toContain("Merge the generated top-level `mcpServers` property");
    expect(claudeDesktop).toMatch(/merge the generated server entry into that object instead of nesting/iu);
    expect(claudeDesktop).not.toContain("Paste the generated JSON into the `mcpServers` object");
    expect(claudeDesktop).not.toContain("Linux: `~/.config/Claude/claude_desktop_config.json`");
    expect(compatibility).not.toContain("Linux: `~/.config/Claude/claude_desktop_config.json`");
    for (const option of [
      "--name",
      "--preset",
      "--output",
      "--interactive",
      "--client",
      "--credential-env",
      "--npm-package",
      "--docker-image",
      "--url",
      "--header-name",
      "--header-prefix",
      "--oauth-client-secrets-file"
    ]) {
      expect(cli).toContain(option);
    }
    expect(compatibility).not.toContain("runtime construction");
    expect(compatibility).toContain(
      "Miftah does not generate equivalent per-tool client permission guidance for Claude Desktop, Cursor, or VS Code"
    );

    const issue19 = changelogIssueEntry(changelog, 19);
    const issue98 = changelogIssueEntry(changelog, 98);
    const issue87 = changelogIssueEntry(changelog, 87);
    expect(issue19).toContain("catalog");
    expect(issue19).toContain("onboarding");
    expect(issue98).toContain("permission");
    expect(issue98).not.toContain("runtime construction");
    expect(issue87).toContain("upstream-owned");
    expect(providerAdapters).toContain("## Google Search Console pilot");
    expect(providerAdapters).toContain("Credential ownership | Upstream");
    expect(providerAdapters).toContain("Each generated Miftah configuration/profile pair passes a distinct `GSC_CONFIG_DIR`");
    expect(providerAdapters).toContain("The upstream creates and maintains its token cache there");
    expect(providerAdapters).toContain("Miftah never creates, reads, copies, exports, or deletes that cache");
    expect(providerAdapters).toContain("This is cache isolation, not Google-account identity verification");
    expect(providerAdapters).toContain("GSC_CREDENTIALS_PATH");
    expect(providerAdapters).toContain("GSC_SKIP_OAUTH=true");
    expect(providerAdapters).toContain("get_capabilities");
    expect(providerAdapters).toContain("reauthenticate");
    expect(providerAdapters).toContain("GSC_ALLOW_DESTRUCTIVE");
    expect(oauthSupport).not.toContain("No provider-adapter API exists today");
    expect(oauthSupport).toContain("Google Search Console pilot");
  });
});

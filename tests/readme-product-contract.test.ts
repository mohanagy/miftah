import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, renderCommandHelp, type CliCommand } from "../src/cli/parse.js";
import { buildPresetConfig, PRESET_CATALOG } from "../src/config/presets.js";
import { CURRENT_CONFIG_VERSION, SUPPORTED_CONFIG_VERSIONS } from "../src/config/versions.js";
import { MANAGEMENT_TOOL_NAMES } from "../src/mcp/server/management-tools.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const duplicates = new Map<string, number>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
    const base = match[1]!
      .toLowerCase()
      .replace(/[`*~]/gu, "")
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = duplicates.get(base) ?? 0;
    duplicates.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

describe("product README", () => {
  it("leads with the multi-account outcome instead of internal implementation terms", () => {
    expect(readme).toContain("## One MCP connector. Deliberate account selection.");
    expect(readme).toContain("same MCP service across more than one account");
    expect(readme).toContain("Do not create one client entry for every account.");
    expect(readme).not.toContain("credential broker");
  });

  it("sets practical expectations for local operation, audit logging, and GUI secret setup", () => {
    expect(readme).toContain("Miftah itself has no cloud service or telemetry");
    expect(readme).toContain("Optional, redacted local audit metadata");
    expect(readme).toContain("Claude Desktop is a GUI app and does not inherit terminal startup files");
  });

  it("explains what Miftah changes and what it deliberately does not replace", () => {
    expect(readme).toContain("one Miftah connector per service");
    expect(readme).toContain("Miftah wraps an existing upstream MCP server. It does not replace it.");
    expect(readme).toContain("Provider-specific or local STDIO OAuth remains owned by that upstream");
  });

  it("keeps a practical Claude Desktop path and routes detailed material to the docs", () => {
    expect(readme).toContain("miftah init github --preset github");
    expect(readme).toContain("[Claude Desktop setup](docs/claude-desktop.md)");
    expect(readme).toContain("[Configuration reference](docs/config.md)");
    expect(readme).toContain("[Security boundary](docs/security.md)");
  });

  it("gives a first-time user complete setup and profile-selection journeys", () => {
    expect(readme).toContain("## Choose your setup path");
    expect(readme).toContain("miftah setup");
    expect(readme).toContain("never asks for a token, password, or browser cookie");
    expect(readme).toContain("## First setup: GitHub with Claude Desktop");
    expect(readme).toContain("Developer → Edit Config");
    expect(readme).toContain("restart Claude Desktop");
    expect(readme).toContain("miftah test-profile --config");
    expect(readme).toContain("miftah list-tools --config");
    expect(readme).toContain("`miftah_list_profiles`");
    expect(readme).toContain("`miftah_current_profile`");
    expect(readme).toContain("`miftah_use_profile`");
    expect(readme).toContain("`miftah_reset_profile`");
    expect(readme).toContain("through `github`");
    expect(readme).not.toContain("through miftah-github");
    expect(readme).toContain("The generated GitHub preset requires confirmation for every profile switch");
    expect(readme).toContain("form elicitation");
    expect(readme).toContain("`command` as a string and `args` as an array");
  });

  it("separates generic MCP, native OAuth, and upstream-owned OAuth onboarding", () => {
    expect(readme).toContain("## Add another MCP");
    expect(readme).toContain("--preset generic-npx");
    expect(readme).toContain("--npm-package");
    expect(readme).toContain("## OAuth and the local dashboard");
    expect(readme).toContain("Native remote OAuth");
    expect(readme).toContain("Upstream-owned OAuth");
    expect(readme).toContain("miftah connection add --config");
    expect(readme).toContain("miftah auth connect --config");
    expect(readme).toContain("--preset google-search-console");
    expect(readme).toContain("miftah setup gsc --preset google-search-console");
    expect(readme).toContain("one or more named Google accounts");
    expect(readme).toContain(
      "miftah init remote-service --preset streamable-http --url https://mcp.example.com --output ~/.config/miftah/remote-service.json"
    );
    expect(readme).toMatch(
      /miftah connection add --config ~\/\.config\/miftah\/remote-service\.json \\\n\s+--profile default/gu
    );
    expect(readme).toContain("The `streamable-http` preset creates one profile named `default`");
    expect(readme).toContain("oauthconn:UUID_FROM_PLAN");
    expect(readme).not.toContain("oauthconn:<uuid>");
    expect(readme).toContain("uses `~/.config/miftah/miftah.json` by default");
  });

  it("describes the Claude Desktop guide without promising missing screenshots", () => {
    expect(readme).toContain("For host-specific notes, use the [Claude Desktop setup]");
    expect(readme).not.toContain("For screenshots and host-specific notes");
  });

  it("makes everyday safety and operational features discoverable", () => {
    expect(readme).toContain("## Everyday commands");
    expect(readme).toContain("miftah logs --config");
    expect(readme).toContain("miftah audit-export --config");
    expect(readme).toContain("miftah audit-verify --config");
    expect(readme).toContain("## Secrets, policy, routing, and identity");
    expect(readme).toContain("`${ENV_NAME}`");
    expect(readme).toContain("`secretref:env://ENV_NAME`");
    expect(readme).toContain("`miftah_route_preview`");
    expect(readme).toContain("`miftah_verify_identity`");
    expect(readme).toContain("Shell examples below use POSIX syntax");
    expect(readme).toContain("Confirm with `miftah doctor --config ~/.config/miftah/github.json`");
  });

  it("keeps every local README link and heading anchor resolvable", () => {
    const links = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]!);
    for (const link of links) {
      if (/^(?:https?:|mailto:)/u.test(link)) continue;
      const [path, fragment] = link.split("#", 2);
      const target = new URL(path === "" ? "../README.md" : `../${path}`, import.meta.url);
      expect(existsSync(target), `missing README link target: ${link}`).toBe(true);
      expect(statSync(target).isFile(), `README link target is not a file: ${link}`).toBe(true);
      if (fragment !== undefined && fragment.length > 0) {
        const targetMarkdown = readFileSync(target, "utf8");
        expect(headingSlugs(targetMarkdown), `missing README anchor: ${link}`).toContain(fragment);
      }
    }
  });

  it("models GitHub heading anchors with underscores", () => {
    expect(headingSlugs("### `DEFAULT_PROFILE_NOT_FOUND`")).toContain("default_profile_not_found");
  });

  it("models GitHub heading anchors without collapsing repeated hyphens", () => {
    expect(headingSlugs("## Foo - Bar")).toContain("foo---bar");
  });

  it("binds documented preset and management-tool names to production catalogs", () => {
    const presetNames = [...readme.matchAll(/--preset\s+([a-z0-9-]+)/gu)].map((match) => match[1]!);
    for (const preset of presetNames) {
      expect(Object.keys(PRESET_CATALOG.presets), `unknown README preset: ${preset}`).toContain(preset);
    }

    const managementNames = new Set(readme.match(/\bmiftah_[a-z0-9_]+\b/gu) ?? []);
    for (const managementName of managementNames) {
      expect(MANAGEMENT_TOOL_NAMES, `unknown README management tool: ${managementName}`).toContain(managementName);
    }
  });

  it("binds fenced and inline shell commands and flags to the production CLI contract", () => {
    const bashBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]!);
    const fencedLines = bashBlocks.flatMap((block) =>
      block
        .replace(/\\\n\s*/gu, " ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("miftah "))
    );
    const inlineLines = [...readme.matchAll(/`(miftah [^`\n]+)`/gu)]
      .map((match) => match[1]!)
      .filter((line) => !line.includes("<command>") && line !== "miftah --help");
    const logicalLines = [...new Set([...fencedLines, ...inlineLines])];

    for (const line of logicalLines) {
      const match = /^miftah\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/u.exec(line);
      expect(match, `could not parse README command: ${line}`).not.toBeNull();
      const primary = match![1]!;
      const command = (primary === "connection" || primary === "auth" ? `${primary} ${match![2]}` : primary) as CliCommand;
      expect(Object.keys(CLI_COMMANDS), `unknown README command: ${command}`).toContain(command);
      const help = renderCommandHelp(command);
      const supportedFlags = new Set(help.match(/--[a-z][a-z-]*/gu) ?? []);
      for (const flag of line.match(/--[a-z][a-z-]*/gu) ?? []) {
        expect(supportedFlags, `unsupported README flag for ${command}: ${flag}`).toContain(flag);
      }
    }
  });

  it("uses a profile created by the documented native OAuth preset", () => {
    const profile = /miftah connection add --config ~\/\.config\/miftah\/remote-service\.json \\\n\s+--profile ([a-z0-9-]+)/u.exec(
      readme
    )?.[1];
    expect(profile, "missing native OAuth profile").toBeDefined();
    const config = buildPresetConfig("remote-service", "streamable-http", {
      url: "https://mcp.example.com"
    });
    expect(Object.keys(config.profiles), `unknown native OAuth profile: ${profile}`).toContain(profile);
  });

  it("routes readers to a configuration guide that identifies v3 as the current format", () => {
    const config = readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");
    const supportedVersions = SUPPORTED_CONFIG_VERSIONS.map((version) => `\`"${version}"\``);
    const supportedVersionList =
      supportedVersions.length === 1
        ? supportedVersions[0]
        : `${supportedVersions.slice(0, -1).join(", ")}, and ${supportedVersions.at(-1)}`;
    expect(config).toContain(
      `Version \`"${CURRENT_CONFIG_VERSION}"\` is the canonical format written by current presets and examples.`
    );
    expect(config).toContain(`Miftah accepts versions ${supportedVersionList}`);
    expect(config).toContain("`migrate-config` supports v1/v2 input and v3 output");
  });

  it("documents the complete built-in secret grammar at the linked target", () => {
    const config = readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");
    expect(config).toContain("| Process environment | `${ENV_NAME}` or `secretref:env://ENV_NAME`");
    expect(config).toContain("| Dotenv | `secretref:dotenv://<name>` with `secrets.envFiles`");
    expect(config).toContain("| Explicit plaintext opt-in | `secretref:plain://<value>`");
    expect(config).toContain("For keychain and 1Password references, each path component");
  });

  it("records both the onboarding rewrite and corrected version guidance", () => {
    expect(changelog).toContain("Reworked the README into a task-oriented first-use guide");
    expect(changelog).toContain("corrected stale configuration-version guidance");
  });
});

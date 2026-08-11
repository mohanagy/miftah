import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, renderCommandHelp, type CliCommand } from "../src/cli/parse.js";
import { PRESET_CATALOG } from "../src/config/presets.js";
import { CURRENT_CONFIG_VERSION, SUPPORTED_CONFIG_VERSIONS } from "../src/config/versions.js";
import { MANAGEMENT_TOOL_NAMES } from "../src/mcp/server/management-tools.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const cliDocs = readFileSync(new URL("../docs/cli.md", import.meta.url), "utf8");
const configDocs = readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");
const oauthDocs = readFileSync(new URL("../docs/oauth-support.md", import.meta.url), "utf8");
const presetDocs = readFileSync(new URL("../docs/presets-and-clients.md", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

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
  it("keeps the first-use front door short and progressively disclosed", () => {
    const lines = readme.split("\n");
    const fitIndex = lines.indexOf("## Is Miftah for you?");
    const quickStartIndex = lines.indexOf("## Quick start");
    const setupPathIndex = lines.indexOf("## Choose your setup and authentication path");
    const safetyIndex = lines.indexOf("## Safety boundaries");
    const deeperIndex = lines.indexOf("## Go deeper");

    expect(lines.length).toBeLessThanOrEqual(260);
    expect(fitIndex).toBeGreaterThan(0);
    expect(fitIndex).toBeLessThan(80);
    expect(quickStartIndex).toBeGreaterThan(fitIndex);
    expect(quickStartIndex).toBeLessThan(120);
    expect(setupPathIndex).toBeGreaterThan(quickStartIndex);
    expect(safetyIndex).toBeGreaterThan(setupPathIndex);
    expect(deeperIndex).toBeGreaterThan(safetyIndex);
  });

  it("lets a first-screen reader understand the product and its fit", () => {
    const firstScreen = readme.split("\n").slice(0, 50).join("\n");

    expect(firstScreen).toContain("Use the right account with the MCP servers you already trust");
    expect(firstScreen).toContain("one Miftah connector for a service");
    expect(firstScreen).toContain("work     personal");
    expect(firstScreen).toContain("Miftah itself has no cloud service or telemetry");
    expect(firstScreen).toContain("## Is Miftah for you?");
    expect(firstScreen).toContain("Keep your direct MCP entry when you use one account");
    expect(firstScreen).toContain("stable v1 release line");
    expect(firstScreen).toContain("closed by maintainer attestation");
    expect(firstScreen).toContain(
      "source participant records and completed security report are not published in this repository",
    );
    expect(firstScreen).toContain("[#39]");
    expect(firstScreen).not.toContain("experimental and pre-1.0");
  });

  it("explains one connector with named profiles instead of duplicate entries", () => {
    expect(readme).toContain("## One connector, named profiles");
    expect(readme).toContain("`github-work` and `github-personal`");
    expect(readme).toContain("one `github` connector");
    expect(readme).toContain("Miftah exposes management tools");
    expect(readme).toContain("`miftah_list_profiles`");
    expect(readme).toContain("`miftah_current_profile`");
    expect(readme).toContain("`miftah_use_profile`");
    expect(readme).toContain("The upstream's tools keep their original names.");
  });

  it("keeps one literal, version-aligned GitHub first-success path", () => {
    expect(readme).toContain(`npm install -g ${packageJson.name}@${packageJson.version}`);
    expect(readme).toContain(
      "miftah init github --preset github --output ~/.config/miftah/github.json --client claude-desktop"
    );
    expect(readme).toContain("miftah validate --config ~/.config/miftah/github.json");
    expect(readme).toContain("miftah doctor --config ~/.config/miftah/github.json");
    expect(readme).toContain("miftah test-profile --config ~/.config/miftah/github.json --profile work");
    expect(readme).toContain("`GITHUB_WORK_TOKEN` and `GITHUB_PERSONAL_TOKEN`");
    expect(readme).toContain("[secret provider](docs/config.md#secret-providers)");
    expect(readme).toContain("It does not edit Claude Desktop and does not ask for or write a token.");
    expect(readme).toContain("Claude Desktop is a GUI app and does not normally inherit variables");
  });

  it("puts both human-first setup surfaces before the scripted quick-start path", () => {
    const quickStartStart = readme.indexOf("## Quick start");
    const quickStartEnd = readme.indexOf("## Choose your setup and authentication path");
    expect(quickStartStart).toBeGreaterThanOrEqual(0);
    expect(quickStartEnd).toBeGreaterThan(quickStartStart);
    const quickStart = readme.slice(quickStartStart, quickStartEnd);
    const terminalWizardIndex = quickStart.indexOf("miftah setup");
    const browserConsoleIndex = quickStart.indexOf("miftah dashboard");
    const scriptedInitIndex = quickStart.indexOf("miftah init");

    expect(terminalWizardIndex).toBeGreaterThan(0);
    expect(browserConsoleIndex).toBeGreaterThan(terminalWizardIndex);
    expect(scriptedInitIndex).toBeGreaterThan(browserConsoleIndex);
    expect(quickStart).toContain("Terminal wizard");
    expect(quickStart).toContain("Browser Console");
  });

  it("separates secret, native OAuth, and upstream-owned authentication", () => {
    expect(readme).toContain("## Choose your setup and authentication path");
    expect(readme).toContain("API key, token, or another secret");
    expect(readme).toContain("Standards-compatible remote HTTPS MCP with OAuth");
    expect(readme).toContain("Local or provider-specific MCP that opens its own login");
    expect(readme).toContain("Miftah does not scrape that cache.");
    expect(readme).toContain("Native OAuth is intentionally narrow");
    expect(readme).toContain("not promised for every remote MCP or provider");
    expect(readme).toContain("miftah setup --native-oauth");
    expect(readme).toContain("[OAuth guide](docs/oauth-support.md)");
  });

  it("makes the wizard, CLI, optional Console, and client paths easy to find", () => {
    expect(readme).toContain("## Wizard, CLI, clients, and optional Console");
    expect(readme).toContain("`miftah setup` is the guided terminal wizard");
    expect(readme).toContain("`miftah init` is the optional scripted preset path");
    expect(readme).toContain("`miftah dashboard` opens the optional foreground-only local Console");
    expect(readme).toContain("It is not required to run Miftah.");
    expect(readme).toContain("Claude Desktop, Claude Code, Cursor, and VS Code");
    expect(readme).toContain("Miftah never silently edits their settings.");
    expect(readme).toContain("[Setup paths](docs/presets-and-clients.md)");
    expect(readme).toContain("[Console guide](docs/console-api.md)");
  });

  it("retains concise security and platform boundaries without a front-page architecture wall", () => {
    expect(readme).toContain("## Safety boundaries");
    expect(readme).toContain("Local policy can allow, deny, or require confirmation");
    expect(readme).toContain("it cannot reduce permissions already granted");
    expect(readme).toContain("Credential readiness, token health, and verified account identity are different claims.");
    expect(readme).toContain("not a remotely anchored immutable trail");
    expect(readme).toContain("Miftah refuses them instead of invoking `cmd.exe`.");
    expect(readme).toContain("direct `.exe` or `.com` executable");
    expect(readme).not.toContain("## What Miftah controls—and what it does not");
    expect(readme).not.toContain("## Architecture");
  });

  it("links detailed setup, OAuth, security, architecture, and troubleshooting material", () => {
    expect(readme).toContain("[Setup paths](docs/presets-and-clients.md)");
    expect(readme).toContain("[OAuth guide](docs/oauth-support.md)");
    expect(readme).toContain("[Security boundary](docs/security.md)");
    expect(readme).toContain("[Architecture](docs/architecture.md)");
    expect(readme).toContain("[Troubleshooting](docs/cli.md#troubleshooting)");
    expect(readme).toContain("[Configuration reference](docs/config.md)");
    expect(readme).toContain("[CLI reference](docs/cli.md)");
  });

  it("keeps linked reference docs explicit about compatibility and ownership", () => {
    expect(presetDocs).toContain(`Miftah package version: \`${packageJson.version}\``);
    expect(presetDocs).toContain("Claude Desktop");
    expect(presetDocs).toContain("Claude Code");
    expect(presetDocs).toContain("Cursor");
    expect(presetDocs).toContain("VS Code");
    expect(presetDocs).toContain("Its first step lists five numbered starting points");
    expect(presetDocs).toContain("enter `back` there to return to the starting-point list");
    expect(presetDocs).not.toContain("choose `remote sign-in`");
    expect(oauthDocs).toContain("Miftah does not support OAuth for every MCP server or provider.");
    expect(oauthDocs).toContain("## Local and provider-owned OAuth");
    expect(oauthDocs).toContain("Miftah must not scrape, copy, or manage that upstream token cache.");
  });

  it("keeps troubleshooting aligned with the quick-start configuration", () => {
    expect(cliDocs).toContain("## Troubleshooting");
    expect(cliDocs).toContain("### `DEFAULT_PROFILE_NOT_FOUND`");
    expect(cliDocs).toContain("### `SECRET_ENV_MISSING` after exporting a variable");
    expect(cliDocs).toContain("miftah validate --config ~/.config/miftah/github.json");
    expect(cliDocs).toContain("miftah doctor --config ~/.config/miftah/github.json");
    expect(cliDocs).toContain("Miftah does not replace an already-running MCP session");
    expect(cliDocs).toContain("`OAUTH_INTERACTIVE_REQUIRED`");
  });

  it("records the redesign without claiming external validation", () => {
    expect(changelog).toContain("[#290](https://github.com/mohanagy/miftah/issues/290)");
    expect(changelog).toContain("Redesigned the README as a concise product front door");
    expect(changelog).toContain("External evaluator acceptance remains open and is not claimed");
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

  it("binds fenced and inline Miftah commands and flags to the production CLI contract", () => {
    const bashBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]!);
    const fencedLines = bashBlocks.flatMap((block) =>
      block
        .replace(/\\\n\s*/gu, " ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("miftah "))
    );
    const inlineLines = [...readme.matchAll(/`(miftah [^`\n]+)`/gu)].map((match) => match[1]!);
    const logicalLines = [...new Set([...fencedLines, ...inlineLines])];

    for (const line of logicalLines) {
      const match = /^miftah\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/u.exec(line);
      expect(match, `could not parse README command: ${line}`).not.toBeNull();
      const primary = match![1]!;
      const command = (primary === "connection" || primary === "auth" || primary === "profile"
        ? `${primary} ${match![2]}`
        : primary) as CliCommand;
      expect(Object.keys(CLI_COMMANDS), `unknown README command: ${command}`).toContain(command);
      const supportedFlags = new Set(renderCommandHelp(command).match(/--[a-z][a-z-]*/gu) ?? []);
      for (const flag of [...line.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/gu)].map((flagMatch) => flagMatch[1]!)) {
        expect(supportedFlags, `unsupported README flag for ${command}: ${flag}`).toContain(flag);
      }
    }
  });

  it("keeps every fenced quick-start command literally pasteable", () => {
    const bashBlocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]!);
    for (const block of bashBlocks) {
      expect(block).not.toMatch(/[<>]/u);
    }
    expect(readme).not.toContain("oauthconn:<uuid>");
  });

  it("routes readers to the current configuration and secret grammar", () => {
    const supportedVersions = SUPPORTED_CONFIG_VERSIONS.map((version) => `\`"${version}"\``);
    const supportedVersionList =
      supportedVersions.length === 1
        ? supportedVersions[0]
        : `${supportedVersions.slice(0, -1).join(", ")}, and ${supportedVersions.at(-1)}`;

    expect(configDocs).toContain(
      `Version \`"${CURRENT_CONFIG_VERSION}"\` is the canonical format written by current presets and examples.`
    );
    expect(configDocs).toContain(`Miftah accepts versions ${supportedVersionList}`);
    expect(configDocs).toContain("| Process environment | `${ENV_NAME}` or `secretref:env://ENV_NAME`");
    expect(configDocs).toContain("| Dotenv | `secretref:dotenv://<name>` with `secrets.envFiles`");
    expect(configDocs).toContain("| Explicit plaintext opt-in | `secretref:plain://<value>`");
  });
});

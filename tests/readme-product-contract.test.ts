import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, renderCommandHelp, type CliCommand } from "../src/cli/parse.js";
import { buildPresetConfig, PRESET_CATALOG } from "../src/config/presets.js";
import { CURRENT_CONFIG_VERSION, SUPPORTED_CONFIG_VERSIONS } from "../src/config/versions.js";
import { MANAGEMENT_TOOL_NAMES } from "../src/mcp/server/management-tools.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const cliDocs = readFileSync(new URL("../docs/cli.md", import.meta.url), "utf8");

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
    expect(readme).toContain("choose `connector`, `remote`, `local`, `browser sign-in`, or `import`");
    expect(readme).toContain("enter `remote` for a remote HTTPS endpoint");
    expect(readme).toContain("`local` for a reviewed executable and argument array");
    expect(readme).toContain("can print an optional client JSON snippet for manual review");
    expect(readme).toContain("When setup finishes, Miftah tells you whether it ran a reviewed check, skipped one, or had no declared safe check at all.");
    expect(readme).toContain("Browser sign-in setup can finish with browser authorization still outstanding.");
    expect(readme).toContain("You still review and merge any client JSON yourself, then restart or reconnect the client.");
    expect(readme).toContain("The generic `remote` path does not discover authentication or call the endpoint");
    expect(readme).toContain("Choose `browser sign-in` when the remote MCP opens a browser to authenticate you");
    expect(readme).toContain("Keep `miftah setup --native-oauth` for scripted or repeatable setup");
    expect(readme).toContain("Remote MCP with browser sign-in");
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

  it("keeps the CLI reference aligned with the five guided setup sources", () => {
    expect(cliDocs).toContain(
      "With a bare TTY invocation, it asks what you already have: `connector`, `remote`, `local`, `browser sign-in`, or `import`."
    );
    expect(cliDocs).toContain("The completion handoff prints the actual configuration path in any later `miftah profile test` command.");
    expect(cliDocs).toContain("Browser sign-in setup can finish with browser authorization still outstanding.");
    expect(cliDocs).not.toContain("it first offers `new` or `import`");
  });

  it("separates generic MCP, native OAuth, and upstream-owned OAuth onboarding", () => {
    expect(readme).toContain("## Add another MCP");
    expect(readme).toContain("--preset generic-npx");
    expect(readme).toContain("--npm-package");
    expect(readme).toContain("### Reviewed local executable template");
    expect(readme).toContain("--preset local-stdio");
    expect(readme).toContain("--local-command node");
    expect(readme).toContain("--arg=--stdio");
    expect(readme).toContain("--accept-local-command");
    expect(readme).toContain("Miftah does not run the local executable during setup");
    expect(readme).toContain("On Windows, provide an absolute `.exe` or `.com` binary");
    expect(readme).toContain("## OAuth and the local dashboard");
    expect(readme).toContain("Native remote OAuth");
    expect(readme).toContain("Upstream-owned OAuth");
    expect(readme).toContain("miftah setup --native-oauth");
    expect(readme).toContain("Miftah discovers the issuer, supported OAuth metadata, and dynamic client-registration capability from the endpoint itself.");
    expect(readme).toContain("No browser authorization, client registration, or credential is created during setup.");
    expect(readme).toContain("### Add another native OAuth account");
    expect(readme).toContain("Miftah preserves each existing account and its OAuth binding.");
    expect(readme).toContain("--make-default");
    expect(readme).toContain("Add another native OAuth account");
    expect(readme).toContain("### Advanced manual OAuth registration");
    expect(readme).toContain("miftah connection add --config");
    expect(readme).toContain("miftah auth connect --config");
    expect(readme).toContain("--preset google-search-console");
    expect(readme).toContain("miftah setup gsc --preset google-search-console");
    expect(readme).toContain("miftah setup gsc --preset google-search-console --verify");
    expect(readme).toContain("### Add another Google Search Console account");
    expect(readme).toContain("miftah setup --add-profile");
    expect(readme).toContain("The new account receives its own `GSC_CONFIG_DIR`");
    expect(readme).toContain("Add another provider account");
    expect(readme).toContain("### Add another local environment-backed account");
    expect(readme).toContain("--credential-env SENTRY_PERSONAL_ACCESS_TOKEN");
    expect(readme).toContain("Remote HTTP MCPs are refused because profile environments do not authenticate HTTP requests.");
    expect(readme).toContain("Add another environment-backed account");
    expect(readme).toContain("### Retest a reviewed provider account");
    expect(readme).toContain("miftah profile test --config ~/.config/miftah/gsc.json --profile google-personal");
    expect(readme).toContain("It does not run an arbitrary tool or expose provider output.");
    expect(readme).toContain("### Review configured accounts");
    expect(readme).toContain("miftah profile list --config ~/.config/miftah/gsc.json");
    expect(readme).toContain("It never resolves a secret reference, reads a credential file, header, OAuth vault entry, or provider token cache, and it never starts an upstream.");
    expect(readme).toContain("Configured accounts");
    expect(readme).toContain("### Change the durable default later");
    expect(readme).toContain("miftah profile set-default --config ~/.config/miftah/gsc.json --profile google-personal");
    expect(readme).toContain("does not switch an already-running MCP client");
    expect(readme).toContain("Choose the default account");
    expect(readme).toContain("### Edit an account label later");
    expect(readme).toContain("miftah profile set-description --config ~/.config/miftah/gsc.json --profile google-personal --description \"Personal Google account\"");
    expect(readme).toContain("miftah profile set-description --config ~/.config/miftah/gsc.json --profile google-personal --clear-description");
    expect(readme).toContain("does not change credentials, OAuth bindings, routing, provider token caches, or the durable default");
    expect(readme).toContain("Edit a non-secret account label");
    expect(readme).toContain("### Remove an account later");
    expect(readme).toContain("miftah profile remove --config ~/.config/miftah/gsc.json --profile google-personal --replacement-profile google-work");
    expect(readme).toContain("does not resolve or delete an underlying secret");
    expect(readme).toContain("Remove an account safely");
    expect(readme).toContain("native OAuth binding");
    expect(readme).toContain("Miftah does not invent a probe or show the provider output");
    expect(readme).toContain("A non-ready readiness result leaves the configuration in place and exits 1.");
    expect(readme).toContain("If the final readiness prompt is cancelled after the write, the configuration remains available and setup exits 1.");
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

  it("documents the explicit no-secret local and remote client-entry import paths", () => {
    expect(readme).toContain("## Reuse one existing MCP client entry");
    expect(readme).toContain("What do you already have? (connector, remote HTTPS, local executable, browser sign-in, import) [connector]");
    expect(readme).toContain("lists only entry names");
    expect(readme).toContain("never prints the source entry's command, arguments, headers, environment values, or credentials");
    expect(readme).toContain("--import-file");
    expect(readme).toContain("--import-entry");
    expect(readme).toContain("does not scan or modify the source client file");
    expect(readme).toContain("does not infer OAuth ownership");
    expect(readme).toContain("credential-free HTTPS remote entry");
    expect(readme).toContain("does not discover OAuth or call the remote endpoint");
    expect(readme).toContain("`--verify` is rejected because an imported entry has no reviewed provider adapter");
    expect(readme).toContain("static launch grammar");
    expect(readme).toContain("exact version");
    expect(readme).toContain("On Windows, the import path accepts only a direct absolute `.exe` or `.com` executable");
    expect(readme).toContain("advanced manual setup");
    expect(readme).toContain("Miftah does not retain rejected arguments, headers, environment values, or credentials.");
    expect(cliDocs).toContain("If guided import refuses a selected entry, Miftah keeps no rejected source values");
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
      const command = (primary === "connection" || primary === "auth" || primary === "profile"
        ? `${primary} ${match![2]}`
        : primary) as CliCommand;
      expect(Object.keys(CLI_COMMANDS), `unknown README command: ${command}`).toContain(command);
      const help = renderCommandHelp(command);
      const supportedFlags = new Set(help.match(/--[a-z][a-z-]*/gu) ?? []);
      for (const flag of [...line.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/gu)].map((flagMatch) => flagMatch[1]!)) {
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

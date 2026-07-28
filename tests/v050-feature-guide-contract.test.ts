import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, renderCommandHelp, type CliCommand } from "../src/cli/parse.js";

const guideUrl = new URL("../docs/whats-new-in-0.5.md", import.meta.url);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

function readGuide(): string {
  return existsSync(guideUrl) ? readFileSync(guideUrl, "utf8") : "";
}

function documentedMiftahCommands(markdown: string): string[] {
  const bashBlocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]!);
  const fencedCommands = bashBlocks.flatMap((block) =>
    block
      .replace(/\\\n\s*/gu, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("miftah "))
  );
  const inlineCommands = [...markdown.matchAll(/`(miftah [^`\n]+)`/gu)].map((match) => match[1]!);
  return [...new Set([...fencedCommands, ...inlineCommands])];
}

describe("Miftah 0.5 owner guide", () => {
  it("publishes a linked, release-aligned explanation of the product delta", () => {
    const guide = readGuide();

    expect(guide).not.toBe("");
    expect(guide.split("\n").length).toBeLessThanOrEqual(220);
    expect(guide).toContain("# What is in Miftah 0.5");
    expect(guide).toContain(`Install \`@lubab/miftah@${packageManifest.version}\``);
    expect(guide).toContain("0.5.0 compared with 0.4.0");
    expect(guide).toContain("guided and resumable setup");
    expect(guide).toContain("Native OAuth and the optional Console first shipped in 0.4.0");
    expect(guide).toContain("0.5.0 makes them easier to discover, configure, and maintain");
    expect(readme.split("\n").slice(0, 80).join("\n")).toContain(
      "[What is in 0.5 and how to use it](docs/whats-new-in-0.5.md)"
    );
  });

  it("maps the main 0.5 outcomes to exact safe starting commands", () => {
    const guide = readGuide();

    for (const text of [
      "miftah setup",
      "miftah setup gsc --preset google-search-console",
      "--plan",
      "--resume",
      "--discard-draft",
      "--import-file",
      "--import-entry",
      "miftah dashboard",
      "miftah setup --add-profile",
      "miftah profile list",
      "miftah profile set-default",
      "miftah profile set-description",
      "miftah profile rename",
      "miftah profile remove",
      "miftah profile test"
    ]) {
      expect(guide).toContain(text);
    }

    expect(guide).toContain("The plan does not write a configuration or start an upstream.");
    expect(guide).toContain("Miftah never reads or copies the upstream-owned token cache.");
  });

  it("keeps the authentication, active-session, and validation boundaries honest", () => {
    const guide = readGuide();

    expect(guide).toContain("Miftah does not support OAuth for every MCP server or provider.");
    expect(guide).toContain("Native OAuth");
    expect(guide).toContain("upstream-owned OAuth");
    expect(guide).toContain("API key or secret reference");
    expect(guide).toContain("restart the MCP client");
    expect(guide).toContain("External multi-account and returning-user validation is still open");
    expect(guide).toContain("[#25]");
    expect(guide).toContain("[#88]");
    expect(guide).toContain("[CLI reference](cli.md)");
    expect(guide).toContain("[OAuth guide](oauth-support.md)");
    expect(guide).toContain("[provider-adapter guide](provider-adapters.md)");
    expect(guide).toContain("[full changelog](../CHANGELOG.md)");
  });

  it("binds every documented Miftah command and flag to generated CLI help", () => {
    const commands = documentedMiftahCommands(readGuide());
    expect(commands.length).toBeGreaterThan(5);

    for (const line of commands) {
      const match = /^miftah\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/u.exec(line);
      expect(match, `could not parse guide command: ${line}`).not.toBeNull();
      const primary = match![1]!;
      const command = (primary === "connection" || primary === "auth" || primary === "profile"
        ? `${primary} ${match![2]}`
        : primary) as CliCommand;
      expect(Object.keys(CLI_COMMANDS), `unknown guide command: ${command}`).toContain(command);
      const supportedFlags = new Set(renderCommandHelp(command).match(/--[a-z][a-z-]*/gu) ?? []);
      for (const flag of [...line.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/gu)].map((flagMatch) => flagMatch[1]!)) {
        expect(supportedFlags, `unsupported guide flag for ${command}: ${flag}`).toContain(flag);
      }
    }
  });

  it("keeps fenced commands paste-safe and records the guide under issue 40", () => {
    const guide = readGuide();
    const bashBlocks = [...guide.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]!);

    for (const block of bashBlocks) {
      expect(block).not.toMatch(/[<>]/u);
    }
    expect(guide).not.toContain("oauthconn:<uuid>");
    expect(changelog).toContain("[#40](https://github.com/mohanagy/miftah/issues/40)");
    expect(changelog).toContain("Added an owner-readable Miftah 0.5 feature and usage guide");
  });

  it("keeps every local guide link resolvable", () => {
    const links = [...readGuide().matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]!);

    for (const link of links) {
      if (/^(?:https?:|mailto:)/u.test(link)) continue;
      const path = link.split("#", 1)[0]!;
      const target = new URL(path, guideUrl);
      expect(existsSync(target), `missing guide link target: ${link}`).toBe(true);
    }
  });
});

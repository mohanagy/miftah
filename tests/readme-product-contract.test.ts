import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const duplicates = new Map<string, number>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
    const base = match[1]!
      .toLowerCase()
      .replace(/[`*_~]/gu, "")
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-");
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
    expect(readme).toContain("## First setup: GitHub with Claude Desktop");
    expect(readme).toContain("Developer → Edit Config");
    expect(readme).toContain("restart Claude Desktop");
    expect(readme).toContain("miftah test-profile --config");
    expect(readme).toContain("miftah list-tools --config");
    expect(readme).toContain("`miftah_list_profiles`");
    expect(readme).toContain("`miftah_current_profile`");
    expect(readme).toContain("`miftah_use_profile`");
    expect(readme).toContain("`miftah_reset_profile`");
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
  });

  it("keeps every local README link and heading anchor resolvable", () => {
    const links = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]!);
    for (const link of links) {
      if (/^(?:https?:|mailto:)/u.test(link)) continue;
      const [path, fragment] = link.split("#", 2);
      const target = new URL(path === "" ? "../README.md" : `../${path}`, import.meta.url);
      expect(existsSync(target), `missing README link target: ${link}`).toBe(true);
      if (fragment !== undefined && fragment.length > 0) {
        const targetMarkdown = readFileSync(target, "utf8");
        expect(headingSlugs(targetMarkdown), `missing README anchor: ${link}`).toContain(fragment);
      }
    }
  });

  it("routes readers to a configuration guide that identifies v3 as the current format", () => {
    const config = readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");
    expect(config).toContain('Version `"3"` is the canonical format written by current presets and examples.');
    expect(config).toContain('Miftah accepts versions `"1"`, `"2"`, and `"3"`');
    expect(config).toContain("`migrate-config` supports v1/v2 input and v3 output");
  });
});

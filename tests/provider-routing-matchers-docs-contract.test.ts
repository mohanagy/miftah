import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readDoc(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("provider routing matcher documentation", () => {
  it("documents the opt-in fixed registry, precedence, safe evidence, and extension boundary", () => {
    const readme = readDoc("../README.md");
    const config = readDoc("../docs/config.md");
    const architecture = readDoc("../docs/architecture.md");
    const security = readDoc("../docs/security.md");
    const changelog = readDoc("../CHANGELOG.md");

    expect(config).toContain("`profiles.<profile>.routing.match`");
    expect(config).toContain('"github"');
    expect(config).toContain('"repositories"');
    expect(config).toContain(
      "environment hint, project-marker hint, configured rule, the matcher band (fixed static matchers plus allowlisted plugin matchers), then fallback"
    );
    expect(config).toContain("allowlisted `url` and `uri` fields");
    expect(config).toContain("`routing.plugins` remains unsupported");
    expect(config).toContain("root [`plugins.allowlist`](plugins.md) API");
    expect(architecture).toContain("`matcher:<provider>`");
    expect(architecture).toContain("fixed in-tree registry");
    expect(security).toContain("`routingMatcherEvidence`");
    expect(security).toContain("raw `MIFTAH_PROJECT`");
    expect(security).toContain("raw provider URL");
    expect(readme).toContain("provider routing matchers");
    expect(readme).not.toContain("Routing plugins, profile metadata and matchers");
    expect(changelog).toContain("[#30]");
    expect(changelog).toContain("[#34]");
  });
});

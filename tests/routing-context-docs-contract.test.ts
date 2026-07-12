import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function unreleasedSection(changelog: string): string {
  const afterHeading = changelog.split(/^## \[Unreleased\]\s*$/mu)[1];
  if (afterHeading === undefined) throw new Error("CHANGELOG.md must contain an Unreleased section.");
  const nextRelease = afterHeading.search(/^## \[/mu);
  return nextRelease === -1 ? afterHeading : afterHeading.slice(0, nextRelease);
}

describe("routing context documentation contract", () => {
  it("documents metadata-only selection, roots, evidence, and its security boundary", () => {
    const readme = readRepositoryFile("README.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const changelog = readRepositoryFile("CHANGELOG.md");

    expect(readme).toContain("[routing context](docs/config.md#routing-context)");
    expect(config).toContain("## Routing context");
    expect(config).toContain("`MIFTAH_PROFILE`");
    expect(config).toContain("`MIFTAH_PROJECT`");
    expect(config).toContain("environment hint, project-marker hint, configured rule, then fallback");
    expect(config).toContain("`notifications/roots/list_changed`");
    expect(config).toContain("does not poll roots");
    expect(config).toContain("`miftah_route_preview`");
    expect(config).toContain("`routingEvidence`");
    expect(architecture).toContain("metadata-only routing context collector");
    expect(architecture).toContain("one immutable snapshot");
    expect(security).toContain("Project markers cannot");
    expect(security).toContain("never contains the raw `MIFTAH_PROJECT` value");
    expect(unreleasedSection(changelog)).toMatch(/\[#20\][\s\S]*routing context[\s\S]*audit/iu);
  });
});

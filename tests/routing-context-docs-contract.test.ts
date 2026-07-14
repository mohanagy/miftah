import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Returns pending changes, or the latest release notes once a release empties Unreleased. */
function documentedChangesSection(changelog: string): string {
  const afterHeading = changelog.split(/^## \[Unreleased\]\s*$/mu)[1];
  if (afterHeading === undefined) throw new Error("CHANGELOG.md must contain an Unreleased section.");
  const nextRelease = afterHeading.search(/^## \[/mu);
  const unreleased = nextRelease === -1 ? afterHeading : afterHeading.slice(0, nextRelease);
  if (unreleased.trim() !== "" || nextRelease === -1) return unreleased;

  const currentRelease = afterHeading.slice(nextRelease);
  const end = currentRelease.indexOf("\n## ", 1);
  return end === -1 ? currentRelease : currentRelease.slice(0, end);
}

function routingContextSection(config: string): string {
  const afterHeading = config.split(/^## Routing context\s*$/mu)[1];
  if (afterHeading === undefined) throw new Error("docs/config.md must contain a Routing context section.");
  const nextSection = afterHeading.search(/^## /mu);
  return nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
}

describe("routing context documentation contract", () => {
  it("documents metadata-only selection, roots, evidence, and its security boundary", () => {
    const readme = readRepositoryFile("README.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const changelog = readRepositoryFile("CHANGELOG.md");
    const routingContext = routingContextSection(config);

    expect(readme).toContain("[routing context](docs/config.md#routing-context)");
    expect(config).toContain("## Routing context");
    expect(routingContext).toContain("only runtime configuration authority");
    expect(routingContext).toContain('"profiles": {');
    expect(routingContext).toContain("only top-level key");
    expect(routingContext).toContain("all values are strings");
    expect(routingContext).toContain("does not merge with runtime configuration");
    expect(routingContext).toContain("`MIFTAH_PROFILE`");
    expect(routingContext).toContain("`MIFTAH_PROJECT`");
    expect(routingContext).toContain(
      "environment hint, project-marker hint, configured rule, the matcher band (fixed static matchers plus allowlisted plugin matchers), then fallback"
    );
    expect(routingContext).toContain("The nearest valid project marker wins");
    expect(routingContext).toContain("`notifications/roots/list_changed`");
    expect(routingContext).toContain("does not poll roots");
    expect(routingContext).toContain("`miftah_route_preview`");
    expect(routingContext).toContain("`routingEvidence`");
    expect(architecture).toContain("metadata-only routing context collector");
    expect(architecture).toContain("one immutable snapshot");
    expect(security).toContain("Project markers cannot");
    expect(security).toContain("cannot add credentials");
    expect(security).toContain("never contains the raw `MIFTAH_PROJECT` value");
    expect(documentedChangesSection(changelog)).toMatch(/\[#20\][\s\S]*routing context[\s\S]*audit/iu);
  });
});

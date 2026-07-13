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

describe("profile lease and lock documentation contract", () => {
  it("documents the connection, routing, and operator-control boundaries", () => {
    const readme = readRepositoryFile("README.md");
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const cli = readRepositoryFile("docs/cli.md");
    const changelog = readRepositoryFile("CHANGELOG.md");

    expect(readme).toContain("miftah_lock_profile");
    expect(readme).toContain("miftah_unlock_profile");
    for (const setting of [
      "security.requireProfileSwitchConfirmation",
      "security.allowProfileLockingFromMcp",
      "security.requireExplicitSelectionForDestructive",
      "requiredForRisk",
      "ttlMs"
    ]) {
      expect(config).toContain(setting);
    }
    expect(config).toContain("connection-bound");
    expect(config).toContain("cannot borrow a lease");
    expect(security).toContain("does not authenticate a human");
    expect(security).toContain("operator-controlled");
    expect(architecture).toContain("captured lease");
    expect(cli).toContain("miftah_lock_profile");
    expect(cli).toContain("miftah_unlock_profile");
    expect(unreleasedSection(changelog)).toMatch(/\[#28\][\s\S]*profile/iu);
  });
});

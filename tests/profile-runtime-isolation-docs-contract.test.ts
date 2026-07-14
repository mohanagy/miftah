import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

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

describe("profile credential isolation documentation contract", () => {
  it("states the file-copy, lifecycle, and container configuration contract", () => {
    const readme = readRepositoryFile("README.md");
    const config = readRepositoryFile("docs/config.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const changelog = readRepositoryFile("CHANGELOG.md");

    expect(readme).toContain("[profile credential isolation](docs/config.md#profile-credential-isolation)");
    for (const text of [
      "profiles.<profile>.isolation",
      "containerVolumes",
      "readOnly",
      "Docker/Podman",
      "Miftah never removes",
      "automatic migration",
      "Windows",
      "[REDACTED]",
      "DOCKER_HOST",
      "DOCKER_CONFIG",
      "CONTAINER_HOST",
      "PODMAN_CONNECTIONS_CONF"
    ]) {
      expect(config).toContain(text);
    }
    expect(architecture).toContain("ProfileRuntimeIsolation");
    expect(architecture).toContain("--mount");
    expect(architecture).toContain("macOS Podman isolation fail closed");
    expect(documentedChangesSection(changelog)).toMatch(/\[#29\][\s\S]*credential/iu);
  });

  it("states the native same-user and container boundaries without overclaiming containment", () => {
    const security = readRepositoryFile("docs/security.md");

    expect(security).toContain("same OS user");
    expect(security).toContain("never resolves, materializes, injects, or bind-mounts another profile");
    expect(security).toContain("Windows profile credential isolation fails closed");
    expect(security).toContain("no other host directories");
    expect(security).toContain("atomic path-to-daemon handoff");
  });
});

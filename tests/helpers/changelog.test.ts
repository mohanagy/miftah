import { describe, expect, it } from "vitest";
import { documentedChangesSection } from "./changelog.js";

describe("documentedChangesSection", () => {
  it("returns pending changes when Unreleased has content", () => {
    const changelog = `# Changelog

## [Unreleased]

### Fixed

- Pending release note.

## [0.2.1] - 2026-07-17

- Previous release note.
`;

    const changes = documentedChangesSection(changelog);

    expect(changes).toContain("Pending release note.");
    expect(changes).not.toContain("Previous release note.");
  });

  it("returns all release notes but excludes following non-release sections when Unreleased is empty", () => {
    const changelog = `# Changelog

## [Unreleased]

## [0.2.1] - 2026-07-17

- Current release note.

## [0.2.0] - 2026-07-14

- Historical release note.

## Release policy

This is not a release note.
`;

    const changes = documentedChangesSection(changelog);

    expect(changes).toContain("Current release note.");
    expect(changes).toContain("Historical release note.");
    expect(changes).not.toContain("This is not a release note.");
  });

  it("rejects a changelog without an Unreleased section", () => {
    expect(() => documentedChangesSection("## [0.2.1] - 2026-07-17")).toThrow(
      "CHANGELOG.md must contain an Unreleased section."
    );
  });
});

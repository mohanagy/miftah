import { describe, expect, it } from "vitest";
import { changelogIssueEntry } from "./helpers/changelog.js";

describe("changelog issue-entry helper", () => {
  it("bounds a contract assertion to one issue entry", () => {
    const changelog = [
      "## [Unreleased]",
      "",
      "### Changed",
      "- [#19](https://example.test/issues/19) Catalog guidance.",
      "- [#20](https://example.test/issues/20) Routing-context onboarding."
    ].join("\n");

    const issue19 = changelogIssueEntry(changelog, 19);
    expect(issue19).toContain("Catalog guidance.");
    expect(issue19).not.toContain("Routing-context onboarding.");
  });
});

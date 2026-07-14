import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function document(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("release policy contract", () => {
  it("gives every agent an unambiguous main-only publishing protocol", async () => {
    const instructions = await document("AGENTS.md");

    for (const rule of [
      "## Release protocol",
      "All implementation and maintenance pull requests target `development`.",
      "A release promotion pull request is the only exception and must be `development` → `main`.",
      "Never publish from a feature branch or from `development`.",
      "Do not run a workstation `npm publish`.",
      "npm trusted publishing still performs `npm publish`",
      "deprecate every superseded unsafe published version"
    ]) {
      expect(instructions).toContain(rule);
    }
  });

  it("requires the protected, provenance-backed release workflow and post-publish verification", async () => {
    const [contributing, workflow] = await Promise.all([
      document("CONTRIBUTING.md"),
      document(".github/workflows/publish.yml")
    ]);

    expect(contributing).toContain("Never run `npm publish` from a workstation or a feature branch.");
    expect(contributing).toContain("Verify the registry version and provenance after publication");
    expect(contributing).toContain("deprecate every superseded unsafe published version");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(workflow).toContain("npm publish --access public --provenance");
  });
});

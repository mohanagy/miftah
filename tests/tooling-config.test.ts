import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("repository tooling contracts", () => {
  it("keeps JSON data files outside source lint processing", () => {
    const eslintConfig = readRepositoryFile("eslint.config.js");

    expect(eslintConfig).toMatch(/ignores:\s*\[[^\]]*"\*\*\/\*\.json"/u);
  });

  it("starts the pull request template with a level-one heading", () => {
    const template = readRepositoryFile(".github/pull_request_template.md");

    expect(template).toMatch(/^# [^#\n]+/u);
  });

  it("documents every nontrivial pack verifier function", () => {
    const verifier = readRepositoryFile("scripts/check-pack.mjs");

    for (const name of ["formatPaths", "isAllowedPath", "verifyPackPaths", "parsePackOutput", "checkPack"]) {
      const functionIndex = verifier.search(new RegExp(`(?:export )?function ${name}\\(`, "u"));
      expect(functionIndex, `${name} should exist`).toBeGreaterThan(-1);
      expect(verifier.slice(0, functionIndex), `${name} should have an adjacent JSDoc comment`).toMatch(
        /\/\*\*[\s\S]*?\*\/\n$/u
      );
    }
  });
});

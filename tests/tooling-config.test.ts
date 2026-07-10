import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jsdocAdjacencyPattern = /\/\*\*[\s\S]*?\*\/\n$/u;
const jsonIgnorePattern = /ignores:\s*\[[^\]]*"\*\*\/\*\.json"/u;
const pullRequestTitlePattern = /^# [^#\n]+/u;

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("repository tooling contracts", () => {
  it("keeps JSON data files outside source lint processing", () => {
    const eslintConfig = readRepositoryFile("eslint.config.js");

    expect(eslintConfig).toMatch(jsonIgnorePattern);
  });

  it("starts the pull request template with a level-one heading", () => {
    const template = readRepositoryFile(".github/pull_request_template.md");

    expect(template).toMatch(pullRequestTitlePattern);
  });

  it("documents every nontrivial pack verifier function", () => {
    const verifier = readRepositoryFile("scripts/check-pack.mjs");

    for (const name of ["formatPaths", "isAllowedPath", "verifyPackPaths", "parsePackOutput", "checkPack"]) {
      const exportedFunctionIndex = verifier.indexOf(`export function ${name}(`);
      const functionIndex =
        exportedFunctionIndex >= 0 ? exportedFunctionIndex : verifier.indexOf(`function ${name}(`);
      expect(functionIndex, `${name} should exist`).toBeGreaterThan(-1);
      expect(verifier.slice(0, functionIndex), `${name} should have an adjacent JSDoc comment`).toMatch(
        jsdocAdjacencyPattern
      );
    }
  });
});

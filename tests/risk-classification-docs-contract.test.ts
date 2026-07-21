import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const changelogRiskClassificationPattern = /\[#26\][\s\S]*risk classification/iu;

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("risk classification documentation contract", () => {
  it("documents the explicit trust boundary, conservative fallback, and safe provenance output", () => {
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const libraryApi = readRepositoryFile("docs/library-api.md");
    const changelog = readRepositoryFile("CHANGELOG.md");

    for (const claim of [
      "trustToolAnnotations: true",
      "tooling.unknownToolRisk",
      "riskSource",
      "riskConfidence",
      "trusted-command-adapter",
      "https://mcp.posthog.com/mcp",
      "enforcement",
      "`idempotentHint`",
      "`openWorldHint`",
      "defaults to `\"destructive\"`",
      "never starts an upstream"
    ]) {
      expect(config).toContain(claim);
    }
    expect(security).toContain("behavioral hints");
    expect(security).toContain("profile override cannot change");
    expect(security).toContain("Invalid or unrecognized command forms remain destructive");
    expect(architecture).toContain("normalizes only the four MCP behavioral booleans");
    expect(architecture).toContain("shares the local policy-enforcement evaluator");
    expect(libraryApi).toContain("UnknownToolRisk");
    expect(changelog).toMatch(changelogRiskClassificationPattern);
  });

  it("keeps the documented classification precedence aligned with the runtime", () => {
    const config = readRepositoryFile("docs/config.md");
    const precedence = [
      "1. an exact local `tooling.toolRiskOverrides` entry;",
      "2. Miftah's fixed PostHog command adapter",
      "3. MCP tool annotations only when",
      "4. conservative name heuristics; then",
      "5. `tooling.unknownToolRisk`"
    ];

    let previousIndex = -1;
    for (const step of precedence) {
      const currentIndex = config.indexOf(step);
      expect(currentIndex, `missing or out-of-order documentation step: ${step}`).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  });
});

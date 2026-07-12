import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
      "`idempotentHint`",
      "`openWorldHint`",
      "defaults to `\"destructive\"`",
      "never starts an upstream"
    ]) {
      expect(config).toContain(claim);
    }
    expect(security).toContain("behavioral hints");
    expect(security).toContain("profile override cannot change");
    expect(architecture).toContain("normalizes only the four MCP behavioral booleans");
    expect(libraryApi).toContain("UnknownToolRisk");
    expect(changelog).toMatch(/\[#26\][\s\S]*risk classification/iu);
  });
});

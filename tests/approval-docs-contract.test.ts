import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("approval documentation contract", () => {
  it("documents capability-bound fallback, native elicitation, and safe audit boundaries", () => {
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const architecture = readRepositoryFile("docs/architecture.md");

    expect(config).toContain("MCP approvals");
    expect(config).toContain("miftah_list_approvals");
    expect(config).toContain("miftah_approve");
    expect(config).toContain("miftah_deny");
    expect(config).toContain("form elicitation");
    expect(security).toContain("approval bearer");
    expect(architecture).toContain("approval lifecycle");
    expect(architecture).toContain("raw approval bearer or operation arguments");
  });
});

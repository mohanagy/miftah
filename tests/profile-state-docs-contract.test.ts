import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogIssueEntry } from "./helpers/changelog.js";

const activeProfileStateHeading = /^### Active profile state\s*$/mu;
const sectionHeading = /^## |^### /mu;

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function section(content: string, heading: RegExp): string {
  const afterHeading = content.split(heading)[1];
  if (afterHeading === undefined) throw new Error("Expected documentation section is missing.");
  const nextSection = afterHeading.search(sectionHeading);
  return nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
}

describe("active profile state documentation contract", () => {
  it("keeps scope, persistence, fallback, and safe-output claims aligned with the implementation", () => {
    const types = readRepositoryFile("src/config/types.ts");
    const schema = readRepositoryFile("src/config/schema.ts");
    const state = readRepositoryFile("src/profiles/profile-state.ts");
    const manager = readRepositoryFile("src/profiles/profile-manager.ts");
    const server = readRepositoryFile("src/mcp/server/miftah-server.ts");
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const cli = readRepositoryFile("docs/cli.md");
    const changelog = readRepositoryFile("CHANGELOG.md");
    const activeProfileState = section(config, activeProfileStateHeading);

    expect(types).toContain('export type ActiveProfileStateScope = "process" | "session" | "workspace" | "global";');
    expect(types).toContain("export type StateConfig =");
    expect(schema).toContain('"custom profile-state paths are not supported; choose workspace or global scope"');
    expect(manager).toContain("async beginSession(): Promise<void>");
    expect(manager).toContain('selectionSource: this.scope === "workspace" ? "persisted-workspace" : "persisted-global"');
    expect(state).toContain('await open(temporaryPath, "wx", 0o600)');
    expect(state).toContain("await handle.sync();");
    expect(state).toContain("await rename(temporaryPath, path);");
    expect(server).toContain("selectionSource: current.selectionSource");
    expect(server).toContain("stateDiagnostic: current.stateDiagnostic");

    for (const claim of [
      "persistActiveProfile",
      "`process`",
      "`session`",
      "`workspace`",
      "`global`",
      "Custom `state.path` values are rejected",
      "config-identity",
      "security.lockToProfile",
      "PROFILE_STATE_INVALID",
      "PROFILE_STATE_STALE",
      "PROFILE_STATE_UNAVAILABLE",
      "atomically rename"
    ]) {
      expect(activeProfileState).toContain(claim);
    }
    expect(security).toContain("other MCP request data");
    expect(cli).toContain("`selectionSource`, `selectedAt`, and `scope`");
    expect(changelogIssueEntry(changelog, 23)).toMatch(/active-profile persistence/iu);
  });
});

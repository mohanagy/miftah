import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("OAuth and Console validation contract", () => {
  it("keeps the deterministic OAuth and Console suite in every supported OS and Node job", async () => {
    const [packageJson, workflow] = await Promise.all([
      repositoryFile("package.json"),
      repositoryFile(".github/workflows/ci.yml")
    ]);
    const packageManifest = JSON.parse(packageJson) as {
      scripts?: Record<string, string>;
    };

    expect(packageManifest.scripts?.["test:oauth-console"]).toBe(
      "vitest run tests/oauth tests/remote-oauth tests/console tests/identity " +
        "tests/provider-adapter-contract.test.ts tests/preset-catalog.test.ts " +
        "tests/init-command.test.ts tests/cli-exit-codes.test.ts tests/cli-parse.test.ts " +
        "tests/config-migration.test.ts tests/audit-integrity.test.ts"
    );
    expect(workflow).toContain("Test OAuth and Console compatibility");
    expect(workflow).toContain("run: npm run test:oauth-console");
    expect(workflow).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(workflow).toContain('node: ["20", "22", "24"]');
  });

  it("publishes truthful automated, recovery, and external-user release evidence", async () => {
    const [oauthSupport, validation] = await Promise.all([
      repositoryFile("docs/oauth-support.md"),
      repositoryFile("docs/oauth-console-validation.md")
    ]);

    expect(oauthSupport).toContain("[OAuth and Console validation](oauth-console-validation.md)");

    for (const requiredEvidence of [
      "# OAuth and Console validation",
      "Ubuntu, macOS, and Windows",
      "Node.js 20, 22, and 24",
      "deterministic local fixtures",
      "does not contact live OAuth providers",
      "does not write test credentials into the operator's real OS vault",
      "Refresh and reauthorization",
      "Disconnect and cleanup",
      "Cancellation and callback timeout",
      "Configuration backup and recovery",
      "pre-v1 feature release",
      "Interested external users: 5",
      "Recorded completed external workflows: 0",
      "Recorded returning external users: 0",
      "The external design-partner gate remains open"
    ]) {
      expect(validation).toContain(requiredEvidence);
    }
  });
});

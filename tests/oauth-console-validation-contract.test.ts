import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function workflowJob(workflow: string, jobName: string): string | undefined {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) return undefined;
  const nextJob = lines.findIndex((line, index) => index > start && /^ {2}[a-z0-9_-]+:$/u.test(line));
  return lines.slice(start, nextJob === -1 ? undefined : nextJob).join("\n");
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
    const compatibilityJob = workflowJob(workflow, "compatibility");

    expect(packageManifest.scripts?.["test:oauth-console"]).toBe(
      "vitest run tests/oauth tests/remote-oauth tests/console tests/identity " +
        "tests/provider-adapter-contract.test.ts tests/preset-catalog.test.ts " +
        "tests/init-command.test.ts tests/cli-exit-codes.test.ts tests/cli-parse.test.ts " +
        "tests/config-migration.test.ts tests/audit-integrity.test.ts"
    );
    expect(compatibilityJob).toBeDefined();
    expect(compatibilityJob).toContain("Test OAuth and Console compatibility");
    expect(compatibilityJob).toContain("run: npm run test:oauth-console");
    expect(compatibilityJob).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(compatibilityJob).toContain('node: ["20", "22", "24"]');
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

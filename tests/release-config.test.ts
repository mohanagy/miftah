import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const checkoutPin = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const npmVersionComparisonPattern = /const npmIsCurrentEnough =\s*([\s\S]*?);\n\n\s+if \(Number/u;
const reflectiveArrayMethodPattern = /\.(?:every|some|findIndex)\(/u;
const setupNodePin = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function readPackageScripts(): Record<string, string> {
  const packageJson = JSON.parse(readRepositoryFile("package.json")) as { scripts?: Record<string, string> };
  if (!packageJson.scripts) throw new Error("package.json does not define scripts.");
  return packageJson.scripts;
}

function actionReferences(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*uses:\s*(\S+)\s*$/gmu)].map((match) => match[1]!);
}

function npmVersionComparison(workflow: string): string {
  const match = workflow.match(npmVersionComparisonPattern);
  if (!match?.[1]) {
    throw new Error("Unable to find the npm version comparison.");
  }
  return match[1];
}

describe("continuous integration workflow contract", () => {
  it("uses least privilege, immutable official actions, and safe concurrency", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(workflow).toMatch(/pull_request:\s*\n\s+branches: \[development, main\]/u);
    expect(workflow).toMatch(/push:\s*\n\s+branches: \[development, main\]/u);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}");
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect([...new Set(actionReferences(workflow))]).toEqual([checkoutPin, setupNodePin]);
    expect(actionReferences(workflow).every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
  });

  it("runs the Linux quality sequence including coverage, CLI, and package smoke checks", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    for (const command of [
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run test:coverage",
      "npm run build",
      "npm run smoke:cli",
      "npm run check:pack"
    ]) {
      expect(workflow).toContain(`run: ${command}`);
    }
  });

  it("runs core and CLI compatibility checks across supported Node versions and operating systems", () => {
    const workflow = readRepositoryFile(".github/workflows/ci.yml");

    expect(workflow).toContain("linux-quality:");
    expect(workflow).toContain("compatibility:");
    expect(workflow).toMatch(/os:\s*\[ubuntu-latest,\s*macos-latest,\s*windows-latest\]/u);
    expect(workflow).toMatch(/node:\s*\["20",\s*"22",\s*"24"\]/u);
    expect(workflow).toContain("run: npm run test:core");
    expect(workflow).toContain("run: npm run test:cli");
    expect(workflow).toMatch(/verify:\s*\n\s+name: Verify[\s\S]*?needs: \[linux-quality, compatibility\]/u);
  });

  it("defines portable core, package, CLI, and coverage verification scripts", () => {
    const scripts = readPackageScripts();

    expect(scripts["test:core"]).toContain("vitest run");
    expect(scripts["test:core"]).toContain("tests/executable-resolver.test.ts");
    expect(scripts["test:core"]).toContain("tests/secret-provider-availability.test.ts");
    expect(scripts["test:core"]).toContain("tests/secret-providers.test.ts");
    expect(scripts["test:core"]).toContain("tests/config-migration.test.ts");
    expect(scripts["test:core"]).toContain("tests/windows-config-acl.test.ts");
    expect(scripts["test:core"]).toContain("tests/windows-config-migration-acl-failure.test.ts");
    expect(scripts["test:core"]).toContain("tests/windows-config-migration-acl.test.ts");
    expect(scripts["test:package"]).toBe("vitest run tests/package-contract.test.ts");
    expect(scripts["smoke:cli"]).toBe("node dist/cli/main.js schema");
    expect(scripts["test:cli"]).toContain("npm run test:package");
    expect(scripts["test:cli"]).toContain("npm run smoke:cli");
    expect(scripts["test:coverage"]).toContain("vitest run --coverage");
  });

  it("runs packed-artifact npm commands without Windows shell parsing", () => {
    const packageContract = readRepositoryFile("tests/package-contract.test.ts");
    const packVerifier = readRepositoryFile("scripts/check-pack.mjs");
    const npmHelper = packageContract.slice(
      packageContract.indexOf("function npmInvocation"),
      packageContract.indexOf("function quoteForWindowsCommand")
    );

    for (const source of [packageContract, packVerifier]) {
      expect(source).toContain("process.env.npm_execpath");
    }
    for (const source of [npmHelper, packVerifier]) {
      expect(source).toContain("command: process.execPath");
      expect(source).toContain("shell: false");
      expect(source).not.toContain("shell: true");
    }
  });

  it("collects V8 coverage for the critical runtime boundaries", () => {
    const config = readRepositoryFile("vitest.config.ts");

    expect(config).toContain('provider: "v8"');
    expect(config).toContain("thresholds:");
    for (const module of [
      "src/config/**/*.ts",
      "src/secrets/**/*.ts",
      "src/mcp/server/operation-pipeline.ts",
      "src/mcp/server/tool-registry.ts",
      "src/mcp/server/resource-prompt-registry.ts",
      "src/upstream/upstream-process-manager.ts",
      "src/upstream/remote-error.ts"
    ]) {
      expect(config).toContain(module);
    }
    expect(config).toContain(
      'exclude: process.platform === "win32" ? [] : ["src/secrets/windows-secret-command.ts"]'
    );
  });
});

describe("trusted publishing workflow contract", () => {
  it("runs only for published releases with minimal OIDC permissions and the npm environment", () => {
    const workflow = readRepositoryFile(".github/workflows/publish.yml");

    expect(workflow).toMatch(/release:\s*\n\s+types: \[published\]/u);
    expect(workflow).toContain("permissions:\n  contents: read\n  id-token: write");
    expect(workflow).toMatch(/^\s*environment: npm$/mu);
    expect(workflow).toContain("group: publish-npm");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
  });

  it("pins actions, checks out the tag, and verifies the exact main commit and version", () => {
    const workflow = readRepositoryFile(".github/workflows/publish.yml");

    expect(actionReferences(workflow)).toEqual([checkoutPin, setupNodePin]);
    expect(actionReferences(workflow).every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
    expect(workflow).toContain("ref: ${{ github.event.release.tag_name }}");
    expect(workflow).toContain('test "$RELEASE_TAG" = "v$PACKAGE_VERSION"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"');
  });

  it("checks the trusted-publishing toolchain and verifies before publishing with provenance", () => {
    const workflow = readRepositoryFile(".github/workflows/publish.yml");

    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("const minimumNode = 24;");
    expect(workflow).toContain("const minimumNpm = [11, 5, 1];");
    for (const command of [
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "node dist/cli/main.js schema",
      "npm run check:pack",
      "npm publish --access public --provenance"
    ]) {
      expect(workflow).toContain(`run: ${command}`);
    }
  });

  it.each([
    ["10.9.9", false],
    ["11.4.9", false],
    ["11.5.0", false],
    ["11.5.1", true],
    ["11.6.0", true],
    ["12.0.0", true]
  ])("compares npm %s against the minimum version as an auditable tuple", (version, expected) => {
    const workflow = readRepositoryFile(".github/workflows/publish.yml");
    const comparison = npmVersionComparison(workflow);

    expect(comparison).not.toMatch(reflectiveArrayMethodPattern);
    expect(
      runInNewContext(comparison, {
        minimumNpm: [11, 5, 1],
        npmParts: version.split(".").map(Number)
      })
    ).toBe(expected);
  });
});

describe("dependency update policy contract", () => {
  it("uses a monthly, grouped, low-noise npm update policy", () => {
    const config = readRepositoryFile(".github/dependabot.yml");

    expect(config).toContain('package-ecosystem: "npm"');
    expect(config).toContain('interval: "monthly"');
    expect(config).toContain("open-pull-requests-limit: 5");
    expect(config).toContain("dependency-type: \"production\"");
    expect(config).toContain("dependency-type: \"development\"");
    expect(config).toContain('update-types: ["minor", "patch"]');
  });
});

describe("repository security and release policy contract", () => {
  it("routes vulnerability reports away from public issues", () => {
    const issueConfig = readRepositoryFile(".github/ISSUE_TEMPLATE/config.yml");
    const securityPolicy = readRepositoryFile("SECURITY.md");

    expect(issueConfig).toContain("blank_issues_enabled: false");
    expect(issueConfig).toContain("https://github.com/mohanagy/miftah/security/advisories/new");
    expect(securityPolicy).toContain("https://github.com/mohanagy/miftah/security/advisories/new");
    expect(securityPolicy).toMatch(/do not (?:open|report).*public issue/iu);
  });

  it("documents external one-time controls without treating them as repository secrets", () => {
    const contributing = readRepositoryFile("CONTRIBUTING.md");

    expect(contributing).toContain("One-time dashboard configuration");
    expect(contributing).toContain("npm trusted publisher");
    expect(contributing).toContain("GitHub `npm` environment");
    expect(contributing).toContain("Branch protection");
    expect(contributing).toMatch(/never commit.*NPM_TOKEN/iu);
  });
});

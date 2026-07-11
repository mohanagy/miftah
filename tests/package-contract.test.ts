import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface PackageManifest {
  version?: string;
  repository?: unknown;
  homepage?: unknown;
  bugs?: unknown;
  keywords?: unknown;
  publishConfig?: unknown;
  scripts?: Record<string, string>;
}

interface PackVerifier {
  verifyPackPaths(paths: readonly string[]): readonly string[];
}

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommandTimeoutMs = 25_000;
const npmCliPath = process.env.npm_execpath;
const typescriptCliPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const publicRuntimeExports = [
  "MIFTAH_VERSION",
  "MiftahError",
  "createMiftahRuntime",
  "generateConfigSchema",
  "loadConfig",
  "presetConfig",
  "validateConfig"
];
const requiredPackPaths = [
  "LICENSE",
  "README.md",
  "dist/cli/main.js",
  "dist/index.d.ts",
  "dist/index.js",
  "docs/cli.md",
  "docs/library-api.md",
  "examples/generic.miftah.json",
  "package.json"
] as const;

function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

function npmInvocation(args: readonly string[]): { command: string; args: readonly string[] } {
  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, ...args] };
  }
  if (process.platform === "win32") {
    throw new Error("npm_execpath is required to invoke npm safely on Windows. Run the test through npm.");
  }
  return { command: "npm", args };
}

function runNpm(args: readonly string[], cwd = repositoryRoot) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    timeout: npmCommandTimeoutMs,
    killSignal: "SIGTERM"
  });
  if (result.error) {
    const timedOut = "code" in result.error && result.error.code === "ETIMEDOUT";
    const reason =
      timedOut
        ? `timed out after ${npmCommandTimeoutMs}ms`
        : `could not start: ${result.error.message}`;
    throw new Error(`npm ${args.join(" ")} ${reason}`);
  }
  return result;
}

function quoteForWindowsCommand(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function runInstalledBinary(binary: string, args: readonly string[], cwd: string) {
  if (process.platform !== "win32") {
    return spawnSync(binary, args, {
      cwd,
      encoding: "utf8",
      timeout: npmCommandTimeoutMs
    });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", [binary, ...args].map(quoteForWindowsCommand).join(" ")],
    {
      cwd,
      encoding: "utf8",
      timeout: npmCommandTimeoutMs
    }
  );
}

async function loadPackVerifier(): Promise<PackVerifier> {
  // @ts-expect-error The production verifier is intentionally plain Node ESM.
  return import("../scripts/check-pack.mjs") as Promise<PackVerifier>;
}

beforeAll(
  () => {
    const build = runNpm(["run", "build"]);
    if (build.status !== 0) {
      throw new Error(`Package-contract build failed:\n${build.stderr || build.stdout}`);
    }
  },
  30_000
);

describe("package metadata contract", () => {
  it("identifies the public repository and package support URLs", () => {
    const manifest = readPackageManifest();

    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/mohanagy/miftah.git"
    });
    expect(manifest.homepage).toBe("https://github.com/mohanagy/miftah#readme");
    expect(manifest.bugs).toEqual({
      url: "https://github.com/mohanagy/miftah/issues"
    });
  });

  it("declares npm discoverability and public registry publication settings", () => {
    const manifest = readPackageManifest();

    expect(manifest.keywords).toEqual(
      expect.arrayContaining([
        "mcp",
        "model-context-protocol",
        "credential-broker",
        "multi-account",
        "security",
        "cli"
      ])
    );
    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/"
    });
  });

  it("exposes the package verification command", () => {
    expect(readPackageManifest().scripts?.["check:pack"]).toBe("node scripts/check-pack.mjs");
  });
});

describe("packed artifact contract", () => {
  it("contains required runtime, documentation, and example files from a real dry run", () => {
    const packed = runNpm(["pack", "--dry-run", "--json"]);

    expect(packed.status, packed.stderr).toBe(0);
    const results = JSON.parse(packed.stdout) as PackResult[];
    expect(results).toHaveLength(1);
    const paths = results[0]!.files.map(({ path }) => path);
    expect(paths).toEqual(expect.arrayContaining([...requiredPackPaths]));
    expect(
      paths.filter(
        (path) =>
          !["LICENSE", "README.md", "package.json"].includes(path) &&
          !/^(dist|docs|examples)\//u.test(path)
      )
    ).toEqual([]);
  });

  it("accepts the critical package paths", async () => {
    const { verifyPackPaths } = await loadPackVerifier();

    expect(verifyPackPaths(requiredPackPaths)).toEqual(requiredPackPaths);
  });

  it("rejects unexpected source paths", async () => {
    const { verifyPackPaths } = await loadPackVerifier();

    expect(() => verifyPackPaths([...requiredPackPaths, "src/index.ts"])).toThrow(
      /unexpected package paths.*src\/index\.ts/isu
    );
  });

  it("rejects package paths containing traversal segments", async () => {
    const { verifyPackPaths } = await loadPackVerifier();

    expect(() => verifyPackPaths([...requiredPackPaths, "dist/../secrets.js"])).toThrow(
      /unexpected package paths.*dist\/\.\.\/secrets\.js/isu
    );
  });

  it("rejects a package missing a critical entry", async () => {
    const { verifyPackPaths } = await loadPackVerifier();
    const withoutCli = requiredPackPaths.filter((path) => path !== "dist/cli/main.js");

    expect(() => verifyPackPaths(withoutCli)).toThrow(
      /missing required package paths.*dist\/cli\/main\.js/isu
    );
  });

  it("runs the checked package command against the real npm pack output", () => {
    const checked = runNpm(["run", "check:pack"]);

    expect(checked.status, checked.stderr || checked.stdout).toBe(0);
    expect(checked.stdout).toMatch(/Package contract verified \(\d+ files\)\./u);
  });

  it(
    "loads the installed entry point and runs the installed binary from a real tarball",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-packed-artifact-"));
      try {
        const packed = runNpm(["pack", "--json", "--pack-destination", directory]);
        expect(packed.status, packed.stderr).toBe(0);
        const [result] = JSON.parse(packed.stdout) as PackResult[];
        if (!result) throw new Error("npm pack did not report an artifact.");

        const install = runNpm(["install", "--ignore-scripts", "--no-package-lock", join(directory, result.filename)], directory);
        expect(install.status, install.stderr || install.stdout).toBe(0);

        const consumerPath = join(directory, "consumer.mjs");
        const configPath = join(directory, "miftah.json");
        await writeFile(
          configPath,
          JSON.stringify({
            version: "1",
            name: "packed-public-api",
            defaultProfile: "work",
            upstream: { transport: "stdio", command: process.execPath },
            profiles: { work: {} }
          })
        );
        await writeFile(
          consumerPath,
          [
            'import * as api from "@lubab/miftah";',
            'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
            'import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";',
            "",
            "const runtime = await api.createMiftahRuntime(process.argv[2]);",
            "const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();",
            'const client = new Client({ name: "packed-artifact-test", version: "1.0.0" });',
            "try {",
            "  await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);",
            "  process.stdout.write(JSON.stringify({",
            "    exports: Object.keys(api).sort(),",
            "    version: api.MIFTAH_VERSION,",
            "    server: client.getServerVersion()",
            "  }));",
            "} finally {",
            "  await client.close();",
            "  await runtime.close();",
            "}"
          ].join("\n")
        );
        const entryPoint = spawnSync(process.execPath, [consumerPath, configPath], {
          cwd: directory,
          encoding: "utf8",
          timeout: npmCommandTimeoutMs
        });
        expect(entryPoint.status, entryPoint.stderr || entryPoint.stdout).toBe(0);
        expect(JSON.parse(entryPoint.stdout)).toEqual({
          exports: [...publicRuntimeExports].sort(),
          version: readPackageManifest().version,
          server: {
            name: "miftah-packed-public-api",
            version: readPackageManifest().version
          }
        });

        const typeConsumerPath = join(directory, "consumer.ts");
        await writeFile(
          typeConsumerPath,
          [
            'import { createMiftahRuntime, MIFTAH_VERSION, type AuditConfig, type ConfigDiagnostic, type MiftahConfig, type MiftahErrorCode, type MiftahErrorDetails, type MiftahRuntime, type PolicyConfig, type ProcessConfig, type ProfileConfig, type ProfileUpstreamOverride, type RiskLevel, type RoutingConfig, type RoutingRule, type SecurityConfig, type ToolDiscoveryMode, type ToolingConfig, type TransportType, type UpstreamConfig, type ValidatedRoutingConfig } from "@lubab/miftah";',
            "",
            "type SupportedTypes = [",
            "  AuditConfig, ConfigDiagnostic, MiftahConfig, MiftahErrorCode, MiftahErrorDetails, MiftahRuntime,",
            "  PolicyConfig, ProcessConfig, ProfileConfig, ProfileUpstreamOverride, RiskLevel, RoutingConfig,",
            "  RoutingRule, SecurityConfig, ToolDiscoveryMode, ToolingConfig, TransportType, UpstreamConfig,",
            "  ValidatedRoutingConfig",
            "];",
            "declare const types: SupportedTypes;",
            "const version: string = MIFTAH_VERSION;",
            'const runtime: Promise<MiftahRuntime> = createMiftahRuntime("./miftah.json");',
            "void [types, version, runtime];"
          ].join("\n")
        );
        const typecheck = spawnSync(
          process.execPath,
          [
            typescriptCliPath,
            "--noEmit",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--target",
            "ES2022",
            "--skipLibCheck",
            typeConsumerPath
          ],
          {
            cwd: directory,
            encoding: "utf8",
            timeout: npmCommandTimeoutMs
          }
        );
        expect(typecheck.status, typecheck.stderr || typecheck.stdout).toBe(0);

        const binary = join(directory, "node_modules", ".bin", process.platform === "win32" ? "miftah.cmd" : "miftah");
        const schema = runInstalledBinary(binary, ["schema"], directory);
        expect(schema.status, schema.stderr || schema.stdout).toBe(0);
        expect(JSON.parse(schema.stdout)).toMatchObject({
          $schema: "https://json-schema.org/draft/2019-09/schema#"
        });

        const version = runInstalledBinary(binary, ["version"], directory);
        expect(version.status, version.stderr || version.stdout).toBe(0);
        expect(version.stdout.trim()).toBe(readPackageManifest().version);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );
});

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

interface NpmCommand {
  args: readonly string[];
  timeoutMs: number;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommandTimeoutMs = 25_000;
// A fresh consumer resolves package dependencies and is slower on Windows than local pack/build/check commands.
const consumerInstallTimeoutMs = 120_000;
const packedArtifactContractTimeoutMs = consumerInstallTimeoutMs + npmCommandTimeoutMs;
const npmDiagnosticOutputLimit = 8_000;
const npmCliPath = process.env.npm_execpath;
const typescriptCliPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const fakeStdioUpstreamFixture = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
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

function consumerInstallCommand(tarballPath: string): NpmCommand {
  return {
    args: [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      tarballPath
    ],
    timeoutMs: consumerInstallTimeoutMs
  };
}

function capturedNpmOutput(stream: "stdout" | "stderr", output: string | null): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) return undefined;

  const truncated = trimmed.slice(0, npmDiagnosticOutputLimit);
  const suffix = truncated.length === trimmed.length ? "" : "\n... output truncated";
  return `${stream}:\n${truncated}${suffix}`;
}

function npmDiagnostics(stdout: string | null, stderr: string | null): string {
  const outputs = [capturedNpmOutput("stdout", stdout), capturedNpmOutput("stderr", stderr)].filter(
    (output): output is string => output !== undefined
  );
  return outputs.length === 0 ? "" : `\nCaptured npm output:\n${outputs.join("\n")}`;
}

function runNpm(args: readonly string[], cwd = repositoryRoot, timeoutMs = npmCommandTimeoutMs) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    timeout: timeoutMs,
    killSignal: "SIGTERM"
  });
  if (result.error) {
    const timedOut = "code" in result.error && result.error.code === "ETIMEDOUT";
    const reason =
      timedOut
        ? `timed out after ${timeoutMs}ms`
        : `could not start: ${result.error.message}`;
    throw new Error(`npm ${args.join(" ")} ${reason}.${npmDiagnostics(result.stdout, result.stderr)}`);
  }
  if (result.status !== 0) {
    const outcome =
      result.status === null
        ? `terminated by ${result.signal ?? "an unknown signal"}`
        : `exited with status ${result.status}`;
    throw new Error(`npm ${args.join(" ")} ${outcome}.${npmDiagnostics(result.stdout, result.stderr)}`);
  }
  return result;
}

function quoteForWindowsCommand(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function buildWindowsCommand(binary: string, args: readonly string[]): string {
  // cmd.exe /s removes this outer pair before parsing the quoted executable path.
  return `"${[binary, ...args].map(quoteForWindowsCommand).join(" ")}"`;
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
    ["/d", "/s", "/c", buildWindowsCommand(binary, args)],
    {
      cwd,
      encoding: "utf8",
      timeout: npmCommandTimeoutMs,
      windowsVerbatimArguments: true
    }
  );
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/gu, "'\"'\"'")}'`;
}

function runInstalledBinaryThroughPosixShell(binary: string, args: readonly string[], cwd: string) {
  return spawnSync("/bin/sh", ["-c", [binary, ...args].map(quoteForPosixShell).join(" ")], {
    cwd,
    encoding: "utf8",
    timeout: npmCommandTimeoutMs
  });
}

function runInstalledBinaryThroughShell(binary: string, args: readonly string[], cwd: string) {
  return process.platform === "win32"
    ? runInstalledBinary(binary, args, cwd)
    : runInstalledBinaryThroughPosixShell(binary, args, cwd);
}

async function loadPackVerifier(): Promise<PackVerifier> {
  // @ts-expect-error The production verifier is intentionally plain Node ESM.
  return import("../scripts/pack-verifier.mjs") as Promise<PackVerifier>;
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
  it("gives the fresh consumer install deterministic offline options and its own timeout", () => {
    expect(consumerInstallCommand("miftah-0.1.1.tgz")).toEqual({
      args: [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        "miftah-0.1.1.tgz"
      ],
      timeoutMs: 120_000
    });
  });

  it("includes captured output when an npm command exits unsuccessfully", () => {
    expect(() =>
      runNpm([
        "exec",
        "--",
        process.execPath,
        "--eval",
        'process.stdout.write("miftah-diagnostic-out"); process.stderr.write("miftah-diagnostic-err"); process.exit(1);'
      ])
    ).toThrow(
      /exited with status 1\.\nCaptured npm output:\nstdout:\nmiftah-diagnostic-out\nstderr:\nmiftah-diagnostic-err/u
    );
  });

  it("loads its verifier from a shebang-free ESM module", async () => {
    const verifierSource = readFileSync(new URL("../scripts/pack-verifier.mjs", import.meta.url), "utf8");

    expect(verifierSource).not.toMatch(/^#!/u);
    await expect(loadPackVerifier()).resolves.toEqual(
      expect.objectContaining({ verifyPackPaths: expect.any(Function) })
    );
  });

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

        const consumerInstall = consumerInstallCommand(join(directory, result.filename));
        const install = runNpm(consumerInstall.args, directory, consumerInstall.timeoutMs);
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
            'import { createMiftahRuntime, MIFTAH_VERSION, type ActiveProfileStateScope, type AuditConfig, type ConfigDiagnostic, type IdentityConfig, type IdentityFingerprint, type IdentityProbeConfig, type MiftahConfig, type MiftahErrorCode, type MiftahErrorDetails, type MiftahRuntime, type PolicyConfig, type ProcessConfig, type ProfileConfig, type ProfileIsolationConfig, type ProfileIsolationContainerVolume, type ProfileIsolationFile, type ProfileLeaseConfig, type ProfileUpstreamOverride, type RiskLevel, type RoutingConfig, type RoutingRule, type SecurityConfig, type StateConfig, type ToolDiscoveryMode, type ToolingConfig, type TransportType, type UnknownToolRisk, type UpstreamConfig, type ValidatedRoutingConfig } from "@lubab/miftah";',
            "",
            "type SupportedTypes = [",
            "  ActiveProfileStateScope, AuditConfig, ConfigDiagnostic, IdentityConfig, IdentityFingerprint, IdentityProbeConfig, MiftahConfig,",
            "  MiftahErrorCode, MiftahErrorDetails, MiftahRuntime,",
            "  PolicyConfig, ProcessConfig, ProfileConfig, ProfileIsolationConfig, ProfileIsolationContainerVolume, ProfileIsolationFile, ProfileLeaseConfig, ProfileUpstreamOverride, RiskLevel, RoutingConfig,",
            "  RoutingRule, SecurityConfig, StateConfig, ToolDiscoveryMode, ToolingConfig, TransportType, UnknownToolRisk, UpstreamConfig,",
            "  ValidatedRoutingConfig",
            "];",
            "declare const types: SupportedTypes;",
            "const version: string = MIFTAH_VERSION;",
            'const runtime: Promise<MiftahRuntime> = createMiftahRuntime("./miftah.json");',
            'const globalScope: ActiveProfileStateScope = "global";',
            'const validState: StateConfig = { persistActiveProfile: true, scope: "workspace" };',
            'const validSessionState: StateConfig = { scope: "session" };',
            'const validProfileLease: ProfileLeaseConfig = { ttlMs: 60_000, requiredForRisk: ["write"] };',
            'const isolatedFile: ProfileIsolationFile = { source: "credentials/oauth.json", destination: "credentials/oauth.json" };',
            'const isolatedVolume: ProfileIsolationContainerVolume = { source: "credentials/oauth.json", destination: "/run/miftah/oauth.json" };',
            'const isolation: ProfileIsolationConfig = { files: [isolatedFile], containerVolumes: [isolatedVolume] };',
            "// @ts-expect-error Profile lease risk requirements must be unique.",
            'const invalidDuplicateProfileLease: ProfileLeaseConfig = { ttlMs: 60_000, requiredForRisk: ["write", "write"] };',
            'const unknownRisk: UnknownToolRisk = "destructive";',
            "// @ts-expect-error Durable profile state requires explicit opt-in.",
            'const invalidState: StateConfig = { scope: "global" };',
            'const validTextIdentity: IdentityConfig = { expected: { provider: "github", login: "mona" }, probe: { tool: "whoami", resultFormat: "text", provider: "github" }, maxAgeMs: 60_000, requiredForRisk: ["write"] };',
            "// This structurally type-checks; validateConfig must enforce provider equality at runtime.",
            'const mismatchedTextProviderIdentity: IdentityConfig = { expected: { provider: "github", login: "mona" }, probe: { tool: "whoami", resultFormat: "text", provider: "gitlab" }, maxAgeMs: 60_000 };',
            'const validDestructiveIdentity: IdentityConfig = { expected: { provider: "github", login: "mona" }, probe: { tool: "whoami", resultFormat: "text", provider: "github" }, maxAgeMs: 60_000, requiredForRisk: ["destructive"] };',
            'const validWriteThenDestructiveIdentity: IdentityConfig = { expected: { provider: "github", login: "mona" }, probe: { tool: "whoami", resultFormat: "text", provider: "github" }, maxAgeMs: 60_000, requiredForRisk: ["write", "destructive"] };',
            'const validDestructiveThenWriteIdentity: IdentityConfig = { expected: { provider: "github", login: "mona" }, probe: { tool: "whoami", resultFormat: "text", provider: "github" }, maxAgeMs: 60_000, requiredForRisk: ["destructive", "write"] };',
            "const invalidDuplicateRiskIdentity: IdentityConfig = {",
            '  expected: { provider: "github", login: "mona" },',
            '  probe: { tool: "whoami", resultFormat: "text", provider: "github" },',
            "  maxAgeMs: 60_000,",
            "  // @ts-expect-error Identity risk requirements must be unique.",
            '  requiredForRisk: ["write", "write"]',
            "};",
            'const validJsonIdentity: IdentityConfig = { expected: { organization: "lubab" }, probe: { tool: "identity", resultFormat: "json" }, maxAgeMs: 60_000 };',
            "  // @ts-expect-error Text probes require an expected login.",
            "const invalidTextIdentity: IdentityConfig = {",
            '  expected: { provider: "github" },',
            '  probe: { tool: "whoami", resultFormat: "text", provider: "github" },',
            "  maxAgeMs: 60_000",
            "};",
            "  // @ts-expect-error Text probes cannot verify an organization.",
            "const invalidTextOrganization: IdentityConfig = {",
            '  expected: { login: "mona", organization: "lubab" },',
            '  probe: { tool: "whoami", resultFormat: "text" },',
            "  maxAgeMs: 60_000",
            "};",
            "  // @ts-expect-error Expected text providers require a static probe provider.",
            "const invalidTextProviderWithoutProbeProvider: IdentityConfig = {",
            '  expected: { provider: "github", login: "mona" },',
            '  probe: { tool: "whoami", resultFormat: "text" },',
            "  maxAgeMs: 60_000",
            "};",
            "const invalidJsonStaticProvider: IdentityConfig = {",
            '  expected: { login: "mona" },',
            "  // @ts-expect-error JSON probes do not support a static provider.",
            '  probe: { tool: "identity", resultFormat: "json", provider: "github" },',
            "  maxAgeMs: 60_000",
            "};",
            "const invalidJsonEmptyExpected: IdentityConfig = {",
            "  // @ts-expect-error JSON probes require at least one expected fingerprint field.",
            "  expected: {},",
            '  probe: { tool: "identity", resultFormat: "json" },',
            "  maxAgeMs: 60_000",
            "};",
            "  // @ts-expect-error JSON probes do not support a static provider.",
            "const invalidJsonProbe: IdentityProbeConfig = {",
            '  tool: "identity", resultFormat: "json",',
            '  provider: "github"',
            "};",
            "void [types, version, runtime, globalScope, validState, validSessionState, validProfileLease, isolatedFile, isolatedVolume, isolation, invalidDuplicateProfileLease, unknownRisk, invalidState, validTextIdentity, mismatchedTextProviderIdentity, validDestructiveIdentity, validWriteThenDestructiveIdentity, validDestructiveThenWriteIdentity, invalidDuplicateRiskIdentity, invalidTextIdentity, invalidTextOrganization, invalidTextProviderWithoutProbeProvider, invalidJsonStaticProvider, invalidJsonEmptyExpected, invalidJsonProbe];"
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
        const writeDoctorConfig = async (name: string, config: Record<string, unknown>): Promise<string> => {
          const path = join(directory, name);
          await writeFile(path, JSON.stringify(config));
          if (process.platform !== "win32") await chmod(path, 0o600);
          return path;
        };
        const doctorConfig = (name: string, env: Record<string, string> = {}, args: string[] = [fakeStdioUpstreamFixture]) => ({
          version: "1",
          name,
          defaultProfile: "work",
          upstream: { transport: "stdio", command: process.execPath, args },
          profiles: { work: { env } },
          process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 }
        });
        const healthyConfigPath = await writeDoctorConfig(
          "doctor-healthy.json",
          doctorConfig("packed-doctor-healthy")
        );
        const healthyDoctor = runInstalledBinary(binary, ["doctor", "--config", healthyConfigPath], directory);
        expect(healthyDoctor.status, healthyDoctor.stderr || healthyDoctor.stdout).toBe(0);
        expect(healthyDoctor.stderr).toBe("");
        expect(healthyDoctor.stdout).toContain("Doctor: healthy");
        expect(healthyDoctor.stdout).toContain("DOCTOR_CONFIGURATION");
        expect(healthyDoctor.stdout).toContain("DOCTOR_STARTUP");
        expect(healthyDoctor.stdout).toMatch(/\n$/u);

        const degradedConfigPath = await writeDoctorConfig(
          "doctor-degraded.json",
          doctorConfig("packed-doctor-degraded", { TEST_FAIL_LIST_RESOURCES: "true" })
        );
        const degradedDoctor = runInstalledBinary(
          binary,
          ["doctor", "--json", "--config", degradedConfigPath],
          directory
        );
        expect(degradedDoctor.status, degradedDoctor.stderr || degradedDoctor.stdout).toBe(0);
        expect(degradedDoctor.stderr).toBe("");
        expect(degradedDoctor.stdout).toMatch(/\n$/u);
        expect(JSON.parse(degradedDoctor.stdout)).toMatchObject({ overallStatus: "degraded", ok: true });

        const missingSecretReference = "secretref:env://MIFTAH_PACKED_DOCTOR_MISSING_SECRET";
        const rawCommandArgument = "--packed-doctor-raw-command-argument";
        const failedConfigPath = await writeDoctorConfig(
          "doctor-failed.json",
          doctorConfig(
            "packed-doctor-failed",
            { API_TOKEN: missingSecretReference },
            [fakeStdioUpstreamFixture, rawCommandArgument]
          )
        );
        const failedDoctor = runInstalledBinary(
          binary,
          ["doctor", "--config", failedConfigPath, "--json"],
          directory
        );
        expect(failedDoctor.status).toBe(1);
        expect(failedDoctor.stderr).toBe("");
        expect(failedDoctor.stdout).toMatch(/\n$/u);
        expect(JSON.parse(failedDoctor.stdout)).toMatchObject({ overallStatus: "failed", ok: false });
        for (const value of [
          missingSecretReference,
          rawCommandArgument,
          failedConfigPath,
          fakeStdioUpstreamFixture,
          process.execPath
        ]) {
          expect(`${failedDoctor.stdout}${failedDoctor.stderr}`).not.toContain(value);
        }

        const schema = runInstalledBinary(binary, ["schema"], directory);
        expect(schema.status, schema.stderr || schema.stdout).toBe(0);
        expect(JSON.parse(schema.stdout)).toMatchObject({
          $schema: "https://json-schema.org/draft/2019-09/schema#"
        });

        const version = runInstalledBinary(binary, ["version"], directory);
        expect(version.status, version.stderr || version.stdout).toBe(0);
        expect(version.stdout.trim()).toBe(readPackageManifest().version);

        const versionWithJson = runInstalledBinary(binary, ["version", "--json"], directory);
        expect(versionWithJson.status, versionWithJson.stderr || versionWithJson.stdout).toBe(0);
        expect(versionWithJson.stdout.trim()).toBe(readPackageManifest().version);

        const cliContractDirectory = join(directory, "CLI contract hierarchy with spaces");
        const configDirectory = join(cliContractDirectory, "configuration files with spaces");
        await mkdir(configDirectory, { recursive: true });
        const writeCliConfig = async (name: string, config: Record<string, unknown>): Promise<string> => {
          const path = join(configDirectory, name);
          await writeFile(path, JSON.stringify(config));
          if (process.platform !== "win32") await chmod(path, 0o600);
          return path;
        };
        const cliConfig = (
          name: string,
          profiles: Record<string, unknown>,
          args: string[] = [fakeStdioUpstreamFixture],
          extras: Record<string, unknown> = {}
        ) => ({
          version: "1",
          name,
          defaultProfile: "work",
          upstream: { transport: "stdio", command: process.execPath, args },
          profiles,
          process: { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 },
          ...extras
        });

        const rootHelp = runInstalledBinary(binary, ["--help"], cliContractDirectory);
        expect(rootHelp.status, rootHelp.stderr || rootHelp.stdout).toBe(0);
        expect(rootHelp.stderr).toBe("");
        expect(rootHelp.stdout).toContain("Usage: miftah [command] [options]");
        const commandOptions = {
          serve: ["--config <file>"],
          validate: ["--config <file>"],
          doctor: ["--config <file>", "--json"],
          schema: [],
          init: ["--name <name>", "--preset <name>", "--output <file>"],
          "list-tools": ["--config <file>", "--profile <name>"],
          "test-profile": ["--config <file>", "--profile <name>"],
          logs: ["--config <file>", "--follow"],
          version: ["--json"]
        } as const;
        for (const [command, options] of Object.entries(commandOptions)) {
          expect(rootHelp.stdout).toContain(command);
          const help = runInstalledBinary(binary, [command, "--help"], cliContractDirectory);
          expect(help.status, help.stderr || help.stdout).toBe(0);
          expect(help.stderr).toBe("");
          expect(help.stdout).toContain(`Usage: miftah ${command}`);
          for (const option of options) expect(help.stdout).toContain(option);
        }

        for (const args of [["--version"], ["-v"], ["version"], ["version", "--json"]] as const) {
          const command = runInstalledBinary(binary, args, cliContractDirectory);
          expect(command.status, command.stderr || command.stdout).toBe(0);
          expect(command.stderr).toBe("");
          expect(command.stdout.trim()).toBe(readPackageManifest().version);
        }

        const initOutputPath = join(cliContractDirectory, "generated output with spaces", "starter config with spaces.json");
        const initialized = runInstalledBinaryThroughShell(
          binary,
          ["init", "starter config with spaces", "--preset", "generic", "--output", initOutputPath],
          cliContractDirectory
        );
        expect(initialized.status, initialized.stderr || initialized.stdout).toBe(0);
        expect(initialized.stderr).toBe("");
        expect(initialized.stdout).toContain(initOutputPath);
        expect(JSON.parse(await readFile(initOutputPath, "utf8"))).toMatchObject({ name: "starter config with spaces" });
        const validatedInit = runInstalledBinaryThroughShell(
          binary,
          ["validate", "--config", initOutputPath],
          cliContractDirectory
        );
        expect(validatedInit.status, validatedInit.stderr || validatedInit.stdout).toBe(0);
        expect(validatedInit.stderr).toBe("");
        expect(JSON.parse(validatedInit.stdout)).toMatchObject({ ok: true, name: "starter config with spaces" });

        const automationConfigPath = await writeCliConfig(
          "automation config with spaces.json",
          cliConfig("packed-cli-automation", {
            work: { env: { TEST_ACCOUNT_NAME: "automation-account" } }
          })
        );
        const schemaAutomation = runInstalledBinary(binary, ["schema"], cliContractDirectory);
        expect(schemaAutomation.status, schemaAutomation.stderr || schemaAutomation.stdout).toBe(0);
        expect(schemaAutomation.stderr).toBe("");
        expect(JSON.parse(schemaAutomation.stdout)).toMatchObject({
          $schema: "https://json-schema.org/draft/2019-09/schema#"
        });
        const validateAutomation = runInstalledBinary(
          binary,
          ["validate", "--config", automationConfigPath],
          cliContractDirectory
        );
        expect(validateAutomation.status, validateAutomation.stderr || validateAutomation.stdout).toBe(0);
        expect(validateAutomation.stderr).toBe("");
        expect(JSON.parse(validateAutomation.stdout)).toMatchObject({ ok: true, name: "packed-cli-automation" });
        const doctorAutomation = runInstalledBinary(
          binary,
          ["doctor", "--json", "--config", automationConfigPath],
          cliContractDirectory
        );
        expect(doctorAutomation.status, doctorAutomation.stderr || doctorAutomation.stdout).toBe(0);
        expect(doctorAutomation.stderr).toBe("");
        expect(JSON.parse(doctorAutomation.stdout)).toMatchObject({ ok: true, overallStatus: "healthy" });
        const listedTools = runInstalledBinary(
          binary,
          ["list-tools", "--config", automationConfigPath, "--profile", "work"],
          cliContractDirectory
        );
        expect(listedTools.status, listedTools.stderr || listedTools.stdout).toBe(0);
        expect(listedTools.stderr).toBe("");
        expect(JSON.parse(listedTools.stdout)).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "whoami" })])
        );
        const testedProfile = runInstalledBinary(
          binary,
          ["test-profile", "--config", automationConfigPath, "--profile", "work"],
          cliContractDirectory
        );
        expect(testedProfile.status, testedProfile.stderr || testedProfile.stdout).toBe(0);
        expect(testedProfile.stderr).toBe("");
        expect(JSON.parse(testedProfile.stdout)).toEqual({ ok: true, profile: "work" });

        const noRuntimeStartPath = join(cliContractDirectory, "runtime must not start");
        const unavailableSecretName = "MIFTAH_PACKED_CONTRACT_MISSING_SECRET";
        const unavailableConfigPath = await writeCliConfig(
          "unavailable secret config.json",
          cliConfig(
            "packed-cli-unavailable-secret",
            { work: { env: { API_TOKEN: `secretref:env://${unavailableSecretName}` } } },
            [
              "--eval",
              `require("node:fs").writeFileSync(${JSON.stringify(noRuntimeStartPath)}, "started")`
            ]
          )
        );
        for (const args of [
          ["list-tools", "--config", unavailableConfigPath, "--unknown"],
          ["list-tools", "--config", unavailableConfigPath, "--profile"],
          ["schema", "--config", unavailableConfigPath]
        ]) {
          const invalid = runInstalledBinary(binary, args, cliContractDirectory);
          expect(invalid.status).toBe(2);
          expect(invalid.stdout).toBe("");
          expect(invalid.stderr).not.toContain(unavailableSecretName);
          expect(invalid.stderr).not.toContain("SECRET_ENV_MISSING");
          expect(invalid.stderr).not.toContain("UPSTREAM_");
        }
        await expect(readFile(noRuntimeStartPath, "utf8")).rejects.toThrow();

        const missingConfigPath = join(configDirectory, "missing config with spaces.json");
        const missingConfig = runInstalledBinary(binary, ["validate", "--config", missingConfigPath], cliContractDirectory);
        expect(missingConfig.status).toBe(3);
        expect(missingConfig.stdout).toBe("");
        expect(missingConfig.stderr).toContain("CONFIG_NOT_FOUND");

        const missingSecretStartPath = join(cliContractDirectory, "missing secret must not start");
        const missingSecretConfigPath = await writeCliConfig(
          "missing secret config.json",
          cliConfig(
            "packed-cli-missing-secret",
            { work: { env: { API_TOKEN: `secretref:env://${unavailableSecretName}` } } },
            [
              "--eval",
              `require("node:fs").writeFileSync(${JSON.stringify(missingSecretStartPath)}, "started")`
            ]
          )
        );
        const missingSecret = runInstalledBinary(
          binary,
          ["test-profile", "--config", missingSecretConfigPath],
          cliContractDirectory
        );
        expect(missingSecret.status).toBe(4);
        expect(missingSecret.stdout).toBe("");
        expect(missingSecret.stderr).toContain("SECRET_ENV_MISSING");
        expect(missingSecret.stderr).not.toContain(`secretref:env://${unavailableSecretName}`);
        await expect(readFile(missingSecretStartPath, "utf8")).rejects.toThrow();

        const failedInitSecret = "packed-cli-init-secret";
        const upstreamShutdownPath = join(cliContractDirectory, "failed upstream shutdown");
        const failedInitConfigPath = await writeCliConfig(
          "failed upstream config.json",
          cliConfig(
            "packed-cli-failed-init",
            {
              work: {
                env: {
                  API_TOKEN: `secretref:plain://${failedInitSecret}`,
                  TEST_FAIL_INITIALIZE: "true",
                  TEST_SHUTDOWN_END_PATH: upstreamShutdownPath
                }
              }
            },
            [fakeStdioUpstreamFixture],
            { secrets: { allowPlaintextSecrets: true } }
          )
        );
        const failedInit = runInstalledBinary(
          binary,
          ["test-profile", "--config", failedInitConfigPath],
          cliContractDirectory
        );
        expect(failedInit.status).toBe(5);
        expect(failedInit.stdout).toBe("");
        expect(failedInit.stderr).toContain("UPSTREAM_INIT_FAILED");
        expect(`${failedInit.stdout}${failedInit.stderr}`).not.toContain(failedInitSecret);
        expect(await readFile(upstreamShutdownPath, "utf8")).toBe("ended");

        const auditPath = join(cliContractDirectory, "audit output with spaces", "events with spaces.jsonl");
        const auditUsername = ["user", "name"].join("");
        const auditPassword = ["pass", "word"].join("");
        await mkdir(dirname(auditPath), { recursive: true });
        await writeFile(
          auditPath,
          `${JSON.stringify({
            callbackUrl: `https://${auditUsername}:${auditPassword}@example.test/callback?access_token=uri-query-secret&tenant=private-tenant`,
            message: "non-default-profile-secret"
          })}\n`
        );
        const logsConfigPath = await writeCliConfig(
          "logs config with spaces.json",
          cliConfig(
            "packed-cli-logs",
            {
              work: {},
              archival: {
                env: { WORK_ENV: "secretref:plain://non-default-profile-secret" }
              }
            },
            [fakeStdioUpstreamFixture],
            {
              audit: { path: auditPath },
              secrets: { allowPlaintextSecrets: true }
            }
          )
        );
        const logs = runInstalledBinaryThroughShell(
          binary,
          ["logs", "--config", logsConfigPath],
          cliContractDirectory
        );
        expect(logs.status, logs.stderr || logs.stdout).toBe(0);
        expect(logs.stderr).toBe("");
        for (const secret of ["username", "password", "uri-query-secret", "private-tenant", "non-default-profile-secret"]) {
          expect(logs.stdout).not.toContain(secret);
        }
        const logRecords = logs.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, string>);
        expect(logRecords).toEqual([
          {
            callbackUrl: "https://example.test/callback?access_token=%5BREDACTED%5D&tenant=%5BREDACTED%5D",
            message: "[REDACTED]"
          }
        ]);

        const installedCliReference = await readFile(
          join(directory, "node_modules", "@lubab", "miftah", "docs", "cli.md"),
          "utf8"
        );
        expect(installedCliReference).toContain("## Help");
        for (const command of Object.keys(commandOptions)) {
          expect(installedCliReference).toContain(`\`miftah ${command}`);
        }
        for (const option of [
          "--help",
          "-h",
          "--version",
          "-v",
          "--config",
          "--profile",
          "--output",
          "--preset",
          "--name",
          "--json",
          "--follow"
        ]) {
          expect(installedCliReference).toContain(`\`${option}`);
        }
        expect(installedCliReference).toContain("| `2` | Usage");
        expect(installedCliReference).toContain("| `3` | Configuration");
        expect(installedCliReference).toContain("| `4` | Secret resolution");
        expect(installedCliReference).toContain("| `5` | Upstream");
        expect(installedCliReference).toContain("| `6` | Policy");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    packedArtifactContractTimeoutMs
  );
});

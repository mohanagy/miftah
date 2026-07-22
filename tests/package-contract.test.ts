import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  repository?: unknown;
  homepage?: unknown;
  bugs?: unknown;
  keywords?: unknown;
  overrides?: Record<string, string>;
  publishConfig?: unknown;
  scripts?: Record<string, string>;
}

interface PackVerifier {
  parsePackResult(output: string): PackResult;
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

interface PackageLock {
  lockfileVersion?: number;
  requires?: boolean;
  packages?: Record<string, Record<string, unknown>>;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommandTimeoutMs = 25_000;
// A fresh consumer resolves package dependencies and is slower on Windows than local pack/build/check commands.
const consumerInstallTimeoutMs = 120_000;
const packedArtifactContractTimeoutMs = consumerInstallTimeoutMs + npmCommandTimeoutMs;
const npmDiagnosticOutputLimit = 8_000;
const npmTerminationGraceMs = 250;
const npmCliPath = process.env.npm_execpath;
const typescriptCliPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const fakeStdioUpstreamFixture = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const publicRuntimeExports = [
  "CURRENT_CONFIG_VERSION",
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
  "dist/plugin-api.d.ts",
  "dist/plugin-api.js",
  "dist/plugin-host.js",
  "dist/windows-secret-job.exe",
  "docs/cli.md",
  "docs/library-api.md",
  "docs/provider-adapters.md",
  "docs/plugins.md",
  "examples/generic.miftah.json",
  "examples/plugins.miftah.json",
  "examples/plugins/file-secret-provider.mjs",
  "examples/plugins/github-owner-routing-matcher.mjs",
  "package.json"
] as const;

function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

function assertPatchedEsbuildLockEntries(lock: PackageLock): void {
  const esbuildEntries = Object.entries(lock.packages ?? {}).filter(([packagePath]) =>
    packagePath.endsWith("node_modules/esbuild")
  );

  expect(esbuildEntries).not.toHaveLength(0);
  for (const [packagePath, packageEntry] of esbuildEntries) {
    expect(packageEntry["version"], `${packagePath} must resolve to the patched esbuild release`).toBe("0.28.1");
  }
}

function assertPatchedFastUriLockEntries(lock: PackageLock): void {
  const suffix = "node_modules/fast-uri";
  const entries = Object.entries(lock.packages ?? {}).filter(
    ([packagePath]) => packagePath === suffix || packagePath.endsWith(`/${suffix}`)
  );

  expect(entries, "fast-uri must exist in the package lock").not.toHaveLength(0);
  for (const [packagePath, packageEntry] of entries) {
    expect(packageEntry["version"], `${packagePath} must resolve to the patched release`).toBe("3.1.4");
  }
}

async function prepareLockedConsumer(directory: string, tarballPath: string): Promise<void> {
  const manifest = readPackageManifest();
  if (!manifest.name) throw new Error("Package manifest is missing a name.");

  const source = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as PackageLock;
  const rootPackage = source.packages?.[""];
  if (!rootPackage || source.lockfileVersion === undefined) {
    throw new Error("Package lock is missing the root package entry.");
  }

  const tarball = `file:${basename(tarballPath)}`;
  const consumerManifest = {
    name: "miftah-packed-artifact-contract",
    private: true,
    dependencies: { [manifest.name]: tarball }
  };
  const packedPackage = { ...rootPackage };
  delete packedPackage.devDependencies;
  const consumerLock = {
    name: consumerManifest.name,
    lockfileVersion: source.lockfileVersion,
    requires: source.requires,
    packages: {
      ...source.packages,
      "": consumerManifest,
      [`node_modules/${manifest.name}`]: { ...packedPackage, resolved: tarball }
    }
  };

  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify(consumerManifest)),
    writeFile(join(directory, "package-lock.json"), JSON.stringify(consumerLock))
  ]);
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

function consumerInstallCommand(): NpmCommand {
  return {
    args: [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline"
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

interface NpmCommandResult {
  readonly status: 0;
  readonly stdout: string;
  readonly stderr: string;
}

interface NpmProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (status: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

interface NpmSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

type NpmSpawner = (
  command: string,
  args: readonly string[],
  options: NpmSpawnOptions
) => NpmProcess;

const spawnNpm: NpmSpawner = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: options.stdio
  });

async function runNpm(
  args: readonly string[],
  cwd = repositoryRoot,
  timeoutMs = npmCommandTimeoutMs,
  spawnProcess: NpmSpawner = spawnNpm
): Promise<NpmCommandResult> {
  const invocation = npmInvocation(args);
  return new Promise<NpmCommandResult>((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, npm_config_loglevel: "silent" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new Error(`npm ${args.join(" ")} timed out after ${timeoutMs}ms.${npmDiagnostics(stdout, stderr)}`);
    const settle = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      result();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settle(() => {
          reject(timeoutError());
        });
      }, npmTerminationGraceMs);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      settle(() => {
        reject(new Error(`npm ${args.join(" ")} could not start: ${error.message}.${npmDiagnostics(stdout, stderr)}`));
      });
    });
    child.once("close", (status, signal) => {
      settle(() => {
        if (timedOut) {
          reject(timeoutError());
          return;
        }
        if (status !== 0) {
          const outcome = status === null ? `terminated by ${signal ?? "an unknown signal"}` : `exited with status ${status}`;
          reject(new Error(`npm ${args.join(" ")} ${outcome}.${npmDiagnostics(stdout, stderr)}`));
          return;
        }
        resolve({ status: 0, stdout, stderr });
      });
    });
  });
}

class TermIgnoringNpmProcess extends EventEmitter implements NpmProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.signals.push(signal);
    return true;
  }
}

class DelayedNpmProcess extends EventEmitter implements NpmProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(delayMs: number) {
    super();
    setTimeout(() => this.emit("close", 0, null), delayMs);
  }

  kill(): boolean {
    return true;
  }
}

function fixtureLifecycleDiagnostic(startedPath: string, initializedPath: string): string {
  return `Fixture lifecycle markers: source-loaded=${existsSync(startedPath)}, initialized=${existsSync(initializedPath)}`;
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

interface StartedInstalledCli {
  readonly stdout: string;
  readonly stderr: string;
  stop(): Promise<void>;
}

async function startInstalledCli(
  entry: string,
  args: readonly string[],
  cwd: string,
  startupMarker = "Miftah HTTP server listening on "
): Promise<StartedInstalledCli> {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let closePromise: Promise<void> | undefined;

  const waitForStartup = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Installed CLI did not report startup.${npmDiagnostics(stdout, stderr)}`));
    }, npmCommandTimeoutMs);
    const settle = (outcome: () => void): void => {
      clearTimeout(timeout);
      outcome();
    };
    const reportStartup = (): void => {
      if (!stdout.includes(startupMarker) && !stderr.includes(startupMarker)) return;
      settle(resolve);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      reportStartup();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      reportStartup();
    });
    child.once("error", (error) => {
      settle(() => reject(new Error(`Installed CLI could not start: ${error.message}.${npmDiagnostics(stdout, stderr)}`)));
    });
    child.once("close", (status, signal) => {
      settle(() => {
        const outcome = status === null ? `terminated by ${signal ?? "an unknown signal"}` : `exited with status ${status}`;
        reject(new Error(`Installed CLI ${outcome} before startup.${npmDiagnostics(stdout, stderr)}`));
      });
    });
  });

  const stop = async (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Installed CLI did not stop after SIGTERM.${npmDiagnostics(stdout, stderr)}`));
      }, npmCommandTimeoutMs);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
    return closePromise;
  };

  await waitForStartup;
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    stop
  };
}

async function loadPackVerifier(): Promise<PackVerifier> {
  // @ts-expect-error The production verifier is intentionally plain Node ESM.
  return import("../scripts/pack-verifier.mjs") as Promise<PackVerifier>;
}

beforeAll(
  async () => {
    const build = await runNpm(["run", "build"]);
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

  it("pins the patched esbuild release for GHSA-g7r4-m6w7-qqqr", () => {
    const manifest = readPackageManifest();
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as PackageLock;

    expect(manifest.overrides?.esbuild).toBe("0.28.1");
    assertPatchedEsbuildLockEntries(lock);
  });

  it("locks the patched fast-uri release for GHSA-v2hh-gcrm-f6hx", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as PackageLock;

    assertPatchedFastUriLockEntries(lock);
  });

  it("rejects stale nested esbuild lock entries", () => {
    const lock: PackageLock = {
      packages: {
        "node_modules/esbuild": { version: "0.28.1" },
        "node_modules/vite/node_modules/esbuild": { version: "0.27.0" }
      }
    };

    expect(() => assertPatchedEsbuildLockEntries(lock)).toThrow(/node_modules\/vite\/node_modules\/esbuild/);
  });

  it("rejects stale nested fast-uri lock entries", () => {
    const lock: PackageLock = {
      packages: {
        "node_modules/fast-uri": { version: "3.1.4" },
        "node_modules/ajv/node_modules/fast-uri": { version: "3.1.3" }
      }
    };

    expect(() => assertPatchedFastUriLockEntries(lock)).toThrow(/node_modules\/ajv\/node_modules\/fast-uri/);
  });
});

describe("packed artifact contract", () => {
  it("requires a locked cache-only consumer install and its own timeout", () => {
    expect(consumerInstallCommand()).toEqual({
      args: [
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline"
      ],
      timeoutMs: 120_000
    });
  });

  it("keeps the test worker responsive while a spawned npm process is pending", async () => {
    let completed = false;
    const child = new DelayedNpmProcess(100);
    const spawnDelayedChild: NpmSpawner = () => child;
    const running = Promise.resolve(
      runNpm(["exec", "--", process.execPath, "--eval", "process.exit(0)"], repositoryRoot, 1_000, spawnDelayedChild)
    ).finally(() => {
      completed = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    await expect(running).resolves.toMatchObject({ status: 0 });
  });

  it("includes captured output when an npm command exits unsuccessfully", async () => {
    const child = new TermIgnoringNpmProcess();
    const spawnFailedChild: NpmSpawner = () => child;
    const failedRun = runNpm(["diagnostic"], repositoryRoot, 1_000, spawnFailedChild);

    child.stdout.end("miftah-diagnostic-out");
    child.stderr.end("miftah-diagnostic-err");
    child.emit("close", 1, null);

    await expect(failedRun).rejects.toThrow(
      /exited with status 1\.\nCaptured npm output:\nstdout:\nmiftah-diagnostic-out\nstderr:\nmiftah-diagnostic-err/u
    );
  });

  it("escalates an npm timeout when its child ignores SIGTERM", async () => {
    const child = new TermIgnoringNpmProcess();
    const spawnTermIgnoringChild: NpmSpawner = () => child;
    const outcome = await Promise.race([
      runNpm(["ignored"], repositoryRoot, 5, spawnTermIgnoringChild).then(
        () => "resolved",
        (error: unknown) => error
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 500))
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("loads its verifier from a shebang-free ESM module", async () => {
    const verifierSource = readFileSync(new URL("../scripts/pack-verifier.mjs", import.meta.url), "utf8");

    expect(verifierSource).not.toMatch(/^#!/u);
    await expect(loadPackVerifier()).resolves.toEqual(
      expect.objectContaining({ parsePackResult: expect.any(Function), verifyPackPaths: expect.any(Function) })
    );
  });

  it("normalizes the list and keyed-object JSON formats emitted by supported npm pack versions", async () => {
    const { parsePackResult } = await loadPackVerifier();
    const result = { filename: "miftah.tgz", files: [{ path: "package.json" }] };

    expect(parsePackResult(JSON.stringify([result]))).toEqual(result);
    expect(parsePackResult(JSON.stringify({ "@lubab/miftah": result }))).toEqual(result);
  });

  it("contains required runtime, documentation, and example files from a real dry run", async () => {
    const packed = await runNpm(["pack", "--dry-run", "--json"]);

    expect(packed.status, packed.stderr).toBe(0);
    const result = (await loadPackVerifier()).parsePackResult(packed.stdout);
    const paths = result.files.map(({ path }) => path);
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

  it("runs the checked package command against the real npm pack output", async () => {
    const checked = await runNpm(["run", "check:pack"]);

    expect(checked.status, checked.stderr || checked.stdout).toBe(0);
    expect(checked.stdout).toMatch(/Package contract verified \(\d+ files\)\./u);
  });

  it(
    "loads the installed entry point and runs the installed binary from a real tarball",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-packed-artifact-"));
      try {
        const packed = await runNpm(["pack", "--json", "--pack-destination", directory]);
        expect(packed.status, packed.stderr).toBe(0);
        const result = (await loadPackVerifier()).parsePackResult(packed.stdout);

        await prepareLockedConsumer(directory, join(directory, result.filename));
        const consumerInstall = consumerInstallCommand();
        const install = await runNpm(consumerInstall.args, directory, consumerInstall.timeoutMs);
        expect(install.status, install.stderr || install.stdout).toBe(0);
        const installedManifest = JSON.parse(
          await readFile(join(directory, "node_modules", "@lubab", "miftah", "package.json"), "utf8")
        ) as PackageManifest;
        expect(installedManifest.dependencies).toEqual(readPackageManifest().dependencies);

        const consumerPath = join(directory, "consumer.mjs");
        const configPath = join(directory, "miftah.json");
        await writeFile(
          configPath,
          JSON.stringify({
            version: "1",
            name: "packed-public-api",
            defaultProfile: "work",
            upstream: { transport: "stdio", command: process.execPath },
            profiles: { work: {} },
            // This package-entrypoint smoke deliberately uses an inert process
            // instead of an external MCP fixture. Resource-subscription
            // capability probing must therefore fail quickly and safely.
            process: { startupTimeoutMs: 250 }
          })
        );
        await writeFile(
          consumerPath,
          [
            'import * as api from "@lubab/miftah";',
            'import * as pluginApi from "@lubab/miftah/plugin-api";',
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
            "    pluginApiVersion: pluginApi.MIFTAH_PLUGIN_API_VERSION,",
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
          pluginApiVersion: "1",
          server: {
            name: "miftah-packed-public-api",
            version: readPackageManifest().version
          }
        });

        const typeConsumerPath = join(directory, "consumer.ts");
        await writeFile(
          typeConsumerPath,
          [
            'import { createMiftahRuntime, CURRENT_CONFIG_VERSION, MIFTAH_VERSION, type ActiveProfileStateScope, type AuditConfig, type AuditIntegrityConfig, type AuditRotationConfig, type ConfigDiagnostic, type GitHubProfileRoutingMatch, type IdentityConfig, type IdentityFingerprint, type IdentityProbeConfig, type JiraProfileRoutingMatch, type LinearProfileRoutingMatch, type MiftahConfig, type MiftahConfigVersion, type MiftahErrorCode, type MiftahErrorDetails, type MiftahRuntime, type PluginConfig, type PluginKind, type PluginsConfig, type PolicyConfig, type PostHogProfileRoutingMatch, type ProcessConfig, type ProfileConfig, type ProfileIsolationConfig, type ProfileIsolationContainerVolume, type ProfileIsolationFile, type ProfileLeaseConfig, type ProfileRoutingConfig, type ProfileRoutingMatchConfig, type ProfileUpstreamOverride, type RiskLevel, type RoutingConfig, type RoutingMatcherPluginConfig, type RoutingRule, type SecurityConfig, type SentryProfileRoutingMatch, type SecretProviderPluginConfig, type StateConfig, type ToolDiscoveryMode, type ToolingConfig, type TransportType, type UnknownToolRisk, type UpstreamConfig, type ValidatedRoutingConfig } from "@lubab/miftah";',
            'import { MIFTAH_PLUGIN_API_VERSION, type MiftahPlugin, type RoutingMatcherPlugin, type RoutingMatcherPluginRequest, type RoutingMatcherPluginResult, type RoutingMatcherPluginSignal, type SecretProviderPlugin, type SecretProviderPluginRequest, type SecretProviderPluginResult } from "@lubab/miftah/plugin-api";',
            "",
            "type SupportedTypes = [",
            "  ActiveProfileStateScope, AuditConfig, AuditIntegrityConfig, AuditRotationConfig, ConfigDiagnostic, GitHubProfileRoutingMatch, IdentityConfig, IdentityFingerprint, IdentityProbeConfig, JiraProfileRoutingMatch, LinearProfileRoutingMatch, MiftahConfig, MiftahConfigVersion,",
            "  MiftahErrorCode, MiftahErrorDetails, MiftahRuntime,",
            "  PluginConfig, PluginKind, PluginsConfig, PolicyConfig, PostHogProfileRoutingMatch, ProcessConfig, ProfileConfig, ProfileIsolationConfig, ProfileIsolationContainerVolume, ProfileIsolationFile, ProfileLeaseConfig, ProfileRoutingConfig, ProfileRoutingMatchConfig, ProfileUpstreamOverride, RiskLevel, RoutingConfig, RoutingMatcherPluginConfig,",
            "  RoutingRule, SecurityConfig, SentryProfileRoutingMatch, SecretProviderPluginConfig, StateConfig, ToolDiscoveryMode, ToolingConfig, TransportType, UnknownToolRisk, UpstreamConfig,",
            "  ValidatedRoutingConfig, MiftahPlugin, RoutingMatcherPlugin, RoutingMatcherPluginRequest, RoutingMatcherPluginResult, RoutingMatcherPluginSignal, SecretProviderPlugin, SecretProviderPluginRequest, SecretProviderPluginResult",
            "];",
            "declare const types: SupportedTypes;",
            'const currentConfigVersion: "3" = CURRENT_CONFIG_VERSION;',
            "const version: string = MIFTAH_VERSION;",
            'const pluginApiVersion: "1" = MIFTAH_PLUGIN_API_VERSION;',
            'const runtime: Promise<MiftahRuntime> = createMiftahRuntime("./miftah.json");',
            'const secretPluginRequest: SecretProviderPluginRequest = { reference: "secretref:consumer-secret://account" };',
            'const secretPluginResult: SecretProviderPluginResult = { value: "consumer-secret" };',
            'const secretPlugin: SecretProviderPlugin = { apiVersion: MIFTAH_PLUGIN_API_VERSION, id: "consumer-secret", kind: "secret-provider", resolve: () => secretPluginResult };',
            'const routingSignal: RoutingMatcherPluginSignal = { provider: "github", kind: "repository", value: "lubab/miftah", source: "argument" };',
            'const routingPluginRequest: RoutingMatcherPluginRequest = { toolName: "github_issue_get", signals: [routingSignal] };',
            'const routingPluginResult: RoutingMatcherPluginResult = { bindings: ["consumer-work"] };',
            'const routingPlugin: RoutingMatcherPlugin = { apiVersion: MIFTAH_PLUGIN_API_VERSION, id: "consumer-routing", kind: "routing-matcher", match: () => routingPluginResult };',
            "const plugin: MiftahPlugin = secretPlugin;",
            'const pluginKind: PluginKind = "routing-matcher";',
            'const secretPluginConfig: SecretProviderPluginConfig = { id: "consumer-secret", kind: "secret-provider", path: "./plugins/secret.mjs" };',
            'const routingPluginConfig: RoutingMatcherPluginConfig = { id: "consumer-routing", kind: "routing-matcher", path: "./plugins/routing.mjs", bindings: { "consumer-work": "work" } };',
            "const pluginConfig: PluginConfig = routingPluginConfig;",
            "const pluginsConfig: PluginsConfig = { allowlist: [secretPluginConfig, routingPluginConfig] };",
            'const globalScope: ActiveProfileStateScope = "global";',
            'const validState: StateConfig = { persistActiveProfile: true, scope: "workspace" };',
            'const auditRotation: AuditRotationConfig = { maxBytes: 1_024, retainFiles: 7 };',
            'const auditIntegrity: AuditIntegrityConfig = { algorithm: "sha256-chain" };',
            'const validSessionState: StateConfig = { scope: "session" };',
            'const validProfileLease: ProfileLeaseConfig = { ttlMs: 60_000, requiredForRisk: ["write"] };',
            'const isolatedFile: ProfileIsolationFile = { source: "credentials/oauth.json", destination: "credentials/oauth.json" };',
            'const isolatedVolume: ProfileIsolationContainerVolume = { source: "credentials/oauth.json", destination: "/run/miftah/oauth.json" };',
            'const isolation: ProfileIsolationConfig = { files: [isolatedFile], containerVolumes: [isolatedVolume] };',
            'const githubMatcher: GitHubProfileRoutingMatch = { repositories: ["acme/miftah"] };',
            'const sentryMatcher: SentryProfileRoutingMatch = { projects: ["acme/api"] };',
            'const jiraMatcher: JiraProfileRoutingMatch = { projects: ["OPS"] };',
            'const linearMatcher: LinearProfileRoutingMatch = { workspaces: ["acme"] };',
            'const posthogMatcher: PostHogProfileRoutingMatch = { projects: ["123"] };',
            'const profileRoutingMatch: ProfileRoutingMatchConfig = { github: githubMatcher, sentry: sentryMatcher, jira: jiraMatcher, linear: linearMatcher, posthog: posthogMatcher };',
            'const profileRouting: ProfileRoutingConfig = { match: profileRoutingMatch };',
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
            "void [types, version, pluginApiVersion, runtime, secretPluginRequest, secretPluginResult, secretPlugin, routingSignal, routingPluginRequest, routingPluginResult, routingPlugin, plugin, pluginKind, secretPluginConfig, routingPluginConfig, pluginConfig, pluginsConfig, globalScope, validState, auditRotation, auditIntegrity, validSessionState, validProfileLease, isolatedFile, isolatedVolume, isolation, invalidDuplicateProfileLease, unknownRisk, invalidState, validTextIdentity, mismatchedTextProviderIdentity, validDestructiveIdentity, validWriteThenDestructiveIdentity, validDestructiveThenWriteIdentity, invalidDuplicateRiskIdentity, invalidTextIdentity, invalidTextOrganization, invalidTextProviderWithoutProbeProvider, invalidJsonStaticProvider, invalidJsonEmptyExpected, invalidJsonProbe];"
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
        const healthyStartedPath = join(directory, "doctor-healthy-started");
        const healthyInitializedPath = join(directory, "doctor-healthy-initialized");
        const healthyConfigPath = await writeDoctorConfig(
          "doctor-healthy.json",
          doctorConfig("packed-doctor-healthy", {
            TEST_START_COUNT_PATH: healthyStartedPath,
            TEST_INITIALIZED_PATH: healthyInitializedPath
          })
        );
        const healthyDoctor = runInstalledBinary(binary, ["doctor", "--config", healthyConfigPath], directory);
        expect(
          healthyDoctor.status,
          [healthyDoctor.stderr || healthyDoctor.stdout, fixtureLifecycleDiagnostic(healthyStartedPath, healthyInitializedPath)]
            .filter(Boolean)
            .join("\n")
        ).toBe(0);
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

        const httpServeConfigPath = await writeCliConfig(
          "http serve config.json",
          cliConfig("packed-cli-http-serve", { work: {} }, [fakeStdioUpstreamFixture], {
            server: { http: { port: 0 } }
          })
        );
        const installedCliEntry = join(directory, "node_modules", "@lubab", "miftah", "dist", "cli", "main.js");
        const httpServe = await startInstalledCli(
          installedCliEntry,
          ["serve", "--transport", "http", "--config", httpServeConfigPath],
          cliContractDirectory
        );
        try {
          expect(httpServe.stdout).toMatch(/^Miftah HTTP server listening on http:\/\/127\.0\.0\.1:\d+\/mcp\n$/u);
          expect(httpServe.stderr).toBe("");
        } finally {
          await httpServe.stop();
        }

        const consoleServe = await startInstalledCli(
          installedCliEntry,
          ["console", "--config", httpServeConfigPath],
          cliContractDirectory,
          "Miftah Console control API listening on "
        );
        try {
          expect(consoleServe.stdout).toMatch(
            /^Miftah Console control API listening on http:\/\/127\.0\.0\.1:\d+\/\nOne-time bootstrap code: [A-Za-z0-9_-]{32,}\nEnter this code only in the local Miftah Console\. It expires after first use or shutdown\.\n$/u
          );
          expect(consoleServe.stderr).toBe("");
        } finally {
          await consoleServe.stop();
        }

        const rootHelp = runInstalledBinary(binary, ["--help"], cliContractDirectory);
        expect(rootHelp.status, rootHelp.stderr || rootHelp.stdout).toBe(0);
        expect(rootHelp.stderr).toBe("");
        expect(rootHelp.stdout).toContain("Usage: miftah [command] [options]");
        const commandOptions = {
          serve: ["--config <file>"],
          console: ["--config <file>", "--port <number>"],
          validate: ["--config <file>"],
          doctor: ["--config <file>", "--json"],
          schema: [],
          init: ["--name <name>", "--preset <name>", "--output <file>"],
          "list-tools": ["--config <file>", "--profile <name>"],
          "test-profile": ["--config <file>", "--profile <name>"],
          logs: ["--config <file>", "--follow"],
          "audit-export": ["--config <file>", "--output <file>", "--include-arguments"],
          "audit-verify": ["--config <file>", "--json"],
          "migrate-config": ["--config <file>", "--write"],
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

        const migrationConfigPath = await writeCliConfig(
          "migration config with spaces.json",
          cliConfig("packed-cli-migration", { work: {} })
        );
        const migrationOriginal = await readFile(migrationConfigPath, "utf8");
        const migrationDryRun = runInstalledBinary(
          binary,
          ["migrate-config", "--config", migrationConfigPath],
          cliContractDirectory
        );
        expect(migrationDryRun.status, migrationDryRun.stderr || migrationDryRun.stdout).toBe(0);
        expect(migrationDryRun.stderr).toBe("");
        expect(JSON.parse(migrationDryRun.stdout)).toMatchObject({
          fromVersion: "1",
          toVersion: "3",
          changed: true,
          write: false,
          backupCreated: false
        });
        expect(await readFile(migrationConfigPath, "utf8")).toBe(migrationOriginal);
        await expect(readFile(`${migrationConfigPath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const migrationWrite = runInstalledBinary(
          binary,
          ["migrate-config", "--config", migrationConfigPath, "--write"],
          cliContractDirectory
        );
        expect(migrationWrite.status, migrationWrite.stderr || migrationWrite.stdout).toBe(0);
        expect(migrationWrite.stderr).toBe("");
        expect(JSON.parse(migrationWrite.stdout)).toMatchObject({ changed: true, write: true, backupCreated: true });
        expect(await readFile(`${migrationConfigPath}.bak`, "utf8")).toBe(migrationOriginal);
        expect(JSON.parse(await readFile(migrationConfigPath, "utf8"))).toMatchObject({ version: "3" });

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

        const gscOutputPath = join(cliContractDirectory, "gsc pilot.json");
        const gscClientSecretsPath = join(cliContractDirectory, "private client secrets.json");
        const initializedGsc = runInstalledBinaryThroughShell(
          binary,
          [
            "init",
            "gsc-pilot",
            "--preset",
            "google-search-console",
            "--oauth-client-secrets-file",
            gscClientSecretsPath,
            "--output",
            gscOutputPath
          ],
          cliContractDirectory
        );
        expect(initializedGsc.status, initializedGsc.stderr || initializedGsc.stdout).toBe(0);
        expect(initializedGsc.stderr).toBe("");
        expect(initializedGsc.stdout).toContain("Credential ownership: upstream");
        expect(initializedGsc.stdout).not.toContain(gscClientSecretsPath);
        expect(JSON.parse(await readFile(gscOutputPath, "utf8"))).toMatchObject({
          name: "gsc-pilot",
          upstream: { command: "uvx", args: ["mcp-search-console@0.3.2"] },
          profiles: {
            default: {
              env: { GSC_OAUTH_CLIENT_SECRETS_FILE: gscClientSecretsPath },
              policy: "readonly"
            }
          }
        });

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

        const exportAuditPath = join(cliContractDirectory, "audit export input with spaces", "events.jsonl");
        const exportOutputPath = join(cliContractDirectory, "audit export output with spaces", "support export.jsonl");
        const exportProfileSecret = "export-profile-secret";
        const exportArgumentSecret = "export-argument-secret";
        await mkdir(dirname(exportAuditPath), { recursive: true });
        await writeFile(
          exportAuditPath,
          `${JSON.stringify({
            message: exportProfileSecret,
            arguments: { token: exportArgumentSecret }
          })}\n`
        );
        const exportConfigPath = await writeCliConfig(
          "audit export config with spaces.json",
          cliConfig(
            "packed-cli-audit-export",
            { work: { env: { EXPORT_SECRET: `secretref:plain://${exportProfileSecret}` } } },
            [fakeStdioUpstreamFixture],
            {
              audit: { path: exportAuditPath },
              secrets: { allowPlaintextSecrets: true }
            }
          )
        );
        const auditExport = runInstalledBinaryThroughShell(
          binary,
          ["audit-export", "--config", exportConfigPath, "--output", exportOutputPath],
          cliContractDirectory
        );
        expect(auditExport.status, auditExport.stderr || auditExport.stdout).toBe(0);
        expect(auditExport.stderr).toBe("");
        expect(JSON.parse(auditExport.stdout)).toEqual({ ok: true });
        const exportedAudit = await readFile(exportOutputPath, "utf8");
        expect(exportedAudit).not.toContain(exportProfileSecret);
        expect(exportedAudit).not.toContain(exportArgumentSecret);
        expect(exportedAudit.trim()).toBe(JSON.stringify({ message: "[REDACTED]" }));

        const unconfiguredAuditVerify = runInstalledBinary(
          binary,
          ["audit-verify", "--config", exportConfigPath, "--json"],
          cliContractDirectory
        );
        expect(unconfiguredAuditVerify.status, unconfiguredAuditVerify.stderr || unconfiguredAuditVerify.stdout).toBe(1);
        expect(unconfiguredAuditVerify.stderr).toBe("");
        expect(JSON.parse(unconfiguredAuditVerify.stdout)).toEqual({
          ok: false,
          firstBroken: {
            segment: basename(exportAuditPath),
            record: 1,
            reason: "INTEGRITY_NOT_CONFIGURED"
          }
        });

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
          "--follow",
          "--include-arguments"
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

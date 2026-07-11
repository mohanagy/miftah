import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface PackageManifest {
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
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCommandTimeoutMs = 25_000;
const requiredPackPaths = [
  "LICENSE",
  "README.md",
  "dist/cli/main.js",
  "dist/index.d.ts",
  "dist/index.js",
  "docs/cli.md",
  "examples/generic.miftah.json",
  "package.json"
] as const;

function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
}

function runNpm(args: readonly string[], cwd = repositoryRoot) {
  const result = spawnSync(npmCommand, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    timeout: npmCommandTimeoutMs,
    killSignal: "SIGTERM",
    shell: process.platform === "win32"
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

        const packageRoot = join(directory, "node_modules", "@lubab", "miftah");
        const entryPoint = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
        expect(entryPoint.validateConfig).toBeTypeOf("function");

        const binary = join(directory, "node_modules", ".bin", process.platform === "win32" ? "miftah.cmd" : "miftah");
        const schema = spawnSync(binary, ["schema"], {
          cwd: directory,
          encoding: "utf8",
          shell: process.platform === "win32",
          timeout: npmCommandTimeoutMs
        });
        expect(schema.status, schema.stderr || schema.stdout).toBe(0);
        expect(JSON.parse(schema.stdout)).toMatchObject({
          $schema: "https://json-schema.org/draft/2019-09/schema#"
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );
});

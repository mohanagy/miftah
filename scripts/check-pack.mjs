#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_PATHS = [
  "LICENSE",
  "README.md",
  "dist/cli/main.js",
  "dist/index.d.ts",
  "dist/index.js",
  "docs/cli.md",
  "examples/generic.miftah.json",
  "package.json"
];

const ALLOWED_ROOT_PATHS = new Set(["LICENSE", "README.md", "package.json"]);
const ALLOWED_PATH_PATTERNS = [
  /^dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:d\.ts|d\.ts\.map|js|js\.map)$/u,
  /^docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/u,
  /^examples\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.miftah\.json$/u
];

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));

function formatPaths(paths) {
  return paths.map((path) => `  - ${path}`).join("\n");
}

function isAllowedPath(path) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) {
    return false;
  }
  return ALLOWED_ROOT_PATHS.has(path) || ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function verifyPackPaths(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("Package paths must be an array of strings.");
  }

  const duplicates = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))].sort();
  const unexpected = paths.filter((path) => !isAllowedPath(path)).sort();
  const missing = REQUIRED_PATHS.filter((path) => !paths.includes(path));
  const problems = [];

  if (duplicates.length > 0) {
    problems.push(`duplicate package paths:\n${formatPaths(duplicates)}`);
  }
  if (unexpected.length > 0) {
    problems.push(`unexpected package paths:\n${formatPaths(unexpected)}`);
  }
  if (missing.length > 0) {
    problems.push(`missing required package paths:\n${formatPaths(missing)}`);
  }

  if (problems.length > 0) {
    throw new Error(`Package contract verification failed:\n${problems.join("\n")}`);
  }

  return [...paths];
}

export function parsePackOutput(output) {
  let results;
  try {
    results = JSON.parse(output);
  } catch (error) {
    throw new Error("npm pack returned invalid JSON.", { cause: error });
  }

  if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(results[0]?.files)) {
    throw new Error("npm pack must return exactly one package with a files array.");
  }

  return results[0].files.map((file) => {
    if (typeof file?.path !== "string") {
      throw new Error("npm pack returned a file entry without a string path.");
    }
    return file.path;
  });
}

export function checkPack() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    maxBuffer: 10 * 1024 * 1024
  });

  if (packed.error) {
    throw new Error(`Unable to run npm pack: ${packed.error.message}`, { cause: packed.error });
  }
  if (packed.status !== 0) {
    const detail = packed.stderr.trim() || packed.stdout.trim() || `exit status ${packed.status}`;
    throw new Error(`npm pack failed: ${detail}`);
  }

  return verifyPackPaths(parsePackOutput(packed.stdout));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const paths = checkPack();
    process.stdout.write(`Package contract verified (${paths.length} files).\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check:pack failed: ${message}\n`);
    process.exitCode = 1;
  }
}

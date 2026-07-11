#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parsePackOutput, verifyPackPaths } from "./pack-verifier.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));
const npmCliPath = process.env.npm_execpath;

function npmInvocation(args) {
  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, ...args] };
  }
  if (process.platform === "win32") {
    throw new Error("npm_execpath is required to invoke npm safely on Windows. Run this command through npm.");
  }
  return { command: "npm", args };
}

/**
 * Runs a real npm pack dry run from the repository root and verifies every reported path.
 *
 * @returns {string[]} verified package-relative paths
 * @throws {Error} when npm cannot run, packing fails, or the package contract is violated
 */
export function checkPack() {
  const invocation = npmInvocation(["pack", "--dry-run", "--json"]);
  const packed = spawnSync(invocation.command, invocation.args, {
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

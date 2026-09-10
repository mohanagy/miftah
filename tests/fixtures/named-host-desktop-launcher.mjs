import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const [outputRoot, nodeExecutable, recorderPath, miftahCliPath, fakeUpstreamPath] =
  process.argv.slice(2);

if (
  outputRoot === undefined ||
  nodeExecutable === undefined ||
  recorderPath === undefined ||
  miftahCliPath === undefined ||
  fakeUpstreamPath === undefined
) {
  throw new Error(
    "Usage: node named-host-desktop-launcher.mjs <output-root> <node> <recorder> <miftah-cli> <fake-upstream>"
  );
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const instanceDirectory = await mkdtemp(join(outputRoot, "instance-"));
await chmod(instanceDirectory, 0o700);

const recordPath = join(instanceDirectory, "record.json");
const configPath = join(instanceDirectory, "miftah.json");
const auditPath = join(instanceDirectory, "audit.jsonl");
const initializedPath = join(instanceDirectory, "upstream-initialized");
const listToolsPath = join(instanceDirectory, "tool-list-count");
const callToolPath = join(instanceDirectory, "tool-call-count");
const shutdownPath = join(instanceDirectory, "upstream-shutdown");
const startCountPath = join(instanceDirectory, "upstream-start-count");
const xdgConfigHome = join(instanceDirectory, "xdg-config");
const xdgCacheHome = join(instanceDirectory, "xdg-cache");
const xdgDataHome = join(instanceDirectory, "xdg-data");
const xdgStateHome = join(instanceDirectory, "xdg-state");
const xdgRuntimeDir = join(instanceDirectory, "xdg-runtime");

await Promise.all(
  [xdgConfigHome, xdgCacheHome, xdgDataHome, xdgStateHome, xdgRuntimeDir].map(
    async (directory) => mkdir(directory, { mode: 0o700 })
  )
);

const childEnvironment = {
  HOME: instanceDirectory,
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_CACHE_HOME: xdgCacheHome,
  XDG_DATA_HOME: xdgDataHome,
  XDG_STATE_HOME: xdgStateHome,
  XDG_RUNTIME_DIR: xdgRuntimeDir
};
for (const key of [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT"
]) {
  if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
}

const config = {
  version: "1",
  name: "desktop-evidence-425",
  defaultProfile: "work",
  upstream: {
    transport: "stdio",
    command: nodeExecutable,
    args: [fakeUpstreamPath]
  },
  profiles: {
    work: {
      env: {
        TEST_ACCOUNT_NAME: "desktop-evidence-fixture",
        TEST_INITIALIZED_PATH: initializedPath,
        TEST_LIST_TOOLS_COUNT_PATH: listToolsPath,
        TEST_CALL_TOOL_COUNT_PATH: callToolPath,
        TEST_SHUTDOWN_END_PATH: shutdownPath,
        TEST_START_COUNT_PATH: startCountPath
      }
    }
  },
  audit: { path: auditPath },
  process: {
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
    maxConcurrentProfiles: 1
  }
};

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const child = spawn(
  nodeExecutable,
  [recorderPath, recordPath, nodeExecutable, miftahCliPath, "--config", configPath],
  { env: childEnvironment, stdio: "inherit" }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

const childResult = await new Promise((resolveResult) => {
  child.once("error", (error) =>
    resolveResult({ exitCode: null, signal: null, spawnError: error.code ?? "UNKNOWN" })
  );
  child.once("close", (exitCode, signal) =>
    resolveResult({ exitCode, signal, spawnError: null })
  );
});

if (childResult.spawnError !== null) {
  process.stderr.write(`named-host desktop launcher failed: ${childResult.spawnError}\n`);
}
process.exitCode = childResult.exitCode ?? 1;

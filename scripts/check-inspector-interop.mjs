import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const inspectorPackage = "@modelcontextprotocol/inspector@2.1.0";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout
  });
  if (result.error !== undefined || result.status !== 0) {
    const diagnostic = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed: ${diagnostic}`);
  }
  return result.stdout;
}

function assertToolList(output, transport) {
  if (!output.includes("whoami") || !output.includes("miftah_current_profile")) {
    throw new Error(`Inspector ${transport} tools/list did not expose the packaged Miftah tools: ${output}`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function startHttpServer(cliEntry, configPath, cwd) {
  const child = spawn(process.execPath, [cliEntry, "serve", "--transport", "http", "--config", configPath], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for packaged Miftah HTTP startup: ${stderr || stdout}`));
    }, 30_000);
    const inspect = () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/u);
      if (match === null) return;
      clearTimeout(timeout);
      resolve(match[0]);
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Packaged Miftah HTTP server exited with ${String(code)}: ${stderr || stdout}`));
    });
  });

  return {
    endpoint,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  };
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "miftah-inspector-interop-"));
try {
  const packOutput = run(npmCommand, ["pack", "--json", "--pack-destination", temporaryDirectory], repositoryRoot);
  const parsedPackOutput = JSON.parse(packOutput);
  const packResult = Array.isArray(parsedPackOutput)
    ? parsedPackOutput[0]
    : parsedPackOutput.filename === undefined
      ? Object.values(parsedPackOutput)[0]
      : parsedPackOutput;
  const { filename } = packResult ?? {};
  if (typeof filename !== "string") throw new Error("npm pack did not return a package filename.");

  const consumer = join(temporaryDirectory, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }), "utf8");
  run(
    npmCommand,
    ["install", "--no-audit", "--no-fund", "--package-lock=false", join(temporaryDirectory, filename)],
    consumer
  );

  const configPath = join(consumer, "miftah.json");
  const auditPath = join(consumer, "audit.jsonl");
  await writeFile(configPath, JSON.stringify({
    version: "1",
    name: "packaged-inspector",
    defaultProfile: "work",
    upstream: {
      transport: "stdio",
      command: process.execPath,
      args: [join(repositoryRoot, "tests", "fixtures", "fake-upstream.mjs")]
    },
    profiles: { work: {} },
    audit: { path: auditPath },
    process: { startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000 },
    server: { http: { port: 0 } }
  }), "utf8");

  const cliEntry = join(consumer, "node_modules", "@lubab", "miftah", "dist", "cli", "main.js");
  const stdioLauncher = join(consumer, "start-miftah-stdio.sh");
  await writeFile(stdioLauncher, [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} serve --transport stdio --config ${shellQuote(configPath)}`
  ].join("\n"), "utf8");
  const stdioOutput = run(npxCommand, [
    "--yes",
    inspectorPackage,
    "--cli",
    "/bin/sh",
    stdioLauncher,
    "--method",
    "tools/list"
  ], consumer);
  assertToolList(stdioOutput, "STDIO");

  const httpServer = await startHttpServer(cliEntry, configPath, consumer);
  try {
    const httpOutput = run(npxCommand, [
      "--yes",
      inspectorPackage,
      "--cli",
      httpServer.endpoint,
      "--transport", "http",
      "--method", "tools/list"
    ], consumer);
    assertToolList(httpOutput, "Streamable HTTP");
  } finally {
    await httpServer.close();
  }

  const audit = await readFile(auditPath, "utf8");
  if (!audit.includes('"operation":"tools/list"') || audit.includes("requestState")) {
    throw new Error("Packaged Inspector audit evidence is missing or contains continuation state.");
  }
  process.stdout.write(`Packaged MCP Inspector ${inspectorPackage.split("@").at(-1)} interoperability passed.\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

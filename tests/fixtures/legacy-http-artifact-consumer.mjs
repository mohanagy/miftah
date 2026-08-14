import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const upstreamFixture = process.argv[2];
if (upstreamFixture === undefined) {
  throw new Error("Usage: node legacy-http-artifact-consumer.mjs <fake-upstream-path>");
}

const waitFor = async (condition, description, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(10);
  }
};

const pathExists = (path) => access(path).then(() => true, () => false);

const readTextResult = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("Expected one text tool result.");
  return text;
};

const countLines = async (path) => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length;

const readAuditEvents = async (path) => {
  const audit = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return audit
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const readToolCallOperations = async (path) =>
  (await readAuditEvents(path)).filter((event) => event.kind === "operation" && event.operation === "tools/call");

const resolveInstalledCliEntry = async () => {
  let packageDirectory = dirname(fileURLToPath(import.meta.resolve("@lubab/miftah")));
  for (;;) {
    const manifestPath = join(packageDirectory, "package.json");
    const manifest = await readFile(manifestPath, "utf8").then(JSON.parse, (error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (manifest?.name === "@lubab/miftah") {
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.miftah;
      if (typeof bin !== "string") throw new Error("Installed Miftah package does not declare bin.miftah.");
      const cliEntry = resolve(packageDirectory, bin);
      if (!(await pathExists(cliEntry))) throw new Error("Installed Miftah bin.miftah entry does not exist.");
      return cliEntry;
    }
    const parent = dirname(packageDirectory);
    if (parent === packageDirectory) throw new Error("Could not locate the installed Miftah package manifest.");
    packageDirectory = parent;
  }
};

const startInstalledHttpCli = async (cliEntry, configPath, cwd) => {
  const child = spawn(
    process.execPath,
    [cliEntry, "serve", "--transport", "http", "--config", configPath],
    { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  let closePromise;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Installed Miftah HTTP CLI exited before startup: ${stderr || stdout || "no output"}`);
    }
    return Promise.resolve(/Miftah HTTP server listening on http:\/\/127\.0\.0\.1:\d+\/mcp\n/u.test(stdout));
  }, "the installed Miftah HTTP CLI to report its endpoint");

  const endpoint = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/u)?.[0];
  if (endpoint === undefined) throw new Error(`Installed Miftah HTTP CLI did not report its endpoint: ${stdout}`);

  return {
    endpoint,
    get stderr() {
      return stderr;
    },
    async stop() {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise((resolveStop, rejectStop) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveStop();
          return;
        }
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          rejectStop(new Error(`Installed Miftah HTTP CLI did not stop after SIGTERM: ${stderr || stdout || "no output"}`));
        }, 10_000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolveStop();
        });
        child.kill("SIGTERM");
      });
      return closePromise;
    }
  };
};

const directory = await mkdtemp(join(tmpdir(), "miftah-legacy-http-artifact-"));
const configPath = join(directory, "miftah.json");
const auditPath = join(directory, "audit.jsonl");
const createCountPath = join(directory, "create-count");
const callStartedPath = join(directory, "call-started");
const cancelledPath = join(directory, "cancelled");
const workShutdownPath = join(directory, "work-shutdown");
const sensitiveArgument = "packaged-legacy-http-sensitive-name";

let client;
let transport;
let httpCli;

try {
  await mkdir(directory, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: "1",
    name: "packed-legacy-http-evidence",
    defaultProfile: "work",
    upstream: { transport: "stdio", command: process.execPath, args: [upstreamFixture] },
    profiles: {
      work: {
        policy: "confirm",
        env: {
          TEST_ACCOUNT_NAME: "work",
          TEST_CREATE_ITEM_COUNT_PATH: createCountPath,
          TEST_CALL_TOOL_STARTED_PATH: callStartedPath,
          TEST_CALL_TOOL_DELAY_MS: "500",
          TEST_CANCELLED_PATH: cancelledPath,
          TEST_SHUTDOWN_END_PATH: workShutdownPath
        }
      }
    },
    policies: { confirm: { requireConfirmation: ["create_item"] } },
    audit: { path: auditPath },
    process: { startupTimeoutMs: 5_000, shutdownTimeoutMs: 5_000 },
    server: { http: { port: 0 } }
  }));

  const cliEntry = await resolveInstalledCliEntry();
  httpCli = await startInstalledHttpCli(cliEntry, configPath, directory);
  transport = new StreamableHTTPClientTransport(new URL(httpCli.endpoint));
  client = new Client(
    { name: "packed-legacy-http-evidence-client", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  const elicitationRequests = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    elicitationRequests.push(request);
    return { action: "accept", content: { approved: true } };
  });

  await client.connect(transport);
  if (client.getNegotiatedProtocolVersion() !== "2025-11-25") {
    throw new Error(`Expected legacy protocol 2025-11-25, got ${String(client.getNegotiatedProtocolVersion())}.`);
  }
  const mcpSessionId = transport.sessionId;
  if (typeof mcpSessionId !== "string" || mcpSessionId.length === 0) {
    throw new Error("Installed legacy HTTP server did not assign an Mcp-Session-Id.");
  }

  const created = readTextResult(await client.callTool({
    name: "create_item",
    arguments: { name: sensitiveArgument }
  }));
  if (created !== `created:${sensitiveArgument}`) throw new Error(`Unexpected create_item result: ${created}`);
  await waitFor(() => pathExists(createCountPath), "the approved upstream tool execution");
  const approvalTerminalAudit = (await readToolCallOperations(auditPath)).at(-1);
  if (approvalTerminalAudit?.status !== "success") {
    throw new Error(`Expected a successful terminal approval audit event: ${JSON.stringify(approvalTerminalAudit)}`);
  }

  await rm(callStartedPath, { force: true });
  const toolCallsBeforeCancellation = (await readToolCallOperations(auditPath)).length;
  const controller = new globalThis.AbortController();
  const pending = client.callTool({ name: "whoami", arguments: {} }, { signal: controller.signal });
  await waitFor(() => pathExists(callStartedPath), "the cancellable upstream tool call");
  controller.abort("packaged legacy HTTP cancellation evidence");
  let cancellationRejected = false;
  try {
    await pending;
  } catch {
    cancellationRejected = true;
  }
  if (!cancellationRejected) throw new Error("The cancelled legacy HTTP tool call unexpectedly completed.");
  await waitFor(
    async () => (await readToolCallOperations(auditPath)).length > toolCallsBeforeCancellation,
    "the terminal cancellation audit event"
  );
  await waitFor(
    async () => (await pathExists(cancelledPath)) && await countLines(cancelledPath) === 1,
    "one upstream cancellation notification"
  );

  await client.close();
  client = undefined;
  transport = undefined;
  await waitFor(() => pathExists(workShutdownPath), "the retained work upstream shutdown after HTTP session close");
  await httpCli.stop();

  const auditEvents = await readAuditEvents(auditPath);
  const toolCallOperations = auditEvents.filter(
    (event) => event.kind === "operation" && event.operation === "tools/call"
  );
  const cancelledOperations = toolCallOperations.filter((event) => event.status === "cancelled");
  const approvalActions = auditEvents
    .filter((event) => event.kind === "approval")
    .map((event) => event.approvalAction);
  const serializedElicitations = JSON.stringify(elicitationRequests);
  const serializedAudit = JSON.stringify(auditEvents);

  process.stdout.write(JSON.stringify({
    protocol: "2025-11-25",
    session: { mcpSessionIdAssigned: true, closed: true },
    approval: {
      elicitationCount: elicitationRequests.length,
      actions: approvalActions,
      toolExecutions: await countLines(createCountPath),
      terminalAuditStatus: approvalTerminalAudit.status,
      terminalAuditErrorCode: approvalTerminalAudit.errorCode ?? null,
      sensitiveArgumentRedacted:
        !serializedElicitations.includes(sensitiveArgument) && !serializedAudit.includes(sensitiveArgument)
    },
    cancellation: {
      downstreamRejected: cancellationRejected,
      upstreamNotifications: await countLines(cancelledPath),
      terminalAuditEvents: cancelledOperations.length,
      lastAuditStatus: toolCallOperations.at(-1)?.status ?? null,
      lastAuditErrorCode: toolCallOperations.at(-1)?.errorCode ?? null
    },
    cleanup: { work: await pathExists(workShutdownPath) },
    stderrEmpty: httpCli.stderr === ""
  }));
  httpCli = undefined;
} finally {
  await Promise.allSettled([client?.close(), transport?.close(), httpCli?.stop()]);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

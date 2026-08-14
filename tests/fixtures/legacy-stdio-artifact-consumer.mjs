import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const upstreamFixture = process.argv[2];
if (upstreamFixture === undefined) {
  throw new Error("Usage: node legacy-stdio-artifact-consumer.mjs <fake-upstream-path>");
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

const readToolCallOperations = async (path) => {
  const audit = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return audit
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === "operation" && event.operation === "tools/call");
};

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

const directory = await mkdtemp(join(tmpdir(), "miftah-legacy-stdio-artifact-"));
const matchingRootPath = join(directory, "matching-root");
const changedRootPath = join(directory, "changed-root");
const matchingRoot = pathToFileURL(matchingRootPath).toString();
const changedRoot = pathToFileURL(changedRootPath).toString();
const configPath = join(directory, "miftah.json");
const auditPath = join(directory, "audit.jsonl");
const subscribePath = join(directory, "subscribe-count");
const unsubscribePath = join(directory, "unsubscribe-count");
const callStartedPath = join(directory, "call-started");
const cancelledPath = join(directory, "cancelled");
const personalShutdownPath = join(directory, "personal-shutdown");
const workShutdownPath = join(directory, "work-shutdown");

let client;
let transport;
let stderr = "";

try {
  await Promise.all([mkdir(matchingRootPath), mkdir(changedRootPath)]);
  await writeFile(configPath, JSON.stringify({
    version: "1",
    name: "packed-legacy-stdio-evidence",
    defaultProfile: "work",
    upstream: { transport: "stdio", command: process.execPath, args: [upstreamFixture] },
    profiles: {
      personal: {
        env: {
          TEST_ACCOUNT_NAME: "personal",
          TEST_RESOURCE_SUBSCRIPTIONS: "true",
          TEST_RESOURCE_UPDATE_URI: "account://current",
          TEST_SUBSCRIBE_COUNT_PATH: subscribePath,
          TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribePath,
          TEST_NOTIFY_LIST_CHANGES_ON_CALL_TOOL: "true",
          TEST_SHUTDOWN_END_PATH: personalShutdownPath
        }
      },
      work: {
        env: {
          TEST_ACCOUNT_NAME: "work",
          TEST_RESOURCE_SUBSCRIPTIONS: "true",
          TEST_CALL_TOOL_STARTED_PATH: callStartedPath,
          TEST_CALL_TOOL_DELAY_MS: "500",
          TEST_CANCELLED_PATH: cancelledPath,
          TEST_SHUTDOWN_END_PATH: workShutdownPath
        }
      }
    },
    routing: {
      rules: [{
        name: "matching-root",
        when: { "context.fileRoots": matchingRoot },
        profile: "personal"
      }]
    },
    audit: { path: auditPath },
    process: { startupTimeoutMs: 5_000, shutdownTimeoutMs: 5_000 }
  }));

  const cliEntry = await resolveInstalledCliEntry();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, "serve", "--transport", "stdio", "--config", configPath],
    cwd: directory,
    stderr: "pipe"
  });
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  client = new Client(
    { name: "packed-legacy-stdio-evidence-client", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } }
  );
  let currentRoot = matchingRoot;
  let rootRequests = 0;
  const resourceUpdates = [];
  const listChanges = { tools: 0, resources: 0, prompts: 0 };
  client.setRequestHandler("roots/list", async () => {
    rootRequests += 1;
    return { roots: [{ uri: currentRoot }] };
  });
  client.setNotificationHandler("notifications/resources/updated", (notification) => {
    resourceUpdates.push(notification.params.uri);
  });
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    listChanges.tools += 1;
  });
  client.setNotificationHandler("notifications/resources/list_changed", () => {
    listChanges.resources += 1;
  });
  client.setNotificationHandler("notifications/prompts/list_changed", () => {
    listChanges.prompts += 1;
  });

  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Installed Miftah STDIO process did not connect: ${stderr || "no stderr"}`, { cause: error });
  }

  if (client.getNegotiatedProtocolVersion() !== "2025-11-25") {
    throw new Error(`Expected legacy protocol 2025-11-25, got ${String(client.getNegotiatedProtocolVersion())}.`);
  }
  const serverCapabilities = client.getServerCapabilities();
  const subscriptionsAdvertised = serverCapabilities?.resources?.subscribe === true;
  if (!subscriptionsAdvertised) {
    throw new Error("Installed legacy server did not advertise resource subscriptions.");
  }
  const listChangesAdvertised =
    serverCapabilities.tools?.listChanged === true &&
    serverCapabilities.resources?.listChanged === true &&
    serverCapabilities.prompts?.listChanged === true;
  if (!listChangesAdvertised) {
    throw new Error(`Installed legacy server did not advertise list changes: ${JSON.stringify(serverCapabilities)}.`);
  }

  const initialProfile = readTextResult(await client.callTool({ name: "whoami", arguments: {} }));
  if (initialProfile !== "personal" || rootRequests !== 1) {
    throw new Error(`Roots initialization did not select personal exactly once: profile=${initialProfile}, requests=${rootRequests}.`);
  }

  const resource = (await client.listResources()).resources.find((candidate) => candidate.uri === "account://current");
  if (resource === undefined) throw new Error("Installed legacy server did not expose account://current.");
  await client.subscribeResource({ uri: resource.uri });
  await waitFor(() => pathExists(subscribePath), "the upstream subscription marker");
  await waitFor(() => Promise.resolve(resourceUpdates.includes(resource.uri)), "the namespaced resource update");
  await client.unsubscribeResource({ uri: resource.uri });
  await waitFor(() => pathExists(unsubscribePath), "the upstream unsubscription marker");

  const echoed = readTextResult(await client.callTool({ name: "echo", arguments: { message: "packaged-list-change" } }));
  if (echoed !== "packaged-list-change") throw new Error(`Unexpected echo result: ${echoed}`);
  // The fake upstream awaits all three notification sends before returning this tools/call response,
  // so the successful response is the positive completion barrier for the zero downstream counts.

  currentRoot = changedRoot;
  await client.notification({ method: "notifications/roots/list_changed" });
  await waitFor(() => Promise.resolve(rootRequests === 2), "the refreshed Roots request");
  const refreshedProfile = readTextResult(await client.callTool({ name: "whoami", arguments: {} }));
  if (refreshedProfile !== "work") {
    throw new Error(`Roots refresh did not return to the work profile: ${refreshedProfile}`);
  }

  const toolCallsBeforeCancellation = (await readToolCallOperations(auditPath)).length;
  const controller = new globalThis.AbortController();
  const pending = client.callTool({ name: "whoami", arguments: {} }, { signal: controller.signal });
  await waitFor(() => pathExists(callStartedPath), "the cancellable upstream tool call");
  controller.abort("packaged legacy cancellation evidence");
  let cancellationRejected = false;
  try {
    await pending;
  } catch {
    cancellationRejected = true;
  }
  if (!cancellationRejected) throw new Error("The cancelled legacy tool call unexpectedly completed.");
  await waitFor(
    async () => (await readToolCallOperations(auditPath)).length > toolCallsBeforeCancellation,
    "the terminal cancellation audit event"
  );

  await client.close();
  client = undefined;
  transport = undefined;
  await waitFor(() => pathExists(personalShutdownPath), "personal upstream shutdown");
  await waitFor(() => pathExists(workShutdownPath), "work upstream shutdown");
  const cleanup = {
    personal: await pathExists(personalShutdownPath),
    work: await pathExists(workShutdownPath)
  };

  const toolCallOperations = await readToolCallOperations(auditPath);
  const cancelledOperations = toolCallOperations.filter((event) => event.status === "cancelled");

  process.stdout.write(JSON.stringify({
    protocol: "2025-11-25",
    roots: { initialized: initialProfile, refreshed: refreshedProfile, requests: rootRequests },
    subscriptions: {
      advertised: subscriptionsAdvertised,
      updateForwarded: resourceUpdates.includes(resource.uri),
      subscribeCount: await countLines(subscribePath),
      unsubscribeCount: await countLines(unsubscribePath)
    },
    listChanges: {
      advertised: listChangesAdvertised,
      tools: listChanges.tools > 0,
      resources: listChanges.resources > 0,
      prompts: listChanges.prompts > 0
    },
    cancellation: {
      downstreamRejected: cancellationRejected,
      upstreamNotifications: await pathExists(cancelledPath) ? await countLines(cancelledPath) : 0,
      terminalAuditEvents: cancelledOperations.length,
      lastAuditStatus: toolCallOperations.at(-1)?.status ?? null,
      lastAuditErrorCode: toolCallOperations.at(-1)?.errorCode ?? null
    },
    cleanup,
    stderrEmpty: stderr === ""
  }));
} finally {
  await Promise.allSettled([client?.close(), transport?.close()]);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

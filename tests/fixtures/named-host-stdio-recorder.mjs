import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const [outputPath, command, ...args] = process.argv.slice(2);
if (outputPath === undefined || command === undefined) {
  throw new Error(
    "Usage: node named-host-stdio-recorder.mjs <output-path> <command> [...args]"
  );
}

const requestMethods = new Map();
const requestProtocols = new Map();
const maxPendingRequests = 1_024;
const maxParseBufferBytes = 1024 * 1024;
const protocolVersionMetaKey = "io.modelcontextprotocol/protocolVersion";
const clientInfoMetaKey = "io.modelcontextprotocol/clientInfo";
const serverInfoMetaKey = "io.modelcontextprotocol/serverInfo";
const observations = {
  era: null,
  client: null,
  server: null,
  supportedVersions: [],
  initializedNotification: false,
  operations: {},
  process: null
};
const buffers = { client: Buffer.alloc(0), server: Buffer.alloc(0) };

const requestKey = (id) => JSON.stringify(id);

const safeImplementation = (value) => ({
  name: typeof value?.name === "string" ? value.name : null,
  version: typeof value?.version === "string" ? value.version : null
});

const hasImplementationMetadata = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (typeof value.name === "string" || typeof value.version === "string");

const makeRoomForRequest = (key) => {
  if (requestMethods.has(key) || requestMethods.size < maxPendingRequests) return;
  const oldestKey = requestMethods.keys().next().value;
  requestMethods.delete(oldestKey);
  requestProtocols.delete(oldestKey);
};

const incrementOperation = (method, status) => {
  const current = observations.operations[method] ?? { requests: 0, success: 0, error: 0 };
  current[status] += 1;
  observations.operations[method] = current;
};

const recordClientMessage = (message) => {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  if (typeof message.method !== "string") return;

  if (message.id !== undefined) {
    const key = requestKey(message.id);
    makeRoomForRequest(key);
    requestMethods.set(key, message.method);
    if (["server/discover", "tools/list", "tools/call", "prompts/list", "resources/list"].includes(message.method)) {
      incrementOperation(message.method, "requests");
    }
  }

  const envelope = message.params?._meta;
  const envelopeProtocol = envelope?.[protocolVersionMetaKey];
  if (typeof envelopeProtocol === "string") {
    observations.era = "modern";
    if (message.id !== undefined) requestProtocols.set(requestKey(message.id), envelopeProtocol);
    if (observations.client === null) {
      observations.client = {
        ...safeImplementation(envelope?.[clientInfoMetaKey]),
        requestedProtocol: envelopeProtocol
      };
    }
  }

  if (message.method === "initialize") {
    observations.era = "initialized";
    observations.client = {
      ...safeImplementation(message.params?.clientInfo),
      requestedProtocol:
        typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : null
    };
  } else if (message.method === "notifications/initialized") {
    observations.initializedNotification = true;
  }
};

const recordServerMessage = (message) => {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  if (message.id === undefined) return;

  const method = requestMethods.get(requestKey(message.id));
  if (method === undefined) return;
  requestMethods.delete(requestKey(message.id));
  const requestProtocol = requestProtocols.get(requestKey(message.id));
  requestProtocols.delete(requestKey(message.id));

  if (["server/discover", "tools/list", "tools/call", "prompts/list", "resources/list"].includes(method)) {
    incrementOperation(method, message.error === undefined ? "success" : "error");
  }

  if (method === "initialize" && message.result !== undefined) {
    observations.server = {
      ...safeImplementation(message.result.serverInfo),
      negotiatedProtocol:
        typeof message.result.protocolVersion === "string" ? message.result.protocolVersion : null
    };
  } else if (message.result !== undefined && typeof requestProtocol === "string") {
    const serverInfo = message.result?._meta?.[serverInfoMetaKey];
    if (hasImplementationMetadata(serverInfo)) {
      observations.server = {
        ...safeImplementation(serverInfo),
        negotiatedProtocol: requestProtocol
      };
    }
    if (method === "server/discover" && Array.isArray(message.result.supportedVersions)) {
      observations.supportedVersions = message.result.supportedVersions.filter(
        (version) => typeof version === "string"
      );
    }
  }
};

const recordLines = (direction, chunk, recordMessage) => {
  if (chunk.length > maxParseBufferBytes || buffers[direction].length + chunk.length > maxParseBufferBytes) {
    buffers[direction] = Buffer.alloc(0);
    return;
  }
  buffers[direction] =
    buffers[direction].length === 0
      ? chunk
      : Buffer.concat([buffers[direction], chunk], buffers[direction].length + chunk.length);
  for (;;) {
    const newline = buffers[direction].indexOf(0x0a);
    if (newline === -1) return;
    const line = buffers[direction].subarray(0, newline).toString("utf8").trim();
    buffers[direction] = buffers[direction].subarray(newline + 1);
    if (line === "") continue;
    try {
      recordMessage(JSON.parse(line));
    } catch {
      // Preserve the byte stream for the real client and server, but never persist unparsed content.
    }
  }
};

const child = spawn(command, args, {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

process.stdin.on("data", (chunk) => recordLines("client", chunk, recordClientMessage));
process.stdin.pipe(child.stdin);
child.stdout.on("data", (chunk) => {
  recordLines("server", chunk, recordServerMessage);
  process.stdout.write(chunk);
});
child.stderr.pipe(process.stderr);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const childResult = await new Promise((resolveResult) => {
  child.once("error", (error) => resolveResult({ exitCode: null, signal: null, spawnError: error.code ?? "UNKNOWN" }));
  child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal, spawnError: null }));
});

observations.process = childResult;
await writeFile(outputPath, `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
process.exitCode = childResult.exitCode ?? 1;

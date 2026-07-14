import { Buffer } from "node:buffer";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAXIMUM_REQUEST_BYTES = 16 * 1024;
const MAXIMUM_SECRET_VALUE_BYTES = 48 * 1024;
const MAXIMUM_ROUTING_SIGNALS = 64;
const MAXIMUM_ROUTING_BINDINGS = 64;
const pluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const bindingPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const sourceValues = new Set(["argument", "context", "url"]);
const signalKinds = {
  github: new Set(["repository", "organization"]),
  sentry: new Set(["organization", "project", "environment"]),
  jira: new Set(["site", "project"]),
  linear: new Set(["workspace", "team"]),
  posthog: new Set(["host", "project"])
};

async function main() {
  const pluginPath = process.argv[2];
  if (process.argv.length !== 3 || typeof pluginPath !== "string" || pluginPath.length === 0) return fail();
  const request = await readRequest();
  if (!isRecord(request) || typeof request.operation !== "string") return fail();

  const module = await import(pathToFileURL(pluginPath).href);
  const plugin = module.default;
  const manifest = inspectManifest(plugin);
  if (manifest === undefined) return fail();

  if (request.operation === "manifest") {
    writeResponse({ manifest });
    return;
  }
  if (request.operation === "secret") {
    if (manifest.kind !== "secret-provider" || !isSecretRequest(request)) return fail();
    const result = await plugin.resolve(Object.freeze({ reference: request.reference }));
    if (!isSecretResult(result)) return fail();
    writeResponse({ result: { value: result.value } });
    return;
  }
  if (request.operation === "routing") {
    if (manifest.kind !== "routing-matcher" || !isRoutingRequest(request)) return fail();
    const result = await plugin.match(
      Object.freeze({
        toolName: request.toolName,
        signals: Object.freeze(request.signals.map((signal) => Object.freeze({ ...signal })))
      })
    );
    if (!isRoutingResult(result)) return fail();
    writeResponse({ result: { bindings: [...result.bindings] } });
    return;
  }
  fail();
}

async function readRequest() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAXIMUM_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) throw new Error("missing request");
  return JSON.parse(text);
}

function inspectManifest(plugin) {
  if (!isRecord(plugin)) return undefined;
  if (plugin.apiVersion !== "1" || !isPluginIdentifier(plugin.id)) return undefined;
  if (plugin.kind === "secret-provider" && typeof plugin.resolve === "function") {
    return { apiVersion: "1", id: plugin.id, kind: "secret-provider" };
  }
  if (plugin.kind === "routing-matcher" && typeof plugin.match === "function") {
    return { apiVersion: "1", id: plugin.id, kind: "routing-matcher" };
  }
  return undefined;
}

function isSecretRequest(value) {
  return typeof value.reference === "string" && value.reference.length > 0 && value.reference.length <= 1024;
}

function isSecretResult(value) {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    Buffer.byteLength(value.value, "utf8") <= MAXIMUM_SECRET_VALUE_BYTES &&
    !value.value.includes("\u0000")
  );
}

function isRoutingRequest(value) {
  return (
    typeof value.toolName === "string" &&
    isSafeText(value.toolName) &&
    Array.isArray(value.signals) &&
    value.signals.length <= MAXIMUM_ROUTING_SIGNALS &&
    value.signals.every(isRoutingSignal)
  );
}

function isRoutingSignal(value) {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.kind !== "string") return false;
  return (
    signalKinds[value.provider]?.has(value.kind) === true &&
    typeof value.value === "string" &&
    isSafeText(value.value) &&
    typeof value.source === "string" &&
    sourceValues.has(value.source)
  );
}

function isSafeText(value) {
  if (value.length === 0 || value.length > 512) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isRoutingResult(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.bindings) &&
    value.bindings.length <= MAXIMUM_ROUTING_BINDINGS &&
    value.bindings.every((binding) => typeof binding === "string" && bindingPattern.test(binding))
  );
}

function isPluginIdentifier(value) {
  return typeof value === "string" && pluginIdPattern.test(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeResponse(value) {
  process.stdout.write(JSON.stringify(value));
}

function fail() {
  process.exitCode = 1;
}

void main().catch(fail);

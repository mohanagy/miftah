import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginConfig, PluginsConfig, RoutingMatcherPluginConfig } from "../config/types.js";
import type { ProviderMatcherInput } from "../routing/provider-matcher-types.js";
import { SecretProcessError, runSecretCommand } from "../secrets/secret-process-runner.js";
import { MiftahError } from "../utils/errors.js";
import { MIFTAH_PLUGIN_API_VERSION, type MiftahPluginApiVersion } from "./plugin-api.js";
import { isPluginIdentifier, type PluginSecretReference } from "./plugin-secret-reference.js";

const defaultPluginTimeoutMs = 5_000;
const builtInSecretProviderIds = new Set(["env", "dotenv", "plain", "keychain", "op"]);
const maximumRoutingBindingCount = 64;
// This is the static limit enforced by the independent plugin host protocol.
const maximumPluginHostRequestBytes = 16 * 1024;
const maximumPluginRoutingSignalCount = 64;
const bindingPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

interface LoadedPlugin {
  readonly id: string;
  readonly kind: PluginConfig["kind"];
  readonly path: string;
  readonly bindings?: Readonly<Record<string, string>>;
}

interface PluginManifest {
  readonly apiVersion: MiftahPluginApiVersion;
  readonly id: string;
  readonly kind: PluginConfig["kind"];
}

interface PluginRoutingCandidate {
  readonly profile: string;
  readonly pluginId: string;
  readonly binding: string;
}

type RoutingPluginTerminal =
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failure"; readonly error: unknown };

type PluginHostRequest =
  | { readonly operation: "manifest" }
  | { readonly operation: "secret"; readonly reference: string }
  | {
      readonly operation: "routing";
      readonly toolName: string;
      readonly signals: ProviderMatcherInput["signals"];
    };

/** Loads and runs configured local plugins only through an isolated child host. */
export class PluginRegistry {
  private readonly secretProviders: ReadonlyMap<string, LoadedPlugin>;
  private readonly routingMatchers: readonly LoadedPlugin[];

  constructor(
    private readonly timeoutMs: number,
    plugins: readonly LoadedPlugin[]
  ) {
    this.secretProviders = new Map(
      plugins.filter((plugin) => plugin.kind === "secret-provider").map((plugin) => [plugin.id, plugin])
    );
    this.routingMatchers = plugins.filter((plugin) => plugin.kind === "routing-matcher");
  }

  hasSecretProvider(id: string): boolean {
    return this.secretProviders.has(id);
  }

  hasRoutingMatchers(): boolean {
    return this.routingMatchers.length > 0;
  }

  async resolveSecret(reference: PluginSecretReference, signal?: AbortSignal): Promise<string | undefined> {
    const plugin = this.secretProviders.get(reference.providerId);
    if (plugin === undefined) return undefined;
    try {
      const response = await this.invoke(plugin, { operation: "secret", reference: reference.canonicalReference }, signal);
      const value = pluginSecretValue(response);
      if (value === undefined) throw new Error("invalid plugin secret response");
      return value;
    } catch (error) {
      throw secretPluginError(error);
    }
  }

  async matchRouting(
    toolName: string,
    input: ProviderMatcherInput,
    signal?: AbortSignal
  ): Promise<readonly PluginRoutingCandidate[]> {
    if (signal?.aborted) throw routingPluginCancelledError();
    const controller = new AbortController();
    let terminal: RoutingPluginTerminal | undefined;
    const stop = (next: RoutingPluginTerminal) => {
      if (terminal !== undefined) return;
      terminal = next;
      controller.abort();
    };
    const abort = () => stop({ kind: "cancelled" });
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      stop({ kind: "timeout" });
    }, this.timeoutMs);
    try {
      const pluginInput = normalizePluginRoutingInput(toolName, input);
      const attempts = this.routingMatchers.map((plugin) =>
        this.invoke(plugin, { operation: "routing", toolName, signals: pluginInput.signals }, controller.signal)
          .then((response) => {
            const bindings = pluginRoutingBindings(response);
            if (bindings === undefined) throw new Error("invalid plugin routing response");
            return { plugin, bindings };
          })
          .catch((error: unknown) => {
            stop({ kind: "failure", error });
            throw error;
          })
      );
      const outcomes = await Promise.allSettled(attempts);
      if (terminal?.kind === "timeout") throw routingPluginTimeoutError();
      if (terminal?.kind === "cancelled") throw routingPluginCancelledError();
      if (terminal?.kind === "failure") throw routingPluginError(terminal.error);

      const candidates: PluginRoutingCandidate[] = [];
      for (const outcome of outcomes) {
        if (outcome.status !== "fulfilled") throw routingPluginError(new Error("routing plugin failed"));
        const { plugin, bindings } = outcome.value;
        for (const binding of [...new Set(bindings)].sort()) {
          const configuredBindings = plugin.bindings;
          if (configuredBindings === undefined || !Object.hasOwn(configuredBindings, binding)) {
            throw routingPluginError(new Error("unconfigured plugin routing binding"));
          }
          const profile = configuredBindings[binding];
          if (typeof profile !== "string") throw routingPluginError(new Error("invalid plugin routing binding"));
          candidates.push({ profile, pluginId: plugin.id, binding });
        }
      }
      return candidates.sort(compareRoutingCandidates);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async invoke(
    plugin: LoadedPlugin,
    request: PluginHostRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const stdout = await runSecretCommand(
      {
        executable: process.execPath,
        args: [pluginHostPath(), plugin.path],
        environment: {},
        stdin: Buffer.from(JSON.stringify(request), "utf8")
      },
      { timeoutMs: this.timeoutMs, signal }
    );
    return parsePluginHostResponse(stdout.stdout);
  }
}

export interface PluginRegistryLoadOptions {
  /** Canonical local directory that every resolved plugin module must remain below. */
  readonly rootDirectory?: string;
  /** Cancels manifest preflight and terminates any isolated plugin host child. */
  readonly signal?: AbortSignal;
}

/** Preflights each explicit local allowlist entry before Miftah constructs an MCP server. */
export async function loadPluginRegistry(
  config: PluginsConfig | undefined,
  options: PluginRegistryLoadOptions = {}
): Promise<PluginRegistry> {
  const entries = config?.allowlist ?? [];
  validatePluginEntries(entries);
  const timeoutMs = config?.timeoutMs ?? defaultPluginTimeoutMs;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let rootDirectory: string | undefined;
  try {
    if (controller.signal.aborted) throw incompatiblePluginError();
    if (options.rootDirectory !== undefined) {
      try {
        rootDirectory = await realpath(options.rootDirectory);
      } catch {
        throw incompatiblePluginError();
      }
    }
    if (controller.signal.aborted) {
      throw incompatiblePluginError();
    }
    const attempts = entries.map((entry) =>
      loadPlugin(entry, timeoutMs, rootDirectory, controller.signal).catch((error: unknown) => {
        controller.abort();
        throw error;
      })
    );
    const outcomes = await Promise.allSettled(attempts);
    if (options.signal?.aborted) throw incompatiblePluginError();
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    if (failure !== undefined) throw incompatiblePluginError();
    const plugins = outcomes.map((outcome) => {
      if (outcome.status !== "fulfilled") throw incompatiblePluginError();
      return outcome.value;
    });
    return new PluginRegistry(timeoutMs, plugins.sort((first, second) => first.id.localeCompare(second.id)));
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
  }
}

function validatePluginEntries(entries: readonly PluginConfig[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isPluginIdentifier(entry.id) || builtInSecretProviderIds.has(entry.id)) throw incompatiblePluginError();
    if (ids.has(entry.id)) throw incompatiblePluginError();
    ids.add(entry.id);
    if ((entry.kind !== "secret-provider" && entry.kind !== "routing-matcher") || entry.path.length === 0) {
      throw incompatiblePluginError();
    }
    if (entry.kind === "routing-matcher") validateRoutingMatcherBindings(entry);
  }
}

function validateRoutingMatcherBindings(entry: RoutingMatcherPluginConfig): void {
  const bindings = Object.entries(entry.bindings);
  if (bindings.length === 0 || bindings.length > maximumRoutingBindingCount) throw incompatiblePluginError();
  for (const [binding, profile] of bindings) {
    if (!bindingPattern.test(binding) || !isSafeProfileName(profile)) throw incompatiblePluginError();
  }
}

async function loadPlugin(
  entry: PluginConfig,
  timeoutMs: number,
  rootDirectory: string | undefined,
  signal: AbortSignal
): Promise<LoadedPlugin> {
  let path: string;
  try {
    path = await realpath(entry.path);
    if (!(await stat(path)).isFile()) throw new Error("plugin path is not a file");
    if (rootDirectory !== undefined && !isChildPath(rootDirectory, path)) throw new Error("plugin path escapes root");
  } catch {
    throw incompatiblePluginError();
  }
  const manifest = await inspectPluginManifest(path, timeoutMs, signal);
  if (manifest.id !== entry.id || manifest.kind !== entry.kind || manifest.apiVersion !== MIFTAH_PLUGIN_API_VERSION) {
    throw incompatiblePluginError();
  }
  return entry.kind === "routing-matcher"
    ? { id: entry.id, kind: entry.kind, path, bindings: { ...entry.bindings } }
    : { id: entry.id, kind: entry.kind, path };
}

async function inspectPluginManifest(path: string, timeoutMs: number, signal: AbortSignal): Promise<PluginManifest> {
  try {
    const result = await runSecretCommand(
      {
        executable: process.execPath,
        args: [pluginHostPath(), path],
        environment: {},
        stdin: Buffer.from(JSON.stringify({ operation: "manifest" }), "utf8")
      },
      { timeoutMs, signal }
    );
    const response = parsePluginHostResponse(result.stdout);
    const manifest = pluginManifest(response);
    if (manifest === undefined) throw new Error("invalid plugin manifest response");
    return manifest;
  } catch {
    throw incompatiblePluginError();
  }
}

function isChildPath(rootDirectory: string, target: string): boolean {
  const pathFromRoot = relative(rootDirectory, target);
  return (
    pathFromRoot.length > 0 &&
    !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    pathFromRoot !== ".." &&
    !isAbsolute(pathFromRoot)
  );
}

/** Preserves static matcher coverage while keeping the isolated host request inside its fixed protocol budget. */
function normalizePluginRoutingInput(toolName: string, input: ProviderMatcherInput): ProviderMatcherInput {
  const uniqueSignals = new Map<string, ProviderMatcherInput["signals"][number]>();
  for (const signal of input.signals) {
    const key = `${signal.provider}\u0000${signal.kind}\u0000${signal.value}\u0000${signal.source}`;
    uniqueSignals.set(key, signal);
  }
  const sorted = [...uniqueSignals.values()].sort(comparePluginSignals);
  const signals: ProviderMatcherInput["signals"][number][] = [];
  for (const signal of sorted) {
    if (signals.length === maximumPluginRoutingSignalCount) break;
    const candidate = [...signals, signal];
    if (pluginRoutingRequestBytes(toolName, candidate) > maximumPluginHostRequestBytes) continue;
    signals.push(signal);
  }
  return { signals };
}

function comparePluginSignals(
  first: ProviderMatcherInput["signals"][number],
  second: ProviderMatcherInput["signals"][number]
): number {
  for (const [left, right] of [
    [first.provider, second.provider],
    [first.kind, second.kind],
    [first.value, second.value],
    [first.source, second.source]
  ] as const) {
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

function pluginRoutingRequestBytes(
  toolName: string,
  signals: readonly ProviderMatcherInput["signals"][number][]
): number {
  return Buffer.byteLength(JSON.stringify({ operation: "routing", toolName, signals }), "utf8");
}

function pluginHostPath(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const builtHost = join(currentDirectory, "plugin-host.js");
  if (existsSync(builtHost)) return builtHost;
  return join(currentDirectory, "..", "plugin-host.mjs");
}

function parsePluginHostResponse(stdout: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new Error("invalid plugin host output");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid plugin host output");
  }
}

function pluginManifest(value: unknown): PluginManifest | undefined {
  if (!isRecord(value) || !isRecord(value.manifest)) return undefined;
  const manifest = value.manifest;
  const { apiVersion, id, kind } = manifest;
  if (
    apiVersion !== MIFTAH_PLUGIN_API_VERSION ||
    !isPluginIdentifier(id) ||
    (kind !== "secret-provider" && kind !== "routing-matcher")
  ) {
    return undefined;
  }
  return { apiVersion, id, kind };
}

function pluginSecretValue(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.result)) return undefined;
  const secret = value.result.value;
  return typeof secret === "string" && secret.length > 0 && !secret.includes("\u0000") ? secret : undefined;
}

function pluginRoutingBindings(value: unknown): readonly string[] | undefined {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.bindings)) return undefined;
  const bindings = value.result.bindings;
  if (!bindings.every((binding) => typeof binding === "string" && bindingPattern.test(binding))) return undefined;
  return bindings as string[];
}

function incompatiblePluginError(): MiftahError {
  return new MiftahError(
    "PLUGIN_API_INCOMPATIBLE",
    "PLUGIN_API_INCOMPATIBLE: configured plugin is incompatible with the supported plugin API"
  );
}

function secretPluginError(error: unknown): MiftahError {
  if (error instanceof MiftahError) return error;
  if (error instanceof SecretProcessError) {
    if (error.kind === "timeout") {
      return new MiftahError("SECRET_PROVIDER_TIMEOUT", "SECRET_PROVIDER_TIMEOUT: plugin secret provider timed out");
    }
    if (error.kind === "cancelled") {
      return new MiftahError("SECRET_PROVIDER_CANCELLED", "SECRET_PROVIDER_CANCELLED: plugin secret provider was cancelled");
    }
  }
  return new MiftahError("SECRET_PROVIDER_FAILED", "SECRET_PROVIDER_FAILED: plugin secret provider failed");
}

function routingPluginError(error: unknown): MiftahError {
  if (error instanceof MiftahError) return error;
  if (error instanceof SecretProcessError) {
    if (error.kind === "timeout") {
      return new MiftahError("ROUTING_PLUGIN_TIMEOUT", "ROUTING_PLUGIN_TIMEOUT: routing plugin timed out");
    }
    if (error.kind === "cancelled") {
      return new MiftahError("ROUTING_PLUGIN_CANCELLED", "ROUTING_PLUGIN_CANCELLED: routing plugin was cancelled");
    }
  }
  return new MiftahError("ROUTING_PLUGIN_FAILED", "ROUTING_PLUGIN_FAILED: routing plugin failed");
}

function routingPluginTimeoutError(): MiftahError {
  return new MiftahError("ROUTING_PLUGIN_TIMEOUT", "ROUTING_PLUGIN_TIMEOUT: routing plugin timed out");
}

function routingPluginCancelledError(): MiftahError {
  return new MiftahError("ROUTING_PLUGIN_CANCELLED", "ROUTING_PLUGIN_CANCELLED: routing plugin was cancelled");
}

function isSafeProfileName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareRoutingCandidates(first: PluginRoutingCandidate, second: PluginRoutingCandidate): number {
  for (const [left, right] of [
    [first.pluginId, second.pluginId],
    [first.binding, second.binding],
    [first.profile, second.profile]
  ] as const) {
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

export type { PluginRoutingCandidate };

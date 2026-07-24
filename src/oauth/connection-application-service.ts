import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import { loadConfig } from "../config/load-config.js";
import { resolvePath } from "../config/path-resolve.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { validateConfig } from "../config/validate-config.js";
import type { MiftahConfig, OAuthConnectionConfig } from "../config/types.js";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import { MiftahError } from "../utils/errors.js";
import { parseOAuthConnectionRef, type OAuthConnectionRef } from "./connection-types.js";

export interface OAuthConnectionAddRequest {
  readonly profile: string;
  readonly upstream?: string;
  readonly issuer: string;
  readonly clientRegistration: string;
  readonly scopes: readonly string[];
}

export interface OAuthConnectionAddPlan {
  readonly connectionRef: OAuthConnectionRef;
  readonly actions: readonly string[];
  readonly config: MiftahConfig;
}

export interface ConnectionAddCommandOptions extends OAuthConnectionAddRequest {
  readonly configPath: string;
  readonly connectionRef?: string;
  readonly write?: boolean;
}

export interface ConnectionAddCommandReport {
  readonly changed: true;
  readonly write: boolean;
  readonly connectionRef: OAuthConnectionRef;
  readonly profile: string;
  readonly upstream: string;
  readonly resource: string;
  readonly actions: readonly string[];
  readonly backupPath?: string;
}

export interface ConnectionApplicationAuditEvent {
  readonly action: "add";
  readonly profile: string;
  readonly upstream: string;
  readonly status: "success";
}

/** Audit port shared by the CLI and the future Console application layer. */
export interface ConnectionApplicationAuditSink {
  ensureWritable(): Promise<void>;
  record(event: ConnectionApplicationAuditEvent): Promise<void>;
}

export interface ConnectionApplicationDependencies {
  readonly audit?: ConnectionApplicationAuditSink;
  readonly generateConnectionRef?: () => string;
  /** Source captured by a caller that already verified and opened the exact config file. */
  readonly trustedSource?: ConfigMigrationSource;
}

class ConfiguredConnectionApplicationAuditSink implements ConnectionApplicationAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  record(event: ConnectionApplicationAuditEvent): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/oauth-connection-add",
      name: "connection",
      profile: event.profile,
      upstream: event.upstream,
      status: event.status
    });
  }
}

async function configuredAuditSink(configPath: string): Promise<ConnectionApplicationAuditSink | undefined> {
  const config = await loadConfig(configPath);
  if (config.audit?.enabled === false || !config.audit?.path) return undefined;
  const logger = new AuditLogger(config.audit.path, {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredConnectionApplicationAuditSink(new AuditTrail(config.name, logger));
}

type MutableJsonRecord = Record<string, unknown>;

function targetRequired(): never {
  throw new MiftahError(
    "OAUTH_CONNECTION_TARGET_REQUIRED",
    "OAUTH_CONNECTION_TARGET_REQUIRED: choose an exact named upstream for this OAuth connection"
  );
}

function invalidJson(path: string): never {
  throw new MiftahError("CONFIG_INVALID_JSON", `CONFIG_INVALID_JSON: config '${path}' is not valid JSON`);
}

function parseBytes(bytes: Buffer, path: string): unknown {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidJson(path);
  }
  try {
    return JSON.parse(content);
  } catch {
    invalidJson(path);
  }
}

function asRecord(value: unknown): MutableJsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as MutableJsonRecord
    : undefined;
}

function selectedUpstream(
  config: MutableJsonRecord,
  requestedName: string | undefined
): { readonly name: string; readonly config: MutableJsonRecord } {
  const singleton = asRecord(config.upstream);
  if (singleton !== undefined) return { name: requestedName ?? "default", config: singleton };
  if (requestedName === undefined) targetRequired();
  const upstreams = asRecord(config.upstreams);
  const selected = asRecord(upstreams?.[requestedName]);
  if (selected === undefined) {
    // Let the public schema produce the canonical UPSTREAM_NOT_FOUND diagnostic after insertion.
    return { name: requestedName, config: {} };
  }
  return { name: requestedName, config: selected };
}

function resourceUrl(upstream: MutableJsonRecord): string {
  return typeof upstream.url === "string" ? upstream.url : "";
}

/** Plans one immutable, schema-validated connection addition without reading credentials. */
export function planOAuthConnectionAdd(
  input: unknown,
  request: OAuthConnectionAddRequest,
  connectionReference: string
): OAuthConnectionAddPlan {
  const migration = planConfigMigration(input);
  const config = structuredClone(migration.config) as MutableJsonRecord;
  const connectionRef = parseOAuthConnectionRef(connectionReference);
  const target = selectedUpstream(config, request.upstream);
  const connection: OAuthConnectionConfig = {
    profile: request.profile,
    upstream: target.name,
    resource: resourceUrl(target.config),
    issuer: request.issuer,
    clientRegistration: request.clientRegistration,
    scopes: [...request.scopes]
  };
  const oauth = asRecord(config.oauth) ?? {};
  const connections = asRecord(oauth.connections) ?? {};
  if (Object.hasOwn(connections, connectionRef)) {
    throw new MiftahError(
      "OAUTH_CONNECTION_INVALID",
      "OAUTH_CONNECTION_INVALID: refusing to replace an existing OAuth connection reference"
    );
  }
  oauth.connections = { ...connections, [connectionRef]: connection };
  config.oauth = oauth;
  validateConfig(config);
  return {
    connectionRef,
    actions: [
      ...migration.actions,
      `Added OAuth connection for profile '${request.profile}' and upstream '${target.name}'.`
    ],
    config: config as unknown as MiftahConfig
  };
}

function report(plan: OAuthConnectionAddPlan, write: boolean, backupPath?: string): ConnectionAddCommandReport {
  const connection = plan.config.version === "3" ? plan.config.oauth?.connections[plan.connectionRef] : undefined;
  if (connection === undefined) {
    throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: planned OAuth connection is missing");
  }
  return {
    changed: true,
    write,
    connectionRef: plan.connectionRef,
    profile: connection.profile,
    upstream: connection.upstream,
    resource: connection.resource,
    actions: plan.actions,
    ...(backupPath === undefined ? {} : { backupPath })
  };
}

/** Plans by default and commits only from an exact source snapshot after explicit --write. */
export async function runConnectionAddCommand(
  options: ConnectionAddCommandOptions,
  dependencies: ConnectionApplicationDependencies = {}
): Promise<ConnectionAddCommandReport> {
  const path = resolvePath(options.configPath);
  const connectionRef = options.connectionRef ?? `oauthconn:${dependencies.generateConnectionRef?.() ?? randomUUID()}`;
  if (options.write !== true) {
    const bytes = dependencies.trustedSource?.originalBytes ?? await readFile(path).catch((error: unknown) => {
      throw new MiftahError("CONFIG_NOT_FOUND", `CONFIG_NOT_FOUND: unable to read config '${path}'`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    });
    return report(planOAuthConnectionAdd(parseBytes(bytes, path), options, connectionRef), false);
  }

  const source = dependencies.trustedSource ?? await readConfigMigrationSource(path);
  const plan = planOAuthConnectionAdd(parseBytes(source.originalBytes, path), options, connectionRef);
  const audit = dependencies.audit ?? await configuredAuditSink(path);
  await audit?.ensureWritable();
  const backupPath = await applyConfigReplacement(path, source, plan.config);
  const result = report(plan, true, backupPath);
  await audit?.record({
    action: "add",
    profile: result.profile,
    upstream: result.upstream,
    status: "success"
  });
  return result;
}

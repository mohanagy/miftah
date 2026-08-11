import { randomUUID } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/server";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig, UpstreamConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { parseOAuthConnectionRef, type OAuthConnectionRef } from "../oauth/connection-types.js";
import {
  discoverNativeOAuthConnection,
  type DiscoveredNativeOAuthConnection
} from "../oauth/remote-oauth-discovery.js";
import { MiftahError } from "../utils/errors.js";

export interface NativeOAuthFirstRunRequest {
  readonly name: string;
  readonly profile: string;
  readonly description?: string;
  readonly resource: string;
  readonly clientMetadataUrl?: string;
}

export interface NativeOAuthFirstRunPlan {
  readonly connectionRef: OAuthConnectionRef;
  readonly discovery: DiscoveredNativeOAuthConnection;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

export interface NativeOAuthFirstRunDependencies {
  /** Generates only an opaque UUID suffix; the public config stores an oauthconn: reference. */
  readonly generateConnectionRef?: () => string;
  readonly fetch?: FetchLike;
}

/** Non-secret input for adding one more independently authorized account to an existing remote MCP config. */
export interface NativeOAuthAccountAdditionRequest {
  readonly profile: string;
  readonly description?: string;
  /** `default` for a singleton upstream; a named upstream is required otherwise. */
  readonly upstream?: string;
  /** Explicitly changes only the durable default; existing MCP sessions remain unchanged until restart. */
  readonly makeDefault?: boolean;
  readonly clientMetadataUrl?: string;
}

/** A side-effect-free account-addition plan. The caller owns the guarded config transaction. */
export interface NativeOAuthAccountAdditionPlan {
  readonly connectionRef: OAuthConnectionRef;
  readonly profile: string;
  readonly upstream: string;
  readonly discovery: DiscoveredNativeOAuthConnection;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

export interface NativeOAuthAccountAdditionCommandOptions extends NativeOAuthAccountAdditionRequest {
  readonly configPath: string;
}

export interface NativeOAuthAccountAdditionReport {
  readonly changed: true;
  readonly write: true;
  readonly connectionRef: OAuthConnectionRef;
  readonly profile: string;
  readonly upstream: string;
  readonly resource: string;
  readonly actions: readonly string[];
  /** A byte-exact recovery copy created when migration rewrote the selected configuration. */
  readonly backupPath?: string;
}

export interface NativeOAuthAccountAdditionAuditSink {
  ensureWritable(): Promise<void>;
  record(event: { readonly profile: string; readonly upstream: string; readonly status: "success" }): Promise<void>;
}

export interface NativeOAuthAccountAdditionDependencies extends NativeOAuthFirstRunDependencies {
  /** Source captured by a caller that already verified and opened the exact configuration file. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers use their own redacted local lifecycle journal. */
  readonly audit?: NativeOAuthAccountAdditionAuditSink;
}

/**
 * Produces a complete schema-valid first-run configuration only after endpoint-first OAuth discovery succeeds.
 * This function is intentionally side-effect free: callers own durable publication and must do it atomically.
 */
export async function planNativeOAuthFirstRunConfiguration(
  request: NativeOAuthFirstRunRequest,
  dependencies: NativeOAuthFirstRunDependencies = {}
): Promise<NativeOAuthFirstRunPlan> {
  const connectionRef = parseOAuthConnectionRef(`oauthconn:${dependencies.generateConnectionRef?.() ?? randomUUID()}`);
  const discovery = await discoverNativeOAuthConnection(
    {
      resource: request.resource,
      profile: request.profile,
      upstream: "default",
      connectionRef,
      ...(request.clientMetadataUrl === undefined ? {} : { clientMetadataUrl: request.clientMetadataUrl })
    },
    { fetch: dependencies.fetch }
  );
  const profile = request.description === undefined || request.description.length === 0
    ? {}
    : { description: request.description };
  const config: MiftahConfig = {
    version: "3",
    name: request.name,
    defaultProfile: request.profile,
    upstream: { transport: "streamable-http", url: discovery.resource },
    profiles: { [request.profile]: profile },
    oauth: {
      connections: {
        [connectionRef]: {
          profile: request.profile,
          upstream: "default",
          resource: discovery.resource,
          issuer: discovery.issuer,
          clientRegistration: discovery.clientRegistration,
          scopes: [...discovery.advertisedScopes]
        }
      }
    }
  };
  validateConfig(config);
  return {
    connectionRef,
    discovery,
    config,
    actions: [
      `Created profile '${request.profile}'.`,
      `Discovered standards-based OAuth for profile '${request.profile}'.`,
      `Added OAuth connection for profile '${request.profile}' and upstream 'default'.`
    ]
  };
}

function profileMetadata(description: string | undefined): Record<string, string> {
  return description === undefined || description.length === 0 ? {} : { description };
}

export function selectedExistingUpstream(
  config: MiftahConfig,
  requestedUpstream: string | undefined
): { readonly name: string; readonly config: UpstreamConfig & { readonly url: string } } {
  const name = config.upstream === undefined ? requestedUpstream : requestedUpstream ?? "default";
  if (name === undefined) {
    throw new MiftahError(
      "OAUTH_CONNECTION_TARGET_REQUIRED",
      "OAUTH_CONNECTION_TARGET_REQUIRED: choose a named Streamable HTTP upstream"
    );
  }
  const upstream = config.upstream === undefined
    ? config.upstreams?.[name]
    : name === "default"
      ? config.upstream
      : undefined;
  if (upstream === undefined) {
    throw new MiftahError("UPSTREAM_NOT_FOUND", "UPSTREAM_NOT_FOUND: upstream does not exist");
  }
  if (upstream.transport !== "streamable-http" || typeof upstream.url !== "string" || upstream.url.length === 0) {
    throw new MiftahError(
      "OAUTH_RESOURCE_INVALID",
      "OAUTH_RESOURCE_INVALID: endpoint-first OAuth requires the selected upstream to be Streamable HTTP over exact HTTPS"
    );
  }
  return { name, config: upstream as UpstreamConfig & { readonly url: string } };
}

/**
 * Plans a new account profile and its independent native OAuth binding from a configuration snapshot.
 * It deliberately takes no endpoint from the caller: the resource is derived only from the selected
 * existing Streamable HTTP upstream. It does not write, register a client, open a browser, or store a credential.
 */
export async function planNativeOAuthAccountAddition(
  input: unknown,
  request: NativeOAuthAccountAdditionRequest,
  dependencies: NativeOAuthFirstRunDependencies = {}
): Promise<NativeOAuthAccountAdditionPlan> {
  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as Extract<MiftahConfig, { version: "3" }>;
  if (Object.hasOwn(config.profiles, request.profile)) {
    throw new MiftahError("PROFILE_ALREADY_EXISTS", "PROFILE_ALREADY_EXISTS: account profile already exists");
  }

  const selected = selectedExistingUpstream(config, request.upstream);
  const candidate = structuredClone(config) as Extract<MiftahConfig, { version: "3" }>;
  candidate.profiles[request.profile] = profileMetadata(request.description);
  if (request.makeDefault === true) candidate.defaultProfile = request.profile;
  // Validate the profile name and durable-default choice before any metadata request.
  validateConfig(candidate);

  const connectionRef = parseOAuthConnectionRef(`oauthconn:${dependencies.generateConnectionRef?.() ?? randomUUID()}`);
  const discovery = await discoverNativeOAuthConnection({
    resource: selected.config.url,
    profile: request.profile,
    upstream: selected.name,
    connectionRef,
    ...(request.clientMetadataUrl === undefined ? {} : { clientMetadataUrl: request.clientMetadataUrl })
  }, { fetch: dependencies.fetch });
  const oauth = candidate.oauth ?? { connections: {} };
  oauth.connections[connectionRef] = {
    profile: request.profile,
    upstream: selected.name,
    resource: discovery.resource,
    issuer: discovery.issuer,
    clientRegistration: discovery.clientRegistration,
    scopes: [...discovery.advertisedScopes]
  };
  candidate.oauth = oauth;
  validateConfig(candidate);

  return {
    connectionRef,
    profile: request.profile,
    upstream: selected.name,
    discovery,
    config: candidate,
    actions: [
      ...migrated.actions,
      `Created profile '${request.profile}'.`,
      `Discovered standards-based OAuth for profile '${request.profile}'.`,
      `Added OAuth connection for profile '${request.profile}' and upstream '${selected.name}'.`,
      ...(request.makeDefault === true ? [`Set durable default profile to '${request.profile}'.`] : [])
    ]
  };
}

class ConfiguredNativeOAuthAccountAuditSink implements NativeOAuthAccountAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  record(event: { readonly profile: string; readonly upstream: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/oauth-profile-add",
      name: "profile",
      profile: event.profile,
      upstream: event.upstream,
      status: event.status
    });
  }
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function configuredAuditSink(config: MiftahConfig): NativeOAuthAccountAdditionAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(config.audit.path, {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredNativeOAuthAccountAuditSink(new AuditTrail(config.name, logger));
}

/**
 * Performs one guarded, atomic account-profile addition from an exact configuration snapshot.
 * OAuth discovery happens before the transaction; browser authorization and client registration remain separate.
 */
export async function runNativeOAuthAccountAddition(
  options: NativeOAuthAccountAdditionCommandOptions,
  dependencies: NativeOAuthAccountAdditionDependencies = {}
): Promise<NativeOAuthAccountAdditionReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = await planNativeOAuthAccountAddition(sourceInput(source), options, dependencies);
  const audit = dependencies.audit ?? configuredAuditSink(plan.config);
  await audit?.ensureWritable();
  const backupPath = await applyConfigReplacement(configPath, source, plan.config);
  await audit?.record({ profile: plan.profile, upstream: plan.upstream, status: "success" });
  return {
    changed: true,
    write: true,
    connectionRef: plan.connectionRef,
    profile: plan.profile,
    upstream: plan.upstream,
    resource: plan.discovery.resource,
    actions: plan.actions,
    backupPath
  };
}

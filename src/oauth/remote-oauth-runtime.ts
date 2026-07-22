import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import type { MiftahConfig } from "../config/types.js";
import type { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";
import { OAuthMetadataFetchGuard } from "./oauth-metadata-fetch-guard.js";
import type { AuditTrail } from "../audit/audit-trail.js";
import {
  AuditTrailOAuthConnectionAuditSink,
  type OAuthConnectionLifecycleAuditEvent,
  type OAuthConnectionLifecycleAuditSink
} from "./audit.js";
import { OAuthConnectionLifecycle } from "./connection-lifecycle.js";
import {
  FileOAuthConnectionMetadataStore,
  OAuthConnectionRegistry,
  type OAuthConnectionMetadataStore
} from "./connection-registry.js";
import {
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  type OAuthConnectionBinding,
  type OAuthCredentialState,
  type OAuthIdentityState
} from "./connection-types.js";
import { createLoopbackOAuthAuthorizationHandoff } from "./loopback-authorization-handoff.js";
import {
  RemoteOAuthClientProvider,
  type OAuthAuthorizationHandoff
} from "./remote-oauth-client-provider.js";
import { RemoteOAuthCredentialRefresher } from "./remote-oauth-credential-refresher.js";
import {
  createPlatformOAuthCredentialStore,
  type OAuthCredentialStore
} from "./secure-credential-store.js";

export interface RemoteOAuthRuntimeOptions {
  readonly metadataStore?: OAuthConnectionMetadataStore;
  readonly credentialStore?: OAuthCredentialStore;
  readonly fetch?: FetchLike;
  readonly createHandoff?: () => Promise<OAuthAuthorizationHandoff>;
  readonly now?: () => Date;
  /** Disables browser handoff for diagnostics while preserving use of an existing credential. */
  readonly interactiveAuthorization?: boolean;
  /** Forces one exact target through a fresh flow without deleting its current credential first. */
  readonly forceAuthorization?: { readonly profile: string; readonly upstream: string };
}

export interface RedactedOAuthConnection {
  readonly connectionRef: string;
  readonly profile: string;
  readonly upstream: string;
  readonly resource: string;
  readonly issuer: string;
  readonly clientRegistration: string;
  readonly scopes: readonly string[];
}

export interface RedactedOAuthConnectionStatus extends RedactedOAuthConnection {
  readonly credentialState: OAuthCredentialState;
  readonly identityState: OAuthIdentityState;
  readonly expiresAt?: string;
  readonly updatedAt: string;
}

function targetKey(profile: string, upstream: string): string {
  return `${profile}\u0000${upstream}`;
}

class DeferredOAuthAuditSink implements OAuthConnectionLifecycleAuditSink {
  private delegate?: OAuthConnectionLifecycleAuditSink;

  attach(delegate: OAuthConnectionLifecycleAuditSink): void {
    this.delegate = delegate;
  }

  async record(event: OAuthConnectionLifecycleAuditEvent): Promise<void> {
    await this.delegate?.record(event);
  }
}

/** Returns the restrictive non-secret OAuth metadata location for the current OS user. */
export function defaultOAuthConnectionMetadataPath(): string {
  if (platform() === "win32") {
    const configured = process.env.LOCALAPPDATA;
    const root = configured !== undefined && isAbsolute(configured)
      ? configured
      : join(homedir(), "AppData", "Local");
    return join(root, "Miftah", "oauth-connections.json");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Miftah", "oauth-connections.json");
  }
  const configured = process.env.XDG_STATE_HOME;
  const root = configured !== undefined && isAbsolute(configured)
    ? configured
    : join(homedir(), ".local", "state");
  return join(root, "miftah", "oauth-connections.json");
}

/** Owns exact profile/upstream OAuth providers for one resolved Miftah configuration. */
export class RemoteOAuthRuntime {
  constructor(
    private readonly bindings: ReadonlyMap<string, OAuthConnectionBinding>,
    private readonly lifecycle: OAuthConnectionLifecycle,
    private readonly createHandoff: () => Promise<OAuthAuthorizationHandoff>,
    readonly fetch?: FetchLike,
    private readonly now?: () => Date,
    private readonly audit?: DeferredOAuthAuditSink,
    private readonly issuerResponseSupported?: (issuer: string) => boolean,
    private readonly interactiveAuthorization = true,
    private readonly forceAuthorization?: { readonly profile: string; readonly upstream: string }
  ) {}

  attachAuditTrail(auditTrail: AuditTrail): void {
    this.audit?.attach(new AuditTrailOAuthConnectionAuditSink(auditTrail));
  }

  async provider(profile: string, upstream: string): Promise<RemoteOAuthClientProvider | undefined> {
    const binding = this.bindings.get(targetKey(profile, upstream));
    if (binding === undefined) return undefined;
    await this.lifecycle.register(binding);
    const handoff = await this.createHandoff();
    try {
      return new RemoteOAuthClientProvider({
        binding,
        lifecycle: this.lifecycle,
        handoff,
        ...(this.issuerResponseSupported === undefined
          ? {}
          : { issuerResponseSupported: this.issuerResponseSupported }),
        ...(this.now === undefined ? {} : { now: this.now }),
        interactiveAuthorization: this.interactiveAuthorization,
        forceAuthorization:
          this.forceAuthorization?.profile === profile && this.forceAuthorization.upstream === upstream
      });
    } catch (error) {
      await handoff.close().catch(() => undefined);
      throw error;
    }
  }

  /** Returns configured non-secret bindings without the config identity used by secure storage. */
  connections(): readonly RedactedOAuthConnection[] {
    return [...this.bindings.values()]
      .sort((left, right) => left.connectionRef.localeCompare(right.connectionRef))
      .map((binding) => this.redacted(binding));
  }

  async status(profile: string, upstream: string): Promise<RedactedOAuthConnectionStatus> {
    const binding = this.requireBinding(profile, upstream);
    const record = await this.lifecycle.register(binding);
    return {
      ...this.redacted(binding),
      credentialState: record.credentialState,
      identityState: record.identityState,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      updatedAt: record.updatedAt
    };
  }

  async disconnect(profile: string, upstream: string): Promise<RedactedOAuthConnectionStatus> {
    const binding = this.requireBinding(profile, upstream);
    await this.lifecycle.register(binding);
    const record = await this.lifecycle.disconnect(binding);
    return {
      ...this.redacted(binding),
      credentialState: record.credentialState,
      identityState: record.identityState,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      updatedAt: record.updatedAt
    };
  }

  /** Persists only the bounded identity lifecycle state for an exact configured OAuth target. */
  async recordIdentityState(profile: string, upstream: string, state: OAuthIdentityState): Promise<void> {
    const binding = this.bindings.get(targetKey(profile, upstream));
    if (binding === undefined) return;
    await this.lifecycle.register(binding);
    await this.lifecycle.setIdentityState(binding, state);
  }

  private requireBinding(profile: string, upstream: string): OAuthConnectionBinding {
    const binding = this.bindings.get(targetKey(profile, upstream));
    if (binding === undefined) {
      throw new MiftahError(
        "OAUTH_CONNECTION_NOT_FOUND",
        "OAUTH_CONNECTION_NOT_FOUND: OAuth connection does not exist"
      );
    }
    return binding;
  }

  private redacted(binding: OAuthConnectionBinding): RedactedOAuthConnection {
    return {
      connectionRef: binding.connectionRef,
      profile: binding.profile,
      upstream: binding.upstream,
      resource: binding.canonicalResource,
      issuer: binding.issuer,
      clientRegistration: binding.clientRegistration,
      scopes: [...binding.scopes]
    };
  }
}

/** Builds the enabled OAuth runtime only when a v3 configuration declares a connection. */
export async function createRemoteOAuthRuntime(
  configPath: string,
  config: MiftahConfig,
  redactor: SecretRedactor,
  options: RemoteOAuthRuntimeOptions = {}
): Promise<RemoteOAuthRuntime | undefined> {
  if (config.version !== "3" || Object.keys(config.oauth?.connections ?? {}).length === 0) return undefined;
  const registry = new OAuthConnectionRegistry(
    options.metadataStore ?? new FileOAuthConnectionMetadataStore(defaultOAuthConnectionMetadataPath())
  );
  const store = options.credentialStore ?? await createPlatformOAuthCredentialStore(redactor);
  const metadataGuard = new OAuthMetadataFetchGuard(options.fetch);
  const refresher = new RemoteOAuthCredentialRefresher({
    fetch: metadataGuard.fetch,
    issuerResponseSupported: (issuer) => metadataGuard.issuerResponseSupported(issuer),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const audit = new DeferredOAuthAuditSink();
  const lifecycle = new OAuthConnectionLifecycle({
    registry,
    store,
    refresher,
    audit,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const configIdentity = createOAuthConfigIdentity(configPath);
  const bindings = new Map<string, OAuthConnectionBinding>();
  for (const [connectionRef, connection] of Object.entries(config.oauth?.connections ?? {})) {
    const binding = createOAuthConnectionBinding({
      configIdentity,
      connectionRef,
      profile: connection.profile,
      upstream: connection.upstream,
      resource: connection.resource,
      issuer: connection.issuer,
      clientRegistration: connection.clientRegistration,
      scopes: connection.scopes
    });
    bindings.set(targetKey(binding.profile, binding.upstream), binding);
  }
  return new RemoteOAuthRuntime(
    bindings,
    lifecycle,
    options.createHandoff ?? (() => createLoopbackOAuthAuthorizationHandoff()),
    metadataGuard.fetch,
    options.now,
    audit,
    (issuer) => metadataGuard.issuerResponseSupported(issuer),
    options.interactiveAuthorization ?? true,
    options.forceAuthorization
  );
}

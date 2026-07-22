import type { OAuthConnectionRef } from "../oauth/connection-types.js";

export type TransportType = "stdio" | "http" | "sse" | "streamable-http";

export interface UpstreamConfig {
  transport: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Explicitly permits this configured upstream's MCP tool annotations to influence risk classification. */
  trustToolAnnotations?: boolean;
}

type CurrentUpstreamConfig = Omit<UpstreamConfig, "transport"> & {
  /** Canonical config versions replace the legacy HTTP transport alias with the canonical name. */
  transport: Exclude<TransportType, "http">;
};

/** Non-secret account attributes used to validate an upstream identity. */
export interface IdentityFingerprint {
  provider?: string;
  login?: string;
  organization?: string;
  host?: string;
}

interface TextIdentityProbeConfig {
  tool: string;
  resultFormat: "text";
  provider?: string;
}

interface JsonIdentityProbeConfig {
  tool: string;
  resultFormat: "json";
  provider?: never;
}

/** Describes an upstream tool that returns a bounded identity fingerprint. */
export type IdentityProbeConfig = TextIdentityProbeConfig | JsonIdentityProbeConfig;

type TextIdentityExpectedFingerprint = {
  login: string;
  provider?: never;
  organization?: never;
  host?: never;
};

type TextIdentityExpectedFingerprintWithProvider = {
  login: string;
  provider: string;
  organization?: never;
  host?: never;
};

type NonEmptyIdentityFingerprint =
  | (IdentityFingerprint & { provider: string })
  | (IdentityFingerprint & { login: string })
  | (IdentityFingerprint & { organization: string })
  | (IdentityFingerprint & { host: string });

type IdentityRequiredRisk = ["write"] | ["destructive"] | ["write", "destructive"] | ["destructive", "write"];

type IdentityVerificationConfig = {
  maxAgeMs: number;
  requiredForRisk?: IdentityRequiredRisk;
};

/** Opt-in identity verification for a profile or one named upstream. */
export type IdentityConfig =
  | (IdentityVerificationConfig & {
      expected: TextIdentityExpectedFingerprint;
      probe: TextIdentityProbeConfig;
    })
  | (IdentityVerificationConfig & {
      expected: TextIdentityExpectedFingerprintWithProvider;
      probe: TextIdentityProbeConfig & { provider: string };
    })
  | (IdentityVerificationConfig & {
      expected: NonEmptyIdentityFingerprint;
      probe: JsonIdentityProbeConfig;
    });

/** Copies a regular configuration-owned file into an isolated profile runtime tree. */
export interface ProfileIsolationFile {
  source: string;
  destination: string;
  environment?: string;
}

/** Binds a path from an isolated profile runtime tree into a Docker or Podman container. */
export interface ProfileIsolationContainerVolume {
  source: string;
  destination: string;
  readOnly?: boolean;
  environment?: string;
}

/** Opt-in filesystem and container isolation for one profile/upstream target. */
export interface ProfileIsolationConfig {
  files?: ProfileIsolationFile[];
  containerVolumes?: ProfileIsolationContainerVolume[];
}

export interface ProfileUpstreamOverride {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  identity?: IdentityConfig;
  isolation?: ProfileIsolationConfig;
}

/** GitHub identifiers that can select a profile through Miftah's built-in matcher. */
export interface GitHubProfileRoutingMatch {
  repositories?: string[];
  organizations?: string[];
}

/** Sentry identifiers that can select a profile through Miftah's built-in matcher. */
export interface SentryProfileRoutingMatch {
  organizations?: string[];
  projects?: string[];
  environments?: string[];
}

/** Jira identifiers that can select a profile through Miftah's built-in matcher. */
export interface JiraProfileRoutingMatch {
  sites?: string[];
  projects?: string[];
}

/** Linear identifiers that can select a profile through Miftah's built-in matcher. */
export interface LinearProfileRoutingMatch {
  workspaces?: string[];
  teams?: string[];
}

/** PostHog identifiers that can select a profile through Miftah's built-in matcher. */
export interface PostHogProfileRoutingMatch {
  hosts?: string[];
  projects?: string[];
}

/** Static, provider-specific identifiers that may route to one profile. */
export interface ProfileRoutingMatchConfig {
  github?: GitHubProfileRoutingMatch;
  sentry?: SentryProfileRoutingMatch;
  jira?: JiraProfileRoutingMatch;
  linear?: LinearProfileRoutingMatch;
  posthog?: PostHogProfileRoutingMatch;
}

/** Opt-in static provider matcher declarations for a profile. */
export interface ProfileRoutingConfig {
  match: ProfileRoutingMatchConfig;
}

/** Requires a fresh explicit profile selection before the named risky operations can run. */
export interface ProfileLeaseConfig {
  ttlMs: number;
  requiredForRisk:
    | ["write"]
    | ["destructive"]
    | ["write", "destructive"]
    | ["destructive", "write"];
}

export interface ProfileConfig {
  description?: string;
  tags?: string[];
  env?: Record<string, string>;
  args?: string[];
  cwd?: string;
  headers?: Record<string, string>;
  policy?: string;
  identity?: IdentityConfig;
  lease?: ProfileLeaseConfig;
  isolation?: ProfileIsolationConfig;
  routing?: ProfileRoutingConfig;
  upstreams?: Record<string, ProfileUpstreamOverride>;
}

export interface RoutingRule {
  name?: string;
  when: Record<string, unknown>;
  profile: string;
}

export interface RoutingConfig {
  mode?: "active" | "rules" | "hybrid";
  fallback?: "default" | "activeProfile" | "ask" | "block";
  rules?: RoutingRule[];
}

export interface ValidatedRoutingConfig extends Omit<RoutingConfig, "mode"> {
  mode?: "hybrid";
}

export type RiskLevel = "read" | "write" | "destructive";
/** Conservative defaults allowed for tools whose risk cannot be classified. */
export type UnknownToolRisk = "write" | "destructive";
export type ToolDiscoveryMode = "permissive" | "strict";

export interface PolicyConfig {
  allow?: RiskLevel[];
  allowRisk?: RiskLevel[];
  deny?: string[];
  denyRisk?: RiskLevel[];
  requireConfirmation?: string[];
}

export interface SecurityConfig {
  allowPlaintextSecrets?: boolean;
  redactSecrets?: true;
  allowProfileSwitchingFromMcp?: boolean;
  requireProfileSwitchConfirmation?: boolean;
  /** Human confirmation is the default; delegated-agent mode explicitly permits the bearer fallback. */
  approvalMode?: "human" | "delegated-agent";
  allowProfileLockingFromMcp?: boolean;
  requireExplicitProfileForDestructive?: boolean;
  requireExplicitSelectionForDestructive?: boolean;
  lockToProfile?: string | null;
}

type CurrentSecurityConfig = Omit<SecurityConfig, "allowPlaintextSecrets" | "redactSecrets"> & {
  /** Version 2 moves this opt-in to secrets.allowPlaintextSecrets. */
  allowPlaintextSecrets?: never;
  /** Secret redaction is always enabled in version 2. */
  redactSecrets?: never;
};

/** Configures lifecycle behavior for profile-bound upstream processes. */
export interface ProcessConfig {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleTimeoutMs?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  maxConcurrentProfiles?: number;
}

/** Bounded local JSONL segment rotation and archive retention. */
export type AuditRotationConfig =
  | {
      maxBytes: number;
      maxAgeMs?: number;
      retainFiles: number;
    }
  | {
      maxBytes?: number;
      maxAgeMs: number;
      retainFiles: number;
    };

/** Opt-in local tamper-evidence for already-redacted audit records. */
export interface AuditIntegrityConfig {
  algorithm: "sha256-chain";
}

interface AuditConfigBase {
  enabled?: boolean;
  path?: string;
  format?: "jsonl";
  includeArguments?: boolean;
  redact?: true;
  failureMode?: "fail-open" | "fail-closed";
}

/** An ordinary audit declaration without managed rotation or integrity metadata. */
type UnmanagedAuditConfig = AuditConfigBase & {
  rotation?: never;
  integrity?: never;
};

/** A managed journal always has an enabled, concrete destination. */
type ManagedAuditConfig = Omit<AuditConfigBase, "enabled" | "path"> & {
  enabled?: true;
  path: string;
  rotation?: AuditRotationConfig;
  integrity?: AuditIntegrityConfig;
};

/** Configures local audit output and optional managed journal controls. */
export type AuditConfig = UnmanagedAuditConfig | ManagedAuditConfig;

type WithoutLegacyOption<Type, Key extends PropertyKey> = Type extends unknown
  ? Omit<Type, Key> & { [Option in Key]?: never }
  : never;

type CurrentAuditConfig = WithoutLegacyOption<AuditConfig, "redact">;

export interface ToolingConfig {
  collisionStrategy?: "prefix-upstream" | "fail";
  toolDiscoveryMode?: ToolDiscoveryMode;
  toolRiskOverrides?: Record<string, RiskLevel>;
  unknownToolRisk?: UnknownToolRisk;
}

/** Configures provider-backed secret resolution. */
export interface SecretsConfig {
  envFiles?: string[];
  allowPlaintextSecrets?: boolean;
  providerTimeoutMs?: number;
}

/** Kinds of locally allowlisted extensions supported by the stable plugin API. */
export type PluginKind = "secret-provider" | "routing-matcher";

interface PluginConfigBase {
  /** Stable plugin manifest identifier. */
  id: string;
  /** Local ESM module path, resolved relative to the configuration file. */
  path: string;
}

/** An allowlisted provider for a `secretref:<id>://...` reference. */
export interface SecretProviderPluginConfig extends PluginConfigBase {
  kind: "secret-provider";
}

/** An allowlisted matcher whose returned binding tokens map only to configured profiles. */
export interface RoutingMatcherPluginConfig extends PluginConfigBase {
  kind: "routing-matcher";
  bindings: Record<string, string>;
}

export type PluginConfig = SecretProviderPluginConfig | RoutingMatcherPluginConfig;

/** Explicit local extension allowlist. Remote installation and package-name lookup are unsupported. */
export interface PluginsConfig {
  allowlist: PluginConfig[];
  timeoutMs?: number;
}

/** Configures localhost-first Streamable HTTP serving. Authentication values must be secret references. */
export interface HttpServerConfig {
  host?: string;
  port?: number;
  /** Explicitly permits binding any host other than the literal loopback defaults. */
  allowNonLoopback?: true;
  /** A supported secret reference resolved before the HTTP listener starts. */
  authToken?: string;
  /** Exact request Host names accepted by the HTTP listener. */
  allowedHosts?: string[];
  /** Explicit browser origins permitted to access the HTTP endpoint. */
  allowedOrigins?: string[];
  maxSessions?: number;
  sessionIdleTimeoutMs?: number;
  maxRequestBytes?: number;
}

/** Configures server transports hosted by Miftah. */
export interface ServerConfig {
  http?: HttpServerConfig;
}

/** Selects the isolation boundary for the active-profile selection. */
export type ActiveProfileStateScope = "process" | "session" | "workspace" | "global";

/** Opt-in active-profile persistence. Durable scopes never accept a caller-provided path. */
export type StateConfig =
  | {
      persistActiveProfile?: false;
      scope?: "process" | "session";
    }
  | {
      persistActiveProfile: true;
      scope: "workspace" | "global";
    };

/** A non-secret, versioned attachment of one OAuth connection to an exact remote upstream. */
export interface OAuthConnectionConfig {
  /** Selects an existing profile; it is not an account identity claim. */
  profile: string;
  /** "default" for a singleton upstream, otherwise the configured named-upstream key. */
  upstream: string;
  /** Exact canonical HTTPS Streamable HTTP MCP resource URL. */
  resource: string;
  /** Exact issuer identifier selected by a later authorization-server discovery flow. */
  issuer: string;
  /** Non-secret identifier for the approved client-registration path. */
  clientRegistration: string;
  /** Requested least-privilege OAuth scopes; raw credentials never belong in config. */
  scopes: string[];
}

/** Declarative non-secret OAuth connection bindings. Credential state remains outside configuration. */
export interface OAuthConfig {
  connections: Record<OAuthConnectionRef, OAuthConnectionConfig>;
}

interface MiftahConfigBase {
  name: string;
  description?: string;
  defaultProfile: string;
  upstream?: UpstreamConfig;
  upstreams?: Record<string, UpstreamConfig>;
  profiles: Record<string, ProfileConfig>;
  routing?: ValidatedRoutingConfig;
  policies?: Record<string, PolicyConfig>;
  security?: SecurityConfig;
  process?: ProcessConfig;
  audit?: AuditConfig;
  tooling?: ToolingConfig;
  secrets?: SecretsConfig;
  plugins?: PluginsConfig;
  state?: StateConfig;
  server?: ServerConfig;
}

/** Version 1 retains the documented compatibility aliases accepted by the runtime. */
interface LegacyMiftahConfig extends MiftahConfigBase {
  version: "1";
}

/** Version 2 accepts only the canonical configuration surface. */
interface CurrentMiftahConfig extends Omit<MiftahConfigBase, "upstream" | "upstreams" | "security" | "audit"> {
  version: "2";
  upstream?: CurrentUpstreamConfig;
  upstreams?: Record<string, CurrentUpstreamConfig>;
  security?: CurrentSecurityConfig;
  audit?: CurrentAuditConfig;
}

/** Version 3 adds opaque OAuth connection bindings without serializing credentials. */
interface OAuthMiftahConfig extends Omit<CurrentMiftahConfig, "version"> {
  version: "3";
  oauth?: OAuthConfig;
}

/**
 * Supported configuration formats, discriminated by their declared version.
 *
 * Version 1 preserves documented compatibility aliases; version 2 exposes the
 * strict canonical surface; version 3 adds non-secret OAuth connection bindings.
 */
export type MiftahConfig = LegacyMiftahConfig | CurrentMiftahConfig | OAuthMiftahConfig;

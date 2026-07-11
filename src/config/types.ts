export type TransportType = "stdio" | "http" | "sse" | "streamable-http";

export interface UpstreamConfig {
  transport: TransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface ProfileUpstreamOverride {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
}

export interface ProfileConfig {
  description?: string;
  tags?: string[];
  env?: Record<string, string>;
  args?: string[];
  cwd?: string;
  headers?: Record<string, string>;
  policy?: string;
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
  requireExplicitProfileForDestructive?: boolean;
  lockToProfile?: string | null;
}

/** Configures lifecycle behavior for profile-bound upstream processes. */
export interface ProcessConfig {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleTimeoutMs?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  maxConcurrentProfiles?: number;
}

export interface AuditConfig {
  enabled?: boolean;
  path?: string;
  format?: "jsonl";
  includeArguments?: boolean;
  redact?: true;
  failureMode?: "fail-open" | "fail-closed";
}

export interface ToolingConfig {
  collisionStrategy?: "prefix-upstream" | "fail";
  toolDiscoveryMode?: ToolDiscoveryMode;
  toolRiskOverrides?: Record<string, RiskLevel>;
}

export interface MiftahConfig {
  version: "1";
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
  secrets?: { envFiles?: string[]; allowPlaintextSecrets?: boolean };
}

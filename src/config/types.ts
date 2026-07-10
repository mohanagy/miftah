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

export interface ProfileRoutingConfig {
  match?: Record<string, unknown>;
}

export interface ProfileConfig {
  description?: string;
  tags?: string[];
  env?: Record<string, string>;
  args?: string[];
  cwd?: string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  policy?: string;
  routing?: ProfileRoutingConfig;
  upstreams?: Record<string, Partial<UpstreamConfig>>;
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
  plugins?: string[];
}

export type RiskLevel = "read" | "write" | "destructive";

export interface PolicyConfig {
  allow?: RiskLevel[];
  allowRisk?: RiskLevel[];
  deny?: string[];
  denyRisk?: RiskLevel[];
  requireConfirmation?: string[];
}

export interface SecurityConfig {
  allowPlaintextSecrets?: boolean;
  redactSecrets?: boolean;
  allowProfileSwitchingFromMcp?: boolean;
  requireProfileSwitchConfirmation?: boolean;
  requireExplicitProfileForDestructive?: boolean;
  lockToProfile?: string | null;
}

export interface ProcessConfig {
  startMode?: "lazy" | "eager";
  cache?: boolean;
  idleTimeoutMs?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxConcurrentProfiles?: number;
}

export interface AuditConfig {
  enabled?: boolean;
  path?: string;
  format?: "jsonl";
  includeArguments?: boolean;
  redact?: boolean;
}

export interface ToolingConfig {
  managementToolPrefix?: string;
  upstreamToolNamespace?: "none" | "wrapperName" | "profile" | "both" | "upstreamName";
  collisionStrategy?: "prefix-upstream" | "fail";
  toolDiscoveryMode?: "defaultProfile" | "allProfilesStrict" | "allProfilesUnion" | "allProfilesIntersection";
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
  routing?: RoutingConfig;
  policies?: Record<string, PolicyConfig>;
  security?: SecurityConfig;
  process?: ProcessConfig;
  audit?: AuditConfig;
  tooling?: ToolingConfig;
  secrets?: { envFiles?: string[]; allowPlaintextSecrets?: boolean };
  state?: { persistActiveProfile?: boolean; path?: string };
  ui?: Record<string, unknown>;
}

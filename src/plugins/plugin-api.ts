/** Stable ABI version implemented by Miftah's local plugin host. */
export const MIFTAH_PLUGIN_API_VERSION = "1";

export type MiftahPluginApiVersion = typeof MIFTAH_PLUGIN_API_VERSION;
export type MiftahPluginKind = "secret-provider" | "routing-matcher";

/** Manifest fields checked in an isolated process before Miftah starts serving MCP. */
export interface MiftahPluginManifest {
  readonly apiVersion: MiftahPluginApiVersion;
  readonly id: string;
  readonly kind: MiftahPluginKind;
}

/** The complete secret-provider input. No resolved values, configuration, or environment are supplied. */
export interface SecretProviderPluginRequest {
  readonly reference: string;
}

export interface SecretProviderPluginResult {
  readonly value: string;
}

/** A local extension that resolves one configured canonical secret reference at a time. */
export interface SecretProviderPlugin extends MiftahPluginManifest {
  readonly kind: "secret-provider";
  resolve(request: SecretProviderPluginRequest): Promise<SecretProviderPluginResult> | SecretProviderPluginResult;
}

export type RoutingMatcherPluginProvider = "github" | "sentry" | "jira" | "linear" | "posthog";
export type RoutingMatcherPluginKind =
  | "repository"
  | "organization"
  | "project"
  | "environment"
  | "site"
  | "workspace"
  | "team"
  | "host";

/** One canonical signal projected by Miftah before a routing plugin is invoked. */
export interface RoutingMatcherPluginSignal {
  readonly provider: RoutingMatcherPluginProvider;
  readonly kind: RoutingMatcherPluginKind;
  readonly value: string;
  readonly source: "argument" | "context" | "url";
}

/** The complete routing-matcher input. Raw arguments, profile data, and secrets are intentionally absent. */
export interface RoutingMatcherPluginRequest {
  readonly toolName: string;
  readonly signals: readonly RoutingMatcherPluginSignal[];
}

/** Binding tokens are mapped to configured profiles by Miftah, never by the plugin. */
export interface RoutingMatcherPluginResult {
  readonly bindings: readonly string[];
}

/** A local extension that returns configured routing binding tokens for safe canonical signals. */
export interface RoutingMatcherPlugin extends MiftahPluginManifest {
  readonly kind: "routing-matcher";
  match(request: RoutingMatcherPluginRequest): Promise<RoutingMatcherPluginResult> | RoutingMatcherPluginResult;
}

export type MiftahPlugin = SecretProviderPlugin | RoutingMatcherPlugin;

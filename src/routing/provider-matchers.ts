import type { ProfileConfig } from "../config/types.js";
import type {
  ProviderMatcherCandidate,
  ProviderMatcherContext,
  ProviderMatcherEvidence,
  ProviderMatcherInput,
  ProviderMatcherSignal
} from "./provider-matcher-types.js";

const MAX_PROVIDER_MATCHER_VALUE_LENGTH = 256;
const MAX_PROVIDER_MATCHER_CONTEXT_REPOSITORIES = 32;
const githubOrganizationPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/u;
const githubRepositoryPattern = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/u;
const sentrySlugPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const sentryProjectPattern = /^[a-z0-9][a-z0-9_-]{0,127}\/[a-z0-9][a-z0-9_-]{0,127}$/u;
const sentryEnvironmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const jiraProjectPattern = /^[A-Z][A-Z0-9_]{0,9}$/u;
const linearSlugPattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const posthogProjectPattern = /^[1-9][0-9]{0,17}$/u;

/**
 * Projects raw routing arguments into the narrow, canonical input accepted by
 * Miftah's static matcher registry. The registry itself never receives raw
 * arguments, arbitrary context, environment data, or nested values.
 */
export function projectProviderMatcherInput(
  toolName: string,
  args: Readonly<Record<string, unknown>> | undefined,
  context?: ProviderMatcherContext
): ProviderMatcherInput {
  const signals: ProviderMatcherSignal[] = [];
  if (hasProviderToken(toolName, "github")) {
    appendCanonicalSignals(
      signals,
      "github",
      "repository",
      "argument",
      args,
      ["repository", "repo"],
      canonicalGithubRepository
    );
    appendCanonicalSignals(
      signals,
      "github",
      "organization",
      "argument",
      args,
      ["organization", "org", "owner"],
      canonicalGithubOrganization
    );
  }
  appendCanonicalSignals(
    signals,
    "github",
    "repository",
    "url",
    args,
    ["url", "uri", "html_url", "repository_url", "issue_url", "pull_request_url"],
    githubRepositoryFromUrl
  );
  const contextRepositories = Array.isArray(context?.githubRepositories)
    ? context.githubRepositories.slice(0, MAX_PROVIDER_MATCHER_CONTEXT_REPOSITORIES)
    : [];
  for (const repository of contextRepositories) {
    const canonical = canonicalGithubRepository(repository);
    if (canonical !== undefined) {
      signals.push({ provider: "github", kind: "repository", value: canonical, source: "context" });
    }
  }
  if (hasProviderToken(toolName, "sentry")) {
    const organizations = canonicalValues(args, ["organization", "org"], canonicalSentrySlug);
    appendSignals(signals, "sentry", "organization", "argument", organizations);
    appendSignals(signals, "sentry", "project", "argument", canonicalSentryProjects(args, organizations));
    appendCanonicalSignals(
      signals,
      "sentry",
      "environment",
      "argument",
      args,
      ["environment"],
      canonicalSentryEnvironment
    );
  }
  appendCanonicalSignals(
    signals,
    "sentry",
    "organization",
    "url",
    args,
    ["url", "uri", "html_url", "issue_url"],
    sentryOrganizationFromUrl
  );
  if (hasProviderToken(toolName, "jira")) {
    appendCanonicalSignals(
      signals,
      "jira",
      "site",
      "argument",
      args,
      ["site", "baseUrl", "base_url"],
      canonicalHttpsOrigin
    );
    appendCanonicalSignals(
      signals,
      "jira",
      "project",
      "argument",
      args,
      ["project", "projectKey", "project_key"],
      canonicalJiraProject
    );
  }
  signals.push(...jiraCloudUrlSignals(args, ["url", "uri", "html_url", "issue_url"]));
  if (hasProviderToken(toolName, "linear")) {
    appendCanonicalSignals(
      signals,
      "linear",
      "workspace",
      "argument",
      args,
      ["workspace"],
      canonicalLinearSlug
    );
    appendCanonicalSignals(signals, "linear", "team", "argument", args, ["team"], canonicalLinearSlug);
  }
  appendCanonicalSignals(
    signals,
    "linear",
    "workspace",
    "url",
    args,
    ["url", "uri", "html_url", "issue_url"],
    linearWorkspaceFromUrl
  );
  if (hasProviderToken(toolName, "posthog")) {
    appendCanonicalSignals(
      signals,
      "posthog",
      "host",
      "argument",
      args,
      ["host", "baseUrl", "base_url"],
      canonicalHttpsOrigin
    );
    appendCanonicalSignals(
      signals,
      "posthog",
      "project",
      "argument",
      args,
      ["project", "projectId", "project_id"],
      canonicalPosthogProject
    );
  }
  signals.push(...posthogProjectUrlSignals(args, ["url", "uri", "html_url"]));
  return { signals };
}

/** Converts supported GitHub URL/remote syntax into a canonical repository identifier. */
export function githubRepositoryFromSource(value: string): string | undefined {
  if (!isBoundedSafeValue(value)) return undefined;
  const https = githubRepositoryFromUrl(value.startsWith("git+") ? value.slice(4) : value);
  if (https !== undefined) return https;
  const ssh = value.match(/^ssh:\/\/git@github\.com\/([^/?#]+)\/([^/?#]+)$/u);
  if (ssh) return canonicalGithubRepositoryParts(ssh[1], ssh[2]);
  const scp = value.match(/^git@github\.com:([^/?#]+)\/([^/?#]+)$/u);
  return scp ? canonicalGithubRepositoryParts(scp[1], scp[2]) : undefined;
}

/**
 * Evaluates profile-local declarations with a fixed in-tree registry. It is
 * synchronous and has no filesystem, process, network, or dynamic-code path.
 */
export function matchProviderBindings(
  profiles: Readonly<Record<string, ProfileConfig>>,
  input: ProviderMatcherInput
): readonly ProviderMatcherCandidate[] {
  const candidates: ProviderMatcherCandidate[] = [];
  const seen = new Set<string>();
  for (const profile of Object.keys(profiles).sort()) {
    for (const signal of input.signals) {
      if (!matchesProfileBinding(profiles[profile], signal)) continue;
      const evidence: ProviderMatcherEvidence = {
        provider: signal.provider,
        kind: signal.kind,
        value: signal.value
      };
      const key = `${evidence.provider}\u0000${evidence.kind}\u0000${evidence.value}\u0000${profile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ profile, evidence });
    }
  }
  return candidates.sort(compareCandidates);
}

/** Validates that audit and preview evidence has the exact grammar emitted by the fixed registry. */
export function isCanonicalProviderMatcherEvidence(
  provider: unknown,
  kind: unknown,
  value: unknown
): boolean {
  if (typeof value !== "string") return false;
  if (provider === "github") {
    return (
      (kind === "repository" && canonicalGithubRepository(value) !== undefined) ||
      (kind === "organization" && canonicalGithubOrganization(value) !== undefined)
    );
  }
  if (provider === "sentry") {
    return (
      (kind === "organization" && canonicalSentrySlug(value) !== undefined) ||
      (kind === "project" && canonicalSentryProject(value) !== undefined) ||
      (kind === "environment" && canonicalSentryEnvironment(value) !== undefined)
    );
  }
  if (provider === "jira") {
    return (
      (kind === "site" && canonicalHttpsOrigin(value) !== undefined) ||
      (kind === "project" && canonicalJiraProject(value) !== undefined)
    );
  }
  if (provider === "linear") {
    return (
      (kind === "workspace" && canonicalLinearSlug(value) !== undefined) ||
      (kind === "team" && canonicalLinearSlug(value) !== undefined)
    );
  }
  return (
    provider === "posthog" &&
    ((kind === "host" && canonicalHttpsOrigin(value) !== undefined) ||
      (kind === "project" && canonicalPosthogProject(value) !== undefined))
  );
}

function matchesProfileBinding(profile: ProfileConfig | undefined, signal: ProviderMatcherSignal): boolean {
  const match = profile?.routing?.match;
  if (!match) return false;
  if (signal.provider === "github") {
    return (
      (signal.kind === "repository" && match.github?.repositories?.includes(signal.value) === true) ||
      (signal.kind === "organization" && match.github?.organizations?.includes(signal.value) === true)
    );
  }
  if (signal.provider === "sentry") {
    return (
      (signal.kind === "organization" && match.sentry?.organizations?.includes(signal.value) === true) ||
      (signal.kind === "project" && match.sentry?.projects?.includes(signal.value) === true) ||
      (signal.kind === "environment" && match.sentry?.environments?.includes(signal.value) === true)
    );
  }
  if (signal.provider === "jira") {
    return (
      (signal.kind === "site" && match.jira?.sites?.includes(signal.value) === true) ||
      (signal.kind === "project" && match.jira?.projects?.includes(signal.value) === true)
    );
  }
  if (signal.provider === "linear") {
    return (
      (signal.kind === "workspace" && match.linear?.workspaces?.includes(signal.value) === true) ||
      (signal.kind === "team" && match.linear?.teams?.includes(signal.value) === true)
    );
  }
  if (signal.provider === "posthog") {
    return (
      (signal.kind === "host" && match.posthog?.hosts?.includes(signal.value) === true) ||
      (signal.kind === "project" && match.posthog?.projects?.includes(signal.value) === true)
    );
  }
  return false;
}

function appendCanonicalSignals(
  signals: ProviderMatcherSignal[],
  provider: ProviderMatcherSignal["provider"],
  kind: ProviderMatcherSignal["kind"],
  source: ProviderMatcherSignal["source"],
  args: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[],
  canonicalize: (value: string) => string | undefined
): void {
  appendSignals(signals, provider, kind, source, canonicalValues(args, names, canonicalize));
}

function appendSignals(
  signals: ProviderMatcherSignal[],
  provider: ProviderMatcherSignal["provider"],
  kind: ProviderMatcherSignal["kind"],
  source: ProviderMatcherSignal["source"],
  values: readonly string[]
): void {
  for (const value of values) {
    signals.push({ provider, kind, value, source });
  }
}

function canonicalValues(
  args: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[],
  canonicalize: (value: string) => string | undefined
): readonly string[] {
  if (args === undefined) return [];
  const values = new Set<string>();
  for (const name of names) {
    const value = args[name];
    if (typeof value !== "string") continue;
    const canonical = canonicalize(value);
    if (canonical !== undefined) values.add(canonical);
  }
  return [...values];
}

function canonicalSentryProjects(
  args: Readonly<Record<string, unknown>> | undefined,
  organizations: readonly string[]
): readonly string[] {
  if (args === undefined) return [];
  const projects = new Set<string>();
  const value = args.project;
  if (typeof value !== "string") return [];
  const direct = canonicalSentryProject(value);
  if (direct !== undefined) projects.add(direct);
  const project = canonicalSentrySlug(value);
  if (project !== undefined) {
    for (const organization of organizations) {
      projects.add(`${organization}/${project}`);
    }
  }
  return [...projects];
}

function sentryOrganizationFromUrl(value: string): string | undefined {
  const parsed = trustedHttpsUrl(value);
  if (parsed === undefined) return undefined;
  const hostedOrganization = parsed.hostname.match(/^([a-z0-9][a-z0-9_-]{0,127})\.sentry\.io$/u)?.[1];
  const pathOrganization =
    parsed.hostname === "sentry.io"
      ? parsed.pathname.match(/^\/organizations\/([^/]+)(?:\/|$)/u)?.[1]
      : undefined;
  const organization = hostedOrganization ?? pathOrganization;
  return organization === undefined ? undefined : canonicalSentrySlug(organization);
}

function argumentStringValues(
  args: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[]
): readonly string[] {
  if (args === undefined) return [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const value = args[name];
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function uniqueUrlSignals(
  signals: readonly ProviderMatcherSignal[]
): ProviderMatcherSignal[] {
  const unique = new Map<string, ProviderMatcherSignal>();
  for (const signal of signals) {
    unique.set(`${signal.provider}\u0000${signal.kind}\u0000${signal.value}\u0000${signal.source}`, signal);
  }
  return [...unique.values()];
}

function jiraCloudUrlSignals(
  args: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[]
): ProviderMatcherSignal[] {
  const signals: ProviderMatcherSignal[] = [];
  for (const value of argumentStringValues(args, names)) {
    const parsed = trustedHttpsUrl(value);
    if (parsed === undefined) continue;
    if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/u.test(parsed.hostname)) continue;
    const site = canonicalHttpsOrigin(`https://${parsed.host}`);
    const project = parsed.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]{0,9})-[^/]+(?:\/|$)/u)?.[1];
    if (site === undefined || project === undefined) continue;
    signals.push(
      { provider: "jira", kind: "site", value: site, source: "url" },
      { provider: "jira", kind: "project", value: project, source: "url" }
    );
  }
  return uniqueUrlSignals(signals);
}

function linearWorkspaceFromUrl(value: string): string | undefined {
  const parsed = trustedHttpsUrl(value);
  if (parsed?.hostname !== "linear.app") return undefined;
  const workspace = parsed.pathname.match(/^\/([^/]+)\/issue\/[^/]+(?:\/|$)/u)?.[1];
  return workspace === undefined ? undefined : canonicalLinearSlug(workspace);
}

function posthogProjectUrlSignals(
  args: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[]
): ProviderMatcherSignal[] {
  const signals: ProviderMatcherSignal[] = [];
  for (const value of argumentStringValues(args, names)) {
    const parsed = trustedHttpsUrl(value);
    if (parsed === undefined || !/^[a-z0-9-]+\.posthog\.com$/u.test(parsed.hostname)) continue;
    const host = canonicalHttpsOrigin(`https://${parsed.host}`);
    const project = parsed.pathname.match(/^\/project\/([1-9][0-9]{0,17})(?:\/|$)/u)?.[1];
    if (host === undefined || project === undefined) continue;
    signals.push(
      { provider: "posthog", kind: "host", value: host, source: "url" },
      { provider: "posthog", kind: "project", value: project, source: "url" }
    );
  }
  return uniqueUrlSignals(signals);
}

function canonicalGithubRepository(value: string): string | undefined {
  return isBoundedSafeValue(value) && githubRepositoryPattern.test(value) ? value : undefined;
}

function canonicalGithubOrganization(value: string): string | undefined {
  return isBoundedSafeValue(value) && githubOrganizationPattern.test(value) ? value : undefined;
}

function canonicalSentrySlug(value: string): string | undefined {
  return isBoundedSafeValue(value) && sentrySlugPattern.test(value) ? value : undefined;
}

function canonicalSentryProject(value: string): string | undefined {
  return isBoundedSafeValue(value) && sentryProjectPattern.test(value) ? value : undefined;
}

function canonicalSentryEnvironment(value: string): string | undefined {
  return isBoundedSafeValue(value) && sentryEnvironmentPattern.test(value) ? value : undefined;
}

function canonicalJiraProject(value: string): string | undefined {
  return isBoundedSafeValue(value) && jiraProjectPattern.test(value) ? value : undefined;
}

function canonicalLinearSlug(value: string): string | undefined {
  return isBoundedSafeValue(value) && linearSlugPattern.test(value) ? value : undefined;
}

function canonicalPosthogProject(value: string): string | undefined {
  return isBoundedSafeValue(value) && posthogProjectPattern.test(value) ? value : undefined;
}

function canonicalHttpsOrigin(value: string): string | undefined {
  if (!isBoundedSafeValue(value)) return undefined;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === "/" &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      value === `https://${parsed.host}`
    )
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function trustedHttpsUrl(value: string): URL | undefined {
  if (!isBoundedSafeValue(value) || !value.startsWith("https://")) return undefined;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      value.startsWith(`https://${parsed.host}/`)
    )
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function githubRepositoryFromUrl(value: string): string | undefined {
  if (!isBoundedSafeValue(value) || !value.startsWith("https://github.com/")) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.port.length > 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return undefined;
    }
    const segments = parsed.pathname.split("/");
    const owner = segments[1];
    return canonicalGithubRepositoryParts(owner, segments[2]);
  } catch {
    return undefined;
  }
}

function canonicalGithubRepositoryParts(owner: string | undefined, repository: string | undefined): string | undefined {
  if (owner === undefined || repository === undefined) return undefined;
  const bareRepository = repository.endsWith(".git") ? repository.slice(0, -4) : repository;
  return canonicalGithubRepository(`${owner}/${bareRepository}`);
}

function isBoundedSafeValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PROVIDER_MATCHER_VALUE_LENGTH &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function hasProviderToken(toolName: string, provider: string): boolean {
  if (!isBoundedSafeValue(toolName)) return false;
  return toolName.toLowerCase().split(/[^a-z0-9]+/u).includes(provider);
}

function compareCandidates(first: ProviderMatcherCandidate, second: ProviderMatcherCandidate): number {
  return (
    compareStrings(first.evidence.provider, second.evidence.provider) ||
    compareStrings(first.evidence.kind, second.evidence.kind) ||
    compareStrings(first.evidence.value, second.evidence.value) ||
    compareStrings(first.profile, second.profile)
  );
}

function compareStrings(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

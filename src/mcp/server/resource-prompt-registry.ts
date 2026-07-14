import { randomUUID } from "node:crypto";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type {
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListResourcesRequest,
  ListResourcesResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDiscoveryMode } from "../../config/types.js";
import { redactUri } from "../../secrets/redact.js";
import type { UpstreamRequestOptions } from "../../upstream/upstream-session.js";
import { MiftahError } from "../../utils/errors.js";

export interface ResourceRoute {
  readonly profile: string;
  readonly upstreamName: string;
  readonly originalUri: string;
  readonly exposedUri: string;
  readonly exposedName?: string;
}

export interface ResourceTemplateRoute {
  readonly profile: string;
  readonly upstreamName: string;
  readonly originalUriTemplate: string;
  readonly exposedUriBase: string;
  readonly exposedUriTemplate: string;
  readonly exposedName: string;
  readonly variables: readonly string[];
}

export interface PromptRoute {
  readonly profile: string;
  readonly upstreamName: string;
  readonly originalName: string;
  readonly exposedName: string;
}

type ResourceDiscovery = (
  profile: string,
  upstreamName: string,
  params?: ListResourcesRequest["params"],
  options?: UpstreamRequestOptions
) => Promise<ListResourcesResult>;
type PromptDiscovery = (
  profile: string,
  upstreamName: string,
  params?: ListPromptsRequest["params"],
  options?: UpstreamRequestOptions
) => Promise<ListPromptsResult>;
type ResourceTemplateDiscovery = (
  profile: string,
  upstreamName: string,
  params?: ListResourceTemplatesRequest["params"],
  options?: UpstreamRequestOptions
) => Promise<ListResourceTemplatesResult>;
type Redact = <T>(value: T) => T;
type CursorKind = "resources" | "resource-templates" | "prompts";
const defaultMaximumCursors = 256;

interface CursorState {
  readonly kind: CursorKind;
  readonly profile: string;
  readonly upstreamCursors: ReadonlyMap<string, string>;
}

interface DiscoveryFailure {
  readonly upstreamName: string;
  readonly code?: string;
  readonly message: string;
}

interface DiscoveryProgressAggregator {
  optionsFor(index: number): UpstreamRequestOptions | undefined;
  complete(index: number): void;
}

/**
 * Holds exact per-profile routes for multi-upstream resource and prompt capabilities.
 */
export class ResourcePromptRegistry {
  private readonly resourceRoutes = new Map<string, Map<string, ResourceRoute>>();
  private readonly resourceTemplateRoutes = new Map<string, Map<string, ResourceTemplateRoute>>();
  private readonly promptRoutes = new Map<string, Map<string, PromptRoute>>();
  private readonly cursors = new Map<string, CursorState>();
  private readonly epochs = new Map<string, number>();
  private readonly capabilityEpochs = new Map<string, Map<CursorKind, number>>();
  private readonly availability = new Map<string, Map<CursorKind, Map<string, boolean>>>();
  private readonly availabilityChanges = new Set<string>();

  constructor(
    private readonly upstreamNames: () => string[],
    private readonly discoverResources: ResourceDiscovery,
    private readonly discoverPrompts: PromptDiscovery,
    private readonly redact: Redact,
    private readonly maximumCursors = defaultMaximumCursors,
    private readonly discoveryMode: ToolDiscoveryMode = "permissive",
    private readonly discoverResourceTemplates?: ResourceTemplateDiscovery
  ) {}

  async listResources(
    profile: string,
    cursor?: string,
    options?: UpstreamRequestOptions
  ): Promise<ListResourcesResult> {
    this.assertRequestActive(options);
    const epoch = this.captureEpoch(profile);
    const upstreamCursors = this.resolveCursor("resources", profile, cursor);
    const pages = [...upstreamCursors];
    const progress = this.aggregateDiscoveryProgress(options, pages.length);
    const discoveryResults = await Promise.allSettled(
      pages.map(async ([upstreamName, upstreamCursor], index) => {
        try {
          return {
            upstreamName,
            result: await this.discoverResources(
              profile,
              upstreamName,
              upstreamCursor === undefined ? undefined : { cursor: upstreamCursor },
              progress.optionsFor(index)
            )
          };
        } finally {
          progress.complete(index);
        }
      })
    );
    this.assertRequestActive(options);
    const discovered = discoveryResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    this.assertCurrentEpoch("resources", profile, epoch);
    const failures = this.discoveryFailures(discoveryResults, pages);
    this.updateAvailability("resources", profile, discovered.map(({ upstreamName }) => upstreamName), failures);
    this.assertDiscoveryAvailable("resources", profile, discovered.length, failures);
    const routes = new Map(this.resourceRoutes.get(profile));
    for (const { upstreamName } of failures) {
      for (const [uri, route] of routes) {
        if (route.upstreamName === upstreamName) routes.delete(uri);
      }
    }
    const names = new Map<string, string>();
    for (const route of routes.values()) {
      if (route.exposedName !== undefined) names.set(route.exposedName, route.exposedUri);
    }
    const resources: Resource[] = [];

    for (const { upstreamName, result } of discovered) {
      for (const original of result.resources) {
        const resource = redactResource(this.redact(original));
        const exposedUri = namespaceResourceUri(upstreamName, redactUri(resource.uri));
        const exposedName = namespaceName(upstreamName, resource.name);
        const existing = routes.get(exposedUri);
        const nameRoute = names.get(exposedName);
        if (
          (existing &&
            (existing.upstreamName !== upstreamName ||
              existing.originalUri !== original.uri ||
              (existing.exposedName !== undefined && existing.exposedName !== exposedName))) ||
          (nameRoute !== undefined && nameRoute !== exposedUri)
        ) {
          throw new MiftahError(
            "RESOURCE_COLLISION",
            `RESOURCE_COLLISION: multiple upstream resources resolve to '${exposedName}' for profile '${profile}'`
          );
        }
        if (!existing || existing.exposedName === undefined) {
          routes.set(exposedUri, {
            profile,
            upstreamName,
            originalUri: original.uri,
            exposedUri,
            exposedName
          });
          names.set(exposedName, exposedUri);
        }
        resources.push({ ...resource, uri: exposedUri, name: exposedName });
      }
    }

    this.resourceRoutes.set(profile, routes);
    const nextCursor = this.storeCursor(
      "resources",
      profile,
      new Map(
        discovered.flatMap(({ upstreamName, result }) =>
          result.nextCursor === undefined ? [] : [[upstreamName, result.nextCursor] as const]
        )
      )
    );
    return { resources, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listResourceTemplates(
    profile: string,
    cursor?: string,
    options?: UpstreamRequestOptions
  ): Promise<ListResourceTemplatesResult> {
    if (this.discoverResourceTemplates === undefined) {
      throw new MiftahError(
        "RESOURCE_TEMPLATES_UNAVAILABLE",
        "RESOURCE_TEMPLATES_UNAVAILABLE: resource template discovery is not configured"
      );
    }
    const discoverResourceTemplates = this.discoverResourceTemplates;
    this.assertRequestActive(options);
    const epoch = this.captureEpoch(profile);
    const upstreamCursors = this.resolveCursor("resource-templates", profile, cursor);
    const pages = [...upstreamCursors];
    const progress = this.aggregateDiscoveryProgress(options, pages.length);
    const discoveryResults = await Promise.allSettled(
      pages.map(async ([upstreamName, upstreamCursor], index) => {
        try {
          return {
            upstreamName,
            result: await discoverResourceTemplates(
              profile,
              upstreamName,
              upstreamCursor === undefined ? undefined : { cursor: upstreamCursor },
              progress.optionsFor(index)
            )
          };
        } finally {
          progress.complete(index);
        }
      })
    );
    this.assertRequestActive(options);
    const discovered = discoveryResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    this.assertCurrentEpoch("resource-templates", profile, epoch);
    const failures = this.discoveryFailures(discoveryResults, pages);
    this.updateAvailability("resource-templates", profile, discovered.map(({ upstreamName }) => upstreamName), failures);
    this.assertDiscoveryAvailable("resource-templates", profile, discovered.length, failures);
    const routes = new Map(this.resourceTemplateRoutes.get(profile));
    for (const { upstreamName } of failures) {
      for (const [base, route] of routes) {
        if (route.upstreamName === upstreamName) routes.delete(base);
      }
    }
    const names = new Map<string, string>();
    for (const route of routes.values()) {
      names.set(route.exposedName, route.exposedUriBase);
    }
    const resourceTemplates: ResourceTemplate[] = [];

    for (const { upstreamName, result } of discovered) {
      for (const original of result.resourceTemplates) {
        const template = redactResourceTemplate(this.redact(original));
        const exposedName = namespaceName(upstreamName, template.name);
        const existing = [...routes.values()].find(
          (route) => route.upstreamName === upstreamName && route.originalUriTemplate === original.uriTemplate
        );
        const nameRoute = names.get(exposedName);
        if (nameRoute !== undefined && nameRoute !== existing?.exposedUriBase) {
          throw new MiftahError(
            "RESOURCE_TEMPLATE_COLLISION",
            `RESOURCE_TEMPLATE_COLLISION: multiple upstream resource templates resolve to '${exposedName}' for profile '${profile}'`
          );
        }
        const route = existing ?? this.registerResourceTemplateRoute(
          routes,
          profile,
          upstreamName,
          original.uriTemplate,
          exposedName
        );
        names.set(exposedName, route.exposedUriBase);
        resourceTemplates.push({ ...template, uriTemplate: route.exposedUriTemplate, name: route.exposedName });
      }
    }

    this.resourceTemplateRoutes.set(profile, routes);
    const nextCursor = this.storeCursor(
      "resource-templates",
      profile,
      new Map(
        discovered.flatMap(({ upstreamName, result }) =>
          result.nextCursor === undefined ? [] : [[upstreamName, result.nextCursor] as const]
        )
      )
    );
    return { resourceTemplates, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listPrompts(
    profile: string,
    cursor?: string,
    options?: UpstreamRequestOptions
  ): Promise<ListPromptsResult> {
    this.assertRequestActive(options);
    const epoch = this.captureEpoch(profile);
    const upstreamCursors = this.resolveCursor("prompts", profile, cursor);
    const pages = [...upstreamCursors];
    const progress = this.aggregateDiscoveryProgress(options, pages.length);
    const discoveryResults = await Promise.allSettled(
      pages.map(async ([upstreamName, upstreamCursor], index) => {
        try {
          return {
            upstreamName,
            result: await this.discoverPrompts(
              profile,
              upstreamName,
              upstreamCursor === undefined ? undefined : { cursor: upstreamCursor },
              progress.optionsFor(index)
            )
          };
        } finally {
          progress.complete(index);
        }
      })
    );
    this.assertRequestActive(options);
    const discovered = discoveryResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    this.assertCurrentEpoch("prompts", profile, epoch);
    const failures = this.discoveryFailures(discoveryResults, pages);
    this.updateAvailability("prompts", profile, discovered.map(({ upstreamName }) => upstreamName), failures);
    this.assertDiscoveryAvailable("prompts", profile, discovered.length, failures);
    const routes = new Map(this.promptRoutes.get(profile));
    for (const { upstreamName } of failures) {
      for (const [name, route] of routes) {
        if (route.upstreamName === upstreamName) routes.delete(name);
      }
    }
    const prompts: Prompt[] = [];

    for (const { upstreamName, result } of discovered) {
      for (const original of result.prompts) {
        const prompt = redactPrompt(this.redact(original));
        const exposedName = namespaceName(upstreamName, prompt.name);
        const existing = routes.get(exposedName);
        if (
          existing &&
          (existing.upstreamName !== upstreamName || existing.originalName !== original.name)
        ) {
          throw new MiftahError(
            "PROMPT_COLLISION",
            `PROMPT_COLLISION: multiple upstream prompts resolve to '${exposedName}' for profile '${profile}'`
          );
        }
        if (!existing) {
          routes.set(exposedName, {
            profile,
            upstreamName,
            originalName: original.name,
            exposedName
          });
        }
        prompts.push({ ...prompt, name: exposedName });
      }
    }

    this.promptRoutes.set(profile, routes);
    const nextCursor = this.storeCursor(
      "prompts",
      profile,
      new Map(
        discovered.flatMap(({ upstreamName, result }) =>
          result.nextCursor === undefined ? [] : [[upstreamName, result.nextCursor] as const]
        )
      )
    );
    return { prompts, ...(nextCursor ? { nextCursor } : {}) };
  }

  resolveResource(profile: string, exposedUri: string): ResourceRoute | undefined {
    const staticRoute = this.resourceRoutes.get(profile)?.get(exposedUri);
    return staticRoute ?? this.resolveTemplatedResource(profile, exposedUri);
  }

  resolvePrompt(profile: string, exposedName: string): PromptRoute | undefined {
    return this.promptRoutes.get(profile)?.get(exposedName);
  }

  hasResourceRoutes(profile: string): boolean {
    return this.resourceRoutes.has(profile);
  }

  hasResourceTemplateRoutes(profile: string): boolean {
    return this.resourceTemplateRoutes.has(profile);
  }

  hasPromptRoutes(profile: string): boolean {
    return this.promptRoutes.has(profile);
  }

  captureEpoch(profile: string): number {
    return this.epochs.get(profile) ?? 0;
  }

  assertResourceEpoch(profile: string, epoch: number): void {
    this.assertCurrentEpoch("resources", profile, epoch);
  }

  assertPromptEpoch(profile: string, epoch: number): void {
    this.assertCurrentEpoch("prompts", profile, epoch);
  }

  redactReadResult(route: ResourceRoute, result: ReadResourceResult, epoch: number): ReadResourceResult {
    const canRegisterLinkedRoutes = this.isCurrentEpoch("resources", route.profile, epoch);
    const redacted = this.redact(result);
    return {
      ...redacted,
      contents: redacted.contents.map((content, index) =>
        result.contents[index]?.uri === route.originalUri
          ? { ...content, uri: route.exposedUri }
          : {
              ...content,
              uri: this.exposedLinkedResource(
                route.profile,
                route.upstreamName,
                result.contents[index]?.uri ?? content.uri,
                canRegisterLinkedRoutes
              )
            }
      )
    };
  }

  redactPromptResult(route: PromptRoute, result: GetPromptResult, epoch: number): GetPromptResult {
    const canRegisterLinkedRoutes =
      this.isCurrentEpoch("prompts", route.profile, epoch) && this.isCurrentEpoch("resources", route.profile, epoch);
    const redacted = this.redact(result);
    return {
      ...redacted,
      messages: redacted.messages.map((message, index) => {
        const originalContent = result.messages[index]?.content;
        if (message.content.type === "resource_link") {
          const originalUri = originalContent?.type === "resource_link" ? originalContent.uri : message.content.uri;
          return {
            ...message,
            content: {
              ...message.content,
              uri: this.exposedLinkedResource(route.profile, route.upstreamName, originalUri, canRegisterLinkedRoutes),
              icons: redactIconSources(message.content.icons)
            }
          };
        }
        if (message.content.type === "resource") {
          const originalUri = originalContent?.type === "resource" ? originalContent.resource.uri : message.content.resource.uri;
          return {
            ...message,
            content: {
              ...message.content,
              resource: {
                ...message.content.resource,
                uri: this.exposedLinkedResource(route.profile, route.upstreamName, originalUri, canRegisterLinkedRoutes)
              }
            }
          };
        }
        return message;
      })
    };
  }

  invalidate(profile: string): void {
    this.advanceEpoch(profile, ["resources", "resource-templates", "prompts"]);
    this.resourceRoutes.delete(profile);
    this.resourceTemplateRoutes.delete(profile);
    this.promptRoutes.delete(profile);
    this.availability.delete(profile);
    this.availabilityChanges.delete(this.availabilityKey("resources", profile));
    this.availabilityChanges.delete(this.availabilityKey("resource-templates", profile));
    this.availabilityChanges.delete(this.availabilityKey("prompts", profile));
    for (const [cursor, state] of this.cursors) {
      if (state.profile === profile) this.cursors.delete(cursor);
    }
  }

  invalidateResources(profile: string): void {
    this.advanceEpoch(profile, ["resources", "resource-templates"]);
    this.resourceRoutes.delete(profile);
    this.resourceTemplateRoutes.delete(profile);
    this.clearCursors(profile, "resources");
    this.clearCursors(profile, "resource-templates");
  }

  invalidatePrompts(profile: string): void {
    this.advanceEpoch(profile, ["prompts"]);
    this.promptRoutes.delete(profile);
    this.clearCursors(profile, "prompts");
  }

  exposeUpdatedResource(profile: string, upstreamName: string, originalUri: string): string {
    return this.registerLinkedResource(profile, upstreamName, originalUri).exposedUri;
  }

  consumeResourceListChange(profile: string): boolean {
    const resourcesChanged = this.availabilityChanges.delete(this.availabilityKey("resources", profile));
    const templatesChanged = this.availabilityChanges.delete(this.availabilityKey("resource-templates", profile));
    return resourcesChanged || templatesChanged;
  }

  consumePromptListChange(profile: string): boolean {
    return this.availabilityChanges.delete(this.availabilityKey("prompts", profile));
  }

  private resolveCursor(kind: CursorKind, profile: string, cursor?: string): Map<string, string | undefined> {
    if (cursor === undefined) {
      return new Map([...this.upstreamNames()].sort().map((upstreamName) => [upstreamName, undefined]));
    }
    const state = this.cursors.get(cursor);
    if (!state || state.kind !== kind || state.profile !== profile) {
      const code =
        kind === "resources"
          ? "RESOURCE_CURSOR_INVALID"
          : kind === "resource-templates"
            ? "RESOURCE_TEMPLATE_CURSOR_INVALID"
            : "PROMPT_CURSOR_INVALID";
      throw new MiftahError(code, `${code}: cursor is not valid for profile '${profile}'`);
    }
    this.cursors.delete(cursor);
    this.cursors.set(cursor, state);
    return new Map(state.upstreamCursors);
  }

  private storeCursor(kind: CursorKind, profile: string, upstreamCursors: Map<string, string>): string | undefined {
    if (upstreamCursors.size === 0) return undefined;
    const cursor = `miftah-${kind}-${randomUUID()}`;
    while (this.cursors.size >= this.maximumCursors) {
      const oldest = this.cursors.keys().next().value;
      if (oldest === undefined) break;
      this.cursors.delete(oldest);
    }

    this.cursors.set(cursor, { kind, profile, upstreamCursors });
    return cursor;
  }

  private discoveryFailures<T>(
    results: PromiseSettledResult<T>[],
    pages: ReadonlyArray<readonly [string, string | undefined]>
  ): DiscoveryFailure[] {
    return results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const upstreamName = pages[index]?.[0];
      if (upstreamName === undefined) return [];
      const error = result.reason;
      const message = error instanceof Error ? error.message : String(error);
      return [
        {
          upstreamName,
          ...(error instanceof MiftahError ? { code: error.code } : {}),
          message: this.redact(message)
        }
      ];
    });
  }

  private assertDiscoveryAvailable(
    kind: CursorKind,
    profile: string,
    successfulUpstreams: number,
    failures: readonly DiscoveryFailure[]
  ): void {
    if (failures.length === 0) return;
    const strict = this.discoveryMode === "strict";
    if (!strict && successfulUpstreams > 0) return;
    this.clearCapability(profile, kind);
    if (
      kind === "resource-templates" &&
      successfulUpstreams === 0 &&
      failures.every((failure) => failure.code === "RESOURCE_TEMPLATES_UNAVAILABLE")
    ) {
      throw new MiftahError(
        "RESOURCE_TEMPLATES_UNAVAILABLE",
        `RESOURCE_TEMPLATES_UNAVAILABLE: no upstream implements resource templates for profile '${profile}'`
      );
    }
    const capability = kind === "resources" ? "resources" : kind === "prompts" ? "prompts" : "resource templates";
    const prefix = strict
      ? `strict ${capability} discovery failed`
      : `no healthy upstream completed ${capability} discovery`;
    throw new MiftahError(
      "UPSTREAM_DISCOVERY_FAILED",
      `UPSTREAM_DISCOVERY_FAILED: ${prefix} for profile '${profile}': ${failures
        .map((failure) => `upstream '${failure.upstreamName}' (${failure.message})`)
        .join("; ")}`,
      { profile, capability, failures }
    );
  }

  private clearCapability(profile: string, kind: CursorKind): void {
    if (kind === "resources") {
      this.resourceRoutes.delete(profile);
    } else if (kind === "resource-templates") {
      this.resourceTemplateRoutes.delete(profile);
    } else {
      this.promptRoutes.delete(profile);
    }

    this.clearCursors(profile, kind);
  }

  private clearCursors(profile: string, kind: CursorKind): void {
    for (const [cursor, state] of this.cursors) {
      if (state.profile === profile && state.kind === kind) this.cursors.delete(cursor);
    }
  }

  private updateAvailability(
    kind: CursorKind,
    profile: string,
    successfulUpstreams: readonly string[],
    failures: readonly DiscoveryFailure[]
  ): void {
    const byKind = this.availability.get(profile) ?? new Map<CursorKind, Map<string, boolean>>();
    this.availability.set(profile, byKind);
    const upstreams = byKind.get(kind) ?? new Map<string, boolean>();
    byKind.set(kind, upstreams);
    for (const upstreamName of successfulUpstreams) {
      this.updateUpstreamAvailability(kind, profile, upstreams, upstreamName, true);
    }
    for (const { upstreamName } of failures) {
      this.updateUpstreamAvailability(kind, profile, upstreams, upstreamName, false);
    }
  }

  private updateUpstreamAvailability(
    kind: CursorKind,
    profile: string,
    upstreams: Map<string, boolean>,
    upstreamName: string,
    available: boolean
  ): void {
    const previous = upstreams.get(upstreamName);
    if (previous !== undefined && previous !== available) {
      this.availabilityChanges.add(this.availabilityKey(kind, profile));
    }
    upstreams.set(upstreamName, available);
  }

  private availabilityKey(kind: CursorKind, profile: string): string {
    return `${kind}:${profile}`;
  }

  private assertRequestActive(options?: UpstreamRequestOptions): void {
    if (options?.signal?.aborted) throw new Error("Upstream request cancelled");
  }

  /**
   * Upstream counters belong to independent requests, so their totals cannot be
   * represented as one downstream total. Each settled upstream that reported
   * progress contributes one equal discovery unit; its final message is retained.
   */
  private aggregateDiscoveryProgress(
    options: UpstreamRequestOptions | undefined,
    upstreamCount: number
  ): DiscoveryProgressAggregator {
    if (options?.onprogress === undefined || upstreamCount <= 1) {
      return {
        optionsFor: () => options,
        complete: (): void => undefined
      };
    }

    const { onprogress, signal } = options;
    const completed = new Set<number>();
    const reported = new Set<number>();
    const messages = new Map<number, string | undefined>();
    return {
      optionsFor: (index) => ({
        ...options,
        onprogress: (progress) => {
          reported.add(index);
          messages.set(index, progress.message);
        }
      }),
      complete: (index) => {
        if (completed.has(index)) return;
        completed.add(index);
        if (!reported.has(index) || signal?.aborted) return;
        const message = messages.get(index);
        onprogress({
          progress: completed.size / upstreamCount,
          ...(message === undefined ? {} : { message })
        });
      }
    };
  }

  private assertCurrentEpoch(kind: CursorKind, profile: string, epoch: number): void {
    if (this.isCurrentEpoch(kind, profile, epoch)) return;
    const code =
      kind === "resources"
        ? "RESOURCE_DISCOVERY_INVALIDATED"
        : kind === "resource-templates"
          ? "RESOURCE_TEMPLATE_DISCOVERY_INVALIDATED"
          : "PROMPT_DISCOVERY_INVALIDATED";
    throw new MiftahError(code, `${code}: capability discovery was invalidated for profile '${profile}'; re-list it`);
  }

  private advanceEpoch(profile: string, kinds: readonly CursorKind[]): void {
    const epoch = this.captureEpoch(profile) + 1;
    this.epochs.set(profile, epoch);
    const capabilityEpochs = this.capabilityEpochs.get(profile) ?? new Map<CursorKind, number>();
    this.capabilityEpochs.set(profile, capabilityEpochs);
    for (const kind of kinds) capabilityEpochs.set(kind, epoch);
  }

  private isCurrentEpoch(kind: CursorKind, profile: string, epoch: number): boolean {
    if (epoch > this.captureEpoch(profile)) return false;
    return (this.capabilityEpochs.get(profile)?.get(kind) ?? 0) <= epoch;
  }

  private registerResourceTemplateRoute(
    routes: Map<string, ResourceTemplateRoute>,
    profile: string,
    upstreamName: string,
    originalUriTemplate: string,
    exposedName: string
  ): ResourceTemplateRoute {
    const variables = resourceTemplateVariables(originalUriTemplate);
    const exposedUriBase = namespaceResourceTemplateBase(upstreamName, randomUUID());
    const route: ResourceTemplateRoute = {
      profile,
      upstreamName,
      originalUriTemplate,
      exposedUriBase,
      exposedUriTemplate: namespaceResourceTemplateUri(exposedUriBase, variables),
      exposedName,
      variables
    };
    routes.set(exposedUriBase, route);
    return route;
  }

  private resolveTemplatedResource(profile: string, exposedUri: string): ResourceRoute | undefined {
    const routes = this.resourceTemplateRoutes.get(profile);
    if (!routes) return undefined;
    let url: URL;
    try {
      url = new URL(exposedUri);
    } catch {
      return undefined;
    }
    if (url.hash) return undefined;
    const route = routes.get(resourceTemplateBase(url));
    if (!route) return undefined;
    const variables = new Set(route.variables);
    if ([...url.searchParams.keys()].some((key) => !variables.has(key))) return undefined;
    const values: Record<string, string | string[]> = {};
    for (const variable of route.variables) {
      const matches = url.searchParams.getAll(variable);
      const [match] = matches;
      if (matches.length === 1 && match !== undefined) values[variable] = match;
      if (matches.length > 1) values[variable] = matches;
    }
    try {
      return {
        profile,
        upstreamName: route.upstreamName,
        originalUri: new UriTemplate(route.originalUriTemplate).expand(values),
        exposedUri
      };
    } catch {
      return undefined;
    }
  }

  private registerLinkedResource(profile: string, upstreamName: string, originalUri: string): ResourceRoute {
    const exposedUri = namespaceResourceUri(upstreamName, redactUri(this.redact(originalUri)));
    const routes = new Map(this.resourceRoutes.get(profile));
    const existing = routes.get(exposedUri);
    if (existing) {
      if (existing.upstreamName === upstreamName && existing.originalUri === originalUri) return existing;
      throw new MiftahError(
        "RESOURCE_COLLISION",
        `RESOURCE_COLLISION: multiple upstream resources resolve to '${exposedUri}' for profile '${profile}'`
      );
    }
    const route: ResourceRoute = { profile, upstreamName, originalUri, exposedUri };
    routes.set(exposedUri, route);
    this.resourceRoutes.set(profile, routes);
    return route;
  }

  private exposedLinkedResource(
    profile: string,
    upstreamName: string,
    originalUri: string,
    canRegister: boolean
  ): string {
    if (canRegister) {
      return this.registerLinkedResource(profile, upstreamName, originalUri).exposedUri;
    }
    // A request already bound to a route may complete, but invalidated maps cannot gain new callable routes.
    return namespaceResourceUri(upstreamName, redactUri(this.redact(originalUri)));
  }
}

function namespaceResourceUri(upstreamName: string, uri: string): string {
  return `miftah://resource/${encodeURIComponent(upstreamName)}?uri=${encodeURIComponent(uri)}`;
}

function namespaceResourceTemplateBase(upstreamName: string, id: string): string {
  return `miftah://template/${encodeURIComponent(upstreamName)}/${id}`;
}

function namespaceResourceTemplateUri(base: string, variables: readonly string[]): string {
  return variables.length === 0 ? base : `${base}{?${variables.join(",")}}`;
}

function resourceTemplateBase(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function resourceTemplateVariables(uriTemplate: string): readonly string[] {
  try {
    return [...new Set(new UriTemplate(uriTemplate).variableNames)];
  } catch {
    throw new MiftahError(
      "RESOURCE_TEMPLATE_UNSUPPORTED",
      "RESOURCE_TEMPLATE_UNSUPPORTED: an upstream resource template cannot be proxied safely"
    );
  }
}

function namespaceName(upstreamName: string, name: string): string {
  return `${upstreamName}__${name}`;
}

function redactResource(resource: Resource): Resource {
  return {
    ...resource,
    uri: redactUri(resource.uri),
    icons: redactIconSources(resource.icons)
  };
}

function redactResourceTemplate(template: ResourceTemplate): ResourceTemplate {
  return {
    ...template,
    uriTemplate: redactUri(template.uriTemplate),
    icons: redactIconSources(template.icons)
  };
}

function redactPrompt(prompt: Prompt): Prompt {
  return {
    ...prompt,
    icons: redactIconSources(prompt.icons)
  };
}

function redactIconSources<T extends { src: string }>(icons: readonly T[] | undefined) {
  return icons?.map((icon) => ({ ...icon, src: redactUri(icon.src) }));
}

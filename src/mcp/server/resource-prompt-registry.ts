import { randomUUID } from "node:crypto";
import type {
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  Prompt,
  ReadResourceResult,
  Resource
} from "@modelcontextprotocol/sdk/types.js";
import { redactUri } from "../../secrets/redact.js";
import { MiftahError } from "../../utils/errors.js";

export interface ResourceRoute {
  readonly profile: string;
  readonly upstreamName: string;
  readonly originalUri: string;
  readonly exposedUri: string;
  readonly exposedName?: string;
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
  params?: ListResourcesRequest["params"]
) => Promise<ListResourcesResult>;
type PromptDiscovery = (
  profile: string,
  upstreamName: string,
  params?: ListPromptsRequest["params"]
) => Promise<ListPromptsResult>;
type Redact = <T>(value: T) => T;
type CursorKind = "resources" | "prompts";
const defaultMaximumCursors = 256;

interface CursorState {
  readonly kind: CursorKind;
  readonly profile: string;
  readonly upstreamCursors: ReadonlyMap<string, string>;
}

/**
 * Holds exact per-profile routes for multi-upstream resource and prompt capabilities.
 */
export class ResourcePromptRegistry {
  private readonly resourceRoutes = new Map<string, Map<string, ResourceRoute>>();
  private readonly promptRoutes = new Map<string, Map<string, PromptRoute>>();
  private readonly cursors = new Map<string, CursorState>();
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly upstreamNames: () => string[],
    private readonly discoverResources: ResourceDiscovery,
    private readonly discoverPrompts: PromptDiscovery,
    private readonly redact: Redact,
    private readonly maximumCursors = defaultMaximumCursors
  ) {}

  async listResources(profile: string, cursor?: string): Promise<ListResourcesResult> {
    const epoch = this.captureEpoch(profile);
    const upstreamCursors = this.resolveCursor("resources", profile, cursor);
    const discovered = await Promise.all(
      [...upstreamCursors].map(async ([upstreamName, upstreamCursor]) => ({
        upstreamName,
        result: await this.discoverResources(profile, upstreamName, upstreamCursor ? { cursor: upstreamCursor } : undefined)
      }))
    );
    this.assertCurrentEpoch("resources", profile, epoch);
    const routes = new Map(this.resourceRoutes.get(profile));
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

  async listPrompts(profile: string, cursor?: string): Promise<ListPromptsResult> {
    const epoch = this.captureEpoch(profile);
    const upstreamCursors = this.resolveCursor("prompts", profile, cursor);
    const discovered = await Promise.all(
      [...upstreamCursors].map(async ([upstreamName, upstreamCursor]) => ({
        upstreamName,
        result: await this.discoverPrompts(profile, upstreamName, upstreamCursor ? { cursor: upstreamCursor } : undefined)
      }))
    );
    this.assertCurrentEpoch("prompts", profile, epoch);
    const routes = new Map(this.promptRoutes.get(profile));
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
    return this.resourceRoutes.get(profile)?.get(exposedUri);
  }

  resolvePrompt(profile: string, exposedName: string): PromptRoute | undefined {
    return this.promptRoutes.get(profile)?.get(exposedName);
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
    this.assertResourceEpoch(route.profile, epoch);
    const redacted = this.redact(result);
    return {
      ...redacted,
      contents: redacted.contents.map((content, index) =>
        result.contents[index]?.uri === route.originalUri
          ? { ...content, uri: route.exposedUri }
          : {
              ...content,
              uri: this.registerLinkedResource(route.profile, route.upstreamName, result.contents[index]?.uri ?? content.uri)
                .exposedUri
            }
      )
    };
  }

  redactPromptResult(route: PromptRoute, result: GetPromptResult, epoch: number): GetPromptResult {
    this.assertPromptEpoch(route.profile, epoch);
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
              uri: this.registerLinkedResource(route.profile, route.upstreamName, originalUri).exposedUri,
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
                uri: this.registerLinkedResource(route.profile, route.upstreamName, originalUri).exposedUri
              }
            }
          };
        }
        return message;
      })
    };
  }

  invalidate(profile: string): void {
    this.epochs.set(profile, this.captureEpoch(profile) + 1);
    this.resourceRoutes.delete(profile);
    this.promptRoutes.delete(profile);
    for (const [cursor, state] of this.cursors) {
      if (state.profile === profile) this.cursors.delete(cursor);
    }
  }

  private resolveCursor(kind: CursorKind, profile: string, cursor?: string): Map<string, string | undefined> {
    if (cursor === undefined) {
      return new Map([...this.upstreamNames()].sort().map((upstreamName) => [upstreamName, undefined]));
    }
    const state = this.cursors.get(cursor);
    if (!state || state.kind !== kind || state.profile !== profile) {
      const code = kind === "resources" ? "RESOURCE_CURSOR_INVALID" : "PROMPT_CURSOR_INVALID";
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

  private assertCurrentEpoch(kind: CursorKind, profile: string, epoch: number): void {
    if (this.captureEpoch(profile) === epoch) return;
    const code = kind === "resources" ? "RESOURCE_DISCOVERY_INVALIDATED" : "PROMPT_DISCOVERY_INVALIDATED";
    throw new MiftahError(code, `${code}: capability discovery was invalidated for profile '${profile}'; re-list it`);
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
}

function namespaceResourceUri(upstreamName: string, uri: string): string {
  return `miftah://resource/${encodeURIComponent(upstreamName)}?uri=${encodeURIComponent(uri)}`;
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

function redactPrompt(prompt: Prompt): Prompt {
  return {
    ...prompt,
    icons: redactIconSources(prompt.icons)
  };
}

function redactIconSources<T extends { src: string }>(icons: readonly T[] | undefined) {
  return icons?.map((icon) => ({ ...icon, src: redactUri(icon.src) }));
}

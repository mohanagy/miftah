import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type ListPromptsResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type Prompt,
  type ReadResourceResult,
  type ReadResourceRequest,
  type Resource,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { MiftahConfig } from "../../config/types.js";
import { redactSecrets, redactUri, redactUrisInText } from "../../secrets/redact.js";
import { ProfileManager } from "../../profiles/profile-manager.js";
import { RoutingEngine } from "../../routing/routing-engine.js";
import { PolicyEngine } from "../../policy/policy-engine.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { UpstreamProcessManager, type UpstreamHealth } from "../../upstream/upstream-process-manager.js";
import { MultiUpstreamProcessManager } from "../../upstream/multi-upstream-process-manager.js";
import type { UpstreamSession } from "../../upstream/upstream-session.js";
import { MiftahError } from "../../utils/errors.js";
import {
  OperationPipeline,
  type CapturedProfileState,
  type ResolvedOperation
} from "./operation-pipeline.js";
import { ResourcePromptRegistry } from "./resource-prompt-registry.js";
import {
  canonicalJson,
  ToolRegistry,
  type DiscoveredTools,
  type ToolDiscoveryResult,
  type ToolSnapshot
} from "./tool-registry.js";

const managementTools: Tool[] = [
  tool("miftah_list_profiles", "List configured profiles without exposing secrets."),
  tool("miftah_current_profile", "Show the active and default profile."),
  tool("miftah_use_profile", "Switch the active profile for this MCP session.", ["profile"]),
  tool("miftah_reset_profile", "Reset the active profile to the configured default."),
  tool("miftah_profile_info", "Show non-secret metadata for a profile.", ["profile"]),
  tool("miftah_health", "Show redacted wrapper and upstream health."),
  tool("miftah_validate_config", "Validate the loaded wrapper configuration."),
  tool("miftah_list_upstream_tools", "List tools discovered from an upstream profile.", ["profile"]),
  tool("miftah_restart_profile", "Restart all upstream processes for a profile.", ["profile"]),
  tool("miftah_route_preview", "Preview routing for a hypothetical tool call.", ["toolName"])
];

function tool(name: string, description: string, required: string[] = []): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: required.reduce<Record<string, { type: string }>>((result, key) => {
        result[key] = { type: key === "toolName" ? "string" : "string" };
        return result;
      }, {}),
      required
    }
  };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

interface ResourcePromptProxyAvailable {
  available: true;
  upstreamName?: string;
}

interface ResourcePromptProxyUnavailable {
  available: false;
  reason: string;
}

type ResourcePromptProxyAvailability = ResourcePromptProxyAvailable | ResourcePromptProxyUnavailable;

/** Hosts Miftah's MCP surface and coordinates profile routing, upstream discovery, and client notifications. */
export class MiftahServer {
  readonly server: Server;
  private readonly routing: RoutingEngine;
  private readonly policy: PolicyEngine;
  private readonly audit?: AuditLogger;
  private readonly resourcePromptProxy: ResourcePromptProxyAvailability;
  private readonly toolRegistry: ToolRegistry;
  private readonly operationPipeline: OperationPipeline;
  private readonly resourcePromptRegistry?: ResourcePromptRegistry;
  private readonly invalidatedToolSnapshots = new Map<string, ToolSnapshot>();
  private readonly restartingProfiles = new Map<string, Promise<void>>();
  private readonly pendingResourceListChanges = new Set<string>();
  private readonly pendingPromptListChanges = new Set<string>();

  constructor(
    private readonly config: MiftahConfig,
    private readonly profiles: ProfileManager,
    private readonly upstreams: UpstreamProcessManager | MultiUpstreamProcessManager
  ) {
    this.resourcePromptProxy = this.resourcePromptProxyAvailability();
    this.server = new Server(
      { name: `miftah-${config.name}`, version: "0.1.1" },
      {
        debouncedNotificationMethods: [
          "notifications/tools/list_changed",
          "notifications/resources/list_changed",
          "notifications/prompts/list_changed"
        ],
        capabilities: {
          tools: { listChanged: true },
          ...(this.resourcePromptProxy.available
            ? { resources: { listChanged: true }, prompts: { listChanged: true } }
            : {})
        },
        instructions: [
          "Miftah wraps an upstream MCP and routes requests through local credential profiles.",
          ...(this.resourcePromptProxy.available
            ? []
            : [this.resourcePromptProxy.reason])
        ].join(" ")
      }
    );
    this.routing = new RoutingEngine(config.routing, profiles.current().activeProfile, config.defaultProfile);
    this.policy = new PolicyEngine(config.policies, config.tooling?.toolRiskOverrides ?? {});
    this.toolRegistry = new ToolRegistry(
      (profile) => this.discoverTools(profile),
      (name, upstreamName) => this.exposedToolName(name, upstreamName)
    );
    if (this.upstreams instanceof MultiUpstreamProcessManager && this.upstreams.listUpstreams().length > 1) {
      const multiUpstreams = this.upstreams;
      this.resourcePromptRegistry = new ResourcePromptRegistry(
        () => multiUpstreams.listUpstreams(),
        (profile, upstreamName, params) => this.discoverResources(profile, upstreamName, params),
        (profile, upstreamName, params) => this.discoverPrompts(profile, upstreamName, params),
        (value) => redactSecrets(value, this.upstreams.getSecretValues()),
        undefined,
        config.tooling?.toolDiscoveryMode ?? "permissive"
      );
    }
    this.upstreams.addHealthListener((health) => this.handleUpstreamHealthChange(health));
    if (config.audit?.enabled !== false && config.audit?.path) {
      this.audit = new AuditLogger(config.audit.path, {
        includeArguments: config.audit.includeArguments,
        secretValues: []
      });
    }
    this.operationPipeline = new OperationPipeline({
      wrapper: config.name,
      profiles,
      routing: this.routing,
      policy: this.policy,
      upstreams,
      writeAudit: (event) => this.writeAudit(event)
    });
    this.registerHandlers();
  }

  connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.upstreams.close();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const snapshot = await this.activeToolSnapshot();
      return { tools: [...managementTools, ...snapshot.getTools()] };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      if (managementTools.some((tool) => tool.name === name)) return this.handleManagement(name, args);
      return this.handleUpstreamTool(name, args);
    });

    if (this.resourcePromptProxy.available) {
      const upstreamName = this.resourcePromptProxy.upstreamName;
      this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
        const profile = this.profiles.current().activeProfile;
        if (this.resourcePromptRegistry) {
          try {
            return await this.resourcePromptRegistry.listResources(profile, request.params?.cursor);
          } finally {
            await this.notifyResourceAvailabilityChange(profile);
          }
        }
        return redactSecrets(
          redactDirectResourceList(await this.discoverResources(profile, upstreamName, request.params)),
          this.upstreams.getSecretValues()
        );
      });

      this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const source = this.profiles.current();
        if (this.resourcePromptRegistry) {
          try {
            return await this.executeResourceRead(source, upstreamName, request.params);
          } finally {
            await this.notifyResourceAvailabilityChange(source.activeProfile);
          }
        }
        return this.executeResourceRead(source, upstreamName, request.params);
      });

      this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
        const profile = this.profiles.current().activeProfile;
        if (this.resourcePromptRegistry) {
          try {
            return await this.resourcePromptRegistry.listPrompts(profile, request.params?.cursor);
          } finally {
            await this.notifyPromptAvailabilityChange(profile);
          }
        }
        return redactSecrets(
          redactDirectPromptList(await this.discoverPrompts(profile, upstreamName, request.params)),
          this.upstreams.getSecretValues()
        );
      });

      this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const source = this.profiles.current();
        if (this.resourcePromptRegistry) {
          try {
            return await this.executePromptGet(source, upstreamName, request.params);
          } finally {
            await this.notifyPromptAvailabilityChange(source.activeProfile);
          }
        }
        return this.executePromptGet(source, upstreamName, request.params);
      });
    }
  }

  private async handleUpstreamTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const sourceState = this.profiles.current();
      const sourceProfile = sourceState.activeProfile;
      const previous = this.toolRegistry.peek(sourceProfile) ?? this.invalidatedToolSnapshots.get(sourceProfile);
      const sourceSnapshot = await this.toolRegistry.get(sourceProfile);
      if (this.profiles.current().revision === sourceState.revision && previous !== undefined) {
        await this.notifyToolListChanged(previous, sourceSnapshot);
        this.invalidatedToolSnapshots.delete(sourceProfile);
      }
      const mapped = sourceSnapshot.resolve(name);
      if (!mapped) {
        throw new MiftahError(
          "TOOL_NOT_FOUND",
          `TOOL_NOT_FOUND: tool '${name}' is not exposed for profile '${sourceProfile}'`
        );
      }
      return await this.operationPipeline.execute({
        source: sourceState,
        operation: "tools/call",
        routingName: mapped.originalName,
        policyName: mapped.originalName,
        name: mapped.originalName,
        args,
        requireExplicitRuleForDestructive: this.config.security?.requireExplicitProfileForDestructive,
        resolveTarget: async (profile) => {
          const target = (await this.toolRegistry.get(profile)).resolve(name);
          if (!target) {
            throw new MiftahError(
              "TOOL_NOT_FOUND",
              `TOOL_NOT_FOUND: tool '${name}' is not exposed for routed profile '${profile}'`
            );
          }
          if (target.fingerprint !== mapped.fingerprint) {
            throw new MiftahError(
              "TOOL_SCHEMA_MISMATCH",
              `TOOL_SCHEMA_MISMATCH: tool '${name}' has a different schema for routed profile '${profile}'`
            );
          }
          return {
            upstreamName: target.upstreamName,
            name: target.originalName,
            execute: (session) => session.callTool({ name: target.originalName, arguments: args }),
            redact: (result) => result
          };
        }
      });
    } catch (error) {
      const safeMessage = redactSecrets(
        redactUrisInText(error instanceof Error ? error.message : String(error)),
        this.upstreams.getSecretValues()
      );
      if (error instanceof MiftahError) {
        return textResult(safeMessage, true);
      }
      return textResult(`UPSTREAM_CALL_FAILED: ${safeMessage}`, true);
    }
  }

  private async handleManagement(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (name === "miftah_list_profiles") {
        const activeProfile = this.profiles.current().activeProfile;
        return textResult(JSON.stringify(this.profiles.list().map((profile) => ({
          ...profile,
          active: profile.name === activeProfile
        }))));
      }
      if (name === "miftah_current_profile") {
        const current = this.profiles.current();
        return textResult(
          JSON.stringify({
            activeProfile: current.activeProfile,
            defaultProfile: current.defaultProfile,
            routingMode: this.config.routing?.mode ?? "hybrid"
          })
        );
      }
      if (name === "miftah_use_profile") {
        const previousSnapshot = this.toolRegistry.peek(this.profiles.current().activeProfile);
        const profile = requiredString(args, "profile");
        const switched = this.profiles.switch(profile);
        this.routing.setActiveProfile(switched.activeProfile);
        this.invalidateResourcePromptProfiles(switched.previousProfile, switched.activeProfile);
        await this.notifyToolListChanged(previousSnapshot, this.toolRegistry.peek(switched.activeProfile));
        await this.notifyResourcePromptListChanged();
        return textResult(`Active profile changed from ${switched.previousProfile} to ${switched.activeProfile}.`);
      }
      if (name === "miftah_reset_profile") {
        const previousSnapshot = this.toolRegistry.peek(this.profiles.current().activeProfile);
        const reset = this.profiles.reset();
        this.routing.setActiveProfile(reset.activeProfile);
        this.invalidateResourcePromptProfiles(reset.previousProfile, reset.activeProfile);
        await this.notifyToolListChanged(previousSnapshot, this.toolRegistry.peek(reset.activeProfile));
        await this.notifyResourcePromptListChanged();
        return textResult(`Active profile reset from ${reset.previousProfile} to ${reset.activeProfile}.`);
      }
      if (name === "miftah_profile_info") return textResult(JSON.stringify(this.profiles.info(requiredString(args, "profile"))));
      if (name === "miftah_health") {
        return textResult(
          JSON.stringify({
            configValid: true,
            activeProfile: this.profiles.current().activeProfile,
            resourcePromptProxy: this.resourcePromptProxy.available
              ? { available: true }
              : { available: false, reason: this.resourcePromptProxy.reason },
            upstreams: this.upstreams.listHealth()
          })
        );
      }
      if (name === "miftah_validate_config") return textResult(JSON.stringify({ ok: true, errors: [] }));
      if (name === "miftah_list_upstream_tools") {
        const profile = args.profile === undefined ? this.profiles.current().activeProfile : requiredString(args, "profile");
        const tools = (await this.toolRegistry.get(profile)).getTools();
        return textResult(JSON.stringify(tools.map((item) => ({ name: item.name, description: item.description }))));
      }
      if (name === "miftah_restart_profile") {
        const profile = requiredString(args, "profile");
        await this.restartUpstreamProfile(profile);
        return textResult("Profile restarted.");
      }
      if (name === "miftah_route_preview") {
        const route = this.routing.resolve({
          toolName: requiredString(args, "toolName"),
          args: isRecord(args.args) ? args.args : {}
        });
        const profile = this.profiles.get(route.profile);
        return textResult(JSON.stringify({ ...route, policy: this.policy.evaluate(profile.policy, requiredString(args, "toolName")) }));
      }
      return textResult(`Unknown management tool '${name}'`, true);
    } catch (error) {
      const message = error instanceof MiftahError ? `${error.code}: ${error.message}` : String(error);
      return textResult(redactSecrets(message, this.upstreams.getSecretValues()), true);
    }
  }

  private exposedToolName(name: string, upstreamName?: string): string {
    if (upstreamName) return `${upstreamName}__${name}`;
    if (managementTools.some((item) => item.name === name)) {
      if ((this.config.tooling?.collisionStrategy ?? "prefix-upstream") === "fail") {
        throw new MiftahError("TOOL_COLLISION", `TOOL_COLLISION: upstream tool '${name}' is reserved by Miftah`);
      }
      return `upstream_${name}`;
    }
    return name;
  }

  private upstreamNames(): (string | undefined)[] {
    if (this.upstreams instanceof MultiUpstreamProcessManager) return this.upstreams.listUpstreams();
    return [undefined];
  }

  private async discoverTools(profile: string): Promise<ToolDiscoveryResult> {
    const profiles =
      this.config.tooling?.toolDiscoveryMode === "strict" ? Object.keys(this.config.profiles).sort() : [profile];
    const outcomes = await Promise.all(profiles.map(async (name) => [name, await this.discoverToolsForProfile(name)] as const));
    const failures = outcomes.flatMap(([profileName, outcome]) =>
      outcome.failures.map((failure) => ({ profile: profileName, ...failure }))
    );
    if (failures.length > 0 && this.config.tooling?.toolDiscoveryMode === "strict") {
      const activeFailures = failures
        .filter((failure) => failure.profile === profile)
        .map((failure) => `upstream '${failure.upstreamName}' (${failure.code}: ${failure.message})`);
      const otherFailures = failures
        .filter((failure) => failure.profile !== profile)
        .map((failure) => `profile '${failure.profile}', upstream '${failure.upstreamName}' (${failure.code}: ${failure.message})`);
      throw new MiftahError(
        "UPSTREAM_DISCOVERY_FAILED",
        `UPSTREAM_DISCOVERY_FAILED: strict tools discovery failed for profile '${profile}': ${[
          ...activeFailures,
          ...otherFailures
        ].join("; ")}`
      );
    }
    if (this.config.tooling?.toolDiscoveryMode === "strict") {
      this.assertStrictToolSchemas(outcomes);
    }
    const selected = outcomes.find(([profileName]) => profileName === profile);
    if (!selected) throw new Error(`Missing tool discovery result for profile '${profile}'`);
    if (selected[1].discovered.length === 0 && selected[1].failures.length > 0) {
      throw new MiftahError(
        "UPSTREAM_DISCOVERY_FAILED",
        `UPSTREAM_DISCOVERY_FAILED: no healthy upstream completed tools discovery for profile '${profile}': ${selected[1].failures
          .map((failure) => `upstream '${failure.upstreamName}' (${failure.code}: ${failure.message})`)
          .join("; ")}`
      );
    }
    return {
      discovered: selected[1].discovered,
      incomplete: selected[1].failures.length > 0
    };
  }

  private async discoverToolsForProfile(profile: string): Promise<{
    discovered: DiscoveredTools[];
    failures: Array<{ upstreamName: string; code: string; message: string }>;
  }> {
    const upstreamNames = this.upstreamNames();
    const discoveries = await Promise.allSettled(
      upstreamNames.map(async (upstreamName) => ({
        upstreamName,
        tools: await this.upstreams.listTools(profile, upstreamName)
      }))
    );
    return {
      discovered: discoveries.flatMap((discovery) => (discovery.status === "fulfilled" ? [discovery.value] : [])),
      failures: discoveries.flatMap((discovery, index) => {
        if (discovery.status === "fulfilled") return [];
        const error = discovery.reason;
        const code = error instanceof MiftahError ? error.code : "UPSTREAM_TOOL_LIST_FAILED";
        return [
          {
            upstreamName: upstreamNames[index] ?? "default",
            code,
            message: redactSecrets(error instanceof Error ? error.message : String(error), this.upstreams.getSecretValues())
          }
        ];
      })
    };
  }

  private assertStrictToolSchemas(
    outcomes: ReadonlyArray<
      readonly [
        string,
        {
          discovered: DiscoveredTools[];
          failures: Array<{ upstreamName: string; code: string; message: string }>;
        }
      ]
    >
  ): void {
    const snapshots = outcomes.map(([profile, outcome]) => [profile, this.toolFingerprints(profile, outcome.discovered)] as const);
    const [referenceProfile, reference] = snapshots[0] ?? [];
    if (!referenceProfile || !reference) return;
    const differences: string[] = [];
    for (const [profile, snapshot] of snapshots.slice(1)) {
      for (const name of new Set([...reference.keys(), ...snapshot.keys()])) {
        if (reference.get(name) !== snapshot.get(name)) {
          differences.push(`profiles '${referenceProfile}' and '${profile}' differ for tool '${name}'`);
        }
      }
    }
    if (differences.length > 0) {
      throw new MiftahError(
        "TOOL_SCHEMA_MISMATCH",
        `TOOL_SCHEMA_MISMATCH: strict tools discovery found different client-visible schemas: ${differences.join("; ")}`
      );
    }
  }

  private toolFingerprints(profile: string, discovered: DiscoveredTools[]): Map<string, string> {
    const fingerprints = new Map<string, string>();
    for (const { upstreamName, tools } of [...discovered].sort((left, right) =>
      (left.upstreamName ?? "").localeCompare(right.upstreamName ?? "")
    )) {
      for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
        const exposedName = this.exposedToolName(tool.name, upstreamName);
        const fingerprint = canonicalJson({ ...structuredClone(tool), name: exposedName });
        const existing = fingerprints.get(exposedName);
        if (existing !== undefined) {
          throw new MiftahError(
            "TOOL_COLLISION",
            `TOOL_COLLISION: multiple upstream tools resolve to '${exposedName}' for profile '${profile}'`
          );
        }
        fingerprints.set(exposedName, fingerprint);
      }
    }
    return fingerprints;
  }

  private resourcePromptProxyAvailability(): ResourcePromptProxyAvailability {
    if (!(this.upstreams instanceof MultiUpstreamProcessManager)) return { available: true };
    const upstreamNames = this.upstreams.listUpstreams();
    if (upstreamNames.length === 1) return { available: true, upstreamName: upstreamNames[0] };
    if (upstreamNames.length === 0) {
      return { available: false, reason: "No upstream is configured, so resource and prompt proxying is unavailable." };
    }
    return { available: true };
  }

  private async executeResourceRead(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: ReadResourceRequest["params"]
  ): Promise<ReadResourceResult> {
    return this.operationPipeline.execute({
      source,
      operation: "resources/read",
      routingName: "resources/read",
      policyName: "resources/read",
      name: params.uri,
      args: { uri: params.uri },
      resolveTarget: async (profile) => {
        if (this.resourcePromptRegistry) return this.resolveAggregatedResource(profile, params);
        return {
          ...(upstreamName === undefined ? {} : { upstreamName }),
          name: params.uri,
          execute: (session) => session.readResource(params),
          redact: redactDirectReadResult
        };
      }
    });
  }

  private async executePromptGet(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: GetPromptRequest["params"]
  ): Promise<GetPromptResult> {
    return this.operationPipeline.execute({
      source,
      operation: "prompts/get",
      routingName: "prompts/get",
      policyName: "prompts/get",
      name: params.name,
      args: { ...(params.arguments ?? {}), name: params.name },
      resolveTarget: async (profile) => {
        if (this.resourcePromptRegistry) return this.resolveAggregatedPrompt(profile, params);
        return {
          ...(upstreamName === undefined ? {} : { upstreamName }),
          name: params.name,
          execute: (session) => session.getPrompt(params),
          redact: redactDirectPromptResult
        };
      }
    });
  }

  private async discoverResources(
    profile: string,
    upstreamName: string | undefined,
    params?: ListResourcesRequest["params"]
  ): Promise<ListResourcesResult> {
    try {
      const result = await this.callUpstream(profile, upstreamName, (session) => session.listResources(params));
      this.upstreams.recordCapabilitySuccess(profile, "resources", upstreamName);
      return result;
    } catch (error) {
      this.upstreams.recordCapabilityFailure(profile, "resources", error, upstreamName);
      throw error;
    }
  }

  private async discoverPrompts(
    profile: string,
    upstreamName: string | undefined,
    params?: ListPromptsRequest["params"]
  ): Promise<ListPromptsResult> {
    try {
      const result = await this.callUpstream(profile, upstreamName, (session) => session.listPrompts(params));
      this.upstreams.recordCapabilitySuccess(profile, "prompts", upstreamName);
      return result;
    } catch (error) {
      this.upstreams.recordCapabilityFailure(profile, "prompts", error, upstreamName);
      throw error;
    }
  }

  private async callUpstream<Result>(
    profile: string,
    upstreamName: string | undefined,
    operation: (session: UpstreamSession) => Promise<Result>
  ): Promise<Result> {
    try {
      const session = await this.upstreams.get(profile, upstreamName);
      return await operation(session);
    } catch (error) {
      const safeMessage = redactSecrets(
        redactUrisInText(error instanceof Error ? error.message : String(error)),
        this.upstreams.getSecretValues()
      );
      throw new Error(safeMessage, { cause: error });
    }
  }

  private async resolveAggregatedResource(
    profile: string,
    params: ReadResourceRequest["params"]
  ): Promise<ResolvedOperation<ReadResourceResult>> {
    if (!this.resourcePromptRegistry) throw new Error("Resource aggregation is unavailable");
    const registry = this.resourcePromptRegistry;
    let epoch = registry.captureEpoch(profile);
    let route = registry.resolveResource(profile, params.uri);
    if (!route) {
      await this.listResourcesForCapturedOperation(profile, registry);
      epoch = registry.captureEpoch(profile);
      registry.assertResourceEpoch(profile, epoch);
      route = registry.resolveResource(profile, params.uri);
    }
    if (!route) {
      throw new MiftahError(
        "RESOURCE_NOT_FOUND",
        `RESOURCE_NOT_FOUND: resource '${redactUri(params.uri)}' is not exposed for profile '${profile}'`
      );
    }
    registry.assertResourceEpoch(profile, epoch);
    return {
      upstreamName: route.upstreamName,
      name: route.originalUri,
      execute: (session) => session.readResource({ ...params, uri: route.originalUri }),
      redact: (result) => registry.redactReadResult(route, result, epoch)
    };
  }

  private async resolveAggregatedPrompt(
    profile: string,
    params: GetPromptRequest["params"]
  ): Promise<ResolvedOperation<GetPromptResult>> {
    if (!this.resourcePromptRegistry) throw new Error("Prompt aggregation is unavailable");
    const registry = this.resourcePromptRegistry;
    let epoch = registry.captureEpoch(profile);
    let route = registry.resolvePrompt(profile, params.name);
    if (!route) {
      await this.listPromptsForCapturedOperation(profile, registry);
      epoch = registry.captureEpoch(profile);
      registry.assertPromptEpoch(profile, epoch);
      route = registry.resolvePrompt(profile, params.name);
    }
    if (!route) {
      throw new MiftahError(
        "PROMPT_NOT_FOUND",
        `PROMPT_NOT_FOUND: prompt '${params.name}' is not exposed for profile '${profile}'`
      );
    }
    registry.assertPromptEpoch(profile, epoch);
    return {
      upstreamName: route.upstreamName,
      name: route.originalName,
      execute: (session) => session.getPrompt({ ...params, name: route.originalName }),
      redact: (result) => registry.redactPromptResult(route, result, epoch)
    };
  }

  private async listResourcesForCapturedOperation(profile: string, registry: ResourcePromptRegistry): Promise<void> {
    try {
      await registry.listResources(profile);
    } catch (error) {
      if (!(error instanceof MiftahError) || error.code !== "RESOURCE_DISCOVERY_INVALIDATED") throw error;
      await registry.listResources(profile);
    } finally {
      await this.notifyResourceAvailabilityChange(profile);
    }
  }

  private async listPromptsForCapturedOperation(profile: string, registry: ResourcePromptRegistry): Promise<void> {
    try {
      await registry.listPrompts(profile);
    } catch (error) {
      if (!(error instanceof MiftahError) || error.code !== "PROMPT_DISCOVERY_INVALIDATED") throw error;
      await registry.listPrompts(profile);
    } finally {
      await this.notifyPromptAvailabilityChange(profile);
    }
  }

  private async writeAudit(event: Parameters<AuditLogger["log"]>[0]): Promise<void> {
    if (this.audit) await this.audit.log(redactSecrets(event, this.upstreams.getSecretValues()));
  }

  private async activeToolSnapshot(): Promise<ToolSnapshot> {
    for (;;) {
      const state = this.profiles.current();
      const previous =
        this.toolRegistry.peek(state.activeProfile) ?? this.invalidatedToolSnapshots.get(state.activeProfile);
      const snapshot = await this.toolRegistry.get(state.activeProfile);
      if (this.profiles.current().revision === state.revision) {
        if (previous !== undefined) await this.notifyToolListChanged(previous, snapshot);
        this.invalidatedToolSnapshots.delete(state.activeProfile);
        return snapshot;
      }
    }
  }

  private restartUpstreamProfile(profile: string): Promise<void> {
    const existing = this.restartingProfiles.get(profile);
    if (existing) return existing;
    const restart = this.restartUpstreamProfileOnce(profile);
    this.restartingProfiles.set(profile, restart);
    void restart.then(
      () => {
        if (this.restartingProfiles.get(profile) === restart) this.restartingProfiles.delete(profile);
      },
      () => {
        if (this.restartingProfiles.get(profile) === restart) this.restartingProfiles.delete(profile);
      }
    );
    return restart;
  }

  private async restartUpstreamProfileOnce(profile: string): Promise<void> {
    try {
      if (this.upstreams instanceof MultiUpstreamProcessManager) {
        await this.upstreams.restartProfile(profile);
      } else {
        await this.upstreams.restart(profile);
      }
    } finally {
      this.toolRegistry.invalidate(profile);
      this.resourcePromptRegistry?.invalidate(profile);
      if (profile === this.profiles.current().activeProfile) {
        await this.notifyToolListChanged(undefined, undefined);
        await this.notifyResourcePromptListChanged();
      }
    }
  }

  private handleUpstreamHealthChange(health: UpstreamHealth): void {
    if (health.processState !== "failed" || this.restartingProfiles.has(health.profile)) return;
    if (this.config.tooling?.toolDiscoveryMode === "strict") {
      const snapshots = Object.keys(this.config.profiles).map((profile) => [profile, this.toolRegistry.peek(profile)] as const);
      if (!snapshots.some(([, snapshot]) => snapshot?.isComplete())) return;
      for (const [profile, snapshot] of snapshots) {
        if (snapshot?.isComplete()) this.invalidatedToolSnapshots.set(profile, snapshot);
        this.toolRegistry.invalidate(profile);
      }
      if (health.profile === this.profiles.current().activeProfile) {
        this.invalidateResourcePromptAfterUpstreamFailure(health.profile);
      }
      return;
    }
    const snapshot = this.toolRegistry.peek(health.profile);
    if (!snapshot || !snapshot.isComplete()) return;
    this.invalidatedToolSnapshots.set(health.profile, snapshot);
    this.toolRegistry.invalidate(health.profile);
    this.invalidateResourcePromptAfterUpstreamFailure(health.profile);
  }

  private invalidateResourcePromptAfterUpstreamFailure(profile: string): void {
    if (this.resourcePromptRegistry) {
      const hadResources = this.resourcePromptRegistry.hasResourceRoutes(profile);
      const hadPrompts = this.resourcePromptRegistry.hasPromptRoutes(profile);
      this.resourcePromptRegistry.invalidate(profile);
      if (hadResources) this.pendingResourceListChanges.add(profile);
      if (hadPrompts) this.pendingPromptListChanges.add(profile);
    }
  }

  private async notifyToolListChanged(
    previous: ReturnType<ToolRegistry["peek"]>,
    next: ReturnType<ToolRegistry["peek"]>
  ): Promise<void> {
    if (!this.toolRegistry.hasSameTools(previous, next) && this.server.transport) {
      await this.server.sendToolListChanged();
    }
  }

  private async notifyResourcePromptListChanged(): Promise<void> {
    await Promise.all([this.notifyResourceListChanged(), this.notifyPromptListChanged()]);
  }

  private async notifyResourceAvailabilityChange(profile: string): Promise<void> {
    const pending = this.pendingResourceListChanges.delete(profile);
    if (pending || this.resourcePromptRegistry?.consumeResourceListChange(profile)) {
      await this.notifyResourceListChanged();
    }
  }

  private async notifyPromptAvailabilityChange(profile: string): Promise<void> {
    const pending = this.pendingPromptListChanges.delete(profile);
    if (pending || this.resourcePromptRegistry?.consumePromptListChange(profile)) {
      await this.notifyPromptListChanged();
    }
  }

  private async notifyResourceListChanged(): Promise<void> {
    if (this.resourcePromptProxy.available && this.server.transport) {
      await this.server.sendResourceListChanged();
    }
  }

  private async notifyPromptListChanged(): Promise<void> {
    if (this.resourcePromptProxy.available && this.server.transport) {
      await this.server.sendPromptListChanged();
    }
  }

  private invalidateResourcePromptProfiles(...profiles: string[]): void {
    for (const profile of new Set(profiles)) {
      this.resourcePromptRegistry?.invalidate(profile);
      this.pendingResourceListChanges.delete(profile);
      this.pendingPromptListChanges.delete(profile);
    }
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MiftahError("CONFIG_SCHEMA_INVALID", `CONFIG_SCHEMA_INVALID: '${key}' must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactDirectResourceList(result: ListResourcesResult): ListResourcesResult {
  return {
    ...result,
    resources: result.resources.map(redactDirectResource)
  };
}

function redactDirectPromptList(result: ListPromptsResult): ListPromptsResult {
  return {
    ...result,
    prompts: result.prompts.map(redactDirectPrompt)
  };
}

function redactDirectReadResult(result: ReadResourceResult): ReadResourceResult {
  return {
    ...result,
    contents: result.contents.map((content) => ({ ...content, uri: redactSensitiveUri(content.uri) }))
  };
}

function redactDirectPromptResult(result: GetPromptResult): GetPromptResult {
  return {
    ...result,
    messages: result.messages.map((message) => {
      if (message.content.type === "resource_link") {
        return {
          ...message,
          content: {
            ...message.content,
            uri: redactSensitiveUri(message.content.uri),
            icons: redactDirectIconSources(message.content.icons)
          }
        };
      }
      if (message.content.type === "resource") {
        return {
          ...message,
          content: {
            ...message.content,
            resource: {
              ...message.content.resource,
              uri: redactSensitiveUri(message.content.resource.uri)
            }
          }
        };
      }
      return message;
    })
  };
}

function redactDirectResource(resource: Resource): Resource {
  return {
    ...resource,
    uri: redactSensitiveUri(resource.uri),
    icons: redactDirectIconSources(resource.icons)
  };
}

function redactDirectPrompt(prompt: Prompt): Prompt {
  return {
    ...prompt,
    icons: redactDirectIconSources(prompt.icons)
  };
}

function redactDirectIconSources<T extends { src: string }>(icons: readonly T[] | undefined) {
  return icons?.map((icon) => ({ ...icon, src: redactSensitiveUri(icon.src) }));
}

function redactSensitiveUri(uri: string): string {
  try {
    const value = new URL(uri);
    if (!value.username && !value.password && !value.hash && value.search.length === 0) return uri;
  } catch {
    return uri;
  }
  return redactUri(uri);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  RootsListChangedNotificationSchema,
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
import type { MiftahConfig, ToolingConfig } from "../../config/types.js";
import { ApprovalStore, type ApprovalBinding, type ApprovalSummary } from "../../approvals/approval-store.js";
import { SecretRedactor, redactUri } from "../../secrets/redact.js";
import {
  bindProfileTransitionConfirmationVerifier,
  ProfileManager,
  type ProfileTransitionOptions
} from "../../profiles/profile-manager.js";
import { RoutingEngine } from "../../routing/routing-engine.js";
import type {
  RoutingContextMcpRoot,
  RoutingContextSnapshot
} from "../../routing/routing-types.js";
import { PolicyEngine } from "../../policy/policy-engine.js";
import type { ToolRiskMetadata } from "../../policy/risk-classifier.js";
import { IdentityManager } from "../../identity/identity-manager.js";
import type { IdentityStatus } from "../../identity/identity-types.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { AuditScope, AuditTrail, type AuditProfileInput, type AuditScopeResult } from "../../audit/audit-trail.js";
import type { ApprovalAuditAction, AuditStatus, ProfileAuditAction } from "../../audit/audit-types.js";
import {
  UpstreamProcessManager,
  type UpstreamHealth,
  type UpstreamLifecycleEvent
} from "../../upstream/upstream-process-manager.js";
import { MultiUpstreamProcessManager } from "../../upstream/multi-upstream-process-manager.js";
import type { UpstreamSession } from "../../upstream/upstream-session.js";
import { MiftahError } from "../../utils/errors.js";
import { MIFTAH_VERSION } from "../../version.js";
import {
  OperationPipeline,
  type ApprovalRequestContext,
  type CapturedProfileState,
  type ResolvedOperation
} from "./operation-pipeline.js";
import { ResourcePromptRegistry } from "./resource-prompt-registry.js";
import {
  canonicalJson,
  ToolRegistry,
  type DiscoveredTools,
  type RegisteredTool,
  type ToolDiscoveryResult,
  type ToolSnapshot
} from "./tool-registry.js";

const managementTools: Tool[] = [
  tool("miftah_list_profiles", "List configured profiles without exposing secrets."),
  tool("miftah_current_profile", "Show the active and default profile."),
  tool("miftah_use_profile", "Switch the active profile according to the configured state scope.", ["profile"]),
  tool("miftah_reset_profile", "Reset the active profile to the configured default."),
  tool("miftah_lock_profile", "Lock the current profile for this MCP connection when enabled."),
  tool("miftah_unlock_profile", "Unlock the current profile for this MCP connection when enabled."),
  tool("miftah_profile_info", "Show non-secret metadata for a profile.", ["profile"]),
  tool("miftah_health", "Show redacted wrapper and upstream health."),
  tool("miftah_validate_config", "Validate the loaded wrapper configuration."),
  tool("miftah_list_upstream_tools", "List tools discovered from an upstream profile.", ["profile"]),
  tool("miftah_restart_profile", "Restart all upstream processes for a profile.", ["profile"]),
  tool("miftah_verify_identity", "Explicitly verify configured upstream identity.", [], ["profile", "upstream"]),
  tool("miftah_route_preview", "Preview routing for a hypothetical tool call.", ["toolName"]),
  tool("miftah_list_approvals", "List safe metadata for approvals pending in this connection."),
  tool("miftah_approve", "Approve a pending operation using its one-time approval token.", ["approval"]),
  tool("miftah_deny", "Deny a pending operation using its one-time approval token.", ["approval"])
];

const EMPTY_MCP_ROOTS: readonly RoutingContextMcpRoot[] = Object.freeze([]);
const emptyRoutingContext: RoutingContextSnapshot = {
  context: Object.freeze({}),
  evidence: Object.freeze({ cwd: "", fileRoots: Object.freeze([]) }),
  profileHints: Object.freeze([])
};

export type RoutingContextCollector = (
  roots: readonly RoutingContextMcpRoot[]
) => Promise<RoutingContextSnapshot>;

export function resolveClientVisibleToolName(
  name: string,
  upstreamName: string | undefined,
  collisionStrategy: ToolingConfig["collisionStrategy"]
): string {
  if (upstreamName) return `${upstreamName}__${name}`;
  if (managementTools.some((item) => item.name === name)) {
    if ((collisionStrategy ?? "prefix-upstream") === "fail") {
      throw new MiftahError("TOOL_COLLISION", `TOOL_COLLISION: upstream tool '${name}' is reserved by Miftah`);
    }
    return `upstream_${name}`;
  }
  return name;
}

/** Checks that a cached routed tool still denotes the same upstream operation before using its risk hints. */
export function hasCompatibleCachedToolTarget(
  source: RegisteredTool | undefined,
  target: RegisteredTool | undefined
): target is RegisteredTool {
  return (
    source !== undefined &&
    target !== undefined &&
    source.fingerprint === target.fingerprint &&
    source.originalName === target.originalName &&
    source.upstreamName === target.upstreamName
  );
}

function tool(name: string, description: string, required: string[] = [], optional: string[] = []): Tool {
  const fields = [...new Set([...required, ...optional])];
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: fields.reduce<Record<string, { type: string }>>((result, key) => {
        result[key] = { type: "string" };
        return result;
      }, {}),
      required
    }
  };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function managementOperation(name: string): string {
  if (name === "miftah_use_profile") return "profiles/switch";
  if (name === "miftah_reset_profile") return "profiles/reset";
  if (name === "miftah_lock_profile") return "profiles/lock";
  if (name === "miftah_unlock_profile") return "profiles/unlock";
  if (name === "miftah_restart_profile") return "upstreams/restart";
  return `management/${name.replace(/^miftah_/, "").replaceAll("_", "-")}`;
}

function managementName(name: string, args: Record<string, unknown>): string {
  if (name === "miftah_use_profile" || name === "miftah_restart_profile" || name === "miftah_profile_info") {
    return typeof args.profile === "string" ? args.profile : "profile";
  }
  if (name === "miftah_reset_profile") return "default";
  if (name === "miftah_lock_profile" || name === "miftah_unlock_profile") return "active-profile";
  if (name === "miftah_list_profiles") return "profiles";
  if (name === "miftah_list_upstream_tools") return typeof args.profile === "string" ? args.profile : "active-profile";
  return name;
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

type ApprovalResolution =
  | { readonly kind: "consumed" }
  | { readonly kind: "fallback"; readonly token: string }
  | { readonly kind: "form"; readonly token: string };

interface ApprovalErrorFactory {
  required(binding: ApprovalBinding, token: string): MiftahError;
  notAccepted(binding: ApprovalBinding): MiftahError;
}

interface ProfileAuditRequest {
  readonly action: ProfileAuditAction;
  readonly input: {
    readonly sourceProfile: string;
    readonly profile: string;
    readonly operation: string;
    readonly name: string;
    readonly state?: CapturedProfileState;
  };
}

interface ProfileTransitionConfirmationBinding {
  readonly session: number;
  readonly action: "switch" | "reset";
  readonly profile: string;
  readonly revision: number;
}

type ProfileStateSnapshot = ReturnType<ProfileManager["current"]>;

const genericApprovalErrors: ApprovalErrorFactory = {
  required: (binding, token) =>
    new MiftahError(
      "POLICY_CONFIRMATION_REQUIRED",
      `POLICY_CONFIRMATION_REQUIRED: approval required for '${binding.displayName}'. Use miftah_approve with approval '${token}' then retry the exact operation.`
    ),
  notAccepted: (binding) =>
    new MiftahError(
      "POLICY_CONFIRMATION_REQUIRED",
      `POLICY_CONFIRMATION_REQUIRED: approval was not accepted for '${binding.displayName}'`
    )
};

const profileSwitchApprovalErrors: ApprovalErrorFactory = {
  required: (binding, token) =>
    new MiftahError(
      "PROFILE_SWITCH_CONFIRMATION_REQUIRED",
      `PROFILE_SWITCH_CONFIRMATION_REQUIRED: confirmation required for ${binding.displayName}. Use miftah_approve with approval '${token}' then retry the exact operation.`
    ),
  notAccepted: (binding) =>
    new MiftahError(
      "PROFILE_SWITCH_CONFIRMATION_REQUIRED",
      `PROFILE_SWITCH_CONFIRMATION_REQUIRED: confirmation was not accepted for ${binding.displayName}`
    )
};

/** Hosts Miftah's MCP surface and coordinates profile routing, upstream discovery, and client notifications. */
export class MiftahServer {
  readonly server: Server;
  private readonly routing: RoutingEngine;
  private readonly policy: PolicyEngine;
  private readonly audit?: AuditLogger;
  private readonly auditTrail: AuditTrail;
  private readonly redactor: SecretRedactor;
  private readonly resourcePromptProxy: ResourcePromptProxyAvailability;
  private readonly toolRegistry: ToolRegistry;
  private readonly operationPipeline: OperationPipeline;
  private readonly approvals = new ApprovalStore();
  /** One-time, connection-bound proofs accepted only by the profile manager attached to this server. */
  private profileTransitionConfirmations = new WeakMap<object, ProfileTransitionConfirmationBinding>();
  private profileTransitionSession = 0;
  private readonly identities: IdentityManager;
  private readonly resourcePromptRegistry?: ResourcePromptRegistry;
  private readonly invalidatedToolSnapshots = new Map<string, ToolSnapshot>();
  private readonly restartingProfiles = new Map<string, Promise<void>>();
  private readonly pendingResourceListChanges = new Set<string>();
  private readonly pendingPromptListChanges = new Set<string>();
  /** Serializes approval state changes through their audit records; native elicitation runs outside this queue. */
  private approvalTransitions: Promise<void> = Promise.resolve();
  private profileTransitions: Promise<void> = Promise.resolve();
  private mcpRoots: readonly RoutingContextMcpRoot[] = EMPTY_MCP_ROOTS;
  private mcpRootsReady: Promise<void> = Promise.resolve();
  private resolveMcpRootsReady: () => void = () => undefined;
  private mcpRootsRefresh?: Promise<void>;
  private mcpRootsRefreshRequested = false;
  private mcpRootsConnection = 0;
  private mcpRootsInitialized = false;
  private readonly provideRoutingContext = async (): Promise<RoutingContextSnapshot> => {
    if (this.routingContextCollector === undefined) return emptyRoutingContext;
    if (!this.mcpRootsInitialized) return this.routingContextCollector(EMPTY_MCP_ROOTS);
    await this.mcpRootsReady;
    return this.routingContextCollector(this.mcpRoots);
  };

  constructor(
    private readonly config: MiftahConfig,
    private readonly profiles: ProfileManager,
    private readonly upstreams: UpstreamProcessManager | MultiUpstreamProcessManager,
    private readonly routingContextCollector?: RoutingContextCollector
  ) {
    bindProfileTransitionConfirmationVerifier(profiles, (request) => {
      const binding = this.profileTransitionConfirmations.get(request.proof);
      this.profileTransitionConfirmations.delete(request.proof);
      return (
        binding !== undefined &&
        binding.session === this.profileTransitionSession &&
        binding.action === request.action &&
        binding.profile === request.profile &&
        binding.revision === request.revision
      );
    });
    this.redactor = upstreams.getRedactor();
    this.resourcePromptProxy = this.resourcePromptProxyAvailability();
    this.server = new Server(
      { name: `miftah-${config.name}`, version: MIFTAH_VERSION },
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
    this.policy = new PolicyEngine(config.policies, config.tooling?.toolRiskOverrides ?? {}, {
      unknownRisk: config.tooling?.unknownToolRisk
    });
    this.identities = new IdentityManager(config);
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
        (value) => this.redactor.redact(value),
        undefined,
        config.tooling?.toolDiscoveryMode ?? "permissive"
      );
    }
    this.upstreams.addHealthListener((health) => this.handleUpstreamHealthChange(health));
    if (config.audit?.enabled !== false && config.audit?.path) {
      this.audit = new AuditLogger(config.audit.path, {
        includeArguments: config.audit.includeArguments,
        redactor: this.redactor,
        failureMode: config.audit.failureMode
      });
    }
    this.auditTrail = new AuditTrail(config.name, this.audit);
    this.upstreams.addLifecycleListener((event) => {
      this.identities.invalidate(event.profile, event.upstreamName);
      this.recordUpstreamLifecycle(event);
    });
    this.operationPipeline = new OperationPipeline({
      profiles,
      routing: this.routing,
      policy: this.policy,
      upstreams,
      redactor: this.redactor,
      routingContext: this.provideRoutingContext,
      identities: this.identities,
      approvals: { requireApproval: (binding, context) => this.requireApproval(binding, context) },
      profileAudits: {
        leaseExpired: ({ source, profile, operation }) =>
          this.writeProfileAction("lease-expired", {
            sourceProfile: source.activeProfile,
            profile,
            operation,
            name: profile,
            state: {
              ...source,
              lease:
                "expiresAt" in source.lease
                  ? { ...source.lease, state: "expired" }
                  : source.lease
            }
          })
      }
    });
    this.server.oninitialized = () => this.handleClientInitialized();
    this.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      if (
        this.routingContextCollector === undefined ||
        !this.mcpRootsInitialized ||
        this.server.getClientCapabilities()?.roots?.listChanged !== true
      ) {
        return;
      }
      void this.refreshMcpRoots().then(
        () => undefined,
        () => undefined
      );
    });
    this.registerHandlers();
  }

  async connect(transport: Transport): Promise<void> {
    await this.profileTransitions;
    this.profileTransitionSession += 1;
    this.profileTransitionConfirmations = new WeakMap<object, ProfileTransitionConfirmationBinding>();
    await this.enqueueApprovalTransition(async () => {
      this.approvals.beginSession();
    });
    const previousProfile = this.profiles.current().activeProfile;
    await this.profiles.beginSession();
    const activeProfile = this.profiles.current().activeProfile;
    this.routing.setActiveProfile(activeProfile);
    if (previousProfile !== activeProfile) this.invalidateResourcePromptProfiles(previousProfile, activeProfile);
    this.resetMcpRoots();
    await this.server.connect(transport);
    await this.auditTrail.writeLifecycle({
      operation: "wrapper/start",
      name: this.config.name,
      profile: this.profiles.current().activeProfile,
      lockToProfile: this.config.security?.lockToProfile ?? undefined,
      status: "success"
    }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.profileTransitionSession += 1;
    this.profileTransitionConfirmations = new WeakMap<object, ProfileTransitionConfirmationBinding>();
    await this.server.close();
    await this.upstreams.close();
    await this.auditTrail.writeLifecycle({
      operation: "wrapper/shutdown",
      name: this.config.name,
      profile: this.profiles.current().activeProfile,
      status: "success"
    }).catch(() => undefined);
  }

  private resetMcpRoots(): void {
    this.mcpRootsConnection += 1;
    this.mcpRoots = EMPTY_MCP_ROOTS;
    this.mcpRootsRefresh = undefined;
    this.mcpRootsRefreshRequested = false;
    this.mcpRootsInitialized = false;
    this.mcpRootsReady = new Promise<void>((resolve) => {
      this.resolveMcpRootsReady = resolve;
    });
  }

  private handleClientInitialized(): void {
    this.mcpRootsInitialized = true;
    if (this.routingContextCollector === undefined || this.server.getClientCapabilities()?.roots === undefined) {
      this.resolveMcpRootsReady();
      return;
    }
    void this.refreshMcpRoots().then(
      () => this.resolveMcpRootsReady(),
      () => this.resolveMcpRootsReady()
    );
  }

  private refreshMcpRoots(): Promise<void> {
    const pending = this.mcpRootsRefresh;
    if (pending) {
      this.mcpRootsRefreshRequested = true;
      return pending;
    }

    const connection = this.mcpRootsConnection;
    const refresh = this.refreshMcpRootsUntilCurrent(connection);
    this.mcpRootsRefresh = refresh;
    void refresh.then(
      () => {
        if (this.mcpRootsRefresh === refresh) this.mcpRootsRefresh = undefined;
      },
      () => {
        if (this.mcpRootsRefresh === refresh) this.mcpRootsRefresh = undefined;
      }
    );
    return refresh;
  }

  private async refreshMcpRootsUntilCurrent(connection: number): Promise<void> {
    do {
      this.mcpRootsRefreshRequested = false;
      await this.fetchMcpRoots(connection);
    } while (connection === this.mcpRootsConnection && this.mcpRootsRefreshRequested);
  }

  private async fetchMcpRoots(connection: number): Promise<void> {
    if (
      this.routingContextCollector === undefined ||
      !this.mcpRootsInitialized ||
      this.server.getClientCapabilities()?.roots === undefined
    ) {
      if (connection === this.mcpRootsConnection) this.mcpRoots = EMPTY_MCP_ROOTS;
      return;
    }
    try {
      const result = await this.server.listRoots();
      if (connection !== this.mcpRootsConnection) return;
      this.mcpRoots = Object.freeze(result.roots.map(({ uri }) => Object.freeze({ uri })));
    } catch {
      if (connection === this.mcpRootsConnection) this.mcpRoots = EMPTY_MCP_ROOTS;
    }
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const source = await this.captureStableProfileState();
      return this.runAudited(
        { operation: "tools/list", name: "tools", sourceProfile: source.activeProfile },
        async (audit) => {
          const upstream = this.auditUpstreamName();
          if (upstream) audit.update({ upstream });
          const { profile, snapshot } = await this.activeToolSnapshot();
          audit.update({ profile });
          return { tools: [...managementTools, ...snapshot.getTools()] };
        }
      );
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const source = await this.captureStableProfileState();
      const isManagementTool = managementTools.some((tool) => tool.name === name);
      const isApprovalManagementTool = name === "miftah_approve" || name === "miftah_deny";
      return this.runAudited(
        {
          operation: isManagementTool ? managementOperation(name) : "tools/call",
          name: isManagementTool ? managementName(name, args) : name,
          sourceProfile: source.activeProfile,
          ...(isApprovalManagementTool ? {} : { arguments: args })
        },
        (audit) =>
          isManagementTool
            ? this.handleManagement(name, args, audit, source, {
                requestId: extra.requestId,
                signal: extra.signal
              })
            : this.handleUpstreamTool(name, args, audit, source, {
                requestId: extra.requestId,
                signal: extra.signal
              }),
        (error) => textResult(error.message, true),
        (result) =>
          result.isError
            ? { status: "failure", errorCode: "UPSTREAM_CALL_FAILED" }
            : { status: "success" }
      );
    });

    if (this.resourcePromptProxy.available) {
      const upstreamName = this.resourcePromptProxy.upstreamName;
      this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
        const source = await this.captureStableProfileState();
        return this.runAudited(
          {
            operation: "resources/list",
            name: "resources",
            sourceProfile: source.activeProfile,
            arguments: request.params ?? {}
          },
          async (audit) => {
            const upstream = this.resourcePromptRegistry ? undefined : this.auditUpstreamName(upstreamName);
            if (upstream) audit.update({ upstream });
            if (this.resourcePromptRegistry) {
              try {
                return await this.resourcePromptRegistry.listResources(source.activeProfile, request.params?.cursor);
              } finally {
                await this.notifyResourceAvailabilityChange(source.activeProfile);
              }
            }
            return redactDirectResourceList(await this.discoverResources(source.activeProfile, upstreamName, request.params));
          }
        );
      });

      this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const approvalContext: ApprovalRequestContext = { requestId: extra.requestId, signal: extra.signal };
        return this.runAudited(
          {
            operation: "resources/read",
            name: this.redactor.redactUri(request.params.uri),
            sourceProfile: source.activeProfile,
            arguments: { uri: this.redactor.redactUri(request.params.uri) }
          },
          async (audit) => {
            if (this.resourcePromptRegistry) {
              try {
                return await this.executeResourceRead(source, upstreamName, request.params, audit, approvalContext);
              } finally {
                await this.notifyResourceAvailabilityChange(source.activeProfile);
              }
            }
            return this.executeResourceRead(source, upstreamName, request.params, audit, approvalContext);
          }
        );
      });

      this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
        const source = await this.captureStableProfileState();
        return this.runAudited(
          {
            operation: "prompts/list",
            name: "prompts",
            sourceProfile: source.activeProfile,
            arguments: request.params ?? {}
          },
          async (audit) => {
            const upstream = this.resourcePromptRegistry ? undefined : this.auditUpstreamName(upstreamName);
            if (upstream) audit.update({ upstream });
            if (this.resourcePromptRegistry) {
              try {
                return await this.resourcePromptRegistry.listPrompts(source.activeProfile, request.params?.cursor);
              } finally {
                await this.notifyPromptAvailabilityChange(source.activeProfile);
              }
            }
            return redactDirectPromptList(await this.discoverPrompts(source.activeProfile, upstreamName, request.params));
          }
        );
      });

      this.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const approvalContext: ApprovalRequestContext = { requestId: extra.requestId, signal: extra.signal };
        return this.runAudited(
          {
            operation: "prompts/get",
            name: request.params.name,
            sourceProfile: source.activeProfile,
            arguments: { ...(request.params.arguments ?? {}), name: request.params.name }
          },
          async (audit) => {
            if (this.resourcePromptRegistry) {
              try {
                return await this.executePromptGet(source, upstreamName, request.params, audit, approvalContext);
              } finally {
                await this.notifyPromptAvailabilityChange(source.activeProfile);
              }
            }
            return this.executePromptGet(source, upstreamName, request.params, audit, approvalContext);
          }
        );
      });
    }
  }

  private async handleUpstreamTool(
    name: string,
    args: Record<string, unknown>,
    audit: AuditScope,
    sourceState: CapturedProfileState,
    approvalContext?: ApprovalRequestContext
  ): Promise<CallToolResult> {
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
    audit.update({ name: mapped.originalName });
    return this.operationPipeline.execute(
      {
        source: sourceState,
        operation: "tools/call",
        routingName: mapped.originalName,
        policyName: mapped.originalName,
        name: mapped.originalName,
        args,
        ...(approvalContext === undefined ? {} : { approvalContext }),
        riskMetadataForProfile: (profile) => {
          const target = this.toolRegistry.peek(profile)?.resolve(name);
          return hasCompatibleCachedToolTarget(mapped, target) ? this.riskMetadata(target) : undefined;
        },
        requireExplicitRuleForDestructive: this.config.security?.requireExplicitProfileForDestructive,
        requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
        resolveTarget: async (profile) => {
          const target = (await this.toolRegistry.get(profile)).resolve(name);
          if (!target) {
            throw new MiftahError(
              "TOOL_NOT_FOUND",
              `TOOL_NOT_FOUND: tool '${name}' is not exposed for routed profile '${profile}'`
            );
          }
          if (target.fingerprint !== mapped.fingerprint || target.originalName !== mapped.originalName) {
            throw new MiftahError(
              "TOOL_SCHEMA_MISMATCH",
              `TOOL_SCHEMA_MISMATCH: tool '${name}' has a different schema for routed profile '${profile}'`
            );
          }
          if (target.upstreamName !== mapped.upstreamName) {
            throw new MiftahError(
              "TOOL_SCHEMA_MISMATCH",
              `TOOL_SCHEMA_MISMATCH: tool '${name}' resolves to a different upstream for routed profile '${profile}'`
            );
          }
          return {
            upstreamName: this.auditUpstreamName(target.upstreamName),
            identityUpstreamName: target.upstreamName,
            name: target.originalName,
            execute: (session) => session.callTool({ name: target.originalName, arguments: args }),
            redact: (result) => result
          };
        }
      },
      audit
    );
  }

  private async handleManagement(
    name: string,
    args: Record<string, unknown>,
    audit: AuditScope,
    source: ProfileStateSnapshot,
    approvalContext?: ApprovalRequestContext
  ): Promise<CallToolResult> {
    if (name === "miftah_list_profiles") {
      const activeProfile = source.activeProfile;
      return textResult(JSON.stringify(this.profiles.list().map((profile) => ({
        ...profile,
        active: profile.name === activeProfile
      }))));
    }
    if (name === "miftah_current_profile") {
      const current = this.currentProfileState(source);
      return textResult(
        JSON.stringify({
          ...current,
          routingMode: this.config.routing?.mode ?? "hybrid",
          identity: this.identityStatuses(current.activeProfile)
        })
      );
    }
    if (name === "miftah_use_profile") {
      const profile = requiredString(args, "profile");
      const transition = await this.requireProfileTransitionConfirmation(
        "switch",
        profile,
        source,
        approvalContext
      );
      return this.enqueueProfileTransition(async () => {
        const previousSnapshot = this.toolRegistry.peek(this.profiles.current().activeProfile);
        const switched = await this.profiles.mutateAudited(
          () => this.profiles.switchPersisted(profile, transition),
          async (result) => {
            const actions: ProfileAuditRequest[] = [
              {
                action: "switch",
                input: {
                  sourceProfile: result.previousProfile,
                  profile: result.activeProfile,
                  operation: "profiles/switch",
                  name: result.activeProfile
                }
              }
            ];
            const leaseIssued = this.leaseIssuedAuditAction(
              result.previousProfile,
              "profiles/switch",
              result.activeProfile
            );
            if (leaseIssued !== undefined) actions.push(leaseIssued);
            await this.writeProfileActions(actions);
          }
        );
        audit.update({ name: switched.activeProfile, profile: switched.activeProfile });
        this.routing.setActiveProfile(switched.activeProfile);
        this.invalidateResourcePromptProfiles(switched.previousProfile, switched.activeProfile);
        await this.notifyToolListChanged(previousSnapshot, this.toolRegistry.peek(switched.activeProfile));
        await this.notifyResourcePromptListChanged();
        return textResult(`Active profile changed from ${switched.previousProfile} to ${switched.activeProfile}.`);
      });
    }
    if (name === "miftah_lock_profile") {
      return this.enqueueProfileTransition(async () => {
        const locked = await this.profiles.mutateAudited(
          () => this.profiles.lock(),
          (result) =>
            this.writeProfileAction("lock", {
              sourceProfile: result.profile,
              profile: result.profile,
              operation: "profiles/lock",
              name: result.profile
            })
        );
        audit.update({ name: locked.profile, profile: locked.profile });
        return textResult(JSON.stringify({ profileState: this.currentProfileState() }));
      });
    }
    if (name === "miftah_unlock_profile") {
      return this.enqueueProfileTransition(async () => {
        const unlocked = await this.profiles.mutateAudited(
          () => this.profiles.unlock(),
          (result) =>
            this.writeProfileAction("unlock", {
              sourceProfile: result.profile,
              profile: result.profile,
              operation: "profiles/unlock",
              name: result.profile
            })
        );
        audit.update({ name: unlocked.profile, profile: unlocked.profile });
        return textResult(JSON.stringify({ profileState: this.currentProfileState() }));
      });
    }
    if (name === "miftah_reset_profile") {
      const profile = source.defaultProfile;
      const transition = await this.requireProfileTransitionConfirmation(
        "reset",
        profile,
        source,
        approvalContext
      );
      return this.enqueueProfileTransition(async () => {
        const previousSnapshot = this.toolRegistry.peek(this.profiles.current().activeProfile);
        const reset = await this.profiles.mutateAudited(
          () => this.profiles.resetPersisted(transition),
          async (result) => {
            const actions: ProfileAuditRequest[] = [
              {
                action: "reset",
                input: {
                  sourceProfile: result.previousProfile,
                  profile: result.activeProfile,
                  operation: "profiles/reset",
                  name: result.activeProfile
                }
              }
            ];
            const leaseIssued = this.leaseIssuedAuditAction(
              result.previousProfile,
              "profiles/reset",
              result.activeProfile
            );
            if (leaseIssued !== undefined) actions.push(leaseIssued);
            await this.writeProfileActions(actions);
          }
        );
        audit.update({ name: reset.activeProfile, profile: reset.activeProfile });
        this.routing.setActiveProfile(reset.activeProfile);
        this.invalidateResourcePromptProfiles(reset.previousProfile, reset.activeProfile);
        await this.notifyToolListChanged(previousSnapshot, this.toolRegistry.peek(reset.activeProfile));
        await this.notifyResourcePromptListChanged();
        return textResult(`Active profile reset from ${reset.previousProfile} to ${reset.activeProfile}.`);
      });
    }
    if (name === "miftah_profile_info") {
      const profile = requiredString(args, "profile");
      const info = this.profiles.info(profile);
      audit.update({ name: profile, profile });
      return textResult(JSON.stringify(info));
    }
    if (name === "miftah_health") {
      return textResult(
        JSON.stringify({
          configValid: true,
          activeProfile: source.activeProfile,
          profileState: this.currentProfileState(source),
          resourcePromptProxy: this.resourcePromptProxy.available
            ? { available: true }
            : { available: false, reason: this.resourcePromptProxy.reason },
          audit: this.auditTrail.health(),
          upstreams: this.upstreams.listHealth(),
          identity: Object.keys(this.config.profiles)
            .sort()
            .flatMap((profile) => this.identityStatuses(profile))
        })
      );
    }
    if (name === "miftah_validate_config") return textResult(JSON.stringify({ ok: true, errors: [] }));
    if (name === "miftah_list_approvals") {
      return this.enqueueApprovalTransition(async () => {
        await this.expireApprovals();
        return textResult(JSON.stringify(this.approvals.list()));
      });
    }
    if (name === "miftah_approve") {
      return this.enqueueApprovalTransition(async () => {
        await this.expireApprovals();
        const approval = await this.withApprovalExpiryAudit(
          () => this.approvals.approve(requiredString(args, "approval")),
          (value) => this.approvals.revoke(value.id)
        );
        try {
          await this.writeApproval("approved", approval);
        } catch (error) {
          this.approvals.revoke(approval.id);
          throw error;
        }
        return textResult("Approval granted. Retry the exact operation.");
      });
    }
    if (name === "miftah_deny") {
      return this.enqueueApprovalTransition(async () => {
        await this.expireApprovals();
        const approval = await this.withApprovalExpiryAudit(
          () => this.approvals.deny(requiredString(args, "approval")),
          (value) => this.approvals.revoke(value.id)
        );
        try {
          await this.writeApproval("denied", approval);
        } catch (error) {
          this.approvals.revoke(approval.id);
          throw error;
        }
        return textResult("Approval denied.");
      });
    }
    if (name === "miftah_list_upstream_tools") {
      const profile = args.profile === undefined ? source.activeProfile : requiredString(args, "profile");
      audit.update({ name: profile, profile });
      const tools = (await this.toolRegistry.get(profile)).getTools();
      return textResult(JSON.stringify(tools.map((item) => ({ name: item.name, description: item.description }))));
    }
    if (name === "miftah_restart_profile") {
      const profile = requiredString(args, "profile");
      audit.update({ name: profile, profile });
      await this.restartUpstreamProfile(profile);
      return textResult("Profile restarted.");
    }
    if (name === "miftah_verify_identity") {
      const profile = args.profile === undefined ? source.activeProfile : requiredString(args, "profile");
      this.profiles.get(profile);
      const requestedUpstream = optionalString(args, "upstream");
      const targetUpstreams = this.identityTargetUpstreams(requestedUpstream);
      audit.update({
        name: requestedUpstream ?? profile,
        profile,
        ...(requestedUpstream === undefined ? {} : { upstream: requestedUpstream })
      });
      const statuses = await Promise.all(
        targetUpstreams.map(async (upstreamName) => {
          const current = this.identities.status(profile, upstreamName);
          if (current.status === "unconfigured") return current;
          let session: UpstreamSession;
          try {
            session = await this.upstreams.get(profile, upstreamName);
          } catch {
            return this.identities.recordAcquisitionFailure(profile, upstreamName);
          }
          return this.identities.verify(profile, upstreamName, session, { force: true });
        })
      );
      const identity = statuses
        .map((status) => this.redactor.redactForAudit(status))
        .sort((left, right) => left.upstream.localeCompare(right.upstream));
      audit.update({ identity });
      const failure = identity.find((status) => status.status !== "verified");
      if (failure) {
        audit.setResult({ status: "failure", errorCode: identityAuditErrorCode(failure) });
      }
      return textResult(JSON.stringify({ profile, identity }));
    }
    if (name === "miftah_route_preview") {
      const toolName = requiredString(args, "toolName");
      const snapshot = await this.provideRoutingContext();
      const evidence = this.redactor.redactForAudit(snapshot.evidence);
      audit.update({ routingEvidence: evidence });
      const route = this.routing.resolve({
        toolName,
        args: isRecord(args.args) ? args.args : {},
        context: snapshot.context,
        profileHints: snapshot.profileHints
      }, source.activeProfile);
      const profile = this.profiles.get(route.profile);
      const sourceTool = this.toolRegistry.peek(source.activeProfile)?.resolve(toolName);
      const targetTool =
        sourceTool === undefined
          ? undefined
          : this.toolRegistry.peek(route.profile)?.resolve(toolName);
      const hasCompatibleCachedTarget = hasCompatibleCachedToolTarget(sourceTool, targetTool);
      const policyName = sourceTool?.originalName ?? toolName;
      const policy = this.policy.evaluate(
        profile.policy,
        policyName,
        hasCompatibleCachedTarget && targetTool !== undefined ? this.riskMetadata(targetTool) : undefined
      );
      audit.update({
        profile: route.profile,
        routingReason: route.reason,
        policyName: profile.policy ?? "default",
        policyDecision: policy.action,
        risk: policy.risk,
        riskSource: policy.riskSource,
        riskConfidence: policy.riskConfidence,
        routingEvidence: evidence
      });
      return textResult(JSON.stringify({ ...route, policy, evidence, identity: this.identityStatuses(route.profile) }));
    }
    throw new MiftahError("TOOL_NOT_FOUND", `TOOL_NOT_FOUND: management tool '${name}' is not registered`);
  }

  private currentProfileState(current: ProfileStateSnapshot = this.profiles.current()) {
    return {
      activeProfile: current.activeProfile,
      defaultProfile: current.defaultProfile,
      selectionSource: current.selectionSource,
      selectedAt: current.selectedAt,
      scope: current.scope,
      confirmation: current.confirmation,
      lease: current.lease,
      lock: current.lock,
      ...(current.stateDiagnostic === undefined ? {} : { stateDiagnostic: current.stateDiagnostic })
    };
  }

  private async requireProfileTransitionConfirmation(
    action: "switch" | "reset",
    profile: string,
    source: CapturedProfileState,
    context?: ApprovalRequestContext
  ): Promise<ProfileTransitionOptions | undefined> {
    this.profiles.get(profile);
    if (this.config.security?.requireProfileSwitchConfirmation !== true) return undefined;
    const session = this.profileTransitionSession;
    await this.requireApproval(
      {
        sourceProfile: source.activeProfile,
        profile,
        upstream: "profiles",
        operation: `profiles/${action}`,
        name: profile,
        displayName: `profile '${profile}'`,
        arguments: { profile, selectionRevision: source.revision }
      },
      context,
      profileSwitchApprovalErrors
    );
    if (session !== this.profileTransitionSession) {
      throw new MiftahError(
        "PROFILE_SWITCH_CONFIRMATION_REQUIRED",
        "PROFILE_SWITCH_CONFIRMATION_REQUIRED: profile confirmation was invalidated by a new MCP connection"
      );
    }
    const confirmation = Object.freeze({});
    this.profileTransitionConfirmations.set(confirmation, {
      session,
      action,
      profile,
      revision: source.revision
    });
    return { confirmation, expectedRevision: source.revision };
  }

  private exposedToolName(name: string, upstreamName?: string): string {
    return resolveClientVisibleToolName(name, upstreamName, this.config.tooling?.collisionStrategy);
  }

  private riskMetadata(tool: RegisteredTool): ToolRiskMetadata {
    return {
      trusted: this.trustsToolAnnotations(tool.upstreamName),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations })
    };
  }

  private async requireApproval(
    binding: ApprovalBinding,
    context?: ApprovalRequestContext,
    errors: ApprovalErrorFactory = genericApprovalErrors
  ): Promise<void> {
    const supportsFormElicitation =
      context !== undefined && this.server.getClientCapabilities()?.elicitation?.form !== undefined;
    const resolution = await this.enqueueApprovalTransition(async (): Promise<ApprovalResolution> => {
      await this.expireApprovals();
      const consumed = await this.withApprovalExpiryAudit(
        () => this.approvals.consume(binding),
        (value) => {
          if (value !== undefined) this.approvals.revoke(value.id);
        }
      );
      if (consumed !== undefined) {
        try {
          await this.writeApproval("consumed", consumed);
        } catch (error) {
          this.approvals.revoke(consumed.id);
          throw error;
        }
        return { kind: "consumed" };
      }
      const requested = await this.withApprovalExpiryAudit(
        () =>
          this.approvals.request(
            binding,
            supportsFormElicitation ? undefined : (bearer) => this.redactor.redactText(bearer) === bearer
          ),
        (value) => this.approvals.revoke(value.approval.id)
      );
      if (requested.created) {
        try {
          await this.writeApproval("requested", requested.approval);
        } catch (error) {
          this.approvals.revoke(requested.approval.id);
          throw error;
        }
      }
      return supportsFormElicitation ? { kind: "form", token: requested.token } : { kind: "fallback", token: requested.token };
    });
    if (resolution.kind === "consumed") return;
    if (resolution.kind === "fallback") {
      throw errors.required(binding, resolution.token);
    }
    if (context === undefined) throw new Error("Form approval requires an MCP request context.");
    let result;
    try {
      result = await this.server.elicitInput(
        {
          mode: "form",
          message: "Approve this exact operation?",
          requestedSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"]
          }
        },
        { relatedRequestId: context.requestId, signal: context.signal, timeout: 60_000 }
      );
    } catch {
      await this.finalizeNativeApproval(resolution.token, binding, false);
      throw errors.notAccepted(binding);
    }
    if (result.action === "accept" && result.content?.approved === true) {
      await this.finalizeNativeApproval(resolution.token, binding, true);
      return;
    }
    await this.finalizeNativeApproval(resolution.token, binding, false);
    throw errors.notAccepted(binding);
  }

  private async finalizeNativeApproval(token: string, binding: ApprovalBinding, accepted: boolean): Promise<void> {
    await this.enqueueApprovalTransition(async () => {
      await this.expireApprovals();
      if (accepted) {
        const approval = await this.withApprovalExpiryAudit(
          () => this.approvals.approveAndConsume(token, binding),
          (value) => this.approvals.revoke(value.id)
        );
        try {
          await this.writeApproval("approved", approval);
          await this.writeApproval("consumed", approval);
        } catch (error) {
          this.approvals.revoke(approval.id);
          throw error;
        }
        return;
      }
      const approval = await this.withApprovalExpiryAudit(
        () => this.approvals.deny(token),
        (value) => this.approvals.revoke(value.id)
      );
      try {
        await this.writeApproval("denied", approval);
      } catch (error) {
        this.approvals.revoke(approval.id);
        throw error;
      }
    });
  }

  private async expireApprovals(): Promise<void> {
    this.approvals.expire();
    await this.writeExpiredApprovalTransitions();
  }

  private async withApprovalExpiryAudit<Result>(
    operation: () => Result,
    rollbackOnAuditFailure?: (result: Result) => void
  ): Promise<Result> {
    let result: Result;
    try {
      result = operation();
    } catch (error) {
      try {
        await this.writeExpiredApprovalTransitions();
      } catch {
        // The transition is restored before this throws and the fail-closed audit logger retains its health failure.
        // Preserve the original approval error because it is the actionable result of this operation.
      }
      throw error;
    }
    try {
      await this.writeExpiredApprovalTransitions();
    } catch (error) {
      rollbackOnAuditFailure?.(result);
      throw error;
    }
    return result;
  }

  private enqueueApprovalTransition<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.approvalTransitions.then(operation, operation);
    this.approvalTransitions = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async writeExpiredApprovalTransitions(): Promise<void> {
    const expired = this.approvals.takeExpiredTransitions();
    for (let index = 0; index < expired.length; index += 1) {
      try {
        await this.writeApproval("expired", expired[index]!);
      } catch (error) {
        this.approvals.restoreExpiredTransitions(expired.slice(index));
        throw error;
      }
    }
  }

  private async writeApproval(
    action: ApprovalAuditAction,
    approval: ApprovalSummary
  ): Promise<void> {
    const approvalInput = {
      approvalId: approval.id,
      approvalSessionId: this.approvals.activeSessionId,
      approvalAction: action,
      sourceProfile: approval.sourceProfile,
      profile: approval.profile,
      upstream: approval.upstream,
      operation: approval.operation,
      name: approval.name,
      expiresAt: approval.expiresAt
    };
    const profileAction = profileConfirmationAction(action, approval.operation);
    if (profileAction === undefined) {
      await this.auditTrail.writeApproval(approvalInput);
      return;
    }
    await this.auditTrail.writeApprovalAndProfile(
      approvalInput,
      this.profileAuditInput(profileAction, {
        sourceProfile: approval.sourceProfile,
        profile: approval.profile,
        operation: approval.operation,
        name: approval.name
      })
    );
  }

  private leaseIssuedAuditAction(
    sourceProfile: string,
    operation: string,
    profile: string
  ): ProfileAuditRequest | undefined {
    if (this.profiles.current().lease.state !== "active") return undefined;
    return { action: "lease-issued", input: { sourceProfile, profile, operation, name: profile } };
  }

  private async writeProfileAction(
    action: ProfileAuditAction,
    input: {
      sourceProfile: string;
      profile: string;
      operation: string;
      name: string;
      state?: CapturedProfileState;
    }
  ): Promise<void> {
    await this.writeProfileActions([{ action, input }]);
  }

  private async writeProfileActions(actions: readonly ProfileAuditRequest[]): Promise<void> {
    await this.auditTrail.writeProfiles(actions.map(({ action, input }) => this.profileAuditInput(action, input)));
  }

  private profileAuditInput(
    action: ProfileAuditAction,
    input: ProfileAuditRequest["input"]
  ): AuditProfileInput {
    const { state, ...event } = input;
    const current = state ?? this.profiles.current();
    return {
      profileAction: action,
      ...event,
      profileSelectionSource: current.selectionSource,
      profileConfirmation: current.confirmation,
      profileLeaseState: current.lease.state,
      ...("expiresAt" in current.lease ? { profileLeaseExpiresAt: current.lease.expiresAt } : {}),
      profileLockState: current.lock.state
    };
  }

  private trustsToolAnnotations(upstreamName: string | undefined): boolean {
    if (this.config.upstream !== undefined) return this.config.upstream.trustToolAnnotations === true;
    return (
      upstreamName !== undefined &&
      this.config.upstreams !== undefined &&
      Object.hasOwn(this.config.upstreams, upstreamName) &&
      this.config.upstreams[upstreamName]!.trustToolAnnotations === true
    );
  }

  private upstreamNames(): (string | undefined)[] {
    if (this.upstreams instanceof MultiUpstreamProcessManager) return this.upstreams.listUpstreams();
    return [undefined];
  }

  private identityStatuses(profile: string) {
    return this.upstreamNames()
      .map((upstreamName) => this.redactor.redactForAudit(this.identities.status(profile, upstreamName)))
      .sort((left, right) => left.upstream.localeCompare(right.upstream));
  }

  private identityTargetUpstreams(requestedUpstream?: string): (string | undefined)[] {
    const configured = this.upstreamNames();
    if (requestedUpstream === undefined) return configured;
    if (requestedUpstream === "default" && configured.length === 1 && configured[0] === undefined) return [undefined];
    if (configured.includes(requestedUpstream)) return [requestedUpstream];
    throw new MiftahError("UPSTREAM_NOT_FOUND", `UPSTREAM_NOT_FOUND: upstream '${requestedUpstream}' is not configured`);
  }

  private auditUpstreamName(upstreamName?: string): string | undefined {
    if (upstreamName !== undefined) return upstreamName;
    if (!(this.upstreams instanceof MultiUpstreamProcessManager)) return "default";
    const names = this.upstreams.listUpstreams();
    return names.length === 1 ? names[0] : undefined;
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
            message: this.redactor.redactText(error instanceof Error ? error.message : String(error))
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
    params: ReadResourceRequest["params"],
    audit: AuditScope,
    approvalContext?: ApprovalRequestContext
  ): Promise<ReadResourceResult> {
    return this.operationPipeline.execute(
      {
        source,
        operation: "resources/read",
        routingName: "resources/read",
        policyName: "resources/read",
        name: params.uri,
        args: { uri: params.uri },
        ...(approvalContext === undefined ? {} : { approvalContext }),
        requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
        resolveTarget: async (profile) => {
          if (this.resourcePromptRegistry) return this.resolveAggregatedResource(profile, params);
          const auditUpstream = this.auditUpstreamName(upstreamName);
          return {
            ...(auditUpstream === undefined ? {} : { upstreamName: auditUpstream }),
            ...(upstreamName === undefined ? {} : { identityUpstreamName: upstreamName }),
            name: params.uri,
            execute: (session) => session.readResource(params),
            redact: redactDirectReadResult
          };
        }
      },
      audit
    );
  }

  private async executePromptGet(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: GetPromptRequest["params"],
    audit: AuditScope,
    approvalContext?: ApprovalRequestContext
  ): Promise<GetPromptResult> {
    return this.operationPipeline.execute(
      {
        source,
        operation: "prompts/get",
        routingName: "prompts/get",
        policyName: "prompts/get",
        name: params.name,
        args: { ...(params.arguments ?? {}), name: params.name },
        ...(approvalContext === undefined ? {} : { approvalContext }),
        requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
        resolveTarget: async (profile) => {
          if (this.resourcePromptRegistry) return this.resolveAggregatedPrompt(profile, params);
          const auditUpstream = this.auditUpstreamName(upstreamName);
          return {
            ...(auditUpstream === undefined ? {} : { upstreamName: auditUpstream }),
            ...(upstreamName === undefined ? {} : { identityUpstreamName: upstreamName }),
            name: params.name,
            execute: (session) => session.getPrompt(params),
            redact: redactDirectPromptResult
          };
        }
      },
      audit
    );
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
      throw this.toSafeError(error);
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
      identityUpstreamName: route.upstreamName,
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
      identityUpstreamName: route.upstreamName,
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

  private async runAudited<Result>(
    input: {
      operation: string;
      name: string;
      sourceProfile: string;
      arguments?: Record<string, unknown>;
    },
    operation: (audit: AuditScope) => Promise<Result>,
    errorResult?: (error: MiftahError) => Result,
    resultAudit?: (result: Result) => AuditScopeResult
  ): Promise<Result> {
    const audit = this.auditTrail.beginOperation(input);
    try {
      await this.auditTrail.ensureWritable();
      const result = await operation(audit);
      await audit.finish(resultAudit?.(result) ?? { status: "success" });
      return this.redactor.redact(result);
    } catch (error) {
      let safeError = this.toSafeError(error);
      if (!audit.isFinalized) {
        try {
          await audit.finish({ status: this.auditStatus(safeError), errorCode: safeError.code });
        } catch (auditError) {
          safeError = this.toSafeError(auditError);
        }
      }
      if (errorResult) return errorResult(safeError);
      throw safeError;
    }
  }

  private auditStatus(error: MiftahError): AuditStatus {
    if (
      error.code === "POLICY_BLOCKED" ||
      error.code === "ROUTING_BLOCKED" ||
      error.code === "PROFILE_SWITCH_DISABLED" ||
      error.code === "PROFILE_LOCKING_DISABLED" ||
      error.code === "PROFILE_LOCKED" ||
      error.code === "PROFILE_SELECTION_STALE" ||
      error.code === "PROFILE_LEASE_REQUIRED" ||
      error.code === "PROFILE_LEASE_EXPIRED" ||
      error.code === "PROFILE_SELECTION_REQUIRED"
    ) {
      return "denied";
    }
    if (
      error.code === "POLICY_CONFIRMATION_REQUIRED" ||
      error.code === "PROFILE_SWITCH_CONFIRMATION_REQUIRED"
    ) {
      return "confirmation-required";
    }
    if (error.code === "ROUTING_AMBIGUOUS") return "ambiguous";
    return "failure";
  }

  private toSafeError(error: unknown): MiftahError {
    const message = this.redactor.redactText(error instanceof Error ? error.message : String(error));
    if (error instanceof MiftahError) {
      return new MiftahError(error.code, message, this.redactor.redact(error.details));
    }
    return new MiftahError("UPSTREAM_CALL_FAILED", `UPSTREAM_CALL_FAILED: ${message}`);
  }

  /** Prevents a request from capturing profile state while a required-audit transition can still roll it back. */
  private async captureStableProfileState(): Promise<ProfileStateSnapshot> {
    for (;;) {
      const transitions = this.profileTransitions;
      await transitions;
      if (transitions === this.profileTransitions) return this.profiles.current();
    }
  }

  private async activeToolSnapshot(): Promise<{ profile: string; snapshot: ToolSnapshot }> {
    for (;;) {
      const state = await this.captureStableProfileState();
      const previous =
        this.toolRegistry.peek(state.activeProfile) ?? this.invalidatedToolSnapshots.get(state.activeProfile);
      const snapshot = await this.toolRegistry.get(state.activeProfile);
      if (this.profiles.current().revision === state.revision) {
        if (previous !== undefined) await this.notifyToolListChanged(previous, snapshot);
        this.invalidatedToolSnapshots.delete(state.activeProfile);
        return { profile: state.activeProfile, snapshot };
      }
    }
  }

  private enqueueProfileTransition<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.profileTransitions.then(operation, operation);
    this.profileTransitions = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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

  private recordUpstreamLifecycle(event: UpstreamLifecycleEvent): void {
    this.auditTrail.recordLifecycle({
      operation: `upstream/${event.type}`,
      name: event.upstreamName,
      profile: event.profile,
      upstream: event.upstreamName,
      status: event.status,
      errorCode: event.errorCode
    });
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

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined) return undefined;
  return requiredString(args, key);
}

function identityAuditErrorCode(status: IdentityStatus): string {
  if (status.status === "unconfigured") return "IDENTITY_NOT_CONFIGURED";
  return status.errorCode ?? "IDENTITY_VERIFICATION_FAILED";
}

function profileConfirmationAction(
  action: ApprovalAuditAction,
  operation: string
): Extract<ProfileAuditAction, `confirmation-${string}`> | undefined {
  if (operation !== "profiles/switch" && operation !== "profiles/reset") return undefined;
  if (action === "requested") return "confirmation-requested";
  if (action === "approved") return "confirmation-accepted";
  if (action === "denied") return "confirmation-denied";
  if (action === "expired") return "confirmation-expired";
  return undefined;
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

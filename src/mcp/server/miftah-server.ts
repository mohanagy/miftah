import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  RootsListChangedNotificationSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type ListPromptsResult,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ListResourcesRequest,
  type ListResourcesResult,
  type Prompt,
  type ReadResourceResult,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type ServerNotification,
  type ServerRequest,
  type SubscribeRequest,
  type UnsubscribeRequest,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { MiftahConfig, ToolingConfig } from "../../config/types.js";
import type { PluginRegistry } from "../../plugins/plugin-registry.js";
import { ApprovalStore, type ApprovalBinding, type ApprovalSummary } from "../../approvals/approval-store.js";
import { SecretRedactor, redactUri } from "../../secrets/redact.js";
import {
  bindProfileTransitionConfirmationVerifier,
  ProfileManager,
  type ProfileTransitionOptions
} from "../../profiles/profile-manager.js";
import { matcherEvidenceFromError, RoutingEngine } from "../../routing/routing-engine.js";
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
import type { UpstreamRequestOptions, UpstreamSession } from "../../upstream/upstream-session.js";
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
const defaultResourceSubscriptionCleanupTimeoutMs = 5_000;
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

type ProxiedRequestExtra = Pick<
  RequestHandlerExtra<ServerRequest, ServerNotification>,
  "_meta" | "sendNotification" | "signal"
>;

interface UpstreamRequestContext {
  readonly options: UpstreamRequestOptions;
  flush(): Promise<void>;
}

interface ToolListSnapshotLoad {
  readonly snapshot: ToolSnapshot;
  finish(published: boolean): void;
}

interface ResourceSubscriptionRoute {
  readonly profile: string;
  readonly upstreamName?: string;
  readonly originalUri: string;
  readonly exposedUri: string;
}

interface ResourceSubscription extends ResourceSubscriptionRoute {
  readonly session: UpstreamSession;
  state: "pending" | "active";
  pendingUpdates: number;
  cleanupRequested?: boolean;
  abortPending?: () => void;
  cleanupPromise?: Promise<void>;
  release?: () => void;
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
  private readonly deferredToolInvalidations = new Set<string>();
  private readonly activeToolListDiscoveries = new Map<string, number>();
  private readonly pendingResourceListChanges = new Set<string>();
  private readonly pendingPromptListChanges = new Set<string>();
  private readonly boundUpstreamSessions = new WeakSet<UpstreamSession>();
  private readonly resourceSubscriptions = new Map<string, ResourceSubscription>();
  private readonly resourceSubscriptionTransitions = new Map<string, Promise<void>>();
  private resourceSubscriptionEpoch = 0;
  private resourceSubscriptionCapabilityConfigured = false;
  private resourceSubscriptionsAvailable = false;
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
    private readonly routingContextCollector?: RoutingContextCollector,
    private readonly plugins?: PluginRegistry
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
    this.routing = new RoutingEngine(
      config.routing,
      profiles.current().activeProfile,
      config.defaultProfile,
      config.profiles,
      plugins
    );
    this.policy = new PolicyEngine(config.policies, config.tooling?.toolRiskOverrides ?? {}, {
      unknownRisk: config.tooling?.unknownToolRisk
    });
    this.identities = new IdentityManager(config);
    this.toolRegistry = new ToolRegistry(
      (profile, options) => this.discoverTools(profile, options),
      (name, upstreamName) => this.exposedToolName(name, upstreamName)
    );
    if (this.upstreams instanceof MultiUpstreamProcessManager && this.upstreams.listUpstreams().length > 1) {
      const multiUpstreams = this.upstreams;
      this.resourcePromptRegistry = new ResourcePromptRegistry(
        () => multiUpstreams.listUpstreams(),
        (profile, upstreamName, params, options) => this.discoverResources(profile, upstreamName, params, options),
        (profile, upstreamName, params, options) => this.discoverPrompts(profile, upstreamName, params, options),
        (value) => this.redactor.redact(value),
        undefined,
        config.tooling?.toolDiscoveryMode ?? "permissive",
        (profile, upstreamName, params, options) =>
          this.discoverResourceTemplates(profile, upstreamName, params, options)
      );
    }
    this.upstreams.addHealthListener((health) => this.handleUpstreamHealthChange(health));
    if (config.audit?.enabled !== false && config.audit?.path) {
      this.audit = new AuditLogger(config.audit.path, {
        includeArguments: config.audit.includeArguments,
        redactor: this.redactor,
        failureMode: config.audit.failureMode,
        rotation: config.audit.rotation,
        integrity: config.audit.integrity
      });
    }
    this.auditTrail = new AuditTrail(config.name, this.audit);
    this.upstreams.addLifecycleListener((event) => {
      if (event.type !== "start") {
        this.dropResourceSubscriptions(
          (subscription) =>
            subscription.profile === event.profile &&
            this.resourceSubscriptionUpstreamName(subscription.upstreamName) === event.upstreamName
        );
      }
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
      onSession: (session, target) => this.bindUpstreamSession(session, target.identityUpstreamName),
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
    if (previousProfile !== activeProfile) await this.invalidateResourcePromptProfiles(previousProfile, activeProfile);
    this.resetMcpRoots();
    await this.configureResourceSubscriptionCapability();
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
    await this.unsubscribeResourceSubscriptions(() => true);
    await this.server.close();
    await this.upstreams.close();
    await this.auditTrail.writeLifecycle({
      operation: "wrapper/shutdown",
      name: this.config.name,
      profile: this.profiles.current().activeProfile,
      status: "success"
    }).catch(() => undefined);
  }

  private async configureResourceSubscriptionCapability(): Promise<void> {
    if (this.resourceSubscriptionCapabilityConfigured) return;
    this.resourceSubscriptionCapabilityConfigured = true;
    if (!this.resourcePromptProxy.available) return;
    const upstreamNames =
      this.upstreams instanceof MultiUpstreamProcessManager
        ? this.upstreams.listUpstreams()
        : [this.resourcePromptProxy.upstreamName];
    let supported = upstreamNames.length > 0;
    for (const profile of Object.keys(this.config.profiles).sort((left, right) => left.localeCompare(right))) {
      try {
        for (const upstreamName of upstreamNames) {
          try {
            const session = await this.upstreams.get(profile, upstreamName);
            this.bindUpstreamSession(session, upstreamName);
            supported &&= session.supportsResourceSubscriptions();
          } catch (error) {
            supported = false;
            this.reportResourceSubscriptionCapabilityFailure(error);
          }
        }
      } finally {
        try {
          await this.upstreams.closeProfile(profile);
        } catch (error) {
          supported = false;
          this.reportResourceSubscriptionCapabilityFailure(error);
        }
      }
    }
    this.resourceSubscriptionsAvailable = supported;
    if (this.resourceSubscriptionsAvailable) {
      this.server.registerCapabilities({ resources: { subscribe: true } });
    }
  }

  private bindUpstreamSession(session: UpstreamSession, upstreamName: string | undefined): void {
    if (this.boundUpstreamSessions.has(session)) return;
    this.boundUpstreamSessions.add(session);
    session.addResourceUpdatedListener((uri) => {
      void this.forwardUpstreamResourceUpdated(session, upstreamName, uri).catch((error: unknown) => {
        this.reportUpstreamNotificationFailure(error);
      });
    });
    session.addListChangedListener((kind) => {
      void this.handleUpstreamListChanged(session.profile, kind).catch((error: unknown) => {
        this.reportUpstreamNotificationFailure(error);
      });
    });
  }

  private async forwardUpstreamResourceUpdated(
    session: UpstreamSession,
    upstreamName: string | undefined,
    originalUri: string
  ): Promise<void> {
    if (!this.server.transport) return;
    const activeSubscriptions: ResourceSubscription[] = [];
    for (const subscription of this.resourceSubscriptions.values()) {
      if (
        subscription.session !== session ||
        subscription.upstreamName !== upstreamName ||
        subscription.originalUri !== originalUri
      ) {
        continue;
      }
      if (subscription.state === "pending") {
        subscription.pendingUpdates += 1;
      } else {
        activeSubscriptions.push(subscription);
      }
    }
    await Promise.all(activeSubscriptions.map((subscription) => this.server.sendResourceUpdated({ uri: subscription.exposedUri })));
  }

  private resourceSubscriptionUpstreamName(upstreamName: string | undefined): string {
    return upstreamName ?? "default";
  }

  private async handleUpstreamListChanged(profile: string, kind: "prompts" | "resources" | "tools"): Promise<void> {
    if (kind === "tools") {
      // An upstream may notify while its initial tools/list response is building
      // this profile's first snapshot. Defer the invalidation until that request
      // publishes its response: invalidating immediately would restart discovery
      // and can livelock when an upstream emits a notification for every list.
      if (this.toolRegistry.hasPending(profile) && this.hasActiveToolListDiscovery(profile)) {
        this.deferredToolInvalidations.add(profile);
      } else {
        this.deferredToolInvalidations.delete(profile);
        if (this.toolRegistry.peek(profile) !== undefined) this.toolRegistry.invalidate(profile);
      }
      if (profile === this.profiles.current().activeProfile && this.server.transport) {
        await this.server.sendToolListChanged();
      }
      return;
    }
    if (kind === "resources") {
      this.resourcePromptRegistry?.invalidateResources(profile);
      if (profile === this.profiles.current().activeProfile) await this.notifyResourceListChanged();
      return;
    }
    this.resourcePromptRegistry?.invalidatePrompts(profile);
    if (profile === this.profiles.current().activeProfile) await this.notifyPromptListChanged();
  }

  /**
   * Applies a tools/list_changed notification that arrived before the initial
   * snapshot was published. The caller may still return that in-flight list
   * response, but no later operation may reuse its routes.
   */
  private consumeDeferredToolInvalidation(profile: string): boolean {
    if (!this.deferredToolInvalidations.delete(profile)) return false;
    this.toolRegistry.invalidate(profile);
    return true;
  }

  private assertToolSnapshotCurrent(profile: string): void {
    if (!this.consumeDeferredToolInvalidation(profile)) return;
    throw new MiftahError(
      "UPSTREAM_DISCOVERY_FAILED",
      "UPSTREAM_DISCOVERY_FAILED: upstream tools changed during discovery; retry the request"
    );
  }

  private hasActiveToolListDiscovery(profile: string): boolean {
    return (this.activeToolListDiscoveries.get(profile) ?? 0) > 0;
  }

  private async loadToolSnapshotForList(
    profile: string,
    options?: UpstreamRequestOptions
  ): Promise<ToolListSnapshotLoad> {
    // A list notification observed while a direct tools/call warms an idle
    // snapshot does not make that call's newly returned routes stale. Track
    // only client-visible list discovery so such a notification can defer the
    // cache invalidation until that list response has been published.
    const tracked = !this.toolRegistry.peek(profile)?.isComplete();
    if (tracked) {
      this.activeToolListDiscoveries.set(profile, (this.activeToolListDiscoveries.get(profile) ?? 0) + 1);
    }
    let finished = false;
    const finish = (published: boolean): void => {
      if (finished) return;
      finished = true;
      if (!tracked) return;

      const remaining = Math.max(0, (this.activeToolListDiscoveries.get(profile) ?? 1) - 1);
      if (remaining === 0) this.activeToolListDiscoveries.delete(profile);
      else this.activeToolListDiscoveries.set(profile, remaining);

      if (published) {
        this.consumeDeferredToolInvalidation(profile);
      } else if (remaining === 0 && this.deferredToolInvalidations.delete(profile)) {
        // The final client-visible list did not publish the snapshot that was
        // current when the notification arrived. Do not leave its deferred
        // marker to poison a later cold tools/call.
        this.toolRegistry.invalidate(profile);
      }
    };
    try {
      return { snapshot: await this.toolRegistry.get(profile, options), finish };
    } catch (error) {
      finish(false);
      throw error;
    }
  }

  private reportUpstreamNotificationFailure(error: unknown): void {
    const safeError = this.toSafeError(error);
    process.emitWarning(safeError.message, { code: "MIFTAH_UPSTREAM_NOTIFICATION_FAILED" });
  }

  private reportResourceSubscriptionCapabilityFailure(error: unknown): void {
    const safeError = this.toSafeError(error);
    process.emitWarning(safeError.message, { code: "MIFTAH_RESOURCE_SUBSCRIPTION_CAPABILITY_UNAVAILABLE" });
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
    this.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const source = await this.captureStableProfileState();
      const upstreamRequest = this.upstreamRequestContext(extra);
      return this.runAudited(
        { operation: "tools/list", name: "tools", sourceProfile: source.activeProfile },
        async (audit) => {
          const upstream = this.auditUpstreamName();
          if (upstream) audit.update({ upstream });
          const { profile, snapshot } = await this.runWithUpstreamRequest(
            upstreamRequest,
            () => this.activeToolSnapshot(upstreamRequest.options)
          );
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
      const upstreamRequest = this.upstreamRequestContext(extra);
      return this.runAudited(
        {
          operation: isManagementTool ? managementOperation(name) : "tools/call",
          name: isManagementTool ? managementName(name, args) : name,
          sourceProfile: source.activeProfile,
          ...(isApprovalManagementTool ? {} : { arguments: args })
        },
        (audit) =>
          isManagementTool
            ? this.runWithUpstreamRequest(
                upstreamRequest,
                () =>
                  this.handleManagement(
                    name,
                    args,
                    audit,
                    source,
                    { requestId: extra.requestId, signal: extra.signal },
                    upstreamRequest
                  )
              )
            : this.handleUpstreamTool(
                name,
                args,
                audit,
                source,
                { requestId: extra.requestId, signal: extra.signal },
                upstreamRequest
              ),
        (error) => textResult(error.message, true),
        (result) =>
          result.isError
            ? { status: "failure", errorCode: "UPSTREAM_CALL_FAILED" }
            : { status: "success" }
      );
    });

    if (this.resourcePromptProxy.available) {
      const upstreamName = this.resourcePromptProxy.upstreamName;
      this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const upstreamRequest = this.upstreamRequestContext(extra);
        return this.runAudited(
          {
            operation: "resources/templates/list",
            name: "resource-templates",
            sourceProfile: source.activeProfile,
            arguments: request.params ?? {}
          },
          async (audit) => this.runWithUpstreamRequest(upstreamRequest, async () => {
            const upstream = this.resourcePromptRegistry ? undefined : this.auditUpstreamName(upstreamName);
            if (upstream) audit.update({ upstream });
            if (this.resourcePromptRegistry) {
              try {
                return await this.resourcePromptRegistry.listResourceTemplates(
                  source.activeProfile,
                  request.params?.cursor,
                  upstreamRequest.options
                );
              } finally {
                await this.notifyResourceAvailabilityChange(source.activeProfile);
              }
            }
            return redactDirectResourceTemplateList(
              await this.discoverResourceTemplates(source.activeProfile, upstreamName, request.params, upstreamRequest.options)
            );
          })
        );
      });

      this.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const approvalContext: ApprovalRequestContext = { requestId: extra.requestId, signal: extra.signal };
        const upstreamRequest = this.upstreamRequestContext(extra);
        return this.runAudited(
          {
            operation: "resources/subscribe",
            name: this.redactor.redactUri(request.params.uri),
            sourceProfile: source.activeProfile,
            arguments: { uri: this.redactor.redactUri(request.params.uri) }
          },
          async (audit) => {
            if (!this.resourceSubscriptionsAvailable) {
              throw new MiftahError(
                "RESOURCE_SUBSCRIPTION_UNSUPPORTED",
                "RESOURCE_SUBSCRIPTION_UNSUPPORTED: no active upstream supports resource subscriptions"
              );
            }
            await this.subscribeResource(source, upstreamName, request.params, audit, approvalContext, upstreamRequest);
            return {};
          }
        );
      });

      this.server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const approvalContext: ApprovalRequestContext = { requestId: extra.requestId, signal: extra.signal };
        const upstreamRequest = this.upstreamRequestContext(extra);
        return this.runAudited(
          {
            operation: "resources/unsubscribe",
            name: this.redactor.redactUri(request.params.uri),
            sourceProfile: source.activeProfile,
            arguments: { uri: this.redactor.redactUri(request.params.uri) }
          },
          async (audit) => {
            if (!this.resourceSubscriptionsAvailable) {
              throw new MiftahError(
                "RESOURCE_SUBSCRIPTION_UNSUPPORTED",
                "RESOURCE_SUBSCRIPTION_UNSUPPORTED: no active upstream supports resource subscriptions"
              );
            }
            await this.unsubscribeResource(source, request.params, audit, approvalContext, upstreamRequest);
            return {};
          }
        );
      });

      this.server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const upstreamRequest = this.upstreamRequestContext(extra);
        return this.runAudited(
          {
            operation: "resources/list",
            name: "resources",
            sourceProfile: source.activeProfile,
            arguments: request.params ?? {}
          },
          async (audit) => this.runWithUpstreamRequest(upstreamRequest, async () => {
            const upstream = this.resourcePromptRegistry ? undefined : this.auditUpstreamName(upstreamName);
            if (upstream) audit.update({ upstream });
            if (this.resourcePromptRegistry) {
              try {
                return await this.resourcePromptRegistry.listResources(
                  source.activeProfile,
                  request.params?.cursor,
                  upstreamRequest.options
                );
              } finally {
                await this.notifyResourceAvailabilityChange(source.activeProfile);
              }
            }
            return redactDirectResourceList(
              await this.discoverResources(source.activeProfile, upstreamName, request.params, upstreamRequest.options)
            );
          })
        );
      });

      this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const approvalContext: ApprovalRequestContext = { requestId: extra.requestId, signal: extra.signal };
        const upstreamRequest = this.upstreamRequestContext(extra);
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
                return await this.executeResourceRead(source, upstreamName, request.params, audit, approvalContext, upstreamRequest);
              } finally {
                await this.notifyResourceAvailabilityChange(source.activeProfile);
              }
            }
            return this.executeResourceRead(source, upstreamName, request.params, audit, approvalContext, upstreamRequest);
          }
        );
      });

      this.server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const upstreamRequest = this.upstreamRequestContext(extra);
        return this.runAudited(
          {
            operation: "prompts/list",
            name: "prompts",
            sourceProfile: source.activeProfile,
            arguments: request.params ?? {}
          },
          async (audit) => this.runWithUpstreamRequest(upstreamRequest, async () => {
            const upstream = this.resourcePromptRegistry ? undefined : this.auditUpstreamName(upstreamName);
            if (upstream) audit.update({ upstream });
            if (this.resourcePromptRegistry) {
              try {
                return await this.resourcePromptRegistry.listPrompts(
                  source.activeProfile,
                  request.params?.cursor,
                  upstreamRequest.options
                );
              } finally {
                await this.notifyPromptAvailabilityChange(source.activeProfile);
              }
            }
            return redactDirectPromptList(
              await this.discoverPrompts(source.activeProfile, upstreamName, request.params, upstreamRequest.options)
            );
          })
        );
      });

      this.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
        const source = await this.captureStableProfileState();
        const approvalContext: ApprovalRequestContext = { requestId: extra.requestId, signal: extra.signal };
        const upstreamRequest = this.upstreamRequestContext(extra);
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
                return await this.executePromptGet(source, upstreamName, request.params, audit, approvalContext, upstreamRequest);
              } finally {
                await this.notifyPromptAvailabilityChange(source.activeProfile);
              }
            }
            return this.executePromptGet(source, upstreamName, request.params, audit, approvalContext, upstreamRequest);
          }
        );
      });
    }
  }

  private upstreamRequestContext(extra: ProxiedRequestExtra): UpstreamRequestContext {
    const progressToken = extra._meta?.progressToken;
    let forwardingFailure: unknown;
    let pending = Promise.resolve();
    const options: UpstreamRequestOptions = {
      signal: extra.signal,
      ...(progressToken === undefined
        ? {}
        : {
            onprogress: ({ progress, total, message }) => {
              const safeMessage = message === undefined ? undefined : this.redactor.redactText(message);
              pending = pending
                .then(() =>
                  extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress,
                      ...(total === undefined ? {} : { total }),
                      ...(safeMessage === undefined ? {} : { message: safeMessage })
                    }
                  })
                )
                .catch((error: unknown) => {
                  forwardingFailure ??= error;
                });
            }
          })
    };
    return {
      options,
      async flush(): Promise<void> {
        await pending;
        if (forwardingFailure !== undefined) throw forwardingFailure;
      }
    };
  }

  private async runWithUpstreamRequest<Result>(
    upstreamRequest: UpstreamRequestContext | undefined,
    operation: () => Promise<Result>
  ): Promise<Result> {
    try {
      return await operation();
    } finally {
      await upstreamRequest?.flush();
    }
  }

  private async handleUpstreamTool(
    name: string,
    args: Record<string, unknown>,
    audit: AuditScope,
    sourceState: CapturedProfileState,
    approvalContext?: ApprovalRequestContext,
    upstreamRequest?: UpstreamRequestContext
  ): Promise<CallToolResult> {
    return this.runWithUpstreamRequest(upstreamRequest, async () => {
      const sourceProfile = sourceState.activeProfile;
      const previous = this.toolRegistry.peek(sourceProfile) ?? this.invalidatedToolSnapshots.get(sourceProfile);
      const sourceSnapshot = await this.toolRegistry.get(sourceProfile, upstreamRequest?.options);
      this.assertToolSnapshotCurrent(sourceProfile);
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
          matcherToolName: name,
          policyName: mapped.originalName,
          name: mapped.originalName,
          args,
          ...(approvalContext === undefined ? {} : { approvalContext }),
          ...(upstreamRequest === undefined ? {} : { upstreamRequestOptions: upstreamRequest.options }),
          riskMetadataForProfile: (profile) => {
            const target = this.toolRegistry.peek(profile)?.resolve(name);
            return hasCompatibleCachedToolTarget(mapped, target) ? this.riskMetadata(target) : undefined;
          },
          requireExplicitRuleForDestructive: this.config.security?.requireExplicitProfileForDestructive,
          requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
          resolveTarget: async (profile) => {
            const targetSnapshot = await this.toolRegistry.get(profile, upstreamRequest?.options);
            this.assertToolSnapshotCurrent(profile);
            const target = targetSnapshot.resolve(name);
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
              execute: (session, options) => session.callTool({ name: target.originalName, arguments: args }, options),
              redact: (result) => result
            };
          }
        },
        audit
      );
    });
  }

  private async handleManagement(
    name: string,
    args: Record<string, unknown>,
    audit: AuditScope,
    source: ProfileStateSnapshot,
    approvalContext?: ApprovalRequestContext,
    upstreamRequest?: UpstreamRequestContext
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
        await this.invalidateResourcePromptProfiles(switched.previousProfile, switched.activeProfile);
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
        await this.invalidateResourcePromptProfiles(reset.previousProfile, reset.activeProfile);
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
      const loaded = await this.loadToolSnapshotForList(profile, upstreamRequest?.options);
      try {
        const tools = loaded.snapshot.getTools();
        loaded.finish(true);
        return textResult(JSON.stringify(tools.map((item) => ({ name: item.name, description: item.description }))));
      } catch (error) {
        loaded.finish(false);
        throw error;
      }
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
          this.bindUpstreamSession(session, upstreamName);
          return this.identities.verify(profile, upstreamName, session, {
            force: true,
            request: upstreamRequest?.options
          });
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
      let route;
      try {
        route = await this.routing.resolveWithPlugins(
          {
            toolName,
            matcherToolName: toolName,
            args: isRecord(args.args) ? args.args : {},
            context: snapshot.context,
            matcherContext: snapshot.matcherContext,
            profileHints: snapshot.profileHints
          },
          source.activeProfile,
          upstreamRequest?.options.signal
        );
      } catch (error) {
        const matcherEvidence = matcherEvidenceFromError(error);
        if (matcherEvidence !== undefined) {
          audit.update({ routingMatcherEvidence: this.redactor.redactForAudit(matcherEvidence) });
        }
        throw error;
      }
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
        routingEvidence: evidence,
        ...(route.matcherEvidence === undefined
          ? {}
          : { routingMatcherEvidence: this.redactor.redactForAudit(route.matcherEvidence) })
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

  private async discoverTools(profile: string, options?: UpstreamRequestOptions): Promise<ToolDiscoveryResult> {
    const profiles =
      this.config.tooling?.toolDiscoveryMode === "strict" ? Object.keys(this.config.profiles).sort() : [profile];
    const upstreamNames = this.upstreamNames();
    const optionsForUpstream = aggregateProgressOptions(
      options,
      profiles.flatMap((profileName) => upstreamNames.map((upstreamName) => toolDiscoveryProgressKey(profileName, upstreamName)))
    );
    const outcomes = await Promise.all(
      profiles.map(async (name) => [
        name,
        await this.discoverToolsForProfile(
          name,
          upstreamNames,
          (upstreamName) => optionsForUpstream(toolDiscoveryProgressKey(name, upstreamName))
        )
      ] as const)
    );
    this.assertUpstreamRequestActive(options);
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

  private async discoverToolsForProfile(
    profile: string,
    upstreamNames: readonly (string | undefined)[],
    optionsForUpstream: (upstreamName: string | undefined) => UpstreamRequestOptions | undefined
  ): Promise<{
    discovered: DiscoveredTools[];
    failures: Array<{ upstreamName: string; code: string; message: string }>;
  }> {
    const discoveries = await Promise.allSettled(
      upstreamNames.map(async (upstreamName) => ({
        upstreamName,
        tools: await this.discoverUpstreamTools(profile, upstreamName, optionsForUpstream(upstreamName))
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

  private async discoverUpstreamTools(
    profile: string,
    upstreamName: string | undefined,
    options?: UpstreamRequestOptions
  ): Promise<Tool[]> {
    try {
      const tools = (await this.callUpstream(profile, upstreamName, (session) => session.listTools(options))).tools;
      this.upstreams.recordCapabilitySuccess(profile, "tools", upstreamName);
      return tools;
    } catch (error) {
      if (options?.signal?.aborted) throw upstreamRequestCancelled();
      const failure = new MiftahError(
        "UPSTREAM_TOOL_LIST_FAILED",
        `UPSTREAM_TOOL_LIST_FAILED: unable to list tools for '${profile}'`,
        { cause: this.redactor.redactText(error instanceof Error ? error.message : String(error)) }
      );
      this.upstreams.recordCapabilityFailure(profile, "tools", failure, upstreamName);
      throw failure;
    }
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

  private async subscribeResource(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: SubscribeRequest["params"],
    audit: AuditScope,
    approvalContext: ApprovalRequestContext,
    upstreamRequest: UpstreamRequestContext
  ): Promise<void> {
    const subscriptionEpoch = this.resourceSubscriptionEpoch;
    return this.enqueueResourceSubscriptionTransition(params.uri, () =>
      this.subscribeResourceOnce(source, upstreamName, params, audit, approvalContext, upstreamRequest, subscriptionEpoch)
    );
  }

  private async subscribeResourceOnce(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: SubscribeRequest["params"],
    audit: AuditScope,
    approvalContext: ApprovalRequestContext,
    upstreamRequest: UpstreamRequestContext,
    subscriptionEpoch: number
  ): Promise<void> {
    if (!this.resourceSubscriptionsAvailable) {
      throw new MiftahError(
        "RESOURCE_SUBSCRIPTION_UNSUPPORTED",
        "RESOURCE_SUBSCRIPTION_UNSUPPORTED: Miftah cannot proxy resource subscriptions for every selectable upstream"
      );
    }
    if (this.resourceSubscriptions.has(params.uri)) return;
    let subscription: ResourceSubscription | undefined;
    await this.runWithUpstreamRequest(upstreamRequest, () => this.operationPipeline.execute<void>(
      {
        source,
        operation: "resources/subscribe",
        routingName: "resources/read",
        policyName: "resources/read",
        name: params.uri,
        args: { uri: params.uri },
        approvalContext,
        upstreamRequestOptions: upstreamRequest.options,
        requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
        resolveTarget: async (profile) => {
          this.assertResourceSubscriptionEpoch(subscriptionEpoch);
          const route = await this.resolveResourceSubscription(profile, upstreamName, params.uri, upstreamRequest.options);
          this.assertResourceSubscriptionEpoch(subscriptionEpoch);
          return {
            ...(route.upstreamName === undefined ? {} : { upstreamName: route.upstreamName }),
            ...(route.upstreamName === undefined ? {} : { identityUpstreamName: route.upstreamName }),
            name: route.originalUri,
            execute: async (session, options) => {
              this.assertResourceSubscriptionEpoch(subscriptionEpoch);
              if (!session.supportsResourceSubscriptions()) {
                throw new MiftahError(
                  "RESOURCE_SUBSCRIPTION_UNSUPPORTED",
                  "RESOURCE_SUBSCRIPTION_UNSUPPORTED: the selected upstream does not support resource subscriptions"
                );
              }
              const candidate: ResourceSubscription = { ...route, session, state: "pending", pendingUpdates: 0 };
              subscription = candidate;
              this.resourceSubscriptions.set(params.uri, candidate);
              const controller = new AbortController();
              const parentSignal = options?.signal;
              const abort = () => controller.abort();
              if (parentSignal?.aborted) abort();
              else parentSignal?.addEventListener("abort", abort, { once: true });
              candidate.abortPending = abort;
              try {
                await session.subscribeResource({ uri: route.originalUri }, { ...options, signal: controller.signal });
                candidate.abortPending = undefined;
                if (this.resourceSubscriptions.get(params.uri) !== candidate || candidate.cleanupRequested) {
                  candidate.cleanupRequested = true;
                  await this.cleanupResourceSubscriptionOnce(candidate);
                  subscription = undefined;
                  throw new MiftahError(
                    "RESOURCE_SUBSCRIPTION_NOT_FOUND",
                    "RESOURCE_SUBSCRIPTION_NOT_FOUND: the resource subscription was invalidated before it became active"
                  );
                }
                candidate.release = session.retain();
                candidate.state = "active";
                await this.flushPendingResourceUpdates(candidate);
              } catch (error) {
                const invalidated = this.resourceSubscriptions.get(params.uri) !== candidate || candidate.cleanupRequested;
                candidate.abortPending = undefined;
                if (this.resourceSubscriptions.get(params.uri) === candidate) {
                  this.resourceSubscriptions.delete(params.uri);
                }
                // MCP cancellation is advisory: the upstream can still finish the
                // subscribe request after its client-side promise has rejected.
                // Keep the bounded cleanup in this URI's transition so a retry
                // cannot be unsubscribed by a late cleanup from this attempt.
                candidate.cleanupRequested = true;
                await this.cleanupResourceSubscriptionOnce(candidate);
                subscription = undefined;
                if (invalidated) {
                  throw new MiftahError(
                    "RESOURCE_SUBSCRIPTION_NOT_FOUND",
                    "RESOURCE_SUBSCRIPTION_NOT_FOUND: the resource subscription was invalidated before it became active"
                  );
                }
                throw error;
              } finally {
                parentSignal?.removeEventListener("abort", abort);
              }
            },
            redact: () => undefined
          };
        }
      },
      audit
    ));
    if (subscription === undefined) {
      throw new MiftahError(
        "RESOURCE_SUBSCRIPTION_UNSUPPORTED",
        "RESOURCE_SUBSCRIPTION_UNSUPPORTED: the selected upstream did not establish a resource subscription"
      );
    }
  }

  private async unsubscribeResource(
    source: CapturedProfileState,
    params: UnsubscribeRequest["params"],
    audit: AuditScope,
    approvalContext: ApprovalRequestContext,
    upstreamRequest: UpstreamRequestContext
  ): Promise<void> {
    return this.enqueueResourceSubscriptionTransition(params.uri, () =>
      this.unsubscribeResourceOnce(source, params, audit, approvalContext, upstreamRequest)
    );
  }

  private assertResourceSubscriptionEpoch(epoch: number): void {
    if (epoch === this.resourceSubscriptionEpoch) return;
    throw new MiftahError(
      "RESOURCE_SUBSCRIPTION_NOT_FOUND",
      "RESOURCE_SUBSCRIPTION_NOT_FOUND: the resource subscription was invalidated before it became active"
    );
  }

  private async unsubscribeResourceOnce(
    source: CapturedProfileState,
    params: UnsubscribeRequest["params"],
    audit: AuditScope,
    approvalContext: ApprovalRequestContext,
    upstreamRequest: UpstreamRequestContext
  ): Promise<void> {
    const subscription = this.resourceSubscriptions.get(params.uri);
    if (!subscription) {
      throw new MiftahError(
        "RESOURCE_SUBSCRIPTION_NOT_FOUND",
        "RESOURCE_SUBSCRIPTION_NOT_FOUND: the resource is not subscribed for this connection"
      );
    }
    try {
      await this.runWithUpstreamRequest(upstreamRequest, () => this.operationPipeline.execute<void>(
        {
          source,
          operation: "resources/unsubscribe",
          routingName: "resources/read",
          policyName: "resources/read",
          name: subscription.originalUri,
          args: { uri: params.uri },
          approvalContext,
          upstreamRequestOptions: upstreamRequest.options,
          requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
          resolveTarget: async (profile) => {
            if (profile !== subscription.profile) {
              throw new MiftahError(
                "RESOURCE_SUBSCRIPTION_NOT_FOUND",
                "RESOURCE_SUBSCRIPTION_NOT_FOUND: the resource subscription is not active for the routed profile"
              );
            }
            return {
              ...(subscription.upstreamName === undefined ? {} : { upstreamName: subscription.upstreamName }),
              ...(subscription.upstreamName === undefined ? {} : { identityUpstreamName: subscription.upstreamName }),
              name: subscription.originalUri,
              execute: async (session, options) => {
                if (!session.supportsResourceSubscriptions()) {
                  throw new MiftahError(
                    "RESOURCE_SUBSCRIPTION_UNSUPPORTED",
                    "RESOURCE_SUBSCRIPTION_UNSUPPORTED: the selected upstream does not support resource subscriptions"
                  );
                }
                await session.unsubscribeResource({ uri: subscription.originalUri }, options);
              },
              redact: () => undefined
            };
          }
        },
        audit
      ));
    } catch (error) {
      if (upstreamRequest.options.signal?.aborted && this.resourceSubscriptions.get(params.uri) === subscription) {
        // MCP cancellation is advisory. Stop forwarding updates and retain the
        // session only long enough to issue one bounded cleanup unsubscribe.
        this.resourceSubscriptions.delete(params.uri);
        subscription.cleanupRequested = true;
        await this.cleanupResourceSubscriptionOnce(subscription);
      }
      throw error;
    }
    this.resourceSubscriptions.delete(params.uri);
    subscription.release?.();
  }

  private async resolveResourceSubscription(
    profile: string,
    upstreamName: string | undefined,
    exposedUri: string,
    options?: UpstreamRequestOptions
  ): Promise<ResourceSubscriptionRoute> {
    if (this.resourcePromptRegistry) {
      const route = await this.resolveAggregatedResource(profile, { uri: exposedUri }, options);
      return {
        profile,
        upstreamName: route.upstreamName,
        originalUri: route.name,
        exposedUri
      };
    }
    return { profile, upstreamName, originalUri: exposedUri, exposedUri };
  }

  private async executeResourceRead(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: ReadResourceRequest["params"],
    audit: AuditScope,
    approvalContext?: ApprovalRequestContext,
    upstreamRequest?: UpstreamRequestContext
  ): Promise<ReadResourceResult> {
    return this.runWithUpstreamRequest(upstreamRequest, () => this.operationPipeline.execute(
      {
        source,
        operation: "resources/read",
        routingName: "resources/read",
        policyName: "resources/read",
        name: params.uri,
        args: { uri: params.uri },
        ...(approvalContext === undefined ? {} : { approvalContext }),
        ...(upstreamRequest === undefined ? {} : { upstreamRequestOptions: upstreamRequest.options }),
        requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
        resolveTarget: async (profile) => {
          if (this.resourcePromptRegistry) return this.resolveAggregatedResource(profile, params, upstreamRequest?.options);
          const auditUpstream = this.auditUpstreamName(upstreamName);
          return {
            ...(auditUpstream === undefined ? {} : { upstreamName: auditUpstream }),
            ...(upstreamName === undefined ? {} : { identityUpstreamName: upstreamName }),
            name: params.uri,
            execute: (session, options) => session.readResource(params, options),
            redact: redactDirectReadResult
          };
        }
      },
      audit
    ));
  }

  private async executePromptGet(
    source: CapturedProfileState,
    upstreamName: string | undefined,
    params: GetPromptRequest["params"],
    audit: AuditScope,
    approvalContext?: ApprovalRequestContext,
    upstreamRequest?: UpstreamRequestContext
  ): Promise<GetPromptResult> {
    return this.runWithUpstreamRequest(upstreamRequest, () => this.operationPipeline.execute(
      {
        source,
        operation: "prompts/get",
        routingName: "prompts/get",
        policyName: "prompts/get",
        name: params.name,
        args: { ...(params.arguments ?? {}), name: params.name },
        ...(approvalContext === undefined ? {} : { approvalContext }),
        ...(upstreamRequest === undefined ? {} : { upstreamRequestOptions: upstreamRequest.options }),
        requireExplicitSelectionForDestructive: this.config.security?.requireExplicitSelectionForDestructive,
        resolveTarget: async (profile) => {
          if (this.resourcePromptRegistry) return this.resolveAggregatedPrompt(profile, params, upstreamRequest?.options);
          const auditUpstream = this.auditUpstreamName(upstreamName);
          return {
            ...(auditUpstream === undefined ? {} : { upstreamName: auditUpstream }),
            ...(upstreamName === undefined ? {} : { identityUpstreamName: upstreamName }),
            name: params.name,
            execute: (session, options) => session.getPrompt(params, options),
            redact: redactDirectPromptResult
          };
        }
      },
      audit
    ));
  }

  private async discoverResources(
    profile: string,
    upstreamName: string | undefined,
    params?: ListResourcesRequest["params"],
    options?: UpstreamRequestOptions
  ): Promise<ListResourcesResult> {
    try {
      const result = await this.callUpstream(profile, upstreamName, (session) => session.listResources(params, options));
      this.upstreams.recordCapabilitySuccess(profile, "resources", upstreamName);
      return result;
    } catch (error) {
      if (options?.signal?.aborted) throw upstreamRequestCancelled();
      this.upstreams.recordCapabilityFailure(profile, "resources", error, upstreamName);
      throw error;
    }
  }

  private async discoverResourceTemplates(
    profile: string,
    upstreamName: string | undefined,
    params?: ListResourceTemplatesRequest["params"],
    options?: UpstreamRequestOptions
  ): Promise<ListResourceTemplatesResult> {
    try {
      const result = await this.callUpstream(
        profile,
        upstreamName,
        (session) => session.listResourceTemplates(params, options),
        (error) =>
          !isMethodNotFoundError(error)
            ? undefined
            : new MiftahError(
                "RESOURCE_TEMPLATES_UNAVAILABLE",
                `RESOURCE_TEMPLATES_UNAVAILABLE: upstream '${this.auditUpstreamName(upstreamName) ?? "default"}' does not implement resource templates`
              )
      );
      this.upstreams.recordCapabilitySuccess(profile, "resources", upstreamName);
      return result;
    } catch (error) {
      if (options?.signal?.aborted) throw upstreamRequestCancelled();
      this.upstreams.recordCapabilityFailure(profile, "resources", error, upstreamName);
      throw error;
    }
  }

  private async discoverPrompts(
    profile: string,
    upstreamName: string | undefined,
    params?: ListPromptsRequest["params"],
    options?: UpstreamRequestOptions
  ): Promise<ListPromptsResult> {
    try {
      const result = await this.callUpstream(profile, upstreamName, (session) => session.listPrompts(params, options));
      this.upstreams.recordCapabilitySuccess(profile, "prompts", upstreamName);
      return result;
    } catch (error) {
      if (options?.signal?.aborted) throw upstreamRequestCancelled();
      this.upstreams.recordCapabilityFailure(profile, "prompts", error, upstreamName);
      throw error;
    }
  }

  private async callUpstream<Result>(
    profile: string,
    upstreamName: string | undefined,
    operation: (session: UpstreamSession) => Promise<Result>,
    mapError?: (error: unknown) => MiftahError | undefined
  ): Promise<Result> {
    try {
      const session = await this.upstreams.get(profile, upstreamName);
      this.bindUpstreamSession(session, upstreamName);
      return await operation(session);
    } catch (error) {
      throw mapError?.(error) ?? this.toSafeError(error);
    }
  }

  private assertUpstreamRequestActive(options?: UpstreamRequestOptions): void {
    if (options?.signal?.aborted) throw upstreamRequestCancelled();
  }

  private async resolveAggregatedResource(
    profile: string,
    params: ReadResourceRequest["params"],
    options?: UpstreamRequestOptions
  ): Promise<ResolvedOperation<ReadResourceResult>> {
    if (!this.resourcePromptRegistry) throw new Error("Resource aggregation is unavailable");
    const registry = this.resourcePromptRegistry;
    let epoch = registry.captureEpoch(profile);
    let route = registry.resolveResource(profile, params.uri);
    if (!route) {
      await this.listResourcesForCapturedOperation(profile, registry, options);
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
      execute: (session, options) => session.readResource({ ...params, uri: route.originalUri }, options),
      redact: (result) => registry.redactReadResult(route, result, epoch)
    };
  }

  private async resolveAggregatedPrompt(
    profile: string,
    params: GetPromptRequest["params"],
    options?: UpstreamRequestOptions
  ): Promise<ResolvedOperation<GetPromptResult>> {
    if (!this.resourcePromptRegistry) throw new Error("Prompt aggregation is unavailable");
    const registry = this.resourcePromptRegistry;
    let epoch = registry.captureEpoch(profile);
    let route = registry.resolvePrompt(profile, params.name);
    if (!route) {
      await this.listPromptsForCapturedOperation(profile, registry, options);
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
      execute: (session, options) => session.getPrompt({ ...params, name: route.originalName }, options),
      redact: (result) => registry.redactPromptResult(route, result, epoch)
    };
  }

  private async listResourcesForCapturedOperation(
    profile: string,
    registry: ResourcePromptRegistry,
    options?: UpstreamRequestOptions
  ): Promise<void> {
    try {
      await registry.listResources(profile, undefined, options);
    } catch (error) {
      if (!(error instanceof MiftahError) || error.code !== "RESOURCE_DISCOVERY_INVALIDATED") throw error;
      await registry.listResources(profile, undefined, options);
    } finally {
      await this.notifyResourceAvailabilityChange(profile);
    }
  }

  private async listPromptsForCapturedOperation(
    profile: string,
    registry: ResourcePromptRegistry,
    options?: UpstreamRequestOptions
  ): Promise<void> {
    try {
      await registry.listPrompts(profile, undefined, options);
    } catch (error) {
      if (!(error instanceof MiftahError) || error.code !== "PROMPT_DISCOVERY_INVALIDATED") throw error;
      await registry.listPrompts(profile, undefined, options);
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

  private async activeToolSnapshot(options?: UpstreamRequestOptions): Promise<{ profile: string; snapshot: ToolSnapshot }> {
    for (;;) {
      const state = await this.captureStableProfileState();
      const previous =
        this.toolRegistry.peek(state.activeProfile) ?? this.invalidatedToolSnapshots.get(state.activeProfile);
      const loaded = await this.loadToolSnapshotForList(state.activeProfile, options);
      if (this.profiles.current().revision !== state.revision) {
        loaded.finish(false);
        continue;
      }
      try {
        if (previous !== undefined) await this.notifyToolListChanged(previous, loaded.snapshot);
        this.invalidatedToolSnapshots.delete(state.activeProfile);
        loaded.finish(true);
        return { profile: state.activeProfile, snapshot: loaded.snapshot };
      } catch (error) {
        loaded.finish(false);
        throw error;
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
    this.dropResourceSubscriptions((subscription) => subscription.profile === profile);
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
      const hadResourceTemplates = this.resourcePromptRegistry.hasResourceTemplateRoutes(profile);
      const hadPrompts = this.resourcePromptRegistry.hasPromptRoutes(profile);
      this.resourcePromptRegistry.invalidate(profile);
      if (hadResources || hadResourceTemplates) this.pendingResourceListChanges.add(profile);
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

  private async invalidateResourcePromptProfiles(...profiles: string[]): Promise<void> {
    this.resourceSubscriptionEpoch += 1;
    const invalidatedProfiles = new Set(profiles);
    await this.unsubscribeResourceSubscriptions(() => true);
    for (const profile of invalidatedProfiles) {
      this.resourcePromptRegistry?.invalidate(profile);
      this.pendingResourceListChanges.delete(profile);
      this.pendingPromptListChanges.delete(profile);
    }
  }

  private dropResourceSubscriptions(predicate: (subscription: ResourceSubscription) => boolean): void {
    for (const [uri, subscription] of [...this.resourceSubscriptions]) {
      if (!predicate(subscription)) continue;
      this.resourceSubscriptions.delete(uri);
      if (subscription.state === "pending") {
        subscription.cleanupRequested = true;
        subscription.abortPending?.();
        continue;
      }
      subscription.release?.();
    }
  }

  private enqueueResourceSubscriptionTransition<Result>(uri: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.resourceSubscriptionTransitions.get(uri) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.resourceSubscriptionTransitions.set(uri, settled);
    void settled.then(() => {
      if (this.resourceSubscriptionTransitions.get(uri) === settled) {
        this.resourceSubscriptionTransitions.delete(uri);
      }
    });
    return result;
  }

  private async unsubscribeResourceSubscriptions(
    predicate: (subscription: ResourceSubscription) => boolean
  ): Promise<void> {
    const subscriptions: Array<readonly [string, ResourceSubscription]> = [];
    const pendingTransitions: Promise<void>[] = [];
    for (const [uri, subscription] of this.resourceSubscriptions) {
      if (!predicate(subscription)) continue;
      if (subscription.state === "pending") {
        if (this.resourceSubscriptions.get(uri) === subscription) {
          this.resourceSubscriptions.delete(uri);
          subscription.cleanupRequested = true;
          subscription.abortPending?.();
          const transition = this.resourceSubscriptionTransitions.get(uri);
          if (transition !== undefined) pendingTransitions.push(transition);
        }
        continue;
      }
      subscriptions.push([uri, subscription]);
    }
    await Promise.all(
      [...pendingTransitions, ...subscriptions.map(([uri, subscription]) =>
        this.enqueueResourceSubscriptionTransition(uri, async () => {
          // A client-initiated unsubscribe may already be ahead of this cleanup.
          // Its completion removes the route, so sending another upstream unsubscribe
          // here would duplicate a protocol transition.
          if (this.resourceSubscriptions.get(uri) !== subscription) return;
          this.resourceSubscriptions.delete(uri);
          await this.cleanupResourceSubscriptionOnce(subscription);
        })
      )]
    );
  }

  private async flushPendingResourceUpdates(subscription: ResourceSubscription): Promise<void> {
    if (!this.server.transport || subscription.pendingUpdates === 0) return;
    const pendingUpdates = subscription.pendingUpdates;
    subscription.pendingUpdates = 0;
    try {
      await Promise.all(
        Array.from({ length: pendingUpdates }, () => this.server.sendResourceUpdated({ uri: subscription.exposedUri }))
      );
    } catch (error) {
      this.reportUpstreamNotificationFailure(error);
    }
  }

  private cleanupResourceSubscriptionOnce(subscription: ResourceSubscription): Promise<void> {
    if (subscription.cleanupPromise === undefined) {
      subscription.cleanupPromise = this.cleanupResourceSubscription(subscription);
    }
    return subscription.cleanupPromise;
  }

  private async cleanupResourceSubscription(subscription: ResourceSubscription): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.process?.shutdownTimeoutMs ?? defaultResourceSubscriptionCleanupTimeoutMs
    );
    try {
      await subscription.session.unsubscribeResource(
        { uri: subscription.originalUri },
        { signal: controller.signal }
      );
    } catch (error) {
      this.reportResourceSubscriptionCleanupFailure(error);
    } finally {
      clearTimeout(timeout);
      subscription.release?.();
    }
  }

  private reportResourceSubscriptionCleanupFailure(error: unknown): void {
    const safeError = this.toSafeError(error);
    process.emitWarning(safeError.message, { code: "MIFTAH_RESOURCE_SUBSCRIPTION_CLEANUP_FAILED" });
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

function isMethodNotFoundError(error: unknown): error is { readonly code: number } {
  return isRecord(error) && error.code === ErrorCode.MethodNotFound;
}

function upstreamRequestCancelled(): Error {
  return new Error("Upstream request cancelled");
}

function toolDiscoveryProgressKey(profile: string, upstreamName: string | undefined): string {
  return `${profile}\u0000${upstreamName ?? "default"}`;
}

/**
 * Maps concurrent upstream progress streams onto one downstream token. A
 * combined operation deliberately omits `total`: upstream totals are local to
 * each provider and cannot be represented faithfully as one shared total.
 */
function aggregateProgressOptions(
  options: UpstreamRequestOptions | undefined,
  keys: readonly string[]
): (key: string) => UpstreamRequestOptions | undefined {
  const onprogress = options?.onprogress;
  const uniqueKeys = [...new Set(keys)];
  if (onprogress === undefined || uniqueKeys.length <= 1) return () => options;

  const contributions = new Map(uniqueKeys.map((key) => [key, 0]));
  let lastProgress = 0;
  return (key) => ({
    ...options,
    onprogress: ({ progress, total, message }) => {
      const safeProgress = Number.isFinite(progress) ? Math.max(0, progress) : 0;
      const contribution =
        total !== undefined && Number.isFinite(total) && total > 0
          ? Math.min(1, safeProgress / total)
          : safeProgress;
      contributions.set(key, Math.max(contributions.get(key) ?? 0, contribution));
      const aggregate = [...contributions.values()].reduce((sum, value) => sum + value, 0);
      if (aggregate <= lastProgress) return;
      lastProgress = aggregate;
      onprogress({ progress: aggregate, ...(message === undefined ? {} : { message }) });
    }
  });
}

function redactDirectResourceList(result: ListResourcesResult): ListResourcesResult {
  return {
    ...result,
    resources: result.resources.map(redactDirectResource)
  };
}

function redactDirectResourceTemplateList(result: ListResourceTemplatesResult): ListResourceTemplatesResult {
  return {
    ...result,
    resourceTemplates: result.resourceTemplates.map(redactDirectResourceTemplate)
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

function redactDirectResourceTemplate(template: ResourceTemplate): ResourceTemplate {
  return {
    ...template,
    uriTemplate: redactSensitiveUri(template.uriTemplate),
    icons: redactDirectIconSources(template.icons)
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

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
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { MiftahConfig } from "../../config/types.js";
import { redactSecrets } from "../../secrets/redact.js";
import { ProfileManager } from "../../profiles/profile-manager.js";
import { RoutingEngine } from "../../routing/routing-engine.js";
import { PolicyEngine } from "../../policy/policy-engine.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { UpstreamProcessManager } from "../../upstream/upstream-process-manager.js";
import { MultiUpstreamProcessManager } from "../../upstream/multi-upstream-process-manager.js";
import { MiftahError } from "../../utils/errors.js";

const managementTools: Tool[] = [
  tool("miftah_list_profiles", "List configured profiles without exposing secrets."),
  tool("miftah_current_profile", "Show the active and default profile."),
  tool("miftah_use_profile", "Switch the active profile for this MCP session.", ["profile"]),
  tool("miftah_reset_profile", "Reset the active profile to the configured default."),
  tool("miftah_profile_info", "Show non-secret metadata for a profile.", ["profile"]),
  tool("miftah_health", "Show redacted wrapper and upstream health."),
  tool("miftah_validate_config", "Validate the loaded wrapper configuration."),
  tool("miftah_list_upstream_tools", "List tools discovered from an upstream profile.", ["profile"]),
  tool("miftah_restart_profile", "Restart the upstream process for a profile.", ["profile"]),
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

interface ResourcePromptProxyAvailability {
  available: boolean;
  upstreamName?: string;
  reason?: string;
}

export class MiftahServer {
  readonly server: Server;
  private readonly routing: RoutingEngine;
  private readonly policy: PolicyEngine;
  private readonly audit?: AuditLogger;
  private readonly resourcePromptProxy: ResourcePromptProxyAvailability;
  private toolMap = new Map<string, { name: string; upstreamName?: string }>();

  constructor(
    private readonly config: MiftahConfig,
    private readonly profiles: ProfileManager,
    private readonly upstreams: UpstreamProcessManager | MultiUpstreamProcessManager
  ) {
    this.resourcePromptProxy = this.resourcePromptProxyAvailability();
    this.server = new Server(
      { name: `miftah-${config.name}`, version: "0.1.0" },
      {
        capabilities: {
          tools: {},
          ...(this.resourcePromptProxy.available ? { resources: {}, prompts: {} } : {})
        },
        instructions: [
          "Miftah wraps an upstream MCP and routes requests through local credential profiles.",
          ...(this.resourcePromptProxy.available
            ? []
            : ["Resource and prompt proxying is temporarily unavailable for multi-upstream bundles until namespaced aggregation is available."])
        ].join(" ")
      }
    );
    this.routing = new RoutingEngine(config.routing, profiles.current().activeProfile, config.defaultProfile);
    this.policy = new PolicyEngine(config.policies, config.tooling?.toolRiskOverrides ?? {});
    if (config.audit?.enabled !== false && config.audit?.path) {
      this.audit = new AuditLogger(config.audit.path, {
        includeArguments: config.audit.includeArguments,
        secretValues: []
      });
    }
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
      const management = managementTools;
      try {
        const upstreamNames = this.upstreamNames();
        const discovered = await Promise.all(
          upstreamNames.map(async (upstreamName) => ({
            upstreamName,
            tools: await this.upstreams.listTools(this.profiles.current().activeProfile, upstreamName)
          }))
        );
        this.toolMap = new Map();
        const exposedTools = discovered.flatMap(({ upstreamName, tools }) =>
          tools.map((item) => {
            const exposedName = this.exposedToolName(item.name, upstreamName);
            this.toolMap.set(exposedName, { name: item.name, upstreamName });
            return { ...item, name: exposedName };
          })
        );
        return { tools: [...management, ...exposedTools] };
      } catch (error) {
        if (error instanceof MiftahError && error.code === "TOOL_COLLISION") throw error;
        this.toolMap.clear();
        return { tools: management };
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      if (name.startsWith("miftah_")) return this.handleManagement(name, args);
      return this.handleUpstreamTool(name, args);
    });

    if (this.resourcePromptProxy.available) {
      const upstreamName = this.resourcePromptProxy.upstreamName;
      this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const session = await this.upstreams.get(this.profiles.current().activeProfile, upstreamName);
        return session.listResources();
      });

      this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        try {
          const session = await this.upstreams.get(this.profiles.current().activeProfile, upstreamName);
          return redactSecrets(await session.readResource(request.params), this.upstreams.getSecretValues());
        } catch (error) {
          throw new Error(
            redactSecrets(error instanceof Error ? error.message : String(error), this.upstreams.getSecretValues()),
            { cause: error }
          );
        }
      });

      this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
        const session = await this.upstreams.get(this.profiles.current().activeProfile, upstreamName);
        return session.listPrompts();
      });

      this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        try {
          const session = await this.upstreams.get(this.profiles.current().activeProfile, upstreamName);
          return redactSecrets(await session.getPrompt(request.params), this.upstreams.getSecretValues());
        } catch (error) {
          throw new Error(
            redactSecrets(error instanceof Error ? error.message : String(error), this.upstreams.getSecretValues()),
            { cause: error }
          );
        }
      });
    }
  }

  private async handleUpstreamTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const mapped = this.toolMap.get(name);
    const upstreamName = mapped?.name ?? name;
    const targetUpstream = mapped?.upstreamName;
    const startedAt = Date.now();
    try {
      const route = this.routing.resolve({ toolName: upstreamName, args });
      const profile = this.profiles.get(route.profile);
      const decision = this.policy.evaluate(profile.policy, upstreamName);
      if (
        decision.risk === "destructive" &&
        this.config.security?.requireExplicitProfileForDestructive &&
        !route.reason.startsWith("rule:")
      ) {
        return textResult(
          `POLICY_BLOCKED: destructive tool '${upstreamName}' requires an explicit routing rule`,
          true
        );
      }
      if (decision.action === "deny") {
        await this.writeAudit({
          wrapper: this.config.name,
          profile: route.profile,
          operation: "tools/call",
          name: upstreamName,
          status: "blocked",
          durationMs: Date.now() - startedAt,
          routingReason: route.reason,
          policyDecision: decision.action,
          risk: decision.risk
        });
        return textResult(`POLICY_BLOCKED: tool '${upstreamName}' is blocked for profile '${route.profile}'`, true);
      }
      if (decision.action === "confirm") {
        return textResult(
          `POLICY_CONFIRMATION_REQUIRED: tool '${upstreamName}' requires confirmation for profile '${route.profile}'`,
          true
        );
      }
      const result = await (await this.upstreams.get(route.profile, targetUpstream)).callTool({ name: upstreamName, arguments: args });
      await this.writeAudit({
        wrapper: this.config.name,
        profile: route.profile,
        operation: "tools/call",
        name: upstreamName,
        status: "success",
        durationMs: Date.now() - startedAt,
        routingReason: route.reason,
        policyDecision: decision.action,
        risk: decision.risk,
        arguments: args
      });
      return redactSecrets(result, this.upstreams.getSecretValues());
    } catch (error) {
      const safeMessage = redactSecrets(
        error instanceof Error ? error.message : String(error),
        this.upstreams.getSecretValues()
      );
      if (error instanceof MiftahError) {
        return textResult(`${error.code}: ${safeMessage}`, true);
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
        return textResult(JSON.stringify({ ...this.profiles.current(), routingMode: this.config.routing?.mode ?? "hybrid" }));
      }
      if (name === "miftah_use_profile") {
        const profile = requiredString(args, "profile");
        const switched = this.profiles.switch(profile);
        this.routing.setActiveProfile(switched.activeProfile);
        return textResult(`Active profile changed from ${switched.previousProfile} to ${switched.activeProfile}.`);
      }
      if (name === "miftah_reset_profile") {
        const reset = this.profiles.reset();
        this.routing.setActiveProfile(reset.activeProfile);
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
        const tools = await this.upstreams.listTools(String(args.profile ?? this.profiles.current().activeProfile));
        return textResult(JSON.stringify(tools.map((item) => ({ name: item.name, description: item.description }))));
      }
      if (name === "miftah_restart_profile") {
        await this.upstreams.restart(requiredString(args, "profile"));
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

  private resourcePromptProxyAvailability(): ResourcePromptProxyAvailability {
    if (!(this.upstreams instanceof MultiUpstreamProcessManager)) return { available: true };
    const upstreamNames = this.upstreams.listUpstreams();
    if (upstreamNames.length === 1) return { available: true, upstreamName: upstreamNames[0] };
    return {
      available: false,
      reason: "Resource and prompt proxying is unavailable for multi-upstream bundles until namespaced aggregation is available."
    };
  }

  private async writeAudit(event: Parameters<AuditLogger["log"]>[0]): Promise<void> {
    if (this.audit) await this.audit.log(redactSecrets(event, this.upstreams.getSecretValues()));
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

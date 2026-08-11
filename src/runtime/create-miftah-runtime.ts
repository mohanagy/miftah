import type { McpServerFactory, Transport } from "@modelcontextprotocol/server";
import { ApprovalContinuationStore } from "../approvals/approval-continuation-store.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig } from "../config/types.js";
import { MiftahServer } from "../mcp/server/miftah-server.js";
import type { ModernProfileContextRuntimeOptions } from "../profiles/profile-context-handle.js";
import { collectRoutingContext } from "../routing/context-collector.js";
import { createRuntime } from "./create-runtime.js";

/** Encapsulates a configured Miftah MCP server and its managed upstream lifecycle. */
export interface MiftahRuntime {
  /** Resolved configuration used to construct this runtime. */
  readonly config: MiftahConfig;
  /** Connects the wrapper to an MCP transport supplied by the host application. */
  connect(transport: Transport): Promise<void>;
  /** Stops the wrapper and all managed upstream sessions. */
  close(): Promise<void>;
}

export interface MiftahRuntimeOptions {
  /** Enables explicit request-scoped profile handles for a trusted modern host. */
  readonly modernProfileContext?: ModernProfileContextRuntimeOptions;
}

interface MiftahRuntimeFactoryOptions extends MiftahRuntimeOptions {
  readonly profileState?: { readonly persistActiveProfile?: false; readonly scope?: "process" | "session" };
  readonly resourceSubscriptionsEnabled?: boolean;
  readonly approvalContinuations?: ApprovalContinuationStore;
}

async function createConfiguredMiftahServer(
  configPath: string,
  options: MiftahRuntimeFactoryOptions = {}
): Promise<{ readonly config: MiftahConfig; readonly server: MiftahServer }> {
  const runtimeConfigPath = resolvePath(configPath);
  const runtime = await createRuntime(runtimeConfigPath, undefined, { profileState: options.profileState });
  const server = new MiftahServer(
    runtime.config,
    runtime.profileManager,
    runtime.manager,
    (mcpRoots) =>
      collectRoutingContext({
        wrapperName: runtime.config.name,
        knownProfileNames: Object.keys(runtime.config.profiles),
        cwd: process.cwd(),
        environment: process.env,
        runtimeConfigPath,
        mcpRoots
      }),
    runtime.plugins,
    runtime.oauth,
    runtime.identities,
    runtimeConfigPath,
    options.modernProfileContext,
    options.resourceSubscriptionsEnabled,
    options.approvalContinuations
  );

  return { config: runtime.config, server };
}

async function createConfiguredMiftahRuntime(
  configPath: string,
  options: MiftahRuntimeFactoryOptions = {}
): Promise<MiftahRuntime> {
  const configured = await createConfiguredMiftahServer(configPath, options);
  return {
    config: configured.config,
    connect: (transport) => configured.server.connect(transport),
    close: () => configured.server.close()
  };
}

function configuredMiftahServerFactory(
  configPath: string,
  options: MiftahRuntimeFactoryOptions
): McpServerFactory {
  const approvalContinuations = new ApprovalContinuationStore();
  return async (context) => {
    const eraOptions: MiftahRuntimeFactoryOptions = context.era === "modern"
      ? { ...options, resourceSubscriptionsEnabled: false, approvalContinuations }
      : {
          ...(options.profileState === undefined ? {} : { profileState: options.profileState }),
          resourceSubscriptionsEnabled: true,
          approvalContinuations
        };
    const configured = await createConfiguredMiftahServer(configPath, eraOptions);
    try {
      return await configured.server.prepareForServing();
    } catch (error) {
      await configured.server.close().catch(() => undefined);
      throw error;
    }
  };
}

/** Creates an MCP wrapper runtime without exposing its internal manager or server classes. */
export async function createMiftahRuntime(
  configPath: string,
  options: MiftahRuntimeOptions = {}
): Promise<MiftahRuntime> {
  return createConfiguredMiftahRuntime(configPath, options);
}

/** Creates fresh lifecycle-managed server instances for SDK v2 serving entries. */
export function createMiftahServerFactory(
  configPath: string,
  options: MiftahRuntimeOptions = {}
): McpServerFactory {
  return configuredMiftahServerFactory(configPath, options);
}

/** Creates per-request modern HTTP servers whose mutable profile state cannot escape an exchange. */
export function createHttpRequestMiftahServerFactory(configPath: string): McpServerFactory {
  return configuredMiftahServerFactory(configPath, {
    profileState: { persistActiveProfile: false, scope: "session" },
    resourceSubscriptionsEnabled: false
  });
}

/** Creates a fresh MCP runtime whose profile state cannot escape its HTTP client session. */
export async function createHttpSessionRuntime(configPath: string): Promise<MiftahRuntime> {
  return createConfiguredMiftahRuntime(configPath, {
    profileState: { persistActiveProfile: false, scope: "session" }
  });
}

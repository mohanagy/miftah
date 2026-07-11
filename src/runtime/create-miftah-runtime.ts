import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig } from "../config/types.js";
import { MiftahServer } from "../mcp/server/miftah-server.js";
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

/** Creates an MCP wrapper runtime without exposing its internal manager or server classes. */
export async function createMiftahRuntime(configPath: string): Promise<MiftahRuntime> {
  const runtimeConfigPath = resolvePath(configPath);
  const runtime = await createRuntime(runtimeConfigPath);
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
      })
  );

  return {
    config: runtime.config,
    connect: (transport) => server.connect(transport),
    close: () => server.close()
  };
}

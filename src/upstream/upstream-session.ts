import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  GetPromptRequest,
  ListPromptsResult,
  ListPromptsRequest,
  ListResourcesResult,
  ListResourcesRequest,
  ListToolsRequest,
  ListToolsResult,
  ReadResourceRequest
} from "@modelcontextprotocol/sdk/types.js";
import { MiftahError } from "../utils/errors.js";

/** Lets the process manager bracket upstream work so idle shutdown cannot interrupt an active request. */
export interface UpstreamSessionActivity {
  begin(): void;
  end(): void;
}

export type UpstreamRequestErrorMapper = (error: unknown) => MiftahError | undefined;

/** Provides profile-bound MCP operations while reporting their activity to lifecycle management. */
export class UpstreamSession {
  constructor(
    readonly profile: string,
    private readonly client: Client,
    private readonly closeTransport: () => Promise<void>,
    private readonly activity?: UpstreamSessionActivity,
    private readonly mapRequestError?: UpstreamRequestErrorMapper
  ) {}

  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult> {
    return this.request(() => this.client.listTools(params));
  }

  callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.request(() => this.client.callTool(params) as Promise<CallToolResult>);
  }

  listResources(params?: ListResourcesRequest["params"]): Promise<ListResourcesResult> {
    return this.request(() => this.client.listResources(params));
  }

  readResource(params: ReadResourceRequest["params"]) {
    return this.request(() => this.client.readResource(params));
  }

  listPrompts(params?: ListPromptsRequest["params"]): Promise<ListPromptsResult> {
    return this.request(() => this.client.listPrompts(params));
  }

  getPrompt(params: GetPromptRequest["params"]) {
    return this.request(() => this.client.getPrompt(params));
  }

  async close(): Promise<void> {
    await this.closeTransport();
  }

  private async request<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.activity?.begin();
    try {
      return await operation();
    } catch (error) {
      throw this.mapRequestError?.(error) ?? error;
    } finally {
      this.activity?.end();
    }
  }
}

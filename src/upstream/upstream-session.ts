import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  GetPromptRequest,
  ListPromptsResult,
  ListPromptsRequest,
  ListResourcesResult,
  ListResourcesRequest,
  ListToolsResult,
  ReadResourceRequest
} from "@modelcontextprotocol/sdk/types.js";

export interface UpstreamSessionActivity {
  begin(): void;
  end(): void;
}

export class UpstreamSession {
  constructor(
    readonly profile: string,
    private readonly client: Client,
    private readonly closeTransport: () => Promise<void>,
    private readonly activity?: UpstreamSessionActivity
  ) {}

  listTools(): Promise<ListToolsResult> {
    return this.request(() => this.client.listTools());
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
    } finally {
      this.activity?.end();
    }
  }
}

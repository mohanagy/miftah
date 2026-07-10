import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  GetPromptRequest,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceRequest
} from "@modelcontextprotocol/sdk/types.js";

export class UpstreamSession {
  constructor(
    readonly profile: string,
    private readonly client: Client,
    private readonly closeTransport: () => Promise<void>
  ) {}

  listTools(): Promise<ListToolsResult> {
    return this.client.listTools();
  }

  callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.client.callTool(params) as Promise<CallToolResult>;
  }

  listResources(): Promise<ListResourcesResult> {
    return this.client.listResources();
  }

  readResource(params: ReadResourceRequest["params"]) {
    return this.client.readResource(params);
  }

  listPrompts(): Promise<ListPromptsResult> {
    return this.client.listPrompts();
  }

  getPrompt(params: GetPromptRequest["params"]) {
    return this.client.getPrompt(params);
  }

  async close(): Promise<void> {
    await this.closeTransport();
  }
}

import type {
  CallToolRequest,
  CallToolResult,
  Client,
  GetPromptRequest,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListToolsResult,
  ReadResourceRequest,
  RequestOptions,
  SubscribeRequest,
  UnsubscribeRequest
} from "@modelcontextprotocol/client";
import { MiftahError } from "../utils/errors.js";

/** Lets the process manager bracket upstream work so idle shutdown cannot interrupt an active request. */
export interface UpstreamSessionActivity {
  begin(): void;
  end(): void;
}

export type UpstreamRequestErrorMapper = (error: unknown) => MiftahError | undefined;
export type UpstreamRequestOptions = Pick<RequestOptions, "onprogress" | "signal">;
export type UpstreamListChangeKind = "prompts" | "resources" | "tools";

type ResourceUpdatedListener = (uri: string) => void;
type ListChangedListener = (kind: UpstreamListChangeKind) => void;

/** Provides profile-bound MCP operations while reporting their activity to lifecycle management. */
export class UpstreamSession {
  private readonly resourceUpdatedListeners = new Set<ResourceUpdatedListener>();
  private readonly listChangedListeners = new Set<ListChangedListener>();

  constructor(
    readonly profile: string,
    /** Monotonically increasing manager generation for this live upstream session. */
    readonly generation: number,
    private readonly client: Client,
    private readonly closeTransport: () => Promise<void>,
    private readonly activity?: UpstreamSessionActivity,
    private readonly mapRequestError?: UpstreamRequestErrorMapper
  ) {
    this.client.setNotificationHandler("notifications/resources/updated", (notification) => {
      this.notifyResourceUpdated(notification.params.uri);
    });
    this.client.setNotificationHandler("notifications/resources/list_changed", () => {
      this.notifyListChanged("resources");
    });
    this.client.setNotificationHandler("notifications/prompts/list_changed", () => {
      this.notifyListChanged("prompts");
    });
    this.client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.notifyListChanged("tools");
    });
  }

  supportsResourceSubscriptions(): boolean {
    return this.client.getServerCapabilities()?.resources?.subscribe === true;
  }

  addResourceUpdatedListener(listener: ResourceUpdatedListener): () => void {
    this.resourceUpdatedListeners.add(listener);
    return () => this.resourceUpdatedListeners.delete(listener);
  }

  addListChangedListener(listener: ListChangedListener): () => void {
    this.listChangedListeners.add(listener);
    return () => this.listChangedListeners.delete(listener);
  }

  /** Retains this session while a long-lived upstream subscription is active. */
  retain(): () => void {
    this.activity?.begin();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activity?.end();
    };
  }

  listTools(options?: UpstreamRequestOptions): Promise<ListToolsResult> {
    return this.request(
      (requestOptions) => this.client.request({ method: "tools/list", params: {} }, requestOptions),
      options
    );
  }

  callTool(params: CallToolRequest["params"], options?: UpstreamRequestOptions): Promise<CallToolResult> {
    return this.request(
      (requestOptions) => this.client.callTool(params, requestOptions) as Promise<CallToolResult>,
      options
    );
  }

  listResources(params?: ListResourcesRequest["params"], options?: UpstreamRequestOptions): Promise<ListResourcesResult> {
    return this.request(
      (requestOptions) => this.client.request({ method: "resources/list", params: params ?? {} }, requestOptions),
      options
    );
  }

  listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    options?: UpstreamRequestOptions
  ): Promise<ListResourceTemplatesResult> {
    return this.request(
      (requestOptions) =>
        this.client.request({ method: "resources/templates/list", params: params ?? {} }, requestOptions),
      options
    );
  }

  readResource(params: ReadResourceRequest["params"], options?: UpstreamRequestOptions) {
    return this.request((requestOptions) => this.client.readResource(params, requestOptions), options);
  }

  subscribeResource(params: SubscribeRequest["params"], options?: UpstreamRequestOptions) {
    return this.request((requestOptions) => this.client.subscribeResource(params, requestOptions), options);
  }

  unsubscribeResource(params: UnsubscribeRequest["params"], options?: UpstreamRequestOptions) {
    return this.request((requestOptions) => this.client.unsubscribeResource(params, requestOptions), options);
  }

  listPrompts(params?: ListPromptsRequest["params"], options?: UpstreamRequestOptions): Promise<ListPromptsResult> {
    return this.request(
      (requestOptions) => this.client.request({ method: "prompts/list", params: params ?? {} }, requestOptions),
      options
    );
  }

  getPrompt(params: GetPromptRequest["params"], options?: UpstreamRequestOptions) {
    return this.request((requestOptions) => this.client.getPrompt(params, requestOptions), options);
  }

  async close(): Promise<void> {
    await this.closeTransport();
  }

  private async request<Result>(
    operation: (options?: UpstreamRequestOptions) => Promise<Result>,
    options?: UpstreamRequestOptions
  ): Promise<Result> {
    if (options?.signal?.aborted) {
      throw this.mapRequestError?.(new Error("Upstream request cancelled")) ?? new Error("Upstream request cancelled");
    }
    const scoped = scopeRequestOptions(options);
    this.activity?.begin();
    try {
      return await operation(scoped.options);
    } catch (error) {
      throw this.mapRequestError?.(error) ?? error;
    } finally {
      scoped.dispose();
      this.activity?.end();
    }
  }

  private notifyResourceUpdated(uri: string): void {
    for (const listener of this.resourceUpdatedListeners) listener(uri);
  }

  private notifyListChanged(kind: UpstreamListChangeKind): void {
    for (const listener of this.listChangedListeners) listener(kind);
  }
}

function scopeRequestOptions(options?: UpstreamRequestOptions): {
  readonly options?: UpstreamRequestOptions;
  dispose(): void;
} {
  const signal = options?.signal;
  if (signal === undefined) return { options, dispose: () => undefined };

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return {
    options: { ...options, signal: controller.signal },
    dispose: () => signal.removeEventListener("abort", abort)
  };
}

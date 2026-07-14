import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ProgressPreservingTransport } from "../src/upstream/progress-preserving-transport.js";

class ControlledTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  async start(): Promise<void> {}

  async send(..._arguments: [JSONRPCMessage, TransportSendOptions?]): Promise<void> {
    void _arguments;
  }

  async close(): Promise<void> {}

  emit(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

describe("progress-preserving transport", () => {
  it("preserves a response before a following notification in one inbound batch", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const received: string[] = [];
    transport.onmessage = (message) => {
      received.push("id" in message ? "response" : "notification");
    };

    upstream.emit({ jsonrpc: "2.0", id: 1, result: {} });
    upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {} });
    await Promise.resolve();

    expect(received).toEqual(["response", "notification"]);
  });

  it("delivers a queued response before forwarding close", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const events: string[] = [];
    transport.onmessage = () => events.push("response");
    transport.onclose = () => events.push("close");

    upstream.emit({ jsonrpc: "2.0", id: 1, result: {} });
    upstream.onclose?.();
    await Promise.resolve();

    expect(events).toEqual(["response", "close"]);
  });

  it("recovers its queue after a synchronous notification handler failure", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const received: string[] = [];
    transport.onmessage = (message) => {
      if ("method" in message) throw new Error("notification failure");
      received.push("response");
    };

    expect(() => upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {} })).toThrow(
      "notification failure"
    );
    upstream.emit({ jsonrpc: "2.0", id: 1, result: {} });
    await Promise.resolve();

    expect(received).toEqual(["response"]);
  });
});

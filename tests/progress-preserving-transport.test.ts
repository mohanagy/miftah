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

  it("drains a reentrantly queued response and close after a notification handler failure", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const events: string[] = [];
    transport.onmessage = (message) => {
      if ("method" in message) {
        upstream.emit({ jsonrpc: "2.0", id: 1, result: {} });
        upstream.onclose?.();
        throw new Error("notification failure");
      }
      events.push("response");
    };
    transport.onclose = () => events.push("close");

    expect(() => upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {} })).toThrow(
      "notification failure"
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["response", "close"]);
  });

  it("reports a later queued notification failure through onerror after recovering the drain", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const errors: string[] = [];
    const events: string[] = [];
    let firstNotification = true;
    transport.onmessage = () => {
      if (firstNotification) {
        firstNotification = false;
        upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: { marker: "second" } });
        upstream.onclose?.();
        throw new Error("first notification failure");
      }
      throw new Error("second notification failure");
    };
    transport.onerror = (error) => errors.push(error.message);
    transport.onclose = () => events.push("close");

    expect(() =>
      upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: { marker: "first" } })
    ).toThrow("first notification failure");
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(["second notification failure"]);
    expect(events).toEqual(["close"]);
  });

  it("reports a recovered deferred response failure through onerror", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const errors: string[] = [];
    const events: string[] = [];
    transport.onmessage = (message) => {
      if ("method" in message) {
        upstream.emit({ jsonrpc: "2.0", id: 1, result: {} });
        upstream.onclose?.();
        throw new Error("notification failure");
      }
      throw new Error("response failure");
    };
    transport.onerror = (error) => errors.push(error.message);
    transport.onclose = () => events.push("close");

    expect(() => upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {} })).toThrow(
      "notification failure"
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(["response failure"]);
    expect(events).toEqual(["close"]);
  });

  it("reports a notification queued by a deferred response through onerror", async () => {
    const upstream = new ControlledTransport();
    const transport = new ProgressPreservingTransport(upstream);
    const errors: string[] = [];
    const events: string[] = [];
    transport.onmessage = (message) => {
      if ("id" in message) {
        upstream.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {} });
        upstream.onclose?.();
        return;
      }
      throw new Error("notification failure");
    };
    transport.onerror = (error) => errors.push(error.message);
    transport.onclose = () => events.push("close");

    upstream.emit({ jsonrpc: "2.0", id: 1, result: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(["notification failure"]);
    expect(events).toEqual(["close"]);
  });
});

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

/**
 * Lets the SDK dispatch an immediately preceding progress notification before
 * it retires the response's progress handler.
 *
 * The SDK intentionally schedules notification handlers in a microtask, while
 * response handling is synchronous. A compliant upstream may send both frames
 * together, so defer responses one microtask to retain that ordering.
 */
export class ProgressPreservingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly pendingMessages: Array<{ message: JSONRPCMessage; extra?: MessageExtraInfo }> = [];
  private flushing = false;
  private responseDeferred = false;
  private closeRequested = false;
  private closed = false;

  constructor(private readonly upstream: Transport) {
    upstream.onclose = () => {
      if (this.closeRequested || this.closed) return;
      this.closeRequested = true;
      this.flushMessages();
    };
    upstream.onerror = (error) => this.onerror?.(error);
    upstream.onmessage = (message, extra) => this.enqueueMessage(message, extra);
  }

  get sessionId(): string | undefined {
    return this.upstream.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.upstream.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    return this.upstream.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.upstream.send(message, options);
  }

  close(): Promise<void> {
    return this.upstream.close();
  }

  unwrap(): Transport {
    return this.upstream;
  }

  private enqueueMessage(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (this.closeRequested || this.closed) return;
    this.pendingMessages.push({ message, extra });
    this.flushMessages();
  }

  private flushMessages(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pendingMessages.length > 0) {
        const next = this.pendingMessages.shift();
        if (next === undefined) break;
        if (isResponse(next.message)) {
          this.responseDeferred = true;
          queueMicrotask(() => {
            try {
              this.onmessage?.(next.message, next.extra);
            } finally {
              this.responseDeferred = false;
              this.flushing = false;
              this.flushMessages();
            }
          });
          return;
        }
        this.onmessage?.(next.message, next.extra);
      }
    } finally {
      if (!this.responseDeferred) {
        this.flushing = false;
        this.forwardCloseWhenDrained();
      }
    }
  }

  private forwardCloseWhenDrained(): void {
    if (!this.closeRequested || this.closed || this.flushing || this.pendingMessages.length > 0) return;
    this.closed = true;
    this.onclose?.();
  }
}

export function unwrapProgressPreservingTransport(transport: Transport): Transport {
  return transport instanceof ProgressPreservingTransport ? transport.unwrap() : transport;
}

function isResponse(message: JSONRPCMessage): boolean {
  return "id" in message && ("result" in message || "error" in message);
}

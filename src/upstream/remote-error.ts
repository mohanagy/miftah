import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { TransportType } from "../config/types.js";
import { MiftahError } from "../utils/errors.js";

type RemoteTransportType = Exclude<TransportType, "stdio">;

/** Represents a remote HTTP status without retaining its potentially sensitive response body. */
export class RemoteHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Remote HTTP request failed with status ${status}`);
    this.name = "RemoteHttpStatusError";
  }
}

/**
 * Stops legacy SSE POST failures from reaching the SDK's response-text error path.
 * GET requests remain untouched so the SDK can manage SSE startup and authentication.
 */
export const fetchSsePostWithStatusOnly: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  if (init?.method?.toUpperCase() !== "POST" || response.ok) return response;
  await response.body?.cancel();
  throw new RemoteHttpStatusError(response.status);
};

/** Converts SDK remote transport failures into stable, response-body-free Miftah errors. */
export function asRemoteError(
  profile: string,
  transport: RemoteTransportType,
  error: unknown
): MiftahError | undefined {
  if (error instanceof MiftahError) return error;
  if (error instanceof RemoteHttpStatusError) return httpError(profile, transport, error.status);
  if (error instanceof UnauthorizedError) return httpError(profile, transport, 401);
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    if (isHttpStatus(error.code)) return httpError(profile, transport, error.code);
    return undefined;
  }
  if (error instanceof McpError) {
    return new MiftahError(
      "UPSTREAM_PROTOCOL_ERROR",
      `UPSTREAM_PROTOCOL_ERROR: ${transport} upstream for profile '${profile}' returned MCP error ${error.code}`,
      { profile, transport, mcpCode: error.code }
    );
  }
  return undefined;
}

function httpError(profile: string, transport: RemoteTransportType, status: number): MiftahError {
  return new MiftahError(
    "UPSTREAM_HTTP_ERROR",
    `UPSTREAM_HTTP_ERROR: ${transport} upstream for profile '${profile}' returned HTTP ${status}`,
    { profile, transport, status }
  );
}

function isHttpStatus(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599;
}

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const maximumMetadataBytes = 64 * 1_024;

function requestUrl(input: Parameters<FetchLike>[0]): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return undefined;
  }
}

function isAuthorizationMetadataPath(pathname: string): boolean {
  return (
    pathname.includes("/.well-known/oauth-authorization-server") ||
    pathname.includes("/.well-known/openid-configuration")
  );
}

function metadataIssuerMatchesRequest(requestUrl: URL, issuer: string): boolean {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return false;
  }
  if (
    issuerUrl.origin !== requestUrl.origin ||
    issuerUrl.search.length > 0 ||
    issuerUrl.hash.length > 0 ||
    issuerUrl.username.length > 0 ||
    issuerUrl.password.length > 0
  ) {
    return false;
  }

  const authorizationMarker = "/.well-known/oauth-authorization-server";
  const authorizationIndex = requestUrl.pathname.indexOf(authorizationMarker);
  if (authorizationIndex === 0) {
    const issuerPath = requestUrl.pathname.slice(authorizationIndex + authorizationMarker.length) || "/";
    return issuerUrl.pathname === issuerPath;
  }

  const openIdMarker = "/.well-known/openid-configuration";
  const openIdIndex = requestUrl.pathname.indexOf(openIdMarker);
  if (openIdIndex >= 0 && openIdIndex + openIdMarker.length === requestUrl.pathname.length) {
    const issuerPath = requestUrl.pathname.slice(0, openIdIndex) || "/";
    return issuerUrl.pathname === issuerPath;
  }
  return false;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maximumMetadataBytes) return undefined;
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let serialized = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumMetadataBytes) {
        // A cloned undici response can keep cancellation pending until its original branch is read.
        // Start cancellation without waiting so an oversized metadata response cannot stall discovery.
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      serialized += decoder.decode(chunk.value, { stream: true });
    }
    serialized += decoder.decode();
    return JSON.parse(serialized) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** Retains only RFC 9207 capability evidence that the SDK's OIDC schema otherwise strips. */
export class OAuthMetadataFetchGuard {
  private readonly issuerResponseSupport = new Set<string>();
  readonly fetch: FetchLike;

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    this.fetch = async (input, init) => {
      const response = await fetchFn(input, init);
      const url = requestUrl(input);
      if (response.ok && url !== undefined && isAuthorizationMetadataPath(url.pathname)) {
        try {
          const value = await boundedJson(response.clone());
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).issuer === "string" &&
            metadataIssuerMatchesRequest(url, (value as Record<string, unknown>).issuer as string) &&
            (value as Record<string, unknown>).authorization_response_iss_parameter_supported === true
          ) {
            this.issuerResponseSupport.add((value as Record<string, unknown>).issuer as string);
          }
        } catch {
          // The SDK owns parsing and maps malformed provider responses through Miftah's typed boundary.
        }
      }
      return response;
    };
  }

  issuerResponseSupported(issuer: string): boolean {
    return this.issuerResponseSupport.has(issuer);
  }
}

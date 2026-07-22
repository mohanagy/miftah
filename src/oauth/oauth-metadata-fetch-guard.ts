import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

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
          const value: unknown = await response.clone().json();
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).issuer === "string" &&
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

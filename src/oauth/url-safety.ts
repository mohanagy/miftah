export interface SafeOAuthHttpsUrlOptions {
  readonly requirePath?: boolean;
  readonly allowSearch?: boolean;
}

/** Applies the shared URL boundary used by config validation and the runtime OAuth provider. */
export function isSafeOAuthHttpsUrl(
  value: string,
  options: SafeOAuthHttpsUrlOptions = {}
): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0 &&
      (options.allowSearch !== false || url.search.length === 0) &&
      (options.requirePath !== true || url.pathname !== "/")
    );
  } catch {
    return false;
  }
}

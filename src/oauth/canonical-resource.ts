import { MiftahError } from "../utils/errors.js";

const unreservedCharacterPattern = /^[A-Za-z0-9\-._~]$/u;
const pathCharacterPattern = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/u;

function hasUnsafePathCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return character === "\\" || code === undefined || code <= 0x20 || code === 0x7f;
  });
}

function isPrintableAscii(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && code >= 0x21 && code <= 0x7e;
  });
}

function invalidResource(): never {
  throw new MiftahError(
    "OAUTH_RESOURCE_INVALID",
    "OAUTH_RESOURCE_INVALID: OAuth resource must be a canonical HTTPS endpoint"
  );
}

function splitAuthority(authority: string): { host: string; port?: string } {
  if (authority.length === 0 || authority.includes("@")) invalidResource();

  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket <= 1) invalidResource();
    const host = authority.slice(0, closingBracket + 1);
    const suffix = authority.slice(closingBracket + 1);
    if (suffix.length === 0) return { host };
    if (!suffix.startsWith(":")) invalidResource();
    return { host, port: suffix.slice(1) };
  }

  const colon = authority.lastIndexOf(":");
  if (colon < 0) return { host: authority };
  const host = authority.slice(0, colon);
  if (host.includes(":")) invalidResource();
  return { host, port: authority.slice(colon + 1) };
}

function validatePort(port: string | undefined): void {
  if (port === undefined) return;
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(port) || Number(port) > 65_535) invalidResource();
}

function canonicalPath(rawPath: string): string {
  if (rawPath.length === 0 || rawPath === "/") return "";
  if (!rawPath.startsWith("/") || hasUnsafePathCharacter(rawPath)) invalidResource();

  let canonical = "";
  for (let index = 0; index < rawPath.length; index += 1) {
    const character = rawPath[index];
    if (character === undefined) invalidResource();
    if (character === "%") {
      const encoded = rawPath.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(encoded)) invalidResource();
      const decoded = String.fromCharCode(Number.parseInt(encoded, 16));
      canonical += unreservedCharacterPattern.test(decoded) ? decoded : `%${encoded.toUpperCase()}`;
      index += 2;
      continue;
    }
    if (!pathCharacterPattern.test(character)) invalidResource();
    canonical += character;
  }

  if (canonical.split("/").some((segment) => segment === "." || segment === "..")) invalidResource();
  return canonical;
}

/**
 * Produces the one resource identifier used by an OAuth connection. It intentionally does not
 * use URL serialization because an OAuth binding must reject aliases rather than normalize them.
 */
export function canonicalizeOAuthResource(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value.includes("?") || value.includes("#")) {
    invalidResource();
  }

  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)$/u.exec(value);
  if (match === null) invalidResource();
  const [, rawScheme, authority, rawPath] = match;
  if (rawScheme === undefined || authority === undefined || rawPath === undefined || rawScheme.toLowerCase() !== "https") {
    invalidResource();
  }
  const { host: rawHost, port } = splitAuthority(authority);
  if (!isPrintableAscii(rawHost) || rawHost.endsWith(".")) invalidResource();
  validatePort(port);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidResource();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.hostname.length === 0 ||
    !isPrintableAscii(parsed.hostname) ||
    rawHost.toLowerCase() !== parsed.hostname.toLowerCase()
  ) {
    invalidResource();
  }

  const canonicalPort = port === undefined || port === "443" ? "" : `:${port}`;
  return `https://${parsed.hostname.toLowerCase()}${canonicalPort}${canonicalPath(rawPath)}`;
}

/** Returns true only when an input is already the exact canonical OAuth resource serialization. */
export function isCanonicalOAuthResource(value: string): boolean {
  try {
    return canonicalizeOAuthResource(value) === value;
  } catch {
    return false;
  }
}

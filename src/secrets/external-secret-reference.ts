import { MiftahError } from "../utils/errors.js";

const keychainPrefix = "secretref:keychain://";
const onePasswordPrefix = "secretref:op://";
const maximumComponentLength = 255;

export interface KeychainSecretReference {
  readonly provider: "keychain";
  readonly service: string;
  readonly account: string;
  readonly canonicalReference: string;
}

export interface OnePasswordSecretReference {
  readonly provider: "op";
  readonly vault: string;
  readonly item: string;
  readonly field: string;
  readonly canonicalReference: string;
}

export type ExternalSecretReference = KeychainSecretReference | OnePasswordSecretReference;

/** Parses only safe, canonical keychain and 1Password secret-reference forms. */
export function parseExternalSecretReference(value: string): ExternalSecretReference | undefined {
  if (value.startsWith("secretref:keychain:")) {
    if (!value.startsWith(keychainPrefix)) malformedReference("keychain");
    const components = parseComponents(value.slice(keychainPrefix.length), 2, "keychain");
    const service = components[0]!;
    const account = components[1]!;
    return {
      provider: "keychain",
      service,
      account,
      canonicalReference: `${keychainPrefix}${encodeComponent(service)}/${encodeComponent(account)}`
    };
  }
  if (value.startsWith("secretref:op:")) {
    if (!value.startsWith(onePasswordPrefix)) malformedReference("op");
    const components = parseComponents(value.slice(onePasswordPrefix.length), 3, "op");
    const vault = components[0]!;
    const item = components[1]!;
    const field = components[2]!;
    return {
      provider: "op",
      vault,
      item,
      field,
      canonicalReference: `${onePasswordPrefix}${encodeComponent(vault)}/${encodeComponent(item)}/${encodeComponent(field)}`
    };
  }
  return undefined;
}

function parseComponents(value: string, componentCount: number, provider: "keychain" | "op"): string[] {
  if (value.includes("?") || value.includes("#")) malformedReference(provider);
  const components = value.split("/");
  if (components.length !== componentCount || components[0]?.includes("@")) malformedReference(provider);
  return components.map((component) => decodeComponent(component, provider));
}

function decodeComponent(component: string, provider: "keychain" | "op"): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(component);
  } catch {
    malformedReference(provider);
  }
  if (
    decoded.length === 0 ||
    decoded.length > maximumComponentLength ||
    containsControlCharacter(decoded) ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\")
  ) {
    malformedReference(provider);
  }
  return decoded;
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return true;
    }
  }
  return false;
}

function malformedReference(provider: "keychain" | "op"): never {
  throw new MiftahError(
    "SECRET_REFERENCE_MALFORMED",
    `SECRET_REFERENCE_MALFORMED: malformed ${provider} secret reference`,
    { provider }
  );
}

import { MiftahError } from "../utils/errors.js";

const pluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const pluginComponentPattern = /^(?:[A-Za-z0-9._~:@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/u;
const maximumReferenceLength = 1_024;

export interface PluginSecretReference {
  readonly providerId: string;
  readonly canonicalReference: string;
}

/** Parses a bounded, canonical local-plugin reference without interpreting its opaque components. */
export function parsePluginSecretReference(value: string): PluginSecretReference | undefined {
  if (!value.startsWith("secretref:")) return undefined;
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return undefined;
  const providerId = value.slice("secretref:".length, schemeEnd);
  if (!pluginIdPattern.test(providerId)) return undefined;
  const resource = value.slice(schemeEnd + 3);
  if (!isCanonicalPluginResource(resource) || value.length > maximumReferenceLength) {
    throw new MiftahError(
      "SECRET_REFERENCE_MALFORMED",
      "SECRET_REFERENCE_MALFORMED: malformed plugin secret reference",
      { provider: providerId }
    );
  }
  return {
    providerId,
    canonicalReference: `secretref:${providerId}://${canonicalizePluginResource(resource)}`
  };
}

export function isPluginIdentifier(value: unknown): value is string {
  return typeof value === "string" && pluginIdPattern.test(value);
}

function isCanonicalPluginResource(value: string): boolean {
  if (value.length === 0 || value.includes("?") || value.includes("#") || value.includes("\\")) return false;
  const components = value.split("/");
  return components.every(
    (component) => component !== "." && component !== ".." && pluginComponentPattern.test(component)
  );
}

function canonicalizePluginResource(value: string): string {
  return value.replace(/%[0-9A-Fa-f]{2}/gu, (encoded) => encoded.toUpperCase());
}

import { createHmac, randomUUID } from "node:crypto";

const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const uriInTextPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const providerTokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
];
const camelCaseBoundaryPattern = /([a-z0-9])([A-Z])/g;
const nonAlphanumericPattern = /[^a-z0-9]+/;
const invalidUriRedactionKey = randomUUID();
const secretKeyTerms = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "credential",
  "credentials",
  "authorization",
  "auth",
  "apikey",
  "privatekey"
]);

/** Identifies structured-data keys whose values must be redacted in full. */
function isSecretKey(key: string): boolean {
  const normalized = key.replace(camelCaseBoundaryPattern, "$1_$2").toLowerCase();
  const parts = normalized.split(nonAlphanumericPattern).filter(Boolean);
  if (parts.some((part) => secretKeyTerms.has(part))) {
    return true;
  }
  return (parts.includes("api") && parts.includes("key")) || (parts.includes("private") && parts.includes("key"));
}

/** Redacts configured values and recognized credential formats from text. */
function redactString(value: string, secretValues: readonly string[]): string {
  let result = value;
  for (const secret of secretValues) {
    if (secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  result = result.replace(bearerPattern, "$1[REDACTED]");
  for (const pattern of providerTokenPatterns) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/** Recursively redacts secrets while preserving the input's data shape. */
function redactValue(value: unknown, secretValues: readonly string[], key?: string): unknown {
  if (key && isSecretKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactString(value, secretValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, secretValues, entryKey)
      ])
    );
  }
  return value;
}

/** Creates a reusable deep redactor for a fixed collection of secret values. */
export function createRedactor(secretValues: readonly string[] = []): <T>(value: T) => T {
  return <T>(value: T) => redactValue(value, secretValues) as T;
}

/** Produces a safe public representation of a URI while retaining only its non-sensitive identity. */
export function redactUri(uri: string): string {
  try {
    const value = new URL(uri);
    value.username = "";
    value.password = "";
    for (const key of new Set(value.searchParams.keys())) {
      value.searchParams.set(key, "[REDACTED]");
    }
    value.hash = "";
    return value.toString();
  } catch {
    return `miftah-invalid-uri:${createHmac("sha256", invalidUriRedactionKey).update(uri).digest("hex")}`;
  }
}

/** Redacts sensitive URI components embedded in an arbitrary diagnostic string. */
export function redactUrisInText(value: string): string {
  return value.replace(uriInTextPattern, (candidate) => {
    const { uri, suffix } = splitTrailingPunctuation(candidate);
    try {
      const parsed = new URL(uri);
      if (!parsed.username && !parsed.password && !parsed.hash && parsed.search.length === 0) return candidate;
      return `${redactUri(uri)}${suffix}`;
    } catch {
      return candidate;
    }
  });
}

/** Redacts secret values and secret-bearing keys from an arbitrary value. */
export function redactSecrets<T>(value: T, secretValues: readonly string[] = []): T {
  return createRedactor(secretValues)(value);
}

function splitTrailingPunctuation(value: string): { uri: string; suffix: string } {
  const match = value.match(/[),.;!?]+$/);
  if (!match) return { uri: value, suffix: "" };
  return {
    uri: value.slice(0, -match[0].length),
    suffix: match[0]
  };
}

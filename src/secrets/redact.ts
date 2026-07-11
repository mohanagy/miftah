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

/** Shares a mutable set of known secret values across runtime output boundaries. */
export class SecretRedactor {
  private readonly secretValues = new Set<string>();

  constructor(secretValues: readonly string[] = []) {
    this.addAll(secretValues);
  }

  add(value: string): void {
    if (value.length > 0) this.secretValues.add(value);
  }

  addAll(values: readonly string[]): void {
    for (const value of values) this.add(value);
  }

  values(): string[] {
    return [...this.secretValues];
  }

  redact<T>(value: T): T {
    return redactValue(value, this.values()) as T;
  }

  redactText(value: string): string {
    return this.redact(redactUrisInText(value));
  }

  redactUri(uri: string): string {
    return this.redact(redactUri(uri));
  }

  createTextStream(): { write(value: string): string; flush(): string } {
    let pending = "";
    return {
      write: (value) => {
        pending += value;
        const lastLineBreak = pending.lastIndexOf("\n");
        if (lastLineBreak >= 0) {
          const completeLines = pending.slice(0, lastLineBreak + 1);
          pending = pending.slice(lastLineBreak + 1);
          return this.redactText(completeLines);
        }
        const retainedLength = Math.max(1_024, ...[...this.secretValues].map((secret) => secret.length));
        if (pending.length <= retainedLength) return "";
        const requestedBoundary = pending.length - retainedLength;
        const boundary = this.safeTextBoundary(pending, requestedBoundary);
        const completeText = pending.slice(0, boundary);
        pending = pending.slice(boundary);
        return this.redactText(completeText);
      },
      flush: () => {
        const completeText = this.redactText(pending);
        pending = "";
        return completeText;
      }
    };
  }

  private safeTextBoundary(value: string, requestedBoundary: number): number {
    let boundary = requestedBoundary;
    for (const secret of this.secretValues) {
      let index = value.indexOf(secret);
      while (index >= 0) {
        if (index < boundary && index + secret.length > boundary) boundary = index;
        index = value.indexOf(secret, index + 1);
      }
    }
    return boundary;
  }
}

/** Creates a reusable deep redactor for a fixed collection of secret values. */
export function createRedactor(secretValues: readonly string[] = []): <T>(value: T) => T {
  const redactor = new SecretRedactor(secretValues);
  return <T>(value: T) => redactor.redact(value);
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

import { createHmac, randomUUID } from "node:crypto";

const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const uriInTextPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const maximumBufferedLineLength = 8_192;
const maximumPendingStreamLength = maximumBufferedLineLength * 2;
const redactedStreamLineMarker = "[REDACTED STREAM LINE]";
const redactedStreamMarker = "[REDACTED STREAM]";
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

type UnfinishedSecretPredicate = (secret: string, value: string) => boolean;

/** Redacts configured values and recognized credential formats from text. */
function redactString(value: string, secretValues: readonly string[]): string;
function redactString(
  value: string,
  secretValues: readonly string[],
  hasUnfinishedSecret: UnfinishedSecretPredicate
): string | undefined;
function redactString(
  value: string,
  secretValues: readonly string[],
  hasUnfinishedSecret?: UnfinishedSecretPredicate
): string | undefined {
  let result = value;
  for (const secret of secretValues) {
    if (hasUnfinishedSecret?.(secret, value)) return undefined;
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

function hasProperSecretPrefix(value: string, secret: string): boolean {
  const maximumPrefixLength = Math.min(secret.length - 1, value.length);
  for (let length = maximumPrefixLength; length > 0; length -= 1) {
    if (value.endsWith(secret.slice(0, length))) return true;
  }
  return false;
}

/** Recursively redacts secrets while preserving the input's data shape. */
function redactValue(value: unknown, secretValues: readonly string[], key?: string, redactUris = false): unknown {
  if (key && isSecretKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactString(redactUris ? redactUrisInText(value) : value, secretValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues, undefined, redactUris));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, secretValues, entryKey, redactUris)
      ])
    );
  }
  return value;
}

/** Shares a mutable set of known secret values across runtime output boundaries. */
export class SecretRedactor {
  private readonly secretValues = new Set<string>();
  private secretSnapshot: readonly string[] = [];
  private secretSnapshotDirty = true;
  private maximumSecretLength = 0;

  constructor(secretValues: readonly string[] = []) {
    this.addAll(secretValues);
  }

  add(value: string): void {
    if (value.length === 0 || this.secretValues.has(value)) return;
    this.secretValues.add(value);
    this.secretSnapshotDirty = true;
    this.maximumSecretLength = Math.max(this.maximumSecretLength, value.length);
  }

  addAll(values: readonly string[]): void {
    for (const value of values) this.add(value);
  }

  values(): string[] {
    return [...this.secretList()];
  }

  redact<T>(value: T): T {
    return redactValue(value, this.secretList()) as T;
  }

  /** Redacts structured audit values, including URI credentials embedded in arbitrary string arguments. */
  redactForAudit<T>(value: T): T {
    return redactValue(value, this.secretList(), undefined, true) as T;
  }

  redactText(value: string): string {
    return this.redact(redactUrisInText(value));
  }

  redactUri(uri: string): string {
    return this.redact(redactUri(uri));
  }

  createTextStream(): { write(value: string): string; flush(): string } {
    let pending = "";
    let activeLine = "";
    let suppressingOutput = false;

    const suppress = (marker: string): string => {
      pending = "";
      activeLine = "";
      // Dropping an overlong line can lose a multiline-secret prefix, so later stderr stays fail-closed.
      suppressingOutput = true;
      return `${marker}\n`;
    };

    const emitPending = (): string => {
      if (pending.length === 0) return "";
      const output = this.redactPending(pending);
      if (output === undefined) return "";
      pending = "";
      return output;
    };

    return {
      write: (value) => {
        if (suppressingOutput) return "";
        if (this.maximumSecretLength > maximumBufferedLineLength) return suppress(redactedStreamMarker);

        let offset = 0;
        while (offset < value.length) {
          const lineBreak = value.indexOf("\n", offset);
          const hasLineBreak = lineBreak >= 0;
          const end = hasLineBreak ? lineBreak : value.length;
          const completeLineLength = activeLine.length + (end - offset) + (hasLineBreak ? 1 : 0);
          if (completeLineLength > maximumBufferedLineLength) {
            return suppress(redactedStreamLineMarker);
          }

          activeLine += value.slice(offset, end + (hasLineBreak ? 1 : 0));
          if (!hasLineBreak) break;
          const completedLine = redactUrisInText(activeLine);
          if (pending.length + completedLine.length > maximumPendingStreamLength) {
            return suppress(redactedStreamMarker);
          }
          pending += completedLine;
          activeLine = "";
          offset = lineBreak + 1;
        }

        const output = emitPending();
        return output;
      },
      flush: () => {
        if (suppressingOutput) {
          pending = "";
          activeLine = "";
          return "";
        }
        if (this.maximumSecretLength > maximumBufferedLineLength) {
          return pending.length > 0 || activeLine.length > 0 ? suppress(redactedStreamMarker) : "";
        }
        if (activeLine.length > 0) {
          const completedLine = redactUrisInText(activeLine);
          if (pending.length + completedLine.length > maximumPendingStreamLength) {
            return suppress(redactedStreamMarker);
          }
          pending += completedLine;
          activeLine = "";
        }
        // A truncated known-secret prefix remains sensitive even after stderr closes.
        const output = emitPending();
        return pending.length > 0 ? output + suppress(redactedStreamMarker) : output;
      }
    };
  }

  private secretList(): readonly string[] {
    if (this.secretSnapshotDirty) {
      this.secretSnapshot = [...this.secretValues].sort((first, second) => second.length - first.length);
      this.secretSnapshotDirty = false;
    }
    return this.secretSnapshot;
  }

  private redactPending(value: string): string | undefined {
    const uriSafeValue = redactUrisInText(value);
    return redactString(uriSafeValue, this.secretList(), (secret, pendingValue) =>
      hasProperSecretPrefix(pendingValue, secret)
    );
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

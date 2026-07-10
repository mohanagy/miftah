const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const providerTokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
];
const secretKeyTerms = new Set(["token", "secret", "password", "credential", "authorization", "auth", "apikey", "privatekey"]);

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((part) => secretKeyTerms.has(part))) {
    return true;
  }
  return (parts.includes("api") && parts.includes("key")) || (parts.includes("private") && parts.includes("key"));
}

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

export function createRedactor(secretValues: readonly string[] = []): <T>(value: T) => T {
  return <T>(value: T) => redactValue(value, secretValues) as T;
}

export function redactSecrets<T>(value: T, secretValues: readonly string[] = []): T {
  return createRedactor(secretValues)(value);
}

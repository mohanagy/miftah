const secretKeyPattern = /(token|secret|password|api[_-]?key|auth|private|credential|authorization)/i;
const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const tokenPattern = /\b[A-Za-z0-9_-]{32,}\b/g;

function redactString(value: string, secretValues: readonly string[]): string {
  let result = value;
  for (const secret of secretValues) {
    if (secret.length > 0) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result.replace(bearerPattern, "$1[REDACTED]").replace(tokenPattern, "[REDACTED]");
}

function redactValue(value: unknown, secretValues: readonly string[], key?: string): unknown {
  if (key && secretKeyPattern.test(key)) {
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

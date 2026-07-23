/** Merges HTTP headers with the same case-insensitive semantics used by remote transports. */
export function mergeHeaders(...headerSets: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged = new Map<string, string>();
  for (const headers of headerSets) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      merged.set(name.toLowerCase(), value);
    }
  }
  return Object.fromEntries(merged);
}

/** Detects a header after applying the same case-insensitive merge as the runtime transport. */
export function hasMergedHeader(name: string, ...headerSets: Array<Record<string, string> | undefined>): boolean {
  return Object.hasOwn(mergeHeaders(...headerSets), name.toLowerCase());
}

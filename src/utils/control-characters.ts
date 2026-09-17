/**
 * Identity fingerprints travel from configuration through verification into the durable
 * binding store, and every layer must agree on what a storable field looks like. The
 * binding store cannot persist C0 control characters or DEL, so they are rejected at the
 * configuration boundary rather than surfacing later as an unavailable binding store.
 */
export function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code === undefined || code < 0x20 || code === 0x7f;
  });
}

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function resolvePath(value: string, baseDirectory = process.cwd()): string {
  const expanded = value.startsWith("~") ? `${homedir()}${value.slice(1)}` : value;
  return isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded);
}

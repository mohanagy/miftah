import type { RiskLevel } from "../config/types.js";

const MAX_COMMAND_LENGTH = 4_096;
const MAX_SEARCH_QUERY_LENGTH = 256;
const canonicalToolNamePattern = /^[A-Za-z][A-Za-z0-9:_-]{0,127}$/u;
const canonicalFieldPathPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const safeSearchQueryPattern = /^[A-Za-z0-9][A-Za-z0-9 .,:_\-/()]{0,255}$/u;
const unsafeCommandSyntaxPattern = /[;|&`$<>\\]/u;
const destructivePattern = /(delete|remove|destroy|revoke|archive|close|merge)/i;
const writePattern = /(create|update|edit|post|comment|send|resolve|assign|move|set)/i;
const readPattern = /(get|list|search|read|fetch|query|find|whoami|status|health)/i;

type ParsedPosthogCommand =
  | { readonly kind: "read-discovery" }
  | { readonly kind: "call"; readonly toolName: string }
  | { readonly kind: "invalid" };

/**
 * Classifies the fixed command language exposed by PostHog's official MCP
 * wrapper. This parser is deliberately narrow: every unsupported or malformed
 * form remains destructive rather than being treated as a safe shell command.
 */
export function classifyPosthogCommandRisk(command: unknown): RiskLevel {
  const parsed = parsePosthogCommand(command);
  if (parsed.kind === "read-discovery") return "read";
  if (parsed.kind === "call") return classifyNestedToolRisk(parsed.toolName);
  return "destructive";
}

function parsePosthogCommand(command: unknown): ParsedPosthogCommand {
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    return { kind: "invalid" };
  }
  if (hasUnsafeCommandCharacter(command)) return { kind: "invalid" };
  const input = command.trim();
  if (input.length === 0) return { kind: "invalid" };
  if (input === "tools") return { kind: "read-discovery" };

  const searchQuery = commandArgument(input, "search");
  if (searchQuery !== undefined) {
    return safeSearchQueryPattern.test(searchQuery) && searchQuery.length <= MAX_SEARCH_QUERY_LENGTH
      ? { kind: "read-discovery" }
      : { kind: "invalid" };
  }

  if (parseNamedReadCommand(input, "info", true) !== undefined) return { kind: "read-discovery" };
  if (parseNamedReadCommand(input, "schema", false) !== undefined) return { kind: "read-discovery" };
  return parseCallCommand(input);
}

function commandArgument(input: string, verb: string): string | undefined {
  if (!input.startsWith(`${verb} `)) return undefined;
  const argument = input.slice(verb.length).trim();
  return argument.length === 0 ? undefined : argument;
}

function hasUnsafeCommandCharacter(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return unsafeCommandSyntaxPattern.test(command);
}

function parseNamedReadCommand(input: string, verb: "info" | "schema", allowJson: boolean): string | undefined {
  const argument = commandArgument(input, verb);
  if (argument === undefined) return undefined;
  const tokens = argument.split(/\s+/u);
  const hasJsonFlag = allowJson && tokens[0] === "--json";
  const targetIndex = hasJsonFlag ? 1 : 0;
  const target = tokens[targetIndex];
  const fieldPath = tokens[targetIndex + 1];
  if (
    target === undefined ||
    !canonicalToolNamePattern.test(target) ||
    tokens.length > targetIndex + (verb === "schema" ? 2 : 1) ||
    (fieldPath !== undefined && (verb !== "schema" || !canonicalFieldPathPattern.test(fieldPath)))
  ) {
    return undefined;
  }
  return target;
}

function parseCallCommand(input: string): ParsedPosthogCommand {
  if (input === "call" || !input.startsWith("call ")) return { kind: "invalid" };
  let remaining = input.slice("call".length).trim();
  const flags = new Set<string>();
  for (;;) {
    const token = firstToken(remaining);
    if (token === undefined || !token.value.startsWith("--")) break;
    if ((token.value !== "--json" && token.value !== "--confirm") || flags.has(token.value)) {
      return { kind: "invalid" };
    }
    flags.add(token.value);
    remaining = token.remaining;
  }
  const target = firstToken(remaining);
  if (target === undefined || !canonicalToolNamePattern.test(target.value) || target.remaining.length === 0) {
    return { kind: "invalid" };
  }
  if (!isJsonObject(target.remaining)) return { kind: "invalid" };
  return { kind: "call", toolName: target.value };
}

function firstToken(input: string): { readonly value: string; readonly remaining: string } | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const separator = trimmed.search(/\s/u);
  if (separator === -1) return { value: trimmed, remaining: "" };
  return { value: trimmed.slice(0, separator), remaining: trimmed.slice(separator).trim() };
}

function isJsonObject(input: string): boolean {
  try {
    const value: unknown = JSON.parse(input);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function classifyNestedToolRisk(toolName: string): RiskLevel {
  if (destructivePattern.test(toolName)) return "destructive";
  if (writePattern.test(toolName)) return "write";
  if (readPattern.test(toolName)) return "read";
  return "destructive";
}

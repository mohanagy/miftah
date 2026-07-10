import type { RiskLevel } from "../config/types.js";

const destructivePattern = /(delete|remove|destroy|revoke|archive|close|merge)/i;
const writePattern = /(create|update|edit|post|comment|send|resolve|assign|move|set)/i;
const readPattern = /(get|list|search|read|fetch|query|find|whoami|status|health)/i;

export function classifyRisk(toolName: string, overrides: Record<string, RiskLevel> = {}): RiskLevel {
  if (overrides[toolName]) return overrides[toolName];
  if (destructivePattern.test(toolName)) return "destructive";
  if (writePattern.test(toolName)) return "write";
  if (readPattern.test(toolName)) return "read";
  return "write";
}

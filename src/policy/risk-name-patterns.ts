/** Stable name heuristics shared by outer tools and nested command adapters. */
export const destructiveRiskNamePattern = /(delete|remove|destroy|revoke|archive|close|merge)/i;
export const writeRiskNamePattern = /(create|update|edit|post|comment|send|resolve|assign|move|set)/i;
export const readRiskNamePattern = /(get|list|search|read|fetch|query|find|whoami|status|health)/i;

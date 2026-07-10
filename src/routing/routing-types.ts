import type { RoutingConfig } from "../config/types.js";

export interface RoutingInput {
  toolName: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface RoutingDecision {
  profile: string;
  reason: string;
}

export type { RoutingConfig };

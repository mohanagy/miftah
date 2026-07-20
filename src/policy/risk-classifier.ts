import type { RiskLevel, UnknownToolRisk } from "../config/types.js";
import type { RiskClassification, ToolRiskAnnotations } from "./policy-types.js";
import { classifyPosthogCommandRisk } from "./posthog-command-wrapper.js";
import { destructiveRiskNamePattern, readRiskNamePattern, writeRiskNamePattern } from "./risk-name-patterns.js";

export interface ToolRiskMetadata {
  readonly trusted?: boolean;
  readonly annotations?: ToolRiskAnnotations;
  /** Command payload from Miftah's origin-pinned PostHog adapter; never supplied by an upstream tool. */
  readonly posthogCommand?: { readonly command: unknown };
}

export interface RiskClassifierOptions {
  readonly overrides?: Record<string, RiskLevel>;
  readonly unknownRisk?: UnknownToolRisk;
}

/** Classifies one operation and preserves the evidence used for the safety decision. */
export function classifyToolRisk(
  toolName: string,
  options: RiskClassifierOptions = {},
  metadata: ToolRiskMetadata = {}
): RiskClassification {
  const override = options.overrides;
  if (override !== undefined && Object.hasOwn(override, toolName)) {
    return { risk: override[toolName]!, riskSource: "local-override", riskConfidence: "high" };
  }

  if (metadata.trusted && metadata.annotations !== undefined) {
    const annotationRisk = classifyTrustedAnnotations(metadata.annotations);
    if (annotationRisk !== undefined) return annotationRisk;
  }

  if (metadata.posthogCommand !== undefined) {
    return trustedCommandAdapter(classifyPosthogCommandRisk(metadata.posthogCommand.command));
  }

  if (destructiveRiskNamePattern.test(toolName)) return heuristic("destructive");
  if (writeRiskNamePattern.test(toolName)) return heuristic("write");
  if (readRiskNamePattern.test(toolName)) return heuristic("read");
  return {
    risk: options.unknownRisk ?? "destructive",
    riskSource: "unknown-default",
    riskConfidence: "low"
  };
}

/** Backwards-compatible risk-only classifier for callers that do not need provenance. */
export function classifyRisk(toolName: string, overrides: Record<string, RiskLevel> = {}): RiskLevel {
  return classifyToolRisk(toolName, { overrides }).risk;
}

function classifyTrustedAnnotations(annotations: ToolRiskAnnotations): RiskClassification | undefined {
  const readOnly = booleanHint(annotations.readOnlyHint);
  const destructive = booleanHint(annotations.destructiveHint);
  if (readOnly === true && destructive === true) {
    return { risk: "destructive", riskSource: "annotation-conflict", riskConfidence: "low" };
  }
  if (readOnly === true) return trusted("read");
  if (destructive === true) return trusted("destructive");
  if (readOnly === false && destructive === false) return trusted("write");
  if (readOnly === false) return trusted("destructive");
  return undefined;
}

function booleanHint(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function trusted(risk: RiskLevel): RiskClassification {
  return { risk, riskSource: "trusted-upstream-annotation", riskConfidence: "medium" };
}

/** Marks a risk derived by Miftah's origin-pinned command adapter as high confidence. */
function trustedCommandAdapter(risk: RiskLevel): RiskClassification {
  return { risk, riskSource: "trusted-command-adapter", riskConfidence: "high" };
}

function heuristic(risk: RiskLevel): RiskClassification {
  return { risk, riskSource: "name-heuristic", riskConfidence: "low" };
}

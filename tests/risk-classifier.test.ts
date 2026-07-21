import { describe, expect, it } from "vitest";
import { classifyToolRisk } from "../src/policy/risk-classifier.js";

describe("tool risk classifier", () => {
  it("gives a trusted PostHog command precedence over a static read-only hint", () => {
    expect(
      classifyToolRisk("exec", {}, {
        trusted: true,
        annotations: { readOnlyHint: true },
        posthogCommand: { command: "call dashboard-delete {}" }
      })
    ).toEqual({ risk: "destructive", riskSource: "trusted-command-adapter", riskConfidence: "high" });
  });
});

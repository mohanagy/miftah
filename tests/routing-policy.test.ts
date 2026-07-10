import { describe, expect, it } from "vitest";
import { RoutingEngine } from "../src/routing/routing-engine.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";

describe("routing and policy", () => {
  it("routes by tool arguments before falling back to the active profile", () => {
    const engine = new RoutingEngine(
      {
        mode: "hybrid",
        fallback: "activeProfile",
        rules: [
          { name: "work-repo", when: { "args.repo": "org/work" }, profile: "work" }
        ]
      },
      "personal"
    );

    expect(engine.resolve({ toolName: "search_issues", args: { repo: "org/work" } })).toEqual({
      profile: "work",
      reason: "rule:work-repo"
    });
    expect(engine.resolve({ toolName: "search_issues", args: { repo: "org/other" } })).toEqual({
      profile: "personal",
      reason: "active-profile"
    });
  });

  it("returns an ambiguity error when ask fallback has multiple matches", () => {
    const engine = new RoutingEngine(
      {
        mode: "rules",
        fallback: "ask",
        rules: [
          { name: "one", when: { "args.repo": "org/work" }, profile: "one" },
          { name: "two", when: { "args.repo": "org/work" }, profile: "two" }
        ]
      },
      "default"
    );

    expect(() => engine.resolve({ toolName: "update_issue", args: { repo: "org/work" } })).toThrow(
      /ROUTING_AMBIGUOUS/
    );
  });

  it("blocks destructive calls and requires confirmation for configured write calls", () => {
    const engine = new PolicyEngine(
      {
        readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] },
        safe: { allowRisk: ["read", "write"], denyRisk: ["destructive"], requireConfirmation: ["write"] }
      },
      { create_item: "write" }
    );

    expect(engine.evaluate("readonly", "create_item")).toEqual({ action: "deny", risk: "write" });
    expect(engine.evaluate("safe", "create_item")).toEqual({
      action: "confirm",
      risk: "write"
    });
    expect(engine.evaluate("safe", "get_item")).toEqual({ action: "allow", risk: "read" });
  });
});

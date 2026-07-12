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

  it("matches exact context values against members of a context array", () => {
    const engine = new RoutingEngine(
      {
        rules: [
          {
            name: "workspace-root",
            when: { "context.fileRoots": "file:///workspace/project" },
            profile: "workspace"
          }
        ]
      },
      "active"
    );

    expect(
      engine.resolve({
        toolName: "search_issues",
        context: { fileRoots: ["file:///other", "file:///workspace/project"] }
      })
    ).toEqual({ profile: "workspace", reason: "rule:workspace-root" });
  });

  it("matches wildcard context values against members of a context array", () => {
    const engine = new RoutingEngine(
      {
        rules: [
          {
            name: "workspace-root",
            when: { "context.fileRoots": "file:///workspace/*" },
            profile: "workspace"
          }
        ]
      },
      "active"
    );

    expect(
      engine.resolve({
        toolName: "search_issues",
        context: { fileRoots: ["file:///other", "file:///workspace/project"] }
      })
    ).toEqual({ profile: "workspace", reason: "rule:workspace-root" });
    expect(
      engine.resolve({
        toolName: "search_issues",
        context: { fileRoots: ["file:///other", "file:///different/project"] }
      })
    ).toEqual({ profile: "active", reason: "active-profile" });
  });

  it("prefers an environment profile hint over marker hints, rules, and active fallback", () => {
    const engine = new RoutingEngine(
      {
        rules: [{ name: "matching-rule", when: { "args.repo": "org/work" }, profile: "rule" }]
      },
      "active"
    );

    const decision = engine.resolve({
      toolName: "search_issues",
      args: { repo: "org/work" },
      profileHints: [
        {
          profile: "marker",
          source: "project-marker",
          evidence: { kind: "marker", path: "/workspace/.miftah-profile" }
        },
        {
          profile: "environment",
          source: "environment",
          evidence: { kind: "environment", variable: "MIFTAH_PROFILE" }
        }
      ]
    });

    expect(decision).toEqual({ profile: "environment", reason: "profile-hint:environment" });
    expect(decision.reason.startsWith("rule:")).toBe(false);
  });

  it("prefers one project-marker profile hint over matching rules and fallback", () => {
    const engine = new RoutingEngine(
      {
        rules: [{ name: "matching-rule", when: { "args.repo": "org/work" }, profile: "rule" }]
      },
      "active"
    );

    expect(
      engine.resolve({
        toolName: "search_issues",
        args: { repo: "org/work" },
        profileHints: [
          {
            profile: "marker",
            source: "project-marker",
            evidence: { kind: "marker", path: "/workspace/.miftah-profile" }
          },
          {
            profile: "marker",
            source: "project-marker",
            evidence: { kind: "marker", path: "/workspace/nested/.miftah-profile" }
          }
        ]
      })
    ).toEqual({ profile: "marker", reason: "profile-hint:project-marker" });
  });

  it("rejects distinct project-marker profile hints in stable profile order", () => {
    const engine = new RoutingEngine({}, "active");
    const input = {
      toolName: "search_issues",
      profileHints: [
        {
          profile: "zeta",
          source: "project-marker" as const,
          evidence: { kind: "marker" as const, path: "/workspace/zeta/.miftah-profile" }
        },
        {
          profile: "alpha",
          source: "project-marker" as const,
          evidence: { kind: "marker" as const, path: "/workspace/alpha/.miftah-profile" }
        }
      ]
    };

    expect(() => engine.resolve(input)).toThrow(
      "ROUTING_AMBIGUOUS: project-marker profile hints are alpha, zeta"
    );
  });

  it("uses matching rules before fallback when no profile hint is provided", () => {
    const engine = new RoutingEngine(
      {
        rules: [{ name: "matching-rule", when: { "args.repo": "org/work" }, profile: "rule" }]
      },
      "active"
    );

    expect(engine.resolve({ toolName: "search_issues", args: { repo: "org/work" } })).toEqual({
      profile: "rule",
      reason: "rule:matching-rule"
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

    expect(engine.evaluate("readonly", "create_item")).toEqual({
      action: "deny",
      risk: "write",
      riskSource: "local-override",
      riskConfidence: "high"
    });
    expect(engine.evaluate("safe", "create_item")).toEqual({
      action: "confirm",
      risk: "write",
      riskSource: "local-override",
      riskConfidence: "high"
    });
    expect(engine.evaluate("safe", "get_item")).toEqual({
      action: "allow",
      risk: "read",
      riskSource: "name-heuristic",
      riskConfidence: "low"
    });
  });

  it("records ordered risk classification from local overrides, trusted annotations, heuristics, and defaults", () => {
    const readonly = new PolicyEngine(
      { readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] } },
      { delete_workspace: "read" }
    );

    expect(
      readonly.evaluate("readonly", "delete_workspace", {
        trusted: true,
        annotations: { readOnlyHint: false, destructiveHint: true }
      })
    ).toEqual({ action: "allow", risk: "read", riskSource: "local-override", riskConfidence: "high" });

    expect(
      new PolicyEngine({ readonly: { allowRisk: ["read"] } }).evaluate("readonly", "delete_workspace", {
        trusted: true,
        annotations: { readOnlyHint: true, destructiveHint: false }
      })
    ).toEqual({ action: "allow", risk: "read", riskSource: "trusted-upstream-annotation", riskConfidence: "medium" });

    expect(
      new PolicyEngine({ readonly: { allowRisk: ["read"] } }).evaluate("readonly", "get_workspace", {
        trusted: true,
        annotations: { readOnlyHint: true, destructiveHint: true }
      })
    ).toEqual({ action: "deny", risk: "destructive", riskSource: "annotation-conflict", riskConfidence: "low" });

    expect(
      new PolicyEngine({ readonly: { allowRisk: ["read"] } }).evaluate("readonly", "delete_workspace", {
        trusted: false,
        annotations: { readOnlyHint: true }
      })
    ).toEqual({ action: "deny", risk: "destructive", riskSource: "name-heuristic", riskConfidence: "low" });

    expect(
      new PolicyEngine({ readonly: { allowRisk: ["read"] } }).evaluate("readonly", "delete_workspace", {
        trusted: true,
        annotations: { destructiveHint: false }
      })
    ).toEqual({ action: "deny", risk: "destructive", riskSource: "name-heuristic", riskConfidence: "low" });

    expect(
      new PolicyEngine().evaluate(undefined, "upsert_workspace", {
        trusted: true,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      })
    ).toEqual({ action: "allow", risk: "write", riskSource: "trusted-upstream-annotation", riskConfidence: "medium" });

    expect(new PolicyEngine().evaluate(undefined, "frobnicate")).toEqual({
      action: "allow",
      risk: "destructive",
      riskSource: "unknown-default",
      riskConfidence: "low"
    });
    expect(new PolicyEngine({}, {}, { unknownRisk: "write" }).evaluate(undefined, "frobnicate")).toEqual({
      action: "allow",
      risk: "write",
      riskSource: "unknown-default",
      riskConfidence: "low"
    });
    expect(new PolicyEngine().evaluate(undefined, "toString")).toEqual({
      action: "allow",
      risk: "destructive",
      riskSource: "unknown-default",
      riskConfidence: "low"
    });
  });

  it("fails closed when a profile references a missing named policy", () => {
    const engine = new PolicyEngine(
      {
        readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] }
      },
      { create_item: "write" }
    );

    expect(engine.evaluate("missing-policy", "create_item")).toEqual({
      action: "deny",
      risk: "write",
      riskSource: "local-override",
      riskConfidence: "high"
    });
  });

  it("fails closed when a policy name resolves to an inherited object property", () => {
    const engine = new PolicyEngine();

    expect(engine.evaluate("toString", "delete_repository")).toEqual({
      action: "deny",
      risk: "destructive",
      riskSource: "name-heuristic",
      riskConfidence: "low"
    });
  });

  it("fails closed when a policy name is explicitly empty", () => {
    const engine = new PolicyEngine();

    expect(engine.evaluate("", "delete_repository")).toEqual({
      action: "deny",
      risk: "destructive",
      riskSource: "name-heuristic",
      riskConfidence: "low"
    });
  });
});

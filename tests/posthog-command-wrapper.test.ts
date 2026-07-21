import { describe, expect, it } from "vitest";
import { classifyPosthogCommandRisk } from "../src/policy/posthog-command-wrapper.js";

describe("PostHog command-wrapper classifier", () => {
  it.each([
    ["tools", "read"],
    [" search session recording ", "read"],
    ["info query-trends", "read"],
    ["info --json query-trends", "read"],
    ["schema query-trends", "read"],
    ["schema query-trends results.columns", "read"],
    ["call query-trends {}", "read"],
    ["call --json query-trends {\"limit\":10}", "read"],
    ["call query-trends {\"event\":\"$pageview\",\"math\":\"dau\"}", "read"],
    ["call dashboard-create {}", "write"],
    ["call dashboard-delete {\"event\":\"$pageview\"}", "destructive"],
    ["call dashboard-delete {}", "destructive"],
    ["call --confirm dashboard-delete {}", "destructive"],
    ["call execute-sql {}", "destructive"],
    ["call made-up {}", "destructive"]
  ] as const)("classifies %j as %s", (command, risk) => {
    expect(classifyPosthogCommandRisk(command)).toBe(risk);
  });

  it.each([
    undefined,
    "",
    "tools extra",
    "info",
    "info --json --json query-trends",
    "schema query-trends extra one",
    "search ",
    "search $pageview",
    "search query; call dashboard-delete {}",
    "call",
    "call --confirm --confirm query-trends {}",
    "call --force query-trends {}",
    "call $query-trends {}",
    "call query-trends []",
    "call query-trends {\"event\":\"$(whoami)\"}",
    "call query-trends {\"event\":\"${HOME}\"}",
    "call query-trends {\"limit\":1} trailing",
    "call query-trends {}; tools",
    "call query-trends {}\ncall dashboard-delete {}",
    "x".repeat(4_097)
  ])("keeps malformed or multi-command input destructive: %j", (command) => {
    expect(classifyPosthogCommandRisk(command)).toBe("destructive");
  });
});

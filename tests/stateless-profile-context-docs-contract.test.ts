import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const decision = readFileSync(
  new URL("../docs/plans/2026-08-11-stateless-profile-context-decision.md", import.meta.url),
  "utf8"
);

describe("stateless profile context decision", () => {
  it("records the fail-closed decision and rejects hidden session substitutes", () => {
    expect(decision).toContain("will not read or mutate an implicit active profile");
    expect(decision).toContain("unforgeable per-chat context claim");
    expect(decision).toContain("MCP `clientInfo`");
    expect(decision).toContain("### Mutable process or durable default");
    expect(decision).toContain("### Sticky load balancing or an in-memory instance map");
    expect(decision).toContain("must not claim chat-scoped switching");
  });

  it("defines expiry, revocation, redaction, UX fallback, and implementation follow-ups", () => {
    expect(decision).toContain("Revocation is deployment-wide");
    expect(decision).toContain("exactly one active epoch for minting");
    expect(decision).toContain("maximum handle lifetime plus bounded clock skew");
    expect(decision).toContain("No error includes the handle");
    expect(decision).toContain("one-connector, named-account experience");
    expect(decision).toContain("[#376]");
    expect(decision).toContain("[#377]");
    expect(decision).toContain("## Required compatibility and security tests");
    expect(decision).toContain("## Stop rule");
  });
});

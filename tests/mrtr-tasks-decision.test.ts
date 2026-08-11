import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const decision = readFileSync(
  new URL("../docs/plans/2026-08-11-mrtr-tasks-decision.md", import.meta.url),
  "utf8"
);

describe("MRTR and Tasks decision", () => {
  it("records the selected capability-gated MRTR boundary and safe fallback", () => {
    expect(decision).toContain("Status: Multi Round-Trip Requests are implemented for confirmation workflows");
    expect(decision).toContain("`elicitation.form`");
    expect(decision).toContain("authenticated request-context correlation");
    expect(decision).toContain("cannot consume another request's state");
    expect(decision).toContain("Clients without the declared form capability");
    expect(decision).toContain("No bearer is disclosed in the default human mode");
  });

  it("distinguishes lifecycle outcomes and records why Tasks remain unimplemented", () => {
    for (const outcome of ["Incomplete and waiting for input", "Cancelled by the caller", "Failed or rejected", "Completed"]) {
      expect(decision).toContain(outcome);
    }
    expect(decision).toContain("The `io.modelcontextprotocol/tasks` extension remains unimplemented");
    expect(decision).toContain("there is no selected Miftah task");
    expect(decision).toContain("durable opaque identifier");
    expect(decision).toContain("`tasks/get`, `tasks/result`, `tasks/update`, and `tasks/cancel`");
    expect(decision).toContain("`inputResponses` updates");
    expect(decision).toContain("packaged reconnect evidence");
    expect(decision).toContain("Miftah makes no Tasks interoperability claim");
  });

  it("links the primary protocol and extension sources", () => {
    expect(decision).toContain("https://blog.modelcontextprotocol.io/posts/2026-07-28/");
    expect(decision).toContain("https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322");
    expect(decision).toContain("https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663");
    expect(decision).toContain("https://modelcontextprotocol.io/extensions/tasks/overview");
    expect(decision).toContain("https://github.com/modelcontextprotocol/ext-tasks");
  });
});

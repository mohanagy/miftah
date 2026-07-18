import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("product README", () => {
  it("leads with the multi-account outcome instead of internal implementation terms", () => {
    expect(readme).toContain("## One MCP connector. Deliberate account selection.");
    expect(readme).toContain("same MCP service across more than one account");
    expect(readme).toContain("Do not create one client entry for every account.");
    expect(readme).not.toContain("credential broker");
  });

  it("sets practical expectations for local operation, audit logging, and GUI secret setup", () => {
    expect(readme).toContain("Miftah itself has no cloud service or telemetry");
    expect(readme).toContain("Optional, redacted local audit metadata");
    expect(readme).toContain("Claude Desktop is a GUI app and does not inherit terminal startup files");
  });

  it("explains what Miftah changes and what it deliberately does not replace", () => {
    expect(readme).toContain("one Miftah connector per service");
    expect(readme).toContain("Miftah wraps an existing upstream MCP server. It does not replace it.");
    expect(readme).toContain("Miftah does not run provider OAuth");
  });

  it("keeps a practical Claude Desktop path and routes detailed material to the docs", () => {
    expect(readme).toContain("miftah init github --preset github");
    expect(readme).toContain("[Claude Desktop setup](docs/claude-desktop.md)");
    expect(readme).toContain("[Configuration reference](docs/config.md)");
    expect(readme).toContain("[Security boundary](docs/security.md)");
  });
});

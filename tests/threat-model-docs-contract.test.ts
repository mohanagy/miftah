import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function document(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("threat model documentation contract", () => {
  it("publishes a public threat model from the security and architecture documentation", async () => {
    const [threatModel, readme, security, architecture] = await Promise.all([
      document("docs/threat-model.md"),
      document("README.md"),
      document("docs/security.md"),
      document("docs/architecture.md")
    ]);

    expect(readme).toContain("[Threat model](docs/threat-model.md)");
    expect(security).toContain("[threat model](threat-model.md)");
    expect(architecture).toContain("[threat model](threat-model.md)");
    expect(await document("SECURITY.md")).toContain("[threat model](docs/threat-model.md)");

    for (const heading of [
      "## Scope and method",
      "## Protected assets",
      "## Actors and trust assumptions",
      "## Trust boundaries and data flows",
      "## Threats, controls, and residual risks",
      "## Guarantees and explicit non-goals",
      "## Operator deployment responsibilities",
      "## Independent review status"
    ]) {
      expect(threatModel).toContain(heading);
    }
  });

  it("maps the in-scope threats to supported controls without overstating their boundaries", async () => {
    const threatModel = await document("docs/threat-model.md");

    expect(threatModel).toContain(
      "| Threat and attacker goal | Implemented controls | Residual risk and operator decision |"
    );
    expect(threatModel).toContain(
      "required secret-backed bearer authentication for explicitly enabled non-loopback binding"
    );

    for (const boundary of [
      "trusted and untrusted MCP clients and upstreams",
      "prompt-driven tool and profile switching",
      "local process and environment exposure",
      "secret providers and credential files",
      "remote transport and session authentication",
      "routing ambiguity and policy fail-open paths",
      "audit confidentiality and integrity",
      "plugin and supply-chain boundaries",
      "denial of service and concurrency limits"
    ]) {
      expect(threatModel).toContain(boundary);
    }

    for (const residualRisk of [
      "ordinary descendants",
      "not an operating-system sandbox",
      "same OS user",
      "not a cryptographic signature",
      "not authentication",
      "cannot reduce privileges granted by a provider token"
    ]) {
      expect(threatModel).toContain(residualRisk);
    }

    for (const threat of [
      "**Secret disclosure**",
      "**Prompt-driven profile or tool confusion**",
      "**Provider or plugin subprocess abuse**",
      "**Credential-runtime or container handoff exposure**",
      "**Remote transport or local HTTP session confusion**",
      "**Routing ambiguity, deceptive metadata, or policy fail-open**",
      "**Audit loss, disclosure, or undetected replacement**",
      "**Misleading upstream identity or response data**",
      "**Plugin, dependency, or source supply-chain compromise**",
      "**Denial of service and concurrency exhaustion**"
    ]) {
      expect(threatModel).toContain(threat);
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const identityVerificationHeadingPattern = /^## Identity verification\s*$/mu;
const sectionHeadingPattern = /^## /mu;
const identityFingerprintFieldPattern = /^\s+(\w+)\?: string;$/gmu;
const documentedFingerprintFieldPattern = /^\| `([^`]+)` \|/gmu;
const fieldLimitPattern = /const maxIdentityFieldLength = (\d+);/u;
const responseLimitPattern = /const maxIdentityResponseLength = ([\d_]+);/u;
const maxAgePattern = /maxAgeMs: z\.number\(\)\.int\(\)\.positive\(\)\.max\(([\d_]+)\)/u;
const digitGroupPattern = /\B(?=(\d{3})+(?!\d))/gu;
const beforeParsingPattern = /before parsing or normalization/iu;
const identityStatusPattern = /"([^"]+)"/gu;
const identityStatusFieldPattern = /^\s+(\w+)\??:/gmu;
const documentedIdentityPattern = /\[#21\][\s\S]*identity/iu;

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function identityVerificationSection(config: string): string {
  const afterHeading = config.split(identityVerificationHeadingPattern)[1];
  if (afterHeading === undefined) throw new Error("docs/config.md must contain an Identity verification section.");
  const nextSection = afterHeading.search(sectionHeadingPattern);
  return nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
}

describe("identity verification documentation contract", () => {
  it("keeps bounded configuration and probe-response semantics aligned with the schema and parser", () => {
    const types = readRepositoryFile("src/config/types.ts");
    const schema = readRepositoryFile("src/config/schema.ts");
    const manager = readRepositoryFile("src/identity/identity-manager.ts");
    const config = readRepositoryFile("docs/config.md");
    const security = readRepositoryFile("docs/security.md");
    const identityConfig = identityVerificationSection(config);

    const identityFingerprint = types.split("export interface IdentityFingerprint {")[1]?.split("\n}")[0] ?? "";
    const authoritativeFingerprintFields = Array.from(identityFingerprint.matchAll(identityFingerprintFieldPattern), (match) => match[1])
      .sort();
    const documentedFingerprintFields = Array.from(identityConfig.matchAll(documentedFingerprintFieldPattern), (match) => match[1])
      .sort();
    expect(documentedFingerprintFields).toEqual(authoritativeFingerprintFields);

    const fieldLimit = manager.match(fieldLimitPattern)?.[1];
    const responseLimit = manager.match(responseLimitPattern)?.[1]?.replaceAll("_", "");
    const maxAgeMs = schema.match(maxAgePattern)?.[1]?.replaceAll("_", "");
    expect(fieldLimit).toBeDefined();
    expect(responseLimit).toBeDefined();
    expect(maxAgeMs).toBeDefined();
    expect(schema).toContain(`z.string().trim().min(1).max(${fieldLimit})`);
    expect(schema).toContain(`tool: z.string().trim().min(1).max(${fieldLimit})`);
    expect(schema).toContain(`maxAgeMs: z.number().int().positive().max(${maxAgeMs?.replace(digitGroupPattern, "_")})`);
    expect(manager).toContain("const normalized = value.trim();");
    expect(manager).toContain("content.length !== 1");
    expect(manager).toContain('content[0]?.type !== "text"');
    expect(manager).toContain("content[0].text.length > maxIdentityResponseLength");
    expect(manager).toContain("JSON.parse(content[0].text)");
    expect(manager).toContain("if (!isRecord(parsed)) return undefined;");
    expect(manager).toContain('for (const field of ["provider", "login", "organization", "host"] as const)');

    expect(identityConfig).toContain(`maximum ${fieldLimit} JavaScript characters`);
    expect(identityConfig).toContain("trimmed and must be nonempty");
    expect(identityConfig).toContain(`maximum ${maxAgeMs?.replace(digitGroupPattern, ",")} ms (24 hours)`);
    expect(identityConfig).toContain("positive integer");
    expect(identityConfig).toContain("exactly one MCP text content item");
    expect(identityConfig).toContain(`maximum ${responseLimit?.replace(digitGroupPattern, ",")} JavaScript characters`);
    expect(identityConfig).toMatch(beforeParsingPattern);
    expect(identityConfig).toContain("JSON object");
    expect(identityConfig).toContain("allowed string fields");
    expect(security).toMatch(beforeParsingPattern);
  });

  it("keeps gating, statuses, management targeting, doctor mapping, and safe-output claims aligned", () => {
    const manager = readRepositoryFile("src/identity/identity-manager.ts");
    const statusTypes = readRepositoryFile("src/identity/identity-types.ts");
    const server = readRepositoryFile("src/mcp/server/miftah-server.ts");
    const managementTools = readRepositoryFile("src/mcp/server/management-tools.ts");
    const pipeline = readRepositoryFile("src/mcp/server/operation-pipeline.ts");
    const doctor = readRepositoryFile("src/cli/doctor.ts");
    const doctorReport = readRepositoryFile("src/cli/doctor-report.ts");
    const config = readRepositoryFile("docs/config.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const security = readRepositoryFile("docs/security.md");
    const cli = readRepositoryFile("docs/cli.md");
    const changelog = readRepositoryFile("CHANGELOG.md");
    const identityConfig = identityVerificationSection(config);

    const verificationStatuses = statusTypes.split("export type IdentityVerificationStatus =")[1]?.split(";")[0] ?? "";
    const bindingStatuses = statusTypes.split("export type IdentityBindingState =")[1]?.split(";")[0] ?? "";
    const verificationStatusValues = Array.from(verificationStatuses.matchAll(identityStatusPattern), (match) => match[1]);
    const bindingStatusValues = Array.from(bindingStatuses.matchAll(identityStatusPattern), (match) => match[1]);
    const statuses = [...verificationStatusValues, ...bindingStatusValues];
    const identityStatus = statusTypes.split("export interface IdentityStatus {")[1]?.split("\n}")[0] ?? "";
    const identityStatusFields = Array.from(identityStatus.matchAll(identityStatusFieldPattern), (match) => match[1]).sort();
    expect(verificationStatusValues).not.toHaveLength(0);
    expect(bindingStatusValues).not.toHaveLength(0);
    for (const status of statuses) expect(security).toContain(`\`${status}\``);
    expect(identityStatusFields).toEqual([
      "actual",
      "bindingState",
      "bound",
      "boundAt",
      "errorCode",
      "expected",
      "profile",
      "status",
      "upstream",
      "verifiedAt"
    ]);

    expect(manager).toContain('if (risk !== "write" && risk !== "destructive") return false;');
    expect(manager).toContain("requiredRisk === risk");
    expect(pipeline).toContain("this.options.identities.requiresVerification(profile, target.identityUpstreamName, decision.risk)");
    expect(identityConfig).toContain("only when `requiredForRisk` explicitly names the selected write or destructive risk");
    expect(identityConfig).toContain("Read discovery, resource reads, and prompt retrieval are not gated");
    expect(identityConfig).toContain('`selectionMode: "explicit" | "confirmed"`');
    expect(identityConfig).toContain("another process changing the durable default");

    expect(managementTools).toContain('name: "miftah_verify_identity"');
    expect(server).toContain("args.profile === undefined ? source.activeProfile");
    expect(server).toContain("const targetUpstreams = this.identityTargetUpstreams(requestedUpstream);");
    expect(server).toContain('requestedUpstream === "default" && configured.length === 1 && configured[0] === undefined');
    expect(server).toContain("if (requestedUpstream === undefined) return configured;");
    expect(server).toContain("this.redactor.redactForAudit(status)");
    for (const claim of [
      "`miftah_verify_identity`",
      "defaults to the active profile",
      "named `upstream`",
      '`upstream: "default"`',
      "every configured target",
      "deterministic upstream order",
      "safe structured identity results"
    ]) {
      expect(cli).toContain(claim);
    }

    expect(doctorReport).toContain('IDENTITY: "DOCTOR_IDENTITY"');
    expect(doctor).toMatch(/identityCheck\(\s*"skipped"/u);
    expect(doctor).toContain('required ? "error" : "warning"');
    for (const claim of [
      "`DOCTOR_IDENTITY` as `skipped`",
      "configured verified identity is `pass`",
      "required identity verification is `error`",
      "optional identity verification is `warning`",
      "never includes raw probe output or fingerprint values"
    ]) {
      expect(cli).toContain(claim);
    }

    expect(manager).toContain("private readonly statuses = new Map<string, IdentityStatus>();");
    expect(manager).toContain("private readonly cache = new Map<string, Map<string, IdentityStatus>>();");
    expect(manager).toContain("private readonly bindings = new Map<string, IdentityBindingRecord>();");
    expect(architecture).toContain("file-backed binding store");
    expect(architecture).toContain("cannot satisfy a protected live request");
    for (const claim of [
      "raw response",
      "unconfigured field",
      "tool argument",
      "error body",
      "arbitrary JSON",
      "credentials",
      "credential validity",
      "raw configuration path"
    ]) {
      expect(security).toContain(claim);
    }
    expect(changelog).toMatch(documentedIdentityPattern);
  });
});

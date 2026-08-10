import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PrototypeReport {
  schemaVersion: number;
  status: string;
  corpus: {
    benign: number;
    malicious: number;
    flaggedBenign: number;
    flaggedMalicious: number;
    falsePositiveRate: number;
    detectionRate: number;
    misses: string[];
  };
  scannerValidation: {
    instructionOverride: boolean;
    secretExfiltration: boolean;
    concealment: boolean;
    authoritySpoofing: boolean;
    forcedToolChain: boolean;
  };
  changeDetection: {
    summary: {
      total: number;
      added: number;
      removed: number;
      changed: number;
      description: number;
      inputSchema: number;
    };
  };
  descriptorValidation: {
    duplicateNameRejected: boolean;
    emptyNameRejected: boolean;
    missingNameRejected: boolean;
  };
  benchmark: {
    toolCount: number;
    iterations: number;
    medianMs: number;
    p95Ms: number;
    maxMs: number;
  };
}

async function document(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function runPrototype(): PrototypeReport {
  const script = fileURLToPath(new URL("../scripts/tool-description-quarantine-prototype.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    shell: false,
    timeout: 15_000
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as PrototypeReport;
}

describe("tool-description quarantine research", () => {
  it("records deterministic synthetic detection and drift evidence", () => {
    const report = runPrototype();

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("research-only");
    expect(report.corpus).toMatchObject({
      benign: 12,
      malicious: 10,
      flaggedBenign: 1,
      flaggedMalicious: 8,
      falsePositiveRate: 1 / 12,
      detectionRate: 0.8
    });
    expect(report.corpus.misses).toHaveLength(2);
    expect(report.scannerValidation).toEqual({
      instructionOverride: true,
      secretExfiltration: true,
      concealment: true,
      authoritySpoofing: true,
      forcedToolChain: true
    });
    expect(report.changeDetection.summary).toEqual({
      total: 5,
      added: 1,
      removed: 1,
      changed: 3,
      description: 2,
      inputSchema: 1
    });
    expect(report.descriptorValidation).toEqual({
      duplicateNameRejected: true,
      emptyNameRejected: true,
      missingNameRejected: true
    });
  });

  it("keeps timing evidence bounded without treating it as a production SLO", () => {
    const report = runPrototype();

    expect(report.benchmark).toMatchObject({ toolCount: 1_000, iterations: 30 });
    expect(report.benchmark.medianMs).toBeGreaterThan(0);
    expect(report.benchmark.p95Ms).toBeGreaterThanOrEqual(report.benchmark.medianMs);
    expect(report.benchmark.maxMs).toBeLessThan(10_000);
  });

  it("publishes the defer recommendation and enforceable credential boundary", async () => {
    const [research, threatModel] = await Promise.all([
      document("docs/research/tool-description-quarantine.md"),
      document("docs/threat-model.md")
    ]);

    for (const statement of [
      "Status: research evidence, not a production control",
      "Recommendation: defer runtime quarantine",
      "synthetic corpus does not estimate production false-positive rates",
      "cannot protect credentials after they are delivered to an upstream",
      "design-partner evidence"
    ]) {
      expect(research).toContain(statement);
    }
    expect(threatModel).toContain("[tool-description quarantine study](research/tool-description-quarantine.md)");
    expect(threatModel).toContain("is not a production security control");
  });
});

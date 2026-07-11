import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCTOR_CODES,
  diagnoseCommandPinning,
  diagnosePathPermissions,
  formatDoctorReport,
  normalizeDoctorReport,
  runRedactionCanary
} from "../src/cli/doctor-report.js";
import { SecretRedactor } from "../src/secrets/redact.js";

const fixtureDirectory = resolve(`.doctor-report-test-${process.pid}`);

afterEach(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true });
});

describe("doctor report", () => {
  it("normalizes statuses and only renders safe check fields", () => {
    const report = normalizeDoctorReport([
      {
        code: DOCTOR_CODES.CANARY,
        status: "pass",
        target: "secret redaction",
        explanation: "Secret redaction passed.",
        remediation: "No action required.",
        sourceError: "unsafe-error-message"
      },
      {
        code: DOCTOR_CODES.PINNING,
        status: "warning",
        target: "package dependency",
        explanation: "A package version is not pinned.",
        remediation: "Use an explicit semantic version.",
        details: { path: "/unsafe/path" }
      },
      {
        code: DOCTOR_CODES.CONFIGURATION,
        status: "error",
        target: "configuration",
        explanation: "Configuration could not be checked.",
        remediation: "Correct the configuration."
      }
    ]);

    expect(report).toMatchObject({
      overallStatus: "failed",
      ok: false,
      summary: { pass: 1, warning: 1, error: 1, skipped: 0 }
    });
    expect(report.checks.map((check) => check.code)).toEqual([
      DOCTOR_CODES.CONFIGURATION,
      DOCTOR_CODES.CANARY,
      DOCTOR_CODES.PINNING
    ]);

    const output = formatDoctorReport(report);
    expect(output).toContain(DOCTOR_CODES.CANARY);
    expect(output).toContain("A package version is not pinned.");
    expect(output).toContain("Use an explicit semantic version.");
    expect(output).not.toContain("unsafe-error-message");
    expect(output).not.toContain("/unsafe/path");
  });

  it("uses a real redactor to validate a generated canary without reporting it", () => {
    const redactor = new SecretRedactor();
    const check = runRedactionCanary(redactor);
    const canary = redactor.values()[0];

    expect(canary).toBeDefined();
    expect(redactor.redactText(`value=${canary}`)).not.toContain(canary!);
    expect(redactor.redact({ value: canary })).toEqual({ value: "[REDACTED]" });
    expect(check).toMatchObject({ code: DOCTOR_CODES.CANARY, status: "pass" });

    const report = normalizeDoctorReport([check]);
    expect(JSON.stringify(report)).not.toContain(canary!);
    expect(formatDoctorReport(report)).not.toContain(canary!);
  });

  it("reports Unix group and world permissions on existing files and directories", async () => {
    if (process.platform === "win32") return;

    await mkdir(fixtureDirectory, { recursive: true });
    const file = resolve(fixtureDirectory, "config.json");
    const directory = resolve(fixtureDirectory, "audit");
    await writeFile(file, "{}");
    await mkdir(directory);

    await chmod(file, 0o644);
    await chmod(directory, 0o755);
    await expect(diagnosePathPermissions("config", file)).resolves.toMatchObject({ status: "warning" });
    await expect(diagnosePathPermissions("audit", directory)).resolves.toMatchObject({ status: "warning" });

    await chmod(file, 0o600);
    await chmod(directory, 0o700);
    await expect(diagnosePathPermissions("config", file)).resolves.toMatchObject({ status: "pass" });
    await expect(diagnosePathPermissions("audit", directory)).resolves.toMatchObject({ status: "pass" });
  });

  it("skips permission diagnostics on Windows without filesystem mocks", async () => {
    if (process.platform !== "win32") return;

    await expect(diagnosePathPermissions("env", "not-read-on-windows")).resolves.toMatchObject({
      code: DOCTOR_CODES.ENV_PERMISSIONS,
      status: "skipped"
    });
  });

  it("diagnoses only recognized unpinned docker, podman, and package invocations", () => {
    const cases = [
      ["docker", ["run", "registry.example/docker-unpinned:latest"], "warning"],
      ["docker", ["run", "registry.example/docker-pinned@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "pass"],
      ["podman", ["run", "--rm", "registry.example/podman-unpinned:latest"], "warning"],
      ["podman", ["run", "registry.example/podman-pinned@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "pass"],
      ["npx", ["npx-unpinned@latest"], "warning"],
      ["npx", ["npx-pinned@1.2.3"], "pass"],
      ["npm", ["exec", "--", "@scope/npm-unpinned@latest"], "warning"],
      ["npm", ["exec", "--", "@scope/npm-pinned@1.2.3"], "pass"]
    ] as const;
    const checks = cases.map(([command, args]) => diagnoseCommandPinning(command, args));

    expect(checks.map((check) => check.status)).toEqual([
      "warning",
      "pass",
      "warning",
      "pass",
      "warning",
      "pass",
      "warning",
      "pass"
    ]);
    expect(checks.map((check) => check.target)).toEqual([
      "container image",
      "container image",
      "container image",
      "container image",
      "package dependency",
      "package dependency",
      "package dependency",
      "package dependency"
    ]);

    const output = formatDoctorReport(normalizeDoctorReport(checks));
    for (const value of ["docker-unpinned", "podman-unpinned", "npx-unpinned", "npm-unpinned", "@scope/npm-pinned"]) {
      expect(output).not.toContain(value);
    }
  });
});

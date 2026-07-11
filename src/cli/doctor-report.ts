import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { SecretRedactor } from "../secrets/redact.js";

export const DOCTOR_CODES = {
  CONFIGURATION: "DOCTOR_CONFIGURATION",
  SECRET_REFERENCES: "DOCTOR_SECRET_REFERENCES",
  CANARY: "DOCTOR_REDACTION_CANARY",
  CONFIG_PERMISSIONS: "DOCTOR_CONFIG_PERMISSIONS",
  ENV_PERMISSIONS: "DOCTOR_ENV_PERMISSIONS",
  AUDIT_PERMISSIONS: "DOCTOR_AUDIT_PERMISSIONS",
  EXECUTABLE: "DOCTOR_EXECUTABLE",
  STARTUP: "DOCTOR_STARTUP",
  TOOLS_DISCOVERY: "DOCTOR_TOOLS_DISCOVERY",
  RESOURCES_DISCOVERY: "DOCTOR_RESOURCES_DISCOVERY",
  PROMPTS_DISCOVERY: "DOCTOR_PROMPTS_DISCOVERY",
  COLLISION: "DOCTOR_COLLISION",
  SCHEMA_DIFFERENCE: "DOCTOR_SCHEMA_DIFFERENCE",
  PINNING: "DOCTOR_PINNING",
  AUDIT_WRITABLE: "DOCTOR_AUDIT_WRITABLE",
  CLEAN_SHUTDOWN: "DOCTOR_CLEAN_SHUTDOWN"
} as const;

export type DoctorCode = (typeof DOCTOR_CODES)[keyof typeof DOCTOR_CODES];
export type DoctorCheckStatus = "pass" | "warning" | "error" | "skipped";
export type DoctorOverallStatus = "healthy" | "degraded" | "failed";

export interface DoctorCheck {
  code: DoctorCode;
  status: DoctorCheckStatus;
  target: string;
  explanation: string;
  remediation: string;
}

export interface DoctorReport {
  overallStatus: DoctorOverallStatus;
  ok: boolean;
  checks: DoctorCheck[];
  summary: Record<DoctorCheckStatus, number>;
}

type PermissionTarget = "config" | "env" | "audit";

const doctorCodeOrder = Object.values(DOCTOR_CODES);
const statusOrder: DoctorCheckStatus[] = ["pass", "warning", "error", "skipped"];
const noValueContainerOptions = new Set(["--rm", "--init", "--interactive", "-i", "--tty", "-t", "--detach", "-d"]);
const valueContainerOptions = new Set([
  "--add-host",
  "--attach",
  "-a",
  "--cap-add",
  "--cap-drop",
  "--cidfile",
  "--cpus",
  "--detach-keys",
  "--device",
  "--dns",
  "--dns-option",
  "--dns-search",
  "--domainname",
  "--name",
  "--env",
  "-e",
  "--env-file",
  "--expose",
  "--group-add",
  "--hostname",
  "-h",
  "--label",
  "-l",
  "--label-file",
  "--link",
  "--log-driver",
  "--log-opt",
  "--memory",
  "-m",
  "--mount",
  "--network-alias",
  "--platform",
  "--volume",
  "-v",
  "--publish",
  "-p",
  "--pull",
  "--restart",
  "--security-opt",
  "--shm-size",
  "--stop-signal",
  "--stop-timeout",
  "--sysctl",
  "--tmpfs",
  "--ulimit",
  "--workdir",
  "-w",
  "--user",
  "-u",
  "--network",
  "--entrypoint"
]);
const packageLaunchers = new Map<string, string>([
  ["npx", ""],
  ["bunx", ""],
  ["pnpm", "dlx"],
  ["yarn", "dlx"],
  ["npm", "exec"]
]);
const semverNumericIdentifier = "(?:0|[1-9]\\d*)";
const semverPrereleaseIdentifier = `(?:${semverNumericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const strictSemver = new RegExp(
  `^${semverNumericIdentifier}\\.${semverNumericIdentifier}\\.${semverNumericIdentifier}` +
    `(?:-${semverPrereleaseIdentifier}(?:\\.${semverPrereleaseIdentifier})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
);

function noAction(): string {
  return "No action required.";
}

function permissionCode(target: PermissionTarget): DoctorCode {
  switch (target) {
    case "config":
      return DOCTOR_CODES.CONFIG_PERMISSIONS;
    case "env":
      return DOCTOR_CODES.ENV_PERMISSIONS;
    case "audit":
      return DOCTOR_CODES.AUDIT_PERMISSIONS;
  }
}

function permissionLabel(target: PermissionTarget, isDirectory: boolean): string {
  const name = target === "config" ? "configuration" : target === "env" ? "environment" : "audit";
  return `${name} ${isDirectory ? "directory" : "file"}`;
}

function pinningCheck(status: DoctorCheckStatus, target: string, explanation: string, remediation: string): DoctorCheck {
  return { code: DOCTOR_CODES.PINNING, status, target, explanation, remediation };
}

function containerImage(args: readonly string[]): string | undefined {
  if (args[0] !== "run") return undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) return undefined;
    if (!argument.startsWith("-")) return argument;
    if (noValueContainerOptions.has(argument) || argument.includes("=")) continue;
    if (valueContainerOptions.has(argument)) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function isDigestPinned(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}

function packageArgument(command: string, args: readonly string[]): string | undefined {
  const launcherArgument = packageLaunchers.get(command);
  if (launcherArgument === undefined) return undefined;

  let index = 0;
  if (launcherArgument) {
    if (args[index] !== launcherArgument) return undefined;
    index += 1;
  }
  while (args[index] === "--yes" || args[index] === "-y" || args[index] === "--quiet") {
    index += 1;
  }
  if (args[index] === "--") index += 1;
  const candidate = args[index];
  if (!candidate || candidate.startsWith("-") || candidate.includes("/") && !candidate.startsWith("@")) return undefined;
  return candidate;
}

function isExplicitSemverPackage(value: string): boolean {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return false;
  const version = value.slice(separator + 1);
  return strictSemver.test(version);
}

function codePosition(code: DoctorCode): number {
  return doctorCodeOrder.indexOf(code);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function normalizeDoctorReport<T extends DoctorCheck>(checks: readonly T[]): DoctorReport {
  const normalizedChecks = checks
    .map(({ code, status, target, explanation, remediation }) => ({ code, status, target, explanation, remediation }))
    .sort(
      (left, right) =>
        codePosition(left.code) - codePosition(right.code) ||
        compareText(left.target, right.target) ||
        statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status)
    );
  const summary: Record<DoctorCheckStatus, number> = { pass: 0, warning: 0, error: 0, skipped: 0 };
  for (const check of normalizedChecks) summary[check.status] += 1;

  return {
    overallStatus: summary.error > 0 ? "failed" : summary.warning > 0 ? "degraded" : "healthy",
    ok: summary.error === 0,
    checks: normalizedChecks,
    summary
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const summary = statusOrder.map((status) => `${report.summary[status]} ${status}`).join(", ");
  const checks = report.checks.map(
    (check) =>
      `[${check.status.toUpperCase()}] ${check.code} — ${check.target}\n` +
      `  ${check.explanation}\n` +
      `  Remediation: ${check.remediation}`
  );
  return [`Doctor: ${report.overallStatus}`, `Summary: ${summary}`, ...checks].join("\n");
}

export function runRedactionCanary(redactor: SecretRedactor): DoctorCheck {
  const canary = `doctor-canary-${randomUUID()}`;
  const canaryRedactor = new SecretRedactor([...redactor.values(), canary]);
  const textRedacted = canaryRedactor.redactText(`canary=${canary}`) === "canary=[REDACTED]";
  const objectRedacted = canaryRedactor.redact({ value: canary });
  const structuredRedacted = objectRedacted.value === "[REDACTED]";

  if (textRedacted && structuredRedacted) {
    return {
      code: DOCTOR_CODES.CANARY,
      status: "pass",
      target: "secret redaction",
      explanation: "Secret redaction protects text and structured values.",
      remediation: noAction()
    };
  }
  return {
    code: DOCTOR_CODES.CANARY,
    status: "error",
    target: "secret redaction",
    explanation: "Secret redaction validation did not complete safely.",
    remediation: "Review secret redaction configuration before continuing."
  };
}

export async function diagnosePathPermissions(target: PermissionTarget, path: string): Promise<DoctorCheck> {
  const code = permissionCode(target);
  if (process.platform === "win32") {
    return {
      code,
      status: "skipped",
      target: `${target === "config" ? "configuration" : target === "env" ? "environment" : "audit"} path`,
      explanation: "Permission mode checks are not available on Windows.",
      remediation: noAction()
    };
  }

  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch {
    return {
      code,
      status: "error",
      target: `${target === "config" ? "configuration" : target === "env" ? "environment" : "audit"} path`,
      explanation: "Permission mode check could not be completed.",
      remediation: "Ensure the path exists and is accessible before running doctor."
    };
  }
  const label = permissionLabel(target, metadata.isDirectory());
  const secureMode = (metadata.mode & 0o066) === 0;
  if (secureMode) {
    return {
      code,
      status: "pass",
      target: label,
      explanation: "Permissions restrict group and other access.",
      remediation: noAction()
    };
  }
  return {
    code,
    status: "warning",
    target: label,
    explanation: "Permissions allow group or other access.",
    remediation: `Restrict the ${label} with chmod ${metadata.isDirectory() ? "700" : "600"}.`
  };
}

export function diagnoseCommandPinning(command: string, args: readonly string[]): DoctorCheck {
  if (command === "docker" || command === "podman") {
    const image = containerImage(args);
    if (!image) {
      return pinningCheck("skipped", "container image", "No recognized container image invocation was found.", noAction());
    }
    if (isDigestPinned(image)) {
      return pinningCheck("pass", "container image", "The container image uses an immutable digest.", noAction());
    }
    return pinningCheck(
      "warning",
      "container image",
      "The container image does not use an immutable digest.",
      "Use an image digest such as @sha256:<digest>."
    );
  }

  const packageName = packageArgument(command, args);
  if (!packageName) {
    return pinningCheck("skipped", "package dependency", "No recognized package invocation was found.", noAction());
  }
  if (isExplicitSemverPackage(packageName)) {
    return pinningCheck("pass", "package dependency", "The package uses an explicit semantic version.", noAction());
  }
  return pinningCheck(
    "warning",
    "package dependency",
    "A package version is not pinned.",
    "Use an explicit semantic version."
  );
}

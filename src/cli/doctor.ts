import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig, ProfileConfig, ToolingConfig, UpstreamConfig } from "../config/types.js";
import { IdentityManager } from "../identity/identity-manager.js";
import { canonicalJson } from "../mcp/server/tool-registry.js";
import { resolveClientVisibleToolName } from "../mcp/server/miftah-server.js";
import type { UpstreamSession } from "../upstream/upstream-session.js";
import { MiftahError } from "../utils/errors.js";
import { createRuntime } from "./create-runtime.js";
import {
  DOCTOR_CODES,
  diagnoseCommandPinning,
  diagnosePathPermissions,
  normalizeDoctorReport,
  runRedactionCanary,
  type DoctorCheck,
  type DoctorReport
} from "./doctor-report.js";

const discoveryPageLimit = 16;

interface DoctorTarget {
  profile: string;
  profileIndex: number;
  upstreamName?: string;
  upstreamIndex: number;
  upstream: UpstreamConfig;
}

function noAction(): string {
  return "No action required.";
}

function targetLabel(target: DoctorTarget): string {
  return `profile ${target.profileIndex + 1}, upstream ${target.upstreamName === undefined ? "default" : target.upstreamIndex + 1}`;
}

function check(
  code: DoctorCheck["code"],
  status: DoctorCheck["status"],
  target: string,
  explanation: string,
  remediation: string
): DoctorCheck {
  return { code, status, target, explanation, remediation };
}

function skippedDiscoveryCheck(code: DoctorCheck["code"], target: string, capability: string): DoctorCheck {
  return check(
    code,
    "skipped",
    target,
    `${capability} discovery was skipped because startup did not complete.`,
    "Resolve the startup check before retrying discovery."
  );
}

function identityCheck(
  status: DoctorCheck["status"],
  target: string,
  explanation: string,
  remediation: string
): DoctorCheck {
  return check(DOCTOR_CODES.IDENTITY, status, target, explanation, remediation);
}

function configuredUpstreams(config: MiftahConfig): Array<{ name?: string; upstream: UpstreamConfig }> {
  if (config.upstreams) {
    return Object.entries(config.upstreams)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, upstream]) => ({ name, upstream }));
  }
  return config.upstream ? [{ upstream: config.upstream }] : [];
}

function configuredTargets(config: MiftahConfig): DoctorTarget[] {
  const targets: DoctorTarget[] = [];
  for (const [profileIndex, profile] of Object.keys(config.profiles).sort().entries()) {
    for (const [upstreamIndex, { name, upstream }] of configuredUpstreams(config).entries()) {
      targets.push({ profile, profileIndex, upstreamName: name, upstreamIndex, upstream });
    }
  }
  return targets;
}

function pathForTarget(config: MiftahConfig, target: DoctorTarget): string | undefined {
  const profile: ProfileConfig | undefined = config.profiles[target.profile];
  const profileEnvironment = {
    ...(profile?.env ?? {}),
    ...(target.upstreamName ? profile?.upstreams?.[target.upstreamName]?.env ?? {} : {})
  };
  return profileEnvironment.PATH ?? target.upstream.env?.PATH ?? process.env.PATH;
}

function effectiveTargetOptions(
  config: MiftahConfig,
  target: DoctorTarget
): { args: string[]; cwd: string | undefined } {
  const profile = config.profiles[target.profile];
  const override = target.upstreamName ? profile?.upstreams?.[target.upstreamName] : undefined;
  return {
    args: override?.args ?? profile?.args ?? target.upstream.args ?? [],
    cwd: override?.cwd ?? profile?.cwd ?? target.upstream.cwd
  };
}

async function isExecutableAvailable(
  command: string | undefined,
  pathValue: string | undefined,
  cwd: string | undefined
): Promise<boolean> {
  if (!command) return false;
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [isAbsolute(command) ? command : resolve(cwd ?? process.cwd(), command)]
    : (pathValue ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .flatMap((entry) =>
          process.platform === "win32"
            ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")].map((extension) =>
                join(entry, `${command}${extension}`)
              )
            : [join(entry, command)]
        );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Check the next PATH candidate without exposing its location.
    }
  }
  return false;
}

async function listTools(session: UpstreamSession): Promise<{ tools: Tool[]; truncated: boolean }> {
  const result = await session.listTools();
  return { tools: result.tools, truncated: Boolean(result.nextCursor) };
}

async function listResources(session: UpstreamSession): Promise<{ count: number; truncated: boolean }> {
  let cursor: string | undefined;
  let count = 0;
  for (let page = 0; page < discoveryPageLimit; page += 1) {
    const result = await session.listResources(cursor === undefined ? undefined : { cursor });
    count += result.resources.length;
    if (!result.nextCursor) return { count, truncated: false };
    cursor = result.nextCursor;
  }
  return { count, truncated: true };
}

async function listPrompts(session: UpstreamSession): Promise<{ count: number; truncated: boolean }> {
  let cursor: string | undefined;
  let count = 0;
  for (let page = 0; page < discoveryPageLimit; page += 1) {
    const result = await session.listPrompts(cursor === undefined ? undefined : { cursor });
    count += result.prompts.length;
    if (!result.nextCursor) return { count, truncated: false };
    cursor = result.nextCursor;
  }
  return { count, truncated: true };
}

function configurationFailure(error: unknown): DoctorCheck {
  const code = error instanceof MiftahError && error.code.startsWith("SECRET_")
    ? DOCTOR_CODES.SECRET_REFERENCES
    : DOCTOR_CODES.CONFIGURATION;
  return check(
    code,
    "error",
    code === DOCTOR_CODES.SECRET_REFERENCES ? "secret references" : "configuration",
    code === DOCTOR_CODES.SECRET_REFERENCES
      ? "Secret references could not be initialized safely."
      : "Configuration could not be loaded safely.",
    code === DOCTOR_CODES.SECRET_REFERENCES
      ? "Correct secret reference configuration and retry doctor."
      : "Correct configuration and retry doctor."
  );
}

function strictToolDiscoveryCapacityCheck(config: MiftahConfig): DoctorCheck | undefined {
  const maximumProfiles = config.process?.maxConcurrentProfiles;
  if (
    config.tooling?.toolDiscoveryMode !== "strict" ||
    maximumProfiles === undefined ||
    !Number.isFinite(maximumProfiles) ||
    maximumProfiles >= Object.keys(config.profiles).length
  ) {
    return undefined;
  }
  return check(
    DOCTOR_CODES.TOOLS_DISCOVERY,
    "error",
    "strict tool discovery",
    "Strict tool discovery requires all profiles to be available at the same time.",
    "Increase maxConcurrentProfiles or use permissive tool discovery."
  );
}

function recordCollision(
  checks: DoctorCheck[],
  target: DoctorTarget,
  visibleTools: Map<string, string>,
  tools: readonly Tool[],
  collisionStrategy: ToolingConfig["collisionStrategy"]
): boolean {
  let collided = false;
  for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const name = resolveClientVisibleToolName(tool.name, target.upstreamName, collisionStrategy);
      if (visibleTools.has(name)) {
        collided = true;
        continue;
      }
      visibleTools.set(name, canonicalJson({ ...structuredClone(tool), name }));
    } catch {
      collided = true;
    }
  }
  if (collided) {
    checks.push(
      check(
        DOCTOR_CODES.COLLISION,
        "error",
        targetLabel(target),
        "Tool discovery found a client-visible name collision.",
        "Adjust tool names or collision strategy before starting the wrapper."
      )
    );
  }
  return collided;
}

function addSchemaDifferenceCheck(
  checks: DoctorCheck[],
  config: MiftahConfig,
  fingerprints: ReadonlyMap<string, ReadonlyMap<string, string>>,
  incompleteProfiles: ReadonlySet<string>
): void {
  const profiles = Object.keys(config.profiles).sort().filter((profile) => !incompleteProfiles.has(profile));
  if (profiles.length < 2) {
    checks.push(
      check(
        DOCTOR_CODES.SCHEMA_DIFFERENCE,
        "skipped",
        "profile tool schemas",
        "Profile schema comparison requires at least two complete profiles.",
        noAction()
      )
    );
    return;
  }
  const reference = fingerprints.get(profiles[0]!);
  const differs = profiles.slice(1).some((profile) => {
    const current = fingerprints.get(profile);
    if (!reference || !current || reference.size !== current.size) return true;
    return [...reference].some(([name, fingerprint]) => current.get(name) !== fingerprint);
  });
  if (!differs) {
    checks.push(
      check(
        DOCTOR_CODES.SCHEMA_DIFFERENCE,
        "pass",
        "profile tool schemas",
        "Complete profiles expose matching client-visible tool schemas.",
        noAction()
      )
    );
    return;
  }
  const strict = config.tooling?.toolDiscoveryMode === "strict";
  checks.push(
    check(
      DOCTOR_CODES.SCHEMA_DIFFERENCE,
      strict ? "error" : "warning",
      "profile tool schemas",
      "Complete profiles expose different client-visible tool schemas.",
      strict
        ? "Align profile tool schemas before starting the wrapper."
        : "Review profile tool schema differences before routing across profiles."
    )
  );
}

async function addAuditChecks(
  checks: DoctorCheck[],
  config: MiftahConfig,
  redactor: Awaited<ReturnType<typeof createRuntime>>["redactor"]
): Promise<void> {
  if (config.audit?.enabled === false || !config.audit?.path) {
    checks.push(
      check(
        DOCTOR_CODES.AUDIT_WRITABLE,
        "skipped",
        "audit log",
        "Audit logging is not configured.",
        "Configure an audit log to verify fail-closed audit readiness."
      ),
      check(
        DOCTOR_CODES.AUDIT_PERMISSIONS,
        "skipped",
        "audit path",
        "Audit logging is not configured.",
        "Configure an audit log to verify audit permissions."
      )
    );
    return;
  }
  try {
    await new AuditLogger(config.audit.path, { redactor, failureMode: "fail-closed" }).ensureWritable();
    checks.push(
      check(
        DOCTOR_CODES.AUDIT_WRITABLE,
        "pass",
        "audit log",
        "The fail-closed audit log is writable.",
        noAction()
      )
    );
  } catch {
    checks.push(
      check(
        DOCTOR_CODES.AUDIT_WRITABLE,
        "error",
        "audit log",
        "The fail-closed audit log could not be prepared.",
        "Correct audit storage access before starting the wrapper."
      )
    );
  }
  try {
    checks.push(
      await diagnosePathPermissions("audit", config.audit.path),
      await diagnosePathPermissions("audit", dirname(config.audit.path))
    );
  } catch {
    checks.push(
      check(
        DOCTOR_CODES.AUDIT_PERMISSIONS,
        "error",
        "audit path",
        "Permission mode check could not be completed.",
        "Ensure the audit path is accessible before running doctor."
      )
    );
  }
}

/**
 * Performs bounded, side-effecting readiness checks without exposing runtime diagnostics.
 */
export async function runDoctor(configPath: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const resolvedConfigPath = resolvePath(configPath);
  try {
    checks.push(await diagnosePathPermissions("config", resolvedConfigPath));
  } catch {
    checks.push(
      check(
        DOCTOR_CODES.CONFIG_PERMISSIONS,
        "error",
        "configuration path",
        "Permission mode check could not be completed.",
        "Ensure the path exists and is accessible before running doctor."
      )
    );
  }

  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime(configPath);
  } catch (error) {
    checks.push(configurationFailure(error));
    return normalizeDoctorReport(checks);
  }

  try {
    checks.push(
      check(
        DOCTOR_CODES.CONFIGURATION,
        "pass",
        "configuration",
        "Configuration loaded and validated.",
        noAction()
      ),
      check(
        DOCTOR_CODES.SECRET_REFERENCES,
        "pass",
        "secret references",
        "Secret references initialized safely.",
        noAction()
      ),
      runRedactionCanary(runtime.redactor)
    );

    const strictCapacityCheck = strictToolDiscoveryCapacityCheck(runtime.config);
    if (strictCapacityCheck) checks.push(strictCapacityCheck);

    for (const envFile of runtime.config.secrets?.envFiles ?? []) {
      checks.push(await diagnosePathPermissions("env", envFile));
    }

    await addAuditChecks(checks, runtime.config, runtime.redactor);

    for (const target of configuredTargets(runtime.config)) {
      checks.push(
        diagnoseCommandPinning(basename(target.upstream.command ?? ""), effectiveTargetOptions(runtime.config, target).args)
      );
    }

    const visibleTools = new Map<string, Map<string, string>>();
    const incompleteProfiles = new Set<string>();
    const targets = configuredTargets(runtime.config);
    const identities = new IdentityManager(runtime.config);
    const discoveryFailureStatus = runtime.config.tooling?.toolDiscoveryMode === "strict" ? "error" : "warning";
    const identityRequired = (target: DoctorTarget): boolean =>
      identities.requiresVerification(target.profile, target.upstreamName, "write") ||
      identities.requiresVerification(target.profile, target.upstreamName, "destructive");
    const unavailableIdentityCheck = (target: DoctorTarget, targetText: string, reason: "startup" | "discovery"): DoctorCheck => {
      const configured = identities.status(target.profile, target.upstreamName);
      if (configured.status === "unconfigured") {
        return identityCheck(
          "skipped",
          targetText,
          `Identity verification was skipped because ${reason === "startup" ? "upstream startup" : "tool discovery"} did not complete.`,
          `Resolve the ${reason === "startup" ? "startup" : "tool discovery"} check before retrying doctor.`
        );
      }
      const required = identityRequired(target);
      return identityCheck(
        required ? "error" : "warning",
        targetText,
        required
          ? "Required upstream identity verification could not complete."
          : "Optional upstream identity verification could not complete.",
        "Review the configured expected fingerprint and identity probe before relying on risky operations."
      );
    };
    const probeTarget = async (target: DoctorTarget): Promise<void> => {
      const targetText = targetLabel(target);
      if (target.upstream.transport === "stdio") {
        const available = await isExecutableAvailable(
          target.upstream.command,
          pathForTarget(runtime.config, target),
          effectiveTargetOptions(runtime.config, target).cwd
        );
        checks.push(
          check(
            DOCTOR_CODES.EXECUTABLE,
            available ? "pass" : "error",
            targetText,
            available
              ? "The configured executable is available."
              : "The configured executable is not available.",
            available ? noAction() : "Install or correct the executable before starting the wrapper."
          )
        );
      } else {
        checks.push(
          check(
            DOCTOR_CODES.EXECUTABLE,
            "skipped",
            targetText,
            "Executable availability does not apply to this transport.",
            "Startup will verify remote connectivity."
          )
        );
      }

      let session: UpstreamSession;
      try {
        session = await runtime.manager.get(target.profile, target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.STARTUP,
            "pass",
            targetText,
            "Upstream startup and initialization completed.",
            noAction()
          )
        );
      } catch {
        incompleteProfiles.add(target.profile);
        checks.push(
          check(
            DOCTOR_CODES.STARTUP,
            "error",
            targetText,
            "Upstream startup or initialization did not complete.",
            "Correct upstream availability or configuration before retrying doctor."
          ),
          skippedDiscoveryCheck(DOCTOR_CODES.TOOLS_DISCOVERY, targetText, "Tool"),
          unavailableIdentityCheck(target, targetText, "startup"),
          skippedDiscoveryCheck(DOCTOR_CODES.RESOURCES_DISCOVERY, targetText, "Resource"),
          skippedDiscoveryCheck(DOCTOR_CODES.PROMPTS_DISCOVERY, targetText, "Prompt")
        );
        return;
      }

      let discoveryCompleted = false;
      try {
        const result = await listTools(session);
        runtime.manager.recordCapabilitySuccess(target.profile, "tools", target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.TOOLS_DISCOVERY,
            result.truncated ? "warning" : "pass",
            targetText,
            result.truncated
              ? "Tool discovery returned a cursor. Additional tool pages are not currently exposed by the wrapper."
              : `Tool discovery completed with ${result.tools.length} item(s).`,
            result.truncated
              ? "Use only the currently exposed tools until the wrapper supports additional tool pages."
              : noAction()
          )
        );
        const fingerprints = visibleTools.get(target.profile) ?? new Map<string, string>();
        visibleTools.set(target.profile, fingerprints);
        if (recordCollision(checks, target, fingerprints, result.tools, runtime.config.tooling?.collisionStrategy)) {
          incompleteProfiles.add(target.profile);
        }
        discoveryCompleted = true;
      } catch (error) {
        incompleteProfiles.add(target.profile);
        runtime.manager.recordCapabilityFailure(target.profile, "tools", error, target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.TOOLS_DISCOVERY,
            discoveryFailureStatus,
            targetText,
            "Tool discovery did not complete.",
            "Review upstream tool discovery before relying on this profile."
          ),
          unavailableIdentityCheck(target, targetText, "discovery")
        );
      }

      if (discoveryCompleted) {
        try {
          const configuredIdentity = identities.status(target.profile, target.upstreamName);
          if (configuredIdentity.status === "unconfigured") {
            checks.push(
              identityCheck(
                "skipped",
                targetText,
                "No upstream identity verification is configured.",
                "Configure profile identity verification to validate risky operations."
              )
            );
          } else {
            const identity = await identities.verify(target.profile, target.upstreamName, session);
            const required = identityRequired(target);
            checks.push(
              identity.status === "verified"
                ? identityCheck(
                    "pass",
                    targetText,
                    "Configured upstream identity verification completed.",
                    noAction()
                  )
                : identityCheck(
                    required ? "error" : "warning",
                    targetText,
                    "Configured upstream identity verification did not complete.",
                    "Review the configured expected fingerprint and identity probe before relying on risky operations."
                  )
            );
          }
        } catch {
          checks.push(unavailableIdentityCheck(target, targetText, "discovery"));
        }
      }

      try {
        const result = await listResources(session);
        runtime.manager.recordCapabilitySuccess(target.profile, "resources", target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.RESOURCES_DISCOVERY,
            result.truncated ? "warning" : "pass",
            targetText,
            result.truncated
              ? "Resource discovery reached the bounded page limit."
              : `Resource discovery completed with ${result.count} item(s).`,
            result.truncated ? "Reduce resource pages or verify the upstream cursor." : noAction()
          )
        );
      } catch (error) {
        runtime.manager.recordCapabilityFailure(target.profile, "resources", error, target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.RESOURCES_DISCOVERY,
            discoveryFailureStatus,
            targetText,
            "Resource discovery did not complete.",
            "Review upstream resource discovery before relying on this capability."
          )
        );
      }

      try {
        const result = await listPrompts(session);
        runtime.manager.recordCapabilitySuccess(target.profile, "prompts", target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.PROMPTS_DISCOVERY,
            result.truncated ? "warning" : "pass",
            targetText,
            result.truncated
              ? "Prompt discovery reached the bounded page limit."
              : `Prompt discovery completed with ${result.count} item(s).`,
            result.truncated ? "Reduce prompt pages or verify the upstream cursor." : noAction()
          )
        );
      } catch (error) {
        runtime.manager.recordCapabilityFailure(target.profile, "prompts", error, target.upstreamName);
        checks.push(
          check(
            DOCTOR_CODES.PROMPTS_DISCOVERY,
            discoveryFailureStatus,
            targetText,
            "Prompt discovery did not complete.",
            "Review upstream prompt discovery before relying on this capability."
          )
        );
      }
    };

    for (const [profileIndex, profile] of Object.keys(runtime.config.profiles).sort().entries()) {
      try {
        for (const target of targets) {
          if (target.profile === profile) await probeTarget(target);
        }
      } finally {
        let closed = false;
        try {
          await runtime.manager.closeProfile(profile);
          const health = runtime.manager.listHealth().filter((entry) => entry.profile === profile);
          closed =
            health.length > 0 &&
            health.every(
              (entry) =>
                entry.processState === "stopped" &&
                entry.pid == null &&
                entry.lastStopReason !== "shutdown-timeout" &&
                entry.lastStopReason !== "shutdown-error"
            );
        } catch {
          // The safe failure below records an unsuccessful per-profile shutdown.
        }
        if (!closed) {
          checks.push(
            check(
              DOCTOR_CODES.CLEAN_SHUTDOWN,
              "error",
              `profile ${profileIndex + 1}`,
              "Upstream profile shutdown did not complete cleanly.",
              "Stop remaining upstream processes before starting the wrapper."
            )
          );
        }
      }
    }

    addSchemaDifferenceCheck(checks, runtime.config, visibleTools, incompleteProfiles);
  } finally {
    try {
      await runtime.manager.close();
      const closed = runtime.manager
        .listHealth()
        .every(
          (health) =>
            health.processState === "stopped" &&
            health.pid == null &&
            health.lastStopReason !== "shutdown-timeout" &&
            health.lastStopReason !== "shutdown-error"
        );
      checks.push(
        check(
          DOCTOR_CODES.CLEAN_SHUTDOWN,
          closed ? "pass" : "error",
          "upstream manager",
          closed ? "Upstream processes shut down cleanly." : "Upstream processes did not shut down cleanly.",
          closed ? noAction() : "Stop remaining upstream processes before starting the wrapper."
        )
      );
    } catch {
      checks.push(
        check(
          DOCTOR_CODES.CLEAN_SHUTDOWN,
          "error",
          "upstream manager",
          "Upstream manager shutdown did not complete.",
          "Stop remaining upstream processes before starting the wrapper."
        )
      );
    }
  }

  return normalizeDoctorReport(checks);
}

import { readFile } from "node:fs/promises";

interface DiagnosticCapabilityHealth {
  readonly state: string;
  readonly lastTransition: string;
  readonly error?: string;
}

interface DiagnosticUpstreamHealth {
  readonly profile: string;
  readonly upstreamName: string;
  readonly status?: string;
  readonly state: string;
  readonly processState: string;
  readonly lastTransition?: string;
  readonly restartCount: number;
  readonly lastStopReason?: string;
  readonly restartLimitReached?: boolean;
  readonly error?: string;
  readonly capabilities: Record<string, DiagnosticCapabilityHealth>;
}

/** Counts fixture process entries without reporting any fixture output. */
export async function countFixtureStarts(path: string): Promise<number> {
  const contents = await readFile(path, "utf8");
  return contents.split("\n").filter(Boolean).length;
}

/** Restricts failure diagnostics to lifecycle metadata that cannot contain upstream output or secrets. */
export function summarizeUpstreamHealth(health: readonly DiagnosticUpstreamHealth[]): Array<Record<string, unknown>> {
  return health.map((entry) => ({
    profile: entry.profile,
    upstreamName: entry.upstreamName,
    state: entry.state,
    processState: entry.processState,
    restartCount: entry.restartCount,
    lastStopReason: entry.lastStopReason,
    restartLimitReached: entry.restartLimitReached,
    capabilities: Object.fromEntries(
      Object.entries(entry.capabilities).map(([capability, capabilityHealth]) => [capability, capabilityHealth.state])
    )
  }));
}

/** Keeps the original test failure in Error.cause while emitting a safe, allowlisted diagnostic message. */
export function diagnosticFailure(message: string, details: Record<string, unknown>, cause: unknown): Error {
  return new Error(`${message}: ${JSON.stringify(details)}`, { cause });
}

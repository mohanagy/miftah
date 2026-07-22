import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countFixtureStarts, diagnosticFailure, summarizeUpstreamHealth } from "./upstream-diagnostics.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("upstream test diagnostics", () => {
  it("counts fixture starts and emits only the safe health fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-upstream-diagnostics-"));
    directories.push(directory);
    const starts = join(directory, "starts");
    await writeFile(starts, "one\n\ntwo\n");

    await expect(countFixtureStarts(starts)).resolves.toBe(2);
    expect(
      summarizeUpstreamHealth([
        {
          profile: "work",
          upstreamName: "remote",
          state: "failed",
          processState: "failed",
          restartCount: 1,
          lastStopReason: "shutdown-timeout",
          restartLimitReached: false,
          capabilities: {
            tools: { state: "failed", lastTransition: "2026-01-01T00:00:00.000Z", error: "sensitive tool failure" },
            resources: { state: "unknown", lastTransition: "2026-01-01T00:00:00.000Z" },
            prompts: { state: "available", lastTransition: "2026-01-01T00:00:00.000Z" }
          },
          status: "failed",
          lastTransition: "2026-01-01T00:00:00.000Z",
          error: "sensitive manager error"
        }
      ])
    ).toEqual([
      {
        profile: "work",
        upstreamName: "remote",
        state: "failed",
        processState: "failed",
        restartCount: 1,
        lastStopReason: "shutdown-timeout",
        restartLimitReached: false,
        capabilities: { tools: "failed", resources: "unknown", prompts: "available" }
      }
    ]);
  });

  it("keeps a captured failure as the cause without putting it in the safe diagnostic message", () => {
    const cause = new Error("sensitive upstream failure");
    const error = diagnosticFailure("Upstream marker diagnostic", { startDelta: 0 }, cause);

    expect(error.message).toBe('Upstream marker diagnostic: {"startDelta":0}');
    expect(error.message).not.toContain("sensitive upstream failure");
    expect(error.cause).toBe(cause);
  });
});

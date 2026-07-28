import { beforeEach, describe, expect, it, vi } from "vitest";

const profileReadinessMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../src/setup/profile-readiness.js", () => ({
  runProfileReadiness: profileReadinessMocks.run
}));

import { runProfileReadinessCommand } from "../src/cli/profile-readiness-command.js";

describe("profile readiness command", () => {
  beforeEach(() => {
    profileReadinessMocks.run.mockReset();
  });

  it("uses one explicitly selected profile and returns the redacted ready report", async () => {
    const report = {
      status: "ready" as const,
      profile: "google-personal",
      upstream: "default",
      adapter: "Google Search Console",
      safeRead: { status: "passed" as const, tool: "get_capabilities" },
      identity: { status: "unavailable" as const }
    };
    profileReadinessMocks.run.mockResolvedValue(report);

    await expect(runProfileReadinessCommand({
      configPath: "/Users/example/.config/miftah/gsc.json",
      profile: "google-personal",
      upstream: "default"
    })).resolves.toEqual({ report, exitCode: 0 });
    expect(profileReadinessMocks.run).toHaveBeenCalledWith(
      "/Users/example/.config/miftah/gsc.json",
      { profile: "google-personal", upstream: "default" }
    );
  });

  it("returns a nonzero result for a supported command whose selected profile is not ready", async () => {
    const report = {
      status: "blocked" as const,
      profile: "google-personal",
      upstream: "default",
      adapter: "Google Search Console",
      safeRead: { status: "blocked" as const, tool: "get_capabilities", errorCode: "POLICY_BLOCKED" },
      identity: { status: "not-checked" as const }
    };
    profileReadinessMocks.run.mockResolvedValue(report);

    await expect(runProfileReadinessCommand({
      configPath: "/Users/example/.config/miftah/gsc.json",
      profile: "google-personal"
    })).resolves.toEqual({ report, exitCode: 1 });
    expect(profileReadinessMocks.run).toHaveBeenCalledWith(
      "/Users/example/.config/miftah/gsc.json",
      { profile: "google-personal" }
    );
  });
});

import { describe, expect, it } from "vitest";
import { createSetupCompletion } from "../src/setup/setup-completion.js";

describe("setup completion", () => {
  it("gives an unreviewed generic setup a truthful manual handoff without inventing a probe", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "not-declared",
      clientHandoff: "not-generated",
      configPath: "/Users/example/.config/miftah/support.json"
    })).toEqual({
      verification: {
        state: "not-declared",
        message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
      },
      clientHandoff: {
        state: "not-generated",
        message:
          "Next: generate a copy-only client snippet with 'miftah connection list --config /Users/example/.config/miftah/support.json --client claude-desktop', review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("gives a skipped reviewed provider profile an explicit later retest without claiming success", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "skipped",
      clientHandoff: "shown",
      profile: "google-work",
      configPath: "/Users/example/.config/miftah/gsc.json"
    })).toEqual({
      verification: {
        state: "skipped",
        message: "The reviewed safe check was skipped. The configuration is saved but not yet verified.",
        nextAction: "When ready, run 'miftah profile test --config /Users/example/.config/miftah/gsc.json --profile google-work'."
      },
      clientHandoff: {
        state: "shown",
        message:
          "Next: review the client JSON above, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("keeps Console client adoption explicitly manual while exposing a reviewed check when one is available", () => {
    expect(createSetupCompletion({
      surface: "console",
      verification: "available",
      clientHandoff: "available"
    })).toEqual({
      verification: {
        state: "available",
        message: "A provider-declared read-only check is available, but it has not run yet."
      },
      clientHandoff: {
        state: "available",
        message:
          "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("does not deny declared OAuth metadata discovery while browser authorization remains pending", () => {
    expect(createSetupCompletion({
      surface: "console",
      verification: "authorization-pending",
      clientHandoff: "available"
    }).verification).toEqual({
      state: "authorization-pending",
      message: "No browser authorization completed during setup. Connect later to begin the provider's authorization flow."
    });
  });

  it("quotes a published CLI config path when it contains whitespace", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "not-declared",
      clientHandoff: "not-generated",
      configPath: "/Users/example/Miftah configs/support.json"
    }).clientHandoff.message).toContain(
      "miftah connection list --config \"/Users/example/Miftah configs/support.json\" --client claude-desktop"
    );
  });
});

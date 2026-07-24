import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogIssueEntry } from "./helpers/changelog.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const cli = readFileSync(new URL("../docs/cli.md", import.meta.url), "utf8");
const security = readFileSync(new URL("../docs/security.md", import.meta.url), "utf8");
const presets = readFileSync(new URL("../docs/presets-and-clients.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

describe("Windows stdio launch documentation", () => {
  it("explains why npx-backed presets are unavailable instead of silently using cmd.exe", () => {
    expect(readme).toContain("On Windows, `generic`, `sentry`, and `generic-npx` are unavailable.");
    expect(readme).toContain("Miftah refuses them instead of invoking `cmd.exe`.");
    expect(cli).toContain("On Windows, `generic`, `sentry`, and `generic-npx` are unavailable because npm's `npx` runner requires a command shell.");
    expect(cli).toContain("On Windows, `--preset` is required for noninteractive `init`; there is no implicit generic preset.");
    expect(security).toContain("Windows STDIO upstreams are resolved before the MCP SDK starts a child process.");
    expect(presets).toContain("the `generic`, `sentry`, and `generic-npx` npx-backed presets are refused rather than launched through a command shell");
  });

  it("records the fail-closed Windows launch boundary under issue #217", () => {
    expect(changelogIssueEntry(changelog, 217)).toContain("Windows STDIO");
    expect(changelogIssueEntry(changelog, 217)).toContain("cmd.exe");
  });
});

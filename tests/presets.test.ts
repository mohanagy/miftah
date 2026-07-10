import { describe, expect, it } from "vitest";
import { presetConfig } from "../src/config/presets.js";

describe("preset config", () => {
  it("generates a pinned, token-forwarding GitHub Docker preset with profile-specific env refs", () => {
    const config = presetConfig("github", "github");

    expect(config.upstream).toBeDefined();
    expect(config.upstream?.command).toBe("docker");
    expect(config.upstream?.args).toEqual(
      expect.arrayContaining(["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:v1.1.0"])
    );

    expect(config.defaultProfile).toBe("work");
    expect(config.profiles.work?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("${GITHUB_WORK_TOKEN}");
    expect(config.profiles.personal?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("${GITHUB_PERSONAL_TOKEN}");

    const refs = [
      config.profiles.work?.env?.GITHUB_PERSONAL_ACCESS_TOKEN,
      config.profiles.personal?.env?.GITHUB_PERSONAL_ACCESS_TOKEN
    ];
    expect(refs.every((value) => typeof value === "string" && value.startsWith("${") && value.endsWith("}"))).toBe(true);
  });
});

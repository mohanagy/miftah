import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

describe("fake upstream fixture", () => {
  it("identifies malformed tool annotations without echoing the invalid value", () => {
    const result = spawnSync(process.execPath, [fixture], {
      env: { ...process.env, TEST_CREATE_ITEM_ANNOTATIONS: "{not-json" },
      encoding: "utf8",
      timeout: 5_000
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TEST_CREATE_ITEM_ANNOTATIONS must contain valid JSON");
    expect(result.stderr).not.toContain("{not-json");
  });
});

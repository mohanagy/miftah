import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { expandEnvironmentReferences } from "../src/config/env-expand.js";
import { MiftahError } from "../src/utils/errors.js";

describe("config foundation", () => {
  it("accepts a valid wrapper and expands profile environment references", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: {
        work: {
          description: "Work GitHub",
          env: { API_TOKEN: "${WORK_TOKEN}", ACCOUNT: "work" }
        }
      }
    });

    expect(
      expandEnvironmentReferences(config.profiles.work!.env!, { WORK_TOKEN: "secret-value" })
    ).toEqual({ API_TOKEN: "secret-value", ACCOUNT: "work" });
  });

  it("rejects a config whose default profile does not exist", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "missing",
        upstream: { transport: "stdio", command: "node" },
        profiles: { work: {} }
      })
    ).toThrow(/DEFAULT_PROFILE_NOT_FOUND/);
  });

  it("reports missing environment references without exposing values", () => {
    expect(() =>
      expandEnvironmentReferences({ API_TOKEN: "${MISSING_TOKEN}" }, {})
    ).toThrow(/MISSING_TOKEN/);
  });

  it("rejects profiles that reference unknown named policies", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node" },
        policies: {
          readonly: { allowRisk: ["read"] }
        },
        profiles: {
          work: { policy: "missing-policy" }
        }
      })
    ).toThrow(/POLICY_NOT_FOUND/);
  });

  it("does not derive the error code from user-controlled policy names", () => {
    let thrown: unknown;

    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node" },
        profiles: {
          work: { policy: "DEFAULT_PROFILE_NOT_FOUND" }
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    expect(thrown).toMatchObject({ code: "POLICY_NOT_FOUND" });
  });
});

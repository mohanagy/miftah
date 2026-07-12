import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/config/validate-config.js";
import { IdentityManager } from "../src/identity/identity-manager.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const managers: UpstreamProcessManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

describe("identity verifier", () => {
  it("verifies a configured text identity and exposes only its allowlisted fingerprint", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "mona" },
          identity: {
            expected: { provider: "github", login: "mona" },
            probe: { tool: "whoami", resultFormat: "text", provider: "github" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);
    const session = await upstreams.get("work");

    const result = await verifier.verify("work", undefined, session);

    expect(result).toMatchObject({
      status: "verified",
      profile: "work",
      upstream: "default",
      expected: { provider: "github", login: "mona" },
      actual: { provider: "github", login: "mona" },
      verifiedAt: expect.any(String)
    });
    expect(JSON.stringify(result)).not.toContain("TEST_ACCOUNT_NAME");
    expect(verifier.status("work", undefined)).toMatchObject({ status: "verified", actual: { login: "mona" } });
  });

  it("returns a safe verification failure when the probe tool reports an MCP error", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_RETURN_CALL_TOOL_ERROR: "true" },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({ status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain("test tool returned an error result");
  });

  it("returns a safe verification failure when identity probe discovery fails", async () => {
    const secret = "identity-discovery-secret";
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_FAIL_LIST_TOOLS: "true", API_TOKEN: secret },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({ status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not invoke a probe that declares required input", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".miftah-identity-required-input-"));
    const countPath = join(directory, "probe-count");
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_WHOAMI_SCHEMA: "account", TEST_CALL_TOOL_COUNT_PATH: countPath },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    try {
      const result = await verifier.verify("work", undefined, await upstreams.get("work"));

      expect(result).toMatchObject({ status: "unsupported", errorCode: "IDENTITY_PROBE_UNSUPPORTED" });
      await expect(readFile(countPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when a probe declares malformed required input", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_WHOAMI_SCHEMA: "malformed-required", API_TOKEN: "schema-secret" },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({ status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain("schema-secret");
  });

  it.each(["min-properties", "all-of-required"] as const)(
    "does not invoke an identity probe whose %s schema rejects an empty object",
    async (schema) => {
      const directory = await mkdtemp(join(process.cwd(), ".miftah-identity-probe-schema-"));
      const countPath = join(directory, "probe-count");
      const config = validateConfig({
        version: "1",
        name: "identity-test",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
        profiles: {
          work: {
            env: {
              TEST_INCLUDE_IDENTITY_TOOL: "true",
              TEST_IDENTITY_SCHEMA: schema,
              TEST_CALL_TOOL_COUNT_PATH: countPath
            },
            identity: {
              expected: { login: "mona" },
              probe: { tool: "identity", resultFormat: "json" },
              maxAgeMs: 60_000
            }
          }
        },
        tooling: { toolRiskOverrides: { identity: "read" } }
      });
      const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
      managers.push(upstreams);
      const verifier = new IdentityManager(config);

      try {
        const result = await verifier.verify("work", undefined, await upstreams.get("work"));

        expect(result).toMatchObject({ status: "unsupported", errorCode: "IDENTITY_PROBE_UNSUPPORTED" });
        await expect(readFile(countPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  it("verifies an identity probe with additionalProperties false exactly once", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".miftah-identity-additional-properties-"));
    const countPath = join(directory, "probe-count");
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "mona",
            TEST_INCLUDE_IDENTITY_TOOL: "true",
            TEST_IDENTITY_SCHEMA: "additional-properties-false",
            TEST_CALL_TOOL_COUNT_PATH: countPath
          },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "identity", resultFormat: "json" },
            maxAgeMs: 60_000
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    try {
      const result = await verifier.verify("work", undefined, await upstreams.get("work"));

      expect(result).toMatchObject({ status: "verified", actual: { login: "mona" } });
      expect(await readFile(countPath, "utf8")).toBe("1\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["text", "json"] as const)("fails safely for an oversized %s probe response", async (resultFormat) => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "mona",
            TEST_OVERSIZED_IDENTITY_RESPONSE_REPEAT: "300",
            ...(resultFormat === "json" ? { TEST_INCLUDE_IDENTITY_TOOL: "true" } : {})
          },
          identity: {
            expected: { login: "mona" },
            probe: { tool: resultFormat === "text" ? "whoami" : "identity", resultFormat },
            maxAgeMs: 60_000
          }
        }
      },
      ...(resultFormat === "json" ? { tooling: { toolRiskOverrides: { identity: "read" } } } : {})
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({ status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain("identity-response-secret");
  });

  it("fails safely when a whitespace-padded text response exceeds the raw response limit", async () => {
    const padding = " ".repeat(4_096);
    const response = `${padding}mona`;
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: response },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({ status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" });
    expect(JSON.stringify(result)).not.toContain(padding);
  });

  it("turns an expected-versus-actual mismatch into a typed blocking error", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "personal" },
          identity: {
            expected: { provider: "github", login: "mona" },
            probe: { tool: "whoami", resultFormat: "text", provider: "github" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);
    const session = await upstreams.get("work");

    await expect(verifier.requireVerified("work", undefined, session)).rejects.toMatchObject({
      code: "IDENTITY_MISMATCH",
      details: {
        profile: "work",
        upstream: "default",
        expected: { provider: "github", login: "mona" },
        actual: { provider: "github", login: "personal" }
      }
    });
  });

  it("reuses a fresh verification result without calling the identity probe again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-cache-"));
    const countPath = join(directory, "probe-count");
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "mona", TEST_CALL_TOOL_COUNT_PATH: countPath },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);
    const session = await upstreams.get("work");

    try {
      await verifier.verify("work", undefined, session);
      await verifier.verify("work", undefined, session);

      await expect(readFile(countPath, "utf8")).resolves.toBe("1\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("re-verifies identity after an upstream session restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-restart-"));
    const countPath = join(directory, "probe-count");
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "mona", TEST_CALL_TOOL_COUNT_PATH: countPath },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    try {
      await verifier.verify("work", undefined, await upstreams.get("work"));
      await verifier.verify("work", undefined, await upstreams.restart("work"));

      await expect(readFile(countPath, "utf8")).resolves.toBe("1\n1\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("coalesces concurrent verification requests for one live session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-concurrent-"));
    const countPath = join(directory, "probe-count");
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "mona",
            TEST_LIST_TOOLS_DELAY_MS: "50",
            TEST_CALL_TOOL_COUNT_PATH: countPath
          },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);
    const session = await upstreams.get("work");

    try {
      const results = await Promise.all([
        verifier.verify("work", undefined, session),
        verifier.verify("work", undefined, session)
      ]);

      expect(results.map((result) => result.status)).toEqual(["verified", "verified"]);
      await expect(readFile(countPath, "utf8")).resolves.toBe("1\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not reuse a colliding named profile and upstream identity result", async () => {
    const firstProfile = "a";
    const firstUpstream = "b\u0000c";
    const secondProfile = "a\u0000b";
    const secondUpstream = "c";
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: firstProfile,
      upstreams: {
        [firstUpstream]: { transport: "stdio", command: process.execPath, args: [fixture] },
        [secondUpstream]: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        [firstProfile]: {
          upstreams: {
            [firstUpstream]: {
              env: { TEST_ACCOUNT_NAME: "matching" },
              identity: {
                expected: { login: "matching" },
                probe: { tool: "whoami", resultFormat: "text" },
                maxAgeMs: 60_000
              }
            }
          }
        },
        [secondProfile]: {
          upstreams: {
            [secondUpstream]: {
              env: { TEST_ACCOUNT_NAME: "wrong" },
              identity: {
                expected: { login: "expected" },
                probe: { tool: "whoami", resultFormat: "text" },
                maxAgeMs: 60_000
              }
            }
          }
        }
      }
    });
    const upstreams = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const verifier = new IdentityManager(config);

    try {
      await expect(
        verifier.verify(firstProfile, firstUpstream, await upstreams.get(firstProfile, firstUpstream))
      ).resolves.toMatchObject({ status: "verified", actual: { login: "matching" } });
      await expect(
        verifier.verify(secondProfile, secondUpstream, await upstreams.get(secondProfile, secondUpstream))
      ).resolves.toMatchObject({
        status: "mismatch",
        expected: { login: "expected" },
        actual: { login: "wrong" },
        errorCode: "IDENTITY_MISMATCH"
      });
    } finally {
      await upstreams.close();
    }
  });

  it("does not reuse an omitted upstream result for a named default upstream", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".miftah-identity-default-upstream-"));
    const countPath = join(directory, "probe-count");
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstreams: {
        default: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          identity: {
            expected: { login: "base-account" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          },
          upstreams: {
            default: {
              env: { TEST_ACCOUNT_NAME: "named-account", TEST_CALL_TOOL_COUNT_PATH: countPath },
              identity: {
                expected: { login: "named-account" },
                probe: { tool: "whoami", resultFormat: "text" },
                maxAgeMs: 60_000
              }
            }
          }
        }
      }
    });
    const upstreams = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const verifier = new IdentityManager(config);

    try {
      await expect(verifier.verify("work", undefined, await upstreams.get("work"))).resolves.toMatchObject({
        status: "mismatch",
        expected: { login: "base-account" },
        actual: { login: "named-account" }
      });
      await expect(verifier.verify("work", "default", await upstreams.get("work", "default"))).resolves.toMatchObject({
        status: "verified",
        expected: { login: "named-account" },
        actual: { login: "named-account" }
      });
      await expect(readFile(countPath, "utf8")).resolves.toBe("1\n1\n");
    } finally {
      await upstreams.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports a cached matching identity as expired after its configured TTL", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "mona" },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 1
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    await verifier.verify("work", undefined, await upstreams.get("work"));
    await delay(20);

    expect(verifier.status("work", undefined)).toMatchObject({
      status: "expired",
      actual: { login: "mona" }
    });
  });

  it("expires a verified identity when the parent clock rolls back", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "mona" },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000
          }
        }
      }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));
    expect(result).toMatchObject({ status: "verified", verifiedAt: expect.any(String) });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(result.verifiedAt!) - 1);
    try {
      expect(verifier.status("work", undefined)).toMatchObject({ status: "expired", actual: { login: "mona" } });
    } finally {
      clock.mockRestore();
    }
  });

  it("accepts only allowlisted fields from a JSON identity probe", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_INCLUDE_IDENTITY_TOOL: "true",
            TEST_IDENTITY_RESPONSE: JSON.stringify({
              provider: "github",
              login: "mona",
              organization: "octo",
              host: "github.com",
              token: "must-not-be-retained",
              nested: { secret: "must-not-be-retained" }
            })
          },
          identity: {
            expected: {
              provider: "github",
              login: "mona",
              organization: "octo",
              host: "github.com"
            },
            probe: { tool: "identity", resultFormat: "json" },
            maxAgeMs: 60_000
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({
      status: "verified",
      actual: { provider: "github", login: "mona", organization: "octo", host: "github.com" }
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
  });

  it("retains only configured expected fields from a JSON identity response", async () => {
    const config = validateConfig({
      version: "1",
      name: "identity-test",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_INCLUDE_IDENTITY_TOOL: "true",
            TEST_IDENTITY_RESPONSE: JSON.stringify({ login: "mona", organization: "must-not-be-retained" })
          },
          identity: {
            expected: { login: "mona" },
            probe: { tool: "identity", resultFormat: "json" },
            maxAgeMs: 60_000
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles);
    managers.push(upstreams);
    const verifier = new IdentityManager(config);

    const result = await verifier.verify("work", undefined, await upstreams.get("work"));

    expect(result).toMatchObject({ status: "verified", actual: { login: "mona" } });
    expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildPresetConfig,
  PRESET_CATALOG,
  PresetCatalogError
} from "../src/config/presets.js";
import type { PresetBuildOptions } from "../src/config/presets.js";
import { validateConfig } from "../src/config/validate-config.js";

function serializedConfig(config: unknown): string {
  return JSON.stringify(config);
}

describe("preset catalog", () => {
  it("publishes one versioned catalog with inspectable preset requirements", () => {
    expect(PRESET_CATALOG.version).toBe("1");
    expect(Object.keys(PRESET_CATALOG.presets)).toEqual([
      "generic",
      "github",
      "sentry",
      "generic-npx",
      "generic-docker",
      "streamable-http"
    ]);
    expect(PRESET_CATALOG.presets["generic-npx"].requirements.npmPackage).toBe("required");
    expect(PRESET_CATALOG.presets["generic-docker"].requirements.dockerImage).toBe("required");
    expect(PRESET_CATALOG.presets["streamable-http"].requirements.url).toBe("required");
  });

  it("builds every catalog config as a valid strict Miftah config without literal secrets", () => {
    const literalSecret = "literal-secret-that-must-not-appear";
    const genericOptions = { credentialEnv: "GENERIC_TOKEN", secret: literalSecret };
    const configs = [
      buildPresetConfig("generic", "generic", genericOptions),
      buildPresetConfig("github", "github"),
      buildPresetConfig("sentry", "sentry"),
      buildPresetConfig("npx", "generic-npx", {
        npmPackage: "@scope/server@1.2.3",
        credentialEnv: "NPM_SERVER_TOKEN"
      }),
      buildPresetConfig("docker", "generic-docker", {
        dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        credentialEnv: "DOCKER_SERVER_TOKEN"
      }),
      buildPresetConfig("remote", "streamable-http", {
        url: "https://mcp.example.com/v1",
        credentialEnv: "REMOTE_TOKEN",
        headerName: "Authorization",
        headerPrefix: "Bearer "
      })
    ];

    for (const config of configs) {
      expect(() => validateConfig(config)).not.toThrow();
      expect(serializedConfig(config)).not.toContain(literalSecret);
    }
  });

  it("builds exact provider contracts with only environment secret references", () => {
    const generic = buildPresetConfig("generic", "generic");
    const github = buildPresetConfig("github", "github");
    const sentry = buildPresetConfig("sentry", "sentry");

    expect(generic.upstream?.args).toEqual(["--yes", "@modelcontextprotocol/server-everything@2026.7.4", "stdio"]);
    expect(github.upstream?.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server:v1.5.0",
      "stdio",
      "--read-only",
      "--toolsets=repos,issues,pull_requests"
    ]);
    expect(github.profiles).toMatchObject({
      work: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_WORK_TOKEN}" }, policy: "readonly" },
      personal: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_TOKEN}" }, policy: "readonly" }
    });
    expect(sentry.upstream?.args).toEqual(["--yes", "@sentry/mcp-server@0.36.0", "--skills=inspect"]);
    expect(sentry.profiles.default).toMatchObject({
      env: { SENTRY_ACCESS_TOKEN: "${SENTRY_ACCESS_TOKEN}" },
      policy: "readonly"
    });
  });

  it("requires and validates exact generic preset inputs", () => {
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@1.2.3" })).not.toThrow();
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "@scope/server@1.2.3" })).not.toThrow();
    expect(buildPresetConfig("npx", "generic-npx", { npmPackage: "@sentry/mcp-server@0.36.0" }).upstream?.args).toEqual([
      "--yes",
      "@sentry/mcp-server@0.36.0"
    ]);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@latest" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@^1.2.3" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("docker", "generic-docker", { dockerImage: "ghcr.io/acme/server:latest" })).toThrow(
      PresetCatalogError
    );
    const dockerImage = "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const docker = buildPresetConfig("docker", "generic-docker", {
      dockerImage,
      credentialEnv: "DOCKER_SERVER_TOKEN"
    });
    expect(docker.upstream?.args).toEqual(["run", "-i", "--rm", "-e", "DOCKER_SERVER_TOKEN", dockerImage, "stdio"]);
    expect(() => buildPresetConfig("docker", "generic-docker", {
      dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    })).not.toThrow();
  });

  it("accepts only safe streamable HTTP credential header inputs", () => {
    const config = buildPresetConfig("remote", "streamable-http", {
      url: "https://mcp.example.com/v1",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix: "Bearer "
    });

    expect(config.upstream).toMatchObject({
      transport: "streamable-http",
      url: "https://mcp.example.com/v1",
      headers: { Authorization: "Bearer ${REMOTE_TOKEN}" }
    });
    expect(() => buildPresetConfig("remote", "streamable-http", { url: "http://mcp.example.com" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", { url: "https://user@example.com" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", { url: "https://example.com/?q=1" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", { url: "https://example.com/#fragment" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", {
      url: "https://example.com",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Bad Header",
      headerPrefix: "Bearer "
    })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", {
      url: "https://example.com",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix: "Bearer ${INJECTED}"
    })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", {
      url: "https://example.com",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix: "Bearer\r\nX-Injected: yes"
    })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("remote", "streamable-http", {
      url: "https://example.com",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix: "Bearer\u0000"
    })).toThrow(PresetCatalogError);
  });

  it.each([
    ["Bearer ", "Bearer ${REMOTE_TOKEN}"],
    ["Sentry ", "Sentry ${REMOTE_TOKEN}"]
  ])("constructs an Authorization header from the supported %s auth scheme", (headerPrefix, expectedHeader) => {
    const config = buildPresetConfig("remote", "streamable-http", {
      url: "https://mcp.example.com/v1",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix
    });

    expect(config.upstream?.headers).toEqual({ Authorization: expectedHeader });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("uses no default scheme when a streamable HTTP header prefix is empty or omitted", () => {
    const emptyPrefix = buildPresetConfig("remote", "streamable-http", {
      url: "https://mcp.example.com/v1",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix: ""
    });
    const omittedPrefix = buildPresetConfig("remote", "streamable-http", {
      url: "https://mcp.example.com/v1",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization"
    });

    expect(emptyPrefix.upstream?.headers).toEqual({ Authorization: "${REMOTE_TOKEN}" });
    expect(omittedPrefix.upstream?.headers).toEqual({ Authorization: "${REMOTE_TOKEN}" });
    expect(() => validateConfig(emptyPrefix)).not.toThrow();
    expect(() => validateConfig(omittedPrefix)).not.toThrow();
  });

  it("rejects a literal credential followed by a space as a streamable HTTP header prefix", () => {
    expect(() => buildPresetConfig("remote", "streamable-http", {
      url: "https://mcp.example.com/v1",
      credentialEnv: "REMOTE_TOKEN",
      headerName: "Authorization",
      headerPrefix: "literal-secret-value "
    })).toThrow(PresetCatalogError);
  });

  it.each([
    ["generic", {}, ""],
    ["generic", {}, "INVALID-NAME"],
    ["generic-npx", { npmPackage: "server@1.2.3" }, ""],
    ["generic-npx", { npmPackage: "server@1.2.3" }, "INVALID-NAME"],
    [
      "generic-docker",
      { dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      ""
    ],
    [
      "generic-docker",
      { dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      "INVALID-NAME"
    ]
  ] as const)("rejects a supplied %s credential environment name of %j", (preset, options, credentialEnv) => {
    expect(() => buildPresetConfig("test", preset, { ...options, credentialEnv })).toThrow(PresetCatalogError);
  });

  it.each([
    ["generic", "credentialEnv", {}],
    ["generic-npx", "npmPackage", { npmPackage: "server@1.2.3" }],
    [
      "generic-docker",
      "dockerImage",
      { dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
    ],
    ["streamable-http", "url", { url: "https://mcp.example.com/v1" }],
    [
      "streamable-http",
      "headerName",
      { url: "https://mcp.example.com/v1", credentialEnv: "REMOTE_TOKEN", headerName: "Authorization" }
    ],
    [
      "streamable-http",
      "headerPrefix",
      { url: "https://mcp.example.com/v1", credentialEnv: "REMOTE_TOKEN", headerName: "Authorization" }
    ]
  ] as const)(
    "rejects a non-string %s option for %s presets before generating config",
    (preset, option, validOptions) => {
      for (const value of [null, true, {}, []]) {
        const options = { ...validOptions, [option]: value };
        expect(() => buildPresetConfig("test", preset, options as unknown as PresetBuildOptions)).toThrow(
          /must be a string/
        );
      }
    }
  );

  it("accepts explicitly undefined optional preset inputs", () => {
    expect(() => buildPresetConfig("generic", "generic", { credentialEnv: undefined })).not.toThrow();
    expect(() => buildPresetConfig("remote", "streamable-http", {
      url: "https://mcp.example.com/v1",
      credentialEnv: undefined,
      headerName: undefined,
      headerPrefix: undefined
    })).not.toThrow();
  });

  it("rejects unknown strict catalog presets with a clear typed error", () => {
    expect(() => buildPresetConfig("test", "unknown")).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("test", "unknown")).toThrow(/Unknown preset 'unknown'/);
    expect(() => buildPresetConfig("test", "toString")).toThrow(PresetCatalogError);
  });
});

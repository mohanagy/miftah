import { isAbsolute, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const gscClientSecretsFile = resolve("fixtures", "gsc", "client-secrets.json");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function localExecutable(): string {
  return process.platform === "win32" ? process.execPath : "node";
}

afterEach(() => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
});

describe("preset catalog", () => {
  it("publishes one versioned catalog with inspectable preset requirements", () => {
    expect(PRESET_CATALOG.version).toBe("3");
    expect(Object.keys(PRESET_CATALOG.presets)).toEqual([
      "generic",
      "github",
      "sentry",
      "google-search-console",
      "generic-npx",
      "generic-docker",
      "local-stdio",
      "streamable-http"
    ]);
    expect(PRESET_CATALOG.presets["generic-npx"].requirements.npmPackage).toBe("required");
    expect(PRESET_CATALOG.presets["generic-docker"].requirements.dockerImage).toBe("required");
    expect(PRESET_CATALOG.presets["local-stdio"].requirements.localCommand).toBe("required");
    expect(PRESET_CATALOG.presets["local-stdio"].requirements.acceptLocalCommand).toBe("required");
    expect(PRESET_CATALOG.presets["streamable-http"].requirements.url).toBe("required");
    expect(PRESET_CATALOG.presets["google-search-console"].requirements.oauthClientSecretsFile).toBe("required");
  });

  it("builds every catalog config as a valid strict Miftah config without literal secrets", () => {
    const genericOptions = { credentialEnv: "GENERIC_TOKEN" };
    const configs = [
      buildPresetConfig("github", "github"),
      buildPresetConfig("gsc", "google-search-console", {
        oauthClientSecretsFile: gscClientSecretsFile
      }),
      buildPresetConfig("docker", "generic-docker", {
        dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        credentialEnv: "DOCKER_SERVER_TOKEN"
      }),
      buildPresetConfig("local", "local-stdio", {
        localCommand: localExecutable(),
        args: ["server.mjs"],
        acceptLocalCommand: true,
        credentialEnv: "LOCAL_MCP_TOKEN"
      }),
      buildPresetConfig("remote", "streamable-http", {
        url: "https://mcp.example.com/v1",
        credentialEnv: "REMOTE_TOKEN",
        headerName: "Authorization",
        headerPrefix: "Bearer "
      }),
      ...(process.platform === "win32"
        ? []
        : [
            buildPresetConfig("generic", "generic", genericOptions),
            buildPresetConfig("sentry", "sentry"),
            buildPresetConfig("npx", "generic-npx", {
              npmPackage: "@scope/server@1.2.3",
              credentialEnv: "NPM_SERVER_TOKEN"
            })
          ])
    ];

    for (const config of configs) {
      expect(() => validateConfig(config)).not.toThrow();
      expect(serializedConfig(config)).not.toContain("literal-secret-that-must-not-appear");
    }
  });

  it("builds exact provider contracts with only environment secret references", () => {
    const github = buildPresetConfig("github", "github");

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

    if (process.platform === "win32") return;

    const generic = buildPresetConfig("generic", "generic");
    const sentry = buildPresetConfig("sentry", "sentry");
    expect(generic.upstream?.args).toEqual(["--yes", "@modelcontextprotocol/server-everything@2026.7.4", "stdio"]);
    expect(sentry.upstream?.args).toEqual(["--yes", "@sentry/mcp-server@0.36.0", "--skills=inspect"]);
    expect(sentry.profiles.default).toMatchObject({
      env: { SENTRY_ACCESS_TOKEN: "${SENTRY_ACCESS_TOKEN}" },
      policy: "readonly"
    });
  });

  it("builds the exact pinned GSC pilot without enabling destructive tools or Miftah native OAuth", () => {
    const config = buildPresetConfig("gsc", "google-search-console", {
      oauthClientSecretsFile: gscClientSecretsFile
    });

    expect(config.upstream).toEqual({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-search-console@0.3.2"]
    });
    expect(config.profiles.default).toMatchObject({
      description: "Google Search Console account (OAuth owned by upstream)",
      env: { GSC_OAUTH_CLIENT_SECRETS_FILE: gscClientSecretsFile },
      policy: "readonly"
    });
    expect(config.profiles.default?.env?.GSC_CONFIG_DIR).toSatisfy(
      (directory: unknown) => typeof directory === "string" && isAbsolute(directory)
    );
    expect(config).not.toHaveProperty("oauth");
    expect(config.profiles.default?.env).not.toHaveProperty("GSC_ALLOW_DESTRUCTIVE");
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("gives every named GSC account a separate upstream-owned OAuth state directory", () => {
    const config = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        {
          name: "google-govalidate",
          description: "GoValidate Google account",
          oauthClientSecretsFile: gscClientSecretsFile
        },
        {
          name: "google-craftmyletter",
          description: "CraftMyLetter Google account",
          oauthClientSecretsFile: gscClientSecretsFile
        }
      ],
      defaultProfile: "google-govalidate"
    });

    expect(config.defaultProfile).toBe("google-govalidate");
    expect(config.profiles).toMatchObject({
      "google-govalidate": {
        description: "GoValidate Google account",
        env: { GSC_OAUTH_CLIENT_SECRETS_FILE: gscClientSecretsFile },
        policy: "readonly"
      },
      "google-craftmyletter": {
        description: "CraftMyLetter Google account",
        env: { GSC_OAUTH_CLIENT_SECRETS_FILE: gscClientSecretsFile },
        policy: "readonly"
      }
    });
    const stateDirectories = Object.values(config.profiles).map((profile) => profile.env?.GSC_CONFIG_DIR);
    expect(stateDirectories.every((directory) => typeof directory === "string" && isAbsolute(directory))).toBe(true);
    expect(new Set(stateDirectories).size).toBe(2);
    expect(config).not.toHaveProperty("oauth");
    expect(config.profiles["google-govalidate"]?.env).not.toHaveProperty("GSC_ALLOW_DESTRUCTIVE");
    expect(config.profiles["google-craftmyletter"]?.env).not.toHaveProperty("GSC_ALLOW_DESTRUCTIVE");
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("namespaces generated GSC OAuth state by configuration as well as profile", () => {
    const options = {
      googleSearchConsoleProfiles: [
        { name: "work", oauthClientSecretsFile: gscClientSecretsFile }
      ]
    } as const;

    const first = buildPresetConfig("gsc", "google-search-console", options, {
      configurationPath: "/tmp/customer-a/gsc.json"
    });
    const second = buildPresetConfig("gsc", "google-search-console", options, {
      configurationPath: "/tmp/customer-b/gsc.json"
    });

    expect(first.profiles.work?.env?.GSC_CONFIG_DIR).not.toBe(second.profiles.work?.env?.GSC_CONFIG_DIR);
  });

  it("requires an explicit durable GSC default when more than one account is configured", () => {
    expect(() => buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "work", oauthClientSecretsFile: gscClientSecretsFile },
        { name: "client", oauthClientSecretsFile: gscClientSecretsFile }
      ]
    })).toThrow(PresetCatalogError);
  });

  it("requires one safe absolute OAuth client-secrets file path for the GSC pilot", () => {
    expect(() => buildPresetConfig("gsc", "google-search-console")).toThrow(PresetCatalogError);
    for (const value of [
      "client-secrets.json",
      "",
      " /tmp/client.json",
      "/tmp/client.json\nignored",
      resolve("fixtures", "${HOME}", "client-secrets.json")
    ] as const) {
      expect(() => buildPresetConfig("gsc", "google-search-console", { oauthClientSecretsFile: value })).toThrow(
        PresetCatalogError
      );
    }
  });

  it("requires and validates exact generic preset inputs", () => {
    if (process.platform !== "win32") {
      expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@1.2.3" })).not.toThrow();
      expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "@scope/server@1.2.3" })).not.toThrow();
      expect(buildPresetConfig("npx", "generic-npx", { npmPackage: "@sentry/mcp-server@0.36.0" }).upstream?.args).toEqual([
        "--yes",
        "@sentry/mcp-server@0.36.0"
      ]);
    }
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@latest" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@^1.2.3" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server" })).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@1.2.3-01" })).toThrow(
      PresetCatalogError
    );
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@1.2.3-alpha.01" })).toThrow(
      PresetCatalogError
    );
    if (process.platform !== "win32") {
      expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@1.2.3-0" })).not.toThrow();
      expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "server@1.2.3-01alpha" })).not.toThrow();
    }
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

  it("requires explicit acknowledgement before creating a restricted local stdio configuration", () => {
    const localCommand = localExecutable();
    const args = ["fixtures/fake-local-mcp.mjs", "--stdio", "$pageview"];

    expect(isAbsolute(args[0] ?? "")).toBe(false);
    expect(() => buildPresetConfig("local-tools", "local-stdio", { localCommand, args })).toThrow(PresetCatalogError);

    const config = buildPresetConfig("local-tools", "local-stdio", {
      localCommand,
      args,
      acceptLocalCommand: true,
      credentialEnv: "LOCAL_MCP_TOKEN"
    });

    expect(config.upstream).toEqual({ transport: "stdio", command: localCommand, args });
    expect(config.profiles.default).toEqual({
      description: "Locally configured MCP executable; configure authentication with secret references when required.",
      env: { LOCAL_MCP_TOKEN: "${LOCAL_MCP_TOKEN}" },
      policy: "readonly"
    });
    expect(config.policies).toEqual({
      readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] }
    });
    expect(config.tooling?.unknownToolRisk).toBe("destructive");
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects shell-shaped, credential-bearing, and non-native local stdio inputs without echoing them", () => {
    const secret = "local-secret-that-must-not-appear";
    const base = { localCommand: localExecutable(), args: ["server.mjs"], acceptLocalCommand: true } as const;
    const foreignPath = process.platform === "win32" ? "/tmp/server" : "C:\\tools\\server.exe";
    const unsafe = [
      { ...base, localCommand: "/bin/sh" },
      { ...base, localCommand: "env" },
      { ...base, localCommand: `node?token=${secret}` },
      { ...base, args: [`--token=${secret}`] },
      { ...base, args: [`https://example.test/mcp?signature=${secret}`] },
      { ...base, args: ["${LOCAL_MCP_TOKEN}"] },
      { ...base, args: ["--config=${LOCAL_MCP_CONFIG}"] },
      { ...base, cwd: "relative-directory" },
      { ...base, cwd: foreignPath }
    ];

    for (const options of unsafe) {
      try {
        buildPresetConfig("local-tools", "local-stdio", options);
        throw new Error("Expected local stdio input to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(PresetCatalogError);
        expect(error instanceof Error ? error.message : "").not.toContain(secret);
      }
    }
  });

  it("rejects the legacy Windows command interpreter as a local stdio executable", () => {
    expect(() => buildPresetConfig("local-tools", "local-stdio", {
      localCommand: "COMMAND.COM",
      args: ["/c", "server"],
      acceptLocalCommand: true
    })).toThrow(PresetCatalogError);
  });

  it("requires a direct Windows binary for local stdio instead of a command-processor shim", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const base = { args: ["server.mjs"], acceptLocalCommand: true } as const;

    for (const localCommand of ["node", "server.cmd", "server.bat"]) {
      expect(() => buildPresetConfig("local-tools", "local-stdio", { ...base, localCommand })).toThrow(PresetCatalogError);
    }
  });

  it("does not create npx-backed presets on Windows where npm requires a command shell", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    expect(() => buildPresetConfig("generic", "generic")).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("sentry", "sentry")).toThrow(PresetCatalogError);
    expect(() => buildPresetConfig("npx", "generic-npx", { npmPackage: "@scope/server@1.2.3" })).toThrow(
      PresetCatalogError
    );
  });

  it("validates generic-npx input before rejecting its Windows package runner", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    expect(() =>
      buildPresetConfig("npx", "generic-npx", { npmPackage: null as unknown as string })
    ).toThrow("Preset option 'npmPackage' must be a string.");
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
      "google-search-console",
      "oauthClientSecretsFile",
      { oauthClientSecretsFile: gscClientSecretsFile }
    ],
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
    if (process.platform !== "win32") {
      expect(() => buildPresetConfig("generic", "generic", { credentialEnv: undefined })).not.toThrow();
    }
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

  it.each([
    ["generic", { npmPackage: "server@1.2.3" }],
    ["github", { credentialEnv: "GITHUB_TOKEN" }],
    ["sentry", { credentialEnv: "SENTRY_TOKEN" }],
    ["google-search-console", { oauthClientSecretsFile: gscClientSecretsFile, credentialEnv: "GSC_TOKEN" }],
    ["generic-npx", { npmPackage: "server@1.2.3", dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }],
    ["generic-docker", { dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", url: "https://mcp.example.com" }],
    ["streamable-http", { url: "https://mcp.example.com", npmPackage: "server@1.2.3" }]
  ] as const)("rejects inapplicable preset inputs for %s", (preset, options) => {
    expect(() => buildPresetConfig("test", preset, options)).toThrow(PresetCatalogError);
  });

  it.each(["unsupported", "secret"])("rejects undeclared strict catalog input %s", (option) => {
    expect(() =>
      buildPresetConfig(
        "test",
        "generic",
        { [option]: option === "secret" ? "literal-secret-that-must-not-appear" : "value" } as unknown as PresetBuildOptions
      )
    ).toThrow(new RegExp(`Preset 'generic' does not support option '${option}'`));
  });
});

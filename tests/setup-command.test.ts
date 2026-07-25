import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileReadinessMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../src/setup/profile-readiness.js", () => ({
  runProfileReadiness: profileReadinessMocks.run
}));

import { CliUsageError, parseCli, renderCommandHelp } from "../src/cli/parse.js";
import { runSetupCommand } from "../src/cli/setup.js";
import { runNativeOAuthSetup } from "../src/cli/setup-native-oauth.js";
import { runProviderAccountSetup } from "../src/cli/setup-provider-account.js";
import { buildPresetConfig } from "../src/config/presets.js";
import { validateConfig } from "../src/config/validate-config.js";
import { startOAuthCompatibilityProbe } from "./helpers/fake-remote-upstream.js";

const outputRoot = resolve(process.cwd(), ".setup-command-test-output");

function importableClientEntry(): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === "win32"
    ? { command: process.execPath, args: ["server.mjs"] }
    : { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3"] };
}

class StreamTranscript {
  #contents = "";
  #waiters: Array<{ readonly text: string; readonly occurrences: number; readonly resolve: () => void }> = [];

  append(chunk: Buffer | string): void {
    this.#contents += chunk.toString();
    this.#waiters = this.#waiters.filter((waiter) => {
      if (this.#contents.split(waiter.text).length - 1 < waiter.occurrences) return true;
      waiter.resolve();
      return false;
    });
  }

  get contents(): string {
    return this.#contents;
  }

  waitFor(text: string, occurrences = 1): Promise<void> {
    if (this.#contents.split(text).length - 1 >= occurrences) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ text, occurrences, resolve }));
  }
}

function createStreams() {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const transcript = new StreamTranscript();
  output.on("data", (chunk: Buffer) => transcript.append(chunk));
  return { input, output, transcript };
}

async function answer(
  streams: ReturnType<typeof createStreams>,
  prompt: string,
  value: string,
  occurrences = 1
): Promise<void> {
  await streams.transcript.waitFor(prompt, occurrences);
  streams.input.write(`${value}\n`);
}

beforeEach(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

afterEach(async () => {
  profileReadinessMocks.run.mockReset();
  await rm(outputRoot, { recursive: true, force: true });
});

describe("setup command", () => {
  it("makes the guided setup flow a first-class command", () => {
    expect(parseCli(["setup"])).toEqual({ kind: "run", command: "setup", options: {} });
    expect(renderCommandHelp("setup")).toContain("guided MCP setup flow");
  });

  it("renders incompatible provider-account flags exactly as users pass them", async () => {
    await expect(runSetupCommand({
      addProfile: true,
      credentialEnv: "GSC_TOKEN"
    }, {
      input: new PassThrough(),
      output: new PassThrough(),
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).rejects.toThrow("Option '--credential-env' is unavailable when adding a provider-owned account.");
  });

  it("creates a native OAuth configuration only after endpoint discovery without registering or storing a credential", async () => {
    const output = resolve(outputRoot, "posthog-work.json");
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const transcript = new PassThrough();
    let contents = "";
    transcript.on("data", (chunk: Buffer) => { contents += chunk.toString(); });

    try {
      const result = await runSetupCommand({
        nativeOAuth: true,
        name: "posthog-work",
        profile: "production",
        url: upstream.streamableHttpUrl,
        output: "posthog-work.json",
        client: "claude-desktop"
      }, {
        input,
        output: Object.assign(transcript, { isTTY: false }),
        cwd: outputRoot,
        launcher: {
          command: process.execPath,
          args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
        },
        nativeOAuthFetch: upstream.fetch
      });

      expect(result).toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
      expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
        version: "3",
        name: "posthog-work",
        defaultProfile: "production",
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" }
      });
      expect(upstream.discoveryRequests()).toEqual([
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server"
      ]);
      expect(upstream.registrationRequests()).toEqual([]);
      expect(contents).toContain("OAuth discovery completed");
      expect(contents).toContain("Claude Desktop settings config");
      expect(contents).not.toContain("fixture-access-token");
    } finally {
      await upstream.close();
    }
  });

  it("adds another native OAuth account to an existing configuration without asking for an endpoint or issuer", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "posthog-work.json");
    await writeFile(configPath, JSON.stringify({
      version: "3",
      name: "posthog-work",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: { description: "Work analytics" } }
    }, null, 2), { mode: 0o600 });
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const transcript = new PassThrough();
    let contents = "";
    transcript.on("data", (chunk: Buffer) => { contents += chunk.toString(); });

    try {
      await expect(runSetupCommand({
        nativeOAuth: true,
        config: configPath,
        profile: "personal",
        description: "Personal analytics",
        upstream: "default",
        makeDefault: true
      }, {
        input,
        output: Object.assign(transcript, { isTTY: false }),
        cwd: outputRoot,
        launcher: {
          command: process.execPath,
          args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
        },
        nativeOAuthFetch: upstream.fetch
      })).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });

      expect(validateConfig(JSON.parse(await readFile(configPath, "utf8")))).toMatchObject({
        defaultProfile: "personal",
        profiles: {
          work: { description: "Work analytics" },
          personal: { description: "Personal analytics" }
        }
      });
      const stored = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly oauth: { readonly connections: Record<string, { readonly profile: string; readonly upstream: string }> };
      };
      expect(Object.values(stored.oauth.connections)).toContainEqual({
        profile: "personal",
        upstream: "default",
        resource: "https://mcp.example.test/mcp",
        issuer: "https://mcp.example.test",
        clientRegistration: "dynamic",
        scopes: ["mcp:tools"]
      });
      expect(contents).toContain("Added account profile 'personal'");
      expect(contents).not.toContain("Remote MCP HTTPS URL");
      expect(contents).not.toContain("OAuth issuer URL");
      expect(upstream.registrationRequests()).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("uses the injected discovery fetch when adding a native OAuth account", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "injected-fetch-account.json");
    await writeFile(configPath, JSON.stringify({
      version: "3",
      name: "posthog-work",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: {} }
    }, null, 2), { mode: 0o600 });
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const contextFetch = vi.fn(async (): Promise<Response> => {
      throw new Error("context discovery fetch must not be used");
    });
    const injectedFetch = vi.fn(upstream.fetch);
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });

    try {
      await expect(runNativeOAuthSetup({
        config: configPath,
        profile: "personal",
        upstream: "default"
      }, {
        input,
        output,
        cwd: outputRoot,
        launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] },
        nativeOAuthFetch: contextFetch
      }, { fetch: injectedFetch })).resolves.toBeUndefined();

      expect(injectedFetch).toHaveBeenCalled();
      expect(contextFetch).not.toHaveBeenCalled();
    } finally {
      await upstream.close();
    }
  });

  it("continues the interactive native OAuth account wizard when a profile name was supplied", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "multi-upstream.json");
    await writeFile(configPath, JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstreams: {
        analytics: { transport: "streamable-http", url: "https://mcp.example.test/mcp" }
      },
      profiles: { work: { description: "Work analytics" } }
    }, null, 2), { mode: 0o600 });
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const streams = createStreams();
    const command = runSetupCommand({
      nativeOAuth: true,
      config: configPath,
      profile: "personal"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch: upstream.fetch
    });

    try {
      await answer(streams, "Account profile description (optional)", "Personal analytics");
      await answer(streams, "Configured upstream [default]", "analytics");
      await answer(streams, "Make this the durable default profile? (yes/no) [no]", "yes");
      await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
      streams.input.end();

      expect(validateConfig(JSON.parse(await readFile(configPath, "utf8")))).toMatchObject({
        defaultProfile: "personal",
        profiles: {
          work: { description: "Work analytics" },
          personal: { description: "Personal analytics" }
        }
      });
      expect(streams.transcript.contents).toContain("Account profile description (optional)");
      expect(streams.transcript.contents).toContain("Configured upstream [default]");
      expect(streams.transcript.contents).toContain("Make this the durable default profile? (yes/no) [no]");
      expect(streams.transcript.contents).not.toContain("Remote MCP HTTPS URL");
      expect(streams.transcript.contents).not.toContain("OAuth issuer URL");
      expect(upstream.registrationRequests()).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("guides a user through the endpoint-first native OAuth setup questions", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "guided-oauth.json");
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const command = runSetupCommand({ nativeOAuth: true }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch: upstream.fetch
    });

    try {
      await answer(streams, "Configuration name [miftah-remote]", "posthog-work");
      await answer(streams, "Account profile name [default]", "production");
      await answer(streams, "Account profile description (optional)", "Production analytics");
      await answer(streams, "Remote MCP HTTPS URL", upstream.streamableHttpUrl);
      await answer(streams, "Output location [posthog-work.miftah.json]", "guided-oauth.json");
      await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");
      await command;
      streams.input.end();

      const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
      expect(config).toMatchObject({
        name: "posthog-work",
        defaultProfile: "production",
        profiles: { production: { description: "Production analytics" } }
      });
      expect(streams.transcript.contents).toContain("OAuth discovery completed for https://mcp.example.test/mcp.");
      expect(streams.transcript.contents).toContain("Server-advertised scopes: mcp:tools.");
      expect(streams.transcript.contents).not.toContain("OAuth issuer URL");
      expect(streams.transcript.contents).not.toContain("client secret");
    } finally {
      await upstream.close();
    }
  });

  it("creates a validated owner-only configuration through the guided setup flow", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "guided.json");
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await answer(streams, "Name [miftah-wrapper]", "guided");
    await answer(streams, "Catalog preset", "generic-docker");
    await answer(
      streams,
      "Docker image (digest-pinned)",
      "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    await answer(streams, "Output location [guided.miftah.json]", "guided.json");
    await answer(streams, "Client", "");
    await command;
    streams.input.end();

    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({ name: "guided" });
    expect(streams.transcript.contents).toContain(`Created ${output}`);
    if (process.platform !== "win32") {
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    }
  });

  it("stores a reviewed local argv configuration without launching or probing it", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "local-tools.json");
    const localCommand = process.platform === "win32" ? process.execPath : "node";
    const command = runSetupCommand({
      name: "local-tools",
      preset: "local-stdio",
      output: "local-tools.json",
      localCommand,
      args: ["server.mjs", "--stdio", "$pageview"],
      cwd: outputRoot,
      credentialEnv: "LOCAL_MCP_TOKEN"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await answer(
      streams,
      "Miftah will not run this during setup. It will save this executable and argument array without a shell.",
      "yes"
    );
    await answer(streams, "Client", "");

    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      upstream: { transport: "stdio", command: localCommand, args: ["server.mjs", "--stdio", "$pageview"], cwd: outputRoot },
      profiles: { default: { env: { LOCAL_MCP_TOKEN: "${LOCAL_MCP_TOKEN}" }, policy: "readonly" } },
      tooling: { unknownToolRisk: "destructive" }
    });
    expect(profileReadinessMocks.run).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain(
      "Local command review: 1 executable with 3 argument(s); working directory: configured; credential environment: configured."
    );
    expect(streams.transcript.contents).not.toContain("$pageview");
  });

  it("imports one explicitly selected local stdio entry without modifying the source client file", async () => {
    const source = resolve(outputRoot, "claude-desktop.json");
    const output = resolve(outputRoot, "posthog.json");
    const entry = importableClientEntry();
    const document = JSON.stringify({
      mcpServers: {
        posthog: entry
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const input = new PassThrough();
    const transcript = new PassThrough();

    const result = await runSetupCommand({
      name: "posthog-work",
      output,
      importFile: source,
      importEntry: "posthog"
    } as Parameters<typeof runSetupCommand>[0], {
      input,
      output: transcript,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });
    input.end();

    expect(result).toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "posthog-work",
      upstream: { transport: "stdio", command: entry.command, args: entry.args },
      profiles: { default: { policy: "readonly" } }
    });
    expect(await readFile(source, "utf8")).toBe(document);
  });

  it.each([
    ["a prefixed header", "--http-header=Authorization: Bearer gF7r2Uv9Qx"],
    ["an embedded authorization header", "--metadata=Authorization: Bearer gF7r2Uv9Qx"],
    ["an embedded bearer credential", "--metadata=Bearer gF7r2Uv9Qx"],
    ["URL userinfo", "--url=https://user:gF7r2Uv9Qx@example.test/mcp"],
    ["empty-user URL credentials", "--url=redis://:gF7r2Uv9Qx@cache.example/0"],
    ["token-as-user URL credentials", "--url=https://gF7r2Uv9Qx@example.test/mcp"],
    ["an embedded token credential", "--metadata=Token gF7r2Uv9Qx"],
    ["a camel-cased credential option", "--myApiKey=gF7r2Uv9Qx"],
    ["a compound credential option", "--token-value=gF7r2Uv9Qx"],
    ["a credential query parameter", "--endpoint=https://example.test/mcp?token=gF7r2Uv9Qx"],
    ["a JWT credential option", "--jwt=gF7r2Uv9Qx"],
    ["an embedded JWT credential", "--metadata=JWT gF7r2Uv9Qx"],
    ["a signed URL signature", "--url=https://example.test/mcp?signature=gF7r2Uv9Qx"],
    ["a short signed URL signature", "--url=https://example.test/mcp?sig=gF7r2Uv9Qx"]
  ])("does not write a configuration when imported client arguments contain %s", async (_kind, argument) => {
    const source = resolve(outputRoot, "unsafe-client.json");
    const output = resolve(outputRoot, "unsafe.json");
    const secret = "gF7r2Uv9Qx";
    const document = JSON.stringify({
      mcpServers: {
        unsafe: { command: "npx", args: [argument] }
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const input = new PassThrough();
    const transcript = new PassThrough();

    await expect(runSetupCommand({
      name: "unsafe",
      output,
      importFile: source,
      importEntry: "unsafe"
    } as Parameters<typeof runSetupCommand>[0], {
      input,
      output: transcript,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    })).rejects.toMatchObject({ message: expect.not.stringContaining(secret) });
    input.end();

    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe(document);
  });

  it.each([
    ["a remote URL", "https://gF7r2Uv9Qx@example.test/mcp"],
    ["a query-bearing executable", "node?token=gF7r2Uv9Qx"]
  ])("does not write a configuration when the selected command is %s", async (_kind, command) => {
    const source = resolve(outputRoot, "unsafe-command-client.json");
    const output = resolve(outputRoot, "unsafe-command.json");
    const secret = "gF7r2Uv9Qx";
    const document = JSON.stringify({
      mcpServers: {
        unsafe: { command }
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const input = new PassThrough();
    const transcript = new PassThrough();

    await expect(runSetupCommand({
      name: "unsafe-command",
      output,
      importFile: source,
      importEntry: "unsafe"
    } as Parameters<typeof runSetupCommand>[0], {
      input,
      output: transcript,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    })).rejects.toMatchObject({ message: expect.not.stringContaining(secret) });
    input.end();

    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe(document);
  });

  it.each([
    ["an environment wrapper", { command: "env", args: ["FOO=gF7r2Uv9Qx", "node", "server.mjs"] }],
    ["Node inline code", { command: "node", args: ["-e", "require(\"./server\").start(\"gF7r2Uv9Qx\")"] }],
    ["Python inline code", { command: "python3", args: ["-c", "start(\"gF7r2Uv9Qx\")"] }],
    ["an unpinned package runner", { command: "npx", args: ["--yes", "@posthog/mcp"] }]
  ])("does not write a configuration when the selected entry contains %s", async (_kind, unsafeEntry) => {
    const source = resolve(outputRoot, "unsafe-launch-client.json");
    const output = resolve(outputRoot, "unsafe-launch.json");
    const secret = "gF7r2Uv9Qx";
    const document = JSON.stringify({
      mcpServers: { unsafe: unsafeEntry }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const input = new PassThrough();
    const transcript = new PassThrough();

    await expect(runSetupCommand({
      name: "unsafe-launch",
      output,
      importFile: source,
      importEntry: "unsafe"
    } as Parameters<typeof runSetupCommand>[0], {
      input,
      output: transcript,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    })).rejects.toMatchObject({ message: expect.not.stringContaining(secret) });
    input.end();

    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe(document);
  });

  it("rejects --verify for an imported client entry before writing a configuration", async () => {
    const source = resolve(outputRoot, "client.json");
    const output = resolve(outputRoot, "imported.json");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, JSON.stringify({
      mcpServers: { example: { command: "node", args: ["server.mjs"] } }
    }), { mode: 0o600 });
    const input = new PassThrough();
    const transcript = new PassThrough();

    await expect(runSetupCommand({
      name: "example",
      output,
      importFile: source,
      importEntry: "example",
      verify: true
    } as Parameters<typeof runSetupCommand>[0], {
      input,
      output: transcript,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    })).rejects.toBeInstanceOf(CliUsageError);
    input.end();

    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes every supplied Google Search Console account without echoing its client-secrets paths", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc.json");
    const govalidateSecrets = resolve("fixtures", "gsc", "govalidate-client-secrets.json");
    const craftmyletterSecrets = resolve("fixtures", "gsc", "craftmyletter-client-secrets.json");

    const command = runSetupCommand({
      name: "gsc",
      preset: "google-search-console",
      output: "gsc.json",
      client: "claude-desktop",
      googleSearchConsoleProfiles: [
        {
          name: "google-govalidate",
          description: "GoValidate Google account",
          oauthClientSecretsFile: govalidateSecrets
        },
        {
          name: "google-craftmyletter",
          description: "CraftMyLetter Google account",
          oauthClientSecretsFile: craftmyletterSecrets
        }
      ],
      defaultProfile: "google-craftmyletter"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });
    await answer(streams, "Run the reviewed safe readiness check for every account now? (yes/no) [no]", "no");
    await command;
    streams.input.end();

    const config = JSON.parse(await readFile(output, "utf8")) as {
      readonly defaultProfile: string;
      readonly profiles: Record<string, {
        readonly env: {
          readonly GSC_CONFIG_DIR: string;
          readonly GSC_OAUTH_CLIENT_SECRETS_FILE?: string;
        };
      }>;
    };
    expect(config.defaultProfile).toBe("google-craftmyletter");
    expect(config.profiles).toMatchObject({
      "google-govalidate": { env: { GSC_OAUTH_CLIENT_SECRETS_FILE: govalidateSecrets } },
      "google-craftmyletter": { env: { GSC_OAUTH_CLIENT_SECRETS_FILE: craftmyletterSecrets } }
    });
    expect(Object.keys(config.profiles)).toHaveLength(2);
    expect(new Set(Object.values(config.profiles).map((profile) => profile.env.GSC_CONFIG_DIR)).size).toBe(2);
    expect(streams.transcript.contents).not.toContain(govalidateSecrets);
    expect(streams.transcript.contents).not.toContain(craftmyletterSecrets);
  });

  it("uses --verify to run the bounded provider readiness check once for every supplied account", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc-verified.json");
    const govalidateSecrets = resolve("fixtures", "gsc", "govalidate-client-secrets.json");
    const craftmyletterSecrets = resolve("fixtures", "gsc", "craftmyletter-client-secrets.json");
    profileReadinessMocks.run.mockImplementation(async (_configPath: string, target: { readonly profile: string }) => ({
      status: "ready",
      profile: target.profile,
      upstream: "default",
      adapter: "Google Search Console",
      safeRead: { status: "passed", tool: "get_capabilities" },
      identity: { status: "unavailable" }
    }));

    const result = await runSetupCommand({
      name: "gsc",
      preset: "google-search-console",
      output: "gsc-verified.json",
      client: "claude-desktop",
      verify: true,
      googleSearchConsoleProfiles: [
        { name: "google-govalidate", oauthClientSecretsFile: govalidateSecrets },
        { name: "google-craftmyletter", oauthClientSecretsFile: craftmyletterSecrets }
      ],
      defaultProfile: "google-craftmyletter"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });
    streams.input.end();

    expect(result).toMatchObject({ verification: "complete" });
    expect(profileReadinessMocks.run).toHaveBeenCalledTimes(2);
    expect(profileReadinessMocks.run).toHaveBeenNthCalledWith(1, output, { profile: "google-craftmyletter" });
    expect(profileReadinessMocks.run).toHaveBeenNthCalledWith(2, output, { profile: "google-govalidate" });
    expect(streams.transcript.contents).not.toContain("Run the reviewed safe readiness check for every account now?");
    expect(streams.transcript.contents).toContain("Profile 'google-craftmyletter': safe read-only check succeeded; identity is unavailable.");
    expect(streams.transcript.contents).not.toContain(govalidateSecrets);
    expect(streams.transcript.contents).not.toContain(craftmyletterSecrets);
  });

  it("adds one provider-owned GSC account to an existing configuration and verifies only that account", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "gsc-existing.json");
    const firstSecrets = resolve(outputRoot, "google-work-client-secrets.json");
    const secondSecrets = resolve(outputRoot, "google-personal-client-secrets.json");
    const thirdSecrets = resolve(outputRoot, "google-third-client-secrets.json");
    await writeFile(configPath, `${JSON.stringify(buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath }), null, 2)}\n`, { mode: 0o600 });
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    let transcript = "";
    output.on("data", (chunk: Buffer) => { transcript += chunk.toString(); });
    profileReadinessMocks.run.mockResolvedValue({
      status: "ready",
      profile: "google-third",
      upstream: "default",
      adapter: "Google Search Console",
      safeRead: { status: "passed", tool: "get_capabilities" },
      identity: { status: "unavailable" }
    });

    await expect(runSetupCommand({
      addProfile: true,
      config: configPath,
      profile: "google-third",
      description: "Third Google account",
      oauthClientSecretsFile: thirdSecrets,
      makeDefault: true,
      verify: true
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).resolves.toMatchObject({ verification: "complete", exitCode: 0 });

    const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
    expect(config).toMatchObject({
      defaultProfile: "google-third",
      profiles: {
        "google-third": {
          description: "Third Google account",
          env: { GSC_OAUTH_CLIENT_SECRETS_FILE: thirdSecrets },
          policy: "readonly"
        }
      }
    });
    const stateDirectories = Object.values(config.profiles).map((profile) => profile.env?.GSC_CONFIG_DIR);
    expect(new Set(stateDirectories).size).toBe(3);
    expect(profileReadinessMocks.run).toHaveBeenCalledTimes(1);
    expect(profileReadinessMocks.run).toHaveBeenCalledWith(configPath, { profile: "google-third" });
    expect(transcript).toContain("Added provider-owned account profile 'google-third'");
    expect(transcript).not.toContain(thirdSecrets);
  });

  it("skips readiness without prompting after a scripted provider-account addition", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "gsc-noninteractive-account.json");
    const firstSecrets = resolve(outputRoot, "google-work-client-secrets.json");
    const secondSecrets = resolve(outputRoot, "google-personal-client-secrets.json");
    const original = `${JSON.stringify(buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [{ name: "google-work", oauthClientSecretsFile: firstSecrets }],
      defaultProfile: "google-work"
    }, { configurationPath: configPath }), null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    const streams = createStreams();
    Object.assign(streams.input, { isTTY: false });
    Object.assign(streams.output, { isTTY: false });

    const command = runSetupCommand({
      addProfile: true,
      config: configPath,
      profile: "google-personal",
      oauthClientSecretsFile: secondSecrets
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    });
    setImmediate(() => streams.input.end());

    await expect(command).resolves.toEqual({ verification: "skipped", exitCode: 0, reports: [] });
    expect(profileReadinessMocks.run).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain("First-success verification was skipped");
    expect(streams.transcript.contents).not.toContain("Run the reviewed safe readiness check for the new account now?");
  });

  it("rejects a NUL profile before it can become provider state or mutate the configuration", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "gsc-nul-profile.json");
    const firstSecrets = resolve(outputRoot, "google-work-client-secrets.json");
    const secondSecrets = resolve(outputRoot, "google-personal-client-secrets.json");
    const original = `${JSON.stringify(buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [{ name: "google-work", oauthClientSecretsFile: firstSecrets }],
      defaultProfile: "google-work"
    }, { configurationPath: configPath }), null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });

    await expect(runProviderAccountSetup({
      config: configPath,
      profile: "google\0personal",
      oauthClientSecretsFile: secondSecrets
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).rejects.toThrow("Profile name must not contain a NUL character.");

    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("keeps the written config and returns an incomplete nonzero outcome when the post-write readiness prompt is cancelled", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc-readiness-cancelled.json");
    const clientSecrets = resolve("fixtures", "gsc", "client-secrets.json");
    const command = runSetupCommand({
      name: "gsc",
      preset: "google-search-console",
      output: "gsc-readiness-cancelled.json",
      client: "claude-desktop",
      googleSearchConsoleProfiles: [{ name: "work", oauthClientSecretsFile: clientSecrets }],
      defaultProfile: "work"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await streams.transcript.waitFor("Run the reviewed safe readiness check for every account now? (yes/no) [no]");
    streams.input.end();

    await expect(command).resolves.toMatchObject({ verification: "incomplete", exitCode: 1, reports: [] });
    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({ name: "gsc" });
    expect(profileReadinessMocks.run).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain("First-success verification was cancelled after configuration creation; the configuration remains available.");
  });

  it("writes config before --verify and returns a nonzero outcome when readiness is incomplete", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc-verify-incomplete.json");
    const clientSecrets = resolve("fixtures", "gsc", "client-secrets.json");
    profileReadinessMocks.run.mockResolvedValue({
      status: "unsupported",
      profile: "work",
      upstream: "default",
      adapter: "Google Search Console",
      safeRead: { status: "unavailable", errorCode: "PROFILE_READINESS_UNSUPPORTED" },
      identity: { status: "not-checked" }
    });

    const result = await runSetupCommand({
      name: "gsc",
      preset: "google-search-console",
      output: "gsc-verify-incomplete.json",
      client: "claude-desktop",
      verify: true,
      googleSearchConsoleProfiles: [{ name: "work", oauthClientSecretsFile: clientSecrets }],
      defaultProfile: "work"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });
    streams.input.end();

    expect(result).toMatchObject({ verification: "incomplete", exitCode: 1 });
    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({ name: "gsc" });
    expect(streams.transcript.contents).toContain("Profile 'work': readiness is unsupported (unavailable: PROFILE_READINESS_UNSUPPORTED).");
  });

  it("isolates upstream-owned Google OAuth state for separate config files with the same display name", async () => {
    const clientSecrets = resolve("fixtures", "gsc", "client-secrets.json");
    const firstOutput = resolve(outputRoot, "customer-a", "gsc.json");
    const secondOutput = resolve(outputRoot, "customer-b", "gsc.json");

    for (const output of [firstOutput, secondOutput]) {
      const streams = createStreams();
      const command = runSetupCommand({
        name: "gsc",
        preset: "google-search-console",
        output,
        client: "claude-desktop",
        googleSearchConsoleProfiles: [{ name: "work", oauthClientSecretsFile: clientSecrets }],
        defaultProfile: "work"
      }, {
        input: streams.input,
        output: streams.output,
        cwd: outputRoot,
        launcher: {
          command: process.execPath,
          args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
        }
      });
      await answer(streams, "Run the reviewed safe readiness check for every account now? (yes/no) [no]", "no");
      await command;
      streams.input.end();
    }

    const first = JSON.parse(await readFile(firstOutput, "utf8")) as {
      readonly profiles: { readonly work: { readonly env: { readonly GSC_CONFIG_DIR: string } } };
    };
    const second = JSON.parse(await readFile(secondOutput, "utf8")) as {
      readonly profiles: { readonly work: { readonly env: { readonly GSC_CONFIG_DIR: string } } };
    };

    expect(first.profiles.work.env.GSC_CONFIG_DIR).not.toBe(second.profiles.work.env.GSC_CONFIG_DIR);
  });

  it("rejects conflicting legacy and named Google Search Console account input", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc-conflict.json");
    const clientSecrets = resolve("fixtures", "gsc", "client-secrets.json");

    await expect(runSetupCommand({
      name: "gsc-conflict",
      preset: "google-search-console",
      output: "gsc-conflict.json",
      client: "claude-desktop",
      oauthClientSecretsFile: clientSecrets,
      googleSearchConsoleProfiles: [
        { name: "work", oauthClientSecretsFile: clientSecrets }
      ],
      defaultProfile: "work"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    })).rejects.toThrow("oauthClientSecretsFile or googleSearchConsoleProfiles, not both");
    streams.input.end();
    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("guides a user through adding multiple Google Search Console accounts and choosing the durable default", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc-interactive.json");
    const govalidateSecrets = resolve("fixtures", "gsc", "govalidate-client-secrets.json");
    const craftmyletterSecrets = resolve("fixtures", "gsc", "craftmyletter-client-secrets.json");
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await answer(streams, "Name [miftah-wrapper]", "gsc");
    await answer(streams, "Catalog preset", "google-search-console");
    await answer(streams, "Google account profile name [google-account-1]", "google-govalidate");
    await answer(streams, "Google account description (optional)", "GoValidate Google account");
    await answer(streams, "Google OAuth client-secrets file (absolute path)", govalidateSecrets);
    await answer(streams, "Add another Google account? (yes/no) [no]", "yes");
    await answer(streams, "Google account profile name", "google-craftmyletter", 2);
    await answer(streams, "Google account description (optional)", "CraftMyLetter Google account", 2);
    await answer(streams, "Google OAuth client-secrets file (absolute path)", craftmyletterSecrets, 2);
    await answer(streams, "Add another Google account? (yes/no) [no]", "no", 2);
    await answer(streams, "Default Google account profile [google-govalidate]", "google-craftmyletter");
    await answer(streams, "Output location [gsc.miftah.json]", "gsc-interactive.json");
    await answer(streams, "Client", "");
    await answer(streams, "Run the reviewed safe readiness check for every account now? (yes/no) [no]", "no");
    await command;
    streams.input.end();

    const config = JSON.parse(await readFile(output, "utf8")) as {
      readonly defaultProfile: string;
      readonly profiles: Record<string, {
        readonly env: {
          readonly GSC_CONFIG_DIR: string;
          readonly GSC_OAUTH_CLIENT_SECRETS_FILE?: string;
        };
      }>;
    };
    expect(config.defaultProfile).toBe("google-craftmyletter");
    expect(config.profiles).toMatchObject({
      "google-govalidate": { env: { GSC_OAUTH_CLIENT_SECRETS_FILE: govalidateSecrets } },
      "google-craftmyletter": { env: { GSC_OAUTH_CLIENT_SECRETS_FILE: craftmyletterSecrets } }
    });
    expect(Object.values(config.profiles).map((profile) => profile.env.GSC_CONFIG_DIR)).toHaveLength(2);
    const completedOutput = streams.transcript.contents.slice(streams.transcript.contents.indexOf("Created "));
    expect(completedOutput).not.toContain(govalidateSecrets);
    expect(completedOutput).not.toContain(craftmyletterSecrets);
  });
});

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileReadinessMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../src/setup/profile-readiness.js", () => ({
  runProfileReadiness: profileReadinessMocks.run
}));

import { CliUsageError, parseCli, renderCommandHelp } from "../src/cli/parse.js";
import { ClientEntryImportSetupError } from "../src/cli/setup-client-entry-import.js";
import { runSetupCommand } from "../src/cli/setup.js";
import { runNativeOAuthSetup } from "../src/cli/setup-native-oauth.js";
import { runProviderAccountSetup } from "../src/cli/setup-provider-account.js";
import { buildPresetConfig } from "../src/config/presets.js";
import { validateConfig } from "../src/config/validate-config.js";
import { FileSetupDraftStore, resolveSetupDraftPath } from "../src/setup/setup-draft.js";
import { MiftahError } from "../src/utils/errors.js";
import { environmentProfileConfig } from "./helpers/environment-profile-config.js";
import { startOAuthCompatibilityProbe } from "./helpers/fake-remote-upstream.js";

const outputRoot = resolve(process.cwd(), ".setup-command-test-output");
const guidedSourcePrompt = "Choose a starting point (1-5 or name) [1]";
const guidedSourceConfirmationPrompt = "Continue with this setup path? (yes/back/cancel) [yes]";

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

async function chooseGuidedSource(
  streams: ReturnType<typeof createStreams>,
  value: string,
  occurrences = 1
): Promise<void> {
  await answer(streams, guidedSourcePrompt, value, occurrences);
  await answer(streams, guidedSourceConfirmationPrompt, "yes", occurrences);
}

beforeEach(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

afterEach(async () => {
  profileReadinessMocks.run.mockReset();
  await rm(outputRoot, { recursive: true, force: true });
});

describe("setup command", () => {
  it("identifies client-entry import setup errors without losing the usage-error contract", () => {
    const error = new ClientEntryImportSetupError("safe import failure", "invalid");

    expect(error).toBeInstanceOf(CliUsageError);
    expect(error.name).toBe("ClientEntryImportSetupError");
    expect(error.importReason).toBe("invalid");
  });

  it("makes the guided setup flow a first-class command", () => {
    expect(parseCli(["setup"])).toEqual({ kind: "run", command: "setup", options: {} });
    expect(renderCommandHelp("setup")).toContain("guided terminal MCP setup wizard");
  });

  it("presents the first setup decision as a numbered, progress-labelled wizard step", async () => {
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    try {
      await streams.transcript.waitFor(guidedSourcePrompt);
      expect(streams.transcript.contents).toContain("Step 1 — Choose what you already have");
      expect(streams.transcript.contents).toContain("1. Known connector or pinned package");
      expect(streams.transcript.contents).toContain("2. Remote HTTPS endpoint");
      expect(streams.transcript.contents).toContain("3. Local executable");
      expect(streams.transcript.contents).toContain("4. Remote MCP with browser sign-in");
      expect(streams.transcript.contents).toContain("5. Existing client entry");
      expect(streams.transcript.contents).toContain("Enter a number or name");
    } finally {
      streams.input.end();
      await command.catch(() => undefined);
    }
  });

  it("accepts numbered choices and returns safely to the source step on back", async () => {
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await answer(streams, guidedSourcePrompt, "2");
    await answer(streams, guidedSourceConfirmationPrompt, "back");
    await answer(streams, guidedSourcePrompt, "3", 2);
    await answer(streams, guidedSourceConfirmationPrompt, "cancel", 2);

    await expect(command).rejects.toThrow("Guided setup was cancelled.");
    streams.input.end();
    expect(streams.transcript.contents).toContain("Selected: Remote HTTPS endpoint");
    expect(streams.transcript.contents).toContain("Returning to the starting-point choices.");
    expect(streams.transcript.contents).toContain("Selected: Local executable");
    await expect(readFile(resolve(outputRoot, "miftah-wrapper.miftah.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("checkpoints only a bare connector intent before asking for connection details", async () => {
    const draftDirectory = resolve(outputRoot, "setup-draft");
    const draftStore = new FileSetupDraftStore({
      directory: draftDirectory,
      now: () => "2026-07-25T12:00:00.000Z"
    });
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      setupDraftStore: draftStore
    });

    try {
      await chooseGuidedSource(streams, "connector");
      await answer(streams, "Name [miftah-wrapper]", "posthog-work");
      await answer(streams, "What do you want to set up? (connector name, remote, or local)", "generic-docker");
      await streams.transcript.waitFor("Docker image (digest-pinned)");

      await expect(draftStore.load()).resolves.toEqual({
        schemaVersion: 1,
        revision: 1,
        source: "connector",
        name: "posthog-work",
        preset: "generic-docker",
        stage: "connection",
        savedAt: "2026-07-25T12:00:00.000Z"
      });
      await expect(readFile(resolveSetupDraftPath(draftDirectory), "utf8")).resolves.not.toContain("Docker image");
      await expect(readFile(resolveSetupDraftPath(draftDirectory), "utf8")).resolves.not.toContain("credentialEnv");
    } finally {
      streams.input.end();
      await command.catch(() => undefined);
    }
  });

  it("resumes a connector choice, re-prompts connection data, and clears the draft only after publication", async () => {
    const draftStore = new FileSetupDraftStore({ directory: resolve(outputRoot, "setup-draft") });
    const draft = await draftStore.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic-docker",
      stage: "connection"
    });
    const streams = createStreams();
    const command = runSetupCommand({ resume: true }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      setupDraftStore: draftStore
    });

    try {
      await vi.waitFor(() => expect(streams.transcript.contents).toContain("Docker image (digest-pinned)"));
      expect(streams.transcript.contents).not.toContain(guidedSourcePrompt);
      expect(streams.transcript.contents).not.toContain("Name [miftah-wrapper]");
      expect(streams.transcript.contents).not.toContain("What do you want to set up? (connector name, remote, or local)");

      await answer(
        streams,
        "Docker image (digest-pinned)",
        "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      );
      await answer(streams, "Output location [posthog-work.miftah.json]", "resumed.json");
      await answer(streams, "Client", "");

      await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
      await expect(draftStore.load()).resolves.toBeUndefined();
      await expect(readFile(resolve(outputRoot, "resumed.json"), "utf8")).resolves.toContain("ghcr.io/acme/server@sha256");
      expect(draft.revision).toBe(1);
    } finally {
      streams.input.end();
      await command.catch(() => undefined);
    }
  });

  it("finishes a published resumed setup when its private draft cleanup conflicts", async () => {
    const persistedStore = new FileSetupDraftStore({ directory: resolve(outputRoot, "setup-draft") });
    const draft = await persistedStore.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic-docker",
      stage: "connection"
    });
    const draftStore = {
      load: persistedStore.load.bind(persistedStore),
      save: persistedStore.save.bind(persistedStore),
      discard: async () => {
        throw new MiftahError(
          "SETUP_DRAFT_CONFLICT",
          "SETUP_DRAFT_CONFLICT: setup draft changed in another CLI or Console session"
        );
      }
    };
    const streams = createStreams();
    const command = runSetupCommand({ resume: true }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      setupDraftStore: draftStore
    });

    try {
      await answer(
        streams,
        "Docker image (digest-pinned)",
        "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      );
      await answer(streams, "Output location [posthog-work.miftah.json]", "resumed-cleanup-conflict.json");
      await answer(streams, "Client", "");

      await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
      expect(streams.transcript.contents).toContain(
        "Configuration was created, but Miftah could not clear the saved connector choice (SETUP_DRAFT_CONFLICT)."
      );
      await expect(persistedStore.load()).resolves.toEqual(draft);
    } finally {
      streams.input.end();
      await command.catch(() => undefined);
    }
  });

  it("retains a resumed draft when publication fails and permits an explicit discard without a TTY", async () => {
    const draftStore = new FileSetupDraftStore({ directory: resolve(outputRoot, "setup-draft") });
    const draft = await draftStore.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection"
    });
    const existingOutput = resolve(outputRoot, "existing.json");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(existingOutput, "{}", { mode: 0o600 });
    const streams = createStreams();
    const command = runSetupCommand({ resume: true }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      setupDraftStore: draftStore
    });

    try {
      await answer(streams, "Output location [posthog-work.miftah.json]", "existing.json");
      await answer(streams, "Client", "");
      await expect(command).rejects.toThrow("Output");
      await expect(draftStore.load()).resolves.toEqual(draft);
    } finally {
      streams.input.end();
      await command.catch(() => undefined);
    }

    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    await expect(runSetupCommand({ discardDraft: true }, {
      input,
      output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      setupDraftStore: draftStore
    })).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    await expect(draftStore.load()).resolves.toBeUndefined();
  });

  it("rejects every setup input when resuming a private connector intent", async () => {
    const streams = createStreams();
    await expect(runSetupCommand({ resume: true, output: "unsafe.json" }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      setupDraftStore: new FileSetupDraftStore({ directory: resolve(outputRoot, "setup-draft") })
    })).rejects.toThrow("cannot be combined with '--output'");
    streams.input.end();
  });

  it("rejects mutually exclusive and noninteractive resume modes", async () => {
    const streams = createStreams();
    const draftStore = new FileSetupDraftStore({ directory: resolve(outputRoot, "setup-draft") });
    await expect(runSetupCommand({ resume: true, discardDraft: true }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] },
      setupDraftStore: draftStore
    })).rejects.toThrow("Choose either '--resume' or '--discard-draft', not both.");
    streams.input.end();

    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    await expect(runSetupCommand({ resume: true }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] },
      setupDraftStore: draftStore
    })).rejects.toThrow("Option '--resume' requires TTY input and output");
    input.end();
  });

  it("prints a validated non-secret setup plan without writing or contacting a remote MCP", async () => {
    const outputPath = resolve(outputRoot, "remote-tools.json");
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    let transcript = "";
    output.on("data", (chunk: Buffer) => { transcript += chunk.toString(); });
    input.end();

    await expect(runSetupCommand({
      plan: true,
      name: "remote-tools",
      preset: "streamable-http",
      url: "https://mcp.example.test/mcp",
      credentialEnv: "MCP_TOKEN",
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      output: "remote-tools.json"
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] },
      nativeOAuthFetch: vi.fn()
    })).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });

    expect(JSON.parse(transcript)).toEqual({
      schemaVersion: 1,
      kind: "setup-plan",
      output: outputPath,
      configuration: {
        schemaVersion: 1,
        name: "remote-tools",
        version: "3",
        defaultProfile: "default",
        profiles: ["default"],
        profileCount: 1,
        upstreams: [{ name: "default", transport: "streamable-http", kind: "remote-mcp" }],
        sensitiveValues: "omitted",
        publication: "new-file-only"
      },
      clientHandoff: "not-requested"
    });
    expect(transcript).not.toContain("mcp.example.test");
    expect(transcript).not.toContain("MCP_TOKEN");
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts Google OAuth client-secrets paths while printing a setup plan", async () => {
    const outputPath = resolve(outputRoot, "gsc.json");
    const clientSecretsPath = resolve(outputRoot, "google-client-secrets.json");
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    let transcript = "";
    output.on("data", (chunk: Buffer) => { transcript += chunk.toString(); });
    input.end();

    await expect(runSetupCommand({
      plan: true,
      name: "gsc",
      preset: "google-search-console",
      output: "gsc.json",
      oauthClientSecretsFile: clientSecretsPath
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });

    expect(JSON.parse(transcript)).toMatchObject({
      kind: "setup-plan",
      output: outputPath,
      configuration: {
        name: "gsc",
        profiles: ["default"],
        upstreams: [{ name: "default", transport: "stdio", kind: "local-process" }],
        sensitiveValues: "omitted",
        publication: "new-file-only"
      }
    });
    expect(transcript).not.toContain(clientSecretsPath);
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not render client snippets while printing a setup plan", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    input.end();
    const launcher = Object.create(null) as { readonly command: string; readonly args: readonly string[] };
    Object.defineProperties(launcher, {
      command: {
        get: (): string => {
          throw new Error("client snippet rendering must not run for a setup plan");
        }
      },
      args: {
        get: (): readonly string[] => {
          throw new Error("client snippet rendering must not run for a setup plan");
        }
      }
    });

    await expect(runSetupCommand({
      plan: true,
      name: "remote-tools",
      preset: "streamable-http",
      url: "https://mcp.example.test/mcp",
      client: "claude-desktop"
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher
    })).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });

    expect(JSON.parse(output.read()?.toString() ?? "{}")).toMatchObject({
      kind: "setup-plan",
      clientHandoff: "requested"
    });
  });

  it("validates a requested client while printing a setup plan", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    input.end();

    await expect(runSetupCommand({
      plan: true,
      name: "remote-tools",
      preset: "streamable-http",
      url: "https://mcp.example.test/mcp",
      client: "unsupported" as never
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).rejects.toThrow("Unsupported client 'unsupported'.");

    await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to combine the noninteractive setup plan with the interactive wizard", async () => {
    await expect(runSetupCommand({
      plan: true,
      interactive: true,
      name: "remote-tools",
      preset: "streamable-http",
      url: "https://mcp.example.test/mcp"
    }, {
      input: Object.assign(new PassThrough(), { isTTY: true }),
      output: Object.assign(new PassThrough(), { isTTY: true }),
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).rejects.toThrow("Option '--interactive' is unavailable when printing a setup plan.");
  });

  it("requires a configuration before classifying account-addition flags", async () => {
    await expect(runSetupCommand({
      addProfile: true,
      credentialEnv: "GSC_TOKEN"
    }, {
      input: new PassThrough(),
      output: new PassThrough(),
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).rejects.toThrow("Adding an account profile requires --config.");
  });

  it("adds a named environment-backed account to an existing standard configuration without launching its upstream", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "sentry.json");
    await writeFile(configPath, `${JSON.stringify(environmentProfileConfig("sentry"), null, 2)}\n`, { mode: 0o600 });
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    let transcript = "";
    output.on("data", (chunk: Buffer) => { transcript += chunk.toString(); });

    await expect(runSetupCommand({
      addProfile: true,
      config: configPath,
      profile: "govalidate",
      description: "GoValidate Sentry account",
      credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN",
      makeDefault: true
    }, {
      input,
      output,
      cwd: outputRoot,
      launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
    })).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });

    const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
    expect(config).toMatchObject({
      defaultProfile: "govalidate",
      profiles: {
        govalidate: {
          description: "GoValidate Sentry account",
          env: { STATIC_ACCESS_TOKEN: "${STATIC_GOVALIDATE_ACCESS_TOKEN}" },
          policy: "readonly"
        }
      }
    });
    expect(profileReadinessMocks.run).not.toHaveBeenCalled();
    expect(transcript).toContain("Created environment-backed account profile 'govalidate'.");
    expect(transcript).toContain("Enabled required profile-switch confirmation.");
    expect(transcript).toContain("Required explicit selection for destructive tools.");
  });

  it("cancels an interactive environment-backed account setup on EOF or SIGINT before changing the configuration", async () => {
    await mkdir(outputRoot, { recursive: true });
    const configPath = resolve(outputRoot, "environment-account-cancelled.json");
    const original = `${JSON.stringify(environmentProfileConfig("sentry"), null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });

    for (const cancel of [
      (streams: ReturnType<typeof createStreams>) => streams.input.end(),
      (streams: ReturnType<typeof createStreams>) => streams.input.write("\u0003")
    ]) {
      const streams = createStreams();
      const command = runSetupCommand({
        addProfile: true,
        config: configPath
      }, {
        input: streams.input,
        output: streams.output,
        cwd: outputRoot,
        launcher: { command: process.execPath, args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"] }
      });

      await streams.transcript.waitFor("New account profile name");
      cancel(streams);
      await expect(command).rejects.toThrow("Environment-backed account setup was cancelled.");
      streams.input.end();
      expect(await readFile(configPath, "utf8")).toBe(original);
    }
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
      expect(contents).toContain("No browser authorization completed during setup. Connect later to begin the provider's authorization flow.");
      expect(contents).toContain("Next: review the client JSON above, merge it manually, then restart or reconnect the client.");
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
      expect(streams.transcript.contents).toContain(
        `miftah connection list --config '${output}' --client 'claude-desktop'`
      );
      expect(streams.transcript.contents).not.toContain("OAuth issuer URL");
      expect(streams.transcript.contents).not.toContain("client secret");
    } finally {
      await upstream.close();
    }
  });

  it("starts browser sign-in setup from bare guided setup without requiring an OAuth flag", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "guided-browser-sign-in.json");
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const command = runSetupCommand({}, {
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
      await chooseGuidedSource(streams, "remote-sign-in");
      await answer(streams, "Configuration name [miftah-remote]", "posthog-work");
      await answer(streams, "Account profile name [default]", "production");
      await answer(streams, "Account profile description (optional)", "Production analytics");
      await answer(streams, "Remote MCP HTTPS URL", upstream.streamableHttpUrl);
      await answer(streams, "Output location [posthog-work.miftah.json]", "guided-browser-sign-in.json");
      await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");

      await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
      streams.input.end();

      const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
      expect(config).toMatchObject({
        name: "posthog-work",
        defaultProfile: "production",
        profiles: { production: { description: "Production analytics" } }
      });
      if (!("oauth" in config) || !config.oauth) {
        throw new Error("Expected the guided browser sign-in configuration to include a native OAuth binding.");
      }
      expect(Object.values(config.oauth.connections)).toEqual([
        {
          profile: "production",
          upstream: "default",
          resource: "https://mcp.example.test/mcp",
          issuer: "https://mcp.example.test",
          clientRegistration: "dynamic",
          scopes: ["mcp:tools"]
        }
      ]);
      expect(streams.transcript.contents).toContain(guidedSourcePrompt);
      expect(streams.transcript.contents).toContain("OAuth discovery completed for https://mcp.example.test/mcp.");
      expect(streams.transcript.contents).not.toContain("--native-oauth");
      expect(upstream.registrationRequests()).toEqual([]);
      expect(upstream.authorizationRequests()).toEqual([]);
      expect(upstream.tokenExchanges()).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("accepts a bare remote endpoint choice instead of requiring a technical preset name", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "remote-tools.json");
    const nativeOAuthFetch = vi.fn();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch
    });

    await chooseGuidedSource(streams, "remote");
    await answer(streams, "Name [miftah-wrapper]", "remote-tools");
    await answer(streams, "Streamable HTTPS URL", "https://mcp.example.test/mcp");
    await answer(streams, "Credential environment variable name (optional)", "");
    await answer(streams, "Output location [remote-tools.miftah.json]", "remote-tools.json");
    await answer(streams, "Client", "");
    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "remote-tools",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { default: {} }
    });
    expect(nativeOAuthFetch).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain("Generic remote setup did not discover authentication or call the endpoint.");
    expect(streams.transcript.contents).not.toContain("--native-oauth");
    expect(streams.transcript.contents).toContain(
      "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
    );
    expect(streams.transcript.contents).toContain(
      `Next: generate a copy-only client snippet: miftah connection list --config '${output}' --client 'claude-desktop'`
    );
  });

  it("accepts the displayed local executable choice and saves a literal argv configuration", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "local-tools.json");
    const localCommand = process.execPath;
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await chooseGuidedSource(streams, "local executable");
    await answer(streams, "Name [miftah-wrapper]", "local-tools");
    await answer(streams, "Local executable (no shell)", localCommand);
    await answer(streams, "Add a local argument? (yes/no) [no]", "no");
    await answer(streams, "Working directory (absolute path, optional)", "");
    await answer(streams, "Credential environment variable name (optional)", "");
    await answer(
      streams,
      "Miftah will not run this during setup. It will save this executable and argument array without a shell.",
      "yes"
    );
    await answer(streams, "Output location [local-tools.miftah.json]", "local-tools.json");
    await answer(streams, "Client", "");
    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "local-tools",
      upstream: { transport: "stdio", command: localCommand, args: [] },
      profiles: { default: {} }
    });
    expect(streams.transcript.contents).toContain("Local command review: 1 executable with 0 argument(s)");
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

    await chooseGuidedSource(streams, "new");
    await answer(streams, "Name [miftah-wrapper]", "guided");
    await answer(streams, "What do you want to set up? (connector name, remote, or local)", "generic-docker");
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

    await answer(streams, "What do you want to set up? (connector name, remote, or local)", "LOCAL");
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

  it("guides a user through selecting one existing client entry without rendering source credentials", async () => {
    const source = resolve(outputRoot, "claude-desktop.json");
    const output = resolve(outputRoot, "analytics.json");
    const entry = importableClientEntry();
    const secret = "client-source-secret-must-not-be-rendered";
    const document = JSON.stringify({
      mcpServers: {
        analytics: entry,
        private: {
          command: entry.command,
          args: entry.args,
          env: { PRIVATE_TOKEN: secret }
        }
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    await answer(streams, "MCP entry to import (number or exact name)", "1");
    await answer(streams, "Configuration name [miftah-import]", "analytics");
    await answer(streams, "Output location [analytics.miftah.json]", "analytics.json");
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");

    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "analytics",
      upstream: { transport: "stdio", command: entry.command, args: entry.args },
      profiles: { default: { policy: "readonly" } }
    });
    expect(await readFile(source, "utf8")).toBe(document);
    expect(streams.transcript.contents).toContain("Available MCP entries (names only):");
    expect(streams.transcript.contents).toContain("1. analytics");
    expect(streams.transcript.contents).toContain("2. private");
    expect(streams.transcript.contents).not.toContain(secret);
  });

  it("recovers an unsupported guided client entry through a manual local setup without copying source values", async () => {
    const source = resolve(outputRoot, "unsupported-client-entry.json");
    const output = resolve(outputRoot, "manual-recovery.json");
    const secret = "client-source-value-that-must-not-be-rendered";
    const document = JSON.stringify({
      mcpServers: {
        analytics: {
          command: "npx",
          args: ["--yes", "@posthog/mcp@1.2.3", "--project", secret]
        }
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const streams = createStreams();
    const nativeOAuthFetch = vi.fn();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch
    });
    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    await answer(streams, "MCP entry to import (number or exact name)", "analytics");
    await answer(streams, "Configuration name [miftah-import]", "analytics");
    await answer(streams, "Output location [analytics.miftah.json]", "manual-recovery.json");
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");

    await answer(streams, "What do you want to set up? (connector name, remote, or local)", "local");
    await answer(streams, "Local executable (no shell)", process.execPath);
    await answer(streams, "Add a local argument? (yes/no) [no]", "no");
    await answer(streams, "Working directory (absolute path, optional)", "");
    await answer(streams, "Credential environment variable name (optional)", "");
    await answer(
      streams,
      "Miftah will not run this during setup. It will save this executable and argument array without a shell.",
      "yes"
    );
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "", 2);

    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "analytics",
      upstream: { transport: "stdio", command: process.execPath, args: [] },
      profiles: { default: { policy: "readonly" } }
    });
    expect(await readFile(source, "utf8")).toBe(document);
    expect(nativeOAuthFetch).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain(
      "Miftah did not import this entry or write a configuration from it."
    );
    expect(streams.transcript.contents).toContain(
      "Choose 'local' to re-enter a reviewed executable and literal arguments, or 'remote' for a canonical HTTPS endpoint."
    );
    expect(streams.transcript.contents).not.toContain(secret);
    expect(streams.transcript.contents).not.toContain("--project");
  });

  it("recovers a credential-bearing guided client entry through manual local setup without copying source values", async () => {
    const source = resolve(outputRoot, "credential-bearing-client-entry.json");
    const output = resolve(outputRoot, "credential-manual-recovery.json");
    const secret = "client-source-secret-that-must-not-be-rendered";
    const credentialName = "POSTHOG_CLIENT_ENTRY_TOKEN";
    const document = JSON.stringify({
      mcpServers: {
        analytics: {
          command: process.execPath,
          args: ["serve"],
          env: { [credentialName]: secret }
        }
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const streams = createStreams();
    const nativeOAuthFetch = vi.fn();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch
    });
    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    await answer(streams, "MCP entry to import (number or exact name)", "analytics");
    await answer(streams, "Configuration name [miftah-import]", "analytics");
    await answer(streams, "Output location [analytics.miftah.json]", "credential-manual-recovery.json");
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");

    await answer(streams, "What do you want to set up? (connector name, remote, or local)", "local");
    await answer(streams, "Local executable (no shell)", process.execPath);
    await answer(streams, "Add a local argument? (yes/no) [no]", "no");
    await answer(streams, "Working directory (absolute path, optional)", "");
    await answer(streams, "Credential environment variable name (optional)", "");
    await answer(
      streams,
      "Miftah will not run this during setup. It will save this executable and argument array without a shell.",
      "yes"
    );
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "", 2);

    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "analytics",
      upstream: { transport: "stdio", command: process.execPath, args: [] },
      profiles: { default: { policy: "readonly" } }
    });
    expect(await readFile(source, "utf8")).toBe(document);
    expect(nativeOAuthFetch).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain(
      "Miftah did not import this entry or write a configuration from it."
    );
    expect(streams.transcript.contents).not.toContain(secret);
    expect(streams.transcript.contents).not.toContain(credentialName);
  });

  it("honors an exact numeric client entry name before interpreting a list position", async () => {
    const source = resolve(outputRoot, "numeric-entry.json");
    const output = resolve(outputRoot, "numeric-entry.miftah.json");
    const namedTwoUrl = "https://mcp.example.test/named-two";
    const secondEntryUrl = "https://mcp.example.test/second-entry";
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, JSON.stringify({
      mcpServers: {
        "2": { type: "http", url: namedTwoUrl },
        analytics: { type: "http", url: secondEntryUrl }
      }
    }), { mode: 0o600 });
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    await answer(streams, "MCP entry to import (number or exact name)", "2");
    await answer(streams, "Configuration name [miftah-import]", "numeric-entry");
    await answer(streams, "Output location [numeric-entry.miftah.json]", "numeric-entry.miftah.json");
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");

    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();
    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      upstream: { transport: "streamable-http", url: namedTwoUrl }
    });
  });

  it("imports the inspected client file snapshot when its source path changes before entry confirmation", async () => {
    const source = resolve(outputRoot, "changing-client.json");
    const output = resolve(outputRoot, "snapshot.miftah.json");
    const inspectedUrl = "https://mcp.example.test/inspected";
    const changedUrl = "https://mcp.example.test/changed";
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, JSON.stringify({
      mcpServers: { analytics: { type: "http", url: inspectedUrl } }
    }), { mode: 0o600 });
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    await streams.transcript.waitFor("MCP entry to import (number or exact name)");
    await writeFile(source, JSON.stringify({
      mcpServers: { analytics: { type: "http", url: changedUrl } }
    }), { mode: 0o600 });
    await answer(streams, "MCP entry to import (number or exact name)", "analytics");
    await answer(streams, "Configuration name [miftah-import]", "snapshot");
    await answer(streams, "Output location [snapshot.miftah.json]", "snapshot.miftah.json");
    await answer(streams, "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)", "");

    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();
    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      upstream: { transport: "streamable-http", url: inspectedUrl }
    });
  });

  it("rejects an unlisted guided client-entry selection before any configuration write", async () => {
    const source = resolve(outputRoot, "selection-client.json");
    const original = JSON.stringify({ mcpServers: { analytics: importableClientEntry() } });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, original, { mode: 0o600 });
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    await answer(streams, "MCP entry to import (number or exact name)", "missing");

    await expect(command).rejects.toThrow("Choose one listed MCP entry by number or exact name.");
    streams.input.end();
    expect(await readFile(source, "utf8")).toBe(original);
  });

  it("cancels guided client-entry import on EOF or SIGINT before selecting or writing a configuration", async () => {
    const source = resolve(outputRoot, "cancelled-client.json");
    const original = JSON.stringify({ mcpServers: { analytics: importableClientEntry() } });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, original, { mode: 0o600 });

    for (const cancel of [
      (streams: ReturnType<typeof createStreams>) => streams.input.end(),
      (streams: ReturnType<typeof createStreams>) => streams.input.write("\u0003")
    ]) {
      const streams = createStreams();
      const command = runSetupCommand({}, {
        input: streams.input,
        output: streams.output,
        cwd: outputRoot,
        launcher: {
          command: process.execPath,
          args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
        }
      });

      await chooseGuidedSource(streams, "import");
      await streams.transcript.waitFor("Client configuration file (absolute path)");
      cancel(streams);

      await expect(command).rejects.toThrow("Guided client-entry import was cancelled.");
      streams.input.end();
      expect(await readFile(source, "utf8")).toBe(original);
    }
  });

  it("reports guided client-entry cancellation safely between prompts", async () => {
    const source = resolve(outputRoot, "cancel-between-prompts.json");
    const original = JSON.stringify({ mcpServers: { analytics: importableClientEntry() } });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, original, { mode: 0o600 });
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await chooseGuidedSource(streams, "import");
    await answer(streams, "Client configuration file (absolute path)", source);
    streams.input.end();

    await expect(command).rejects.toThrow("Guided client-entry import was cancelled.");
    expect(await readFile(source, "utf8")).toBe(original);
    await expect(readFile(resolve(outputRoot, "miftah-import.miftah.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels the initial guided setup choice on EOF or SIGINT before any configuration write", async () => {
    for (const cancel of [
      (streams: ReturnType<typeof createStreams>) => streams.input.end(),
      (streams: ReturnType<typeof createStreams>) => streams.input.write("\u0003")
    ]) {
      const streams = createStreams();
      const command = runSetupCommand({}, {
        input: streams.input,
        output: streams.output,
        cwd: outputRoot,
        launcher: {
          command: process.execPath,
          args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
        }
      });

      await streams.transcript.waitFor(guidedSourcePrompt);
      cancel(streams);

      await expect(command).rejects.toThrow("Guided setup was cancelled.");
      streams.input.end();
      await expect(readFile(resolve(outputRoot, "miftah-wrapper.miftah.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps an unsupported guided setup starting point on the current step without writing", async () => {
    const streams = createStreams();
    const command = runSetupCommand({}, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await answer(streams, guidedSourcePrompt, "unsupported");
    await streams.transcript.waitFor(guidedSourcePrompt, 2);
    expect(streams.transcript.contents).toContain(
      "Choose 1-5, or enter connector, remote, local, browser sign-in, or import."
    );
    await answer(streams, guidedSourcePrompt, "cancel", 2);
    await expect(command).rejects.toThrow("Guided setup was cancelled.");
    streams.input.end();
    await expect(readFile(resolve(outputRoot, "miftah-wrapper.miftah.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the established setup wizard entry point when --verify is explicit", async () => {
    const streams = createStreams();
    const command = runSetupCommand({ verify: true }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      }
    });

    await streams.transcript.waitFor("Name [miftah-wrapper]");
    expect(streams.transcript.contents).not.toContain("What do you already have?");
    streams.input.end();
    await expect(command).rejects.toThrow("Interactive init was cancelled");
  });

  it("imports one explicitly selected remote HTTPS entry without OAuth discovery or an upstream call", async () => {
    const source = resolve(outputRoot, "cursor-remote.json");
    const output = resolve(outputRoot, "remote-analytics.json");
    const document = JSON.stringify({
      mcpServers: {
        analytics: { type: "http", url: "https://mcp.example.test/mcp" }
      }
    });
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, document, { mode: 0o600 });
    const streams = createStreams();
    const nativeOAuthFetch = vi.fn(async (): Promise<Response> => {
      throw new Error("remote client-entry import must not discover OAuth");
    });

    const result = await runSetupCommand({
      name: "remote-analytics",
      output,
      importFile: source,
      importEntry: "analytics"
    } as Parameters<typeof runSetupCommand>[0], {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch
    });
    streams.input.end();

    expect(result).toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    expect(validateConfig(JSON.parse(await readFile(output, "utf8")))).toMatchObject({
      name: "remote-analytics",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { default: { policy: "readonly" } }
    });
    expect(await readFile(source, "utf8")).toBe(document);
    expect(nativeOAuthFetch).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain(
      "Imported one HTTPS remote MCP entry without copying credentials. Miftah did not discover OAuth or call the upstream."
    );
  });

  it("accepts a remote MCP source without making native OAuth assumptions", async () => {
    const output = resolve(outputRoot, "remote-tools.json");
    const streams = createStreams();
    const nativeOAuthFetch = vi.fn(async (): Promise<Response> => {
      throw new Error("generic remote setup must not attempt OAuth discovery");
    });

    const command = runSetupCommand({
      name: "remote-tools",
      output: "remote-tools.json",
      client: "claude-desktop"
    }, {
      input: streams.input,
      output: streams.output,
      cwd: outputRoot,
      launcher: {
        command: process.execPath,
        args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
      },
      nativeOAuthFetch
    });

    await answer(streams, "What do you want to set up? (connector name, remote, or local)", "REMOTE");
    await answer(streams, "Streamable HTTPS URL", "https://mcp.example.test/mcp");
    await answer(streams, "Credential environment variable name (optional)", "");
    await expect(command).resolves.toEqual({ verification: "not-applicable", exitCode: 0, reports: [] });
    streams.input.end();

    const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
    expect(config).toMatchObject({
      name: "remote-tools",
      defaultProfile: "default",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { default: {} }
    });
    expect(config).not.toHaveProperty("oauth");
    expect(nativeOAuthFetch).not.toHaveBeenCalled();
    expect(streams.transcript.contents).toContain("Created");
    expect(streams.transcript.contents).toContain("Generic remote setup did not discover authentication or call the endpoint.");
    expect(streams.transcript.contents).not.toContain("OAuth discovery completed");
    expect(streams.transcript.contents).not.toContain("fixture-access-token");
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
    expect(streams.transcript.contents).toContain(
      `When ready, run: miftah profile test --config '${configPath}' --profile 'google-personal'.`
    );
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

    await chooseGuidedSource(streams, "new");
    await answer(streams, "Name [miftah-wrapper]", "gsc");
    await answer(streams, "What do you want to set up? (connector name, remote, or local)", "google-search-console");
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

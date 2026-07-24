import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileReadinessMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../src/setup/profile-readiness.js", () => ({
  runProfileReadiness: profileReadinessMocks.run
}));

import { parseCli, renderCommandHelp } from "../src/cli/parse.js";
import { runSetupCommand } from "../src/cli/setup.js";
import { validateConfig } from "../src/config/validate-config.js";

const outputRoot = resolve(process.cwd(), ".setup-command-test-output");

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
    await answer(streams, "Catalog preset [generic]", "");
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
    await answer(streams, "Catalog preset [generic]", "google-search-console");
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

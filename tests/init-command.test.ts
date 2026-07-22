import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { runInitCommand } from "../src/cli/init.js";
import { CliUsageError } from "../src/cli/parse.js";

const outputRoot = resolve(process.cwd(), ".init-command-test-output");

interface TtyStreams {
  readonly input: PassThrough & { isTTY?: boolean };
  readonly output: PassThrough & { isTTY?: boolean };
  readonly transcript: StreamTranscript;
}

class StreamTranscript {
  #contents = "";
  #waiters: Array<{ readonly text: string; readonly resolve: () => void }> = [];

  append(chunk: Buffer | string): void {
    this.#contents += chunk.toString();
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!this.#contents.includes(waiter.text)) return true;
      waiter.resolve();
      return false;
    });
  }

  get contents(): string {
    return this.#contents;
  }

  waitFor(text: string): Promise<void> {
    if (this.#contents.includes(text)) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiters.push({ text, resolve });
    });
  }
}

function createStreams(isTTY = true): TtyStreams {
  const input = Object.assign(new PassThrough(), { isTTY });
  const output = Object.assign(new PassThrough(), { isTTY });
  const transcript = new StreamTranscript();
  output.on("data", (chunk: Buffer) => transcript.append(chunk));
  return { input, output, transcript };
}

function commandContext(streams: TtyStreams) {
  return {
    input: streams.input,
    output: streams.output,
    cwd: outputRoot,
    launcher: {
      command: process.execPath,
      args: [resolve(process.cwd(), "dist/cli/main.js"), "serve"]
    }
  };
}

async function answer(streams: TtyStreams, prompt: string, value: string): Promise<void> {
  await streams.transcript.waitFor(prompt);
  streams.input.write(`${value}\n`);
}

async function expectNoPath(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

beforeEach(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

describe("init command", () => {
  it("keeps noninteractive init config-only output compatible and writes a strict valid config", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "generic.json");

    await runInitCommand({ name: "generic", output: "generic.json" }, commandContext(streams));
    streams.input.end();

    const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
    expect(config.name).toBe("generic");
    expect(streams.transcript.contents).toBe(`Created ${output}\n`);
  });

  it("reports an existing output file as a usage error without changing it", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "existing.json");

    await runInitCommand({ name: "existing", output: "existing.json" }, commandContext(streams));
    const originalContents = await readFile(output, "utf8");

    await expect(
      runInitCommand({ name: "replacement", output: "existing.json" }, commandContext(streams))
    ).rejects.toThrow(CliUsageError);

    expect(await readFile(output, "utf8")).toBe(originalContents);
    streams.input.end();
  });

  it("rejects unknown presets and missing generic metadata before creating output directories", async () => {
    const streams = createStreams();

    await expect(
      runInitCommand({ name: "unknown", preset: "not-a-catalog-preset", output: "unknown/config.json" }, commandContext(streams))
    ).rejects.toThrow(CliUsageError);
    await expect(
      runInitCommand({ name: "npx", preset: "generic-npx", output: "npx/config.json" }, commandContext(streams))
    ).rejects.toThrow(CliUsageError);
    await expect(
      runInitCommand(
        { name: "generic", preset: "generic", npmPackage: "server@1.2.3", output: "inapplicable/config.json" },
        commandContext(streams)
      )
    ).rejects.toThrow(CliUsageError);
    await expect(
      runInitCommand({ name: "client", client: "unsupported", output: "client/config.json" }, commandContext(streams))
    ).rejects.toThrow(CliUsageError);

    await expectNoPath(resolve(outputRoot, "unknown"));
    await expectNoPath(resolve(outputRoot, "npx"));
    await expectNoPath(resolve(outputRoot, "inapplicable"));
    await expectNoPath(resolve(outputRoot, "client"));
    streams.input.end();
  });

  it("prints client snippets with resolved config and absolute launcher values after one config write", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "client.json");

    await runInitCommand({ name: "client", output: "client.json", client: "cursor" }, commandContext(streams));
    streams.input.end();

    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ name: "client" });
    expect(streams.transcript.contents).toContain(`Created ${output}\n`);
    expect(streams.transcript.contents).toContain("Cursor .cursor/mcp.json (cursor):");
    expect(streams.transcript.contents).toContain(JSON.stringify(process.execPath));
    expect(streams.transcript.contents).toContain(JSON.stringify(output));
    const json = streams.transcript.contents.slice(streams.transcript.contents.indexOf("{"));
    expect(JSON.parse(json).mcpServers.client).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [resolve(process.cwd(), "dist/cli/main.js"), "serve", "--config", output]
    });
  });

  it("prints Claude Code permission guidance without writing user settings", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "miftah.json");

    await runInitCommand({ name: "miftah", output: "miftah.json", client: "claude-code" }, commandContext(streams));
    streams.input.end();

    expect(streams.transcript.contents).toContain("Claude Code settings permissions:");
    expect(streams.transcript.contents).toContain('"mcp__miftah__miftah_use_profile"');
    expect(streams.transcript.contents).not.toContain("miftah_approve");
    expect(streams.transcript.contents).toContain("Manually merge this fragment");
    await expectNoPath(resolve(outputRoot, ".claude", "settings.local.json"));
    await expectNoPath(resolve(outputRoot, ".claude", "settings.json"));
    await expect(readFile(output, "utf8")).resolves.toContain('"name": "miftah"');
  });

  it("runs the TTY wizard with real streams for a generic config", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "wizard-generic.json");
    const command = runInitCommand({ interactive: true }, commandContext(streams));

    await answer(streams, "Name [miftah-wrapper]", "wizard-generic");
    await answer(streams, "Catalog preset [generic]", "");
    await answer(streams, "Output location [wizard-generic.miftah.json]", "wizard-generic.json");
    await answer(streams, "Client", "claude-code");
    await command;
    streams.input.end();

    const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
    expect(config.name).toBe("wizard-generic");
    expect(streams.transcript.contents).toContain("Claude Code project .mcp.json (claude-code):");
  });

  it("prompts for generic-npx metadata and validates the resulting config", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "wizard-npx.json");
    const command = runInitCommand(
      { interactive: true, name: "wizard-npx", preset: "generic-npx", output: "wizard-npx.json" },
      commandContext(streams)
    );

    await answer(streams, "NPM package", "@scope/server@1.2.3");
    await answer(streams, "Client", "");
    await command;
    streams.input.end();

    const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
    expect(config.upstream?.args).toEqual(["--yes", "@scope/server@1.2.3"]);
  });

  it("preserves a supported streamable HTTP credential header prefix", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "wizard-http.json");
    const command = runInitCommand(
      { interactive: true, name: "wizard-http", preset: "streamable-http", output: "wizard-http.json" },
      commandContext(streams)
    );

    await answer(streams, "Streamable HTTPS URL", "https://mcp.example.com/v1");
    await answer(streams, "Credential environment variable name", "MCP_TOKEN");
    await answer(streams, "Credential header name", "Authorization");
    await answer(streams, "Credential header prefix", "Bearer ");
    await answer(streams, "Client", "");
    await command;
    streams.input.end();

    const fileConfig = JSON.parse(await readFile(output, "utf8"));
    expect(fileConfig.upstream.headers).toEqual({ Authorization: "Bearer ${MCP_TOKEN}" });
    expect(() => validateConfig(fileConfig)).not.toThrow();
  });

  it("creates the GSC pilot and prints ownership guidance without exposing the configured path", async () => {
    const streams = createStreams();
    const output = resolve(outputRoot, "gsc.json");
    const clientSecretsFile = resolve(outputRoot, "private", "client-secrets.json");

    await runInitCommand(
      {
        name: "gsc",
        preset: "google-search-console",
        output: "gsc.json",
        oauthClientSecretsFile: clientSecretsFile
      },
      commandContext(streams)
    );
    streams.input.end();

    const config = validateConfig(JSON.parse(await readFile(output, "utf8")));
    expect(config.upstream?.args).toEqual(["mcp-search-console@0.3.2"]);
    expect(streams.transcript.contents).toContain("Provider adapter: Google Search Console");
    expect(streams.transcript.contents).toContain("Credential ownership: upstream");
    expect(streams.transcript.contents).toContain("Browser handoff: upstream");
    expect(streams.transcript.contents).toContain("Token store: upstream-private");
    expect(streams.transcript.contents).toContain("Identity evidence: unavailable");
    expect(streams.transcript.contents).toContain("Reauthentication: upstream MCP tool 'reauthenticate'");
    expect(streams.transcript.contents).toContain("Disconnect/revocation: manual-only");
    expect(streams.transcript.contents).toContain("Miftah will not read or manage the upstream token cache.");
    expect(streams.transcript.contents).not.toContain(clientSecretsFile);
  });

  it("normalizes wizard EOF and SIGINT cancellation to usage errors without creating files", async () => {
    const eofStreams = createStreams();
    eofStreams.input.end();
    await expect(runInitCommand({ interactive: true, output: "eof/config.json" }, commandContext(eofStreams))).rejects.toThrow(
      CliUsageError
    );

    const cancelStreams = createStreams();
    const command = runInitCommand({ interactive: true, output: "cancel/config.json" }, commandContext(cancelStreams));
    await cancelStreams.transcript.waitFor("Name");
    cancelStreams.input.write("\u0003");
    await expect(command).rejects.toThrow(CliUsageError);
    cancelStreams.input.end();

    await expectNoPath(resolve(outputRoot, "eof"));
    await expectNoPath(resolve(outputRoot, "cancel"));
  });

  it("does not emit an unhandled rejection when fully supplied wizard input closes", async () => {
    const streams = createStreams();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    queueMicrotask(() => {
      streams.input.write("\u0003");
      streams.input.end();
    });

    try {
      await runInitCommand(
        {
          interactive: true,
          name: "fully-supplied",
          preset: "generic",
          output: "fully-supplied.json",
          client: "all"
        },
        commandContext(streams)
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
    }
  });

  it("rejects interactive init without TTY input and output before creating files", async () => {
    const streams = createStreams(false);

    await expect(runInitCommand({ interactive: true, output: "notty/config.json" }, commandContext(streams))).rejects.toThrow(
      CliUsageError
    );
    await expectNoPath(resolve(outputRoot, "notty"));
    streams.input.end();
  });
});

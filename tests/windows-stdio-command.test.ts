import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsStdioCommand } from "../src/upstream/windows-stdio-command.js";

function resolver(paths: Readonly<Record<string, string | undefined>>) {
  const commands: string[] = [];
  return {
    commands,
    resolveExecutable: async (command: string) => {
      commands.push(command);
      return paths[command];
    }
  };
}

describe("Windows stdio command resolution", () => {
  it("passes a generated runner to the SDK only after it resolves to a direct executable", async () => {
    const files = resolver({ uvx: "C:\\uv\\uvx.exe" });

    await expect(resolveWindowsStdioCommand("uvx", ["mcp-search-console@0.3.2"], {
      platform: "win32",
      resolveExecutable: files.resolveExecutable
    })).resolves.toEqual({
      command: "C:\\uv\\uvx.exe",
      args: ["mcp-search-console@0.3.2"]
    });
    expect(files.commands).toEqual(["uvx"]);
  });

  it("rejects an npx command shim instead of allowing the SDK to fall back to cmd.exe", async () => {
    const files = resolver({ npx: undefined });

    await expect(resolveWindowsStdioCommand("npx", ["--yes", "@scope/server@1.2.3"], {
      platform: "win32",
      resolveExecutable: files.resolveExecutable
    })).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
  });

  it("rejects a command shim even if a future resolver returns it", async () => {
    const files = resolver({ provider: "C:\\tools\\provider.cmd" });

    await expect(resolveWindowsStdioCommand("provider", [], {
      platform: "win32",
      resolveExecutable: files.resolveExecutable
    })).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
  });

  it("rejects an explicit shell executable even when it has a direct executable extension", async () => {
    const files = resolver({ "C:\\Windows\\System32\\cmd.exe": "C:\\Windows\\System32\\cmd.exe" });

    await expect(resolveWindowsStdioCommand("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "server"], {
      platform: "win32",
      resolveExecutable: files.resolveExecutable
    })).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
  });

  it("rejects the legacy Windows command interpreter", async () => {
    const files = resolver({ "C:\\Windows\\System32\\COMMAND.COM": "C:\\Windows\\System32\\COMMAND.COM" });

    await expect(resolveWindowsStdioCommand("C:\\Windows\\System32\\COMMAND.COM", ["/c", "server"], {
      platform: "win32",
      resolveExecutable: files.resolveExecutable
    })).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
  });

  it("rejects a POSIX shell executable even when it has a direct executable extension", async () => {
    const files = resolver({ "C:\\Program Files\\Git\\bin\\bash.exe": "C:\\Program Files\\Git\\bin\\bash.exe" });

    await expect(resolveWindowsStdioCommand("C:\\Program Files\\Git\\bin\\bash.exe", ["-c", "server"], {
      platform: "win32",
      resolveExecutable: files.resolveExecutable
    })).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
  });

  it("rejects a direct-extension file that cross-spawn would reinterpret through a shebang", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-windows-stdio-"));
    const executable = join(directory, "provider.exe");
    try {
      await writeFile(executable, "#!cmd.exe\n", { mode: 0o700 });

      await expect(resolveWindowsStdioCommand(executable, [], { platform: "win32" })).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "rejects a bare npx command when only an npx.cmd shim is on the final PATH",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-windows-stdio-"));
      const commandShim = win32.join(directory, "npx.cmd");
      try {
        await writeFile(commandShim, "", { mode: 0o700 });

        await expect(resolveWindowsStdioCommand("npx", ["--yes", "@scope/server@1.2.3"], {
          platform: "win32",
          environment: { PATH: directory }
        })).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});

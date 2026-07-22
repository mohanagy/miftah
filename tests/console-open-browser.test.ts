import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { browserLaunchCommand, openSystemBrowser } from "../src/console/open-browser.js";

const dashboard = new URL("http://127.0.0.1:43127/");

describe("Console system-browser launch", () => {
  it("uses only fixed platform launchers and rejects non-loopback destinations", () => {
    expect(browserLaunchCommand(dashboard, { platform: "darwin" })).toEqual({
      command: "/usr/bin/open",
      arguments: [dashboard.toString()]
    });
    expect(browserLaunchCommand(dashboard, { platform: "win32" })).toEqual({
      command: "C:\\Windows\\System32\\rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", dashboard.toString()]
    });
    expect(browserLaunchCommand(dashboard, {
      platform: "linux",
      exists: (path) => path === "/bin/xdg-open"
    })).toEqual({ command: "/bin/xdg-open", arguments: [dashboard.toString()] });
    expect(browserLaunchCommand(new URL("https://example.test/"), { platform: "darwin" })).toBeUndefined();
  });

  it("spawns with an argument array and shell disabled", async () => {
    const calls: Array<{ command: string; arguments: readonly string[]; options: Record<string, unknown> }> = [];
    class FakeChild extends EventEmitter {
      unrefCalled = false;
      unref(): void { this.unrefCalled = true; }
    }
    const child = new FakeChild();
    const result = openSystemBrowser(dashboard, {
      platform: "darwin",
      spawn: ((command: string, arguments_: readonly string[], options: Record<string, unknown>) => {
        calls.push({ command, arguments: arguments_, options });
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as never
    });

    await expect(result).resolves.toBe(true);
    expect(calls).toEqual([{
      command: "/usr/bin/open",
      arguments: [dashboard.toString()],
      options: expect.objectContaining({ shell: false, stdio: "ignore", detached: true })
    }]);
    expect(child.unrefCalled).toBe(true);
  });
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface BrowserLaunchCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

interface BrowserLaunchDependencies {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  readonly spawn?: typeof spawn;
}

function isTrustedDashboardUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}

/** Selects only fixed OS launchers for a literal-loopback dashboard URL. */
export function browserLaunchCommand(
  url: URL,
  dependencies: Pick<BrowserLaunchDependencies, "platform" | "exists"> = {}
): BrowserLaunchCommand | undefined {
  if (!isTrustedDashboardUrl(url)) return undefined;
  const platform = dependencies.platform ?? process.platform;
  const target = url.toString();
  if (platform === "darwin") return { command: "/usr/bin/open", arguments: [target] };
  if (platform === "win32") {
    return {
      command: "C:\\Windows\\System32\\rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", target]
    };
  }
  if (platform === "linux") {
    const exists = dependencies.exists ?? existsSync;
    const command = ["/usr/bin/xdg-open", "/bin/xdg-open"].find((candidate) => exists(candidate));
    return command === undefined ? undefined : { command, arguments: [target] };
  }
  return undefined;
}

/** Opens the optional dashboard without a command shell; failure leaves the printed URL usable. */
export async function openSystemBrowser(
  url: URL,
  dependencies: BrowserLaunchDependencies = {}
): Promise<boolean> {
  const launch = browserLaunchCommand(url, dependencies);
  if (launch === undefined) return false;
  const spawnProcess = dependencies.spawn ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    try {
      const child = spawnProcess(launch.command, [...launch.arguments], {
        shell: false,
        stdio: "ignore",
        detached: true,
        windowsHide: true
      });
      child.once("error", () => finish(false));
      child.once("spawn", () => {
        child.unref();
        finish(true);
      });
    } catch {
      finish(false);
    }
  });
}

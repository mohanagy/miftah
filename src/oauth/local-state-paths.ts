import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

/** Returns the restrictive non-secret OAuth metadata location for the current OS user. */
export function defaultOAuthConnectionMetadataPath(): string {
  if (platform() === "win32") {
    const configured = process.env.LOCALAPPDATA;
    const root = configured !== undefined && isAbsolute(configured)
      ? configured
      : join(homedir(), "AppData", "Local");
    return join(root, "Miftah", "oauth-connections.json");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Miftah", "oauth-connections.json");
  }
  const configured = process.env.XDG_STATE_HOME;
  const root = configured !== undefined && isAbsolute(configured)
    ? configured
    : join(homedir(), ".local", "state");
  return join(root, "miftah", "oauth-connections.json");
}

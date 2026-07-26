import { loadConfig } from "../config/load-config.js";
import { profileInventory, type ProfileInventory } from "../profiles/profile-inventory.js";

export interface ProfileListCommandOptions {
  readonly configPath: string;
}

/** Reads only validated configuration and returns its fixed non-secret account inventory. */
export async function runProfileListCommand(options: ProfileListCommandOptions): Promise<ProfileInventory> {
  return profileInventory(await loadConfig(options.configPath));
}

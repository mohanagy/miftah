import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createWindowsPrivateDirectory,
  verifyWindowsConfigPathSecurity
} from "../../src/cli/windows-config-acl.js";

/**
 * Creates a child directory suitable for Console tests that exercise the
 * production configuration trust boundary. Windows tests must not rely on the
 * broadly writable system temporary directory as a trusted configuration root.
 */
export async function createPrivateConsoleDirectory(parent: string, name = "config-root"): Promise<string> {
  const directory = join(parent, name);
  if (process.platform !== "win32") {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    return directory;
  }

  if (!(await createWindowsPrivateDirectory(directory))) {
    throw new Error("Unable to create a private Windows Console test directory.");
  }
  if (!(await verifyWindowsConfigPathSecurity(directory, "directory"))) {
    throw new Error("Windows Console test directory did not pass production ACL verification.");
  }
  return directory;
}

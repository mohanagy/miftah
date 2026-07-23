import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWindowsPrivateDirectory,
  secureWindowsConfigFile,
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

/** Writes a fresh fixture file only after its Windows ACL is private and verified. */
export async function writePrivateConsoleFile(path: string, content: string): Promise<void> {
  if (process.platform !== "win32") {
    await writeFile(path, content, { mode: 0o600 });
    await chmod(path, 0o600);
    return;
  }
  const handle = await open(path, "wx", 0o600);
  try {
    if (!(await secureWindowsConfigFile(path))) {
      throw new Error("Unable to apply a private Windows ACL to a Console test fixture file.");
    }
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

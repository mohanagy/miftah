import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ClientEntryImportError } from "./client-entry-import.js";

const maximumClientEntryImportBytes = 64 * 1024;
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const readOnlyFlags = constants.O_RDONLY | noFollowFlag;

function sameEntry(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRegularNonSymlink(entry: Stats): boolean {
  return entry.isFile() && !entry.isSymbolicLink();
}

function sourceFileError(): never {
  throw new ClientEntryImportError(
    "The selected client configuration must be an absolute regular non-symlink JSON file no larger than 64 KiB."
  );
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.length) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    if (bytesRead === 0) sourceFileError();
    offset += bytesRead;
  }
  return content;
}

/**
 * Reads a user-selected client configuration through one verified file handle.
 * The caller must still select an entry and pass the returned text to the pure importer.
 */
export async function readClientEntryImportFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) sourceFileError();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const observed = await lstat(path);
    if (!isRegularNonSymlink(observed)) sourceFileError();
    const canonical = await realpath(path);
    const resolved = await stat(canonical);
    if (!isRegularNonSymlink(resolved) || !sameEntry(observed, resolved)) sourceFileError();

    handle = await open(canonical, readOnlyFlags);
    const opened = await handle.stat();
    if (
      !isRegularNonSymlink(opened)
      || !sameEntry(observed, opened)
      || !Number.isSafeInteger(opened.size)
      || opened.size < 0
      || opened.size > maximumClientEntryImportBytes
    ) {
      sourceFileError();
    }
    const content = await readExact(handle, opened.size);
    const afterRead = await handle.stat();
    if (
      !isRegularNonSymlink(afterRead) ||
      !sameEntry(observed, afterRead) ||
      afterRead.size !== opened.size ||
      content.byteLength > maximumClientEntryImportBytes
    ) {
      sourceFileError();
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      sourceFileError();
    }
  } catch (error) {
    if (error instanceof ClientEntryImportError) throw error;
    sourceFileError();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        sourceFileError();
      }
    }
  }
  sourceFileError();
}

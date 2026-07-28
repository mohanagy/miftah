import { watch } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";

export interface PathArrivalWatch {
  readonly wait: Promise<void>;
  close(): void;
}

/** Arms a filesystem event before child-process work, avoiding a polling race with process startup. */
export function watchForPathArrival(path: string): PathArrivalWatch {
  let watcher: ReturnType<typeof watch> | undefined;
  let fallbackPoll: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveWait!: () => void;
  let rejectWait!: (error: unknown) => void;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  /** Completes the watch exactly once and releases every observation resource. */
  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    watcher?.close();
    if (fallbackPoll !== undefined) clearInterval(fallbackPoll);
    if (error === undefined) resolveWait();
    else rejectWait(error);
  };
  /** Checks the exact path after a directory event or fallback polling tick. */
  const verify = () => {
    void access(path).then(
      () => settle(),
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") settle(error);
      }
    );
  };
  try {
    watcher = watch(dirname(path), { persistent: false }, verify);
    watcher.on("error", settle);
  } catch (error) {
    settle(error);
  }
  if (!settled) {
    // fs.watch can drop directory events under load, so keep verifying the exact
    // path without imposing a shorter deadline than the owning test.
    fallbackPoll = setInterval(verify, 50);
    fallbackPoll.unref();
    verify();
  }
  return {
    wait,
    close: () => {
      watcher?.close();
      if (fallbackPoll !== undefined) clearInterval(fallbackPoll);
      if (!settled) {
        settled = true;
        resolveWait();
      }
    }
  };
}

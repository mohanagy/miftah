import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const retainDescendantPath = process.env.TEST_RETAIN_STDIO_DESCENDANT_PATH;
const shouldRetainStdio = retainDescendantPath === undefined || existsSync(retainDescendantPath);

if (shouldRetainStdio) {
  const descendantPidPath = process.env.TEST_RETAINED_STDIO_DESCENDANT_PID_PATH;
  if (!descendantPidPath) {
    throw new Error("TEST_RETAINED_STDIO_DESCENDANT_PID_PATH is required when retaining stdio");
  }

  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000);"], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  if (descendant.pid === undefined) {
    throw new Error("Unable to start retained stdio descendant");
  }
  writeFileSync(descendantPidPath, String(descendant.pid));
}

await import("./fake-upstream.mjs");

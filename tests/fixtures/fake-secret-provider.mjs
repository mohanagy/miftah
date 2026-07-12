#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";

const mode = process.env.MIFTAH_FAKE_MODE ?? "success";
const recordPath = process.env.MIFTAH_FAKE_RECORD_PATH;
const countPath = process.env.MIFTAH_FAKE_COUNT_PATH;

if (
  process.env.MIFTAH_FAKE_REQUIRE_REGISTRATION === "true" &&
  process.env.MIFTAH_FAKE_REGISTRATION_MARKER !== "registered"
) {
  process.exit(1);
}
if (recordPath) {
  await writeFile(
    recordPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      mode,
      hasOpServiceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
      keychainEnvironment: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("MIFTAH_KEYCHAIN_"))
      )
    })
  );
}
if (countPath) await appendFile(countPath, "1\n");

if (mode === "sleep") {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  process.stdout.write(process.env.MIFTAH_FAKE_VALUE ?? "fixture-secret");
} else if (mode === "descendant") {
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "inherit" });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
} else if (mode === "early-exit-descendant") {
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "inherit" });
  process.exit(0);
} else if (mode === "locked") {
  process.stderr.write("fixture locked raw provider detail\n");
  process.exitCode = 1;
} else if (mode === "missing") {
  process.stderr.write("fixture item not found raw provider detail\n");
  process.exitCode = 1;
} else if (mode === "empty") {
  process.stdout.write("");
} else if (mode === "nul") {
  process.stdout.write("value\u0000with-nul");
} else if (mode === "large") {
  process.stdout.write("x".repeat(70 * 1024));
} else if (mode === "newline") {
  process.stdout.write(`${process.env.MIFTAH_FAKE_VALUE ?? "fixture-secret"}\r\n`);
} else {
  process.stdout.write(process.env.MIFTAH_FAKE_VALUE ?? "fixture-secret");
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";

const mode = process.env.MIFTAH_FAKE_MODE ?? "success";
const recordPath = process.env.MIFTAH_FAKE_RECORD_PATH;
const countPath = process.env.MIFTAH_FAKE_COUNT_PATH;

async function writeRecord(descendantPid) {
  if (!recordPath) return;
  await writeFile(
    recordPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      mode,
      hasOpServiceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
      keychainEnvironment: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("MIFTAH_KEYCHAIN_"))
      ),
      ...(descendantPid === undefined ? {} : { descendantPid })
    })
  );
}

async function spawnDescendant() {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], { stdio: "inherit" });
  if (descendant.pid === undefined) throw new Error("Fake descendant did not start");
  await writeRecord(descendant.pid);
}

if (
  process.env.MIFTAH_FAKE_REQUIRE_REGISTRATION === "true" &&
  process.env.MIFTAH_FAKE_REGISTRATION_MARKER !== "registered"
) {
  process.exit(1);
}
if (mode !== "descendant" && mode !== "early-exit-descendant") await writeRecord();
if (countPath) await appendFile(countPath, "1\n");

if (mode === "sleep") {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  process.stdout.write(process.env.MIFTAH_FAKE_VALUE ?? "fixture-secret");
} else if (mode === "descendant") {
  await spawnDescendant();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
} else if (mode === "early-exit-descendant") {
  await spawnDescendant();
  process.exit(0);
} else if (mode === "locked") {
  process.stderr.write("fixture locked raw provider detail\n");
  process.exitCode = 1;
} else if (mode === "noninteractive") {
  process.stderr.write("fixture interaction not allowed in non-interactive mode\n");
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
} else if (mode === "large-stderr") {
  process.stderr.write("x".repeat(16 * 1024));
  process.exitCode = 1;
} else if (mode === "newline") {
  process.stdout.write(`${process.env.MIFTAH_FAKE_VALUE ?? "fixture-secret"}\r\n`);
} else {
  process.stdout.write(process.env.MIFTAH_FAKE_VALUE ?? "fixture-secret");
}

import { writeFileSync } from "node:fs";
import { setTimeout } from "node:timers";

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.method !== "initialize" || message.id === undefined) continue;
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: {},
        serverInfo: { name: "shutdown-delay-upstream", version: "1.0.0" }
      }
    })}\n`);
  }
});

process.stdin.on("end", () => {
  const markerPath = process.env.TEST_SHUTDOWN_END_PATH;
  if (markerPath !== undefined) writeFileSync(markerPath, "ended", { mode: 0o600 });
  const delayMs = Number(process.env.TEST_SHUTDOWN_DELAY_MS ?? "0");
  setTimeout(() => process.exit(0), Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0);
});

process.stdin.resume();

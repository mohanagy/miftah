import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });

input.once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        capabilities: {},
        serverInfo: { name: process.env.TEST_MALFORMED_SECRET ?? "malformed", version: 1 }
      }
    })}\n`
  );
});

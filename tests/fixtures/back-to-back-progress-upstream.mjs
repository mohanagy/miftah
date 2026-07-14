import { createInterface } from "node:readline";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendBatch(messages) {
  process.stdout.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { resources: {} },
        serverInfo: { name: "back-to-back-progress-upstream", version: "1.0.0" }
      }
    });
    return;
  }
  if (request.method === "resources/templates/list") {
    const progressToken = request.params?._meta?.progressToken;
    sendBatch([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: 1, total: 2 }
      },
      { jsonrpc: "2.0", id: request.id, result: { resourceTemplates: [] } }
    ]);
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});

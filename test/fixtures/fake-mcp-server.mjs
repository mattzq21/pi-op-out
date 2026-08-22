import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi-desktop-test", version: "1" } } })}\n`);
  } else if (message.method === "tools/list") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text for integration tests", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } })}\n`);
  } else if (message.method === "tools/call") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] } })}\n`);
  }
}

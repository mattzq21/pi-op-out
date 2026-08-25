// @vitest-environment node
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ReturnType<typeof spawn>[] = [];
const httpServers: Server[] = [];
afterEach(() => { children.splice(0).forEach((child) => child.kill()); httpServers.splice(0).forEach((server) => server.close()); });

async function probeRegisteredTools(temporary: string, servers: unknown[], environment: Record<string, string> = {}) {
  const config = join(temporary, "servers.json"); const probe = join(temporary, "tools.json");
  await writeFile(config, JSON.stringify(servers));
  const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "--approve", "--no-skills", "--extension", resolve("src-tauri/resources/mcp-bridge.ts"), "--extension", resolve("test/fixtures/probe-tools.ts")], {
    cwd: resolve("."), env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: temporary, PI_DESKTOP_MCP_CONFIG: config, PI_DESKTOP_TOOL_PROBE: probe, ...environment }, stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Pi MCP startup timed out: ${stderr}`)), 12_000); let buffer = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { buffer += chunk; if (buffer.split("\n").some((line) => { try { return JSON.parse(line).id === "state"; } catch { return false; } })) { clearTimeout(timeout); resolvePromise(); } });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Pi exited with ${code}: ${stderr}\n${buffer}`)); });
  });
  return JSON.parse(await readFile(probe, "utf8")) as string[];
}

describe("MCP bridge extension", () => {
  it("discovers an MCP server and registers its tools in Pi", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-"));
    const tools = await probeRegisteredTools(temporary, [{ id: "fixture", name: "Fixture", transport: "stdio", command: process.execPath, args: "test/fixtures/fake-mcp-server.mjs", enabled: true }]);
    expect(tools).toContain("mcp_fixture_echo");
  }, 15_000);

  it("supports Streamable HTTP servers with sessions and SSE responses", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-http-"));
    let sawSession = false; let sawProtocol = false; let sawCustomHeader = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sawCustomHeader ||= request.headers["x-test"] === "bridge";
      if (message.method === "initialize") {
        response.setHeader("Content-Type", "application/json"); response.setHeader("Mcp-Session-Id", "test-session");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-test", version: "1" } } })); return;
      }
      sawSession ||= request.headers["mcp-session-id"] === "test-session";
      sawProtocol ||= request.headers["mcp-protocol-version"] === "2025-06-18";
      if (message.method === "notifications/initialized") { response.statusCode = 202; response.end(); return; }
      response.setHeader("Content-Type", "text/event-stream");
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] } })}\n\n`);
    });
    httpServers.push(server); await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");

    const tools = await probeRegisteredTools(temporary, [{ id: "remote", name: "Remote", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: '{"X-Test":"bridge"}', enabled: true }]);
    expect(tools).toContain("mcp_remote_echo");
    expect(sawSession).toBe(true); expect(sawProtocol).toBe(true); expect(sawCustomHeader).toBe(true);
  }, 15_000);

  it("loads only MCP servers allowed for a spawned agent", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-policy-")); const server = { name: "Fixture", transport: "stdio", command: process.execPath, args: resolve("test/fixtures/fake-mcp-server.mjs"), enabled: true };
    const tools = await probeRegisteredTools(temporary, [{ ...server, id: "allowed" }, { ...server, id: "denied" }], { PI_DESKTOP_MCP_ALLOWED_SERVER_IDS: "allowed" });
    expect(tools).toContain("mcp_allowed_echo"); expect(tools).not.toContain("mcp_denied_echo");
  }, 15_000);
});

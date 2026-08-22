// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => children.splice(0).forEach((child) => child.kill()));

describe("MCP bridge extension", () => {
  it("discovers an MCP server and registers its tools in Pi", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-"));
    const config = join(temporary, "servers.json"); const probe = join(temporary, "tools.json");
    await writeFile(config, JSON.stringify([{ id: "fixture", name: "Fixture", command: process.execPath, args: "test/fixtures/fake-mcp-server.mjs", enabled: true }]));
    const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "--approve", "--extension", resolve("src-tauri/resources/mcp-bridge.ts"), "--extension", resolve("test/fixtures/probe-tools.ts")], {
      cwd: resolve("."), env: { ...process.env, PI_DESKTOP_MCP_CONFIG: config, PI_DESKTOP_TOOL_PROBE: probe }, stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Pi MCP startup timed out: ${stderr}`)), 12_000); let buffer = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { buffer += chunk; if (buffer.split("\n").some((line) => { try { return JSON.parse(line).id === "state"; } catch { return false; } })) { clearTimeout(timeout); resolvePromise(); } });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Pi exited with ${code}: ${stderr}`)); });
    });
    const tools = JSON.parse(await readFile(probe, "utf8")) as string[];
    expect(tools).toContain("mcp_fixture_echo");
  }, 15_000);
});

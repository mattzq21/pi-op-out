// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = []; const temporaryDirectories: string[] = [];
afterEach(async () => { children.splice(0).forEach((child) => child.kill()); await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function encode(value: unknown) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode<T>(value: string) { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T; }

function rpcProcess(args: string[], environment: Record<string, string> = {}) {
  const temporary = temporaryDirectories.at(-1)!;
  const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "--approve", "--no-skills", ...args], { cwd: resolve("."), env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: temporary, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child); const events: unknown[] = []; const waiters = new Set<() => void>(); let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8"); let buffer = ""; child.stdout.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); try { events.push(JSON.parse(line)); waiters.forEach((wake) => wake()); } catch { /* ignore non-RPC output */ } } });
  const waitFor = <T,>(predicate: (event: any) => event is T, timeoutMs = 12_000) => new Promise<T>((resolvePromise, reject) => {
    const inspect = () => { const found = events.find(predicate) as T | undefined; if (found !== undefined) { clearTimeout(timeout); waiters.delete(inspect); resolvePromise(found); } };
    const timeout = setTimeout(() => { waiters.delete(inspect); reject(new Error(`Pi RPC event timed out: ${stderr}`)); }, timeoutMs); waiters.add(inspect); inspect();
  });
  child.once("exit", (code) => waiters.forEach((wake) => wake()));
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  return { child, send, waitFor };
}

describe("Pi orchestration extension", () => {
  it("publishes, selects, and persists its capability configuration", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-extension-")); temporaryDirectories.push(temporary);
    const extension = join(temporary, "index.ts"); const configPath = join(temporary, "config.json"); const toolsPath = join(temporary, "tools.json");
    await copyFile(resolve("extensions/pi-orchestration/index.ts"), extension); await copyFile(resolve("extensions/pi-orchestration/config.example.json"), configPath);
    const rpc = rpcProcess(["--extension", resolve("test/fixtures/probe-tools.ts"), "--extension", extension], { PI_DESKTOP_TOOL_PROBE: toolsPath });
    const initial = await rpc.waitFor<{ statusText: string }>((event): event is { statusText: string } => event?.type === "extension_ui_request" && event.statusKey === "pi-desktop-orchestration");
    expect(decode<any>(initial.statusText.slice(5))).toMatchObject({ version: 1, active: "default" });
    expect(JSON.parse(await readFile(toolsPath, "utf8"))).toContain("call_agent");

    rpc.send({ id: "use", type: "prompt", message: "/pi-orchestration-use orchestrator" });
    const selected = await rpc.waitFor<{ statusText: string }>((event): event is { statusText: string } => event?.statusKey === "pi-desktop-orchestration" && event.statusText !== initial.statusText);
    expect(decode<any>(selected.statusText.slice(5)).active).toBe("orchestrator");

    const config = { agents: [{ name: "default", description: "Défaut", model: "", effort: "off", systemPrompt: "Réponds précisément", developerPrompt: "", agentsMd: "", tools: ["read"], skills: [], mcpServers: [] }], sequences: [] };
    rpc.send({ id: "config", type: "prompt", message: `/pi-orchestration-config ${encode(config)}` });
    await rpc.waitFor((event): event is { id: string; success: boolean } => event?.id === "config" && event.success === true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
  }, 20_000);

  it("migrates legacy desktop agents and sequences without deleting their files", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-migration-")); temporaryDirectories.push(temporary);
    const extensionDirectory = join(temporary, ".pi", "agent", "extensions", "pi-orchestration"); const extension = join(extensionDirectory, "index.ts");
    const legacyDirectory = join(temporary, ".pi-desktop", "agents"); const settingsDirectory = join(temporary, ".config", "dev.pi.desktop");
    await Promise.all([mkdir(extensionDirectory, { recursive: true }), mkdir(legacyDirectory, { recursive: true }), mkdir(settingsDirectory, { recursive: true })]);
    await copyFile(resolve("extensions/pi-orchestration/index.ts"), extension);
    await writeFile(join(legacyDirectory, "default.yaml"), "name: default\ndescription: Legacy agent\nmodel: ''\neffort: medium\nsystemPrompt: |-\n  Keep the old instructions.\ntools:\n- read\nskills: []\nmcpServers: []\n");
    await writeFile(join(settingsDirectory, "settings.json"), JSON.stringify({ activeAgent: "default", sequences: [{ name: "legacy-sequence", description: "", agents: ["default"], visibleSteps: 1 }] }));
    const rpc = rpcProcess(["--extension", extension]);
    const status = await rpc.waitFor<{ statusText: string }>((event): event is { statusText: string } => event?.statusKey === "pi-desktop-orchestration"); const capability = decode<any>(status.statusText.slice(5));
    expect(capability.config.agents[0]).toMatchObject({ name: "default", description: "Legacy agent", systemPrompt: "Keep the old instructions.", tools: ["read"] });
    expect(capability.config.sequences).toEqual([{ name: "legacy-sequence", description: "", agents: ["default"], visibleSteps: 1 }]);
    expect(await readFile(join(legacyDirectory, "default.yaml"), "utf8")).toContain("Legacy agent");
    expect(JSON.parse(await readFile(join(extensionDirectory, "config.json"), "utf8"))).toEqual(capability.config);
  }, 20_000);

  it("activates a spawned agent's permitted configured tools inside Pi", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-child-")); temporaryDirectories.push(temporary);
    const extension = join(temporary, "index.ts"); const probe = join(temporary, "active-tools.json");
    await copyFile(resolve("extensions/pi-orchestration/index.ts"), extension);
    const agent = { name: "reader", description: "", model: "", effort: "off", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read"], skills: [], mcpServers: [] };
    const rpc = rpcProcess(["--extension", extension, "--extension", resolve("test/fixtures/probe-tools.ts")], { PI_ORCHESTRATION_CHILD: encode(agent), PI_DESKTOP_ALLOWED_TOOLS: JSON.stringify(["read"]), PI_DESKTOP_TOOL_PROBE: probe, PI_DESKTOP_PROBE_ACTIVE: "1" });
    rpc.send({ id: "state", type: "get_state" }); await rpc.waitFor((event): event is { id: string } => event?.id === "state");
    expect(JSON.parse(await readFile(probe, "utf8"))).toEqual(["read"]);
  }, 20_000);

  it("exits a spawned agent run with failure when its configured tool is denied", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-child-denied-")); temporaryDirectories.push(temporary);
    const extension = join(temporary, "index.ts"); await copyFile(resolve("extensions/pi-orchestration/index.ts"), extension);
    const agent = { name: "writer", description: "", model: "", effort: "off", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["write"], skills: [], mcpServers: [] };
    const child = spawn("pi", ["--mode", "rpc", "--approve", "--no-skills", "--no-session", "--offline", "--extension", extension], {
      cwd: resolve("."), env: { ...process.env, HOME: temporary, XDG_CONFIG_HOME: temporary, PI_ORCHESTRATION_CHILD: encode(agent), PI_DESKTOP_ALLOWED_TOOLS: JSON.stringify(["read"]) }, stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child); let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolveExit, reject) => { const timeout = setTimeout(() => { child.kill(); reject(new Error(`Spawned Pi did not exit: ${stderr}`)); }, 12_000); child.once("close", (exitCode) => { clearTimeout(timeout); resolveExit(exitCode); }); });
    expect(code).not.toBe(0); expect(stderr).toContain('Agent "writer" cannot run because Pi does not allow its configured tool: write');
  }, 20_000);

  it("blocks an agent run when Pi disallows or does not provide a configured tool", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-tools-denied-")); temporaryDirectories.push(temporary);
    const extension = join(temporary, "index.ts"); const configPath = join(temporary, "config.json");
    await copyFile(resolve("extensions/pi-orchestration/index.ts"), extension);
    const agent = { name: "default", description: "", model: "", effort: "off", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read", "write", "ghost-tool"], skills: [], mcpServers: [] };
    await writeFile(configPath, JSON.stringify({ agents: [agent], sequences: [] }));
    const rpc = rpcProcess(["--extension", extension], { PI_DESKTOP_ALLOWED_TOOLS: JSON.stringify(["read", "ghost-tool"]) });
    await rpc.waitFor((event): event is { statusKey: string } => event?.statusKey === "pi-desktop-orchestration");
    rpc.send({ id: "blocked", type: "prompt", message: "This must not start an agent" });
    const notice = await rpc.waitFor<{ method: string; message: string }>((event): event is { method: string; message: string } => event?.type === "extension_ui_request" && event.method === "notify" && /cannot run/.test(event.message));
    expect(notice.message).toContain('Agent "default" cannot run'); expect(notice.message).toContain("write"); expect(notice.message).toContain("ghost-tool");
    rpc.send({ id: "state-after-block", type: "get_state" }); const state = await rpc.waitFor<any>((event): event is any => event?.id === "state-after-block" && event.success === true);
    expect(state.data).toMatchObject({ isStreaming: false, messageCount: 0 });
  }, 20_000);

  it("reloads only the current sequence agent's globally enabled skills", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-orchestration-skills-")); temporaryDirectories.push(temporary);
    const extension = join(temporary, "index.ts"); const configPath = join(temporary, "config.json"); const allowed = join(temporary, "allowed"); const denied = join(temporary, "denied");
    await Promise.all([mkdir(allowed), mkdir(denied)]); await copyFile(resolve("extensions/pi-orchestration/index.ts"), extension);
    await writeFile(join(allowed, "SKILL.md"), "---\nname: allowed\ndescription: Allowed skill\n---\n"); await writeFile(join(denied, "SKILL.md"), "---\nname: denied\ndescription: Denied skill\n---\n");
    const profile = { description: "", model: "", effort: "off", systemPrompt: "", developerPrompt: "", agentsMd: "", tools: ["read"], mcpServers: [] };
    const config = { agents: [{ ...profile, name: "default", skills: [allowed] }, { ...profile, name: "reviewer", skills: [denied] }], sequences: [{ name: "review", description: "", agents: ["default", "reviewer"], visibleSteps: 2 }] };
    await writeFile(configPath, JSON.stringify(config)); const rpc = rpcProcess(["--extension", extension], { PI_DESKTOP_SKILL_PATHS: JSON.stringify([allowed, denied]) });
    await rpc.waitFor((event): event is { statusKey: string } => event?.statusKey === "pi-desktop-orchestration"); rpc.send({ id: "use-review", type: "prompt", message: "/pi-orchestration-use review" }); await rpc.waitFor((event): event is any => event?.id === "use-review" && event.success === true);
    rpc.send({ id: "commands-first", type: "get_commands" }); const first = await rpc.waitFor<any>((event): event is any => event?.id === "commands-first" && event.success === true); const firstNames = first.data.commands.map((command: { name: string }) => command.name);
    expect(firstNames).toContain("skill:allowed"); expect(firstNames).not.toContain("skill:denied");
    rpc.send({ id: "next", type: "prompt", message: `/pi-orchestration-next ${encode({ sequence: "review", index: 1, handoff: "" })}` }); await rpc.waitFor((event): event is any => event?.id === "next" && event.success === true);
    const stepStatus = await rpc.waitFor<{ statusText: string }>((event): event is { statusText: string } => event?.statusKey === "pi-desktop-orchestration" && decode<any>(event.statusText.slice(5)).currentAgent === "reviewer"); expect(decode<any>(stepStatus.statusText.slice(5)).active).toBe("review");
    rpc.send({ id: "commands-second", type: "get_commands" }); const second = await rpc.waitFor<any>((event): event is any => event?.id === "commands-second" && event.success === true); const secondNames = second.data.commands.map((command: { name: string }) => command.name);
    expect(secondNames).toContain("skill:denied"); expect(secondNames).not.toContain("skill:allowed");
  }, 20_000);
});

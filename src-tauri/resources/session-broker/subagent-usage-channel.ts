import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";

const fileErrorSchema = Type.Object({ code: Type.String() });

type Channel = { port: number; token: string; usageProtocol: number; startedAt?: number; offset?: number };

const channelPath = (path: string) => `${path}.goal-usage.json`;

const channelUpdateScript = `
  const fs = require("node:fs");
  const http = require("node:http");
  const [path, temporary, action] = process.argv.slice(1);
  const next = JSON.parse(fs.readFileSync(0, "utf8"));
  function readOwner() {
    let content;
    try { content = fs.readFileSync(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try { return JSON.parse(content); }
    catch (error) { if (error instanceof SyntaxError) return; throw error; }
  }
  function identity(pid) {
    if (process.platform !== "linux") return;
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + started;
  }
  function listening(owner) {
    if (!Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || typeof owner.token !== "string") return false;
    return new Promise((resolve, reject) => {
      const authenticated = owner.protocol === 1;
      const request = http.request({ host: "127.0.0.1", port: owner.port, path: authenticated ? "/owner" : "/usage", method: authenticated ? "GET" : "POST", headers: { Authorization: "Bearer " + owner.token, "Content-Type": "application/json" } }, response => {
        response.resume();
        resolve(authenticated ? response.statusCode === 204 && response.headers["x-piop-usage-token"] === owner.token : response.statusCode === 204 || response.statusCode === 500);
      });
      request.setTimeout(2000, () => request.destroy(new Error("Existing subagent usage listener did not respond")));
      request.on("error", error => { if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") resolve(false); else reject(error); });
      request.end(authenticated ? undefined : '{"total":0}');
    });
  }
  async function claim() {
    const owner = readOwner();
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && owner.pid <= 2147483647) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return publish(); if (error.code !== "EPERM") throw error; }
      let current;
      try { current = identity(owner.pid); }
      catch (error) { if (error.code === "ENOENT") return publish(); throw error; }
      if (owner.identity && current && owner.identity !== current) return publish();
      if (await listening(owner)) throw new Error("Subagent usage channel is already owned by a running process");
    }
    publish();
  }
  function publish() {
    process.kill(next.pid, 0);
    next.identity = identity(next.pid);
    next.protocol = 1;
    fs.rmSync(temporary, { force: true });
    try {
      const file = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(file, JSON.stringify(next)); fs.fsyncSync(file); }
      finally { fs.closeSync(file); }
      fs.renameSync(temporary, path);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  async function update() {
    if (action === "claim") await claim();
    else if (readOwner()?.token === next.token) fs.rmSync(path, { force: true });
  }
  update().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;

async function prepareChannelDirectory(path: string, directory: string) {
  const transcript = await lstat(path);

  if (!transcript.isFile() || transcript.isSymbolicLink()) throw new Error("Subagent usage requires a saved session file");
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function channelDirectory(path: string, action: "claim" | "close") {
  if (!path.endsWith(".jsonl")) throw new Error("Subagent usage requires a saved session");

  const directory = path.replace(/\.jsonl$/, ".snapshots");

  if (action === "claim") await prepareChannelDirectory(path, directory);

  const info = await lstat(directory).catch(error => {
    if (action === "close" && Check(fileErrorSchema, error) && error.code === "ENOENT") return;
    throw error;
  });

  if (!info) return;

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Subagent usage storage must be a directory");

  return directory;
}

async function updateChannel(path: string, action: "claim" | "close", channel: Channel & { pid: number }) {
  const directory = await channelDirectory(path, action);

  if (!directory) return;

  return new Promise<void>((resolve, reject) => {
    const child = execFile("flock", ["--exclusive", "--wait", "10", "--no-fork", join(directory, "subagent-usage.lock"), process.execPath, "-e", channelUpdateScript, channelPath(path), join(directory, "subagent-usage.pending"), action], { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8" }, (error, _output, stderr) => {
      if (error) reject(new Error(`Could not ${action} subagent usage channel: ${stderr.trim() || error.message}`));
      else resolve();
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(channel));
  });
}


export async function claimUsageChannel(path: string, port: number, token: string, scope?: { startedAt: number; offset?: number }) {
  const channel = { port, token, pid: process.pid, usageProtocol: 2, ...scope };
  let closed: Promise<void> | undefined;

  const close = () => closed ??= updateChannel(path, "close", channel).then(() => {});

  try { await updateChannel(path, "claim", channel);

  return close; }
  catch (error) { await close(); throw error; }
}

import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Channel = { port: number; token: string; usageProtocol: number; startedAt?: number; offset?: number };

const storageModule = fileURLToPath(new URL("./subagent-usage-storage.cjs", import.meta.url));

const channelUpdateScript = `
  const fs = require("node:fs");
  const http = require("node:http");
  const [modulePath, path, sessionId, action] = process.argv.slice(1);
  const storage = require(modulePath);
  const next = JSON.parse(fs.readFileSync(0, "utf8"));
  function readOwner() { return storage.read(path, sessionId); }
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
    storage.write(path, sessionId, next);
  }

  async function update() {
    if (action === "claim") await claim();
    else storage.close(path, sessionId, next.token);
  }
  update().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;

async function prepareChannelDirectory(path: string, directory: string) {
  const transcript = await lstat(path);

  if (!transcript.isFile() || transcript.isSymbolicLink()) throw new Error("Subagent usage requires a saved session file");
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function channelDirectory(path: string) {
  const directory = path.replace(/\.jsonl$/, ".snapshots");

  await prepareChannelDirectory(path, directory);
  const info = await lstat(directory);

  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Subagent usage storage must be a directory");

  return directory;
}

async function updateChannel(path: string, sessionId: string, action: "claim" | "close", channel: Channel & { pid: number }) {
  if (!path.endsWith(".jsonl")) throw new Error("Subagent usage requires a saved session");
  let command = process.execPath;
  let args = ["-e", channelUpdateScript, storageModule, path, sessionId, action];

  if (action === "claim") {
    const directory = await channelDirectory(path);
    args = ["--exclusive", "--wait", "10", "--no-fork", join(directory, "subagent-usage.lock"), command, ...args];
    command = "flock";
  }

  return new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8" }, (error, _output, stderr) => {
      if (error) reject(new Error(`Could not ${action} subagent usage channel: ${stderr.trim() || error.message}`));
      else resolve();
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(channel));
  });
}


export async function claimUsageChannel(path: string, sessionId: string, port: number, token: string, scope?: { startedAt: number; offset?: number }) {
  const channel = { port, token, pid: process.pid, usageProtocol: 2, ...scope };
  let closed: Promise<void> | undefined;

  const close = () => closed ??= updateChannel(path, sessionId, "close", channel).then(() => {});

  try { await updateChannel(path, sessionId, "claim", channel);

  return close; }
  catch (error) { await close(); throw error; }
}

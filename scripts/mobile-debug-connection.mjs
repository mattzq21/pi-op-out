import { readDaemonEndpoint } from "./daemon-endpoint.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const project = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

const legacyEndpointIdentity = join(project, "src-tauri");

let key = 0xcbf29ce484222325n;

for (const byte of Buffer.from(legacyEndpointIdentity)) key = BigInt.asUintN(64, (key ^ BigInt(byte)) * 0x100000001b3n);

const endpointDirectory = join(homedir(), ".piop-dev", "daemons", key.toString(16).padStart(16, "0"));

const daemon = join(project, "target", "debug", "piopd");

const builtIdentity = createHash("sha256").update(readFileSync(daemon)).digest("hex");

const result = spawnSync(daemon, ["start"], { cwd: project, stdio: ["ignore", "ignore", "inherit"], timeout: 45000 });

if (result.error || result.status !== 0) {
  throw new Error("Could not start the worktree daemon. Build it first with bun run daemon:dev.", { cause: result.error });
}

async function ready(url, token) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(false), 1500);
    const finish = (value) => { clearTimeout(timer); resolve(value); socket.close(); };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "authenticate", token })), { once: true });

    socket.addEventListener("message", ({ data }) => {
      try {
        const packet = JSON.parse(String(data));
        finish(packet.type === "ready" && packet.protocol === 1 && packet.backend === "daemon" ? packet : false);
      } catch { finish(false); }
    }, { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
    socket.addEventListener("close", () => finish(false), { once: true });
  });
}

let connection;
let token;

let runtime;

let outdatedBuild = false;

const deadline = Date.now() + 10000;

while (Date.now() < deadline) {
  try {
    const endpoint = readDaemonEndpoint(endpointDirectory, "debug-mobile.json");
    const url = new URL(endpoint.url);

    if (endpoint.protocol === 1 && typeof endpoint.token === "string" && endpoint.token.length >= 32 && url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port) {
      const packet = await ready(url.href, endpoint.token);

      if (packet) {
        let runningIdentity;

        if (typeof packet.debugRuntime?.buildIdentity === "string") runningIdentity = packet.debugRuntime.buildIdentity;
        else if (Number.isSafeInteger(packet.debugProcessId) && packet.debugProcessId > 0) {
          try { runningIdentity = createHash("sha256").update(readFileSync(`/proc/${packet.debugProcessId}/exe`)).digest("hex"); } catch { }
        }

        if (runningIdentity !== builtIdentity) {
          outdatedBuild = true;
          break;
        }

        url.hostname = "10.0.2.2";
        connection = url.href;
        token = endpoint.token;
        runtime = packet.debugRuntime ?? { processId: packet.debugProcessId, buildIdentity: runningIdentity };
        break;
      }
    }
  } catch { }

  await delay(200);
}

if (outdatedBuild) throw new Error("The running worktree daemon does not match the rebuilt binary; restart it before connecting.");

if (!connection) throw new Error("The worktree daemon has no live debug mobile endpoint. Rebuild it, stop the old daemon, and start it again.");

process.stdout.write(JSON.stringify({
  project,
  runtime,
  apk: join(project, "clients/android/app/build/outputs/apk/debug/app-debug.apk"),
  url: connection,
  exec: { argv: ["am", "start", "-S", "-n", "dev.pi.mobile/.MainActivity", "--es", "piopDebugUrl", connection, "--es", "piopDebugToken", token] },
}, null, 2) + "\n");

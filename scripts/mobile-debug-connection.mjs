import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { developmentEndpointKey } from "../protocol/connection.ts";

const project = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

const endpointDirectory = join(homedir(), ".piop-dev", "daemons", developmentEndpointKey(project));

const daemon = join(project, "target", "debug", "piopd");

const builtIdentity = createHash("sha256").update(readFileSync(daemon)).digest("hex");

const result = spawnSync(daemon, ["start"], { cwd: project, stdio: ["ignore", "ignore", "inherit"], timeout: 45000 });

if (result.error || result.status !== 0) {
  throw new Error("Could not start the worktree daemon. Build it first with bun run daemon:dev.", { cause: result.error });
}

function readDaemonEndpoint() {
  let database;

  try {
    database = new DatabaseSync(join(endpointDirectory, "sessions.sqlite"), { readOnly: true });
    database.exec("PRAGMA busy_timeout=2000");

    const row = database.prepare("SELECT body FROM application_settings WHERE name=?").get("debug-mobile");

    return row?.body ? JSON.parse(Buffer.from(row.body).toString("utf8")) : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
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
    const endpoint = readDaemonEndpoint();
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

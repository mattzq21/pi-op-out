import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const project = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const manifest = join(project, "src-tauri");
let key = 0xcbf29ce484222325n;

for (const byte of Buffer.from(manifest)) key = BigInt.asUintN(64, (key ^ BigInt(byte)) * 0x100000001b3n);

const endpointFile = join(homedir(), ".piop-dev", "daemons", key.toString(16).padStart(16, "0"), "debug-mobile.json");
const daemon = join(manifest, "target", "debug", "piopd");
const result = spawnSync(daemon, ["start"], { cwd: project, stdio: ["ignore", "ignore", "inherit"] });

if (result.error || result.status !== 0) {
  throw new Error("Could not start the worktree daemon. Build it first with npm run daemon:dev.", { cause: result.error });
}

async function ready(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(false), 1500);
    const finish = (value) => { clearTimeout(timer); resolve(value); socket.close(); };
    socket.addEventListener("message", ({ data }) => {
      try {
        const packet = JSON.parse(String(data));
        finish(packet.type === "ready" && packet.protocol === 1 && packet.backend === "daemon");
      } catch { finish(false); }
    }, { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
    socket.addEventListener("close", () => finish(false), { once: true });
  });
}

let connection;
const deadline = Date.now() + 10000;

while (Date.now() < deadline) {
  try {
    const endpoint = JSON.parse(readFileSync(endpointFile, "utf8"));
    const url = new URL(endpoint.url);

    if (endpoint.protocol === 1 && url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port && await ready(url.href)) {
      url.hostname = "10.0.2.2";
      connection = url.href;
      break;
    }
  } catch { }
  await delay(200);
}

if (!connection) throw new Error("The worktree daemon has no live debug mobile endpoint. Rebuild it, stop the old daemon, and start it again.");

process.stdout.write(JSON.stringify({
  project,
  apk: join(project, "android/app/build/outputs/apk/debug/app-debug.apk"),
  url: connection,
  exec: { argv: ["am", "start", "-S", "-n", "dev.pi.mobile/.MainActivity", "--es", "piopDebugUrl", connection] },
}, null, 2) + "\n");

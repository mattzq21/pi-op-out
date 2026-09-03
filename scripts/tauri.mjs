import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const args = process.argv.slice(2);
const topBounds = "2560,56,1280,692";
const bottomBounds = "2560,748,1280,692";

function devStartBounds() {
  try {
    const windows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const topSlotOccupied = windows.split("\n").some((line) =>
      line.includes('"Pi": ("pi-desktop" "Pi-desktop")') && line.includes("1280x692+2560+56")
    );
    return topSlotOccupied ? bottomBounds : topBounds;
  } catch {
    return topBounds;
  }
}

if (args[0] === "dev") {
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("Could not allocate a development port")));
    });
  });
  args.splice(1, 0, "--config", JSON.stringify({ build: {
    beforeDevCommand: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    devUrl: `http://127.0.0.1:${port}`,
  } }));
}

const tauri = fileURLToPath(new URL("../node_modules/.bin/tauri", import.meta.url));
const env = process.platform === "linux" && args[0] === "dev"
  ? { ...process.env, GDK_BACKEND: "x11", PI_START_BOUNDS: devStartBounds() }
  : process.env;
const child = spawn(tauri, args, { stdio: "inherit", env });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });

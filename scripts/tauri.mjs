import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { selectWindowBounds } from "./window-placement.mjs";

const args = process.argv.slice(2);
const windowBounds = process.platform === "linux" && args[0] === "dev" ? selectWindowBounds() : undefined;
const development = args[0] === "dev" || (args[0] === "build" && args.includes("--debug"));

const configOverrides = development ? { productName: "Piop Dev", identifier: "dev.pi.desktop.debug" } : {};

if (args[0] === "dev") {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("Could not allocate a development port")));
    });
  });
  Object.assign(configOverrides, {
    build: {
      beforeDevCommand: `npm run build:voice && npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
      devUrl: `http://127.0.0.1:${port}`,
    },
    app: { windows: config.app.windows.map((window) => ({ ...window, focus: false })) },
  });
}

if (development) args.splice(1, 0, "--config", JSON.stringify(configOverrides));

const tauri = fileURLToPath(new URL("../node_modules/.bin/tauri", import.meta.url));
const env = {
  ...process.env,
  ...(windowBounds ? { GDK_BACKEND: "x11", PI_WINDOW_BOUNDS: JSON.stringify(windowBounds) } : {}),
};
const child = spawn(tauri, args, { stdio: "inherit", env });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });

import { z } from "zod";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { selectWindowBounds } from "./window-placement.mjs";
import { watchBackend } from "./watch-backend.mjs";

const args = process.argv.slice(2);


const windowBounds = args[0] === "dev" ? selectWindowBounds() : undefined;

const development = args[0] === "dev" || (args[0] === "build" && args.includes("--debug"));

const configOverrides = development ? { productName: "Piop Dev", identifier: "dev.pi.desktop.debug" } : {};

let devPort;

async function developmentPort() {
  const root = realpathSync(new URL("../", import.meta.url));
  const preferred = 20000 + createHash("sha256").update(root).digest().readUInt32BE(0) % 40000;

  for (let attempt = 0; attempt <= 32; attempt++) {
    const requested = attempt === 32 ? 0 : 20000 + (preferred - 20000 + attempt) % 40000;

    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", error => error.code === "EADDRINUSE" ? resolve(undefined) : reject(error));
      server.listen(requested, "127.0.0.1", () => {
        const address = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(server.address());
        server.close(error => {
          if (error) reject(error);
          else if (address.success) resolve(address.data.port);
          else reject(new Error("Could not allocate a development port"));
        });
      });
    });

    if (port !== undefined) return port;
  }

  throw new Error("Could not allocate a development port");
}

if (args[0] === "dev") {
  const config = JSON.parse(readFileSync(new URL("../clients/desktop/tauri.conf.json", import.meta.url), "utf8"));

  devPort = await developmentPort();

  Object.assign(configOverrides, {
    build: {
      beforeDevCommand: null,
      devUrl: `http://127.0.0.1:${devPort}`,
    },
    app: { windows: config.app.windows.map((window) => ({ ...window, focus: false })) },
  });
}

if (args[0] === "build" && development) configOverrides.build = { beforeBuildCommand: "bun scripts/build.mjs --debug" };

if (development) args.splice(1, 0, "--config", JSON.stringify(configOverrides));

const tauri = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));

const env = {
  ...process.env,
  TAURI_APP_PATH: fileURLToPath(new URL("../clients/desktop", import.meta.url)),
  TAURI_FRONTEND_PATH: fileURLToPath(new URL("../", import.meta.url)),
  VITE_PIOP_DEBUG: String(development),
  PIOP_PREBUILT_DAEMON_FOR: args[0] === "dev" ? fileURLToPath(new URL("../", import.meta.url)) : "",
};

if (windowBounds) {
  env.GDK_BACKEND = "x11";
  env.PI_WINDOW_BOUNDS = JSON.stringify(windowBounds);
}

if (args[0] === "dev") {
  await watchBackend(process.execPath, [tauri, ...(args.includes("--no-watch") ? args : [...args, "--no-watch"])], { stdio: "inherit", env }, fileURLToPath(new URL("../", import.meta.url)), { port: devPort, watch: !args.includes("--no-watch") });
} else {
  const child = spawn(process.execPath, [tauri, ...args], { stdio: "inherit", env });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
}

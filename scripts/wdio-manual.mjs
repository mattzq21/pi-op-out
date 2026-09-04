import path from "node:path";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { cleanupWdioSession, startWdioSession } from "@wdio/tauri-service";
import { selectWindowBounds, serializeWindowBounds } from "./window-placement.mjs";

const defaultBinary = path.resolve(
  "src-tauri",
  "target",
  "release",
  process.platform === "win32" ? "pi-desktop.exe" : "pi-desktop",
);
const appBinaryPath = path.resolve(process.env.PI_E2E_BINARY ?? defaultBinary);
const windowBounds = selectWindowBounds();

if (!existsSync(appBinaryPath)) {
  throw new Error(`Test binary not found at ${appBinaryPath}. Run npm run test:e2e:build first.`);
}

const webdriverPort = await new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => {
      if (error) reject(error);
      else if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("Could not allocate an ephemeral WebDriver port"));
    });
  });
});

const capabilities = {
  browserName: "tauri",
  "tauri:options": { application: appBinaryPath },
  "wdio:tauriServiceOptions": {
    appBinaryPath,
    driverProvider: "embedded",
    embeddedPort: webdriverPort,
    env: process.platform === "linux" ? {
      GDK_BACKEND: "x11",
      PI_E2E_WINDOW_BOUNDS: serializeWindowBounds(windowBounds),
    } : undefined,
  },
};

const browser = await startWdioSession(capabilities);

console.log(JSON.stringify({
  sessionId: browser.sessionId,
  webdriverConfig: { hostname: "127.0.0.1", port: webdriverPort, path: "/" },
  window: windowBounds,
}, null, 2));
console.log("Keep this process running while the WebdriverIO MCP is attached. Press Ctrl+C to close the app.");

await new Promise((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

await cleanupWdioSession(browser);

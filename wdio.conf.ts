import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import { selectWindowBounds } from "./scripts/window-placement.mjs";
import { linkTestPi } from "./test/pi-install.mjs";

const binary = path.resolve(process.env.PI_E2E_BINARY ?? "target/e2e/release/piop");
const ownsFixtureHome = !process.env.PIOP_TEST_HOME;
const fixtureHome = process.env.PIOP_TEST_HOME || mkdtempSync(path.join(tmpdir(), "piop-e2e-"));
process.env.PIOP_TEST_HOME = fixtureHome;
const fixtureAgent = path.join(fixtureHome, ".pi", "agent");
mkdirSync(fixtureAgent, { recursive: true, mode: 0o700 });

for (const name of ["auth.json", "models.json", "models-store.json"]) {
  const source = path.join(homedir(), ".pi", "agent", name), destination = path.join(fixtureAgent, name);

  if (existsSync(source) && !existsSync(destination)) { copyFileSync(source, destination); chmodSync(destination, 0o600); }
}

const fixtureBin = path.join(fixtureHome, ".local", "bin");
mkdirSync(fixtureBin, { recursive: true, mode: 0o700 });
await linkTestPi(fixtureHome);
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const realNode = process.execPath;
writeFileSync(path.join(fixtureBin, "node"), "#!/bin/sh\nexec " + shellQuote(realNode) + " " + shellQuote(path.resolve("test/e2e/pi-ready-launcher.cjs")) + " --node " + shellQuote(realNode) + ' -- "$@"\n', { mode: 0o700 });

const fixtureEnvironment: Record<string, string> = {
  HOME: fixtureHome,
  PIOP_TEST_HOME: fixtureHome,
  PI_CODING_AGENT_DIR: fixtureAgent,
  PIOP_MOBILE_BIND: "127.0.0.1:0",
  XDG_CONFIG_HOME: path.join(fixtureHome, "config"), XDG_DATA_HOME: path.join(fixtureHome, "data"), XDG_CACHE_HOME: path.join(fixtureHome, "cache"),
  GDK_BACKEND: "x11",
};
const windowBounds = selectWindowBounds();
if (windowBounds) fixtureEnvironment.PI_WINDOW_BOUNDS = JSON.stringify(windowBounds);

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = z.object({ port: z.number().int().min(1).max(65535) }).parse(server.address());
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

process.env.PIOP_E2E_DRIVER_PORT ||= String(await freePort());
process.env.PIOP_E2E_NATIVE_PORT ||= String(await freePort());
const driverPort = Number(process.env.PIOP_E2E_DRIVER_PORT);
const nativePort = Number(process.env.PIOP_E2E_NATIVE_PORT);
let driver: ChildProcess | undefined;

const listening = (port: number) => new Promise<boolean>(resolve => {
  const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.end(); resolve(true); });
  socket.once("error", () => resolve(false));
});

const stopDriver = async () => {
  const child = driver;
  driver = undefined;

  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");

  if (!await Promise.race([exited.then(() => true), delay(3000, undefined, { ref: false }).then(() => false)])) { child.kill("SIGKILL"); await exited; }
};

const stopFixtureProcesses = () => {
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    let environment: string;

    try { environment = readFileSync(path.join("/proc", pid, "environ"), "utf8"); }
    catch { continue; }

    if (environment.split("\0").includes("PIOP_TEST_HOME=" + fixtureHome)) {
      try { process.kill(Number(pid), "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
};

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: driverPort,
  specs: ["./test/e2e/specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [{ "tauri:options": { application: binary }, "wdio:enforceWebDriverClassic": true } as WebdriverIO.Capabilities],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 10_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 2,
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  onPrepare: async () => {
    if (!existsSync(binary)) throw new Error("E2E app is missing at " + binary + ". Build it with: node scripts/test-e2e.mjs --build");
    let failure: Error | undefined;
    driver = spawn("tauri-driver", ["--port", String(driverPort), "--native-port", String(nativePort)], { env: { ...process.env, ...fixtureEnvironment }, stdio: ["ignore", "inherit", "inherit"] });
    driver.once("error", error => { failure = error; });

    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;

      if (driver.exitCode !== null) throw new Error("tauri-driver exited with code " + driver.exitCode);

      if (await listening(driverPort)) return;
      await delay(100);
    }

    await stopDriver();
    throw new Error("tauri-driver did not start");
  },
  onComplete: async () => {
    try { await stopDriver(); stopFixtureProcesses(); }
    finally { if (ownsFixtureHome) rmSync(fixtureHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  },
  afterTest: async (_test, _context, { passed }) => {
    if (passed) return;

    const state = await browser.execute(() => ({
      pageErrors: window.__piopE2eErrors,
      sessions: [...document.querySelectorAll(".session-item")].map(element => ({ text: element.textContent, visible: Boolean(element.getClientRects().length), html: element.outerHTML.slice(0, 1000) })),
      errors: [...document.querySelectorAll(".error-toast,.dialog-error,.upload-error,.split-pane-status.error")].map(element => element.textContent),
      composer: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message piop"]')?.disabled,
      calls: JSON.parse(document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls")?.value || "[]").slice(-15).map((call: { command: string; args?: { command?: { type?: string }; action?: string } }) => ({ command: call.command, type: call.args?.command?.type, action: call.args?.action })),
    }));

    console.error("E2E failure state", JSON.stringify(state));
  },
  before: async () => {
    const [mainWindow] = await browser.getWindowHandles();

    if (mainWindow) await browser.switchToWindow(mainWindow);
  },
};

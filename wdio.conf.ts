import path from "node:path";
import { z } from "zod";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { selectWindowBounds } from "./scripts/window-placement.mjs";

declare global {
  interface Screen { availLeft?: number; availTop?: number; }
}

const authSchema = z.record(z.string(), z.json());

const sessionHeaderSchema = z.object({ type: z.string().optional(), id: z.string().optional(), cwd: z.string().optional() });

if (process.platform === "linux") process.env.GDK_BACKEND = "x11";

delete process.env.PIOP_DAEMON_URL;

delete process.env.PIOP_DAEMON_TOKEN;

const defaultBinary = path.resolve(
  "target",
  "release",
  process.platform === "win32" ? "piop.exe" : "piop",
);

const ownsFixtureHome = !process.env.PIOP_TEST_HOME;

const fixtureHome = process.env.PIOP_TEST_HOME || mkdtempSync(path.join(tmpdir(), "piop-e2e-"));

process.env.PIOP_TEST_HOME = fixtureHome;

const fixtureAgent = path.join(fixtureHome, ".pi", "agent");

mkdirSync(fixtureAgent, { recursive: true, mode: 0o700 });

for (const name of ["auth.json", "models.json", "models-store.json"]) {
  const source = path.join(homedir(), ".pi", "agent", name), destination = path.join(fixtureAgent, name);

  if (existsSync(source) && !existsSync(destination)) { copyFileSync(source, destination); chmodSync(destination, 0o600); }
}

const fixtureEnvironment = {
  PIOP_TEST_HOME: fixtureHome,
  PI_CODING_AGENT_DIR: fixtureAgent,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("test/isolated-node-home.mjs")).href}`.trim(),
  XDG_CONFIG_HOME: path.join(fixtureHome, "config"), XDG_DATA_HOME: path.join(fixtureHome, "data"), XDG_CACHE_HOME: path.join(fixtureHome, "cache"),
};

const defaultActualCallModel = "openai-codex/gpt-5.6-luna";

const actualCallModel = defaultActualCallModel;

const driverProvider = "embedded";

const getOsAssignedPort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(server.address());

    if (!address.success) {
      server.close();
      reject(new Error("Could not allocate an ephemeral WebDriver port"));

      return;
    }

    server.close((error) => error ? reject(error) : resolve(address.data.port));
  });
});

const webdriverPort = await getOsAssignedPort();

const sessionsRoot = path.join(fixtureHome, ".piop", "sessions");

const temporaryProjectsRoot = path.join(fixtureHome, ".piop", "tmp");

const definedAgentsConfigPath = path.join(fixtureHome, ".piop", "piop-define-agents", "config.json");

const userConfigRoot = fixtureEnvironment.XDG_CONFIG_HOME;

const desktopSettingsPath = path.join(userConfigRoot, "dev.pi.desktop", "settings.json");

let baselineSessions = new Set<string>();

let baselineProjects = new Set<string>();

const baselineNativeConfigs = new Map<string, Buffer | undefined>();

let fixtureDaemon: ChildProcess | undefined;

const stopFixtureDaemon = async () => {
  const child = fixtureDaemon;
  fixtureDaemon = undefined;

  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));

  const signal = (name: NodeJS.Signals) => {
    try { if (process.platform === "win32") child.kill(name); else process.kill(-pid, name); }
    catch (error) { if (z.object({ code: z.string() }).safeParse(error).data?.code !== "ESRCH") throw error; }
  };

  signal("SIGTERM");

  if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) { signal("SIGKILL"); await exited; }
};

const startFixtureDaemon = async () => {
  const binary = path.join(path.dirname(defaultBinary), process.platform === "win32" ? "piopd.exe" : "piopd");
  let failure: Error | undefined;
  fixtureDaemon = spawn(binary, ["--serve"], { env: { ...process.env, ...fixtureEnvironment, PIOP_MOBILE_BIND: "127.0.0.1:0" }, detached: process.platform !== "win32", stdio: "ignore" });
  fixtureDaemon.on("error", error => { failure = error; });

  for (let attempt = 0; attempt < 150; attempt++) {
    if (failure) throw failure;

    if (fixtureDaemon.exitCode !== null) throw new Error(`Test daemon exited with code ${fixtureDaemon.exitCode}`);

    if (existsSync(path.join(fixtureHome, ".piop", "daemon.json"))) return;
    await delay(100);
  }

  await stopFixtureDaemon();
  throw new Error("Test daemon did not publish its isolated endpoint");
};

const verifyActualCallModel = () => {
  const [provider, ...modelParts] = actualCallModel.split("/");
  const modelId = modelParts.join("/");
  const agentRoot = path.join(homedir(), ".pi", "agent");
  let models: Record<string, { models?: Array<{ id?: string }> }>;
  let auth: z.infer<typeof authSchema>;

  try {
    models = JSON.parse(readFileSync(path.join(agentRoot, "models-store.json"), "utf8"));
    auth = authSchema.parse(JSON.parse(readFileSync(path.join(agentRoot, "auth.json"), "utf8")));
  } catch (error) {
    throw new Error(`ACCEPTANCE TEST MODEL IS NOT AVAILABLE: could not read Pi's model catalog/authentication (${String(error)})`);
  }

  if (!provider || !modelId || !models[provider]?.models?.some((model) => model.id === modelId)) {
    throw new Error(`ACCEPTANCE TEST MODEL IS NOT AVAILABLE: ${actualCallModel} is missing from Pi's installed model catalog`);
  }

  if (!(provider in auth)) {
    throw new Error(`ACCEPTANCE TEST MODEL IS NOT AVAILABLE: Pi has no authentication for ${provider}`);
  }
};

const sessionFiles = (directory = sessionsRoot): string[] => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const child = path.join(directory, entry.name);

  return entry.isDirectory() ? sessionFiles(child) : entry.isFile() && entry.name.endsWith(".jsonl") ? [child] : [];
});

const markedTestProjects = () => !existsSync(temporaryProjectsRoot) ? [] : readdirSync(temporaryProjectsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(temporaryProjectsRoot, entry.name, ".pi-e2e-test")))
  .map((entry) => path.join(temporaryProjectsRoot, entry.name));

const isFixtureProject = (cwd: string, id: string) => path.dirname(cwd) === path.resolve(temporaryProjectsRoot)
  && path.basename(cwd) === id && existsSync(path.join(cwd, ".pi-e2e-test"));

const cleanupTestSessions = () => {
  for (const sessionFile of sessionFiles().filter((file) => !baselineSessions.has(file))) {
    let header = sessionHeaderSchema.parse({});

    try { header = sessionHeaderSchema.parse(JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0])); } catch { }

    if (header.type !== "session" || !header.id || !header.cwd) continue;
    const cwd = path.resolve(header.cwd);

    if (!isFixtureProject(cwd, header.id)) continue;
    rmSync(sessionFile);

    try { rmdirSync(path.dirname(sessionFile)); } catch { }

    rmSync(cwd, { recursive: true, force: true });
  }

  for (const project of markedTestProjects().filter((directory) => !baselineProjects.has(directory))) rmSync(project, { recursive: true, force: true });
};

const restoreNativeConfigs = () => {
  const failures: unknown[] = [];

  for (const [file, original] of baselineNativeConfigs) {
    try {
      if (original === undefined) {
        if (existsSync(file)) rmSync(file);
      } else {
        const current = existsSync(file) ? readFileSync(file) : undefined;

        if (!current?.equals(original)) writeFileSync(file, original, { mode: 0o600 });
      }
    } catch (error) { failures.push(error); }
  }

  if (failures.length) throw new AggregateError(failures, "Could not restore native configuration after the acceptance run");
};

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./test/e2e/specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [{ browserName: "tauri" }],
  services: [["@wdio/tauri-service", {
    appBinaryPath: process.env.PI_E2E_BINARY ?? defaultBinary,
    driverProvider,
    embeddedPort: webdriverPort,
    captureBackendLogs: true,
    env: process.platform === "linux" ? {
      ...fixtureEnvironment,
      GDK_BACKEND: "x11",
      PI_WINDOW_BOUNDS: JSON.stringify(selectWindowBounds()),
    } : fixtureEnvironment,
  }]],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 10_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 2,
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
  },
  onPrepare: async () => {
    verifyActualCallModel();
    baselineSessions = new Set(sessionFiles());
    baselineProjects = new Set(markedTestProjects());

    for (const file of [definedAgentsConfigPath, desktopSettingsPath]) {
      baselineNativeConfigs.set(file, existsSync(file) ? readFileSync(file) : undefined);
    }

    await startFixtureDaemon();
  },
  onComplete: async () => {
    await stopFixtureDaemon();

    try { cleanupTestSessions(); }
    finally { try { restoreNativeConfigs(); } finally { if (ownsFixtureHome) rmSync(fixtureHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } }
  },
  afterTest: async (_test, _context, { passed }) => {
    if (passed) return;

    const state = await browser.execute(() => ({
      errors: [...document.querySelectorAll(".error-toast,.dialog-error,.upload-error,.split-pane-status.error")].map(element => element.textContent),
      composer: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message piop"]')?.disabled,
      calls: JSON.parse(document.querySelector<HTMLTextAreaElement>("#pi-e2e-calls")?.value || "[]").slice(-15).map((call: { command: string; args?: { command?: { type?: string }; action?: string } }) => ({ command: call.command, type: call.args?.command?.type, action: call.args?.action })),
    }));

    console.error("E2E failure state", JSON.stringify(state));
  },

  before: async () => {
    const [mainWindow] = await browser.getWindowHandles();

    if (mainWindow) await browser.switchToWindow(mainWindow);

    if (process.platform === "linux") return;

    const screenBounds = await browser.execute(() => {
      const currentScreen = window.screen;

      return {
        left: currentScreen.availLeft ?? 0,
        top: currentScreen.availTop ?? 0,
        height: currentScreen.availHeight,
      };
    });

    const bottom = screenBounds.top + screenBounds.height;
    await browser.setWindowRect(
      screenBounds.left,
      Math.max(screenBounds.top, bottom - 720),
      1_100,
      720,
    );
  },
};

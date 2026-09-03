import path from "node:path";
import { createServer } from "node:net";
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const defaultBinary = path.resolve(
  "src-tauri",
  "target",
  "release",
  process.platform === "win32" ? "pi-desktop.exe" : "pi-desktop",
);
const testWindow = { width: 1_100, height: 720 };
const defaultActualCallModel = "openai-codex/gpt-5.6-luna";
const actualCallModel = process.env.PI_E2E_ACTUAL_MODEL?.trim() || defaultActualCallModel;
const driverProvider = "embedded";
const getOsAssignedPort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate an ephemeral WebDriver port"));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const webdriverPort = await getOsAssignedPort();
const sessionsRoot = path.join(homedir(), ".pi-desktop", "sessions");
const temporaryProjectsRoot = path.join(homedir(), "pi-desktop", "tmp");
const orchestrationConfigPath = path.join(homedir(), ".pi", "agent", "extensions", "pi-orchestration", "config.json");
let baselineSessions = new Set<string>();
let baselineProjects = new Set<string>();
let baselineOrchestrationConfig: Buffer | undefined;

const verifyActualCallModel = () => {
  const [provider, ...modelParts] = actualCallModel.split("/");
  const modelId = modelParts.join("/");
  const agentRoot = path.join(homedir(), ".pi", "agent");
  let models: Record<string, { models?: Array<{ id?: string }> }>;
  let auth: Record<string, unknown>;
  try {
    models = JSON.parse(readFileSync(path.join(agentRoot, "models-store.json"), "utf8"));
    auth = JSON.parse(readFileSync(path.join(agentRoot, "auth.json"), "utf8"));
  } catch (error) {
    throw new Error(`ACCEPTANCE TEST MODEL IS NOT AVAILABLE: could not read Pi's model catalog/authentication (${String(error)})`);
  }
  if (!provider || !modelId || !models[provider]?.models?.some((model) => model.id === modelId)) {
    throw new Error(`ACCEPTANCE TEST MODEL IS NOT AVAILABLE: ${actualCallModel} is missing from Pi's installed model catalog`);
  }
  if (!(provider in auth)) {
    throw new Error(`ACCEPTANCE TEST MODEL IS NOT AVAILABLE: Pi has no authentication for ${provider}`);
  }
  process.env.PI_DESKTOP_E2E_MODEL = actualCallModel;
};

const sessionFiles = (directory = sessionsRoot): string[] => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const child = path.join(directory, entry.name);
  return entry.isDirectory() ? sessionFiles(child) : entry.isFile() && entry.name.endsWith(".jsonl") ? [child] : [];
});
const markedTestProjects = () => !existsSync(temporaryProjectsRoot) ? [] : readdirSync(temporaryProjectsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(temporaryProjectsRoot, entry.name, ".pi-e2e-test")))
  .map((entry) => path.join(temporaryProjectsRoot, entry.name));

const cleanupTestSessions = () => {
  for (const sessionFile of sessionFiles().filter((file) => !baselineSessions.has(file))) {
    let header: { type?: string; id?: string; cwd?: string } = {};
    try { header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]); } catch { /* A new malformed test artifact still belongs to this run. */ }
    if (header.type !== "session" || !header.id || !header.cwd) continue;
    const cwd = path.resolve(header.cwd);
    if (path.dirname(cwd) !== path.resolve(temporaryProjectsRoot) || path.basename(cwd) !== header.id || !existsSync(path.join(cwd, ".pi-e2e-test"))) continue;
    rmSync(sessionFile);
    try { rmdirSync(path.dirname(sessionFile)); } catch { /* Keep shared or non-empty session directories. */ }
    rmSync(cwd, { recursive: true, force: true });
  }
  for (const project of markedTestProjects().filter((directory) => !baselineProjects.has(directory))) rmSync(project, { recursive: true, force: true });
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
  onPrepare: () => {
    verifyActualCallModel();
    baselineSessions = new Set(sessionFiles());
    baselineProjects = new Set(markedTestProjects());
    baselineOrchestrationConfig = existsSync(orchestrationConfigPath) ? readFileSync(orchestrationConfigPath) : undefined;
  },
  onComplete: () => {
    try { cleanupTestSessions(); }
    finally {
      if (baselineOrchestrationConfig) {
        const current = existsSync(orchestrationConfigPath) ? readFileSync(orchestrationConfigPath) : undefined;
        if (!current?.equals(baselineOrchestrationConfig)) writeFileSync(orchestrationConfigPath, baselineOrchestrationConfig);
      }
      else if (existsSync(orchestrationConfigPath)) rmSync(orchestrationConfigPath);
    }
  },
  before: async () => {
    const [mainWindow] = await browser.getWindowHandles();
    if (mainWindow) await browser.switchToWindow(mainWindow);
    const screenBounds = await browser.execute(() => {
      const currentScreen = window.screen as Screen & { availLeft?: number; availTop?: number };
      return {
        left: currentScreen.availLeft ?? 0,
        top: currentScreen.availTop ?? 0,
        height: currentScreen.availHeight,
      };
    });
    const bottom = screenBounds.top + screenBounds.height;
    await browser.setWindowRect(
      screenBounds.left,
      Math.max(screenBounds.top, bottom - testWindow.height),
      testWindow.width,
      testWindow.height,
    );
  },
};

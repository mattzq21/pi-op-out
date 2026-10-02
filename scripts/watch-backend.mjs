import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

export function watchBackend(command, args, options, root) {
  let child;
  let timer;
  let restarting = false;
  let pending = false;
  let closing = false;
  const watchers = [];

  const signalChild = (process, signal) => {
    if (!process?.pid) return;

    try {
      if (globalThis.process.platform === "win32") process.kill(signal);
      else globalThis.process.kill(-process.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") console.error(error.message); }
  };

  const stop = async () => {
    const previous = child;
    child = undefined;

    if (!previous?.pid || previous.exitCode !== null || previous.signalCode !== null) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => signalChild(previous, "SIGKILL"), 5000);
      previous.once("exit", () => { clearTimeout(deadline); resolve(); });
      signalChild(previous, "SIGTERM");
    });
  };

  const close = async (code) => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);

    for (const watcher of watchers) watcher.close();
    await stop();
    process.exitCode = code;
  };

  const launch = () => {
    const running = spawn(command, args, { ...options, detached: process.platform !== "win32" });
    child = running;
    running.once("error", error => { console.error(error.message); void close(1); });
    running.once("exit", code => {
      if (child !== running) return;
      child = undefined;

      if (code === 0) void close(0);
      else console.error("Debug launch failed. Waiting for a backend change to retry.");
    });
  };

  const restart = async () => {
    if (closing || restarting) return;
    restarting = true;
    pending = false;
    console.log("Backend changed. Restarting Piop Dev…");
    await stop();

    if (!closing) launch();
    restarting = false;

    if (pending && !closing) timer = setTimeout(() => void restart(), 400);
  };

  const changed = (_event, filename) => {
    if (!filename || closing) return;
    const name = String(filename);

    if (name.endsWith(".bundle.mjs") || name.split(/[\\/]/).some(part => ["node_modules", "target", ".git", "binaries", "gen", "agent-commands.json"].includes(part))) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => void restart(), 400);
  };

  const observe = (path, recursive = false) => {
    if (existsSync(path)) watchers.push(watch(path, { recursive }, changed));
  };

  for (const directory of ["src-tauri/src", "src-tauri/capabilities", "src-tauri/resources", "src-tauri/icons", "extensions", "scripts"]) observe(join(root, directory), true);
  observe(join(root, "src-tauri"));

  for (const filename of ["package.json", "package-lock.json"]) observe(join(root, filename));
  process.once("SIGINT", () => void close(130));
  process.once("SIGTERM", () => void close(143));
  launch();
}

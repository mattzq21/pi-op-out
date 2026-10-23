import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch as watchFiles } from "node:fs";
import { join, resolve, sep } from "node:path";

export async function watchBackend(command, args, options, root, { port, watch = true }) {
  root = resolve(root);
  let child;
  let task;
  let timer;
  let restarting = true;
  let closing = false;
  let daemonManaged = false;
  let vite;
  const pending = new Set();
  const watchers = [];
  const daemon = join(root, "target/debug", "piopd");

  const signalChild = (running, signal) => {
    if (!running?.pid) return;

    try {
      process.kill(-running.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") console.error(error.message); }
  };

  const stopProcess = async running => {
    if (!running?.pid || running.exitCode !== null || running.signalCode !== null) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => signalChild(running, "SIGKILL"), 5000);
      running.once("exit", () => { clearTimeout(deadline); resolve(); });
      signalChild(running, "SIGTERM");
    });
  };

  const stopClient = async () => {
    const previous = child;
    child = undefined;
    await stopProcess(previous);
  };

  const run = (executable, arguments_, allowClosing = false) => new Promise((resolve, reject) => {
    if (closing && !allowClosing) {
      reject(new Error("Development session closed"));

      return;
    }

    const running = spawn(executable, arguments_, { ...options, cwd: root, detached: true });
    task = running;
    running.once("error", reject);
    running.once("exit", (code, signal) => {
      if (task === running) task = undefined;

      if (code === 0) resolve();
      else reject(new Error(executable + " failed (" + (signal ?? code) + ")"));
    });
  });

  const close = async code => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);

    for (const watcher of watchers) watcher.close();
    await stopProcess(task);
    await stopClient();

    if (daemonManaged) {
      try { await run(daemon, ["stop"], true); } catch (error) { console.error(error.message); }
    }

    await vite?.close();
    process.exitCode = code;
  };

  const prepareDaemon = async () => {
    await run(process.execPath, [join(root, "scripts/build-daemon.mjs"), "--debug"]);

    await run(daemon, ["stop"]);
    daemonManaged = true;
    await run(daemon, ["start"]);
  };

  const launch = () => {
    if (closing) return;
    const running = spawn(command, args, { ...options, cwd: root, detached: true });
    child = running;
    running.once("error", error => { console.error(error.message); void close(1); });
    running.once("exit", code => {
      if (child !== running) return;
      child = undefined;

      if (code === 0) void close(0);
      else console.error("Debug launch failed. Waiting for a backend change to retry.");
    });
  };

  const compiledInputs = binary => {
    const info = readFileSync(join(root, "target/debug", binary + ".d"), "utf8").replace(/\\\r?\n/g, "");
    const line = info.split(/\r?\n/)[0];

    if (!line.includes(": ")) return undefined;
    const dependencies = line.slice(line.indexOf(": ") + 2).match(/(?:\\.|[^\s])+/g) ?? [];

    return new Set(dependencies.map(input => resolve(root, input.replace(/\\([\\ #])/g, "$1"))));
  };

  const desktopChange = path => {
    try {
      const desktop = compiledInputs("piop");

      if (!desktop || desktop.has(path)) return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;

      return true;
    }

    return !["extensions", "daemon/resources", "daemon"].some(directory => path.startsWith(join(root, directory) + sep));
  };

  const applyChanges = async changes => {
    const desktop = !child || changes.some(desktopChange);
    console.log(desktop ? "Desktop changed. Restarting Piop Dev…" : "Daemon changed. Rebuilding before reloading the page…");
    await prepareDaemon();

    if (closing) return;

    if (changes.some(path => ["package.json", "bun.lock"].includes(path.slice(root.length + 1)))) await vite.restart(true);

    if (desktop) {
      await stopClient();
      launch();
    } else {
      vite.ws.send({ type: "custom", event: "piop:daemon-restarted", data: {} });
    }
  };

  const restart = async () => {
    if (closing || restarting || pending.size === 0) return;
    restarting = true;
    const changes = [...pending];
    pending.clear();

    try {
      await applyChanges(changes);
    } catch (error) {
      if (!closing) console.error(error.message + ". Waiting for a backend change to retry.");
    } finally {
      restarting = false;

      if (pending.size && !closing) timer = setTimeout(() => void restart(), 400);
    }
  };

  const changed = (directory, filename) => {
    if (!filename || closing) return;
    const name = String(filename);

    if (name.endsWith(".bundle.mjs") || name.split(/[\\/]/).some(part => ["node_modules", "target", ".git", "binaries", "gen", "agent-commands.json"].includes(part))) return;
    pending.add(resolve(directory, name));
    clearTimeout(timer);
    timer = setTimeout(() => void restart(), 400);
  };

  const observe = (path, recursive = false) => {
    if (existsSync(path)) watchers.push(watchFiles(path, { recursive }, (_event, filename) => changed(path, filename)));
  };

  process.once("SIGINT", () => void close(130));
  process.once("SIGTERM", () => void close(143));

  const observeBackend = () => {
    if (!watch) return;

    for (const directory of ["clients/desktop/src", "clients/desktop/protocol", "daemon", "clients/desktop/capabilities", "clients/desktop/icons", "extensions", "scripts", ".cargo"]) observe(join(root, directory), true);
    observe(join(root, "clients/desktop"));

    for (const filename of ["package.json", "bun.lock", "Cargo.toml", "Cargo.lock"]) {
      const path = join(root, filename);

      if (existsSync(path)) watchers.push(watchFiles(path, () => changed(root, filename)));
    }
  };

  observeBackend();

  try {
    const { createServer } = await import("vite");

    const define = {
      "import.meta.env.VITE_PIOP_DEBUG": JSON.stringify(options.env.VITE_PIOP_DEBUG),
    };

    vite = await createServer({
      root,
      define,
      server: { host: "127.0.0.1", port, strictPort: true },
    });

    if (closing) {
      await vite.close();

      return;
    }

    await vite.listen();
    vite.printUrls();
    await prepareDaemon();
    restarting = false;

    if (closing) return;
    launch();

    if (pending.size) timer = setTimeout(() => void restart(), 400);
  } catch (error) {
    console.error(error.message);
    await close(1);
  }
}

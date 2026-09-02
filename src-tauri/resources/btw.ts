import { spawn } from "node:child_process";

const DESKTOP_TITLE = "__pi_desktop_btw__";
const CUSTOM_TYPE = "pi-desktop-btw";

type PiApi = {
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean }): void;
};

type CommandContext = {
  mode: string;
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
};

function runFork(sessionFile: string, cwd: string, task: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = process.env.PI_DESKTOP_PI_EXECUTABLE;
    const command = executable || process.execPath;
    const args = executable
      ? ["--print", "--approve", "--fork", sessionFile, task]
      : [process.argv[1], "--print", "--approve", "--fork", sessionFile, task];
    const child = spawn(command, args, { cwd, env: { ...process.env, PI_DESKTOP_BTW: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const answer = stdout.trim();
      if (code === 0 && answer) resolve(answer);
      else reject(new Error(stderr.trim() || answer || `The /btw branch exited with status ${code ?? "unknown"}`));
    });
  });
}

export default function btwExtension(pi: PiApi) {
  pi.registerCommand("btw", {
    description: "Open an ephemeral side conversation branched from the current response",
    handler: async (rawArgs, ctx) => {
      const task = rawArgs.trim();
      if (!task) {
        ctx.ui.notify("/btw needs a message to send", "warning");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/btw needs a persisted session to branch from", "error");
        return;
      }

      const parentLeafId = ctx.sessionManager.getLeafId();
      ctx.ui.setStatus("btw", "Running side conversation…");
      void (async () => {
        try {
          if (ctx.mode === "rpc" && process.env.PI_DESKTOP_BTW === "1") {
            await ctx.ui.input(DESKTOP_TITLE, JSON.stringify({ task, sessionFile, leafId: parentLeafId, cwd: ctx.cwd }));
            return;
          }
          const answer = await runFork(sessionFile, ctx.cwd, task);
          if (!answer?.trim()) {
            ctx.ui.notify("The /btw conversation did not return an answer", "warning");
            return;
          }
          pi.sendMessage({
            customType: CUSTOM_TYPE,
            content: `Side conversation result:\n\n${answer.trim()}`,
            display: true,
            details: { task, parentLeafId },
          }, { triggerTurn: false });
        } catch (error) {
          ctx.ui.notify(`/btw failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus("btw", undefined);
        }
      })();
    },
  });
}

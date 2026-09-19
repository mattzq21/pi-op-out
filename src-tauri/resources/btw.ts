import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const DESKTOP_TITLE = "__pi_desktop_btw__";
const CUSTOM_TYPE = "pi-desktop-btw";
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const execFile = promisify(execFileCallback);

type PiApi = {
  events: { emit(name: string, value: unknown): void };
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

function forkCommand(pi: PiApi, sessionFile: string, task: string) {
  const executable = process.env.PI_DESKTOP_PI_EXECUTABLE;
  const command = executable || process.execPath;
  const args = executable
    ? ["--print", "--approve", "--fork", sessionFile]
    : [process.argv[1], "--print", "--approve", "--fork", sessionFile];
  args.push("--session-dir", join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "sessions"));
  args.push("--extension", join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "rtk.ts"));
  args.push("--extension", join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "runtime-settings.ts"));
  args.push("--extension", join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "piop-mcp-bridge.ts"));
  const settings: { settings?: unknown } = {};
  pi.events.emit("piop:runtime-settings", settings);
  if (settings.settings) args.push("--piop-runtime-settings", JSON.stringify(settings.settings));
  const codexWebSearchExtension = process.env.PI_DESKTOP_CODEX_WEB_SEARCH_EXTENSION;
  if (codexWebSearchExtension) args.push("--extension", codexWebSearchExtension);
  const definedAgentsExtension = process.env.PI_DESKTOP_DEFINED_AGENTS_EXTENSION;
  if (definedAgentsExtension) args.push("--extension", definedAgentsExtension);
  args.push(task);
  return { command, args };
}

async function runFork(pi: PiApi, sessionFile: string, cwd: string, task: string): Promise<string> {
  const { command, args } = forkCommand(pi, sessionFile, task);
  try {
    const { stdout } = await execFile(command, args, {
      cwd,
      env: { ...process.env, PI_DESKTOP_BTW: "0" },
      encoding: "utf8",
      maxBuffer: OUTPUT_LIMIT,
    });
    const answer = stdout.trim();
    if (answer) return answer;
    throw new Error("The /btw branch returned no output");
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.stdout?.trim() || failure.message);
  }
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
          const answer = await runFork(pi, sessionFile, ctx.cwd, task);
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

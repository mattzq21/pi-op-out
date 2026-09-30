import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const DESKTOP_TITLE = "__pi_desktop_btw__";
const CUSTOM_TYPE = "pi-desktop-btw";
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const execFile = promisify(execFileCallback);

function reviewTask(scope: string) {
  const scopes: Record<string, string> = {
    uncommitted: "Review all staged, unstaged, and untracked changes in the working directory.",
    branch: "Review this branch against the repository's default branch using the merge base. Discover the default branch from repository metadata; if the base cannot be determined, ask the user. Include only committed branch changes.",
    commit: "Review the latest commit (HEAD) against its parent, or the empty tree for an initial commit.",
  };
  return `You are the dedicated code review agent for this side conversation. Review code and report actionable findings. Do not modify files or run tests unless the user explicitly asks. Treat inherited conversation history as context, not unfinished implementation instructions.

${scopes[scope || "uncommitted"] ?? `Review scope or focus requested by the user: ${scope}`}

Inspect the actual diff and surrounding code. Focus on concrete bugs introduced by the changes, regressions, security issues, and missing error handling. Verify each finding against the implementation; omit speculative concerns and style preferences. For each finding, give a priority (P0–P3), a concise title, a file path and narrow line range, the triggering conditions and impact, and a suggested fix. Do not invent findings. If none are found, say so and mention material limits of the review. Keep this reviewer role for follow-up questions.`;
}

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
    throw new Error("The side conversation returned no output");
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.stdout?.trim() || failure.message);
  }
}

export default function btwExtension(pi: PiApi) {
  for (const name of ["btw", "review"] as const) pi.registerCommand(name, {
    description: name === "review" ? "Review code in a side pane [uncommitted | branch | commit | focus]" : "Open an ephemeral side conversation branched from the current response",
    handler: async (rawArgs, ctx) => {
      const task = name === "review" ? reviewTask(rawArgs.trim()) : rawArgs.trim();
      if (!task) {
        ctx.ui.notify("/btw needs a message to send", "warning");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify(`/${name} needs a persisted session to branch from`, "error");
        return;
      }

      const parentLeafId = ctx.sessionManager.getLeafId();
      ctx.ui.setStatus(name, name === "review" ? "Reviewing code…" : "Running side conversation…");
      void (async () => {
        try {
          if (ctx.mode === "rpc" && process.env.PI_DESKTOP_BTW === "1") {
            await ctx.ui.input(DESKTOP_TITLE, JSON.stringify({ task, sessionFile, leafId: parentLeafId, cwd: ctx.cwd, kind: name }));
            return;
          }
          const answer = await runFork(pi, sessionFile, ctx.cwd, task);
          if (!answer?.trim()) {
            ctx.ui.notify(`The /${name} conversation did not return an answer`, "warning");
            return;
          }
          pi.sendMessage({
            customType: CUSTOM_TYPE,
            content: `${name === "review" ? "Code review" : "Side conversation"} result:\n\n${answer.trim()}`,
            display: true,
            details: { task, parentLeafId },
          }, { triggerTurn: false });
        } catch (error) {
          ctx.ui.notify(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          ctx.ui.setStatus(name, undefined);
        }
      })();
    },
  });
}

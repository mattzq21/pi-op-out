import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function registerTurnCapture(pi: ExtensionAPI) {
  const script = process.env.PI_DESKTOP_GIT_CAPTURE_SCRIPT;

  if (!script) return;
  const publish = (ctx: ExtensionContext, capture: object) => ctx.ui.setStatus("pi-desktop-turn-capture", JSON.stringify(capture));

  const snapshot = async (cwd: string) => {
    try {
      const { stdout } = await runFile(process.execPath, ["-e", script], { cwd, maxBuffer: 64 * 1024 });
      const capture = JSON.parse(stdout);

      if (!capture || typeof capture.root !== "string" || !capture.root || typeof capture.repository_root !== "string" || !capture.repository_root
        || typeof capture.tree !== "string" || !/^[a-f0-9]{40,64}$/i.test(capture.tree)) throw new Error("Git snapshot was incomplete");

      return JSON.stringify({ root: capture.root, tree: capture.tree, repository_root: capture.repository_root });
    } catch (error) {
      if ([3, 4, 6].includes(Number((error as { code?: unknown }).code))) return null;
      throw error;
    }
  };

  let turn: { id: string; cwd: string; sessionId: string; entries: Set<string> } | undefined;

  const cancel = (ctx: ExtensionContext) => {
    if (turn) publish(ctx, { phase: "end", turnId: turn.id });
    turn = undefined;
  };

  pi.on("agent_start", async (_event, ctx) => {
    cancel(ctx);
    const started = { id: crypto.randomUUID(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), entries: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)) };

    try {
      const baseline = await snapshot(started.cwd);

      if (baseline) { turn = started; publish(ctx, { phase: "start", turnId: started.id, cwd: started.cwd, baseline }); }
    } catch (error) { ctx.ui.notify(`Could not capture project changes: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  });
  pi.on("agent_end", async (_event, ctx) => {
    const ended = turn; turn = undefined;

    if (!ended) return;
    let current: string | null = null;
    let messageId: string | undefined;
    const sessionPath = ctx.sessionManager.getSessionFile();

    try {
      if (ctx.sessionManager.getSessionId() !== ended.sessionId || !sessionPath) return;
      const response = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && !ended.entries.has(entry.id) && entry.message.role === "assistant" && (entry.message.content.some((part) => part.type === "text" && part.text.trim()) || ["aborted", "error"].includes(entry.message.stopReason)));

      if (!response) return;
      messageId = response.id;
      current = await snapshot(ended.cwd);
    } catch (error) { ctx.ui.notify(`Could not capture project changes: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    finally { publish(ctx, { phase: "end", turnId: ended.id, cwd: ended.cwd, current, sessionPath, messageId }); }
  });
  pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
}

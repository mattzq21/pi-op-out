import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

const captureSchema = Type.Object({
  root: Type.String({ minLength: 1 }), repository_root: Type.String({ minLength: 1 }), tree: Type.String({ pattern: "^[a-fA-F0-9]{40,64}$" }),
  durable: Type.Optional(Type.Boolean()),
  retentionError: Type.Optional(Type.String()),
});

const skippedCaptureSchema = Type.Object({ code: Type.Union([Type.Literal(3), Type.Literal(4), Type.Literal(6)]) });

type TurnCapture = { phase: "start"; turnId: string; cwd: string; baseline: string; sessionPath?: string }
  | { phase: "end"; turnId: string; cwd?: string; current?: string | null; sessionPath?: string; messageId?: string; durable?: boolean };

export function registerTurnCapture(pi: ExtensionAPI) {
  const script = process.env.PI_DESKTOP_GIT_CAPTURE_SCRIPT;

  if (!script) return;

  const publish = (ctx: ExtensionContext, capture: TurnCapture) => ctx.ui.setStatus("pi-desktop-turn-capture", JSON.stringify(capture));

  const snapshot = async (cwd: string, ctx: ExtensionContext, turnId: string, phase: string, comparison?: { baseline: string; messageId: string }) => {

    try {
      const owner = { sessionPath: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), turnId, phase, ephemeral: process.env.PIOP_EPHEMERAL_SESSION === "1", ...comparison };
      const { stdout } = await runFile(process.execPath, ["-e", script, JSON.stringify(owner)], { cwd, maxBuffer: 64 * 1024 });
      const capture = JSON.parse(stdout);

      if (!Check(captureSchema, capture)) throw new Error("Git snapshot was incomplete");

      if (capture.retentionError) ctx.ui.notify(`Could not retain project changes for retry: ${capture.retentionError}`, "error");

      return { token: JSON.stringify({ root: capture.root, tree: capture.tree, repository_root: capture.repository_root }), durable: capture.durable === true };
    } catch (error) {
      if (Check(skippedCaptureSchema, error)) return null;
      throw error;
    }
  };

  let turn: { id: string; cwd: string; sessionId: string; entries: Set<string>; baseline: string } | undefined;

  const cancel = (ctx: ExtensionContext) => {
    if (turn) publish(ctx, { phase: "end", turnId: turn.id });
    turn = undefined;
  };

  pi.on("agent_start", async (_event, ctx) => {
    cancel(ctx);
    const started = { id: crypto.randomUUID(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), entries: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)) };

    try {

      const baseline = await snapshot(started.cwd, ctx, started.id, "start");

      if (baseline) { turn = { ...started, baseline: baseline.token }; publish(ctx, { phase: "start", turnId: started.id, cwd: started.cwd, baseline: baseline.token, sessionPath: ctx.sessionManager.getSessionFile() }); }
    } catch (error) { ctx.ui.notify(`Could not capture project changes: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  });
  pi.on("agent_end", async (_event, ctx) => {
    const ended = turn; turn = undefined;

    if (!ended) return;
    let current: string | null = null;
    let durable = false;
    let messageId: string | undefined;
    const sessionPath = ctx.sessionManager.getSessionFile();

    try {
      if (ctx.sessionManager.getSessionId() !== ended.sessionId || !sessionPath) return;
      const response = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && !ended.entries.has(entry.id) && entry.message.role === "assistant" && (entry.message.content.some((part) => part.type === "text" && part.text.trim()) || ["aborted", "error"].includes(entry.message.stopReason)));

      if (!response) return;
      messageId = response.id;
      const captured = await snapshot(ended.cwd, ctx, ended.id, "end", { baseline: ended.baseline, messageId });
      current = captured?.token ?? null;
      durable = captured?.durable === true;
    } catch (error) { ctx.ui.notify(`Could not capture project changes: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    finally { publish(ctx, { phase: "end", turnId: ended.id, cwd: ended.cwd, current, sessionPath, messageId, durable }); }
  });
  pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
}

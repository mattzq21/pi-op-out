import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForkGate } from "./operations.ts";
import { randomUUID } from "node:crypto";

const runFile = promisify(execFile);

const captureSchema = Type.Object({
  root: Type.String({ minLength: 1 }), repository_root: Type.String({ minLength: 1 }), tree: Type.String({ pattern: "^[a-fA-F0-9]{40,64}$" }),
});

const skippedCaptureSchema = Type.Object({ code: Type.Union([Type.Literal(3), Type.Literal(4), Type.Literal(6)]) });

type TurnCapture = { phase: "start"; turnId: string; cwd: string; baseline: string }
  | { phase: "end"; turnId: string; cwd?: string; current?: string | null; sessionPath?: string; sessionId?: string; messageId?: string };

const forkDrainSchema = Type.Object({ nonce: Type.String({ pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$" }), sessionId: Type.String(), error: Type.Optional(Type.String()) });

const FORK_CAPTURE_TIMEOUT_MS = 150_000;

type ForkDrain = { nonce: string; sessionId: string; resolve: () => void; reject: (error: Error) => void };

type CaptureDrainRequest = { ctx: ExtensionContext; ids: ReadonlySet<string>; ready?: Promise<void> };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:drain-fork-captures", handler: (request: CaptureDrainRequest) => void): () => void;
    emit(channel: "piop:drain-fork-captures", request: CaptureDrainRequest): void;
  }
}

export async function boundedForkWait(work: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Project capture did not finish before branching; the source was retained. Retry after it settles.")), FORK_CAPTURE_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export async function drainForkCaptures(events: ExtensionAPI["events"], ctx: ExtensionContext, ids: ReadonlySet<string>) {
  const request: CaptureDrainRequest = { ctx, ids };
  events.emit("piop:drain-fork-captures", request);

  if (!request.ready) throw new Error("The source capture drain protocol is unavailable; conversation was retained");
  await request.ready;
}

function registerForkDrain(pi: ExtensionAPI, wait: (ctx: ExtensionContext, ids: ReadonlySet<string>) => Promise<void>) {
  let pending: ForkDrain | undefined;
  const clearPending = (nonce: string) => { if (pending?.nonce === nonce) pending = undefined; };

  const drainSource = async (ctx: ExtensionContext, ids: ReadonlySet<string>) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const source = ctx.sessionManager.getSessionFile();
    await boundedForkWait(wait(ctx, ids));

    if (pending) throw new Error("Another branch is already draining this conversation's project captures");
    const nonce = randomUUID();

    try {
      await boundedForkWait(new Promise<void>((resolve, reject) => {
        pending = { nonce, sessionId, resolve, reject };
        ctx.ui.setStatus("piop-fork-drain", JSON.stringify({ nonce, sessionId }));
      }));
    } finally { clearPending(nonce); }

    if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== source) throw new Error("The source conversation changed while its project captures were draining");
  };

  pi.events.on("piop:drain-fork-captures", request => { request.ready = drainSource(request.ctx, request.ids); });

  pi.events.on("piop:rpc", request => {
    if (request.command !== "fork_drained") return;
    request.ready = Promise.resolve().then(() => {
      const reply = Parse(forkDrainSchema, request.payload);

      if (!pending || reply.nonce !== pending.nonce || reply.sessionId !== pending.sessionId) throw new Error("Fork capture acknowledgment is no longer pending");

      if (reply.error) pending.reject(new Error(`Project captures could not be saved; source retained: ${reply.error}`));
      else pending.resolve();

      return { drained: !reply.error };
    });
  });
  pi.on("session_shutdown", () => { pending?.reject(new Error("The source stopped before its project captures drained")); });
}

export function registerTurnCapture(pi: ExtensionAPI) {
  let turn: { id: string; cwd: string; sessionId: string; entries: Set<string> } | undefined;
  let failure: { sessionId: string; error: Error } | undefined;
  const inFlight = new Set<Promise<void>>();

  const track = (work: Promise<void>) => {
    inFlight.add(work);
    void work.then(() => inFlight.delete(work), () => inFlight.delete(work));

    return work;
  };

  const waitCaptures = async (ctx: ExtensionContext, ids: ReadonlySet<string>) => {
    while (inFlight.size) await Promise.all([...inFlight]);

    const sessionId = ctx.sessionManager.getSessionId();

    if (failure?.sessionId === sessionId) throw failure.error;
    const active = turn;

    if (active?.sessionId === sessionId && [...ids].some(id => {
      const entry = ctx.sessionManager.getEntry(id);

      return entry?.type === "message" && entry.message.role === "assistant" && !active.entries.has(id);
    })) throw new Error("The selected response's project capture is not complete. Wait for the response to settle before branching.");
  };

  registerForkDrain(pi, waitCaptures);
  pi.events.on("piop:before-fork", (gate: ForkGate) => {
    gate.captureReady = boundedForkWait(Promise.all([...inFlight]).then(() => {
      if (failure?.sessionId === gate.sessionId) throw failure.error;
    }));
  });
  const script = process.env.PI_DESKTOP_GIT_CAPTURE_SCRIPT;

  if (!script) return;
  const publish = (ctx: ExtensionContext, capture: TurnCapture) => ctx.ui.setStatus("pi-desktop-turn-capture", JSON.stringify(capture));

  const snapshot = async (cwd: string, ctx: ExtensionContext, turnId: string, phase: string) => {
    try {
      const owner = { sessionPath: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(), turnId, phase };
      const { stdout } = await runFile(process.execPath, ["-e", script, JSON.stringify(owner)], { cwd, maxBuffer: 64 * 1024 });
      const capture = JSON.parse(stdout);

      if (!Check(captureSchema, capture)) throw new Error("Git snapshot was incomplete");

      return JSON.stringify({ root: capture.root, tree: capture.tree, repository_root: capture.repository_root });
    } catch (error) {
      if (Check(skippedCaptureSchema, error)) return null;
      throw error;
    }
  };

  const reportCaptureFailure = (ctx: ExtensionContext, error: Error) => {
    failure = { sessionId: ctx.sessionManager.getSessionId(), error };
    ctx.ui.notify(`Could not capture project changes: ${error.message}`, "error");
  };

  const cancel = (ctx: ExtensionContext) => {
    if (turn) publish(ctx, { phase: "end", turnId: turn.id });
    turn = undefined;
  };

  const start = async (ctx: ExtensionContext) => {
    cancel(ctx);
    const started = { id: crypto.randomUUID(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), entries: new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)) };

    try {

      const baseline = await snapshot(started.cwd, ctx, started.id, "start");

      if (baseline) { turn = started; publish(ctx, { phase: "start", turnId: started.id, cwd: started.cwd, baseline }); }
    } catch (error) { reportCaptureFailure(ctx, error instanceof Error ? error : new Error(String(error))); }
  };

  const end = async (ctx: ExtensionContext) => {
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
      current = await snapshot(ended.cwd, ctx, ended.id, "end");
    } catch (error) { reportCaptureFailure(ctx, error instanceof Error ? error : new Error(String(error))); }
    finally { publish(ctx, { phase: "end", turnId: ended.id, cwd: ended.cwd, current, sessionPath, sessionId: ended.sessionId, messageId }); }
  };

  pi.on("agent_start", (_event, ctx) => track(start(ctx)));
  pi.on("agent_end", (_event, ctx) => track(end(ctx)));
  pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
}

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getFastCommandCompletions, parseFastCommand } from "./commands";
import { loadConfigForScope } from "./config";
import { getFastModePayload, toModelRef } from "./payload";
import { FastModeSessionState } from "./session";
import { clearFastStatus, updateFastStatus } from "./status";
import { STATE_ENTRY, type ModelRef } from "./types";

export type FastModeExtensionOptions = {
  extensionDir?: string;
  agentDir?: string;
};

const DEFAULT_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const savedStateSchema = z.object({ enabled: z.boolean() });

/** Returns the latest saved choice on the current branch, or undefined when the session has none. */
function savedChoice(ctx: Pick<ExtensionContext, "sessionManager">): boolean | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const parsed = savedStateSchema.safeParse(entry.data);

    if (!parsed.success) throw new Error("Invalid saved fast mode choice in this session");

    return parsed.data.enabled;
  }
}

function notifyError(ctx: Pick<ExtensionContext, "hasUI" | "ui">, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else console.error("[fast-mode] " + message);
}

export function createPiFastModeExtension(options: FastModeExtensionOptions = {}): ExtensionFactory {
  const extensionDir = options.extensionDir ?? DEFAULT_EXTENSION_DIR;
  const agentDir = options.agentDir;

  return function piFastModeExtension(pi: ExtensionAPI): void {
    let statusContext: ExtensionContext | undefined;
    let currentModel: ModelRef | undefined;
    const session = new FastModeSessionState(
      enabled => pi.appendEntry(STATE_ENTRY, { enabled }),
      enabled => { if (statusContext) updateFastStatus(statusContext, enabled, currentModel); },
    );

    pi.events.on("piop:fast-mode:session", request => { request.session = session; });

    /** A saved choice wins; a session without one starts from the config file. */
    async function load(ctx: ExtensionContext): Promise<void> {
      session.reset();
      statusContext = ctx;
      currentModel = toModelRef(ctx.model);

      try {
        const saved = savedChoice(ctx);
        const initial = saved ?? (await loadConfigForScope({ cwd: ctx.cwd, extensionDir, agentDir })).config.enabled;
        session.load(initial);
        updateFastStatus(ctx, initial, currentModel);
      } catch (error) {
        session.fail(error);
        notifyError(ctx, error);
      }
    }

    pi.registerCommand("fast", {
      description: "Toggle Fast Mode. Usage: /fast [on|off|toggle]",
      getArgumentCompletions: getFastCommandCompletions,
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        try {
          await session.setEnabled(parseFastCommand(args, await session.getEnabled()));
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });

    pi.on("session_start", (_event, ctx) => load(ctx));
    pi.on("session_tree", (_event, ctx) => load(ctx));

    // The saved choice loads in this extension's session_start. Another extension can change the model before then, so the status waits for the load without holding up the model change.
    pi.on("model_select", (event, ctx) => {
      const model = toModelRef(event.model) ?? toModelRef(ctx.model);
      currentModel = model;
      void session.getEnabled().then(
        enabled => { if (currentModel === model) updateFastStatus(ctx, enabled, model); },
        error => { if (currentModel === model) { clearFastStatus(ctx); notifyError(ctx, error); } },
      );
    });

    pi.on("before_provider_request", async (event, ctx) => getFastModePayload(await session.getEnabled(), toModelRef(ctx.model) ?? currentModel, event.payload));

    pi.on("session_shutdown", (_event, ctx) => { statusContext = undefined; clearFastStatus(ctx); });
  };
}

const piFastModeExtension = createPiFastModeExtension();

export default piFastModeExtension;

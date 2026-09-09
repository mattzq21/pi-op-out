import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getFastCommandCompletions, parseFastCommand } from "./commands";
import {
  cloneConfig,
  loadConfigForScope,
  syncSupportedTargets,
} from "./config";
import { getFastModePayload, toModelRef } from "./payload";
import { clearFastStatus, updateFastStatus } from "./status";
import type { FastModeConfig, ModelRef } from "./types";

export type FastModeExtensionOptions = {
  /** Directory containing the extension entry point; used to detect project-local package installs. */
  extensionDir?: string;
  /** Test/advanced override for Pi's user-level agent directory. */
  agentDir?: string;
};

const DEFAULT_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = "piop-fast-mode-state";

function notifyError(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  error: unknown,
): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(message, "error");
}

export function createPiFastModeExtension(
  options: FastModeExtensionOptions = {},
): ExtensionFactory {
  const extensionDir = options.extensionDir ?? DEFAULT_EXTENSION_DIR;
  const agentDir = options.agentDir;

  return function piFastModeExtension(pi: ExtensionAPI): void {
    let config: FastModeConfig = cloneConfig();
    let loadedSessionId: string | undefined;
    let loadedCwd: string | undefined;
    let currentModel: ModelRef | undefined;
    let agentEnabled: boolean | undefined;
    const effectiveConfig = () => ({ ...config, enabled: agentEnabled ?? config.enabled });
    pi.events.on("piop:fast-mode", (request: { models?: string[]; apply?: boolean; enabled?: boolean; ctx?: ExtensionContext }) => {
      request.models = cloneConfig().targets.map((target) => `${target.provider}/${target.model}`);
      if (request.apply) {
        agentEnabled = request.enabled;
        if (request.ctx) updateFastStatus(request.ctx, effectiveConfig(), toModelRef(request.ctx.model) ?? currentModel);
      }
    });

    async function loadForContext(
      ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
    ): Promise<void> {
      const loaded = await loadConfigForScope({
        cwd: ctx.cwd,
        extensionDir,
        agentDir,
      });

      config = syncSupportedTargets(loaded.config);
      let savedEnabled: boolean | undefined;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
        const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
        if (typeof enabled === "boolean") savedEnabled = enabled;
      }
      config.enabled = savedEnabled ?? (pi.getFlag("fast") === true || config.enabled);
      if (savedEnabled === undefined) pi.appendEntry(STATE_ENTRY, { enabled: config.enabled });
      loadedCwd = ctx.cwd;
      loadedSessionId = ctx.sessionManager.getSessionId();
    }

    async function ensureLoaded(
      ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
    ): Promise<void> {
      if (loadedSessionId !== ctx.sessionManager.getSessionId() || loadedCwd !== ctx.cwd) {
        await loadForContext(ctx);
      }
    }

    function refreshCurrentModel(ctx: Pick<ExtensionContext, "model">): void {
      currentModel = toModelRef(ctx.model) ?? currentModel;
    }

    pi.registerFlag("fast", {
      description: "Start with Fast Mode enabled",
      type: "boolean",
      default: false,
    });

    pi.registerCommand("fast", {
      description: "Toggle Fast Mode. Usage: /fast [on|off|toggle]",
      getArgumentCompletions: getFastCommandCompletions,
      handler: async (
        args: string,
        ctx: ExtensionCommandContext,
      ): Promise<void> => {
        try {
          await ensureLoaded(ctx);
          refreshCurrentModel(ctx);
          const enabled = parseFastCommand(args, effectiveConfig().enabled);
          pi.appendEntry(STATE_ENTRY, { enabled });
          config.enabled = enabled;
          agentEnabled = undefined;
          updateFastStatus(ctx, effectiveConfig(), currentModel);
        } catch (error) {
          notifyError(ctx, error);
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      try {
        currentModel = toModelRef(ctx.model);
        await loadForContext(ctx);

        updateFastStatus(ctx, effectiveConfig(), currentModel);
      } catch (error) {
        notifyError(ctx, error);
      }
    });

    pi.on("session_tree", async (_event, ctx) => {
      try {
        await loadForContext(ctx);
        currentModel = toModelRef(ctx.model);
        updateFastStatus(ctx, effectiveConfig(), currentModel);
      } catch (error) {
        notifyError(ctx, error);
      }
    });

    pi.on("model_select", async (event, ctx) => {
      currentModel = toModelRef(event.model) ?? toModelRef(ctx.model);
      updateFastStatus(ctx, effectiveConfig(), currentModel);
    });

    pi.on("before_provider_request", (event, ctx) => {
      const model = toModelRef(ctx.model) ?? currentModel;
      return getFastModePayload(effectiveConfig(), model, event.payload);
    });

    pi.on("session_shutdown", (_event, ctx) => { clearFastStatus(ctx); });
  };
}

const piFastModeExtension = createPiFastModeExtension();

export default piFastModeExtension;

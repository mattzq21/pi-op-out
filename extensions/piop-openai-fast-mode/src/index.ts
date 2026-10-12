import { dirname } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getFastCommandCompletions, parseFastCommand } from "./commands";
import { createFastModeDiscovery, type FastModeDiscovery } from "./discovery";
import {
  cloneConfig,
  loadConfigForScope,
  syncSupportedTargets,
} from "./config";
import { getFastModePayload, toModelRef } from "./payload";
import { clearFastStatus, updateFastStatus } from "./status";
import type { FastModeConfig, FastTarget, ModelRef } from "./types";

export type FastModeExtensionOptions = {
  extensionDir?: string;
  agentDir?: string;
};

const DEFAULT_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

type SessionContext = Pick<ExtensionContext, "sessionManager">;

const sessionValueSchema = z.object({
  fastModeOverride: z.boolean().optional(), enabled: z.boolean().optional(),
  snapshot: z.object({ definition: z.object({ fastMode: z.boolean().optional() }).optional() }).optional(),
}).catch({});

function savedSessionValue(ctx: SessionContext): boolean | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom") continue;
    const data = sessionValueSchema.parse(entry.data);

    if (entry.customType === "piop-fast-mode-state") return data.enabled;

    if (entry.customType === "pi-define-agents-state") {
      const enabled = data.fastModeOverride ?? data.snapshot?.definition?.fastMode;

      if (enabled !== undefined) return enabled;
    }
  }
}

function notifyError(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  cause: unknown,
): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else console.error(`[fast-mode] ${message}`);
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
    let configuredTargets: FastTarget[] = [];
    let loading: Promise<void> | undefined;
    let discoveryError: string | undefined;
    const discover = createFastModeDiscovery();
    const discoverTargets = async (ctx: ExtensionContext): Promise<FastTarget[]> => {
      const result: FastModeDiscovery = await discover(ctx, configuredTargets, config.targets);
      const error = result.errors.length ? result.errors.join("\n") : undefined;

      if (error && error !== discoveryError) notifyError(ctx, error);
      discoveryError = error;

      return result.targets;
    };
    const effectiveConfig = () => ({ ...config, enabled: agentEnabled ?? config.enabled });
    pi.events.on("piop:fast-mode", request => {
      request.models = config.targets.map((target) => `${target.provider}/${target.model}`);

      const requestContext = request.ctx;

      if (request.refresh && requestContext) request.ready = ensureLoaded(requestContext).then(async () => {
        await refreshTargets(requestContext);
        request.models = config.targets.map((target) => `${target.provider}/${target.model}`);
      });

      if (request.apply) {
        agentEnabled = request.enabled;

        if (request.ctx) updateFastStatus(request.ctx, effectiveConfig(), toModelRef(request.ctx.model) ?? currentModel);
      }
    });

    async function loadForContext(
      ctx: ExtensionContext,
    ): Promise<void> {
      const loaded = await loadConfigForScope({
        cwd: ctx.cwd,
        extensionDir,
        agentDir,
      });

      configuredTargets = loaded.config.targets;
      config = syncSupportedTargets(loaded.config, await discoverTargets(ctx));
      config.enabled = savedSessionValue(ctx) ?? (pi.getFlag("fast") === true || config.enabled);
      agentEnabled = undefined;
      loadedCwd = ctx.cwd;
      loadedSessionId = ctx.sessionManager.getSessionId();
    }

    async function ensureLoaded(
      ctx: ExtensionContext,
    ): Promise<void> {
      if (loading) await loading;

      if (loadedSessionId !== ctx.sessionManager.getSessionId() || loadedCwd !== ctx.cwd) {
        loading = loadForContext(ctx);

        try { await loading; } finally { loading = undefined; }
      }
    }

    async function refreshTargets(ctx: ExtensionContext): Promise<void> {
      const targets = await discoverTargets(ctx);
      const changed = JSON.stringify(targets) !== JSON.stringify(config.targets);
      config.targets = targets;

      if (changed) pi.events.emit("piop:fast-mode-models-changed", { ctx });
      updateFastStatus(ctx, effectiveConfig(), toModelRef(ctx.model) ?? currentModel);
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
          await refreshTargets(ctx);
          refreshCurrentModel(ctx);
          const enabled = parseFastCommand(args, effectiveConfig().enabled);

          if (enabled === effectiveConfig().enabled) {
            updateFastStatus(ctx, effectiveConfig(), currentModel);

            return;
          }

          const request: { enabled: boolean; ready?: Promise<void> } = { enabled };
          pi.events.emit("piop:fast-mode-changed", request);

          if (!request.ready) throw new Error("Fast mode save handler unavailable");
          await request.ready;
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
        await ensureLoaded(ctx);

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
      await ensureLoaded(ctx);
      await refreshTargets(ctx);
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

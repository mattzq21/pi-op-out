import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export function registerFastModeStatus(pi: ExtensionAPI) {
  const packageName = "pi-openai-fast-mode";
  const statusKey = "pi-desktop-fast-mode";
  type FastConfig = { enabled: boolean; targets: Array<{ provider: string; model: string }> };
  let config: FastConfig | undefined;
  let loaded = false;
  let available = false;
  let queue = Promise.resolve();
  const loadConfig = async (path: string) => {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<FastConfig>;
      if (typeof value.enabled === "boolean" && Array.isArray(value.targets) && value.targets.every((target) => target && typeof target.provider === "string" && typeof target.model === "string")) config = value as FastConfig;
    } catch { }
  };
  const publish = (ctx: ExtensionContext, model = ctx.model) => {
    const supported = config?.targets.some((target) => target.provider === model?.provider && target.model === model?.id && ["openai", "openai-codex"].includes(target.provider));
    const text = available && config && supported ? (config.enabled ? "Fast mode on" : "Fast mode off") : undefined;
    ctx.ui.setStatus(statusKey, text);
  };
  const refresh = async (ctx: ExtensionContext, reload: boolean) => {
    if (ctx.mode !== "rpc") return;
    if (!loaded || reload) {
      const command = pi.getCommands().find((command) => command.source === "extension" && /^fast(?::\d+)?$/.test(command.name) && (command.sourceInfo.source === `npm:${packageName}` || command.sourceInfo.path.split(/[\\/]/).includes(packageName)));
      available = Boolean(command); config = undefined;
      if (command) {
        const projectDir = resolve(ctx.cwd, ".pi");
        const extensionDir = resolve(dirname(command.sourceInfo.path));
        const projectConfig = join(projectDir, packageName, "config.json");
        const projectLocal = extensionDir === projectDir || extensionDir.startsWith(`${projectDir}${sep}`);
        const path = existsSync(projectConfig) || projectLocal ? projectConfig : join(getAgentDir(), "extensions", packageName, "config.json");
        await loadConfig(path);
      }
      loaded = true;
    }
    publish(ctx);
  };
  pi.registerCommand("pi-desktop-fast-status", {
    description: "Read Fast Mode status for piop", handler: (args, ctx) => {
      const next = queue.then(() => refresh(ctx, args.trim() === "refresh"));
      queue = next.catch(() => undefined);
      return next;
    }
  });
  pi.on("session_start", () => { loaded = false; config = undefined; available = false; });
  pi.on("model_select", (event, ctx) => { if (ctx.mode === "rpc" && loaded) publish(ctx, event.model); });
}

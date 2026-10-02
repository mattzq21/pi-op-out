import type { RpcCommand, RpcEvent } from "../types";
import { z } from "zod";

type Command = { name: string; source: string; sourceInfo?: { source?: string; path?: string } };

export const commandListingSchema = z.object({
  commands: z.array(z.object({
    name: z.string(), source: z.string(),
    sourceInfo: z.object({ source: z.string().optional(), path: z.string().optional() }).optional(),
  })),
});

type FastModeConnection = {
  command: (command: RpcCommand) => Promise<void>;
  send: (command: RpcCommand) => Promise<void>;
  emit: (event: RpcEvent) => void;
};

export class FastModeCommands {
  private needsStatusRefresh = false;
  private commands = new Set<string>();

  constructor(private connection: FastModeConnection) {}

  reset() { this.needsStatusRefresh = false; this.commands.clear(); }

  afterCommand(command: RpcCommand, result?: z.infer<typeof commandListingSchema>) {
    if (command.type === "get_commands" && result) return this.discover(result.commands);

    if (command.type === "prompt") return this.afterPrompt(command);
  }

  private async discover(commands: Command[]) {
    const fromPackage = (item: Command, name: string) => item.sourceInfo?.source === `npm:${name}` || item.sourceInfo?.path?.split(/[\\/]/).includes(name);
    const localPackages = ["piop-openai-fast-mode", "pi-openai-fast-mode-piop"];
    const fastCommands = commands.filter(item => item.source === "extension" && /^fast(?::\d+)?$/.test(item.name) && [...localPackages, "pi-openai-fast-mode"].some(name => fromPackage(item, name)));
    this.commands = new Set(fastCommands.map(item => item.name));
    this.needsStatusRefresh = fastCommands.length > 0 && !fastCommands.some(item => localPackages.some(name => fromPackage(item, name)));
    await this.refreshStatus(false);
  }

  private async afterPrompt(command: RpcCommand) {
    const message = z.string().safeParse(command.message);
    const invocation = message.success ? message.data.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/) : undefined;

    if (invocation && this.commands.has(invocation[1]) && ["", "on", "off", "toggle"].includes((invocation[2] ?? "").trim().toLowerCase())) await this.refreshStatus(true);
  }

  private async refreshStatus(reload: boolean) {
    if (!this.needsStatusRefresh) return;

    try {
      await this.connection.send({ type: "fast_mode_status", reload });
    } catch {
      this.connection.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: "Fast mode status unavailable" });
    }
  }

  async set(enabled: boolean) {
    await this.connection.command({ type: "get_commands" });
    await this.change(enabled ? "on" : "off");
  }

  async toggle() { await this.change("toggle"); }

  private async change(mode: "on" | "off" | "toggle") {
    const command = this.commands.values().next().value;

    if (!command) throw new Error("Fast mode is unavailable in this conversation");
    await this.connection.send({ type: "prompt", message: `/${command} ${mode}` });
    await this.refreshStatus(true);
  }
}

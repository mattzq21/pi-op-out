import type { RpcCommand, RpcEvent } from "../types";

type CommandServices = {
  send: <T>(command: RpcCommand) => Promise<T>;
  command: <T>(command: RpcCommand) => Promise<T>;
  emit: (event: RpcEvent) => void;
};

type ExtensionCommand = { name: string; source: string; sourceInfo?: { source?: string; path?: string } };

export class ConversationCommands {
  private fastStatusCommand?: string;
  private fastCommands = new Set<string>();

  constructor(private readonly services: CommandServices) {}

  reset() { this.fastStatusCommand = undefined; this.fastCommands.clear(); }

  normalize(command: RpcCommand) {
    const compact = ["prompt", "steer", "follow_up"].includes(command.type) && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;
    if (compact && command.type !== "prompt") throw new Error("Stop or pause piop before running /compact.");
    if (compact) return { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) };
    return command;
  }

  afterCommand(command: RpcCommand, result: unknown): Promise<void> | undefined {
    if (command.type === "get_commands") return this.discoverFastCommands(result);
    if (command.type === "prompt") return this.afterPrompt(command);
  }

  private async discoverFastCommands(result: unknown) {
    const { commands } = result as { commands: ExtensionCommand[] };
    const fromPackage = (item: ExtensionCommand, name: string) => item.sourceInfo?.source === `npm:${name}` || item.sourceInfo?.path?.split(/[\\/]/).includes(name);
    const localFastPackages = ["piop-openai-fast-mode", "pi-openai-fast-mode-piop"];
    const fastCommands = commands.filter(item => item.source === "extension" && /^fast(?::\d+)?$/.test(item.name) && [...localFastPackages, "pi-openai-fast-mode"].some(name => fromPackage(item, name)));
    this.fastCommands = new Set(fastCommands.map(item => item.name));
    this.fastStatusCommand = fastCommands.some(item => localFastPackages.some(name => fromPackage(item, name))) ? undefined : commands.find(item => item.source === "extension" && item.name === "pi-desktop-fast-status")?.name;
    await this.refreshFastStatus(false);
  }

  private async afterPrompt(command: RpcCommand) {
    const invocation = typeof command.message === "string" ? command.message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/) : undefined;
    if (invocation && this.fastCommands.has(invocation[1]) && ["", "on", "off", "toggle"].includes((invocation[2] ?? "").trim().toLowerCase())) await this.refreshFastStatus(true);
  }

  private async refreshFastStatus(reload: boolean) {
    if (!this.fastStatusCommand) return;
    try {
      await this.services.send({ type: "prompt", message: `/${this.fastStatusCommand}${reload ? " refresh" : ""}` });
    } catch {
      this.services.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "pi-desktop-fast-mode", statusText: "Fast mode status unavailable" });
    }
  }

  async toggleFastMode() { await this.changeFastMode("toggle"); }

  async setFastMode(enabled: boolean) {
    await this.services.command({ type: "get_commands" });
    await this.changeFastMode(enabled ? "on" : "off");
  }

  private async changeFastMode(mode: "on" | "off" | "toggle") {
    const command = this.fastCommands.values().next().value;
    if (!command) throw new Error("Fast mode is unavailable in this conversation");
    await this.services.send({ type: "prompt", message: `/${command} ${mode}` });
    await this.refreshFastStatus(true);
  }
}

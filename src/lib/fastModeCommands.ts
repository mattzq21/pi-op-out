import type { RpcCommand, RpcEvent } from "../types";

type Command = { name: string; source: string; sourceInfo?: { source?: string; path?: string } };

type FastModeConnection = {
  command: (command: RpcCommand) => Promise<unknown>;
  send: (command: RpcCommand) => Promise<unknown>;
  emit: (event: RpcEvent) => void;
};

export class FastModeCommands {
  private statusCommand?: string;
  private commands = new Set<string>();

  constructor(private connection: FastModeConnection) {}

  reset() { this.statusCommand = undefined; this.commands.clear(); }

  afterCommand(command: RpcCommand, result: unknown) {
    if (command.type === "get_commands") return this.discover(result);

    if (command.type === "prompt") return this.afterPrompt(command);
  }

  private async discover(result: unknown) {
    const { commands } = result as { commands: Command[] };
    const fromPackage = (item: Command, name: string) => item.sourceInfo?.source === `npm:${name}` || item.sourceInfo?.path?.split(/[\\/]/).includes(name);
    const localPackages = ["piop-openai-fast-mode", "pi-openai-fast-mode-piop"];
    const fastCommands = commands.filter(item => item.source === "extension" && /^fast(?::\d+)?$/.test(item.name) && [...localPackages, "pi-openai-fast-mode"].some(name => fromPackage(item, name)));
    this.commands = new Set(fastCommands.map(item => item.name));
    this.statusCommand = fastCommands.some(item => localPackages.some(name => fromPackage(item, name))) ? undefined : commands.find(item => item.source === "extension" && item.name === "pi-desktop-fast-status")?.name;
    await this.refreshStatus(false);
  }

  private async afterPrompt(command: RpcCommand) {
    const invocation = typeof command.message === "string" ? command.message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/) : undefined;

    if (invocation && this.commands.has(invocation[1]) && ["", "on", "off", "toggle"].includes((invocation[2] ?? "").trim().toLowerCase())) await this.refreshStatus(true);
  }

  private async refreshStatus(reload: boolean) {
    if (!this.statusCommand) return;

    try {
      await this.connection.send({ type: "prompt", message: `/${this.statusCommand}${reload ? " refresh" : ""}` });
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

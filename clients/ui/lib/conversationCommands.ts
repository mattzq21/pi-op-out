import type { RpcCommand } from "../types";

export class ConversationCommands {
  normalize(command: RpcCommand) {
    if (["prompt", "steer", "follow_up"].includes(command.type) && command.message !== undefined && /^\/goal(?:\s|$)/.test(command.message.trimStart()) && Array.isArray(command.images) && command.images.length) {
      throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
    }
    return command;
  }
}

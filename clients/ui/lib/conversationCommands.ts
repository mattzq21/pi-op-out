import type { RpcCommand } from "../types";

export class ConversationCommands {
  normalize(command: RpcCommand) {
    if (["prompt", "steer", "follow_up"].includes(command.type) && command.message !== undefined && /^\/goal(?:\s|$)/.test(command.message.trimStart()) && Array.isArray(command.images) && command.images.length) {
      throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
    }
    const compact = ["prompt", "steer", "follow_up"].includes(command.type) && command.message !== undefined ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;

    if (compact && command.type !== "prompt") throw new Error("Stop or pause piop before running /compact.");

    if (compact) {
      const customInstructions = compact[1]?.trim();

      return customInstructions ? { type: "compact", customInstructions } : { type: "compact" };
    }

    return command;
  }
}

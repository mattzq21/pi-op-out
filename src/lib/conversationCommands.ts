import type { RpcCommand } from "../types";
import { FastModeCommands } from "./fastModeCommands";

export class ConversationCommands extends FastModeCommands {
  private goalAttachments(command: RpcCommand) {
    if (command.type === "prompt" && command.message !== undefined && /^\/goal\s+\S/.test(command.message) && Array.isArray(command.images) && command.images.length) {
      const objective = command.message.slice(6);
      const attachments = command.images.map((image, index) => ({ name: `Image ${index + 1}`, image }));

      return { ...command, message: `/goal __piop_draft ${JSON.stringify({ objective, attachments })}`, images: undefined };
    }

    return command;
  }
  normalize(command: RpcCommand) {
    command = this.goalAttachments(command);
    const compact = ["prompt", "steer", "follow_up"].includes(command.type) && command.message !== undefined ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;

    if (compact && command.type !== "prompt") throw new Error("Stop or pause piop before running /compact.");

    if (compact) {
      const customInstructions = compact[1]?.trim();

      return customInstructions ? { type: "compact", customInstructions } : { type: "compact" };
    }

    return command;
  }
}

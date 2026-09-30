import type { RpcCommand } from "../types";
import { FastModeCommands } from "./fastModeCommands";

export class ConversationCommands extends FastModeCommands {
  private goalAttachments(command: RpcCommand) {
    if (command.type === "prompt" && typeof command.message === "string" && /^\/goal\s+\S/.test(command.message) && Array.isArray(command.images) && command.images.length) {
      const objective = command.message.slice(6);
      const attachments = command.images.map((image, index) => ({ name: `Image ${index + 1}`, image }));
      return { ...command, message: `/goal __piop_draft ${JSON.stringify({ objective, attachments })}`, images: undefined };
    }
    return command;
  }
  normalize(command: RpcCommand) {
    command = this.goalAttachments(command);
    const compact = ["prompt", "steer", "follow_up"].includes(command.type) && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;
    if (compact && command.type !== "prompt") throw new Error("Stop or pause piop before running /compact.");
    if (compact) return { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) };
    return command;
  }
}

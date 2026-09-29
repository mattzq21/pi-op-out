import type { RpcCommand } from "../types";
import { FastModeCommands } from "./fastModeCommands";

export class ConversationCommands extends FastModeCommands {
  normalize(command: RpcCommand) {
    const compact = ["prompt", "steer", "follow_up"].includes(command.type) && typeof command.message === "string" ? command.message.match(/^\/compact(?:\s+([\s\S]*))?$/) : null;
    if (compact && command.type !== "prompt") throw new Error("Stop or pause piop before running /compact.");
    if (compact) return { type: "compact", ...(compact[1]?.trim() ? { customInstructions: compact[1].trim() } : {}) };
    return command;
  }
}

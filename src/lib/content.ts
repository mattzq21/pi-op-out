import type { ChatMessage } from "../types";
import { z } from "zod";

const INVISIBLE_CHARS = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

export function stripInvisible(value: string) {
  return value.replace(INVISIBLE_CHARS, "");
}

export function hasVisibleText(value: string) {
  return stripInvisible(value).trim().length > 0;
}

export function isBlank(value: string) {
  return !hasVisibleText(value);
}

export function textOf(content: ChatMessage["content"]): string {
  if (!Array.isArray(content)) return z.string().catch("").parse(content);

  return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

export function thinkingOf(content: ChatMessage["content"]): string {
  if (!Array.isArray(content)) return "";

  return content.flatMap((part) => part.type === "thinking" ? [part.thinking] : []).join("\n\n");
}

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

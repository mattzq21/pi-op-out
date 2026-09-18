import type { ChatMessage, ContentPart } from "../types";

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
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("");
}

export function thinkingOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return "";
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is Extract<ContentPart, { type: "thinking" }> => part.type === "thinking").map((part) => part.thinking).join("\n\n");
}

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

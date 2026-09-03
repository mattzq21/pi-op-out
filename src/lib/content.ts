import type { ChatMessage, ContentPart } from "../types";

export function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("");
}

export function thinkingOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return "";
  return content.filter((part): part is Extract<ContentPart, { type: "thinking" }> => part.type === "thinking").map((part) => part.thinking).join("\n\n");
}

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

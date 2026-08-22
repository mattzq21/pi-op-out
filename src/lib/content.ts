import type { ChatMessage, ContentPart } from "../types";

export function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("");
}

export function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function projectName(cwd: string) {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace";
}

export function relativeTime(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

import { createContext } from "solid-js";
import { nativeCall } from "./nativeCall";
import { isMobile } from "./platform";
import { fileReference } from "./projectFiles";
import { voidResultSchema } from "./responseSchemas";

export interface MessageFileScope { hostId: () => string; cwd: () => string | undefined; notify?: (title: string, message: string) => void; }

export const MessageFileContext = createContext<MessageFileScope>();

export const canOpenFileLinks = !isMobile;

export function fileLinkTooltip(href: string, cwd: string | undefined) {
  try { return messageFilePath(href, cwd); } catch { return fileReference(href)?.path ?? href; }
}

export function openablePath(value: string) {
  return /^(?:\/|~(?:\/|$))/.test(fileReference(value)?.path ?? "");
}

export function messageFilePath(href: string, cwd: string | undefined) {
  const reference = fileReference(href);

  if (!reference) throw new Error(`Not a file path: ${href}`);
  if (reference.path.startsWith("/")) return reference.path;
  if (/^~(?:\/|$)/.test(reference.path)) return reference.path;
  if (!cwd) throw new Error(`This chat has no project directory, thus the relative path ${reference.path} cannot be found`);

  return `${cwd.replace(/\/+$/, "")}/${reference.path.replace(/^\.\//, "")}`;
}

export function openMessageFile(href: string, scope: MessageFileScope | undefined) {
  return localFileCall("open_local_file", href, scope);
}

export function revealMessageFile(href: string, scope: MessageFileScope | undefined) {
  return localFileCall("reveal_local_file", href, scope);
}

async function localFileCall(command: "open_local_file" | "reveal_local_file", href: string, scope: MessageFileScope | undefined) {
  if (isMobile) throw new Error("Opening files is not supported on Android");
  if (!scope) throw new Error("This message has no conversation, thus the file host is not known");
  const hostId = scope.hostId();

  if (hostId !== "local") throw new Error(`This file is on the host "${hostId}". Piop can open only files on this computer.`);
  await nativeCall(command, { path: messageFilePath(href, scope.cwd()), hostId }, voidResultSchema);
}

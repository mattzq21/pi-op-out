import { createContext } from "solid-js";
import { nativeCall } from "./nativeCall";
import { isMobile } from "./platform";
import { fileReference } from "./projectFiles";
import { voidResultSchema } from "./responseSchemas";

/** The conversation data that file links in messages use: the host of the files, the project directory, and the toast output. */
export interface MessageFileScope { hostId: () => string; cwd: () => string | undefined; notify?: (title: string, message: string) => void; }

export const MessageFileContext = createContext<MessageFileScope>();

/** Android keeps the files on the host, thus file links open only on the desktop. */
export const canOpenFileLinks = !isMobile;

/** The full path of a file link, for its tooltip. A relative path without a project directory stays relative. */
export function fileLinkTooltip(href: string, cwd: string | undefined) {
  try { return messageFilePath(href, cwd); } catch { return fileReference(href)?.path ?? href; }
}

/** Get the absolute path of a file link. Relative paths start at the project directory. */
export function messageFilePath(href: string, cwd: string | undefined) {
  const reference = fileReference(href);

  if (!reference) throw new Error(`Not a file path: ${href}`);
  if (reference.path.startsWith("/")) return reference.path;
  if (reference.path.startsWith("~")) throw new Error(`Paths that start with ~ are not supported: ${reference.path}`);
  if (!cwd) throw new Error(`This chat has no project directory, thus the relative path ${reference.path} cannot be found`);

  return `${cwd.replace(/\/+$/, "")}/${reference.path.replace(/^\.\//, "")}`;
}

/** Open the file of a link with the default app of this computer. */
export async function openMessageFile(href: string, scope: MessageFileScope | undefined) {
  if (isMobile) throw new Error("Opening files is not supported on Android");
  if (!scope) throw new Error("This message has no conversation, thus the file host is not known");
  const hostId = scope.hostId();

  if (hostId !== "local") throw new Error(`This file is on the host "${hostId}". Piop can open only files on this computer.`);
  await nativeCall("open_local_file", { path: messageFilePath(href, scope.cwd()), hostId }, voidResultSchema);
}

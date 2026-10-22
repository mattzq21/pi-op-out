import { webUrl } from "./webLinks";

export interface FileProject { cwd: string; hostId: string; }

export interface FileReference { path: string; line?: number; column?: number; }

function decodeFilePath(value: string) {
  let path = value.trim();

  if (!path || /[\n\r\0]/.test(path)) return undefined;

  if (path.startsWith("file://")) {
    try { const url = new URL(path);

    if (url.hostname && url.hostname !== "localhost") return undefined; path = `${url.pathname}${url.hash}`; }
    catch { return undefined; }
  }

  try { return decodeURIComponent(path); } catch { return undefined; }
}

function sourceLocation(location: RegExpMatchArray | null) {
  if (!location) return {};
  const line = Number(location[1] ?? location[3]);
  const column = Number(location[2] ?? location[4] ?? 1);

  return { line: Number.isSafeInteger(line) ? Math.max(1, line) : 1, column: Number.isSafeInteger(column) ? Math.max(1, column) : 1 };
}

export function fileReference(value: string): FileReference | undefined {
  let path = decodeFilePath(value);

  if (!path || webUrl(path)) return undefined;
  const location = path.match(/(?::(\d+)(?::(\d+))?(?:-\d+)?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/);

  if (location) path = path.slice(0, location.index);

  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined;

  if (!path || /[?#<>|\n\r\0]/.test(path)) return undefined;

  return { path, ...sourceLocation(location) };
}

export function looksLikeFile(value: string) {
  const reference = fileReference(value);

  if (!reference || /\s/.test(reference.path)) return false;
  const path = reference.path;

  return /(?:^|\/)(?:[\w@+.-]+\.[a-z\d_-]+|\.[\w.-]+|Dockerfile|Makefile|Justfile|LICENSE|README|AGENTS\.md)$/i.test(path)
    || /^(?:\.{0,2}\/|~\/|[\w@.-]+\/)[\w@./+~-]+$/.test(path);
}

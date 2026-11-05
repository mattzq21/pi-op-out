import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CALL = /\/skill:(\S+)(?:\s+|$)/y;

export function leadingCalls(text: string) {
  const names: string[] = [];
  let at = 0;

  for (let match; at < text.length; at = CALL.lastIndex) {
    CALL.lastIndex = at;
    match = CALL.exec(text);
    if (!match) break;
    names.push(match[1]);
  }

  return { names, rest: text.slice(at).trim() };
}

export function skillPaths(pi: ExtensionAPI) {
  return new Map(pi.getCommands().flatMap(command => command.source === "skill" ? [[command.name.replace(/^skill:/, ""), command.sourceInfo.path] as const] : []));
}

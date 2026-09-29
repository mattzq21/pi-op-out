import type { ComposerUpload, SlashCommand } from "../types";

export const skillName = (command: SlashCommand) => command.source === "skill" ? command.name.replace(/^skill:/, "") : undefined;
export const skillReference = (value: string) => value.match(/(?:^|[\s([{])\$([a-zA-Z0-9_-]*)$/)?.[1]?.toLowerCase();
function expandSkillReference(value: string, commands: SlashCommand[]) {
  if (value.startsWith("/")) return value;
  const skills = new Map(commands.flatMap((command) => { const name = skillName(command); return name ? [[name.toLowerCase(), name] as const] : []; }));
  const reference = /(^|[^a-zA-Z0-9_$])\$([a-zA-Z0-9][a-zA-Z0-9_-]*)\b/g;
  let primary: string | undefined;
  let rest = value;
  const prose = value.replace(/(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)|(`+)[^`]*?\4/g, (code) => code.replace(/[^\n]/g, " "));
  for (const match of [...prose.matchAll(reference)]) {
    const name = skills.get(match[2].toLowerCase());
    if (!name || match.index === undefined) continue;
    if (!primary) primary = name;
    const token = match[0].slice(match[1].length);
    const at = match.index + match[1].length;
    if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + token.length);
    break;
  }
  if (!primary) return value;
  rest = rest.trim();
  return `/skill:${primary}${rest ? ` ${rest}` : ""}`;
}
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

export function buildComposerPrompt(value: string, uploads: ComposerUpload[], commands: SlashCommand[]) {
  const textFiles = uploads.filter((upload) => upload.kind === "text");
  const escapeFileContent = (text: string) => text.replace(/<\/file>/gi, "<\\/file>");
  const message = [expandSkillReference(value.trim(), commands), ...textFiles.map((file) => `<file name="${escapeAttribute(file.name)}">\n${escapeFileContent(file.text ?? "")}\n</file>`)].filter(Boolean).join("\n\n");
  const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);
  return { message, images };
}

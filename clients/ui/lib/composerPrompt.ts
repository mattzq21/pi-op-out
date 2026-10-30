import { required } from "./required";
import type { ComposerUpload, SlashCommand } from "../types";

export const skillName = (command: SlashCommand) => command.source === "skill" ? command.name.replace(/^skill:/, "") : undefined;

export const isPromptCommand = (command: SlashCommand) => command.name === "goal" || command.source === "skill" || command.source === "prompt";

export function composerReference(value: string, caret: number) {
  const match = value.slice(0, caret).match(/(?:^|\s)([/$])([^\s/$]*)$/);

  return match ? { start: caret - match[2].length - 1, end: caret, marker: match[1], query: match[2].toLowerCase() } : undefined;
}

function expandInlineCommand(value: string, commands: SlashCommand[]) {
  if (value.startsWith("/")) return value;
  const available = new Map<string, SlashCommand>();

  for (const command of commands) {
    if (isPromptCommand(command)) available.set(command.name, command);
  }

  for (const match of proseOnly(value).matchAll(/\s\/(\S+)(?=\s|$)/g)) {
    const command = available.get(match[1]);

    if (!command) continue;
    const rest = `${value.slice(0, match.index)}${value.slice(match.index + match[0].length)}`.trim();

    return `/${command.name}${rest ? ` ${rest}` : ""}`;
  }

  return value;
}

const proseOnly = (value: string) => value.replace(/(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)|(`+)[^`]*?\4/g, (code) => code.replace(/[^\n]/g, " "));

export const skillReference = (value: string) => value.match(/(?:^|[\s([{])\$([a-zA-Z0-9_-]*)$/)?.[1]?.toLowerCase();

/** Skill names by their lowercase form. */
export const skillNames = (commands: SlashCommand[]) => new Map(commands.flatMap((command): Array<[string, string]> => { const name = skillName(command);

  return name ? [[name.toLowerCase(), name]] : []; }));

/** The `$skill` reference that the message uses, if any. Only the first known skill in the prose counts. */
export function findSkillReference(value: string, skills: ReadonlyMap<string, string>) {
  if (value.trimStart().startsWith("/") || !value.includes("$") || !skills.size) return undefined;

  for (const match of proseOnly(value).matchAll(/(^|[^a-zA-Z0-9_$])\$([a-zA-Z0-9][a-zA-Z0-9_-]*)\b/g)) {
    const name = skills.get(match[2].toLowerCase());

    if (!name) continue;
    const start = match.index + match[1].length;

    return { name, start, end: start + match[2].length + 1 };
  }

  return undefined;
}

function expandSkillReference(value: string, commands: SlashCommand[]) {
  const found = findSkillReference(value, skillNames(commands));

  if (!found) return value;
  const before = value.slice(0, found.start);
  const after = value.slice(found.end);
  const rest = (before + (/\s$/.test(before) && /^[ \t]/.test(after) ? after.slice(1) : after)).trim();

  return `/skill:${found.name}${rest ? ` ${rest}` : ""}`;
}

const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (character) => required(({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]));

/** A text file attached to a message. The message ends with one block per file, so the model reads the file with the prompt. */
export interface AttachedFile { name: string; text: string }

const unescapeAttribute = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => required(({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name]));

/** The message for a prompt and its text files. File text cannot end its block early, because a closing tag inside it is escaped. */
export function attachFiles(prompt: string, files: AttachedFile[]) {
  return [prompt, ...files.map((file) => '<file name="' + escapeAttribute(file.name) + '">\n' + file.text.replace(/<\/file>/gi, "<\\/file>") + "\n</file>")].filter(Boolean).join("\n\n");
}

const FILE_BLOCK = /<file name="([^"]*)">\n([\s\S]*?)\n<\/file>/y;

/** Splits a message made by attachFiles into its prompt and text files. A message without file blocks at its end is all prompt. */
export function splitAttachedFiles(message: string): { prompt: string; files: AttachedFile[] } {
  for (let start = message.indexOf('<file name="'); start >= 0; start = message.indexOf('<file name="', start + 1)) {
    if (start > 0 && !message.slice(0, start).endsWith("\n\n")) continue;
    const files: AttachedFile[] = [];
    let at = start;

    while (at < message.length) {
      FILE_BLOCK.lastIndex = at;
      const block = FILE_BLOCK.exec(message);

      if (!block) break;
      files.push({ name: unescapeAttribute(block[1]), text: block[2].replace(/<\\\/file>/gi, "</file>") });
      at = FILE_BLOCK.lastIndex;

      if (at < message.length) {
        if (!message.startsWith("\n\n", at)) break;
        at += 2;
      }
    }

    if (at === message.length && files.length) return { prompt: message.slice(0, start).replace(/\n\n$/, ""), files };
  }

  return { prompt: message, files: [] };
}

export function buildComposerPrompt(value: string, uploads: ComposerUpload[], commands: SlashCommand[]) {
  const prompt = expandSkillReference(expandInlineCommand(value.trim(), commands), commands);

  if (prompt === "/goal") throw new Error("Write an objective or an action after /goal. Usage: /goal <objective | edit | pause | resume | clear>");
  if (/^\/goal(?:\s|$)/.test(prompt) && uploads.length) throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
  const message = attachFiles(prompt, uploads.flatMap((upload) => upload.kind === "text" ? [{ name: upload.name, text: upload.text ?? "" }] : []));
  const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);

  return { message, images };
}

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
    if (isPromptCommand(command) && command.source !== "skill") available.set(command.name, command);
  }

  for (const match of proseOnly(value).matchAll(/\s\/(\S+)(?=\s|$)/g)) {
    const command = available.get(match[1]);

    if (!command) continue;
    const rest = `${value.slice(0, match.index)}${value.slice(match.index + match[0].length)}`.trim();

    return `/${command.name}${rest ? ` ${rest}` : ""}`;
  }

  return value;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

const proseOnly = (value: string) => value.replace(/(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)|(`+)[^`]*?\4/g, blank).replace(/!?\[(?:\\.|[^\\\]\n])*\]\([^()\n]*\)/g, blank);

export const skillReference = (value: string) => value.match(/(?:^|\s)\$([a-zA-Z0-9_-]*)$/)?.[1]?.toLowerCase();

export const skillNames = (commands: SlashCommand[]) => new Map(commands.flatMap((command): Array<[string, string]> => { const name = skillName(command);

  return name ? [[name.toLowerCase(), name]] : []; }));

export function findSkillReferences(value: string, skills: ReadonlyMap<string, string>) {
  if (/^\s*\/(?!skill:)/.test(value) || !skills.size) return [];

  return [...proseOnly(value).matchAll(/(^|\s)(\$|\/skill:)([a-zA-Z0-9][a-zA-Z0-9_-]*)(?=\s|$)/g)].flatMap(match => {
    const name = skills.get(match[3].toLowerCase());
    const start = match.index + match[1].length;

    return name ? [{ name, start, end: start + match[2].length + match[3].length }] : [];
  });
}

function expandSkillReferences(value: string, commands: SlashCommand[]) {
  const names = new Set(findSkillReferences(value, skillNames(commands)).map(found => found.name));

  return names.size ? `${[...names].map(name => `/skill:${name}`).join(" ")} ${value}` : value;
}

const SKILL_BLOCK = /<skill\s+name="([^"]+)"\s+location="[^"]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?\n<\/skill>(?:\n\n|$)/iy;

const QUEUED_SKILL = /\/skill:([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+|$)/y;

function leadingSkills(message: string, pattern: RegExp) {
  const skills: string[] = [];
  let at = 0;

  for (let match; at < message.length; at = pattern.lastIndex) {
    pattern.lastIndex = at;
    match = pattern.exec(message);

    if (!match) break;
    skills.push(match[1]);
  }

  if (!skills.length) return undefined;
  const text = message.slice(at).trim();
  const missing = skills.filter(skill => !findSkillReferences(text, new Map([[skill.toLowerCase(), skill]])).length);

  return { skills, text: [...missing.map(skill => `$${skill}`), text].filter(Boolean).join(" ") };
}

export const sentSkillPrompt = (message: string) => leadingSkills(message, SKILL_BLOCK);

export const queuedSkillPrompt = (message: string) => leadingSkills(message, QUEUED_SKILL);

const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (character) => required(({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]));

export interface AttachedFile { name: string; text: string }

const unescapeAttribute = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => required(({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name]));

export function attachFiles(prompt: string, files: AttachedFile[]) {
  return [prompt, ...files.map((file) => '<file name="' + escapeAttribute(file.name) + '">\n' + file.text.replace(/<\/file>/gi, "<\\/file>") + "\n</file>")].filter(Boolean).join("\n\n");
}

const FILE_BLOCK = /<file name="([^"]*)">\n([\s\S]*?)\n<\/file>/y;

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

export function expandComposerPrompt(value: string, commands: SlashCommand[]) {
  return expandSkillReferences(expandInlineCommand(value.trim(), commands), commands);
}

export function buildComposerPrompt(value: string, uploads: ComposerUpload[], commands: SlashCommand[]) {
  const prompt = expandComposerPrompt(value, commands);

  if (prompt === "/goal") throw new Error("Write an objective or an action after /goal. Usage: /goal <objective | edit | pause | resume | clear>");
  if (/^\/goal(?:\s|$)/.test(prompt) && uploads.length) throw new Error("Goals do not accept attachments. Remove the files and images before sending.");
  const message = attachFiles(prompt, uploads.flatMap((upload) => upload.kind === "text" ? [{ name: upload.name, text: upload.text ?? "" }] : []));
  const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);

  return { message, images };
}

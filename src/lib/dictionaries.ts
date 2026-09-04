import type { PromptDictionary } from "../types";

export interface DictionaryMatch { start: number; end: number; replacement: string }

const wordCharacter = /[\p{L}\p{N}_]/u;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function dictionaryMatches(value: string, dictionaries: PromptDictionary[] = [], limit = Number.POSITIVE_INFINITY): DictionaryMatch[] {
  const entries = new Map<string, string>();
  for (const dictionary of dictionaries) for (const entry of dictionary.entries) {
    const word = entry.word.trim(); const replacement = entry.replacement.trim();
    if (word && replacement && !entries.has(word)) entries.set(word, replacement);
  }
  const words = [...entries.keys()].sort((left, right) => right.length - left.length);
  if (!words.length) return [];
  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "gu");
  const matches: DictionaryMatch[] = [];
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if ((start > 0 && wordCharacter.test(value[start - 1])) || (end < value.length && wordCharacter.test(value[end]))) continue;
    const replacement = entries.get(match[0]);
    if (replacement !== undefined) {
      matches.push({ start, end, replacement });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

export function applyDictionary(value: string, dictionaries: PromptDictionary[] = []) {
  const matches = dictionaryMatches(value, dictionaries);
  if (!matches.length) return value;
  let result = ""; let offset = 0;
  for (const match of matches) { result += value.slice(offset, match.start) + match.replacement; offset = match.end; }
  return result + value.slice(offset);
}

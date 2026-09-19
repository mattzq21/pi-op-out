import { DiffParser } from './diffParser';

export type DiffPart = { text: string; changed: boolean };
export type DiffLine = { kind: "add" | "delete" | "context" | "meta"; text: string; oldLine?: number; newLine?: number; parts?: DiffPart[] };
export type DiffFile = { id: string; path: string; oldPath?: string; lines: DiffLine[]; additions: number; deletions: number };

const MAX_ANNOTATED_LINE_CHARS = 4_000;
const MAX_PAIR_MATRIX_CELLS = 400;
const MAX_TOKEN_MATRIX_CELLS = 40_000;

const tokens = (text: string) => text.match(/#[\da-fA-F]{3,8}\b|\s+|[\p{L}\p{N}_$]+|./gu) ?? [];

function appendPart(parts: DiffPart[], text: string, changed: boolean) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.changed === changed) previous.text += text;
  else parts.push({ text, changed });
}

function boundedIntralineParts(before: string, after: string): [DiffPart[], DiffPart[]] {
  let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
  const split = (text: string) => [{ text: text.slice(0, prefix), changed: false }, { text: text.slice(prefix, text.length - suffix), changed: true }, { text: suffix ? text.slice(-suffix) : "", changed: false }].filter((part) => part.text);
  return [split(before), split(after)];
}

function matchingTokenTable(left: string[], right: string[]) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  return table;
}

function intralineParts(before: string, after: string): [DiffPart[], DiffPart[]] {
  const left = tokens(before); const right = tokens(after);
  if (left.length * right.length > MAX_TOKEN_MATRIX_CELLS) return boundedIntralineParts(before, after);
  const table = matchingTokenTable(left, right);
  const leftParts: DiffPart[] = []; const rightParts: DiffPart[] = []; let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { appendPart(leftParts, left[i], false); appendPart(rightParts, right[j], false); i += 1; j += 1; }
    else if (i < left.length && (j === right.length || table[i + 1][j] >= table[i][j + 1])) { appendPart(leftParts, left[i], true); i += 1; }
    else { appendPart(rightParts, right[j], true); j += 1; }
  }
  return [leftParts, rightParts];
}

function similarity(left: string, right: string) {
  if (left === right) return 1;
  const a = tokens(left); const b = tokens(right); if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>(); for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let common = 0; for (const token of b) { const count = counts.get(token) ?? 0; if (count > 0) { common += 1; counts.set(token, count - 1); } }
  return 2 * common / (a.length + b.length);
}

function canAnnotate(deleted: DiffLine[], added: DiffLine[]) {
  return deleted.length > 0 && added.length > 0 && deleted.length * added.length <= MAX_PAIR_MATRIX_CELLS && ![...deleted, ...added].some((line) => line.text.length > MAX_ANNOTATED_LINE_CHARS);
}

function linePairTable(scores: number[][], width: number) {
  const table = Array.from({ length: scores.length + 1 }, () => new Float32Array(width + 1));
  for (let i = scores.length - 1; i >= 0; i -= 1) for (let j = width - 1; j >= 0; j -= 1) table[i][j] = Math.max(table[i + 1][j], table[i][j + 1], scores[i][j] >= .35 ? scores[i][j] + table[i + 1][j + 1] : 0);
  return table;
}

function annotateBlock(block: DiffLine[]) {
  const deleted = block.filter((line) => line.kind === "delete"); const added = block.filter((line) => line.kind === "add");
  if (!canAnnotate(deleted, added)) return;
  const scores = deleted.map((line) => added.map((candidate) => similarity(line.text, candidate.text)));
  const table = linePairTable(scores, added.length);
  let i = 0; let j = 0;
  while (i < deleted.length && j < added.length) {
    const paired = scores[i][j] >= .35 ? scores[i][j] + table[i + 1][j + 1] : -1;
    if (paired >= table[i + 1][j] && paired >= table[i][j + 1]) { [deleted[i].parts, added[j].parts] = intralineParts(deleted[i].text, added[j].text); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
}

function annotateIntraline(files: DiffFile[]) {
  for (const file of files) {
    let block: DiffLine[] = [];
    const flush = () => { annotateBlock(block); block = []; };
    for (const line of file.lines) { if (line.kind === "add" || line.kind === "delete") block.push(line); else flush(); }
    flush();
  }
}

export function parseDiff(patch: string, fallbackPath?: string): DiffFile[] {
  const files = new DiffParser(fallbackPath).parse(patch);
  annotateIntraline(files); return files;
}

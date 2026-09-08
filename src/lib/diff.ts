export type DiffPart = { text: string; changed: boolean };
export type DiffLine = { kind: "add" | "delete" | "context" | "meta"; text: string; oldLine?: number; newLine?: number; parts?: DiffPart[] };
export type DiffFile = { id: string; path: string; lines: DiffLine[]; additions: number; deletions: number };

const MAX_DIFF_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_RENDERED_DIFF_LINES = 10_000;
const MAX_RENDERED_LINE_CHARS = 20_000;
const MAX_ANNOTATED_LINE_CHARS = 4_000;
const MAX_PAIR_MATRIX_CELLS = 400;
const MAX_TOKEN_MATRIX_CELLS = 40_000;

function decodeGitPath(value: string) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const source = value.slice(1, -1); const bytes: number[] = []; const encoder = new TextEncoder();
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\\": 92, '"': 34 };
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\") { const character = String.fromCodePoint(source.codePointAt(index)!); bytes.push(...encoder.encode(character)); index += character.length - 1; continue; }
    const next = source[++index]; if (next === undefined) break;
    if (/[0-7]/.test(next)) { let octal = next; while (octal.length < 3 && /[0-7]/.test(source[index + 1] ?? "")) octal += source[++index]; bytes.push(Number.parseInt(octal, 8)); }
    else if (escapes[next] !== undefined) bytes.push(escapes[next]);
    else bytes.push(...encoder.encode(next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function displayPath(header: string) {
  const fields = header.replace(/^diff --git\s+/, "").match(/"(?:\\.|[^"])*"|\S+/g) ?? [];
  const decoded = decodeGitPath(fields[1] ?? fields[0] ?? "");
  return decoded.replace(/^b\//, "");
}

const tokens = (text: string) => text.match(/#[\da-fA-F]{3,8}\b|\s+|[\p{L}\p{N}_$]+|./gu) ?? [];

function appendPart(parts: DiffPart[], text: string, changed: boolean) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.changed === changed) previous.text += text;
  else parts.push({ text, changed });
}

function intralineParts(before: string, after: string): [DiffPart[], DiffPart[]] {
  const left = tokens(before); const right = tokens(after);
  if (left.length * right.length > MAX_TOKEN_MATRIX_CELLS) {
    let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
    const split = (text: string) => [{ text: text.slice(0, prefix), changed: false }, { text: text.slice(prefix, text.length - suffix), changed: true }, { text: suffix ? text.slice(-suffix) : "", changed: false }].filter((part) => part.text);
    return [split(before), split(after)];
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
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

function annotateBlock(block: DiffLine[]) {
  const deleted = block.filter((line) => line.kind === "delete"); const added = block.filter((line) => line.kind === "add");
  if (!deleted.length || !added.length || deleted.length * added.length > MAX_PAIR_MATRIX_CELLS || [...deleted, ...added].some((line) => line.text.length > MAX_ANNOTATED_LINE_CHARS)) return;
  const scores = deleted.map((line) => added.map((candidate) => similarity(line.text, candidate.text)));
  const table = Array.from({ length: deleted.length + 1 }, () => new Float32Array(added.length + 1));
  for (let i = deleted.length - 1; i >= 0; i -= 1) for (let j = added.length - 1; j >= 0; j -= 1) table[i][j] = Math.max(table[i + 1][j], table[i][j + 1], scores[i][j] >= .35 ? scores[i][j] + table[i + 1][j + 1] : 0);
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

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let inHunk = false; let oldLine = 0; let newLine = 0; let renderedLines = 0;
  const boundedPatch = patch.slice(0, MAX_DIFF_INPUT_CHARS);
  const pushLine = (line: DiffLine) => { if (!file || renderedLines >= MAX_RENDERED_DIFF_LINES) return; file.lines.push(line.text.length > MAX_RENDERED_LINE_CHARS ? { ...line, text: `${line.text.slice(0, MAX_RENDERED_LINE_CHARS)}…` } : line); renderedLines += 1; };
  for (const text of boundedPatch.split("\n")) {
    if (text.startsWith("diff --git ")) {
      file = { id: `${files.length}:${text}`, path: displayPath(text), lines: [], additions: 0, deletions: 0 };
      inHunk = false; files.push(file); continue;
    }
    if (!file) continue;
    if (!inHunk && (text.startsWith("+++ ") || text.startsWith("--- "))) {
      const path = decodeGitPath(text.slice(4).split("\t")[0]);
      if (path !== "/dev/null") file.path = path.replace(/^[ab]\//, "");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); pushLine({ kind: "meta", text }); continue; }
    if (inHunk && text.startsWith("+")) { pushLine({ kind: "add", text: text.slice(1), newLine: newLine++ }); file.additions += 1; continue; }
    if (inHunk && text.startsWith("-")) { pushLine({ kind: "delete", text: text.slice(1), oldLine: oldLine++ }); file.deletions += 1; continue; }
    if (text.startsWith(" ")) { pushLine({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ }); continue; }
    if (text && !text.startsWith("index ") && !text.startsWith("--- ") && !text.startsWith("+++ ")) pushLine({ kind: "meta", text });
  }
  if (patch.length > boundedPatch.length || renderedLines >= MAX_RENDERED_DIFF_LINES) files.at(-1)?.lines.push({ kind: "meta", text: "Diff display truncated for performance." });
  annotateIntraline(files); return files;
}

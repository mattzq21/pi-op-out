export type DiffPart = { text: string; changed: boolean };
export type DiffLine = { kind: "add" | "delete" | "context" | "meta"; text: string; oldLine?: number; newLine?: number; parts?: DiffPart[] };
export type DiffFile = { id: string; path: string; lines: DiffLine[]; additions: number; deletions: number };

function displayPath(header: string) {
  const quotedMarker = header.lastIndexOf(' "b/');
  const marker = quotedMarker >= 0 ? quotedMarker : header.lastIndexOf(" b/");
  const raw = marker >= 0 ? header.slice(marker + (quotedMarker >= 0 ? 4 : 3)) : header.replace(/^diff --git /, "");
  return raw.replace(/^"|"$/g, "").replace(/\\([\\"])/g, "$1");
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
  if (left.length > 1200 || right.length > 1200) {
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
  if (!deleted.length || !added.length || deleted.length > 100 || added.length > 100) return;
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
  let oldLine = 0; let newLine = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("diff --git ")) {
      file = { id: `${files.length}:${text}`, path: displayPath(text), lines: [], additions: 0, deletions: 0 };
      files.push(file); continue;
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); file.lines.push({ kind: "meta", text }); continue; }
    if (text.startsWith("+") && !text.startsWith("+++")) { file.lines.push({ kind: "add", text: text.slice(1), newLine: newLine++ }); file.additions += 1; continue; }
    if (text.startsWith("-") && !text.startsWith("---")) { file.lines.push({ kind: "delete", text: text.slice(1), oldLine: oldLine++ }); file.deletions += 1; continue; }
    if (text.startsWith(" ")) { file.lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ }); continue; }
    if (text && !text.startsWith("index ") && !text.startsWith("--- ") && !text.startsWith("+++ ")) file.lines.push({ kind: "meta", text });
  }
  annotateIntraline(files); return files;
}


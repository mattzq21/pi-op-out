import { TERMINAL_OUTPUT_LIMIT } from "./terminalOutput";
import { applyTerminalRendition, terminalTextStyle, type TerminalRendition } from "./terminalColors";

type ControlState = "text" | "escape" | "csi" | "string" | "stringEscape" | "charset";

function afterEscape(char: string): ControlState {
  if (char === "[") return "csi";

  if ("]PX^_".includes(char)) return "string";

  if (char >= " " && char <= "/") return "charset";

  return "text";
}

const controlHandlers: Record<Exclude<ControlState, "text" | "csi">, (char: string) => ControlState> = {
  escape: afterEscape,
  string: char => {
    if (char === "\u0007" || char === "\u009c") return "text";

    return char === "\u001b" ? "stringEscape" : "string";
  },
  stringEscape: char => char === "\\" ? "text" : "string",
  charset: () => "text",
};

const controlOpeners = new Map<string, ControlState>([
  ["\u001b", "escape"], ["\u009b", "csi"], ["\u009d", "string"], ["\u0090", "string"], ["\u009e", "string"], ["\u009f", "string"],
]);

const plain: TerminalRendition = {};
const zeroWidth = /^[\p{M}\u200b-\u200f\u2060\ufe00-\ufe0f]$/u;
const wide = /^[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]$/u;
const simpleText = /^[\x20-\x7e]*$/;

function columns(char: string) {
  if (simpleText.test(char)) return 1;

  if (zeroWidth.test(char)) return 0;

  return wide.test(char) ? 2 : 1;
}

type Segment = { id: object; text: string; style: ReturnType<typeof terminalTextStyle> };
type Run = { start: number; rendition: TerminalRendition; segment?: Segment };

const styles = new WeakMap<TerminalRendition, ReturnType<typeof terminalTextStyle>>();

function styleOf(rendition: TerminalRendition) {
  let style = styles.get(rendition);

  if (!style) { style = terminalTextStyle(rendition); styles.set(rendition, style); }

  return style;
}

function createRow() {
  let text = "";
  let runs: Run[] = [];
  let simple = true;
  let wraps = false;

  const indexAt = (column: number, after = false) => {
    if (simple) return Math.min(column, text.length);
    let used = 0;
    let index = 0;

    for (const char of text) {
      const width = columns(char);

      if (used + width > column || (used === column && width)) return after && used < column ? index + char.length : index;
      used += width; index += char.length;
    }

    return index;
  };

  const width = () => simple ? text.length : [...text].reduce((total, char) => total + columns(char), 0);

  const splice = (start: number, end: number, value: string, rendition: TerminalRendition) => {
    const shift = value.length - (end - start);
    const parts: Run[] = [];
    const add = (from: number, to: number, partRendition: TerminalRendition) => {
      if (from >= to) return;

      if (parts.at(-1)?.rendition !== partRendition) parts.push({ start: from, rendition: partRendition });
    };
    const ranges = runs.map((run, index) => ({ rendition: run.rendition, from: run.start, to: runs[index + 1]?.start ?? text.length }));

    for (const range of ranges) add(range.from, Math.min(range.to, start), range.rendition);
    add(start, start + value.length, rendition);

    for (const range of ranges) add(Math.max(range.from, end) + shift, range.to + shift, range.rendition);
    text = text.slice(0, start) + value + text.slice(end);
    runs = parts;

    if (!simpleText.test(value)) simple = false;
  };

  return {
    text: () => text,
    runs: () => runs,
    wraps: () => wraps,
    setWraps(value: boolean) { wraps = value; },
    write(column: number, char: string, rendition: TerminalRendition) {
      const charWidth = columns(char);
      const rowWidth = width();

      if (column > rowWidth) splice(text.length, text.length, " ".repeat(column - rowWidth), plain);

      if (!charWidth) { const index = indexAt(column); splice(index, index, char, rendition); return 0; }
      splice(indexAt(column), indexAt(column + charWidth, true), char, rendition);

      return charWidth;
    },
    eraseFrom(column: number) { splice(indexAt(column), text.length, "", plain); wraps = false; },
    eraseTo(column: number) { splice(0, indexAt(column + 1, true), " ".repeat(Math.min(column + 1, width())), plain); },
    deleteAt(column: number, count: number) { splice(indexAt(column), indexAt(column + count, true), "", plain); },
    insertAt(column: number, count: number, limit: number) {
      if (column >= width()) return;
      const index = indexAt(column);
      splice(index, index, " ".repeat(count), plain);
      splice(indexAt(limit), text.length, "", plain);
    },
    eraseAt(column: number, count: number) { const rowWidth = width(); if (column < rowWidth) splice(indexAt(column), indexAt(Math.min(rowWidth, column + count), true), " ".repeat(Math.min(count, rowWidth - column)), plain); },
    clear() { text = ""; runs = []; simple = true; wraps = false; },
  };
}

type Row = ReturnType<typeof createRow>;

export function createTerminalTranscript() {
  let text = "";
  let runs: Run[] = [];
  let state: ControlState = "text";
  let parameters = "";
  let rendition: TerminalRendition = plain;
  let width = 80;
  let height = 24;
  let screen: Row[] = [createRow()];
  let row = 0;
  let column = 0;
  let screenSegments: Segment[] = [];

  const finishRow = (finished: Row) => {
    const start = text.length;

    for (const [index, run] of finished.runs().entries()) {
      const end = finished.runs()[index + 1]?.start ?? finished.text().length;

      if (runs.at(-1)?.rendition !== run.rendition) runs.push({ start: start + run.start, rendition: run.rendition });
      text += finished.text().slice(run.start, end);
    }

    if (finished.wraps()) return;

    if (!runs.length) runs.push({ start: text.length, rendition: plain });
    text += "\n";
  };

  const lineFeed = () => {
    if (row < screen.length - 1) { row++; return; }

    if (screen.length >= height) { finishRow(screen.shift()!); screenSegments = []; }
    screen.push(createRow());
    row = screen.length - 1;
  };

  const cursorLine = () => {
    let first = row;
    let last = row;

    while (first > 0 && screen[first - 1].wraps()) first--;

    while (last < screen.length - 1 && screen[last].wraps()) last++;

    return { first, last };
  };

  const write = (char: string) => {
    if (column + columns(char) > width) { screen[row].setWraps(true); lineFeed(); column = 0; }
    column += screen[row].write(column, char, rendition);
  };

  const count = () => Math.max(1, Number.parseInt(parameters, 10) || 1);
  const onScreen = () => Math.min(column, width - 1);

  const csiActions: Record<string, () => void> = {
    K: () => {
      if (parameters === "" || parameters === "0") screen[row].eraseFrom(column);
      else if (parameters === "1") screen[row].eraseTo(onScreen());
      else if (parameters === "2") screen[row].clear();
    },
    A: () => { row = Math.max(0, row - count()); column = onScreen(); },
    B: () => {
      const target = Math.min(height - 1, row + count());

      while (screen.length <= target) screen.push(createRow());
      row = target; column = onScreen();
    },
    C: () => { column = Math.min(width - 1, column + count()); },
    D: () => { column = Math.max(0, onScreen() - count()); },
    G: () => { column = Math.min(width - 1, count() - 1); },
    P: () => screen[row].deleteAt(column, count()),
    "@": () => screen[row].insertAt(column, count(), width),
    X: () => screen[row].eraseAt(column, count()),
  };

  const consumeCsi = (char: string) => {
    if (char >= "@" && char <= "~") {
      const size = char === "t" && /^8;(\d+);(\d+)$/.exec(parameters);

      if (char === "m") rendition = applyTerminalRendition(rendition, parameters);
      else if (size) { height = Math.max(1, Number(size[1])); width = Math.max(1, Number(size[2])); }
      else if (/^\d*$/.test(parameters)) csiActions[char]?.();
      parameters = ""; state = "text";
    } else if (parameters.length < 256) parameters += char;
  };

  const appendText = (char: string) => {
    if (char === "\r") column = 0;
    else if (char === "\n") { lineFeed(); column = 0; }
    else if (char === "\b") column = Math.max(0, onScreen() - 1);
    else if (char === "\t") column = Math.min(width - 1, (Math.floor(column / 8) + 1) * 8);
    else if (!/[\u0000-\u001f\u007f-\u009f]/.test(char)) write(char);
  };

  const consume = (char: string) => {
    if (state === "csi") { consumeCsi(char); return; }

    if (state !== "text") { state = controlHandlers[state](char); return; }

    const opener = controlOpeners.get(char);

    if (opener) { state = opener; return; }

    appendText(char);
  };

  const visibleScreen = (lineLimit?: number) => {
    let last = row;

    for (let index = screen.length - 1; index > row; index--) if (screen[index].text()) { last = index; break; }
    const parts: { text: string; runs: Run[] }[] = [];
    const line = cursorLine();
    let lineLeft = lineLimit ?? Infinity;

    if (lineLimit !== undefined) last = line.last;

    for (let index = 0; index <= last; index++) {
      const screenRow = screen[index];
      let rowText = screenRow.text();

      if (index >= line.first && index <= line.last) { rowText = rowText.slice(0, lineLeft); lineLeft -= rowText.length; }
      const breakAfter = index < last && !screenRow.wraps() ? "\n" : "";
      parts.push({ text: rowText + breakAfter, runs: screenRow.runs() });
    }

    return parts;
  };

  const screenText = () => visibleScreen().map(part => part.text).join("");

  const limit = () => {
    const discard = Math.min(text.length, text.length + screenText().length - TERMINAL_OUTPUT_LIMIT);

    if (discard <= 0) return;
    runs = runs.filter((_, index) => (runs[index + 1]?.start ?? text.length) > discard)
      .map(run => ({ ...run, start: Math.max(0, run.start - discard) }));
    text = text.slice(discard);
  };

  return {
    append(data: string) {
      for (const char of data) consume(char);
      limit();

      return text + screenText();
    },
    currentLine() {
      const { first, last } = cursorLine();

      return screen.slice(first, last + 1).map(screenRow => screenRow.text()).join("");
    },
    segments(lineLimit?: number) {
      const fixed = runs.map((run, index) => {
        const value = text.slice(run.start, runs[index + 1]?.start);

        if (run.segment?.text !== value) run.segment = { id: run.segment?.id ?? {}, text: value, style: styleOf(run.rendition) };

        return run.segment;
      });
      const pieces: { text: string; rendition: TerminalRendition }[] = [];

      for (const part of visibleScreen(lineLimit)) {
        const content = part.text.replace(/\n$/, "");

        for (const [index, run] of part.runs.entries()) {
          const value = content.slice(run.start, part.runs[index + 1]?.start);

          if (!value) continue;

          if (pieces.at(-1)?.rendition === run.rendition) pieces[pieces.length - 1].text += value;
          else pieces.push({ text: value, rendition: run.rendition });
        }

        if (part.text.endsWith("\n")) {
          if (pieces.length) pieces[pieces.length - 1].text += "\n";
          else pieces.push({ text: "\n", rendition: plain });
        }
      }
      screenSegments = pieces.map((piece, index) => {
        const previous = screenSegments[index];
        const style = styleOf(piece.rendition);

        return previous?.text === piece.text && previous.style === style ? previous : { id: previous?.id ?? {}, text: piece.text, style };
      });

      return [...fixed, ...screenSegments];
    },
  };
}

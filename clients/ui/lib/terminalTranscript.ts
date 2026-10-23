import { TERMINAL_OUTPUT_LIMIT } from "./terminalOutput";
import { applyTerminalRendition, terminalTextStyle, type TerminalRendition } from "./terminalColors";

type ControlState = "text" | "escape" | "csi" | "string" | "stringEscape" | "charset";

function afterEscape(char: string): ControlState {
  if (char === "[") return "csi";

  if ("]PX^_".includes(char)) return "string";

  if (char >= " " && char <= "/") return "charset";

  return "text";
}

const controlHandlers: Record<Exclude<ControlState, "text">, (char: string) => ControlState> = {
  escape: afterEscape,
  csi: char => char >= "@" && char <= "~" ? "text" : "csi",
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

function eraseLastCharacter(text: string) {
  return text.slice(0, /[\uDC00-\uDFFF]$/.test(text) ? -2 : -1);
}

export function createTerminalTranscript() {
  let text = "";
  let state: ControlState = "text";
  let carriageReturn = false;
  let parameters = "";
  let rendition: TerminalRendition = {};
  type Segment = { id: object; text: string; style: ReturnType<typeof terminalTextStyle> };
  let runs: { start: number; rendition: TerminalRendition; segment?: Segment }[] = [];

  const write = (value: string) => {
    if (runs.at(-1)?.rendition !== rendition) runs.push({ start: text.length, rendition });
    text += value;
  };

  const truncate = (end: number) => {
    text = text.slice(0, end);

    while (runs.length && runs[runs.length - 1].start >= text.length) runs.pop();
  };

  const clearCurrentLine = () => truncate(text.lastIndexOf("\n") + 1);

  const backspace = () => {
    if (text && !text.endsWith("\n")) truncate(eraseLastCharacter(text).length);
  };

  const appendText = (char: string) => {
    if (char === "\r") {
      carriageReturn = true;

      return;
    }

    if (carriageReturn) {
      if (char !== "\n") clearCurrentLine();
      carriageReturn = false;
    }

    if (char === "\b") {
      backspace();

      return;
    }

    if (!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(char)) write(char);
  };

  const eraseLine = () => {
    if (!["", "0", "1", "2"].includes(parameters)) return;

    if (carriageReturn || parameters === "1" || parameters === "2") clearCurrentLine();
    carriageReturn = false;
  };

  const consumeCsi = (char: string) => {
    if (char >= "@" && char <= "~") {
      if (char === "m") rendition = applyTerminalRendition(rendition, parameters);
      else if (char === "K") eraseLine();
      parameters = ""; state = "text";
    } else if (parameters.length < 256) parameters += char;
  };

  const consume = (char: string) => {
    if (state === "csi") {
      consumeCsi(char);

      return;
    }

    if (state !== "text") {
      state = controlHandlers[state](char);

      return;
    }

    const opener = controlOpeners.get(char);

    if (opener) {
      state = opener;

      return;
    }

    appendText(char);
  };

  return {
    append(data: string) {
      for (const char of data) consume(char);

      const discard = Math.max(0, text.length - TERMINAL_OUTPUT_LIMIT);

      if (discard) {
        runs = runs.filter((_, index) => (runs[index + 1]?.start ?? text.length) > discard)
          .map(run => ({ ...run, start: Math.max(0, run.start - discard) }));
      }

      text = text.slice(-TERMINAL_OUTPUT_LIMIT);

      return text;
    },
    segments() {
      return runs.map((run, index) => {
        const value = text.slice(run.start, runs[index + 1]?.start);

        if (run.segment?.text !== value) run.segment = { id: run.segment?.id ?? {}, text: value, style: run.segment?.style ?? terminalTextStyle(run.rendition) };

        return run.segment;
      });
    },
  };
}

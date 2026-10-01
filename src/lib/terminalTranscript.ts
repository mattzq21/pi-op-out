import { TERMINAL_OUTPUT_LIMIT } from "./terminalOutput";

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

  const appendText = (char: string) => {
    if (char === "\r") {
      carriageReturn = true;

      return;
    }

    if (carriageReturn) {
      if (char !== "\n" && text && !text.endsWith("\n")) text += "\n";
      carriageReturn = false;
    }

    if (char === "\b") {
      if (text && !text.endsWith("\n")) text = eraseLastCharacter(text);

      return;
    }

    if (!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(char)) text += char;
  };

  const consume = (char: string) => {
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
      text = text.slice(-TERMINAL_OUTPUT_LIMIT);

      return text;
    },
  };
}

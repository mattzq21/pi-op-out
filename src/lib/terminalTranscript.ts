import { TERMINAL_OUTPUT_LIMIT } from "./terminalOutput";

export function createTerminalTranscript() {
  let text = "";
  let state: "text" | "escape" | "csi" | "string" | "stringEscape" | "charset" = "text";
  let carriageReturn = false;

  return {
    append(data: string) {
      for (const char of data) {
        if (state === "stringEscape") { state = char === "\\" ? "text" : "string"; continue; }
        if (state === "string") {
          if (char === "\u0007" || char === "\u009c") state = "text";
          else if (char === "\u001b") state = "stringEscape";
          continue;
        }
        if (state === "csi") { if (char >= "@" && char <= "~") state = "text"; continue; }
        if (state === "charset") { state = "text"; continue; }
        if (state === "escape") {
          if (char === "[") state = "csi";
          else if ("]PX^_".includes(char)) state = "string";
          else if (char >= " " && char <= "/") state = "charset";
          else state = "text";
          continue;
        }
        if (char === "\u001b") { state = "escape"; continue; }
        if (char === "\u009b") { state = "csi"; continue; }
        if (char === "\u009d" || char === "\u0090") { state = "string"; continue; }
        if (char === "\r") { carriageReturn = true; continue; }
        if (carriageReturn) {
          if (char !== "\n" && text && !text.endsWith("\n")) text += "\n";
          carriageReturn = false;
        }
        if (char === "\b") {
          if (text && !text.endsWith("\n")) text = text.slice(0, /[\uDC00-\uDFFF]$/.test(text) ? -2 : -1);
        } else if (char === "\n" || char === "\t" || (char >= " " && !(char >= "\u007f" && char <= "\u009f"))) text += char;
      }
      text = text.slice(-TERMINAL_OUTPUT_LIMIT);
      return text;
    },
  };
}

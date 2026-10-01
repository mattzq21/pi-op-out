import type { JSX } from "solid-js";

export const terminalTheme = {
  background: "#1d1d1b", foreground: "#e5e1d8", selectionBackground: "#5a554b88",
  black: "#242320", red: "#d77865", green: "#72ad8d", yellow: "#c49b52",
  blue: "#7496b8", magenta: "#ad83ad", cyan: "#72aaa9", white: "#e5e1d8",
  brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
  brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
};

const palette = [terminalTheme.black, terminalTheme.red, terminalTheme.green, terminalTheme.yellow,
  terminalTheme.blue, terminalTheme.magenta, terminalTheme.cyan, terminalTheme.white,
  terminalTheme.brightBlack, terminalTheme.brightRed, terminalTheme.brightGreen, terminalTheme.brightYellow,
  terminalTheme.brightBlue, terminalTheme.brightMagenta, terminalTheme.brightCyan, terminalTheme.brightWhite];

export type TerminalRendition = {
  foreground?: number | string; background?: number | string;
  bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; hidden?: boolean; strike?: boolean;
};

const attributes = new Map<number, Partial<TerminalRendition>>([
  [1, { bold: true }], [2, { dim: true }], [3, { italic: true }], [4, { underline: true }],
  [7, { inverse: true }], [8, { hidden: true }], [9, { strike: true }],
  [22, { bold: false, dim: false }], [23, { italic: false }], [24, { underline: false }],
  [27, { inverse: false }], [28, { hidden: false }], [29, { strike: false }],
  [39, { foreground: undefined }], [49, { background: undefined }],
]);

function indexedColor(index: number) {
  if (index < 16) return palette[index];

  if (index >= 232) {
    const level = 8 + (index - 232) * 10;

    return `rgb(${level}, ${level}, ${level})`;
  }

  const levels = [0, 95, 135, 175, 215, 255];
  const color = index - 16;

  return `rgb(${levels[Math.floor(color / 36)]}, ${levels[Math.floor(color / 6) % 6]}, ${levels[color % 6]})`;
}

function basicColor(code: number): Partial<TerminalRendition> {
  if (code >= 30 && code <= 37) return { foreground: code - 30 };

  if (code >= 40 && code <= 47) return { background: code - 40 };

  if (code >= 90 && code <= 97) return { foreground: code - 82 };

  if (code >= 100 && code <= 107) return { background: code - 92 };

  return attributes.get(code) ?? {};
}

function extendedColor(params: number[], index: number) {
  const mode = params[index + 1];
  const count = mode === 2 ? 3 : 1;
  const channels = params.slice(index + 2, index + 2 + count);
  const valid = channels.length === count && channels.every(value => Number.isInteger(value) && value >= 0 && value <= 255);

  if (!valid) return { end: index + 1 };

  if (mode === 5) return { end: index + 2, color: indexedColor(channels[0]) };

  if (mode === 2) return { end: index + 4, color: `rgb(${channels.join(", ")})` };

  return { end: index + 1 };
}

export function applyTerminalRendition(current: TerminalRendition, parameters: string): TerminalRendition {
  if (!/^[\d;:]*$/.test(parameters)) return current;
  const params = parameters.replace(/::/g, ":").split(/[;:]/).map(Number);
  let result = { ...current };

  for (let index = 0; index < params.length; index++) {
    const code = params[index];

    if (code === 0) result = {};
    else if (code === 38 || code === 48) {
      const extended = extendedColor(params, index);
      index = extended.end;

      if (extended.color) result[code === 38 ? "foreground" : "background"] = extended.color;
    } else Object.assign(result, basicColor(code));
  }

  return result;
}

function resolveColor(color: number | string | undefined, fallback: string, bold = false): string {
  if (color === undefined) return fallback;

  if (Number.isInteger(color)) {
    const index = Number(color);

    return indexedColor(bold && index < 8 ? index + 8 : index);
  }

  return String(color);
}

export function terminalTextStyle(rendition: TerminalRendition): JSX.CSSProperties {
  const foreground = resolveColor(rendition.foreground, terminalTheme.foreground, rendition.bold);
  const background = resolveColor(rendition.background, terminalTheme.background);

  return {
    color: rendition.inverse ? background : foreground,
    "background-color": rendition.inverse ? foreground : background,
    "font-weight": rendition.bold ? "bold" : undefined,
    "font-style": rendition.italic ? "italic" : undefined,
    "text-decoration": [rendition.underline ? "underline" : "", rendition.strike ? "line-through" : ""].filter(Boolean).join(" "),
    opacity: rendition.dim ? 0.5 : undefined,
    visibility: rendition.hidden ? "hidden" : undefined,
  };
}
